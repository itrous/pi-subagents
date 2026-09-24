import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { BOUND_MCP_DISCOVERY_BUDGET, discoverBoundMcp, type BoundMcpAdapterAbi } from "../../src/bound/bound-mcp-direct-bridge.ts";
import { BoundMcpPreparationRegistry, type BoundMcpPreparation } from "../../src/bound/bound-mcp-preparation.ts";

// S3 P2 (D2): discovery never throws and never leaks, the registry decides
// expiry and capacity on its own state. Inputs name the case each rule guards.

const CONFIG = { mcpServers: { s: { command: "node" } } };

test("D2 default discovery limits are 10s + 2s close, 32 pages, 1 MiB and 1024 tools", () => {
	assert.deepEqual(BOUND_MCP_DISCOVERY_BUDGET, { discoveryMs: 10_000, closeMs: 2_000, maxPages: 32, maxMetadataBytes: 1_048_576, maxTools: 1_024 });
});

function fakeAbi(manager: Partial<Record<string, unknown>> & { connect?: () => Promise<unknown> }, throwOnConstruct = false): BoundMcpAdapterAbi {
	class Manager {
		closed = 0;
		constructor() { if (throwOnConstruct) throw new Error("ctor"); Object.assign(this, manager); }
		setRuntimeSignal() {}
		setTraceConfig() {}
		setMetadataListChangedListener() {}
		getConnection() { return undefined; }
		async connect() { return { status: "connected", tools: [] }; }
		async closeAll() { this.closed++; }
	}
	return { McpServerManager: Manager as never, resolveDirectTools: () => [], createDirectToolExecutor: () => async () => ({}) };
}

test("a null tool entry is malformed metadata, not a rejection", async () => {
	const result = await discoverBoundMcp({ abi: fakeAbi({ connect: async () => ({ status: "connected", tools: [null] }) }), config: CONFIG, cwd: "/", selectors: ["s/t"], budget: { closeMs: 50 } });
	assert.deepEqual(result, { ok: false, code: "mcp_metadata_invalid" });
});

for (const [label, abi] of [
	["a throwing manager constructor", fakeAbi({}, true)],
	["a throwing list-changed hook", fakeAbi({ setMetadataListChangedListener() { throw new Error("x"); } })],
	["a throwing connect", fakeAbi({ connect: async () => { throw new Error("down"); } })],
] as const) {
	test(`${label} returns a bounded code and leaves no listener on the caller's signal`, async () => {
		const controller = new AbortController();
		const before = getEventListeners(controller.signal, "abort").length;
		const result = await discoverBoundMcp({ abi, config: CONFIG, cwd: "/", selectors: ["s/t"], signal: controller.signal, budget: { closeMs: 50 } });
		assert.equal(result.ok, false);
		assert.equal(getEventListeners(controller.signal, "abort").length, before);
	});
}

function preparation(ticket: string, closes: string[]): BoundMcpPreparation {
	return {
		ticket, requestId: "r", ownerRunId: "o", nodeId: "n", serverInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		activeSessionDigest: "a".repeat(64),
		close: async () => { closes.push(ticket); return "closed"; },
	} as unknown as BoundMcpPreparation;
}

