import { normalizeDirectoryPath } from '../shared/directory';
import { pathOf } from './format';

/** Стартовый путь дерева: поле формы может содержать и путь, и file: URI. */
export function initialTreePath(fieldValue: string): string {
  return normalizeDirectoryPath(pathOf(fieldValue)) ?? '/';
}

/** Честная подпись источника: от неё зависит, насколько широко доступно дерево. */
export function directorySourceHint(source: 'host' | 'backend'): string {
  return source === 'host'
    ? 'Список с хоста'
    : 'Хост не поддерживает список — показан локальный листинг панели';
}
