// Семантика путей и порядка папок, общая для backend и браузера.
// Модуль не импортирует `node:*`: его исполняют и сервер, и UI.

export interface DirectoryEntry {
  name: string;
  type: 'file' | 'directory';
}

/** Один коллатор на модуль: сортировка не создаёт ICU-объект на каждый рендер. */
const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });

/** Имя прямого ребёнка каталога: без разделителей и без ссылок на сам/родительский каталог. */
export function isValidEntryName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0');
}

/**
 * Абсолютный POSIX-путь в каноническом виде: без `//`, `.`, `..` и хвостового `/`.
 * `..` разбирается лексически, поэтому для пути через симлинк он может означать не тот каталог.
 */
export function normalizeDirectoryPath(value: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.includes('\0')) return undefined;
  const segments: string[] = [];
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

export function parentDirectoryPath(path: string): string | undefined {
  const normalized = normalizeDirectoryPath(path);
  if (!normalized || normalized === '/') return undefined;
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

export function childDirectoryPath(parent: string, name: string): string | undefined {
  const normalized = normalizeDirectoryPath(parent);
  if (!normalized || !isValidEntryName(name)) return undefined;
  return normalized === '/' ? `/${name}` : `${normalized}/${name}`;
}

/** Каталоги раньше файлов; внутри — регистронезависимо и numeric, с детерминированным tie-break. */
export function sortDirectoryEntries(entries: readonly DirectoryEntry[]): DirectoryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    const byName = collator.compare(a.name, b.name);
    if (byName !== 0) return byName;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/**
 * Разбор недоверенного ответа хоста или листинга: только валидные записи, первая на имя.
 * Не массив — `undefined`; пустой массив остаётся валидным пустым каталогом.
 */
export function parseDirectoryEntries(raw: unknown): DirectoryEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const entries: DirectoryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { name, type } = item as { name?: unknown; type?: unknown };
    if (typeof name !== 'string' || !isValidEntryName(name) || seen.has(name)) continue;
    if (type !== 'file' && type !== 'directory') continue;
    seen.add(name);
    entries.push({ name, type });
  }
  return entries;
}
