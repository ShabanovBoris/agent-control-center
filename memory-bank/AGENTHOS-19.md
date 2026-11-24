# AGENTHOS-19 — автозапуск, keep-awake и восстановление сервисов

## Итог

macOS LaunchAgent `com.agentcontrolcenter.up` запускает `up --supervised` при входе. После
готовности падение одного сервиса восстанавливается без остановки остальных; `kill -9` самого
`up` перехватывается launchd, новый супервизор принимает живые хосты (включая найденные
`localInstance` без записи в состоянии) и пересоздаёт backend/Vite. `--keep-awake` удерживает
систему awake через `caffeinate`, не меняя `pmset`. Установка/удаление идемпотентны и
обратимы; README и `techContext` описывают `launchctl`, диагностику и ограничения.

## Решения

- **Ручной `up` остаётся fail-fast.** Восстановление включается только флагом `--supervised`,
  который использует launchd. Ошибки до готовности по-прежнему мгновенно прерывают запуск
  (stage-флаг попытки + `failure` в `waitFor`), без ожидания полного таймаута.
- **Супервизор на месте.** [server/up-restart.ts](../server/up-restart.ts) — `RestartBudget`
  (5 попыток, backoff 1/2/5/15/30 с, сброс после 10 минут стабильной работы). Перезапуски
  сериализованы по сервису, параллельны между сервисами; ошибка бюджета даёт `stopAll('keep-live-hosts')`
  и код 1, живой хост не получает сигналов.
- **Владение процессами.** [server/up-state.ts](../server/up-state.ts): `up-state.json` в
  `ACC_STATE_DIR`/`.local`, `pid` + `ps -o lstart=`, атомарный захват `wx`, запись temp+rename
  0600, `record`/`forget`/`release(remove)`. Живой владелец или другой `scripts/up.ts`
  (`ps -axo pid=,command=`) — код 0 без сигналов.
- **Принятие хостов.** Любой живой экземпляр `localInstance` принимается как `AdoptedChild`
  (polling `isAlive`, сигнал конкретному pid), даже без записи — это закрывает окно между
  `spawn` и `record` и перезапуск хоста, начатый backend. Чужим считается только живой
  неучтённый backend/Vite: код 0, никаких сигналов.
- **Плановый перезапуск.** Backend под супервизором получает `ACC_UP_SUPERVISED=1` и вместо
  второго процесса завершается кодом `75` ([server/up-contract.ts](../server/up-contract.ts));
  `up` ждёт порт и поднимает его. `HostOverview.restarting` ([shared/protocol.ts](../shared/protocol.ts),
  [withRestarting](../server/restart-services.ts)) позволяет отличить плановый перезапуск
  хоста от падения; проверки `activeSessions` остаются в [server/restart-services.ts](../server/restart-services.ts)
  и не дублируются.
- **launchd.** [server/launchd.ts](../server/launchd.ts) не вызывает macOS напрямую (fs/run
  инжектятся). Плист: тот же entrypoint без npm, `WorkingDirectory`, `PATH` с каталогом
  `process.execPath`, `RunAtLoad`, `KeepAlive={SuccessfulExit:false}`, `ThrottleInterval=30`,
  `Umask=63`, логи `.local/up.log`, без секретов. Матрица install: running → no-op;
  loaded-not-running → `kickstart` без `-k`; not-loaded → `bootstrap`; different → lint,
  `bootout` до rename, ожидание исчезновения job. Uninstall ждёт job, запомненный pid и порты;
  при таймауте plist остаётся.
- **Keep-awake.** [server/keep-awake.ts](../server/keep-awake.ts): `caffeinate -i -m -s -w <pid up>`,
  только по флагу, только macOS; `-w` завершает его вместе с супервизором, даже после SIGKILL.

## Файлы

Новые: [server/up-contract.ts](../server/up-contract.ts), [server/up-state.ts](../server/up-state.ts),
[server/up-restart.ts](../server/up-restart.ts), [server/keep-awake.ts](../server/keep-awake.ts),
[server/launchd.ts](../server/launchd.ts), [server/net.ts](../server/net.ts),
[scripts/autostart.ts](../scripts/autostart.ts).
Изменены: [server/up.ts](../server/up.ts), [scripts/up.ts](../scripts/up.ts),
[server/index.ts](../server/index.ts), [server/restart-services.ts](../server/restart-services.ts),
[shared/protocol.ts](../shared/protocol.ts), [scripts/start-gemini-host.ts](../scripts/start-gemini-host.ts),
[package.json](../package.json), [README.md](../README.md), [techContext.md](techContext.md).
Тесты: [server/up.test.ts](../server/up.test.ts) (22), [server/up-state.test.ts](../server/up-state.test.ts) (9),
[server/up-restart.test.ts](../server/up-restart.test.ts) (3), [server/keep-awake.test.ts](../server/keep-awake.test.ts) (4),
[server/launchd.test.ts](../server/launchd.test.ts) (18), [server/restart-services.test.ts](../server/restart-services.test.ts).

