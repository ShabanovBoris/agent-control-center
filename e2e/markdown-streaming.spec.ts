import { createSession, expectCompletedTurn, sendMessage } from './support/app';
import { expect, test } from './support/fixtures';

test('стримит markdown с заголовком, списком и таблицей', async ({ app }) => {
  await createSession(app);
  await sendMessage(app, 'markdown');

  // Пока ход активен, эхо уже видно: пользователь наблюдает частичный ответ, а не пустоту.
  await expect(app.getByRole('button', { name: 'Остановить' })).toBeVisible();
  await expect(app.getByText('Учебный ответ на сообщение: «markdown».')).toBeVisible();

  const answer = app.locator('.markdown-message').filter({ hasText: 'Учебный отчёт' });
  await expect(answer.getByRole('heading', { name: 'Учебный отчёт', level: 2 })).toBeVisible();
  await expect(answer.getByRole('list')).toContainText('Первый пункт');
  await expect(answer.getByRole('list')).toContainText('Второй пункт');
  await expect(answer.getByRole('table')).toBeVisible();
  await expect(answer.getByRole('cell', { name: 'Готово' })).toBeVisible();
  await expect(answer.locator('pre')).toContainText('https://example.test/');

  await expectCompletedTurn(app);
});
