import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BOUND_ATTEMPT_COORDINATOR_GLOBAL_KEY, BoundAttemptCoordinator, boundCancellationBindingKey,
	getBoundAttemptCoordinator, type BoundTerminal,
} from "../../src/bound/bound-attempt-coordinator.ts";

const tuple = { requestId: "r", ownerRunId: "o", nodeId: "n" };
const bindingKey = "key-1";

function collector(): { sink: (terminal: BoundTerminal) => void; seen: BoundTerminal[] } {
	const seen: BoundTerminal[] = [];
	return { sink: (terminal) => { seen.push(terminal); }, seen };
}

test("an admitted attempt settles exactly once through the active sink", () => {
	const coordinator = new BoundAttemptCoordinator();
	const { sink, seen } = collector();
	coordinator.activateSink("gen-1", sink);
	const admission = coordinator.admit(tuple, "gen-1", bindingKey);
	assert.equal(admission.accepted, true);
	if (!admission.accepted) return;
	assert.equal(admission.isRunning(), true);
	admission.settle({ ...tuple, status: "completed" });
	admission.settle({ ...tuple, status: "failed" });
	assert.deepEqual(seen, [{ ...tuple, status: "completed" }]);
	assert.equal(admission.isRunning(), false);
});

test("duplicate tuples and duplicate nodes are refused separately", () => {
	const coordinator = new BoundAttemptCoordinator();
	coordinator.activateSink("gen-1", () => {});
	assert.equal(coordinator.admit(tuple, "gen-1", bindingKey).accepted, true);
	assert.deepEqual(coordinator.admit(tuple, "gen-1", bindingKey), { accepted: false, reason: "duplicate_tuple" });
	assert.deepEqual(coordinator.admit({ ...tuple, requestId: "r2" }, "gen-1", bindingKey), { accepted: false, reason: "duplicate_node" });
	assert.deepEqual(coordinator.admit({ requestId: "r3", ownerRunId: "o2", nodeId: "n2" }, "gen-1", bindingKey).accepted, true);
});

test("identity capacity saturates instead of evicting", () => {
	const coordinator = new BoundAttemptCoordinator(1);
	coordinator.activateSink("gen-1", () => {});
	assert.equal(coordinator.admit(tuple, "gen-1", bindingKey).accepted, true);
	assert.deepEqual(coordinator.admit({ requestId: "r2", ownerRunId: "o2", nodeId: "n2" }, "gen-1", bindingKey), { accepted: false, reason: "capacity" });
});

test("only the exact binding key cancels, and a stopped attempt projects to cancelled", () => {
	const coordinator = new BoundAttemptCoordinator();
	const { sink, seen } = collector();
	coordinator.activateSink("gen-1", sink);
	const admission = coordinator.admit(tuple, "gen-1", bindingKey);
	assert.equal(admission.accepted, true);
	if (!admission.accepted) return;
	assert.equal(coordinator.cancel("r", "o", "n", "other-key"), false);
	assert.equal(coordinator.cancel("r", "o", "other-node", bindingKey), false);
	assert.equal(admission.signal.aborted, false);
	assert.equal(coordinator.cancel("r", "o", "n", bindingKey), true);
	assert.equal(admission.signal.aborted, true);
	admission.settle({ ...tuple, status: "completed", result: { kind: "text", text: "leaked" } });
	assert.deepEqual(seen, [{ ...tuple, status: "cancelled" }]);
});

test("terminals stay in the outbox until a sink is active and survive a throwing listener", () => {
	const coordinator = new BoundAttemptCoordinator();
	const admission = coordinator.admit(tuple, "gen-1", bindingKey);
	assert.equal(admission.accepted, true);
	if (!admission.accepted) return;
	admission.settle({ ...tuple, status: "completed" });
	assert.equal(coordinator.snapshot().pending, 1);
	let calls = 0;
	coordinator.activateSink("gen-1", () => { calls++; throw new Error("listener failed"); });
	assert.equal(calls, 1);
	assert.equal(coordinator.snapshot().pending, 0);
	const { sink, seen } = collector();
	coordinator.activateSink("gen-2", sink);
	assert.deepEqual(seen, []);
});

