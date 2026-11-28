/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ActionType, TerminalClaimKind, TerminalLifecycleStatus, type SessionSummary, type TerminalState } from '@microsoft/agent-host-protocol';
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
  assert.equal(previous.overviewLoaded, false, 'до первой сводки страница не знает набор терминалов');
  for (const data of ['{', 'null', '{"t":"overview"}']) socket.onmessage!({ data });
  assert.equal(store.getState(), previous);

  const overview = { hosts: [], sessions: [] };
  receive({ t: 'overview', overview });
  assert.notEqual(store.getState(), previous);
  assert.deepEqual(store.getState().overview, overview);
  assert.equal(store.getState().overviewLoaded, true);
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

test('поток терминала идёт мимо состояния React и переживает timing подписки', () => {
  const terminal = 'ahp-terminal:/one';
  const release = store.watch('one', terminal);
  snapshot('one', terminal);
  const before = store.getState();
  // До подписки эмулятора кадр не создаёт новое состояние: React не перерисовывается.
  receive({ t: 'terminalData', hostId: 'one', uri: terminal, data: 'early' });
  assert.equal(store.getState(), before);

  const seen: string[] = [];
  const unsubscribe = store.subscribeChannelData('one', terminal, data => seen.push(data));
  assert.deepEqual(seen, ['early'], 'кадр, пришедший до подписки, не теряется');
  receive({ t: 'terminalData', hostId: 'one', uri: terminal, data: 'late' });
  assert.deepEqual(seen.at(-1), 'late');
  assert.equal(store.getState(), before, 'кадры не меняют channels');

  // Кадр чужого канала не должен попасть в этот эмулятор.
  store.forgetChannelData('one', terminal);
  unsubscribe();
  release();
});

test('поток адресный: подписка на один терминал не съедает буфер другого', () => {
  const first = 'ahp-terminal:/first';
  const second = 'ahp-terminal:/second';
  const releaseFirst = store.watch('one', first);
  const releaseSecond = store.watch('one', second);
  snapshot('one', first);
  snapshot('one', second);
  receive({ t: 'terminalData', hostId: 'one', uri: first, data: 'first-early' });
  receive({ t: 'terminalData', hostId: 'one', uri: second, data: 'second-early' });

  const seenFirst: string[] = [];
  const offFirst = store.subscribeChannelData('one', first, data => seenFirst.push(data));
  assert.deepEqual(seenFirst, ['first-early'], 'подписка получает только свой буфер');

  receive({ t: 'terminalData', hostId: 'one', uri: first, data: '-late' });
  assert.deepEqual(seenFirst, ['first-early', '-late']);

  const seenSecond: string[] = [];
  const offSecond = store.subscribeChannelData('one', second, data => seenSecond.push(data));
  assert.deepEqual(seenSecond, ['second-early'], 'буфер второго канала пережил подписку на первый');

  // Кадр канала без слушателя буферизуется, даже когда слушатель есть у соседнего.
  offFirst();
  receive({ t: 'terminalData', hostId: 'one', uri: first, data: 'first-buffered' });
  assert.deepEqual(seenFirst, ['first-early', '-late']);
  const seenAgain: string[] = [];
  const offAgain = store.subscribeChannelData('one', first, data => seenAgain.push(data));
  assert.deepEqual(seenAgain, ['first-buffered']);

  offAgain();
  offSecond();
  releaseFirst();
  releaseSecond();
});

test('буфер вывода до подписки не рвёт суррогатную пару', () => {
  const terminal = 'ahp-terminal:/buffer';
  const release = store.watch('one', terminal);
  snapshot('one', terminal);
  receive({ t: 'terminalData', hostId: 'one', uri: terminal, data: 'b'.repeat(10) });
  // Обрезка до 256 КиБ попадает ровно между половинами эмодзи: префикс + эмодзи + хвост.
  receive({ t: 'terminalData', hostId: 'one', uri: terminal, data: `😀${'c'.repeat(262_143)}` });
  const seen: string[] = [];
  const unsubscribe = store.subscribeChannelData('one', terminal, data => seen.push(data));
  const buffered = seen[0] ?? '';
  assert.ok(buffered.length <= 256 * 1024 + 1, 'буфер остаётся ограниченным');
  assert.equal(buffered.charCodeAt(0), 0xd83d, 'старшая половина эмодзи на месте');
  assert.equal(buffered.charCodeAt(1), 0xde00, 'младшая половина эмодзи на месте');
  unsubscribe();
  store.forgetChannelData('one', terminal);
  release();
});

