import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerArgs, providerCatalog } from '../scripts/start-gemini-host.js';

test('каталог включает все семейства и модели без инструментов, выбранная модель первая', () => {
  const result = providerCatalog({ data: [
    { id: 'gpt-test', supports_tools: true, supports_reasoning: true },
    { id: 'gemini-pro', supports_tools: true },
    { id: 'gemini-flash', display_name: 'Gemini Flash', supports_tools: true, supports_reasoning: true, context_window: 1048576, input_modalities: ['text', 'image'] },
    { id: 'gemini-chat', supports_tools: false },
    { id: 'claude-test' },
    { display_name: 'Некорректная запись' },
    { id: '' },
  ] }, 'gemini-flash');
  assert.deepEqual(result.models.map(model => model.slug), ['gemini-flash', 'gpt-test', 'gemini-pro', 'gemini-chat', 'claude-test']);
  assert.equal(result.models[0]?.context_window, 1048576);
  assert.equal(result.models[0]?.display_name, 'Gemini Flash');
  assert.deepEqual(result.models[0]?.input_modalities, ['text', 'image']);
  assert.equal(result.models[0]?.use_responses_lite, false);
  assert.equal(result.models[0]?.tool_mode, 'direct');
  assert.deepEqual(result.models[0]?.supported_reasoning_levels.map(level => level.effort), ['low', 'medium', 'high']);
  assert.equal(result.models[0]?.default_reasoning_level, 'medium');
  assert.deepEqual(result.models[1]?.supported_reasoning_levels, []);
  assert.equal(result.models[1]?.default_reasoning_level, undefined);
});

test('модель по умолчанию выбирается из каталога с сохранением настроек Gemini', () => {
  const models = { data: [
    { id: 'gpt-test' }, { id: 'gemini-3.8-flash' }, { id: 'claude-test' },
  ] };
  assert.equal(providerCatalog(models).models[0]?.slug, 'gemini-3.8-flash');
  assert.equal(providerCatalog(models, 'claude-test').models[0]?.slug, 'claude-test');
  assert.equal(providerCatalog({ data: [{ id: 'gpt-test' }, { id: 'claude-test' }] }).models[0]?.slug, 'gpt-test');
});

test('некорректный, пустой каталог и отсутствие настроенной модели дают явную ошибку', () => {
  assert.throws(() => providerCatalog({ error: 'unauthorized' }), /нет массива data/);
  assert.throws(() => providerCatalog({ data: [] }), /не содержит моделей/);
  assert.throws(() => providerCatalog({ data: [{ id: 'gpt-test' }] }, 'gemini-flash'), /отсутствует в каталоге/);
});

test('отдельному хосту передаются настройки CheapVibeCode и ключ без ChatGPT auth', () => {
  const args = providerArgs('https://vendor.example/v1', '/tmp/gemini models.json', 'claude-test');
  assert.ok(args.includes('model="claude-test"'));
  assert.ok(args.includes('model_catalog_json="/tmp/gemini models.json"'));
  assert.ok(args.includes('model_providers.cheapvibecode.env_key="AHP_CHEAPVIBECODE_API_KEY"'));
  assert.ok(args.includes('model_providers.cheapvibecode.wire_api="responses"'));
  assert.ok(args.includes('model_providers.cheapvibecode.requires_openai_auth=false'));
});
