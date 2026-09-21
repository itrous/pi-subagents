# A1R.4 — исполнение bound-листа и доказательства

## Задача

Этап A1R.4 зонтичного плана `PLAN-A1R-inprocess-upstream-migration.md`
(разделы «A1R.4», «Целевая модель доверия», «Стратегия интеграции»,
«Инварианты», решения Р1–Р11) и чек-лист `LANDING-A1R-plan-review.md`
(пункты 7 и 8). Резюме: подключить порт исполнения bound-листа, который A1R.3
оставил незанятым (его Д9, терминал `unavailable_context`), — декоратором
`ChildSessionFactory` в точке Т2 (`src/runs/foreground/subagent-executor.ts`):
финальная сверка `ChildSessionLaunch` с контрактом, аттестованные фабрики
пакетов inline-хуками с фасадом, привязки сессии, окно `MCP_DIRECT_TOOLS` с
восстановлением, снимок реестра до `prompt()` и барьер на
`session.agent.streamFunction`, коллектор отказов, отмена по С5, приватность
bound-прогонов (Т3 `src/extension/rpc.ts`, Р8). В конце этапа объявляется
`capabilities.boundForegroundLeaf: { version: 2 }` при успешной самопроверке
внутренних полей Pi и подключённых доказательствах.

Обязательный вход: `LANDING-A1R.0-spikes.md` (С1–С6 и «Следствия»),
`PLAN-A1R.3-control-plane-v2.md` (Д1–Д9, И3.1–И3.20),
`LANDING-A1R.2-carries.md` (строки (б)), `LANDING-A1R-plan-review.md`,
`FORK.md`, `PLAN-A1.8-lifecycle-verification.md` (сценарии).

База: upstream `8bd275bba0dc13273eff366e348378d41ad5535e` (v0.69.0), дерево
`/Users/kiriller/src/pi-subagents.feat-a1r-base`, ветка `feat/a1r-base`,
HEAD `653c03b9`. Хост Pi 0.85.1.

## Вне рамок

- Реальная проба с установленным Pi (`pi install git:…@<sha>`, Linux-хост,
  fixture MCP-сервер, GitHub-проба) — **A1R.5**.
- Любые правки в `/Users/kiriller/src/onecpi` (клиент v2, перевод расширений
  на `ctx.cwd`/привязки, пин, `mutationTools` в агентах) — **A1R.6**; здесь
  onecpi только читается.
- push, PR в `main` форка, публикация SHA, переписывание `FORK.md` под релиз — **A1R.7**.
- Фоновый/async-путь, Windows, изоляция кода пакетов (Р4), остановка
  инструмента, игнорирующего сигнал (Р6).
- Правки upstream-файлов сверх Т1–Т7 и любые правки upstream-тестов (И8).
- Правка `completion-guard.ts` и `isPotentialMutationToolCall`: решение (а) в
  `LANDING-A1R.2-carries.md`; `mutationTools` приходит из определения агента,
  байты которого связаны контрактом (`agent.fileContentDigest`,
  `bound-resolver.ts:39`).
- Снятие платформенного гейта source identity (`src/extension/source-identity.ts:277`).

## Допущения, принятые без вопроса

Вызов автономный: вилки закрыты веткой по умолчанию и перечислены в
«Открытых вопросах».

- **Д1. Доступ к `AgentSession` — через шов `loadPiCodingAgent` собственной
  фабрики.** Bound-запуск получает свою фабрику
  `createDefaultChildSessionFactory({ loadPiCodingAgent })`
  (`src/runs/shared/child-session.ts:243`, опция объявлена `:135`), где модуль —
  прокси над настоящим: `{ ...pi, createAgentSession: … }`. Своя копия `open()`
  отвергнута (дублирует 155 строк `:243-397` и молча разъедется при
  синхронизации), правка `child-session.ts` — тоже (восьмой upstream-файл,
  И7).
- **Д2. Окно `MCP_DIRECT_TOOLS` открывает upstream, закрывает форк на всех
  выходах.** Декоратор кладёт значения в `launch.processEnv`, upstream
  применяет их внутри `open()` (`child-session.ts:288`, `applyProcessEnv`
  `:201`) — в начале окна `reload()→bindExtensions()`, признанного достаточным
  в С3. Окно закрывается при первом из событий, восстановление идемпотентно
  (снимок имён плюс флаг): (а) конец обёрнутого `session.bindExtensions`;
  (б) исключение в любой точке, которую `open()` проходит **после** `:288` —
  перечень закрыт чтением `:286-340` и весь идёт через наш прокси:
  `loader.reload` (`:290`), проверка обязательных расширений (`:293`),
  `modelRuntime.register*`/`refresh` (`:294-305`), `SessionManager.*`
  (`:306-312`), `resolveCliModel` (`:313-316`), `createAgentSession` (`:317`),
  `bindExtensions` (`:332`); (в) `finally` вокруг `base.create(...)` —
  страховка. (а) и (б) лежат **внутри** сериализованного окна (`let loading`,
  `:186`, `:342`), поэтому сосед чужого значения не видит; без них ранний
  провал `open()` оставил бы `MCP_DIRECT_TOOLS` выставленным и нарушил И4.6.
- **Д3. Bound-ребёнок живёт в своей фабрике, и его останавливает bound-путь.**
  `RunSyncOptions.childSessionFactory` (`src/shared/types.ts:2411`, применение
  `src/runs/foreground/execution.ts:581`) уводит ребёнка из процессной фабрики,
  поэтому `disposeChildSessions()` (`src/extension/index.ts:1204`, внутри
  обработчика `session_shutdown` с `:1198`) его не трогает. Предел даёт обработчик `session_shutdown` bound-слоя: отмена живых
  попыток → жёсткий таймер → `child.dispose()`. Обёртка
  `bounded-child-shutdown.ts` отвечает за не-bound детей и не меняется.
- **Д4. Т2 — один импорт и четыре фрагмента** (см. «Точки Т2 и Т3»), в том числе
  `runId` bound-прогона = `prospectiveRunId` контракта: иначе корни сессии,
  зафиксированные контрактом (`sessionRoot = join(baseRoot, prospectiveRunId)`,
  `src/bound/bound-resolver.ts:204`), не совпадут с фактическими
  (`sessionRoot = join(baseSessionRoot, runId)`,
  `src/runs/foreground/subagent-executor.ts:7099`).
- **Д5. Приватность после перезапуска достигается отсутствием записи.**
  Обоих писателей сохранённой истории foreground закрывает одно и то же
  условие: `rememberForegroundRun` (`subagent-executor.ts:4194`) и
  `updateRememberedForegroundChild` на пути detached-выхода (`:4098`, запись на
  диск внутри — `:900`). Поэтому в `foreground-history.json` bound-прогона нет
  ни при обычном завершении, ни при отделении; Т3 закрывает живые прогоны. Поле `activeBound` в
  `foreground-history.ts` (как на `main`) не вводится — это был бы восьмой
  upstream-файл.
- **Д6. Тотальный запрет `.mjs`/`.cjs`/`type: module` в дереве пакета не
  вводится.** Замер (команда и вывод — в «Устройстве сейчас») даёт в
  аттестуемом замыкании 1С-листа 2194 `.mjs`, 145 `.cjs`, 5 `.node`, а
  `type: module` объявлен и у `onecpi`, и у `pi-mcp-adapter@2.26.1`, поэтому
  правило строки «Песочница фабрик пакетов» зонтичного плана отвергло бы самого
  потребителя. Гигиена С6 сужается до: вход фабрики — регулярный несимлинк
  `.ts` внутри аттестованного корня; `transform` jiti запрещает транспиляцию
  вне аттестованных корней; байты входа сверяются с `contentDigest`, дерева — с
  `packageTreeDigest`. Глобальный патч `Module._resolveFilename`
  (`main:bound-tool-registry-runtime.ts:212`) не ставится: он задел бы родителя
  и соседние сессии (Р4).
- **Д7. Вызов модели без инструментов запрещён.** Compaction и branch summary
  идут через тот же `streamFunction` с пустым `tools`
  (`agent-session.js:1453,2551`, факт С1/A8), поэтому барьер отказывает и
  помечает причину `compaction_forbidden`.
- **Д8. Множество статусов терминала не расширяется.** Используются только
  статусы, которые клиент A1 уже принимает (15 имён,
  `onecpi/src/lib/review/pi-native-transport.ts:36`); причина уточняется полем
  `toolRegistryError`, которое уже входит в разрешённые ключи терминала
  (`:37`). Соответствие: расхождение реестра → `native_tool_registry_mismatch`;
  несовпадение launch с контрактом → `unavailable_context` +
  `toolRegistryError: "launch_contract_mismatch"`; запрет вызова без
  инструментов → `native_tool_registry_mismatch` +
  `toolRegistryError: "compaction_forbidden"`.
