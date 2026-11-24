import { useEffect, useId, useRef, useState } from 'react';
import type { UsageReport } from '../shared/protocol';
import { CallCancelled } from './errors';
import { issueLabel } from './search';
import { describeError, store, useAppState } from './store';
import { formatTokens, formatUsageTotal, usageReasonLabel } from './usage-format';
import { UsageTables } from './UsageTables';

type ReportState =
  | { phase: 'loading' }
  | { phase: 'done'; report: UsageReport }
  | { phase: 'error'; error: string };

/**
 * Отчёт строится по кнопке на том же backend-слое истории, что и поиск.
 * Закрытие диалога отменяет обход: store шлёт `cancelUsage`, backend освобождает каналы.
 */
export function UsageReportDialog({ timeZone, onClose }: { timeZone: string; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const { connection } = useAppState();
  const [state, setState] = useState<ReportState>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);

  useEffect(() => {
    if (connection !== 'open') {
      setState({ phase: 'error', error: 'Нет связи с backend' });
      return;
    }
    const abort = new AbortController();
    setState({ phase: 'loading' });
    void store.usageReport(timeZone, abort.signal).then(
      report => { if (!abort.signal.aborted) setState({ phase: 'done', report }); },
      error => {
        if (abort.signal.aborted || error instanceof CallCancelled) return;
        setState({ phase: 'error', error: describeError(error) });
      },
    );
    return () => abort.abort();
  }, [timeZone, connection, attempt]);

  return (
    <dialog
      ref={dialog}
      className="dialog usage-report-dialog"
      aria-labelledby={heading}
      onCancel={event => { event.preventDefault(); onClose(); }}
    >
      <h3 id={heading}>Отчёт по расходу токенов</h3>
      {state.phase === 'loading' && <p role="status">Загружается отчёт: backend читает историю сессий…</p>}
      {state.phase === 'error' && (
        <>
          <p className="error-text" role="alert">{state.error}</p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setAttempt(value => value + 1)}>Повторить</button>
            <button type="button" onClick={onClose}>Закрыть</button>
          </div>
        </>
      )}
      {state.phase === 'done' && <ReportBody report={state.report} onClose={onClose} />}
    </dialog>
  );
}

function ReportBody({ report, onClose }: { report: UsageReport; onClose(): void }) {
  return (
    <>
      <p className="usage-report-summary">
        Всего: <strong>{formatUsageTotal(report.total, report.partial)}</strong>
        {' · '}Вход: {formatTokens(report.input)}
        {' · '}Выход: {formatTokens(report.output)}
        {' · '}Кэш: {formatTokens(report.cached)}
      </p>
      <p className="muted">
        Проверено {report.scannedChats} из {report.candidateChats} чатов · часовой пояс {report.timeZone} ·{' '}
        {new Date(report.generatedAt).toLocaleString('ru-RU')}
      </p>
      {report.partial && (
        <p className="usage-partial">
          Нижняя граница: отчёт не покрывает всю историю. Суммы не выдаются за точные.
        </p>
      )}
      {report.reasons.length > 0 && (
        <ul className="usage-report-reasons">
          {report.reasons.map(reason => <li key={reason}>{usageReasonLabel(reason)}</li>)}
        </ul>
      )}
      {report.issues.length > 0 && (
        <details className="usage-report-issues">
          <summary>Ошибки и пропуски ({report.issues.length})</summary>
          <ul>
            {report.issues.map((issue, index) => <li key={index}>{issueLabel(issue)}</li>)}
          </ul>
        </details>
      )}
      <UsageTables usage={report} timeZone={report.timeZone} />
      <h4>Сессии</h4>
      {report.sessions.length === 0
        ? <p className="muted">Подключённые хосты не вернули ни одного чата.</p>
        : report.sessions.map(session => (
          <details key={`${session.hostId}\u0000${session.sessionUri}`} className="usage-report-session">
            <summary>
              {session.title || session.sessionUri} · {session.hostLabel} · {formatUsageTotal(session.total, session.partial)}
              {session.archived && <span className="muted"> · архив</span>}
            </summary>
            <p className="muted">{session.provider} · {session.sessionUri}</p>
            <UsageTables usage={session} timeZone={report.timeZone} />
            {session.chats.map(chat => (
              <details key={chat.chatUri} className="usage-report-chat">
                <summary>
                  {chat.title || chat.chatUri}
                  {chat.hidden && <span className="muted"> · служебный</span>}
                  {' — '}{formatUsageTotal(chat.total, chat.partial)}
                </summary>
                <p className="muted">
                  {chat.chatUri}
                  {chat.hasMoreTurns && ' · история неполная'}
                  {chat.issue && ` · ${chat.issue}`}
                </p>
                <UsageTables usage={chat} timeZone={report.timeZone} />
              </details>
            ))}
          </details>
        ))}
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>Закрыть</button>
      </div>
    </>
  );
}
