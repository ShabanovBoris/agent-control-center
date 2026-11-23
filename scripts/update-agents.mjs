import { execFile } from 'node:child_process';
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { agentPackages, compareVersions, managedCache, platform, projectRoot, sdkEntries, stableVersion } from './agent-sdks.mjs';

const run = promisify(execFile);
const npmCli = process.env.npm_execpath;
const npmSettings = [
  '--registry=https://registry.npmjs.org/', `--cache=${resolve(managedCache, '.npm-cache')}`,
  '--ignore-scripts', '--no-audit', '--no-fund',
  '--fetch-retries=1', '--fetch-timeout=25000',
];
const ahpPackage = '@microsoft/agent-host-protocol';

/** @typedef {keyof typeof agentPackages | 'ahp'} UpdateComponent */
/** @typedef {Partial<Record<UpdateComponent, string>>} UpdateVersions */

/** @param {string[]} args @param {string} [cwd] */
async function npm(args, cwd = projectRoot) {
  const command = npmCli ? process.execPath : 'npm';
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  const { stdout } = await run(command, [...commandArgs, ...npmSettings], { cwd, timeout: 180000 });
  return stdout;
}

/** @param {string} spec */
async function registryVersion(spec) {
  const value = JSON.parse(await npm(['view', spec, 'version', '--json']));
  /** @type {unknown[]} */
  const versions = Array.isArray(value) ? value : [value];
  return versions.filter(version => typeof version === 'string').filter(version => stableVersion.test(version))
    .sort((a, b) => compareVersions(b, a))[0];
}

export async function installedAhpVersion() {
  const manifest = JSON.parse(await readFile(resolve(projectRoot, 'node_modules', ahpPackage, 'package.json'), 'utf8'));
  return /** @type {string} */ (manifest.version);
}

/** @param {UpdateComponent} component */
export async function latestVersion(component) {
  const spec = component === 'ahp'
    ? `${ahpPackage}@${JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8')).dependencies[ahpPackage]}`
    : `${agentPackages[component]}@latest`;
  const version = await registryVersion(spec);
  if (!version) throw new Error(`npm не вернул стабильную версию ${spec}`);
  return version;
}

