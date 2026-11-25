// Эмулятор терминала: xterm.js + fit addon в отдельном ленивом чанке.
//
// Модуль грузится только на странице `#terminal`, поэтому основной бандл не растёт
// на размер xterm. Вывод PTY приходит кадром `terminalData` мимо React-состояния
// и пишется прямо в терминал; React владеет лишь контейнером и статусом.
import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalState } from '../../shared/protocol';
import { store } from '../store';

/** Прокрутка ограничена: 1.5 МБ вывода не должны превращаться в бесконечную память вкладки. */
const SCROLLBACK_LINES = 5000;
/** Ресайз шлётся не чаще этого: ResizeObserver на телефоне дёргается на каждый пиксель. */
const RESIZE_DEBOUNCE_MS = 150;

interface TerminalEmulatorProps {
  hostId: string;
  uri: string;
  /** Текущий снимок канала: первое открытие, F5 и reconnect начинают вывод с него. */
  state: TerminalState | undefined;
  /** Номер снимка: меняется только когда канал прислал новую точку отсчёта. */
  epoch: number | undefined;
  /** Панель выбрана в списке: только она получает фокус клавиатуры. */
  active: boolean;
  /** Нет связи или PTY завершён: ввод не отправляется. */
  interactive: boolean;
  onNotice(message: string): void;
}

export default function TerminalEmulator({ hostId, uri, state, epoch, active, interactive, onNotice }: TerminalEmulatorProps) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | undefined>(undefined);
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;
  /** Какой снимок канала уже нарисован: повторный рендер того же снимка не стирает экран. */
  const appliedEpoch = useRef<number | undefined>(undefined);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const term = new Terminal({
      scrollback: SCROLLBACK_LINES,
      // Ширина и высота приходят от layout: fit addon подгоняет сетку под контейнер.
      convertEol: false,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      // `screenReaderMode` намеренно выключен: при нём xterm игнорирует `input`-события
      // с текстом (`CoreBrowserTerminal._inputEvent`), и с мобильной клавиатуры, из IME
      // и с русской раскладки в PTY не доходит ни один символ.
      screenReaderMode: false,
      theme: { background: '#11151c', foreground: '#e6edf3', cursor: '#e6edf3', selectionBackground: '#264f78' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    terminal.current = term;
    // Новый xterm — чистый экран: снимок нужно применить заново, даже если он уже был
    // применён к предыдущему экземпляру (StrictMode монтирует эффект дважды).
    appliedEpoch.current = undefined;

    const input = term.onData(data => {
      if (!interactiveRef.current) return;
      // Ввод — fire-and-forget: подтверждение придёт выводом PTY, а не ответом команды.
      store.call({ op: 'terminalInput', hostId, terminalUri: uri, data }).catch(error => {
        noticeRef.current(error instanceof Error ? error.message : String(error));
      });
    });

    const sendResize = () => {
      const dimensions = fit.proposeDimensions();
      if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) return;
      if (!interactiveRef.current) return;
      store.call({ op: 'terminalResize', hostId, terminalUri: uri, cols: dimensions.cols, rows: dimensions.rows })
        .catch(() => undefined);
    };
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      fit.fit();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(sendResize, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(element);
    // Первый fit — синхронно: иначе xterm стартует с 80×24 и первая строка обрезается.
    fit.fit();
    sendResize();

    return () => {
      clearTimeout(resizeTimer);
      observer.disconnect();
      input.dispose();
      term.dispose();
      terminal.current = undefined;
    };
    // Зависимости — только адрес канала: пересоздание терминала на каждый рендер недопустимо.
  }, [hostId, uri]);

  // Снимок канала — точка отсчёта: reset + replay. Новая точка отсчёта приходит только
  // на первом открытии, F5, возврате на страницу, reconnect и `terminal/cleared`, поэтому
  // `resized` или `exited` не стирают уже нарисованное.
  useEffect(() => {
    const term = terminal.current;
    if (!term || !state) return;
    if (appliedEpoch.current === epoch) return;
    appliedEpoch.current = epoch;
    term.reset();
    term.write(contentOf(state));
  }, [state, epoch]);

  // Фокус — только у выбранной панели. Скрытые панели остаются смонтированными
  // и продолжают писать поток, но клавиатура не должна уходить в невидимый xterm.
  useEffect(() => {
    if (active) terminal.current?.focus();
  }, [active]);

  // Поток вывода: подписка адресная и живёт вместе с компонентом, не завися от рендеров.
  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    return store.subscribeChannelData(hostId, uri, data => term.write(data));
  }, [hostId, uri]);

  return <div className="terminal-screen" ref={container} />;
}

/** Поток байтов из частей: так же, как его склеивает SDK при отдаче снимка. */
function contentOf(state: TerminalState): string {
  return state.content.map(part => (part.type === 'command' ? part.output : part.value)).join('');
}
