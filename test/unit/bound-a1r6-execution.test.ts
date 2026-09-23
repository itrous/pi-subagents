import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { BOUND_CHILD_REFUSED_TEXT, createBoundChildSessionFactory, type BoundChildSessionFactoryOptions } from "../../src/bound/bound-child-factory.ts";
import { projectBoundTerminal } from "../../src/bound/bound-execution-port.ts";
import type { BoundMcpConfigContractV1 } from "../../src/bound/bound-mcp-config.ts";
import { BoundRunRegistryV1 } from "../../src/bound/bound-run-registry.ts";
import type { BoundAuthorizedLaunch } from "../../src/bound/bound-runtime-service.ts";
import { expectedToolRegistryProjection } from "../../src/bound/bound-tool-registry-projection.ts";
import type { BoundToolShadowingContractV1 } from "../../src/bound/bound-tool-shadowing.ts";
import { toolDeclarationDigest } from "../../src/bound/bound-transcript.ts";
import { computeMcpServerHash } from "../../src/runs/shared/mcp-direct-tool-allowlist.ts";
import { packageTreeDigest } from "../../src/runs/shared/package-tree-evidence.ts";
import type { PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { canonicalSha256 } from "../../src/shared/canonical-json.ts";
import { createBoundFixture, type BoundFixture } from "../fixtures/bound/harness.ts";
import { admitBoundLaunch, contractLaunch } from "../support/bound-launch.ts";
import { fakePi } from "../support/bound-fake-pi.ts";
import { TEST_TRANSCRIPT_API } from "../support/bound-transcript.ts";

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const ENV = "MCP_DIRECT_TOOLS";

let fixture: BoundFixture;
let owner: string;
let savedEnv: string | undefined;

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf8");
}

const WORKSPACE_READ = { name: "read", label: "read (workspace)", description: "Read inside the review workspace.", parameters: { type: "object", properties: { path: { type: "string" } } } };

/** An owner package with the extensions a leaf may load: the attested owner of the replacement, a foreign one, and variants. */
beforeEach(() => {
	fixture = createBoundFixture();
	savedEnv = process.env[ENV];
	owner = path.join(fs.realpathSync(fixture.tempRoot), "owner");
	write(path.join(owner, "package.json"), JSON.stringify({ name: "fixture-owner", version: "1.0.0", dependencies: { "pi-mcp-adapter": "2.26.1" } }));
	const register = (tools: object[]) => `export default function factory(pi: any): void {\n${tools.map((tool) => `\tpi.registerTool({ ...${JSON.stringify(tool)}, execute: async () => ({ content: [{ type: "text", text: "workspace" }], details: {} }) });`).join("\n")}\n}\n`;
	write(path.join(owner, "agents", "ext", "workspace.ts"), register([WORKSPACE_READ]));
	write(path.join(owner, "agents", "ext", "empty.ts"), register([]));
	write(path.join(owner, "agents", "ext", "twice.ts"), register([WORKSPACE_READ, WORKSPACE_READ]));
	write(path.join(owner, "agents", "ext", "foreign.ts"), register([{ ...WORKSPACE_READ, description: "Foreign read." }]));
	const adapter = path.join(owner, "node_modules", "pi-mcp-adapter");
	write(path.join(adapter, "package.json"), JSON.stringify({ name: "pi-mcp-adapter", version: "2.26.1", type: "module", main: "./index.ts" }));
	// Stand-in adapter: the programmatic factory registers one tool per configured server; the default export registers none.
	write(path.join(adapter, "index.ts"), [
		"export function createMcpAdapter(options: any = {}) {",
		"\treturn function adapter(pi: any): void {",
		"\t\t(globalThis as any).__boundMcpConfigSeen = options.config;",
		"\t\tfor (const server of Object.keys(options.config?.mcpServers ?? {})) pi.registerTool({ name: `${server}_search`, label: server, description: `${server} search`, parameters: {}, execute: async () => ({ content: [], details: {} }) });",
		"\t};",
		"}",
		"export default createMcpAdapter();",
		"",
	].join("\n"));
	delete (globalThis as Record<string, unknown>).__boundMcpConfigSeen;
});
afterEach(() => {
	if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv;
	fixture.cleanup();
});

