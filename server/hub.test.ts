import assert from 'node:assert/strict';
import { EventEmitter, on } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import {
  ActionType, ChatOriginKind, ChatSourceKind, MessageAttachmentKind, MessageKind, SessionLifecycle, TurnState,
  type ActionEnvelope, type ChatState, type MessageEmbeddedResourceAttachment, type SessionModelInfo, type SessionState, type StateAction, type Turn,
} from '@microsoft/agent-host-protocol';
import type { MultiHostClient } from '@microsoft/agent-host-protocol/hosts';
import type { SessionOverview } from '../shared/protocol.js';
import { Hub } from './hub.js';

const model: SessionModelInfo = {
  id: 'model-a', provider: 'codex', name: 'Model A',
  configSchema: {
    type: 'object',
    properties: {
      thinkingLevel: { type: 'string', title: 'Effort Level', enum: ['low', 'high', 'ultra'], enumLabels: ['Low', 'High', 'Ultra'], default: 'low' },
      contextSize: { type: 'number', title: 'Context', enum: [272000, 872000] },
    },
  },
};

function setup(models: SessionModelInfo[] = [model], request?: (method: string, params: unknown) => unknown) {
  const actions: StateAction[] = [];
  const targets: string[] = [];
  const requests: { method: string; params: unknown }[] = [];
  const events = new EventEmitter();
  const states = new Map<string, SessionState | ChatState>();
  const sessions: SessionOverview[] = [];
  const unsubscribed: string[] = [];
  let serverSeq = 0;
  const host = { id: 'h', clientId: 'browser-backend', label: 'Host', completionTriggerCharacters: ['/'], state: { status: 'connected' }, agents: [{
    provider: 'codex', displayName: 'Codex', models, capabilities: { multipleChats: { fork: true, sideChat: true } },
  }] };
  const multi = {
    host: () => host,
    client: () => ({
      dispatch: (uri: string, action: StateAction) => { targets.push(uri); return { clientSeq: actions.push(action) }; },
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        return request?.(method, params) ?? null;
      },
    }),
    subscribe: async (_hostId: string, uri: string) => ({ snapshot: { resource: uri, state: states.get(uri), fromSeq: serverSeq } }),
    async unsubscribe(_hostId: string, uri: string) { unsubscribed.push(uri); },
    hostsSnapshot: () => [host],
    aggregatedSessions: () => sessions,
    async *hostEvents() {},
    async *events() { for await (const [event] of on(events, 'action', { close: ['shutdown'] })) yield event; },
    async shutdown() { events.emit('shutdown'); },
  } as unknown as MultiHostClient;
  const hub = new Hub(multi, { broadcast() {}, toWatchers() {} });
  const echo = (channel: string, action: StateAction, origin: ActionEnvelope['origin'], rejectionReason?: string) => {
    events.emit('action', { hostId: host.id, channel, event: { type: 'action', params: { channel, action, origin, serverSeq: ++serverSeq, rejectionReason } } });
  };
  return { hub, actions, targets, requests, host, echo, states, sessions, unsubscribed };
}

const message = { op: 'sendMessage', hostId: 'h', chatUri: 'ahp-chat:/test', text: 'Task', modelId: model.id } as const;

test('панель получает схему reasoning модели без потери метаданных', () => {
  const { hub } = setup();
  assert.deepEqual(hub.overview().hosts[0]?.agents[0]?.models[0]?.configSchema, model.configSchema);
});

test('reasoning и остальные параметры выбранной модели доходят до AHP action', async () => {
  const { hub, actions } = setup();
  const config = { thinkingLevel: 'ultra', contextSize: 872000, providerFlag: true };
  await hub.call({ ...message, modelConfig: config });
  const action = actions[0];
  assert.equal(action?.type, ActionType.ChatTurnStarted);
  if (action?.type !== ActionType.ChatTurnStarted) assert.fail('Нет ChatTurnStarted');
  assert.deepEqual(action.message.model, { id: model.id, config });
});

