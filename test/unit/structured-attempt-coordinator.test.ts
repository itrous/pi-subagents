import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SubagentDelegationRequest, SubagentDelegationResponse } from "../../src/api/delegation.ts";
import { StructuredAttemptCoordinator, getStructuredAttemptCoordinator, prepareStructuredAttemptCoordinator, structuredCancellationBindingKey } from "../../src/slash/structured-attempt-coordinator.ts";

function request(requestId = "r1", nodeId = "n1"): SubagentDelegationRequest {
	return { requestId, ownerRunId: "owner", nodeId, agent: "worker", task: "work", context: "fresh", cwd: "/repo", result: { kind: "text" } };
}
function terminal(value: SubagentDelegationRequest, status: "completed" | "cancelled" = "completed"): SubagentDelegationResponse {
	return { requestId: value.requestId, ownerRunId: value.ownerRunId, nodeId: value.nodeId, status };
}
function boundRequest(requestId = "bound", nodeId = "bound-node"): SubagentDelegationRequest {
	return { ...request(requestId, nodeId), binding: {} as never };
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

	it("preserves validated native proof fields when cancellation owns terminal status", () => {
		const coordinator = new StructuredAttemptCoordinator(); const value = request(); const admitted = coordinator.admit(value, "A"); assert.equal(admitted.accepted, true);
		const delivered: SubagentDelegationResponse[] = []; coordinator.activateSink("A", (payload) => delivered.push(payload)); coordinator.cancel(value.requestId, value.ownerRunId, value.nodeId);
		if (admitted.accepted) admitted.settle({ ...terminal(value), deniedToolCalls: [], toolRegistry: { version: 1, projectionVersion: 1, required: [], effectiveCallerTools: [], internalTools: [], missing: [], digest: "0".repeat(64) } } as any);
		assert.equal(delivered[0]?.status, "cancelled"); assert.deepEqual((delivered[0] as any).deniedToolCalls, []); assert.ok((delivered[0] as any).toolRegistry);
	});

	it("keeps registry failure status ahead of a racing cancellation", () => {
		const coordinator = new StructuredAttemptCoordinator(); const value = request(); const admitted = coordinator.admit(value, "A"); const delivered: SubagentDelegationResponse[] = [];
		coordinator.activateSink("A", (payload) => delivered.push(payload)); coordinator.cancel(value.requestId, value.ownerRunId, value.nodeId);
		if (admitted.accepted) admitted.settle({ ...terminal(value), status: "native_tool_registry_mismatch", toolsExtra: ["extra"], transportIncomplete: true } as any);
		assert.equal(delivered[0]?.status, "native_tool_registry_mismatch"); assert.deepEqual((delivered[0] as any).toolsExtra, ["extra"]);
	});

	it("keeps complete denied-proof protocol failure ahead of cancellation", () => {
		const coordinator = new StructuredAttemptCoordinator(); const value = request(); const admitted = coordinator.admit(value, "A"); const delivered: SubagentDelegationResponse[] = [];
		coordinator.activateSink("A", (payload) => delivered.push(payload)); coordinator.cancel(value.requestId, value.ownerRunId, value.nodeId);
		if (admitted.accepted) admitted.settle({ ...terminal(value), status: "native_denied_tools_protocol_error", deniedToolCallsError: "multiple_frames", transportIncomplete: true } as any);
		assert.equal(delivered[0]?.status, "native_denied_tools_protocol_error"); assert.equal((delivered[0] as any).deniedToolCallsError, "multiple_frames");
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

	it("requires bound authority for bound tuples while preserving live legacy cancellation", () => {
		const coordinator = new StructuredAttemptCoordinator();
		const legacy = coordinator.admit(request("legacy", "legacy"), "A");
		const bound = coordinator.admit(boundRequest(), "A");
		assert.equal(legacy.accepted, true); assert.equal(bound.accepted, true);
		assert.equal(coordinator.cancel("bound", "owner", "bound-node"), false);
		assert.equal(bound.accepted && bound.signal.aborted, false);
		assert.equal(coordinator.cancel("legacy", "owner", "legacy", "bound"), false);
		assert.equal(coordinator.cancel("legacy", "owner", "legacy"), true);
		assert.equal(coordinator.cancel("bound", "owner", "bound-node", "bound", structuredCancellationBindingKey(boundRequest().binding)), true);
		assert.equal(legacy.accepted && legacy.signal.aborted, true);
		assert.equal(bound.accepted && bound.signal.aborted, true);
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

	it("upgrades a process-global previous-generation settle contract in place", () => {
		const key = "__piSubagentStructuredAttemptCoordinatorV1"; const prior = (globalThis as any)[key]; let seen: any;
		const legacy: any = { attemptsByTuple: new Map(), settledTuples: new Set(), admit() { return { accepted: false }; }, cancel() { return false; }, activateSink() {}, settle(record: any, terminalValue: any) { seen = record.stopped || record.controller.signal.aborted ? { status: "cancelled" } : terminalValue; } };
		(globalThis as any)[key] = legacy;
		try {
			const upgraded = getStructuredAttemptCoordinator() as any; prepareStructuredAttemptCoordinator(upgraded); const controller = new AbortController(); controller.abort();
			upgraded.settle({ stopped: false, controller, request: { requestId: "r", ownerRunId: "o", nodeId: "n" } }, { requestId: "r", ownerRunId: "o", nodeId: "n", status: "native_tool_registry_mismatch", toolsExtra: ["extra"] });
			assert.equal(upgraded, legacy); assert.equal(upgraded.contractVersion, 2); assert.equal(upgraded.cancellationContractVersion, 1); assert.equal(seen.status, "native_tool_registry_mismatch");
		} finally { if (prior === undefined) delete (globalThis as any)[key]; else (globalThis as any)[key] = prior; }
	});

	it("upgrades the actual mutable A1.7 v2 marker in place for active and future records", () => {
		const key = "__piSubagentStructuredAttemptCoordinatorV1"; const prior = (globalThis as any)[key];
		class HistoricalV2 {
			contractVersion = 2; attemptsByTuple = new Map<string, any>(); settledTuples = new Set<string>();
			admit(value: SubagentDelegationRequest) {
				const tupleKey = JSON.stringify([value.requestId, value.ownerRunId, value.nodeId]); const controller = new AbortController();
				this.attemptsByTuple.set(tupleKey, { request: value, controller, settled: false });
				return { accepted: true as const, signal: controller.signal, isRunning: () => true, settle() {} };
			}
			cancel(requestId: string, ownerRunId: string, nodeId: string) { const record = this.attemptsByTuple.get(JSON.stringify([requestId, ownerRunId, nodeId])); if (!record) return false; record.controller.abort(); return true; }
			activateSink() {}
		}
		const legacy: any = new HistoricalV2(); const oldBound = boundRequest("old-bound", "old-bound"); const oldLegacy = request("old-legacy", "old-legacy");
		const oldBoundAdmission = legacy.admit(oldBound); const oldLegacyAdmission = legacy.admit(oldLegacy); (globalThis as any)[key] = legacy;
		try {
			const upgraded = getStructuredAttemptCoordinator() as any;
			assert.equal(upgraded.cancellationContractVersion, undefined, "candidate construction must not mutate the active old coordinator");
			prepareStructuredAttemptCoordinator(upgraded);
			assert.equal(upgraded, legacy); assert.deepEqual(Object.getOwnPropertyDescriptor(upgraded, "contractVersion") && { value: upgraded.contractVersion, writable: Object.getOwnPropertyDescriptor(upgraded, "contractVersion")!.writable, configurable: Object.getOwnPropertyDescriptor(upgraded, "contractVersion")!.configurable }, { value: 2, writable: false, configurable: false });
			assert.deepEqual(Object.getOwnPropertyDescriptor(upgraded, "cancellationContractVersion") && { value: upgraded.cancellationContractVersion, writable: Object.getOwnPropertyDescriptor(upgraded, "cancellationContractVersion")!.writable, configurable: Object.getOwnPropertyDescriptor(upgraded, "cancellationContractVersion")!.configurable }, { value: 1, writable: false, configurable: false });
			assert.equal(upgraded.cancel("old-bound", "owner", "old-bound"), false); assert.equal(oldBoundAdmission.signal.aborted, false);
			assert.equal(upgraded.cancel("old-legacy", "owner", "old-legacy"), true); assert.equal(oldLegacyAdmission.signal.aborted, true);
			assert.equal(upgraded.cancel("old-bound", "owner", "old-bound", "bound", structuredCancellationBindingKey(oldBound.binding)), true); assert.equal(oldBoundAdmission.signal.aborted, true);
			let getterCalls = 0; const ambiguous = request("ambiguous", "ambiguous") as any; Object.defineProperty(ambiguous, "binding", { get() { getterCalls++; return {}; } });
			const ambiguousAdmission = upgraded.admit(ambiguous, "new"); assert.equal(getterCalls, 0); assert.equal(upgraded.cancel("ambiguous", "owner", "ambiguous"), false); assert.equal(upgraded.cancel("ambiguous", "owner", "ambiguous", "bound", "invalid-bound-cancellation-key"), true); assert.equal(ambiguousAdmission.signal.aborted, true); assert.equal(getterCalls, 0);
			const futureLegacy = upgraded.admit(request("future-legacy", "future-legacy"), "new"); assert.equal(upgraded.cancel("future-legacy", "owner", "future-legacy"), true); assert.equal(futureLegacy.signal.aborted, true);
		} finally { if (prior === undefined) delete (globalThis as any)[key]; else (globalThis as any)[key] = prior; }
	});

	it("rejects a forged v1 cancellation marker without invoking accessors or replacing methods", () => {
		const key = "__piSubagentStructuredAttemptCoordinatorV1"; const prior = (globalThis as any)[key]; let getterCalls = 0; const admit = () => ({ accepted: false }); const cancel = () => true;
		const legacy: any = { contractVersion: 2, attemptsByTuple: new Map(), admit, cancel, activateSink() {} }; Object.defineProperty(legacy, "cancellationContractVersion", { configurable: false, get() { getterCalls++; return 1; } }); (globalThis as any)[key] = legacy;
		try { const coordinator = getStructuredAttemptCoordinator(); assert.throws(() => prepareStructuredAttemptCoordinator(coordinator), /Incompatible process-global structured attempt cancellation coordinator/); assert.equal(getterCalls, 0); assert.equal(legacy.admit, admit); assert.equal(legacy.cancel, cancel); }
		finally { if (prior === undefined) delete (globalThis as any)[key]; else (globalThis as any)[key] = prior; }
	});

	it("rejects incompatible method descriptors before partially replacing admission", () => {
		const key = "__piSubagentStructuredAttemptCoordinatorV1"; const prior = (globalThis as any)[key]; const admit = () => ({ accepted: false }); const cancel = () => true; const legacy: any = { contractVersion: 2, attemptsByTuple: new Map(), admit, activateSink() {} }; Object.defineProperty(legacy, "cancel", { value: cancel, writable: true, configurable: false, enumerable: true }); (globalThis as any)[key] = legacy;
		try { const coordinator = getStructuredAttemptCoordinator(); assert.throws(() => prepareStructuredAttemptCoordinator(coordinator), /Incompatible process-global structured attempt cancellation coordinator/); assert.equal(legacy.admit, admit); assert.equal(legacy.cancel, cancel); assert.equal(legacy.cancellationContractVersion, undefined); }
		finally { if (prior === undefined) delete (globalThis as any)[key]; else (globalThis as any)[key] = prior; }
	});

	it("fails closed without partially publishing cancellation policy on frozen incompatible v2", () => {
		const key = "__piSubagentStructuredAttemptCoordinatorV1"; const prior = (globalThis as any)[key];
		const legacy: any = { attemptsByTuple: new Map(), admit() {}, cancel() { return true; }, activateSink() {} }; Object.defineProperty(legacy, "contractVersion", { value: 2, writable: false, configurable: false }); Object.preventExtensions(legacy); (globalThis as any)[key] = legacy;
		try { const coordinator = getStructuredAttemptCoordinator(); assert.throws(() => prepareStructuredAttemptCoordinator(coordinator), /Incompatible process-global structured attempt cancellation coordinator/); assert.equal(legacy.cancellationContractVersion, undefined); assert.equal(legacy.cancel(), true); }
		finally { if (prior === undefined) delete (globalThis as any)[key]; else (globalThis as any)[key] = prior; }
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
