import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BudgetLatch, TOKEN_BUDGET_KEY, readTokenBudget, saveTokenBudget, usageBudgetLatch } from './usage-budget.js';

class MemoryStorage {
  readonly values = new Map<string, string>();
  fail?: Error;
  getItem(key: string): string | null {
    if (this.fail) throw this.fail;
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.fail) throw this.fail;
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    if (this.fail) throw this.fail;
    this.values.delete(key);
  }
}

test('порог читается как положительное целое и не принимает мусор', () => {
  const storage = new MemoryStorage();
  assert.equal(readTokenBudget(storage), undefined);
  for (const [saved, expected] of [
    ['1000', 1000], [' 42 ', 42], ['0', undefined], ['-1', undefined], ['1.5', undefined],
    ['1e6', undefined], ['abc', undefined], ['', undefined], ['99999999999999999999', undefined],
  ] as const) {
    storage.values.set(TOKEN_BUDGET_KEY, saved);
    assert.equal(readTokenBudget(storage), expected, saved);
  }
});

test('порог сохраняется и сбрасывается, невалидное значение не пишется', () => {
  const storage = new MemoryStorage();
  saveTokenBudget(storage, 250_000);
  assert.equal(storage.values.get(TOKEN_BUDGET_KEY), '250000');
  saveTokenBudget(storage, undefined);
  assert.equal(storage.values.has(TOKEN_BUDGET_KEY), false);
  for (const value of [0, -1, 1.5, Number.NaN]) assert.throws(() => saveTokenBudget(storage, value), /целым/);
});

test('ошибки storage пробрасываются, чтобы панель показала их пользователю', () => {
  const storage = new MemoryStorage();
  storage.fail = new Error('quota');
  assert.throws(() => readTokenBudget(storage), /quota/);
  assert.throws(() => saveTokenBudget(storage, 1), /quota/);
});

test('уведомление срабатывает один раз на переход ниже→выше', () => {
  const latch = new BudgetLatch();
  assert.equal(latch.observe('s', 50, 100), false, 'первое наблюдение тихое');
  assert.equal(latch.observe('s', 50, 100), false);
  assert.equal(latch.observe('s', 120, 100), true, 'переход снизу вверх');
  assert.equal(latch.observe('s', 150, 100), false, 'повторный рендер выше порога молчит');
  assert.equal(latch.observe('s', 10, 100), false, 'спуск ниже');
  assert.equal(latch.observe('s', 130, 100), true, 'следующий переход снова уведомляет');
});

test('первое наблюдение выше порога и смена порога тихие', () => {
  const latch = new BudgetLatch();
  assert.equal(latch.observe('s', 500, 100), false);
  assert.equal(latch.observe('s', 500, 100), false);
  assert.equal(latch.observe('s', 500, 600), false, 'новый порог — тихое наблюдение');
  assert.equal(latch.observe('s', 700, 600), true, 'переход уже относительно нового порога');
});

test('сессии и невалидные значения не влияют друг на друга', () => {
  const latch = new BudgetLatch();
  assert.equal(latch.observe('one', 10, 100), false);
  assert.equal(latch.observe('two', 50, 100), false);
  assert.equal(latch.observe('one', 200, 100), true);
  assert.equal(latch.observe('two', 300, 100), true);
  for (const value of [undefined, Number.NaN, -1]) assert.equal(latch.observe('one', value, 100), false);
  assert.equal(latch.observe('one', 300, 100), false, 'невалидное значение не сбрасывает состояние');
  latch.reset('one');
  assert.equal(latch.observe('one', 300, 100), false, 'после reset наблюдение снова тихое');
  assert.equal(latch.size, 2);
  latch.reset();
  assert.equal(latch.size, 0);
});

test('latch ограничен по числу сессий и вытесняет самые старые', () => {
  const latch = new BudgetLatch(2);
  latch.observe('a', 10, 100);
  latch.observe('b', 10, 100);
  latch.observe('c', 10, 100);
  assert.equal(latch.size, 2);
  assert.equal(latch.observe('a', 200, 100), false, 'запись a вытеснена и наблюдается заново');
  assert.equal(latch.observe('c', 200, 100), true, 'c ещё помнит, что была ниже');
});

test('общий latch панели экспортируется как singleton', () => {
  usageBudgetLatch.reset();
  assert.equal(usageBudgetLatch.observe('s', 1, 10), false);
  assert.equal(usageBudgetLatch.observe('s', 11, 10), true);
  usageBudgetLatch.reset();
});
