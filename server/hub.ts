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
  MessageKind,
  ToolCallCancellationReason,
  ToolCallConfirmationReason,
  ToolCallStatus,
  ResponsePartKind,
  SessionStatus,
  TurnState,
  type ActionOrigin,
  type ChatTurnStartedAction,
  type ChatState,
  type Message,
  type RootState,
  type SessionState,
  type Snapshot,
  type StateAction,
} from '@microsoft/agent-host-protocol';
import { RpcError } from '@microsoft/agent-host-protocol/client';
import type { HostConfig, HostHandle, MultiHostClient } from '@microsoft/agent-host-protocol/hosts';
import {
  ROOT_URI,
  SIDE_CHAT_FIRST_EDIT_UNAVAILABLE,
  type AgentOverview,
  type AgentSdkDownload,
  type HostCall as Call,
  type CallError,
  type ChannelState,
  type EditMessageResult,
  type HostOverview,
  type Overview,
  type ServerMessage,
  type SlashCompletions,
} from '../shared/protocol.js';
import { channelKey, isSupportedChannel } from '../shared/reduce.js';
import { ChannelMirror } from './mirror.js';
import type { DirectoryPicker } from './directory-picker.js';

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
const SEQUENCE_ACTION_LABEL: Partial<Record<StateAction['type'], string>> = {
  [ActionType.ChatConfigChanged]: 'изменение режима',
  [ActionType.SessionConfigChanged]: 'изменение режима',
  [ActionType.RootConfigChanged]: 'изменение настроек хоста',
  [ActionType.ChatTruncated]: 'обрезку истории',
};

type HistoryTarget = Pick<Extract<Call, { op: 'editMessage' }>, 'hostId' | 'sessionUri' | 'chatUri'>;

interface PendingAction {
  hostId: string;
  channel: string;
  finish(error?: unknown): void;
}

export class CallFailure extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

export interface HubSink {
  /** Сообщение всем подключённым браузерам. */
  broadcast(message: ServerMessage): void;
  /** Сообщение браузерам, которые смотрят канал. */
  toWatchers(hostId: string, uri: string, message: ServerMessage): void;
}

/**
 * Связывает AHP-хосты с браузерами: держит соединения через MultiHostClient,
 * ведёт зеркало состояния каналов и переводит узкие команды UI в AHP actions.
 */
