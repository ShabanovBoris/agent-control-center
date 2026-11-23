import { RpcError } from '@microsoft/agent-host-protocol/client';
import type { CallError } from '../shared/protocol.js';

/** Ошибка команды backend; `code` сохраняет JSON-RPC код хоста. */
export class CallFailure extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toCallError(error: unknown): CallError {
  if (error instanceof CallFailure || error instanceof RpcError) return { message: error.message, ...(error.code !== undefined ? { code: error.code } : {}) };
  return { message: errorMessage(error) };
}
