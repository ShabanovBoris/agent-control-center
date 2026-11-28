import { randomUUID } from 'node:crypto';
import {
  ActionType,
  AhpErrorCodes,
  ChatInputResponseKind,
  ChatInteractivity,
  ChatMoveDestinationKind,
  ChatOriginKind,
  ChatSourceKind,
  ConfirmationOptionKind,
  CompletionItemKind,
  ContentEncoding,
  JsonRpcErrorCodes,
  MessageKind,
  TerminalClaimKind,
  ToolCallCancellationReason,
  ToolCallConfirmationReason,
  ToolCallStatus,
  ResponsePartKind,
  SessionStatus,
  TurnState,
  type ActionOrigin,
  type ChatTurnStartedAction,
  type ChatState,
  type CommandMap,
  type Message,
  type RootState,
  type SessionState,
  type Snapshot,
  type StateAction,
  type TerminalInfo,
  type TerminalState,
} from '@microsoft/agent-host-protocol';
import { RpcError } from '@microsoft/agent-host-protocol/client';
import type { HostConfig, HostHandle, MultiHostClient } from '@microsoft/agent-host-protocol/hosts';
import {
  ROOT_URI,
  SIDE_CHAT_FIRST_EDIT_UNAVAILABLE,
  TERMINAL_PREFIX,
  type AgentOverview,
  type AgentSdkDownload,
  type Call,
  type CallError,
  type ChannelState,
  type DirectoryListing,
  type EditMessageResult,
  type HostIssue,
  type HostOverview,
  type HostStatus,
  type Overview,
  type ServerMessage,
  type SlashCompletions,
} from '../shared/protocol.js';
import { channelKey, isChangesetChannel, isSupportedChannel } from '../shared/reduce.js';
import { directoryName, normalizeDirectoryPath, parseDirectoryEntries } from '../shared/directory.js';
import { resolveTimeZone } from '../shared/usage.js';
import { ChannelMirror } from './mirror.js';
import { TerminalStream } from './terminal-stream.js';
import { trimTerminalContent, contentBytes, TERMINAL_MIRROR_BYTES } from './terminal-content.js';
import { DEFAULT_TERMINAL_IDLE_MS, evictionCandidate, terminalCleanupPlan } from './terminal-cleanup.js';
import type { DirectoryPicker } from './directory-picker.js';
import type { LocalDirectoryLister } from './directory-listing.js';
import { abortable } from './async.js';
import { CallFailure, errorMessage, rpcCallFailure, toCallError } from './errors.js';
import { readHostBuild, type HostBuild } from './host-build.js';
import { appendHostIssue } from './host-issues.js';
import { redactSecrets } from '../shared/redact.js';
import { checkSessionTitle } from '../shared/session-title.js';
import { HistorySearch, Semaphore, type SearchEnvironment, type SearchLimits } from './search.js';

// Служебные ключи VS Code в root config. Это не часть AHP: через них референсный клиент
// просит хост скачать SDK агента (явное согласие пользователя) или перечитать его настройки.
const SDK_STATUS_KEY_PREFIX = 'vscode.agentSdkSetup.status.';
const SDK_REQUEST_KEYS = {
  download: 'vscode.agentSdkSetup.downloadRequest',
  reload: 'vscode.agentSdkSetup.reloadRequest',
} as const;

const SDK_DOWNLOAD_VALUES: readonly string[] = ['notDownloaded', 'downloadOnUse', 'downloading', 'ready'];
const ACTION_CONFIRMATION_MS = 15_000;
const CHAT_MOVES_SETTING = 'chatMoves.enabled';
/** Сколько своих PTY панель держит одновременно: каждый — отдельный shell на хосте. */
export const MAX_CLIENT_TERMINALS = 8;
/** Пределы resize: значения вне диапазона — ошибка клиента, а не повод звать хост. */
const TERMINAL_MAX_COLS = 1000;
const TERMINAL_MAX_ROWS = 500;
const SEQUENCE_ACTION_LABEL: Partial<Record<StateAction['type'], string>> = {
  [ActionType.ChatConfigChanged]: 'изменение режима',
  [ActionType.SessionConfigChanged]: 'изменение режима',
  [ActionType.RootConfigChanged]: 'изменение настроек хоста',
  [ActionType.ChatTruncated]: 'обрезку истории',
  [ActionType.SessionTitleChanged]: 'переименование сессии',
};

type HistoryTarget = Pick<Extract<Call, { op: 'editMessage' }>, 'hostId' | 'sessionUri' | 'chatUri'>;

interface PendingAction {
  hostId: string;
  channel: string;
  finish(error?: unknown): void;
}

export { CallFailure, errorMessage, toCallError } from './errors.js';

export interface HubSink {
  /** Сообщение всем подключённым браузерам. */
  broadcast(message: ServerMessage): void;
  /** Сообщение браузерам, которые смотрят канал. */
  toWatchers(hostId: string, uri: string, message: ServerMessage): void;
  /**
   * Очередь хотя бы одного наблюдателя канала переполнена: кадр вывода терминала
   * остаётся в буфере до следующего тика, а не копится в сокете без предела.
   */
  channelBackpressured?(hostId: string, uri: string): boolean;
}

/** Диагностика хоста сверх `HostOverview`: история ошибок и время последнего события. */
export interface HostDiagnostics {
  id: string;
  lastConnectedAt?: string;
  lastEventAt?: string;
  activeSessions?: number;
  hostBuild?: HostBuild;
  issues: readonly HostIssue[];
}

/**
 * Связывает AHP-хосты с браузерами: держит соединения через MultiHostClient,
 * ведёт зеркало состояния каналов и переводит узкие команды UI в AHP actions.
 */
