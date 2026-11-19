import type { UpdateCheck } from '../shared/protocol.js';
import { agentPackages, compareVersions, resolveAgentSdk, stableVersion } from '../scripts/agent-sdks.mjs';
import { installedAhpVersion, installVersion, latestVersion, type UpdateComponent, type UpdateVersions } from '../scripts/update-agents.mjs';
import type { Hub } from './hub.js';
import { canUpdateSdk, localInstance, restartLocalHost, runningSdks, type HostBuild, type LocalHost } from './local-hosts.js';

const agentNames = { codex: 'Codex', claude: 'Claude SDK' };
type Agent = keyof typeof agentPackages;
type Instance = NonNullable<Awaited<ReturnType<typeof localInstance>>>;

interface HostState {
  host: LocalHost;
  instance: Instance;
  build: HostBuild;
  active: number | undefined;
  versions: Record<Agent, string | null>;
}

interface RestartTarget {
  state: HostState;
  versions: Partial<Record<Agent, string>>;
  build?: HostBuild;
}

export interface UpdatePlan {
  preview: UpdateCheck;
  install: UpdateVersions;
  targets: RestartTarget[];
  restartBackend: boolean;
}

function hostBuild(value: unknown): HostBuild | undefined {
  const build = value as Partial<HostBuild> | undefined;
  if (typeof build?.version !== 'string' || !stableVersion.test(build.version) ||
      typeof build.commit !== 'string' || !/^[a-f0-9]{40}$/.test(build.commit)) return undefined;
  return { version: build.version, commit: build.commit };
}

