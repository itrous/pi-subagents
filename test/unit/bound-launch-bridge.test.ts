import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { BoundAttemptCoordinator } from "../../src/bound/bound-attempt-coordinator.ts";
import { registerBoundLaunchBridge, type BoundExecutionPort } from "../../src/bound/bound-launch-bridge.ts";
import { BoundPendingCancellationRegistryV2 } from "../../src/bound/bound-pending-cancellation-registry.ts";
import { createBoundRuntimeService, type BoundPreflightSuccessV2, type BoundRuntimeService, type BoundRuntimeServiceOptions } from "../../src/bound/bound-runtime-service.ts";
import {
	BOUND_CANCEL_EVENT, BOUND_CHANNEL_VERSION, BOUND_LAUNCH_EVENT, BOUND_STARTED_EVENT,
	BOUND_TERMINAL_EVENT, BOUND_UPDATE_EVENT, type BoundBindingV2,
} from "../../src/bound/channel.ts";
import { getBoundIdentityRegistry, type BoundIdentityRegistryV1 } from "../../src/slash/bound-identity-registry.ts";
import { createBoundFixture, FIXTURE_SERVER_INSTANCE_ID, type BoundFixture } from "../fixtures/bound/harness.ts";

let fixture: BoundFixture;

beforeEach(() => { fixture = createBoundFixture(); });
afterEach(() => { fixture.cleanup(); });

interface Bus {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
	deliver(event: string, data: unknown): Promise<void>;
	emitted: Array<{ event: string; data: Record<string, unknown> }>;
	of(event: string): Array<Record<string, unknown>>;
}

function createBus(): Bus {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
	return {
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
		},
		emit(event, data) { emitted.push({ event, data: data as Record<string, unknown> }); },
		async deliver(event, data) {
			for (const handler of [...(handlers.get(event) ?? [])]) await (handler(data) as unknown as Promise<void> | void);
		},
		emitted,
		of(event) { return emitted.filter((entry) => entry.event === event).map((entry) => entry.data); },
	};
}

interface Harness {
	bus: Bus;
	service: BoundRuntimeService;
	coordinator: BoundAttemptCoordinator;
	identities: BoundIdentityRegistryV1;
	pending: BoundPendingCancellationRegistryV2;
	dispose(): void;
}

function harness(executionPort?: BoundExecutionPort, runtimeId = "gen-1", identityCapacity?: number): Harness {
	const bus = createBus();
	const service = createBoundRuntimeService(fixture.serviceOptions() as unknown as BoundRuntimeServiceOptions);
	const coordinator = identityCapacity === undefined ? new BoundAttemptCoordinator() : new BoundAttemptCoordinator(identityCapacity);
	const identities = getBoundIdentityRegistry({});
	const pending = new BoundPendingCancellationRegistryV2(() => 1_000);
	const bridge = registerBoundLaunchBridge({
		events: bus, service, coordinator, runtimeId, identityRegistry: identities, pendingCancellations: pending,
		...(executionPort ? { executionPort } : {}),
	});
	coordinator.activateSink(runtimeId, bridge.sink);
	return { bus, service, coordinator, identities, pending, dispose: () => { bridge.dispose(); service.dispose(); } };
}

async function preflighted(service: BoundRuntimeService, requestOverrides: Record<string, unknown> = {}): Promise<{ data: BoundPreflightSuccessV2; binding: BoundBindingV2; request: Record<string, unknown> }> {
	const request = fixture.request(requestOverrides);
	const outcome = await service.preflight(request);
	assert.ok(outcome && outcome.ok, "preflight must succeed");
	if (!outcome || !outcome.ok) throw new Error("unreachable");
	const data = outcome.data;
	return {
		data, request,
		binding: {
			version: BOUND_CHANNEL_VERSION,
			targetServerInstanceId: data.serverInstanceId,
			prospectiveRunId: data.launchContract.prospectiveRunId,
			expectedSourceIdentityDigest: data.sourceIdentityDigest,
			expectedActiveSessionDigest: data.activeSessionDigest,
			requestDigest: data.requestDigest,
			expectedLaunchContractDigest: data.launchContractDigest,
			receipt: data.receipt,
			cancellationToken: data.cancellationToken,
		},
	};
}

async function until(condition: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error(`timed out waiting for ${label}`);
}

function launchEnvelope(request: Record<string, unknown>, binding: BoundBindingV2, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: BOUND_CHANNEL_VERSION,
		requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId,
		request, binding, ...overrides,
	};
}

