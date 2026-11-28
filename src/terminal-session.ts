// Выбор терминала на странице `#terminal` и последние значения формы.
//
// Набор открытых PTY приходит из overview (backend читает root хоста), поэтому
// localStorage помнит только выбранный URI и форму. Пары «хост+папка» больше нет:
// в одной папке можно держать несколько своих терминалов. Модуль чистый:
// хранилище передаётся аргументом.
import type { TerminalState } from '@microsoft/agent-host-protocol';
import { REDACTED, redactSecrets } from '../shared/redact';

/** Выбранная строка списка: URI может исчезнуть из overview до следующего рендера. */
const SELECTED_KEY = 'acc.terminals.v2.selected';
/** Последние значения формы: хост и папка для следующего PTY. */
const FORM_KEY = 'acc.terminals.v2.form';
/** Форма из версии «один PTY на страницу»: одноразовый fallback при первом открытии. */
const LEGACY_FORM_KEY = 'acc.terminals.v1.last';
/**
 * Адресная запись подписи PTY: `(hostId, uri)`. Отдельный ключ на терминал не даёт
 * перезаписи общей карты потерять имя соседнего PTY, а раздельные слоты `base`/`manual`
 * позволяют отложенной записи автоимени не затереть ручное имя.
 */
const LABEL_PREFIX = 'acc.terminals.v3.label:';
/** Старая карта URI → имя: только fallback на чтение, без двойной записи. */
const LEGACY_LABELS_KEY = 'acc.terminals.v2.labels';
/** Длина автозаголовка в Unicode-кодовых точках, включая многоточие. */
const COMMAND_LABEL_MAX = 120;

export interface TerminalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/**
 * Базовая запись адреса: `created` ждёт первую команду, `auto` — окончательное автоимя,
 * `skipped` — имя по умолчанию, автоименование больше не разрешено.
 */
export type TerminalLabelBase =
  | { kind: 'created'; title: string }
  | { kind: 'auto'; title: string }
  | { kind: 'skipped'; title: string };

export interface TerminalLabelRecord {
  base?: TerminalLabelBase;
  manual?: string;
}

export interface TerminalSelection {
  hostId: string;
  uri: string;
}

export interface TerminalFormState {
  hostId: string;
  directory: string;
}

function readObject(storage: TerminalStorage, key: string): Record<string, unknown> | undefined {
  const raw = storage.getItem(key);
  if (raw === null) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

/** Выбранный терминал: только непустой hostId и URI терминального канала. */
export function selectedTerminal(storage: TerminalStorage): TerminalSelection | undefined {
  const parsed = readObject(storage, SELECTED_KEY);
  if (!parsed) return undefined;
  const { hostId, uri } = parsed;
  if (typeof hostId !== 'string' || !hostId) return undefined;
  if (typeof uri !== 'string' || !uri.startsWith('ahp-terminal:')) return undefined;
  return { hostId, uri };
}

export function rememberSelectedTerminal(storage: TerminalStorage, hostId: string, uri: string): void {
  if (!hostId || !uri.startsWith('ahp-terminal:')) return;
  storage.setItem(SELECTED_KEY, JSON.stringify({ hostId, uri }));
}

/** Забывает выбор: запись `null` читается как отсутствие выбора. */
export function forgetSelectedTerminal(storage: TerminalStorage): void {
  storage.setItem(SELECTED_KEY, 'null');
}

function readForm(storage: TerminalStorage, key: string): TerminalFormState | undefined {
  const parsed = readObject(storage, key);
  if (!parsed) return undefined;
  const { hostId, directory } = parsed;
  if (typeof hostId !== 'string' || !hostId) return undefined;
  if (typeof directory !== 'string' || !directory) return undefined;
  return { hostId, directory };
}

/** Форма для следующего PTY; до первого сохранения v2 — последняя пара старой версии. */
export function lastTerminalForm(storage: TerminalStorage): TerminalFormState | undefined {
  return readForm(storage, FORM_KEY) ?? readForm(storage, LEGACY_FORM_KEY);
}

export function rememberLastTerminalForm(storage: TerminalStorage, hostId: string, directory: string): void {
  if (!hostId || !directory) return;
  storage.setItem(FORM_KEY, JSON.stringify({ hostId, directory }));
}

function labelKey(hostId: string, uri: string): string {
  return `${LABEL_PREFIX}${encodeURIComponent(hostId)}:${encodeURIComponent(uri)}`;
}

function isBase(value: unknown): value is TerminalLabelBase {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { kind, title } = value as { kind?: unknown; title?: unknown };
  return (kind === 'created' || kind === 'auto' || kind === 'skipped')
    && typeof title === 'string' && title.length > 0;
}

/** Битые записи игнорируются целиком: имя лучше потерять, чем показать мусор. */
export function terminalLabelRecord(storage: TerminalStorage, hostId: string, uri: string): TerminalLabelRecord | undefined {
  const parsed = readObject(storage, labelKey(hostId, uri));
  if (!parsed) return undefined;
  const record: TerminalLabelRecord = {};
  if (isBase(parsed.base)) record.base = parsed.base;
  if (typeof parsed.manual === 'string' && parsed.manual) record.manual = parsed.manual;
  return record.base || record.manual ? record : undefined;
}

function writeTerminalLabelRecord(storage: TerminalStorage, hostId: string, uri: string, record: TerminalLabelRecord): void {
  if (!record.base && !record.manual) {
    if (storage.removeItem) storage.removeItem(labelKey(hostId, uri));
    else storage.setItem(labelKey(hostId, uri), 'null');
    return;
  }
  storage.setItem(labelKey(hostId, uri), JSON.stringify(record));
}

function legacyTerminalLabels(storage: TerminalStorage): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const [uri, value] of Object.entries(readObject(storage, LEGACY_LABELS_KEY) ?? {})) {
    if (uri.startsWith('ahp-terminal:') && typeof value === 'string' && value) labels.set(uri, value);
  }
  return labels;
}

