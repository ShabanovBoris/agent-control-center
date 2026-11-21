import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from './config.js';

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
