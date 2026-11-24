import { RpcError } from '@microsoft/agent-host-protocol/client';
import type { CallError } from '../shared/protocol.js';

/** Ошибка команды backend; `code` сохраняет JSON-RPC код хоста. */
export class CallFailure extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

/** Текст RpcError без технического префикса `RPC error <code>: ` — для сообщений формы. */
const RPC_MESSAGE_PREFIX = /^RPC error -?\d+: /;

/**
 * Хостовая RPC-ошибка как CallFailure с исходным кодом и понятным текстом.
 * `undefined` — ошибка другого рода, её обрабатывает вызывающий код.
 */
export function rpcCallFailure(error: unknown): CallFailure | undefined {
  if (!(error instanceof RpcError)) return undefined;
  return new CallFailure(error.message.replace(RPC_MESSAGE_PREFIX, ''), error.code);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toCallError(error: unknown): CallError {
  if (error instanceof CallFailure || error instanceof RpcError) return { message: error.message, ...(error.code !== undefined ? { code: error.code } : {}) };
  return { message: errorMessage(error) };
}
