# Очередь задач агентов: design spike

**Задача:** AGENTHOS-22 — «Спроектировать очередь задач агентов».
**Статус:** design proposal (не реализация). Решение о реализации принимает владелец после ревью PR.
**Срез кода:** `main` + ветка `AGENTHOS-22`, HEAD `6cbd5a5`, 24.11.2026.
**Протокол:** `@microsoft/agent-host-protocol` 1.1.0 (`package.json:18`), сверено по `node_modules/@microsoft/agent-host-protocol` в main workspace.
**Артефакт:** только этот документ. Production-код, зависимости, `hosts.json` и Memory Bank не менялись.

**Легенда меток.** «проверено» — прочитано в коде или в типах SDK 1.1.0 на указанном `path:line`. «допущение» — следует из кода, но отдельным экспериментом не подтверждено. «не проверено» — известно только по отчёту Recon 24.11.2026 или требует живого хоста.

---

## TL;DR

- **Рекомендация — вариант B: очередь живёт в backend панели, исполнение идёт обычными AHP-сессиями.** Backend хранит только намерение пользователя: задачу, зависимости, порядок, политику попыток и ссылки на сессии. **Хост остаётся авторитетом сессий, чатов, ходов, approvals, changesets и usage.** Очередь не хранит транскрипт, не ведёт второй список сессий и не переписывает `SessionStatus`/`TurnState` как собственное состояние.
- **Единица v1: 1 задача = 1 попытка = 1 сессия = 1 default chat = 1 ход.** Зависимости соединяют задачи; retry создаёт новую попытку и новую сессию; fork и side chat — пользовательские ветки контекста, а не задачи.
- **Старт хода — прямой `ChatTurnStarted` с клиентским `turnId = attempt.id`**, как это уже делает `Hub.sendMessage` (`server/hub.ts:265`). `ChatPendingMessageSet`/`queuedMessageId` в MVP не используются: потребление очереди сообщений при простое в спецификации описано как `SHOULD`, а корреляция `queuedMessageId` на живом хосте не проверена.
- **Approvals только человеческие.** Очередь обнаруживает `SessionState.inputNeeded`, переводит задачу в `blocked` и не подтверждает ничего сама. `PendingResultConfirmation` и MCP-аутентификацию панель подтвердить не умеет (`src/SessionView.tsx:516`) — это честное ограничение v1, а не скрытая автоматизация.
- **Оценка документа этой задачи — 1,5–2,5 чел.-дня** (сверка, текст, ревью). Будущий MVP — **11–16 чел.-дней** диапазоном; доска +2–3, push +2–4, automation-адаптер +4–6. Календарных сроков нет.

**Как читать.** Нужен только вывод — TL;DR. Нужно решение — §3 (модель) → §4 (владение) → §8–9 (варианты и рекомендация) → §11 (вопросы владельцу). §2 — фактическая база протокола, §5 — исполнение, §6–7 — контракт и UX, §10–12 — риски, открытые вопросы и доказательства.

---

## 1. Цель, границы, сценарии

### 1.1 Пользовательский результат

Пользователь ставит N задач, для каждой выбирает хост, агента, модель и рабочую папку, задаёт зависимости и лимит параллелизма, видит прогресс, блокировки и результат. Каждая задача исполняется в обычной AHP-сессии, которую видно и в панели, и в VS Code. Результат задачи — ссылки на сессию, чат и ход, итоговый статус хода и сводка изменений; транскрипт не копируется.

Сегодня единица работы — сессия: пользователь сам открывает сессию, сам отправляет сообщение и сам следит за ней. Очередь добавляет слой «пакет работы»: что сделать, в каком порядке, с какими зависимостями и что делать при сбое. Она не заменяет сессии и не строит второй UI для чатов.

### 1.2 Не-цели этой задачи

- Реализация очереди, runner'а, UI, доски, push-уведомлений, auto-approval и automation-адаптера. Ни строки production-кода.
- Новые зависимости, изменения `package.json`/lockfile, `hosts.json`, Memory Bank и `README.md`.
- Обещания календарных сроков, «полностью unattended» работы, deep link в VS Code, push.
- Многохостовый failover: задача привязана к выбранному хосту, при недоступности — `blocked`, а не перенос.
- Multi-instance backend: очередь, как и текущее зеркало, рассчитана на один backend.

### 1.3 Сценарии

| # | Сценарий | Ожидаемое поведение |
| --- | --- | --- |
| S1 | Пакет из 3 задач: B зависит от A, C независима, `maxParallel=2` | A и C стартуют; B ждёт A; после завершения A стартует B |
| S2 | На задачу выбраны агент, модель и папка | Создаётся обычная сессия выбранного провайдера; модель передаётся в первом ходе |
| S3 | Задача ждёт подтверждения инструмента | `blocked(tool_confirmation)`; running-слот освобождается, число задач с живой сессией, ждущих человека, ограничено `maxBlocked`; подтверждение в панели или VS Code продолжает ход |
| S4 | Ход завершился `TurnState.Error` | `retry_wait` по политике; новая попытка — новая сессия; старые попытки остаются артефактами |
| S5 | Отмена queued/running | queued сразу `cancelled`; running получает `ChatTurnCancelled`, затем фактический исход сверяется с хостом |
| S6 | Результат и артефакты | Ссылки `sessionUri`/`chatUri`/`turnId`, `changes` из summary; текст ответа не копируется |
| S7 | Перезапуск backend во время работы | Очередь загружается с диска; running-сессия присоединяется по сохранённым ссылкам; завершившаяся за простой задача фиксируется |
| S8 | Хост отключился | `blocked(host_disconnected)`, не `failed`; после reconnect — сверка; без failover на другой хост |
| S9 | Телефон | Список задач, бейдж blocked, открытие сессии, отмена/retry; push-уведомлений нет |
| S10 | Человек пишет в ту же сессию | `blocked(external_turn)`; очередь не борется с человеком и не отменяет его ход |
| S11 | Сессия удалена в VS Code | `failed(session_missing)`; зависимые — `blocked(dependency_failed)` |
| S12 | Повторная отправка формы после обрыва связи | `clientRequestId` делает добавление идемпотентным |
| S13 | Добавление задачи с циклом или несуществующей зависимостью | `queueAdd` отклоняется с понятной ошибкой; очередь не меняется |
| S14 | Пользователь удаляет задачу, от которой зависят другие | Удаление отклоняется: сначала отменить или переназначить зависимые |

### 1.4 Критерии готовности документа

1. Есть цель, не-цели, сценарии и границы.
2. Ограничения AHP 1.1.0 описаны по символам SDK, отдельно — чего протокол не даёт.
3. Модель: задача, попытка, состояния, DAG, параллелизм, retry, approvals, отмена, артефакты, хранение, recovery, инварианты.
4. Явно и неоднократно сказано: **хост остаётся авторитетом сессий**; очередь хранит только intent, порядок, зависимости и ссылки.
5. Сравнены три варианта по одинаковым критериям, дана одна рекомендация с обоснованием.
6. Есть поэтапный план будущей реализации и оценка-диапазон с допущениями.
7. Нет неподтверждённых обещаний: deep link, push, auto-approval, unattended.

### 1.5 Существенные допущения

- **допущение.** Панель и backend работают на Mac пользователя; очередь доступна, пока backend жив. Если очередь должна работать при выключенном Mac, рекомендация меняется в пользу host-owned варианта A.
- **допущение.** Пользователь один; одновременные редакторы очереди — вкладки одного пользователя.
- **допущение.** Хосты — обычные AHP 1.1.0. VS Code Agent Host сохраняет сессии при перезапуске backend, но не гарантирует их при собственном перезапуске.
- **допущение.** Approvals остаются человеческими; auto-approval не входит в MVP.
- **допущение.** Потеря файла очереди — известный риск, а не сценарий восстановления сессий.

---

## 2. Ограничения AHP 1.1.0

### 2.1 Что протокол даёт и чего не даёт

Все символы ниже сверены с типами SDK 1.1.0. Ссылки на код проекта — из текущей реализации.

| Возможность | Что даёт | Чего не даёт | Как использует очередь |
| --- | --- | --- | --- |
| `SessionSummary` | `resource`, `status` (битмаска), `chats`, `defaultChat`, `origin`, `changes`, `activity`, `modifiedAt` | Нет причины блокировки, нет результата хода, нет зависимостей | Список и проекция статуса; join по `(hostId, sessionUri)` |
| `SessionState` | `lifecycle`, `chats: SessionChatSummary[]`, `defaultChat`, `inputNeeded: SessionInputRequest[]`, `activity`, `changesets`, `workingDirectories` | `inputNeeded` host-managed; не все виды запросов панель умеет разрешать | Подписка на сессию активной задачи; источник `blocked` |
| `ChatState` | `activeTurn`, `turns: Turn[]`, `queuedMessages`, `draft`, `changesets`, `interactivity` (проверено, `channels-chat/state.ts:52`) | Очередь сообщений чата — не очередь задач | Мониторинг хода и фиксация результата |
| `Turn` / `TurnState` | `id`, `state: 'complete' \| 'cancelled' \| 'error'`, `responseParts`, `usage` (`channels-chat/state.ts:751`, `:781`) | Нет структурированного «результата задачи» | Детерминированный settle по `turn.state` |
| `ChatOrigin` | `user`, `fork`, `sideChat`, `tool` | Не задача; fork/side — ветки контекста | Не используем как primitive задачи |
| `createSession` | `channel` (URI выбирает клиент), `provider?`, `workingDirectories?`, `config?` (`channels-session/commands.ts:42`) | Нет initial message, нет title; при существующем URI — ошибка `-32003` (`SessionAlreadyExists`) | Создание сессии с заранее известным URI |
| `ChatTurnStarted` | Клиентский `turnId`, `message` (в т.ч. `model`) | Один ход = одно сообщение; DAG нет | Запуск хода v1; `turnId` детерминирован для идемпотентности |
| `ChatPendingMessageSet/Removed/Reordered`, `queuedMessages`, `queuedMessageId` | Штатная очередь сообщений чата; action client-dispatchable | Потребление при простое описано как `SHOULD`; корреляция `queuedMessageId` на живом хосте не проверена | Не primitive MVP; кандидат на отдельную проверку |
| `inputNeeded` + `confirmTool` / `completeInput` | Причина блокировки и всё для ответа; по спецификации отвечать можно без подписки на чат (`channels-session/state.ts:330`) | `toolConfirmation` покрывает и подтверждение параметров, и подтверждение результата; `PendingResultConfirmation` панель не подтверждает; MCP-auth в панели не реализован | Детект `blocked`; ручное подтверждение в панели или VS Code |
| `SessionTitleChanged` / `SessionMetaChanged` | Title client-dispatchable; meta server-only | Provenance задачи в `_meta` записать нельзя | Title — человекочитаемая метка, не идентификатор |
| Automations (`ahp-automations://`, `AutomationEntry`, `runAutomation`) | Host-owned run lifecycle, `primarySession`, provenance, отмена запуска | Нет DAG, приоритетов, retry-политики, ad-hoc run без durable definition | Не хранилище очереди; опциональный адаптер после feature detection |
| `isSupportedChannel` (`shared/reduce.ts:25`) | `ahp-root:`, `ahp-session:`, `ahp-chat:`, changeset | Automation-каналов нет | Вариант B не трогает эти контракты |
| `overview.sessions` (`server/hub.ts:125`) | Готовая проекция списка | Нет `inputNeeded`-причин | Дешёвый poll для планировщика; причины — из подписки на сессию |

