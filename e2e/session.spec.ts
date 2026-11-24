import { createSession, expectCompletedTurn, sendMessage } from './support/app';
import { expect, test } from './support/fixtures';

test('создаёт сессию и отправляет сообщение', async ({ app }) => {
  await createSession(app);
  await expect(app.locator('.session-head h2')).toContainText('Учебная сессия');

  await sendMessage(app, 'привет');

  await expect(app.locator('.message-user')).toContainText('привет');
  await expect(app.getByText('Учебный ответ на сообщение: «привет».')).toBeVisible();
  await expectCompletedTurn(app);
});
