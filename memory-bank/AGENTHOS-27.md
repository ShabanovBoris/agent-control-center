# AGENTHOS-27: несколько терминалов в общем списке

Статус: сделано и слито — PR [#19](https://github.com/ShabanovBoris/agent-control-center/pull/19),
squash `a977fb8`. Повторный Gate: `open_refs` пуст, оба блокера (README «один терминал на
страницу», статус memory-bank) закрыты.

## Решение владельца по границе

Список терминалов живёт **внутри** страницы `#terminal`; сайдбар чатов не трогаем, `#terminal`
остаётся отдельной страницей. «Общий список» = все открытые терминалы на странице терминала;
чёрная обводка — отличие выбранного.

## Реализовано в коде

- `shared/protocol.ts`: `TerminalOverview { resource, title, lifecycle }` и `HostOverview.terminals?`;
  поле отсутствует, если своих PTY нет.
- `server/hub.ts`: `hostOverview` собирает `terminals` из зеркала root через
  `hostTerminals(...).filter(isOwnTerminal)`; `createTerminal` передаёт `name`
  (`title?.trim() || directoryName(path) || 'Терминал'`).
- `shared/directory.ts`: `directoryName`.
- `src/store.ts`: адресный `subscribeChannelData(hostId, uri, listener)` с буфером по каналу;
  `overviewLoaded` в `AppState`; `useChannels(refs)` — diff-подписки на набор каналов.
- `src/ui/TerminalEmulator.tsx`: проп `active`, фокус только у активной панели, адресная подписка.
- `src/terminal-session.ts`: `acc.terminals.v2.selected` / `acc.terminals.v2.form`,
  `selectedTerminal`, `rememberSelectedTerminal`, `forgetSelectedTerminal`, `lastTerminalForm`
  (fallback на `acc.terminals.v1.last`), `rememberLastTerminalForm`, `terminalStatusText`,
  `terminalCwd`. Старая карта «хост+папка» удалена. Подписи строк: `acc.terminals.v2.labels`
  (URI → имя, `terminalLabels` / `rememberTerminalLabel` / `pruneTerminalLabels`),
  `nextTerminalLabel` (имя папки и номер для повторов), `terminalRowLabels` (сохранённое имя
  важнее хост-заголовка; одинаковые подписи получают короткий хвост URI).
- `src/TerminalView.tsx` + `src/ui/TerminalList.tsx`: общий список, `pending`/`closing`,
  выбор по строке без смены hash, «Новый терминал» всегда создаёт новый PTY, закрытие
  выбирает первый терминал того же хоста; все панели смонтированы, скрыты `visibility:hidden`.
  Имя нового PTY считается по папке, сохраняется по URI и не меняется после overview.
- `src/styles.css`: `.terminal-list`, `.terminal-row` (чёрная обводка выбранной),
  `.terminal-stage`, `.terminal-pane[data-active]`, форма поверх сцены.
- `src/App.tsx`: передаёт `overviewLoaded` в `TerminalView`.
- `scripts/mock-host.ts`: title PTY — `bash`, как у local-хоста (`name` принимается, но заголовок
  не меняется); различимость строк в e2e проверяется по подписям панели.
- Тесты: `server/hub-terminal.test.ts` (overview own-only, имя папки, RootTerminalsChanged
  через расширенную фикстуру), `src/store.test.ts` (адресный поток, `overviewLoaded`),
  `src/terminal-session.test.ts` (выбор/форма/подписи/различитель), `e2e/terminal.spec.ts`
  (beforeEach-изоляция, два PTY в разных и в одной папке, переключение, F5, лимит в unit).

## Замечания Gate и их статус

- **B1 (README, «Безопасность терминала»)** — resolved: раздел описывает до восьми своих PTY,
  общий `clientId`, видимость и запись своих PTY со всех браузеров, `claim` не замок.
  Упоминаний «один терминал на страницу» в README нет.
- **B2 (статус memory-bank)** — resolved: этот файл и `progress.md` приведены к текущему
  состоянию, «Осталось» заменено фактическими проверками.
- **B3 (неразличимые PTY в одной папке)** — resolved: подпись строки (`acc.terminals.v2.labels`)
  задаётся при создании и не зависит от хост-заголовка `bash`; повтор в папке нумеруется,
  кросс-браузерные совпадения получают хвост URI. Mock-хост ведёт себя как реальный, e2e
  покрывает два PTY в одной папке, unit — `nextTerminalLabel` / `terminalRowLabels`.
- **Q-4 (README про «соседний»)** — resolved: README описывает фактический выбор (первый
  терминал того же хоста).
- Некритичные C-3/C-4/C-5, ARCH-1..ARCH-4, COMPAT-27-02/04/3, L-5 — open, не входили
  в блокеры приёмки; поведение не менялось.

## Проверки

1. `npm test` — 489/489 pass (в счётчике также untracked `server/terminal-env.test.ts`
   от AGENTHOS-28; работа AGENTHOS-28 как доказательство не использовалась).
2. `npm run typecheck` — три tsconfig (app, server, e2e) pass.
3. `npm run build` — pass; xterm остаётся ленивым чанком `TerminalEmulator-*.js`.
4. `npm run test:e2e -- e2e/terminal.spec.ts` — 7/7 pass (повторный прогон; первый упал
   в `beforeEach` из-за незапустившегося mock-хоста на общем стенде, к коду не относится).
5. Живой smoke на local (backend 8090, хост 8089, панель 5173): два PTY в `/tmp` получили
   подписи «tmp» и «tmp 2», после F5 подписи и выбор сохранились, оба PTY закрыты; в root
   хост отдавал им `title: "bash"` (проба через backend). Оба PTY после smoke закрыты.

## Осталось

1. Некритичные замечания Gate (C-3/C-5, ARCH-1..ARCH-4, COMPAT-27-02/04/05, quality:Q-5/Q-6/Q-7,
   correctness:C-4/D-1) не исправлялись: они не блокировали приёмку и не входили в объём этой
   правки. Переносить в отдельную задачу по списку из реестра находок.

## Ограничения

- Свои PTY одного backend видны всем его браузерам (общий `clientId`); подписи строк живут
  в `localStorage` браузера, поэтому в другом браузере имя будет хост-заголовком с хвостом URI.
- Хост без `root.terminals` не восстановит набор после F5 (ограничение хоста, описано в README).
- До восьми смонтированных xterm (5000 строк scrollback); память не измерялась.
- Подписи строк не чистятся, когда PTY закрыт с другого устройства, автоочисткой или хостом:
  запись остаётся в `acc.terminals.v2.labels` навсегда (quality:Q-5).
