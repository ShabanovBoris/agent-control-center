import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionStatus, type SessionChatSummary, type SessionSummary } from '@microsoft/agent-host-protocol';
import { parseServerMessage, type Overview, type SessionUserState } from '../shared/protocol.js';
import { channelKey } from '../shared/reduce.js';
import {
  createSessionUserState,
  SessionUserStateFailure,
  type SessionUserStateStore,
} from './session-user-state.js';
import { writePrivate } from './state-file.js';

const MAC = 'https://mac.ts.net';
const PHONE = 'https://phone.ts.net';
const SESSION = 'ahp-session:/s';
const OTHER = 'ahp-session:/other';
const CHAT = 'ahp-chat:/c';

interface ChatSpec {
  uri: string;
  status?: number;
}

interface Spec {
  sessionUri?: string;
  status?: number;
  modifiedAt?: string;
  activity?: string;
  chats?: ChatSpec[];
  defaultChat?: string;
}

function overview(...specs: Spec[]): Overview {
  return {
    hosts: [],
    sessions: specs.map(spec => ({
      hostId: 'local',
      hostLabel: 'Mac',
      summary: {
        provider: 'mock',
        resource: spec.sessionUri ?? SESSION,
        title: 'Сессия',
        createdAt: '2026-11-24T00:00:00Z',
        modifiedAt: spec.modifiedAt ?? '2026-11-24T00:01:00Z',
        status: spec.status ?? SessionStatus.Idle,
        ...(spec.activity !== undefined ? { activity: spec.activity } : {}),
        ...(spec.chats ? {
          chats: spec.chats.map((chat): SessionChatSummary => ({
            resource: chat.uri,
            title: 'Чат',
            ...(chat.status !== undefined ? { status: chat.status } : {}),
          })),
        } : {}),
        ...(spec.defaultChat ? { defaultChat: spec.defaultChat } : {}),
      } as SessionSummary,
    })),
  };
}

function key(uri: string): string {
  return channelKey('local', uri);
}

function visible(...uris: string[]): Map<string, Set<string>> {
  return new Map(uris.map(uri => [key(uri), new Set([MAC])]));
}

async function stateDir(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'acc-user-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function remembered(dir: string, ...origins: string[]): Promise<SessionUserStateStore> {
  const store = await createSessionUserState({ dir });
  for (const origin of origins) await store.rememberOrigin(origin);
  return store;
}

function unreadCount(store: SessionUserStateStore, origin: string, sessionUri = SESSION): number | undefined {
  return store.viewFor(origin).unread.find(entry => entry.hostId === 'local' && entry.sessionUri === sessionUri)?.count;
}

test('закрепление идемпотентно, переживает перезапуск и хранится в файле 0600', async t => {
  const dir = await stateDir(t);
  const store = await createSessionUserState({ dir });
  assert.equal(await store.setPinned('local', SESSION, true), true);
  assert.equal(await store.setPinned('local', SESSION, true), false);
  assert.deepEqual(store.viewFor(MAC).pinned, [{ hostId: 'local', sessionUri: SESSION }]);

  const path = join(dir, 'session-user-state.json');
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  const reopened = await createSessionUserState({ dir });
  assert.deepEqual(reopened.viewFor(PHONE).pinned, [{ hostId: 'local', sessionUri: SESSION }]);
  const file = JSON.parse(await readFile(path, 'utf8')) as { version: number; pinned: unknown[] };
  assert.equal(file.version, 1);
  assert.equal(file.pinned.length, 1);

  assert.equal(await store.setPinned('local', SESSION, false), true);
  assert.equal(await store.setPinned('local', SESSION, false), false);
  assert.deepEqual(store.viewFor(MAC).pinned, []);
});

test('pin глобальный, unread — только для своего origin', async t => {
  const dir = await stateDir(t);
  const store = await remembered(dir, MAC, PHONE);
  const empty = new Map<string, Set<string>>();
  await store.observe(overview({ status: SessionStatus.InProgress, modifiedAt: '2026-11-24T00:01:00Z' }), empty);
  await store.observe(overview({ status: SessionStatus.Idle, modifiedAt: '2026-11-24T00:02:00Z' }), empty);
  await store.setPinned('local', SESSION, true);

  assert.equal(unreadCount(store, MAC), 1);
  assert.equal(unreadCount(store, PHONE), 1);
  assert.deepEqual(store.viewFor(MAC).pinned, [{ hostId: 'local', sessionUri: SESSION }]);
  assert.deepEqual(store.viewFor(PHONE).pinned, [{ hostId: 'local', sessionUri: SESSION }]);

  const exclusive = await remembered(dir, 'https://else.ts.net');
  assert.deepEqual(exclusive.viewFor('https://else.ts.net').unread, []);
  assert.equal(exclusive.viewFor('https://else.ts.net').pinned.length, 1);
});

