# Darwin source identity — pio 98

## Задача

> Подготовить план добавления macOS (Darwin) поддержки в backend source-identity,
> чтобы native-гейты onecpi на этой машине могли проходить: backend перестаёт
> отдавать штатный `sourceIdentityUnavailable` на macOS там, где identity
> установить можно.

Это этап планирования, не реализация. Владелец выбрал зависимую починку
pi-subagents и base `main`. Согласованный межрепозиторный контекст прочитан
командой `git -C /Users/kiriller/src/onecpi show c6386ee:docs/plans/onecpi-native-ping-fix.md`.
В нём B требует descriptor-relative проверки и отдельного согласования native
helper; A уже поставлен в onecpi `c6386eec0d119c8ef571d6a94d6d23431c781973`.
Этот план конкретизирует B, а не разрешает C/D (машинную поставку).

Рабочий checkout: `/Users/kiriller/src/pi-subagents.pio-pi-subagents-darwin-identity`.
`git status --short` перед работой пуст; `git branch --show-current` →
`pio/pi-subagents-darwin-identity`; `git rev-parse HEAD main` и
`git merge-base HEAD main` → `2d0dc6fa6825e6b2cd87e3fddc703b241c896176`.
Ссылки file:line ниже относятся к этому HEAD, кроме явно обозначенного onecpi.

## Вне рамок

Не устанавливать/обновлять пакеты, CLT/Xcode, общую Pi-установку,
`~/.pi/agent/...`, `~/.pio/adapters/onecpi-review.toml`. Не трогать worktree
`/Users/kiriller/src/onecpi.pio-onecpi-pio-child-runs` и чужие процессы.
Не менять pin onecpi, RPC-версии, lifecycle, runner, authority или public API.
Не добавлять v1 shim, CLI/subprocess fallback для native-ревью, npm identity
без Git или поддержку Windows. Не утверждать успешное native-ревью по одному
успешному resolver. Поставка и интеграция onecpi — отдельное решение владельца.

## Допущения, принятые без вопроса

- Реализация остаётся на базе `main`; обнаруженный разрыв bound v2 / onecpi v1
  не лечится возвратом старого протокола в этой задаче.
- Предлагается узкий C executable helper, а не Node addon/новый runner.
  Его исходник и проверяемый universal Darwin executable поставляются в Git
  вместе; это новый бинарный компонент, требующий явного согласования плана.
- Первый заявленный Darwin target — macOS 15+ на arm64 и x86_64, обычный Node
  runtime; обе архитектуры требуют реальных проверок до объявления поддержки.
  Непроверенный target остаётся unavailable, не получает оптимистический fallback.
- Сохраняются нынешние лимиты, reason-коды, digest, detached HEAD и строгая
  политика корня: alias/symlink пути не начинают молча приниматься.
- Пробы планирования доказывают только наличие Darwin-примитивов и старый отказ.
  Успех полной проверки, производительность и безопасность helper ещё предстоит
  доказать. Установка владельцем допускается лишь после отдельной интеграции.

## Устройство сейчас и доказательства

### Backend

`src/extension/source-identity.ts:7–25,49–56` задаёт identity v1:
`{version:1, kind:"git", repository, commit, digest}`; digest — SHA256
канонического JSON без самого digest. Это проекция проверенного commit, а не
самостоятельное доказательство дерева. Repository закреплён за fork itrous.

`source-identity.ts:271–277` до чтения корня отказывает любой не-Linux платформе
или Linux без `/proc/self/fd`: `{available:false, sourceIdentityUnavailable:
{version:1, reasonCode:"unverified_source"}}`.
Есть также Linux guards у доверенного Git (:114–125) и process probe (:128–142).
Команда `rg -n 'process.platform|/proc/self/fd' src/extension/source-identity.ts`
показывает эти guards и proc-path (:159–162); смены одного guard недостаточно.

`source-identity.ts:278–291` требует канонический, не symlink корень, обычный
package.json, `.git`, удерживает root FD. Initial Git probe (:73–111) выполняет
7 команд; final — 6 (контроль числа в :294,309). Проверяются top-level root,
detached HEAD, 40-hex commit, единственный допустимый remote, индекс и untracked
files; дерево берётся через `ls-tree -r -z --full-tree`. `parseMetadata` (:252–269)
не допускает attached HEAD даже при нужном commit. Git идёт по фиксированному
`/usr/bin/git`, с проверкой root-owned, non-writable-by-group/other компонентов,
закрытым env, без shell, без fsmonitor, global/system config и replace objects.

