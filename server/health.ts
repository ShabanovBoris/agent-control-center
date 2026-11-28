import { readFile } from 'node:fs/promises';
import type { HealthSnapshot, HostHealth, HostOverview, SdkVersions } from '../shared/protocol.js';
import type { HostBuild } from './host-build.js';
import type { HostDiagnostics } from './hub.js';
import type { LogSource } from './logs.js';
import { redactSecrets } from '../shared/redact.js';

/** Читает версии SDK запущенного хоста; `undefined` — хост запущен не скриптами проекта. */
export type SdkVersionInspector = (
  hostId: string,
  build: HostBuild | undefined,
) => Promise<SdkVersions | undefined>;

export interface HealthBackendInput {
  version: string;
  ahpVersion: string;
  startedAt: number;
  phoneAccess: boolean;
}

export interface HealthInput {
  hosts: readonly Pick<HostOverview, 'id' | 'label' | 'status' | 'error' | 'protocolVersion'>[];
  diagnostics: readonly HostDiagnostics[];
  logs: readonly LogSource[];
  backend: HealthBackendInput;
  sdkVersions?: SdkVersionInspector;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hostHealth(
  host: HealthInput['hosts'][number],
  diagnostics: HostDiagnostics | undefined,
  log: LogSource | undefined,
  sdkVersions: SdkVersions | undefined,
  sdkError: string | undefined,
): HostHealth {
  return {
    id: host.id,
    label: host.label,
    status: host.status,
    // Редакция повторяется здесь на случай, если snapshot пришёл не из Hub.
    ...(host.error === undefined ? {} : { error: redactSecrets(host.error) }),
    ...(host.protocolVersion ? { protocolVersion: host.protocolVersion } : {}),
    ...(diagnostics?.hostBuild ? { hostBuild: diagnostics.hostBuild } : {}),
    ...(diagnostics?.lastConnectedAt ? { lastConnectedAt: diagnostics.lastConnectedAt } : {}),
    ...(diagnostics?.lastEventAt ? { lastEventAt: diagnostics.lastEventAt } : {}),
    ...(diagnostics?.activeSessions === undefined ? {} : { activeSessions: diagnostics.activeSessions }),
    ...(sdkVersions ? { sdkVersions } : {}),
    ...(sdkError ? { sdkError: redactSecrets(sdkError) } : {}),
    recentErrors: (diagnostics?.issues ?? []).map(issue => ({ ...issue, message: redactSecrets(issue.message) })),
    ...(log ? { logFile: log.fileName } : {}),
  };
}

/** Собирает снимок здоровья: живой статус из `overview`, остальное — из диагностики Hub. */
export async function collectHealth(input: HealthInput): Promise<HealthSnapshot> {
  const diagnostics = new Map(input.diagnostics.map(entry => [entry.id, entry]));
  const logs = new Map(input.logs.map(entry => [entry.hostId, entry]));
  const hosts = await Promise.all(input.hosts.map(async (host): Promise<HostHealth> => {
    let sdkVersions: SdkVersions | undefined;
    let sdkError: string | undefined;
    if (input.sdkVersions) {
      try { sdkVersions = await input.sdkVersions(host.id, diagnostics.get(host.id)?.hostBuild); }
      catch (error) { sdkError = messageOf(error); }
    }
    return hostHealth(host, diagnostics.get(host.id), logs.get(host.id), sdkVersions, sdkError);
  }));
  return {
    backend: {
      version: input.backend.version,
      ahpVersion: input.backend.ahpVersion,
      startedAt: new Date(input.backend.startedAt).toISOString(),
      phoneAccess: input.backend.phoneAccess,
    },
    hosts,
  };
}

/** Версия панели из package.json: обязательная часть проекта, поэтому ошибка валит старт backend. */
export async function readAppVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const version = (manifest as { version?: unknown }).version;
  if (typeof version !== 'string' || !version) throw new Error('В package.json не указана версия панели.');
  return version;
}