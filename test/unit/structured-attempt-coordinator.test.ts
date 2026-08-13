import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SubagentDelegationRequest, SubagentDelegationResponse } from "../../src/api/delegation.ts";
import { StructuredAttemptCoordinator } from "../../src/slash/structured-attempt-coordinator.ts";

function request(requestId = "r1", nodeId = "n1"): SubagentDelegationRequest {
	return { requestId, ownerRunId: "owner", nodeId, agent: "worker", task: "work", context: "fresh", cwd: "/repo", result: { kind: "text" } };
}
function terminal(value: SubagentDelegationRequest, status: "completed" | "cancelled" = "completed"): SubagentDelegationResponse {
	return { requestId: value.requestId, ownerRunId: value.ownerRunId, nodeId: value.nodeId, status };
}

describe("structured attempt coordinator", () => {
	it("drains A through an inactive B gap and flushes exactly once through C", () => {
		const coordinator = new StructuredAttemptCoordinator();
		const value = request();
		const admitted = coordinator.admit(value, "A");
		assert.equal(admitted.accepted, true);
		coordinator.stopOwner("A");
		coordinator.activateSink("B", () => assert.fail("B sink must be inactive during the gap"));
		coordinator.deactivateSink("B");
		if (admitted.accepted) admitted.settle(terminal(value));
		assert.equal(coordinator.snapshot().pending, 1);
		const delivered: SubagentDelegationResponse[] = [];
		coordinator.activateSink("C", (payload) => delivered.push(payload));
		assert.deepEqual(delivered.map((entry) => entry.status), ["cancelled"]);
		coordinator.activateSink("C", (payload) => delivered.push(payload));
		assert.equal(delivered.length, 1);
	});

	it("keeps tuple one-shot, releases node before delivery, and routes cancel to the new tuple", () => {
		const coordinator = new StructuredAttemptCoordinator();
		const first = request("first");
		const admitted = coordinator.admit(first, "A");
		assert.equal(admitted.accepted, true);
		let secondSignal: AbortSignal | undefined;
		coordinator.activateSink("B", () => {
			assert.equal(coordinator.admit(first, "B").accepted, false);
			const second = coordinator.admit(request("second"), "B");
			assert.equal(second.accepted, true);
			if (second.accepted) secondSignal = second.signal;
			assert.equal(coordinator.cancel("second", "owner", "n1"), true);
		});
		if (admitted.accepted) admitted.settle(terminal(first));
		assert.equal(secondSignal?.aborted, true);
	});

	it("commits delivery before a throwing listener and never replays it", () => {
		const coordinator = new StructuredAttemptCoordinator();
		const value = request();
		const admitted = coordinator.admit(value, "A");
		let calls = 0;
		coordinator.activateSink("A", () => { calls++; throw new Error("listener"); });
		if (admitted.accepted) admitted.settle(terminal(value));
		coordinator.activateSink("B", () => { calls++; });
		assert.equal(calls, 1);
		assert.equal(coordinator.snapshot().settled, 1);
	});

	it("ignores unknown cancellation without poisoning a future tuple or capacity", () => {
		const coordinator = new StructuredAttemptCoordinator(1);
		assert.equal(coordinator.cancel("future", "owner", "n1"), false);
		assert.equal(coordinator.cancel("other", "owner", "n2"), false);
		const admitted = coordinator.admit(request("future"), "A");
		assert.equal(admitted.accepted, true);
		if (admitted.accepted) assert.equal(admitted.signal.aborted, false);
	});

	it("fails closed permanently at identity capacity before admission", () => {
		const coordinator = new StructuredAttemptCoordinator(2);
		const one = coordinator.admit(request("one", "one"), "A");
		assert.equal(one.accepted, true);
		assert.equal(coordinator.admit(request("two", "two"), "A").accepted, true);
		assert.deepEqual(coordinator.admit(request("three", "three"), "A"), { accepted: false, reason: "capacity" });
		coordinator.activateSink("A", () => {});
		if (one.accepted) one.settle(terminal(request("one", "one")));
		assert.deepEqual(coordinator.admit(request("four", "four"), "A"), { accepted: false, reason: "capacity" });
	});

	it("drains only attempts owned by the stopped runtime", async () => {
		const coordinator = new StructuredAttemptCoordinator();
		const owned = request("owned", "owned");
		const foreign = request("foreign", "foreign");
		const ownedAdmission = coordinator.admit(owned, "A");
		const foreignAdmission = coordinator.admit(foreign, "B");
		assert.equal(ownedAdmission.accepted, true);
		assert.equal(foreignAdmission.accepted, true);
		coordinator.stopOwner("A");
		assert.equal(coordinator.hasDrainingOwner("A"), true);
		if (ownedAdmission.accepted) ownedAdmission.settle(terminal(owned));
		await coordinator.drainOwner("A");
		assert.equal(coordinator.hasDrainingOwner("A"), false);
		assert.equal(coordinator.snapshot().attempts, 2);
	});
});
