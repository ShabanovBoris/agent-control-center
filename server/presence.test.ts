import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleOrigins, type Presence } from './presence.js';

const hostId = 'local';
const sessionUri = 'ahp-session:/s';

test('push подавляется только на тех origin, где эта же сессия видима', () => {
  const presences: Presence[] = [
    { origin: 'https://mac.ts.net', visible: true, selection: { hostId, sessionUri } },
    { origin: 'http://localhost:5173', visible: true, selection: { hostId, sessionUri } },
    { origin: 'https://other.ts.net', visible: true, selection: { hostId, sessionUri: 'ahp-session:/other' } },
    { origin: 'https://hidden.ts.net', visible: false, selection: { hostId, sessionUri } },
    { origin: 'https://list.ts.net', visible: true },
  ];
  assert.deepEqual([...visibleOrigins(presences, hostId, sessionUri)].sort(), ['http://localhost:5173', 'https://mac.ts.net']);
});

test('без присутствия и с пустым origin подавлять нечего', () => {
  assert.equal(visibleOrigins([], hostId, sessionUri).size, 0);
  assert.equal(visibleOrigins([{ origin: '', visible: true, selection: { hostId, sessionUri } }], hostId, sessionUri).size, 0);
  assert.equal(visibleOrigins([{ origin: 'https://mac.ts.net', visible: false }], hostId, sessionUri).size, 0);
});
