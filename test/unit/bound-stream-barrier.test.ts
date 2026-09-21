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

const EXPECTATION: BoundBarrierExpectation = { toolNames: ["read", "bsl-search"], model: "openai/gpt-5", api: "openai-responses" };
const MODEL = { provider: "openai", id: "gpt-5", api: "openai-responses" };

function tools(...names: string[]): Array<{ name: string; description: string; parameters: object }> {
	return names.map((name) => ({ name, description: name, parameters: {} }));
}

function harness(install = true) {
	const calls: unknown[] = [];
	const refusals: BoundBarrierRefusal[] = [];
	const original: StreamFn = ((model: unknown, context: unknown) => { calls.push({ model, context }); return { stream: true }; }) as unknown as StreamFn;
	const agent = { streamFunction: original };
	const barrier = install ? installBoundStreamBarrier(agent, EXPECTATION, (refusal) => refusals.push(refusal)) : undefined;
	const call = (model: unknown, context: unknown) => (agent.streamFunction as unknown as (model: unknown, context: unknown, options?: unknown) => unknown)(model, context, {});
	return { calls, refusals, agent, barrier, call, original };
}

test("a matching tool set and model reach the original stream function exactly once", () => {
	const h = harness();
	assert.notEqual(h.agent.streamFunction, h.original);
	assert.deepEqual(h.call(MODEL, { tools: tools("bsl-search", "read") }), { stream: true });
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
		assert.throws(() => h.call(MODEL, { tools: tools(...names) }), { message: BOUND_BARRIER_ERROR_TEXT });
		assert.equal(h.calls.length, 0);
		assert.deepEqual(h.refusals, [{ reason: "tool_registry_mismatch", missing: [...missing], extra: [...extra] }]);
	});
}

test("a duplicated name is refused although the set matches", () => {
	const h = harness();
	assert.throws(() => h.call(MODEL, { tools: tools("read", "read", "bsl-search") }), { message: BOUND_BARRIER_ERROR_TEXT });
	assert.equal(h.calls.length, 0);
	assert.equal(h.refusals[0]?.reason, "tool_registry_mismatch");
});

for (const [label, context] of [["empty", { tools: [] }], ["absent", {}]] as const) {
	test(`a model call with ${label} tools is refused as compaction_forbidden`, () => {
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
		assert.throws(() => h.call(model, { tools: tools("read", "bsl-search") }), { message: BOUND_BARRIER_ERROR_TEXT });
		assert.equal(h.calls.length, 0);
		assert.deepEqual(h.refusals, [{ reason: "model_mismatch", missing: [], extra: [] }]);
	});
}

test("the barrier survives a second call and a model switch", () => {
	const h = harness();
	const installed = h.agent.streamFunction;
	h.call(MODEL, { tools: tools("read", "bsl-search") });
	h.call(MODEL, { tools: tools("read", "bsl-search") });
	assert.equal(h.calls.length, 2);
	assert.throws(() => h.call({ ...MODEL, id: "gpt-4" }, { tools: tools("read", "bsl-search") }), { message: BOUND_BARRIER_ERROR_TEXT });
	assert.equal(h.agent.streamFunction, installed);
	h.call(MODEL, { tools: tools("read", "bsl-search") });
	assert.equal(h.calls.length, 3);
});

test("refuseAlways closes every later call, even a matching one", () => {
	const h = harness();
	h.barrier!.refuseAlways({ reason: "tool_registry_mismatch", missing: ["bsl-search"], extra: [] });
	assert.throws(() => h.call(MODEL, { tools: tools("read", "bsl-search") }), { message: BOUND_BARRIER_ERROR_TEXT });
	assert.equal(h.calls.length, 0);
	assert.deepEqual(h.refusals, [{ reason: "tool_registry_mismatch", missing: ["bsl-search"], extra: [] }]);
});

test("without a stream function the barrier cannot be installed", () => {
	assert.equal(installBoundStreamBarrier(undefined, EXPECTATION, () => {}), undefined);
	assert.equal(installBoundStreamBarrier({} as { streamFunction: StreamFn }, EXPECTATION, () => {}), undefined);
});

test("positive control: without the wrapper the same mismatching call reaches the original stream function", () => {
	const h = harness(false);
	h.call(MODEL, { tools: tools("bash") });
	h.call(MODEL, {});
	assert.equal(h.calls.length, 2);
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
test("the barrier text matches no retry pattern of the installed pi-ai", { skip: !sdkRoot && "Set PI_SUBAGENTS_NATIVE_SDK to the isolated 0.85.1 SDK root" }, async () => {
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
