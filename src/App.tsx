import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ChatInteractivity, ChatOriginKind, type SessionChatSummary, type SessionState } from '@microsoft/agent-host-protocol';
import type { AgentOverview, HostOverview, SessionOverview, UpdateCheck } from '../shared/protocol';
import { channelKey } from '../shared/reduce';
import { PHASE_LABEL, ellipsize, isArchived, pathOf, phaseOf, selectionFromHash, timeAgo, type Phase, type Selection } from './format';
import { SessionView } from './SessionView';
import { describeError, store, useAppState } from './store';
import { recentDirectories, rememberDirectory } from './recent-directories';

type Filter = 'all' | 'active' | 'input' | 'archived';

// Адрес восстанавливает выбранную сессию и её чат после перезагрузки.
function selectionToHash(selection: Selection | null): string {
  if (!selection) return '';
  const { hostId, sessionUri, chatUri } = selection;
  const parts = chatUri ? [hostId, sessionUri, chatUri] : [hostId, sessionUri];
  return `#${parts.map(encodeURIComponent).join('|')}`;
}

const HOST_STATUS_LABEL: Record<HostOverview['status'], string> = {
  connected: 'Подключён',
  connecting: 'Подключение…',
  reconnecting: 'Переподключение…',
  disconnected: 'Отключён',
  failed: 'Недоступен',
};

