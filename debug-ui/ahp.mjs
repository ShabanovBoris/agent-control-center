import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ActionType, ChatInputAnswerState, ChatInputAnswerValueKind, ChatInputQuestionKind, ChatInputResponseKind,
  ConfirmationOptionKind, MessageKind, PROTOCOL_VERSION, ResponsePartKind, SessionStatus,
  ToolCallCancellationReason, ToolCallConfirmationReason, ToolCallStatus,
} from '@microsoft/agent-host-protocol';
import { AhpClient } from '@microsoft/agent-host-protocol/client';
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws';

const ROOT = 'ahp-root://';
const RECENT_TURNS = 20;
const CONNECT_MS = 4000;
const REQUEST_MS = 6000;
const ACK_MS = 10000;

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function describe(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/([?&]tkn=)[^\s"'&#]+/gi, '$1…');
}

function isUri(value, scheme) {
  return typeof value === 'string' && value.startsWith(scheme) && value.length > scheme.length && value.length <= 2048;
}

function list(value) { return Array.isArray(value) ? value : []; }

async function connectTransport(url) {
  const socket = new WebSocket(url);
  const lifetime = new AbortController();
  const options = { signal: lifetime.signal };
  const failed = () => { throw new RequestError(503, 'AHP-хост недоступен'); };
  try {
    await Promise.race([
      once(socket, 'open', options), once(socket, 'error', options).then(failed),
      once(socket, 'close', options).then(failed), delay(CONNECT_MS, null, options).then(failed),
    ]);
    return WebSocketTransport.fromSocket(socket);
  } catch (error) {
    socket.close();
    throw error;
  } finally {
    lifetime.abort();
  }
}

async function withChannel(client, uri, view, run) {
  try {
    const { result, subscription } = await client.subscribe(uri, view ? { view } : undefined);
    const state = result.snapshot?.state;
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new RequestError(502, 'Хост не вернул состояние канала');
    }
    return await run(state, subscription);
  } finally {
    // Освобождаем канал после снимка или подтверждения, в том числе при таймауте.
    await client.unsubscribe(uri).catch(() => {});
  }
}

function chatList(session) {
  return list(session.chats).filter(chat => isUri(chat?.resource, 'ahp-chat:'));
}

function chatFor(session, picked) {
  const chats = chatList(session);
  const defaultChat = isUri(session.defaultChat, 'ahp-chat:') ? session.defaultChat : undefined;
  if (!picked) return defaultChat ?? chats[0]?.resource;
  if (picked === defaultChat || chats.some(chat => chat.resource === picked)) return picked;
  throw new RequestError(404, 'Чат больше не входит в эту сессию');
}

function visibleTurn(turn, active = false) {
  const responseParts = list(turn.responseParts).flatMap(part => {
    switch (part?.kind) {
      case ResponsePartKind.Markdown: return [{ kind: part.kind, content: part.content }];
      case ResponsePartKind.Error: return [{ kind: part.kind, error: { message: part.error?.message } }];
      case ResponsePartKind.InputRequest: return active ? [part] : [];
      case ResponsePartKind.ToolCall: {
        const tool = part.toolCall;
        if (!tool) return [];
        const { toolCallId, toolName, displayName, status } = tool;
        const pending = active && (status === ToolCallStatus.PendingConfirmation || status === ToolCallStatus.PendingResultConfirmation);
        const details = pending ? {
          options: tool.options, confirmationTitle: tool.confirmationTitle, invocationMessage: tool.invocationMessage,
          pastTenseMessage: tool.pastTenseMessage, toolInput: tool.toolInput,
          content: list(tool.content).filter(item => item?.type === 'text'),
        } : {};
        return [{ kind: part.kind, toolCall: { toolCallId, toolName, displayName, status, ...details } }];
      }
      default: return [];
    }
  });
  return { id: turn.id, message: { text: turn.message?.text }, responseParts };
}

function buildAnswers(request, values) {
  const results = [];
  const raw = values && typeof values === 'object' ? values : {};
  for (const question of list(request.questions)) {
    const value = Object.hasOwn(raw, question.id) ? raw[question.id] : undefined;
    const invalid = () => new RequestError(400, `Проверьте ответ на вопрос «${question.title || question.message || question.id}»`);
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
      if (question.required) throw invalid();
      continue;
    }
    const { min, max } = question;
    const fits = size => (min === undefined || size >= min) && (max === undefined || size <= max);
    const options = list(question.options);
    const kinds = ChatInputAnswerValueKind;
    let kind;
    switch (question.kind) {
      case ChatInputQuestionKind.Text:
        if (typeof value === 'string' && fits(value.length)) kind = kinds.Text;
        break;
      case ChatInputQuestionKind.Integer:
      case ChatInputQuestionKind.Number:
        if (Number.isFinite(value) && fits(value) && (question.kind !== ChatInputQuestionKind.Integer || Number.isInteger(value))) kind = kinds.Number;
        break;
      case ChatInputQuestionKind.Boolean:
        if (typeof value === 'boolean') kind = kinds.Boolean;
        break;
      case ChatInputQuestionKind.SingleSelect:
        if (typeof value === 'string' && options.some(option => option.id === value)) kind = kinds.Selected;
        break;
      case ChatInputQuestionKind.MultiSelect:
        if (Array.isArray(value) && fits(value.length) && new Set(value).size === value.length && value.every(id => options.some(option => option.id === id))) kind = kinds.SelectedMany;
        break;
    }
    if (!kind) throw invalid();
    results.push([question.id, { state: ChatInputAnswerState.Submitted, value: { kind, value } }]);
  }
  return Object.fromEntries(results);
}

