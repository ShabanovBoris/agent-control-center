import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TerminalContentPart } from '@microsoft/agent-host-protocol';
import { contentBytes, trimTerminalContent } from './terminal-content.js';

const plain = (value: string): TerminalContentPart => ({ type: 'unclassified', value });

test('хвост вывода сохраняется, а старые части отбрасываются целиком', () => {
  const content = [plain('a'.repeat(100)), plain('b'.repeat(100)), plain('c'.repeat(100))];
  const trimmed = trimTerminalContent(content, 150);
  assert.equal(contentBytes(trimmed), 150);
  assert.deepEqual(trimmed, [plain('b'.repeat(50)), plain('c'.repeat(100))]);
});

test('бюджет внутри части режется по границе символа UTF-8', () => {
  // «привет» — 12 байт; в 7 байт влезают три последних символа (6 байт), четвёртый уже нет.
  const trimmed = trimTerminalContent([plain('привет')], 7);
  assert.equal(contentBytes(trimmed), 6);
  assert.deepEqual(trimmed, [plain('вет')]);
});

test('части команды обрезаются по output, а метаданные команды сохраняются', () => {
  const command: TerminalContentPart = {
    type: 'command', commandId: 'c1', commandLine: 'ls', output: 'x'.repeat(10), timestamp: 1, isComplete: false,
  };
  const [trimmed] = trimTerminalContent([command], 4);
  assert.deepEqual(trimmed, { ...command, output: 'xxxx' });
});

test('вывод меньше бюджета возвращается без изменений по смыслу', () => {
  const content = [plain('hello')];
  assert.deepEqual(trimTerminalContent(content, 100), content);
});
