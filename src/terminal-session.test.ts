import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TerminalClaimKind, TerminalLifecycleStatus, type TerminalState } from '@microsoft/agent-host-protocol';
import {
  forgetSelectedTerminal, forgetTerminalLabel, lastTerminalForm, nextTerminalLabel,
  rememberAutoTerminalLabel, rememberCreatedTerminalLabel, rememberLastTerminalForm,
  rememberManualTerminalLabel, rememberSelectedTerminal, selectedTerminal, skipTerminalAutoLabel,
  terminalCommandLabel, terminalCwd, terminalLabel, terminalLabelBase, terminalLabelRecord,
  terminalRowLabels, terminalStateHasCommands, terminalStatusText,
} from './terminal-session.js';

interface TestStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  data: Record<string, string>;
}

function storage(initial: Record<string, string> = {}): TestStorage {
  const data = { ...initial };
  return { data, getItem: key => (Object.hasOwn(data, key) ? data[key]! : null), setItem: (key, value) => { data[key] = value; } };
}

/** Хранилище с удалением: так ведёт себя `localStorage` в браузере. */
function removableStorage(initial: Record<string, string> = {}): TestStorage & { removeItem(key: string): void } {
  const data = { ...initial };
  return {
    data,
    getItem: key => (Object.hasOwn(data, key) ? data[key]! : null),
    setItem: (key, value) => { data[key] = value; },
    removeItem: key => { delete data[key]; },
  };
}

const labelKey = (hostId: string, uri: string): string => `acc.terminals.v3.label:${encodeURIComponent(hostId)}:${encodeURIComponent(uri)}`;
const TERMINAL = 'ahp-terminal:/one';
const TERMINAL_TWO = 'ahp-terminal:/two';

const state = (lifecycle: TerminalState['lifecycle']): TerminalState => ({
  title: 'Терминал',
  content: [],
  lifecycle,
  claim: { kind: TerminalClaimKind.Client, clientId: 'backend' },
});

test('выбранный терминал хранится как hostId+URI и переживает roundtrip', () => {
  const store = storage();
  assert.equal(selectedTerminal(store), undefined);
  rememberSelectedTerminal(store, 'mac', 'ahp-terminal:/one');
  assert.deepEqual(selectedTerminal(store), { hostId: 'mac', uri: 'ahp-terminal:/one' });
  rememberSelectedTerminal(store, 'other', 'ahp-terminal:/two');
  assert.deepEqual(selectedTerminal(store), { hostId: 'other', uri: 'ahp-terminal:/two' }, 'запоминается последний выбор');
});

test('мусор, пустой hostId и не терминальный URI игнорируются', () => {
  assert.equal(selectedTerminal(storage({ 'acc.terminals.v2.selected': '{' })), undefined);
  assert.equal(selectedTerminal(storage({ 'acc.terminals.v2.selected': '[1,2]' })), undefined);
  assert.equal(selectedTerminal(storage({ 'acc.terminals.v2.selected': JSON.stringify({ hostId: '', uri: 'ahp-terminal:/one' }) })), undefined);
  assert.equal(selectedTerminal(storage({ 'acc.terminals.v2.selected': JSON.stringify({ uri: 'ahp-terminal:/one' }) })), undefined);
  assert.equal(selectedTerminal(storage({ 'acc.terminals.v2.selected': JSON.stringify({ hostId: 'mac', uri: 'https://example.test' }) })), undefined);

  const store = storage();
  rememberSelectedTerminal(store, '', 'ahp-terminal:/one');
  rememberSelectedTerminal(store, 'mac', 'https://example.test');
  assert.equal(selectedTerminal(store), undefined, 'невалидное значение не записывается');
});

test('forgetSelectedTerminal забывает выбор', () => {
  const store = storage();
  rememberSelectedTerminal(store, 'mac', 'ahp-terminal:/one');
  forgetSelectedTerminal(store);
  assert.equal(selectedTerminal(store), undefined);
});

