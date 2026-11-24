import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { MultiHostClient } from '@microsoft/agent-host-protocol/hosts';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseClientMessage, type Call, type ClientMessage, type ServerMessage } from '../shared/protocol.js';
import { channelKey } from '../shared/reduce.js';
import { installedAhpVersion } from '../scripts/update-agents.mjs';
import { FileClientIdStore, loadConfig, toHostConfig } from './config.js';
import { CallFailure, Hub, toCallError } from './hub.js';
import { DirectoryPicker } from './directory-picker.js';
import { collectHealth, readAppVersion, type SdkVersionInspector } from './health.js';
import { localLogSources, readLogTail } from './logs.js';
import { createPhoneAccess, PHONE_ACCESS_PORT } from './phone-access.js';
import { localHosts, localInstance, runningSdks } from './local-hosts.js';
import { visibleOrigins } from './presence.js';
import { createPushService } from './push.js';
import { ProjectUpdates, type UpdatePlan } from './updates.js';
import { restartServices } from './restart-services.js';

const previousBackend = Number(process.env.ACC_PREVIOUS_BACKEND_PID);
delete process.env.ACC_PREVIOUS_BACKEND_PID;
if (Number.isSafeInteger(previousBackend) && previousBackend > 1) {
  const deadline = Date.now() + 30_000;
  while (true) {
    try { process.kill(previousBackend, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') break; else throw error; }
    if (Date.now() > deadline) throw new Error('Прежний backend не завершил работу.');
    await delay(150);
  }
}

// Параллельный dev/e2e backend не должен занимать production-порты и читать production-настройки,
// поэтому порт и адрес mock-хоста переопределяются через env, а доступ с телефона отключается.
function envPort(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label}: ожидается целое число 1..65535`);
  return port;
}

const portOverride = envPort(process.env.ACC_PORT, 'ACC_PORT');
const mockHostUrl = process.env.ACC_MOCK_HOST_URL?.trim() || undefined;
const config = await loadConfig(process.env.ACC_CONFIG ?? 'hosts.json', {
  ...(portOverride !== undefined ? { port: portOverride } : {}),
  ...(mockHostUrl ? { hostUrls: { mock: mockHostUrl } } : {}),
});
const locals = localHosts(config.hosts);
const ahpVersion = await installedAhpVersion();
const appVersion = await readAppVersion();
const backendStartedAt = Date.now();
const logSources = localLogSources(locals);
const phone = process.env.ACC_PHONE_ACCESS === '0' ? undefined : await createPhoneAccess('.local/phone-access.json', 'dist').catch((error: unknown) => {
  console.error('[acc] Доступ с телефона отключён.', error);
});

/** Версии SDK читаются у запущенного экземпляра; отсутствие экземпляра — не ошибка страницы. */
const sdkVersions: SdkVersionInspector = async (hostId, build) => {
  const host = locals.find(candidate => candidate.id === hostId);
  if (!host || !build) return undefined;
  const instance = await localInstance(host).catch((error: unknown) => {
    // Хост ещё не запускали скриптами проекта: файла реестра или токена нет.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  return instance ? runningSdks(host, instance, build) : undefined;
};

interface Browser {
  socket: WebSocket;
  origin: string;
  /** Сессия на экране именно этого устройства; источник решения о подавлении push. */
  visible: boolean;
  selection?: { hostId: string; sessionUri: string };
  watching: Set<string>;
  abort: AbortController;
  pickerAbort?: AbortController;
  /** Текущий поиск по истории: новый запрос отменяет предыдущий. */
  search?: { id: number; abort: AbortController };
  /** Текущий отчёт по расходу: отдельный слот, чтобы отчёт не рвал поиск. */
  usage?: { id: number; abort: AbortController };
  updatePlan?: UpdatePlan;
}
const browsers = new Set<Browser>();
const defaultModels = new Map(config.hosts.map(host => [host.id, host.defaultModels ?? {}]));

const push = await createPushService({ dir: '.local' }).catch((error: unknown) => {
  console.error('[acc] Push-уведомления отключены.', error instanceof Error ? error.message : String(error));
  return undefined;
});
if (push) console.log(`[acc] Push-уведомления готовы, подписок: ${push.subscriptionCount}`);

function send(browser: Browser, message: ServerMessage, onSent?: () => void): void {
  if (browser.socket.readyState === browser.socket.OPEN) browser.socket.send(JSON.stringify(message), onSent);
  else onSent?.();
}

const hub = new Hub(new MultiHostClient({ clientIdStore: new FileClientIdStore('.local/client-ids.json') }), {
  broadcast(message) {
    for (const browser of browsers) send(browser, message);
    if (message.t === 'overview' && push) {
      // Сбой push не должен ломать обновление сводки в браузерах.
      void push.observe(message.overview, transition => visibleOrigins(browsers, transition.hostId, transition.sessionUri))
        .catch(error => console.warn('[acc] Не удалось обработать push-переходы.', error instanceof Error ? error.message : String(error)));
    }
  },
  toWatchers(hostId, uri, message) {
    const key = channelKey(hostId, uri);
    for (const browser of browsers) {
      if (browser.watching.has(key)) send(browser, message);
    }
  },
}, config.agents, new DirectoryPicker(config.hosts.filter(host => host.localFilesystem).map(host => host.id)), defaultModels);
const updates = new ProjectUpdates(locals, hub, ahpVersion);
let backendRestarting = false;

function restartAllServices(): Promise<void> {
  return restartServices({
    hosts: locals, hub, updates, restartBackend: startReplacementBackend,
  });
}

async function startReplacementBackend(): Promise<void> {
  backendRestarting = true;
  try {
    const next = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], {
      env: { ...process.env, ACC_PREVIOUS_BACKEND_PID: String(process.pid) },
      detached: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
    await once(next, 'spawn');
    next.unref();
  } catch (error) {
    backendRestarting = false;
    throw error;
  }
}

/**
 * Backend исполняет команды агентов от имени пользователя, поэтому подключаться к нему
 * может только страница, открытая с этого же loopback-адреса. Сравнение Origin с Host
 * отсекает чужие сайты (WebSocket не защищён CORS), а требование loopback-имени — DNS rebinding.
 */
function isTrustedUpgrade(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) return false;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  return originUrl.host === host && ['localhost', '127.0.0.1', '[::1]'].includes(originUrl.hostname);
}

const server = createServer((_request, response) => {
  response.writeHead(404).end();
});
const sockets = new WebSocketServer({ noServer: true });

function acceptBrowserConnections(listener: Server, isTrusted: (request: IncomingMessage) => boolean) {
  listener.on('upgrade', (request, socket, head) => {
    if (request.url !== '/ws' || !isTrusted(request)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, webSocket => onBrowser(webSocket, request.headers.origin ?? ''));
  });
}

acceptBrowserConnections(server, isTrustedUpgrade);
if (phone) acceptBrowserConnections(phone.server, phone.isTrustedUpgrade);

function onBrowser(socket: WebSocket, origin: string): void {
  const browser: Browser = { socket, origin, visible: false, watching: new Set(), abort: new AbortController() };
  browsers.add(browser);
  send(browser, { t: 'overview', overview: hub.overview() });

  socket.on('message', data => {
    const message = parseClientMessage(String(data));
    if (!message) return;
    void onMessage(browser, message).catch(error => {
      console.warn(`[acc] Не удалось обработать сообщение браузера (${message.t})`, error);
    });
  });
  socket.on('close', () => {
    browser.visible = false;
    browser.abort.abort();
    browsers.delete(browser);
    for (const key of browser.watching) {
      const [hostId, uri] = key.split('\u0000') as [string, string];
      hub.unwatch(hostId, uri);
    }
  });
}

async function onMessage(browser: Browser, message: ClientMessage): Promise<void> {
  switch (message.t) {
    case 'cancelDirectoryPicker':
      browser.pickerAbort?.abort();
      return;
    case 'cancelSearch':
      if (browser.search?.id === message.id) browser.search.abort.abort();
      return;
    case 'cancelUsage':
      if (browser.usage?.id === message.id) browser.usage.abort.abort();
      return;
    case 'presence':
      browser.visible = message.visible;
      browser.selection = message.selection
        ? { hostId: message.selection.hostId, sessionUri: message.selection.sessionUri }
        : undefined;
      return;
    case 'watch': {
      const { hostId, uri } = message;
      const key = channelKey(hostId, uri);
      if (browser.watching.has(key)) return;
      try {
        // Наблюдатель регистрируется до запроса состояния, чтобы не пропустить его снимок.
        browser.watching.add(key);
        const state = hub.watch(hostId, uri);
        if (state !== undefined) send(browser, { t: 'snapshot', hostId, uri, state });
      } catch (error) {
        browser.watching.delete(key);
        const failure = toCallError(error);
        send(browser, { t: 'channelError', hostId, uri, error: failure.message, ...(failure.code !== undefined ? { code: failure.code } : {}) });
      }
      return;
    }
    case 'unwatch': {
      if (browser.watching.delete(channelKey(message.hostId, message.uri))) hub.unwatch(message.hostId, message.uri);
      return;
    }
    case 'call': {
      let pickerAbort: AbortController | undefined;
      let searchAbort: AbortController | undefined;
      let usageAbort: AbortController | undefined;
      try {
        const call = message.call;
        if (backendRestarting) throw new Error('Backend перезапускается после обновления.');
        if (call.op === 'checkUpdates') {
          browser.updatePlan = undefined;
          browser.updatePlan = await updates.check();
          send(browser, { t: 'result', id: message.id, ok: true, data: browser.updatePlan.preview });
          return;
        }
        if (call.op === 'applyUpdates') {
          const plan = browser.updatePlan;
          browser.updatePlan = undefined;
          if (!plan) throw new Error('Сначала проверьте доступные обновления.');
          const restartBackend = await updates.apply(plan);
          if (restartBackend) await startReplacementBackend();
          send(browser, { t: 'result', id: message.id, ok: true, data: { restartBackend } }, restartBackend ? () => void shutdown() : undefined);
          return;
        }
        if (call.op === 'restartServices') {
          await restartAllServices();
          send(browser, { t: 'result', id: message.id, ok: true, data: { restartBackend: true } }, () => void shutdown());
          return;
        }
        // Push не зависит от перезапуска хоста: ключи и подписки живут в backend.
        if (call.op === 'pushConfig' || call.op === 'pushSubscribe'
          || call.op === 'pushUnsubscribe' || call.op === 'pushTest') {
          const data = await handlePushCall(browser, call);
          send(browser, { t: 'result', id: message.id, ok: true, ...(data !== undefined ? { data } : {}) });
          return;
        }
        if (call.op === 'health') {
          send(browser, {
            t: 'result', id: message.id, ok: true,
            data: await collectHealth({
              hosts: hub.overview().hosts,
              diagnostics: hub.hostDiagnostics(),
              logs: logSources,
              backend: { version: appVersion, ahpVersion, startedAt: backendStartedAt, phoneAccess: phone !== undefined },
              sdkVersions,
            }),
          });
          return;
        }
        if (call.op === 'readLog') {
          if (typeof call.hostId !== 'string') throw new CallFailure('Не указан хост для чтения журнала.');
          const source = logSources.find(candidate => candidate.hostId === call.hostId);
          if (!source) throw new CallFailure('Журнал доступен только для локальных хостов проекта.');
          send(browser, { t: 'result', id: message.id, ok: true, data: await readLogTail(source) });
          return;
        }
        if ('hostId' in call && updates.isRestarting(call.hostId) && (
          call.op === 'sendMessage' || call.op === 'createSession' || call.op === 'createChat'
          || call.op === 'forkSession' || call.op === 'editMessage' || call.op === 'retryEditedMessage'
        )) {
          throw new Error('Хост перезапускается после обновления.');
        }
        if (call.op === 'pickDirectory') {
          if (browser.pickerAbort) throw new Error('Диалог выбора папки уже открыт');
          pickerAbort = new AbortController();
          browser.pickerAbort = pickerAbort;
        }
        if (call.op === 'searchHistory') {
          // Смена запроса и закрытие палитры не должны оставлять прежние воркеры.
          browser.search?.abort.abort();
          searchAbort = new AbortController();
          browser.search = { id: message.id, abort: searchAbort };
        }
        if (call.op === 'usageReport') {
          // Новый отчёт заменяет прежний; поиск живёт в своём слоте.
          browser.usage?.abort.abort();
          usageAbort = new AbortController();
          browser.usage = { id: message.id, abort: usageAbort };
        }
        const signals = [browser.abort.signal, pickerAbort?.signal, searchAbort?.signal, usageAbort?.signal].filter((value): value is AbortSignal => value !== undefined);
        const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
        const data = await hub.call(call, signal);
        send(browser, { t: 'result', id: message.id, ok: true, ...(data !== undefined ? { data } : {}) });
      } catch (error) {
        send(browser, { t: 'result', id: message.id, ok: false, error: toCallError(error) });
      } finally {
        if (pickerAbort) browser.pickerAbort = undefined;
        // Новая поисковая команда или отчёт могли уже заменить этот controller.
        if (searchAbort && browser.search?.id === message.id) browser.search = undefined;
        if (usageAbort && browser.usage?.id === message.id) browser.usage = undefined;
      }
      return;
    }
  }
}

type PushCall = Extract<Call, { op: 'pushConfig' | 'pushSubscribe' | 'pushUnsubscribe' | 'pushTest' }>;

/** Push-вызовы не относятся к хостам: обрабатываются до проверки перезапуска хоста. */
async function handlePushCall(browser: Browser, call: PushCall): Promise<unknown> {
  if (!push) throw new CallFailure('Push-уведомления не настроены на backend.');
  switch (call.op) {
    case 'pushConfig':
      return { publicKey: push.publicKey };
    case 'pushSubscribe':
      if (call.origin !== browser.origin) throw new CallFailure('Подписка пришла с другого адреса.');
      await push.subscribe({ origin: call.origin, subscription: call.subscription });
      return undefined;
    case 'pushUnsubscribe':
      await push.unsubscribe(call.endpoint);
      return undefined;
    case 'pushTest':
      if (call.origin !== browser.origin) throw new CallFailure('Проверка пришла с другого адреса.');
      return push.test(call.origin);
  }
}

await hub.start(config.hosts.map(toHostConfig));
server.listen(config.listen.port, config.listen.host, () => {
  console.log(`[acc] backend слушает ws://${config.listen.host}:${config.listen.port}/ws, хостов: ${config.hosts.length}`);
});
if (phone) {
  phone.server.on('error', error => console.error('[acc] Доступ с телефона отключён.', error));
  phone.server.listen(PHONE_ACCESS_PORT, '127.0.0.1', () => {
    console.log(`[acc] Панель для Tailscale ${phone.origin} слушает 127.0.0.1:${PHONE_ACCESS_PORT}`);
  });
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  phone?.server.close();
  for (const browser of browsers) browser.socket.close();
  await hub.stop();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
