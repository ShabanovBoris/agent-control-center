# AGENTHOS-16 — копирование и подсветка кода в markdown

Ветка `AGENTHOS-16`, база `e74368d` (AGENTHOS-14 в `main`). Реализация в рабочем дереве worktree;
коммит и PR не создавались (по условию задачи нужен явный запрос).

## Что сделано

- **Зависимости.** `lowlight@3.3.0`, `highlight.js@11.11.2` (грамматики импортируются напрямую),
  `hast-util-to-jsx-runtime@2.3.7` как прямая runtime-зависимость, `@types/hast@3.0.5` в dev.
  Одна версия каждого пакета, дубля `highlight.js` нет.
- **Чистые модули.** [src/errors.ts](../src/errors.ts) теперь содержит `CallCancelled`, `CallRejected`
  и `describeError`; [src/store.ts](../src/store.ts) импортирует и реэкспортирует их, поэтому
  существующие импорты не менялись. [src/clipboard.ts](../src/clipboard.ts) — `copyText`/`browserClipboard`
  без `store` и DOM на уровне модуля, чтобы markdown-цепочка оставалась SSR-безопасной.
- **Копирование ответа.** `TurnView.copyResponse` переведён на `copyText`; тексты toast не изменились.
- **CodeBlock.** [src/ui/CodeBlock.tsx](../src/ui/CodeBlock.tsx): wrapper `.code-block` с header,
  язык из `language-*`, доступная кнопка «Скопировать код», toast успеха/ошибки через `onNotify`,
  галочка на 2 секунды, отмена устаревшего `import()` при смене кода. Fallback без `node` —
  обычный `<pre>` без кнопки.
- **Подсветка.** [src/highlight.ts](../src/highlight.ts) — статический `createLowlight` с 13 грамматиками
  (`typescript`, `javascript`, `json`, `bash`, `python`, `go`, `rust`, `sql`, `yaml`, `diff`, `xml`,
  `css`, `markdown`) и `toJsxRuntime`; модуль грузится только динамически из `CodeBlock`, поэтому
  грамматики не попадают в entry. Неизвестный язык и ошибка грамматики → plain-код.
- **Интеграция.** [MarkdownMessage.tsx](../src/ui/MarkdownMessage.tsx) переопределяет `pre` через
  `useMemo` по `onNotify`; `TurnView` передаёт стабильный `useCallback`-колбэк в `store.notify`.
- **Стили.** [styles.css](../src/styles.css): header и кнопка, токены `--code-*` для светлой и тёмной
  темы, `pre` внутри wrapper без собственных margin/фона; `.turn-action` переиспользован.
- **Тесты.** `src/clipboard.test.ts` (4), `src/highlight.test.ts` (5), обновлённые SSR-проверки
  markdown: wrapper/кнопка, indented-код, неизвестный язык, `vscode://` остаётся `<span>`.
- **Документация.** README: размеры сборки, ограничения, описание `MarkdownMessage`.

## Замеры

| Метрика | До | После | Прирост |
| --- | --- | --- | --- |
| entry JS | 537.82 kB / gzip 163.31 kB | 542.24 kB / gzip 164.67 kB | +4.42 kB / +1.36 kB gzip |
| CSS | 24.21 kB / gzip 5.44 kB | 25.88 kB / gzip 5.82 kB | +1.67 kB / +0.38 kB gzip |
| lazy `highlight-*.js` | — | 70.99 kB / gzip 23.59 kB | только при первом блоке с языком |

`rg 'hljs-|createLowlight'` по entry — пусто; `accesslog|arduino|monkey` в `dist/assets` — пусто;
`highlight` в `dist/index.html` — пусто (чанк не прелоадится). `hast-util-to-jsx-runtime` уже был в
entry через `react-markdown`, поэтому рендерер не даёт отдельного прироста.

### Почему lowlight, а не refractor/shiki

