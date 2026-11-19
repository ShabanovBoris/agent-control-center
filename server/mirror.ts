import type { ActionEnvelope, Snapshot, StateAction } from '@microsoft/agent-host-protocol';
import type { ChannelState } from '../shared/protocol.js';
import { channelKey, reduceChannel } from '../shared/reduce.js';

interface Entry {
  readonly hostId: string;
  readonly uri: string;
  state: ChannelState | undefined;
  /** serverSeq, на котором находится state. */
  seq: number;
  /** Сколько запросов снимка сейчас в полёте. */
  pendingLoads: number;
  /** Actions, пришедшие, пока снимок запрашивался: их место относительно снимка ещё неизвестно. */
  buffered: ActionEnvelope[];
}

/** Непрозрачная метка запроса снимка. */
export type LoadToken = { readonly __loadToken: never };

interface LoadResult {
  state: ChannelState;
  invalidActions: StateAction['type'][];
}

type ApplyResult = 'applied' | 'invalid' | undefined;

/**
 * Зеркало состояния каналов на стороне backend.
 *
 * Снимок и поток actions приходят по разным путям (ответ на subscribe и очередь событий),
 * поэтому их взаимный порядок не гарантирован. Зеркало упорядочивает их по serverSeq:
 * снимок и actions не откатывают применённое состояние, а actions до первого снимка
 * дожидаются его в буфере.
 */
export class ChannelMirror {
  private readonly entries = new Map<string, Entry>();

  track(hostId: string, uri: string): void {
    const key = channelKey(hostId, uri);
    if (!this.entries.has(key)) {
      this.entries.set(key, { hostId, uri, state: undefined, seq: 0, pendingLoads: 0, buffered: [] });
    }
  }

  drop(hostId: string, uri: string): void {
    this.entries.delete(channelKey(hostId, uri));
  }

  state(hostId: string, uri: string): ChannelState | undefined {
    return this.entries.get(channelKey(hostId, uri))?.state;
  }

  urisOf(hostId: string): string[] {
    return [...this.entries.values()].filter(entry => entry.hostId === hostId).map(entry => entry.uri);
  }

  /**
   * Отмечает начало запроса снимка. Возвращает метку запроса: по ней `loadFinished`
   * отличает свой канал от заново созданного после быстрых unwatch/watch.
   */
  loadStarted(hostId: string, uri: string): LoadToken | undefined {
    const entry = this.entries.get(channelKey(hostId, uri));
    if (entry) entry.pendingLoads += 1;
    return entry as unknown as LoadToken | undefined;
  }

  /** Относится ли метка к каналу, который отслеживается сейчас, а не к его прежней подписке. */
  isCurrent(token: LoadToken | undefined): boolean {
    const entry = token as unknown as Entry | undefined;
    return entry !== undefined && this.entries.get(channelKey(entry.hostId, entry.uri)) === entry;
  }

  /**
   * Завершает запрос снимка и возвращает состояние только для принятого снимка.
   */
  loadFinished(token: LoadToken | undefined, snapshot: Snapshot | undefined): LoadResult | undefined {
    if (!this.isCurrent(token)) return undefined;
    const entry = token as unknown as Entry;
    entry.pendingLoads -= 1;
    const buffered = entry.buffered;
    if (entry.pendingLoads === 0) entry.buffered = [];
    if (!snapshot || snapshot.fromSeq < entry.seq) return undefined;

    entry.state = snapshot.state as ChannelState;
    entry.seq = snapshot.fromSeq;
    entry.buffered = [];
    const invalidActions: StateAction['type'][] = [];
    for (const envelope of buffered) {
      if (this.reduce(entry, envelope) === 'invalid') invalidActions.push(envelope.action.type);
    }
    return { state: entry.state, invalidActions };
  }

  apply(hostId: string, envelope: ActionEnvelope): ApplyResult {
    const entry = this.entries.get(channelKey(hostId, envelope.channel));
    if (!entry || envelope.rejectionReason !== undefined) return undefined;
    if (entry.state === undefined && entry.pendingLoads > 0) entry.buffered.push(envelope);
    return this.reduce(entry, envelope);
  }

  private reduce(entry: Entry, envelope: ActionEnvelope): ApplyResult {
    if (entry.state === undefined || envelope.serverSeq <= entry.seq) return undefined;
    try {
      entry.state = reduceChannel(entry.uri, entry.state, envelope.action);
    } catch {
      return 'invalid';
    }
    entry.seq = envelope.serverSeq;
    return 'applied';
  }
}
