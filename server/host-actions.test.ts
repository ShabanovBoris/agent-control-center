import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionType } from '@microsoft/agent-host-protocol';
import type { TransportFrame } from '@microsoft/agent-host-protocol/client';
import { ROOT_URI } from '../shared/protocol.js';
import { guardHostActions } from './host-actions.js';

test('повреждённое корневое действие не попадает во внутренний редьюсер SDK', async t => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const broken = { channel: ROOT_URI, serverSeq: 1, action: { type: ActionType.RootAgentsChanged } };
  const valid = { channel: ROOT_URI, serverSeq: 2, action: { type: ActionType.RootAgentsChanged, agents: [] } };
  const notification = (params: unknown) => ({ jsonrpc: '2.0', method: 'action', params });
  const reply = { jsonrpc: '2.0', id: 1, result: { type: 'replay', actions: [broken, valid], missing: [] } };
  const frames: TransportFrame[] = [
    { kind: 'text', text: JSON.stringify(notification(broken)) },
    { kind: 'text', text: JSON.stringify(notification(valid)) },
    { kind: 'binary', data: Buffer.from(JSON.stringify(reply)) },
  ];
  const transport = guardHostActions({ send() {}, close() {}, async recv() { return frames.shift() ?? null; } }, 'test');

  assert.deepEqual(await transport.recv(), { kind: 'parsed', message: notification(valid) });
  assert.deepEqual(await transport.recv(), { kind: 'parsed', message: { ...reply, result: { ...reply.result, actions: [valid] } } });
  assert.equal(await transport.recv(), null);
  assert.equal(warnings.mock.callCount(), 2);
});
