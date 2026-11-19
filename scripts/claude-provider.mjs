import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentPackages, defaultServerData, projectRoot, resolveAgentSdk } from './agent-sdks.mjs';

/** @typedef {{env?: Record<string, string>, [key: string]: unknown}} InlineSettings */
/** @typedef {{settings?: InlineSettings | string, [key: string]: unknown}} SdkOptions */

/**
 * @param {{options?: SdkOptions, [key: string]: unknown}} [params]
 * @param {Record<string, string | undefined>} [environment]
 * @returns {{[key: string]: unknown, options: SdkOptions & {settings: InlineSettings & {env: Record<string, string>}}}}
 */
export function providerOptions(params = {}, environment = process.env) {
  const options = params.options ?? {};
  if (typeof options.settings === 'string') throw new Error('Claude provider: Agent Host должен передавать inline settings');
  const settings = options.settings ?? {};
  const key = environment.AHP_CLAUDE_API_KEY;
  const baseUrl = environment.AHP_CLAUDE_BASE_URL;
  if (!key || !baseUrl) throw new Error('Claude provider: не заданы API_KEY или BASE_URL хоста');
  // Settings.env имеет приоритет над ~/.claude/settings.json; обычный options.env — нет.
  const env = {
    ANTHROPIC_API_KEY: key,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    // Явные настройки транспорта самого хоста (например, локального proxy) сохраняют приоритет.
    ...settings.env,
  };
  return { ...params, options: { ...options, settings: { ...settings, env } } };
}

/** @param {string} sdkRoot @param {string} outputRoot */
export async function prepareClaudeSdk(sdkRoot, outputRoot) {
  const packagePath = `node_modules/${agentPackages.claude}`;
  const originalPackage = resolve(sdkRoot, packagePath);
  const metadata = JSON.parse(await readFile(resolve(originalPackage, 'package.json'), 'utf8'));
  const original = pathToFileURL(resolve(originalPackage, 'sdk.mjs')).href;
  const wrapper = [
    `export * from ${JSON.stringify(original)};`,
    `import * as sdk from ${JSON.stringify(original)};`,
    `import { providerOptions } from ${JSON.stringify(import.meta.url)};`,
    'export const query = params => sdk.query(providerOptions(params));',
    'export const startup = params => sdk.startup(providerOptions(params));',
    'export const prewarm = params => sdk.prewarm(providerOptions(params));',
    '',
  ].join('\n');
  const manifest = `${JSON.stringify({ name: agentPackages.claude, version: metadata.version, type: 'module', main: 'sdk.mjs', exports: './sdk.mjs' }, null, 2)}\n`;
  const hash = createHash('sha256').update(wrapper).update(manifest).digest('hex').slice(0, 16);
  const destination = resolve(outputRoot, hash);
  const entry = resolve(destination, packagePath, 'sdk.mjs');
  try {
    await access(entry);
    return destination;
  }
  catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
  }
  await mkdir(outputRoot, { recursive: true });
  const stage = await mkdtemp(resolve(outputRoot, '.pending-'));
  try {
    const packageDir = resolve(stage, packagePath);
    await mkdir(packageDir, { recursive: true });
    await writeFile(resolve(packageDir, 'package.json'), manifest);
    await writeFile(resolve(packageDir, 'sdk.mjs'), wrapper);
    try { await rename(stage, destination); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? '')) throw error;
      await access(entry);
    }
    return destination;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const sdk = process.env.VSCODE_AGENT_HOST_CLAUDE_SDK_ROOT
      || await resolveAgentSdk('claude', process.argv[2] ?? defaultServerData);
    if (sdk) console.log(await prepareClaudeSdk(sdk, resolve(projectRoot, '.local/claude-sdk')));
    else console.error('start-host: после скачивания Claude SDK в панели перезапустите npm run host, чтобы закрепить настройки API');
  } catch (error) {
    console.error(`start-host: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
