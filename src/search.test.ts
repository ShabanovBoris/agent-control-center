import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ChatInteractivity, ChatOriginKind, MessageKind, ResponsePartKind, SessionStatus, TurnState,
  type ChatState, type ResponsePart, type SessionSummary, type Turn,
} from '@microsoft/agent-host-protocol';
import type { Overview, SearchHistoryResult, SessionOverview } from '../shared/protocol';
import { channelKey } from '../shared/reduce';
import { highlightRanges, makeSnippet, makeField, prepareQuery, scoreFields, turnSearchFields, type SearchField } from '../shared/search';
import { visibleTurns } from '../shared/turns';
import {
  DEFAULT_PALETTE_LIMITS, buildLoadedCorpus, deepToPalette, mergeSearchResults, recentSessionResults,
  recentSessions, searchComplete, searchLoaded, searchOverview, searchStatusText, type PaletteResult,
} from './search';
import { pinnedKeys } from './session-list';

const at = '2026-11-20T10:00:00.000Z';

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    resource: 'ahp-session:/one', createdAt: at, modifiedAt: at, provider: 'codex',
    title: 'Deploy pipeline', status: SessionStatus.Idle,
    workingDirectories: ['file:///Users/me/deploy-project'],
    chats: [{ resource: 'ahp-chat:/main', title: 'Основной чат', status: SessionStatus.Idle }],
    ...overrides,
  };
}

function session(overrides: Partial<SessionSummary> = {}): SessionOverview {
  return { hostId: 'h', hostLabel: 'MacBook', summary: summary(overrides) };
}

function overview(sessions: SessionOverview[] = [session()]): Overview {
  return {
    hosts: [{ id: 'h', label: 'MacBook', status: 'connected', agents: [{ provider: 'codex', displayName: 'Codex Agent', models: [] }] }],
    sessions,
  };
}

function turn(id: string, message: string, parts: ResponsePart[] = []): Turn {
  return { id, startedAt: at, message: { text: message, origin: { kind: MessageKind.User } }, responseParts: parts, usage: undefined, state: TurnState.Complete };
}

function chat(overrides: Partial<ChatState> = {}): ChatState {
  return {
    resource: 'ahp-chat:/main', title: 'Основной чат', status: SessionStatus.Idle, modifiedAt: at,
    turns: [turn('second', 'deploy redis')], ...overrides,
  };
}

function history(hits: SearchHistoryResult['hits'] = [], overrides: Partial<SearchHistoryResult> = {}): SearchHistoryResult {
  return { hits, candidateChats: 1, scannedChats: 1, scannedTurns: 1, reasons: [], issues: [], ...overrides };
}

test('нормализация: регистр, ё и пунктуация, лимит токенов', () => {
  const query = prepareQuery('  DEPLOY, Ёлка! Ёлка ')!!;
  assert.deepEqual(query.tokens, ['deploy', 'елка']);
  assert.equal(query.truncated, false);
  assert.equal(prepareQuery('!!! ???'), undefined);
  const limited = prepareQuery('one two three', { maxQueryChars: 200, maxQueryTokens: 2 })!;
  assert.deepEqual(limited.tokens, ['one', 'two']);
  assert.equal(limited.truncated, true);
  assert.equal(prepareQuery('x'.repeat(10), { maxQueryChars: 4, maxQueryTokens: 5 })!.truncated, true);
});

test('качество совпадения: поле целиком, префикс, слово и подстрока различаются', () => {
  const quality = (text: string) => scoreFields([makeField('message', text)!], ['deploy'])!.score;
  assert.ok(quality('deploy') > quality('deploy pipeline'));
  assert.ok(quality('deploy pipeline') > quality('please deploy now'));
  assert.ok(quality('please deploy now') > quality('redeployed'));
  assert.equal(scoreFields([makeField('message', 'unrelated')!], ['deploy']), undefined);
});

test('AND по токенам и вес поля: заголовок важнее ответа', () => {
  const title = makeField('title', 'Deploy redis')!;
  const message = makeField('message', 'Deploy redis')!;
  assert.ok(scoreFields([title], ['deploy', 'redis'])!.score > scoreFields([message], ['deploy', 'redis'])!.score);
  assert.equal(scoreFields([message], ['deploy', 'kafka']), undefined);
  assert.deepEqual(scoreFields([message], ['deploy'])!.field.kind, 'message');
});

