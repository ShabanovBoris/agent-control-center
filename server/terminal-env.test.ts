import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { terminalEnv } from './terminal-env.js';

/** Грязное окружение задано литералами: при удалении переменной из реализации тест обязан упасть. */
const dirtyEnv = {
  NO_COLOR: '1',
  CLICOLOR: '0',
  CLICOLOR_FORCE: '0',
  FORCE_COLOR: '0',
  CI: '1',
  TERM: 'dumb',
  COLORTERM: '',
  PATH: '/bin',
  KEEP: 'yes',
};

function parseNulEnv(output: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  for (const entry of output.toString('utf8').split('\0')) {
    if (!entry) continue;
    const separator = entry.indexOf('=');
    assert.notEqual(separator, -1, `строка env без «=»: ${entry}`);
    entries.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return entries;
}

test('terminalEnv чистит цветовраждебные переменные и выставляет терминал панели', () => {
  const env = Object.freeze({ ...dirtyEnv });
  const result = terminalEnv(env, { CODEX_HOME: '/tmp/codex', PROVIDER_KEY: 'secret' });

  for (const name of ['NO_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE', 'FORCE_COLOR', 'CI']) {
    assert.equal(result[name], undefined, `${name} должен быть удалён`);
  }
  assert.equal(result.TERM, 'xterm-256color');
  assert.equal(result.COLORTERM, 'truecolor');
  assert.equal(result.PATH, '/bin');
  assert.equal(result.KEEP, 'yes');
  assert.equal(result.CODEX_HOME, '/tmp/codex');
  assert.equal(result.PROVIDER_KEY, 'secret');
  // TERM/COLORTERM ставятся последними: overrides их не перебивают.
  assert.equal(terminalEnv(dirtyEnv, { TERM: 'dumb', COLORTERM: '' }).TERM, 'xterm-256color');
  assert.equal(terminalEnv(dirtyEnv, { TERM: 'dumb', COLORTERM: '' }).COLORTERM, 'truecolor');
  // Входной объект не мутируется: его же использует wrapper провайдера.
  assert.equal(env.NO_COLOR, '1');
  assert.equal(env.TERM, 'dumb');
});

test('start-host.sh отдаёт хосту чистый env с терминалом панели', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ahp-terminal-env-'));
  try {
    await mkdir(join(root, 'scripts'));
    // Скрипт сам делает `cd` в корень копии, поэтому репозиторий не затрагивается.
    await copyFile(fileURLToPath(new URL('../scripts/start-host.sh', import.meta.url)), join(root, 'scripts/start-host.sh'));
    // Подмена CLI: `code agent host` не нужен, печатаем env, который получил бы хост.
    const stub = join(root, 'code');
    await writeFile(stub, '#!/bin/sh\nexec /usr/bin/env -0\n');
    await chmod(stub, 0o755);

    const child = spawnSync('/bin/bash', [join(root, 'scripts/start-host.sh')], {
      env: {
        ...process.env,
        ...dirtyEnv,
        // Скрипту нужны dirname/openssl: PATH берём реальный, цветовраждебные ключи — из dirtyEnv.
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        VSCODE_CLI: stub,
        AHP_USE_BUNDLED_SDK: '1',
      },
      encoding: 'buffer',
      timeout: 20_000,
    });
    assert.equal(child.status, 0, `start-host.sh упал: ${child.stderr.toString('utf8')}`);
    const env = parseNulEnv(child.stdout);

    assert.equal(env.get('TERM'), 'xterm-256color');
    assert.equal(env.get('COLORTERM'), 'truecolor');
    for (const name of ['NO_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE', 'FORCE_COLOR', 'CI']) {
      assert.equal(env.get(name), undefined, `${name} доезжает до хоста`);
    }
    assert.equal(env.get('KEEP'), 'yes');
    assert.equal(env.get('VSCODE_AGENT_HOST_CODEX_AGENT_ENABLED'), 'true');
    assert.equal(env.get('VSCODE_AGENT_HOST_CLAUDE_AGENT_ENABLED'), 'false');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
