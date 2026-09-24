# S3 P2 — producer: cold MCP discovery and a verifiable cancellation

Source of decisions: onecpi `docs/plans/bound-v2-s3-native-repair.md`, commit
`74dea4ef785171a22042d28b89bf89cacd238770`, SHA256
`11ff7c96333edf879e073693141ccbfedfab0e60d25196af1c15c8f1792adb1f` (D1–D4, R1–R12),
with the immutable invariants of `bound-v2-native-migration.md` @ `41438fe`.
Base: producer P `5fae1057e3e742fef60d2ccb34c2fd3f23fea444`. This is the
producer slice S1 only. It is **not** native acceptance: the pair is not accepted
before the agreed consumer C2 exists and the separate S3 acceptance ran. Nothing
was installed into any Pi, no config was changed, nothing was pushed.

## Spikes (go/no-go before production code)

Environment, read only: Pi SDK 0.87.1 and an owner package with pi-mcp-adapter
2.26.1 from `/home/itrous/src/onecpi-bound-v2-validation/pio-136-bootstrap-01`
(`sdk/`, `owner/`).

- **D2, private adapter ABI** — `spikes/S3-P2/spike-d2-bridge.ts`
  (`PI_SUBAGENTS_MCP_OWNER=<owner> node --experimental-strip-types …`). Through
  the bound attested-roots importer: `server-manager.ts` exports
  `McpServerManager` (connect/close/closeAll/getConnection/
  setMetadataListChangedListener/setRuntimeSignal), `direct-tools.ts` exports
  `resolveDirectTools`/`createDirectToolExecutor`. A file outside the attested
  roots is refused by the guard. Cold live discovery of a fixture server: 239 ms;
  `resolveDirectTools` over an in-memory metadata object built from the live
  connection gives exactly the two explicit selectors (the third server tool,
  `execute`, stays inactive); the adapter's own executor returns
  `fixture:spike:search`; `close` 4 ms, the server process exits; the agent dir
  listing is identical before and after (no `mcp-cache.json`). Entry digests
  pinned: `server-manager.ts`
  `dd920670643db7208934eca2fe63b7ba2689e49be2126853c87dfcdbe9591da6`,
  `direct-tools.ts` `a1a45b8a329b6f2b97918877b1c6f94cc4bc0336af3df0caaa0fff679d562351`.
  **Go.** No adapter edit, no new dependency, no other direct entry.
- **D3, observable disposal** — `spikes/S3-P2/spike-d3-disposal.ts`
  (`PI_SUBAGENTS_NATIVE_SDK=<sdk> node --experimental-strip-types --import ./test/support/register-loader.mjs …`).
  On the real 0.87.1 `AgentSession`, for a `session_shutdown` handler that
  returns / hangs / throws: the handler runs once; `dispose()` takes 0 / 2000 /
  0 ms with a 2000 ms bound; afterwards the extension's captured ctx is stale in
  all three cases (the observable revocation); a second `dispose()` is a no-op.
  `AgentSession.dispose()` is synchronous. **Go**, with the seam below to record
  which of completed/deadline/failed happened.

Observation: the bounded wait uses an unref'd timer, so a bare script whose event
loop holds nothing else exits with an unsettled top-level await; inside Pi the
loop is alive. Not a product change.

## What changed (production code)

See FORK.md, section "S3 P2 repair contract". In short:

- D1/D4 wire: `methods = [ping, preflight, prepareMcp, releaseMcp]`;
  capabilities `boundMcpDiscovery:1`, `boundCancellationProof:1` beside the leaf,
  only when the port issues proofs from its own lifecycle; request `safety`;
  `contract.safety` and `contract.cancellationPolicy` (3000/2000/1000) inside both
  digests; `mcpConfig` v2 prepare/final shapes; `contract.mcpConfig` v2 with
  `snapshotDigest`, `packageEvidenceDigest`, `entryDigests`, `bridge`;
  `terminal.cancellationProof`. Legacy v2 requests (no `safety`) keep their request
  and contract bytes; their cancelled terminal is marked incomplete.
- D2: `bound-mcp-preparation.ts` (records, ticket/TTL/capacity/ownership),
  `bound-mcp-direct-bridge.ts` (measurement, ABI import, bounded discovery, the
  bridge factory), `bound-mcp-selections.ts` (snapshot handles for the tool plan),
  service methods `prepareMcp`/`releaseMcp`/`claimMcp`, resolver prepare stage.
- D3: coordinator latch without the cancel projection, run revocation (bindings,
  barrier, tool calls, MCP owner signal), the disposal handle from the start of
  creation, sealed collectors, proof construction, the not-admitted branch.