- **Д9. Самопроверка полей Pi — одноразовая проба сессии в памяти** (Ш0, П2)
  при первой публикации поколения; до её успеха capability не объявляется.
  Проверяются `AgentSession.agent`, `Agent.streamFunction`,
  `AgentSession.getActiveToolNames`, `"loaded"` у экземпляра загрузчика.
- **Д10. Пока П1 не показала иного, MCP-запуск требует
  `process.cwd() === contract.canonicalCwd`**, иначе — закрытый отказ до
  создания сессии. Основание: `pi-mcp-adapter@2.26.1` (пин onecpi,
  `onecpi/package.json:25`) грузит ранний конфиг от `process.cwd()`
  (`index.ts:116-121`, умолчание `config.ts:293`), а инициализацию — от
  `ctx.cwd` (`init.ts:103,113`).
- **Д11. Текст ошибки барьера — фиксированная строка форка**, не совпадающая
  ни с одним retry-паттерном pi-ai (`dist/utils/retry.js:20-77`, см.
  «Устройство сейчас»): `pi-subagents bound leaf: tool registry mismatch; the
  model call was refused before dispatch.`
- **Д12. Тесты двухъярусные.** Ярус 1 — поддельный модуль Pi (готовый шаблон
  `fakePi`, `test/unit/child-session-parent-providers.test.ts:49-91`,
  применение `:108`), зелёный на darwin без сети и SDK, identity — швом
  `resolveSourceIdentity`. Ярус 2 — настоящий SDK по `PI_SUBAGENTS_NATIVE_SDK`
  с faux-провайдером через `globalThis.fetch` и декоратором фабрики поверх
  `{ ...pi, createAgentSession }` (`test/unit/acceptance-compaction.test.ts:16-22,71-84`),
  без переменной пропускается. `createMockPi` (`test/support/mock-pi.ts:57,75`)
  не годится: он подменяет фабрику, а не модуль, и до `session.agent` не
  доходит. Реальная проба — A1R.5.
- **Д13. Обновления v2 несут только читаемое клиентом**: тройка плюс
  необязательные `model`, `durationMs`, `tokens`, `currentTool`
  (`onecpi/src/lib/review/pi-native-transport.ts:246-252`).
- **Д14. Политику, которую контракт объявляет выключенной, порт выключает
  явно.** Контракт фиксирует `control: false`, `intercom: false`,
  `watchdog: false`, `usageBudget: false` (`src/bound/bound-resolver.ts:62-65`,
  сборка `:316-319`), но исполнитель берёт эти значения из **конфигурации
  хоста**, а не из контракта: `resolveControlConfig(deps.config.control, effectiveParams.control)`
  (`subagent-executor.ts:7036` — путь одиночного foreground-запуска),
  `resolveIntercomBridge({ config: deps.config.intercomBridge, override:
  params.intercomBridge, … })` (`:1884-1889`).
  Оба принимают override из `params`, и override полностью заменяет
  конфигурацию: `enabled` берётся из override первым
  (`src/runs/shared/subagent-control.ts:45`), а `resolveIntercomBridgeConfig`
  получает именно override, когда он определён
  (`src/intercom/intercom-bridge.ts:178`). Поэтому порт всегда передаёт
  `control: { enabled: false }` и `intercomBridge: { mode: "off" }`; `watchdog`
  ловится сверкой Ш3 по `launch.runtime.childWatchdog`
  (`execution.ts:369,422`). Для `usageBudget` ни того, ни другого нет — Д15.
- **Д15. Глобальный `usageBudget` хоста несовместим с контрактом, запуск
  отклоняется.** Исполнитель берёт бюджет как
  `effectiveParams.usageBudget ?? deps.config.usageBudget`
  (`subagent-executor.ts:6910`), «выключающего» значения нет
  (`validateUsageBudgetConfig`: `undefined` → откат к конфигу, `{}` → ошибка
  «must include tokens or costUsd», `src/runs/shared/usage-budget.ts:14-32`), а
  в `ChildRuntimeConfig` поля нет
  (`git grep -n usageBudget -- src/runs/shared/child-launch.ts` → 0), поэтому
  сверка launch его не видит. Порт **до запуска** проверяет
  `config.usageBudget === undefined` (`config` у слоя есть,
  `src/bound/index.ts:44`) и иначе отвечает закрытым `unavailable_context` +
  `toolRegistryError: "policy_mismatch"`, ноль запросов. Альтернатива — В6.

## Устройство сейчас

Числа и цитаты получены командами в
`/Users/kiriller/src/pi-subagents.feat-a1r-base`, `/Users/kiriller/src/onecpi`
(чтение) и в установленном Pi 0.85.1
(`/opt/homebrew/Cellar/pi-coding-agent/0.85.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent`
= `$PI`).

### Площадь правок и состояние слоя

- `git diff --name-only --diff-filter=MD 8bd275bba0dc13273eff366e348378d41ad5535e HEAD -- src`
  → **5** путей (Т1 `src/extension/index.ts` + Т4–Т7); без `-- src` → 9 (плюс 4
  upstream-теста). Контроль: та же команда `2c2db5b8 main | wc -l` → 46. После
  A1R.4 ожидается **7**: добавляются Т2
  `src/runs/foreground/subagent-executor.ts` и Т3 `src/extension/rpc.ts`.
- `ls src/bound | wc -l` → **16** модулей.
- `git grep -n boundForegroundLeaf -- src` → **1 строка**, и это комментарий
  `src/bound/index.ts:81`; исполняемого объявления нет. Контроль:
  `git grep -n boundForegroundLeaf main -- src` → `src/extension/rpc.ts:407`
  (объявление v1 в A1).
- Порт исполнения объявлен, но не подключён: `BoundExecutionPort`
  (`src/bound/bound-launch-bridge.ts:25-31`); без него принятый запуск даёт один
  терминал `unavailable_context` (`:126-130`).
- `registerBoundControlPlane` уже принимает `executionPort`
  (`src/bound/index.ts:56`, проброс `:128`); Т1 его не передаёт (вызов —
  `src/extension/index.ts:767`, импорт — `:63`).
- Авторизованный запуск отдаёт порту `request`, `contract`, `agent`,
  `packageExtensionPaths` (`bound-runtime-service.ts:37-42`).

### Upstream: где стоит декоратор и что он видит

- `RunSyncOptions.childSessionFactory` (`src/shared/types.ts:2411`) —
  инъекция фабрики на один запуск; применение
  `src/runs/foreground/execution.ts:581`.
- Один вызов `runSync` в исполнителе: `src/runs/foreground/subagent-executor.ts:4026`
  (`grep -n "runSync(" src/runs/foreground/subagent-executor.ts` → ровно одна
  строка, 4026; импорт — `:27`). Вызов лежит в `runSinglePath(data, deps)`
  (`:3797`), где уже распакованы `params`, `ctx`, `runId` (`:3799-3815`).
- Последовательность запуска ребёнка: `childSessions.create(input)` (`:1400`),
  подписка (`:1417`), `onChildSession` (`:1421`), `await created.prompt(...)`
  (`:1423`) — все номера строк этого списка относятся к
  `src/runs/foreground/execution.ts`. Отмена там же: `abortChild` —
  `execution.ts:606-612`, сам вызов `void session.abort().catch(...)` — `:608`;
  в `subagent-executor.ts` вызовов `session.abort()` нет
  (`grep -n "\.abort()" src/runs/foreground/subagent-executor.ts` → только
  `interruptController.abort()`).
- `ChildSession`, возвращаемый upstream-фабрикой, **не отдаёт**
  `session.agent`: объект собран из 11 членов (`child-session.ts:361-382`).
  Отсюда шов Д1.
- Фабрика использует ровно 7 членов модуля Pi
  (`awk 'NR>=243 && NR<=397' src/runs/shared/child-session.ts | grep -o "pi\.[A-Za-z]*" | sort | uniq -c`
  → `DefaultResourceLoader`, `ModelRuntime`, `SessionManager`, `SettingsManager`,
  `createAgentSession`, `initTheme`, `resolveCliModel`). Прогон импорта
  `$PI/dist/index.js` со спредом пространства имён:
  `{"nsKeys":151,"spreadKeys":151,"present":[…7…],"missing":[],"sameFn":true}` —
  все экспорты и идентичность функций сохраняются.
- Foreground-ребёнок не получает `processEnv` от upstream: он задаётся только
  хосту `runner` (`src/runs/shared/child-launch.ts:322`), а сами значения
  строит `childProcessEnv` (`:161-169`, `MCP_DIRECT_TOOLS_ENV` — `:42`).
- `extensionBindings` доставляются только через env runner-а
  (`child-launch.ts:164`); читателя значения в дереве нет:
  `git grep -n PI_SUBAGENT_EXTENSION_BINDINGS -- src` → 4 строки —
  `child-launch.ts:25` (импорт), `:164` (запись в env),
  `extension-bindings.ts:1` (константа), `:76` (вычистка ключа), и ни одна не
  читает значение. Значит для foreground привязки доставляет форк (Р5).