export function App() {
  const { connection, overview, channels, notices } = useAppState();
  const backendConnected = connection === 'open';
  const [selection, setSelection] = useState(() => selectionFromHash(location.hash));
  const [creating, setCreating] = useState(false);
  const [showSessionList, setShowSessionList] = useState(false);
  const hasDetail = creating || selection !== null;
  useEffect(() => {
    history.replaceState(null, '', `${location.pathname}${location.search}${selectionToHash(selection)}`);
  }, [selection]);
  const [filter, setFilter] = useState<Filter>('all');

  const sessions = useMemo(
    () => overview.sessions
      .toSorted((a, b) => b.summary.modifiedAt.localeCompare(a.summary.modifiedAt)),
    [overview.sessions],
  );
  const normal = sessions.filter(session => !isArchived(session.summary.status));
  const phases = normal.map(session => phaseOf(session.summary.status));
  const counts = {
    all: normal.length,
    archived: sessions.length - normal.length,
    active: phases.filter(phase => phase === 'running' || phase === 'input').length,
    input: phases.filter(phase => phase === 'input').length,
  };
  const visible = sessions.filter(session => {
    const archived = isArchived(session.summary.status);
    if (filter === 'archived') return archived;
    if (archived) return false;
    const phase = phaseOf(session.summary.status);
    if (filter === 'input') return phase === 'input';
    if (filter === 'active') return phase === 'running' || phase === 'input';
    return true;
  });
  const selected = selection && sessions.find(session =>
    session.hostId === selection.hostId && session.summary.resource === selection.sessionUri);

  return (
    <div className="app" data-mobile-view={hasDetail && !showSessionList ? 'detail' : 'list'}>
      <aside className="sidebar" id="sidebar">
        <header className="brand">
          <div className="brand-heading">
            <h1>Agent Control Center</h1>
            <UpdatesButton connected={backendConnected} />
          </div>
          {connection !== 'open' && (
            <span className="badge badge-warn">{connection === 'connecting' ? 'Подключение к backend…' : 'Нет связи с backend'}</span>
          )}
        </header>

        <div className="counters" role="group" aria-label="Фильтр сессий">
          <Counter label="Все" value={counts.all} active={filter === 'all'} onSelect={() => setFilter('all')} />
          <Counter label="В работе" value={counts.active} active={filter === 'active'} onSelect={() => setFilter('active')} />
          <Counter label="Ждут ответа" value={counts.input} active={filter === 'input'} onSelect={() => setFilter('input')} attention={counts.input > 0} />
          <Counter label="Архив" value={counts.archived} active={filter === 'archived'} onSelect={() => setFilter('archived')} />
        </div>

        <div className="sidebar-actions">
          <button className="primary" onClick={() => { setCreating(true); setShowSessionList(false); }}>Новая сессия</button>
          {hasDetail && showSessionList && (
            <button className="mobile-return" onClick={() => setShowSessionList(false)}>{creating ? 'К форме' : 'К открытому чату'}</button>
          )}
        </div>

        <nav className="session-list" aria-label="Сессии">
          {visible.length === 0 && (
            <p className="muted pad">{sessions.length === 0 ? 'Сессий пока нет.' : 'Под этот фильтр ничего не подходит.'}</p>
          )}
          {visible.map(session => {
            const { hostId, summary } = session;
            const sessionUri = summary.resource;
            const live = channels.get(channelKey(hostId, sessionUri))?.state as SessionState | undefined;
            return (
              <SessionRow
                key={channelKey(hostId, sessionUri)}
                session={session}
                catalog={live?.chats ?? summary.chats}
                defaultChat={live?.defaultChat ?? summary.defaultChat}
                connected={backendConnected && overview.hosts.some(host => host.id === hostId && host.status === 'connected')}
                selected={!creating && selection?.hostId === hostId && selection.sessionUri === sessionUri ? selection : null}
                onSelect={chatUri => {
                  setCreating(false);
                  setSelection({ hostId, sessionUri, ...(chatUri ? { chatUri } : {}) });
                  setShowSessionList(false);
                }}
              />
            );
          })}
        </nav>

        <HostsPanel hosts={overview.hosts} backendConnected={backendConnected} />
      </aside>

      <main className="detail">
        {creating ? (
          <>
            <button className="mobile-back mobile-form-back" aria-controls="sidebar" onClick={() => setShowSessionList(true)}>‹ Сессии</button>
            <NewSession
              hosts={overview.hosts}
              backendConnected={backendConnected}
              onCancel={() => setCreating(false)}
              onCreated={created => {
                setSelection(created);
                setCreating(false);
                setShowSessionList(false);
              }}
            />
          </>
        ) : selection ? (
          <SessionView
            key={`${selection.hostId}\n${selection.sessionUri}`}
            hostId={selection.hostId}
            sessionUri={selection.sessionUri}
            selectedChatUri={selection.chatUri}
            host={overview.hosts.find(host => host.id === selection.hostId)}
            summary={selected?.summary}
            backendConnected={backendConnected}
            onClose={() => setSelection(null)}
            onShowSessions={() => setShowSessionList(true)}
            onOpenChat={chatUri => setSelection(current => current === selection ? { ...current, chatUri } : current)}
            onForked={sessionUri => {
              setFilter('all');
              setSelection(current => current === selection ? { hostId: current.hostId, sessionUri } : current);
            }}
          />
        ) : (
          <div className="empty">
            <p>Выберите сессию слева или создайте новую.</p>
          </div>
        )}
      </main>

      <div className="notices" role="status">
        {notices.map(notice => (
          <button key={notice.id} className="notice" onClick={() => store.dismiss(notice.id)} title="Закрыть">
            {notice.text}
          </button>
        ))}
      </div>
    </div>
  );
}

type UpdateDialogState =
  | { phase: 'checking' | 'applying' | 'done' | 'restartingBackend' | 'reconnecting' }
  | { phase: 'checked'; preview: UpdateCheck }
  | { phase: 'failed'; message: string };