Bounded refusal codes of the new methods: `mcp_adapter_unverified`,
`mcp_config_invalid`, `mcp_config_mismatch`, `mcp_selector_invalid`,
`mcp_selector_unresolved`, `mcp_metadata_invalid`, `mcp_discovery_failed`,
`mcp_discovery_timeout`, `mcp_discovery_aborted`, `mcp_discovery_capacity`,
`mcp_ticket_invalid`, `mcp_snapshot_drift`, `mcp_release_failed` — never the
configuration text.

## Deviations and residual risks (named, not hidden)

1. **Page budget through the manager's trace hook.** The pinned manager lists all
   pages without a limit; the 32-page and 1 MiB budgets are enforced by an
   instance-scoped observer placed in the manager's own `traceWriter` field (an
   internal of the pinned `server-manager.ts` bytes), which aborts the discovery.
   No file is written. A server definition with `trace` is refused, so it cannot
   switch the observer off. If this is judged beyond "the two entries", it is the
   point to re-decide; the remaining budgets (10 s, 1024 tools, post-hoc 1 MiB of
   declarations) do not depend on it.
2. **Supported configuration.** `bound-direct/v1` refuses HTTP/OAuth/header/
   `trace`/`pluginDataDir` servers (ambient credential storage, interactive auth,
   disk side effects). The production 1C servers are stdio (`bsl-analyzer`) and
   stay supported; env interpolation of the trusted config is unchanged.
3. **`mcp-direct-tool-allowlist.ts` seam.** `loadMcpConfig` is exported so the
   discovered-vs-attested definition comparison (kept by D2) needs no metadata
   cache. This is a fourth upstream file beyond the three named in S1 — a one-word
   change, documented in FORK.md.
4. **Real startup time is unmeasured.** The 10 s discovery budget is proven on
   fixture servers only. A cold `bsl-analyzer` may start slower; then prepare
   fails closed (`mcp_discovery_timeout`), it never falls back.
5. **Q1 unchanged.** In-process code is not an OS sandbox; a signal-ignoring tool
   and its grandchildren may keep running after the proof; they get no new bound
   capability, provider request, update or result.

## Stop conditions of the plan, status

No adapter edit, no new dependency, no other private entry, no bypass of the
bound package facade or attestation, no manual warmup, no fallback to built-ins
or v1, no downgrade. None of the stop conditions was hit.

## Review and checks (post-review doc-only change: this section and one line above)

onecpi code review, `--uncommitted --plan <S3 plan>`, 4 rounds on the tree of code
plus the prepared (uncommitted) tests:

| Round | reviewId | Gate | Findings |
|---|---|---|---|
| 1 | `20260924-113252-47fa7d` | rerun (1 lens failed format) | 1 high, 1 mid, 3 low — all upheld and fixed |
| 2 | `20260924-115345-8889d3` | revise | 2 high, 2 mid, 1 low — 4 upheld/fixed, 1 mid rebutted |
| 3 | `20260924-120646-dd38e0` | revise | 1 high, 3 mid, 2 low — 3 upheld/fixed, 3 rebutted |
| 4 | `20260924-122128-631c61` | **closed**, effectiveBlocking 0, nextAction ready, lenses 4/4, attestations ok, no drift | 2 mid upheld as residual, 1 low rebutted |

Round 4 revision: head `5fae1057e3e742fef60d2ccb34c2fd3f23fea444`, tree
`9c28ce585528b883ba6f0a3997b57a4fd3f7bbcad7c753e01221c7b6d43b25b8`; the code-review
report carries no `scope.subjectHash`. Verdicts are recorded in the review ledger.

Residual risks from round 4 (accepted, not fixed): an admitted preparation whose
every run-level close fails keeps its capacity slot and its server processes; a
failed discovery whose `closeAll` exceeds 2 s loses the manager without a retry.
Both stay fail-closed (no ticket, no new capacity) and need an adapter whose
close does not finish.

Checks on the reviewed tree (`PI_SUBAGENTS_NATIVE_SDK`/`PI_SUBAGENTS_MCP_OWNER`
from `pio-136-bootstrap-01`, `PI_SUBAGENTS_DISK_TMP=<worktree>/tmp/s3p2`):
`tsc --noEmit` 0 errors; unit 3625 tests, 3613 pass, 8 fail, 4 skipped — the 8 are
the known `acceptance-compaction.test.ts` baseline (`VERSION === "0.85.1"` on SDK
0.87.1), reproduced on the base `5fae1057` (3615/3603/8/4); integration 1107 tests,
1100 pass, 0 fail, 7 skipped (maintainer smokes, as on the base 1102/1095/0/7);
`bound-s3-p2-real-sdk.test.ts` 5/5 on the real SDK and adapter. The whole suite
is not green because of that baseline. The new and adjusted tests are left
uncommitted for the independent test stage.

This is a bootstrap CLI review, not Pi-native acceptance; S3 acceptance needs
C2 and a separate isolated run.
