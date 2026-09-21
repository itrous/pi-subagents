import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { BoundAttemptCoordinator } from "../../src/bound/bound-attempt-coordinator.ts";
import { BOUND_BINDINGS_NAMESPACE } from "../../src/bound/bound-bindings.ts";
import {
	buildBoundExecutionParams, createBoundExecutionPort, type BoundExecuteDelegated, type BoundExecutionPortOptions,
} from "../../src/bound/bound-execution-port.ts";
import { registerBoundLaunchBridge, type BoundExecutionPort } from "../../src/bound/bound-launch-bridge.ts";
import { boundRunIdOf, BoundRunRegistryV1, getBoundRunRegistry, isPrivateBoundRun } from "../../src/bound/bound-run-registry.ts";
import { createBoundRuntimeService, type BoundAuthorizedLaunch, type BoundRuntimeServiceOptions } from "../../src/bound/bound-runtime-service.ts";
import { expectedToolRegistryProjection } from "../../src/bound/bound-tool-registry-projection.ts";
import {
	BOUND_CHANNEL_VERSION, BOUND_LAUNCH_EVENT, BOUND_REQUEST_EVENT, BOUND_TERMINAL_EVENT, BOUND_UPDATE_EVENT, boundReplyEvent, type BoundBindingV2,
} from "../../src/bound/channel.ts";
import { registerBoundControlPlane } from "../../src/bound/index.ts";
import { canonicalSha256 } from "../../src/shared/canonical-json.ts";
import type { ExtensionConfig } from "../../src/shared/types.ts";
import { getBoundIdentityRegistry } from "../../src/slash/bound-identity-registry.ts";
import { BoundPendingCancellationRegistryV2 } from "../../src/bound/bound-pending-cancellation-registry.ts";
import { createBoundFixture, FIXTURE_LAYER_MANIFEST, FIXTURE_PI_RUNTIME, FIXTURE_RUNTIME_BUILTINS, FIXTURE_SERVER_INSTANCE_ID, fixtureSourceIdentity, type BoundFixture } from "../fixtures/bound/harness.ts";

let fixture: BoundFixture;
beforeEach(() => { fixture = createBoundFixture(); });
afterEach(() => { fixture.cleanup(); });

type DelegatedResult = Awaited<ReturnType<BoundExecuteDelegated>>;
type Tuple = { requestId: string; ownerRunId: string; nodeId: string };

const BINDINGS = { ONECPI_REVIEW_ROOT: "/review/root" };

function requestOverrides(extra: Record<string, unknown> = {}): Record<string, unknown> {
	// Every attempt reserves its run id process-wide, so each test takes a fresh one.
	return { prospectiveRunId: randomUUID(), bindings: BINDINGS, ...extra };
}

function bindingOf(data: { serverInstanceId: string; launchContract: { prospectiveRunId: string }; sourceIdentityDigest: string; activeSessionDigest: string; requestDigest: string; launchContractDigest: string; receipt: unknown; cancellationToken: unknown }): BoundBindingV2 {
	return {
		version: BOUND_CHANNEL_VERSION, targetServerInstanceId: data.serverInstanceId, prospectiveRunId: data.launchContract.prospectiveRunId,
		expectedSourceIdentityDigest: data.sourceIdentityDigest, expectedActiveSessionDigest: data.activeSessionDigest,
		requestDigest: data.requestDigest, expectedLaunchContractDigest: data.launchContractDigest,
		receipt: data.receipt, cancellationToken: data.cancellationToken,
	} as BoundBindingV2;
}

async function admittedLaunch(extra: Record<string, unknown> = {}): Promise<BoundAuthorizedLaunch> {
	const service = createBoundRuntimeService(fixture.serviceOptions() as unknown as BoundRuntimeServiceOptions);
	try {
		const request = fixture.request(requestOverrides(extra));
		const preflight = await service.preflight(request);
		assert.ok(preflight?.ok, "preflight must succeed");
		const admitted = await service.admit(request, bindingOf(preflight.data));
		assert.ok(admitted.ok, "admission must succeed");
		return admitted.launch;
	} finally { service.dispose(); }
}

