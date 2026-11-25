import { useEffect, useSyncExternalStore } from 'react';
import { ActionType, AhpErrorCodes } from '@microsoft/agent-host-protocol';
import {
  parseServerMessage,
  type Call,
  type ChannelState,
  type ClientMessage,
  type Overview,
  type SearchHistoryResult,
  type ServerMessage,
  type SessionUserState,
  type UsageReport,
} from '../shared/protocol';
import { channelKey, reduceChannel } from '../shared/reduce';
import { CallCancelled, CallRejected, describeError } from './errors';
import type { Selection } from '../shared/routing';

export { CallRejected, describeError } from './errors';

export type Connection = 'connecting' | 'open' | 'closed';

export interface ChannelView {
  state?: ChannelState;
  error?: string;
  missing?: boolean;
  /**
   * Номер снимка канала: растёт, когда хост присылает новую точку отсчёта (первое открытие,
   * F5, reconnect, `terminal/cleared`). Actions его не меняют, поэтому `resized` или `exited`
   * не заставляют терминал стирать экран и рисовать содержимое заново.
   */
  epoch?: number;
}

export interface Notice {
  id: number;
  text: string;
}

export interface AppState {
  connection: Connection;
  overview: Overview;
  /** Закрепления и непрочитанные этого устройства; приходят отдельным сообщением backend. */
  sessionUserState: SessionUserState;
  channels: ReadonlyMap<string, ChannelView>;
  notices: readonly Notice[];
}

interface Watch {
  hostId: string;
  uri: string;
  count: number;
}

const RETRY_MS = 1500;
const NOTICE_MS = 8000;
/**
 * Сколько вывода PTY браузер придерживает до подписки эмулятора. Достаточно, чтобы
 * не потерять первый кадр после F5, и мало, чтобы это вообще было заметно.
 */
const DATA_BUFFER_CHARS = 256 * 1024;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

class Store {
  private state: AppState = {
    connection: 'connecting',
    overview: { hosts: [], sessions: [] },
    sessionUserState: { pinned: [], unread: [] },
    channels: new Map(),
    notices: [],
  };
  private readonly listeners = new Set<() => void>();
  private readonly watches = new Map<string, Watch>();
  private readonly pending = new Map<number, { resolve(data: unknown): void; reject(error: Error): void; cleanup(): void }>();
  private socket: WebSocket | undefined;
  private nextId = 1;
  /** Растёт на каждом снимке канала: эмулятор по нему отличает новую точку отсчёта от action. */
  private epoch = 0;
  /**
   * Слушатели вывода PTY. Кадры `terminalData` не проходят через состояние React:
   * их получают эмуляторы напрямую, иначе 30 обновлений в секунду перерисовывали бы страницу.
   */
  private readonly channelDataListeners = new Set<(hostId: string, uri: string, data: string) => void>();
  /**
   * Кадры, пришедшие до подписки эмулятора (например, между приходом снимка и монтированием
   * xterm). Без буфера начало вывода терялось бы при каждом F5.
   */
  private readonly channelDataBuffer = new Map<string, string>();
  // Backend подавляет push на том устройстве, где сессия уже на экране.
  private presenceVisible = false;
  private presenceSelection: { hostId: string; sessionUri: string } | undefined;

  constructor() {
    this.connect();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): AppState => this.state;

