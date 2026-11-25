import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ChatInteractivity, ChatOriginKind, type SessionChatSummary, type SessionState } from '@microsoft/agent-host-protocol';
import type {
  AgentOverview,
  HostOverview,
  ResolveSessionConfigResult,
  SessionConfigCompletionsResult,
  SessionConfigSchema,
  SessionOverview,
  UpdateCheck,
} from '../shared/protocol';
import { channelKey } from '../shared/reduce';
import { HOST_STATUS_LABEL, PHASE_LABEL, ellipsize, isArchived, pathOf, phaseOf, selectionFromHash, selectionToHash, timeAgo, type Phase, type Selection } from './format';
import { HealthView } from './HealthView';
import { TerminalView } from './TerminalView';
import { CommandPalette } from './ui/CommandPalette';
import { SessionView } from './SessionView';
import { describeError, store, useAppState, usePresence } from './store';
import { panelVisibility } from './panel-presence';
import { pinnedKeys, sortSessions, unreadCounts } from './session-list';
import { NotificationsButton } from './ui/NotificationsButton';
import { DirectoryTree } from './ui/DirectoryTree';
import { directoryHistory, rememberDirectory } from './recent-directories';
import {
  branchFieldOf,
  completionOptions,
  configString,
  currentBranchOf,
  effectiveConfig,
  isAbsoluteHostPath,
  sessionConfigFailure,
  sessionConfigOptions,
  sessionConfigPayload,
  targetFieldOf,
  workspaceProbeConfig,
  type SessionConfigOption,
} from './session-config';

type Filter = 'all' | 'active' | 'input' | 'archived';


