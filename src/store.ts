import { useEffect, useSyncExternalStore } from 'react';
import { AhpErrorCodes } from '@microsoft/agent-host-protocol';
import {
  AUTH_REQUIRED_CODE,
  parseServerMessage,
  type Call,
  type CallError,
  type ChannelState,
  type ClientMessage,
  type Overview,
  type ServerMessage,
} from '../shared/protocol';
import { channelKey, reduceChannel } from '../shared/reduce';

export type Connection = 'connecting' | 'open' | 'closed';

export interface ChannelView {
  state?: ChannelState;
  error?: string;
  missing?: boolean;
}

export interface Notice {
  id: number;
  text: string;
}

export interface AppState {
  connection: Connection;
  overview: Overview;
  channels: ReadonlyMap<string, ChannelView>;
  notices: readonly Notice[];
}

export class CallRejected extends Error {
  constructor(readonly detail: CallError) {
    super(detail.message);
  }
}

interface Watch {
  hostId: string;
  uri: string;
  count: number;
}

const RETRY_MS = 1500;
const NOTICE_MS = 8000;

class Store {
  private state: AppState = {
    connection: 'connecting',
    overview: { hosts: [], sessions: [] },
    channels: new Map(),
    notices: [],
  };
  private readonly listeners = new Set<() => void>();
  private readonly watches = new Map<string, Watch>();
  private readonly pending = new Map<number, { resolve(data: unknown): void; reject(error: Error): void }>();
  private socket: WebSocket | undefined;
  private nextId = 1;

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
    };
  }

  call<T = void>(call: Call): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.socket?.readyState !== WebSocket.OPEN) {
        reject(new Error('Нет связи с backend'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject });
      this.send({ t: 'call', id, call });
    });
  }

  cancelDirectoryPicker(): void {
    this.send({ t: 'cancelDirectoryPicker' });
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
    };
    socket.onmessage = event => {
      const message = parseServerMessage(String(event.data));
      if (message) this.onMessage(message);
    };
    socket.onclose = () => {
      this.update({ connection: 'closed' });
      for (const { reject } of this.pending.values()) reject(new Error('Связь с backend прервалась'));
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
        this.setChannel(key, { state: message.state });
        return;
      }
      case 'action': {
        const key = channelKey(message.hostId, message.uri);
        const current = this.state.channels.get(key)?.state;
        if (current === undefined) return;
        this.setChannel(key, { state: reduceChannel(message.uri, current, message.action) });
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
        this.update({
          channels,
          overview: { ...this.state.overview, sessions: this.state.overview.sessions.filter(session => session.hostId !== message.hostId || session.summary.resource !== message.sessionUri) },
        });
        return;
      }
      case 'rejected':
        this.notify(`Хост отклонил действие ${message.actionType}: ${message.reason}`);
        return;
      case 'result': {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
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

  private update(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export function describeError(error: unknown): string {
  if (error instanceof CallRejected && error.detail.code === AUTH_REQUIRED_CODE) {
    return 'Агент не готов на этом хосте: скачайте его SDK и выполните вход (блок «Хосты и агенты»).';
  }
  return error instanceof Error ? error.message : String(error);
}

export const store = new Store();

export function useAppState(): AppState {
  return useSyncExternalStore(store.subscribe, store.getState);
}

const EMPTY_VIEW: ChannelView = {};

/** Состояние канала хоста; `uri === undefined` означает «пока не знаем, что смотреть». */
export function useChannel<T extends ChannelState>(hostId: string, uri: string | undefined): { state?: T; error?: string; missing?: boolean } {
  useEffect(() => (uri ? store.watch(hostId, uri) : undefined), [hostId, uri]);
  const { channels } = useAppState();
  const view = uri ? channels.get(channelKey(hostId, uri)) ?? EMPTY_VIEW : EMPTY_VIEW;
  return view as { state?: T; error?: string; missing?: boolean };
}
