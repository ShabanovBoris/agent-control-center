import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { HealthSnapshot, HostHealth, HostOverview, LogTail } from '../shared/protocol';
import { HOST_STATUS_LABEL, timeAgo } from './format';
import { describeError, store, useAppState } from './store';

const LOG_REFRESH_MS = 5000;
const SDK_LABEL = { codex: 'Codex', claude: 'Claude SDK' } as const;

type RestartPhase = 'idle' | 'running' | 'restartingBackend' | 'reconnecting' | 'done' | 'failed';

interface RestartState {
  phase: RestartPhase;
  message?: string;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function ago(iso: string | undefined): string | undefined {
  return iso ? timeAgo(iso) : undefined;
}

/** Живой статус берётся из `overview`, версии и история — из снимка `health`. */
interface HostRow {
  live?: HostOverview;
  health?: HostHealth;
}

function rowStatus(row: HostRow): HostOverview['status'] {
  return row.live?.status ?? row.health?.status ?? 'disconnected';
}

function HostCard({ row, connected, restarting, busy, onReconnect, error }: {
  row: HostRow;
  connected: boolean;
  restarting: boolean;
  busy: boolean;
  onReconnect(): void;
  error?: string;
}) {
  const { live, health } = row;
  const id = live?.id ?? health?.id ?? '';
  const label = live?.label ?? health?.label ?? id;
  const status = rowStatus(row);
  const problem = live?.error ?? health?.error;
  const build = health?.hostBuild?.version;
  const protocol = live?.protocolVersion ?? health?.protocolVersion;
  const sdk = health?.sdkVersions;
  const sdkText = sdk
    ? (['codex', 'claude'] as const).filter(agent => agent in sdk).map(agent => `${SDK_LABEL[agent]}: ${sdk[agent] ?? '—'}`).join(' · ')
    : undefined;
  const lastConnected = ago(health?.lastConnectedAt);
  const lastEvent = ago(health?.lastEventAt);
  return (
    <section className="health-card" aria-label={`Хост ${label}`}>
      <div className="health-host-head">
        <span className={`dot dot-${status}`} aria-hidden />
        <strong>{label}</strong>
        <span className="muted">{HOST_STATUS_LABEL[status]}</span>
        <span className="muted">{id}</span>
      </div>
      {problem && <p className="error-text">{problem}</p>}
      <dl className="health-fields">
        <Field label="Agent Host">{build ?? '—'}</Field>
        <Field label="AHP">{protocol ?? '—'}</Field>
        <Field label="Последнее подключение">{lastConnected ?? '—'}</Field>
        <Field label="Последнее событие">{lastEvent ?? '—'}</Field>
        <Field label="Активные сессии">{health?.activeSessions ?? '—'}</Field>
        <Field label="SDK агентов">{sdkText ?? '—'}</Field>
        <Field label="Журнал">{health?.logFile ?? 'нет (удалённый хост)'}</Field>
      </dl>
      {health?.sdkError && <p className="error-text">Версии SDK: {health.sdkError}</p>}
      <div>
        <h4 className="health-subheading">Последние ошибки подключения</h4>
        {health?.recentErrors.length ? (
          <ul className="host-issues">
            {health.recentErrors.map((issue, index) => (
              <li key={`${issue.at}-${index}`}>
                <span>{issue.message}</span>
                {issue.count > 1 && <span className="badge badge-warn">×{issue.count}</span>}
                <time className="muted" dateTime={issue.at}>{timeAgo(issue.at)}</time>
              </li>
            ))}
          </ul>
        ) : <p className="muted">С момента запуска backend ошибок не было.</p>}
      </div>
      {status !== 'connected' && (
        <div className="host-problem">
          <button type="button" disabled={!connected || busy || restarting} onClick={onReconnect}>
            {busy ? 'Подключаем…' : 'Подключить снова'}
          </button>
          {error && <span className="error-text" role="alert">{error}</span>}
        </div>
      )}
    </section>
  );
}

export function HealthView({ onClose }: { onClose(): void }) {
  const { connection, overview } = useAppState();
  const connected = connection === 'open';
  const [snapshot, setSnapshot] = useState<HealthSnapshot>();
  const [loadedAt, setLoadedAt] = useState<string>();
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string>();
  const healthRequest = useRef(0);
  const [selectedLogHost, setSelectedLogHost] = useState<string>();
  const [tail, setTail] = useState<LogTail>();
  const [tailAt, setTailAt] = useState<string>();
  const [logError, setLogError] = useState<string>();
  const [logLoading, setLogLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const tailInFlight = useRef(false);
  const [restart, setRestart] = useState<RestartState>({ phase: 'idle' });
  const [busyHost, setBusyHost] = useState<string>();
  const [hostErrors, setHostErrors] = useState<Readonly<Record<string, string>>>({});

  const loadHealth = useCallback(async () => {
    const request = ++healthRequest.current;
    setHealthLoading(true);
    try {
      const next = await store.call<HealthSnapshot>({ op: 'health' });
      if (request !== healthRequest.current) return;
      setSnapshot(next);
      setLoadedAt(new Date().toISOString());
      setHealthError(undefined);
    } catch (error) {
      if (request === healthRequest.current) setHealthError(describeError(error));
    } finally {
      if (request === healthRequest.current) setHealthLoading(false);
    }
  }, []);

  useEffect(() => { void loadHealth(); }, [loadHealth]);
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnected.current) void loadHealth();
    wasConnected.current = connected;
  }, [connected, loadHealth]);

  useEffect(() => {
    if (restart.phase === 'restartingBackend' && !connected) setRestart({ phase: 'reconnecting' });
    if (restart.phase === 'reconnecting' && connected) {
      setRestart({ phase: 'done' });
      void loadHealth();
    }
  }, [restart.phase, connected, loadHealth]);

  const rows = useMemo(() => {
    const live = new Map(overview.hosts.map(item => [item.id, item]));
    const health = new Map((snapshot?.hosts ?? []).map(item => [item.id, item]));
    const ids = [...live.keys()];
    for (const id of health.keys()) if (!live.has(id)) ids.push(id);
    return ids.map((id): HostRow => ({ live: live.get(id), health: health.get(id) }));
  }, [overview.hosts, snapshot]);

  const logHosts = useMemo(() => (snapshot?.hosts ?? []).filter(item => item.logFile), [snapshot]);
  // Выбор пользователя может устареть после обновления снимка: показываем первый доступный журнал.
  const logHostId = logHosts.some(item => item.id === selectedLogHost) ? selectedLogHost : logHosts[0]?.id;
  const labelOf = useCallback((id: string) =>
    overview.hosts.find(item => item.id === id)?.label ?? snapshot?.hosts.find(item => item.id === id)?.label ?? id,
  [overview.hosts, snapshot]);

  useEffect(() => {
    setTail(undefined);
    setTailAt(undefined);
    setLogError(undefined);
    setLogLoading(false);
  }, [logHostId]);

  useEffect(() => {
    if (!logHostId || !connected) return;
    let cancelled = false;
    const load = async () => {
      // Скрытая вкладка/телефон в фоне не тратит запросы; при возврате тик догонит.
      if (tailInFlight.current || document.visibilityState === 'hidden') return;
      tailInFlight.current = true;
      setLogLoading(true);
      try {
        const next = await store.call<LogTail>({ op: 'readLog', hostId: logHostId });
        if (cancelled) return;
        setTail(next);
        setTailAt(new Date().toISOString());
        setLogError(undefined);
      } catch (error) {
        if (!cancelled) setLogError(describeError(error));
      } finally {
        tailInFlight.current = false;
        if (!cancelled) setLogLoading(false);
      }
    };
    void load();
    const timer = autoRefresh ? window.setInterval(() => void load(), LOG_REFRESH_MS) : undefined;
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [logHostId, connected, autoRefresh, reloadToken]);

  const reconnect = async (hostId: string) => {
    setBusyHost(hostId);
    setHostErrors(current => {
      const next = { ...current };
      delete next[hostId];
      return next;
    });
    try {
      await store.call({ op: 'reconnectHost', hostId });
      await loadHealth();
    } catch (error) {
      setHostErrors(current => ({ ...current, [hostId]: describeError(error) }));
    } finally {
      setBusyHost(undefined);
    }
  };

  const restartServices = async () => {
    setRestart({ phase: 'running' });
    try {
      const result = await store.call<{ restartBackend: boolean }>({ op: 'restartServices' });
      setRestart({ phase: result.restartBackend ? 'restartingBackend' : 'done' });
    } catch (error) {
      setRestart({ phase: 'failed', message: describeError(error) });
    }
  };

  const restarting = restart.phase === 'running' || restart.phase === 'restartingBackend' || restart.phase === 'reconnecting';
  const backend = snapshot?.backend;

  return (
    <div className="health">
      <header className="health-header">
        <button className="mobile-back" aria-controls="sidebar" onClick={onClose}>‹ Сессии</button>
        <h2>Здоровье хостов и журналы</h2>
        <div className="health-actions">
          <button type="button" disabled={!connected || healthLoading} onClick={() => void loadHealth()}>
            {healthLoading ? 'Обновляем…' : 'Обновить данные'}
          </button>
          <button type="button" disabled={!connected || restarting} onClick={() => void restartServices()}>
            {restarting ? 'Перезапускаем…' : 'Перезапустить службы'}
          </button>
          <button type="button" onClick={onClose}>Закрыть</button>
        </div>
      </header>

      {healthError && <p className="error-text" role="alert">Не удалось получить снимок: {healthError}</p>}
      {restart.phase === 'running' && <p role="status">Перезапускаем службы…</p>}
      {restart.phase === 'restartingBackend' && <p role="status">Backend перезапускается…</p>}
      {restart.phase === 'reconnecting' && <p role="status">Ждём подключения к backend…</p>}
      {restart.phase === 'done' && <p role="status">Службы перезапущены.</p>}
      {restart.phase === 'failed' && <p className="error-text" role="alert">Перезапуск не выполнен: {restart.message}</p>}

      <section className="health-card" aria-label="Backend">
        <div className="health-host-head">
          <span className={`dot dot-${connected ? 'connected' : connection === 'connecting' ? 'connecting' : 'disconnected'}`} aria-hidden />
          <strong>Backend</strong>
          <span className="muted">{connected ? 'Связь есть' : connection === 'connecting' ? 'Подключение…' : 'Нет связи'}</span>
        </div>
        <dl className="health-fields">
          <Field label="Версия панели">{backend?.version ?? '—'}</Field>
          <Field label="Клиент AHP">{backend?.ahpVersion ?? '—'}</Field>
          <Field label="Запущен">{backend ? new Date(backend.startedAt).toLocaleString('ru-RU') : '—'}</Field>
          <Field label="Доступ с телефона">{backend ? (backend.phoneAccess ? 'включён (Tailscale)' : 'выключен') : '—'}</Field>
          <Field label="Снимок">{loadedAt ? `${new Date(loadedAt).toLocaleTimeString('ru-RU')} · ${timeAgo(loadedAt)}` : '—'}</Field>
        </dl>
        <p className="muted">Backend пишет журнал только в stdout: файла журнала backend нет. Ниже — журналы локальных хостов.</p>
      </section>

      {rows.length === 0
        ? <p className="muted">Хосты не настроены или ещё не подключены.</p>
        : rows.map(row => {
          const id = row.live?.id ?? row.health?.id ?? '';
          return (
            <HostCard
              key={id}
              row={row}
              connected={connected}
              restarting={restarting}
              busy={busyHost === id}
              error={hostErrors[id]}
              onReconnect={() => void reconnect(id)}
            />
          );
        })}

      <section className="health-card" aria-label="Журнал хоста">
        <div className="health-header">
          <h3>Журнал хоста</h3>
          <div className="health-actions">
            <label className="log-auto muted">
              <input type="checkbox" checked={autoRefresh} onChange={event => setAutoRefresh(event.target.checked)} />
              Автообновление
            </label>
            <button type="button" disabled={!connected || logLoading || !logHostId} onClick={() => setReloadToken(token => token + 1)}>
              {logLoading ? 'Читаем…' : 'Обновить'}
            </button>
          </div>
        </div>
        {logHosts.length === 0 ? (
          <p className="muted">{snapshot ? 'Журналы доступны только для локальных хостов проекта (macOS).' : 'Список журналов появится после загрузки снимка.'}</p>
        ) : (
          <>
            <div className="log-toolbar">
              <select aria-label="Хост журнала" value={logHostId ?? ''} onChange={event => setSelectedLogHost(event.target.value)}>
                {logHosts.map(item => <option key={item.id} value={item.id}>{labelOf(item.id)}</option>)}
              </select>
              {tail?.status === 'ok' && (
                <span className="muted">
                  {tail.fileName}
                  {tail.updatedAt && ` · изменён ${timeAgo(tail.updatedAt)}`}
                  {tailAt && ` · прочитан ${timeAgo(tailAt)}`}
                  {tail.truncated && ' · показан хвост'}
                </span>
              )}
            </div>
            {logError && <p className="error-text" role="alert">{logError}</p>}
            {tail?.status === 'ok' && (tail.lines.length > 0
              ? <pre className="log-tail">{tail.lines.join('\n')}</pre>
              : <p className="muted">Журнал пуст.</p>)}
            {tail?.status === 'missing' && <p className="muted">{tail.message}</p>}
            {tail?.status === 'unavailable' && <p className="error-text">{tail.message}</p>}
          </>
        )}
      </section>
    </div>
  );
}
