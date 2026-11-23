# AGENTHOS-14 — push-уведомления о состоянии агента

Ветка `AGENTHOS-14`, база `6cbd5a5`. Реализация выполнена в рабочем дереве worktree;
коммит и PR не создавались (по условию задачи нужен явный запрос).

## Что сделано

- **Backend.** `web-push@4.0.0`, VAPID и подписки в `.local` (0600, temp + rename),
  `PushTransitions` по `Overview` (input / done / error), подавление per-origin через presence,
  `pushConfig`/`pushSubscribe`/`pushUnsubscribe`/`pushTest`. Детектор встроен в перехват
  `HubSink.broadcast` в [server/index.ts](../server/index.ts); контракт `Hub` не менялся.
- **PWA.** Статический [public/sw.js](../public/sw.js) (`push`, `notificationclick`,
  same-origin + fallback `openWindow`), manifest и PNG-иконки 192/512/180; регистрация SW в
  [src/main.tsx](../src/main.tsx); allowlist и MIME в [server/phone-access.ts](../server/phone-access.ts)
  с сохранением проверки Tailscale.
- **UI.** Кнопка «Уведомления» с диалогом: `off`, `on`, `blocked`, `install` (iOS), `unsupported`;
  включение только из клика (разрешение запрашивается до `await`), выключение, тестовая отправка.
  Deep link в сессию/чат; `hashchange` переключает уже открытую вкладку.
- **Общее.** [shared/routing.ts](../shared/routing.ts) и [shared/status.ts](../shared/status.ts) —
  единая логика hash и фаз для клиента, backend и payload; `src/format.ts` реэкспортирует.
- **Документация.** README (раздел «Push-уведомления»), [techContext.md](techContext.md),
  [activeContext.md](activeContext.md), [progress.md](progress.md).

## Проверки (фактические)

| Команда | Результат |
| --- | --- |
| `npm install` | 134 пакета, 0 уязвимостей |
| `npm install --prefix debug-ui` | 1 пакет |
| `npm test` | **174/174** pass |
| `npm run typecheck` | exit 0, обе конфигурации |
| `npm run build` | exit 0; `dist/index.html` 0.89 kB, CSS 21.28 kB, JS 513.96 kB (gzip 155.94 kB), warning о чанке >500 kB — не регрессия |
| `npm test --prefix debug-ui` | 4/4 pass |
| `node --check public/sw.js` | OK |
| `git diff --check` | OK |

### Chromium (headless 159.0.8154.6, CDP, `dist` + реальный backend)

Собрана smoke-связка: `dist` на `127.0.0.1:8173`, WebSocket-прокси на backend `127.0.0.1:8190`.

- страница загрузилась, backend connected, manifest и apple-touch-icon на месте;
- `navigator.serviceWorker.ready` → `/sw.js`, scope `/`, страница controlled; console errors/warnings — 0;
- смена `location.hash` на `#local|ahp-session…#ahp-chat…` переключила детальный вид (hash-роут работает);
- диалог «Уведомления»: при `Notification.permission = denied` показано состояние «запрещены» без кнопки включения;
- для проверки сценариев `off → on → test → off` `PushManager` и `Notification` подменены в
  `Page.addScriptToEvaluateOnNewDocument` (headless не выдаёт разрешение и не имеет FCM):
  «Включить» → `on`, backend записал подписку в `.local/push-subscriptions.json` (origin
  `http://127.0.0.1:8173`, файл 0600); «Проверить уведомление» → `delivered = 0` и понятное
  предупреждение (endpoint `push.example` недоступен); «Выключить» → `off`, файл снова
  `{ "subscriptions": [] }`;
- в логах backend строка `[acc] Push не доставлен: сеть или неизвестная ошибка.` без endpoint,
  ключей и payload; `rg` по логу не нашёл `smoke-endpoint`, `p256dh`, `push.example`;
- `.local/push-vapid.json` и `.local/push-subscriptions.json` — `-rw-------`.

### Доступ с телефона (dist + Tailscale-заголовки)

`createPhoneAccess('.local/phone-access.json', 'dist')` на временном порту:

- `/sw.js` → 200 `text/javascript; charset=utf-8`, `/manifest.webmanifest` → 200
  `application/manifest+json; charset=utf-8`, `/icons/*.png` → 200 `image/png`, `/` → 200 HTML;
- без Tailscale-заголовков любой путь → 403;
- `/package.json` и `/icons/../package.json` → 404; POST → 405; HEAD → 200 с `Content-Length`;
- `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` сохранились.

## Ограничения и что не проверено

- **iPhone/APNs не проверялись**: устройства нет. Проверено только в Chromium (headless) и на
  уровне unit-тестов; формулировка DoD: «Проверено только в Chromium; iOS/APNs не проверялись».
- Реальная доставка через FCM/APNs/Mozilla не проверялась: в headless нет разрешения и push-сервиса,
  endpoint был тестовым. Код отправки и обработка 404/410/401/403/5xx покрыты тестами с fake sender.
- Сквозной сценарий «реальный хост → переход → push» не прогонялся: в окружении нет mock-host
  (AGENTHOS-12/13); детектор, payload, URL, tag, TTL/urgency покрыты unit-тестами.
- Headless-браузер не даёт выдать `notifications` permission (`Browser.grantPermissions`/`setPermission`
  возвращают denied), поэтому `on/test/off` проверены с подменённым `PushManager`; сама ветка
  `blocked` проверена в реальном браузере без подмены.
- iOS: только PWA с домашнего экрана, iOS 16.4+; Safari-вкладка не подходит — зафиксировано в README и UI.
- Mac должен бодрствовать, backend — работать; keep-awake и автозапуск backend не делались.
- Переходы, целиком укладывающиеся в 30-мс debounce `scheduleOverview`, могут быть не замечены;
  baseline после старта backend не уведомляет; два устройства с одинаковым origin делят подавление.

## Секреты

`.local` в `.gitignore`. Приватный VAPID-ключ и endpoint не уходят в браузер (`pushConfig` отдаёт
только `publicKey`), не пишутся в логи; ошибки доставки логируются только кодом статуса/«сеть».
Тест `server/push.test.ts` проверяет режим 0600, отсутствие endpoint/ключей в текстах ошибок и логах.
