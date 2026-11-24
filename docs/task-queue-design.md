# Очередь задач агентов: design spike

**Задача:** AGENTHOS-22 — «Спроектировать очередь задач агентов».
**Статус:** design proposal (не реализация). Решение о реализации принимает владелец после ревью PR.
**Срез кода:** `main` = `6cbd5a5`; ветка `AGENTHOS-22` добавляет только этот документ (production-код не меняется).
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
| S5 | Отмена queued/running | queued сразу `cancelled`; running/blocked получает `ChatTurnCancelled` только для своего хода, затем `blocked(cancel_pending)` до сверки фактического исхода с хостом; отмена работает и без открытой вкладки (§3.9) |
| S6 | Результат и артефакты | Ссылки `sessionUri`/`chatUri`/`turnId`, `changes` из summary; текст ответа не копируется |
| S7 | Перезапуск backend во время работы | Очередь загружается с диска; running-сессия присоединяется по сохранённым ссылкам; завершившаяся за простой задача фиксируется |
| S8 | Хост отключился | `blocked(host_disconnected)`, не `failed`; после reconnect — сверка; без failover на другой хост |
| S9 | Телефон | Список задач, бейдж blocked, открытие сессии, отмена/retry; push-уведомлений нет |
| S10 | Человек пишет в ту же сессию | `blocked(external_turn)`; очередь не борется с человеком и не отменяет его ход |
| S11 | Сессия удалена в VS Code | `failed(session_missing)`; зависимые — `blocked(dependency_failed)` |
| S12 | Повторная отправка формы после обрыва связи | `clientRequestId` делает добавление идемпотентным |
| S13 | Добавление задачи с циклом или несуществующей зависимостью | `queueAdd` отклоняется с понятной ошибкой; очередь не меняется |
| S14 | Пользователь удаляет задачу, от которой зависят другие | Удаление отклоняется: сначала отменить или переназначить зависимые |
| S15 | Задача A завершилась `failed`, B стоит в `blocked(dependency_failed)`; пользователь делает `queueRetry(A)`, A завершается `completed` | B автоматически возвращается в `queued` на ближайшем tick и стартует без перезапуска backend |

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
| `SessionState` | `lifecycle`, `chats: ChatSummary[]` (`channels-session/state.ts:193`), `defaultChat`, `inputNeeded: SessionInputRequest[]`, `activity`, `changesets`, `workingDirectories` | `inputNeeded` host-managed; не все виды запросов панель умеет разрешать | Подписка на сессию активной задачи; источник `blocked` |
| `ChatState` | `activeTurn`, `turns: Turn[]`, `queuedMessages`, `draft`, `changesets`, `interactivity` (проверено, `channels-chat/state.ts:52`) | Очередь сообщений чата — не очередь задач | Мониторинг хода и фиксация результата |
| `Turn` / `TurnState` | `id`, `state: 'complete' \| 'cancelled' \| 'error'`, `responseParts`, `usage` (`channels-chat/state.ts:751`, `:781`) | Нет структурированного «результата задачи» | Детерминированный settle по `turn.state` |
| `ChatOrigin` | `user`, `fork`, `sideChat`, `tool` | Не задача; fork/side — ветки контекста | Не используем как primitive задачи |
| `createSession` | `channel` (URI выбирает клиент), `provider?`, `workingDirectories?`, `config?` (`channels-session/commands.ts:53`) | Нет initial message, нет title; при существующем URI — ошибка `-32003` (`SessionAlreadyExists`) | Создание сессии с заранее известным URI |
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
- **`SessionState.inputNeeded` агрегирован по всем чатам сессии**, entry содержит `id` и `chat` (`channels-session/state.ts:318`), агрегация описана на `:434`. Отвечать по спецификации можно без подписки на чат, но текущий `Hub.confirmTool` идёт через `confirmationOption` (`server/hub.ts:476`), который вызывает `chatState` (`server/hub.ts:495`) и требует зеркала чата. Поэтому очередь не отвечает сама: она показывает блокировку и ведёт пользователя в открытую сессию.
- **`toolConfirmation` — один kind на два разных состояния.** У `SessionToolConfirmationRequest` есть `turnId` и `toolCall` (`channels-session/state.ts:363-369`); поля `request` у него нет. `request: ChatInputRequest` объявлен только у `SessionChatInputRequest` (`channels-session/state.ts:345-349`), а общая база `SessionInputRequestBase` содержит лишь `id` и `chat` (`:318-333`). Поэтому подтверждение параметров и подтверждение результата различаются по `entry.toolCall.status`: `ToolCallPendingConfirmationState` против `ToolCallPendingResultConfirmationState` (`channels-chat/state.ts:1707`, сами статусы — `ToolCallStatus`, `:1271-1284`). `entry.turnId` — ход, к которому относится подтверждение; он используется для сверки с `attempt.turnId` в §3.8, но не для классификации `kind`. Только первое состояние панель умеет подтверждать.
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
| `Hub.cancelTurn` (`server/hub.ts:293`) | Отмена running-хода | Проверяет `activeTurn.id`, но на чужой ход отвечает той же ошибкой, что и на завершившийся (`server/hub.ts:296`): владение очередь проверяет до вызова (§3.9) |
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
    modelConfig?: Record<string, JsonPrimitive>; // reasoning и прочие chatMutable-параметры, форма ModelSelection["config"]
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

`modelConfig` намеренно совпадает по форме с `ModelSelection["config"]` (`channels-root/state.ts:254-262`): `Record<string, JsonPrimitive>`, без вложенных объектов. Валидация — при `queueAdd` (только JSON-примитивы, известные ключи не проверяются: схема модели живёт на хосте) и на границе `TaskHostPort.startTurn`, где тип уже обязан быть `ModelSelection["config"]`. Иначе `Record<string, unknown>` пришлось бы сужать в рантайме без типа-доказательства.

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
               │             ├── inputNeeded ───▶ blocked ───▶ running   (запрос снят, ход попытки свой)
               │             │                       ├───────▶ blocked(external_turn) (в чате чужой ход или ввод)
               │             │                       └───────▶ cancelled (cancel без своего хода)
               │             └── Turn.state=cancelled ───────▶ cancelled
               └── сбой старта ──▶ retry_wait ──▶ starting (новая сессия)
                                      └── попытки кончились ──▶ failed

Отмена и потери:
  queued | starting | retry_wait ── cancel ──▶ cancelled          (без обращения к хосту)
  running | blocked ── cancel ──▶ blocked(cancel_pending) | cancelled
                        │  исход dispatch неизвестен → задача остаётся running (§3.9)
                        │  свой ход жив → cancelTurn
                        │  хода попытки нет и исход старта известен → сразу cancelled
                        └── Turn.state ──▶ completed | cancelled | failed
  running             ── Turn.state=error ──▶ retry_wait (есть попытки) | failed
  starting | running | blocked ── сессия исчезла ──▶ failed(session_missing)
                        (в blocked — до ожидания снимка; в starting — только после
                         createSession и watch сессии, §3.9)

Терминальные состояния: completed, failed, cancelled.

Зависимости (пересчёт на каждом tick):
  queued ── dependsOn failed/cancelled ──▶ blocked(dependency_failed|cancelled)
  blocked(dependency_failed|cancelled) ── все dependsOn снова completed ──▶ queued
  blocked(dependency_failed|cancelled) ── cancel ──▶ cancelled
