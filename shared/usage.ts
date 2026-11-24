import type { ActiveTurn, ChatState, Turn, UsageInfo } from '@microsoft/agent-host-protocol';

/** Одна строка расхода: обращение к модели внутри хода либо весь ход без разбивки. */
export interface UsageRow {
  model?: string;
  startedAt?: string;
  input: number;
  output: number;
  cached: number;
  /** Хост сообщил хотя бы один из счётчиков входа/выхода. */
  reported: boolean;
  partial: boolean;
}

/** Расход одного чата — единица, из которой собираются и панель, и отчёт. */
export interface UsageSource {
  rows: UsageRow[];
  /** Все ходы, включая ходы без usage: отличает пустой чат от неполного. */
  turns: number;
  hasMoreTurns: boolean;
  missing: boolean;
  /** Строки или ходы неполны; `hasMoreTurns` сюда не входит и учитывается в суммах. */
  partial: boolean;
}

export interface UsageTotals {
  total: number | undefined;
  input: number;
  output: number;
  cached: number;
  partial: boolean;
  hasMoreTurns: boolean;
}

export interface UsageModelBucket extends Omit<UsageTotals, 'hasMoreTurns'> {
  model?: string;
}

export interface UsageDayBucket extends Omit<UsageTotals, 'hasMoreTurns'> {
  day: string;
  models: UsageModelBucket[];
}

export interface UsageAggregate extends UsageTotals {
  days: UsageDayBucket[];
  models: UsageModelBucket[];
}

export type SessionTokenUsage = UsageTotals;

export const UNDATED_USAGE_DAY = 'undated';

const tokenCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Строка без даты не делает сумму токенов неполной: дата нужна только разбивке по дням. */
const modelOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

export function chatContextUsage(chat: ChatState | undefined): { usedTokens: number; windowTokens: number } | undefined {
  const usage = chat?.activeTurn?.usage ?? chat?.turns.findLast(turn => turn.usage !== undefined)?.usage;
  const windowTokens = usage?._meta?.modelContextWindow;
  if (!tokenCount(windowTokens) || windowTokens === 0 || !tokenCount(usage?.inputTokens) || !tokenCount(usage?.outputTokens)) return undefined;

  // VS Code передаёт usage последнего запроса Codex вместе с размером его окна.
  // Чтение кэша уже входит во вход, а токены reasoning входят в выход.
  return { usedTokens: usage.inputTokens + usage.outputTokens, windowTokens };
}

/**
 * Строки одного usage. У Codex верхний usage — последнее обращение к модели,
 * метаданные `turnTokenTotals` — сумма всех обращений хода, поэтому они важнее.
 */
function countsOf(usage: UsageInfo, fallbackModel: string | undefined): Omit<UsageRow, 'startedAt'>[] {
  const totals = usage._meta?.turnTokenTotals;
  const sourceRows: Record<string, unknown>[] =
    Array.isArray(totals) && totals.length > 0 && totals.every(row => row && typeof row === 'object')
      ? totals as Record<string, unknown>[]
      : [{ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cacheReadTokens }];
  return sourceRows.map(row => {
    let input = 0, output = 0, cached = 0, reported = false, partial = false;
    if (tokenCount(row.inputTokens)) { input = row.inputTokens; reported = true; } else partial = true;
    if (tokenCount(row.outputTokens)) { output = row.outputTokens; reported = true; } else partial = true;
    if (tokenCount(row.cachedTokens)) cached = row.cachedTokens;
    const model = modelOf(row.model) ?? modelOf(usage.model) ?? fallbackModel;
    return { ...(model ? { model } : {}), input, output, cached, reported, partial };
  });
}

/**
 * Строки чата для агрегатов. Здесь намеренно используются все `chat.turns`, а не
 * `visibleTurns`: панель и отчёт обязаны совпадать с `sessionTokenUsage`, а поиск
 * отдельно решает, какие ходы индексировать.
 */
export function usageSourceOf(
  chat: ChatState | undefined,
  provider: string,
  options: { includeActiveTurn?: boolean } = {},
): UsageSource {
  if (!chat) return { rows: [], turns: 0, hasMoreTurns: false, missing: true, partial: true };
  const turns: readonly (Turn | ActiveTurn)[] = options.includeActiveTurn === false || !chat.activeTurn
    ? chat.turns
    : [...chat.turns, chat.activeTurn];
  const rows: UsageRow[] = [];
  let partial = false;
  for (const turn of turns) {
    if (!turn.usage) { partial = true; continue; }
    const fallbackModel = modelOf(turn.message?.model?.id);
    for (const row of countsOf(turn.usage, fallbackModel)) {
      rows.push({ ...(turn.startedAt ? { startedAt: turn.startedAt } : {}), ...row });
    }
  }
  // Адаптер VS Code для Claude передаёт некэшированный вход отдельно от чтения кэша.
  // Запись кэша адаптер не публикует: для Claude это нижняя граница, а не точный биллинг.
  if (provider === 'claude') {
    partial = true;
    for (const row of rows) {
      row.input += row.cached;
      row.partial = true;
    }
  }
  return { rows, turns: turns.length, hasMoreTurns: chat.turnsNextCursor !== undefined, missing: false, partial };
}

