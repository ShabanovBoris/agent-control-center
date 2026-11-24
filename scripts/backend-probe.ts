import WebSocket from 'ws';
import { parseServerMessage, type Overview } from '../shared/protocol.js';

export interface BackendProbeOptions {
  /** `host:port` backend без схемы, например `127.0.0.1:8090`. */
  base: string;
  /** Origin панели: backend сверяет его с Host. */
  origin: string;
  timeoutMs?: number;
}

/**
 * Читает первое `overview` от backend. Используется готовностью `npm run up`
 * и `restart:services`; повторные попытки остаются на стороне вызывающего.
 */
export function probeBackendOverview({ base, origin, timeoutMs = 5000 }: BackendProbeOptions): Promise<Overview> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${base}/ws`, { headers: { origin } });
    let settled = false;
    const deadline = setTimeout(() => finish(new Error('Backend не вернул сводку.')), timeoutMs);
    function finish(error?: Error, value?: Overview): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.terminate();
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error('Backend не вернул сводку.'));
    }
    socket.on('message', data => {
      const message = parseServerMessage(String(data));
      if (message?.t === 'overview') finish(undefined, message.overview);
    });
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(new Error('Backend закрыл соединение.')));
    socket.on('unexpected-response', (_request, response) => finish(new Error(`HTTP ${response.statusCode}`)));
  });
}
