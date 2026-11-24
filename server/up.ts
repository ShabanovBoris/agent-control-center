import { setTimeout as delay } from 'node:timers/promises';
import type { Overview } from '../shared/protocol.js';
import type { AppConfig } from './config.js';
import { nativeVSCodeCli, stableVSCodeCli, type HostInstance, type LocalHost } from './local-hosts.js';

export type UpService = 'host:local' | 'host:gemini' | 'backend' | 'web';

export interface UpExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface UpChild {
  service: UpService;
  pid: number;
  exited: Promise<UpExit>;
  /** Сигнал всей группе процессов, даже если лидер уже вышел; ESRCH игнорируется. */
  signal(signal: NodeJS.Signals): void;
  /** Закрывает читаемые концы pipe, чтобы `up` не висел после остановки. */
  dispose(): void;
}

export interface UpDeps {
  inspectHost(host: LocalHost): Promise<HostInstance | undefined>;
  probeBackend(): Promise<Overview>;
  probeWeb(): Promise<boolean>;
  portFree(port: number, host: string): Promise<boolean>;
  hostLog(host: LocalHost): Promise<{ fileName: string; lines: string[] } | undefined>;
  /** Только fallback для застрявшего порта, когда группа процессов уже не отвечает. */
  signalPid(pid: number, signal: NodeJS.Signals): void;
  spawnHost(host: LocalHost, env: NodeJS.ProcessEnv): UpChild;
  spawnBackend(env: NodeJS.ProcessEnv): UpChild;
  spawnWeb(env: NodeJS.ProcessEnv): UpChild;
  isExecutable(path: string): Promise<boolean> | boolean;
  log(line: string): void;
}

export interface UpTimeouts {
  hostStartMs: number;
  backendStartMs: number;
  webStartMs: number;
  stopGraceMs: number;
  stopWaitMs: number;
  portFreeMs: number;
  pollMs: number;
  progressMs: number;
}

export interface RunUpOptions {
  config: AppConfig;
  hosts: readonly LocalHost[];
  env: NodeJS.ProcessEnv;
  providerEnvFile: string;
  providerEnv: Readonly<Record<string, string | undefined>> | undefined;
  webPort?: number;
  /** Порт phone listener; задан, только если он включён. */
  phonePort?: number;
  signal: AbortSignal;
  deps: UpDeps;
  timeouts?: Partial<UpTimeouts>;
}

export const DEFAULT_UP_TIMEOUTS: UpTimeouts = {
  hostStartMs: 600_000,
  backendStartMs: 60_000,
  webStartMs: 60_000,
  stopGraceMs: 15_000,
  stopWaitMs: 5_000,
  portFreeMs: 5_000,
  pollMs: 250,
  progressMs: 15_000,
};

export const UP_USAGE = `Использование: npm run up [--help]

Поднимает локальные хосты local и gemini, backend и web (Vite) и гасит всё по Ctrl+C/SIGTERM.
  -h, --help  показать справку

Режим --prod не поддерживается; для production используйте npm run build и npm run server.

Переменные: VSCODE_CLI — только VS Code Stable по стандартному пути (или его bin/code).
AHP_PROVIDER_ENV_FILE — путь к .local/model-provider.env (нужны API_KEY и BASE_URL).`;

export type UpArgs = { kind: 'help' } | { kind: 'run' } | { kind: 'error'; message: string };

export function parseUpArgs(argv: readonly string[]): UpArgs {
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };
  for (const arg of argv) {
    if (arg === '--prod') {
      return { kind: 'error', message: 'Режим --prod не поддерживается: для production используйте npm run build и npm run server.' };
    }
    return { kind: 'error', message: `Неизвестный аргумент «${arg}».` };
  }
  return { kind: 'run' };
}

/** Отличает пользовательскую остановку от внутренней ошибки. */
export class UpStop extends Error {
  constructor(readonly signal?: NodeJS.Signals) {
    super(signal ? `Остановка по сигналу ${signal}` : 'Остановка');
    this.name = 'UpStop';
  }
}