test('завершённый ход начисляется только невидимым origin', async t => {
  const dir = await stateDir(t);
  const store = await remembered(dir, MAC, PHONE);
  await store.observe(overview({ status: SessionStatus.InProgress, modifiedAt: '2026-11-24T00:01:00Z' }), new Map());
  const changed = await store.observe(
    overview({ status: SessionStatus.Idle, modifiedAt: '2026-11-24T00:02:00Z' }), visible(SESSION),
  );
  assert.equal(changed, true);
  assert.equal(unreadCount(store, MAC), undefined);
  assert.equal(unreadCount(store, PHONE), 1);
});

test('InputNeeded сам не начисляется, а InputNeeded → Idle — завершение хода', async t => {
  const dir = await stateDir(t);
  const store = await remembered(dir, MAC);
  const empty = new Map<string, Set<string>>();
  await store.observe(overview({ status: SessionStatus.InProgress, modifiedAt: '2026-11-24T00:01:00Z' }), empty);
  await store.observe(overview({ status: SessionStatus.InputNeeded, modifiedAt: '2026-11-24T00:02:00Z' }), empty);
  await store.observe(overview({ status: SessionStatus.InputNeeded, modifiedAt: '2026-11-24T00:03:00Z' }), empty);
  assert.equal(unreadCount(store, MAC), undefined);
  await store.observe(overview({ status: SessionStatus.Idle, modifiedAt: '2026-11-24T00:04:00Z' }), empty);
  assert.equal(unreadCount(store, MAC), 1);
});

test('новая ошибка начисляется один раз, повтор и Error → Idle не дублируют', async t => {
  const dir = await stateDir(t);
  const store = await remembered(dir, MAC);
  const empty = new Map<string, Set<string>>();
  await store.observe(overview({ status: SessionStatus.InProgress, modifiedAt: '2026-11-24T00:01:00Z' }), empty);
  const failed = overview({ status: SessionStatus.InProgress | SessionStatus.Error, modifiedAt: '2026-11-24T00:02:00Z' });
  await store.observe(failed, empty);
  assert.equal(unreadCount(store, MAC), 1);
  // Replay той же сводки после reconnect не должен начислять второй раз.
  await store.observe(failed, empty);
  assert.equal(unreadCount(store, MAC), 1);
  await store.observe(overview({ status: SessionStatus.Idle, modifiedAt: '2026-11-24T00:03:00Z' }), empty);
  assert.equal(unreadCount(store, MAC), 1);
});

test('ошибка отдельного чата начисляется, как и ошибка сессии', async t => {
  const dir = await stateDir(t);
  const store = await remembered(dir, MAC);
  const empty = new Map<string, Set<string>>();
  await store.observe(overview({
    status: SessionStatus.InProgress, modifiedAt: '2026-11-24T00:01:00Z',
    chats: [{ uri: CHAT, status: SessionStatus.InProgress }], defaultChat: CHAT,
  }), empty);
  await store.observe(overview({
    status: SessionStatus.InProgress, modifiedAt: '2026-11-24T00:02:00Z',
    chats: [{ uri: CHAT, status: SessionStatus.InProgress | SessionStatus.Error }], defaultChat: CHAT,
  }), empty);
  assert.equal(unreadCount(store, MAC), 1);
});

test('архивная сессия накапливает непрочитанные', async t => {
  const dir = await stateDir(t);
  const store = await remembered(dir, MAC);
  const empty = new Map<string, Set<string>>();
  await store.observe(overview({ status: SessionStatus.IsArchived | SessionStatus.InProgress, modifiedAt: '2026-11-24T00:01:00Z' }), empty);
  await store.observe(overview({ status: SessionStatus.IsArchived | SessionStatus.Idle, modifiedAt: '2026-11-24T00:02:00Z' }), empty);
  assert.equal(unreadCount(store, MAC), 1);
});