`verifyTree` (:188–242) разбирает NUL/raw-byte пути; открывает компоненты
от удержанных FD с O_NOFOLLOW/O_DIRECTORY/O_NONBLOCK через `/proc/self/fd`.
Проверяет обычный файл, executable bit, stat до/после чтения и Git blob SHA1
против HEAD. Tracked symlink/gitlink не удостоверяет. Namespace перепроверяется
после файла, после всего обхода и всё дерево повторно после final Git probe
(:317–326); root inode/dev перепроверяется перед выдачей. Git status сам по себе
не заменяет это доказательство (assume-unchanged, skip-worktree, filters).

Лимиты из :37–43: общий deadline 2000 ms, Git output 4 MiB, tracked content
64 MiB, path bytes 4 MiB, entries 20000, components 100000, depth 64.
`rg -n '^const (PROBE|TRACKED)_' src/extension/source-identity.ts` → 7 констант.
Не увеличивать их скрыто ради helper. `git ls-files -s | awk '{n++; if($1==120000
|| $1==160000)s++} END {print n,s+0}'` → 1163 entries, 0 symlink/gitlink.
Сумма `stat.size` по `git ls-files -z` → 14709859 bytes: текущий checkout
вмещается в content budget, но это не замер будущего binary и времени.

### Producer и важное отличие от установленного старого backend

На этой базе `src/bound/index.ts:87–98` выдаёт ровно одну из identity/unavailable
форм. При отказе capabilities пусты; `bound-runtime-service.ts:83–101` вызывает
настоящий resolver и закрывает preflight кодом `unverified_source`.
Однако наружный bound envelope/ping уже **v2** (`src/bound/channel.ts:5`,
`src/bound/index.ts:93,102`), identity внутри по-прежнему **v1**.
Upstream `src/extension/rpc.ts:441–470` отвечает на v1 без source identity и без
serverInstanceId. `test/unit/bound-onecpi-v1-compat.test.ts:85–142` специально
фиксирует malformed_ping у v1 клиента и отсутствие v2-ответа на v1-канале.

Следствие: исторический диагноз установленной копии из onecpi-плана верен,
но не описывает весь текущий `main`. Darwin backend здесь — необходимая,
**недостаточная** зависимость восстановления onecpi. Даже новый exact pin сам
по себе не адаптирует v1 client к v2. Нельзя обещать зелёный native-гейт после
одного обновления пакета; согласовать отдельную миграцию consumer до поставки.

### Контракт отказа

`SourceIdentityUnavailableReason` (:18–21) и
onecpi `c6386ee:src/lib/review/a1-readiness.ts:14–18` совпадают поэлементно:

`package_root_unavailable`, `package_root_symlink`, `package_manifest_unavailable`,
`not_git`, `git_timeout`, `git_failed`, `output_too_large`, `malformed_output`,
`wrong_root`, `dirty`, `attached_head`, `invalid_commit`, `wrong_remote`,
`unverified_source`.

Пересчёт: Node извлекает строки regex `/"([a-z_]+)"/g` из type после
`export type SourceIdentityUnavailableReason =` до `;`, а у consumer из первого
`Object.freeze([` до `])`; вывод `{producer:14,consumer:14,equal:true}`.
Положительный контроль — равенство списков; добавление `unknown` в consumer
даёт `equal:false`. Новые Darwin-коды в публичный договор не вводить.

В onecpi `a1-readiness.ts:219–245` допустимы только взаимоисключающие точные
формы. Штатный unavailable → `source_identity_unavailable`, diagnostics только
`reasonCode=...`. Обе формы, ни одной, неизвестная причина, лишнее поле,
**sourceIdentityUnavailable.version=2** → malformed_ping. Это именно вложенная
версия: внешний data.version=2 в иначе корректном v1 payload → unsupported_ping;
v2 envelope не проходит replyData. Не смешивать эти проверки с bound v2.
Доказательство: `git -C /Users/kiriller/src/onecpi show
c6386ee:src/lib/review/test.ts`, строки 5503–5530 (5 malformed fixtures), и
соответствующие предикаты consumer. Эти fixtures не разрешают переписать наш v2
producer в v1; межрепозиторный probe использует настоящий consumer, не старую
копию его предикатов из bound-onecpi-v1-compat.test.ts.