test('снимок терминала начинает новую точку отсчёта, а action её не сдвигает', () => {
  const terminal = 'ahp-terminal:/epoch';
  const release = store.watch('one', terminal);
  const base: TerminalState = {
    title: 'Терминал',
    content: [{ type: 'unclassified', value: '$ ' }],
    lifecycle: { status: TerminalLifecycleStatus.Running },
    claim: { kind: TerminalClaimKind.Client, clientId: 'backend' },
  };
  receive({ t: 'snapshot', hostId: 'one', uri: terminal, state: base });
  const first = store.getState().channels.get(channelKey('one', terminal))!;
  assert.equal(typeof first.epoch, 'number');

  // `resized` и `exited` меняют состояние, но экран перерисовывать не нужно.
  receive({ t: 'action', hostId: 'one', uri: terminal, action: { type: ActionType.TerminalResized, cols: 100, rows: 30 } });
  const resized = store.getState().channels.get(channelKey('one', terminal))!;
  assert.equal(resized.epoch, first.epoch, 'action не сдвигает точку отсчёта');
  assert.equal((resized.state as { cols?: number }).cols, 100);

  // Повторный снимок (F5, reconnect) — новая точка отсчёта.
  receive({ t: 'snapshot', hostId: 'one', uri: terminal, state: base });
  assert.notEqual(store.getState().channels.get(channelKey('one', terminal))!.epoch, first.epoch);

  // Кадр, пришедший до снимка, уже есть в его содержимом: иначе вывод задвоился бы.
  receive({ t: 'terminalData', hostId: 'one', uri: terminal, data: 'stale' });
  receive({ t: 'snapshot', hostId: 'one', uri: terminal, state: base });
  const seen: string[] = [];
  const unsubscribe = store.subscribeChannelData('one', terminal, data => seen.push(data));
  assert.deepEqual(seen, [], 'кадры до снимка не доигрываются поверх него');
  unsubscribe();
  release();
});

test('подписка на первую команду видит только живое принятое действие PTY', () => {
  const terminal = 'ahp-terminal:/command';
  const neighbour = 'ahp-terminal:/command-neighbour';
  const base: TerminalState = {
    title: 'Терминал',
    content: [],
    lifecycle: { status: TerminalLifecycleStatus.Running },
    claim: { kind: TerminalClaimKind.Client, clientId: 'backend' },
    supportsCommandDetection: true,
  };
  const release = store.watch('one', terminal);
  const releaseNeighbour = store.watch('one', neighbour);
  receive({ t: 'snapshot', hostId: 'one', uri: terminal, state: base });
  receive({ t: 'snapshot', hostId: 'one', uri: neighbour, state: base });

  const seen: string[] = [];
  const unsubscribe = store.subscribeTerminalCommands('one', terminal, commandLine => seen.push(commandLine));
  // Снимок уже с командой не уведомляет: история не доказывает, что команда первая.
  receive({
    t: 'snapshot',
    hostId: 'one',
    uri: terminal,
    state: { ...base, content: [{ type: 'command', commandId: 'old', commandLine: 'echo from-history', output: '', timestamp: 1, isComplete: true }] },
  });
  assert.deepEqual(seen, []);

  receive({ t: 'action', hostId: 'one', uri: terminal, action: { type: ActionType.TerminalCommandExecuted, commandId: 'c1', commandLine: 'echo first', timestamp: 2 } });
  assert.deepEqual(seen, ['echo first']);
  const applied = store.getState().channels.get(channelKey('one', terminal))?.state as TerminalState;
  assert.deepEqual(applied.content.at(-1), {
    type: 'command', commandId: 'c1', commandLine: 'echo first', output: '', timestamp: 2, isComplete: false,
  }, 'уведомление идёт после reducer');

  // Соседний PTY и ненаблюдаемый канал не уведомляют эту подписку.
  receive({ t: 'action', hostId: 'one', uri: neighbour, action: { type: ActionType.TerminalCommandExecuted, commandId: 'n1', commandLine: 'echo neighbour', timestamp: 3 } });
  receive({ t: 'action', hostId: 'two', uri: terminal, action: { type: ActionType.TerminalCommandExecuted, commandId: 'x1', commandLine: 'echo other-host', timestamp: 4 } });
  assert.deepEqual(seen, ['echo first']);

  unsubscribe();
  receive({ t: 'action', hostId: 'one', uri: terminal, action: { type: ActionType.TerminalCommandExecuted, commandId: 'c2', commandLine: 'echo second', timestamp: 5 } });
  assert.deepEqual(seen, ['echo first'], 'после отписки слушатель не получает команд');

  release();
  releaseNeighbour();
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
