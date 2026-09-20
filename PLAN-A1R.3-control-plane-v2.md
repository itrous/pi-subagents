# A1R.3 — control plane v2 форка: канал `subagents:bound:v2:*`

## Задача

Этап A1R.3 зонтичного плана `PLAN-A1R-inprocess-upstream-migration.md`
(разделы «A1R.3», «Целевая модель доверия», «Стратегия интеграции»,
«Инварианты», решения Р1–Р11). Резюме: поднять в форке управляющий канал
`subagents:bound:v2:*` — ping (`serverInstanceId`, `sourceIdentity` точного
git-checkout; capability bound-листа **не** объявляется до конца A1R.4),
`preflight` без побочных эффектов с контрактом запуска v2, приём запроса с
receipt/HMAC и финальной перепроверкой, targeted cancel, координатор попыток и
реестры идентичности, reload/drain и ограниченная по времени остановка на
`session_shutdown`. Резолвер v2 строится поверх upstream
`resolvePiLaunchToolPlan` (`src/runs/shared/child-tool-plan.ts:297`). Аттестация
runtime — по Р2. `environment` заменяется привязками сессии (`bindings`,
пространство `onecpi-review/1`). `toolRegistry.runtimeExtensions` — перечень
модулей bound-слоя вместо 18 имён A1. Единственная точка правки upstream-файла —
Т1 (`src/extension/index.ts`).

Обязательный вход: `LANDING-A1R-plan-review.md` (пункты 6, 10, 11 — этому
этапу), `LANDING-A1R.0-spikes.md`, `LANDING-A1R.2-carries.md` (строки (б)),
`FORK.md`.

База: upstream `8bd275bba0dc13273eff366e348378d41ad5535e` (v0.69.0), дерево
`feat/a1r-base`, HEAD `40d5ef59`.

## Вне рамок

- Исполнение bound-листа и доказательства реестра/отказов: декоратор
  `ChildSessionFactory` (Т2), барьер `streamFunction`, привязки в сессии,
  окно `MCP_DIRECT_TOOLS`, коллектор отказов, приватность (Т3) — **A1R.4**.
- Объявление capability `boundForegroundLeaf: { version: 2 }` и самопроверка
  внутренних полей Pi — **конец A1R.4**.
- Реальная проба с установленным Pi — **A1R.5**.
- Любые правки в `/Users/kiriller/src/onecpi` (клиент v2, расширения,
  пин) — **A1R.6**. В этом этапе onecpi только читается.
- push, PR в `main` форка, публикация SHA — **A1R.7**.
- Фоновый/async-путь, Windows, изоляция кода пакетов (Р4), остановка работы
  инструмента, игнорирующего сигнал (Р6).
- Правки upstream-файлов сверх Т1; правки upstream-тестов.

## Допущения, принятые без вопроса

Вызов автономный: инструмента вопросов у планировщика в этом запуске нет
(AskUserQuestion недоступен), поэтому каждая вилка закрыта веткой по умолчанию и
вынесена в «Открытые вопросы» для человека.

- **Д1. Receipt и cancellationToken остаются в формате payload `version: 1`**
  (`src/api/launch-receipt.ts:4`), несмотря на контракт v2. Подделка между
  поколениями невозможна: секрет 32 байта создаётся на каждый экземпляр
  bound-слоя, `serverInstanceId` и `launchContractDigest` входят в payload.
  Изменение версии payload потребовало бы правки кроме модуля ещё и его
  сохранившегося теста без выигрыша в свойствах.
- **Д2. Пространство привязок `onecpi-review/1` — закрытый список из 6 имён**,
  зашитый в форке: `ONECPI_REVIEW_ROOT`, `ONECPI_REVIEW_SUBJECT_PATH`,
  `ONECPI_REVIEW_WORKSPACE_ROOT`, `ONECPI_REVIEW_WORKSPACE_SUBJECTS`,
  `ONECPI_REVIEW_WORKSPACE_POLICY_DIGEST`, `ONECPI_REVIEW_WORKSPACE_LOG`.
  Конфигурируемый реестр пространств не вводится.
- **Д3. Предел на `session_shutdown` ставится обёрткой процессной фабрики
  дочерних сессий и покрывает ВСЕХ детей**, как требует поправка зонтичного
  плана. Upstream-файлы не правятся: используются экспорты
  `childSessionFactory()` (`src/runs/shared/child-session.ts:403`) и
  `setChildSessionFactory()` (`:426`); подмену процессной фабрики через этот
  экспорт делает upstream-тест `test/integration/nested-async-wait.test.ts:34`
  (восстановление — `:55`). Механизм — в разделе «Reload, drain и остановка».
- **Д4. Перед каждым разрешением контракта сбрасываются оба кэша обнаружения** —
  `clearAgentDiscoveryCache()` (`src/agents/agents.ts:2732`) и
  `clearSkillCache()` (`src/agents/skills.ts:751`): без второго `resolveSkills`
  отдаёт запись `skillCache` при совпадении `mtimeMs` (`skills.ts:593-594`), и
  digest навыка отстанет от байтов. Оба сброса — только память, не диск.
- **Д5. Ping v2 объявляет `capabilities.activeRuntimeIdentity: { version: 2 }`
  только при доступной source identity** (как A1: `source.available` —
  `main:src/extension/rpc.ts:406`); `boundForegroundLeaf` не объявляется до конца
  A1R.4 ни при каких условиях.
- **Д6. `src/api/active-bound-environment.ts` удаляется**, его разбор/проекция
  переносятся в `src/bound/bound-bindings.ts` (env-сборка на spawn мертва при
  in-process, Р5). Пункт 11 чек-листа закрывается тестом
  `test/unit/bound-bindings.test.ts`, покрывающим те же свойства парсера.
- **Д7. Строгий клон JSON — копия в форке**, а не правка upstream
  `src/slash/delegation-json.ts` (решение (б) из `LANDING-A1R.2-carries.md`).
- **Д8. Запрос v2 отвергает поле `turnBudget`** как неизвестное. В onecpi
  значение `turnBudget` нигде не формируется (см. «Устройство сейчас»).
- **Д9. Порт исполнения в A1R.3 не подключён**: принятый запрос завершается
  терминалом `unavailable_context`; в тестах порт подменяется заглушкой.
  Исполнение подключает A1R.4.

## Устройство сейчас

Все числа и цитаты получены командами в
`/Users/kiriller/src/pi-subagents.feat-a1r-base` и `/Users/kiriller/src/onecpi`.

### Площадь правок upstream

`git diff --name-only --diff-filter=MD 8bd275bba0dc13273eff366e348378d41ad5535e HEAD`
→ 8 путей: `agent-memory.ts`, `long-running-guard.ts`, `permissions.ts`,
`jsonl-writer.ts` (Т4–Т7) и 4 upstream-теста
`test/unit/{agent-memory,completion-guard,jsonl-writer,permissions}.test.ts`;
с `-- src` → 4. Контроль:
`git diff --name-only --diff-filter=MD 2c2db5b8 main | wc -l` → 46. Замечание:
`LANDING-A1R.2-carries.md` называет «3 файла upstream-тестов» — фактически 4,
`completion-guard.test.ts` тоже изменён.

### Что осталось от A1 в дереве

`git diff --name-only --diff-filter=A <база> HEAD -- src` → 7 модулей
(`canonical-json`, `source-identity`, `core-runtime-tools`,
`package-tree-evidence`, `launch-receipt`, `active-bound-environment`,
`bound-identity-registry`), та же команда `-- test` → 3 теста
(`bound-identity-registry`, `launch-receipt`, `source-identity`).
Отложено в A1R.1 и подлежит возврату в новой форме (6 модулей + fixture):
`tool-registry-proof`, `denied-tool-proof`, `active-bound-preflight`,
`active-bound-package-extensions`, `bound-pending-cancellation-registry`,
`structured-attempt-coordinator`, `test/fixtures/active-runtime-parent-probe.ts`.
Из них этот этап возвращает в новой форме 5 (`tool-registry-proof` — только
контрактную половину, `active-bound-preflight`, `active-bound-package-extensions`,
`bound-pending-cancellation-registry`, `structured-attempt-coordinator`);
`denied-tool-proof` и `test/fixtures/active-runtime-parent-probe.ts` возвращаются
в A1R.4 вместе с исполнением.
Проверено `git cat-file -e`: все 8 файлов A1-тестов и фикстур
(`active-bound-preflight`, `structured-attempt-coordinator`, `delegation-json`,
`active-bound-environment`, `tool-registry-proof`, `denied-tool-proof`,
`bound-pending-cancellation-registry`, `active-runtime-parent-probe`) в
upstream-базе отсутствуют, а на `main` есть, — их возврат добавляет файлы и
площадь И7 не трогает.
`src/bound/` сейчас нет (`ls src/bound` → No such file or directory).

