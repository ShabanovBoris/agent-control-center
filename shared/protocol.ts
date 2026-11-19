// Контракт между backend и браузером. Браузер никогда не говорит с AHP-хостом напрямую:
// токен хоста живёт только в backend, а сюда попадают снимки состояния и actions.
import type {
  AgentCapabilities,
  ChatInputAnswer,
  ChatState,
  ChatSource,
  ChangesetState,
  Message,
  ModelSelection,
  RootState,
  SessionModelInfo,
  SessionState,
  SessionSummary,
  StateAction,
} from '@microsoft/agent-host-protocol';

export type HostStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

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
  defaultDirectory?: string;
  canPickDirectory?: boolean;
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

export type ChannelState = RootState | SessionState | ChatState | ChangesetState;

export interface UpdateCheck {
  changes: { name: string; current: string | null; available: string }[];
  restartBlocked?: string;
}

export type Call = HostCall | { op: 'checkUpdates' } | { op: 'applyUpdates' };

export type EditMessageResult =
  | { status: 'sent' }
  | { status: 'truncated'; retainedTurnId: string | null; error: string };

export type HostCall =
  | { op: 'createSession'; hostId: string; provider: string; workingDirectory: string }
  | { op: 'pickDirectory'; hostId: string; initialDirectory?: string }
  | { op: 'archiveSession'; hostId: string; sessionUri: string; archived: boolean }
  | { op: 'refreshSession'; hostId: string; sessionUri: string }
  | { op: 'fetchTurns'; hostId: string; chatUri: string; cursor: string }
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
  | { t: 'watch'; hostId: string; uri: string }
  | { t: 'unwatch'; hostId: string; uri: string }
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
  | { t: 'result'; id: number; ok: true; data?: unknown }
  | { t: 'result'; id: number; ok: false; error: CallError };

export const ROOT_URI = 'ahp-root://';
export const AUTH_REQUIRED_CODE = -32007;
export const SIDE_CHAT_FIRST_EDIT_UNAVAILABLE = 'При обрезке первого сообщения хост сбрасывает исходный контекст бокового чата.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export function parseClientMessage(raw: string): ClientMessage | undefined {
  const message = parseObject(raw);
  switch (message?.t) {
    case 'watch':
    case 'unwatch':
      if (!hasChannelAddress(message)) return undefined;
      break;
    case 'call': {
      const { id, call } = message;
      if (typeof id !== 'number' || !Number.isFinite(id) || !isRecord(call) || typeof call.op !== 'string') return undefined;
      break;
    }
    case 'cancelDirectoryPicker':
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