Ключевые следствия:

- **`SessionSummary.origin` в 1.1.0 умеет только `automation`** (`SessionOrigin` = `AutomationSessionOrigin`). Обычная сессия очереди не получает provenance задачи, а `SessionMetaChanged` — server-only action (`action-origin.generated.ts:502`), то есть записать `taskId` в метаданные клиент не может. Единственная связь task→session живёт в файле очереди в backend; title — человеческая метка.
- **`createSession` не принимает initial message.** Сообщение отправляется отдельным `ChatTurnStarted` после того, как у сессии появился чат.
- **Хост держит `lifecycle: creating` до первого хода, хотя чат уже доступен** — это зафиксировано комментарием и условием в панели (`src/SessionView.tsx:191`), поэтому ждать `Ready` нельзя: планировщик ждёт `defaultChat`/`chats[0]`.
- **`SessionState.inputNeeded` агрегирован по всем чатам сессии**, entry содержит `id` и `chat` (`channels-session/state.ts:318`). Отвечать по спецификации можно без подписки на чат, но текущий `Hub.confirmTool` идёт через `confirmationOption` (`server/hub.ts:476`), который вызывает `chatState` (`server/hub.ts:495`) и требует зеркала чата. Поэтому очередь не отвечает сама: она показывает блокировку и ведёт пользователя в открытую сессию.
- **`toolConfirmation` — один kind на два разных состояния.** Различать подтверждение параметров и подтверждение результата нужно по `request.toolCall.status`: `ToolCallPendingConfirmationState` против `ToolCallPendingResultConfirmationState` (`channels-chat/state.ts:1707`). Только первое панель умеет подтверждать.
- **`ToolClientExecution`** в `inputNeeded` — это запрос на исполнение инструмента клиентом, а не человекозависимая блокировка; очередь его игнорирует.

### 2.2 Сверка с отчётом Recon

| Утверждение Recon | Проверенный факт | Как учтено |
| --- | --- | --- |
| `Hub.sendMessage` шлёт ход «только при простое» | Hub простоя не проверяет; guard живёт в UI (`src/SessionView.tsx:823`) | Планировщик обязан сам проверять `activeTurn` и `queuedMessages` |
| `PendingResultConfirmation` требует deep link в VS Code | Подтверждения результата в панели нет (`src/SessionView.tsx:516`); механизма deep link в репозитории нет | v1 — `blocked` с инструкцией; deep link не обещаем |
| `session/metaChanged` host-only, provenance в meta не записать | `SessionMetaChanged` — server-only; `SessionTitleChanged` — client-dispatchable | Mapping task→session только в backend |
| `ChatPendingMessageSet` + `queuedMessageId` — штатная очередь | Типы и actions client-dispatchable; потребление — `SHOULD` | Не primitive MVP |
| `createSession` → ждать `Ready` → pending message | initial message нет; при этом сессия `creating`, пока чат уже доступен | Ждём `defaultChat`/`chats[0]` |
| `cancelTurn`/`confirmTool`/`completeInput` переиспользовать | Подтверждено; `confirmTool` — только `PendingConfirmation` | Очередь детектит blocked, approval-логику не дублирует |
| Автоматизации дают run lifecycle и `origin=automation` | Типы SDK подтверждают; живые capabilities и `automationsEnabled` — наблюдение Recon 24.11.2026 | Только адаптер после feature detection |
| `isSupportedChannel` не знает automation | Подтверждено (`shared/reduce.ts:25`) | Вариант A дороже; B не трогает контракты |
| Уведомлений и read-state нет; телефон — Tailscale | Подтверждено: `store.notify` (`src/store.ts:122`), `server/phone-access.ts`, push отсутствует | In-app + title badge в v1 |
| MVP 8–12 чел.-дней | Нижняя граница реалистична только без recovery и DAG-UI | В документе 11–16 с допущениями |

Живые наблюдения Recon (хосты на портах 8089/8091, `automationsEnabled=false`) в этом документе помечены как **не проверенные в этой ноде**: они не влияют на архитектурные выводы, но влияют на приоритет automation-адаптера.

### 2.3 Что уже есть в панели и переиспользуется

| Код | Роль в очереди | Почему подходит |
| --- | --- | --- |
| `Hub.watch` / `unwatch` (`server/hub.ts:147`, `:163`) | Execution lease на сессию и чат | Уже считает подписки; браузер и очередь не мешают друг другу |
| `ChannelMirror` (`server/mirror.ts`) | Актуальное состояние сессии и чата | Снимок + actions по `serverSeq`; не второй источник истины |
| `Hub.dispatchTurnAndWait` / `waitForAction` (`server/hub.ts:512`, `:527`) | Подтверждение старта хода | Уже обрабатывает rejection и таймаут 15 с (`ACTION_CONFIRMATION_MS`, `server/hub.ts:58`) |
| `Hub.cancelTurn` (`server/hub.ts:293`) | Отмена running-хода | Проверяет `activeTurn.id`; не дублируем |
| `Hub.confirmTool` / `completeInput` (`server/hub.ts:305`, `:314`) | Ручное снятие blocked | Остаётся в UI, очередь не автоматизирует |
| `toFileUri` (`server/hub.ts:732`) | Валидация рабочей папки | Уже требует абсолютный POSIX-путь |
| Валидация модели в `sendMessage` (`server/hub.ts:265`) | Проверка target задачи | Вынести в общий helper, чтобы очередь и UI не расходились |
| `Hub.overview` / `hostOverview` (`server/hub.ts:125`, `:664`) | Проекция сессий и хостов | Один источник для списка и очереди |
| `phaseOf` / `isArchived` (`src/format.ts:36`, `:43`) | Бейджи статуса | Уже учитывает битмаску `InputNeeded` |
| `SessionRow` / `NewSession` (`src/App.tsx:253`, `:430`) | Паттерны списка и формы | Стиль, выбор хоста/агента/папки |
| `store.call` / `watch` / `notify` (`src/store.ts:95`, `:75`, `:122`) | Контракт UI | Queue-calls и snapshot встраиваются сюда |
| `server/hub.test.ts` fake host + `echo` | Тесты старта и rejection | Позволяет проверить идемпотентность без живого хоста |
| `server/lifecycle.test.ts` fake events | Тесты recovery и подписок | EventEmitter-модель уже есть |
| `src/store.test.ts` FakeSocket | Тест нового сообщения `queue` | Без React и без сети |

---

## 3. Модель сущностей

### 3.1 Единица работы v1

**1 задача = 1 попытка = 1 сессия = 1 default chat = 1 ход.**

Почему так:

- Сессия — то, что хост умеет создавать, хранить и показывать в VS Code. Одна задача — одна сессия означает, что пользователь видит ровно один разговор на задачу, без склейки и без «скрытых» сессий.
- Один ход на попытку означает, что результат и ошибка однозначно выражаются через `Turn.state`, а не через эвристику по нескольким ходам. Если агенту нужно уточнение, он спросит через `chatInput` — это блокировка, а не второй ход.
- Retry создаёт новую попытку и **новую сессию**: старая сессия остаётся артефактом со своим результатом, ходы не переиспользуются и история не переписывается.
- Fork и side chat — пользовательские ветки контекста (`ChatOrigin.fork` / `sideChat`), а не задачи. Очередь их не создаёт и не отслеживает как работу.

Что это ограничивает (честно): задача не может состоять из нескольких последовательных ходов в одной сессии, не может агрегировать результат нескольких сессий и не поддерживает «продолжить разговор» внутри задачи. Это следующий уровень, и он потребует отдельного решения о том, кто считает границу задачи.

### 3.2 Задача

Persisted-запись. Хранится целиком только в backend-файле.

```ts
interface QueueTaskRecord {
  id: string;                       // UUID, стабильный идентификатор задачи
  title: string;                    // человекочитаемая метка; дублируется в title сессии
  prompt: string;                   // текст первого и единственного хода, ≤ 100 KB
  target: {
    hostId: string;
    provider: string;               // id агента, не display name
    modelId?: string;
    modelConfig?: Record<string, unknown>; // reasoning и прочие chatMutable-параметры
    workingDirectory: string;       // абсолютный POSIX-путь на хосте
  };
  dependsOn: string[];              // id задач той же очереди
  maxAttempts: number;              // 1–3, default 1
  position: number;                 // порядок среди готовых задач
  state: QueueTaskState;
  blocked?: { kind: QueueBlockedKind; since: string };
  cancelRequestedAt?: string;
  attempts: QueueAttempt[];
  outcome?: QueueOutcome;
  error?: QueueError;
  clientRequestId?: string;         // идемпотентность добавления
  createdAt: string;
  updatedAt: string;
}

type QueueTaskState =
  | 'queued' | 'starting' | 'running' | 'blocked' | 'retry_wait'
  | 'completed' | 'failed' | 'cancelled';
```

`state` — это состояние **намерения и оркестрации**, а не копия `SessionStatus`. Оно отвечает на вопрос «что очередь собирается делать с задачей», а не «что сейчас делает хост». Например, `running` означает «у задачи есть незавершённый ход, очередь его ждёт», а не «хост сообщил InProgress»; фактический статус хода читается из `ChatState`.

### 3.3 Попытка

