# A1R.2 — малые переносы и сверка MCP: решение по каждому файлу

Этап плана: `PLAN-A1R-inprocess-upstream-migration.md`, раздел «A1R.2». База A1R.1 —
upstream `8bd275bba0dc13273eff366e348378d41ad5535e`.

Перечень построен машинно, не вручную:
`git diff --name-only --diff-filter=M 2c2db5b8 main`, отфильтрованный по
`git cat-file -e "<база>:<путь>"` — 42 файла из 46 (4 удалены или переименованы
upstream и разобраны в A1R.1). Каждая строка несёт решение:

- **(а)** upstream уже покрывает → не переносим;
- **(б)** нужно только bound-слою → реализуем в модуле форка на A1R.3/A1R.4;
- **(в)** общее исправление → минимальный участок в upstream-файле (точки Т4–Т7) плюс
  кандидат PR в upstream;
- **отложено** / **уходит** — возвращается вместе со своим этапом либо исчезает вместе
  с процессной моделью A1.

## Итог

- Перенесено сейчас: **4 файла upstream** (`permissions.ts`, `agent-memory.ts`,
  `long-running-guard.ts`, `jsonl-writer.ts`) — ровно бюджет Т4–Т7 — плюс 3 файла
  upstream-тестов, покрывающих эти же переносы.
- Проверки: `npm run typecheck` зелёный; `LC_ALL=C npm run test:unit` — 3338 прошли,
  0 упали; `LC_ALL=C npm run test:integration` — 1072 прошли, 0 упали.
- Кандидаты PR в upstream (Р10, пункт «малые исправления»): все четыре (в).

## Дифференциальная сверка MCP (И6, exact-ten)

Фикстура: два сервера (`bsl-ws`, `bsl-ref`), кэш метаданных и конфиг в throwaway
`PI_CODING_AGENT_DIR`; селекторы — реальные 10 пар onecpi
(`src/lib/review/onec-tools.ts: ONEC_TOOL_PAIRS`).

| Прогон | Версия форка (`main`) | База upstream | Совпало |
|---|---|---|---|
| 10 селекторов | 10 имён (`bsl-ws_search` … `bsl-ref_its_help`) | те же 10 | да |
| контроль: без `bsl-ws/event_log` | 9 | 9 | да |

Вывод: правки форка в `mcp-direct-tool-allowlist.ts` для exact-ten не нужны — (а).
Скрипт сверки: `spikes/A1R.2/mcp-diff.mjs`.

## Таблица решений