### Upstream-точки, на которые опирается bound-слой

- Регистрация мостов: `src/extension/index.ts:741` (slash), `:748`
  (prompt-template), `:759` (rpc). Остановка сессии:
  `pi.on("session_shutdown", …)` — `src/extension/index.ts:1191`, внутри
  `await disposeChildSessions()` — `:1194`.
- Реестр рантаймов расширения и reload-очистка: `:108` (`RUNTIME_REGISTRY_STORE_KEY`),
  `installRuntime` — `:1106`, вызов из `session_start` — `:1163`, очистка
  предыдущего рантайма — `:1128`.
- Локальные имена, доступные в точке Т1: `config` (`:433`), `waitToolConfig` (`:434`),
  `expandTilde` (`:304`), `resolveCurrentSubagentCapabilityCeiling` (импорт `:72`),
  `state.lastUiContext` (используется, напр. `:743`).
- `resolvePiLaunchToolPlan` — `src/runs/shared/child-tool-plan.ts:297`, вход
  `ResolvePiLaunchToolPlanInput` — `:131` (`tools`, `excludeTools`, `extensions`,
  `mcpDirectTools`, `cwd`, `structuredOutput`, `model`, `capabilityCeiling`,
  `agentName`, `permissionRules`, `runtimeSnapshotHost`), выход `PiLaunchToolPlan`
  — `:157` (`effectiveToolAllowlist`, `requiredChildTools`, `internalTools`,
  `effectiveMcpTools`, `runtimeExtensions`, `disableAmbientExtensions`, …).
  MCP-разрешение — `:353-355` (`resolveMcpDirectToolResolution(input.mcpDirectTools,
  input.cwd, input.runtimeSnapshotHost)`), отказ по runtime-снимку — `:357`.
- Дети: `createDefaultChildSessionFactory` — `src/runs/shared/child-session.ts:243`;
  `child.dispose()` убирает ребёнка из `live` и кладёт завершение в `shutdowns`
  (`:368-375`), само завершение ограничено `shutdownTimeoutMs` 5 000 мс (`:245`,
  гонка на `:353`); `factory.dispose()` ждёт `Promise.allSettled(children.map(child
  => child.abort()))` **без предела** (`:386-393`, само ожидание — `:389`) — это и есть поправка A1R.0 п.5.
  `disposeChildSessions()` — `:444`.
- Публичный ping upstream не несёт `serverInstanceId`/`sourceIdentity`
  (`src/extension/rpc.ts:439-468`), `SUBAGENT_RPC_METHODS` без `preflight`
  (`:34`), каналы `subagents:rpc:v1:{request,ready,reply:}` (`:30-32`).
- Типы делегаций upstream (`src/api/delegation.ts`) не содержат ни `binding`, ни
  `turnBudget`, ни native-статусов доказательств: `SubagentDelegationRequest`
  (`:26`), `SubagentDelegationStatus` (`:64`).
- Агенты пакета upstream открывает сам: `AgentSource` включает `"package"`
  (`src/agents/agents.ts:32`), у `AgentConfig` есть `filePath`,
  `packageSourceName/Version/Root`, `extensions`, `tools` (`:133`+),
  `discoverAgents` (`:2958`), `resolveAgentName` (`:710`),
  `clearAgentDiscoveryCache` (`:2732`). Форковых `discoverProjectAgentsRestricted`,
  `loadAgentsFromDir(strictRegularFiles)`, `buildBoundSkillInjection`,
  `resolveProjectSkillsUncached` в upstream нет (проверено
  `git grep -ln "export .*<имя>" -- src` → пусто), значит строгое чтение
  определений живёт в модуле форка.
- **Source identity доступна только на Linux**: `resolveActiveRuntimeSourceIdentity`
  первым делом возвращает `unavailable("unverified_source")`, если
  `process.platform !== "linux"` или нет `/proc/self/fd`
  (`src/extension/source-identity.ts:277`); те же платформенные гейты — в пробах
  (`:115`, `:129`). Следствия: на darwin/Windows ping несёт
  `sourceIdentityUnavailable`, а preflight отвечает `unverified_source`;
  bound-возможность работает только на Linux-хосте. Поэтому bound-модуль
  принимает шов `resolveSourceIdentity` (как A1: `dependencies.resolveSourceIdentity
  ?? resolveActiveRuntimeSourceIdentity`), а все unit-тесты этапа подают
  разрешение через этот шов и не зависят от платформы.
- Проекция определения агента: `AGENT_DEFINITION_PROJECTION_VERSION = 2`
  (`src/shared/launch-contract.ts:7`) — в v1-контракте A1 было 1; это
  наблюдаемое изменение для onecpi (A1R.6).
- `test/support/fake-child-session.ts` существует: `createFakeChildSessions`
  (`:212`), `FakeChildSessionRecord` (`:55`). Его `abort()` разрешается сразу
  (`:492-496`), поэтому сценарий «abort не завершается» требует собственной
  заглушки ребёнка, а не этой фикстуры.

### Pi 0.85.1 (прогоны, не память)

- **Порядок обработчиков.** `ExtensionRunner.emit` вызывает обработчики одного
  расширения последовательно и ждёт каждый (`dist/core/extensions/runner.js:623-653`);
  `api.on` складывает их в массив в порядке регистрации
  (`dist/core/extensions/loader.js:232-237`). Прогон (скрипт из двух обработчиков
  `session_shutdown`): `{"order":"slow-first","log":["slow:start","slow:end","fast:start","fast:end"],"elapsedMs":132}`;
  положительный контроль обратным порядком регистрации:
  `{"order":"fast-first","log":["fast:start","fast:end","slow:start","slow:end"],"elapsedMs":134}`.
  Следствие: обработчик, зарегистрированный в точке Т1 (строка ~765), гарантированно
  отрабатывает до upstream-обработчика на `:1191`.
- **Встроенные инструменты.** Прогон: импорт подпути
  `@earendil-works/pi-coding-agent/dist/core/tools/index.js` →
  `ERR_MODULE_NOT_FOUND`, `createRequire(...).resolve(<пакет>)` →
  `ERR_PACKAGE_PATH_NOT_EXPORTED` (манифесты объявляют только условие `import`),
  а импорт того же файла по абсолютному пути →
  `["read","bash","powershell","edit","write","grep","find","ls"]` (8 имён).
  Контроль: `import.meta.resolve(<пакет>)` из дерева форка разрешается в тестовый
  shim (`test/fixtures/pi-coding-agent-shim/index.mjs`), а не в установленный Pi,
  поэтому корень аттестации берётся от фактически загруженного модуля и должен
  быть подменяемым в тестах.
- **Стоимость аттестации Р2.** Обход собственных файлов пакета Pi без
  `node_modules` с sha256: `{"files":1056,"ms":154}`. (Ловушка счёта: `find … -not
  -path "*/node_modules/*"` даёт 0, потому что сам пакет установлен внутри
  `.../lib/node_modules/...`; число получено обходом из node.)
- Манифесты: установленный Pi — `@earendil-works/pi-coding-agent` `0.85.1`,
  `type: module`; shim форка (`devDependencies` →
  `file:./test/fixtures/pi-coding-agent-shim`) — `version`
  `0.0.0-pi-subagents-test-shim`.

