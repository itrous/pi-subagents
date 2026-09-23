import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BoundBindingsV1 } from "../../src/bound/bound-bindings.ts";
import { createBoundPackageEventBus } from "../../src/bound/bound-package-api.ts";
import { boundPackageFactoriesHook } from "../../src/bound/bound-package-loader.ts";
import { createBoundRunHook } from "../../src/bound/bound-run-hooks.ts";
import { BoundRunRegistryV1 } from "../../src/bound/bound-run-registry.ts";
import type { BoundAuthorizedLaunch } from "../../src/bound/bound-runtime-service.ts";
import {
	BOUND_SESSION_BINDINGS_REQUEST_EVENT, boundSessionBindingsReplyEvent, installBoundSessionBindingsResponder,
	type BoundSessionBindingsReplyV1,
} from "../../src/bound/bound-session-bindings.ts";

const DIGEST = (label: string) => label.repeat(64).slice(0, 64);

function launch(runId: string, bindings: BoundBindingsV1, cwd: string): BoundAuthorizedLaunch {
	return {
		request: { prospectiveRunId: runId, bindings },
		contract: { canonicalCwd: cwd, bindings: { valuesDigest: DIGEST(runId.at(-1)!) } },
		agent: {}, packageExtensionPaths: [],
	} as unknown as BoundAuthorizedLaunch;
}

/** One child session of one run: the fork's run hook publishes its bindings on the session's own session_start. */
function childOf(registry: BoundRunRegistryV1, runId: string, sessionId: string, bindings: BoundBindingsV1, cwd = `/work/${runId}`) {
	assert.ok(registry.open(launch(runId, bindings, cwd)));
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const pi = { on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); } } as unknown as ExtensionAPI;
	createBoundRunHook({ runId, registry, allowedTools: ["read"] }).factory(pi);
	const ctx = { sessionManager: { getSessionId: () => sessionId } };
	return {
		async emit(type: string) { for (const handler of handlers.get(type) ?? []) await handler({ type }, ctx); },
	};
}

/** What a consumer does: subscribe to its reply, then emit the request, on the bus its facade exposes. */
function ask(events: ExtensionAPI["events"], request: unknown, requestId = "req-1"): BoundSessionBindingsReplyV1[] {
	const replies: BoundSessionBindingsReplyV1[] = [];
	const off = events.on(boundSessionBindingsReplyEvent(requestId), (data) => { replies.push(data as BoundSessionBindingsReplyV1); });
	events.emit(BOUND_SESSION_BINDINGS_REQUEST_EVENT, request);
	off();
	return replies;
}

test("a published child session reads exactly its own bindings and cwd, synchronously and frozen", async () => {
	const registry = new BoundRunRegistryV1();
	const child = childOf(registry, "run-a", "child-a", { ONECPI_REVIEW_ROOT: "/a", ONECPI_REVIEW_SUBJECT_PATH: "a.bsl" });
	const events = createBoundPackageEventBus();
	installBoundSessionBindingsResponder(events, (sessionId) => registry.sessionBindingsForRun(sessionId, "run-a"));
	assert.deepEqual(ask(events, { version: 1, requestId: "req-1", sessionId: "child-a" }).map((reply) => reply.success), [false], "nothing before session_start");
	await child.emit("session_start");
	const [reply] = ask(events, { version: 1, requestId: "req-1", sessionId: "child-a" });
	assert.deepEqual(reply, {
		version: 1, requestId: "req-1", success: true,
		data: { version: 1, namespace: "onecpi-review/1", sessionId: "child-a", cwd: "/work/run-a", bindings: { ONECPI_REVIEW_ROOT: "/a", ONECPI_REVIEW_SUBJECT_PATH: "a.bsl" }, valuesDigest: DIGEST("a") },
	});
	assert.ok(Object.isFrozen(reply) && reply.success && Object.isFrozen(reply.data.bindings));
});

test("another run's session, the parent session, a shut-down session and a closed run are unknown_session", async () => {
	const registry = new BoundRunRegistryV1();
	const a = childOf(registry, "run-a", "child-a", { ONECPI_REVIEW_ROOT: "/a" });
	const b = childOf(registry, "run-b", "child-b", { ONECPI_REVIEW_ROOT: "/b" });
	await Promise.all([a.emit("session_start"), b.emit("session_start")]);
	const busA = createBoundPackageEventBus();
	const busB = createBoundPackageEventBus();
	installBoundSessionBindingsResponder(busA, (sessionId) => registry.sessionBindingsForRun(sessionId, "run-a"));
	installBoundSessionBindingsResponder(busB, (sessionId) => registry.sessionBindingsForRun(sessionId, "run-b"));
	const code = (bus: ExtensionAPI["events"], sessionId: string) => {
		const [reply] = ask(bus, { version: 1, requestId: "r", sessionId }, "r");
		return reply!.success ? `ok:${reply!.data.bindings.ONECPI_REVIEW_ROOT}` : reply!.error.code;
	};
	// Parallel runs: each bus answers only for its own run.
	assert.deepEqual([code(busA, "child-a"), code(busB, "child-b")], ["ok:/a", "ok:/b"]);
	assert.deepEqual([code(busA, "child-b"), code(busB, "child-a"), code(busA, "parent-session")], ["unknown_session", "unknown_session", "unknown_session"]);
	await a.emit("session_shutdown");
	assert.equal(code(busA, "child-a"), "unknown_session");
	registry.close("run-b");
	assert.equal(code(busB, "child-b"), "unknown_session");
});