export function actionFor(command, chat, duration = 0) {
  const active = chat.activeTurn;
  if (command.op === 'send') {
    const text = typeof command.text === 'string' ? command.text.trim() : '';
    if (!text) throw new RequestError(400, 'Введите сообщение');
    if (active) throw new RequestError(409, 'В чате уже идёт ход');
    return {
      type: ActionType.ChatTurnStarted, turnId: randomUUID(), startedAt: new Date().toISOString(),
      message: { text, origin: { kind: MessageKind.User } },
    };
  }

  if (!active || active.id !== command.turnId) throw new RequestError(409, 'Ход уже изменился. Обновите чат.');
  const turnId = active.id;
  if (command.op === 'stop') return { type: ActionType.ChatTurnCancelled, turnId, duration };
  const parts = list(active.responseParts);
  if (command.op === 'input') {
    const request = parts.find(part => part?.kind === ResponsePartKind.InputRequest && part.response === undefined && part.request?.id === command.requestId)?.request;
    if (!request) throw new RequestError(409, 'Запрос агента уже закрыт');
    if (!Object.values(ChatInputResponseKind).includes(command.response)) throw new RequestError(400, 'Неизвестное действие с запросом');
    const answers = command.response === ChatInputResponseKind.Accept ? buildAnswers(request, command.answers) : undefined;
    return { type: ActionType.ChatInputCompleted, requestId: request.id, response: command.response, ...(answers ? { answers } : {}) };
  }

  if (command.op !== 'tool' || typeof command.approved !== 'boolean') throw new RequestError(400, 'Неизвестная команда');
  const tool = parts.find(part => part?.kind === ResponsePartKind.ToolCall && part.toolCall?.toolCallId === command.toolCallId)?.toolCall;
  if (!tool || tool.status !== command.status) throw new RequestError(409, 'Инструмент уже сменил состояние');
  const { toolCallId } = tool;
  const { approved } = command;
  if (tool.status === ToolCallStatus.PendingResultConfirmation) {
    return { type: ActionType.ChatToolCallResultConfirmed, turnId, toolCallId, approved };
  }
  if (tool.status !== ToolCallStatus.PendingConfirmation) throw new RequestError(409, 'Инструмент больше не ждёт подтверждения');
  const options = list(tool.options);
  const option = options.find(candidate => candidate.id === command.optionId &&
    candidate.kind === (approved ? ConfirmationOptionKind.Approve : ConfirmationOptionKind.Deny));
  if ((options.length > 0 || command.optionId !== undefined) && !option) throw new RequestError(400, 'Хост не предлагал такой вариант подтверждения');
  return {
    type: ActionType.ChatToolCallConfirmed, turnId, toolCallId, approved,
    ...(approved ? { confirmed: ToolCallConfirmationReason.UserAction } : { reason: ToolCallCancellationReason.Denied }),
    ...(option ? { selectedOptionId: option.id } : {}),
  };
}

async function dispatchAndWait(client, clientId, chatUri, subscription, action) {
  const { clientSeq } = client.dispatch(chatUri, action);
  const warning = 'Хост не подтвердил команду. Обновите чат перед повтором.';
  const deadline = new AbortController();
  const echo = async () => {
    for await (const event of subscription) {
      const envelope = event.type === 'action' && event.params;
      if (envelope?.channel !== chatUri || envelope.action?.type !== action.type) continue;
      const { origin } = envelope;
      const ours = origin ? origin.clientId === clientId && origin.clientSeq === clientSeq
        : action.type === ActionType.ChatTurnStarted && envelope.action.turnId === action.turnId;
      if (!ours) continue;
      if (envelope.rejectionReason !== undefined) throw new RequestError(409, `Хост отклонил команду. ${envelope.rejectionReason}`);
      return;
    }
    throw new RequestError(503, warning);
  };
  try {
    await Promise.race([
      echo(),
      delay(ACK_MS, null, { signal: deadline.signal }).then(() => { throw new RequestError(504, warning); }),
    ]);
  } finally {
    deadline.abort();
  }
}

export class HostConnection {
  #connection;
  #queue = Promise.resolve();
  #lastTurn;
  #closed = false;

  constructor(config) { this.config = config; }

