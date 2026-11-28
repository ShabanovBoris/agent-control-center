# Текущий контекст

Снимок от 18 ноября 2026 года. Последнее изменение продукта перед инициализацией Memory Bank — системный выбор рабочей папки на macOS и история последних директорий. Реализация находится в [directory-picker.ts](../server/directory-picker.ts), [recent-directories.ts](../src/recent-directories.ts) и [форме новой сессии](../src/App.tsx).

23 ноября 2026 добавлен рендер markdown-частей ответа агента: [markdown-stream.ts](../src/markdown-stream.ts) нормализует поток частей и конкатенирует соседние markdown-части как display text SDK, [MarkdownMessage.tsx](../src/ui/MarkdownMessage.tsx) рендерит GFM без raw HTML и внешних картинок. Копирование и форк по-прежнему берут исходный markdown финального блока. Подробности и результаты проверок — [AGENTHOS-10.md](AGENTHOS-10.md).

24 ноября 2026 добавлен E2E-контур на Playwright: `npm run test:e2e` поднимает mock-хост, backend
`hosts.e2e.json` на 8096 и Vite на 5175, прогоняет шесть сценариев в Chromium и изолирует состояние
backend через `ACC_STATE_DIR=test-results/state`. Job `e2e` добавлен в CI после `verify`.
Подробности — [AGENTHOS-13.md](AGENTHOS-13.md).

24 ноября 2026 добавлены Web Push-уведомления для PWA: [server/push.ts](../server/push.ts) (VAPID и подписки в `.local`, доставка через `web-push`), [server/push-transitions.ts](../server/push-transitions.ts) (переходы `InputNeeded`, `InProgress → Idle`, ошибка), [server/presence.ts](../server/presence.ts) (подавление на устройстве, где сессия видима), [public/sw.js](../public/sw.js), manifest и иконки, диалог «Уведомления» в [NotificationsButton.tsx](../src/ui/NotificationsButton.tsx). Общие hash- и phase-функции вынесены в [shared/routing.ts](../shared/routing.ts) и [shared/status.ts](../shared/status.ts). Проверено в Chromium; iOS/APNs не проверялись. Подробности — [AGENTHOS-14.md](AGENTHOS-14.md).

24 ноября 2026 в markdown-блоках кода появились копирование и ленивая подсветка: [CodeBlock.tsx](../src/ui/CodeBlock.tsx) добавляет доступную кнопку и грузит [highlight.ts](../src/highlight.ts) отдельным чанком (`lowlight` + `highlight.js`), [clipboard.ts](../src/clipboard.ts) и [errors.ts](../src/errors.ts) вынесены из [store.ts](../src/store.ts), чтобы SSR-тесты оставались без DOM и module-level `Store`. Неизвестный язык и код без метки остаются plain; `file:line`/`vscode://` не открываются. Подробности и замеры — [AGENTHOS-16.md](AGENTHOS-16.md).

24 ноября 2026 добавлена единая команда запуска `npm run up`: [server/up.ts](../server/up.ts) — супервизор с preflight, последовательным запуском хостов и backend/web, проверкой готовности и остановкой по сигналам, [scripts/up.ts](../scripts/up.ts) — CLI. Повторный запуск на живом стенде — no-op с кодом 0, частичный стенд или чужой порт — отказ с кодом 1 без `spawn`; `--prod` не поддерживается. Общая WS-проба backend вынесена в [backend-probe.ts](../scripts/backend-probe.ts), [server/index.ts](../server/index.ts) получил понятную ошибку `listen`. Подробности и результаты smoke — [AGENTHOS-18.md](AGENTHOS-18.md).

25 ноября 2026 появился терминал на отдельной странице `#terminal`: [shared/reduce.ts](../shared/reduce.ts) знает `ahp-terminal:`, [server/terminal-stream.ts](../server/terminal-stream.ts) склеивает `terminal/data` в кадры `terminalData` (33 мс, ≤128 КБ, без потерь), [server/hub.ts](../server/hub.ts) открывает и закрывает PTY и следит за лимитом 8 своих терминалов, [server/terminal-cleanup.ts](../server/terminal-cleanup.ts) закрывает брошенные без наблюдателей, [src/TerminalView.tsx](../src/TerminalView.tsx) и ленивый [TerminalEmulator.tsx](../src/ui/TerminalEmulator.tsx) (xterm.js) дают shell в браузере и на телефоне. Shell запускается без approvals — осознанное решение владельца, отражено в README. После ревью лимит восьми PTY стал атомарным (слот резервируется до создания, вытеснение дожидается dispose), второй наблюдатель больше не получает кадр дважды, буфер вывода не рвёт суррогатную пару, а `ACC_TERMINAL_IDLE_MS` проверяется при старте. Подробности — [AGENTHOS-26.md](AGENTHOS-26.md).

