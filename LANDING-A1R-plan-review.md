# A1R — ревью замысла плана и чек-лист исполнителя

План: `PLAN-A1R-inprocess-upstream-migration.md`. Ревьюер: onecpi `review.mjs --review-plan --adjudicate`,
ledger `.git/onecpi/review-ledger/f97612b18e98ad9de92048121e55b4bd9d1a372158fe31e6c61728cca07cea50.json`.

| Круг | Прогон | Предмет (sha256 плана) | Итог |
|---|---|---|---|
| 1 | `20260919-182134-774f0d` | `4d834e31…` | закрыт, blocking 0 |
| 2 (после решений Р1–Р11 и A1R.0) | `20260919-205415-06b7bf` | `174b3ff9…` | закрыт, blocking 0; 4 mid исправлены заменой в плане |
| 3 (финальный) | `20260919-210802-e6fe41` | `b979dcc56d4eb2fd567aa327a74458bcf5a8463cc28fcc433923fac34308782f` | **закрыт**, critical 0, high 0, effective blocking 0; mid 7, low 2 → чек-лист ниже |

Замечания mid/low финального круга по протоколу не переписывают план (хеш проверенного
предмета сохраняется) и обязательны для исполнителя соответствующего этапа.

## Ревью замысла `PLAN-A1R.3-control-plane-v2.md`

| Круг | Прогон | Предмет | Итог |
|---|---|---|---|
| 1 (общий, `--runs 2`) | `20260920-054801-e44d03` | `443fdafc…` | закрыт; 9 mid разобраны |
| 2 (общий) | `20260920-060957-170133` | `6384efc4…` | НЕ закрыт: high — остановка `session_shutdown` только для bound-детей |
| 3 (общий) | `20260920-063101-7d133c` | `8052e009…` | НЕ закрыт: high — обёртка фабрики рвала detached-детей |
| 4 (целевой) | `20260920-065052-b7a01c` | `6bd3323e…` | закрыт; 3 mid + 2 low |
| 5 (целевой, контрольный) | `20260920-071032-c18cae` | `10e8d25d9e076339840c965397c492f00f173dd474c5b35ee976c02b24b7c055` | **закрыт**, blocking 0, `nextAction: ready` |

### Чек-лист исполнителя A1R.3 (непогашенные mid/low, нового круга не требуют)
1. Строки таблицы проверок И3.3 и И3.10 указывают на `bound-channel.test.ts`/`bound-launch-bridge.test.ts`, а сценарий смены поколения лежит в `bound-registration.test.ts` — привязать указатели к фактическим файлам.
2. Добавить тест обработчика `session_shutdown` bound-слоя: живые попытки отменяются и получают свои терминалы.
3. Расширить `bound-preflight-no-side-effects.test.ts` снимком `process.env` до/после и шпионом на обращения к провайдеру.

## Чек-лист исполнителя

### A1R.1
1. **Шаг 1** выполнять в task worktree после шага 2 (или `git status --porcelain --untracked-files=no`
   в основном checkout): основной checkout содержит неотслеживаемые артефакты A1R.
2. **Шаг 6**: ожидание «8 файлов» неверно. Проба (только чтение): на дереве `$U` шаблон
   `pi-args|bound-tool-registry-runtime|pi-command-evidence|install-lib` по `test` → 0 файлов,
   поэтому нетронутые upstream-тесты шаг 6 не удаляет (опасение линзы опровергнуто). На `main`
   совпадают 12 путей, отсутствующих в `$U`: `bound-tool-registry-installed`, `fork-installer`,
   `single-execution` (integration), 3 файла `test/probes/` + `README-package-projection.md`,
   unit: `active-bound-package-extensions`, `bound-tool-registry-runtime`,
   `capability-ceiling-pi-args`, `pi-args-permission-system`, `pi-args`, `pi-command-evidence`.
   Выполнять grep по рабочему дереву после шагов 4–5 и `git rm` только путей, которых нет в `$U`.
3. **Шаг 7**: откладывается не 2, а не меньше 5 кандидатов. Кроме `tool-registry-proof` и
   `denied-tool-proof` typecheck не пройдут `active-bound-preflight` (`SubagentDelegationTurnBudget`),
   `active-bound-package-extensions` (`ActiveBoundPackageIdentity`),
   `bound-pending-cancellation-registry` (`SubagentDelegationBindingV1`) — этих типов нет в
   upstream `agents.ts`/`delegation.ts`. Перечень «отложено» в сообщении коммита — полный.

### A1R.2
4. **Полнота перечня**: проверка — не только «число строк = числу файлов», но и что каждая строка
   несёт одно из (а)/(б)/(в)/«уходит вместе с процессной моделью A1» и ссылку на hunk; строка без
   решения — провал.
5. **Площадь правок (И7, бюджет ≤ 4)**: мера `--diff-filter=MD $U HEAD` считает и тесты/конфиги.
   Перенос powershell-семантики тянет 3 src + 3 upstream-теста. В `LANDING-A1R.2-carries.md`
   считать отдельно src-точки (Т4–Т7) и сопутствующие правки upstream-тестов; сопутствующие
   тесты перечислить явно как ожидаемые конфликты синхронизаций (И8 «без правок
   upstream-тестов» к ним не применяется — это тесты переносимого исправления).

### A1R.3 (в `PLAN-A1R.3-*`) — из ревью A1R.1 (`20260919-215443-2c2f15`, low, подтверждены)
10. **Строгий клон JSON вернуть до подключения.** Upstream `delegation-json.ts` не
    отвергает Proxy (в форке было `utilTypes.isProxy(...) → throw`). Проверено:
    `cloneJsonWithinByteLimit(proxy, 16*1024)` → `{ok:true,value:{}}` и 2 сработавших
    трапа вместо `{ok:false,reason:"invalid"}` без трапов. `src/api/launch-receipt.ts`
    (:92, :125) проверяет этим вызовом недоверенные receipt/token — восстановить
    строгий клон в модуле форка (или PR в upstream) до подключения bound-слоя, вернуть
    регрессионный тест `delegation-json`.
11. **Тест `active-bound-environment` вернуть вместе с подключением модуля** (удалён в
    A1R.1 вместе с `active-bound-runtime`; сейчас парсер env-имён без покрытия).

6. **И11**: снимок ФС не ловит «не создаёт сессий» — добавить проверку, что после preflight нет
   новой сессии/зарегистрированных обработчиков.

### A1R.4 (в `PLAN-A1R.4-*`)
7. **MCP и `process.cwd()`**: `pi-mcp-adapter` ищет проектный конфиг по `process.cwd()`
   (С3: 2.34.0 `index.ts:107,314-316,1006`), а in-process это cwd родителя; у onecpi есть
   проектный пример `.pi/bsl.json.example`. Установить, откуда 1С-лист получает конфиг MCP
   (глобальный/agent-dir против проектного), и добавить пробу С3 с cwd родителя ≠ bound cwd;
   И6 exact-ten от этого зависит. При проектном конфиге — отдельное решение до реализации.
8. **И9**: добавить отрицательную канарейку — отключённый proof-коллектор (реестр или отказы) →
   capability не объявляется.

### Документ
9. Отсылка в «Допущениях» к «Открытым решениям» — исторический текст: открытых развилок уровня
   зонтичного плана нет; развилки следующих этапов («(в) или (б) по решению A1R.3», своя фабрика
   на `createAgentSession` или точка доступа внутри Т2, временные точки в лимите Т4–Т7)
   решаются в `PLAN-A1R.3-*`/`PLAN-A1R.4-*`.
