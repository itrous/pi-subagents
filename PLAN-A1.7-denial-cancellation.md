# A1.7 denied-tool proof and exact cancellation

## Scope

This landing adds active-bound denied-tool proof and exact cancellation. A1.6
registry proof is unchanged. Fleet/headless/packed probes remain next, except
focused reload tests for cancellation. Legacy/unbound behavior is unchanged.

## Denied-tool proof

Each active-bound child gets a parent-owned pipe on FD 4. The private policy
carries `denialFd:4` and the parent-generated
256-bit proof nonce; bootstrap validates and removes all proof env values before
package code loads. Public executor params, inherited env and filesystem paths
cannot supply this channel.

The attested prompt runtime owns a bounded in-memory collector. At its own
`tool_call` gates it records only:

```ts
type DeniedToolReasonV1 =
  | "permission_rule"
  | "tool_budget";
interface DeniedToolCallV1 { tool: string; reason: DeniedToolReasonV1 }
```

No args, preview, block text, output, schema or path enters the proof.
Tool names use the A1.6 UTF-8/name bounds. Calls preserve observed order, are
capped at 128, and set `overflow:true` after the cap. Direct deny and hard tool-budget denial are recorded at the package-owned
decision point before returning Pi's block response. Active-bound admission
continues to reject every `ask` policy before spawn, so `ask` is deliberately not
a reachable A1.7 reason. Approved calls and the soft budget notice are not denials.

On final `agent_settled`, with `session_shutdown` fallback, runtime writes one
frame and closes FD 4. `agent_end` never closes it. For active-bound only, parent
final-drain cannot start until `agent_settled`/valid denial frame; the overall
attempt timeout remains the hard fallback:

```ts
{
  version: 1;
  kind: "denied_tool_calls";
  calls: DeniedToolCallV1[];
  overflow: boolean;
  proofNonce: string;
}
```

The frame is closed plain data, at most 128 KiB, with exact keys and reason codes.
This covers 128 128-byte names under six-byte JSON escaping plus overhead;
anything larger is `frame_too_large`, never truncation. Captured write/close/JSON
primordials are used and failures are fail-stop. The parent collector uses fatal
UTF-8, one-frame/size/closure checks; an inherited writer is protocol error.

As in A1.6 registry proof, exact attested package/dependency bytes are TCB. The
nonce/FD is private from public params and unattested ambient bytes, not a sandbox
against deliberate `/proc`, `node:module` or raw-FD attacks by that same TCB.

For a normally completed spawned active-bound lifecycle, missing/malformed/
multiple/oversized proof becomes `native_denied_tools_protocol_error`,
`transportIncomplete:true`, and never synthesizes `[]`. Registry mismatch or its
protocol error retains priority because it terminates before a tool lifecycle.
Cancellation/timeout/interruption retains its semantic priority when the denial
pipe is absent or partial due to process termination; a complete valid frame may
still be projected. Pre-spawn failure does not require either child proof.

The terminal DTO adds active-bound-only fields:

```ts
deniedToolCalls?: DeniedToolCallV1[];
deniedToolCallsOverflow?: true;
deniedToolCallsError?: "missing_frame" | "invalid_frame" |
  "multiple_frames" | "frame_too_large";
```

A valid `[]` means measured zero. Normal active-bound terminal DTOs contain
exactly one proof variant: valid `deniedToolCalls` (plus optional overflow), or
`deniedToolCallsError` without the calls field. A protocol-error terminal therefore
never fabricates measured zero. Any non-empty valid list sets
`transportIncomplete:true` while preserving the semantic child status/result;
the caller decides gate closure. Adapter projections copy only validated names,
reason codes and overflow. Legacy responses omit all three fields.

## Exact cancellation

Cancellation identity remains the exact tuple
`{requestId, ownerRunId, nodeId}`. The process-global
`StructuredAttemptCoordinator` remains the sole owner of controllers, node locks,
terminal outbox and reload drain state.

To preserve synchronous `started` while covering bound cancel-before-start, the
`ActiveBoundPreflightResponseV1` issues and returns `cancellationToken` beside the
receipt; client binding carries both unchanged. The token is a domain-tagged HMAC
over server/source/session, prospective ID, request/launch digests, expiry and the
exact `{requestId,ownerRunId,nodeId}`. The bound cancel DTO carries
target, binding and token. A read-only verifier checks all token/receipt fields and
MACs without reservation; server ID alone is never authority. The tombstone stores
those signed fields and only the later exact verified request can consume it.
Active tuples still accept the existing three-field cancel; unknown three-field
legacy/unbound cancels remain ignored.