```ts
interface QueueAttempt {
  id: string;                 // UUID; он же turnId при прямом старте хода
  number: number;             // 1..maxAttempts, ручной retry может превысить maxAttempts
  sessionUri: string;         // сгенерирован и записан ДО createSession
  chatUri?: string;           // появляется, когда хост отдал defaultChat/chats[0]
  turnId?: string;            // = id; записан ДО dispatch
  state: 'active' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  endedAt?: string;
  outcome?: QueueOutcome;
  error?: QueueError;
}

interface QueueOutcome {
  turnState: 'complete' | 'cancelled' | 'error';
  finishedAt: string;
  changes?: ChangesSummary;   // снимок на момент завершения, не живое состояние
}

interface QueueError {
  kind:
    | 'turn_error' | 'start_timeout' | 'turn_rejected' | 'creation_error'
    | 'session_missing' | 'chat_read_only' | 'model_unavailable' | 'auth_required';
  message: string;
}
```

`state: 'active'` — не «истина о сессии», а «эта попытка ещё не урегулирована». При загрузке backend такая попытка пере-сверяется с хостом и получает терминальное состояние либо продолжает отслеживаться. Живой статус хода в файле не хранится.

### 3.4 Состояния и переходы

```
Основной путь:
  queued ──▶ starting ──▶ running ──▶ completed
               │             │
               │             ├── inputNeeded ───▶ blocked ───▶ running   (запрос снят)
               │             │                       └───────▶ cancelled (cancel)
               │             └── Turn.state=cancelled ───────▶ cancelled
               └── сбой старта ──▶ retry_wait ──▶ starting (новая сессия)
                                      └── попытки кончились ──▶ failed

Отмена и потери:
  queued | retry_wait ── cancel ──▶ cancelled
  blocked             ── cancel ──▶ cancelled
  running             ── Turn.state=error ──▶ retry_wait (есть попытки) | failed
  starting | running | blocked ── сессия исчезла ──▶ failed(session_missing)

Терминальные состояния: completed, failed, cancelled.
```

| Из | Событие | В | Примечание |
| --- | --- | --- | --- |
| — | `queueAdd` | `queued` | Валидация target, зависимостей, лимитов |
| `queued` | зависимости `completed` + свободен running-слот | `starting` | Слот резервируется **до** await; пишется `sessionUri` |
| `queued` | cancel | `cancelled` | Без обращения к хосту |
| `starting` | чат получен, `ChatTurnStarted` подтверждён | `running` | `chatUri`, `turnId` записаны до dispatch |
| `starting` | retryable-сбой, попытки есть | `retry_wait` | `error` сохраняется в попытке |
| `starting` | cancel | `cancelled` | `cancelRequestedAt`; пустая сессия остаётся у хоста |
| `starting` | retryable-сбой, попыток нет | `failed` | Терминальное |
| `starting` | `auth_required`, `model_unavailable`, `chat_read_only` | `failed` | Требуется человек, автоматический retry бессмыслен |
| `running` | `turn.state === 'complete'` | `completed` | `outcome` из `Turn` + `changes` |
| `running` | `turn.state === 'error'` | `retry_wait` или `failed` | По политике попыток |
| `running` | `turn.state === 'cancelled'` | `cancelled` | В т.ч. отмена человеком вне очереди; автоматического retry нет |
| `running` | `inputNeeded` по чату попытки | `blocked` | Kind определяется по entry; running-слот освобождается |
| `running` | сессия исчезла при подключённом хосте | `failed(session_missing)` | Зависимые → `blocked(dependency_failed)` |
| `blocked` | `inputNeeded` по чату попытки исчез | `running` | Ход продолжается или уже завершился — решается по `ChatState` при следующем tick |
| `blocked` | host disconnected | `blocked(host_disconnected)` | Причина блокировки меняется, слот не занимается |
| `blocked` | cancel | `cancelled` | Если ход жив — `cancelTurn` |
| `retry_wait` | backoff истёк | `starting` | Новая попытка, новая сессия |
| любой нетерминальный | host reconnect | сверка | Состояние пересчитывается с хоста, а не «додумывается» |

Терминальные состояния: `completed`, `failed`, `cancelled`. Из них только ручные `queueRetry` (для `failed`/`cancelled`) и `queueRemove`.

### 3.5 Зависимости

- `dependsOn` ссылается только на задачи той же очереди. Цикл, self-dependency и несуществующий id отклоняются при `queueAdd` (и при `queueUpdateSettings`, если он меняет граф).
- Задача готова, когда **все** зависимости в `completed`. `failed` или `cancelled` зависимость не запускает задачу, а переводит её в `blocked(dependency_failed | dependency_cancelled)` — без каскадной отмены и без автоматического «проброса» ошибки. Владелец решает: retry зависимости, отмена зависимой или правка графа.
- Удаление задачи, от которой зависят другие, отклоняется. Сначала отменяются или переназначаются зависимые. Это защищает от «висячих» ссылок в графе.
- `position` упорядочивает готовые задачи между собой. При равном `position` — по `createdAt`.
- Глубина графа и число задач ограничены: 200 задач на очередь достаточно для панели и держит snapshot маленьким. DAG без циклов, значит глубина ≤ 200 по построению.

### 3.6 Параллелизм

- `settings.maxParallel` — 1–8, default 2. Считает только задачи в `starting | running`.
- `settings.maxBlocked` — 0–8, default 2, где 0 означает «без ограничения». Считает только задачи в `blocked`, у которых **есть живая сессия и ожидается действие человека**: `tool_confirmation`, `tool_result_confirmation`, `chat_input`, `tool_authentication`, `external_turn`, `session_archived`, `cancel_pending`.
- Задача стартует, только если `running < maxParallel` **и** `humanBlocked < maxBlocked`. Иначе она остаётся `queued`; уже запущенные задачи продолжают работать.
- `blocked` не держит running-слот. Иначе одно подтверждение инструмента останавливает весь пакет: слот занят, новая независимая задача не стартует, а человек может уйти на час.
- `blocked(host_disconnected | host_unknown | dependency_failed | dependency_cancelled)` не занимает ни running-слот, ни `maxBlocked`: живой сессии под контролем очереди нет, ограничивать нечего.
- `retry_wait` не занимает ни того, ни другого: попытка уже завершилась, новая ещё не началась.
- Лимиты глобальные, без per-host и per-directory. Причина: одна панель, один пользователь; per-host лимиты добавляют настройку без ясной пользы. Предупреждение о двух задачах в одной рабочей папке показывается в UI, но не блокирует — параллельная работа в одной папке иногда осмысленна и всегда рискованна.

### 3.7 Retry

- Автоматический retry только для `turn_error` (`TurnState.Error`) и retryable-сбоев старта: `start_timeout`, `turn_rejected`, `creation_error`.
- Backoff: 30 с → 2 мин → 10 мин, дальше cap 10 мин. Значения фиксированные в v1; настройка — позже, если появится запрос.
- Новая попытка — новая сессия и новый `turnId`. Старая сессия не удаляется и не архивируется очередью: это артефакт со своим исходом.
- `maxAttempts` 1–3, default 1: по умолчанию задача не ретраится, потому что агент мог уже сделать половину работы и повтор опасен. Автоматический retry — осознанный выбор пользователя.
- Ручной `queueRetry` разрешён сверх `maxAttempts`: человек видит контекст и решает сам.
- Не ретраятся автоматически: `cancelled` (в т.ч. отмена человеком), `session_missing`, `auth_required`, `model_unavailable`, `chat_read_only`. Для них нужен человек или изменение target.
- Идемпотентность: `turnId` фиксирован до dispatch. Если dispatch отвалился по таймауту, но хост принял ход, сверка находит ход с этим `turnId` в `activeTurn` или `turns` и присваивает его вместо создания второй попытки.

### 3.8 Approvals и блокировки

Очередь **только обнаруживает** блокировку. Она не подтверждает инструменты, не отвечает на вопросы и не пытается обойти approval.

```ts
type QueueBlockedKind =
  // ждёт человека, есть живая сессия — считается в maxBlocked
  | 'tool_confirmation' | 'tool_result_confirmation' | 'chat_input'
  | 'tool_authentication' | 'external_turn' | 'session_archived' | 'cancel_pending'
  // инфраструктура — не считается ни в maxParallel, ни в maxBlocked
  | 'host_disconnected' | 'host_unknown'
  // решение по графу — не считается нигде, живой сессии нет
  | 'dependency_failed' | 'dependency_cancelled';
```

Алгоритм на каждом tick для задачи в `starting | running`:

1. Взять `SessionState.inputNeeded` (если `attempt.chatUri` ещё нет — пропустить шаг).
2. Оставить только entries с `entry.chat === attempt.chatUri`. Причина: `inputNeeded` агрегирован по всем чатам сессии (`channels-session/state.ts:433`), а approval в боковом чате человека не должен блокировать задачу.
3. Классифицировать:

| `inputNeeded[].kind` | Условие | `QueueBlockedKind` | Панель умеет снять? |
| --- | --- | --- | --- |
| `chatInput` | — | `chat_input` | Да, `completeInput` (`server/hub.ts:314`) |
| `toolConfirmation` | `request.toolCall.status === 'pending-confirmation'` | `tool_confirmation` | Да, `confirmTool` (`server/hub.ts:305`) |
| `toolConfirmation` | `request.toolCall.status === 'pending-result-confirmation'` | `tool_result_confirmation` | **Нет** (`src/SessionView.tsx:516`) |
| `toolAuthentication` | — | `tool_authentication` | **Нет** (в панели не реализовано) |
| `toolClientExecution` | — | игнорируется | Не human-block |

4. Перевести задачу в `blocked` с причиной и временем. Освободить running-слот.
5. Когда entry исчез — на следующем tick пересчитать состояние по `ChatState`: `activeTurn` жив → `running`; ход завершён → settle.

Что происходит дальше: пользователь открывает задачу, попадает в обычную сессию (панель или VS Code), подтверждает инструмент или отвечает на вопрос. Очередь видит, что `inputNeeded` опустел, и продолжает. Никакого auto-approval в v1 нет: политика «подтверждать всё, что просит агент» — это отдельное продуктовое и security-решение, а не деталь очереди.

Дополнительные причины блокировки, не связанные с `inputNeeded`:

