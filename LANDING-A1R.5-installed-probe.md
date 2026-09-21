# A1R.5 — реальная проба установленного pi-subagents на Linux

Критерии этапа — `PLAN-A1R-inprocess-upstream-migration.md`, раздел «A1R.5»: `pi install
git:…@<sha>` в throwaway `PI_CODING_AGENT_DIR`, реальный Pi 0.85.1, родитель через SDK,
faux-провайдер, fixture MCP-сервер; ровно один ответчик ping; preflight→launch→terminal;
exact-ten; отмена; reload; headless; негативные канарейки с нулём запросов; нет второй копии
`pi-subagents`. GitHub-проба по SHA после push — A1R.7, здесь не выполнялась.

Итог: на `b2df9867b71896260fc711b89e8569beb6bd1b81` все проверки пройдены без тестового шва.
До этого проба нашла четыре дефекта, из-за которых bound-путь на установленном пакете не
работал; они исправлены коммитами `4724606a`, `2416c80b`, `b2df9867`.

## Стенд

Хост `ii-01`: Ubuntu 24.04.4 LTS, Linux 6.8.0-139-generic x86_64, Node v22.22.1, npm 11.13.0,
`/usr/bin/git` 2.43.0 (root-owned, требование `trustedSystemGitExecutable`).
Pi 0.85.1 (`@earendil-works/pi-coding-agent`), pi-mcp-adapter 2.26.1 (пин onecpi),
`pi-subagents` 0.69.0.

Всё живёт в `~/a1r5-probe-20260921` (далее `$B`); глобальные настройки, `~/.pi`, `~/.npm`,
системный npm и git не менялись, sudo не использовался:

| путь | что |
|---|---|
| `$B/src` | не-bare клон из `git bundle` ветки (push не делался) |
| `$B/gitconfig-install` | `url.<$B/src>.insteadOf = https://github.com/itrous/pi-subagents.git`, только для `pi install` |
| `$B/sdk` | `npm install --prefix` Pi 0.85.1 |
| `$B/npm-cache` | отдельный кэш npm |
| `$B/home/.pi/agent` | `HOME`/`PI_CODING_AGENT_DIR` пробы: `settings.json`, установленный пакет в `git/github.com/itrous/pi-subagents` |
| `$B/owner` | пакет-владелец агентов пробы, зависимости как у onecpi |
| `$B/ws-leaf`, `$B/ws-parent`, `$B/ws-foreign` | cwd листа (Y, проектный `.pi/mcp.json`), cwd родителя (X, без конфига), чужой конфиг |
| `$B/home-<sha>`, `$B/out-<sha>`, … | снимки прогонов промежуточных SHA |
| `$B/dbg` | отладочный клон с локальным коммитом, печатающим операцию нарушения фасада (только для диагностики) |
| `$B/testcheckout` | клон для прогона тестовых наборов на Linux |

`insteadOf` нужен, чтобы клонировать без push, а `remote.origin.url` установленного checkout
остался каноническим: identity читает его `git config --local` в закрытом окружении
(`GIT_CONFIG_GLOBAL=/dev/null`), подмена URL на это не влияет.

Откат: `rm -rf ~/a1r5-probe-20260921` — только по решению человека; других следов нет.

## Команды

```sh
# локально
git bundle create a1r.bundle feat/a1r-base            # затем инкрементальные бандлы на каждый SHA
scp a1r.bundle kelishev@ii-01:a1r5-probe-20260921/
# ii-01
git clone a1r.bundle src -b feat/a1r-base
npm install --prefix sdk --cache npm-cache @earendil-works/pi-coding-agent@0.85.1
env HOME=$B/home PI_CODING_AGENT_DIR=$B/home/.pi/agent GIT_CONFIG_GLOBAL=$B/gitconfig-install \
  GIT_CONFIG_NOSYSTEM=1 npm_config_cache=$B/npm-cache PI_SKIP_VERSION_CHECK=1 \
  sdk/node_modules/.bin/pi install git:https://github.com/itrous/pi-subagents.git@<sha>
bash probe/run-probe.sh $B                             # probe/ = spikes/A1R.5/
```

`spikes/A1R.5/`: `probe.mjs` (родитель — `createAgentSession` SDK с `DefaultResourceLoader`
поверх `settings.json`, шина событий — `createEventBus`), `faux-llm.mjs` (OpenAI-совместимый
сервер на 127.0.0.1, считает запросы, `HOLD:` держит ответ), `fixture-mcp.mjs` (stdio MCP,
задержка `initialize` 1,5 с вместо старта настоящего сервера), `owner/` (агенты
`probe-plain`, `probe-1c` — `read` плюс десять `bsl-*` и `package:pi-mcp-adapter`,
канарейки `probe-narrow`/`probe-shadow`/`probe-drift` с относительными расширениями),
`run-probe.sh`. Выводы — `spikes/A1R.5/out/`, прогоны промежуточных SHA — `out/history/`.

