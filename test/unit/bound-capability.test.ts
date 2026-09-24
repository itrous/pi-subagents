import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { BoundAttemptCoordinator } from "../../src/bound/bound-attempt-coordinator.ts";
import type { BoundExecuteDelegated } from "../../src/bound/bound-execution-port.ts";
import { runBoundSelfCheck, type BoundSelfCheckResult } from "../../src/bound/bound-self-check.ts";
import { verifiedBoundTranscriptApi, type BoundTranscriptModules } from "../../src/bound/bound-transcript.ts";
import { TEST_TRANSCRIPT_API } from "../support/bound-transcript.ts";
import { BOUND_CHANNEL_VERSION, BOUND_REQUEST_EVENT, boundReplyEvent } from "../../src/bound/channel.ts";
import { registerBoundControlPlane, type RegisterBoundControlPlaneOptions } from "../../src/bound/index.ts";
import type { PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { createBoundFixture, FIXTURE_LAYER_MANIFEST, FIXTURE_PI_RUNTIME, FIXTURE_RUNTIME_BUILTINS, FIXTURE_SERVER_INSTANCE_ID, fixtureSourceIdentity, type BoundFixture } from "../fixtures/bound/harness.ts";

let fixture: BoundFixture;
beforeEach(() => { fixture = createBoundFixture(); });
afterEach(() => { fixture.cleanup(); });

const PASSED: BoundSelfCheckResult = { agent: true, streamFunction: true, getActiveToolNames: true, loaded: true, transcriptApi: true, transcriptContext: true };
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

const FULL = {
	activeRuntimeIdentity: { version: 2 }, boundForegroundLeaf: { version: 2 },
	boundSessionBindings: { version: 1 }, boundToolShadowing: { version: 1 }, boundMcpConfig: { version: 1 },
	boundMcpDiscovery: { version: 1 }, boundCancellationProof: { version: 1 },
};

test("the full configuration announces boundForegroundLeaf v2 with its feature keys", async () => {
	assert.deepEqual(await capabilities(), FULL);
});

const REMOVALS: Array<[string, Partial<RegisterBoundControlPlaneOptions>]> = [
	["the execution port", { executeDelegated: undefined }],
	["the registry collector", { proofs: { toolRegistry: false, deniedTools: true } }],
	["the denial collector", { proofs: { toolRegistry: true, deniedTools: false } }],
	["Agent.streamFunction", { selfCheck: async () => ({ ...PASSED, streamFunction: false }) }],
	["AgentSession.agent", { selfCheck: async () => ({ ...PASSED, agent: false }) }],
	["loader.loaded", { selfCheck: async () => ({ ...PASSED, loaded: false }) }],
	["getActiveToolNames", { selfCheck: async () => ({ ...PASSED, getActiveToolNames: false }) }],
	["the runtime transcript API", { selfCheck: async () => ({ ...PASSED, transcriptApi: false }) }],
	["the transcript context probe", { selfCheck: async () => ({ ...PASSED, transcriptContext: false }) }],
	["a settled self-check", { selfCheck: () => new Promise<BoundSelfCheckResult>(() => {}) }],
	["source identity", { resolveSourceIdentity: () => fixtureSourceIdentity(false) }],
];

for (const [label, override] of REMOVALS) {
	test(`removing ${label} removes the capability`, async () => {
		const announced = await capabilities(override);
		for (const key of ["boundForegroundLeaf", "boundSessionBindings", "boundToolShadowing", "boundMcpConfig", "boundMcpDiscovery", "boundCancellationProof"]) assert.equal(Object.hasOwn(announced, key), false, key);
	});
}

test("positive control: removing an unrelated condition keeps the capability", async () => {
	assert.deepEqual(await capabilities({ waitToolEnabled: true, getContext: () => null }), FULL);
});

const sharedUuid = () => "uuid";

/**
 * Tier-1 stand-in for pi-agent-core 0.87: `prompt` declares the loadout delta on
 * a system message and hands the stream function `{ messages }`, like the real
 * `declareToolChanges`. `legacy` hands `{ tools }` instead, like Pi 0.85.
 */
function transcriptModules(variant: "transcript" | "legacy" = "transcript"): BoundTranscriptModules {
	type ProbeTool = { name: string; description: string; parameters: unknown };
	const declaration = (tool: ProbeTool) => JSON.stringify([tool.name, tool.description, tool.parameters]);
	class Agent {
		state: { tools: ProbeTool[] };
		private readonly messages: Array<Record<string, unknown>> = [];
		private declared = new Map<string, ProbeTool>();
		private readonly streamFn: (model: unknown, context: unknown) => unknown;
		constructor(options: { initialState: { tools: ProbeTool[] }; streamFn: (model: unknown, context: unknown) => unknown }) {
			this.state = { tools: [...options.initialState.tools] };
			this.streamFn = options.streamFn;
		}
		async prompt(text: string) {
			const next = new Map(this.state.tools.map((tool) => [tool.name, { name: tool.name, description: tool.description, parameters: tool.parameters }]));
			const toolsRemoved = [...this.declared.values()].filter((tool) => !next.has(tool.name) || declaration(next.get(tool.name)!) !== declaration(tool));
			const toolsAdded = [...next.values()].filter((tool) => !this.declared.has(tool.name) || declaration(this.declared.get(tool.name)!) !== declaration(tool));
			this.declared = next;
			this.messages.push({ role: "system", content: "", ...(toolsAdded.length ? { toolsAdded } : {}), ...(toolsRemoved.length ? { toolsRemoved } : {}), timestamp: 0 });
			this.messages.push({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
			try { this.streamFn({}, variant === "legacy" ? { tools: [...next.values()] } : { messages: [...this.messages] }); }
			catch { this.messages.push({ role: "assistant", content: [], stopReason: "error", timestamp: 0 }); }
		}
	}
	return { ai: { getCurrentTools: TEST_TRANSCRIPT_API.getCurrentTools, uuidv7: sharedUuid }, core: { Agent, uuidv7: sharedUuid } };
}

type SelfCheckGap = "agent" | "streamFunction" | "loaded" | "getActiveToolNames" | "foreignAgent";

/** Tier-1 module for the self-check itself: one member can be removed at a time. */
function selfCheckModule(modules: BoundTranscriptModules, missing?: SelfCheckGap): { pi: PiCodingAgentModule; disposed: () => number } {
	let disposed = 0;
	const RuntimeAgent = (modules.core as { Agent: new (options: unknown) => Record<string, unknown> }).Agent;
	const sessionAgent = () => {
		if (missing === "foreignAgent") return { streamFunction: () => ({}) };
		const agent = new RuntimeAgent({ initialState: { tools: [] }, streamFn: () => ({}) });
		if (missing !== "streamFunction") agent.streamFunction = () => ({});
		return agent;
	};
	const pi = {
		ModelRuntime: { create: async () => ({}) },
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: missing === "loaded" ? class {} : class { loaded = false; },
		SessionManager: { inMemory: () => ({}) },
		createAgentSession: async () => ({
			session: {
				...(missing === "agent" ? {} : { agent: sessionAgent() }),
				...(missing === "getActiveToolNames" ? {} : { getActiveToolNames: () => ["read"] }),
				dispose() { disposed += 1; },
			},
		}),
	};
	return { pi: pi as unknown as PiCodingAgentModule, disposed: () => disposed };
}

test("the self-check reads every Pi field, probes the transcript, and disposes its session", async () => {
	const modules = transcriptModules();
	const full = selfCheckModule(modules);
	assert.deepEqual(await runBoundSelfCheck({ loadPiCodingAgent: async () => full.pi, loadTranscriptModules: async () => modules }), PASSED);
	assert.equal(full.disposed(), 1);
	assert.equal(verifiedBoundTranscriptApi()?.getCurrentTools, TEST_TRANSCRIPT_API.getCurrentTools, "a passed check records the verified API");
	const expectations: Array<[SelfCheckGap, Array<keyof BoundSelfCheckResult>]> = [
		["agent", ["agent", "streamFunction", "transcriptApi", "transcriptContext"]],
		["streamFunction", ["streamFunction"]],
		["loaded", ["loaded"]],
		["getActiveToolNames", ["getActiveToolNames"]],
		// The session runs another agent-core than the one the barrier would read with.
		["foreignAgent", ["transcriptApi", "transcriptContext"]],
	];
	for (const [missing, failed] of expectations) {
		const module = selfCheckModule(modules, missing);
		const result = await runBoundSelfCheck({ loadPiCodingAgent: async () => module.pi, loadTranscriptModules: async () => modules });
		assert.deepEqual(Object.entries(result).filter(([, value]) => !value).map(([key]) => key).sort(), [...failed].sort(), missing);
		assert.equal(verifiedBoundTranscriptApi(), undefined, `${missing}: a failed check leaves no verified API`);
	}
});

test("the self-check refuses a pre-0.87 stream context and a pi-ai copy the agent loop does not use", async () => {
	const legacy = transcriptModules("legacy");
	const legacyModule = selfCheckModule(legacy);
	const legacyResult = await runBoundSelfCheck({ loadPiCodingAgent: async () => legacyModule.pi, loadTranscriptModules: async () => legacy });
	assert.deepEqual([legacyResult.transcriptApi, legacyResult.transcriptContext], [true, false]);
	const modules = transcriptModules();
	const foreignAi = { ...modules, ai: { ...(modules.ai as object), uuidv7: () => "other copy" } };
	const module = selfCheckModule(modules);
	const foreign = await runBoundSelfCheck({ loadPiCodingAgent: async () => module.pi, loadTranscriptModules: async () => foreignAi });
	assert.deepEqual([foreign.transcriptApi, foreign.transcriptContext], [false, false]);
	assert.equal(verifiedBoundTranscriptApi(), undefined);
});

const sdkRoot = process.env.PI_SUBAGENTS_NATIVE_SDK;
const resolveInSdk = (specifier: string): string => execFileSync(process.execPath, ["--input-type=module", "-e", `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`], { cwd: sdkRoot, encoding: "utf8" }).trim();

test("the self-check passes on the installed Pi without a provider call", { skip: !sdkRoot && "Set PI_SUBAGENTS_NATIVE_SDK to the isolated Pi SDK root" }, async (t) => {
	const pi = await import(resolveInSdk("@earendil-works/pi-coding-agent")) as PiCodingAgentModule & { VERSION?: string };
	// The full upstream unit suite uses 0.85.1 for compaction. P2's native
	// transcript context self-check is specifically a 0.87.1 contract.
	if (pi.VERSION !== "0.87.1") { t.skip("P2 transcript context requires Pi 0.87.1"); return; }
	const sdkModules = async (): Promise<BoundTranscriptModules> => ({
		ai: await import(resolveInSdk("@earendil-works/pi-ai")),
		core: await import(resolveInSdk("@earendil-works/pi-agent-core")),
	});
	// The fork's own dev copy of pi-ai is not the one the SDK's agent loop runs.
	const devCopy = async (): Promise<BoundTranscriptModules> => ({ ai: await import("@earendil-works/pi-ai"), core: (await sdkModules()).core });
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "bound-self-check-agent-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	const previousFetch = globalThis.fetch;
	let fetches = 0;
	globalThis.fetch = (async () => { fetches += 1; throw new Error("no network in the self-check"); }) as typeof fetch;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		assert.deepEqual(await runBoundSelfCheck({ loadPiCodingAgent: async () => pi, loadTranscriptModules: sdkModules, cwd: agentDir }), PASSED);
		assert.ok(verifiedBoundTranscriptApi());
		const foreign = await runBoundSelfCheck({ loadPiCodingAgent: async () => pi, loadTranscriptModules: devCopy, cwd: agentDir });
		assert.deepEqual([foreign.transcriptApi, foreign.transcriptContext], [false, false]);
		assert.equal(verifiedBoundTranscriptApi(), undefined);
		assert.equal(fetches, 0);
	} finally {
		globalThis.fetch = previousFetch;
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});
