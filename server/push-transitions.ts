import { ChatInteractivity, SessionStatus, type SessionChatSummary } from '@microsoft/agent-host-protocol';
import { channelKey } from '../shared/reduce.js';
import { isArchived, phaseOf, type Phase } from '../shared/status.js';
import type { Overview, SessionOverview } from '../shared/protocol.js';

export interface PushTransition {
  hostId: string;
  sessionUri: string;
  hostLabel: string;
  title: string;
  kind: 'input' | 'done' | 'error';
  chatUri?: string;
  chatTitle?: string;
}

interface ChatSnapshot {
  status?: number;
  title: string;
  hidden: boolean;
}

interface SessionSnapshot {
  status?: number;
  modifiedAt?: string;
  title: string;
  hostLabel: string;
  chats: Map<string, ChatSnapshot>;
  defaultChat?: string;
}

interface Notified {
  kind: PushTransition['kind'];
  modifiedAt?: string;
}

interface ChatRef {
  chatUri: string;
  chatTitle?: string;
}

const TITLE_LIMIT = 80;
const DEFAULT_TITLE = 'Сессия агента';

/**
 * Сравнивает последовательные сводки и возвращает только реальные переходы.
 * Повторный snapshot с теми же статусами ничего не даёт — это защищает от спама.
 */
export class PushTransitions {
  private snapshots = new Map<string, SessionSnapshot>();
  private readonly lastNotified = new Map<string, Notified>();
  private started = false;

  observe(overview: Overview): PushTransition[] {
    const next = new Map<string, SessionSnapshot>();
    const transitions: PushTransition[] = [];
    for (const session of overview.sessions) {
      const snapshot = snapshotOf(session);
      const key = channelKey(session.hostId, session.summary.resource);
      next.set(key, snapshot);
      const previous = this.snapshots.get(key);
      // Первая сводка после старта backend и новые сессии — baseline без уведомлений.
      if (!this.started || !previous) continue;
      const transition = detect(previous, snapshot, session);
      if (!transition) continue;
      if (this.wasNotified(key, transition, snapshot.modifiedAt)) continue;
      this.lastNotified.set(key, { kind: transition.kind, ...(snapshot.modifiedAt ? { modifiedAt: snapshot.modifiedAt } : {}) });
      transitions.push(transition);
    }
    for (const key of this.lastNotified.keys()) {
      if (!next.has(key)) this.lastNotified.delete(key);
    }
    this.snapshots = next;
    this.started = true;
    return transitions;
  }

  /** Replay старой сводки после reconnect не должен повторять уведомление того же хода. */
  private wasNotified(key: string, transition: PushTransition, modifiedAt: string | undefined): boolean {
    const notified = this.lastNotified.get(key);
    return notified?.kind === transition.kind && notified.modifiedAt !== undefined && notified.modifiedAt === modifiedAt;
  }
}

function detect(previous: SessionSnapshot, next: SessionSnapshot, session: SessionOverview): PushTransition | undefined {
  const nextStatus = next.status;
  // Без статуса сессии остаётся только ошибка отдельного чата.
  if (nextStatus !== undefined && isArchived(nextStatus)) return undefined;
  if (previous.status !== undefined && isArchived(previous.status)) return undefined;
  const prevPhase = phase(previous.status);
  const nextPhase = phase(nextStatus);

  const make = (kind: PushTransition['kind'], chat?: ChatRef): PushTransition => ({
    hostId: session.hostId,
    sessionUri: session.summary.resource,
    hostLabel: next.hostLabel,
    title: next.title,
    kind,
    ...(chat ? { chatUri: chat.chatUri, ...(chat.chatTitle ? { chatTitle: chat.chatTitle } : {}) } : {}),
  });

  // Приоритет на одну сводку: подтверждение важнее ошибки, ошибка важнее завершения хода.
  if (nextPhase === 'input' && prevPhase !== 'input') {
    return make('input', inputChat(next) ?? defaultChat(next));
  }
  const error = errorChat(previous, next);
  if ((prevPhase !== 'error' && nextPhase === 'error') || error) {
    return make('error', error ?? errorChatIn(next) ?? defaultChat(next));
  }
  if (prevPhase === 'running' && nextPhase === 'idle') {
    return make('done', finishedChat(previous, next) ?? defaultChat(next));
  }
  return undefined;
}

