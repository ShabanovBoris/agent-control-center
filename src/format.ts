import {
  ChatInputAnswerState,
  ChatInputAnswerValueKind,
  ChatInputQuestionKind,
  ChatInputResponseKind,
  type ChatInputAnswer,
  type ChatInputQuestion,
  type ChatInputRequest,
} from '@microsoft/agent-host-protocol';
import type { HostStatus } from '../shared/protocol';
import type { Phase } from '../shared/status';

// Роутинг, фазу и текстовые хелперы делят клиент, backend и service worker; отсюда они только
// реэкспортируются, чтобы существующие импорты `./format` продолжали работать.
export { pathOf, plain } from '../shared/text';
export { isArchived, phaseOf, type Phase } from '../shared/status';
export { selectionFromHash, selectionToHash, type Selection } from '../shared/routing';

export const HOST_STATUS_LABEL: Record<HostStatus, string> = {
  connected: 'Подключён',
  connecting: 'Подключение…',
  reconnecting: 'Переподключение…',
  disconnected: 'Отключён',
  failed: 'Недоступен',
};

export const PHASE_LABEL: Record<Phase, string> = {
  input: 'Ждёт ответа',
  running: 'В работе',
  error: 'Ошибка',
  idle: 'Свободна',
};

const relative = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });

export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  if (Number.isNaN(seconds)) return '';
  const abs = Math.abs(seconds);
  if (abs < 60) return relative.format(seconds, 'second');
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), 'hour');
  return relative.format(Math.round(seconds / 86400), 'day');
}

/** Чем закончился запрос ввода агента: ответы пользователя либо причина их отсутствия. */
export function inputOutcome(request: ChatInputRequest, response: ChatInputResponseKind | undefined): string {
  if (response === undefined) return 'закрыт без ответа';
  if (response === ChatInputResponseKind.Decline) return 'отклонён';
  if (response === ChatInputResponseKind.Cancel) return 'отменён';
  const questions = request.questions ?? [];
  if (questions.length === 0) return 'принят';
  return questions
    .map(question => `${question.title ?? question.message}: ${answerText(question, request.answers?.[question.id])}`)
    .join('; ');
}

function answerText(question: ChatInputQuestion, answer: ChatInputAnswer | undefined): string {
  if (!answer || answer.state === ChatInputAnswerState.Skipped) return 'без ответа';
  const { value } = answer;
  // Хост хранит идентификатор варианта; человеку нужна его подпись.
  const label = (id: string) => {
    const options = question.kind === ChatInputQuestionKind.SingleSelect || question.kind === ChatInputQuestionKind.MultiSelect
      ? question.options
      : [];
    return options.find(option => option.id === id)?.label ?? id;
  };
  switch (value.kind) {
    case ChatInputAnswerValueKind.Text:
      return value.value;
    case ChatInputAnswerValueKind.Number:
      return String(value.value);
    case ChatInputAnswerValueKind.Boolean:
      return value.value ? 'да' : 'нет';
    case ChatInputAnswerValueKind.Selected:
      return label(value.value);
    case ChatInputAnswerValueKind.SelectedMany:
      return value.value.map(label).join(', ');
  }
}

/** Сессия, чат или инструмент без заголовка получают понятную подпись. */
export function shortTitle(title: string | undefined, fallback: string): string {
  const trimmed = title?.trim();
  return trimmed ? trimmed : fallback;
}

/** Короткая подпись для кнопок: длинный заголовок обрезается по словам. */
export function ellipsize(text: string, limit = 60): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1).trimEnd()}…`;
}
