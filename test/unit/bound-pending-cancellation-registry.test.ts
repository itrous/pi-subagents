import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BOUND_PENDING_CANCELLATION_GLOBAL_KEY, BoundPendingCancellationRegistryV2, getBoundPendingCancellationRegistry,
} from "../../src/bound/bound-pending-cancellation-registry.ts";
import type { BoundBindingV2 } from "../../src/bound/channel.ts";

const tuple = { requestId: "r", ownerRunId: "o", nodeId: "n" };

function binding(expiresAt = 31_000, target = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"): BoundBindingV2 {
	const run = "123e4567-e89b-12d3-a456-426614174000";
	return {
		version: 2, targetServerInstanceId: target, prospectiveRunId: run,
		expectedSourceIdentityDigest: "a".repeat(64), expectedActiveSessionDigest: "b".repeat(64),
		requestDigest: "c".repeat(64), expectedLaunchContractDigest: "d".repeat(64),
		receipt: {} as never,
		cancellationToken: {
			version: 1, algorithm: "HMAC-SHA256",
			payload: {
				version: 1, serverInstanceId: target, sourceIdentityDigest: "a".repeat(64), activeSessionDigest: "b".repeat(64),
				prospectiveRunId: run, requestDigest: "c".repeat(64), launchContractDigest: "d".repeat(64),
				issuedAt: 1000, expiresAt, requestId: "r", ownerRunId: "o", nodeId: "n",
			},
			mac: "e".repeat(64),
		},
	};
}

test("a pending cancellation is exact, one-shot, and expiry releases capacity", () => {
	let now = 1000;
	const registry = new BoundPendingCancellationRegistryV2(() => now, 1);
	const proof = binding();
	assert.equal(registry.remember(tuple, proof), true);
	assert.equal(registry.consume(tuple, { ...proof, requestDigest: "f".repeat(64) }), false);
	assert.equal(registry.consume(tuple, proof), "cancelled");
	assert.equal(registry.consume(tuple, proof), "consumed");
	assert.equal(registry.remember(tuple, proof), true);
	now = 31_000;
	assert.deepEqual(registry.snapshot(), { pending: 0, consumed: 0, saturatedTargets: 0 });
});

test("saturation never evicts another generation's pending cancellation", () => {
	let now = 1000;
	const registry = new BoundPendingCancellationRegistryV2(() => now, 1);
	const old = binding();
	const second = { requestId: "x", ownerRunId: "o", nodeId: "n" };
	assert.equal(registry.remember(tuple, old), true);
	assert.equal(registry.remember(second, old), false);
	assert.equal(registry.consume(second, old), "saturated");
	const next = binding(31_000, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
	assert.equal(registry.remember(tuple, next), false);
	assert.equal(registry.consume(tuple, next), "saturated");
	assert.equal(registry.consume(tuple, old), "cancelled");
	now = 31_000;
	assert.deepEqual(registry.snapshot(), { pending: 0, consumed: 0, saturatedTargets: 0 });
});

test("the same tuple stays independently cancellable across generations and reissued bindings", () => {
	const registry = new BoundPendingCancellationRegistryV2(() => 1000, 3);
	const oldBinding = binding();
	const newBinding = binding(31_000, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
	const reissued = structuredClone(oldBinding);
	reissued.cancellationToken.mac = "f".repeat(64);
	assert.equal(registry.remember(tuple, oldBinding), true);
	assert.equal(registry.remember(tuple, newBinding), true);
	assert.equal(registry.remember(tuple, reissued), true);
	assert.deepEqual(registry.snapshot(), { pending: 3, consumed: 0, saturatedTargets: 0 });
	assert.equal(registry.consume(tuple, reissued), "cancelled");
	assert.equal(registry.consume(tuple, newBinding), "cancelled");
	assert.equal(registry.consume(tuple, oldBinding), "cancelled");
});

test("A1 global registry state does not transfer into the V3 generation contract", () => {
	const store: Record<string, unknown> = {
		__piSubagentBoundPendingCancellationRegistryV1: { remember() { return false; }, consume() { return true; } },
		__piSubagentBoundPendingCancellationRegistryV2: { remember() { return false; }, consume() { return true; } },
	};
	const registry = getBoundPendingCancellationRegistry(store);
	assert.deepEqual(registry.snapshot(), { pending: 0, consumed: 0, saturatedTargets: 0 });
	assert.equal(registry.consume(tuple, binding()), false);
	assert.equal(store[BOUND_PENDING_CANCELLATION_GLOBAL_KEY], registry);
	assert.equal(BOUND_PENDING_CANCELLATION_GLOBAL_KEY, "__piSubagentBoundPendingCancellationRegistryV3");
	assert.throws(() => getBoundPendingCancellationRegistry({ [BOUND_PENDING_CANCELLATION_GLOBAL_KEY]: { remember() {}, consume() {} } }), /Incompatible/u);
});
