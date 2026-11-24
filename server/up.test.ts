import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { Overview } from '../shared/protocol.js';
import type { AppConfig } from './config.js';
import { nativeVSCodeCli, stableVSCodeCli, type HostInstance, type LocalHost } from './local-hosts.js';
import {
  parseUpArgs, resolveVSCodeCli, runUp, UpStop,
  type RunUpOptions, type UpChild, type UpDeps, type UpExit, type UpService, type UpTimeouts,
} from './up.js';

const localHost: LocalHost = {
  id: 'local', label: 'Local', port: 8089,
  tokenFile: '/project/.local/host-token', serverData: '/project/.local/host-data', agents: ['codex', 'claude'],
};
const geminiHost: LocalHost = {
  id: 'gemini', label: 'Gemini', port: 8091,
  tokenFile: '/project/.local/gemini-host-token', serverData: '/project/.local/gemini-host-data', agents: ['codex'],
};
const hosts = [localHost, geminiHost];
const config: AppConfig = { listen: { host: '127.0.0.1', port: 8090 }, hosts: [] };

const overview: Overview = {
  hosts: [
    { id: 'local', label: 'Local', status: 'connected', agents: [] },
    { id: 'gemini', label: 'Gemini', status: 'connected', agents: [] },
  ],
  sessions: [],
};

function serviceOf(host: LocalHost): UpService {
  return host.id === 'local' ? 'host:local' : 'host:gemini';
}

function instance(host: LocalHost): HostInstance {
  return { id: `fake-${host.id}`, pid: host.id === 'local' ? 8101 : 8102, roots: {}, env: {} };
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
  deps?: Partial<UpDeps>;
}

class Harness {
  readonly logs: string[] = [];
  readonly spawns: UpService[] = [];
  readonly children = new Map<UpService, FakeChild>();
  readonly signals: { service: UpService; signal: NodeJS.Signals }[] = [];
  readonly killed: number[] = [];
  readonly envs = new Map<UpService, NodeJS.ProcessEnv>();
  readonly controller = new AbortController();
  readonly options: RunUpOptions;
  private readonly live: Set<UpService>;
  private readonly busy: Set<number>;
  private readonly ready: boolean;
  private readonly ignoreSoft: boolean;
  private readonly portStillBusy: boolean;
  private readonly spawnFails?: UpService;
  private readonly extraDeps: Partial<UpDeps>;

  constructor(patch: HarnessPatch = {}) {
    this.live = new Set(patch.live ?? []);
    this.busy = new Set(patch.portsBusy ?? []);
    this.ready = patch.ready ?? false;
    this.ignoreSoft = patch.ignoreSoftSignals ?? false;
    this.portStillBusy = patch.portStillBusy ?? false;
    this.spawnFails = patch.spawnFails;
    this.extraDeps = patch.deps ?? {};
    this.options = {
      config,
      hosts,
      env: patch.env ?? {},
      providerEnvFile: '.local/model-provider.env',
      providerEnv: 'providerEnv' in patch ? patch.providerEnv : { API_KEY: 'key', BASE_URL: 'https://provider.test/v1' },
      signal: this.controller.signal,
      timeouts: {
        hostStartMs: 500, backendStartMs: 500, webStartMs: 500,
        stopGraceMs: 500, stopWaitMs: 100, portFreeMs: 100, pollMs: 5, progressMs: 10_000,
        ...patch.timeouts,
      },
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
    child.exit(code, signal);
  }

  text(): string {
    return this.logs.join('\n');
  }

  private makeDeps(): UpDeps {
    const deps: UpDeps = {
      inspectHost: async host => {
        const service = serviceOf(host);
        if (this.live.has(service)) return instance(host);
        if (this.ready && this.spawns.includes(service)) return instance(host);
        return undefined;
      },
      probeBackend: async () => {
        if (this.live.has('backend') || (this.ready && this.spawns.includes('backend'))) return overview;
        throw new Error('Backend недоступен');
      },
      probeWeb: async () => this.live.has('web') || (this.ready && this.spawns.includes('web')),
      portFree: async port => {
        if (this.busy.has(port)) return false;
        if (this.portStillBusy && this.spawns.length > 0) return false;
        return true;
      },
      hostLog: async host => ({
        fileName: host.id === 'local' ? '.local/host.log' : '.local/gemini-host.log',
        lines: ['журнал хоста'],
      }),
      signalPid: pid => { this.killed.push(pid); },
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
    this.spawns.push(service);
    this.envs.set(service, env);
    const child = new FakeChild(service, 9000 + this.spawns.length, (signal, fake) => {
      this.signals.push({ service, signal });
      if (this.ignoreSoft && (signal === 'SIGINT' || signal === 'SIGTERM')) return;
      fake.exit(null, signal);
    });
    this.children.set(service, child);
    return child;
  }
}

function signalsOf(harness: Harness, service: UpService): NodeJS.Signals[] {
  return harness.signals.filter(item => item.service === service).map(item => item.signal);
}

test('аргументы: --help, --prod и неизвестный флаг', () => {
  assert.deepEqual(parseUpArgs(['--help']), { kind: 'help' });
  assert.deepEqual(parseUpArgs(['-h']), { kind: 'help' });
  assert.deepEqual(parseUpArgs([]), { kind: 'run' });
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
  for (const providerEnv of [{ API_KEY: 'key' }, { BASE_URL: 'https://provider.test/v1' }]) {
    const harness = new Harness({ providerEnv });
    assert.equal(await harness.run(), 1);
    assert.equal(harness.spawns.length, 0);
    assert.ok(harness.text().includes('.local/model-provider.env'), harness.text());
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
  const harness = new Harness({ live: ['host:local', 'host:gemini', 'backend', 'web'] });
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

test('запуск: порядок local → gemini → backend → web, env и сигналы остановки', async () => {
  const harness = new Harness({ ready: true });
  const running = harness.run();
  await harness.waitReady();
  assert.deepEqual(harness.spawns, ['host:local', 'host:gemini', 'backend', 'web']);

  const localEnv = harness.envs.get('host:local')!;
  assert.equal(localEnv.AHP_PORT, '8089');
  assert.equal(localEnv.AHP_SERVER_DATA_DIR, localHost.serverData);
  assert.equal(localEnv.VSCODE_CLI, nativeVSCodeCli);
  const geminiEnv = harness.envs.get('host:gemini')!;
  assert.equal(geminiEnv.GEMINI_AHP_PORT, '8091');
  assert.equal(geminiEnv.AHP_PORT, undefined);
  assert.equal(harness.envs.get('backend')!.ACC_BACKEND, undefined);
  assert.equal(harness.envs.get('web')!.ACC_BACKEND, '127.0.0.1:8090');

  const summary = harness.text();
  for (const address of ['http://127.0.0.1:5173', 'ws://127.0.0.1:8090/ws', 'ws://127.0.0.1:8089', 'ws://127.0.0.1:8091']) {
    assert.ok(summary.includes(address), address);
  }

  harness.controller.abort(new UpStop('SIGINT'));
  assert.equal(await running, 0);
  assert.deepEqual(signalsOf(harness, 'host:local'), ['SIGINT']);
  assert.deepEqual(signalsOf(harness, 'host:gemini'), ['SIGINT']);
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
  const harness = new Harness({ ready: true, spawnFails: 'host:gemini' });
  assert.equal(await harness.run(), 1);
  assert.ok(harness.text().includes('Не удалось запустить host:gemini'));
  assert.deepEqual(signalsOf(harness, 'host:local'), ['SIGINT']);
});