function phase(status: number | undefined): Phase | undefined {
  return status === undefined ? undefined : phaseOf(status);
}

function visibleChats(snapshot: SessionSnapshot): [string, ChatSnapshot][] {
  return [...snapshot.chats].filter(([, chat]) => !chat.hidden);
}

function chatRef(uri: string, snapshot: SessionSnapshot): ChatRef {
  const title = snapshot.chats.get(uri)?.title;
  return { chatUri: uri, ...(title ? { chatTitle: title } : {}) };
}

function inputChat(snapshot: SessionSnapshot): ChatRef | undefined {
  for (const [uri, chat] of visibleChats(snapshot)) {
    if (chat.status !== undefined && (chat.status & SessionStatus.InputNeeded) === SessionStatus.InputNeeded) {
      return chatRef(uri, snapshot);
    }
  }
  return undefined;
}

/** Чат, который только что получил ошибку: статус чата может не подняться до статуса сессии. */
function errorChat(previous: SessionSnapshot, next: SessionSnapshot): ChatRef | undefined {
  for (const [uri, chat] of visibleChats(next)) {
    if (chat.status === undefined || (chat.status & SessionStatus.Error) === 0) continue;
    if (!previous.chats.has(uri)) continue;
    const before = previous.chats.get(uri)?.status;
    if (before === undefined || (before & SessionStatus.Error) === 0) return chatRef(uri, next);
  }
  return undefined;
}

function errorChatIn(snapshot: SessionSnapshot): ChatRef | undefined {
  for (const [uri, chat] of visibleChats(snapshot)) {
    if (chat.status !== undefined && (chat.status & SessionStatus.Error) !== 0) return chatRef(uri, snapshot);
  }
  return undefined;
}

function finishedChat(previous: SessionSnapshot, next: SessionSnapshot): ChatRef | undefined {
  for (const [uri, chat] of visibleChats(next)) {
    const before = previous.chats.get(uri)?.status;
    if (before === undefined || (before & SessionStatus.InProgress) === 0) continue;
    const active = SessionStatus.InProgress | SessionStatus.InputNeeded | SessionStatus.Error;
    // Отсутствующий статус чата не активен: сессия уже Idle, ход действительно закончен.
    if (((chat.status ?? 0) & active) === 0) return chatRef(uri, next);
  }
  return undefined;
}

function defaultChat(snapshot: SessionSnapshot): ChatRef | undefined {
  const uri = snapshot.defaultChat;
  if (!uri || snapshot.chats.get(uri)?.hidden) return undefined;
  return chatRef(uri, snapshot);
}

function snapshotOf({ hostLabel, summary }: SessionOverview): SessionSnapshot {
  const chats = new Map<string, ChatSnapshot>();
  for (const chat of summary.chats ?? []) {
    chats.set(chat.resource, {
      ...(typeof chat.status === 'number' ? { status: chat.status } : {}),
      title: chatTitle(chat),
      hidden: chat.interactivity === ChatInteractivity.Hidden,
    });
  }
  return {
    ...(typeof summary.status === 'number' ? { status: summary.status } : {}),
    ...(typeof summary.modifiedAt === 'string' ? { modifiedAt: summary.modifiedAt } : {}),
    title: sessionTitle(summary.title),
    hostLabel,
    chats,
    ...(typeof summary.defaultChat === 'string' ? { defaultChat: summary.defaultChat } : {}),
  };
}

function sessionTitle(title: string | undefined): string {
  const trimmed = title?.trim();
  if (!trimmed) return DEFAULT_TITLE;
  return trimmed.length <= TITLE_LIMIT ? trimmed : `${trimmed.slice(0, TITLE_LIMIT - 1).trimEnd()}…`;
}

function chatTitle(chat: SessionChatSummary): string {
  const trimmed = chat.title?.trim();
  return trimmed || 'Чат';
}
