import { execFile } from 'node:child_process';
import { mkdir, link, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import type { UpService } from './up.js';

/** Идентичность процесса: pid переиспользуется, время старта — нет. */
export interface ProcessIdentity {
  pid: number;
  /** `ps -p <pid> -o lstart=` при LC_ALL=C. */
  startedAt: string;
}

export interface UpServiceRecord {
  /** Лидер группы: его сигналит супервизор. */
  leader: ProcessIdentity;
  /** Живой экземпляр хоста, найденный через localInstance (pid CLI, не обёртки). */
  instance?: ProcessIdentity;
}

export interface UpState {
  version: 1;
  owner: ProcessIdentity;
  children: Partial<Record<UpService, UpServiceRecord>>;
}

export interface ProcessTable {
  identity(pid: number): Promise<ProcessIdentity | undefined>;
  /** Другой живой `scripts/up.ts`, которым не владеет этот файл состояния. */
  otherUp(ownerPid: number): Promise<number | undefined>;
}

export interface UpOwnership {
  readonly owner: ProcessIdentity;
  previous(service: UpService): UpServiceRecord | undefined;
  /** Запись подтверждена: pid жив и время старта совпало. */
  owns(service: UpService): Promise<boolean>;
  record(service: UpService, child: { leaderPid: number; instancePid?: number }): Promise<void>;
  forget(service: UpService): Promise<void>;
  /** `remove` — только при чистой остановке; иначе состояние нужно следующему запуску. */
  release(remove: boolean): Promise<void>;
}

export type OwnershipResult =
  | { kind: 'acquired'; ownership: UpOwnership }
  | { kind: 'other'; pid: number };

export interface UpOwnershipSource {
  acquire(): Promise<OwnershipResult>;
}

export interface CreateOwnershipOptions {
  file: string;
  ownerPid: number;
  table: ProcessTable;
  log(line: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseIdentity(value: unknown): ProcessIdentity | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 1) return undefined;
  if (typeof value.startedAt !== 'string' || value.startedAt.length === 0) return undefined;
  return { pid: value.pid as number, startedAt: value.startedAt };
}

function parseServiceRecord(value: unknown): UpServiceRecord | undefined {
  if (!isRecord(value)) return undefined;
  const leader = parseIdentity(value.leader);
  if (!leader) return undefined;
  const instance = value.instance === undefined ? undefined : parseIdentity(value.instance);
  if (value.instance !== undefined && !instance) return undefined;
  return { leader, ...(instance ? { instance } : {}) };
}

/** Битый или чужой файл не должен блокировать запуск: он считается отсутствующим. */
export async function readUpState(file: string, log: (line: string) => void = () => undefined): Promise<UpState | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log(`[up] Файл ${file} повреждён: состояние владения игнорируется.`);
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    log(`[up] Файл ${file} имеет неизвестную версию: состояние владения игнорируется.`);
    return undefined;
  }
  const owner = parseIdentity(parsed.owner);
  if (!owner || !isRecord(parsed.children)) {
    log(`[up] Файл ${file} не содержит владельца: состояние владения игнорируется.`);
    return undefined;
  }
  const children: UpState['children'] = {};
  for (const [service, value] of Object.entries(parsed.children)) {
    if (service !== 'host:local' && service !== 'host:wbllm' && service !== 'host:glm' && service !== 'backend' && service !== 'web') continue;
    const record = parseServiceRecord(value);
    if (record) children[service] = record;
  }
  return { version: 1, owner, children };
}

/** Уникальный temp-файл на процесс: параллельные записи не должны видеть чужой temp. */
let tempSeq = 0;

function tempPath(file: string): string {
  tempSeq += 1;
  return `${file}.${process.pid}.${tempSeq}.tmp`;
}

async function writeState(file: string, state: UpState): Promise<void> {
  const temp = tempPath(file);
  try {
    // temp+rename: читатель никогда не увидит половину JSON, режим 0600 наследуется файлом.
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  } finally {
    // После успешного rename temp уже нет; иначе (ошибка записи) убираем мусор.
    await unlink(temp).catch(() => undefined);
  }
}

/**
 * Публикация состояния без перезаписи: `link` атомарен и, в отличие от `open('wx')`
 * с последующей записью, не оставляет пустой файл, который второй запуск принял бы
 * за устаревший и удалил.
 */
async function createState(file: string, state: UpState): Promise<void> {
  const temp = tempPath(file);
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await link(temp, file);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}