### Строгий клон JSON (пункт 10 чек-листа)

Upstream `cloneJsonWithinByteLimit` (`src/slash/delegation-json.ts:9`) не
отвергает Proxy. Прогон: вход — Proxy над `{version:1}` с ловушками →
`{"cloned":{"ok":true,"value":{"version":1},"encodedBytes":13},"traps":["ownKeys","gopd:version"]}`;
положительный контроль на обычном объекте → `{"ok":true,...}`. Недоверенные
receipt/token проверяются именно этим вызовом:
`src/api/launch-receipt.ts:92` и `:122` (в чек-листе указано `:125` — номер
устарел на 3 строки). Важно: строгий разбор дескрипторов у upstream **уже есть** — массив обязан иметь
`Array.prototype`, целочисленный `length`, только индексные ключи и
enumerable-data-дескрипторы (`src/slash/delegation-json.ts:48-64`), то же для
объектов (`:72-78`). Единственное поведенческое расхождение форк-версии A1 —
отказ Proxy; остальное в её диффе — опции
`ignoreNonEnumerable/omitUndefinedProperties/omitNonJsonProperties`, которые
меняют поведение лишь когда их передают, и они нужны путям A1R.4, а не этому
этапу (`git diff 2c2db5b8 main -- src/slash/delegation-json.ts` → 15 добавленных,
7 удалённых строк; файл на `main` — 116 строк, в дереве — 108).

### Потребитель (onecpi, пин `c32663ec…`, читается только)

- Канал и вызов ping: `A1_RPC_REQUEST = "subagents:rpc:v1:request"`,
  `A1_RPC_REPLY(requestId)` (`src/lib/review/a1-readiness.ts:10-11`).
- Ping обязан нести ровно ключи `serverInstanceId, sourceIdentity, version,
  methods, capabilities, events, session` — иначе `malformed_ping`
  (`a1-readiness.ts:215-217`); далее `version === 1` и `methods` c `preflight` —
  иначе `unsupported_ping` (`:218-220`); `sourceIdentity` =
  `{version:1, kind:"git", repository, commit, digest}` — иначе
  `unverified_source` (`:221-225`); `capabilities.boundForegroundLeaf.version === 1`
  — иначе `unsupported_capability` (`:226-229`); ноль/несколько ответов →
  `no_active_responder`/`multiple_active_responders` (`:213`).
- Ответ preflight: ключи ровно
  `version, serverInstanceId, sourceIdentityDigest, activeSessionDigest,
  canonicalCwd, requestDigest, launchContract, launchContractDigest, receipt,
  cancellationToken` (`:307-310`), доменная ошибка читается как
  `preflight_<code>` (`:305-306`).
- Ключи контракта v1 — 28 имён (`:312`), необязательны `timeoutMs`,
  `turnBudget`, `toolBudget` (`:313-314`); дальше идут поимённые проверки
  идентичностей, модели, агента (вплоть до байтов файла), `mcpDirectTools`,
  `toolRegistry` c проекцией и 18 именами `A1_RUNTIME_EXTENSION_NAMES`
  (`:14-18`), digest реестра, `tools`/`policy`/`roots`/`environment`,
  `packageExtensions` и обоих подписанных токенов — сплошным блоком
  `:315-368` (`signedToken` — `:179`).
- Делегация (форму v2 повторяет на своём канале): `prompt-template:subagent:*`
  (`pi-native-transport.ts:8-12`), `binding` в запросе (`:226-233`), cancel с
  `targetServerInstanceId` (`:264`), ключи терминала (`:37`), статусы (`:36`).
- `turnBudget` в onecpi не формируется: `grep -rn turnBudget src bin` → 6 строк
  — необязательный проброс (`a1-readiness.ts:273`, `pi-native-transport.ts:234`),
  тип (`transport.ts:27`) и три упоминания в списках ключей контракта.
- Пространство привязок: прогон импорта `REVIEW_WORKSPACE_ENV_NAMES`
  (`src/extensions/review-workspace/policy.ts:7-13`) даёт 4 имени
  `ONECPI_REVIEW_WORKSPACE_{ROOT,SUBJECTS,POLICY_DIGEST,LOG}`, плюс 2 имени
  адъюдикатора (`pi-native-transport.ts:103-105`) — итого 6 (Д2).

## Модули `src/bound/` и граница с upstream

| Модуль | Ответственность | Берётся у upstream / форка |
|---|---|---|
| `index.ts` | `registerBoundControlPlane(options)`: сборка сервисов, свои `pi.on("session_start"/"session_shutdown")`, публикация поколения, `stop()` | `pi.events`, `ExtensionContext` |
| `channel.ts` | Константы канала v2, разбор конверта запроса, эмиссия ответов/событий | — |
| `bound-json.ts` | Строгий клон: копия upstream `delegation-json.ts` плюс одно расхождение — отказ `utilTypes.isProxy(object)`; опции A1 не переносятся (нужны только путям A1R.4) | форк-копия upstream `delegation-json.ts` |
| `bound-request.ts` | Разбор запроса preflight v2 и его digest | `canonical-json.ts`, `bound-json.ts` |
| `bound-bindings.ts` | Пространство `onecpi-review/1`: разбор, проекция, digest | перенос `active-bound-environment.ts` |
| `bound-agent-discovery.ts` | Поиск package-агента, строгое перечитывание байтов определения и skills | `discoverAgents`, `resolveAgentName`, `normalizeSkillInput`, `resolveSkills`, `agentDefinitionDigest` |
| `bound-package-extensions.ts` | Проекция и digest ссылок расширений пакета | `package-tree-evidence.ts` (форк), `AgentConfig.packageSource*` |
| `pi-runtime-attestation.ts` | Р2: корень загруженного пакета Pi, `name`/`version`, digest собственных файлов, `allToolNames`; кэш на процесс | абсолютный импорт `dist/core/tools/index.js` |
| `bound-tool-registry-projection.ts` | Контрактная половина `tool-registry-proof`: `toolRegistryProjection`, `expectedToolRegistryProjection`, `runtimeBuiltinProjection`, `SUPPORTED_BOUND_MODEL_APIS`, валидаторы имён | перенос из A1 без кадров и payload-разбора |
| `bound-layer-manifest.ts` | Перечень модулей bound-слоя и их digest → `toolRegistry.runtimeExtensions` v2 | — |
| `bound-resolver.ts` | Контракт запуска v2 поверх `resolvePiLaunchToolPlan`: резерв имён, `discoveryCwd`, корни, политика, digest | upstream `resolvePiLaunchToolPlan`, `resolvePermissionRules`, `checkModelScope`, `getSupportedThinkingLevels`, `validateToolBudgetConfig`, `resolveChildMaxSubagentDepth`, `resolveCurrentSessionId` + форк `CORE_RUNTIME_OWNED_TOOLS` |
| `bound-runtime-service.ts` | `preflight()`, `admit()`, `verify{Pending,Active}Cancellation()`, `recheckInputs()`, `dispose()`; владение receipt-сервисом | `launch-receipt.ts` (форк) |
| `bound-attempt-coordinator.ts` | Координатор попыток (перенос `structured-attempt-coordinator`, ключ `…V2`) | — |
| `bound-pending-cancellation-registry.ts` | Отмены, пришедшие до приёма (перенос, ключ `…V3`) | — |
| `bound-launch-bridge.ts` | Приём `:launch`, targeted `:cancel`, `:started`/`:update`/`:terminal`, drain, порт исполнения | `bound-identity-registry.ts` (форк, остаётся на своём пути) |
| `bounded-child-shutdown.ts` | Прозрачная обёртка процессной `ChildSessionFactory`: учёт живых детей и `dispose()` с дедлайном для всех детей | `childSessionFactory()` (`child-session.ts:403`), `setChildSessionFactory()` (`:426`) |

Модули вне `src/bound/`, которые этап трогает: `src/api/launch-receipt.ts` —
только замена импорта строгого клона на `../bound/bound-json.ts`;
`src/api/active-bound-environment.ts` — удаляется (Д6). Остальные 5 сохранённых
модулей A1 используются без правок.

