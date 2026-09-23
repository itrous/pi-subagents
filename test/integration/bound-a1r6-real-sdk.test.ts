import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createBoundChildSessionFactory } from "../../src/bound/bound-child-factory.ts";
import type { BoundMcpConfigContractV1 } from "../../src/bound/bound-mcp-config.ts";
import { boundPackageFactoriesHook, loadBoundPackageFactories } from "../../src/bound/bound-package-loader.ts";
import { BoundRunRegistryV1 } from "../../src/bound/bound-run-registry.ts";
import type { BoundAuthorizedLaunch } from "../../src/bound/bound-runtime-service.ts";
import { expectedToolRegistryProjection, toolRegistryProjection } from "../../src/bound/bound-tool-registry-projection.ts";
import { boundTranscriptApiOf, toolDeclarationDigest, type BoundTranscriptApi } from "../../src/bound/bound-transcript.ts";
import { computeMcpServerHash } from "../../src/runs/shared/mcp-direct-tool-allowlist.ts";
import { packageTreeDigest } from "../../src/runs/shared/package-tree-evidence.ts";
import type { PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { canonicalSha256 } from "../../src/shared/canonical-json.ts";
import { createBoundFixture, type BoundFixture } from "../fixtures/bound/harness.ts";
import { admitBoundLaunch, contractLaunch } from "../support/bound-launch.ts";

// Tier 2 of subplan A1R.6 on the installed Pi SDK: attested shadowing (sub-stage 3)
// and the attested MCP configuration (sub-stage 4). Never installs anything; the
// provider is a stub `globalThis.fetch`, MCP servers are the local stdio fixture.
const sdkRoot = process.env.PI_SUBAGENTS_NATIVE_SDK;
/** An owner package with `node_modules/pi-mcp-adapter` 2.26.1 installed (read only). */
const mcpOwner = process.env.PI_SUBAGENTS_MCP_OWNER;
const skip = !sdkRoot && "Set PI_SUBAGENTS_NATIVE_SDK to the isolated Pi 0.87.1 SDK root";
const skipMcp = skip || (!mcpOwner && "Set PI_SUBAGENTS_MCP_OWNER to an owner package with pi-mcp-adapter 2.26.1 installed");
const FAUX_URL = "https://synthetic.invalid/v1/chat/completions";
const FAUX_MODELS = [{ provider: "faux", id: "faux-1", fullId: "faux/faux-1", api: "openai-completions", reasoning: false }];
const FIXTURE_MCP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "spikes", "A1R.5", "fixture-mcp.mjs");
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

let fixture: BoundFixture;
let savedFetch: typeof fetch;
const envSnapshot = (): string => JSON.stringify(Object.entries(process.env).sort(([left], [right]) => (left < right ? -1 : 1)));

const resolveInSdk = (specifier: string): string => execFileSync(process.execPath, ["--input-type=module", "-e", `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`], { cwd: sdkRoot, encoding: "utf8" }).trim();

async function loadSdk(): Promise<{ pi: PiCodingAgentModule; transcript: BoundTranscriptApi }> {
	const pi = await import(resolveInSdk("@earendil-works/pi-coding-agent")) as PiCodingAgentModule & { VERSION?: string };
	assert.equal(pi.VERSION, "0.87.1");
	const transcript = boundTranscriptApiOf({ ai: await import(resolveInSdk("@earendil-works/pi-ai")), core: await import(resolveInSdk("@earendil-works/pi-agent-core")) });
	assert.ok(transcript);
	return { pi, transcript };
}

interface FauxRequest { tools?: Array<{ function: { name: string; description?: string } }>; messages?: Array<{ role: string; content?: unknown }> }

