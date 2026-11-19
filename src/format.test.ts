import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatInputRequest } from '@microsoft/agent-host-protocol';
import { inputOutcome, selectionFromHash } from './format.js';

test('ссылка на сессию восстанавливает обе части адреса', () => {
  assert.deepEqual(selectionFromHash('#a|b'), { hostId: 'a', sessionUri: 'b' });
  assert.deepEqual(selectionFromHash('#host%20id|ahp-session%3A%2Fa%7Cb'), {
    hostId: 'host id',
    sessionUri: 'ahp-session:/a|b',
  });
});

test('ссылка с закодированным разделителем сохраняет адрес сессии и значения с вертикальной чертой', () => {
  assert.deepEqual(selectionFromHash('#local%7Cahp-session%3A%2Fsession'), {
    hostId: 'local',
    sessionUri: 'ahp-session:/session',
  });
  assert.deepEqual(selectionFromHash('#host%7Cdev%7cahp-session%3a%2Fa%7Cb'), {
    hostId: 'host|dev',
    sessionUri: 'ahp-session:/a|b',
  });
  assert.equal(selectionFromHash('#local%7Cahp-session%3A%2F%ZZ'), null);
});

test('пустая, неполная или повреждённая ссылка не выбирает сессию', () => {
  for (const hash of ['', '#', '#host', '#|uri', '#host|', '#host|%E0%A4%A', '#%ZZ|uri']) {
    assert.equal(selectionFromHash(hash), null, hash);
  }
});

test('ссылка восстанавливает вложенный чат вместе с его сессией', () => {
  const expected = { hostId: 'local', sessionUri: 'ahp-session:/session', chatUri: 'ahp-chat:/child' };
  assert.deepEqual(selectionFromHash('#local|ahp-session%3A%2Fsession|ahp-chat%3A%2Fchild'), expected);
  assert.deepEqual(selectionFromHash('#local%7Cahp-session%3A%2Fsession%7Cahp-chat%3A%2Fchild'), expected);
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