/** IPv6-адрес в URL и в `host:port` должен быть в скобках. */
export function formatHostPort(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

export type VSCodeCliChoice = { cli: string; source: 'env' | 'default' } | { error: string };

/**
 * `localInstance()` находит только VS Code Stable по стандартному пути, поэтому
 * `up` принимает либо нативный `code-tunnel`, либо его `bin/code`.
 */
export async function resolveVSCodeCli(
  env: NodeJS.ProcessEnv,
  isExecutable: (path: string) => Promise<boolean> | boolean,
): Promise<VSCodeCliChoice> {
  const standard = [nativeVSCodeCli, stableVSCodeCli];
  const custom = env.VSCODE_CLI?.trim();
  if (custom) {
    if (!standard.includes(custom)) {
      return {
        error: `VSCODE_CLI=${custom} не поддерживается командой up: панель и localInstance находят только VS Code Stable по стандартному пути. Запустите хост вручную через npm run host.`,
      };
    }
    if (!await isExecutable(custom)) return { error: `VSCODE_CLI=${custom} не исполняется. Проверьте установку VS Code Stable.` };
    return { cli: custom, source: 'env' };
  }
  for (const cli of standard) {
    if (await isExecutable(cli)) return { cli, source: 'default' };
  }
  return {
    error: `Не найден VS Code CLI (${nativeVSCodeCli}). Установите VS Code Stable или задайте VSCODE_CLI стандартным путём.`,
  };
}

interface ServiceState {
  service: UpService;
  label: string;
  port: number;
  host: string;
  live: boolean;
  portBusy: boolean;
  note?: string;
}

interface Running {
  child: UpChild;
  done: Promise<void>;
  exited: boolean;
  host?: LocalHost;
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exitText(exit: UpExit): string {
  if (exit.error) return `ошибка запуска: ${exit.error.message}`;
  return exit.signal ? `сигнал ${exit.signal}` : `код ${exit.code ?? '?'}`;
}

function serviceOf(host: LocalHost): UpService {
  return host.id === 'local' ? 'host:local' : 'host:gemini';
}

function hostLogName(host: LocalHost): string {
  return `.local/${host.id === 'local' ? 'host' : 'gemini-host'}.log`;
}

export async function runUp(options: RunUpOptions): Promise<number> {
  const { config, hosts, env, providerEnv, providerEnvFile, deps, signal } = options;
  const timeouts: UpTimeouts = { ...DEFAULT_UP_TIMEOUTS, ...options.timeouts };
  const webPort = options.webPort ?? 5173;

  // 1. Локальные хосты: остальные записи hosts.json могут быть удалёнными.
  const local = hosts.find(host => host.id === 'local');
  const gemini = hosts.find(host => host.id === 'gemini');
  if (!local || !gemini) {
    deps.log('[up] up управляет только локальными хостами local и gemini из hosts.json на macOS. Проверьте localFilesystem и tokenFile.');
    return 1;
  }
  const localHost: LocalHost = local;
  const geminiHost: LocalHost = gemini;

  // 2. env-переопределения, которые ломают владение стендом.
  const accPort = env.ACC_PORT?.trim();
  if (accPort && Number(accPort) !== config.listen.port) {
    deps.log(`[up] ACC_PORT=${accPort} не совпадает с listen.port ${config.listen.port} из hosts.json: backend слушал бы другой порт. Уберите ACC_PORT для npm run up.`);
    return 1;
  }
  if (env.ACC_MOCK_HOST_URL?.trim()) {
    deps.log('[up] ACC_MOCK_HOST_URL задан: backend подменит адреса хостов mock-хостом. Уберите переменную для npm run up.');
    return 1;
  }

  // 3. Провайдер: значения не печатаем.
  if (!providerEnv) {
    deps.log(`[up] Не найден файл провайдера ${providerEnvFile}. Создайте его по образцу model-provider.env.example: нужны API_KEY и BASE_URL.`);
    return 1;
  }
  const missing = ['API_KEY', 'BASE_URL'].filter(name => !providerEnv[name]?.trim());
  if (missing.length > 0) {
    deps.log(`[up] В ${providerEnvFile} не заданы ${missing.join(' и ')}. Оба локальных хоста без них не запустятся.`);
    return 1;
  }

  // 4. VS Code CLI: тот же путь, по которому localInstance узнаёт хост.
  const cli = await resolveVSCodeCli(env, deps.isExecutable);
  if ('error' in cli) {
    deps.log(`[up] ${cli.error}`);
    return 1;
  }

  if (signal.aborted) {
    deps.log('[up] Остановлено до запуска.');
    return 0;
  }

  // 5. Текущее состояние. Проба backend недоступна, пока backend не запущен.
  let localInstance: HostInstance | undefined;
  let geminiInstance: HostInstance | undefined;
  let overview: Overview | undefined;
  let backendError: string | undefined;
  let webAlive = false;
  try {
    [localInstance, geminiInstance, overview, webAlive] = await Promise.all([
      deps.inspectHost(localHost),
      deps.inspectHost(geminiHost),
      deps.probeBackend().catch((error: unknown) => { backendError = text(error); return undefined; }),
      deps.probeWeb().catch(() => false),
    ]);
  } catch (error) {
    deps.log(`[up] Не удалось проверить состояние стенда: ${text(error)}`);
    return 1;
  }

  const overviewStatus = (id: LocalHost['id']) => overview?.hosts.find(host => host.id === id)?.status;
  const backendReady = overviewStatus('local') === 'connected' && overviewStatus('gemini') === 'connected';
  const states: ServiceState[] = [
    { service: 'host:local', label: 'local', port: localHost.port, host: '127.0.0.1', live: localInstance !== undefined, portBusy: false,
      ...(localInstance ? { note: `pid ${localInstance.pid}` } : {}) },
    { service: 'host:gemini', label: 'gemini', port: geminiHost.port, host: '127.0.0.1', live: geminiInstance !== undefined, portBusy: false,
      ...(geminiInstance ? { note: `pid ${geminiInstance.pid}` } : {}) },
    { service: 'backend', label: 'backend', port: config.listen.port, host: config.listen.host, live: backendReady, portBusy: false,
      ...(overview
        ? { note: `отвечает, хосты: local ${overviewStatus('local') ?? 'нет'}, gemini ${overviewStatus('gemini') ?? 'нет'}` }
        : backendError ? { note: 'недоступен' } : {}) },
    { service: 'web', label: 'web', port: webPort, host: '127.0.0.1', live: webAlive, portBusy: false },
  ];

  // 6. Чужие процессы на наших портах не дадут запуститься и остались бы сиротами.
  try {
    for (const state of states) {
      if (state.live) continue;
      if (!await deps.portFree(state.port, state.host)) state.portBusy = true;
    }
  } catch (error) {
    deps.log(`[up] Не удалось проверить порты: ${text(error)}`);
    return 1;
  }

  const live = states.filter(state => state.live);
  const busy = states.filter(state => state.portBusy);
  if (live.length === states.length) {
    deps.log(liveSummary());
    return 0;
  }
  if (live.length > 0 || busy.length > 0) {
    deps.log(partialSummary());
    return 1;
  }

  if (options.phonePort !== undefined && !await deps.portFree(options.phonePort, '127.0.0.1')) {
    deps.log(`[up] Порт ${options.phonePort} (доступ с телефона) занят. Остановите процесс (lsof -nP -iTCP:${options.phonePort} -sTCP:LISTEN) или уберите .local/phone-access.json.`);
    return 1;
  }

  // 7. Запуск и готовность.
  let failure: string | undefined;
  let stopping = false;
  let interruptedOnce = false;
  let resolveInterrupt!: (reason: 'signal' | 'failure') => void;
  const interrupted = new Promise<'signal' | 'failure'>(resolve => { resolveInterrupt = resolve; });
  const interrupt = (reason: 'signal' | 'failure'): void => {
    if (interruptedOnce) return;
    interruptedOnce = true;
    resolveInterrupt(reason);
  };
  const onAbort = (): void => interrupt('signal');
  signal.addEventListener('abort', onAbort, { once: true });

  const running = new Map<UpService, Running>();
  const readyHosts = new Map<LocalHost['id'], HostInstance>();
  let clean = true;

  const logHostTail = async (host: LocalHost): Promise<void> => {
    try {
      const tail = await deps.hostLog(host);
      if (!tail) return;
      deps.log(`[up] Хвост ${tail.fileName}:`);
      for (const line of tail.lines.slice(-20)) deps.log(`  ${line}`);
    } catch (error) {
      deps.log(`[up] Не удалось прочитать журнал ${hostLogName(host)}: ${text(error)}`);
    }
  };

  const launch = (child: UpChild, host?: LocalHost): void => {
    let markDone!: () => void;
    const entry: Running = { child, done: new Promise<void>(resolve => { markDone = resolve; }), exited: false, ...(host ? { host } : {}) };
    running.set(child.service, entry);
    void child.exited.then(async exit => {
      entry.exited = true;
      markDone();
      if (stopping) return;
      // code-tunnel может пережить обёртку (detach из панели): сначала проверяем хост.
      if (host) {
        const instance = await deps.inspectHost(host).catch(() => undefined);
        if (stopping) return;
        if (instance) {
          deps.log(`[up] Обёртка ${child.service} завершилась (${exitText(exit)}), но хост «${host.label}» ещё работает (pid ${instance.pid}).`);
          return;
        }
      }
      failure = `Сервис ${child.service} завершился (${exitText(exit)}).`;
      deps.log(`[up] ${failure}`);
      if (host) await logHostTail(host);
      interrupt('failure');
    });
  };

  const waitFor = async (timeoutMs: number, test: () => Promise<boolean>, progress?: (elapsed: number) => string): Promise<boolean> => {
    const start = Date.now();
    let lastProgress = 0;
    while (!failure && !signal.aborted && !stopping) {
      try { if (await test()) return true; } catch { /* проба повторится */ }
      if (failure || signal.aborted || stopping) break;
      const elapsed = Date.now() - start;
      if (elapsed >= timeoutMs) return false;
      if (progress && elapsed - lastProgress >= timeouts.progressMs) {
        lastProgress = elapsed;
        deps.log(progress(elapsed));
      }
      await delay(Math.min(timeouts.pollMs, 250), undefined, { signal }).catch(() => undefined);
    }
    return false;
  };

  const spawnStage = (service: UpService, spawnChild: () => UpChild, host?: LocalHost): boolean => {
    let child: UpChild;
    try {
      child = spawnChild();
    } catch (error) {
      failure = `Не удалось запустить ${service}: ${text(error)}`;
      deps.log(`[up] ${failure}`);
      return false;
    }
    deps.log(`[up] Запускаю ${service} (pid ${child.pid}).`);
    launch(child, host);
    return true;
  };

  const startHost = async (host: LocalHost): Promise<boolean> => {
    const service = serviceOf(host);
    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      VSCODE_CLI: cli.cli,
      ...(host.id === 'local'
        ? { AHP_PORT: String(host.port), AHP_SERVER_DATA_DIR: host.serverData }
        : { GEMINI_AHP_PORT: String(host.port) }),
    };
    if (!spawnStage(service, () => deps.spawnHost(host, childEnv), host)) return false;
    const ready = await waitFor(timeouts.hostStartMs, async () => {
      const instance = await deps.inspectHost(host);
      if (!instance) return false;
      readyHosts.set(host.id, instance);
      return true;
    }, elapsed => `[up] Ждём хост «${host.label}» (${Math.round(elapsed / 1000)} с). Первый запуск может скачать сборку ~600 МБ; журнал: ${hostLogName(host)}.`);
    if (ready) return true;
    if (failure || signal.aborted) return false;
    failure = `Хост «${host.label}» не запустился за ${Math.round(timeouts.hostStartMs / 1000)} с.`;
    deps.log(`[up] ${failure}`);
    await logHostTail(host);
    return false;
  };

  let lastBackendNote = 'backend ещё не отвечал.';
  const startBackend = async (): Promise<boolean> => {
    if (!spawnStage('backend', () => deps.spawnBackend({ ...env }))) return false;
    const ready = await waitFor(timeouts.backendStartMs, async () => {
      try {
        const state = await deps.probeBackend();
        lastBackendNote = `Backend отвечает, хосты: local ${state.hosts.find(host => host.id === 'local')?.status ?? 'нет'}, gemini ${state.hosts.find(host => host.id === 'gemini')?.status ?? 'нет'}.`;
        return state.hosts.some(host => host.id === 'local' && host.status === 'connected') &&
          state.hosts.some(host => host.id === 'gemini' && host.status === 'connected');
      } catch (error) {
        lastBackendNote = `Backend недоступен: ${text(error)}`;
        return false;
      }
    }, elapsed => `[up] Ждём backend (${Math.round(elapsed / 1000)} с). ${lastBackendNote}`);
    if (ready) return true;
    if (failure || signal.aborted) return false;
    failure = `Backend не подключил local и gemini за ${Math.round(timeouts.backendStartMs / 1000)} с. ${lastBackendNote}`;
    deps.log(`[up] ${failure}`);
    await logHostTail(localHost);
    await logHostTail(geminiHost);
    return false;
  };

  const startWeb = async (): Promise<boolean> => {
    const childEnv: NodeJS.ProcessEnv = { ...env, ACC_BACKEND: formatHostPort(config.listen.host, config.listen.port) };
    if (!spawnStage('web', () => deps.spawnWeb(childEnv))) return false;
    const ready = await waitFor(timeouts.webStartMs, () => deps.probeWeb(),
      elapsed => `[up] Ждём web (${Math.round(elapsed / 1000)} с).`);
    if (ready) return true;
    if (failure || signal.aborted) return false;
    failure = `Vite не ответил на http://127.0.0.1:${webPort}/ за ${Math.round(timeouts.webStartMs / 1000)} с.`;
    deps.log(`[up] ${failure}`);
    return false;
  };

  try {
    for (const stage of [() => startHost(localHost), () => startHost(geminiHost), startBackend, startWeb]) {
      if (failure || signal.aborted) break;
      if (!await stage()) break;
    }
    if (!failure && !signal.aborted) {
      deps.log(readySummary());
      await interrupted;
    }
  } catch (error) {
    failure = `Внутренняя ошибка up: ${text(error)}`;
    deps.log(`[up] ${failure}`);
  } finally {
    signal.removeEventListener('abort', onAbort);
    clean = await stopAll();
  }

  if (failure) {
    deps.log('[up] Запуск прерван из-за ошибки.');
    return 1;
  }
  if (!clean) return 1;
  deps.log('[up] Стенд остановлен.');
  return 0;

  function readySummary(): string {
    return [
      '[up] Стенд готов:',
      `  web      http://127.0.0.1:${webPort}`,
      `  backend  ws://${formatHostPort(config.listen.host, config.listen.port)}/ws${options.phonePort !== undefined ? ` (+ телефон 127.0.0.1:${options.phonePort})` : ''}`,
      `  local    ws://127.0.0.1:${localHost.port} (pid ${readyHosts.get('local')?.pid ?? '?'})`,
      `  gemini   ws://127.0.0.1:${geminiHost.port} (pid ${readyHosts.get('gemini')?.pid ?? '?'})`,
      '  журналы  .local/host.log, .local/gemini-host.log',
      '  Ctrl+C — остановить всё.',
    ].join('\n');
  }

  function liveSummary(): string {
    return [
      '[up] Стенд уже запущен, ничего не запускаю:',
      `  local    ws://127.0.0.1:${localHost.port} (pid ${localInstance?.pid ?? '?'})`,
      `  gemini   ws://127.0.0.1:${geminiHost.port} (pid ${geminiInstance?.pid ?? '?'})`,
      `  backend  ws://${formatHostPort(config.listen.host, config.listen.port)}/ws`,
      `  web      http://127.0.0.1:${webPort}`,
      '  up управляет только своими процессами; остановите стенд прежним способом.',
    ].join('\n');
  }

  function partialSummary(): string {
    const lines = ['[up] Стенд запущен не полностью — запуск отменён, чтобы не смешивать владение процессами:'];
    for (const state of states) {
      const status = state.live ? 'работает' : state.portBusy ? `порт ${state.port} занят` : 'не запущен';
      lines.push(`  ${state.label.padEnd(8)} ${status}${state.note ? ` — ${state.note}` : ''}`);
    }
    const ports = busy.map(state => state.port);
    if (ports.length > 0) lines.push(`  Чужие процессы: lsof -nP -iTCP:${ports.join(',')} -sTCP:LISTEN`);
    lines.push('  Остановите перечисленные процессы и повторите: up не гасит чужие процессы и не дозапускает частичный стенд.');
    return lines.join('\n');
  }

  function portOf(service: UpService): { port: number; host: string } {
    switch (service) {
      case 'host:local': return { port: localHost.port, host: '127.0.0.1' };
      case 'host:gemini': return { port: geminiHost.port, host: '127.0.0.1' };
      case 'backend': return { port: config.listen.port, host: config.listen.host };
      case 'web': return { port: webPort, host: '127.0.0.1' };
    }
  }

  async function portFreeWithin(port: number, host: string): Promise<boolean> {
    const deadline = Date.now() + timeouts.portFreeMs;
    while (true) {
      if (await deps.portFree(port, host)) return true;
      if (Date.now() >= deadline) return false;
      await delay(100);
    }
  }

  async function verifyPorts(): Promise<string[]> {
    const stuck: string[] = [];
    for (const [service, entry] of running) {
      const target = portOf(service);
      if (await portFreeWithin(target.port, target.host)) continue;
      if (entry.host) {
        const instance = await deps.inspectHost(entry.host).catch(() => undefined);
        if (instance) {
          deps.log(`[up] Порт ${target.port} всё ещё держит хост «${entry.host.label}» (pid ${instance.pid}). Завершаю процесс.`);
          try { deps.signalPid(instance.pid, 'SIGKILL'); }
          catch (error) { deps.log(`[up] Не удалось завершить pid ${instance.pid}: ${text(error)}`); }
          if (await portFreeWithin(target.port, target.host)) continue;
        }
      }
      stuck.push(`${target.port} (${service})`);
    }
    return stuck;
  }

  async function stopAll(): Promise<boolean> {
    stopping = true;
    const entries = [...running.entries()];
    if (entries.length === 0) return true;
    deps.log(`[up] Останавливаю: ${entries.map(([service]) => service).join(', ')}…`);
    for (const [service, entry] of entries) {
      if (entry.exited) continue;
      trySignal(service, entry.child, service.startsWith('host:') ? 'SIGINT' : 'SIGTERM');
    }
    await waitDone(entries, timeouts.stopGraceMs);
    const alive = entries.filter(([, entry]) => !entry.exited);
    if (alive.length > 0) {
      deps.log(`[up] Не завершились за ${Math.round(timeouts.stopGraceMs / 1000)} с: ${alive.map(([service]) => service).join(', ')}. Посылаю SIGKILL.`);
      for (const [service, entry] of alive) trySignal(service, entry.child, 'SIGKILL');
      await waitDone(alive, timeouts.stopWaitMs);
    }
    for (const [, entry] of entries) entry.child.dispose();
    const stuck = await verifyPorts();
    if (stuck.length > 0) {
      deps.log(`[up] После остановки заняты порты: ${stuck.join(', ')}. Проверьте lsof -nP -iTCP:<порт> -sTCP:LISTEN.`);
      return false;
    }
    deps.log('[up] Все процессы остановлены, порты свободны.');
    return true;
  }

  function trySignal(service: UpService, child: UpChild, someSignal: NodeJS.Signals): void {
    try {
      child.signal(someSignal);
    } catch (error) {
      deps.log(`[up] Не удалось послать ${someSignal} сервису ${service}: ${text(error)}`);
    }
  }

  async function waitDone(entries: [UpService, Running][], timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); });
    try {
      // Таймер отменяем: иначе он держит event loop и `up` выходит только через 15 с.
      await Promise.race([
        Promise.all(entries.map(([, entry]) => entry.done)),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
