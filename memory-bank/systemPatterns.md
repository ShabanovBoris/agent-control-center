# Архитектура и контракты

Браузер (React) → WebSocket `/ws` → Node.js backend → AHP по WebSocket → VS Code Agent Host → движок агента и API модели. Vite проксирует браузерный `/ws` к backend при разработке.

| Участок | Ответственность |
| --- | --- |
| [server/index.ts](../server/index.ts), [server/config.ts](../server/config.ts) | WebSocket панели, жизненный цикл браузерных подписок, загрузка конфигурации и токенов хостов |
| [server/hub.ts](../server/hub.ts) | `MultiHostClient` из AHP SDK, вызовы протокола, подписки и сводка хостов и сессий |
| [server/mirror.ts](../server/mirror.ts) | Зеркало каналов, согласование снимков и действий по `serverSeq`, проверка актуальности результата загрузки |
| [shared/](../shared/) | Типы сообщений панели и применение редьюсеров AHP SDK |
| [src/store.ts](../src/store.ts), [src/App.tsx](../src/App.tsx), [src/SessionView.tsx](../src/SessionView.tsx) | Зеркало в браузере, навигация, создание сессии и интерфейс чата |

- Авторитетное состояние принадлежит хосту. Backend и браузер применяют снимки и действия. Идентичность канала включает `hostId` и URI, поэтому одинаковые URI разных хостов не смешиваются.
- Токены AHP читает backend. Браузер получает сводку, состояние каналов и результаты разрешённых команд панели.
- При переподключении снимки и replay сходятся по `serverSeq`. При удалении сессии хаб освобождает её подписки, а ошибки `SessionNotFound` и `NotFound` переводят браузер в состояние недоступной сессии.
- [Выбор папки](../server/directory-picker.ts) выполняется на Mac с backend. [История папок](../src/recent-directories.ts) — настройка браузера, которую [форма](../src/App.tsx) обновляет после успешного ответа `createSession`. Ошибка `localStorage` оставляет созданную сессию доступной.
- Расход вычисляется из сохранённых данных ходов. Повторное получение состояния не прибавляет usage второй раз. [Агрегация токенов](../shared/usage.ts)

- Расход и отчёт используют один модуль [shared/usage.ts](../shared/usage.ts) и один слой загрузки истории [server/search.ts](../server/search.ts) (`usageReport`). Это сохраняет parity с `sessionTokenUsage`, но отчёт остаётся частичным: `reasons`, `issues`, `partial` и `hasMoreTurns` обязательны.
- Порог расхода — локальная настройка браузера ([src/usage-budget.ts](../src/usage-budget.ts)); `BudgetLatch` вне React даёт одно уведомление на переход ниже→выше. Отмена отчёта идёт отдельным `cancelUsage` и не рвёт поиск.
