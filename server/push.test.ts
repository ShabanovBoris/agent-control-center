import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SessionStatus, type SessionChatSummary, type SessionSummary } from '@microsoft/agent-host-protocol';
import type { Overview, PushSubscriptionPayload } from '../shared/protocol.js';
import {
  createPushService, DEFAULT_VAPID_SUBJECT, MAX_SUBSCRIPTIONS,
  PushDeliveryError, PushFailure, type PushDelivery, type PushSender, type PushTarget,
} from './push.js';

const SESSION = 'ahp-session:/s';
const CHAT = 'ahp-chat:/c';
const MAC = 'https://mac.ts.net';
const PHONE = 'https://phone.ts.net';

class FakeSender implements PushSender {
  readonly sent: { target: PushTarget; payload: Record<string, string>; delivery: PushDelivery }[] = [];
  readonly failures = new Map<string, Error>();

  async send(target: PushTarget, payload: string, delivery: PushDelivery): Promise<void> {
    const failure = this.failures.get(target.endpoint);
    if (failure) {
      this.failures.delete(target.endpoint);
      throw failure;
    }
    this.sent.push({ target, payload: JSON.parse(payload) as Record<string, string>, delivery });
  }
}

function key(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function subscription(endpoint = 'https://push.example/ep1'): PushSubscriptionPayload {
  return { endpoint, expirationTime: null, keys: { p256dh: key(65), auth: key(16) } };
}

function overview(status: SessionStatus, modifiedAt = '2026-11-24T00:02:00Z', chatStatus?: SessionStatus): Overview {
  return {
    hosts: [],
    sessions: [{
      hostId: 'local',
      hostLabel: 'Mac',
      summary: {
        provider: 'codex',
        resource: SESSION,
        title: 'Сессия',
        createdAt: '2026-11-24T00:00:00Z',
        modifiedAt,
        status,
        chats: [{ resource: CHAT, title: 'Основной', ...(chatStatus !== undefined ? { status: chatStatus } : {}) } as SessionChatSummary],
        defaultChat: CHAT,
      } as SessionSummary,
    }],
  };
}

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'acc-push-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('VAPID-ключи генерируются один раз и хранятся с правами 0600', async t => {
  const dir = await tempDir(t);
  const first = await createPushService({ dir, sender: new FakeSender() });
  const path = join(dir, 'push-vapid.json');
  const stored = JSON.parse(await readFile(path, 'utf8')) as Record<string, string>;
  assert.equal(stored.subject, DEFAULT_VAPID_SUBJECT);
  assert.equal(Buffer.from(stored.publicKey!, 'base64url').length, 65);
  assert.equal(Buffer.from(stored.privateKey!, 'base64url').length, 32);
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  const second = await createPushService({ dir, sender: new FakeSender() });
  assert.equal(second.publicKey, first.publicKey);
  assert.equal(second.publicKey, stored.publicKey);
});

test('повреждённые VAPID-ключи и файл подписок не запускают push', async t => {
  const dir = await tempDir(t);
  const path = join(dir, 'push-vapid.json');
  const broken = '{"publicKey":"короткий"}';
  await writeFile(path, broken);
  await assert.rejects(createPushService({ dir }), PushFailure);
  assert.equal(await readFile(path, 'utf8'), broken, 'файл не перезаписывается');

  await rm(path);
  await writeFile(join(dir, 'push-subscriptions.json'), '{');
  await assert.rejects(createPushService({ dir }), PushFailure);
});

test('подписка идемпотентна по endpoint, переживает перезапуск и удаляется', async t => {
  const dir = await tempDir(t);
  const sender = new FakeSender();
  const service = await createPushService({ dir, sender });
  const first = subscription();
  await service.subscribe({ origin: MAC, subscription: first });
  const path = join(dir, 'push-subscriptions.json');
  const stored = JSON.parse(await readFile(path, 'utf8')) as { subscriptions: Record<string, unknown>[] };
  assert.equal(stored.subscriptions.length, 1);
  assert.equal(stored.subscriptions[0]!.origin, MAC);
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  const updated = { ...first, keys: { p256dh: key(65), auth: key(16) } };
  await service.subscribe({ origin: MAC, subscription: updated });
  assert.equal(service.subscriptionCount, 1);
  const reopened = await createPushService({ dir, sender });
  assert.equal(reopened.subscriptionCount, 1);
  const storedAgain = JSON.parse(await readFile(path, 'utf8')) as { subscriptions: Record<string, unknown>[] };
  assert.deepEqual(storedAgain.subscriptions[0]!.keys, updated.keys);
  assert.equal(storedAgain.subscriptions[0]!.createdAt, stored.subscriptions[0]!.createdAt);

  await service.unsubscribe(first.endpoint);
  await service.unsubscribe(first.endpoint);
  assert.equal(service.subscriptionCount, 0);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { subscriptions: [] });
});

