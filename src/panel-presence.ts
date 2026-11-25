// Одна точка правды о том, что сессия реально видима: presence и badge непрочитанных
// не должны расходиться. `selected` остаётся только подсветкой строки.
import type { Selection } from '../shared/routing';

export interface PanelView {
  creating: boolean;
  showHealth: boolean;
  /** Открыта страница `#terminal`: сессия на экране не видна, presence снимается. */
  showTerminal: boolean;
  /** На телефоне открыт список сессий, detail скрыт. */
  sessionList: boolean;
  mobile: boolean;
}

export interface PanelVisibility {
  detailVisible: boolean;
  presence: Selection | null;
}

export function panelVisibility(selection: Selection | null, view: PanelView): PanelVisibility {
  const detailVisible = selection !== null && !view.creating && !view.showHealth && !view.showTerminal
    && (!view.mobile || !view.sessionList);
  return { detailVisible, presence: detailVisible ? selection : null };
}
