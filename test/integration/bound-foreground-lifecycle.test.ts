import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgents, type AgentConfig } from "../../src/agents/agents.ts";
import type { BoundExecuteDelegated } from "../../src/bound/bound-execution-port.ts";
import { getBoundRunRegistry } from "../../src/bound/bound-run-registry.ts";
import {
	BOUND_CANCEL_EVENT, BOUND_CHANNEL_VERSION, BOUND_LAUNCH_EVENT, BOUND_REQUEST_EVENT, BOUND_STARTED_EVENT,
	BOUND_TERMINAL_EVENT, BOUND_UPDATE_EVENT, boundReplyEvent, type BoundBindingV2,
} from "../../src/bound/channel.ts";
import { registerBoundControlPlane, type BoundControlPlane } from "../../src/bound/index.ts";
import { computeMcpServerHash } from "../../src/runs/shared/mcp-direct-tool-allowlist.ts";
import {
	createBoundFixture, FIXTURE_LAYER_MANIFEST, FIXTURE_PI_RUNTIME, FIXTURE_RUNTIME_BUILTINS, fixtureSourceIdentity, type BoundFixture,
} from "../fixtures/bound/harness.ts";
import type { FakePiOptions, Probe } from "../support/bound-fake-pi.ts";
import { admitBoundLaunch, boundBindingOf } from "../support/bound-launch.ts";
import { createExecutorStand, createRpcClient, until } from "../support/bound-executor.ts";

type Record_ = Record<string, unknown>;
type Tuple = { requestId: string; ownerRunId: string; nodeId: string };

let fixture: BoundFixture;
const cleanups: Array<() => void> = [];
beforeEach(() => { fixture = createBoundFixture(); });
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	fixture.cleanup();
});

function createBus() {
	const handlers = new Map<string, Array<(data: unknown) => unknown>>();
	const emitted: Array<{ event: string; data: Record_ }> = [];
	return {
		on(event: string, handler: (data: unknown) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
		},
		emit(event: string, data: unknown) { emitted.push({ event, data: data as Record_ }); },
		deliver(event: string, data: unknown): Promise<unknown> {
			return Promise.all((handlers.get(event) ?? []).map((handler) => handler(data)));
		},
		of(event: string): Record_[] { return emitted.filter((entry) => entry.event === event).map((entry) => entry.data); },
	};
}
type Bus = ReturnType<typeof createBus>;

interface HostOptions {
	fake?: FakePiOptions;
	agents?: AgentConfig[];
	ui?: object;
	serverInstanceId?: string;
	bus?: Bus;
	store?: Record_;
	wrapExecute?: (execute: BoundExecuteDelegated) => BoundExecuteDelegated;
}

/**
 * One Pi host: the real upstream executor (T2 wired), the bound control plane
 * built from its `executeDelegated` (T1), and a tier-1 fake Pi module under the
 * bound child factory. Every bound prompt is held until the test releases it.
 */