test('сниппет режет окно и подсвечивает совпадения в исходных координатах', () => {
  const text = `${'начало '.repeat(30)}Ёжик deploy ${'хвост '.repeat(30)}`;
  const field = makeField('message', text)!;
  const snippet = makeSnippet(field, ['ёжик', 'deploy']);
  assert.ok(snippet.text.length < text.length);
  assert.ok(snippet.text.startsWith('…') || snippet.text.length < 220);
  assert.ok(snippet.ranges.length >= 2);
  for (const [start, end] of snippet.ranges) assert.ok(start >= 0 && end <= snippet.text.length && end > start);
  assert.deepEqual(highlightRanges('Ёлка', ['елка']), [[0, 4]]);
});

test('поля хода: сообщение, ответ, reasoning, уведомления и ошибки; activeTurn не индексируется', () => {
  const fields = turnSearchFields(turn('t', 'вопрос', [
    { kind: ResponsePartKind.Markdown, id: 'm1', content: '**ответ**' },
    { kind: ResponsePartKind.Reasoning, id: 'r1', content: 'рассуждение' },
    { kind: ResponsePartKind.SystemNotification, content: 'уведомление' },
    { kind: ResponsePartKind.Error, error: { errorType: 'unknown', message: 'ошибка' } },
  ]), 100_000).fields;
  assert.deepEqual(fields.map(field => field.kind).sort(), ['error', 'message', 'notification', 'reasoning', 'response']);
  assert.ok(fields.some(field => field.text.includes('**ответ**')));
  const truncated = turnSearchFields(turn('long', 'x'.repeat(50)), 10);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.fields[0]!.text.length, 10);
});

test('боковая ветка прячет унаследованный префикс из поиска', () => {
  const state = chat({
    origin: { kind: ChatOriginKind.SideChat, chat: 'ahp-chat:/source', turnId: 'inherited' },
    turns: [turn('inherited', 'скрытый'), turn('own', 'видимый')],
  });
  assert.deepEqual(visibleTurns(state).map(item => item.id), ['own']);
});

test('overview-поиск: название, провайдер, хост, папка и чат; скрытые чаты исключены', () => {
  const hidden = { resource: 'ahp-chat:/hidden', title: 'Deploy hidden', status: SessionStatus.Idle, interactivity: ChatInteractivity.Hidden };
  const facts = overview([session({ chats: [...summary().chats!, hidden] })]);
  const byTitle = searchOverview(facts, new Map(), prepareQuery('deploy'), DEFAULT_PALETTE_LIMITS);
  assert.equal(byTitle[0]?.kind, 'session');
  assert.ok(byTitle[0]!.title.ranges.length > 0);
  assert.ok(searchOverview(facts, new Map(), prepareQuery('codex agent'), DEFAULT_PALETTE_LIMITS).some(item => item.kind === 'session'));
  assert.ok(searchOverview(facts, new Map(), prepareQuery('macbook'), DEFAULT_PALETTE_LIMITS).some(item => item.kind === 'session'));
  assert.ok(searchOverview(facts, new Map(), prepareQuery('deploy-project'), DEFAULT_PALETTE_LIMITS).some(item => item.kind === 'session'));
  assert.ok(searchOverview(facts, new Map(), prepareQuery('основной'), DEFAULT_PALETTE_LIMITS).some(item => item.kind === 'chat'));
  assert.equal(searchOverview(facts, new Map(), prepareQuery('hidden'), DEFAULT_PALETTE_LIMITS).length, 0);
});

test('локальный корпус: только watched-чаты, без activeTurn и с пометкой неполноты', () => {
  const facts = overview();
  const state = chat({ turns: [turn('one', 'deploy old'), turn('two', 'deploy new')], turnsNextCursor: 'older' });
  const channels = new Map([[channelKey('h', 'ahp-chat:/main'), { state }]]);
  const corpus = buildLoadedCorpus(facts, channels);
  assert.equal(corpus.docs.length, 2);
  assert.equal(corpus.incomplete, true, 'курсор означает неполную историю');
  const results = searchLoaded(corpus, prepareQuery('deploy'));
  assert.equal(results.length, 2);
  assert.equal(results[0]!.origin, 'loaded');
  assert.ok(results[0]!.snippet!.text.includes('deploy'));

  const active = chat({ activeTurn: { id: 'active', startedAt: at, message: { text: 'deploy streaming', origin: { kind: MessageKind.User } }, responseParts: [], usage: undefined } });
  const activeCorpus = buildLoadedCorpus(facts, new Map([[channelKey('h', 'ahp-chat:/main'), { state: active }]]));
  assert.equal(activeCorpus.docs.some(doc => doc.turnId === 'active'), false);
});

