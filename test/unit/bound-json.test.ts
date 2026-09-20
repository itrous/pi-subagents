import assert from "node:assert/strict";
import { test } from "node:test";
import { cloneJsonWithinByteLimit as forkClone } from "../../src/bound/bound-json.ts";
import { cloneJsonWithinByteLimit as upstreamClone } from "../../src/slash/delegation-json.ts";
import { createLaunchReceiptService } from "../../src/api/launch-receipt.ts";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const HEX = "a".repeat(64);

function trapRecordingProxy<T extends object>(target: T): { proxy: T; traps: string[] } {
	const traps: string[] = [];
	const proxy = new Proxy(target, {
		get(object, key, receiver) { traps.push(`get:${String(key)}`); return Reflect.get(object, key, receiver); },
		has(object, key) { traps.push(`has:${String(key)}`); return Reflect.has(object, key); },
		ownKeys(object) { traps.push("ownKeys"); return Reflect.ownKeys(object); },
		getOwnPropertyDescriptor(object, key) { traps.push(`gopd:${String(key)}`); return Reflect.getOwnPropertyDescriptor(object, key); },
		getPrototypeOf(object) { traps.push("getPrototypeOf"); return Reflect.getPrototypeOf(object); },
	});
	return { proxy, traps };
}

test("the fork clone rejects a Proxy without invoking a single trap", () => {
	const { proxy, traps } = trapRecordingProxy({ version: 1 });
	assert.deepEqual(forkClone(proxy, 4096), { ok: false, reason: "invalid" });
	assert.deepEqual(traps, []);
	// Positive control: upstream accepts the same input and does invoke traps.
	const upstream = trapRecordingProxy({ version: 1 });
	assert.equal(upstreamClone(upstream.proxy, 4096).ok, true);
	assert.ok(upstream.traps.length > 0);
});

test("a nested Proxy is rejected too, and a plain object still clones", () => {
	const { proxy, traps } = trapRecordingProxy({ inner: true });
	assert.deepEqual(forkClone({ outer: proxy }, 4096), { ok: false, reason: "invalid" });
	assert.deepEqual(traps, []);
	assert.deepEqual(forkClone({ a: 1, b: [1, 2, 3] }, 4096), { ok: true, value: { a: 1, b: [1, 2, 3] }, encodedBytes: 19 });
});

test("untrusted receipts and cancellation tokens supplied as a Proxy do not verify", () => {
	const service = createLaunchReceiptService({ secret: new Uint8Array(32).fill(7), clock: () => 1000 });
	const receipt = service.issue({
		serverInstanceId: UUID, sourceIdentityDigest: HEX, activeSessionDigest: "b".repeat(64),
		prospectiveRunId: UUID, requestDigest: "c".repeat(64), launchContractDigest: "d".repeat(64),
	});
	const token = service.issueCancellation(receipt, { requestId: "r", ownerRunId: "o", nodeId: "n" });
	assert.equal(service.verify(receipt), true);
	assert.equal(service.verifyCancellation(token), true);
	assert.equal(service.verify(new Proxy(receipt, {})), false);
	assert.equal(service.verifyCancellation(new Proxy(token, {})), false);
	service.dispose();
});

test("fork and upstream clones agree on the whole corpus; only a Proxy input diverges", () => {
	const cyclic: Record<string, unknown> = { self: undefined }; cyclic.self = cyclic;
	const accessor = Object.defineProperty({}, "a", { get: () => 1, enumerable: true, configurable: true });
	const sparseArray: unknown[] = [1]; (sparseArray as unknown as Record<string, unknown>).extra = 2;
	const nonEnumerable = Object.defineProperty({}, "hidden", { value: 1, enumerable: false, configurable: true });
	const corpus: Array<{ input: unknown; maxBytes: number }> = [
		{ input: null, maxBytes: 32 },
		{ input: true, maxBytes: 32 },
		{ input: 0, maxBytes: 32 },
		{ input: -0, maxBytes: 32 },
		{ input: Number.POSITIVE_INFINITY, maxBytes: 32 },
		{ input: Number.NaN, maxBytes: 32 },
		{ input: "текст", maxBytes: 32 },
		{ input: "x".repeat(64), maxBytes: 32 },
		{ input: undefined, maxBytes: 32 },
		{ input: () => 1, maxBytes: 32 },
		{ input: Symbol("s"), maxBytes: 32 },
		{ input: 1n, maxBytes: 32 },
		{ input: [], maxBytes: 32 },
		{ input: {}, maxBytes: 32 },
		{ input: [1, [2, [3, [4]]]], maxBytes: 4096 },
		{ input: { a: { b: { c: { d: 1 } } } }, maxBytes: 4096 },
		{ input: { a: undefined }, maxBytes: 4096 },
		{ input: accessor, maxBytes: 4096 },
		{ input: nonEnumerable, maxBytes: 4096 },
		{ input: sparseArray, maxBytes: 4096 },
		{ input: cyclic, maxBytes: 4096 },
		{ input: Object.assign(Object.create(null), { a: 1 }), maxBytes: 4096 },
		{ input: Object.assign(Object.create({ inherited: 1 }), { a: 1 }), maxBytes: 4096 },
		{ input: new Date(0), maxBytes: 4096 },
		{ input: new Map(), maxBytes: 4096 },
		{ input: { [Symbol("s")]: 1 }, maxBytes: 4096 },
		{ input: { a: "x".repeat(100) }, maxBytes: 16 },
		{ input: { a: 1, b: 2, c: 3 }, maxBytes: 1024 },
	];
	for (const { input, maxBytes } of corpus) {
		assert.deepEqual(forkClone(input, maxBytes), upstreamClone(input, maxBytes), `corpus entry #${corpus.findIndex((entry) => Object.is(entry.input, input))}`);
	}
	const proxied = new Proxy({ version: 1 }, {});
	assert.notDeepEqual(forkClone(proxied, 4096), upstreamClone(proxied, 4096));
});
