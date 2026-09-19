# A1R.0 — спайки: итог

План: `PLAN-A1R-inprocess-upstream-migration.md`, раздел «A1R.0». Дата: 2026-09-20.
Среда: Pi 0.85.1 (`/opt/homebrew/Cellar/pi-coding-agent/0.85.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent`),
node v26.8.1, upstream pi-subagents `8bd275bb`, jiti 2.7.0 из Pi, pi-mcp-adapter 2.34.0
(установлен в `~/.pi`) и 2.26.1 (из `onecpi/node_modules`, только чтение) — С3 прогнан на обеих.

Изоляция всех прогонов: throwaway `HOME`/`PI_CODING_AGENT_DIR`, faux-провайдер
`openai-completions` SSE на `127.0.0.1:<порт 0>` со счётчиком запросов, без внешней сети
(`externalFetches=[]`), `~/.pi` и репозитории не изменялись. Хост-скрипты повторяют upstream
`child-session.ts` `open()`: `DefaultResourceLoader` → `loaded=true` → `reload()` →
`resolveCliModel` → `createAgentSession` → `bindExtensions({mode:"print"})` → `prompt()`.

Артефакты (скрипты, фикстуры, сырые выводы): `spikes/A1R.0/{c1c2,c3c4,c5c6}`. Каталоги
throwaway (`home`, `agent`, `runs`, `ws`, `work`) не сохранены; фикстуры содержат абсолютные
пути исходного scratch-каталога — для повтора задать `D` на копию и пересоздать `home`/`agent`.

## Сводка

| Спайк | Вердикт | Гейт плана |
|---|---|---|
| С1 барьер до провайдера | **ПОДТВЕРЖДЕНО** (оговорка: compaction) | пройден — остановки нет |
| С2 реестр со стороны хоста | ЧАСТИЧНО: `getActiveToolNames()` — да, `getAllTools()` — нет | корректировка A1R.4 |
| С3 MCP-адаптер in-process | ЧАСТИЧНО: окно `reload()→bindExtensions()` — да; узкое окно загрузки — нет | Р11 не требуется |
| С4 cwd и привязки | **ПОДТВЕРЖДЕНО**; чтение env в `execute` — ОПРОВЕРГНУТО | корректировка A1R.4/A1R.6 |
| С5 отмена | ЧАСТИЧНО | факты для Р6, Р4 |
| С6 сдерживание импорта | ЧАСТИЧНО: гигиена, не граница | факты для Р4; ослабить строку 210 плана |

## С1. Барьер до провайдера — ПОДТВЕРЖДЕНО

Обёртка `session.agent.streamFunction` (самопроверка `typeof === "function"`; приём как у
upstream `pinChildCacheRetention`, `src/shared/child-cache-retention.ts:33`).
Воспроизведение: `cd spikes/A1R.0/c1c2 && env HOME=$D/home PI_CODING_AGENT_DIR=$D/agent PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 node c1.mjs` → `C1 SUMMARY: 14/14 PASS`.

- Расхождение набора → `requests:0`, `stopReason:"error"`, без автоповтора даже при retry по умолчанию.
- Контроль: без обёртки `requests:1`; при совпадении набора `requests:1`, `stop`.
- Ловит сдвиг набора в `before_agent_start` (расширение и сужение) и посреди прогона из `execute`.
- Обёртка переживает turn, повторный `prompt()`, `setModel` (Pi больше нигде не присваивает поле: `pi-agent-core/dist/agent.js:119`; читается на старте прогона `:272,:277`).
- Факты: исключение в `before_provider_request` (A7) и в `agent_start` (A9) проглатывается — upstream-диагностика `requiredTools` (`subagent-prompt-runtime.ts:485-487`) **не блокирует**.
- Хрупкость: `compact()`/branch summary идут через тот же `streamFunction` с пустым `tools` (`agent-session.js:1453,2551`) — барьер их блокирует (A8); `prompt()` не отклоняется — ошибка только в последнем assistant-сообщении (`agent.js:326-360`).

## С2. Реестр со стороны хоста — ЧАСТИЧНО

`node c2.mjs` → `C2 SUMMARY: 5/5 PASS`.
- `getActiveToolNames()` после `bindExtensions` = `context.tools` первого вызова = то, что видел сервер.
- `getAllTools()` ≠ (содержит неактивные builtins `find,grep,ls,powershell`) — не годится как эталон; это же касается upstream `requiredTools`.
- Регистрация в `session_start` расхождения не даёт: событие эмитится внутри `bindExtensions` (`agent-session.js:1926`). Регистрация в `before_agent_start` обнаружима только сравнением в момент вызова модели (барьер С1). Allowlist отсекает добавление, но не сужение.