function attest(ref: string, entry: string) {
	return { ref, path: entry, contentDigest: sha256(fs.readFileSync(entry)), evidenceRoot: owner, evidenceRootDigest: sha256(owner), packageTreeDigest: packageTreeDigest(entry, owner, owner) };
}

function shadowingOf(attestation: ReturnType<typeof attest>, tools = ["read"]): BoundToolShadowingContractV1 {
	return {
		version: 1, tools,
		extension: { ref: attestation.ref, owner: { name: "fixture-owner", version: "1.0.0", manifestDigest: "0".repeat(64) }, contentDigest: attestation.contentDigest, packageTreeDigest: attestation.packageTreeDigest, evidenceRootDigest: attestation.evidenceRootDigest },
	};
}

async function setup(edit: (launch: BoundAuthorizedLaunch) => BoundAuthorizedLaunch) {
	const registry = new BoundRunRegistryV1();
	const authorized = edit(await admitBoundLaunch(fixture));
	const record = registry.open(authorized)!;
	const launch = contractLaunch(fixture, authorized);
	fs.mkdirSync(fixture.sessionDir, { recursive: true });
	return { registry, record, launch };
}

function factoryFor(registry: BoundRunRegistryV1, runId: string, pi: PiCodingAgentModule, extra: Partial<BoundChildSessionFactoryOptions> = {}) {
	return createBoundChildSessionFactory({ runId, expectedRunId: runId }, { registry, loadPiCodingAgent: async () => pi, processCwd: () => fixture.project, transcriptApi: TEST_TRANSCRIPT_API, ...extra });
}

function withShadowing(ownerRef: string, attestations: Array<ReturnType<typeof attest>>, tools = ["read"]) {
	return (launch: BoundAuthorizedLaunch): BoundAuthorizedLaunch => ({
		...launch,
		packageAttestations: attestations,
		contract: { ...launch.contract, toolRegistry: { ...launch.contract.toolRegistry, shadowing: shadowingOf(attestations.find((entry) => entry.ref === ownerRef)!, tools) } },
	});
}

const ext = (name: string) => path.join(owner, "agents", "ext", `${name}.ts`);

test("the attested owner's replacement of read reaches the provider with its own declaration and leaves evidence", async () => {
	const { registry, record, launch } = await setup(withShadowing("./ext/workspace.ts", [attest("./ext/workspace.ts", ext("workspace"))]));
	const { pi, probe } = fakePi();
	const child = await factoryFor(registry, record.runId, pi).create(launch);
	await child.prompt("go");
	assert.equal(probe.requests, 1);
	assert.equal(record.registry.failure, undefined);
	assert.deepEqual(record.registry.shadowing, { version: 1, tools: ["read"], declarations: { read: toolDeclarationDigest(WORKSPACE_READ) } });
});

for (const [label, ownerRef, attestations, options, code] of [
	["an owner that registers no replacement", "./ext/empty.ts", () => [attest("./ext/empty.ts", ext("empty"))], {}, { status: "native_tool_registry_mismatch", toolRegistryError: "shadowing_incomplete" }],
	["an owner that registers read twice", "./ext/twice.ts", () => [attest("./ext/twice.ts", ext("twice"))], {}, { status: "native_tool_registry_mismatch", toolRegistryError: "package_mutation" }],
	["another extension taking read before the owner", "./ext/workspace.ts", () => [attest("./ext/foreign.ts", ext("foreign")), attest("./ext/workspace.ts", ext("workspace"))], {}, { status: "native_tool_registry_mismatch", toolRegistryError: "package_mutation" }],
	["a session whose active read is still the builtin", "./ext/workspace.ts", () => [attest("./ext/workspace.ts", ext("workspace"))], { builtinWins: ["read"] }, { status: "native_tool_registry_mismatch", toolRegistryError: "shadowing_mismatch" }],
] as const) {
	test(`${label} gets zero requests and no builtin in its place`, async () => {
		const { registry, record, launch } = await setup(withShadowing(ownerRef, attestations()));
		const { pi, probe } = fakePi(options);
		const child = await factoryFor(registry, record.runId, pi).create(launch);
		await child.prompt("go");
		assert.equal(probe.requests, 0);
		assert.deepEqual(record.registry.failure, code);
	});
}

