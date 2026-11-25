import { setTimeout as delay } from 'node:timers/promises';
import type { Overview } from '../shared/protocol.js';
import type { AppConfig } from './config.js';
import { nativeVSCodeCli, stableVSCodeCli, type HostInstance, type LocalHost } from './local-hosts.js';
import { BACKEND_RESTART_EXIT_CODE } from './up-contract.js';
import { RestartBudget } from './up-restart.js';
import type { UpOwnership, UpOwnershipSource } from './up-state.js';
import { isResponsesProvider, responsesProviders } from '../scripts/responses-providers.js';

export type UpService = `host:${LocalHost['id']}` | 'backend' | 'web';

/** Единый порт Vite: его проверяют `up`, `autostart` и `launchd`. */
export const WEB_PORT = 5173;

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
  /** `SIGKILL` конкретному pid: хост мог пережить обёртку или быть заменён backend'ом. */
  signalPid(pid: number, signal: NodeJS.Signals): void;
  /** Сигнал группе процессов по pid лидера (принятый прежний backend/Vite). */
  signalGroup(pid: number, signal: NodeJS.Signals): void;
  /** Жив ли процесс; используется принятыми детьми и ожиданием выхода. */
  isAlive(pid: number): boolean;
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

export interface UpPolicy {
  /** Сколько перезапусков одного сервиса допускается подряд. */
  restartLimit: number;
  restartBackoffMs: readonly number[];
  restartResetMs: number;
  /** Сколько ждать перезапуска хоста, если `restart:services` ещё не прислал `restarting`. */
  hostGraceMs: number;
  /** Верхняя граница ожидания планового перезапуска хоста (как RESTART_TIMEOUT_MS). */
  plannedRestartMs: number;
  /** Период проверки принятого хоста, у которого нет pipe. */
  adoptPollMs: number;
}

export const DEFAULT_UP_POLICY: UpPolicy = {
  restartLimit: 5,
  restartBackoffMs: [1_000, 2_000, 5_000, 15_000, 30_000],
  restartResetMs: 600_000,
  hostGraceMs: 10_000,
  plannedRestartMs: 240_000,
  adoptPollMs: 1_000,
};

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
  /** Режим launchd: принимать живые хосты и перезапускать только упавший сервис. */
  supervised?: boolean;
  policy?: Partial<UpPolicy>;
  /** Обязателен в supervised: без подтверждённого владения стенд не запускается. */
  ownership?: UpOwnershipSource;
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

export const UP_USAGE = `Использование: npm run up [--supervised] [--keep-awake] [--help]

Поднимает локальные хосты из hosts.json, backend и web (Vite) и гасит всё по Ctrl+C/SIGTERM.
  --supervised    режим launchd: принимать живые хосты и перезапускать только упавший сервис
  --keep-awake    не давать macOS уснуть, пока жив up (caffeinate; только macOS)
  -h, --help      показать справку

Без флагов up остаётся fail-fast: падение любого сервиса гасит стенд.
Режим --prod не поддерживается; для production используйте npm run build и npm run server.

Переменные: VSCODE_CLI — только VS Code Stable по стандартному пути (или его bin/code).
AHP_PROVIDER_ENV_FILE — путь к .local/model-provider.env (ключи WBLLM_API_KEY и GLM_API_KEY для дополнительных хостов).`;

export type UpArgs =
  | { kind: 'help' }
  | { kind: 'run'; supervised: boolean; keepAwake: boolean }
  | { kind: 'error'; message: string };

export function parseUpArgs(argv: readonly string[]): UpArgs {
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };
  let supervised = false;
  let keepAwake = false;
  for (const arg of argv) {
    if (arg === '--supervised') { supervised = true; continue; }
    if (arg === '--keep-awake') { keepAwake = true; continue; }
    if (arg === '--prod') {
      return { kind: 'error', message: 'Режим --prod не поддерживается: для production используйте npm run build и npm run server.' };
    }
    return { kind: 'error', message: `Неизвестный аргумент «${arg}».` };
  }
  return { kind: 'run', supervised, keepAwake };
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
  /** Попытка запуска/перезапуска: её выход обрабатывает сама попытка, а не супервизор. */
  attempt?: Attempt;
}

interface Attempt {
  active: boolean;
  exit?: UpExit;
}

type StartResult = { ok: true } | { ok: false; reason: string };