test('лимит устройств не превышается', async t => {
  const dir = await tempDir(t);
  const service = await createPushService({ dir, sender: new FakeSender() });
  for (let index = 0; index < MAX_SUBSCRIPTIONS; index += 1) {
    await service.subscribe({ origin: MAC, subscription: subscription(`https://push.example/ep${index}`) });
  }
  await assert.rejects(
    service.subscribe({ origin: MAC, subscription: subscription('https://push.example/extra') }),
    PushFailure,
  );
  assert.equal(service.subscriptionCount, MAX_SUBSCRIPTIONS);
});

test('конкурентные subscribe и unsubscribe не теряют записи', async t => {
  const dir = await tempDir(t);
  const service = await createPushService({ dir, sender: new FakeSender() });
  const endpoints = Array.from({ length: 10 }, (_, index) => `https://push.example/ep${index}`);
  await Promise.all(endpoints.map(endpoint => service.subscribe({ origin: MAC, subscription: subscription(endpoint) })));
  assert.equal(service.subscriptionCount, 10);
  await Promise.all([
    ...endpoints.slice(0, 5).map(endpoint => service.unsubscribe(endpoint)),
    ...Array.from({ length: 5 }, (_, index) => service.subscribe({ origin: PHONE, subscription: subscription(`https://push.example/new${index}`) })),
  ]);
  assert.equal(service.subscriptionCount, 10);
  const stored = JSON.parse(await readFile(join(dir, 'push-subscriptions.json'), 'utf8')) as { subscriptions: { endpoint: string }[] };
  assert.equal(stored.subscriptions.length, 10);
  assert.equal(service.subscriptionCount, stored.subscriptions.length);
});

test('некорректные адрес, endpoint и ключи отклоняются без содержимого в ошибке', async t => {
  const dir = await tempDir(t);
  const service = await createPushService({ dir, sender: new FakeSender() });
  for (const origin of ['not a url', 'ftp://mac.ts.net', `${MAC}/path`, `${MAC}/`]) {
    await assert.rejects(service.subscribe({ origin, subscription: subscription() }), PushFailure, origin);
  }
  const bad = [
    { ...subscription(), endpoint: 'http://push.example/ep' },
    { ...subscription(), endpoint: `https://push.example/${'x'.repeat(2048)}` },
    { ...subscription(), keys: { p256dh: key(64), auth: key(16) } },
    { ...subscription(), keys: { p256dh: key(65), auth: key(8) } },
    { ...subscription(), expirationTime: Number.NaN },
  ];
  for (const subscription_ of bad) {
    const error = await service.subscribe({ origin: MAC, subscription: subscription_ }).then(() => undefined, (reason: unknown) => reason);
    assert.ok(error instanceof PushFailure);
    assert.doesNotMatch(error.message, /push\.example/, 'endpoint не должен попадать в текст ошибки');
  }
  assert.equal(service.subscriptionCount, 0);
});

test('уведомление о завершении хода содержит deep link, tag и настройки доставки', async t => {
  const dir = await tempDir(t);
  const sender = new FakeSender();
  const service = await createPushService({ dir, sender });
  await service.subscribe({ origin: MAC, subscription: subscription() });
  await service.observe(overview(SessionStatus.InProgress, '2026-11-24T00:01:00Z', SessionStatus.InProgress), () => new Set());
  await service.observe(overview(SessionStatus.Idle, '2026-11-24T00:02:00Z', SessionStatus.Idle), () => new Set());
  assert.equal(sender.sent.length, 1);
  const [sent] = sender.sent;
  assert.deepEqual(sent?.payload, {
    title: 'Сессия',
    body: 'Mac: Ход завершён · Основной',
    url: `${MAC}/#local|ahp-session%3A%2Fs|ahp-chat%3A%2Fc`,
    tag: 'acc:local:ahp-session:/s:done',
  });
  assert.deepEqual(sent?.delivery, { ttl: 600, urgency: 'normal' });
  assert.equal(sent?.target.endpoint, 'https://push.example/ep1');
  assert.equal(Buffer.from(sent?.target.keys.p256dh ?? '', 'base64url').length, 65);

  await service.observe(overview(SessionStatus.Idle, '2026-11-24T00:02:00Z', SessionStatus.Idle), () => new Set());
  assert.equal(sender.sent.length, 1, 'повторный snapshot не дублирует уведомление');
});

