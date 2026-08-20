# A1.3: bounded per-request child environment

## Epoch and scope

Base `ba04e1cec32f160d42c83085cb75e06a6bd596b0` after closed A1.2. The first
A1.3 plan epoch combined environment and artifact storage and was split after its
review budget exposed independent storage semantics. The second environment-only
epoch exhausted its budget while defining Windows case-folding and UTF-16 bounds;
the third exposed that a restorable in-process guard cannot prove absence of
whole-property replacement. This deliberate fourth epoch retains the closed two-key
design and moves the no-mutation proof into a disposable process with an irreversible
guard. Session
artifacts move to A1.4 with a separate storage design and review.

Legacy/unbound execution is unchanged. Package-owned extension refs, artifacts,
final tool registry/denial proof, exact cancellation, installer and real-Pi probes
remain deferred. Provider credentials, arbitrary environment keys, caller-supplied
extensions and async/workflow/Fleet are forbidden.

## Closed bound DTO

`ActiveBoundPreflightRequestV1` adds optional:

```ts
environment?: {
  ONECPI_REVIEW_ROOT?: string;
  ONECPI_REVIEW_SUBJECT_PATH?: string;
};
```

It is an own enumerable plain object with no symbols/accessors/prototype tricks or
unknown keys. Omitted and `{}` normalize to the same empty environment. Bounds are
checked before canonicalization: at most two entries; key at most 64 UTF-8 bytes;
each value non-empty, NUL-free, contains no unpaired UTF-16 surrogate, and is at
most 4096 UTF-8 bytes; total key+value bytes at most 8192. Only the two literal
uppercase names above are accepted, so lowercase/case variants, `PI_SUBAGENT_*`,
`PI_INTERCOM_*`, auth/provider and every unknown key fail closed without invoking
getters.

The structured-delegation DTO/parser accepts `environment` only when a valid bound
`binding` is present. Its presence without binding remains `invalid_request`;
existing legacy `artifacts` behavior is untouched. The delegation-to-preflight
adapter copies the normalized environment exactly. Public preflight, request digest,
receipt, admitted private proof and executor therefore represent one request.

## Projection and digest

The launch contract adds:

```ts
environment: {
  version: 1;
  names: string[];
  valuesDigest: string;
};
```

Names are sorted and unique. `valuesDigest` is SHA-256 of canonical
`{version:1,entries:[{name,value}]}` with entries in name order. Empty environment
has one stable independent vector. No raw value appears in the public preflight
response, errors or launch contract.

The canonical request digest includes normalized entries. `launchBindingDigest`
includes the environment projection, and the immediate `beforeSpawn` callback
compares the actually materialized projection. Name/value mutation is therefore
caught at admission, preparation and final spawn barriers.

## Spawn isolation

The private active-bound proof carries request values to execution; public executor
params cannot set them. `RunSyncOptions` receives a private copied
`childEnvironment` and its projection only in bound mode.

For each bound attempt, a new pure `buildBoundSpawnEnvironment(inherited,
requested,hostOwned)` helper copies its input and removes every inherited key whose
ASCII-uppercase spelling equals either allowlisted ONECPI name (required for
Windows' case-insensitive environment) or starts with uppercase
`PI_SUBAGENT_`/`PI_INTERCOM_`. This deliberately upgrades the current bound cleanup,
which is case-sensitive. The helper then overlays exactly the request's
canonical uppercase names and host-owned launch variables. Omitted allowlisted keys
and ambient case variants are absent in the child. Legacy attempts keep their
current inherited environment behavior.

Environment is supplied only as `spawn(...,{env})`; no path writes and no assignment,
delete or temporary overlay touches `process.env`. Preparing two concurrent children
with different values cannot expose one request's values to the other.

## Landing

Implement wire parsing, normalization/projection, resolver and launch digest first;
then carry values through the private proof to `RunSyncOptions` and exact spawn env.
This is one coherent landing because a public preflight projection without matching
spawn semantics must not be committed or advertised.

## Acceptance

- independent vectors cover omitted, `{}`, one and both entries; omitted and `{}`
  produce identical normalized request/projection digests, and reversed input key
  order produces the same sorted names/entries/digests; name/value mutations differ;
- a valid astral character encoded as one UTF-16 surrogate pair is accepted and
  hashed by its UTF-8 bytes; descriptor/prototype/symbol/unknown/reserved/case-
  variant/empty/NUL/unpaired-surrogate/oversized inputs fail without
  getter execution, started, identity consumption, filesystem or environment effects;
- delegation without binding still accepts its legacy fields but rejects environment;
  bound delegation reconstructs the exact preflight request digest;
- preflight response recursively contains neither raw value;
- preflight/admission leave recursive filesystem, budget and `process.env` unchanged;
- child A and child B are held at a deterministic mock-child barrier until both have
  spawned, then released together; each receives only its own values, while poisoned
  ambient canonical and mixed-case allowlisted keys and an omitted key are absent;
  poisoned `Pi_Subagent_*` and `pi_intercom_*` variants are also absent, proving the
  wildcard `PI_SUBAGENT_*`/`PI_INTERCOM_*` stripping is ASCII-case-insensitive;
- a dedicated disposable Node process installs `process.env` as a
  **non-configurable** accessor for its remaining lifetime. Its getter returns a
  Proxy over the original environment; its setter records and throws on whole-object
  assignment. The Proxy's `set`, `deleteProperty` and `defineProperty` traps record
  and throw. Non-configurability makes delete/redefinition bypasses fail, and process
  exit removes the need to restore the descriptor. That process executes complete
  bound preparation/spawn with mock Pi and asserts zero setter/trap operations plus
  original values in `beforeSpawn` and the spawn spy. A separate ordinary test keeps
  the parent runner environment restorable;
- materialized projection mismatch causes zero spawn/provider, restored transactional
  budget and normal A1.2 owned-root cleanup;
- a positive unbound process test poisons the two ONECPI keys and proves the legacy
  child still inherits both unchanged, while the bound child strips/overlays them;
- retryable provider failure still performs one model attempt; legacy delegation,
  current bound and RPC closed-response tests remain green;
- run typecheck, focused unit/process tests, `npm run test:all`, `git diff --check`,
  intended-file audit and independent zero-blocker diff review before local commit.

## Gate

This brief is subordinate to unchanged GitHub issue #1 and reviewed master plan. It
is a new review epoch after explicitly splitting storage from environment. Before
code, run independent `--review-plan --adjudicate --runs 2`; start only with a
closed, zero-blocker, non-truncated, non-drifted result whose subject hash equals the
current file SHA-256. Push and issue updates are not implicit.
