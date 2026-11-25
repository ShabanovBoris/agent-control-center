import assert from 'node:assert/strict';
import { EventEmitter, on } from 'node:events';
import { setTimeout as delay, setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import {
  ActionType, AhpErrorCodes, JsonRpcErrorCodes, TerminalClaimKind, TerminalLifecycleStatus,
  type ActionEnvelope, type StateAction, type TerminalInfo, type TerminalState,
} from '@microsoft/agent-host-protocol';
import { RpcError } from '@microsoft/agent-host-protocol/client';
import type { MultiHostClient } from '@microsoft/agent-host-protocol/hosts';
import type { ServerMessage } from '../shared/protocol.js';
import { CallFailure } from './errors.js';
import { Hub, MAX_CLIENT_TERMINALS } from './hub.js';

const ROOT = 'ahp-root://';

function terminalState(overrides: Partial<TerminalState> = {}): TerminalState {
  return {
    title: 'Терминал',
    cwd: 'file:///work',
    cols: 80,
    rows: 24,
    content: [{ type: 'unclassified', value: '$ ' }],
    lifecycle: { status: TerminalLifecycleStatus.Running },
    claim: { kind: TerminalClaimKind.Client, clientId: 'browser-backend' },
    ...overrides,
  };
}

function setup(options: { request?: (method: string, params: unknown) => unknown; terminals?: TerminalInfo[] } = {}) {
  const events = new EventEmitter();
  const hostEvents = new EventEmitter();
  const states = new Map<string, unknown>();
  const requests: { method: string; params: unknown }[] = [];
  const dispatched: { channel: string; action: StateAction }[] = [];
  const messages: { uri: string; message: ServerMessage }[] = [];
  let serverSeq = 0;
  const host = {
    id: 'h', clientId: 'browser-backend', label: 'Host', generation: 1,
    completionTriggerCharacters: [],
    state: { status: 'connected' },
    agents: [],
    terminals: options.terminals ?? [],
  };
  const multi = {
    host: (id: string) => (id === 'h' ? host : undefined),
    client: () => ({
      dispatch: (channel: string, action: StateAction) => {
        dispatched.push({ channel, action });
        return { clientSeq: dispatched.length };
      },
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        return options.request?.(method, params) ?? null;
      },
    }),
    subscribe: async (_hostId: string, uri: string) => ({ snapshot: { resource: uri, state: states.get(uri), fromSeq: serverSeq } }),
    async unsubscribe() {},
    hostsSnapshot: () => [host],
    aggregatedSessions: () => [],
    async *hostEvents() { for await (const [event] of on(hostEvents, 'hostEvent', { close: ['shutdown'] })) yield event; },
    async *events() { for await (const [event] of on(events, 'action', { close: ['shutdown'] })) yield event; },
    async shutdown() { hostEvents.emit('shutdown'); events.emit('shutdown'); },
  } as unknown as MultiHostClient;
  const hub = new Hub(multi, {
    broadcast() {},
    toWatchers: (hostId, uri, message) => messages.push({ uri, message }),
  });
  const echo = (channel: string, action: StateAction, origin: ActionEnvelope['origin'] = undefined) => {
    events.emit('action', { hostId: 'h', channel, event: { type: 'action', params: { channel, action, origin, serverSeq: ++serverSeq } } });
  };
  const streaming = (uri: string) => messages.filter(item => item.uri === uri && item.message.t === 'terminalData')
    .map(item => (item.message as { data: string }).data).join('');
  return { hub, host, states, requests, dispatched, messages, echo, streaming, events };
}

const terminalUri = 'ahp-terminal:/one';

