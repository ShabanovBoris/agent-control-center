import { describeCallError, type CallError } from '../shared/protocol';

/** Локальная отмена поиска: backend уже получил `cancelSearch`, ответ не нужен. */
export class CallCancelled extends Error {
  constructor() {
    super('Поиск отменён');
    this.name = 'CallCancelled';
  }
}

/** Хост отклонил вызов; детали протокола важнее текста ошибки. */
export class CallRejected extends Error {
  constructor(readonly detail: CallError) {
    super(detail.message);
  }
}

export function describeError(error: unknown): string {
  if (error instanceof CallRejected) return describeCallError(error.detail);
  return error instanceof Error ? error.message : String(error);
}
