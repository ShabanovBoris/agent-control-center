import { ChatInteractivity, ChatOriginKind, SessionStatus, type ChatState, type SessionChatSummary, type SessionState, type Turn } from '@microsoft/agent-host-protocol';
import type {
  ChannelState,
  MetadataFieldKind,
  Overview,
  SearchHistoryResult,
  SearchHit,
  SearchIssue,
  SessionOverview,
  TurnFieldKind,
} from '../shared/protocol';
import { DEFAULT_QUERY_LIMITS, highlightRanges, makeField, makeSnippet, scoreFields, turnSearchFields, type PreparedQuery, type QueryLimits, type SearchField } from '../shared/search';
import { pathOf } from '../shared/text';
import { visibleTurns } from '../shared/turns';
import { channelKey } from '../shared/reduce';
import { timeAgo } from './format';
import { sortSessions } from './session-list';

export interface ChannelLike {
  state?: ChannelState;
  error?: string;
  missing?: boolean;
}

export type ChannelMap = ReadonlyMap<string, ChannelLike>;

export interface PaletteLimits {
  maxResults: number;
  maxLocalTurns: number;
  maxLocalChars: number;
  maxCharsPerTurn: number;
  query: QueryLimits;
}

export const DEFAULT_PALETTE_LIMITS: PaletteLimits = {
  maxResults: 50,
  maxLocalTurns: 2000,
  maxLocalChars: 2_000_000,
  maxCharsPerTurn: 100_000,
  query: DEFAULT_QUERY_LIMITS,
};

export interface TextMatch {
  text: string;
  ranges: readonly (readonly [number, number])[];
}

export interface PaletteResult {
  /** Стабильный ключ строки: deep-результаты могут переупорядочить список. */
  key: string;
  kind: 'session' | 'chat' | 'turn';
  title: TextMatch;
  snippet?: TextMatch & { label: string };
  hostId: string;
  sessionUri: string;
  chatUri?: string;
  turnId?: string;
  sessionTitle: string;
  chatTitle?: string;
  context: string;
  archived: boolean;
  origin?: 'loaded' | 'history';
  modifiedAt: string;
  startedAt?: string;
  score: number;
}

const FIELD_LABEL: Record<TurnFieldKind, string> = {
  message: 'Сообщение',
  response: 'Ответ',
  reasoning: 'Рассуждение',
  notification: 'Уведомление',
  error: 'Ошибка',
};

const METADATA_LABEL: Record<MetadataFieldKind, string> = {
  title: 'Название',
  chat: 'Чат',
  provider: 'Провайдер',
  host: 'Хост',
  path: 'Папка',
};

function archived(status: number): boolean {
  return (status & SessionStatus.IsArchived) !== 0;
}

export function chatCatalog(overview: Overview, channels: ChannelMap, session: SessionOverview): readonly SessionChatSummary[] {
  const live = channels.get(channelKey(session.hostId, session.summary.resource))?.state as SessionState | undefined;
  return (live?.chats ?? session.summary.chats ?? []) as readonly SessionChatSummary[];
}

function displayProvider(overview: Overview, hostId: string, provider: string | undefined): string {
  if (!provider) return '';
  const agent = overview.hosts.find(host => host.id === hostId)?.agents.find(candidate => candidate.provider === provider);
  return agent && agent.displayName !== provider ? `${provider} (${agent.displayName})` : provider;
}

function sessionFields(overview: Overview, session: SessionOverview): SearchField[] {
  const { summary, hostId, hostLabel } = session;
  const provider = displayProvider(overview, hostId, summary.provider);
  const paths = (summary.workingDirectories ?? []).map(pathOf).join('\n');
  return (['title', 'provider', 'host', 'path'] as const).flatMap(kind => {
    const text = { title: summary.title, provider, host: `${hostLabel}\n${hostId}`, path: paths }[kind];
    const field = makeField(kind, text);
    return field ? [field] : [];
  });
}

function contextLine(overview: Overview, session: SessionOverview, chatTitle: string | undefined): string {
  const { hostId, hostLabel, summary } = session;
  const provider = displayProvider(overview, hostId, summary.provider);
  return [provider, chatTitle, hostLabel, pathOf(summary.workingDirectories?.[0]), timeAgo(summary.modifiedAt)]
    .filter(Boolean).join(' · ');
}

function snippetLabel(kind: MetadataFieldKind): string {
  return METADATA_LABEL[kind];
}

