import type { ReactNode } from 'react';
import { mergeRanges } from '../../shared/search';

/** Подсветка совпадений без dangerouslySetInnerHTML: React экранирует текст. */
export function HighlightedText({ text, ranges }: { text: string; ranges: readonly (readonly [number, number])[] }) {
  const merged = mergeRanges(ranges.map(([start, end]) => ({ start, end })))
    .map(range => ({ start: Math.max(0, Math.min(range.start, text.length)), end: Math.max(0, Math.min(range.end, text.length)) }))
    .filter(range => range.end > range.start);
  if (merged.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  merged.forEach((range, index) => {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    parts.push(<mark key={index}>{text.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
