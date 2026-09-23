import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { clearAgentDiscoveryCache } from "../../src/agents/agents.ts";
import { clearBoundDiscoveryCaches } from "../../src/bound/bound-agent-discovery.ts";
import { boundRequestDigest, parseBoundRequest, type BoundRequestV2 } from "../../src/bound/bound-request.ts";
import { resolveBoundLaunchContract, type ResolveBoundLaunchContractInput } from "../../src/bound/bound-resolver.ts";
import { computeMcpServerHash } from "../../src/runs/shared/mcp-direct-tool-allowlist.ts";
import { canonicalSha256 } from "../../src/shared/canonical-json.ts";
import {
	createBoundFixture, FIXTURE_LAYER_MANIFEST, FIXTURE_MODELS, FIXTURE_PI_RUNTIME,
	FIXTURE_RUNTIME_BUILTINS, FIXTURE_SERVER_INSTANCE_ID, fixtureSourceIdentity, type BoundFixture,
} from "../fixtures/bound/harness.ts";

const identity = fixtureSourceIdentity();
const sourceIdentityDigest = identity.available ? identity.sourceIdentity.digest : "";
const SERVER = { command: "node", args: ["fx-server.js"] };

let fixture: BoundFixture;
let project: string;

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf8");
}

/**
 * The project is itself the owner package, like onecpi: package agents, their
 * own `./ext/*` extensions, and `pi-mcp-adapter` as a declared dependency.
 */
beforeEach(() => {
	fixture = createBoundFixture();
	project = fs.realpathSync(fixture.project);
	write(path.join(project, "package.json"), JSON.stringify({ name: "fixture-owner", version: "1.0.0", pi: { subagents: { agents: ["./agents"] } }, dependencies: { "pi-mcp-adapter": "2.26.1" } }));
	write(path.join(project, "agents", "ext", "workspace.ts"), "export default function workspace(): void {}\n");
	write(path.join(project, "agents", "ext", "git-read.ts"), "export default function gitRead(): void {}\n");
	const adapter = path.join(project, "node_modules", "pi-mcp-adapter");
	write(path.join(adapter, "package.json"), JSON.stringify({ name: "pi-mcp-adapter", version: "2.26.1", type: "module", main: "./index.ts", pi: { extensions: ["./index.ts"] } }));
	write(path.join(adapter, "index.ts"), "export function createMcpAdapter() { return () => {}; }\nexport default createMcpAdapter();\n");
	write(path.join(project, "agents", "lens.md"), "---\nname: lens\ndescription: Lens.\ntools: read, grep, find, ls\nsubagentOnlyExtensions: ./ext/git-read.ts, ./ext/workspace.ts\ninheritProjectContext: false\ninheritSkills: false\n---\n\nReview.\n");
	write(path.join(project, "agents", "lens-mcp.md"), "---\nname: lens-mcp\ndescription: MCP lens.\ntools: read, mcp:fx/search\nsubagentOnlyExtensions: package:pi-mcp-adapter\ninheritProjectContext: false\ninheritSkills: false\n---\n\nReview.\n");
	clearAgentDiscoveryCache();
	clearBoundDiscoveryCaches();
});
afterEach(() => { fixture.cleanup(); });

function parse(overrides: Record<string, unknown>): BoundRequestV2 | undefined {
	const parsed = parseBoundRequest(fixture.request(overrides));
	return parsed.ok ? parsed.request : undefined;
}

function resolve(requestOverrides: Record<string, unknown>, overrides: Partial<ResolveBoundLaunchContractInput> = {}) {
	const request = parse(requestOverrides);
	assert.ok(request, "the request itself parses");
	return resolveBoundLaunchContract({
		request,
		discoveryCwd: project,
		sessionManager: fixture.sessionManager,
		availableModels: FIXTURE_MODELS,
		serverInstanceId: FIXTURE_SERVER_INSTANCE_ID,
		sourceIdentityDigest,
		piRuntime: FIXTURE_PI_RUNTIME,
		runtimeBuiltins: FIXTURE_RUNTIME_BUILTINS,
		layerManifest: FIXTURE_LAYER_MANIFEST,
		defaultSessionDir: fixture.config.defaultSessionDir,
		runtimePolicy: { foregroundTimeoutMs: 60_000, waitToolEnabled: false, maxSubagentDepth: 1, currentDepth: 0 },
		...overrides,
	});
}

const SHADOW = { version: 1, extension: "./ext/workspace.ts", tools: ["find", "grep", "ls", "read"] };

test("fixture builtins include the four shadowable names", () => {
	for (const name of SHADOW.tools) assert.ok(FIXTURE_RUNTIME_BUILTINS.names.includes(name), name);
});

