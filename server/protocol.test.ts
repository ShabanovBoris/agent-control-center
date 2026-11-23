import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionType, SessionLifecycle, SessionStatus } from '@microsoft/agent-host-protocol';
import { describeCallError, parseClientMessage, parseServerMessage, type ClientMessage, type ServerMessage } from '../shared/protocol.js';

const hostId = 'test';
const uri = 'ahp-session:/test';

test('оба парсера игнорируют битый JSON и значения вне протокола', () => {
  for (const raw of ['{', 'null', '[]', '42', '"x"', '{}', '{"t":"unknown"}']) {
    assert.equal(parseClientMessage(raw), undefined, raw);
    assert.equal(parseServerMessage(raw), undefined, raw);
  }
});

test('парсер клиента проверяет обязательные поля и сохраняет аргументы команд', () => {
  const valid: ClientMessage[] = [
    { t: 'watch', hostId, uri },
    { t: 'unwatch', hostId, uri },
    { t: 'presence', visible: true, selection: { hostId, sessionUri: uri } },
    { t: 'presence', visible: false },
    { t: 'call', id: 1, call: { op: 'fetchTurns', hostId, chatUri: 'ahp-chat:/test', cursor: 'opaque/+=' } },
    { t: 'call', id: 2, call: { op: 'pushConfig' } },
    { t: 'call', id: 3, call: { op: 'pushSubscribe', origin: 'https://mac.ts.net', subscription: { endpoint: 'https://push.example/e', keys: { p256dh: 'a', auth: 'b' } } } },
    { t: 'call', id: 4, call: { op: 'pushUnsubscribe', endpoint: 'https://push.example/e' } },
    { t: 'call', id: 5, call: { op: 'pushTest', origin: 'https://mac.ts.net' } },
    { t: 'call', id: 6, call: { op: 'health' } },
    { t: 'call', id: 7, call: { op: 'readLog', hostId: 'local' } },
    { t: 'cancelDirectoryPicker' },
  ];
  for (const message of valid) assert.deepEqual(parseClientMessage(JSON.stringify(message)), message);

  for (const message of [
    { t: 'watch', hostId },
    { t: 'unwatch', hostId: 42, uri },
    { t: 'call', call: { op: 'reconnectHost', hostId } },
    { t: 'call', id: 1, call: null },
    { t: 'presence', visible: 'yes' },
    { t: 'presence' },
    { t: 'presence', visible: true, selection: { hostId } },
    { t: 'presence', visible: true, selection: { hostId: 42, sessionUri: uri } },
    { t: 'presence', visible: true, selection: 'x' },
  ]) {
    const raw = JSON.stringify(message);
    assert.equal(parseClientMessage(raw), undefined, raw);
  }
});

test('парсер сервера проверяет обязательные поля и сохраняет данные сообщений', () => {
  const valid: ServerMessage[] = [
    { t: 'overview', overview: { hosts: [], sessions: [] } },
    { t: 'snapshot', hostId, uri, state: { provider: 'mock', title: 'Сессия', status: SessionStatus.Idle, lifecycle: SessionLifecycle.Ready, activeClients: [], chats: [] } },
    { t: 'action', hostId, uri, action: { type: ActionType.SessionTitleChanged, title: 'Новое название' } },
    { t: 'rejected', hostId, uri, actionType: ActionType.SessionTitleChanged, reason: 'Отклонено' },
    { t: 'channelError', hostId, uri, error: 'Не найдено', code: -32001 },
    { t: 'sessionRemoved', hostId, sessionUri: uri, chatUris: ['ahp-chat:/test'] },
    { t: 'result', id: 1, ok: true, data: null },
    { t: 'result', id: 2, ok: false, error: { message: 'Нужна авторизация', code: -32007 } },
  ];
  for (const message of valid) assert.deepEqual(parseServerMessage(JSON.stringify(message)), message);

  for (const message of [
    { t: 'overview', overview: { hosts: [], sessions: null } },
    { t: 'snapshot', hostId, uri, state: null },
    { t: 'action', hostId, uri, action: {} },
    { t: 'sessionRemoved', hostId, sessionUri: uri, chatUris: [null] },
    { t: 'result', id: 1, ok: false },
    { t: 'result', id: 2, ok: 'true' },
  ]) {
    const raw = JSON.stringify(message);
    assert.equal(parseServerMessage(raw), undefined, raw);
  }
});

test('поиск по истории проходит парсер вызова, а отмена проверяет id', () => {
  const call = { t: 'call', id: 7, call: { op: 'searchHistory', query: 'deploy', limit: 10 } } as const;
  assert.deepEqual(parseClientMessage(JSON.stringify(call)), call);
  assert.deepEqual(parseClientMessage('{"t":"cancelSearch","id":7}'), { t: 'cancelSearch', id: 7 });
  for (const raw of ['{"t":"cancelSearch"}', '{"t":"cancelSearch","id":"7"}', '{"t":"cancelSearch","id":null}']) {
    assert.equal(parseClientMessage(raw), undefined, raw);
  }
});

test('describeCallError сохраняет авторизационное указание и код обычной ошибки', () => {
  assert.match(describeCallError({ message: 'Authentication required', code: -32007 }), /скачайте его SDK/);
  assert.equal(describeCallError({ message: 'Хост недоступен', code: -32001 }), 'Хост недоступен');
  assert.equal(describeCallError({ message: 'Без кода' }), 'Без кода');
});
