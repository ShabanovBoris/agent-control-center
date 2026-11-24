import { test as base, expect, type Page } from '@playwright/test';
import { ensureHostConnected } from './app';
import { MockHost } from './mock-host';

interface AppFixtures {
  app: Page;
}

interface WorkerFixtures {
  mockHost: MockHost;
}

export const test = base.extend<AppFixtures, WorkerFixtures>({
  mockHost: [async ({}, use) => {
    const mockHost = new MockHost();
    await mockHost.start();
    try {
      await use(mockHost);
    } finally {
      await mockHost.stop();
    }
  }, { scope: 'worker' }],

  app: async ({ page, mockHost }, use) => {
    // Reconnect-сценарий останавливает mock-хост; следующий тест должен получить живой.
    await mockHost.ensureStarted();
    await page.goto('/');
    await ensureHostConnected(page);
    await use(page);
  },
});

export { expect };
