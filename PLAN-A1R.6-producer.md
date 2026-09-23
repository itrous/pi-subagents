# A1R.6 (producer) — bound v2 на Pi 0.87.1: барьер transcript, bindings, shadowing, MCP-конфиг

## Задача и источник решений

Producer-часть S1 плана onecpi `docs/plans/bound-v2-native-migration.md`
(коммит onecpi `41438fe558a87b1b7d3429ef2b3fc710a641d4c9`, раздел «S1. Producer»,
решения Q1–Q6). Решения этим документом не пересматриваются; здесь зафиксированы
точные DTO и проверки, которые план S1 относит к producer subplan «до реализации».
Требование: GitLab onecpi #19. База форка — `9e0466470368743a3572ada5e335137f2cb18e59`.
Хост — Pi 0.87.1 (SDK и бандл CLI).

Статус review: независимое review отложено по Q6 до ремонта native-пути; этот
документ и код среза ревьюятся штатным `/onecpi:review` (CLI-маршруты), что не
является native-приёмкой #19.

## Вне рамок

Consumer (onecpi, S2), установка (S3), публикация (S4), upstream-файлы вне семи
точек подключения, возврат к v1, subprocess-fallback, ослабление source identity,
изменение содержательных инструкций линз. D10 не снимается для запусков без
аттестованного MCP-конфига.

## Подэтап 1. Барьер на `TranscriptContext` (Pi 0.87.1)

Доказанный дрейф (стенд `pio-136-bootstrap-01`, `out/stream-contract.json`):
Pi 0.87.1 передаёт в `streamFunction` контекст `{ messages }`
(`pi-agent-core/dist/agent-loop.js:268`, `normalizeContext`), а инструменты
вызова — это replay `toolsAdded`/`toolsRemoved` системных сообщений
(`pi-ai/dist/utils/transcript.js:41-52`). Старый барьер читал `context.tools` и
отказывал каждому вызову как `compaction_forbidden`.

Решение (`src/bound/bound-transcript.ts`, `bound-stream-barrier.ts`):

- Источник replay — `getCurrentTools` той копии pi-ai, которую исполняет
  загруженный Pi. Её дают те же спецификаторы, что загрузчик расширений Pi
  отображает на свои модули (virtual modules в бандле CLI, dist-aliases иначе):
  `import("@earendil-works/pi-ai")`, `import("@earendil-works/pi-agent-core")`.
  Резолв по `node_modules` пакета Pi НЕ используется: бандл CLI несёт свою
  вшитую копию pi-ai. Идентичность доказывается двумя фактами: pi-agent-core
  реэкспортирует тот же объект `uuidv7`, что держит наш pi-ai (одна инстанция
  модуля), и `session.agent instanceof Agent` этой pi-agent-core.
- `boundTranscriptTools(context, api)` принимает только точную форму: plain
  object с единственным собственным ключом `messages` (data-свойство, не Proxy);
  дельты только на `role: "system"`; каждый элемент дельты — объект с валидным
  именем; дубликат имени внутри одной дельты — отказ. Собственный replay форка
  сравнивается с replay рантайма поэлементно по идентичности объектов; расхождение
  — отказ. Декларация инструмента — SHA256 канонического JSON
  `{name, description, parameters, constrainedSampling?}` после JSON round trip
  (как `toToolDeclaration`).
- Порядок отказов барьера: не transcript → `context_unsupported`; пустой набор →
  `compaction_forbidden` (compaction 0.87.1 строит transcript без tools);
  набор имён ≠ контракту или дубликат → `tool_registry_mismatch`; модель/api →
  `model_mismatch`; декларация ≠ закреплённой → `tool_definition_mismatch`.
  Декларации первого допущенного вызова закрепляются: реестр после барьера
  неизменяем, замена определения под тем же именем — дрейф. Декларации из
  `expectation.declarations` (аттестованный shadowing) сверяются на каждом вызове.
- Барьер не ставится без проверенного API (`verifiedBoundTranscriptApi()`):
  запуск закрывается `barrier_unavailable` до сети.
- Self-check (`bound-self-check.ts`) получает поля `transcriptApi` (идентичность
  выше) и `transcriptContext`: на `Agent` рантайма два prompt с
  `streamFn`, который записывает контекст и бросает ошибку (провайдера и сети нет);
  второй набор удаляет инструмент, добавляет инструмент и заменяет определение
  третьего; replay обязан отразить каждый шаг и замену, а форма `{ tools }` —
  отвергаться. Только полностью пройденный self-check записывает проверенный API.
  Capability `boundForegroundLeaf: { version: 2 }` требует обоих новых полей.

Новые коды `toolRegistryError` (статус `native_tool_registry_mismatch`):
`context_unsupported`, `tool_definition_mismatch`.

## Подэтап 2. Bindings текущего child session для независимого consumer

Канал — приватная per-run шина пакетов (`createBoundPackageEventBus`, её видят
только фабрики пакетов одного запуска; host bus недостижим). Отвечает producer,
подписанный на шину до вызова фабрик. Ответ синхронен внутри `emit` запроса:
consumer подписывается на канал ответа ДО `emit`.