test('без выбранного reasoning сохраняется обычная отправка с моделью и без неё', async () => {
  const { hub, actions } = setup();
  await hub.call(message);
  await hub.call({ ...message, modelId: undefined });
  const turns = actions.filter(action => action.type === ActionType.ChatTurnStarted);
  assert.deepEqual(turns[0]?.message.model, { id: model.id });
  assert.equal(turns[1]?.message.model, undefined);
});

test('сообщение с одним изображением передаёт байты и MIME-тип в AHP', async () => {
  const { hub, actions } = setup();
  const image: MessageEmbeddedResourceAttachment = {
    type: MessageAttachmentKind.EmbeddedResource,
    label: 'sample.png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6RQAAAAASUVORK5CYII=',
    contentType: 'image/png',
  };
  await hub.call({ ...message, text: '', attachments: [image] });
  const [action] = actions;
  if (action?.type !== ActionType.ChatTurnStarted) assert.fail('Нет ChatTurnStarted');
  assert.equal(action.message.text, '');
  assert.deepEqual(action.message.attachments, [image]);
});

test('разные файлы передаются вместе и без текста с исходными именами, типами и байтами', async () => {
  const { hub, actions } = setup();
  const attachments: MessageEmbeddedResourceAttachment[] = [
    { type: MessageAttachmentKind.EmbeddedResource, label: 'отчёт.pdf', contentType: 'application/pdf', data: 'JVBERi0xLjQK' },
    { type: MessageAttachmentKind.EmbeddedResource, label: 'данные.bin', contentType: 'application/octet-stream', data: 'AAEC/f7/' },
    { type: MessageAttachmentKind.EmbeddedResource, label: 'пустой.txt', contentType: 'text/plain', data: '' },
  ];
  await hub.call({ ...message, text: '', attachments });
  const [action] = actions;
  if (action?.type !== ActionType.ChatTurnStarted) assert.fail('Нет ChatTurnStarted');
  assert.equal(action.message.text, '');
  assert.deepEqual(action.message.attachments, attachments);
});

test('неподдерживаемый уровень, модель без reasoning и отсутствие modelId не запускают ход', async () => {
  const { hub, actions } = setup([model, { id: 'model-b', provider: 'codex', name: 'No reasoning' }]);
  await assert.rejects(hub.call({ ...message, modelConfig: { thinkingLevel: 'max' } }), /недоступен/);
  await assert.rejects(hub.call({ ...message, modelId: 'model-b', modelConfig: { thinkingLevel: 'low' } }), /недоступен/);
  await assert.rejects(hub.call({ ...message, modelId: undefined, modelConfig: { thinkingLevel: 'low' } }), /выберите модель/);
  assert.equal(actions.length, 0);
});

test('управляемый хостом уровень reasoning нельзя переопределить', async () => {
  const locked = structuredClone(model);
  locked.configSchema!.properties.thinkingLevel!.readOnly = true;
  const { hub, actions } = setup([locked]);
  await assert.rejects(hub.call({ ...message, modelConfig: { thinkingLevel: 'low' } }), /недоступен/);
  assert.equal(actions.length, 0);
});

test('архивирование и восстановление передаются хосту без удаления сессии', async () => {
  const { hub, actions, targets } = setup();
  for (const archived of [true, false]) await hub.call({ op: 'archiveSession', hostId: 'h', sessionUri: 'ahp-session:/one', archived });
  assert.deepEqual(actions, [
    { type: ActionType.SessionIsArchivedChanged, isArchived: true },
    { type: ActionType.SessionIsArchivedChanged, isArchived: false },
  ]);
  assert.deepEqual(targets, ['ahp-session:/one', 'ahp-session:/one']);
  await assert.rejects(hub.call({ op: 'archiveSession', hostId: 'h', sessionUri: 'ahp-chat:/one', archived: true }), /сессия/);
});

test('страницы истории запрашиваются у хоста с исходным opaque cursor', async () => {
  const { hub, requests } = setup();
  await hub.call({ op: 'fetchTurns', hostId: 'h', chatUri: 'ahp-chat:/one', cursor: 'opaque/+=' });
  assert.deepEqual(requests, [{ method: 'fetchTurns', params: { channel: 'ahp-chat:/one', cursor: 'opaque/+=' } }]);
});

