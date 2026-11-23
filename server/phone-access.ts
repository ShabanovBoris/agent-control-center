import { readFile, readdir } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { extname, join } from 'node:path';

export const PHONE_ACCESS_PORT = 8092;

const assetTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
]);

async function loadPhoneConfig(path: string) {
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (text === undefined) return undefined;

  const config = JSON.parse(text) as { origin?: unknown; login?: unknown } | null;
  if (typeof config?.origin !== 'string' || typeof config.login !== 'string' || !/^[^\s,]+$/.test(config.login)) {
    throw new Error(`${path} должен содержать origin и login`);
  }
  const url = new URL(config.origin);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.ts.net') || url.href !== `${url.origin}/`) {
    throw new Error(`${path} должен указывать HTTPS-адрес Tailscale Serve без пути`);
  }
  return { url, login: config.login };
}

export async function createPhoneAccess(configPath: string, buildDir: string) {
  const config = await loadPhoneConfig(configPath);
  if (!config) return undefined;
  const { url, login } = config;

  // Публикуем только результат сборки. Каталог проекта и файлы настроек недоступны.
  const index = { content: await readFile(join(buildDir, 'index.html')), type: 'text/html; charset=utf-8' };
  const files = new Map([['/', index], ['/index.html', index]]);
  for (const entry of await readdir(join(buildDir, 'assets'), { withFileTypes: true })) {
    const type = assetTypes.get(extname(entry.name));
    if (entry.isFile() && type) {
      files.set(`/assets/${entry.name}`, { content: await readFile(join(buildDir, 'assets', entry.name)), type });
    }
  }
  // PWA: без service worker, manifest и иконок телефон не установит приложение и не получит push.
  const pwaFiles = new Map([
    ['/sw.js', 'text/javascript; charset=utf-8'],
    ['/manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
    ['/icons/icon-192.png', 'image/png'],
    ['/icons/icon-512.png', 'image/png'],
    ['/icons/apple-touch-icon.png', 'image/png'],
  ]);
  for (const [route, type] of pwaFiles) {
    try {
      files.set(route, { content: await readFile(join(buildDir, route)), type });
    } catch (error) {
      // Старый dist не должен отключать доступ с телефона целиком; предупреждаем и пропускаем.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      console.warn(`[acc] В dist нет ${route}: PWA может не установиться. Пересоберите панель.`);
    }
  }

  // Этот listener доступен только на 127.0.0.1. Serve подставляет сведения о пользователе
  // сам, предварительно удаляя одноимённые заголовки с входящего запроса.
  function isAuthorized(headers: IncomingHttpHeaders): boolean {
    return headers.host === url.host
      && headers['x-forwarded-proto'] === 'https'
      && headers['tailscale-user-login'] === login;
  }

  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!isAuthorized(request.headers)) {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Доступ разрешён настроенной учётной записи Tailscale.');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const file = files.get(request.url?.split('?', 1)[0] ?? '');
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': file.type,
      'Content-Length': file.content.length,
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    }).end(request.method === 'HEAD' ? undefined : file.content);
  });

  return {
    origin: url.origin,
    server,
    isTrustedUpgrade: ({ headers }: Pick<IncomingMessage, 'headers'>) => isAuthorized(headers) && headers.origin === url.origin,
  };
}
