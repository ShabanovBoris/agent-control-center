import { stableVersion } from '../scripts/agent-sdks.mjs';

/** Версия Agent Host из root `_meta.hostBuild`. */
export interface HostBuild { version: string; commit: string }

/** Разбирает `_meta.hostBuild`; нестабильная версия или чужой commit считаются отсутствием данных. */
export function readHostBuild(value: unknown): HostBuild | undefined {
  const build = value as Partial<HostBuild> | undefined;
  if (typeof build?.version !== 'string' || !stableVersion.test(build.version) ||
      typeof build.commit !== 'string' || !/^[a-f0-9]{40}$/.test(build.commit)) return undefined;
  return { version: build.version, commit: build.commit };
}