function UpdatesButton({ connected }: { connected: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [state, setState] = useState<UpdateDialogState>({ phase: 'checking' });
  const applying = state.phase === 'applying';
  const preview = state.phase === 'checked' ? state.preview : undefined;
  useEffect(() => {
    if (state.phase === 'restartingBackend' && !connected) setState({ phase: 'reconnecting' });
    if (state.phase === 'reconnecting' && connected) setState({ phase: 'done' });
  }, [state.phase, connected]);

  const check = async () => {
    setState({ phase: 'checking' });
    try { setState({ phase: 'checked', preview: await store.call<UpdateCheck>({ op: 'checkUpdates' }) }); }
    catch (error) { setState({ phase: 'failed', message: describeError(error) }); }
  };

  const apply = async () => {
    setState({ phase: 'applying' });
    try {
      const { restartBackend } = await store.call<{ restartBackend: boolean }>({ op: 'applyUpdates' });
      setState({ phase: restartBackend ? 'restartingBackend' : 'done' });
    } catch (error) { setState({ phase: 'failed', message: describeError(error) }); }
  };

  return (
    <>
      <button className="updates-button" type="button" aria-haspopup="dialog" title="Проверить обновления" disabled={!connected} onClick={() => {
        dialog.current?.showModal();
        void check();
      }}>Обновления</button>
      <dialog ref={dialog} className="dialog" aria-labelledby={heading} onCancel={event => { if (applying) event.preventDefault(); }}>
        <h3 id={heading}>Обновления</h3>
        {state.phase === 'checking' && <p role="status">Проверяем версии…</p>}
        {state.phase === 'applying' && <p role="status">Устанавливаем обновления и перезапускаем службы…</p>}
        {state.phase === 'done' && <p role="status">Обновление завершено.</p>}
        {(state.phase === 'restartingBackend' || state.phase === 'reconnecting') && <p role="status">Клиент AHP обновлён. Backend перезапускается.</p>}
        {state.phase === 'failed' && <p className="error-text" role="alert">{state.message}</p>}
        {preview && (preview.changes.length > 0 ? (
          <ul className="update-changes">
            {preview.changes.map(change => (
              <li key={change.name}>{change.name} <span className="muted">{change.current ?? 'без SDK'} → {change.available}</span></li>
            ))}
          </ul>
        ) : <p role="status">Всё актуально.</p>)}
        {preview?.restartBlocked && <p className="error-text" role="status">{preview.restartBlocked}</p>}
        <div className="dialog-actions">
          {!!preview?.changes.length && !preview.restartBlocked && (
            <button type="button" className="primary" disabled={!connected} onClick={() => void apply()}>Обновить и перезапустить</button>
          )}
          {(state.phase === 'failed' || preview?.restartBlocked) && (
            <button type="button" disabled={!connected} onClick={() => void check()}>Проверить снова</button>
          )}
          <button type="button" disabled={applying} onClick={() => dialog.current?.close()}>Закрыть</button>
        </div>
      </dialog>
    </>
  );
}

function Counter(props: { label: string; value: number; active: boolean; attention?: boolean; onSelect(): void }) {
  return (
    <button
      aria-pressed={props.active}
      className={`counter${props.active ? ' counter-active' : ''}${props.attention ? ' counter-attention' : ''}`}
      onClick={props.onSelect}
    >
      <span className="counter-label">{props.label}</span>
      <span className="counter-value">{props.value}</span>
    </button>
  );
}

export function PhaseBadge({ phase }: { phase: Phase }) {
  return <span className={`badge badge-${phase}`}>{PHASE_LABEL[phase]}</span>;
}

function SessionRow({ session, catalog, defaultChat, selected, connected, onSelect }: {
  session: SessionOverview;
  catalog: readonly SessionChatSummary[] | undefined;
  defaultChat: string | undefined;
  selected: Selection | null;
  connected: boolean;
  onSelect(chatUri?: string): void;
}) {
  const { summary } = session;
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const treeId = useId();
  const selectedChat = selected?.chatUri;
  const chats = (catalog ?? []).filter(chat => chat.interactivity !== ChatInteractivity.Hidden);
  const mainChat = defaultChat ?? chats[0]?.resource;
  const subchats = chats.filter(chat => chat.resource !== mainChat);
  const mainSelected = selected !== null && (!selectedChat || selectedChat === mainChat);
  useEffect(() => {
    if (selectedChat && selectedChat !== mainChat) setExpanded(true);
  }, [mainChat, selectedChat]);
  const archived = isArchived(summary.status);
  const phase = phaseOf(summary.status);
  const label = archived ? 'Вернуть' : 'В архив';
  const toggleArchive = async () => {
    setBusy(true);
    try { await store.run({ op: 'archiveSession', hostId: session.hostId, sessionUri: summary.resource, archived: !archived }); }
    finally { setBusy(false); }
  };
  return (
    <div className="session-node">
      <div className={`session-row${mainSelected ? ' session-row-selected' : ''}`} role="group" aria-label={`${summary.title || 'Без названия'} · ${session.hostLabel}`}>
        {subchats.length > 0 && (
          <button type="button" className="session-disclosure" aria-expanded={expanded} aria-controls={treeId}
            aria-label={`Подчаты: ${summary.title || 'Без названия'}`} onClick={() => setExpanded(value => !value)}>
            <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
          </button>
        )}
        <button className="session-open" onClick={() => onSelect()} aria-current={mainSelected}>
          <span className="session-title" title={summary.title || undefined}>{summary.title || 'Без названия'}</span>
          {phase !== 'idle' && <PhaseBadge phase={phase} />}
          <span className="session-meta">
            <span title={`${summary.provider} · ${session.hostLabel}`}>{summary.provider} · {session.hostLabel}</span>
            <time dateTime={summary.modifiedAt}>{timeAgo(summary.modifiedAt)}</time>
          </span>
          {summary.activity && <span className="session-activity">{summary.activity}</span>}
        </button>
        <button className="session-archive" aria-label={`${label}: ${summary.title || 'Без названия'}`} title={archived ? 'Восстановить из архива' : label} disabled={!connected || busy} onClick={() => void toggleArchive()}>
          {label}
        </button>
      </div>
      {subchats.length > 0 && (
        <div id={treeId} hidden={!expanded}>
          {expanded && <SessionChatTree chats={subchats} selectedChat={selectedChat} onSelect={onSelect} />}
        </div>
      )}
    </div>
  );
}

function SessionChatTree({ chats, selectedChat, onSelect }: {
  chats: readonly SessionChatSummary[];
  selectedChat: string | undefined;
  onSelect(chatUri: string): void;
}) {
  const ids = new Set(chats.map(chat => chat.resource));
  const children = new Map<string | undefined, SessionChatSummary[]>();
  for (const chat of chats) {
    const source = chat.origin && chat.origin.kind !== ChatOriginKind.User ? chat.origin.chat : undefined;
    const parent = source && ids.has(source) ? source : undefined;
    const siblings = children.get(parent);
    if (siblings) siblings.push(chat);
    else children.set(parent, [chat]);
  }
  const branch = (parent?: string) => {
    const entries = children.get(parent);
    if (!entries) return null;
    return (
      <ul className="session-children">
        {entries.map(chat => {
          const phase = chat.status === undefined ? undefined : phaseOf(chat.status);
          return (
            <li key={chat.resource}>
              <button type="button" className="session-chat-open" aria-current={selectedChat === chat.resource} onClick={() => onSelect(chat.resource)}>
                <span title={chat.title || undefined}>{chat.title || 'Боковой чат'}</span>
                {phase && phase !== 'idle' && <PhaseBadge phase={phase} />}
              </button>
              {branch(chat.resource)}
            </li>
          );
        })}
      </ul>
    );
  };
  return branch();
}

function HostsPanel({ hosts, backendConnected }: { hosts: readonly HostOverview[]; backendConnected: boolean }) {
  const connected = hosts.filter(host => host.status === 'connected').length;
  const needsSetup = hosts.some(host => host.status === 'connected' && host.agents.some(agent =>
    agent.sdk === 'notDownloaded' || agent.sdk === 'downloading' || agent.models.length === 0));
  return (
    <details className="hosts">
      <summary>
        <span className="hosts-summary">
          <strong>Хосты и агенты</strong>
          {hosts.length > 0 && <span className={connected < hosts.length ? 'badge badge-warn' : 'muted'}>Подключено: {connected}/{hosts.length}</span>}
          {needsSetup && <span className="badge badge-warn">Настройка агентов</span>}
        </span>
      </summary>
      <div className="host-list">
        {hosts.map(host => (
          <div key={host.id} className="host">
            <div className="host-head">
              <span className={`dot dot-${host.status}`} aria-hidden />
              <span className="host-label">{host.label}</span>
              <span className="muted">{HOST_STATUS_LABEL[host.status]}{host.protocolVersion ? ` · AHP ${host.protocolVersion}` : ''}</span>
            </div>
            {host.status !== 'connected' && (
              <div className="host-problem">
                {host.error && <span className="muted">{host.error}</span>}
                <button disabled={!backendConnected} onClick={() => void store.run({ op: 'reconnectHost', hostId: host.id })}>Подключить снова</button>
              </div>
            )}
            {host.status === 'connected' && host.agents.map(agent => <AgentRow key={agent.provider} hostId={host.id} agent={agent} backendConnected={backendConnected} />)}
          </div>
        ))}
      </div>
    </details>
  );
}

function AgentRow({ hostId, agent, backendConnected }: { hostId: string; agent: AgentOverview; backendConnected: boolean }) {
  const setup = (request: 'download' | 'reload') => void store.run({ op: 'agentSetup', hostId, agent: agent.provider, request });
  let status: string;
  let action: { label: string; request: 'download' | 'reload' } | undefined;
  if (agent.sdk === 'notDownloaded') {
    status = 'SDK агента не скачан';
    action = { label: 'Скачать SDK', request: 'download' };
  } else if (agent.sdk === 'downloading') {
    status = 'SDK скачивается…';
  } else if (agent.sdk === 'downloadOnUse') {
    status = 'SDK скачается при первом запуске';
  } else if (agent.models.length > 0) {
    status = `Готов · моделей: ${agent.models.length}`;
  } else if (agent.sdk === 'ready') {
    // Пустой список не всегда значит «нет входа»: Codex отдаёт модели только после первой сессии.
    status = 'Моделей пока нет — создайте сессию; если не выйдет, проверьте вход на хосте';
    action = { label: 'Проверить снова', request: 'reload' };
  } else {
    status = 'Модели не получены';
  }
  return (
    <div className="agent">
      <span className="agent-name">{agent.displayName}</span>
      <span className="muted agent-status">
        {status}
        {agent.sdk === 'ready' && agent.models.length === 0 && agent.setupDocsUrl && (
          <> · <a href={agent.setupDocsUrl} target="_blank" rel="noreferrer">как войти</a></>
        )}
      </span>
      {action && <button disabled={!backendConnected} onClick={() => setup(action.request)}>{action.label}</button>}
    </div>
  );
}

function directoryHistory(hostId: string): { paths: string[]; error?: string } {
  try { return { paths: recentDirectories(window.localStorage, hostId) }; }
  catch (error) { return { paths: [], error: `Не удалось прочитать недавние папки: ${describeError(error)}` }; }
}

interface NewSessionProps {
  hosts: readonly HostOverview[];
  backendConnected: boolean;
  onCancel(): void;
  onCreated(selection: Selection): void;
}

function NewSession({ hosts, backendConnected, onCancel, onCreated }: NewSessionProps) {
  const [pickedHostId, setHostId] = useState<string>();
  const host = hosts.find(candidate => candidate.id === pickedHostId) ?? hosts.find(candidate => candidate.status === 'connected');
  if (host && host.id !== pickedHostId) setHostId(host.id);

  useEffect(() => () => store.cancelDirectoryPicker(), []);

  if (!host) {
    return (
      <div className="empty">
        <p>Нет подключённых хостов — создать сессию негде.</p>
        <button onClick={onCancel}>Назад</button>
      </div>
    );
  }

  return (
    <NewSessionForm
      key={host.id}
      host={host}
      hosts={hosts.filter(candidate => candidate.status === 'connected' || candidate.id === host.id)}
      backendConnected={backendConnected}
      onHostChange={setHostId}
      onCancel={onCancel}
      onCreated={onCreated}
    />
  );
}

function NewSessionForm({ host, hosts, backendConnected, onHostChange, onCancel, onCreated }: NewSessionProps & {
  host: HostOverview;
  onHostChange(hostId: string): void;
}) {
  const hostId = host.id;
  const [pickedProvider, setProvider] = useState<string>();
  const provider = host.agents.find(agent => agent.provider === pickedProvider)?.provider ?? host.agents[0]?.provider ?? '';
  if (provider && provider !== pickedProvider) setProvider(provider);
  const [pickedDirectory, setDirectory] = useState<string>();
  const directory = pickedDirectory ?? pathOf(host.defaultDirectory);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [recent] = useState(() => directoryHistory(hostId));
  const [error, setError] = useState<string>();
  const commandsAvailable = backendConnected && host.status === 'connected';
  const pending = busy || picking;

  const chooseDirectory = async () => {
    if (!commandsAvailable || pending) return;
    setPicking(true);
    setError(undefined);
    try {
      const { directory: chosen } = await store.call<{ directory: string | null }>({ op: 'pickDirectory', hostId, initialDirectory: directory });
      if (chosen !== null) setDirectory(chosen);
    } catch (failure) { setError(describeError(failure)); }
    finally { setPicking(false); }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!commandsAvailable || pending || !provider) return;
    setBusy(true);
    setError(undefined);
    try {
      const { sessionUri } = await store.call<{ sessionUri: string }>({ op: 'createSession', hostId, provider, workingDirectory: directory });
      // Созданная сессия остаётся успешным результатом, даже если браузер запретил запись настроек.
      try { rememberDirectory(window.localStorage, hostId, directory); }
      catch (failure) { store.notify(`Сессия создана, но папку не удалось запомнить: ${describeError(failure)}`); }
      onCreated({ hostId, sessionUri });
    } catch (failure) {
      setError(describeError(failure));
      setBusy(false);
    }
  };

  return (
    <form className="new-session" onSubmit={event => void submit(event)}>
      <h2>Новая сессия</h2>
      <label>
        Хост
        <select value={hostId} onChange={event => onHostChange(event.target.value)} disabled={pending}>
          {hosts.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
        </select>
      </label>
      <label>
        Агент
        <select value={provider} onChange={event => setProvider(event.target.value)} disabled={pending}>
          {host.agents.map(agent => <option key={agent.provider} value={agent.provider}>{agent.displayName}</option>)}
        </select>
      </label>
      <div className="directory-picker">
        <label htmlFor="working-directory">Рабочая папка на хосте</label>
        <div className="directory-field">
          <input id="working-directory" value={directory} onChange={event => setDirectory(event.target.value)} placeholder="/Users/me/project" spellCheck={false} required disabled={pending} />
          {host.canPickDirectory && <button type="button" disabled={!commandsAvailable || pending} onClick={() => void chooseDirectory()}>{picking ? 'Выбор папки…' : 'Выбрать в Finder…'}</button>}
        </div>
      </div>
      {recent.paths.length > 0 && (
        <label>
          Недавние папки
          <select value={recent.paths.includes(directory) ? directory : ''} onChange={event => { if (event.target.value) setDirectory(event.target.value); }} disabled={pending}>
            <option value="">Выберите недавнюю папку</option>
            {recent.paths.map(path => <option key={path} value={path}>{path}</option>)}
          </select>
        </label>
      )}
      {recent.error && <p className="error-text" role="alert">{recent.error}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="row">
        <button type="submit" className="primary" disabled={!commandsAvailable || pending || !provider}>{busy ? 'Создание…' : 'Создать'}</button>
        <button type="button" disabled={pending} onClick={onCancel}>Отмена</button>
      </div>
    </form>
  );
}
