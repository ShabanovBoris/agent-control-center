import { describeError } from './errors';

export type ClipboardWriter = (text: string) => Promise<void>;

export type CopyResult = { ok: true } | { ok: false; message: string };

/**
 * `navigator.clipboard.writeText` теряет `this` при вызове как обычная функция,
 * поэтому writer замыкает объект clipboard.
 */
export function browserClipboard(): ClipboardWriter | undefined {
  try {
    const clipboard = globalThis.navigator?.clipboard;
    return typeof clipboard?.writeText === 'function' ? text => clipboard.writeText(text) : undefined;
  } catch {
    return undefined;
  }
}

/** Не бросает: UI получает готовое сообщение для toast. */
export async function copyText(text: string, write?: ClipboardWriter): Promise<CopyResult> {
  try {
    const writer = write ?? browserClipboard();
    if (!writer) return { ok: false, message: 'Буфер обмена недоступен' };
    await writer(text);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}