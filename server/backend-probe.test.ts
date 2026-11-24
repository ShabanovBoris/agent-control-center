import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { WebSocketServer } from 'ws';
import { probeBackendOverview } from '../scripts/backend-probe.js';

async function backend(t: TestContext, onConnection: (socket: import('ws').WebSocket, origin: string | undefined) => void): Promise<{ base: string; server: WebSocketServer }> {
  const http = createServer();
  const server = new WebSocketServer({ server: http });
  server.on('connection', (socket, request) => onConnection(socket, request.headers.origin));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.close(); http.close(() => resolve()); }));
  const { port } = http.address() as AddressInfo;
  return { base: `127.0.0.1:${port}`, server };
}

test('проба присылает Origin и возвращает первое overview', async t => {
  let origin: string | undefined;
  const { base } = await backend(t, (socket, value) => {
    origin = value;
    socket.send(JSON.stringify({ t: 'overview', overview: { hosts: [], sessions: [] } }));
  });
  const overview = await probeBackendOverview({ base, origin: 'http://127.0.0.1:5173', timeoutMs: 1000 });
  assert.deepEqual(overview, { hosts: [], sessions: [] });
  assert.equal(origin, 'http://127.0.0.1:5173');
});

test('молчащий backend даёт таймаут', async t => {
  const { base } = await backend(t, () => undefined);
  await assert.rejects(
    probeBackendOverview({ base, origin: 'http://127.0.0.1:5173', timeoutMs: 30 }),
    /не вернул сводку/,
  );
});

test('закрытое соединение объясняется, а не висит', async t => {
  const { base } = await backend(t, socket => socket.close());
  await assert.rejects(
    probeBackendOverview({ base, origin: 'http://127.0.0.1:5173', timeoutMs: 1000 }),
    /закрыл соединение/,
  );
});
