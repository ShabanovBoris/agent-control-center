import { type ReactNode } from 'react';
import type { TerminalPreview, TerminalResultView } from '../tool-results';

interface TerminalOutputProps {
  result: TerminalResultView;
}

function outputBody(preview: TerminalPreview, failed: boolean): ReactNode {
  if (preview.state === 'missing') {
    return <p className="muted">Хост не передал текст вывода команды.</p>;
  }
  if (preview.state === 'empty') {
    return <p className="muted">Команда завершилась без вывода.</p>;
  }
  const content = (
    <pre className={`terminal-content${failed ? ' terminal-error' : ''}`}>{preview.text}</pre>
  );
  if (!preview.long) return content;
  return (
    <details className="terminal-long">
      <summary>Показать вывод <span className="muted">{preview.lines} строк</span></summary>
      {content}
    </details>
  );
}

function exitStatus(result: TerminalResultView): { className: string; label: string } {
  if (result.state !== 'exited' || result.exitCode === undefined) {
    return { className: 'terminal-exit', label: 'Код выхода не сообщён' };
  }
  return {
    className: `terminal-exit ${result.exitCode === 0 ? 'exit-success' : 'exit-error'}`,
    label: `Код выхода: ${result.exitCode}`,
  };
}

/**
 * Сохранённый результат терминальной команды. Живой вывод панель не транслирует,
 * а `preview` PTY показывается как есть, без разбора ANSI/VT.
 */
export function TerminalOutput({ result }: TerminalOutputProps): ReactNode {
  const exit = exitStatus(result);
  const truncated = result.state === 'exited' && result.truncated && result.preview.state === 'present';

  return (
    <section className="terminal-output" title={result.resource} aria-label={`Терминал: ${result.title}`}>
      <div className="terminal-head">
        <span className="terminal-title">{result.title}</span>
        {result.isPty === true && (
          <span className="badge" title="PTY: escape-последовательности показаны как есть">PTY</span>
        )}
        {truncated && <span className="badge">Вывод обрезан</span>}
        <span className={exit.className}>{exit.label}</span>
      </div>
      {result.state === 'unreported'
        ? <p className="muted">Хост не передал итог команды. Живой вывод терминала в панели не транслируется.</p>
        : outputBody(result.preview, result.failed)}
    </section>
  );
}
