import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { loadConfig } from '../server/config.js';
import { startKeepAwake } from '../server/keep-awake.js';
import { localHosts, localInstance, type LocalHost } from '../server/local-hosts.js';
import { localLogSources, readLogTail } from '../server/logs.js';
import { portFree, probeWeb } from '../server/net.js';
import { PHONE_ACCESS_PORT } from '../server/phone-access.js';
import { UP_SUPERVISED_ENV } from '../server/up-contract.js';
import { processTable, upOwnershipSource } from '../server/up-state.js';
import {
  formatHostPort, parseUpArgs, runUp, UP_USAGE, UpStop, WEB_PORT,
  type UpChild, type UpDeps, type UpExit, type UpService,
} from '../server/up.js';
import { projectRoot } from './agent-sdks.mjs';
import { probeBackendOverview } from './backend-probe.js';

const SERVICE_PREFIX: Record<UpService, string> = {
  'host:local': '[host:local]',
  'host:wbllm': '[host:wbllm]',
  'host:glm': '[host:glm]',
  backend: '[backend]',
  web: '[web]',
};

function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

function isExecutable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(() => true, () => false);
}

/** Проверка bind'ом: занятый порт не даст запуститься и останется сиротой. */

function pumpLines(stream: Readable, log: (line: string) => void): void {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  void (async () => {
    try {
      for await (const line of lines) log(line);
    } catch {
      // Поток закрыт при dispose().
    } finally {
      lines.close();
    }
  })();
}

function spawnService(service: UpService, command: string, args: string[], env: NodeJS.ProcessEnv, log: (line: string) => void): UpChild {
  const child = spawn(command, args, { cwd: projectRoot, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = SERVICE_PREFIX[service];
  const streams = [child.stdout, child.stderr].filter((stream): stream is Readable => stream !== null);
  // Через общий `log`: в supervised каждая строка (не только собственные сообщения up)
  // получает ISO-время, иначе журнал launchd не сопоставить по времени.
  for (const stream of streams) pumpLines(stream, line => log(`${prefix} ${line}`));
  let settled = false;
  const exited = new Promise<UpExit>(resolveExit => {
    child.once('error', error => {
      if (settled) return;
      settled = true;
      resolveExit({ code: null, signal: null, error });
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      resolveExit({ code, signal });
    });
  });
  if (child.pid === undefined) throw new Error(`Не удалось запустить ${command}`);
  const pid = child.pid;
  return {
    service,
    pid,
    exited,
    signal(someSignal) {
      try {
        // Отрицательный pid — вся группа: code-tunnel и code-server не остаются сиротами.
        process.kill(-pid, someSignal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    },
    dispose() {
      for (const stream of streams) stream.destroy();
    },
  };
}

async function readProviderEnv(file: string): Promise<{ env?: NodeJS.Dict<string>; error?: string }> {
  try {
    return { env: parseEnv(await readFile(file, 'utf8')) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return { error: `Не удалось прочитать ${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function main(): Promise<number> {
  process.chdir(projectRoot);
  const args = parseUpArgs(process.argv.slice(2));
  if (args.kind === 'help') {
    console.log(UP_USAGE);
    return 0;
  }
  if (args.kind === 'error') {
    console.error(`[up] ${args.message}`);
    console.error(UP_USAGE);
    return 1;
  }

  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(process.env.ACC_CONFIG ?? 'hosts.json');
  } catch (error) {
    console.error(`[up] Не удалось прочитать конфигурацию: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const hosts = localHosts(config.hosts);

  const providerEnvFile = process.env.AHP_PROVIDER_ENV_FILE ?? '.local/model-provider.env';
  const provider = await readProviderEnv(providerEnvFile);
  if (provider.error) {
    console.error(`[up] ${provider.error}`);
    return 1;
  }

  const stateDir = process.env.ACC_STATE_DIR?.trim() || '.local';
  let phonePort: number | undefined;
  if (process.env.ACC_PHONE_ACCESS !== '0' && await exists(resolve(stateDir, 'phone-access.json'))) {
    phonePort = PHONE_ACCESS_PORT;
    if (!await exists(resolve('dist/index.html'))) {
      console.warn('[up] Доступ с телефона настроен, но dist/index.html не собран: backend отключит его. Выполните npm run build или уберите phone-access.json.');
    }
  }

  const backend = formatHostPort(config.listen.host, config.listen.port);
  const logSources = localLogSources(hosts);
  const serviceOf = (host: LocalHost): UpService => `host:${host.id}`;
  // launchd пишет stdout в файл без времени; ISO-метка делает журнал пригодным для диагностики.
  const log = (line: string): void => {
    console.log(args.supervised ? `${new Date().toISOString()} ${line}` : line);
  };

  const deps: UpDeps = {
    inspectHost: async host => {
      try {
        return await localInstance(host);
      } catch (error) {
        // На чистой машине нет токена или реестра VS Code: это «хост не запущен», не сбой.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    probeBackend: () => probeBackendOverview({ base: backend, origin: `http://${backend}`, timeoutMs: 2000 }),
    probeWeb: () => probeWeb(WEB_PORT),
    portFree,
    hostLog: async host => {
      const source = logSources.find(item => item.hostId === host.id);
      if (!source) return undefined;
      const tail = await readLogTail(source);
      return tail.status === 'ok'
        ? { fileName: tail.fileName, lines: tail.lines }
        : { fileName: tail.fileName, lines: [tail.message] };
    },
    signalPid: (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    },
    signalGroup: (pid, signal) => {
      try {
        // Отрицательный pid — группа лидера: дети прежнего up тоже завершатся.
        process.kill(-pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    },
    isAlive: pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    spawnHost: (host, env) => serviceOf(host) === 'host:local'
      ? spawnService('host:local', '/bin/bash', ['scripts/start-host.sh', '--log'], env, log)
      : spawnService(serviceOf(host), process.execPath, ['--import', 'tsx', 'scripts/start-responses-host.ts', host.id, '--log'], env, log),
    spawnBackend: env => spawnService('backend', process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      ...env,
      ...(args.supervised ? { [UP_SUPERVISED_ENV]: '1' } : {}),
    }, log),
    spawnWeb: env => spawnService('web', process.execPath, ['node_modules/vite/bin/vite.js'], env, log),
    isExecutable,
    log,
  };

  const ownership = args.supervised
    ? upOwnershipSource({
      file: resolve(stateDir, 'up-state.json'),
      ownerPid: process.pid,
      table: processTable,
      log,
    })
    : undefined;

  const keepAwake = args.keepAwake
    ? startKeepAwake({ platform: process.platform, pid: process.pid, spawn, log })
    : undefined;

  const controller = new AbortController();
  let fatal = false;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const onSignal = (signal: NodeJS.Signals): void => controller.abort(new UpStop(signal));
  const onFatal = (error: unknown): void => {
    fatal = true;
    console.error(`[up] Неожиданная ошибка: ${error instanceof Error ? error.message : String(error)}`);
    controller.abort(new UpStop());
  };
  for (const signal of signals) process.on(signal, onSignal);
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);
  try {
    const code = await runUp({
      config, hosts, env: process.env, providerEnvFile, providerEnv: provider.env,
      webPort: WEB_PORT, ...(phonePort !== undefined ? { phonePort } : {}),
      signal: controller.signal, deps,
      supervised: args.supervised,
      ...(ownership ? { ownership } : {}),
    });
    return fatal ? 1 : code;
  } finally {
    keepAwake?.stop();
    for (const signal of signals) process.off(signal, onSignal);
    process.off('uncaughtException', onFatal);
    process.off('unhandledRejection', onFatal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }, error => {
    console.error(`[up] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
