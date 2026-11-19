import type { ChatState, UsageInfo } from '@microsoft/agent-host-protocol';

export interface SessionTokenUsage {
  total: number | undefined;
  input: number;
  output: number;
  cached: number;
  partial: boolean;
  hasMoreTurns: boolean;
}

const tokenCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function chatContextUsage(chat: ChatState | undefined): { usedTokens: number; windowTokens: number } | undefined {
  const usage = chat?.activeTurn?.usage ?? chat?.turns.findLast(turn => turn.usage !== undefined)?.usage;
  const windowTokens = usage?._meta?.modelContextWindow;
  if (!tokenCount(windowTokens) || windowTokens === 0 || !tokenCount(usage?.inputTokens) || !tokenCount(usage?.outputTokens)) return undefined;

  // VS Code передаёт usage последнего запроса Codex вместе с размером его окна.
  // Чтение кэша уже входит во вход, а токены reasoning входят в выход.
  return { usedTokens: usage.inputTokens + usage.outputTokens, windowTokens };
}

function countsOf(usage: UsageInfo) {
  const totals = usage._meta?.turnTokenTotals;
  // У Codex верхний usage — последнее обращение к модели, метаданные — сумма всех обращений хода.
  const rows: { inputTokens?: unknown; outputTokens?: unknown; cachedTokens?: unknown }[] =
    Array.isArray(totals) && totals.length > 0 && totals.every(row => row && typeof row === 'object')
      ? totals
      : [{ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cacheReadTokens }];
  let input = 0, output = 0, cached = 0, reported = false, partial = false;
  for (const row of rows) {
    if (tokenCount(row.inputTokens)) { input += row.inputTokens; reported = true; } else partial = true;
    if (tokenCount(row.outputTokens)) { output += row.outputTokens; reported = true; } else partial = true;
    if (tokenCount(row.cachedTokens)) cached += row.cachedTokens;
  }
  return { input, output, cached, reported, partial };
}

export function sessionTokenUsage(chats: readonly (ChatState | undefined)[], provider: string): SessionTokenUsage {
  let input = 0, output = 0, cached = 0, reported = 0, turns = 0;
  let partial = chats.some(chat => chat === undefined), hasMoreTurns = false;
  for (const chat of chats) {
    if (!chat) continue;
    hasMoreTurns ||= chat.turnsNextCursor !== undefined;
    for (const turn of [...chat.turns, ...(chat.activeTurn ? [chat.activeTurn] : [])]) {
      turns++;
      if (!turn.usage) { partial = true; continue; }
      const counts = countsOf(turn.usage);
      reported += Number(counts.reported);
      input += counts.input;
      output += counts.output;
      cached += counts.cached;
      partial ||= counts.partial;
    }
  }
  // Адаптер VS Code для Claude передаёт некэшированный вход отдельно от чтения кэша.
  // Запись кэша адаптер не публикует: для Claude это нижняя граница, а не точный биллинг.
  if (provider === 'claude') { input += cached; partial = true; }
  partial ||= hasMoreTurns;
  return { total: reported > 0 || (turns === 0 && !chats.some(chat => chat === undefined)) ? input + output : undefined, input, output, cached, partial, hasMoreTurns };
}
