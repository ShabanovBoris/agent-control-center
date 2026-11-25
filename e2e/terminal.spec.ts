import type { Page } from '@playwright/test';
import { expect, test } from './support/fixtures';

/** Панель выбранного терминала: скрытые панели остаются в DOM, но невидимы. */
function activePane(page: Page) {
  return page.locator('.terminal-pane[data-active="true"]');
}

/** Текст, который эмулятор реально нарисовал: DOM-рендер xterm отдаёт строки в `.xterm-rows`. */
async function screenText(page: Page): Promise<string> {
  return activePane(page).innerText();
}

/** Строка списка по подписи: сохранённое при создании имя папки (у второго PTY — с номером). */
function terminalRow(page: Page, title: string) {
  return page.locator('.terminal-row').filter({ has: page.locator('.terminal-row-title', { hasText: new RegExp(`^${title}$`) }) });
}

/** Кнопка закрытия конкретной строки: `×` лежит рядом с `.terminal-row` внутри `li`. */
function terminalRowClose(page: Page, title: string) {
  const item = page.locator('.terminal-list > li').filter({ has: page.locator('.terminal-row-title', { hasText: new RegExp(`^${title}$`) }) });
  return item.getByRole('button', { name: `Закрыть терминал «${title}»` });
}

async function openTerminal(page: Page): Promise<void> {
  const heading = page.getByRole('heading', { name: 'Терминал', exact: true });
  // На мобильном открытый detail скрывает сайдбар с кнопкой «Терминал»:
  // страница уже открыта — повторный клик по невидимой кнопке не нужен.
  if (await heading.isVisible()) return;
  await page.getByRole('button', { name: 'Терминал', exact: true }).click();
  await expect(heading).toBeVisible();
}

/**
 * Чистый старт теста: mock-хост и backend общие на worker, поэтому PTY предыдущего
 * теста видны следующему через overview. Закрываем их до открытия нового — кнопкой
 * на строке, без переключения экрана.
 */
async function closeAllTerminals(page: Page): Promise<void> {
  await openTerminal(page);
  await expect(page.locator('.terminal-list, .terminal-form').first()).toBeVisible();
  const rows = page.locator('.terminal-row');
  const closes = page.locator('.terminal-row-close');
  for (let guard = 0; guard < 12; guard += 1) {
    const count = await rows.count();
    if (count === 0) return;
    await closes.first().click();
    await expect(rows).toHaveCount(count - 1);
  }
}

/** Ввод идёт в фокус выбранного xterm: клик по экрану ставит его так же, как это сделал бы человек. */
async function typeInTerminal(page: Page, text: string): Promise<void> {
  // Эмулятор грузится ленивым чанком: до появления xterm ввод просто потерялся бы.
  await expect(activePane(page).locator('.terminal-screen .xterm-rows')).toBeVisible();
  await activePane(page).locator('.terminal-screen').click();
  await page.keyboard.type(text, { delay: 10 });
  await page.keyboard.press('Enter');
}

test.beforeEach(async ({ app }) => {
  await closeAllTerminals(app);
});

test('терминал на mock: открыть, выполнить команду, увидеть вывод и код выхода, закрыть', async ({ app }) => {
  await openTerminal(app);
  await expect(app.getByRole('textbox', { name: 'Папка терминала на хосте' })).toHaveValue('/mock/workspace');
  await app.getByRole('button', { name: 'Открыть терминал' }).click();
  await expect(app.locator('.terminal-status')).toContainText('/mock/workspace');
  await expect(app.locator('.terminal-status')).toContainText('выполняется');

  await typeInTerminal(app, 'echo hello');
  await expect.poll(() => screenText(app)).toContain('hello');

  await typeInTerminal(app, 'exit 7');
  await expect(app.locator('.terminal-status')).toContainText('завершён · код 7');
  // Вывод, набранный до выхода, остаётся на экране: статус не стирает историю.
  expect(await screenText(app)).toContain('hello');
});

