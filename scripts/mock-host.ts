// Учебный AHP-хост для разработки и проверки панели без настоящих агентов.
// Состояние ведёт теми же редьюсерами SDK, что и клиенты, но сценарий «агента» выдуман:
// он отвечает эхом, а на слова «tool» и «input» просит подтверждение вызова или ввод,
// на слово «markdown» добавляет заголовок, список, таблицу и code block.
// История ходов хранится в памяти: снимок чата отдаёт хвост, остальное — через fetchTurns.
// Запуск: npx tsx scripts/mock-host.ts [port] или MOCK_HOST_PORT=8190; аргумент важнее env.
import { randomUUID } from 'node:crypto';
import {
  ActionType,
  AhpErrorCodes,
  ChatInputAnswerValueKind,
  ChatInputQuestionKind,
  ChatInputResponseKind,
  ChatOriginKind,
  JsonRpcErrorCodes,
  chatReducer,
  rootReducer,
  sessionReducer,
  SessionLifecycle,
  SessionStatus,
  type ActionEnvelope,
  type ChatAction,
  type ChatInputCompletedAction,
  type ChatOrigin,
  type ChatState,
  type ChatSummary,
  type RootAction,
  type RootState,
  type SessionAction,
  type SessionChatSummary,
  type SessionState,
  type SessionSummary,
  type StateAction,
} from '@microsoft/agent-host-protocol';
import { WebSocketServer, type WebSocket } from 'ws';
import { normalizeDirectoryPath, type DirectoryEntry } from '../shared/directory.js';
import { pathOf } from '../shared/text.js';

/** Детерминированное дерево для e2e; порядок нарочно не отсортирован, чтобы проверять сортировку UI. */
const MOCK_DIRECTORIES = new Map<string, readonly DirectoryEntry[]>([
  ['/mock/workspace', [
    { name: 'README.md', type: 'file' },
    { name: 'src', type: 'directory' },
    { name: 'docs', type: 'directory' },
  ]],
  ['/mock/workspace/src', [{ name: 'components', type: 'directory' }]],
  ['/mock/workspace/src/components', []],
  ['/mock/workspace/docs', [{ name: 'guide.md', type: 'file' }]],
]);

