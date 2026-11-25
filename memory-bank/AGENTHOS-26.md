# AGENTHOS-26 — терминал на `#terminal`

> Кнопка «Закрыть терминал» из шапки страницы, описанная ниже, позже переехала: `×` стоит
> на каждой строке списка и закрывает именно её PTY (см. `progress.md`, запись от 25 ноября
> 2026). Остальное описание задачи остаётся историческим.

## Чеклист реализации

- [x] 1. `shared/reduce.ts`: `terminalReducer`, `ahp-terminal:` в `isSupportedChannel`/`reduceChannel` (+ `server/reduce.test.ts`)
- [x] 2. `shared/protocol.ts`: `TerminalState` в `ChannelState`, `TERMINAL_PREFIX`, `HostCall` (createTerminal/disposeTerminal/terminalInput/terminalResize), `ServerMessage.terminalData` + парсер (+ кейсы в `server/protocol.test.ts`)
- [x] 3. `server/terminal-stream.ts` + тест: склейка, 33 мс, ≤128 КБ, flush/drop, бэкпрешер, переполнение буфера
- [x] 4. `server/hub.ts` + `server/hub-terminal.test.ts`: перехват `terminal/data`, flush перед прочими terminal-actions и snapshot, `createTerminal`/`disposeTerminal`/input/resize, лимит 8 с вытеснением старейшего, ограничение зеркала (`server/terminal-content.ts` + `ChannelMirror.rewrite`)
- [x] 5. `server/terminal-cleanup.ts` + тест + `sweepTerminals` + `setInterval` в `server/index.ts` (`ACC_TERMINAL_IDLE_MS`, default 30 мин)
- [x] 6. Браузер: `src/store.ts` (raw `terminalData`, replay снимка), `src/terminal-session.ts` + тест, `src/TerminalView.tsx`, `src/ui/TerminalEmulator.tsx` (lazy)
- [x] 7. `src/App.tsx` (`#terminal`, кнопка «Терминал»), `src/panel-presence.ts` (+тест), `src/styles.css`
- [x] 8. `scripts/mock-host.ts`: фейковый PTY (эхо, `echo`, `exit N`, Ctrl-C, resize/cleared/claimed, `root/terminalsChanged`)
- [x] 9. `e2e/terminal.spec.ts`: команда и код выхода, F5/возврат/закрытие, F5 к последней папке, 390×844 без overflow
- [x] 10. README (раздел «Терминал» и «Безопасность терминала», ограничения) + memory-bank (этот файл), запись в `activeContext.md`

## Итог

Страница `#terminal` открывает настоящий PTY на выбранном хосте и папке, показывает поток вывода,
фактический `cwd` и lifecycle с кодом выхода, переживает F5, уход со страницы и рестарт backend,
а брошенные свои терминалы закрывает автоочистка.

## Реализация

- **Контракт** — [shared/reduce.ts](../shared/reduce.ts): `ahp-terminal:` в `isSupportedChannel`
  и ветка `terminalReducer` в `reduceChannel`; [shared/protocol.ts](../shared/protocol.ts):
  `TerminalState` в `ChannelState`, `TERMINAL_PREFIX`, `HostCall` `createTerminal`/`disposeTerminal`/
  `terminalInput`/`terminalResize`, `ServerMessage.terminalData` и его разбор в `parseServerMessage`.
- **Поток** — [server/terminal-stream.ts](../server/terminal-stream.ts): `TerminalStream` копит
  `terminal/data` и отдаёт кадры `terminalData` раз в 33 мс, не больше 128 КБ, хвост остаётся
  в pending; `flush` перед любым не-data действием канала и перед снимком; `drop` при unwatch,
  dispose и stop; бэкпрешер через `HubSink.channelBackpressured` (`socket.bufferedAmount` > 4 МБ).
  [server/terminal-content.ts](../server/terminal-content.ts) ограничивает историю в backend-зеркале
  256 КБ (`ChannelMirror.rewrite`), чтобы память не росла вместе с выводом PTY.
- **Hub** — [server/hub.ts](../server/hub.ts): перехват `terminal/data` в `consumeEvents`,
  `createTerminal` (проверка папки `resourceList` с деградацией по `-32601`, cwd `toFileUri`,
  claim `{kind:'client', clientId}` из `HostHandle.clientId`), `disposeTerminal` (idempotent по
  `NotFound`), `terminalInput`/`terminalResize` только для `running`, лимит 8 своих PTY с вытеснением
  старейшего без наблюдателей, `sweepTerminals`.
- **Автоочистка** — [server/terminal-cleanup.ts](../server/terminal-cleanup.ts): чистый план
  `terminalCleanupPlan` и `evictionCandidate`; Hub ведёт `terminalSeenAt` по `root/terminalsChanged`
  и при снятии последнего наблюдателя; [server/index.ts](../server/index.ts) крутит `setInterval`
  60 с, порог из `ACC_TERMINAL_IDLE_MS` (default 30 мин, минимум 60 с).
