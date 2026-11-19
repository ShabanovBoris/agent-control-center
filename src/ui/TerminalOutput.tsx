import { type ReactNode } from 'react';

interface TerminalOutputProps {
  output: string;
  exitCode?: number;
  command?: string;
}

export function TerminalOutput({ output, exitCode, command }: TerminalOutputProps): ReactNode {
  return (
    <div className="terminal-output">
      {command && (
        <div className="terminal-command">
          <span className="terminal-prompt">$</span>
          <span>{command}</span>
        </div>
      )}
      <pre className={`terminal-content ${exitCode !== 0 ? 'terminal-error' : ''}`}>
        {output}
      </pre>
      {exitCode !== undefined && (
        <div className={`terminal-exit ${exitCode === 0 ? 'exit-success' : 'exit-error'}`}>
          Exit code: {exitCode}
        </div>
      )}
    </div>
  );
}
