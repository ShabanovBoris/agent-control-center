import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatInteractivity, SessionStatus, type SessionChatSummary, type SessionSummary } from '@microsoft/agent-host-protocol';
import type { Overview } from '../shared/protocol.js';
import { PushTransitions } from './push-transitions.js';

const SESSION = 'ahp-session:/s';
const CHAT = 'ahp-chat:/c';
const SECOND = 'ahp-chat:/second';
const HIDDEN = 'ahp-chat:/hidden';

interface ChatSpec {
  uri: string;
  title?: string;
  status?: SessionStatus;
  interactivity?: ChatInteractivity;
}

interface Spec {
  sessionUri?: string;
  status?: SessionStatus;
  title?: string;
  modifiedAt?: string;
  hostLabel?: string;
  chats?: ChatSpec[];
  defaultChat?: string;
}

function overview(...specs: Spec[]): Overview {
  return {
    hosts: [],
    sessions: specs.map(spec => ({
      hostId: 'local',
      hostLabel: spec.hostLabel ?? 'Mac',
      summary: {
        provider: 'codex',
        resource: spec.sessionUri ?? SESSION,
        title: spec.title ?? 'Сессия',
        createdAt: '2026-11-24T00:00:00Z',
        modifiedAt: spec.modifiedAt ?? '2026-11-24T00:01:00Z',
        ...(spec.status !== undefined ? { status: spec.status } : {}),
        ...(spec.chats ? {
          chats: spec.chats.map((chat): SessionChatSummary => ({
            resource: chat.uri,
            title: chat.title ?? 'Чат',
            ...(chat.status !== undefined ? { status: chat.status } : {}),
            ...(chat.interactivity !== undefined ? { interactivity: chat.interactivity } : {}),
          })),
        } : {}),
        ...(spec.defaultChat ? { defaultChat: spec.defaultChat } : {}),
      } as SessionSummary,
    })),
  };
}

test('первая сводка становится baseline и не уведомляет о старых состояниях', () => {
  const transitions = new PushTransitions();
  assert.deepEqual(transitions.observe(overview({ status: SessionStatus.InputNeeded })), []);
  assert.deepEqual(transitions.observe(overview({ status: SessionStatus.InputNeeded })), []);
});

test('переход InProgress → Idle даёт одно уведомление о завершении хода', () => {
  const transitions = new PushTransitions();
  transitions.observe(overview({ status: SessionStatus.Idle }));
  transitions.observe(overview({ status: SessionStatus.InProgress }));
  const result = transitions.observe(overview({ status: SessionStatus.Idle, modifiedAt: '2026-11-24T00:02:00Z' }));
  assert.deepEqual(result, [{
    hostId: 'local', sessionUri: SESSION, hostLabel: 'Mac', title: 'Сессия', kind: 'done',
  }]);
  assert.deepEqual(transitions.observe(overview({ status: SessionStatus.Idle, modifiedAt: '2026-11-24T00:02:00Z' })), []);
});

test('переход в InputNeeded срабатывает и из Idle, и из InProgress', () => {
  for (const before of [SessionStatus.Idle, SessionStatus.InProgress]) {
    const transitions = new PushTransitions();
    transitions.observe(overview({ status: before }));
    const result = transitions.observe(overview({ status: SessionStatus.InputNeeded }));
    assert.equal(result.length, 1, String(before));
    assert.equal(result[0]?.kind, 'input');
  }
});

test('возврат из InputNeeded в Idle не считается завершением хода', () => {
  const transitions = new PushTransitions();
  transitions.observe(overview({ status: SessionStatus.InputNeeded }));
  assert.deepEqual(transitions.observe(overview({ status: SessionStatus.Idle })), []);
});

test('ошибка хода определяется по статусу сессии', () => {
  const transitions = new PushTransitions();
  transitions.observe(overview({ status: SessionStatus.InProgress }));
  const result = transitions.observe(overview({ status: SessionStatus.Error }));
  assert.equal(result.length, 1);
  assert.equal(result[0]?.kind, 'error');
});

test('ошибка не-default чата ловится по статусу чата, даже когда сессия ещё в работе', () => {
  const transitions = new PushTransitions();
  const chats = [{ uri: CHAT }, { uri: SECOND, title: 'Второй' }];
  transitions.observe(overview({ status: SessionStatus.InProgress, chats }));
  const result = transitions.observe(overview({
    status: SessionStatus.InProgress,
    chats: [{ uri: CHAT }, { uri: SECOND, title: 'Второй', status: SessionStatus.Error }],
  }));
  assert.deepEqual(result, [{
    hostId: 'local', sessionUri: SESSION, hostLabel: 'Mac', title: 'Сессия', kind: 'error',
    chatUri: SECOND, chatTitle: 'Второй',
  }]);
});

test('повторный снимок и чтение/архив не создают дублей', () => {
  const transitions = new PushTransitions();
  transitions.observe(overview({ status: SessionStatus.InProgress }));
  const done = overview({ status: SessionStatus.Idle | SessionStatus.IsRead, modifiedAt: '2026-11-24T00:02:00Z' });
  assert.equal(transitions.observe(done).length, 1);
  assert.deepEqual(transitions.observe(done), []);
  assert.deepEqual(transitions.observe(overview({ status: SessionStatus.Idle | SessionStatus.IsArchived })), []);
});

