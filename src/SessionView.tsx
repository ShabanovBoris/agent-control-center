import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import {
  ChatInputAnswerState,
  ChatInputAnswerValueKind,
  ChatInputQuestionKind,
  ChatInteractivity,
  ChatOriginKind,
  ChatSourceKind,
  compareProtocolVersions,
  type ChatInputResponseKind,
  ConfirmationOptionKind,
  MessageKind,
  ResponsePartKind,
  SessionLifecycle,
  ToolCallStatus,
  ToolResultContentType,
  TurnState,
  type ActiveTurn,
  type ChatInputAnswer,
  type ChatInputQuestion,
  type ChatInputRequest,
  type ChatState,
  type Message,
  type ResponsePart,
  type SessionState,
  type SessionSummary,
  type SideChatSource,
  type ToolCallState,
  type Turn,
} from '@microsoft/agent-host-protocol';
import { SIDE_CHAT_FIRST_EDIT_UNAVAILABLE, type HostOverview, type ModelOverview } from '../shared/protocol';
import { PhaseBadge } from './App';
import { copyableResponseText } from './copy-response';
import { collectFileEdits, resolveTurnChangeset } from './file-edits';
import { inputOutcome, isArchived, pathOf, phaseOf, plain } from './format';
import { composerModelOf, readPreferredModel, savePreferredModel } from './model';
import { SessionUsage } from './SessionUsage';
import { describeError, store, useChannel } from './store';
import { ChatSourceMenu, ConfigPanel, FileEditDisplay, MessageView, ReasoningBlock, ToolResultsDisplay } from './ui';
import { attachmentLabel, MAX_ATTACHMENT_FILE_BYTES, readFileAttachment } from './ui/AttachmentUpload';
import { EditMessageDialog } from './ui/EditMessageDialog';

interface ChatTarget {
  hostId: string;
  chatUri: string;
}