export class Hub implements SearchEnvironment {
  private readonly mirror = new ChannelMirror();
  private readonly watchCounts = new Map<string, number>();
  private readonly channelErrors = new Map<string, CallError>();
  private readonly connectedOnce = new Set<string>();
  private readonly pendingActions = new Map<string, PendingAction>();
  private readonly editingChats = new Set<string>();
  /** Слушатели изменений канала: поиск ждёт снимок или следующую страницу истории. */
  private readonly channelChanges = new Map<string, Set<() => void>>();
  private readonly pageLocks = new Map<string, Semaphore>();
  private readonly historySearch: HistorySearch;
  private readonly hostIssues = new Map<string, HostIssue[]>();
  private readonly lastEventAt = new Map<string, number>();
  /** Когда терминал последний раз остался без наблюдателей: отсчёт автоочистки. */
  private readonly terminalSeenAt = new Map<string, number>();
  /**
   * Терминалы, которые мы попросили хост закрыть, но их ещё показывает список root.
   * Их слот не считаем занятым и повторно не вытесняем; запись живёт до обновления root.
   */
  private readonly terminalDisposals = new Map<string, Set<string>>();
  /** Наши терминалы в процессе закрытия: слот освободится только после ответа хоста. */
  private readonly terminalClosings = new Map<string, Set<string>>();
  /** Наши созданные терминалы, ещё не появившиеся в списке root: их слот уже занят. */
  private readonly pendingTerminals = new Map<string, Set<string>>();
  private readonly terminalStream: TerminalStream;
  private overviewTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly multi: MultiHostClient,
    private readonly sink: HubSink,
    /** Показываемые агенты (provider); `undefined` — все, что предлагает хост. */
    private readonly visibleAgents?: readonly string[],
    /** Разные права: Finder — desktop/`localFilesystem`, листинг — только allowlist `locals`. */
    private readonly directories?: {
      picker?: Pick<DirectoryPicker, 'availableFor' | 'choose'>;
      lister?: Pick<LocalDirectoryLister, 'availableFor' | 'list'>;
    },
    private readonly defaultModels?: ReadonlyMap<string, Readonly<Record<string, string>>>,
    searchLimits?: SearchLimits,
  ) {
    this.historySearch = new HistorySearch(this, searchLimits);
    this.terminalStream = new TerminalStream({
      send: (hostId, uri, data) => this.sink.toWatchers(hostId, uri, { t: 'terminalData', hostId, uri, data }),
      ...(sink.channelBackpressured ? { backpressured: (hostId: string, uri: string) => sink.channelBackpressured?.(hostId, uri) ?? false } : {}),
      onOverflow: (hostId, uri, bytes) => console.warn(`[hub] Буфер вывода ${uri} переполнен: потеряно ${bytes} байт (${hostId})`),
    });
  }

  async start(hosts: readonly HostConfig[]): Promise<void> {
    void this.consumeHostEvents();
    void this.consumeEvents();
    for (const host of hosts) {
      this.mirror.track(host.id, ROOT_URI);
      await this.multi.addHost(host);
    }
  }

  async stop(): Promise<void> {
    clearTimeout(this.overviewTimer);
    this.terminalStream.stop();
    this.terminalSeenAt.clear();
    this.terminalDisposals.clear();
    this.terminalClosings.clear();
    this.pendingTerminals.clear();
    for (const action of this.pendingActions.values()) action.finish(new CallFailure('Backend завершает работу'));
    this.historySearch.clear();
    this.pageLocks.clear();
    // Ожидающие снимка/страницы не должны пережить остановку backend.
    this.watchCounts.clear();
    for (const key of [...this.channelChanges.keys()]) {
      this.channelErrors.set(key, { message: 'Backend завершает работу' });
      const [hostId, uri] = key.split('\u0000') as [string, string];
      this.notifyChannel(hostId, uri);
    }
    await this.multi.shutdown();
  }

  overview(): Overview {
    return {
      hosts: this.multi.hostsSnapshot().map(host => this.hostOverview(host)),
      sessions: this.multi.aggregatedSessions().map(({ hostId, hostLabel, summary }) => ({ hostId, hostLabel, summary })),
    };
  }

  hostGeneration(hostId: string): number | undefined {
    const host = this.multi.host(hostId);
    return host?.state.status === 'connected' ? host.generation : undefined;
  }

  /** Снимок диагностики по каждому известному хосту: без сети, только уже накопленные данные. */
  hostDiagnostics(): HostDiagnostics[] {
    return this.multi.hostsSnapshot().map(host => {
      const root = this.mirror.state(host.id, ROOT_URI) as RootState | undefined;
      const hostBuild = readHostBuild(root?._meta?.hostBuild);
      const lastEventAt = this.lastEventAt.get(host.id);
      return {
        id: host.id,
        ...(typeof host.lastConnectedAt === 'number' ? { lastConnectedAt: new Date(host.lastConnectedAt).toISOString() } : {}),
        ...(lastEventAt === undefined ? {} : { lastEventAt: new Date(lastEventAt).toISOString() }),
        ...(typeof host.activeSessions === 'number' ? { activeSessions: host.activeSessions } : {}),
        ...(hostBuild ? { hostBuild } : {}),
        issues: [...(this.hostIssues.get(host.id) ?? [])],
      };
    });
  }

  async hostRoot(hostId: string): Promise<RootState> {
    const { snapshot } = await this.client(hostId).request('subscribe', { channel: ROOT_URI });
    if (!snapshot) throw new CallFailure('Хост не вернул состояние для проверки обновлений.');
    return snapshot.state as RootState;
  }

  /**
   * Регистрирует наблюдателя канала. Возвращает текущее состояние, если оно уже есть;
   * иначе состояние придёт наблюдателям сообщением `snapshot`.
   */
  watch(hostId: string, uri: string): ChannelState | undefined {
    if (uri === ROOT_URI || !isSupportedChannel(uri)) throw new CallFailure(`Канал недоступен для просмотра: ${uri}`);
    if (!this.multi.host(hostId)) throw new CallFailure(`Неизвестный хост: ${hostId}`);
    const key = `${hostId}\u0000${uri}`;
    const count = this.watchCounts.get(key) ?? 0;
    const failure = this.channelErrors.get(key);
    if (count > 0 && failure) throw new CallFailure(failure.message, failure.code);
    this.watchCounts.set(key, count + 1);
    // Терминал снова под наблюдением: автоочистка не должна его закрыть.
    this.terminalSeenAt.delete(key);
    if (count === 0) {
      this.mirror.track(hostId, uri);
      void this.load(hostId, uri);
      return undefined;
    }
    // Накопленный, но ещё не отправленный вывод уже есть в состоянии зеркала: отдаём его
    // кадром раньше снимка, иначе второй наблюдатель получит эти же байты дважды.
    this.terminalStream.flush(hostId, uri);
    return this.mirror.state(hostId, uri);
  }

  unwatch(hostId: string, uri: string): void {
    const key = `${hostId}\u0000${uri}`;
    const count = this.watchCounts.get(key);
    if (count === undefined) return;
    if (count > 1) {
      this.watchCounts.set(key, count - 1);
      return;
    }
    this.watchCounts.delete(key);
    this.channelErrors.delete(key);
    this.mirror.drop(hostId, uri);
    this.terminalStream.drop(hostId, uri);
    if (uri.startsWith(TERMINAL_PREFIX)) this.terminalSeenAt.set(key, Date.now());
    this.notifyChannel(hostId, uri);
    this.multi.unsubscribe(hostId, uri).catch(error => console.warn(`[hub] unsubscribe ${uri} failed:`, errorMessage(error)));
  }

  /**
   * Закрывает свои брошенные терминалы и возвращает их URI. Вызывается таймером
   * в `server/index.ts`; терминалы агентов и наблюдаемые каналы не трогаются.
   */
  sweepTerminals(now = Date.now(), thresholdMs = DEFAULT_TERMINAL_IDLE_MS): string[] {
    const disposed: string[] = [];
    for (const host of this.multi.hostsSnapshot()) {
      if (host.state.status !== 'connected') continue;
      const terminals = this.hostTerminals(host.id);
      this.observeTerminals(host.id, terminals, now);
      // Уже закрываемые терминалы не попадают в план: dispose не должен дублироваться.
      const disposals = this.terminalDisposals.get(host.id);
      const plan = terminalCleanupPlan({
        now, thresholdMs, clientId: host.clientId,
        terminals: disposals ? terminals.filter(terminal => !disposals.has(terminal.resource)) : terminals,
        watched: uri => (this.watchCounts.get(channelKey(host.id, uri)) ?? 0) > 0,
        seenAt: uri => this.terminalSeenAt.get(channelKey(host.id, uri)),
      });
      for (const uri of plan) {
        disposed.push(uri);
        this.closeTerminal(host.id, uri).catch(error => console.warn(`[hub] Автоочистка ${uri} не удалась:`, errorMessage(error)));
      }
    }
    return disposed;
  }

  async call(call: Call, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.execute(call, signal);
    } catch (error) {
      if (signal?.aborted && (call.op === 'pickDirectory' || call.op === 'sendMessage' || call.op === 'updateChatConfig' || call.op === 'updateSessionConfig')) throw error;
      if (error instanceof CallFailure) throw error;
      throw new CallFailure(errorMessage(error), error instanceof RpcError ? error.code : undefined);
    }
  }

  // --- SearchEnvironment: то, что нужно поиску по истории, без доступа к SDK напрямую.

  sessions(): Overview['sessions'] {
    return this.overview().sessions;
  }

  hostStatus(hostId: string): HostStatus | undefined {
    return this.multi.host(hostId)?.state.status;
  }

  mirrorChat(hostId: string, chatUri: string): ChatState | undefined {
    return this.mirror.state(hostId, chatUri) as ChatState | undefined;
  }

  mirrorSession(hostId: string, sessionUri: string): SessionState | undefined {
    return this.mirror.state(hostId, sessionUri) as SessionState | undefined;
  }

  /**
   * Открывает чат для поиска и удерживает подписку до `releaseChat`.
   * При ошибке подписка не остаётся висеть: чужой watchCount не уменьшается.
   */
  async openChat(hostId: string, chatUri: string, signal: AbortSignal, waitMs: number): Promise<ChatState> {
    signal.throwIfAborted();
    const state = this.watch(hostId, chatUri);
    if (state !== undefined) return state as ChatState;
    try {
      return await this.waitForChannel(hostId, chatUri, value => value !== undefined, signal, waitMs) as ChatState;
    } catch (error) {
      this.unwatch(hostId, chatUri);
      throw error;
    }
  }

  releaseChat(hostId: string, chatUri: string): void {
    this.unwatch(hostId, chatUri);
  }

  /**
   * Загружает одну страницу истории. Страницы одного чата сериализуются, а уже
   * загруженный курсор превращается в no-op: SessionUsage, поиск и правка хода
   * могут позвать один и тот же курсор.
   */
  async fetchOlderTurns(hostId: string, chatUri: string, cursor: string, signal?: AbortSignal, waitMs = 5000): Promise<ChatState | undefined> {
    if (typeof cursor !== 'string' || !cursor) throw new CallFailure('Ожидался курсор истории');
    const key = channelKey(hostId, chatUri);
    let lock = this.pageLocks.get(key);
    if (!lock) {
      lock = new Semaphore(1);
      this.pageLocks.set(key, lock);
    }
    const pageLock = lock;
    const task = () => this.loadPage(hostId, chatUri, cursor, signal, waitMs);
    try {
      // Свободный лок не должен добавлять лишний microtask: вызывающий ждёт
      // отправки запроса синхронно, как и до сериализации.
      if (pageLock.tryAcquire()) {
        try { return await task(); } finally { pageLock.release(); }
      }
      return await pageLock.run(signal, task);
    } finally {
      if (pageLock.pending === 0 && this.pageLocks.get(key) === pageLock) this.pageLocks.delete(key);
    }
  }

  private async loadPage(hostId: string, chatUri: string, cursor: string, signal: AbortSignal | undefined, waitMs: number): Promise<ChatState | undefined> {
    signal?.throwIfAborted();
    const before = this.mirror.state(hostId, chatUri) as ChatState | undefined;
    if (!before) {
      // Раньше страницу можно было запросить без подписки; это поведение сохраняем.
      await abortable(this.client(hostId).request('fetchTurns', { channel: chatUri, cursor }), signal, 'Загрузка истории отменена');
      return this.mirror.state(hostId, chatUri) as ChatState | undefined;
    }
    if (before.turnsNextCursor !== cursor) return before;
    const beforeLength = before.turns.length;
    const changed = (state: ChatState) => state.turnsNextCursor !== cursor || state.turns.length !== beforeLength;
    let failure: unknown;
    try {
      await abortable(this.client(hostId).request('fetchTurns', { channel: chatUri, cursor }), signal, 'Загрузка истории отменена');
    } catch (error) {
      failure = error;
    }
    // Действие `chat/turnsLoaded` может прийти раньше ответа на запрос.
    const current = this.mirror.state(hostId, chatUri) as ChatState | undefined;
    if (current && changed(current)) return current;
    if (failure !== undefined) throw failure;
    return await this.waitForChannel(hostId, chatUri, value => changed(value as ChatState), signal, waitMs) as ChatState;
  }

  private notifyChannel(hostId: string, uri: string): void {
    const listeners = this.channelChanges.get(channelKey(hostId, uri));
    if (!listeners?.size) return;
    for (const listener of [...listeners]) listener();
  }

  private waitForChannel(
    hostId: string,
    uri: string,
    predicate: (state: ChannelState) => boolean,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<ChannelState> {
    const key = channelKey(hostId, uri);
    return new Promise<ChannelState>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const listeners = this.channelChanges.get(key);
        listeners?.delete(listener);
        if (listeners?.size === 0) this.channelChanges.delete(key);
      };
      const finish = (error?: unknown, state?: ChannelState) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error !== undefined) reject(error);
        else resolve(state!);
      };
      const check = () => {
        const failure = this.channelErrors.get(key);
        if (failure) { finish(new CallFailure(failure.message, failure.code)); return; }
        if (!this.watchCounts.has(key)) { finish(new CallFailure('Канал закрыт до получения состояния')); return; }
        const state = this.mirror.state(hostId, uri);
        if (state !== undefined && predicate(state)) { finish(undefined, state); return; }
      };
      const listener = () => check();
      const onAbort = () => finish(signal?.reason ?? new CallFailure('Отменено'));
      check();
      if (settled) return;
      const listeners = this.channelChanges.get(key) ?? new Set<() => void>();
      listeners.add(listener);
      this.channelChanges.set(key, listeners);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish(new CallFailure('Хост не прислал состояние канала вовремя')), timeoutMs);
    });
  }

  /**
   * Запрос конфигурации сессии: RpcError сохраняет код хоста (по -32601 форма скрывает блок),
   * но теряет технический префикс сообщения.
   */
  private async sessionConfigRequest<M extends 'resolveSessionConfig' | 'sessionConfigCompletions'>(
    call: { hostId: string }, method: M, params: CommandMap[M]['params'],
  ): Promise<CommandMap[M]['result']> {
    try {
      return await this.client(call.hostId).request(method, params);
    } catch (error) {
      throw rpcCallFailure(error) ?? error;
    }
  }

  /**
   * Ручное имя агентной сессии живёт на хосте: action меняет состояние канала и метаданные,
   * хост публикует `root/sessionSummaryChanged`, и список обновляется штатным путём.
   * Временная подписка нужна, чтобы дождаться снимка неоткрытой строки и подтверждения
   * именно своего action; освобождается только собственный ref.
   */
  private async renameSession(call: Extract<Call, { op: 'renameSession' }>, signal?: AbortSignal): Promise<void> {
    const checked = checkSessionTitle(call.title);
    if (!checked.ok) throw new CallFailure(checked.error);
    const { hostId, sessionUri } = call;
    if (!sessionUri.startsWith('ahp-session:') || isChangesetChannel(sessionUri)) {
      throw new CallFailure('Переименовать можно только сессию');
    }
    if (!this.multi.host(hostId)) throw new CallFailure(`Хост ${hostId} не подключён`);
    signal?.throwIfAborted();
    const state = this.watch(hostId, sessionUri);
    try {
      if (state === undefined) {
        await this.waitForChannel(hostId, sessionUri, value => value !== undefined, signal, ACTION_CONFIRMATION_MS);
      }
      await this.dispatchActionAndWait(
        hostId,
        sessionUri,
        { type: ActionType.SessionTitleChanged, title: checked.title },
        signal,
        'Хост не подтвердил переименование сессии. Проверьте название в списке перед повтором.',
      );
    } finally {
      this.unwatch(hostId, sessionUri);
    }
  }

  private async execute(call: Call, signal?: AbortSignal): Promise<unknown> {
    switch (call.op) {
      case 'pickDirectory':
        if (!this.multi.host(call.hostId) || !this.directories?.picker) throw new CallFailure('Выбор папки через Finder недоступен');
        return { directory: await this.directories.picker.choose(call.hostId, call.initialDirectory, signal) };
      case 'listDirectory': {
        if (typeof call.path !== 'string') throw new CallFailure('Не указан путь к папке');
        const path = normalizeDirectoryPath(call.path);
        if (!path) throw new CallFailure('Укажите абсолютный путь к папке на хосте');
        if (!this.multi.host(call.hostId)) throw new CallFailure('Хост не подключён');
        let result: unknown;
        try {
          result = await this.client(call.hostId).request('resourceList', { channel: ROOT_URI, uri: toFileUri(path) });
        } catch (error) {
          if (!(error instanceof RpcError) || error.code !== JsonRpcErrorCodes.MethodNotFound) throw directoryFailure(error);
          // Нет capability-флага: поддержку узнаём по отказу и не кэшируем — хост мог обновиться.
          const lister = this.directories?.lister;
          if (!lister?.availableFor(call.hostId)) {
            throw new CallFailure('Хост не поддерживает просмотр папок. Укажите путь вручную.', error.code);
          }
          return { path, source: 'backend', entries: await lister.list(call.hostId, path, signal) } satisfies DirectoryListing;
        }
        const entries = parseDirectoryEntries((result as { entries?: unknown } | null)?.entries);
        if (!entries) throw new CallFailure('Хост вернул некорректный список папок');
        return { path, source: 'host', entries } satisfies DirectoryListing;
      }
      case 'createSession': {
        const sessionUri = `ahp-session:/${randomUUID()}`;
        await this.client(call.hostId).request('createSession', {
          channel: sessionUri,
          provider: call.provider,
          workingDirectories: [toFileUri(call.workingDirectory)],
          ...(call.config ? { config: call.config } : {}),
        });
        return { sessionUri };
      }
      case 'createTerminal':
        return this.createTerminal(call, signal);
      case 'disposeTerminal': {
        const uri = this.requireTerminalUri(call.terminalUri);
        await this.closeTerminal(call.hostId, uri);
        return undefined;
      }
      case 'terminalInput': {
        const state = this.runningTerminal(call.hostId, call.terminalUri);
        if (typeof call.data !== 'string' || call.data.length === 0) throw new CallFailure('Пустой ввод терминала');
        if (!state) throw new CallFailure('Терминал завершён: ввод недоступен');
        this.dispatch(call.hostId, call.terminalUri, { type: ActionType.TerminalInput, data: call.data });
        return undefined;
      }
      case 'terminalResize': {
        this.runningTerminal(call.hostId, call.terminalUri);
        const { cols, rows } = call;
        if (!Number.isInteger(cols) || cols < 1 || cols > TERMINAL_MAX_COLS || !Number.isInteger(rows) || rows < 1 || rows > TERMINAL_MAX_ROWS) {
          throw new CallFailure('Некорректный размер терминала');
        }
        this.dispatch(call.hostId, call.terminalUri, { type: ActionType.TerminalResized, cols, rows });
        return undefined;
      }
      case 'resolveSessionConfig':
        return this.sessionConfigRequest(call, 'resolveSessionConfig', {
          channel: ROOT_URI,
          provider: call.provider,
          workingDirectory: toFileUri(call.workingDirectory),
          ...(call.config ? { config: call.config } : {}),
        });
      case 'sessionConfigCompletions': {
        if (typeof call.property !== 'string' || !call.property) throw new CallFailure('Ожидалось свойство конфигурации сессии');
        return this.sessionConfigRequest(call, 'sessionConfigCompletions', {
          channel: ROOT_URI,
          provider: call.provider,
          workingDirectory: toFileUri(call.workingDirectory),
          ...(call.config ? { config: call.config } : {}),
          property: call.property,
          ...(call.query ? { query: call.query } : {}),
        });
      }
      case 'archiveSession': {
        if (!call.sessionUri.startsWith('ahp-session:')) throw new CallFailure('Ожидалась сессия');
        if (typeof call.archived !== 'boolean') throw new CallFailure('Укажите состояние архива');
        this.dispatch(call.hostId, call.sessionUri, { type: ActionType.SessionIsArchivedChanged, isArchived: call.archived });
        return undefined;
      }
      case 'renameSession':
        return this.renameSession(call, signal);
      case 'refreshSession': {
        if (!call.sessionUri.startsWith('ahp-session:')) throw new CallFailure('Ожидалась сессия');
        if (!this.watchCounts.has(channelKey(call.hostId, call.sessionUri))) throw new CallFailure('Сессия не открыта');
        this.mirror.track(call.hostId, call.sessionUri);
        await this.load(call.hostId, call.sessionUri);
        return undefined;
      }
      case 'fetchTurns':
        // Через общую сериализацию: браузер, поиск и editMessage не запрашивают одну страницу дважды.
        await this.fetchOlderTurns(call.hostId, call.chatUri, call.cursor, signal);
        return undefined;
      case 'searchHistory': {
        if (typeof call.query !== 'string') throw new CallFailure('Ожидался поисковый запрос');
        if (call.limit !== undefined && (!Number.isInteger(call.limit) || call.limit < 1 || call.limit > 100)) {
          throw new CallFailure('Лимит результатов должен быть целым числом от 1 до 100');
        }
        return this.historySearch.search(call.query, signal ?? new AbortController().signal, call.limit);
      }
      case 'usageReport': {
        const timeZone = resolveTimeZone(call.timeZone);
        if (!timeZone) throw new CallFailure('Неизвестный часовой пояс');
        return this.historySearch.usageReport(timeZone, signal ?? new AbortController().signal);
      }
      case 'slashCompletions': {
        const { session } = this.historyChat(call);
        if (!this.multi.host(call.hostId)?.completionTriggerCharacters?.includes('/')) return { items: [] } satisfies SlashCompletions;
        if (typeof call.text !== 'string' || !call.text.trimStart().startsWith('/') ||
            !Number.isInteger(call.offset) || call.offset < 0 || call.offset > call.text.length) {
          throw new CallFailure('Некорректный запрос подсказок команд.');
        }
        // VS Code exposes default-chat completions on the session URI; peer chats stay chat-addressed.
        return this.client(call.hostId).request('completions', {
          channel: session.defaultChat === call.chatUri ? call.sessionUri : call.chatUri,
          kind: CompletionItemKind.UserMessage, text: call.text, offset: call.offset,
        });
      }
      case 'createChat': {
        if (!call.sessionUri.startsWith('ahp-session:') || !call.chatUri.startsWith('ahp-chat:')) throw new CallFailure('Ожидались сессия и чат');
        await this.client(call.hostId).request('createChat', {
          channel: call.sessionUri,
          chat: call.chatUri,
          ...(call.source ? { source: call.source } : {}),
          ...(call.title ? { title: call.title } : {}),
        });
        return { chatUri: call.chatUri };
      }
      case 'forkSession':
        return this.forkSession(call, signal);
      case 'editMessage':
      case 'retryEditedMessage':
        return this.editMessage(call, signal);
      case 'updateSessionConfig': {
        if (!call.sessionUri.startsWith('ahp-session:')) throw new CallFailure('Ожидалась сессия');
        const action = { type: ActionType.SessionConfigChanged, config: call.config } as const;
        if (call.waitForHost) return this.dispatchActionAndWait(call.hostId, call.sessionUri, action, signal);
        return this.dispatch(call.hostId, call.sessionUri, action);
      }
      case 'updateChatConfig': {
        if (!call.chatUri.startsWith('ahp-chat:')) throw new CallFailure('Ожидался чат');
        const action = { type: ActionType.ChatConfigChanged, config: call.config } as const;
        if (call.waitForHost) return this.dispatchActionAndWait(call.hostId, call.chatUri, action, signal);
        return this.dispatch(call.hostId, call.chatUri, action);
      }
      case 'readResource': {
        const result = await this.client(call.hostId).request('resourceRead', {
          channel: ROOT_URI,
          uri: call.uri,
          encoding: ContentEncoding.Base64,
        });
        return result;
      }
      case 'sendMessage': {
        if (this.editingChats.has(channelKey(call.hostId, call.chatUri))) throw new CallFailure('Дождитесь завершения редактирования истории.');
        const text = call.text.trim();
        if (!text && (!call.attachments || call.attachments.length === 0)) throw new CallFailure('Пустое сообщение');
        if (call.modelConfig && !call.modelId) throw new CallFailure('Для параметров reasoning выберите модель');
        const thinkingLevel = call.modelConfig?.thinkingLevel;
        if (thinkingLevel !== undefined) {
          const model = this.multi.host(call.hostId)?.agents.flatMap(agent => agent.models).find(model => model.id === call.modelId);
          const property = model?.configSchema?.properties.thinkingLevel;
          if (typeof thinkingLevel !== 'string' || property?.type !== 'string' || property.readOnly || !property.enum?.includes(thinkingLevel)) {
            throw new CallFailure('Выбранный уровень reasoning недоступен для этой модели');
          }
        }
        const action: ChatTurnStartedAction = {
          type: ActionType.ChatTurnStarted,
          turnId: randomUUID(),
          startedAt: new Date().toISOString(),
          message: {
            text,
            origin: { kind: MessageKind.User },
            ...(call.attachments?.length ? { attachments: call.attachments } : {}),
            ...(call.modelId ? { model: { id: call.modelId, ...(call.modelConfig ? { config: call.modelConfig } : {}) } } : {}),
          },
        };
        if (call.waitForHost === true) await this.dispatchTurnAndWait(call.hostId, call.chatUri, action, signal);
        else this.dispatch(call.hostId, call.chatUri, action);
        return undefined;
      }
      case 'cancelTurn': {
        const chat = this.chatState(call.hostId, call.chatUri);
        const turn = chat.activeTurn;
        if (!turn || turn.id !== call.turnId) throw new CallFailure('Этот ход уже завершён');
        this.dispatch(call.hostId, call.chatUri, {
          type: ActionType.ChatTurnCancelled,
          turnId: turn.id,
          // Время хода по часам backend — он и есть продюсер этого action.
          duration: Math.max(0, Date.now() - Date.parse(turn.startedAt)),
        });
        return undefined;
      }
      case 'confirmTool': {
        const option = this.confirmationOption(call);
        const base = { type: ActionType.ChatToolCallConfirmed, turnId: call.turnId, toolCallId: call.toolCallId } as const;
        const selected = option ? { selectedOptionId: option.id } : {};
        this.dispatch(call.hostId, call.chatUri, call.approved
          ? { ...base, approved: true, confirmed: ToolCallConfirmationReason.UserAction, ...selected }
          : { ...base, approved: false, reason: ToolCallCancellationReason.Denied, ...selected });
        return undefined;
      }
      case 'completeInput': {
        const response = {
          accept: ChatInputResponseKind.Accept,
          decline: ChatInputResponseKind.Decline,
          cancel: ChatInputResponseKind.Cancel,
        }[call.response];
        if (!response) throw new CallFailure(`Неизвестный ответ: ${String(call.response)}`);
        this.dispatch(call.hostId, call.chatUri, {
          type: ActionType.ChatInputCompleted,
          requestId: call.requestId,
          response,
          ...(call.answers ? { answers: call.answers } : {}),
        });
        return undefined;
      }
      case 'agentSetup': {
        const key = SDK_REQUEST_KEYS[call.request];
        if (!key) throw new CallFailure(`Неизвестный запрос: ${String(call.request)}`);
        this.dispatch(call.hostId, ROOT_URI, {
          type: ActionType.RootConfigChanged,
          // Уникальный request нужен, чтобы хост не принял повторное нажатие за уже обработанное.
          config: { [key]: { agent: call.agent, request: randomUUID() } },
        });
        return undefined;
      }
      case 'reconnectHost':
        await this.multi.reconnectHost(call.hostId);
        return undefined;
      default:
        throw new CallFailure(`Неизвестная команда: ${String((call as { op?: unknown }).op)}`);
    }
  }

  private async createTerminal(call: Extract<Call, { op: 'createTerminal' }>, signal?: AbortSignal): Promise<{ terminalUri: string }> {
    const host = this.multi.host(call.hostId);
    if (!host) throw new CallFailure('Хост не подключён');
    const path = normalizeDirectoryPath(call.directory);
    if (!path) throw new CallFailure('Укажите абсолютный путь к папке на хосте, например /Users/me/project');
    await this.assertTerminalDirectory(call.hostId, path, signal);

    const uri = `${TERMINAL_PREFIX}/${randomUUID()}`;
    // Слот резервируется до запроса: вытесняемый PTY успевает закрыться, пока хост
    // ещё не создал новый, — иначе на хосте на время dispose живут лишние shell'ы.
    await this.reserveTerminalSlot(call.hostId, uri, signal);
    try {
      signal?.throwIfAborted();
      await this.client(call.hostId).request('createTerminal', {
        channel: uri,
        // Claim остаётся за backend-клиентом: после F5 и рестарта backend shell принадлежит нам же.
        claim: { kind: TerminalClaimKind.Client, clientId: host.clientId },
        // Имя видно в общем списке терминалов: явный title побеждает, иначе имя папки.
        name: call.title?.trim() || directoryName(path) || 'Терминал',
        cwd: toFileUri(path),
        ...(call.cols && call.rows ? { cols: call.cols, rows: call.rows } : {}),
      });
    } catch (error) {
      // PTY не появился — зарезервированный слот возвращается лимиту.
      this.untrackUri(this.pendingTerminals, call.hostId, uri);
      throw error;
    }
    return { terminalUri: uri };
  }

  /**
   * Папка проверяется до создания PTY: несуществующий cwd хост молча подменяет домашней,
   * а пользователь должен видеть ошибку в поле, а не чужой каталог в терминале.
   * Хост без `resourceList` — штатная деградация: путь принимается как есть.
   */
  private async assertTerminalDirectory(hostId: string, path: string, signal?: AbortSignal): Promise<void> {
    try {
      await abortable(this.client(hostId).request('resourceList', { channel: ROOT_URI, uri: toFileUri(path) }), signal, 'Отменено');
    } catch (error) {
      // Хост без листинга папок не должен блокировать терминал: путь проверен в UI.
      if (error instanceof RpcError && error.code === JsonRpcErrorCodes.MethodNotFound) return;
      throw directoryFailure(error);
    }
  }

  /**
   * Резервирует слот под новый PTY, вытесняя при необходимости старейший терминал
   * без наблюдателей. Занятость считается по списку хоста с поправкой на то, что
   * происходит «в полёте»: закрываемые терминалы ещё держат слот до ответа хоста,
   * а только что созданные занимают его сразу, не дожидаясь обновления root.
   * Если все слоты заняты наблюдаемыми терминалами — честная ошибка: молча убивать
   * открытый на другом устройстве shell нельзя.
   */
  private async reserveTerminalSlot(hostId: string, uri: string, signal?: AbortSignal): Promise<void> {
    const host = this.multi.host(hostId);
    if (!host) throw new CallFailure('Хост не подключён');
    const disposals = this.terminalDisposals.get(hostId);
    // Терминалы, которые уже закрываются или закрыты, слот не занимают: root обновится позже.
    const terminals = this.hostTerminals(hostId).filter(terminal => !disposals?.has(terminal.resource));
    const visible = new Set(terminals.map(terminal => terminal.resource));
    const pending = [...(this.pendingTerminals.get(hostId) ?? [])].filter(item => !visible.has(item)).length;
    const closings = this.terminalClosings.get(hostId)?.size ?? 0;
    const own = terminals.filter(terminal => this.isOwnTerminal(hostId, terminal.claim)).length;
    if (own + closings + pending < MAX_CLIENT_TERMINALS) {
      this.trackUri(this.pendingTerminals, hostId, uri);
      return;
    }
    const candidate = evictionCandidate(terminals, {
      clientId: host.clientId,
      watched: item => (this.watchCounts.get(channelKey(hostId, item)) ?? 0) > 0,
      seenAt: item => this.terminalSeenAt.get(channelKey(hostId, item)),
    });
    if (!candidate) throw new CallFailure(`Открыто ${MAX_CLIENT_TERMINALS} терминалов. Закройте один из них.`);
    try {
      await this.closeTerminal(hostId, candidate);
    } catch (error) {
      // Хост не закрыл терминал: слот остался занят, новый PTY не создаём.
      throw new CallFailure(`Не удалось освободить место: ${errorMessage(error)}`, error instanceof RpcError ? error.code : undefined);
    }
    signal?.throwIfAborted();
    this.trackUri(this.pendingTerminals, hostId, uri);
  }

  /** «Свой» терминал: claim client с clientId этого backend. Терминалы агентов не наши. */
  private isOwnTerminal(hostId: string, claim: TerminalInfo['claim']): boolean {
    const host = this.multi.host(hostId);
    return host !== undefined && claim.kind === TerminalClaimKind.Client && claim.clientId === host.clientId;
  }

  private trackUri(map: Map<string, Set<string>>, hostId: string, uri: string): void {
    const set = map.get(hostId) ?? new Set<string>();
    set.add(uri);
    map.set(hostId, set);
  }

  private untrackUri(map: Map<string, Set<string>>, hostId: string, uri: string): void {
    const set = map.get(hostId);
    if (!set?.delete(uri)) return;
    if (set.size === 0) map.delete(hostId);
  }

  private requireTerminalUri(uri: string): string {
    if (typeof uri !== 'string' || !uri.startsWith(TERMINAL_PREFIX)) throw new CallFailure('Ожидался терминал');
    return uri;
  }

  /** Терминал открыт и жив: в завершённый PTY писать и ресайзить его бессмысленно. */
  private runningTerminal(hostId: string, uri: string): TerminalState | undefined {
    const state = this.terminalState(hostId, this.requireTerminalUri(uri));
    if (state.lifecycle.status !== 'running') return undefined;
    return state;
  }

  private async forkSession(call: Extract<Call, { op: 'forkSession' }>, signal?: AbortSignal): Promise<{ sessionUri: string }> {
    const { hostId, sessionUri, chatUri, turnId } = call;
    const { session, chat } = this.historyChat(call);
    const provider = chat.provider ?? session.provider;
    const agent = this.multi.host(hostId)?.agents.find(candidate => candidate.provider === provider);
    if (!agent?.capabilities?.multipleChats?.fork) throw new CallFailure('Агент не поддерживает форки.');
    if (!chat.turns.some(turn => turn.id === turnId && turn.state === TurnState.Complete)) {
      throw new CallFailure('Этот завершённый ответ больше недоступен.');
    }

    const client = this.client(hostId);
    const root = this.mirror.state(hostId, ROOT_URI) as RootState | undefined;
    const flag = root?.config?.schema.properties[CHAT_MOVES_SETTING];
    if (flag?.type === 'boolean' && (root?.config?.values[CHAT_MOVES_SETTING] ?? flag.default) !== true) {
      if (flag.readOnly) throw new CallFailure('Перенос чатов отключён в настройках хоста.');
      await this.dispatchActionAndWait(hostId, ROOT_URI, {
        type: ActionType.RootConfigChanged,
        config: { [CHAT_MOVES_SETTING]: true },
      }, signal);
    }

    signal?.throwIfAborted();
    const forkUri = `ahp-chat:/${randomUUID()}`;
    await client.request('createChat', {
      channel: sessionUri,
      chat: forkUri,
      source: { kind: ChatSourceKind.Fork, chat: chatUri, turnId },
      title: `Форк: ${chat.title || session.title || 'Новая сессия'}`,
    });
    try {
      // Повторяем subscribe уже открытой сессии для актуального каталога.
      // Одного подтверждения createChat недостаточно, чтобы считать ветку movable.
      const { snapshot } = await client.request('subscribe', { channel: sessionUri });
      const catalog = (snapshot?.state as SessionState | undefined)?.chats;
      if (!catalog?.some(item => item.resource === forkUri && item.movable === true)) {
        throw new CallFailure('Хост оставил созданный форк в исходной сессии. Перенос этой ветки недоступен.');
      }
      const { session: newSession } = await client.request('moveChat', {
        channel: forkUri,
        destination: { kind: ChatMoveDestinationKind.NewSession },
      });
      if (!newSession?.startsWith('ahp-session:') || newSession === sessionUri) {
        throw new CallFailure('Хост вернул некорректный адрес новой сессии.');
      }
      return { sessionUri: newSession };
    } catch (error) {
      throw new CallFailure(`Новая сессия не подтверждена. Проверьте список сессий. ${errorMessage(error)}`);
    }
  }

  private async editMessage(call: Extract<Call, { op: 'editMessage' | 'retryEditedMessage' }>, signal?: AbortSignal): Promise<EditMessageResult> {
    const { hostId, chatUri, replacementId } = call;
    if (typeof replacementId !== 'string' || !replacementId) throw new CallFailure('Ожидался идентификатор нового хода.');
    const key = channelKey(hostId, chatUri);
    if (this.editingChats.has(key)) throw new CallFailure('История этого чата уже редактируется.');
    this.editingChats.add(key);
    const held: string[] = [];
    try {
      signal?.throwIfAborted();
      let { chat } = this.historyChat(call);
      for (const uri of [call.sessionUri, chatUri]) {
        this.watch(hostId, uri);
        held.push(uri);
      }
      if (call.op === 'retryEditedMessage') {
        const message = editedMessage(call.message, call.text);
        return await this.sendEditedMessage(call, message, call.retainedTurnId, replacementId, signal);
      }

      requireIdleHistory(chat, call.lastTurnId);
      if (chat.turns[0]?.id === call.turnId && chat.turnsNextCursor) {
        signal?.throwIfAborted();
        await this.fetchOlderTurns(hostId, chatUri, chat.turnsNextCursor, signal);
        ({ chat } = this.historyChat(call));
        requireIdleHistory(chat, call.lastTurnId);
      }
      const index = chat.turns.findIndex(turn => turn.id === call.turnId);
      if (index < 0) throw new CallFailure('Редактируемое сообщение больше недоступно.');
      if (index === 0 && chat.turnsNextCursor) throw new CallFailure('Загрузите предыдущие сообщения перед редактированием.');
      if (chat.turns.some(turn => turn.id === replacementId)) throw new CallFailure('Идентификатор нового хода уже занят.');
      const message = editedMessage(chat.turns[index]!.message, call.text);
      const retainedTurnId = chat.turns[index - 1]?.id ?? null;
      if (retainedTurnId === null && chat.origin?.kind === ChatOriginKind.SideChat) {
        throw new CallFailure(SIDE_CHAT_FIRST_EDIT_UNAVAILABLE);
      }
      // Если обрезка уже отправлена, доводим правку до нового хода даже при закрытии вкладки.
      signal?.throwIfAborted();
      await this.dispatchActionAndWait(hostId, chatUri, {
        type: ActionType.ChatTruncated,
        ...(retainedTurnId !== null ? { turnId: retainedTurnId } : {}),
      });
      return await this.sendEditedMessage(call, message, retainedTurnId, replacementId);
    } finally {
      for (const uri of held) this.unwatch(hostId, uri);
      this.editingChats.delete(key);
    }
  }

  private async sendEditedMessage(target: HistoryTarget, message: Message, retainedTurnId: string | null, replacementId: string, signal?: AbortSignal): Promise<EditMessageResult> {
    try {
      const { chat } = this.historyChat(target);
      if (chat.activeTurn?.id === replacementId || chat.turns.some(turn => turn.id === replacementId)) return { status: 'sent' };
      requireIdleHistory(chat, retainedTurnId);
      await this.dispatchTurnAndWait(target.hostId, target.chatUri, {
        type: ActionType.ChatTurnStarted,
        turnId: replacementId,
        startedAt: new Date().toISOString(),
        message,
      }, signal);
      return { status: 'sent' };
    } catch (error) {
      signal?.throwIfAborted();
      return { status: 'truncated', retainedTurnId, error: errorMessage(error) };
    }
  }

  private historyChat({ hostId, sessionUri, chatUri }: HistoryTarget): { session: SessionState; chat: ChatState } {
    const session = this.mirror.state(hostId, sessionUri) as SessionState | undefined;
    if (!sessionUri.startsWith('ahp-session:') || !session?.chats?.some(chat => chat.resource === chatUri)) {
      throw new CallFailure('Чат не принадлежит открытой сессии.');
    }
    const chat = this.chatState(hostId, chatUri);
    if ((session.status | chat.status) & SessionStatus.IsArchived || (chat.interactivity && chat.interactivity !== ChatInteractivity.Full)) {
      throw new CallFailure('Этот чат доступен только для просмотра.');
    }
    return { session, chat };
  }

  /** Находит вариант подтверждения, который хост предложил для этого вызова инструмента. */
  private confirmationOption(call: Extract<Call, { op: 'confirmTool' }>) {
    const chat = this.chatState(call.hostId, call.chatUri);
    const turn = chat.activeTurn?.id === call.turnId ? chat.activeTurn : undefined;
    const part = turn?.responseParts.find(candidate =>
      candidate.kind === ResponsePartKind.ToolCall && candidate.toolCall.toolCallId === call.toolCallId);
    const toolCall = part?.kind === ResponsePartKind.ToolCall ? part.toolCall : undefined;
    if (toolCall?.status !== ToolCallStatus.PendingConfirmation) {
      throw new CallFailure('Этот вызов уже не ждёт подтверждения');
    }
    const options = toolCall.options ?? [];
    if (call.optionId !== undefined) {
      const option = options.find(candidate => candidate.id === call.optionId);
      const expected = call.approved ? ConfirmationOptionKind.Approve : ConfirmationOptionKind.Deny;
      if (!option || option.kind !== expected) throw new CallFailure('Хост не предлагал такой вариант ответа');
      return option;
    }
    return undefined;
  }

  private chatState(hostId: string, chatUri: string): ChatState {
    if (!chatUri.startsWith('ahp-chat:')) throw new CallFailure(`Не чат: ${chatUri}`);
    const state = this.mirror.state(hostId, chatUri);
    if (!state) throw new CallFailure('Чат не открыт или его состояние ещё не получено');
    return state as ChatState;
  }

  private client(hostId: string) {
    const client = this.multi.client(hostId);
    if (!client) throw new CallFailure(`Хост ${hostId} не подключён`);
    return client;
  }

  /** Список терминалов хоста: зеркало root — источник истины, а не отдельная карта в панели. */
  private hostTerminals(hostId: string): readonly TerminalInfo[] {
    const root = this.mirror.state(hostId, ROOT_URI) as RootState | undefined;
    const handleTerminals = this.multi.host(hostId)?.terminals;
    return root?.terminals ?? handleTerminals ?? [];
  }

  /** Канал терминала открыт и его состояние уже пришло: иначе отправлять ввод некуда. */
  private terminalState(hostId: string, uri: string): TerminalState {
    if (!uri.startsWith(TERMINAL_PREFIX)) throw new CallFailure('Ожидался терминал');
    const state = this.mirror.state(hostId, uri) as TerminalState | undefined;
    if (!state) throw new CallFailure('Терминал не открыт или его состояние ещё не получено');
    return state;
  }

  /**
   * Закрывает PTY на хосте и убирает канал из зеркала. Повторное закрытие
   * (терминал уже исчез, backend перезапущен) не ошибка для вызывающего.
   */
  private async closeTerminal(hostId: string, uri: string): Promise<void> {
    const key = channelKey(hostId, uri);
    // Отметки ставятся синхронно, до первого await: параллельный create уже не выберет
    // этот URI и увидит, что слот ещё держится, пока хост не ответил на dispose.
    this.trackUri(this.terminalDisposals, hostId, uri);
    const closing = this.hostTerminals(hostId).find(terminal => terminal.resource === uri);
    const countsTowardsLimit = closing !== undefined && this.isOwnTerminal(hostId, closing.claim);
    if (countsTowardsLimit) this.trackUri(this.terminalClosings, hostId, uri);
    let disposed = false;
    try {
      await this.client(hostId).request('disposeTerminal', { channel: uri });
      disposed = true;
    } catch (error) {
      if (!(error instanceof RpcError) || error.code !== AhpErrorCodes.NotFound) throw error;
      // NotFound — терминала уже нет: для вызывающего это успешное закрытие.
      disposed = true;
    } finally {
      // Неудачный dispose оставляет PTY живым: слот и запись в списке хоста сохраняются.
      if (!disposed) this.untrackUri(this.terminalDisposals, hostId, uri);
      if (countsTowardsLimit) this.untrackUri(this.terminalClosings, hostId, uri);
      this.untrackUri(this.pendingTerminals, hostId, uri);
      this.terminalStream.drop(hostId, uri);
      this.terminalSeenAt.delete(key);
      this.mirror.drop(hostId, uri);
      this.multi.unsubscribe(hostId, uri).catch(error => console.warn(`[hub] unsubscribe ${uri} failed:`, errorMessage(error)));
    }
  }

  private dispatch(hostId: string, uri: string, action: StateAction): void {
    this.client(hostId).dispatch(uri, action);
  }

  private dispatchTurnAndWait(hostId: string, chatUri: string, action: ChatTurnStartedAction, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.dispatch(hostId, chatUri, action);
    return this.waitForAction(action.turnId, hostId, chatUri, 'Хост не подтвердил отправку. Проверьте чат перед повтором.', signal);
  }

  private dispatchActionAndWait(hostId: string, channel: string, action: StateAction, signal?: AbortSignal, timeoutMessage?: string): Promise<void> {
    signal?.throwIfAborted();
    const host = this.multi.host(hostId);
    if (!host) throw new CallFailure(`Хост ${hostId} не подключён`);
    const { clientSeq } = this.client(hostId).dispatch(channel, action);
    const key = sequenceActionKey(hostId, action.type, { clientId: host.clientId, clientSeq }, host.generation);
    return this.waitForAction(key, hostId, channel, timeoutMessage
      ?? `Хост не подтвердил ${SEQUENCE_ACTION_LABEL[action.type]}. Проверьте чат перед повтором.`, signal);
  }

  private waitForAction(key: string, hostId: string, channel: string, timeoutMessage: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pendingActions.delete(key);
        if (error === undefined) resolve();
        else reject(error);
      };
      const abort = () => finish(signal?.reason);
      const timer = setTimeout(() => finish(new CallFailure(timeoutMessage)), ACTION_CONFIRMATION_MS);
      this.pendingActions.set(key, { hostId, channel, finish });
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private async load(hostId: string, uri: string): Promise<void> {
    const token = this.mirror.loadStarted(hostId, uri);
    this.channelErrors.delete(channelKey(hostId, uri));
    let snapshot: Snapshot | undefined;
    try {
      ({ snapshot } = await this.multi.subscribe(hostId, uri));
    } catch (error) {
      // Канал успели закрыть и открыть заново: хост отменил прежнюю подписку, и её ошибка
      // к новой уже не относится.
      if (!this.mirror.isCurrent(token)) return;
      this.mirror.loadFinished(token, undefined);
      // Подписка остаётся отслеживаемой: после восстановления связи resync запросит снимок заново.
      this.reportChannelError(hostId, uri, toCallError(error));
      this.notifyChannel(hostId, uri);
      return;
    }
    if (!this.mirror.isCurrent(token)) return;
    if (snapshot?.state == null || !Number.isSafeInteger(snapshot.fromSeq)) {
      this.mirror.loadFinished(token, undefined);
      this.reportChannelError(hostId, uri, { message: 'Хост не вернул состояние канала' });
      this.notifyChannel(hostId, uri);
      return;
    }
    const loaded = this.mirror.loadFinished(token, snapshot);
    if (loaded) {
      if (uri.startsWith(TERMINAL_PREFIX)) this.trimTerminalMirror(hostId, uri);
      // Снимок — это reset+replay в эмуляторе: вывод, накопленный до него, должен уйти первым.
      this.terminalStream.flush(hostId, uri);
      // Снимок канала — тоже событие от хоста: страница здоровья показывает его время.
      this.lastEventAt.set(hostId, Date.now());
      this.sink.toWatchers(hostId, uri, { t: 'snapshot', hostId, uri, state: this.mirror.state(hostId, uri) ?? loaded.state });
      for (const type of loaded.invalidActions) this.reportInvalidAction(hostId, uri, type);
      if (uri === ROOT_URI) this.scheduleOverview();
    }
    this.notifyChannel(hostId, uri);
  }

  private async consumeHostEvents(): Promise<void> {
    for await (const event of this.multi.hostEvents()) {
      if (event.type === 'stateChanged' && event.lastError) {
        // AHP публикует lastError и при переходе в reconnecting, и при failed, поэтому
        // один сбой может увеличить счётчик дважды: история считает наблюдаемые повторы.
        this.recordHostIssue(event.hostId, event.lastError.message);
      }
      if (event.type === 'connected') {
        // Отвеченный initialize — подтверждение, что хост жив; неудачные попытки в
        // «последнее событие» не попадают, иначе сломанный хост выглядел бы активным.
        this.lastEventAt.set(event.hostId, Date.now());
        // При повторном подключении SDK доигрывает пропущенные actions, но если хост вместо
        // replay вернул снимки, не-root снимки он не отдаёт наружу. Поэтому состояние всех
        // отслеживаемых каналов перезапрашивается: порядок с replay разрешает serverSeq.
        const reconnecting = this.connectedOnce.has(event.hostId);
        if (reconnecting) this.historySearch.forgetHost(event.hostId);
        const uris = reconnecting ? this.mirror.urisOf(event.hostId) : [ROOT_URI];
        this.connectedOnce.add(event.hostId);
        for (const uri of uris) {
          // После перезапуска хоста нумерация может начаться заново.
          if (reconnecting) {
            this.mirror.drop(event.hostId, uri);
            this.mirror.track(event.hostId, uri);
          }
          void this.load(event.hostId, uri);
        }
      }
      this.scheduleOverview();
    }
  }

  private async consumeEvents(): Promise<void> {
    for await (const { hostId, channel, event } of this.multi.events()) {
      this.lastEventAt.set(hostId, Date.now());
      if (event.type === 'sessionRemoved') this.removeSession(hostId, event.params.session);
      if (event.type !== 'action') {
        // sessionAdded / sessionRemoved / sessionSummaryChanged / authRequired: сводку SDK уже обновил.
        this.scheduleOverview();
        continue;
      }
      const envelope = event.params;
      const action = envelope?.action;
      if (typeof action?.type !== 'string' || !Number.isSafeInteger(envelope.serverSeq)) {
        this.reportInvalidAction(hostId, channel, action?.type);
        continue;
      }
      const isTurn = action.type === ActionType.ChatTurnStarted;
      const subject = SEQUENCE_ACTION_LABEL[action.type];
      const origin = envelope.origin;
      const key = isTurn ? action.turnId : subject && origin
        ? sequenceActionKey(hostId, action.type, origin, this.multi.host(hostId)?.generation)
        : undefined;
      const candidate = key === undefined ? undefined : this.pendingActions.get(key);
      const pending = candidate?.hostId === hostId && candidate.channel === channel ? candidate : undefined;
      if (envelope.rejectionReason !== undefined) {
        if (pending) pending.finish(new CallFailure(`Хост отклонил ${isTurn ? 'сообщение' : subject}: ${envelope.rejectionReason}`));
        else this.sink.toWatchers(hostId, channel, { t: 'rejected', hostId, uri: channel, actionType: action.type, reason: envelope.rejectionReason });
        continue;
      }
      const applied = this.mirror.apply(hostId, envelope);
      if (applied === 'invalid') {
        this.reportInvalidAction(hostId, channel, action.type);
        pending?.finish(new CallFailure('Не удалось обработать подтверждение хоста. Проверьте чат перед повтором.'));
        continue;
      }
      if (applied === 'applied' && channel === ROOT_URI && action.type === ActionType.RootTerminalsChanged) {
        this.observeTerminals(hostId, (action as { terminals?: readonly TerminalInfo[] }).terminals ?? []);
      }
      if (channel.startsWith(TERMINAL_PREFIX)) this.afterTerminalAction(hostId, channel, action);
      const streamed = applied === 'applied' && this.streamTerminalData(hostId, channel, action);
      if (applied === 'applied' && !streamed) this.sink.toWatchers(hostId, channel, { t: 'action', hostId, uri: channel, action });
      pending?.finish();
      this.notifyChannel(hostId, channel);
      if (channel === ROOT_URI) this.scheduleOverview();
    }
  }

  /**
   * Вывод PTY не идёт через обычный `action`: он копится и уходит кадрами `terminalData`.
   * Любое другое действие канала сначала выдавливает накопленное, чтобы порядок
   * «вывод → статус» сохранялся в браузере.
   */
  private streamTerminalData(hostId: string, channel: string, action: StateAction): boolean {
    if (action.type !== ActionType.TerminalData) return false;
    const data = (action as { data?: unknown }).data;
    if (typeof data !== 'string') return false;
    // За каналом никто не следит — копить кадры некому; состояние канала обновится в зеркале.
    if ((this.watchCounts.get(channelKey(hostId, channel)) ?? 0) > 0) this.terminalStream.push(hostId, channel, data);
    this.trimTerminalMirror(hostId, channel);
    return true;
  }

  private afterTerminalAction(hostId: string, channel: string, action: StateAction): void {
    // Вывод обязан дойти до браузера раньше статуса — иначе последние строки пропадут.
    if (action.type !== ActionType.TerminalData) this.terminalStream.flush(hostId, channel);
  }

  /**
   * Отслеживает срок жизни своих терминалов по списку из root. Запись `terminalSeenAt`
   * заводится при появлении терминала и после того, как за ним перестали следить,
   * поэтому рестарт backend не сбрасывает отсчёт автоочистки в бесконечность.
   */
  private observeTerminals(hostId: string, terminals: readonly TerminalInfo[], now = Date.now()): void {
    const host = this.multi.host(hostId);
    if (!host) return;
    const seen = new Set<string>();
    const resources = new Set<string>();
    for (const terminal of terminals) {
      const key = channelKey(hostId, terminal.resource);
      seen.add(key);
      resources.add(terminal.resource);
      // Созданный нами терминал попал в список хоста: резерв слота больше не нужен.
      this.untrackUri(this.pendingTerminals, hostId, terminal.resource);
      if (!this.isOwnTerminal(hostId, terminal.claim)) continue;
      if (this.terminalSeenAt.has(key)) continue;
      if ((this.watchCounts.get(key) ?? 0) > 0) continue;
      this.terminalSeenAt.set(key, now);
    }
    // Закрытый нами терминал исчез из списка хоста — запись о закрытии можно снять.
    for (const uri of [...(this.terminalDisposals.get(hostId) ?? [])]) {
      if (!resources.has(uri)) this.untrackUri(this.terminalDisposals, hostId, uri);
    }
    // Терминал исчез (закрыт нами или хостом) — его запись больше не нужна.
    for (const key of [...this.terminalSeenAt.keys()]) {
      if (!key.startsWith(`${hostId}\u0000${TERMINAL_PREFIX}`)) continue;
      if (!seen.has(key)) this.terminalSeenAt.delete(key);
    }
  }

  /** Ограничивает историю вывода в зеркале: полная история PTY backend не нужна. */
  private trimTerminalMirror(hostId: string, channel: string): void {
    this.mirror.rewrite(hostId, channel, state => {
      const terminal = state as TerminalState;
      if (contentBytes(terminal.content) <= TERMINAL_MIRROR_BYTES) return state;
      return { ...terminal, content: trimTerminalContent(terminal.content, TERMINAL_MIRROR_BYTES) };
    });
  }

  private reportInvalidAction(hostId: string, uri: string, type: unknown): void {
    console.warn('[hub] Некорректное действие хоста', hostId, uri, typeof type === 'string' ? type : 'без типа');
    this.sink.toWatchers(hostId, uri, { t: 'channelError', hostId, uri, error: 'Не удалось применить действие хоста' });
  }

  private recordHostIssue(hostId: string, message: string): void {
    const issues = this.hostIssues.get(hostId) ?? [];
    this.hostIssues.set(hostId, appendHostIssue(issues, redactSecrets(message), new Date().toISOString()));
  }

  private reportChannelError(hostId: string, uri: string, failure: CallError): void {
    this.channelErrors.set(channelKey(hostId, uri), failure);
    this.sink.toWatchers(hostId, uri, { t: 'channelError', hostId, uri, error: failure.message, ...(failure.code !== undefined ? { code: failure.code } : {}) });
  }

  private removeSession(hostId: string, sessionUri: string): void {
    const session = this.mirror.state(hostId, sessionUri) as SessionState | undefined;
    const chatUris = session?.chats.map(chat => chat.resource) ?? [];
    for (const uri of [sessionUri, ...chatUris]) {
      // Инвалидирует также снимок, который ещё в полёте: удалённая сессия не должна появиться снова.
      this.mirror.drop(hostId, uri);
      const key = channelKey(hostId, uri);
      if (this.watchCounts.has(key)) this.channelErrors.set(key, { message: 'Сессия удалена на хосте', code: AhpErrorCodes.SessionNotFound });
      this.notifyChannel(hostId, uri);
      void this.multi.unsubscribe(hostId, uri).catch(error => console.warn(`[hub] unsubscribe removed ${uri}:`, errorMessage(error)));
    }
    this.historySearch.forgetSession(hostId, sessionUri);
    this.sink.broadcast({ t: 'sessionRemoved', hostId, sessionUri, chatUris });
  }

  private scheduleOverview(): void {
    // Потоковые события идут пачками; сводку достаточно пересобрать один раз на пачку.
    this.overviewTimer ??= setTimeout(() => {
      this.overviewTimer = undefined;
      this.sink.broadcast({ t: 'overview', overview: this.overview() });
    }, 30);
  }

  private hostOverview(host: HostHandle): HostOverview {
    const root = this.mirror.state(host.id, ROOT_URI) as RootState | undefined;
    const configValues = root?.config?.values ?? {};
    // Список терминалов уже есть в зеркале root: отдельная карта в панели не нужна.
    const terminals = this.hostTerminals(host.id)
      .filter(terminal => this.isOwnTerminal(host.id, terminal.claim))
      .map(terminal => ({ resource: terminal.resource, title: terminal.title, lifecycle: terminal.lifecycle }));
    return {
      id: host.id,
      label: host.label,
      slashCompletions: host.completionTriggerCharacters?.includes('/') ?? false,
      status: host.state.status,
      ...(host.lastError ? { error: redactSecrets(host.lastError.message) } : {}),
      ...(host.protocolVersion ? { protocolVersion: host.protocolVersion } : {}),
      ...(host.defaultDirectory ? { defaultDirectory: host.defaultDirectory } : {}),
      ...(terminals.length > 0 ? { terminals } : {}),
      canPickDirectory: this.directories?.picker?.availableFor(host.id) ?? false,
      agents: host.agents.filter(agent => !this.visibleAgents || this.visibleAgents.includes(agent.provider)).map((agent): AgentOverview => {
        const setup = readSdkSetup(configValues[`${SDK_STATUS_KEY_PREFIX}${agent.provider}`]);
        const configuredModel = this.defaultModels?.get(host.id)?.[agent.provider];
        // VS Code CodexAgent берёт первую модель из опубликованного каталога.
        const hostDefault = agent.provider === 'codex' && root?._meta?.hostBuild ? agent.models[0]?.id : undefined;
        const defaultModelId = agent.models.some(model => model.id === configuredModel) ? configuredModel : hostDefault;
        return {
          provider: agent.provider,
          displayName: agent.displayName,
          models: agent.models.map(model => ({
            id: model.id,
            name: model.name,
            ...(model.configSchema ? { configSchema: model.configSchema } : {}),
            ...(model.supportsVision !== undefined ? { supportsVision: model.supportsVision } : {}),
          })),
          ...(defaultModelId ? { defaultModelId } : {}),
          ...(agent.capabilities ? { capabilities: agent.capabilities } : {}),
          ...setup,
        };
      }),
    };
  }
}

