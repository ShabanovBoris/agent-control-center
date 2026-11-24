import { ChatInteractivity, SessionStatus, type ChatState, type SessionState } from '@microsoft/agent-host-protocol';
import {
  type HostStatus,
  type SearchHit,
  type SearchHistoryResult,
  type SearchIssue,
  type SearchStopReason,
  type SessionOverview,
  type TurnFieldKind,
  type UsageReport,
  type UsageReportSession,
  type UsageStopReason,
} from '../shared/protocol.js';
import { makeSnippet, prepareQuery, scoreFields, turnSearchFields } from '../shared/search.js';
import { visibleTurns } from '../shared/turns.js';
import { aggregateUsage, resolveTimeZone, usageSourceOf, type UsageAggregate, type UsageSource } from '../shared/usage.js';
import { yieldToEventLoop } from './async.js';
import { CallFailure, toCallError } from './errors.js';
import { liveFingerprint, SearchCache, type CacheLimits, type SearchDoc } from './search-cache.js';

export interface SearchLimits {
  maxChats: number;
  maxPagesPerChat: number;
  maxConcurrentChats: number;
  maxOpenSearchChats: number;
  maxConcurrentPageRequests: number;
  maxPageRequestsPerHost: number;
  maxHits: number;
  deadlineMs: number;
  pageWaitMs: number;
  snapshotWaitMs: number;
  maxCharsPerTurn: number;
  query: { maxQueryChars: number; maxQueryTokens: number };
  minHistoryQueryChars: number;
  cache: CacheLimits;
}

export const DEFAULT_SEARCH_LIMITS: SearchLimits = {
  maxChats: 40,
  maxPagesPerChat: 10,
  maxConcurrentChats: 2,
  maxOpenSearchChats: 4,
  maxConcurrentPageRequests: 4,
  maxPageRequestsPerHost: 2,
  maxHits: 40,
  deadlineMs: 6000,
  pageWaitMs: 5000,
  snapshotWaitMs: 10_000,
  maxCharsPerTurn: 100_000,
  query: { maxQueryChars: 200, maxQueryTokens: 12 },
  minHistoryQueryChars: 2,
  cache: { ttlMs: 10 * 60_000, maxChats: 32, maxChars: 4_000_000 },
};

/** Узкий интерфейс Hub, который нужен поиску: подписки, зеркало и страницы истории. */
export interface SearchEnvironment {
  sessions(): SessionOverview[];
  hostStatus(hostId: string): HostStatus | undefined;
  mirrorChat(hostId: string, chatUri: string): ChatState | undefined;
  mirrorSession(hostId: string, sessionUri: string): SessionState | undefined;
  /** Открывает чат и удерживает подписку; вызывающий обязан вызвать `releaseChat`. */
  openChat(hostId: string, chatUri: string, signal: AbortSignal, waitMs: number): Promise<ChatState>;
  releaseChat(hostId: string, chatUri: string): void;
  fetchOlderTurns(hostId: string, chatUri: string, cursor: string, signal: AbortSignal, waitMs: number): Promise<ChatState | undefined>;
}

export interface Candidate {
  hostId: string;
  sessionUri: string;
  chatUri: string;
  chatTitle: string;
  /** Провайдер сессии: от него зависит поправка Claude на чтение кэша. */
  provider: string;
  hidden: boolean;
  sessionModifiedAt: string;
  archived: boolean;
  order: number;
}

export interface CandidateList {
  candidates: Candidate[];
  /** Все видимые чаты подключённых хостов, включая не попавшие в бюджет. */
  candidateChats: number;
  issues: SearchIssue[];
}

function archived(status: number): boolean {
  return (status & SessionStatus.IsArchived) !== 0;
}

/**
 * Кандидаты в порядке приоритета: активные сессии от свежих к старым, затем
 * архивные. Каталог чатов берётся из открытого состояния сессии, если оно есть:
 * живой каталог важнее сводки.
 */