## С3. pi-mcp-adapter in-process — ЧАСТИЧНО

`cd spikes/A1R.0/c3c4 && ./run-c3.sh && ./summarize-c3.sh` (14 прогонов: окно none/load/bind × кэш cold/warm/stale × env родителя).
- Окно `bind` (от `reload()` до конца `bindExtensions()`, как upstream `child-session.ts:185,288`): ровно `fx_alpha,fx_gamma` во всех состояниях кэша, в т.ч. при чужом `MCP_DIRECT_TOOLS` родителя.
- Окно `load` (только фабрики): при устаревшем кэше — только `mcp` (**опровергнуто**).
- Во всех 14: `process.env` после окна побайтно равен исходному; MCP-процессы после `dispose()` → 0.
- Контроль без окна: только `mcp`, `fx_alpha` → «Tool fx_alpha not found».
- Поздние чтения вне окна: ленивый init при валидном кэше (`init.ts:438`, на первом prompt) и spawn stdio-сервера копирует весь `process.env` родителя (`server-manager.ts:1817-1829`). Набор direct-инструментов не меняется (захвачен фабрикой, `index.ts:318`), но env MCP-процесса — родительский. Адаптер ищет проектный конфиг по `process.cwd()` (`index.ts:107,314-316,1006`).
- Версии: матрица из 14 прогонов совпала на 2.34.0 и 2.26.1 (`C3_ADAPTER=… ./run-c3-v2261.sh && ./summarize-c3-any.sh v2261-`, выводы `out/v2261-c3-*`).
  Строки: 2.26.1 — `index.ts:123`, `init.ts:374`, `server-manager.ts:1233` (как в плане); 2.34.0 — `:318`, `:438`, `:1825`.
  Отличие: в 2.26.1 init не откладывается и при валидном кэше (чтение `init.ts:374` внутри окна `bind`); MCP-сервер в обеих версиях стартует лениво с env родителя (`bind-warm-penv` получил `fx/beta,fx/delta`).

## С4. cwd и привязки — ПОДТВЕРЖДЕНО

`./run-c4.sh && cat out/c4.json` — две параллельные сессии, перекрытие 397 мс.
- `ctx.cwd` своей сессии; встроенный `read("hello.txt")` → `CONTENT-A` / `CONTENT-B`.
- Контроль: `process.cwd()` = cwd родителя в обеих.
- Привязки своей сессии видны через: `Map<sessionId, bindings>` (ключ `ctx.sessionManager.getSessionId()`), замыкание inline-фабрики, env, захваченный фабрикой в окне.
- **ОПРОВЕРГНУТО**: чтение env внутри `execute` → `null` (текущий шаблон onecpi `review-read/index.ts:25-27`, `git-read/index.ts:74`).
- Upstream in-process доставки привязок для foreground нет: `PI_SUBAGENT_EXTENSION_BINDINGS` только при `host==="runner"` (`child-launch.ts:162-170,322`).
- Сброс кэша фабрик даёт каждому ребёнку свой экземпляр модуля (`resource-loader.js:265-266`).

## С5. Отмена — ЧАСТИЧНО

`cd spikes/A1R.0/c5c6 && node c5-host.mjs {ignore|respect} [--hang-shutdown]`, `node c5-sync-wrapper.mjs`.
Отмена как upstream `execution.ts`: `void abort()` → жёсткий таймер 3000 мс → `dispose()` (гонка `session_shutdown` с 5000 мс).

| Свойство | Результат |
|---|---|
| `abort()` быстро при инструменте, игнорирующем сигнал | ОПРОВЕРГНУТО: 8538 мс = до конца инструмента (в общем случае без предела) |
| `prompt()` рассчитывается после `abort()` | ОПРОВЕРГНУТО: вместе с `abort()`, `{ok:true}` + `stopReason=error` |
| `dispose()` ≤ 5 с | ПОДТВЕРЖДЕНО: 1 мс / 5001 мс с зависшим `session_shutdown` — только за счёт обёртки upstream; Pi `dispose()` синхронный |
| Инструмент прекращает работу после `dispose()` | ОПРОВЕРГНУТО: отметки 5..10 записаны после |
| Подпроцесс инструмента завершён | ОПРОВЕРГНУТО: `sleep 30` жив |
| События после `dispose()` | `session.subscribe` — не получает; `agent.subscribe` — 9 событий |
| Контроль (уважает сигнал) | ПОДТВЕРЖДЕНО: 4–10 мс, `spawn({signal})` убивает `sleep` |
| Синхронный цикл вешает родителя | ПОДТВЕРЖДЕНО: ни одного heartbeat, SIGTERM не сработал, только SIGKILL |

