import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ToolResultContentType,
  type ToolResultSubagentContent,
  type ToolResultTerminalContent,
} from '@microsoft/agent-host-protocol';
import {
  isLongTerminalPreview,
  subagentTarget,
  terminalResultView,
  type TerminalResultView,
} from './tool-results.js';

function terminal(overrides: Partial<Omit<ToolResultTerminalContent, 'type'>> = {}): ToolResultTerminalContent {
  return {
    type: ToolResultContentType.Terminal,
    resource: 'ahp-terminal:/cmd',
    title: 'printf hello',
    ...overrides,
  };
}

function exited(content: ToolResultTerminalContent): Extract<TerminalResultView, { state: 'exited' }> {
  const view = terminalResultView(content);
  if (view.state !== 'exited') assert.fail(`ожидалось exited, получено ${view.state}`);
  return view;
}

function subagent(overrides: Partial<Omit<ToolResultSubagentContent, 'type'>> = {}): ToolResultSubagentContent {
  return {
    type: ToolResultContentType.Subagent,
    resource: 'ahp-chat:/worker',
    title: 'Исследование',
    ...overrides,
  };
}

test('без result терминал остаётся unreported и сохраняет поля', () => {
  const view = terminalResultView(terminal({ isPty: true }));

  assert.deepEqual(view, {
    state: 'unreported',
    resource: 'ahp-terminal:/cmd',
    title: 'printf hello',
    isPty: true,
  });
});

test('result без preview — отдельное состояние missing', () => {
  const view = exited(terminal({ result: { exitCode: 0 } }));

  assert.equal(view.preview.state, 'missing');
  assert.equal(view.failed, false);
  assert.equal(view.truncated, false);
  assert.equal(view.exitCode, 0);
});

test('пустой preview — empty, а не missing', () => {
  const view = exited(terminal({ result: { exitCode: 0, preview: '' } }));

  assert.equal(view.preview.state, 'empty');
});

test('пробельный preview считается выводом и не нормализуется', () => {
  const view = exited(terminal({ result: { exitCode: 0, preview: '   \n' } }));

  assert.equal(view.preview.state, 'present');
  if (view.preview.state !== 'present') return;
  assert.equal(view.preview.text, '   \n');
});

test('ненулевой exit code — ошибка, ноль — успех, отсутствие кода не подменяется нулём', () => {
  assert.equal(exited(terminal({ result: { exitCode: 0 } })).failed, false);
  assert.equal(exited(terminal({ result: { exitCode: 2 } })).failed, true);

  const unreportedCode = exited(terminal({ result: { preview: 'done' } }));
  assert.equal(unreportedCode.failed, false);
  assert.equal(unreportedCode.exitCode, undefined);
});

test('truncated переносится как булево, отсутствие флага — false', () => {
  assert.equal(exited(terminal({ result: { truncated: true } })).truncated, true);
  assert.equal(exited(terminal({ result: {} })).truncated, false);
});

test('isPty сохраняется в любом значении', () => {
  assert.equal(exited(terminal({ isPty: true, result: {} })).isPty, true);
  assert.equal(exited(terminal({ isPty: false, result: {} })).isPty, false);
  assert.equal(exited(terminal({ result: {} })).isPty, undefined);
});

test('границы сворачивания: строки и символы', () => {
  const twentyLines = `${Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')}`;
  const twentyOneLines = `${twentyLines}\nline 20`;
  const fourThousand = 'a'.repeat(4000);
  const fourThousandOne = 'a'.repeat(4001);

  assert.equal(isLongTerminalPreview(twentyLines), false);
  assert.equal(isLongTerminalPreview(twentyOneLines), true);
  assert.equal(isLongTerminalPreview(fourThousand), false);
  assert.equal(isLongTerminalPreview(fourThousandOne), true);

  const short = exited(terminal({ result: { preview: twentyLines } }));
  const long = exited(terminal({ result: { preview: twentyOneLines } }));
  assert.equal(short.preview.state === 'present' && short.preview.long, false);
  assert.equal(long.preview.state === 'present' && long.preview.long, true);
  assert.equal(short.preview.state === 'present' && short.preview.lines, 20);
});

test('ANSI-последовательности PTY не разбираются и не вырезаются', () => {
  const ansi = '\u001b[31mred\u001b[0m';
  const view = exited(terminal({ isPty: true, result: { exitCode: 0, preview: ansi } }));

  assert.equal(view.preview.state, 'present');
  if (view.preview.state !== 'present') return;
  assert.equal(view.preview.text, ansi);
});

test('subagentTarget переносит поля карточки', () => {
  const target = subagentTarget(subagent({ agentName: 'explore', description: 'найти вызовы' }));

  assert.deepEqual(target, {
    chatUri: 'ahp-chat:/worker',
    name: 'Исследование',
    agentName: 'explore',
    description: 'найти вызовы',
    available: false,
  });
});

test('доступность подагента решает только каталог чатов сессии', () => {
  const chats = new Set(['ahp-chat:/visible']);

  assert.equal(subagentTarget(subagent({ resource: 'ahp-chat:/visible' }), chats).available, true);
  assert.equal(subagentTarget(subagent({ resource: 'ahp-chat:/hidden' }), chats).available, false);
  // Похожий на chat URI ресурс сам по себе не делает чат доступным.
  assert.equal(subagentTarget(subagent(), new Set()).available, false);
  assert.equal(subagentTarget(subagent()).available, false);});