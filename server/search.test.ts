import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ChatInteractivity, MessageKind, SessionStatus, TurnState,
  type ChatState, type SessionChatSummary, type SessionState, type Turn,
} from '@microsoft/agent-host-protocol';
import type { SearchHistoryResult, SessionOverview } from '../shared/protocol.js';
import { makeField } from '../shared/search.js';
import { liveFingerprint, SearchCache, type SearchDoc } from './search-cache.js';
import {
  DEFAULT_SEARCH_LIMITS, HistorySearch, Semaphore, collectCandidates,
  type SearchEnvironment, type SearchLimits,
} from './search.js';

const at = '2026-11-20T10:00:00.000Z';
const sessionUri = 'ahp-session:/one';
const chatUri = 'ahp-chat:/main';
const otherChatUri = 'ahp-chat:/other';

const summary = {
  resource: sessionUri, createdAt: at, modifiedAt: at, provider: 'codex', title: 'Deploy', status: SessionStatus.Idle,
  chats: [
    { resource: chatUri, title: 'Main', status: SessionStatus.Idle },
    { resource: otherChatUri, title: 'Other', status: SessionStatus.Idle },
  ] as SessionChatSummary[],
};
const session: SessionOverview = { hostId: 'h', hostLabel: 'Host', summary };

function turn(id: string, text: string): Turn {
  return { id, startedAt: at, message: { text, origin: { kind: MessageKind.User } }, responseParts: [], usage: undefined, state: TurnState.Complete };
}

function chat(turns: Turn[], cursor?: string): ChatState {
  return { resource: chatUri, title: 'Main', status: SessionStatus.Idle, modifiedAt: at, turns, ...(cursor ? { turnsNextCursor: cursor } : {}) };
}

function doc(turnId: string, text: string): SearchDoc {
  return { turnId, fields: [makeField('message', text)!], truncated: false };
}

function limits(overrides: Partial<SearchLimits> = {}): SearchLimits {
  return { ...DEFAULT_SEARCH_LIMITS, ...overrides };
}

interface HarnessOptions {
  chats?: ChatState[];
  sessions?: SessionOverview[];
  hostStatus?: 'connected' | 'disconnected';
  fetch?: (uri: string, cursor: string, state: ChatState) => ChatState;
  open?: (uri: string) => ChatState;
}

function harness(options: HarnessOptions = {}) {
  const initial = options.chats ?? [chat([turn('two', 'deploy tail')], 'p1')];
  const defaultSession: SessionOverview = {
    hostId: 'h', hostLabel: 'Host',
    summary: {
      ...session.summary,
      chats: initial.map(item => ({ resource: item.resource, title: item.title, status: item.status, modifiedAt: item.modifiedAt })),
    },
  };
  const opened: string[] = [];
  const released: string[] = [];
  const fetched: string[] = [];
  const live = new Map<string, ChatState>();
  const sessionState: SessionState = {
    title: 'Deploy', status: SessionStatus.Idle, provider: 'codex',
    lifecycle: 'ready', activeClients: [],
    chats: defaultSession.summary.chats!.map(item => ({ ...item, modifiedAt: at })), defaultChat: chatUri,
  } as SessionState;
  const env: SearchEnvironment = {
    sessions: () => options.sessions ?? [defaultSession],
    hostStatus: () => options.hostStatus ?? 'connected',
    mirrorChat: (_hostId, uri) => live.get(uri),
    mirrorSession: () => sessionState,
    openChat: async (_hostId, uri) => {
      opened.push(uri);
      const state = options.open?.(uri) ?? initial.find(item => item.resource === uri) ?? initial[0]!;
      live.set(uri, state);
      return state;
    },
    releaseChat: (_hostId, uri) => { released.push(uri); live.delete(uri); },
    fetchOlderTurns: async (_hostId, uri, cursor) => {
      fetched.push(`${uri}:${cursor}`);
      const state = live.get(uri) ?? initial[0]!;
      const next = options.fetch?.(uri, cursor, state) ?? chat([turn('one', 'deploy older'), ...state.turns]);
      live.set(uri, next);
      return next;
    },
  };
  return { env, opened, released, fetched };
}

