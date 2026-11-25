// Склейка вывода PTY перед отправкой браузеру.
//
// Хост присылает `terminal/data` пачками по ~200 байт (замер: 8 171 action и 1.5 МБ за 8 секунд),
// и каждый action отдельным кадром WebSocket'а — это 1000 кадров в секунду и столько же
// обновлений на клиенте. Здесь данные копятся и уходят наблюдателям не чаще `frameMs`,
// одним кадром не больше `maxFrameBytes`; хвост остаётся в буфере и уходит следующим тиком,
// поэтому байты не теряются и их порядок сохраняется.
import { channelKey } from '../shared/reduce.js';

/** ~30 кадров в секунду: быстрее человеческий глаз вывод всё равно не читает. */
export const TERMINAL_FRAME_MS = 33;
/** Предел одного кадра: 1.5 МБ за 8 секунд влезают в 12 кадров вместо 8 тысяч. */
export const TERMINAL_MAX_FRAME_BYTES = 128 * 1024;
/**
 * Потолок буфера на канал. Хост отдаёт ~187 КБ/с, а браузер дренирует очередь быстрее,
 * поэтому до потолка дело доходит только при мёртвом сокете; тогда теряется начало
 * вывода, но не работа backend.
 */
export const TERMINAL_MAX_PENDING_BYTES = 8 * 1024 * 1024;

export type TerminalTimer = ReturnType<typeof setTimeout>;

export interface TerminalStreamOptions {
  /** Отправляет непустой кадр наблюдателям канала. */
  send(hostId: string, uri: string, data: string): void;
  /** Транспорт перегружен: кадры этого канала ждут следующего тика. */
  backpressured?(hostId: string, uri: string): boolean;
  /** Инъекция таймера: тесты двигают время вручную. */
  schedule?(callback: () => void, delayMs: number): TerminalTimer;
  cancel?(handle: TerminalTimer): void;
  /** Сколько байт выброшено из начала буфера при переполнении. */
  onOverflow?(hostId: string, uri: string, bytes: number): void;
  frameMs?: number;
  maxFrameBytes?: number;
  maxPendingBytes?: number;
}

interface Pending {
  readonly hostId: string;
  readonly uri: string;
  readonly key: string;
  data: string;
  bytes: number;
}

/** Индекс, до которого строка занимает не больше `maxBytes` в UTF-8; суррогатная пара не рвётся. */
function cutIndex(data: string, maxBytes: number): number {
  if (byteLength(data) <= maxBytes) return data.length;
  let low = 0;
  let high = data.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(data.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // Не оставляем половину суррогатной пары: иначе повторная склейка даст битый символ.
  const code = data.charCodeAt(low - 1);
  const safe = low > 0 && code >= 0xd800 && code <= 0xdbff ? low - 1 : low;
  // Один символ шире лимита не должен давать пустой кадр: отдаём его целиком.
  return safe > 0 ? safe : Math.min(data.length, 2);
}

/** Первая часть строки не длиннее `maxBytes` в UTF-8. */
export function splitFrame(data: string, maxBytes: number): [frame: string, rest: string] {
  const cut = cutIndex(data, maxBytes);
  return [data.slice(0, cut), data.slice(cut)];
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export class TerminalStream {
  private readonly pending = new Map<string, Pending>();
  private timer: TerminalTimer | undefined;
  private readonly frameMs: number;
  private readonly maxFrameBytes: number;
  private readonly maxPendingBytes: number;
  private readonly schedule: NonNullable<TerminalStreamOptions['schedule']>;
  private readonly cancel: NonNullable<TerminalStreamOptions['cancel']>;

  constructor(private readonly options: TerminalStreamOptions) {
    this.frameMs = options.frameMs ?? TERMINAL_FRAME_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? TERMINAL_MAX_FRAME_BYTES;
    this.maxPendingBytes = options.maxPendingBytes ?? TERMINAL_MAX_PENDING_BYTES;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? (handle => clearTimeout(handle));
  }

  /** Добавляет фрагмент вывода канала. */
  push(hostId: string, uri: string, chunk: string): void {
    if (!chunk) return;
    const key = channelKey(hostId, uri);
    const existing = this.pending.get(key);
    if (existing) {
      existing.data += chunk;
      existing.bytes += byteLength(chunk);
      this.trim(existing);
    } else {
      this.pending.set(key, { hostId, uri, key, data: chunk, bytes: byteLength(chunk) });
      this.trim(this.pending.get(key)!);
    }
    this.arm();
  }

  /**
   * Отправляет всё накопленное канала немедленно, несколькими кадрами подряд.
   * Нужен перед любым другим сообщением канала (`terminal/exited`, снимок), иначе
   * браузер увидит статус раньше последних строк. Перегрузку транспорта игнорирует:
   * порядок важнее, а объём ограничен буфером канала.
   */
  flush(hostId: string, uri: string): void {
    const key = channelKey(hostId, uri);
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    let rest = entry.data;
    while (rest.length > 0) {
      const [frame, tail] = splitFrame(rest, this.maxFrameBytes);
      this.options.send(entry.hostId, entry.uri, frame);
      rest = tail;
    }
  }

  /** Забывает канал: терминал закрыт или за ним больше никто не следит. */
  drop(hostId: string, uri: string): void {
    this.pending.delete(channelKey(hostId, uri));
  }

  stop(): void {
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }

  /** Байты, ожидающие отправки: нужно тестам и диагностике. */
  pendingBytes(hostId: string, uri: string): number {
    return this.pending.get(channelKey(hostId, uri))?.bytes ?? 0;
  }

  private arm(): void {
    if (this.timer !== undefined) return;
    this.timer = this.schedule(() => this.tick(), this.frameMs);
  }

  private tick(): void {
    this.timer = undefined;
    for (const entry of [...this.pending.values()]) {
      if (this.options.backpressured?.(entry.hostId, entry.uri)) continue;
      const [frame, rest] = splitFrame(entry.data, this.maxFrameBytes);
      entry.data = rest;
      entry.bytes = byteLength(rest);
      this.options.send(entry.hostId, entry.uri, frame);
      if (rest.length === 0) this.pending.delete(entry.key);
    }
    if (this.pending.size > 0) this.arm();
  }

  private trim(entry: Pending): void {
    if (entry.bytes <= this.maxPendingBytes) return;
    // Буфер ограничен, чтобы мёртвый сокет не съел память backend: теряется начало вывода.
    const [dropped, rest] = splitFrame(entry.data, entry.bytes - this.maxPendingBytes);
    entry.data = rest;
    entry.bytes = byteLength(rest);
    this.options.onOverflow?.(entry.hostId, entry.uri, byteLength(dropped));
  }
}