Код: `agent-session.js:1222-1228` (`abort` = `agent.abort()` + `waitForIdle()`), `:584-599` (`dispose` синхронный),
`agent-loop.js:460-464` (`await tool.execute` без гонки с сигналом).

## С6. Сдерживание импорта — ЧАСТИЧНО

`./c6-run-isolated.sh` → `out-c6-isolated.txt`. Отдельный экземпляр jiti на случай, проверка корня в `transform`, опционально пролог, подменяющий `require`/`jitiImport`.
- Глобальные `Module._resolveFilename`, `_load`, `_extensions['.js']` не изменены — ПОДТВЕРЖДЕНО.
- `transform` блокирует транспилируемые выходы: `../outside.ts`, `.js` с ESM, абсолютный путь, симлинк, `import()` таких файлов.
- Не блокирует нетранспилируемое (`.mjs`, `.cjs`, `.js` без ESM, вход `.mjs`): jiti отдаёт их нативному загрузчику, `transform` не вызывается.
- Пролог закрывает `.mjs`/`.cjs` из транспилированного кода, но не цепочку внутри нативного `.cjs`.
- Не ловятся ни в каком варианте: `createRequire`, `module.constructor._load`, `fs` + `new Function`. **Не граница безопасности.**
- Pi грузит `extensionPaths` своим jiti без проверок (`extensions/loader.js:416`) — сдерживание возможно только для фабрик, которые хост грузит сам и передаёт через `extensionFactories`.
- `moduleCache:false` не изолирует нативный `require.cache`.

## Следствия для плана

**Решения человека**
- Р3: для дрейфа реестра / `context.tools` гарантия «0 запросов» достижима (С1). Остаётся открытым только дрейф, видимый лишь в payload.
- Р4: изоляции нет вообще: код пакета читает ключ HMAC из памяти, синхронный цикл вешает родителя и соседей (С5, С6). Внутри процесса не лечится; альтернатива — Р1 (runner-процесс).
- Р6: «сессия утилизирована» ≠ «работа остановлена»: инструмент продолжает писать на диск, подпроцессы живут; остановку даёт только дисциплина `signal` в инструментах.
- Р11: не требуется при окне `bind` (С3; адаптер 2.26.1 и 2.34.0).

**A1R.3 / A1R.4**
1. Барьер — на `session.agent.streamFunction` после `bindExtensions`, до первого `prompt()` (рядом с `pinChildCacheRetention`, `child-session.ts:330`). `before_provider_request`/`agent_start` барьером быть не могут.
2. Эталон набора — `getActiveToolNames()` после bind или allowlist агента; не `getAllTools()`.
3. Явное правило для вызовов без инструментов (compaction, branch summary) или запрет compaction у bound-детей.
4. Хост сам превращает ошибку барьера в провал запуска (разбор последнего assistant-сообщения); текст ошибки не совпадает с retry-паттернами Pi.
5. Отмена: не ждать `prompt()` после `abort()`; `void abort()` → жёсткий таймер → `dispose()`; ограничить по времени `abort` в `factory.dispose()` (upstream `child-session.ts:389` ждёт детей — вывод из замеров, отдельно не запускался).
6. Ретрансляция событий — только через `session.subscribe` с отпиской на `dispose()`.
7. Окно env — `reload()→bindExtensions()` с восстановлением после (в upstream восстановления нет, `child-session.ts:~201`).
8. Привязки — реестр хоста `sessionId→bindings` (заполнять до `reload()`, удалять на `dispose()` — последнее не проверено) или замыкание inline-фабрики.
9. Импорт: `transform` + пролог; нативные входы и `.mjs`/`.cjs`/`type:module` в дереве пакета запрещать при аттестации. Строку 210 плана ослабить до «гигиенической проверки графа транспилируемых модулей»; реальная гарантия — digest байтов пакета.
10. Внутренние поля Pi (`Agent.streamFunction`, `AgentSession.agent`, `DefaultResourceLoader.loaded`) — самопроверка при старте и регрессионные тесты при обновлении Pi.

**A1R.6 (onecpi)**
- `review-read`, `git-read`, `review-workspace` перевести на `ctx.cwd` и привязки по id сессии; `process.env`/`process.cwd()` в `execute` вернут значения родителя.

**Кандидаты в upstream**
- `requiredTools`-диагностика не блокирует (исключение в `agent_start` проглатывается).
- Восстановление `process.env` после окна загрузки ребёнка.
- In-process доставка `extensionBindings` foreground-детям.
