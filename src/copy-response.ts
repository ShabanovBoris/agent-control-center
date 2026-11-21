import { ResponsePartKind, TurnState } from '@microsoft/agent-host-protocol';

interface ResponseTextPart {
  kind: ResponsePartKind;
  content?: string | { markdown: string };
}

export function copyableResponseText(state: TurnState | undefined, responseParts: readonly ResponseTextPart[]): string | undefined {
  if (state !== TurnState.Complete) return undefined;

  for (let index = responseParts.length - 1; index >= 0; index -= 1) {
    const part = responseParts[index];
    if (part?.kind === ResponsePartKind.Markdown && typeof part.content === 'string' && part.content.trim()) return part.content;
  }
  return undefined;
}
