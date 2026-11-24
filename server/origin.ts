/**
 * Origin доверенного WebSocket-upgrade — единица «устройства» для push и непрочитанных.
 * Схема и порт входят в origin, поэтому `localhost` и `127.0.0.1` считаются разными устройствами.
 */
export function deviceOrigin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== value) return undefined;
  return url.origin;
}
