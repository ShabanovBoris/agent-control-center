import type { ChatState } from '@microsoft/agent-host-protocol';
import type { SearchField } from '../shared/search.js';

/** Извлечённый из хода текст; не результат запроса, поэтому кэш переиспользуется при смене query. */
export interface SearchDoc {
  turnId: string;
  startedAt?: string;
  fields: SearchField[];
  truncated: boolean;
}

export interface ChatCorpus {
  hostId: string;
  sessionUri: string;
  chatUri: string;
  sessionModifiedAt: string;
  /** Живой fingerprint на момент извлечения; для закрытого чата отсутствует. */
  liveFingerprint?: string;
  docs: SearchDoc[];
  storedAt: number;
  chars: number;
}

export interface CacheLimits {
  ttlMs: number;
  maxChats: number;
  maxChars: number;
}

export const DEFAULT_CACHE_LIMITS: CacheLimits = { ttlMs: 10 * 60_000, maxChats: 32, maxChars: 4_000_000 };

export interface CorpusContext {
  sessionModifiedAt: string;
  live?: ChatState;
}

export function liveFingerprint(chat: ChatState): string {
  return JSON.stringify([chat.turns.length, chat.turns.at(-1)?.id ?? null, chat.turnsNextCursor ?? null]);
}

/**
 * Ограниченный in-memory кэш извлечённого корпуса чатов. Не индекс и не БД:
 * при рестарте пуст, TTL и объём ограничены. Кэшируются только полностью
 * прочитанные чаты, поэтому неполный корпус не выглядит как проверенный.
 */
export class SearchCache {
  private readonly entries = new Map<string, ChatCorpus>();

  constructor(private readonly limits: CacheLimits = DEFAULT_CACHE_LIMITS) {}

  private key(hostId: string, chatUri: string): string {
    return `${hostId}\u0000${chatUri}`;
  }

  get(hostId: string, chatUri: string, context: CorpusContext, now = Date.now()): ChatCorpus | undefined {
    const key = this.key(hostId, chatUri);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now - entry.storedAt > this.limits.ttlMs || entry.sessionModifiedAt !== context.sessionModifiedAt) {
      this.entries.delete(key);
      return undefined;
    }
    if (context.live && entry.liveFingerprint !== undefined && entry.liveFingerprint !== liveFingerprint(context.live)) {
      this.entries.delete(key);
      return undefined;
    }
    // LRU: свежий хит переезжает в конец очереди вытеснения.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(entry: Omit<ChatCorpus, 'chars'>): ChatCorpus {
    const chars = entry.docs.reduce((sum, doc) => sum + doc.fields.reduce((fieldSum, field) => fieldSum + field.text.length, 0), 0);
    const stored: ChatCorpus = { ...entry, chars };
    const key = this.key(entry.hostId, entry.chatUri);
    this.entries.delete(key);
    this.entries.set(key, stored);
    this.evict();
    return stored;
  }

  forgetSession(hostId: string, sessionUri: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.hostId === hostId && entry.sessionUri === sessionUri) this.entries.delete(key);
    }
  }

  forgetHost(hostId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.hostId === hostId) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(): void {
    let chars = [...this.entries.values()].reduce((sum, entry) => sum + entry.chars, 0);
    while ((this.entries.size > this.limits.maxChats || chars > this.limits.maxChars) && this.entries.size > 0) {
      const [key, entry] = this.entries.entries().next().value as [string, ChatCorpus];
      this.entries.delete(key);
      chars -= entry.chars;
    }
  }
}