- Ссылки расширений пакета доходят до Pi **сырыми**: относительные
  превращаются в абсолютные (`src/agents/agents.ts:2047-2057,2161`), а
  `package:<имя>` остаётся литералом, и upstream его не разбирает
  (`git grep -n 'package:' -- src` вне `src/bound` даёт только ключи объектов:
  `agents.ts:269,2456,2760,2795,2875`, `prompt-resources.ts:7`). В Pi такого
  разбора тоже нет (`grep -rn "package:" $PI/dist/core/extensions/loader.js` →
  пусто). Путь ссылки: `execution.ts:402` → `child-launch.ts:199` →
  `child-tool-plan.ts:433,441,445` → `launch.extensionPaths`
  (`child-launch.ts:298`, попадание в launch — `:321`). Следствие: декоратор
  обязан снять эти записи и заменить inline-фабриками, иначе загрузчик Pi
  получит несуществующий путь.
- Блокировка вызова хуком: `pi.on("tool_call", …)` → `{ block: true, reason }`;
  upstream так и делает (`subagent-prompt-runtime.ts:345-380` — правила
  разрешений, `:389+` — бюджет).
- История foreground пишется на каждом завершении (`rememberForegroundRun`,
  `subagent-executor.ts:760`, вызов `:4194`, запись на диск `:737`, `:824`);
  отдельный путь detached — `:4098` (персист внутри — `:900`).
- Приватность в A1 опиралась на флаг `activeBound` и
  `privateBoundStatusRequested` (`main:src/extension/rpc.ts:558`, применения
  `:616,:626,:638`); в upstream её нет. Публичные поверхности, видящие
  foreground-прогоны: `buildFleetStatus` (`src/extension/rpc.ts:177`, обход
  `:199`), обработчики `status` (`:718`), `steer` (`:756`), `interrupt`
  (`:759`) и `resume` (`:765`); список методов — `:34`.

### Pi 0.85.1 — внутренние поля и ретраи

- `AgentSession.agent` — публичное поле типа (`$PI/dist/core/agent-session.d.ts:193`),
  присваивается в конструкторе (`agent-session.js:139`), значит проверяемо
  только на экземпляре.
- `Agent.streamFunction` — объявленное поле класса
  (`$PI/node_modules/@earendil-works/pi-agent-core/dist/agent.d.ts:39`);
  upstream сам его оборачивает (`pinChildCacheRetention`,
  `src/shared/child-cache-retention.ts:33`, вызов `child-session.ts:330`).
- `StreamFn = (model, context, options) => …`
  (`pi-ai/dist/types.d.ts:13`), `Context.tools?: Tool[]`
  (`pi-ai/dist/types.d.ts:389-393`) — барьер сверяет имена из `context.tools`
  и идентичность `model`.
- `getActiveToolNames(): string[]` (`agent-session.d.ts:306`) — эталон набора
  (С2); `getAllTools()` (`:310`) эталоном не является.
- `DefaultResourceLoader.loaded` — поле экземпляра
  (`$PI/dist/core/resource-loader.js:154,201,265,400`); upstream проверяет его
  как `"loaded" in loader` (`child-session.ts:195-199`) и при отсутствии
  сообщает через `onExtensionError` (`:289`).
- Классы сессии не замораживаются: `grep -n "Object.freeze(this)\|Object.seal(this)" $PI/dist/core/agent-session.js`
  → пусто, поэтому затенение метода собственным свойством допустимо.
- Retry-паттерны, которых текст ошибки барьера не должен касаться, лежат в
  `$PI/node_modules/@earendil-works/pi-ai/dist/utils/retry.js:20-77`
  (`RETRYABLE_PROVIDER_ERROR_PATTERN`, 35 строк: `overloaded`, `rate.?limit`,
  `429`, `500`…`524`, `server.?error`, `internal.?error`, `network.?error`,
  `connection.?refused`, `fetch failed`, `timed? out`, `terminated`,
  `ended without`, `retry delay`, `ResourceExhausted`, …); применение —
  `agent-session.js:2248-2252`.

### MCP: откуда 1С-лист берёт конфиг (пункт 7 чек-листа)

- Потребитель решает по **проектным** слоям рядом с cwd листа:
  `join(cwd, ".mcp.json")` и `join(cwd, ".pi", "mcp.json")`
  (`onecpi/src/lib/review/onec-tools.ts:287`, функция — `:282`), и это записано
  как «читается там, где прочтёт pi, — от cwd процесса, без подъёма по дереву»
  (`:274`).
  Состав — 10 пар `ONEC_TOOL_PAIRS` (`:38-49`).
- Адаптер в версии пина onecpi (`onecpi/package.json:25` → `2.26.1`):
  ранний конфиг на этапе фабрики — `loadMcpConfig(earlyConfigPath)`
  (`index.ts:116-121`) с умолчанием `cwd = process.cwd()`
  (`config.ts:293`); инициализация сессии — `loadMcpConfig(configPath, cwd)`,
  где `cwd = ctx.cwd` (`init.ts:103,113`); `MCP_DIRECT_TOOLS` читается дважды
  (`index.ts:123`, `init.ts:374`); на этапе фабрики уже регистрируются direct-
  инструменты (`syncDirectTools(earlyConfig, earlyCache)`, `index.ts:927`), а
  обработчик `session_start` при нехватке ожидаемых серверов **дожидается**
  инициализации (`index.ts:407-415`). В 2.34.0 те же места — `:313-316`,
  `:318`, `init.ts:438`.
- Upstream разрешает имена MCP от cwd, переданного в план
  (`resolveMcpDirectToolResolution(input.mcpDirectTools, input.cwd, …)`,
  `child-tool-plan.ts:355`; слои — `mcp-direct-tool-allowlist.ts:243,264-274`).
- Резолвер форка уже сужает случай: план строится от `discoveryCwd` — cwd
  активной сессии хоста (`src/bound/bound-resolver.ts:256`), а MCP при
  `cwd` листа ≠ `discoveryCwd` запрещён вовсе
  (`externalCwd` `:172`, отказ `unsupported_mode` `:217`).
- **Незакрытая щель**: `process.cwd()` родителя не обязан равняться `ctx.cwd`
  сессии; проверка — проба П1 (Ш0).

### Аттестация пакетов: что уже есть и сколько это стоит

- Разрешение ссылок и доказательства (`contentDigest`, `evidenceRoot`,
  `packageTreeDigest`) — `src/bound/bound-package-extensions.ts:130-183`;
  обход дерева — `src/runs/shared/package-tree-evidence.ts:47-101`. Запретов на
  `.mjs`/`.cjs`/`.node` там нет (`grep -n "mjs\|cjs" …/package-tree-evidence.ts`
  → пусто).
- Замер аттестуемого замыкания 1С-листа (owner — репозиторий onecpi,
  вход — `node_modules/pi-mcp-adapter/index.ts`). Команда (выполнять из
  `/Users/kiriller/src/onecpi`, только чтение):

  ```sh
  node --experimental-strip-types --input-type=module -e '
  import { packageTreeEvidence as E } from "/Users/kiriller/src/pi-subagents.feat-a1r-base/src/runs/shared/package-tree-evidence.ts";
  import * as fs from "node:fs"; import * as path from "node:path";
  const o = "/Users/kiriller/src/onecpi", t = Date.now();
  const ev = E(path.join(o, "node_modules/pi-mcp-adapter/index.ts"), o, o);
  const ms = Date.now() - t, c = { mjs: 0, cjs: 0, node: 0, files: 0 };
  for (const r of ev.roots) { const q = [r]; while (q.length) { const d = q.pop();
    for (const n of fs.readdirSync(d)) { if (n === "node_modules") continue; const a = path.join(d, n);
      if (fs.lstatSync(a).isDirectory()) { q.push(a); continue; }
      c.files++; const e = path.extname(n); if (e in c) c[e.slice(1)]++; } } }
  console.log(JSON.stringify({ roots: ev.roots.length, ...c, ms }));'
  ```

  Вывод (два прогона): `{"roots":211,"mjs":2194,"cjs":145,"node":5,"files":20190,"ms":3750}`
  и `…"ms":4270`. Манифесты: `onecpi` — `"type": "module"`;
  `pi-mcp-adapter@2.26.1` — `"type": "module"`, вход `./index.ts`. Это и есть
  основание Д6. Положительный контроль правила Д6: файл `.node` или `.mjs`,
  добавленный **как вход фабрики**, обязан быть отвергнут, а те же расширения
  внутри дерева — нет.
- Механика A1, воспроизводимая в форке: экземпляр jiti с проверкой в
  `transform`, сверка байтов входа, фасад API
  (`main:…/bound-tool-registry-runtime.ts:273-317`, фасад `:161-196`);
  `createJiti` — из `jiti/static` (`package.json:99` → `jiti 2.7.0`).

