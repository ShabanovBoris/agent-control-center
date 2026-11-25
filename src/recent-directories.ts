interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = 'acc.recentDirectories.v1';
const LIMIT = 8;

function readAll(storage: Storage): Record<string, string[]> {
  const saved = storage.getItem(KEY);
  if (saved === null) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(saved); }
  catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.values(parsed).every(paths => Array.isArray(paths) && paths.every(path => typeof path === 'string'))) {
    return {};
  }
  return parsed as Record<string, string[]>;
}

export function recentDirectories(storage: Storage, hostId: string): string[] {
  const all = readAll(storage);
  return Object.hasOwn(all, hostId) ? all[hostId]!.slice(0, LIMIT) : [];
}

export function rememberDirectory(storage: Storage, hostId: string, directory: string): void {
  const all = readAll(storage);
  const previous = Object.hasOwn(all, hostId) ? all[hostId]! : [];
  const key = (path: string) => path.replace(/\/+$/, '') || '/';
  const paths = [directory, ...previous.filter(path => key(path) !== key(directory))].slice(0, LIMIT);
  storage.setItem(KEY, JSON.stringify({ ...all, [hostId]: paths }));
}

/**
 * История папок вместе с причиной, почему её не удалось прочитать: формы показывают
 * это отдельной строкой и не блокируют работу (приватный режим запрещает localStorage).
 */
export function directoryHistory(storage: Storage, hostId: string): { paths: string[]; error?: string } {
  try {
    return { paths: recentDirectories(storage, hostId) };
  } catch (error) {
    return { paths: [], error: `Не удалось прочитать недавние папки: ${error instanceof Error ? error.message : String(error)}` };
  }
}