test("attested shadowing lands in toolRegistry, its digest, the request digest and the contract digest", () => {
	const plain = resolve({ agent: "lens" });
	const shadowed = resolve({ agent: "lens", toolShadowing: SHADOW });
	assert.ok(plain.ok && shadowed.ok, `refused: ${!plain.ok ? plain.code : ""} ${!shadowed.ok ? shadowed.code : ""}`);
	if (!plain.ok || !shadowed.ok) return;
	assert.equal(plain.contract.toolRegistry.shadowing, undefined, "no request field, no contract field");
	const workspace = shadowed.contract.packageExtensions.find((entry) => entry.ref === "./ext/workspace.ts")!;
	assert.deepEqual(shadowed.contract.toolRegistry.shadowing, {
		version: 1, tools: ["find", "grep", "ls", "read"],
		extension: { ref: "./ext/workspace.ts", owner: workspace.owner, contentDigest: workspace.contentDigest, packageTreeDigest: workspace.packageTreeDigest, evidenceRootDigest: workspace.evidenceRootDigest },
	});
	assert.notEqual(shadowed.contract.toolRegistry.digest, plain.contract.toolRegistry.digest);
	assert.notEqual(shadowed.contract.launchInputsDigest, plain.contract.launchInputsDigest);
	assert.notEqual(shadowed.launchContractDigest, plain.launchContractDigest);
	assert.notEqual(boundRequestDigest(parse({ agent: "lens", toolShadowing: SHADOW })!), boundRequestDigest(parse({ agent: "lens" })!));
	// The private attestation of the owner carries its contract ref, so the runtime can find it.
	assert.deepEqual(shadowed.packageAttestations.map((attestation) => attestation.ref).sort(), ["./ext/git-read.ts", "./ext/workspace.ts"]);
});

test("shadowing is refused for a dependency package, an unknown ref, a name outside the allowlist, and a non-package agent", () => {
	assert.deepEqual(resolve({ agent: "lens-mcp", toolShadowing: { version: 1, extension: "package:pi-mcp-adapter", tools: ["read"] } }), { ok: false, code: "restricted_agent" }, "no MCP cache: upstream planning refuses first");
	assert.deepEqual(resolve({ agent: "lens", toolShadowing: { ...SHADOW, extension: "./ext/other.ts" } }), { ok: false, code: "unsupported_mode" });
	fs.writeFileSync(path.join(project, "agents", "lens.md"), fs.readFileSync(path.join(project, "agents", "lens.md"), "utf8").replace("tools: read, grep, find, ls", "tools: read, find, ls"));
	clearAgentDiscoveryCache(); clearBoundDiscoveryCaches();
	assert.deepEqual(resolve({ agent: "lens", toolShadowing: SHADOW }), { ok: false, code: "unsupported_mode" }, "grep is not in the allowlist");
	assert.equal(resolve({ agent: "lens", toolShadowing: { ...SHADOW, tools: ["find", "ls", "read"] } }).ok, true, "positive control: the allowlisted subset resolves");
	assert.deepEqual(resolve({ agent: "reviewer", toolShadowing: { ...SHADOW, tools: ["read"] } }), { ok: false, code: "unsupported_mode" }, "a project agent owns no extension");
	// The dependency-package case itself, with a resolvable MCP selector.
	writeMcpCache([["fx", "search"]]);
	write(path.join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { fx: SERVER } }));
	assert.equal(resolve({ agent: "lens-mcp" }).ok, true, "positive control: the MCP lens resolves");
	assert.deepEqual(resolve({ agent: "lens-mcp", toolShadowing: { version: 1, extension: "package:pi-mcp-adapter", tools: ["read"] } }), { ok: false, code: "unsupported_mode" });
});

test("a malformed toolShadowing is an invalid request, as for a producer that does not know the field", () => {
	for (const toolShadowing of [
		{ ...SHADOW, tools: ["bash"] }, { ...SHADOW, tools: ["read", "grep"] }, { ...SHADOW, tools: ["read", "read"] },
		{ ...SHADOW, tools: [] }, { ...SHADOW, version: 2 }, { ...SHADOW, owner: "x" }, { version: 1, tools: ["read"] },
	]) assert.equal(parse({ agent: "lens", toolShadowing }), undefined, JSON.stringify(toolShadowing));
	assert.ok(parse({ agent: "lens", toolShadowing: SHADOW }));
});

function writeMcpCache(pairs: ReadonlyArray<readonly [string, string]>, definition: Record<string, unknown> = SERVER): void {
	const agentDir = path.join(fixture.home, ".pi", "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify({
		version: 1,
		servers: Object.fromEntries([...new Set(pairs.map(([server]) => server))].map((server) => [server, {
			configHash: computeMcpServerHash(definition as never), cachedAt: Date.now(),
			tools: pairs.filter(([owner]) => owner === server).map(([, tool]) => ({ name: tool })),
		}])),
	}));
}

