/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { SessionSummary } from '@microsoft/agent-host-protocol';
import type { ChannelState, ServerMessage } from '../shared/protocol.js';
import { channelKey } from '../shared/reduce.js';

let socket: FakeSocket;
class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  constructor(_url: string) { socket = this; }
  send(_message: string) {}
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