  #use(run) {
    // Снимок, dispatch и отписка одного клиента выполняются последовательно.
    const result = this.#queue.then(async () => {
      if (this.#closed) throw new RequestError(503, 'Резервная панель останавливается');
      return run(await this.#connect());
    });
    this.#queue = result.then(() => {}, () => {});
    return result;
  }

  async #connect() {
    if (this.#connection?.client.connectionState.status === 'connected') return this.#connection;
    await this.#connection?.transport.close();
    this.#connection = undefined;
    const url = new URL(this.config.url);
    if (this.config.tokenFile) {
      let token;
      try { token = (await readFile(this.config.tokenFile, 'utf8')).trim(); }
      catch { throw new RequestError(503, 'Не удалось прочитать токен подключения к хосту'); }
      url.searchParams.set('tkn', token);
    }
    const transport = await connectTransport(url);
    const client = new AhpClient(transport, { requestTimeoutMs: REQUEST_MS, subscriptionBuffer: 256 });
    const clientId = randomUUID();
    client.connect();
    try {
      const init = await client.initialize({ clientId, protocolVersions: [PROTOCOL_VERSION], initialSubscriptions: [ROOT] });
      const root = list(init.snapshots).find(snapshot => snapshot.resource === ROOT)?.state;
      const providers = list(root?.agents).filter(agent => typeof agent?.provider === 'string')
        .filter(agent => !this.config.providers || this.config.providers.includes(agent.provider))
        .map(agent => ({ id: agent.provider, label: agent.displayName ?? agent.provider }));
      if (providers.length === 0) {
        for (const id of this.config.providers ?? []) providers.push({ id, label: id });
      }
      this.#connection = { client, clientId, transport, providers, defaultDirectory: init.defaultDirectory };
      return this.#connection;
    } catch (error) {
      await client.shutdown();
      await transport.close();
      throw error;
    }
  }

  overview() {
    return this.#use(async ({ client, providers, defaultDirectory }) => {
      const { id, label } = this.config;
      const { items, nextCursor } = await client.request('listSessions', { channel: ROOT, limit: 100 });
      if (!Array.isArray(items)) throw new RequestError(502, 'Хост не вернул список сессий');
      const sessions = items.filter(item => isUri(item?.resource, 'ahp-session:')).map(item => ({
        uri: item.resource, title: item.title, provider: item.provider, status: item.status, modifiedAt: item.modifiedAt,
      }));
      return { id, label, providers, defaultDirectory, sessions, moreSessions: Boolean(nextCursor) };
    });
  }

  session(sessionUri, pickedChat) {
    return this.#use(async ({ client }) => {
      const session = await withChannel(client, sessionUri, undefined, state => state);
      let chatUri, chat, chatError;
      try {
        chatUri = chatFor(session, pickedChat);
        if (chatUri) chat = await withChannel(client, chatUri, { turns: RECENT_TURNS }, state => state);
      } catch (error) {
        chatError = describe(error);
      }
      this.#duration(chat?.activeTurn);
      return {
        title: session.title, status: session.status, lifecycle: session.lifecycle,
        creationError: session.creationError?.message,
        chats: chatList(session).map(item => ({ uri: item.resource, title: item.title })),
        chatUri, chatError,
        turns: list(chat?.turns).slice(-RECENT_TURNS).filter(Boolean).map(turn => visibleTurn(turn)),
        activeTurn: chat?.activeTurn ? visibleTurn(chat.activeTurn, true) : undefined,
      };
    });
  }

  create(command) {
    return this.#use(async ({ client, providers }) => {
      if (!providers.some(provider => provider.id === command.provider)) throw new RequestError(400, 'Агент недоступен на этом хосте');
      const path = typeof command.directory === 'string' ? command.directory.trim() : '';
      if (!path.startsWith('/')) throw new RequestError(400, 'Укажите абсолютную рабочую папку на хосте');
      const sessionUri = `ahp-session:/${randomUUID()}`;
      await client.request('createSession', {
        channel: sessionUri, provider: command.provider,
        workingDirectories: [`file://${path.split('/').map(encodeURIComponent).join('/')}`],
      });
      return { sessionUri };
    });
  }

  command(sessionUri, chatUri, command) {
    return this.#use(async ({ client, clientId }) => {
      const session = await withChannel(client, sessionUri, undefined, state => state);
      chatFor(session, chatUri);
      if (command.op === 'send' && ((session.status & SessionStatus.IsArchived) !== 0 || session.lifecycle === 'failed')) {
        throw new RequestError(409, 'В эту сессию сейчас нельзя отправить сообщение');
      }
      return withChannel(client, chatUri, { turns: RECENT_TURNS }, async (chat, subscription) => {
        const action = actionFor(command, chat, this.#duration(chat.activeTurn));
        await dispatchAndWait(client, clientId, chatUri, subscription, action);
      });
    });
  }

  #duration(turn) {
    if (!turn) return 0;
    const now = performance.now();
    // Используем время наблюдения на наших часах при отмене хода из другого клиента.
    if (this.#lastTurn?.id !== turn.id) this.#lastTurn = { id: turn.id, since: now };
    return Math.round(now - this.#lastTurn.since);
  }

  async close() {
    this.#closed = true;
    await this.#connection?.client.shutdown();
    await this.#queue;
    await this.#connection?.client.shutdown();
    await this.#connection?.transport.close();
  }
}