export function App() {
  const { connection, overview, overviewLoaded, channels, notices, sessionUserState } = useAppState();
  const backendConnected = connection === 'open';
  const [selection, setSelection] = useState(() => selectionFromHash(location.hash));
  const [creating, setCreating] = useState(false);
  const [showHealth, setShowHealth] = useState(() => location.hash === '#health');
  const [showTerminal, setShowTerminal] = useState(() => location.hash === '#terminal');
  const [showSessionList, setShowSessionList] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [revealSeq, setRevealSeq] = useState(0);
  const hasDetail = creating || selection !== null || showHealth || showTerminal;
  useEffect(() => {
    const hash = showHealth ? '#health' : showTerminal ? '#terminal' : selectionToHash(selection);
    history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
  }, [selection, showHealth, showTerminal]);
  // Клик по push-уведомлению в уже открытой вкладке меняет только hash.
  useEffect(() => {
    const onHashChange = () => {
      if (location.hash === '#health' || location.hash === '#terminal') {
        setShowHealth(location.hash === '#health');
        setShowTerminal(location.hash === '#terminal');
        setCreating(false);
        setShowSessionList(false);
        return;
      }
      const next = selectionFromHash(location.hash);
      setSelection(next);
      setShowHealth(false);
      setShowTerminal(false);
      if (next) {
        setCreating(false);
        setShowSessionList(false);
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const mobile = useMediaQuery('(max-width: 760px)');
  // Presence и badge непрочитанных считаются от одного и того же «detail реально показан».
  const { detailVisible, presence } = panelVisibility(selection, { creating, showHealth, showTerminal, sessionList: showSessionList, mobile });
  usePresence(presence);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.code !== 'KeyK' || !(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing) return;
      // Палитра не открывается поверх другого модального окна (обновления, правка сообщения).
      if (!paletteOpen && document.querySelector('dialog[open]')) return;
      event.preventDefault();
      setPaletteOpen(open => !open);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [paletteOpen]);

  const navigate = (next: Selection) => {
    setCreating(false);
    setShowHealth(false);
    setSelection(next);
    setRevealSeq(value => value + 1);
    setShowSessionList(false);
    setPaletteOpen(false);
  };

  const pinned = useMemo(() => pinnedKeys(sessionUserState.pinned), [sessionUserState.pinned]);
  const unread = useMemo(() => unreadCounts(sessionUserState.unread), [sessionUserState.unread]);
  const sessions = useMemo(
    () => sortSessions(overview.sessions, pinned),
    [overview.sessions, pinned],
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
            <div className="brand-actions">
              <button
                type="button"
                className="updates-button"
                aria-pressed={showTerminal}
                onClick={() => { setShowTerminal(true); setShowHealth(false); setCreating(false); setShowSessionList(false); }}
              >Терминал</button>
              <button
                type="button"
                className="updates-button"
                aria-pressed={showHealth}
                onClick={() => { setShowHealth(true); setShowTerminal(false); setShowSessionList(false); }}
              >Диагностика</button>
              <NotificationsButton connected={backendConnected} />
              <UpdatesButton connected={backendConnected} />
            </div>
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
          <button type="button" className="search-button" aria-keyshortcuts="Meta+K Control+K" title="Поиск по сессиям и истории" onClick={() => setPaletteOpen(true)}>
            Поиск <span className="palette-kbd">{navigator.userAgent.includes('Mac') ? '⌘K' : 'Ctrl K'}</span>
          </button>
          <button className="primary" onClick={() => { setCreating(true); setShowHealth(false); setShowTerminal(false); setShowSessionList(false); }}>Новая сессия</button>
          {hasDetail && showSessionList && (
            <button className="mobile-return" onClick={() => setShowSessionList(false)}>{creating ? 'К форме' : showTerminal ? 'К терминалу' : showHealth ? 'К диагностике' : 'К открытому чату'}</button>
          )}
        </div>

        <nav className="session-list" aria-label="Сессии">
          {visible.length === 0 && (
            <p className="muted pad">{sessions.length === 0 ? 'Сессий пока нет.' : 'Под этот фильтр ничего не подходит.'}</p>
          )}
          {visible.map(session => {
            const { hostId, summary } = session;
            const sessionUri = summary.resource;
            const key = channelKey(hostId, sessionUri);
            const live = channels.get(key)?.state as SessionState | undefined;
            // Badge скрыт только когда detail этой сессии действительно на экране;
            // на телефоне в списке detail скрыт, поэтому badge остаётся видимым.
            const hideUnread = detailVisible && selection?.hostId === hostId && selection.sessionUri === sessionUri;
            return (
              <SessionRow
                key={key}
                session={session}
                catalog={live?.chats ?? summary.chats}
                defaultChat={live?.defaultChat ?? summary.defaultChat}
                connected={backendConnected && overview.hosts.some(host => host.id === hostId && host.status === 'connected')}
                backendConnected={backendConnected}
                pinned={pinned.has(key)}
                unread={hideUnread ? 0 : unread.get(key) ?? 0}
                selected={!creating && !showHealth && !showTerminal && selection?.hostId === hostId && selection.sessionUri === sessionUri ? selection : null}
                onSelect={chatUri => {
                  setCreating(false);
                  setShowHealth(false);
                  setShowTerminal(false);
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
        {showTerminal ? (
          <TerminalView
            hosts={overview.hosts}
            connected={backendConnected}
            overviewLoaded={overviewLoaded}
            onClose={() => { setShowTerminal(false); setShowSessionList(true); }}
          />
        ) : showHealth ? (
          <HealthView onClose={() => { setShowHealth(false); setShowSessionList(true); }} />
        ) : creating ? (
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
            onOpenChat={chatUri => setSelection(current => current === selection
              ? { hostId: current.hostId, sessionUri: current.sessionUri, chatUri }
              : current)}
            onForked={sessionUri => {
              setFilter('all');
              setRevealSeq(value => value + 1);
              setSelection(current => current === selection ? { hostId: current.hostId, sessionUri } : current);
            }}
            revealTurnId={selection.turnId}
            revealSeq={revealSeq}
            onRevealMissing={() => {
              setSelection(current => current ? { hostId: current.hostId, sessionUri: current.sessionUri, ...(current.chatUri ? { chatUri: current.chatUri } : {}) } : current);
              store.notify('Сообщение не найдено: возможно, история изменилась.');
            }}
          />
        ) : (
          <div className="empty">
            <p>Выберите сессию слева или создайте новую.</p>
          </div>
        )}
      </main>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} onNavigate={navigate} />}

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

/** Тот же breakpoint, что `@media (max-width: 760px)` в стилях: detail на телефоне скрыт. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
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

function SessionRow({ session, catalog, defaultChat, selected, connected, backendConnected, pinned, unread, onSelect }: {
  session: SessionOverview;
  catalog: readonly SessionChatSummary[] | undefined;
  defaultChat: string | undefined;
  selected: Selection | null;
  connected: boolean;
  backendConnected: boolean;
  pinned: boolean;
  unread: number;
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
  const title = summary.title || 'Без названия';
  const toggleArchive = async () => {
    setBusy(true);
    try { await store.run({ op: 'archiveSession', hostId: session.hostId, sessionUri: summary.resource, archived: !archived }); }
    finally { setBusy(false); }
  };
  const togglePin = async () => {
    setBusy(true);
    try { await store.run({ op: 'pinSession', hostId: session.hostId, sessionUri: summary.resource, pinned: !pinned }); }
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
          <span className="session-title-line">
            <span className="session-title" title={summary.title || undefined}>{title}</span>
            {unread > 0 && (
              <span className="session-unread" title={`Непрочитанных ходов: ${unread}`} aria-label={`Непрочитанных ходов: ${unread}`}>
                {unread > 99 ? '99+' : unread}
              </span>
            )}
            {phase !== 'idle' && <PhaseBadge phase={phase} />}
          </span>
          <span className="session-meta">
            <span title={`${summary.provider} · ${session.hostLabel}`}>{summary.provider} · {session.hostLabel}</span>
            <time dateTime={summary.modifiedAt}>{timeAgo(summary.modifiedAt)}</time>
          </span>
          {summary.activity && <span className="session-activity">{summary.activity}</span>}
        </button>
        <div className="session-row-actions">
          <button
            type="button"
            className="session-pin"
            aria-pressed={pinned}
            aria-label={`${pinned ? 'Открепить' : 'Закрепить'}: ${title}`}
            title={pinned ? 'Открепить' : 'Закрепить'}
            disabled={!backendConnected || busy}
            onClick={() => void togglePin()}
          >
            <span aria-hidden="true">{pinned ? '★' : '☆'}</span>
          </button>
          <button className="session-archive" aria-label={`${label}: ${title}`} title={archived ? 'Восстановить из архива' : label} disabled={!connected || busy} onClick={() => void toggleArchive()}>
            {label}
          </button>
        </div>
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
  const [recent] = useState(() => directoryHistory(window.localStorage, hostId));
  const [error, setError] = useState<string>();
  const commandsAvailable = backendConnected && host.status === 'connected';
  const pending = busy || picking;

  // Конфигурация сессии приходит от хоста: target/isolation и ветка. Список веток — только из ответов.
  // Схема описывает контролы и переживает смену target: иначе выбор исчезал бы на время повторного
  // resolve. Values — defaults конкретного запроса, после смены target они уже не используются.
  const [targetChoice, setTargetChoice] = useState<{ key: string; value: string }>();
  const [branch, setBranch] = useState<string>();
  const [branchQuery, setBranchQuery] = useState('');
  const [branchItems, setBranchItems] = useState<SessionConfigOption[]>([]);
  const [schema, setSchema] = useState<SessionConfigSchema>();
  const [values, setValues] = useState<Record<string, unknown>>();
  const [configPending, setConfigPending] = useState(false);
  const [branchPending, setBranchPending] = useState(false);
  const [currentBranch, setCurrentBranch] = useState<string>();
  const [configError, setConfigError] = useState<string>();
  const [branchError, setBranchError] = useState<string>();
  const branchListId = useId();

  const targetField = targetFieldOf(schema);
  const branchField = branchFieldOf(schema);
  const targetValue = targetChoice?.value ?? (targetField && configString(values, targetField.key)) ?? targetField?.workspaceValue;
  const targetOptions = sessionConfigOptions(targetField?.property);
  const targetSelectable = targetOptions.length > 1 && !targetField?.property.readOnly;
  const branchDynamic = branchField?.dynamic === true;
  const branchValue = branch ?? (branchField ? configString(values, branchField.key) : undefined);
  const branchOptions = branchDynamic ? branchItems : sessionConfigOptions(branchField?.property);
  const branchStatus = configPending || branchPending ? 'определяется…' : currentBranch ?? 'неизвестна';

  // Смена папки/хоста/агента делает недействительными и схему, и выбор: чужие defaults не переезжают.
  useEffect(() => {
    setTargetChoice(undefined);
    setBranch(undefined);
    setBranchQuery('');
    setBranchItems([]);
    setSchema(undefined);
    setValues(undefined);
    setCurrentBranch(undefined);
    setConfigError(undefined);
    setBranchError(undefined);
  }, [hostId, provider, directory]);

  useEffect(() => {
    let live = true;
    // Недописанный путь не повод ходить в хост: ветка честно неизвестна.
    if (!commandsAvailable || !provider || !isAbsoluteHostPath(directory)) {
      setConfigPending(false);
      setBranchPending(false);
      return;
    }
    setConfigPending(true);
    setBranchPending(false);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await store.call<ResolveSessionConfigResult>({
            op: 'resolveSessionConfig', hostId, provider, workingDirectory: directory,
            ...(targetChoice ? { config: { [targetChoice.key]: targetChoice.value } } : {}),
          });
          if (!live) return;
          setSchema(result.schema);
          setValues(result.values);
          setBranchItems(sessionConfigOptions(branchFieldOf(result.schema)?.property));
          setConfigPending(false);
          // Текущую ветку отдаёт только режим «текущая папка»; worktree-ответ содержит default branch.
          const probe = workspaceProbeConfig(result.schema);
          if (!probe) return;
          setBranchPending(true);
          try {
            const current = await store.call<ResolveSessionConfigResult>({
              op: 'resolveSessionConfig', hostId, provider, workingDirectory: directory, config: probe,
            });
            if (!live) return;
            setCurrentBranch(currentBranchOf(current.schema, current.values));
          } catch (failure) {
            if (!live) return;
            setCurrentBranch(undefined);
            setBranchError(`Текущая ветка неизвестна: ${describeError(failure)}`);
          } finally {
            if (live) setBranchPending(false);
          }
        } catch (failure) {
          if (!live) return;
          setConfigPending(false);
          // -32601 — штатная деградация: блок скрыт, создание сессии работает как раньше.
          const { hidden, text } = sessionConfigFailure(failure);
          if (!hidden) setConfigError(text);
        }
      })();
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [commandsAvailable, hostId, provider, directory, targetChoice]);

  // Динамические значения (ветки) хост отдаёт по мере ввода; запоздалый ответ не перезаписывает новый.
  useEffect(() => {
    if (!schema || !branchField || !branchDynamic || targetValue !== targetField?.worktreeValue) return;
    let live = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await store.call<SessionConfigCompletionsResult>({
            op: 'sessionConfigCompletions', hostId, provider, workingDirectory: directory,
            ...(targetField ? { config: { [targetField.key]: targetValue } } : {}),
            property: branchField.key,
            ...(branchQuery.trim() ? { query: branchQuery } : {}),
          });
          if (!live) return;
          setBranchItems(completionOptions(result.items));
          setBranchError(undefined);
        } catch (failure) {
          if (!live) return;
          // Ошибка списка не сбрасывает выбранную ветку и не блокирует создание.
          setBranchError(`Список веток недоступен: ${describeError(failure)}`);
        }
      })();
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [schema, branchField?.key, branchDynamic, targetField?.key, targetValue, commandsAvailable, hostId, provider, directory, branchQuery]);

  const changeTarget = (value: string) => {
    if (!targetField) return;
    setTargetChoice({ key: targetField.key, value });
    // Defaults и ветка относились к прежнему target: до ответа хоста на новый запрос их не используем.
    setValues(undefined);
    setBranch(undefined);
    setBranchQuery('');
    setBranchItems([]);
    setBranchError(undefined);
    setConfigError(undefined);
  };

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
      const overrides: Record<string, unknown> = {};
      // Явный выбор пользователя уходит хосту даже во время повторного resolve: target и ветка
      // не должны молча откатываться на текущую папку. Defaults без выбора — из ответа для этого target.
      if (targetChoice) overrides[targetChoice.key] = targetChoice.value;
      else if (targetField && targetValue !== undefined) overrides[targetField.key] = targetValue;
      // Очищенное пользователем поле уходит хосту как есть: default подставляет только он.
      if (branchField && branchValue !== undefined) overrides[branchField.key] = branchValue;
      const config = sessionConfigPayload(schema, effectiveConfig(values, overrides));
      const { sessionUri } = await store.call<{ sessionUri: string }>({
        op: 'createSession', hostId, provider, workingDirectory: directory, ...(config ? { config } : {}),
      });
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
          {host.canPickDirectory && <button type="button" className="finder-picker" disabled={!commandsAvailable || pending} onClick={() => void chooseDirectory()}>{picking ? 'Выбор папки…' : 'Выбрать в Finder…'}</button>}
        </div>
        <div className="directory-actions">
          <DirectoryTree hostId={hostId} initialPath={directory} disabled={!commandsAvailable || pending} onChoose={setDirectory} />
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
      <p className="session-branch" aria-live="polite">Ветка: {branchStatus}</p>
      {targetField && targetSelectable && (
        <div className="session-config">
          <label>
            Куда создать сессию
            <select value={targetValue ?? ''} onChange={event => changeTarget(event.currentTarget.value)} disabled={pending}>
              {targetOptions.map(option => (
                <option key={option.value} value={option.value} title={option.description}>{option.label}</option>
              ))}
            </select>
          </label>
          {targetValue === targetField.worktreeValue && branchField && (branchDynamic ? (
            <label>
              Базовая ветка
              <input
                list={branchListId}
                value={branchValue ?? ''}
                onChange={event => { setBranch(event.currentTarget.value); setBranchQuery(event.currentTarget.value); }}
                placeholder="Начните вводить ветку"
                spellCheck={false}
                disabled={pending}
              />
              <datalist id={branchListId}>
                {branchOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </datalist>
            </label>
          ) : (
            <label>
              Базовая ветка
              <select value={branchValue ?? ''} onChange={event => setBranch(event.currentTarget.value)} disabled={pending}>
                {!branchValue && <option value="" disabled>Выберите ветку</option>}
                {branchOptions.map(option => (
                  <option key={option.value} value={option.value} title={option.description}>{option.label}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
      {branchError && <p className="error-text" role="alert">{branchError}</p>}
      {configError && <p className="error-text" role="alert">{configError}</p>}
      {recent.error && <p className="error-text" role="alert">{recent.error}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="row">
        <button type="submit" className="primary" disabled={!commandsAvailable || pending || !provider}>{busy ? 'Создание…' : 'Создать'}</button>
        <button type="button" disabled={pending} onClick={onCancel}>Отмена</button>
      </div>
    </form>
  );
}
