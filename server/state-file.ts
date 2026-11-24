import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Временный файл + rename: writeFile с mode не исправит права уже существующего файла. */
export async function writePrivate(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
    await chmod(path, 0o600).catch(() => {});
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}
