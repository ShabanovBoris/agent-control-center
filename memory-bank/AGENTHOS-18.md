# AGENTHOS-18 — единая команда запуска `npm run up`

## Итог

`npm run up` из корня проекта поднимает dev-стенд целиком: локальные хосты `local` (8089) и
`gemini` (8091), backend (8090, phone listener 8092 при настроенном `.local/phone-access.json`) и
Vite (5173). Готовность проверяется по состоянию, а не по `spawn`; `Ctrl+C`/`SIGTERM`/`SIGHUP`
гасят все процессы, включая `code-tunnel`/`code-server`, и освобождают порты. Повторный запуск
при живом стенде ничего не делает (код 0), частичный стенд или чужой порт — отказ без `spawn`
(код 1).

## Решения

- **Ядро и CLI разделены.** [server/up.ts](../server/up.ts) — тестируемый супервизор с `UpDeps`
  (preflight, порядок запуска, готовность, сигналы, проверка портов); [scripts/up.ts](../scripts/up.ts) —
  тонкий CLI: конфигурация, provider env, телефон, реальные процессы, обработчики сигналов.
- **Переиспользование вместо копирования.** `localHosts`/`localInstance`/`nativeVSCodeCli`
  ([local-hosts.ts](../server/local-hosts.ts)), `readLogTail` ([logs.ts](../server/logs.ts)),
  `probeBackendOverview` ([backend-probe.ts](../scripts/backend-probe.ts), общий с
  `restart:services`), сами `scripts/start-host.sh`, `scripts/start-gemini-host.ts`, `server/index.ts`.
- **Порядок и владение.** Хосты стартуют последовательно `local → gemini`, затем backend и web.
  Каждый child — в своей группе (`detached: true`), сигнал идёт `kill(-pid)`. Мягкий сигнал:
  `SIGINT` хостам, `SIGTERM` backend/web; через 15 с — `SIGKILL`; затем проверка портов bind'ом,
  для хоста fallback `localInstance` + `signalPid`. `dispose()` закрывает pipe-хвосты, чтобы
  `up` не висел после остановки; таймер grace-ожидания отменяется, иначе он держал event loop.
- **Готовность.** Хост — `localInstance` (запись реестра VS Code + `ps` + token-file +
  `--server-data-dir`), backend — `overview` с `connected` у `local` и `gemini`, web — HTTP 200 +
  `text/html`. Таймауты: хосты 600 с с прогрессом, backend/web 60 с; при ошибке печатается хвост
  `.local/*.log`.
- **Журналы.** Хосты пишутся существующим `--log` в `.local/host.log`/`.local/gemini-host.log`;
  backend/web идут в терминал с префиксами `[backend]`/`[web]`.
- **Preflight.** Нет `.local/model-provider.env` или `API_KEY`/`BASE_URL`; нет VS Code Stable;
  `VSCODE_CLI` не стандартный; занятые порты; `ACC_PORT` ≠ `listen.port`; `ACC_MOCK_HOST_URL`;
  занятый 8092 при включённом телефоне. Ошибки — до первого `spawn`, многострочные, с `lsof`.
- **`--prod` не реализован.** Локального static на 8090 нет, phone listener уже отдаёт `dist`;
  `npm run up -- --prod` печатает объяснение и выходит 1.
- **Backend `listen`.** [server/index.ts](../server/index.ts) получил `once('error')` перед
  `listen` и `shutdown(exitCode)`: при `EADDRINUSE` одна строка и код 1 без stack trace.
- **Внешние перезапуски.** `restart:services`/`update:agents`/кнопки панели под работающим `up`
  заменяют процессы; `up` увидит выход child, погасит остальных и вернёт 1. Это документированное
  ограничение, не супервизор.

## Файлы

- [server/up.ts](../server/up.ts) — супервизор, `runUp`, `parseUpArgs`, `resolveVSCodeCli`,
  `formatHostPort`, `UpStop`.
- [scripts/up.ts](../scripts/up.ts) — CLI и реальные `UpDeps`.
- [scripts/backend-probe.ts](../scripts/backend-probe.ts) — WS-проба `overview`; используется
  `up` и `restart:services`.
- [server/local-hosts.ts](../server/local-hosts.ts) — экспортированы `nativeVSCodeCli` и
  `stableVSCodeCli`; поведение `localInstance` не менялось.
- [server/index.ts](../server/index.ts) — обработчик ошибки `listen`, `shutdown(exitCode)`.
- [package.json](../package.json) — скрипт `up`.
- Тесты: [server/up.test.ts](../server/up.test.ts) (14 сценариев), [server/backend-probe.test.ts](../server/backend-probe.test.ts) (3).
- Документация: [README.md](../README.md) (раздел «Запуск», CheapVibeCode), [techContext.md](techContext.md).

## Проверки

- `npm install` — синхронизировал `node_modules` с lockfile (`lowlight`/`highlight.js`), diff
  `package-lock.json`/`package.json` после установки отсутствовал (кроме добавленного скрипта `up`).
- `npm run typecheck` — успешно (все три конфигурации).
- `npm test` — 314/314 (база 297 + 17 новых), 0 падений.
- `npm test --prefix debug-ui` — успешно.
- `npm run build` — успешно; предупреждение о чанке >500 kB не подавлялось.
- `git diff --check` — чисто.
- Ручной smoke (macOS, реальные хосты, 44 сессии в Idle):
  1. No-op на живом стенде — код 0, «Стенд уже запущен», набор процессов/портов не изменился.
  2. Остановка прежнего стенда, чистый `npm run up` — оба хоста, backend (+8092) и web поднялись;
     `curl` 200, `backend-check` показал `local: connected` и `gemini: connected`.
  3. Повторный `npm run up` во втором терминале — код 0, новых процессов нет.
  4. `SIGINT` супервизору (эквивалент Ctrl+C) — код 0, порты 8089/8091/8090/8092/5173 свободны,
     `pgrep` не находит `code-tunnel`/`start-gemini-host.ts`/`server/index.ts`/`vite`.
  5. Внешний `SIGTERM` backend в готовом стенде — `up` сообщил о завершении сервиса, погасил
     хосты и web, код 1, порты свободны.
  6. `SIGTERM` самому `up` — штатная остановка, код 0, сирот нет.
  7. Занятый 8090 + `npm run server` — строка `Backend не запустился ... EADDRINUSE`, код 1.
  8. `--help` — код 0; `--prod` — объяснение и код 1; `AHP_PROVIDER_ENV_FILE=/tmp/...` и
     `VSCODE_CLI=/tmp/nope` — понятные ошибки и код 1 до `spawn`.
- Во время smoke найден и исправлен реальный дефект: `Promise.race` с `delay(15 с)` оставлял
  таймер, и `up` висел до 15 с после остановки. Теперь таймер отменяется, выход мгновенный
  (проверено: `EXITED_IN:0s`).
- Стенд после проверок восстановлен: `npm run up` запущен detached, порты заняты, no-op даёт 0.

## Ограничения

- Только macOS и VS Code Stable по стандартному пути: `localInstance` не найдёт другой CLI,
  поэтому кастомный `VSCODE_CLI` отклоняется с советом запустить `npm run host` вручную.
- `--prod`, launchd/автозапуск, Docker, автоперезапуск и менюбар не входят в задачу (AGENTHOS-19).
- Активные сессии при остановке прерываются: `up` не спрашивает backend о `activeSessions`.
- Одновременный двойной `up` не защищён lock-файлом: последовательный повтор покрыт, конкурентный
  старт может проиграть гонку портов.
- `SIGKILL` самому `up` не обрабатывается; дети в отдельных группах при этом выживут.