### Пробы на этой машине (до реализации)

`node -v` → v26.8.1; `uname -s` → Darwin; `/usr/bin/git --version` →
`git version 2.50.1 (Apple Git-155)`. lstat `/`, `/usr`, `/usr/bin`, `/usr/bin/git`
→ uid=0, mode=755, symlink=false. Это подтверждает кандидата Git на данной
машине, не переносимость на все macOS; runtime проверяет trust и работоспособность.

Прямой импорт `resolveActiveRuntimeSourceIdentity()` через `node --input-type=module`
→ `{"available":false,"sourceIdentityUnavailable":{"version":1,"reasonCode":"unverified_source"}}`.
Контроль `createSourceIdentity("a".repeat(40))` даёт identity/digest; это контроль
формы, **не успешный source proof**. `node --experimental-strip-types --test
 test/unit/source-identity.test.ts` → основной suite SKIP, дополнительный test
про отсутствие tracked symlink/gitlink pass=1, fail=0. Это не зелёный Darwin suite.
`rg -n 'process.platform' test/unit/source-identity.test.ts` → 5 мест:
внешний skip :46 и внутренние guards :127,247,263,293;
`rg '^\s*it\(' test/unit/source-identity.test.ts | wc -l` → 19 tests всего.

Изолированный C spike в собственном `.pio98-capability/` (после пробы удалён):
открыть root с O_DIRECTORY|O_NOFOLLOW; создать `regular` через openat; сравнить
fstat(file) и fstatat(root,"regular",AT_SYMLINK_NOFOLLOW); создать `link` через
symlinkat и открыть его с O_NOFOLLOW; попробовать `/dev/fd/<rootfd>/regular`.
Компиляция `/Library/Developer/CommandLineTools/usr/bin/clang -isysroot
/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk -Wall -Wextra probe.c -o probe`.
Без явного SDK первый запуск дал `fatal error: 'fcntl.h' file not found`;
с SDK — exit=0 и `openat_regular=1 same_inode=1 symlink_rejected=1 errno=62
 devfd_child=0 errno=2`. Обычный файл — положительный контроль отказа symlink.
Отдельно Node `openSync('/dev/fd/'+rootfd+'/package.json')` → ENOENT, при этом
обычное открытие root FD с нужными флагами успешно. Ничего не установлено.
Это доказывает механизм openat, но не полноценный verifier, race-safety или
пригодность `/dev/fd` для exec. F_GETPATH не даёт descriptor-relative обхода.

## Выбор механизма

| Вариант | Решение |
|---|---|
| Только разрешить Darwin guards, заменить `/proc/self/fd` на `/dev/fd` | Отвергнут: child-path probe выше не работает. |
| realpath + обычное чтение / git status / F_GETPATH + pathname | Отвергнут: теряется привязка каждого открытия к удержанному directory FD. |
| Python/ctypes, shell, ambient compiler в runtime | Отвергнут: новый непинованный runtime/trust input и не гарантированное наличие. |
| Node native addon | Возможен, но не выбран: in-process native failure и усложнение загрузки; нужен ограниченный verifier, а не расширение Node API. |
| Малый C subprocess helper с openat/fstatat | Выбран: OS primitives подтверждены, возможны жёсткий timeout и узкий binary protocol; нет shell/произвольной команды. |

Предлагаемый helper проверяет **дерево**, а metadata orchestration остаётся в
TypeScript. Linux сохраняет нынешний путь без запуска helper. Существующий
resolver/options API и identity wire schema не расширяются.

### Граница helper и доверия

- Родитель передаёт root directory FD как отдельный унаследованный descriptor,
  не путь из запроса/окружения, и bounded HEAD tree manifest из Git по pipe.
  Протокол закрытый и версионированный: размер, число записей, mode, blob hash,
  длина и raw bytes каждого относительного пути; никаких shell strings.
