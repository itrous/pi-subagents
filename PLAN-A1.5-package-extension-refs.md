# A1.5: package-owned extension references

## Граница

Только package-agent discovery/extension refs после A1.1–A1.4; wire и execution —
один commit. Registry/cancellation/installer/full probe остаются далее.

## Контракт

Active-bound по-прежнему не принимает extension paths/refs от runtime caller.
Refs принадлежат выбранному agent definition. Разрешены:

1. `./relative/path.ts` в `subagentOnlyExtensions` package agent — относительно
   каталога agent definition;
2. `package:<module>` в `subagentOnlyExtensions` package agent — logical ref на
   dependency owner package.

`extensions`, абсолютные/bare/parent-traversal paths, refs project/user/builtin
agents и path-like entries в `tools` остаются запрещены. Negative owner/field
matrix отдельно фиксирует: package `extensions`, project/user/builtin
`subagentOnlyExtensions`, project `package:*` и package absolute/traversal ref. Ambient/default
extensions отключены. Для package agent сохраняются требования A1: fresh,
foreground, exact model, no fallback/context/memory/output/intercom.

## Restricted package discovery

Resolver не использует opportunistic global/npm/node_modules scan. Он читает
только bounded active Pi registry:

- regular non-symlink user settings из `getAgentDir()` (явный
  `PI_CODING_AGENT_DIR` либо существующий Pi default `<home>/<configDir>/agent`);
  nearest project
  `.pi/settings.json` читается только если active `ExtensionContext.isProjectTrusted()`
  синхронно возвращает true. Runtime context и resolver получают этот trust-факт;
  absent/throw/false исключает project registry (project-owned agent/ref тогда
  недоступен), не доверяя path или request-флагу;
- settings `lstat.size <= 1,048,576` до parse; closed `packages` entries —
  только string или объект с единственным own key `{source:string}`; любой invalid
  element/extra key отвергает snapshot;
- source разрешается существующей Pi layout-семантикой `git:`, `npm:` и explicit
  `file:`/relative path; bare absolute, `~`/`~/` и неизвестные schemes запрещены;
- каждый resolved package root и `package.json` — realpath regular, без symlink
  escape; до JSON parse `lstat.size <= 1,048,576` bytes, `packages <= 64`, agent
  roots <= 64, refs на agent <= 16; package `name` — valid npm name <=214 bytes,
  `version` — <=64 bytes и только ASCII alnum/`.`/`+`/`_`/`-` (не path-like);
- agent directories из `pi.subagents.agents`/`pi-subagents.agents` остаются внутри
  root, без symlink; traversal depth <=4, entries/agent files суммарно <=64, каждый
  definition regular non-symlink <=1,048,576 bytes до чтения;
- duplicate canonical package roots/agent names fail closed, а не выбираются по
  precedence.

Effective modelScope сохраняет precedence: trusted project перекрывает user.
Fixtures: same snapshot, user package+project deny, project allow+user deny,
untrusted project package и throwing trust accessor. Соседний package в project/user/global node_modules,
отсутствующий в settings, обязательно не обнаруживается. Остальные
user/global/builtin sources не открываются.

## Resolution refs

Для каждого package agent сначала находится единственный owner manifest,
содержащий definition realpath.

Relative ref:

- только `./...`, ни один lexical component не равен `..`, normalized path внутри owner root;
- target — existing regular non-symlink file; все существующие компоненты не
  symlink;
- execution получает canonical realpath.

`package:<module>`:

- module name — валидное bare npm имя (включая scoped), без subpath/version;
- exact own-property `dependencies[module]` owner manifest обязателен;
- `createRequire(agent.filePath)` разрешает установленную dependency; nearest
  regular dependency `package.json` имеет exact matching `name`, non-empty
  `version`, canonical root внутри expected dependency installation и без
  symlink escape;
- dependency manifest содержит массив `pi.extensions` ровно из одного non-empty
  relative entry; target existing regular non-symlink file внутри dependency root;
- duplicate logical refs и duplicate resolved entries fail closed.

## Projection и binding