class FileOwnership implements UpOwnership {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: CreateOwnershipOptions,
    readonly owner: ProcessIdentity,
    private readonly state: UpState,
  ) {}

  previous(service: UpService): UpServiceRecord | undefined {
    return this.state.children[service];
  }

  async owns(service: UpService): Promise<boolean> {
    const record = this.state.children[service];
    if (!record) return false;
    const alive = await this.options.table.identity(record.leader.pid);
    return alive?.startedAt === record.leader.startedAt;
  }

  async record(service: UpService, child: { leaderPid: number; instancePid?: number }): Promise<void> {
    const leader = await this.options.table.identity(child.leaderPid);
    // Без записи владения следующий запуск примет живой сервис за чужой стенд,
    // поэтому сбой identity не проглатывается: супервизор гасит процесс и выходит.
    if (!leader) throw new Error(`не удалось определить время старта pid ${child.leaderPid}`);
    const instance = child.instancePid === undefined
      ? undefined
      : child.instancePid === child.leaderPid ? leader : await this.options.table.identity(child.instancePid);
    if (child.instancePid !== undefined && !instance) {
      this.options.log(`[up] Не удалось определить время старта pid ${child.instancePid}: в записи ${service} остаётся только лидер.`);
    }
    this.state.children[service] = { leader, ...(instance ? { instance } : {}) };
    this.writeQueue = this.writeQueue.then(() => writeState(this.options.file, this.state));
    await this.writeQueue;
  }

  async forget(service: UpService): Promise<void> {
    delete this.state.children[service];
    this.writeQueue = this.writeQueue.then(() => writeState(this.options.file, this.state));
    await this.writeQueue;
  }

  async release(remove: boolean): Promise<void> {
    await this.writeQueue;
    if (!remove) return;
    try {
      await unlink(this.options.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/**
 * Захват владения стендом. Публикация состояния через `link` атомарна; живой владелец
 * или другой `scripts/up.ts` — не ошибка, а причина выйти с кодом 0, не трогая процессы.
 */
export function upOwnershipSource(options: CreateOwnershipOptions): UpOwnershipSource {
  return {
    async acquire(): Promise<OwnershipResult> {
      const otherPid = await options.table.otherUp(options.ownerPid);
      if (otherPid !== undefined) return { kind: 'other', pid: otherPid };
      let previous = await readUpState(options.file, options.log);
      await mkdir(dirname(options.file), { recursive: true, mode: 0o700 });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const owner = await options.table.identity(options.ownerPid);
        if (!owner) throw new Error(`Не удалось определить время старта pid ${options.ownerPid}: без этого владение невозможно.`);
        const state: UpState = { version: 1, owner, children: previous?.children ?? {} };
        try {
          await createState(options.file, state);
          return { kind: 'acquired', ownership: new FileOwnership(options, owner, state) };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          // Файл мог появиться между чтением и публикацией: перечитываем его, чтобы
          // не удалить запись живого владельца и не захватить стенд вдвоём.
          previous = await readUpState(options.file, options.log) ?? previous;
          const current = previous?.owner;
          if (current) {
            const alive = await options.table.identity(current.pid);
            if (alive?.startedAt === current.startedAt) return { kind: 'other', pid: current.pid };
          }
          // Владелец мёртв или pid переиспользован: файл устарел, но дети могли выжить.
          try { await unlink(options.file); }
          catch (unlinkError) { if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError; }
        }
      }
      throw new Error(`Не удалось захватить ${options.file}: файл состояния постоянно пересоздаётся.`);
    },
  };
}

const execFileAsync = promisify(execFile);

/**
 * Командная строка запуска `[<путь>/]scripts/up.ts`: ручной `node --import tsx`,
 * `node --import=tsx`, `node --loader tsx` и tsx-бин. Аргументы после скрипта не важны.
 */
export function isUpCommandLine(command: string, execPath: string = process.execPath): boolean {
  const tokens = command.trim().split(/\s+/);
  const bin = tokens[0] ?? '';
  if (bin !== execPath && bin.split('/').pop() !== 'node') return false;
  const scriptIndex = tokens.findIndex((token, index) => index > 0 && /(?:^|\/)scripts\/up\.ts$/.test(token));
  if (scriptIndex < 0) return false;
  // Между node и скриптом стоит загрузчик tsx (флагом, значением флага или путём к бину).
  return tokens.slice(1, scriptIndex).some(token => token.includes('tsx'));
}

export const processTable: ProcessTable = {
  async identity(pid: number): Promise<ProcessIdentity | undefined> {
    try {
      const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
        env: { ...process.env, LC_ALL: 'C' }, timeout: 5000,
      });
      const startedAt = stdout.trim();
      return startedAt ? { pid, startedAt } : undefined;
    } catch {
      return undefined;
    }
  },

  async otherUp(ownerPid: number): Promise<number | undefined> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,command=', '-ww'], {
        env: { ...process.env, LC_ALL: 'C' }, timeout: 5000, maxBuffer: 8 * 1024 * 1024,
      }));
    } catch {
      return undefined;
    }
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      if (pid === ownerPid || pid <= 1) continue;
      if (isUpCommandLine(match[2]!)) return pid;
    }
    return undefined;
  },
};
