import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { Message } from '@microsoft/agent-host-protocol';
import type { EditMessageResult } from '../../shared/protocol';
import { describeError, store } from '../store';

interface EditMessageDialogProps {
  hostId: string;
  sessionUri: string;
  chatUri: string;
  turnId: string;
  lastTurnId: string;
  message: Message;
  disabled: boolean;
  onClose(): void;
}

export function EditMessageDialog({ hostId, sessionUri, chatUri, turnId, lastTurnId, message, disabled, onClose }: EditMessageDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [replacementId] = useState(() => crypto.randomUUID());
  const [text, setText] = useState(message.text);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [retainedTurnId, setRetainedTurnId] = useState<string | null>();
  const truncated = retainedTurnId !== undefined;
  const canSubmit = !disabled && !pending && (text.trim().length > 0 || !!message.attachments?.length);

  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setPending(true);
    setError(undefined);
    const target = { hostId, sessionUri, chatUri, text, replacementId };
    try {
      const result = await store.call<EditMessageResult>(retainedTurnId === undefined
        ? { op: 'editMessage', ...target, turnId, lastTurnId }
        : { op: 'retryEditedMessage', ...target, retainedTurnId, message });
      if (result.status === 'sent') dialog.current?.close();
      else {
        setRetainedTurnId(result.retainedTurnId);
        setError(result.error);
      }
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <dialog ref={dialog} className="dialog edit-message-dialog" aria-labelledby={headingId} onClose={onClose} onCancel={event => {
      if (pending) event.preventDefault();
    }}>
      <form onSubmit={event => void submit(event)}>
        <h3 id={headingId}>Редактировать сообщение</h3>
        <p className="muted">
          {truncated
            ? 'История обрезана. Можно снова отправить исправленное сообщение.'
            : 'После отправки сохранятся только сообщения до этого запроса. Агент ответит на исправленный текст заново.'}
        </p>
        <textarea aria-label="Текст сообщения" rows={5} value={text} disabled={pending} onChange={event => setText(event.currentTarget.value)} autoFocus />
        {error && <p role="alert" className="error-text">{error}</p>}
        <div className="dialog-actions">
          <button type="submit" className="primary" disabled={!canSubmit}>
            {pending ? 'Отправка…' : truncated ? 'Отправить снова' : 'Сохранить и отправить'}
          </button>
          <button type="button" disabled={pending} onClick={() => dialog.current?.close()}>Отмена</button>
        </div>
      </form>
    </dialog>
  );
}
