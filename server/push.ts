import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { generateVAPIDKeys, sendNotification, WebPushError, type PushSubscription } from 'web-push';
import type { Overview, PushSubscriptionPayload } from '../shared/protocol.js';
import { selectionToHash } from '../shared/routing.js';
import { PushTransitions, type PushTransition } from './push-transitions.js';

export const DEFAULT_VAPID_SUBJECT = 'https://github.com/ShabanovBoris/agent-control-center';
export const MAX_SUBSCRIPTIONS = 20;
const DELIVERY_TIMEOUT_MS = 10_000;

const KIND_LABEL: Record<PushTransition['kind'], string> = {
  input: 'Агент ждёт ответа',
  done: 'Ход завершён',
  error: 'Ошибка хода',
};

const KIND_DELIVERY: Record<PushTransition['kind'], PushDelivery> = {
  input: { ttl: 3600, urgency: 'high' },
  error: { ttl: 3600, urgency: 'high' },
  done: { ttl: 600, urgency: 'normal' },
};

export class PushFailure extends Error {}

/** Ответ push-сервиса: только код, без endpoint и тела — чтобы не утащить секреты в лог. */
export class PushDeliveryError extends Error {
  constructor(readonly statusCode: number | undefined) {
    super(statusCode === undefined ? 'Push-сервис недоступен' : `Push-сервис ответил ${statusCode}`);
  }
}

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushDelivery {
  ttl: number;
  urgency: 'high' | 'normal';
}

export interface PushSender {
  send(subscription: PushTarget, payload: string, delivery: PushDelivery): Promise<void>;
}

export interface StoredSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
  origin: string;
  createdAt: string;
}

interface Vapid {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export interface PushServiceOptions {
  dir: string;
  subject?: string;
  sender?: PushSender;
  now?: () => Date;
}

/** Открывает хранилище и VAPID-ключи; всё лежит в `.local` с правами 0600. */
export async function createPushService(options: PushServiceOptions): Promise<PushService> {
  const store = new PushStore(join(options.dir, 'push-subscriptions.json'));
  await store.load();
  const vapid = await loadVapid(join(options.dir, 'push-vapid.json'), options.subject ?? DEFAULT_VAPID_SUBJECT);
  const sender = options.sender ?? webPushSender(vapid);
  return new PushService(store, vapid, sender, options.now ?? (() => new Date()));
}

export class PushService {
  private readonly transitions = new PushTransitions();

  constructor(
    private readonly store: PushStore,
    private readonly vapid: Vapid,
    private readonly sender: PushSender,
    private readonly now: () => Date,
  ) {}

  get publicKey(): string {
    return this.vapid.publicKey;
  }

  get subscriptionCount(): number {
    return this.store.count;
  }

  async subscribe({ origin, subscription }: { origin: string; subscription: PushSubscriptionPayload }): Promise<void> {
    const address = deviceOrigin(origin);
    const entry = validateSubscription(subscription, address, this.now().toISOString());
    await this.store.upsert(entry);
  }

  async unsubscribe(endpoint: string): Promise<void> {
    await this.store.remove(endpoint);
  }

  /** Вызывается из broadcast; отправка идёт фоном и не задерживает сводку для браузеров. */
  async observe(overview: Overview, muted: (transition: PushTransition) => ReadonlySet<string>): Promise<void> {
    let transitions: PushTransition[];
    try {
      transitions = this.transitions.observe(overview);
    } catch (error) {
      console.warn('[acc] Не удалось разобрать переходы для push.', message(error));
      return;
    }
    await Promise.all(transitions.map(transition => this.deliver(transition, muted(transition)).catch(error => {
      console.warn('[acc] Не удалось отправить push.', message(error));
    })));
  }

  /** Тестовая доставка на конкретное устройство; presence на явный тест не действует. */
  async test(origin: string): Promise<{ delivered: number }> {
    const address = deviceOrigin(origin);
    const subscriptions = this.store.list().filter(subscription => subscription.origin === address);
    return { delivered: await this.sendAll(subscriptions, () => ({
      title: 'Agent Control Center',
      body: 'Проверка уведомлений',
      url: `${address}/`,
      tag: 'acc:test',
    }), { ttl: 600, urgency: 'normal' }) };
  }

