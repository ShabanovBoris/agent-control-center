import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { loadConfig } from '../server/config.js';
import { localHosts } from '../server/local-hosts.js';
import { parseServerMessage, type Overview } from '../shared/protocol.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
process.chdir(projectRoot);
const config = await loadConfig(process.env.ACC_CONFIG ?? 'hosts.json');
const hosts = localHosts(config.hosts);
if (hosts.length !== config.hosts.length || hosts.length === 0) {
  throw new Error('restart:services управляет только локальными хостами local и gemini из hosts.json.');
}

const base = process.env.ACC_BACKEND ?? `${config.listen.host}:${config.listen.port}`;
const origin = process.env.ACC_ORIGIN ?? `http://${base}`;
const timeoutMs = Number(process.env.ACC_RESTART_TIMEOUT_MS ?? 600_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 1_800_000) {
  throw new Error('ACC_RESTART_TIMEOUT_MS должен быть от 30000 до 1800000 миллисекунд.');
}

const deadline = Date.now() + timeoutMs;
function backendCall(): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${base}/ws`, { headers: { origin } });
    let settled = false;
    let accepted = false;
    const remaining = () => Math.max(1, deadline - Date.now());
    const deadlineTimer = setTimeout(() => finish(new Error('Backend не подтвердил перезапуск за отведённое время.')), remaining());
    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      socket.terminate();
      if (error) reject(error); else resolve();
    }
    socket.on('open', () => socket.send(JSON.stringify({ t: 'call', id: 1, call: { op: 'restartServices' } })));
    socket.on('message', data => {
      const message = parseServerMessage(String(data));
      if (message?.t !== 'result' || message.id !== 1) return;
      if (!message.ok) return finish(new Error(message.error.message));
      // Сохраняем соединение до штатного close старого backend: ранний HTTP/WebSocket
      // на том же порту мог бы принадлежать ещё завершающемуся процессу.
      accepted = true;
    });
    socket.on('error', error => finish(new Error(`Backend недоступен: ${error.message}. Запустите npm run server и повторите команду.`)));
    socket.on('close', () => finish(accepted ? undefined : new Error('Backend закрыл соединение до подтверждения перезапуска.')));
    socket.on('unexpected-response', (_request, response) => finish(new Error(`Backend отклонил подключение: HTTP ${response.statusCode}.`)));
  });
}

console.log(`[services] Перезапуск: ${hosts.map(host => host.label).join(', ')} и backend.`);
await backendCall();

async function overview(): Promise<Overview> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${base}/ws`, { headers: { origin } });
    let settled = false;
    const deadline = setTimeout(() => finish(new Error('Backend не вернул сводку.')), 5000);
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

for (;;) {
  let error: unknown;
  try {
    const state = await overview();
    if (hosts.every(host => state.hosts.some(item => item.id === host.id && item.status === 'connected'))) {
      console.log('[services] Оба хоста и backend доступны.');
      break;
    }
    console.log('[services] Backend отвечает; ожидание подключения хостов.');
  } catch (cause) {
    error = cause;
  }
  if (Date.now() >= deadline) {
    throw new Error('Не все хосты подключились за отведённое время. Проверьте .local/host.log и .local/gemini-host.log.', { cause: error });
  }
  await delay(500);
}

export {};
