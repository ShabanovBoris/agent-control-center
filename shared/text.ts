import type { StringOrMarkdown } from '@microsoft/agent-host-protocol';

/** Display text части ответа: markdown-строка либо её поле `markdown`. */
export function plain(value: StringOrMarkdown | undefined): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : value.markdown;
}

/** file: URI хоста -> путь для показа. Прочие URI показываются как есть. */
export function pathOf(uri: string | undefined): string {
  if (!uri) return '';
  try {
    const url = new URL(uri);
    return url.protocol === 'file:' ? decodeURIComponent(url.pathname) : uri;
  } catch {
    return uri;
  }
}