test('форма v2 переживает roundtrip, а до неё читается последняя пара старой версии', () => {
  const store = storage();
  assert.equal(lastTerminalForm(store), undefined);
  rememberLastTerminalForm(store, 'mac', '/work/src');
  assert.deepEqual(lastTerminalForm(store), { hostId: 'mac', directory: '/work/src' });
  // v2 важнее старой пары: миграция одноразовая и не перетирает новый выбор.
  store.data['acc.terminals.v1.last'] = JSON.stringify({ hostId: 'old', directory: '/tmp' });
  assert.deepEqual(lastTerminalForm(store), { hostId: 'mac', directory: '/work/src' });

  const legacy = storage({ 'acc.terminals.v1.last': JSON.stringify({ hostId: 'old', directory: '/tmp' }) });
  assert.deepEqual(lastTerminalForm(legacy), { hostId: 'old', directory: '/tmp' });
  assert.equal(lastTerminalForm(storage({ 'acc.terminals.v1.last': '{' })), undefined);
  assert.equal(lastTerminalForm(storage({ 'acc.terminals.v2.form': JSON.stringify({ hostId: 'mac' }) })), undefined, 'без папки форма бесполезна');
  assert.equal(lastTerminalForm(storage({ 'acc.terminals.v2.form': JSON.stringify({ hostId: '', directory: '/work' }) })), undefined);
});

test('фактический cwd берётся из состояния, а не из поля формы', () => {
  assert.equal(terminalCwd(state({ status: TerminalLifecycleStatus.Running }), '/requested'), '/requested');
  assert.equal(terminalCwd({ ...state({ status: TerminalLifecycleStatus.Running }), cwd: 'file:///Users/me/project' }, '/requested'), '/Users/me/project');
  assert.equal(terminalCwd({ ...state({ status: TerminalLifecycleStatus.Running }), cwd: 'file:///Users/%D0%BC%D0%B5' }, '/'), '/Users/ме');
});

test('статус жизненного цикла: выполняется, завершён с кодом и без', () => {
  assert.equal(terminalStatusText(undefined), 'подключаемся…');
  assert.equal(terminalStatusText({ status: TerminalLifecycleStatus.Running }), 'выполняется');
  assert.equal(terminalStatusText({ status: TerminalLifecycleStatus.Exited, exitCode: 7 }), 'завершён · код 7');
  assert.equal(terminalStatusText({ status: TerminalLifecycleStatus.Exited, exitCode: 0 }), 'завершён · код 0');
  assert.equal(terminalStatusText({ status: TerminalLifecycleStatus.Exited }), 'завершён');
});

test('имя, выданное при создании, хранится по адресу и ждёт первую команду', () => {
  const store = storage();
  assert.equal(terminalLabel(store, 'mac', TERMINAL), undefined);
  rememberCreatedTerminalLabel(store, 'mac', TERMINAL, 'workspace');
  assert.equal(terminalLabel(store, 'mac', TERMINAL), 'workspace');
  assert.deepEqual(terminalLabelBase(store, 'mac', TERMINAL), { kind: 'created', title: 'workspace' });

  rememberCreatedTerminalLabel(store, 'mac', TERMINAL, 'other');
  assert.equal(terminalLabel(store, 'mac', TERMINAL), 'workspace', 'повторное создание не перетирает адрес');

  rememberCreatedTerminalLabel(store, '', TERMINAL, 'x');
  rememberCreatedTerminalLabel(store, 'mac', 'https://example.test', 'x');
  rememberCreatedTerminalLabel(store, 'mac', TERMINAL_TWO, '');
  assert.equal(terminalLabelRecord(store, '', TERMINAL), undefined);
  assert.equal(terminalLabelRecord(store, 'mac', TERMINAL_TWO), undefined, 'невалидные адреса и пустое имя не пишутся');
});

