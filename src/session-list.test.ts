import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionStatus, type SessionSummary } from '@microsoft/agent-host-protocol';
import type { SessionOverview } from '../shared/protocol';
import { channelKey } from '../shared/reduce';
import { pinnedKeys, sortSessions, unreadCounts } from './session-list';

function session(hostId: string, uri: string, modifiedAt: string): SessionOverview {
  return {
    hostId,
    hostLabel: hostId,
    summary: {
      resource: uri,
      createdAt: '2026-11-24T00:00:00Z',
      modifiedAt,
      provider: 'mock',
      title: uri,
      status: SessionStatus.Idle,
    } as SessionSummary,
  };
}

const older = session('local', 'ahp-session:/older', '2026-11-24T00:01:00Z');
const newer = session('local', 'ahp-session:/newer', '2026-11-24T00:02:00Z');
const otherHost = session('second', 'ahp-session:/older', '2026-11-24T00:03:00Z');

test('без закреплений порядок остаётся по modifiedAt по убыванию', () => {
  assert.deepEqual(sortSessions([older, newer], new Set()).map(item => item.summary.resource), [
    'ahp-session:/newer', 'ahp-session:/older',
  ]);
});

test('закреплённые идут первыми, порядок внутри группы — modifiedAt', () => {
  const pinned = pinnedKeys([{ hostId: 'local', sessionUri: 'ahp-session:/older' }]);
  assert.deepEqual(sortSessions([newer, older], pinned).map(item => item.summary.resource), [
    'ahp-session:/older', 'ahp-session:/newer',
  ]);
});

test('pin одного хоста не поднимает одноимённую сессию другого', () => {
  const pinned = pinnedKeys([{ hostId: 'local', sessionUri: 'ahp-session:/older' }]);
  const sorted = sortSessions([older, otherHost], pinned);
  assert.deepEqual(sorted.map(item => channelKey(item.hostId, item.summary.resource)), [
    channelKey('local', 'ahp-session:/older'),
    channelKey('second', 'ahp-session:/older'),
  ]);
});

test('равный modifiedAt разрешается ключом канала, вход не мутируется', () => {
  const left = session('b', 'ahp-session:/x', '2026-11-24T00:00:00Z');
  const right = session('a', 'ahp-session:/x', '2026-11-24T00:00:00Z');
  const input = [left, right];
  assert.deepEqual(sortSessions(input, new Set()).map(item => item.hostId), ['a', 'b']);
  assert.deepEqual(input.map(item => item.hostId), ['b', 'a']);
});

test('unreadCounts сопоставляет счётчики по ключу канала', () => {
  const counts = unreadCounts([
    { hostId: 'local', sessionUri: 'ahp-session:/older', count: 2 },
    { hostId: 'second', sessionUri: 'ahp-session:/older', count: 1 },
  ]);
  assert.equal(counts.get(channelKey('local', 'ahp-session:/older')), 2);
  assert.equal(counts.get(channelKey('second', 'ahp-session:/older')), 1);
  assert.equal(counts.get(channelKey('local', 'ahp-session:/newer')), undefined);
});
