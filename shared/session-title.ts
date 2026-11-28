// Проверка ручного имени сессии. Одна и та же для backend и диалога панели:
// вход не обрезается молча, пустое или многострочное имя отклоняется с понятной причиной.
export const SESSION_TITLE_MAX = 120;

export type SessionTitleCheck =
  | { ok: true; title: string }
  | { ok: false; error: string };

export function checkSessionTitle(value: unknown): SessionTitleCheck {
  if (typeof value !== 'string') return { ok: false, error: 'Название должно быть строкой' };
  if (value.trim().length === 0) return { ok: false, error: 'Название не может быть пустым' };
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    return { ok: false, error: 'Название должно быть одной строкой без управляющих символов' };
  }
  if ([...value].length > SESSION_TITLE_MAX) {
    return { ok: false, error: `Название длиннее ${SESSION_TITLE_MAX} символов` };
  }
  return { ok: true, title: value };
}
