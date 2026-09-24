import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createBoundChildSessionFactory } from "../../src/bound/bound-child-factory.ts";
import { createBoundExecutionPort, type BoundExecuteDelegated } from "../../src/bound/bound-execution-port.ts";
import { clearBoundDiscoveryCaches } from "../../src/bound/bound-agent-discovery.ts";
import { boundLayerManifest } from "../../src/bound/bound-layer-manifest.ts";
import { BoundMcpPreparationRegistry } from "../../src/bound/bound-mcp-preparation.ts";
import { boundRunIdOf, BoundRunRegistryV1 } from "../../src/bound/bound-run-registry.ts";
import { createBoundRuntimeService, type BoundAuthorizedLaunch, type BoundRuntimeService, type BoundRuntimeServiceOptions } from "../../src/bound/bound-runtime-service.ts";
import { boundTranscriptApiOf, type BoundTranscriptApi } from "../../src/bound/bound-transcript.ts";
import { clearAgentDiscoveryCache } from "../../src/agents/agents.ts";
import type { ChildSession, PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { createBoundFixture, type BoundFixture } from "../fixtures/bound/harness.ts";
import { boundBindingOf, contractLaunch } from "../support/bound-launch.ts";

// S3 P2 on the installed Pi 0.87.1 SDK and the real pi-mcp-adapter 2.26.1:
// cold MCP discovery through the bound-direct bridge, and the cancellation
// proof of an admitted run. The owner package is a reflink copy on a real
// disk (never /tmp, a RAM disk here); the provider is a stub `fetch`.
const sdkRoot = process.env.PI_SUBAGENTS_NATIVE_SDK;
const mcpOwner = process.env.PI_SUBAGENTS_MCP_OWNER;
const diskTmp = process.env.PI_SUBAGENTS_DISK_TMP;
const skip = (!sdkRoot || !mcpOwner || !diskTmp) && "Set PI_SUBAGENTS_NATIVE_SDK, PI_SUBAGENTS_MCP_OWNER and PI_SUBAGENTS_DISK_TMP";
const FAUX_URL = "https://synthetic.invalid/v1/chat/completions";
const FAUX_MODELS = [{ provider: "faux", id: "faux-1", fullId: "faux/faux-1", api: "openai-completions", reasoning: false }];
const FIXTURE_MCP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "spikes", "A1R.5", "fixture-mcp.mjs");
const WS_TOOLS = ["search", "symbol_info", "graph", "metadata", "diagnostics", "query", "event_log", "execute", "debug", "outline"];
const REF_TOOLS = ["syntax_help", "search", "its_help"];
const SELECTORS = [
	"bsl-ws/search", "bsl-ws/symbol_info", "bsl-ws/graph", "bsl-ws/metadata", "bsl-ws/diagnostics", "bsl-ws/query", "bsl-ws/event_log",
	"bsl-ref/syntax_help", "bsl-ref/search", "bsl-ref/its_help",
];
const SAFETY = { version: 1, cancellationProof: 1 };

let fixture: BoundFixture;
let project: string;
let savedFetch: typeof fetch;
let sdk: { pi: PiCodingAgentModule; transcript: BoundTranscriptApi } | undefined;

const resolveInSdk = (specifier: string): string => execFileSync(process.execPath, ["--input-type=module", "-e", `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`], { cwd: sdkRoot, encoding: "utf8" }).trim();

async function loadSdk(): Promise<{ pi: PiCodingAgentModule; transcript: BoundTranscriptApi }> {
	if (sdk) return sdk;
	const pi = await import(resolveInSdk("@earendil-works/pi-coding-agent")) as PiCodingAgentModule & { VERSION?: string };
	assert.equal(pi.VERSION, "0.87.1");
	const transcript = boundTranscriptApiOf({ ai: await import(resolveInSdk("@earendil-works/pi-ai")), core: await import(resolveInSdk("@earendil-works/pi-agent-core")) });
	assert.ok(transcript);
	sdk = { pi, transcript };
	return sdk;
}

