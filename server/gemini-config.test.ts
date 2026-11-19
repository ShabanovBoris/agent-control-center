import assert from 'node:assert/strict';
import { test } from 'node:test';
import { geminiArgs, geminiCatalog } from '../scripts/start-gemini-host.js';

test('Gemini-каталог исключает другие семейства и ставит выбранную модель первой', () => {
  const result = geminiCatalog({ data: [
    { id: 'gpt-test', supports_tools: true },
    { id: 'gemini-pro', supports_tools: true },
    { id: 'gemini-flash', display_name: 'Gemini Flash', supports_tools: true, supports_reasoning: true, context_window: 1048576, input_modalities: ['text', 'image'] },
    { id: 'gemini-chat', supports_tools: false },
  ] }, 'gemini-flash');
  assert.deepEqual(result.models.map(model => model.slug), ['gemini-flash', 'gemini-pro']);
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

test('некорректный каталог и отсутствие выбранной Gemini дают явную ошибку', () => {
  assert.throws(() => geminiCatalog({ error: 'unauthorized' }, 'gemini-flash'), /нет массива data/);
  assert.throws(() => geminiCatalog({ data: [] }, 'gemini-flash'), /отсутствует/);
});

test('отдельному хосту передаются Gemini-провайдер и имя переменной ключа, а не ChatGPT auth', () => {
  const args = geminiArgs('https://vendor.example/v1', '/tmp/gemini models.json', 'gemini-flash');
  assert.ok(args.includes('model="gemini-flash"'));
  assert.ok(args.includes('model_catalog_json="/tmp/gemini models.json"'));
  assert.ok(args.includes('model_providers.cheapvibecode.env_key="AHP_GEMINI_API_KEY"'));
  assert.ok(args.includes('model_providers.cheapvibecode.requires_openai_auth=false'));
});