test("a malformed request is invalid_request; one without a usable requestId gets no reply at all", () => {
	const registry = new BoundRunRegistryV1();
	const events = createBoundPackageEventBus();
	installBoundSessionBindingsResponder(events, (sessionId) => registry.sessionBindingsForRun(sessionId, "run-a"));
	const accessor = { version: 1, requestId: "req-1", get sessionId() { throw new Error("must not be read"); } };
	for (const [index, request] of [
		{ version: 2, requestId: "req-1", sessionId: "child-a" },
		{ version: 1, requestId: "req-1", sessionId: "child-a", runId: "run-b" },
		{ version: 1, requestId: "req-1" },
		{ version: 1, requestId: "req-1", sessionId: "" },
		{ version: 1, requestId: "req-1", sessionId: "a\nb" },
		{ version: 1, requestId: "req-1", sessionId: 7 },
		accessor,
	].entries()) {
		const replies = ask(events, request);
		assert.equal(replies.length, 1, `request #${index}`);
		assert.deepEqual(replies[0], { version: 1, requestId: "req-1", success: false, error: { version: 1, code: "invalid_request" } });
	}
	const silent: unknown[] = [];
	const off = events.on(boundSessionBindingsReplyEvent("bad id"), (data) => { silent.push(data); });
	for (const request of [{ version: 1, requestId: "bad id", sessionId: "x" }, new Proxy({ version: 1, requestId: "req-1", sessionId: "x" }, {}), null, "request"]) events.emit(BOUND_SESSION_BINDINGS_REQUEST_EVENT, request);
	off();
	assert.deepEqual(silent, []);
});

test("through the package facade: a package tool reads its own session's bindings; the host bus never sees the request", async () => {
	const registry = new BoundRunRegistryV1();
	const child = childOf(registry, "run-a", "child-a", { ONECPI_REVIEW_WORKSPACE_ROOT: "/ws" });
	await child.emit("session_start");
	const hostBus: string[] = [];
	const tools: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> = [];
	const host = {
		events: { emit: (event: string) => hostBus.push(event), on: (event: string) => { hostBus.push(`on:${event}`); return () => {}; } },
		registerTool(tool: { execute: (...args: unknown[]) => Promise<unknown> }) { tools.push(tool); },
		on() {},
	} as unknown as ExtensionAPI;
	const seen: unknown[] = [];
	const consumer = (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "bsl-bindings", label: "b", description: "b", parameters: {},
			execute: async (_id: string, _params: unknown, _signal: unknown, _update: unknown, ctx: { sessionManager: { getSessionId(): string } }) => {
				seen.push(...ask(pi.events, { version: 1, requestId: "tool-1", sessionId: ctx.sessionManager.getSessionId() }, "tool-1"));
				return { content: [], details: {} };
			},
		} as never);
	};
	const hook = boundPackageFactoriesHook([{ path: "/consumer.ts", allowInputRegistrationNoop: false, factory: consumer }], {
		runtimeBuiltins: ["read"], internalTools: [], barrierCommitted: () => false, onViolation: () => {}, onFactoryError: () => {},
		sessionBindings: (sessionId) => registry.sessionBindingsForRun(sessionId, "run-a"),
	});
	await hook.factory(host);
	await tools[0]!.execute("call-1", {}, undefined, undefined, { cwd: "/work/run-a", sessionManager: { getSessionId: () => "child-a" } });
	assert.equal(seen.length, 1);
	assert.deepEqual((seen[0] as { data: { bindings: unknown } }).data.bindings, { ONECPI_REVIEW_WORKSPACE_ROOT: "/ws" });
	assert.deepEqual(hostBus, []);
	// Positive control: without the responder nobody answers on the private bus.
	seen.length = 0;
	const bare = boundPackageFactoriesHook([{ path: "/consumer.ts", allowInputRegistrationNoop: false, factory: consumer }], {
		runtimeBuiltins: ["read"], internalTools: [], barrierCommitted: () => false, onViolation: () => {}, onFactoryError: () => {},
	});
	tools.length = 0;
	await bare.factory(host);
	await tools[0]!.execute("call-2", {}, undefined, undefined, { cwd: "/work/run-a", sessionManager: { getSessionId: () => "child-a" } });
	assert.deepEqual(seen, []);
});
