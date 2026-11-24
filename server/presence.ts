import { channelKey } from '../shared/reduce.js';

// Presence привязан к устройству (origin), а не к вкладке: иначе открытая на Mac сессия
// глушила бы push на телефон.
export interface Presence {
  origin: string;
  visible: boolean;
  selection?: { hostId: string; sessionUri: string };
}

/** Сессия видима, только если вкладка видима и на устройстве реально открыт её detail. */
function visibleSelection(presence: Presence): { hostId: string; sessionUri: string } | undefined {
  if (!presence.visible || !presence.origin) return undefined;
  return presence.selection;
}

/** Устройства, на которых эта сессия уже видима и push им не нужен. */
export function visibleOrigins(
  presences: Iterable<Presence>, hostId: string, sessionUri: string,
): Set<string> {
  const origins = new Set<string>();
  for (const presence of presences) {
    const selection = visibleSelection(presence);
    if (selection?.hostId !== hostId || selection.sessionUri !== sessionUri) continue;
    origins.add(presence.origin);
  }
  return origins;
}

/** Обратная форма для сводки: по каждой видимой сессии — origin, где она открыта. */
export function visibleSessions(presences: Iterable<Presence>): Map<string, Set<string>> {
  const sessions = new Map<string, Set<string>>();
  for (const presence of presences) {
    const selection = visibleSelection(presence);
    if (!selection) continue;
    const key = channelKey(selection.hostId, selection.sessionUri);
    const origins = sessions.get(key);
    if (origins) origins.add(presence.origin);
    else sessions.set(key, new Set([presence.origin]));
  }
  return sessions;
}
