import { useId, useRef, useState, type FormEvent } from 'react';
import type { SideChatSource } from '@microsoft/agent-host-protocol';
import { describeError } from '../store';

interface ChatSourceMenuProps {
  source: SideChatSource | undefined;
  onSelect: (source: SideChatSource, title?: string) => Promise<void>;
  disabled: boolean;
}

export function ChatSourceMenu({ source, onSelect, disabled }: ChatSourceMenuProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [selectedSource, setSelectedSource] = useState<SideChatSource>();
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const open = () => {
    if (!source || disabled) return;
    // ID текущего хода остаётся тем же после его завершения.
    setSelectedSource(source);
    setTitle('');
    setError(undefined);
    dialog.current?.showModal();
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedSource || disabled || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await onSelect(selectedSource, title.trim() || undefined);
      dialog.current?.close();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="icon-button"
        disabled={disabled || !source}
        onClick={open}
        aria-label="Боковой чат"
        title={source ? 'Создать боковой чат' : 'Сначала нужен исходный ход'}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 16.5 21 21l-4.5-1A9.5 9.5 0 1 1 20 16.5Z" />
          <path d="M12 8v8M8 12h8" />
        </svg>
      </button>
      <dialog ref={dialog} className="dialog" aria-labelledby={headingId} closedby="any" onCancel={event => {
        if (pending) event.preventDefault();
      }}>
        <form onSubmit={event => void create(event)}>
          <h3 id={headingId}>Боковой чат</h3>
          <div className="form-group">
            <label>
              Название (опционально)
              <input
                type="text"
                value={title}
                onChange={event => setTitle(event.currentTarget.value)}
                placeholder="Мой новый чат"
                maxLength={100}
                disabled={pending}
              />
            </label>
          </div>
          {error && <p className="error-text" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button type="submit" className="primary" disabled={disabled || pending || !selectedSource}>{pending ? 'Создание…' : 'Создать'}</button>
            <button type="button" disabled={pending} onClick={() => dialog.current?.close()}>Отмена</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