/**
 * Поиск по overview: заголовок, провайдер, хост, рабочая папка и названия чатов.
 * Историю не загружает.
 */
export function searchOverview(
  overview: Overview,
  channels: ChannelMap,
  query: PreparedQuery | undefined,
  limits: PaletteLimits = DEFAULT_PALETTE_LIMITS,
): PaletteResult[] {
  if (!query) return [];
  const results: PaletteResult[] = [];
  for (const session of overview.sessions) {
    const isArchivedSession = archived(session.summary.status);
    const fields = sessionFields(overview, session);
    const scored = scoreFields(fields, query.tokens);
    if (scored) {
      const title = session.summary.title;
      const snippetField = scored.field.kind === 'title' ? undefined : scored.field;
      results.push({
        key: `session:${session.hostId}:${session.summary.resource}`,
        kind: 'session',
        title: { text: title, ranges: highlightRanges(title, query.tokens) },
        ...(snippetField ? { snippet: { ...makeSnippet(snippetField, query.tokens), label: snippetLabel(snippetField.kind as MetadataFieldKind) } } : {}),
        hostId: session.hostId,
        sessionUri: session.summary.resource,
        sessionTitle: title,
        context: contextLine(overview, session, undefined),
        archived: isArchivedSession,
        modifiedAt: session.summary.modifiedAt,
        score: scored.score,
      });
    }
    for (const chat of chatCatalog(overview, channels, session)) {
      if (chat.interactivity === ChatInteractivity.Hidden) continue;
      const chatField = makeField('chat', chat.title);
      const chatScored = chatField ? scoreFields([chatField], query.tokens) : undefined;
      if (!chatScored) continue;
      const sessionTitle = session.summary.title;
      const isDefault = chat.resource === (session.summary.defaultChat ?? undefined);
      results.push({
        key: `chat:${session.hostId}:${chat.resource}`,
        kind: 'chat',
        title: { text: chat.title, ranges: highlightRanges(chat.title, query.tokens) },
        hostId: session.hostId,
        sessionUri: session.summary.resource,
        chatUri: chat.resource,
        sessionTitle,
        chatTitle: isDefault ? undefined : chat.title,
        context: contextLine(overview, session, undefined),
        archived: isArchivedSession,
        modifiedAt: session.summary.modifiedAt,
        score: chatScored.score,
      });
    }
  }
  return sortPalette(results).slice(0, limits.maxResults);
}

interface LoadedDoc {
  hostId: string;
  sessionUri: string;
  chatUri: string;
  sessionTitle: string;
  chatTitle: string | undefined;
  context: string;
  modifiedAt: string;
  archived: boolean;
  turnId: string;
  startedAt?: string;
  fields: SearchField[];
}

export interface LoadedCorpus {
  docs: LoadedDoc[];
  incomplete: boolean;
  truncated: boolean;
  errors: string[];
}

interface Extracted {
  origin: string;
  docs: { turnId: string; startedAt?: string; fields: SearchField[] }[];
  chars: number;
}

// Извлечение зависит только от ссылки на массив ходов: стриминг activeTurn не
// пересобирает корпус на каждый delta.
const extractedTurns = new WeakMap<readonly Turn[], Extracted>();

function extractChat(chat: ChatState, maxCharsPerTurn: number): Extracted {
  const origin = chat.origin?.kind === ChatOriginKind.SideChat ? `side:${chat.origin.turnId}` : '';
  const cached = extractedTurns.get(chat.turns);
  if (cached?.origin === origin) return cached;
  const docs = visibleTurns(chat).map(turn => {
    const { fields } = turnSearchFields(turn, maxCharsPerTurn);
    return { turnId: turn.id, ...(turn.startedAt ? { startedAt: turn.startedAt } : {}), fields };
  });
  const chars = docs.reduce((sum, doc) => sum + doc.fields.reduce((fieldSum, field) => fieldSum + field.text.length, 0), 0);
  const extracted = { origin, docs, chars };
  extractedTurns.set(chat.turns, extracted);
  return extracted;
}

