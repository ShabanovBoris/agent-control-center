import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TerminalClaimKind, TerminalLifecycleStatus, type TerminalState } from '@microsoft/agent-host-protocol';
import {
  forgetTerminal, lastTerminal, rememberLastTerminal, rememberTerminal, savedTerminal, terminalChoice, terminalCwd, terminalKey,
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

test('URI хранится по паре хост+папка и переживает хвостовой слэш', () => {
  const store = storage();
  rememberTerminal(store, 'mac', '/work/', 'ahp-terminal:/one');
  assert.equal(savedTerminal(store, 'mac', '/work'), 'ahp-terminal:/one');
  assert.equal(savedTerminal(store, 'mac', '/work/'), 'ahp-terminal:/one');
  assert.equal(savedTerminal(store, 'other', '/work'), undefined, 'другой хост — свой терминал');
  assert.equal(savedTerminal(store, 'mac', '/work/src'), undefined, 'другая папка — свой терминал');
  assert.equal(terminalKey('mac', '/'), 'mac\n/');
});

test('закрытие терминала забывает URI, а мусор в хранилище игнорируется', () => {
  const store = storage();
  rememberTerminal(store, 'mac', '/work', 'ahp-terminal:/one');
  forgetTerminal(store, 'mac', '/work');
  assert.equal(savedTerminal(store, 'mac', '/work'), undefined);

  const broken = storage({ 'acc.terminals.v1': '[1,2,3]' });
  assert.equal(savedTerminal(broken, 'mac', '/work'), undefined);
  const invalid = storage({ 'acc.terminals.v1': JSON.stringify({ 'mac\n/work': 'https://example.test' }) });
  assert.equal(savedTerminal(invalid, 'mac', '/work'), undefined, 'не терминальный URI не подхватывается');
  const garbage = storage({ 'acc.terminals.v1': '{' });
  assert.equal(savedTerminal(garbage, 'mac', '/work'), undefined);
});

test('выбор «подхватить или создать»: NotFound и завершённый shell дают новый PTY', () => {
  assert.deepEqual(terminalChoice(undefined, {}), { kind: 'create' });
  assert.deepEqual(terminalChoice('ahp-terminal:/one', { missing: true }), { kind: 'create' });
  // Снимка ещё нет — сохранённый URI в игре, иначе каждое открытие создавало бы второй PTY.
  assert.deepEqual(terminalChoice('ahp-terminal:/one', {}), { kind: 'attach' });
  assert.deepEqual(terminalChoice('ahp-terminal:/one', { state: state({ status: TerminalLifecycleStatus.Running }) }), { kind: 'attach' });
  assert.deepEqual(terminalChoice('ahp-terminal:/one', { state: state({ status: TerminalLifecycleStatus.Exited, exitCode: 7 }) }), { kind: 'exited', exitCode: 7 });
  assert.deepEqual(terminalChoice('ahp-terminal:/one', { state: state({ status: TerminalLifecycleStatus.Exited }) }), { kind: 'exited' });
});

test('фактический cwd берётся из состояния, а не из поля формы', () => {
  assert.equal(terminalCwd(state({ status: TerminalLifecycleStatus.Running }), '/requested'), '/requested');
  assert.equal(terminalCwd({ ...state({ status: TerminalLifecycleStatus.Running }), cwd: 'file:///Users/me/project' }, '/requested'), '/Users/me/project');
  assert.equal(terminalCwd({ ...state({ status: TerminalLifecycleStatus.Running }), cwd: 'file:///Users/%D0%BC%D0%B5' }, '/'), '/Users/ме');
});

test('последняя пара хост+папка возвращает страницу к прежнему shell после F5', () => {
  const store = storage();
  assert.equal(lastTerminal(store), undefined);
  rememberLastTerminal(store, 'mac', '/tmp');
  rememberTerminal(store, 'mac', '/tmp', 'ahp-terminal:/one');
  assert.deepEqual(lastTerminal(store), { hostId: 'mac', directory: '/tmp' });
  // Именно эта пара даёт сохранённый URI: папка по умолчанию к терминалу не относится.
  assert.equal(savedTerminal(store, 'mac', '/tmp'), 'ahp-terminal:/one');

  assert.equal(lastTerminal(storage({ 'acc.terminals.v1.last': '{' })), undefined);
  assert.equal(lastTerminal(storage({ 'acc.terminals.v1.last': JSON.stringify({ hostId: 'mac' }) })), undefined, 'без папки запись бесполезна');
  assert.equal(lastTerminal(storage({ 'acc.terminals.v1.last': JSON.stringify([1]) })), undefined);
});