test('merge: deep важнее при большем score, локальный — при равенстве', () => {
  const base: PaletteResult = {
    key: 'turn:h:ahp-chat:/main:one', kind: 'turn', title: { text: 'Deploy', ranges: [] },
    hostId: 'h', sessionUri: 'ahp-session:/one', chatUri: 'ahp-chat:/main', turnId: 'one',
    sessionTitle: 'Deploy', context: '', archived: false, origin: 'loaded', modifiedAt: at, score: 10,
  };
  assert.equal(mergeSearchResults([base], [{ ...base, origin: 'history', score: 12 }])[0]!.origin, 'history');
  assert.equal(mergeSearchResults([base], [{ ...base, origin: 'history', score: 10 }])[0]!.origin, 'loaded');
  const unique = { ...base, key: 'turn:h:ahp-chat:/main:two', turnId: 'two', origin: 'history' as const };
  assert.equal(mergeSearchResults([base], [unique]).length, 2);
});

test('deep-результат не теряет ход, даже если сессия исчезла из overview', () => {
  const result = history([{
    hostId: 'h', sessionUri: 'ahp-session:/gone', chatUri: 'ahp-chat:/gone', turnId: 't',
    score: 5, field: 'response', snippet: 'deploy', ranges: [[0, 6]],
  }]);
  const [item] = deepToPalette(result, overview());
  assert.equal(item?.kind, 'turn');
  assert.equal(item?.turnId, 't');
  assert.equal(item?.sessionTitle, 'ahp-session:/gone');
});

test('статус не обещает «ничего не найдено», пока история проверена не полностью', () => {
  const incomplete = history([], { reasons: ['page-budget'], scannedChats: 1, candidateChats: 2 });
  assert.match(searchStatusText({ phase: 'done', result: incomplete, localIncomplete: false, localErrors: [], ready: true }), /проверена не полностью/);
  assert.equal(searchComplete(incomplete), false);
  const complete = history([], { scannedChats: 2, candidateChats: 2 });
  assert.match(searchStatusText({ phase: 'done', result: complete, localIncomplete: false, localErrors: [], ready: true }), /^Ничего не найдено\./);
  assert.match(searchStatusText({ phase: 'error', error: 'нет связи', localIncomplete: false, localErrors: [], ready: true }), /нет связи/);
  assert.match(searchStatusText({ phase: 'done', result: complete, localIncomplete: true, localErrors: [], ready: true }), /проверена не полностью/);
});

test('закреплённая сессия идёт первой в «Недавних», остальной порядок прежний', () => {
  const older = session({ resource: 'ahp-session:/older', title: 'Старая', modifiedAt: '2026-11-01T10:00:00.000Z' });
  const newer = session({ resource: 'ahp-session:/newer', title: 'Новая', modifiedAt: '2026-11-20T10:00:00.000Z' });
  const pinned = pinnedKeys([{ hostId: 'h', sessionUri: 'ahp-session:/older' }]);

  assert.deepEqual(recentSessions(overview([newer, older]), 8, pinned).map(item => item.summary.resource), [
    'ahp-session:/older', 'ahp-session:/newer',
  ]);
  assert.deepEqual(recentSessions(overview([newer, older])).map(item => item.summary.resource), [
    'ahp-session:/newer', 'ahp-session:/older',
  ]);
  // Pin меняет порядок, но не состав: ограничение применяется после сортировки.
  assert.deepEqual(recentSessions(overview([newer, older]), 1, pinned).map(item => item.summary.resource), [
    'ahp-session:/older',
  ]);
});

test('закреплённая архивная сессия не попадает в «Недавние»', () => {
  const active = session({ resource: 'ahp-session:/active', modifiedAt: '2026-11-01T10:00:00.000Z' });
  const archivedSession = session({
    resource: 'ahp-session:/archived', title: 'Архивная', modifiedAt: '2026-11-20T10:00:00.000Z',
    status: SessionStatus.IsArchived,
  });
  const pinned = pinnedKeys([{ hostId: 'h', sessionUri: 'ahp-session:/archived' }]);
  assert.deepEqual(recentSessions(overview([archivedSession, active]), 8, pinned).map(item => item.summary.resource), [
    'ahp-session:/active',
  ]);
  assert.deepEqual(recentSessionResults(overview([archivedSession, active]), 8, pinned).map(item => item.kind), ['session']);
  assert.equal(recentSessionResults(overview([archivedSession, active]), 8, pinned)[0]?.sessionUri, 'ahp-session:/active');
});
