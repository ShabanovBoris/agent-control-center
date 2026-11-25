import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type { HostOverview, TerminalState } from '../shared/protocol';
import { directoryName, normalizeDirectoryPath } from '../shared/directory';
import { channelKey } from '../shared/reduce';
import { pathOf } from './format';
import { describeError, store, useChannels } from './store';
import {
  forgetSelectedTerminal, forgetTerminalLabel, lastTerminalForm, nextTerminalLabel,
  rememberLastTerminalForm, rememberSelectedTerminal, rememberTerminalLabel, selectedTerminal,
  terminalCwd, terminalLabels, terminalRowLabels, terminalStatusText,
} from './terminal-session';
import { DirectoryTree } from './ui/DirectoryTree';
import { TerminalList, type TerminalListEntry } from './ui/TerminalList';
import { directoryHistory, rememberDirectory } from './recent-directories';
import { isAbsoluteHostPath } from './session-config';

/**
 * xterm.js и его стили грузятся отдельным чанком: страница терминала — единственный
 * потребитель, и основной бандл панели не должен расти на размер эмулятора.
 */
const TerminalEmulator = lazy(() => import('./ui/TerminalEmulator'));

/** Терминал, созданный этим устройством и ещё не появившийся в overview. */
interface PendingTerminal {
  hostId: string;
  uri: string;
  title: string;
  directory: string;
}

/** Строка общего списка: всё, что нужно для выбора и статуса. */
interface TerminalEntry {
  hostId: string;
  hostLabel: string;
  uri: string;
  title: string;
  /** lifecycle из overview/pending: строка показывает статус до прихода снимка канала. */
  lifecycle?: TerminalState['lifecycle'];
  /** Запрошенная папка pending-терминала: cwd из состояния появится после снимка. */
  directory?: string;
}

const rowKey = (hostId: string, uri: string): string => channelKey(hostId, uri);

/** Приватный режим может запретить localStorage: страница открывается без выбора. */
function readSelection(): { hostId: string; uri: string } | undefined {
  try { return selectedTerminal(window.localStorage); } catch { return undefined; }
}

function readForm(): { hostId: string; directory: string } | undefined {
  try { return lastTerminalForm(window.localStorage); } catch { return undefined; }
}

/** Подписи строк из localStorage: в приватном режиме остаются хост-заголовки. */
function readLabels(): ReadonlyMap<string, string> {
  try { return terminalLabels(window.localStorage); } catch { return new Map(); }
}

/**
 * Страница `#terminal`: общий список всех своих PTY backend и один активный экран.
 * Набор приходит из overview (backend читает root хоста), поэтому PTY живут до `×`
 * на своей строке, а F5 и возврат на страницу восстанавливают те же сессии.
 */
