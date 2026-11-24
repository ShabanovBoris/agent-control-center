import { createSession, expectCompletedTurn, sendMessage } from './support/app';
import { expect, test } from './support/fixtures';

test('проводит tool call через подтверждение к результату', async ({ app }) => {
  await createSession(app);
  await sendMessage(app, 'tool');

  await expect(app.getByText('Учебный ответ на сообщение: «tool».')).toBeVisible();
  const card = app.locator('.tool-call');
  await expect(card).toContainText('Запуск команды');
  await expect(card).toContainText('Ждёт подтверждения');

  await card.getByRole('button', { name: 'Разрешить', exact: true }).click();
  await expect(card).toContainText('Выполнен');
  await card.locator('summary').click();
  await expect(card.locator('.tool-result-text')).toContainText('hello from mock');
  await expect(app.getByText('Команда отработала, продолжаю.')).toBeVisible();
  await expectCompletedTurn(app);
});
