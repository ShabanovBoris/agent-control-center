import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectionFromHash, selectionToHash } from '../shared/routing.js';

test('ссылка на сессию восстанавливает обе части адреса', () => {
  assert.deepEqual(selectionFromHash('#a|b'), { hostId: 'a', sessionUri: 'b' });
  assert.deepEqual(selectionFromHash('#host%20id|ahp-session%3A%2Fa%7Cb'), {
    hostId: 'host id',
    sessionUri: 'ahp-session:/a|b',
  });
});

test('ссылка с закодированным разделителем сохраняет адрес сессии и значения с вертикальной чертой', () => {
  assert.deepEqual(selectionFromHash('#local%7Cahp-session%3A%2Fsession'), {
    hostId: 'local',
    sessionUri: 'ahp-session:/session',
  });
  assert.deepEqual(selectionFromHash('#host%7Cdev%7cahp-session%3a%2Fa%7Cb'), {
    hostId: 'host|dev',
    sessionUri: 'ahp-session:/a|b',
  });
  assert.equal(selectionFromHash('#local%7Cahp-session%3A%2F%ZZ'), null);
});

test('пустая, неполная или повреждённая ссылка не выбирает сессию', () => {
  for (const hash of ['', '#', '#host', '#|uri', '#host|', '#host|%E0%A4%A', '#%ZZ|uri']) {
    assert.equal(selectionFromHash(hash), null, hash);
  }
});

test('ссылка восстанавливает вложенный чат вместе с его сессией', () => {
  const expected = { hostId: 'local', sessionUri: 'ahp-session:/session', chatUri: 'ahp-chat:/child' };
  assert.deepEqual(selectionFromHash('#local|ahp-session%3A%2Fsession|ahp-chat%3A%2Fchild'), expected);
  assert.deepEqual(selectionFromHash('#local%7Cahp-session%3A%2Fsession%7Cahp-chat%3A%2Fchild'), expected);
});

test('ход в адресе переживает перезагрузку и не ломает старые ссылки', () => {
  const selection = { hostId: 'local', sessionUri: 'ahp-session:/session', chatUri: 'ahp-chat:/child', turnId: 'turn|1' };
  const hash = selectionToHash(selection);
  assert.equal(hash, '#local|ahp-session%3A%2Fsession|ahp-chat%3A%2Fchild|turn%7C1');
  assert.deepEqual(selectionFromHash(hash), selection);
  assert.deepEqual(selectionFromHash('#local|ahp-session%3A%2Fsession'), { hostId: 'local', sessionUri: 'ahp-session:/session' });
  assert.deepEqual(selectionFromHash('#local|ahp-session%3A%2Fsession|ahp-chat%3A%2Fchild|'), { hostId: 'local', sessionUri: 'ahp-session:/session', chatUri: 'ahp-chat:/child' });
  assert.deepEqual(selectionFromHash('#local|ahp-session%3A%2Fsession||turn'), { hostId: 'local', sessionUri: 'ahp-session:/session' }, 'ход без чата игнорируется');
  assert.equal(selectionFromHash('#local|ahp-session%3A%2Fsession|ahp-chat%3A%2Fchild|%ZZ'), null);
  assert.equal(selectionToHash(null), '');
});

test('построенная ссылка читается обратно, включая разделители и не-ASCII', () => {
  const selections = [
    { hostId: 'local', sessionUri: 'ahp-session:/session' },
    { hostId: 'host|dev', sessionUri: 'ahp-session:/a|b' },
    { hostId: 'хост', sessionUri: 'ahp-session:/сессия', chatUri: 'ahp-chat:/чат|1' },
  ];
  for (const selection of selections) {
    assert.deepEqual(selectionFromHash(selectionToHash(selection)), selection);
  }
  assert.equal(selectionToHash(null), '');
  assert.equal(selectionToHash({ hostId: 'a', sessionUri: 'b' }), '#a|b');
});