test('изменение режима ждёт подтверждение именно своего действия и возвращает отказ хоста', async () => {
  const { hub, actions, targets, host, echo } = setup();
  await hub.start([]);
  try {
    const chatUri = 'ahp-chat:/test';
    const config = { 'codex.permissionsPreset': 'auto-review' };
    const updating = hub.call({ op: 'updateChatConfig', hostId: host.id, chatUri, config, waitForHost: true });
    const [action] = actions;
    assert.deepEqual(action, { type: ActionType.ChatConfigChanged, config });
    assert.deepEqual(targets, [chatUri]);
    let confirmed = false;
    void updating.then(() => { confirmed = true; });
    echo(chatUri, action!, { clientId: 'other-client', clientSeq: 1 });
    await setImmediate();
    assert.equal(confirmed, false);
    echo(chatUri, action!, { clientId: host.clientId, clientSeq: 1 });
    await updating;

    const sessionUri = 'ahp-session:/test';
    const rejected = hub.call({ op: 'updateSessionConfig', hostId: host.id, sessionUri, config, waitForHost: true });
    echo(sessionUri, actions[1]!, { clientId: host.clientId, clientSeq: 2 }, 'Read-only configuration');
    await assert.rejects(rejected, /Хост отклонил изменение режима: Read-only configuration/);
  } finally { await hub.stop(); }
});

const sessionUri = 'ahp-session:/history';
const chatUri = 'ahp-chat:/history';
const startedAt = '2026-11-19T06:00:00.000Z';
const history = ['first', 'second', 'third'].map((id): Turn => ({
  id,
  startedAt,
  message: { origin: { kind: MessageKind.User }, text: id, model: { id: model.id, config: { thinkingLevel: 'ultra' } }, agent: { uri: 'file:///agent' } },
  responseParts: [],
  usage: undefined,
  state: TurnState.Complete,
}));
const chatSummary = { resource: chatUri, title: 'Тема', status: 1, modifiedAt: startedAt };
const sessionState: SessionState = {
  title: 'Тема', status: 1, provider: 'codex',
  lifecycle: SessionLifecycle.Ready, activeClients: [], chats: [chatSummary], defaultChat: chatUri,
};

test('slash-подсказки: sessionUri только для defaultChat, отправка всегда в выбранный чат', async () => {
  const side = 'ahp-chat:/side';
  const attachment = { type: MessageAttachmentKind.Simple, label: '/rename', _meta: { command: 'rename', extra: { example: true } } } as const;
  const items = [{ insertText: '/rename ', attachment }];
  const fixture = setup([model], () => ({ items }));
  const { hub, host, states, requests, actions, targets, echo } = fixture;
  const call = { op: 'slashCompletions', hostId: host.id, sessionUri, chatUri, text: '/ren', offset: 4 } as const;
  await watchHistory(fixture);
  try {
    assert.deepEqual(await hub.call(call), { items });
    await assert.rejects(hub.call({ ...call, chatUri: side }), /не принадлежит/);
    const sideSummary = { ...chatSummary, resource: side };
    states.set(sessionUri, { ...sessionState, chats: [chatSummary, sideSummary] });
    states.set(side, { ...sideSummary, turns: [] });
    hub.watch(host.id, side);
    await hub.call({ op: 'refreshSession', hostId: host.id, sessionUri });
    await setImmediate();
    assert.deepEqual(await hub.call({ ...call, chatUri: side }), { items });
    assert.deepEqual(requests, [sessionUri, side].map(channel => ({
      method: 'completions', params: { channel, kind: 'userMessage', text: '/ren', offset: 4 },
    })));
    host.completionTriggerCharacters = ['@'];
    assert.deepEqual(await hub.call(call), { items: [] });
    assert.equal(requests.length, 2);
    for (const target of [chatUri, side]) {
      const sending = hub.call({ op: 'sendMessage', hostId: host.id, chatUri: target, text: '/rename Новое имя', attachments: [attachment], waitForHost: true });
      const action = actions.at(-1);
      if (action?.type !== ActionType.ChatTurnStarted) assert.fail('Ожидался ход');
      assert.equal(targets.at(-1), target);
      assert.equal(action.message.text, '/rename Новое имя');
      assert.deepEqual(action.message.attachments, [attachment]);
      echo(target, action, { clientId: host.clientId, clientSeq: actions.length }, 'test refusal');
      await assert.rejects(sending, /test refusal/);
    }
  } finally { await hub.stop(); }
});

