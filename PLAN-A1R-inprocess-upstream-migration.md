# A1R — перенос bound/active-runtime контракта форка на in-process архитектуру upstream

## Статус и граница

Зонтичный план миграции. Этапы A1R.0–A1R.2 расписаны до исполнимых шагов. A1R.3,
A1R.4 и A1R.6 здесь заданы целью, точками подключения, инвариантами и критериями
приёмки; перед реализацией каждого из них пишется свой `PLAN-A1R.<N>-*.md` и
проходит собственный круг ревью (как A1.2–A1.8). Ветка форка `main` и пин onecpi не
меняются до A1R.7. Никаких push/merge в `main` без явного разрешения человека.

**2026-09-20:** A1R.0 выполнен (`LANDING-A1R.0-spikes.md`, артефакты `spikes/A1R.0/`);
решения Р1–Р11 приняты человеком — раздел «Принятые решения». Поправки по итогам
спайков внесены в «Целевую модель доверия», «Стратегию интеграции», A1R.3, A1R.4,
A1R.6 и «Риски».

Имя: `A2` и `A3` заняты в onecpi (A2 — `docs/history/attestations/a2-native-agents-attestation.md`,
`bin/a2-bound-probe.mjs`; A3 — 54 коммита со scope `(a3)`, `agents/ext/probe-delegate.ts:106`).
`A1R` («A1 re-platform») не встречается ни в одном из репозиториев
(`git grep -n A1R` в обоих — пусто; `git log --all --format=%s | grep -c A1R` → 0).

## Задача