test('createTerminal проверяет папку, передаёт claim client и file: cwd', async () => {
  const fixture = setup();
  const result = await fixture.hub.call({ op: 'createTerminal', hostId: 'h', directory: '/work/src', title: 'Проект' }) as { terminalUri: string };
  assert.match(result.terminalUri, /^ahp-terminal:\//);
  assert.deepEqual(fixture.requests[0], { method: 'resourceList', params: { channel: ROOT, uri: 'file:///work/src' } });
  const created = fixture.requests[1];
  assert.equal(created?.method, 'createTerminal');
  assert.deepEqual(created?.params, {
    channel: (result as { terminalUri: string }).terminalUri,
    claim: { kind: TerminalClaimKind.Client, clientId: 'browser-backend' },
    name: 'Проект',
    cwd: 'file:///work/src',
  });
});

test('createTerminal: отсутствующая папка и относительный путь не создают PTY', async () => {
  const fixture = setup({ request: () => { throw new RpcError(AhpErrorCodes.NotFound, 'No such directory'); } });
  await assert.rejects(fixture.hub.call({ op: 'createTerminal', hostId: 'h', directory: '/nope' }), (error: unknown) => {
    assert.ok(error instanceof CallFailure);
    assert.match(error.message, /Папка не найдена/);
    return true;
  });
  assert.deepEqual(fixture.requests.map(item => item.method), ['resourceList']);
  await assert.rejects(fixture.hub.call({ op: 'createTerminal', hostId: 'h', directory: 'relative' }), /абсолютный путь/);
});

test('createTerminal: хост без resourceList всё равно открывает терминал', async () => {
  const fixture = setup({
    request: method => {
      if (method === 'resourceList') throw new RpcError(JsonRpcErrorCodes.MethodNotFound, 'Method not found');
      return null;
    },
  });
  const { terminalUri: uri } = await fixture.hub.call({ op: 'createTerminal', hostId: 'h', directory: '/work' }) as { terminalUri: string };
  assert.match(uri, /^ahp-terminal:\//);
  assert.deepEqual(fixture.requests.map(item => item.method), ['resourceList', 'createTerminal']);
});

test('лимит своих терминалов вытесняет старейший без наблюдателей, а занятые — отказ', async () => {
  const terminals = (count: number, claim = TerminalClaimKind.Client): TerminalInfo[] => Array.from({ length: count }, (_, index) => ({
    resource: `ahp-terminal:/busy-${index}`,
    title: `T${index}`,
    claim: claim === TerminalClaimKind.Client ? { kind: claim, clientId: 'browser-backend' } : { kind: claim, session: 'ahp-session:/s', chat: 'ahp-chat:/c' },
    lifecycle: { status: TerminalLifecycleStatus.Running },
  }));
  const free = setup({ terminals: terminals(8) });
  await free.hub.call({ op: 'createTerminal', hostId: 'h', directory: '/work' });
  assert.ok(free.requests.some(item => item.method === 'disposeTerminal'), 'старейший вытесняется');

  const busy = setup({ terminals: terminals(8) });
  for (const terminal of busy.host.terminals) busy.hub.watch('h', terminal.resource);
  await setImmediate();
  await assert.rejects(busy.hub.call({ op: 'createTerminal', hostId: 'h', directory: '/work' }), /Закройте один из них/);

  const agentTerminals = setup({ terminals: terminals(8, TerminalClaimKind.Session) });
  await agentTerminals.hub.call({ op: 'createTerminal', hostId: 'h', directory: '/work' });
  assert.equal(agentTerminals.requests.filter(item => item.method === 'disposeTerminal').length, 0, 'терминалы агентов не вытесняются');
  await free.hub.stop();
  await busy.hub.stop();
  await agentTerminals.hub.stop();
});

function ownTerminals(count: number): TerminalInfo[] {
  return Array.from({ length: count }, (_, index) => ({
    resource: `ahp-terminal:/own-${index}`,
    title: `T${index}`,
    claim: { kind: TerminalClaimKind.Client, clientId: 'browser-backend' },
    lifecycle: { status: TerminalLifecycleStatus.Running },
  }));
}

test('createTerminal вытесняет старейший PTY до запроса создания', async () => {
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const disposeStarted = new Promise<void>(resolve => { started = resolve; });
  const fixture = setup({
    terminals: ownTerminals(MAX_CLIENT_TERMINALS),
    request: method => {
      if (method !== 'disposeTerminal') return null;
      started?.();
      return new Promise<void>(resolve => { release = resolve; });
    },
  });
  const created = fixture.hub.call({ op: 'createTerminal', hostId: 'h', directory: '/work' });
  await disposeStarted;
  assert.deepEqual(fixture.requests.map(item => item.method), ['resourceList', 'disposeTerminal'], 'create ждёт завершения dispose');
  release?.();
  await created;
  assert.deepEqual(fixture.requests.map(item => item.method), ['resourceList', 'disposeTerminal', 'createTerminal']);
  await fixture.hub.stop();
});

test('два одновременных createTerminal не превышают лимит и не вытесняют один URI дважды', async () => {
  const terminals = ownTerminals(MAX_CLIENT_TERMINALS);
  const alive = new Set(terminals.map(terminal => terminal.resource));
  const disposed: string[] = [];
  const fixture = setup({
    terminals,
    request: async (method, params) => {
      if (method === 'disposeTerminal') {
        const channel = (params as { channel: string }).channel;
        await delay(20);
        assert.ok(alive.delete(channel), `${channel} уже закрыт`);
        disposed.push(channel);
        return null;
      }
      if (method === 'createTerminal') {
        alive.add((params as { channel: string }).channel);
        assert.ok(alive.size <= MAX_CLIENT_TERMINALS, `живых PTY ${alive.size}`);
        return null;
      }
      return null;
    },
  });
  await Promise.all([
    fixture.hub.call({ op: 'createTerminal', hostId: 'h', directory: '/work' }),
    fixture.hub.call({ op: 'createTerminal', hostId: 'h', directory: '/work' }),
  ]);
  assert.equal(new Set(disposed).size, disposed.length, 'один URI не вытесняется дважды');
  assert.equal(disposed.length, 2, 'каждое новое открытие освобождает свой слот');
  assert.ok(alive.size <= MAX_CLIENT_TERMINALS);
  await fixture.hub.stop();
});

test('ошибка вытеснения не создаёт новый PTY, а NotFound считается закрытием', async () => {
  const broken = setup({
    terminals: ownTerminals(MAX_CLIENT_TERMINALS),
    request: method => {
      if (method === 'disposeTerminal') throw new RpcError(JsonRpcErrorCodes.InternalError, 'dispose failed');
      return null;
    },
  });
  await assert.rejects(broken.hub.call({ op: 'createTerminal', hostId: 'h', directory: '/work' }), /Не удалось освободить место/);
  assert.equal(broken.requests.filter(item => item.method === 'createTerminal').length, 0, 'PTY не создаётся');

  const gone = setup({
    terminals: ownTerminals(MAX_CLIENT_TERMINALS),
    request: method => {
      if (method === 'disposeTerminal') throw new RpcError(AhpErrorCodes.NotFound, 'No such terminal');
      return null;
    },
  });
  const { terminalUri } = await gone.hub.call({ op: 'createTerminal', hostId: 'h', directory: '/work' }) as { terminalUri: string };
  assert.match(terminalUri, /^ahp-terminal:\//);
  assert.equal(gone.requests.filter(item => item.method === 'createTerminal').length, 1);
  await broken.hub.stop();
  await gone.hub.stop();
});

test('второй наблюдатель получает накопленный вывод кадром раньше снимка', async () => {
  const fixture = setup();
  await fixture.hub.start([]);
  fixture.states.set(terminalUri, terminalState());
  fixture.hub.watch('h', terminalUri);
  await setImmediate();
  fixture.messages.length = 0;
  fixture.echo(terminalUri, { type: ActionType.TerminalData, data: 'ping' });
  await setImmediate();
  assert.equal(fixture.messages.length, 0, 'до тика кадр ещё не отправлен');

  assert.ok(fixture.hub.watch('h', terminalUri) !== undefined, 'второй наблюдатель получает снимок');
  assert.deepEqual(fixture.messages.map(item => item.message.t), ['terminalData'], 'кадр уходит до снимка');
  assert.equal(fixture.streaming(terminalUri), 'ping');
  // Кадр в тике уже не должен повторить те же байты.
  fixture.messages.length = 0;
  await delay(60);
  assert.deepEqual(fixture.messages, []);
  await fixture.hub.stop();
});

test('ввод и resize уходят в канал только живого терминала', async () => {
  const fixture = setup();
  fixture.states.set(terminalUri, terminalState());
  fixture.hub.watch('h', terminalUri);
  await setImmediate();
  await fixture.hub.call({ op: 'terminalInput', hostId: 'h', terminalUri, data: 'ls\r' });
  await fixture.hub.call({ op: 'terminalResize', hostId: 'h', terminalUri, cols: 120, rows: 40 });
  assert.deepEqual(fixture.dispatched, [
    { channel: terminalUri, action: { type: ActionType.TerminalInput, data: 'ls\r' } },
    { channel: terminalUri, action: { type: ActionType.TerminalResized, cols: 120, rows: 40 } },
  ]);
  await assert.rejects(fixture.hub.call({ op: 'terminalResize', hostId: 'h', terminalUri, cols: 0, rows: 40 }), /размер/);
  await assert.rejects(fixture.hub.call({ op: 'terminalInput', hostId: 'h', terminalUri, data: '' }), /Пустой ввод/);

  fixture.states.set(terminalUri, terminalState({ lifecycle: { status: TerminalLifecycleStatus.Exited, exitCode: 7 } }));
  fixture.hub.unwatch('h', terminalUri);
  fixture.hub.watch('h', terminalUri);
  await setImmediate();
  await assert.rejects(fixture.hub.call({ op: 'terminalInput', hostId: 'h', terminalUri, data: 'x' }), /завершён/);
  await fixture.hub.stop();
});

test('disposeTerminal закрывает PTY на хосте и убирает канал, повторное закрытие не ошибка', async () => {
  const fixture = setup();
  fixture.states.set(terminalUri, terminalState());
  fixture.hub.watch('h', terminalUri);
  await setImmediate();
  await fixture.hub.call({ op: 'disposeTerminal', hostId: 'h', terminalUri });
  assert.deepEqual(fixture.requests.at(-1), { method: 'disposeTerminal', params: { channel: terminalUri } });

  const gone = setup({ request: () => { throw new RpcError(AhpErrorCodes.NotFound, 'No such terminal'); } });
  await gone.hub.call({ op: 'disposeTerminal', hostId: 'h', terminalUri });
  await assert.rejects(fixture.hub.call({ op: 'disposeTerminal', hostId: 'h', terminalUri: 'ahp-session:/x' }), /Ожидался терминал/);
  await fixture.hub.stop();
  await gone.hub.stop();
});

test('вывод склеивается в кадры, а перед статусом выходит отдельным кадром', async () => {
  const fixture = setup();
  await fixture.hub.start([]);
  fixture.states.set(terminalUri, terminalState());
  fixture.hub.watch('h', terminalUri);
  await setImmediate();
  fixture.messages.length = 0;
  fixture.echo(terminalUri, { type: ActionType.TerminalData, data: 'a' });
  fixture.echo(terminalUri, { type: ActionType.TerminalData, data: 'b' });
  await setImmediate();
  assert.equal(fixture.messages.filter(item => item.message.t === 'action').length, 0, 'данные не идут обычным action');
  await delay(60);
  assert.equal(fixture.streaming(terminalUri), 'ab');
  const frames = fixture.messages.filter(item => item.message.t === 'terminalData').length;
  assert.equal(frames, 1, 'два фрагмента одного тика — один кадр');

  fixture.messages.length = 0;
  fixture.echo(terminalUri, { type: ActionType.TerminalData, data: 'bye' });
  fixture.echo(terminalUri, { type: ActionType.TerminalExited, exitCode: 0 });
  await setImmediate();
  // flush перед статусом: сначала последний вывод, потом действие.
  assert.deepEqual(fixture.messages.map(item => item.message.t), ['terminalData', 'action']);
  assert.equal(fixture.streaming(terminalUri), 'bye');
  await fixture.hub.stop();
});

test('автоочистка закрывает только свой брошенный терминал', async () => {
  const terminals: TerminalInfo[] = [
    { resource: 'ahp-terminal:/mine', title: 'Мой', claim: { kind: TerminalClaimKind.Client, clientId: 'browser-backend' }, lifecycle: { status: TerminalLifecycleStatus.Running } },
    { resource: 'ahp-terminal:/agent', title: 'Агент', claim: { kind: TerminalClaimKind.Session, session: 'ahp-session:/s', chat: 'ahp-chat:/c' }, lifecycle: { status: TerminalLifecycleStatus.Running } },
    { resource: 'ahp-terminal:/other', title: 'Чужой', claim: { kind: TerminalClaimKind.Client, clientId: 'another' }, lifecycle: { status: TerminalLifecycleStatus.Running } },
  ];
  const fixture = setup({ terminals });
  await fixture.hub.start([]);
  fixture.states.set(ROOT, { agents: [], terminals });
  fixture.echo(ROOT, { type: ActionType.RootTerminalsChanged, terminals });
  await setImmediate();
  assert.deepEqual(fixture.hub.sweepTerminals(Date.now() + 60_000, 30_000), []);
  const disposed = fixture.hub.sweepTerminals(Date.now() + 31 * 60_000, 30 * 60_000);
  assert.deepEqual(disposed, ['ahp-terminal:/mine']);
  await setImmediate();
  assert.deepEqual(fixture.requests.filter(item => item.method === 'disposeTerminal').map(item => (item.params as { channel: string }).channel), ['ahp-terminal:/mine']);
  await fixture.hub.stop();
});