export class Hub {
  private readonly mirror = new ChannelMirror();
  private readonly watchCounts = new Map<string, number>();
  private readonly channelErrors = new Map<string, CallError>();
  private readonly connectedOnce = new Set<string>();
  private readonly pendingActions = new Map<string, PendingAction>();
  private readonly editingChats = new Set<string>();
  private overviewTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly multi: MultiHostClient,
    private readonly sink: HubSink,
    /** Показываемые агенты (provider); `undefined` — все, что предлагает хост. */
    private readonly visibleAgents?: readonly string[],
    private readonly directoryPicker?: Pick<DirectoryPicker, 'availableFor' | 'choose'>,
    private readonly defaultModels?: ReadonlyMap<string, Readonly<Record<string, string>>>,
  ) {}

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
    for (const action of this.pendingActions.values()) action.finish(new CallFailure('Backend завершает работу'));
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
    if (count === 0) {
      this.mirror.track(hostId, uri);
      void this.load(hostId, uri);
      return undefined;
    }
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
    this.multi.unsubscribe(hostId, uri).catch(error => console.warn(`[hub] unsubscribe ${uri} failed:`, errorMessage(error)));
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

  private async execute(call: Call, signal?: AbortSignal): Promise<unknown> {
    switch (call.op) {
      case 'pickDirectory':
        if (!this.multi.host(call.hostId) || !this.directoryPicker) throw new CallFailure('Выбор папки через Finder недоступен');
        return { directory: await this.directoryPicker.choose(call.hostId, call.initialDirectory, signal) };
      case 'createSession': {
        const sessionUri = `ahp-session:/${randomUUID()}`;
        await this.client(call.hostId).request('createSession', {
          channel: sessionUri,
          provider: call.provider,
          workingDirectories: [toFileUri(call.workingDirectory)],
        });
        return { sessionUri };
      }
      case 'archiveSession': {
        if (!call.sessionUri.startsWith('ahp-session:')) throw new CallFailure('Ожидалась сессия');
        if (typeof call.archived !== 'boolean') throw new CallFailure('Укажите состояние архива');
        this.dispatch(call.hostId, call.sessionUri, { type: ActionType.SessionIsArchivedChanged, isArchived: call.archived });
        return undefined;
      }
      case 'refreshSession': {
        if (!call.sessionUri.startsWith('ahp-session:')) throw new CallFailure('Ожидалась сессия');
        if (!this.watchCounts.has(channelKey(call.hostId, call.sessionUri))) throw new CallFailure('Сессия не открыта');
        this.mirror.track(call.hostId, call.sessionUri);
        await this.load(call.hostId, call.sessionUri);
        return undefined;
      }
      case 'fetchTurns':
        await this.client(call.hostId).request('fetchTurns', { channel: call.chatUri, cursor: call.cursor });
        return undefined;
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
        await this.client(hostId).request('fetchTurns', { channel: chatUri, cursor: chat.turnsNextCursor });
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

  private dispatch(hostId: string, uri: string, action: StateAction): void {
    this.client(hostId).dispatch(uri, action);
  }

  private dispatchTurnAndWait(hostId: string, chatUri: string, action: ChatTurnStartedAction, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.dispatch(hostId, chatUri, action);
    return this.waitForAction(action.turnId, hostId, chatUri, 'Хост не подтвердил отправку. Проверьте чат перед повтором.', signal);
  }

  private dispatchActionAndWait(hostId: string, channel: string, action: StateAction, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const host = this.multi.host(hostId);
    if (!host) throw new CallFailure(`Хост ${hostId} не подключён`);
    const { clientSeq } = this.client(hostId).dispatch(channel, action);
    const key = sequenceActionKey(hostId, action.type, { clientId: host.clientId, clientSeq }, host.generation);
    return this.waitForAction(key, hostId, channel, `Хост не подтвердил ${SEQUENCE_ACTION_LABEL[action.type]}. Проверьте чат перед повтором.`, signal);
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
      return;
    }
    if (!this.mirror.isCurrent(token)) return;
    if (snapshot?.state == null || !Number.isSafeInteger(snapshot.fromSeq)) {
      this.mirror.loadFinished(token, undefined);
      this.reportChannelError(hostId, uri, { message: 'Хост не вернул состояние канала' });
      return;
    }
    const loaded = this.mirror.loadFinished(token, snapshot);
    if (loaded) {
      this.sink.toWatchers(hostId, uri, { t: 'snapshot', hostId, uri, state: loaded.state });
      for (const type of loaded.invalidActions) this.reportInvalidAction(hostId, uri, type);
      if (uri === ROOT_URI) this.scheduleOverview();
    }
  }

  private async consumeHostEvents(): Promise<void> {
    for await (const event of this.multi.hostEvents()) {
      if (event.type === 'connected') {
        // При повторном подключении SDK доигрывает пропущенные actions, но если хост вместо
        // replay вернул снимки, не-root снимки он не отдаёт наружу. Поэтому состояние всех
        // отслеживаемых каналов перезапрашивается: порядок с replay разрешает serverSeq.
        const reconnecting = this.connectedOnce.has(event.hostId);
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
      if (applied === 'applied') this.sink.toWatchers(hostId, channel, { t: 'action', hostId, uri: channel, action });
      pending?.finish();
      if (channel === ROOT_URI) this.scheduleOverview();
    }
  }

  private reportInvalidAction(hostId: string, uri: string, type: unknown): void {
    console.warn('[hub] Некорректное действие хоста', hostId, uri, typeof type === 'string' ? type : 'без типа');
    this.sink.toWatchers(hostId, uri, { t: 'channelError', hostId, uri, error: 'Не удалось применить действие хоста' });
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
      void this.multi.unsubscribe(hostId, uri).catch(error => console.warn(`[hub] unsubscribe removed ${uri}:`, errorMessage(error)));
    }
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
    return {
      id: host.id,
      label: host.label,
      slashCompletions: host.completionTriggerCharacters?.includes('/') ?? false,
      status: host.state.status,
      ...(host.lastError ? { error: host.lastError.message } : {}),
      ...(host.protocolVersion ? { protocolVersion: host.protocolVersion } : {}),
      ...(host.defaultDirectory ? { defaultDirectory: host.defaultDirectory } : {}),
      canPickDirectory: this.directoryPicker?.availableFor(host.id) ?? false,
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

/** Абсолютный POSIX-путь на хосте -> file: URI. Путь принадлежит хосту, а не машине backend. */
export function toFileUri(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith('/')) throw new CallFailure('Укажите абсолютный путь к папке на хосте, например /Users/me/project');
  return `file://${trimmed.split('/').map(encodeURIComponent).join('/')}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toCallError(error: unknown): CallError {
  if (error instanceof CallFailure || error instanceof RpcError) return { message: error.message, ...(error.code !== undefined ? { code: error.code } : {}) };
  return { message: errorMessage(error) };
}
