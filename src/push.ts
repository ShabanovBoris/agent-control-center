import type { PushSubscriptionPayload } from '../shared/protocol';

export type PushPermission = 'default' | 'granted' | 'denied';

export type PushAvailability =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'install'; reason: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'off' }
  | { kind: 'on' };

export interface PushEnvironment {
  secureContext: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  permission: PushPermission | undefined;
  isIos: boolean;
  standalone: boolean;
  hasSubscription: boolean;
}

/** Порядок важен: на iOS состояние «установите на домашний экран» объясняет и отсутствие PushManager. */
export function pushAvailability(environment: PushEnvironment): PushAvailability {
  if (!environment.secureContext) {
    return { kind: 'unsupported', reason: 'Нужен HTTPS-адрес Tailscale или localhost: браузер не даёт push на http.' };
  }
  if (environment.isIos && !environment.standalone) {
    return {
      kind: 'install',
      reason: 'На iPhone уведомления работают только у приложения с домашнего экрана (iOS 16.4+): '
        + '«Поделиться» → «На экран Домой», затем запустите панель с иконки.',
    };
  }
  if (!environment.serviceWorker || !environment.pushManager || environment.permission === undefined) {
    return {
      kind: 'unsupported',
      reason: environment.isIos
        ? 'Нужна iOS 16.4 или новее и запуск с домашнего экрана.'
        : 'Этот браузер не поддерживает push-уведомления.',
    };
  }
  if (environment.permission === 'denied') {
    return {
      kind: 'blocked',
      reason: 'Уведомления запрещены в настройках браузера. Разрешите их для этого сайта и перезагрузите панель.',
    };
  }
  return environment.hasSubscription ? { kind: 'on' } : { kind: 'off' };
}

export function isIosDevice(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/** iOS не поддерживает matchMedia display-mode для установленных PWA во всех версиях. */
export function isStandalone(displayModeMatches: boolean, navigatorStandalone: boolean | undefined): boolean {
  return displayModeMatches || navigatorStandalone === true;
}

/** VAPID public key приходит base64url без padding; PushManager ждёт байты. */
export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function toPushSubscriptionPayload(json: PushSubscriptionJSON): PushSubscriptionPayload {
  const { endpoint, keys } = json;
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (typeof endpoint !== 'string' || !endpoint || typeof p256dh !== 'string' || typeof auth !== 'string') {
    throw new Error('Браузер не вернул ключи подписки. Попробуйте выключить и включить уведомления.');
  }
  return {
    endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh, auth },
  };
}