Чего в форке **нет** и не появляется: правок `agents.ts`, `skills.ts`,
`execution.ts`, `subagent-executor.ts`, `rpc.ts`, `prompt-template-bridge.ts`,
`child-session.ts`, `child-tool-plan.ts`, `tool-availability.ts`,
`launch-contract.ts`, `types.ts`, `delegation.ts`.

## Канал `subagents:bound:v2:*`

### События

| Имя | Направление | Полезная нагрузка |
|---|---|---|
| `subagents:bound:v2:ready` | форк → клиент | тело ping (эмитируется на `session_start`) |
| `subagents:bound:v2:request` | клиент → форк | `{version:2, requestId, method:"ping"\|"preflight", params?}` |
| `subagents:bound:v2:reply:<requestId>` | форк → клиент | `{version:2, requestId, method?, success, data}` либо `{…, success:false, error:{code, message?}}` |
| `subagents:bound:v2:launch` | клиент → форк | запрос запуска с `binding` |
| `subagents:bound:v2:started` | форк → клиент | `{requestId, ownerRunId, nodeId}` |
| `subagents:bound:v2:update` | форк → клиент | прогресс той же тройки |
| `subagents:bound:v2:terminal` | форк → клиент | ровно один терминал на попытку |
| `subagents:bound:v2:cancel` | клиент → форк | `{requestId, ownerRunId, nodeId, targetServerInstanceId, binding}` |

Upstream-каналы `subagents:rpc:v1:*` и `prompt-template:subagent:*` bound-слой не
слушает и не занимает (Р7).

Маршрутизация: `preflight` — только при
`params.targetServerInstanceId === serverInstanceId` (дескриптор-безопасное
извлечение до разбора, как `activeBoundPreflightTarget` в A1); `launch`/`cancel`
— только при `binding.targetServerInstanceId === serverInstanceId`; чужой target
— молчание, не ошибка.

### Ping v2

Ключи ровно: `serverInstanceId` (UUID RFC-4122), `sourceIdentity` **или**
`sourceIdentityUnavailable`, `version: 2`, `methods: ["ping","preflight"]`,
`capabilities`, `events`, `session`. `sourceIdentity` —
`{version:1, kind:"git", repository, commit, digest}` из
`resolveActiveRuntimeSourceIdentity` (`src/extension/source-identity.ts:271`).
`capabilities` на этом этапе: `{ activeRuntimeIdentity: { version: 2 } }` при
доступной source identity и `{}` при недоступной; `boundForegroundLeaf` не
объявляется ни при каких условиях (Д5). `events` перечисляет все 8 имён канала.
`session` — `{cwd, sessionId, sessionFile}` контекста из аргумента обработчика
`session_start` (см. «Точка Т1»), а не из `state.lastUiContext`. На не-Linux
хостах identity недоступна всегда (см. «Устройство сейчас»), и поведение
закрытое, а не тихое: `sourceIdentityUnavailable`, пустые `capabilities`,
preflight → `unverified_source`.

### Preflight v2

Ответ-успех — ключи ровно `version(2), serverInstanceId, sourceIdentityDigest,
activeSessionDigest, canonicalCwd, requestDigest, launchContract,
launchContractDigest, receipt, cancellationToken`. Ответ-отказ — ключи ровно
`{version: 2, code}`; никаких сообщений, путей и диагностик.

Запрос — закрытый плоский объект, поля ровно:
`version(2), targetServerInstanceId, requestId, ownerRunId, nodeId,
prospectiveRunId, agent, task, cwd, context:"fresh", model, thinking,
timeoutMs?, toolBudget?, skill?, bindings?, artifacts, result` (относительно A1
нет `turnBudget` (Д8) и `artifactDir`, `environment` → `bindings`). Неизвестное
поле, аксессор, прототип, Proxy, символ, нефинитное число или цикл →
`invalid_request` без исполнения чужого кода.

### Контракт запуска v2

Ключи ровно: `version(2), prospectiveRunId, requestDigest, serverInstanceId,
sourceIdentityDigest, activeSessionDigest, canonicalCwd, agent, model,
modelRegistryDigest, modelCandidates, thinking, context, taskDigest, skills,
bindings, packageExtensions, packageExtensionsDigest, tools, mcpDirectTools,
toolRegistry, roots, policy, result, launchInputsDigest, digest` плюс
необязательные `timeoutMs`, `toolBudget`. Отличия от v1: версия 2; `environment`
→ `bindings`; `turnBudget` отсутствует как класс;
`agent.definitionProjectionVersion` = 2 (upstream `launch-contract.ts:7`);
`toolRegistry` получает подобъект `piRuntime`.

`toolRegistry` = `{ modelApi, piRuntime, piRuntimeVersion, projection,
runtimeExtensions, runtimeBuiltins, digest }`, где
`piRuntime = { name, version, packageRootDigest, filesDigest, fileCount }` по Р2,
`runtimeExtensions = { version: 2, entries: [{ name, contentDigest }] }` —
перечень модулей bound-слоя из `bound-layer-manifest.ts` в фиксированном порядке,
`runtimeBuiltins` — проекция `allToolNames` загруженного пакета Pi,
`digest = canonicalSha256({modelApi, piRuntime, piRuntimeVersion, projection,
runtimeExtensions, runtimeBuiltins})`. `piRuntimeVersion` намеренно дублирует
`piRuntime.version`: так проверка версии у клиента v2 остаётся той же строкой,
что и в v1 (`a1-readiness.ts:336-343`), а новый подобъект добавляется рядом.

`bindings = { version: 1, namespace: "onecpi-review/1", names: [...],
valuesDigest }`, `valuesDigest = canonicalSha256({version:1, entries:[{name,
value}]})` в порядке кодовых единиц имени.

`digest` контракта = `canonicalSha256(<контракт без поля digest>)`;
`launchInputsDigest` = `canonicalSha256` проекции входов запуска (агент, модель,
мышление, инструменты, корни, политика, привязки, результат) — то, что
исполнитель A1R.4 сверяет перед созданием сессии.

### Receipt, токен отмены, ключ

Один 32-байтный секрет на экземпляр bound-слоя создаётся
`createLaunchReceiptService()` (`src/api/launch-receipt.ts:77`) в момент
регистрации; живёт только в замыкании сервиса, не публикуется ни в одном событии.
Ротация: reload создаёт новый экземпляр → новый секрет; остановка старого
поколения вызывает `dispose()`, который забивает буфер нулями (`:142-146`).
Receipt: TTL ровно 30 000 мс (`:5`), проверка времени — только при приёме
(admission), время — монотонное `process.hrtime.bigint()/1_000_000n` (`:83`).
Токен отмены дополняет payload тройкой `requestId/ownerRunId/nodeId` и имеет
собственную доменную строку `pi-subagents:active-bound-cancel:v1` (`:89-90`).
Сверка MAC — `timingSafeEqual`.

### Закрытые коды отказов

- Разбор и preflight: `invalid_request`, `no_active_session`,
  `unverified_source`, `unverified_runtime` (новый, Р2: версия пакета на диске ≠
  загруженной либо аттестация не сошлась), `invalid_cwd`, `host_required`,
  `missing_agent`, `ambiguous_agent`, `missing_skill`, `unsupported_mode`,
  `unavailable_model`, `restricted_agent`.
- Приём запуска: `invalid_request`, `unavailable_context`, `duplicate_node`.
- Терминал отменённой попытки: `cancelled`.
Разбор в onecpi превращает незнакомый доменный код в `preflight_<code>` и
падает закрыто (`a1-readiness.ts:305-306`), поэтому `unverified_runtime` не
требует особой ветки у клиента v2; клиента v1 канал v2 не касается (И3.2).

## Preflight без побочных эффектов (И11, пункт 6 чек-листа)

Запрещено: `mkdir`/`mkdtemp`/`writeFile`/`rm`, создание дочерней сессии,
регистрация обработчиков и подписок, резерв идентичности, потребление
`prospectiveRunId`, обращение к провайдеру, запись в `process.env`. Корень —
из `config.defaultSessionDir`, иначе из файла родительской сессии, иначе
`host_required`. Разрешено: чтение файлов, сброс кэша обнаружения агентов в
памяти (Д4), заполнение кэша аттестации Pi на процесс.

