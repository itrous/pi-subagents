# itrous/pi-subagents fork

This repository is the `itrous/pi-subagents` security-focused fork used by the
OneCPI native review transport.

## Status: A1R.4 — leaf execution connected, capability v2 announced with identity

This build is upstream `8bd275bba0dc13273eff366e348378d41ad5535e` plus the fork
control plane on `subagents:bound:v2:*` (`src/bound/`): ping, side-effect-free
preflight with the v2 launch contract, receipt/HMAC admission with a final
re-resolution, targeted cancel, the attempt coordinator and identity registries,
reload/drain, and a bounded stop for every child session.

Since A1R.4 an admitted leaf is executed in-process by the upstream executor
(`executeDelegated`, wired in T1) through the bound child-session factory (T2):
a final launch↔contract recheck, attested package factories loaded inline behind
a facade, bindings published under the child session id, the `MCP_DIRECT_TOOLS`
window with restoration on every exit, a registry snapshot after
`bindExtensions`, and a barrier on `session.agent.streamFunction` that refuses
every model call whose tool names, model or api differ from the contract. The
ping announces `boundForegroundLeaf: { version: 2 }` only with a verified source
identity, a passed self-check of the Pi fields the layer relies on
(`AgentSession.agent`, `Agent.streamFunction`, `getActiveToolNames`,
`"loaded" in loader`), a connected execution port, and both proof collectors.
Every OneCPI **A1 (v1)** readiness probe still fails closed with
`malformed_ping`: the bound layer does not listen on `subagents:rpc:v1:*` at all;
the v2 client lands in A1R.6.

**Platform limit.** The bound channel answers everywhere, but a launch contract
is only issued on a Linux host: `resolveActiveRuntimeSourceIdentity`
(`src/extension/source-identity.ts:277`) returns `unverified_source` on any
non-Linux platform or without `/proc/self/fd`. On macOS and Windows the ping
carries `sourceIdentityUnavailable`, `capabilities` is empty, preflight refuses
with `unverified_source`, the self-check does not run, and the execution path is
therefore inactive. Tests inject the identity through the `resolveSourceIdentity`
seam and therefore stay green on every platform; the real installed probe is
A1R.5 on a Linux host.

Migration plan and accepted decisions: `PLAN-A1R-inprocess-upstream-migration.md`;
spike results: `LANDING-A1R.0-spikes.md`; plan review rounds and the executor
checklist: `LANDING-A1R-plan-review.md`. The published A1 pin
`c32663ec7e9f4c3c35456552c1d262eeeb845a60` on `main` remains the only build
OneCPI may install until stage A1R.7.

## Upstream bases

- Original A1 delta base: upstream release `v0.46.0`, peeled commit
  `4a2d5284a2ac6a6b0282059e756fc5ee8dbdd58c` (annotated tag object
  `3841f11cdc51070fe0c1af98c0083c50c5c984bb`).
- Fork-main integration base for PR #2: `2c2db5b8fb514fdd1670647a5aa205a399046720`
  (`package.json` version `0.47.1`).
- **A1R.1 base: `8bd275bba0dc13273eff366e348378d41ad5535e`** (`package.json`
  version `0.69.0`), merged into the fork as a single merge commit.
- Fork repository: `https://github.com/itrous/pi-subagents.git`.

## Fork delta in this build

Every upstream file is taken from the A1R.1 base verbatim except three hook
points: `git diff --name-only --diff-filter=MD <base> HEAD -- src` reports exactly
seven paths —
- T1 `src/extension/index.ts`: the import and the single
  `registerBoundControlPlane({...})` call right after the RPC bridge, which passes
  `executeDelegated`;
- T2 `src/runs/foreground/subagent-executor.ts`: one import and small fragments —
  a marked (bound) launch runs under the contract's `prospectiveRunId`, gets the
  bound child-session factory, is skipped by both foreground-history writers, gets
  no prompt-redo contract, and is hidden from the `status` reads and from the
  selection of a control without an id;
- T3 `src/extension/rpc.ts`: one import; Fleet skips bound runs, and targeted
  `status`/`steer`/`interrupt`/`resume` answer a bound run exactly like an unknown
  id;
- the four carries `src/agents/agent-memory.ts`, `src/runs/shared/long-running-guard.ts`,
  `src/runs/shared/permissions.ts`, `src/shared/jsonl-writer.ts`.

The accompanying upstream tests are the same four files as before; no upstream
test is edited.

