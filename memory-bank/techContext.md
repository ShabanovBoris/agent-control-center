# Технический контекст

React, TypeScript, Vite, Node.js 22+, `ws` и официальный TypeScript SDK `@microsoft/agent-host-protocol`. В [package.json](../package.json) объявлен `^1.1.0`, в [lockfile](../package-lock.json) закреплён `1.1.0`.

| Команда | Назначение |
| --- | --- |
| `npm run host` | `code agent host` на `127.0.0.1:8089` для Claude и Codex |
| `npm run host:gemini` | Отдельный `code agent host` на `127.0.0.1:8091` для Gemini |
| `npm run server` | Backend на `127.0.0.1:8090`, конфигурация из `hosts.json` |
| `npm run web` | Панель на `http://localhost:5173` |
| `npm run mock-host`, `npm run server:dev` | Учебный хост на `8189` и backend с `hosts.dev.json` |
| `npm run typecheck`, `npm test`, `npm run build` | Проверка типов, тесты и production-сборка |

Claude и Gemini читают `API_KEY` и `BASE_URL` из `.local/model-provider.env`. Claude использует Anthropic Messages API и базовый адрес без `/v1`. Gemini использует Responses API и базовый адрес с `/v1`. На момент проверки локального файла адреса были `https://ru.cheapvibecode.ru` и `https://ru.cheapvibecode.ru/v1` соответственно. Актуальный источник этих значений — локальный файл. [Шаблон](../model-provider.env.example) · [Claude](../scripts/start-host.sh) · [Gemini](../scripts/start-gemini-host.ts)

[Обёртка Claude SDK](../scripts/claude-provider.mjs) подставляет настройки API и очищает старый OAuth. Основной Codex сохраняет локальный вход ChatGPT. Gemini использует отдельные данные хоста, токен AHP и `CODEX_HOME` в `.local/gemini-codex`. Хост переиспользует установленный SDK Codex при наличии кэша.

Настройки, skills и MCP зависят от запуска и рабочей папки. Основной Codex читает обычную локальную конфигурацию с переопределениями Agent Host. Claude загружает пользовательские, проектные и локальные настройки Claude Code. Подключения, предоставленные desktop-приложением, отдельно в панель не импортируются.

Для диагностики [probe.ts](../scripts/probe.ts) обращается к хосту, [backend-check.ts](../scripts/backend-check.ts) — к backend. Подробная настройка SDK и агента описана в [README](../README.md).