test("stopping a generation aborts its attempts and the new sink receives the single terminal", () => {
	const coordinator = new BoundAttemptCoordinator();
	const first = collector();
	coordinator.activateSink("gen-1", first.sink);
	const admission = coordinator.admit(tuple, "gen-1", bindingKey);
	assert.equal(admission.accepted, true);
	if (!admission.accepted) return;
	coordinator.stopOwner("gen-1");
	assert.equal(admission.signal.aborted, true);
	coordinator.deactivateSink("gen-1");
	admission.settle({ ...tuple, status: "completed" });
	assert.deepEqual(first.seen, []);
	const second = collector();
	coordinator.activateSink("gen-2", second.sink);
	assert.deepEqual(second.seen, [{ ...tuple, status: "cancelled" }]);
	assert.equal(coordinator.snapshot().pending, 0);
});

test("a rejected identity is committed once and blocks a later admission", () => {
	const coordinator = new BoundAttemptCoordinator();
	const { sink, seen } = collector();
	coordinator.activateSink("gen-1", sink);
	assert.equal(coordinator.commitRejected(tuple, "gen-1", { ...tuple, status: "invalid_request" }), "committed");
	assert.equal(coordinator.commitRejected(tuple, "gen-1", { ...tuple, status: "invalid_request" }), "duplicate_tuple");
	assert.deepEqual(coordinator.admit(tuple, "gen-1", bindingKey), { accepted: false, reason: "duplicate_tuple" });
	assert.deepEqual(seen, [{ ...tuple, status: "invalid_request" }]);
	assert.equal(coordinator.canRememberCancellation("r", "o", "n"), false);
	assert.equal(coordinator.canRememberCancellation("r2", "o2", "n2"), true);
});

test("the binding key is descriptor safe and generation specific", () => {
	const binding = {
		targetServerInstanceId: "target", prospectiveRunId: "run", requestDigest: "req",
		expectedLaunchContractDigest: "contract", cancellationToken: { mac: "mac" },
	};
	const key = boundCancellationBindingKey(binding);
	assert.equal(key, boundCancellationBindingKey({ ...binding }));
	assert.notEqual(key, boundCancellationBindingKey({ ...binding, cancellationToken: { mac: "other" } }));
	assert.equal(boundCancellationBindingKey(new Proxy(binding, {})), "invalid-bound-cancellation-key");
	assert.equal(boundCancellationBindingKey(undefined), "invalid-bound-cancellation-key");
	assert.equal(boundCancellationBindingKey({ ...binding, cancellationToken: {} }), "invalid-bound-cancellation-key");
	let getterCalls = 0;
	const accessor = Object.defineProperty({ ...binding }, "requestDigest", { get: () => { getterCalls++; return "req"; }, enumerable: true, configurable: true });
	assert.equal(boundCancellationBindingKey(accessor), "invalid-bound-cancellation-key");
	assert.equal(getterCalls, 0);
});

test("the V2 global slot does not adopt an incompatible coordinator", () => {
	const store: Record<string, unknown> = {};
	const created = getBoundAttemptCoordinator(store);
	assert.equal(store[BOUND_ATTEMPT_COORDINATOR_GLOBAL_KEY], created);
	assert.equal(getBoundAttemptCoordinator(store), created);
	const foreign: Record<string, unknown> = { admit() {}, cancel() {}, activateSink() {}, canRememberCancellation() {}, contractVersion: 1 };
	assert.throws(() => getBoundAttemptCoordinator({ [BOUND_ATTEMPT_COORDINATOR_GLOBAL_KEY]: foreign }), /Incompatible/u);
	// An A1 coordinator lives under its own key and never transfers into V2.
	assert.equal(BOUND_ATTEMPT_COORDINATOR_GLOBAL_KEY, "__piSubagentBoundAttemptCoordinatorV2");
});
