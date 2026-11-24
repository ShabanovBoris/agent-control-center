# Текущий контекст

Снимок от 18 ноября 2026 года. Последнее изменение продукта перед инициализацией Memory Bank — системный выбор рабочей папки на macOS и история последних директорий. Реализация находится в [directory-picker.ts](../server/directory-picker.ts), [recent-directories.ts](../src/recent-directories.ts) и [форме новой сессии](../src/App.tsx).

23 ноября 2026 добавлен рендер markdown-частей ответа агента: [markdown-stream.ts](../src/markdown-stream.ts) нормализует поток частей и конкатенирует соседние markdown-части как display text SDK, [MarkdownMessage.tsx](../src/ui/MarkdownMessage.tsx) рендерит GFM без raw HTML и внешних картинок. Копирование и форк по-прежнему берут исходный markdown финального блока. Подробности и результаты проверок — [AGENTHOS-10.md](AGENTHOS-10.md).

24 ноября 2026 добавлен E2E-контур на Playwright: `npm run test:e2e` поднимает mock-хост, backend
`hosts.e2e.json` на 8096 и Vite на 5175, прогоняет шесть сценариев в Chromium и изолирует состояние
backend через `ACC_STATE_DIR=test-results/state`. Job `e2e` добавлен в CI после `verify`.
Подробности — [AGENTHOS-13.md](AGENTHOS-13.md).

24 ноября 2026 добавлены Web Push-уведомления для PWA: [server/push.ts](../server/push.ts) (VAPID и подписки в `.local`, доставка через `web-push`), [server/push-transitions.ts](../server/push-transitions.ts) (переходы `InputNeeded`, `InProgress → Idle`, ошибка), [server/presence.ts](../server/presence.ts) (подавление на устройстве, где сессия видима), [public/sw.js](../public/sw.js), manifest и иконки, диалог «Уведомления» в [NotificationsButton.tsx](../src/ui/NotificationsButton.tsx). Общие hash- и phase-функции вынесены в [shared/routing.ts](../shared/routing.ts) и [shared/status.ts](../shared/status.ts). Проверено в Chromium; iOS/APNs не проверялись. Подробности — [AGENTHOS-14.md](AGENTHOS-14.md).

24 ноября 2026 в markdown-блоках кода появились копирование и ленивая подсветка: [CodeBlock.tsx](../src/ui/CodeBlock.tsx) добавляет доступную кнопку и грузит [highlight.ts](../src/highlight.ts) отдельным чанком (`lowlight` + `highlight.js`), [clipboard.ts](../src/clipboard.ts) и [errors.ts](../src/errors.ts) вынесены из [store.ts](../src/store.ts), чтобы SSR-тесты оставались без DOM и module-level `Store`. Неизвестный язык и код без метки остаются plain; `file:line`/`vscode://` не открываются. Подробности и замеры — [AGENTHOS-16.md](AGENTHOS-16.md).

24 ноября 2026 добавлена единая команда запуска `npm run up`: [server/up.ts](../server/up.ts) — супервизор с preflight, последовательным запуском хостов и backend/web, проверкой готовности и остановкой по сигналам, [scripts/up.ts](../scripts/up.ts) — CLI. Повторный запуск на живом стенде — no-op с кодом 0, частичный стенд или чужой порт — отказ с кодом 1 без `spawn`; `--prod` не поддерживается. Общая WS-проба backend вынесена в [backend-probe.ts](../scripts/backend-probe.ts), [server/index.ts](../server/index.ts) получил понятную ошибку `listen`. Подробности и результаты smoke — [AGENTHOS-18.md](AGENTHOS-18.md).

- Основной хост `8089` обслуживает Claude через cheapvibecode и Codex через ChatGPT. Gemini изолирован на `8091` и работает в среде Codex. Адреса провайдера читаются из локальной конфигурации при запуске.
- 17 ноября сверили опубликованные версии AHP. На дату проверки `1.1.0` была актуальной стабильной версией SDK и спецификации, а `1.2.0` оставалась в разработке. Для текущей версии проекта смотри lockfile, для новых релизов — [changelog AHP](https://github.com/microsoft/agent-host-protocol/blob/main/CHANGELOG.md).
- Версия AHP, согласованная работающими хостами, и фактический список активных skills и MCP по сессиям отдельно не проверялись.
