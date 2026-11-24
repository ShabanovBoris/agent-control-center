/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { SessionSummary } from '@microsoft/agent-host-protocol';
import type { ChannelState, ServerMessage } from '../shared/protocol.js';
import { channelKey } from '../shared/reduce.js';

let socket: FakeSocket;
class FakeSocket {
  static OPEN = 1;
  static sent: string[] = [];
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  readonly sent: string[] = [];
  constructor(_url: string) { socket = this; }
  send(message: string) { this.sent.push(message); FakeSocket.sent.push(message); }
}
const runtime = globalThis as unknown as { WebSocket: unknown; location: unknown };
const original = { WebSocket: runtime.WebSocket, location: runtime.location };
runtime.WebSocket = FakeSocket;
runtime.location = { protocol: 'http:', host: 'localhost:5173' };
after(() => { runtime.WebSocket = original.WebSocket; runtime.location = original.location; });
const { store } = await import('./store.js');
socket!.onopen?.();
const receive = (message: ServerMessage) => socket.onmessage?.({ data: JSON.stringify(message) });
const snapshot = (hostId: string, uri: string) => receive({ t: 'snapshot', hostId, uri, state: { title: 'Old state' } as ChannelState });

test('после повреждённых сообщений браузер принимает следующую сводку', () => {
  const previous = store.getState();
  for (const data of ['{', 'null', '{"t":"overview"}']) socket.onmessage!({ data });
  assert.equal(store.getState(), previous);

  const overview = { hosts: [], sessions: [] };
  receive({ t: 'overview', overview });
  assert.notEqual(store.getState(), previous);
  assert.deepEqual(store.getState().overview, overview);
  assert.equal(store.getState().connection, 'open');
});

test('удаление сессии из другого клиента сбрасывает её каналы и список, но не чужой хост', () => {
  const session = 'ahp-session:/same', chat = 'ahp-chat:/same';
  const releases = [store.watch('one', session), store.watch('one', chat), store.watch('two', session)];
  receive({ t: 'overview', overview: { hosts: [], sessions: ['one', 'two'].map(hostId => ({ hostId, hostLabel: hostId, summary: { resource: session } as SessionSummary })) } });
  for (const [host, uri] of [['one', session], ['one', chat], ['two', session]]) snapshot(host!, uri!);
  receive({ t: 'sessionRemoved', hostId: 'one', sessionUri: session, chatUris: [chat] });
  assert.deepEqual(store.getState().channels.get(channelKey('one', session)), { missing: true });
  assert.equal(store.getState().channels.has(channelKey('one', chat)), false);
  assert.equal(store.getState().channels.get(channelKey('two', session))?.state !== undefined, true);
  assert.deepEqual(store.getState().overview.sessions.map(session => session.hostId), ['two']);
  snapshot('one', session);
  assert.deepEqual(store.getState().channels.get(channelKey('one', session)), { missing: true }, 'поздний снимок не оживляет удалённую сессию');
  releases.forEach(release => release());
});

test('отсутствующая при открытии сессия отличается от ошибки соединения или авторизации', () => {
  const uri = 'ahp-session:/missing';
  const release = store.watch('one', uri);
  receive({ t: 'channelError', hostId: 'one', uri, error: 'Not found', code: -32001 });
  assert.equal(store.getState().channels.get(channelKey('one', uri))?.missing, true);
  release();
  const releaseAgain = store.watch('one', uri);
  receive({ t: 'channelError', hostId: 'one', uri, error: 'Authentication required', code: -32007 });
  assert.equal(store.getState().channels.get(channelKey('one', uri))?.missing, undefined);
  assert.equal(store.getState().channels.get(channelKey('one', uri))?.error, 'Authentication required');
  releaseAgain();
});


test('поиск уходит отдельным вызовом и возвращает результат', async () => {
  const running = store.search('deploy', new AbortController().signal);
  const call = JSON.parse(socket.sent.at(-1)!) as { id: number; call: { op: string; query: string } };
  assert.equal(call.call.op, 'searchHistory');
  assert.equal(call.call.query, 'deploy');
  const result = { hits: [], candidateChats: 0, scannedChats: 0, scannedTurns: 0, reasons: [], issues: [] };
  receive({ t: 'result', id: call.id, ok: true, data: result });
  assert.deepEqual(await running, result);
});

test('отмена поиска шлёт cancelSearch и режет ожидание, поздний результат игнорируется', async () => {
  const controller = new AbortController();
  const running = store.search('deploy', controller.signal);
  const call = JSON.parse(socket.sent.at(-1)!) as { id: number };
  controller.abort();
  await assert.rejects(running, (error: Error) => error.name === 'CallCancelled');
  assert.deepEqual(JSON.parse(socket.sent.at(-1)!), { t: 'cancelSearch', id: call.id });
  // Поздний ответ не должен воскресить отменённый pending или сломать следующий поиск.
  receive({ t: 'result', id: call.id, ok: true, data: { hits: [] } });
  const next = store.search('redis', new AbortController().signal);
  const nextCall = JSON.parse(socket.sent.at(-1)!) as { id: number };
  assert.notEqual(nextCall.id, call.id);
  receive({ t: 'result', id: nextCall.id, ok: true, data: { hits: ['ok'] } });
  assert.deepEqual(await next, { hits: ['ok'] });
});