export function collectCandidates(
  sessions: readonly SessionOverview[],
  hostStatus: (hostId: string) => HostStatus | undefined,
  mirrorSession: (hostId: string, sessionUri: string) => SessionState | undefined,
  maxChats: number,
  options: { includeHidden?: boolean } = {},
): CandidateList {
  const issues: SearchIssue[] = [];
  const disconnected = new Set<string>();
  const missingCatalog = new Set<string>();
  const candidates: Candidate[] = [];
  let candidateChats = 0;
  for (const session of sessions) {
    const { hostId, summary } = session;
    if (hostStatus(hostId) !== 'connected') {
      if (!disconnected.has(hostId)) {
        disconnected.add(hostId);
        issues.push({ hostId, message: 'Хост не подключён: его история не проверена' });
      }
      continue;
    }
    // Живой каталог важнее сводки: он знает и провайдера, и скрытые чаты.
    const live = mirrorSession(hostId, summary.resource);
    const chats = live?.chats ?? summary.chats;
    const provider = live?.provider ?? summary.provider;
    if (!chats?.length) {
      const key = `${hostId}\u0000${summary.resource}`;
      if (!missingCatalog.has(key)) {
        missingCatalog.add(key);
        issues.push({ hostId, uri: summary.resource, message: 'Хост не публикует каталог чатов: история сессии не проверена' });
      }
      continue;
    }
    // Поиск не индексирует служебные чаты, но отчёт расхода обязан их учитывать.
    const included = options.includeHidden ? chats : chats.filter(chat => chat.interactivity !== ChatInteractivity.Hidden);
    candidateChats += included.length;
    included.forEach((chat, index) => {
      candidates.push({
        hostId,
        sessionUri: summary.resource,
        chatUri: chat.resource,
        chatTitle: chat.title ?? '',
        provider,
        hidden: chat.interactivity === ChatInteractivity.Hidden,
        sessionModifiedAt: summary.modifiedAt,
        archived: archived(summary.status),
        order: index,
      });
    });
  }
  candidates.sort((left, right) =>
    Number(left.archived) - Number(right.archived)
    || right.sessionModifiedAt.localeCompare(left.sessionModifiedAt)
    || left.order - right.order
    || left.sessionUri.localeCompare(right.sessionUri));
  return { candidates: candidates.slice(0, maxChats), candidateChats, issues };
}

interface Waiter {
  resolve(): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Семафор с FIFO-очередью и отменой ожидания; слот переходит ожидающему без мигания. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Ёмкость семафора должна быть положительной');
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.active < this.capacity) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason);
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  /** Пробует занять свободный слот без ожидания: быстрый путь не создаёт microtask. */
  tryAcquire(): boolean {
    if (this.active < this.capacity && this.waiters.length === 0) {
      this.active += 1;
      return true;
    }
    return false;
  }

  /** Сколько слотов занято и сколько задач ждёт: нужно для очистки per-chat очередей. */
  get pending(): number {
    return this.active + this.waiters.length;
  }

  release(): void {
    const waiter = this.waiters.shift();
    if (!waiter) {
      this.active = Math.max(0, this.active - 1);
      return;
    }
    if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
    // Слот не освобождается: его сразу занимает первый ожидающий.
    waiter.resolve();
  }

  async run<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.release();
    }
  }
}

/** Глобальный лимит страниц плюс отдельный лимит на каждый хост. */
class HostLimiter {
  private readonly hosts = new Map<string, Semaphore>();

  constructor(private readonly global: Semaphore, private readonly perHost: number) {}

  run<T>(hostId: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    let host = this.hosts.get(hostId);
    if (!host) {
      host = new Semaphore(this.perHost);
      this.hosts.set(hostId, host);
    }
    const limiter = host;
    return this.global.run(signal, () => limiter.run(signal, task));
  }
}

