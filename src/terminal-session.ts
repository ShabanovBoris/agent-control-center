// Какой shell подхватить на странице `#terminal`.
//
// Backend не помнит, какой терминал относится к какой папке: это состояние браузера.
// URI хранится по паре «хост + папка», поэтому F5 и возврат со страницы поднимают тот же
// PTY, а другое устройство открывает свой. Модуль чистый: хранилище передаётся аргументом.
import type { TerminalState } from '@microsoft/agent-host-protocol';

const STORAGE_KEY = 'acc.terminals.v1';
/** Последняя открытая пара хост+папка: по ней страница после F5 возвращает прежний shell. */
const LAST_KEY = 'acc.terminals.v1.last';

export interface TerminalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Ключ папки не зависит от хвостового `/`: `/work` и `/work/` — один терминал. */
export function terminalKey(hostId: string, directory: string): string {
  const path = directory.trim().replace(/\/+$/, '') || '/';
  return `${hostId}\n${path}`;
}

function readAll(storage: TerminalStorage): Record<string, string> {
  const saved = storage.getItem(STORAGE_KEY);
  if (saved === null) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(saved); }
  catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const entries = Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].startsWith('ahp-terminal:'));
  return Object.fromEntries(entries);
}

export function savedTerminal(storage: TerminalStorage, hostId: string, directory: string): string | undefined {
  const all = readAll(storage);
  const key = terminalKey(hostId, directory);
  return Object.hasOwn(all, key) ? all[key] : undefined;
}

export function rememberTerminal(storage: TerminalStorage, hostId: string, directory: string, uri: string): void {
  if (!uri.startsWith('ahp-terminal:')) return;
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(storage), [terminalKey(hostId, directory)]: uri }));
}

export function forgetTerminal(storage: TerminalStorage, hostId: string, directory: string): void {
  const all = readAll(storage);
  const key = terminalKey(hostId, directory);
  if (!Object.hasOwn(all, key)) return;
  delete all[key];
  storage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export interface LastTerminal {
  hostId: string;
  directory: string;
}

/**
 * Пара хост+папка, открытая последней. Нужна, когда папка не совпадает с папкой по
 * умолчанию (например, `/tmp`): без неё возврат на страницу показывал бы форму и
 * создавал второй PTY, хотя прошлый shell ещё жив.
 */
export function lastTerminal(storage: TerminalStorage): LastTerminal | undefined {
  const raw = storage.getItem(LAST_KEY);
  if (raw === null) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const { hostId, directory } = parsed as Record<string, unknown>;
  if (typeof hostId !== 'string' || typeof directory !== 'string' || !hostId || !directory) return undefined;
  return { hostId, directory };
}

export function rememberLastTerminal(storage: TerminalStorage, hostId: string, directory: string): void {
  storage.setItem(LAST_KEY, JSON.stringify({ hostId, directory }));
}

/** Что показать, когда сохранённый URI уже известен странице. */
export type TerminalChoice =
  | { kind: 'create' }
  | { kind: 'attach' }
  | { kind: 'exited'; exitCode?: number };

/**
 * `missing` от backend означает `NotFound`: терминал закрыт, хост перезапущен или PTY
 * вычищен — тогда создаётся новый. Пока снимка нет, сохранённый URI остаётся в игре:
 * иначе каждое открытие страницы создавало бы второй PTY.
 */
export function terminalChoice(saved: string | undefined, view: { state?: TerminalState; missing?: boolean }): TerminalChoice {
  if (!saved) return { kind: 'create' };
  if (view.missing) return { kind: 'create' };
  const state = view.state;
  if (!state) return { kind: 'attach' };
  if (state.lifecycle.status === 'exited') {
    return { kind: 'exited', ...(state.lifecycle.exitCode !== undefined ? { exitCode: state.lifecycle.exitCode } : {}) };
  }
  return { kind: 'attach' };
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
