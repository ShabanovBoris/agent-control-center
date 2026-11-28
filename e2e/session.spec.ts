import {
  createSession, ensureHostConnected, expectCompletedTurn, openSession, renameSession,
  sendMessage, sessionRow,
} from './support/app';
import { expect, test } from './support/fixtures';

test('создаёт сессию и отправляет сообщение', async ({ app }) => {
  await createSession(app);
  await expect(app.locator('.session-head h2')).toContainText('Учебная сессия');

  await sendMessage(app, 'привет');

  await expect(app.locator('.message-user')).toContainText('привет');
  await expect(app.getByText('Учебный ответ на сообщение: «привет».')).toBeVisible();
  await expectCompletedTurn(app);
});

test('переименование агентной сессии: невыбранная строка, F5, другой браузер и открытый чат', async ({ app, browser }) => {
  const first = await createSession(app);
  const second = await createSession(app);
  // Вторая сессия только что создана и выбрана: первую переименовываем, не открывая.
  await expect(app.locator('.session-open[aria-current="true"] .session-title')).toHaveText(second);

  await renameSession(app, first, 'Первая переименована');
  await expect(sessionRow(app, 'Первая переименована')).toHaveCount(1);
  await expect(sessionRow(app, first)).toHaveCount(0);
  await expect(app.locator('.session-open[aria-current="true"] .session-title')).toHaveText(second);
  await expect(app.locator('.session-head h2')).toHaveText(second);

  await app.reload();
  await expect(sessionRow(app, 'Первая переименована')).toHaveCount(1);

  // Открытая сессия: список и шапка обновляются одним и тем же ответом хоста.
  await openSession(app, 'Первая переименована');
  await expect(app.locator('.session-head h2')).toHaveText('Первая переименована');
  await renameSession(app, 'Первая переименована', 'Открытая переименована');
  await expect(sessionRow(app, 'Открытая переименована')).toHaveCount(1);
  await expect(app.locator('.session-head h2')).toHaveText('Открытая переименована');

  // Имя принадлежит хосту, а не браузеру: свежий контекст видит его без localStorage.
  const context = await browser.newContext();
  const other = await context.newPage();
  try {
    await other.goto('/');
    await ensureHostConnected(other);
    await expect(sessionRow(other, 'Открытая переименована')).toHaveCount(1);
    await expect(sessionRow(other, second)).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test('отмена и пустое имя не отправляют renameSession', async ({ app }) => {
  const title = await createSession(app);
  const frames: string[] = [];
  app.on('websocket', socket => socket.on('framesent', event => {
    frames.push(typeof event.payload === 'string' ? event.payload : event.payload.toString());
  }));

  const button = () => sessionRow(app, title).getByRole('button', { name: `Переименовать: ${title}`, exact: true });
  await button().click();
  const dialog = app.getByRole('dialog', { name: 'Переименовать сессию' });
  const input = dialog.getByRole('textbox', { name: 'Название сессии' });
  await input.fill('Не сохранять');
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(sessionRow(app, title)).toHaveCount(1);

  await button().click();
  await input.fill('   ');
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Название не может быть пустым');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(sessionRow(app, title)).toHaveCount(1);
  expect(frames.some(frame => frame.includes('renameSession'))).toBe(false);
});