interface RunContext {
  hits: SearchHit[];
  scannedChats: number;
  scannedTurns: number;
  issues: SearchIssue[];
  pageLimited: boolean;
  textBudget: boolean;
  hitBudget: boolean;
  maxHits: number;
  next: number;
}

interface LoadedChat {
  docs: SearchDoc[];
  usage: UsageSource;
  truncated: boolean;
  pageLimited: boolean;
  failed: boolean;
  issue?: SearchIssue;
}

interface CollectedChat {
  candidate: Candidate;
  source: UsageSource;
  failed: boolean;
  pageLimited: boolean;
  issue?: SearchIssue;
}

export class HistorySearch {
  private readonly cache: SearchCache;
  private readonly openChats: Semaphore;
  private readonly pages: HostLimiter;

  constructor(private readonly env: SearchEnvironment, private readonly limits: SearchLimits = DEFAULT_SEARCH_LIMITS) {
    this.cache = new SearchCache(limits.cache);
    this.openChats = new Semaphore(limits.maxOpenSearchChats);
    this.pages = new HostLimiter(new Semaphore(limits.maxConcurrentPageRequests), limits.maxPageRequestsPerHost);
  }

  forgetSession(hostId: string, sessionUri: string): void {
    this.cache.forgetSession(hostId, sessionUri);
  }

  forgetHost(hostId: string): void {
    this.cache.forgetHost(hostId);
  }

  clear(): void {
    this.cache.clear();
  }

  async search(query: string, callerSignal: AbortSignal, limit?: number): Promise<SearchHistoryResult> {
    const prepared = prepareQuery(query, this.limits.query);
    if (!prepared) throw new CallFailure('Пустой поисковый запрос');
    if (prepared.normalized.length < this.limits.minHistoryQueryChars) {
      throw new CallFailure('Введите минимум два символа для поиска по истории');
    }
    const maxHits = Math.min(limit ?? this.limits.maxHits, this.limits.maxHits);
    const { candidates, candidateChats, issues } = collectCandidates(
      this.env.sessions(), hostId => this.env.hostStatus(hostId),
      (hostId, uri) => this.env.mirrorSession(hostId, uri), this.limits.maxChats,
    );

    const controller = new AbortController();
    const signal = AbortSignal.any([callerSignal, controller.signal]);
    let deadlineReached = false;
    const timer = setTimeout(() => {
      deadlineReached = true;
      controller.abort(new CallFailure('Истекло время поиска'));
    }, this.limits.deadlineMs);
    const context: RunContext = {
      hits: [], scannedChats: 0, scannedTurns: 0, issues: [...issues],
      pageLimited: false, textBudget: false, hitBudget: false, maxHits, next: 0,
    };
    try {
      const workers = Array.from({ length: Math.min(this.limits.maxConcurrentChats, candidates.length) }, async () => {
        while (!signal.aborted) {
          const index = context.next;
          context.next += 1;
          const candidate = candidates[index];
          if (!candidate) return;
          if (context.hits.length >= context.maxHits) { context.hitBudget = true; return; }
          await this.scan(candidate, prepared.tokens, signal, context);
          await yieldToEventLoop();
        }
      });
      await Promise.all(workers);
      if (callerSignal.aborted) throw new CallFailure('Поиск отменён');
    } finally {
      clearTimeout(timer);
    }

    const reasons: SearchStopReason[] = [];
    if (candidateChats > candidates.length) reasons.push('chat-budget');
    if (context.pageLimited) reasons.push('page-budget');
    if (deadlineReached) reasons.push('deadline');
    if (context.hitBudget) reasons.push('hit-budget');
    if (context.textBudget) reasons.push('text-budget');

    const recency = new Map(candidates.map(candidate => [`${candidate.hostId}\u0000${candidate.sessionUri}`, candidate.sessionModifiedAt]));
    const hits = context.hits
      .toSorted((left, right) =>
        right.score - left.score
        || (recency.get(`${right.hostId}\u0000${right.sessionUri}`) ?? '').localeCompare(recency.get(`${left.hostId}\u0000${left.sessionUri}`) ?? '')
        || (right.startedAt ?? '').localeCompare(left.startedAt ?? '')
        || `${left.chatUri}\u0000${left.turnId}`.localeCompare(`${right.chatUri}\u0000${right.turnId}`))
      .slice(0, maxHits);

    return {
      hits,
      candidateChats,
      scannedChats: context.scannedChats,
      scannedTurns: context.scannedTurns,
      reasons,
      issues: dedupeIssues(context.issues),
    };
  }

