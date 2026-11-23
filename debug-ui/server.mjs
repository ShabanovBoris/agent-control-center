import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostConnection, RequestError, describe } from './ahp.mjs';

const configPath = process.env.ACC_DEBUG_CONFIG ? resolve(process.env.ACC_DEBUG_CONFIG) : fileURLToPath(new URL('../hosts.json', import.meta.url));
const config = JSON.parse(await readFile(configPath, 'utf8'));
const port = config.debugPort ?? 5174;
if (!Number.isInteger(port) || port < 0 || port > 65535 || !Array.isArray(config.hosts) || config.hosts.length === 0) {
  throw new Error('Проверьте port и список hosts в конфигурации резервной панели');
}
const hosts = new Map();
for (const entry of config.hosts) {
  if (!entry || typeof entry.id !== 'string' || !entry.id || hosts.has(entry.id) || typeof entry.label !== 'string' || typeof entry.url !== 'string') {
    throw new Error('Каждому хосту нужны уникальный id, label и WebSocket url');
  }
  if (!['ws:', 'wss:'].includes(new URL(entry.url).protocol)) throw new Error('Адрес AHP-хоста должен начинаться с ws: или wss:');
  if (entry.providers !== undefined && (!Array.isArray(entry.providers) || !entry.providers.every(id => typeof id === 'string'))) {
    throw new Error('providers должен быть списком идентификаторов агентов');
  }
  hosts.set(entry.id, new HostConnection({
    ...entry,
    tokenFile: entry.tokenFile ? resolve(dirname(configPath), entry.tokenFile) : undefined,
  }));
}

const files = new Map(await Promise.all([
  ['/', 'index.html', 'text/html'],
  ['/panel.js', 'panel.js', 'text/javascript'],
  ['/panel.css', 'panel.css', 'text/css'],
].map(async ([route, file, mime]) => [route, {
  content: await readFile(new URL(file, import.meta.url)), type: `${mime}; charset=utf-8`,
}])));

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(body);
}

async function readBody(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new RequestError(415, 'Ожидался JSON');
  }
  const limit = 64 * 1024;
  if (Number(request.headers['content-length']) > limit) throw new RequestError(413, 'Запрос слишком большой');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new RequestError(413, 'Запрос слишком большой');
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400, 'Не удалось прочитать JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new RequestError(400, 'Ожидался объект');
  return data;
}

function requireHost(id) {
  const host = hosts.get(id);
  if (!host) throw new RequestError(404, 'Неизвестный хост');
  return host;
}

function requireUri(value, scheme) {
  if (typeof value !== 'string' || !value.startsWith(scheme) || value.length === scheme.length || value.length > 2048) {
    throw new RequestError(400, 'Некорректный адрес сессии или чата');
  }
  return value;
}

async function handle(request, response) {
  const hostHeader = request.headers.host;
  const actualPort = server.address()?.port;
  if (hostHeader !== `127.0.0.1:${actualPort}` && hostHeader !== `localhost:${actualPort}`) {
    throw new RequestError(403, 'Панель доступна только с локального адреса');
  }
  const origin = request.headers.origin;
  if ((request.method === 'POST' || origin !== undefined) && origin !== `http://${hostHeader}`) {
    throw new RequestError(403, 'Команды разрешены с этой страницы резервной панели');
  }

  const { pathname, searchParams } = new URL(request.url, `http://${hostHeader}`);
  if (request.method === 'GET' || request.method === 'HEAD') {
    const file = files.get(pathname);
    if (file) {
      response.writeHead(200, { 'Content-Type': file.type }).end(request.method === 'HEAD' ? undefined : file.content);
      return;
    }
  }
  if (request.method === 'GET' && pathname === '/healthz') return json(response, 200, { ready: true });
  if (request.method === 'GET' && pathname === '/api/overview') {
    const overview = await Promise.all([...hosts.values()].map(async host => {
      try { return await host.overview(); }
      catch (error) { return { id: host.config.id, label: host.config.label, error: describe(error) }; }
    }));
    return json(response, 200, { hosts: overview });
  }
  if (request.method === 'GET' && pathname === '/api/session') {
    const host = requireHost(searchParams.get('host'));
    const sessionUri = requireUri(searchParams.get('session'), 'ahp-session:');
    const chatUri = searchParams.has('chat') ? requireUri(searchParams.get('chat'), 'ahp-chat:') : undefined;
    return json(response, 200, await host.session(sessionUri, chatUri));
  }
  if (request.method === 'POST' && pathname === '/api/session') {
    const create = await readBody(request);
    return json(response, 201, await requireHost(create.host).create(create));
  }
  if (request.method === 'POST' && pathname === '/api/command') {
    const command = await readBody(request);
    const host = requireHost(command.host);
    const sessionUri = requireUri(command.session, 'ahp-session:');
    const chatUri = requireUri(command.chat, 'ahp-chat:');
    await host.command(sessionUri, chatUri, command);
    return json(response, 200, { confirmed: true });
  }
  throw new RequestError(404, 'Страница не найдена');
}

const server = createServer({ requestTimeout: 10_000, headersTimeout: 8000 }, (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  void handle(request, response).catch(error => {
    if (!response.headersSent && !response.destroyed) {
      json(response, error instanceof RequestError ? error.status : 502, { error: describe(error) });
    }
  });
});
server.on('error', error => {
  console.error('[debug-ui]', describe(error));
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`[debug-ui] http://127.0.0.1:${server.address().port}`);
});

async function close() {
  server.close();
  await Promise.allSettled([...hosts.values()].map(host => host.close()));
}
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
