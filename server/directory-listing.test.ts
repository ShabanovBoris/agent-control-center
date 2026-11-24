import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CallFailure } from './errors.js';
import { LocalDirectoryLister } from './directory-listing.js';
import { sortDirectoryEntries } from '../shared/directory.js';

const entry = (name: string, directory: boolean) => ({ name, isDirectory: () => directory });

test('листинг доступен только хостам из allowlist', async () => {
  let reads = 0;
  const lister = new LocalDirectoryLister(['local'], async () => { reads += 1; return []; });
  assert.equal(lister.availableFor('local'), true);
  assert.equal(lister.availableFor('remote'), false);
  await assert.rejects(lister.list('remote', '/tmp'), /только для локальных хостов/);
  assert.equal(reads, 0);
});

test('листинг отдаёт имена и типы прямых детей, не заходя в подкаталоги', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acc-listing-'));
  try {
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'deep.md'), 'x');
    await writeFile(join(root, 'README.md'), 'x');
    const entries = await new LocalDirectoryLister(['local']).list('local', root);
    assert.deepEqual(sortDirectoryEntries(entries), [
      { name: 'nested', type: 'directory' },
      { name: 'README.md', type: 'file' },
    ]);
    // Хвостовой слэш нормализуется до того же каталога.
    assert.deepEqual((await new LocalDirectoryLister(['local']).list('local', `${root}/`)).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ошибки файловой системы переводятся в понятный текст без кода хоста', async () => {
  const makeError = (code: string) => Object.assign(new Error(code), { code });
  const cases: [string, RegExp][] = [
    ['ENOENT', /Папка не найдена/],
    ['EACCES', /Нет прав на чтение папки/],
    ['EPERM', /Нет прав на чтение папки/],
    ['ENOTDIR', /Это не папка/],
    ['EIO', /Не удалось прочитать папку: EIO/],
  ];
  for (const [code, expected] of cases) {
    const lister = new LocalDirectoryLister(['local'], async () => { throw makeError(code); });
    await assert.rejects(lister.list('local', '/broken'), (error: unknown) => {
      assert.ok(error instanceof CallFailure);
      assert.match(error.message, expected);
      assert.equal(error.code, undefined);
      return true;
    });
  }
});

test('невалидный путь отклоняется без чтения диска', async () => {
  let reads = 0;
  const lister = new LocalDirectoryLister(['local'], async () => { reads += 1; return []; });
  await assert.rejects(lister.list('local', 'relative/path'), /абсолютный путь/);
  await assert.rejects(lister.list('local', ''), /абсолютный путь/);
  assert.equal(reads, 0);
});

test('имена с разделителями и NUL не попадают в результат, симлинки показываются файлами', async () => {
  const lister = new LocalDirectoryLister(['local'], async () => [
    entry('ok', false),
    entry('..', true),
    entry('a/b', false),
    entry('bad\0name', true),
    entry('link', false),
  ]);
  assert.deepEqual(await lister.list('local', '/tmp/x'), [
    { name: 'ok', type: 'file' },
    { name: 'link', type: 'file' },
  ]);
});
