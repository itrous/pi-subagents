import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	BOUND_BARRIER_ERROR_TEXT, installBoundStreamBarrier, snapshotBoundToolRegistry,
	type BoundBarrierExpectation, type BoundBarrierRefusal,
} from "../../src/bound/bound-stream-barrier.ts";
import { expectedToolRegistryProjection } from "../../src/bound/bound-tool-registry-projection.ts";
import { toolDeclarationDigest } from "../../src/bound/bound-transcript.ts";
import { TEST_TRANSCRIPT_API, transcriptContext, transcriptTool, type TranscriptTool } from "../support/bound-transcript.ts";

const EXPECTATION: BoundBarrierExpectation = { toolNames: ["read", "bsl-search"], model: "openai/gpt-5", api: "openai-responses" };
const MODEL = { provider: "openai", id: "gpt-5", api: "openai-responses" };

function harness(install = true, expectation: BoundBarrierExpectation = EXPECTATION, transcript = TEST_TRANSCRIPT_API) {
	const calls: unknown[] = [];
	const refusals: BoundBarrierRefusal[] = [];
	const original: StreamFn = ((model: unknown, context: unknown) => { calls.push({ model, context }); return { stream: true }; }) as unknown as StreamFn;
	const agent = { streamFunction: original };
	const barrier = install ? installBoundStreamBarrier(agent, expectation, (refusal) => refusals.push(refusal), transcript) : undefined;
	const call = (model: unknown, context: unknown) => (agent.streamFunction as unknown as (model: unknown, context: unknown, options?: unknown) => unknown)(model, context, {});
	return { calls, refusals, agent, barrier, call, original };
}

/** A transcript whose tool set evolves over several system messages, as Pi 0.87 builds it across turns. */
function evolving(...steps: Array<{ added?: Array<string | TranscriptTool>; removed?: string[] }>) {
	const messages: Array<Record<string, unknown>> = [];
	steps.forEach((step, index) => {
		messages.push({
			role: "system", content: index === 0 ? "prompt" : "", timestamp: index,
			...(step.removed?.length ? { toolsRemoved: step.removed.map((name) => transcriptTool(name)) } : {}),
			...(step.added?.length ? { toolsAdded: step.added.map((tool) => (typeof tool === "string" ? transcriptTool(tool) : tool)) } : {}),
		});
		messages.push({ role: "user", content: [{ type: "text", text: `turn ${index}` }], timestamp: index });
	});
	return { messages };
}

test("a matching transcript tool set and model reach the original stream function exactly once", () => {
	const h = harness();
	assert.notEqual(h.agent.streamFunction, h.original);
	assert.deepEqual(h.call(MODEL, transcriptContext(["bsl-search", "read"])), { stream: true });
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.refusals, []);
});

for (const [label, names, missing, extra] of [
	["an extra name", ["read", "bsl-search", "bash"], [], ["bash"]],
	["a missing name", ["read"], ["bsl-search"], []],
	["a renamed name", ["read", "bsl_search"], ["bsl-search"], ["bsl_search"]],
] as const) {
	test(`${label} is refused before the original stream function`, () => {
		const h = harness();
		assert.throws(() => h.call(MODEL, transcriptContext([...names])), { message: BOUND_BARRIER_ERROR_TEXT });
		assert.equal(h.calls.length, 0);
		assert.deepEqual(h.refusals, [{ reason: "tool_registry_mismatch", missing: [...missing], extra: [...extra] }]);
	});
}

test("the tool set is the replay of every delta: additions, removals and a replacement in later system messages", () => {
	// Starts wrong (bash, no bsl-search), is corrected by later deltas: admitted.
	const corrected = harness();
	corrected.call(MODEL, evolving({ added: ["read", "bash"] }, { removed: ["bash"], added: ["bsl-search"] }));
	assert.equal(corrected.calls.length, 1);
	assert.deepEqual(corrected.refusals, []);
	// Starts right, a later delta removes a contract tool: refused although the first system message matches.
	const removed = harness();
	assert.throws(() => removed.call(MODEL, evolving({ added: ["read", "bsl-search"] }, { removed: ["bsl-search"] })), { message: BOUND_BARRIER_ERROR_TEXT });
	assert.deepEqual(removed.refusals, [{ reason: "tool_registry_mismatch", missing: ["bsl-search"], extra: [] }]);
	// A later delta adds a tool the contract does not declare.
	const added = harness();
	assert.throws(() => added.call(MODEL, evolving({ added: ["read", "bsl-search"] }, { added: ["bash"] })), { message: BOUND_BARRIER_ERROR_TEXT });
	assert.deepEqual(added.refusals, [{ reason: "tool_registry_mismatch", missing: [], extra: ["bash"] }]);
	assert.equal(removed.calls.length + added.calls.length, 0);
});

