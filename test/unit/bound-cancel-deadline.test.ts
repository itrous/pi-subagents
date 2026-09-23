import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { BoundAttemptCoordinator } from "../../src/bound/bound-attempt-coordinator.ts";
import { createBoundChildSessionFactory } from "../../src/bound/bound-child-factory.ts";
import { createBoundExecutionPort, type BoundExecuteDelegated } from "../../src/bound/bound-execution-port.ts";
import { registerBoundLaunchBridge } from "../../src/bound/bound-launch-bridge.ts";
import { BoundPendingCancellationRegistryV2 } from "../../src/bound/bound-pending-cancellation-registry.ts";
import { boundRunIdOf, BoundRunRegistryV1 } from "../../src/bound/bound-run-registry.ts";
import { createBoundRuntimeService, type BoundAuthorizedLaunch, type BoundRuntimeServiceOptions } from "../../src/bound/bound-runtime-service.ts";
import { BOUND_CHANNEL_VERSION, BOUND_LAUNCH_EVENT, BOUND_REQUEST_EVENT, BOUND_TERMINAL_EVENT, boundReplyEvent } from "../../src/bound/channel.ts";
import { registerBoundControlPlane } from "../../src/bound/index.ts";
import { createDefaultChildSessionFactory, type ChildSession } from "../../src/runs/shared/child-session.ts";
import { getBoundIdentityRegistry } from "../../src/slash/bound-identity-registry.ts";
import { createBoundFixture, FIXTURE_LAYER_MANIFEST, FIXTURE_PI_RUNTIME, FIXTURE_RUNTIME_BUILTINS, FIXTURE_SERVER_INSTANCE_ID, fixtureSourceIdentity, type BoundFixture } from "../fixtures/bound/harness.ts";
import { fakePi } from "../support/bound-fake-pi.ts";
import { admitBoundLaunch, boundBindingOf, contractLaunch } from "../support/bound-launch.ts";
import { TEST_TRANSCRIPT_API } from "../support/bound-transcript.ts";

type DelegatedResult = Awaited<ReturnType<BoundExecuteDelegated>>;

// Scaled-down stand-ins for BOUND_CANCEL_HARD_TIMER_MS and BOUND_CHILD_SHUTDOWN_TIMEOUT_MS.
const HARD_TIMER_MS = 60;
const SHUTDOWN_MS = 90;
const PROMISED_MS = HARD_TIMER_MS + SHUTDOWN_MS;
// Generous under load, yet far below the controls: a port that waits for the
// executor never settles, and the upstream default needs 5 000 ms.
const SLACK_MS = 2_000;

let fixture: BoundFixture;
beforeEach(() => { fixture = createBoundFixture(); fs.mkdirSync(fixture.sessionDir, { recursive: true }); });
afterEach(() => { fixture.cleanup(); });

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); });

/**
 * An executor that creates the child through the bound factory and then never
 * finishes, whatever the signal says: the S5 case of a tool ignoring abort.
 */
function hangingExecutor(registry: BoundRunRegistryV1, authorized: Map<string, BoundAuthorizedLaunch>, child: { hangShutdown: boolean; factory?: "bound" | "upstream-default" }) {
	const probes: Array<ReturnType<typeof fakePi>["probe"]> = [];
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const executeDelegated: BoundExecuteDelegated = async (_id, params) => {
		const runId = boundRunIdOf(params)!;
		const { pi, probe } = fakePi({ hangShutdown: child.hangShutdown });
		probes.push(probe);
		const launch = contractLaunch(fixture, authorized.get(runId)!);
		let created: ChildSession;
		if (child.factory === "upstream-default") {
			// Control: the process-wide default, 5 000 ms on a hanging session_shutdown.
			created = await createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi }).create(launch);
			registry.attachChild(runId, created);
		} else {
			created = await createBoundChildSessionFactory({ runId, expectedRunId: runId }, { registry, loadPiCodingAgent: async () => pi, processCwd: () => fixture.project, shutdownTimeoutMs: SHUTDOWN_MS, transcriptApi: TEST_TRANSCRIPT_API }).create(launch);
		}
		await gate;
		return { content: [], details: { mode: "single", results: [] } } as unknown as DelegatedResult;
	};
	return { executeDelegated, probes, release: () => release?.() };
}