test('автоимя из первой команды одноразовое и пишется только поверх ожидания', () => {
  const store = storage();
  assert.equal(rememberAutoTerminalLabel(store, 'mac', TERMINAL, 'echo first'), false, 'без записи создания нет адреса');

  rememberCreatedTerminalLabel(store, 'mac', TERMINAL, 'workspace');
  assert.equal(rememberAutoTerminalLabel(store, 'mac', TERMINAL, 'echo first'), true);
  assert.deepEqual(terminalLabelBase(store, 'mac', TERMINAL), { kind: 'auto', title: 'echo first' });
  assert.equal(terminalLabel(store, 'mac', TERMINAL), 'echo first');

  assert.equal(rememberAutoTerminalLabel(store, 'mac', TERMINAL, 'echo second'), false, 'вторая команда имя не меняет');
  assert.equal(terminalLabel(store, 'mac', TERMINAL), 'echo first');
});

test('ручное имя до команды блокирует автоимя, даже если совпадает с дефолтом', () => {
  const store = storage();
  rememberCreatedTerminalLabel(store, 'mac', TERMINAL, 'workspace');
  rememberManualTerminalLabel(store, 'mac', TERMINAL, 'сборка');
  assert.deepEqual(terminalLabelRecord(store, 'mac', TERMINAL), {
    base: { kind: 'skipped', title: 'workspace' },
    manual: 'сборка',
  });
  assert.equal(rememberAutoTerminalLabel(store, 'mac', TERMINAL, 'echo first'), false);
  assert.equal(skipTerminalAutoLabel(store, 'mac', TERMINAL), false);
  assert.equal(terminalLabel(store, 'mac', TERMINAL), 'сборка');

  const same = storage();
  rememberCreatedTerminalLabel(same, 'mac', TERMINAL, 'workspace');
  rememberManualTerminalLabel(same, 'mac', TERMINAL, 'workspace');
  assert.equal(rememberAutoTerminalLabel(same, 'mac', TERMINAL, 'echo first'), false, 'явное сохранение сильнее автоимени');
  assert.equal(terminalLabel(same, 'mac', TERMINAL), 'workspace');
  assert.equal(terminalLabelBase(same, 'mac', TERMINAL)?.kind, 'skipped');
});

test('ручное имя после авто удаляет текст команды из хранилища', () => {
  const store = storage();
  rememberCreatedTerminalLabel(store, 'mac', TERMINAL, 'workspace');
  rememberAutoTerminalLabel(store, 'mac', TERMINAL, 'export GITHUB_TOKEN=ghp_secret_value');
  rememberManualTerminalLabel(store, 'mac', TERMINAL, 'сборка');
  assert.deepEqual(terminalLabelRecord(store, 'mac', TERMINAL), { manual: 'сборка' });
  assert.equal(terminalLabel(store, 'mac', TERMINAL), 'сборка');
  const raw = Object.entries(store.data).filter(([key]) => key.startsWith('acc.terminals.v3.label:')).map(([, value]) => value).join('\n');
  assert.equal(raw.includes('ghp_secret_value'), false, 'старая команда не остаётся рядом с ручным именем');
});

test('ручное имя без записи создания сохраняется и не перетирается созданием', () => {
  const store = storage();
  rememberManualTerminalLabel(store, 'mac', TERMINAL, 'api');
  assert.deepEqual(terminalLabelRecord(store, 'mac', TERMINAL), { manual: 'api' });
  rememberCreatedTerminalLabel(store, 'mac', TERMINAL, 'workspace');
  assert.equal(terminalLabel(store, 'mac', TERMINAL), 'api');
});

test('skip фиксирует дефолт и не трогает auto, manual или отсутствующую запись', () => {
  const store = storage();
  assert.equal(skipTerminalAutoLabel(store, 'mac', TERMINAL), false);
  rememberCreatedTerminalLabel(store, 'mac', TERMINAL, 'workspace');
  assert.equal(skipTerminalAutoLabel(store, 'mac', TERMINAL), true);
  assert.deepEqual(terminalLabelBase(store, 'mac', TERMINAL), { kind: 'skipped', title: 'workspace' });
  assert.equal(rememberAutoTerminalLabel(store, 'mac', TERMINAL, 'echo first'), false);

  rememberManualTerminalLabel(store, 'mac', TERMINAL_TWO, 'api');
  assert.equal(skipTerminalAutoLabel(store, 'mac', TERMINAL_TWO), false);
  assert.equal(terminalLabel(store, 'mac', TERMINAL_TWO), 'api');
});

