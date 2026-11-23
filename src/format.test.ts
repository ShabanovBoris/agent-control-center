import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionStatus, type ChatInputRequest } from '@microsoft/agent-host-protocol';
import { inputOutcome, isArchived, phaseOf } from './format.js';

test('фаза сессии определяется по битам активности и игнорирует флаги прочтения и архива', () => {
  assert.equal(phaseOf(SessionStatus.Idle), 'idle');
  assert.equal(phaseOf(SessionStatus.Error), 'error');
  assert.equal(phaseOf(SessionStatus.InProgress), 'running');
  assert.equal(phaseOf(SessionStatus.InputNeeded), 'input');
  assert.equal(phaseOf(SessionStatus.Idle | SessionStatus.IsRead | SessionStatus.IsArchived), 'idle');
  assert.equal(phaseOf(SessionStatus.Error | SessionStatus.IsRead | SessionStatus.IsArchived), 'error');
  assert.equal(phaseOf(SessionStatus.InProgress | SessionStatus.IsRead | SessionStatus.IsArchived), 'running');
  assert.equal(phaseOf(SessionStatus.InputNeeded | SessionStatus.IsArchived), 'input');
});

test('архивный флаг проверяется отдельно от фазы', () => {
  assert.equal(isArchived(SessionStatus.Idle), false);
  assert.equal(isArchived(SessionStatus.Idle | SessionStatus.IsRead), false);
  assert.equal(isArchived(SessionStatus.Idle | SessionStatus.IsArchived), true);
});

// Форма запроса снята с настоящего хоста: так Claude задаёт вопрос через AskUserQuestion.
const colorRequest = {
  id: 'toolu_1',
  questions: [{
    id: 'Color',
    kind: 'single-select',
    title: 'Color',
    message: 'Which color do you prefer, red or blue?',
    options: [{ id: 'red-id', label: 'Red' }, { id: 'blue-id', label: 'Blue' }],
  }],
  answers: { Color: { state: 'submitted', value: { kind: 'selected', value: 'blue-id' } } },
} as unknown as ChatInputRequest;

const outcome = (request: unknown, response?: string) => inputOutcome(request as ChatInputRequest, response as never);

test('принятый ответ показывает вопрос и подпись выбранного варианта', () => {
  assert.equal(outcome(colorRequest, 'accept'), 'Color: Blue');
});

test('отклонённый и отменённый запросы не выдаются за ответ', () => {
  assert.equal(outcome(colorRequest, 'decline'), 'отклонён');
  assert.equal(outcome(colorRequest, 'cancel'), 'отменён');
  assert.equal(outcome(colorRequest, undefined), 'закрыт без ответа');
});

test('вопрос без ответа и пропущенный вопрос помечаются явно', () => {
  const request = { ...colorRequest, answers: {} };
  assert.equal(outcome(request, 'accept'), 'Color: без ответа');
  const skipped = { ...colorRequest, answers: { Color: { state: 'skipped' } } };
  assert.equal(outcome(skipped, 'accept'), 'Color: без ответа');
});

test('разные виды ответов приводятся к тексту', () => {
  const request = {
    id: 'r',
    questions: [
      { id: 'name', kind: 'text', message: 'Имя?' },
      { id: 'count', kind: 'integer', message: 'Сколько?' },
      { id: 'ok', kind: 'boolean', message: 'Продолжать?' },
      { id: 'tags', kind: 'multi-select', title: 'Теги', message: 'Какие теги?', options: [{ id: 'a', label: 'Альфа' }, { id: 'b', label: 'Бета' }] },
    ],
    answers: {
      name: { state: 'submitted', value: { kind: 'text', value: 'Борис' } },
      count: { state: 'submitted', value: { kind: 'number', value: 3 } },
      ok: { state: 'submitted', value: { kind: 'boolean', value: false } },
      tags: { state: 'submitted', value: { kind: 'selected-many', value: ['a', 'b'] } },
    },
  };
  assert.equal(outcome(request, 'accept'), 'Имя?: Борис; Сколько?: 3; Продолжать?: нет; Теги: Альфа, Бета');
});

test('запрос без вопросов (только сообщение или ссылка) считается принятым', () => {
  assert.equal(outcome({ id: 'r', message: 'Откройте ссылку' }, 'accept'), 'принят');
});

test('неизвестный идентификатор варианта показывается как есть', () => {
  const request = { ...colorRequest, answers: { Color: { state: 'submitted', value: { kind: 'selected', value: 'green-id' } } } };
  assert.equal(outcome(request, 'accept'), 'Color: green-id');
});
