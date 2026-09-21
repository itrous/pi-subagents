import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BoundBindingsV1 } from "../../src/bound/bound-bindings.ts";
import { BOUND_DENIED_TOOL_REASON, BOUND_RUN_HOOK_NAME, createBoundRunHook } from "../../src/bound/bound-run-hooks.ts";
import { BOUND_DENIED_TOOL_MAX_CALLS, BoundRunRegistryV1 } from "../../src/bound/bound-run-registry.ts";
import type { BoundAuthorizedLaunch } from "../../src/bound/bound-runtime-service.ts";

const PARENT_SESSION_ID = "parent-session-id";

function launch(runId: string, bindings: BoundBindingsV1): BoundAuthorizedLaunch {
	return { request: { prospectiveRunId: runId, bindings }, contract: {}, agent: {}, packageExtensionPaths: [] } as unknown as BoundAuthorizedLaunch;
}

/** One child session: its own handler table and its own session id in `ctx`. */
function childSession(sessionId: string) {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const pi = { on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); } };
	const ctx = { sessionManager: { getSessionId: () => sessionId } };
	return {
		pi: pi as unknown as ExtensionAPI,
		async emit(type: string, fields: Record<string, unknown> = {}): Promise<unknown[]> {
			const results: unknown[] = [];
			for (const handler of handlers.get(type) ?? []) results.push(await handler({ type, ...fields }, ctx));
			return results;
		},
	};
}

function setup(runId: string, bindings: BoundBindingsV1, registry: BoundRunRegistryV1, sessionId: string) {
	assert.ok(registry.open(launch(runId, bindings)));
	const hook = createBoundRunHook({ runId, registry, allowedTools: ["read", "bsl-search"] });
	assert.equal(hook.name, BOUND_RUN_HOOK_NAME);
	const session = childSession(sessionId);
	hook.factory(session.pi);
	return session;
}

test("bindings are published under the child session id from the hook's own session_start", async () => {
	const registry = new BoundRunRegistryV1();
	const session = setup("run-a", { ONECPI_REVIEW_ROOT: "/a" }, registry, "child-a");
	assert.equal(registry.sessionBindingsFor("child-a"), undefined, "nothing is published before session_start");
	await session.emit("session_start", { reason: "startup" });
	assert.deepEqual({ ...registry.sessionBindingsFor("child-a") }, { ONECPI_REVIEW_ROOT: "/a" });
	// Key control: the parent session id is never a key.
	assert.equal(registry.sessionBindingsFor(PARENT_SESSION_ID), undefined);
});

test("two parallel child sessions each read only their own bindings", async () => {
	const registry = new BoundRunRegistryV1();
	const a = setup("run-a", { ONECPI_REVIEW_ROOT: "/a" }, registry, "child-a");
	const b = setup("run-b", { ONECPI_REVIEW_ROOT: "/b", ONECPI_REVIEW_SUBJECT_PATH: "b.bsl" }, registry, "child-b");
	await Promise.all([a.emit("session_start"), b.emit("session_start")]);
	assert.deepEqual({ ...registry.sessionBindingsFor("child-a") }, { ONECPI_REVIEW_ROOT: "/a" });
	assert.deepEqual({ ...registry.sessionBindingsFor("child-b") }, { ONECPI_REVIEW_ROOT: "/b", ONECPI_REVIEW_SUBJECT_PATH: "b.bsl" });
	assert.equal(registry.sessionBindingsFor(PARENT_SESSION_ID), undefined);
});

test("a session id bound to another run is not taken over", async () => {
	const registry = new BoundRunRegistryV1();
	const a = setup("run-a", { ONECPI_REVIEW_ROOT: "/a" }, registry, "same-child");
	const b = setup("run-b", { ONECPI_REVIEW_ROOT: "/b" }, registry, "same-child");
	await a.emit("session_start");
	await b.emit("session_start");
	assert.deepEqual({ ...registry.sessionBindingsFor("same-child") }, { ONECPI_REVIEW_ROOT: "/a" });
});

test("the binding entry is removed at session_shutdown and at run close", async () => {
	const registry = new BoundRunRegistryV1();
	const a = setup("run-a", { ONECPI_REVIEW_ROOT: "/a" }, registry, "child-a");
	await a.emit("session_start");
	await a.emit("session_shutdown");
	assert.equal(registry.sessionBindingsFor("child-a"), undefined);
	const b = setup("run-b", { ONECPI_REVIEW_ROOT: "/b" }, registry, "child-b");
	await b.emit("session_start");
	registry.close("run-b");
	assert.equal(registry.sessionBindingsFor("child-b"), undefined);
});

test("a forbidden tool is blocked with exactly one denial record; an allowed one passes without a record", async () => {
	const registry = new BoundRunRegistryV1();
	const session = setup("run-a", {}, registry, "child-a");
	assert.deepEqual(await session.emit("tool_call", { toolName: "bash", toolCallId: "1", input: {} }), [{ block: true, reason: BOUND_DENIED_TOOL_REASON }]);
	assert.deepEqual(await session.emit("tool_call", { toolName: "read", toolCallId: "2", input: {} }), [undefined]);
	const record = registry.get("run-a")!;
	assert.deepEqual(record.denials.calls, [{ name: "bash", reason: "not_in_contract" }]);
	assert.equal(record.denials.overflow, false);
});

test("denials beyond the cap raise the overflow flag instead of being lost silently", async () => {
	const registry = new BoundRunRegistryV1();
	const session = setup("run-a", {}, registry, "child-a");
	for (let index = 0; index <= BOUND_DENIED_TOOL_MAX_CALLS; index++) {
		assert.deepEqual(await session.emit("tool_call", { toolName: `denied-${index}`, toolCallId: String(index), input: {} }), [{ block: true, reason: BOUND_DENIED_TOOL_REASON }]);
	}
	const record = registry.get("run-a")!;
	assert.equal(record.denials.calls.length, BOUND_DENIED_TOOL_MAX_CALLS);
	assert.equal(record.denials.overflow, true);
});