## Дефекты, найденные пробой

| # | симптом на установленном пакете | причина | исправление |
|---|---|---|---|
| 1 | identity `dirty` | `pi install git:` делает `npm install --omit=dev`; npm 11 снимает `"peer": true` с двух dev-записей upstream-lockfile | `4724606a`: lockfile приведён к неподвижной точке `npm install --omit=dev`, `npm ci` и `npm install` |
| 2 | identity `unverified_source` (после ручного возврата lockfile) | отслеживаемый symlink `spikes/A1R.0/c5c6/c6/pkg/link-to-outside.js` | `4724606a`: спайк C6 создаёт ссылку на время прогона; тест запрещает symlink и gitlink в дереве |
| 3 | preflight `unsupported_mode` у любого package-агента с `./ext/*.ts` (так устроены агенты onecpi: `./ext/git-read.ts`) | upstream разворачивает `./…` в абсолютный путь (`agents.ts:2047`), слой ждал сырой `./`-вид | `2416c80b`: абсолютная ссылка возвращается в относительную запись контракта; выход за каталог агента закрыт |
| 4 | MCP-инструмент в bound-листе падает `state.approvalEvents.emit is not a function` | фасад отдавал `pi.events` отсоединённым объектом без функций; адаптер публикует запрос одобрения перед каждым вызовом (`tool-approval.ts:129`) | `b2df9867`: фабрики одного прогона получают общую приватную шину с семантикой `createEventBus`; шина хоста недостижима, как у A1 в отдельном процессе |

Дефекты 2–4 закрыты тестами, которые проваливаются на прежнем коде (проверено откатом правки).
Дефект 1 проверен командами: на чистом клоне прежний lockfile меняется после
`npm install --omit=dev`, новый не меняется ни после него, ни после `npm ci`, ни после
`npm install` (npm 11.19 локально; `--omit=dev` и `npm ci` — также npm 11.13 на ii-01);
сетевой установки в наборе тестов нет.
Тесты A1R.4 их не видели: identity подставлялась швом, агенты пакетов собирались вручную с
`package:`-ссылками, вместо адаптера стояла фикстура.

## Результаты на `b2df9867`

`out/main.json` (process.cwd = cwd сессии = Y), `out/mismatch.json` (process.cwd = X,
в argv `--mcp-config Y/.pi/mcp.json`), `out/foreign-config.json`.

| проверка | результат |
|---|---|
| identity без шва | `available: true`, commit `b2df9867…`, digest `sha256` канонической проекции; 682–1281 мс на 1137 файлах |
| capability | ping: `activeRuntimeIdentity: {version: 2}`, `boundForegroundLeaf: {version: 2}` (самопроверка полей Pi прошла на настоящем 0.85.1) |
| один ответчик, нет второй копии | 1 ответ на ping до и после reload; в загрузчике один путь `…/itrous/pi-subagents/index.ts`; слот поколения совпадает с `serverInstanceId` ping |
| preflight→launch→terminal | `probe-plain`: 1 `started`, 1 `completed`, `launchContractDigest` терминала = digest preflight, 1 запрос с инструментами `[read]` |
| headless structured | `hasUI: false`; `result: {kind: "structured", value: {ok: true}}` |
| exact-ten | `probe-1c`: оба запроса к провайдеру ровно `read` + 10 `bsl-*`; вызовы `bsl-ws_search` и `bsl-ref_its_help` выполнены фикстурными серверами; `completed` |
| точная отмена | чужой target, подделанный MAC, чужая привязка, конверт без binding — 0 терминалов, оба листа живы; верный токен дважды → один `cancelled` за 1,2 с, провайдер увидел обрыв, после терминала обновлений нет; сосед `completed` |
| канарейки, 0 запросов | narrow: `native_tool_registry_mismatch`, `toolsMissing: [read]`; shadow: `native_tool_registry_mismatch`/`package_mutation`; drift (байты расширения после preflight): `invalid_request` на приёме, `started` нет; положительный контроль на том же счётчике — 1 запрос, `completed` |
| приватность | RPC `status` во время живого bound-листа: `totalActive: 0`, ни runId, ни имени агента |
| reload | живой лист старого поколения → ровно один `cancelled`; новый `serverInstanceId`, 1 ответчик; preflight на старый id — без ответа; лист нового поколения `completed` |
| env | `process.env` родителя побайтно равен исходному после всех прогонов |
| гейт Д10 | `probe-1c` при process.cwd ≠ cwd листа: `unavailable_context`/`mcp_cwd_mismatch`, 0 запросов, хотя в argv явный `--mcp-config`; `probe-plain` в том же процессе `completed` |

