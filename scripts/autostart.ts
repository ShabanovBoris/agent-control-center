import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { loadConfig } from '../server/config.js';
import {
  AUTOSTART_LABEL,
  defaultLaunchdDeps,
  installLaunchdJob,
  launchdSpec,
  launchdStatus,
  uninstallLaunchdJob,
} from '../server/launchd.js';
import { localHosts, localInstance, type LocalHost } from '../server/local-hosts.js';
import { readLogTail } from '../server/logs.js';
import { portFree, probeWeb } from '../server/net.js';
import { PHONE_ACCESS_PORT } from '../server/phone-access.js';
import { formatHostPort, WEB_PORT } from '../server/up.js';
import { projectRoot } from './agent-sdks.mjs';
import { probeBackendOverview } from './backend-probe.js';

function spec(keepAwake: boolean) {
  return launchdSpec({ projectRoot, execPath: process.execPath, keepAwake });
}

const USAGE = `Использование: npm run autostart:<install|uninstall|status> [--keep-awake] [--force]

  install     создать ~/Library/LaunchAgents/${AUTOSTART_LABEL}.plist и запустить up --supervised
  uninstall   выгрузить job, дождаться выхода up и свободных портов, удалить plist
  status      показать plist, job, keep-awake, журнал и состояние стенда

  --keep-awake  запускать up с caffeinate (только install)
  --force       перезаписать/удалить чужой plist и подтвердить перезапуск работающего
                job, если plist изменился (это прерывает активные ходы)

Плист лежит вне Git и не содержит секретов: провайдер читается хостом из
.local/model-provider.env относительно WorkingDirectory.`;

type Command = 'install' | 'uninstall' | 'status';

interface Args {
  command: Command;
  keepAwake: boolean;
  force: boolean;
}

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const command = argv[0];
  if (command !== 'install' && command !== 'uninstall' && command !== 'status') {
    return { error: command ? `Неизвестная команда «${command}».` : 'Не указана команда.' };
  }
  let keepAwake = false;
  let force = false;
  for (const arg of argv.slice(1)) {
    if (arg === '--keep-awake') { keepAwake = true; continue; }
    if (arg === '--force') { force = true; continue; }
    if (arg === '--help' || arg === '-h') return { error: USAGE };
    return { error: `Неизвестный аргумент «${arg}».` };
  }
  if (keepAwake && command !== 'install') return { error: '--keep-awake допустим только для install.' };
  return { command, keepAwake, force };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

/**
 * Значения не печатаем: часть переменных может содержать секреты. Предупреждение
 * важно при install, но полезно и в status: иначе диагностика смотрит не туда, куда job.
 */
function warnIgnoredEnv(): void {
  const names = ['ACC_CONFIG', 'ACC_STATE_DIR', 'AHP_PROVIDER_ENV_FILE', 'VSCODE_CLI', 'AHP_USE_BUNDLED_SDK', 'ACC_PHONE_ACCESS']
    .filter(name => process.env[name]?.trim());
  if (names.length === 0) return;
  console.warn(`[autostart] launchd не наследует ${names.join(', ')}: job и эта команда используют стандартные hosts.json и .local из WorkingDirectory.`);
}

/** Журнал launchd: обычный файл 0600, symlink отклоняется. */
async function ensureLogFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`${path} — символическая ссылка; журнал launchd не может быть ссылкой.`);
    if (!info.isFile()) throw new Error(`${path} существует, но не является обычным файлом.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try { await handle.chmod(0o600); }
  finally { await handle.close(); }
}

function daemonPorts(config: Awaited<ReturnType<typeof loadConfig>>, hosts: readonly LocalHost[], phone: boolean) {
  return [
    { port: config.listen.port, host: config.listen.host },
    ...hosts.map(host => ({ port: host.port, host: '127.0.0.1' })),
    { port: WEB_PORT, host: '127.0.0.1' },
    ...(phone ? [{ port: PHONE_ACCESS_PORT, host: '127.0.0.1' }] : []),
  ];
}

async function printStandStatus(config: Awaited<ReturnType<typeof loadConfig>>, hosts: readonly LocalHost[]): Promise<void> {
  const backend = formatHostPort(config.listen.host, config.listen.port);
  const [overview, web, instances] = await Promise.all([
    probeBackendOverview({ base: backend, origin: `http://${backend}`, timeoutMs: 2000 }).catch(() => undefined),
    probeWeb(WEB_PORT),
    Promise.all(hosts.map(host => localInstance(host).catch(() => undefined))),
  ]);
  console.log(`  backend  ${overview ? 'отвечает' : 'не отвечает'}  ws://${backend}/ws`);
  console.log(`  web      ${web ? 'отвечает' : 'не отвечает'}  http://127.0.0.1:${WEB_PORT}`);
  hosts.forEach((host, index) => {
    const instance = instances[index];
    console.log(`  ${host.id.padEnd(8)} ${instance ? `pid ${instance.pid}` : 'не запущен'}  ws://127.0.0.1:${host.port}`);
  });
}

async function printLogTail(path: string): Promise<void> {
  const tail = await readLogTail({ hostId: 'up', fileName: '.local/up.log', path, startCommand: 'npm run autostart:install' });
  console.log(`  ${tail.fileName}:`);
  if (tail.status !== 'ok') {
    console.log(`    ${tail.message}`);
    return;
  }
  for (const line of tail.lines.slice(-20)) console.log(`    ${line}`);
}