  private async deliver(transition: PushTransition, muted: ReadonlySet<string>): Promise<void> {
    const subscriptions = this.store.list().filter(subscription => !muted.has(subscription.origin));
    if (subscriptions.length === 0) return;
    await this.sendAll(subscriptions, subscription => this.payload(transition, subscription), KIND_DELIVERY[transition.kind]);
  }

  private payload(transition: PushTransition, subscription: StoredSubscription): PushPayload {
    const selection = {
      hostId: transition.hostId,
      sessionUri: transition.sessionUri,
      ...(transition.chatUri ? { chatUri: transition.chatUri } : {}),
    };
    const body = `${transition.hostLabel}: ${KIND_LABEL[transition.kind]}`
      + (transition.chatTitle ? ` · ${transition.chatTitle}` : '');
    return {
      title: transition.title,
      body,
      url: `${subscription.origin}/${selectionToHash(selection)}`,
      tag: `acc:${transition.hostId}:${transition.sessionUri}:${transition.kind}`,
    };
  }

  private async sendAll(
    subscriptions: readonly StoredSubscription[],
    payloadFor: (subscription: StoredSubscription) => PushPayload,
    delivery: PushDelivery,
  ): Promise<number> {
    let delivered = 0;
    let rejectedVapid = false;
    let failed = false;
    for (const subscription of subscriptions) {
      try {
        await this.sender.send(
          { endpoint: subscription.endpoint, keys: subscription.keys },
          JSON.stringify(payloadFor(subscription)),
          delivery,
        );
        delivered += 1;
      } catch (error) {
        const status = error instanceof PushDeliveryError ? error.statusCode : undefined;
        if (status === 404 || status === 410) {
          // Подписка мертва: браузер отозвал разрешение или удалил PWA.
          await this.store.remove(subscription.endpoint);
          continue;
        }
        if (status === 401 || status === 403) {
          if (!rejectedVapid) {
            rejectedVapid = true;
            console.warn('[acc] Push-сервис отклонил VAPID. Если ключи менялись, выключите и включите уведомления на устройстве.');
          }
          continue;
        }
        if (!failed) {
          failed = true;
          console.warn(status === undefined
            ? '[acc] Push не доставлен: сеть или неизвестная ошибка.'
            : `[acc] Push не доставлен: push-сервис ответил ${status}.`);
        }
      }
    }
    return delivered;
  }
}

interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

function webPushSender(vapid: Vapid): PushSender {
  const vapidDetails = { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey };
  return {
    async send(subscription: PushSubscription, payload: string, { ttl, urgency }: PushDelivery): Promise<void> {
      try {
        await sendNotification(subscription, payload, {
          vapidDetails, TTL: ttl, urgency, timeout: DELIVERY_TIMEOUT_MS,
        });
      } catch (error) {
        if (error instanceof WebPushError) throw new PushDeliveryError(error.statusCode);
        throw error;
      }
    },
  };
}

/** Очередь read-modify-write: параллельные subscribe/unsubscribe не теряют записи. */
class PushStore {
  private queue: Promise<unknown> = Promise.resolve();
  private subscriptions: StoredSubscription[] = [];

  constructor(private readonly path: string) {}

  get count(): number {
    return this.subscriptions.length;
  }

  list(): readonly StoredSubscription[] {
    return this.subscriptions;
  }

  async load(): Promise<void> {
    const text = await readFile(this.path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw new PushFailure(`Не удалось прочитать ${this.path}: ${message(error)}`);
    });
    if (text === undefined) {
      this.subscriptions = [];
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Содержимое не логируем: в нём endpoint и ключи.
      throw new PushFailure(`Файл подписок ${this.path} повреждён.`);
    }
    const rows = isRecord(parsed) && Array.isArray(parsed.subscriptions) ? parsed.subscriptions : undefined;
    if (!rows) throw new PushFailure(`Файл подписок ${this.path} имеет неверный формат.`);
    this.subscriptions = rows.flatMap(row => {
      const entry = parseStoredSubscription(row);
      if (!entry) console.warn('[acc] Пропущена некорректная запись в файле push-подписок.');
      return entry ? [entry] : [];
    });
  }

