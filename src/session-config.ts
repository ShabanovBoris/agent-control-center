// Разбор конфигурации новой сессии из ответов AHP-хоста. Модуль не знает про React:
// схема хоста — единственный источник допустимых значений (target/isolation и baseBranch/branch),
// панель только показывает их и собирает `config` для createSession.
import type {
  SessionConfigPropertySchema,
  SessionConfigSchema,
  SessionConfigValueItem,
} from '../shared/protocol';
import { METHOD_NOT_FOUND_CODE } from '../shared/protocol';
import { CallRejected, describeError } from './errors';

export interface ConfigField {
  key: string;
  property: SessionConfigPropertySchema;
}

export interface TargetField extends ConfigField {
  workspaceValue: string;
  worktreeValue: string;
}

export interface BranchField extends ConfigField {
  /** Полный список значений хоста не помещается в схему: значения приходят из completions. */
  dynamic: boolean;
}

export interface SessionConfigOption {
  value: string;
  label: string;
  description?: string;
}

// Реальный VS Code-хост публикует isolation=folder|worktree, документация AHP — target=workspace|worktree.
const TARGET_KEYS = [
  { key: 'target', workspace: 'workspace', worktree: 'worktree' },
  { key: 'isolation', workspace: 'folder', worktree: 'worktree' },
] as const;

const BRANCH_KEYS = ['baseBranch', 'branch'] as const;

/** Поле выбора «текущая папка или worktree», если хост предложил оба варианта. */
export function targetFieldOf(schema: SessionConfigSchema | undefined): TargetField | undefined {
  for (const candidate of TARGET_KEYS) {
    const property = schema?.properties[candidate.key];
    if (property?.type !== 'string' || !Array.isArray(property.enum)) continue;
    const values = property.enum.filter(value => typeof value === 'string');
    if (values.includes(candidate.workspace) && values.includes(candidate.worktree)) {
      return { key: candidate.key, property, workspaceValue: candidate.workspace, worktreeValue: candidate.worktree };
    }
  }
  return undefined;
}

/** Поле базовой ветки; у реального хоста это `branch`, у документационного набора — `baseBranch`. */
export function branchFieldOf(schema: SessionConfigSchema | undefined): BranchField | undefined {
  for (const key of BRANCH_KEYS) {
    const property = schema?.properties[key];
    if (property?.type === 'string') return { key, property, dynamic: property.enumDynamic === true };
  }
  return undefined;
}

/** Статические значения свойства с подписями хоста; нестроковые значения отбрасываются. */
export function sessionConfigOptions(property: SessionConfigPropertySchema | undefined): SessionConfigOption[] {
  if (property?.type !== 'string' || !Array.isArray(property.enum)) return [];
  return property.enum.flatMap((value, index) => {
    if (typeof value !== 'string') return [];
    const label = property.enumLabels?.[index] ?? value;
    const description = property.enumDescriptions?.[index];
    return [{ value, label, ...(description ? { description } : {}) }];
  });
}

export function completionOptions(items: SessionConfigValueItem[] | undefined): SessionConfigOption[] {
  return (items ?? []).flatMap(item => typeof item.value === 'string'
    ? [{ value: item.value, label: item.label || item.value, ...(item.description ? { description: item.description } : {}) }]
    : []);
}

/** Текущая ветка из ответа хоста; `HEAD`, пустое значение и отсутствие поля — «неизвестна». */
export function currentBranchOf(
  schema: SessionConfigSchema | undefined,
  values: Record<string, unknown> | undefined,
): string | undefined {
  const field = branchFieldOf(schema);
  const value = field ? values?.[field.key] : undefined;
  if (typeof value !== 'string') return undefined;
  const branch = value.trim();
  return branch && branch !== 'HEAD' ? branch : undefined;
}

/**
 * Конфигурация probe: тот же хост, но принудительно текущая папка. Только так resolveSessionConfig
 * отдаёт текущую ветку (у реального хоста `branch` при `isolation=folder` равен headName).
 */
export function workspaceProbeConfig(schema: SessionConfigSchema | undefined): Record<string, unknown> | undefined {
  const target = targetFieldOf(schema);
  if (!target || !branchFieldOf(schema)) return undefined;
  return { [target.key]: target.workspaceValue };
}

/** Значения хоста плюс выбор пользователя: overrides важнее defaults. */
export function effectiveConfig(
  values: Record<string, unknown> | undefined,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...values, ...overrides };
}

/**
 * Полезная нагрузка для createSession: только свойства текущей схемы и без `undefined`.
 * Пустая строка не подменяется defaults — очищенное поле остаётся заботой хоста.
 */
export function sessionConfigPayload(
  schema: SessionConfigSchema | undefined,
  values: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!schema) return undefined;
  const payload: Record<string, unknown> = {};
  for (const key of Object.keys(schema.properties)) {
    if (values[key] !== undefined) payload[key] = values[key];
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}

/** Деградация: -32601 скрывает блок выбора, остальные ошибки хоста показываются текстом. */
export function sessionConfigFailure(error: unknown): { hidden: boolean; text?: string } {
  if (error instanceof CallRejected && error.detail.code === METHOD_NOT_FOUND_CODE) return { hidden: true };
  return { hidden: false, text: describeError(error) };
}

/** Абсолютный путь на хосте; недописанный путь не повод ходить в хост. */
export function isAbsoluteHostPath(path: string): boolean {
  return path.trim().startsWith('/');
}

export function configString(values: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = values?.[key];
  return typeof value === 'string' ? value : undefined;
}
