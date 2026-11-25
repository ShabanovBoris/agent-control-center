import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { Overview } from '../shared/protocol.js';
import type { AppConfig } from './config.js';
import { nativeVSCodeCli, stableVSCodeCli, type HostInstance, type LocalHost } from './local-hosts.js';
import {
  parseUpArgs, resolveVSCodeCli, runUp, UpStop,
  type RunUpOptions, type UpChild, type UpDeps, type UpExit, type UpPolicy, type UpService, type UpTimeouts,
} from './up.js';
import { readUpState, upOwnershipSource, type ProcessTable, type UpOwnership, type UpOwnershipSource } from './up-state.js';

const localHost: LocalHost = {
  id: 'local', label: 'Local', port: 8089,
  tokenFile: '/project/.local/host-token', serverData: '/project/.local/host-data', agents: ['codex'],
};
const wbllmHost: LocalHost = {
  id: 'wbllm', label: 'WBLLM', port: 8093,
  tokenFile: '/project/.local/wbllm-host-token', serverData: '/project/.local/wbllm-host-data', agents: ['codex'],
};
const glmHost: LocalHost = {
  id: 'glm', label: 'GLM', port: 8094,
  tokenFile: '/project/.local/glm-host-token', serverData: '/project/.local/glm-host-data', agents: ['codex'],
};
const hosts = [localHost, wbllmHost];
const config: AppConfig = { listen: { host: '127.0.0.1', port: 8090 }, hosts: [] };

const overview: Overview = {
  hosts: [
    { id: 'local', label: 'Local', status: 'connected', agents: [] },
    { id: 'wbllm', label: 'WBLLM', status: 'connected', agents: [] },
  ],
  sessions: [],
};

function serviceOf(host: LocalHost): UpService {
  return `host:${host.id}`;
}

function instance(host: LocalHost): HostInstance {
  return { id: `fake-${host.id}`, pid: host.id === 'local' ? 8101 : host.id === 'wbllm' ? 8102 : 8103, roots: {}, env: {} };
}

class FakeChild implements UpChild {
  readonly signals: NodeJS.Signals[] = [];
  readonly exited: Promise<UpExit>;
  disposed = false;
  private settle!: (exit: UpExit) => void;

  constructor(
    readonly service: UpService,
    readonly pid: number,
    private readonly onSignal?: (signal: NodeJS.Signals, child: FakeChild) => void,
  ) {
    this.exited = new Promise(resolve => { this.settle = resolve; });
  }

  signal(signal: NodeJS.Signals): void {
    this.signals.push(signal);
    if (this.onSignal) this.onSignal(signal, this);
    else this.exit(null, signal);
  }

  dispose(): void {
    this.disposed = true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    this.settle({ code, signal, ...(error ? { error } : {}) });
  }
}

interface HarnessPatch {
  env?: NodeJS.ProcessEnv;
  providerEnv?: Readonly<Record<string, string | undefined>> | undefined;
  /** Сервисы, которые уже работают до запуска (preflight). */
  live?: UpService[];
  portsBusy?: number[];
  /** Пробы становятся готовыми после spawn. */
  ready?: boolean;
  spawnFails?: UpService;
  ignoreSoftSignals?: boolean;
  /** Порты остаются занятыми после SIGKILL. */
  portStillBusy?: boolean;
  timeouts?: Partial<UpTimeouts>;
  policy?: Partial<UpPolicy>;
  deps?: Partial<UpDeps>;
  supervised?: boolean;
  /** Сервисы, подтверждённые в up-state.json (прежний backend/Vite). */
  owned?: UpService[];
  /** Другой процесс up уже владеет стендом. */
  ownerOther?: number;
  /** Запись владения, которая не удалась (identity недоступна). */
  recordFails?: UpService;
  /** Настоящий источник владения (up-state.json) вместо заглушки. */
  ownershipSource?: UpOwnershipSource;
}

class Harness {
  readonly logs: string[] = [];
  readonly spawns: UpService[] = [];
  readonly children = new Map<UpService, FakeChild>();
  readonly signals: { service: UpService; signal: NodeJS.Signals }[] = [];
  readonly killed: number[] = [];
  readonly groupSignals: { pid: number; signal: NodeJS.Signals }[] = [];
  readonly envs = new Map<UpService, NodeJS.ProcessEnv>();
  readonly controller = new AbortController();
  readonly options: RunUpOptions;
  readonly alivePids = new Set<number>();
  readonly ownership: UpOwnership;
  readonly ownershipSource: UpOwnershipSource;
  readonly records: { service: UpService; leaderPid: number; instancePid?: number }[] = [];
  released: boolean | undefined;
  backendOverview: Overview = cloneOverview(overview);
  private readonly live: Set<UpService>;
  private readonly busy: Set<number>;
  private readonly ready: boolean;
  private readonly ignoreSoft: boolean;
  private readonly portStillBusy: boolean;
  private readonly spawnFails?: UpService;
  private readonly extraDeps: Partial<UpDeps>;
  private readonly dead = new Set<UpService>();
  private readonly owned: Set<UpService>;

