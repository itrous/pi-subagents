# Repro recipe: issue #4 (package-projection lost in delegated spawn)

Status: **reproduced externally, fix pending.** This file is the working
handoff for the fix branch. Do not delete until `test/probes/active-runtime-package-projection.mjs`
lands and goes green.

## Symptom (pinned 57174db, feat/active-runtime-contract-a1)

Delegated foreground bound spawn of a **package** agent whose frontmatter has
`subagentOnlyExtensions: package:<dep>` fails before any provider request:

```
status: native_tool_registry_protocol_error
error:  Native tool registry proof failed: package_load_error
```

Child-side transform hook log (instrumented copy of
`bound-tool-registry-runtime.ts`, see "instrumentation" below):

```
TX   <ownerPkg>/node_modules/<dep>/index.ts     ← jiti compiles the ENTRY itself
ESC  <ownerPkg>/node_modules/<dep>/index.ts     ← then the guard rejects IT
LOAD-FAIL Error: Package factory transform escaped its attested resolution roots.
```

So the attestation **is delivered** (`loadBoundPackageFactories` attempts
exactly the dependency entry), but `evidenceRoots` computed by
`verifyPackageEvidence()` in the child does **not contain the dependency
root** at factory-load time — otherwise `within(root, entry)` would pass and
no escape would be logged for that path.

## What works

- Package agent with a **relative** ref (`./ext/x.ts`) from a *small separate*
  owner package: full cycle OK (factory loads, registry proof clean).
- Ordinary bound leaves (builtin tools only): full cycle OK.
- Parent-side preflight for the package-ref agent: projection `kind:"package"`,
  digests computed correctly.

## External reproducer

onecpi branch `feat/a2-native-agents-attestation`, `bin/a2-bound-probe.mjs`
(1С phase; env `A2_SKIP_1C=1 A2_SKIP_LEAK=1 A2_PROBE_DEBUG=1 A2_PROBE_KEEP=1`;
child logs in `<root>/load-debug.log`). Owner = packed onecpi with exact deps
(`pi-mcp-adapter`, `typebox`), agent `1c-review-native` with ten `mcp:` selectors
+ `package:pi-mcp-adapter`.

## In-fork repro to build (this branch)

`test/probes/active-runtime-package-projection.mjs`, modeled on
`test/probes/active-runtime-git-installed.mjs`:

1. Throwaway HOME/agentDir; installExactCommit not needed (running from repo),
   but children need the runtime extensions — same layout as the existing
   probe (extensionDir = repo checkout).
2. Two tiny local packages, **materialized as real directories**
   (resolver rejects symlinks):
   - `deppkg`: `pi.extensions: ["./index.ts"]`, index registers one tool;
   - `ownpkg`: depends on deppkg declared in `dependencies`
     (`{"a1dep": "file:./deppkg"}`), `node_modules/a1dep` materialized as a
     REAL copied directory (not symlink), agent `proj-leaf.md` with
     `subagentOnlyExtensions: package:a1dep`.
3. Seed `settings.json` packages with both roots; models.json → faux provider.
4. Parent SDK session (faux setResponses forces the probe tool), delegate the
   agent; assert child terminal `completed` and factory tool present in wire.
5. Currently expected to fail exactly like the external reproducer.

## Instrumentation hint

The four self-verified runtime files cannot be patched in attestation runs
(`runtime_bytes_drift`), but for DEBUG runs patching before parent creation is
consistent on both sides. Transform-guard condition + per-call filename logging
was sufficient to localize ESC on the entry file. Note: jiti keeps no on-disk
transpile cache here (checked), so stale-cache explanations are ruled out.

## Fix hypotheses (in priority order)

1. Policy assembly for delegated spawns: `execution.ts`
   `boundPackageExtensions = options.activeBoundProjectSkills ?
   resolveActiveBoundPackageExtensions(agent) : undefined` — verify the value
   actually reaches `spawnEnv[BOUND_TOOL_REGISTRY_POLICY_ENV]` on this path
   (log `policy.packageExtensions.length` child-side first).
2. Double guard installation: `registerBoundPackageMediator` may run for
   extension loads without bound context, installing the resolver/transform
   guard with empty roots; last-installed guard wins.
3. `within()`/path normalization mismatch between evidenceRoot recorded at
   preflight and the child-side realpath comparison.

## Статус реализации (WIP, ветка fix/package-projection-delegated-spawn)

- `package-projection-parent.mts` — родительский probe-extension (ping,
  preflight+delegation двух листов, диагностика на stderr).
- `active-runtime-package-projection.mjs` — драйвер (throwaway HOME,
  installExactCommit текущего HEAD, owner/dep пакеты materialized копией,
  faux-провайдер, SDK-родитель с принудительным tool call).
- Под `A2_PROBE_DEBUG=1` резолвер инструментируется логами всех
  `failure(...)`-сайтов со стеком.

**Текущий блокер воспроизведения:** минимальная фикстура получает
`unsupported_mode` на preflight rel-leaf ещё до слоя #4. Причина не
идентифицирована (подозрения: restricted-discovery без доверия проекта в
SDK-сессии, либо дополнительное ограничение forbiddenAgentMode для
минимальных манифестов). Метод дальнейшей отладки: читать стек из
A2RESOLVE-логов (каждый сайт отказа резолвера пишет место), сравнить с
рабочим воспроизведением onecpi (`bin/a2-bound-probe.mjs`, где preflight
проходит) и свести различия окружения (settings.json, состав packages).


## Результат минимальной пробы (зелёный)

С `main: "./index.ts"` в manifest зависимости ОБА листа завершаются
`completed`: rel-leaf (относительный ref) и dep-leaf (`package:a1dep`,
factory загружается через jiti). Базовый механизм package-projection в
делегированном спавне **работает**.

## Сужение #4 до реального кейса onecpi

Различия minimal ↔ onecpi, кандидаты на причину `package_load_error`:

1. Импорт `typebox` (peerDependency адаптера) разрешается вверх из
   `<owner>/node_modules/pi-mcp-adapter` в `<owner>/node_modules/typebox` —
   соседний каталог ВНУТРИ owner root, но вне корня самой зависимости;
   проверять `evidenceRoots`/guard на этот путь.
2. Хост-алиасы (`@earendil-works/pi-coding-agent`) при компиляции jiti.
3. Состав дерева owner (onecpi несёт corpus/scenarios и собственные
   extensions) против минимального дерева.

## Эксперимент typebox-sibling (WIP, нестабильно)

Драйвер получил env-гейты `A2_DEP_IMPORTS_TYPEBOX=1` (dep entry импортирует
typebox), `A2_DEP_PEER_TYPEBOX=1` (объявить peerDependencies) и materialize
typebox в owner node_modules. Прогон показал недетерминизм ДО фазы
dependency: rel-leaf то `completed`, то `invalid_request` между прогонами —
стабилизировать в первую очередь (подозрение: межфазовое состояние
координатора/реестров в одной сессии или гонка pending-cancel), затем
снимать вывод по гипотезе 1.