- Helper принимает только этот FD и manifest. Он повторяет семантику нынешнего
  verifyTree: открытие каждого компонента openat O_NOFOLLOW, fstatat с
  AT_SYMLINK_NOFOLLOW, bounded чтение фактически открытого regular file,
  executable bit и Git blob SHA1, stat/namespace rechecks, финальная сверка всех
  записей. Никакого Unicode roundtrip для имён и следования tracked symlink.
  Родитель вызывает verifier до и после final metadata, удерживая тот же root FD.
- Нынешние семь лимитов становятся общей границей всей операции, включая запуск
  helper; родитель передаёт оставшийся budget, сам ограничивает output/timeout и
  убивает process group. В C чтение порциями не превышает budget даже если файл
  растёт; не доверять declared size. Каждый pipe/input/output имеет верхний предел.
- Предлагаемые пути: `src/extension/source-identity-darwin.ts` (закрытый wrapper),
  `native/source-identity-darwin.c`, `native/source-identity-darwin` (universal
  executable), `scripts/build-source-identity-darwin.mjs` (явная release-сборка).
  Runtime не компилирует, не скачивает, не ищет helper на PATH и не принимает
  override из env. Нет npm install hook. SDK/compiler нужны только сборщику.
- Binary включается **в тот же Git commit** вместе с исходником и SHA256
  ожидаемых байтов в wrapper; build записывает compiler/SDK/target и проверяемое
  соответствие source→artifact. Binary не содержит commit, поэтому нет
  циклического self-hash. Проверка воспроизводимости сборки — gate поставки;
  при расхождении не обновлять hash «чтобы прошло».
- До exec wrapper открывает binary без symlink, проверяет regular/mode,
  bounded bytes, digest и stat до/после, затем исполняет проверенный snapshot
  в собственном private temp directory (0700, файл 0500). После завершения
  очищает только свои artifacts. Закрытый env исключает NODE_OPTIONS,
  DYLD_*, PATH overrides и preload; executable не запускает дочерние команды.
  Эта загрузочная цепь, как текущий TS resolver, опирается на доверие к уже
  загруженному pinned коду, не является защитой от злонамеренного same-UID
  процесса, способного менять память/код проверяющего. Обнаружимый случайный
  namespace/source drift остаётся обязательным отказом.
- Новый TS import включить в BOUND_LAYER_MODULES и тест closure. Нативные source,
  binary и build recipe включить в Git source proof; binary digest transitively
  закреплён в wrapper manifest. Не расширять wire manifest именами не-TS модулей.
  Сборка/pack должны явно переносить native assets (сейчас build-package.mjs:38–45
  переносит JS/static/directories, а src-glob в package.json files — src/**/*.ts).
  Packaged distribution без `.git` по-прежнему не удостоверяется как Git source.

Если spike полной границы требует другой поставки binary или расширения
публичного API, остановиться и согласовать изменение, а не заменить openat
path-based проверкой. Размер universal binary должен укладываться вместе с
деревом в 64 MiB, время — в текущий deadline. Компиляция helper сама по себе
не делает продукт доступным.

### Darwin Git и причины отказа

Разрешить доверенный `/usr/bin/git` на Darwin с теми же uid/mode/symlink
проверками компонентов; не использовать brew Git или xcrun discovery в runtime.
Оставить closed env/config/fsmonitor policy и process-group cleanup.
Отсутствие безопасного Git либо helper/ABI/host capability → `unverified_source`.
Безопасный Git, который не выполнил probe (например, CLT недоступен) → `git_failed`;
timeout всей операции → `git_timeout`, output/content/path/count overflow →
`output_too_large`, некорректный Git/helper protocol → `malformed_output`.
Ненулевой exit/crash helper без валидного результата → `unverified_source`.
Неправильные байты/mode/namespace tracked file → `dirty`, tracked symlink/gitlink
→ `unverified_source`; root replacement → `wrong_root`. Остальные существующие
metadata/root коды сохраняются. Внешний ответ всегда прежний tagged union,
без raw paths, stderr, env или новых reason-кодов. Никакого success при ошибке.

Canonical packageRoot остаётся строгим: лексический `/var/...`, если realpath
даёт `/private/var/...`, отклоняется как package_root_symlink; явный канонический
путь может пройти. Package-root symlink отклоняется и на Darwin, и на Linux.
Не переносить эту политику на cwd задания: речь именно о package source root.