test('F5 и возврат на страницу подхватывают тот же shell, «Закрыть» убирает его', async ({ app }) => {
  await openTerminal(app);
  await app.getByRole('button', { name: 'Открыть терминал' }).click();
  await expect(app.locator('.terminal-status')).toContainText('выполняется');
  await typeInTerminal(app, 'echo marker-42');
  await expect.poll(() => screenText(app)).toContain('marker-42');

  // Уход со страницы не убивает PTY: возврат через кнопку подхватывает ту же сессию терминала.
  await app.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await openTerminal(app);
  await expect.poll(() => screenText(app)).toContain('marker-42');

  await app.reload();
  await expect(app.getByRole('heading', { name: 'Терминал', exact: true })).toBeVisible();
  await expect.poll(() => screenText(app)).toContain('marker-42');

  // Закрытие кнопкой на строке: она одна, поэтому подпись — имя единственного PTY.
  await app.locator('.terminal-row-close').click();
  await expect(app.getByRole('button', { name: 'Открыть терминал' })).toBeVisible();
  // После закрытия сохранённый URI забыт: повторное открытие создаёт новый PTY.
  await app.getByRole('button', { name: 'Открыть терминал' }).click();
  await expect.poll(() => screenText(app)).not.toContain('marker-42');
});

test('F5 возвращает к терминалу не по папке по умолчанию, а по последней открытой', async ({ app }) => {
  await openTerminal(app);
  await app.getByRole('textbox', { name: 'Папка терминала на хосте' }).fill('/mock/workspace/src');
  await app.getByRole('button', { name: 'Открыть терминал' }).click();
  await expect(app.locator('.terminal-status .terminal-cwd')).toHaveText('/mock/workspace/src');
  await typeInTerminal(app, 'echo subdir-marker');
  await expect.poll(() => screenText(app)).toContain('subdir-marker');

  await app.reload();
  // Выбор пережил перезагрузку: страница не показала форму и не создала второй PTY.
  await expect(app.locator('.terminal-status .terminal-cwd')).toHaveText('/mock/workspace/src');
  await expect.poll(() => screenText(app)).toContain('subdir-marker');
});

test('кириллица и текст из IME/мобильной клавиатуры доходят до PTY', async ({ app }) => {
  await openTerminal(app);
  await app.getByRole('button', { name: 'Открыть терминал' }).click();
  await expect(app.locator('.terminal-status')).toContainText('выполняется');
  await expect(activePane(app).locator('.terminal-screen .xterm-rows')).toBeVisible();

  // Русская раскладка и мобильная клавиатура присылают символы не keypress, а input-событием
  // в скрытую textarea. При screenReaderMode xterm такие события игнорирует, и в PTY не
  // приходит ничего — этот сценарий ловится здесь.
  await activePane(app).locator('.terminal-screen').click();
  await app.keyboard.type('echo привет', { delay: 10 });
  await app.keyboard.press('Enter');
  await expect.poll(() => screenText(app)).toContain('привет');

  // IME и вставка: тот же путь через input/composition, без отдельных keypress.
  await activePane(app).locator('.xterm-helper-textarea').evaluate((element: HTMLTextAreaElement) => {
    element.focus();
    element.value = 'вставка';
    element.dispatchEvent(new InputEvent('input', { data: 'вставка', inputType: 'insertText', bubbles: true, cancelable: true }));
  });
  await app.keyboard.press('Enter');
  await expect.poll(() => screenText(app)).toContain('вставка');
});

