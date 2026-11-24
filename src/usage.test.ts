import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatState, UsageInfo } from '@microsoft/agent-host-protocol';
import {
  UNDATED_USAGE_DAY, aggregateUsage, chatContextUsage, resolveTimeZone, sessionTokenUsage, usageSourceOf,
} from '../shared/usage.js';

const chat = (...usage: (UsageInfo | undefined)[]): ChatState => ({ turns: usage.map((usage, id) => ({ id: String(id), usage })) }) as ChatState;

test('сумма за сессию включает все чаты, активный ход и кэш без повторного сложения', () => {
  const first = chat({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 60 });
  first.activeTurn = { id: 'active', usage: { inputTokens: 40, outputTokens: 5, cacheReadTokens: 20 } } as ChatState['activeTurn'];
  const usage = sessionTokenUsage([first, chat({ inputTokens: 200, outputTokens: 20 })], 'codex');
  assert.deepEqual(usage, { total: 375, input: 340, output: 35, cached: 80, partial: false, hasMoreTurns: false });
});

test('Codex: сумма обращений внутри хода имеет приоритет перед последним обращением', () => {
  const state = chat({
    inputTokens: 10, outputTokens: 1, cacheReadTokens: 5,
    _meta: { turnTokenTotals: [{ model: 'one', inputTokens: 300, outputTokens: 30, cachedTokens: 100 }, { model: 'two', inputTokens: 200, outputTokens: 20, cachedTokens: 50 }] },
  });
  const usage = sessionTokenUsage([state], 'codex');
  assert.equal(usage.total, 550);
  assert.equal(usage.cached, 150);
});

test('повторный snapshot и обновлённый cumulative usage не накапливаются как отдельные траты', () => {
  const state = chat({ inputTokens: 100, outputTokens: 10 });
  assert.equal(sessionTokenUsage([state], 'codex').total, 110);
  assert.equal(sessionTokenUsage([state], 'codex').total, 110);
  state.turns[0]!.usage = { inputTokens: 200, outputTokens: 20 };
  assert.equal(sessionTokenUsage([state], 'codex').total, 220);
});

test('пустая сессия, отсутствие usage и неполная загрузка различаются', () => {
  assert.equal(sessionTokenUsage([chat()], 'codex').total, 0);
  assert.equal(sessionTokenUsage([chat(undefined)], 'codex').total, undefined);
  const usage = sessionTokenUsage([undefined, chat({ inputTokens: 100, outputTokens: 10 }, undefined)], 'codex');
  assert.equal(usage.total, 110);
  assert.equal(usage.partial, true);
  const paged = chat({ inputTokens: 50, outputTokens: 5 });
  paged.turnsNextCursor = 'older';
  assert.equal(sessionTokenUsage([paged], 'codex').partial, true);
  assert.equal(sessionTokenUsage([paged], 'codex').hasMoreTurns, true);
});

test('Claude: чтение кэша добавляется к некэшированному входу, непубликуемая запись кэша не выдумывается', () => {
  const usage = sessionTokenUsage([chat({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 200 })], 'claude');
  assert.equal(usage.input, 300);
  assert.equal(usage.total, 310);
  assert.equal(usage.partial, true);
});

test('контекст берётся из последнего запроса без повторного учёта кэша и reasoning', () => {
  const state = chat(
    { inputTokens: 130017, outputTokens: 1683, _meta: { modelContextWindow: 475000 } },
    {
      inputTokens: 131766, outputTokens: 661, cacheReadTokens: 131584,
      _meta: {
        modelContextWindow: 475000,
        reasoningOutputTokens: 516,
        turnTokenTotals: [{ model: 'codex', inputTokens: 479211, outputTokens: 3527, cachedTokens: 460544 }],
      },
    },
    undefined,
  );
  assert.deepEqual(chatContextUsage(state), { usedTokens: 132427, windowTokens: 475000 });
});

test('новый замер активного хода может уменьшить заполненность после сжатия', () => {
  const state = chat({ inputTokens: 150000, outputTokens: 100, _meta: { modelContextWindow: 200000 } });
  state.activeTurn = { id: 'live' } as ChatState['activeTurn'];
  assert.deepEqual(chatContextUsage(state), { usedTokens: 150100, windowTokens: 200000 });

  state.activeTurn!.usage = { inputTokens: 12000, outputTokens: 300, _meta: { modelContextWindow: 200000 } };
  assert.deepEqual(chatContextUsage(state), { usedTokens: 12300, windowTokens: 200000 });
});

test('отсутствие замера отличается от явно сообщённого пустого окна', () => {
  assert.equal(chatContextUsage(undefined), undefined);
  assert.equal(chatContextUsage(chat()), undefined);
  assert.equal(chatContextUsage(chat({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 800000 })), undefined);
  assert.equal(chatContextUsage(chat({ inputTokens: 100, outputTokens: 10, _meta: { modelContextWindow: 0 } })), undefined);
  assert.deepEqual(chatContextUsage(chat({ inputTokens: 0, outputTokens: 0, _meta: { modelContextWindow: 475000 } })), { usedTokens: 0, windowTokens: 475000 });
});