  constructor(patch: HarnessPatch = {}) {
    this.live = new Set(patch.live ?? []);
    this.busy = new Set(patch.portsBusy ?? []);
    this.ready = patch.ready ?? false;
    this.ignoreSoft = patch.ignoreSoftSignals ?? false;
    this.portStillBusy = patch.portStillBusy ?? false;
    this.spawnFails = patch.spawnFails;
    this.extraDeps = patch.deps ?? {};
    this.owned = new Set(patch.owned ?? []);
    for (const service of patch.live ?? []) {
      if (service === 'host:local') this.alivePids.add(instance(localHost).pid);
      if (service === 'host:wbllm') this.alivePids.add(instance(wbllmHost).pid);
    }
    const ownership: UpOwnership = {
      owner: { pid: 4242, startedAt: 'test' },
      previous: service => this.owned.has(service)
        ? { leader: { pid: service === 'backend' ? 7100 : 7200, startedAt: 'test' } }
        : undefined,
      owns: async service => this.owned.has(service),
      record: async (service, child) => {
        if (patch.recordFails === service) throw new Error(`pid ${child.leaderPid} не найден в таблице процессов`);
        this.records.push({ service, ...child });
      },
      forget: async () => undefined,
      release: async remove => { this.released = remove; },
    };
    this.ownership = ownership;
    this.ownershipSource = {
      acquire: async () => patch.ownerOther !== undefined
        ? { kind: 'other', pid: patch.ownerOther }
        : { kind: 'acquired', ownership },
    };
    this.options = {
      config,
      hosts,
      env: patch.env ?? {},
      providerEnvFile: '.local/model-provider.env',
      providerEnv: 'providerEnv' in patch ? patch.providerEnv : { WBLLM_API_KEY: 'wb-key' },
      signal: this.controller.signal,
      timeouts: {
        hostStartMs: 500, backendStartMs: 500, webStartMs: 500,
        stopGraceMs: 500, stopWaitMs: 100, portFreeMs: 100, pollMs: 5, progressMs: 10_000,
        ...patch.timeouts,
      },
      policy: {
        restartLimit: 3, restartBackoffMs: [1], restartResetMs: 60_000,
        hostGraceMs: 20, plannedRestartMs: 200, adoptPollMs: 5,
        ...patch.policy,
      },
      supervised: patch.supervised ?? false,
      ownership: patch.ownershipSource ?? this.ownershipSource,
      deps: this.makeDeps(),
    };
  }

  run(): Promise<number> {
    return runUp(this.options);
  }

