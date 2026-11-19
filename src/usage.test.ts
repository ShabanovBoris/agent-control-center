import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatState, UsageInfo } from '@microsoft/agent-host-protocol';
import { chatContextUsage, sessionTokenUsage } from './usage.js';

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
