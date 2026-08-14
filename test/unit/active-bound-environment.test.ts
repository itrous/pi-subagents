import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { activeBoundRequestFromDelegation } from "../../src/api/active-bound-runtime.ts";
import {
	buildActiveBoundSpawnEnvironment,
	parseActiveBoundEnvironment,
	projectActiveBoundEnvironment,
} from "../../src/api/active-bound-environment.ts";

describe("active-bound child environment", () => {
	it("normalizes ordering and projects values without disclosure", () => {
		const a = parseActiveBoundEnvironment({ ONECPI_REVIEW_SUBJECT_PATH: "/subject-😀", ONECPI_REVIEW_ROOT: "/root" });
		const b = parseActiveBoundEnvironment({ ONECPI_REVIEW_ROOT: "/root", ONECPI_REVIEW_SUBJECT_PATH: "/subject-😀" });
		assert.equal(a.ok, true); assert.equal(b.ok, true); if (!a.ok || !b.ok) return;
		assert.deepEqual(a.environment, b.environment);
		const projection = projectActiveBoundEnvironment(a.environment);
		assert.deepEqual(projection.names, ["ONECPI_REVIEW_ROOT", "ONECPI_REVIEW_SUBJECT_PATH"]);
		assert.deepEqual(projection, projectActiveBoundEnvironment(b.environment));
		assert.doesNotMatch(JSON.stringify(projection), /\/root|subject/);
		assert.deepEqual(projectActiveBoundEnvironment(undefined), projectActiveBoundEnvironment({}));
		(Object.prototype as Record<string, unknown>).ONECPI_REVIEW_ROOT = "/prototype";
		try { assert.deepEqual(projectActiveBoundEnvironment({}).names, []); assert.equal(buildActiveBoundSpawnEnvironment({}, {}).ONECPI_REVIEW_ROOT, undefined); }
		finally { delete (Object.prototype as Record<string, unknown>).ONECPI_REVIEW_ROOT; }
		assert.notEqual(projectActiveBoundEnvironment({ ONECPI_REVIEW_ROOT: "/other" }).valuesDigest, projection.valuesDigest);
	});

	it("rejects closed-data, name, Unicode and byte-bound violations", () => {
		let invoked = 0;
		const accessor = Object.defineProperty({}, "ONECPI_REVIEW_ROOT", { enumerable: true, get() { invoked++; return "/root"; } });
		for (const value of [accessor, { unknown: "x" }, { onecpi_review_root: "/root" }, { ONECPI_REVIEW_ROOT: "" }, { ONECPI_REVIEW_ROOT: "x\0y" }, { ONECPI_REVIEW_ROOT: "\ud800" }, { ONECPI_REVIEW_ROOT: "x".repeat(4097) }, Object.create({ ONECPI_REVIEW_ROOT: "/root" })]) {
			assert.equal(parseActiveBoundEnvironment(value).ok, false);
		}
		assert.equal(invoked, 0);
	});

	it("copies the bound wire environment into the admitted request", () => {
		const environment = { ONECPI_REVIEW_ROOT: "/root" } as const;
		const request = activeBoundRequestFromDelegation({ requestId: "r", ownerRunId: "o", nodeId: "n", agent: "worker", task: "task", context: "fresh", cwd: "/repo", model: "test/exact", thinking: "off", environment, artifacts: false, result: { kind: "text" } }, { version: 1, targetServerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", prospectiveRunId: "123e4567-e89b-12d3-a456-426614174000", expectedSourceIdentityDigest: "a".repeat(64), expectedActiveSessionDigest: "b".repeat(64), requestDigest: "c".repeat(64), expectedLaunchContractDigest: "d".repeat(64), receipt: {} as never });
		assert.deepEqual({ ...request.environment }, environment); assert.notEqual(request.environment, environment); assert.equal(Object.getPrototypeOf(request.environment!), null);
	});

	it("builds an isolated case-folded spawn environment without mutating inputs", () => {
		const inherited = Object.assign(Object.create(null), { KEEP: "yes", ONECPI_REVIEW_ROOT: "ambient", Onecpi_Review_Subject_Path: "ambient-case", Pi_Subagent_Test: "poison", pi_intercom_test: "poison", "pi_ſubagent_keep": "unicode" }) as NodeJS.ProcessEnv;
		Object.defineProperty(inherited, "__proto__", { enumerable: true, value: "own-value" });
		const requested = { ONECPI_REVIEW_ROOT: "/request" } as const;
		const beforeInherited = { ...inherited }; const beforeRequested = { ...requested };
		const child = buildActiveBoundSpawnEnvironment(inherited, requested);
		assert.deepEqual(Object.entries(inherited), Object.entries(beforeInherited)); assert.deepEqual(requested, beforeRequested);
		assert.deepEqual(Object.entries(child), [["KEEP", "yes"], ["pi_ſubagent_keep", "unicode"], ["__proto__", "own-value"], ["ONECPI_REVIEW_ROOT", "/request"]]);
		assert.equal(Object.getPrototypeOf(child), null);
	});
});
