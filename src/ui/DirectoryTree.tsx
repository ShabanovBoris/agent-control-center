import { useId, useRef, useState } from 'react';
import {
  childDirectoryPath, normalizeDirectoryPath, parentDirectoryPath, sortDirectoryEntries,
} from '../../shared/directory';
import type { DirectoryListing } from '../../shared/protocol';
import { directorySourceHint, initialTreePath } from '../directory-tree';
import { describeError, store } from '../store';

interface DirectoryTreeProps {
  hostId: string;
  /** Текущее значение поля формы: дерево стартует с него при открытии. */
  initialPath: string;
  /** Нет связи, идёт выбор или создание сессии — навигация и выбор недоступны. */
  disabled: boolean;
  onChoose(path: string): void;
}

/** Inline-браузер каталогов хоста: работает с телефона, где нативного Finder нет. */
export function DirectoryTree({ hostId, initialPath, disabled, onChoose }: DirectoryTreeProps) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('/');
  const [listing, setListing] = useState<DirectoryListing>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  // Поздний ответ старой навигации не должен перетирать новый каталог.
  const requestId = useRef(0);

  const load = async (target: string) => {
    const id = ++requestId.current;
    const normalized = normalizeDirectoryPath(target);
    setPath(normalized ?? target.trim());
    setListing(undefined);
    setError(normalized ? undefined : 'Укажите абсолютный путь к папке');
    if (!normalized) return;
    setLoading(true);
    try {
      const result = await store.call<DirectoryListing>({ op: 'listDirectory', hostId, path: normalized });
      if (requestId.current !== id) return;
      setListing(result);
    } catch (failure) {
      if (requestId.current !== id) return;
      setError(describeError(failure));
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  };

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    void load(initialTreePath(initialPath));
  };

  const parent = parentDirectoryPath(path);
  const entries = listing ? sortDirectoryEntries(listing.entries) : [];
  const select = () => {
    onChoose(path);
    setOpen(false);
  };

  return (
    <div className="directory-tree">
      <button type="button" className="directory-tree-toggle" aria-expanded={open} aria-controls={panelId} disabled={disabled} onClick={toggle}>
        {open ? 'Скрыть дерево' : 'Дерево папок'}
      </button>
      {open && (
        <div className="directory-tree-panel" id={panelId}>
          <div className="directory-tree-head">
            <code className="directory-tree-path">{path}</code>
            <button type="button" disabled={disabled || loading || !parent} onClick={() => { if (parent) void load(parent); }}>‹ Вверх</button>
            <button type="button" disabled={disabled || loading || !listing} onClick={select}>Выбрать эту папку</button>
          </div>
          {listing && <p className="directory-tree-source">{directorySourceHint(listing.source)}</p>}
          {loading && <p className="directory-tree-status" aria-live="polite">Загрузка…</p>}
          {error && <p className="error-text" role="alert">{error}</p>}
          {!loading && listing && (entries.length === 0
            ? <p className="directory-tree-status">В папке нет элементов.</p>
            : (
              // key пересоздаёт список: прокрутка прошлого каталога не переезжает в новый.
              <ul className="directory-tree-list" key={path}>
                {entries.map(entry => (
                  <li key={entry.name}>
                    {entry.type === 'directory'
                      ? (
                        <button
                          type="button"
                          className="directory-tree-entry"
                          disabled={disabled || loading}
                          onClick={() => {
                            const child = childDirectoryPath(path, entry.name);
                            if (child) void load(child);
                          }}
                        >
                          <span aria-hidden="true">📁 </span>{entry.name}
                        </button>
                      )
                      : <span className="directory-tree-file"><span aria-hidden="true">📄 </span>{entry.name}</span>}
                  </li>
                ))}
              </ul>
            ))}
        </div>
      )}
    </div>
  );
}
