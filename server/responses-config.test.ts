import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerArgs, providerCatalog } from '../scripts/start-responses-host.js';

test('каталог включает все семейства и модели без инструментов, выбранная модель первая', () => {
  const result = providerCatalog({ data: [
    { id: 'gpt-test', supports_tools: true, supports_reasoning: true },
    { id: 'gemini-pro', supports_tools: true },
    { id: 'gemini-flash', display_name: 'Gemini Flash', supports_tools: true, supports_reasoning: true, context_window: 1048576, input_modalities: ['text', 'image'] },
    { id: 'gemini-chat', supports_tools: false },
    { id: 'claude-test' },
    { display_name: 'Некорректная запись' },
    { id: '' },
  ] }, 'wbllm', 'gemini-flash');
  assert.deepEqual(result.models.map(model => model.slug), ['gemini-flash', 'gpt-test', 'gemini-pro', 'gemini-chat', 'claude-test']);
  assert.equal(result.models[0]?.context_window, 1048576);
  assert.equal(result.models[0]?.display_name, 'Gemini Flash');
  assert.deepEqual(result.models[0]?.input_modalities, ['text', 'image']);
  assert.equal(result.models[0]?.use_responses_lite, false);
  assert.equal(result.models[0]?.tool_mode, 'direct');
  assert.deepEqual(result.models[0]?.supported_reasoning_levels?.map(level => level.effort), ['low', 'medium', 'high']);
  assert.equal(result.models[0]?.default_reasoning_level, 'medium');
  assert.deepEqual(result.models[1]?.supported_reasoning_levels, []);
  assert.equal(result.models[1]?.default_reasoning_level, undefined);
});

test('нативный каталог GLM сохраняет свойства моделей Codex и порядок по умолчанию', () => {
  const model = {
    slug: 'glm-5.4', display_name: 'glm-5.4', context_window: 1048576,
    supported_reasoning_levels: [{ effort: 'low', description: 'Light reasoning' }, { effort: 'max', description: 'Deep reasoning' }],
    input_modalities: ['text', 'image'], shell_type: 'shell_command', supports_parallel_tool_calls: true,
  };
  const second = { slug: 'glm-5.3' };
  const payload = { models: [model, second, { slug: '' }, null] };
  assert.deepEqual(providerCatalog(payload, 'glm').models, [model, second]);
  assert.deepEqual(providerCatalog(payload, 'glm', second.slug).models, [second, model]);
  assert.throws(() => providerCatalog({ models: [] }, 'glm'), /не содержит моделей/);
  assert.throws(() => providerCatalog(payload, 'glm', 'missing'), /отсутствует в каталоге/);
});

test('WBLLM coder-medium предлагает только поддерживаемые уровни reasoning', () => {
  const payload = { data: [{ id: 'coder-medium', context_window: 256000 }, { id: 'coder-mini' }] };
  const [medium, mini] = providerCatalog(payload, 'wbllm').models;
  assert.deepEqual(medium?.supported_reasoning_levels?.map(level => level.effort), ['low', 'high']);
  assert.equal(medium?.default_reasoning_level, 'low');
  assert.equal(medium?.context_window, 256000);
  assert.deepEqual(mini?.supported_reasoning_levels, []);
  assert.deepEqual(providerCatalog(payload, 'glm').models[0]?.supported_reasoning_levels, []);
});

test('первая модель каталога выбирается по умолчанию', () => {
  const models = { data: [
    { id: 'gpt-test' }, { id: 'gemini-3.8-flash' }, { id: 'claude-test' },
  ] };
  assert.equal(providerCatalog(models, 'wbllm').models[0]?.slug, 'gpt-test');
  assert.equal(providerCatalog(models, 'wbllm', 'claude-test').models[0]?.slug, 'claude-test');
  assert.equal(providerCatalog({ data: [{ id: 'gpt-test' }, { id: 'claude-test' }] }, 'glm').models[0]?.slug, 'gpt-test');
});

test('некорректный, пустой каталог и отсутствие настроенной модели дают явную ошибку', () => {
  assert.throws(() => providerCatalog({ error: 'unauthorized' }, 'wbllm'), /нет массива data/);
  assert.throws(() => providerCatalog({ data: [] }, 'wbllm'), /не содержит моделей/);
  assert.throws(() => providerCatalog({ data: [{ id: 'gpt-test' }] }, 'wbllm', 'gemini-flash'), /отсутствует в каталоге/);
});

test('обоим хостам передаются отдельные настройки Responses API без ChatGPT auth', () => {
  for (const [id, endpoint, key] of [
    ['wbllm', 'https://llm.wb.ru/api/v1', 'WBLLM_API_KEY'],
    ['glm', 'https://api.z.ai/api/v1', 'GLM_API_KEY'],
  ] as const) {
    const args = providerArgs(id, '/tmp/provider models.json', 'test-model');
    assert.ok(args.includes('model="test-model"'));
    assert.ok(args.includes('model_catalog_json="/tmp/provider models.json"'));
    assert.ok(args.includes(`model_provider="${id}"`));
    assert.ok(args.includes(`model_providers.${id}.base_url="${endpoint}"`));
    assert.ok(args.includes(`model_providers.${id}.env_key="${key}"`));
    assert.ok(args.includes(`model_providers.${id}.wire_api="responses"`));
    assert.ok(args.includes(`model_providers.${id}.requires_openai_auth=false`));
    assert.equal(args.includes('features.multi_agent=false'), id === 'wbllm');
    assert.equal(args.includes('features.multi_agent_v2=false'), id === 'wbllm');
    assert.equal(args.includes('web_search="disabled"'), id === 'wbllm');
  }
});
