// Выбор терминала на странице `#terminal` и последние значения формы.
//
// Набор открытых PTY приходит из overview (backend читает root хоста), поэтому
// localStorage помнит только выбранный URI и форму. Пары «хост+папка» больше нет:
// в одной папке можно держать несколько своих терминалов. Модуль чистый:
// хранилище передаётся аргументом.
import type { TerminalState } from '@microsoft/agent-host-protocol';

/** Выбранная строка списка: URI может исчезнуть из overview до следующего рендера. */
const SELECTED_KEY = 'acc.terminals.v2.selected';
/** Последние значения формы: хост и папка для следующего PTY. */
const FORM_KEY = 'acc.terminals.v2.form';
/** Форма из версии «один PTY на страницу»: одноразовый fallback при первом открытии. */
const LEGACY_FORM_KEY = 'acc.terminals.v1.last';
/**
 * Подписи строк по URI. Реальный хост отдаёт `title: "bash"` для любого своего PTY
 * (`terminal/titleChanged` он принимает, но заголовок не меняет), поэтому имя, которое
 * человек видел при создании, хранит панель. Набор при этом остаётся из overview.
 */
const LABELS_KEY = 'acc.terminals.v2.labels';

export interface TerminalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
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

/** Сохранённые подписи строк: URI → имя, которое человек видел при создании PTY. */
export function terminalLabels(storage: TerminalStorage): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const [uri, value] of Object.entries(readObject(storage, LABELS_KEY) ?? {})) {
    if (uri.startsWith('ahp-terminal:') && typeof value === 'string' && value) labels.set(uri, value);
  }
  return labels;
}

export function rememberTerminalLabel(storage: TerminalStorage, uri: string, label: string): void {
  if (!uri.startsWith('ahp-terminal:') || !label) return;
  const labels = new Map(terminalLabels(storage));
  labels.set(uri, label);
  storage.setItem(LABELS_KEY, JSON.stringify(Object.fromEntries(labels)));
}

/** Подписи исчезнувших терминалов не копятся: закрытый PTY забывает своё имя. */
export function forgetTerminalLabel(storage: TerminalStorage, uri: string): void {
  const labels = new Map(terminalLabels(storage));
  if (!labels.delete(uri)) return;
  storage.setItem(LABELS_KEY, JSON.stringify(Object.fromEntries(labels)));
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
 * Подписи строк списка: сохранённая по URI, иначе title хоста. Если после этого
 * у двух терминалов одного хоста в одной папке подпись совпадает (PTY создан в другом
 * браузере), обе получают короткий хвост URI — иначе строки неотличимы.
 */
export function terminalRowLabels(
  items: readonly { hostId: string; uri: string; title: string; folder?: string }[],
  labels: ReadonlyMap<string, string>,
): string[] {
  const base = items.map(item => labels.get(item.uri) || item.title);
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