## Модули A1R.4 и граница с upstream

Новые файлы — только в `src/bound/`; манифест слоя
(`src/bound/bound-layer-manifest.ts`) расширяется на все девять.

| Модуль | Ответственность |
|---|---|
| `bound-execution-port.ts` | `BoundExecutionPort`: сборка `SubagentParamsLike` из контракта (с выключателями Д14), вызов `executeDelegated`, проекции обновления (Д13) и терминала (Д8), жёсткий таймер отмены, снятие ресурсов прогона |
| `bound-run-registry.ts` | Состояние одного прогона в процессе: `runId → { contract, bindings, collectors, childRef, private }`; карта `sessionId → bindings`, где ключ — id **дочерней** сессии (С4); учёт живых bound-детей для остановки (Д3) |
| `bound-child-factory.ts` | Декоратор `ChildSessionFactory`: своя фабрика на `loadPiCodingAgent` (Д1), правка `launch` (пакеты, хуки, `processEnv`), захват `AgentSession`, обёртка `bindExtensions` (восстановление env, снимок реестра, барьер) |
| `bound-launch-recheck.ts` | Финальная сверка `ChildSessionLaunch` ↔ контракт до создания сессии |
| `bound-stream-barrier.ts` | Обёртка `agent.streamFunction`: сверка имён `context.tools` и модели, отказ без вызова исходного потока (С1), фиксированный текст (Д11) |
| `bound-run-hooks.ts` | Inline-хук ребёнка: доставка привязок по id сессии, коллектор отказов на `tool_call`, запрет незаявленных имён |
| `bound-package-loader.ts` | Экземпляр jiti с `transform` по аттестованным корням, сверка байтов входа, вызов фабрик с фасадом (С6, Д6) |
| `bound-package-api.ts` | Фасад `ExtensionAPI` для фабрик пакетов: запрет чужих имён, запрет мутаций реестра после барьера, ограниченный `ctx` |
| `bound-self-check.ts` | Самопроверка внутренних полей Pi (Д9) и готовности коллекторов; вход для решения об объявлении capability |

Замыкание импортов считается от входа слоя: тест
`test/unit/bound-layer-manifest.test.ts` обходит импорты **только** от
`src/bound/index.ts` и сверяет `audit.owned` с `BOUND_LAYER_MODULES`, а
`audit.upstream` — с `EXPECTED_UPSTREAM_DEPENDENCIES` (`:36-51`, сверка
`:118-120`). Отсюда два требования: (1) все девять модулей достижимы из
`src/bound/index.ts` (порт → фабрика → сверка, барьер, хуки, загрузчик;
`index.ts` → порт и самопроверка), иначе `audit.owned` не сойдётся; (2) в
`EXPECTED_UPSTREAM_DEPENDENCIES` добавляются новые upstream-зависимости —
минимум `jiti/static` (`git grep -n "jiti/static" -- src` → пусто) и
`runs/foreground/subagent-executor.ts` (тип `SubagentParamsLike`, `:309`). Тест
принадлежит форку, а не upstream (`git cat-file -e <база>:test/unit/bound-layer-manifest.test.ts`
→ файла нет), поэтому его правка не нарушает И8. Золотой слепок контракта
A1R.3 не двигается: он считается от фикстурного манифеста (`PLAN-A1R.3-*`, Ш4).

Модули A1 в новой форме: `denied-tool-proof` — коллектор внутри
`bound-run-hooks.ts`; `test/fixtures/active-runtime-parent-probe.ts` — фикстура
яруса 2. Изменяются `src/bound/index.ts` (сборка порта, capability,
самопроверка, остановка bound-детей) и `bound-layer-manifest.ts` (перечень);
`bound-tool-registry-projection.ts` используется как есть.

## Точки Т2 и Т3

### Т2 — `src/runs/foreground/subagent-executor.ts`

Один импорт и четыре фрагмента; других правок в файле нет.

1. Импорт: `import { boundForegroundRunId, boundForegroundChildSessionFactory, isBoundForegroundLaunch } from "../../bound/bound-child-factory.ts";`
2. `:7029` — `const runId = boundForegroundRunId(effectiveParams) ?? randomUUID();`
   (Д4: контракт уже назвал корни сессии по `prospectiveRunId`).
3. В объекте опций `runSync` (`:4026-4131`) добавляется одно поле:
   `childSessionFactory: boundForegroundChildSessionFactory(params, { runId, sessionId: data.parentSessionId ?? ctx.sessionManager.getSessionId() ?? undefined })`.
   `compactOptional` уберёт поле, когда функция вернула `undefined`, то есть
   для не-bound запусков вызов `runSync` остаётся байт-в-байт прежним.
4. `:4194` — вызов `rememberForegroundRun(...)` и `:4098` — вызов
   `updateRememberedForegroundChild(...)` оборачиваются одним и тем же условием
   `if (!isBoundForegroundLaunch(params)) …` (Д5). Оба — писатели одной и той
   же истории: второй персистит её на `:900`. Это четвёртый фрагмент; он
   считается вместе с третьим как одна правка в одном файле.

Возможность передаётся на `params` под Symbol-ключом bound-слоя: символьные
ключи не попадают в `JSON.stringify`, поэтому ни события, ни файлы сессии их не
несут. Значение — ключ записи в `bound-run-registry.ts`, не сам контракт.

### Т3 — `src/extension/rpc.ts`

Один импорт (`isPrivateBoundRun` из `../bound/bound-run-registry.ts`) и
исключение приватных прогонов в **пяти** местах: `buildFleetStatus` пропускает
контролы приватных прогонов (обход `:199-200`), а `status` (`:718`), `steer`
(`:756`), `interrupt` (`:759`) и `resume` (`:765`) отвечают так же, как на
неизвестный идентификатор. Форма ответа не меняется: «не найден», а не
«запрещено», иначе сам факт bound-прогона становится наблюдаемым.

Правило выбора цели без `id` (важно для И4.14): фильтруется **выбор**, а не
ответ. `getForegroundControl(state, undefined)` берёт
`state.lastForegroundControlId`, иначе самый свежий по `updatedAt`
(`subagent-executor.ts:571-581`); Т3 пропускает приватные контролы и отдаёт
самый свежий **публичный**, «не найден» — лишь когда публичных нет. Иначе
живой не-bound прогон переставал бы прерываться после старта bound-листа.

Перечень закрыт и пересчитан: `SUBAGENT_RPC_METHODS` — 8 имён (`rpc.ts:34`).
Живой foreground-прогон не могут увидеть или тронуть `ping` (статический
ответ, `:709`), `manage` (только расписания — 7 действий, `:65-73`), `spawn`
(создаёт новый прогон) и `stop` (только async, `:763` → `stopAsyncRun`);
остальные четыре плюс Fleet и есть пять точек. `interrupt` закрывать
обязательно: без id он берёт самый свежий foreground-контрол
(`getForegroundControl(deps.state, undefined)`, `subagent-executor.ts:6827`),
прерывает его и печатает `runId` в ответе (`:6834`) — раскрывает и
останавливает bound-попытку в обход токена.

Мера площади после этапа (И7):
`git diff --name-only --diff-filter=MD 8bd275bba0dc13273eff366e348378d41ad5535e HEAD -- src`
→ ровно **7**: Т1 `src/extension/index.ts`, Т2 `src/runs/foreground/subagent-executor.ts`,
Т3 `src/extension/rpc.ts`, Т4–Т7 (`agent-memory.ts`, `long-running-guard.ts`,
`permissions.ts`, `jsonl-writer.ts`). Без `-- src` — 11 (те же 4
upstream-теста, новых правок upstream-тестов нет). Контроль: та же команда
против `main` → 27 src-файлов.

## Порядок одного bound-запуска

Шкала времени одной попытки; номера — точки, на которых стоят проверки.

1. **Приём** (A1R.3): `:launch` → `admit()` → резерв идентичности →
   `:started`; порт получает `BoundAuthorizedLaunch`.
2. **Подготовка** (порт): запись в `bound-run-registry` под ключ
   `prospectiveRunId`; коллекторы реестра и отказов создаются **до** запуска —
   их отсутствие означает отсутствие capability (И4.11), а не тихий пропуск.
3. **Вызов исполнителя**: `executeDelegated(requestId, params, signal,
   onUpdate, ctx)` с Symbol-возможностью на `params`. `params` — только из
   контракта: `agent`, `task`, `cwd`, `model`, `context: "fresh"`,
   `foregroundOnly: true`, `async: false`, `clarify: false`, `share: false`,
   `skill`, `timeoutMs`, `toolBudget`, `outputSchema`/`outputMode`,
   `artifacts`, `extensionBindings`, `delegatedThinkingOverride` плюс
   выключатели политики (Д14): `control: { enabled: false }`,
   `intercomBridge: { mode: "off" }`; `config.usageBudget` проверен по Д15.
