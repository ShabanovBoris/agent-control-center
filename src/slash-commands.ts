import type { CompletionItem } from '@microsoft/agent-host-protocol';

export function slashCommand(text: string): string | undefined {
  return /^\s*(\/[\w.-]+)(?=\s|$)/u.exec(text)?.[1];
}

export function slashItems(items: CompletionItem[]): CompletionItem[] {
  return items.filter(item => /^\/[\w.-]+\s*$/u.test(item.insertText) &&
    !!item.attachment && !['/goal', '/plan'].includes(item.insertText.trim()));
}

export function applySlashItem(draft: string, offset: number, item: CompletionItem): string | undefined {
  const start = item.rangeStart ?? offset;
  const end = item.rangeEnd ?? offset;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > draft.length) return;
  const text = draft.slice(0, start) + item.insertText + draft.slice(end);
  if (slashCommand(text) === item.insertText.trim()) return text;
}

export async function sendSlashDraft(
  text: string,
  chosen: CompletionItem | undefined,
  lookup: (command: string) => Promise<CompletionItem[]>,
  send: (text: string, item: CompletionItem | undefined) => Promise<boolean>,
  clearDraft: () => void,
) {
  const command = slashCommand(text);
  if (command === '/goal') throw new Error('Штатный хост не поддерживает /goal через AHP.');
  const item = command && (chosen?.insertText.trim() === command ? chosen :
    slashItems(await lookup(command)).find(item => item.insertText.trim() === command));
  if (command && !item) throw new Error(`Команда ${command} недоступна в этом чате.`);
  if (await send(text, item || undefined)) clearDraft();
}

/** Cleanup invalidates even a response for an earlier, identical draft. */
export function requestSlashItems<T>(request: Promise<T>, publish: (result: T) => void): () => void {
  let current = true;
  void request.then(result => { if (current) publish(result); }, () => {});
  return () => { current = false; };
}
