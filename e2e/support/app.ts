import { expect, type Locator, type Page } from '@playwright/test';

const CONNECTED_ONE = 'Подключено: 1/1';
const CONNECTED_ANY = /^Подключено: \d+\/\d+$/;

async function detailsOpen(details: Locator): Promise<boolean> {
  // У boolean-атрибута `open` значение '', поэтому getAttribute('open') здесь бесполезен.
  return details.evaluate((element: HTMLDetailsElement) => element.open);
}

/** Доводит единственный mock-хост до состояния «Подключён», не полагаясь на порядок тестов. */
export async function ensureHostConnected(page: Page): Promise<void> {
  const details = page.locator('details.hosts');
  const summary = details.locator('summary');
  await expect(summary.getByText(CONNECTED_ANY)).toBeVisible();

  if (!(await detailsOpen(details))) await summary.click();
  if (!(await summary.getByText(CONNECTED_ONE, { exact: true }).isVisible().catch(() => false))) {
    const reconnect = details.getByRole('button', { name: 'Подключить снова' });
    // Кнопка может исчезнуть между проверкой и кликом: хост успел подключиться сам.
    if (await reconnect.isVisible().catch(() => false)) await reconnect.click().catch(() => undefined);
    await expect(summary.getByText(CONNECTED_ONE, { exact: true })).toBeVisible({ timeout: 20_000 });
  }
  if (await detailsOpen(details)) await summary.click();
}

export async function createSession(page: Page, options: { beforeCreate?: (page: Page) => Promise<void> } = {}): Promise<string> {
  await page.getByRole('button', { name: 'Новая сессия' }).click();
  await expect(page.getByRole('heading', { name: 'Новая сессия' })).toBeVisible();
  // Видимые подписи — «Учебный хост (e2e)» и «Mock Agent», значения селектов остаются mock.
  await expect(page.getByRole('combobox', { name: 'Хост', exact: true })).toHaveValue('mock');
  await expect(page.getByRole('combobox', { name: 'Агент', exact: true })).toHaveValue('mock');
  await expect(page.getByRole('textbox', { name: 'Рабочая папка на хосте' })).toHaveValue('/mock/workspace');

  await options.beforeCreate?.(page);

  // Смена hash — это состояние выбранной сессии; без него форма может ещё показывать старую.
  const previousHash = await page.evaluate(() => location.hash);
  await page.getByRole('button', { name: 'Создать' }).click();
  await expect.poll(() => page.evaluate(() => location.hash)).not.toBe(previousHash);
  const heading = page.locator('.session-head h2');
  await expect(heading).toContainText('Учебная сессия');
  await expect(page.getByRole('textbox', { name: 'Сообщение агенту' })).toBeVisible();
  return (await heading.textContent())?.trim() ?? '';
}

function escapeAttribute(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Строка конкретной сессии. Глобальный `getByTitle` не годится: тот же title есть у `<h2>`
 * в открытой сессии, и строгий режим Playwright упадёт на двух совпадениях.
 */
export function sessionRow(page: Page, title: string): Locator {
  return page.locator('.session-row').filter({ has: page.locator(`.session-title[title="${escapeAttribute(title)}"]`) });
}

export async function sessionTitles(page: Page): Promise<string[]> {
  return page.locator('.session-title').allTextContents();
}

export async function openSession(page: Page, title: string): Promise<void> {
  await sessionRow(page, title).locator('.session-open').click();
}

/** Возврат из открытой сессии к списку на телефоне. */
export async function backToSessionList(page: Page): Promise<void> {
  await page.locator('.mobile-back[aria-label="К списку сессий"]').click();
  await expect(page.locator('.app')).toHaveAttribute('data-mobile-view', 'list');
}

export async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Сообщение агенту' }).fill(text);
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
}

/** Ход завершён, когда у ответа появилась кнопка копирования: она требует полного display text. */
export async function expectCompletedTurn(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Скопировать ответ' }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Остановить' })).toHaveCount(0);
}