test("owner bytes that differ from the contract refuse the launch before any session", async () => {
	const attestation = attest("./ext/workspace.ts", ext("workspace"));
	const { registry, record, launch } = await setup((authorized) => ({
		...withShadowing("./ext/workspace.ts", [attestation])(authorized),
		contract: { ...authorized.contract, toolRegistry: { ...authorized.contract.toolRegistry, shadowing: { ...shadowingOf(attestation), extension: { ...shadowingOf(attestation).extension, contentDigest: "f".repeat(64) } } } },
	}));
	const { pi, probe } = fakePi();
	await assert.rejects(factoryFor(registry, record.runId, pi).create(launch), { message: BOUND_CHILD_REFUSED_TEXT });
	assert.equal(probe.sessions, 0);
	assert.deepEqual(record.registry.failure, { status: "unavailable_context", toolRegistryError: "launch_contract_mismatch" });
});

test("positive control: without a shadowing grant the same owner's read is a package_mutation", async () => {
	const { registry, record, launch } = await setup((authorized) => ({ ...authorized, packageAttestations: [attest("./ext/workspace.ts", ext("workspace"))] }));
	const { pi, probe } = fakePi();
	const child = await factoryFor(registry, record.runId, pi).create(launch);
	await child.prompt("go");
	assert.equal(probe.requests, 0);
	assert.deepEqual(record.registry.failure, { status: "native_tool_registry_mismatch", toolRegistryError: "package_mutation" });
});

test("a completed terminal carries the replacement evidence; without it a shadowing contract is not a success", async () => {
	const authorized = withShadowing("./ext/workspace.ts", [attest("./ext/workspace.ts", ext("workspace"))])(await admitBoundLaunch(fixture));
	const registry = new BoundRunRegistryV1();
	const record = registry.open(authorized)!;
	record.registry.recordProjection(expectedToolRegistryProjection(authorized.contract.toolRegistry.projection.required, authorized.contract.toolRegistry.projection.internalTools)!);
	const result = { content: [{ type: "text", text: "done" }], details: { mode: "single", results: [{ agent: "reviewer", exitCode: 0, messages: [], finalOutput: "done" }] } } as never;
	const unverified = projectBoundTerminal(record, result, false);
	assert.deepEqual([unverified.status, unverified.toolRegistryError, unverified.result], ["native_tool_registry_mismatch", "shadowing_unverified", undefined]);
	const evidence = { version: 1 as const, tools: ["read"], declarations: { read: toolDeclarationDigest(WORKSPACE_READ)! } };
	record.registry.recordShadowing(evidence);
	const verified = projectBoundTerminal(record, result, false);
	assert.equal(verified.status, "completed");
	assert.deepEqual(verified.toolShadowing, evidence);
});

// ---- Attested MCP configuration (B1) ----

const SERVER = { command: "node", args: ["fx-server.js"] };

