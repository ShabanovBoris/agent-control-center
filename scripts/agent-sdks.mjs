import { access, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const agentPackages = {
  codex: '@openai/codex',
  claude: '@anthropic-ai/claude-agent-sdk',
};
export const sdkEntries = { codex: 'bin/codex.js', claude: 'sdk.mjs' };
export const platform = `${process.platform}-${process.arch}`;
export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const managedCache = resolve(projectRoot, '.local/agent-sdks');
export const stableVersion = /^\d+\.\d+\.\d+$/;
export const defaultServerData = resolve(projectRoot, '.local/host-data');

/** @param {string} a @param {string} b */
export function compareVersions(a, b) {
  return a.localeCompare(b, 'en', { numeric: true });
}

/** @param {string} dir */
async function versionsIn(dir) {
  try { return (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return [];
    throw error;
  }
}

/** @param {keyof typeof agentPackages} agent @param {string} serverData */
export async function resolveAgentSdk(agent, serverData) {
  const bundled = resolve(serverData, 'data/agent-host/sdk-cache', agent);
  const managed = resolve(managedCache, agent);
  const caches = process.env.AHP_USE_BUNDLED_SDK === '1' ? [bundled] : [managed, bundled];
  const candidates = (await Promise.all(caches.map(async cache => {
    const versions = await versionsIn(cache);
    return versions.filter(version => stableVersion.test(version) || cache === bundled).map(version => ({
      version, root: resolve(cache, version, platform),
    }));
  }))).flat();
  for (const { root } of candidates.sort((a, b) => compareVersions(b.version, a.version))) {
    try {
      await access(resolve(root, 'node_modules', agentPackages[agent], sdkEntries[agent]));
      return root;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = await resolveAgentSdk('codex', process.argv[2] ?? defaultServerData);
  if (root) console.log(root);
}
