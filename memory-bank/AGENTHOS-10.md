# AGENTHOS-10 — поддержка markdown

Область: только `ResponsePartKind.Markdown` в ответе агента. `Message.text`, `MessageView`, `debug-ui/panel.js`,
описания инструментов, `SystemNotification`, `InputRequest`, `ContentRef` и вывод инструментов не менялись.
Внешние картинки не загружаются: показывается ссылка с alt, изображением рендерится только `data:image/`.

- [x] Зависимости: `react-markdown@10.1.0`, `remark-gfm@4.0.1` (точные версии), lockfile обновлён.
- [x] `src/markdown-stream.ts`: `trimLeadingBlankLines`, конкатенация соседних markdown-частей как display text SDK
      (без вставляемого разделителя), границы на tool/reasoning, стабильные ключи блоков, `agentResponseText`,
      `completedResponseText` (гейт `TurnState.Complete`), тип `NonMarkdownPart`.
- [x] `src/ui/MarkdownMessage.tsx`: GFM, безопасные ссылки, фильтр URL, заголовки через `role="heading"`,
      картинки только `data:image/`.
- [x] `src/SessionView.tsx`: `TurnView` рендерит `layoutParts`, markdown-ветка и `trimStart` из `PartView` удалены;
      копирование и форк используют `completedResponseText`, `PartView` типизирован `NonMarkdownPart`.
- [x] `src/styles.css`: блок `.markdown-message` (списки, заголовки, код, цитаты, ссылки, картинки), task-list
      без дублирующего маркера списка, `.markdown-table` прокручивается внутри себя. Правило `.message` не менялось.
- [x] Тесты: `src/markdown-stream.test.ts`, `src/markdown-message.test.ts`; `src/copy-response.*` удалены.
- [x] README: компонент MarkdownMessage, контракт копирования и ограничения (нет подсветки синтаксиса, внешние
      картинки ссылкой, мягкий перенос GFM).
- [x] Проверки 23.11.2026 после правок Gate: `npm test` 125/125, `npm run typecheck`, `npm run build` (505.49 kB /
      gzip 153.52 kB), `git diff --check` чисто.
- [x] Проверка CSS в headless Chromium (chrome-headless-shell из кэша Playwright) на реальном `src/styles.css`:
      `li.task-list-item` → `list-style-type: none`, обычный `li` → `disc`; `.markdown-table` при 320 px ленте
      имеет `clientWidth 296`/`scrollWidth 475`, `.transcript` по горизонтали не прокручивается; мягкий перенос —
      `white-space: normal` и один line box. Контрольный прогон без двух правил воспроизвёл дефекты
      (`disc` у task-list, `transcriptScrollWidth 487`).
- [x] Smoke через изолированный backend (порт 8095) и `npm run mock-host`: 34 чанка, 3 части (markdown → tool → markdown),
      2 markdown-блока, копирование отдало финальный блок; история восстановилась из повторного snapshot.
- [ ] Визуальная проверка человеком (тёмная тема, прокрутка, узкий экран) не выполнялась; проверены вычисленные
      стили и геометрия в Chromium, не скриншоты.

## Замечания Gate 23.11.2026 (needs_changes → исправление)

| ID | Статус | Где | Доказательство |
| --- | --- | --- | --- |
| C-1 дублирующий маркер у GFM task-list | resolved | `src/styles.css:358` | правило `ul.contains-task-list > li.task-list-item { list-style: none }`; Chromium: `listStyleType` = `none`, у обычного `li` = `disc`; SSR-структура task-list в `src/markdown-message.test.ts` |
| Q-01 / C-2 / compat-2 склейка частей через `\n` | resolved | `src/markdown-stream.ts`, `layoutParts` | конкатенация без разделителя, как display text SDK; тесты «конкатенируются без разделителя», «пустые строки срезаются только в начале блока»; копирование отдаёт ровно display text |
| Q-03 / compat-4 таблица без `overflow-x` | resolved | `src/styles.css:371` | `.markdown-table { max-width: 100%; overflow-x: auto }`; Chromium: таблица прокручивается внутри блока, лента — нет |
| Q-02 мягкий перенос схлопывается | resolved | `src/ui/MarkdownMessage.tsx`, `README.md` | владелец выбрал строгий GFM; README фиксирует поведение, SSR-тест: `a\nb` → абзац без `<br>`, жёсткий перенос (`  \n`) → `<br/>`; Chromium: `white-space: normal`, один line box |
| compat-3 неточная формулировка README | resolved | `README.md` | «markdown последнего непустого блока: части склеены, хвостовые пробелы срезаны» |
| Q-05 `PartView` без ветки Markdown | resolved | `src/SessionView.tsx:449` | параметр сужен до `NonMarkdownPart` (`Exclude<ResponsePart, MarkdownResponsePart>`), инвариант держит тип потока |
| Q-06 потеряно покрытие гейта `TurnState.Complete` | resolved | `src/markdown-stream.ts`, `src/markdown-stream.test.ts` | чистая `completedResponseText(state, parts)`; тест проверяет Complete/Cancelled/Error/undefined и ход без markdown |

## Замечания

- `agentResponseText` срезает хвостовые пробелы и для нескольких соседних markdown-частей отдаёт склеенный финальный
  блок; части конкатенируются без вставки разделителя, как предписывает SDK, ведущий отступ кода сохраняется.
- `vite build` предупреждает о чанке >500 kB (505.49 kB, gzip 153.52 kB) — ожидаемая цена `react-markdown`.
- В рабочем дереве остаются посторонние незакоммиченные правки (README про CheapVibeCode, hosts, gemini-config,
  server/updates.ts); они не затрагивались, правки README внесены только в разделы UI/Ограничения.
