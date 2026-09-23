import assert from "node:assert/strict";
import * as fs from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { BOUND_CHILD_REFUSED_TEXT, boundLaunch, createBoundChildSessionFactory, type BoundChildSessionFactoryOptions } from "../../src/bound/bound-child-factory.ts";
import { BOUND_RUN_HOOK_NAME } from "../../src/bound/bound-run-hooks.ts";
import { BoundRunRegistryV1 } from "../../src/bound/bound-run-registry.ts";
import type { BoundAuthorizedLaunch } from "../../src/bound/bound-runtime-service.ts";
import { createDefaultChildSessionFactory, type ChildSessionLaunch, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { createBoundFixture, type BoundFixture } from "../fixtures/bound/harness.ts";
import { admitBoundLaunch, contractLaunch, writeMcpFixture } from "../support/bound-launch.ts";
import { expectedToolRegistryProjection } from "../../src/bound/bound-tool-registry-projection.ts";
import { fakePi, type FailurePoint } from "../support/bound-fake-pi.ts";
import { until } from "../support/bound-executor.ts";
import { TEST_TRANSCRIPT_API } from "../support/bound-transcript.ts";

const ENV = "MCP_DIRECT_TOOLS";
const FAILURE_POINTS: FailurePoint[] = ["reload", "getExtensions", "refresh", "inheritProvider", "sessionManager", "resolveCliModel", "createAgentSession", "bindExtensions"];

let fixture: BoundFixture;
let savedEnv: string | undefined;
beforeEach(() => { fixture = createBoundFixture(); savedEnv = process.env[ENV]; });
afterEach(() => {
	if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv;
	fixture.cleanup();
});

const envSnapshot = (): string => JSON.stringify(Object.entries(process.env).sort(([left], [right]) => (left < right ? -1 : 1)));

async function setup(authorizedOverride?: (launch: BoundAuthorizedLaunch) => BoundAuthorizedLaunch) {
	const registry = new BoundRunRegistryV1();
	const admitted = await admitBoundLaunch(fixture, { bindings: { ONECPI_REVIEW_ROOT: "/review" } });
	const authorized = authorizedOverride ? authorizedOverride(admitted) : admitted;
	const record = registry.open(authorized)!;
	const launch = contractLaunch(fixture, authorized);
	fs.mkdirSync(fixture.sessionDir, { recursive: true });
	return { registry, record, authorized, launch };
}

function factoryFor(registry: BoundRunRegistryV1, runId: string, pi: PiCodingAgentModule, extra: Partial<BoundChildSessionFactoryOptions> = {}) {
	return createBoundChildSessionFactory({ runId, expectedRunId: runId }, { registry, loadPiCodingAgent: async () => pi, processCwd: () => fixture.project, transcriptApi: TEST_TRANSCRIPT_API, ...extra });
}

test("create() returns the base factory's child, with the run hook first and the env window restored", async () => {
	const { registry, record, launch } = await setup();
	const { pi, probe } = fakePi();
	process.env[ENV] = "parent/value";
	const before = envSnapshot();
	const child = await factoryFor(registry, record.runId, pi).create(launch);
	assert.equal(envSnapshot(), before, "process.env is byte-equal after create()");
	assert.equal(record.child, child, "the registry holds the returned child itself");
	assert.deepEqual(Object.keys(child).sort(), ["abort", "dispose", "followUp", "hasQueuedMessages", "messages", "modelId", "prompt", "sessionFile", "sessionId", "steer", "subscribe"]);
	assert.equal(probe.hookNames[0], BOUND_RUN_HOOK_NAME);
	assert.deepEqual([probe.envAtReload, probe.envAtBind], [["__none__"], ["__none__"]]);
	assert.deepEqual({ ...registry.sessionBindingsFor("child-session") }, { ONECPI_REVIEW_ROOT: "/review" });
	assert.ok(record.registry.projection, "the registry snapshot was taken");
	await child.prompt("go");
	assert.equal(probe.requests, 1, "a matching registry reaches the stream function exactly once");
	assert.equal(record.registry.failure, undefined);
});

test("the launch handed to the base factory carries no required-extension or package paths", async () => {
	// As upstream builds it under a host policy (registerRequiredChildExtensions): the
	// required path sits in both `requiredExtensions` and `extensionPaths`. The recheck
	// refuses such a launch and preflight refuses the host (bound-resolver.test.ts), so
	// the decorator's own guarantee is checked on `boundLaunch` as a unit.
	const { launch } = await setup();
	const policy = { ...launch, requiredExtensions: [{ id: "host-policy", path: "/host-required.ts" }], extensionPaths: ["/host-required.ts", "package:fixture-ext"] };
	const handed = boundLaunch(policy, { hooks: [], processEnv: {}, onExtensionError: () => {} });
	assert.deepEqual([handed.requiredExtensions, handed.extensionPaths], [[], []]);
	// End to end: a base factory that would throw "Required child extension failed to
	// load" for that path never sees it.
	const { pi } = fakePi({ requiredError: "/host-required.ts" });
	await createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi }).create(handed);
	await assert.rejects(createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi }).create(policy), /Required child extension failed to load/, "positive control: the raw launch does fail open()");
});

