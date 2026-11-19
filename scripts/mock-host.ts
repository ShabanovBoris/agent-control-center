// Учебный AHP-хост для разработки и проверки панели без настоящих агентов.
// Состояние ведёт теми же редьюсерами SDK, что и клиенты, но сценарий «агента» выдуман:
// он отвечает эхом, а на слово «tool» в сообщении просит подтвердить вызов инструмента.
// Запуск: npx tsx scripts/mock-host.ts [port=8189]
import { randomUUID } from 'node:crypto';
import {
  ActionType,
  chatReducer,
  rootReducer,
  sessionReducer,
  type ActionEnvelope,
  type ChatAction,
  type ChatState,
  type RootAction,
  type RootState,
  type SessionAction,
  type SessionState,
  type SessionSummary,
  type StateAction,
} from '@microsoft/agent-host-protocol';
import { WebSocketServer, type WebSocket } from 'ws';

const port = Number(process.argv[2] ?? 8189);
const ROOT = 'ahp-root://';
const STATUS = { idle: 1, inProgress: 8, inputNeeded: 24 } as const;
const cast = <T>(value: unknown) => value as T;

let serverSeq = 0;
let root = cast<RootState>({
  agents: [{
    provider: 'mock',
    displayName: 'Mock Agent',
    description: 'Отвечает эхом, не настоящий агент',
    models: [{ id: 'mock-1', provider: 'mock', name: 'Mock 1' }],
  }],
  activeSessions: 0,
});
const sessions = new Map<string, SessionState>();
const chats = new Map<string, ChatState>();
const summaries = new Map<string, SessionSummary>();
const chatSession = new Map<string, string>();
/** Продолжение сценария хода, ждущее ответа на подтверждение инструмента. */
const awaitingConfirmation = new Map<string, (approved: boolean) => void>();
const scripts = new Map<string, AbortController>();

interface Connection {
  socket: WebSocket;
  clientId: string;
  subscriptions: Set<string>;
}
const connections = new Set<Connection>();

function stateOf(channel: string): unknown {
  if (channel === ROOT) return root;
  return sessions.get(channel) ?? chats.get(channel);
}

function notify(connection: Connection, method: string, params: unknown): void {
  if (connection.socket.readyState === connection.socket.OPEN) {
    connection.socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }
}

/** Применяет action к авторитетному состоянию и рассылает его подписчикам канала. */
function emit(channel: string, action: object, origin?: ActionEnvelope['origin']): void {
  if (channel === ROOT) root = rootReducer(root, cast<RootAction>(action));
  else if (sessions.has(channel)) sessions.set(channel, sessionReducer(sessions.get(channel)!, cast<SessionAction>(action)));
  else if (chats.has(channel)) chats.set(channel, chatReducer(chats.get(channel)!, cast<ChatAction>(action)));
  else return;
  const envelope = { channel, action, serverSeq: ++serverSeq, origin };
  for (const connection of connections) {
    if (connection.subscriptions.has(channel)) notify(connection, 'action', envelope);
  }
}

function setSummary(sessionUri: string, changes: Partial<SessionSummary>): void {
  const summary = { ...summaries.get(sessionUri)!, ...changes, modifiedAt: new Date().toISOString() };
  summaries.set(sessionUri, summary);
  for (const connection of connections) {
    notify(connection, 'root/sessionSummaryChanged', { channel: ROOT, session: sessionUri, changes: { ...changes, modifiedAt: summary.modifiedAt } });
  }
}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); }, { once: true });
});

