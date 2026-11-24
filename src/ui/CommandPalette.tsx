import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { prepareQuery } from '../../shared/search';
import type { SearchHistoryResult } from '../../shared/protocol';
import type { Selection } from '../format';
import {
  DEFAULT_PALETTE_LIMITS,
  buildLoadedCorpus,
  deepToPalette,
  issueLabel,
  mergeSearchResults,
  recentSessionResults,
  searchComplete,
  searchLoaded,
  searchOverview,
  searchStatusText,
  type PaletteResult,
} from '../search';
import { CallCancelled } from '../errors';
import { pinnedKeys } from '../session-list';
import { describeError, store, useAppState } from '../store';
import { HighlightedText } from './HighlightedText';

type DeepState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; result: SearchHistoryResult }
  | { phase: 'error'; error: string };

const DEBOUNCE_MS = 320;

export function CommandPalette({ onClose, onNavigate }: { onClose(): void; onNavigate(selection: Selection): void }) {
  const { overview, channels, connection, sessionUserState } = useAppState();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const heading = useId();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [deep, setDeep] = useState<DeepState>({ phase: 'idle' });
  const [activeKey, setActiveKey] = useState<string>();
  const [retryNonce, setRetryNonce] = useState(0);
  const controller = useRef<AbortController | undefined>(undefined);

  const prepared = useMemo(() => prepareQuery(deferredQuery), [deferredQuery]);
  const pinned = useMemo(() => pinnedKeys(sessionUserState.pinned), [sessionUserState.pinned]);
  const corpus = useMemo(() => buildLoadedCorpus(overview, channels), [overview, channels]);
  const metadata = useMemo(() => searchOverview(overview, channels, prepared), [overview, channels, prepared]);
  const loaded = useMemo(() => searchLoaded(corpus, prepared), [corpus, prepared]);
  const historyResults = useMemo(() => (deep.phase === 'done' ? deepToPalette(deep.result, overview) : []), [deep, overview]);
  const turns = useMemo(() => mergeSearchResults(loaded, historyResults), [loaded, historyResults]);
  const groups = useMemo(() => prepared
    ? [
        { label: 'Сессии и чаты', items: metadata },
        { label: 'Сообщения', items: turns },
      ].filter(group => group.items.length > 0)
    : [{ label: 'Недавние сессии', items: recentSessionResults(overview, 8, pinned) }], [prepared, metadata, turns, overview, pinned]);
  const flat = useMemo(() => groups.flatMap(group => group.items), [groups]);
  const active = flat.find(item => item.key === activeKey) ?? flat[0];
  const activeIndex = active ? flat.indexOf(active) : -1;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    input.current?.focus();
    return () => { if (element.open) element.close(); };
  }, []);

  useEffect(() => {
    const ready = !!prepared && prepared.normalized.length >= 2;
    controller.current?.abort();
    if (!ready || connection !== 'open') {
      setDeep({ phase: 'idle' });
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setDeep({ phase: 'running' });
    const timer = setTimeout(() => {
      void store.search(deferredQuery, abort.signal).then(
        result => { if (controller.current === abort && !abort.signal.aborted) setDeep({ phase: 'done', result }); },
        error => {
          if (abort.signal.aborted || error instanceof CallCancelled) return;
          if (controller.current === abort) setDeep({ phase: 'error', error: describeError(error) });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
      if (controller.current === abort) controller.current = undefined;
    };
  }, [deferredQuery, prepared, connection, retryNonce]);

  useEffect(() => {
    // Смена запроса сбрасывает активную строку: deep-результаты меняют порядок.
    setActiveKey(undefined);
  }, [deferredQuery]);

  useEffect(() => {
    if (activeKey === undefined) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' });
  }, [activeKey, activeIndex]);

  const move = (delta: number) => {
    if (flat.length === 0) return;
    const index = activeIndex < 0 ? 0 : (activeIndex + delta + flat.length) % flat.length;
    setActiveKey(flat[index]!.key);
  };

  const choose = (item: PaletteResult | undefined) => {
    if (!item) return;
    onNavigate({
      hostId: item.hostId,
      sessionUri: item.sessionUri,
      ...(item.chatUri ? { chatUri: item.chatUri } : {}),
      ...(item.chatUri && item.turnId ? { turnId: item.turnId } : {}),
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); return; }
    if (event.key === 'Home') { event.preventDefault(); if (flat[0]) setActiveKey(flat[0].key); return; }
    if (event.key === 'End') { event.preventDefault(); if (flat.at(-1)) setActiveKey(flat.at(-1)!.key); return; }
    if (event.key === 'Enter') {
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      choose(active);
    }
  };

  const ready = !!prepared && prepared.normalized.length >= 2;
  const localErrors = [...corpus.errors];
  const status = searchStatusText({
    phase: deep.phase,
    ...(deep.phase === 'done' ? { result: deep.result } : {}),
    ...(deep.phase === 'error' ? { error: deep.error } : {}),
    localIncomplete: corpus.incomplete,
    localErrors,
    ready,
  });
  const issues = deep.phase === 'done' ? deep.result.issues : [];
  const noResults = prepared && flat.length === 0 && deep.phase === 'done';

  return (
    <dialog
      ref={dialog}
      className="palette"
      aria-labelledby={heading}
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={onKeyDown}
    >
      <h2 id={heading} className="visually-hidden">Поиск по сессиям и истории</h2>
      <header className="palette-header">
        <input
          ref={input}
          className="palette-input"
          value={query}
          maxLength={200}
          placeholder="Сессия, папка, сообщение…"
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-activedescendant={active ? optionId(activeIndex) : undefined}
          onChange={event => setQuery(event.target.value)}
        />
        <button type="button" className="palette-close" aria-label="Закрыть поиск" onClick={onClose}>Esc</button>
      </header>
      <div className="palette-list" id="palette-list" role="listbox" aria-label="Результаты поиска">
        {groups.map(group => (
          <div key={group.label} role="group" aria-label={group.label}>
            <p className="palette-group">{group.label}</p>
            {group.items.map(item => {
              const index = flat.indexOf(item);
              return (
                <div
                  key={item.key}
                  id={optionId(index)}
                  role="option"
                  aria-selected={item.key === active?.key}
                  className="palette-option"
                  onMouseMove={() => setActiveKey(item.key)}
                  onClick={() => choose(item)}
                >
                  <div className="palette-option-title">
                    <HighlightedText text={item.title.text} ranges={item.title.ranges} />
                    {item.archived && <span className="palette-badge">архив</span>}
                    {item.origin === 'history' && <span className="palette-badge">из истории</span>}
                    {item.origin === 'loaded' && <span className="palette-badge">открытая сессия</span>}
                  </div>
                  {item.snippet && (
                    <p className="palette-option-snippet">
                      <span className="palette-option-label">{item.snippet.label}: </span>
                      <HighlightedText text={item.snippet.text} ranges={item.snippet.ranges} />
                    </p>
                  )}
                  {item.context && <p className="palette-option-context">{item.context}</p>}
                </div>
              );
            })}
          </div>
        ))}
        {noResults && (
          <p className="palette-status">
            {searchComplete(deep.result) && !corpus.incomplete && deep.result.issues.length === 0
              ? 'Ничего не найдено.'
              : 'Совпадений нет: история проверена не полностью.'}
          </p>
        )}
        {!prepared && <p className="palette-hint">Начните печатать: поиск идёт по названиям, папкам, провайдерам и истории сообщений.</p>}
      </div>
      <footer className="palette-footer">
        {status && <p className="palette-status" aria-live="polite">{status}</p>}
        {localErrors.map(error => <p key={error} className="palette-error">{error}</p>)}
        {issues.length > 0 && (
          <details className="palette-issues">
            <summary>Ошибки хостов: {issues.length}</summary>
            <ul>
              {issues.slice(0, 10).map((issue, index) => <li key={index}>{issueLabel(issue)}</li>)}
            </ul>
            {issues.length > 10 && <p>ещё {issues.length - 10}</p>}
          </details>
        )}
        {deep.phase === 'error' && <button type="button" onClick={() => setRetryNonce(value => value + 1)}>Повторить</button>}
        <span className="palette-kbd">↑↓ выбрать · Enter открыть · Esc закрыть</span>
      </footer>
    </dialog>
  );
}

function optionId(index: number): string {
  return `palette-option-${index}`;
}
