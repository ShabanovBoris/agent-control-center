import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  isUpCommandLine, processTable, readUpState, upOwnershipSource,
  type ProcessTable, type UpOwnership,
} from './up-state.js';

interface FakeTable {
  table: ProcessTable;
  identities: Map<number, string>;
  other: { pid?: number };
}

function fakeTable(): FakeTable {
  const identities = new Map<number, string>();
  const other: { pid?: number } = {};
  return {
    identities,
    other,
    table: {
      identity: async pid => identities.has(pid) ? { pid, startedAt: identities.get(pid)! } : undefined,
      otherUp: async () => other.pid,
    },
  };
}

async function acquire(file: string, ownerPid: number, table: ProcessTable): Promise<UpOwnership> {
  const result = await upOwnershipSource({ file, ownerPid, table, log: () => undefined }).acquire();
  assert.equal(result.kind, 'acquired');
  if (result.kind !== 'acquired') throw new Error('unreachable');
  return result.ownership;
}

test('захват создаёт up-state.json 0600; живой владелец — other', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'up-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'up-state.json');
  const fake = fakeTable();
  fake.identities.set(100, 'Mon Nov 24 10:00:00 2026');

  await acquire(file, 100, fake.table);
  const info = await stat(file);
  assert.equal(info.mode & 0o777, 0o600);
  const saved = await readUpState(file);
  assert.equal(saved?.owner.pid, 100);

  fake.identities.set(200, 'Mon Nov 24 11:00:00 2026');
  const second = await upOwnershipSource({ file, ownerPid: 200, table: fake.table, log: () => undefined }).acquire();
  assert.deepEqual(second, { kind: 'other', pid: 100 });
});

test('pid reuse: старый владелец считается мёртвым, состояние перехватывается', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'up-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'up-state.json');
  const fake = fakeTable();
  fake.identities.set(100, 'old-start');
  const first = await acquire(file, 100, fake.table);
  fake.identities.set(500, 'child-start');
  await first.record('backend', { leaderPid: 500 });

  fake.identities.set(100, 'new-start-after-reuse');
  fake.identities.set(200, 'owner-200');
  const second = await upOwnershipSource({ file, ownerPid: 200, table: fake.table, log: () => undefined }).acquire();
  assert.equal(second.kind, 'acquired');
  if (second.kind !== 'acquired') return;
  assert.equal(second.ownership.owner.pid, 200);
  assert.equal(second.ownership.previous('backend')?.leader.pid, 500, 'записи о детях сохраняются при перехвате');
  const saved = await readUpState(file);
  assert.equal(saved?.owner.startedAt, 'owner-200');
});

test('битый файл состояния игнорируется и не блокирует запуск', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'up-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'up-state.json');
  await writeFile(file, '{not json', { mode: 0o600 });
  const fake = fakeTable();
  fake.identities.set(200, 'owner-200');
  const logs: string[] = [];
  const result = await upOwnershipSource({ file, ownerPid: 200, table: fake.table, log: line => logs.push(line) }).acquire();
  assert.equal(result.kind, 'acquired');
  assert.ok(logs.some(line => line.includes('повреждён')), logs.join('\n'));
  assert.equal((await readUpState(file))?.owner.pid, 200);
});

test('другой scripts/up.ts не создаёт состояние', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'up-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'up-state.json');
  const fake = fakeTable();
  fake.other.pid = 777;
  fake.identities.set(200, 'owner-200');
  const result = await upOwnershipSource({ file, ownerPid: 200, table: fake.table, log: () => undefined }).acquire();
  assert.deepEqual(result, { kind: 'other', pid: 777 });
  await assert.rejects(stat(file), /ENOENT/);
});

test('record/owns/forget/release', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'up-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'up-state.json');
  const fake = fakeTable();
  fake.identities.set(100, 'owner');
  fake.identities.set(500, 'leader');
  fake.identities.set(600, 'instance');
  const ownership = await acquire(file, 100, fake.table);

  await ownership.record('backend', { leaderPid: 500 });
  assert.equal(await ownership.owns('backend'), true);
  fake.identities.delete(500);
  assert.equal(await ownership.owns('backend'), false);
  fake.identities.set(500, 'leader');

  await ownership.record('host:local', { leaderPid: 500, instancePid: 600 });
  let saved = await readUpState(file);
  assert.equal(saved?.children['host:local']?.leader.pid, 500);
  assert.equal(saved?.children['host:local']?.instance?.pid, 600);

  await ownership.forget('backend');
  saved = await readUpState(file);
  assert.equal(saved?.children.backend, undefined);
  assert.equal(saved?.children['host:local']?.instance?.pid, 600);

  await ownership.release(true);
  await assert.rejects(stat(file), /ENOENT/);
});

