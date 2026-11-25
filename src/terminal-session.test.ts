import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TerminalClaimKind, TerminalLifecycleStatus, type TerminalState } from '@microsoft/agent-host-protocol';
import {
  forgetSelectedTerminal, forgetTerminalLabel, lastTerminalForm, nextTerminalLabel,
  rememberLastTerminalForm, rememberSelectedTerminal, rememberTerminalLabel, selectedTerminal,
  terminalCwd, terminalLabels, terminalRowLabels, terminalStatusText,
} from './terminal-session.js';

function storage(initial: Record<string, string> = {}): { getItem(key: string): string | null; setItem(key: string, value: string): void; data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: key => (Object.hasOwn(data, key) ? data[key]! : null), setItem: (key, value) => { data[key] = value; } };
}

const state = (lifecycle: TerminalState['lifecycle']): TerminalState => ({
  title: 'Терминал',
  content: [],
  lifecycle,
  claim: { kind: TerminalClaimKind.Client, clientId: 'backend' },
});

test('выбранный терминал хранится как hostId+URI и переживает roundtrip', () => {
  const store = storage();
  assert.equal(selectedTerminal(store), undefined);
  rememberSelectedTerminal(store, 'mac', 'ahp-terminal:/one');
  assert.deepEqual(selectedTerminal(store), { hostId: 'mac', uri: 'ahp-terminal:/one' });
  rememberSelectedTerminal(store, 'other', 'ahp-terminal:/two');
  assert.deepEqual(selectedTerminal(store), { hostId: 'other', uri: 'ahp-terminal:/two' }, 'запоминается последний выбор');
});

test('мусор, пустой hostId и не терминальный URI игнорируются', () => {
  assert.equal(selectedTerminal(storage({ 'acc.terminals.v2.selected': '{' })), undefined);
  assert.equal(selectedTerminal(storage({ 'acc.terminals.v2.selected': '[1,2]' })), undefined);
  assert.equal(selectedTerminal(storage({ 'acc.terminals.v2.selected': JSON.stringify({ hostId: '', uri: 'ahp-terminal:/one' }) })), undefined);
  assert.equal(selectedTerminal(storage({ 'acc.terminals.v2.selected': JSON.stringify({ uri: 'ahp-terminal:/one' }) })), undefined);
  assert.equal(selectedTerminal(storage({ 'acc.terminals.v2.selected': JSON.stringify({ hostId: 'mac', uri: 'https://example.test' }) })), undefined);

  const store = storage();
  rememberSelectedTerminal(store, '', 'ahp-terminal:/one');
  rememberSelectedTerminal(store, 'mac', 'https://example.test');
  assert.equal(selectedTerminal(store), undefined, 'невалидное значение не записывается');
});

test('forgetSelectedTerminal забывает выбор', () => {
  const store = storage();
  rememberSelectedTerminal(store, 'mac', 'ahp-terminal:/one');
  forgetSelectedTerminal(store);
  assert.equal(selectedTerminal(store), undefined);
});

test('форма v2 переживает roundtrip, а до неё читается последняя пара старой версии', () => {
  const store = storage();
  assert.equal(lastTerminalForm(store), undefined);
  rememberLastTerminalForm(store, 'mac', '/work/src');
  assert.deepEqual(lastTerminalForm(store), { hostId: 'mac', directory: '/work/src' });
  // v2 важнее старой пары: миграция одноразовая и не перетирает новый выбор.
  store.data['acc.terminals.v1.last'] = JSON.stringify({ hostId: 'old', directory: '/tmp' });
  assert.deepEqual(lastTerminalForm(store), { hostId: 'mac', directory: '/work/src' });

  const legacy = storage({ 'acc.terminals.v1.last': JSON.stringify({ hostId: 'old', directory: '/tmp' }) });
  assert.deepEqual(lastTerminalForm(legacy), { hostId: 'old', directory: '/tmp' });
  assert.equal(lastTerminalForm(storage({ 'acc.terminals.v1.last': '{' })), undefined);
  assert.equal(lastTerminalForm(storage({ 'acc.terminals.v2.form': JSON.stringify({ hostId: 'mac' }) })), undefined, 'без папки форма бесполезна');
  assert.equal(lastTerminalForm(storage({ 'acc.terminals.v2.form': JSON.stringify({ hostId: '', directory: '/work' }) })), undefined);
});

test('фактический cwd берётся из состояния, а не из поля формы', () => {
  assert.equal(terminalCwd(state({ status: TerminalLifecycleStatus.Running }), '/requested'), '/requested');
  assert.equal(terminalCwd({ ...state({ status: TerminalLifecycleStatus.Running }), cwd: 'file:///Users/me/project' }, '/requested'), '/Users/me/project');
  assert.equal(terminalCwd({ ...state({ status: TerminalLifecycleStatus.Running }), cwd: 'file:///Users/%D0%BC%D0%B5' }, '/'), '/Users/ме');
});