## Инварианты (вход → наблюдаемое свойство)

I1. Поддержанный Darwin + чистый canonical detached Git checkout нужного fork
и рабочая host capability → available identity v1 с настоящим commit/digest;
прежний backend на том же Darwin → unavailable. Linux сохраняет результат.
I2. Неподтверждённый source/root/metadata, symlink, drift или неподдержанный host
→ отказ без оптимистического identity; дерево проверено через открытые объекты.
I3. Враждебные env/config, зависший процесс, malformed/oversized input или
растущий файл → закрытый bounded отказ; нет исполнения filters/preloads,
произвольных команд или оставшихся потомков.
I4. Resolver result → ровно одна неизменная identity/unavailable форма с прежним
reason enum; unavailable не открывает bound capability/preflight. onecpi
отличает штатный отказ от malformed, а несовместимый v1/v2 не становится ready.
I5. Alias packageRoot → прежний явный отказ; canonical путь к тому же checkout
проходит при остальных выполненных условиях, symlink не становится обходом.
I6. Отсутствующий/подменённый helper или непроверенный build/target → unavailable;
одобренный binary и чистый Git checkout работают без компилятора в runtime.
I7. Поставка владельцем только согласованной пары producer/consumer → exact pin,
detached source и настоящий native leaf; rollback возвращает прежнее поведение,
не затрагивая общую установку/чужие процессы в рамках этого этапа.

## Шаги после явного согласования

### A. Проверяемый Darwin backend — один реализационный landing

1. Зафиксировать исходный Darwin отказ, Linux baseline и fixture с detached HEAD,
   корректным origin и canonical temp root. Не снимать все skips вслепую.
2. Сделать узкий helper/wrapper/build recipe по указанной границе; доказать
   передачу root FD через spawn, binary integrity и namespace rechecks. Сперва
   изолированный spike; при невозможности безопасной загрузки/лимитов остановиться.
3. Подключить платформенный выбор resolver и Darwin trusted Git, не менять Linux
   алгоритм или публичный API. Использовать одни и те же metadata и reason mappings.
4. Обновить manifest closure, asset packaging и source-identity tests. Разнести
   platform-independent tests вне Linux suite; существующие filesystem/security
   cases исполнять на Linux и Darwin, платформенные детали процессов проверить
   отдельно. Добавить helper-negative tests и реальную Darwin integration без
   `resolveSourceIdentity` fixture. Обновить устаревший комментарий
   bound-runtime-service.ts:59, документировать target/необходимый Git checkout.
5. Выполнить матрицу I1–I6 на реальном Darwin arm64/x86_64 и Linux. Команды:
   `node --experimental-strip-types --test test/unit/source-identity.test.ts`,
   затем целевые `bound-channel.test.ts`, `bound-runtime-service.test.ts`,
   `bound-capability.test.ts`, `bound-layer-manifest.test.ts`,
   `bound-onecpi-v1-compat.test.ts` через тот же node runner;
   `npm run typecheck`, `npm run test:unit`, `npm run build:pkg` и проверка pack
   в собственном checkout после отдельно разрешённой локальной подготовки deps.
   Нынешний checkout без node_modules; зависимости в планировании не ставились.
6. Измерить cold/warm полный resolver на реальном checkout: wall time, timeout
   count, FD/process cleanup, размер дерева с binary. Положительный контроль —
   неизменное дерево проходит; drift/timeout controls отказывают. Не увеличивать
   deadline и не добавлять identity cache ради цифр. Если 2 s недостаточно —
   blocker/решение владельца, а не обход. После целевых тестов и обязательного
   review — обычный локальный коммит; следующий этап начинать с чистого дерева.

Результат A: доказанная source identity на заявленных Darwin targets, Linux
регрессии отсутствуют; это **не** заявление о работающем onecpi на текущем v1.

### B. Межрепозиторная приёмка и поставка — только рекомендации владельцу

До обновления установки согласовать consumer, понимающий текущий bound v2
(отдельная миграция, не shim здесь). Сверить не только ping, но и preflight,
receipt, runtime evidence/capability. Исторические v1 contract negatives
сохраняют назначение отрицательных контролей, а не спецификации нового producer.