4. **Т2** отдаёт декоратор фабрики; upstream строит `ChildSessionLaunch`
   (`buildInProcessChildLaunch`, `child-launch.ts:185`).
5. **`create(launch)` декоратора, до базовой фабрики**:
   - финальная сверка `launch` ↔ контракт (`bound-launch-recheck.ts`), включая
     следы выключенной политики в `launch.runtime`: нет `intercomSessionName`
     (`child-launch.ts:252`), `orchestratorTarget` (`:253`),
     `supervisorChannelDir` (`:255`), `childWatchdog`/`watchdogStatus`
     (`:270-271`); `orchestratorSessionId`/`parentSessionId` (`:254`)
     допустимы — их ставит любой запуск с известным родителем. Дайджест
     системного промпта равен контрактному: инъекция интеркома
     (`applyIntercomBridgeToAgent`, `subagent-executor.ts:1891`) его меняет;
   - гейт Д10 при непустом `contract.mcpDirectTools`;
   - из `launch.extensionPaths` снимаются записи, отвечающие
     `contract.packageExtensions[].ref` (сырые `package:…` и абсолютные
     относительные); их аттестованные пути уходят в загрузчик пакетов;
   - в `launch.hooks` добавляются inline-хук прогона и хук загрузки
     аттестованных фабрик. Привязки хук держит в замыкании и на своём
     `session_start` публикует в реестре под ключом
     `ctx.sessionManager.getSessionId()` — id **дочерней** сессии, который и
     читает расширение-потребитель (С4); на завершении запись снимается.
     `sessionId` из Т2 — родительский, он нужен только приватности (Т3);
   - `launch.processEnv = { MCP_DIRECT_TOOLS: <селекторы или "__none__"> }` (Д2);
   - `launch.onExtensionError` оборачивается: ошибка `<loader>`/`load` (сброс
     кэша расширений недоступен) закрывает прогон отказом.
6. **Внутри `open()` базовой фабрики** (сериализовано `loading`):
   `applyProcessEnv` → `reload()` → фабрики пакетов и адаптер читают env и
   конфиг → `createAgentSession` (наш прокси запоминает `session` и ставит
   затенение `bindExtensions`) → `pinChildCacheRetention` → `bindExtensions`.
7. **В обёрнутом `bindExtensions`, после оригинала и до возврата**:
   восстановление env (Д2); снимок `session.getActiveToolNames()` (С2) и его
   сверка с `contract.toolRegistry.projection.required`; проверка
   `typeof session.agent?.streamFunction === "function"` и установка барьера.
   При расхождении барьер ставится в режим «отказывать всегда»: сессия создана,
   но ни один запрос провайдеру не уйдёт.
8. **`prompt()`** вызывает upstream (`execution.ts:1423`). Каждый вызов модели
   проходит барьер: сверяются имена `context.tools`, идентичность модели
   (`provider/id`) и `api`; пустой/отсутствующий `tools` — отказ (Д7).
9. **Во время прогона**: `tool_call`-хук блокирует и записывает незаявленные
   имена; обновления уходят через `onUpdate` порта (Д13).
10. **Завершение**: терминал = результат `executeDelegated` плюс
    `toolRegistry`, `toolsMissing`, `toolsExtra`, `toolRegistryError`,
    `deniedToolCalls`, `deniedToolCallsOverflow`, `launchContractDigest`;
    координатор A1R.3 даёт ровно один терминал; запись прогона снимается
    (включая `sessionId → bindings`).

## Доказательства

**Реестр (И2).** Эталон — `contract.toolRegistry.projection.required`
(`expectedToolRegistryProjection(toolPlan.effectiveToolAllowlist,
toolPlan.internalTools)`, `src/bound/bound-resolver.ts:284`). Два независимых
замера: снимок `getActiveToolNames()` после `bindExtensions` (шаг 7) и имена
`context.tools` на каждом вызове модели (шаг 8). Лишнее, недостающее и
затенённое имя дают один исход: исходный поток не вызван, запросов провайдеру
ноль, исполненных инструментов ноль, терминал `native_tool_registry_mismatch`
с `toolsMissing`/`toolsExtra` и проекцией живого набора
(`toolRegistryProjection`, `bound-tool-registry-projection.ts:87`). Затенение
ловит фасад: фабрика пакета не может занять имя встроенного инструмента,
зарезервированное форком (`CORE_RUNTIME_OWNED_TOOLS`,
`src/runs/shared/core-runtime-tools.ts:2`, внутренний список `:13`) или чужое.

**Отказы (И3).** `bound-run-hooks.ts` регистрирует `tool_call` первым среди
хуков прогона: имя вне `projection.required` → `{ block: true, reason }` и одна
запись `{ name, reason }`. Записи с потолком (список плюс флаг), в терминале —
`deniedToolCalls`, `deniedToolCallsOverflow`, ошибка коллектора —
`deniedToolCallsError`. «Ровно одна запись» И3 = одна запись на один
`tool_call`, без дублей.

**Вызовы без инструментов (Д7).** Отсутствующий или пустой `context.tools` —
нарушение: исходный поток не вызывается, клиент видит
`native_tool_registry_mismatch` + `toolRegistryError: "compaction_forbidden"`.
Так compaction и branch summary становятся невозможными (поправка A1R.0 п.3):
иначе форк их не предотвратит — решение об их запуске принимает Pi.

## Отмена и завершение

Соответствие С5 и Р6:

- Отмена (`:cancel` верным токеном, `session_shutdown`, reload) даёт
  `AbortSignal` порту; порт **не ждёт** ни `prompt()`, ни `abort()`.
- Порт запускает жёсткий таймер (константа слоя, подменяемая швом), по его
  истечении — `child.dispose()` по ссылке из `bound-run-registry`, затем
  терминал `cancelled`. Сам `dispose()` upstream ограничивает своим
  `shutdownTimeoutMs` (умолчание 5 000 мс, `child-session.ts:245`, гонка
  `:353`; С5 замерил 5 001 мс при зависшем `session_shutdown`), поэтому
  bound-фабрика получает **своё** значение опции (`:137`). Обещанный предел —
  сумма `hardTimerMs + boundShutdownTimeoutMs`, она и проверяется.
- Позднее завершение `executeDelegated` второго терминала не даёт: запись
  попытки уже утилизирована координатором (`bound-attempt-coordinator.ts`,
  И3.9).
- Обновления после отмены не ретранслируются: `onUpdate` порта проверяет
  `attempt.isRunning()` (`bound-launch-bridge.ts:121-124`) и статус прогона в
  реестре.
- Изоляция соседей (И4): у каждого прогона своя фабрика, сессия, коллектор и
  запись реестра; отмена одного не трогает других — контроль: соседи
  завершаются со своими доказательствами.
- Остановка процесса: обработчик `session_shutdown` слоя
  (`src/bound/index.ts:194-198`) отменяет живые попытки; предел для bound-детей
  — тот же таймер (Д3), для остальных — обёртка `bounded-child-shutdown.ts`.

## Аттестация и inline-загрузка фабрик пакетов

1. Аттестации приходят из `resolveBoundPackageExtensions`
   (`src/bound/bound-package-extensions.ts:130`): путь входа, `contentDigest`,
   `evidenceRoot`, `evidenceRootDigest`, `packageTreeDigest`.
2. Перед загрузкой вход перепроверяется: регулярный файл, не симлинк,
   `realpath` равен пути, расширение `.ts`, sha256 равен `contentDigest`;
   дерево — `packageTreeEvidence` равен `packageTreeDigest`. Расхождение —
   отказ до создания сессии (`unavailable_context` +
   `toolRegistryError: "package_bytes_drift"`), ноль запросов провайдеру.
3. Загрузка — отдельный экземпляр jiti (`createJiti` из `jiti/static`,
   `moduleCache: false`, `tryNative: false`) с `transform`, бросающим для файла
   вне аттестованных корней и для пути внутрь `node_modules` — как в A1
   (`main:…/bound-tool-registry-runtime.ts:292-299`). Это гигиена, не граница
   (С6): `createRequire`, `module.constructor._load`, `fs` + `new Function` не
   сдерживаются; записано в `FORK.md` (Р4).
4. Фабрика вызывается с фасадом `bound-package-api.ts`: запрет занятых имён,
   no-op для интерфейсных методов, запрет мутаций набора инструментов после
   барьера, ограниченная проекция `ctx`.
5. Глобальные патчи модульного резолвера не ставятся (Д6).

## MCP, окно env и cwd