  async waitReady(): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!this.logs.some(line => line.includes('Стенд готов'))) {
      if (Date.now() > deadline) throw new Error(`Стенд не объявил готовность: ${this.logs.join('\n')}`);
      await delay(5);
    }
  }

  exit(service: UpService, code: number | null, signal: NodeJS.Signals | null = null): void {
    const child = this.children.get(service);
    if (!child) throw new Error(`Нет процесса ${service}`);
    this.markDead(service, child.pid);
    child.exit(code, signal);
  }

  setRestarting(id: LocalHost['id'], value: boolean): void {
    this.backendOverview = {
      ...this.backendOverview,
      hosts: this.backendOverview.hosts.map(item => item.id === id
        ? { ...item, ...(value ? { restarting: true } : { restarting: undefined }) }
        : item),
    };
  }

  reviveHost(service: UpService): void {
    this.dead.delete(service);
    if (service === 'host:local') this.alivePids.add(instance(localHost).pid);
    if (service === 'host:wbllm') this.alivePids.add(instance(wbllmHost).pid);
  }

  text(): string {
    return this.logs.join('\n');
  }

  private markDead(service: UpService, pid: number): void {
    this.dead.add(service);
    this.alivePids.delete(pid);
  }

  private makeDeps(): UpDeps {
    const deps: UpDeps = {
      inspectHost: async host => {
        const service = serviceOf(host);
        if (this.dead.has(service)) return undefined;
        if (this.live.has(service)) return instance(host);
        if (this.ready && this.spawns.includes(service)) return instance(host);
        return undefined;
      },
      probeBackend: async () => {
        if (this.dead.has('backend')) throw new Error('Backend недоступен');
        if (this.live.has('backend') || (this.ready && this.spawns.includes('backend'))) return this.backendOverview;
        throw new Error('Backend недоступен');
      },
      probeWeb: async () => !this.dead.has('web') && (this.live.has('web') || (this.ready && this.spawns.includes('web'))),
      portFree: async port => {
        if (this.busy.has(port)) return false;
        if (this.portStillBusy && this.spawns.length > 0) return false;
        return true;
      },
      hostLog: async host => ({
        fileName: host.id === 'local' ? '.local/host.log' : `.local/${host.id}-host.log`,
        lines: ['журнал хоста'],
      }),
      signalPid: (pid, signal) => {
        this.killed.push(pid);
        this.alivePids.delete(pid);
      },
      signalGroup: (pid, signal) => { this.groupSignals.push({ pid, signal }); },
      isAlive: pid => this.alivePids.has(pid),
      spawnHost: (host, env) => this.spawn(serviceOf(host), env),
      spawnBackend: env => this.spawn('backend', env),
      spawnWeb: env => this.spawn('web', env),
      isExecutable: async () => true,
      log: line => { this.logs.push(line); },
    };
    return { ...deps, ...this.extraDeps };
  }

  private spawn(service: UpService, env: NodeJS.ProcessEnv): UpChild {
    if (this.spawnFails === service) throw new Error(`нет исполняемого файла для ${service}`);
    this.dead.delete(service);
    this.spawns.push(service);
    this.envs.set(service, env);
    const pid = 9000 + this.spawns.length;
    const child = new FakeChild(service, pid, (signal, fake) => {
      this.signals.push({ service, signal });
      if (this.ignoreSoft && (signal === 'SIGINT' || signal === 'SIGTERM')) return;
      fake.exit(null, signal);
    });
    this.alivePids.add(pid);
    this.children.set(service, child);
    return child;
  }
}

function cloneOverview(value: Overview): Overview {
  return { hosts: value.hosts.map(host => ({ ...host, agents: [...host.agents] })), sessions: [...value.sessions] };
}

function signalsOf(harness: Harness, service: UpService): NodeJS.Signals[] {
  return harness.signals.filter(item => item.service === service).map(item => item.signal);
}

test('аргументы: --help, --supervised, --keep-awake, --prod и неизвестный флаг', () => {
  assert.deepEqual(parseUpArgs(['--help']), { kind: 'help' });
  assert.deepEqual(parseUpArgs(['-h']), { kind: 'help' });
  assert.deepEqual(parseUpArgs([]), { kind: 'run', supervised: false, keepAwake: false });
  assert.deepEqual(parseUpArgs(['--supervised', '--keep-awake']), { kind: 'run', supervised: true, keepAwake: true });
  assert.deepEqual(parseUpArgs(['--keep-awake', '--supervised']), { kind: 'run', supervised: true, keepAwake: true });
  const prod = parseUpArgs(['--prod']);
  assert.equal(prod.kind, 'error');
  assert.ok(prod.kind === 'error' && prod.message.includes('не поддерживается'));
  const unknown = parseUpArgs(['--bogus']);
  assert.equal(unknown.kind, 'error');
  assert.ok(unknown.kind === 'error' && unknown.message.includes('--bogus'));
});

test('нет provider env или ключей — ошибка до spawn', async () => {
  const absent = new Harness({ providerEnv: undefined });
  assert.equal(await absent.run(), 1);
  assert.equal(absent.spawns.length, 0);
  assert.ok(absent.text().includes('model-provider.env.example'), absent.text());
  for (const providerEnv of [{}, { WBLLM_API_KEY: ' ' }]) {
    const harness = new Harness({ providerEnv });
    assert.equal(await harness.run(), 1);
    assert.equal(harness.spawns.length, 0);
    assert.ok(harness.text().includes('.local/model-provider.env'), harness.text());
  }
});

test('up принимает ключ провайдера из окружения без файла', async () => {
  const harness = new Harness({ ready: true, providerEnv: undefined, env: { WBLLM_API_KEY: 'wb-key' } });
  const running = harness.run();
  try {
    await harness.waitReady();
    assert.deepEqual(harness.spawns, ['host:local', 'host:wbllm', 'backend', 'web']);
  } finally {
    harness.controller.abort(new UpStop('SIGINT'));
    assert.equal(await running, 0);
  }
});

