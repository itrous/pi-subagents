import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { BoundAttemptCoordinator } from "../../src/bound/bound-attempt-coordinator.ts";
import type { BoundExecuteDelegated } from "../../src/bound/bound-execution-port.ts";
import { runBoundSelfCheck, type BoundSelfCheckResult } from "../../src/bound/bound-self-check.ts";
import { BOUND_CHANNEL_VERSION, BOUND_REQUEST_EVENT, boundReplyEvent } from "../../src/bound/channel.ts";
import { registerBoundControlPlane, type RegisterBoundControlPlaneOptions } from "../../src/bound/index.ts";
import type { PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { createBoundFixture, FIXTURE_LAYER_MANIFEST, FIXTURE_PI_RUNTIME, FIXTURE_RUNTIME_BUILTINS, FIXTURE_SERVER_INSTANCE_ID, fixtureSourceIdentity, type BoundFixture } from "../fixtures/bound/harness.ts";

let fixture: BoundFixture;
beforeEach(() => { fixture = createBoundFixture(); });
afterEach(() => { fixture.cleanup(); });

const PASSED: BoundSelfCheckResult = { agent: true, streamFunction: true, getActiveToolNames: true, loaded: true };
const neverExecutes: BoundExecuteDelegated = async () => { throw new Error("not executed in this test"); };

async function capabilities(overrides: Partial<RegisterBoundControlPlaneOptions> = {}): Promise<Record<string, unknown>> {
	const handlers = new Map<string, (data: unknown) => unknown>();
	const replies = new Map<string, Record<string, unknown>>();
	const plane = registerBoundControlPlane({
		pi: { on() {} },
		events: {
			on(event: string, handler: (data: unknown) => unknown) { handlers.set(event, handler); return () => handlers.delete(event); },
			emit(event: string, data: unknown) { replies.set(event, data as Record<string, unknown>); },
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
		executeDelegated: neverExecutes,
		selfCheck: async () => PASSED,
		...overrides,
	});
	try {
		// The self-check settles asynchronously after publication.
		await new Promise((resolve) => setImmediate(resolve));
		await handlers.get(BOUND_REQUEST_EVENT)!({ version: BOUND_CHANNEL_VERSION, requestId: "ping-1", method: "ping" });
		const reply = replies.get(boundReplyEvent("ping-1"));
		assert.equal(reply?.success, true);
		return (reply!.data as { capabilities: Record<string, unknown> }).capabilities;
	} finally { plane.stop(); }
}

test("the full configuration announces boundForegroundLeaf v2", async () => {
	assert.deepEqual(await capabilities(), { activeRuntimeIdentity: { version: 2 }, boundForegroundLeaf: { version: 2 } });
});

const REMOVALS: Array<[string, Partial<RegisterBoundControlPlaneOptions>]> = [
	["the execution port", { executeDelegated: undefined }],
	["the registry collector", { proofs: { toolRegistry: false, deniedTools: true } }],
	["the denial collector", { proofs: { toolRegistry: true, deniedTools: false } }],
	["Agent.streamFunction", { selfCheck: async () => ({ ...PASSED, streamFunction: false }) }],
	["AgentSession.agent", { selfCheck: async () => ({ ...PASSED, agent: false }) }],
	["loader.loaded", { selfCheck: async () => ({ ...PASSED, loaded: false }) }],
	["getActiveToolNames", { selfCheck: async () => ({ ...PASSED, getActiveToolNames: false }) }],
	["a settled self-check", { selfCheck: () => new Promise<BoundSelfCheckResult>(() => {}) }],
	["source identity", { resolveSourceIdentity: () => fixtureSourceIdentity(false) }],
];

for (const [label, override] of REMOVALS) {
	test(`removing ${label} removes the capability`, async () => {
		const announced = await capabilities(override);
		assert.equal(Object.hasOwn(announced, "boundForegroundLeaf"), false);
	});
}

test("positive control: removing an unrelated condition keeps the capability", async () => {
	assert.deepEqual(await capabilities({ waitToolEnabled: true, getContext: () => null }), { activeRuntimeIdentity: { version: 2 }, boundForegroundLeaf: { version: 2 } });
});

/** Tier-1 module for the self-check itself: one member can be removed at a time. */
function selfCheckModule(missing?: "agent" | "streamFunction" | "loaded" | "getActiveToolNames"): { pi: PiCodingAgentModule; disposed: () => number } {
	let disposed = 0;
	const pi = {
		ModelRuntime: { create: async () => ({}) },
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: missing === "loaded" ? class {} : class { loaded = false; },
		SessionManager: { inMemory: () => ({}) },
		createAgentSession: async () => ({
			session: {
				...(missing === "agent" ? {} : { agent: missing === "streamFunction" ? {} : { streamFunction: () => ({}) } }),
				...(missing === "getActiveToolNames" ? {} : { getActiveToolNames: () => ["read"] }),
				dispose() { disposed += 1; },
			},
		}),
	};
	return { pi: pi as unknown as PiCodingAgentModule, disposed: () => disposed };
}

test("the self-check reads all four Pi fields and disposes its session", async () => {
	const full = selfCheckModule();
	assert.deepEqual(await runBoundSelfCheck({ loadPiCodingAgent: async () => full.pi }), PASSED);
	assert.equal(full.disposed(), 1);
	for (const missing of ["agent", "streamFunction", "loaded", "getActiveToolNames"] as const) {
		const module = selfCheckModule(missing);
		const result = await runBoundSelfCheck({ loadPiCodingAgent: async () => module.pi });
		assert.equal(result[missing], false, missing);
		assert.equal(Object.values(result).filter((value) => !value).length, missing === "agent" ? 2 : 1, missing);
	}
});

const sdkRoot = process.env.PI_SUBAGENTS_NATIVE_SDK;
test("the self-check passes on the installed Pi without a provider call", { skip: !sdkRoot && "Set PI_SUBAGENTS_NATIVE_SDK to the isolated 0.85.1 SDK root" }, async () => {
	const entry = execFileSync(process.execPath, ["--input-type=module", "-e", "console.log(import.meta.resolve('@earendil-works/pi-coding-agent'))"], { cwd: sdkRoot, encoding: "utf8" }).trim();
	const pi = await import(entry) as PiCodingAgentModule;
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "bound-self-check-agent-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	const previousFetch = globalThis.fetch;
	let fetches = 0;
	globalThis.fetch = (async () => { fetches += 1; throw new Error("no network in the self-check"); }) as typeof fetch;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		assert.deepEqual(await runBoundSelfCheck({ loadPiCodingAgent: async () => pi, cwd: agentDir }), PASSED);
		assert.equal(fetches, 0);
	} finally {
		globalThis.fetch = previousFetch;
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});