Проверка (`test/unit/bound-preflight-no-side-effects.test.ts`): вокруг вызова
снимаются четыре величины — (1) рекурсивный список путей временного корня и
каталога сессий; (2) число созданных сессий у подставленной
`ChildSessionFactory`; (3) число подписок шины и вызовов `pi.on`; (4) `size()`
реестра идентичности (`src/slash/bound-identity-registry.ts:41`). Положительный
контроль: тот же набор утверждений вокруг «грязного» двойника, который создаёт
каталог, создаёт сессию через ту же фабрику, подписывается на событие и
резервирует идентичность, — каждое из четырёх обязано провалиться.

## Координатор, реестры, отмена

Переносится из A1 без изменения семантики: `bound-attempt-coordinator.ts`
(тройка `requestId/ownerRunId/nodeId`, ключ узла `ownerRunId/nodeId`,
`duplicate_tuple`/`duplicate_node`/`capacity`, outbox с «ровно одним
терминалом», проекция терминала остановленной попытки в `cancelled`);
`bound-identity-registry.ts` (`reserve/commit/release` `prospectiveRunId`,
остаётся на пути `src/slash/`, тест сохранён);
`bound-pending-cancellation-registry.ts` (`remember` при неизвестной тройке,
`consume` ровно один раз, `saturated` при насыщении).

Меняется из-за in-process:
1. Ключи глобалей — свои для поколения v2 (`__piSubagentBoundAttemptCoordinatorV2`,
   `__piSubagentBoundPendingCancellationRegistryV3`); апгрейд A1.7→A1.8
   (`upgradeCancellationContract`) не переносится: сборки A1 и A1R не
   сосуществуют в процессе, а несовместимая глобаль → исключение при регистрации
   и отказ от публикации поколения.
2. Полномочие отмены всегда `bound`: legacy-ветки (запрос без `binding`) здесь нет.
3. Отмена = «сессия утилизирована» (Р6): попытка помечена остановленной, порт
   исполнения получает `AbortSignal`, терминал отдаётся после его `dispose()`;
   ожидания `abort()` без предела нет.
4. Обновления ретранслируются только через подписку, снимаемую на завершении
   попытки; после терминала обновлений нет.

## Reload, drain и остановка

- Регистрация нового поколения: сначала кандидат (сервисы созданы, подписки
  пассивны), затем публикация — занятие слота
  `__piSubagentBoundControlPlaneV2` (`{serverInstanceId, stop}`), остановка
  предыдущего поколения, `activateSink(runtimeId, sink)` координатора, установка
  обёртки фабрики (ниже). `:ready` публикация **не** эмитирует: единственная
  точка эмиссии — обработчик `session_start`, по одному событию на
  `session_start`. Ошибка до публикации откатывает кандидата и оставляет старое
  поколение нетронутым.
- Старое поколение: снимает подписки, перестаёт отвечать на свой
  `serverInstanceId`, `dispose()` receipt-сервиса, прерывает свои попытки.
  Их терминалы доставляются ровно один раз уже через новый приёмник.
- **Предел ожидания — обёртка процессной фабрики** (`bounded-child-shutdown.ts`).
  При публикации поколения модуль берёт `childSessionFactory()`
  (`child-session.ts:403`) и ставит на её место (`setChildSessionFactory`,
  `:426`) обёртку: `create()` делегирует базовой фабрике и запоминает ребёнка;
  `dispose()` повторяет отбор upstream — берёт только живых **не-detached**
  детей и помечает им `shutDown = true` (`child-session.ts:387-388`; detached
  дети по контракту продолжают работу, `:107-108`), вызывает им
  `void child.abort()`, ждёт `Promise.race([<все abort>, таймер 3 000 мс])`,
  затем **до возврата** вызывает `child.dispose()` каждому из них (убирает из
  `live`, `:370`; само ограничено upstream-таймаутом 5 000 мс, `:245`) и лишь
  затем `await base.dispose()`. Ссылки на утилизированных детей обёртка
  отпускает.
  Установка идемпотентна по маркеру; других методов у `ChildSessionFactory` нет
  (`:121-125`), поэтому обёртка прозрачна. Предел действует на **всех** детей и
  на любом пути остановки, включая `await disposeChildSessions()`
  (`src/extension/index.ts:1194`).
- Обработчик `session_shutdown` bound-слоя (Т1, регистрируется раньше
  upstream-обработчика `:1191` — порядок доказан прогоном выше) снимает приём
  запросов, отменяет живые попытки и отдаёт их терминалы; `abort()` он не ждёт —
  предел времени держит обёртка фабрики.

## Точка Т1 и площадь правок

В `src/extension/index.ts` вносятся ровно два фрагмента:
1. импорт `import { registerBoundControlPlane } from "../bound/index.ts";` в
   блок импортов;
2. вызов сразу после создания `rpcBridge` (`:759-764`) и до
   `const parameters = createSubagentParamsSchema();`, без присваивания:
   `registerBoundControlPlane({ pi, events: pi.events, getContext: () =>
   state.lastUiContext, config, waitToolEnabled: waitToolConfig.enabled,
   resolveCapabilityCeiling: (sessionId) =>
   resolveCurrentSubagentCapabilityCeiling(sessionId), expandTilde });`
   — все имена доступны в этой области (`:433`, `:434`, `:304`, `:72`).
   Необязательные швы (`resolveSourceIdentity`, часы, таймер отмены, фабрика
   дочерних сессий, реестры) имеют умолчания внутри модуля и в Т1 не передаются:
   их подают только тесты.
   Функция возвращает `{ stop }`, но вызывает его сама из собственных
   обработчиков `session_start`/`session_shutdown`, поэтому в Т1 результат не
   хранится и лишних локальных имён в upstream-файле не появляется.
   Важно: обработчики bound-слоя идут **раньше** upstream-обработчика
   `session_start` (`:1162`), который и присваивает `state.lastUiContext`
   (`:994` в `resetSessionState`), а `rpcBridge.emitReady(ctx)` зовёт уже после
   (`:1186`). Поэтому bound-модуль берёт контекст из аргумента своего
   обработчика (`pi.on("session_start", (event, ctx) => …)`), хранит его как
   `currentContext` и использует для `:ready` и ответов;
   `getContext: () => state.lastUiContext` — запасной источник.

Обработчики upstream (`:1162`, `:1191`), тело `runtimeEntry.cleanup()` и строка
`await disposeChildSessions()` не изменяются (Д3).

Мера площади после этапа (И7):
`git diff --name-only --diff-filter=MD <база> HEAD -- src` → ровно 5:
`src/extension/index.ts` (Т1) + 4 файла Т4–Т7. Сопутствующие upstream-тесты —
ровно те же 4 файла, что и сейчас; новых правок upstream-тестов нет (пункт 5
чек-листа: src-точки и сопутствующие тесты считаются раздельно). Контроль:
на `main` та же команда даёт 27 src-файлов (`… 2c2db5b8 main -- src | wc -l`).

## Шаги

Каждый шаг заканчивается зелёными `npm run typecheck` и своим тестом; общий
прогон наборов — в шаге Ш9.

**Ш1. Каркас и строгий клон.** Создать `src/bound/` и в нём заготовку входа
`index.ts` (экспортирует `registerBoundControlPlane`, пока возвращающий
`{ stop: () => {} }`), чтобы последующие шаги и манифест имели точку входа.
Перенести строгий клон в `src/bound/bound-json.ts` — побайтовая копия upstream
`src/slash/delegation-json.ts` с единственным добавлением
`if (utilTypes.isProxy(object)) throw new TypeError("invalid")` рядом с проверкой
цикла (`:43`, `const object` — `:42`); опции A1 не переносятся. Перевести на него
`src/api/launch-receipt.ts:2`.
Тест `test/unit/bound-json.test.ts`: Proxy → `{ok:false, reason:"invalid"}`
и ни одной сработавшей ловушки (проверка `isProxy` предшествует обходу);
обычный объект → `{ok:true}`;
receipt/cancellation-token, поданные Proxy-объектом, не проходят проверку;
дифференциальная сверка с upstream-функцией на корпусе значений (объекты,
массивы, вложенность, границы байтов, аксессоры, символы, непронумерованные
ключи массива, циклы) — результаты совпадают **на всём корпусе**, единственное
расхождение воспроизводится только входом-Proxy.
Исход: регрессия пункта 10 чек-листа закрыта, мера риска «форк-копия расходится
с upstream» имеет шаг и проверку.