test('VS Code CLI: env раньше native, native раньше bin/code, чужой путь отклонён', async () => {
  assert.deepEqual(
    await resolveVSCodeCli({ VSCODE_CLI: stableVSCodeCli }, () => true),
    { cli: stableVSCodeCli, source: 'env' },
  );
  assert.deepEqual(
    await resolveVSCodeCli({}, path => path === nativeVSCodeCli),
    { cli: nativeVSCodeCli, source: 'default' },
  );
  assert.deepEqual(
    await resolveVSCodeCli({}, path => path === stableVSCodeCli),
    { cli: stableVSCodeCli, source: 'default' },
  );
  const custom = await resolveVSCodeCli({ VSCODE_CLI: '/tmp/my-code' }, () => true);
  assert.ok('error' in custom && custom.error.includes('не поддерживается'));
  const absent = await resolveVSCodeCli({}, () => false);
  assert.ok('error' in absent && absent.error.includes('VSCODE_CLI'));

  const harness = new Harness({ deps: { isExecutable: () => false } });
  assert.equal(await harness.run(), 1);
  assert.equal(harness.spawns.length, 0);
  assert.ok(harness.text().includes('VSCODE_CLI'));
});

test('занятый чужой порт web — отказ до spawn с подсказкой lsof', async () => {
  const harness = new Harness({ portsBusy: [5173] });
  assert.equal(await harness.run(), 1);
  assert.equal(harness.spawns.length, 0);
  assert.ok(harness.text().includes('5173'));
  assert.ok(harness.text().includes('web'));
  assert.ok(harness.text().includes('lsof'));
});

test('полностью живой стенд — no-op с кодом 0', async () => {
  const harness = new Harness({ live: ['host:local', 'host:wbllm', 'backend', 'web'] });
  assert.equal(await harness.run(), 0);
  assert.equal(harness.spawns.length, 0);
  assert.ok(harness.text().includes('уже запущен'));
  assert.ok(harness.text().includes('8101'));
});

test('частично живой стенд — отказ без spawn и список состояний', async () => {
  const harness = new Harness({ live: ['backend'] });
  assert.equal(await harness.run(), 1);
  assert.equal(harness.spawns.length, 0);
  assert.ok(harness.text().includes('не полностью'));
  assert.ok(harness.text().includes('local'));
  assert.ok(harness.text().includes('web'));
});

test('запуск: порядок local → wbllm → backend → web, env и сигналы остановки', async () => {
  const harness = new Harness({ ready: true });
  const running = harness.run();
  await harness.waitReady();
  assert.deepEqual(harness.spawns, ['host:local', 'host:wbllm', 'backend', 'web']);

  const localEnv = harness.envs.get('host:local')!;
  assert.equal(localEnv.AHP_PORT, '8089');
  assert.equal(localEnv.AHP_SERVER_DATA_DIR, localHost.serverData);
  assert.equal(localEnv.VSCODE_CLI, nativeVSCodeCli);
  const wbllmEnv = harness.envs.get('host:wbllm')!;
  assert.equal(wbllmEnv.RESPONSES_AHP_PORT, '8093');
  assert.equal(wbllmEnv.AHP_PORT, undefined);
  assert.equal(harness.envs.get('backend')!.ACC_BACKEND, undefined);
  assert.equal(harness.envs.get('web')!.ACC_BACKEND, '127.0.0.1:8090');

  const summary = harness.text();
  for (const address of ['http://127.0.0.1:5173', 'ws://127.0.0.1:8090/ws', 'ws://127.0.0.1:8089', 'ws://127.0.0.1:8093']) {
    assert.ok(summary.includes(address), address);
  }

  harness.controller.abort(new UpStop('SIGINT'));
  assert.equal(await running, 0);
  assert.deepEqual(signalsOf(harness, 'host:local'), ['SIGINT']);
  assert.deepEqual(signalsOf(harness, 'host:wbllm'), ['SIGINT']);
  assert.deepEqual(signalsOf(harness, 'backend'), ['SIGTERM']);
  assert.deepEqual(signalsOf(harness, 'web'), ['SIGTERM']);
  assert.ok(harness.text().includes('порты свободны'));
  assert.ok([...harness.children.values()].every(child => child.disposed));
});

test('падение сервиса после готовности гасит остальные и возвращает 1', async () => {
  const harness = new Harness({ ready: true });
  const running = harness.run();
  await harness.waitReady();
  harness.exit('web', 1);
  assert.equal(await running, 1);
  assert.ok(harness.text().includes('Сервис web завершился (код 1)'));
  assert.deepEqual(signalsOf(harness, 'host:local'), ['SIGINT']);
  assert.deepEqual(signalsOf(harness, 'backend'), ['SIGTERM']);
  assert.equal(signalsOf(harness, 'web').length, 0, 'упавший сервис не получает сигнал');
});