```
запрос  "subagents:bound:bindings:v1:request"
  { version: 1, requestId: string, sessionId: string }
ответ   "subagents:bound:bindings:v1:reply:<requestId>"
  { version: 1, requestId, success: true,
    data: { version: 1, namespace: "onecpi-review/1", sessionId, cwd,
            bindings: { <ONECPI_REVIEW_*>: string }, valuesDigest } }
  | { version: 1, requestId, success: false,
      error: { version: 1, code: "invalid_request" | "unknown_session" } }
```

- `requestId`: 1–128 символов `[A-Za-z0-9._:-]`; иначе ответа нет (некуда).
  `sessionId`: непустая строка ≤ 256 байт без переводов строк.
- Лишние/отсутствующие поля, Proxy, accessor, `version ≠ 1` → `invalid_request`.
- `unknown_session`: id не опубликован ДЛЯ ЭТОГО запуска: до `session_start`,
  после `session_shutdown`, после закрытия записи, чужой запуск. Перечисления
  сессий, registry, receipt/HMAC и host bus нет.
- `cwd` — `contract.canonicalCwd`; `valuesDigest` — `contract.bindings.valuesDigest`;
  `bindings` — замороженная копия принятых bindings. Пустые bindings — успешный
  ответ с `{}`; отсутствие bindings consumer трактует сам (native-путь закрыт).
- Жизненный цикл: публикация на `session_start` bound-хука (первого хука
  запуска), снятие на `session_shutdown` и `registry.close`; reload хоста
  останавливает запуск (dispose → shutdown) и тем снимает доступ.

Capability: `boundSessionBindings: { version: 1 }` (только вместе с
`boundForegroundLeaf`).

## Подэтап 3. Аттестованный shadowing встроенных инструментов (Q3)

Закрытый набор заменяемых имён форка: `find`, `grep`, `ls`, `read` (read-only
built-ins). `bash`, `edit`, `write` и любые иные имена не заменяются.

Запрос (новое необязательное поле v2 request, входит в `requestDigest`):
```
toolShadowing: { version: 1, extension: string, tools: string[] }
```
- `tools`: непустой, без повторов, в порядке code units, подмножество набора выше.
- `extension`: ровно `ref` одной записи `packageExtensions` контракта вида
  `"relative"` (код самого владельца-агента). `package:`-зависимости (например,
  pi-mcp-adapter) права замены не получают.
- Каждое имя обязано быть встроенным инструментом аттестованного рантайма
  (`runtimeBuiltins.names`) и входить в `tools.effectiveAllowlist`.
  Нарушение → `unsupported_mode` на preflight. Старый producer отвергает
  неизвестное поле как `invalid_request`.

Контракт: `toolRegistry.shadowing` (только при запросе; входит в
`toolRegistry.digest`, `launchInputsDigest` и `digest`, а значит в receipt):
```
{ version: 1, tools: string[],
  extension: { ref, owner: { name, version, manifestDigest },
               contentDigest, packageTreeDigest, evidenceRootDigest } }
```
Поля `extension` — копия записи `packageExtensions` этого `ref`.

Исполнение:
- Фасад пакета разрешает `registerTool(<имя из tools>)` только фабрике, чья
  аттестация — этот `ref` (путь и `contentDigest` совпадают с контрактом), и
  только один раз на имя. Любая другая фабрика, повтор, имя вне `tools`, регистрация
  после барьера → `package_mutation`.
- Записывается декларация каждой замены (digest по правилу подэтапа 1).
- После `bindExtensions`, до барьера: каждое имя зарегистрировано (иначе
  `shadowing_incomplete`); активное определение по `getAllTools()` — не
  `sourceInfo.source === "builtin"` и с той же декларацией (иначе
  `shadowing_mismatch`). Ошибка → запуск закрыт, 0 запросов, built-in не
  подставляется.
- Барьер получает декларации замен как обязательные: вызов, в котором модели
  предъявлен иной `read`, отказывается `tool_definition_mismatch`.
- Terminal при контракте с shadowing несёт
  `toolShadowing: { version: 1, tools, declarations: { <имя>: <digest> } }`;
  `completed` без этого доказательства превращается в
  `native_tool_registry_mismatch` / `shadowing_unverified`.

Capability: `boundToolShadowing: { version: 1 }`.

## Подэтап 4. Аттестованный MCP-конфиг (B1, Q2)

Проба по коду pi-mcp-adapter 2.26.1: ранний конфиг читается из
`process.cwd()`/`process.argv --mcp-config` (`index.ts:116-121`), полный — из
`ctx.cwd` и `pi.getFlag` (`init.ts:100-113`), источники сливаются с глобальными
(`config.ts:293-310`). Программный вход `createMcpAdapter({ config })`
(`index.ts:932-940`) исключает файловое обнаружение на обоих путях: ранний
конфиг — клон переданного, полный init — клон переданного, серверы стартуют в
`ctx.cwd` (`server-manager.ts:489`). Поэтому B1 — передача адаптеру проверенного
объекта конфигурации, без `process.chdir`, argv и env.

