import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createBoundChildSessionFactory } from "../../src/bound/bound-child-factory.ts";
import { BoundRunRegistryV1 } from "../../src/bound/bound-run-registry.ts";
import type { ChildSessionEvent, ChildSessionLaunch, PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { createBoundFixture, type BoundFixture } from "../fixtures/bound/harness.ts";
import { admitBoundLaunch, contractLaunch } from "../support/bound-launch.ts";

// Tier 2: the installed Pi SDK (decision D12). Never installs anything and never
// reaches the network: the provider is answered by a stub `globalThis.fetch`.
const sdkRoot = process.env.PI_SUBAGENTS_NATIVE_SDK;
const skip = !sdkRoot && "Set PI_SUBAGENTS_NATIVE_SDK to the isolated 0.85.1 SDK root";
const FAUX_URL = "https://synthetic.invalid/v1/chat/completions";
const FAUX_MODELS = [{ provider: "faux", id: "faux-1", fullId: "faux/faux-1", api: "openai-completions", reasoning: false }];

let fixture: BoundFixture;
let savedFetch: typeof fetch;
const envSnapshot = (): string => JSON.stringify(Object.entries(process.env).sort(([left], [right]) => (left < right ? -1 : 1)));

async function loadSdk(): Promise<PiCodingAgentModule> {
	const entry = execFileSync(process.execPath, ["--input-type=module", "-e", "console.log(import.meta.resolve('@earendil-works/pi-coding-agent'))"], { cwd: sdkRoot, encoding: "utf8" }).trim();
	const pi = await import(entry) as PiCodingAgentModule & { VERSION?: string };
	assert.equal(pi.VERSION, "0.85.1");
	return pi;
}

interface FauxProvider { requests: Array<{ tools?: unknown[] }>; }

/** Answers each chat request with a scripted SSE chunk and counts every request that reached the provider. */
function installFauxProvider(script: (request: { tools?: unknown[] }, index: number) => { delta: unknown; finish: string; tokens: number }): FauxProvider {
	const faux: FauxProvider = { requests: [] };
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		assert.equal(input instanceof Request ? input.url : String(input), FAUX_URL, "no request leaves for the network");
		const body = JSON.parse(String(init?.body)) as { tools?: unknown[] };
		const index = faux.requests.push(body) - 1;
		const { delta, finish, tokens } = script(body, index);
		const chunk = { id: "faux", object: "chat.completion.chunk", created: 1, model: "faux-1", choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: tokens, completion_tokens: 1, total_tokens: tokens + 1 } };
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
	}) as typeof fetch;
	return faux;
}

function writeAgentDir(settings: Record<string, unknown>): void {
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { faux: { baseUrl: "https://synthetic.invalid/v1", apiKey: "fixture-key", models: [{ id: "faux-1", name: "faux-1", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
}

async function runLeaf(pi: PiCodingAgentModule, extraHooks: ChildSessionLaunch["hooks"] = []) {
	const context = fixture.context();
	const authorized = await admitBoundLaunch(fixture, { model: "faux/faux-1", thinking: "off" }, {
		getContext: () => ({ ...context, modelRegistry: { getAvailable: () => FAUX_MODELS } }),
	});
	const registry = new BoundRunRegistryV1();
	const record = registry.open(authorized)!;
	const launch = contractLaunch(fixture, authorized);
	fs.mkdirSync(path.dirname((launch.storage as { sessionFile: string }).sessionFile), { recursive: true });
	const factory = createBoundChildSessionFactory({ runId: record.runId, expectedRunId: record.runId }, {
		registry, loadPiCodingAgent: async () => pi, processCwd: () => authorized.contract.canonicalCwd,
	});
	const events: ChildSessionEvent[] = [];
	const child = await factory.create({ ...launch, hooks: [...launch.hooks, ...extraHooks] });
	child.subscribe((event) => events.push(event));
	try { await child.prompt("Answer with one word."); }
	finally { await child.dispose(); await factory.dispose(); }
	const last = [...child.messages].reverse().find((message) => (message as { role?: string }).role === "assistant") as { stopReason?: string } | undefined;
	return { record, events, last };
}

describe("bound leaf on the installed Pi SDK (tier 2)", () => {
	beforeEach(() => { fixture = createBoundFixture(); savedFetch = globalThis.fetch; });
	afterEach(() => { globalThis.fetch = savedFetch; fixture.cleanup(); });

	it("a matching registry reaches the provider exactly once and completes", { skip }, async () => {
		const pi = await loadSdk();
		writeAgentDir({});
		const before = envSnapshot();
		const faux = installFauxProvider(() => ({ delta: { content: "done" }, finish: "stop", tokens: 10 }));
		const { record, last } = await runLeaf(pi);
		assert.equal(faux.requests.length, 1);
		assert.equal(last?.stopReason, "stop");
		assert.equal(record.registry.failure, undefined);
		assert.deepEqual(record.registry.projection?.missing, []);
		assert.equal(envSnapshot(), before, "process.env is byte-equal after the run");
	});

	it("a registry narrowed in session_start gets zero requests, no retry, and native_tool_registry_mismatch", { skip }, async () => {
		const pi = await loadSdk();
		// Default retry settings: the barrier text must not be retried by Pi.
		writeAgentDir({});
		const before = envSnapshot();
		const faux = installFauxProvider(() => ({ delta: { content: "must not happen" }, finish: "stop", tokens: 10 }));
		// Pi's allowlist cuts additions (fact S2), so the drift a live session can
		// still show is a narrowed set.
		const narrow: ChildSessionLaunch["hooks"][number] = {
			name: "fixture-narrow",
			factory: (api) => {
				api.on("session_start", () => { api.setActiveTools([]); });
			},
		};
		const { record, events, last } = await runLeaf(pi, [narrow]);
		assert.equal(faux.requests.length, 0);
		assert.equal(last?.stopReason, "error");
		assert.equal(events.filter((event) => event.type.startsWith("auto_retry")).length, 0, "no retry event");
		assert.deepEqual(record.registry.failure, { status: "native_tool_registry_mismatch", toolsMissing: ["read"], toolsExtra: [] });
		assert.equal(envSnapshot(), before);
	});

	it("threshold compaction does not pass the barrier", { skip }, async () => {
		const pi = await loadSdk();
		writeAgentDir({ retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: true, reserveTokens: 2048, keepRecentTokens: 32 } });
		fs.writeFileSync(path.join(fixture.project, "marker.txt"), "WORK_EVIDENCE");
		const before = envSnapshot();
		const faux = installFauxProvider((_request, index) => index === 0
			? { delta: { content: "Reading. ".repeat(12), tool_calls: [{ index: 0, id: "read-once", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "marker.txt" }) } }] }, finish: "tool_calls", tokens: 127000 }
			: { delta: { content: "done" }, finish: "stop", tokens: 10 });
		const { record } = await runLeaf(pi);
		assert.equal(faux.requests.filter((request) => !request.tools?.length).length, 0, "no summary request reached the provider");
		assert.ok(faux.requests.length >= 1, "the first turn did reach the provider");
		assert.deepEqual(record.registry.failure, { status: "native_tool_registry_mismatch", toolRegistryError: "compaction_forbidden" });
		assert.equal(envSnapshot(), before);
	});
});