test('record без identity лидера падает: up не оставит неучтённого ребёнка', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'up-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'up-state.json');
  const fake = fakeTable();
  fake.identities.set(100, 'owner');
  const ownership = await acquire(file, 100, fake.table);
  await assert.rejects(ownership.record('backend', { leaderPid: 999 }), /pid 999/);
  assert.equal((await readUpState(file))?.children.backend, undefined);
});

test('параллельный захват: один acquired, второй other, без потери состояния', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'up-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'up-state.json');
  const fake = fakeTable();
  fake.identities.set(100, 'owner-100');
  fake.identities.set(200, 'owner-200');
  const [first, second] = await Promise.all([
    upOwnershipSource({ file, ownerPid: 100, table: fake.table, log: () => undefined }).acquire(),
    upOwnershipSource({ file, ownerPid: 200, table: fake.table, log: () => undefined }).acquire(),
  ]);
  assert.deepEqual([first.kind, second.kind].sort(), ['acquired', 'other']);
  const winner = first.kind === 'acquired' ? 100 : 200;
  const loser = first.kind === 'other' ? first : second;
  assert.equal(loser.kind, 'other');
  assert.equal(loser.kind === 'other' ? loser.pid : undefined, winner);
  const saved = await readUpState(file);
  assert.equal(saved?.owner.pid, winner);
  assert.equal(saved?.owner.startedAt, `owner-${winner}`);
});

test('release(false) сохраняет состояние для следующего запуска', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'up-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'up-state.json');
  const fake = fakeTable();
  fake.identities.set(100, 'owner');
  fake.identities.set(500, 'leader');
  const ownership = await acquire(file, 100, fake.table);
  await ownership.record('host:wbllm', { leaderPid: 500 });
  await ownership.release(false);
  assert.equal((await readUpState(file))?.children['host:wbllm']?.leader.pid, 500);
});

test('состояние с неизвестной версией игнорируется', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'up-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'up-state.json');
  await writeFile(file, JSON.stringify({ version: 2, owner: { pid: 1, startedAt: 'x' }, children: {} }));
  const logs: string[] = [];
  assert.equal(await readUpState(file, line => logs.push(line)), undefined);
  assert.ok(logs.some(line => line.includes('неизвестную версию')));
  assert.match(await readFile(file, 'utf8'), /"version":2/);
});

test('isUpCommandLine: относительный и абсолютный путь, чужие команды', () => {
  assert.equal(isUpCommandLine('node --import tsx scripts/up.ts'), true);
  assert.equal(isUpCommandLine('node --import tsx ./scripts/up.ts --supervised'), true);
  assert.equal(isUpCommandLine('/opt/homebrew/bin/node --import tsx /Users/me/AgentHostProtocolMicrosoft/scripts/up.ts --supervised --keep-awake'), true);
  assert.equal(isUpCommandLine('node --no-warnings --import tsx /repo/scripts/up.ts'), true);
  assert.equal(isUpCommandLine('node --no-warnings --import=tsx /repo/scripts/up.ts --supervised'), true);
  assert.equal(isUpCommandLine('node --loader tsx /repo/scripts/up.ts'), true);
  assert.equal(isUpCommandLine('/opt/homebrew/bin/node /repo/node_modules/.bin/tsx /repo/scripts/up.ts'), true);
  assert.equal(isUpCommandLine('node scripts/up.ts'), false);
  assert.equal(isUpCommandLine('node --import tsx scripts/up-other.ts'), false);
  assert.equal(isUpCommandLine('npm run up'), false);
  assert.equal(isUpCommandLine('/usr/bin/python3 --import tsx scripts/up.ts'), false);
});

test('processTable: identity читает lstart', async () => {
  const identity = await processTable.identity(process.pid);
  assert.equal(identity?.pid, process.pid);
  assert.ok((identity?.startedAt.length ?? 0) > 0);
  assert.equal(await processTable.identity(2_147_483_647), undefined);
});