  /**
   * Отчёт по расходу на том же слое истории, что и поиск: те же кандидаты, семафоры,
   * бюджеты страниц и кэш. В отличие от поиска, скрытые чаты включаются, иначе сумма
   * сессии разойдётся с панелью (`sessionTokenUsage` считает все чаты).
   */
  async usageReport(timeZone: string, callerSignal: AbortSignal): Promise<UsageReport> {
    if (!resolveTimeZone(timeZone)) throw new CallFailure('Неизвестный часовой пояс');
    const sessions = this.env.sessions();
    const { candidates, candidateChats, issues } = collectCandidates(
      sessions, hostId => this.env.hostStatus(hostId),
      (hostId, uri) => this.env.mirrorSession(hostId, uri), this.limits.maxChats,
      { includeHidden: true },
    );

    const controller = new AbortController();
    const signal = AbortSignal.any([callerSignal, controller.signal]);
    let deadlineReached = false;
    const timer = setTimeout(() => {
      deadlineReached = true;
      controller.abort(new CallFailure('Истекло время отчёта'));
    }, this.limits.deadlineMs);
    const collected: (CollectedChat | undefined)[] = new Array(candidates.length);
    let next = 0;
    let pageLimited = false;
    try {
      const workers = Array.from({ length: Math.min(this.limits.maxConcurrentChats, candidates.length) }, async () => {
        while (!signal.aborted) {
          const index = next;
          next += 1;
          const candidate = candidates[index];
          if (!candidate) return;
          const loaded = await this.loadCandidate(candidate, signal, { preferLive: true });
          collected[index] = {
            candidate,
            source: loaded.usage,
            failed: loaded.failed,
            pageLimited: loaded.pageLimited,
            ...(loaded.issue ? { issue: loaded.issue } : {}),
          };
          pageLimited ||= loaded.pageLimited;
          await yieldToEventLoop();
        }
      });
      await Promise.all(workers);
      if (callerSignal.aborted) throw new CallFailure('Отчёт отменён');
    } finally {
      clearTimeout(timer);
    }

    const results: CollectedChat[] = candidates.map((candidate, index) => {
      const result = collected[index];
      if (result) {
        // Дедлайн обрывает загрузку без ошибки хоста; причина всё равно должна быть видна.
        return result.failed && !result.issue && deadlineReached
          ? { ...result, issue: { hostId: candidate.hostId, message: 'Не загружено: истекло время отчёта' } }
          : result;
      }
      return {
        candidate,
        source: usageSourceOf(undefined, ''),
        failed: true,
        pageLimited: false,
        ...(deadlineReached ? { issue: { hostId: candidate.hostId, message: 'Не загружено: истекло время отчёта' } } : {}),
      };
    });
    for (const result of results) if (result.issue) issues.push(result.issue);

    const reasons: UsageStopReason[] = [];
    if (candidateChats > candidates.length) reasons.push('chat-budget');
    if (pageLimited) reasons.push('page-budget');
    if (deadlineReached) reasons.push('deadline');
    const scannedChats = results.filter(result => !result.failed).length;
    // Любая остановка делает отчёт нижней границей: неполное не должно выглядеть точным.
    const globalIncomplete = reasons.length > 0 || issues.length > 0 || scannedChats < candidateChats;

    const aggregate = (sources: readonly UsageSource[], withMissingFallback: boolean): UsageAggregate => {
      // Если не загружено ничего с известным usage, сумма 0 была бы ложной уверенностью.
      const effective = withMissingFallback && globalIncomplete && !sources.some(source => source.rows.some(row => row.reported))
        ? [...sources, usageSourceOf(undefined, '')]
        : sources;
      return aggregateUsage(effective, { timeZone, incomplete: globalIncomplete });
    };

    const sessionOverviews = new Map<string, SessionOverview>();
    for (const session of sessions) sessionOverviews.set(`${session.hostId}\u0000${session.summary.resource}`, session);

    const grouped = new Map<string, CollectedChat[]>();
    for (const result of results) {
      const key = `${result.candidate.hostId}\u0000${result.candidate.sessionUri}`;
      const list = grouped.get(key);
      if (list) list.push(result);
      else grouped.set(key, [result]);
    }

    const reportSessions: UsageReportSession[] = [...grouped.entries()].map(([key, chats]) => {
      const first = chats[0]!.candidate;
      // Снимок сводок взят один раз; провайдер и заголовок открытой сессии важнее сводки.
      const overview = sessionOverviews.get(key);
      const live = this.env.mirrorSession(first.hostId, first.sessionUri);
      return {
        hostId: first.hostId,
        hostLabel: overview?.hostLabel ?? first.hostId,
        sessionUri: first.sessionUri,
        title: live?.title ?? overview?.summary.title ?? '',
        provider: live?.provider ?? overview?.summary.provider ?? first.provider,
        archived: first.archived,
        chats: chats.map(result => ({
          hostId: result.candidate.hostId,
          sessionUri: result.candidate.sessionUri,
          chatUri: result.candidate.chatUri,
          title: result.candidate.chatTitle,
          hidden: result.candidate.hidden,
          ...aggregate([result.source], false),
          ...(result.failed ? { issue: result.issue?.message ?? 'Не загружено' } : {}),
        })),
        ...aggregate(chats.map(result => result.source), true),
      };
    });

    return {
      ...aggregate(results.map(result => result.source), true),
      timeZone,
      generatedAt: new Date().toISOString(),
      sessions: reportSessions,
      scannedChats,
      candidateChats,
      reasons,
      issues: dedupeIssues(issues),
    };
  }

