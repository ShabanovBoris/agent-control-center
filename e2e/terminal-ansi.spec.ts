import type { Page } from '@playwright/test';
import { expect, test } from './support/fixtures';

/** Панель выбранного терминала: скрытые панели остаются в DOM, но невидимы. */
function activePane(page: Page) {
  return page.locator('.terminal-pane[data-active="true"]');
}

async function openTerminalPage(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Терминал', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Терминал', exact: true })).toBeVisible();
}

test.beforeEach(async ({ app }) => {
  // mock-хост и backend общие на worker: PTY прошлого файла видны следующему через overview.
  await openTerminalPage(app);
  await expect(app.locator('.terminal-list, .terminal-form').first()).toBeVisible();
  const rows = app.locator('.terminal-row');
  for (let guard = 0; guard < 12; guard += 1) {
    const count = await rows.count();
    if (count === 0) break;
    await rows.first().click();
    await app.getByRole('button', { name: 'Закрыть терминал' }).click();
    await expect(rows).toHaveCount(count - 1);
  }
});

test('SGR из PTY доезжает до xterm панели', async ({ app }) => {
  await app.getByRole('button', { name: 'Открыть терминал' }).click();
  await expect(activePane(app).locator('.terminal-screen .xterm-rows')).toBeVisible();

  // mock-хост отдаёт приглашение "\x1b[32m$\x1b[0m" (scripts/mock-host.ts): xterm.js
  // разбирает SGR и красит его классом xterm-fg-2. Если байты с атрибутами потеряются
  // в кадре backend или в эмуляторе, TUI-агенты снова останутся без подсветки выбора.
  await expect(activePane(app).locator('.terminal-screen .xterm-fg-2').first()).toBeVisible();
  expect(await activePane(app).innerText()).toContain('$');
});
