// Presence привязан к устройству (origin), а не к вкладке: иначе открытая на Mac сессия
// глушила бы push на телефон.
export interface Presence {
  origin: string;
  visible: boolean;
  selection?: { hostId: string; sessionUri: string };
}

/** Устройства, на которых эта сессия уже видима и push им не нужен. */
export function visibleOrigins(
  presences: Iterable<Presence>, hostId: string, sessionUri: string,
): Set<string> {
  const origins = new Set<string>();
  for (const presence of presences) {
    if (!presence.visible || !presence.origin) continue;
    if (presence.selection?.hostId !== hostId || presence.selection.sessionUri !== sessionUri) continue;
    origins.add(presence.origin);
  }
  return origins;
}
