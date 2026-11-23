/** Отдаёт управление event loop: длинный обход чатов не должен блокировать backend. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * Гонка промиса с сигналом отмены. Исходный промис не отменяется (SDK этого не умеет),
 * но его поздний reject поглощается, чтобы не стать unhandled rejection.
 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, message = 'Отменено'): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortReason(signal, message));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {});
      reject(abortReason(signal, message));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

export function abortReason(signal: AbortSignal, message: string): unknown {
  return signal.reason instanceof Error ? signal.reason : new Error(message);
}
