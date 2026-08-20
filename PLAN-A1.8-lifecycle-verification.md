# A1.8 — synthetic active-bound lifecycle verification

## Status and boundary

Base is local A1.7 commit `c1347e1`. This landing proves current lifecycle with deterministic extension,
mock-Pi, event-bus and process harnesses. It does **not** satisfy the later packed,
immutable Git-installed real-Pi stop-gate. Do not load a second extension copy,
modify installer provenance, publish a SHA, or start A2.

## Goal

Prove that four independently preflighted active-bound foreground leaves can be
live together and appear as four active Fleet leaves; exact authenticated
cancellation affects one tuple only and settles after its child closes; headless
execution remains supported and bounded; runtime replacement changes generation,
drains old attempts exactly once through the replacement sink, and never accepts
or relays old-target protocol traffic.

Change production only for test-exposed defects; preserve A1.1–A1.7.

## Definitions

### Fleet

The authoritative synthetic Fleet projection is `collectFleetSnapshot(state)` and
the public bounded projection is RPC `status.data.fleet`. For a foreground control
with `activeChildren`, each active child is one `foreground-active:<runId>:<index>`
item. Four separate single-leaf calls therefore normally have index `0`; uniqueness
is by full private control/run identity and by opaque public Fleet key, not by child
index alone.

Observe four entries while children are live and zero active entries after
settlement. Public status has bounded fields and opaque keys: no private IDs, full
prompt marker, tool args/output, session path, or cancellation token.

### Headless

A structured foreground delegation is awaited by its caller and is not an async
job discovered by `drainOutstandingWork`. Headless means an active session context
with `hasUI:false`: structured preflight/request/cancel/status work without invoking
UI methods, terminals settle, and no foreground control/process remains.

The existing `agent_end` hook must still invoke session-scoped async/background
auto-drain only for headless contexts. Its one absolute deadline bounds work that
appears during draining. A1.8 tests this split without claiming that auto-drain
enumerates active foreground leaves.

### Reload

Each extension registration has a distinct `serverInstanceId`. Publishing a
replacement stops/disposes the old runtime, suppresses old updates, aborts only old
owner attempts and leaves their terminal settlements in the process-global
coordinator. `rpcBridge.prepare()` makes the replacement the sole discovery RPC
responder immediately: unaddressed `ping` returns its new identity, while methods
requiring a session return `no_active_session` until `session_start`. Ping is a
broadcast discovery method and has no old-target form. The structured bridge and
terminal sink remain inactive until session start; then the replacement flushes
each old terminal once after that old executor/process has actually settled.
Reload itself need not synchronously wait for old drain.

## Test harness

Add `test/integration/active-bound-lifecycle.test.ts` using one registered extension,
actual RPC preflight/structured listeners, real foreground executor, `createMockPi`,
a trusted project and fixed source/server identity. One extension instance is both
responder and executor.

Each bound request has a unique tuple and `prospectiveRunId`; unbound controls have
only the unique tuple. Obtain bindings only from synchronous RPC preflight. Policy is root-only,
foreground-only, `context:"fresh"`, exact model/thinking, no fallback/watchdog/
intercom/usage budget, and the measured registry/denial proof remains mandatory.
Use bounded polling helpers with diagnostic failure output, never sleeps without a
deadline.

Use unit harnesses for process-free races and an isolated subprocess for
replacement/global-state tests.

## Required scenarios

### Four leaves and Fleet

1. Preflight four unique leaves and synchronously emit all four requests.
2. Observe exactly one `started` per tuple and four mock child spawns.
3. Hold all children live; assert the private Fleet snapshot has exactly four
   active foreground leaves with the expected agents and distinct full keys.
4. Query public RPC status and assert `totalActive === 4`, four opaque stable keys,
   bounded/redacted display data, and no private identifiers or secret marker.
5. Release children in non-request order. Each tuple gets exactly one terminal,
   launch/proof fields remain correlated, private `foreground-active` entries and
   public active entries become zero, and supported `foreground-recent` history may
   remain in the private snapshot.

### Exact cancellation and sibling isolation

1. Hold four active-bound leaves; authenticate cancellation only with the selected
   preflight binding/token.
2. Wrong target, malformed/cross-tuple token, replay, unknown legacy cancel, and a
   three-field legacy cancel naming a **live bound tuple** affect no child. Preserve
   legacy cancellation for a live unbound tuple. Coordinator admission retains a
   cancellation-policy bit; request shape/accessors are not re-read later.
