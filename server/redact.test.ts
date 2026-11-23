import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REDACTED, redactSecrets } from './redact.js';

const token = '0123456789abcdef'.repeat(4);

test('токен подключения в журнале не попадает в браузер', () => {
  const line = `[acc] ${new Date(0).toISOString()} подключение ws://localhost:8089?tkn=${token}`;
  const redacted = redactSecrets(line);
  assert.ok(redacted.includes(`?tkn=${REDACTED}`), redacted);
  assert.ok(!redacted.includes(token));
  assert.ok(redacted.startsWith('[acc] '));
});

test('query-параметры, Bearer и переменные окружения редактируются', () => {
  assert.equal(redactSecrets('/ws?token=abc&x=1'), `/ws?token=${REDACTED}&x=1`);
  assert.equal(redactSecrets('/ws?api_key=abc#frag'), `/ws?api_key=${REDACTED}#frag`);
  assert.equal(redactSecrets('Authorization: Bearer abc.def-123'), `Authorization: Bearer ${REDACTED}`);
  assert.equal(redactSecrets('API_KEY=secret'), `API_KEY=${REDACTED}`);
  assert.equal(redactSecrets("AHP_SOME_TOKEN='secret'"), `AHP_SOME_TOKEN=${REDACTED}`);
  assert.equal(redactSecrets(`commit ${token}`), `commit ${REDACTED}`);
});

test('редакция идемпотентна и не трогает обычный текст', () => {
  const source = `ws://127.0.0.1:8090?tkn=${token} PASSWORD="hunter2"`;
  const once = redactSecrets(source);
  assert.equal(redactSecrets(once), once);
  for (const text of ['HTTP 401 Unauthorized', 'tokens: 1200', 'token usage', 'ключ не найден']) {
    assert.equal(redactSecrets(text), text);
  }
});
