import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TerminalClaimKind, type TerminalInfo } from '@microsoft/agent-host-protocol';
import { DEFAULT_TERMINAL_IDLE_MS, evictionCandidate, terminalCleanupPlan, terminalIdleMs } from './terminal-cleanup.js';

const now = 1_000_000;
const thresholdMs = 60_000;
const clientId = 'backend-client';
type TerminalRef = Pick<TerminalInfo, 'resource' | 'claim'>;

const own = (name: string): TerminalRef => ({
  resource: `ahp-terminal:/${name}`, claim: { kind: TerminalClaimKind.Client, clientId },
});
const foreign = (name: string): TerminalRef => ({
  resource: `ahp-terminal:/${name}`, claim: { kind: TerminalClaimKind.Client, clientId: 'other-device' },
});
const agent = (name: string): TerminalRef => ({
  resource: `ahp-terminal:/${name}`,
  claim: { kind: TerminalClaimKind.Session, session: 'ahp-session:/s', chat: 'ahp-chat:/c' },
});

test('порог автоочистки разбирается на старте и не принимает опечатки', () => {
  assert.equal(terminalIdleMs(undefined), DEFAULT_TERMINAL_IDLE_MS);
  assert.equal(terminalIdleMs('  '), DEFAULT_TERMINAL_IDLE_MS);
  assert.equal(terminalIdleMs('120000'), 120_000);
  assert.throws(() => terminalIdleMs('59999'), /ACC_TERMINAL_IDLE_MS/);
  assert.throws(() => terminalIdleMs('30m'), /ACC_TERMINAL_IDLE_MS/);
});

test('свой терминал без наблюдателей дольше порога попадает в план, свежий — нет', () => {
  const terminals = [own('old'), own('fresh')];
  const plan = terminalCleanupPlan({
    now, thresholdMs, terminals, clientId,
    watched: () => false,
    seenAt: uri => (uri.endsWith('/old') ? now - thresholdMs - 1 : now - 1000),
  });
  assert.deepEqual(plan, ['ahp-terminal:/old']);
});

test('наблюдаемый терминал и терминал агента автоочистка не трогает никогда', () => {
  const terminals = [own('watched'), agent('agent')];
  const plan = terminalCleanupPlan({
    now, thresholdMs, terminals, clientId,
    watched: uri => uri.endsWith('/watched'),
    seenAt: () => now - thresholdMs * 10,
  });
  assert.deepEqual(plan, [], 'у агентского терминала другой claim');
});

test('чужие терминалы и терминалы без записи времени не закрываются', () => {
  const terminals = [foreign('other'), own('unknown'), agent('agent')];
  const plan = terminalCleanupPlan({
    now, thresholdMs, terminals, clientId,
    watched: () => false,
    seenAt: uri => (uri.endsWith('/unknown') ? undefined : now - thresholdMs * 2),
  });
  assert.deepEqual(plan, []);
});

test('на границе порога терминал считается брошенным', () => {
  const plan = terminalCleanupPlan({
    now, thresholdMs, terminals: [own('edge')], clientId,
    watched: () => false,
    seenAt: () => now - thresholdMs,
  });
  assert.deepEqual(plan, ['ahp-terminal:/edge']);
});

test('при лимите вытесняется старейший свой терминал без наблюдателей', () => {
  const terminals = [own('a'), own('b'), own('c'), agent('agent'), foreign('foreign')];
  const since: Record<string, number> = {
    'ahp-terminal:/a': now - 5000,
    'ahp-terminal:/b': now - 9000,
    'ahp-terminal:/c': now - 1000,
  };
  const uri = evictionCandidate(terminals, {
    clientId,
    watched: candidate => candidate.endsWith('/c'),
    seenAt: candidate => since[candidate],
  });
  assert.equal(uri, 'ahp-terminal:/b');
});

test('если все свои терминалы наблюдаются, вытеснять некого', () => {
  const terminals = [own('a'), own('b')];
  assert.equal(evictionCandidate(terminals, { clientId, watched: () => true, seenAt: () => 0 }), undefined);
});