| Файл | Решение | Основание |
|---|---|---|
| `README.md` | (а) | форковые заметки заменены разделом статуса в `FORK.md` |
| `install.mjs` | (а) | установщик форка удалён в A1R.1; используется upstream-версия и `pi install git:…@<sha>` |
| `package.json` | (а) | URL-ы форка и `src/**/*.cjs` в `files` были нужны удалённому установщику и `bound-tool-registry-state.cjs`; вернуться к вопросу в A1R.7 (публикация) |
| `src/agents/agent-memory.ts` | (в) | `WRITE_TOOLS` включает powershell. Перенесено, Т5 |
| `src/agents/agents.ts` | отложено | обнаружение package-агентов и `package:`-ссылок — bound-резолвер A1R.3 |
| `src/agents/skills.ts` | отложено | то же для skills — A1R.3 |
| `src/api/delegation.ts` | отложено | типы bound-контракта v2 — A1R.3 |
| `src/extension/index.ts` | отложено | точка Т1 (регистрация bound-модуля) — A1R.3 |
| `src/extension/rpc.ts` | отложено | точка Т3 (приватность bound-прогонов) — A1R.3/A1R.4; сам протокол уходит на канал `subagents:bound:v2:*` |
| `src/runs/background/subagent-runner.ts` | (а) | единственная правка — вызов `isPotentialMutationToolCall`; следует за (а) по `completion-guard.ts` |
| `src/runs/foreground/execution.ts` | отложено | запуск листа отдельным процессом — уходит; bound-исполнение через декоратор фабрики (Т2) в A1R.4 |
| `src/runs/foreground/foreground-history.ts` | отложено | приватная проекция Fleet — A1R.4 |
| `src/runs/foreground/subagent-executor.ts` | отложено | точка Т2 — A1R.4 |
| `src/runs/shared/completion-guard.ts` | (а) | upstream закрывает иначе: незнакомый инструмент немутирующий, состав объявляется через `mutationTools` (`hasMutationToolCall(messages, mutationTools)`). Консервативное умолчание форка противоречит upstream-тесту «declared extension mutation tools count without weakening unknown tools» — не переносится; bound-слой в A1R.4 объявляет свои `mutationTools` явно |
| `src/runs/shared/long-running-guard.ts` | (в) | непустой вызов powershell считается мутирующим. Перенесено, Т6 |
| `src/runs/shared/mcp-direct-tool-allowlist.ts` | (а) | дифференциальная сверка на 10 селекторах onecpi (`bsl-ws/*` ×7, `bsl-ref/*` ×3): версия форка и база дают одинаковые 10 имён; контроль без `bsl-ws/event_log` — 9 и 9. Расширения форка (`toolPrefix`, `disabled`, `uiVisibility`, префикс `mcp__`, `read_`) для И6 не нужны |
| `src/runs/shared/permissions.ts` | (в) | powershell как bash: правило пользователя не переопределяет, решение `allow` (A1P3 пп.3-4). Перенесено, Т4 |
| `src/runs/shared/spawn-budget.ts` | уходит | бюджет spawn дочерних процессов — процессная модель A1 |
| `src/runs/shared/subagent-prompt-runtime.ts` | (б) | кадры отказов — коллектор bound-слоя на inline-хуке `tool_call` (A1R.4) |
| `src/runs/shared/tool-availability.ts` | (б) | `CORE_RUNTIME_OWNED_TOOLS` применяет bound-резолвер (A1R.3), upstream-файл не правится |
| `src/shared/jsonl-writer.ts` | (в) | ошибка потока во время `close()` разрешает ожидание — без этого close висит вечно. Перенесено, Т7 |
| `src/shared/launch-contract.ts` | отложено | поля контракта v2 — A1R.3 |
| `src/shared/model-info.ts` | (б) | `baseUrl` нужен только digest'у реестра моделей — считать в модуле форка из `ctx.modelRegistry` (A1R.3) |
| `src/shared/types.ts` | отложено | типы bound-слоя — A1R.3 |
| `src/slash/delegation-adapters.ts` | отложено | native-статусы и proof — A1R.4 |
| `src/slash/delegation-json.ts` | (б) | upstream-версия не отвергает Proxy (в форке был `isProxy → throw`). Строгий клон восстановить в модуле форка до подключения bound-слоя — пункт 10 чек-листа A1R.3; зафиксировано в `FORK.md` |
| `src/slash/delegation-request.ts` | отложено | fail-closed разбор запроса v2 — A1R.3 |
| `src/slash/prompt-template-bridge.ts` | отложено | admission/coordinator/targeted cancel — A1R.3 на своём канале |
| `src/slash/slash-bridge.ts` | (б) | `activate`/`stop` нужны жизненному циклу bound-канала — в модуле форка A1R.3; проверяется lifecycle-тестом A1R.4 |
| `test/fixtures/pi-coding-agent-shim/index.mjs` | отложено | шим дочернего процесса — уходит |
| `test/support/mock-pi.ts` | отложено | заглушка дочернего процесса pi — уходит вместе с процессной моделью |
| `test/unit/agent-memory.test.ts` | (в) | кейс powershell добавлен |
| `test/unit/completion-guard.test.ts` | (а) | следует за решением по `completion-guard.ts` |
| `test/unit/delegation-api.test.ts` | отложено | возвращается с контрактом v2 (A1R.3) |
| `test/unit/fleet.test.ts` | отложено | возвращается с приватной проекцией Fleet (A1R.4) |
| `test/unit/index-child-registration.test.ts` | отложено | возвращается с регистрацией bound-модуля (A1R.3) |
| `test/unit/jsonl-writer.test.ts` | (в) | добавлен `error` в MockStream и тест расчёта close при ошибке |
| `test/unit/permissions.test.ts` | (в) | два powershell-кейса добавлены в тесты базы |
| `test/unit/prompt-template-bridge.test.ts` | отложено | возвращается с каналом v2 (A1R.3) |
| `test/unit/rpc.test.ts` | отложено | возвращается с ping/preflight v2 (A1R.3) |
| `test/unit/slash-bridge.test.ts` | отложено | возвращается с lifecycle моста (A1R.3) |
| `test/unit/spawn-budget.test.ts` | отложено | уходит вместе со `spawn-budget.ts` |
