# itrous/pi-subagents fork

This repository is the `itrous/pi-subagents` security-focused fork used by the
OneCPI native review transport.

## Status: A1R.3 — control plane v2 up, leaf execution and capability pending

This build is upstream `8bd275bba0dc13273eff366e348378d41ad5535e` plus the fork
control plane on `subagents:bound:v2:*` (`src/bound/`): ping, side-effect-free
preflight with the v2 launch contract, receipt/HMAC admission with a final
re-resolution, targeted cancel, the attempt coordinator and identity registries,
reload/drain, and a bounded stop for every child session. Leaf execution and the
`boundForegroundLeaf` capability land in A1R.4, so the preflight contract is
served but nothing is launched yet (an admitted request terminates with
`unavailable_context`), and every OneCPI **A1 (v1)** readiness probe still fails
closed with `malformed_ping`: the bound layer does not listen on
`subagents:rpc:v1:*` at all.

**Platform limit.** The bound channel answers everywhere, but a launch contract
is only issued on a Linux host: `resolveActiveRuntimeSourceIdentity`
(`src/extension/source-identity.ts:277`) returns `unverified_source` on any
non-Linux platform or without `/proc/self/fd`. On macOS and Windows the ping
carries `sourceIdentityUnavailable`, `capabilities` is empty, and preflight
refuses with `unverified_source`. Tests inject the identity through the
`resolveSourceIdentity` seam and therefore stay green on every platform.

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

Every upstream file is taken from the A1R.1 base verbatim except one hook point:
`git diff --name-only --diff-filter=MD <base> HEAD -- src` reports exactly five
paths — `src/extension/index.ts` (T1: the import and the single
`registerBoundControlPlane({...})` call right after the RPC bridge) plus the four
carries `src/agents/agent-memory.ts`, `src/runs/shared/long-running-guard.ts`,
`src/runs/shared/permissions.ts`, `src/shared/jsonl-writer.ts`. The accompanying
upstream tests are the same four files as before; A1R.3 edits no upstream test.

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

Still deferred to A1R.4 (execution): `denied-tool-proof`, the `ChildSessionFactory`
decorator, the `streamFunction` barrier, the `MCP_DIRECT_TOOLS` window, the denial
collector, `test/fixtures/active-runtime-parent-probe.ts`, and the announcement of
`boundForegroundLeaf`.

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
LC_ALL=C npm run test:integration   # под нагрузкой добавить --test-concurrency=2
node --experimental-strip-types --test test/unit/source-identity.test.ts
# Fork edit surface: exactly five upstream src files (T1 plus four carries).
git diff --name-only --diff-filter=MD 8bd275bba0dc13273eff366e348378d41ad5535e -- src
# The layer manifest equals the import closure of src/bound/index.ts.
node --experimental-strip-types --test test/unit/bound-layer-manifest.test.ts
# The bound capability is not announced, and no upstream channel is occupied.
git grep -n boundForegroundLeaf -- src
git grep -n "subagents:rpc:v1\|prompt-template:subagent" -- src/bound
```

`LC_ALL=C` is required: upstream `test/integration/async-execution.part-2.test.ts`
matches English git error text and fails under a localized git, on this build and on
a pristine upstream checkout alike.

A1 probes (`test:probe:active-runtime`), the packed-package check and the real
Git-installed stop-gate return in A1R.5 once leaf execution is connected; that
probe runs on a Linux host, because source identity is unavailable elsewhere.