test('таймаут готовности хоста показывает журнал и код 1', async () => {
  const harness = new Harness({ timeouts: { hostStartMs: 30, pollMs: 5 } });
  assert.equal(await harness.run(), 1);
  assert.ok(harness.text().includes('.local/host.log'));
  assert.ok(harness.text().includes('не запустился'));
  assert.deepEqual(signalsOf(harness, 'host:local'), ['SIGINT']);
});

test('мягкий сигнал не завершил сервисы — SIGKILL, но остановка успешна', async () => {
  const harness = new Harness({ ready: true, ignoreSoftSignals: true, timeouts: { stopGraceMs: 20, stopWaitMs: 20, portFreeMs: 20 } });
  const running = harness.run();
  await harness.waitReady();
  harness.controller.abort(new UpStop('SIGTERM'));
  assert.equal(await running, 0);
  assert.deepEqual(signalsOf(harness, 'host:local'), ['SIGINT', 'SIGKILL']);
  assert.deepEqual(signalsOf(harness, 'backend'), ['SIGTERM', 'SIGKILL']);
  assert.ok(harness.text().includes('SIGKILL'));
});

test('порт остался занят после SIGKILL — код 1 и fallback по pid', async () => {
  const harness = new Harness({ ready: true, ignoreSoftSignals: true, portStillBusy: true, timeouts: { stopGraceMs: 20, stopWaitMs: 20, portFreeMs: 20 } });
  const running = harness.run();
  await harness.waitReady();
  harness.controller.abort(new UpStop('SIGTERM'));
  assert.equal(await running, 1);
  assert.ok(harness.text().includes('заняты порты'));
  assert.deepEqual(harness.killed, [8101, 8102]);
});

test('повторный abort и выход child во время остановки не дублируют сигналы', async () => {
  const harness = new Harness({ ready: true });
  const running = harness.run();
  await harness.waitReady();
  harness.controller.abort(new UpStop('SIGINT'));
  harness.controller.abort(new UpStop('SIGINT'));
  harness.exit('backend', 0);
  assert.equal(await running, 0);
  assert.deepEqual(signalsOf(harness, 'host:local'), ['SIGINT']);
  assert.deepEqual(signalsOf(harness, 'backend'), ['SIGTERM']);
});

test('ACC_PORT и ACC_MOCK_HOST_URL отклоняются до spawn', async () => {
  const port = new Harness({ env: { ACC_PORT: '9999' } });
  assert.equal(await port.run(), 1);
  assert.equal(port.spawns.length, 0);
  assert.ok(port.text().includes('ACC_PORT'));

  const mock = new Harness({ env: { ACC_MOCK_HOST_URL: 'ws://127.0.0.1:9000' } });
  assert.equal(await mock.run(), 1);
  assert.equal(mock.spawns.length, 0);
  assert.ok(mock.text().includes('ACC_MOCK_HOST_URL'));
});

test('спавн с ошибкой сообщает сервис и код 1', async () => {
  const harness = new Harness({ ready: true, spawnFails: 'host:wbllm' });
  assert.equal(await harness.run(), 1);
  assert.ok(harness.text().includes('Не удалось запустить host:wbllm'));
  assert.deepEqual(signalsOf(harness, 'host:local'), ['SIGINT']);
});

async function waitForChild(harness: Harness, service: UpService, previousPid?: number): Promise<FakeChild> {
  const deadline = Date.now() + 3000;
  while (true) {
    const child = harness.children.get(service);
    if (child && child.pid !== previousPid) return child;
    if (Date.now() > deadline) throw new Error(`Нет процесса ${service}: ${harness.text()}`);
    await delay(5);
  }
}

test('supervised: падение web после готовности перезапускает только web', async () => {
  const harness = new Harness({ ready: true, supervised: true });
  const running = harness.run();
  await harness.waitReady();
  const first = await waitForChild(harness, 'web');
  harness.exit('web', 1);
  const second = await waitForChild(harness, 'web', first.pid);
  assert.notEqual(second.pid, first.pid);
  assert.equal(harness.spawns.filter(service => service === 'web').length, 2);
  assert.deepEqual(signalsOf(harness, 'host:local'), []);
  assert.deepEqual(signalsOf(harness, 'host:wbllm'), []);
  assert.deepEqual(signalsOf(harness, 'backend'), []);
  assert.ok(harness.text().includes('Перезапуск 1/3'), harness.text());
  assert.ok(harness.text().includes('web снова в строю'), harness.text());
  harness.controller.abort(new UpStop('SIGTERM'));
  assert.equal(await running, 0);
  assert.equal(harness.released, true);
});

