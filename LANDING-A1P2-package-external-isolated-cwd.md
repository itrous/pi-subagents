# A1P2 addendum: package-owned isolated external cwd

## Основание

Landing E2 packed fake-provider gate обнаружил реальный разрыв: active-bound resolver
отвергает любой `request.cwd`, отличный от cwd активной Pi-сессии. Поэтому
import-safe native corpus не может запускать package-owned carrier в собственном
материализованном git-репозитории вне review repository и получает
`native_preflight_invalid_cwd` до provider request.

Обход в onecpi запрещён: materialization нельзя переносить в измеряемый project,
а subprocess/fallback не является strict-native. Исправление принадлежит A1:
launch contract уже связывает canonical cwd, но admission излишне требует его
равенства cwd родителя для всех source kinds.

## Изменение контракта

`resolveActiveBoundLaunchContract` допускает canonical существующий regular
`request.cwd`, отличный от `activeCwd`, **только** если окончательно выбранный agent:

- `source === "package"`;
- уже проходит прежний `forbiddenAgentMode`: fresh, без project-context/skills,
  memory/default reads, external runner, async/acceptance и прочих ambient
  возможностей; A1P2 отдельно требует `artifacts:false` для external cwd
  (exact-active прежний session-artifact contract сохраняется);
- не имеет project refinement в active discovery cwd;
- package extensions/factories проходят прежнюю owner attestation, resolver-pass
  evidence cache и final/runtime rehash без послаблений.

Project agents и любой иной source kind по-прежнему требуют exact canonical
`request.cwd === activeCwd`. Symlink/non-directory/missing cwd fail closed.

External cwd входит в прежние request/launch digests и launch contract как exact
`canonicalCwd`; process запускается с ним через spawn `cwd` (не argv), а child
runtime обязан подтвердить тот же cwd. Receipt/cancellation связывают digest всего
launch contract, не отдельное cwd-поле. Active session identity/server ownership
не меняются. Новых request flags, ambient tools, MCP selectors или capability
ceilings нет.

Исполняемый Pi runtime, package registry и package/model scope разрешаются только
от trusted **activeCwd/active session root**, как до A1P2. External request cwd
никогда не участвует в поиске runtime executable; относительная команда Pi
разрешается относительно activeCwd (либо прежнего attested runtime root), а её
bytes/provenance проходят прежнюю аттестацию.

## Dual-root discovery boundary

A1P2 разделяет два корня явно:

- **discovery/runtime root = activeCwd**: restricted discovery, trusted project
  package registry, modelScope, package resolution, agent refinement, skills и Pi
  executable разрешаются ровно как до изменения;
- **execution root = requestCwd**: только canonical existing regular child cwd,
  bound в launch contract и spawn options.

Ни initial, ни fresh execution rediscovery не читают из requestCwd project
packages/settings/agents/skills/refinements или MCP config. Итоговый agent обязан
быть package-owned; ambiguity/refinement проверяются в active discovery root.
Для любого active-bound package carrier (external и exact-active cwd)
`request.skill` обязан быть absent/false, а package `agent.skills` уже запрещён
прежним режимом. External carrier с `mcpDirectTools` **или package extension
`pi-mcp-adapter`** в A1P2 fail closed: безопасная передача merged active-root MCP
config в Pi child требует отдельного adapter contract и не нужна E2 basic corpus.
Проверка учитывает owner/package identity attested extension projection, а не
только строку ref. Execution cwd не может включить eager/proxy MCP чтением
`.mcp.json`/`.pi/mcp.json`. Exact-active carrier сохраняет прежний MCP contract. Child запускается с прежним
`disableAmbientExtensions`/exact tool registry, `inheritProjectContext:false` и
`inheritSkills:false`; package tool/extension ownership измеряется по package
owner, а не execution cwd.

## Tests

1. Package-owned strict fresh carrier: external real cwd проходит preflight и
   launch contract/receipt связывают exact canonical cwd.
2. Тот же mismatch для project agent остаётся `invalid_cwd`.
3. Missing/file cwd fail closed. Новый mismatched external cwd с symlink в
   leaf-компоненте fail closed; symlink-префикс ОС канонизируется, а прежний
   exact-active alias сохраняет realpath-equality и существующий позитивный контракт.
4. External `.pi/settings`, packages, agents и skills не меняют active package
   discovery/model scope; external carrier с `mcpDirectTools` или attested
   `pi-mcp-adapter` extension fail closed, а external MCP config не читается.
   Separate fixtures cover both `owner.name` and dependency `package.name`
   adapter identities without selectors; positive exact-active fixture with the
   same MCP contract remains green. Explicit `request.skill` у
   package carrier fail closed и при external, и при exact-active cwd.
   External refinement не применяется и не создаёт denial, тогда как refinement
   того же package agent в active discovery root сохраняет прежний fail-closed
   `unsupported_mode`. Контрольные fixtures обязаны отличать dual-root реализацию
   от ошибочного discovery/overlay по requestCwd.
5. External `artifacts:true, artifactDir:"session"` fail closed, while the
   existing exact-active session-artifact positive remains green.
6. Относительный/подменённый Pi executable во внешнем cwd никогда не выбирается;
   runtime attestation остаётся привязана к active root.
7. Spawn/runtime proof подтверждают внешний cwd; package extension/tool registry
   initial/fresh/final/runtime evidence остаются exact, включая execution
   rediscovery от active discovery root.
8. Все A1/A1P unit/integration/probe suites green; independent review закрывает
   critical/high. После commit onecpi pin обновляется только через отдельный E2
   addendum и packed corpus gate.

## Не входит

- произвольный external cwd для project/user agents;
- наследование AGENTS/skills/settings из external cwd;
- ослабление owner evidence, package pin, registry proof или cancellation;
- изменение onecpi corpus work-root/writer policy.