test('подтверждение и ошибка доставляются с высоким приоритетом', async t => {
  const dir = await tempDir(t);
  const sender = new FakeSender();
  const service = await createPushService({ dir, sender });
  await service.subscribe({ origin: MAC, subscription: subscription() });
  await service.observe(overview(SessionStatus.Idle, '2026-11-24T00:01:00Z'), () => new Set());
  await service.observe(overview(SessionStatus.InputNeeded, '2026-11-24T00:02:00Z'), () => new Set());
  assert.equal(sender.sent[0]?.payload.body, 'Mac: Агент ждёт ответа · Основной');
  assert.deepEqual(sender.sent[0]?.delivery, { ttl: 3600, urgency: 'high' });

  await service.observe(overview(SessionStatus.InProgress, '2026-11-24T00:03:00Z'), () => new Set());
  await service.observe(overview(SessionStatus.Error, '2026-11-24T00:04:00Z'), () => new Set());
  assert.equal(sender.sent[1]?.payload.body, 'Mac: Ошибка хода · Основной');
  assert.deepEqual(sender.sent[1]?.delivery, { ttl: 3600, urgency: 'high' });
});

test('устройство, где сессия видима, push не получает, остальные получают', async t => {
  const dir = await tempDir(t);
  const sender = new FakeSender();
  const service = await createPushService({ dir, sender });
  await service.subscribe({ origin: MAC, subscription: subscription('https://push.example/mac') });
  await service.subscribe({ origin: PHONE, subscription: subscription('https://push.example/phone') });
  await service.observe(overview(SessionStatus.InProgress, '2026-11-24T00:01:00Z'), () => new Set());
  await service.observe(overview(SessionStatus.Idle, '2026-11-24T00:02:00Z'), () => new Set([MAC]));
  assert.deepEqual(sender.sent.map(sent => sent.target.endpoint), ['https://push.example/phone']);
  assert.equal(sender.sent[0]?.payload.url, `${PHONE}/#local|ahp-session%3A%2Fs|ahp-chat%3A%2Fc`);
});

test('мёртвые подписки удаляются по 404/410, живые остаются при 429/5xx и сети', async t => {
  for (const status of [404, 410]) {
    const dir = await tempDir(t);
    const sender = new FakeSender();
    const service = await createPushService({ dir, sender });
    const dead = subscription('https://push.example/dead');
    await service.subscribe({ origin: MAC, subscription: dead });
    sender.failures.set(dead.endpoint, new PushDeliveryError(status));
    await service.observe(overview(SessionStatus.InProgress, '2026-11-24T00:01:00Z'), () => new Set());
    await service.observe(overview(SessionStatus.Idle, '2026-11-24T00:02:00Z'), () => new Set());
    assert.equal(service.subscriptionCount, 0, String(status));
  }

  for (const failure of [new PushDeliveryError(500), new PushDeliveryError(429), new Error('offline')]) {
    const dir = await tempDir(t);
    const sender = new FakeSender();
    const service = await createPushService({ dir, sender });
    const alive = subscription('https://push.example/alive');
    await service.subscribe({ origin: MAC, subscription: alive });
    sender.failures.set(alive.endpoint, failure);
    await service.observe(overview(SessionStatus.InProgress, '2026-11-24T00:01:00Z'), () => new Set());
    await service.observe(overview(SessionStatus.Idle, '2026-11-24T00:02:00Z'), () => new Set());
    assert.equal(service.subscriptionCount, 1, failure.message);
  }
});

test('ошибки доставки логируются без endpoint, ключей и payload', async t => {
  const dir = await tempDir(t);
  const sender = new FakeSender();
  const service = await createPushService({ dir, sender });
  const dead = subscription('https://push.example/secret-endpoint');
  await service.subscribe({ origin: MAC, subscription: dead });
  sender.failures.set(dead.endpoint, new PushDeliveryError(503));
  const logged: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  t.after(() => { console.warn = original; });
  await service.observe(overview(SessionStatus.InProgress, '2026-11-24T00:01:00Z'), () => new Set());
  await service.observe(overview(SessionStatus.Idle, '2026-11-24T00:02:00Z'), () => new Set());
  assert.ok(logged.length > 0);
  for (const line of logged) {
    assert.doesNotMatch(line, /secret-endpoint|p256dh|auth|endpoint/);
  }
});

test('тестовая отправка идёт только подпискам указанного устройства', async t => {
  const dir = await tempDir(t);
  const sender = new FakeSender();
  const service = await createPushService({ dir, sender });
  await service.subscribe({ origin: MAC, subscription: subscription('https://push.example/mac') });
  await service.subscribe({ origin: PHONE, subscription: subscription('https://push.example/phone') });
  assert.deepEqual(await service.test(MAC), { delivered: 1 });
  assert.deepEqual(sender.sent.map(sent => sent.target.endpoint), ['https://push.example/mac']);
  assert.deepEqual(sender.sent[0]?.payload, {
    title: 'Agent Control Center',
    body: 'Проверка уведомлений',
    url: `${MAC}/`,
    tag: 'acc:test',
  });
  assert.deepEqual(await service.test('https://elsewhere.ts.net'), { delivered: 0 });
  await assert.rejects(service.test('not a url'), PushFailure);
});
