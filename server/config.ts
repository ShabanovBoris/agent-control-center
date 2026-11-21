import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ClientIdStore, HostConfig } from '@microsoft/agent-host-protocol/hosts';
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws';
import { guardHostActions } from './host-actions.js';

export interface HostEntry {
  id: string;
  label: string;
  /** WebSocket-адрес AHP-хоста, например ws://127.0.0.1:8089. */
  url: string;
  /** Файл с токеном подключения. Токен читается при каждом подключении и не покидает backend. */
  tokenFile?: string;
  /** Файловая система хоста совпадает с Mac, на котором запущен backend. */
  localFilesystem?: boolean;
  /** Модель панели по умолчанию для агентов, которые не публикуют её по AHP. */
  defaultModels?: Record<string, string>;
}

export interface AppConfig {
  listen: { host: string; port: number };
  /** Какие агенты показывать (по provider). Без списка показываются все, что предлагает хост. */
  agents?: string[];
  hosts: HostEntry[];
}

export async function loadConfig(path: string): Promise<AppConfig> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  const config = raw as Partial<AppConfig>;
  const listen = config.listen;
  if (!listen || typeof listen.host !== 'string' || !Number.isInteger(listen.port)) {
    throw new Error(`${path}: нужен listen { host, port }`);
  }
  const listenHost = listen.host === 'localhost' ? '127.0.0.1' : listen.host;
  if (listenHost !== '127.0.0.1' && listenHost !== '::1') {
    throw new Error(`${path}: listen.host должен быть 127.0.0.1, ::1 или localhost`);
  }
  if (!Array.isArray(config.hosts) || config.hosts.length === 0) {
    throw new Error(`${path}: нужен непустой список hosts`);
  }
  const ids = new Set<string>();
  for (const host of config.hosts) {
    if (!host || typeof host.id !== 'string' || typeof host.label !== 'string' || typeof host.url !== 'string') {
      throw new Error(`${path}: у каждого хоста должны быть id, label и url`);
    }
    if (ids.has(host.id)) throw new Error(`${path}: повторяющийся id хоста "${host.id}"`);
    if (host.localFilesystem !== undefined && typeof host.localFilesystem !== 'boolean') throw new Error(`${path}: localFilesystem должен быть boolean`);
    const defaults = host.defaultModels;
    if (defaults !== undefined && (!defaults || typeof defaults !== 'object' || Array.isArray(defaults) ||
        !Object.values(defaults).every(id => typeof id === 'string' && id.length > 0))) {
      throw new Error(`${path}: defaultModels должен сопоставлять id агентов и моделей`);
    }
    ids.add(host.id);
    new URL(host.url);
  }
  if (config.agents !== undefined && !(Array.isArray(config.agents) && config.agents.every(agent => typeof agent === 'string'))) {
    throw new Error(`${path}: agents должен быть списком строк`);
  }
  const baseDir = dirname(resolve(path));
  return {
    listen: { ...listen, host: listenHost },
    ...(config.agents ? { agents: config.agents } : {}),
    hosts: config.hosts.map(host => ({
      ...host,
      ...(host.tokenFile ? { tokenFile: resolve(baseDir, host.tokenFile) } : {}),
    })),
  };
}

export function toHostConfig(entry: HostEntry): HostConfig {
  return {
    id: entry.id,
    label: entry.label,
    transportFactory: async () => {
      const url = new URL(entry.url);
      if (entry.tokenFile) {
        // Agent Host VS Code принимает токен только в query-параметре tkn.
        url.searchParams.set('tkn', (await readFile(entry.tokenFile, 'utf8')).trim());
      }
      return guardHostActions(await WebSocketTransport.connect(url), entry.id);
    },
  };
}

/**
 * Хранит clientId каждого хоста на диске. Хост доигрывает пропущенные события
 * по clientId, поэтому после перезапуска backend он должен остаться прежним.
 */
export class FileClientIdStore implements ClientIdStore {
  constructor(private readonly path: string) {}

  async load(hostId: string): Promise<string | null> {
    return (await this.read())[hostId] ?? null;
  }

  async store(hostId: string, clientId: string): Promise<void> {
    const ids = await this.read();
    ids[hostId] = clientId;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(ids, null, 2)}\n`, { mode: 0o600 });
  }

  private async read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }
}
