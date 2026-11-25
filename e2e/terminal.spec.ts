import { expect, test } from './support/fixtures';

/** Текст, который эмулятор реально нарисовал: DOM-рендер xterm отдаёт строки в `.xterm-rows`. */
async function screenText(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('.terminal-screen').innerText();
}

async function openTerminal(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Терминал', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Терминал', exact: true })).toBeVisible();
}

/** Ввод идёт в фокус xterm: клик по экрану ставит его так же, как это сделал бы человек. */
async function typeInTerminal(page: import('@playwright/test').Page, text: string): Promise<void> {
  // Эмулятор грузится ленивым чанком: до появления xterm ввод просто потерялся бы.
  await expect(page.locator('.terminal-screen .xterm-rows')).toBeVisible();
  await page.locator('.terminal-screen').click();
  await page.keyboard.type(text, { delay: 10 });
  await page.keyboard.press('Enter');
}

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

  await app.getByRole('button', { name: 'Закрыть терминал' }).click();
  await expect(app.getByRole('button', { name: 'Открыть терминал' })).toBeVisible();
  // После «Закрыть» сохранённый URI забыт: повторное открытие создаёт новый PTY.
  await app.getByRole('button', { name: 'Открыть терминал' }).click();
  await expect.poll(() => screenText(app)).not.toContain('marker-42');
});

test('F5 возвращает к терминалу не по папке по умолчанию, а по последней открытой', async ({ app }) => {
  await openTerminal(app);
  await app.getByRole('textbox', { name: 'Папка терминала на хосте' }).fill('/mock/workspace/src');
  await app.getByRole('button', { name: 'Открыть терминал' }).click();
  await expect(app.locator('.terminal-status')).toContainText('/mock/workspace/src');
  await typeInTerminal(app, 'echo subdir-marker');
  await expect.poll(() => screenText(app)).toContain('subdir-marker');

  await app.reload();
  // Папка по умолчанию другая: без запомненной пары страница показала бы форму и создала второй PTY.
  await expect(app.locator('.terminal-status')).toContainText('/mock/workspace/src');
  await expect.poll(() => screenText(app)).toContain('subdir-marker');
});

test('кириллица и текст из IME/мобильной клавиатуры доходят до PTY', async ({ app }) => {
  await openTerminal(app);
  await app.getByRole('button', { name: 'Открыть терминал' }).click();
  await expect(app.locator('.terminal-status')).toContainText('выполняется');
  await expect(app.locator('.terminal-screen .xterm-rows')).toBeVisible();

  // Русская раскладка и мобильная клавиатура присылают символы не keypress, а input-событием
  // в скрытую textarea. При screenReaderMode xterm такие события игнорирует, и в PTY не
  // приходит ничего — этот сценарий ловится здесь.
  await app.locator('.terminal-screen').click();
  await app.keyboard.type('echo привет', { delay: 10 });
  await app.keyboard.press('Enter');
  await expect.poll(() => screenText(app)).toContain('привет');

  // IME и вставка: тот же путь через input/composition, без отдельных keypress.
  await app.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    if (!textarea) throw new Error('Скрытая textarea xterm не найдена');
    textarea.focus();
    textarea.value = 'вставка';
    textarea.dispatchEvent(new InputEvent('input', { data: 'вставка', inputType: 'insertText', bubbles: true, cancelable: true }));
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
    const screen = document.querySelector<HTMLElement>('.terminal-screen');
    if (!screen) throw new Error('Экран терминала не найден');
    const keyboard = visualViewport ? visualViewport.height : window.innerHeight;
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      screen: screen.scrollWidth - screen.clientWidth,
      height: screen.getBoundingClientRect().bottom,
      keyboard,
    };
  });
  // Длинная строка переносится внутри xterm, а не растягивает страницу.
  expect(overflow.page, 'страница шире viewport').toBeLessThanOrEqual(0);
  expect(overflow.screen, 'экран терминала шире viewport').toBeLessThanOrEqual(0);
  // Уменьшение visualViewport (клавиатура) не выносит экран за пределы видимой области.
  expect(overflow.height).toBeLessThanOrEqual(overflow.keyboard + 1);
});