test("an attested MCP configuration binds path, bytes and effective config into the contract", () => {
	writeMcpCache([["fx", "search"]]);
	const configPath = path.join(project, ".pi", "mcp.json");
	const bytes = JSON.stringify({ mcpServers: { fx: SERVER }, settings: { toolPrefix: "server" } });
	write(configPath, bytes);
	const plain = resolve({ agent: "lens-mcp" });
	const attested = resolve({ agent: "lens-mcp", mcpConfig: { version: 1, path: configPath } });
	assert.ok(plain.ok && attested.ok, `refused: ${!plain.ok ? plain.code : ""} ${!attested.ok ? attested.code : ""}`);
	if (!plain.ok || !attested.ok) return;
	assert.equal(plain.contract.mcpConfig, undefined);
	assert.deepEqual(attested.contract.mcpDirectTools, ["fx_search"]);
	assert.deepEqual(attested.contract.mcpConfig, {
		version: 1, extension: "package:pi-mcp-adapter",
		sourcePathDigest: canonicalSha256(configPath),
		contentDigest: createHash("sha256").update(bytes).digest("hex"),
		effectiveDigest: canonicalSha256(JSON.parse(bytes)),
		servers: ["fx"],
	});
	assert.notEqual(attested.contract.launchInputsDigest, plain.contract.launchInputsDigest);
	assert.notEqual(attested.launchContractDigest, plain.launchContractDigest);
});

test("an MCP leaf in an external cwd is refused without an attested configuration and resolves with one", () => {
	writeMcpCache([["fx", "search"]]);
	const external = path.join(fixture.tempRoot, "leaf");
	const configPath = path.join(external, ".pi", "mcp.json");
	write(configPath, JSON.stringify({ mcpServers: { fx: SERVER } }));
	// The host project holds no MCP configuration: the leaf's own cwd is the only
	// place discovery can find it, as for a review worktree.
	assert.deepEqual(resolve({ agent: "lens-mcp", cwd: external }), { ok: false, code: "unsupported_mode" }, "D10 without B1");
	const attested = resolve({ agent: "lens-mcp", cwd: external, mcpConfig: { version: 1, path: configPath } });
	assert.equal(attested.ok, true, attested.ok ? "" : attested.code);
	if (attested.ok) assert.equal(attested.contract.canonicalCwd, external);
});

test("an attested configuration that upstream discovery in the leaf cwd does not confirm is refused", () => {
	writeMcpCache([["fx", "search"]]);
	write(path.join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { fx: SERVER } }));
	// Another definition of the same server elsewhere: its hash has no cache entry,
	// and discovery in the leaf cwd sees the project's definition, not this one.
	const elsewhere = path.join(fixture.tempRoot, "elsewhere.json");
	write(elsewhere, JSON.stringify({ mcpServers: { fx: { command: "node", args: ["foreign.js"] } } }));
	assert.deepEqual(resolve({ agent: "lens-mcp", mcpConfig: { version: 1, path: elsewhere } }), { ok: false, code: "unsupported_mode" });
	// Positive control: a file holding the discovered definition resolves from anywhere.
	const same = path.join(fixture.tempRoot, "same.json");
	write(same, JSON.stringify({ mcpServers: { fx: SERVER } }));
	assert.equal(resolve({ agent: "lens-mcp", mcpConfig: { version: 1, path: same } }).ok, true);
});

test("an MCP configuration outside the closed shape, behind a symlink, or for a leaf without MCP is refused", () => {
	writeMcpCache([["fx", "search"]]);
	write(path.join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { fx: SERVER } }));
	const cases: Array<[string, unknown]> = [
		["imports", { mcpServers: { fx: SERVER }, imports: ["cursor"] }],
		["plugin paths", { mcpServers: { fx: SERVER }, settings: { agentPluginPaths: ["./x"] } }],
		["host discovery", { mcpServers: { fx: SERVER }, settings: { hostConfigDiscovery: "on" } }],
		["eager lifecycle", { mcpServers: { fx: { ...SERVER, lifecycle: "eager" } } }],
		["keep-alive lifecycle", { mcpServers: { fx: { ...SERVER, lifecycle: "keep-alive" } } }],
		["relative server cwd", { mcpServers: { fx: { ...SERVER, cwd: "sub" } } }],
		["no servers", { mcpServers: {} }],
		["unknown top-level key", { mcpServers: { fx: SERVER }, extra: true }],
	];
	for (const [label, config] of cases) {
		const file = path.join(fixture.tempRoot, `${label.replaceAll(" ", "-")}.json`);
		write(file, JSON.stringify(config));
		assert.deepEqual(resolve({ agent: "lens-mcp", mcpConfig: { version: 1, path: file } }), { ok: false, code: "unsupported_mode" }, label);
	}
	const target = path.join(fixture.tempRoot, "target.json");
	write(target, JSON.stringify({ mcpServers: { fx: SERVER } }));
	const link = path.join(fixture.tempRoot, "link.json");
	fs.symlinkSync(target, link);
	assert.deepEqual(resolve({ agent: "lens-mcp", mcpConfig: { version: 1, path: link } }), { ok: false, code: "unsupported_mode" }, "symlink");
	assert.equal(resolve({ agent: "lens-mcp", mcpConfig: { version: 1, path: target } }).ok, true, "positive control: the link target itself resolves");
	assert.deepEqual(resolve({ agent: "lens", mcpConfig: { version: 1, path: target } }), { ok: false, code: "unsupported_mode" }, "no MCP tools");
	for (const mcpConfig of [{ version: 1, path: "relative.json" }, { version: 1, path: `${target}/../target.json` }, { version: 2, path: target }, { version: 1 }]) {
		assert.equal(parse({ agent: "lens-mcp", mcpConfig }), undefined, JSON.stringify(mcpConfig));
	}
});
