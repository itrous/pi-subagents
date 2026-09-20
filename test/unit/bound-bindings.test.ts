import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BOUND_BINDING_NAMES, BOUND_BINDINGS_NAMESPACE, parseBoundBindings, projectBoundBindings,
} from "../../src/bound/bound-bindings.ts";

// Closes checklist item 11: this file carries the parser properties that
// test/unit/active-bound-environment.test.ts used to cover before A1R.1 removed it.

test("the onecpi-review/1 namespace is exactly six names", () => {
	assert.deepEqual([...BOUND_BINDING_NAMES], [
		"ONECPI_REVIEW_ROOT",
		"ONECPI_REVIEW_SUBJECT_PATH",
		"ONECPI_REVIEW_WORKSPACE_ROOT",
		"ONECPI_REVIEW_WORKSPACE_SUBJECTS",
		"ONECPI_REVIEW_WORKSPACE_POLICY_DIGEST",
		"ONECPI_REVIEW_WORKSPACE_LOG",
	]);
	assert.equal(BOUND_BINDINGS_NAMESPACE, "onecpi-review/1");
});

test("every allowed name parses and any other key is refused", () => {
	for (const name of BOUND_BINDING_NAMES) {
		const parsed = parseBoundBindings({ [name]: "value" });
		assert.equal(parsed.ok, true);
		assert.deepEqual(parsed.ok ? { ...parsed.bindings } : undefined, { [name]: "value" });
	}
	assert.deepEqual(parseBoundBindings({ PATH: "/usr/bin" }), { ok: false });
	assert.deepEqual(parseBoundBindings({ ONECPI_REVIEW_ROOT: "/a", OTHER: "b" }), { ok: false });
	assert.deepEqual(parseBoundBindings({ onecpi_review_root: "/a" }), { ok: false });
});

test("undefined means no bindings, and hostile shapes fail closed", () => {
	const empty = parseBoundBindings(undefined);
	assert.equal(empty.ok, true);
	assert.deepEqual(empty.ok ? Object.keys(empty.bindings) : undefined, []);
	assert.deepEqual(parseBoundBindings(null), { ok: false });
	assert.deepEqual(parseBoundBindings([]), { ok: false });
	assert.deepEqual(parseBoundBindings("ONECPI_REVIEW_ROOT=/a"), { ok: false });
	assert.deepEqual(parseBoundBindings(new Proxy({ ONECPI_REVIEW_ROOT: "/a" }, {})), { ok: false });
	// A foreign prototype is refused outright rather than silently read as empty.
	assert.deepEqual(parseBoundBindings(Object.create({ ONECPI_REVIEW_ROOT: "/a" })), { ok: false });
	const accessor = Object.defineProperty({}, "ONECPI_REVIEW_ROOT", { get: () => "/a", enumerable: true, configurable: true });
	assert.deepEqual(parseBoundBindings(accessor), { ok: false });
	const nonEnumerable = Object.defineProperty({}, "ONECPI_REVIEW_ROOT", { value: "/a", enumerable: false, configurable: true });
	assert.deepEqual(parseBoundBindings(nonEnumerable), { ok: false });
	assert.deepEqual(parseBoundBindings({ ONECPI_REVIEW_ROOT: 1 }), { ok: false });
});

test("values reject empty, NUL, and broken surrogate pairs", () => {
	assert.deepEqual(parseBoundBindings({ ONECPI_REVIEW_ROOT: "" }), { ok: false });
	assert.deepEqual(parseBoundBindings({ ONECPI_REVIEW_ROOT: "a\0b" }), { ok: false });
	assert.deepEqual(parseBoundBindings({ ONECPI_REVIEW_ROOT: "\ud800" }), { ok: false });
	assert.deepEqual(parseBoundBindings({ ONECPI_REVIEW_ROOT: "\udc00a" }), { ok: false });
	assert.equal(parseBoundBindings({ ONECPI_REVIEW_ROOT: "😀" }).ok, true);
});

test("value and total byte limits are 4 KiB and 8 KiB", () => {
	assert.equal(parseBoundBindings({ ONECPI_REVIEW_ROOT: "x".repeat(4096) }).ok, true);
	assert.deepEqual(parseBoundBindings({ ONECPI_REVIEW_ROOT: "x".repeat(4097) }), { ok: false });
	const twoLarge = { ONECPI_REVIEW_ROOT: "x".repeat(4096), ONECPI_REVIEW_SUBJECT_PATH: "y".repeat(4096) };
	assert.deepEqual(parseBoundBindings(twoLarge), { ok: false });
});

test("the projection is stable and value-sensitive", () => {
	const first = projectBoundBindings({ ONECPI_REVIEW_ROOT: "/a", ONECPI_REVIEW_WORKSPACE_LOG: "/log" });
	const reordered = projectBoundBindings({ ONECPI_REVIEW_WORKSPACE_LOG: "/log", ONECPI_REVIEW_ROOT: "/a" });
	assert.deepEqual(first, reordered);
	assert.deepEqual(first.names, ["ONECPI_REVIEW_ROOT", "ONECPI_REVIEW_WORKSPACE_LOG"]);
	assert.equal(first.namespace, "onecpi-review/1");
	assert.notEqual(first.valuesDigest, projectBoundBindings({ ONECPI_REVIEW_ROOT: "/b", ONECPI_REVIEW_WORKSPACE_LOG: "/log" }).valuesDigest);
	assert.notEqual(first.valuesDigest, projectBoundBindings({ ONECPI_REVIEW_ROOT: "/a" }).valuesDigest);
	assert.equal(projectBoundBindings(undefined).names.length, 0);
	assert.equal(projectBoundBindings(undefined).valuesDigest, projectBoundBindings({}).valuesDigest);
});