test("a definition replaced after the first admitted call is refused as tool_definition_mismatch", () => {
	const h = harness();
	h.call(MODEL, evolving({ added: ["read", "bsl-search"] }));
	assert.equal(h.calls.length, 1);
	assert.throws(() => h.call(MODEL, evolving({ added: ["read", "bsl-search"] }, { removed: ["read"], added: [transcriptTool("read", "read v2")] })), { message: BOUND_BARRIER_ERROR_TEXT });
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.refusals, [{ reason: "tool_definition_mismatch", missing: ["read"], extra: ["read"] }]);
	// Positive control: the same second transcript without the replacement passes.
	const control = harness();
	control.call(MODEL, evolving({ added: ["read", "bsl-search"] }));
	control.call(MODEL, evolving({ added: ["read", "bsl-search"] }, { added: [] }));
	assert.equal(control.calls.length, 2);
});

test("a required declaration must reach the provider exactly as attested", () => {
	const attested = transcriptTool("read", "workspace read");
	const expectation = { ...EXPECTATION, declarations: new Map([["read", toolDeclarationDigest(attested)!]]) };
	const matching = harness(true, expectation);
	matching.call(MODEL, transcriptContext([attested, "bsl-search"]));
	assert.equal(matching.calls.length, 1);
	const builtin = harness(true, expectation);
	assert.throws(() => builtin.call(MODEL, transcriptContext(["read", "bsl-search"])), { message: BOUND_BARRIER_ERROR_TEXT });
	assert.equal(builtin.calls.length, 0);
	assert.equal(builtin.refusals[0]?.reason, "tool_definition_mismatch");
});

test("a context that is not the exact transcript shape is refused as context_unsupported", () => {
	const legacy = { tools: [transcriptTool("read"), transcriptTool("bsl-search")] };
	const both = { ...transcriptContext(["read", "bsl-search"]), tools: [] };
	const duplicateInDelta = transcriptContext([transcriptTool("read"), transcriptTool("read"), "bsl-search"]);
	const deltaOnUser = { messages: [{ role: "user", content: "x", toolsAdded: [transcriptTool("read"), transcriptTool("bsl-search")] }] };
	const accessor = { get messages() { return transcriptContext(["read", "bsl-search"]).messages; } };
	const proxy = new Proxy(transcriptContext(["read", "bsl-search"]), {});
	const unnamed = { messages: [{ role: "system", content: "", toolsAdded: [{ description: "x" }] }] };
	for (const context of [legacy, both, duplicateInDelta, deltaOnUser, accessor, proxy, unnamed, undefined, null, "context"]) {
		const h = harness();
		assert.throws(() => h.call(MODEL, context), { message: BOUND_BARRIER_ERROR_TEXT });
		assert.equal(h.calls.length, 0);
		assert.equal(h.refusals[0]?.reason, "context_unsupported");
	}
});

test("a runtime replay that disagrees with the fork's replay is refused", () => {
	const lying = { getCurrentTools: () => [transcriptTool("read"), transcriptTool("bsl-search")] };
	const h = harness(true, EXPECTATION, lying);
	// The transcript itself declares only read; the runtime claims both.
	assert.throws(() => h.call(MODEL, transcriptContext(["read"])), { message: BOUND_BARRIER_ERROR_TEXT });
	assert.equal(h.calls.length, 0);
	assert.equal(h.refusals[0]?.reason, "context_unsupported");
});

for (const [label, context] of [
	["no tool delta at all", { messages: [{ role: "system", content: "summarize", timestamp: 0 }, { role: "user", content: "x", timestamp: 1 }] }],
	["an empty message list", { messages: [] }],
	["every tool removed again", evolving({ added: ["read", "bsl-search"] }, { removed: ["read", "bsl-search"] })],
] as const) {
	test(`a transcript with ${label} is refused as compaction_forbidden`, () => {
		const h = harness();
		assert.throws(() => h.call(MODEL, context), { message: BOUND_BARRIER_ERROR_TEXT });
		assert.equal(h.calls.length, 0);
		assert.equal(h.refusals[0]?.reason, "compaction_forbidden");
	});
}

for (const [label, model] of [
	["another model id", { ...MODEL, id: "gpt-4" }],
	["another provider", { ...MODEL, provider: "azure" }],
	["another api", { ...MODEL, api: "openai-completions" }],
] as const) {
	test(`${label} is refused before the original stream function`, () => {
		const h = harness();
		assert.throws(() => h.call(model, transcriptContext(["read", "bsl-search"])), { message: BOUND_BARRIER_ERROR_TEXT });
		assert.equal(h.calls.length, 0);
		assert.deepEqual(h.refusals, [{ reason: "model_mismatch", missing: [], extra: [] }]);
	});
}

