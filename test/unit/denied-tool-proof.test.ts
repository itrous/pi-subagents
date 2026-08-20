import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createDeniedToolCollector, DENIED_TOOL_MAX_FRAME_BYTES, encodeDeniedToolFrame } from "../../src/runs/shared/denied-tool-proof.ts";

const nonce = "a".repeat(64);
async function collect(value: string | Buffer) { const stream = new PassThrough(); const collector = createDeniedToolCollector(stream, nonce); stream.end(value); return collector.result; }
test("denied-tool frame is bounded, nonce-authenticated, and redacted", async () => {
	const encoded = encodeDeniedToolFrame({ version: 1, kind: "denied_tool_calls", calls: [{ tool: "read", reason: "permission_rule" }], overflow: false, proofNonce: nonce });
	assert.ok(encoded); assert.deepEqual(await collect(encoded!), { ok: true, frame: { version: 1, kind: "denied_tool_calls", calls: [{ tool: "read", reason: "permission_rule" }], overflow: false } });
	assert.deepEqual(await collect(encoded!.replace(nonce, "b".repeat(64))), { ok: false, code: "invalid_frame" });
	assert.equal(encodeDeniedToolFrame({ version: 1, kind: "denied_tool_calls", calls: [], overflow: true, proofNonce: nonce }), undefined);
	assert.equal(encoded!.includes("args"), false); assert.equal(encoded!.includes("output"), false);
	const worst = Array.from({ length: 128 }, (_, index) => ({ tool: `${"\u0001".repeat(120)}${index}`, reason: "tool_budget" as const }));
	assert.ok(encodeDeniedToolFrame({ version: 1, kind: "denied_tool_calls", calls: worst, overflow: true, proofNonce: nonce }));
});
test("denied-tool collector rejects second, overflow, and inherited-open frames", async () => {
	const empty = encodeDeniedToolFrame({ version: 1, kind: "denied_tool_calls", calls: [], overflow: false, proofNonce: nonce })!;
	assert.deepEqual(await collect(empty + empty), { ok: false, code: "multiple_frames" });
	assert.deepEqual(await collect(Buffer.alloc(DENIED_TOOL_MAX_FRAME_BYTES + 1)), { ok: false, code: "frame_too_large" });
	assert.deepEqual(await collect(Buffer.from([0xe2])), { ok: false, code: "invalid_frame", partial: true });
	assert.deepEqual(await collect(Buffer.from([0xff, 0x0a])), { ok: false, code: "invalid_frame" });
	const stream = new PassThrough(); const collector = createDeniedToolCollector(stream, nonce); stream.write(empty); collector.finalize();
	assert.deepEqual(await collector.result, { ok: false, code: "invalid_frame", partial: true });
});
