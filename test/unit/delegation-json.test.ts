import assert from "node:assert/strict";
import { test } from "node:test";
import { cloneJsonWithinByteLimit } from "../../src/slash/delegation-json.ts";

test("bounded JSON clone ignores only non-enumerable array extras", () => {
	const value = ["kept"] as unknown[] & { hidden?: string; visible?: string };
	Object.defineProperty(value, "hidden", { value: "ignored", enumerable: false });
	assert.deepEqual(cloneJsonWithinByteLimit(value, 1024, { ignoreNonEnumerable: true }), { ok: true, value: ["kept"], encodedBytes: 8 });
	Object.defineProperty(value, "visible", { value: "rejected", enumerable: true });
	assert.deepEqual(cloneJsonWithinByteLimit(value, 1024, { ignoreNonEnumerable: true }), { ok: false, reason: "invalid" });
});