export function TerminalView({ hosts, connected, overviewLoaded, onClose }: {
  hosts: readonly HostOverview[];
  connected: boolean;
  overviewLoaded: boolean;
  onClose(): void;
}) {
  // Выбор читается синхронно при монтировании: после F5 он уже в состоянии к первой сводке.
  const [selected, setSelected] = useState(readSelection);
  const [pending, setPending] = useState<ReadonlyMap<string, PendingTerminal>>(() => new Map());
  const [labels, setLabels] = useState(readLabels);
  const [closing, setClosing] = useState<ReadonlySet<string>>(() => new Set());
  /** Строки с `disposeTerminal` в полёте: их `×` заблокирована до ответа хоста. */
  const [closingBusy, setClosingBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [formOpen, setFormOpen] = useState(false);
  const [formHostId, setFormHostId] = useState(() => readForm()?.hostId ?? '');
  const [formDirectory, setFormDirectory] = useState(() => readForm()?.directory ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [recent, setRecent] = useState(() => directoryHistory(window.localStorage, readForm()?.hostId ?? ''));

  /** Overview + только что созданные PTY; закрываемые строки скрыты до обновления root. */
  const entries = useMemo(() => {
    const map = new Map<string, TerminalEntry>();
    for (const host of hosts) {
      for (const terminal of host.terminals ?? []) {
        map.set(rowKey(host.id, terminal.resource), {
          hostId: host.id,
          hostLabel: host.label,
          uri: terminal.resource,
          title: terminal.title,
          lifecycle: terminal.lifecycle,
        });
      }
    }
    for (const [key, item] of pending) {
      if (map.has(key)) continue;
      map.set(key, {
        hostId: item.hostId,
        hostLabel: hosts.find(host => host.id === item.hostId)?.label ?? item.hostId,
        uri: item.uri,
        title: item.title,
        directory: item.directory,
      });
    }
    return [...map.values()].filter(entry => !closing.has(rowKey(entry.hostId, entry.uri)));
  }, [hosts, pending, closing]);

  // Все видимые терминалы под наблюдением backend-а: их вывод не теряется при переключении,
  // а вытеснение «старейшего без наблюдателей» не срабатывает, пока страница открыта.
  const channels = useChannels(entries.map(entry => ({ hostId: entry.hostId, uri: entry.uri })));

  // PTY, закрытый на другом устройстве или хостом, исчезает из списка, а не висит мёртвым.
  const rows = entries.filter(entry => channels.get(rowKey(entry.hostId, entry.uri))?.missing !== true);
  const overviewSignature = rows.map(entry => rowKey(entry.hostId, entry.uri)).join('\n');

  const selectedKey = selected ? rowKey(selected.hostId, selected.uri) : undefined;
  const activeIndex = rows.findIndex(entry => rowKey(entry.hostId, entry.uri) === selectedKey);
  const active = activeIndex >= 0 ? rows[activeIndex] : rows[0];
  const activeKey = active ? rowKey(active.hostId, active.uri) : undefined;
  const activeView = activeKey ? channels.get(activeKey) : undefined;
  const activeState = activeView?.state as TerminalState | undefined;

  const rememberSelection = useCallback((hostId: string, uri: string) => {
    try { rememberSelectedTerminal(window.localStorage, hostId, uri); }
    catch (failure) { store.notify(`Выбор терминала не удалось запомнить: ${describeError(failure)}`); }
  }, []);

  const select = useCallback((hostId: string, uri: string) => {
    setSelected({ hostId, uri });
    rememberSelection(hostId, uri);
    setFormOpen(false);
    setError(undefined);
  }, [rememberSelection]);

  // Первая сводка — точка, после которой можно сверять сохранённый выбор со списком.
  // До неё эффект молчит: иначе F5 терял бы выбранный URI ещё до прихода overview.
  useEffect(() => {
    if (!overviewLoaded) return;
    if (rows.length === 0) {
      setSelected(undefined);
      setFormOpen(true);
      if (!selected) return;
      try { forgetSelectedTerminal(window.localStorage); } catch { /* приватный режим */ }
      return;
    }
    if (selected && rows.some(entry => rowKey(entry.hostId, entry.uri) === rowKey(selected.hostId, selected.uri))) return;
    const first = rows[0]!;
    setSelected({ hostId: first.hostId, uri: first.uri });
    rememberSelection(first.hostId, first.uri);
    // rows/selected читаются на момент смены набора: эффект не должен срабатывать на клик.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overviewLoaded, overviewSignature, rememberSelection]);

  // Форма подставляет хост из последней пары, иначе первый подключённый хост.
  useEffect(() => {
    if (!overviewLoaded) return;
    if (formHostId && hosts.some(candidate => candidate.id === formHostId)) return;
    const saved = readForm();
    const host = hosts.find(candidate => candidate.id === saved?.hostId)
      ?? hosts.find(candidate => candidate.status === 'connected')
      ?? hosts[0];
    setFormHostId(host?.id ?? '');
    setFormDirectory(saved && saved.hostId === host?.id ? saved.directory : pathOf(host?.defaultDirectory));
    setRecent(directoryHistory(window.localStorage, host?.id ?? ''));
  }, [overviewLoaded, formHostId, hosts]);

  const overviewKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const host of hosts) {
      for (const terminal of host.terminals ?? []) keys.add(rowKey(host.id, terminal.resource));
    }
    return keys;
  }, [hosts]);

  // Pending живёт до появления URI в overview или до NotFound канала.
  useEffect(() => {
    setPending(previous => {
      let changed = false;
      const next = new Map(previous);
      for (const key of previous.keys()) {
        if (overviewKeys.has(key) || channels.get(key)?.missing) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [overviewKeys, channels]);

  // Строка закрытия исчезает, когда root перестал отдавать URI: overview — источник истины.
  useEffect(() => {
    setClosing(previous => {
      let changed = false;
      const next = new Set(previous);
      for (const key of previous) {
        if (!overviewKeys.has(key)) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [overviewKeys]);

  const openForm = useCallback(() => {
    setError(undefined);
    setFormOpen(true);
    if (!active) return;
    const cwd = terminalCwd(channels.get(rowKey(active.hostId, active.uri))?.state as TerminalState | undefined, active.directory ?? '');
    setFormHostId(active.hostId);
    setFormDirectory(cwd || active.directory || '');
    setRecent(directoryHistory(window.localStorage, active.hostId));
  }, [active, channels]);

  /** Форма всегда создаёт новый PTY: старый по паре «хост+папка» не подхватывается. */
  const open = useCallback(async () => {
    if (busy) return;
    const host = hosts.find(candidate => candidate.id === formHostId);
    if (!connected || host?.status !== 'connected') {
      setError('Хост не подключён');
      return;
    }
    if (!isAbsoluteHostPath(formDirectory)) {
      setError('Укажите абсолютный путь к папке на хосте, например /Users/me/project');
      return;
    }
    const directory = formDirectory.trim();
    // Имя строки закрепляется за URI: реальный хост отдаёт title «bash» и не переименовывает PTY.
    const folder = normalizeDirectoryPath(directory);
    const used = rows.flatMap(entry => {
      if (entry.hostId !== formHostId) return [];
      const state = channels.get(rowKey(entry.hostId, entry.uri))?.state as TerminalState | undefined;
      if (normalizeDirectoryPath(terminalCwd(state, entry.directory ?? '')) !== folder) return [];
      return [labels.get(entry.uri) || entry.title];
    });
    const title = nextTerminalLabel(directoryName(directory) ?? 'Терминал', used);
    setBusy(true);
    setError(undefined);
    try {
      rememberDirectory(window.localStorage, formHostId, directory);
      rememberLastTerminalForm(window.localStorage, formHostId, directory);
      setRecent(directoryHistory(window.localStorage, formHostId));
    } catch (failure) {
      store.notify(`Папку не удалось запомнить: ${describeError(failure)}`);
    }
    try {
      const { terminalUri } = await store.call<{ terminalUri: string }>({
        op: 'createTerminal',
        hostId: formHostId,
        directory,
        title,
      });
      try { rememberTerminalLabel(window.localStorage, terminalUri, title); }
      catch (failure) { store.notify(`Имя терминала не удалось запомнить: ${describeError(failure)}`); }
      setLabels(previous => new Map(previous).set(terminalUri, title));
      setPending(previous => new Map(previous).set(rowKey(formHostId, terminalUri), {
        hostId: formHostId, uri: terminalUri, title, directory,
      }));
      select(formHostId, terminalUri);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }, [busy, channels, connected, formDirectory, formHostId, hosts, labels, rows, select]);

  /**
   * Закрывает строку, на которой нажали `×`, а не только выбранную. Выбор меняется
   * лишь если закрыли активный терминал: следующим становится первый терминал того же
   * хоста, иначе первый в списке. Закрытие неактивной строки оставляет экран как есть.
   */
  const closeTerminal = useCallback(async (hostId: string, uri: string) => {
    const key = rowKey(hostId, uri);
    if (closingBusy.has(key) || closing.has(key)) return;
    const wasActive = activeKey === key;
    setClosingBusy(previous => new Set(previous).add(key));
    try {
      await store.call({ op: 'disposeTerminal', hostId, terminalUri: uri });
      // `closing` ставится после успешного ответа: иначе неудачное закрытие
      // размонтировало бы живой xterm и потеряло бы контекст.
      setClosing(previous => new Set(previous).add(key));
      setPending(previous => {
        if (!previous.has(key)) return previous;
        const next = new Map(previous);
        next.delete(key);
        return next;
      });
      store.forgetChannelData(hostId, uri);
      // Имя закрытого PTY больше не нужно: URI не вернётся под тем же shell.
      try { forgetTerminalLabel(window.localStorage, uri); } catch { /* приватный режим */ }
      setLabels(previous => {
        if (!previous.has(uri)) return previous;
        const next = new Map(previous);
        next.delete(uri);
        return next;
      });
      if (!wasActive) return;
      const remaining = rows.filter(entry => rowKey(entry.hostId, entry.uri) !== key);
      // Закрываемые прямо сейчас строки не годятся в преемники: иначе выбор перескочил бы
      // на терминал, который исчезнет следующим кадром overview.
      const candidates = remaining.filter(entry => {
        const entryKey = rowKey(entry.hostId, entry.uri);
        return !closing.has(entryKey) && !closingBusy.has(entryKey);
      });
      const next = candidates.find(entry => entry.hostId === hostId) ?? candidates[0];
      if (next) {
        select(next.hostId, next.uri);
      } else if (remaining.length === 0) {
        setSelected(undefined);
        setFormOpen(true);
        try { forgetSelectedTerminal(window.localStorage); } catch { /* приватный режим */ }
      }
      // Иначе все оставшиеся строки закрываются в этот момент: выбор оставляем как есть,
      // его переставит эффект сверки с overview, когда набор устоится.
    } catch (failure) {
      store.notify(`Терминал не закрыт: ${describeError(failure)}`);
    } finally {
      // Строка уже скрыта через `closing`; флаг в полёте снимается в любом исходе.
      setClosingBusy(previous => {
        if (!previous.has(key)) return previous;
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
    }
  }, [activeKey, closing, closingBusy, rows, select]);

  const changeHost = (nextId: string) => {
    setFormHostId(nextId);
    setFormDirectory(pathOf(hosts.find(candidate => candidate.id === nextId)?.defaultDirectory));
    setError(undefined);
    setRecent(directoryHistory(window.localStorage, nextId));
  };

  const lifecycle = activeState?.lifecycle ?? active?.lifecycle;
  const running = lifecycle?.status === 'running';
  const cwd = terminalCwd(activeState, active?.directory ?? '');
  const waitingOverview = !overviewLoaded && connected;
  const showForm = formOpen || rows.length === 0;
  const rowDrafts = rows.map(entry => {
    const key = rowKey(entry.hostId, entry.uri);
    const view = channels.get(key);
    const state = view?.state as TerminalState | undefined;
    const folder = terminalCwd(state, entry.directory ?? '');
    return {
      key,
      hostId: entry.hostId,
      uri: entry.uri,
      hostLabel: entry.hostLabel,
      title: entry.title,
      folder: normalizeDirectoryPath(folder) ?? '',
      cwd: folder || undefined,
      status: terminalStatusText(state?.lifecycle ?? entry.lifecycle),
    };
  });
  // Сохранённое имя при создании важнее title хоста: у реальных хостов это «bash».
  const rowLabels = terminalRowLabels(rowDrafts, labels);
  const listItems: TerminalListEntry[] = rowDrafts.map(({ key, hostId, uri, hostLabel, cwd, status }, index) => ({
    key, hostId, uri, hostLabel, cwd, status, title: rowLabels[index]!,
  }));

  const formAvailable = connected && hosts.find(candidate => candidate.id === formHostId)?.status === 'connected';

  return (
    <div className="terminal-page">
      <header className="terminal-header">
        <button className="mobile-back" aria-controls="sidebar" onClick={onClose}>‹ Сессии</button>
        <h2>Терминал</h2>
        <div className="terminal-actions">
          {!waitingOverview && !showForm && (
            <button type="button" className="terminal-new" disabled={busy} onClick={openForm}>Новый терминал</button>
          )}
          <button type="button" onClick={onClose}>Закрыть</button>
        </div>
      </header>

      {waitingOverview ? (
        <p className="terminal-placeholder" role="status">Загружаем список терминалов…</p>
      ) : (
        <>
          {active && (
            <div className="terminal-status" aria-live="polite">
              <span className={running ? 'dot dot-connected' : 'dot dot-disconnected'} aria-hidden />
              <strong>{active.hostLabel}</strong>
              <code className="terminal-cwd" title={cwd}>{cwd}</code>
              <span className="muted">{terminalStatusText(lifecycle)}</span>
              {activeState?.rows && activeState.cols ? <span className="muted">{activeState.cols}×{activeState.rows}</span> : null}
            </div>
          )}
          {activeView?.error && <p className="error-text" role="alert">{activeView.error}</p>}
          {listItems.length > 0 && (
            <TerminalList
              items={listItems}
              activeKey={activeKey}
              onSelect={select}
              onClose={(hostId, uri) => void closeTerminal(hostId, uri)}
              closeInFlight={closingBusy}
            />
          )}
          <div className="terminal-stage">
            <div className="terminal-stack">
              {rows.map(entry => {
                const key = rowKey(entry.hostId, entry.uri);
                const view = channels.get(key);
                const state = view?.state as TerminalState | undefined;
                const paneActive = key === activeKey;
                return (
                  <div className="terminal-pane" data-active={paneActive ? 'true' : 'false'} key={key}>
                    {state ? (
                      <Suspense fallback={<p className="terminal-placeholder" role="status">Загружаем эмулятор терминала…</p>}>
                        <TerminalEmulator
                          hostId={entry.hostId}
                          uri={entry.uri}
                          state={state}
                          epoch={view?.epoch}
                          active={paneActive}
                          // Resize нужен и скрытым панелям, поэтому interactive — только про ввод.
                          interactive={state.lifecycle.status === 'running' && connected}
                          onNotice={message => store.notify(message)}
                        />
                      </Suspense>
                    ) : (
                      <p className="terminal-placeholder" role="status">Открываем терминал…</p>
                    )}
                  </div>
                );
              })}
            </div>
            {showForm && (
              <form className="terminal-form terminal-form-overlay" onSubmit={event => { event.preventDefault(); void open(); }}>
                <label>
                  Хост
                  <select value={formHostId} onChange={event => changeHost(event.target.value)} disabled={busy}>
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
                    value={formDirectory}
                    onChange={event => setFormDirectory(event.target.value)}
                    placeholder="/Users/me/project"
                    spellCheck={false}
                    required
                    disabled={busy}
                  />
                  <div className="directory-actions">
                    <DirectoryTree hostId={formHostId} initialPath={formDirectory} disabled={!formAvailable || busy} onChoose={setFormDirectory} />
                  </div>
                </div>
                {recent.paths.length > 0 && (
                  <label>
                    Недавние папки
                    <select value={recent.paths.includes(formDirectory) ? formDirectory : ''} onChange={event => { if (event.target.value) setFormDirectory(event.target.value); }} disabled={busy}>
                      <option value="">Выберите недавнюю папку</option>
                      {recent.paths.map(path => <option key={path} value={path}>{path}</option>)}
                    </select>
                  </label>
                )}
                <p className="muted terminal-note">
                  Shell запускается на выбранном хосте без подтверждений команд и живёт до нажатия «×»
                  на строке списка. Каждое открытие создаёт новый PTY: в одной папке можно держать
                  несколько агентов.
                </p>
                {recent.error && <p className="error-text" role="alert">{recent.error}</p>}
                {error && <p className="error-text" role="alert">{error}</p>}
                <div className="row">
                  <button type="submit" className="primary" disabled={!formAvailable || busy}>
                    {busy ? 'Открываем…' : 'Открыть терминал'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      // Отмена не трогает живые панели: они остаются смонтированными под формой.
                      if (rows.length > 0) { setFormOpen(false); setError(undefined); }
                      else onClose();
                    }}
                  >Отмена</button>
                </div>
              </form>
            )}
          </div>
        </>
      )}
    </div>
  );
}
