# itrous/pi-subagents fork

This repository is the `itrous/pi-subagents` security-focused fork used by the
OneCPI native review transport.

## Upstream base

- Upstream release: `v0.46.0`
- Peeled base commit: `4a2d5284a2ac6a6b0282059e756fc5ee8dbdd58c`
- Annotated tag object: `3841f11cdc51070fe0c1af98c0083c50c5c984bb`
- Fork repository: `https://github.com/itrous/pi-subagents.git`

## Fork delta

The A1 delta adds a versioned active-runtime API for bounded foreground leaves:

- clean detached Git source identity and single active responder;
- side-effect-free preflight plus receipt-bound admission and final recheck;
- bounded child environment, runtime-owned artifacts, and attested package refs;
- measured pre-provider tool-registry and denied-tool proofs;
- exact authenticated cancellation, private Fleet projection, headless drain, and
  reload/replacement lifecycle handling.

It does not include the OneCPI review engine, routes, prompts, corpus, or its MCP
adapter. Those are integrated by the downstream A2 landing.

## Immutable installation

Never install this fork from a branch, floating tag, abbreviated SHA, or `git
pull`. Choose a reviewed 40-character lowercase commit and pin it explicitly.

Use the protected extension-directory installer:

```sh
npx git+https://github.com/itrous/pi-subagents.git#<40-hex-commit> \
  --commit <40-hex-commit>
```

Do not update this fork through Pi's package reconciler: that mechanism deliberately
uses hard reset/clean and is unsuitable when an existing checkout must be rejected
or preserved if it contains local state. The attested installer is fail-closed on non-Linux hosts because its final
checkout verification is anchored through procfs. Installer candidates, retained
previous checkouts, and recovery markers live in
`$PI_CODING_AGENT_DIR/.pi-subagents-installer`, outside extension discovery. A
SIGKILL may leave `install.lock`; automatic stale-lock takeover is intentionally
forbidden, so remove that lock manually only after confirming no installer process
is active. `install.mjs` intentionally requires the exact commit as input. A Git commit
cannot contain its own SHA in its committed bytes, so there is no self-referential
"latest A1" default. The installer verifies the fork origin, refuses dirty
existing checkouts, fetches the requested object, checks it out detached, installs
production dependencies, and verifies the resulting state.

## Updating from upstream

1. Create a dedicated task branch/worktree from an explicitly reviewed upstream
   base; do not merge a floating upstream branch.
2. Reapply the fork delta deliberately and review contract or threat-model drift.
3. Run focused A1 tests, the complete upstream suite, packed-package checks, and
   the real Git-installed Pi stop-gate.
4. Create a new immutable candidate commit. Never amend or replace a published
   A1 commit.
5. After explicit approval, push the candidate, install it from the canonical
   GitHub repository by exact SHA in an isolated Pi home, and repeat the stop-gate.
6. Publish that exact SHA to downstream consumers only after the independent
   review and GitHub-installed probe are closed.

## Verification

```sh
npm run typecheck
node --experimental-strip-types --test test/unit/source-identity.test.ts
node --experimental-strip-types --import ./test/support/register-loader.mjs \
  --test test/integration/fork-installer.test.ts
node --experimental-strip-types --import ./test/support/register-loader.mjs \
  --test test/integration/active-bound-lifecycle.test.ts \
         test/integration/bound-tool-registry-installed.test.ts
npm run test:all
npm pack --dry-run
A1_PROBE_EXPECTED_COMMIT=<40-hex-commit> A1_PROBE_SOURCE_MODE=local \
  npm run test:probe:active-runtime
```

`A1_PROBE_SOURCE_MODE=local` is a pre-push control: it installs exact local Git
bytes and then applies the canonical origin solely for source-attestation testing.
It does not replace the authoritative post-push run with
`A1_PROBE_SOURCE_MODE=github`. The final release gate additionally requires a new Pi parent using the package
installed from the canonical GitHub URL at the published exact SHA. The probe must
enter through a real registered `ToolDefinition.execute`, observe one responder,
verify pre-turn registry proof, exact cancellation, Fleet, headless, and reload,
and must not load a second copy of `pi-subagents`.
