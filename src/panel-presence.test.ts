import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Selection } from '../shared/routing';
import { panelVisibility } from './panel-presence';

const selection: Selection = { hostId: 'local', sessionUri: 'ahp-session:/s', chatUri: 'ahp-chat:/c' };

test('desktop с открытой сессией: detail видим, presence содержит выбор', () => {
  const view = { creating: false, showHealth: false, showTerminal: false, sessionList: false, mobile: false };
  assert.deepEqual(panelVisibility(selection, view), { detailVisible: true, presence: selection });
});

test('форма, диагностика и пустой выбор прячут detail и снимают presence', () => {
  for (const view of [
    { creating: true, showHealth: false, showTerminal: false, sessionList: false, mobile: false },
    { creating: false, showHealth: true, showTerminal: false, sessionList: false, mobile: false },
    { creating: false, showHealth: false, showTerminal: false, sessionList: false, mobile: false },
  ]) {
    assert.deepEqual(panelVisibility(null, view), { detailVisible: false, presence: null });
  }
  assert.deepEqual(
    panelVisibility(selection, { creating: true, showHealth: false, showTerminal: false, sessionList: false, mobile: false }),
    { detailVisible: false, presence: null },
  );
  assert.deepEqual(
    panelVisibility(selection, { creating: false, showHealth: true, showTerminal: false, sessionList: false, mobile: false }),
    { detailVisible: false, presence: null },
  );
});

test('на телефоне список сессий скрывает detail, хотя selection остаётся', () => {
  assert.deepEqual(
    panelVisibility(selection, { creating: false, showHealth: false, showTerminal: false, sessionList: true, mobile: true }),
    { detailVisible: false, presence: null },
  );
  assert.deepEqual(
    panelVisibility(selection, { creating: false, showHealth: false, showTerminal: false, sessionList: false, mobile: true }),
    { detailVisible: true, presence: selection },
  );
});

test('страница терминала прячет detail и снимает presence', () => {
  assert.deepEqual(
    panelVisibility(selection, { creating: false, showHealth: false, showTerminal: true, sessionList: false, mobile: false }),
    { detailVisible: false, presence: null },
  );
});

test('presence сохраняет адрес сессии и открытый чат, включая ход', () => {
  const deep: Selection = { ...selection, turnId: 'turn-1' };
  const { presence } = panelVisibility(deep, { creating: false, showHealth: false, showTerminal: false, sessionList: false, mobile: false });
  assert.deepEqual(presence, deep);
});
