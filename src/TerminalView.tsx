import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { HostOverview, TerminalState } from '../shared/protocol';
import { pathOf } from './format';
import { describeError, store, useChannel } from './store';
import {
  forgetTerminal, lastTerminal, rememberLastTerminal, rememberTerminal, savedTerminal, terminalChoice, terminalCwd,
} from './terminal-session';
import { DirectoryTree } from './ui/DirectoryTree';
import { directoryHistory, rememberDirectory } from './recent-directories';
import { isAbsoluteHostPath } from './session-config';

/**
 * xterm.js и его стили грузятся отдельным чанком: страница терминала — единственный
 * потребитель, и основной бандл панели не должен расти на размер эмулятора.
 */
const TerminalEmulator = lazy(() => import('./ui/TerminalEmulator'));

interface TerminalOrigin {
  hostId: string;
  directory: string;
  attached?: string;
}

/**
 * Что показать при открытии страницы: последнюю пару хост+папка и её сохранённый PTY.
 * Папка по умолчанию — запасной вариант, когда сохранённой пары нет. Приватный режим
 * может запретить localStorage целиком: тогда страница просто открывается формой.
 */
function restoreTerminal(storage: Storage, hosts: readonly HostOverview[]): TerminalOrigin {
  const host = hosts.find(candidate => candidate.status === 'connected') ?? hosts[0];
  const directory = pathOf(host?.defaultDirectory);
  try {
    const last = lastTerminal(storage);
    const hostId = last && hosts.some(candidate => candidate.id === last.hostId) ? last.hostId : host?.id ?? '';
    const path = last && last.hostId === hostId ? last.directory : directory;
    const attached = savedTerminal(storage, hostId, path);
    return { hostId, directory: path, ...(attached ? { attached } : {}) };
  } catch {
    // Приватный режим или запрет на localStorage: страница открывается формой, без подхвата.
    return { hostId: host?.id ?? '', directory };
  }
}

/**
 * Страница `#terminal`: один shell на страницу, хост и папка выбираются здесь же.
 * PTY живёт до «Закрыть терминал»: уход со страницы его не убивает, а F5 и возврат
 * подхватывают тот же URI из localStorage по паре хост+папка.
 */
