import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { registerSubagentRpcBridge } from "../../src/extension/rpc.ts";
import { createSourceIdentity } from "../../src/extension/source-identity.ts";
import { registerBoundControlPlane, type BoundControlPlane, type RegisterBoundControlPlaneOptions } from "../../src/bound/index.ts";
import { createBoundFixture, FIXTURE_SOURCE_COMMIT, type BoundFixture } from "../fixtures/bound/harness.ts";

/*
 * The predicates below are copied verbatim from the OneCPI A1 client at pin
 * c32663ec7e9f4c3c35456552c1d262eeeb845a60, src/lib/review/a1-readiness.ts:70-74
 * and :213-229. The copy can fall behind the client: the authoritative
 * cross-repository probe is stage A1R.5/A1R.6, not this file.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const A1_REPOSITORY = "https://github.com/itrous/pi-subagents.git";
const A1_RPC_REQUEST = "subagents:rpc:v1:request";
const A1_RPC_REPLY = (requestId: string) => `subagents:rpc:v1:reply:${requestId}`;

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const requiredKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => {
	const actual = Object.keys(value);
	return required.every((key) => actual.includes(key)) && actual.every((key) => required.includes(key) || optional.includes(key));
};
function replyData(value: unknown, requestId: string): Record<string, unknown> | undefined {
	if (!record(value) || !requiredKeys(value, ["version", "requestId", "success", "data"], ["method"])) return undefined;
	if (value.version !== 1 || value.requestId !== requestId || value.success !== true || !record(value.data)) return undefined;
	return value.data;
}

type Probe = { ready: true } | { ready: false; code: string };

function probeA1Ping(replies: unknown[], requestId: string, expectedCommit: string): Probe {
	if (replies.length !== 1) return { ready: false, code: replies.length === 0 ? "no_active_responder" : "multiple_active_responders" };
	const data = replyData(replies[0], requestId);
	if (!data || !requiredKeys(data, ["serverInstanceId", "sourceIdentity", "version", "methods", "capabilities", "events", "session"])) {
		return { ready: false, code: "malformed_ping" };
	}
	if (typeof data.serverInstanceId !== "string" || !UUID.test(data.serverInstanceId) || data.version !== 1 || !Array.isArray(data.methods) || !data.methods.includes("preflight")) {
		return { ready: false, code: "unsupported_ping" };
	}
	const source = data.sourceIdentity;
	if (!record(source) || !requiredKeys(source, ["version", "kind", "repository", "commit", "digest"]) || source.version !== 1 || source.kind !== "git"
		|| source.repository !== A1_REPOSITORY || source.commit !== expectedCommit || typeof source.digest !== "string" || !HEX64.test(source.digest)) {
		return { ready: false, code: "unverified_source" };
	}
	const capabilities = data.capabilities;
	if (!record(capabilities) || !record(capabilities.boundForegroundLeaf) || (capabilities.boundForegroundLeaf as { version?: unknown }).version !== 1) {
		return { ready: false, code: "unsupported_capability" };
	}
	return { ready: true };
}

let fixture: BoundFixture;
const disposers: Array<() => void> = [];

beforeEach(() => { fixture = createBoundFixture(); });
afterEach(() => {
	while (disposers.length) disposers.pop()!();
	fixture.cleanup();
});

function createBus() {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	return {
		on(event: string, handler: (data: unknown) => void) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
		},
		emit(event: string, data: unknown) { for (const handler of [...(handlers.get(event) ?? [])]) handler(data); },
	};
}

async function runProbe(bus: ReturnType<typeof createBus>, expectedCommit = FIXTURE_SOURCE_COMMIT): Promise<Probe> {
	const requestId = randomUUID();
	const replies: unknown[] = [];
	const off = bus.on(A1_RPC_REPLY(requestId), (value) => { replies.push(value); });
	try {
		bus.emit(A1_RPC_REQUEST, { version: 1, requestId, method: "ping" });
		await new Promise((resolve) => setTimeout(resolve, 20));
	} finally { off(); }
	return probeA1Ping(replies, requestId, expectedCommit);
}

test("the A1 client fails closed with malformed_ping against this build", async () => {
	const bus = createBus();
	const context = fixture.context();
	const upstream = registerSubagentRpcBridge({
		events: bus,
		getContext: () => context as never,
		execute: async () => { throw new Error("not reachable from a ping"); },
		state: { asyncJobs: new Map(), activeRuns: new Map() } as never,
	} as never);
	disposers.push(() => upstream.dispose());
	const plane: BoundControlPlane = registerBoundControlPlane({
		...(fixture.serviceOptions() as unknown as RegisterBoundControlPlaneOptions),
		serverInstanceId: undefined,
		pi: { on() {} } as unknown as RegisterBoundControlPlaneOptions["pi"],
		events: bus,
		store: {},
		childShutdown: false,
	});
	disposers.push(() => plane.stop());
	// Only the upstream v1 bridge answers on that channel; the bound layer does
	// not listen to subagents:rpc:v1:* at all (decision R7).
	assert.deepEqual(await runProbe(bus), { ready: false, code: "malformed_ping" });
});

test("the probe still distinguishes unsupported_capability from malformed_ping", async () => {
	const bus = createBus();
	// A v1 responder that carries every required key and a valid source identity,
	// but announces no bound capability.
	bus.on(A1_RPC_REQUEST, (raw) => {
		const request = raw as { requestId: string; method: string };
		if (request.method !== "ping") return;
		bus.emit(A1_RPC_REPLY(request.requestId), {
			version: 1, requestId: request.requestId, method: "ping", success: true,
			data: {
				serverInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				sourceIdentity: createSourceIdentity(FIXTURE_SOURCE_COMMIT),
				version: 1, methods: ["ping", "preflight"], capabilities: {}, events: {}, session: {},
			},
		});
	});
	assert.deepEqual(await runProbe(bus), { ready: false, code: "unsupported_capability" });
});

test("the bound v2 channel does not answer on the v1 request event", async () => {
	const bus = createBus();
	const plane: BoundControlPlane = registerBoundControlPlane({
		...(fixture.serviceOptions() as unknown as RegisterBoundControlPlaneOptions),
		serverInstanceId: undefined,
		pi: { on() {} } as unknown as RegisterBoundControlPlaneOptions["pi"],
		events: bus,
		store: {},
		childShutdown: false,
	});
	disposers.push(() => plane.stop());
	assert.deepEqual(await runProbe(bus), { ready: false, code: "no_active_responder" });
});
