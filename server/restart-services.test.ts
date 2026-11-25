import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { RootState } from '@microsoft/agent-host-protocol';
import type { Overview } from '../shared/protocol.js';
import { ProjectUpdates } from './updates.js';
import { restartServices, waitForConnections, withRestarting, type RestartServicesOptions } from './restart-services.js';
import type { HostInstance, LocalHost } from './local-hosts.js';
import type { Hub } from './hub.js';

const commit = 'a'.repeat(40);
const hosts: LocalHost[] = [
  { id: 'local', label: 'Основной', port: 8089, tokenFile: '/project/.local/host-token', serverData: '/project/.local/host-data', agents: ['codex'] },
  { id: 'wbllm', label: 'WBLLM', port: 8093, tokenFile: '/project/.local/wbllm-host-token', serverData: '/project/.local/wbllm-host-data', agents: ['codex'] },
];
const instance = (host: LocalHost): HostInstance => ({ id: host.id, pid: host.port, roots: {}, env: {} });
const child = {} as ChildProcess;

function setup(options: {
  active?: Record<string, number>;
  running?: string[];
  failHost?: string;
  generation?: Record<string, number | undefined>;
  onRestart?: (host: LocalHost, beforeStop: () => Promise<void>) => Promise<void>;
  onStart?: (host: LocalHost) => void;
  exclusive?: ProjectUpdates['exclusive'];
} = {}) {
  const active = new Map(Object.entries(options.active ?? { local: 0, wbllm: 0 }));
  const generations = new Map<string, number | undefined>(Object.entries(options.generation ?? { local: 1, wbllm: 1 }));
  const events: string[] = [];
  const hub = {
    hostGeneration: (id: string) => generations.get(id),
    hostRoot: async (id: string) => ({ agents: [], activeSessions: active.get(id), _meta: { hostBuild: { version: '1.0.0', commit } } } as RootState),
  } as unknown as Hub;
  const updates = {
    exclusive: options.exclusive ?? (async <T,>(run: () => Promise<T>) => run()),
    beginRestart: (id: string) => events.push(`blocked:${id}`),
  };
  const args: RestartServicesOptions = {
    hosts, hub, updates,
    restartBackend: async () => { events.push('backend'); },
    inspectInstance: async host => options.running?.includes(host.id) === false ? undefined : instance(host),
    restartHost: async (host, _instance, _build, ready, beforeStop) => {
      events.push(`restart:${host.id}`);
      if (options.onRestart) await options.onRestart(host, beforeStop);
      else await beforeStop();
      if (options.failHost === host.id) throw new Error('host failed');
      generations.set(host.id, (generations.get(host.id) ?? 0) + 1);
      assert.equal(ready(), true);
    },
    startHost: async host => {
      events.push(`start:${host.id}`);
      options.onStart?.(host);
      return child;
    },
    waitForHost: async (_host, ready) => {
      assert.equal(ready(), true, 'готовность требует нового подключения, а не старого snapshot');
    },
  };
  return { args, events, active, generations };
}

test('активная сессия отменяет всю операцию до перезапуска любого хоста', async () => {
  const { args, events } = setup({ active: { local: 0, wbllm: 1 } });
  await assert.rejects(restartServices(args), /активные задачи/);
  assert.deepEqual(events, []);
});

test('остановленный хост запускается; старое connected-состояние не считается готовностью', async () => {
  const { args, events, generations } = setup({
    running: ['local'], generation: { local: 1, wbllm: 8 },
    onStart: host => generations.set(host.id, undefined),
  });
  args.waitForHost = async (_host, ready) => {
    assert.equal(ready(), false, 'disconnected не является новым поколением');
    generations.set('wbllm', 9);
    assert.equal(ready(), true);
  };
  await restartServices(args);
  assert.deepEqual(events, ['blocked:local', 'blocked:wbllm', 'restart:local', 'start:wbllm', 'backend']);
});

test('сбой второго хоста не запускает замену backend', async () => {
  const { args, events } = setup({ failHost: 'wbllm' });
  await assert.rejects(restartServices(args), /host failed/);
  assert.equal(events.includes('backend'), false);
});

test('активность, появившаяся перед SIGINT, отменяет остановку хоста', async () => {
  const { args, active } = setup({
    onRestart: async (_host, beforeStop) => { active.set('local', 1); await beforeStop(); },
  });
  await assert.rejects(restartServices(args), /появились активные задачи/);
});

test('ручной перезапуск и обновление используют одно взаимное исключение', async () => {
  const updates = new ProjectUpdates([], {} as Hub, '1.0.0');
  const running = updates.exclusive(async () => { await setImmediate(); });
  const { args } = setup({ exclusive: run => updates.exclusive(run) });
  await assert.rejects(restartServices(args), /уже выполняется/);
  await running;
});

test('ожидание подключения не принимает undefined и завершается таймаутом', async () => {
  const services = { connected: (_id: string) => undefined };
  await assert.rejects(waitForConnections(services, hosts, new Map([['local', undefined], ['wbllm', undefined]]), 10), /отведённое время/);
});

test('ожидание требует определённое новое поколение каждого хоста', async () => {
  const generations = new Map<string, number | undefined>([['local', 2], ['wbllm', undefined]]);
  let completed = false;
  const pending = waitForConnections({ connected: id => generations.get(id) }, hosts, new Map([['local', 1], ['wbllm', 1]]), 1000)
    .then(() => { completed = true; });
  await setImmediate();
  assert.equal(completed, false, 'disconnected не должен завершать ожидание');
  generations.set('wbllm', 2);
  await pending;
  assert.equal(completed, true);
});

test('withRestarting помечает только планово перезапускаемый хост и не мутирует сводку', () => {
  const original: Overview = {
    hosts: [
      { id: 'local', label: 'Основной', status: 'connected', agents: [] },
      { id: 'wbllm', label: 'WBLLM', status: 'connected', agents: [] },
    ],
    sessions: [],
  };
  const marked = withRestarting(original, id => id === 'wbllm');
  assert.equal(marked.hosts[0]?.restarting, undefined);
  assert.equal(marked.hosts[1]?.restarting, true);
  assert.equal(original.hosts[1]?.restarting, undefined, 'исходная сводка не меняется');
  assert.equal(withRestarting(original, () => false), original, 'без перезапусков возвращается та же сводка');
});