test('телефон 390×844: терминал без горизонтального скролла, клавиатура не ломает раскладку', async ({ app }) => {
  await app.setViewportSize({ width: 390, height: 844 });
  await openTerminal(app);
  await app.getByRole('button', { name: 'Открыть терминал' }).click();
  await expect(app.locator('.terminal-status')).toContainText('выполняется');
  await typeInTerminal(app, 'echo '.concat('x'.repeat(200)));
  await expect.poll(() => screenText(app)).toContain('xxxx');

  const overflow = await app.evaluate(() => {
    const screen = document.querySelector<HTMLElement>('.terminal-pane[data-active="true"] .terminal-screen');
    if (!screen) throw new Error('Экран терминала не найден');
    const list = document.querySelector<HTMLElement>('.terminal-list');
    const keyboard = visualViewport ? visualViewport.height : window.innerHeight;
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      screen: screen.scrollWidth - screen.clientWidth,
      list: list ? list.scrollWidth - list.clientWidth : 0,
      height: screen.getBoundingClientRect().bottom,
      keyboard,
    };
  });
  // Длинная строка переносится внутри xterm, а не растягивает страницу.
  expect(overflow.page, 'страница шире viewport').toBeLessThanOrEqual(0);
  expect(overflow.screen, 'экран терминала шире viewport').toBeLessThanOrEqual(0);
  expect(overflow.list, 'список терминалов шире viewport').toBeLessThanOrEqual(0);
  // Уменьшение visualViewport (клавиатура) не выносит экран за пределы видимой области.
  expect(overflow.height).toBeLessThanOrEqual(overflow.keyboard + 1);

  // Кнопка закрытия живёт на самой строке: не вылезает за её край и остаётся нажимаемой.
  const close = await app.locator('.terminal-list > li').first().evaluate(item => {
    const row = item.querySelector('.terminal-row')!.getBoundingClientRect();
    const button = item.querySelector('.terminal-row-close')!.getBoundingClientRect();
    return {
      inside: button.left >= row.left && button.right <= row.right && button.top >= row.top && button.bottom <= row.bottom,
      width: button.width,
      height: button.height,
    };
  });
  expect(close.inside, '× вылезла за строку').toBe(true);
  expect(close.width, '× слишком узкая для пальца').toBeGreaterThanOrEqual(24);
  expect(close.height, '× слишком низкая для пальца').toBeGreaterThanOrEqual(24);
});