test('supervised: exit 75 перезапускает backend без бюджета и без второго процесса', async () => {
  const harness = new Harness({ ready: true, supervised: true });
  const running = harness.run();
  await harness.waitReady();
  const first = await waitForChild(harness, 'backend');
  harness.exit('backend', 75);
  const second = await waitForChild(harness, 'backend', first.pid);
  assert.notEqual(second.pid, first.pid);
  assert.equal(harness.spawns.filter(service => service === 'backend').length, 2);
  assert.ok(harness.text().includes('код 75'), harness.text());
  assert.ok(!harness.text().includes('Перезапуск 1/3'), harness.text());
  harness.controller.abort(new UpStop('SIGTERM'));
  assert.equal(await running, 0);
});

test('supervised: исчерпание бюджета сохраняет живой хост и возвращает 1', async () => {
  const harness = new Harness({ ready: true, supervised: true, live: ['host:local'], policy: { restartLimit: 2 } });
  const running = harness.run();
  await harness.waitReady();
  let previous = (await waitForChild(harness, 'web')).pid;
  harness.exit('web', 1);
  previous = (await waitForChild(harness, 'web', previous)).pid;
  harness.exit('web', 1);
  previous = (await waitForChild(harness, 'web', previous)).pid;
  harness.exit('web', 1);
  assert.equal(await running, 1);
  assert.deepEqual(signalsOf(harness, 'host:local'), []);
  assert.ok(harness.text().includes('Оставляю живым host:local'), harness.text());
  assert.ok(harness.text().includes('не восстановился после 2 попыток'), harness.text());
  assert.equal(harness.released, false);
});

test('supervised: чужой backend — код 0 без сигналов и спавна', async () => {
  const harness = new Harness({ live: ['backend', 'host:local'], supervised: true });
  assert.equal(await harness.run(), 0);
  assert.equal(harness.spawns.length, 0);
  assert.deepEqual(harness.killed, []);
  assert.deepEqual(harness.groupSignals, []);
  assert.ok(harness.text().includes('чужой стенд'), harness.text());
  assert.equal(harness.released, false);
});

test('C-01: запись владения backend и web создаётся до ожидания готовности', async () => {
  const backendSnapshots: { service: UpService }[][] = [];
  const webSnapshots: { service: UpService }[][] = [];
  let harness!: Harness;
  harness = new Harness({
    ready: true,
    supervised: true,
    deps: {
      probeBackend: async () => {
        if (!harness.spawns.includes('backend')) throw new Error('Backend недоступен');
        backendSnapshots.push([...harness.records]);
        return harness.backendOverview;
      },
      probeWeb: async () => {
        if (harness.spawns.includes('web')) webSnapshots.push([...harness.records]);
        return false;
      },
    },
    timeouts: { webStartMs: 30, pollMs: 5 },
  });
  assert.equal(await harness.run(), 1);
  const firstBackendProbe = backendSnapshots[0] ?? [];
  assert.ok(firstBackendProbe.some(record => record.service === 'backend'), `backend не записан до первой пробы: ${JSON.stringify(firstBackendProbe)}`);
  const firstWebProbe = webSnapshots[0] ?? [];
  assert.ok(firstWebProbe.some(record => record.service === 'web'), `web не записан до пробы: ${JSON.stringify(firstWebProbe)}`);
  assert.deepEqual(harness.records.filter(record => record.service === 'backend').length, 1, 'запись backend не дублируется после готовности');
  assert.deepEqual(harness.records.filter(record => record.service === 'web').length, 1, 'запись web не дублируется после готовности');
  assert.ok(!harness.text().includes('Стенд готов'), harness.text());
});

test('C-01: сбой записи владения гасит ребёнка и возвращает 1', async () => {
  const harness = new Harness({ ready: true, supervised: true, recordFails: 'backend' });
  assert.equal(await harness.run(), 1);
  assert.deepEqual(harness.spawns, ['host:local', 'host:wbllm', 'backend']);
  assert.deepEqual(signalsOf(harness, 'backend'), ['SIGTERM'], 'неучтённый backend должен быть погашен');
  assert.deepEqual(signalsOf(harness, 'host:local'), []);
  assert.ok(harness.text().includes('Не удалось сохранить владение backend'), harness.text());
  assert.ok(harness.text().includes('без записи о владении'), harness.text());
});

