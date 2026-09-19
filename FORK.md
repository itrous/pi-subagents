# itrous/pi-subagents fork

This repository is the `itrous/pi-subagents` security-focused fork used by the
OneCPI native review transport.

## Status: A1R.1 — base only, bound capability absent

This build is upstream `8bd275bba0dc13273eff366e348378d41ad5535e` plus a few
unwired fork modules. The A1 bound/active-runtime contract is **not** available
here: the child-process machinery it relied on was removed upstream in `d9bc62f8`
(#1844, in-process child sessions), so `boundForegroundLeaf` is not announced and
every OneCPI readiness probe fails closed (`malformed_ping`).

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

Every upstream file is taken from the A1R.1 base verbatim
(`git diff --name-only --diff-filter=MD <base> HEAD` is empty). What remains of the
A1 delta are unreferenced modules kept for stages A1R.3/A1R.4:
`src/shared/canonical-json.ts`, `src/extension/source-identity.ts`,
`src/runs/shared/core-runtime-tools.ts`, `src/runs/shared/package-tree-evidence.ts`,
`src/api/launch-receipt.ts`, `src/api/active-bound-environment.ts`,
`src/slash/bound-identity-registry.ts`.

Removed here because they encode the child-process model or its installer:
the bound tool-registry runtime (bootstrap/gate/runtime/state), package mediator,
denied-tool runtime, registry collector, `pi-command-evidence`,
`bound-runtime-evidence`, `active-bound-resolver`, `active-bound-runtime`,
`install-lib.mjs`, `test/probes/`, and the fork tests covering them.

Deferred to A1R.3/A1R.4 (removed only because they cannot typecheck against the new
upstream API, not because the behaviour is dropped): `tool-registry-proof`,
`denied-tool-proof`, `active-bound-preflight`, `active-bound-package-extensions`,
`bound-pending-cancellation-registry`, `structured-attempt-coordinator`, plus their
tests and `test/fixtures/active-runtime-parent-probe.ts`.

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
LC_ALL=C npm run test:integration
node --experimental-strip-types --test test/unit/source-identity.test.ts
```

`LC_ALL=C` is required: upstream `test/integration/async-execution.part-2.test.ts`
matches English git error text and fails under a localized git, on this build and on
a pristine upstream checkout alike.

A1 probes (`test:probe:active-runtime`), the packed-package check and the real
Git-installed stop-gate return in A1R.5 once the bound layer is reconnected.
