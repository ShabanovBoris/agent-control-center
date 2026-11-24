import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RestartBudget } from './up-restart.js';

test('бюджет: лимит попыток и экспоненциальный backoff', () => {
  const budget = new RestartBudget({ limit: 3, backoffMs: [10, 20, 30], resetAfterMs: 1000 });
  assert.equal(budget.canRestart(), true);
  assert.equal(budget.noteFailure(), 1);
  assert.equal(budget.nextDelayMs(), 10);
  assert.equal(budget.noteFailure(), 2);
  assert.equal(budget.nextDelayMs(), 20);
  assert.equal(budget.noteFailure(), 3);
  assert.equal(budget.nextDelayMs(), 30);
  assert.equal(budget.canRestart(), false);
});

test('бюджет: пустой backoff не даёт задержки', () => {
  const budget = new RestartBudget({ limit: 2, backoffMs: [] });
  budget.noteFailure();
  assert.equal(budget.nextDelayMs(), 0);
});

test('бюджет: счётчик сбрасывается только после стабильного окна', () => {
  let now = 0;
  const budget = new RestartBudget({ limit: 5, backoffMs: [1], resetAfterMs: 1000, now: () => now });
  budget.noteFailure();
  budget.noteFailure();
  budget.noteSuccess();
  now = 999;
  budget.noteFailure();
  assert.equal(budget.failureCount, 3, 'до окна стабильности счётчик продолжается');
  budget.noteSuccess();
  now = 2000;
  budget.noteFailure();
  assert.equal(budget.failureCount, 1, 'после окна стабильности счётчик сброшен');
});