/**
 * A capability ceiling leaves one of the server's tools: the agent selects the
 * whole `bsl-ws` server, the contract keeps only `bsl-ws_search`.
 */
const mcpContract = (launch: BoundAuthorizedLaunch): BoundAuthorizedLaunch => {
	const required = ["bsl-ws_search", "read"];
	return {
		...launch,
		contract: {
			...launch.contract,
			mcpDirectTools: ["bsl-ws_search"],
			tools: { ...launch.contract.tools, effectiveAllowlist: required },
			toolRegistry: { ...launch.contract.toolRegistry, projection: expectedToolRegistryProjection(required, [])! },
		},
		agent: { ...launch.agent, mcpDirectTools: ["bsl-ws"], definitionDigest: launch.contract.agent.definitionDigest },
	};
};

test("the MCP window carries only the effective selector; the leaf passes the D10 gate only at its cwd and reaches the provider", async () => {
	writeMcpFixture(fixture, [["bsl-ws", "search"], ["bsl-ws", "graph"]]);
	const { registry, record, launch } = await setup(mcpContract);
	const { pi, probe } = fakePi({ registerFromMcpWindow: true });
	delete process.env[ENV];
	const child = await factoryFor(registry, record.runId, pi, { processCwd: () => record.launch.contract.canonicalCwd }).create(launch);
	assert.deepEqual(probe.envAtReload, ["bsl-ws/search"], "not the agent's whole-server selector");
	assert.deepEqual([...probe.activeToolNames[0]!].sort(), ["bsl-ws_search", "read"]);
	assert.equal(record.registry.failure, undefined, "the snapshot equals required");
	await child.prompt("go");
	assert.equal(probe.requests, 1);
	assert.equal(process.env[ENV], undefined, "an absent variable is absent again");

	const other = await setup(mcpContract);
	const refused = fakePi();
	await assert.rejects(factoryFor(other.registry, other.record.runId, refused.pi, { processCwd: () => "/elsewhere" }).create(other.launch), { message: BOUND_CHILD_REFUSED_TEXT });
	assert.deepEqual(other.record.registry.failure, { status: "unavailable_context", toolRegistryError: "mcp_cwd_mismatch" });
	assert.deepEqual(refused.probe.envAtReload, [], "no session work before the gate");
});

test("an effective MCP name that no longer resolves refuses the launch", async () => {
	writeMcpFixture(fixture, [["bsl-ws", "graph"]]);
	const { registry, record, launch } = await setup(mcpContract);
	const { pi, probe } = fakePi();
	await assert.rejects(factoryFor(registry, record.runId, pi, { processCwd: () => record.launch.contract.canonicalCwd }).create(launch), { message: BOUND_CHILD_REFUSED_TEXT });
	assert.deepEqual(record.registry.failure, { status: "unavailable_context", toolRegistryError: "launch_contract_mismatch" });
	assert.deepEqual(probe.envAtReload, []);
});

test("a launch that fails the recheck is refused before any session work", async () => {
	const { registry, record, launch } = await setup();
	const { pi, probe } = fakePi();
	await assert.rejects(factoryFor(registry, record.runId, pi).create({ ...launch, model: "openai/gpt-5:high" }), { message: BOUND_CHILD_REFUSED_TEXT });
	assert.deepEqual(record.registry.failure, { status: "unavailable_context", toolRegistryError: "launch_contract_mismatch" });
	assert.deepEqual(probe.envAtReload, []);
	// A factory handed another run id refuses as well.
	await assert.rejects(createBoundChildSessionFactory({ runId: record.runId, expectedRunId: "other" }, { registry, loadPiCodingAgent: async () => pi }).create(launch));
});

