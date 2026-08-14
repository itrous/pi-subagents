# A1.4: runtime-owned session artifacts

## Base and scope

Base `0cf4c09bd2486d8312b499654cb3bd5532d46c18` after closed A1.3. This slice
adds one artifact policy to admitted active-bound foreground leaves. The earlier
combined A1.3 plan was split because the existing foreground writer performs effects
before the immediate spawn barrier. A1.4 resolves that by activating bound writers
only after a successful child `spawn` event.

Legacy/unbound artifact behavior is unchanged. Custom/project/temp artifact roots,
caller output paths, package extension refs, final registry proof, exact cancellation,
async/workflow/Fleet, installer and real-Pi probes remain deferred.

## Closed bound DTO

`ActiveBoundPreflightRequestV1` and bound structured delegation add:

```ts
artifacts: boolean;
artifactDir?: "session";
```

The valid pairs are exactly `artifacts:false` with absent `artifactDir`, or
`artifacts:true` with `artifactDir:"session"`. `artifactDir` without bound binding
is rejected; legacy `artifacts` remains accepted exactly as before. Descriptor-safe
parsing, optional-undefined normalization, request digest, receipt and delegation
adapter all preserve one normalized request. Unknown values or fields fail before
started/admission effects.

## Contract and roots

The existing launch contract fields become authoritative rather than duplicated:
`policy.artifacts` equals the normalized request boolean, and new
`policy.artifactDir` is absent when disabled or exactly `"session"` when enabled.
For enabled mode, `roots.artifactRootDigest` is present; disabled mode omits it.
Tests require all three projections to agree, so no second top-level artifact policy
can contradict the existing `policy.artifacts` field.

For enabled artifacts, the root is exactly
`<baseRoot>/<prospectiveRunId>/artifacts`; only its canonical path digest is public.
It must be absent during preflight, admission, executor preparation and the immediate
pre-spawn resolver barrier. The existing prospective session root and `run-0`
identities remain the ownership boundary. An existing file, directory or symlink at
the artifact path rejects before spawn. Disabled mode has no artifact root projection.
No public response contains a raw root.

Artifact policy/root projection enters `launchBindingDigest`; mutation of
`artifacts`, `artifactDir`, the resolved root or materialized artifact config changes
request, launch and immediate materialized digests.

Bound mode rejects agent-level `output` and any public executor `output` override,
so artifact policy cannot be bypassed by an absolute/custom output path.

## Spawn-event writer activation

For enabled bound mode, executor passes the fixed future artifact root and existing
`ArtifactConfig` features, but `runSync` only computes `ArtifactPaths` before spawn.
It does not mkdir/open/write input, JSONL, transcript, output or metadata before the
immediate `beforeSpawn` callback and successful process creation. Structured-output
protocol bootstrap remains separate: schema/output files are always prepared in the
existing attempt-owned temporary runtime, never in the future artifact root, because
the child must read its schema during startup. After spawn/completion, the existing
result may be copied/persisted as a normal session artifact. Active-bound cleanup
always tears down this protocol temporary runtime on mismatch/exit regardless of the
user artifact policy; it no longer keys structured cleanup solely on
`artifactConfig.enabled`.

`runSingleAttempt` installs its child `spawn` listener immediately after
`child_process.spawn` returns. Node's spawn event precedes stdout/stderr data events.
The listener performs this synchronous order:

1. mark spawn observed and invoke the existing bound `onSpawn` callback, committing
   transactional budget because a child now exists;
2. perform the critical activation phase: create the fixed artifact root and write
   the initial input artifact; a throw here is an activation failure;
3. initialize transcript and JSONL sinks, with `includeJsonl:true` forced for this
   bound session policy; they retain current best-effort semantics and are not part
   of the critical activation transaction. Transcript failures use its existing
   result diagnostic; JSONL open/write failure remains intentionally silent in v1;
4. only then permit stdout processing and external progress publication. Updates are
   buffered/suppressed until steps 2–3 finish successfully.

JSONL/transcript sinks are late-bound mutable holders used by already-installed data
handlers, so the first child line cannot bypass them. Unit/process tests emit spawn
and stdout in the same turn and assert input/transcript/JSONL ordering and completeness.
Disabled and legacy paths retain current eager writer behavior.

If the critical mkdir/input activation throws after spawn, the listener catches it,
records a bounded artifact initialization error, sends termination through the
existing child shutdown path, waits for observed close, and returns one failed
terminal. It never throws from EventEmitter. Budget remains committed (spawn
occurred), and provider/tool/progress events are never published for that child after
the failure. Partial files remain only under the owned session artifact root as
diagnostics. TERM/KILL grace uses existing foreground process termination constants
rather than a detached timer. Best-effort JSONL/transcript sink failures do not kill
an otherwise valid child; transcript keeps its existing diagnostic while JSONL
failure is silent, matching legacy v1 behavior.

Normal completion uses existing output/metadata persistence and returns the same
`artifactPaths`, all descendants of the contract-owned root. `artifacts:false` keeps
writers disabled and creates neither the session artifact root nor caller-cwd
`.pi-subagents`.

The threat boundary remains A1.2's adjudicated boundary: no atomic pathname claim is
made against a separate hostile process replacing paths between adjacent syscalls.
Within the extension, there is no await/external callback between final identity
check and spawn, no artifact effect before spawn, and no caller-selected path.

## Landing

Implement wire/resolver and execution lifecycle as one coherent landing. No commit or
advertised capability may accept `artifacts:true` until post-spawn activation,
structured-output temporary bootstrap and failure suppression are all wired. Run
focused tests, full suite and closed review, then commit.

## Acceptance

- false/absent and true/session parse; every other pair, accessor, explicit null,
  unknown value and unbound artifactDir fails closed;
- request/artifact/root mutations change independent canonical vectors;
- preflight/admission recursively preserve filesystem, budget, writer/provider counts;
  public response has no raw artifact path;
- pre-existing artifact file/directory/symlink rejects with zero started/spawn for
  admission collisions and zero spawn for preparation drift;
- disabled success creates no artifact root and no caller `.pi-subagents`;
- enabled child spawn spy observes the artifact root absent inside `beforeSpawn` and
  present only after spawn; all returned paths are regular descendants of the UUID
  root, with complete input/transcript/JSONL/output/metadata;
- a mock emits spawn plus first stdout line without delay; transcript and JSONL contain
  it, and an update spy remains empty until critical activation and sink setup finish,
  proving listener/publication order;
- structured result bootstrap before spawn exists only in the attempt-owned temporary
  runtime and is cleaned on mismatch; the session artifact root remains absent;
- synchronous spawn throw and pre-spawn error leave no artifact root and roll budget
  back; post-spawn critical mkdir/input failure commits budget, terminates/reaps the
  child, suppresses later events and produces exactly one failed terminal;
- forced transcript/JSONL sink open failures do not throw from EventEmitter and
  preserve the child result; transcript exposes its existing diagnostic while JSONL
  retains documented silent best-effort behavior;
- two enabled leaves use disjoint UUID roots; replacement/sentinel roots are preserved;
- agent/public output path attempts reject before spawn;
- legacy project/session/temp artifacts retain positive regression tests;
- run typecheck, target tests, `git diff --check`, intended-file audit,
  `npm run test:all` and independent zero-blocker review before the one local commit.

## Gate

This is a new plan epoch subordinate to unchanged GitHub issue #1 and master plan.
Before C1 code, run independent `--review-plan --adjudicate --runs 2`; start only
with a closed, zero-blocker, non-truncated, non-drifted result whose subject hash
matches the current file SHA-256. Push and issue updates are not implicit.
