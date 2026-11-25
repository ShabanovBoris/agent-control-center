import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, writeFile, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { isResponsesProvider, responsesProviders, type ResponsesProviderId } from './responses-providers.js';
import { defaultServerData, resolveAgentSdk } from './agent-sdks.mjs';
import { terminalEnv } from '../server/terminal-env.js';

interface VendorModel {
  id: string;
  display_name?: string;
  supports_tools?: boolean;
  supports_reasoning?: boolean;
  context_window?: number;
  auto_compact_token_limit?: number;
  input_modalities?: string[];
}

interface CodexCatalogModel {
  slug: string;
  display_name?: string;
  supported_reasoning_levels?: { effort: string; description: string }[];
  default_reasoning_level?: string;
  context_window?: number;
  input_modalities?: string[];
  [field: string]: unknown;
}

export function providerCatalog(payload: unknown, providerId: ResponsesProviderId, requestedModel?: string): { models: CodexCatalogModel[] } {
  const nativeModels = (payload as { models?: unknown } | null)?.models;
  if (Array.isArray(nativeModels)) {
    // GLM публикует готовый каталог Codex, включая возможности каждой модели.
    const models = nativeModels.filter((row): row is CodexCatalogModel =>
      row !== null && typeof row === 'object' && typeof row.slug === 'string' && row.slug.length > 0);
    if (models.length === 0) throw new Error('API провайдера: каталог /models не содержит моделей');
    if (requestedModel !== undefined && !models.some(model => model.slug === requestedModel)) {
      throw new Error(`Модель ${requestedModel} отсутствует в каталоге провайдера`);
    }
    const defaultModel = requestedModel ?? models[0]!.slug;
    models.sort((a, b) => Number(b.slug === defaultModel) - Number(a.slug === defaultModel));
    return { models };
  }
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error('API провайдера: в ответе /models нет массива data');
  const models = data.filter((row): row is VendorModel =>
    row !== null && typeof row === 'object' && typeof row.id === 'string' && row.id.length > 0);
  if (models.length === 0) throw new Error('API провайдера: каталог /models не содержит моделей');
  if (requestedModel !== undefined && !models.some(model => model.id === requestedModel)) {
    throw new Error(`Модель ${requestedModel} отсутствует в каталоге провайдера`);
  }
  const defaultModel = requestedModel ?? models[0]!.id;
  // Хост выбирает первый элемент каталога, если у новой сессии ещё нет модели.
  models.sort((a, b) => Number(b.id === defaultModel) - Number(a.id === defaultModel));
  return {
    models: models.map((model, index) => {
      // WBLLM принимает low и high для coder-medium. Остальные уровни API отклоняет.
      const isWbllmCoderMedium = providerId === 'wbllm' && model.id === 'coder-medium';
      const isReasoningGemini = model.id.startsWith('gemini-') && model.supports_reasoning === true;
      const efforts = isWbllmCoderMedium ? ['low', 'high'] : isReasoningGemini ? ['low', 'medium', 'high'] : [];
      return {
        slug: model.id,
        display_name: model.display_name ?? model.id,
        description: `${responsesProviders[providerId].name} · Codex`,
        supported_reasoning_levels: efforts.map(effort => ({ effort, description: '' })),
        ...(isWbllmCoderMedium ? { default_reasoning_level: 'low' } : isReasoningGemini ? { default_reasoning_level: 'medium' } : {}),
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
      };
    }),
  };
}

export function providerArgs(providerId: ResponsesProviderId, catalogPath: string, model: string) {
  const provider = responsesProviders[providerId];
  const prefix = `model_providers.${providerId}`;
  const config = {
    model_provider: providerId,
    model,
    model_catalog_json: catalogPath,
    [`${prefix}.name`]: provider.name,
    [`${prefix}.base_url`]: provider.endpoint,
    [`${prefix}.env_key`]: provider.envKey,
    [`${prefix}.wire_api`]: 'responses',
    [`${prefix}.requires_openai_auth`]: false,
    // WBLLM не десериализует инструменты namespace и web_search.
    ...(providerId === 'wbllm' ? {
      'features.multi_agent': false,
      'features.multi_agent_v2': false,
      web_search: 'disabled',
    } : {}),
  };
  return Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
}