test("a live registry that differs from the contract keeps the session but refuses every model call", async () => {
	const { registry, record, launch } = await setup();
	const { pi, probe } = fakePi({ activeTools: (tools) => [...tools, "bash"] });
	const child = await factoryFor(registry, record.runId, pi).create(launch);
	assert.deepEqual(record.registry.failure, { status: "native_tool_registry_mismatch", toolsMissing: [], toolsExtra: ["bash"] });
	await child.prompt("go");
	assert.equal(probe.requests, 0);
});

function failingLaunch(launch: ChildSessionLaunch, point: FailurePoint): ChildSessionLaunch {
	return point === "inheritProvider"
		? { ...launch, parentProviderRegistry: { getRegisteredProviderIds: () => { throw new Error("injected inherit failure"); }, getRegisteredProviderConfig: () => undefined, getRegisteredNativeProvider: () => undefined } as never }
		: launch;
}

for (const preset of ["parent/value", undefined] as const) {
	for (const point of FAILURE_POINTS) {
		test(`a failure at ${point} rejects create() and leaves process.env byte-equal (${preset ?? "unset"})`, async () => {
			const { registry, record, launch } = await setup();
			const { pi, probe } = fakePi({ fail: point });
			if (preset === undefined) delete process.env[ENV]; else process.env[ENV] = preset;
			const before = envSnapshot();
			await assert.rejects(factoryFor(registry, record.runId, pi).create(failingLaunch(launch, point)));
			assert.equal(envSnapshot(), before);
			assert.equal(probe.requests, 0);
		});
	}
}

test("positive control: without any restoration every failure point leaks the window", async () => {
	for (const point of FAILURE_POINTS) {
		const { registry, record, launch } = await setup();
		const { pi } = fakePi({ fail: point });
		process.env[ENV] = "parent/value";
		await assert.rejects(factoryFor(registry, record.runId, pi, { envRestore: "none" }).create(failingLaunch(launch, point)));
		assert.equal(process.env[ENV], "__none__", point);
	}
});

test("a non-bound child queued behind a failed bound launch sees the parent's value (I4.6)", async () => {
	const { registry, record, launch } = await setup();
	const bound = fakePi({ fail: "createAgentSession" });
	const plain = fakePi({ fail: "resolveCliModel" });
	process.env[ENV] = "parent/value";
	const failing = factoryFor(registry, record.runId, bound.pi).create(launch);
	failing.catch(() => {});
	// Deterministic order: the bound open() is already inside upstream's serialized
	// window (its reload ran) before the non-bound launch queues behind it.
	await until(() => bound.probe.envAtReload.length === 1, "bound window open");
	const next = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => plain.pi }).create({ ...launch, hooks: [] });
	await Promise.allSettled([failing, next]);
	assert.deepEqual(plain.probe.envAtReload, ["parent/value"]);
	assert.equal(process.env[ENV], "parent/value");
});

test("positive control: without capturing the session the barrier cannot be installed and create() refuses", async () => {
	const { registry, record, launch } = await setup();
	const { pi, probe } = fakePi();
	await assert.rejects(factoryFor(registry, record.runId, pi, { captureSession: false }).create(launch), { message: BOUND_CHILD_REFUSED_TEXT });
	assert.deepEqual(record.registry.failure, { status: "native_tool_registry_mismatch", toolRegistryError: "barrier_unavailable" });
	assert.equal(probe.disposed, 1, "the uncovered session is disposed");
	assert.equal(probe.requests, 0);
});

test("two concurrent bound launches failing in getExtensions leave process.env byte-equal", async () => {
	const first = await setup();
	const second = await setup();
	process.env[ENV] = "parent/value";
	const before = envSnapshot();
	const results = await Promise.allSettled([
		factoryFor(first.registry, first.record.runId, fakePi({ fail: "getExtensions" }).pi).create(first.launch),
		factoryFor(second.registry, second.record.runId, fakePi({ fail: "getExtensions" }).pi).create(second.launch),
	]);
	assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
	assert.equal(envSnapshot(), before);
});
