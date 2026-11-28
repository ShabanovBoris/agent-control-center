import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectRoot } from '../scripts/agent-sdks.mjs';
import type { LogTail } from '../shared/protocol.js';
import type { LocalHost } from './local-hosts.js';
import { redactSecrets } from '../shared/redact.js';

export const MAX_LOG_BYTES = 64 * 1024;
export const MAX_LOG_LINES = 300;
export const MAX_LOG_LINE_CHARS = 4000;

export interface LogSource {
  hostId: string;
  /** Только имя файла: абсолютный путь остаётся на сервере. */
  fileName: string;
  /** Абсолютный путь; строится от корня проекта, не от cwd процесса. */
  path: string;
  startCommand: string;
}

/**
 * Единственное место, где известны пути журналов. Панель может запустить хост только
 * с `--log` (`startLocalHost`/`startHost`), поэтому эти файлы покрывают её сценарии.
 */
const LOG_FILES: Record<LocalHost['id'], { fileName: string; startCommand: string }> = {
  local: { fileName: '.local/host.log', startCommand: 'npm run host -- --log' },
  wbllm: { fileName: '.local/wbllm-host.log', startCommand: 'npm run host:wbllm -- --log' },
  glm: { fileName: '.local/glm-host.log', startCommand: 'npm run host:glm -- --log' },
};

/** Таблица «hostId → фиксированный файл»: произвольный путь или хост добавить нельзя. */
export function localLogSources(hosts: readonly LocalHost[]): LogSource[] {
  return hosts.flatMap(host => {
    const file = LOG_FILES[host.id];
    return file ? [{ hostId: host.id, ...file, path: resolve(projectRoot, file.fileName) }] : [];
  });
}

function truncatedLine(line: string): { line: string; truncated: boolean } {
  if (line.length <= MAX_LOG_LINE_CHARS) return { line, truncated: false };
  return { line: line.slice(0, MAX_LOG_LINE_CHARS), truncated: true };
}

function unavailable(hostId: string, fileName: string, message: string): LogTail {
  return { status: 'unavailable', hostId, fileName, message };
}

/**
 * Читает хвост журнала: не больше `MAX_LOG_BYTES` с конца файла, затем последние
 * `MAX_LOG_LINES` строк. Symlink, каталог и FIFO отклоняются без содержимого.
 */
export async function readLogTail(source: LogSource): Promise<LogTail> {
  const { hostId, fileName } = source;
  let handle: FileHandle;
  try {
    // O_NOFOLLOW закрывает подмену файла ссылкой, O_NONBLOCK — зависание на FIFO.
    handle = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    switch ((error as NodeJS.ErrnoException).code) {
      case 'ENOENT':
        return {
          status: 'missing', hostId, fileName,
          message: `Файл не найден: хост не запускали с --log. Запустите «${source.startCommand}» или перезапустите службы из панели.`,
        };
      case 'ELOOP':
        return unavailable(hostId, fileName, 'Файл журнала является символической ссылкой — чтение отклонено.');
      case 'EACCES':
      case 'EPERM':
        return unavailable(hostId, fileName, 'Нет доступа к файлу журнала.');
      default:
        return unavailable(hostId, fileName, 'Не удалось открыть файл журнала.');
    }
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return unavailable(hostId, fileName, 'Журнал не является обычным файлом — чтение отклонено.');
    const start = Math.max(0, stat.size - MAX_LOG_BYTES);
    const size = stat.size - start;
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const { bytesRead } = await handle.read(buffer, read, size - read, start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    let text = buffer.subarray(0, read).toString('utf8');
    let truncated = start > 0;
    if (truncated) {
      // Первая строка окна почти всегда обрезана посередине.
      const newline = text.indexOf('\n');
      if (newline === -1) text = text.replace(/^\uFFFD+/, '');
      else text = text.slice(newline + 1);
    }
    const raw = text.split('\n');
    // Файл почти всегда заканчивается переводом строки: пустой хвост не строка журнала.
    if (raw.at(-1) === '') raw.pop();
    if (raw.length > MAX_LOG_LINES) truncated = true;
    const lines = raw.slice(-MAX_LOG_LINES).map(logLine => {
      // Сначала редакция, потом обрезка: секрет не должен разрезаться лимитом.
      const clipped = truncatedLine(redactSecrets(logLine.replace(/\r$/, '')));
      if (clipped.truncated) truncated = true;
      return clipped.line;
    });
    return { status: 'ok', hostId, fileName, lines, truncated, updatedAt: stat.mtime.toISOString() };
  } catch {
    return unavailable(hostId, fileName, 'Не удалось прочитать файл журнала.');
  } finally {
    await handle.close().catch(() => undefined);
  }
}