```

| Из | Событие | В | Примечание |
| --- | --- | --- | --- |
| — | `queueAdd` | `queued` | Валидация target, зависимостей, лимитов |
| `queued` | зависимости `completed` + свободен running-слот (`maxParallel`, `maxBlocked`, §3.6) | `starting` | Слот резервируется **до** await; пишется `sessionUri` |
| `queued` | cancel | `cancelled` | Без обращения к хосту |
| `queued` | зависимость стала `failed`/`cancelled` | `blocked(dependency_failed \| dependency_cancelled)` | Gate пересчитывается на каждом tick (§3.5) |
| `starting` | чат получен; persist `chatUri` + `turnId` + `running` **до** dispatch | `running` | `running` = «очередь ждёт ход с этим `turnId`», а не подтверждение хоста: write-ahead сильнее, чем ожидание echo |
| `starting` | retryable-сбой, попытки есть | `retry_wait` | `error` сохраняется в попытке |
| `starting` | cancel | `cancelled` | `cancelRequestedAt`; без обращения к хосту; пустая сессия остаётся у хоста; ход не диспатчится — ветка старта перечитывает `cancelRequestedAt` после `createSession` и после появления чата (§5.2) |
| `starting` | retryable-сбой, попыток нет | `failed` | Терминальное |
| `starting` | `auth_required`, `model_unavailable`, `chat_read_only` | `failed` | Требуется человек, автоматический retry бессмыслен |
| `running` | `turn.state === 'complete'` | `completed` | `outcome` из `Turn` + `changes` |
| `running` | `turn.state === 'error'` | `retry_wait` или `failed` | По политике попыток |
| `running` | `turn.state === 'cancelled'` | `cancelled` | В т.ч. отмена человеком вне очереди; автоматического retry нет |
| `running` | `inputNeeded` по чату попытки | `blocked` | Kind определяется по entry (§3.8): сначала «в чате чужой `activeTurn` или непустые `queuedMessages`» → `external_turn`, потом классификация запроса; running-слот освобождается |
| `running` | `ChatTurnStarted` отклонён хостом до принятия (`turn_rejected`) | `retry_wait` или `failed` | Тот же ряд, что у `starting`: `running` записан write-ahead, поэтому отказ приходит уже в `running`, а хода в `ChatState` нет |
| `running` | подтверждение старта не пришло за 15 с (`start_timeout`) | `running` либо `retry_wait` | Перечитать чат: `activeTurn.id === attempt.turnId` → продолжаем `running`; ход в `turns` → settle по `Turn.state`; иначе хода нет → `retry_wait` (при `cancelRequestedAt` — `cancelled`). Только истечение этих 15 с при доступном `ChatState` делает отсутствие хода доказательством (§3.9) |
| `running`, `blocked` (включая `cancel_pending`) | сессия подтверждённо исчезла при подключённом хосте (§3.9 «Потеря видимости») | `failed(session_missing)` | Зависимые → `blocked(dependency_failed)`; lease снимается в `finally` закрытия попытки (§5.2 п.7) |
| `running`, `blocked` | cancel | `running` (окно dispatch→эхо) → `blocked(cancel_pending)` → `cancelled` | `cancelTurn` только при `activeTurn.id === attempt.turnId`; пока исход dispatch неизвестен, задача не терминальна и остаётся `running` (§3.9); без своего хода и с известным исходом старта — сразу `cancelled`; lease сохраняется (§3.9) |
| `blocked` | `inputNeeded` по чату попытки исчез | `running`, `blocked(external_turn)` или терминальное | Пересчёт целиком по `ChatState`, в том же порядке, что §3.8 шаг 3: ход попытки в `turns` → settle по `Turn.state`; иначе чужой `activeTurn` или непустые `queuedMessages` → `blocked(external_turn)`; иначе свой `activeTurn` → `running`; иначе хода нет → `retry_wait` (§4.4) |
| `blocked` | host disconnected | `blocked(host_disconnected)` | Причина блокировки меняется, слот не занимается |
| `blocked(dependency_*)` | все `dependsOn` снова `completed` (retry зависимости завершился) | `queued` | Пересчёт на каждом tick, без рестарта backend; затем обычная проверка готовности (S15) |
| `blocked(cancel_pending)` | `attempt.turnId` в `turns` | `completed` / `cancelled` / `failed` | Исход по фактическому `Turn.state` (§3.9) |
| `retry_wait` | backoff истёк | `starting` | Новая попытка, новая сессия |
| любой нетерминальный | host reconnect | сверка | Состояние пересчитывается с хоста, а не «додумывается» |

Терминальные состояния: `completed`, `failed`, `cancelled`. Из них только ручные `queueRetry` (для `failed`/`cancelled`) и `queueRemove`.

### 3.5 Зависимости

- `dependsOn` ссылается только на задачи той же очереди. Цикл, self-dependency и несуществующий id отклоняются при `queueAdd`; другого способа изменить граф в v1 нет (§6.2).
- Задача готова, когда **все** зависимости в `completed`. `failed` или `cancelled` зависимость не запускает задачу, а переводит её в `blocked(dependency_failed | dependency_cancelled)` — без каскадной отмены и без автоматического «проброса» ошибки. Владелец решает: retry зависимости или отмена зависимой задачи; правки графа в v1 нет (§6.2).
- Gate пересчитывается **на каждом tick** для всех нетерминальных задач, а не только при старте backend: `queued` → `blocked(dependency_failed | dependency_cancelled)`, если хотя бы одна зависимость стала `failed`/`cancelled`; `blocked(dependency_failed | dependency_cancelled)` → `queued`, когда все `dependsOn` снова `completed` (например, после `queueRetry` упавшей зависимости). Причина блокировки обновляется на месте, `position` сохраняется. Без этого правила зависимая задача навсегда осталась бы в `blocked` с устаревшей причиной (сценарий S15).
- Если зависимость после retry снова `queued`/`running`, задача остаётся `blocked(dependency_failed | dependency_cancelled)`: причина не сбрасывается «на всякий случай», иначе UI показывал бы готовность раньше времени. Текст причины в UI строится из текущего состояния зависимости («ждёт retry A»), а не только из `blocked.kind`.
- Удаление задачи, от которой зависят другие, отклоняется. Сначала зависимые нужно отменить (в v1 «переназначить» = удалить и добавить заново с новым `dependsOn`). Это защищает от «висячих» ссылок в графе.
- `position` упорядочивает готовые задачи между собой. При равном `position` — по `createdAt`.
- Глубина графа и число задач ограничены: 200 задач на очередь достаточно для панели и держит snapshot маленьким. DAG без циклов, значит глубина ≤ 200 по построению.

### 3.6 Параллелизм

- `settings.maxParallel` — 1–8, default 2. Считает только задачи в `starting | running`.
- `settings.maxBlocked` — 0–8, default 2, где 0 означает «без ограничения». Считает только задачи в `blocked`, у которых **есть живая сессия и ожидается действие человека**: `tool_confirmation`, `tool_result_confirmation`, `chat_input`, `tool_authentication`, `external_turn`, `session_archived`, `cancel_pending`.
- Задача стартует, только если `running < maxParallel` **и** (`maxBlocked === 0` или `humanBlocked < maxBlocked`). Иначе она остаётся `queued`; уже запущенные задачи продолжают работать. Проверка именно такая, а не `humanBlocked < maxBlocked`, иначе `maxBlocked = 0` («без ограничения») означал бы `0 < 0` и навсегда останавливал очередь.
- `blocked` не держит running-слот. Иначе одно подтверждение инструмента останавливает весь пакет: слот занят, новая независимая задача не стартует, а человек может уйти на час.
- Следствие, которое принимается осознанно: у `blocked(chat_input | tool_confirmation | tool_result_confirmation)` и `blocked(cancel_pending)` ход попытки ещё жив (paused или running); у `blocked(external_turn)` он может быть жив, если стартовал до чужого ввода. Такой ход идёт параллельно, но слот не занимает, поэтому фактическое число одновременных ходов может кратковременно превысить `maxParallel`. `maxParallel` ограничивает число стартов, которые очередь инициирует, а не число живых ходов на хосте в любой момент. Альтернатива — держать слот до терминального `Turn.state` — возвращает проблему «одно подтверждение останавливает пакет». `blocked(cancel_pending)` считается в `maxBlocked` по той же логике: первые 30 с очередь повторяет `cancelTurn` сама, но ход всё ещё жив, а без подтверждения хоста нужен человек (§3.9).
- `blocked(host_disconnected | host_unknown | dependency_failed | dependency_cancelled)` не занимает ни running-слот, ни `maxBlocked`: живой сессии под контролем очереди нет, ограничивать нечего.
- `retry_wait` не занимает ни того, ни другого: попытка уже завершилась, новая ещё не началась.
- Лимиты глобальные, без per-host и per-directory. Причина: одна панель, один пользователь; per-host лимиты добавляют настройку без ясной пользы. Предупреждение о двух задачах в одной рабочей папке показывается в UI, но не блокирует — параллельная работа в одной папке иногда осмысленна и всегда рискованна.

### 3.7 Retry

- Автоматический retry только для `turn_error` (`TurnState.Error`) и retryable-сбоев старта: `start_timeout`, `turn_rejected`, `creation_error`.
- Backoff: 30 с → 2 мин → 10 мин, дальше cap 10 мин. Значения фиксированные в v1; настройка — позже, если появится запрос.
- Новая попытка — новая сессия и новый `turnId`. Старая сессия не удаляется и не архивируется очередью: это артефакт со своим исходом.
- `maxAttempts` 1–3, default 1: по умолчанию задача не ретраится, потому что агент мог уже сделать половину работы и повтор опасен. Автоматический retry — осознанный выбор пользователя.
- Ручной `queueRetry` разрешён сверх `maxAttempts`: человек видит контекст и решает сам.
- Не ретраятся автоматически: `cancelled` (в т.ч. отмена человеком), `session_missing`, `auth_required`, `model_unavailable`, `chat_read_only`. Для них нужен человек или изменение target; в v1 «сменить target» = удалить задачу и добавить заново, потому что `queueUpdateTask` нет (§6.2).
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

Алгоритм на каждом tick для задачи в `starting | running | blocked` (для `blocked` шаги 1–4 уточняют причину, шаг 5 — выход):

0. Проверить архив: `SessionStatus.IsArchived` в `SessionState.status` (`channels-session/state.ts:71`), а при `attempt.chatUri` — ещё и в `ChatState.status` (`channels-chat/state.ts:59`). Отдельного источника не нужно: бит приходит и в `SessionSummary.status` (`channels-session/state.ts:128`, §2.1) без lease, и в `SessionState`, который шаг 1 всё равно читает под lease. Пока `attempt` ещё без lease (между `persist(starting)` и `watch(session)`), шаг пропускается: читать нечего, а следующий tick придёт уже после подписки. Архивированная сессия или архивный чат попытки → `blocked(session_archived)` без разбора `inputNeeded`, running-слот освобождается. Тот же бит панель проверяет перед правкой чата (`server/hub.ts:469`), поэтому правило совпадает с поведением хоста. Для `blocked` проверка идёт перед сверкой §3.9 и пересчётом шага 5: архив — причина блокировки, а не следствие.
1. Взять `SessionState.inputNeeded` (если `attempt.chatUri` ещё нет — пропустить шаг).
2. Оставить только entries с `entry.chat === attempt.chatUri`. Причина: `inputNeeded` агрегирован по всем чатам сессии (`channels-session/state.ts:434`), а approval в боковом чате человека не должен блокировать задачу.
3. Сначала — исход и владение ходом. Порядок один и тот же здесь, в §3.4 и в §5.4:
   - `chat.turns` уже содержит `attempt.turnId` → settle по `Turn.state` (§3.4): исход известен, и чужая активность в чате его не переписывает;
   - иначе — `blocked(external_turn)` **без** разбора `inputNeeded` (§5.4) в двух случаях, и оба означают «в чате попытки есть чужое действие»: `activeTurn` с `id !== attempt.turnId` (чужой ход) либо непустые `queuedMessages` (человек поставил в этот чат свой ввод — `ChatPendingMessageSet`, `queuedMessageId`, §2.2; очередь pending-сообщений не создаёт, она отправляет `ChatTurnStarted`, поэтому непустой `queuedMessages` всегда чужой). Это правило действует и при живом ходе попытки (`activeTurn.id === attempt.turnId`): свой ход не отменяется и остаётся под сверкой, но задача переходит в `blocked(external_turn)` — чужой ввод в её чате это решение человека, а не сбой;
   - иначе — классифицировать по `entry.kind`; для `toolConfirmation` статус читается из `entry.toolCall.status` (`SessionToolConfirmationRequest` не имеет поля `request` — оно есть только у `chatInput`, см. §2.1):

| `inputNeeded[].kind` | Условие | `QueueBlockedKind` | Панель умеет снять? |
| --- | --- | --- | --- |
| `chatInput` | — | `chat_input` | Да, `completeInput` (`server/hub.ts:314`) |
| `toolConfirmation` | `entry.toolCall.status === 'pending-confirmation'` | `tool_confirmation` | Да, `confirmTool` (`server/hub.ts:305`) |
| `toolConfirmation` | `entry.toolCall.status === 'pending-result-confirmation'` | `tool_result_confirmation` | **Нет** (`src/SessionView.tsx:516`) |
| `toolAuthentication` | — | `tool_authentication` | **Нет** (в панели не реализовано) |
| `toolClientExecution` | — | игнорируется | Не human-block |

У `toolConfirmation` и `toolAuthentication` есть `entry.turnId` (`channels-session/state.ts:363-369`, `:425-431`); у `chatInput` его нет — там только `request: ChatInputRequest` (`:345-349`), а `ChatInputRequest` `turnId` не содержит (`channels-chat/state.ts:641-652`). Если `entry.turnId` присутствует и не равен `attempt.turnId`, запрос не атрибутирован задаче: причина — `external_turn`, а не `tool_confirmation`/`tool_authentication`, потому что снимать его «в панели вместо VS Code» бессмысленно (§5.4). Это правило опирается на допущение, что хост сохраняет клиентский `turnId`; допущение проверяется на этапе 0 (§12.3, `entry.turnId` у `toolConfirmation`), и **до** проверки отсутствие `entry.turnId` трактуется как собственный запрос, а не как чужой ход: иначе при переназначении id задача объявила бы чужой собственное подтверждение.

4. Перевести задачу в `blocked` с причиной и временем. Освободить running-слот.
5. Когда entry исчез — на следующем tick пересчитать состояние **целиком** по `ChatState`, в том же порядке, что шаг 3: ход попытки в `turns` → settle по `Turn.state`; иначе чужой `activeTurn` или непустые `queuedMessages` → `blocked(external_turn)`; иначе свой `activeTurn` → `running`; иначе хода нет — ветка §4.4 «dispatch потерялся» (`retry_wait` с проверкой `turnId`, §5.4). Просто «entry исчез → running» недостаточно: между tick'ами ход задачи мог завершиться, а в чате мог появиться ход человека. Settle идёт первым намеренно: если ход попытки уже завершился, его результат не зависит от того, что человек делает в чате дальше, и ждать конца чужого хода значило бы держать задачу в `blocked(external_turn)` и занимать `maxBlocked` без причины.

Что происходит дальше: пользователь открывает задачу, попадает в обычную сессию (панель или VS Code), подтверждает инструмент или отвечает на вопрос. Очередь видит, что `inputNeeded` опустел, и продолжает. Никакого auto-approval в v1 нет: политика «подтверждать всё, что просит агент» — это отдельное продуктовое и security-решение, а не деталь очереди.

Дополнительные причины блокировки, не связанные с `inputNeeded`:

| Причина | Когда | Кто снимает |
| --- | --- | --- |
| `external_turn` | В чате попытки уже есть чужой активный ход или `queuedMessages` (чужой ввод) | Человек завершает свой ход; очередь не отменяет чужой ход |
| `session_archived` | `SessionStatus.IsArchived` в `SessionState.status` или `ChatState.status` (`SessionSummary.status` даёт тот же бит без lease; шаг 0) | Человек восстанавливает сессию: бит снят → пересчёт по шагу 5 |
| `cancel_pending` | Отмена запрошена, `cancelTurn` отправлен, но ход попытки всё ещё жив и хост не подтвердил отмену за 30 с | Сверка §3.9 ставит исход по `Turn.state`; после 30 с очередь перестаёт повторять `cancelTurn`, ход останавливает человек в панели или VS Code |
| `host_disconnected` | Хост отключён | Reconnect |
| `host_unknown` | Хост исчез из конфигурации | Правка `hosts.json` и перезапуск backend |
| `dependency_failed` / `dependency_cancelled` | Зависимость завершилась неуспешно | Снимается автоматически, когда все `dependsOn` снова `completed` (retry зависимости, §3.5); иначе отмена или удаление задачи |

Отличие от плана (продуктовое решение, вынесено владельцу — §11, вопрос 9): в плане `session_missing` и `model_unavailable` перечислены среди blocked-причин. Здесь они — терминальные `failed`, потому что это не «ждём человека с живой сессией», а «эта попытка больше не может продолжаться». `session_missing` ставится только при подключённом хосте и подтверждённом отсутствии сессии (событие `sessionRemoved` через `TaskHostPort.onSessionRemoved`, ответ `checkSession` → `missing` либо отсутствие в `overview.sessions` дольше 5 с — подробно в §3.9 «Потеря видимости»). Пока хост недоступен, это `blocked(host_disconnected)`: отсутствие данных — не доказательство отсутствия сессии. Если владелец выберет blocked-вариант, меняются только значения `QueueTaskState`/`QueueBlockedKind` и переходы; архитектура и хранение не затрагиваются.

### 3.9 Отмена

Отмена — процесс, а не флаг (§3.11 п.9): `queueCancel` фиксирует намерение, а терминальное состояние ставит только сверка с хостом. Порядок шагов буквальный, и он же задан в §5.2 п.7 — если эти два места разойдутся, отмена перестаёт работать:

1. **Persist.** `cancelRequestedAt` пишется в файл до любого обращения к хосту (§4.4). Состояние задачи при этом не меняется.
2. **Диагноз владения ходом** — по `ChatState` чата попытки (`TaskHostPort.chatState`): `chat.activeTurn.id === attempt.turnId` — свой ход жив; `chat.turns` содержит `attempt.turnId` — свой ход уже завершился; ни там, ни там — хода попытки нет. Третий исход — доказательство только при известном исходе dispatch: пока эхо не пришло, отказ хоста не получен и 15 с подтверждения не истекли, `ChatState` законно не содержит хода (см. «Окно dispatch→эхо» ниже).
3. **Решение** — по состоянию задачи и диагнозу (таблица ниже). `cancelTurn` вызывается **только** при своём живом ходе. `Hub.cancelTurn` сверяет `activeTurn.id` с переданным `turnId`, но на чужой ход отвечает той же ошибкой «Этот ход уже завершён», что и на завершившийся (`server/hub.ts:293-296`), поэтому по ошибке владение не определить — его нужно проверить до вызова. Чужой `activeTurn` не отменяется никогда (§5.4).
4. **Lease не снимается при запросе отмены.** Подписки нужны шагам 2–3 и сверке: `Hub.unwatch` при счётчике 1 удаляет канал из зеркала (`server/hub.ts:163-175`, `server/mirror.ts:45-47`), после этого `chatState` бросает «Чат не открыт или его состояние ещё не получено» (`server/hub.ts:495-499`), а `cancelTurn` первым делом читает `ChatState` (`server/hub.ts:294`). Отмена «вслепую» в фоне, без браузерных подписчиков, не отправила бы `ChatTurnCancelled` вообще. Повторный `retain` не делается, пока lease жив; если его нет (recovery после рестарта backend), он сначала восстанавливается — §4.4.
5. **Сверка** — на каждом следующем tick'е, строго по `attempt.turnId`. Никаких выводов по чужому ходу.

| Состояние на момент `queueCancel` | Диагноз по `ChatState` | Действие | Куда переходит |
| --- | --- | --- | --- |
| `queued` | чата ещё нет | без хоста | `cancelled` |
| `starting` | хода нет по построению: `running` пишется до dispatch (§4.4) | без хоста; если `createSession` уже прошёл, пустая сессия остаётся у хоста; ход не диспатчится (§5.2) | `cancelled` |
| `retry_wait` | попытка закрыта, lease нет | без хоста | `cancelled` |
| `running`, `blocked` без `attempt.chatUri` | диспатча не было | без хоста | `cancelled` |
| `running` в окне dispatch→эхо: эхо не пришло, отказ хоста не получен, 15 с не истекли | `attempt.turnId` ещё не может быть в `ChatState`; отсутствие хода не доказательство | `cancelTurn` не вызывается (владения нет), lease сохраняется, намерение уже в файле | остаётся `running` до подтверждения, отказа или таймаута; сверка на следующем tick'е |
| `running`, `blocked`, `ChatState` недоступен | видимости нет | сначала проверить сессию, затем «Потеря видимости» | `failed(session_missing)`, `blocked(host_*)` либо без изменений |
| `running`, `blocked`, свой ход жив | `activeTurn.id === attempt.turnId` | `cancelTurn(attempt.turnId)`, lease сохраняется | `blocked(cancel_pending)` |
| `running`, `blocked`, свой ход завершился | `attempt.turnId` в `turns` | settle по `Turn.state` | `completed` / `cancelled` / `failed` |
| `running`, `blocked`, хода попытки нет, исход старта известен (эхо, отказ или 15 с) | ни `activeTurn`, ни `turns` | чужой ход не трогаем, `cancelTurn` не вызывается | `cancelled` |

Вид блокировки не выбирает ветку отмены — ветку выбирает диагноз `ChatState` из таблицы, и порядок один для `running` и любого `blocked`. `blocked(dependency_*)` попадает в строку «хода попытки нет»: чата попытки уже нет или ход закрыт, отмена сразу терминальная, без обращения к хосту (§3.5). `blocked(external_turn)` — не исключение. Чужой `activeTurn` (`id !== attempt.turnId`) не отменяется никогда, но это не повод оставить жить свой ход: свой ход жив → `cancelTurn(attempt.turnId)` → `blocked(cancel_pending)` → сверка; свой ход уже в `turns` → settle по фактическому `Turn.state`, и `completed` не переписывается на `cancelled` (иначе теряется `outcome`, §3.10); сразу `cancelled` — только когда `attempt.turnId` нет ни в `activeTurn`, ни в `turns` **и** исход старта известен (ниже), и найденный чужой `activeTurn` при этом остаётся жить. «Чужой ход не отменяем» относится ровно к `activeTurn` с чужим id.

**Окно dispatch→эхо.** `dispatchTurnAndWait` только отправляет action и ждёт эхо (`server/hub.ts:512-516`, `:527-541`); эхо применяется к зеркалу в `consumeEvents` (`:621`), а `chatState` читает зеркало (`:495-499`). Значит между `persist(running)`/dispatch и применением эха `ChatState` законно не содержит хода: отсутствие `attempt.turnId` в этом окне — не доказательство «хода нет». Поэтому окно не создаёт нового состояния и не отправляет `cancelTurn`: задача остаётся `running` (`running` = «ждём ход с этим `turnId`», §3.2) с persisted `cancelRequestedAt` и живым lease, а диагноз повторяется на каждом tick'е. Терминальный исход ставится, только когда исход старта известен:

- ход появился в `activeTurn` → владение есть → `cancelTurn` → `blocked(cancel_pending)`;
- ход сразу оказался в `turns` (успел завершиться) → settle по `Turn.state`, `completed` не переписывается;
- хост отклонил старт (`turn_rejected`) или истекли 15 с подтверждения, а `ChatState` прочитан и хода в нём нет → хода не было никогда: попытка закрывается, и при `cancelRequestedAt` задача сразу `cancelled` с `error.kind = 'turn_rejected' | 'start_timeout'` (инвариант 7 требует `outcome` или `error`); без `cancelRequestedAt` те же исходы дали бы `retry_wait`/`failed` по §3.4. Если снимок чата недоступен, это не «хода нет», а ветка «`ChatState` недоступен» из таблицы выше.

`blocked(cancel_pending)` означает «`cancelTurn` отправлен», и до появления хода задача в него не переходит — иначе состояние врало бы о том, чего не было. Отдельного поля «эхо получено» не нужно: ход либо виден в `ChatState`, либо исход старта уже зафиксирован отказом или таймаутом. После рестарта backend правило работает на свежем снимке: `ChatState` запрашивается заново под восстановленным lease (§4.4), живой ход в нём виден, а его отсутствие при `cancelRequestedAt` даёт `cancelled`.

Рестарт backend посередине отмены не начинает её заново: `cancelRequestedAt` уже в файле, а состояние могло остаться прежним (`running`/`blocked`), поэтому recovery сначала восстанавливает lease, затем продолжает с шага 2 — диагноз по `ChatState`, затем `cancelTurn` или терминальный исход (§4.4).

**Сверка `blocked(cancel_pending)`.** Читаем `ChatState` чата попытки; если его нет — сначала проверка сессии (§ «Потеря видимости»), а не ожидание: удалённая сессия даёт `failed(session_missing)`, а не вечный `cancel_pending`.

- `attempt.turnId` есть в `turns` → `complete` даёт `completed` (не врём про отмену), `cancelled` — `cancelled`, `error` — `failed`. Порядок `turns` — хвостовое окно, новые ходы в конце (так его читает панель: `src/SessionView.tsx:284`, `server/hub.ts:417`); только что завершённый ход попадает в окно, поэтому его отсутствие — достаточный признак «хода нет», а не повод уходить в `retry_wait`.
- свой ход всё ещё в `activeTurn` → повторяем `cancelTurn` не чаще раза в 2 с; пока хост не подтвердил, задача остаётся в `blocked(cancel_pending)`, а после 30 с автоматические повторы прекращаются и причину видит человек (остановить ход в панели или VS Code) — после остановки сверка поставит фактический исход.
- хода нет ни в `activeTurn`, ни в `turns` → `cancelled`: ход не материализовался (ср. диагноз «dispatch потерялся» в §4.4). Окно dispatch→эхо этой ветки не касается: в `cancel_pending` задача попала только после того, как `activeTurn.id === attempt.turnId` был подтверждён, то есть приём хода уже доказан.

**Ожидаемая и неожидаемая ошибка `cancelTurn`.** No-op только для отказа «Этот ход уже завершён»: это значит, что ход завершился между чтением `ChatState` и вызовом, и следующий tick зафиксирует `Turn.state`. Все остальные отказы (`Неизвестный хост`, «Чат не открыт или его состояние ещё не получено», транспортные) — не no-op: хост отключён → `blocked(host_disconnected)`, хост исчез из конфигурации → `blocked(host_unknown)`, причина видна пользователю, а `cancelTurn` повторяется на следующем tick'е, потому что `cancelRequestedAt` сохранён. Глушить их нельзя: именно так ход остаётся жить, выпав из учёта очереди.

**Потеря видимости: сначала «сессия есть?», потом «снимок будет?».** Если `chatState === undefined` при подключённом хосте — это ещё не отказ, но и не повод ждать вслепую: зеркало пустеет по двум разным причинам, и они требуют разного.

1. **Сессия подтверждённо отсутствует.** Критериев три, и все они проверяются при подключённом хосте (чтение каналов — под живым lease, критерий по `summarize` lease не требует): пришло событие `sessionRemoved` через `TaskHostPort.onSessionRemoved` (`Hub` пересылает событие хоста, `server/hub.ts:653`); либо `TaskHostPort.checkSession` ответил `missing` — хост вернул `NotFound`/`-32001` (`AhpErrorCodes.SessionNotFound`, `src/types/common/errors.ts:46`), и адаптер достаёт этот код из `channelError` канала после перезапроса снимка (§6.4); либо сессия отсутствует в `summarize`/`overview.sessions` дольше 5 с после того, как наблюдалась в этой попытке. Тогда задача из любого нетерминального состояния, где попытка уже имеет чат, — `running`, `blocked(tool_confirmation | tool_result_confirmation | chat_input | tool_authentication | external_turn | session_archived)` и `blocked(cancel_pending)` — переходит в `failed(session_missing)`, зависимые — в `blocked(dependency_failed)`, lease снимается в `finally` закрытия попытки (§5.2 п.7). Ждать здесь нельзя: `Hub.removeSession` сбрасывает зеркало сессии и её чатов и записывает `channelErrors` «Сессия удалена на хосте», а снимки перезапрашиваются только по событию `connected` (`server/hub.ts:643-652`, `:572-588`). «Дождаться следующего tick'а» для удалённой сессии означало бы ждать вечно: `cancelTurn` и сверка упирались бы в «Чат не открыт…» (`:495-499`), а задача висела бы в `blocked(cancel_pending)` с lease до рестарта backend, хотя `S11` (§1) и §5.5 обещают `failed(session_missing)`.
2. **Сессия есть, снимок потерян временно** (реконнект, рестарт хоста, гонка подписки). Задача ждёт следующий tick: lease остаётся, повторный `retain` не делается — иначе счётчик подписок течёт. Признак — сессия видна в `summarize`/`sessionState`, а канал отвечает ошибкой загрузки, не удаления. Оговорка одна: «повторный» относится к живому lease. Если lease ещё не взят — backend только что перезапустился, — он сначала восстанавливается и лишь затем проверяется сессия (§4.4); иначе проверка не прочитает ничего (см. «Предусловие» ниже).

**Предусловие: сначала lease, потом чтение.** `SessionState`/`ChatState` читаются из зеркала, а зеркало наполняется только подпиской: `Hub.watch` — единственный путь `mirror.track` + `load` для сессии и чата (`server/hub.ts:147-160`), `mirror.state` без `track` возвращает `undefined` (`server/mirror.ts:38-51`). Проверка сессии без подписки не вернёт `missing`, а бросит «Сессия не открыта» (`server/hub.ts:209`) — это нарушение предусловия, а не `unavailable`, и трактовать его как признак исчезновения нельзя. Поэтому правило одно: подписка → чтение; lease-free источник ровно один — `SessionSummary`/`overview.sessions` (`Hub.overview` собирает его из `aggregatedSessions`, `server/hub.ts:128`), и он же даёт бит архива и признак «сессии нет в каталоге» (§3.11 п.14).

Проверка идёт **до** «ждать следующий tick» и при каждом заходе в сверку: в обычном tick'е, в `queueCancel` и в recovery (§4.4). Это единственный способ отличить «снимок ещё не пришёл» от «сессии больше нет», не заводя второго списка сессий: очередь не решает, что сессия исчезла, — она спрашивает хост (`checkSession`/`summarize`) и делает вывод только по его ответу, а хост остаётся авторитетом.

Если хост отключён — `blocked(host_disconnected)`: отсутствие данных не доказательство отсутствия сессии. Хост исчез из конфигурации — `blocked(host_unknown)`. `session_missing` без подключённого хоста не выводится никогда.

**Lease: где он есть, а где его нет.** Lease — это подписки очереди на `sessionUri` и `chatUri` попытки, которые она берёт в §5.2 пп.2–3. Таблица описывает устойчивое состояние живого backend; после его рестарта lease восстанавливается **до** первой проверки сессии или чтения `ChatState` (§4.4), иначе строки «есть» были бы ложью.

| Состояние | Lease |
| --- | --- |
| `queued`, `retry_wait`, терминальные | нет |
| `starting` после `Hub.watch` сессии (§5.2 п.2), `running` | есть |
| `blocked(chat_input \| tool_confirmation \| tool_result_confirmation \| tool_authentication \| external_turn \| session_archived \| cancel_pending)` | есть: сверка §3.8 читает `ChatState` |
| `blocked(host_disconnected)` | есть: счётчик дожидается реконнекта, состояние перезапрашивается (§5.5) |
| `blocked(host_unknown)` | нет: подписку на хост, которого нет в конфигурации, создать нельзя; она берётся заново, когда хост вернулся, — до любой сверки |

Снимается lease ровно в двух местах: в `finally` закрытия попытки — терминальный переход или `retry_wait` (§5.2 п.7) — и при переходе в `blocked(host_unknown)`. `blocked(cancel_pending)` нетерминален, поэтому lease сохраняет: §5.2 п.7 и этот раздел описывают один и тот же порядок `persist → cancelTurn → сверка → release`.

**Пример (S5 в фоновом режиме).** Задача A стоит в `blocked(tool_confirmation)`, браузерных вкладок нет — единственный, кто держит lease, это сама очередь. `queueCancel`: persist `cancelRequestedAt`; `ChatState` из зеркала очереди читается, потому что lease не снят; `activeTurn.id === attempt.turnId` → `cancelTurn`, задача в `blocked(cancel_pending)`; хост применяет `ChatTurnCancelled`, ход попадает в `turns` со `state = 'cancelled'`, следующий tick ставит `cancelled` и уже затем снимает lease. Если хост успел завершить ход сам, задача станет `completed` по фактическому `Turn.state`, а не «отменённой». Открытая вкладка браузера на результат не влияет: `Hub.watch` считает подписки, и подписка очереди живёт независимо от UI.

Отмена не удаляет сессию: пользователь может открыть её и посмотреть, что успел сделать агент.

### 3.10 Артефакты и результат

Задача хранит ссылки и снимок исхода:

- `attempts[].sessionUri`, `chatUri`, `turnId` — адреса, по которым всё открывается.
- `outcome.turnState` — `Turn.state` нужного хода из `ChatState.turns`. Пока ход активен, исхода нет: задача остаётся `running` или `blocked(cancel_pending)`.
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
11. Нет `cancelTurn` без проверки владения: вызов только при `activeTurn.id === attempt.turnId` (§3.9).
12. Нет нетерминальной задачи с живым ходом попытки без lease: исключение одно — `blocked(host_unknown)`, где подписку создать нельзя (§3.9).
13. Нет ожидания снимка без проверки сессии: подтверждённое отсутствие сессии — всегда `failed(session_missing)` из любого нетерминального статуса, где попытка уже имеет чат, а не `blocked` и не «ждём следующий tick» (§3.9 «Потеря видимости»). Для `starting` проверка делается только после `createSession` и `watch` сессии (§4.4).
14. Нет чтения `SessionState`/`ChatState` и проверки сессии без живого lease: подписка берётся первой, чтение — вторым (§3.9 «Предусловие»). Lease-free источник только один — `SessionSummary`/`overview.sessions`; «Сессия не открыта» — нарушение предусловия, а не признак удаления.

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
- **Version mismatch:** `version !== 1` (отсутствует, строка, будущая версия) — это не corrupt JSON, а несовместимый формат. Файл не перезаписывается и не переименовывается: очередь стартует пустой в памяти, `loadError` объясняет, что версия файла не поддерживается, а запись блокируется до ручного решения. Молча перезаписать файл другой версии нельзя — это потеря задач. Пока запись заблокирована, **мутирующие calls отклоняются** (`queueAdd`, `queueRetry`, `queueMove`, `queueUpdateSettings`, `queueCancel`, `queueRemove`) с текстом «запись очереди заблокирована»: принять задачу и потерять её при рестарте хуже, чем отказать. Это отличается от обычной ошибки записи выше, где работа в памяти разрешена и видна через `persistenceError`.
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
   - проверить, известен ли `hostId` и подключён ли хост; если нет — `blocked(host_disconnected | host_unknown)`, подписки не берутся;
   - **восстановить lease до любого чтения**: для `running` и `blocked`, у которых попытка уже имеет `sessionUri` (включая `blocked(cancel_pending)`), — `retain(sessionUri)`, при наличии `chatUri` — `retain(chatUri)`; для `starting` — сразу после `createSession` (ниже); у `blocked(dependency_*)` попытки нет, lease не нужен. Без подписки зеркало пусто (`server/mirror.ts:38-51`), а проверка сессии без `watchCounts` бросает «Сессия не открыта» (`server/hub.ts:209`): чтение до `retain` — не ответ хоста, а нарушенное предусловие (§3.11 п.14). `Hub.watch` при первом подписчике сам делает `mirror.track` + `load` (`server/hub.ts:147-160`);
   - проверить сессию — теперь под восстановленным lease: для тех же `running`/`blocked`, где попытка уже стартовала, подтверждённое отсутствие (§3.9 «Потеря видимости») сразу даёт `failed(session_missing)`, зависимые → `blocked(dependency_failed)`, lease снимается в `finally` (§5.2 п.7). Проверка идёт до любых ожиданий снимка: у удалённой сессии снимка не будет. Для `starting` она делается после `createSession` и `watch` (ниже), иначе падение backend между записью `sessionUri` и вызовом выглядело бы как удаление;
   - для `starting`: выполнить `createSession` с сохранённым `sessionUri`. `-32003 SessionAlreadyExists` (`channels-session/commands.ts:26`) — успех: сессия уже создана до падения backend. **Сразу после ответа** (в том числе `-32003`) — `retain(sessionUri)` и ожидание `SessionState` с `defaultChat`/`chats[0]`; чат появился → `retain(chatUri)`. Другая ошибка — `retry_wait`/`failed` по политике. Порядок тот же, что в §5.2: `createSession` → `watch(session)` → ждать чат → `watch(chat)`; без него ожидание `SessionState` до `watch` упиралось бы в 60-секундный таймаут на happy path. Этот случай — главная причина, почему `sessionUri` генерируется заранее: без него повтор создал бы вторую сессию;
   - для `running` (lease восстановлен, `ChatState` прочитан):
     - `activeTurn.id === turnId` → продолжаем `running`;
     - ход в `turns` с нашим `turnId` → settle по `turn.state`;
     - `inputNeeded` по нашему чату → `blocked` с причиной (перед этим — шаг 0 §3.8: архив);
     - чата нет, ход не найден, хост подключён и сессия отсутствует → `failed(session_missing)`;
     - сессия есть, но ход не найден и `activeTurn` пуст → `cancelRequestedAt` установлен ? `cancelled` (`error.kind = 'start_timeout'`) : `retry_wait` (dispatch потерялся) с проверкой, что `turnId` действительно нигде нет. Свежий снимок под lease показывает живой ход, поэтому отсутствие в нём — тот же критерий, что истечение 15 с в §3.9;
   - для `blocked` (включая `cancel_pending`) и `retry_wait`: сначала шаг 0 §3.8 (архив → `blocked(session_archived)`), затем сверка отмены для `cancel_pending` (§3.9), затем пересчёт причины/backoff, включая gate зависимостей (задача с зависимостями, у которых все `dependsOn` уже `completed`, возвращается в `queued`). `retry_wait` с истёкшим backoff сразу становится `starting`. Для `blocked(cancel_pending)` — ход уже завершился → терминальный исход по `Turn.state`; ход жив → продолжать `cancelTurn` по тем же правилам, что до рестарта backend. Если сессия подтверждённо отсутствует, сюда мы уже не попадаем — сработал пункт про сессию выше.
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
   |                   |--------------------------->| retain(session), watch  |
   |                   |                            |<--- session snapshot ---|
   |                   | wait defaultChat/chats[0]  |                         |
   |                   |--------------------------->| retain(chat), watch     |
   |                   |<-- chat snapshot ----------|                         |
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

1. **Tick.** Single-flight: если tick уже идёт, второй не запускается. Сначала tick пересчитывает gate зависимостей для всех нетерминальных задач (§3.5): `blocked(dependency_*)` → `queued`, когда все `dependsOn` снова `completed`, и `queued` → `blocked(dependency_*)`, когда зависимость стала `failed`/`cancelled`. Затем выбирает готовую задачу с минимальным `position`, проверяет слоты, резервирует слот в памяти и пишет `starting` + `sessionUri`. Резерв — до первого `await`, иначе два параллельных tick'а стартуют одну задачу дважды.
2. **Создание сессии.** `createSession` с `channel = sessionUri`, `provider`, `workingDirectories = [toFileUri(workingDirectory)]`. `Hub.createSession` возвращает только `{ sessionUri }` и ничего не подписывает (`server/hub.ts:192-200`), поэтому **сразу после ответа, включая `-32003 SessionAlreadyExists`**, берём `Hub.watch(hostId, sessionUri)`: первый подписчик делает `mirror.track` + `load` (`server/hub.ts:147-160`). Только теперь ждём `defaultChat` или `chats[0]` из `SessionState` (не `lifecycle === 'ready'`): хост держит `creating`, пока чат уже доступен (`src/SessionView.tsx:191`). Без `watch` ожидание `SessionState` не закончится — зеркало пусто (`server/mirror.ts:38-51`) — и happy path упирался бы в таймаут. Таймаут — 60 с. Если `lifecycle === 'failed'` → `failed(creation_error)`.
3. **Lease чата.** Чат появился → `Hub.watch(hostId, chatUri)`. Счётчики подписок не дают очереди и браузеру мешать друг другу (`server/hub.ts:147`); повторный `watch` при живом lease не делается (§3.9, §3.11 п.14).
4. **Проверка чата.** Дождаться загрузки `ChatState`. Если `interactivity` задан и не `full` → `failed(chat_read_only)`. **Перечитать `cancelRequestedAt`**: отмена могла прийти, пока ждали `createSession` или чат; тогда ход не диспатчится, задача `cancelled`, пустая сессия остаётся у хоста, lease освобождается в `finally` (§3.9). Если есть чужой `activeTurn` или непустые `queuedMessages` (очередь их не создаёт, значит это чужой ввод) → `blocked(external_turn)` (не отменяем чужой ход). Архив проверяется по шагу 0 §3.8.
5. **Старт хода.** Ещё раз перечитать `cancelRequestedAt` непосредственно перед записью: persist `chatUri`, `turnId`, `running`; диспатч `ChatTurnStarted` с `turnId = attempt.id`, `message.text = prompt`, `message.origin = { kind: MessageKind.User }`, при наличии модели — `message.model = { id, config }`. Ждём подтверждения через `dispatchTurnAndWait` (таймаут 15 с, `ACTION_CONFIRMATION_MS`). До истечения этого окна отсутствие хода в `ChatState` ничего не доказывает (§3.9 «Окно dispatch→эхо»).
   - Rejection до принятия → `retry_wait`/`failed` (при `cancelRequestedAt` — `cancelled`).
   - Таймаут → перечитать чат: `activeTurn.id === turnId` → продолжаем `running`; ход в `turns` → settle по `Turn.state`; хода нет → `retry_wait` (при `cancelRequestedAt` — `cancelled`, `error.kind = 'start_timeout'`).
6. **Мониторинг.** Пока есть нетерминальные задачи — tick раз в секунду (не чаще). Оптимизация: если все задачи в `blocked`/`retry_wait` с длинным backoff, интервал можно растянуть, но в v1 проще фиксированный.
7. **Закрытие попытки (settle).** Один `finally` на два исхода, и `release` watches живёт только в нём:
   - терминальный переход (`completed`/`failed`/`cancelled`): persist `outcome`/`error`, `release` watches, освободить слот, `kick` tick;
   - `retry_wait`: persist ошибку в попытку, `release` watches этой попытки (её чат больше не отслеживается), слот не занимает.
   Нетерминальные `blocked`, включая `blocked(cancel_pending)`, lease **не** снимают: их сверка (§3.8, §3.9) читает `ChatState`, а без подписки зеркало пустое и `Hub.cancelTurn` бросает «Чат не открыт или его состояние ещё не получено» (`server/hub.ts:294`, `:495-499`), то есть отмена молча не отправляется. Исключение одно — `blocked(host_unknown)`: подписку на хост, которого нет в конфигурации, создать нельзя, поэтому lease снимается при переходе в это состояние и берётся заново, когда хост вернулся (§3.9, lease-таблица). Порядок §3.9 — `persist cancelRequestedAt → cancelTurn → сверка → release` — это тот же порядок: `release` в `finally` возможен только здесь (и при переходе в `blocked(host_unknown)`).
8. **Cancel / retry / recovery** — отдельные ветки с теми же инвариантами. Ни одна из них не обходит шаги persist-before-act.

Таймауты по умолчанию: создание сессии вместе с появлением чата — 60 с, подтверждение старта — 15 с (существующая константа), poll — 1 с. Wall-clock-лимит на сам ход по умолчанию **выключен**: агент может законно работать десятки минут, и «убить по таймауту» — это скрытая потеря работы. Лимит можно добавить как настройку позже.

### 5.3 Гонки и как они закрыты

| Гонка | Защита |
| --- | --- |
| Два tick'а стартуют одну задачу | Single-flight tick + резерв слота до `await` + persist `starting` |
| Backend упал между `createSession` и записью `sessionUri` | `sessionUri` пишется **до** вызова; повтор получает `-32003` и продолжает |
| Ход принят, но подтверждение потеряно | `turnId` детерминирован; сверка `activeTurn`/`turns` вместо второго dispatch |
| Cancel пришёл после persist(running)/dispatch, но до эха | Отсутствие хода в `ChatState` в этом окне ничего не доказывает: задача остаётся `running` с `cancelRequestedAt` и lease, `cancelTurn` вызывается только после появления хода, терминальный исход — после эха, отказа хоста или 15 с (§3.9 «Окно dispatch→эхо») |
| Cancel пришёл, пока старт ждёт `createSession`/чат | Ветка старта перечитывает `cancelRequestedAt` перед persist/dispatch и не отправляет ход отменённой задачи; остаётся пустая сессия (§5.2 пп.4–5) |
| Backend перезапустился, задача в `blocked`/`cancel_pending` | Recovery сначала восстанавливает lease, потом читает `ChatState` и проверяет сессию (§4.4): иначе зеркало пусто, а проверка без подписки бросает «Сессия не открыта» |
| Человек архивировал сессию или чат задачи | `SessionStatus.IsArchived` в `SessionState`/`ChatState` (или `SessionSummary.status` без lease) → `blocked(session_archived)`; снятый бит возвращает задачу в пересчёт (§3.8 шаг 0) |
| Человек отправил сообщение в тот же чат | `blocked(external_turn)`; очередь не отменяет чужой ход |
| Человек подтвердил approval одновременно с тиком | Очередь вообще не отвечает на approvals, конфликта нет |
| Cancel приходит, когда ход уже завершился | `cancelTurn` бросает «уже завершён» — единственная ожидаемая ошибка: settle фиксирует фактический `Turn.state`; остальные ошибки дают `blocked` с причиной |
| Cancel в фоне, когда чат никто не открыл в браузере | Lease держит сама очередь (§3.9): lease не снимается до терминального исхода, поэтому `cancelTurn` видит `ChatState`, а сверка не теряется |
| Cancel задачи в `blocked`, у которой живой ход | `cancelTurn` только при `activeTurn.id === attempt.turnId`; чужой ход не трогается, задача в `blocked(cancel_pending)` до фактического исхода. В `blocked(external_turn)` это работает так же: свой живой ход отменяется, чужой остаётся (§3.9) |
| Сессия удалена во время мониторинга, в том числе пока задача в `blocked`/`cancel_pending` | `TaskHostPort.onSessionRemoved`, `checkSession` → `missing` или отсутствие в overview дольше 5 с → `failed(session_missing)` из любого нетерминального статуса (§3.9), зависимые blocked; lease снимается в `finally` |
| Реконнект хоста совпал с проверкой сессии | Сначала `disconnected` → `blocked(host_disconnected)`, счётчик отсутствия сессии обнуляется на `connected` (§5.5): ложного `session_missing` из-за пустого зеркала не бывает |
| Два backend на одном файле | Не поддерживается и явно запрещено правилом владения |

### 5.4 Вмешательство человека

Человек — полноценный участник: он может открыть сессию задачи и написать в неё. Очередь не считает сессию своей собственностью. Поведение:

- Если в чате появился чужой активный ход или непустые `queuedMessages` — задача переходит в `blocked(external_turn)`. Очередь не отменяет ход человека и не отправляет второй. Проверка владения ходом идёт раньше классификации `inputNeeded` и повторяется при каждом выходе из `blocked` (§3.8 шаги 3 и 5).
- Как только чат освободился, а незавершённого хода задачи нет, задача пересчитывается: если ход задачи уже завершён — settle; если нет и хода нет — `retry_wait` (осторожно, с проверкой `turnId`), потому что ход мог быть отменён человеком.
- Если человек меняет модель/конфиг сессии, очередь это не откатывает: это его сессия. Задача продолжает ждать ход.

### 5.5 Хост: disconnect, restart, updates

- **Disconnect:** все задачи, чьи сессии на этом хосте, переходят в `blocked(host_disconnected)` — включая `blocked(cancel_pending)` и `running`, — lease при этом сохраняется (§3.9, lease-таблица). Ни `failed`, ни retry: сеть может вернуться. Слоты освобождаются. Пока хост не подключён, отсутствие сессии не проверяется: отсутствие данных — не доказательство отсутствия сессии.
- **Reconnect:** подписки переустанавливаются, состояние задач сверяется по `overview.sessions` и `ChatState`. Порядок важен: сначала `disconnected` → `blocked(host_disconnected)`, и только после `connected` проверяется существование сессии (§3.9 «Потеря видимости»), а 5-секундный счётчик отсутствия считается заново от `connected`. Иначе реконнект дал бы ложный `session_missing`. Задачи, чьи сессии действительно исчезли, → `failed(session_missing)` из любого нетерминального статуса (включая `blocked`/`cancel_pending`), зависимые → `blocked(dependency_failed)`; lease снимается в `finally` (§5.2 п.7). После перезапуска самого backend подписки восстанавливаются до первой сверки — §4.4; пока lease не восстановлен, `ChatState` не читается и сессия не проверяется (§3.11 п.14).
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
| `queueAdd` | Добавить задачу | Хост известен; `provider` непустой; папка — абсолютный POSIX-путь (`toFileUri`); prompt непустой и ≤ 100 KB; `dependsOn` существуют, без цикла и self; `maxAttempts` 1–3; очередь < 200; `clientRequestId` уникален либо повторяет уже добавленную задачу; `modelConfig` — только JSON-примитивы; `modelId` — см. правило каталога ниже |
| `queueCancel` | Отменить | `queued`/`starting`/`retry_wait` — сразу, без обращения к хосту; `running`/`blocked` — `cancelTurn` только при `activeTurn.id === attempt.turnId`, затем `blocked(cancel_pending)` до сверки (§3.9); пока исход dispatch неизвестен (окно до эха/15 с), задача остаётся `running` с `cancelRequestedAt` и не терминальна; терминальные → ошибка «уже завершена» |
| `queueRetry` | Ручной retry | Только `failed`/`cancelled`; создаёт новую попытку с номером `max(number)+1`, `maxAttempts` не ограничивает ручной retry; `outcome`/`error`/`cancelRequestedAt` очищаются до следующего исхода. Зависимые задачи разблокируются не самим retry, а завершением зависимости (§3.5) |
| `queueRemove` | Удалить | Только `queued` или терминальные; при наличии зависимых — ошибка; running/blocked сначала `queueCancel` |
| `queueMove` | Изменить порядок | Только `queued`; `position` клампится в диапазон |
| `queueUpdateSettings` | Лимиты | `maxParallel` 1–8, `maxBlocked` 0–8; применяется немедленно, уже запущенные задачи не останавливаются |

При заблокированной записи (§4.3, version mismatch) все мутирующие calls таблицы отклоняются с текстом «запись очереди заблокирована»; читающие (`queueList`, `queueGet`) продолжают работать. Обычная ошибка записи так не поступает: там работа в памяти разрешена и видна через `persistenceError`.

Правило `modelId` одно для всех мест: если каталог моделей агента на подключённом хосте непуст — `modelId` обязан в нём быть (ошибка `queueAdd`/`queueRetry` с понятным текстом); если каталог пуст или хост не подключён — ручной `modelId` разрешён и передаётся хосту как есть, а несовместимость вернёт хост при старте хода (`model_unavailable`, §3.7). Если `modelId` не задан вообще — используется модель хоста по умолчанию. Это покрывает и форму «Codex до первой сессии» (§12.3): запрещать ручной id при пустом каталоге нельзя, разрешать при заполненном — тоже.

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
| `server/hub.ts` | Тонкий адаптер `TaskHostPort`: создать сессию с заданным URI, старт хода, summaries, состояние каналов, watch/unwatch, cancel, `checkSession`, событие `sessionRemoved` | SDK |
| `server/index.ts` | Маршрутизация, broadcast, жизненный цикл runner | всё выше |
| `src/queue.ts` | Клиентские типы/хелперы отображения (лейблы, сортировка, группировка) | `shared/queue.ts` |
| `src/QueueView.tsx` | Список, форма, карточка, пустые/ошибочные состояния | `store` |
| `src/store.ts`, `src/App.tsx` | Snapshot, навигация, мобильный режим | — |

`TaskHostPort` — узкая граница, чтобы `queue-runner` тестировался без SDK и без WebSocket:

```ts
interface TaskHostPort {
  summarize(hostId: string): SessionSummary[] | undefined;              // lease-free: overview.sessions
  sessionState(hostId: string, sessionUri: string): SessionState | undefined; // требует живого lease
  chatState(hostId: string, chatUri: string): ChatState | undefined;          // требует живого lease
  hostAvailable(hostId: string): boolean;
  retain(hostId: string, uri: string): void;      // watch: единственный путь наполнить зеркало
  release(hostId: string, uri: string): void;     // unwatch
  createSession(input: { hostId: string; sessionUri: string; provider: string; workingDirectory: string }): Promise<void>;
  startTurn(input: { hostId: string; chatUri: string; turnId: string; prompt: string; modelId?: string; modelConfig?: Record<string, JsonPrimitive> }): Promise<void>;
  cancelTurn(input: { hostId: string; chatUri: string; turnId: string }): Promise<void>;
  /** Перезапрос снимка сессии под живым lease; watchCounts не меняет. */
  checkSession(hostId: string, sessionUri: string): Promise<'ok' | 'missing' | 'unavailable'>;
  /** Единственное push-событие порта: хост удалил сессию. Возвращает отписку. */
  onSessionRemoved(listener: (hostId: string, sessionUri: string, chatUris: readonly string[]) => void): () => void;
  setSessionTitle?(input: { hostId: string; sessionUri: string; title: string }): Promise<void>; // best-effort
}
```

`checkSession` — **не** существующий `HostCall.refreshSession`: тот возвращает `void` (`shared/protocol.ts:79`), требует, чтобы канал уже был подписан (`server/hub.ts:207-213`), а ошибку кладёт в приватный `channelErrors` (`server/hub.ts:638-640`). Tri-state даёт новый внутренний метод `Hub.checkSession(hostId, sessionUri)`: `mirror.track` + `await load`, затем чтение `mirror.state` и `channelErrors` канала → `ok` (снимок есть), `missing` (`AhpErrorCodes.SessionNotFound`, `-32001`), `unavailable` (транспорт, хост не подключён, снимок не пришёл). `watchCounts` метод не меняет, поэтому он безопасен при живом lease и не является повторным `retain` (§3.9). На неподписанном канале он бросает «Сессия не открыта» — это нарушение предусловия (§3.11 п.14), а не `unavailable`, и трактовать его как удаление нельзя. Браузерный `HostCall.refreshSession` остаётся без изменений.

`onSessionRemoved` — единственное push-событие порта, и оно нужно, потому что без него критерий `sessionRemoved` нереализуем: порт в остальном pull-only, а `Hub` пересылает это событие только браузеру через `sink.broadcast` (`server/hub.ts:653`). Адаптер подписывает runner на тот же `removeSession`; контракт Hub↔браузер не меняется, новых AHP-каналов нет. Альтернатива — убрать `sessionRemoved` из критериев и оставить `checkSession`/`summarize`: тогда обнаружение удаления занимает до одного tick'а, а «5 секунд» в §3.9 становится основным путём; это допустимо, но медленнее и хуже для S11.

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
| 0. Валидация допущений | Одноразовая сессия на живом хосте: клиентский `turnId` и его эхо в `entry.turnId`, `inputNeeded`-формы, title, `createSession` → чат, cancel без открытой вкладки | 0,5–1 | Записанные наблюдения; ни одно архитектурное решение не держится на непроверенном primitive |
| 1. Домен | `shared/queue.ts`, `server/task-queue.ts`: состояния, DAG, выбор готовых, backoff, проекция | 1,5–2 | Unit-тесты на переходы, циклы, лимиты; нет SDK в зависимостях |
| 2. Хранилище | `server/queue-store.ts`: atomic write, `.bak`, corrupt-handling, сериализация | 1–1,5 | Тесты на обрыв записи, битый JSON, идемпотентность `clientRequestId` |
| 3. Исполнение | `Hub`-адаптер + `queue-runner`: старт, мониторинг, settle, blocked, cancel, recovery | 3–4 | Fake-порт: happy path (в т.ч. `watch(session)` до ожидания чата), timeout, rejection, cancel-гонка (в т.ч. отмена `blocked` без браузерных подписчиков и без потери lease, и отмена в окне dispatch→эхо), recovery (`blocked` восстанавливает lease до чтения), `-32003`, удаление сессии в `blocked`/`cancel_pending` → `failed(session_missing)` с освобождением lease, архив сессии → `blocked(session_archived)` |
| 4. Контракт и UI | `protocol.ts`, `index.ts`, `store.ts`, `QueueView`, навигация, mobile, in-app notices | 3–4 | Typecheck/build; store-тест на `queue`-сообщение; ручной smoke |
| 5. Политики | DAG-UI (список зависимостей), retry/backoff в UI, settings, reorder, prune | 1–1,5 | Unit + smoke на пакете из 3 задач с зависимостью |
| 6. Hardening | restart backend/хоста, disconnect, гонки, документация, smoke | 1–2 | CI зелёный; сценарии S7/S8/S10/S11 пройдены вручную |
| **Итого MVP** |  | **11–16** | Сценарии S1–S15, кроме push и доски |
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
9. **`session_missing` и `model_unavailable`: терминальный `failed` или `blocked`, как в одобренном плане?** Рекомендация — `failed` с ручным `queueRetry` (§3.8): после исчезновения сессии ждать нечего, а `model_unavailable` требует смены target, чего в v1 нет. Выбор `blocked` меняет только значения `QueueTaskState`/`QueueBlockedKind` и переходы; архитектура, хранение и UX блокировок не меняются. Нужно явное подтверждение владельца, потому что это расхождение с планом.

**Что нужно от ревьюера:** подтвердить или изменить рекомендации по пунктам 1–9. После подтверждения открывается отдельная задача на реализацию этапов 0–6; в этой ноде ничего не кодится.

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
| `cancelTurn` требует `activeTurn.id`; на завершившийся и на чужой ход отвечает одной и той же ошибкой «Этот ход уже завершён», поэтому владение проверяется до вызова | `server/hub.ts:293`–`:297` |
| `unwatch` при счётчике подписок 1 удаляет канал из зеркала; после этого `chatState` бросает «Чат не открыт или его состояние ещё не получено», а `cancelTurn` читает `ChatState` первым делом | `server/hub.ts:163`–`:175`, `server/mirror.ts:45`–`:47`, `server/hub.ts:294`, `:495`–`:499` |
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
| `CreateSessionParams`: `channel`, `provider?`, `workingDirectories?`, `config?`, без initial message | `src/types/channels-session/commands.ts:53` |
| Повторное создание существующей сессии → `-32003 SessionAlreadyExists` | `src/types/channels-session/commands.ts:26`, `src/types/common/errors.ts:50` |
| `inputNeeded` host-managed, entry содержит `id` и `chat`, отвечать можно без подписки | `src/types/channels-session/state.ts:244`–`:332` |
| Kinds: `chatInput`, `toolConfirmation`, `toolClientExecution`, `toolAuthentication` | `src/types/channels-session/state.ts:302`–`:311` |
| `toolConfirmation` покрывает и `PendingConfirmation`, и `PendingResultConfirmation` | `src/types/channels-session/state.ts:351`–`:369`, `src/types/channels-chat/state.ts:1707` |
| `SessionToolConfirmationRequest`: `kind`, `turnId`, `toolCall`; поля `request` нет — `request: ChatInputRequest` только у `SessionChatInputRequest`; база содержит `id` и `chat` | `src/types/channels-session/state.ts:318`–`:333`, `:345`–`:349`, `:363`–`:369` |
| `ToolCallStatus`: `pending-confirmation`, `pending-result-confirmation`; `ToolCallConfirmationState` — union двух состояний | `src/types/channels-chat/state.ts:1271`–`:1284`, `:1707`–`:1709` |
| `TurnState`: `complete`, `cancelled`, `error` | `src/types/channels-chat/state.ts:751` |
| `Turn`: `id`, `state`, `responseParts`, `usage` | `src/types/channels-chat/state.ts:781` |
| `ChatInteractivity`: `full`, `read-only`, `hidden` | `src/types/channels-chat/state.ts:425` |
| `ChatState`: `activeTurn`, `turns`, `queuedMessages`, `draft`, `interactivity` | `src/types/channels-chat/state.ts:52`–`:185` |
| `SessionMetaChanged` — server-only, `SessionTitleChanged` — client-dispatchable | `src/types/action-origin.generated.ts:502`, `:480` |
| `ChatState.turns` — хвостовое окно завершённых ходов (`turns is a tail window`), `turnsNextCursor` грузит более старые | `src/types/channels-chat/state.ts:149`–`:159` |
| `SessionOrigin` = только `AutomationSessionOrigin` | `src/types/channels-session/state.ts:107` (тип), `:94` (единственный вариант) |

### 12.3 Не проверено и как проверить

| Вопрос | Почему важно | Как проверить (этап 0) |
| --- | --- | --- |
| Принимает ли живой хост `ChatTurnStarted` с клиентским `turnId` при простое | Основа старта хода | Одна тестовая сессия: отправить ход, сравнить `activeTurn.id` с отправленным |
| Заполняется ли `SessionSummary.chats`/`defaultChat` сразу после `createSession` | Если да, чат можно найти без подписки на сессию; если нет — `watch(session)` обязателен до ожидания `SessionState` (§5.2 п.2) | Создать сессию и посмотреть `overview.sessions[].summary.chats` до `watch`; отдельно убедиться, что `sessionState` до подписки пуст |
| Приходит ли `sessionRemoved` для сессии, созданной очередью, и когда | Критерий `session_missing` и `TaskHostPort.onSessionRemoved` (§3.9, §6.4) | Создать сессию из backend, удалить её в VS Code, проверить событие хоста и `sink.broadcast`; при отсутствии события критерий убирается, остаются `checkSession`/`summarize` |
| Возвращает ли хост `-32001` на перезапрос снимка (`refreshSession`) под живым lease | Tri-state `checkSession`: `missing` не должен выглядеть как `unavailable` | Удалить сессию в VS Code при открытом канале очереди и вызвать `refreshSession`; ожидается `channelError` с `-32001`, а не «Сессия не открыта» |
| Все ли формы `inputNeeded` приходят на живом VS Code-хосте | Источник `blocked` | Вызвать инструмент с approval, посмотреть `SessionState.inputNeeded` |
| Равен ли `entry.turnId` у `toolConfirmation`/`toolAuthentication` отправленному `attempt.turnId` | Правило атрибуции чужого хода (`external_turn`, §3.8) | На живой сессии отправить approval-инструмент и сравнить `inputNeeded[].turnId` с отправленным; если хост переназначает id, правило §3.8 до пересмотра считается неприменимым |
| Работает ли отмена из backend, когда чат не открыт ни в одном браузере | Основа §3.9: lease очереди, `ChatTurnCancelled`, сверка `Turn.state` | Тестовая сессия ждёт approval, вкладки закрыты, `cancelTurn` вызывается из backend: проверить, что action применён, ход попал в `turns` как `cancelled`, а `ChatState` читается без браузерных подписчиков |
| Заполняется ли `ChatState.queuedMessages` при живом ходе и потребляется ли очередь сообщений при простое | Правило `blocked(external_turn)` (§3.8 шаг 3) опирается на непустой `queuedMessages`, а не только на чужой `activeTurn`; в MVP сами pending-сообщения не отправляются | На живой сессии поставить сообщение в чат с активным ходом и посмотреть `ChatState.queuedMessages`; если хост pending-сообщения не показывает, `external_turn` определяется только по чужому `activeTurn`, а `queuedMessages` из правила убирается |
| Принимает ли хост `SessionTitleChanged` сразу после создания | Косметика | Отправить и проверить, что title изменился; отказ не ломает задачу |
| Сохраняются ли сессии при перезапуске хоста | Recovery | Перезапустить хост, проверить `overview.sessions` |
| `automationsEnabled` и capabilities на текущих хостах | Приоритет automation-адаптера | По отчёту Recon 24.11.2026 выключено; **в этой ноде не перепроверялось** |
| Каталог моделей Codex до первой сессии | Форма выбора модели | Открыть форму на хосте без сессий; если каталог пуст — разрешить ручной `modelId` |

### 12.4 Как проверялся этот документ

- Каждый `path:line`, на который опирается решение, сверен чтением файла на `6cbd5a5`; символы SDK — по типам 1.1.0. Безусловной пословной сверки каждого номера строки документ не заявляет: после ревью уточнены `channels-session/commands.ts:53` (вместо `:42`) и `SessionState.chats: ChatSummary[]` (`channels-session/state.ts:193`). Если номер строки расходится с символом — верить имени символа.
- `git status --short` до начала работы: чисто; после — только `docs/task-queue-design.md`.
- `git diff --check` — без пробельных ошибок.
- `rg -n "^## |^### "` — структура разделов на месте.
- `rg -n "авторитет|хост остаётся"` — утверждение о владении присутствует в TL;DR, §1.4, §4.2, §10.
- Проверки в worktree на ветке `AGENTHOS-22` (код = `6cbd5a5`): `npm ci` (134 пакета), `npm run typecheck` — exit 0, `npm test` — 132/132, `npm run build -- --outDir /tmp/acc-queue-doc-build-2` — exit 0 с известным предупреждением Vite о чанке 505 kB (CI его сохраняет намеренно). Runtime-код не менялся, поэтому эти прогоны подтверждают baseline, а не поведение очереди.
- Правки после ревью проверялись точечно: поиск устаревшего префикса `request.` перед `toolCall` по документу — пусто (теперь везде `entry.toolCall`, а поле `request` упоминается только для `chatInput`); таблицы документа (число колонок в строках) — без расхождений; `git diff --check` — без пробельных ошибок.
- Отмена перепроверена по коду, а не по памяти: `server/hub.ts:163`–`:175` (`unwatch` при счётчике 1 → `this.mirror.drop`), `server/mirror.ts:45`–`:47` (`drop` удаляет entry), `server/hub.ts:294` (`cancelTurn` читает `chatState`), `:495`–`:499` (`chatState` бросает, если зеркала нет), `:293`–`:296` (одна и та же ошибка «Этот ход уже завершён» на завершившийся и на чужой ход), `:574`–`:588` (снимок перезапрашивается на реконнекте). Отсюда порядок `persist → cancelTurn → сверка → release` и запрет снимать lease при запросе отмены (§3.9, §5.2 п.7).
- Документ не заявляет проверку поведения: живые AHP-хосты не поднимались, очередь не реализована; `typecheck`/`test`/`build` подтверждают только baseline. Что именно проверить на живом хосте до реализации — §12.3, этап 0.
- Номера строк в этом разделе и в §3.9 чувствительны к правкам кода: при расхождении верить имени символа, а не номеру.
- Правки раунда 5 (отмена `blocked(external_turn)`, удаление сессии в `blocked`/`cancel_pending`) сверены по коду, а не по памяти: `server/hub.ts:207`–`:213` (`refreshSession`: `mirror.track` + `load`, `watchCounts` не меняется), `:572`–`:592` (`consumeHostEvents`: снимки перезапрашиваются только по `connected`), `:643`–`:653` (`removeSession`: `mirror.drop` сессии и её чатов, `channelErrors` «Сессия удалена на хосте», `sink.broadcast({ t: 'sessionRemoved' })`), `server/lifecycle.test.ts:85`–`:100` (перепроверка через `refreshSession` выявляет удаление, даже если хост не прислал `sessionRemoved`), `:147`–`:160` (`watch` бросает сохранённую ошибку канала при `count > 0`), `:293`–`:296` (`cancelTurn` читает `chatState` и сверяет `activeTurn.id`), `:495`–`:499` (`chatState` бросает при пустом зеркале). SDK: `src/types/common/errors.ts:46` (`SessionNotFound: -32001`), `src/types/channels-chat/state.ts:161`, `:176` (`activeTurn` и `queuedMessages` в одном `ChatState`), `src/types/channels-chat/actions.ts:84` (`queuedMessageId`).
- Команды проверки взяты из `package.json` и CI; `memory-bank/techContext.md:11` упоминает `npm run mock-host` и `npm run server:dev`, которых в `package.json` нет — эти команды не используются.
- Правки раунда 6 (`lease → чтение`, окно dispatch→эхо, архив сессии, tri-state проверки сессии) сверены по коду `6cbd5a5`: `server/hub.ts:110-117` (`Hub.start` отслеживает только `ROOT`), `:147-160` (`watch` — единственный путь `mirror.track` + `load`), `:192-200` (`createSession` возвращает только `{ sessionUri }` и ничего не подписывает), `:207-213` (`refreshSession` требует `watchCounts.has` и возвращает `void`), `:495-499` (`chatState` читает зеркало), `:508-516`, `:527-541` (dispatch отправляет action и ждёт эхо до `ACTION_CONFIRMATION_MS`), `:621` (эхо применяется к зеркалу), `:643-653` (`removeSession` → `channelErrors` и `sink.broadcast sessionRemoved`), `:469` (панель проверяет `SessionStatus.IsArchived`); `server/mirror.ts:38-51` (без `track` состояние `undefined`); `shared/protocol.ts:79` (`refreshSession` — `void`, без кода ошибки). SDK 1.1.0: `channels-session/state.ts:71` (`SessionStatus.IsArchived`), `:128` (`SessionMetadata.status`), `:502-529` (`SessionSummary` с `status`, `chats`, `defaultChat`), `channels-chat/state.ts:59` (`ChatState.status`). Отсюда порядок `createSession → watch(session) → ждать чат → watch(chat) → чтение`, восстановление lease в recovery и tri-state `Hub.checkSession` (§3.9, §4.4, §5.2, §6.4).
- После правок раунда 6: `npm run typecheck` — exit 0, `npm test` — 132/132, `npm run build -- --outDir /tmp/acc-queue-doc-build-6` — exit 0 с тем же предупреждением Vite; таблицы документа (число ячеек) и `git diff --check` — без расхождений. Runtime-код не менялся, это baseline.

---

## Приложение A. Что в этой задаче не делается

- Не реализуются очередь, runner, store, UI, доска, push и automation-адаптер.
- Не меняются production-код, `package.json`/lockfile, `hosts.json`, Memory Bank, `README.md`.
- Не добавляются зависимости.
- Не обещаются сроки, deep link в VS Code, push, «полностью unattended» работа.
- `ChatPendingMessageSet` не выдаётся за проверенный primitive.
- Backend не становится вторым источником истины о сессиях: **хост остаётся авторитетом сессий.**
