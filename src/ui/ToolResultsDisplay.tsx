import { type ReactNode } from 'react';
import { ToolResultContentType, type ToolResultContent } from '@microsoft/agent-host-protocol';

interface ToolResultsDisplayProps {
  content: ToolResultContent[];
}

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
          case ToolResultContentType.Image:
            return (
              <div key={index} className="tool-result-image">
                <img
                  src={`data:${item.mimeType};base64,${item.data}`}
                  alt="Tool result image"
                  style={{ maxWidth: '100%', maxHeight: '400px' }}
                />
              </div>
            );
          case ToolResultContentType.File:
            return (
              <div key={index} className="tool-result-file">
                <a href={`data:${item.mimeType};base64,${item.data}`} download={item.name}>
                  📄 {item.name}
                </a>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
