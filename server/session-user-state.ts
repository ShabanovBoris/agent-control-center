// Пользовательское состояние панели: глобальное закрепление и счётчики непрочитанных по origin.
// AHP-хост об этом ничего не знает: здесь только ссылки на сессии и числа, без копий сессий.
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionStatus } from '@microsoft/agent-host-protocol';
import {
  isSessionRef,
  type Overview,
  type SessionRef,
  type SessionUserState,
} from '../shared/protocol.js';
import { channelKey } from '../shared/reduce.js';
import { phaseOf } from '../shared/status.js';
import { snapshotOf, type SessionSnapshot } from './session-snapshot.js';
import { writePrivate } from './state-file.js';

export class SessionUserStateFailure extends Error {}

const VERSION = 1;
const FILE_NAME = 'session-user-state.json';

type CountedKind = 'completed' | 'error';

interface UnreadRecord extends SessionRef {
  counts: Map<string, number>;
}

interface Counted {
  kind: CountedKind;
  modifiedAt?: string;
}

export interface SessionUserStateOptions {
  dir: string;
  /** Инъекция записи для тестов; по умолчанию — атомарная запись 0600. */
  write?: (path: string, value: unknown) => Promise<void>;
}

/** Сериализация read-modify-write: параллельные pin/markVisible/observe не теряют записи. */
export class SessionUserStateStore {
  private readonly path: string;
  private readonly write: (path: string, value: unknown) => Promise<void>;
  private readonly origins = new Set<string>();
  private readonly pinned = new Map<string, SessionRef>();
  private readonly unread = new Map<string, UnreadRecord>();
  // Снимки и дедупликация живут только в памяти: сводка приходит чаще, чем меняется состояние.
  private snapshots = new Map<string, SessionSnapshot>();
  private readonly lastCounted = new Map<string, Counted>();
  private started = false;
  private dirty = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: SessionUserStateOptions) {
    this.path = join(options.dir, FILE_NAME);
    this.write = options.write ?? writePrivate;
  }

  /** Читает файл; битый файл не перезаписывается, а отключает состояние (fail closed). */
  async load(): Promise<void> {
    const text = await readFile(this.path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw new SessionUserStateFailure(`Не удалось прочитать ${this.path}: ${message(error)}`);
    });
    if (text === undefined) return;
    this.apply(parseFile(text, this.path));
    await chmod(this.path, 0o600).catch(() => {});
  }

  /** Все закрепления и непрочитанные только этого origin. */
  viewFor(origin: string): SessionUserState {
    const pinned: SessionRef[] = [...this.pinned.values()]
      .map(ref => ({ hostId: ref.hostId, sessionUri: ref.sessionUri }))
      .sort(compareRefs);
    const unread = [...this.unread.values()].flatMap(record => {
      const count = record.counts.get(origin);
      return count !== undefined && count > 0
        ? [{ hostId: record.hostId, sessionUri: record.sessionUri, count }]
        : [];
    }).sort(compareRefs);
    return { pinned, unread };
  }

  /** Новый origin начинает считать с момента подключения; прошлые ходы не восстанавливаются. */
  rememberOrigin(origin: string): Promise<void> {
    return this.enqueue(async () => {
      if (!origin || this.origins.has(origin)) return;
      this.origins.add(origin);
      this.dirty = true;
      await this.persist();
    });
  }

  /**
   * Транзакционное закрепление: при ошибке записи мутация откатывается и вызов reject-ит,
   * иначе UI показал бы pin, которого нет в файле.
   */
  setPinned(hostId: string, sessionUri: string, pinned: boolean): Promise<boolean> {
    return this.enqueue(async () => {
      const key = channelKey(hostId, sessionUri);
      const before = this.pinned.get(key);
      if ((before !== undefined) === pinned) return false;
      const wasDirty = this.dirty;
      if (pinned) this.pinned.set(key, { hostId, sessionUri });
      else this.pinned.delete(key);
      this.dirty = true;
      try {
        await this.write(this.path, this.serialize());
        this.dirty = false;
      } catch (error) {
        if (before) this.pinned.set(key, before);
        else this.pinned.delete(key);
        this.dirty = wasDirty;
        throw new SessionUserStateFailure(`Не удалось сохранить закрепление: ${message(error)}`);
      }
      return true;
    });
  }

  /** Сессия видима на origin: счётчик сбрасывается, опустевшая запись удаляется. */
  markVisible(origin: string, hostId: string, sessionUri: string): Promise<boolean> {
    return this.enqueue(async () => {
      const changed = this.reset(channelKey(hostId, sessionUri), origin);
      await this.persist();
      return changed;
    });
  }

  /**
   * Сравнивает последовательные сводки: завершение хода и новые ошибки увеличивают счётчики
   * известных origin, кроме тех, где сессия видима. Возвращает признак изменения состояния.
   */
  observe(overview: Overview, visible: ReadonlyMap<string, ReadonlySet<string>>): Promise<boolean> {
    return this.enqueue(async () => {
      const changed = this.detect(overview, visible);
      await this.persist();
      return changed;
    });
  }

  /** Удалённая на хосте сессия не должна оставлять pin, счётчики и снимок. */
  forgetSession(hostId: string, sessionUri: string): Promise<boolean> {
    return this.enqueue(async () => {
      const key = channelKey(hostId, sessionUri);
      let changed = false;
      if (this.pinned.delete(key)) { changed = true; this.dirty = true; }
      if (this.unread.delete(key)) { changed = true; this.dirty = true; }
      this.snapshots.delete(key);
      this.lastCounted.delete(key);
      await this.persist();
      return changed;
    });
  }

  private detect(overview: Overview, visible: ReadonlyMap<string, ReadonlySet<string>>): boolean {
    const next = new Map<string, SessionSnapshot>();
    let changed = false;
    for (const session of overview.sessions) {
      const key = channelKey(session.hostId, session.summary.resource);
      const snapshot = snapshotOf(session);
      next.set(key, snapshot);
      const previous = this.snapshots.get(key);
      // Первая сводка после старта backend и новые сессии — baseline без начислений.
      if (!this.started || !previous) continue;
      const kind = detectEvent(previous, snapshot);
      if (!kind) continue;
      if (this.wasCounted(key, kind, snapshot.modifiedAt)) continue;
      this.lastCounted.set(key, { kind, ...(snapshot.modifiedAt ? { modifiedAt: snapshot.modifiedAt } : {}) });
      for (const origin of this.origins) {
        if (visible.get(key)?.has(origin)) continue;
        this.increment(session.hostId, session.summary.resource, origin);
        changed = true;
      }
    }
    // Страховка на случай, если presence пришёл раньше или позже сводки.
    for (const [key, origins] of visible) {
      for (const origin of origins) {
        if (this.reset(key, origin)) changed = true;
      }
    }
    for (const key of this.snapshots.keys()) if (!next.has(key)) this.snapshots.delete(key);
    for (const key of this.lastCounted.keys()) if (!next.has(key)) this.lastCounted.delete(key);
    this.snapshots = next;
    this.started = true;
    return changed;
  }

  /** Replay старой сводки после reconnect не должен начислять второй раз за тот же ход. */
  private wasCounted(key: string, kind: CountedKind, modifiedAt: string | undefined): boolean {
    const counted = this.lastCounted.get(key);
    return counted?.kind === kind && counted.modifiedAt !== undefined && counted.modifiedAt === modifiedAt;
  }

  private increment(hostId: string, sessionUri: string, origin: string): void {
    const key = channelKey(hostId, sessionUri);
    const current = this.unread.get(key);
    const counts = current ? new Map(current.counts) : new Map<string, number>();
    counts.set(origin, (counts.get(origin) ?? 0) + 1);
    this.unread.set(key, { hostId, sessionUri, counts });
    this.dirty = true;
  }

  private reset(key: string, origin: string): boolean {
    const record = this.unread.get(key);
    if (!record?.counts.has(origin)) return false;
    const counts = new Map(record.counts);
    counts.delete(origin);
    if (counts.size === 0) this.unread.delete(key);
    else this.unread.set(key, { ...record, counts });
    this.dirty = true;
    return true;
  }

  /** Best-effort: живой детектор важнее диска, ошибка записи повторится на следующей мутации. */
  private async persist(): Promise<void> {
    if (!this.dirty) return;
    try {
      await this.write(this.path, this.serialize());
      this.dirty = false;
    } catch (error) {
      console.warn('[acc] Не удалось сохранить состояние сессий.', message(error));
    }
  }

  private serialize(): unknown {
    return {
      version: VERSION,
      origins: [...this.origins].sort(),
      pinned: [...this.pinned.values()].map(ref => ({ hostId: ref.hostId, sessionUri: ref.sessionUri })).sort(compareRefs),
      unread: [...this.unread.values()].flatMap(record => {
        const counts = [...record.counts].filter(([, count]) => Number.isInteger(count) && count > 0)
          .sort(([left], [right]) => left.localeCompare(right));
        if (counts.length === 0) return [];
        return [{ hostId: record.hostId, sessionUri: record.sessionUri, counts: Object.fromEntries(counts) }];
      }).sort(compareRefs),
    };
  }

  private apply(file: StoredFile): void {
    for (const origin of file.origins) this.origins.add(origin);
    for (const ref of file.pinned) this.pinned.set(channelKey(ref.hostId, ref.sessionUri), { ...ref });
    for (const record of file.unread) {
      for (const origin of record.counts.keys()) this.origins.add(origin);
      this.unread.set(channelKey(record.hostId, record.sessionUri), record);
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

interface StoredFile {
  origins: string[];
  pinned: SessionRef[];
  unread: UnreadRecord[];
}

function parseFile(text: string, path: string): StoredFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SessionUserStateFailure(`Файл ${path} повреждён.`);
  }
  if (!isRecord(parsed) || parsed.version !== VERSION) {
    throw new SessionUserStateFailure(`Файл ${path} имеет неверный формат.`);
  }
  const { origins, pinned, unread } = parsed;
  if (!Array.isArray(origins) || !origins.every(origin => typeof origin === 'string')) {
    throw new SessionUserStateFailure(`Файл ${path} имеет неверный список устройств.`);
  }
  if (!Array.isArray(pinned) || !pinned.every(isSessionRef)) {
    throw new SessionUserStateFailure(`Файл ${path} имеет неверный список закреплений.`);
  }
  if (!Array.isArray(unread)) {
    throw new SessionUserStateFailure(`Файл ${path} имеет неверный список непрочитанных.`);
  }
  const records: UnreadRecord[] = [];
  for (const entry of unread) {
    if (!isRecord(entry) || !isSessionRef(entry) || !isRecord(entry.counts)) {
      throw new SessionUserStateFailure(`Файл ${path} имеет неверную запись непрочитанных.`);
    }
    // Нулевые и дробные счётчики недопустимы: запись без положительных значений просто исчезает,
    // иначе клиент отбросит всё сообщение `sessionUserState` вместе с закреплениями.
    const counts = new Map<string, number>();
    for (const [origin, count] of Object.entries(entry.counts)) {
      if (typeof count === 'number' && Number.isInteger(count) && count > 0) counts.set(origin, count);
    }
    if (counts.size === 0) continue;
    records.push({ hostId: entry.hostId, sessionUri: entry.sessionUri, counts });
  }
  return { origins, pinned: pinned.map(ref => ({ ...ref })), unread: records };
}

