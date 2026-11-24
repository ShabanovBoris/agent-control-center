// Контракт между backend и браузером. Браузер никогда не говорит с AHP-хостом напрямую:
// токен хоста живёт только в backend, а сюда попадают снимки состояния и actions.
import type {
  AgentCapabilities,
  ChatInputAnswer,
  ChatState,
  ChatSource,
  CompletionsResult,
  ChangesetState,
  Message,
  ModelSelection,
  ResolveSessionConfigResult,
  RootState,
  SessionConfigCompletionsResult,
  SessionConfigPropertySchema,
  SessionConfigSchema,
  SessionConfigValueItem,
  SessionModelInfo,
  SessionState,
  SessionSummary,
  StateAction,
} from '@microsoft/agent-host-protocol';
import type { DirectoryEntry } from './directory.js';
import type { UsageAggregate } from './usage.js';

export type { DirectoryEntry } from './directory.js';
export type {
  ResolveSessionConfigResult,
  SessionConfigCompletionsResult,
  SessionConfigPropertySchema,
  SessionConfigSchema,
  SessionConfigValueItem,
};

export type HostStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
export type SlashCompletions = CompletionsResult;

/** Готовность SDK агента на хосте. Приходит из служебных ключей VS Code в root config. */
export type AgentSdkDownload = 'notDownloaded' | 'downloadOnUse' | 'downloading' | 'ready';

export type ModelOverview = Pick<SessionModelInfo, 'id' | 'name' | 'configSchema' | 'supportsVision'>;

export interface AgentOverview {
  provider: string;
  displayName: string;
  models: ModelOverview[];
  defaultModelId?: string;
  /** Возможности агента по версии AHP: мультичаты, fork и side chat. */
  capabilities?: AgentCapabilities;
  /** Отсутствует, если хост не публикует статус SDK (не VS Code или старая версия). */
  sdk?: AgentSdkDownload;
  setupDocsUrl?: string;
}

export interface HostOverview {
  id: string;
  label: string;
  status: HostStatus;
  error?: string;
  protocolVersion?: string;
  slashCompletions?: boolean;
  defaultDirectory?: string;
  canPickDirectory?: boolean;
  /** Backend сейчас планово перезапускает хост (restart:services или обновление). */
  restarting?: boolean;
  agents: AgentOverview[];
}

export interface SessionOverview {
  hostId: string;
  hostLabel: string;
  summary: SessionSummary;
}

export interface Overview {
  hosts: HostOverview[];
  sessions: SessionOverview[];
}

/** Ключ пользовательского состояния панели: сессия конкретного хоста. */
export interface SessionRef {
  hostId: string;
  sessionUri: string;
}

export interface UnreadSession extends SessionRef {
  /** Всегда положительный: нулевой счётчик означает отсутствие записи, а не `count: 0`. */
  count: number;
}

/**
 * Состояние, которое принадлежит панели, а не AHP-хосту. `pinned` общее для всех устройств;
 * `unread` уже отфильтрован для origin получателя.
 */
export interface SessionUserState {
  pinned: SessionRef[];
  unread: UnreadSession[];
}

export type ChannelState = RootState | SessionState | ChatState | ChangesetState;

export interface UpdateCheck {
  changes: { name: string; current: string | null; available: string }[];
  restartBlocked?: string;
}

export type Call = HostCall
  | { op: 'checkUpdates' }
  | { op: 'applyUpdates' }
  | { op: 'restartServices' }
  | { op: 'searchHistory'; query: string; limit?: number }
  | { op: 'usageReport'; timeZone: string }
  | { op: 'pushConfig' }
  | { op: 'pushSubscribe'; origin: string; subscription: PushSubscriptionPayload }
  | { op: 'pushUnsubscribe'; endpoint: string }
  | { op: 'pushTest'; origin: string }
  | { op: 'pinSession'; hostId: string; sessionUri: string; pinned: boolean }
  | { op: 'health' }
  | { op: 'readLog'; hostId: string };

/** Поле хода, по которому нашлось совпадение. */
export type TurnFieldKind = 'message' | 'response' | 'reasoning' | 'notification' | 'error';
/** Поле overview, по которому нашлось совпадение. */
export type MetadataFieldKind = 'title' | 'chat' | 'provider' | 'host' | 'path';
export type SearchFieldKind = TurnFieldKind | MetadataFieldKind;