test('C-01: подтверждённый backend с живым лидером пересоздаётся, хосты не сигналятся', async () => {
  const harness = new Harness({ ready: true, supervised: true, live: ['backend'], owned: ['backend'] });
  const running = harness.run();
  await harness.waitReady();
  assert.deepEqual(harness.groupSignals, [{ pid: 7100, signal: 'SIGTERM' }]);
  assert.deepEqual(harness.spawns, ['host:local', 'host:wbllm', 'backend', 'web']);
  assert.deepEqual(signalsOf(harness, 'host:local'), []);
  assert.deepEqual(signalsOf(harness, 'host:wbllm'), []);
  assert.ok(harness.text().includes('Останавливаю прежний backend (pid 7100)'), harness.text());
  assert.ok(harness.text().includes('Стенд готов'), harness.text());
  harness.controller.abort(new UpStop('SIGTERM'));
  assert.equal(await running, 0);
});

test('C-03: зависший подтверждённый backend пересоздаётся, а не упирается в порт', async () => {
  let harness!: Harness;
  harness = new Harness({
    ready: true,
    supervised: true,
    owned: ['backend'],
    deps: { portFree: async port => port !== 8090 || harness.groupSignals.length > 0 },
  });
  const running = harness.run();
  await harness.waitReady();
  assert.deepEqual(harness.groupSignals, [{ pid: 7100, signal: 'SIGTERM' }]);
  assert.equal(harness.spawns.filter(service => service === 'backend').length, 1);
  assert.ok(harness.text().includes('Стенд готов'), harness.text());
  harness.controller.abort(new UpStop('SIGTERM'));
  assert.equal(await running, 0);
});

test('C-04: занятый порт после падения не даёт вторую попытку спавна', async () => {
  let harness!: Harness;
  harness = new Harness({
    ready: true,
    supervised: true,
    deps: { portFree: async port => !(port === 5173 && harness.spawns.includes('web')) },
    timeouts: { stopGraceMs: 5, stopWaitMs: 5, portFreeMs: 5 },
    policy: { restartLimit: 2 },
  });
  const running = harness.run();
  await harness.waitReady();
  harness.exit('web', 1);
  assert.equal(await running, 1);
  assert.equal(harness.spawns.filter(service => service === 'web').length, 1, 'второй Vite на занятом порту не запускается');
  assert.ok(harness.text().includes('Порт сервиса web всё ещё занят'), harness.text());
  assert.ok(harness.text().includes('не восстановился после 2 попыток'), harness.text());
});

test('C-01: запись backend переживает смерть up, новый супервизор пересоздаёт backend', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'up-c01-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'up-state.json');
  const identities = new Map<number, string>([[2000, 'owner-old'], [7000, 'backend-start']]);
  const table: ProcessTable = {
    identity: async pid => identities.has(pid)
      ? { pid, startedAt: identities.get(pid)! }
      : pid >= 9000 ? { pid, startedAt: `spawn-${pid}` } : undefined,
    otherUp: async () => undefined,
  };

  // Фаза 1: up заспавнил backend, записал владение и «умер» до готовности.
  const backend = new FakeChild('backend', 7000);
  const first = new Harness({
    supervised: true,
    live: ['host:local', 'host:wbllm'],
    deps: {
      spawnBackend: () => backend,
      probeBackend: async () => { throw new Error('backend ещё не готов'); },
    },
    timeouts: { backendStartMs: 20, pollMs: 5 },
    ownershipSource: upOwnershipSource({ file, ownerPid: 2000, table, log: () => undefined }),
  });
  assert.equal(await first.run(), 1);
  const saved = await readUpState(file);
  assert.equal(saved?.children.backend?.leader.pid, 7000, 'запись создана до готовности');
  assert.equal(saved?.children.backend?.leader.startedAt, 'backend-start');

  // Фаза 2: владелец мёртв, backend отвечает, его лидер жив — новый up пересоздаёт backend.
  identities.delete(2000);
  identities.set(3000, 'owner-new');
  const second = new Harness({
    supervised: true,
    ready: true,
    live: ['host:local', 'host:wbllm', 'backend'],
    ownershipSource: upOwnershipSource({ file, ownerPid: 3000, table, log: () => undefined }),
  });
  const running = second.run();
  await second.waitReady();
  assert.deepEqual(second.groupSignals, [{ pid: 7000, signal: 'SIGTERM' }], second.text());
  assert.deepEqual(second.spawns, ['backend', 'web']);
  assert.deepEqual(signalsOf(second, 'host:local'), []);
  assert.deepEqual(signalsOf(second, 'host:wbllm'), []);
  second.controller.abort(new UpStop('SIGTERM'));
  assert.equal(await running, 0);
});

