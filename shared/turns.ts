import { ChatOriginKind, type ChatState, type Turn } from '@microsoft/agent-host-protocol';

/**
 * Ходы, которые видит пользователь. Некоторые хосты возвращают унаследованный
 * префикс при восстановлении боковой ветки: он скрыт из ленты и не должен
 * попадать в поиск.
 */
export function visibleTurns(chat: ChatState): readonly Turn[] {
  const origin = chat.origin;
  if (origin?.kind !== ChatOriginKind.SideChat) return chat.turns;
  const inherited = chat.turns.findIndex(turn => turn.id === origin.turnId);
  return inherited < 0 ? chat.turns : chat.turns.slice(inherited + 1);
}