const totalsOf = (usage: ReturnType<typeof aggregateUsage>) => {
  const { days: _days, models: _models, ...totals } = usage;
  return totals;
};
const sumBuckets = (buckets: readonly { total: number | undefined }[]) => buckets.reduce((sum, bucket) => sum + (bucket.total ?? 0), 0);

test('агрегаты по дням и моделям совпадают с sessionTokenUsage на тех же данных', () => {
  const state = chat(
    { inputTokens: 100, outputTokens: 10, cacheReadTokens: 60 },
        { inputTokens: 10, outputTokens: 1, _meta: { turnTokenTotals: [{ model: 'one', inputTokens: 300, outputTokens: 30 }, { model: 'two', inputTokens: 200, outputTokens: 20 }] } },
  );
  for (const provider of ['codex', 'claude']) {
    const usage = aggregateUsage([usageSourceOf(state, provider)], { timeZone: 'UTC' });
    assert.deepEqual(totalsOf(usage), sessionTokenUsage([state], provider));
    assert.equal(sumBuckets(usage.days), usage.total);
    assert.equal(sumBuckets(usage.models), usage.total);
    assert.deepEqual(usage.models.flatMap(model => model.model ? [model.model] : []).sort(), ['one', 'two']);
    assert.equal(usage.models.some(model => model.model === undefined), true, 'ход без модели остаётся отдельным бакетом');
  }
});

test('день считается в часовом поясе браузера, а не в UTC', () => {
  const state = chat({ inputTokens: 10, outputTokens: 1 });
  state.turns[0]!.startedAt = '2026-11-20T23:30:00.000Z';
  const moscow = aggregateUsage([usageSourceOf(state, 'codex')], { timeZone: 'Europe/Moscow' });
  const utc = aggregateUsage([usageSourceOf(state, 'codex')], { timeZone: 'UTC' });
  assert.deepEqual(moscow.days.map(day => day.day), ['2026-11-21']);
  assert.deepEqual(utc.days.map(day => day.day), ['2026-11-20']);
});

test('ход без даты попадает в undated и делает неполной только разбивку по дням', () => {
  const state = chat({ inputTokens: 10, outputTokens: 1 });
  const usage = aggregateUsage([usageSourceOf(state, 'codex')], { timeZone: 'UTC' });
  assert.equal(usage.partial, false);
  assert.equal(usage.total, 11);
  assert.deepEqual(usage.days.map(day => day.day), [UNDATED_USAGE_DAY]);
  assert.equal(usage.days[0]!.partial, true);
  assert.equal(usage.models[0]!.partial, false);
});

test('неполная история помечает partial на сумме, сессии, днях и моделях', () => {
  const state = chat({ inputTokens: 10, outputTokens: 1 });
  state.turnsNextCursor = 'older';
  const source = usageSourceOf(state, 'codex');
  const usage = aggregateUsage([source], { timeZone: 'UTC' });
  assert.equal(source.partial, false);
  assert.equal(usage.hasMoreTurns, true);
  assert.equal(usage.partial, true);
  assert.equal(usage.days[0]!.partial, true);
  assert.equal(usage.models[0]!.partial, true);
});

test('модель строки берётся из turnTokenTotals, usage или выбранной модели хода', () => {
  const state = {
    turns: [
      { id: 'a', message: { model: { id: 'from-message' } }, usage: { inputTokens: 1, outputTokens: 1 } },
      { id: 'b', message: { model: { id: 'ignored' } }, usage: { inputTokens: 2, outputTokens: 2, model: 'from-usage' } },
      { id: 'c', message: { model: { id: 'ignored' } }, usage: { inputTokens: 3, outputTokens: 3, model: 'from-usage', _meta: { turnTokenTotals: [{ model: 'from-totals', inputTokens: 4, outputTokens: 4 }] } } },
    ],
  } as unknown as ChatState;
  const usage = aggregateUsage([usageSourceOf(state, 'codex')], { timeZone: 'UTC' });
  assert.deepEqual(usage.models.map(model => [model.model, model.total]).sort(), [
    ['from-message', 2],
    ['from-totals', 8],
    ['from-usage', 4],
  ]);
});

test('кэш активного хода учитывается по умолчанию и исключается для кэша истории', () => {
  const state = chat({ inputTokens: 10, outputTokens: 1 });
  state.activeTurn = { id: 'live', startedAt: '2026-11-20T10:00:00.000Z', usage: { inputTokens: 5, outputTokens: 1 } } as ChatState['activeTurn'];
  assert.equal(sessionTokenUsage([state], 'codex').total, 17);
  const cached = usageSourceOf(state, 'codex', { includeActiveTurn: false });
  assert.equal(cached.turns, 1);
  assert.equal(aggregateUsage([cached], { timeZone: 'UTC' }).total, 11);
});

test('resolveTimeZone принимает только известные зоны, aggregate падает на неизвестной', () => {
  assert.equal(resolveTimeZone('Europe/Moscow'), 'Europe/Moscow');
  assert.equal(resolveTimeZone(' UTC '), 'UTC');
  for (const value of [undefined, null, 42, '', 'x'.repeat(65), 'Mars/Base']) assert.equal(resolveTimeZone(value), undefined, String(value));
  assert.throws(() => aggregateUsage([], { timeZone: 'Mars/Base' }), /часовой пояс/);
});