test('ошибка поиска приходит как CallRejected с кодом хоста', async () => {
  const { CallRejected } = await import('./store.js');
  const running = store.search('deploy', new AbortController().signal);
  const call = JSON.parse(socket.sent.at(-1)!) as { id: number };
  receive({ t: 'result', id: call.id, ok: false, error: { message: 'Нужна авторизация', code: -32007 } });
  await assert.rejects(running, (error: unknown) => error instanceof CallRejected && error.detail.code === -32007);
});

test('presence сообщает открытую сессию и видимость, переживая переподключение', () => {
  FakeSocket.sent.length = 0;
  const sent = () => FakeSocket.sent.map(raw => JSON.parse(raw) as unknown);
  store.setPresence({ hostId: 'one', sessionUri: 'ahp-session:/visible' });
  assert.deepEqual(sent(), [{ t: 'presence', visible: false, selection: { hostId: 'one', sessionUri: 'ahp-session:/visible' } }]);

  store.setPresenceVisible(true);
  assert.deepEqual(sent().at(-1), { t: 'presence', visible: true, selection: { hostId: 'one', sessionUri: 'ahp-session:/visible' } });

  store.setPresenceVisible(true);
  assert.equal(FakeSocket.sent.length, 2, 'одинаковая видимость не отправляется повторно');

  FakeSocket.sent.length = 0;
  socket.onopen?.();
  assert.deepEqual(sent().at(-1), {
    t: 'presence', visible: true, selection: { hostId: 'one', sessionUri: 'ahp-session:/visible' },
  }, 'после reconnect presence отправляется заново');

  store.setPresence(null);
  assert.deepEqual(sent().at(-1), { t: 'presence', visible: true });
});

test('отчёт по расходу уходит отдельным вызовом с часовым поясом', async () => {
  const running = store.usageReport('Europe/Moscow', new AbortController().signal);
  const call = JSON.parse(socket.sent.at(-1)!) as { id: number; call: { op: string; timeZone: string } };
  assert.equal(call.call.op, 'usageReport');
  assert.equal(call.call.timeZone, 'Europe/Moscow');
  const report = { total: 110, timeZone: 'Europe/Moscow', sessions: [], reasons: [], issues: [] };
  receive({ t: 'result', id: call.id, ok: true, data: report });
  assert.deepEqual(await running, report);
});

test('отмена отчёта шлёт cancelUsage и не рвёт поиск', async () => {
  const controller = new AbortController();
  const running = store.usageReport('UTC', controller.signal);
  const call = JSON.parse(socket.sent.at(-1)!) as { id: number };
  controller.abort();
  await assert.rejects(running, (error: Error) => error.name === 'CallCancelled');
  assert.deepEqual(JSON.parse(socket.sent.at(-1)!), { t: 'cancelUsage', id: call.id });
  receive({ t: 'result', id: call.id, ok: true, data: { total: 999 } });

  const search = store.search('deploy', new AbortController().signal);
  const searchCall = JSON.parse(socket.sent.at(-1)!) as { id: number; call: { op: string } };
  assert.equal(searchCall.call.op, 'searchHistory');
  assert.notEqual(searchCall.id, call.id);
  receive({ t: 'result', id: searchCall.id, ok: true, data: { hits: [] } });
  assert.deepEqual(await search, { hits: [] });
});

test('состояние закреплений и непрочитанных приходит отдельным сообщением', () => {
  assert.deepEqual(store.getState().sessionUserState, { pinned: [], unread: [] });
  const state = {
    pinned: [{ hostId: 'one', sessionUri: 'ahp-session:/pinned' }],
    unread: [{ hostId: 'one', sessionUri: 'ahp-session:/unread', count: 2 }],
  };
  receive({ t: 'sessionUserState', state });
  assert.deepEqual(store.getState().sessionUserState, state);

  const beforeBroken = store.getState();
  for (const data of [
    '{"t":"sessionUserState","state":{"pinned":[],"unread":[{"hostId":"one","sessionUri":"ahp-session:/x","count":0}]}}',
    '{"t":"sessionUserState","state":{"pinned":"x","unread":[]}}',
    '{"t":"sessionUserState"}',
  ]) socket.onmessage!({ data });
  assert.equal(store.getState(), beforeBroken, 'битое состояние не должно менять pin и счётчики');
});

test('удаление сессии вычищает её закрепление и badge до ответа backend', () => {
  const removed = 'ahp-session:/removed', kept = 'ahp-session:/kept';
  receive({
    t: 'sessionUserState',
    state: {
      pinned: [{ hostId: 'one', sessionUri: removed }, { hostId: 'one', sessionUri: kept }],
      unread: [
        { hostId: 'one', sessionUri: removed, count: 1 },
        { hostId: 'two', sessionUri: removed, count: 3 },
        { hostId: 'one', sessionUri: kept, count: 1 },
      ],
    },
  });
  receive({ t: 'sessionRemoved', hostId: 'one', sessionUri: removed, chatUris: [] });
  assert.deepEqual(store.getState().sessionUserState, {
    pinned: [{ hostId: 'one', sessionUri: kept }],
    unread: [
      { hostId: 'two', sessionUri: removed, count: 3 },
      { hostId: 'one', sessionUri: kept, count: 1 },
    ],
  });
});
