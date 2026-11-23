import {
  ResponsePartKind,
  TurnState,
  type MarkdownResponsePart,
  type ResponsePart,
} from '@microsoft/agent-host-protocol';

const LEADING_BLANK_LINES = /^(?:[ \t]*\r?\n)+/;

/**
 * Убирает пустые строки в начале реплики, не трогая отступ содержимого:
 * `trimStart()` съедал отступ первого code block.
 */
export function trimLeadingBlankLines(content: string): string {
  if (!content.trim()) return '';
  return content.replace(LEADING_BLANK_LINES, '');
}

export interface MarkdownBlock {
  /** Стабильный ключ React: индекс и id первой части блока. */
  readonly key: string;
  readonly content: string;
}

/** Часть ответа, которая рендерится не как markdown; `Markdown` уходит в отдельные блоки. */
export type NonMarkdownPart = Exclude<ResponsePart, MarkdownResponsePart>;

export type TurnItem =
  | { readonly kind: 'markdown'; readonly block: MarkdownBlock }
  | { readonly kind: 'part'; readonly part: NonMarkdownPart; readonly index: number };

/**
 * Плоский список для рендера в порядке потока. Соседние markdown-части
 * конкатенируются без разделителя: SDK предписывает выводить display text
 * именно так («derive display text by concatenating markdown parts»), поэтому
 * копирование отдаёт ровно тот текст, который видит пользователь. Любой другой
 * вид части — жёсткая граница. Пустые строки в начале блока срезаются один раз,
 * чтобы не терять отступ кода. `index` — позиция части в `responseParts`,
 * нужна для ключа `partKey`.
 */
export function layoutParts(parts: readonly ResponsePart[]): readonly TurnItem[] {
  const items: TurnItem[] = [];
  let open: { firstIndex: number; id: string; content: string } | undefined;

  const flush = () => {
    if (!open) return;
    const content = trimLeadingBlankLines(open.content);
    if (content) {
      items.push({
        kind: 'markdown',
        block: { key: `markdown:${open.firstIndex}|${open.id}`, content },
      });
    }
    open = undefined;
  };

  parts.forEach((part, index) => {
    if (part.kind === ResponsePartKind.Markdown) {
      if (open) {
        open.content += part.content;
      } else {
        open = { firstIndex: index, id: part.id, content: part.content };
      }
      return;
    }
    flush();
    items.push({ kind: 'part', part, index });
  });
  flush();
  return items;
}

/** Непустые markdown-блоки хода в порядке потока. */
export function markdownBlocks(parts: readonly ResponsePart[]): readonly MarkdownBlock[] {
  return layoutParts(parts).flatMap(item => (item.kind === 'markdown' ? [item.block] : []));
}

/**
 * Исходный markdown последнего непустого блока — текст «Скопировать ответ».
 * Части склеены как display text SDK, хвостовые пробелы срезаются, ведущий
 * отступ кода сохраняется. Про `TurnState` функция не знает, показ кнопки
 * решает вызывающий.
 */
export function agentResponseText(parts: readonly ResponsePart[]): string | undefined {
  let last: MarkdownBlock | undefined;
  for (const item of layoutParts(parts)) {
    if (item.kind === 'markdown') last = item.block;
  }
  return last?.content.trimEnd();
}

/** Текст «Скопировать ответ» и форка: только завершённый ход с непустым markdown. */
export function completedResponseText(
  state: TurnState | undefined,
  parts: readonly ResponsePart[],
): string | undefined {
  return state === TurnState.Complete ? agentResponseText(parts) : undefined;
}
