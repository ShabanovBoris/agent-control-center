// Порядок списка сессий и счётчики badge — чистые функции: их проверяют Node-тесты,
// а панель и палитра используют один компаратор.
import type { SessionOverview, SessionRef, UnreadSession } from '../shared/protocol';
import { channelKey } from '../shared/reduce';

export function pinnedKeys(pinned: readonly SessionRef[]): ReadonlySet<string> {
  return new Set(pinned.map(ref => channelKey(ref.hostId, ref.sessionUri)));
}

export function unreadCounts(unread: readonly UnreadSession[]): ReadonlyMap<string, number> {
  return new Map(unread.map(entry => [channelKey(entry.hostId, entry.sessionUri), entry.count]));
}

/**
 * Закреплённые идут первыми в любом фильтре, внутри группы — `modifiedAt` по убыванию.
 * Ключ канала — детерминированный tie-breaker для сессий с одинаковым временем.
 */
export function sortSessions(
  sessions: readonly SessionOverview[], pinned: ReadonlySet<string>,
): SessionOverview[] {
  return sessions.toSorted((left, right) => {
    const leftKey = channelKey(left.hostId, left.summary.resource);
    const rightKey = channelKey(right.hostId, right.summary.resource);
    const leftPinned = pinned.has(leftKey);
    if (leftPinned !== pinned.has(rightKey)) return leftPinned ? -1 : 1;
    return right.summary.modifiedAt.localeCompare(left.summary.modifiedAt) || leftKey.localeCompare(rightKey);
  });
}