The bound layer lives in `src/bound/` (entry `src/bound/index.ts`) and owns six
further modules outside it: `src/shared/canonical-json.ts`,
`src/extension/source-identity.ts`, `src/runs/shared/core-runtime-tools.ts`,
`src/runs/shared/package-tree-evidence.ts`, `src/api/launch-receipt.ts`,
`src/slash/bound-identity-registry.ts`. That exact set is published in the
contract as `toolRegistry.runtimeExtensions` and is checked against the import
closure of the layer entry by `test/unit/bound-layer-manifest.test.ts`.

Removed here because they encode the child-process model or its installer:
the bound tool-registry runtime (bootstrap/gate/runtime/state), package mediator,
denied-tool runtime, registry collector, `pi-command-evidence`,
`bound-runtime-evidence`, `active-bound-resolver`, `active-bound-runtime`,
`install-lib.mjs`, `test/probes/`, and the fork tests covering them.

Both coverage gaps recorded for A1R.1 are closed here:

- `src/api/active-bound-environment.ts` was removed; its namespace parser now lives
  in `src/bound/bound-bindings.ts` (bindings replace spawn environment variables in
  the in-process model) and is covered by `test/unit/bound-bindings.test.ts`.
- the strict JSON clone is back as a fork copy, `src/bound/bound-json.ts`: upstream
  `src/slash/delegation-json.ts` byte for byte plus a single divergence, a Proxy is
  rejected before any own-key inspection. `src/api/launch-receipt.ts` validates
  untrusted receipts and cancellation tokens through that copy.
  `test/unit/bound-json.test.ts` diffs both implementations over a value corpus, so
  a drift from upstream is visible.

A1R.4 adds nine modules to the layer, all reachable from `src/bound/index.ts`
and listed in the manifest: `bound-execution-port`, `bound-run-registry`,
`bound-child-factory`, `bound-launch-recheck`, `bound-stream-barrier`,
`bound-run-hooks` (bindings plus the denial collector that replaces
`denied-tool-proof`), `bound-package-loader`, `bound-package-api`,
`bound-self-check`.

### Probe P1: MCP and cwd (outcome B)

`pi-mcp-adapter` loads its early config from `process.cwd()`, the session config
from `ctx.cwd`. With `process.cwd() !== ctx.cwd` the direct-tool set is
incomplete when `create()` returns, which is exactly where the registry snapshot
and the barrier sit (`LANDING-A1R.4-spikes.md`, adapter 2.26.1 and 2.34.0). Gate
D10 therefore stays: a leaf with MCP direct tools and
`process.cwd() !== contract.canonicalCwd` is refused before any session work
(`unavailable_context`, `mcp_cwd_mismatch`). The measured alternative — passing
the adapter its config path explicitly — is fork B1 and awaits a human decision.
Side fact for A1R.6: adapter 2.34.0 with `PI_MCP_CONFIG_MODE=exclusive` collapses
config sources to the global one and disables project `.pi/mcp.json` entirely.

### Accepted weaknesses (decisions R4, R6)

- **R4, import containment is hygiene, not a boundary.** Package factories load
  through a private jiti instance whose `transform` refuses files outside the
  attested package roots, after the entry bytes and the package tree are
  re-measured. Native `.mjs`/`.cjs`, `createRequire`, `module.constructor._load`
  and `fs` plus `new Function` are not contained, and package code shares the host
  process (it can read in-memory secrets). No global resolver patch is installed.
- **R6, cancellation guarantees are weaker than a process kill.** A cancel never
  waits for `prompt()` or `abort()`: after the hard timer (3 s,
  `BOUND_CANCEL_HARD_TIMER_MS`) the port disposes the child and settles
  `cancelled`, and the bound factory bounds `session_shutdown` by 2 s
  (`BOUND_CHILD_SHUTDOWN_TIMEOUT_MS`): at most 5 s in total. A tool that ignores
  its abort signal keeps running and writing after that, and its subprocesses
  survive; a synchronous loop blocks the whole host process.

### Terminal refinement codes

Terminal statuses stay within the set the A1 client accepts; the reason is
refined through `toolRegistryError`:

| `toolRegistryError` | status | meaning |
|---|---|---|
| `launch_contract_mismatch` | `unavailable_context` | the upstream launch differs from the contract, or the task/bindings no longer hash to it |
| `mcp_cwd_mismatch` | `unavailable_context` | gate D10 |
| `policy_mismatch` | `unavailable_context` | the host sets a global `usageBudget` the contract forbids (D15) |
| `package_bytes_drift` | `unavailable_context` | an attested package entry or tree changed before loading |
| `package_load_error` | `unavailable_context` | an attested factory failed to load or threw |
| `package_mutation` | `native_tool_registry_mismatch` | a package factory tried a forbidden facade operation (occupied name, change after the barrier) |
| `barrier_unavailable` | `native_tool_registry_mismatch` | the barrier could not be installed, or a run completed without a registry snapshot |
| `compaction_forbidden` | `native_tool_registry_mismatch` | a model call without tools (compaction, branch summary) was refused |
| `model_mismatch` | `native_tool_registry_mismatch` | a model call used another model or api |