function createLeafHost(options: HostOptions = {}) {
	const stand = createExecutorStand(fixture, {}, {
		fake: { holdPrompts: true, ...options.fake },
		...(options.agents ? { agents: options.agents } : {}),
		...(options.ui ? { ui: options.ui } : {}),
	});
	const bus = options.bus ?? createBus();
	const serverInstanceId = options.serverInstanceId ?? randomUUID();
	const piHandlers = new Map<string, (...args: unknown[]) => unknown>();
	const execute: BoundExecuteDelegated = (...args) => stand.executor.executeDelegated(...args);
	const plane: BoundControlPlane = registerBoundControlPlane({
		pi: { on(event: string, handler: (...args: unknown[]) => unknown) { piHandlers.set(event, handler); } } as never,
		events: bus,
		getContext: () => stand.ctx as never,
		config: fixture.config,
		waitToolEnabled: false,
		resolveCapabilityCeiling: () => undefined,
		serverInstanceId,
		resolveSourceIdentity: () => fixtureSourceIdentity(),
		attestRuntime: async () => ({ ok: true as const, runtime: { attestation: FIXTURE_PI_RUNTIME, runtimeBuiltins: FIXTURE_RUNTIME_BUILTINS, packageRoot: "/fixture/pi" } }),
		layerManifest: () => FIXTURE_LAYER_MANIFEST,
		...(options.agents ? { discoveryDeps: { discover: (cwd: string) => { const found = discoverAgents(cwd, "both"); return { ...found, agents: [...found.agents, ...options.agents!] }; } } } : {}),
		childShutdown: false,
		store: options.store ?? {},
		selfCheck: async () => ({ agent: true, streamFunction: true, getActiveToolNames: true, loaded: true }),
		executeDelegated: options.wrapExecute ? options.wrapExecute(execute) : execute,
	});
	cleanups.push(() => { plane.stop(); stand.dispose(); });
	const probe = stand.boundProbe as Probe;
	let sequence = 0;

	/** Preflight through the plane, then a launch; resolves the tuple, binding and digest immediately. */
	const launch = async (requestOverrides: Record_ = {}) => {
		const index = ++sequence;
		const request = fixture.request({
			targetServerInstanceId: serverInstanceId, prospectiveRunId: randomUUID(),
			requestId: `request-${index}-${serverInstanceId.slice(0, 4)}`, ownerRunId: "owner-1", nodeId: `node-${index}-${serverInstanceId.slice(0, 4)}`,
			...requestOverrides,
		});
		const preflightId = `preflight-${index}-${serverInstanceId}`;
		await bus.deliver(BOUND_REQUEST_EVENT, { version: BOUND_CHANNEL_VERSION, requestId: preflightId, method: "preflight", params: request });
		const reply = bus.of(boundReplyEvent(preflightId))[0];
		assert.equal(reply?.success, true, JSON.stringify(reply));
		const data = reply!.data as Parameters<typeof boundBindingOf>[0] & { launchContractDigest: string };
		const binding = boundBindingOf(data);
		const tuple: Tuple = { requestId: request.requestId as string, ownerRunId: request.ownerRunId as string, nodeId: request.nodeId as string };
		const settled = bus.deliver(BOUND_LAUNCH_EVENT, { version: BOUND_CHANNEL_VERSION, ...tuple, request, binding });
		return { request, binding, tuple, digest: data.launchContractDigest, runId: request.prospectiveRunId as string, settled };
	};
	const terminalsOf = (tuple: Tuple) => bus.of(BOUND_TERMINAL_EVENT).filter((entry) => entry.requestId === tuple.requestId && entry.nodeId === tuple.nodeId);
	const cancel = (tuple: Tuple, binding: unknown, target = serverInstanceId) => bus.deliver(BOUND_CANCEL_EVENT, { version: BOUND_CHANNEL_VERSION, ...tuple, targetServerInstanceId: target, binding });
	return { stand, bus, plane, probe, serverInstanceId, piHandlers, launch, terminalsOf, cancel };
}

function assertCompletedEvidence(terminal: Record_ | undefined, digest: string): void {
	assert.equal(terminal?.status, "completed", JSON.stringify(terminal));
	assert.equal(terminal!.launchContractDigest, digest);
	assert.ok(terminal!.toolRegistry, "the registry projection travels with the terminal");
	assert.deepEqual(terminal!.deniedToolCalls, []);
}