Public projection: kind/ref, owner/dependency identity+manifestDigest,
entryDigest/contentDigest; private paths отсутствуют.
Без raw absolute paths. Contract получает `packageExtensions` и её digest;
agent-definition/launch-input/materialized launch digests связывают refs,
identity, manifest/entry bytes и ordered effective extension arguments. Любая
mutation owner/dependency manifest, agent ref или extension bytes, наблюдаемая до
завершения final before-spawn recheck, даёт существующий launch mismatch до
`spawn`, с обычным rollback/cleanup.

Threat boundary A1.2 сохраняется: post-final external pathname replacement и
immutable inode transport вне контракта.

Inherited `denyExtensions:true` запрещает refs. Active-bound ambient isolation
задаётся explicit extension set/`--no-extensions`, не этим ceiling, и потому не
удаляет attested refs.

Restricted discovery возвращает private resolved paths только локальному
executor. Bound launch использует `--no-extensions` плюс ровно resolved canonical
package-agent entries **и существующие обязательные runtime-owned extensions**
(`subagent-prompt-runtime` для structured output/tool-budget). Projection и
materialized binding различают internal runtime entries и package-owned entries;
ambient/configured extensions и auto-discovered permission-system не добавляются;
internal set задаётся явно только runtime-owned кодом. Preflight не создаёт файлов,
не загружает extension code и не резервирует spawn budget.

## Failure model

Preflight invalid package/ref → `unsupported_mode`; admission → `invalid_request`;
final drift → launch mismatch. Invalid inputs fail closed без private paths; legacy
unbound behavior не меняется.

## Tests

Synthetic persistent fixtures (не `/tmp` worktree) покрывают:

- positive matrix: string/object registry entries; git/npm/file/relative sources;
  `pi.subagents.agents` и `pi-subagents.agents`; explicit/default user agent dir;
  package agent из user/trusted-project settings и запуск из другого cwd;
  untrusted/throwing project trust не открывает registry; invalid/extra-key entry,
  bare absolute/tilde/unknown scheme отвергают весь snapshot;
- injected fs/exec observers подтверждают zero read/stat/readdir/`npm root -g` для
  соседних unregistered project/user/global roots; same/cross-scope
  packages+modelScope сохраняет user fallback и project-over-user precedence;
- valid package and relative refs, scoped module, deterministic sorted projection;
- caller не может передать refs; ambient/default extension не просачивается;
- полная owner/field matrix: разрешён только package subagentOnlyExtensions;
  package variants каждого A1 guard (fallback/context/skills/memory/output/runner/
  async/acceptance/reads/MCP) остаются запрещены;
- undeclared, unresolved, malformed/ambiguous entry, duplicate ref/agent/root,
  absolute/traversal, symlink root/component/target/escape, wrong dependency name;
- trust перечитывается каждой resolver фазой: true→false и true→throw на
  admission и final before-spawn дают zero spawn;
- exact settings/manifest/agent 1,048,576-byte boundaries и traversal/count/
  name/version limits проверены на boundary/+1; path-like public labels rejected;
- inherited `denyExtensions:true` запрещает ref, а internal ambient isolation
  сохраняет attested ref и runtime-owned extension;
- private owner/dependency/extension absolute paths отсутствуют в contract/DTO
  (существующий public `canonicalCwd` сохраняется); content/manifest/ref mutation
  меняет digest и ловится на admission/final recheck;
- execution args содержат `--no-extensions`, exact canonical package entries и
  обязательный prompt runtime, но не ambient permission-system/other entries;
- valid extension с top-level sentinel: preflight/admission metadata resolution не
  создаёт sentinel; он появляется только при child load; zero spawn on failures;
- project agent без extensions и весь legacy corpus остаются green.

Gate: typecheck, focused/full tests, diff check/audit, independent review, commit.
Packed Git-installed Pi proof остаётся отдельным обязательным A1 stop-gate.

## CLI probe

Installed Pi 0.84.1: при `--no-extensions --extension <path>` explicit sentinel
создан до provider failure, project ambient sentinel отсутствует. Packed E2E это
не заменяет.