| Причина | Когда | Кто снимает |
| --- | --- | --- |
| `external_turn` | В чате попытки уже есть чужой активный ход или `queuedMessages` (чужой ввод) | Человек завершает свой ход; очередь не отменяет чужой ход |
| `session_archived` | Сессия или чат архивированы | Человек восстанавливает сессию |
| `cancel_pending` | Отмена запрошена, но хост не подтвердил её за 30 с | Человек останавливает ход в панели или VS Code |
| `host_disconnected` | Хост отключён | Reconnect |
| `host_unknown` | Хост исчез из конфигурации | Правка `hosts.json` и перезапуск backend |
| `dependency_failed` / `dependency_cancelled` | Зависимость завершилась неуспешно | Retry зависимости, отмена задачи или правка графа |

Отличие от плана (осознанное уточнение): в плане `session_missing` и `model_unavailable` перечислены среди blocked-причин. Здесь они — терминальные `failed`, потому что это не «ждём человека с живой сессией», а «эта попытка больше не может продолжаться». `session_missing` ставится только при подключённом хосте и подтверждённом отсутствии сессии (событие `sessionRemoved` или сессия отсутствует в `overview.sessions` дольше 5 с). Пока хост недоступен, это `blocked(host_disconnected)`: отсутствие данных — не доказательство отсутствия сессии.

### 3.9 Отмена

- `queued` → `cancelled` немедленно, без обращения к хосту.
- `starting` → `cancelRequestedAt`, попытка помечается `cancelled`; если `createSession` уже прошёл, сессия остаётся пустой — очередь её не удаляет, хост ею владеет.
- `running` → `cancelRequestedAt`, затем `Hub.cancelTurn` с `turnId` попытки. После этого задача остаётся в `running` до сверки: `cancelTurn` мог не сработать, если ход успел завершиться (`server/hub.ts:293` бросает «Этот ход уже завершён»).
- Сверка: при следующем tick смотрим `ChatState`. Ход завершился `complete` → `completed` (не врём про отмену); `cancelled` → `cancelled`; `error` → `failed`; ход всё ещё активен → повторяем `cancelTurn` с ограничением (не чаще раза в 2 с, до 30 с), затем `blocked(cancel_pending)` с сообщением «хост не подтвердил отмену».
- `blocked` → `cancelRequestedAt`, снимаем lease, `cancelled`. Если ход жив (например, blocked по `external_turn`), сначала `cancelTurn`.
- `retry_wait` → `cancelled` без обращения к хосту.
- Отмена не удаляет сессию. Пользователь может открыть её и посмотреть, что успел сделать агент.

### 3.10 Артефакты и результат

Задача хранит ссылки и снимок исхода:

- `attempts[].sessionUri`, `chatUri`, `turnId` — адреса, по которым всё открывается.
- `outcome.turnState` — `Turn.state` нужного хода из `ChatState.turns`. Пока ход активен, исхода нет: задача остаётся `running` или `cancel_pending`.
- `outcome.finishedAt` — время фиксации исхода.
- `outcome.changes` — `SessionChatSummary.changes` нужного чата, fallback на `SessionSummary.changes`; это **снимок** на момент завершения, помечен как снимок.

Не копируются: текст ответа, `responseParts`, транскрипт, `usage`, содержимое файлов. Причины: дублирование транскрипта — это второй источник истины и распухание файла очереди; usage и файлы уже доступны через хост. Если сессия удалена, ссылка помечается `missing` при открытии, но задача не переписывает свой исход.

Почему не excerpt ответа в v1: короткий excerpt кажется дешёвым, но требует политики усечения, хранения и приватности. Ссылка на ход + `changes` даёт достаточно, чтобы понять результат, и не создаёт копию контента. Это открытый вопрос владельцу (§11, вопрос 5).

### 3.11 Инварианты

1. Нет второго списка сессий: очередь не хранит сессии, которые она не создавала, и не удаляет созданные.
2. Нет транскрипта: только ссылки, `Turn.state`, `changes`.
3. Нет auto-approval: очередь не диспатчит `ChatToolCallConfirmed`, `ChatToolCallResultConfirmed` и `ChatInputCompleted`.
4. Нет задачи без target: `hostId`, `provider`, `workingDirectory` обязательны и валидируются.
5. Нет цикла в `dependsOn`.
6. Нет `running` без активной попытки с `sessionUri`.
7. Нет терминального состояния без `outcome` или `error`.
8. Нет двух активных задач на одну сессию: сессию создаёт только очередь, для одной задачи.
9. Нет `cancelRequestedAt` без последующей сверки: отмена — процесс, а не флаг.
10. Нет изменения `SessionStatus`/`TurnState` в файле очереди.

---

## 4. Владение состоянием и хранение

### 4.1 Кто чем владеет

| Данные | Владелец | Где живёт | Как читается |
| --- | --- | --- | --- |
| Сессия, чат, ход, approvals, changesets, usage | **Хост** | AHP | `overview.sessions` + подписка на session/chat |
| Task intent, DAG, порядок, политика попыток, target | Backend | `.local/task-queue.json` (0600) | Snapshot по WS |
| Прогресс задачи | Производный | Backend state machine + проекция хоста | Snapshot; живой статус сессии не persisted |
| Вид, фильтры, черновик формы | Браузер | React state | Локально |

### 4.2 Правила

1. **При конфликте выигрывает хост.** Очередь перезаписывает свою проекцию по данным хоста, а не спорит с ними. Если хост говорит «ход идёт», а очередь думала «completed», задача возвращается в `running`.
2. **Очередь не хранит живой `SessionStatus`/`TurnState`.** В файле — только терминальный `outcome.turnState` как снимок «чем кончилось».
3. **Очередь не утверждает, что сессия существует.** Она хранит ссылку и проверяет её у хоста. `session_missing` — результат проверки, а не отдельное знание.
4. **Потеря файла очереди теряет задачи, но не сессии.** Это явный риск, а не сценарий восстановления сессий.
5. **Один backend.** Multi-instance не поддерживается, как и текущее зеркало: два процесса с одним файлом дадут гонку и второй источник истины.

Отдельно: **хост остаётся авторитетом сессий** — очередь не создаёт альтернативный реестр, не переименовывает сессии задним числом, не архивирует и не удаляет их. `SessionTitleChanged` используется только как косметическая метка при создании, и его отказ не ломает задачу.

### 4.3 Формат файла

```jsonc
{
  "version": 1,
  "revision": 42,            // монотонный счётчик для отладки и обнаружения откатов
  "settings": { "maxParallel": 2, "maxBlocked": 2 },
  "tasks": [ /* QueueTaskRecord[] */ ]
}
```

- Путь: `.local/task-queue.json` (рядом с другими локальными данными; `.local/` в `.gitignore:1`).
- Права `0600`, запись с `O_NOFOLLOW` по образцу уже существующей практики для локальных файлов (`scripts/start-gemini-host.ts:123`).
- Атомарная запись: `task-queue.json.tmp` → `fsync` → `rename`; предыдущая версия уходит в `task-queue.json.bak`. Rename в одной файловой системе атомарен, поэтому читатель видит либо старый, либо новый файл.
- Все записи сериализуются в одном месте (single writer). Никаких параллельных `writeFile` из разных модулей.
- Лимит: 200 задач. Терминальные задачи без зависимых прунятся по `updatedAt` старше настраиваемого порога (default 30 дней) — но только по явному действию пользователя или при превышении лимита, чтобы не терять историю молча.
- `clientRequestId` (UUID со стороны формы) делает `queueAdd` идемпотентным: повтор после обрыва возвращает существующую задачу, а не создаёт вторую.
- Ошибка записи не валит backend: она попадает в `QueueSnapshot.persistenceError` и показывается в UI. Очередь продолжает работать в памяти и пытается записать снова.
- **Corrupt JSON:** пробуем `.bak`. Если и он невалиден — переименовываем повреждённый файл в `task-queue.json.corrupt-<ISO>` (ничего не удаляем), стартуем с пустой очередью и отдаём `loadError` в snapshot. Молча подменять данные пустотой нельзя.

### 4.4 Recovery и write-ahead

Правило: **всё, что нельзя восстановить из хоста, пишется до необратимого действия.**

| Перед чем | Что persisted |
| --- | --- |
| `createSession` | задача `starting`, попытка с `sessionUri` (сгенерирован заранее) |
| `ChatTurnStarted` | `chatUri`, `turnId` (равен `attempt.id`), задача `running` |
| `ChatTurnCancelled` | `cancelRequestedAt` |
| Терминальный переход | `outcome`/`error`, `endedAt` |

Алгоритм при старте backend:

1. Загрузить файл (с fallback на `.bak`).
2. Для каждой нетерминальной задачи:
   - проверить, известен ли `hostId` и подключён ли хост; если нет — `blocked(host_disconnected | host_unknown)`;
   - для `starting`: выполнить `createSession` с сохранённым `sessionUri`. Если хост ответил `-32003 SessionAlreadyExists` (`channels-session/commands.ts:26`) — сессия уже создана до падения backend, это успех: продолжаем с шага «ждать чат». Если хост ответил другой ошибкой — `retry_wait`/`failed` по политике. Этот случай — главная причина, почему `sessionUri` генерируется заранее: без него повтор создал бы вторую сессию;
   - для `running`: подписаться на сессию и чат по сохранённым URI, прочитать `ChatState`:
     - `activeTurn.id === turnId` → продолжаем `running`;
     - ход в `turns` с нашим `turnId` → settle по `turn.state`;
     - `inputNeeded` по нашему чату → `blocked` с причиной;
     - чата нет, ход не найден, хост подключён и сессия отсутствует → `failed(session_missing)`;
     - сессия есть, но ход не найден и `activeTurn` пуст → `retry_wait` (dispatch потерялся) с проверкой, что `turnId` действительно нигде нет;
   - для `blocked` (включая `cancel_pending`) и `retry_wait`: пересчитать причину/backoff. `retry_wait` с истёкшим backoff сразу становится `starting`.
3. Записать нормализованное состояние, только если оно изменилось.
4. Запустить tick.

Отдельно: если во время простоя ход завершился и `activeTurn` пуст, а в `turns` есть наш `turnId` — задача фиксируется как завершившаяся, даже если пользователь не видел этого. Иначе очередь «зависает» на задаче, которая давно закончилась.

---

## 5. Исполнение

### 5.1 Sequence

