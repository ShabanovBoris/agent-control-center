import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatState, ModelSelection } from '@microsoft/agent-host-protocol';
import { composerModelOf, currentModelOf, readPreferredModel, savePreferredModel } from './model.js';

const previous: ModelSelection = { id: 'model-a', config: { thinkingLevel: 'low', contextSize: 872000, providerFlag: true } };

function chat(draft?: ModelSelection, active?: ModelSelection): ChatState {
  return {
    turns: [{ message: { model: previous } }],
    ...(draft ? { draft: { text: '', model: draft } } : {}),
    ...(active ? { activeTurn: { message: { model: active } } } : {}),
  } as ChatState;
}

test('черновик VS Code только с id не теряет reasoning последнего сообщения после reload', () => {
  assert.deepEqual(currentModelOf(chat({ id: previous.id })), previous);
});

test('явный пустой config сбрасывает параметры, а явный уровень имеет приоритет', () => {
  assert.deepEqual(currentModelOf(chat({ id: previous.id, config: {} })), { id: previous.id, config: {} });
  const changed = { id: previous.id, config: { thinkingLevel: 'high' } };
  assert.deepEqual(currentModelOf(chat(changed)), changed);
});

test('уровень предыдущей модели не переносится в черновик с другой моделью', () => {
  assert.deepEqual(currentModelOf(chat({ id: 'model-b' })), { id: 'model-b' });
});

test('активный ход имеет приоритет перед завершённым при восстановлении reasoning', () => {
  const active = { id: previous.id, config: { thinkingLevel: 'high' } };
  assert.deepEqual(currentModelOf(chat({ id: previous.id }, active)), active);
  assert.deepEqual(currentModelOf(chat(undefined, active)), active);
});

test('без черновика берётся последняя модель, а у нового чата модели нет', () => {
  assert.deepEqual(currentModelOf(chat()), previous);
  assert.equal(currentModelOf({ turns: [] }), undefined);
});

const models = [{ id: 'model-a', name: 'A' }, { id: 'model-b', name: 'B' }];

test('сохранённая модель применяется в новом чате, открытый чат учитывает свой выбор', () => {
  assert.equal(composerModelOf({ turns: [] }, models, 'model-a', 'model-b', undefined).model?.id, 'model-b');
  assert.equal(composerModelOf(chat(), models, 'model-b', 'model-b', undefined).model?.id, 'model-a');
  assert.equal(composerModelOf({ turns: [], turnsNextCursor: 'older' }, models, 'model-a', 'model-b', undefined).model?.id, 'model-a');
});

test('исчезнувшая модель и сброс выбора используют объявленную модель по умолчанию', () => {
  const fallback = composerModelOf({ turns: [] }, models, 'model-a', 'unavailable', undefined);
  assert.equal(fallback.choice, '');
  assert.equal(fallback.model?.id, 'model-a');
  assert.equal(composerModelOf(chat(), models, 'model-b', 'model-a', '').model?.id, 'model-b');
});

test('выбор модели хранится по хосту и агенту, возврат к умолчанию удаляет только его', () => {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
  savePreferredModel(storage, 'local', 'codex', 'model-a');
  savePreferredModel(storage, 'local', 'claude', 'model-b');
  savePreferredModel(storage, 'gemini', 'codex', 'model-c');
  assert.equal(readPreferredModel(storage, 'local', 'codex'), 'model-a');
  savePreferredModel(storage, 'local', 'codex', '');
  assert.equal(readPreferredModel(storage, 'local', 'codex'), undefined);
  assert.equal(readPreferredModel(storage, 'local', 'claude'), 'model-b');
  assert.equal(readPreferredModel(storage, 'gemini', 'codex'), 'model-c');
});
