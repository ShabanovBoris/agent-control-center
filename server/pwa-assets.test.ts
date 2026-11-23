import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const publicDir = new URL('../public/', import.meta.url);
const publicFile = (name: string) => fileURLToPath(new URL(name, publicDir));

test('manifest описывает устанавливаемую PWA с иконками 192 и 512', () => {
  const manifest = JSON.parse(readFileSync(publicFile('manifest.webmanifest'), 'utf8')) as {
    name?: unknown; start_url?: unknown; display?: unknown; icons?: { src?: string; sizes?: string; type?: string }[];
  };
  assert.equal(typeof manifest.name, 'string');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.deepEqual(manifest.icons?.map(icon => [icon.src, icon.sizes, icon.type]), [
    ['/icons/icon-192.png', '192x192', 'image/png'],
    ['/icons/icon-512.png', '512x512', 'image/png'],
  ]);
});

test('иконки существуют, это PNG нужного размера', () => {
  for (const [name, size] of [['icons/icon-192.png', 192], ['icons/icon-512.png', 512], ['icons/apple-touch-icon.png', 180]] as const) {
    const content = readFileSync(publicFile(name));
    assert.deepEqual([...content.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${name}: сигнатура PNG`);
    assert.equal(content.readUInt32BE(16), size, `${name}: ширина`);
    assert.equal(content.readUInt32BE(20), size, `${name}: высота`);
  }
});

test('service worker синтаксически корректен и обрабатывает push и клик', () => {
  const sw = publicFile('sw.js');
  execFileSync(process.execPath, ['--check', sw]);
  const source = readFileSync(sw, 'utf8');
  for (const marker of ["addEventListener('push'", "addEventListener('notificationclick'", 'showNotification', 'openWindow']) {
    assert.ok(source.includes(marker), marker);
  }
});

test('index.html подключает manifest, иконки и мобильные meta', () => {
  const html = readFileSync(publicFile('../index.html'), 'utf8');
  for (const marker of [
    'rel="manifest" href="/manifest.webmanifest"',
    'rel="apple-touch-icon"',
    'name="theme-color"',
    'name="apple-mobile-web-app-capable"',
  ]) {
    assert.ok(html.includes(marker), marker);
  }
});
