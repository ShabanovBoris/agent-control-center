import { ActionType, ReconnectResultType, type ProtocolMessage } from '@microsoft/agent-host-protocol';
import type { AhpTransport, TransportFrame } from '@microsoft/agent-host-protocol/client';
import { ROOT_URI } from '../shared/protocol.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validEnvelope(value: unknown): boolean {
  if (!isRecord(value) || typeof value.channel !== 'string' || !Number.isSafeInteger(value.serverSeq)) return false;
  const action = value.action;
  if (!isRecord(action) || typeof action.type !== 'string') return false;
  if (value.rejectionReason !== undefined) return typeof value.rejectionReason === 'string';
  if (value.channel !== ROOT_URI) return true;

  // MultiHostClient применяет корневые действия до публикации в Hub.
  switch (action.type) {
    case ActionType.RootAgentsChanged:
      return Array.isArray(action.agents) && action.agents.every(agent =>
        isRecord(agent) && typeof agent.provider === 'string' && typeof agent.displayName === 'string' &&
        Array.isArray(agent.models) && agent.models.every(model => isRecord(model) && typeof model.id === 'string' && typeof model.name === 'string'));
    case ActionType.RootTerminalsChanged:
      return Array.isArray(action.terminals);
    default:
      return true;
  }
}

/** Проверяет входящий action до его применения внутри SDK, включая replay при reconnect. */
export function guardHostActions(transport: AhpTransport, hostId: string): AhpTransport {
  const decoder = new TextDecoder();
  const accept = (envelope: unknown): boolean => {
    if (validEnvelope(envelope)) return true;
    const action = isRecord(envelope) ? envelope.action : undefined;
    const uri = isRecord(envelope) && typeof envelope.channel === 'string' ? envelope.channel : 'без канала';
    const type = isRecord(action) && typeof action.type === 'string' ? action.type : 'без типа';
    console.warn('[ahp] Некорректное действие хоста', hostId, uri, type);
    return false;
  };

  return {
    send: message => transport.send(message),
    close: () => transport.close(),
    async recv(): Promise<TransportFrame | null> {
      while (true) {
        const frame = await transport.recv();
        if (frame === null) return null;
        let message: unknown;
        try {
          message = frame.kind === 'parsed' ? frame.message
            : JSON.parse(frame.kind === 'text' ? frame.text : decoder.decode(frame.data));
        } catch {
          console.warn('[ahp] Некорректный JSON от хоста', hostId);
          continue;
        }
        if (!isRecord(message)) continue;
        if (message.method === 'action' && !('id' in message) && !accept(message.params)) continue;
        const result = message.result;
        if (isRecord(result) && result.type === ReconnectResultType.Replay && Array.isArray(result.actions)) {
          return { kind: 'parsed', message: { ...message, result: { ...result, actions: result.actions.filter(accept) } } as ProtocolMessage };
        }
        return { kind: 'parsed', message: message as ProtocolMessage };
      }
    },
  };
}