## Проверки

- `npm run typecheck` — успешно (после итерации Gate).
- `npm test` — 368/368.
- Целевой прогон шести файлов (`up`, `up-state`, `launchd`, `up-restart`, `keep-awake`,
  `restart-services`) — 75/75.
- `npm run build` — успешно (предупреждение Vite о размере чанка, не ошибка).
- `npm test --prefix debug-ui` — 4/4.
- `git diff --check` — чисто.
- Реальный macOS-эксперимент с launchd (временные label `com.kent.agentcontrolcenter.probe*`,
  плисты удалены после проверки): exit 0 → job не перезапускается (`runs = 1`, `last exit 0`);
  exit 1 → перезапуск с `ThrottleInterval`; `kill -9` → перезапуск (`runs = 2`);
  `SIGTERM` с обработчиком и выходом 0 → job остаётся загруженным, но не running;
  `launchctl kickstart` без `-k` поднимает его; `launchctl bootout` выгружает job.
- Реальный plist из `renderPlist` → `plutil -lint` OK; `plutil -p` подтверждает
  `KeepAlive={SuccessfulExit:false}`, `Umask 63`, PATH с каталогом `process.execPath`,
  логи в `.local/up.log` и отсутствие секретов.
- `processTable.identity(process.pid)` возвращает `lstart`; `otherUp` нашёл живой ручной
  `node --import tsx scripts/up.ts` (pid 75810) — проверено на реальной машине.
- `caffeinate -i -m -s -w <pid>` создаёт assertion `PreventUserIdleSystemSleep`
  (`pmset -g assertions`); глобальные настройки энергии не менялись.
- `npm run autostart:status` (только чтение) на живой машине: plist/job отсутствуют,
  backend 8090, web 5173 и оба хоста видны; предупреждение о заданном `ACC_STATE_DIR`
  печатается без значений.

Не выполнено (ограничение среды): установка реального plist проекта, `kill -9` сервисов
стенда, `restart:services` под супервизором, uninstall/reinstall и перезагрузка. На машине
уже работает ручной `up` (pid 75810), который обслуживает текущую сессию: установка login
item и перезапуск его сервисов оборвали бы пользовательскую работу.

## Состояние реализации

Готово: код, тесты и документация; проверки выше пройдены, изменения не закоммичены
(коммит требует явного запроса). Дополнительно в этой итерации уточнены:

- `isUpCommandLine` в [server/up-state.ts](../server/up-state.ts) — распознаёт и
  относительный, и абсолютный путь (`<repo>/scripts/up.ts`), покрыт тестом;
- явный сигнал (`Ctrl+C`/`bootout`) в supervised всегда гасит всё, даже если до него
  супервизор уже зафиксировал ошибку;
- [scripts/autostart.ts](../scripts/autostart.ts) всегда читает `hosts.json` и `.local`
  (как job) и предупреждает об env-переменных, которые launchd не наследует.

Известные ограничения для отчёта: ручной smoke на реальных хостах/launchd не выполнялся
агентом, если не подтверждён выводом команд; `launchd`-тесты идут на фейковых fs/run и не
проверяют реальный `launchctl`; Node/nvm upgrade требует переустановки plist; `.local/up.log`
без ротации.

## Итерация Gate: C-01 и неблокирующие замечания

Gate вернул `needs_changes`: `record` владения вызывался после готовности и без `await`.
`kill -9` в окне оставлял backend/Vite без записи; следующий запуск классифицировал их как
чужой стенд, выходил с 0, `KeepAlive={SuccessfulExit:false}` не поднимал job — стенд оставался
без супервизора, и `autostart:uninstall` не мог освободить 8090.

### Что изменено

- [server/up.ts](../server/up.ts): `spawnStage` стал асинхронным; в supervised запись
  `record(leaderPid)` создаётся сразу после `spawn`, до `waitFor` и до любых веток раннего
  выхода. После готовности запись хоста дополняется `instancePid` (`confirmOwnership`, await);
  fire-and-forget записи backend/web после готовности удалены. Сбой записи гасит только что
  запущенный процесс (`abandon`: SIGTERM, затем SIGKILL через `stopWaitMs`) и даёт код 1.
- [server/up.ts](../server/up.ts): подтверждённый backend/Vite пересоздаётся независимо от
  пробы (C-03): зависший процесс с живым лидером тоже останавливается, запуск не упирается
  в занятый порт.
- [server/up.ts](../server/up.ts): занятый порт после падения больше не печатает «попытка
  отложена» и тут же не спавнит (C-04): попытка не запускается, идёт backoff следующей
  попытки бюджета.
- [server/up-state.ts](../server/up-state.ts): `record` бросает при недоступной identity;
  публикация состояния — `link` из уникального temp-файла вместо `open('wx')` + запись
  (C-02): нет пустого placeholder, который второй acquire мог удалить; обновления —
  уникальный temp+rename. Параллельный захват даёт ровно один `acquired`.