async function runTurn(chatUri: string, turnId: string, text: string, signal: AbortSignal): Promise<void> {
  const sessionUri = chatSession.get(chatUri)!;
  const startedAt = Date.now();
  const say = async (content: string) => {
    const partId = randomUUID();
    emit(chatUri, { type: ActionType.ChatResponsePart, turnId, part: { kind: 'markdown', id: partId, content: '' } });
    for (const word of content.split(/(?<= )/)) {
      await pause(60, signal);
      emit(chatUri, { type: ActionType.ChatDelta, turnId, partId, content: word });
    }
  };
  setSummary(sessionUri, { status: STATUS.inProgress, activity: 'Отвечает' });
  await say(`Учебный ответ на сообщение: «${text}».`);
  if (/tool/i.test(text)) {
    const toolCallId = randomUUID();
    emit(chatUri, { type: ActionType.ChatToolCallStart, turnId, toolCallId, toolName: 'mock_shell', displayName: 'Запуск команды' });
    emit(chatUri, {
      type: ActionType.ChatToolCallReady, turnId, toolCallId,
      invocationMessage: 'Выполнить команду в терминале',
      confirmationTitle: 'Разрешить запуск команды?',
      toolInput: 'echo "hello from mock"',
      options: [
        { id: 'allow', label: 'Разрешить', kind: 'approve' },
        { id: 'deny', label: 'Отклонить', kind: 'deny' },
      ],
    });
    setSummary(sessionUri, { status: STATUS.inputNeeded, activity: 'Ждёт подтверждения' });
    const approved = await new Promise<boolean>((resolve, reject) => {
      awaitingConfirmation.set(toolCallId, resolve);
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
    setSummary(sessionUri, { status: STATUS.inProgress, activity: 'Отвечает' });
    if (approved) {
      await pause(400, signal);
      emit(chatUri, {
        type: ActionType.ChatToolCallComplete, turnId, toolCallId,
        result: { success: true, pastTenseMessage: 'Команда выполнена', content: [{ type: 'text', text: 'hello from mock' }] },
      });
      await say('Команда отработала, продолжаю.');
    } else {
      await say('Команду запускать не стал.');
    }
  }
  emit(chatUri, { type: ActionType.ChatTurnComplete, turnId, duration: Date.now() - startedAt });
  setSummary(sessionUri, { status: STATUS.idle, activity: '' });
}

/** Возвращает причину отказа либо `undefined`, если действие принято. */
function acceptDispatch(connection: Connection, channel: string, action: StateAction, origin: ActionEnvelope['origin']): string | undefined {
  const chat = chats.get(channel);
  switch (action.type) {
    case ActionType.RootConfigChanged:
      emit(ROOT, action, origin);
      return undefined;
    case ActionType.ChatTurnStarted: {
      if (!chat) return 'unknown chat';
      if (chat.activeTurn) return 'a turn is already in progress';
      emit(channel, action, origin);
      const controller = new AbortController();
      scripts.set(channel, controller);
      runTurn(channel, action.turnId, action.message.text, controller.signal)
        .catch(() => undefined)
        .finally(() => { if (scripts.get(channel) === controller) scripts.delete(channel); });
      return undefined;
    }
    case ActionType.ChatToolCallConfirmed: {
      const resume = awaitingConfirmation.get(action.toolCallId);
      if (!chat || !resume) return 'tool call is not pending confirmation';
      awaitingConfirmation.delete(action.toolCallId);
      emit(channel, action, origin);
      resume(action.approved);
      return undefined;
    }
    case ActionType.ChatTurnCancelled: {
      if (!chat?.activeTurn || chat.activeTurn.id !== action.turnId) return 'no active turn';
      scripts.get(channel)?.abort();
      emit(channel, action, origin);
      setSummary(chatSession.get(channel)!, { status: STATUS.idle, activity: '' });
      return undefined;
    }
    default:
      return `mock host does not accept ${action.type} from ${connection.clientId}`;
  }
}

function handleRequest(connection: Connection, method: string, params: any): unknown {
  switch (method) {
    case 'initialize':
    case 'reconnect': {
      connection.clientId = params.clientId;
      const wanted: string[] = params.initialSubscriptions ?? params.subscriptions ?? [];
      const snapshots = wanted.filter(uri => stateOf(uri) !== undefined).map(uri => {
        connection.subscriptions.add(uri);
        return { resource: uri, state: stateOf(uri), fromSeq: serverSeq };
      });
      // На reconnect всегда отвечаем снимками: это самый строгий для клиента вариант.
      return method === 'initialize'
        ? { protocolVersion: params.protocolVersions[0], serverSeq, snapshots, defaultDirectory: 'file:///mock/workspace' }
        : { type: 'snapshot', snapshots };
    }
    case 'ping':
      return null;
    case 'subscribe': {
      const state = stateOf(params.channel);
      if (state === undefined) throw { code: -32008, message: `No such channel: ${params.channel}` };
      connection.subscriptions.add(params.channel);
      return { snapshot: { resource: params.channel, state, fromSeq: serverSeq } };
    }
    case 'listSessions':
      return { items: [...summaries.values()] };
    case 'createSession': {
      const sessionUri: string = params.channel;
      if (sessions.has(sessionUri)) throw { code: -32003, message: 'Session already exists' };
      const chatUri = `ahp-chat:/${randomUUID()}`;
      const now = new Date().toISOString();
      const title = `Учебная сессия ${sessions.size + 1}`;
      const metadata = { provider: params.provider ?? 'mock', title, status: STATUS.idle, workingDirectories: params.workingDirectories ?? [] };
      const chatSummary = { resource: chatUri, title, status: STATUS.idle, modifiedAt: now };
      sessions.set(sessionUri, cast<SessionState>({ ...metadata, lifecycle: 'ready', activeClients: [], chats: [chatSummary], defaultChat: chatUri }));
      chats.set(chatUri, cast<ChatState>({ ...chatSummary, turns: [] }));
      chatSession.set(chatUri, sessionUri);
      const summary = cast<SessionSummary>({ ...metadata, resource: sessionUri, createdAt: now, modifiedAt: now, defaultChat: chatUri });
      summaries.set(sessionUri, summary);
      for (const other of connections) notify(other, 'root/sessionAdded', { channel: ROOT, summary });
      return null;
    }
    default:
      throw { code: -32601, message: `Method not found: ${method}` };
  }
}

new WebSocketServer({ host: '127.0.0.1', port }).on('connection', socket => {
  const connection: Connection = { socket, clientId: '', subscriptions: new Set() };
  connections.add(connection);
  socket.on('close', () => connections.delete(connection));
  socket.on('message', data => {
    const message = JSON.parse(String(data));
    if (message.id !== undefined) {
      try {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: handleRequest(connection, message.method, message.params) }));
      } catch (error) {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error }));
      }
    } else if (message.method === 'unsubscribe') {
      connection.subscriptions.delete(message.params.channel);
    } else if (message.method === 'dispatchAction') {
      const { channel, clientSeq, action } = message.params;
      const origin = { clientId: connection.clientId, clientSeq };
      const rejectionReason = acceptDispatch(connection, channel, action, origin);
      if (rejectionReason) notify(connection, 'action', { channel, action, serverSeq, origin, rejectionReason });
    }
  });
});
// Для проверки переподключения клиентов: kill -USR2 <pid> рвёт все соединения, состояние остаётся.
process.on('SIGUSR2', () => {
  for (const connection of connections) connection.socket.terminate();
});
console.log(`[mock-host] ws://127.0.0.1:${port} pid=${process.pid}`);
