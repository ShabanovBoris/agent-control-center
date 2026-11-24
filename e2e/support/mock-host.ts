import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { PORTS, REPO_ROOT } from './env';

const READY_LINE = /^\[mock-host\] ws:\/\/127\.0\.0\.1:(\d+) pid=(\d+)$/;
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;
const PORT_TIMEOUT_MS = 5_000;

function connectOnce(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('таймаут подключения'));
    }, 1_000);
    socket.once('connect', () => {
      socket.destroy();
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', error => {
      socket.destroy();
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  // bind происходит асинхронно после строки готовности, поэтому проверяем TCP с повторами.
  while (Date.now() <= deadline) {
    try {
      await connectOnce(port);
      return;
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`порт ${port} не отвечает за ${timeoutMs} мс`);
}

function portIsClosed(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(true);
    });
  });
}

/**
 * Владелец процесса mock-хоста на время worker-а. Аргумент порта важнее `MOCK_HOST_PORT`,
 * поэтому чужие env не влияют; строка готовности подтверждает, что слушает именно наш процесс.
 */
export class MockHost {
  private child: ChildProcess | undefined;
  private stderr = '';

  constructor(private readonly port: number = PORTS.mock) {}

  async ensureStarted(): Promise<void> {
    if (this.child && this.child.exitCode === null) return;
    await this.start();
  }

  async start(): Promise<void> {
    if (this.child && this.child.exitCode === null) return;
    this.stderr = '';
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/mock-host.ts', String(this.port)], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MOCK_HOST_PORT: String(this.port) },
    });
    this.child = child;
    child.stderr?.on('data', chunk => { this.stderr += String(chunk); });

    const ready = new Promise<void>((resolve, reject) => {
      let stdout = '';
      const timer = setTimeout(() => {
        reject(new Error(`mock-host не напечатал адрес за ${START_TIMEOUT_MS} мс`));
      }, START_TIMEOUT_MS);
      const settle = (error?: Error) => {
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      child.stdout?.on('data', chunk => {
        stdout += String(chunk);
        for (const line of stdout.split('\n')) {
          const match = READY_LINE.exec(line.trim());
          if (!match) continue;
          if (Number(match[1]) !== this.port || Number(match[2]) !== child.pid) continue;
          settle();
          return;
        }
      });
      child.once('error', error => settle(error));
      child.once('exit', (code, signal) => {
        settle(new Error(`mock-host завершился до готовности: code=${String(code)} signal=${String(signal)}`));
      });
    });

    try {
      await ready;
      await waitForPort(this.port, PORT_TIMEOUT_MS);
    } catch (error) {
      await this.stop();
      throw new Error(
        `Не удалось запустить mock-host на порту ${this.port}: ${error instanceof Error ? error.message : String(error)}. `
        + 'Порт может быть занят — задайте свободный через E2E_MOCK_PORT.'
        + (this.stderr.trim() ? `\n${this.stderr.trim()}` : ''),
        { cause: error },
      );
    }
  }

  /** Идемпотентно останавливает процесс и дожидается освобождения порта. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    // `close`, а не `exit`: при ошибке spawn событие `exit` может не прийти.
    const exited = new Promise<void>(resolve => {
      if (child.exitCode !== null) resolve();
      else child.once('close', () => resolve());
    });
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
    await exited.catch(() => undefined);
    clearTimeout(timer);
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (!(await portIsClosed(this.port))) {
      if (Date.now() > deadline) throw new Error(`mock-host не освободил порт ${this.port} за ${STOP_TIMEOUT_MS} мс`);
      await delay(50);
    }
  }
}
