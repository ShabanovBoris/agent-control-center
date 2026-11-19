// Диагностика: подключается к хосту и печатает, что он реально умеет.
// Запуск: npx tsx scripts/probe.ts [ws://127.0.0.1:8089] [.local/host-token]
import { readFileSync } from 'node:fs';
import { MultiHostClient } from '@microsoft/agent-host-protocol/hosts';
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws';
import { ROOT_URI } from '../shared/protocol.js';

async function probe(): Promise<void> {
  const url = new URL(process.argv[2] ?? 'ws://127.0.0.1:8089');
  const tokenFile = process.argv[3] ?? '.local/host-token';
  url.searchParams.set('tkn', readFileSync(tokenFile, 'utf8').trim());

  const { multi, host } = await MultiHostClient.single({
    id: 'probe',
    label: 'probe',
    transportFactory: async () => WebSocketTransport.connect(url),
  });
  try {
    // single() возвращает управление до завершения handshake.
    if (host.state.status === 'failed') throw host.state.error;
    if (host.state.status !== 'connected') {
      for await (const event of multi.hostEvents()) {
        if (event.type === 'connected') break;
        if (event.type === 'stateChanged') {
          console.log('state ->', event.state.status, event.lastError?.message ?? '');
          if (event.state.status === 'failed') throw event.state.error;
        }
      }
    }
    const client = multi.client('probe');
    if (!client) throw new Error('Хост отключился');
    const snapshot = multi.host('probe');
    console.log(JSON.stringify(snapshot, (key, value) => (key === 'models' && Array.isArray(value) ? `[${value.length} models]` : value), 2));
    const sessions = await client.request('listSessions', { channel: ROOT_URI });
    console.log('listSessions:', JSON.stringify(sessions, null, 2).slice(0, 2000));
  } finally {
    await multi.shutdown();
  }
}

const deadline = setTimeout(() => {
  console.error('[probe] Истекло время ожидания ответа хоста (10 с)');
  process.exit(1);
}, 10_000);
try { await probe(); }
catch (error) {
  console.error('[probe]', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
}