function installFauxProvider(script: (request: FauxRequest, index: number) => { delta: unknown; finish: string }): FauxRequest[] {
	const requests: FauxRequest[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		assert.equal(input instanceof Request ? input.url : String(input), FAUX_URL, "no request leaves for the network");
		const body = JSON.parse(String(init?.body)) as FauxRequest;
		const index = requests.push(body) - 1;
		const { delta, finish } = script(body, index);
		const chunk = { id: "faux", object: "chat.completion.chunk", created: 1, model: "faux-1", choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
	}) as typeof fetch;
	return requests;
}

const callThenDone = (tool: string, args: Record<string, unknown>) => (_request: FauxRequest, index: number) => index === 0
	? { delta: { content: "Calling.", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] }, finish: "tool_calls" }
	: { delta: { content: "done" }, finish: "stop" };

function toolResultText(request: FauxRequest | undefined): string {
	const result = request?.messages?.find((message) => message.role === "tool");
	return typeof result?.content === "string" ? result.content : JSON.stringify(result?.content ?? null);
}

function writeAgentDir(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }));
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { faux: { baseUrl: "https://synthetic.invalid/v1", apiKey: "fixture-key", models: [{ id: "faux-1", name: "faux-1", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
	return agentDir;
}

function attestation(ref: string, entry: string, evidenceRoot: string) {
	return { ref, path: entry, contentDigest: sha256(fs.readFileSync(entry)), evidenceRoot, evidenceRootDigest: sha256(evidenceRoot), packageTreeDigest: packageTreeDigest(entry, evidenceRoot, evidenceRoot) };
}

async function runLeaf(sdk: { pi: PiCodingAgentModule; transcript: BoundTranscriptApi }, edit: (launch: BoundAuthorizedLaunch) => BoundAuthorizedLaunch) {
	const context = fixture.context();
	const authorized = edit(await admitBoundLaunch(fixture, { model: "faux/faux-1", thinking: "off" }, {
		getContext: () => ({ ...context, modelRegistry: { getAvailable: () => FAUX_MODELS } }),
	}));
	const registry = new BoundRunRegistryV1();
	const record = registry.open(authorized)!;
	const launch = contractLaunch(fixture, authorized);
	fs.mkdirSync(path.dirname((launch.storage as { sessionFile: string }).sessionFile), { recursive: true });
	const factory = createBoundChildSessionFactory({ runId: record.runId, expectedRunId: record.runId }, {
		registry, loadPiCodingAgent: async () => sdk.pi, transcriptApi: sdk.transcript,
	});
	let child;
	try { child = await factory.create(launch); }
	catch (error) { await factory.dispose(); return { record, refused: error, last: undefined }; }
	try { await child.prompt("Use the tool once, then answer."); }
	finally { await child.dispose(); await factory.dispose(); }
	const last = [...child.messages].reverse().find((message) => (message as { role?: string }).role === "assistant") as { stopReason?: string } | undefined;
	return { record, refused: undefined, last };
}

describe("A1R.6 features on the installed Pi SDK (tier 2)", () => {
	beforeEach(() => { fixture = createBoundFixture(); savedFetch = globalThis.fetch; });
	afterEach(() => { globalThis.fetch = savedFetch; fixture.cleanup(); });

	const WORKSPACE_READ = { name: "read", label: "read (workspace)", description: "Read inside the review workspace.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };

	function shadowOwner(register: boolean): { owner: string; entry: string } {
		const owner = path.join(fs.realpathSync(fixture.tempRoot), "owner");
		fs.mkdirSync(path.join(owner, "agents", "ext"), { recursive: true });
		fs.writeFileSync(path.join(owner, "package.json"), JSON.stringify({ name: "fixture-owner", version: "1.0.0" }));
		const entry = path.join(owner, "agents", "ext", "workspace.ts");
		fs.writeFileSync(entry, register
			? `export default function workspace(pi: any): void {\n\tpi.registerTool({ ...${JSON.stringify(WORKSPACE_READ)}, execute: async () => ({ content: [{ type: "text", text: "WORKSPACE_READ_RESULT" }], details: {} }) });\n}\n`
			: "export default function workspace(): void {}\n");
		return { owner, entry };
	}

	function withShadowing(owner: string, entry: string) {
		const attested = attestation("./ext/workspace.ts", entry, owner);
		return (launch: BoundAuthorizedLaunch): BoundAuthorizedLaunch => ({
			...launch,
			packageAttestations: [attested],
			contract: {
				...launch.contract,
				toolRegistry: {
					...launch.contract.toolRegistry,
					shadowing: { version: 1, tools: ["read"], extension: { ref: attested.ref, owner: { name: "fixture-owner", version: "1.0.0", manifestDigest: "0".repeat(64) }, contentDigest: attested.contentDigest, packageTreeDigest: attested.packageTreeDigest, evidenceRootDigest: attested.evidenceRootDigest } },
				},
			},
		});
	}

	it("an attested replacement of read is what the provider is shown and what executes; the builtin never runs", { skip }, async () => {
		const sdk = await loadSdk();
		writeAgentDir();
		fs.writeFileSync(path.join(fixture.project, "marker.txt"), "BUILTIN_WOULD_READ_THIS");
		const { owner, entry } = shadowOwner(true);
		const before = envSnapshot();
		const requests = installFauxProvider(callThenDone("read", { path: "marker.txt" }));
		const { record, last, refused } = await runLeaf(sdk, withShadowing(owner, entry));
		assert.equal(refused, undefined);
		assert.equal(requests.length, 2);
		assert.deepEqual(requests.map((request) => request.tools?.map((tool) => [tool.function.name, tool.function.description])), [
			[["read", WORKSPACE_READ.description]], [["read", WORKSPACE_READ.description]],
		]);
		assert.match(toolResultText(requests[1]), /WORKSPACE_READ_RESULT/u);
		assert.doesNotMatch(toolResultText(requests[1]), /BUILTIN_WOULD_READ_THIS/u);
		assert.equal(last?.stopReason, "stop");
		assert.equal(record.registry.failure, undefined);
		assert.deepEqual(record.registry.shadowing, { version: 1, tools: ["read"], declarations: { read: toolDeclarationDigest(WORKSPACE_READ) } });
		assert.equal(envSnapshot(), before);
	});

	it("an owner that registers no replacement gets zero requests; the builtin read does not stand in", { skip }, async () => {
		const sdk = await loadSdk();
		writeAgentDir();
		const { owner, entry } = shadowOwner(false);
		const requests = installFauxProvider(callThenDone("read", { path: "marker.txt" }));
		const { record } = await runLeaf(sdk, withShadowing(owner, entry));
		assert.equal(requests.length, 0);
		assert.deepEqual(record.registry.failure, { status: "native_tool_registry_mismatch", toolRegistryError: "shadowing_incomplete" });
	});

	// ---- Attested MCP configuration on the real pi-mcp-adapter 2.26.1 ----

	function mcpStand(tools = ["search"]): { adapterEntry: string; config: Record<string, unknown>; configPath: string; bytes: string; definition: Record<string, unknown> } {
		const owner = fs.realpathSync(mcpOwner!);
		const adapterEntry = path.join(owner, "node_modules", "pi-mcp-adapter", "index.ts");
		assert.equal(JSON.parse(fs.readFileSync(path.join(owner, "node_modules", "pi-mcp-adapter", "package.json"), "utf8")).version, "2.26.1");
		const definition = { command: process.execPath, args: [FIXTURE_MCP, "attested", tools.join(","), "300"] };
		const config = { mcpServers: { fx: definition }, settings: { disableProxyTool: true } };
		const configPath = path.join(fs.realpathSync(fixture.project), ".pi", "mcp.json");
		const bytes = JSON.stringify(config);
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, bytes);
		// A foreign global config with the same server name and another command:
		// the adapter must never read it, discovery must let the project win.
		fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "mcp.json"), JSON.stringify({ mcpServers: { fx: { command: process.execPath, args: [FIXTURE_MCP, "foreign", "search"] } } }));
		return { adapterEntry, config, configPath, bytes, definition };
	}

	function writeMetadataCache(definition: Record<string, unknown>, tools = ["search"]): void {
		fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "mcp-cache.json"), JSON.stringify({
			version: 1, servers: { fx: { configHash: computeMcpServerHash(definition as never), cachedAt: Date.now(), tools: tools.map((name) => ({ name, description: `fixture tool ${name}`, inputSchema: { type: "object", properties: { q: { type: "string" } } } })) } },
		}));
	}

	it("a leaf with an attested configuration, another process cwd and a foreign global config is served only by the attested server", { skip: skipMcp }, async () => {
		const sdk = await loadSdk();
		writeAgentDir();
		const stand = mcpStand();
		writeMetadataCache(stand.definition);
		assert.notEqual(fs.realpathSync(process.cwd()), fs.realpathSync(fixture.project), "the host process cwd differs from the leaf cwd");
		const before = envSnapshot();
		const requests = installFauxProvider(callThenDone("fx_search", { q: "x" }));
		const contract: BoundMcpConfigContractV1 = {
			version: 1, extension: "package:pi-mcp-adapter", sourcePathDigest: canonicalSha256(stand.configPath),
			contentDigest: sha256(stand.bytes), effectiveDigest: canonicalSha256(stand.config), servers: ["fx"],
		};
		const { record, last, refused } = await runLeaf(sdk, (launch) => {
			const required = ["fx_search", "read"];
			return {
				...launch,
				request: { ...launch.request, mcpConfig: { version: 1, path: stand.configPath } },
				packageAttestations: [attestation("package:pi-mcp-adapter", stand.adapterEntry, fs.realpathSync(mcpOwner!))],
				agent: { ...launch.agent, mcpDirectTools: ["fx/search"], definitionDigest: launch.contract.agent.definitionDigest } as BoundAuthorizedLaunch["agent"],
				contract: {
					...launch.contract, mcpConfig: contract, mcpDirectTools: ["fx_search"],
					tools: { ...launch.contract.tools, effectiveAllowlist: required },
					toolRegistry: { ...launch.contract.toolRegistry, projection: expectedToolRegistryProjection(required, [])! },
				},
			};
		});
		assert.equal(refused, undefined, String(refused));
		assert.equal(record.registry.failure, undefined);
		assert.equal(requests.length, 2);
		assert.deepEqual(requests[0]!.tools!.map((tool) => tool.function.name).sort(), ["fx_search", "read"]);
		assert.match(toolResultText(requests[1]), /fixture:attested:search/u);
		assert.doesNotMatch(toolResultText(requests[1]), /foreign/u);
		assert.equal(last?.stopReason, "stop");
		assert.equal(envSnapshot(), before);
	});

	/** The adapter as the bound loader builds it, in a real session whose cwd is not the process cwd. */
	async function adapterSession(sdk: { pi: PiCodingAgentModule }, stand: ReturnType<typeof mcpStand>, attested = true, tools = ["search"]): Promise<{ complete: boolean; names: string[] }> {
		const loaded = await loadBoundPackageFactories([attestation("package:pi-mcp-adapter", stand.adapterEntry, fs.realpathSync(mcpOwner!))], attested ? { mcpConfig: { ref: "package:pi-mcp-adapter", config: stand.config } } : {});
		assert.ok(loaded.ok, JSON.stringify(loaded));
		if (!loaded.ok) throw new Error("unreachable");
		const hook = boundPackageFactoriesHook(loaded.factories, { runtimeBuiltins: ["read"], internalTools: [], barrierCommitted: () => false, onViolation: () => {}, onFactoryError: () => {} });
		const { pi } = sdk;
		const cwd = fs.realpathSync(fixture.project);
		const agentDir = process.env.PI_CODING_AGENT_DIR!;
		const settingsManager = pi.SettingsManager.create(cwd, agentDir);
		const loader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [hook.factory as never] } as never);
		const modelRuntime = await pi.ModelRuntime.create();
		process.env.MCP_DIRECT_TOOLS = tools.map((name) => `fx/${name}`).join(",");
		let session;
		try {
			await loader.reload();
			({ session } = await pi.createAgentSession({ cwd, agentDir, modelRuntime, resourceLoader: loader, settingsManager, sessionManager: pi.SessionManager.inMemory(cwd), sessionStartEvent: { type: "session_start", reason: "startup" } } as never));
			await session.bindExtensions({ mode: "print" } as never);
		} finally { delete process.env.MCP_DIRECT_TOOLS; }
		const names = session.getActiveToolNames().filter((name: string) => name.startsWith("fx_"));
		const runner = (session as unknown as { extensionRunner: { hasHandlers(event: string): boolean; emit(event: unknown): Promise<unknown> } }).extensionRunner;
		if (runner.hasHandlers("session_shutdown")) await Promise.race([runner.emit({ type: "session_shutdown", reason: "quit" }), new Promise((resolve) => setTimeout(resolve, 5000))]);
		session.dispose();
		return { complete: names.length === tools.length && tools.every((name) => names.includes(`fx_${name}`)), names };
	}

	it("cold and warm metadata cache give the same complete set at the end of create(), with another process cwd", { skip: skipMcp }, async () => {
		const sdk = await loadSdk();
		writeAgentDir();
		const stand = mcpStand();
		const cache = path.join(process.env.PI_CODING_AGENT_DIR!, "mcp-cache.json");
		assert.equal(fs.existsSync(cache), false, "cold: no metadata cache");
		const cold = await adapterSession(sdk, stand);
		assert.equal(fs.existsSync(cache), true, "the cold run filled the cache");
		const warm = await adapterSession(sdk, stand);
		assert.deepEqual([cold, warm], [{ complete: true, names: ["fx_search"] }, { complete: true, names: ["fx_search"] }]);
	});

	it("cold and warm cache expose exactly ten attested MCP tools, never an ambient server's tools", { skip: skipMcp }, async () => {
		const sdk = await loadSdk();
		writeAgentDir();
		const tools = Array.from({ length: 10 }, (_, index) => `tool${index}`);
		const names = tools.map((tool) => `fx_${tool}`);
		const stand = mcpStand(tools);
		const cache = path.join(process.env.PI_CODING_AGENT_DIR!, "mcp-cache.json");
		assert.equal(fs.existsSync(cache), false);
		const before = envSnapshot();
		const cold = await adapterSession(sdk, stand, true, tools);
		assert.equal(fs.existsSync(cache), true);
		const warm = await adapterSession(sdk, stand, true, tools);
		assert.deepEqual([cold, warm], [{ complete: true, names }, { complete: true, names }]);
		assert.equal(envSnapshot(), before);
		// Dropping one selector yields nine, not an implicit built-in or fallback.
		const nine = await adapterSession(sdk, stand, true, tools.slice(0, 9));
		assert.deepEqual(nine, { complete: true, names: names.slice(0, 9) });
		const expected = expectedToolRegistryProjection(["read", ...names], [])!;
		const observed = toolRegistryProjection({ required: expected.required, actual: ["read", ...nine.names], internalExpected: [] })!;
		assert.deepEqual(observed.missing, [names[9]], "one missing MCP tool refuses the exact-ten registry contract");
		assert.notEqual(observed.digest, expected.digest);
	});

	it("positive control: the adapter's default export on a cold cache, with another process cwd, is incomplete at the end of create()", { skip: skipMcp }, async () => {
		const sdk = await loadSdk();
		writeAgentDir();
		const stand = mcpStand();
		// Without the foreign global config the early config, read from process.cwd(), is empty (fact P1, outcome B).
		fs.rmSync(path.join(process.env.PI_CODING_AGENT_DIR!, "mcp.json"));
		const cold = await adapterSession(sdk, stand, false);
		assert.deepEqual(cold, { complete: false, names: [] });
	});
});