test("an admitted launch without an execution port ends in exactly one unavailable_context terminal", async () => {
	const h = harness();
	try {
		const { request, binding } = await preflighted(h.service);
		await h.bus.deliver(BOUND_LAUNCH_EVENT, launchEnvelope(request, binding));
		assert.deepEqual(h.bus.of(BOUND_STARTED_EVENT), [{ version: 2, requestId: "request-1", ownerRunId: "owner-1", nodeId: "node-1" }]);
		assert.deepEqual(h.bus.of(BOUND_TERMINAL_EVENT), [{ requestId: "request-1", ownerRunId: "owner-1", nodeId: "node-1", status: "unavailable_context" }]);
	} finally { h.dispose(); }
});

test("a stub execution port completes the attempt and its updates stop at the terminal", async () => {
	let capturedUpdate: ((update: Record<string, unknown>) => void) | undefined;
	const port: BoundExecutionPort = {
		async run({ onUpdate }) {
			capturedUpdate = onUpdate;
			onUpdate({ currentTool: "read" });
			return { status: "completed", result: { kind: "text", text: "done" } };
		},
	};
	const h = harness(port);
	try {
		const { request, binding } = await preflighted(h.service);
		await h.bus.deliver(BOUND_LAUNCH_EVENT, launchEnvelope(request, binding));
		assert.deepEqual(h.bus.of(BOUND_UPDATE_EVENT), [{ version: 2, requestId: "request-1", ownerRunId: "owner-1", nodeId: "node-1", currentTool: "read" }]);
		const terminals = h.bus.of(BOUND_TERMINAL_EVENT);
		assert.equal(terminals.length, 1);
		assert.equal(terminals[0]!.status, "completed");
		capturedUpdate?.({ currentTool: "late" });
		assert.equal(h.bus.of(BOUND_UPDATE_EVENT).length, 1);
	} finally { h.dispose(); }
});

test("a duplicate tuple is refused without a second started event or terminal", async () => {
	const h = harness();
	try {
		const { request, binding } = await preflighted(h.service);
		await h.bus.deliver(BOUND_LAUNCH_EVENT, launchEnvelope(request, binding));
		await h.bus.deliver(BOUND_LAUNCH_EVENT, launchEnvelope(request, binding));
		assert.equal(h.bus.of(BOUND_STARTED_EVENT).length, 1);
		assert.equal(h.bus.of(BOUND_TERMINAL_EVENT).length, 1);
	} finally { h.dispose(); }
});

test("a second attempt on the same node is refused as duplicate_node", async () => {
	const h = harness();
	try {
		const first = await preflighted(h.service);
		await h.bus.deliver(BOUND_LAUNCH_EVENT, launchEnvelope(first.request, first.binding));
		const second = await preflighted(h.service, { requestId: "request-2" });
		await h.bus.deliver(BOUND_LAUNCH_EVENT, launchEnvelope(second.request, second.binding));
		const terminals = h.bus.of(BOUND_TERMINAL_EVENT);
		assert.equal(terminals.length, 2);
		assert.equal(terminals[1]!.status, "duplicate_node");
		assert.equal(h.bus.of(BOUND_STARTED_EVENT).length, 1);
	} finally { h.dispose(); }
});

test("identity is reserved on admission, committed on start, and released on a later refusal", async () => {
	const h = harness();
	try {
		assert.equal(h.identities.size(), 0);
		const first = await preflighted(h.service);
		await h.bus.deliver(BOUND_LAUNCH_EVENT, launchEnvelope(first.request, first.binding));
		assert.equal(h.identities.size(), 1);
		assert.equal(h.identities.has(FIXTURE_SERVER_INSTANCE_ID, first.data.launchContract.prospectiveRunId), true);
		// A committed identity cannot be released, so the second launch is duplicate_node.
		const second = await preflighted(h.service, { requestId: "request-3", nodeId: "node-3" });
		await h.bus.deliver(BOUND_LAUNCH_EVENT, launchEnvelope(second.request, second.binding));
		assert.equal(h.identities.size(), 1);
		const terminals = h.bus.of(BOUND_TERMINAL_EVENT);
		assert.equal(terminals.at(-1)!.status, "duplicate_node");
	} finally { h.dispose(); }
});

test("an invalid request or a drifted binding produces a closed terminal, not silence", async () => {
	const h = harness();
	try {
		const { request, binding } = await preflighted(h.service);
		// A request that still resolves but no longer matches the signed digests.
		await h.bus.deliver(BOUND_LAUNCH_EVENT, launchEnvelope({ ...request, task: "Review something else." }, binding));
		assert.deepEqual(h.bus.of(BOUND_TERMINAL_EVENT), [{ requestId: "request-1", ownerRunId: "owner-1", nodeId: "node-1", status: "invalid_request" }]);
		assert.equal(h.bus.of(BOUND_STARTED_EVENT).length, 0);
		assert.equal(h.identities.size(), 0);
	} finally { h.dispose(); }
});