function childResult(overrides: Record<string, unknown> = {}): DelegatedResult {
	return {
		content: [{ type: "text", text: "done" }],
		details: {
			mode: "single",
			runId: "executor-run",
			results: [{
				agent: "reviewer", task: "Review the diff.", exitCode: 0, messages: [], finalOutput: "done",
				model: "openai/gpt-5:medium", thinking: "medium",
				usage: { input: 3, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
				progressSummary: { toolCount: 2, durationMs: 40, tokens: 8 },
				...overrides,
			}],
		},
	} as unknown as DelegatedResult;
}

/** Stand-in for the bound child factory (step Sh2): it fills the run's collectors the way the barrier will. */
function recordEvidence(registry: BoundRunRegistryV1, params: unknown, denied: string[] = []): void {
	const runId = boundRunIdOf(params);
	assert.ok(runId, "params carry the bound capability");
	const record = registry.get(runId)!;
	record.registry.recordProjection(expectedToolRegistryProjection(record.launch.contract.toolRegistry.projection.required, record.launch.contract.toolRegistry.projection.internalTools)!);
	for (const name of denied) record.denials.record(name);
}

function port(executeDelegated: BoundExecuteDelegated, overrides: Partial<BoundExecutionPortOptions> = {}) {
	const registry = new BoundRunRegistryV1();
	const handle = createBoundExecutionPort({
		executeDelegated,
		getContext: () => fixture.context() as never,
		config: fixture.config,
		childFactoryWired: () => true,
		registry,
		...overrides,
	});
	return { handle, registry };
}

const noUpdate = () => {};

test("executor params are built only from the contract and carry the D14 switches", async () => {
	const launch = await admittedLaunch();
	const params = buildBoundExecutionParams(launch);
	const { contract } = launch;
	assert.deepEqual(params, {
		agent: contract.agent.name,
		task: launch.request.task,
		cwd: contract.canonicalCwd,
		model: contract.model,
		delegatedThinkingOverride: contract.thinking,
		context: "fresh",
		foregroundOnly: true,
		async: false,
		clarify: false,
		share: false,
		acceptance: false,
		output: false,
		skill: contract.skills.map((skill) => skill.name),
		timeoutMs: contract.timeoutMs,
		delegatedAllowZeroToolBudget: true,
		outputMode: "inline",
		artifacts: contract.policy.artifacts,
		extensionBindings: { [BOUND_BINDINGS_NAMESPACE]: BINDINGS },
		control: { enabled: false },
		intercomBridge: { mode: "off" },
	});
	assert.equal(canonicalSha256(params!.task), contract.taskDigest);
	// The request must still hash to the contract: a task or binding swapped after
	// admission produces no params at all.
	assert.equal(buildBoundExecutionParams({ ...launch, request: { ...launch.request, task: "Something else." } }), undefined);
	assert.equal(buildBoundExecutionParams({ ...launch, request: { ...launch.request, bindings: { ONECPI_REVIEW_ROOT: "/other" } } }), undefined);
	// Each contract-derived field follows the contract.
	const changed = buildBoundExecutionParams({ ...launch, contract: { ...contract, canonicalCwd: "/elsewhere", model: "openai/gpt-4", thinking: "high", timeoutMs: 5, skills: [], toolBudget: { hard: 0 } } });
	assert.deepEqual([changed?.cwd, changed?.model, changed?.delegatedThinkingOverride, changed?.timeoutMs, changed?.skill, changed?.toolBudget], ["/elsewhere", "openai/gpt-4", "high", 5, false, { hard: 0 }]);
	const structured = buildBoundExecutionParams({ ...launch, contract: { ...contract, result: { kind: "structured", schema: { type: "object" } } } });
	assert.deepEqual(structured?.outputSchema, { type: "object" });
});

test("a host usageBudget refuses the run closed before the executor (D15); without it the run proceeds", async () => {
	const launch = await admittedLaunch();
	let calls = 0;
	const executor: BoundExecuteDelegated = async () => { calls++; return childResult(); };
	const budgeted = port(executor, { config: { ...fixture.config, usageBudget: { tokens: 10 } } as ExtensionConfig });
	assert.deepEqual(await budgeted.handle.run({ launch, signal: new AbortController().signal, onUpdate: noUpdate }), { status: "unavailable_context", toolRegistryError: "policy_mismatch" });
	assert.equal(calls, 0);
	const plain = port(executor);
	await plain.handle.run({ launch, signal: new AbortController().signal, onUpdate: noUpdate });
	assert.equal(calls, 1);
});

test("without the child factory slot the port refuses before any executor call", async () => {
	const launch = await admittedLaunch();
	let calls = 0;
	const { handle } = port(async () => { calls++; return childResult(); }, { childFactoryWired: undefined });
	assert.deepEqual(await handle.run({ launch, signal: new AbortController().signal, onUpdate: noUpdate }), { status: "unavailable_context" });
	assert.equal(calls, 0);
});

test("updates carry exactly the keys the client reads", async () => {
	const launch = await admittedLaunch();
	const updates: Array<Record<string, unknown>> = [];
	const { handle, registry } = port(async (_id, params, _signal, onUpdate) => {
		recordEvidence(registry, params);
		onUpdate?.({
			content: [{ type: "text", text: "secret partial output" }],
			details: {
				mode: "single", runId: "executor-run", results: [],
				progress: [{ index: 0, agent: "reviewer", status: "running", task: "Review the diff.", currentTool: "read", currentToolArgs: "/secret/path", recentTools: [], recentOutput: ["secret"], toolCount: 1, tokens: 12, durationMs: 30, model: "openai/gpt-5:medium" }],
			},
		} as unknown as DelegatedResult);
		return childResult();
	});
	await handle.run({ launch, signal: new AbortController().signal, onUpdate: (update) => updates.push(update) });
	assert.deepEqual(updates, [{ model: "openai/gpt-5:medium", durationMs: 30, tokens: 12, currentTool: "read" }]);
});

test("a successful run completes with its evidence; the params carry the capability privately", async () => {
	const launch = await admittedLaunch();
	let seen: unknown;
	const { handle, registry } = port(async (_id, params) => {
		seen = params;
		assert.equal(isPrivateBoundRun(launch.contract.prospectiveRunId, {}), false, "another store sees nothing");
		assert.equal(registry.has(launch.contract.prospectiveRunId), true, "the record is live during execution");
		recordEvidence(registry, params, ["bash"]);
		return childResult();
	});
	const outcome = await handle.run({ launch, signal: new AbortController().signal, onUpdate: noUpdate });
	assert.equal(boundRunIdOf(seen), launch.contract.prospectiveRunId);
	assert.equal(JSON.stringify(seen).includes(launch.contract.prospectiveRunId), false, "the capability never serializes");
	assert.deepEqual(outcome, {
		status: "completed",
		runId: "executor-run",
		agent: "reviewer",
		model: "openai/gpt-5:medium",
		thinking: "medium",
		exitCode: 0,
		launchContractDigest: launch.contract.digest,
		toolRegistry: expectedToolRegistryProjection(launch.contract.toolRegistry.projection.required, launch.contract.toolRegistry.projection.internalTools),
		deniedToolCalls: [{ name: "bash", reason: "not_in_contract" }],
		transportIncomplete: true,
		result: { kind: "text", text: "done" },
		usage: { input: 3, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 2, durationMs: 40 },
	});
	assert.equal(registry.has(launch.contract.prospectiveRunId), false, "the record is removed after the run");
});

test("an executor exception settles as failed with the run's evidence", async () => {
	const launch = await admittedLaunch();
	const { handle, registry } = port(async (_id, params) => { recordEvidence(registry, params); throw new Error("executor broke"); });
	const outcome = await handle.run({ launch, signal: new AbortController().signal, onUpdate: noUpdate });
	assert.equal(outcome.status, "failed");
	assert.equal(outcome.launchContractDigest, launch.contract.digest);
	assert.deepEqual(outcome.deniedToolCalls, []);
	assert.equal(registry.has(launch.contract.prospectiveRunId), false);
});

test("a recorded registry failure wins over the executor status (D8 mapping)", async () => {
	const launch = await admittedLaunch();
	const { handle, registry } = port(async (_id, params) => {
		registry.get(boundRunIdOf(params)!)!.registry.fail({ status: "native_tool_registry_mismatch", toolsMissing: ["read"], toolsExtra: ["bash"] });
		return childResult({ exitCode: 1, error: "Tool registry mismatch" });
	});
	const outcome = await handle.run({ launch, signal: new AbortController().signal, onUpdate: noUpdate });
	assert.equal(outcome.status, "native_tool_registry_mismatch");
	assert.deepEqual([outcome.toolsMissing, outcome.toolsExtra, outcome.toolRegistryError], [["read"], ["bash"], undefined]);
	const compaction = port(async (_id, params) => {
		compaction.registry.get(boundRunIdOf(params)!)!.registry.fail({ status: "native_tool_registry_mismatch", toolRegistryError: "compaction_forbidden" });
		return childResult();
	});
	const second = await compaction.handle.run({ launch: await admittedLaunch(), signal: new AbortController().signal, onUpdate: noUpdate });
	assert.deepEqual([second.status, second.toolRegistryError], ["native_tool_registry_mismatch", "compaction_forbidden"]);
});

test("a completion without a registry snapshot is not reported as success", async () => {
	const launch = await admittedLaunch();
	const { handle } = port(async () => childResult());
	const outcome = await handle.run({ launch, signal: new AbortController().signal, onUpdate: noUpdate });
	assert.deepEqual([outcome.status, outcome.toolRegistryError, outcome.result], ["native_tool_registry_mismatch", "barrier_unavailable", undefined]);
});

test("after the generation stops the port relays nothing and starts nothing", async () => {
	const launch = await admittedLaunch();
	const updates: Array<Record<string, unknown>> = [];
	let release!: () => void;
	let relay: ((update: DelegatedResult) => void) | undefined;
	let calls = 0;
	const { handle, registry } = port(async (_id, params, _signal, onUpdate) => {
		calls++;
		relay = onUpdate;
		recordEvidence(registry, params);
		await new Promise<void>((resolve) => { release = resolve; });
		return childResult();
	});
	const running = handle.run({ launch, signal: new AbortController().signal, onUpdate: (update) => updates.push(update) });
	while (!relay) await new Promise((resolve) => setImmediate(resolve));
	const progress = { content: [], details: { mode: "single", results: [], progress: [{ currentTool: "read", durationMs: 1, tokens: 1 }] } } as unknown as DelegatedResult;
	relay(progress);
	handle.dispose();
	relay(progress);
	release();
	await running;
	assert.equal(updates.length, 1);
	assert.deepEqual(await handle.run({ launch: await admittedLaunch(), signal: new AbortController().signal, onUpdate: noUpdate }), { status: "unavailable_context" });
	assert.equal(calls, 1);
});

function createBus() {
	const handlers = new Map<string, Array<(data: unknown) => unknown>>();
	const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
	return {
		on(event: string, handler: (data: unknown) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
		},
		emit(event: string, data: unknown) { emitted.push({ event, data: data as Record<string, unknown> }); },
		async deliver(event: string, data: unknown) { for (const handler of [...(handlers.get(event) ?? [])]) await handler(data); },
		of(event: string) { return emitted.filter((entry) => entry.event === event).map((entry) => entry.data); },
	};
}

async function launchThroughBridge(executionPort: BoundExecutionPort | undefined): Promise<Array<Record<string, unknown>>> {
	const bus = createBus();
	const service = createBoundRuntimeService(fixture.serviceOptions() as unknown as BoundRuntimeServiceOptions);
	const coordinator = new BoundAttemptCoordinator();
	const bridge = registerBoundLaunchBridge({
		events: bus, service, coordinator, runtimeId: "gen-1", identityRegistry: getBoundIdentityRegistry({}),
		pendingCancellations: new BoundPendingCancellationRegistryV2(() => 1_000), ...(executionPort ? { executionPort } : {}),
	});
	coordinator.activateSink("gen-1", bridge.sink);
	try {
		const request = fixture.request(requestOverrides());
		const preflight = await service.preflight(request);
		assert.ok(preflight?.ok);
		await bus.deliver(BOUND_LAUNCH_EVENT, { version: BOUND_CHANNEL_VERSION, requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, request, binding: bindingOf(preflight.data) });
		return bus.of(BOUND_TERMINAL_EVENT);
	} finally { bridge.dispose(); service.dispose(); }
}

test("through the bridge the port yields exactly one completed terminal; positive control: no port gives unavailable_context (I3.19)", async () => {
	const { handle, registry } = port(async (_id, params) => { recordEvidence(registry, params); return childResult(); });
	const withPort = await launchThroughBridge(handle);
	assert.equal(withPort.length, 1);
	assert.equal(withPort[0]!.status, "completed");
	assert.deepEqual(await launchThroughBridge(undefined), [{ requestId: "request-1", ownerRunId: "owner-1", nodeId: "node-1", status: "unavailable_context" }]);
});

test("the control plane builds its port from executeDelegated and silences it on stop", async () => {
	const bus = createBus();
	const store: Record<string, unknown> = {};
	const registry = getBoundRunRegistry();
	let release!: () => void;
	let relay: ((update: DelegatedResult) => void) | undefined;
	const plane = registerBoundControlPlane({
		pi: { on() {} },
		events: bus,
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
		store,
		childFactoryWired: () => true,
		executeDelegated: async (_id, params, _signal, onUpdate) => {
			relay = onUpdate;
			recordEvidence(registry, params);
			await new Promise<void>((resolve) => { release = resolve; });
			return childResult();
		},
	});
	try {
		// Receipts are per service, so the binding comes from the plane's own preflight.
		const request = fixture.request(requestOverrides());
		await bus.deliver(BOUND_REQUEST_EVENT, { version: BOUND_CHANNEL_VERSION, requestId: "plane-preflight", method: "preflight", params: request });
		const reply = bus.of(boundReplyEvent("plane-preflight"))[0];
		assert.equal(reply?.success, true, JSON.stringify(reply));
		const data = reply!.data as Parameters<typeof bindingOf>[0];
		const tuple: Tuple = { requestId: request.requestId as string, ownerRunId: request.ownerRunId as string, nodeId: request.nodeId as string };
		const launched = bus.deliver(BOUND_LAUNCH_EVENT, { version: BOUND_CHANNEL_VERSION, ...tuple, request, binding: bindingOf(data) });
		while (!relay) await new Promise((resolve) => setImmediate(resolve));
		const progress = { content: [], details: { mode: "single", results: [], progress: [{ currentTool: "read", durationMs: 1, tokens: 1 }] } } as unknown as DelegatedResult;
		relay(progress);
		assert.equal(bus.of(BOUND_UPDATE_EVENT).length, 1);
		// The same stop `session_shutdown` performs: intake closes, the sink stays.
		plane.stop({ keepSink: true });
		relay(progress);
		release();
		await launched;
		assert.equal(bus.of(BOUND_UPDATE_EVENT).length, 1, "no update after the generation stopped");
		const terminals = bus.of(BOUND_TERMINAL_EVENT);
		assert.equal(terminals.length, 1);
		assert.equal(terminals[0]!.status, "cancelled");
	} finally { plane.stop(); }
});