test('адресные записи не перетирают соседние PTY и хосты', () => {
  const store = storage();
  rememberCreatedTerminalLabel(store, 'mac', TERMINAL, 'workspace');
  rememberCreatedTerminalLabel(store, 'mac', TERMINAL_TWO, 'workspace 2');
  rememberCreatedTerminalLabel(store, 'glm', TERMINAL, 'workspace');

  assert.equal(rememberAutoTerminalLabel(store, 'mac', TERMINAL, 'echo one'), true);
  rememberManualTerminalLabel(store, 'glm', TERMINAL, 'удалённый');

  assert.equal(terminalLabel(store, 'mac', TERMINAL), 'echo one');
  assert.equal(terminalLabel(store, 'mac', TERMINAL_TWO), 'workspace 2');
  assert.equal(terminalLabel(store, 'glm', TERMINAL), 'удалённый');
  assert.deepEqual(terminalLabelBase(store, 'mac', TERMINAL_TWO), { kind: 'created', title: 'workspace 2' });
});

test('старая карта v2 читается как fallback, ручное имя её перекрывает', () => {
  const store = storage({
    'acc.terminals.v2.labels': JSON.stringify({
      [TERMINAL]: 'legacy',
      [TERMINAL_TWO]: 'legacy two',
      'https://example.test': 'чужое',
      'ahp-terminal:/empty': '',
    }),
  });
  assert.equal(terminalLabel(store, 'mac', TERMINAL), 'legacy');
  assert.equal(terminalLabel(store, 'mac', 'ahp-terminal:/unknown'), undefined);

  rememberManualTerminalLabel(store, 'mac', TERMINAL, 'manual');
  assert.equal(terminalLabel(store, 'mac', TERMINAL), 'manual');
  assert.equal(terminalLabel(store, 'mac', TERMINAL_TWO), 'legacy two', 'соседняя старая подпись не потеряна');
  assert.equal(terminalLabel(storage({ 'acc.terminals.v2.labels': '{' }), 'mac', TERMINAL), undefined);
});

test('битые записи игнорируются, а валидная часть записи остаётся', () => {
  const broken = storage({ [labelKey('mac', TERMINAL)]: '{' });
  assert.equal(terminalLabelRecord(broken, 'mac', TERMINAL), undefined);
  assert.equal(terminalLabel(broken, 'mac', TERMINAL), undefined);

  const array = storage({ [labelKey('mac', TERMINAL)]: '[]' });
  assert.equal(terminalLabelRecord(array, 'mac', TERMINAL), undefined);

  const badKind = storage({ [labelKey('mac', TERMINAL)]: JSON.stringify({ base: { kind: 'other', title: 'x' } }) });
  assert.equal(terminalLabelRecord(badKind, 'mac', TERMINAL), undefined);

  const empty = storage({ [labelKey('mac', TERMINAL)]: JSON.stringify({ base: { kind: 'auto', title: '' }, manual: '' }) });
  assert.equal(terminalLabelRecord(empty, 'mac', TERMINAL), undefined);

  const partial = storage({ [labelKey('mac', TERMINAL)]: JSON.stringify({ base: { kind: 'auto', title: 'echo x' }, manual: '' }) });
  assert.deepEqual(terminalLabelRecord(partial, 'mac', TERMINAL), { base: { kind: 'auto', title: 'echo x' } });
  assert.equal(terminalLabel(partial, 'mac', TERMINAL), 'echo x');
});

test('имя нового PTY нумеруется в пределах папки', () => {
  assert.equal(nextTerminalLabel('workspace', []), 'workspace');
  assert.equal(nextTerminalLabel('workspace', ['workspace']), 'workspace 2');
  assert.equal(nextTerminalLabel('workspace', ['workspace', 'workspace 2']), 'workspace 3');
  assert.equal(nextTerminalLabel('workspace', ['workspace 2']), 'workspace', 'свободное имя переиспользуется');
  assert.equal(nextTerminalLabel('workspace', ['src']), 'workspace');
});