Значение окна: `contract.mcpDirectTools` непусто → селекторы через запятую,
иначе `"__none__"` (форма upstream, `child-launch.ts:165-168`). Открытие и
закрытие — Д2; после закрытия `process.env` побайтно равен состоянию до
запуска, включая провал (И5). Гейт Д10 — до создания сессии, его судьбу решает
П1. И6 (реестр 1С-листа = встроенные плюс ровно 10 `bsl-*`) проверяется
сценарием 6 Ш10 по полному равенству снимка, а не по «в списке есть десять»;
контроль — девять имён обязаны провалить равенство.

## Capability и самопроверка

`boundForegroundLeaf: { version: 2 }` добавляется в `capabilities` ping
(`buildBoundPing`, `src/bound/index.ts:80-92`) **только** при одновременном:
(1) `identity.available`; (2) успешной самопроверке полей Pi (Д9, П2);
(3) подключённом порте; (4) подключённых коллекторах реестра и отказов. Любое
условие ложно → ключа нет, клиент отказывает закрыто
(`unsupported_capability`, `onecpi/src/lib/review/a1-readiness.ts:226-229`).
Отрицательные канарейки (пункт 8 чек-листа) и положительный контроль — Ш9.

## Шаги

Каждый шаг завершается зелёным `npm run typecheck` и своим тестом; полные
наборы — в Ш10.

**Ш0. Пробы до реализации** — изолированно (throwaway `HOME`,
`PI_CODING_AGENT_DIR`, faux-провайдер со счётчиком, без сети), артефакты в
`spikes/A1R.4/`.

- **П1. MCP и cwd.** Родитель с `process.cwd()` = X; сессия и bound-лист с
  cwd = Y (в Y есть `.pi/mcp.json` с двумя fixture-серверами, в X — нет); окно
  `MCP_DIRECT_TOOLS` как в Д2. Замер: набор direct-инструментов ребёнка.
  Положительный контроль: тот же прогон с `process.cwd()` = Y обязан дать
  полный набор. Исход A (полон при X ≠ Y) → гейт Д10 снимается; B (неполон) →
  гейт остаётся и идёт в `FORK.md`; C (полон лишь при явной передаче
  конфигурации) → вилка В1 человеку. Обязательно на 2.26.1 (пин onecpi),
  желательно на 2.34.0.
- **П2. Самопроверка сессии.** Сессия в памяти (`SessionManager.inMemory`, без
  `bindExtensions` и `prompt`), проверка `session.agent`,
  `agent.streamFunction`, `getActiveToolNames`, `"loaded" in loader`, затем
  `dispose()`. Замеры: обращений к провайдеру 0, снимок ФС throwaway-корня
  до/после равен, длительность. Положительный контроль: поддельный модуль без
  `streamFunction` даёт отрицательный вердикт. Провал по времени или побочным
  эффектам → ветка В2.

**Ш1. Реестр прогона и порт исполнения.** `bound-run-registry.ts`,
`bound-execution-port.ts`; Т1 получает поле `executionPort`; проекции
обновления (Д13) и терминала (Д8).
Тест `test/unit/bound-execution-port.test.ts`: параметры строятся только из
контракта (перебор полей) и несут выключатели Д14 (`control.enabled === false`,
`intercomBridge.mode === "off"`); при заданном `config.usageBudget` запуск
отклоняется закрыто (Д15), при пустом — идёт; обновление несёт ровно
разрешённые ключи; успех → `completed` с доказательствами, исключение →
`failed`; порт после остановки поколения молчит. Положительный контроль: та же
попытка без порта даёт `unavailable_context` (И3.19 цел).

**Ш2. Декоратор фабрики и окно env.** `bound-child-factory.ts` (Д1, Д2).
Тест `test/unit/bound-child-factory.test.ts` на поддельном модуле Pi:
`create()` отдаёт объект базовой фабрики без подмен;
`launch.processEnv` несёт ожидаемое значение; после возврата `create()`
снимок `process.env` побайтно равен исходному. Отдельный набор — внедрение
сбоя по одному в каждую точку окна Д2 (`reload`, обязательное расширение,
регистрация/`refresh` провайдеров, `SessionManager`, `resolveCliModel`,
`createAgentSession`, `bindExtensions`); в каждом случае `create()`
отклоняется, а снимок `process.env` побайтно равен исходному. Положительные контроли: реализация,
восстанавливающая env только после `create()`, проваливает случай, где сразу
за упавшим bound-запуском стартует не-bound ребёнок и читает
`MCP_DIRECT_TOOLS`; реализация без восстановления вовсе проваливает каждый случай; отсутствие захвата сессии делает барьер неустановимым, и тест это
видит.

**Ш3. Финальная сверка launch ↔ контракт.** `bound-launch-recheck.ts`.
Сверяются `cwd`, `storage`, `model`, `tools`, `excludeTools`,
`ambientExtensions === false`, `noSkills`, `noContextFiles`,
`runtime.mcpDirectTools`, `runtime.requiredTools`, `runtime.capabilityCeiling`,
дайджест системного промпта, следы выключенной политики (шаг 5 «Порядка»),
состав `extensionPaths` после снятия аттестованных ссылок и соответствие сырых
ссылок записям `contract.packageExtensions[].ref`.
Тест `test/unit/bound-launch-recheck.test.ts`: каждое поле по одному меняется
и даёт отказ; немодифицированный launch проходит. Отдельный случай — хост с
`intercomBridge: { mode: "always" }` и `control: { enabled: true }`:
bound-запуск сверку проходит (выключатели Д14 сработали, маркер в промпт не
попал), а тот же запуск без выключателей проваливает её по дайджесту промпта и
`launch.runtime`. Положительный контроль: не-bound запуск при том же хосте мост
интеркома получает.

**Ш4. Барьер и снимок реестра.** `bound-stream-barrier.ts`.
Тест `test/unit/bound-stream-barrier.test.ts`: при совпадении набора исходный
поток вызван ровно один раз; лишнее, недостающее и переименованное имя, пустой
и отсутствующий `tools` (причина `compaction_forbidden`), другая модель и
другой `api` — не вызван; барьер переживает второй вызов и смену модели; текст
ошибки не совпадает ни с одним retry-паттерном pi-ai, и паттерны тест
**читает** из `dist/utils/retry.js` установленного SDK (гейт
`PI_SUBAGENTS_NATIVE_SDK`, иначе пропуск), а не из рукописной копии: её
неполнота сделала бы проверку непроваливаемой. Положительные контроли: строка
`"overloaded"` обязана совпасть с прочитанными паттернами; без обёртки тот же
сценарий вызывает исходный поток.

**Ш5. Привязки и коллектор отказов.** `bound-run-hooks.ts`.
Тест `test/unit/bound-run-hooks.test.ts`: хук публикует привязки под id
**своей** (дочерней) сессии из `ctx` своего `session_start`, а не под
родительским; две параллельные сессии читают каждая свои; чтение по
родительскому id пусто (контроль на ключ); запись снимается на завершении;
запрещённое имя блокируется одной записью, переполнение поднимает флаг,
разрешённое имя проходит без записи.

**Ш6. Аттестованная загрузка фабрик пакетов.** `bound-package-loader.ts`,
`bound-package-api.ts`.
Тест `test/unit/bound-package-loader.test.ts` на фикстурном пакете: загрузка
проходит и фабрика получает фасад; отказ при изменении байта входа, байта в
дереве, при входе `.mjs` и входе-симлинке; импорт за аттестованные корни —
исключение из `transform`; регистрация занятого имени и регистрация
инструмента после барьера — отказ. Положительные контроли: те же `.mjs`/`.cjs`
**внутри** дерева (не как вход) загрузку не ломают (Д6); импорт внутри корня
проходит.

**Ш7. Отмена, дедлайн, соседи.** Дополнение порта и реестра.
Тест `test/unit/bound-cancel-deadline.test.ts`: исполнитель, чей
`executeDelegated` не завершается, — отмена даёт `cancelled` в пределах
`hardTimerMs + boundShutdownTimeoutMs`, `dispose()` вызван до возврата;
отдельный случай — ребёнок с зависшим `session_shutdown`: измеренное время
укладывается в ту же сумму (значит опция передана фабрике); позднее завершение
исполнителя второго терминала не даёт; сосед не получает ни `dispose()`, ни
отмены. Положительные контроли: реализация, ждущая `executeDelegated`, не
укладывается; фабрика с умолчанием 5 000 мс на том же зависшем
`session_shutdown` — тоже.

**Ш8. Т2 и Т3.** Внести фрагменты (раздел «Точки»).
Тест `test/unit/bound-hook-points.test.ts`: на не-bound параметрах
`boundForegroundChildSessionFactory` и `boundForegroundRunId` дают `undefined`,
`isBoundForegroundLaunch` — `false` (И4.14); на bound-параметрах `runId` равен
`prospectiveRunId`.
Тест `test/unit/bound-rpc-privacy.test.ts`: bound-прогон не виден в
`buildFleetStatus`, а `status`, `steer`, `interrupt` (в том числе **без** `id`,
который иначе берёт самый свежий контрол) и `resume` отвечают как на
неизвестный идентификатор; ни один ответ не содержит его `runId`, и попытка не
прерывается (по отсутствию отмены у координатора); после завершения запись
реестра снята. Положительный контроль: не-bound прогон при тех же запросах
виден, прерывается и назван в ответе.
Тест `test/unit/bound-history-privacy.test.ts`: после bound-прогона история
foreground не содержит его `runId` — отдельно для обычного завершения (`:4194`)
и для detached-выхода (`:4098`); после не-bound прогона содержит в обоих.

