import assert from "node:assert/strict";
import * as fs from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { BOUND_CHILD_REFUSED_TEXT, createBoundChildSessionFactory, type BoundChildSessionFactoryOptions } from "../../src/bound/bound-child-factory.ts";
import { BOUND_RUN_HOOK_NAME } from "../../src/bound/bound-run-hooks.ts";
import { BoundRunRegistryV1 } from "../../src/bound/bound-run-registry.ts";
import type { BoundAuthorizedLaunch } from "../../src/bound/bound-runtime-service.ts";
import { createDefaultChildSessionFactory, type ChildSessionLaunch, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { createBoundFixture, type BoundFixture } from "../fixtures/bound/harness.ts";
import { admitBoundLaunch, contractLaunch } from "../support/bound-launch.ts";
import { fakePi, type FailurePoint } from "../support/bound-fake-pi.ts";

const ENV = "MCP_DIRECT_TOOLS";
const FAILURE_POINTS: FailurePoint[] = ["reload", "refresh", "inheritProvider", "sessionManager", "resolveCliModel", "createAgentSession", "bindExtensions"];

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
	return createBoundChildSessionFactory({ runId, expectedRunId: runId }, { registry, loadPiCodingAgent: async () => pi, processCwd: () => fixture.project, ...extra });
}

test("create() returns the base factory's child, with the run hook first and the env window restored", async () => {
	const { registry, record, launch } = await setup();
	const { pi, probe } = fakePi();
	process.env[ENV] = "parent/value";
	const before = envSnapshot();
	const child = await factoryFor(registry, record.runId, pi).create({ ...launch, requiredExtensions: [{ path: "/host-required.ts" }] as never });
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

test("a host-required extension error cannot fail open(): the bound launch loads none", async () => {
	const { registry, record, launch } = await setup();
	const { pi } = fakePi({ requiredError: "/host-required.ts" });
	await factoryFor(registry, record.runId, pi).create({ ...launch, requiredExtensions: [{ path: "/host-required.ts" }] as never });
	assert.equal(record.registry.failure, undefined);
});

const mcpContract = (launch: BoundAuthorizedLaunch): BoundAuthorizedLaunch => ({
	...launch,
	contract: { ...launch.contract, mcpDirectTools: ["bsl-search"] },
	agent: { ...launch.agent, mcpDirectTools: ["bsl/search"], definitionDigest: launch.contract.agent.definitionDigest },
});

test("an MCP leaf gets its selectors in the window and passes the D10 gate only at the leaf cwd", async () => {
	const { registry, record, launch } = await setup(mcpContract);
	const { pi, probe } = fakePi();
	delete process.env[ENV];
	await factoryFor(registry, record.runId, pi, { processCwd: () => record.launch.contract.canonicalCwd }).create(launch);
	assert.deepEqual(probe.envAtReload, ["bsl/search"]);
	assert.equal(process.env[ENV], undefined, "an absent variable is absent again");

	const other = await setup(mcpContract);
	const refused = fakePi();
	await assert.rejects(factoryFor(other.registry, other.record.runId, refused.pi, { processCwd: () => "/elsewhere" }).create(other.launch), { message: BOUND_CHILD_REFUSED_TEXT });
	assert.deepEqual(other.record.registry.failure, { status: "unavailable_context", toolRegistryError: "mcp_cwd_mismatch" });
	assert.deepEqual(refused.probe.envAtReload, [], "no session work before the gate");
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

test("a non-bound child queued right behind a failed bound launch sees the parent's value", async () => {
	const { registry, record, launch } = await setup();
	const bound = fakePi({ fail: "createAgentSession" });
	const plain = fakePi({ fail: "resolveCliModel" });
	process.env[ENV] = "parent/value";
	const failing = factoryFor(registry, record.runId, bound.pi).create(launch);
	// Upstream serializes every open() of the process; this one runs next.
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
