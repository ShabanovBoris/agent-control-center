import { type ReactNode } from 'react';
import { MessageAttachmentKind, type Message } from '@microsoft/agent-host-protocol';

interface MessageViewProps {
  message: Message;
}

export function MessageView({ message }: MessageViewProps): ReactNode {
  return (
    <div className="message-view">
      {message.text && <div className="message-text">{message.text}</div>}
      {message.attachments && message.attachments.length > 0 && (
        <div className="message-attachments">
          {message.attachments.map((attachment, index) => {
            const label = attachment.label || 'Вложение';
            if (attachment.type === MessageAttachmentKind.EmbeddedResource && attachment.contentType.startsWith('image/')) {
              return (
                <div key={index} className="attachment-image">
                  <img src={`data:${attachment.contentType};base64,${attachment.data}`} alt={label} loading="lazy" />
                </div>
              );
            }
            return <div key={index} className="attachment-file">{label}</div>;
          })}
        </div>
      )}
    </div>
  );
}
