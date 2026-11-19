import {
  ChatInputAnswerState,
  ChatInputAnswerValueKind,
  ChatInputQuestionKind,
  ChatInputResponseKind,
  SessionStatus,
  type ChatInputAnswer,
  type ChatInputQuestion,
  type ChatInputRequest,
  type StringOrMarkdown,
} from '@microsoft/agent-host-protocol';

export type Phase = 'input' | 'running' | 'error' | 'idle';

export interface Selection {
  hostId: string;
  sessionUri: string;
  chatUri?: string;
}

export function selectionFromHash(hash: string): Selection | null {
  let fragment = hash.slice(1);
  if (!fragment.includes('|')) {
    // Схемы URI отличают закодированные разделители от черты внутри значения.
    fragment = fragment.replace(/%7c(?=ahp-(?:session|chat)(?::|%3a))/gi, '|');
  }
  try {
    const [hostId, sessionUri, chatUri] = fragment.split('|').map(decodeURIComponent);
    return hostId && sessionUri ? { hostId, sessionUri, ...(chatUri ? { chatUri } : {}) } : null;
  } catch {
    return null;
  }
}

/** SessionStatus — битовая маска: InputNeeded включает в себя бит InProgress. */
export function phaseOf(status: number): Phase {
  if ((status & SessionStatus.InputNeeded) === SessionStatus.InputNeeded) return 'input';
  if (status & SessionStatus.InProgress) return 'running';
  if (status & SessionStatus.Error) return 'error';
  return 'idle';
}

export function isArchived(status: number): boolean {
  return (status & SessionStatus.IsArchived) !== 0;
}

export const PHASE_LABEL: Record<Phase, string> = {
  input: 'Ждёт ответа',
  running: 'В работе',
  error: 'Ошибка',
  idle: 'Свободна',
};

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