async function watchHistory(fixture: ReturnType<typeof setup>, chat?: Partial<ChatState>) {
  fixture.states.set(sessionUri, sessionState);
  fixture.states.set(chatUri, { ...chatSummary, turns: history, ...chat });
  await fixture.hub.start([]);
  fixture.hub.watch('h', sessionUri);
  fixture.hub.watch('h', chatUri);
  await setImmediate();
}

test('форк использует выбранный старый ход и открывает отдельную сессию из ответа хоста', async () => {
  let forkUri: string;
  const fixture = setup([model], (method, params) => {
    if (method === 'createChat') forkUri = (params as { chat: string }).chat;
    if (method === 'subscribe') return { snapshot: { state: { ...sessionState, chats: [...sessionState.chats, { ...chatSummary, resource: forkUri, movable: true }] } } };
    if (method === 'moveChat') return { session: 'ahp-session:/independent' };
  });
  await watchHistory(fixture);
  try {
    const { hub, requests } = fixture;
    assert.deepEqual(await hub.call({ op: 'forkSession', hostId: 'h', sessionUri, chatUri, turnId: 'first' }), { sessionUri: 'ahp-session:/independent' });
    assert.equal(requests[0]?.method, 'createChat');
    assert.deepEqual((requests[0]?.params as { source: unknown }).source, { kind: ChatSourceKind.Fork, chat: chatUri, turnId: 'first' });
    assert.deepEqual(requests[2], { method: 'moveChat', params: { channel: forkUri!, destination: { kind: 'newSession' } } });
    assert.equal(fixture.actions.length, 0);
  } finally { await fixture.hub.stop(); }
});

test('редактирование проверяет свежесть истории и ждёт подтверждения обрезки предыдущего хода', async () => {
  const fixture = setup();
  const { hub, actions, host, echo } = fixture;
  await watchHistory(fixture);
  try {
    const call = { op: 'editMessage', hostId: 'h', sessionUri, chatUri, turnId: 'second', lastTurnId: 'third', text: 'Исправлено', replacementId: 'replacement' } as const;
    await assert.rejects(hub.call({ ...call, lastTurnId: 'second' }), /История чата изменилась/);
    assert.equal(actions.length, 0);
    const editing = hub.call(call);
    assert.deepEqual(actions[0], { type: ActionType.ChatTruncated, turnId: 'first' });
    await assert.rejects(hub.call({ ...message, chatUri }), /редактирования истории/);
    echo(chatUri, actions[0]!, { clientId: 'other-client', clientSeq: 1 });
    await setImmediate();
    assert.equal(actions.length, 1);
    echo(chatUri, actions[0]!, { clientId: host.clientId, clientSeq: 1 });
    await setImmediate();
    const attempt = actions[1];
    if (attempt?.type !== ActionType.ChatTurnStarted) assert.fail('Нет повторной отправки');
    assert.deepEqual(attempt.message, { ...history[1]?.message, text: 'Исправлено' });
    assert.equal(attempt.turnId, call.replacementId);

    echo(chatUri, attempt, { clientId: host.clientId, clientSeq: 2 }, 'test rejection');
    assert.deepEqual(await editing, { status: 'truncated', retainedTurnId: 'first', error: 'Хост отклонил сообщение: test rejection' });
    const retry = hub.call({
      op: 'retryEditedMessage', hostId: 'h', sessionUri, chatUri, retainedTurnId: 'first',
      message: history[1]!.message, text: call.text, replacementId: call.replacementId,
    });
    assert.equal(actions.filter(action => action.type === ActionType.ChatTruncated).length, 1);
    assert.equal(actions[2]?.type, ActionType.ChatTurnStarted);
    echo(chatUri, actions[2]!, { clientId: host.clientId, clientSeq: 3 });
    assert.deepEqual(await retry, { status: 'sent' });
  } finally { await hub.stop(); }
});

