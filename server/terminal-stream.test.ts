import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TERMINAL_FRAME_MS,
  TERMINAL_MAX_FRAME_BYTES,
  TerminalStream,
  splitFrame,
  type TerminalTimer,
} from './terminal-stream.js';

interface Fixture {
  stream: TerminalStream;
  sent: { uri: string; data: string; at: number }[];
  advance(ms: number): void;
  now: number;
  /** Транспорт перегружен по этому каналу. */
  busy: boolean;
}

interface FakeTimer {
  at: number;
  callback: () => void;
}

function setup(options: { maxPendingBytes?: number; maxFrameBytes?: number; overflow?: (hostId: string, uri: string, bytes: number) => void } = {}): Fixture {
  const queue: { at: number; callback: () => void; handle: FakeTimer }[] = [];
  const fixture: Fixture = {
    stream: undefined as unknown as TerminalStream,
    sent: [],
    now: 0,
    busy: false,
    advance(ms: number) {
      const target = this.now + ms;
      while (true) {
        const next = queue.filter(item => item.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        queue.splice(queue.indexOf(next), 1);
        this.now = next.at;
        next.callback();
      }
      this.now = target;
    },
  };
  fixture.stream = new TerminalStream({
    send: (_hostId, uri, data) => fixture.sent.push({ uri, data, at: fixture.now }),
    backpressured: () => fixture.busy,
    schedule: (callback, delayMs) => {
      const handle: FakeTimer = { at: fixture.now + delayMs, callback };
      queue.push({ ...handle, handle });
      return handle as unknown as TerminalTimer;
    },
    cancel: handle => {
      const index = queue.findIndex(item => item.handle === (handle as unknown as FakeTimer));
      if (index >= 0) queue.splice(index, 1);
    },
    ...(options.maxPendingBytes !== undefined ? { maxPendingBytes: options.maxPendingBytes } : {}),
    ...(options.maxFrameBytes !== undefined ? { maxFrameBytes: options.maxFrameBytes } : {}),
    ...(options.overflow ? { onOverflow: options.overflow } : {}),
  });
  return fixture;
}

const uri = 'ahp-terminal:/one';

test('фрагменты одного тика уходят одним кадром, байты не теряются и порядок сохранён', () => {
  const fixture = setup();
  fixture.stream.push('h', uri, 'a');
  fixture.stream.push('h', uri, 'b');
  fixture.stream.push('h', uri, 'c');
  assert.equal(fixture.sent.length, 0);
  fixture.advance(TERMINAL_FRAME_MS);
  assert.deepEqual(fixture.sent.map(item => item.data), ['abc']);
});

test('частота кадров ограничена, а недописанный хвост уходит следующим тиком', () => {
  const fixture = setup({ maxFrameBytes: 4 });
  fixture.stream.push('h', uri, '0123456789');
  fixture.advance(TERMINAL_FRAME_MS);
  // Кадр не больше лимита, остаток ждёт следующего тика, а не теряется.
  assert.deepEqual(fixture.sent.map(item => item.data), ['0123']);
  assert.equal(fixture.stream.pendingBytes('h', uri), 6);
  fixture.advance(TERMINAL_FRAME_MS);
  assert.deepEqual(fixture.sent.map(item => item.data), ['0123', '4567']);
  fixture.advance(TERMINAL_FRAME_MS);
  assert.deepEqual(fixture.sent.map(item => item.data), ['0123', '4567', '89']);
  assert.equal(fixture.stream.pendingBytes('h', uri), 0);
});

test('кадр никогда не превышает лимит в байтах UTF-8', () => {
  const fixture = setup({ maxFrameBytes: 8 });
  const cyrillic = 'привет'.repeat(10);
  fixture.stream.push('h', uri, cyrillic);
  while (fixture.stream.pendingBytes('h', uri) > 0) fixture.advance(TERMINAL_FRAME_MS);
  const joined = fixture.sent.map(item => item.data).join('');
  assert.equal(joined, cyrillic, 'ни один символ не потерян и не разорван');
  for (const frame of fixture.sent) assert.ok(Buffer.byteLength(frame.data, 'utf8') <= 8, frame.data);
});

test('перегрузка транспорта откладывает кадр, не удаляя его', () => {
  const fixture = setup();
  fixture.busy = true;
  fixture.stream.push('h', uri, 'x');
  fixture.advance(TERMINAL_FRAME_MS);
  assert.equal(fixture.sent.length, 0);
  assert.equal(fixture.stream.pendingBytes('h', uri), 1);
  fixture.busy = false;
  fixture.advance(TERMINAL_FRAME_MS);
  assert.deepEqual(fixture.sent.map(item => item.data), ['x']);
});

test('flush отдаёт накопленное сразу и несколькими кадрами, сохраняя порядок', () => {
  const fixture = setup({ maxFrameBytes: 4 });
  fixture.stream.push('h', uri, '0123456789');
  fixture.stream.flush('h', uri);
  assert.deepEqual(fixture.sent.map(item => item.data), ['0123', '4567', '89']);
  assert.equal(fixture.stream.pendingBytes('h', uri), 0);
  // Таймер тика не остаётся висеть без данных.
  fixture.advance(TERMINAL_FRAME_MS);
  assert.equal(fixture.sent.length, 3);
});

test('flush перегруженного транспорта всё равно доставляет вывод перед статусом', () => {
  const fixture = setup();
  fixture.busy = true;
  fixture.stream.push('h', uri, 'bye');
  fixture.stream.flush('h', uri);
  assert.deepEqual(fixture.sent.map(item => item.data), ['bye']);
});

test('drop забывает канал, а переполнение буфера сообщает о потере', () => {
  const dropped: number[] = [];
  const fixture = setup({ maxPendingBytes: 4 });
  fixture.stream.push('h', uri, '0123456789');
  fixture.stream.drop('h', uri);
  assert.equal(fixture.stream.pendingBytes('h', uri), 0);
  assert.equal(fixture.sent.length, 0);

  const other = setup({ maxPendingBytes: 4, overflow: (_, __, bytes) => dropped.push(bytes) });
  other.stream.push('h', uri, '0123456789');
  assert.equal(other.stream.pendingBytes('h', uri), 4, 'в буфере остаётся хвост');
  assert.deepEqual(dropped, [6], 'потерянные байты видны диагностике');
  other.advance(TERMINAL_FRAME_MS);
  assert.deepEqual(other.sent.map(item => item.data), ['6789']);
});

test('splitFrame не рвёт суррогатную пару', () => {
  const [frame, rest] = splitFrame('a😀b', 2);
  assert.equal(frame, 'a');
  assert.equal(rest, '😀b');
  assert.equal(splitFrame('abc', 10)[1], '');
  assert.equal(TERMINAL_MAX_FRAME_BYTES, 128 * 1024);
});
