import { setTimeout as delay } from 'node:timers/promises';
import type { ChildProcess } from 'node:child_process';
import type { Overview } from '../shared/protocol.js';
import type { Hub } from './hub.js';
import { readHostBuild, type HostBuild } from './host-build.js';
import {
  localInstance,
  restartLocalHost,
  startLocalHost,
  waitForLocalHost,
  type HostInstance,
  type LocalHost,
} from './local-hosts.js';
import type { ProjectUpdates } from './updates.js';

export const RESTART_TIMEOUT_MS = 240_000;

/**
 * Помечает хосты, которые backend перезапускает планово. `up --supervised` по этому
 * флагу отличает плановый перезапуск от падения и не спавнит второй процесс.
 */
export function withRestarting(overview: Overview, isRestarting: (hostId: string) => boolean): Overview {
  if (!overview.hosts.some(host => isRestarting(host.id))) return overview;
  return {
    ...overview,
    hosts: overview.hosts.map(host => isRestarting(host.id) ? { ...host, restarting: true } : host),
  };
}

export interface RestartHost extends LocalHost {
  instance?: HostInstance;
}

export interface RestartServicesOptions {
  hosts: readonly LocalHost[];
  hub: Pick<Hub, 'hostGeneration' | 'hostRoot'>;
  updates: Pick<ProjectUpdates, 'exclusive' | 'beginRestart'>;
  restartBackend: () => Promise<void>;
  inspectInstance?: (host: LocalHost) => Promise<HostInstance | undefined>;
  restartHost?: (
    host: LocalHost,
    instance: HostInstance,
    build: HostBuild,
    ready: () => boolean,
    beforeStop: () => Promise<void>,
  ) => Promise<void>;
  startHost?: (host: LocalHost) => Promise<ChildProcess>;
  waitForHost?: (host: LocalHost, ready: () => boolean, child: ChildProcess, signal: AbortSignal) => Promise<void>;
}

async function activeSessions(hub: RestartServicesOptions['hub'], host: LocalHost): Promise<number> {
  const active = (await hub.hostRoot(host.id)).activeSessions;
  if (active === undefined) throw new Error(`Хост «${host.label}» не сообщил число активных сессий.`);
  return active;
}

function ready(hub: RestartServicesOptions['hub'], host: LocalHost, previous: number | undefined): () => boolean {
  return () => {
    const generation = hub.hostGeneration(host.id);
    return generation !== undefined && generation !== previous;
  };
}

export async function restartServices(options: RestartServicesOptions): Promise<void> {
  const inspect = options.inspectInstance ?? localInstance;
  const restart = options.restartHost ?? restartLocalHost;
  const start = options.startHost ?? (async (host: LocalHost) => startLocalHost(host));
  const wait = options.waitForHost ?? waitForLocalHost;
  await options.updates.exclusive(async () => {
    const targets: RestartHost[] = [];
    // Сначала проверяем всю конфигурацию: активный хост не останавливается из-за ошибки другого.
    for (const host of options.hosts) {
      const instance = await inspect(host);
      if (instance && await activeSessions(options.hub, host) !== 0) {
        throw new Error(`Завершите активные задачи на хосте «${host.label}» и повторите перезапуск.`);
      }
      targets.push({ ...host, ...(instance ? { instance } : {}) });
    }
    for (const host of targets) options.updates.beginRestart(host.id);
    for (const host of targets) {
      if (!host.instance) {
        console.log(`[services] Запуск остановленного хоста «${host.label}».`);
        const previous = options.hub.hostGeneration(host.id);
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(new Error(`Таймаут запуска хоста «${host.label}».`)), RESTART_TIMEOUT_MS);
        try {
          const child = await start(host);
          await wait(host, ready(options.hub, host, previous), child, controller.signal);
        } finally {
          clearTimeout(deadline);
        }
        if (await activeSessions(options.hub, host) !== 0) {
          throw new Error(`Хост «${host.label}» запущен с активными задачами. Проверьте его состояние.`);
        }
        console.log(`[services] Хост «${host.label}» подключён.`);
        continue;
      }
      const instance = await inspect(host);
      if (!instance || instance.id !== host.instance.id) {
        throw new Error(`Хост «${host.label}» изменился перед перезапуском. Повторите команду.`);
      }
      const root = await options.hub.hostRoot(host.id);
      if (root.activeSessions !== 0) {
        throw new Error(`На хосте «${host.label}» появились активные задачи. Перезапуск отменён.`);
      }
      const previous = options.hub.hostGeneration(host.id);
      console.log(`[services] Перезапуск хоста «${host.label}».`);
      const parsed = readHostBuild(root._meta?.hostBuild);
      if (!parsed) throw new Error('Хост не сообщил корректную версию Agent Host.');
      await restart(host, instance, parsed, ready(options.hub, host, previous), async () => {
        if (await activeSessions(options.hub, host) !== 0) {
          throw new Error(`На хосте «${host.label}» появились активные задачи. Перезапуск отменён.`);
        }
      });
      console.log(`[services] Хост «${host.label}» подключён.`);
    }
    // Замена backend запускается только после успешной обработки всех хостов.
    await options.restartBackend();
    console.log('[services] Backend перезапускается.');
  });
}

export interface ConnectionProbe {
  connected: (hostId: string) => number | undefined;
}

export async function waitForConnections(
  services: ConnectionProbe,
  hosts: readonly LocalHost[],
  expected: ReadonlyMap<string, number | undefined>,
  timeoutMs = RESTART_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hosts.every(host => {
      const current = services.connected(host.id);
      return current !== undefined && current !== expected.get(host.id);
    })) return;
    const disconnected = hosts.filter(host => services.connected(host.id) === undefined).map(host => host.label);
    if (disconnected.length > 0) console.log(`[services] Ожидание: ${disconnected.join(', ')}.`);
    await delay(500);
  }
  throw new Error('Не все хосты подключились за отведённое время. Проверьте журналы .local/host.log и .local/gemini-host.log.');
}
