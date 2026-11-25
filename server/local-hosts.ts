import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { agentPackages, defaultServerData, managedCache, platform, projectRoot, stableVersion } from '../scripts/agent-sdks.mjs';
import type { HostEntry } from './config.js';
import { isResponsesProvider, type ResponsesProviderId } from '../scripts/responses-providers.js';
import type { HostBuild } from './host-build.js';

type Agent = keyof typeof agentPackages;
type AgentRoots = Partial<Record<Agent, string>>;

/** Нативный CLI: им пользуются `localInstance` и `npm run up`. */
export const nativeVSCodeCli = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code-tunnel';
/** Bash-обёртка Stable: допускается в `VSCODE_CLI`, потому что запускает тот же `code-tunnel`. */
export const stableVSCodeCli = resolve(dirname(nativeVSCodeCli), 'code');
const claudeShim = resolve(projectRoot, '.local/claude-sdk');
const userData = process.env.VSCODE_PORTABLE
  ? resolve(process.env.VSCODE_PORTABLE, 'user-data')
  : resolve(process.env.VSCODE_APPDATA ?? resolve(homedir(), 'Library/Application Support'), 'Code');
const registryDir = resolve(userData, 'agent-host/local-endpoint/entries');
const readProcess = promisify(execFile);

export interface LocalHost {
  id: 'local' | ResponsesProviderId;
  label: string;
  port: number;
  tokenFile: string;
  serverData: string;
  agents: Agent[];
}

export interface HostInstance {
  id: string;
  pid: number;
  roots: AgentRoots;
  env: NodeJS.ProcessEnv;
}

export function localHosts(entries: HostEntry[]): LocalHost[] {
  if (process.platform !== 'darwin') return [];
  return entries.flatMap(entry => {
    if (!entry.localFilesystem || (entry.id !== 'local' && !isResponsesProvider(entry.id))) return [];
    const main = entry.id === 'local';
    const url = new URL(entry.url);
    const tokenFile = resolve(projectRoot, main ? '.local/host-token' : `.local/${entry.id}-host-token`);
    if (entry.tokenFile !== tokenFile || url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port) return [];
    return [{
      id: entry.id, label: entry.label, port: Number(url.port), tokenFile,
      serverData: main ? resolve(projectRoot, process.env.AHP_SERVER_DATA_DIR ?? defaultServerData) : resolve(projectRoot, `.local/${entry.id}-host-data`),
      agents: ['codex'],
    }];
  });
}

function envValue(command: string, name: string): string | undefined {
  return command.match(new RegExp(`(?:^| )${name}=(.*?)(?= [A-Za-z_][A-Za-z0-9_]*=|$)`))?.[1];
}

function hasArgument(command: string, flag: string, value: string): boolean {
  const argument = ` ${flag} ${value}`;
  const at = command.indexOf(argument);
  return at !== -1 && /^(?:$| --| [A-Za-z_][A-Za-z0-9_]*=)/.test(command.slice(at + argument.length));
}

