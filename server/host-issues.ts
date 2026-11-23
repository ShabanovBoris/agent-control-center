import type { HostIssue } from '../shared/protocol.js';

export const MAX_HOST_ISSUES = 5;
export const MAX_ISSUE_CHARS = 500;

/**
 * Добавляет ошибку подключения в ограниченную историю. Повтор той же причины
 * (reconnect-цикл) не вытесняет остальные записи, а увеличивает счётчик.
 * Входной массив не мутируется.
 */
export function appendHostIssue(issues: readonly HostIssue[], message: string, at: string): HostIssue[] {
  const text = message.length <= MAX_ISSUE_CHARS ? message : `${message.slice(0, MAX_ISSUE_CHARS - 1)}…`;
  const last = issues.at(-1);
  if (last?.message === text) return [...issues.slice(0, -1), { at, message: text, count: last.count + 1 }];
  return [...issues, { at, message: text, count: 1 }].slice(-MAX_HOST_ISSUES);
}
