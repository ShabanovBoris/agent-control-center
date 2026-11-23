import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ResponsePartKind,
  ToolCallStatus,
  TurnState,
  type MarkdownResponsePart,
  type ReasoningResponsePart,
  type ResponsePart,
  type ToolCallResponsePart,
} from '@microsoft/agent-host-protocol';
import {
  agentResponseText,
  completedResponseText,
  layoutParts,
  markdownBlocks,
  trimLeadingBlankLines,
} from './markdown-stream.js';

function markdown(content: string, id = `md-${content.length}`): MarkdownResponsePart {
  return { kind: ResponsePartKind.Markdown, id, content };
}

function toolCall(toolCallId = 'tool-1'): ToolCallResponsePart {
  return {
    kind: ResponsePartKind.ToolCall,
    toolCall: { toolCallId, toolName: 'shell', displayName: 'Shell', status: ToolCallStatus.Streaming },
  };
}

function reasoning(content: string): ReasoningResponsePart {
  return { kind: ResponsePartKind.Reasoning, id: 'reasoning-1', content };
}

test('trimLeadingBlankLines срезает только пустые строки в начале, сохраняя отступ', () => {
  assert.equal(trimLeadingBlankLines('\n\n  const x = 1;'), '  const x = 1;');
  assert.equal(trimLeadingBlankLines('  const x = 1;'), '  const x = 1;');
  assert.equal(trimLeadingBlankLines(' \n\t\ncode'), 'code');
  assert.equal(trimLeadingBlankLines('   '), '');
  assert.equal(trimLeadingBlankLines('\r\n\r\ntext'), 'text');
});

test('соседние markdown-части конкатенируются без разделителя, как display text SDK', () => {
  const joined = markdownBlocks([markdown('Полу', 'a'), markdown('жизнь', 'b')]);
  assert.equal(joined.length, 1);
  assert.equal(joined[0]?.content, 'Полужизнь');

  const paragraphs = markdownBlocks([markdown('Первый\n\n', 'a'), markdown('второй', 'b')]);
  assert.equal(paragraphs[0]?.content, 'Первый\n\nвторой');
});

test('пустые строки срезаются только в начале блока, внутренние остаются', () => {
  const blocks = markdownBlocks([markdown('\n\nПервый', 'a'), markdown('\n\nвторой', 'b')]);
  assert.equal(blocks[0]?.content, 'Первый\n\nвторой');
});

test('пустые markdown-части не создают блоков и не разрывают склейку', () => {
  const items = layoutParts([markdown('Начало', 'a'), markdown(' \n\t ', 'empty'), markdown('конец', 'b')]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    kind: 'markdown',
    block: { key: 'markdown:0|a', content: 'Начало \n\t конец' },
  });

  assert.equal(markdownBlocks([markdown('', 'a'), markdown('', 'b')]).length, 0);
});

test('карточка инструмента остаётся жёсткой границей и сохраняет позицию в responseParts', () => {
  const parts: ResponsePart[] = [markdown('До инструмента', 'a'), toolCall(), markdown('После инструмента', 'b')];
  const items = layoutParts(parts);

  assert.equal(items.length, 3);
  assert.equal(items[0]?.kind, 'markdown');
  assert.equal(items[1]?.kind, 'part');
  assert.equal(items[1]?.kind === 'part' && items[1].index, 1);
  assert.equal(items[1]?.kind === 'part' && items[1].part.kind, ResponsePartKind.ToolCall);
  assert.equal(items[2]?.kind === 'markdown' && items[2].block.content, 'После инструмента');
});

test('reasoning между markdown-частями тоже граница', () => {
  const blocks = markdownBlocks([markdown('До', 'a'), reasoning('думаю'), markdown('После', 'b')]);
  assert.deepEqual(blocks.map(block => block.content), ['До', 'После']);
});

test('ход без непустого markdown не создаёт блоков, но сохраняет остальные части', () => {
  const parts: ResponsePart[] = [markdown('', 'a'), toolCall(), markdown('  \n ', 'b')];
  assert.equal(markdownBlocks(parts).length, 0);

  const items = layoutParts(parts);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'part');
});

test('ключ блока не меняется при дописывании в последнюю часть', () => {
  const before = layoutParts([markdown('Полу', 'stream-1')]);
  const after = layoutParts([markdown('Полужизнь', 'stream-1')]);

  assert.equal(before[0]?.kind === 'markdown' && before[0].block.key, 'markdown:0|stream-1');
  assert.equal(after[0]?.kind === 'markdown' && after[0].block.key, 'markdown:0|stream-1');
  assert.equal(after[0]?.kind === 'markdown' && after[0].block.content, 'Полужизнь');
});

test('agentResponseText возвращает финальную реплику после инструмента', () => {
  const finalResponse = '**Итог**\n\nТолько финальная реплика.\n';
  const parts: ResponsePart[] = [
    markdown('Ранний текст', 'a'),
    toolCall(),
    markdown(finalResponse, 'b'),
    markdown(' \n\t ', 'empty'),
  ];

  assert.equal(agentResponseText(parts), '**Итог**\n\nТолько финальная реплика.');
});

test('agentResponseText не теряет отступ кода и не возвращает пустые ответы', () => {
  assert.equal(agentResponseText([markdown('\n\n    const x = 1;', 'code')]), '    const x = 1;');
  assert.equal(agentResponseText([]), undefined);
  assert.equal(agentResponseText([markdown(' \n\t ', 'empty'), toolCall()]), undefined);
});

test('completedResponseText отдаёт markdown только у завершённого хода', () => {
  const parts: ResponsePart[] = [markdown('**Итог**\n', 'a')];

  assert.equal(completedResponseText(TurnState.Complete, parts), '**Итог**');
  assert.equal(completedResponseText(TurnState.Cancelled, parts), undefined);
  assert.equal(completedResponseText(TurnState.Error, parts), undefined);
  assert.equal(completedResponseText(undefined, parts), undefined);
  assert.equal(completedResponseText(TurnState.Complete, [toolCall()]), undefined);
});
