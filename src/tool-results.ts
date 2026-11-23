import type { ToolResultSubagentContent, ToolResultTerminalContent } from '@microsoft/agent-host-protocol';

/** Сколько строк сохранённого вывода терминала ещё показываем целиком. */
export const TERMINAL_COLLAPSE_LINES = 20;
/** Сколько символов сохранённого вывода терминала ещё показываем целиком. */
export const TERMINAL_COLLAPSE_CHARS = 4000;

export type TerminalPreview =
  | { state: 'missing' }
  | { state: 'empty' }
  | { state: 'present'; text: string; lines: number; long: boolean };

/**
 * Терминальный результат в виде, готовом для рендера. `unreported` — хост ещё не
 * прислал итог команды (идёт выполнение или ответ неполный); это не ошибка.
 */
export type TerminalResultView =
  | { state: 'unreported'; resource: string; title: string; isPty?: boolean }
  | {
    state: 'exited';
    resource: string;
    title: string;
    isPty?: boolean;
    exitCode?: number;
    failed: boolean;
    truncated: boolean;
    preview: TerminalPreview;
  };

export interface SubagentTarget {
  chatUri: string;
  name: string;
  agentName?: string;
  description?: string;
  available: boolean;
}

/** Доступ к уже существующей навигации по чатам сессии: набор видимых чатов и переход в чат. */
export interface SubagentNavigation {
  availableChats: ReadonlySet<string>;
  onOpenChat(chatUri: string): void;
}

function countLines(text: string): number {
  let lines = 1;
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) lines += 1;
  return lines;
}

/** Длинный вывод сворачиваем локально, не полагаясь на `truncated` от хоста. */
export function isLongTerminalPreview(text: string): boolean {
  return text.length > TERMINAL_COLLAPSE_CHARS || countLines(text) > TERMINAL_COLLAPSE_LINES;
}

function terminalPreview(text: string | undefined): TerminalPreview {
  if (text === undefined) return { state: 'missing' };
  // Пробельный вывод — это вывод: не нормализуем и не обрезаем текст.
  if (text === '') return { state: 'empty' };
  const lines = countLines(text);
  return { state: 'present', text, lines, long: isLongTerminalPreview(text) };
}

/**
 * Переносит `ToolResultTerminalContent` в view-модель. Текст `preview` отдаётся
 * как есть: VT-последовательности PTY не разбираются и не вырезаются.
 */
export function terminalResultView(content: ToolResultTerminalContent): TerminalResultView {
  if (content.result === undefined) {
    return { state: 'unreported', resource: content.resource, title: content.title, isPty: content.isPty };
  }
  const { exitCode, preview, truncated } = content.result;
  return {
    state: 'exited',
    resource: content.resource,
    title: content.title,
    isPty: content.isPty,
    exitCode,
    // Отсутствие кода выхода — «не сообщён», а не успех и не ошибка.
    failed: exitCode !== undefined && exitCode !== 0,
    truncated: truncated === true,
    preview: terminalPreview(preview),
  };
}

/**
 * Чат подагента доступен, только если он опубликован в каталоге сессии: переходить
 * по URI из ответа хоста вслепую нельзя.
 */
export function subagentTarget(
  content: ToolResultSubagentContent,
  availableChats?: ReadonlySet<string>,
): SubagentTarget {
  return {
    chatUri: content.resource,
    name: content.title,
    agentName: content.agentName,
    description: content.description,
    available: availableChats?.has(content.resource) === true,
  };
}
