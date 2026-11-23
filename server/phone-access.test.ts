import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { get, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPhoneAccess } from './phone-access.js';

test('порт для телефона включается только при наличии настроек Tailscale', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'acc-phone-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'phone-access.json');
  assert.equal(await createPhoneAccess(configPath, dir), undefined);
  await writeFile(configPath, JSON.stringify({ origin: 'http://mac.personal.ts.net', login: 'owner@example.com' }));
  await assert.rejects(createPhoneAccess(configPath, dir), /HTTPS/);
});

test('страница, ресурсы и WebSocket требуют учётную запись и адрес Tailscale', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'acc-phone-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'phone-access.json');
  const origin = 'https://mac.personal.ts.net';
  const login = 'owner@example.com';
  await mkdir(join(dir, 'assets'));
  await mkdir(join(dir, 'icons'));
  await writeFile(configPath, JSON.stringify({ origin, login }));
  await writeFile(join(dir, 'index.html'), 'Test page');
  await writeFile(join(dir, 'assets', 'app.js'), 'export {};');
  await writeFile(join(dir, 'sw.js'), 'self.addEventListener("install", () => {});');
  await writeFile(join(dir, 'manifest.webmanifest'), '{"name":"Test"}');
  for (const icon of ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) {
    await writeFile(join(dir, 'icons', icon), `not really ${icon}`);
  }
  const phone = await createPhoneAccess(configPath, dir);
  assert.ok(phone);

  const endpoint: IncomingHttpHeaders = {
    host: new URL(origin).host,
    'x-forwarded-proto': 'https',
  };
  const trusted = { ...endpoint, 'tailscale-user-login': login };
  const invalid = [
    endpoint,
    { ...trusted, 'tailscale-user-login': 'someone-else@example.com' },
    { ...trusted, 'x-forwarded-proto': 'http' },
    { ...trusted, host: 'localhost:8092' },
  ];
  const { server } = phone;
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const { port } = address;
  function read(path: string, headers: IncomingHttpHeaders) {
    return new Promise<{ status?: number; body: string; type?: string }>((resolve, reject) => {
      get({ hostname: '127.0.0.1', port, path, headers }, response => {
        response.setEncoding('utf8');
        let body = '';
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body, type: response.headers['content-type'] }));
        response.on('error', reject);
      }).on('error', reject);
    });
  }
  for (const headers of invalid) {
    assert.equal((await read('/', headers)).status, 403);
    assert.equal((await read('/sw.js', headers)).status, 403, 'service worker закрыт так же, как страница');
    assert.equal(phone.isTrustedUpgrade({ headers: { ...headers, origin } }), false);
  }
  assert.deepEqual(await read('/', trusted), { status: 200, body: 'Test page', type: 'text/html; charset=utf-8' });
  assert.deepEqual(await read('/assets/app.js', trusted), {
    status: 200, body: 'export {};', type: 'text/javascript; charset=utf-8',
  });
  assert.deepEqual(await read('/sw.js', trusted), {
    status: 200, body: 'self.addEventListener("install", () => {});', type: 'text/javascript; charset=utf-8',
  });
  assert.deepEqual(await read('/manifest.webmanifest', trusted), {
    status: 200, body: '{"name":"Test"}', type: 'application/manifest+json; charset=utf-8',
  });
  for (const icon of ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) {
    assert.deepEqual(await read(`/icons/${icon}`, trusted), {
      status: 200, body: `not really ${icon}`, type: 'image/png',
    }, icon);
  }
  assert.equal((await read('/phone-access.json', trusted)).status, 404);
  assert.equal((await read('/package.json', trusted)).status, 404);
  assert.equal((await read('/assets/../phone-access.json', trusted)).status, 404);
  assert.equal((await read('/icons/../package.json', trusted)).status, 404);
  assert.equal(phone.isTrustedUpgrade({ headers: trusted }), false);
  assert.equal(phone.isTrustedUpgrade({ headers: { ...trusted, origin: 'https://another.example.com' } }), false);
  assert.equal(phone.isTrustedUpgrade({ headers: { ...trusted, origin } }), true);
});