function requireIdleHistory(chat: ChatState, lastTurnId: string | null): void {
  if (chat.activeTurn || chat.queuedMessages?.length || chat.steeringMessage) {
    throw new CallFailure('Дождитесь ответа агента и завершения очереди сообщений.');
  }
  if ((chat.turns.at(-1)?.id ?? null) !== lastTurnId) throw new CallFailure('История чата изменилась. Откройте сообщение заново.');
}

function editedMessage(original: Message, text: string): Message {
  if (original?.origin?.kind !== MessageKind.User || typeof text !== 'string') throw new CallFailure('Ожидалось сообщение пользователя.');
  const value = text.trim();
  if (!value && !original.attachments?.length) throw new CallFailure('Пустое сообщение');
  if (value === original.text) return original;
  // Позиции встроенных ссылок относятся к исходному тексту.
  const attachments = original.attachments?.map(({ range: _range, ...attachment }) => attachment);
  return { ...original, text: value, ...(attachments ? { attachments } : {}) };
}

function sequenceActionKey(hostId: string, type: StateAction['type'], origin: ActionOrigin, generation: number | undefined): string {
  return JSON.stringify([hostId, generation, type, origin.clientId, origin.clientSeq]);
}

function readSdkSetup(value: unknown): { sdk?: AgentSdkDownload; setupDocsUrl?: string } {
  if (!value || typeof value !== 'object') return {};
  const { download, setupDocsUrl } = value as { download?: unknown; setupDocsUrl?: unknown };
  if (typeof download !== 'string' || !SDK_DOWNLOAD_VALUES.includes(download)) return {};
  return {
    sdk: download as AgentSdkDownload,
    ...(typeof setupDocsUrl === 'string' ? { setupDocsUrl } : {}),
  };
}

/**
 * Отказ хоста при листинге: сохраняем код, чтобы UI мог отличить причины,
 * но переводим текст. `AuthRequired` идёт без кода: `describeCallError` подменяет
 * любой -32007 подсказкой про SDK агента, которая здесь неверна.
 */
function directoryFailure(error: unknown): unknown {
  if (error instanceof RpcError) {
    if (error.code === AhpErrorCodes.NotFound) return new CallFailure('Папка не найдена на хосте', error.code);
    if (error.code === AhpErrorCodes.PermissionDenied) return new CallFailure('Хост не разрешает просмотр этой папки', error.code);
    if (error.code === AhpErrorCodes.AuthRequired) return new CallFailure('Хост требует авторизации для просмотра папок. Проверьте вход на хосте.');
  }
  return error;
}

/** Абсолютный POSIX-путь на хосте -> file: URI. Путь принадлежит хосту, а не машине backend. */
export function toFileUri(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith('/')) throw new CallFailure('Укажите абсолютный путь к папке на хосте, например /Users/me/project');
  return `file://${trimmed.split('/').map(encodeURIComponent).join('/')}`;
}

