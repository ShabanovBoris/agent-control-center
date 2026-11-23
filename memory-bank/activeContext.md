# Текущий контекст

Снимок от 18 ноября 2026 года. Последнее изменение продукта перед инициализацией Memory Bank — системный выбор рабочей папки на macOS и история последних директорий. Реализация находится в [directory-picker.ts](../server/directory-picker.ts), [recent-directories.ts](../src/recent-directories.ts) и [форме новой сессии](../src/App.tsx).

23 ноября 2026 добавлен рендер markdown-частей ответа агента: [markdown-stream.ts](../src/markdown-stream.ts) нормализует поток частей и конкатенирует соседние markdown-части как display text SDK, [MarkdownMessage.tsx](../src/ui/MarkdownMessage.tsx) рендерит GFM без raw HTML и внешних картинок. Копирование и форк по-прежнему берут исходный markdown финального блока. Подробности и результаты проверок — [AGENTHOS-10.md](AGENTHOS-10.md).

24 ноября 2026 добавлены Web Push-уведомления для PWA: [server/push.ts](../server/push.ts) (VAPID и подписки в `.local`, доставка через `web-push`), [server/push-transitions.ts](../server/push-transitions.ts) (переходы `InputNeeded`, `InProgress → Idle`, ошибка), [server/presence.ts](../server/presence.ts) (подавление на устройстве, где сессия видима), [public/sw.js](../public/sw.js), manifest и иконки, диалог «Уведомления» в [NotificationsButton.tsx](../src/ui/NotificationsButton.tsx). Общие hash- и phase-функции вынесены в [shared/routing.ts](../shared/routing.ts) и [shared/status.ts](../shared/status.ts). Проверено в Chromium; iOS/APNs не проверялись. Подробности — [AGENTHOS-14.md](AGENTHOS-14.md).

- Основной хост `8089` обслуживает Claude через cheapvibecode и Codex через ChatGPT. Gemini изолирован на `8091` и работает в среде Codex. Адреса провайдера читаются из локальной конфигурации при запуске.
- 17 ноября сверили опубликованные версии AHP. На дату проверки `1.1.0` была актуальной стабильной версией SDK и спецификации, а `1.2.0` оставалась в разработке. Для текущей версии проекта смотри lockfile, для новых релизов — [changelog AHP](https://github.com/microsoft/agent-host-protocol/blob/main/CHANGELOG.md).
- Версия AHP, согласованная работающими хостами, и фактический список активных skills и MCP по сессиям отдельно не проверялись.
