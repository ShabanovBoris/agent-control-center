import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionType, SessionLifecycle, SessionStatus } from '@microsoft/agent-host-protocol';
import { parseClientMessage, parseServerMessage, type ClientMessage, type ServerMessage } from '../shared/protocol.js';

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
    { t: 'call', id: 1, call: { op: 'fetchTurns', hostId, chatUri: 'ahp-chat:/test', cursor: 'opaque/+=' } },
    { t: 'cancelDirectoryPicker' },
  ];
  for (const message of valid) assert.deepEqual(parseClientMessage(JSON.stringify(message)), message);

  for (const message of [
    { t: 'watch', hostId },
    { t: 'unwatch', hostId: 42, uri },
    { t: 'call', call: { op: 'reconnectHost', hostId } },
    { t: 'call', id: 1, call: null },
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
