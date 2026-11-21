import { type ReactNode } from 'react';
import { ToolResultContentType, type ToolResultContent } from '@microsoft/agent-host-protocol';

interface ToolResultsDisplayProps {
  content: ToolResultContent[];
}

const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function ToolResultsDisplay({ content }: ToolResultsDisplayProps): ReactNode {
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
          case ToolResultContentType.FileEdit:
          case ToolResultContentType.Terminal:
          case ToolResultContentType.Subagent:
          default:
            return null;
        }
      })}
    </div>
  );
}
