# A1.6 tool-registry proof

## Scope

Только active-bound final-registry gate/proof. Denial/cancellation — A1.7;
Fleet/reload/packed E2E — далее. Legacy path не меняется.

## Projection

```ts
interface ToolRegistryProjectionV1 {
  version: 1;
  projectionVersion: 1;
  required: string[];
  effectiveCallerTools: string[];
  internalTools: string[];
  missing: string[];
  digest: string;
}
```

В expected projection `required` — expected caller+internal, caller строится из
`toolPlan.effectiveToolAllowlist - internalTools`, `missing:[]`. В measured projection
`actual` — byte-exact outgoing payload names; `internalTools = actual ∩ expected
internal`, `effectiveCallerTools = actual - expected internal`, `missing = required -
actual`, extra = `actual - required`. Wire/live inequality — protocol
`active_registry_drift` без projection/diffs; только wire=live mismatch публикует
exact missing/extra.

Names — непустой UTF-8 <=128 bytes; arrays sorted/unique <=128 entries, frame <=64
KiB. Никаких schemas/args/source/path. Canonical JSON фиксирует первые шесть полей;
digest — SHA-256 объекта без digest. Launch contract содержит projection и
`toolRegistryDigest`; policy входит в agent/launch/materialized binding.

Terminal DTO аддитивно получает `toolRegistry` и только для measured mismatch —
exact sorted `toolsMissing`/`toolsExtra`. Status
`native_tool_registry_mismatch`, exitCode 1, `transportIncomplete:true` имеет
terminal priority. Missing/malformed transport или непредставимый payload даёт
`native_tool_registry_protocol_error`, bounded `toolRegistryError`, также
`transportIncomplete:true`, без выдуманных projection/diffs.

## One-shot transport

Active-bound spawn добавляет parent-owned pipe FD 3. Parent принимает один closed
newline JSON frame максимум 64 KiB; overflow/second frame/invalid UTF-8/unknown key
— protocol error. Child получает generated `PI_SUBAGENT_TOOL_REGISTRY_FD=3`.
Mandatory bootstrap первый: читает/удаляет env policy+FD и хранит singleton.
Generated runtime mediator идёт вторым: import exact attested package factories и
вызывает их по порядку с API proxy. Gate последний. Package paths больше не
передаются Pi как самостоятельные `--extension`; mediator bytes/imports и exact
first/mediator/last order входят в launch digest/beforeSpawn recheck.

Gate пишет frame и закрывает FD. Нет child-writable path/MAC/file/public param.
Pre-spawn failure proof не требует; lifecycle закрывает ends once, bounded collector
не удерживает terminal. Legacy stdio прежний.

## Payload gate

Gate измеряет tools фактического payload текущего provider request, полученного его
последним `before_provider_request` после package handlers:

1. bootstrap parses policy/env, deletes env, stores singleton;
2. последний `agent_start` делает preliminary `pi.getActiveTools()` только для
   diagnostics, без frame/exit;
3. final handler принимает bounded plain-data payload, строит detached clone,
   извлекает wire names и сравнивает live/policy;
4. non-exact пишет frame и exit 78; exact пишет frame, атомарно commits immutable
   barrier и возвращает clone. Package mutation меняет лишь старый object.

Mediator никогда не делегирует provider/model/thinking mutators; command/shortcut/
flag registrations становятся bounded no-op (их callbacks не сохраняются), чтобы
headless MCP adapter мог загрузиться без UI surface. `on` имеет allowlist только
`session_start|session_shutdown|tool_result`; payload,
header и pre-agent hooks запрещены. Event и wrapped tool-execute callbacks получают
context proxy; `modelRegistry` целиком недоступен, raw context/API не выдаются.
До barrier разрешены `registerTool|unregisterTool|setActiveTools`; после barrier они
exit 76 без underlying call. Exact frame + exit 76 даёт parent-generated protocol
`package_runtime_mutation`, не child frame; registry frozen. A1.2 contract сохраняется; A1.6 не утверждает proof
остальных Pi-owned payload fields. Process internals вне attested boundary.

Policy содержит `modelApi`/`piRuntimeVersion`. Resolver допускает exported Pi
`VERSION` только `0.84.1|0.84.2` и bind-ит его; gate требует exact match. Иная
version — preflight reject/child protocol. Обе имеют installed control. Grammars:

- OpenAI completions: `tools[].function.name` или grammar `custom.name`;
- Mistral: только `tools[].function.name`;
- OpenAI/Azure/Codex responses: `tools[].name`;
- Anthropic: `tools[].name`;
- Bedrock: `toolConfig.tools[].toolSpec.name`;
- Google/Vertex: `tools[].functionDeclarations[].name`;
- `pi-messages`: `context.tools[].name`.

Resolver убирает ранний запрет `mcpDirectTools`, передаёт selections в preflight
`resolvePiLaunchToolPlan` как execution и связывает resolved names в projection.
Они допустимы только с attested package adapter/ceiling checks. Unknown API
отклоняется preflight. Missing tools container допустим только
при expected zero. Mixed/unknown entry shape, duplicate wire name, unexpected keys
в name-bearing wrapper, malformed container или deferred marker дают protocol
frame (`unsupported_payload_shape|duplicate_tool_name`). Никакого recursive search
по произвольным `name` нет. Wrappers имеют exact version-tested fields; unrelated top-level fields ignored.

Anthropic byte-exact. Если OAuth меняет `read` → `Read`, wire/live inequality даёт
protocol `active_registry_drift` без projection/diffs. OAuth доступен для A1 names,
которые остаются byte-exact; wire casing никогда не приписывается live name.

Это one-shot startup proof первого request, до model turn. Fresh request не имеет
deferred loading; wire = full live. После barrier следующие requests не пишут FD;
A1.7 покрывает tool lifecycle. Startup mismatch — до transport/tool call.

Installed control: mediator-before-gate; allowlisted `session_start` fixture
registers/activates exact package tools; gate returns clone to loopback. Forbidden
hook/mutator fixtures exit до transport. Real adapter may add generic `mcp`; gate
reports it extra unless packed stop-gate config disables proxy and proves readiness.
Это не positive control A1.6. Installed 0.84.1 подтвердил pre-transport exit.

Provider counter означает вход в transport после handlers; достигнутый `turn_start`
не model turn. Gate failure: providerRequests/usage turns/toolCalls = 0.

## Parent validation

Representable frame:

```ts
{ version:1, kind:"registry", projection:ToolRegistryProjectionV1 }
```

Other strict frames:

```ts
{version:1,kind:"unrepresentable",code:"too_many_tools"|"invalid_tool_name"|
 "frame_too_large"}
{version:1,kind:"protocol",code:"unsupported_payload_shape"|
 "duplicate_tool_name"|"active_registry_drift"}
```

Registry не truncates. Absent/partial/multiple/malformed frame становится
`missing_frame|invalid_frame|multiple_frames|frame_too_large`. Invalid expected
bounds/API — preflight `unsupported_mode`; unknown fields fail closed.

До cleanup parent требует exact projection/digest. Valid missing/extra overrides
outcome mismatch; exit 78 без valid mismatch frame — protocol error. Success без
proof — protocol error. Timeout несёт frame только после barrier; preliminary его
не пишет. Pre-spawn/spawn error proof не требуют. Adapter копирует только validated
projection/diffs/code и launch digest.

## Tests

- canonical split/sort/digest/zero/UTF-8/bounds vectors;
- preflight projections/digest mutation/API/version support, child version drift,
  internal subtraction and mcpDirectTools parity with materialized execution;
- pipe tests: exact/partial/overflow/second/invalid UTF-8/close; legacy unchanged;
- event harness: first/mediator/last, mediated package factory, all API extractors,
  Anthropic byte-exact/OAuth rename mismatch, payload/live drift, missing/extra,
  wire=live missing/extra exact diffs и обе асимметрии wire/live как protocol;
  original versus clone; event allowlist rejects payload/header/pre-agent hooks;
  provider/model/thinking/modelRegistry bypasses exit 76, command/flag callbacks are
  discarded; post-barrier
  register/unregister/active likewise; wrapped contexts, no-second-frame;
- installed mediator/order/freeze fixture per Pi version, then mock exact barrier
  and mismatch exit 78; real adapter stays packed A1 stop-gate;
- all mismatch/protocol gate exits prove provider=0, usage turns=0, toolCalls=0;
- terminal success, exact diffs, protocol without diffs, exit priority, one
  terminal/no retry; timeout before barrier has no proof, after barrier retains it;
  package fixture emits missing/extra against
  expected mcpDirectTools names (нет blanket admission для unattested `agent.tools`);
  pre-spawn no proof;
- typecheck, focused/full tests, diff audit, independent review, local commit.

Packed E2E remains A1 stop-gate. Plan <10,000 bytes.