A registry that differs from the contract gives `native_tool_registry_mismatch`
with `toolsMissing`/`toolsExtra` and no `toolRegistryError`.

### Known privacy limits

A live bound run is private on the public surfaces of this build: Fleet and
`status` (including `view: "fleet"`/`"transcript"`), targeted
`steer`/`interrupt`/`resume` over RPC, `interrupt` without an id, the model's own
`subagent` tool (`status`, `interrupt`, `steer`, `resume`, `stop`, `dismiss` by id
or prefix answer as for an unknown id), the foreground history, and
`run-history.jsonl`. It stays visible and controllable through the host owner's
surfaces:

- slash commands (`src/slash/slash-commands.ts:238,246`);
- the TUI Fleet (`src/tui/fleet.ts`, `src/tui/fleet-status.ts`);
- the pi-web activity signal (`src/integrations/pi-web-session-liveness.ts:49`),
  which only reports that some work is active.

Closing them needs upstream files beyond the seven hook points; the decision is
left to a human.

Installation from this fork uses upstream `install.mjs` or, as OneCPI does,
`pi install git:https://github.com/itrous/pi-subagents.git@<40-hex-commit>`. The
previous fork-specific exact-commit installer was removed in A1R.1; its three
OneCPI consumers migrate in A1R.6.

## Updating from upstream

1. Create a dedicated task branch/worktree from an explicitly reviewed upstream
   base; do not merge a floating upstream branch.
2. Take every upstream file from that base verbatim; the fork keeps its own
   modules plus the narrow hook points listed in the migration plan.
3. Run `npm run typecheck`, `npm run test:unit`, `npm run test:integration` and the
   bound tests; a bound-test failure on a green upstream suite means internal Pi or
   upstream drift.
4. Create a new immutable candidate commit. Never amend or replace a published
   A1 commit.
5. After explicit approval, push the candidate, install it from the canonical
   GitHub repository by exact SHA in an isolated Pi home, and repeat the probe.
6. Publish that exact SHA to downstream consumers only after the independent
   review and GitHub-installed probe are closed.

## Verification of this build

```sh
npm ci
npm run typecheck
LC_ALL=C npm run test:unit
LC_ALL=C npm run test:integration -- --test-concurrency=2
node --experimental-strip-types --test test/unit/source-identity.test.ts
# Tier 2 is mandatory: the same suites against the installed Pi 0.85.1. Without
# the variable its tests are skipped and prove nothing about the real Pi fields.
PI_SUBAGENTS_NATIVE_SDK=/opt/homebrew/Cellar/pi-coding-agent/0.85.1/libexec/lib LC_ALL=C npm run test:unit
PI_SUBAGENTS_NATIVE_SDK=/opt/homebrew/Cellar/pi-coding-agent/0.85.1/libexec/lib LC_ALL=C npm run test:integration -- --test-concurrency=2
# Fork edit surface: exactly seven upstream src files (T1-T3 plus four carries),
# and every added src path lives in src/bound/.
git diff --name-only --diff-filter=MD 8bd275bba0dc13273eff366e348378d41ad5535e -- src
git diff --name-only --diff-filter=A 8bd275bba0dc13273eff366e348378d41ad5535e -- src
git diff --name-only --diff-filter=MD 8bd275bba0dc13273eff366e348378d41ad5535e -- test
# The layer manifest equals the import closure of src/bound/index.ts.
node --experimental-strip-types --test test/unit/bound-layer-manifest.test.ts
# The capability is decided only inside the layer, and no upstream channel is occupied.
git grep -n boundForegroundLeaf -- src   # only src/bound/index.ts and src/bound/bound-self-check.ts
git grep -n "subagents:rpc:v1\|prompt-template:subagent" -- src/bound   # only the explanatory comment in src/bound/index.ts
```

`LC_ALL=C` is required: upstream `test/integration/async-execution.part-2.test.ts`
matches English git error text and fails under a localized git, on this build and on
a pristine upstream checkout alike.

A1 probes (`test:probe:active-runtime`), the packed-package check and the real
Git-installed stop-gate return in A1R.5; that probe runs on a Linux host, because
source identity is unavailable elsewhere.