test('потоковая сводка без перехода не пишет файл, но обновляет снимок', async t => {
  const dir = await stateDir(t);
  const writes: unknown[] = [];
  const store = await createSessionUserState({
    dir,
    write: async (path, value) => {
      writes.push(value);
      await writePrivate(path, value);
    },
  });
  await store.rememberOrigin(MAC);
  writes.length = 0;
  const empty = new Map<string, Set<string>>();
  await store.observe(overview({ status: SessionStatus.InProgress, modifiedAt: '2026-11-24T00:01:00Z', activity: 'Отвечает' }), empty);
  await store.observe(overview({ status: SessionStatus.InProgress, modifiedAt: '2026-11-24T00:02:00Z', activity: 'Печатает' }), empty);
  assert.deepEqual(writes, []);
  await store.observe(overview({ status: SessionStatus.Idle, modifiedAt: '2026-11-24T00:03:00Z' }), empty);
  assert.equal(writes.length, 1);
  assert.equal(unreadCount(store, MAC), 1);
});

test('ошибка записи не останавливает детектор, следующая мутация сохраняет накопленное', async t => {
  const dir = await stateDir(t);
  let fail = false;
  const store = await createSessionUserState({
    dir,
    write: async (path, value) => {
      if (fail) throw new Error('disk is full');
      await writePrivate(path, value);
    },
  });
  await store.rememberOrigin(MAC);
  const empty = new Map<string, Set<string>>();
  await store.observe(overview({ status: SessionStatus.InProgress, modifiedAt: '2026-11-24T00:01:00Z' }), empty);
  fail = true;
  const changed = await store.observe(overview({ status: SessionStatus.Idle, modifiedAt: '2026-11-24T00:02:00Z' }), empty);
  assert.equal(changed, true);
  assert.equal(unreadCount(store, MAC), 1);
  // Следующая сводка всё ещё обрабатывается, а успешная мутация записывает накопленное.
  await store.observe(overview({ status: SessionStatus.InProgress, modifiedAt: '2026-11-24T00:03:00Z' }), empty);
  fail = false;
  await store.rememberOrigin(PHONE);
  const saved = JSON.parse(await readFile(join(dir, 'session-user-state.json'), 'utf8')) as {
    unread: { counts: Record<string, number> }[];
  };
  assert.deepEqual(saved.unread.map(entry => entry.counts), [{ [MAC]: 1 }]);
});

test('setPinned при ошибке записи не коммитит pin', async t => {
  const dir = await stateDir(t);
  await writeFile(join(dir, 'session-user-state.json'), '{"version":1,"origins":[],"pinned":[],"unread":[]}\n');
  const store = await createSessionUserState({
    dir,
    write: async () => { throw new Error('read-only'); },
  });
  await assert.rejects(store.setPinned('local', SESSION, true), SessionUserStateFailure);
  assert.deepEqual(store.viewFor(MAC).pinned, []);
});

test('сброс при видимости удаляет запись, не оставляя count: 0', async t => {
  const dir = await stateDir(t);
  const store = await remembered(dir, MAC);
  const empty = new Map<string, Set<string>>();
  await store.observe(overview({ status: SessionStatus.InProgress, modifiedAt: '2026-11-24T00:01:00Z' }), empty);
  await store.observe(overview({ status: SessionStatus.Idle, modifiedAt: '2026-11-24T00:02:00Z' }), empty);
  await store.setPinned('local', OTHER, true);
  assert.equal(unreadCount(store, MAC), 1);

  assert.equal(await store.markVisible(MAC, 'local', SESSION), true);
  assert.equal(await store.markVisible(MAC, 'local', SESSION), false);
  assert.deepEqual(store.viewFor(MAC).unread, []);

  const path = join(dir, 'session-user-state.json');
  const saved = JSON.parse(await readFile(path, 'utf8')) as { unread: unknown[] };
  assert.deepEqual(saved.unread, []);
  const message = { t: 'sessionUserState', state: store.viewFor(MAC) } as const;
  assert.deepEqual(parseServerMessage(JSON.stringify(message)), message);
});

test('сброс через observe при видимой сессии идемпотентен', async t => {
  const dir = await stateDir(t);
  const store = await remembered(dir, MAC, PHONE);
  await store.observe(overview({ status: SessionStatus.InProgress, modifiedAt: '2026-11-24T00:01:00Z' }), new Map());
  await store.observe(overview({ status: SessionStatus.Idle, modifiedAt: '2026-11-24T00:02:00Z' }), visible(SESSION));
  assert.deepEqual(store.viewFor(MAC).unread, []);
  assert.equal(unreadCount(store, PHONE), 1);
});