/** Завершение хода и новая ошибка. `InputNeeded` сам по себе событием не считается. */
function detectEvent(previous: SessionSnapshot, next: SessionSnapshot): CountedKind | undefined {
  if (gainedError(previous.status, next.status)) return 'error';
  for (const [uri, chat] of next.chats) {
    if (chat.hidden) continue;
    if (gainedError(previous.chats.get(uri)?.status, chat.status)) return 'error';
  }
  const previousPhase = previous.status === undefined ? undefined : phaseOf(previous.status);
  const nextPhase = next.status === undefined ? undefined : phaseOf(next.status);
  if ((previousPhase === 'running' || previousPhase === 'input') && nextPhase === 'idle'
    && (previous.status === undefined || (previous.status & SessionStatus.Error) === 0)) return 'completed';
  return undefined;
}

function gainedError(before: number | undefined, after: number | undefined): boolean {
  if (after === undefined || (after & SessionStatus.Error) === 0) return false;
  return before === undefined || (before & SessionStatus.Error) === 0;
}

function compareRefs(left: SessionRef, right: SessionRef): number {
  return left.hostId.localeCompare(right.hostId) || left.sessionUri.localeCompare(right.sessionUri);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createSessionUserState(options: SessionUserStateOptions): Promise<SessionUserStateStore> {
  const store = new SessionUserStateStore(options);
  await store.load();
  return store;
}
