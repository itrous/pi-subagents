# A1P addendum: bounded per-pass owner evidence cache

E1 packed probe with five package-tool carriers exposed deterministic timeout:
active-bound resolver calls `resolveActiveBoundPackageExtensions` for every package
agent, and each call independently hashes the same full owner dependency tree.
Zero-tool merge reached provider but terminal missed its 30s deadline solely because
unrelated package agents repeated identical evidence scans. Removing E1 agents
restored Landing D probe. Global/stale cache is forbidden because mutation between
preflight and spawn must remain detectable.

## Решение

Добавить optional resolver-pass cache, owned by one complete discovery/resolution
pass and discarded afterwards. `resolveActiveBoundPackageExtensions(agent, cache)`
may reuse package-tree evidence only by closed key containing canonical evidence
root and bounded resolution owner root. Entry path is not part of digest input
except boundary validation; every call still validates current entry file,
contentDigest, ref, owner/dependency manifests and canonical paths before cache use.

`resolveActiveBoundLaunchContract` creates a fresh cache for initial discovery.
Completion barrier использует два уровня: fresh discovery всех кандидатов может
иметь свой новый cache, но заключительный `freshResolved.agent` вызов получает
ещё один новый cache (либо идёт без cache) и обязательно повторно хеширует owner
после discovery. Preflight и pre-spawn barrier также никогда не делят cache. Direct callers without cache preserve
current behavior. Runtime child `verifyPackageEvidence` remains uncached and
re-hashes actual bytes before provider request.

## Tests

- N agents from one owner perform one tree hash per resolver pass while each
  wrapper content digest remains distinct;
- initial, fresh-discovery и final-selected измерения не делят cache; мутация
  между fresh discovery и final-selected rehash обнаруживается;
- different owner/evidence roots never share entries;
- malformed/symlink/entry drift still fails before cache reuse;
- packed E1 agent set restores Landing D zero-tool completed/cancel under deadline;
- A1P custom-tool packed execution, full fork suite and independent review green.

No DTO/version/tool policy/cancellation/runtime proof changes. Cache cannot outlive
one synchronous observational pass and does not cross preflight/delegation barrier.
