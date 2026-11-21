import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResponsePartKind, TurnState } from '@microsoft/agent-host-protocol';
import { copyableResponseText } from './copy-response.js';

test('копирует только последний непустой Markdown-блок, сохраняя его разметку и переносы строк', () => {
  const finalResponse = '**Итог**\n\nТолько финальная реплика.\n';
  const responseParts = [
    { kind: ResponsePartKind.Markdown, content: 'Ранний текст' },
    { kind: ResponsePartKind.ToolCall },
    { kind: ResponsePartKind.Markdown, content: finalResponse },
    { kind: ResponsePartKind.Markdown, content: ' \n\t ' },
  ];

  assert.equal(copyableResponseText(TurnState.Complete, responseParts), finalResponse);
});

test('не предлагает текст для хода без непустого Markdown-ответа или для незавершённого хода', () => {
  assert.equal(copyableResponseText(TurnState.Complete, []), undefined);
  assert.equal(copyableResponseText(TurnState.Complete, [
    { kind: ResponsePartKind.Markdown, content: ' \n\t ' },
    { kind: ResponsePartKind.ToolCall },
  ]), undefined);
  assert.equal(copyableResponseText(undefined, [
    { kind: ResponsePartKind.Markdown, content: 'Пока генерируется' },
  ]), undefined);
  assert.equal(copyableResponseText(TurnState.Cancelled, [
    { kind: ResponsePartKind.Markdown, content: 'Остановленный ответ' },
  ]), undefined);
});
