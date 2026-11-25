// Хвост вывода терминала для backend-зеркала.
//
// Зеркало хранит состояние канала, чтобы отдать снимок наблюдателю и пережить переподключение.
// Держать в памяти весь вывод PTY незачем: хост сам обрезает снимок канала (~82 КБ), а браузер
// всё равно получает поток кадрами. Поэтому у зеркала остаётся ограниченный хвост.
import type { TerminalContentPart } from '@microsoft/agent-host-protocol';

/** Сколько вывода терминала backend держит в зеркале: примерно как снимок хоста. */
export const TERMINAL_MIRROR_BYTES = 256 * 1024;

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function contentBytes(content: readonly TerminalContentPart[]): number {
  let total = 0;
  for (const part of content) total += byteLength(part.type === 'command' ? part.output : part.value);
  return total;
}

/**
 * Оставляет хвост вывода в пределах бюджета, не разрывая символы UTF-8.
 * Части старше бюджета отбрасываются целиком; последняя обрезается по границе символа.
 */
export function trimTerminalContent(content: readonly TerminalContentPart[], keepBytes: number): TerminalContentPart[] {
  if (contentBytes(content) <= keepBytes) return [...content];
  const kept: TerminalContentPart[] = [];
  let budget = keepBytes;
  for (let index = content.length - 1; index >= 0 && budget > 0; index -= 1) {
    const part = content[index]!;
    const text = part.type === 'command' ? part.output : part.value;
    const bytes = byteLength(text);
    if (bytes <= budget) {
      kept.unshift(part);
      budget -= bytes;
      continue;
    }
    const tail = tailBytes(text, budget);
    if (tail) kept.unshift(part.type === 'command' ? { ...part, output: tail } : { ...part, value: tail });
    break;
  }
  return kept;
}

function tailBytes(text: string, budget: number): string {
  let start = text.length;
  let used = 0;
  while (start > 0) {
    const code = text.charCodeAt(start - 1);
    // Суррогатная пара занимает 4 байта и не должна распадаться.
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdfff ? 4 : 3;
    if (used + width > budget) break;
    start -= code >= 0xdc00 && code <= 0xdfff ? 2 : 1;
    used += width;
  }
  return text.slice(start);
}