async function started(registry: BoundRunRegistryV1, runId: string): Promise<void> {
	for (let attempt = 0; attempt < 500 && !registry.get(runId)?.child; attempt++) await sleep(2);
	assert.ok(registry.get(runId)?.child, "the child was created");
}

test("a cancel settles as cancelled within hardTimer + shutdown bound, disposing the child first", async () => {
	for (const hangShutdown of [false, true]) {
		const registry = new BoundRunRegistryV1();
		const launch = await admitBoundLaunch(fixture);
		const executor = hangingExecutor(registry, new Map([[launch.contract.prospectiveRunId, launch]]), { hangShutdown });
		const port = createBoundExecutionPort({ executeDelegated: executor.executeDelegated, getContext: () => fixture.context() as never, config: fixture.config, registry, hardTimerMs: HARD_TIMER_MS });
		const controller = new AbortController();
		const outcome = port.run({ launch, signal: controller.signal, onUpdate: () => {} });
		await started(registry, launch.contract.prospectiveRunId);
		const cancelledAt = Date.now();
		controller.abort();
		const settled = await outcome;
		const elapsed = Date.now() - cancelledAt;
		assert.equal(settled.status, "cancelled");
		assert.equal(executor.probes[0]!.disposed, 1, "dispose() ran before the outcome returned");
		assert.ok(elapsed >= HARD_TIMER_MS - 5, `not before the hard timer (${elapsed} ms)`);
		assert.ok(elapsed < PROMISED_MS + SLACK_MS, `within the promised bound (${elapsed} ms, hanging shutdown: ${hangShutdown})`);
		// The executor is still stuck, so the run stays private until it returns.
		assert.equal(registry.has(launch.contract.prospectiveRunId), true);
		executor.release();
		await port.whenIdle();
		await sleep(5);
		assert.equal(registry.has(launch.contract.prospectiveRunId), false);
	}
});

test("a late executor completion after the deadline yields no second terminal", async () => {
	const registry = new BoundRunRegistryV1();
	const bus = { handlers: new Map<string, (data: unknown) => unknown>(), terminals: [] as Array<Record<string, unknown>> };
	const events = {
		on(event: string, handler: (data: unknown) => unknown) { bus.handlers.set(event, handler); return () => bus.handlers.delete(event); },
		emit(event: string, data: unknown) { if (event === BOUND_TERMINAL_EVENT) bus.terminals.push(data as Record<string, unknown>); },
	};
	const service = createBoundRuntimeService(fixture.serviceOptions() as unknown as BoundRuntimeServiceOptions);
	const coordinator = new BoundAttemptCoordinator();
	const authorized = new Map<string, BoundAuthorizedLaunch>();
	const executor = hangingExecutor(registry, authorized, { hangShutdown: true });
	const port = createBoundExecutionPort({ executeDelegated: executor.executeDelegated, getContext: () => fixture.context() as never, config: fixture.config, registry, hardTimerMs: HARD_TIMER_MS });
	const bridge = registerBoundLaunchBridge({ events, service, coordinator, runtimeId: "gen-1", identityRegistry: getBoundIdentityRegistry({}), pendingCancellations: new BoundPendingCancellationRegistryV2(() => 1_000), executionPort: port });
	coordinator.activateSink("gen-1", bridge.sink);
	try {
		const admitted = await admitBoundLaunch(fixture);
		authorized.set(admitted.contract.prospectiveRunId, admitted);
		const request = fixture.request({ prospectiveRunId: admitted.contract.prospectiveRunId });
		const preflight = await service.preflight(request);
		assert.ok(preflight?.ok);
		const launched = bus.handlers.get(BOUND_LAUNCH_EVENT)!({ version: BOUND_CHANNEL_VERSION, requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, request, binding: boundBindingOf(preflight.data) }) as Promise<void>;
		await started(registry, admitted.contract.prospectiveRunId);
		coordinator.stopOwner("gen-1");
		await launched;
		assert.equal(bus.terminals.length, 1);
		assert.equal(bus.terminals[0]!.status, "cancelled");
		executor.release();
		await port.whenIdle();
		await sleep(20);
		assert.equal(bus.terminals.length, 1, "the late completion is not published");
	} finally { bridge.dispose(); service.dispose(); executor.release(); }
});

