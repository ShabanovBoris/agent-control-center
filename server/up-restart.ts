/**
 * Бюджет перезапусков одного сервиса: ограниченное число попыток и экспоненциальный
 * backoff. Счётчик сбрасывается только после `resetAfterMs` стабильной работы,
 * поэтому редкие падения не превращаются в бесконечный цикл, а временный сбой
 * после долгой работы снова начинается с первой попытки.
 */
export interface RestartBudgetOptions {
  limit?: number;
  backoffMs?: readonly number[];
  resetAfterMs?: number;
  now?: () => number;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];
const DEFAULT_RESET_AFTER_MS = 600_000;

export class RestartBudget {
  private failures = 0;
  private stableSince: number | undefined;
  private readonly limit: number;
  private readonly backoffMs: readonly number[];
  private readonly resetAfterMs: number;
  private readonly now: () => number;

  constructor(options: RestartBudgetOptions = {}) {
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.resetAfterMs = options.resetAfterMs ?? DEFAULT_RESET_AFTER_MS;
    this.now = options.now ?? Date.now;
  }

  get failureCount(): number {
    return this.failures;
  }

  /** Сколько перезапусков ещё разрешено. */
  canRestart(): boolean {
    return this.failures < this.limit;
  }

  /** Задержка перед следующей попыткой; вызывается после `noteFailure`. */
  nextDelayMs(): number {
    if (this.backoffMs.length === 0) return 0;
    return this.backoffMs[Math.min(this.failures - 1, this.backoffMs.length - 1)]!;
  }

  /** Фиксирует падение и возвращает номер попытки (1-based). */
  noteFailure(): number {
    if (this.stableSince !== undefined && this.now() - this.stableSince >= this.resetAfterMs) {
      this.failures = 0;
    }
    this.stableSince = undefined;
    this.failures += 1;
    return this.failures;
  }

  /** Сервис снова в строю; счётчик сбросится после стабильного окна. */
  noteSuccess(): void {
    this.stableSince = this.now();
  }
}
