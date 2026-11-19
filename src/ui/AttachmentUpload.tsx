import { type ReactNode, useState } from 'react';
import { MessageAttachmentKind, type MessageAttachment, type MessageEmbeddedResourceAttachment } from '@microsoft/agent-host-protocol';

export const MAX_ATTACHMENT_FILE_BYTES = 20 * 1024 * 1024;

export function attachmentLabel(file: File): string {
  return file.name || (file.type.startsWith('image/') ? 'Изображение' : 'Файл');
}

export async function readFileAttachment(file: File): Promise<MessageEmbeddedResourceAttachment> {
  const label = attachmentLabel(file);
  if (file.size > MAX_ATTACHMENT_FILE_BYTES) throw new Error(`«${label}» больше 20 МБ.`);
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const fail = () => reject(new Error(`Не удалось прочитать «${label}».`));
    reader.onerror = fail;
    reader.onabort = () => reject(new DOMException('Чтение файла отменено.', 'AbortError'));
    reader.onload = () => {
      const encoded = typeof reader.result === 'string' ? reader.result.split(',')[1] : undefined;
      if (encoded !== undefined) resolve(encoded);
      else fail();
    };
    reader.readAsDataURL(file);
  });
  return {
    type: MessageAttachmentKind.EmbeddedResource,
    label,
    data,
    contentType: file.type || 'application/octet-stream',
  };
}

interface AttachmentUploadProps {
  onAttachmentsSelected: (attachments: MessageAttachment[]) => void;
  disabled?: boolean;
  maxFiles?: number;
}

export function AttachmentUpload({ onAttachmentsSelected, disabled, maxFiles = 10 }: AttachmentUploadProps): ReactNode {
  const [error, setError] = useState<string>();

  const handleFileInput = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []).slice(0, maxFiles);
    input.value = '';
    if (!files.length) return;
    setError(undefined);
    try {
      onAttachmentsSelected(await Promise.all(files.map(readFileAttachment)));
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') return;
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <div className="attachment-upload">
      <input
        type="file"
        multiple
        onChange={handleFileInput}
        disabled={disabled}
        hidden
        id="attachment-file-input"
      />
      <label htmlFor="attachment-file-input" className="attachment-button" title="Прикрепить файлы">
        +
      </label>
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  );
}
