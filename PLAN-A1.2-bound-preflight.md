# A1.2: active preflight and bound foreground leaf

## Base and scope

Base `a0b6973057e48930c1ff053e96e372832cba2395` after closed A1.1. A1.2 adds one
restricted active-runtime preflight and binds it to one existing structured
foreground leaf. It does not reopen source verification or reload lifecycle.

Deferred: caller env, other artifact policies, package/custom refs, final registry,
exact cancellation, installer/real-Pi probes, Fleet, async/workflow/schedules/missions.
Legacy preview, unbound requests and RPC methods stay unchanged.

## Closed preflight request

RPC v1 adds `preflight`; `boundForegroundLeaf:{version:1}` is advertised only with
available A1.1 source identity. Params are closed plain data:

```ts
{
 version:1; targetServerInstanceId:string;
 requestId:string; ownerRunId:string; nodeId:string;
 prospectiveRunId:string; // canonical RFC-4122 UUID
 agent:string; task:string; cwd:string; context:"fresh";
 model:string; // exact registry provider/id
 thinking:"off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max";
 timeoutMs?:number;
 turnBudget?:{maxTurns:number;graceTurns?:number};
 toolBudget?:{soft?:number;hard:number;block?:string[]|"*"};
 skill?:string|string[]|false; artifacts:false;
 result:{kind:"text"}|{kind:"structured";schema:Record<string,unknown>};
}
```

Bounds reuse delegation limits. Descriptor clone rejects accessors, prototypes,
cycles, symbols, non-finite numbers and unknown fields without executing code.
Schema keys use code-unit order; skill order is significant.

Execution fixes async/clarify/share/acceptance/mission/output false,
`foregroundOnly:true`, inline output and no artifacts. Reject fork, fuzzy/fallback
model, external runner, custom refs/env and nested/fanout. Candidate set is exactly
requested `provider/id`; retries cannot change model.

Both cwd values must be directories with equal realpaths. Active session identity
is `{currentSessionId,piSessionId}` from `resolveCurrentSessionId()` and
`sessionManager.getSessionId()`; both are non-empty and only its digest is public.

Root is configured `defaultSessionDir`, otherwise derived from a non-null parent
session file. Without either, fail `host_required`; never call `mkdtempSync`.

Success keys are exactly `version,serverInstanceId,sourceIdentityDigest,
activeSessionDigest,canonicalCwd,requestDigest,launchContract,launchContractDigest,
receipt`; error data only `version,code`. Tests prove no secret/raw diagnostic.

## Strict synchronous resolver

Keep `resolveSubagentLaunchContract()` as legacy async preview. Add a synchronous
restricted resolver using active context/session, exact registry snapshot, captured
config, capability ceiling, agent discovery and deterministic root.

Each resolution rereads agent/skill bytes, bypassing mtime caches. Digest binds
request/UUID, agent/skills, model/thinking, prompt/tools/capability, cwd/root, fixed
policy/protocol, schema/budgets and runtime/source/session identity.

Preflight is observational: no mkdir/write/rm, state/Fleet mutation, mission,
spawn-budget reservation, launcher/provider call, env mutation or ID consumption.

## Receipt and runtime service

One random 32-byte secret is created by production `randomBytes(32)` for each
successful runtime registration and shared only by RPC, bridge and executor. Dispose
zeros/drops it. Default clock is integer milliseconds from
`process.hrtime.bigint()/1_000_000n`, never `Date.now`; tests may inject both.

Fixed-order payload:

```ts
{version:1,serverInstanceId:string,sourceIdentityDigest:string,
 activeSessionDigest:string,prospectiveRunId:string,requestDigest:string,
 launchContractDigest:string,issuedAt:number,expiresAt:number}
```

Receipt is `{version:1,algorithm:"HMAC-SHA256",payload,mac}`. HMAC covers exact UTF-8
payload; MAC is 64 lowercase hex and uses `timingSafeEqual`. TTL is exactly 30,000
ms; admission accepts `issuedAt <= now < expiresAt`. Preflight consumes no identity.
Expiry is checked only at admission.

Production tests issue the identical payload through two default-secret services
(with all payload fields injected equal) and require distinct MACs; they also require
one 32-byte generator request, Date.now rollback immunity and closed responses.

Non-target RPC responders ignore preflight. Prepared target returns asynchronous
`no_active_session`; active target returns one reply. Source-unavailable runtime does
not advertise or issue receipts.

## Structured wire and admission

Existing request adds exactly:

```ts
binding?: {
 version:1;
 targetServerInstanceId:string;
 prospectiveRunId:string;
 expectedSourceIdentityDigest:string;
 expectedActiveSessionDigest:string;
 requestDigest:string;
 expectedLaunchContractDigest:string;
 receipt:LaunchReceiptV1;
}
```