test('редактирование первого сообщения боковой ветки сохраняет скрытый контекст хоста', async () => {
  const fixture = setup();
  await watchHistory(fixture, { origin: { kind: ChatOriginKind.SideChat, chat: 'ahp-chat:/source', turnId: 'source-turn' } });
  try {
    await assert.rejects(fixture.hub.call({
      op: 'editMessage', hostId: 'h', sessionUri, chatUri, turnId: 'first', lastTurnId: 'third', text: 'Исправлено', replacementId: 'replacement',
    }), /исходный контекст бокового чата/);
    assert.equal(fixture.actions.length, 0);
  } finally { await fixture.hub.stop(); }
});

test('правка первого хода загруженной страницы сохраняет предыдущую страницу', async () => {
  const fixture = setup([model], async (method, params) => {
    assert.equal(method, 'fetchTurns');
    assert.deepEqual(params, { channel: chatUri, cursor: 'older-turns' });
    fixture.echo(chatUri, { type: ActionType.ChatTurnsLoaded, turns: [history[0]!] }, undefined);
    await setImmediate();
    return {};
  });
  const { hub, actions, host, echo } = fixture;
  await watchHistory(fixture, { turns: history.slice(1), turnsNextCursor: 'older-turns' });
  try {
    const editing = hub.call({
      op: 'editMessage', hostId: 'h', sessionUri, chatUri, turnId: 'second', lastTurnId: 'third',
      text: 'Исправлено', replacementId: 'replacement',
    });
    await setImmediate();
    assert.deepEqual(actions[0], { type: ActionType.ChatTruncated, turnId: 'first' });
    echo(chatUri, actions[0]!, { clientId: host.clientId, clientSeq: 1 });
    await setImmediate();
    echo(chatUri, actions[1]!, { clientId: host.clientId, clientSeq: 2 });
    assert.deepEqual(await editing, { status: 'sent' });
  } finally { await hub.stop(); }
});

test('подтверждённая правка доходит до нового хода после закрытия браузера', async () => {
  const fixture = setup();
  const { hub, actions, host, echo } = fixture;
  await watchHistory(fixture);
  try {
    const browser = new AbortController();
    const editing = hub.call({
      op: 'editMessage', hostId: 'h', sessionUri, chatUri, turnId: 'second', lastTurnId: 'third',
      text: 'Исправлено', replacementId: 'replacement',
    }, browser.signal);
    browser.abort();
    hub.unwatch('h', chatUri);
    hub.unwatch('h', sessionUri);
    echo(chatUri, actions[0]!, { clientId: host.clientId, clientSeq: 1 });
    await setImmediate();
    assert.equal(actions[1]?.type, ActionType.ChatTurnStarted);
    echo(chatUri, actions[1]!, { clientId: host.clientId, clientSeq: 2 });
    assert.deepEqual(await editing, { status: 'sent' });
  } finally { await hub.stop(); }
});


const searchSummary = {
  resource: sessionUri, createdAt: startedAt, modifiedAt: startedAt,
  title: 'Тема', status: 1, provider: 'codex', chats: [chatSummary],
};

test('поиск по истории догружает страницы, находит ход и освобождает чат', async () => {
  const fixture = setup([model], async (method, params) => {
    if (method !== 'fetchTurns') return null;
    assert.deepEqual(params, { channel: chatUri, cursor: 'older-turns' });
    fixture.echo(chatUri, { type: ActionType.ChatTurnsLoaded, turns: [history[0]!] }, undefined);
    await setImmediate();
    return {};
  });
  const { hub, requests, sessions, states } = fixture;
  states.set(sessionUri, sessionState);
  states.set(chatUri, { ...chatSummary, turns: history.slice(1), turnsNextCursor: 'older-turns' });
  sessions.push({ hostId: 'h', hostLabel: 'Host', summary: searchSummary });
  await hub.start([]);
  try {
    const first = await hub.call({ op: 'searchHistory', query: 'first' }) as { hits: { turnId: string }[]; scannedTurns: number; issues: unknown[] };
    assert.deepEqual(first.hits.map(hit => hit.turnId), ['first']);
    assert.equal(first.scannedTurns, 3);
    assert.deepEqual(first.issues, []);
    assert.equal(requests.filter(request => request.method === 'fetchTurns').length, 1);
    assert.equal(hub.mirrorChat('h', chatUri), undefined, 'подписка поиска освобождена');

    const second = await hub.call({ op: 'searchHistory', query: 'second' }) as { hits: { turnId: string }[] };
    assert.deepEqual(second.hits.map(hit => hit.turnId), ['second']);
    assert.equal(requests.filter(request => request.method === 'fetchTurns').length, 1, 'повторный поиск берёт корпус из кэша');
  } finally { await hub.stop(); }
});

