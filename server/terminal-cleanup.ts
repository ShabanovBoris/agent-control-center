// Автоочистка PTY — чистая функция: какие свои терминалы пора закрыть.
//
// Хост не прибирает терминалы после обрыва WebSocket, а панель не должна оставлять
// бесконечные shell'ы на маке. «Свой» терминал — это claim.kind === 'client' с нашим
// `clientId`: терминалы агентов (`claim.kind === 'session'`) не трогаются никогда,
// даже если на них никто не подписан.
import type { TerminalInfo } from '@microsoft/agent-host-protocol';

/** Брошенный терминал без наблюдателей живёт 30 минут: этого хватает на переключение задач. */
export const DEFAULT_TERMINAL_IDLE_MS = 30 * 60_000;
/** Слишком короткий порог закрывал бы shell, на который просто переключились. */
export const MIN_TERMINAL_IDLE_MS = 60_000;

/** Разбирает `ACC_TERMINAL_IDLE_MS` один раз при старте: опечатка должна падать, а не отключать уборку. */
export function terminalIdleMs(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_TERMINAL_IDLE_MS;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < MIN_TERMINAL_IDLE_MS) {
    throw new Error(`ACC_TERMINAL_IDLE_MS: ожидается число не меньше ${MIN_TERMINAL_IDLE_MS}`);
  }
  return ms;
}

export interface TerminalCleanupInput {
  now: number;
  /** Сколько миллисекунд без наблюдателей считается «брошено». */
  thresholdMs: number;
  terminals: readonly Pick<TerminalInfo, 'resource' | 'claim'>[];
  /** `clientId` этого backend: тот же, что ушёл хосту в initialize. */
  clientId: string;
  /** Есть ли сейчас хоть один наблюдатель канала. */
  watched(uri: string): boolean;
  /** Когда канал терминала последний раз оставался без наблюдателей. */
  seenAt(uri: string): number | undefined;
}

export function terminalCleanupPlan(input: TerminalCleanupInput): string[] {
  const { now, thresholdMs, terminals, clientId, watched, seenAt } = input;
  const plan: string[] = [];
  for (const terminal of terminals) {
    const { claim } = terminal;
    if (claim.kind !== 'client' || claim.clientId !== clientId) continue;
    if (watched(terminal.resource)) continue;
    // Терминал, который панель ещё не видела, получает отсчёт только сейчас:
    // отсутствие записи не должно читаться как «брошен давно».
    const since = seenAt(terminal.resource);
    if (since === undefined) continue;
    if (now - since < thresholdMs) continue;
    plan.push(terminal.resource);
  }
  return plan;
}

/** Счётчик своих терминалов без наблюдателей: из них вытесняется старейший при лимите. */
export function evictionCandidate(
  terminals: readonly Pick<TerminalInfo, 'resource' | 'claim'>[],
  input: Pick<TerminalCleanupInput, 'clientId' | 'watched' | 'seenAt'>,
): string | undefined {
  let oldest: { uri: string; since: number } | undefined;
  for (const terminal of terminals) {
    const { claim } = terminal;
    if (claim.kind !== 'client' || claim.clientId !== input.clientId) continue;
    if (input.watched(terminal.resource)) continue;
    const since = input.seenAt(terminal.resource) ?? Number.POSITIVE_INFINITY;
    if (!oldest || since < oldest.since) oldest = { uri: terminal.resource, since };
  }
  return oldest?.uri;
}