- **Браузер** — [src/store.ts](../src/store.ts) `subscribeChannelData` с буфером кадров до подписки
  и `epoch` снимка (эмулятор видит новую точку отсчёта только на снимке и `terminal/cleared`,
  поэтому `resized`/`exited` не стирают экран); [src/terminal-session.ts](../src/terminal-session.ts)
  `terminalKey`, `localStorage['acc.terminals.v1']`, `acc.terminals.v1.last` (последняя пара
  хост+папка), `terminalChoice`, `terminalCwd`; [src/TerminalView.tsx](../src/TerminalView.tsx) —
  страница, форма, подхват/создание, «Закрыть терминал» с забыванием URI; чтение и запись
  `localStorage` обёрнуты: приватный режим не мешает открыть терминал, а только лишает подхвата;
  [src/ui/TerminalEmulator.tsx](../src/ui/TerminalEmulator.tsx) — ленивый чанк xterm + fit,
  `scrollback: 5000`, `screenReaderMode: false` (см. «Найдено на независимой проверке»),
  resize с debounce 150 мс, reset+replay снимка.
- **UI-обвязка** — [src/App.tsx](../src/App.tsx) `#terminal` и кнопка «Терминал»,
  [src/panel-presence.ts](../src/panel-presence.ts) новое поле `showTerminal`, [src/styles.css](../src/styles.css)
  `.terminal-page`/`.terminal-screen` и мобильные правила.
- **mock-host** — [scripts/mock-host.ts](../scripts/mock-host.ts): карта терминалов, `stateOf` для
  `ahp-terminal:`, `createTerminal`/`disposeTerminal`, `root/terminalsChanged`, фейковый shell
  (`echo`, `exit N`, Ctrl-C), `terminal/resized|cleared|claimed`.
- **E2E** — [e2e/terminal.spec.ts](../e2e/terminal.spec.ts): команда и код выхода, F5/возврат/закрытие,
  F5 к последней открытой папке (не к папке по умолчанию), 390×844 без горизонтального скролла.

## Проверки

- `npm run typecheck` — зелёный (`tsconfig.json`, `tsconfig.server.json`, `tsconfig.e2e.json`).
- `npm test` — 478/478 (после ревью добавлены тесты гонки лимита, flush для второго наблюдателя,
  суррогатной пары в буфере и разбора `ACC_TERMINAL_IDLE_MS`).
- `npm run build` — `TerminalEmulator-*.js` 333.7 КБ (gzip 84 КБ) отдельным ленивым чанком и
  `TerminalEmulator-*.css` 3.9 КБ; основной `index-*.js` 586.6 КБ (gzip 177 КБ) против 576.3 КБ
  на `HEAD` до задачи — прирост ~10 КБ на страницу и store, xterm в основной чанк не попал.
  Предупреждение Vite о чанке >500 КБ было и до задачи.
- `npm run test:e2e` — 18/18 (четыре сценария терминала: команда и код выхода, F5/возврат/закрытие,
  F5 к последней папке, 390×844 без overflow).
- Флак окружения, не связанный с задачей: `ensureHostConnected` в `e2e/support/app.ts` иногда не
  дожидается «Подключено: 1/1» за 20 с и тест падает по таймауту setup. Проверено на чистом
  `HEAD` в отдельном worktree: `e2e/session.spec.ts` падает так же (1 из 6 прогонов), то есть
  это гонка первого подключения mock-хоста, а не регрессия терминала; повторный прогон зелёный.
- Живой стенд (`local` на 8089, отдельный backend на 8099 и Vite на 5180, чтобы не трогать
  `npm run up`): `createTerminal` в `/tmp` дал `running` и `117×54`; `pwd` вернул `/tmp`;
  `seq 1 200000` прошёл без зависания (heap вкладки ~29 МБ, `scrollback` держит 5000 строк);
  Ctrl-C оставил shell живым (`echo` после прерывания работает); `exit 7` дал статус
  «завершён · код 7»; уход-возврат, F5 и возврат после F5 к папке `/tmp` (не к папке по умолчанию)
  подхватили тот же shell по маркеру; 390×844 — overflow страницы и экрана `0`; «Закрыть терминал»
  вернул форму. Кириллица в выводе хоста корректна, вставка кириллицы (`ClipboardEvent` в
  helper-textarea) тоже.
- Рестарт backend на живом стенде: `kill` backend на 8099, новый процесс, F5 — маркер прошлого
  вывода на месте, статус `running`, ввод снова работает (claim остался за `clientId` из
  `client-ids.json`).
- Автоочистка на живом стенде: backend с `ACC_TERMINAL_IDLE_MS=60000`, `createTerminal` и
  закрытие наблюдающего WebSocket — через два тика (140 с) `root/terminals` пуст, терминал закрыт.

## Ревью Gate: замечания и исправления