Прогоны промежуточных SHA: `out/history/main-4724606a.json` (дефекты 3 и `typebox` фикстуры),
`out/history/main-2416c80b.json` и `debug-violation-2416c80b.txt` (дефект 4 и proxy-инструмент,
см. ниже).

## MCP и cwd: явная передача пути к конфигурации (вилка В1)

Замер тем же адаптером 2.26.1 из `owner/node_modules`, обычным загрузчиком Pi, сессия в Y
(`out/adapter-*.json`; «полон» — все десять `bsl-*` активны):

| прогон | process.cwd | кэш метаданных | `--mcp-config` | полон на возврате `create()` | через 2,5 с |
|---|---|---|---|---|---|
| `adapter-mismatch-cold` | X | нет | нет | **нет (0 из 10)** | да |
| `adapter-mismatch-config-cold` | X | нет | да | **да** | да |
| `adapter-match` | Y | нет → прогрет | нет | да | да |
| `adapter-mismatch-warm` | X | да | нет | да | да |
| `adapter-mismatch-config-warm` | X | да | да | да | да |

Исход B пробы П1 воспроизведён на Linux: без явного пути и с холодным кэшем набор неполон ровно
в точке снимка реестра; с тёплым кэшем — полон, то есть результат зависит от состояния кэша.
Явный путь делает набор полным при любом кэше. Bound-путь его не использует: Д10 закрывает
запуск до сессии, что и показал `mismatch`. Реализация В1 в форке не входит в A1R.4/A1R.5: она
делает конфигурацию адаптера входом контракта v2 и требует своего плана с ревью.

`foreign-config`: хост запущен с `--mcp-config`, указывающим на конфиг с теми же именами
серверов и другими командами, cwd совпадает. Лист `completed`, вызов обслужил проектный сервер
(`fixture:a1r5-bsl-ws:search`), не чужой: флаг хоста до исполнения листа не доходит.

## Наблюдения для A1R.6 и решений человека

- **Зависимости адаптера берутся из владельца, а не из хоста.** Приватный jiti загрузчика
  пакетов не повторяет alias Pi (`@earendil-works/*`, `typebox` → копии хоста,
  `loader.js:66-113`). Адаптер импортирует в рантайме `typebox`, `pi-tui`, `pi-ai/compat`;
  в bound-листе они резолвятся из `node_modules` владельца. У onecpi это `typebox` 1.1.38,
  `pi-ai`/`pi-tui` 0.84.3 при хосте 0.85.1. Без `typebox` во владельце лист закрывается
  `package_load_error` (первый прогон фикстуры).
- **`settings.disableProxyTool: true` обязателен для exact-ten.** Без него `lazyConnect`
  адаптера на первом вызове активирует `mcp` после барьера (`index.ts:913`) → закрытый
  `package_mutation`. onecpi задаёт этот флаг (`bin/a2-bound-probe.mjs:212`).
- **Бюджет identity.** Проверка дерева укладывается в 0,7–1,3 с из 2 с; на загруженном хосте
  возможен `git_timeout`, то есть закрытый отказ по доступности.
- **Drift до приёма** даёт `invalid_request` при финальной пере-резолюции, а не
  `package_bytes_drift`: последний возможен только в окне между приёмом и загрузкой.
- На ii-01 есть чужой `/tmp/.agents`: upstream поднимает корень проекта до `/tmp`, если во
  временном каталоге нет своего маркера. Новый unit-тест якорит корень каталогом `.pi`.

## Интерфейсы владельца хоста

Не закрыты и в пробе не проверялись: пробный родитель headless, TUI нет. Остаются видимыми
и управляемыми bound-прогоны через slash-команды (`src/slash/slash-commands.ts:238,246`),
TUI Fleet (`src/tui/fleet.ts`, `src/tui/fleet-status.ts`) и признак активности pi-web
(`src/integrations/pi-web-session-liveness.ts:49`) — см. `FORK.md`, «Known privacy limits».
Закрытие требует правок upstream-файлов сверх семи точек, решение за человеком.

## Тесты

Локально (macOS, `b2df9867` плюс правка теста) и на ii-01 (`$B/testcheckout`):
`npm run typecheck`, `test:unit`, `test:integration -- --test-concurrency=2`, те же наборы с
`PI_SUBAGENTS_NATIVE_SDK`. Linux-only `test/unit/source-identity.test.ts` впервые прогнан на
Linux: 27 тестов identity зелёные. Итоги — в отчёте этапа.