test('SearchCache: TTL, modifiedAt, живой fingerprint и забывание', () => {
  const cache = new SearchCache({ ttlMs: 1000, maxChats: 4, maxChars: 10_000 });
  const entry = { hostId: 'h', sessionUri, chatUri, sessionModifiedAt: at, docs: [doc('t', 'deploy')], storedAt: 100 };
  cache.set(entry);
  assert.ok(cache.get('h', chatUri, { sessionModifiedAt: at }, 500));
  assert.equal(cache.get('h', chatUri, { sessionModifiedAt: at }, 2000), undefined);
  cache.set({ ...entry, storedAt: 100 });
  assert.equal(cache.get('h', chatUri, { sessionModifiedAt: 'later' }, 500), undefined);

  const state = chat([turn('one', 'deploy')]);
  cache.set({ ...entry, storedAt: 100, liveFingerprint: liveFingerprint(state) });
  assert.ok(cache.get('h', chatUri, { sessionModifiedAt: at, live: state }, 500));
  const changed = chat([turn('one', 'deploy'), turn('two', 'more')]);
  assert.equal(cache.get('h', chatUri, { sessionModifiedAt: at, live: changed }, 500), undefined);

  cache.set(entry);
  cache.forgetSession('h', sessionUri);
  assert.equal(cache.size, 0);
  cache.set(entry);
  cache.forgetHost('h');
  assert.equal(cache.size, 0);
});

test('SearchCache вытесняет старые чаты по количеству и объёму', () => {
  const cache = new SearchCache({ ttlMs: 10_000, maxChats: 2, maxChars: 10_000 });
  for (const uri of ['a', 'b', 'c']) {
    cache.set({ hostId: 'h', sessionUri, chatUri: uri, sessionModifiedAt: at, docs: [doc(uri, 'x')], storedAt: Date.now() });
  }
  assert.equal(cache.size, 2);
  assert.equal(cache.get('h', 'a', { sessionModifiedAt: at }), undefined, 'самый старый вытеснен');
  const tiny = new SearchCache({ ttlMs: 10_000, maxChats: 10, maxChars: 5 });
  tiny.set({ hostId: 'h', sessionUri, chatUri: 'a', sessionModifiedAt: at, docs: [doc('a', '1234')], storedAt: Date.now() });
  tiny.set({ hostId: 'h', sessionUri, chatUri: 'b', sessionModifiedAt: at, docs: [doc('b', '1234')], storedAt: Date.now() });
  assert.equal(tiny.size, 1);
});

test('кандидаты: скрытые чаты исключены, архив после активных, отключённый хост и пустой каталог видны', () => {
  const hidden = { resource: 'ahp-chat:/hidden', title: 'Hidden', status: SessionStatus.Idle, modifiedAt: at, interactivity: ChatInteractivity.Hidden };
  const active: SessionOverview = { hostId: 'h', hostLabel: 'Host', summary: { ...summary, title: 'Fresh', modifiedAt: '2026-11-21T00:00:00.000Z', chats: [summary.chats![0]!, hidden] } };
  const archived: SessionOverview = { hostId: 'h', hostLabel: 'Host', summary: { ...summary, resource: 'ahp-session:/archived', status: SessionStatus.IsArchived, modifiedAt: '2026-11-22T00:00:00.000Z' } };
  const list = collectCandidates([archived, active], () => 'connected', () => undefined, 10);
  assert.deepEqual(list.candidates.map(candidate => candidate.chatUri), [chatUri, chatUri, otherChatUri]);
  assert.equal(list.candidateChats, 3, 'скрытый чат не считается');
  assert.deepEqual(list.issues, []);

  const offline = collectCandidates([active], () => 'disconnected', () => undefined, 10);
  assert.equal(offline.candidates.length, 0);
  assert.match(offline.issues[0]!.message, /не подключён/);

  const empty = collectCandidates([{ ...active, summary: { ...active.summary, chats: [] } }], () => 'connected', () => undefined, 10);
  assert.match(empty.issues[0]!.message, /каталог чатов/);

  const trimmed = collectCandidates([active], () => 'connected', () => undefined, 1);
  assert.equal(trimmed.candidates.length, 1);
  assert.equal(trimmed.candidateChats, 1);
});

test('Semaphore: лимит, FIFO, отмена ожидания и быстрый захват', async () => {
  const semaphore = new Semaphore(1);
  assert.equal(semaphore.tryAcquire(), true);
  assert.equal(semaphore.tryAcquire(), false);
  let second = false;
  const waiting = semaphore.acquire().then(() => { second = true; });
  semaphore.release();
  await waiting;
  assert.equal(second, true);
  assert.equal(semaphore.pending, 1);
  semaphore.release();

  const abort = new AbortController();
  const blocked = new Semaphore(1);
  await blocked.acquire();
  const cancelled = blocked.acquire(abort.signal);
  abort.abort(new Error('stop'));
  await assert.rejects(cancelled, /stop/);
  assert.equal(blocked.pending, 1);
  blocked.release();
});