test('архивная сессия не уведомляет даже при смене фазы', () => {
  const transitions = new PushTransitions();
  transitions.observe(overview({ status: SessionStatus.InProgress | SessionStatus.IsArchived }));
  assert.deepEqual(transitions.observe(overview({ status: SessionStatus.Idle | SessionStatus.IsArchived })), []);
});

test('InputNeeded выбирает чат, который ждёт ответа; иначе используется defaultChat', () => {
  const transitions = new PushTransitions();
  const chats = [
    { uri: CHAT, title: 'Основной' },
    { uri: SECOND, title: 'Вопрос', status: SessionStatus.InputNeeded },
  ];
  transitions.observe(overview({ status: SessionStatus.InProgress, chats, defaultChat: CHAT }));
  const result = transitions.observe(overview({ status: SessionStatus.InputNeeded, chats, defaultChat: CHAT }));
  assert.deepEqual(result[0], {
    hostId: 'local', sessionUri: SESSION, hostLabel: 'Mac', title: 'Сессия', kind: 'input',
    chatUri: SECOND, chatTitle: 'Вопрос',
  });

  const fallback = new PushTransitions();
  fallback.observe(overview({ status: SessionStatus.InProgress, chats: [{ uri: CHAT, title: 'Основной' }], defaultChat: CHAT }));
  const withDefault = fallback.observe(overview({ status: SessionStatus.InputNeeded, chats: [{ uri: CHAT, title: 'Основной' }], defaultChat: CHAT }));
  assert.deepEqual(withDefault[0]?.chatUri, CHAT);
  assert.deepEqual(withDefault[0]?.chatTitle, 'Основной');
});

test('скрытые и скрытый defaultChat не попадают в deep link', () => {
  const transitions = new PushTransitions();
  const chats = [
    { uri: HIDDEN, title: 'Скрытый', status: SessionStatus.InputNeeded, interactivity: ChatInteractivity.Hidden },
    { uri: CHAT, title: 'Основной', interactivity: ChatInteractivity.Full },
  ];
  transitions.observe(overview({ status: SessionStatus.InProgress, chats, defaultChat: HIDDEN }));
  const result = transitions.observe(overview({ status: SessionStatus.InputNeeded, chats, defaultChat: HIDDEN }));
  assert.equal(result.length, 1);
  assert.equal(result[0]?.chatUri, undefined);
});

test('завершённый ход выбирает чат, который работал, иначе defaultChat', () => {
  const transitions = new PushTransitions();
  const chats = [{ uri: CHAT, title: 'Основной' }, { uri: SECOND, title: 'Второй' }];
  transitions.observe(overview({ status: SessionStatus.InProgress, chats: [{ uri: CHAT, title: 'Основной' }, { uri: SECOND, title: 'Второй', status: SessionStatus.InProgress }], defaultChat: CHAT }));
  const result = transitions.observe(overview({ status: SessionStatus.Idle, chats, defaultChat: CHAT }));
  assert.deepEqual(result[0]?.chatUri, SECOND);
  assert.equal(result[0]?.chatTitle, 'Второй');
});

test('новые и удалённые сессии не уведомляют, удалённые забываются', () => {
  const transitions = new PushTransitions();
  transitions.observe(overview({ status: SessionStatus.InProgress }));
  assert.deepEqual(transitions.observe(overview(
    { status: SessionStatus.InProgress },
    { sessionUri: 'ahp-session:/new', status: SessionStatus.InputNeeded },
  )), []);
  assert.deepEqual(transitions.observe(overview({ sessionUri: 'ahp-session:/new', status: SessionStatus.InputNeeded })), []);
});

test('подтверждение приоритетнее ошибки и завершения хода', () => {
  const transitions = new PushTransitions();
  transitions.observe(overview({ status: SessionStatus.InProgress }));
  const result = transitions.observe(overview({ status: SessionStatus.InputNeeded | SessionStatus.Error }));
  assert.equal(result.length, 1);
  assert.equal(result[0]?.kind, 'input');
});

test('replay сводки с тем же modifiedAt не повторяет уведомление', () => {
  const transitions = new PushTransitions();
  transitions.observe(overview({ status: SessionStatus.Idle, modifiedAt: '2026-11-24T00:01:00Z' }));
  transitions.observe(overview({ status: SessionStatus.InProgress, modifiedAt: '2026-11-24T00:01:00Z' }));
  assert.equal(transitions.observe(overview({ status: SessionStatus.Idle, modifiedAt: '2026-11-24T00:01:00Z' })).length, 1);
  transitions.observe(overview({ status: SessionStatus.InProgress, modifiedAt: '2026-11-24T00:01:00Z' }));
  assert.deepEqual(transitions.observe(overview({ status: SessionStatus.Idle, modifiedAt: '2026-11-24T00:01:00Z' })), []);
});

test('отсутствующие статусы и пустые заголовки не ломают детектор', () => {
  const transitions = new PushTransitions();
  transitions.observe({ hosts: [], sessions: [] });
  const result = transitions.observe(overview({ title: '   ', chats: [{ uri: CHAT }, { uri: SECOND, status: SessionStatus.Error }] }));
  assert.deepEqual(result, []);
});
