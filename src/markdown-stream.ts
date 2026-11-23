import { TurnState, type ResponsePart } from '@microsoft/agent-host-protocol';
import { layoutParts, type MarkdownBlock } from '../shared/markdown-parts';

export { layoutParts, trimLeadingBlankLines } from '../shared/markdown-parts';
export type { MarkdownBlock, NonMarkdownPart, TurnItem } from '../shared/markdown-parts';

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