  /** Подписывает на канал; возвращает функцию отписки. Подписки переживают переподключение. */
  watch(hostId: string, uri: string): () => void {
    const key = channelKey(hostId, uri);
    const existing = this.watches.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      this.watches.set(key, { hostId, uri, count: 1 });
      this.send({ t: 'watch', hostId, uri });
    }
    return () => {
      const watch = this.watches.get(key);
      if (!watch) return;
      watch.count -= 1;
      if (watch.count > 0) return;
      this.watches.delete(key);
      this.send({ t: 'unwatch', hostId, uri });
      this.setChannel(key, undefined);
      this.channelDataBuffer.delete(key);
    };
  }

  /**
   * Поток вывода терминала: кадры идут мимо React-состояния и отдаются всем
   * подписчикам (эмулятору) в том порядке, в каком их прислал backend.
   * Кадры, пришедшие до подписки, не теряются: они ждут в буфере канала.
   */
  subscribeChannelData(listener: (hostId: string, uri: string, data: string) => void): () => void {
    this.channelDataListeners.add(listener);
    for (const [key, data] of this.channelDataBuffer) {
      const split = key.indexOf('\u0000');
      listener(key.slice(0, split), key.slice(split + 1), data);
    }
    this.channelDataBuffer.clear();
    return () => this.channelDataListeners.delete(listener);
  }

  /** Забывает буфер канала, чтобы выброшенный поток не всплыл при следующей подписке. */
  forgetChannelData(hostId: string, uri: string): void {
    this.channelDataBuffer.delete(channelKey(hostId, uri));
  }

  call<T = void>(call: Call): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.socket?.readyState !== WebSocket.OPEN) {
        reject(new Error('Нет связи с backend'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, cleanup: () => {} });
      this.send({ t: 'call', id, call });
    });
  }

  /**
   * Отменяемые команды (поиск и отчёт по расходу) делят одну логику: обычный `call`
   * сигнал не принимает, чтобы случайно не оборвать `sendMessage`.
   */
  private abortable<T>(call: Call, signal: AbortSignal, cancel: 'cancelSearch' | 'cancelUsage'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(new CallCancelled());
        return;
      }
      if (this.socket?.readyState !== WebSocket.OPEN) {
        reject(new Error('Нет связи с backend'));
        return;
      }
      const id = this.nextId++;
      const onAbort = () => {
        this.pending.delete(id);
        if (cancel === 'cancelSearch') this.send({ t: 'cancelSearch', id });
        else this.send({ t: 'cancelUsage', id });
        reject(new CallCancelled());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: data => resolve(data as T),
        reject,
        cleanup: () => signal.removeEventListener('abort', onAbort),
      });
      this.send({ t: 'call', id, call });
    });
  }

  search(query: string, signal: AbortSignal): Promise<SearchHistoryResult> {
    return this.abortable({ op: 'searchHistory', query }, signal, 'cancelSearch');
  }

  usageReport(timeZone: string, signal: AbortSignal): Promise<UsageReport> {
    return this.abortable({ op: 'usageReport', timeZone }, signal, 'cancelUsage');
  }

  cancelDirectoryPicker(): void {
    this.send({ t: 'cancelDirectoryPicker' });
  }

  /** Сообщает backend, какая сессия открыта на этом устройстве; чат для подавления не важен. */
  setPresence(selection: Pick<Selection, 'hostId' | 'sessionUri'> | null): void {
    this.presenceSelection = selection ? { hostId: selection.hostId, sessionUri: selection.sessionUri } : undefined;
    this.sendPresence();
  }

  setPresenceVisible(visible: boolean): void {
    if (this.presenceVisible === visible) return;
    this.presenceVisible = visible;
    this.sendPresence();
  }

  private sendPresence(): void {
    this.send({
      t: 'presence',
      visible: this.presenceVisible,
      ...(this.presenceSelection ? { selection: this.presenceSelection } : {}),
    });
  }

  /** Выполняет команду и показывает ошибку уведомлением. Возвращает true при успехе. */
  async run(call: Call): Promise<boolean> {
    try {
      await this.call(call);
      return true;
    } catch (error) {
      this.notify(describeError(error));
      return false;
    }
  }

  notify(text: string): void {
    const notice = { id: this.nextId++, text };
    this.update({ notices: [...this.state.notices, notice] });
    setTimeout(() => this.dismiss(notice.id), NOTICE_MS);
  }

  dismiss(id: number): void {
    this.update({ notices: this.state.notices.filter(notice => notice.id !== id) });
  }

  private connect(): void {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/ws`);
    this.socket = socket;
    socket.onopen = () => {
      this.update({ connection: 'open' });
      // Состояние каналов могло устареть за время обрыва — запрашиваем снимки заново.
      for (const { hostId, uri } of this.watches.values()) this.send({ t: 'watch', hostId, uri });
      this.sendPresence();
    };
    socket.onmessage = event => {
      const message = parseServerMessage(String(event.data));
      if (message) this.onMessage(message);
    };
    socket.onclose = () => {
      this.update({ connection: 'closed' });
      for (const { reject, cleanup } of this.pending.values()) {
        cleanup();
        reject(new Error('Связь с backend прервалась'));
      }
      this.pending.clear();
      setTimeout(() => this.connect(), RETRY_MS);
    };
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private onMessage(message: ServerMessage): void {
    switch (message.t) {
      case 'overview':
        this.update({ overview: message.overview });
        return;
      case 'snapshot': {
        const key = channelKey(message.hostId, message.uri);
        if (!this.watches.has(key) || this.state.channels.get(key)?.missing) return;
        // Снимок терминала — новая точка отсчёта для эмулятора: он стирает экран и пишет
        // содержимое заново (первое открытие, F5, reconnect, возврат на страницу).
        this.setChannel(key, { state: message.state, epoch: ++this.epoch });
        // Всё, что накопилось до снимка, уже есть в его содержимом: иначе эмулятор
        // дописал бы эти кадры поверх снимка и вывод бы задвоился.
        this.channelDataBuffer.delete(key);
        return;
      }
      case 'action': {
        const key = channelKey(message.hostId, message.uri);
        const view = this.state.channels.get(key);
        if (view?.state === undefined) return;
        // Обычный action меняет состояние, но не начинает вывод заново: `resized` или
        // `exited` не должны стирать экран. Исключение — `cleared`: он стирает содержимое
        // и в эмуляторе, поэтому считается новой точкой отсчёта.
        const cleared = message.action.type === ActionType.TerminalCleared;
        this.setChannel(key, {
          state: reduceChannel(message.uri, view.state, message.action),
          // Снимок уже был (иначе action некуда применять), поэтому `epoch` всегда известен.
          epoch: cleared ? ++this.epoch : view.epoch,
        });
        // Кадры до очистки уже не нужны: снимок содержимого теперь пустой.
        if (cleared) this.channelDataBuffer.delete(key);
        return;
      }
      case 'terminalData': {
        const key = channelKey(message.hostId, message.uri);
        if (!this.watches.has(key)) return;
        if (this.channelDataListeners.size === 0) {
          this.bufferChannelData(key, message.data);
          return;
        }
        for (const listener of this.channelDataListeners) listener(message.hostId, message.uri, message.data);
        return;
      }
      case 'channelError': {
        const key = channelKey(message.hostId, message.uri);
        if (!this.watches.has(key)) return;
        const missing = message.code === AhpErrorCodes.SessionNotFound || message.code === AhpErrorCodes.NotFound;
        this.setChannel(key, missing ? { missing: true, error: message.error } : { ...this.state.channels.get(key), error: message.error });
        return;
      }
      case 'sessionRemoved': {
        const channels = new Map(this.state.channels);
        channels.set(channelKey(message.hostId, message.sessionUri), { missing: true });
        for (const uri of message.chatUris) channels.delete(channelKey(message.hostId, uri));
        const matches = (ref: { hostId: string; sessionUri: string }) =>
          ref.hostId === message.hostId && ref.sessionUri === message.sessionUri;
        this.update({
          channels,
          overview: { ...this.state.overview, sessions: this.state.overview.sessions.filter(session => session.hostId !== message.hostId || session.summary.resource !== message.sessionUri) },
          // Badge не должен висеть до прихода очищенного состояния от backend.
          sessionUserState: {
            pinned: this.state.sessionUserState.pinned.filter(ref => !matches(ref)),
            unread: this.state.sessionUserState.unread.filter(ref => !matches(ref)),
          },
        });
        return;
      }
      case 'sessionUserState':
        this.update({ sessionUserState: message.state });
        return;
      case 'rejected':
        this.notify(`Хост отклонил действие ${message.actionType}: ${message.reason}`);
        return;
      case 'result': {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        pending.cleanup();
        if (message.ok) pending.resolve(message.data);
        else pending.reject(new CallRejected(message.error));
        return;
      }
    }
  }

  private setChannel(key: string, view: ChannelView | undefined): void {
    const channels = new Map(this.state.channels);
    if (view) channels.set(key, view);
    else channels.delete(key);
    this.update({ channels });
  }

  /**
   * Буфер кадров до подписки эмулятора ограничен: держать мегабайты в памяти вкладки
   * незачем. Кадры до снимка уже есть в его содержимом, поэтому при переполнении
   * теряется только хвост начала; кадры, пришедшие после снимка, снимком не повторятся.
   */
  private bufferChannelData(key: string, data: string): void {
    const previous = this.channelDataBuffer.get(key) ?? '';
    const next = previous + data;
    if (next.length <= DATA_BUFFER_CHARS) {
      this.channelDataBuffer.set(key, next);
      return;
    }
    let start = next.length - DATA_BUFFER_CHARS;
    // Не начинаем с младшего суррогата: половина эмодзи в xterm — битый символ.
    if (start > 0 && isLowSurrogate(next.charCodeAt(start)) && isHighSurrogate(next.charCodeAt(start - 1))) start -= 1;
    this.channelDataBuffer.set(key, next.slice(start));
  }

  private update(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export const store = new Store();

export function useAppState(): AppState {
  return useSyncExternalStore(store.subscribe, store.getState);
}

const EMPTY_VIEW: ChannelView = {};

/** Открытая сессия и видимость вкладки; backend использует их, чтобы не дублировать push. */
export function usePresence(selection: Selection | null): void {
  const hostId = selection?.hostId;
  const sessionUri = selection?.sessionUri;
  useEffect(() => {
    store.setPresence(hostId && sessionUri ? { hostId, sessionUri } : null);
  }, [hostId, sessionUri]);
  useEffect(() => {
    const update = () => store.setPresenceVisible(document.visibilityState === 'visible');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
}

/** Состояние канала хоста; `uri === undefined` означает «пока не знаем, что смотреть». */
export function useChannel<T extends ChannelState>(hostId: string, uri: string | undefined): { state?: T; error?: string; missing?: boolean; epoch?: number } {
  useEffect(() => (uri ? store.watch(hostId, uri) : undefined), [hostId, uri]);
  const { channels } = useAppState();
  const view = uri ? channels.get(channelKey(hostId, uri)) ?? EMPTY_VIEW : EMPTY_VIEW;
  return view as { state?: T; error?: string; missing?: boolean; epoch?: number };
}
