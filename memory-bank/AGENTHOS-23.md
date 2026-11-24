# AGENTHOS-23 — закрепление сессий и непрочитанные

## Итог

В строке сессии появились кнопка закрепления (★) и badge непрочитанных ходов. Закрепление
глобальное: backend хранит его рядом с push-состоянием, оно переживает перезапуск backend и
поднимает сессию над незакреплёнными в любом фильтре и в архиве. Непрочитанные считаются на
устройство (origin): `InProgress → Idle`, `InputNeeded → Idle` и новая ошибка дают +1, если
сессия не видима; открытие сессии/чата, deep link и возврат в видимую вкладку сбрасывают счётчик.
Хост остаётся источником истины о сессиях и ходах, AHP-контракт не менялся.

## Решения владельца (24.11.2026)

- «Непрочитано» — новый ход после последнего открытия сессии; сброс по presence/selection
  (модель AGENTHOS-14), счётчик на устройстве.
- Pin глобальный, unread — per-origin, не глобальный.
- `InputNeeded` сам по себе unread не даёт; `InProgress → Idle`, `InputNeeded → Idle` и новая
  ошибка дают +1.
- Архивные сессии накапливают unread и показывают badge в «Архиве».
- Хранение — backend, `ACC_STATE_DIR`, файл 0600, очистка при удалении сессии; AHP не расширяем.

## Допущения

- «Видима» = сессия выбрана, detail реально показан (не форма, не диагностика, не мобильный
  список) и `document.visibilityState === 'visible'`. Скролл, фокус окна ОС, появление хода в
  ленте и ответ пользователя отдельными триггерами не являются.
- Счётчик приблизительный: 30-мс объединение сводок, рестарт backend и временное исчезновение
  сессии из сводки могут дать +1 вместо N или ничего. Новый origin считает с первого подключения.
- Origin — не физическое устройство: вкладки одного origin делят счётчик, `localhost` и
  `127.0.0.1` — разные origin.

## Реализация

- **Контракт панели.** [shared/protocol.ts](../shared/protocol.ts): `SessionRef`, `UnreadSession`,
  `SessionUserState`, `Call.pinSession`, `ServerMessage.sessionUserState`, `isSessionRef` и строгий
  разбор в `parseServerMessage` (`count` — целое > 0). Команда `pinSession` — backend-only, не
  `HostCall`: `Hub` её не исполняет.
- **Хранилище.** [server/session-user-state.ts](../server/session-user-state.ts):
  `SessionUserStateStore`/`createSessionUserState`, очередь read-modify-write, транзакционный
  `setPinned`, best-effort `observe`/`markVisible`/`rememberOrigin`/`forgetSession`, инвариант
  «нет записи без положительного счётчика», нормализация при загрузке, fail closed на битом файле.
  Файл `session-user-state.json`: `version`, `origins`, `pinned`, `unread[{counts}]`, стабильная
  сортировка.
- **Детектор.** Отдельный от push: архив не фильтруется, `InputNeeded → Idle` считается
  завершением, `Error → Idle` не дублирует ошибку, `lastCounted` (kind + `modifiedAt`) защищает
  от replay, baseline после старта backend и для новых сессий, runtime-снимки коммитятся всегда,
  запись файла — только при изменении persisted-состояния.
- **Проводка.** [server/index.ts](../server/index.ts): сервис создаётся рядом с push; `broadcast`
  вызывает `observe` на `overview` с `visibleSessions`, `forgetSession` на `sessionRemoved`,
  `markVisible` на видимый `presence`; `broadcastSessionUserState` отправляет `viewFor(origin)`;
  `handlePinCall` обрабатывается до `hub.call` и перезапуска хоста.
- **Общие утилиты.** `writePrivate` вынесен в [server/state-file.ts](../server/state-file.ts),
  `deviceOrigin` — в [server/origin.ts](../server/origin.ts) (возвращает `undefined`),
  `snapshotOf` — в [server/session-snapshot.ts](../server/session-snapshot.ts). Поведение push не
  менялось, `visibleOrigins` использует общий предикат с новым
  [visibleSessions](../server/presence.ts).
- **Клиент.** `AppState.sessionUserState` и `sessionRemoved` в [src/store.ts](../src/store.ts);
  [src/session-list.ts](../src/session-list.ts) — `sortSessions` (pinned первыми, затем
  `modifiedAt`, затем ключ канала), `pinnedKeys`, `unreadCounts`;
  [src/panel-presence.ts](../src/panel-presence.ts) — единый `panelVisibility`
  (`detailVisible`/`presence`), которым пользуются presence и badge.
- **UI.** [src/App.tsx](../src/App.tsx): `useMediaQuery(760px)`, `detailVisible` для presence и
  badge, `selected`/`aria-current` остались подсветкой; `.session-row-actions` (pin + archive),
  `.session-title-line` и `.session-unread`; стили в [src/styles.css](../src/styles.css).
- **Палитра.** `recentSessions`/`recentSessionResults` принимают `pinned` и сортируют через
  `sortSessions`; архив по-прежнему исключён, ранжирование поиска не менялось.
- **E2E-хелперы.** `createSession` возвращает фактический заголовок, добавлены `sessionRow`,
  `sessionTitles`, `openSession`, `backToSessionList` (локальная выборка строки вместо
  неоднозначного `getByTitle`).

## Файлы

- Новые: `server/session-user-state.ts`, `server/session-user-state.test.ts`,
  `server/session-snapshot.ts`, `server/state-file.ts`, `server/origin.ts`,
  `src/session-list.ts`, `src/session-list.test.ts`, `src/panel-presence.ts`,
  `src/panel-presence.test.ts`, `e2e/session-pin-unread.spec.ts`, `e2e/session-unread-mobile.spec.ts`.
- Изменённые: `shared/protocol.ts`, `server/index.ts`, `server/presence.ts`,
  `server/presence.test.ts`, `server/push.ts`, `server/push-transitions.ts`,
  `server/protocol.test.ts`, `src/store.ts`, `src/store.test.ts`, `src/App.tsx`,
  `src/styles.css`, `src/search.ts`, `src/search.test.ts`, `src/ui/CommandPalette.tsx`,
  `e2e/support/app.ts`, `README.md`, `memory-bank/AGENTHOS-23.md`.

## Проверки

- `npm ci`, `npm ci --prefix debug-ui` — зависимости восстановлены в worktree.
- Baseline до правок: `npm run typecheck`, `npm test` (314/314), `npm run build` — успешно.
- `npm run typecheck` — успешно (client, server, e2e).
- `npm test` — 345/345 (314 база + 31 новый), 0 падений.
- `npm run build` — успешно; предупреждение Vite о чанке >500 kB прежнее.
- `npm run test:e2e` — 9/9, включая новые `session-pin-unread.spec.ts` (pin + reload, unread +
  reload + deep link) и `session-unread-mobile.spec.ts` (390 px, badge у всё ещё выбранной строки).
  Один полный прогон упал на setup первого файла `copy-response.spec.ts`
  (`ensureHostConnected` не дождался mock-хоста за 60 с — гонка старта webServer/fixture, к правкам
  не относится); изолированный прогон этого файла и следующий полный прогон — 9/9.
- `npm test --prefix debug-ui` — 4/4.
- `git diff --check` — чисто.
- Ручной smoke backend (mock-хост 8199, backend 8099, временный `ACC_STATE_DIR`): ход при видимой
  сессии не дал unread; после снятия selection тот же ход дал `count: 1`; presence с selection
  сбросил запись; файл создан с правами 600; pin пережил `SIGTERM` + повторный запуск backend;
  первый overview после рестарта не начислил unread за старый ход.