Запрос (новое необязательное поле v2 request):
```
mcpConfig: { version: 1, path: string }
```
- `path`: абсолютный канонический путь (без symlink-компонент) обычного файла
  ≤ 256 KiB с JSON-объектом.
- Допустимо только для агента с MCP direct tools и ровно одной аттестованной
  записью `packageExtensions` вида `package` с `package.name === "pi-mcp-adapter"`.
- Закрытая форма конфигурации: верхний уровень — только `mcpServers` (обязателен,
  объект) и `settings`; запрещены `imports`, `settings.agentPluginPaths`,
  `settings.hostConfigDiscovery` отличный от `"off"`, у сервера `lifecycle`
  `"eager"`/`"keep-alive"` (ранний init адаптера стартует такие серверы в
  `process.cwd()`), относительный `cwd` сервера. Нарушение → `unsupported_mode`.
- С `mcpConfig` preflight допускает MCP-агента и при внешнем cwd.

Контракт: поле верхнего уровня `mcpConfig` (только при запросе; входит в
`launchInputsDigest` и `digest`):
```
{ version: 1, extension: "package:pi-mcp-adapter",
  sourcePathDigest, contentDigest, effectiveDigest, servers: string[] }
```
`contentDigest` — SHA256 байтов файла; `effectiveDigest` — canonical SHA256
разобранного объекта, который получит адаптер; `servers` — имена в порядке code units.

Исполнение:
- Перед загрузкой фабрик файл перечитывается один раз; путь, байты и effective
  digest сверяются с контрактом (иначе `unavailable_context` /
  `mcp_config_drift`); адаптеру передаётся объект, разобранный из ЭТИХ байтов.
- Фабрика адаптера строится `createMcpAdapter({ config })` из пространства имён
  аттестованного entry (тот же импортёр с проверкой корней); нет функции →
  `package_load_error`.
- Гейт D10 (`mcp_cwd_mismatch`) пропускается только при контракте с `mcpConfig`.
- Окно `MCP_DIRECT_TOOLS` и exact-набор инструментов не меняются: холодный и
  тёплый кэш метаданных адаптера обязаны дать один и тот же полный набор к снимку
  реестра.

Согласование с upstream-резолвом имён (найдено при реализации, не меняет решения
Q2): upstream-исполнитель (`buildInProcessChildLaunch` → `resolvePiLaunchToolPlan`,
вне семи точек подключения) сам переводит селекторы `server/tool` в имена по
файлам, найденным в cwd листа, и по кэшу метаданных; конфиг-override у него нет.
Поэтому preflight, окно и финальная сверка требуют, чтобы резолв селекторов по
аттестованному объекту и по обнаружению в cwd листа дал одинаковые пары
`селектор→имя`, а имена контракта входили в них. Кэш держит одну запись на имя
сервера с проверкой hash определения, значит совпадение означает и одинаковое
определение каждого выбранного сервера; чужой глобальный конфиг с теми же
именами перекрыт проектным при обнаружении и не читается адаптером вовсе.
Расхождение → `unsupported_mode` на preflight, `launch_contract_mismatch` при
исполнении. Следствие: upstream-планирование bound MCP-листа, как и до B1,
требует свежего кэша метаданных (`formatUnresolvedMcpDirectToolSelectors`); «холодный
кэш» относится к кэшу, который видит адаптер при загрузке, а без кэша лист
закрывается до сессии. Снять это можно только правкой upstream child-launch
(конфиг-override), что расширяет границу правок форка и требует решения человека.

Capability: `boundMcpConfig: { version: 1 }`.

Остаточный риск (не закрывается B1): `${VAR}` в конфиге раскрывается адаптером
из `process.env` при старте сервера; digest покрывает шаблон, не раскрытые значения.

## Инварианты (проверяются тестами)

- П1. Реальный Pi 0.87.1: лист с разрешённым набором доходит до faux-провайдера
  (≥ 1 запрос), круговой tool call — 2 запроса без ложного дрейфа; compaction,
  сужение реестра, неверный/неподдержанный контекст, отсутствие проверенного API
  → 0 запросов и именованный отказ.
- П2. Self-check различает transcript и форму `{ tools }`, свою и чужую копию pi-ai;
  capability без обоих полей отсутствует.
- П3. Bindings: свой session получает свои bindings/cwd; чужой, неопубликованный,
  снятый после shutdown/закрытия, неверно сформированный запрос → отказ;
  две параллельные записи не видят друг друга.
- П4. Shadowing: аттестованная замена → запуск допускается, terminal несёт
  декларации; чужая фабрика, неполная замена, отсутствие замены при built-in,
  неразрешённое имя, дрейф декларации → 0 запросов/отказ; без запроса shadowing
  поведение прежнее (регистрация built-in-имени — `package_mutation`).
- П5. MCP-конфиг: при разных cwd холодный и тёплый кэш дают полный набор;
  изменение байтов после preflight → `mcp_config_drift`; чужой глобальный и
  проектный конфиг не подмешиваются; без `mcpConfig` D10 действует.
- П6. Старый формат запроса и контракта без новых полей не меняется побайтно
  (golden `test/fixtures/bound/contract-v2.golden.json`).
