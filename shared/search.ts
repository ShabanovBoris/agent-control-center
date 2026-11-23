import { ResponsePartKind, type ActiveTurn, type Turn } from '@microsoft/agent-host-protocol';
import { layoutParts } from './markdown-parts.js';
import { plain } from './text.js';
import type { SearchFieldKind, TurnFieldKind } from './protocol.js';

export interface QueryLimits {
  maxQueryChars: number;
  maxQueryTokens: number;
}

export const DEFAULT_QUERY_LIMITS: QueryLimits = { maxQueryChars: 200, maxQueryTokens: 12 };

export interface PreparedQuery {
  /** Запрос после trim и обрезки по лимиту. */
  raw: string;
  normalized: string;
  tokens: readonly string[];
  truncated: boolean;
}

export interface NormalizedText {
  text: string;
  /** Для каждого UTF-16 code unit результата — индекс исходного текста. */
  map: readonly number[];
}

/**
 * Приводит текст к форме поиска, сохраняя карту обратно в исходные индексы:
 * подсветка обязана попадать в исходный текст, включая `Ё`, которую `toLowerCase`
 * превращает в `ё`.
 */
export function normalizeWithMap(text: string): NormalizedText {
  let normalized = '';
  const map: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const lower = text[index]!.toLowerCase().replace(/ё/g, 'е');
    normalized += lower;
    for (let offset = 0; offset < lower.length; offset += 1) map.push(index);
  }
  return { text: normalized, map };
}

export function normalizeText(text: string): string {
  return normalizeWithMap(text).text;
}

export function prepareQuery(raw: string, limits: QueryLimits = DEFAULT_QUERY_LIMITS): PreparedQuery | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const clipped = trimmed.slice(0, limits.maxQueryChars);
  const normalized = normalizeText(clipped);
  const words = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const tokens = [...new Set(words)].slice(0, limits.maxQueryTokens);
  if (tokens.length === 0) return undefined;
  return {
    raw: clipped,
    normalized,
    tokens,
    truncated: clipped.length < trimmed.length || new Set(words).size > tokens.length,
  };
}

/** Вес поля задаёт приоритет совпадения: заголовок важнее ответа агента. */
export const FIELD_WEIGHTS: Record<SearchFieldKind, number> = {
  title: 100,
  chat: 80,
  provider: 60,
  path: 55,
  host: 50,
  message: 45,
  response: 40,
  notification: 30,
  reasoning: 20,
  error: 20,
};

export interface SearchField {
  kind: SearchFieldKind;
  text: string;
  normalized: string;
  weight: number;
}

export function makeField(kind: SearchFieldKind, text: string): SearchField | undefined {
  if (!text.trim()) return undefined;
  return { kind, text, normalized: normalizeText(text), weight: FIELD_WEIGHTS[kind] };
}

export interface Scored {
  score: number;
  /** Поле, по которому удобнее строить сниппет. */
  field: SearchField;
}

/** 4 — поле целиком, 3 — с начала, 2 — с начала слова, 1 — подстрока, 0 — нет. */
export function matchQuality(haystack: string, token: string): number {
  if (haystack === token) return 4;
  if (haystack.startsWith(token)) return 3;
  let index = haystack.indexOf(token);
  while (index >= 0) {
    const previous = haystack[index - 1];
    if (previous === undefined || !/[\p{L}\p{N}]/u.test(previous)) return 2;
    index = haystack.indexOf(token, index + 1);
  }
  return haystack.includes(token) ? 1 : 0;
}

/**
 * Все токены должны найтись (AND). За каждый токен берётся лучшее поле,
 * а совпадение всех токенов в одном поле даёт небольшой бонус.
 */
export function scoreFields(fields: readonly SearchField[], tokens: readonly string[]): Scored | undefined {
  if (tokens.length === 0 || fields.length === 0) return undefined;
  let total = 0;
  let best: { quality: number; field: SearchField } | undefined;
  const perField = new Map<SearchField, number>();
  for (const token of tokens) {
    let winner: { quality: number; field: SearchField } | undefined;
    for (const field of fields) {
      const quality = matchQuality(field.normalized, token);
      if (quality === 0) continue;
      if (!winner || quality > winner.quality || (quality === winner.quality && field.weight > winner.field.weight)) {
        winner = { quality, field };
      }
    }
    if (!winner) return undefined;
    total += winner.quality * winner.field.weight;
    if (!best || winner.quality * winner.field.weight > best.quality * best.field.weight) best = winner;
    perField.set(winner.field, (perField.get(winner.field) ?? 0) + 1);
  }
  if (!best) return undefined;
  const allInOneField = [...perField.values()].some(count => count === tokens.length);
  return { score: total + (allInOneField ? 25 : 0), field: best.field };
}