Постановка вызывающего (резюме): спланировать миграцию доработок форка
`itrous/pi-subagents` (bound/active-runtime контракт A1, опубликованный пин
`c32663ec7e9f4c3c35456552c1d262eeeb845a60`) на новую архитектуру upstream
`nicobailon/pi-subagents`, где с `d9bc62f8` (#1844) дети — in-process `AgentSession`.
Решение человека зафиксировано: «вариант 2» — перенести контракт на новую
архитектуру, не отказываясь от доработок и не замораживая форк; форк должен дальше
регулярно синхронизироваться с upstream. План должен дать: целевую модель доверия с
явным перечнем ослабевающих гарантий; стратегию интеграции с минимальной площадью
правок upstream-файлов и кандидатами на апстрим; этапы с проверяемыми критериями
(сначала база: merge upstream + удаление мёртвого, затем слои контракта);
отдельный этап onecpi с согласованием версии контракта; открытые решения; риски и
откат.

## Вне рамок

- Реализация любого этапа (этот файл — только план).
- Содержимое ревьюера onecpi, маршруты, промпты, корпус, платные прогоны.
- Защита от злонамеренного кода пакетов внутри процесса родителя сверх
  перечисленного в «Целевой модели доверия» (in-process это не обеспечивает).
- Фоновый (async/runner) путь для bound-листов — только как альтернатива в решении Р1.
- Windows-поддержка bound-пути.
- Настройка самого еженедельного pio-задания (только требования к нему, Р9).

## Допущения, принятые без вопроса

Вызов автономный (инструмента вопросов у планировщика нет); вилки вынесены в
«Открытые решения», здесь — выбранные ветки по умолчанию. С 2026-09-20 все вилки
закрыты — см. «Принятые решения».

1. **Хост bound-листа — родительский процесс (in-process foreground)**, как у
   upstream. Подтверждено решением Р1.
2. **База A1R.1 — `upstream/main` = `8bd275bba0dc13273eff366e348378d41ad5535e`**
   (последний зафетченный). Если к старту A1R.1 выбран другой SHA, все числа
   A1R.1 пересчитываются командами из «Устройства сейчас».
3. **Интеграция merge-коммитом**, а не пересборкой ветки: первый родитель — `main`
   форка, второй — база. Так история форка сохраняется, а будущие `git merge
   upstream/main` считают merge-base от базы.
4. **Bound-протокол переезжает на собственный канал форка** `subagents:bound:v2:*`
   (ping/preflight и события запроса/отмены). Upstream-каналы
   `subagents:rpc:v1:*` и `prompt-template:subagent:*` остаются чисто upstream.
   Это снимает правки `rpc.ts`/`prompt-template-bridge.ts` для протокола (Р7).
5. **Версия контракта для onecpi — v2**: `capabilities.boundForegroundLeaf.version: 2`,
   `launchContract.version: 2`. Поле `turnBudget` из контракта удаляется: upstream
   удалил turn-budget (`94ecb662`, #1579), а onecpi его не задаёт ни в одном
   вызове (`git grep -n turnBudget -- src bin` вне транспорта/readiness — только
   тип `src/lib/review/transport.ts:27`).
6. **Окружение листа заменяется привязками сессии** (`bindings`, пространство
   `onecpi-review/1`), а не `process.env` (Р5).
7. **Этапы 3/4/6 получают собственные планы** с ревью до реализации.
8. **Установщик форка удаляется** (`install-lib.mjs`, `test/integration/fork-installer.test.ts`),
   `install.mjs` возвращается к upstream-версии. Три потребителя в onecpi
   мигрируют в A1R.6.
9. **Рабочее дерево**: A1R.1+ выполняются в отдельном task worktree от
   `origin/main` форка (`cdcee44d`), по правилам worktrunk; этот план остаётся
   неотслеживаемым файлом в корне основного checkout.
10. **Целевой Pi — установленный хост 0.85.1** (`pi --version` → `0.85.1`); тестовый
    shim в devDependencies остаётся upstream-овским (`0.81.0`).

## Устройство сейчас

Числа получены командами в `/Users/kiriller/src/pi-subagents` и `/Users/kiriller/src/onecpi`.

### Объём расхождения

- merge-base `2c2db5b8`; `git rev-list --count 2c2db5b8..main` → 24;
  `git rev-list --count 2c2db5b8..upstream/main` → 777 (`--no-merges` → 734).
- Дельта форка: `git diff --name-status 2c2db5b8 main` → 66 добавленных, 46
  изменённых файлов; в `src/` — 24 добавленных, 27 изменённых
  (`… -- src | awk '$1=="A"'` / `'$1=="M"'`).
- Пробный merge без касания дерева: `git merge-tree --write-tree --name-only main upstream/main`
  → 30 файлов с конфликтами, из них 3 modify/delete (`src/runs/shared/pi-args.ts`,
  `test/unit/pi-args.test.ts`, `test/support/mock-pi-script.mjs`); сумма
  `grep -c '^<<<<<<<'` по блобам дерева-результата → 125 участков. Больше всего:
  `execution.ts` 28, `subagent-executor.ts` 28, `extension/index.ts` 12, `rpc.ts` 7,
  `mcp-direct-tool-allowlist.ts` 6.

### Форк (дочерний процесс pi)

- Bound-лист запускается отдельным процессом с пятью stdio; fd3/fd4 — кадры
  доказательств: `src/runs/foreground/execution.ts:646`.
- Дочерний гейт реестра при сбое вызывает `process.exit(...)`
  (`src/runs/shared/bound-tool-registry-runtime.ts:60-61`), фабрики пакетов
  сдерживаются патчем глобального `Module._resolveFilename` (там же :212) и
  фасадом API (`createBoundPackageApi`, :161).
- Аттестация исполняемого pi — `attestPiSpawnCommand`
  (`src/runs/shared/pi-command-evidence.ts:156`) и node-проба `allToolNames` (:131).
- Отмена эскалирует до `SIGKILL` и ждёт `close` (`execution.ts:683,815,974`).
- Координатор/реестры попыток — process-global через `globalThis`
  (`src/slash/structured-attempt-coordinator.ts:355`,
  `bound-identity-registry.ts:52`, `bound-pending-cancellation-registry.ts:33`).
- Приватность bound-прогонов в публичном RPC — `privateBoundStatusRequested`
  (`src/extension/rpc.ts:558`, применения :616, :626, :638); ping объявляет
  `boundForegroundLeaf: { version: 1 }` (:407).
- Окружение листа — allowlist из 2 имён `ONECPI_REVIEW_ROOT`,
  `ONECPI_REVIEW_SUBJECT_PATH` (`src/api/active-bound-environment.ts:6`).
- Импорт-граф 24 добавленных `src`-файлов: 11 завязаны на процесс ребёнка или на
  удалённые upstream-модули (`pi-args`, `turn-budget`, `model-fallback`): 9 в
  `src/runs/shared/` (`bound-tool-registry-{bootstrap,gate,runtime}.ts`,
  `bound-tool-registry-state.cjs`, `bound-package-mediator.ts`,
  `bound-denied-tool-runtime.ts`, `tool-registry-collector.ts`,
  `pi-command-evidence.ts`, `bound-runtime-evidence.ts` — последний перечисляет
  файлы дочернего runtime, :61) и 2 в `src/api/` (`active-bound-resolver.ts`,
  `active-bound-runtime.ts`). Остальные 13 — кандидаты на сохранение:
  `canonical-json`, `source-identity`, `core-runtime-tools`, `package-tree-evidence`,
  `tool-registry-proof`, `denied-tool-proof`, `launch-receipt`,
  `active-bound-environment`, `active-bound-preflight`,
  `active-bound-package-extensions`, `bound-identity-registry`,
  `bound-pending-cancellation-registry`, `structured-attempt-coordinator`;
  `tool-registry-proof` импортирует тип из удаляемого `bound-runtime-evidence`
  (:4), `denied-tool-proof` — из `tool-registry-proof` (:2), поэтому ожидаемо
  откладываются по правилу шага 7 A1R.1. Удалённые upstream-файлы:
  `git diff --name-status 2c2db5b8 upstream/main -- src | awk '$1=="D"'` → 8.
- Имена удаляемых модулей упоминают (`git grep -lE 'pi-args|bound-tool-registry-runtime|pi-command-evidence|install-lib'`):
  на `main` — 57 строк в `src`+`test`, на `upstream/main` — 0; из добавленных
  форком файлов — 7 в `src` (все входят в 11 удаляемых) и 8 в `test`.

### Upstream (`8bd275bb`)

- Ребёнок — `createAgentSession` в процессе хоста
  (`src/runs/shared/child-session.ts`); фабрика инъектируема: `RunSyncOptions.childSessionFactory`
  (`src/shared/types.ts:2411`), используется в `execution.ts:581`, создание
  сессии — `execution.ts:1399-1400`; отмена — `session.abort()` (`execution.ts:607-612`),
  результат отдаётся только после `dispose()` (`execution.ts:788`); таймаут
  `session_shutdown` 5 с (`child-session.ts:245`).
- Foreground-хост — `host: "parent"` (`execution.ts:432`): ambient-расширения не
  грузятся (`child-launch.ts:299`), `processEnv` задаётся только runner-хосту
  (`child-launch.ts:322`). `applyProcessEnv` пишет в `process.env` без
  восстановления (`child-session.ts:201`, вызов :288), окно загрузки сериализовано
  (`let loading`, :186). Изоляция модулей расширений опирается на приватное поле
  загрузчика `loaded` (`resetExtensionCacheOnReload`, :195).
- MCP-серверы только из runtime-снимка адаптера — отказ
  (`child-tool-plan.ts:357`); CHANGELOG 0.65.0: «Foreground children no longer load
  ambient extensions. Use background children for agents that need MCP tools».
- RPC: `SUBAGENT_RPC_METHODS = ["ping","status","manage","spawn","steer","interrupt","stop","resume"]`
  (`src/extension/rpc.ts:34`) — без `preflight`; `pingData` без
  `serverInstanceId`/`sourceIdentity` (`rpc.ts:440`).
- Мост структурных делегаций вызывает `executor.executeDelegated`
  (`src/extension/index.ts:755`); при `session_shutdown` все живые in-process дети
  прерываются `disposeChildSessions()` (`index.ts:1194`).
- TS-преflight: `SUBAGENT_LAUNCH_CONTRACT_VERSION = 3` (`src/api/preflight.ts:33`),
  `LAUNCH_BINDING_PROJECTION_VERSION = 2` (`src/shared/launch-contract.ts:10`);
  `extensionBindings` доставляются ребёнку только через env runner-а
  (`child-launch.ts:164`), foreground-ребёнок их не получает.
- Диагностика `requiredTools` на старте — `subagent-prompt-runtime.ts:487`,
  блокировка вызовов — `tool_call` (:345, :389), свой `before_provider_request` (:507).

### Pi 0.85.1 (установленный хост)

- Исключение обработчика `before_provider_request` проглатывается, запрос уходит с
  прежним payload (`dist/core/extensions/runner.js:828-847`). Запуск
  `ExtensionRunner.emitBeforeProviderRequest` с бросающим обработчиком:
  `throwing-handler: resolved payload= {"tools":["a"]} errors= ["gate-deny"]`;
  положительный контроль (обработчик возвращает `{tools:[]}`):
  `resolved payload= {"tools":[]}`. Следствие: in-process барьер «до провайдера»
  нельзя строить на исключении из этого хука.
- Поток модели — поле `Agent.streamFunction` (`pi-agent-core/dist/agent.js:93,119,272`),
  allowlist инструментов применяется в сессии (`dist/core/agent-session.js:2108-2110`).

### onecpi (потребитель)

- Пин `c32663ec…`: `git grep -c` → 7 вхождений в 6 файлах
  (`src/lib/review/a1-readiness.ts:13`, `bin/pi-package-migration.mjs:9`,
  `bin/install.sh:461`, `bin/g-staging-canary.mjs` ×2, `bin/install.test.mjs:772`,
  `docs/installation.md:130`).
- `A1_RUNTIME_EXTENSION_NAMES` — 18 имён (`a1-readiness.ts:14-18`), сверяются
  поимённо и по порядку с `toolRegistry.runtimeExtensions`; контракт проверяется
  строго по ключам и `version === 1` (`a1-readiness.ts:312-314`).
- Против чистого upstream ping onecpi падает закрыто: `malformed_ping`
  (`a1-readiness.ts:216`), без capability — `unsupported_capability` (:228).
- Расширения пакета читают процессные значения: `review-read`
  (`src/extensions/review-read/index.ts:25-27`: `process.cwd()`,
  `process.env.ONECPI_REVIEW_*`), `git-read` (`src/extensions/git-read/index.ts:74`:
  `process.cwd()`), `review-workspace` (`policy.ts:124-126`: env-объект с 4
  именами `ONECPI_REVIEW_WORKSPACE_*`).
- **Уже существующий дрейф**: для lens-листов onecpi шлёт 4 имени
  `REVIEW_WORKSPACE_ENV_NAMES` (`pi-native-transport.ts:91,93,97,99`), а пин
  форка допускает только 2 (`active-bound-environment.ts:6`) — такие preflight
  на текущем пине отвергаются на разборе окружения.
- `pi-mcp-adapter@2.26.1` читает `process.env.MCP_DIRECT_TOOLS` при вызове
  фабрики (`node_modules/pi-mcp-adapter/index.ts:123`) и при инициализации
  (`init.ts:374`).
- Потребители `install-lib.mjs` форка: 3 файла (`bin/a2-bound-probe.mjs`,
  `bin/a2-parity-probe.mjs`, `bin/pi-package-migration.test.mjs`).

## Целевая модель доверия

Гарантии A1 → A1R. «Ослабевает»/«исчезает» — решения человека (Р1–Р6), приняты 2026-09-20.

| Гарантия A1 | A1R (in-process) | Статус |
|---|---|---|
| **Аттестованный runtime**: sha256 исполняемого pi/shebang/пакета, node-проба `allToolNames`, `pi --version` родителя = ребёнка | Runtime = модуль `@earendil-works/pi-coding-agent`, реально загруженный в процесс хоста: корень пакета + `name`/`version` + digest собственных файлов пакета без `node_modules` (Р2; замер на 0.85.1: 1056 файлов, 44–150 мс, считается раз на процесс); `version` на диске ≠ загруженной → закрытый отказ. Встроенные инструменты — из `allToolNames` этого же модуля без отдельного процесса. Сверка родитель/ребёнок вырождается (один модуль) и удаляется | Ослабевает (Р2 принято): нет хеша исполняемого файла и зависимостей Pi; digest описывает файлы на диске, а не код в памяти |
| **Доказательство реестра**: ребёнок извлекает имена из payload провайдера, пишет кадр с nonce в fd3, при расхождении `exit 78` до сети | Хост снимает `getActiveToolNames()` после `bindExtensions` и до `prompt()` (не `getAllTools()` — С2); на каждом вызове модели обёртка `session.agent.streamFunction` сверяет `context.tools` с контрактом и при расхождении не вызывает исходный поток (С1: 0 запросов, без автоповтора, переживает turn и `setModel`). Вызовы без инструментов (compaction, branch summary) идут через тот же поток — у bound-листа compaction запрещена. Payload-уровень — только наблюдение в последнем `before_provider_request` с прерыванием после факта | Ослабевает (Р3 принято): «ноль запросов» доказан для дрейфа реестра/`context.tools`; для дрейфа только в сборке payload — не более одного запроса |
| **Denied-tool proof**: поштучные кадры fd4 | Коллектор в памяти хоста, наполняемый inline-хуком `tool_call` bound-слоя | Сохраняется |
| **Песочница фабрик пакетов**: отдельный процесс, фасад API, глобальный guard резолва, `exit 77` | Фасад API и **гигиеническая проверка графа транспилируемых модулей** на уровне экземпляра jiti (`transform` + пролог, С6); нативные входы и `.mjs`/`.cjs`/`type:module` в дереве пакета запрещаются при аттестации дерева; глобальный патч `Module._resolveFilename` удаляется (задел бы родителя и соседей); нарушение — исключение + прерывание сессии. `createRequire`, `module.constructor._load`, `fs`+`new Function` не сдерживаются — это не граница безопасности; реальная гарантия — digest байтов пакета и доверие к пакетам onecpi | Исчезает изоляция (Р4 принято): код пакета исполняется с полными правами процесса родителя (память, ключ HMAC, соседние сессии, fs) |
| **Сдерживание сбоев**: падение/зависание/OOM ребёнка не задевает родителя | Синхронный бесконечный цикл или OOM в инструменте пакета роняет/вешает родителя и всех соседей (С5: ни одного тика event loop, помогает только SIGKILL) | Исчезает (Р4 принято) |
| **Bound environment**: allowlist env на spawn, вычистка `PI_SUBAGENT_*`, `NODE_OPTIONS`, `LD_*`, `DYLD_*` | Env ребёнка не существует. Значения листа передаются привязками сессии (`bindings`), доступными расширению по id своей сессии; контракт связывает digest привязок. Для `MCP_DIRECT_TOOLS` — окно загрузки с восстановлением (С3). Процессы MCP-серверов наследуют env родителя | Ослабевает (Р5); onecpi-расширения переписываются |
| **Isolated cwd/discoveryCwd**: `cwd` процесса ребёнка = bound cwd | `cwd` сессии = bound cwd (встроенные инструменты и `ctx.cwd`); `process.cwd()` остаётся родительским | Ослабевает для кода, читающего `process.cwd()` (onecpi правится) |
| **Точная отмена**: кортеж + HMAC-токен, `SIGKILL` на дедлайне, терминал после `close` | Кортеж + токен без изменений; `void abort()` → жёсткий таймер → `dispose()` с гонкой `session_shutdown` против 5 с, без ожидания `prompt()`/`abort()`: при инструменте, игнорирующем сигнал, они ждут его конца (С5: 8,5 с, в общем случае без предела); терминал после `dispose()`; события ретранслируются только через `session.subscribe` с отпиской на `dispose()`. Аттестованные инструменты onecpi запускают подпроцессы только через `spawn({signal})` (С5: контроль 4–10 мс, подпроцесс убит) | Ослабевает (Р6 принято): «процесс завершён» → «сессия утилизирована»; инструмент, игнорирующий сигнал, и его подпроцессы продолжают работу |
| **Изоляция параллельных листов**: отдельные процессы | Отдельные экземпляры модулей расширений (upstream, приватное поле `loaded`); `globalThis`/`process` общие | Ослабевает |
| Receipt/HMAC, cancellationToken, координатор попыток, реестры идентичности, source identity, reload/drain | Уже жили в процессе родителя — переносятся без изменения семантики; reload по-прежнему прерывает только попытки старого поколения | Сохраняется |

## Стратегия интеграции

**Принцип**: весь bound-слой — файлы, которых нет в upstream; в upstream-файлах —
только узкие точки подключения из закрытого списка. Мера — число
upstream-файлов, отличающихся от базы U:
`git diff --name-only --diff-filter=MD <U> HEAD`
(положительный контроль: `git diff --name-only --diff-filter=MD 2c2db5b8 main | wc -l` → 46,
то есть команда видит правки форка).

**Закрытый список точек подключения** (после A1R.4; не больше 7 файлов):

- Т1 `src/extension/index.ts` — регистрация bound-модуля и его остановка на
  `session_shutdown`.
- Т2 `src/runs/foreground/subagent-executor.ts` — проброс приватной
  (Symbol-ключ, не сериализуемой в событиях) bound-возможности из
  `executeDelegated` в `RunSyncOptions.childSessionFactory`. Всё остальное делает
  декоратор фабрики: сверка `ChildSessionLaunch` с контрактом непосредственно
  перед созданием сессии (финальный recheck), подмена путей пакетов на
  аттестованные inline-фабрики, привязки, обёртка потока, коллектор отказов.
- Т3 `src/extension/rpc.ts` — исключение приватных bound-прогонов из публичных
  `status/steer/resume/stop` (только если Р8 = «сохранить приватность»).
- Т4–Т7 — не более 4 файлов малых переносов из A1R.2, каждый с
  кандидатом-PR в upstream.

`execution.ts`, `child-tool-plan.ts`, `child-session.ts`, `prompt-template-bridge.ts`,
`agents.ts`, `skills.ts` форком не правятся: bound-резолвер (обнаружение
package-агентов, `package:`-ссылки, резерв имён `CORE_RUNTIME_OWNED_TOOLS`/
`powershell`/`cursor`/`subagent_wait`, `discoveryCwd` для MCP) живёт в модулях
форка и вызывает экспортированные функции upstream (`resolvePiLaunchToolPlan`,
загрузчики агентов). Если экспорта не хватает — сначала PR-кандидат в upstream,
временная точка входит в лимит Т4–Т7.

**Новые модули форка** — каталог `src/bound/` (конфликтов с upstream не даёт
по построению); выжившие модули A1 остаются на своих путях.

**Кандидаты на апстрим** (открытие PR — после разрешения человека):
1. Публичный per-launch хук создания сессии в `pi-subagents/delegation`
   (декоратор `ChildSessionFactory` для одного запуска) — убирает Т2 и
   открывает путь вынести bound-слой в отдельный пакет без форка.
2. Доставка `extensionBindings` in-process foreground-детям по id сессии
   (сейчас только через env runner-а, `child-launch.ts:164`) — убирает нужду в
   `process.env` для привязок.
3. Опция «приватный прогон» для foreground-делегаций — убирает Т3.
4. Малые исправления A1R.2 (консервативная `isPotentialMutationToolCall`,
   `activate/stop` slash-моста, `baseUrl` в `model-info`) — по результату сверки.
5. Баг (A1R.0 С1): диагностика `requiredTools` не блокирует запуск — исключение в
   `agent_start` проглатывается Pi (`subagent-prompt-runtime.ts:485-487`); вдобавок
   сверка идёт по `getAllTools()`, а не по активному набору (С2).
6. Баг (A1R.0 С3): `process.env` не восстанавливается после окна загрузки ребёнка
   (`child-session.ts:201`).

Порядок (Р10): 5 и 6 — сразу, отдельными bugfix-PR с воспроизведением; 4 — после
A1R.2; 1–3 — после A1R.4, когда форма хуков проверена. Каждый PR открывается от
аккаунта человека только с его разрешения на конкретный PR.

**Еженедельные синхронизации**: после A1R.7 задание сливает `upstream/main` в
`sync/*`; ожидаемые конфликты — только Т1–Т7. Каждая синхронизация прогоняет
`typecheck`, `test:all` и bound-тесты; падение bound-тестов при зелёном upstream —
сигнал дрейфа внутренних полей Pi/upstream (см. «Риски»).

## Этапы

### A1R.0 — спайки (проверка гипотез, не продуктовый код) — ВЫПОЛНЕН

Итог 2026-09-20 (`LANDING-A1R.0-spikes.md`): С1 подтверждён (гейт пройден), С4
подтверждён, С2/С3/С5/С6 — частично; С3 прогнан на адаптере 2.26.1 и 2.34.0 с
одинаковым итогом, Р11 не потребовался. Следствия внесены в таблицу доверия, A1R.3,
A1R.4, A1R.6 и «Риски». Ниже — исходная постановка.

Изолированно: временный каталог вне репозитория, throwaway `HOME` и
`PI_CODING_AGENT_DIR`, faux-провайдер — локальный HTTP-сервер со счётчиком
запросов, модуль хоста — установленный Pi 0.85.1. Результат — файл
`LANDING-A1R.0-spikes.md` в корне форка: по каждому спайку установленное
свойство, команда воспроизведения и вывод, включая положительный контроль.

- С1. **Барьер до провайдера**: обёртка `session.agent.streamFunction` при
  расхождении `context.tools` с ожидаемым набором не вызывает исходный поток.
  Исход: расхождение → 0 запросов на faux-сервер, сессия завершена ошибкой;
  контроль: без обёртки тот же сценарий → ≥1 запрос; расширение, меняющее
  активные инструменты в `before_agent_start`, ловится обёрткой.
- С2. **Реестр со стороны хоста**: снимок `getAllTools`/активных имён после
  `bindExtensions` совпадает с `context.tools` первого вызова модели; контроль —
  расширение, добавляющее инструмент в `session_start`, даёт расхождение.
- С3. **MCP-адаптер in-process**: `pi-mcp-adapter@2.26.1` как расширение ребёнка
  с `MCP_DIRECT_TOOLS`, выставленным только в окне загрузки и восстановленным
  после, регистрирует ровно запрошенные direct-инструменты fixture-сервера;
  `process.env` родителя после окна побайтно равен исходному; после `dispose()`
  число процессов MCP-сервера возвращается к исходному. Контроль: без окна —
  другой набор инструментов.
- С4. **cwd и привязки**: инструмент расширения в двух параллельных сессиях с
  разными cwd/привязками видит `ctx.cwd` и привязки своей сессии; встроенный
  `read` относительного пути читает из cwd сессии. Контроль: `process.cwd()` в том
  же инструменте равен cwd родителя.
- С5. **Отмена**: `abort()`+`dispose()` на инструменте, игнорирующем
  `AbortSignal`, — фиксируется, что продолжает выполняться, и время до
  разрешения `dispose()`; контроль — инструмент, уважающий сигнал.
- С6. **Сдерживание импорта**: фабрика, загруженная экземпляром jiti с
  проверкой в `transform`, не может импортировать файл вне аттестованных корней;
  глобальный `Module._resolveFilename` не изменён. Контроль — тот же импорт без
  проверки успешен.

Гейт: провал С1 → остановка и решение человека (Р3, Р1). Провал С3 → решение Р11.
Остальные провалы — корректировка этапов A1R.3/A1R.4 до написания их планов.

### A1R.1 — база: merge upstream и удаление мёртвого

Шаги (исполнитель выполняет по порядку):

1. `git -C <форк> status --porcelain` → пусто; `git fetch upstream`; `U=8bd275bba0dc13273eff366e348378d41ad5535e`
   (или согласованный новый SHA — тогда пересчитать числа раздела «Объём»).
2. Task worktree от `origin/main` (`cdcee44d`), ветка `feat/a1r-base`.
3. `git merge --no-ff --no-commit $U`.
4. Каждый путь, существующий в `$U`, взять из `$U` целиком, включая
   автоматически слитые участки форка:
   `git diff --name-only $U | while read p; do git cat-file -e "$U:$p" 2>/dev/null && git checkout "$U" -- "$p"; done`.
5. `git rm` трёх modify/delete путей: `src/runs/shared/pi-args.ts`,
   `test/unit/pi-args.test.ts`, `test/support/mock-pi-script.mjs`.
6. До любых удалений сохранить вывод
   `git grep -lE 'pi-args|bound-tool-registry-runtime|pi-command-evidence|install-lib' -- test`
   (ожидается 8 файлов, среди них `test/integration/fork-installer.test.ts` и 3 из
   `test/probes/`). Затем `git rm`: 11 файлов из «Импорт-графа» (9 в
   `src/runs/shared/`, 2 в `src/api/`), `install-lib.mjs`, весь `test/probes/`
   (4 файла) и все файлы сохранённого вывода.
7. `npm ci && npm run typecheck`. Файл из 13 кандидатов в `src`, не
   проходящий typecheck без правок, удаляется и вносится в список «отложено до
   A1R.3/A1R.4» (правки в них на этом этапе запрещены).
8. Каждый оставшийся добавленный форком тест
   (`git diff --cached --name-only --diff-filter=A $U -- test` — индекс против `$U`,
   поэтому удалённые шагами 5–6 файлы не попадают) запускается
   отдельно: `test/unit/*` — `node --experimental-strip-types --import ./test/support/isolated-temp-root.mjs --test <файл>`,
   `test/integration/*` — `node --experimental-strip-types --import ./test/support/register-loader.mjs --test <файл>`
   (те же флаги, что в скриптах `test:unit`/`test:integration` upstream
   `package.json`); упавший удаляется и вносится в тот же список.
9. `FORK.md`: новая база `$U`, статус «bound-возможность в этой сборке
   отсутствует», ссылка на этот план. Прочие `.md` форка не трогать.
10. Проверки индекса до коммита (все обязательны; `HEAD` здесь ещё `cdcee44d`,
    поэтому сравнение идёт с индексом через `--cached`):
    - `npm run typecheck`, `npm run test:unit`, `npm run test:integration` — зелёные;
    - `git diff --cached --name-only --diff-filter=MD $U` → пусто;
    - `git grep --cached -nE 'pi-args|bound-tool-registry-runtime|pi-command-evidence|install-lib' -- src test`
      → пусто (контроль: `git grep -nE '…' main -- src test` непуст);
    - `git grep --cached -n boundForegroundLeaf -- src` → пусто (контроль: на `main`
      находит `src/extension/rpc.ts:407`; на `upstream/main` — 0).
11. Один локальный merge-коммит с перечнем «отложено» в сообщении. Без push.
    После коммита: `git rev-parse HEAD^1 HEAD^2` = `cdcee44d…`, `$U`;
    `git merge-base HEAD $U` = `$U` (контроль: `git merge-base main upstream/main` =
    `2c2db5b8`); `git diff --name-only --diff-filter=MD $U HEAD` → пусто.

Шаги 3–5 отрепетированы в одноразовом клоне (`git clone --no-checkout` + merge
`$U`, git 2.55.0): после них 0 неслитых путей (`git diff --name-only --diff-filter=U`),
`git diff --name-only --diff-filter=MD $U HEAD` → 0, `--diff-filter=A` → 66,
`git merge-base HEAD $U` = `$U`, родители коммита — `cdcee44d` и `$U`.

Наблюдаемый исход: сборка = upstream `$U` + неподключённые чистые модули A1;
bound-возможность в сборке отсутствует (проверка — `boundForegroundLeaf` в шаге 10).
Поведение onecpi против такой сборки проверяется в A1R.3 (И1); промежуточные SHA
никем не потребляются — пин onecpi до A1R.7 не двигается.

### A1R.2 — малые переносы и сверка MCP

Для каждого пункта — одно из трёх: (а) upstream уже покрывает → не переносить;
(б) нужно только bound-слою → реализовать в модуле форка; (в) общее исправление →
минимальный участок в upstream-файле (Т4–Т7) + ветка-кандидат PR.

**Полнота перечня.** Шаг 4 A1R.1 возвращает к `$U` каждый изменённый форком
upstream-файл, существующий в `$U` (42 из 46; 4 удалены или переименованы upstream:
`pi-args.ts`, `pi-args.test.ts`, `mock-pi-script.mjs`, `single-execution.test.ts`).
Перечень строится не вручную, а из
`git diff --name-only --diff-filter=M 2c2db5b8 main`, отфильтрованного по
`git cat-file -e "$U:<путь>"`: каждый файл — строка в `LANDING-A1R.2-carries.md` с решением (а)/(б)/(в)
или «уходит вместе с процессной моделью A1» и ссылкой на hunk. Проверка:
число строк = числу файлов перечня.

| Перенос | Сверка |
|---|---|
| `jsonl-writer` error handler | upstream уже имеет обработчик (`src/shared/jsonl-writer.ts:55-56`) → ожидаемо (а) |
| `model-info.baseUrl` | нет в upstream → (б): digest реестра моделей считается в модуле форка из `ctx.modelRegistry` |
| `completion-guard.isPotentialMutationToolCall` | нет в upstream → (в) или (б) по решению A1R.3 |
| `slash-bridge` `activate/stop` | нет в upstream → (в), если lifecycle-тест A1R.4 без него падает |
| резерв имён (`cursor`, `subagent_wait`, `powershell`, `CORE_RUNTIME_OWNED_TOOLS`) | (б): проверка в bound-резолвере |
| семантика `powershell` как `bash` (решение A1P3, `LANDING-A1P3-ADDENDUM-current-runtime-only.md` пп. 3–4): `permissions.ts:23,47` (правило пользователя не переопределяет, решение allow), `agent-memory.ts:25` (`WRITE_TOOLS`), `long-running-guard.ts:153` (непустой вызов = мутирующий) | нет в upstream → (в): общее исправление; тесты форка `test/unit/permissions.test.ts:18,31`, `agent-memory.test.ts:130`, `completion-guard.test.ts:303-304` переносятся вместе с ним |
| MCP `includeTools`/glob, `requestHeadersCommand`, `discoveryCwd` | дифференциальный тест: старые функции из `main` против upstream `resolveMcpDirectToolResolution` на fixture-конфиге с 10 селекторами onecpi (`bsl-ws/*` ×7, `bsl-ref/*` ×3) → одинаковые 10 имён; контроль — fixture с `excludeTools`-глобом, снимающим один инструмент, → 9 у обеих реализаций. `discoveryCwd` → (б) |

Исход: `LANDING-A1R.2-carries.md` с решением по каждой строке; число
upstream-файлов с правками ≤ 4.

### A1R.3 — control plane v2 (свой план `PLAN-A1R.3-*`)

Цель: канал `subagents:bound:v2:*` с ping (`serverInstanceId`, `sourceIdentity`
точного git-checkout, capability **не** объявляется до конца A1R.4), `preflight`
(side-effect-free, контракт v2), приём запроса с receipt/HMAC и финальной
проверкой, targeted cancel, координатор/реестры идентичности, reload/drain.
Резолвер v2 строится поверх `resolvePiLaunchToolPlan` upstream; аттестация
runtime — по строке таблицы доверия (Р2); `environment` → `bindings` с
digest; `toolRegistry.runtimeExtensions` — список модулей bound-слоя,
реально загружаемых в процесс (новый перечень вместо 18 имён). Точка Т1.
Поправки A1R.0: аттестация runtime — по Р2 (digest собственных файлов пакета, кэш
на процесс); остановка всех детей на `session_shutdown` не ждёт `abort()` без предела
(upstream `factory.dispose()`, `child-session.ts:389`, ждёт детей — ограничить по
времени; вывод из замеров С5, отдельно проверить тестом).
Критерии: unit-тесты преflight/receipt/cancel/reload на fake child session
upstream (`test/support/fake-child-session.ts`); golden-digest контракта;
на сборке A1R.3 текущий onecpi (контракт v1, пин `c32663ec…`) читает
`unsupported_capability`/`malformed_ping`; тот же отказ для клиента v2 проверяется в
A1R.6, когда клиент v2 появится.

### A1R.4 — исполнение и доказательства (свой план `PLAN-A1R.4-*`)

Декоратор `ChildSessionFactory` (Т2): финальная сверка launch↔контракт,
загрузка аттестованных фабрик пакетов inline-хуками с фасадом (С6), привязки
сессии (С4), окно `MCP_DIRECT_TOOLS` с восстановлением (С3), снимок реестра до
`prompt()` (С2) и обёртка потока (С1), коллектор отказов, отмена по С5,
приватность (Т3, если Р8). В конце этапа — capability `boundForegroundLeaf: { version: 2 }`
и самопроверка при старте: отсутствие нужных внутренних полей Pi (`loaded`,
`streamFunction`) → capability не объявляется.
Поправки A1R.0 (обязательны для `PLAN-A1R.4-*`):
1. Барьер ставится после `bindExtensions` и до первого `prompt()`; эталон —
   `getActiveToolNames()` или allowlist агента, не `getAllTools()`.
2. Upstream-обёртка `ChildSession` не отдаёт `session.agent` — нужна своя фабрика на
   `createAgentSession` либо точка доступа к агенту внутри Т2.
3. Compaction и branch summary у bound-листа запрещены (тот же поток без инструментов).
4. Хост сам переводит ошибку барьера в провал запуска по последнему
   assistant-сообщению (`prompt()` не отклоняется); текст ошибки не совпадает с
   retry-паттернами Pi.
5. Отмена — по строке таблицы доверия, без ожидания `prompt()`/`abort()`.
6. Окно env `reload()→bindExtensions()` с восстановлением `process.env` после.
7. Привязки — реестр хоста `sessionId→bindings` (Р5): заполняется до `reload()`,
   удаляется на `dispose()` (удаление — отдельный тест, в С4 не проверялось).
8. Самопроверка внутренних полей Pi: `Agent.streamFunction`, `AgentSession.agent`,
   `DefaultResourceLoader.loaded`; их отсутствие → capability не объявляется.
9. Проверка импорта фабрик — гигиеническая (С6), случаи, которые блокируются,
   становятся регрессионными тестами; обходы документируются.
Критерии: интеграционные тесты сценариев A1.8 (четыре листа и Fleet, точная
отмена с изоляцией соседей, headless, reload) на in-process детях; негативные
канарейки (лишний/недостающий/затенённый инструмент, дрейф байтов пакета,
смена модели) → ноль запросов faux-провайдеру.

### A1R.5 — реальная проба с установленным Pi

`pi install git:<локальный checkout>@<sha>` в throwaway `PI_CODING_AGENT_DIR`,
реальный Pi 0.85.1, родитель через SDK, faux-провайдер, fixture MCP-сервер.
Проверки: ровно один ответчик ping на bound-канале; preflight→request→terminal
через зарегистрированный `ToolDefinition.execute`; exact-ten для MCP-профиля;
отмена; reload; headless; негативные канарейки с нулём запросов; вторая копия
`pi-subagents` не загружена. Затем та же проба после push по SHA с GitHub (A1R.7).

### A1R.6 — onecpi (свой план в onecpi, согласование контракта v2)

- Канал и контракт v2 в `src/lib/review/a1-readiness.ts` и
  `pi-native-transport.ts` (имена событий :8-12, `environment` → `bindings`,
  без `turnBudget`, новый перечень runtime-модулей вместо 18 имён).
- Расширения `review-read`, `git-read`, `review-workspace`: `ctx.cwd` вместо
  `process.cwd()` и привязки сессии вместо `process.env`; env-путь остаётся для
  subprocess-транспорта onecpi. Пространство привязок покрывает 6 имён: 2 для
  адъюдикатора и 4 `ONECPI_REVIEW_WORKSPACE_*` для линз (закрывает дрейф из
  «Устройства сейчас»).
- Подпроцессы в аттестованных расширениях — только через `spawn({signal})` (Р6).
- Пин: 7 вхождений в 6 файлах; установщик — переход exact→exact с
  предшественником `c32663ec…`, без version-allowlist.
- Три потребителя `install-lib.mjs` переводятся на `pi install git:…@<sha>` в
  throwaway-домашнем каталоге; a2-пробы заменяются пробой A1R.
Критерии: наборы тестов `src` и `bin` onecpi; изолированный апгрейд
`c32663ec…` → новый SHA с canary; поведение при несовпадении версии — закрытый
отказ.

### A1R.7 — публикация и синхронизации

PR `feat/a1r-*` → `main` форка после закрытого ревью реализации; push и
GitHub-проба по точному SHA — после явного разрешения; затем landing пина в
onecpi. `FORK.md` переписывается: новая база, таблица гарантий из «Целевой модели
доверия» с принятыми решениями Р1–Р6, команды проверки A1R. Еженедельное задание
возобновляется от нового `main` (Р9).

## Инварианты

- И1. Против сборки, где bound-возможность не объявлена (A1R.1–A1R.3), ни одна
  версия onecpi не запускает bound-лист: readiness → закрытый код отказа.
- И2. Незапрошенный, недостающий или затенённый инструмент в реестре bound-листа
  → терминал с кодом расхождения, 0 запросов провайдеру, 0 выполненных
  инструментов.
- И3. Запрещённый вызов инструмента блокируется и попадает в терминал ровно одной
  записью (имя, причина).
- И4. Верный токен отменяет только свой кортеж; неверный/чужой/повторный — ни
  одного; один терминал `cancelled` после `dispose()`, ни одного обновления после
  отмены.
- И5. Параллельные bound-листы видят только свои привязки и свой `ctx.cwd`;
  `process.env` родителя после любого запуска побайтно равен исходному.
- И6. MCP-профиль: реестр 1С-листа = встроенные + ровно 10 `bsl-*` имён.
- И7. Число upstream-файлов с правками форка ≤ 7 и совпадает с Т1–Т7.
- И8. Не-bound поведение = upstream: `npm run test:all` upstream-набора зелёный
  без правок upstream-тестов.
- И9. На bound-канале ровно один ответчик на процесс; ping несёт
  `serverInstanceId` и `sourceIdentity` точного checkout; capability объявлена
  только при подключённых доказательствах И2–И4 и успешной самопроверке полей Pi.
- И10. Reload: попытки старого поколения прерываются, их терминалы доставляются
  ровно один раз через новый приёмник; трафик на старый `serverInstanceId` без
  ответа.
- И11. Preflight не создаёт файлов, каталогов и сессий.
- И12. После A1R.1 `git merge-base HEAD upstream/main` = `U`.

## Таблица проверок

| Обещание / инвариант | Проверка | Этап |
|---|---|---|
| И1 закрытый отказ без capability | A1R.1: `git grep --cached boundForegroundLeaf` пусто; A1R.3: unit — ответ ping на обоих каналах, onecpi v1 `probeA1Ping` против сборки → `malformed_ping`/`unsupported_capability`; A1R.6: то же для клиента v2 | A1R.1, A1R.3, A1R.6 |
| И2 реестр, 0 запросов | интеграция + канарейки со счётчиком faux-провайдера; спайк С1/С2 | A1R.0, A1R.4, A1R.5 |
| И3 отказы | интеграция: запрещённый вызов → одна запись в терминале | A1R.4 |
| И4 точная отмена | интеграция четырёх листов: чужой/повтор/неверный токен, затем верный; положительный контроль — вызов колбэка обновления после отмены не ретранслируется | A1R.4, A1R.5 |
| И5 привязки/cwd/env | С4; интеграция двух параллельных листов; снимок `process.env` до/после | A1R.0, A1R.4 |
| И6 exact-ten | С3; дифференциальный MCP-тест A1R.2; реальная проба | A1R.0, A1R.2, A1R.5 |
| И7 площадь правок | после коммита этапа: `git diff --name-only --diff-filter=MD $U HEAD` ⊆ Т1–Т7 (контроль 46 на `main`) | A1R.1, A1R.2, A1R.4 |
| И8 upstream-поведение | `npm run test:all` | каждый этап |
| И9 один ответчик, самопроверка | реальная проба; unit: удалённое поле `streamFunction` → capability отсутствует | A1R.4, A1R.5 |
| И10 reload | интеграционный сценарий reload A1.8 на in-process детях | A1R.4, A1R.5 |
| И11 preflight без побочных эффектов | unit: снимок файловой системы до/после preflight | A1R.3 |
| И12 merge-base | после merge-коммита шага 11: `git merge-base HEAD $U` | A1R.1 |
| Модель доверия задокументирована | `FORK.md` содержит таблицу гарантий с решениями Р1–Р6 | A1R.7 |
| onecpi: контракт v2 и откат | тесты onecpi; апгрейд `c32663ec…`→новый и обратно | A1R.6 |

## Риски и откат

- **Внутренние поля Pi** (`loaded` у загрузчика — upstream; `Agent.streamFunction` —
  форк). Их смена ломает изоляцию модулей или барьер. Мера: самопроверка при
  старте, capability не объявляется, onecpi отказывает закрыто; bound-тесты в
  каждой синхронизации.
- **Код пакета в процессе родителя** (Р4): сбой пакета роняет сессию
  пользователя. Мера: только аттестованные пакеты onecpi и закреплённый адаптер.
- **Дрейф upstream в `resolvePiLaunchToolPlan`** меняет digest контракта. Мера:
  golden-digest тесты; изменение digest — осознанный подъём версии контракта.
- **MCP in-process** (С3) — пройдено с окном `reload()→bindExtensions()` на адаптере
  2.26.1 и 2.34.0. Остаток: MCP-сервер стартует лениво и наследует env родителя;
  при смене версии адаптера С3 повторяется (`spikes/A1R.0/c3c4`).
- **Отмена не останавливает работу** (Р6): инструмент, игнорирующий сигнал,
  дорабатывает, его подпроцессы живут. Мера: `spawn({signal})` в аттестованных
  инструментах, жёсткий таймер отмены.
- **Существующий дрейф env у lens-листов** (onecpi 4 имени против 2 в пине)
  закрывается только A1R.6; до этого поведение текущего пина не меняется.
- **Синхронизации до A1R.7** конфликтовали бы со старым `main` (125 участков) —
  задание снято (Р9).
- **Откат**: до A1R.7 `main` форка и пин onecpi не меняются — откат = отказ от
  ветки. После публикации — возврат пина onecpi на `c32663ec…` существующей
  exact→exact транзакцией установщика; `main` форка возвращается revert-коммитом
  merge (без переписывания истории).

## Принятые решения (человек, 2026-09-20)

Основание — итоги A1R.0 (`LANDING-A1R.0-spikes.md`) и разбор вариантов с человеком.

- **Р1. Хост bound-листа — in-process в родителе.** Runner-процесс не выбран: больше
  площадь правок в самых подвижных upstream-файлах (async-механика), задержка старта
  на каждую линзу, доказательства снова пришлось бы передавать между процессами.
  Код внутри листа доверенный (расширения onecpi, закреплённый адаптер,
  встроенные инструменты Pi). Обязательные меры: жёсткий таймер отмены,
  `spawn({signal})` в аттестованных инструментах, документирование Р4/Р6 в `FORK.md`.
- **Р2. Аттестация runtime** — корень пакета, `name`/`version` и digest собственных
  файлов пакета Pi без `node_modules` (1056 файлов, 44–150 мс, раз на процесс).
  Digest всего дерева с зависимостями (14 092 файла, ~1,7 с) не делается.
- **Р3. Принято:** «ноль запросов» — для дрейфа реестра/`context.tools` (доказано
  С1); для дрейфа, видимого только в payload, — не более одного запроса.
- **Р4. Принято:** код пакетов исполняется в процессе родителя без изоляции и без
  сдерживания сбоев; проверка импорта — гигиеническая (С6).
- **Р5. Env листа заменяется привязками сессии** через реестр хоста
  `sessionId→bindings`; три расширения onecpi переходят на `ctx.cwd` и привязки,
  пространство привязок покрывает 6 имён (закрывает дрейф 4 против 2).
- **Р6. Принято:** отмена означает «сессия утилизирована»; работа инструмента,
  игнорирующего сигнал, может продолжиться.
- **Р7. Собственный канал** `subagents:bound:v2:*`; `rpc.ts` и
  `prompt-template-bridge.ts` для протокола не правятся.
- **Р8. Приватность bound-прогонов сохраняется** (точка Т3) до принятия upstream
  опции «приватный прогон».
- **Р9. Еженедельное pio-задание снято** до A1R.7 (`pio sched rm pi-subagents-upstream`,
  2026-09-19); файлы задания сохранены, возврат —
  `pio sched add ~/.pio/sched/pi-subagents-upstream/job.toml`.
- **Р10. PR в upstream:** баги 5–6 — сразу; малые исправления 4 — после A1R.2;
  хуки 1–3 — после A1R.4. Каждый PR — с отдельного разрешения человека.
- **Р11. Не требуется:** С3 пройден с окном upstream на обеих версиях адаптера.
