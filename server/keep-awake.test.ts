import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepAwakeArgs, startKeepAwake, type KeepAwakeChild } from './keep-awake.js';

class FakeCaffeinate implements KeepAwakeChild {
  readonly signals: NodeJS.Signals[] = [];
  private errorListener?: (error: Error) => void;

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }

  once(_event: 'error', listener: (error: Error) => void): this {
    this.errorListener = listener;
    return this;
  }

  fail(message: string): void {
    this.errorListener?.(new Error(message));
  }
}

test('аргументы: только macOS, без -d и без pmset', () => {
  assert.deepEqual(keepAwakeArgs(123, 'darwin'), ['-i', '-m', '-s', '-w', '123']);
  assert.equal(keepAwakeArgs(123, 'linux'), undefined);
  assert.equal(keepAwakeArgs(123, 'win32'), undefined);
  assert.ok(!keepAwakeArgs(123, 'darwin')?.includes('-d'));
});

test('startKeepAwake запускает caffeinate с pid супервизора и останавливает SIGTERM', () => {
  const child = new FakeCaffeinate();
  const calls: { command: string; args: readonly string[]; options: { stdio: 'ignore' } }[] = [];
  const logs: string[] = [];
  const keepAwake = startKeepAwake({
    platform: 'darwin', pid: 999, log: line => logs.push(line),
    spawn: (command, args, options) => { calls.push({ command, args, options }); return child; },
  });
  assert.ok(keepAwake);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, '/usr/bin/caffeinate');
  assert.deepEqual(calls[0]!.args, ['-i', '-m', '-s', '-w', '999']);
  assert.equal(calls[0]!.options.stdio, 'ignore');
  keepAwake?.stop();
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.deepEqual(logs, []);
});

test('startKeepAwake: не-darwin и ошибка spawn — предупреждение, не падение', () => {
  const logs: string[] = [];
  assert.equal(startKeepAwake({ platform: 'linux', pid: 1, spawn: () => { throw new Error('нет'); }, log: line => logs.push(line) }), undefined);
  assert.ok(logs.some(line => line.includes('только на macOS')), logs.join('\n'));

  logs.length = 0;
  assert.equal(startKeepAwake({ platform: 'darwin', pid: 1, spawn: () => { throw new Error('нет'); }, log: line => logs.push(line) }), undefined);
  assert.ok(logs.some(line => line.includes('caffeinate')), logs.join('\n'));
});

test('ошибка caffeinate после запуска попадает в лог', () => {
  const child = new FakeCaffeinate();
  const logs: string[] = [];
  startKeepAwake({ platform: 'darwin', pid: 1, spawn: () => child, log: line => logs.push(line) });
  child.fail('killed');
  assert.ok(logs.some(line => line.includes('killed')), logs.join('\n'));
});
