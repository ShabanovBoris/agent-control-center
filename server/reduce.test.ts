import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionType, TerminalClaimKind, TerminalLifecycleStatus, type TerminalState } from '@microsoft/agent-host-protocol';
import { isSupportedChannel, reduceChannel } from '../shared/reduce.js';
import { ROOT_URI } from '../shared/protocol.js';

const uri = 'ahp-terminal:/one';

const state = (): TerminalState => ({
  title: 'Терминал',
  content: [{ type: 'unclassified', value: '$ ' }],
  lifecycle: { status: TerminalLifecycleStatus.Running },
  claim: { kind: TerminalClaimKind.Client, clientId: 'backend' },
});

test('терминальный канал поддержан там же, где остальные каналы AHP', () => {
  assert.equal(isSupportedChannel(uri), true);
  assert.equal(isSupportedChannel(ROOT_URI), true);
  assert.equal(isSupportedChannel('ahp-terminal-something'), false, 'префикс обязателен вместе с двоеточием');
  assert.equal(isSupportedChannel('https://example.test'), false);
});

test('reduceChannel применяет terminal-actions тем же редьюсером SDK', () => {
  const data = reduceChannel(uri, state(), { type: ActionType.TerminalData, data: 'ok' });
  assert.deepEqual((data as TerminalState).content, [{ type: 'unclassified', value: '$ ok' }]);

  const exited = reduceChannel(uri, state(), { type: ActionType.TerminalExited, exitCode: 7 });
  assert.deepEqual((exited as TerminalState).lifecycle, { status: TerminalLifecycleStatus.Exited, exitCode: 7 });

  const resized = reduceChannel(uri, state(), { type: ActionType.TerminalResized, cols: 120, rows: 40 });
  assert.equal((resized as TerminalState).cols, 120);
  assert.equal((resized as TerminalState).rows, 40);

  const cleared = reduceChannel(uri, state(), { type: ActionType.TerminalCleared });
  assert.deepEqual((cleared as TerminalState).content, []);
  assert.throws(() => reduceChannel('ahp-unknown:/one', state(), { type: ActionType.TerminalCleared }), /Unsupported channel/);
});
