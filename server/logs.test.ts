import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { LocalHost } from './local-hosts.js';
import { MAX_LOG_BYTES, MAX_LOG_LINE_CHARS, MAX_LOG_LINES, localLogSources, readLogTail, type LogSource } from './logs.js';

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'acc-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function source(path: string, hostId = 'local'): LogSource {
  return { hostId, fileName: '.local/host.log', path, startCommand: 'npm run host -- --log' };
}

test('журналы доступны только фиксированным локальным хостам проекта', () => {
  const hosts = [{ id: 'local', label: 'Основной' }, { id: 'wbllm', label: 'WBLLM' }, { id: 'glm', label: 'GLM' }] as LocalHost[];
  const sources = localLogSources(hosts);
  assert.deepEqual(sources.map(item => [item.hostId, item.fileName, item.startCommand]), [
    ['local', '.local/host.log', 'npm run host -- --log'],
    ['wbllm', '.local/wbllm-host.log', 'npm run host:wbllm -- --log'],
    ['glm', '.local/glm-host.log', 'npm run host:glm -- --log'],
  ]);
  for (const item of sources) assert.ok(isAbsolute(item.path), item.path);
  assert.deepEqual(localLogSources([]), []);
});

test('отсутствующий журнал объясняется командой запуска без абсолютного пути', async t => {
  const dir = await tempDir(t);
  const result = await readLogTail(source(join(dir, 'нет.log')));
  assert.equal(result.status, 'missing');
  assert.ok(result.status === 'missing' && result.message.includes('npm run host -- --log'));
  assert.ok(result.status === 'missing' && !result.message.includes(dir));
  assert.equal(result.fileName, '.local/host.log');
});

test('хвост маленького файла сохраняет порядок строк и время изменения', async t => {
  const dir = await tempDir(t);
  const path = join(dir, 'host.log');
  await writeFile(path, 'первая\nвторая\n');
  const result = await readLogTail(source(path));
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.deepEqual(result.lines, ['первая', 'вторая']);
  assert.equal(result.truncated, false);
  assert.ok(result.updatedAt && !Number.isNaN(Date.parse(result.updatedAt)));
  assert.equal(result.hostId, 'local');
});

test('пустой журнал — валидный пустой хвост', async t => {
  const dir = await tempDir(t);
  const path = join(dir, 'empty.log');
  await writeFile(path, '');
  const result = await readLogTail(source(path));
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') assert.deepEqual([result.lines, result.truncated], [[], false]);
});

test('в хвост попадают только последние строки файла', async t => {
  const dir = await tempDir(t);
  const path = join(dir, 'long.log');
  const lines = Array.from({ length: MAX_LOG_LINES + 25 }, (_, index) => `строка ${index}`);
  await writeFile(path, `${lines.join('\n')}\n`);
  const result = await readLogTail(source(path));
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.equal(result.lines.length, MAX_LOG_LINES);
  assert.equal(result.lines[0], lines[25]);
  assert.equal(result.lines.at(-1), lines.at(-1));
  assert.equal(result.truncated, true);
});

test('файл больше лимита читается окном с целой первой строкой', async t => {
  const dir = await tempDir(t);
  const path = join(dir, 'big.log');
  const lines = Array.from({ length: 1200 }, (_, index) => `line ${index} ${'a'.repeat(60)}`);
  const content = `${lines.join('\n')}\n`;
  assert.ok(Buffer.byteLength(content) > MAX_LOG_BYTES);
  await writeFile(path, content);
  const result = await readLogTail(source(path));
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.equal(result.lines.length, MAX_LOG_LINES);
  for (const line of result.lines) assert.match(line, /^line \d+ a+$/);
  assert.equal(result.truncated, true);
});

test('длинная строка обрезается до лимита символов', async t => {
  const dir = await tempDir(t);
  const path = join(dir, 'wide.log');
  await writeFile(path, `${'x'.repeat(MAX_LOG_LINE_CHARS + 100)}\nкороткая\n`);
  const result = await readLogTail(source(path));
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.equal(result.lines[0]?.length, MAX_LOG_LINE_CHARS);
  assert.equal(result.lines[1], 'короткая');
  assert.equal(result.truncated, true);
});

test('граница окна не оставляет битый UTF-8 в начале строки', async t => {
  const dir = await tempDir(t);
  const path = join(dir, 'utf8.log');
  // Окно начинается ровно на втором байте «ж»: декодер даёт ведущий U+FFFD.
  await writeFile(path, `${'a'.repeat(MAX_LOG_BYTES - 1)}ж${'c'.repeat(MAX_LOG_BYTES - 1)}`);
  const result = await readLogTail(source(path));
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.equal(result.lines.length, 1);
  assert.ok(!result.lines[0]?.startsWith('\uFFFD'), result.lines[0]?.slice(0, 10) ?? '');
  assert.equal(result.truncated, true);
});

test('токены из журнала редактируются', async t => {
  const dir = await tempDir(t);
  const path = join(dir, 'token.log');
  const token = 'abcd1234'.repeat(8);
  await writeFile(path, `подключение ws://localhost:8089?tkn=${token}\n`);
  const result = await readLogTail(source(path));
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.ok(result.lines[0]?.includes('<redacted>'));
  assert.ok(!result.lines[0]?.includes(token));
});

test('символическая ссылка и каталог отклоняются без содержимого', async t => {
  const dir = await tempDir(t);
  const real = join(dir, 'real.log');
  await writeFile(real, 'секретная строка\n');
  const link = join(dir, 'link.log');
  await symlink(real, link);
  const linked = await readLogTail(source(link));
  assert.equal(linked.status, 'unavailable');
  assert.ok(linked.status === 'unavailable' && linked.message.includes('символической'));
  assert.ok(!JSON.stringify(linked).includes('секретная строка'));

  const directory = join(dir, 'folder.log');
  await mkdir(directory);
  const folders = await readLogTail(source(directory));
  assert.equal(folders.status, 'unavailable');
  assert.ok(!JSON.stringify(folders).includes('секретная строка'));
});
