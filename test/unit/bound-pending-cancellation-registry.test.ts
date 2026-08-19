import assert from "node:assert/strict";
import { test } from "node:test";
import { BoundPendingCancellationRegistryV1 } from "../../src/slash/bound-pending-cancellation-registry.ts";

function binding(expiresAt = 31_000, target = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") { const run = "123e4567-e89b-12d3-a456-426614174000"; return { version: 1 as const, targetServerInstanceId: target, prospectiveRunId: run, expectedSourceIdentityDigest: "a".repeat(64), expectedActiveSessionDigest: "b".repeat(64), requestDigest: "c".repeat(64), expectedLaunchContractDigest: "d".repeat(64), receipt: {} as never, cancellationToken: { version: 1 as const, algorithm: "HMAC-SHA256" as const, payload: { version: 1 as const, serverInstanceId: target, sourceIdentityDigest: "a".repeat(64), activeSessionDigest: "b".repeat(64), prospectiveRunId: run, requestDigest: "c".repeat(64), launchContractDigest: "d".repeat(64), issuedAt: 1000, expiresAt, requestId: "r", ownerRunId: "o", nodeId: "n" }, mac: "e".repeat(64) } }; }
const tuple = { requestId: "r", ownerRunId: "o", nodeId: "n" };
test("bound pending cancellation is exact, one-shot, and expiration releases capacity", () => {
	let now = 1000; const registry = new BoundPendingCancellationRegistryV1(() => now, 1); const proof = binding();
	assert.equal(registry.remember(tuple, proof), true); assert.equal(registry.remember({ requestId: "x", ownerRunId: "o", nodeId: "n" }, proof), false);
	assert.equal(registry.consume(tuple, { ...proof, requestDigest: "f".repeat(64) }), false); assert.equal(registry.consume(tuple, proof), true); assert.equal(registry.consume(tuple, proof), false);
	assert.equal(registry.remember(tuple, proof), true); now = 31_000; assert.deepEqual(registry.snapshot(), { pending: 0 }); assert.equal(registry.remember({ requestId: "x", ownerRunId: "o", nodeId: "n" }, binding(61_000)), true);
});

test("same tuple remains independently cancellable across server generations and reissued bindings", () => {
	const registry = new BoundPendingCancellationRegistryV1(() => 1000, 3); const oldBinding = binding(); const newBinding = binding(31_000, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
	const reissued = structuredClone(oldBinding); reissued.cancellationToken.mac = "f".repeat(64);
	assert.equal(registry.remember(tuple, oldBinding), true); assert.equal(registry.remember(tuple, newBinding), true); assert.equal(registry.remember(tuple, reissued), true); assert.deepEqual(registry.snapshot(), { pending: 3 });
	assert.equal(registry.consume(tuple, reissued), true); assert.equal(registry.consume(tuple, newBinding), true); assert.equal(registry.consume(tuple, oldBinding), true);
});