/**
 * Хост, найденный `localInstance` и переживший свой `up`: у него нет pipe, но есть
 * живой процесс. `exited` — polling, сигнал идёт только этому pid, `dispose` останавливает polling.
 */
class AdoptedChild implements UpChild {
  readonly exited: Promise<UpExit>;
  private settled = false;
  private timer: NodeJS.Timeout | undefined;
  private resolveExit!: (exit: UpExit) => void;

  constructor(
    readonly service: UpService,
    readonly pid: number,
    private readonly deps: Pick<UpDeps, 'isAlive' | 'signalPid'>,
    private readonly pollMs: number,
  ) {
    this.exited = new Promise<UpExit>(resolve => { this.resolveExit = resolve; });
    this.schedule();
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      if (this.settled) return;
      if (!this.deps.isAlive(this.pid)) {
        this.settled = true;
        this.resolveExit({ code: null, signal: null });
        return;
      }
      this.schedule();
    }, this.pollMs);
  }

  signal(signal: NodeJS.Signals): void {
    this.deps.signalPid(this.pid, signal);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exitText(exit: UpExit): string {
  if (exit.error) return `ошибка запуска: ${exit.error.message}`;
  return exit.signal ? `сигнал ${exit.signal}` : `код ${exit.code ?? '?'}`;
}

function serviceOf(host: LocalHost): UpService {
  return `host:${host.id}`;
}

function hostLogName(host: LocalHost): string {
  return `.local/${host.id === 'local' ? 'host' : `${host.id}-host`}.log`;
}

interface RunOutcome {
  ownership?: UpOwnership;
  removeOwnership: boolean;
}

export async function runUp(options: RunUpOptions): Promise<number> {
  const outcome: RunOutcome = { removeOwnership: false };
  try {
    return await runUpCore(options, outcome);
  } finally {
    if (outcome.ownership) {
      try {
        await outcome.ownership.release(outcome.removeOwnership);
      } catch (error) {
        options.deps.log(`[up] Не удалось обновить состояние владения: ${text(error)}`);
      }
    }
  }
}

async function runUpCore(options: RunUpOptions, outcome: RunOutcome): Promise<number> {
  const { config, hosts, env, providerEnv, providerEnvFile, deps, signal } = options;
  const timeouts: UpTimeouts = { ...DEFAULT_UP_TIMEOUTS, ...options.timeouts };
  const policy: UpPolicy = { ...DEFAULT_UP_POLICY, ...options.policy };
  const supervised = options.supervised === true;
  const webPort = options.webPort ?? WEB_PORT;

  // 1. Локальные хосты: остальные записи hosts.json могут быть удалёнными.
  if (!hosts.some(host => host.id === 'local') ||
      config.hosts.some(entry => (entry.id === 'local' || isResponsesProvider(entry.id)) && !hosts.some(host => host.id === entry.id))) {
    deps.log('[up] Проверьте локальные хосты из hosts.json на macOS: localFilesystem и tokenFile.');
    return 1;
  }

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
  const missing: string[] = [];
  for (const host of hosts) {
    if (!isResponsesProvider(host.id)) continue;
    const key = responsesProviders[host.id].envKey;
    if (!(env[key] || providerEnv?.[key])?.trim()) missing.push(key);
  }
  if (missing.length > 0) {
    deps.log(`[up] Укажите ${missing.join(' и ')} в окружении или в ${providerEnvFile} (образец: model-provider.env.example).`);
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

  // 5. Состояние прогона: общее для ручного и supervised режима.
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

  // 6. Владение: в supervised без него нельзя ни сигналить, ни принимать процессы.
  if (supervised) {
    if (!options.ownership) {
      deps.log('[up] Внутренняя ошибка: режим --supervised требует состояние владения. Запускайте его только через npm run autostart:install.');
      return 1;
    }
    try {
      const acquired = await options.ownership.acquire();
      if (acquired.kind === 'other') {
        deps.log(`[up] Стенд уже под управлением pid ${acquired.pid}; второй супервизор не запускается.`);
        return 0;
      }
      outcome.ownership = acquired.ownership;
    } catch (error) {
      deps.log(`[up] Не удалось подтвердить владение стендом: ${text(error)}.`);
      return 1;
    }
  }

  // 7. Текущее состояние. Проба backend недоступна, пока backend не запущен.
  let instances: (HostInstance | undefined)[];
  let overview: Overview | undefined;
  let backendError: string | undefined;
  let webAlive = false;
  try {
    [instances, overview, webAlive] = await Promise.all([
      Promise.all(hosts.map(host => deps.inspectHost(host))),
      deps.probeBackend().catch((error: unknown) => { backendError = text(error); return undefined; }),
      deps.probeWeb().catch(() => false),
    ]);
  } catch (error) {
    deps.log(`[up] Не удалось проверить состояние стенда: ${text(error)}`);
    return 1;
  }

  const overviewStatus = (id: LocalHost['id']) => overview?.hosts.find(host => host.id === id)?.status;
  const backendReady = hosts.every(host => overviewStatus(host.id) === 'connected');
  const states: ServiceState[] = [
    ...hosts.map((host, index): ServiceState => ({
      service: serviceOf(host), label: host.id, port: host.port, host: '127.0.0.1',
      live: instances[index] !== undefined, portBusy: false,
      ...(instances[index] ? { note: `pid ${instances[index].pid}` } : {}),
    })),
    { service: 'backend', label: 'backend', port: config.listen.port, host: config.listen.host, live: backendReady, portBusy: false,
      ...(overview
        ? { note: `отвечает, хосты: ${hosts.map(host => `${host.id} ${overviewStatus(host.id) ?? 'нет'}`).join(', ')}` }
        : backendError ? { note: 'недоступен' } : {}) },
    { service: 'web', label: 'web', port: webPort, host: '127.0.0.1', live: webAlive, portBusy: false },
  ];

  // 8. В supervised различаем «свой прежний backend/Vite» и чужой стенд. Хосты
  // принимаются отдельно по localInstance, поэтому живой неучтённый backend —
  // единственный признак, что стендом управляет кто-то другой. Подтверждённый
  // backend/Vite пересоздаётся независимо от пробы: зависший процесс тоже наш, и
  // запуск не должен упираться в занятый порт до бесконечности.
  if (supervised) {
    const backendOwned = await outcome.ownership!.owns('backend');
    const webOwned = await outcome.ownership!.owns('web');
    if ((overview !== undefined && !backendOwned) || (webAlive && !webOwned)) {
      deps.log('[up] Backend или Vite уже запущены, но этим up не порождены и не подтверждены в up-state.json: это чужой стенд.');
      deps.log('[up] Ничего не останавливаю. Остановите ручной стенд (Ctrl+C в его терминале) и повторите autostart:install или запуск up --supervised.');
      return 0;
    }
    for (const [service, owned] of [['backend', backendOwned], ['web', webOwned]] as const) {
      if (!owned) continue;
      if (!await stopOwnedBeforeRestart(service)) {
        deps.log(`[up] Не удалось остановить прежний ${service}: порт остался занят.`);
        return 1;
      }
      if (service === 'backend') { overview = undefined; }
      else { webAlive = false; }
      const state = states.find(candidate => candidate.service === service)!;
      state.live = false;
      state.note = 'будет перезапущен';
    }
    states.find(candidate => candidate.service === 'backend')!.live = false;
    states.find(candidate => candidate.service === 'web')!.live = false;
  }

  // 9. Чужие процессы на наших портах не дадут запуститься и остались бы сиротами.
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
  if (!supervised) {
    if (live.length === states.length) {
      deps.log(liveSummary());
      return 0;
    }
    if (live.length > 0 || busy.length > 0) {
      deps.log(partialSummary());
      return 1;
    }
  } else if (busy.length > 0) {
    deps.log(partialSummary());
    return 1;
  }

  if (options.phonePort !== undefined && !await deps.portFree(options.phonePort, '127.0.0.1')) {
    deps.log(`[up] Порт ${options.phonePort} (доступ с телефона) занят. Остановите процесс (lsof -nP -iTCP:${options.phonePort} -sTCP:LISTEN) или уберите .local/phone-access.json.`);
    return 1;
  }

  // 10. Запуск и готовность.
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

  const fail = (message: string): void => {
    failure = message;
    deps.log(`[up] ${message}`);
  };

  let ready = false;
  let lastBackendNote = 'backend ещё не отвечал.';

  const launch = (child: UpChild, host?: LocalHost, attempt?: Attempt): Running => {
    let markDone!: () => void;
    const entry: Running = {
      child,
      done: new Promise<void>(resolve => { markDone = resolve; }),
      exited: false,
      ...(host ? { host } : {}),
      ...(attempt ? { attempt } : {}),
    };
    running.set(child.service, entry);
    void child.exited.then(async exit => {
      entry.exited = true;
      markDone();
      if (stopping) return;
      // Попытка сама проверяет свой stage-флаг: второй параллельный перезапуск не нужен.
      if (attempt?.active) {
        attempt.exit = exit;
        return;
      }
      await afterExit(child.service, child, exit, host);
    });
    return entry;
  };

  /**
   * Гасит процесс, для которого не удалось сохранить владение: иначе следующий
   * запуск увидит живой backend/Vite без записи и примет его за чужой стенд.
   */
  const abandon = async (service: UpService, entry: Running): Promise<void> => {
    trySignal(service, entry.child, 'SIGTERM');
    await waitDone([[service, entry]], timeouts.stopWaitMs);
    if (!entry.exited) {
      trySignal(service, entry.child, 'SIGKILL');
      await waitDone([[service, entry]], timeouts.stopWaitMs);
    }
    entry.child.dispose();
    deps.log(`[up] ${service} (pid ${entry.child.pid}) остановлен: без записи о владении он остался бы без супервизора.`);
  };

  const afterExit = async (service: UpService, child: UpChild, exit: UpExit, host?: LocalHost): Promise<void> => {
    // code-tunnel может пережить обёртку (detach из панели): сначала проверяем хост.
    if (host) {
      const instance = await deps.inspectHost(host).catch(() => undefined);
      if (stopping) return;
      if (instance) {
        deps.log(`[up] Обёртка ${service} завершилась (${exitText(exit)}), но хост «${host.label}» ещё работает (pid ${instance.pid}).`);
        if (supervised) adoptHost(host, instance);
        return;
      }
    }
    if (!supervised || !ready) {
      failure = `Сервис ${service} завершился (${exitText(exit)}).`;
      deps.log(`[up] ${failure}`);
      if (host) await logHostTail(host);
      interrupt('failure');
      return;
    }
    queueRestart(service, exit, host);
  };

  /** Уточняет запись (instancePid для хоста). Лидер уже записан после spawn, поэтому сбой не фатален. */
  const confirmOwnership = async (service: UpService, leaderPid: number, instancePid?: number): Promise<void> => {
    if (!outcome.ownership) return;
    try {
      await outcome.ownership.record(service, { leaderPid, ...(instancePid !== undefined ? { instancePid } : {}) });
    } catch (error) {
      deps.log(`[up] Не удалось уточнить владение ${service}: ${text(error)}`);
    }
  };

  const adoptHost = (host: LocalHost, instance: HostInstance): void => {
    const service = serviceOf(host);
    const tracked = running.get(service);
    if (tracked && !tracked.exited && tracked.child.pid === instance.pid) return;
    const child = new AdoptedChild(service, instance.pid, deps, policy.adoptPollMs);
    deps.log(`[up] Принимаю под наблюдение ${service} (pid ${instance.pid}): активный ход не прерывается.`);
    readyHosts.set(host.id, instance);
    launch(child, host);
    void confirmOwnership(service, instance.pid, instance.pid);
  };

  const waitFor = async (
    timeoutMs: number,
    test: () => Promise<boolean>,
    attempt?: Attempt,
    progress?: (elapsed: number) => string,
  ): Promise<boolean> => {
    const start = Date.now();
    let lastProgress = 0;
    while (!failure && !signal.aborted && !stopping && !attempt?.exit) {
      try { if (await test()) return true; } catch { /* проба повторится */ }
      if (failure || signal.aborted || stopping || attempt?.exit) break;
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

  const spawnStage = async (
    service: UpService,
    spawnChild: () => UpChild,
    attempt: Attempt,
    host?: LocalHost,
  ): Promise<{ child: UpChild } | { error: string }> => {
    let child: UpChild;
    try {
      child = spawnChild();
    } catch (error) {
      return { error: `Не удалось запустить ${service}: ${text(error)}` };
    }
    deps.log(`[up] Запускаю ${service} (pid ${child.pid}).`);
    const entry = launch(child, host, attempt);
    if (supervised) {
      // Владение фиксируется сразу после spawn и до ожидания готовности: супервизор,
      // убитый в этом окне, не должен оставить backend/Vite, которые следующий запуск
      // классифицирует как чужой стенд и оставит без надзора.
      try {
        await outcome.ownership!.record(service, { leaderPid: child.pid });
      } catch (error) {
        await abandon(service, entry);
        return { error: `Не удалось сохранить владение ${service}: ${text(error)}.` };
      }
    }
    return { child };
  };

  const startHost = async (host: LocalHost, retry = false): Promise<StartResult> => {
    const service = serviceOf(host);
    const attempt: Attempt = { active: true };
    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      VSCODE_CLI: cli.cli,
      ...(host.id === 'local'
        ? { AHP_PORT: String(host.port), AHP_SERVER_DATA_DIR: host.serverData }
        : { RESPONSES_AHP_PORT: String(host.port) }),
    };
    const spawned = await spawnStage(service, () => deps.spawnHost(host, childEnv), attempt, host);
    if ('error' in spawned) {
      attempt.active = false;
      if (!retry) { fail(spawned.error); await logHostTail(host); }
      return { ok: false, reason: spawned.error };
    }
    const started = await waitFor(timeouts.hostStartMs, async () => {
      const instance = await deps.inspectHost(host);
      if (!instance) return false;
      readyHosts.set(host.id, instance);
      return true;
    }, attempt, elapsed => `[up] Ждём хост «${host.label}» (${Math.round(elapsed / 1000)} с). Первый запуск может скачать сборку ~600 МБ; журнал: ${hostLogName(host)}.`);
    attempt.active = false;
    if (started) {
      const instance = readyHosts.get(host.id);
      if (instance) {
        await confirmOwnership(service, spawned.child.pid, instance.pid);
      }
      if (attempt.exit) void afterExit(service, spawned.child, attempt.exit, host);
      return { ok: true };
    }
    const reason = attempt.exit
      ? `хост «${host.label}» завершился (${exitText(attempt.exit)}).`
      : signal.aborted || stopping
        ? `запуск хоста «${host.label}» остановлен.`
        : `хост «${host.label}» не запустился за ${Math.round(timeouts.hostStartMs / 1000)} с.`;
    if (!retry && !signal.aborted && !stopping) { fail(reason); await logHostTail(host); }
    else deps.log(`[up] Попытка запуска ${service} не удалась: ${reason}`);
    return { ok: false, reason };
  };

  const startBackend = async (retry = false): Promise<StartResult> => {
    const attempt: Attempt = { active: true };
    const spawned = await spawnStage('backend', () => deps.spawnBackend({ ...env }), attempt);
    if ('error' in spawned) {
      attempt.active = false;
      if (!retry) fail(spawned.error);
      return { ok: false, reason: spawned.error };
    }
    const started = await waitFor(timeouts.backendStartMs, async () => {
      try {
        const state = await deps.probeBackend();
        lastBackendNote = `Backend отвечает, хосты: ${hosts.map(host => `${host.id} ${state.hosts.find(item => item.id === host.id)?.status ?? 'нет'}`).join(', ')}.`;
        // При восстановлении достаточно ответа backend: иначе недоступный хост
        // заставлял бы бесконечно перезапускать живой backend.
        if (retry) return true;
        return hosts.every(host => state.hosts.some(item => item.id === host.id && item.status === 'connected'));
      } catch (error) {
        lastBackendNote = `Backend недоступен: ${text(error)}`;
        return false;
      }
    }, attempt, elapsed => `[up] Ждём backend (${Math.round(elapsed / 1000)} с). ${lastBackendNote}`);
    attempt.active = false;
    if (started) {
      if (attempt.exit) void afterExit('backend', spawned.child, attempt.exit);
      return { ok: true };
    }
    const reason = attempt.exit
      ? `backend завершился (${exitText(attempt.exit)}). ${lastBackendNote}`
      : signal.aborted || stopping
        ? 'запуск backend остановлен.'
        : `Backend не подключил ${hosts.map(host => host.id).join(', ')} за ${Math.round(timeouts.backendStartMs / 1000)} с. ${lastBackendNote}`;
    if (!retry && !signal.aborted && !stopping) {
      fail(reason);
      for (const host of hosts) await logHostTail(host);
    } else deps.log(`[up] Попытка запуска backend не удалась: ${reason}`);
    return { ok: false, reason };
  };

  const startWeb = async (retry = false): Promise<StartResult> => {
    const attempt: Attempt = { active: true };
    const childEnv: NodeJS.ProcessEnv = { ...env, ACC_BACKEND: formatHostPort(config.listen.host, config.listen.port) };
    const spawned = await spawnStage('web', () => deps.spawnWeb(childEnv), attempt);
    if ('error' in spawned) {
      attempt.active = false;
      if (!retry) fail(spawned.error);
      return { ok: false, reason: spawned.error };
    }
    const started = await waitFor(timeouts.webStartMs, () => deps.probeWeb(), attempt,
      elapsed => `[up] Ждём web (${Math.round(elapsed / 1000)} с).`);
    attempt.active = false;
    if (started) {
      if (attempt.exit) void afterExit('web', spawned.child, attempt.exit);
      return { ok: true };
    }
    const reason = attempt.exit
      ? `Vite завершился (${exitText(attempt.exit)}).`
      : signal.aborted || stopping
        ? 'запуск Vite остановлен.'
        : `Vite не ответил на http://127.0.0.1:${webPort}/ за ${Math.round(timeouts.webStartMs / 1000)} с.`;
    if (!retry && !signal.aborted && !stopping) fail(reason);
    else deps.log(`[up] Попытка запуска web не удалась: ${reason}`);
    return { ok: false, reason };
  };

  const startService = (service: UpService, host: LocalHost | undefined, retry: boolean): Promise<StartResult> => {
    if (service === 'backend') return startBackend(retry);
    if (service === 'web') return startWeb(retry);
    if (!host) return Promise.resolve({ ok: false, reason: `неизвестный хост для ${service}` });
    return startHost(host, retry);
  };

  const budgets = new Map<UpService, RestartBudget>();
  const budgetFor = (service: UpService): RestartBudget => {
    let budget = budgets.get(service);
    if (!budget) {
      budget = new RestartBudget({
        limit: policy.restartLimit,
        backoffMs: policy.restartBackoffMs,
        resetAfterMs: policy.restartResetMs,
      });
      budgets.set(service, budget);
    }
    return budget;
  };

  const stopController = new AbortController();
  const abortableDelay = (ms: number): Promise<void> =>
    delay(ms, undefined, { signal: stopController.signal }).catch(() => undefined);

  const handlerChains = new Map<UpService, Promise<void>>();
  const inFlight = new Set<Promise<void>>();
  const queueRestart = (service: UpService, exit: UpExit, host?: LocalHost): void => {
    const next = (handlerChains.get(service) ?? Promise.resolve())
      .then(() => handleExit(service, exit, host))
      .catch(error => {
        failure = `Сбой супервизора ${service}: ${text(error)}`;
        deps.log(`[up] ${failure}`);
        interrupt('failure');
      });
    handlerChains.set(service, next);
    inFlight.add(next);
    void next.then(() => inFlight.delete(next), () => inFlight.delete(next));
  };

  const waitPlannedRestart = async (host: LocalHost): Promise<boolean> => {
    let deadline = Date.now() + policy.hostGraceMs;
    let planned = false;
    while (!stopping && !failure) {
      const instance = await deps.inspectHost(host).catch(() => undefined);
      if (instance) {
        adoptHost(host, instance);
        return true;
      }
      if (!planned) {
        const state = await deps.probeBackend().catch(() => undefined);
        if (state?.hosts.find(candidate => candidate.id === host.id)?.restarting) {
          planned = true;
          deadline = Date.now() + policy.plannedRestartMs;
          deps.log(`[up] Хост «${host.label}» перезапускается планово (restart:services/update). Жду новый экземпляр, активный ход не трогаю.`);
        }
      }
      if (Date.now() >= deadline) return false;
      await abortableDelay(policy.adoptPollMs);
    }
    return true;
  };

  async function handleExit(service: UpService, exit: UpExit, host?: LocalHost): Promise<void> {
    if (stopping || failure) return;
    if (service === 'backend' && exit.code === BACKEND_RESTART_EXIT_CODE) {
      deps.log('[up] Backend запросил плановый перезапуск (код 75): второй процесс не нужен, перезапускаю под собой.');
      await waitPortFreeWithin(service, timeouts.stopGraceMs + timeouts.stopWaitMs);
      if (stopping || failure) return;
      const planned = await startBackend(true);
      if (planned.ok) {
        budgetFor(service).noteSuccess();
        deps.log('[up] Backend снова в строю после планового перезапуска.');
        return;
      }
      deps.log(`[up] Плановый перезапуск backend не удался: ${planned.reason}`);
      await handleExit(service, { code: null, signal: null });
      return;
    }
    if (host) {
      const instance = await deps.inspectHost(host).catch(() => undefined);
      if (stopping || failure) return;
      if (instance) {
        adoptHost(host, instance);
        return;
      }
      if (await waitPlannedRestart(host)) return;
    }
    const budget = budgetFor(service);
    if (!budget.canRestart()) {
      failure = `${service} не восстановился после ${policy.restartLimit} попыток. Проверьте .local/up.log и журнал сервиса.`;
      deps.log(`[up] ${failure}`);
      if (host) await logHostTail(host);
      interrupt('failure');
      return;
    }
    const attemptNo = budget.noteFailure();
    const waitMs = budget.nextDelayMs();
    deps.log(`[up] ${service} завершился (${exitText(exit)}). Перезапуск ${attemptNo}/${policy.restartLimit} через ${(waitMs / 1000).toFixed(1)} с.`);
    await abortableDelay(waitMs);
    if (stopping || failure) return;
    if (host) {
      const instance = await deps.inspectHost(host).catch(() => undefined);
      if (stopping || failure) return;
      if (instance) {
        adoptHost(host, instance);
        return;
      }
    }
    if (!await waitPortFreeWithin(service, timeouts.stopGraceMs)) {
      deps.log(`[up] Порт сервиса ${service} всё ещё занят: попытка ${attemptNo} не запускает второй процесс. Проверьте lsof -nP -iTCP:${portOf(service).port} -sTCP:LISTEN.`);
      await handleExit(service, { code: null, signal: null }, host);
      return;
    }
    if (stopping || failure) return;
    const result = await startService(service, host, true);
    if (result.ok) {
      budget.noteSuccess();
      deps.log(`[up] ${service} снова в строю.`);
      return;
    }
    deps.log(`[up] Попытка ${attemptNo} для ${service} не удалась: ${result.reason}`);
    await handleExit(service, { code: null, signal: null }, host);
  }

  try {
    if (supervised) {
      hosts.forEach((host, index) => {
        const instance = instances[index];
        if (instance) adoptHost(host, instance);
      });
    }
    const stages: (() => Promise<StartResult>)[] = [
      ...hosts.filter((_, index) => !supervised || !instances[index]).map(host => () => startHost(host)),
      () => startBackend(false),
      () => startWeb(false),
    ];
    for (const stage of stages) {
      if (failure || signal.aborted) break;
      if (!(await stage()).ok) break;
    }
    if (!failure && !signal.aborted) {
      ready = true;
      deps.log(readySummary());
      if (supervised) deps.log('[up] Режим супервизора: падение сервиса после готовности восстанавливается без остановки остальных.');
      await interrupted;
    }
  } catch (error) {
    failure = `Внутренняя ошибка up: ${text(error)}`;
    deps.log(`[up] ${failure}`);
  } finally {
    signal.removeEventListener('abort', onAbort);
    clean = await stopAll(supervised && failure && !signal.aborted ? 'keep-live-hosts' : 'all');
  }

  if (failure) {
    deps.log('[up] Запуск прерван из-за ошибки.');
    return 1;
  }
  if (!clean) return 1;
  outcome.removeOwnership = true;
  deps.log(supervised ? '[up] Супервизор остановлен, состояние владения очищено.' : '[up] Стенд остановлен.');
  return 0;

  function readySummary(): string {
    return [
      '[up] Стенд готов:',
      `  web      http://127.0.0.1:${webPort}`,
      `  backend  ws://${formatHostPort(config.listen.host, config.listen.port)}/ws${options.phonePort !== undefined ? ` (+ телефон 127.0.0.1:${options.phonePort})` : ''}`,
      ...hosts.map(host => `  ${host.id.padEnd(8)} ws://127.0.0.1:${host.port} (pid ${readyHosts.get(host.id)?.pid ?? '?'})`),
      `  журналы  ${hosts.map(hostLogName).join(', ')}`,
      '  Ctrl+C — остановить всё.',
    ].join('\n');
  }

  function liveSummary(): string {
    return [
      '[up] Стенд уже запущен, ничего не запускаю:',
      ...hosts.map((host, index) => `  ${host.id.padEnd(8)} ws://127.0.0.1:${host.port} (pid ${instances[index]?.pid ?? '?'})`),
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
      case 'backend': return { port: config.listen.port, host: config.listen.host };
      case 'web': return { port: webPort, host: '127.0.0.1' };
      default: return { port: hosts.find(host => serviceOf(host) === service)!.port, host: '127.0.0.1' };
    }
  }

  async function portFreeWithin(port: number, host: string): Promise<boolean> {
    return portFreeFor(port, host, timeouts.portFreeMs);
  }

  async function portFreeFor(port: number, host: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (await deps.portFree(port, host)) return true;
      if (Date.now() >= deadline) return false;
      await delay(100);
    }
  }

  async function waitPortFreeWithin(service: UpService, timeoutMs: number): Promise<boolean> {
    const target = portOf(service);
    return portFreeFor(target.port, target.host, timeoutMs);
  }

  /**
   * Гасит прежний backend/Vite, подтверждённый в up-state.json. Идентичность
   * проверяется повторно: чужой процесс с тем же pid не должен получить сигнал.
   */
  async function stopOwnedBeforeRestart(service: UpService): Promise<boolean> {
    const record = outcome.ownership?.previous(service);
    if (!record) return true;
    if (!await outcome.ownership!.owns(service)) return true;
    deps.log(`[up] Останавливаю прежний ${service} (pid ${record.leader.pid}) для пересоздания под супервизором.`);
    try { deps.signalGroup(record.leader.pid, 'SIGTERM'); }
    catch (error) { deps.log(`[up] Не удалось послать SIGTERM ${service}: ${text(error)}`); }
    if (await waitPortFreeWithin(service, timeouts.stopGraceMs)) return true;
    deps.log(`[up] ${service} не освободил порт за ${Math.round(timeouts.stopGraceMs / 1000)} с. Посылаю SIGKILL.`);
    try { deps.signalGroup(record.leader.pid, 'SIGKILL'); }
    catch (error) { deps.log(`[up] Не удалось послать SIGKILL ${service}: ${text(error)}`); }
    return waitPortFreeWithin(service, timeouts.stopWaitMs);
  }

  async function verifyPorts(kept: ReadonlySet<UpService>): Promise<string[]> {
    const stuck: string[] = [];
    for (const [service, entry] of running) {
      if (kept.has(service)) continue;
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

  async function stopAll(mode: 'all' | 'keep-live-hosts'): Promise<boolean> {
    stopping = true;
    stopController.abort();
    // Обработчики перезапуска проверяют stopping в каждом poll; дожидаемся их,
    // чтобы spawn не случился после начала остановки.
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    const entries = [...running.entries()];
    if (entries.length === 0) return true;
    const kept = new Set<UpService>();
    if (mode === 'keep-live-hosts') {
      for (const [service, entry] of entries) {
        if (!entry.host) continue;
        const instance = await deps.inspectHost(entry.host).catch(() => undefined);
        if (instance) {
          kept.add(service);
          deps.log(`[up] Оставляю живым ${service} (pid ${instance.pid}): его активный ход не должен прерываться.`);
        }
      }
    }
    const targets = entries.filter(([service]) => !kept.has(service));
    if (targets.length > 0) {
      deps.log(`[up] Останавливаю: ${targets.map(([service]) => service).join(', ')}…`);
      for (const [service, entry] of targets) {
        if (entry.exited) continue;
        trySignal(service, entry.child, service.startsWith('host:') ? 'SIGINT' : 'SIGTERM');
      }
      await waitDone(targets, timeouts.stopGraceMs);
      const alive = targets.filter(([, entry]) => !entry.exited);
      if (alive.length > 0) {
        deps.log(`[up] Не завершились за ${Math.round(timeouts.stopGraceMs / 1000)} с: ${alive.map(([service]) => service).join(', ')}. Посылаю SIGKILL.`);
        for (const [service, entry] of alive) trySignal(service, entry.child, 'SIGKILL');
        await waitDone(alive, timeouts.stopWaitMs);
      }
    }
    // Принятые хосты с polling-таймером не должны держать event loop.
    for (const [, entry] of entries) entry.child.dispose();
    const stuck = await verifyPorts(kept);
    if (stuck.length > 0) {
      deps.log(`[up] После остановки заняты порты: ${stuck.join(', ')}. Проверьте lsof -nP -iTCP:<порт> -sTCP:LISTEN.`);
      return false;
    }
    deps.log(kept.size > 0
      ? `[up] Остановлены сервисы: ${targets.map(([service]) => service).join(', ') || 'нет'}; живые хосты сохранены.`
      : '[up] Все процессы остановлены, порты свободны.');
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