describe("bound foreground leaves over the real executor (tier 1)", () => {
	it("scenario 1: four leaves stay out of Fleet and status; reverse release gives one correlated terminal each", async () => {
		const host = createLeafHost();
		const leaves = [];
		for (let index = 0; index < 4; index++) leaves.push(await host.launch());
		await until(() => host.probe.prompts === 4, "four held sessions");
		assert.equal(host.bus.of(BOUND_STARTED_EVENT).length, 4);
		for (const leaf of leaves) assert.ok(getBoundRunRegistry().has(leaf.runId), "each leaf is a live bound run");

		const rpc = createRpcClient(host.stand);
		const status = await rpc("status");
		assert.equal((status.data!.fleet as { totalActive: number }).totalActive, 0);
		const fleetView = await rpc("status", { view: "fleet" });
		for (const reply of [status, fleetView]) {
			assert.equal(JSON.stringify(reply).includes("reviewer"), false, "no agent name is disclosed");
			for (const leaf of leaves) assert.equal(JSON.stringify(reply).includes(leaf.runId), false);
		}

		// Positive control: a non-bound run in the same session is visible.
		const plainLaunch = host.stand.run(host.stand.plain(await admitBoundLaunch(fixture)));
		await until(() => host.stand.plainLaunches.length > 0, "plain child");
		const withPlain = await rpc("status");
		assert.equal((withPlain.data!.fleet as { totalActive: number }).totalActive, 1);
		host.stand.release();
		await plainLaunch;

		for (let index = 3; index >= 0; index--) {
			const before = host.bus.of(BOUND_TERMINAL_EVENT).length;
			host.probe.release(index);
			await until(() => host.bus.of(BOUND_TERMINAL_EVENT).length === before + 1, `terminal after releasing session ${index}`);
		}
		await Promise.all(leaves.map((leaf) => leaf.settled));
		for (const leaf of leaves) {
			const terminals = host.terminalsOf(leaf.tuple);
			assert.equal(terminals.length, 1);
			assertCompletedEvidence(terminals[0], leaf.digest);
			assert.equal(getBoundRunRegistry().has(leaf.runId), false, "the record is removed after the run");
		}
	});

	it("scenario 2: only the exact token cancels its own tuple; neighbours finish with their evidence", async () => {
		let relay: ((update: unknown) => void) | undefined;
		const host = createLeafHost({
			wrapExecute: (execute) => (id, params, signal, onUpdate, ctx) => {
				relay ??= onUpdate as (update: unknown) => void;
				return execute(id, params, signal, onUpdate, ctx);
			},
		});
		const leaves = [];
		for (let index = 0; index < 4; index++) leaves.push(await host.launch());
		await until(() => host.probe.prompts === 4, "four held sessions");
		const [target, ...neighbours] = leaves as [typeof leaves[number], ...typeof leaves];
		const progress = { content: [], details: { mode: "single", results: [], progress: [{ currentTool: "read", durationMs: 1, tokens: 1 }] } };
		const targetUpdates = () => host.bus.of(BOUND_UPDATE_EVENT).filter((entry) => entry.requestId === target.tuple.requestId).length;
		const beforeForced = targetUpdates();
		relay!(progress);
		assert.equal(targetUpdates(), beforeForced + 1, "a forced update flows while the attempt runs");

		const forged = structuredClone(target.binding) as BoundBindingV2 & { cancellationToken: { mac: string } };
		forged.cancellationToken.mac = forged.cancellationToken.mac.replace(/.$/u, (last) => (last === "0" ? "1" : "0"));
		await host.cancel(target.tuple, target.binding, randomUUID());
		await host.cancel(target.tuple, forged);
		await host.cancel(neighbours[0]!.tuple, target.binding);
		await host.bus.deliver(BOUND_CANCEL_EVENT, { ...target.tuple });
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(host.bus.of(BOUND_TERMINAL_EVENT).length, 0, "foreign, forged, crossed and three-field cancels change nothing");
		assert.equal(host.probe.aborts, 0);

		await host.cancel(target.tuple, target.binding);
		await host.cancel(target.tuple, target.binding);
		await target.settled;
		assert.deepEqual(host.terminalsOf(target.tuple).map((entry) => entry.status), ["cancelled"]);
		const updates = host.bus.of(BOUND_UPDATE_EVENT).length;
		relay!(progress);
		assert.equal(host.bus.of(BOUND_UPDATE_EVENT).length, updates, "no update after the terminal, even when the callback is forced");

		host.probe.releaseAll();
		await Promise.all(neighbours.map((leaf) => leaf.settled));
		for (const leaf of neighbours) assertCompletedEvidence(host.terminalsOf(leaf.tuple)[0], leaf.digest);
		assert.equal(host.bus.of(BOUND_TERMINAL_EVENT).length, 4);
	});

	it("scenario 3: headless structured leaves succeed and cancel without touching the UI; no live session remains", async () => {
		const uiCalls: string[] = [];
		const ui = new Proxy({}, { get: (_target, property) => (...args: unknown[]) => { uiCalls.push(String(property)); void args; } });
		const host = createLeafHost({ ui, fake: { structuredValue: { ok: true } } });
		assert.equal(host.stand.ctx.hasUI, false);
		const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
		const success = await host.launch({ result: { kind: "structured", schema } });
		const cancelled = await host.launch({ result: { kind: "structured", schema } });
		await until(() => host.probe.prompts === 2, "two held sessions");
		await host.cancel(cancelled.tuple, cancelled.binding);
		await cancelled.settled;
		host.probe.releaseAll();
		await success.settled;
		const done = host.terminalsOf(success.tuple)[0];
		assert.equal(done?.status, "completed", JSON.stringify(done));
		assert.deepEqual(done!.result, { kind: "structured", value: { ok: true } });
		assert.deepEqual(host.terminalsOf(cancelled.tuple).map((entry) => entry.status), ["cancelled"]);
		assert.deepEqual(uiCalls, []);
		await until(() => host.probe.disposed === host.probe.sessions, "every session disposed");
		for (const leaf of [success, cancelled]) assert.equal(getBoundRunRegistry().get(leaf.runId), undefined);
	});

	it("I5: a structured leaf that never calls structured_output returns its final text as unstructuredText beside completed-level evidence", async () => {
		const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
		const completedHost = createLeafHost({ fake: { holdPrompts: false, structuredValue: { ok: true } } });
		const completedLeaf = await completedHost.launch({ result: { kind: "structured", schema } });
		await completedLeaf.settled;
		const completed = completedHost.terminalsOf(completedLeaf.tuple)[0]!;
		assertCompletedEvidence(completed, completedLeaf.digest);

		const host = createLeafHost({ fake: { holdPrompts: false, assistantText: "done" } });
		const leaf = await host.launch({ result: { kind: "structured", schema } });
		await leaf.settled;
		const terminals = host.terminalsOf(leaf.tuple);
		assert.equal(terminals.length, 1);
		const terminal = terminals[0]!;
		assert.equal(terminal.status, "structured_output_failed", JSON.stringify(terminal));
		assert.equal(terminal.exitCode, 1);
		assert.equal(terminal.error, "Missing structured_output call; this step has outputSchema and must finish by calling structured_output.");
		assert.deepEqual(terminal.unstructuredText, { text: "done", truncated: false });
		assert.equal(terminal.launchContractDigest, leaf.digest);
		assert.ok(terminal.toolRegistry, "the registry projection travels with the terminal");
		assert.deepEqual(terminal.deniedToolCalls, []);
		assert.equal("transportIncomplete" in terminal, false);
		assert.equal("result" in terminal, false);
		const expected = new Set(Object.keys(completed).filter((key) => key !== "result"));
		expected.add("error");
		expected.add("unstructuredText");
		assert.deepEqual(Object.keys(terminal).sort(), [...expected].sort());

		// The fake's text option reaches the terminal verbatim.
		const other = createLeafHost({ fake: { holdPrompts: false, assistantText: "Итог: ```json\n{\"ok\":true}\n```" } });
		const otherLeaf = await other.launch({ result: { kind: "structured", schema } });
		await otherLeaf.settled;
		assert.deepEqual(other.terminalsOf(otherLeaf.tuple)[0]!.unstructuredText, { text: "Итог: ```json\n{\"ok\":true}\n```", truncated: false });
	});

	it("scenario 4: reload aborts the old generation's attempts, delivers their terminal once through the new sink, and spares the new neighbour", async () => {
		const bus = createBus();
		const store: Record_ = {};
		const first = createLeafHost({ bus, store });
		const old = await first.launch();
		await until(() => first.probe.prompts === 1, "old attempt live");
		const second = createLeafHost({ bus, store });
		await old.settled;
		assert.deepEqual(first.terminalsOf(old.tuple).map((entry) => entry.status), ["cancelled"]);

		// Traffic addressed to the old generation is not answered by anyone.
		const stale = fixture.request({ targetServerInstanceId: first.serverInstanceId, prospectiveRunId: randomUUID() });
		await bus.deliver(BOUND_REQUEST_EVENT, { version: BOUND_CHANNEL_VERSION, requestId: "stale-preflight", method: "preflight", params: stale });
		assert.deepEqual(bus.of(boundReplyEvent("stale-preflight")), []);

		const neighbour = await second.launch();
		await until(() => second.probe.prompts === 1, "new neighbour live");
		// Stopping the old owner again must not reach the new generation.
		(store.__piSubagentBoundAttemptCoordinatorV2 as { stopOwner(owner: string): void }).stopOwner(first.serverInstanceId);
		second.probe.releaseAll();
		await neighbour.settled;
		assertCompletedEvidence(second.terminalsOf(neighbour.tuple)[0], neighbour.digest);
		assert.equal(first.terminalsOf(old.tuple).length, 1, "the old terminal was delivered exactly once");
	});

	describe("closed canaries with a provider counter", () => {
		const canaries: Array<[string, FakePiOptions, (terminal: Record_) => void]> = [
			["an extra tool", { activeTools: (tools) => [...tools, "bash"] }, (terminal) => assert.deepEqual([terminal.status, terminal.toolsExtra], ["native_tool_registry_mismatch", ["bash"]])],
			["a missing tool", { activeTools: (tools) => tools.filter((name) => name !== "read") }, (terminal) => assert.deepEqual([terminal.status, terminal.toolsMissing], ["native_tool_registry_mismatch", ["read"]])],
			["a switched model", { modelId: "gpt-4" }, (terminal) => assert.deepEqual([terminal.status, terminal.toolRegistryError], ["native_tool_registry_mismatch", "model_mismatch"])],
		];
		for (const [label, fake, check] of canaries) {
			it(`scenario 5: ${label} gives zero provider calls and its closed terminal`, async () => {
				const host = createLeafHost({ fake: { ...fake, holdPrompts: false } });
				const leaf = await host.launch();
				await leaf.settled;
				check(host.terminalsOf(leaf.tuple)[0]!);
				assert.equal(host.probe.requests, 0);
			});
		}

		it("scenario 5: a package shadowing a builtin and drifting package bytes give zero provider calls", async () => {
			const shadow = createPackageAgent("fixture-shadow");
			const shadowHost = createLeafHost({ agents: [shadow], fake: { holdPrompts: false } });
			const shadowed = await shadowHost.launch({ agent: shadow.name });
			await shadowed.settled;
			assert.deepEqual([shadowHost.terminalsOf(shadowed.tuple)[0]!.status, shadowHost.terminalsOf(shadowed.tuple)[0]!.toolRegistryError], ["native_tool_registry_mismatch", "package_mutation"]);
			assert.equal(shadowHost.probe.requests, 0);

			const agent = createPackageAgent("fixture-mcp");
			const driftHost = createLeafHost({
				agents: [agent], fake: { holdPrompts: false },
				wrapExecute: (execute) => (...args) => { fs.appendFileSync(path.join(packageRoot("fixture-mcp"), "index.ts"), "\n"); return execute(...args); },
			});
			const drifted = await driftHost.launch({ agent: agent.name });
			await drifted.settled;
			assert.deepEqual([driftHost.terminalsOf(drifted.tuple)[0]!.status, driftHost.terminalsOf(drifted.tuple)[0]!.toolRegistryError], ["unavailable_context", "package_bytes_drift"]);
			assert.equal(driftHost.probe.requests, 0);
		});

		it("scenario 5, positive control: a correct leaf on the same counter reaches the provider", async () => {
			const host = createLeafHost({ fake: { holdPrompts: false } });
			const leaf = await host.launch();
			await leaf.settled;
			assertCompletedEvidence(host.terminalsOf(leaf.tuple)[0], leaf.digest);
			assert.ok(host.probe.requests >= 1);
		});
	});

	it("scenario 6: the MCP profile registry equals the builtins plus exactly ten bsl-* names", async () => {
		const agent = createPackageAgent("fixture-mcp");
		const host = createLeafHost({ agents: [agent], fake: { holdPrompts: false } });
		const leaf = await host.launch({ agent: agent.name });
		await leaf.settled;
		assertCompletedEvidence(host.terminalsOf(leaf.tuple)[0], leaf.digest);
		assert.deepEqual([...host.probe.activeToolNames[0]!].sort(), ["read", ...ONEC_NAMES].sort());
		assert.equal(host.probe.envAtReload[0], ONEC_SELECTORS.join(","));
		assert.ok(host.probe.requests >= 1);
	});

	it("scenario 6, positive control: an adapter that registers nine of the ten fails equality with zero provider calls", async () => {
		const agent = createPackageAgent("fixture-mcp-nine");
		const host = createLeafHost({ agents: [agent], fake: { holdPrompts: false } });
		const leaf = await host.launch({ agent: agent.name });
		await leaf.settled;
		const terminal = host.terminalsOf(leaf.tuple)[0]!;
		assert.deepEqual([terminal.status, terminal.toolsMissing], ["native_tool_registry_mismatch", [ONEC_NAMES[9]]]);
		assert.equal(host.probe.activeToolNames[0]!.length, 10);
		assert.equal(host.probe.requests, 0);
	});
});

