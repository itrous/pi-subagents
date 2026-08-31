# Landing A1P4 — Capability-based Pi runtime compatibility

## Problem

Active-bound admission and the onecpi installer currently reject every Pi version
except `0.84.3`. This causes false incompatibility failures on compatible patch
releases (currently Pi `0.84.4`). Version identity is useful evidence, but it is
not itself a capability or a compatibility result.

## Invariants

1. No semver allowlist/range controls active-bound admission or installer migration.
2. Pi version remains bounded evidence and parent/child drift must still fail closed.
3. Admission derives the complete runtime-owned builtin set from the exact attested
   spawned Pi package's capability export; it does not use the session-filtered
   `getAllTools()` subset and does not infer ownership from a version.
4. The parent binds the canonical builtin-name projection into the launch contract,
   policy and digest. The child independently re-measures the same runtime package
   capability export and its visible requested builtin ownership before the first
   provider request.
5. Package and MCP tools cannot own or shadow any dynamically attested runtime
   builtin. Runtime/internal reserved names remain protected independently.
6. Requested tools absent from the runtime, removed APIs, malformed source metadata,
   registry drift, payload-shape drift, model API drift, command/runtime drift and
   package/runtime mutation continue to fail before provider execution.
7. The exact spawned Pi command and its package remain byte-attested. Its reported
   version is an identity string only and must match between parent evidence and
   child execution; no value is intrinsically accepted or rejected.
8. Standalone/legacy subagent behavior is unchanged.
9. Installer native migration performs staging and production compatibility canaries
   without a version pre-gate. An incompatible runtime leaves/restores the currently
   working managed exact source.
10. Publication probes run against the installed active runtime without an exact
    required-version skip.

## Fork implementation

### Runtime capability projection

- Add a bounded canonical runtime-builtin projection (`version`, sorted unique names,
  digest) with strict name/count/byte limits.
- Obtain the complete set from the exact spawn-target Pi package's bounded
  `allToolNames` capability export in a one-time, isolated probe. Bind the package
  version as identity evidence, not admission policy.
- Do not use session-filtered `pi.getAllTools()` as the complete ownership source.
- Pass the projection into active-bound resolution rather than using a static core set.

### Contract and policy

- Bind runtime version identity obtained from the attested spawn command, not the
  package-local test shim.
- Include runtime builtin projection in the tool-registry contract, policy and digest.
- Remove `SUPPORTED_BOUND_PI_VERSIONS` and every version-membership check.
- Keep child `pi --version === parent runtime identity` and command/package evidence.

### Ownership and execution gate

- Classify requested core tools using the live builtin projection.
- Pass the same set through launch-tool planning for package/MCP collision checks.
- Reserve the projected builtin set in package factory ownership.
- Before the first provider request, independently project the child spawn-target
  runtime package's full capability export and require exact equality with the bound
  parent projection. Also verify visible requested builtin ownership, then retain the
  existing active-registry/provider-payload barrier.

### Tests/probes

- Unit: arbitrary version identities admitted when capabilities match; version drift
  rejected; removed/added/shadowed builtin ownership rejected or safely projected;
  package/MCP collisions with dynamically discovered builtin rejected.
- Integration: installed runtime test no longer exact-version-skips.
- Active runtime probe: Pi 0.84.4, real package/binary identity, exact current builtin
  ownership and successful zero-provider compatibility preflight/canary.

## onecpi implementation

- Remove the installer `case pi --version` allowlist.
- Readiness accepts a bounded runtime identity and verifies the bound capability
  projection/digest instead of `=== 0.84.3`.
- Pin the new reviewed fork SHA. Treat `d2569d3...` as the managed predecessor for the
  existing durable exact-to-exact transaction while preserving npm/none lineage.
- Update canary, tests and installation documentation to describe capability-based
  rejection rather than version admission.

## Verification

1. Fork typecheck, full unit, integration and E2E suites.
2. Required installed-registry test and active-runtime publication probe on Pi 0.84.4.
3. onecpi source and bin suites.
4. Isolated real `d2569d3...` exact → new exact upgrade with the unchanged command,
   staging + production canaries and `pi update --extensions`.
5. Negative canaries for missing/renamed/shadowed builtins and parent/child version,
   ownership or payload drift; provider request count remains zero on rejection.
6. Independent plan and implementation review; close critical/high before publication.

Paid corpus/parity runs remain out of scope without separate approval.
