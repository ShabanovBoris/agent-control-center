import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { defaultServerData, resolveAgentSdk } from './agent-sdks.mjs';

interface VendorModel {
  id: string;
  display_name?: string;
  supports_tools?: boolean;
  supports_reasoning?: boolean;
  context_window?: number;
  auto_compact_token_limit?: number;
  input_modalities?: string[];
}

export function geminiCatalog(payload: unknown, defaultModel: string) {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error('API провайдера: в ответе /models нет массива data');
  const models = data.filter((row): row is VendorModel =>
    row !== null && typeof row === 'object' && typeof row.id === 'string' && row.id.startsWith('gemini-') && row.supports_tools === true);
  if (!models.some(model => model.id === defaultModel)) throw new Error(`Gemini ${defaultModel} отсутствует среди моделей с инструментами`);
  // Хост выбирает первый элемент каталога, если у новой сессии ещё нет модели.
  models.sort((a, b) => Number(b.id === defaultModel) - Number(a.id === defaultModel));
  return {
    models: models.map((model, index) => ({
      slug: model.id,
      display_name: model.display_name ?? model.id,
      description: 'Gemini через cheapvibecode; инструменты Codex',
      // Общие уровни Gemini: https://ai.google.dev/gemini-api/docs/thinking
      supported_reasoning_levels: model.supports_reasoning === true
        ? ['low', 'medium', 'high'].map(effort => ({ effort, description: '' })) : [],
      ...(model.supports_reasoning === true ? { default_reasoning_level: 'medium' } : {}),
      shell_type: 'unified_exec',
      visibility: 'list',
      supported_in_api: true,
      priority: index,
      availability_nux: null,
      upgrade: null,
      support_verbosity: false,
      default_verbosity: null,
      // Обычные function tools: шлюз не обязан поддерживать частные протоколы OpenAI.
      apply_patch_tool_type: null,
      tool_mode: 'direct',
      use_responses_lite: false,
      node_repl_disabled: true,
      supports_reasoning_summary_parameter: false,
      include_apps_usage_instructions: false,
      truncation_policy: { mode: 'tokens', limit: 10000 },
      experimental_supported_tools: [],
      input_modalities: model.input_modalities?.filter(value => ['text', 'image', 'audio'].includes(value)) ?? ['text'],
      ...(Number.isSafeInteger(model.context_window) && model.context_window! > 0 ? { context_window: model.context_window } : {}),
      ...(Number.isSafeInteger(model.auto_compact_token_limit) && model.auto_compact_token_limit! > 0
        ? { auto_compact_token_limit: model.auto_compact_token_limit } : {}),
      base_instructions: 'You are a coding assistant. Use the available tools to complete the user task, follow project instructions, and verify your changes. Respect tool approvals. Do not claim that a command ran unless a tool result confirms it.',
    })),
  };
}

export function geminiArgs(baseUrl: string, catalogPath: string, model: string) {
  const config = {
    model_provider: 'cheapvibecode',
    model,
    model_catalog_json: catalogPath,
    'model_providers.cheapvibecode.name': 'Gemini · cheapvibecode',
    'model_providers.cheapvibecode.base_url': baseUrl,
    'model_providers.cheapvibecode.env_key': 'AHP_GEMINI_API_KEY',
    'model_providers.cheapvibecode.wire_api': 'responses',
    'model_providers.cheapvibecode.requires_openai_auth': false,
  };
  return Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
}

async function main() {
  process.chdir(fileURLToPath(new URL('../', import.meta.url)));
  const file = process.env.AHP_PROVIDER_ENV_FILE ?? '.local/model-provider.env';
  const provider = parseEnv(await readFile(file, 'utf8'));
  if (!provider.BASE_URL || !provider.API_KEY) throw new Error(`Укажите BASE_URL и API_KEY в ${file}`);
  const root = provider.BASE_URL.replace(/\/+$/, '').replace(/\/v1$/, '');
  const url = new URL(root);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('BASE_URL должен быть HTTP(S)-адресом без ключей, query и fragment');
  }
  const base = `${root}/v1`;
  const response = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${provider.API_KEY}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`API провайдера: GET /models вернул HTTP ${response.status}`);
  const model = provider.GEMINI_MODEL ?? 'gemini-3.8-flash';
  const catalog = geminiCatalog(await response.json(), model);
  const catalogPath = resolve('.local/gemini-models.json');
  const tokenPath = resolve('.local/gemini-host-token');
  const geminiHome = resolve('.local/gemini-codex');
  await mkdir(geminiHome, { recursive: true });
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  try { await writeFile(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }

  const sdkRoot = process.env.VSCODE_AGENT_HOST_CODEX_SDK_ROOT
    || await resolveAgentSdk('codex', process.env.AHP_SERVER_DATA_DIR ?? defaultServerData);
  const env = {
    ...process.env,
    // Отдельное хранилище Codex: основной вход ChatGPT и его сессии сюда не попадают.
    CODEX_HOME: geminiHome,
    AHP_GEMINI_API_KEY: provider.API_KEY,
    VSCODE_AGENT_HOST_CLAUDE_AGENT_ENABLED: 'false',
    VSCODE_AGENT_HOST_CODEX_AGENT_ENABLED: 'true',
    VSCODE_AGENT_HOST_CODEX_APP_SERVER_ARGS: JSON.stringify(geminiArgs(base, catalogPath, model)),
    ...(sdkRoot ? { VSCODE_AGENT_HOST_CODEX_SDK_ROOT: sdkRoot } : {}),
  };
  const cli = process.env.VSCODE_CLI ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
  const port = process.env.GEMINI_AHP_PORT ?? '8091';
  console.log(`[gemini] ${url.host}: ${catalog.models.length} моделей, по умолчанию ${model}`);
  const log = process.argv[2] === '--log'
    ? await open('.local/gemini-host.log', constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
    : undefined;
  try {
    await log?.chmod(0o600);
    const child = spawn(cli, [
      'agent', 'host', '--host', '127.0.0.1', '--port', port,
      '--connection-token-file', tokenPath,
      '--server-data-dir', resolve('.local/gemini-host-data'),
      '--foreground', '--new-instance',
    ], { env, stdio: log ? ['inherit', log.fd, log.fd] : 'inherit' });
    const onInterrupt = () => child.kill('SIGINT');
    const onTerminate = () => child.kill('SIGTERM');
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
          process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);
          resolve();
        });
      });
    } finally {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    }
  } finally {
    await log?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`[gemini] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
