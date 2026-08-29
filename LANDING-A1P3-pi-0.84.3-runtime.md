# Landing A1P3: admit and attest Pi 0.84.3

## Goal

Extend the exact active-bound runtime contract from Pi 0.84.1/0.84.2 to Pi
0.84.3 without weakening tool-registry, package ownership, runtime-byte, source
identity, cancellation, or single-execution proofs. This landing produces a new
exact fork SHA for onecpi; changing the onecpi production pin and performing the
old-exact → new-exact migration is a separate follow-up landing.

## Contract

1. Add only `0.84.3` to `SUPPORTED_BOUND_PI_VERSIONS`; do not admit a range or
   future patch versions.
2. Pi 0.84.3 adds the runtime-owned `powershell` builtin. Add it to the canonical
   core/reserved set; derive the child diagnostic's implicit Pi core set from the
   same source. Derive direct-MCP builtin collision protection from the canonical
   core set plus the existing special `mcp` name (not from the broader reserved
   coordination set), so a package or MCP projection can neither own nor shadow
   `powershell` and the existing `mcp` collision remains rejected. The same strict
   provider-payload registry proof, runtime/package extension byte
   attestation, denial FD, launch receipt and process-terminal evidence remain
   mandatory on 0.84.3.
3. Update the active installed-runtime probe to accept exactly 0.84.1, 0.84.2 or
   0.84.3 and assert that the Pi executable and imported SDK package report the
   same version.
4. Add/adjust unit coverage proving 0.84.3 policy acceptance, adjacent
   unsupported-version rejection, the exact eight runtime-owned builtin names,
   rejection of package ownership for `powershell`, child availability of the new
   core tool, and direct-MCP collisions for both `powershell` and `mcp`. Keep drift
   tests pinned to explicit fixture versions where they intentionally test mismatch.
5. Make the installed bound-tool-registry integration accept an explicit
   `PI_SUBAGENT_REQUIRED_PI_VERSION=0.84.3` gate: absence/mismatch must fail rather
   than skip, with a deterministic negative-control test for mismatch. Run it with
   that gate against the real local Pi 0.84.3 runtime. It
   must exercise the actual builtin registry and package-owned tool projection,
   not only a mocked version string.
6. Fix active-runtime probe runtime-root discovery for the current
   `dist/bundle/cli.js` executable layout, then run
   `A1_PROBE_EXPECTED_COMMIT=<landing-sha> npm run test:probe:active-runtime` on
   real Pi 0.84.3. This is a required publication gate and proves stop-gate,
   denial FD, cancellation, reload/replacement and single-execution behavior.
7. Run typecheck, unit and integration suites. The known runtime-dependent E2E
   suite may skip only through its existing explicit skip contract; no skip is
   added for 0.84.3.
8. Independently review the fork diff before publishing. The resulting exact SHA
   is immutable input to the onecpi upgrade landing.

## Follow-up boundary in onecpi

After this landing is published, onecpi must:

- update its installer and preflight allowlists to 0.84.3 and the new exact SHA;
- add a fail-closed transaction for an already active old exact pin, preserving
  the original npm/none rollback receipt while replacing checkout and settings;
- stage and canary the new exact source before production switch;
- prove rollback, interrupted-upgrade recovery, `pi update --extensions`, and the
  production zero-cost canary on Pi 0.84.3.

Simply allowing 0.84.3 in `bin/install.sh` is forbidden: the old exact fork
returns `unsupported_mode` on that runtime.

## Non-goals

- no support for Pi 0.85.x or unbounded semver ranges;
- no behavioral changes to background/general subagent execution;
- no native Claude transport;
- no paid model or corpus run.
