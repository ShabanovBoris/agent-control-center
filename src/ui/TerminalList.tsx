// Общий список открытых терминалов страницы `#terminal`.
//
// Строка — это сессия PTY, а не папка: в одной папке можно держать несколько
// терминалов. Выбранная строка обведена чёрным (border-color), остальные —
// прозрачной рамкой той же толщины, чтобы список не дёргался при выборе.
export interface TerminalListEntry {
  key: string;
  hostId: string;
  uri: string;
  title: string;
  hostLabel: string;
  /** Фактический cwd из состояния канала; у только что созданного PTY — запрошенная папка. */
  cwd?: string;
  /** «выполняется» или «завершён · код N». */
  status: string;
}

export function TerminalList({ items, activeKey, onSelect }: {
  items: readonly TerminalListEntry[];
  activeKey: string | undefined;
  onSelect(hostId: string, uri: string): void;
}) {
  return (
    <ul className="terminal-list" aria-label="Открытые терминалы">
      {items.map(item => (
        <li key={item.key}>
          <button
            type="button"
            className="terminal-row"
            aria-current={item.key === activeKey ? 'true' : undefined}
            onClick={() => onSelect(item.hostId, item.uri)}
          >
            <span className="terminal-row-title" title={item.title}>{item.title}</span>
            <span className="terminal-row-meta">
              <span className="terminal-row-host">{item.hostLabel}</span>
              {item.cwd && <code className="terminal-row-cwd" title={item.cwd}>{item.cwd}</code>}
              <span className="terminal-row-status">{item.status}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}