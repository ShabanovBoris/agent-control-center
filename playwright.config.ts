import { defineConfig } from '@playwright/test';
import { BASE_URL, PORTS, STATE_DIR } from './e2e/support/env';

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  // Backend и mock-хост общие для файлов, поэтому прогон последовательный.
  workers: 1,
  // Ретраи маскировали бы флаки: нестабильный сценарий должен падать на первом прогоне.
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: { mode: 'only-on-failure', fullPage: true },
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      // HTTP-запрос к backend отвечает 404, поэтому готовность проверяется по TCP-порту.
      command: 'npm run server:e2e',
      port: PORTS.backend,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ACC_CONFIG: 'hosts.e2e.json',
        ACC_PHONE_ACCESS: '0',
        ACC_PORT: String(PORTS.backend),
        ACC_MOCK_HOST_URL: `ws://127.0.0.1:${PORTS.mock}`,
        ACC_STATE_DIR: STATE_DIR,
      },
    },
    {
      command: `npm run web -- --port ${PORTS.web}`,
      url: BASE_URL,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { ACC_BACKEND: `127.0.0.1:${PORTS.backend}` },
    },
  ],
});