Выбрать immutable commit A **после коммита**: branch name, package version и
само значение digest не заменяют exact commit pin. Обновление consumer pin/docs
и installer — отдельный onecpi landing; пересчитать активные pin references
перед правкой, не править исторические планы. В текущем onecpi pin
`c32663ec7e9f4c3c35456552c1d262eeeb845a60` (`a1-readiness.ts:13`), не main A.

Установленная копия по постановке не exact-pinned и attached; её здесь не
меняем и не делаем checkout поверх живых сессий. Рекомендация владельцу:
сохранить прежние refs/settings, подготовить отдельную чистую detached копию A
в canonical пути и отдельный Pi profile; проверить HEAD, отсутствие branch,
tracked/untracked drift, origin и реальные байты helper. Новая сессия должна
загрузить именно этот source и ровно одного responder. Сначала позитивный
изолированный onecpi native review-plan с Fleet/receipt/hash/revision evidence;
лишь потом отдельное разрешение на общую установку. Никакого reload/kill чужих
сессий и изменения adapter TOML. Не устанавливать CLT автоматически.

Критерий интеграционного успеха: реальный native leaf и закрытый review-plan,
`lensesFailed=0`, без adjudication.error, `gate.closed=true`,
`treeChanged=false`, `attestationFailed=false`, совпадающий subjectHash.
Новый sourceIdentityUnavailable или v1/v2 rejection — честный blocker, не успех.

## Таблица проверок (взаимно однозначно I1–I7)

| ID | Проверка и различающий контроль |
|---|---|
| I1 | На реальных Darwin targets старый backend отказывает, новый resolver в чистом detached fixture даёт точный HEAD/digest; на Linux тот же положительный fixture и suite проходят. Отдельно настоящий resolver → bound ping, без injected identity. |
| I2 | Dirty tracked/staged/untracked, assume-unchanged/skip-worktree, wrong origin, attached HEAD, invalid commit, symlink/gitlink, FIFO/mode, root/intermediate/file swap и изменение ранее прочитанного файла в final probe дают отказ; неизменный regular tree проходит. Проверить мутацию namespace после чтения и повторное чтение после metadata. |
| I3 | Унаследованные NODE_OPTIONS/DYLD/GIT/PATH, clean filter/fsmonitor markers не исполняются; timeout и уже завершившийся родитель не оставляют потомков. Oversized manifest/output/tree, растущий файл, malformed protocol отклоняются в общем budget; обычные small inputs проходят. |
| I4 | Пересчитать 14 producer/consumer причин; каждая штатная unavailable-форма распознана, capability/preflight закрыты. У onecpi c6386ee пять malformed fixtures выше плюс extra top-level field отвергнуты; wrong pin, malformed digest, 0 или 2 responder не дают ready, валидный pinned v1 fixture даёт ready. Внешний v2 не принимается старым consumer. Реальный v2 producer сохраняет свой exact key set. |
| I5 | Один fixture по canonical /private/var и alias /var: первый available при выполненных условиях, второй package_root_symlink; отдельный package-root symlink тоже отказ. Путь fixture сначала канонизировать, иначе тест успеха ложный. |
| I6 | Missing/truncated/wrong-hash/wrong-arch/symlink helper, crash и неизвестный protocol → отказ; нормальный tracked helper проходит. Повторная сборка подтверждает artifact, pack содержит его неизменные bytes/mode, runtime без compiler не пытается сборку/download. Dirty binary не может быть прикрыт прежним commit pin. |
| I7 | Только после разрешения владельца: совместимая pinned detached пара в изолированной новой сессии даёт реальный closed native gate; wrong pin, attached HEAD и старый v1 consumer служат отрицательными контролями. Возврат сохранённой пары возвращает старый отказ; повтор нового pin снова проходит. В текущем этапе git diff ограничен документом, машинная установка не меняется. |

Самосверка перед гейтом: 7 инвариантов ↔ 7 строк, без дополнительных обещаний
готовности native-гейта. Механические имена файлов/asset copying проверяются
компиляцией, closure/pack tests, а не создают рекурсивный гейт таблицы.

## Риски и откат

