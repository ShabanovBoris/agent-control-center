import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  childDirectoryPath, normalizeDirectoryPath, parentDirectoryPath, parseDirectoryEntries, sortDirectoryEntries,
} from '../shared/directory';
import { directorySourceHint, initialTreePath } from './directory-tree';

test('сортировка: каталоги раньше файлов, регистронезависимо и numeric', () => {
  const entries = [
    { name: 'item10', type: 'file' as const },
    { name: 'item2', type: 'file' as const },
    { name: 'Beta', type: 'directory' as const },
    { name: 'alpha', type: 'directory' as const },
    { name: 'Alpha', type: 'directory' as const },
    { name: 'a.md', type: 'file' as const },
  ];
  assert.deepEqual(sortDirectoryEntries(entries).map(entry => entry.name), ['Alpha', 'alpha', 'Beta', 'a.md', 'item2', 'item10']);
  // Немутирующая: исходный порядок не меняется.
  assert.equal(entries[0]?.name, 'item10');
});

test('сортировка: равные имена в одной категории упорядочены детерминированно', () => {
  const first = { name: 'Name', type: 'directory' as const };
  const second = { name: 'name', type: 'directory' as const };
  assert.deepEqual(sortDirectoryEntries([second, first]).map(entry => entry.name), sortDirectoryEntries([first, second]).map(entry => entry.name));
});

test('нормализация пути: абсолютный POSIX-путь без хвоста, //, . и ..', () => {
  assert.equal(normalizeDirectoryPath('/'), '/');
  assert.equal(normalizeDirectoryPath('///'), '/');
  assert.equal(normalizeDirectoryPath(' /a/ '), '/a');
  assert.equal(normalizeDirectoryPath('/a//b'), '/a/b');
  assert.equal(normalizeDirectoryPath('/a/./b/'), '/a/b');
  assert.equal(normalizeDirectoryPath('/a/../b'), '/b');
  assert.equal(normalizeDirectoryPath('/..'), '/');
  assert.equal(normalizeDirectoryPath('relative/path'), undefined);
  assert.equal(normalizeDirectoryPath(''), undefined);
  assert.equal(normalizeDirectoryPath('/a\0b'), undefined);
});

test('навигация по дереву: родитель и ребёнок', () => {
  assert.equal(parentDirectoryPath('/a/b/'), '/a');
  assert.equal(parentDirectoryPath('/a'), '/');
  assert.equal(parentDirectoryPath('/'), undefined);
  assert.equal(parentDirectoryPath('relative'), undefined);
  assert.equal(childDirectoryPath('/a', 'b'), '/a/b');
  assert.equal(childDirectoryPath('/a/', 'b'), '/a/b');
  assert.equal(childDirectoryPath('/', 'b'), '/b');
  assert.equal(childDirectoryPath('/a', '..'), undefined);
  assert.equal(childDirectoryPath('/a', 'b/c'), undefined);
  assert.equal(childDirectoryPath('/a', ''), undefined);
  assert.equal(childDirectoryPath('relative', 'b'), undefined);
});

test('стартовый путь дерева берётся из поля: путь, file: URI или корень', () => {
  assert.equal(initialTreePath('/Users/me/project'), '/Users/me/project');
  assert.equal(initialTreePath('file:///Users/me/project'), '/Users/me/project');
  assert.equal(initialTreePath('file:///Users/me/%D0%BF%D1%80%D0%BE%D0%B5%D0%BA%D1%82'), '/Users/me/проект');
  assert.equal(initialTreePath(''), '/');
  assert.equal(initialTreePath('relative'), '/');
});

test('разбор ответа хоста: только валидные записи, дубли отбрасываются', () => {
  assert.equal(parseDirectoryEntries('nope'), undefined);
  assert.equal(parseDirectoryEntries(null), undefined);
  assert.deepEqual(parseDirectoryEntries([]), []);
  assert.deepEqual(parseDirectoryEntries([
    { name: 'src', type: 'directory' },
    { name: 'src', type: 'file' },
    { name: 'README.md', type: 'file' },
    { name: '..', type: 'directory' },
    { name: 'a/b', type: 'file' },
    { name: 'bad', type: 'socket' },
    { name: 42, type: 'file' },
    null,
  ]), [
    { name: 'src', type: 'directory' },
    { name: 'README.md', type: 'file' },
  ]);
});

test('подпись источника различает хост и backend-листинг', () => {
  assert.match(directorySourceHint('host'), /с хоста/);
  assert.match(directorySourceHint('backend'), /локальный листинг/);
});