interface FauxRequest { tools?: Array<{ function: { name: string } }>; messages?: Array<{ role: string; content?: unknown }> }

function installFauxProvider(script: (request: FauxRequest, index: number, init?: RequestInit) => Promise<{ delta: unknown; finish: string }> | { delta: unknown; finish: string }): FauxRequest[] {
	const requests: FauxRequest[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		assert.equal(input instanceof Request ? input.url : String(input), FAUX_URL);
		const body = JSON.parse(String(init?.body)) as FauxRequest;
		const index = requests.push(body) - 1;
		const { delta, finish } = await script(body, index, init);
		const chunk = { id: "faux", object: "chat.completion.chunk", created: 1, model: "faux-1", choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
	}) as typeof fetch;
	return requests;
}

function toolResultText(request: FauxRequest | undefined): string {
	const result = request?.messages?.find((message) => message.role === "tool");
	return typeof result?.content === "string" ? result.content : JSON.stringify(result?.content ?? null);
}

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf8");
}

function agentDirListing(): string[] {
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	return fs.existsSync(agentDir) ? fs.readdirSync(agentDir, { recursive: true }).map(String).sort() : [];
}

function mcpConfig(wsTools = WS_TOOLS, refTools = REF_TOOLS): Record<string, unknown> {
	return {
		mcpServers: {
			"bsl-ws": { command: process.execPath, args: [FIXTURE_MCP, "bsl-ws", wsTools.join(","), "50"] },
			"bsl-ref": { command: process.execPath, args: [FIXTURE_MCP, "bsl-ref", refTools.join(","), "50"] },
		},
	};
}

function service(overrides: Partial<BoundRuntimeServiceOptions> = {}): BoundRuntimeService {
	const context = fixture.context();
	return createBoundRuntimeService(fixture.serviceOptions({
		getContext: () => ({ ...context, cwd: project, modelRegistry: { getAvailable: () => FAUX_MODELS } }),
		// The real layer manifest: the bridge's runtime entry is part of the evidence.
		layerManifest: () => boundLayerManifest(),
		...overrides,
	}) as unknown as BoundRuntimeServiceOptions);
}

function baseRequest(prospectiveRunId = randomUUID()): Record<string, unknown> {
	return {
		...fixture.request({ prospectiveRunId }),
		agent: "lens-1c", cwd: project, model: "faux/faux-1", thinking: "off",
		task: "Use one MCP tool, then answer.",
		safety: SAFETY,
	};
}

const configPath = (): string => path.join(project, ".pi", "mcp.json");

/** The launch upstream builds for this package agent: its raw `package:` ref is still in the path list. */
function leafLaunch(launch: BoundAuthorizedLaunch) {
	return { ...contractLaunch(fixture, launch), extensionPaths: launch.contract.packageExtensions.map((entry) => entry.ref) };
}

async function prepare(svc: BoundRuntimeService, request: Record<string, unknown>) {
	return svc.prepareMcp({ version: 1, targetServerInstanceId: request.targetServerInstanceId, request: { ...request, mcpConfig: { version: 2, path: configPath(), implementation: "bound-direct/v1" } } });
}

function finalRequest(request: Record<string, unknown>, data: { ticket: string; snapshotDigest: string }): Record<string, unknown> {
	return { ...request, mcpConfig: { version: 2, path: configPath(), implementation: "bound-direct/v1", ticket: data.ticket, snapshotDigest: data.snapshotDigest } };
}

async function admit(svc: BoundRuntimeService): Promise<{ launch: BoundAuthorizedLaunch; request: Record<string, unknown>; ticket: string }> {
	const request = baseRequest();
	const prepared = await prepare(svc, request);
	assert.ok(prepared?.ok, `prepare failed: ${prepared && !prepared.ok ? prepared.error.code : "silent"}`);
	const final = finalRequest(request, prepared.data);
	const preflight = await svc.preflight(final);
	assert.ok(preflight?.ok, `preflight failed: ${preflight && !preflight.ok ? preflight.error.code : "silent"}`);
	const admitted = await svc.admit(final, boundBindingOf(preflight.data));
	assert.ok(admitted.ok, `admit failed: ${!admitted.ok ? admitted.code : ""}`);
	return { launch: admitted.launch, request: final, ticket: prepared.data.ticket };
}