- [server/up-state.ts](../server/up-state.ts): `isUpCommandLine` (C-09) распознаёт
  `--import=tsx`, `--loader tsx`, путь к tsx-бину и флаги перед загрузчиком.
- [server/launchd.ts](../server/launchd.ts): `launchdSpec` вынесен в модуль и покрыт тестом
  (Q-05); `install` при изменённом plist и работающем job требует `--force` (C-05), иначе
  `bootout` прерывал активный ход без предупреждения; `launchdStatus({spec})` возвращает
  `matchesSpec` (C-06), и `autostart:status` предупреждает о смене пути node после nvm.
- [scripts/up.ts](../scripts/up.ts): строки детей идут через общий `log`, поэтому в
  `--supervised` ISO-время есть у всех строк (Q-04). [scripts/start-gemini-host.ts](../scripts/start-gemini-host.ts)
  создаёт `.local` до открытия журнала (свежий checkout больше не падает с ENOENT раньше
  проверки провайдера).
- README/techContext: исправлено утверждение, что `kickstart -k` убивает детей (C-05);
  добавлен порядок перехода с работающего ручного стенда, описаны `--force` и запись
  владения до готовности.

### Статусы замечаний Gate

| ID | Статус | Доказательство |
| --- | --- | --- |
| C-01 (record после готовности) | resolved | `spawnStage` + `abandon` в [server/up.ts](../server/up.ts); тесты `C-01: запись владения backend и web создаётся до ожидания готовности`, `C-01: сбой записи владения гасит ребёнка и возвращает 1`, `C-01: запись backend переживает смерть up, новый супервизор пересоздаёт backend` (реальные `up-state.json` и `ps`-identity через `upOwnershipSource`), `C-01: подтверждённый backend с живым лидером пересоздаётся, хосты не сигналятся`. Ручная проверка на macOS: spawn `sleep` → `record` → `kill -9` «up» → новый `acquire` видит `owns(backend)=true` и сохранённых детей. |
| C-02 = Q-01 (acquire race) | resolved | `createState` через `link` + уникальные temp-имена в [server/up-state.ts](../server/up-state.ts); тест `параллельный захват: один acquired, второй other, без потери состояния`. |
| C-03 (зависший owned backend/Vite) | resolved | `owns()` проверяется независимо от пробы; тест `C-03: зависший подтверждённый backend пересоздаётся…`. |
| C-04 (ложное «попытка отложена») | resolved | Попытка не спавнится на занятом порту, идёт backoff; тест `C-04: занятый порт после падения не даёт вторую попытку спавна`. |
| C-05 = Q-02 (install при изменённом plist + README) | resolved | Guard в `installLaunchdJob` и исправленная строка README; тест `install: изменённый plist при работающем job — без --force ничего не трогает` и обновлённый `bootout до rename` (с `--force`). |
| C-06 = nvm-warning в status | resolved | `launchdStatus({spec})` → `matchesSpec`; `autostart:status` печатает предупреждение; тест `status: matchesSpec ловит смену пути node в plist`. |
| C-09 = Q-08 (isUpCommandLine) | resolved | Расширенный разбор командной строки; тесты на `--import=tsx`, `--loader tsx`, tsx-бин. |
| Q-04 (ISO-время у строк детей) | resolved | `pumpLines` идёт через `log` в [scripts/up.ts](../scripts/up.ts); README уточнён. |
| Q-05 (launchdSpec без тестов) | resolved | `launchdSpec` в [server/launchd.ts](../server/launchd.ts); тест `launchdSpec: entrypoint без npm, PATH, логи…`. |
| compat-gemini-log-missing-local | resolved | `mkdir('.local')` до `open` журнала обёртки. |
| compat-install-over-manual-stand | resolved | Абзац «Переход с уже работающего ручного стенда» в README. |
| C-07 = Q-06 (health/restarting) | disputed | Без изменений: `restarting` объявлен только в `HostOverview`; тип `HostHealth` его не содержит, потребителей в health/UI нет. Расширение — отдельная задача. |
| C-08 = Q-07 (KeepAlive + exit 1) | disputed | Осознанный self-heal; README описывает повтор и отсутствие ротации журнала. Не менялось. |
| C-10 = Q-09 (ACC_CONFIG/ACC_STATE_DIR) | disputed | install/status/uninstall читают те же стандартные пути, что job, и предупреждают о заданных переменных. Не менялось. |

### Ограничения итерации

- Реальная установка plist, `kickstart -k`, `kill -9` живого стенда, перезагрузка не
  выполнялись: ручной `up` (pid 75810) обслуживает текущую сессию. Проверены `renderPlist` →
  `plutil -lint` и `npm run autostart:status` (только чтение) на живой машине.
- Окно между `spawn` и `record` уменьшено до одного `ps`-вызова, но не равно нулю; после
  планового перезапуска backend (exit 75) запись заменяется сразу после spawn.
- `launchd`-тесты по-прежнему идут на инъецированных fs/run.
