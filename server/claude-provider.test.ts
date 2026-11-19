import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareClaudeSdk, providerOptions } from '../scripts/claude-provider.mjs';

const provider = { AHP_CLAUDE_API_KEY: 'test-panel-key', AHP_CLAUDE_BASE_URL: 'https://vendor.example' };

test('API-настройки закреплены в settings, параметры сессии и отмена сохранены', () => {
  const controller = new AbortController();
  const params = { prompt: 'Task', options: { abortController: controller, resume: 'existing', effort: 'high', settingSources: ['user', 'project', 'local'], settings: { deniedMcpServers: ['blocked'], env: { TRACE_ID: 'keep' } } } };
  const result = providerOptions(params, provider);
  assert.equal(result.prompt, 'Task');
  assert.equal(result.options.abortController, controller);
  assert.equal(result.options.resume, 'existing');
  assert.equal(result.options.effort, 'high');
  assert.deepEqual(result.options.settingSources, params.options.settingSources);
  assert.deepEqual(result.options.settings.deniedMcpServers, ['blocked']);
  assert.deepEqual(result.options.settings.env, { ANTHROPIC_API_KEY: 'test-panel-key', ANTHROPIC_BASE_URL: 'https://vendor.example', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', TRACE_ID: 'keep' });
  assert.deepEqual(params.options.settings.env, { TRACE_ID: 'keep' }, 'исходные параметры SDK не мутируют');
});

test('явный proxy-транспорт хоста не подменяется API-настройками native-режима', () => {
  const result = providerOptions({ options: { settings: { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234', ANTHROPIC_AUTH_TOKEN: 'host-nonce' } } } }, provider);
  assert.equal(result.options.settings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:1234');
  assert.equal(result.options.settings.env.ANTHROPIC_AUTH_TOKEN, 'host-nonce');
});

test('отсутствующие credentials и неожиданный формат настроек не скрываются', () => {
  assert.throws(() => providerOptions({}, {}), /не заданы/);
  assert.throws(() => providerOptions({ options: { settings: 'settings.json' } }, provider), /inline settings/);
});

test('подготовленный SDK делегирует query и startup, остальные экспорты сохраняет, ключи в файлы не пишет', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'acc-claude-sdk-'));
  const oldKey = process.env.AHP_CLAUDE_API_KEY, oldUrl = process.env.AHP_CLAUDE_BASE_URL;
  try {
    const installed = join(folder, 'installed-sdk');
    const original = join(installed, 'node_modules/@anthropic-ai/claude-agent-sdk');
    await mkdir(original, { recursive: true });
    await writeFile(join(original, 'package.json'), JSON.stringify({ version: '0.3.304', type: 'module' }));
    await writeFile(join(original, 'sdk.mjs'), 'export const query = p => p; export const startup = p => p; export const prewarm = p => p; export const listSessions = () => "history-preserved";');
    const root = await prepareClaudeSdk(installed, join(folder, 'shim'));
    assert.ok(root);
    const path = join(root, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
    process.env.AHP_CLAUDE_API_KEY = provider.AHP_CLAUDE_API_KEY;
    process.env.AHP_CLAUDE_BASE_URL = provider.AHP_CLAUDE_BASE_URL;
    const sdk = await import(pathToFileURL(path).href);
    for (const operation of ['query', 'startup', 'prewarm']) assert.equal(sdk[operation]({ options: { resume: 'kept' } }).options.settings.env.ANTHROPIC_API_KEY, provider.AHP_CLAUDE_API_KEY);
    assert.equal(sdk.listSessions(), 'history-preserved');
    assert.equal((await readFile(path, 'utf8')).includes(provider.AHP_CLAUDE_API_KEY), false);
  } finally {
    if (oldKey === undefined) delete process.env.AHP_CLAUDE_API_KEY; else process.env.AHP_CLAUDE_API_KEY = oldKey;
    if (oldUrl === undefined) delete process.env.AHP_CLAUDE_BASE_URL; else process.env.AHP_CLAUDE_BASE_URL = oldUrl;
    await rm(folder, { recursive: true, force: true });
  }
});
