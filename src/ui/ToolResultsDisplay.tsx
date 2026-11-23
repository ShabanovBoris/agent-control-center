import { type ReactNode } from 'react';
import { ToolResultContentType, type ToolResultContent } from '@microsoft/agent-host-protocol';
import { subagentTarget, terminalResultView, type SubagentNavigation } from '../tool-results';
import { SubagentCard } from './SubagentCard';
import { TerminalOutput } from './TerminalOutput';

interface ToolResultsDisplayProps {
  content: ToolResultContent[];
  subagentNavigation?: SubagentNavigation;
}

const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function ToolResultsDisplay({ content, subagentNavigation }: ToolResultsDisplayProps): ReactNode {
  if (!content.length) {
    return null;
  }

  return (
    <div className="tool-results">
      {content.map((item, index) => {
        switch (item.type) {
          case ToolResultContentType.Text:
            return (
              <div key={index} className="tool-result-text">
                <pre>{item.text}</pre>
              </div>
            );
          case ToolResultContentType.EmbeddedResource:
            return IMAGE_CONTENT_TYPES.has(item.contentType.toLowerCase()) ? (
              <div key={index} className="tool-result-image">
                <img
                  src={`data:${item.contentType};base64,${item.data}`}
                  alt="Tool result image"
                  style={{ maxWidth: '100%', maxHeight: '400px' }}
                />
              </div>
            ) : (
              <div key={index} className="tool-result-label">{item.contentType}</div>
            );
          case ToolResultContentType.Resource:
            return <div key={index} className="tool-result-label">{item.uri}</div>;
          case ToolResultContentType.Terminal:
            return <TerminalOutput key={`terminal:${index}:${item.resource}`} result={terminalResultView(item)} />;
          case ToolResultContentType.Subagent: {
            const target = subagentTarget(item, subagentNavigation?.availableChats);
            // Переход возможен только в чат из каталога сессии: URI из ответа хоста сам по себе не доверенный.
            return (
              <SubagentCard
                key={`subagent:${index}:${target.chatUri}`}
                name={target.name}
                type={target.agentName}
                label={target.description}
              >
                {subagentNavigation && target.available ? (
                  <button type="button" className="subagent-open" title={target.chatUri}
                    onClick={() => subagentNavigation.onOpenChat(target.chatUri)}>
                    Открыть чат подагента
                  </button>
                ) : (
                  <span className="muted" title={target.chatUri}>Чат подагента недоступен в этой сессии</span>
                )}
              </SubagentCard>
            );
          }
          case ToolResultContentType.FileEdit:
          default:
            return null;
        }
      })}
    </div>
  );
}