test("cancelling one run neither disposes nor cancels its neighbour", async () => {
	const registry = new BoundRunRegistryV1();
	const first = await admitBoundLaunch(fixture);
	const second = await admitBoundLaunch(fixture);
	const executor = hangingExecutor(registry, new Map([[first.contract.prospectiveRunId, first], [second.contract.prospectiveRunId, second]]), { hangShutdown: false });
	const port = createBoundExecutionPort({ executeDelegated: executor.executeDelegated, getContext: () => fixture.context() as never, config: fixture.config, registry, hardTimerMs: HARD_TIMER_MS });
	const cancelled = new AbortController();
	const neighbour = new AbortController();
	const firstOutcome = port.run({ launch: first, signal: cancelled.signal, onUpdate: () => {} });
	await started(registry, first.contract.prospectiveRunId);
	const secondOutcome = port.run({ launch: second, signal: neighbour.signal, onUpdate: () => {} });
	await started(registry, second.contract.prospectiveRunId);
	cancelled.abort();
	assert.equal((await firstOutcome).status, "cancelled");
	assert.deepEqual(executor.probes.map((probe) => probe.disposed), [1, 0]);
	assert.equal(neighbour.signal.aborted, false);
	executor.release();
	assert.notEqual((await secondOutcome).status, "cancelled");
	assert.equal(executor.probes[1]!.disposed, 0);
});

async function pendingAfter(outcome: Promise<unknown>, ms: number): Promise<boolean> {
	return Promise.race([outcome.then(() => false), sleep(ms).then(() => true)]);
}

test("positive control: a port that waits for executeDelegated does not meet the bound", async () => {
	const registry = new BoundRunRegistryV1();
	const launch = await admitBoundLaunch(fixture);
	const executor = hangingExecutor(registry, new Map([[launch.contract.prospectiveRunId, launch]]), { hangShutdown: false });
	const port = createBoundExecutionPort({ executeDelegated: executor.executeDelegated, getContext: () => fixture.context() as never, config: fixture.config, registry, hardTimerMs: 2_000_000_000 });
	const controller = new AbortController();
	const outcome = port.run({ launch, signal: controller.signal, onUpdate: () => {} });
	await started(registry, launch.contract.prospectiveRunId);
	controller.abort();
	assert.equal(await pendingAfter(outcome, PROMISED_MS + SLACK_MS), true);
	executor.release();
	await outcome;
});

test("positive control: the upstream default shutdown bound does not meet it on a hanging session_shutdown", async () => {
	const registry = new BoundRunRegistryV1();
	const launch = await admitBoundLaunch(fixture);
	const executor = hangingExecutor(registry, new Map([[launch.contract.prospectiveRunId, launch]]), { hangShutdown: true, factory: "upstream-default" });
	const port = createBoundExecutionPort({ executeDelegated: executor.executeDelegated, getContext: () => fixture.context() as never, config: fixture.config, registry, hardTimerMs: HARD_TIMER_MS });
	const controller = new AbortController();
	const outcome = port.run({ launch, signal: controller.signal, onUpdate: () => {} });
	await started(registry, launch.contract.prospectiveRunId);
	controller.abort();
	assert.equal(await pendingAfter(outcome, PROMISED_MS + SLACK_MS), true);
	executor.release();
});