const release = (ticket: string) => ({ version: 1 as const, targetServerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", activeSessionDigest: "a".repeat(64), requestId: "r", ownerRunId: "o", nodeId: "n", ticket });

test("a release after the monotonic expiry answers absent, before the timer fired", async () => {
	let now = 0;
	const closes: string[] = [];
	const registry = new BoundMcpPreparationRegistry({ clock: () => now, ttlMs: 100 });
	const ticket = "11111111-1111-4111-8111-111111111111";
	assert.equal(registry.reserve(), true);
	registry.unreserve();
	assert.equal(registry.add(preparation(ticket, closes), 1_000_000), true, "the timer is far away");
	now = 2_000_000;
	assert.deepEqual(await registry.release(release(ticket)), { ok: true, status: "absent" });
	assert.deepEqual(closes, [ticket], "the expired preparation is still closed");
	registry.dispose();
});

test("capacity counts admitted preparations until their run closes them", () => {
	const registry = new BoundMcpPreparationRegistry({ capacity: 1 });
	const ticket = "22222222-2222-4222-8222-222222222222";
	const prepared = preparation(ticket, []);
	assert.equal(registry.reserve(), true);
	registry.unreserve();
	assert.equal(registry.add(prepared, registry.now() + 60_000), true);
	assert.equal(registry.claim(ticket, prepared), true);
	assert.equal(registry.reserve(), false, "the admitted run still holds its connections");
	registry.forget(ticket);
	assert.equal(registry.reserve(), true, "positive control: freed once the run closed it");
	registry.dispose();
});

test("a connect that ignores its AbortSignal still ends at the discovery deadline with a bounded code", async () => {
	const started = performance.now();
	const result = await discoverBoundMcp({ abi: fakeAbi({ connect: () => new Promise(() => {}) }), config: CONFIG, cwd: "/", selectors: ["s/t"], budget: { discoveryMs: 50, closeMs: 50 } });
	assert.deepEqual(result, { ok: false, code: "mcp_discovery_timeout" });
	assert.ok(performance.now() - started < 1_000);
});

test("a release whose close did not finish keeps the ticket and retries the close", async () => {
	const outcomes = ["timeout", "closed"];
	const registry = new BoundMcpPreparationRegistry();
	const ticket = "33333333-3333-4333-8333-333333333333";
	const prepared = { ...preparation(ticket, []), close: async () => outcomes.shift() } as unknown as BoundMcpPreparation;
	registry.reserve(); registry.unreserve();
	registry.add(prepared, registry.now() + 60_000);
	assert.deepEqual(await registry.release(release(ticket)), { ok: false, code: "mcp_release_failed" });
	assert.equal(registry.prepared(ticket), undefined, "a released ticket is never admitted");
	assert.deepEqual(await registry.release(release(ticket)), { ok: true, status: "released" });
	assert.deepEqual(await registry.release(release(ticket)), { ok: true, status: "absent" });
	registry.dispose();
});

test("a tool without description or inputSchema is valid metadata, not a refusal of the whole discovery", async () => {
	const result = await discoverBoundMcp({ abi: fakeAbi({ connect: async () => ({ status: "connected", tools: [{ name: "t" }] }) }), config: CONFIG, cwd: "/", selectors: ["s/t"], budget: { closeMs: 50 } });
	// The fake adapter resolves no direct tool, so the discovery stops one step later.
	assert.deepEqual(result, { ok: false, code: "mcp_selector_unresolved" });
});

test("an admitted preparation whose run-level close fails keeps the capacity slot (fail-closed)", async () => {
	const registry = new BoundMcpPreparationRegistry({ capacity: 1 });
	const ticket = "55555555-5555-4555-8555-555555555555";
	const prepared = { ...preparation(ticket, []), close: async () => "timeout" } as unknown as BoundMcpPreparation;
	assert.equal(registry.reserve(), true);
	registry.unreserve();
	assert.equal(registry.add(prepared, registry.now() + 60_000), true);
	assert.equal(registry.claim(ticket, prepared), true);
	assert.deepEqual(await registry.release(release(ticket)), { ok: true, status: "admitted" }, "release never steals the admitted run");
	assert.equal(await prepared.close(), "timeout");
	assert.equal(registry.reserve(), false, "an unclosed connection cannot be replaced with a new discovery");
	assert.equal(registry.claim(ticket, prepared), false, "the ticket is not reusable");
	registry.dispose();
});

test("a hung discovery closeAll returns a bounded failure and cannot issue a ticket", async () => {
	let closes = 0;
	const abi = fakeAbi({
		connect: async () => ({ status: "connected", tools: [null] }),
		closeAll: () => { closes++; return new Promise<void>(() => {}); },
	});
	const started = performance.now();
	const result = await discoverBoundMcp({ abi, config: CONFIG, cwd: "/", selectors: ["s/t"], budget: { closeMs: 20 } });
	assert.deepEqual(result, { ok: false, code: "mcp_metadata_invalid" });
	assert.equal(closes, 1, "no unbounded retry after losing the failed-discovery manager");
	assert.ok(performance.now() - started < 1_000);
});

test("page, byte and tool-count budgets all refuse metadata without a partial grant", async () => {
	for (const [label, connect, budget] of [
		["pages", function (this: { traceWriter: { write: (event: unknown) => void } }) {
			for (let i = 0; i < 33; i++) this.traceWriter.write({ direction: "outbound", kind: "request", method: "tools/list" });
			return Promise.resolve({ status: "connected", tools: [{ name: "t" }] });
		}, { maxPages: 32 }],
		["bytes", function (this: { traceWriter: { write: (event: unknown) => void } }) {
			this.traceWriter.write({ direction: "inbound", bytes: 1_048_577 });
			return Promise.resolve({ status: "connected", tools: [{ name: "t" }] });
		}, { maxMetadataBytes: 1_048_576 }],
		["tools", async () => ({ status: "connected", tools: Array.from({ length: 1_025 }, (_, i) => ({ name: `t${i}` })) }), { maxTools: 1_024 }],
	] as const) {
		const result = await discoverBoundMcp({ abi: fakeAbi({ connect }), config: CONFIG, cwd: "/", selectors: ["s/t"], budget: { ...budget, closeMs: 30 } });
		assert.deepEqual(result, { ok: false, code: "mcp_metadata_invalid" }, label);
	}
});

test("an expired ticket whose close did not finish is kept, counted, and not reported absent", async () => {
	let now = 0;
	const outcomes = ["timeout", "timeout", "closed"];
	const registry = new BoundMcpPreparationRegistry({ clock: () => now, capacity: 1 });
	const ticket = "44444444-4444-4444-8444-444444444444";
	const prepared = { ...preparation(ticket, []), close: async () => outcomes.shift() } as unknown as BoundMcpPreparation;
	registry.reserve(); registry.unreserve();
	registry.add(prepared, 100);
	now = 200;
	assert.equal(registry.prepared(ticket), undefined, "expired");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(registry.reserve(), false, "its connections may still be open");
	assert.deepEqual(await registry.release(release(ticket)), { ok: false, code: "mcp_release_failed" });
	assert.deepEqual(await registry.release(release(ticket)), { ok: true, status: "absent" });
	assert.equal(registry.reserve(), true, "freed once closed");
	registry.dispose();
});