describe("S3 P2 producer on the installed Pi SDK and pi-mcp-adapter 2.26.1 (tier 2)", () => {
	beforeEach(() => {
		fixture = createBoundFixture();
		savedFetch = globalThis.fetch;
		if (skip) return;
		fs.mkdirSync(diskTmp!, { recursive: true });
		project = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(diskTmp!), "s3p2-owner-")));
		execFileSync("cp", ["-a", "--reflink=auto", path.join(fs.realpathSync(mcpOwner!), "node_modules"), path.join(project, "node_modules")]);
		write(path.join(project, "package.json"), JSON.stringify({ name: "s3p2-owner", version: "1.0.0", type: "module", pi: { subagents: { agents: ["./agents"] } }, dependencies: { "pi-mcp-adapter": "2.26.1" } }));
		write(path.join(project, "agents", "lens-1c.md"), [
			"---", "name: lens-1c", "description: S3 P2 1C lens.", "defaultContext: fresh", "systemPromptMode: replace",
			"inheritProjectContext: false", "inheritSkills: false",
			`tools: read, ${SELECTORS.map((selector) => `mcp:${selector}`).join(", ")}`,
			"subagentOnlyExtensions: package:pi-mcp-adapter", "---", "", "Answer the task.", "",
		].join("\n"));
		write(configPath(), JSON.stringify(mcpConfig()));
		const agentDir = process.env.PI_CODING_AGENT_DIR!;
		write(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }));
		write(path.join(agentDir, "models.json"), JSON.stringify({ providers: { faux: { baseUrl: "https://synthetic.invalid/v1", apiKey: "fixture-key", models: [{ id: "faux-1", name: "faux-1", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
		clearAgentDiscoveryCache();
		clearBoundDiscoveryCaches();
	});
	afterEach(() => {
		globalThis.fetch = savedFetch;
		fixture.cleanup();
		if (project) fs.rmSync(project, { recursive: true, force: true });
	});

	it("cold cache: prepare discovers exactly the ten selected tools, preflight is side-effect free, the ticket moves into one run", { skip, timeout: 60_000 }, async () => {
		const svc = service();
		try {
			assert.equal(fs.existsSync(path.join(process.env.PI_CODING_AGENT_DIR!, "mcp-cache.json")), false, "cold");
			const before = agentDirListing();
			const request = baseRequest();
			const prepared = await prepare(svc, request);
			assert.ok(prepared?.ok, prepared && !prepared.ok ? prepared.error.code : "silent");
			const names = prepared.data.snapshot.declarations.map((declaration) => declaration.name);
			assert.deepEqual([...names].sort(), [
				"bsl-ws_search", "bsl-ws_symbol_info", "bsl-ws_graph", "bsl-ws_metadata", "bsl-ws_diagnostics", "bsl-ws_query", "bsl-ws_event_log",
				"bsl-ref_syntax_help", "bsl-ref_search", "bsl-ref_its_help",
			].sort(), "the independent expected exact-ten, never a partial grant or advertised execute/debug");
			assert.deepEqual(agentDirListing(), before, "no metadata cache was written");
			const final = finalRequest(request, prepared.data);
			const first = await svc.preflight(final);
			const second = await svc.preflight(final);
			assert.ok(first?.ok && second?.ok);
			assert.equal(first.data.launchContractDigest, second.data.launchContractDigest);
			const contract = first.data.launchContract;
			assert.equal(contract.mcpConfig?.version, 2);
			assert.equal((contract.mcpConfig as { snapshotDigest: string }).snapshotDigest, prepared.data.snapshotDigest);
			assert.deepEqual(contract.safety, SAFETY);
			assert.deepEqual(contract.cancellationPolicy, { version: 1, hardTimerMs: 3000, shutdownTimeoutMs: 2000, deliveryGraceMs: 1000 });
			assert.deepEqual([...contract.mcpDirectTools].sort(), [...names].sort());
			const admitted = await svc.admit(final, boundBindingOf(first.data));
			assert.ok(admitted.ok);
			assert.equal(svc.claimMcp(admitted.launch), true, "ownership moves once");
			assert.equal(svc.claimMcp(admitted.launch), false, "and never twice");
			const release = await svc.releaseMcp({ version: 1, targetServerInstanceId: final.targetServerInstanceId, activeSessionDigest: first.data.activeSessionDigest, requestId: final.requestId, ownerRunId: final.ownerRunId, nodeId: final.nodeId, ticket: prepared.data.ticket });
			assert.deepEqual(release, { ok: true, data: { version: 1, status: "admitted" } });
			assert.equal(await admitted.launch.mcp!.close(), "closed");
		} finally { svc.dispose(); }
	});

	it("a bridged leaf calls the right MCP server; the provider sees exactly read plus the ten names", { skip, timeout: 60_000 }, async () => {
		const { pi, transcript } = await loadSdk();
		const svc = service();
		try {
			const { launch } = await admit(svc);
			assert.ok(svc.claimMcp(launch));
			const requests = installFauxProvider((_request, index) => index === 0
				? { delta: { content: "Calling.", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "bsl-ws_search", arguments: JSON.stringify({ q: "x" }) } }] }, finish: "tool_calls" }
				: { delta: { content: "done" }, finish: "stop" });
			const registry = new BoundRunRegistryV1();
			const record = registry.open(launch)!;
			const childLaunch = leafLaunch(launch);
			fs.mkdirSync(path.dirname((childLaunch.storage as { sessionFile: string }).sessionFile), { recursive: true });
			const factory = createBoundChildSessionFactory({ runId: record.runId, expectedRunId: record.runId }, { registry, loadPiCodingAgent: async () => pi, transcriptApi: transcript });
			const child = await factory.create(childLaunch);
			try { await child.prompt("Use the tool once, then answer."); }
			finally { await child.dispose(); await factory.dispose(); await launch.mcp!.close(); }
			assert.equal(record.registry.failure, undefined);
			assert.equal(requests.length, 2);
			assert.deepEqual(requests[0]!.tools!.map((tool) => tool.function.name).sort(), ["read", ...launch.contract.mcpDirectTools].sort());
			assert.match(toolResultText(requests[1]), /fixture:bsl-ws:search/u);
		} finally { svc.dispose(); }
	});

	it("an unresolved selector, a released ticket, an expired ticket and a drifted config refuse before any provider call", { skip, timeout: 60_000 }, async () => {
		const svc = service({ mcpPreparations: new BoundMcpPreparationRegistry({ ttlMs: 30_000 }) });
		try {
			// One selected tool missing on its server: no partial grant of nine.
			write(configPath(), JSON.stringify(mcpConfig(WS_TOOLS, ["syntax_help", "search"])));
			const missing = await prepare(svc, baseRequest());
			assert.deepEqual(missing, { ok: false, error: { version: 2, code: "mcp_selector_unresolved" } });
			write(configPath(), JSON.stringify(mcpConfig()));
			// Release wins before admission.
			const request = baseRequest();
			const prepared = await prepare(svc, request);
			assert.ok(prepared?.ok);
			const final = finalRequest(request, prepared.data);
			const preflight = await svc.preflight(final);
			assert.ok(preflight?.ok);
			const releaseParams = { version: 1 as const, targetServerInstanceId: final.targetServerInstanceId, activeSessionDigest: preflight.data.activeSessionDigest, requestId: final.requestId, ownerRunId: final.ownerRunId, nodeId: final.nodeId, ticket: prepared.data.ticket };
			assert.deepEqual(await svc.releaseMcp({ ...releaseParams, ownerRunId: randomUUID() }), { ok: false, error: { version: 2, code: "invalid_request" } }, "foreign tuple cannot release the owner's live ticket");
			const released = await svc.releaseMcp(releaseParams);
			assert.deepEqual(released, { ok: true, data: { version: 1, status: "released" } });
			const late = await svc.admit(final, boundBindingOf(preflight.data));
			assert.deepEqual(late, { ok: false, code: "mcp_ticket_invalid" });
			// Config bytes changed after discovery.
			const request2 = baseRequest();
			const prepared2 = await prepare(svc, request2);
			assert.ok(prepared2?.ok);
			write(configPath(), `${JSON.stringify(mcpConfig())}\n`);
			assert.deepEqual(await svc.preflight(finalRequest(request2, prepared2.data)), { ok: false, error: { version: 2, code: "mcp_snapshot_drift" } });
		} finally { svc.dispose(); }
		const expiring = service({ mcpPreparations: new BoundMcpPreparationRegistry({ ttlMs: 1 }) });
		try {
			const request = baseRequest();
			const prepared = await prepare(expiring, request);
			assert.ok(prepared?.ok);
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.deepEqual(await expiring.preflight(finalRequest(request, prepared.data)), { ok: false, error: { version: 2, code: "mcp_ticket_invalid" } });
		} finally { expiring.dispose(); }
	});

	for (const mode of ["cooperative", "ignoring"] as const) {
		it(`an admitted ${mode} run cancelled after its first provider request gets a confirming proof, no result`, { skip, timeout: 60_000 }, async () => {
			const { pi, transcript } = await loadSdk();
			const svc = service();
			try {
				const { launch } = await admit(svc);
				assert.ok(svc.claimMcp(launch));
				let firstRequest!: () => void;
				const reached = new Promise<void>((resolve) => { firstRequest = resolve; });
				const requests = installFauxProvider(async (_request, _index, init) => {
					firstRequest();
					// The provider never answers; only an abort ends the request.
					await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
					return { delta: {}, finish: "stop" };
				});
				const registry = new BoundRunRegistryV1();
				let child: ChildSession | undefined;
				const executeDelegated: BoundExecuteDelegated = async (_id, params, signal) => {
					const runId = boundRunIdOf(params)!;
					const childLaunch = leafLaunch(launch);
					fs.mkdirSync(path.dirname((childLaunch.storage as { sessionFile: string }).sessionFile), { recursive: true });
					child = await createBoundChildSessionFactory({ runId, expectedRunId: runId }, { registry, loadPiCodingAgent: async () => pi, transcriptApi: transcript }).create(childLaunch);
					if (mode === "cooperative") signal.addEventListener("abort", () => { void child!.abort(); }, { once: true });
					const prompting = child.prompt("Use a tool.").catch(() => {});
					if (mode === "ignoring") await new Promise(() => {});
					await prompting;
					return { content: [], details: { mode: "single", results: [] } } as never;
				};
				const port = createBoundExecutionPort({ executeDelegated, getContext: () => fixture.context() as never, config: fixture.config, registry });
				const controller = new AbortController();
				const started = performance.now();
				const outcome = port.run({ launch, signal: controller.signal, onUpdate: () => {}, commit: () => !controller.signal.aborted });
				await reached;
				controller.abort();
				const terminal = await outcome as Record<string, unknown>;
				const elapsed = performance.now() - started;
				assert.equal(terminal.status, "cancelled");
				assert.equal(terminal.result, undefined);
				assert.equal(terminal.transportIncomplete, undefined, JSON.stringify(terminal));
				const proof = terminal.cancellationProof as Record<string, unknown>;
				assert.equal(proof.phase, "admitted");
				assert.equal(proof.session, "disposed");
				assert.equal(proof.revoked, true);
				assert.equal(proof.collectorsSealed, true);
				assert.equal(proof.execution, mode === "ignoring" ? "unsettled" : "settled");
				assert.ok(["completed", "deadline"].includes(proof.shutdown as string));
				assert.ok(terminal.toolRegistry, "the measured registry survives the cancel");
				assert.deepEqual(terminal.deniedToolCalls, []);
				assert.equal(terminal.launchContractDigest, launch.contract.digest);
				assert.equal(requests.length, 1);
				assert.ok(elapsed < 6_000, `bounded: ${elapsed} ms`);
			} finally { svc.dispose(); }
		});
	}
});
