import { createSession, expectCompletedTurn, sendMessage } from './support/app';
import { expect, test } from './support/fixtures';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('на ширине 390 px лента не прокручивается горизонтально', async ({ app }) => {
  await createSession(app);
  await sendMessage(app, 'markdown');

  const answer = app.locator('.markdown-message').filter({ hasText: 'Учебный отчёт' });
  await expect(answer.getByRole('table')).toBeVisible();
  await expect(answer.locator('pre')).toContainText('https://example.test/');
  await expectCompletedTurn(app);

  const overflow = await app.evaluate(() => {
    const transcript = document.querySelector<HTMLElement>('.transcript');
    if (!transcript) throw new Error('Лента не найдена');
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      transcript: transcript.scrollWidth - transcript.clientWidth,
    };
  });
  // Широкая таблица и code block прокручиваются внутри себя, а не растягивают ленту и страницу.
  expect(overflow.page, 'страница шире viewport').toBeLessThanOrEqual(0);
  expect(overflow.transcript, 'лента шире viewport').toBeLessThanOrEqual(0);
});
