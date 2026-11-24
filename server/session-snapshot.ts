import { ChatInteractivity, type SessionChatSummary } from '@microsoft/agent-host-protocol';
import type { SessionOverview } from '../shared/protocol.js';

export interface ChatSnapshot {
  status?: number;
  title: string;
  hidden: boolean;
}

export interface SessionSnapshot {
  status?: number;
  modifiedAt?: string;
  title: string;
  hostLabel: string;
  chats: Map<string, ChatSnapshot>;
  defaultChat?: string;
}

const TITLE_LIMIT = 80;
const DEFAULT_TITLE = 'Сессия агента';

/** Снимок сводки сессии: общий вход для push-переходов и детектора непрочитанных. */
export function snapshotOf({ hostLabel, summary }: SessionOverview): SessionSnapshot {
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