test('отмена поиска прекращает страницы и освобождает канал', async () => {
  const fixture = setup([model], async (method) => {
    if (method === 'fetchTurns') return new Promise(() => {});
    return null;
  });
  const { hub, requests, sessions, states, unsubscribed } = fixture;
  states.set(sessionUri, sessionState);
  states.set(chatUri, { ...chatSummary, turns: [], turnsNextCursor: 'older-turns' });
  sessions.push({ hostId: 'h', hostLabel: 'Host', summary: searchSummary });
  await hub.start([]);
  try {
    const controller = new AbortController();
    const running = hub.call({ op: 'searchHistory', query: 'deploy' }, controller.signal);
    for (let tick = 0; tick < 20 && !requests.some(request => request.method === 'fetchTurns'); tick += 1) await setImmediate();
    assert.ok(requests.some(request => request.method === 'fetchTurns'));
    controller.abort();
    await assert.rejects(running, /Поиск отменён/);
    assert.ok(unsubscribed.includes(chatUri), 'канал поиска отписан');
  } finally { await hub.stop(); }
});

test('ошибка одного чата попадает в issues, результаты другого остаются', async () => {
  const goodChat = 'ahp-chat:/good';
  const badChat = 'ahp-chat:/bad';
  const fixture = setup([model], async (method, params) => {
    if (method !== 'fetchTurns') return null;
    if ((params as { channel: string }).channel === badChat) throw new Error('host refused');
    fixture.echo(goodChat, { type: ActionType.ChatTurnsLoaded, turns: [] }, undefined);
    return {};
  });
  const { hub, sessions, states } = fixture;
  states.set(sessionUri, { ...sessionState, chats: [
    { ...chatSummary, resource: badChat },
    { ...chatSummary, resource: goodChat },
  ] });
  states.set(badChat, { ...chatSummary, resource: badChat, turns: [], turnsNextCursor: 'bad' });
  states.set(goodChat, { ...chatSummary, resource: goodChat, turns: [{ ...history[0]!, message: { ...history[0]!.message, text: 'deploy good' } }] });
  sessions.push({ hostId: 'h', hostLabel: 'Host', summary: { ...searchSummary, chats: [
    { ...chatSummary, resource: badChat },
    { ...chatSummary, resource: goodChat },
  ] } });
  await hub.start([]);
  try {
    const result = await hub.call({ op: 'searchHistory', query: 'deploy' }) as { hits: unknown[]; issues: { message: string }[] };
    assert.equal(result.hits.length, 1);
    assert.match(result.issues[0]!.message, /host refused/);
  } finally { await hub.stop(); }
});

test('одновременные запросы одной страницы не дублируются', async () => {
  const fixture = setup([model], async (method) => {
    if (method !== 'fetchTurns') return null;
    fixture.echo(chatUri, { type: ActionType.ChatTurnsLoaded, turns: [history[0]!] }, undefined);
    await setImmediate();
    return {};
  });
  await watchHistory(fixture, { turns: history.slice(1), turnsNextCursor: 'older-turns' });
  try {
    const call = { op: 'fetchTurns', hostId: 'h', chatUri, cursor: 'older-turns' } as const;
    await Promise.all([fixture.hub.call(call), fixture.hub.call(call)]);
    assert.equal(fixture.requests.filter(request => request.method === 'fetchTurns').length, 1);
  } finally { await fixture.hub.stop(); }
});