/** Подпись строки: ручное имя → базовая запись → старая карта v2 → хост-заголовок. */
export function terminalLabel(storage: TerminalStorage, hostId: string, uri: string): string | undefined {
  const record = terminalLabelRecord(storage, hostId, uri);
  if (record?.manual) return record.manual;
  if (record?.base) return record.base.title;
  return legacyTerminalLabels(storage).get(uri);
}

/** Имя, которое панель дала PTY при создании; ждёт первую команду. */
export function rememberCreatedTerminalLabel(storage: TerminalStorage, hostId: string, uri: string, title: string): void {
  if (!hostId || !uri.startsWith('ahp-terminal:') || !title) return;
  const record = terminalLabelRecord(storage, hostId, uri);
  if (record?.base || record?.manual) return;
  writeTerminalLabelRecord(storage, hostId, uri, { base: { kind: 'created', title } });
}

/** Одноразовое автоимя: пишется только поверх ожидающей записи и никогда поверх ручного. */
export function rememberAutoTerminalLabel(storage: TerminalStorage, hostId: string, uri: string, title: string): boolean {
  if (!hostId || !uri.startsWith('ahp-terminal:') || !title) return false;
  const record = terminalLabelRecord(storage, hostId, uri);
  if (!record || record.manual || record.base?.kind !== 'created') return false;
  writeTerminalLabelRecord(storage, hostId, uri, { ...record, base: { kind: 'auto', title } });
  return true;
}

/**
 * Ручное имя выигрывает всегда. До команды базовая запись становится `skipped`,
 * чтобы отложенное автоимя не перезаписало выбор; старый auto-текст удаляется,
 * чтобы строка команды (возможно, с секретом) не хранилась после переименования.
 */
export function rememberManualTerminalLabel(storage: TerminalStorage, hostId: string, uri: string, title: string): void {
  if (!hostId || !uri.startsWith('ahp-terminal:') || !title) return;
  const record = terminalLabelRecord(storage, hostId, uri) ?? {};
  let base = record.base;
  if (base?.kind === 'created') base = { kind: 'skipped', title: base.title };
  else if (base?.kind === 'auto') base = undefined;
  writeTerminalLabelRecord(storage, hostId, uri, { ...(base ? { base } : {}), manual: title });
}

/** Автоимя невозможно (команда не отображается или история уже обрезана): остаётся дефолт. */
export function skipTerminalAutoLabel(storage: TerminalStorage, hostId: string, uri: string): boolean {
  if (!hostId || !uri.startsWith('ahp-terminal:')) return false;
  const record = terminalLabelRecord(storage, hostId, uri);
  if (record?.manual || record?.base?.kind !== 'created') return false;
  writeTerminalLabelRecord(storage, hostId, uri, { ...record, base: { kind: 'skipped', title: record.base.title } });
  return true;
}

/** Сколько записей подписи исчезло: закрытый или NotFound PTY больше не держит имя. */
export function forgetTerminalLabel(storage: TerminalStorage, hostId: string, uri: string): boolean {
  const had = terminalLabelRecord(storage, hostId, uri) !== undefined;
  if (had) writeTerminalLabelRecord(storage, hostId, uri, {});
  const legacy = new Map(legacyTerminalLabels(storage));
  if (!legacy.delete(uri)) return had;
  if (legacy.size > 0) storage.setItem(LEGACY_LABELS_KEY, JSON.stringify(Object.fromEntries(legacy)));
  else if (storage.removeItem) storage.removeItem(LEGACY_LABELS_KEY);
  else storage.setItem(LEGACY_LABELS_KEY, '{}');
  return true;
}

/** Базовая запись адреса: нужна, чтобы отличить ожидание команды от финального имени. */
export function terminalLabelBase(storage: TerminalStorage, hostId: string, uri: string): TerminalLabelBase | undefined {
  return terminalLabelRecord(storage, hostId, uri)?.base;
}

/**
 * Снимок уже содержит непустые команды, а запись ещё ждёт первую. Значит, история
 * могла быть обрезана до подписки: взять произвольную команду нельзя, остаётся дефолт.
 */
