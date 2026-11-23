// Запуск: npx tsx scripts/backend-check.ts [--write] '<json Call или watch>' ...
import WebSocket from 'ws';
import { parseServerMessage, type Call, type ClientMessage } from '../shared/protocol.js';

const readOnly = new Set<string>(['refreshSession', 'fetchTurns', 'readResource', 'searchHistory'] satisfies Call['op'][]);

function parseCommands(args: string[], allowWrite: boolean): ClientMessage[] {
  return args.map((arg, index) => {
    const value: unknown = JSON.parse(arg);
    if (value && typeof value === 'object') {
      if ('watch' in value && Array.isArray(value.watch)) {
        const [hostId, uri] = value.watch;
        if (value.watch.length === 2 && typeof hostId === 'string' && typeof uri === 'string') return { t: 'watch', hostId, uri };
      }
      if ('op' in value && typeof value.op === 'string') {
        if (!allowWrite && !readOnly.has(value.op)) throw new Error(`Для команды ${value.op} укажите --write`);
        return { t: 'call', id: index + 1, call: value as Call };
      }
    }
    throw new Error(`Аргумент ${index + 1} должен содержать op или watch [hostId, uri]`);
  });
}

const args = process.argv.slice(2);
const allowWrite = args[0] === '--write';
const commands = parseCommands(allowWrite ? args.slice(1) : args, allowWrite);
const waitMs = Number(process.env.CHECK_WAIT_MS ?? 3000);
if (!Number.isInteger(waitMs) || waitMs <= 0 || waitMs > 2_147_483_647) throw new Error('CHECK_WAIT_MS должен быть положительным числом миллисекунд');

const base = process.env.ACC_BACKEND ?? '127.0.0.1:8090';
const origin = process.env.ACC_ORIGIN ?? `http://${base}`;
const socket = new WebSocket(`ws://${base}/ws`, { headers: { origin } });
const brief = (value: unknown, max = 1200) => JSON.stringify(value)?.slice(0, max);
const pending = new Set(commands.flatMap(message => message.t === 'call' ? [message.id] : []));
let gotOverview = false;
let finished = false;
let sendTimer: NodeJS.Timeout | undefined;
let deadline = setTimeout(() => finish('Истекло время подключения к backend (5 с)'), 5000);

function finish(error?: string): void {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  clearTimeout(sendTimer);
  if (error) {
    console.error('[backend-check]', error);
    process.exitCode = 1;
  }
  socket.terminate();
}

socket.on('unexpected-response', (_request, response) => {
  finish(`Подключение отклонено: HTTP ${response.statusCode}`);
});
socket.on('error', error => finish(error.message));
socket.on('close', () => finish('Backend закрыл соединение'));
socket.on('message', data => {
  const message = parseServerMessage(String(data));
  if (!message) return;
  if (message.t === 'overview') {
    gotOverview = true;
    for (const host of message.overview.hosts) {
      console.log(`host ${host.id}: ${host.status} v${host.protocolVersion ?? '?'} ${host.error ?? ''}`);
      for (const agent of host.agents) console.log(`  agent ${agent.provider}: models=${agent.models.length} sdk=${agent.sdk ?? '-'}`);
    }
    console.log(`sessions: ${message.overview.sessions.length}`, brief(message.overview.sessions.map(s => [s.summary.title, s.summary.status]), 400));
  } else {
    if (message.t === 'result') pending.delete(message.id);
    console.log(`<- ${message.t}`, brief(message));
  }
});
socket.on('open', () => {
  clearTimeout(deadline);
  if (commands.length > 0) {
    sendTimer = setTimeout(() => {
      for (const message of commands) socket.send(JSON.stringify(message));
    }, Math.min(500, Math.floor(waitMs / 2)));
  }
  deadline = setTimeout(() => {
    const complete = gotOverview && pending.size === 0;
    finish(complete ? undefined : 'Истекло время ожидания сводки или ответов на команды');
  }, waitMs);
});
