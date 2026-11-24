# AGENTHOS-24 — ветка git при создании сессии

## Итог

Форма новой сессии показывает текущую ветку рабочей папки и, если хост предлагает выбор,
даёт создать сессию в worktree от выбранной базовой ветки. Источник истины — только AHP:
`resolveSessionConfig` (схема и defaults) и `sessionConfigCompletions` (динамические ветки).
Собранный `config` уходит в `createSession` вместе с `workingDirectories`. Панель не вызывает
`git`, не делает checkout и не создаёт ветки/worktree.

## Решения владельца

- Панель только показывает и выбирает то, что предлагает хост.
- Текущая ветка — probe `resolveSessionConfig` с принудительной текущей папкой
  (`target: workspace` / `isolation: folder`): реальный VS Code-хост в этом режиме отдаёт headName.
- Не-git папка, detached HEAD и отсутствие поля ветки дают явное «ветка неизвестна»; default
  branch как текущую не показываем.
- `-32601` — штатная деградация: блок выбора скрыт, сессия создаётся как раньше. Прочие ошибки
  хоста видны текстом и не блокируют создание.

## Реализация

- **[shared/protocol.ts](../shared/protocol.ts)**: `HostCall.createSession.config`,
  новые `resolveSessionConfig`/`sessionConfigCompletions`, `METHOD_NOT_FOUND_CODE = -32601`,
  реэкспорт типов схемы/значений из SDK.
- **[server/hub.ts](../server/hub.ts)**: проброс методов в root-канал с `toFileUri` и `config`;
  `sessionConfigRequest` превращает `RpcError` в `CallFailure` с исходным кодом.
  **[server/errors.ts](../server/errors.ts)**: `rpcCallFailure` снимает префикс `RPC error <code>: `.
- **[src/session-config.ts](../src/session-config.ts)**: schema-driven разбор
  (`target`/`isolation`, `baseBranch`/`branch`), `currentBranchOf`, `workspaceProbeConfig`,
  `effectiveConfig`, `sessionConfigPayload`, `sessionConfigFailure`. React не знает особенностей
  ключей хоста.
- **[src/App.tsx](../src/App.tsx)**: `NewSessionForm` — resolve с debounce 300 мс и stale-guard,
  probe текущей ветки, строка «Ветка: …», выбор target и базовой ветки (static `enum` или
  `enumDynamic` + completions с debounce 250 мс). Смена папки/хоста/агента сбрасывает target
  и ветку, смена target — ветку. Ошибки probe/completions показываются отдельной строкой.
  Схема (`schema`) и defaults (`values`) хранятся раздельно: схема переживает смену target,
  чтобы контролы не исчезали, а `values` действуют только для своего target.
- **[scripts/mock-host.ts](../scripts/mock-host.ts)**: `resolveSessionConfig` и
  `sessionConfigCompletions` с детерминированными ветками (`feature/mock-current` — текущая,
  `main` — default); `createSession` добавляет `config` в заголовок, чтобы e2e доказал проброс.
  Запрос в worktree-режиме отвечает с задержкой 600 мс — окно e2e-регрессии на немедленный submit.
- **[e2e/session-branch.spec.ts](../e2e/session-branch.spec.ts)**: текущая ветка, worktree,
  список из completions, сброс выбора при смене папки, маркер config в заголовке, немедленный
  submit после смены target (с веткой и без).

## Gate 1: BLOCK-1 (race submit, closed)

- **BLOCK-1** (`correctness:C-1` = `compatibility:IC-2-SUBMIT-PENDING` = `quality:QUALITY-24-01`),
  статус resolved. Было: смена target синхронно обнуляла `configResult`, поэтому submit до ответа
  хоста собирал пустой `config` и сессия молча создавалась в текущей папке.
- Фикс: `schema` и `values` разделены. `changeTarget` очищает только `values` и ветку, схема
  остаётся на экране; `submit` берёт target из явного `targetChoice`, ветку — из выбора или
  `values` текущего target. `values` после смены target не подставляются как defaults.
- Доказательство: `e2e/session-branch.spec.ts:37` («немедленный submit … не теряет target»)
  зелёный; с временно возвращённым сбросом схемы (TEMP-GATE-PROBE) падает ровно как в Gate:
  заголовок «Учебная сессия 1» без маркера. Проба удалена, дерево содержит только файлы задачи.
- `e2e/session-branch.spec.ts:53` дополнительно фиксирует target и выбранную ветку при
  немедленном submit.
- Non-blocking `C-2` (completions `-32601`): поведение сохранено (ошибка видна, создание не
  блокируется), строка добавлена в README.

## Проверки

- `npm run typecheck`, `npm test` (412), `npm run build`, `npm run test:e2e` (12) — зелёные.
- Unit: `src/session-config.test.ts`, обновлённые `server/hub.test.ts`/`server/protocol.test.ts`.
- E2E: `e2e/session-branch.spec.ts` — 3 сценария, включая оба немедленных submit.
- Один полный прогон e2e упал на старте (`copy-response` ждал «Подключено: 1/1» дольше 20 с, пока
  backend повторял подключение к поздно поднятому mock-хосту); изолированный повтор и два
  последующих полных прогона — 12/12. Похоже на известную нестабильность старта, отдельного дефекта не видно.

## Ограничения

- Текущая ветка зависит от probe-возможностей хоста; если хост не отдаёт ветку в режиме текущей
  папки, форма честно пишет «неизвестна».
- e2e деградации `-32601` нет: она покрыта unit-тестом `sessionConfigFailure` и Hub-тестом кода
  ошибки, без отдельного mock-режима.
- Ошибка хоста на повторном resolve после смены target кодом покрыта (схема не сбрасывается,
  явный выбор уходит в `config`), но e2e-сценария с падающим хостом нет: mock всегда отвечает.
- Поведение на реальном VS Code-хосте не запускалось: ключи `isolation`/`branch` и текущая ветка
  подтверждены инспекцией SDK/bundle, не runtime.
- Панель рендерит только target/branch; остальные свойства схемы попадают в `config` из `values`
  хоста, но не редактируются.
