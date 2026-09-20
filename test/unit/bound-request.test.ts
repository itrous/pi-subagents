import assert from "node:assert/strict";
import { test } from "node:test";
import { boundRequestDigest, boundRequestTarget, parseBoundRequest } from "../../src/bound/bound-request.ts";

const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN = "123e4567-e89b-12d3-a456-426614174000";

function baseRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: 2, targetServerInstanceId: TARGET, requestId: "r-1", ownerRunId: "o-1", nodeId: "n-1",
		prospectiveRunId: RUN, agent: "reviewer", task: "review the diff", cwd: "/tmp/project",
		context: "fresh", model: "openai/gpt-5", thinking: "medium", artifacts: false,
		result: { kind: "text" }, ...overrides,
	};
}

test("a well formed v2 request parses into the closed shape", () => {
	const parsed = parseBoundRequest(baseRequest({ timeoutMs: 1000, toolBudget: { hard: 5 }, skill: ["a", "b"], bindings: { ONECPI_REVIEW_ROOT: "/root" } }));
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.deepEqual(Object.keys(parsed.request).sort(), [
		"agent", "artifacts", "bindings", "context", "cwd", "model", "nodeId", "ownerRunId",
		"prospectiveRunId", "requestId", "result", "skill", "targetServerInstanceId", "task",
		"thinking", "timeoutMs", "toolBudget", "version",
	]);
	assert.ok(Object.isFrozen(parsed.request));
});

test("turnBudget and artifactDir of the v1 contract are unknown fields", () => {
	assert.deepEqual(parseBoundRequest(baseRequest({ turnBudget: { maxTurns: 3 } })), { ok: false, code: "invalid_request" });
	assert.deepEqual(parseBoundRequest(baseRequest({ artifactDir: "session" })), { ok: false, code: "invalid_request" });
	assert.deepEqual(parseBoundRequest(baseRequest({ environment: { ONECPI_REVIEW_ROOT: "/root" } })), { ok: false, code: "invalid_request" });
	assert.deepEqual(parseBoundRequest(baseRequest({ unexpected: 1 })), { ok: false, code: "invalid_request" });
});

test("accessors, prototypes, proxies, and symbol keys never execute foreign code", () => {
	let getterCalls = 0;
	const accessor = baseRequest();
	Object.defineProperty(accessor, "task", { get: () => { getterCalls++; return "x"; }, enumerable: true, configurable: true });
	assert.deepEqual(parseBoundRequest(accessor), { ok: false, code: "invalid_request" });
	assert.equal(getterCalls, 0);
	assert.deepEqual(parseBoundRequest(Object.assign(Object.create({ hidden: 1 }), baseRequest())), { ok: false, code: "invalid_request" });
	const trapped: string[] = [];
	const proxy = new Proxy(baseRequest(), { get(t, k, r) { trapped.push(String(k)); return Reflect.get(t, k, r); }, ownKeys(t) { trapped.push("ownKeys"); return Reflect.ownKeys(t); } });
	assert.deepEqual(parseBoundRequest(proxy), { ok: false, code: "invalid_request" });
	assert.deepEqual(trapped, []);
	assert.deepEqual(parseBoundRequest(baseRequest({ [Symbol("s")]: 1 })), { ok: false, code: "invalid_request" });
});

