import { createSession, expectCompletedTurn, sendMessage } from './support/app';
import { expect, test } from './support/fixtures';

test('копирует display text завершённого ответа', async ({ app }) => {
  const answer = 'Учебный ответ на сообщение: «скопируй меня».';
  await createSession(app);
  await sendMessage(app, 'скопируй меня');
  await expect(app.getByText(answer)).toBeVisible();
  await expectCompletedTurn(app);

  await app.bringToFront();
  await app.getByRole('button', { name: 'Скопировать ответ' }).click();
  await expect(app.getByText('Ответ скопирован')).toBeVisible();
  await expect.poll(() => app.evaluate(() => navigator.clipboard.readText())).toBe(answer);
});