Замер esbuild (minify, ESM): `lowlight` + 13 грамматик — 74.8 kB raw / 24.1 kB gzip; `refractor@5`
с теми же языками — 65.6 kB / 24.0 kB gzip (выигрыша нет, другая модель); `shiki@3` — ~598 kB
unpacked, отклонён. Ловушка: `await import('lowlight')` с доступом к namespace сохраняет все экспорты
`all`/`common` и даёт чанк ~1.08 MB / 305 kB gzip. Поэтому в `src/highlight.ts` статический
named-import, а ленивым является сам модуль.

## Проверки

| Команда | Результат |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm test` | **240/240** pass (было 230) |
| `npm test --prefix debug-ui` | 4/4 pass |
| `npm run build` | exit 0, warning >500 kB не подавлен |
| `npm ci --dry-run` | lockfile валиден |
| `git diff --check` | OK |

### Chromium (headless shell 1255, CDP, Vite dev)

Временный harness в `.local/` (gitignored): `MarkdownMessage` + `onNotify`, кнопка «показать
markdown», desktop и viewport 360×640. 17/17 проверок:

- до рендера markdown запросов `highlight` нет, после — есть; классы `hljs-keyword` появились;
- trusted click скопировал точный исходный текст ts-блока (включая перевод строки), toast
  «Код скопирован», `title`/галочка; второй блок скопировал свой текст (`graph TD;`), кнопки есть
  у всех трёх блоков, включая indented и неизвестный язык;
- desktop: `pre` скроллится внутри (1581 > 894); mobile 360: `documentElement.scrollWidth = 360`,
  блок и кнопка в viewport, `pre` скроллится (1581 > 334), копирование работает;
- ошибка clipboard: после `Browser.resetPermissions` toast
  «Не удалось скопировать код: Failed to execute 'writeText' on 'Clipboard': Write permission denied.»,
  страница не падает; тёмная тема: токен keyword `rgb(217, 160, 255)` отличается от текста.

Ограничения проверки: clipboard проверялся в headless Chromium с выданными разрешениями, не в
обычном профиле macOS; ленивость в dev подтверждена сетевыми записями, а в production — раскладкой
чанков сборки (отдельный `highlight-*.js`, отсутствие грамматик и `hljs-` в entry). iOS/Safari
не проверялись.

## Осознанные ограничения

- Подсветка только для блоков с `language-*`; автоопределение языка не делается.
- Indented-код тоже получает кнопку: react-markdown 10 отдаёт общий `pre` для fenced и indented.
- Ссылки `file:line`/`vscode://` не добавлялись: `safeLink`/`urlTransform` пропускают только
  `http:`, `https:`, `mailto:` и относительные пути, рабочая папка в `MarkdownMessage` не передаётся,
  а наличие обработчика протокола браузер достоверно не определяет. Зафиксировано тестом и README.
- Карточки инструментов подсветку не используют — там нет `MarkdownMessage`.
- Ошибки clipboard показываются текстом браузера после русского префикса, как и у копирования ответа.
- Чанк `highlight-*.js` запрашивается при первом блоке с меткой `language-*`, даже если грамматика
  не зарегистрирована: проверка языка живёт внутри `highlight.ts`. Отказ от импорта потребовал бы
  статического списка языков — второго источника истины или вытягивания модуля в entry.

## Проверка совместимости с текущим `main`

На момент Gate `origin/main` ушёл на 4 коммита вперёд базы (AGENTHOS-20/21: usage, health).
`git merge-tree origin/main` с рабочим деревом AGENTHOS-16 конфликтов не даёт. В одноразовом
worktree на объединённом дереве (плюс новые untracked-файлы задачи): `npm run typecheck` exit 0,
`npm test` **297/297**, `npm run build` exit 0 — entry 565.70 kB / gzip 170.94 kB (вырос из-за
`main`, не из-за подсветки), ленивый `highlight-*.js` 70.99 kB / 23.59 kB, `npm ci --dry-run` OK.
После ребейза размеры в README нужно перемерить; зафиксированный прирост AGENTHOS-16
(+4.42 kB / +1.36 kB gzip на базе `e74368d`) от этого не меняется.