test('одинаковые подписи различимы хвостом URI, сохранённое имя важнее title хоста', () => {
  const labels = new Map([
    ['ahp-terminal:/a', 'workspace'],
    ['ahp-terminal:/b', 'workspace 2'],
  ]);
  const labelOf = (_hostId: string, uri: string) => labels.get(uri);
  assert.deepEqual(terminalRowLabels([
    { hostId: 'mac', uri: 'ahp-terminal:/a', title: 'bash' },
    { hostId: 'mac', uri: 'ahp-terminal:/b', title: 'bash' },
  ], labelOf), ['workspace', 'workspace 2'], 'сохранённые имена не меняются после overview');

  // PTY созданы в другом браузере: сохранённых имён нет, хост отдаёт одинаковый title.
  assert.deepEqual(terminalRowLabels([
    { hostId: 'mac', uri: 'ahp-terminal:/4606a70c-1', title: 'bash' },
    { hostId: 'mac', uri: 'ahp-terminal:/96c1aabb-2', title: 'bash' },
  ], () => undefined), ['bash · 4606a70c', 'bash · 96c1aabb']);

  // Разные хосты с одинаковым именем не считаются одной строкой.
  assert.deepEqual(terminalRowLabels([
    { hostId: 'mac', uri: 'ahp-terminal:/a', title: 'bash' },
    { hostId: 'glm', uri: 'ahp-terminal:/b', title: 'bash' },
  ], () => undefined), ['bash', 'bash']);

  // Одинаковое имя папки у терминалов из разных папок различает cwd — хвост URI не нужен.
  assert.deepEqual(terminalRowLabels([
    { hostId: 'mac', uri: 'ahp-terminal:/a', title: 'bash', folder: '/work/app' },
    { hostId: 'mac', uri: 'ahp-terminal:/b', title: 'bash', folder: '/tmp/app' },
  ], () => undefined), ['bash', 'bash']);
});

test('forgetTerminalLabel убирает имя адреса и не трогает соседние', () => {
  const store = removableStorage();
  rememberCreatedTerminalLabel(store, 'mac', TERMINAL, 'workspace');
  rememberCreatedTerminalLabel(store, 'mac', TERMINAL_TWO, 'workspace 2');
  assert.equal(forgetTerminalLabel(store, 'mac', TERMINAL), true);
  assert.equal(store.data[labelKey('mac', TERMINAL)], undefined, 'ключ удалён, а не оставлен пустым');
  assert.equal(terminalLabel(store, 'mac', TERMINAL), undefined);
  assert.equal(terminalLabel(store, 'mac', TERMINAL_TWO), 'workspace 2');
  assert.equal(forgetTerminalLabel(store, 'mac', TERMINAL), false);
  assert.equal(forgetTerminalLabel(store, 'mac', 'ahp-terminal:/unknown'), false);
});

test('forget без removeItem обнуляет запись и чистит старую карту', () => {
  const store = storage({
    'acc.terminals.v2.labels': JSON.stringify({ [TERMINAL]: 'legacy', [TERMINAL_TWO]: 'legacy two' }),
  });
  rememberManualTerminalLabel(store, 'mac', TERMINAL, 'manual');
  assert.equal(forgetTerminalLabel(store, 'mac', TERMINAL), true);
  assert.equal(terminalLabel(store, 'mac', TERMINAL), undefined);
  assert.equal(terminalLabel(store, 'mac', TERMINAL_TWO), 'legacy two', 'чужая старая подпись осталась');

  assert.equal(forgetTerminalLabel(store, 'mac', TERMINAL_TWO), true, 'старая карта — тоже имя');
  assert.equal(terminalLabel(store, 'mac', TERMINAL_TWO), undefined);
});