/** Суммы без разбивок; `incomplete` — внешняя неполнота истории (отчёт, бюджеты). */
export function usageTotalsOf(sources: readonly UsageSource[], incomplete = false): UsageTotals {
  let input = 0, output = 0, cached = 0, turns = 0, reported = false, partial = incomplete, missing = false, hasMoreTurns = false;
  for (const source of sources) {
    turns += source.turns;
    missing ||= source.missing;
    hasMoreTurns ||= source.hasMoreTurns;
    partial ||= source.partial || source.hasMoreTurns;
    for (const row of source.rows) {
      input += row.input;
      output += row.output;
      cached += row.cached;
      reported ||= row.reported;
      partial ||= row.partial;
    }
  }
  // Пустая сессия — доказанный ноль; неизвестный чат или ходы без usage — нет.
  return {
    total: reported || (turns === 0 && !missing) ? input + output : undefined,
    input, output, cached, partial, hasMoreTurns,
  };
}

export function sessionTokenUsage(chats: readonly (ChatState | undefined)[], provider: string): SessionTokenUsage {
  return usageTotalsOf(chats.map(chat => usageSourceOf(chat, provider)));
}

/** Часовой пояс из wire-запроса: строка, которую принимает Intl, иначе undefined. */
export function resolveTimeZone(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const timeZone = value.trim();
  if (timeZone.length < 1 || timeZone.length > 64) return undefined;
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

interface BucketAccumulator {
  input: number;
  output: number;
  cached: number;
  reported: boolean;
}

function bucketTotals(accumulator: BucketAccumulator, partial: boolean): Omit<UsageTotals, 'hasMoreTurns'> {
  return {
    total: accumulator.reported ? accumulator.input + accumulator.output : undefined,
    input: accumulator.input,
    output: accumulator.output,
    cached: accumulator.cached,
    partial,
  };
}

function addRow(accumulator: BucketAccumulator, row: UsageRow): void {
  accumulator.input += row.input;
  accumulator.output += row.output;
  accumulator.cached += row.cached;
  accumulator.reported ||= row.reported;
}

/**
 * Куб «день × модель» плюс суммы. Один форматтер на вызов; результат даты не кэшируется
 * между вызовами, потому что часовой пояс приходит из браузера.
 */
export function aggregateUsage(
  sources: readonly UsageSource[],
  options: { timeZone: string; incomplete?: boolean },
): UsageAggregate {
  const timeZone = resolveTimeZone(options.timeZone);
  if (!timeZone) throw new Error(`Неизвестный часовой пояс: ${options.timeZone}`);
  const totals = usageTotalsOf(sources, options.incomplete ?? false);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', calendar: 'gregory', numberingSystem: 'latn',
  });
  const dayCache = new Map<string, string | undefined>();
  const dayOf = (startedAt: string | undefined): string | undefined => {
    if (!startedAt) return undefined;
    if (dayCache.has(startedAt)) return dayCache.get(startedAt);
    let day: string | undefined;
    if (!Number.isNaN(Date.parse(startedAt))) {
      const parts = formatter.formatToParts(new Date(startedAt));
      const year = parts.find(part => part.type === 'year')?.value;
      const month = parts.find(part => part.type === 'month')?.value;
      const date = parts.find(part => part.type === 'day')?.value;
      if (year && month && date) day = `${year}-${month}-${date}`;
    }
    dayCache.set(startedAt, day);
    return day;
  };

  const days = new Map<string, BucketAccumulator>();
  const daysByModel = new Map<string, Map<string, BucketAccumulator>>();
  const models = new Map<string, BucketAccumulator>();
  const bump = (map: Map<string, BucketAccumulator>, key: string, row: UsageRow) => {
    let accumulator = map.get(key);
    if (!accumulator) { accumulator = { input: 0, output: 0, cached: 0, reported: false }; map.set(key, accumulator); }
    addRow(accumulator, row);
  };
  for (const source of sources) {
    for (const row of source.rows) {
      const day = dayOf(row.startedAt) ?? UNDATED_USAGE_DAY;
      const model = row.model ?? '';
      bump(days, day, row);
      bump(models, model, row);
      let dayModels = daysByModel.get(day);
      if (!dayModels) { dayModels = new Map(); daysByModel.set(day, dayModels); }
      bump(dayModels, model, row);
    }
  }

  const modelBuckets = (map: Map<string, BucketAccumulator>): UsageModelBucket[] =>
    [...map.entries()]
      .map(([model, accumulator]) => ({
        ...(model ? { model } : {}),
        ...bucketTotals(accumulator, totals.partial),
      }))
      .sort((left, right) =>
        (right.total ?? 0) - (left.total ?? 0)
        || (left.model ?? '').localeCompare(right.model ?? ''));

  return {
    ...totals,
    days: [...days.entries()]
      .sort(([left], [right]) =>
        left === UNDATED_USAGE_DAY ? 1
          : right === UNDATED_USAGE_DAY ? -1
            : right.localeCompare(left))
      .map(([day, accumulator]) => ({
        day,
        ...bucketTotals(accumulator, totals.partial || day === UNDATED_USAGE_DAY),
        models: modelBuckets(daysByModel.get(day) ?? new Map()),
      })),
    models: modelBuckets(models),
  };
}
