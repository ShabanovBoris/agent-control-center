import { createSession } from './support/app';
import { expect, test } from './support/fixtures';

test('показывает текущую ветку и передаёт worktree с базовой веткой в createSession', async ({ app }) => {
  const title = await createSession(app, {
    beforeCreate: async page => {
      // Текущая ветка — из probe-ответа хоста, а не default branch.
      await expect(page.locator('.session-branch')).toHaveText('Ветка: feature/mock-current');

      const target = page.getByRole('combobox', { name: 'Куда создать сессию' });
      await expect(target).toBeVisible();
      await target.selectOption('worktree');

      const branch = page.getByLabel('Базовая ветка');
      await expect(branch).toHaveValue('main');
      // Стартовое значение схемы — одно; четыре варианта доказывают запрос sessionConfigCompletions.
      await expect(page.locator('datalist option')).toHaveCount(4);

      await branch.fill('develop');
      await expect(page.locator('datalist option')).toHaveCount(1);

      // Смена папки сбрасывает выбор: ветка из прошлого репозитория не должна переехать в новый.
      await page.getByRole('textbox', { name: 'Рабочая папка на хосте' }).fill('/mock/other');
      await expect(target).toHaveValue('workspace');
      await expect(page.locator('.session-branch')).toHaveText('Ветка: feature/mock-current');

      await target.selectOption('worktree');
      await expect(branch).toHaveValue('main');
      await branch.fill('develop');
    },
  });

  expect(title).toContain('target=worktree');
  expect(title).toContain('baseBranch=develop');
});

test('немедленный submit после выбора worktree не теряет target', async ({ app }) => {
  const title = await createSession(app, {
    beforeCreate: async page => {
      const target = page.getByRole('combobox', { name: 'Куда создать сессию' });
      await expect(target).toBeVisible();
      // Mock-хост отвечает на worktree-запрос медленнее debounce панели: клик «Создать» ниже
      // попадает в окно, где схема нового target ещё не пришла.
      await target.selectOption('worktree');
    },
  });

  expect(title).toContain('target=worktree');
  // Defaults прежнего target (ветка текущей папки) не выдаются за выбранную базовую ветку.
  expect(title).not.toContain('baseBranch');
});

test('немедленный submit сохраняет и target, и выбранную ветку', async ({ app }) => {
  const title = await createSession(app, {
    beforeCreate: async page => {
      const target = page.getByRole('combobox', { name: 'Куда создать сессию' });
      await expect(target).toBeVisible();
      await target.selectOption('worktree');
      // Поле ветки остаётся на экране во время повторного resolve, поэтому выбор успевает до submit.
      await page.getByLabel('Базовая ветка').fill('develop');
    },
  });

  expect(title).toContain('target=worktree');
  expect(title).toContain('baseBranch=develop');
});
