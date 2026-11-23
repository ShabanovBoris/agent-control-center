// Адрес выбранной сессии живёт в hash. Логику читают и браузер, и backend (deep link push),
// поэтому она общая и не зависит от DOM.
export interface Selection {
  hostId: string;
  sessionUri: string;
  chatUri?: string;
  /** Ход, к которому нужно прокрутить ленту после открытия. */
  turnId?: string;
}

export function selectionFromHash(hash: string): Selection | null {
  let fragment = hash.slice(1);
  if (!fragment.includes('|')) {
    // Схемы URI отличают закодированные разделители от черты внутри значения.
    fragment = fragment.replace(/%7c(?=ahp-(?:session|chat)(?::|%3a))/gi, '|');
  }
  try {
    const [hostId, sessionUri, chatUri, turnId] = fragment.split('|').map(decodeURIComponent);
    return hostId && sessionUri
      ? { hostId, sessionUri, ...(chatUri ? { chatUri } : {}), ...(chatUri && turnId ? { turnId } : {}) }
      : null;
  } catch {
    return null;
  }
}

/** Адрес восстанавливает выбранную сессию, чат и ход после перезагрузки. */
export function selectionToHash(selection: Selection | null): string {
  if (!selection) return '';
  const { hostId, sessionUri, chatUri, turnId } = selection;
  const parts = chatUri ? [hostId, sessionUri, chatUri, ...(turnId ? [turnId] : [])] : [hostId, sessionUri];
  return `#${parts.map(encodeURIComponent).join('|')}`;
}
