import assert from 'node:assert/strict';
import { EventEmitter, on } from 'node:events';
import { test } from 'node:test';
import { ActionType, type StateAction } from '@microsoft/agent-host-protocol';
import type { HostConfig, HostEvent, HostSubscriptionEvent, MultiHostClient } from '@microsoft/agent-host-protocol/hosts';
import { RpcError } from '@microsoft/agent-host-protocol/client';
import type { ServerMessage } from '../shared/protocol.js';
import { Hub } from './hub.js';

const SESSION = 'ahp-session:/test', CHAT = 'ahp-chat:/test';

function setup(subscribe: (_host: string, uri: string) => Promise<unknown>) {
  const messages: ServerMessage[] = [];
  const unsubscribed: string[] = [];
  const dispatched: StateAction[] = [];
  const events = new EventEmitter();
  const emit = (event: HostSubscriptionEvent) => events.emit('event', event);
  const multi = {
    async *hostEvents() { for await (const [event] of on(events, 'host', { close: ['stop'] })) yield event; },
    async *events() { for await (const [event] of on(events, 'event', { close: ['stop'] })) yield event; },
    addHost: async () => {},
    host: () => ({}),
    client: () => ({ dispatch: (_uri: string, action: StateAction) => { dispatched.push(action); } }),
    subscribe,
    unsubscribe: async (_host: string, uri: string) => { unsubscribed.push(uri); },
    shutdown: async () => { events.emit('stop'); },
    hostsSnapshot: () => [],
    aggregatedSessions: () => [],
  } as unknown as MultiHostClient;
  const hub = new Hub(multi, { broadcast: message => messages.push(message), toWatchers: (_host, _uri, message) => messages.push(message) });
  return {
    hub, messages, unsubscribed, dispatched,
    hostEvent: (event: HostEvent) => events.emit('host', event),
    action: (action: StateAction, serverSeq: number, options: { hostId?: string; rejectionReason?: string } = {}) => emit({
      hostId: options.hostId ?? 'one', channel: CHAT,
      event: { type: 'action', params: { channel: CHAT, origin: undefined, action, serverSeq, rejectionReason: options.rejectionReason } },
    }),
    remove: () => emit({ hostId: 'one', channel: 'ahp-root://', event: { type: 'sessionRemoved', params: { channel: 'ahp-root://', session: SESSION } } }),
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('удаление из другого клиента инвалидирует зеркало и отписывает чаты сессии', async () => {
  const { hub, messages, unsubscribed, remove } = setup(async (_host, uri) => ({ snapshot: { resource: uri, fromSeq: 1, state: uri === SESSION ? { chats: [{ resource: CHAT }] } : { turns: [] } } }));
  await hub.start([] as HostConfig[]);
  hub.watch('one', SESSION);
  hub.watch('one', CHAT);
  await tick();
  remove();
  await tick();
  assert.deepEqual(messages.find(message => message.t === 'sessionRemoved'), { t: 'sessionRemoved', hostId: 'one', sessionUri: SESSION, chatUris: [CHAT] });
  assert.deepEqual(unsubscribed, [SESSION, CHAT]);
  assert.throws(() => hub.watch('one', SESSION), error => error instanceof Error && 'code' in error && error.code === -32001);
  await hub.stop();
});

test('снимок из запроса до удаления не возвращает сессию в UI', async () => {
  let resolveSnapshot!: (value: unknown) => void;
  const { hub, messages, remove } = setup(() => new Promise(resolve => { resolveSnapshot = resolve; }));
  await hub.start([]);
  hub.watch('one', SESSION);
  remove();
  await tick();
  resolveSnapshot({ snapshot: { resource: SESSION, fromSeq: 1, state: { chats: [] } } });
  await tick();
  assert.equal(messages.some(message => message.t === 'snapshot'), false);
  await hub.stop();
});

test('ошибка NotFound сохраняет код, пустой снимок становится ошибкой вместо вечной загрузки', async () => {
  const { hub, messages } = setup(async (_host, uri) => {
    if (uri === SESSION) throw new RpcError(-32001, 'Session missing');
    return { snapshot: { resource: uri, state: undefined, fromSeq: 0 } };
  });
  hub.watch('one', SESSION);
  hub.watch('one', CHAT);
  await tick();
  assert.ok(messages.some(message => message.t === 'channelError' && message.uri === SESSION && message.code === -32001));
  assert.ok(messages.some(message => message.t === 'channelError' && message.uri === CHAT && message.error.includes('не вернул состояние')));
  assert.throws(() => hub.watch('one', SESSION), error => error instanceof Error && 'code' in error && error.code === -32001, 'новый клиент получает уже известную ошибку, а не ждёт несуществующий снимок');
  await hub.stop();
});

test('перепроверка выявляет удаление, даже если хост не прислал sessionRemoved', async () => {
  let removed = false;
  const { hub, messages } = setup(async (_host, uri) => {
    if (removed) throw new RpcError(-32001, 'Deleted draft');
    return { snapshot: { resource: uri, state: { chats: [] }, fromSeq: 1 } };
  });
  hub.watch('one', SESSION);
  await tick();
  assert.equal(messages.some(message => message.t === 'snapshot'), true);
  removed = true;
  await hub.call({ op: 'refreshSession', hostId: 'one', sessionUri: SESSION });
  assert.ok(messages.some(message => message.t === 'channelError' && message.code === -32001));
  assert.throws(() => hub.watch('one', SESSION));
  await hub.stop();
});

test('ошибка редьюсера при первом снимке и в живом потоке затрагивает только канал', async t => {
  let load!: (result: unknown) => void;
  const { hub, messages, action } = setup(() => new Promise(resolve => { load = resolve; }));
  await hub.start([]);
  t.after(() => hub.stop());
  hub.watch('one', CHAT);
  const invalid: StateAction = {
    type: ActionType.ChatTurnsLoaded,
    get turns(): never { throw new TypeError('Не удалось прочитать историю'); },
  };
  action(invalid, 2);
  await tick();
  load({ snapshot: { resource: CHAT, fromSeq: 1, state: { turns: [] } } });
  await tick();
  action(invalid, 3);
  const updated = { type: ActionType.ChatActivityChanged, activity: 'Следующее действие' } as const;
  action(updated, 4);
  await tick();
  assert.deepEqual(messages.filter(message => message.t !== 'overview').map(message => message.t), ['snapshot', 'channelError', 'channelError', 'action']);
  assert.ok(messages.some(message => message.t === 'action' && message.action === updated));
  assert.deepEqual(hub.watch('one', CHAT), { turns: [], activity: 'Следующее действие' });
});

test('после нового подключения низкий serverSeq допустим, ответ старой подписки игнорируется', async t => {
  let completeOldLoad: ((result: unknown) => void) | undefined;
  let generation = 1;
  const { hub, messages, hostEvent } = setup(async (_host, uri) => {
    if (uri !== SESSION) return { snapshot: { resource: uri, fromSeq: 1, state: { agents: [] } } };
    if (generation === 1 && messages.some(message => message.t === 'snapshot' && message.uri === SESSION)) {
      return new Promise(resolve => { completeOldLoad = resolve; });
    }
    return { snapshot: { resource: SESSION, fromSeq: generation === 1 ? 9 : 1, state: { title: `Поколение ${generation}`, chats: [] } } };
  });
  await hub.start([]);
  t.after(() => hub.stop());
  hostEvent({ type: 'connected', hostId: 'one', generation: 1 });
  hub.watch('one', SESSION);
  await tick();
  const refresh = hub.call({ op: 'refreshSession', hostId: 'one', sessionUri: SESSION });
  assert.ok(completeOldLoad);
  generation = 2;
  hostEvent({ type: 'connected', hostId: 'one', generation });
  await tick();
  completeOldLoad({ snapshot: { resource: SESSION, fromSeq: 10, state: { title: 'Устарело' } } });
  await refresh;
  const states = messages.flatMap(message => message.t === 'snapshot' && message.uri === SESSION ? [message.state] : []);
  assert.deepEqual(states, [{ title: 'Поколение 1', chats: [] }, { title: 'Поколение 2', chats: [] }]);
});

test('отправка ждёт подтверждения своего хода и возвращает поздний отказ', async t => {
  const { hub, messages, dispatched, action } = setup(async () => ({ snapshot: { resource: CHAT, fromSeq: 1, state: { turns: [] } } }));
  await hub.start([]);
  t.after(() => hub.stop());
  hub.watch('one', CHAT);
  await tick();
  const call = { op: 'sendMessage', hostId: 'one', chatUri: CHAT, text: 'Сообщение', waitForHost: true } as const;
  let finished = false;
  const accepted = hub.call(call).then(() => { finished = true; });
  action(dispatched[0]!, 2, { hostId: 'other', rejectionReason: 'Чужой хост' });
  await tick();
  assert.equal(finished, false);
  action(dispatched[0]!, 2);
  await accepted;
  assert.ok(messages.some(message => message.t === 'action' && message.action === dispatched[0]));

  const rejected = assert.rejects(hub.call(call), /Хост отклонил сообщение: Ход ещё идёт/);
  action(dispatched[1]!, 3, { rejectionReason: 'Ход ещё идёт' });
  await rejected;
  assert.equal(messages.some(message => message.t === 'rejected' && message.hostId === 'one'), false);
});

test('разрыв связи прерывает ожидание отправки с исходной причиной', async t => {
  const { hub, dispatched } = setup(async () => ({}));
  await hub.start([]);
  t.after(() => hub.stop());
  const abort = new AbortController();
  const reason = new Error('Браузер отключился');
  const send = hub.call({ op: 'sendMessage', hostId: 'one', chatUri: CHAT, text: 'Сообщение', waitForHost: true }, abort.signal);
  assert.equal(dispatched.length, 1);
  abort.abort(reason);
  await assert.rejects(send, error => error === reason);
});
