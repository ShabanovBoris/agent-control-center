import { backToSessionList, createSession, openSession, sendMessage, sessionRow } from './support/app';
import { expect, test } from './support/fixtures';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('badge непрочитанных виден в мобильном списке, хотя сессия остаётся выбранной', async ({ app }) => {
  const title = await createSession(app);
  await sendMessage(app, 'tool markdown');
  const card = app.locator('.tool-call');
  await expect(card).toContainText('Ждёт подтверждения');
  await card.getByRole('button', { name: 'Разрешить', exact: true }).click();

  // Detail скрыт, но selection сохраняется: badge не должен зависеть от подсветки строки.
  await backToSessionList(app);
  const row = sessionRow(app, title);
  await expect(row).toHaveClass(/session-row-selected/);
  await expect(row.locator('.session-unread')).toHaveText('1', { timeout: 30_000 });

  // Открытие сессии отправляет presence и сбрасывает счётчик, а не только скрывает badge.
  await openSession(app, title);
  await expect(app.locator('.session-head h2')).toHaveText(title);
  await backToSessionList(app);
  await expect(sessionRow(app, title).locator('.session-unread')).toHaveCount(0, { timeout: 15_000 });

  const overflow = await app.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>('.sidebar');
    if (!sidebar) throw new Error('Список сессий не найден');
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      sidebar: sidebar.scrollWidth - sidebar.clientWidth,
    };
  });
  expect(overflow.page, 'страница шире viewport').toBeLessThanOrEqual(0);
  expect(overflow.sidebar, 'список сессий шире viewport').toBeLessThanOrEqual(0);
});