Главный риск — перепутать исправление source proof с восстановлением всего
native-контракта: текущая main уже не A1 v1. Второй — bootstrap доверия native
binary; запрещены скачанный непинованный helper и pathname-only проверка.
Другие риски: SDK/reproducibility/architecture, APFS case/Unicode/raw filenames,
различия stat precision, process-group cleanup, TOCTOU и цена двойного обхода.
Проверки race/byte limits/реального времени обязательны; отсутствие результатов
на одной архитектуре означает отсутствие её принятой поддержки.

Откат исходников: revert единственного реализационного landing A, либо возврат
предыдущего immutable source commit в отдельной установке решением владельца.
Откатывать consumer pin совместно с producer, сохранить настройки до поставки,
запустить новую собственную сессию. Это может вернуть ожидаемый unavailable,
а не зелёный гейт. Не выключать fail-closed и не добавлять fallback. Планирование
ничего не установило, поэтому сейчас откатывать машинную установку нечего.

## Открытые вопросы владельцу

1. Согласовать выбранный C helper, tracked universal binary и Darwin target
   macOS 15+ arm64/x86_64? Альтернатива — оставить unavailable и отдельно
   перепроектировать поставку helper; runtime compiler не подразумевается.
2. Подтвердить границу: main/backend здесь, миграция onecpi v1→bound v2 отдельно
   до установки? Иначе нужен новый план backport на согласованную v1-базу,
   а не молчаливая смена заданной base main.

Разрешение на общую установку этим согласованием не выдаётся.

## Гейт этого этапа

По прямому исключению пользователя — ровно один `onecpi_review`,
mode=review-plan, runs=2, adjudicate=true. При source identity/native ping
failure документ коммитится с пометкой о несостоявшемся гейте, статус
«нужен человек», владелец согласует непосредственно в сессии. Не обходить и не
повторять. При состоявшемся закрытом гейте — коммит и «ждёт согласования».
### Фактический исход единственной попытки

Run `20260921-192457-aa20ee`, mode=review-plan, runs=2, adjudicate=true.
Все четыре линзы завершились `native_malformed_ping` (high-маршруты исчерпали
цепочку с той же ошибкой). `lensesTotal=4`, `lensesFailed=4`, `gate.closed=false`,
`gate.nextAction=rerun`, `scope.truncated=false`. Оператор `notNeeded=true`:
отсутствие кандидатов при отказе всех линз не является положительным ревью.
Круг **не состоялся**, ни одна линза не проверила замысел.

- `subjectHash` попытки:
  `3d2618d33d1d1f3be6ee25ff80f81be850c57781df6ffdbb44e6a109b4f134c5`.
  Сразу после вызова `shasum -a 256` дал ровно это значение.
- `revision.head`: `2d0dc6fa6825e6b2cd87e3fddc703b241c896176`.
- `revision.tree`: `fa226557bbd694031500db4420c96bb0b401fc247f3a65f79937b1e339058d87`.
- Initial/final attestation=ok; `treeChanged=false`, `attestationFailed=false`,
  `subjectDrifted=false`, `routingDrifted=false`.
- Отчёт: `/Users/kiriller/.local/state/onecpi/reviews/pi-subagents.pio-pi-subagents-darwin-identity-776cbf3da4c4/20260921-192457-aa20ee/report.json`;
  рядом stderr/usage artifacts.

Это ожидаемое воспроизведение **native-ping блокера**, предусмотренного особым
порядком пользователя. Реальный исход именно malformed, не
`source_identity_unavailable`; сырой payload инструмент не показал. Не
приписываем этот конкретный ping только Darwin guard: на текущем main отдельно
доказана несовместимость v1/v2. Прямой resolver probe выше независимо
воспроизводит Darwin `unverified_source`.

Гейт **не мог пройти**; автоматическое указание rerun не исполнялось согласно
запрету пользователя на повтор/обход. Документ коммитится с явной пометкой
о несостоявшемся native-гейте. Этот evidence-раздел добавлен после попытки по
прямому исключению: финальные байты отличаются от subjectHash попытки и не
выдаются за проверенные линзами. Финальный SHA256 сообщается отдельно при выдаче.
Статус — **нужен человек**, владелец согласует документ в этой сессии.
Реализация не начиналась; машинные установки и чужие процессы не менялись.