  async upsert(entry: StoredSubscription): Promise<void> {
    await this.enqueue(async () => {
      const existing = this.subscriptions.find(subscription => subscription.endpoint === entry.endpoint);
      if (!existing && this.subscriptions.length >= MAX_SUBSCRIPTIONS) {
        throw new PushFailure(`Достигнут лимит устройств (${MAX_SUBSCRIPTIONS}). Выключите уведомления на старом устройстве.`);
      }
      const next = existing
        ? this.subscriptions.map(subscription => subscription.endpoint === entry.endpoint
          ? { ...entry, createdAt: subscription.createdAt }
          : subscription)
        : [...this.subscriptions, entry];
      await this.save(next);
      this.subscriptions = next;
    });
  }

  async remove(endpoint: string): Promise<void> {
    await this.enqueue(async () => {
      if (!this.subscriptions.some(subscription => subscription.endpoint === endpoint)) return;
      const next = this.subscriptions.filter(subscription => subscription.endpoint !== endpoint);
      await this.save(next);
      this.subscriptions = next;
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private save(subscriptions: readonly StoredSubscription[]): Promise<void> {
    return writePrivate(this.path, { subscriptions });
  }
}

async function loadVapid(path: string, defaultSubject: string): Promise<Vapid> {
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw new PushFailure(`Не удалось прочитать ${path}: ${message(error)}`);
  });
  if (text === undefined) {
    const keys = generateVAPIDKeys();
    const vapid = { subject: defaultSubject, publicKey: keys.publicKey, privateKey: keys.privateKey };
    await writePrivate(path, vapid);
    return vapid;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PushFailure(`Файл VAPID-ключей ${path} повреждён.`);
  }
  if (!isRecord(parsed)) throw new PushFailure(`Файл VAPID-ключей ${path} имеет неверный формат.`);
  const { publicKey, privateKey } = parsed;
  if (typeof publicKey !== 'string' || decodeKey(publicKey)?.length !== 65
    || typeof privateKey !== 'string' || decodeKey(privateKey)?.length !== 32) {
    throw new PushFailure(`Файл VAPID-ключей ${path} содержит некорректные ключи.`);
  }
  const subject = typeof parsed.subject === 'string' && parsed.subject.trim() ? parsed.subject.trim() : defaultSubject;
  await chmod(path, 0o600).catch(() => {});
  return { subject, publicKey, privateKey };
}

/** Временный файл + rename: writeFile с mode не исправит права уже существующего файла. */
async function writePrivate(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
    await chmod(path, 0o600).catch(() => {});
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function deviceOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PushFailure('Некорректный адрес устройства.');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== value) {
    throw new PushFailure('Некорректный адрес устройства.');
  }
  return url.origin;
}

function validateSubscription(subscription: PushSubscriptionPayload, origin: string, createdAt: string): StoredSubscription {
  if (!isRecord(subscription)) throw new PushFailure('Некорректная подписка на push.');
  const { endpoint, keys, expirationTime } = subscription;
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https:') || endpoint.length > 2048) {
    throw new PushFailure('Некорректный endpoint подписки.');
  }
  if (!isRecord(keys) || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string'
    || decodeKey(keys.p256dh)?.length !== 65 || decodeKey(keys.auth)?.length !== 16) {
    throw new PushFailure('Некорректные ключи подписки.');
  }
  if (expirationTime !== undefined && expirationTime !== null
    && (typeof expirationTime !== 'number' || !Number.isFinite(expirationTime))) {
    throw new PushFailure('Некорректное время истечения подписки.');
  }
  return {
    endpoint,
    ...(expirationTime !== undefined ? { expirationTime } : {}),
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    origin,
    createdAt,
  };
}

function parseStoredSubscription(value: unknown): StoredSubscription | undefined {
  if (!isRecord(value) || !isRecord(value.keys)) return undefined;
  const { endpoint, origin, createdAt, expirationTime } = value;
  const { p256dh, auth } = value.keys;
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https:') || endpoint.length > 2048) return undefined;
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !decodeKey(p256dh) || !decodeKey(auth)) return undefined;
  if (typeof origin !== 'string' || typeof createdAt !== 'string') return undefined;
  try {
    if (deviceOrigin(origin) !== origin) return undefined;
  } catch {
    return undefined;
  }
  return {
    endpoint,
    ...(expirationTime === null || typeof expirationTime === 'number' ? { expirationTime } : {}),
    keys: { p256dh, auth },
    origin,
    createdAt,
  };
}

function decodeKey(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  return Buffer.from(value, 'base64url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