async function jsonFile(path: string) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export async function localInstance(host: LocalHost): Promise<HostInstance | undefined> {
  const token = await readFile(host.tokenFile, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
  if (!token.trim()) return undefined;
  const files = await readdir(registryDir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  for (const file of files) {
    if (!/^[a-f\d]+\.json$/i.test(file)) continue;
    const entry = await jsonFile(resolve(registryDir, file));
    if (entry?.type !== 'standalone' || entry.quality !== 'stable' || !Number.isSafeInteger(entry.pid) || entry.pid <= 1 ||
        typeof entry.instanceId !== 'string' || entry.connectionToken !== token.trim() || entry.endpoint?.type !== 'tcp' ||
        entry.endpoint.host !== '127.0.0.1' || entry.endpoint.port !== host.port) continue;
    // ps выводит окружение владельца. Из него читаются только пути и флаги запуска.
    let command: string;
    try { command = (await readProcess('/bin/ps', ['eww', '-p', String(entry.pid), '-o', 'command='], { timeout: 5000 })).stdout.trim(); }
    catch { continue; }
    if (!command.startsWith(`${nativeVSCodeCli} `) || !command.includes(' agent host ') ||
        !hasArgument(command, '--server-data-dir', host.serverData) ||
        ![host.tokenFile, relative(projectRoot, host.tokenFile)].some(path => hasArgument(command, '--connection-token-file', path))) continue;
    return {
      id: entry.instanceId, pid: entry.pid,
      roots: {
        codex: envValue(command, 'VSCODE_AGENT_HOST_CODEX_SDK_ROOT'),
        claude: envValue(command, 'VSCODE_AGENT_HOST_CLAUDE_SDK_ROOT'),
      },
      env: {
        AHP_PROVIDER_ENV_FILE: envValue(command, 'AHP_PROVIDER_ENV_FILE'),
        AHP_SERVER_DATA_DIR: envValue(command, 'AHP_SERVER_DATA_DIR'),
        AHP_USE_BUNDLED_SDK: envValue(command, 'AHP_USE_BUNDLED_SDK'),
        CODEX_HOME: envValue(command, 'CODEX_HOME'),
        VSCODE_CLI_DATA_DIR: envValue(command, 'VSCODE_CLI_DATA_DIR'),
      },
    };
  }
}

function inDirectory(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}${sep}`);
}

function customRoot(agent: Agent, root: string | undefined, host: LocalHost, instance: HostInstance): string | undefined {
  if (!root) return undefined;
  const hostCache = resolve(host.serverData, 'data/agent-host/sdk-cache', agent);
  const sharedCache = resolve(instance.env.AHP_SERVER_DATA_DIR ?? defaultServerData, 'data/agent-host/sdk-cache', agent);
  if ([managedCache, hostCache, sharedCache, claudeShim].some(path => inDirectory(root, path))) return undefined;
  return root;
}

export function canUpdateSdk(agent: Agent, host: LocalHost, instance: HostInstance): boolean {
  return instance.env.AHP_USE_BUNDLED_SDK !== '1' && !customRoot(agent, instance.roots[agent], host, instance);
}

async function runningSdkRoots(host: LocalHost, instance: HostInstance, build: HostBuild): Promise<AgentRoots> {
  const cliData = instance.env.VSCODE_CLI_DATA_DIR ?? resolve(homedir(), '.vscode/cli');
  const product = await jsonFile(resolve(cliData, 'servers', `Stable-${build.commit}`, 'server/product.json'));
  const roots: AgentRoots = { ...instance.roots };
  for (const agent of host.agents) {
    if (roots[agent]) continue;
    const pinned = product?.agentSdks?.[agent]?.version;
    if (typeof pinned === 'string' && stableVersion.test(pinned)) {
      const root = resolve(host.serverData, 'data/agent-host/sdk-cache', agent, pinned, platform);
      if (await jsonFile(resolve(root, 'node_modules', agentPackages[agent], 'package.json'))) roots[agent] = root;
    }
  }
  return roots;
}

export async function runningSdks(host: LocalHost, instance: HostInstance, build: HostBuild): Promise<Record<Agent, string | null>> {
  const roots = await runningSdkRoots(host, instance, build);
  const versions: Record<Agent, string | null> = { codex: null, claude: null };
  for (const agent of host.agents) {
    const root = roots[agent];
    const version = root && (await jsonFile(resolve(root, 'node_modules', agentPackages[agent], 'package.json')))?.version;
    if (typeof version === 'string' && stableVersion.test(version)) versions[agent] = version;
  }
  return versions;
}

async function poll(test: () => boolean | Promise<boolean>, timeout: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && !signal?.aborted) {
    if (await test()) return true;
    await delay(250, undefined, { signal }).catch(() => false);
  }
  return false;
}

export function defaultHostInstance(host: LocalHost): HostInstance {
  return {
    id: '', pid: 0, roots: {},
    env: {
      AHP_PROVIDER_ENV_FILE: process.env.AHP_PROVIDER_ENV_FILE,
      AHP_SERVER_DATA_DIR: process.env.AHP_SERVER_DATA_DIR,
      AHP_USE_BUNDLED_SDK: process.env.AHP_USE_BUNDLED_SDK,
      VSCODE_CLI_DATA_DIR: process.env.VSCODE_CLI_DATA_DIR,
    },
  };
}

export async function startLocalHost(host: LocalHost, instance: HostInstance = defaultHostInstance(host)): Promise<ChildProcess> {
  if (await localInstance(host)) throw new Error(`Хост «${host.label}» уже запущен.`);
  const main = host.id === 'local';
  const child = spawn(main ? '/bin/bash' : process.execPath, main
    ? ['scripts/start-host.sh', '--log']
    : ['--import', 'tsx', 'scripts/start-responses-host.ts', host.id, '--log'], {
    cwd: projectRoot, detached: true, stdio: 'ignore',
    env: {
      ...process.env, ...instance.env, VSCODE_CLI: nativeVSCodeCli,
      [main ? 'AHP_PORT' : 'RESPONSES_AHP_PORT']: String(host.port),
      VSCODE_AGENT_HOST_CODEX_SDK_ROOT: customRoot('codex', instance.roots.codex, host, instance),
      VSCODE_AGENT_HOST_CLAUDE_SDK_ROOT: customRoot('claude', instance.roots.claude, host, instance),
    },
  });
  await once(child, 'spawn');
  child.unref();
  return child;
}

async function startHost(host: LocalHost, instance: HostInstance, fallback?: { build: HostBuild; roots: AgentRoots }): Promise<ChildProcess> {
  const main = host.id === 'local';
  const child = spawn(main ? '/bin/bash' : process.execPath, main
    ? ['scripts/start-host.sh', '--log']
    : ['--import', 'tsx', 'scripts/start-responses-host.ts', host.id, '--log'], {
    cwd: projectRoot, detached: true, stdio: 'ignore',
    env: {
      ...process.env, ...instance.env, VSCODE_CLI: nativeVSCodeCli,
      [main ? 'AHP_PORT' : 'RESPONSES_AHP_PORT']: String(host.port),
      VSCODE_AGENT_HOST_CODEX_SDK_ROOT: fallback ? fallback.roots.codex : customRoot('codex', instance.roots.codex, host, instance),
      VSCODE_AGENT_HOST_CLAUDE_SDK_ROOT: fallback ? fallback.roots.claude : customRoot('claude', instance.roots.claude, host, instance),
      VSCODE_CLI_INITIAL_AH_VERSION: fallback?.build.commit,
    },
  });
  await once(child, 'spawn');
  child.unref();
  return child;
}

export async function restartLocalHost(
  host: LocalHost,
  instance: HostInstance,
  build: HostBuild,
  ready: () => boolean,
  beforeStop?: () => Promise<void>,
): Promise<void> {
  const previousRoots = await runningSdkRoots(host, instance, build);
  if ((await localInstance(host))?.id !== instance.id) throw new Error(`Хост «${host.label}» изменился. Проверьте обновления заново.`);
  await beforeStop?.();
  process.kill(instance.pid, 'SIGINT');
  if (!await poll(async () => (await localInstance(host))?.id !== instance.id, 15_000)) {
    throw new Error(`Хост «${host.label}» не завершил работу.`);
  }
  let child: ChildProcess | undefined;
  try {
    if (await localInstance(host)) throw new Error('Порт уже занят другим экземпляром');
    child = await startHost(host, instance);
    if (await poll(() => ready() || child?.exitCode != null || child?.signalCode != null, 180_000) && ready()) return;
  } catch {
    // Если экземпляр завершился до подключения, пробуем запустить прежнюю сборку.
  }
  if ((!child || child.exitCode != null || child.signalCode != null) && !await localInstance(host)) {
    const restored = await startHost(host, instance, { build, roots: previousRoots });
    if (await poll(() => ready() || restored.exitCode != null || restored.signalCode != null, 30_000) && ready()) {
      throw new Error(`Хост «${host.label}» запущен с прежней версией. Проверьте журнал хоста.`);
    }
  }
  throw new Error(`Обновлённый хост «${host.label}» не подключился. Проверьте журнал хоста.`);
}

export async function waitForLocalHost(
  host: LocalHost,
  ready: () => boolean,
  child: ChildProcess,
  signal?: AbortSignal,
): Promise<void> {
  if (await poll(() => ready() || child.exitCode != null || child.signalCode != null, 180_000, signal) && ready()) return;
  if (signal?.aborted) throw signal.reason;
  if (await localInstance(host)) {
    throw new Error(`Хост «${host.label}» запущен, но не подключился к backend. Проверьте его настройки.`);
  }
  throw new Error(`Хост «${host.label}» не запустился. Проверьте .local/${host.id === 'local' ? 'host' : `${host.id}-host`}.log.`);
}