test('два терминала: переключение без закрытия, чёрная обводка, F5 и закрытие одного', async ({ app }) => {
  await openTerminal(app);
  await expect(app.getByRole('textbox', { name: 'Папка терминала на хосте' })).toHaveValue('/mock/workspace');
  await app.getByRole('button', { name: 'Открыть терминал' }).click();
  await expect(app.locator('.terminal-row')).toHaveCount(1);
  await typeInTerminal(app, 'echo marker-one');
  await expect.poll(() => screenText(app)).toContain('marker-one');

  // Второй PTY в другой папке: форма всегда создаёт новый терминал, старый живёт.
  await app.getByRole('button', { name: 'Новый терминал' }).click();
  await app.getByRole('textbox', { name: 'Папка терминала на хосте' }).fill('/mock/workspace/src');
  await app.getByRole('button', { name: 'Открыть терминал' }).click();
  await expect(app.locator('.terminal-row')).toHaveCount(2);
  await typeInTerminal(app, 'echo marker-two');
  await expect.poll(() => screenText(app)).toContain('marker-two');

  // Переключение строкой: первый терминал не закрыт, его вывод на месте.
  await terminalRow(app, 'workspace').click();
  await expect(app.locator('.terminal-status .terminal-cwd')).toHaveText('/mock/workspace');
  await expect.poll(() => screenText(app)).toContain('marker-one');
  await expect(terminalRow(app, 'workspace')).toHaveAttribute('aria-current', 'true');
  await expect(terminalRow(app, 'src')).not.toHaveAttribute('aria-current', 'true');
  await expect(app.locator('.terminal-row[aria-current="true"]')).toHaveCount(1);
  const border = await terminalRow(app, 'workspace').evaluate((element: HTMLElement) => getComputedStyle(element).borderTopColor);
  expect(border, 'выбранная строка обведена чёрным').toBe('rgb(0, 0, 0)');

  await terminalRow(app, 'src').click();
  await expect(app.locator('.terminal-status .terminal-cwd')).toHaveText('/mock/workspace/src');
  await expect.poll(() => screenText(app)).toContain('marker-two');

  // Форма поверх сцены не размонтирует панели: отмена возвращает тот же вывод.
  await app.getByRole('button', { name: 'Новый терминал' }).click();
  await expect(app.locator('.terminal-form')).toBeVisible();
  await app.getByRole('button', { name: 'Отмена' }).click();
  await expect(app.locator('.terminal-form')).toHaveCount(0);
  await expect.poll(() => screenText(app)).toContain('marker-two');

  // Уход со страницы и F5 восстанавливают набор и выбранный терминал.
  await app.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await openTerminal(app);
  await expect(app.locator('.terminal-row')).toHaveCount(2);
  await expect(terminalRow(app, 'src')).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => screenText(app)).toContain('marker-two');

  await app.reload();
  await expect(app.locator('.terminal-row')).toHaveCount(2);
  await expect(terminalRow(app, 'src')).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => screenText(app)).toContain('marker-two');

  // Мобильная раскладка: список и активный экран не шире viewport.
  // После смены viewport xterm пересчитывает сетку через ResizeObserver — ждём refit.
  await app.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => app.evaluate(() => {
    const screen = document.querySelector<HTMLElement>('.terminal-pane[data-active="true"] .terminal-screen');
    return screen ? screen.scrollWidth - screen.clientWidth : 0;
  })).toBeLessThanOrEqual(0);
  const overflow = await app.evaluate(() => {
    const list = document.querySelector<HTMLElement>('.terminal-list');
    const screen = document.querySelector<HTMLElement>('.terminal-pane[data-active="true"] .terminal-screen');
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      list: list ? list.scrollWidth - list.clientWidth : 0,
      screen: screen ? screen.scrollWidth - screen.clientWidth : 0,
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.list).toBeLessThanOrEqual(0);
  expect(overflow.screen).toBeLessThanOrEqual(0);

  // Закрытие выбранного кнопкой на его строке не убивает второй: остаётся workspace
  // с прежним выводом и принимает новые команды.
  await terminalRowClose(app, 'src').click();
  await expect(app.locator('.terminal-row')).toHaveCount(1);
  await expect(terminalRow(app, 'workspace')).toHaveAttribute('aria-current', 'true');
  await expect(app.locator('.terminal-status .terminal-cwd')).toHaveText('/mock/workspace');
  await expect.poll(() => screenText(app)).toContain('marker-one');
  await typeInTerminal(app, 'echo still-alive');
  await expect.poll(() => screenText(app)).toContain('still-alive');

  await terminalRowClose(app, 'workspace').click();
  await expect(app.locator('.terminal-row')).toHaveCount(0);
  await expect(app.getByRole('button', { name: 'Открыть терминал' })).toBeVisible();
});

test('кнопка × на строке закрывает именно её: неактивная строка не меняет выбранный экран', async ({ app }) => {
  await openTerminal(app);
  await expect(app.getByRole('textbox', { name: 'Папка терминала на хосте' })).toHaveValue('/mock/workspace');
  await app.getByRole('button', { name: 'Открыть терминал' }).click();
  await expect(app.locator('.terminal-row')).toHaveCount(1);
  await typeInTerminal(app, 'echo keep-one');
  await expect.poll(() => screenText(app)).toContain('keep-one');

  await app.getByRole('button', { name: 'Новый терминал' }).click();
  await app.getByRole('textbox', { name: 'Папка терминала на хосте' }).fill('/mock/workspace/src');
  await app.getByRole('button', { name: 'Открыть терминал' }).click();
  await expect(app.locator('.terminal-row')).toHaveCount(2);
  await typeInTerminal(app, 'echo keep-two');
  await expect.poll(() => screenText(app)).toContain('keep-two');
  await expect(terminalRow(app, 'src')).toHaveAttribute('aria-current', 'true');

  // Кнопка есть у каждой строки и называет свой терминал, а не выбранный.
  await expect(app.locator('.terminal-row-close')).toHaveCount(2);
  await expect(app.getByRole('button', { name: 'Закрыть терминал «workspace»' })).toBeVisible();
  await expect(app.getByRole('button', { name: 'Закрыть терминал «src»' })).toBeVisible();

  // Закрываем невыбранную строку: экран остаётся на src, вывод не подменяется.
  await terminalRowClose(app, 'workspace').click();
  await expect(app.locator('.terminal-row')).toHaveCount(1);
  await expect(terminalRow(app, 'src')).toHaveAttribute('aria-current', 'true');
  await expect(app.locator('.terminal-status .terminal-cwd')).toHaveText('/mock/workspace/src');
  await expect.poll(() => screenText(app)).toContain('keep-two');
  await typeInTerminal(app, 'echo src-alive');
  await expect.poll(() => screenText(app)).toContain('src-alive');
});