test("scalar validation rejects bad identity, model, thinking, and numbers", () => {
	assert.deepEqual(parseBoundRequest(baseRequest({ version: 1 })), { ok: false, code: "invalid_request" });
	assert.deepEqual(parseBoundRequest(baseRequest({ targetServerInstanceId: "not-a-uuid" })), { ok: false, code: "invalid_request" });
	assert.deepEqual(parseBoundRequest(baseRequest({ prospectiveRunId: TARGET.replace("4", "9") })), { ok: false, code: "invalid_request" });
	assert.deepEqual(parseBoundRequest(baseRequest({ requestId: " " })), { ok: false, code: "invalid_request" });
	assert.deepEqual(parseBoundRequest(baseRequest({ model: "gpt-5" })), { ok: false, code: "invalid_request" });
	assert.deepEqual(parseBoundRequest(baseRequest({ model: "openai/gpt-5:high" })), { ok: false, code: "invalid_request" });
	assert.deepEqual(parseBoundRequest(baseRequest({ thinking: "insane" })), { ok: false, code: "invalid_request" });
	assert.deepEqual(parseBoundRequest(baseRequest({ context: "fork" })), { ok: false, code: "invalid_request" });
	assert.deepEqual(parseBoundRequest(baseRequest({ artifacts: "yes" })), { ok: false, code: "invalid_request" });
	assert.deepEqual(parseBoundRequest(baseRequest({ timeoutMs: 0 })), { ok: false, code: "invalid_request" });
	assert.deepEqual(parseBoundRequest(baseRequest({ timeoutMs: Number.POSITIVE_INFINITY })), { ok: false, code: "invalid_request" });
	assert.deepEqual(parseBoundRequest(baseRequest({ toolBudget: { hard: 2, soft: 3 } })), { ok: false, code: "invalid_request" });
	assert.deepEqual(parseBoundRequest(baseRequest({ toolBudget: { hard: 2, extra: 1 } })), { ok: false, code: "invalid_request" });
	assert.deepEqual(parseBoundRequest(baseRequest({ bindings: { PATH: "/usr/bin" } })), { ok: false, code: "invalid_request" });
	assert.deepEqual(parseBoundRequest(baseRequest({ result: { kind: "structured" } })), { ok: false, code: "invalid_request" });
});

test("byte limits bound the task, cwd, and skill list", () => {
	assert.deepEqual(parseBoundRequest(baseRequest({ task: "x".repeat(1024 * 1024 + 1) })), { ok: false, code: "invalid_request" });
	assert.deepEqual(parseBoundRequest(baseRequest({ cwd: `/${"x".repeat(32 * 1024)}` })), { ok: false, code: "invalid_request" });
	assert.deepEqual(parseBoundRequest(baseRequest({ skill: Array.from({ length: 257 }, (_value, index) => `s${index}`) })), { ok: false, code: "invalid_request" });
	assert.deepEqual(parseBoundRequest(baseRequest({ skill: ["x".repeat(64 * 1024 + 1)] })), { ok: false, code: "invalid_request" });
	assert.deepEqual(parseBoundRequest(baseRequest({ task: "a\0b" })), { ok: false, code: "invalid_request" });
});

test("a cyclic request is rejected rather than traversed", () => {
	const cyclic = baseRequest() as Record<string, unknown>;
	(cyclic.result as Record<string, unknown>).self = cyclic;
	assert.deepEqual(parseBoundRequest(cyclic), { ok: false, code: "invalid_request" });
});

test("the request digest is order independent and input sensitive", () => {
	const left = parseBoundRequest(baseRequest({ timeoutMs: 5, bindings: { ONECPI_REVIEW_ROOT: "/root" } }));
	const right = parseBoundRequest({ result: { kind: "text" }, bindings: { ONECPI_REVIEW_ROOT: "/root" }, timeoutMs: 5, ...baseRequest() });
	assert.equal(left.ok && right.ok, true);
	if (!left.ok || !right.ok) return;
	assert.equal(boundRequestDigest(left.request), boundRequestDigest(right.request));
	const changed = parseBoundRequest(baseRequest({ timeoutMs: 6, bindings: { ONECPI_REVIEW_ROOT: "/root" } }));
	assert.equal(changed.ok, true);
	if (!changed.ok) return;
	assert.notEqual(boundRequestDigest(left.request), boundRequestDigest(changed.request));
});

test("the routing target is read without running caller code", () => {
	assert.equal(boundRequestTarget(baseRequest()), TARGET);
	assert.equal(boundRequestTarget(baseRequest({ targetServerInstanceId: "nope" })), undefined);
	assert.equal(boundRequestTarget(new Proxy(baseRequest(), {})), undefined);
	assert.equal(boundRequestTarget(undefined), undefined);
});
