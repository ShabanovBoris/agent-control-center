// Единая точка применения actions к состоянию канала — её используют и backend-зеркало,
// и браузер, поэтому оба получают одно и то же состояние из одних и тех же редьюсеров SDK.
import {
  changesetReducer,
  chatReducer,
  rootReducer,
  sessionReducer,
  type ChangesetAction,
  type ChangesetState,
  type ChatAction,
  type ChatState,
  type RootAction,
  type RootState,
  type SessionAction,
  type SessionState,
  type StateAction,
} from '@microsoft/agent-host-protocol';
import { ROOT_URI, type ChannelState } from './protocol.js';

export function isChangesetChannel(uri: string): boolean {
  // VS Code объявляет набор правок хода как дочерний URI чата.
  return uri.startsWith('ahp-changeset:') || /^ahp-(?:chat|session):\/[^/?#]+\/changeset\/turn\/[^/?#]+$/.test(uri);
}

export function isSupportedChannel(uri: string): boolean {
  return uri === ROOT_URI || uri.startsWith('ahp-session:') || uri.startsWith('ahp-chat:') || isChangesetChannel(uri);
}

export function reduceChannel(uri: string, state: ChannelState, action: StateAction): ChannelState {
  if (uri === ROOT_URI) return rootReducer(state as RootState, action as RootAction);
  if (isChangesetChannel(uri)) return changesetReducer(state as ChangesetState, action as ChangesetAction);
  if (uri.startsWith('ahp-session:')) return sessionReducer(state as SessionState, action as SessionAction);
  if (uri.startsWith('ahp-chat:')) return chatReducer(state as ChatState, action as ChatAction);
  throw new Error(`Unsupported channel: ${uri}`);
}

export function channelKey(hostId: string, uri: string): string {
  return `${hostId}\u0000${uri}`;
}