  /**
   * Единственный загрузчик истории: поиск и отчёт используют одни семафоры, бюджеты
   * и кэш. Ошибка хоста возвращается как `failed`, а не бросается, чтобы отчёт мог
   * сохранить суммы остальных чатов и показать issue.
   */
  private async loadCandidate(candidate: Candidate, signal: AbortSignal, options: { preferLive?: boolean } = {}): Promise<LoadedChat> {
    const { hostId, chatUri, sessionUri, sessionModifiedAt, provider } = candidate;
    const live = this.env.mirrorChat(hostId, chatUri);
    // Живой чат отчёт читает из зеркала: в кэше нет активного хода, и fingerprint его не видит.
    const cached = options.preferLive && live ? undefined : this.cache.get(hostId, chatUri, { sessionModifiedAt, ...(live ? { live } : {}) });
    if (cached) {
      return {
        docs: cached.docs,
        usage: cached.usage,
        truncated: cached.docs.some(doc => doc.truncated),
        pageLimited: false,
        failed: false,
      };
    }
    let held = false;
    try {
      let state = await this.openChats.run(signal, () => this.env.openChat(hostId, chatUri, signal, this.limits.snapshotWaitMs));
      held = true;
      let pages = 0;
      let pageLimited = false;
      let issue: SearchIssue | undefined;
      while (state.turnsNextCursor) {
        if (pages >= this.limits.maxPagesPerChat) {
          pageLimited = true;
          break;
        }
        const cursor = state.turnsNextCursor;
        const loaded = await this.pages.run(hostId, signal, () => this.env.fetchOlderTurns(hostId, chatUri, cursor, signal, this.limits.pageWaitMs));
        pages += 1;
        if (!loaded) throw new CallFailure('Хост не вернул состояние чата после страницы истории');
        state = loaded;
        if (state.turnsNextCursor === cursor) {
          pageLimited = true;
          issue = { hostId, uri: chatUri, message: 'Хост не продвинул курсор истории: оставшиеся страницы не проверены' };
          break;
        }
      }
      const docs = this.extract(state);
      // Для отчёта activeTurn важен; в кэш он не попадает, иначе fingerprint не заметит его смену.
      const usage = usageSourceOf(state, provider);
      // Неполный корпус не кэшируем: иначе повторный поиск считал бы его полным.
      if (!state.turnsNextCursor) {
        this.cache.set({
          hostId, sessionUri, chatUri, sessionModifiedAt,
          ...(this.env.mirrorChat(hostId, chatUri) ? { liveFingerprint: liveFingerprint(state) } : {}),
          docs, usage: usageSourceOf(state, provider, { includeActiveTurn: false }), storedAt: Date.now(),
        });
      }
      return {
        docs,
        usage,
        truncated: docs.some(doc => doc.truncated),
        pageLimited,
        failed: false,
        ...(issue ? { issue } : {}),
      };
    } catch (error) {
      // Отмена и дедлайн — не ошибка хоста: о них сообщают reasons, а не issues.
      const failure = !signal.aborted ? toCallError(error) : undefined;
      return {
        docs: [],
        usage: usageSourceOf(undefined, ''),
        truncated: false,
        pageLimited: false,
        failed: true,
        ...(failure ? { issue: { hostId, uri: chatUri, message: failure.message, ...(failure.code !== undefined ? { code: failure.code } : {}) } } : {}),
      };
    } finally {
      if (held) this.env.releaseChat(hostId, chatUri);
    }
  }

