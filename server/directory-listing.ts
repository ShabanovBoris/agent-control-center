import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { isValidEntryName, normalizeDirectoryPath, type DirectoryEntry } from '../shared/directory.js';
import { CallFailure } from './errors.js';

/** Инъекция чтения каталога: тесты проверяют allowlist и ошибки без реальной ФС. */
type DirectoryReader = (path: string) => Promise<readonly Pick<Dirent, 'name' | 'isDirectory'>[]>;

const defaultRead: DirectoryReader = path => readdir(path, { withFileTypes: true });

/**
 * Fallback-листинг для хостов, которые панель запускает сама: только `locals`.
 * Отдаёт имена и типы прямых детей, содержимое файлов не читает и за пределы пути не ходит.
 */
export class LocalDirectoryLister {
  constructor(
    private readonly hostIds: readonly string[],
    private readonly read: DirectoryReader = defaultRead,
  ) {}

  availableFor(hostId: string): boolean {
    return this.hostIds.includes(hostId);
  }

  async list(hostId: string, path: string, signal?: AbortSignal): Promise<DirectoryEntry[]> {
    if (!this.availableFor(hostId)) throw new CallFailure('Локальный листинг доступен только для локальных хостов проекта');
    const normalized = normalizeDirectoryPath(path);
    if (!normalized) throw new CallFailure('Укажите абсолютный путь к папке на хосте');
    signal?.throwIfAborted();
    let entries: Awaited<ReturnType<DirectoryReader>>;
    try {
      entries = await this.read(normalized);
    } catch (error) {
      throw new CallFailure(readFailureMessage(error));
    }
    return entries
      .filter(entry => isValidEntryName(entry.name))
      .map((entry): DirectoryEntry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }));
  }
}

/** Errno backend — не JSON-RPC код хоста, поэтому `CallFailure.code` здесь не выставляется. */
function readFailureMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return 'Папка не найдена';
  if (code === 'EACCES' || code === 'EPERM') return 'Нет прав на чтение папки';
  if (code === 'ENOTDIR') return 'Это не папка';
  return `Не удалось прочитать папку: ${error instanceof Error ? error.message : String(error)}`;
}
