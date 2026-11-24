import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTOSTART_LABEL, AUTOSTART_MARKER, defaultLaunchdDeps, escapeXml, installLaunchdJob, launchdJobInfo,
  launchdSpec, launchdStatus, renderPlist, uninstallLaunchdJob,
  type CommandResult, type JobInfo, type LaunchdDeps, type LaunchdFs, type LaunchdRun, type LaunchdSpec,
} from './launchd.js';

const spec: LaunchdSpec = {
  label: AUTOSTART_LABEL,
  programArguments: ['/opt/node/bin/node', '--import', 'tsx', '/project/scripts/up.ts', '--supervised'],
  workingDirectory: '/project',
  path: '/opt/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  stdoutPath: '/project/.local/up.log',
  stderrPath: '/project/.local/up.log',
  throttleIntervalSec: 30,
};

const plistPath = `/Users/test/Library/LaunchAgents/${AUTOSTART_LABEL}.plist`;

class FakeFs implements LaunchdFs {
  readonly files = new Map<string, string>();
  readonly modes = new Map<string, number>();
  readonly ops: string[] = [];

  async read(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async write(path: string, data: string, mode: number): Promise<void> {
    this.files.set(path, data);
    this.modes.set(path, mode);
    this.ops.push(`write:${path}`);
  }

  async rename(from: string, to: string): Promise<void> {
    const data = this.files.get(from);
    if (data === undefined) throw new Error(`rename: нет ${from}`);
    this.files.delete(from);
    this.files.set(to, data);
    this.modes.set(to, this.modes.get(from) ?? 0o600);
    this.ops.push(`rename:${from}->${to}`);
  }

  async unlink(path: string): Promise<void> {
    this.files.delete(path);
    this.ops.push(`unlink:${path}`);
  }

  async mkdir(path: string): Promise<void> {
    this.ops.push(`mkdir:${path}`);
  }
}

class FakeMac {
  readonly fs = new FakeFs();
  readonly commands: string[] = [];
  readonly ops: string[] = [];
  readonly alive = new Set<number>();
  readonly busy = new Set<number>();
  portChecks = 0;
  job: JobInfo = { loaded: false };
  lintFails = false;
  bootoutKeepsJob = false;
  readonly deps: LaunchdDeps;

  constructor() {
    const run: LaunchdRun = async (command, args) => this.run(command, args);
    this.deps = defaultLaunchdDeps({
      fs: this.fs, run, wait: async () => undefined, uid: 501, jobWaitMs: 0, portWaitMs: 0,
    });
  }

  private async run(command: string, args: readonly string[]): Promise<CommandResult> {
    this.commands.push([command, ...args].join(' '));
    this.ops.push(`cmd:${command}:${args[0]}`);
    this.fs.ops.push(`cmd:${command}:${args[0]}`);
    if (command === '/usr/bin/plutil') {
      return this.lintFails ? { code: 1, stdout: '', stderr: 'invalid plist' } : { code: 0, stdout: '', stderr: '' };
    }
    switch (args[0]) {
      case 'print':
        if (!this.job.loaded) return { code: 113, stdout: '', stderr: 'Could not find service' };
        return {
          code: 0, stderr: '',
          stdout: `gui/501/${AUTOSTART_LABEL} = {\n\tstate = ${this.job.state ?? 'not running'}\n${this.job.pid ? `\tpid = ${this.job.pid}\n` : ''}${this.job.lastExitCode !== undefined ? `\tlast exit code = ${this.job.lastExitCode}\n` : ''}}`,
        };
      case 'bootout':
        if (!this.bootoutKeepsJob) this.job = { loaded: false };
        return { code: 0, stdout: '', stderr: '' };
      case 'bootstrap':
        this.job = { loaded: true, state: 'running', pid: 456 };
        return { code: 0, stdout: '', stderr: '' };
      case 'kickstart':
        this.job = { ...this.job, loaded: true, state: 'running', pid: 789 };
        return { code: 0, stdout: '', stderr: '' };
      case 'enable':
        return { code: 0, stdout: '', stderr: '' };
      default:
        return { code: 1, stdout: '', stderr: `неизвестная команда ${args[0]}` };
    }
  }

  portFree = async (port: number): Promise<boolean> => {
    this.portChecks += 1;
    return !this.busy.has(port);
  };