function writeCache(definition: Record<string, unknown> = SERVER): void {
	const agentDir = path.join(fixture.home, ".pi", "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify({ version: 1, servers: { fx: { configHash: computeMcpServerHash(definition as never), cachedAt: Date.now(), tools: [{ name: "search" }] } } }));
}

function mcpLaunch(configPath: string, bytes: string) {
	const adapterEntry = path.join(owner, "node_modules", "pi-mcp-adapter", "index.ts");
	const contract: BoundMcpConfigContractV1 = {
		version: 1, extension: "package:pi-mcp-adapter",
		sourcePathDigest: canonicalSha256(configPath), contentDigest: sha256(bytes), effectiveDigest: canonicalSha256(JSON.parse(bytes)), servers: ["fx"],
	};
	return (launch: BoundAuthorizedLaunch): BoundAuthorizedLaunch => {
		const required = ["fx_search", "read"];
		return {
			...launch,
			request: { ...launch.request, mcpConfig: { version: 1, path: configPath } },
			packageAttestations: [attest("package:pi-mcp-adapter", adapterEntry)],
			agent: { ...launch.agent, mcpDirectTools: ["fx/search"], definitionDigest: launch.contract.agent.definitionDigest } as BoundAuthorizedLaunch["agent"],
			contract: {
				...launch.contract,
				mcpConfig: contract,
				mcpDirectTools: ["fx_search"],
				tools: { ...launch.contract.tools, effectiveAllowlist: required },
				toolRegistry: { ...launch.contract.toolRegistry, projection: expectedToolRegistryProjection(required, [])! },
			},
		};
	};
}

test("with an attested configuration the adapter gets exactly that object, even when the process cwd differs (no D10)", async () => {
	writeCache();
	const configPath = path.join(fs.realpathSync(fixture.project), ".pi", "mcp.json");
	const bytes = JSON.stringify({ mcpServers: { fx: SERVER } });
	write(configPath, bytes);
	const { registry, record, launch } = await setup(mcpLaunch(configPath, bytes));
	const { pi, probe } = fakePi();
	delete process.env[ENV];
	const child = await factoryFor(registry, record.runId, pi, { processCwd: () => "/elsewhere" }).create(launch);
	assert.deepEqual((globalThis as Record<string, unknown>).__boundMcpConfigSeen, JSON.parse(bytes), "createMcpAdapter({ config }) received the attested object");
	assert.deepEqual(probe.envAtReload, ["fx/search"], "the window still carries exactly the contract's selector");
	await child.prompt("go");
	assert.equal(probe.requests, 1);
	assert.equal(record.registry.failure, undefined);
	assert.equal(process.env[ENV], undefined);
});

test("configuration bytes changed after preflight refuse the launch as mcp_config_drift before any session", async () => {
	writeCache();
	const configPath = path.join(fs.realpathSync(fixture.project), ".pi", "mcp.json");
	const bytes = JSON.stringify({ mcpServers: { fx: SERVER } });
	write(configPath, bytes);
	const { registry, record, launch } = await setup(mcpLaunch(configPath, bytes));
	write(configPath, JSON.stringify({ mcpServers: { fx: SERVER } }, null, 1));
	const { pi, probe } = fakePi();
	await assert.rejects(factoryFor(registry, record.runId, pi, { processCwd: () => "/elsewhere" }).create(launch), { message: BOUND_CHILD_REFUSED_TEXT });
	assert.deepEqual(record.registry.failure, { status: "unavailable_context", toolRegistryError: "mcp_config_drift" });
	assert.equal(probe.sessions, 0);
	assert.equal((globalThis as Record<string, unknown>).__boundMcpConfigSeen, undefined);
});

test("discovery that no longer confirms the attested configuration refuses the launch", async () => {
	writeCache();
	const configPath = path.join(fs.realpathSync(fixture.project), ".pi", "mcp.json");
	const bytes = JSON.stringify({ mcpServers: { fx: SERVER } });
	write(configPath, bytes);
	const { registry, record, launch } = await setup(mcpLaunch(configPath, bytes));
	// A metadata cache for another definition: neither the attested nor the discovered selector resolves.
	writeCache({ command: "node", args: ["other.js"] });
	const { pi } = fakePi();
	await assert.rejects(factoryFor(registry, record.runId, pi, { processCwd: () => "/elsewhere" }).create(launch), { message: BOUND_CHILD_REFUSED_TEXT });
	assert.deepEqual(record.registry.failure, { status: "unavailable_context", toolRegistryError: "launch_contract_mismatch" });
});

test("positive control: the same MCP leaf without an attested configuration still meets D10", async () => {
	writeCache();
	const configPath = path.join(fs.realpathSync(fixture.project), ".pi", "mcp.json");
	const bytes = JSON.stringify({ mcpServers: { fx: SERVER } });
	write(configPath, bytes);
	const { registry, record, launch } = await setup((authorized) => {
		const edited = mcpLaunch(configPath, bytes)(authorized);
		const { mcpConfig: _dropped, ...contract } = edited.contract;
		return { ...edited, contract };
	});
	const { pi, probe } = fakePi();
	await assert.rejects(factoryFor(registry, record.runId, pi, { processCwd: () => "/elsewhere" }).create(launch), { message: BOUND_CHILD_REFUSED_TEXT });
	assert.deepEqual(record.registry.failure, { status: "unavailable_context", toolRegistryError: "mcp_cwd_mismatch" });
	assert.equal(probe.sessions, 0);
});