**Ш2. Аттестация runtime и манифест слоя.** `pi-runtime-attestation.ts`:
определение корня загруженного пакета Pi, сверка `name`/`version` манифеста с
версией загруженного модуля, digest собственных файлов без `node_modules`,
импорт `allToolNames` по абсолютному пути. Кэш — `Map` по абсолютному корню
пакета плюс тест-шов `resetPiRuntimeAttestationCache()`; в продакшене корень
один, поэтому это по-прежнему «раз на процесс», а тест, меняющий байт фикстурного
пакета, сбрасывает кэш явно и потому видит другой digest. Несовпадение версии
или недоступность `allToolNames` → `unverified_runtime`.
`bound-layer-manifest.ts`: упорядоченный перечень модулей слоя + digest содержимого.
Тесты `test/unit/bound-runtime-attestation.test.ts` (фикстурный пакет:
изменение одного байта меняет digest — положительный контроль; подмена версии в
манифесте → отказ) и `test/unit/bound-layer-manifest.test.ts`: каждая запись манифеста указывает на
существующий файл, digest совпадает с байтами, порядок фиксирован; сверка
манифеста с полным транзитивным замыканием импортов от `src/bound/index.ts`
делается тем же тестом, но исполняется как критерий приёмки в Ш9, когда все
модули слоя уже созданы (до этого замыкание заведомо неполно).

**Ш3. Разбор запроса и привязки.** `bound-request.ts` и `bound-bindings.ts` с
digest-проекциями. Тест `bound-request.test.ts`: неизвестное поле, `turnBudget`,
аксессор, прототип, Proxy, символьный ключ, нефинитное число, превышение лимитов
байт, невалидные UUID/модель/thinking. Тест `bound-bindings.test.ts`: 6
разрешённых имён, чужое имя, чужое пространство, пустое значение, NUL, битая
суррогатная пара, лимиты 4 KiB/8 KiB, стабильность `valuesDigest` — он закрывает
пункт 11 чек-листа.

**Ш4. Резолвер контракта v2.** `bound-agent-discovery.ts`,
`bound-package-extensions.ts`, `bound-tool-registry-projection.ts`,
`bound-resolver.ts`. Резерв имён через `CORE_RUNTIME_OWNED_TOOLS`
(`src/runs/shared/core-runtime-tools.ts:2`) и внутренний список (`:13`);
`discoveryCwd` = cwd активной сессии хоста, `cwd` листа — из запроса;
MCP-имена — через `resolvePiLaunchToolPlan`.
Тест `test/unit/bound-resolver.test.ts` + золотой слепок
`test/fixtures/bound/contract-v2.golden.json`: на фиксированном входе digest
контракта равен эталону. Чтобы слепок не устаревал от роста слоя, резолвер
принимает манифест и аттестацию **параметрами**, и в Ш4 тест подаёт фикстурные
значения (`test/fixtures/bound/layer-manifest.fixture.json` и фикстурный корень
пакета); живой манифест в слепок не входит. Слепок генерируется один раз в Ш4 и
после этого не перегенерируется: его изменение означает изменение контракта. Положительный контроль мутирует **входы резолвера**, а не поля готового
контракта (порча выхода меняет хеш тавтологически): байты файла агента, состав
skills, список инструментов и MCP-селекторы, привязки, модель и thinking,
`cwd`/корни, `timeoutMs`/`toolBudget` запроса, байты аттестуемого пакета Pi
(через фикстурный корень) и содержимое модуля bound-слоя из манифеста. Каждый
такой вход, изменённый по одному, обязан дать другой `digest`; вход, не
меняющий digest, — провал. Там же измеряется длительность
одного preflight на фикстуре (с `clearAgentDiscoveryCache()`, Д4): значение
печатается и сверяется с потолком 2 000 мс — это мера риска по Д4/В4.

**Ш5. Сервис и receipt.** `bound-runtime-service.ts`: `preflight()` (все коды
отказов), выпуск receipt и токена отмены, `admit()` с повторным разрешением
контракта и сверкой digest, `verify{Pending,Active}Cancellation`, `dispose()`.
Тест `test/unit/bound-runtime-service.test.ts`: успешный preflight → ровно
объявленный набор ключей; каждый код отказа достигается своим входом и ответ
несёт ровно `{version, code}`; просроченный, чужой и подделанный receipt не
принимаются; два сервиса с одинаковым payload дают разные MAC; после `dispose()`
проверка любого receipt — `false`. Финальная перепроверка: между preflight и
`admit()` меняются байты файла агента (и, отдельным случаем, привязка) — `admit()`
отвечает отказом, потому что заново разрешённый контракт даёт другой
`launchContractDigest`; положительный контроль — без подмены тот же вход
принимается.
Тест `test/unit/bound-preflight-no-side-effects.test.ts` — по разделу И11.

**Ш6. Канал ping/preflight.** `channel.ts` + приёмная часть `index.ts`:
подписки, маршрутизация по `targetServerInstanceId`, `:ready` на `session_start`.
Тест `test/unit/bound-channel.test.ts` (identity подаётся швом): ping отвечает
ровно один раз; чужой target — молчание; невалидный конверт — молчание (без
ответа-ошибки на неизвестный `requestId`); при недоступной identity ответ несёт
`sourceIdentityUnavailable` и пустые `capabilities`, а preflight —
`unverified_source`. Смена поколения проверяется в Ш8, где появляется сама
публикация.
Тест `test/unit/bound-onecpi-v1-compat.test.ts`: клиент, повторяющий проверки
`a1-readiness.ts:213-229` на канале v1, против этой сборки получает
`malformed_ping`; положительный контроль — заглушка-ответчик v1 с
`sourceIdentity`, но без capability, даёт `unsupported_capability` (то есть
проверка различает два кода). Список обязательных ключей и порядок проверок
копируются дословно из `a1-readiness.ts:215-229` пина
`c32663ec7e9f4c3c35456552c1d262eeeb845a60`, и это записано в комментарии теста
вместе с оговоркой: копия может отстать от клиента, авторитетная
кросс-репозиторная проверка — A1R.5/A1R.6.

**Ш7. Приём запуска и отмена.** `bound-attempt-coordinator.ts`,
`bound-pending-cancellation-registry.ts`, `bound-launch-bridge.ts`, порт
исполнения (Д9). Тесты `bound-attempt-coordinator.test.ts` и
`bound-pending-cancellation-registry.test.ts` переносятся из A1 с заменой имён
глобалей; `test/unit/bound-launch-bridge.test.ts`: приём с
валидным binding → `:started` и ровно один `:terminal` (без порта исполнения —
`unavailable_context`, с подставленным портом — `completed`); дубль тройки → отказ без
второго `:started`; дубль узла → `duplicate_node`; отмена верным токеном
отменяет только свой кортеж; чужой, повторный и подделанный токен не отменяют
ничего; отмена до приёма потребляется ровно один раз; после терминала обновления
не эмитируются; приём резервирует `prospectiveRunId` в
`bound-identity-registry.ts` и переводит его в committed при старте, а любой
отказ после резерва освобождает его (наблюдается через `size()`/`has()`), повтор
той же идентичности → `duplicate_node` (И3.20).