/** Загруженная (watched) история всех видимых чатов; новые ходы учитываются первыми. */
export function buildLoadedCorpus(
  overview: Overview,
  channels: ChannelMap,
  limits: PaletteLimits = DEFAULT_PALETTE_LIMITS,
): LoadedCorpus {
  const docs: LoadedDoc[] = [];
  const errors: string[] = [];
  let incomplete = false;
  let truncated = false;
  let chars = 0;
  const sessions = [...overview.sessions].sort((left, right) => right.summary.modifiedAt.localeCompare(left.summary.modifiedAt));
  for (const session of sessions) {
    const isArchivedSession = archived(session.summary.status);
    const sessionTitle = session.summary.title;
    for (const chat of chatCatalog(overview, channels, session)) {
      if (chat.interactivity === ChatInteractivity.Hidden) continue;
      const view = channels.get(channelKey(session.hostId, chat.resource));
      if (view?.error) errors.push(`${sessionTitle}: ${view.error}`);
      if (view?.missing) incomplete = true;
      const state = view?.state as ChatState | undefined;
      if (!state || !Array.isArray(state.turns)) continue;
      if (state.turnsNextCursor) incomplete = true;
      const extracted = extractChat(state, limits.maxCharsPerTurn);
      for (const doc of [...extracted.docs].reverse()) {
        if (docs.length >= limits.maxLocalTurns || chars + doc.fields.reduce((sum, field) => sum + field.text.length, 0) > limits.maxLocalChars) {
          incomplete = true;
          truncated = true;
          break;
        }
        docs.push({
          hostId: session.hostId,
          sessionUri: session.summary.resource,
          chatUri: chat.resource,
          sessionTitle,
          chatTitle: chat.title,
          context: contextLine(overview, session, chat.title),
          modifiedAt: session.summary.modifiedAt,
          archived: isArchivedSession,
          ...doc,
        });
        chars += doc.fields.reduce((sum, field) => sum + field.text.length, 0);
      }
    }
  }
  return { docs, incomplete, truncated, errors: [...new Set(errors)] };
}

export function searchLoaded(corpus: LoadedCorpus, query: PreparedQuery | undefined, limits: PaletteLimits = DEFAULT_PALETTE_LIMITS): PaletteResult[] {
  if (!query) return [];
  const results: PaletteResult[] = [];
  for (const doc of corpus.docs) {
    const scored = scoreFields(doc.fields, query.tokens);
    if (!scored) continue;
    const snippet = makeSnippet(scored.field, query.tokens);
    results.push({
      key: `turn:${doc.hostId}:${doc.chatUri}:${doc.turnId}`,
      kind: 'turn',
      title: { text: doc.sessionTitle, ranges: [] },
      snippet: { ...snippet, label: FIELD_LABEL[scored.field.kind as TurnFieldKind] },
      hostId: doc.hostId,
      sessionUri: doc.sessionUri,
      chatUri: doc.chatUri,
      turnId: doc.turnId,
      sessionTitle: doc.sessionTitle,
      chatTitle: doc.chatTitle,
      context: doc.context,
      archived: doc.archived,
      origin: 'loaded',
      modifiedAt: doc.modifiedAt,
      ...(doc.startedAt ? { startedAt: doc.startedAt } : {}),
      score: scored.score,
    });
  }
  return sortPalette(results).slice(0, limits.maxResults);
}

/** Deep-результат остаётся маленьким: в палитру идут session/chat/turnId и сниппет. */
export function deepToPalette(result: SearchHistoryResult, overview: Overview): PaletteResult[] {
  return result.hits.map(hit => hitToPalette(hit, overview));
}

function hitToPalette(hit: SearchHit, overview: Overview): PaletteResult {
  const session = overview.sessions.find(candidate => candidate.hostId === hit.hostId && candidate.summary.resource === hit.sessionUri);
  const chat = session?.summary.chats?.find(candidate => candidate.resource === hit.chatUri);
  const sessionTitle = session?.summary.title ?? hit.sessionUri;
  return {
    key: `turn:${hit.hostId}:${hit.chatUri}:${hit.turnId}`,
    kind: 'turn',
    title: { text: sessionTitle, ranges: [] },
    snippet: { text: hit.snippet, ranges: hit.ranges, label: FIELD_LABEL[hit.field] },
    hostId: hit.hostId,
    sessionUri: hit.sessionUri,
    chatUri: hit.chatUri,
    turnId: hit.turnId,
    sessionTitle,
    chatTitle: chat?.title,
    context: session ? contextLine(overview, session, chat?.title) : `${hit.hostId} · ${hit.chatUri}`,
    archived: session ? archived(session.summary.status) : false,
    origin: 'history',
    modifiedAt: session?.summary.modifiedAt ?? '',
    ...(hit.startedAt ? { startedAt: hit.startedAt } : {}),
    score: hit.score,
  };
}