test('supervised: живой хост без записи принимается и не спавнится', async () => {
  const harness = new Harness({ ready: true, supervised: true, live: ['host:local', 'host:wbllm'] });
  const running = harness.run();
  await harness.waitReady();
  assert.deepEqual(harness.spawns, ['backend', 'web']);
  assert.ok(harness.text().includes('Принимаю под наблюдение host:local'), harness.text());
  assert.ok(harness.records.some(record => record.service === 'host:local' && record.leaderPid === 8101), JSON.stringify(harness.records));
  harness.controller.abort(new UpStop('SIGTERM'));
  assert.equal(await running, 0);
  assert.deepEqual(harness.killed, [8101, 8102]);
  assert.equal(harness.released, true);
});

test('supervised: плановый restarting не спавнит второй хост', async () => {
  const harness = new Harness({ ready: true, supervised: true });
  const running = harness.run();
  await harness.waitReady();
  harness.setRestarting('wbllm', true);
  harness.exit('host:wbllm', 1);
  await delay(40);
  harness.reviveHost('host:wbllm');
  await delay(40);
  assert.equal(harness.spawns.filter(service => service === 'host:wbllm').length, 1);
  assert.ok(harness.text().includes('перезапускается планово'), harness.text());
  assert.ok(harness.text().includes('Принимаю под наблюдение host:wbllm'), harness.text());
  harness.controller.abort(new UpStop('SIGTERM'));
  assert.equal(await running, 0);
});

test('supervised: быстрый выход child во время старта даёт код 1 без ожидания таймаута', async () => {
  const harness = new Harness({ supervised: true, timeouts: { hostStartMs: 5000 } });
  const startedAt = Date.now();
  const running = harness.run();
  await waitForChild(harness, 'host:local');
  harness.exit('host:local', 1);
  assert.equal(await running, 1);
  assert.ok(Date.now() - startedAt < 2000, `ожидание затянулось: ${Date.now() - startedAt} мс`);
  assert.ok(harness.text().includes('хост «Local» завершился (код 1)'), harness.text());
  assert.equal(harness.released, false);
});

test('supervised: другой up — код 0 без проб и спавна', async () => {
  const harness = new Harness({ supervised: true, ownerOther: 777 });
  assert.equal(await harness.run(), 0);
  assert.equal(harness.spawns.length, 0);
  assert.ok(harness.text().includes('pid 777'), harness.text());
  assert.equal(harness.released, undefined);
});

test('up запускает WBLLM и GLM с раздельными портами и ждёт подключения обоих', async () => {
  const harness = new Harness({ ready: true, env: { GLM_API_KEY: 'glm-key' } });
  harness.options.hosts = [...hosts, glmHost];
  const glmOverview: Overview['hosts'][number] = { id: 'glm', label: 'GLM', status: 'reconnecting', agents: [] };
  harness.backendOverview.hosts.push(glmOverview);
  const probeBackend = harness.options.deps.probeBackend;
  let markProbed!: () => void;
  const probed = new Promise<void>(resolve => { markProbed = resolve; });
  harness.options.deps.probeBackend = async () => {
    const result = await probeBackend();
    markProbed();
    return result;
  };
  const running = harness.run();
  try {
    await waitForChild(harness, 'backend');
    await probed;
    assert.equal(harness.spawns.includes('web'), false);
    glmOverview.status = 'connected';
    await harness.waitReady();
    assert.deepEqual(harness.spawns, ['host:local', 'host:wbllm', 'host:glm', 'backend', 'web']);
    assert.equal(harness.envs.get('host:glm')?.RESPONSES_AHP_PORT, '8094');
    assert.equal(harness.envs.get('host:wbllm')?.RESPONSES_AHP_PORT, '8093');
  } finally {
    harness.controller.abort(new UpStop('SIGINT'));
    assert.equal(await running, 0);
  }
  assert.deepEqual(signalsOf(harness, 'host:glm'), ['SIGINT']);
});

test('up отклоняет запуск настроенного GLM без ключа', async () => {
  const harness = new Harness();
  harness.options.hosts = [...hosts, glmHost];
  assert.equal(await harness.run(), 1);
  assert.deepEqual(harness.spawns, []);
  assert.ok(harness.text().includes('GLM_API_KEY'));
});
