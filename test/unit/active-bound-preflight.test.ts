import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { activeBoundPreflightRequestDigest, activeBoundPreflightTarget, parseActiveBoundPreflightRequest } from "../../src/api/active-bound-preflight.ts";

const VECTOR = {
	version: 1, targetServerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", requestId: "request-a", ownerRunId: "owner-a", nodeId: "node-a",
	prospectiveRunId: "123e4567-e89b-12d3-a456-426614174000", agent: "worker", task: "Do it", cwd: "/repo",
	context: "fresh", model: "test/exact", thinking: "high", artifacts: false,
	result: { kind: "structured", schema: { z: 1, "\ud83d\ude00": true, "\uffff": null, a: [3, 2, 1] } },
} as const;

// Independent literal: intentionally does not import the production projection/canonicalizer.
const VECTOR_JSON = "{\"agent\":\"worker\",\"artifacts\":false,\"context\":\"fresh\",\"cwd\":\"/repo\",\"model\":\"test/exact\",\"nodeId\":\"node-a\",\"ownerRunId\":\"owner-a\",\"prospectiveRunId\":\"123e4567-e89b-12d3-a456-426614174000\",\"requestId\":\"request-a\",\"result\":{\"kind\":\"structured\",\"schema\":{\"a\":[3,2,1],\"z\":1,\"😀\":true,\"￿\":null}},\"targetServerInstanceId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"task\":\"Do it\",\"thinking\":\"high\",\"version\":1}";

describe("active-bound preflight DTO", () => {
	it("parses a closed request and matches an independent canonical digest vector", () => {
		const parsed = parseActiveBoundPreflightRequest(VECTOR);
		assert.equal(parsed.ok, true);
		assert.equal(activeBoundPreflightRequestDigest(parsed.request), createHash("sha256").update(VECTOR_JSON, "utf8").digest("hex"));
	});

	it("rejects descriptors, prototypes, symbols, cycles, toJSON and unknown fields without invoking code", () => {
		let invoked = 0;
		const getter = { ...VECTOR } as Record<string, unknown>;
		Object.defineProperty(getter, "task", { enumerable: true, get() { invoked++; return "bad"; } });
		assert.deepEqual(parseActiveBoundPreflightRequest(getter), { ok: false, code: "invalid_request" });
		assert.equal(activeBoundPreflightTarget(getter), VECTOR.targetServerInstanceId);
		const targetGetter = { ...VECTOR } as Record<string, unknown>;
		Object.defineProperty(targetGetter, "targetServerInstanceId", { enumerable: true, get() { invoked++; return VECTOR.targetServerInstanceId; } });
		assert.equal(activeBoundPreflightTarget(targetGetter), undefined);
		assert.equal(parseActiveBoundPreflightRequest(targetGetter).ok, false);
		assert.equal(invoked, 0);
		const toJSON = { ...VECTOR, toJSON() { invoked++; return VECTOR; } };
		assert.equal(parseActiveBoundPreflightRequest(toJSON).ok, false);
		assert.equal(invoked, 0);
		assert.equal(parseActiveBoundPreflightRequest(Object.assign(Object.create({}), VECTOR)).ok, false);
		const symbol = { ...VECTOR, [Symbol("x")]: true };
		assert.equal(parseActiveBoundPreflightRequest(symbol).ok, false);
		const cyclic = { ...VECTOR, result: { kind: "structured", schema: {} as Record<string, unknown> } };
		cyclic.result.schema.self = cyclic.result.schema;
		assert.equal(parseActiveBoundPreflightRequest(cyclic).ok, false);
		assert.equal(parseActiveBoundPreflightRequest({ ...VECTOR, extra: true }).ok, false);
		let proxyTrapCalls = 0;
		const proxy = new Proxy({ ...VECTOR }, { ownKeys(target) { proxyTrapCalls++; return Reflect.ownKeys(target); } });
		assert.deepEqual(parseActiveBoundPreflightRequest(proxy), { ok: false, code: "invalid_request" });
		assert.equal(proxyTrapCalls, 0);
	});

	it("normalizes bounded environment ordering and omitted empty objects", () => {
		const left = parseActiveBoundPreflightRequest({ ...VECTOR, environment: { ONECPI_REVIEW_SUBJECT_PATH: "/subject", ONECPI_REVIEW_ROOT: "/root" } });
		const right = parseActiveBoundPreflightRequest({ ...VECTOR, environment: { ONECPI_REVIEW_ROOT: "/root", ONECPI_REVIEW_SUBJECT_PATH: "/subject" } });
		assert.equal(left.ok, true); assert.equal(right.ok, true); if (!left.ok || !right.ok) return;
		assert.equal(activeBoundPreflightRequestDigest(left.request), activeBoundPreflightRequestDigest(right.request));
		const omitted = parseActiveBoundPreflightRequest(VECTOR); const empty = parseActiveBoundPreflightRequest({ ...VECTOR, environment: {} });
		assert.equal(omitted.ok, true); assert.equal(empty.ok, true); if (!omitted.ok || !empty.ok) return;
		assert.deepEqual(empty.request, omitted.request);
		assert.equal(activeBoundPreflightRequestDigest(empty.request), activeBoundPreflightRequestDigest(omitted.request));
	});

	it("requires RFC4122 UUID, fresh, exact provider/id, explicit thinking, false artifacts and closed bounds", () => {
		for (const mutation of [
			{ targetServerInstanceId: "not-a-uuid" }, { prospectiveRunId: "not-a-uuid" }, { context: "fork" }, { model: "exact" }, { model: "p/m:high" }, { model: `p/${"a".repeat(1023)}` },
			{ thinking: undefined }, { artifacts: true }, { timeoutMs: 0 }, { turnBudget: { maxTurns: 0 } },
			{ toolBudget: { hard: 1, soft: 2 } }, { result: { kind: "text", schema: {} } },
			{ requestId: "x".repeat(257) },
		]) assert.equal(parseActiveBoundPreflightRequest({ ...VECTOR, ...mutation }).ok, false);
		assert.equal(parseActiveBoundPreflightRequest({ ...VECTOR, skill: "résumé" }).ok, true);
		assert.equal(parseActiveBoundPreflightRequest({ ...VECTOR, model: "openrouter/openai/gpt-5" }).ok, true);
		assert.equal(parseActiveBoundPreflightRequest({ ...VECTOR, task: "\u0001".repeat(1024 * 1024) }).ok, true);
		assert.equal(parseActiveBoundPreflightRequest({ ...VECTOR, task: "x".repeat(1024 * 1024 + 1) }).ok, false);
		assert.equal(parseActiveBoundPreflightRequest({ ...VECTOR, artifacts: true, artifactDir: "session" }).ok, true);
		for (const artifactMutation of [{ artifacts: true }, { artifacts: false, artifactDir: "session" }, { artifacts: true, artifactDir: "project" }, { artifacts: false, artifactDir: null }]) assert.equal(parseActiveBoundPreflightRequest({ ...VECTOR, ...artifactMutation }).ok, false);
		for (const environment of [{ UNKNOWN: "x" }, { onecpi_review_root: "/root" }, { ONECPI_REVIEW_ROOT: "" }, { ONECPI_REVIEW_ROOT: "x\0y" }, { ONECPI_REVIEW_ROOT: "\ud800" }, { ONECPI_REVIEW_ROOT: "x".repeat(4097) }]) {
			assert.equal(parseActiveBoundPreflightRequest({ ...VECTOR, environment }).ok, false);
		}
	});
});