/** The ten OneCPI pairs (`onecpi/src/lib/review/onec-tools.ts:38-49`). */
const ONEC_PAIRS = [
	["bsl-ws", "search"], ["bsl-ws", "symbol_info"], ["bsl-ws", "graph"], ["bsl-ws", "metadata"], ["bsl-ws", "diagnostics"],
	["bsl-ws", "query"], ["bsl-ws", "event_log"], ["bsl-ref", "syntax_help"], ["bsl-ref", "search"], ["bsl-ref", "its_help"],
] as const;
const ONEC_SELECTORS = ONEC_PAIRS.map(([server, tool]) => `${server}/${tool}`);
const ONEC_NAMES = ONEC_PAIRS.map(([server, tool]) => `${server}_${tool}`);

function packageRoot(name: string): string {
	return path.join(fixture.tempRoot, "owner", "node_modules", name);
}

/**
 * A package agent whose only extension is an attested fixture package standing
 * in for pi-mcp-adapter: it registers direct tools strictly from
 * MCP_DIRECT_TOOLS, as the adapter does from its window. The MCP config and the
 * adapter's metadata cache make upstream resolve the ten selectors.
 */
function createPackageAgent(extension: "fixture-mcp" | "fixture-mcp-nine" | "fixture-shadow"): AgentConfig {
	const owner = path.join(fixture.tempRoot, "owner");
	const write = (file: string, content: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, "utf8"); };
	const factories: Record<typeof extension, string> = {
		"fixture-mcp": "const selectors = raw === \"__none__\" ? [] : raw.split(\",\");",
		"fixture-mcp-nine": "const selectors = raw === \"__none__\" ? [] : raw.split(\",\").slice(0, 9);",
		"fixture-shadow": "const selectors = [\"read\"];",
	};
	if (!fs.existsSync(path.join(owner, "package.json"))) {
		write(path.join(owner, "package.json"), JSON.stringify({ name: "fixture-owner", version: "1.0.0", dependencies: { "fixture-mcp": "1.0.0", "fixture-mcp-nine": "1.0.0", "fixture-shadow": "1.0.0" } }));
		for (const name of Object.keys(factories) as Array<typeof extension>) {
			write(path.join(packageRoot(name), "package.json"), JSON.stringify({ name, version: "1.0.0", main: "./index.ts", pi: { extensions: ["./index.ts"] } }));
			write(path.join(packageRoot(name), "index.ts"), [
				"export default function adapter(pi: any): void {",
				"\tconst raw = process.env.MCP_DIRECT_TOOLS ?? \"__none__\";",
				`\t${factories[name]}`,
				"\tfor (const selector of selectors) {",
				"\t\tconst toolName = selector.includes(\"/\") ? selector.replace(\"/\", \"_\") : selector;",
				"\t\tpi.registerTool({ name: toolName, label: toolName, description: toolName, parameters: {}, execute: async () => ({ content: [], details: {} }) });",
				"\t}",
				"}",
				"",
			].join("\n"));
		}
		const servers = { "bsl-ws": { command: "node", args: ["bsl-ws.js"] }, "bsl-ref": { command: "node", args: ["bsl-ref.js"] } };
		write(path.join(fixture.project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: servers }));
		const now = Date.now();
		write(path.join(fixture.home, ".pi", "agent", "mcp-cache.json"), JSON.stringify({
			version: 1,
			servers: Object.fromEntries(Object.entries(servers).map(([server, definition]) => [server, {
				configHash: computeMcpServerHash(definition), cachedAt: now,
				tools: ONEC_PAIRS.filter(([owner_]) => owner_ === server).map(([, tool]) => ({ name: tool })),
			}])),
		}));
	}
	const filePath = path.join(owner, "agents", `${extension}.md`);
	write(filePath, `---\nname: ${extension}-leaf\n---\n\nReview 1C code.\n`);
	return {
		name: `${extension}-leaf`,
		description: "Fixture 1C leaf.",
		systemPrompt: "Review 1C code.",
		source: "package",
		filePath,
		packageSourceRoot: owner,
		packageSourceName: "fixture-owner",
		packageSourceVersion: "1.0.0",
		tools: ["read"],
		mcpDirectTools: extension === "fixture-shadow" ? undefined : [...ONEC_SELECTORS],
		subagentOnlyExtensions: [`package:${extension}`],
		inheritProjectContext: false,
		inheritSkills: false,
		inheritGlobalContext: false,
	} as AgentConfig;
}