test('файл с пустыми и нулевыми счётчиками нормализуется при загрузке', async t => {
  const dir = await stateDir(t);
  const path = join(dir, 'session-user-state.json');
  await writeFile(path, JSON.stringify({
    version: 1,
    origins: [PHONE],
    pinned: [{ hostId: 'local', sessionUri: SESSION }],
    unread: [
      { hostId: 'local', sessionUri: SESSION, counts: { [PHONE]: 0 } },
      { hostId: 'local', sessionUri: OTHER, counts: {} },
      { hostId: 'local', sessionUri: 'ahp-session:/valid', counts: { [PHONE]: 2, [MAC]: -1 } },
    ],
  }));
  const store = await createSessionUserState({ dir });
  assert.deepEqual(store.viewFor(PHONE).unread, [{ hostId: 'local', sessionUri: 'ahp-session:/valid', count: 2 }]);
  await store.setPinned('local', OTHER, true);
  const saved = JSON.parse(await readFile(path, 'utf8')) as { unread: unknown[] };
  assert.deepEqual(saved.unread, [{ hostId: 'local', sessionUri: 'ahp-session:/valid', counts: { [PHONE]: 2 } }]);
});

test('удаление сессии вычищает pin, счётчики и снимок', async t => {
  const dir = await stateDir(t);
  const store = await remembered(dir, MAC);
  const empty = new Map<string, Set<string>>();
  await store.setPinned('local', SESSION, true);
  await store.observe(overview({ status: SessionStatus.InProgress, modifiedAt: '2026-11-24T00:01:00Z' }), empty);
  await store.observe(overview({ status: SessionStatus.Idle, modifiedAt: '2026-11-24T00:02:00Z' }), empty);
  assert.equal(await store.forgetSession('local', SESSION), true);
  assert.equal(await store.forgetSession('local', SESSION), false);
  const state = store.viewFor(MAC);
  assert.deepEqual(state, { pinned: [], unread: [] });

  const reopened = await createSessionUserState({ dir });
  assert.deepEqual((reopened.viewFor(MAC) as SessionUserState), { pinned: [], unread: [] });
  const saved = JSON.parse(await readFile(join(dir, 'session-user-state.json'), 'utf8')) as { pinned: unknown[]; unread: unknown[] };
  assert.deepEqual(saved.pinned, []);
  assert.deepEqual(saved.unread, []);
});

test('битый файл отключает состояние и не перезаписывается', async t => {
  const dir = await stateDir(t);
  const path = join(dir, 'session-user-state.json');
  const broken = '{"version":1,"origins":[],"pinned":';
  await writeFile(path, broken);
  await assert.rejects(createSessionUserState({ dir }), SessionUserStateFailure);
  assert.equal(await readFile(path, 'utf8'), broken);

  await writeFile(path, '{"version":2,"origins":[],"pinned":[],"unread":[]}');
  await assert.rejects(createSessionUserState({ dir }), SessionUserStateFailure);
});

test('параллельные операции не теряют записи', async t => {
  const dir = await stateDir(t);
  const store = await remembered(dir, MAC);
  const empty = new Map<string, Set<string>>();
  await store.observe(overview({ status: SessionStatus.InProgress, modifiedAt: '2026-11-24T00:01:00Z' }), empty);
  await store.observe(overview({ status: SessionStatus.Idle, modifiedAt: '2026-11-24T00:02:00Z' }), empty);
  await Promise.all([
    store.setPinned('local', SESSION, true),
    store.markVisible(MAC, 'local', SESSION),
    store.observe(overview({ status: SessionStatus.Idle, modifiedAt: '2026-11-24T00:03:00Z' }), empty),
  ]);
  const state = store.viewFor(MAC);
  assert.deepEqual(state.pinned, [{ hostId: 'local', sessionUri: SESSION }]);
  assert.deepEqual(state.unread, []);

  const reopened = await createSessionUserState({ dir });
  assert.deepEqual(reopened.viewFor(MAC).pinned, [{ hostId: 'local', sessionUri: SESSION }]);
  assert.deepEqual(reopened.viewFor(MAC).unread, []);
});

test('сгенерированное сообщение о состоянии проходит парсер протокола', async t => {
  const dir = await stateDir(t);
  const store = await remembered(dir, MAC);
  await store.setPinned('local', SESSION, true);
  const empty = new Map<string, Set<string>>();
  await store.observe(overview({ status: SessionStatus.InProgress, modifiedAt: '2026-11-24T00:01:00Z' }), empty);
  await store.observe(overview({ status: SessionStatus.Idle, modifiedAt: '2026-11-24T00:02:00Z' }), empty);
  const message = { t: 'sessionUserState', state: store.viewFor(MAC) } as const;
  assert.deepEqual(parseServerMessage(JSON.stringify(message)), message);
  assert.deepEqual(parseServerMessage(JSON.stringify({ t: 'sessionUserState', state: store.viewFor(PHONE) })), {
    t: 'sessionUserState',
    state: store.viewFor(PHONE),
  });
});
