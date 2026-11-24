import { fileURLToPath } from 'node:url';

function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name}: ожидается целое число 1..65535, получено «${raw}»`);
  }
  return port;
}

/**
 * Порты E2E не совпадают ни с production (8090/5173), ни с dev-контуром (8095/8189),
 * ни с резервной панелью (5174). Переопределяются env, чтобы прогон не зависел от занятых портов.
 */
export const PORTS = {
  mock: envPort('E2E_MOCK_PORT', 8190),
  backend: envPort('E2E_BACKEND_PORT', 8096),
  web: envPort('E2E_WEB_PORT', 5175),
} as const;

const ports = Object.values(PORTS);
if (new Set(ports).size !== ports.length) {
  throw new Error(`E2E-порты должны различаться: ${JSON.stringify(PORTS)}`);
}

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const BASE_URL = `http://127.0.0.1:${PORTS.web}`;
export const STATE_DIR = 'test-results/state';