async function latestHostBuild(): Promise<HostBuild> {
  const response = await fetch(`https://update.code.visualstudio.com/api/update/server-darwin-${process.arch}/stable/latest`, {
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Служба обновлений VS Code вернула HTTP ${response.status}.`);
  const metadata = await response.json();
  const build = hostBuild({ version: metadata.productVersion, commit: metadata.version });
  if (!build) throw new Error('Служба обновлений VS Code не вернула версию Agent Host.');
  return build;
}

function blocked(states: HostState[]): string | undefined {
  if (states.some(state => state.active === undefined)) return 'Статус активности хостов недоступен. Повторите проверку.';
  if (states.some(state => state.active !== 0)) return 'Завершите активные задачи на хостах и проверьте обновления снова.';
}

export class ProjectUpdates {
  private applying = false;
  private readonly restarting = new Set<string>();

  constructor(private readonly hosts: LocalHost[], private readonly hub: Hub, private readonly runningAhp: string) {}

  isRestarting(hostId: string): boolean { return this.restarting.has(hostId); }

  private async inspect(host: LocalHost): Promise<HostState> {
    const instance = await localInstance(host);
    if (!instance) throw new Error(`Хост «${host.label}» должен быть запущен скриптом этого проекта через VS Code Stable.`);
    const root = await this.hub.hostRoot(host.id);
    const build = hostBuild(root._meta?.hostBuild);
    if (!build) throw new Error(`Хост «${host.label}» не сообщил версию Agent Host.`);
    return { host, instance, build, active: root.activeSessions, versions: await runningSdks(host, instance, build) };
  }

  async check(): Promise<UpdatePlan> {
    if (this.applying) throw new Error('Обновление уже выполняется.');
    const connected = this.hosts.filter(host => this.hub.hostGeneration(host.id) !== undefined);
    if (connected.length === 0) throw new Error('Для проверки подключите локальный Agent Host этого проекта.');
    const [states, release, ahp, codex, claude] = await Promise.all([
      Promise.all(connected.map(host => this.inspect(host))), latestHostBuild(), latestVersion('ahp'),
      latestVersion('codex'), latestVersion('claude'),
    ]);
    const latest = { codex, claude };
    const changes: UpdateCheck['changes'] = [];
    const install: UpdateVersions = {};
    const targets: RestartTarget[] = [];

    for (const state of states) {
      const { host, instance, build, versions } = state;
      const label = host.id === 'gemini' ? 'Gemini' : 'Основной хост';
      const target: RestartTarget = { state, versions: {} };
      if (release.commit !== build.commit && compareVersions(release.version, build.version) >= 0) {
        target.build = release;
        changes.push({ name: `Agent Host · ${label}`, current: build.version, available: release.version });
      }
      for (const agent of host.agents) {
        if (!canUpdateSdk(agent, host, instance)) continue;
        const cached = await resolveAgentSdk(agent, host.serverData);
        const cachedVersion = cached?.split('/').at(-2);
        const available = cachedVersion && stableVersion.test(cachedVersion) && compareVersions(cachedVersion, latest[agent]) > 0
          ? cachedVersion : latest[agent];
        const current = versions[agent];
        if (current !== null && compareVersions(available, current) <= 0) continue;
        target.versions[agent] = available;
        if (available === latest[agent]) install[agent] = available;
        changes.push({ name: `${agentNames[agent]} · ${label}`, current, available });
      }
      if (target.build || Object.keys(target.versions).length > 0) targets.push(target);
    }

    const installed = await installedAhpVersion();
    const availableAhp = compareVersions(installed, ahp) > 0 ? installed : ahp;
    const restartBackend = compareVersions(availableAhp, this.runningAhp) > 0;
    if (restartBackend) {
      changes.push({ name: 'Клиент AHP', current: this.runningAhp, available: availableAhp });
      if (compareVersions(availableAhp, installed) > 0) install.ahp = availableAhp;
    }
    return { preview: { changes, restartBlocked: blocked(restartBackend ? states : targets.map(target => target.state)) }, install, targets, restartBackend };
  }

  private async ensureIdle(host: LocalHost, expected?: Instance): Promise<HostState> {
    const state = await this.inspect(host);
    if (expected && state.instance.id !== expected.id) throw new Error(`Хост «${host.label}» изменился. Проверьте обновления заново.`);
    const reason = blocked([state]);
    if (reason) throw new Error(reason);
    return state;
  }

  async apply(plan: UpdatePlan): Promise<boolean> {
    if (!plan.preview.changes.length) throw new Error('Доступных обновлений нет.');
    if (this.applying) throw new Error('Обновление уже выполняется.');
    this.applying = true;
    try {
      const backendHosts = plan.restartBackend ? this.hosts.filter(host => this.hub.hostGeneration(host.id) !== undefined) : [];
      for (const target of plan.targets) await this.ensureIdle(target.state.host, target.state.instance);
      for (const host of backendHosts) await this.ensureIdle(host);
      const downloads = Object.entries(plan.install) as [UpdateComponent, string][];
      const results = await Promise.allSettled(downloads.map(([component, version]) => installVersion(component, version)));
      const failed = results.findIndex(result => result.status === 'rejected');
      if (failed !== -1) {
        console.warn('[updates] Контроль установки', results[failed]);
        throw new Error(`Не удалось установить обновление ${downloads[failed]?.[0]}. Проверьте журнал backend.`);
      }

      for (const { state } of plan.targets) this.restarting.add(state.host.id);
      for (const host of backendHosts) this.restarting.add(host.id);
      for (const target of plan.targets) {
        const { host, instance, build } = await this.ensureIdle(target.state.host, target.state.instance);
        const previous = this.hub.hostGeneration(host.id);
        await restartLocalHost(host, instance, build, () => {
          const generation = this.hub.hostGeneration(host.id);
          return generation !== undefined && generation !== previous;
        });
        const updated = await this.inspect(host);
        for (const agent of host.agents) {
          const expected = target.versions[agent];
          const actual = updated.versions[agent];
          if (expected && (!actual || compareVersions(actual, expected) < 0)) {
            throw new Error(`Хост «${host.label}» запущен с прежней версией ${agentNames[agent]}.`);
          }
        }
        if (target.build && updated.build.commit === build.commit) throw new Error(`Хост «${host.label}» запущен с прежней сборкой Agent Host.`);
      }
      for (const host of backendHosts) await this.ensureIdle(host);
      if (plan.restartBackend && compareVersions(await installedAhpVersion(), this.runningAhp) <= 0) {
        throw new Error('Новая версия клиента AHP не установлена. Проверьте обновления снова.');
      }
      return plan.restartBackend;
    } finally {
      this.restarting.clear();
      this.applying = false;
    }
  }
}