  isAlive = (pid: number): boolean => this.alive.has(pid);
}

function install(mac: FakeMac, options: { force?: boolean; plist?: string } = {}) {
  return installLaunchdJob({
    spec, plistPath: options.plist ?? plistPath, force: options.force ?? false, deps: mac.deps,
  });
}

test('renderPlist: все ключи, PATH, аргументы и отсутствие секретов', () => {
  const plist = renderPlist(spec);
  for (const fragment of [
    '<key>Label</key>', AUTOSTART_LABEL, '<key>ProgramArguments</key>', '--supervised',
    '<key>WorkingDirectory</key>', '/project',
    '<key>EnvironmentVariables</key>', '<key>PATH</key>', '/opt/node/bin',
    '<key>RunAtLoad</key>', '<key>KeepAlive</key>', '<key>SuccessfulExit</key>', '<key>ThrottleInterval</key>',
    '<key>StandardOutPath</key>', '/project/.local/up.log', '<key>Umask</key>', '63',
    AUTOSTART_MARKER,
  ]) assert.ok(plist.includes(fragment), fragment);
  assert.ok(!plist.includes('API_KEY'));
  assert.ok(!plist.includes('BASE_URL'));
  assert.ok(!plist.includes('TOKEN'));
});

test('escapeXml экранирует спецсимволы', () => {
  assert.equal(escapeXml(`a&b<c>"d"'e'`), 'a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;');
});

test('install: lint до rename, bootstrap, режим 0600 и запуск', async () => {
  const mac = new FakeMac();
  const result = await install(mac);
  assert.equal(result.changed, true);
  assert.equal(result.running, true);
  assert.equal(mac.fs.modes.get(plistPath), 0o600);
  assert.equal(mac.fs.files.get(plistPath), renderPlist(spec));
  const lintAt = mac.fs.ops.findIndex(op => op === 'cmd:/usr/bin/plutil:-lint');
  const renameAt = mac.fs.ops.indexOf(`rename:${plistPath}.tmp->${plistPath}`);
  const bootstrapAt = mac.fs.ops.indexOf('cmd:/bin/launchctl:bootstrap');
  assert.ok(lintAt !== -1 && lintAt < renameAt && renameAt < bootstrapAt, mac.fs.ops.join('\n'));
  assert.ok(mac.commands.some(command => command.includes(`bootstrap gui/501 ${plistPath}`)), mac.commands.join('\n'));
});

test('install: одинаковый plist и running — no-op', async () => {
  const mac = new FakeMac();
  await install(mac);
  mac.commands.length = 0;
  mac.fs.ops.length = 0;
  const second = await install(mac);
  assert.equal(second.changed, false);
  assert.equal(second.running, true);
  assert.deepEqual(mac.fs.ops, ['cmd:/bin/launchctl:print']);
  assert.deepEqual(mac.commands, [`/bin/launchctl print gui/501/${AUTOSTART_LABEL}`]);
});

test('install: загружен, но не running — kickstart без -k', async () => {
  const mac = new FakeMac();
  mac.fs.files.set(plistPath, renderPlist(spec));
  mac.job = { loaded: true, state: 'not running' };
  const result = await install(mac);
  assert.equal(result.changed, false);
  assert.equal(result.running, true);
  assert.ok(mac.commands.includes(`/bin/launchctl kickstart gui/501/${AUTOSTART_LABEL}`));
  assert.ok(!mac.commands.some(command => command.includes('kickstart -k')), mac.commands.join('\n'));
  assert.ok(!mac.commands.some(command => command.includes('bootstrap')));
});

test('install: plist есть, job не загружен — enable и bootstrap', async () => {
  const mac = new FakeMac();
  mac.fs.files.set(plistPath, renderPlist(spec));
  const result = await install(mac);
  assert.equal(result.changed, false);
  assert.equal(result.running, true);
  assert.ok(mac.commands.some(command => command.includes('enable gui/501')));
  assert.ok(mac.commands.some(command => command.includes('bootstrap gui/501')));
});

test('install: другой plist у загруженного job — bootout до rename', async () => {
  const mac = new FakeMac();
  mac.fs.files.set(plistPath, `<?xml old><!-- ${AUTOSTART_MARKER} -->`);
  mac.job = { loaded: true, state: 'running', pid: 111 };
  const result = await install(mac, { force: true });
  assert.equal(result.changed, true);
  const bootoutAt = mac.fs.ops.indexOf('cmd:/bin/launchctl:bootout');
  const renameAt = mac.fs.ops.indexOf(`rename:${plistPath}.tmp->${plistPath}`);
  const bootstrapAt = mac.fs.ops.indexOf('cmd:/bin/launchctl:bootstrap');
  assert.ok(bootoutAt !== -1 && bootoutAt < renameAt && renameAt < bootstrapAt, mac.fs.ops.join('\n'));
  assert.equal(mac.fs.files.get(plistPath), renderPlist(spec));
});

test('install: изменённый plist при работающем job — без --force ничего не трогает', async () => {
  const mac = new FakeMac();
  const old = `<?xml old><!-- ${AUTOSTART_MARKER} -->`;
  mac.fs.files.set(plistPath, old);
  mac.job = { loaded: true, state: 'running', pid: 111 };
  const result = await install(mac);
  assert.equal(result.changed, false);
  assert.equal(result.running, true);
  assert.equal(result.refused, true);
  assert.equal(mac.fs.files.get(plistPath), old, 'plist не изменён');
  assert.ok(!mac.commands.some(command => command.includes('bootout')), mac.commands.join('\n'));
  assert.ok(result.messages.some(message => message.includes('--force') && message.includes('активные ходы')), result.messages.join('\n'));
});

test('install: plist удалён вручную, но job загружен — bootout и новая установка', async () => {
  const mac = new FakeMac();
  mac.job = { loaded: true, state: 'running', pid: 111 };
  const result = await install(mac);
  assert.equal(result.changed, true);
  assert.equal(result.running, true);
  assert.ok(mac.fs.ops.indexOf('cmd:/bin/launchctl:bootout') < mac.fs.ops.indexOf(`rename:${plistPath}.tmp->${plistPath}`));
});

test('install: чужой plist без --force отклоняется, с --force заменяется', async () => {
  const mac = new FakeMac();
  mac.fs.files.set(plistPath, '<?xml чужой>');
  await assert.rejects(install(mac), /создан не этой командой/);
  assert.equal(mac.fs.files.get(plistPath), '<?xml чужой>');
  const forced = await install(mac, { force: true });
  assert.equal(forced.changed, true);
  assert.equal(mac.fs.files.get(plistPath), renderPlist(spec));
});

test('install: невалидный plist не попадает на место рабочего', async () => {
  const mac = new FakeMac();
  mac.lintFails = true;
  await assert.rejects(install(mac), /plutil -lint/);
  assert.equal(mac.fs.files.has(plistPath), false);
  assert.equal(mac.fs.files.has(`${plistPath}.tmp`), false);
  assert.ok(!mac.commands.some(command => command.includes('bootstrap')));
});

test('uninstall: bootout, удаление plist, ожидание портов', async () => {
  const mac = new FakeMac();
  await install(mac);
  mac.job = { loaded: true, state: 'running', pid: 777 };
  const result = await uninstallLaunchdJob({
    plistPath, deps: mac.deps, ports: [{ port: 8089, host: '127.0.0.1' }],
    portFree: mac.portFree, isAlive: mac.isAlive,
  });
  assert.equal(result.changed, true);
  assert.ok(mac.commands.some(command => command.includes('bootout')));
  assert.equal(mac.fs.files.has(plistPath), false);
  assert.equal(mac.portChecks, 1);
  assert.ok(result.messages.some(message => message.includes('порты свободны')) || result.messages.some(message => message.includes('Порты свободны')));
});

test('uninstall: job не исчез — ошибка, plist остаётся', async () => {
  const mac = new FakeMac();
  await install(mac);
  mac.job = { loaded: true, state: 'running', pid: 777 };
  mac.bootoutKeepsJob = true;
  await assert.rejects(uninstallLaunchdJob({
    plistPath, deps: mac.deps, ports: [], portFree: mac.portFree, isAlive: mac.isAlive,
  }), /не выгрузился/);
  assert.equal(mac.fs.files.has(plistPath), true);
});

test('uninstall: pid up ещё жив — ошибка, plist остаётся', async () => {
  const mac = new FakeMac();
  await install(mac);
  mac.job = { loaded: true, state: 'running', pid: 777 };
  mac.alive.add(777);
  await assert.rejects(uninstallLaunchdJob({
    plistPath, deps: mac.deps, ports: [], portFree: mac.portFree, isAlive: mac.isAlive,
  }), /ещё жив/);
  assert.equal(mac.fs.files.has(plistPath), true);
});

test('uninstall: занятые порты — ошибка с lsof, автозапуск уже снят', async () => {
  const mac = new FakeMac();
  await install(mac);
  mac.job = { loaded: true, state: 'running', pid: 777 };
  mac.busy.add(8089);
  await assert.rejects(uninstallLaunchdJob({
    plistPath, deps: mac.deps, ports: [{ port: 8089, host: '127.0.0.1' }],
    portFree: mac.portFree, isAlive: mac.isAlive,
  }), /порты всё ещё заняты: 8089.*lsof/);
  assert.equal(mac.fs.files.has(plistPath), false);
});

test('uninstall: нет plist и job — no-op без проверки портов', async () => {
  const mac = new FakeMac();
  const result = await uninstallLaunchdJob({
    plistPath, deps: mac.deps, ports: [{ port: 8089, host: '127.0.0.1' }],
    portFree: mac.portFree, isAlive: mac.isAlive,
  });
  assert.equal(result.changed, false);
  assert.equal(mac.portChecks, 0);
});

test('uninstall: чужой plist без --force отклоняется', async () => {
  const mac = new FakeMac();
  mac.fs.files.set(plistPath, 'чужой');
  await assert.rejects(uninstallLaunchdJob({
    plistPath, deps: mac.deps, ports: [], portFree: mac.portFree, isAlive: mac.isAlive,
  }), /создан не этой командой/);
  assert.equal(mac.fs.files.get(plistPath), 'чужой');
});

test('status: plist, lint и job', async () => {
  const mac = new FakeMac();
  await install(mac);
  const status = await launchdStatus({ plistPath, deps: mac.deps });
  assert.equal(status.plistExists, true);
  assert.equal(status.ours, true);
  assert.equal(status.lint?.ok, true);
  assert.equal(status.job.loaded, true);
  assert.equal(status.job.state, 'running');
  assert.equal(status.job.pid, 456);
});

test('launchdSpec: entrypoint без npm, PATH, логи, keep-awake и отсутствие секретов', () => {
  const built = launchdSpec({ projectRoot: '/project', execPath: '/opt/node/bin/node', keepAwake: true });
  assert.deepEqual(built.programArguments, [
    '/opt/node/bin/node', '--import', 'tsx', '/project/scripts/up.ts', '--supervised', '--keep-awake',
  ]);
  assert.equal(built.workingDirectory, '/project');
  assert.equal(built.path, '/opt/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(built.stdoutPath, '/project/.local/up.log');
  assert.equal(built.stderrPath, '/project/.local/up.log');
  assert.equal(built.throttleIntervalSec, 30);
  const plist = renderPlist(built);
  assert.ok(!plist.includes('API_KEY') && !plist.includes('BASE_URL'));
  const off = launchdSpec({ projectRoot: '/project', execPath: '/opt/node/bin/node', keepAwake: false });
  assert.deepEqual(off.programArguments.slice(-1), ['--supervised']);
});

test('status: matchesSpec ловит смену пути node в plist', async () => {
  const mac = new FakeMac();
  await install(mac);
  const current = await launchdStatus({ plistPath, deps: mac.deps, spec });
  assert.equal(current.matchesSpec, true);
  const moved: LaunchdSpec = {
    ...spec,
    programArguments: ['/nvm/versions/node/v22/bin/node', ...spec.programArguments.slice(1)],
    path: '/nvm/versions/node/v22/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  };
  const stale = await launchdStatus({ plistPath, deps: mac.deps, spec: moved });
  assert.equal(stale.matchesSpec, false);
});

test('launchdJobInfo: незагруженный job и разбор last exit code', async () => {
  const mac = new FakeMac();
  assert.deepEqual(await launchdJobInfo(AUTOSTART_LABEL, mac.deps), { loaded: false });
  mac.job = { loaded: true, state: 'not running', lastExitCode: 75 };
  const info = await launchdJobInfo(AUTOSTART_LABEL, mac.deps);
  assert.equal(info.loaded, true);
  assert.equal(info.state, 'not running');
  assert.equal(info.lastExitCode, 75);
});