test('снимок с командами проверяется только при поддержке detection', () => {
  const command = (commandLine: string): TerminalState['content'][number] => ({
    type: 'command', commandId: '1', commandLine, output: '', timestamp: 0, isComplete: true,
  });
  const terminal = (extra: Partial<TerminalState>): TerminalState => ({
    ...state({ status: TerminalLifecycleStatus.Running }),
    ...extra,
  });

  assert.equal(terminalStateHasCommands(undefined), false);
  assert.equal(terminalStateHasCommands(terminal({ content: [command('echo x')] })), false, 'без флага снимку не верим');
  assert.equal(terminalStateHasCommands(terminal({ supportsCommandDetection: true, content: [{ type: 'unclassified', value: 'echo x' }] })), false);
  assert.equal(terminalStateHasCommands(terminal({ supportsCommandDetection: true, content: [command('  ')] })), false);
  assert.equal(terminalStateHasCommands(terminal({ supportsCommandDetection: true, content: [command('echo first')] })), true);
});

test('автозаголовок: пустая и пробельная команда не считается первой', () => {
  assert.deepEqual(terminalCommandLabel(''), { kind: 'empty' });
  assert.deepEqual(terminalCommandLabel('   '), { kind: 'empty' });
  assert.deepEqual(terminalCommandLabel('\n\t'), { kind: 'empty' });
});

test('автозаголовок: управляющие символы схлопываются в одну строку', () => {
  assert.deepEqual(terminalCommandLabel('  echo\u0000a\n\tb  '), { kind: 'title', title: 'echo a b' });
  assert.deepEqual(terminalCommandLabel('\u0000\u001f'), { kind: 'hidden' }, 'невидимую команду нельзя назвать');
});

test('автозаголовок: известные секреты в флагах, env, URL и Bearer замаскированы', () => {
  const cases = [
    'deploy --token supersecret --verbose',
    'deploy --password="hunter2"',
    'deploy --api-key=plainvalue',
    'deploy --secret \'shh\'',
    'API_KEY=abc123 ./run',
    'export GITHUB_TOKEN=ghp_value ./run',
    'export api_key=lower_secret',
    'curl -H "Authorization: Bearer abc.def.ghi" https://example.test',
    'curl "https://example.test/hook?token=query-secret&x=1"',
    'git clone https://user:url-password@example.test/repo.git',
    `deploy --token ${'a1'.repeat(32)}`,
  ];
  for (const commandLine of cases) {
    const parsed = terminalCommandLabel(commandLine);
    assert.equal(parsed.kind, 'title', commandLine);
    assert.match((parsed as { title: string }).title, /<redacted>/u, commandLine);
  }
  const secrets = ['supersecret', 'hunter2', 'plainvalue', 'shh', 'abc123', 'ghp_value', 'lower_secret', 'abc.def.ghi', 'query-secret', 'url-password', 'a1'.repeat(32)];
  for (const secret of secrets) {
    for (const commandLine of cases) {
      const parsed = terminalCommandLabel(commandLine);
      if (parsed.kind === 'title') assert.equal(parsed.title.includes(secret), false, `${commandLine} → ${parsed.title}`);
    }
  }
});

test('автозаголовок: незакрытая кавычка скрывает остаток, а не префикс секрета', () => {
  const parsed = terminalCommandLabel('deploy --token "partially-visible');
  assert.deepEqual(parsed, { kind: 'title', title: 'deploy --token <redacted>' });
});

test('автозаголовок обрезается до 120 code points уже после маскировки', () => {
  const long = `echo ${'я'.repeat(200)}`;
  const parsed = terminalCommandLabel(long);
  assert.equal(parsed.kind, 'title');
  const title = (parsed as { title: string }).title;
  assert.equal([...title].length, 120);
  assert.equal(title.endsWith('…'), true);

  const withSecret = terminalCommandLabel(`echo ${'a'.repeat(80)} --token supersecret-value ${'b'.repeat(50)}`);
  assert.equal(withSecret.kind, 'title');
  const masked = (withSecret as { title: string }).title;
  assert.equal([...masked].length, 120);
  assert.equal(masked.includes('supersecret-value'), false, 'префикс значения не попадает в подпись до обрезки');
  assert.match(masked, /--token <redacted>/u, 'маска попала в сохранённую часть строки');

  const emoji = terminalCommandLabel('😀'.repeat(130));
  assert.equal(emoji.kind, 'title');
  assert.equal([...(emoji as { title: string }).title].length, 120, 'лимит в Unicode-кодовых точках, не в UTF-16');
});