  private async scan(candidate: Candidate, tokens: readonly string[], signal: AbortSignal, context: RunContext): Promise<void> {
    const loaded = await this.loadCandidate(candidate, signal);
    if (loaded.issue) context.issues.push(loaded.issue);
    if (loaded.truncated) context.textBudget = true;
    if (loaded.pageLimited) context.pageLimited = true;
    if (loaded.failed) return;
    context.scannedChats += 1;
    this.collect(loaded.docs, tokens, candidate, context);
  }

  private extract(state: ChatState): SearchDoc[] {
    return visibleTurns(state).map(turn => {
      const { fields, truncated } = turnSearchFields(turn, this.limits.maxCharsPerTurn);
      return {
        turnId: turn.id,
        ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
        fields,
        truncated,
      };
    });
  }

  private collect(docs: readonly SearchDoc[], tokens: readonly string[], candidate: Candidate, context: RunContext): void {
    context.scannedTurns += docs.length;
    for (const doc of docs) {
      if (context.hits.length >= context.maxHits) { context.hitBudget = true; return; }
      const scored = scoreFields(doc.fields, tokens);
      if (!scored) continue;
      const snippet = makeSnippet(scored.field, tokens);
      const field: TurnFieldKind = scored.field.kind as TurnFieldKind;
      context.hits.push({
        hostId: candidate.hostId,
        sessionUri: candidate.sessionUri,
        chatUri: candidate.chatUri,
        turnId: doc.turnId,
        score: scored.score,
        field,
        snippet: snippet.text,
        ranges: snippet.ranges,
        ...(doc.startedAt ? { startedAt: doc.startedAt } : {}),
      });
    }
  }
}

function dedupeIssues(issues: readonly SearchIssue[]): SearchIssue[] {
  const seen = new Set<string>();
  return issues.filter(issue => {
    const key = `${issue.hostId}\u0000${issue.code ?? ''}\u0000${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
