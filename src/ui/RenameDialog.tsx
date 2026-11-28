import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { checkSessionTitle } from '../../shared/session-title';
import { describeError } from '../store';

interface RenameDialogProps {
  heading: string;
  initialTitle: string;
  /** Доступное название поля: «Название сессии» или «Название терминала». */
  fieldLabel: string;
  onSave(title: string): Promise<void>;
  onClose(): void;
}

/**
 * Общий диалог ручного имени. Сохранение закрывает окно только при успехе:
 * ошибка остаётся рядом с полем, введённый текст не теряется.
 */
export function RenameDialog({ heading, initialTitle, fieldLabel, onSave, onClose }: RenameDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [title, setTitle] = useState(initialTitle);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const checked = checkSessionTitle(title);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await onSave(checked.title);
      dialog.current?.close();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <dialog ref={dialog} className="dialog rename-dialog" aria-labelledby={headingId} onClose={onClose} onCancel={event => {
      if (pending) event.preventDefault();
    }}>
      <form onSubmit={event => void submit(event)}>
        <h3 id={headingId}>{heading}</h3>
        <label className="rename-field">
          {fieldLabel}
          <input
            value={title}
            disabled={pending}
            onChange={event => setTitle(event.currentTarget.value)}
            spellCheck={false}
            autoFocus
          />
        </label>
        {error && <p role="alert" className="error-text">{error}</p>}
        <div className="dialog-actions">
          <button type="submit" className="primary" disabled={pending}>
            {pending ? 'Сохраняем…' : 'Сохранить'}
          </button>
          <button type="button" disabled={pending} onClick={() => dialog.current?.close()}>Отмена</button>
        </div>
      </form>
    </dialog>
  );
}
