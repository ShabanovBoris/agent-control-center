import type { ChatState, ModelSelection } from '@microsoft/agent-host-protocol';
import type { ModelOverview } from '../shared/protocol';

type ModelStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function preferenceKey(hostId: string, provider: string): string {
  return `acc.model.v1.${JSON.stringify([hostId, provider])}`;
}

export function readPreferredModel(storage: ModelStorage, hostId: string, provider: string): string | undefined {
  return storage.getItem(preferenceKey(hostId, provider)) ?? undefined;
}

export function savePreferredModel(storage: ModelStorage, hostId: string, provider: string, modelId: string): void {
  const key = preferenceKey(hostId, provider);
  if (modelId) storage.setItem(key, modelId);
  else storage.removeItem(key);
}

export function currentModelOf(chat: Pick<ChatState, 'draft' | 'activeTurn' | 'turns'>): ModelSelection | undefined {
  const previous = chat.activeTurn?.message.model ?? chat.turns.at(-1)?.message.model;
  const draft = chat.draft?.model;
  if (!draft) return previous;
  // VS Code может оставить в черновике только id. Явный config: {} означает сброс параметров.
  if (draft.id === previous?.id && draft.config === undefined && previous.config !== undefined) {
    return { ...draft, config: previous.config };
  }
  return draft;
}

export function composerModelOf(
  chat: Pick<ChatState, 'draft' | 'activeTurn' | 'turns' | 'turnsNextCursor'>,
  models: readonly ModelOverview[],
  defaultModelId: string | undefined,
  preferredModelId: string | undefined,
  pickedModelId: string | undefined,
) {
  const currentModel = currentModelOf(chat);
  const hasHistory = !!chat.activeTurn || chat.turns.length > 0 || chat.turnsNextCursor !== undefined;
  const inheritedModelId = currentModel?.id ?? chat.turns.at(-1)?.usage?.model;
  const defaultModel = models.find(model => model.id === defaultModelId);
  const selected = pickedModelId === '' ? undefined : (
    models.find(model => model.id === pickedModelId) ??
    models.find(model => model.id === inheritedModelId) ??
    (!hasHistory ? models.find(model => model.id === preferredModelId) : undefined)
  );
  return {
    currentModel,
    defaultModel,
    model: selected ?? defaultModel,
    choice: selected?.id !== defaultModel?.id ? selected?.id ?? '' : '',
  };
}