Other values stay top-level and enter request digest. Absence selects legacy mode;
unknown binding fields fail closed. Non-target ignores. Matching bridge before
`started` checks clone/parse, active context, HMAC/TTL, runtime/source/session,
canonical request, strict resolver, launch digest and absent prospective root.
Invalid matching requests get one bounded terminal and no `started`/effects; invalid
proof does not consume identity.

Keep the A1.1 coordinator unchanged. Add global `BoundIdentityRegistryV1` under a
new key. Retrieval requires exact `version===1` and full methods; incompatible
objects fail closed. The registry owns non-evicting
`(serverInstanceId,prospectiveRunId)` reservations/tombstones with capacity 8192.
It survives module reload so an old draining runtime retains its own facts. Replay
scope is intentionally one server instance: new instance B may issue/admit P despite
old tombstone `(A,P)`, while B ignores stale receipt targeted at A.

Atomic JS-stack admission: tentatively reserve prospective ID, call existing
coordinator for tuple/node, release tentative ID on coordinator rejection, otherwise
commit it before `started`. There is no await or external callback before commit.
Tuple/node tombstones and old draining stay in the A1.1 coordinator. Replay in the
same instance receives one `duplicate_node` terminal and no executor call, including
reentrant replay from `started`. First valid admission per instance wins.

`started` is observable before request `emit()` returns and means exact request/UUID
consumption. Existing update/terminal draining remains.

## Executor and spawn enforcement

Proof travels through a private executor-only marker. Bound mode uses the full UUID
as runtime run ID. Strict resolver runs:

1. bridge admission before `started`;
2. `executeDelegated` before common state/nested route/mkdir/mission/budget;
3. after `buildPiArgs`, immediately before `child_process.spawn`, with no await.

All compare request, runtime/source/session, cwd/root, model/capability,
agent/config and skill bytes. Expiry is not rechecked after admission.

Final mismatch cleans temp/structured-output state, foreground/Fleet ownership,
nested route and only roots absent at admission; existing roots remain. Budget is
transactional only in bound mode: rollback before a successful child `spawn` event,
commit exactly once when spawn is observed. Mission is false. Terminal follows
cleanup. Valid bound launch has one exact model attempt; legacy behavior is unchanged.

## Nodes

### C1 — primitives, not advertised

Canonical DTO/digest/vectors, restricted resolver/skill bytes, receipt service and
purity/model/cwd/session tests. No RPC capability or bound request. After typecheck,
target tests and closed diff review commit
`feat: resolve bound active preflight` (`Refs #1`).

### C2 — admission and spawn

Shared runtime service; RPC/capability; structured binding; versioned bound registry;
early/final rechecks; UUID run ID; transactional cleanup/budget. After full suite
and closed diff review commit `feat: bind active preflight to foreground spawn`
(`Refs #1`).

## Acceptance

- independent request/HMAC vectors do not import production canonicalization;
- every preflight/rejection preserves recursive effects ledger: roots, state maps,
  budget and launcher/provider counters; exact public response keys contain no secret;
- cwd alias succeeds; cwd/context/session drift and null-root host case fail closed;
- only exact available model/fresh context succeeds with one candidate;
- all request/receipt/MAC/version/time mutations fail without consumption; fake-clock
  boundaries pass; crossing expiry after accepted `started` still launches because
  later rechecks do not inspect TTL; production hrtime and same-payload secret tests pass;
- 0/1/2 target and stale target are unambiguous; unavailable source advertises no
  capability and direct preflight issues no receipt;
- synchronous `started`, replay/incompatible registry/root collision spawn zero;
  coordinator rejection releases tentative UUID; exact capacity 8192 saturates
  permanently without eviction and preserves the first tombstone; new instance may
  reuse UUID only with its receipt while stale-target receipt is ignored;
- agent/skill/config mutation before admission and common effects rejects;
- pre-spawn barrier mutation gives zero spawn/provider, restored budget, owned cleanup
  and preserved sentinel;
- success uses full UUID/digest, increments limited spawn budget exactly once, and a
  second bound launch at limit is rejected; ChildProcess error before `spawn` restores
  budget; retryable provider failure has one model attempt;
- legacy preview/unbound/direct-rejection/RPC tests pass;
- typecheck, target suites, `npm run test:all`, `git diff --check`, intended files and
  closed onecpi review for each node.

## Gate

Brief stays below 10,000 characters and needs a closed, zero-blocker, no-drift plan
review. Immediately before C1, `sha256sum` must equal `scope.subjectHash` emitted by
that latest closed review; otherwise review repeats. Push/issue update are not implicit.
