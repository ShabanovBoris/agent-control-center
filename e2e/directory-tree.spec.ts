import { expect, test } from './support/fixtures';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('дерево папок на телефоне: навигация, выбор и createSession', async ({ app }) => {
  await app.getByRole('button', { name: 'Новая сессия' }).click();
  await expect(app.getByRole('heading', { name: 'Новая сессия' })).toBeVisible();
  const field = app.getByRole('textbox', { name: 'Рабочая папка на хосте' });
  await expect(field).toHaveValue('/mock/workspace');

  await app.getByRole('button', { name: 'Дерево папок' }).click();
  await expect(app.locator('.directory-tree-path')).toHaveText('/mock/workspace');
  // Панель занимает ширину формы, а не узкий flex-сосед кнопки; строки — тач-размера.
  const widths = await app.evaluate(() => ({
    panel: document.querySelector('.directory-tree-panel')?.getBoundingClientRect().width ?? 0,
    form: document.querySelector('.new-session')?.getBoundingClientRect().width ?? 0,
  }));
  expect(widths.panel).toBeGreaterThan(widths.form * 0.8);
  const rowHeight = (await app.getByRole('button', { name: 'src', exact: true }).boundingBox())?.height ?? 0;
  expect(rowHeight).toBeGreaterThanOrEqual(44);
  // Каталоги раньше файлов; файл — не кнопка и не открывается.
  const rows = app.locator('.directory-tree-list > li');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('docs');
  await expect(rows.nth(1)).toContainText('src');
  await expect(rows.nth(2)).toContainText('README.md');
  await expect(rows.nth(2).locator('button')).toHaveCount(0);

  await app.getByRole('button', { name: 'src', exact: true }).click();
  await expect(app.locator('.directory-tree-path')).toHaveText('/mock/workspace/src');
  await app.getByRole('button', { name: 'components', exact: true }).click();
  await expect(app.locator('.directory-tree-path')).toHaveText('/mock/workspace/src/components');
  await expect(app.getByText('В папке нет элементов.')).toBeVisible();

  await app.getByRole('button', { name: '‹ Вверх' }).click();
  await expect(app.locator('.directory-tree-path')).toHaveText('/mock/workspace/src');
  await app.getByRole('button', { name: 'components', exact: true }).click();

  const overflow = await app.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'страница шире viewport').toBeLessThanOrEqual(0);

  await app.getByRole('button', { name: 'Выбрать эту папку' }).click();
  await expect(app.getByRole('button', { name: 'Дерево папок' })).toBeVisible();
  await expect(field).toHaveValue('/mock/workspace/src/components');

  const previousHash = await app.evaluate(() => location.hash);
  await app.getByRole('button', { name: 'Создать' }).click();
  await expect.poll(() => app.evaluate(() => location.hash)).not.toBe(previousHash);
  await expect(app.locator('.session-subtitle')).toContainText('/mock/workspace/src/components');
});

test('ошибка дерева показывается текстом и не ломает форму', async ({ app }) => {
  await app.getByRole('button', { name: 'Новая сессия' }).click();
  const field = app.getByRole('textbox', { name: 'Рабочая папка на хосте' });
  await field.fill('/mock/missing');

  await app.getByRole('button', { name: 'Дерево папок' }).click();
  await expect(app.getByRole('alert')).toContainText('не найдена');
  await expect(app.locator('.directory-tree-path')).toHaveText('/mock/missing');
  await expect(field).toHaveValue('/mock/missing');
  await expect(app.getByRole('heading', { name: 'Новая сессия' })).toBeVisible();
  await expect(app.getByRole('button', { name: 'Создать' })).toBeEnabled();

  await app.getByRole('button', { name: 'Скрыть дерево' }).click();
  await expect(app.locator('.directory-tree-panel')).toHaveCount(0);
  await expect(app.getByRole('button', { name: 'Дерево папок' })).toBeVisible();
});
