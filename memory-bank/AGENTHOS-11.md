# AGENTHOS-11 — CI: typecheck, тесты и сборка

Область: только `.github/workflows/ci.yml` и документация. Код приложения, тесты, npm-скрипты,
`vite.config.ts`, lockfile не менялись. Workflow добавлен коммитом `f939574` (PR #4), merge в `main`
— `fbc4509`, дата проверок 23 ноября 2026.

- [x] `.github/workflows/ci.yml`: workflow `CI`, job `verify` (check-run context — `verify`).
      Триггеры `pull_request` (без фильтров) и `push` в `main`; `permissions: contents: read`;
      `concurrency` по workflow+ref с `cancel-in-progress: true`; `timeout-minutes: 15`;
      `actions/checkout@v7` с `persist-credentials: false`; `actions/setup-node@v7` с Node 22,
      `cache: npm` и `cache-dependency-path` по обоим lockfile. Шаги: `npm ci`,
      `npm ci --prefix debug-ui`, `npm run typecheck`, `npm test`, `npm test --prefix debug-ui`,
      `npm run build`.
- [x] Зелёный PR-прогон: PR #4, run [45264161996](https://github.com/ShabanovBoris/agent-control-center/actions/runs/45264161996),
      event `pull_request`, head `f939574`, все шаги success, 13 секунд. `npm ci` поставил 135 пакетов,
      `npm ci --prefix debug-ui` — 1; Node на runner — 22.23.5.
- [x] Зелёный push-прогон в `main`: run [45264278778](https://github.com/ShabanovBoris/agent-control-center/actions/runs/45264278778),
      head `fbc4509`, event `push`, success.
- [x] Красное доказательство: ветка `AGENTHOS-11-ci-red`, PR #5 (draft, закрыт без merge, ветка и файл
      удалены), run [45264372569](https://github.com/ShabanovBoris/agent-control-center/actions/runs/45264372569),
      head `1f69000`. Упал шаг `Typecheck`:
      `src/ci-type-regression.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.`
      Шаги `Test`, `Test debug UI`, `Build` — skipped. В `main` файла нет.
- [x] Baseline и регрессия локально: до workflow (`3bed0e2`) и повторно после документации (`98da139`)
      — `npm run typecheck` exit 0, `npm test` 132/132, `npm test --prefix debug-ui` 4/4,
      `npm run build` exit 0 и 505.49 kB / gzip 153.52 kB с warning.
- [x] Сборка: `dist/assets/index-DQMZZ0Bv.js` 505.49 kB, gzip 153.52 kB; Vite warning о чанке >500 kB
      виден в логе Actions. `chunkSizeWarningLimit` не задавался, warning намеренно не подавлен
      (в workflow у шага Build есть комментарий).
- [x] README (`### CI` в «Разработке») и `memory-bank/techContext.md` описывают ровно то, что делает
      workflow; e2e/Playwright, deploy, artifacts, lint/format там явно названы отсутствующими.
- [x] Branch protection для `main` включён 23 ноября 2026 по решению владельца (вариант 1):
      `required_status_checks.contexts = ["verify"]` (app `github-actions`, app_id 15368),
      `strict: false`, `enforce_admins: false`, `required_pull_request_reviews: null`,
      `restrictions: null`, force-push и удаление ветки запрещены.
- [x] Проверка, что required check действительно гейтит merge: в PR #6 с документацией при pending
      `verify` GitHub отдавал `mergeStateStatus: BLOCKED`, после успешного check — `CLEAN`. Прогон
      PR #6 — run [45264627333](https://github.com/ShabanovBoris/agent-control-center/actions/runs/45264627333);
      после merge — push-прогон в `main` [45264703265](https://github.com/ShabanovBoris/agent-control-center/actions/runs/45264703265)
      на `2c157c3`, success.
- [x] Concurrency с отменой устаревшего прогона проверена на временной ветке (PR #7, закрыт без merge):
      два push подряд отменили прогон первого коммита — run [45264933773](https://github.com/ShabanovBoris/agent-control-center/actions/runs/45264933773)
      `cancelled`, прогон второго — run [45264962126](https://github.com/ShabanovBoris/agent-control-center/actions/runs/45264962126)
      success.

## Что CI не делает

- Нет e2e/Playwright, деплоя, публикации артефактов, линтера и форматтера — это отдельные задачи.
- Не требует секретов, `.local`, реальных AHP-хостов и VS Code CLI; `scripts/probe.ts` и
  `scripts/backend-check.ts` не запускаются.
- Не подавляет warning о размере чанка и не меняет code splitting; границы гейта — typecheck,
  unit-тесты и production-сборка.

## Ограничения гейта

- Required status check действует на merge pull request. Прямой push в `main` не проверяется:
  при `enforce_admins: false` администратор обходит branch protection, а правила «Require a pull request
  before merging» нет. То есть для PR check обязателен, но нельзя утверждать, что любой
  коммит в `main` проходит через CI.
- `strict: false` — PR не обязан быть up-to-date с `main` перед merge.
- Жёсткий режим (require PR + правила для админов) меняет git-flow и не включён: владелец сохранил
  прямой поток коммитов для инфраструктурных задач.
- `memory-bank/techContext.md` содержит прежние ссылки на отсутствующие `npm run mock-host` и
  `npm run server:dev`; к CI это не относится и не исправлялось.