test("the layer's session_shutdown handler cancels live attempts and waits until they settled (D3)", async () => {
	const handlers = new Map<string, (data: unknown) => unknown>();
	const piHandlers = new Map<string, (...args: unknown[]) => unknown>();
	const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
	let executorSignal: AbortSignal | undefined;
	const plane = registerBoundControlPlane({
		pi: { on(event: string, handler: (...args: unknown[]) => unknown) { piHandlers.set(event, handler); } } as never,
		events: {
			on(event: string, handler: (data: unknown) => unknown) { handlers.set(event, handler); return () => handlers.delete(event); },
			emit(event: string, data: unknown) { emitted.push({ event, data: data as Record<string, unknown> }); },
		},
		getContext: () => fixture.context() as never,
		config: fixture.config,
		waitToolEnabled: false,
		resolveCapabilityCeiling: () => undefined,
		serverInstanceId: FIXTURE_SERVER_INSTANCE_ID,
		resolveSourceIdentity: () => fixtureSourceIdentity(),
		attestRuntime: async () => ({ ok: true as const, runtime: { attestation: FIXTURE_PI_RUNTIME, runtimeBuiltins: FIXTURE_RUNTIME_BUILTINS, packageRoot: "/fixture/pi" } }),
		layerManifest: () => FIXTURE_LAYER_MANIFEST,
		coordinator: new BoundAttemptCoordinator(),
		childShutdown: false,
		store: {},
		selfCheck: async () => ({ agent: true, streamFunction: true, getActiveToolNames: true, loaded: true }),
		// An executor that settles once it is aborted, like the upstream one.
		executeDelegated: async (_id, _params, signal) => {
			executorSignal = signal;
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			return { content: [], details: { mode: "single", results: [] } } as unknown as DelegatedResult;
		},
	});
	try {
		const request = fixture.request({ prospectiveRunId: randomUUID() });
		await handlers.get(BOUND_REQUEST_EVENT)!({ version: BOUND_CHANNEL_VERSION, requestId: "preflight", method: "preflight", params: request });
		const reply = emitted.find((entry) => entry.event === boundReplyEvent("preflight"))!.data;
		void handlers.get(BOUND_LAUNCH_EVENT)!({ version: BOUND_CHANNEL_VERSION, requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, request, binding: boundBindingOf(reply.data as Parameters<typeof boundBindingOf>[0]) });
		for (let attempt = 0; attempt < 500 && !executorSignal; attempt++) await sleep(2);
		assert.ok(executorSignal, "the attempt reached the executor");
		await piHandlers.get("session_shutdown")!({ reason: "quit" }, fixture.context());
		assert.equal(executorSignal!.aborted, true);
		const terminals = emitted.filter((entry) => entry.event === BOUND_TERMINAL_EVENT);
		assert.deepEqual(terminals.map((entry) => entry.data.status), ["cancelled"], "the terminal exists once the handler returned");
	} finally { plane.stop(); }
});

for (const [label, timing] of [
	["create() starts only after the deadline", { createAfterMs: 200, reloadDelayMs: 0, sessions: 0 }],
	["create() is still loading when the deadline passes", { createAfterMs: 0, reloadDelayMs: 200, sessions: 1 }],
] as const) {
	test(`a child that would appear after the cancel deadline is never left alive: ${label}`, async () => {
		const registry = new BoundRunRegistryV1();
		const launch = await admitBoundLaunch(fixture);
		const { pi, probe } = fakePi({ reloadDelayMs: timing.reloadDelayMs });
		let created: Promise<unknown> | undefined;
		const executeDelegated: BoundExecuteDelegated = async (_id, params) => {
			const runId = boundRunIdOf(params)!;
			await sleep(timing.createAfterMs);
			created = createBoundChildSessionFactory({ runId, expectedRunId: runId }, { registry, loadPiCodingAgent: async () => pi, processCwd: () => fixture.project, shutdownTimeoutMs: SHUTDOWN_MS, transcriptApi: TEST_TRANSCRIPT_API })
				.create(contractLaunch(fixture, launch));
			await created.catch(() => {});
			return { content: [], details: { mode: "single", results: [] } } as unknown as DelegatedResult;
		};
		const port = createBoundExecutionPort({ executeDelegated, getContext: () => fixture.context() as never, config: fixture.config, registry, hardTimerMs: HARD_TIMER_MS });
		const controller = new AbortController();
		const outcome = port.run({ launch, signal: controller.signal, onUpdate: () => {} });
		controller.abort();
		assert.equal((await outcome).status, "cancelled");
		await port.whenIdle();
		for (let attempt = 0; attempt < 200 && !created; attempt++) await sleep(5);
		await assert.rejects(created!, "the late child is refused, not handed to the executor");
		assert.equal(probe.disposed, probe.sessions, "every session that was created is disposed exactly once");
		assert.equal(probe.sessions, timing.sessions);
		assert.equal(probe.requests, 0);
	});
}
