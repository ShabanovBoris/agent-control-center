import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HostOverview } from '../shared/protocol.js';
import { collectHealth, readAppVersion } from './health.js';
import { readHostBuild } from './host-build.js';
import { MAX_HOST_ISSUES, MAX_ISSUE_CHARS, appendHostIssue } from './host-issues.js';
import type { HostDiagnostics } from './hub.js';
import type { LogSource } from './logs.js';

const token = 'ab'.repeat(32);
const build = { version: '1.2.3', commit: 'c'.repeat(40) };
const at = '2026-01-02T03:04:05.000Z';
const backend = { version: '0.1.0', ahpVersion: '1.1.0', startedAt: Date.parse(at), phoneAccess: true };

function host(id: string, status: HostOverview['status'], error?: string): Pick<HostOverview, 'id' | 'label' | 'status' | 'error' | 'protocolVersion'> {
  return { id, label: `Хост ${id}`, status, protocolVersion: '1.1.0', ...(error ? { error } : {}) };
}

function logSource(hostId: string): LogSource {
  return { hostId, fileName: '.local/host.log', path: '/tmp/host.log', startCommand: 'npm run host -- --log' };
}

test('снимок различает статусы и редактирует причину', async () => {
  const snapshot = await collectHealth({
    hosts: [
      host('local', 'connected'),
      host('gemini', 'reconnecting', `connect ECONNREFUSED ws://localhost:8090?tkn=${token}`),
      host('remote', 'failed', 'timeout'),
    ],
    diagnostics: [],
    logs: [],
    backend,
  });
  assert.deepEqual(snapshot.hosts.map(item => [item.id, item.status]), [
    ['local', 'connected'],
    ['gemini', 'reconnecting'],
    ['remote', 'failed'],
  ]);
  assert.equal(snapshot.hosts[0]?.error, undefined);
  assert.equal(snapshot.hosts[1]?.error, 'connect ECONNREFUSED ws://localhost:8090?tkn=<redacted>');
  assert.equal(snapshot.hosts[2]?.error, 'timeout');
  assert.deepEqual(snapshot.hosts.map(item => item.recentErrors), [[], [], []]);
  assert.deepEqual(snapshot.backend, { version: '0.1.0', ahpVersion: '1.1.0', startedAt: at, phoneAccess: true });
});

test('диагностика, журнал и версии SDK попадают в снимок по своим хостам', async () => {
  const diagnostics: HostDiagnostics[] = [{
    id: 'local',
    lastConnectedAt: at,
    lastEventAt: at,
    activeSessions: 2,
    hostBuild: build,
    issues: [{ at, message: 'сбой', count: 3 }],
  }];
  const seen: { hostId: string; build: { version: string; commit: string } | undefined }[] = [];
  const snapshot = await collectHealth({
    hosts: [host('local', 'connected'), host('gemini', 'failed', 'нет связи')],
    diagnostics,
    logs: [logSource('local')],
    backend,
    sdkVersions: async (hostId, hostBuild) => {
      seen.push({ hostId, build: hostBuild });
      return hostId === 'local' ? { codex: '0.5.0', claude: null } : undefined;
    },
  });
  assert.deepEqual(seen, [{ hostId: 'local', build }, { hostId: 'gemini', build: undefined }]);
  const local = snapshot.hosts[0];
  assert.deepEqual(
    [local?.lastConnectedAt, local?.lastEventAt, local?.activeSessions, local?.hostBuild, local?.logFile],
    [at, at, 2, build, '.local/host.log'],
  );
  assert.deepEqual(local?.sdkVersions, { codex: '0.5.0', claude: null });
  assert.deepEqual(local?.recentErrors, [{ at, message: 'сбой', count: 3 }]);
  assert.equal(snapshot.hosts[1]?.logFile, undefined);
  assert.equal(snapshot.hosts[1]?.sdkVersions, undefined);
});

test('сбой инспектора SDK остаётся ошибкой одного хоста', async () => {
  const snapshot = await collectHealth({
    hosts: [host('local', 'connected'), host('gemini', 'connected')],
    diagnostics: [{ id: 'local', issues: [] }, { id: 'gemini', issues: [] }],
    logs: [],
    backend,
    sdkVersions: async hostId => {
      if (hostId === 'local') throw new Error('ps: операция не разрешена');
      return { codex: '0.6.0' };
    },
  });
  assert.equal(snapshot.hosts[0]?.sdkError, 'ps: операция не разрешена');
  assert.equal(snapshot.hosts[0]?.sdkVersions, undefined);
  assert.deepEqual(snapshot.hosts[1]?.sdkVersions, { codex: '0.6.0' });
  assert.equal(snapshot.hosts[1]?.sdkError, undefined);
});

test('история ошибок дедуплицируется, считает повторы и не мутирует вход', () => {
  const start = [{ at, message: 'сбой', count: 1 }];
  const repeated = appendHostIssue(start, 'сбой', '2026-01-02T03:05:00.000Z');
  assert.deepEqual(repeated, [{ at: '2026-01-02T03:05:00.000Z', message: 'сбой', count: 2 }]);
  assert.deepEqual(start, [{ at, message: 'сбой', count: 1 }]);

  const added = appendHostIssue(repeated, 'другая', at);
  assert.deepEqual(added.map(issue => [issue.message, issue.count]), [['сбой', 2], ['другая', 1]]);

  let issues: ReturnType<typeof appendHostIssue> = [];
  for (let index = 0; index < MAX_HOST_ISSUES + 3; index += 1) issues = appendHostIssue(issues, `ошибка ${index}`, at);
  assert.equal(issues.length, MAX_HOST_ISSUES);
  assert.equal(issues[0]?.message, 'ошибка 3');

  const [long] = appendHostIssue([], 'я'.repeat(MAX_ISSUE_CHARS + 50), at);
  assert.equal(long?.message.length, MAX_ISSUE_CHARS);
  assert.ok(long?.message.endsWith('…'));
});

test('версия Agent Host разбирается только из полной стабильной пары', () => {
  assert.deepEqual(readHostBuild(build), build);
  assert.equal(readHostBuild({ version: '1.2', commit: build.commit }), undefined);
  assert.equal(readHostBuild({ version: '1.2.3-beta', commit: build.commit }), undefined);
  assert.equal(readHostBuild({ version: '1.2.3', commit: 'abc' }), undefined);
  assert.equal(readHostBuild({ version: '1.2.3', commit: build.commit.toUpperCase() }), undefined);
  assert.equal(readHostBuild(undefined), undefined);
  assert.equal(readHostBuild('1.2.3'), undefined);
});

test('версия панели читается из package.json', async () => {
  assert.match(await readAppVersion(), /^\d+\.\d+\.\d+$/);
});
