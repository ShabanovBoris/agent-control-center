# AGENTHOS-13 — E2E-сценарии панели на Playwright

База — `main` `e74368d` (AGENTHOS-14 влит). Реализация выполнена в рабочем дереве; коммит и PR не
создавались (нужен явный запрос). AGENTHOS-16 в `main` ещё не влит: при ребейзе после неё
`package.json` должен сохранить обе зависимости, а lockfile пересобирается
`npm install --package-lock-only`.

## Что сделано

- **Зависимость и команды.** `@playwright/test@1.65.1` (точная версия) в devDependencies.
  `npm run test:e2e` = `playwright test`; `pretest:e2e` ставит Chromium, поэтому чистый `npm ci`
  достаточен для локального запуска. `npm run typecheck` включает третий контур `tsconfig.e2e.json`.
- **Изоляция состояния.** `server/index.ts` читает `ACC_STATE_DIR` (по умолчанию `.local`) для
  `phone-access.json`, VAPID/подписок и `client-ids.json`. E2E выставляет
  `ACC_STATE_DIR=test-results/state`, поэтому не читает и не пишет production `.local`.
- **Mock-хост.** `scripts/mock-host.ts`: слово `markdown` добавляет заголовок, список, GFM-таблицу
  и длинный code block; строка готовности печатается на событии `listening` (подтверждает bind
  именно нашего процесса), ошибка bind пишется в stderr и завершает процесс.
- **Инфраструктура E2E.** `playwright.config.ts` (Chromium, `workers: 1`, `retries: 0`,
  trace/screenshot при падении, HTML-отчёт) и `webServer`: backend `hosts.e2e.json` на 8096,
  Vite на 5175, `reuseExistingServer: false`. `e2e/support/env.ts` — порты
  `E2E_MOCK_PORT`/`E2E_BACKEND_PORT`/`E2E_WEB_PORT` (8190/8096/5175 по умолчанию);
  `e2e/support/mock-host.ts` — worker-fixture с `start()`/`stop()` и проверкой освобождения порта;
  `e2e/support/app.ts` — ожидание подключения хоста и пользовательские шаги.
- **Сценарии (6).** `session`, `markdown-streaming`, `tool-call`, `copy-response`,
  `host-reconnect`, `mobile` (390×844). Каждый создаёт свою сессию; reconnect-тест останавливает
  и поднимает mock-процесс и продолжает в новой сессии.
- **CI.** Job `e2e` после `verify`: Node 22, `npm ci`, кэш `~/.cache/ms-playwright` по hash
  lockfile, `npx playwright install --with-deps chromium`, `npm run test:e2e`, при падении —
  артефакт `playwright-report/` + `test-results/` без `test-results/state`.
- **Документация.** README: раздел «E2E-тесты», порты, `ACC_STATE_DIR`, запуск одного сценария,
  отчёт и trace, обновлённые разделы CI и ограничений; `techContext.md`, `activeContext.md`.

## Проверки (фактические)

| Команда | Результат |
| --- | --- |
| `npm ci` (чистое дерево, новый lockfile) | 153 пакета, 0 уязвимостей |
| `npm install --save-dev --save-exact @playwright/test@1.65.1` | +3 пакета |
| `npm run typecheck` | exit 0, три конфигурации |
| `npm test` | 230/230 pass |
| `npm run test:e2e` | 6/6 pass, 20.5–21.6 с |
| `npm ci && npm run typecheck && npm test && npm run test:e2e` | всё зелёное с чистого дерева |
| `npx playwright test --shuffle` | 6/6 pass, seed 658829227, 21.7 с |
| `npx playwright test --repeat-each=3` | 18/18 pass, 58.4 с |
| `E2E_MOCK_PORT=8290 E2E_BACKEND_PORT=8097 E2E_WEB_PORT=5176 npm run test:e2e -- e2e/session.spec.ts` | 1/1 pass, 4.2 с |
| `npm run build` | exit 0, warning о чанке >500 kB сохраняется |
| `git diff --check` | exit 0 |
| `lsof -nP -iTCP:8096 -iTCP:8190 -iTCP:5175 -sTCP:LISTEN` | пусто после прогонов |
| YAML workflow | `jobs: verify,e2e`; шаги e2e читаются |

Изоляция и сосуществование:

- Production backend уже слушал 8090 и 8092 (PID 38928, старт 00:10) во время всех прогонов E2E;
  конфликтов не было.
- `.local/client-ids.json` сохранил mtime 01:55; прогоны 02:47–02:52 создали
  `test-results/state/client-ids.json` и `push-vapid.json`. `hosts.e2e.json` не менялся,
  `tokenFile` в нём нет.
- Первые запуски падали на инфраструктуре и оставили `test-failed-*.png` и `trace.zip` в
  `test-results` — режим `only-on-failure`/`retain-on-failure` работает.

## Ограничения

- CI job локально не исполнялся: нужен push/PR. Проверены синтаксис workflow, версии actions и
  локальный эквивалент шагов.
- Проверка занятого порта backend/Vite сводится к ошибке Playwright при старте `webServer`;
  mock-порт занят — fixture падает с подсказкой `E2E_MOCK_PORT`, чужой процесс не убивает.
- Chromium-only; визуального диффа, реальных моделей и нагрузки нет.