async function main(): Promise<number> {
  process.chdir(projectRoot);
  const args = parseArgs(process.argv.slice(2));
  if ('error' in args) {
    console.error(`[autostart] ${args.error}`);
    if (args.error !== USAGE) console.error(USAGE);
    return 1;
  }
  if (process.platform !== 'darwin') {
    console.error('[autostart] Автозапуск реализован только для macOS (launchd).');
    return 1;
  }

  // launchd не наследует окружение shell, поэтому autostart смотрит ровно туда же,
  // куда смотрит job: hosts.json и .local из WorkingDirectory.
  const config = await loadConfig('hosts.json');
  const hosts = localHosts(config.hosts);
  const stateDir = '.local';
  warnIgnoredEnv();
  const logPath = resolve(projectRoot, `${stateDir}/up.log`);
  const agentsDir = resolve(homedir(), 'Library/LaunchAgents');
  const plistPath = resolve(agentsDir, `${AUTOSTART_LABEL}.plist`);
  const deps = defaultLaunchdDeps({ uid: typeof process.getuid === 'function' ? process.getuid() : 0 });

  if (args.command === 'status') {
    const content = await readFile(plistPath, 'utf8').catch(() => undefined);
    const keepAwake = content?.includes('--keep-awake') ?? false;
    const status = await launchdStatus({ plistPath, deps, spec: spec(keepAwake) });
    console.log(`[autostart] plist: ${plistPath} — ${status.plistExists ? (status.ours ? 'наш' : 'чужой (без маркера)') : 'нет'}`);
    if (status.lint) console.log(`  plutil: ${status.lint.ok ? 'ok' : `ошибка: ${status.lint.message}`}`);
    console.log(`  job ${AUTOSTART_LABEL}: ${status.job.loaded ? `загружен, state=${status.job.state ?? '?'}${status.job.pid ? `, pid ${status.job.pid}` : ''}${status.job.lastExitCode !== undefined ? `, last exit ${status.job.lastExitCode}` : ''}` : 'не загружен'}`);
    if (content !== undefined) {
      console.log(`  keep-awake: ${keepAwake ? 'включён' : 'выключен'}`);
      if (status.ours && status.matchesSpec === false) {
        console.log('[autostart] plist отличается от текущей сборки: другой путь node (обновление/nvm), WorkingDirectory или флаги.');
        console.log(`[autostart] Переустановите: npm run autostart:install${keepAwake ? ' --keep-awake' : ''}${status.job.loaded ? ' --force (перезапустит up и прервёт активные ходы)' : ''}.`);
      }
      const size = await stat(logPath).then(info => info.size, () => undefined);
      console.log(`  журнал: ${logPath}${size === undefined ? ' (нет файла)' : `, ${size} байт`}`);
    }
    await printStandStatus(config, hosts);
    if (status.job.loaded && status.job.state !== 'running') {
      console.log(`[autostart] Job загружен, но не работает. Поднять без прерывания активных ходов: launchctl kickstart gui/${deps.uid}/${AUTOSTART_LABEL}`);
      console.log('[autostart] Последние строки журнала:');
      await printLogTail(logPath);
    }
    return 0;
  }

  if (!await exists(resolve(projectRoot, 'node_modules/tsx/package.json'))) {
    console.error('[autostart] Не найден node_modules/tsx: выполните npm install.');
    return 1;
  }
  if (!await exists(resolve(projectRoot, 'scripts/up.ts'))) {
    console.error('[autostart] Не найден scripts/up.ts: команда запущена не из рабочей копии проекта.');
    return 1;
  }
  await mkdir(resolve(projectRoot, stateDir), { recursive: true, mode: 0o700 });
  await ensureLogFile(logPath);

  if (args.command === 'install') {
    await mkdir(agentsDir, { recursive: true });
    const result = await installLaunchdJob({ spec: spec(args.keepAwake), plistPath, force: args.force, deps });
    for (const message of result.messages) console.log(`[autostart] ${message}`);
    if (result.refused) return 1;
    if (!result.running) {
      const backend = formatHostPort(config.listen.host, config.listen.port);
      const [overview, instances] = await Promise.all([
        probeBackendOverview({ base: backend, origin: `http://${backend}`, timeoutMs: 2000 }).catch(() => undefined),
        Promise.all(hosts.map(host => localInstance(host).catch(() => undefined))),
      ]);
      if (overview || instances.some(Boolean)) {
        console.log('[autostart] Похоже, стенд уже поднят вручную. Остановите ручной up (Ctrl+C), затем:');
        console.log(`  launchctl kickstart gui/${deps.uid}/${AUTOSTART_LABEL}`);
      } else {
        console.log(`[autostart] Проверьте состояние: npm run autostart:status; журнал: ${logPath}`);
      }
    }
    return 0;
  }

  const phone = await exists(resolve(stateDir, 'phone-access.json'));
  const result = await uninstallLaunchdJob({
    plistPath, force: args.force, deps,
    ports: daemonPorts(config, hosts, phone),
    portFree,
    isAlive: pid => {
      try { process.kill(pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
    },
  });
  for (const message of result.messages) console.log(`[autostart] ${message}`);
  return 0;
}

main().then(code => { process.exitCode = code; }, error => {
  console.error(`[autostart] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
