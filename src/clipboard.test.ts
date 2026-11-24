import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserClipboard, copyText } from './clipboard.js';

test('copyText передаёт writer ровно исходный текст', async () => {
  const written: string[] = [];
  const result = await copyText('const a = 1;\n', async text => { written.push(text); });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(written, ['const a = 1;\n']);
});

test('copyText превращает отказ clipboard в сообщение', async () => {
  const result = await copyText('x', async () => { throw new Error('Запись запрещена'); });

  assert.deepEqual(result, { ok: false, message: 'Запись запрещена' });
});

test('copyText без clipboard не бросает', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined });
  try {
    assert.deepEqual(await copyText('x'), { ok: false, message: 'Буфер обмена недоступен' });
    assert.equal(browserClipboard(), undefined);
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test('browserClipboard вызывает writeText с правильным this', async () => {
  const written: string[] = [];
  const clipboard = {
    value: 'clipboard',
    writeText(this: { value: string }, text: string) {
      written.push(`${this.value}:${text}`);
      return Promise.resolve();
    },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard } });
  try {
    assert.deepEqual(await copyText('код'), { ok: true });
    assert.deepEqual(written, ['clipboard:код']);
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});
