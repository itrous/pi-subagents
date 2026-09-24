import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
	BOUND_CHANNEL_EVENTS, BOUND_READY_EVENT, BOUND_REQUEST_EVENT, boundReplyEvent,
} from "../../src/bound/channel.ts";
import { registerBoundControlPlane, type BoundControlPlane, type RegisterBoundControlPlaneOptions } from "../../src/bound/index.ts";
import { createBoundFixture, FIXTURE_SERVER_INSTANCE_ID, fixtureSourceIdentity, type BoundFixture } from "../fixtures/bound/harness.ts";

const RFC4122 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

let fixture: BoundFixture;
const planes: BoundControlPlane[] = [];

beforeEach(() => { fixture = createBoundFixture(); });
afterEach(() => {
	while (planes.length) planes.pop()!.stop();
	fixture.cleanup();
});

function createBus() {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
	return {
		on(event: string, handler: (data: unknown) => void) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
		},
		emit(event: string, data: unknown) { emitted.push({ event, data: data as Record<string, unknown> }); },
		async deliver(event: string, data: unknown) {
			for (const handler of [...(handlers.get(event) ?? [])]) await (handler(data) as unknown as Promise<void> | void);
		},
		emitted,
		of(event: string) { return emitted.filter((entry) => entry.event === event).map((entry) => entry.data); },
	};
}

function fakePi(): { on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void; fire(event: string, payload: unknown, ctx: unknown): void; order: string[] } {
	const handlers: Array<{ event: string; handler: (event: unknown, ctx: unknown) => unknown }> = [];
	const order: string[] = [];
	return {
		on(event, handler) { order.push(event); handlers.push({ event, handler }); },
		fire(event, payload, ctx) { for (const entry of handlers) if (entry.event === event) entry.handler(payload, ctx); },
		order,
	};
}

function register(bus: ReturnType<typeof createBus>, overrides: Partial<RegisterBoundControlPlaneOptions> = {}, pi = fakePi()): { plane: BoundControlPlane; pi: ReturnType<typeof fakePi> } {
	const options = fixture.serviceOptions() as unknown as RegisterBoundControlPlaneOptions;
	const plane = registerBoundControlPlane({
		...options,
		pi: pi as unknown as RegisterBoundControlPlaneOptions["pi"],
		events: bus,
		store: {},
		childShutdown: false,
		...overrides,
	});
	planes.push(plane);
	return { plane, pi };
}

test("ping answers exactly once with the declared key set", async () => {
	const bus = createBus();
	const { plane } = register(bus, { serverInstanceId: FIXTURE_SERVER_INSTANCE_ID });
	await bus.deliver(BOUND_REQUEST_EVENT, { version: 2, requestId: "ping-1", method: "ping" });
	const replies = bus.of(boundReplyEvent("ping-1"));
	assert.equal(replies.length, 1);
	const reply = replies[0]!;
	assert.equal(reply.success, true);
	const ping = reply.data as Record<string, unknown>;
	assert.deepEqual(Object.keys(ping).sort(), ["capabilities", "events", "methods", "serverInstanceId", "session", "sourceIdentity", "version"]);
	assert.match(ping.serverInstanceId as string, RFC4122);
	assert.equal(ping.serverInstanceId, plane.serverInstanceId);
	assert.equal(ping.version, 2);
	assert.deepEqual(ping.methods, ["ping", "preflight", "prepareMcp", "releaseMcp"]);
	assert.deepEqual(ping.capabilities, { activeRuntimeIdentity: { version: 2 } });
	assert.deepEqual(ping.events, { ...BOUND_CHANNEL_EVENTS });
	assert.deepEqual(Object.keys(ping.events as object).sort(), ["cancel", "launch", "ready", "replyPrefix", "request", "started", "terminal", "update"]);
	assert.deepEqual(ping.sourceIdentity, fixtureSourceIdentity().available ? fixtureSourceIdentity().sourceIdentity : undefined);
	// Positive control: removing a key makes the very same assertion fail.
	const missing = { ...ping };
	delete missing.capabilities;
	assert.notDeepEqual(Object.keys(missing).sort(), ["capabilities", "events", "methods", "serverInstanceId", "session", "sourceIdentity", "version"]);
});

test("without a source identity the ping is closed and preflight refuses", async () => {
	const bus = createBus();
	register(bus, { resolveSourceIdentity: () => fixtureSourceIdentity(false) });
	await bus.deliver(BOUND_REQUEST_EVENT, { version: 2, requestId: "ping-2", method: "ping" });
	const ping = bus.of(boundReplyEvent("ping-2"))[0]!.data as Record<string, unknown>;
	assert.deepEqual(Object.keys(ping).sort(), ["capabilities", "events", "methods", "serverInstanceId", "session", "sourceIdentityUnavailable", "version"]);
	assert.deepEqual(ping.capabilities, {});
	assert.deepEqual(ping.sourceIdentityUnavailable, { version: 1, reasonCode: "unverified_source" });
	await bus.deliver(BOUND_REQUEST_EVENT, { version: 2, requestId: "pf-1", method: "preflight", params: fixture.request({ targetServerInstanceId: FIXTURE_SERVER_INSTANCE_ID }) });
	assert.deepEqual(bus.of(boundReplyEvent("pf-1")), [{ version: 2, requestId: "pf-1", method: "preflight", success: false, error: { version: 2, code: "unverified_source" } }]);
});