**Ш8. Т1, reload и ограниченная остановка.** Внести два фрагмента в
`src/extension/index.ts`, реализовать публикацию/остановку поколения и обёртку
`bounded-child-shutdown.ts` (ставится при публикации, идемпотентно).
Тест `test/unit/bound-registration.test.ts` (образец — существующий
`test/unit/index-child-registration.test.ts`, фальшивый `pi` со списком
обработчиков): bound-обработчики `session_start`/`session_shutdown`
зарегистрированы раньше upstream-обработчиков (`:1162`, `:1191`); `:ready`
эмитируется на `session_start` и несёт `session` из **ctx-аргумента
обработчика** — положительный контроль: `getContext()` возвращает другой,
устаревший контекст, и payload обязан показать контекст аргумента; на одно
`session_start` приходится ровно один `:ready`, а регистрация без `session_start`
не даёт ни одного (счётчик событий); повторная
регистрация в том же процессе (модель reload) останавливает предыдущее поколение:
на ping приходит ровно один ответ с новым `serverInstanceId`, на старый
`serverInstanceId` ответа нет, а попытка, принятая старым поколением, получает
свой единственный терминал через приёмник нового поколения (И3.10);
положительные контроли: старое поколение, у которого не сняли подписки, отвечает
на тот же ping вторым ответом (проверка различает «один ответчик»); а если новый
приёмник не активирован (`activateSink` не вызван), терминал остаётся в outbox и
до клиента не доходит — значит наблюдение «ровно один терминал через новый
приёмник» не выполняется само собой.
Тест `test/unit/bound-shutdown-deadline.test.ts`: базовая фабрика-заглушка,
создающая **не-bound** ребёнка, чей `abort()` никогда не разрешается (фикстура
`test/support/fake-child-session.ts` не годится — её `abort()` разрешается
сразу, `:492`), ставится через `setChildSessionFactory`; поверх неё
устанавливается обёртка `bounded-child-shutdown.ts`; часы и таймер подставлены.
Утверждения: (1) `disposeChildSessions()` возвращает управление в пределах
дедлайна; (2) в журнале вызовов `child.dispose()` стоит до возврата, а не после;
(3) `create()` обёртки отдаёт ровно объект базовой фабрики, а повторная
установка обёртки поверх себя не создаёт второго слоя; (4) ребёнок с
`detached = true` после `disposeChildSessions()` не получил ни `abort()`, ни
`dispose()`, ни `shutDown`, а не-detached получил всё это — сравнение с базовой
фабрикой без обёртки даёт тот же результат по detached-ребёнку. Положительные контроли:
та же заглушка без обёртки — `disposeChildSessions()` не укладывается в дедлайн
(значит тест способен упасть); реализация, откладывающая `dispose()` на таймер
после возврата, проваливает (2). В `t.after` фабрика возвращается в исходное
состояние `setChildSessionFactory(undefined)`, как в
`test/integration/nested-async-wait.test.ts:55`.

**Ш9. Приёмка этапа.** Прогоны: `npm run typecheck`;
`LC_ALL=C npm run test:unit`; `LC_ALL=C npm run test:integration`
(`LC_ALL=C` обязателен, см. `FORK.md`);
`git diff --name-only --diff-filter=MD <база> HEAD -- src` → ровно 5 путей
(Т1 + Т4–Т7), тот же вывод без `-- src` → 9 путей (плюс 4 сопутствующих
upstream-теста);
`node --experimental-strip-types --test test/unit/bound-layer-manifest.test.ts`
— транзитивное замыкание импортов от `src/bound/index.ts`, **пересечённое с
форк-owned множеством** (все файлы каталога `src/bound/` по листингу плюс
литеральный список сохранённых модулей A1 — после удаления
`active-bound-environment.ts` (Д6) их 6), совпадает с манифестом; всякий член замыкания вне этого множества обязан входить в отдельный
литеральный список ожидаемых upstream-модулей в теле теста, иначе провал — так
новый форк-модуль не спрячется, а новая зависимость от upstream становится
видимым решением. Положительный контроль — временно добавленный форк-модуль без
записи в манифесте валит тест;
`git grep -n boundForegroundLeaf -- src` → пусто (capability не объявлена;
контроль — та же команда по `main` находит `src/extension/rpc.ts:407`);
`git grep -n "subagents:rpc:v1\|prompt-template:subagent" -- src/bound` → пусто
(bound-слой не занимает upstream-каналы; контроль — та же команда по
`src/extension/rpc.ts` и `src/api/delegation.ts` находит `rpc.ts:30-32` и
`delegation.ts:6-10`; в `src/slash` литеральных имён этих каналов нет, там только
реэкспорт констант — `prompt-template-bridge.ts:26-30`).
Обновить `FORK.md`: статус «control plane v2 поднят, исполнение листа и
capability — A1R.4», снять из раздела пробелов покрытия строки про
`active-bound-environment` и `delegation-json` (закрыты в Ш1/Ш3), перечислить
новые команды проверки и записать платформенное ограничение: bound-канал
отвечает везде, но preflight выдаёт контракт только на Linux-хосте
(`src/extension/source-identity.ts:277`).

## Инварианты этапа

- **И3.1.** Ответ ping v2 несёт ровно объявленный набор ключей (`sourceIdentity`
  **либо** `sourceIdentityUnavailable`), `serverInstanceId` — UUID RFC-4122,
  `sourceIdentity` описывает текущий checkout. При недоступной source identity
  (в т.ч. на любом не-Linux хосте) ответ несёт `sourceIdentityUnavailable`,
  `capabilities` пусты, а preflight отвечает `unverified_source`.
- **И3.2** (= И1 зонтичного плана). Против этой сборки клиент контракта v1
  отказывает закрыто кодом `malformed_ping`: на канале v1 ему отвечает только
  upstream-мост (`src/extension/rpc.ts:439-468`), чей ping не содержит
  `serverInstanceId`/`sourceIdentity`, а bound-слой канал v1 не слушает вовсе
  (Р7). Проверка ключей (`a1-readiness.ts:215-217`) срабатывает раньше проверок
  `unsupported_ping` (`:218-220`) и `unsupported_capability` (`:226-229`).
- **И3.3** (= часть И9). В процессе ровно один отвечающий bound-слой; после
  смены поколения старый `serverInstanceId` не отвечает.
- **И3.4** (= И11). Preflight не создаёт файлов, каталогов, сессий, подписок,
  обработчиков и резервов идентичности.
- **И3.5.** Контракт детерминирован: одинаковый вход → одинаковый digest; любой
  связанный вход меняет digest.
- **И3.6.** Каждый отказ — код из закрытого списка; тело отказа не содержит
  ничего, кроме `version` и `code`.
- **И3.7.** Receipt принимается только свой, живой и неподделанный; после
  `dispose()` — ни один.
- **И3.8.** Верный токен отменяет только свой кортеж; чужой, повторный и
  подделанный — ни одного; отмена до приёма потребляется ровно один раз.
- **И3.9.** На попытку приходится ровно один терминал, доставленный один раз.
- **И3.10** (= И10). Reload прерывает попытки старого поколения, их терминалы
  доставляются ровно один раз через новый приёмник.
- **И3.11.** `disposeChildSessions()` и обработчик `session_shutdown`
  возвращают управление в пределах дедлайна для любого **не-detached** ребёнка
  (bound и не-bound), чей `abort()` не разрешается, и к моменту возврата
  `dispose()` каждого такого ребёнка уже вызван, а не запланирован на будущий
  тик; detached-дети не прерываются и не утилизируются, как и у upstream
  (`child-session.ts:387`, контракт `:107-108`).
- **И3.12.** Несовпадение версии пакета Pi на диске с загруженной → закрытый
  отказ `unverified_runtime`; digest аттестации меняется при изменении байта
  пакета.
- **И3.13.** Строгий клон отвергает Proxy, не вызвав ни одной его ловушки;
  этим же клоном проверяются недоверенные receipt/token.
- **И3.14.** В привязках допустимы только 6 имён пространства `onecpi-review/1`;
  всё прочее — `invalid_request`.
- **И3.15.** `toolRegistry.runtimeExtensions` перечисляет ровно форк-owned
  модули (каталог `src/bound/` и сохранённые модули A1), входящие в замыкание
  импортов от входа слоя; зависимости от upstream-модулей перечислены отдельным
  явным списком в тесте.
