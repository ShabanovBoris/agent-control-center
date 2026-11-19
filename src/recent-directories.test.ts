import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recentDirectories, rememberDirectory } from './recent-directories.js';

function memory() {
  let value: string | null = null;
  return { getItem: (_key: string) => value, setItem: (_key: string, next: string) => { value = next; } };
}

test('недавние папки сохраняют порядок использования и изолированы по хостам', () => {
  const storage = memory();
  assert.deepEqual(recentDirectories(storage, 'local'), []);
  rememberDirectory(storage, 'local', '/first/');
  rememberDirectory(storage, 'local', '/second');
  rememberDirectory(storage, 'remote', '/srv/project');
  rememberDirectory(storage, 'local', '/first');
  assert.deepEqual(recentDirectories(storage, 'local'), ['/first', '/second']);
  assert.deepEqual(recentDirectories(storage, 'remote'), ['/srv/project']);
});

test('история ограничена восемью папками и сохраняет пробелы, Unicode и корневую папку', () => {
  const storage = memory();
  for (let i = 0; i < 10; i++) rememberDirectory(storage, 'local', `/project-${i}`);
  assert.equal(recentDirectories(storage, 'local').length, 8);
  assert.equal(recentDirectories(storage, 'local').at(-1), '/project-2');
  const path = '/Проект с пробелами и "кавычками"/';
  rememberDirectory(storage, 'local', path);
  rememberDirectory(storage, 'local', '/');
  assert.deepEqual(recentDirectories(storage, 'local').slice(0, 2), ['/', path]);
});

test('новая запись восстанавливает повреждённую историю', () => {
  for (const saved of ['[broken', '{"local":true}']) {
    const storage = memory();
    storage.setItem('acc.recentDirectories.v1', saved);
    assert.deepEqual(recentDirectories(storage, 'local'), []);
    rememberDirectory(storage, 'local', '/tmp');
    assert.deepEqual(recentDirectories(storage, 'local'), ['/tmp']);
  }
});

test('ошибки доступа к хранилищу остаются видимыми', () => {
  const failure = new Error('Storage disabled');
  assert.throws(() => recentDirectories({ getItem() { throw failure; }, setItem() {} }, 'local'), error => error === failure);
  assert.throws(() => rememberDirectory({ getItem: () => null, setItem() { throw failure; } }, 'local', '/tmp'), error => error === failure);
});