export function SessionView(props: {
  hostId: string;
  sessionUri: string;
  selectedChatUri?: string;
  host: HostOverview | undefined;
  summary: SessionSummary | undefined;
  backendConnected: boolean;
  onClose(): void;
  onShowSessions(): void;
  onOpenChat(chatUri: string): void;
  onForked(sessionUri: string): void;
}) {
  const { hostId, sessionUri, selectedChatUri, host, summary, backendConnected } = props;
  const session = useChannel<SessionState>(hostId, sessionUri);
  const [configPending, setConfigPending] = useState(false);
  const actionsId = useId();
  const actions = useRef<HTMLDivElement>(null);
  const chats = session.state?.chats ?? summary?.chats ?? [];
  const defaultChat = session.state?.defaultChat ?? summary?.defaultChat ?? chats.find(chat => chat.interactivity !== ChatInteractivity.Hidden)?.resource;
  const requestedChat = selectedChatUri && chats.find(chat => chat.resource === selectedChatUri);
  const chatRemoved = !!selectedChatUri && !!session.state && !requestedChat;
  const chatUnavailable = chatRemoved || (!!requestedChat && requestedChat.interactivity === ChatInteractivity.Hidden);
  const chatUri = chatUnavailable ? undefined : selectedChatUri ?? defaultChat;
  const chat = useChannel<ChatState>(hostId, chatUri);

  const meta = session.state ?? summary;
  const status = chat.state?.status ?? meta?.status;
  const provider = chat.state?.provider ?? meta?.provider;
  const agent = host?.agents.find(candidate => candidate.provider === provider);
  const hostConnected = host?.status === 'connected';
  const commandsAvailable = backendConnected && hostConnected;
  const chatTitle = selectedChatUri && selectedChatUri !== defaultChat ? chat.state?.title || (requestedChat && requestedChat.title) : undefined;
  const title = chatTitle || meta?.title || 'Новая сессия';
  const subtitle = [agent?.displayName ?? meta?.provider, host?.label ?? hostId, pathOf(meta?.workingDirectories?.[0])].filter(Boolean).join(' · ');
  const sessionArchived = isArchived(meta?.status ?? 0);
  const chatArchived = isArchived(chat.state?.status ?? 0);
  const archived = sessionArchived || chatArchived;
  const readOnly = !!chat.state?.interactivity && chat.state.interactivity !== ChatInteractivity.Full;
  const canWrite = commandsAvailable && !archived && !readOnly && !chat.error && !session.error;
  const multipleChats = agent?.capabilities?.multipleChats;
  const sideTurnId = chat.state && (chat.state.activeTurn?.id ?? visibleTurns(chat.state).at(-1)?.id);
  const sideChatSource: SideChatSource | undefined = chatUri && multipleChats?.sideChat && sideTurnId
    ? { kind: ChatSourceKind.SideChat, chat: chatUri, turnId: sideTurnId }
    : undefined;
  const origin = chat.state?.origin ?? (requestedChat ? requestedChat.origin : undefined);
  const originChat = origin?.kind === ChatOriginKind.SideChat
    ? chats.find(item => item.resource === origin.chat && item.interactivity !== ChatInteractivity.Hidden)
    : undefined;
  const handleCreateChat = async (source: SideChatSource, title?: string) => {
    const retained = chat.state?.turns.some(turn => turn.id === source.turnId);
    const active = chat.state?.activeTurn?.id === source.turnId;
    if (!retained && !active) throw new Error('Исходный ход больше недоступен.');
    const { chatUri: createdChat } = await store.call<{ chatUri: string }>({
      op: 'createChat', hostId, sessionUri, chatUri: `ahp-chat:/${crypto.randomUUID()}`, source, title,
    });
    props.onOpenChat(createdChat);
  };
  const supportsChatConfig = !!host?.protocolVersion && compareProtocolVersions(host.protocolVersion, '1.1.0') >= 0;
  const changeMode = async (scope: 'chat' | 'session', key: string, value: string) => {
    if (!canWrite || !chatUri || configPending || chat.state?.activeTurn) return;
    const config = { [key]: value };
    setConfigPending(true);
    try {
      await store.run(scope === 'chat'
        ? { op: 'updateChatConfig', hostId, chatUri, config, waitForHost: true }
        : { op: 'updateSessionConfig', hostId, sessionUri, config, waitForHost: true });
    } finally { setConfigPending(false); }
  };
  const refreshing = useRef(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const refresh = useCallback(async () => {
    if (!commandsAvailable || refreshing.current) return;
    refreshing.current = true;
    setRefreshPending(true);
    try { await store.run({ op: 'refreshSession', hostId, sessionUri }); }
    finally { refreshing.current = false; setRefreshPending(false); }
  }, [commandsAvailable, hostId, sessionUri]);

  useEffect(() => {
    if (!commandsAvailable || session.missing) return;
    // VS Code не публикует sessionRemoved для не начатых черновиков.
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [commandsAvailable, session.missing, refresh]);

  if (session.missing) {
    return (
      <div className="empty" role="status">
        <h2>Сессия недоступна</h2>
        <p>Она удалена на хосте или в другом клиенте.</p>
        <button onClick={props.onClose}>Закрыть сессию</button>
      </div>
    );
  }

  return (
    <section className="session">
      <header className="session-head">
        <div className="session-head-main">
          <button className="mobile-back icon-button" aria-label="К списку сессий" aria-controls="sidebar" title="Сессии" onClick={props.onShowSessions}>‹</button>
          <h2 title={title}>{title}</h2>
          {multipleChats?.sideChat && (
            <ChatSourceMenu
              key={chatUri}
              source={sideChatSource}
              onSelect={handleCreateChat}
              disabled={!canWrite || !session.state || !chat.state}
            />
          )}
          <button className="icon-button session-actions-trigger" popoverTarget={actionsId} aria-label="Действия сессии" title="Действия сессии">⋯</button>
          <div id={actionsId} ref={actions} className="session-actions" popover="auto" aria-label="Действия сессии" role="group">
            <button disabled={!commandsAvailable || refreshPending} onClick={() => { actions.current?.hidePopover(); void refresh(); }}>
              {refreshPending ? 'Обновление…' : 'Обновить сессию'}
            </button>
            <button disabled={!commandsAvailable || !session.state} onClick={() => {
              actions.current?.hidePopover();
              void store.run({ op: 'archiveSession', hostId, sessionUri, archived: !sessionArchived });
            }}>
              {sessionArchived ? 'Восстановить' : 'В архив'}
            </button>
          </div>
        </div>
        <div className="session-sub">
          {status !== undefined && <PhaseBadge phase={phaseOf(status)} />}
          <span className="muted session-subtitle" title={subtitle}>{subtitle}</span>
        </div>
      </header>

      {!backendConnected && <p className="banner">Нет связи с backend. Показано последнее известное состояние.</p>}
      {backendConnected && !hostConnected && <p className="banner">Хост не подключён: показано последнее известное состояние, команды недоступны.</p>}
      {sessionArchived && <p className="banner">Сессия в архиве. Восстановите её, чтобы продолжить.</p>}
      {!sessionArchived && chatArchived && <p className="banner">Чат в архиве.</p>}
      {readOnly && !archived && <p className="banner">Чат доступен только для чтения.</p>}
      {session.error && <p className="banner banner-error">Не удалось получить сессию: {session.error}</p>}
      {/* Хост держит сессию в состоянии creating до первого хода, хотя чат уже доступен. */}
      {session.state?.lifecycle === SessionLifecycle.Creating && !chat.state && <p className="banner">Сессия создаётся…</p>}
      {session.state?.lifecycle === SessionLifecycle.Failed && (
        <p className="banner banner-error">Сессию не удалось создать: {session.state.creationError?.message ?? 'причина не указана'}</p>
      )}
      {chat.error && <p className="banner banner-error">Не удалось получить чат: {chat.error}</p>}
      {chatUnavailable && <p className="banner">Этот чат недоступен. Выберите другой в списке сессий.</p>}

      {chatUri && chat.state ? (
        <>
          <Transcript
            key={chatUri}
            chat={chat.state}
            target={{ hostId, chatUri }}
            sessionUri={sessionUri}
            workingDirectory={(chat.state.workingDirectories ?? meta?.workingDirectories)?.[0]}
            commandsAvailable={commandsAvailable}
            canWrite={canWrite && !!session.state}
            supportsFork={!!multipleChats?.fork}
            sourceLabel={origin?.kind === ChatOriginKind.SideChat
              ? originChat?.title ? `Ответвление от «${originChat.title}»` : 'Боковой чат · ответвление от исходного чата'
              : undefined}
            onOpenSource={originChat ? () => props.onOpenChat(originChat.resource) : undefined}
            onForked={props.onForked}
          />
          <Composer
            key={JSON.stringify([chatUri, provider])}
            chat={chat.state}
            target={{ hostId, chatUri }}
            provider={provider}
            models={agent?.models ?? []}
            defaultModelId={agent?.defaultModelId}
            disabled={!canWrite || chat.missing === true}
            configPending={configPending}
            modeControls={(
              <ConfigPanel
                sessionConfig={session.state?.config}
                chatConfig={chat.state.config}
                isDefaultChat={chatUri === session.state?.defaultChat}
                supportsChatConfig={supportsChatConfig}
                disabled={!canWrite || !!chat.state.activeTurn}
                pending={configPending}
                onChange={changeMode}
              />
            )}
          />
        </>
      ) : (
        !session.error && !chat.error && !chat.missing && !chatUnavailable && (
          <p className="muted pad">{session.state && !chatUri && session.state.lifecycle !== SessionLifecycle.Creating ? 'В этой сессии нет доступных чатов.' : 'Загрузка…'}</p>
        )
      )}
      {session.state && (
        <SessionUsage
          hostId={hostId}
          chatUris={chats.map(chat => chat.resource)}
          currentChat={chat.state}
          provider={session.state.provider}
          connected={commandsAvailable}
        />
      )}
    </section>
  );
}

function visibleTurns(chat: ChatState): readonly Turn[] {
  const origin = chat.origin;
  if (origin?.kind !== ChatOriginKind.SideChat) return chat.turns;
  // Некоторые хосты возвращают унаследованный префикс при восстановлении боковой ветки.
  const inherited = chat.turns.findIndex(turn => turn.id === origin.turnId);
  return inherited < 0 ? chat.turns : chat.turns.slice(inherited + 1);
}

function Transcript({ chat, target, sessionUri, workingDirectory, commandsAvailable, canWrite, supportsFork, sourceLabel, onOpenSource, onForked }: {
  chat: ChatState;
  target: ChatTarget;
  sessionUri: string;
  workingDirectory: string | undefined;
  commandsAvailable: boolean;
  canWrite: boolean;
  supportsFork: boolean;
  sourceLabel?: string;
  onOpenSource?(): void;
  onForked(sessionUri: string): void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [forkingTurn, setForkingTurn] = useState<string>();
  const [editing, setEditing] = useState<{ turn: Turn; lastTurnId: string }>();
  const history = visibleTurns(chat);
  const turns = chat.activeTurn ? [...history, chat.activeTurn] : history;
  const changesetTemplate = chat.changesets?.find(item => item.changeKind === 'turn' && item.uriTemplate.includes('{turnId}'))?.uriTemplate;
  const lastTurnId = chat.turns.at(-1)?.id;
  const firstSideTurnId = chat.origin?.kind === ChatOriginKind.SideChat && !chat.turnsNextCursor ? chat.turns[0]?.id : undefined;
  const canEdit = canWrite && !chat.activeTurn && !chat.queuedMessages?.length && !chat.steeringMessage;
  const canFork = canWrite && supportsFork && chat.origin?.kind !== ChatOriginKind.Tool;

  const loadOlderTurns = async () => {
    if (!chat.turnsNextCursor || loadingHistory || !commandsAvailable) return;
    setLoadingHistory(true);
    stick.current = false;
    try { await store.run({ op: 'fetchTurns', ...target, cursor: chat.turnsNextCursor }); }
    finally { setLoadingHistory(false); }
  };
  const fork = async (turnId: string) => {
    if (!canFork || forkingTurn) return;
    setForkingTurn(turnId);
    try {
      const created = await store.call<{ sessionUri: string }>({ op: 'forkSession', ...target, sessionUri, turnId });
      onForked(created.sessionUri);
    } catch (error) { store.notify(describeError(error)); }
    finally { setForkingTurn(undefined); }
  };

  // Лента прокручивается за новым выводом, только пока пользователь сам не ушёл вверх.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [chat]);

  return (
    <div
      className="transcript"
      ref={scroller}
      onScroll={event => {
        const element = event.currentTarget;
        stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      }}
    >
      {sourceLabel && (
        <div className="chat-provenance muted">
          {onOpenSource ? <button type="button" onClick={onOpenSource}>{sourceLabel}</button> : sourceLabel}
        </div>
      )}
      {chat.turnsNextCursor && (
        <button className="history-more" type="button" disabled={!commandsAvailable || loadingHistory} onClick={() => void loadOlderTurns()}>
          {loadingHistory ? 'Загрузка…' : 'Ранние сообщения'}
        </button>
      )}
      {turns.length === 0 && !sourceLabel && <p className="muted transcript-empty">Сообщений пока нет. Напишите задачу ниже.</p>}
      {turns.map(turn => {
        const active = turn === chat.activeTurn;
        const completed = 'state' in turn ? turn : undefined;
        return (
          <TurnView key={turn.id} turn={turn} target={target} workingDirectory={workingDirectory}
            changesetTemplate={changesetTemplate} active={active} commandsAvailable={active && commandsAvailable}
            onEdit={completed && lastTurnId && canEdit && turn.message.origin.kind === MessageKind.User
              ? () => setEditing({ turn: completed, lastTurnId })
              : undefined}
            editBlockedReason={turn.id === firstSideTurnId ? SIDE_CHAT_FIRST_EDIT_UNAVAILABLE : undefined}
            onFork={completed?.state === TurnState.Complete && canFork
              && completed.responseParts.some(part => part.kind === ResponsePartKind.Markdown && part.content.trim())
              ? () => void fork(completed.id)
              : undefined}
            forkPending={forkingTurn !== undefined} />
        );
      })}
      {editing && (
        <EditMessageDialog
          {...target}
          sessionUri={sessionUri}
          turnId={editing.turn.id}
          lastTurnId={editing.lastTurnId}
          message={editing.turn.message}
          disabled={!canEdit}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}

function TurnView({ turn, target, workingDirectory, changesetTemplate, active, commandsAvailable, onEdit, editBlockedReason, onFork, forkPending }: {
  turn: Turn | ActiveTurn;
  target: ChatTarget;
  workingDirectory: string | undefined;
  changesetTemplate: string | undefined;
  active: boolean;
  commandsAvailable: boolean;
  onEdit?(): void;
  editBlockedReason?: string;
  onFork?(): void;
  forkPending: boolean;
}) {
  const finished = 'state' in turn ? turn.state : undefined;
  const responseToCopy = copyableResponseText(finished, turn.responseParts);
  const { files, hasFileEditCall } = useMemo(() => collectFileEdits(turn.responseParts), [turn.responseParts]);
  const changesetUri = !active && files.size === 0 && hasFileEditCall
    ? resolveTurnChangeset(changesetTemplate, turn.id) : undefined;
  const copyResponse = async () => {
    if (responseToCopy === undefined) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Буфер обмена недоступен');
      await navigator.clipboard.writeText(responseToCopy);
      store.notify('Ответ скопирован');
    } catch (error) {
      store.notify(`Не удалось скопировать ответ: ${describeError(error)}`);
    }
  };
  return (
    <article className="turn">
      <div className="user-message-row">
        {onEdit && (
          <button type="button" className="turn-action" aria-label={editBlockedReason ?? 'Редактировать сообщение'}
            title={editBlockedReason ?? 'Редактировать сообщение'} disabled={!!editBlockedReason} onClick={onEdit}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m14 6 4 4M4 20l1-4L16 5a2.8 2.8 0 0 1 4 4L9 20Z" />
            </svg>
          </button>
        )}
        <div className="message message-user"><MessageView message={turn.message} /></div>
      </div>
      {turn.responseParts.map((part, index) => (
        <PartView key={partKey(part, index)} part={part} turnId={turn.id} target={target} active={active} commandsAvailable={commandsAvailable} />
      ))}
      {(files.size > 0 || changesetUri) && (
        <FileEditDisplay files={files} hostId={target.hostId} workingDirectory={workingDirectory} changesetUri={changesetUri} />
      )}
      {active && <p className="muted working">Агент работает…</p>}
      {finished === TurnState.Cancelled && <p className="muted">Ход остановлен.</p>}
      {!active && (responseToCopy !== undefined || onFork || turn.usage?.model) && (
        <div className="turn-footer">
          {responseToCopy !== undefined && (
            <button type="button" className="turn-action" aria-label="Скопировать ответ" title="Скопировать ответ" onClick={() => void copyResponse()}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="8" y="8" width="13" height="13" rx="2" />
                <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
              </svg>
            </button>
          )}
          {onFork && (
            <button type="button" className="turn-action" aria-label="Форк в отдельную сессию" title="Форк в отдельную сессию" disabled={forkPending} onClick={onFork}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 12h6m0 0 6-6m-6 6 6 6M15 4h5v5m-5 11h5v-5" />
              </svg>
            </button>
          )}
          {turn.usage?.model && <span className="muted working">Модель: {turn.usage.model}</span>}
        </div>
      )}
    </article>
  );
}

function partKey(part: ResponsePart, index: number): string {
  if (part.kind === ResponsePartKind.ToolCall) return `tool:${part.toolCall.toolCallId}`;
  if (part.kind === ResponsePartKind.InputRequest) return `input:${part.request.id}`;
  return `${part.kind}:${index}`;
}

function PartView({ part, turnId, target, active, commandsAvailable }: { part: ResponsePart; turnId: string; target: ChatTarget; active: boolean; commandsAvailable: boolean }) {
  switch (part.kind) {
    case ResponsePartKind.Markdown:
      return <div className="message message-agent">{part.content.trimStart()}</div>;
    case ResponsePartKind.Reasoning:
      return <ReasoningBlock content={part.content} />;
    case ResponsePartKind.ToolCall:
      return <ToolCallCard call={part.toolCall} turnId={turnId} target={target} active={active} commandsAvailable={commandsAvailable} />;
    case ResponsePartKind.InputRequest:
      return <InputRequestCard request={part.request} answered={part.response} target={target} active={active} commandsAvailable={commandsAvailable} />;
    case ResponsePartKind.Error:
      return <p className="banner banner-error">{part.error.message}</p>;
    case ResponsePartKind.SystemNotification:
      return <p className="muted">{plain(part.content)}</p>;
    case ResponsePartKind.ContentRef:
      return <p className="muted">Вложение: {part.uri}</p>;
  }
}

const TOOL_STATUS_LABEL: Record<ToolCallStatus, string> = {
  [ToolCallStatus.Streaming]: 'Готовится',
  [ToolCallStatus.PendingConfirmation]: 'Ждёт подтверждения',
  [ToolCallStatus.Running]: 'Выполняется',
  [ToolCallStatus.AuthRequired]: 'Нужна авторизация на хосте',
  [ToolCallStatus.PendingResultConfirmation]: 'Ждёт подтверждения результата',
  [ToolCallStatus.Completed]: 'Выполнен',
  [ToolCallStatus.Cancelled]: 'Отменён',
};

function ToolCallCard({ call, turnId, target, active, commandsAvailable }: { call: ToolCallState; turnId: string; target: ChatTarget; active: boolean; commandsAvailable: boolean }) {
  const pending = call.status === ToolCallStatus.PendingConfirmation;
  const failed = call.status === ToolCallStatus.Completed && !call.success;
  const description = call.status === ToolCallStatus.Completed
    ? plain(call.pastTenseMessage)
    : call.status === ToolCallStatus.Streaming ? call.intention ?? '' : plain(call.invocationMessage);
  const input = 'toolInput' in call && typeof call.toolInput === 'string' ? call.toolInput : undefined;
  const resultContent = 'content' in call ? call.content ?? [] : [];
  const terminal = call._meta?.toolKind === 'terminal' || call.toolName === 'shell';
  const command = terminal ? input?.trim() : undefined;
  const heading = command ? (
    <code className="tool-name tool-command" title={input}>{command.replace(/[\r\n].*$/s, '…')}</code>
  ) : <span className="tool-name">{call.displayName || call.toolName}</span>;
  const statusLabel = failed ? 'Ошибка' : TOOL_STATUS_LABEL[call.status];
  const showErrorDescription = failed && !call.error && !!description;
  const canExpand = !pending && (!!input || resultContent.length > 0 || (!!description && !showErrorDescription));

  return (
    <div className={`tool tool-call${pending ? ' tool-pending' : ''}${failed ? ' tool-failed' : ''}`}>
      <details className="tool-disclosure">
        <summary className="tool-summary" aria-disabled={!canExpand || undefined} onClick={event => {
          if (!canExpand) event.preventDefault();
        }}>
          {heading}
          <span className="tool-summary-status">· {statusLabel}</span>
        </summary>
        {canExpand && (
          <div className="tool-details">
            {description && !showErrorDescription && <p className="tool-text">{description}</p>}
            {input && <div><span className="muted">Параметры</span><pre className="tool-input">{input}</pre></div>}
            {resultContent.length > 0 && <div><span className="muted">Результат</span><ToolResultsDisplay content={resultContent} /></div>}
          </div>
        )}
      </details>
      {pending && call.confirmationTitle && <p className="tool-title">{plain(call.confirmationTitle)}</p>}
      {pending && description && <p className="tool-text">{description}</p>}
      {pending && input && <pre className="tool-input">{input}</pre>}
      {failed && (call.error || showErrorDescription) && <p className="error-text">{call.error?.message ?? description}</p>}
      {call.status === ToolCallStatus.Cancelled && call.reasonMessage && <p className="muted">{plain(call.reasonMessage)}</p>}
      {pending && active && <Confirmation call={call} turnId={turnId} target={target} commandsAvailable={commandsAvailable} />}
      {call.status === ToolCallStatus.PendingResultConfirmation && (
        <p className="muted">Подтвердить результат можно в VS Code — в этой версии панели такого действия нет.</p>
      )}
    </div>
  );
}

function Confirmation({ call, turnId, target, commandsAvailable }: { call: Extract<ToolCallState, { status: ToolCallStatus.PendingConfirmation }>; turnId: string; target: ChatTarget; commandsAvailable: boolean }) {
  // Ответ уходит хосту без ожидания; кнопки блокируются ненадолго, чтобы двойной клик
  // не отправил второе подтверждение, а при отказе хоста ими можно было воспользоваться снова.
  const [sent, setSent] = useState(false);
  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => setSent(false), 4000);
    return () => clearTimeout(timer);
  }, [sent]);

  const answer = (approved: boolean, optionId?: string) => {
    if (!commandsAvailable || sent) return;
    setSent(true);
    void store.run({ op: 'confirmTool', ...target, turnId, toolCallId: call.toolCallId, approved, ...(optionId ? { optionId } : {}) });
  };

  const options = call.options ?? [];
  // Основной выделяется только первый разрешающий вариант: хост ставит первым разовое
  // разрешение, а постоянные («всегда разрешать») не должны выглядеть действием по умолчанию.
  const primaryId = options.find(option => option.kind === ConfirmationOptionKind.Approve)?.id;
  return (
    <div className="row">
      {options.length > 0 ? options.map(option => {
        const approve = option.kind === ConfirmationOptionKind.Approve;
        return (
          <button key={option.id} className={option.id === primaryId ? 'primary' : ''} disabled={!commandsAvailable || sent} onClick={() => answer(approve, option.id)}>
            {option.label}
          </button>
        );
      }) : (
        <>
          <button className="primary" disabled={!commandsAvailable || sent} onClick={() => answer(true)}>Разрешить</button>
          <button disabled={!commandsAvailable || sent} onClick={() => answer(false)}>Отклонить</button>
        </>
      )}
    </div>
  );
}

type Draft = string | boolean | string[];

function InputRequestCard(props: { request: ChatInputRequest; answered: ChatInputResponseKind | undefined; target: ChatTarget; active: boolean; commandsAvailable: boolean }) {
  const { request, answered, target, active, commandsAvailable } = props;
  const questions = request.questions ?? [];
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(questions.flatMap(question => {
      const initial = initialDraft(question);
      return initial === undefined ? [] : [[question.id, initial]];
    })));
  const [sent, setSent] = useState(false);

  if (answered || !active) {
    return <p className="muted">Вопрос агента{request.message ? ` «${request.message}»` : ''} — {inputOutcome(request, answered)}</p>;
  }

  const complete = (response: 'accept' | 'decline') => {
    if (!commandsAvailable || sent) return;
    setSent(true);
    const answers = response === 'accept' ? buildAnswers(questions, drafts) : undefined;
    void store.run({ op: 'completeInput', ...target, requestId: request.id, response, ...(answers ? { answers } : {}) })
      .then(() => setTimeout(() => setSent(false), 4000));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    complete('accept');
  };
  const set = (id: string, value: Draft) => setDrafts(current => ({ ...current, [id]: value }));

  return (
    <form className="tool tool-pending" onSubmit={submit}>
      <div className="tool-head">
        <span className="tool-name">Агент просит ввод</span>
      </div>
      {request.message && <p className="tool-text">{request.message}</p>}
      {request.url && <p><a href={request.url} target="_blank" rel="noreferrer">{request.url}</a></p>}
      {questions.map(question => (
        <QuestionField key={question.id} question={question} value={drafts[question.id]} onChange={value => set(question.id, value)} />
      ))}
      <div className="row">
        <button type="submit" className="primary" disabled={!commandsAvailable || sent}>Отправить</button>
        <button type="button" disabled={!commandsAvailable || sent} onClick={() => complete('decline')}>Отклонить</button>
      </div>
    </form>
  );
}

function initialDraft(question: ChatInputQuestion): Draft | undefined {
  switch (question.kind) {
    case ChatInputQuestionKind.Text:
      return question.defaultValue;
    case ChatInputQuestionKind.Number:
    case ChatInputQuestionKind.Integer:
      return question.defaultValue === undefined ? undefined : String(question.defaultValue);
    case ChatInputQuestionKind.Boolean:
      return question.defaultValue;
    case ChatInputQuestionKind.SingleSelect:
      return question.options.find(option => option.recommended)?.id;
    case ChatInputQuestionKind.MultiSelect:
      return question.options.filter(option => option.recommended).map(option => option.id);
  }
}

/** Неотвеченные вопросы в ответ не попадают: пустое значение не выдаётся за ответ пользователя. */
function buildAnswers(questions: readonly ChatInputQuestion[], drafts: Record<string, Draft>): Record<string, ChatInputAnswer> {
  const answers: Record<string, ChatInputAnswer> = {};
  const submitted = ChatInputAnswerState.Submitted;
  for (const question of questions) {
    const draft = drafts[question.id];
    if (draft === undefined || draft === '') continue;
    switch (question.kind) {
      case ChatInputQuestionKind.Text:
        answers[question.id] = { state: submitted, value: { kind: ChatInputAnswerValueKind.Text, value: String(draft) } };
        break;
      case ChatInputQuestionKind.Number:
      case ChatInputQuestionKind.Integer:
        answers[question.id] = { state: submitted, value: { kind: ChatInputAnswerValueKind.Number, value: Number(draft) } };
        break;
      case ChatInputQuestionKind.Boolean:
        answers[question.id] = { state: submitted, value: { kind: ChatInputAnswerValueKind.Boolean, value: draft === true } };
        break;
      case ChatInputQuestionKind.SingleSelect:
        answers[question.id] = { state: submitted, value: { kind: ChatInputAnswerValueKind.Selected, value: String(draft) } };
        break;
      case ChatInputQuestionKind.MultiSelect:
        if (Array.isArray(draft) && draft.length > 0) {
          answers[question.id] = { state: submitted, value: { kind: ChatInputAnswerValueKind.SelectedMany, value: draft } };
        }
        break;
    }
  }
  return answers;
}

function QuestionField({ question, value, onChange }: { question: ChatInputQuestion; value: Draft | undefined; onChange(value: Draft): void }) {
  // Заголовок у вопроса короткий («Color»), сам вопрос — в message; показываются оба.
  const caption = (
    <span className="question-text">
      {question.title && question.title !== question.message && <strong>{question.title}{question.required ? ' *' : ''}: </strong>}
      {question.message}{!question.title && question.required ? ' *' : ''}
    </span>
  );
  switch (question.kind) {
    case ChatInputQuestionKind.Text:
      return <label>{caption}<input value={typeof value === 'string' ? value : ''} required={question.required} onChange={event => onChange(event.target.value)} /></label>;
    case ChatInputQuestionKind.Number:
    case ChatInputQuestionKind.Integer:
      return (
        <label>{caption}
          <input
            type="number"
            step={question.kind === ChatInputQuestionKind.Integer ? 1 : 'any'}
            min={question.min}
            max={question.max}
            value={typeof value === 'string' ? value : ''}
            required={question.required}
            onChange={event => onChange(event.target.value)}
          />
        </label>
      );
    case ChatInputQuestionKind.Boolean:
      return <label className="check"><input type="checkbox" checked={value === true} onChange={event => onChange(event.target.checked)} />{caption}</label>;
    case ChatInputQuestionKind.SingleSelect:
      return (
        <fieldset>
          <legend>{caption}</legend>
          {question.options.map(option => (
            <label key={option.id} className="check">
              <input type="radio" name={question.id} checked={value === option.id} required={question.required} onChange={() => onChange(option.id)} />
              {option.label}
            </label>
          ))}
        </fieldset>
      );
    case ChatInputQuestionKind.MultiSelect: {
      const picked = Array.isArray(value) ? value : [];
      return (
        <fieldset>
          <legend>{caption}</legend>
          {question.options.map(option => (
            <label key={option.id} className="check">
              <input
                type="checkbox"
                checked={picked.includes(option.id)}
                onChange={event => onChange(event.target.checked ? [...picked, option.id] : picked.filter(id => id !== option.id))}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      );
    }
  }
}

// Base64 expands 60 MiB to 80 MiB, leaving room for the rest of the WebSocket message.
const MAX_MESSAGE_ATTACHMENT_BYTES = 60 * 1024 * 1024;

function DraftAttachment({ file, onRemove }: { file: File; onRemove(): void }) {
  const [imageUrl, setImageUrl] = useState<string>();
  const label = attachmentLabel(file);
  useEffect(() => {
    if (!file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <div className={imageUrl ? 'attachment-preview' : 'attachment-file attachment-file-draft'}>
      {imageUrl
        ? <img src={imageUrl} alt={label} onError={() => setImageUrl(undefined)} />
        : <span title={label}>{label}</span>}
      <button type="button" className="attachment-remove" aria-label={`Удалить ${label}`} title={`Удалить ${label}`} onClick={onRemove}>✕</button>
    </div>
  );
}

function Composer(props: {
  chat: ChatState;
  target: ChatTarget;
  provider: string | undefined;
  models: readonly ModelOverview[];
  defaultModelId: string | undefined;
  disabled: boolean;
  configPending: boolean;
  modeControls: ReactNode;
}) {
  const { chat, target, provider, models, defaultModelId, disabled, configPending, modeControls } = props;
  const [text, setText] = useState('');
  const [draftFiles, setDraftFiles] = useState<{ id: number; file: File }[]>([]);
  const nextFileId = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const [sendPending, setSendPending] = useState(false);
  const [pickedModelId, setPickedModelId] = useState<string>();
  const [pickedThinkingLevel, setPickedThinkingLevel] = useState<string>();
  const [preferredModelId] = useState(() => {
    if (!provider) return undefined;
    try { return readPreferredModel(window.localStorage, target.hostId, provider); }
    catch { return undefined; }
  });
  const activeTurn = chat.activeTurn;
  const { currentModel, defaultModel, model, choice } = composerModelOf(chat, models, defaultModelId, preferredModelId, pickedModelId);
  const thinking = model?.configSchema?.properties.thinkingLevel;
  const levels = thinking?.type === 'string' ? thinking.enum?.flatMap((value, index) => typeof value === 'string'
    ? [{ value, label: thinking.enumLabels?.[index] ?? value, description: thinking.enumDescriptions?.[index] }]
    : []) ?? [] : [];
  const defaultLevel = levels.find(level => level.value === thinking?.default);
  const previousLevel = model?.id === currentModel?.id ? currentModel?.config?.thinkingLevel : undefined;
  const requestedLevel = pickedThinkingLevel ?? previousLevel;
  const selectedLevel = thinking?.readOnly ? undefined : levels.find(level => level.value === requestedLevel);
  const reasoningChoice = selectedLevel?.value !== defaultLevel?.value ? selectedLevel?.value ?? '' : '';

  const chooseModel = (id: string) => {
    setPickedModelId(id);
    setPickedThinkingLevel('');
    if (!provider) return;
    try { savePreferredModel(window.localStorage, target.hostId, provider, id); }
    catch { store.notify('Не удалось запомнить модель для новых сессий'); }
  };

  const attachFiles = (files: readonly File[]) => {
    if (disabled) return;
    const additions = files.flatMap(file => {
      if (file.size <= MAX_ATTACHMENT_FILE_BYTES) return [{ id: nextFileId.current++, file }];
      store.notify(`«${attachmentLabel(file)}» больше 20 МБ.`);
      return [];
    });
    if (additions.length) setDraftFiles(current => [...current, ...additions]);
  };

  const send = async () => {
    if ((!text.trim() && draftFiles.length === 0) || activeTurn || disabled || configPending || sending.current) return;
    if (draftFiles.reduce((total, { file }) => total + file.size, 0) > MAX_MESSAGE_ATTACHMENT_BYTES) {
      store.notify('Общий размер вложений превышает 60 МБ.');
      return;
    }
    const modelConfig = { ...(currentModel?.id === model?.id ? currentModel?.config : undefined) };
    const thinkingLevel = thinking?.readOnly ? undefined : selectedLevel?.value ?? defaultLevel?.value;
    delete modelConfig.thinkingLevel;
    if (thinkingLevel) modelConfig.thinkingLevel = thinkingLevel;
    sending.current = true;
    setSendPending(true);
    try {
      const attachments = draftFiles.length ? await Promise.all(draftFiles.map(({ file }) => readFileAttachment(file))) : undefined;
      const sent = await store.run({
        op: 'sendMessage', ...target, text, waitForHost: true,
        ...(attachments ? { attachments } : {}),
        ...(model ? { modelId: model.id, ...(Object.keys(modelConfig).length ? { modelConfig } : {}) } : {}),
      });
      if (sent) {
        setText(current => current === text ? '' : current);
        setDraftFiles(current => current.filter(attachment => !draftFiles.includes(attachment)));
      }
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === 'AbortError')) store.notify(describeError(failure));
    } finally {
      sending.current = false;
      setSendPending(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <form
      className="composer"
      onSubmit={event => { event.preventDefault(); void send(); }}
      onDragOver={event => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
      }}
      onDrop={event => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        attachFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="composer-input" data-draft={text}>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={event => {
            attachFiles(Array.from(event.currentTarget.files ?? []));
            event.currentTarget.value = '';
          }}
        />
        <button type="button" disabled={disabled} onClick={() => fileInput.current?.click()} title="Прикрепить файлы" aria-label="Прикрепить файлы" className="icon-button">+</button>
        <textarea
          value={text}
          onChange={event => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={event => {
            const files = Array.from(event.clipboardData.files);
            if (!files.length) return;
            if (!event.clipboardData.getData('text/plain')) event.preventDefault();
            attachFiles(files);
          }}
          placeholder={activeTurn ? 'Агент работает…' : 'Сообщение агенту'}
          title="Enter — отправить, Shift+Enter — новая строка"
          rows={1}
          disabled={disabled}
          aria-label="Сообщение агенту"
        />
        {activeTurn ? (
          <button type="button" className="composer-action" disabled={disabled} onClick={() => void store.run({ op: 'cancelTurn', ...target, turnId: activeTurn.id })}>
            Остановить
          </button>
        ) : (
          <button
            type="submit"
            className="primary composer-action composer-send"
            aria-label={sendPending ? 'Отправка…' : 'Отправить'}
            disabled={disabled || sendPending || configPending || (!text.trim() && draftFiles.length === 0)}
          >
            <span className="composer-send-label">{sendPending ? 'Отправка…' : 'Отправить'}</span>
            <span className="composer-send-icon" aria-hidden="true">{sendPending ? '…' : '↑'}</span>
          </button>
        )}
      </div>
      {draftFiles.length > 0 && (
        <div className="composer-attachments">
          {draftFiles.map(attachment => (
            <DraftAttachment
              key={attachment.id}
              file={attachment.file}
              onRemove={() => setDraftFiles(current => current.filter(item => item !== attachment))}
            />
          ))}
        </div>
      )}
      <div className="row composer-controls" aria-busy={configPending}>
        <div className="composer-modes">{modeControls}</div>
        <div className="composer-model-options">
          {models.length > 0 ? (
            <select value={choice} onChange={event => chooseModel(event.currentTarget.value)} aria-label="Модель" disabled={disabled || sendPending}>
              <option value="">{defaultModel ? `${defaultModel.name} · по умолчанию` : 'Модель хоста'}</option>
              {models.filter(candidate => candidate.id !== defaultModel?.id).map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select>
          ) : <span className="muted">Модель хоста</span>}
          {levels.length > 0 ? (
            <select
              aria-label="Уровень reasoning"
              value={reasoningChoice}
              disabled={disabled || sendPending || thinking?.readOnly || (levels.length === 1 && !!defaultLevel)}
              title={thinking?.description}
              onChange={event => setPickedThinkingLevel(event.currentTarget.value)}
            >
              <option value="">{defaultLevel ? `${defaultLevel.label} · по умолчанию` : 'Автовыбор уровня'}</option>
              {levels.filter(level => level !== defaultLevel).map(level => <option key={level.value} value={level.value} title={level.description}>{level.label}</option>)}
            </select>
          ) : thinking?.readOnly && typeof thinking.default === 'string' ? (
            <span className="muted" title={thinking.description}>{thinking.default} · по умолчанию</span>
          ) : null}
        </div>
      </div>
    </form>
  );
}