function parsePort(value: string | undefined): number {
  const port = value === undefined || value.trim() === '' ? 8189 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[mock-host] Порт должен быть целым числом 1..65535, получено: ${String(value)}`);
  }
  return port;
}

const port = parsePort(process.argv[2] ?? process.env.MOCK_HOST_PORT);
const ROOT = 'ahp-root://';
/** Сколько последних ходов отдаёт снимок чата; остальные грузятся через fetchTurns. */
const TURN_PAGE_SIZE = 6;
/** Канал гарантирует, что его action относится к редьюсеру этого канала; emit принимает их общим объектом. */
const cast = <T>(value: object) => value as T;

let serverSeq = 0;
let root: RootState = {
  agents: [{
    provider: 'mock',
    displayName: 'Mock Agent',
    description: 'Отвечает эхом, не настоящий агент',
    models: [{ id: 'mock-1', provider: 'mock', name: 'Mock 1' }],
    capabilities: { multipleChats: { sideChat: true } },
  }],
  activeSessions: 0,
};
const sessions = new Map<string, SessionState>();
const chats = new Map<string, ChatState>();
const summaries = new Map<string, SessionSummary>();
const chatSession = new Map<string, string>();
/** Продолжение сценария хода, ждущее ответа на подтверждение инструмента. */
const awaitingConfirmation = new Map<string, (approved: boolean) => void>();
/** Продолжение сценария хода, ждущее ответа на InputRequest. */
const awaitingInput = new Map<string, (action: ChatInputCompletedAction) => void>();
const scripts = new Map<string, AbortController>();

interface Connection {
  socket: WebSocket;
  clientId: string;
  subscriptions: Set<string>;
}
const connections = new Set<Connection>();

const olderCursor = (start: number): string => `older:${start}`;

function parseOlderCursor(value: string): number | undefined {
  const match = /^older:(\d+)$/.exec(value);
  if (!match) return undefined;
  const start = Number(match[1]);
  return Number.isSafeInteger(start) ? start : undefined;
}

/** Снимок чата — хвост истории с курсором на более раннюю страницу. */
function chatSnapshot(chat: ChatState): ChatState {
  if (chat.turns.length <= TURN_PAGE_SIZE) return chat;
  const start = chat.turns.length - TURN_PAGE_SIZE;
  return { ...chat, turns: chat.turns.slice(start), turnsNextCursor: olderCursor(start) };
}

function toSessionChatSummary(chat: ChatSummary): SessionChatSummary {
  return {
    resource: chat.resource,
    title: chat.title,
    status: chat.status,
    ...(chat.origin ? { origin: chat.origin } : {}),
    ...(chat.provider ? { provider: chat.provider } : {}),
  };
}

function stateOf(channel: string): unknown {
  if (channel === ROOT) return root;
  const chat = chats.get(channel);
  if (chat) return chatSnapshot(chat);
  return sessions.get(channel);
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

/**
 * Ждёт ответа пользователя и снимает ожидание при отмене хода,
 * чтобы после ChatTurnCancelled в картах не оставалось вечных резолверов.
 */
function awaitResponse<T>(pending: Map<string, (value: T) => void>, key: string, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      pending.delete(key);
      reject(new Error('cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    pending.set(key, value => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    });
  });
}

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
  setSummary(sessionUri, { status: SessionStatus.InProgress, activity: 'Отвечает' });
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
    setSummary(sessionUri, { status: SessionStatus.InputNeeded, activity: 'Ждёт подтверждения' });
    const approved = await awaitResponse(awaitingConfirmation, toolCallId, signal);
    setSummary(sessionUri, { status: SessionStatus.InProgress, activity: 'Отвечает' });
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
  // Ввод идёт после эха и tool: оба сценария проверяются на одном ходе независимо.
  if (/input/i.test(text)) {
    const requestId = randomUUID();
    emit(chatUri, {
      type: ActionType.ChatInputRequested,
      request: {
        id: requestId,
        message: 'Учебный хост просит ввод',
        questions: [{ id: 'answer', kind: ChatInputQuestionKind.Text, message: 'Что ответить?', required: false }],
      },
    });
    setSummary(sessionUri, { status: SessionStatus.InputNeeded, activity: 'Ждёт ввода' });
    const completed = await awaitResponse(awaitingInput, requestId, signal);
    setSummary(sessionUri, { status: SessionStatus.InProgress, activity: 'Отвечает' });
    if (completed.response === ChatInputResponseKind.Accept) {
      const result = completed.answers?.answer;
      const value = result && 'value' in result ? result.value : undefined;
      const answer = value?.kind === ChatInputAnswerValueKind.Text ? value.value.trim() : '';
      await say(answer ? `Принят ответ: ${answer}` : 'Принят ответ.');
    } else {
      await say('Ввод отклонён.');
    }
  }
  // Заголовок, список, таблица и длинная строка в code block: материал для проверки GFM-рендера
  // и отсутствия горизонтального скролла ленты на узком экране.
  if (/markdown/i.test(text)) {
    // Пустая строка отделяет блок от эха: соседние markdown-части склеиваются без разделителя.
    await pause(300, signal);
    await say('\n\n## Учебный отчёт\n\n- Первый пункт\n- Второй пункт\n\n'
      + '| Поле | Значение |\n| --- | --- |\n| Статус | Готово |\n\n'
      + '```\nhttps://example.test/' + 'a'.repeat(120) + '\n```');
  }
  emit(chatUri, { type: ActionType.ChatTurnComplete, turnId, duration: Date.now() - startedAt });
  setSummary(sessionUri, { status: SessionStatus.Idle, activity: '' });
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
    case ActionType.ChatInputCompleted: {
      const resume = awaitingInput.get(action.requestId);
      if (!chat || !resume) return 'input request is not pending';
      awaitingInput.delete(action.requestId);
      emit(channel, action, origin);
      resume(action);
      return undefined;
    }
    case ActionType.ChatTurnCancelled: {
      if (!chat?.activeTurn || chat.activeTurn.id !== action.turnId) return 'no active turn';
      scripts.get(channel)?.abort();
      emit(channel, action, origin);
      setSummary(chatSession.get(channel)!, { status: SessionStatus.Idle, activity: '' });
      return undefined;
    }
    default:
      return `mock host does not accept ${action.type} from ${connection.clientId}`;
  }
}

function invalidParams(message: string): never {
  throw { code: JsonRpcErrorCodes.InvalidParams, message };
}