test('статус жизненного цикла: выполняется, завершён с кодом и без', () => {
  assert.equal(terminalStatusText(undefined), 'подключаемся…');
  assert.equal(terminalStatusText({ status: TerminalLifecycleStatus.Running }), 'выполняется');
  assert.equal(terminalStatusText({ status: TerminalLifecycleStatus.Exited, exitCode: 7 }), 'завершён · код 7');
  assert.equal(terminalStatusText({ status: TerminalLifecycleStatus.Exited, exitCode: 0 }), 'завершён · код 0');
  assert.equal(terminalStatusText({ status: TerminalLifecycleStatus.Exited }), 'завершён');
});

test('подпись строки хранится по URI и переживает roundtrip', () => {
  const store = storage();
  assert.equal(terminalLabels(store).size, 0);
  rememberTerminalLabel(store, 'ahp-terminal:/one', 'workspace');
  rememberTerminalLabel(store, 'ahp-terminal:/two', 'workspace 2');
  assert.deepEqual([...terminalLabels(store)], [
    ['ahp-terminal:/one', 'workspace'],
    ['ahp-terminal:/two', 'workspace 2'],
  ]);

  const garbage = storage({ 'acc.terminals.v2.labels': JSON.stringify({ 'ahp-terminal:/ok': 'src', 'https://x': 'src', 'ahp-terminal:/empty': '' }) });
  assert.deepEqual([...terminalLabels(garbage)], [['ahp-terminal:/ok', 'src']]);
  assert.equal(terminalLabels(storage({ 'acc.terminals.v2.labels': '{' })).size, 0);
  rememberTerminalLabel(store, 'https://example.test', 'чужое');
  assert.equal(terminalLabels(store).size, 2, 'не терминальный URI не записывается');
});

test('имя нового PTY нумеруется в пределах папки', () => {
  assert.equal(nextTerminalLabel('workspace', []), 'workspace');
  assert.equal(nextTerminalLabel('workspace', ['workspace']), 'workspace 2');
  assert.equal(nextTerminalLabel('workspace', ['workspace', 'workspace 2']), 'workspace 3');
  assert.equal(nextTerminalLabel('workspace', ['workspace 2']), 'workspace', 'свободное имя переиспользуется');
  assert.equal(nextTerminalLabel('workspace', ['src']), 'workspace');
});

test('одинаковые подписи различимы хвостом URI, сохранённое имя важнее title хоста', () => {
  const labels = new Map([
    ['ahp-terminal:/a', 'workspace'],
    ['ahp-terminal:/b', 'workspace 2'],
  ]);
  assert.deepEqual(terminalRowLabels([
    { hostId: 'mac', uri: 'ahp-terminal:/a', title: 'bash' },
    { hostId: 'mac', uri: 'ahp-terminal:/b', title: 'bash' },
  ], labels), ['workspace', 'workspace 2'], 'сохранённые имена не меняются после overview');

  // PTY созданы в другом браузере: сохранённых имён нет, хост отдаёт одинаковый title.
  assert.deepEqual(terminalRowLabels([
    { hostId: 'mac', uri: 'ahp-terminal:/4606a70c-1', title: 'bash' },
    { hostId: 'mac', uri: 'ahp-terminal:/96c1aabb-2', title: 'bash' },
  ], new Map()), ['bash · 4606a70c', 'bash · 96c1aabb']);

  // Разные хосты с одинаковым именем не считаются одной строкой.
  assert.deepEqual(terminalRowLabels([
    { hostId: 'mac', uri: 'ahp-terminal:/a', title: 'bash' },
    { hostId: 'glm', uri: 'ahp-terminal:/b', title: 'bash' },
  ], new Map()), ['bash', 'bash']);

  // Одинаковое имя папки у терминалов из разных папок различает cwd — хвост URI не нужен.
  assert.deepEqual(terminalRowLabels([
    { hostId: 'mac', uri: 'ahp-terminal:/a', title: 'bash', folder: '/work/app' },
    { hostId: 'mac', uri: 'ahp-terminal:/b', title: 'bash', folder: '/tmp/app' },
  ], new Map()), ['bash', 'bash']);
});

test('forgetTerminalLabel убирает имя закрытого PTY и не трогает соседние', () => {
  const store = storage();
  rememberTerminalLabel(store, 'ahp-terminal:/one', 'workspace');
  rememberTerminalLabel(store, 'ahp-terminal:/two', 'workspace 2');
  forgetTerminalLabel(store, 'ahp-terminal:/one');
  assert.deepEqual([...terminalLabels(store)], [['ahp-terminal:/two', 'workspace 2']]);
  forgetTerminalLabel(store, 'ahp-terminal:/unknown');
  assert.deepEqual([...terminalLabels(store)], [['ahp-terminal:/two', 'workspace 2']]);
});