test("the barrier survives a second call and a model switch", () => {
	const h = harness();
	const installed = h.agent.streamFunction;
	h.call(MODEL, transcriptContext(["read", "bsl-search"]));
	h.call(MODEL, transcriptContext(["read", "bsl-search"]));
	assert.equal(h.calls.length, 2);
	assert.throws(() => h.call({ ...MODEL, id: "gpt-4" }, transcriptContext(["read", "bsl-search"])), { message: BOUND_BARRIER_ERROR_TEXT });
	assert.equal(h.agent.streamFunction, installed);
	h.call(MODEL, transcriptContext(["read", "bsl-search"]));
	assert.equal(h.calls.length, 3);
});

test("refuseAlways closes every later call, even a matching one", () => {
	const h = harness();
	h.barrier!.refuseAlways({ reason: "tool_registry_mismatch", missing: ["bsl-search"], extra: [] });
	assert.throws(() => h.call(MODEL, transcriptContext(["read", "bsl-search"])), { message: BOUND_BARRIER_ERROR_TEXT });
	assert.equal(h.calls.length, 0);
	assert.deepEqual(h.refusals, [{ reason: "tool_registry_mismatch", missing: ["bsl-search"], extra: [] }]);
});

test("without a stream function or a verified transcript API the barrier cannot be installed", () => {
	assert.equal(installBoundStreamBarrier(undefined, EXPECTATION, () => {}, TEST_TRANSCRIPT_API), undefined);
	assert.equal(installBoundStreamBarrier({} as { streamFunction: StreamFn }, EXPECTATION, () => {}, TEST_TRANSCRIPT_API), undefined);
	const agent = { streamFunction: (() => ({})) as unknown as StreamFn };
	assert.equal(installBoundStreamBarrier(agent, EXPECTATION, () => {}, undefined), undefined);
	assert.equal(installBoundStreamBarrier(agent, EXPECTATION, () => {}, {} as typeof TEST_TRANSCRIPT_API), undefined);
});

test("positive control: without the wrapper the same mismatching calls reach the original stream function", () => {
	const h = harness(false);
	h.call(MODEL, transcriptContext(["bash"]));
	h.call(MODEL, { tools: [transcriptTool("read")] });
	h.call(MODEL, { messages: [] });
	assert.equal(h.calls.length, 3);
});

test("the registry snapshot equals the contract only for the exact active set", () => {
	const required = ["read", "bsl-search"];
	const internal: string[] = [];
	const exact = snapshotBoundToolRegistry({ getActiveToolNames: () => ["bsl-search", "read"] }, { required, internalTools: internal });
	assert.equal(exact.ok, true);
	assert.deepEqual(exact.projection, expectedToolRegistryProjection(required, internal));
	const extra = snapshotBoundToolRegistry({ getActiveToolNames: () => ["read", "bsl-search", "bash"] }, { required, internalTools: internal });
	assert.equal(extra.ok, false);
	if (!extra.ok) assert.deepEqual([extra.missing, extra.extra], [[], ["bash"]]);
	const missing = snapshotBoundToolRegistry({ getActiveToolNames: () => ["read"] }, { required, internalTools: internal });
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.deepEqual([missing.missing, missing.extra], [["bsl-search"], []]);
	const thrown = snapshotBoundToolRegistry({ getActiveToolNames: () => { throw new Error("gone"); } }, { required, internalTools: internal });
	assert.equal(thrown.ok, false);
});

// The patterns are read from the installed SDK, not copied: an incomplete copy
// would make this check impossible to fail.
const sdkRoot = process.env.PI_SUBAGENTS_NATIVE_SDK;
test("the barrier text matches no retry pattern of the installed pi-ai", { skip: !sdkRoot && "Set PI_SUBAGENTS_NATIVE_SDK to the isolated Pi SDK root" }, async () => {
	const entry = execFileSync(process.execPath, ["--input-type=module", "-e", "console.log(import.meta.resolve('@earendil-works/pi-coding-agent'))"], { cwd: sdkRoot, encoding: "utf8" }).trim();
	let directory = path.dirname(fileURLToPath(entry));
	while (!fs.existsSync(path.join(directory, "package.json"))) directory = path.dirname(directory);
	const candidates = [
		path.join(directory, "node_modules", "@earendil-works", "pi-ai", "dist", "utils", "retry.js"),
		path.join(sdkRoot!, "node_modules", "@earendil-works", "pi-ai", "dist", "utils", "retry.js"),
	];
	const retryPath = candidates.find((candidate) => fs.existsSync(candidate));
	assert.ok(retryPath, `retry.js not found under ${candidates.join(", ")}`);
	const retry = await import(pathToFileURL(retryPath).href) as { isRetryableAssistantError(message: { stopReason: string; errorMessage: string }): boolean };
	assert.equal(retry.isRetryableAssistantError({ stopReason: "error", errorMessage: BOUND_BARRIER_ERROR_TEXT }), false);
	// Positive control: a known transient text is classified as retryable.
	assert.equal(retry.isRetryableAssistantError({ stopReason: "error", errorMessage: "overloaded" }), true);
});