/** Создаёт боковой чат: сценарий повторяет то, что панель запрашивает через Hub. */
function createChat(params: any): null {
  const sessionUri: string = params.channel;
  const session = sessions.get(sessionUri);
  if (!session || !sessionUri.startsWith('ahp-session:')) {
    throw { code: AhpErrorCodes.SessionNotFound, message: `No such session: ${sessionUri}` };
  }
  const chatUri: string = params.chat;
  if (typeof chatUri !== 'string' || !chatUri.startsWith('ahp-chat:')) invalidParams('createChat: нужен chat URI ahp-chat:');
  if (chats.has(chatUri)) throw { code: AhpErrorCodes.AlreadyExists, message: `Chat already exists: ${chatUri}` };
  // Hub не передаёт initialMessage; молча терять данные нельзя.
  if (params.initialMessage !== undefined) invalidParams('createChat: initialMessage не поддерживается');
  if (params.provider !== undefined && params.provider !== 'mock') invalidParams(`createChat: неизвестный provider ${String(params.provider)}`);

  let chatOrigin: ChatOrigin | undefined;
  if (params.source !== undefined) {
    const source = params.source;
    if (source?.kind !== 'sideChat') invalidParams('createChat: mock host поддерживает только sideChat');
    if (typeof source.chat !== 'string' || typeof source.turnId !== 'string') invalidParams('createChat: нужны chat и turnId');
    const sourceChat = chats.get(source.chat);
    if (!sourceChat || chatSession.get(source.chat) !== sessionUri) {
      invalidParams('createChat: исходный чат не принадлежит сессии');
    }
    const turnId = source.turnId;
    const known = sourceChat.activeTurn?.id === turnId || sourceChat.turns.some(turn => turn.id === turnId);
    if (!known) invalidParams('createChat: исходный ход недоступен');
    chatOrigin = {
      kind: ChatOriginKind.SideChat,
      chat: source.chat,
      turnId,
      ...(source.selection ? { selection: source.selection } : {}),
    };
  }

  const now = new Date().toISOString();
  const title = typeof params.title === 'string' && params.title.trim() ? params.title.trim() : `Боковой чат ${session.chats.length + 1}`;
  const summary: ChatSummary = {
    resource: chatUri,
    title,
    status: SessionStatus.Idle,
    modifiedAt: now,
    ...(chatOrigin ? { origin: chatOrigin } : {}),
  };
  chats.set(chatUri, { ...summary, turns: [] });
  chatSession.set(chatUri, sessionUri);
  emit(sessionUri, { type: ActionType.SessionChatAdded, summary });
  // sessionReducer заменяет объект сессии, поэтому каталог читается после emit.
  const updated = sessions.get(sessionUri)!;
  setSummary(sessionUri, { chats: updated.chats.map(toSessionChatSummary) });
  return null;
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
      if (state === undefined) throw { code: AhpErrorCodes.NotFound, message: `No such channel: ${params.channel}` };
      connection.subscriptions.add(params.channel);
      return { snapshot: { resource: params.channel, state, fromSeq: serverSeq } };
    }
    case 'listSessions':
      return { items: [...summaries.values()] };
    case 'resourceList': {
      if (typeof params?.uri !== 'string' || !params.uri.startsWith('file:')) invalidParams('resourceList: нужен file: URI');
      const path = normalizeDirectoryPath(pathOf(params.uri));
      if (!path) invalidParams(`resourceList: не удалось разобрать путь ${params.uri}`);
      const entries = MOCK_DIRECTORIES.get(path);
      if (!entries) throw { code: AhpErrorCodes.NotFound, message: `No such directory: ${path}` };
      return { entries };
    }
    case 'createSession': {
      const sessionUri: string = params.channel;
      if (sessions.has(sessionUri)) throw { code: AhpErrorCodes.SessionAlreadyExists, message: 'Session already exists' };
      const chatUri = `ahp-chat:/${randomUUID()}`;
      const now = new Date().toISOString();
      const title = `Учебная сессия ${sessions.size + 1}`;
      const metadata = { provider: params.provider ?? 'mock', title, status: SessionStatus.Idle, workingDirectories: params.workingDirectories ?? [] };
      const chatSummary: ChatSummary = { resource: chatUri, title, status: SessionStatus.Idle, modifiedAt: now };
      sessions.set(sessionUri, { ...metadata, lifecycle: SessionLifecycle.Ready, activeClients: [], chats: [chatSummary], defaultChat: chatUri });
      chats.set(chatUri, { ...chatSummary, turns: [] });
      chatSession.set(chatUri, sessionUri);
      const summary: SessionSummary = {
        ...metadata, resource: sessionUri, createdAt: now, modifiedAt: now,
        chats: [toSessionChatSummary(chatSummary)], defaultChat: chatUri,
      };
      summaries.set(sessionUri, summary);
      for (const other of connections) notify(other, 'root/sessionAdded', { channel: ROOT, summary });
      return null;
    }
    case 'createChat':
      return createChat(params);
    case 'fetchTurns': {
      const chat = chats.get(params.channel);
      if (!chat) throw { code: AhpErrorCodes.NotFound, message: `No such chat: ${params.channel}` };
      // Без курсора хост уже держит все ходы: загружать нечего.
      if (params.cursor === undefined) return {};
      const start = typeof params.cursor === 'string' ? parseOlderCursor(params.cursor) : undefined;
      if (start === undefined || start > chat.turns.length) {
        throw { code: JsonRpcErrorCodes.InvalidParams, message: `fetchTurns: неизвестный курсор ${String(params.cursor)}` };
      }
      const begin = Math.max(0, start - TURN_PAGE_SIZE);
      emit(params.channel, {
        type: ActionType.ChatTurnsLoaded,
        turns: chat.turns.slice(begin, start),
        ...(begin > 0 ? { turnsNextCursor: olderCursor(begin) } : {}),
      });
      return {};
    }
    default:
      throw { code: JsonRpcErrorCodes.MethodNotFound, message: `Method not found: ${method}` };
  }
}

const server = new WebSocketServer({ host: '127.0.0.1', port });
server.on('connection', socket => {
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
// Строка готовности печатается после фактического bind: по ней fixture понимает,
// что слушает именно запущенный ею процесс, а не чужой на том же порту.
server.on('listening', () => console.log(`[mock-host] ws://127.0.0.1:${port} pid=${process.pid}`));
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(`[mock-host] Не удалось слушать 127.0.0.1:${port}: ${error.message}`);
  process.exitCode = 1;
});
// Для проверки переподключения клиентов: kill -USR2 <pid> рвёт все соединения, состояние остаётся.
process.on('SIGUSR2', () => {
  for (const connection of connections) connection.socket.terminate();
});
