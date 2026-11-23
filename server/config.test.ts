import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';

const repositoryConfig = (file: string) => fileURLToPath(new URL(`../${file}`, import.meta.url));

test('loadConfig restricts the backend listener to loopback without restricting host URLs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'acc-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'hosts.json');
  const remoteHostUrl = 'ws://192.168.1.42:8089';

  for (const [configuredHost, expectedHost] of [
    ['127.0.0.1', '127.0.0.1'],
    ['::1', '::1'],
    ['localhost', '127.0.0.1'],
  ]) {
    await writeFile(path, JSON.stringify({
      listen: { host: configuredHost, port: 8090 },
      hosts: [{ id: 'remote', label: 'Remote AHP', url: remoteHostUrl }],
    }));

    const config = await loadConfig(path);
    assert.equal(config.listen.host, expectedHost);
    assert.equal(config.hosts[0]?.url, remoteHostUrl);
  }
});

test('loadConfig rejects non-loopback listener hosts with a field-specific error', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'acc-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'hosts.json');

  for (const host of ['0.0.0.0', '::', '192.168.1.42', 'backend.example.com', '']) {
    await writeFile(path, JSON.stringify({
      listen: { host, port: 8090 },
      hosts: [{ id: 'remote', label: 'Remote AHP', url: 'ws://192.168.1.42:8089' }],
    }));

    await assert.rejects(loadConfig(path), error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`${path}: listen.host`));
      assert.match(error.message, /127\.0\.0\.1, ::1 или localhost/);
      return true;
    }, `host ${JSON.stringify(host)} must be rejected`);
  }
});

test('dev and e2e configs describe the mock host only, without tokens', async () => {
  for (const file of ['hosts.dev.json', 'hosts.e2e.json']) {
    const config = await loadConfig(repositoryConfig(file));
    assert.deepEqual(config.listen, { host: '127.0.0.1', port: 8095 }, file);
    assert.deepEqual(config.agents, ['mock'], file);
    assert.equal(config.hosts.length, 1, file);
    const [host] = config.hosts;
    assert.equal(host?.id, 'mock', file);
    assert.equal(host?.url, 'ws://127.0.0.1:8189', file);
    assert.equal(host?.tokenFile, undefined, file);
    assert.equal(host?.localFilesystem, undefined, file);
  }
});

test('loadConfig applies port and host URL overrides without mutating the file', async () => {
  const path = repositoryConfig('hosts.dev.json');
  const config = await loadConfig(path, { port: 8096, hostUrls: { mock: 'ws://127.0.0.1:8191' } });
  assert.equal(config.listen.port, 8096);
  assert.equal(config.hosts[0]?.url, 'ws://127.0.0.1:8191');
  assert.equal(config.hosts[0]?.tokenFile, undefined);

  const again = await loadConfig(path);
  assert.equal(again.listen.port, 8095);
  assert.equal(again.hosts[0]?.url, 'ws://127.0.0.1:8189');
});

test('loadConfig rejects invalid port overrides and unknown host ids', async () => {
  const path = repositoryConfig('hosts.dev.json');

  for (const port of [0, 70_000, 80.5]) {
    await assert.rejects(loadConfig(path, { port }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /listen\.port/);
      return true;
    }, `port ${port} must be rejected`);
  }

  await assert.rejects(loadConfig(path, { hostUrls: { local: 'ws://127.0.0.1:8089' } }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /неизвестного хоста "local"/);
    return true;
  });
});