export function TerminalView({ hosts, connected, onClose }: {
  hosts: readonly HostOverview[];
  connected: boolean;
  onClose(): void;
}) {
  // Первое открытие и F5 восстанавливают ту же пару хост+папка: без этого страница после
  // перезагрузки показывала бы форму (или терминал другой папки) и создавала второй PTY.
  const [initial] = useState(() => restoreTerminal(window.localStorage, hosts));
  const [hostId, setHostId] = useState(initial.hostId);
  const host = hosts.find(candidate => candidate.id === hostId);
  const [directory, setDirectory] = useState(initial.directory);
  /** URI подхваченного терминала: `undefined` — показываем форму открытия. */
  const [attached, setAttached] = useState(initial.attached);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [recent, setRecent] = useState(() => directoryHistory(window.localStorage, initial.hostId));

  const available = connected && host?.status === 'connected';
  // Сводка хостов приходит уже после первого рендера: до неё hostId пуст, и сохранённый URI
  // пары «хост+папка» ещё не с чем связать. Догоняем, как только хосты появились.
  useEffect(() => {
    if (hostId || hosts.length === 0) return;
    const restored = restoreTerminal(window.localStorage, hosts);
    setHostId(restored.hostId);
    setDirectory(restored.directory);
    setAttached(restored.attached);
    setRecent(directoryHistory(window.localStorage, restored.hostId));
  }, [hostId, hosts]);
  const channel = useChannel<TerminalState>(hostId, attached);
  const state = channel.state;

  const create = useCallback(async (forPath: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const { terminalUri } = await store.call<{ terminalUri: string }>({ op: 'createTerminal', hostId, directory: forPath });
      try { rememberTerminal(window.localStorage, hostId, forPath, terminalUri); }
      catch (failure) { store.notify(`Терминал не удалось запомнить: ${describeError(failure)}`); }
      setAttached(terminalUri);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }, [hostId]);

  /** Сохранённый URI сначала подхватывается; NotFound приводит к созданию нового (см. эффект ниже). */
  const open = useCallback(() => {
    if (!available || busy) return;
    if (!isAbsoluteHostPath(directory)) {
      setError('Укажите абсолютный путь к папке на хосте, например /Users/me/project');
      return;
    }
    setError(undefined);
    try {
      rememberDirectory(window.localStorage, hostId, directory);
      // Пара запоминается до выбора «подхватить или создать»: после F5 страница вернётся
      // и к подхваченному, и к новому терминалу именно этой папки.
      rememberLastTerminal(window.localStorage, hostId, directory);
    } catch (failure) { store.notify(`Папку не удалось запомнить: ${describeError(failure)}`); }
    setRecent(directoryHistory(window.localStorage, hostId));
    // Сохранённый URI подхватывается как есть; если его уже нет, эффект `terminalChoice`
    // пересоздаст PTY. Без сохранённого сразу создаём новый. Запрет на localStorage
    // (приватный режим) не мешает открыть терминал — просто его не получится подхватить.
    let saved: string | undefined;
    try { saved = savedTerminal(window.localStorage, hostId, directory); }
    catch (failure) { store.notify(`Сохранённый терминал недоступен: ${describeError(failure)}`); }
    setAttached(saved);
    if (!saved) void create(directory);
  }, [available, busy, directory, hostId, create]);

  // Закрытый или вычищенный PTY: `terminalChoice` превращает NotFound в решение «создать новый»,
  // а незавершённый снимок оставляет сохранённый URI в игре (иначе открывался бы второй PTY).
  // Попытка на URI запоминается: если хост откажет в создании, страница не будет долбить его вечно.
  const choice = attached ? terminalChoice(attached, channel) : undefined;
  const replace = choice?.kind === 'create';
  const replaced = useRef<string | undefined>(undefined);

  /** Забывает сохранённый URI: приватный режим может запретить запись, но это не повод падать. */
  const forgetSaved = useCallback((uri: string) => {
    try { forgetTerminal(window.localStorage, hostId, directory); }
    catch (failure) { store.notify(`Запись терминала не удалось обновить: ${describeError(failure)}`); }
    store.forgetChannelData(hostId, uri);
  }, [directory, hostId]);

  useEffect(() => {
    // Пока хост отключён, новый PTY не создать: дождёмся связи, чтобы не терять попытку.
    if (!attached || !replace || !available || replaced.current === attached) return;
    replaced.current = attached;
    forgetSaved(attached);
    void create(directory);
  }, [attached, replace, available, forgetSaved, directory, create]);

  const openNew = () => {
    if (attached) forgetSaved(attached);
    setAttached(undefined);
    if (directory) void create(directory);
  };

  const close = useCallback(async () => {
    if (!attached) return;
    setBusy(true);
    try {
      await store.call({ op: 'disposeTerminal', hostId, terminalUri: attached });
    } catch (failure) {
      store.notify(`Терминал не закрыт: ${describeError(failure)}`);
    } finally {
      // Даже если хост не подтвердил закрытие, запись в localStorage не должна вести на мёртвый URI.
      forgetSaved(attached);
      setAttached(undefined);
      setBusy(false);
    }
  }, [attached, forgetSaved, hostId]);

  const changeHost = (nextId: string) => {
    setHostId(nextId);
    setDirectory(pathOf(hosts.find(candidate => candidate.id === nextId)?.defaultDirectory));
    setAttached(undefined);
    setError(undefined);
    setRecent(directoryHistory(window.localStorage, nextId));
  };

  const lifecycle = state?.lifecycle;
  const running = lifecycle?.status === 'running';
  const cwd = terminalCwd(state, directory);
  const loaded = channel.state !== undefined || channel.missing === true || channel.error !== undefined;

  return (
    <div className="terminal-page">
      <header className="terminal-header">
        <button className="mobile-back" aria-controls="sidebar" onClick={onClose}>‹ Сессии</button>
        <h2>Терминал</h2>
        <div className="terminal-actions">
          {attached && (
            <button type="button" className="terminal-close" disabled={busy} onClick={() => void close()}>
              Закрыть терминал
            </button>
          )}
          <button type="button" onClick={onClose}>Закрыть</button>
        </div>
      </header>

      {attached ? (
        <>
          <div className="terminal-status" aria-live="polite">
            <span className={running ? 'dot dot-connected' : 'dot dot-disconnected'} aria-hidden />
            <strong>{host?.label ?? hostId}</strong>
            <code className="terminal-cwd" title={cwd}>{cwd}</code>
            <span className="muted">
              {lifecycle
                ? lifecycle.status === 'exited'
                  ? `завершён${lifecycle.exitCode !== undefined ? ` · код ${lifecycle.exitCode}` : ''}`
                  : 'выполняется'
                : 'подключаемся…'}
            </span>
            {state?.rows && state.cols ? <span className="muted">{state.cols}×{state.rows}</span> : null}
            {lifecycle?.status === 'exited' && (
              <button type="button" className="terminal-new" disabled={busy} onClick={openNew}>Открыть новый</button>
            )}
          </div>
          {channel.error && <p className="error-text" role="alert">{channel.error}</p>}
          {error && (
            <p className="error-text" role="alert">
              {error}
              <button type="button" className="terminal-new" disabled={busy} onClick={openNew}>Повторить</button>
            </p>
          )}
          {loaded ? (
            <Suspense fallback={<p className="terminal-placeholder" role="status">Загружаем эмулятор терминала…</p>}>
              <TerminalEmulator
                key={attached}
                hostId={hostId}
                uri={attached}
                state={channel.state}
                epoch={channel.epoch}
                interactive={running && connected}
                onNotice={message => store.notify(message)}
              />
            </Suspense>
          ) : (
            <p className="terminal-placeholder" role="status">Открываем терминал…</p>
          )}
        </>
      ) : (
        <form className="terminal-form" onSubmit={event => { event.preventDefault(); open(); }}>
          <label>
            Хост
            <select value={hostId} onChange={event => changeHost(event.target.value)} disabled={busy}>
              {hosts.map(candidate => (
                <option key={candidate.id} value={candidate.id} disabled={candidate.status !== 'connected'}>
                  {candidate.label}{candidate.status === 'connected' ? '' : ' (нет связи)'}
                </option>
              ))}
            </select>
          </label>
          <div className="directory-picker">
            <label htmlFor="terminal-directory">Папка терминала на хосте</label>
            <input
              id="terminal-directory"
              value={directory}
              onChange={event => setDirectory(event.target.value)}
              placeholder="/Users/me/project"
              spellCheck={false}
              required
              disabled={busy}
            />
            <div className="directory-actions">
              <DirectoryTree hostId={hostId} initialPath={directory} disabled={!available || busy} onChoose={setDirectory} />
            </div>
          </div>
          {recent.paths.length > 0 && (
            <label>
              Недавние папки
              <select value={recent.paths.includes(directory) ? directory : ''} onChange={event => { if (event.target.value) setDirectory(event.target.value); }} disabled={busy}>
                <option value="">Выберите недавнюю папку</option>
                {recent.paths.map(path => <option key={path} value={path}>{path}</option>)}
              </select>
            </label>
          )}
          <p className="muted terminal-note">
            Shell запускается на выбранном хосте без подтверждений команд и живёт до кнопки «Закрыть терминал».
            Свои брошенные терминалы панель закрывает сама.
          </p>
          {recent.error && <p className="error-text" role="alert">{recent.error}</p>}
          {error && <p className="error-text" role="alert">{error}</p>}
          <div className="row">
            <button type="submit" className="primary" disabled={!available || busy}>
              {busy ? 'Открываем…' : 'Открыть терминал'}
            </button>
            <button type="button" disabled={busy} onClick={onClose}>Отмена</button>
          </div>
        </form>
      )}
    </div>
  );
}