25 ноября 2026 починена подсветка выбора в TUI-агентах панели: PTY наследует env процесса
AHP-хоста, а раннер выставлял `TERM=dumb`, `NO_COLOR`, `CLICOLOR`, `CI` и `FORCE_COLOR`, из-за
чего `kent`/`codex` выбирали Ascii/NoColor. В AHP 1.1.0 у `createTerminal` нет поля `env`,
поэтому нормализация сделана в лаунчерах: [server/terminal-env.ts](../server/terminal-env.ts)
и [scripts/start-responses-host.ts](../scripts/start-responses-host.ts) для wbllm/glm,
[scripts/start-host.sh](../scripts/start-host.sh) для local — `unset` пяти переменных,
`TERM=xterm-256color`, `COLORTERM=truecolor`. Регрессию ловят
[server/terminal-env.test.ts](../server/terminal-env.test.ts) (реальный запуск лаунчера со stub-CLI)
и [e2e/terminal-ansi.spec.ts](../e2e/terminal-ansi.spec.ts) (SGR доезжает до xterm). Переменные
и требование рестарта хостов описаны в README в разделе «Окружение PTY». Подробности —
[AGENTHOS-28.md](AGENTHOS-28.md). Слито PR
[#20](https://github.com/ShabanovBoris/agent-control-center/pull/20) (squash `f6cd10e`).

- Основной хост `8089` обслуживает Claude через cheapvibecode и Codex через ChatGPT. Gemini изолирован на `8091` и работает в среде Codex. Адреса провайдера читаются из локальной конфигурации при запуске.
- 17 ноября сверили опубликованные версии AHP. На дату проверки `1.1.0` была актуальной стабильной версией SDK и спецификации, а `1.2.0` оставалась в разработке. Для текущей версии проекта смотри lockfile, для новых релизов — [changelog AHP](https://github.com/microsoft/agent-host-protocol/blob/main/CHANGELOG.md).
- Версия AHP, согласованная работающими хостами, и фактический список активных skills и MCP по сессиям отдельно не проверялись.
- 25 ноября 2026 (AGENTHOS-27) страница `#terminal` держит несколько PTY: общий список строк внутри страницы, выбранная строка обведена чёрным, все панели смонтированы. Источник списка — `HostOverview.terminals` (root хоста, только свои PTY). Подписка на вывод адресная по каналу, `overviewLoaded` защищает выбор от сброса до первой сводки. По замечаниям Gate имя строки задаёт панель при создании (имя папки и номер повтора) и хранит его по URI — реальный хост отдаёт `title: "bash"` и не переименовывает PTY; README и memory-bank приведены к новой модели доступа. Подробности — [AGENTHOS-27.md](AGENTHOS-27.md).
- 25 ноября 2026 терминал закрывается кнопкой `×` на своей строке: строка остаётся нативной кнопкой выбора, `×` — отдельная кнопка в том же `<li>` поверх её правого края, поэтому вложенной кнопки нет. `closeTerminal(hostId, uri)` адресный: закрытие неактивной строки не меняет выбранный экран, закрытие активной выбирает первый PTY того же хоста. Набор `closingBusy` блокирует `×` в полёте, а `selectRow` игнорирует клик по строке, закрытие которой уже отправлено. Кнопки закрытия терминала в шапке нет.
- 28 ноября 2026 терминал и агентную сессию можно переименовать вручную; имя хранится в `localStorage` этого браузера. Автоимя терминала — первая отправленная непустая команда из `terminal/commandExecuted`, ручное имя приоритетнее. Живая проба вскрыла дефект хоста: у PTY нет UTF-8 локали, поэтому команда с кириллицей не исполняется и портит следующую; починка вынесена отдельной задачей. Подробности — [AGENTHOS-29.md](AGENTHOS-29.md).