- **И3.16** (= И7). Правки upstream-файлов в `src` — ровно Т1 и Т4–Т7 (5),
  сопутствующих upstream-тестов — ровно 4 прежних.
- **И3.17** (= И8). Наборы upstream-тестов зелёные без правок upstream-тестов.
- **И3.18.** Capability `boundForegroundLeaf` в сборке отсутствует.
- **И3.19.** Пока порт исполнения не подключён (Д9), принятый запуск завершается
  ровно одним терминалом `unavailable_context`, а не зависанием и не тишиной.
- **И3.20.** Идентичность `prospectiveRunId` резервируется при приёме, переводится
  в committed при старте попытки и освобождается при любом отказе после резерва;
  повторный запуск с той же идентичностью → `duplicate_node`.

## Таблица проверок

| Обещание / инвариант | Проверка | Положительный контроль |
|---|---|---|
| И3.1 форма ping (в т.ч. при недоступной identity) | `bound-channel.test.ts`: набор ключей и формат полей при обоих исходах шва `resolveSourceIdentity` | удаление одного ключа в двойнике ответа ломает проверку; при доступной identity `capabilities` непусты, при недоступной — пусты |
| И3.2 отказ клиента v1 | `bound-onecpi-v1-compat.test.ts` | ответчик v1 с `sourceIdentity` без capability → `unsupported_capability` |
| И3.3 один ответчик | `bound-channel.test.ts`: одна регистрация → 1 ответ; повторная → 1 ответ и новый id | вторая активная подписка без остановки старой даёт 2 ответа |
| И3.4 preflight без эффектов | `bound-preflight-no-side-effects.test.ts`: 4 снимка | «грязный» двойник обязан провалить все 4 утверждения |
| И3.5 детерминизм контракта | `bound-resolver.test.ts` + золотой слепок | перебор по одному изменению **входа резолвера** (байты агента, skills, инструменты, привязки, модель, корни, бюджеты, байты пакета Pi, байты модуля слоя): каждый меняет digest |
| И3.6 закрытые коды | `bound-runtime-service.test.ts`: вход на каждый код, ключи ответа | отказ с лишним полем `message` проваливает проверку ключей |
| И3.7 receipt | `bound-runtime-service.test.ts`: просроченный / чужой / изменённый / после `dispose()` | два сервиса с равным payload дают разные MAC |
| И3.8 targeted cancel | `bound-launch-bridge.test.ts` + `bound-pending-cancellation-registry.test.ts` | верный токен отменяет свой кортеж — иначе «ничего не отменено» неотличимо от поломки |
| И3.9 один терминал | `bound-launch-bridge.test.ts` | повтор доставки после исключения в слушателе не даёт второго терминала |
| И3.10 reload/drain | `bound-channel.test.ts` + `bound-launch-bridge.test.ts` | терминал старой попытки приходит ровно один раз и через новый приёмник |
| И3.11 предел остановки для не-detached ребёнка | `bound-shutdown-deadline.test.ts`: дедлайн, порядок вызовов, прозрачность обёртки, отдельный detached-ребёнок | без обёртки тот же `disposeChildSessions()` не укладывается в дедлайн; detached-ребёнок обязан остаться нетронутым и с обёрткой, и без неё |
| И3.12 аттестация runtime | `bound-runtime-attestation.test.ts` | изменение байта фикстурного пакета меняет digest |
| И3.13 строгий клон | `bound-json.test.ts`: Proxy + дифференциальная сверка с upstream-клоном | обычный объект по-прежнему принимается обеими реализациями |
| И3.14 привязки | `bound-bindings.test.ts` | разрешённое имя проходит, чужое — нет |
| И3.15 манифест слоя | `bound-layer-manifest.test.ts`: записи и digest в Ш2, полное замыкание импортов — в приёмке Ш9 | временно добавленный модуль без записи в манифест проваливает тест |
| И3.16 площадь правок | `git diff --name-only --diff-filter=MD <база> HEAD -- src` → 5 | та же команда на `main` → 27 |
| И3.17 upstream зелёный | `LC_ALL=C npm run test:unit`, `… test:integration` | инвертированное утверждение в новом тесте делает набор красным (значит новые файлы исполняются набором) |
| И3.18 нет capability | `git grep -n boundForegroundLeaf -- src` → пусто | на `main` та же команда находит `src/extension/rpc.ts:407` |
| И3.19 терминал без порта | `bound-launch-bridge.test.ts`: запуск без порта исполнения | с подставленным портом-заглушкой тот же вход даёт терминал `completed` |
| И3.20 идентичность | `bound-launch-bridge.test.ts`: `size()`/`has()` реестра до приёма, после старта и после отказа | успешный приём оставляет идентичность committed, отказ возвращает `size()` к исходному |

## Риски и откат

- **Дрейф upstream в `resolvePiLaunchToolPlan`** меняет digest контракта. Мера:
  золотой слепок; изменение digest — осознанный подъём версии контракта.
- **Форк-копия строгого клона** расходится с upstream при синхронизациях. Мера:
  дифференциальная сверка в Ш1 на всём корпусе с единственным умышленным
  расхождением (вход-Proxy); строка И3.13 таблицы.
- **Bound-возможность есть только на Linux** (`source-identity.ts:277`): на
  darwin/Windows preflight всегда `unverified_source`, onecpi отказывает
  закрыто. Мера: факт в «Устройстве сейчас» и в `FORK.md` (Ш9); тесты подают
  identity швом; проба A1R.5 — на Linux-хосте. Снятие гейта вне этапа.
- **Приватные детали Pi** (путь `dist/core/tools/index.js`, нет экспорта
  `allToolNames`). Мера: `unverified_runtime` при недоступности, регрессионный
  тест при обновлении Pi; capability и так не объявлена до A1R.4.
- **`clearAgentDiscoveryCache()` на каждый preflight** (Д4) удорожает preflight
  и сбрасывает кэш хоста. Мера: замер длительности в Ш4 с потолком 2 000 мс;
  при неприемлемой цене — вилка В4.
- **Прозрачность обёртки фабрики** (Д3): любое отличие от базовой фабрики
  меняет поведение всех делегаций. Меры: обёртка добавляет только предел в
  `dispose()`; полные наборы upstream-тестов в Ш9 (И3.17); утверждение (3) теста
  дедлайна про идентичность возвращаемого `create()` объекта.
- **Откат**: этап живёт в `feat/a1r-base` отдельными коммитами, `main` форка и
  пин onecpi не двигаются до A1R.7; откат = снятие коммитов этапа, Т1 снимается
  тривиально.

## Открытые вопросы (вилки, закрытые веткой по умолчанию)

- **В1.** Версия payload receipt/токена: оставить `1` (выбрано, Д1) или поднять
  до `2` вместе с контрактом. Альтернатива добавляет правку
  `src/api/launch-receipt.ts` и его теста и требует согласования с A1R.6.
- **В2.** Пространство привязок: закрытый список 6 имён в форке (выбрано, Д2) или
  конфигурируемый реестр пространств. Второе меняет форму контракта
  (`bindings.namespace` становится проверяемым входом клиента).
- **В3.** Где живёт предел ожидания на остановке: обёртка процессной фабрики в
  форке (выбрано, Д3) — или таймаут внутри `createDefaultChildSessionFactory`
  с PR в upstream (Р10, «малые исправления»). Обёртка не трогает upstream-файлы
  и работает сразу; PR снял бы и обёртку, и риск её прозрачности, но зависит от
  чужого решения. Ветки не исключают друг друга: PR можно открыть после A1R.3.
- **В4.** Свежесть обнаружения агентов: сброс кэша перед каждым разрешением
  (выбрано, Д4) или опора на фингерпринт upstream-кэша. Второе дешевле, но
  проекция может отстать от байтов файла.
- **В5.** Удаление `src/api/active-bound-environment.ts` (выбрано, Д6) против
  сохранения модуля как обёртки над `bound-bindings.ts` ради дословного
  выполнения пункта 11 чек-листа.
