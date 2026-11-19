import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionType, ResponsePartKind, ToolCallStatus } from '@microsoft/agent-host-protocol';
import { actionFor } from './ahp.mjs';

const turnId = 'turn';
const toolCallId = 'tool';
const requestId = 'request';
const pending = ToolCallStatus.PendingConfirmation;
const tool = {
  op: 'tool', turnId, toolCallId, status: pending, approved: true, optionId: 'allow-once',
};
const input = { op: 'input', turnId, requestId };
const chat = { activeTurn: { id: turnId, responseParts: [
  { kind: ResponsePartKind.ToolCall, toolCall: { toolCallId, status: pending, options: [{ id: 'allow-once', kind: 'approve' }] } },
  { kind: ResponsePartKind.InputRequest, request: { id: requestId, questions: [
    { id: 'include', kind: 'boolean', required: true }, { id: 'count', kind: 'integer', required: true },
    { id: 'mode', kind: 'single-select', options: [{ id: 'manual' }] },
  ] } },
] } };

test('сообщение запускает новый ход, пока чат свободен', () => {
  const command = { op: 'send', text: ' Проверка ' };
  assert.equal(actionFor(command, {}).type, ActionType.ChatTurnStarted);
  assert.equal(actionFor(command, {}).message.text, 'Проверка');
  assert.throws(() => actionFor(command, chat), error => error.status === 409);
});

test('подтверждение содержит точный вариант, а старые и чужие запросы отклоняются', () => {
  assert.deepEqual(actionFor(tool, chat), {
    type: ActionType.ChatToolCallConfirmed, turnId, toolCallId, approved: true, confirmed: 'user-action', selectedOptionId: 'allow-once',
  });
  assert.throws(() => actionFor({ ...tool, turnId: 'other' }, chat), error => error.status === 409);
  assert.throws(() => actionFor({ ...tool, approved: false }, chat), error => error.status === 400);
  assert.throws(() => actionFor({ ...tool, status: ToolCallStatus.PendingResultConfirmation }, chat), error => error.status === 409);
});

test('ответ сохраняет false и 0, не пересылает посторонние поля и поддерживает отмену', () => {
  const answer = actionFor({ ...input, response: 'accept', answers: { include: false, count: 0, other: 'ignore' } }, chat);
  assert.deepEqual(answer.answers, {
    include: { state: 'submitted', value: { kind: 'boolean', value: false } },
    count: { state: 'submitted', value: { kind: 'number', value: 0 } },
  });
  assert.throws(() => actionFor({ ...input, response: 'accept', answers: { include: true, count: 0.5 } }, chat), error => error.status === 400);
  assert.deepEqual(actionFor({ ...input, response: 'cancel' }, chat), { type: ActionType.ChatInputCompleted, requestId, response: 'cancel' });
});

test('можно отклонить результат инструмента и остановить именно открытый ход', () => {
  const status = ToolCallStatus.PendingResultConfirmation;
  const waitingForResult = { activeTurn: { id: turnId, responseParts: [{ kind: ResponsePartKind.ToolCall, toolCall: { toolCallId, status } }] } };
  assert.deepEqual(actionFor({ ...tool, status, approved: false }, waitingForResult), {
    type: ActionType.ChatToolCallResultConfirmed, turnId, toolCallId, approved: false,
  });
  assert.deepEqual(actionFor({ op: 'stop', turnId }, chat, 123), { type: ActionType.ChatTurnCancelled, turnId, duration: 123 });
});