export interface HighlightRange {
  readonly start: number;
  readonly end: number;
}

function sourceEnd(text: string, index: number): number {
  const code = text.charCodeAt(index);
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) return index + 2;
  return index + 1;
}

function locate(text: string, rawToken: string, limit = 64): HighlightRange[] {
  const token = normalizeText(rawToken);
  if (!token) return [];
  const { text: normalized, map } = normalizeWithMap(text);
  const ranges: HighlightRange[] = [];
  let index = normalized.indexOf(token);
  while (index >= 0 && ranges.length < limit) {
    const start = map[index];
    const last = map[index + token.length - 1];
    if (start !== undefined && last !== undefined) ranges.push({ start, end: sourceEnd(text, last) });
    index = normalized.indexOf(token, index + Math.max(1, token.length));
  }
  return ranges;
}

export function mergeRanges(ranges: readonly HighlightRange[]): HighlightRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: HighlightRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) };
    else merged.push(range);
  }
  return merged;
}

/** Диапазоны всех вхождений токенов запроса в исходном тексте. */
export function highlightRanges(text: string, tokens: readonly string[]): readonly (readonly [number, number])[] {
  return mergeRanges(tokens.flatMap(token => locate(text, token))).map(range => [range.start, range.end] as const);
}

const SNIPPET_LENGTH = 180;

/** Окно вокруг первого совпадения; токены за пределами окна не подсвечиваются. */
export function makeSnippet(field: SearchField, tokens: readonly string[]): { text: string; ranges: readonly (readonly [number, number])[] } {
  const source = field.text;
  if (source.length <= SNIPPET_LENGTH) {
    return { text: source, ranges: highlightRanges(source, tokens) };
  }
  const { text: normalized, map } = normalizeWithMap(source);
  let anchor = -1;
  for (const token of tokens) {
    const index = normalized.indexOf(token);
    if (index >= 0 && (anchor < 0 || index < anchor)) anchor = index;
  }
  const anchorSource = anchor >= 0 ? map[anchor]! : 0;
  let start = Math.max(0, anchorSource - Math.floor(SNIPPET_LENGTH / 3));
  let end = Math.min(source.length, start + SNIPPET_LENGTH);
  start = Math.max(0, end - SNIPPET_LENGTH);
  // Не режем слова, но и не уходим далеко в длинную строку без пробелов.
  let back = 0;
  while (start > 0 && back < 24 && !/\s/.test(source[start - 1]!)) { start -= 1; back += 1; }
  let forward = 0;
  while (end < source.length && forward < 24 && !/\s/.test(source[end - 1]!)) { end += 1; forward += 1; }
  const leading = start > 0 ? '…' : '';
  const trailing = end < source.length ? '…' : '';
  const text = `${leading}${source.slice(start, end)}${trailing}`;
  const all = tokens.flatMap(token => locate(source, token));
  const clipped = mergeRanges(all
    .filter(range => range.start >= start && range.end <= end)
    .map(range => ({ start: range.start - start + leading.length, end: range.end - start + leading.length })));
  return { text, ranges: clipped.map(range => [range.start, range.end] as const) };
}

export interface TurnFields {
  fields: SearchField[];
  truncated: boolean;
}

/**
 * Текст хода, который видит пользователь: сообщение, display text ответа,
 * reasoning, системные уведомления и ошибки. Tool calls, input requests и
 * вложения не индексируются.
 */
export function turnSearchFields(turn: Turn | ActiveTurn, maxChars: number): TurnFields {
  const parts: { kind: TurnFieldKind; text: string }[] = [{ kind: 'message', text: turn.message.text }];
  const markdown = layoutParts(turn.responseParts).flatMap(item => (item.kind === 'markdown' ? [item.block.content] : []));
  parts.push({ kind: 'response', text: markdown.join('\n\n') });
  parts.push({ kind: 'reasoning', text: turn.responseParts.flatMap(part => (part.kind === ResponsePartKind.Reasoning ? [part.content] : [])).join('\n\n') });
  parts.push({ kind: 'notification', text: turn.responseParts.flatMap(part => (part.kind === ResponsePartKind.SystemNotification ? [plain(part.content)] : [])).join('\n\n') });
  parts.push({ kind: 'error', text: turn.responseParts.flatMap(part => (part.kind === ResponsePartKind.Error ? [part.error.message] : [])).join('\n\n') });

  const fields: SearchField[] = [];
  let remaining = maxChars;
  let truncated = false;
  for (const part of parts) {
    if (remaining <= 0) { truncated ||= !!part.text.trim(); continue; }
    const text = part.text.slice(0, remaining);
    if (text.length < part.text.length) truncated = true;
    remaining -= text.length;
    const field = makeField(part.kind, text);
    if (field) fields.push(field);
  }
  return { fields, truncated };
}