**Ш9. Capability, самопроверка, канарейки.** `bound-self-check.ts`, правка
`src/bound/index.ts`. Тест `test/unit/bound-capability.test.ts`: полная
конфигурация → ping несёт `boundForegroundLeaf: { version: 2 }`; снятие по
одному порта, коллектора реестра, коллектора отказов, полей `streamFunction`,
`agent`, `loaded` и доступности identity — каждый случай убирает ключ.
Положительный контроль: снятие постороннего условия ключ не убирает.

**Ш10. Интеграция A1.8 и приёмка.**
`test/integration/bound-foreground-lifecycle.test.ts` (ярус 1, поддельный
модуль Pi; сценарии из `PLAN-A1.8-lifecycle-verification.md:78-144`,
переложенные на in-process детей):

1. **Четыре листа и Fleet**: preflight четырёх троек, четыре `:started`,
   четыре сессии; реестр bound-прогонов содержит четыре живых листа; публичный
   `status` без других прогонов даёт `totalActive === 0` и не раскрывает ни
   агента, ни идентификаторов; отпускание в обратном порядке даёт по одному
   терминалу с коррелированными доказательствами. Положительный контроль:
   не-bound прогон в той же сессии в публичном `status` виден.
2. **Точная отмена и изоляция соседей**: чужой, повторный, подделанный и
   «трёхпольный» cancel не трогают ничего; верный токен отменяет свой кортеж,
   после терминала обновления не ретранслируются (контроль — принудительный
   вызов колбэка); три соседа завершаются со своими доказательствами.
3. **Headless**: `hasUI: false` на всём пути, методы UI не вызываются,
   успешный и отменённый структурированные листы, после расчёта живых сессий
   нет.
4. **Reload**: попытки старого поколения прерываются, их терминалы приходят
   ровно один раз через новый приёмник; трафик на старый `serverInstanceId` без
   ответа; новый сосед старым `stopOwner` не прерывается.
5. **Негативные канарейки со счётчиком провайдера**: лишний, недостающий и
   затенённый инструмент, дрейф байтов пакета, смена модели — каждая даёт ноль
   обращений и свой закрытый терминал. Положительный контроль: правильный
   прогон на том же счётчике даёт ≥ 1 обращение.

6. **MCP-профиль (И4.7)**: лист с 10 селекторами onecpi и фикстурной фабрикой
   пакета, регистрирующей имена строго по `process.env.MCP_DIRECT_TOOLS`
   (стенд-ин адаптера; настоящий MCP-сервер — A1R.5). Снимок
   `getActiveToolNames()` обязан **полностью** равняться встроенным плюс десяти
   `bsl-*`, прогон завершается штатно. Положительный контроль: та же фикстура с
   девятью селекторами обязана провалить равенство и дать
   `native_tool_registry_mismatch` с нулём запросов.

`test/integration/bound-foreground-real-sdk.test.ts` (ярус 2, гейт
`PI_SUBAGENTS_NATIVE_SDK`): совпадение набора → ровно один запрос
faux-провайдеру и завершение; расхождение → ноль запросов, ни одного события
ретрая, терминал `native_tool_registry_mismatch`; compaction по порогу не
проходит барьер; `process.env` после прогонов равен исходному.

Приёмка этапа:

- `npm run typecheck`; `LC_ALL=C npm run test:unit`;
  `LC_ALL=C npm run test:integration` (`LC_ALL=C` обязателен, `FORK.md`);
- **ярус 2 обязателен**: тот же прогон с
  `PI_SUBAGENTS_NATIVE_SDK=<корень изолированного 0.85.1>`; без переменной его
  `it` пропускаются (`skip`, как `acceptance-compaction.test.ts:19`), а в
  `package.json:63` её нет — без неё приёмка ничего не доказывает о настоящих
  полях Pi; результат прогона идёт в landing этапа;
- `git diff --name-only --diff-filter=MD 8bd275bba0dc13273eff366e348378d41ad5535e HEAD -- src`
  → ровно 7 путей (Т1–Т7); без `-- src` → 11; контроль на `main` → 27 src;
- добавления считаются отдельно (`--diff-filter=MD` их не видит): та же команда
  с `--diff-filter=A -- src` (сейчас 22) — каждый новый путь либо в
  `src/bound/`, либо в явном перечне этапа;
- та же команда `-- test` — ровно те же 4 upstream-теста (И8);
- `node --experimental-strip-types --test test/unit/bound-layer-manifest.test.ts`
  — замыкание импортов от `src/bound/index.ts` совпадает с манифестом с учётом
  девяти новых модулей, а `audit.upstream` — с дополненным
  `EXPECTED_UPSTREAM_DEPENDENCIES` (см. «Модули A1R.4»);
- `git grep -n "boundForegroundLeaf" -- src` — вхождения только в
  `src/bound/index.ts` и `src/bound/bound-self-check.ts` (объявление и
  условие), ни одного в upstream-файлах;
- `git grep -n "subagents:rpc:v1\|prompt-template:subagent" -- src/bound` →
  пусто (Р7);
- `FORK.md`: статус «исполнение подключено, capability v2 объявляется», новые
  команды проверки, записи Р4/Р6 и итог П1.

## Инварианты этапа

- **И4.1** (= И2). Расхождение живого реестра с контрактом (лишнее,
  недостающее, затенённое имя) → ноль запросов провайдеру, ноль исполненных
  инструментов, ровно один терминал `native_tool_registry_mismatch` с
  `toolsMissing`/`toolsExtra`.
- **И4.2.** Каждый вызов модели проходит барьер: имена `context.tools`,
  `provider/id` модели и её `api` обязаны совпасть с контрактом; вызов без
  инструментов отклоняется (`compaction_forbidden`). Барьер переживает смену
  модели и повторный `prompt()`.
- **И4.3** (= И3). Запрещённый вызов инструмента блокируется и попадает в
  терминал ровно одной записью на вызов; переполнение обозначено флагом, а не
  молчаливой потерей.
- **И4.4.** Несовпадение `ChildSessionLaunch` с контрактом → сессия не
  создаётся, терминал `unavailable_context` с
  `toolRegistryError: "launch_contract_mismatch"`, ноль запросов провайдеру.
- **И4.5** (= И4). Верный токен отменяет только свой кортеж; сессия
  утилизируется, а терминал `cancelled` приходит не позже
  `hardTimerMs + boundShutdownTimeoutMs` (обе величины — константы слоя),
  ровно один; после него ни одного обновления; соседние листы завершаются
  независимо.
- **И4.6** (= И5). Параллельные листы видят только свои привязки (по id своей
  дочерней сессии) и свой `ctx.cwd`; `process.env` родителя после любого
  запуска — успешного, отменённого или провалившегося в любой точке
  окна Д2 — побайтно равен исходному, и ни один соседний запуск не наблюдает
  чужое значение.
- **И4.7** (= И6). Реестр 1С-листа равен встроенным плюс ровно 10 `bsl-*`
  именам; при непустом `mcpDirectTools` и `process.cwd() !== canonicalCwd`
  запуск отклоняется закрыто (до пересмотра по П1).
- **И4.8.** Загружаются только аттестованные входы; байты входа и дерева
  сверяются в момент загрузки; дрейф → закрытый отказ до первого запроса
  провайдеру; фасад не даёт пакету занять чужое имя или изменить набор
  инструментов после барьера.
- **И4.9** (= И7). upstream-файлов с правками форка в `src` ровно 7 и они
  совпадают с Т1–Т7; сопутствующих upstream-тестов — прежние 4.
- **И4.10** (= И8). Наборы upstream-тестов зелёные без правок upstream-тестов.
- **И4.11** (= И9). `boundForegroundLeaf: { version: 2 }` объявляется только
  при доступной identity, успешной самопроверке, подключённом порте и обоих
  коллекторах; иначе ключа нет.
- **И4.12** (= И10). Reload прерывает попытки старого поколения, их терминалы
  доставляются ровно один раз через новый приёмник — с настоящим исполнением.
- **И4.13.** Bound-прогон не виден и не управляем через публичные
  `status`, `steer`, `interrupt` (в том числе без `id`) и `resume`, не виден в
  Fleet-проекции и не попадает в сохранённую историю foreground-прогонов ни
  одним из двух её писателей.
- **И4.14.** Не-bound делегации не меняются: `childSessionFactory` не
  подставляется, `runId` остаётся случайным, история пишется как прежде.