3. Valid targeted cancel suppresses only its tuple's updates, terminates it,
   escalates to `SIGKILL` on the bound deadline if required, and emits no terminal
   before observed child `close`.
4. After cancel, deliberately invoke the selected executor's update callback and
   emit mock child tool/provider output as a positive control; neither is relayed.
   It emits one `cancelled` terminal after close. Three siblings remain in Fleet,
   continue updates, and complete with independent proof/usage.
5. Cancel-before-request is one-shot with no `started`/spawn and does not poison
   siblings, a reissued binding, capacity, or a new generation.

### Headless

1. Run preflight, status and at least one successful and one cancelled structured
   leaf with `hasUI:false`; UI methods must not be called.
2. Settlement removes every control and closes every child within the deadline.
3. On headless `agent_end`, auto-drain waits for background work created while
   draining under one absolute deadline. For `hasUI:true`, leave known background
   work pending, assert the wait provider is not called, then clean it explicitly.
   Timeout/error remains explicit.

### Replacement/reload

1. Start at least two old-generation attempts, including one whose child ignores
   soft termination long enough to prove close ordering.
2. Register a replacement with a new fixed server ID on the same process/event
   transport, creating an inactive structured-sink gap. Before session start,
   assert exactly one unaddressed ping reply carrying the new ID and
   `no_active_session` for new-generation session-requiring RPC; structured request,
   started/update/terminal events remain absent. Then start its session.
3. Old updates stop immediately. After stop, deliberately call every old executor
   update callback as a positive control and assert no update delivery. Old children
   terminate; the replacement sink delivers terminals once and only after each
   close/settlement, including out-of-order completion.
4. A new-generation sibling is not aborted by old `stopOwner`/late shutdown and
   completes normally. A late old shutdown cannot clear replacement environment,
   cleanup authority, listeners, Fleet state, or sink.
5. Old-target preflight/request/cancel receives no replacement reply and causes
   zero admission/spawn. Unaddressed discovery ping has exactly one replacement
   reply; it is not modeled as targetable. New-target traffic has one responder.
   An old token cannot cancel a new tuple, including reused request strings.
6. `drainOwner(old)` resolves only after every old attempt settles; replacement
   drain/ownership is independent. No terminal is replayed after sink reactivation
   or listener failure.

## Expected seams

Tests first:

- new `test/integration/active-bound-lifecycle.test.ts`;
- focused additions to `test/unit/prompt-template-bridge.test.ts`,
  `test/unit/structured-attempt-coordinator.test.ts`,
  `test/unit/subagent-prompt-runtime.test.ts` or `test/unit/auto-drain.test.ts`;
- test-support helpers only when shared by multiple scenarios.

Keep production fixes narrow. Because historical v2 freezes `contractVersion:2`,
add an orthogonal immutable `cancellationContractVersion:1`; do not redefine v2.
Upgrade extensible v2 objects in place or fail closed. Before publishing the new
field, classify every active record from an own data-property binding
(ambiguous/accessor means bound) and atomically wrap admission/cancel. Test the
historical non-writable v2 shape with active bound/unbound records across class
reload. Three-argument old callers default to legacy authority and cannot cancel
bound records. Preserve all prior binding/proof/env/close contracts.

## Verification

Focused commands:

```bash
node --experimental-strip-types --test \
  test/unit/prompt-template-bridge.test.ts \
  test/unit/structured-attempt-coordinator.test.ts \
  test/unit/subagent-prompt-runtime.test.ts test/unit/auto-drain.test.ts
node --experimental-strip-types --import ./test/support/register-loader.mjs --test \
  test/integration/active-bound-lifecycle.test.ts
npm run typecheck
git diff --check
```

Then run `npm run test:all`, installed-Pi registry control, and
`npm pack --dry-run`. Confirm no staged files before review.

## Landing gate

- All scenarios above have deterministic assertions and bounded cleanup.
- No regressions in A1.1–A1.7 or legacy delegation.
- Independent uncommitted implementation review has `gate.closed:true`; fix and
  rerun for `critical`/`high` or material lifecycle/security changes.
- Create one local A1.8 commit from a clean worktree. Do not push.
- Record residual stop-gate explicitly: packed exact-SHA real Git-installed Pi
  still must prove `ToolDefinition.execute`, single responder, pre-turn proofs,
  exact process cancellation, Fleet, headless and host reload before A2.