Tombstones live in versioned process-global
`BoundPendingCancellationRegistryV1`, outside the old coordinator.
The registry has its own 8192 cap, expires entries after 30 seconds, and prunes
synchronously without timers or an irreversible saturation latch; admission is
again possible after expiry frees capacity.

A later exact bound request is parsed and fully target/receipt/launch verified,
then coordinator admission checks duplicate tuple/node/capacity. Only an accepted
admission consumes the matching tombstone, commits the bound prospective identity,
aborts that exact record and synchronously settles it through the normal terminal
outbox. The bridge emits one `cancelled` terminal, zero `started`, invokes no
executor and spawns no child. Wrong tuples/targets and forged requests do not
consume it. Settled tuple replay remains rejected.

For an active tuple `cancel` only aborts that record's controller. The bridge emits
no terminal from the cancel handler. It suppresses later updates immediately and
continues awaiting the foreground executor. Foreground execution sends graceful
termination, escalates after its existing bounded grace, and resolves only from
observed child `close`/spawn error. Only then does coordinator settlement enqueue
one `cancelled` terminal. No provider/tool/token/update event for that target is
forwarded after cancellation; siblings with another exact tuple remain live.

`stopOwner(runtimeId)` on dispose/reload marks and aborts only records owned by the
retiring runtime, waits on their settlement promises, and leaves terminal delivery
in the process-global outbox. A replacement sink may flush those terminals but
cannot relay new RPC work to the old generation. Pending tombstones remain bound
to the serverInstanceId that accepted the cancel: server rotation never retargets
them to a new generation, and they simply expire. The separate registry avoids
depending on an old coordinator's private fields; tombstones own no runtime/child.

## Implementation

1. Add closed denied-proof types, frame codec/collector and runtime-state FD 4.
2. Record denial decisions in permission/tool-budget gates; write one terminal
   frame from attested lifecycle hooks.
3. Spawn/collect FD 4, enforce terminal priority, and project validated proof
   through `SingleResult`, delegation adapters and public terminal types.
4. Add the global bound-pending registry, signed cancellation token/targeted DTO
   and read-only verifier while preserving the old coordinator
   and synchronous non-cancelled `started`.
5. On active-bound only, delay final-drain to denial settlement and ignore
   `ChildProcess.killed` when escalating; keep legacy behavior unchanged. Test
   actual close, siblings and reload drain.

## Verification

- success returns exact `deniedToolCalls:[]`;
- one allowed tool call still returns exact `[]`; direct permission deny and hard
  budget denial each produce one exact `{tool,reason}` without args/output markers;
  active-bound `ask` remains preflight-rejected;
  each non-empty proof preserves status/result and sets `transportIncomplete:true`;
- 129 denials return 128 calls plus overflow; a 128-name worst-case JSON-escape
  vector fits the 128 KiB bound; malformed name/reason, nonce, UTF-8, second frame,
  overflow and inherited writer fail closed;
- missing proof after ordinary completion is protocol error with error-only DTO;
  registry failure, pre-spawn error, cancellation, timeout and control interruption
  keep their declared priority;
- targeted bound cancel-before-request gives one synchronous terminal and no
  started/executor/spawn; legacy unknown cancel remains ignored; wrong target/tuple,
  missing/forged/mismatched/expired token/receipt and expired tombstone do not create,
  consume or cancel; capacity recovers after expiry;
- duplicate-node/tuple/capacity admission failure does not consume a tombstone or
  commit the prospective identity; an accepted retry consumes/commits each once;
- active-bound final-drain does not terminate between `agent_end` and
  `agent_settled`; the targeted DTO also cancels when request wins the race;
  in-flight terminal is observed only after close; a child that ignores
  SIGTERM is escalated without `ChildProcess.killed`, while legacy keeps its guard; target
  updates stop at cancel/remain absent after grace, and a sibling completes normally;
- an attested package that replaces ambient JSON/write/close functions cannot
  alter, suppress or forge the frame produced by captured primordials;
- retrying `agent_end` and follow-up activity remain in one denial proof until
  `agent_settled`; a fallback-only `session_shutdown` emits exactly one frame;
  repeated cancel/response/replay is one-shot and capacity bounded;
- stop/reload drains old owner and the next sink emits one cancelled terminal;
  old-target pending tombstones never cancel a new server generation and expire;
- legacy request/cancel/result behavior is unchanged;
- typecheck, focused tests, installed Pi control, full upstream suite,
  `npm pack --dry-run`, diff audit, independent review, local commit.

## Stop gate

A2 stays blocked on the next Fleet/headless/packed landing and immutable A1 SHA.