test('поиск читает хвост и страницы, кэширует полный корпус и освобождает чат', async () => {
  const fixture = harness();
  const search = new HistorySearch(fixture.env, limits());
  const first = await search.search('deploy', new AbortController().signal);
  assert.deepEqual(first.hits.map(hit => hit.turnId).sort(), ['one', 'two']);
  assert.deepEqual(first.reasons, []);
  assert.deepEqual(first.issues, []);
  assert.equal(first.scannedTurns, 2);
  assert.deepEqual(fixture.opened, [chatUri]);
  assert.deepEqual(fixture.released, [chatUri]);
  assert.deepEqual(fixture.fetched, [`${chatUri}:p1`]);

  const second = await search.search('older', new AbortController().signal);
  assert.deepEqual(second.hits.map(hit => hit.turnId), ['one']);
  assert.deepEqual(fixture.opened, [chatUri], 'повторный поиск не открывает чат заново');
  assert.deepEqual(fixture.fetched, [`${chatUri}:p1`]);
});

test('бюджет страниц и повторный курсор не зацикливаются и видны в reasons/issues', async () => {
  const fixture = harness({ fetch: (_uri, _cursor, state) => chat(state.turns, 'p1') });
  const search = new HistorySearch(fixture.env, limits({ maxPagesPerChat: 1 }));
  const result = await search.search('deploy', new AbortController().signal);
  assert.deepEqual(result.reasons, ['page-budget']);
  assert.match(result.issues[0]!.message, /не продвинул курсор/);
  assert.equal(result.hits.length, 1);
  // Неполный корпус не кэшируется: следующий поиск снова его читает.
  await search.search('deploy', new AbortController().signal);
  assert.deepEqual(fixture.opened, [chatUri, chatUri]);
});

test('бюджет чатов и совпадений попадает в reasons', async () => {
  const otherSession: SessionOverview = {
    ...session,
    summary: { ...summary, chats: [summary.chats![1]!] },
  };
  const fixture = harness({
    sessions: [session, otherSession],
    chats: [chat([turn('two', 'deploy tail')]), { ...chat([turn('other', 'deploy other')]), resource: otherChatUri }],
    fetch: (_uri, _cursor, state) => chat(state.turns),
  });
  const byChats = await new HistorySearch(fixture.env, limits({ maxChats: 1 })).search('deploy', new AbortController().signal);
  assert.ok(byChats.reasons.includes('chat-budget'));

  const many = harness({
    chats: [chat([turn('second', 'deploy'), turn('third', 'deploy')])],
    fetch: (_uri, _cursor, state) => chat(state.turns),
  });
  const byHits = await new HistorySearch(many.env, limits({ maxHits: 1 })).search('deploy', new AbortController().signal);
  assert.equal(byHits.hits.length, 1);
  assert.ok(byHits.reasons.includes('hit-budget'));
});

test('ошибка одного чата не скрывает результаты другого', async () => {
  const fixture = harness({
    chats: [chat([turn('one', 'deploy main')]), { ...chat([turn('other', 'deploy other')]), resource: otherChatUri }],
    fetch: (_uri, _cursor, state) => chat(state.turns),
    open: uri => { if (uri === otherChatUri) throw new Error('host refused'); return chat([turn('one', 'deploy main')]); },
  });
  const result = await new HistorySearch(fixture.env, limits()).search('deploy', new AbortController().signal);
  assert.equal(result.hits.length, 1);
  assert.match(result.issues[0]!.message, /host refused/);
  assert.deepEqual(fixture.released, [chatUri], 'неудачное открытие освобождает подписку само');
});

test('отмена поиска не превращается в ошибку хоста и освобождает канал', async () => {
  const fixture = harness({
    open: () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); },
  });
  // openChat должен ждать сигнал, поэтому подменяем его на ожидание отмены.
  fixture.env.openChat = (_hostId, uri, signal) => {
    fixture.opened.push(uri);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const controller = new AbortController();
  const search = new HistorySearch(fixture.env, limits());
  const running = search.search('deploy', controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(running, /Поиск отменён/);
});

test('результат несёт сниппет и диапазоны для подсветки', async () => {
  const fixture = harness({
    chats: [chat([turn('one', 'please deploy now')])],
    fetch: (_uri, _cursor, state) => chat(state.turns),
  });
  const result: SearchHistoryResult = await new HistorySearch(fixture.env, limits()).search('deploy', new AbortController().signal);
  assert.equal(result.hits[0]!.snippet, 'please deploy now');
  assert.deepEqual(result.hits[0]!.ranges, [[7, 13]]);
  assert.equal(result.hits[0]!.field, 'message');
});

test('поля запроса ограничиваются до поиска', async () => {
  const search = new HistorySearch(harness().env, limits());
  await assert.rejects(search.search('x', new AbortController().signal), /минимум два символа/);
  await assert.rejects(search.search('  ', new AbortController().signal), /Пустой/);
});