/** Локальные результаты свежее deep, но при равном score проигрывают бэкенду. */
export function mergeSearchResults(local: readonly PaletteResult[], deep: readonly PaletteResult[], limits: PaletteLimits = DEFAULT_PALETTE_LIMITS): PaletteResult[] {
  const byKey = new Map<string, PaletteResult>();
  for (const result of local) byKey.set(result.key, result);
  for (const result of deep) {
    const existing = byKey.get(result.key);
    if (!existing || result.score > existing.score) byKey.set(result.key, result);
  }
  return sortPalette([...byKey.values()]).slice(0, limits.maxResults);
}

function sortPalette(results: readonly PaletteResult[]): PaletteResult[] {
  return [...results].sort((left, right) =>
    right.score - left.score
    || right.modifiedAt.localeCompare(left.modifiedAt)
    || (right.startedAt ?? '').localeCompare(left.startedAt ?? '')
    || left.key.localeCompare(right.key));
}

export function searchComplete(result: SearchHistoryResult): boolean {
  return result.reasons.length === 0 && result.issues.length === 0 && result.scannedChats === result.candidateChats;
}

const REASON_TEXT: Record<string, string> = {
  'chat-budget': 'просмотрены не все чаты',
  'page-budget': 'не вся история',
  deadline: 'время поиска истекло',
  'hit-budget': 'показаны первые совпадения',
  'text-budget': 'часть сообщений слишком длинная',
};

export interface SearchStatusInput {
  phase: 'idle' | 'running' | 'done' | 'error';
  result?: SearchHistoryResult;
  error?: string;
  localIncomplete: boolean;
  localErrors: readonly string[];
  /** Запрос уже достаточно длинный, чтобы искать по истории. */
  ready: boolean;
}

/** Статус полноты поиска; при незавершённости не обещает «ничего не найдено». */
export function searchStatusText(input: SearchStatusInput): string {
  if (input.phase === 'idle') return input.ready ? '' : 'Введите минимум два символа для поиска по истории.';
  if (input.phase === 'running') return 'Ищем по истории…';
  if (input.phase === 'error') return `Поиск по истории недоступен: ${input.error ?? 'неизвестная ошибка'}`;
  const result = input.result;
  if (!result) return '';
  const parts: string[] = [];
  if (result.hits.length === 0) {
    parts.push(searchComplete(result) && !input.localIncomplete
      ? 'Ничего не найдено.'
      : 'Совпадений нет: история проверена не полностью.');
  } else {
    parts.push(`Найдено: ${result.hits.length}`);
  }
  parts.push(`Проверено ${result.scannedChats} из ${result.candidateChats} чатов`);
  const reasons = [...new Set(result.reasons)].map(reason => REASON_TEXT[reason] ?? reason);
  if (reasons.length) parts.push(reasons.join(', '));
  if (result.issues.length) parts.push(`ошибок хостов: ${result.issues.length}`);
  if (input.localIncomplete) parts.push('локальная история загружена не полностью');
  if (input.localErrors.length) parts.push(`ошибок загруженной истории: ${input.localErrors.length}`);
  return `${parts.join(' · ')}.`;
}

export function recentSessionResults(overview: Overview, limit = 8, pinned: ReadonlySet<string> = new Set()): PaletteResult[] {
  return recentSessions(overview, limit, pinned).map(session => {
    const title = session.summary.title;
    return {
      key: `session:${session.hostId}:${session.summary.resource}`,
      kind: 'session' as const,
      title: { text: title, ranges: [] },
      hostId: session.hostId,
      sessionUri: session.summary.resource,
      sessionTitle: title,
      context: contextLine(overview, session, undefined),
      archived: archived(session.summary.status),
      modifiedAt: session.summary.modifiedAt,
      score: 0,
    };
  });
}

/** Архив по-прежнему исключён: pin меняет только порядок, а не состав «Недавних». */
export function recentSessions(
  overview: Overview, limit = 8, pinned: ReadonlySet<string> = new Set(),
): SessionOverview[] {
  return sortSessions(overview.sessions.filter(session => !archived(session.summary.status)), pinned)
    .slice(0, limit);
}

export function issueLabel(issue: SearchIssue): string {
  return `${issue.hostId}: ${issue.message}`;
}
