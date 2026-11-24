import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTokens, formatUsageDay, formatUsageTotal, usageReasonLabel } from './usage-format.js';

test('неполная сумма показывается как нижняя граница, отсутствие данных — словами', () => {
  assert.match(formatTokens(1_234_567), /^1\s234\s567$/);
  assert.equal(formatUsageTotal(undefined, false), 'нет данных');
  assert.equal(formatUsageTotal(undefined, true), 'нет данных');
  assert.equal(formatUsageTotal(0, false), '0');
  assert.equal(formatUsageTotal(0, true), '≥ 0');
  assert.match(formatUsageTotal(1234, true), /^≥ 1\s234$/);
});

test('день без даты и причины неполноты имеют понятные подписи', () => {
  assert.equal(formatUsageDay('undated'), 'Без даты');
  assert.equal(formatUsageDay('2026-11-21'), '2026-11-21');
  for (const reason of ['chat-budget', 'page-budget', 'deadline'] as const) {
    assert.ok(usageReasonLabel(reason).length > 0);
  }
});
