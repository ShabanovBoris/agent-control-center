import type { UsageStopReason } from '../shared/protocol';
import { UNDATED_USAGE_DAY } from '../shared/usage';

const number = new Intl.NumberFormat('ru-RU');

export function formatTokens(value: number): string {
  return number.format(value);
}

/** Неполная сумма — нижняя граница, поэтому `≥`; отсутствие данных не равно нулю. */
export function formatUsageTotal(total: number | undefined, partial: boolean): string {
  if (total === undefined) return 'нет данных';
  return `${partial ? '≥ ' : ''}${number.format(total)}`;
}

export function formatUsageDay(day: string): string {
  return day === UNDATED_USAGE_DAY ? 'Без даты' : day;
}

export function usageReasonLabel(reason: UsageStopReason): string {
  switch (reason) {
    case 'chat-budget': return 'Проверены не все чаты: сработал лимит отчёта';
    case 'page-budget': return 'Не вся история: сработал лимит страниц на чат';
    case 'deadline': return 'Не вся история: истекло время отчёта';
  }
}
