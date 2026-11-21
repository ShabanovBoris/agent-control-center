import type { ChatConfigState, SessionConfigState } from '@microsoft/agent-host-protocol';

const FIELDS: readonly { key: string; label: string; options: Readonly<Record<string, string>> }[] = [
  { key: 'mode', label: 'Режим', options: { interactive: 'Совместная работа', plan: 'Планирование', autopilot: 'Автопилот' } },
  { key: 'permissionMode', label: 'Режим', options: {
    default: 'По умолчанию', acceptEdits: 'Принимать правки', plan: 'Планирование', auto: 'Автоматический', bypassPermissions: 'Без подтверждений',
  } },
  { key: 'codex.permissionsPreset', label: 'Разрешения', options: {
    default: 'По умолчанию', 'auto-review': 'Автопроверка', 'full-access': 'Полный доступ',
  } },
];

interface ConfigPanelProps {
  sessionConfig: SessionConfigState | undefined;
  chatConfig: ChatConfigState | undefined;
  isDefaultChat: boolean;
  supportsChatConfig: boolean;
  disabled: boolean;
  pending: boolean;
  onChange(scope: 'chat' | 'session', key: string, value: string): void;
}

export function modeFields({ sessionConfig, chatConfig, isDefaultChat, supportsChatConfig }: Pick<ConfigPanelProps, 'sessionConfig' | 'chatConfig' | 'isDefaultChat' | 'supportsChatConfig'>) {
  const schema = chatConfig?.schema ?? sessionConfig?.schema;
  const fields = FIELDS.flatMap(({ key, label, options: labels }) => {
    const property = schema?.properties[key];
    if (property?.type !== 'string') return [];

    const options = property.enum?.flatMap((value, index) => {
      if (typeof value !== 'string') return [];
      const translated = Object.hasOwn(labels, value) ? labels[value] : undefined;
      return [{ value, label: translated ?? property.enumLabels?.[index] ?? value, description: property.enumDescriptions?.[index] }];
    }) ?? [];
    if (!options.length) return [];

    const chatValue = property.chatMutable ? chatConfig?.values[key] : undefined;
    const usesSession = !chatConfig?.schema && (!property.chatMutable || isDefaultChat);
    const value = chatValue ?? (usesSession ? sessionConfig?.values[key] : undefined) ?? property.default;
    const current = options.find(option => option.value === value);
    const scope: 'chat' | 'session' = property.chatMutable && supportsChatConfig ? 'chat' : 'session';
    const mutable = !property.readOnly && (scope === 'chat' || (usesSession && property.sessionMutable && chatValue === undefined));

    return [{ key, label, options, scope, mutable, current, value, description: property.description }];
  });
  return fields;
}

export function ConfigPanel({ disabled, pending, onChange, fields }: Pick<ConfigPanelProps, 'disabled' | 'pending' | 'onChange'> & { fields: ReturnType<typeof modeFields> }) {
  return fields.map(({ key, label, options, scope, mutable, current, value, description }) => (
      <label className="session-mode" key={key}>
        {label}
        <select
          value={current?.value ?? ''}
          title={current?.description ?? description}
          disabled={disabled || pending || !mutable}
          onChange={event => onChange(scope, key, event.currentTarget.value)}
        >
          {!current && <option value="" disabled>{typeof value === 'string' ? value : 'Не указан'}</option>}
          {options.map(option => <option key={option.value} value={option.value} title={option.description}>{option.label}</option>)}
        </select>
      </label>
  ));
}
