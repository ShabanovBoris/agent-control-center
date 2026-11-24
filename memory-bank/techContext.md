# Технический контекст

React, TypeScript, Vite, Node.js 22+, `ws` и официальный TypeScript SDK `@microsoft/agent-host-protocol`. В [package.json](../package.json) объявлен `^1.1.0`, в [lockfile](../package-lock.json) закреплён `1.1.0`.

Web Push отправляет backend через `web-push@4.0.0` (ESM, типы `@types/web-push`). Слои:
[server/push.ts](../server/push.ts) — VAPID, подписки, доставка и prune;
[server/push-transitions.ts](../server/push-transitions.ts) — переходы по `Overview` без подписки на чаты;
[server/presence.ts](../server/presence.ts) — подавление push на origin, где сессия видима;
[server/index.ts](../server/index.ts) перехватывает `HubSink.broadcast` и передаёт сводку наблюдателю.
Общие чистые функции вынесены в [shared/routing.ts](../shared/routing.ts) и
[shared/status.ts](../shared/status.ts), их же использует [public/sw.js](../public/sw.js) через готовый
`url` в payload. Service worker статический, без Vite-входа и без кешей; PWA-ассеты отдаёт
[server/phone-access.ts](../server/phone-access.ts) по allowlist. VAPID-ключи и подписки лежат в
`.local/push-vapid.json` и `.local/push-subscriptions.json` с правами 0600 (temp + rename), в Git и
браузер не попадают. Проверка: `npm test` (174), `npm run typecheck`, `npm run build`,
`node --check public/sw.js`. Ограничения: iOS только PWA с домашнего экрана (16.4+), Mac должен
бодрствовать, offline-режима нет.

| Команда | Назначение |
| --- | --- |
| `npm run host` | `code agent host` на `127.0.0.1:8089` для Claude и Codex |
| `npm run host:gemini` | Отдельный `code agent host` на `127.0.0.1:8091` для Gemini |
| `npm run server` | Backend на `127.0.0.1:8090`, конфигурация из `hosts.json` |
| `npm run web` | Панель на `http://localhost:5173` |
| `npm run mock-host` | Учебный AHP-хост на `ws://127.0.0.1:8189` без реальных агентов |
| `npm run server:dev` | Backend на `127.0.0.1:8095` с mock-only `hosts.dev.json` |
| `npm run server:e2e` | Backend на `127.0.0.1:8095` с `hosts.e2e.json` |
| `npm run web:dev` | Панель на `http://127.0.0.1:5173` с прокси `/ws` на 8095 |
| `npm run typecheck`, `npm test`, `npm run build` | Проверка типов, тесты и production-сборка |

Mock-контур не требует VS Code CLI, AHP-токенов и `.local`: `hosts.dev.json` и `hosts.e2e.json`
содержат только хост `mock` (`ws://127.0.0.1:8189`), без `tokenFile`, `localFilesystem`, `local`
и `gemini`; production `hosts.json` они не меняют. `server:dev`/`server:e2e` выставляют
`ACC_PHONE_ACCESS=0`, поэтому не занимают production-порт 8092 и не читают
`.local/phone-access.json`. Порты переопределяются: `MOCK_HOST_PORT=8190 npm run mock-host` или
`npm run mock-host -- 8190` (позиционный аргумент важнее env), `ACC_PORT=8096` и
`ACC_MOCK_HOST_URL=ws://127.0.0.1:8190` для backend, `ACC_BACKEND=127.0.0.1:8096 npm run web:dev`
для прокси. При смене порта mock задавайте пару `MOCK_HOST_PORT` + `ACC_MOCK_HOST_URL`.

Учебный хост отвечает эхом с markdown-стримингом, на слово `tool` просит подтвердить `mock_shell`,
на слово `input` показывает карточку `InputRequest`, создаёт боковой чат через `createChat` и
держит историю в памяти: снимок чата отдаёт последние 6 ходов, остальное грузится через
`fetchTurns` (курсор `older:<index>`). После перезапуска mock-host история и чаты теряются.

GitHub Actions [workflow](../.github/workflows/ci.yml) на pull request и push в `main` (Node.js 22)
выполняет `npm ci`, `npm ci --prefix debug-ui`, `npm run typecheck`, `npm test`,
`npm test --prefix debug-ui`, `npm run build`; npm-кэш учитывает оба lockfile. Секреты, `.local`,
AHP-хосты и VS Code CLI не требуются. Check `verify` требуется для merge PR в `main`; прямые push
администратора branch protection не блокирует (`enforce_admins: false`).

Claude и Gemini читают `API_KEY` и `BASE_URL` из `.local/model-provider.env`. Claude использует Anthropic Messages API и базовый адрес без `/v1`. Gemini использует Responses API и базовый адрес с `/v1`. На момент проверки локального файла адреса были `https://ru.cheapvibecode.ru` и `https://ru.cheapvibecode.ru/v1` соответственно. Актуальный источник этих значений — локальный файл. [Шаблон](../model-provider.env.example) · [Claude](../scripts/start-host.sh) · [Gemini](../scripts/start-gemini-host.ts)

[Обёртка Claude SDK](../scripts/claude-provider.mjs) подставляет настройки API и очищает старый OAuth. Основной Codex сохраняет локальный вход ChatGPT. Gemini использует отдельные данные хоста, токен AHP и `CODEX_HOME` в `.local/gemini-codex`. Хост переиспользует установленный SDK Codex при наличии кэша.

Настройки, skills и MCP зависят от запуска и рабочей папки. Основной Codex читает обычную локальную конфигурацию с переопределениями Agent Host. Claude загружает пользовательские, проектные и локальные настройки Claude Code. Подключения, предоставленные desktop-приложением, отдельно в панель не импортируются.

Для диагностики [probe.ts](../scripts/probe.ts) обращается к хосту, [backend-check.ts](../scripts/backend-check.ts) — к backend. Подробная настройка SDK и агента описана в [README](../README.md).

## Расход токенов

`shared/usage.ts` — единственный расчёт: строки usage по моделям и датам, суммы, `partial`/`hasMoreTurns`
и поправка Claude (`input += cached`). Панель и backend-отчёт используют один и тот же модуль, поэтому
цифры совпадают с `sessionTokenUsage`. День считается `Intl.DateTimeFormat` в часовом поясе браузера;
ходы без даты не делают сумму токенов неполной, но разбивка по дням помечается.

Межсессионный отчёт — `HistorySearch.usageReport` в [server/search.ts](../server/search.ts): тот же
`openChat`/`fetchOlderTurns`/`releaseChat`, семафоры, page budget, deadline и `SearchCache`, что у поиска.
Скрытые чаты включаются в отчёт для parity, но поиск их не индексирует. Отчёт по определению частичный
и показывает `reasons`/`issues`. Денег и прайса нет: AHP публикует только токены.

Порог — одно число в `localStorage` (`acc.tokenBudget.v1`) в [src/usage-budget.ts](../src/usage-budget.ts).
`BudgetLatch` живёт вне React и уведомляет один раз на переход ниже→выше; push/Notification в проекте нет,
поэтому только `store.notify`. Проверки: `npm run typecheck`, `npm test` (включая parity и отчёт),
`npm run build`, `npm test --prefix debug-ui`.
