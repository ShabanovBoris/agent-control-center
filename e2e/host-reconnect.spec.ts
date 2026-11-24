import { createSession, expectCompletedTurn, sendMessage } from './support/app';
import { expect, test } from './support/fixtures';

test('переживает обрыв и переподключение хоста', async ({ app, mockHost }) => {
  await createSession(app);
  await sendMessage(app, 'до обрыва');
  await expect(app.getByText('Учебный ответ на сообщение: «до обрыва».')).toBeVisible();
  await expectCompletedTurn(app);

  const details = app.locator('details.hosts');
  const summary = details.locator('summary');
  if (!(await details.evaluate((element: HTMLDetailsElement) => element.open))) await summary.click();

  await mockHost.stop();
  await expect(details.getByText('Переподключение…')).toBeVisible({ timeout: 20_000 });
  await expect(details.locator('.host-problem')).toBeVisible();
  await expect(app.getByText('Хост не подключён: показано последнее известное состояние, команды недоступны.')).toBeVisible();

  // Ручной путь: кликаем, пока хост ещё лежит, и только затем поднимаем процесс.
  await details.getByRole('button', { name: 'Подключить снова' }).click();
  await mockHost.start();
  await expect(summary.getByText('Подключено: 1/1', { exact: true })).toBeVisible({ timeout: 25_000 });
  await expect(details.locator('.host')).toContainText('Подключён');
  if (await details.evaluate((element: HTMLDetailsElement) => element.open)) await summary.click();

  // После рестарта mock-хост пуст: это ожидаемо, продолжаем в новой сессии.
  await createSession(app);
  await sendMessage(app, 'после переподключения');
  await expect(app.getByText('Учебный ответ на сообщение: «после переподключения».')).toBeVisible();
  await expectCompletedTurn(app);
});
