/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isIosDevice, isStandalone, pushAvailability, toPushSubscriptionPayload, urlBase64ToUint8Array,
  type PushEnvironment,
} from './push.js';

const base: PushEnvironment = {
  secureContext: true,
  serviceWorker: true,
  pushManager: true,
  permission: 'default',
  isIos: false,
  standalone: true,
  hasSubscription: false,
};

test('состояния доступности push идут в порядке причин', () => {
  assert.deepEqual(pushAvailability({ ...base, secureContext: false, isIos: true, standalone: false }), {
    kind: 'unsupported', reason: 'Нужен HTTPS-адрес Tailscale или localhost: браузер не даёт push на http.',
  });
  assert.equal(pushAvailability({ ...base, isIos: true, standalone: false, pushManager: false }).kind, 'install');
  assert.equal(pushAvailability({ ...base, isIos: true, standalone: true, pushManager: false }).kind, 'unsupported');
  assert.equal(pushAvailability({ ...base, serviceWorker: false }).kind, 'unsupported');
  assert.equal(pushAvailability({ ...base, permission: undefined }).kind, 'unsupported');
  assert.equal(pushAvailability({ ...base, permission: 'denied' }).kind, 'blocked');
  assert.equal(pushAvailability({ ...base, permission: 'denied', hasSubscription: true }).kind, 'blocked');
  assert.equal(pushAvailability(base).kind, 'off');
  assert.equal(pushAvailability({ ...base, permission: 'granted' }).kind, 'off');
  assert.equal(pushAvailability({ ...base, hasSubscription: true }).kind, 'on');
});

test('iOS определяется по UA, включая iPad в режиме компьютера', () => {
  assert.equal(isIosDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 0), true);
  assert.equal(isIosDevice('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 0), true);
  assert.equal(isIosDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5), true);
  assert.equal(isIosDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0), false);
  assert.equal(isIosDevice('Mozilla/5.0 (X11; Linux x86_64) Chrome/126', 0), false);
});

test('standalone учитывает display-mode и navigator.standalone', () => {
  assert.equal(isStandalone(true, undefined), true);
  assert.equal(isStandalone(false, true), true);
  assert.equal(isStandalone(false, false), false);
  assert.equal(isStandalone(false, undefined), false);
});

test('VAPID public key декодируется из base64url с padding и без', () => {
  assert.deepEqual([...urlBase64ToUint8Array('AQIDBA')], [1, 2, 3, 4]);
  assert.deepEqual([...urlBase64ToUint8Array('AQIDBA==')], [1, 2, 3, 4]);
  assert.deepEqual([...urlBase64ToUint8Array('-_8')], [0xfb, 0xff]);
});

test('payload подписки сохраняет endpoint, expirationTime и ключи', () => {
  assert.deepEqual(toPushSubscriptionPayload({
    endpoint: 'https://push.example/e',
    expirationTime: null,
    keys: { p256dh: 'p', auth: 'a' },
  }), {
    endpoint: 'https://push.example/e',
    expirationTime: null,
    keys: { p256dh: 'p', auth: 'a' },
  });
  assert.throws(() => toPushSubscriptionPayload({
    endpoint: 'https://push.example/e',
    expirationTime: null,
    keys: {},
  }), /ключи подписки/);
  assert.throws(() => toPushSubscriptionPayload({
    endpoint: undefined,
    expirationTime: null,
    keys: { p256dh: 'p', auth: 'a' },
  }), /ключи подписки/);
});