test("the capability of the bound leaf is not announced in this stage", async () => {
	const bus = createBus();
	register(bus);
	await bus.deliver(BOUND_REQUEST_EVENT, { version: 2, requestId: "ping-3", method: "ping" });
	const ping = bus.of(boundReplyEvent("ping-3"))[0]!.data as { capabilities: Record<string, unknown> };
	assert.equal(Object.hasOwn(ping.capabilities, "boundForegroundLeaf"), false);
});

test("a preflight for another responder and a malformed envelope are both silent", async () => {
	const bus = createBus();
	register(bus, { serverInstanceId: FIXTURE_SERVER_INSTANCE_ID });
	await bus.deliver(BOUND_REQUEST_EVENT, { version: 2, requestId: "pf-2", method: "preflight", params: fixture.request({ targetServerInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }) });
	assert.deepEqual(bus.of(boundReplyEvent("pf-2")), []);
	await bus.deliver(BOUND_REQUEST_EVENT, { version: 1, requestId: "pf-3", method: "preflight" });
	await bus.deliver(BOUND_REQUEST_EVENT, { version: 2, requestId: "pf-4", method: "unknown" });
	await bus.deliver(BOUND_REQUEST_EVENT, undefined);
	assert.deepEqual(bus.emitted, bus.emitted.filter((entry) => entry.event === boundReplyEvent("pf-2")));
});

test("a preflight for us answers with the contract on our own target", async () => {
	const bus = createBus();
	register(bus, { serverInstanceId: FIXTURE_SERVER_INSTANCE_ID });
	await bus.deliver(BOUND_REQUEST_EVENT, { version: 2, requestId: "pf-5", method: "preflight", params: fixture.request() });
	const replies = bus.of(boundReplyEvent("pf-5"));
	assert.equal(replies.length, 1);
	assert.equal(replies[0]!.success, true);
	const data = replies[0]!.data as Record<string, unknown>;
	assert.deepEqual(Object.keys(data).sort(), [
		"activeSessionDigest", "canonicalCwd", "cancellationToken", "launchContract", "launchContractDigest",
		"receipt", "requestDigest", "serverInstanceId", "sourceIdentityDigest", "version",
	].sort());
});

test("only one responder answers, and a reload answers with a new identity", async () => {
	const bus = createBus();
	const store: Record<string, unknown> = {};
	// Each generation mints its own identity here, as production does.
	const first = register(bus, { store, serverInstanceId: undefined });
	await bus.deliver(BOUND_REQUEST_EVENT, { version: 2, requestId: "ping-4", method: "ping" });
	assert.equal(bus.of(boundReplyEvent("ping-4")).length, 1);
	const second = register(bus, { store, serverInstanceId: undefined });
	assert.notEqual(second.plane.serverInstanceId, first.plane.serverInstanceId);
	await bus.deliver(BOUND_REQUEST_EVENT, { version: 2, requestId: "ping-5", method: "ping" });
	const replies = bus.of(boundReplyEvent("ping-5"));
	assert.equal(replies.length, 1);
	assert.equal((replies[0]!.data as { serverInstanceId: string }).serverInstanceId, second.plane.serverInstanceId);
	assert.notEqual((replies[0]!.data as { serverInstanceId: string }).serverInstanceId, first.plane.serverInstanceId);
});

test("two generations that were never stopped answer twice: the check can fail", async () => {
	const bus = createBus();
	// Separate stores mean the second registration does not replace the first.
	register(bus, { store: {}, serverInstanceId: undefined });
	register(bus, { store: {}, serverInstanceId: undefined });
	await bus.deliver(BOUND_REQUEST_EVENT, { version: 2, requestId: "ping-6", method: "ping" });
	assert.equal(bus.of(boundReplyEvent("ping-6")).length, 2);
});

test("ready is emitted once per session_start and carries the handler's own context", async () => {
	const bus = createBus();
	const pi = fakePi();
	const staleContext = { ...fixture.context(), cwd: "/stale/cwd" };
	register(bus, { getContext: () => staleContext as never }, pi);
	assert.deepEqual(bus.of(BOUND_READY_EVENT), []);
	const liveContext = fixture.context();
	pi.fire("session_start", { reason: "startup" }, liveContext);
	const ready = bus.of(BOUND_READY_EVENT);
	assert.equal(ready.length, 1);
	assert.deepEqual(ready[0]!.session, { cwd: liveContext.cwd, sessionId: "parent-session-id", sessionFile: liveContext.sessionManager.getSessionFile() });
	// Positive control: the stale context from getContext() must not win.
	assert.notEqual((ready[0]!.session as { cwd: string }).cwd, "/stale/cwd");
	pi.fire("session_start", { reason: "startup" }, liveContext);
	assert.equal(bus.of(BOUND_READY_EVENT).length, 2);
});

test("a stopped generation stops answering on its own identity", async () => {
	const bus = createBus();
	const { plane } = register(bus);
	plane.stop();
	await bus.deliver(BOUND_REQUEST_EVENT, { version: 2, requestId: "ping-7", method: "ping" });
	assert.deepEqual(bus.of(boundReplyEvent("ping-7")), []);
});
