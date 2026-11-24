/**
 * Порог расхода хранится одним числом в localStorage: это настройка браузера,
 * без токенов доступа и без привязки к хосту. Ошибки storage не скрываются.
 */
export interface BudgetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const TOKEN_BUDGET_KEY = 'acc.tokenBudget.v1';

export function readTokenBudget(storage: BudgetStorage): number | undefined {
  const saved = storage.getItem(TOKEN_BUDGET_KEY);
  if (saved === null) return undefined;
  const text = saved.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function saveTokenBudget(storage: BudgetStorage, budget: number | undefined): void {
  if (budget === undefined) {
    storage.removeItem(TOKEN_BUDGET_KEY);
    return;
  }
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error('Порог должен быть целым числом больше нуля');
  storage.setItem(TOKEN_BUDGET_KEY, String(budget));
}

interface LatchEntry {
  budget: number;
  above: boolean;
}

/**
 * Машина состояний «ниже/выше» вне React: StrictMode и перемонтирование панели
 * не должны повторять уведомление. Ключ — сессия, поэтому latch ограничен LRU.
 */
export class BudgetLatch {
  private readonly entries = new Map<string, LatchEntry>();

  constructor(private readonly capacity = 128) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Ёмкость latch должна быть положительной');
  }

  /** `true` ровно один раз на переход ниже→выше при неизменном пороге. */
  observe(key: string, value: number | undefined, budget: number | undefined): boolean {
    if (value === undefined || !Number.isFinite(value) || value < 0) return false;
    if (budget === undefined || !Number.isFinite(budget) || budget <= 0) return false;
    const previous = this.entries.get(key);
    const above = value >= budget;
    this.entries.delete(key);
    this.entries.set(key, { budget, above });
    this.evict();
    // Первое наблюдение и смена порога тихие: сравнение начинается со следующего рендера.
    if (!previous || previous.budget !== budget) return false;
    return above && !previous.above;
  }

  reset(key?: string): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(): void {
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}

export const usageBudgetLatch = new BudgetLatch();
