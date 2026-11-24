export interface KeepAwakeChild {
  kill(signal: NodeJS.Signals): boolean;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

export type KeepAwakeSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: 'ignore' },
) => KeepAwakeChild;

export interface KeepAwakeOptions {
  platform: NodeJS.Platform;
  /** pid супервизора: `caffeinate -w` выйдет вместе с ним даже после SIGKILL. */
  pid: number;
  spawn: KeepAwakeSpawn;
  log(line: string): void;
}

export interface KeepAwake {
  stop(): void;
}

/**
 * `-i` не даёт уснуть системе и от батареи, `-m` — диску, `-s` — системе на питании.
 * `-d` сознательно не используется: дисплей может гаснуть, это не мешает работе.
 */
export function keepAwakeArgs(pid: number, platform: NodeJS.Platform): readonly string[] | undefined {
  return platform === 'darwin' ? ['-i', '-m', '-s', '-w', String(pid)] : undefined;
}

export function startKeepAwake(options: KeepAwakeOptions): KeepAwake | undefined {
  const args = keepAwakeArgs(options.pid, options.platform);
  if (!args) {
    options.log('[up] caffeinate поддерживается только на macOS; keep-awake пропущен.');
    return undefined;
  }
  let child: KeepAwakeChild;
  try {
    child = options.spawn('/usr/bin/caffeinate', args, { stdio: 'ignore' });
  } catch (error) {
    options.log(`[up] Не удалось запустить caffeinate: ${error instanceof Error ? error.message : String(error)}. Система может уснуть.`);
    return undefined;
  }
  child.once('error', error => {
    options.log(`[up] caffeinate завершился с ошибкой: ${error.message}. Система может уснуть.`);
  });
  return {
    stop() {
      try {
        child.kill('SIGTERM');
      } catch {
        // Процесс уже завершился: это нормальный путь.
      }
    },
  };
}