test("a request the host can no longer resolve ends in unavailable_context", async () => {
	const h = harness();
	try {
		const { request, binding } = await preflighted(h.service);
		await h.bus.deliver(BOUND_LAUNCH_EVENT, launchEnvelope({ ...request, agent: "absent-agent" }, binding));
		assert.deepEqual(h.bus.of(BOUND_TERMINAL_EVENT), [{ requestId: "request-1", ownerRunId: "owner-1", nodeId: "node-1", status: "unavailable_context" }]);
		assert.equal(h.bus.of(BOUND_STARTED_EVENT).length, 0);
	} finally { h.dispose(); }
});

test("a malformed envelope or a foreign target stays silent", async () => {
	const h = harness();
	try {
		const { request, binding } = await preflighted(h.service);
		await h.bus.deliver(BOUND_LAUNCH_EVENT, { version: 1, requestId: "r", ownerRunId: "o", nodeId: "n", request, binding });
		await h.bus.deliver(BOUND_LAUNCH_EVENT, launchEnvelope(request, { ...binding, targetServerInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
		await h.bus.deliver(BOUND_LAUNCH_EVENT, undefined);
		assert.deepEqual(h.bus.emitted, []);
	} finally { h.dispose(); }
});

test("a valid token cancels only its own tuple; foreign, repeated, and forged tokens cancel nothing", async () => {
	let release: (() => void) | undefined;
	const port: BoundExecutionPort = {
		async run({ signal }) {
			await new Promise<void>((resolve) => {
				release = resolve;
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return { status: signal.aborted ? "cancelled" : "completed" };
		},
	};
	const h = harness(port);
	try {
		const first = await preflighted(h.service);
		const pendingLaunch = h.bus.deliver(BOUND_LAUNCH_EVENT, launchEnvelope(first.request, first.binding));
		await until(() => h.bus.of(BOUND_STARTED_EVENT).length === 1, "the attempt to start");
		// A forged token: the MAC no longer matches its payload.
		const forged = structuredClone(first.binding);
		forged.cancellationToken.mac = "f".repeat(64);
		await h.bus.deliver(BOUND_CANCEL_EVENT, { version: 2, requestId: "request-1", ownerRunId: "owner-1", nodeId: "node-1", targetServerInstanceId: FIXTURE_SERVER_INSTANCE_ID, binding: forged });
		// A token issued for a different tuple.
		await h.bus.deliver(BOUND_CANCEL_EVENT, { version: 2, requestId: "request-1", ownerRunId: "owner-1", nodeId: "other-node", targetServerInstanceId: FIXTURE_SERVER_INSTANCE_ID, binding: first.binding });
		assert.equal(h.bus.of(BOUND_TERMINAL_EVENT).length, 0);
		await h.bus.deliver(BOUND_CANCEL_EVENT, { version: 2, requestId: "request-1", ownerRunId: "owner-1", nodeId: "node-1", targetServerInstanceId: FIXTURE_SERVER_INSTANCE_ID, binding: first.binding });
		await pendingLaunch;
		release?.();
		const terminals = h.bus.of(BOUND_TERMINAL_EVENT);
		assert.equal(terminals.length, 1);
		assert.equal(terminals[0]!.status, "cancelled");
		// Repeating the same cancel changes nothing.
		await h.bus.deliver(BOUND_CANCEL_EVENT, { version: 2, requestId: "request-1", ownerRunId: "owner-1", nodeId: "node-1", targetServerInstanceId: FIXTURE_SERVER_INSTANCE_ID, binding: first.binding });
		assert.equal(h.bus.of(BOUND_TERMINAL_EVENT).length, 1);
	} finally { h.dispose(); }
});

test("a cancel that arrives before admission is remembered and consumed exactly once", async () => {
	const h = harness();
	try {
		const { request, binding } = await preflighted(h.service);
		const cancel = { version: 2, requestId: "request-1", ownerRunId: "owner-1", nodeId: "node-1", targetServerInstanceId: FIXTURE_SERVER_INSTANCE_ID, binding };
		await h.bus.deliver(BOUND_CANCEL_EVENT, cancel);
		assert.deepEqual(h.pending.snapshot(), { pending: 1, consumed: 0, saturatedTargets: 0 });
		await h.bus.deliver(BOUND_LAUNCH_EVENT, launchEnvelope(request, binding));
		assert.deepEqual(h.pending.snapshot(), { pending: 0, consumed: 1, saturatedTargets: 0 });
		const terminals = h.bus.of(BOUND_TERMINAL_EVENT);
		assert.equal(terminals.length, 1);
		assert.equal(terminals[0]!.status, "cancelled");
	} finally { h.dispose(); }
});

test("a terminal from a stopped generation reaches the client once through the new sink", async () => {
	let finish: ((value: { status: string }) => void) | undefined;
	const port: BoundExecutionPort = { run: () => new Promise((resolve) => { finish = resolve; }) };
	const oldBus = createBus();
	const newBus = createBus();
	const service = createBoundRuntimeService(fixture.serviceOptions() as unknown as BoundRuntimeServiceOptions);
	const coordinator = new BoundAttemptCoordinator();
	const identities = getBoundIdentityRegistry({});
	const pending = new BoundPendingCancellationRegistryV2(() => 1_000);
	const oldBridge = registerBoundLaunchBridge({ events: oldBus, service, coordinator, runtimeId: "gen-1", executionPort: port, identityRegistry: identities, pendingCancellations: pending });
	coordinator.activateSink("gen-1", oldBridge.sink);
	try {
		const { request, binding } = await preflighted(service);
		const inflight = oldBus.deliver(BOUND_LAUNCH_EVENT, launchEnvelope(request, binding));
		await until(() => oldBus.of(BOUND_STARTED_EVENT).length === 1, "the attempt to start");
		// Reload: the previous generation stops and deactivates its sink.
		oldBridge.dispose();
		coordinator.stopOwner("gen-1");
		coordinator.deactivateSink("gen-1");
		finish?.({ status: "completed" });
		await inflight;
		// Positive control: without an active sink the terminal stays in the outbox.
		assert.equal(oldBus.of(BOUND_TERMINAL_EVENT).length, 0);
		assert.equal(coordinator.snapshot().pending, 1);
		const newBridge = registerBoundLaunchBridge({ events: newBus, service, coordinator, runtimeId: "gen-2", identityRegistry: identities, pendingCancellations: pending });
		coordinator.activateSink("gen-2", newBridge.sink);
		assert.deepEqual(newBus.of(BOUND_TERMINAL_EVENT), [{ requestId: "request-1", ownerRunId: "owner-1", nodeId: "node-1", status: "cancelled" }]);
		assert.equal(oldBus.of(BOUND_TERMINAL_EVENT).length, 0);
		newBridge.dispose();
	} finally { service.dispose(); }
});

test("an exhausted coordinator answers with a terminal and releases the reservation", async () => {
	// Ёмкость 1: первая попытка занимает её целиком, вторая отвергается координатором.
	const h = harness(undefined, "gen-1", 1);
	try {
		const first = await preflighted(h.service);
		await h.bus.deliver(BOUND_LAUNCH_EVENT, launchEnvelope(first.request, first.binding));
		const afterFirst = h.bus.of(BOUND_TERMINAL_EVENT).length;
		assert.equal(h.identities.size(), 1);
		const second = await preflighted(h.service, { requestId: "request-3", nodeId: "node-3", prospectiveRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
		await h.bus.deliver(BOUND_LAUNCH_EVENT, launchEnvelope(second.request, second.binding));
		// Клиент получает терминал, а не молчание.
		const terminals = h.bus.of(BOUND_TERMINAL_EVENT);
		assert.equal(terminals.length, afterFirst + 1);
		assert.equal(terminals.at(-1)!.requestId, "request-3");
		assert.equal(terminals.at(-1)!.status, "unavailable_context");
		// Резерв второй идентичности отпущен.
		assert.equal(h.identities.has(FIXTURE_SERVER_INSTANCE_ID, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), false);
		assert.equal(h.identities.size(), 1);
	} finally { h.dispose(); }
});

test("a launch envelope whose tuple differs from the signed request is refused", async () => {
	const h = harness();
	try {
		const { request, binding } = await preflighted(h.service);
		await h.bus.deliver(BOUND_LAUNCH_EVENT, launchEnvelope(request, binding, { requestId: "envelope-x" }));
		// Отчётность и отмена должны идти по подписанной тройке, поэтому запуск закрыт.
		assert.equal(h.bus.of(BOUND_STARTED_EVENT).length, 0);
		const terminals = h.bus.of(BOUND_TERMINAL_EVENT);
		assert.equal(terminals.at(-1)!.requestId, "envelope-x");
		assert.equal(terminals.at(-1)!.status, "invalid_request");
	} finally { h.dispose(); }
});