```
Браузер        Backend: QueueRunner            Hub-адаптер                 AHP-хост
   |  queueAdd         |                            |                         |
   |------------------>| validate, persist(queued)  |                         |
   |<-- snapshot ------|                            |                         |
   |                   | tick: ready + slot         |                         |
   |                   | persist(starting, uri)     |                         |
   |                   |--------------------------->| createSession(uri)      |
   |                   |                            |------------------------>|
   |                   |                            |<--- created ------------|
   |                   |<-- session snapshot -------|                         |
   |                   | wait defaultChat/chats[0]  |                         |
   |                   |--------------------------->| retain(session), watch  |
   |                   |                            |------------------------>|
   |                   | wait chat idle             |                         |
   |                   | persist(chatUri, turnId, running)                    |
   |                   |--------------------------->| dispatch ChatTurnStarted|
   |                   |                            |------------------------>|
   |                   |                            |<--- action echo --------|
   |                   |<-- confirmed --------------|                         |
   |<-- snapshot ------|                            |                         |
   |                   | poll 1s: ChatState         |                         |
   |                   |  activeTurn -> running     |                         |
   |                   |  inputNeeded -> blocked    |                         |
   |                   |  turn.state -> settle      |                         |
   |                   | persist(outcome), release  |                         |
   |<-- snapshot ------|                            |                         |
```

### 5.2 Шаги и таймауты

1. **Tick.** Single-flight: если tick уже идёт, второй не запускается. Tick выбирает готовую задачу с минимальным `position`, проверяет слоты, резервирует слот в памяти и пишет `starting` + `sessionUri`. Резерв — до первого `await`, иначе два параллельных tick'а стартуют одну задачу дважды.
2. **Создание сессии.** `createSession` с `channel = sessionUri`, `provider`, `workingDirectories = [toFileUri(workingDirectory)]`. Ждём `defaultChat` или `chats[0]` из `SessionState` (не `lifecycle === 'ready'`): хост держит `creating`, пока чат уже доступен (`src/SessionView.tsx:191`). Таймаут — 60 с. Если `lifecycle === 'failed'` → `failed(creation_error)`.
3. **Lease.** `Hub.watch(hostId, sessionUri)`, затем `Hub.watch(hostId, chatUri)`; счётчики подписок не дают очереди и браузеру мешать друг другу (`server/hub.ts:147`).
4. **Проверка чата.** Дождаться загрузки `ChatState`. Если `interactivity` задан и не `full` → `failed(chat_read_only)`. Если есть `activeTurn` или непустые `queuedMessages` (очередь их не создаёт, значит это чужой ввод) → `blocked(external_turn)` (не отменяем чужой ход).
5. **Старт хода.** Persist `chatUri`, `turnId`, `running`; диспатч `ChatTurnStarted` с `turnId = attempt.id`, `message.text = prompt`, `message.origin = { kind: MessageKind.User }`, при наличии модели — `message.model = { id, config }`. Ждём подтверждения через `dispatchTurnAndWait` (таймаут 15 с, `ACTION_CONFIRMATION_MS`).
   - Rejection до принятия → `retry_wait`/`failed`.
   - Таймаут → перечитать чат: если `activeTurn.id === turnId` или ход найден в `turns` — считаем старт успешным; иначе `retry_wait`.
6. **Мониторинг.** Пока есть нетерминальные задачи — tick раз в секунду (не чаще). Оптимизация: если все задачи в `blocked`/`retry_wait` с длинным backoff, интервал можно растянуть, но в v1 проще фиксированный.
7. **Settle.** Терминальный переход: persist `outcome`/`error`, `release` watches в `finally` (иначе счётчик подписок течёт), освободить слот, `kick` tick.
8. **Cancel / retry / recovery** — отдельные ветки с теми же инвариантами. Ни одна из них не обходит шаги persist-before-act.

Таймауты по умолчанию: создание сессии вместе с появлением чата — 60 с, подтверждение старта — 15 с (существующая константа), poll — 1 с. Wall-clock-лимит на сам ход по умолчанию **выключен**: агент может законно работать десятки минут, и «убить по таймауту» — это скрытая потеря работы. Лимит можно добавить как настройку позже.

### 5.3 Гонки и как они закрыты

| Гонка | Защита |
| --- | --- |
| Два tick'а стартуют одну задачу | Single-flight tick + резерв слота до `await` + persist `starting` |
| Backend упал между `createSession` и записью `sessionUri` | `sessionUri` пишется **до** вызова; повтор получает `-32003` и продолжает |
| Ход принят, но подтверждение потеряно | `turnId` детерминирован; сверка `activeTurn`/`turns` вместо второго dispatch |
| Человек отправил сообщение в тот же чат | `blocked(external_turn)`; очередь не отменяет чужой ход |
| Человек подтвердил approval одновременно с тиком | Очередь вообще не отвечает на approvals, конфликта нет |
| Cancel приходит, когда ход уже завершился | `cancelTurn` бросает «уже завершён»; settle фиксирует фактический `Turn.state` |
| Сессия удалена во время мониторинга | `sessionRemoved`/отсутствие в overview → `failed(session_missing)`, зависимые blocked |
| Два backend на одном файле | Не поддерживается и явно запрещено правилом владения |

### 5.4 Вмешательство человека

Человек — полноценный участник: он может открыть сессию задачи и написать в неё. Очередь не считает сессию своей собственностью. Поведение:

- Если в чате появился чужой активный ход или непустые `queuedMessages` — задача переходит в `blocked(external_turn)`. Очередь не отменяет ход человека и не отправляет второй.
- Как только чат освободился, а незавершённого хода задачи нет, задача пересчитывается: если ход задачи уже завершён — settle; если нет и хода нет — `retry_wait` (осторожно, с проверкой `turnId`), потому что ход мог быть отменён человеком.
- Если человек меняет модель/конфиг сессии, очередь это не откатывает: это его сессия. Задача продолжает ждать ход.

### 5.5 Хост: disconnect, restart, updates

- **Disconnect:** все задачи, чьи сессии на этом хосте, переходят в `blocked(host_disconnected)`. Ни `failed`, ни retry: сеть может вернуться. Слоты освобождаются.
- **Reconnect:** подписки переустанавливаются, состояние задач сверяется по `overview.sessions` и `ChatState`. Задачи, чьи сессии исчезли, → `failed(session_missing)`, зависимые → `blocked(dependency_failed)`.
- **Restart хоста:** сессии могут исчезнуть. Это неотличимо от удаления; поведение то же.
- **Обновление/рестарт сервисов:** `server/index.ts:194` блокирует `createSession`/`sendMessage` и родственные операции, пока хост перезапускается (`updates.isRestarting`). Runner должен вести себя так же: не начинать `starting`, пока хост в этом состоянии, и переводить такие задачи в `blocked`, а не спамить ошибками. Техническая деталь: проверка `updates.isRestarting(call.hostId)` работает только потому, что union сужен early-return'ами до `HostCall`. Если добавить `QueueCall` без `hostId` в `Call`, TypeScript не даст обратиться к `call.hostId` у union с вариантом без `hostId` — маршрутизацию queue-calls нужно делать до этой ветки, а проверку сузить явным type guard'ом.
- **Backend restart:** см. §4.4.

---

## 6. Контракт backend ↔ браузер

Очередь добавляет собственный канал панели. **Контракты AHP не меняются:** ни новых actions, ни новых каналов, ни изменений в `shared/reduce.ts`.

### 6.1 Типы

`shared/queue.ts` — единственное место, где описаны типы очереди (общие для server и browser):

```ts
export type QueueTaskState = /* см. §3.2 */;
export type QueueBlockedKind = /* см. §3.8 */;

export interface QueueTaskSummary {        // snapshot: без полного prompt
  id: string;
  title: string;
  promptPreview: string;                   // первые 200 символов, одна строка
  target: QueueTaskRecord['target'];
  dependsOn: string[];
  maxAttempts: number;
  position: number;
  state: QueueTaskState;
  blocked?: { kind: QueueBlockedKind; since: string };
  attempts: QueueAttempt[];                // ссылки и исходы попыток, без транскрипта
  outcome?: QueueOutcome;
  error?: QueueError;
  createdAt: string;
  updatedAt: string;
}

export interface QueueTaskDetail extends QueueTaskSummary {
  prompt: string;                          // полный текст; в snapshot только promptPreview
}

export interface QueueSnapshot {
  settings: QueueSettings;
  tasks: QueueTaskSummary[];
  loadError?: string;
  persistenceError?: string;
  revision: number;
}

export type QueueCall =
  | { op: 'queueList' }
  | { op: 'queueGet'; taskId: string }
  | { op: 'queueAdd'; clientRequestId: string; task: QueueAddInput }
  | { op: 'queueCancel'; taskId: string }
  | { op: 'queueRetry'; taskId: string }
  | { op: 'queueRemove'; taskId: string }
  | { op: 'queueMove'; taskId: string; position: number }
  | { op: 'queueUpdateSettings'; settings: Partial<QueueSettings> };

export function isQueueCall(call: Call): call is QueueCall;
```