export function terminalStateHasCommands(state: TerminalState | undefined): boolean {
  if (!state?.supportsCommandDetection) return false;
  return state.content.some(part => part.type === 'command' && part.commandLine.trim().length > 0);
}

/**
 * Имя нового PTY: имя папки, а при совпадении — следующий свободный номер
 * («workspace», «workspace 2»). Номер закрепляется за URI в localStorage, поэтому
 * после прихода overview подпись не меняется на хост-заголовок.
 */
export function nextTerminalLabel(base: string, used: Iterable<string>): string {
  const taken = new Set(used);
  if (!taken.has(base)) return base;
  let ordinal = 2;
  while (taken.has(`${base} ${ordinal}`)) ordinal += 1;
  return `${base} ${ordinal}`;
}

/** Короткий хвост URI — различитель, когда одинаковые подписи пришли не из этого браузера. */
export function shortTerminalId(uri: string): string {
  const id = uri.slice(uri.lastIndexOf('/') + 1);
  return id.slice(0, 8);
}

/**
 * Подписи строк списка: сохранённая по адресу, иначе title хоста. Если после этого
 * у двух терминалов одного хоста в одной папке подпись совпадает (PTY создан в другом
 * браузере), обе получают короткий хвост URI — иначе строки неотличимы.
 */
export function terminalRowLabels(
  items: readonly { hostId: string; uri: string; title: string; folder?: string }[],
  labelOf: (hostId: string, uri: string) => string | undefined,
): string[] {
  const base = items.map(item => labelOf(item.hostId, item.uri) || item.title);
  const counts = new Map<string, number>();
  for (const [index, label] of base.entries()) {
    const item = items[index]!;
    const key = `${item.hostId}\n${item.folder ?? ''}\n${label}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return base.map((label, index) => {
    const item = items[index]!;
    const key = `${item.hostId}\n${item.folder ?? ''}\n${label}`;
    return (counts.get(key) ?? 0) > 1 ? `${label} · ${shortTerminalId(item.uri)}` : label;
  });
}

/** Текст жизненного цикла для строки списка и статуса выбранного терминала. */
export function terminalStatusText(lifecycle: TerminalState['lifecycle'] | undefined): string {
  if (!lifecycle) return 'подключаемся…';
  if (lifecycle.status !== 'exited') return 'выполняется';
  return `завершён${lifecycle.exitCode !== undefined ? ` · код ${lifecycle.exitCode}` : ''}`;
}

/** Фактический каталог shell: хост мог не принять запрошенный cwd. */
export function terminalCwd(state: TerminalState | undefined, fallback: string): string {
  const cwd = state?.cwd;
  if (!cwd) return fallback;
  try {
    const url = new URL(cwd);
    return url.protocol === 'file:' ? decodeURIComponent(url.pathname) : cwd;
  } catch {
    return cwd;
  }
}

// Значения типичных флагов: `--token X`, `--password="X"`, `--api-key X`.
// Открытая кавычка без пары скрывает остаток строки, а не оставляет префикс значения.
const FLAG_SECRET = /(^|\s)(--?(?:token|password|passwd|api-key|apikey|secret|access-token|auth-token|api-token|client-secret))(=|\s+)(?:"[^"]*"|'[^']*'|"[^"]*$|'[^']*$|[^\s;|&]*)/gi;
// Учётные данные в URL: `https://user:password@host`.
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^@\s/]+)(@)/gi;
// Присваивания в нижнем регистре и имена переменных, которые не попали в серверную редакцию.
const ENV_SECRET = /\b([A-Za-z][A-Za-z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD)|api_key|apikey|access_token|refresh_token|token|secret|password)\s*=\s*("[^"]*"|'[^']*'|[^\s&;,'"]+)/gi;

/** Убирает секреты, которые встречаются в командной строке, но не в журналах сервера. */
function redactTerminalSecrets(text: string): string {
  return redactSecrets(text)
    .replace(FLAG_SECRET, `$1$2$3${REDACTED}`)
    .replace(URL_CREDENTIALS, `$1${REDACTED}$3`)
    .replace(ENV_SECRET, `$1=${REDACTED}`);
}

/** Пустая команда не считается первой; непустую, которую нельзя показать, нельзя и назвать. */
export type TerminalCommandLabel =
  | { kind: 'empty' }
  | { kind: 'hidden' }
  | { kind: 'title'; title: string };

/**
 * Автозаголовок из строки первой команды: одна строка, известные секреты замаскированы
 * до обрезки, итог не длиннее 120 Unicode-кодовых точек. Исходная строка никуда не уходит.
 */
export function terminalCommandLabel(commandLine: string): TerminalCommandLabel {
  if (typeof commandLine !== 'string' || commandLine.trim().length === 0) return { kind: 'empty' };
  const oneLine = commandLine
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!oneLine) return { kind: 'hidden' };
  const redacted = redactTerminalSecrets(oneLine);
  if (!redacted) return { kind: 'hidden' };
  const chars = [...redacted];
  return { kind: 'title', title: chars.length <= COMMAND_LABEL_MAX ? redacted : `${chars.slice(0, COMMAND_LABEL_MAX - 1).join('')}…` };
}