/** Журнал обёртки при `--log`; используется и в обработчике ошибок после main. */
let wrapperLog: FileHandle | undefined;

async function say(line: string): Promise<void> {
  if (wrapperLog) await wrapperLog.write(`${line}\n`);
  else console.log(line);
}

async function main() {
  process.chdir(fileURLToPath(new URL('../', import.meta.url)));
  const providerId = process.argv[2] ?? '';
  if (!isResponsesProvider(providerId)) throw new Error('Укажите провайдера wbllm или glm');
  const provider = responsesProviders[providerId];
  // Обёртка тоже пишет в журнал: у принятого хоста не должно оставаться
  // stdout/stderr, ведущих в pipe умершего `up`.
  if (process.argv[3] === '--log') {
    // В свежем checkout `.local` может отсутствовать: открытие журнала не должно
    // падать раньше проверки провайдера и давать непонятный ENOENT.
    await mkdir('.local', { recursive: true });
    wrapperLog = await open(`.local/${providerId}-host.log`, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  } else {
    wrapperLog = undefined;
  }
  await wrapperLog?.chmod(0o600);
  const file = process.env.AHP_PROVIDER_ENV_FILE ?? '.local/model-provider.env';
  const fileEnv: NodeJS.Dict<string> = await readFile(file, 'utf8').then(parseEnv, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  });
  const apiKey = process.env[provider.envKey] || fileEnv[provider.envKey];
  if (!apiKey?.trim()) throw new Error(`Укажите ${provider.envKey} в окружении или в ${file}`);
  const response = await fetch(`${provider.endpoint}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`API провайдера: GET /models вернул HTTP ${response.status}`);
  const catalog = providerCatalog(await response.json(), providerId);
  const model = catalog.models[0]!.slug;
  const catalogPath = resolve(`.local/${providerId}-models.json`);
  const tokenPath = resolve(`.local/${providerId}-host-token`);
  const codexHome = resolve(`.local/${providerId}-codex`);
  await mkdir(codexHome, { recursive: true });
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  try { await writeFile(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }

  const sdkRoot = process.env.VSCODE_AGENT_HOST_CODEX_SDK_ROOT
    || await resolveAgentSdk('codex', process.env.AHP_SERVER_DATA_DIR ?? defaultServerData);
  // PTY терминалов наследует env процесса хоста, поэтому чистим его только для дочернего
  // `code agent host`: сам wrapper по-прежнему видит ключи провайдера и свой журнал.
  const env = terminalEnv(process.env, {
    // Отдельное хранилище Codex: основной вход ChatGPT и его сессии сюда не попадают.
    CODEX_HOME: codexHome,
    [provider.envKey]: apiKey,
    VSCODE_AGENT_HOST_CLAUDE_AGENT_ENABLED: 'false',
    VSCODE_AGENT_HOST_CODEX_AGENT_ENABLED: 'true',
    VSCODE_AGENT_HOST_CODEX_APP_SERVER_ARGS: JSON.stringify(providerArgs(providerId, catalogPath, model)),
    ...(sdkRoot ? { VSCODE_AGENT_HOST_CODEX_SDK_ROOT: sdkRoot } : {}),
  });
  const cli = process.env.VSCODE_CLI ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
  const port = process.env.RESPONSES_AHP_PORT ?? String(provider.port);
  await say(`[${providerId}] ${new URL(provider.endpoint).host}: ${catalog.models.length} моделей, по умолчанию ${model}`);
  const log = wrapperLog;
  try {
    const child = spawn(cli, [
      'agent', 'host', '--host', '127.0.0.1', '--port', port,
      '--connection-token-file', tokenPath,
      '--server-data-dir', resolve(`.local/${providerId}-host-data`),
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
    if (wrapperLog === log) wrapperLog = undefined;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(async error => {
    const line = `[${process.argv[2] ?? 'responses'}] ${error instanceof Error ? error.message : String(error)}`;
    if (wrapperLog) {
      await wrapperLog.write(`${line}\n`).catch(() => undefined);
      await wrapperLog.close().catch(() => undefined);
      wrapperLog = undefined;
    } else {
      console.error(line);
    }
    process.exitCode = 1;
  });
}