`QueueAddInput` содержит всё, что нужно для создания записи, включая `dependsOn` и `maxAttempts`; `id`, `createdAt`, `updatedAt` и `position` назначает backend. `queueList` возвращает `QueueSnapshot` (нужен для явного refresh: snapshot приходит и push'ем, но после reconnect браузер может захотеть перечитать).

### 6.2 Calls

| Call | Назначение | Валидация / ограничения |
| --- | --- | --- |
| `queueList` | Полный snapshot | — |
| `queueGet` | Полная задача с prompt и attempts | Неизвестный id → ошибка |
| `queueAdd` | Добавить задачу | Хост известен; `provider` непустой; папка — абсолютный POSIX-путь (`toFileUri`); prompt непустой и ≤ 100 KB; `dependsOn` существуют, без цикла и self; `maxAttempts` 1–3; очередь < 200; `clientRequestId` уникален либо повторяет уже добавленную задачу; при подключённом хосте — `modelId` есть в каталоге агента |
| `queueCancel` | Отменить | `queued` — сразу; `starting`/`running`/`blocked` — через сверку; терминальные → ошибка «уже завершена» |
| `queueRetry` | Ручной retry | Только `failed`/`cancelled`; создаёт новую попытку с номером `max(number)+1`, `maxAttempts` не ограничивает ручной retry |
| `queueRemove` | Удалить | Только `queued` или терминальные; при наличии зависимых — ошибка; running/blocked сначала `queueCancel` |
| `queueMove` | Изменить порядок | Только `queued`; `position` клампится в диапазон |
| `queueUpdateSettings` | Лимиты | `maxParallel` 1–8, `maxBlocked` 0–8; применяется немедленно, уже запущенные задачи не останавливаются |

Ошибки — через существующий `CallError.message` (`shared/protocol.ts:102`). Отдельные машинные коды не нужны: UI показывает текст, а различать случаи по строкам не требуется. Promise `queueAdd` возвращает `{ taskId }`, чтобы форма могла открыть созданную задачу.

`queueUpdateTask` (редактирование queued-задачи) в v1 **нет**: это тянет за собой пересчёт зависимостей и частичную валидацию. Удалить и создать заново дешевле и честнее. Это ограничение UX, а не архитектуры; при запросе добавляется отдельным этапом.

### 6.3 Сообщения и маршрутизация

`shared/protocol.ts`:

- `Call = HostCall | QueueCall | { op: 'checkUpdates' } | { op: 'applyUpdates' } | { op: 'restartServices' }`.
- `ServerMessage` дополняется `{ t: 'queue'; queue: QueueSnapshot }`.
- `parseServerMessage` — shallow-валидация: `queue` должен быть объектом, `tasks` — массив. Глубокая проверка не нужна: источник — свой backend, а не AHP-хост.

`server/index.ts`:

- `case 'call'`: queue-calls маршрутизируются **до** host-calls и до `updates.isRestarting(call.hostId)`, короткой транзакцией, **без** привязки к `browser.abort.signal`. Причина: обрыв WS не должен отменять уже принятое добавление задачи; операции очереди короткие и идемпотентные по `clientRequestId`. `pickDirectory`/`sendMessage` остаются привязанными к signal как сейчас.
- Snapshot отправляется при подключении браузера и после каждого изменения состояния очереди (broadcast всем вкладкам). Если вкладок нет — состояние всё равно пишется на диск.
- Загрузка очереди до `hub.start`, запуск runner после; `runner.stop()` при shutdown: снять таймер, дождаться pending-записи, затем останавливать hub. Задачи при остановке не отменяются.
- `browser.watching` не затрагивается: очередь не создаёт браузерных подписок на каналы, это делает backend.

`src/store.ts`: `queue: QueueSnapshot` в `AppState`, case `'queue'` в `onMessage`, `call` уже типизирован общим `Call`. Никакой отдельной логики слияния: snapshot — единственный источник для UI очереди.

### 6.4 Модули будущей реализации

Кода в этой задаче нет; модули описаны как границы будущей работы.

| Файл | Ответственность | Зависимости |
| --- | --- | --- |
| `shared/queue.ts` | Типы, `isQueueCall`, константы лимитов | нет |
| `server/task-queue.ts` | Чистые переходы состояния, DAG, выбор готовых, backoff, проекция в snapshot | `shared/queue.ts` |
| `server/queue-store.ts` | Загрузка/атомарная запись, backup, corrupt-handling, сериализация | `fs` |
| `server/queue-runner.ts` | Оркестрация: старт, мониторинг, settle, blocked, cancel, recovery; работает через `TaskHostPort` | `task-queue`, `queue-store`, port |
| `server/hub.ts` | Тонкий адаптер `TaskHostPort`: создать сессию с заданным URI, старт хода, summaries, состояние каналов, watch/unwatch, cancel | SDK |
| `server/index.ts` | Маршрутизация, broadcast, жизненный цикл runner | всё выше |
| `src/queue.ts` | Клиентские типы/хелперы отображения (лейблы, сортировка, группировка) | `shared/queue.ts` |
| `src/QueueView.tsx` | Список, форма, карточка, пустые/ошибочные состояния | `store` |
| `src/store.ts`, `src/App.tsx` | Snapshot, навигация, мобильный режим | — |

`TaskHostPort` — узкая граница, чтобы `queue-runner` тестировался без SDK и без WebSocket:

```ts
interface TaskHostPort {
  summarize(hostId: string): SessionSummary[] | undefined;
  sessionState(hostId: string, sessionUri: string): SessionState | undefined;
  chatState(hostId: string, chatUri: string): ChatState | undefined;
  hostAvailable(hostId: string): boolean;
  retain(hostId: string, uri: string): void;      // watch
  release(hostId: string, uri: string): void;     // unwatch
  createSession(input: { hostId: string; sessionUri: string; provider: string; workingDirectory: string }): Promise<void>;
  startTurn(input: { hostId: string; chatUri: string; turnId: string; prompt: string; modelId?: string; modelConfig?: Record<string, unknown> }): Promise<void>;
  cancelTurn(input: { hostId: string; chatUri: string; turnId: string }): Promise<void>;
  setSessionTitle?(input: { hostId: string; sessionUri: string; title: string }): Promise<void>; // best-effort
}
```

Почему очередь не внутри `Hub`: `server/hub.ts` — 745 строк и отвечает за AHP-интеграцию. Домену очереди нужны собственные тесты без SDK и без WebSocket, а `Hub` в этой схеме — тонкий адаптер, который заменяется fake-портом. Обратная сторона — ещё один слой; он окупается тестируемостью state machine и recovery.

Одна деталь адаптера: сегодня `Hub.execute` case `createSession` сам генерирует UUID (`server/hub.ts:193`), поэтому для очереди нужен внутренний метод `createSessionWithUri(hostId, provider, workingDirectory, sessionUri)`. Браузерный `HostCall.createSession` при этом не меняется: UI продолжает получать URI от backend, а очередь передаёт свой заранее сохранённый. `ChatTurnStarted` тоже требует отдельного входа — `startTurn` с явным `turnId`, потому что `sendMessage` подставляет `randomUUID()` (`server/hub.ts:280`).

---

## 7. UX

### 7.1 Список или доска

| Критерий | Список | Доска (колонки по состояниям) |
| --- | --- | --- |
| Зависимости | Видны как бейдж «ждёт N» + detail | Нужны стрелки/линии или отдельная панель; в колонках теряются |
| Порядок | Явный, drag за ручку | Порядок внутри колонки, между колонками неоднозначен |
| Мобильный | Работает сразу | Плохо: горизонтальный скролл, мелкие зоны |
| Стоимость | Низкая | +2–3 чел.-дня на drag/дроп и раскладку |
| Плотность | Высокая: 20 задач на экране | Низкая: 6–8 карточек |
| Когда полезнее | Пакет из 5–50 задач | Много параллельных, статусная картина |

**Рекомендация: список — MVP, доска — этап 2 для desktop.** Для сценария «поставить N задач и следить» список честнее: он показывает порядок и зависимости, которые доска как раз прячет.

Wireframe списка:

```
┌ Очередь ────────────────────────────────────────── [+ Новая задача] ─┐
│ Лимиты: параллельно 2 · ждут человека 1/2            [⚙]            │
├──────────────────────────────────────────────────────────────────────┤
│ ● A  Починить тесты в parser        running   попытка 1   [открыть]  │
│ ● C  Обновить README                running   попытка 1   [открыть]  │
│ ◐ B  Переписать CLI    ждёт A       queued                [отмена]   │
│ ▲ D  Миграция схемы    подтверждение инструмента  [открыть] [отмена] │
│ ✕ E  Собрать релиз     ошибка хода, попытка 2/3   [retry] [детали]   │
└──────────────────────────────────────────────────────────────────────┘
```

### 7.2 Экраны

- **Очередь в main pane** — список задач с сортировкой по `position`, затем по `createdAt`. Бейджи: состояние, блокировка, номер попытки, «ждёт N».
- **Форма добавления** — хост, агент, модель (+ reasoning, если схема модели это позволяет), рабочая папка, prompt, `dependsOn` (multi-select из queued/нетерминальных задач), `maxAttempts`. Те же контролы, что в `NewSession` (`src/App.tsx:430`), чтобы не плодить второй UX выбора агента.
- **Карточка задачи** — состояние, причина блокировки с текстом, попытки, ссылка «открыть сессию» в панели (deep link в VS Code не обещаем; в VS Code сессия появляется сама), `changes`, действия `открыть / отменить / retry / удалить`.
- **Detail-панель** — по `queueGet`: полный prompt (до 100 KB, в `<pre>` с ограничением высоты), список попыток с ошибками, исходы.
- **Blocked banner** — в списке и в карточке: что именно ждёт, где подтверждать (`tool_confirmation` — можно в панели, `tool_result_confirmation`/`tool_authentication` — только в VS Code), кнопка «открыть сессию».
- **Пустые и ошибочные состояния** — пустая очередь с объяснением, `loadError` (файл повреждён, данные сохранены в `.corrupt-*`), `persistenceError` (изменения не сохраняются), «хост не подключён».

### 7.3 Мобильный режим

Сейчас мобильная раскладка управляется атрибутом `data-mobile-view` на корне (`src/App.tsx:66`) и CSS-правилами, которые скрывают sidebar или detail (`src/styles.css:766`). Очередь встраивается в эту же схему:

- Новый режим `queue`: sidebar и detail скрыты, список задач занимает экран.
- Открытие задачи переключает `data-mobile-view` в `detail` и ведёт в обычный `SessionView`.
- Форма — full-screen, без drag-and-drop; кнопки вместо hover-действий; `position` меняется стрелками вверх/вниз, а не перетаскиванием.
- Никакого отдельного мобильного приложения и отдельной авторизации: телефон работает через Tailscale, пока Mac и backend живы (`server/phone-access.ts`).

### 7.4 Уведомления

- **In-app:** `store.notify` (`src/store.ts:122`) на переходы, которые вкладка увидела вживую: задача завершилась, задача заблокирована, retry исчерпан.
- **Title badge:** предлагается `(N)` в `document.title` по числу задач, требующих внимания (blocked + failed).
- **Не уведомлять** на первом snapshot после загрузки/reconnect: иначе вкладка «выстрелит» историей. Нужен флаг «baseline получен» и сравнение с предыдущим snapshot.
- **Push отсутствует:** service worker, VAPID и инфраструктура — отдельное решение (+2–4 чел.-дня). Закрытая вкладка не уведомляет, но очередь продолжает работать.
- **Read-state хоста не используем:** `SessionStatus.IsRead` относится к сессиям и чатам, а не к задачам; смешивать две модели прочтения — плохая идея.

### 7.5 Пересечение с VS Code

Очередь — панельная функция, а не второй редактор automations. Сессии задачи — обычные общие сессии: их видно в VS Code, в них можно вмешаться, их можно архивировать или удалить.

| Ситуация | Поведение очереди |
| --- | --- |
| Пользователь открыл сессию задачи в VS Code | Ничего не меняется; ход идёт |
| Пользователь написал в ту же сессию | `blocked(external_turn)`, чужой ход не отменяется |
| Пользователь архивировал сессию | `blocked(session_archived)`; после восстановления — продолжение |
| Пользователь удалил сессию | `failed(session_missing)`; зависимые blocked |
| Агенту нужно подтверждение результата инструмента | `blocked(tool_result_confirmation)`; снять можно только в VS Code |
| Агенту нужна MCP-аутентификация | `blocked(tool_authentication)`; в панели действия нет |

Чего сознательно нет: создания `AutomationEntry` на задачу, расписаний, «тихого» запуска без сессии. Это другой продукт с другими гарантиями.

---

## 8. Варианты

### 8.1 A. Host automations как очередь

Идея: задача = automation на хосте, запуск = `runAutomation`, состояние — `AutomationRunState`, результат — `primarySession`.

Что даёт: durable run lifecycle на хосте, provenance `origin = automation`, работа при выключенной панели, отмена запуска.

Чего не даёт: DAG и зависимостей, лимита параллелизма, приоритетов, retry-политики, ad-hoc run без durable definition. Automation — это «запусти агента по расписанию/событию», а не «выполни пакет с зависимостями». Кроме того, в 1.1.0 automation-каналы не входят в `isSupportedChannel`/`ChannelState` (`shared/reduce.ts:25`), `HostOverview` их не знает (`shared/protocol.ts:39`), а `HostHandle.automations` — только capabilities. Чтобы панель показала очередь, пришлось бы расширять protocol/reduce/hub/store и заново строить витрину поверх чужого lifecycle.

Главный риск: очередь превращается в второй редактор automations и загрязняет каталог хоста пользователя. Плюс живое наблюдение Recon (`automationsEnabled=false`, **не проверено в этой ноде**) говорит, что фича может быть выключена.

### 8.2 B. Backend queue + обычные AHP-сессии

Идея: backend хранит intent и порядок, исполняет задачи обычными сессиями и ходами, а всё «настоящее» состояние читает у хоста.

Что даёт: DAG, глобальный `maxParallel`, retry/backoff, blocked с причиной, отмену, ссылки на артефакты, cross-host пакет в одном snapshot, durability при перезапуске backend, полное отсутствие изменений в AHP-контрактах.

Чего стоит: новый stateful-компонент (файл, recovery, гонки), ещё один слой между UI и Hub, необходимость аккуратной сверки после сбоев. Очередь работает, пока живёт backend.

### 8.3 C. Browser-local queue

Идея: очередь в localStorage, таймер в вкладке, вызовы через существующий `store.call`.

Что даёт: дешево (3–5 чел.-дней), быстро проверяет UX, не трогает backend.

Чего не даёт: durability (закрыл вкладку — очередь умерла), надёжного retry, работы с телефона при закрытой вкладке на Mac, единого snapshot для нескольких вкладок. Две вкладки — два источника истины. Для product-grade не годится; как прототип формы — допустим.

### 8.4 Сравнение

| Критерий | A. Host automations | B. Backend queue | C. Browser-local |
| --- | --- | --- | --- |
| DAG и зависимости | Нет | Да | Нет (только локальный порядок) |
| Лимит параллелизма | Нет (решает хост) | Да, глобальный | Слабый, в пределах вкладки |
| Retry/backoff | Только новый run вручную или по расписанию | Да, политика на задачу | Нет надёжного |
| Approvals/blocked | Только статус run | Да, `inputNeeded` с причиной | Да, пока вкладка жива |
| Отмена | `runCancellation` | `ChatTurnCancelled` + сверка | Да, пока вкладка жива |
| Артефакты | Run → `primarySession` | Ссылки session/chat/turn + `changes` | Ссылки в localStorage |
| Cross-host пакет | Каталог на каждом хосте отдельно | Да, один snapshot | Да, но в одной вкладке |
| Переживает закрытие вкладки | Да | Да | Нет |
| Переживает перезапуск backend | Да | Да (файл + recovery) | Нет |
| Хост — авторитет сессий | Да | Да, жёсткое разделение | Да, но нет durability |
| Дублирование с VS Code | Высокое: второй редактор automations | Низкое: обычные сессии | Низкое |
| Совместимость AHP 1.1.0 | Нужны automation-каналы, protocol, reduce, feature flag | Только session/chat | Только session/chat |
| Ориентировочная стоимость, чел.-дни | 8–12 (адаптер, без DAG) | 11–16 MVP | 3–5 прототип |
| Главный риск | Нет DAG/retry/параллелизма; загрязнение каталога хоста | Новый stateful-компонент и recovery | Не product-grade |

### 8.5 Вердикт

**Рекомендация — B.** Таблица решает не симпатия, а два критерия, которые нельзя обойти продуктовым требованием: DAG с зависимостями и лимит параллелизма. Ни A, ни C их не дают, а «прикрутить» их к A означает построить planning-слой всё равно — только поверх чужого каталога и с feature flag, который может быть выключен.

A остаётся полезной как **опциональный адаптер** позже: если понадобится запуск при выключенном Mac или интеграция с расписаниями хоста. C полезен как UX-прототип формы и списка, но не как продукт.

---

## 9. Рекомендация, этапы, оценка

### 9.1 Рекомендуемая архитектура

- Backend-модуль `task-queue` + `queue-runner` + `queue-store`, тонкий `TaskHostPort` в `Hub`.
- Файл `.local/task-queue.json` как единственное место хранения intent.
- Исполнение — обычные AHP-сессии и один `ChatTurnStarted` на попытку.
- Snapshot очереди по WS; полный prompt — только по `queueGet`.
- **Хост — авторитет сессий, чатов, ходов, approvals, changesets и usage.** Очередь — авторитет только собственного intent.

### 9.2 Этапы будущей реализации

Оценка — в человеко-днях, диапазоном, без календарных дат. Один разработчик, знакомый с кодом.

| Этап | Объём | Оценка | Выходной критерий |
| --- | --- | --- | --- |
| 0. Валидация допущений | Одноразовая сессия на живом хосте: клиентский `turnId`, `inputNeeded`-формы, title, `createSession` → чат, cancel | 0,5–1 | Записанные наблюдения; ни одно архитектурное решение не держится на непроверенном primitive |
| 1. Домен | `shared/queue.ts`, `server/task-queue.ts`: состояния, DAG, выбор готовых, backoff, проекция | 1,5–2 | Unit-тесты на переходы, циклы, лимиты; нет SDK в зависимостях |
| 2. Хранилище | `server/queue-store.ts`: atomic write, `.bak`, corrupt-handling, сериализация | 1–1,5 | Тесты на обрыв записи, битый JSON, идемпотентность `clientRequestId` |
| 3. Исполнение | `Hub`-адаптер + `queue-runner`: старт, мониторинг, settle, blocked, cancel, recovery | 3–4 | Fake-порт: happy path, timeout, rejection, cancel-гонка, recovery, `-32003` |
| 4. Контракт и UI | `protocol.ts`, `index.ts`, `store.ts`, `QueueView`, навигация, mobile, in-app notices | 3–4 | Typecheck/build; store-тест на `queue`-сообщение; ручной smoke |
| 5. Политики | DAG-UI (список зависимостей), retry/backoff в UI, settings, reorder, prune | 1–1,5 | Unit + smoke на пакете из 3 задач с зависимостью |
| 6. Hardening | restart backend/хоста, disconnect, гонки, документация, smoke | 1–2 | CI зелёный; сценарии S7/S8/S10/S11 пройдены вручную |
| **Итого MVP** |  | **11–16** | Сценарии S1–S14, кроме push и доски |
| Доска | Desktop drag-and-drop | +2–3 | Список остаётся основным; mobile не ломается |
| Push | Service worker, VAPID, инфраструктура | +2–4 | Отдельное решение владельца, не часть MVP |
| Automation-адаптер | Feature detection, raw actions, protocol | +4–6 | Нет изменений AHP-контрактов; при выключенных automations не активен |
| Подтверждение результата в панели | `ChatToolCallResultConfirmed` | +0,5–1 | `tool_result_confirmation` снимается без VS Code |
| Auto-approval | Политика + security review | +2–3 + review | Выключено по умолчанию; allowlist явный |

«Minimum demo» — 6–8 чел.-дней: один хост, список, без DAG-UI и recovery. Годится, чтобы показать идею, не годится как production: без recovery очередь врёт после первого же перезапуска.

### 9.3 Допущения оценки

- Recovery покрывает основные сценарии, а не все экзотические гонки.
- Fake-порт позволяет проверить большую часть runner'а без живого хоста.
- Нет неожиданных ограничений хоста (например, запрета на клиентский `turnId` в каком-то провайдере).
- UI переиспользует существующие контролы выбора агента/модели/папки.
- Оценка **не включает** реализацию очереди в этой задаче: здесь только документ, 1,5–2,5 чел.-дня.

### 9.4 Что исключено из оценки

- Мультихостовый failover и миграция задач между хостами.
- Вложения в prompt (файлы, изображения).
- Редактирование queued-задачи.
- Расписания и триггеры (это automation-адаптер).
- Мультипользовательский доступ и права.

---

## 10. Риски

| Риск | Вероятность / влияние | Смягчение |
| --- | --- | --- |
| Очередь становится вторым источником истины о сессиях | Средняя / высокая | Жёсткое правило владения (§4.2); живой `SessionStatus` не persisted; ревью каждого перехода «кто главный» |
| Approvals блокируют очередь | Высокая / средняя | `blocked` вне running-слота + `maxBlocked` + заметный бейдж + инструкция, где подтверждать; этап result-confirm отдельно |
| Потеря файла очереди | Низкая / средняя | Atomic write, `.bak`, `0600`, `O_NOFOLLOW`; потеря задач задокументирована как риск, не как восстановление |
| Дублирование сессий после таймаута | Средняя / средняя | Детерминированный `turnId`, `sessionUri` до создания, `-32003` как успех, сверка `turns`/`activeTurn` |
| Вмешательство человека ломает ход | Средняя / средняя | `blocked(external_turn)`, не отменять чужой ход, settle по фактическому состоянию |
| Restart хоста теряет сессии | Средняя / средняя | Recovery → `failed(session_missing)`, зависимые blocked; без failover |
| Очередь выглядит как второй VS Code automations | Средняя / низкая | Позиционирование: cross-host batch, не scheduler; automations не создаём |
| Оценка занижена | Средняя / средняя | Диапазоны, допущения, отдельные оценки расширений, «minimum demo» без recovery |
| Mobile не получает push | Высокая / низкая | Явное ограничение, in-app badge, отдельное решение |
| Corrupt-файл теряет задачи | Низкая / средняя | `.bak`, переименование corrupt, `loadError` в UI, данные не удаляются |
| Долгий ход «висит» без таймаута | Средняя / низкая | Wall-clock-лимит выключен осознанно; пользователь может отменить; лимит — будущая настройка |
| Слишком много blocked-сессий в VS Code | Средняя / средняя | `maxBlocked`; при 0 — без ограничения, это ответственность пользователя |

---

## 11. Открытые вопросы владельцу

Ни один не блокирует документ: ниже рекомендации и последствия выбора.

1. **Хранение: backend-файл или host-owned automations?** Рекомендация — backend-файл. Если очередь должна работать при выключенном Mac или переживать панель как отдельный сервис, рекомендация меняется на A, оценка +4–6 чел.-дней, и придётся расширять protocol/reduce/hub.
2. **Blocked и слот: `maxBlocked` с освобождением running-слота или удерживать слот?** Рекомендация — освобождать. Удержание проще, но один approval останавливает пакет; при удержании `maxBlocked` не нужен, а `maxParallel` фактически означает «сколько сессий вообще открыто».
3. **DAG-UI в MVP: да или сначала последовательная очередь?** Рекомендация — да, `dependsOn` + список: без зависимостей очередь — это просто пачка сессий, а граф всё равно нужен в модели. Если режем — минус ~1,5 чел.-дня из этапа 5.
4. **Approvals: только вручную или планировать auto-approval?** Рекомендация — только вручную в v1. Auto-approval — отдельный этап с security review и allowlist; «подтверждать всё» не должно быть дефолтом.
5. **Результат: только ссылки + `changes` или short excerpt ответа?** Рекомендация — ссылки. Excerpt требует политики усечения и хранения контента; можно добавить позже, если пользователь жалуется на «не видно, что получилось».
6. **Уведомления: in-app/title или отдельная задача на push?** Рекомендация — in-app. Push (+2–4) оправдан, только если сценарий «уйти от компьютера» реален.
7. **Вложения в prompt: text-only v1 или файлы?** Рекомендация — text-only. Вложения тянут лимиты, копирование файлов и вопросы приватности.
8. **Board: список v1 или доска сразу?** Рекомендация — список v1. Доска (+2–3) — после того, как станет ясно, что задач реально много и параллельно.

**Что нужно от ревьюера:** подтвердить или изменить рекомендации по пунктам 1–8. После подтверждения открывается отдельная задача на реализацию этапов 0–6; в этой ноде ничего не кодится.

---

## 12. Доказательства и проверки

### 12.1 Проверено по коду

| Утверждение | Где проверено |
| --- | --- |
| Проекция сессий и хостов | `server/hub.ts:125` (`overview`), `:664` (`hostOverview`) |
| Watch/unwatch как счётчик подписок | `server/hub.ts:147`, `:163` |
| Создание сессии с UUID внутри Hub | `server/hub.ts:192`–`:198` |
| `sendMessage` стартует ход с `turnId: randomUUID()` | `server/hub.ts:265`–`:281` |
| Подтверждение старта и таймаут 15 с | `server/hub.ts:512` (`dispatchTurnAndWait`), `:527` (`waitForAction`), `:58` (`ACTION_CONFIRMATION_MS`) |
| `cancelTurn` требует `activeTurn.id` | `server/hub.ts:293`–`:297` |
| `confirmTool` требует зеркала чата | `server/hub.ts:476` (`confirmationOption`) → `:495` (`chatState`) |
| `completeInput` диспатчит `ChatInputCompleted` | `server/hub.ts:314` |
| `toFileUri` требует абсолютный POSIX-путь | `server/hub.ts:732` |
| Guard простоя живёт в UI, не в Hub | `src/SessionView.tsx:823` |
| Сессия `creating`, когда чат уже доступен | `src/SessionView.tsx:191`–`:192` |
| `PendingResultConfirmation` не подтверждается панелью | `src/SessionView.tsx:516`–`:518` |
| Мобильная раскладка через `data-mobile-view` | `src/App.tsx:66`, `src/styles.css:766`–`:767` |
| `phaseOf` учитывает битмаску `InputNeeded` | `src/format.ts:36`; `isArchived` — `:43` |
| `store.watch` / `call` / `notify` | `src/store.ts:75`, `:95`, `:122` |
| `isSupportedChannel` не знает automation-каналов | `shared/reduce.ts:25` |
| Маршрутизация calls и `updates.isRestarting(call.hostId)` | `server/index.ts:169`, `:194`, `:206` |
| SDK 1.1.0 в зависимостях | `package.json:18` (`^1.1.0`), lockfile закрепляет 1.1.0 |
| `.local/` в `.gitignore` | `.gitignore:1` |
| Права `0600` и `O_NOFOLLOW` для локальных файлов уже используются | `scripts/start-gemini-host.ts:123` |
| CI-джоб `verify`: `npm ci`, typecheck, test, build | `.github/workflows/ci.yml` |
| Baseline 132/132 и зелёные typecheck/build на `6cbd5a5` | `memory-bank/AGENTHOS-11.md` |

### 12.2 Проверено по SDK 1.1.0

Сверено по `node_modules/@microsoft/agent-host-protocol` (версия 1.1.0) в main workspace; в worktree `node_modules` может отсутствовать.

| Утверждение | Где в SDK |
| --- | --- |
| `CreateSessionParams`: `channel`, `provider?`, `workingDirectories?`, `config?`, без initial message | `src/types/channels-session/commands.ts:42` |
| Повторное создание существующей сессии → `-32003 SessionAlreadyExists` | `src/types/channels-session/commands.ts:26`, `src/types/common/errors.ts:50` |
| `inputNeeded` host-managed, entry содержит `id` и `chat`, отвечать можно без подписки | `src/types/channels-session/state.ts:244`–`:332` |
| Kinds: `chatInput`, `toolConfirmation`, `toolClientExecution`, `toolAuthentication` | `src/types/channels-session/state.ts:302`–`:311` |
| `toolConfirmation` покрывает и `PendingConfirmation`, и `PendingResultConfirmation` | `src/types/channels-session/state.ts:351`–`:369`, `src/types/channels-chat/state.ts:1707` |
| `TurnState`: `complete`, `cancelled`, `error` | `src/types/channels-chat/state.ts:751` |
| `Turn`: `id`, `state`, `responseParts`, `usage` | `src/types/channels-chat/state.ts:781` |
| `ChatInteractivity`: `full`, `read-only`, `hidden` | `src/types/channels-chat/state.ts:425` |
| `ChatState`: `activeTurn`, `turns`, `queuedMessages`, `draft`, `interactivity` | `src/types/channels-chat/state.ts:52`–`:185` |
| `SessionMetaChanged` — server-only, `SessionTitleChanged` — client-dispatchable | `src/types/action-origin.generated.ts:502`, `:480` |
| `SessionOrigin` = только `AutomationSessionOrigin` | `src/types/channels-session/state.ts:107` (тип), `:94` (единственный вариант) |

### 12.3 Не проверено и как проверить

| Вопрос | Почему важно | Как проверить (этап 0) |
| --- | --- | --- |
| Принимает ли живой хост `ChatTurnStarted` с клиентским `turnId` при простое | Основа старта хода | Одна тестовая сессия: отправить ход, сравнить `activeTurn.id` с отправленным |
| Все ли формы `inputNeeded` приходят на живом VS Code-хосте | Источник `blocked` | Вызвать инструмент с approval, посмотреть `SessionState.inputNeeded` |
| Заполняется ли `queuedMessageId` и потребляется ли очередь сообщений при простое | Только для будущего этапа | Не критично для MVP; проверить перед использованием |
| Принимает ли хост `SessionTitleChanged` сразу после создания | Косметика | Отправить и проверить, что title изменился; отказ не ломает задачу |
| Сохраняются ли сессии при перезапуске хоста | Recovery | Перезапустить хост, проверить `overview.sessions` |
| `automationsEnabled` и capabilities на текущих хостах | Приоритет automation-адаптера | По отчёту Recon 24.11.2026 выключено; **в этой ноде не перепроверялось** |
| Каталог моделей Codex до первой сессии | Форма выбора модели | Открыть форму на хосте без сессий; если каталог пуст — разрешить ручной `modelId` |

### 12.4 Как проверялся этот документ

- Каждый `path:line` сверен чтением файла на `6cbd5a5`; символы SDK — по типам 1.1.0.
- `git status --short` до начала работы: чисто; после — только `docs/task-queue-design.md`.
- `git diff --check` — без пробельных ошибок.
- `rg -n "^## |^### "` — структура разделов на месте.
- `rg -n "авторитет|хост остаётся"` — утверждение о владении присутствует в TL;DR, §1.4, §4.2, §10.
- Проверки в worktree на `6cbd5a5`: `npm ci` (134 пакета), `npm run typecheck` — зелёный, `npm test` — 132/132, `npm run build -- --outDir /tmp/acc-queue-doc-build` — зелёный с известным предупреждением Vite о чанке > 500 kB (CI его сохраняет намеренно). Runtime-код не менялся, поэтому эти прогоны подтверждают baseline, а не поведение очереди.
- Команды проверки взяты из `package.json` и CI; `memory-bank/techContext.md:11` упоминает `npm run mock-host` и `npm run server:dev`, которых в `package.json` нет — эти команды не используются.

---

## Приложение A. Что в этой задаче не делается

- Не реализуются очередь, runner, store, UI, доска, push и automation-адаптер.
- Не меняются production-код, `package.json`/lockfile, `hosts.json`, Memory Bank, `README.md`.
- Не добавляются зависимости.
- Не обещаются сроки, deep link в VS Code, push, «полностью unattended» работа.
- `ChatPendingMessageSet` не выдаётся за проверенный primitive.
- Backend не становится вторым источником истины о сессиях: **хост остаётся авторитетом сессий.**