test('два PTY в одной папке: строки различимы и не превращаются в title хоста после overview', async ({ app }) => {
  await openTerminal(app);
  await expect(app.getByRole('textbox', { name: 'Папка терминала на хосте' })).toHaveValue('/mock/workspace');
  await app.getByRole('button', { name: 'Открыть терминал' }).click();
  await expect(app.locator('.terminal-row')).toHaveCount(1);
  await typeInTerminal(app, 'echo same-folder-one');
  await expect.poll(() => screenText(app)).toContain('same-folder-one');

  // Второй PTY создаётся в той же папке: форма подставляет cwd активного терминала.
  await app.getByRole('button', { name: 'Новый терминал' }).click();
  await expect(app.getByRole('textbox', { name: 'Папка терминала на хосте' })).toHaveValue('/mock/workspace');
  await app.getByRole('button', { name: 'Открыть терминал' }).click();
  await expect(app.locator('.terminal-row')).toHaveCount(2);
  await typeInTerminal(app, 'echo same-folder-two');
  await expect.poll(() => screenText(app)).toContain('same-folder-two');

  // Хост отдаёт обоим PTY один и тот же title «bash» (как local-хост), поэтому подписи
  // строк задаёт панель. Имена должны быть разными уже до открытия панели.
  await expect(terminalRow(app, 'workspace')).toHaveCount(1);
  await expect(terminalRow(app, 'workspace 2')).toHaveCount(1);
  await expect(app.locator('.terminal-row-title', { hasText: /^bash/ })).toHaveCount(0);
  await expect(terminalRow(app, 'workspace 2')).toHaveAttribute('aria-current', 'true');

  // Переключение между PTY одной папки сохраняет вывод каждого.
  await terminalRow(app, 'workspace').click();
  await expect.poll(() => screenText(app)).toContain('same-folder-one');
  await expect(terminalRow(app, 'workspace')).toHaveAttribute('aria-current', 'true');
  await terminalRow(app, 'workspace 2').click();
  await expect.poll(() => screenText(app)).toContain('same-folder-two');

  // После F5 строки приходят только из overview (pending пуст): подписи не сбрасываются
  // на хост-заголовок «bash» и остаются тем же набором.
  await app.reload();
  await expect(app.locator('.terminal-row')).toHaveCount(2);
  await expect(terminalRow(app, 'workspace')).toHaveCount(1);
  await expect(terminalRow(app, 'workspace 2')).toHaveCount(1);
  await expect(terminalRow(app, 'workspace 2')).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => screenText(app)).toContain('same-folder-two');

  // Закрытие одного PTY кнопкой на его строке не убивает соседний в той же папке.
  await terminalRowClose(app, 'workspace 2').click();
  await expect(app.locator('.terminal-row')).toHaveCount(1);
  await expect(terminalRow(app, 'workspace')).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => screenText(app)).toContain('same-folder-one');
  await typeInTerminal(app, 'echo same-folder-alive');
  await expect.poll(() => screenText(app)).toContain('same-folder-alive');
});