/** Почему backend-поиск не проверил всю историю. */
export type SearchStopReason = 'chat-budget' | 'page-budget' | 'deadline' | 'hit-budget' | 'text-budget';

export interface SearchIssue {
  hostId: string;
  uri?: string;
  message: string;
  /** JSON-RPC код хоста, если отказ пришёл от него. */
  code?: number;
}

export interface SearchHit {
  hostId: string;
  sessionUri: string;
  chatUri: string;
  turnId: string;
  score: number;
  field: TurnFieldKind;
  snippet: string;
  /** Диапазоны совпадений в координатах `snippet`. */
  ranges: readonly (readonly [number, number])[];
  startedAt?: string;
}

export interface SearchHistoryResult {
  hits: SearchHit[];
  /** Сколько видимых чатов у подключённых хостов было доступно. */
  candidateChats: number;
  scannedChats: number;
  scannedTurns: number;
  reasons: SearchStopReason[];
  issues: SearchIssue[];
}

/** Подмножество PushSubscriptionJSON, которое нужно backend; ключи проверяются на его стороне. */
export interface PushSubscriptionPayload {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export interface PushConfigResult { publicKey: string }

export interface PushTestResult { delivered: number }

/** Диагностика одного хоста: снимок версий и ограниченная история ошибок подключения. */
export interface HostIssue {
  /** ISO, время последнего повтора. */
  at: string;
  /** Уже без токенов и ключей. */
  message: string;
  /** Сколько раз ошибка повторилась подряд. */
  count: number;
}

export interface BackendHealth {
  /** Версия панели из package.json. */
  version: string;
  ahpVersion: string;
  startedAt: string;
  phoneAccess: boolean;
}

export type SdkVersions = Partial<Record<'codex' | 'claude', string | null>>;

export interface HostHealth {
  id: string;
  label: string;
  status: HostStatus;
  error?: string;
  protocolVersion?: string;
  hostBuild?: { version: string; commit: string };
  lastConnectedAt?: string;
  lastEventAt?: string;
  activeSessions?: number;
  /** Версии SDK агентов на запущенном хосте; `null` — SDK не найден. */
  sdkVersions?: SdkVersions;
  /** Причина, по которой версии SDK прочитать не удалось. */
  sdkError?: string;
  /** С момента запуска backend: история живёт в памяти и сбрасывается рестартом. */
  recentErrors: HostIssue[];
  /** Только для локальных хостов проекта, имя файла без абсолютного пути. */
  logFile?: string;
}

export interface HealthSnapshot {
  backend: BackendHealth;
  hosts: HostHealth[];
}

/**
 * Хвост журнала: отсутствие файла и запрет чтения — состояние, а не ошибка транспорта,
 * поэтому UI показывает их подсказкой.
 */
export type LogTail =
  | { status: 'ok'; hostId: string; fileName: string; lines: string[]; truncated: boolean; updatedAt?: string }
  | { status: 'missing' | 'unavailable'; hostId: string; fileName: string; message: string };
/** Почему отчёт по расходу не покрыл всю историю: подмножество причин поиска. */
export type UsageStopReason = Extract<SearchStopReason, 'chat-budget' | 'page-budget' | 'deadline'>;

/** Расход чата в отчёте. `partial`/`hasMoreTurns` означают нижнюю границу, а не точную сумму. */
export interface UsageReportChat extends UsageAggregate {
  hostId: string;
  sessionUri: string;
  chatUri: string;
  title: string;
  /** Служебный чат (подагент/worker) тоже расходует токены, но не индексируется поиском. */
  hidden: boolean;
  issue?: string;
}

export interface UsageReportSession extends UsageAggregate {
  hostId: string;
  hostLabel: string;
  sessionUri: string;
  title: string;
  provider: string;
  archived: boolean;
  chats: UsageReportChat[];
}

export interface UsageReport extends UsageAggregate {
  timeZone: string;
  generatedAt: string;
  sessions: UsageReportSession[];
  scannedChats: number;
  candidateChats: number;
  reasons: UsageStopReason[];
  issues: SearchIssue[];
}


export type EditMessageResult =
  | { status: 'sent' }
  | { status: 'truncated'; retainedTurnId: string | null; error: string };

/** Прямые дети каталога хоста. `source` говорит, кто ответил: AHP-хост или backend-листинг. */
export interface DirectoryListing {
  path: string;
  source: 'host' | 'backend';
  /** Порядок не гарантирован: UI сортирует каталоги раньше файлов. */
  entries: DirectoryEntry[];
}

export type HostCall =
  | { op: 'createSession'; hostId: string; provider: string; workingDirectory: string; config?: Record<string, unknown> }
  | { op: 'resolveSessionConfig'; hostId: string; provider: string; workingDirectory: string; config?: Record<string, unknown> }
  | { op: 'sessionConfigCompletions'; hostId: string; provider: string; workingDirectory: string; config?: Record<string, unknown>; property: string; query?: string }
  | { op: 'pickDirectory'; hostId: string; initialDirectory?: string }
  | { op: 'listDirectory'; hostId: string; path: string }
  | { op: 'archiveSession'; hostId: string; sessionUri: string; archived: boolean }
  | { op: 'refreshSession'; hostId: string; sessionUri: string }
  | { op: 'fetchTurns'; hostId: string; chatUri: string; cursor: string }
  | { op: 'slashCompletions'; hostId: string; sessionUri: string; chatUri: string; text: string; offset: number }
  | { op: 'createChat'; hostId: string; sessionUri: string; chatUri: string; source?: ChatSource; title?: string }
  | { op: 'forkSession'; hostId: string; sessionUri: string; chatUri: string; turnId: string }
  | { op: 'editMessage'; hostId: string; sessionUri: string; chatUri: string; turnId: string; lastTurnId: string; text: string; replacementId: string }
  | { op: 'retryEditedMessage'; hostId: string; sessionUri: string; chatUri: string; retainedTurnId: string | null; message: Message; text: string; replacementId: string }
  | { op: 'updateSessionConfig'; hostId: string; sessionUri: string; config: Record<string, unknown>; waitForHost?: true }
  | { op: 'updateChatConfig'; hostId: string; chatUri: string; config: Record<string, unknown>; waitForHost?: true }
  | { op: 'readResource'; hostId: string; uri: string; contentType?: string }
  | { op: 'sendMessage'; hostId: string; chatUri: string; text: string; attachments?: Message['attachments']; modelId?: string; modelConfig?: ModelSelection['config']; waitForHost?: true }
  | { op: 'cancelTurn'; hostId: string; chatUri: string; turnId: string }
  | { op: 'confirmTool'; hostId: string; chatUri: string; turnId: string; toolCallId: string; approved: boolean; optionId?: string }
  | { op: 'completeInput'; hostId: string; chatUri: string; requestId: string; response: 'accept' | 'decline' | 'cancel'; answers?: Record<string, ChatInputAnswer> }
  | { op: 'agentSetup'; hostId: string; agent: string; request: 'download' | 'reload' }
  | { op: 'reconnectHost'; hostId: string };

export type ClientMessage =
  | { t: 'cancelDirectoryPicker' }
  | { t: 'cancelSearch'; id: number }
  | { t: 'cancelUsage'; id: number }
  | { t: 'watch'; hostId: string; uri: string }
  | { t: 'unwatch'; hostId: string; uri: string }
  | { t: 'presence'; visible: boolean; selection?: { hostId: string; sessionUri: string } }
  | { t: 'call'; id: number; call: Call };

export interface CallError {
  message: string;
  /** JSON-RPC код ошибки хоста, если отказал сам хост (например, -32007 AuthRequired). */
  code?: number;
}

export type ServerMessage =
  | { t: 'overview'; overview: Overview }
  | { t: 'snapshot'; hostId: string; uri: string; state: ChannelState }
  | { t: 'action'; hostId: string; uri: string; action: StateAction }
  /** Хост отклонил действие (например, чужой клиент уже ответил на approval). */
  | { t: 'rejected'; hostId: string; uri: string; actionType: string; reason: string }
  | { t: 'channelError'; hostId: string; uri: string; error: string; code?: number }
  | { t: 'sessionRemoved'; hostId: string; sessionUri: string; chatUris: string[] }
  | { t: 'sessionUserState'; state: SessionUserState }
  | { t: 'result'; id: number; ok: true; data?: unknown }
  | { t: 'result'; id: number; ok: false; error: CallError };

export const ROOT_URI = 'ahp-root://';
export const AUTH_REQUIRED_CODE = -32007;
/** Хост не реализует метод AHP: для конфигурации сессии это штатная деградация. */
export const METHOD_NOT_FOUND_CODE = -32601;
export const SIDE_CHAT_FIRST_EDIT_UNAVAILABLE = 'При обрезке первого сообщения хост сбрасывает исходный контекст бокового чата.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Понятный текст ошибки вызова; коды AHP не теряются. */
export function describeCallError(detail: CallError): string {
  if (detail.code === AUTH_REQUIRED_CODE) {
    return 'Агент не готов на этом хосте: скачайте его SDK и выполните вход (блок «Хосты и агенты»).';
  }
  return detail.message;
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function hasChannelAddress(message: Record<string, unknown>): boolean {
  return typeof message.hostId === 'string' && typeof message.uri === 'string';
}

/** Ссылка на сессию в пользовательском состоянии панели; другие URI здесь недопустимы. */
export function isSessionRef(value: unknown): value is SessionRef {
  if (!isRecord(value)) return false;
  const { hostId, sessionUri } = value;
  return typeof hostId === 'string' && hostId.length > 0
    && typeof sessionUri === 'string' && sessionUri.startsWith('ahp-session:');
}

function isUnreadSession(value: unknown): value is UnreadSession {
  if (!isSessionRef(value)) return false;
  const { count } = value as Partial<UnreadSession>;
  return typeof count === 'number' && Number.isInteger(count) && count > 0;
}

function isSessionUserState(value: unknown): value is SessionUserState {
  if (!isRecord(value)) return false;
  const { pinned, unread } = value;
  return Array.isArray(pinned) && pinned.every(isSessionRef)
    && Array.isArray(unread) && unread.every(isUnreadSession);
}

export function parseClientMessage(raw: string): ClientMessage | undefined {
  const message = parseObject(raw);
  switch (message?.t) {
    case 'watch':
    case 'unwatch':
      if (!hasChannelAddress(message)) return undefined;
      break;
    case 'presence': {
      const { visible, selection } = message;
      if (typeof visible !== 'boolean') return undefined;
      if (selection !== undefined && (!isRecord(selection)
        || typeof selection.hostId !== 'string' || typeof selection.sessionUri !== 'string')) return undefined;
      break;
    }
    case 'call': {
      const { id, call } = message;
      if (typeof id !== 'number' || !Number.isFinite(id) || !isRecord(call) || typeof call.op !== 'string') return undefined;
      break;
    }
    case 'cancelDirectoryPicker':
      break;
    case 'cancelSearch':
    case 'cancelUsage':
      if (typeof message.id !== 'number' || !Number.isFinite(message.id)) return undefined;
      break;
    default:
      return undefined;
  }
  // Аргументы конкретной команды передаются в Hub.
  return message as ClientMessage;
}

export function parseServerMessage(raw: string): ServerMessage | undefined {
  const message = parseObject(raw);
  switch (message?.t) {
    case 'overview': {
      const { overview } = message;
      if (!isRecord(overview) || !Array.isArray(overview.hosts) || !Array.isArray(overview.sessions)) return undefined;
      break;
    }
    case 'snapshot':
      if (!hasChannelAddress(message) || !isRecord(message.state)) return undefined;
      break;
    case 'action':
      if (!hasChannelAddress(message) || !isRecord(message.action) || typeof message.action.type !== 'string') return undefined;
      break;
    case 'rejected':
      if (!hasChannelAddress(message) || typeof message.actionType !== 'string' || typeof message.reason !== 'string') return undefined;
      break;
    case 'channelError':
      if (!hasChannelAddress(message) || typeof message.error !== 'string') return undefined;
      if (message.code !== undefined && typeof message.code !== 'number') return undefined;
      break;
    case 'sessionRemoved': {
      const { hostId, sessionUri, chatUris } = message;
      if (typeof hostId !== 'string' || typeof sessionUri !== 'string') return undefined;
      if (!Array.isArray(chatUris) || !chatUris.every(uri => typeof uri === 'string')) return undefined;
      break;
    }
    case 'sessionUserState':
      // Нулевые и дробные счётчики — признак рассинхронизации: сообщение отбрасывается целиком,
      // чтобы клиент не показывал пустой badge и не терял pin из-за одной записи.
      if (!isSessionUserState(message.state)) return undefined;
      break;
    case 'result': {
      const { id, ok, error } = message;
      if (typeof id !== 'number' || !Number.isFinite(id)) return undefined;
      if (ok === true) break;
      if (ok !== false || !isRecord(error) || typeof error.message !== 'string') return undefined;
      if (error.code !== undefined && typeof error.code !== 'number') return undefined;
      break;
    }
    default:
      return undefined;
  }
  // Структуру вложенных снимков и действий определяет AHP.
  return message as ServerMessage;
}
