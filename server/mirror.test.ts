import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionType, ChangesetStatus, type ActionEnvelope, type Snapshot } from '@microsoft/agent-host-protocol';
import { isSupportedChannel } from '../shared/reduce.js';
import { ChannelMirror } from './mirror.js';

const HOST = 'h';
const SESSION = 'ahp-session:/s1';

function sessionSnapshot(title: string, fromSeq: number): Snapshot {
  return {
    resource: SESSION,
    fromSeq,
    state: { provider: 'claude', title, status: 1, lifecycle: 'ready', activeClients: [], chats: [] },
  } as unknown as Snapshot;
}

function titleChanged(title: string, serverSeq: number, rejectionReason?: string): ActionEnvelope {
  return {
    channel: SESSION,
    serverSeq,
    origin: undefined,
    action: { type: ActionType.SessionTitleChanged, title },
    ...(rejectionReason ? { rejectionReason } : {}),
  } as unknown as ActionEnvelope;
}

const title = (mirror: ChannelMirror) => (mirror.state(HOST, SESSION) as { title: string } | undefined)?.title;

test('action, пришедший раньше снимка, применяется после него', () => {
  const mirror = new ChannelMirror();
  mirror.track(HOST, SESSION);
  const load = mirror.loadStarted(HOST, SESSION);
  assert.equal(mirror.apply(HOST, titleChanged('новый', 6)), undefined, 'без состояния рассылать нечего');
  mirror.loadFinished(load, sessionSnapshot('старый', 5));
  assert.equal(title(mirror), 'новый');
});

test('action, уже учтённый в снимке, не применяется повторно', () => {
  const mirror = new ChannelMirror();
  mirror.track(HOST, SESSION);
  const load = mirror.loadStarted(HOST, SESSION);
  mirror.apply(HOST, titleChanged('устаревший', 4));
  mirror.loadFinished(load, sessionSnapshot('из снимка', 5));
  assert.equal(title(mirror), 'из снимка');
  assert.equal(mirror.apply(HOST, titleChanged('повтор', 5)), undefined);
  assert.equal(title(mirror), 'из снимка');
});

test('после снимка новые actions применяются и возвращаются для рассылки', () => {
  const mirror = new ChannelMirror();
  mirror.track(HOST, SESSION);
  mirror.loadFinished(mirror.loadStarted(HOST, SESSION), sessionSnapshot('a', 5));
  assert.ok(mirror.apply(HOST, titleChanged('b', 6)));
  assert.equal(title(mirror), 'b');
});

test('resync: actions во время перезапроса видны сразу и не теряются после нового снимка', () => {
  const mirror = new ChannelMirror();
  mirror.track(HOST, SESSION);
  mirror.loadFinished(mirror.loadStarted(HOST, SESSION), sessionSnapshot('a', 5));

  const resync = mirror.loadStarted(HOST, SESSION);
  assert.ok(mirror.apply(HOST, titleChanged('во время resync', 9)), 'наблюдатели видят action сразу');
  mirror.loadFinished(resync, sessionSnapshot('снимок на 8', 8));
  assert.equal(title(mirror), 'во время resync');
});

test('поздний снимок из параллельного запроса не откатывает более новое состояние', () => {
  const mirror = new ChannelMirror();
  mirror.track(HOST, SESSION);
  const slow = mirror.loadStarted(HOST, SESSION);
  const fast = mirror.loadStarted(HOST, SESSION);
  mirror.loadFinished(fast, sessionSnapshot('новый', 9));
  assert.equal(mirror.loadFinished(slow, sessionSnapshot('устаревший', 8)), undefined);
  assert.equal(title(mirror), 'новый');
  assert.equal(mirror.apply(HOST, titleChanged('дубликат', 9)), undefined);
  assert.equal(mirror.apply(HOST, titleChanged('следующий', 10)), 'applied');
  assert.equal(title(mirror), 'следующий');
});

test('отклонённый хостом action и action чужого канала состояние не меняют', () => {
  const mirror = new ChannelMirror();
  mirror.track(HOST, SESSION);
  mirror.loadFinished(mirror.loadStarted(HOST, SESSION), sessionSnapshot('a', 5));
  assert.equal(mirror.apply(HOST, titleChanged('отклонён', 6, 'conflict')), undefined);
  assert.equal(mirror.apply('другой-хост', titleChanged('чужой', 7)), undefined);
  assert.equal(title(mirror), 'a');
});

test('неудачный запрос снимка оставляет прежнее состояние', () => {
  const mirror = new ChannelMirror();
  mirror.track(HOST, SESSION);
  mirror.loadFinished(mirror.loadStarted(HOST, SESSION), sessionSnapshot('a', 5));
  assert.equal(mirror.loadFinished(mirror.loadStarted(HOST, SESSION), undefined), undefined);
  assert.equal(title(mirror), 'a');
});

test('снимок от прежней подписки не попадает в заново открытый канал', () => {
  const mirror = new ChannelMirror();
  mirror.track(HOST, SESSION);
  const stale = mirror.loadStarted(HOST, SESSION);
  mirror.drop(HOST, SESSION);
  mirror.track(HOST, SESSION);
  const fresh = mirror.loadStarted(HOST, SESSION);
  assert.equal(mirror.isCurrent(stale), false);
  assert.equal(mirror.isCurrent(fresh), true);
  assert.equal(mirror.loadFinished(stale, sessionSnapshot('старая подписка', 5)), undefined);
  assert.equal(title(mirror), undefined);
  mirror.loadFinished(fresh, sessionSnapshot('новая подписка', 7));
  assert.equal(title(mirror), 'новая подписка');
});

test('вернувшийся из истории набор изменений обновляется и остаётся доступен следующему подписчику', () => {
  const file = {
    id: 'file:///workspace/file.txt',
    edit: { after: { uri: 'file:///workspace/file.txt', content: { uri: 'session-db:/saved' } } },
  };
  for (const channel of ['ahp-chat:/chat/changeset/turn/old-turn', 'ahp-changeset:/old-turn']) {
    assert.ok(isSupportedChannel(channel));
    const mirror = new ChannelMirror();
    mirror.track(HOST, channel);
    const token = mirror.loadStarted(HOST, channel);
    mirror.apply(HOST, { channel, serverSeq: 6, origin: undefined, action: { type: ActionType.ChangesetFileSet, file } });
    mirror.loadFinished(token, { resource: channel, fromSeq: 5, state: { status: ChangesetStatus.Computing, files: [] } });
    assert.equal(mirror.apply(HOST, {
      channel, serverSeq: 7, origin: undefined, action: { type: ActionType.ChangesetStatusChanged, status: ChangesetStatus.Ready },
    }), 'applied');
    assert.deepEqual(mirror.state(HOST, channel), { status: ChangesetStatus.Ready, files: [file] });
  }
});
