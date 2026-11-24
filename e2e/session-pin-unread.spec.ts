import {
  createSession, ensureHostConnected, openSession, sendMessage, sessionRow, sessionTitles,
} from './support/app';
import { expect, test } from './support/fixtures';

test('закрепление поднимает сессию и переживает перезагрузку страницы', async ({ app }) => {
  const older = await createSession(app);
  const newer = await createSession(app);
  expect(newer).not.toEqual(older);

  let titles = await sessionTitles(app);
  expect(titles.indexOf(newer), 'свежая сессия выше старой').toBeLessThan(titles.indexOf(older));

  const pin = sessionRow(app, older).locator('.session-pin');
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'true');

  titles = await sessionTitles(app);
  expect(titles[0], 'закреплённая сессия первая').toBe(older);

  await app.reload();
  await ensureHostConnected(app);
  await expect(sessionRow(app, older).locator('.session-pin')).toHaveAttribute('aria-pressed', 'true');
  titles = await sessionTitles(app);
  expect(titles[0], 'pin пережил перезагрузку').toBe(older);
  expect(titles.indexOf(older)).toBeLessThan(titles.indexOf(newer));

  // Состояние живёт в файле backend и общее для тестов прогона: убираем pin за собой.
  await sessionRow(app, older).locator('.session-pin').click();
  await expect(sessionRow(app, older).locator('.session-pin')).toHaveAttribute('aria-pressed', 'false');
  titles = await sessionTitles(app);
  expect(titles.indexOf(newer)).toBeLessThan(titles.indexOf(older));
});

test('завершённый ход в невидимой сессии даёт badge, deep link его сбрасывает', async ({ app }) => {
  const target = await createSession(app);
  const other = await createSession(app);
  const otherHash = await app.evaluate(() => location.hash);

  await openSession(app, target);
  const heading = app.locator('.session-head h2');
  await expect(heading).toHaveText(target);
  await expect.poll(() => app.evaluate(() => location.hash)).not.toBe(otherHash);
  const targetHash = await app.evaluate(() => location.hash);

  // Длинный ответ mock-хоста даёт окно, чтобы уйти из сессии до завершения хода.
  await sendMessage(app, 'tool markdown');
  const card = app.locator('.tool-call');
  await expect(card).toContainText('Ждёт подтверждения');
  await card.getByRole('button', { name: 'Разрешить', exact: true }).click();

  await openSession(app, other);
  await expect(heading).toHaveText(other);
  const badge = sessionRow(app, target).locator('.session-unread');
  await expect(badge).toHaveText('1', { timeout: 30_000 });

  await app.reload();
  await ensureHostConnected(app);
  await expect(sessionRow(app, target)).toBeVisible();
  await expect(sessionRow(app, target).locator('.session-unread')).toHaveText('1', { timeout: 30_000 });

  // Deep link открывает сессию как обычно и сбрасывает счётчик этого устройства.
  await app.evaluate(hash => { location.hash = hash; }, targetHash);
  await expect(app.locator('.session-head h2')).toHaveText(target);
  await openSession(app, other);
  await expect(app.locator('.session-head h2')).toHaveText(other);
  await expect(sessionRow(app, target).locator('.session-unread')).toHaveCount(0, { timeout: 15_000 });
});