- **И4.15.** На попытку приходится ровно один терминал даже при завершении
  `executeDelegated` после дедлайна отмены.
- **И4.16.** Политика, объявленная контрактом выключенной (`control`,
  `intercom`, `watchdog`, `usageBudget`), не действует ни при какой
  конфигурации хоста: порт передаёт выключатели, сверка отвергает launch с их
  следами, а несовместимый `config.usageBudget` даёт закрытый отказ до запуска
  (Д15); detach bound-прогона поэтому недостижим.

## Таблица проверок

| Обещание / инвариант | Проверка | Положительный контроль |
|---|---|---|
| И4.1 реестр, 0 запросов | `bound-foreground-lifecycle.test.ts` (канарейки лишний/недостающий/затенённый) + ярус 2 | правильный набор на том же счётчике даёт ≥ 1 запрос |
| И4.2 барьер на каждом вызове | `bound-stream-barrier.test.ts` + ярус 2 (compaction по порогу) | совпадение набора — исходный поток вызван ровно один раз; без обёртки вызван всегда |
| И4.3 отказы | `bound-run-hooks.test.ts` + сценарий 5 интеграции | разрешённое имя проходит без записи |
| И4.4 сверка launch ↔ контракт | `bound-launch-recheck.test.ts` | немодифицированный launch проходит |
| И4.5 точная отмена и соседи | `bound-cancel-deadline.test.ts` (в т.ч. зависший `session_shutdown`) + сценарий 2 интеграции | реализация, ждущая `executeDelegated`, и фабрика с умолчанием `shutdownTimeoutMs` не укладываются в сумму |
| И4.6 привязки/cwd/env | `bound-run-hooks.test.ts` (ключ — id дочерней сессии), `bound-child-factory.test.ts` (снимки env плюс внедрённые сбои во всех точках окна), два параллельных листа интеграции | чтение привязок по родительскому id пусто; восстановление env только после `create()` проваливает случай «упавший bound-запуск → не-bound ребёнок» |
| И4.7 exact-ten и гейт cwd | проба П1 (Ш0, гейт cwd) + сценарий 6 Ш10 (равенство снимка десяти `bsl-*` плюс встроенным) | фикстура с девятью селекторами обязана провалить равенство и дать 0 запросов |
| И4.8 аттестация пакетов | `bound-package-loader.test.ts` + канарейка дрейфа байтов в интеграции | `.mjs`/`.cjs` внутри дерева (не вход) загрузку не ломают |
| И4.9 площадь правок | `git diff --name-only --diff-filter=MD <база> HEAD -- src` → 7 | та же команда на `main` → 27 |
| И4.10 upstream зелёный | `LC_ALL=C npm run test:unit`, `… test:integration` | инвертированное утверждение в новом тесте делает набор красным |
| И4.11 capability и самопроверка | `bound-capability.test.ts` (семь снятий по одному) | снятие постороннего условия ключ не убирает |
| И4.12 reload | сценарий 4 интеграции | терминал старой попытки приходит один раз и через новый приёмник |
| И4.13 приватность | `bound-rpc-privacy.test.ts` (четыре метода, включая `interrupt` без `id`), `bound-history-privacy.test.ts` (оба писателя), сценарий 1 интеграции | не-bound прогон виден в `status`, прерывается `interrupt` и попадает в историю |
| И4.14 не-bound путь не изменён | `bound-hook-points.test.ts` + полные upstream-наборы | bound-параметры дают `runId === prospectiveRunId` |
| И4.15 один терминал при позднем завершении | `bound-cancel-deadline.test.ts` | без координатора тот же сценарий дал бы второй терминал |
| И4.16 политика контракта при враждебной конфигурации хоста | `bound-execution-port.test.ts` (выключатели в params; `config.usageBudget` → закрытый отказ по Д15) + `bound-launch-recheck.test.ts` (следы в `launch.runtime` и дайджест промпта) | тот же хост-конфиг для не-bound запуска включает мост интеркома, control и бюджет |
| Самопроверка не создаёт побочных эффектов | проба П2 (Ш0): счётчик провайдера 0, снимок ФС равен | поддельный модуль без `streamFunction` даёт отрицательный вердикт |
| Текст ошибки барьера не ретраится | `bound-stream-barrier.test.ts` (копия списка pi-ai) | строка `"overloaded"` обязана совпасть со списком |

## Риски и откат

- **Шов `loadPiCodingAgent` исчезнет или изменит форму** (Д1). Мера: опция —
  часть публичного типа `DefaultChildSessionFactoryOptions`
  (`child-session.ts:129-138`), её используют шесть upstream-тестов
  (`grep -rl "loadPiCodingAgent" test | wc -l` → 6); при пропаже самопроверка
  Ш9 снимает capability, клиент отказывает закрыто.
- **Затенение `bindExtensions` перестанет работать** (заморозка сессии в
  будущем Pi). Мера: самопроверка и per-run проверка, что обёртка вызвана;
  иначе прогон закрывается отказом.
- **Дрейф внутренних полей Pi** (`agent`, `streamFunction`, `loaded`). Мера:
  Д9/И4.11, ярус 2, bound-тесты в каждой синхронизации.
- **Адаптер MCP и `process.cwd()`** (Д10). Мера: П1, гейт до создания сессии,
  запись в `FORK.md`; при смене версии адаптера П1 повторяется.
- **Стоимость аттестации дерева пакета**: 20 190 файлов и 3,7–4,3 с на
  замыкание onecpi — свойство уже существующего пути A1R.3, но на исполнении
  оно повторяется. Мера: кэш `BoundPackageEvidenceCache` в пределах одного
  приёма; при неприемлемой цене — вилка В3.
- **Компактификация у длинного листа**: запрет Д7 превращает переполнение
  контекста в закрытый отказ. Мера: терминал несёт `compaction_forbidden`;
  выбор бюджета — на стороне потребителя (A1R.6).
- **Т2 в самом подвижном upstream-файле**: `subagent-executor.ts` — 7559 строк
  и один из двух главных источников конфликтов (28 участков в пробном merge,
  зонтичный план). Мера: четыре фрагмента и один импорт, каждый — строка или
  условие; при конфликте синхронизации правка переносится механически.
- **Откат**: этап живёт отдельными коммитами в `feat/a1r-base`, `main` форка и
  пин onecpi не двигаются до A1R.7. Откат = снятие коммитов; Т2 и Т3 снимаются
  тривиально, слой возвращается в состояние A1R.3 (`unavailable_context`,
  capability не объявлена).

## Открытые вопросы (вилки, закрытые веткой по умолчанию)

- **В1. Конфигурация MCP при `process.cwd() !== ctx.cwd`.** По умолчанию
  (Д10) — закрытый отказ. Альтернатива — передавать адаптеру конфигурацию явно
  (`createMcpAdapter({ config, configPath })`,
  `pi-mcp-adapter@2.26.1 types.ts:565-568`): форк грузил бы адаптер своей
  inline-фабрикой с `configPath` от cwd листа. Это меняет доказательство:
  конфигурация адаптера становится входом контракта. Решение — после П1.
  **Закрыто человеком 2026-09-21:** Д10 остаётся, В1 переносится в A1R.6
  (замер явного пути на Linux — `LANDING-A1R.5-installed-probe.md`).
- **В2. Где живёт самопроверка полей Pi.** По умолчанию (Д9) — проба сессии в
  памяти при публикации поколения. Альтернатива — статические проверки модуля
  плюс per-run отказ: дешевле, но capability объявляется при неполном знании, а
  расхождение видно лишь на первом запуске.
- **В3. Глубина аттестации пакета на исполнении.** По умолчанию — полная
  сверка `packageTreeDigest` перед загрузкой (20 190 файлов, ~4 с).
  Альтернатива — доверять сверке, сделанной при приёме, и перепроверять только
  байты входов; дешевле, но окно между приёмом и загрузкой перестаёт
  закрываться.
- **В4. Судьба compaction.** По умолчанию (Д7) — запрет барьером.
  Альтернатива — сузить барьер до вызовов с непустым `tools`: compaction
  вернётся, но откроется путь, где модель вызывается без проверенного набора.
- **В5. Статусы терминала.** По умолчанию (Д8) — множество A1 плюс уточнение в
  `toolRegistryError`. Альтернатива — отдельные статусы v2
  (`launch_contract_mismatch`, `compaction_forbidden`, `package_bytes_drift`) с
  согласованием клиента в A1R.6.
- **В6. Глобальный `usageBudget` хоста.** По умолчанию (Д15) — закрытый отказ
  запуска. Альтернативы: ослабить контракт до дайджеста бюджета вместо
  `usageBudget: false` (правка контракта v2 и клиента в A1R.6) или добавить
  upstream-параметр «игнорировать глобальный бюджет» (кандидат-PR, Р10).