/** @param {string} executable @param {string} stage @param {string} version */
async function verifyCodex(executable, stage, version) {
  const { stdout } = await run(process.execPath, [executable, '--version'], { timeout: 15000 });
  if (stdout.trim() !== `codex-cli ${version}`) throw new Error(`неожиданная версия Codex ${stdout.trim()}`);
  const home = await mkdtemp(resolve(stage, '.codex-check-'));
  try {
    const probe = run(process.execPath, [executable, 'app-server'], {
      cwd: home, env: { ...process.env, CODEX_HOME: home }, timeout: 15000,
    });
    probe.child.stdin?.on('error', () => {});
    probe.child.stdin?.end(`${JSON.stringify({
      id: 1, method: 'initialize', params: { clientInfo: { name: 'acc_sdk_check', version: '1' } },
    })}\n`);
    const { stdout } = await probe;
    const messages = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (!messages.some(message => message.id === 1 && message.result)) throw new Error('Codex App Server не прошёл initialize');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** @param {keyof typeof agentPackages} agent @param {string} version */
async function updateSdk(agent, version) {
  const name = agentPackages[agent];
  const release = resolve(managedCache, agent, version);
  const destination = resolve(release, platform);
  const entry = join('node_modules', name, sdkEntries[agent]);
  try {
    await access(resolve(destination, entry));
    console.log(`[${agent}] ${version} уже подготовлен`);
    return;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
  }

  await mkdir(release, { recursive: true });
  const stage = await mkdtemp(resolve(release, '.pending-'));
  try {
    await npm(['install', '--prefix', stage, '--include=optional', '--no-save', '--no-package-lock', `${name}@${version}`]);
    if (agent === 'codex') {
      await verifyCodex(resolve(stage, entry), stage, version);
    } else {
      const sdk = await import(pathToFileURL(resolve(stage, entry)).href);
      for (const method of ['query', 'startup', 'prewarm', 'listSessions', 'getSessionMessages', 'forkSession', 'renameSession']) {
        if (typeof sdk[method] !== 'function') throw new Error(`отсутствует экспорт Claude SDK ${method}`);
      }
      const native = process.platform === 'win32' ? 'claude.exe' : 'claude';
      await run(resolve(stage, 'node_modules', `${name}-${platform}`, native), ['--version'], { cwd: stage, timeout: 15000 });
    }
    try { await rename(stage, destination); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? '')) throw error;
      await access(resolve(destination, entry));
    }
    console.log(`[${agent}] ${version} подготовлен к следующему запуску хоста`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** @param {string} version */
async function updateAhpClient(version) {
  const manifestPath = resolve(projectRoot, 'package.json');
  const lockfilePath = resolve(projectRoot, 'package-lock.json');
  const [manifest, lockfile] = await Promise.all([readFile(manifestPath, 'utf8'), readFile(lockfilePath, 'utf8')]);
  const range = JSON.parse(manifest).dependencies[ahpPackage];
  const current = JSON.parse(lockfile).packages[`node_modules/${ahpPackage}`].version;
  if (compareVersions(version, current) <= 0) {
    console.log(`[ahp] ${current} — последняя совместимая версия (${range})`);
    return;
  }

  await mkdir(managedCache, { recursive: true });
  const stage = await mkdtemp(resolve(managedCache, '.ahp-'));
  const install = ['install', '--save', '--save-prefix=^', `${ahpPackage}@${version}`];
  try {
    await Promise.all([
      writeFile(resolve(stage, 'package.json'), manifest),
      writeFile(resolve(stage, 'package-lock.json'), lockfile),
      ...['tsconfig.base.json', 'tsconfig.server.json'].map(file => copyFile(resolve(projectRoot, file), resolve(stage, file))),
      ...['server', 'shared', 'scripts', 'src'].map(dir => cp(resolve(projectRoot, dir), resolve(stage, dir), { recursive: true })),
    ]);
    await npm(install, stage);
    await run(resolve(stage, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.server.json'], { cwd: stage, timeout: 60000 });
    await run(process.execPath, ['--import', 'tsx', '--test',
      'server/host-actions.test.ts', 'server/hub.test.ts', 'server/mirror.test.ts', 'server/protocol.test.ts',
    ], { cwd: stage, timeout: 60000 });
    if (await readFile(manifestPath, 'utf8') !== manifest || await readFile(lockfilePath, 'utf8') !== lockfile) {
      throw new Error('список зависимостей изменился во время проверки, повторите обновление');
    }
    await npm([...install, '--offline']);
    console.log(`[ahp] клиент ${current} → ${version}`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** @param {UpdateComponent} component @param {string} version */
export async function installVersion(component, version) {
  if (!stableVersion.test(version)) throw new Error('Ожидалась версия стабильного выпуска');
  if (component === 'ahp') {
    await updateAhpClient(version);
  } else {
    await updateSdk(component, version);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  /** @type {UpdateComponent[]} */
  const components = ['codex', 'claude', 'ahp'];
  const results = await Promise.allSettled(components.map(async component => {
    try {
      await installVersion(component, await latestVersion(component));
    } catch (error) {
      console.error(`[${component}] ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }));
  if (results.some(result => result.status === 'rejected')) {
    process.exitCode = 1;
    console.error('[updates] Не все компоненты обновлены. Службы не перезапускались.');
  } else {
    try {
      const restartTimeout = Number(process.env.ACC_RESTART_TIMEOUT_MS ?? 600_000);
      const timeout = Number.isSafeInteger(restartTimeout) && restartTimeout >= 30_000 && restartTimeout <= 1_800_000
        ? restartTimeout + 30_000 : 1_830_000;
      await run(process.execPath, ['--import', 'tsx', 'scripts/restart-services.ts'], { cwd: projectRoot, timeout });
    } catch (error) {
      process.exitCode = 1;
      console.error(`[updates] Пакеты обновлены, но службы не перезапущены: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
