import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DirectoryPicker } from './directory-picker.js';

test('Finder доступен только на macOS и для явно локальной файловой системы', async () => {
  let calls = 0;
  const native = async () => { calls++; return '/Users/me/project/'; };
  const picker = new DirectoryPicker(['local', 'gemini'], native, 'darwin');
  assert.equal(picker.availableFor('local'), true);
  assert.equal(picker.availableFor('gemini'), true);
  assert.equal(picker.availableFor('remote'), false);
  await assert.rejects(picker.choose('remote'), /вручную/);
  const linux = new DirectoryPicker(['local'], native, 'linux');
  assert.equal(linux.availableFor('local'), false);
  await assert.rejects(linux.choose('local'), /вручную/);
  assert.equal(calls, 0);
});

test('отмена возвращает null, путь с пробелами и Unicode сохраняется без преобразований', async () => {
  const path = '/Users/me/Проект с пробелами/';
  const signal = new AbortController().signal;
  const picker = new DirectoryPicker(['local'], async (initial, receivedSignal) => {
    assert.equal(initial, path);
    assert.equal(receivedSignal, signal);
    return null;
  }, 'darwin');
  assert.equal(await picker.choose('local', path, signal), null);
  const selected = new DirectoryPicker(['local'], async () => path, 'darwin');
  assert.equal(await selected.choose('local'), path);
});

test('два клиента не открывают одновременно несколько нативных диалогов', async () => {
  let finish!: (path: string | null) => void;
  const picker = new DirectoryPicker(['local'], () => new Promise(resolve => { finish = resolve; }), 'darwin');
  const first = picker.choose('local');
  await assert.rejects(picker.choose('local'), /уже открыт/);
  finish(null);
  assert.equal(await first, null);
  const next = picker.choose('local');
  finish('/tmp/');
  assert.equal(await next, '/tmp/');
});

test('ошибка не выдаётся за отмену; после ошибки диалог можно открыть снова', async () => {
  const error = new Error('OS dialog failed');
  let calls = 0;
  const picker = new DirectoryPicker(['local'], async () => { if (calls++ === 0) throw error; return '/tmp/'; }, 'darwin');
  await assert.rejects(picker.choose('local'), failure => failure === error);
  assert.equal(await picker.choose('local'), '/tmp/');
});

test('отключение клиента прерывает ожидающий диалог и освобождает его', async () => {
  const controller = new AbortController();
  const picker = new DirectoryPicker(['local'], async (_path, signal) => new Promise((resolve, reject) => {
    signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
  }), 'darwin');
  const pending = picker.choose('local', undefined, controller.signal);
  controller.abort();
  await assert.rejects(pending, failure => failure === controller.signal.reason);
  await assert.rejects(picker.choose('local', undefined, controller.signal), failure => failure === controller.signal.reason);
});