- **C-01 — resolved (блокер).** Лимит 8 своих PTY не держался: вытеснение запускалось через
  `void this.closeTerminal(...)`, create уходил хосту, не дожидаясь dispose; два параллельных
  create выбирали один и тот же URI. В [server/hub.ts](../server/hub.ts) `releaseSlotForTerminal`
  заменён на асинхронный `reserveTerminalSlot`: слот резервируется до запроса, занятость считается
  как «свои терминалы из root, кроме уже закрываемых» + «закрытия в полёте» (`terminalClosings`) +
  «создания, ещё не попавшие в root» (`pendingTerminals`). `closeTerminal` синхронно помечает URI
  в `terminalDisposals` (повторно не вытесняется) и ждётся до ответа хоста; ошибка dispose, кроме
  `NotFound`, отменяет создание с понятным сообщением. Автоочистка не дублирует уже идущее закрытие.
  Доказательства: `server/hub-terminal.test.ts` — «createTerminal вытесняет старейший PTY до
  запроса создания» (create не уходит, пока dispose не завершён), «два одновременных createTerminal
  не превышают лимит и не вытесняют один URI дважды» (живое множество в fixture никогда > 8),
  «ошибка вытеснения не создаёт новый PTY, а NotFound считается закрытием». Независимый repro
  `/tmp/kent/gate26/repro.ts` на реальном Hub: single — `dispose:done alive=7` → `create:done alive=8`;
  parallel — два разных URI вытеснены, `alive` не превышал 8, итог 8.
- **C-02 — resolved.** `hub.watch` при повторной подписке сначала `terminalStream.flush`, затем
  отдаёт состояние зеркала: второй наблюдатель получает накопленные байты кадром раньше снимка
  и не дублирует их. Тест: «второй наблюдатель получает накопленный вывод кадром раньше снимка».
- **C-03 — resolved.** Буфер кадров до подписки режется по границе кодовой точки
  (`src/store.ts`), комментарий и README больше не обещают «полный снимок» для кадров после
  снимка. Тест: «буфер вывода до подписки не рвёт суррогатную пару».
- **C-04 — resolved.** Ошибка создания PTY в ветке уже подхваченного терминала рендерится рядом
  со статусом с кнопкой «Повторить», а автосоздание после `NotFound` не запускается, пока хост
  отключён (`available` в зависимостях эффекта).
- **C-05 — resolved.** `ACC_TERMINAL_IDLE_MS` разбирается один раз при старте
  (`terminalIdleMs` в `server/terminal-cleanup.ts`): опечатка роняет запуск с внятной ошибкой,
  а не тихо отключает автоочистку. Тест: «порог автоочистки разбирается на старте и не принимает
  опечатки».
- **ARCH-2, ARCH-3, ARCH-4, ARCH-6 — open, не входят в условия приёмки.** Это стоимость обрезки
  зеркала на каждом кадре, политика переполнения pending при мёртвом сокете, дублирование
  проверки папки и обёртка localStorage; поведение задачи они не нарушают. ARCH-5 частично
  закрыт: предикат «свой терминал» вынесен в `isOwnTerminal` и используется в лимите и наблюдении.

## Найдено на независимой проверке после Done

- **Кириллица и мобильная клавиатура не доходили до PTY (исправлено).** В
  [src/ui/TerminalEmulator.tsx](../src/ui/TerminalEmulator.tsx) стоял `screenReaderMode: true`,
  а xterm при этом режиме намеренно игнорирует `input`-события с текстом
  (`CoreBrowserTerminal._inputEvent`, условие `!rawOptions.screenReaderMode`). С русской
  раскладки, из IME и с Android-клавиатуры в скрытую textarea приходит только `input` — в PTY
  не уезжал ни один символ (латиница работала через `keypress`, вставка — через `paste`).
  Режим выключен, добавлен e2e «кириллица и текст из IME/мобильной клавиатуры доходят до PTY»:
  с `screenReaderMode: true` он падает, с `false` проходит.
- Живой прогон на отдельном стенде (backend 8099 + Vite 5180, хосты 8089/8093/8094):
  `pwd`→`/tmp`, кириллица в выводе, `seq 1 200000` (heap 22 МБ, статус `117×54`), Ctrl-C,
  F5, уход-возврат, 390×844 overflow `page=0 screen=0`, рестарт backend с подхватом того же
  shell и рабочим вводом, `exit 7`→«завершён · код 7», «Закрыть терминал» чистит
  `acc.terminals.v1`.
- Автоочистка проверена на production-пути `Hub.sweepTerminals` (не только юнит-тестом):
  план `[ahp-terminal:/own-idle]`, брошенный свой закрыт, свежий свой и агентский живы.

## Ограничения (зафиксированы владельцем)

Один терминал на страницу, без табов и шаринга; без просмотра терминалов агентов; без
переименования, ANSI в `TerminalOutput` и «Открыть в Terminal.app»; approvals нет — shell по
Tailscale запускается осознанно; после reconnect история неполная (снимок хоста ~82 КБ);
кириллица в `commandLine` искажается на стороне хоста и не «чинится».
