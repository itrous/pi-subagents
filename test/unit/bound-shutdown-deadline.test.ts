import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createBoundedChildShutdownFactory, installBoundedChildShutdown } from "../../src/bound/bounded-child-shutdown.ts";
import {
	childSessionFactory, disposeChildSessions, setChildSessionFactory,
	type ChildSession, type ChildSessionFactory,
} from "../../src/runs/shared/child-session.ts";

// The shared fixture test/support/fake-child-session.ts is unusable here: its
// abort() resolves immediately (:492), and the case under test is an abort that
// never settles.
interface StuckChild extends ChildSession {
	log: string[];
}

/** Mimics createDefaultChildSessionFactory: dispose() drops the child from `live`. */
function createStuckFactory(options: { detached?: boolean } = {}): { factory: ChildSessionFactory; children: StuckChild[] } {
	const children: StuckChild[] = [];
	const live = new Set<StuckChild>();
	const factory: ChildSessionFactory = {
		async create() {
			const log: string[] = [];
			const child = {
				log,
				subscribe: () => () => {},
				prompt: async () => {},
				steer: async () => {},
				followUp: async () => {},
				abort: () => { log.push("abort"); return new Promise<void>(() => {}); },
				dispose: async () => { log.push("dispose"); live.delete(child); },
				messages: [],
				sessionFile: undefined,
				sessionId: `stuck-${children.length}`,
				modelId: undefined,
				...(options.detached ? { detached: true } : {}),
			} as unknown as StuckChild;
			children.push(child);
			live.add(child);
			return child;
		},
		async dispose() {
			const attached = [...live].filter((child) => !child.detached);
			for (const child of attached) child.shutDown = true;
			await Promise.allSettled(attached.map((child) => child.abort()));
			for (const child of attached) void child.dispose();
		},
	};
	return { factory, children };
}

function immediateDeadline(): { promise: Promise<void>; cancel: () => void } {
	return { promise: Promise.resolve(), cancel: () => {} };
}

afterEach(() => {
	// Restore the process-wide factory exactly as test/integration/nested-async-wait.test.ts does.
	setChildSessionFactory(undefined);
});

test("disposeChildSessions returns within the deadline and disposes before returning", async () => {
	const base = createStuckFactory();
	setChildSessionFactory(base.factory);
	installBoundedChildShutdown({ deadlineMs: 25 });
	const child = await childSessionFactory().create({} as never);
	const started = Date.now();
	await disposeChildSessions();
	const elapsedMs = Date.now() - started;
	assert.ok(elapsedMs < 2_000, `disposeChildSessions took ${elapsedMs} ms`);
	assert.deepEqual((child as StuckChild).log, ["abort", "dispose"]);
	assert.equal((child as StuckChild).shutDown, true);
});

test("without the wrapper the same stub does not meet the deadline", async () => {
	const base = createStuckFactory();
	setChildSessionFactory(base.factory);
	await childSessionFactory().create({} as never);
	const timedOut = Symbol("timed-out");
	const outcome = await Promise.race([
		disposeChildSessions().then(() => "returned"),
		new Promise((resolve) => setTimeout(() => resolve(timedOut), 300)),
	]);
	assert.equal(outcome, timedOut, "the unwrapped factory must hang on an abort that never settles");
});

test("dispose is called before the wrapper returns, not scheduled after it", async () => {
	const base = createStuckFactory();
	const wrapped = createBoundedChildShutdownFactory(base.factory, { scheduleDeadline: immediateDeadline });
	const child = await wrapped.create({} as never) as StuckChild;
	await wrapped.dispose();
	assert.deepEqual(child.log, ["abort", "dispose"]);
	// Positive control: an implementation that defers dispose to a later tick
	// leaves the log without "dispose" at the moment dispose() returns.
	const deferredBase = createStuckFactory();
	const deferred: ChildSessionFactory = {
		create: (launch) => deferredBase.factory.create(launch),
		async dispose() {
			for (const entry of deferredBase.children) { entry.shutDown = true; void entry.abort(); }
			setTimeout(() => { for (const entry of deferredBase.children) void entry.dispose(); }, 0);
		},
	};
	const deferredChild = await deferred.create({} as never) as StuckChild;
	await deferred.dispose();
	assert.deepEqual(deferredChild.log, ["abort"]);
	assert.notDeepEqual(deferredChild.log, child.log);
});

test("the wrapper is transparent for create and idempotent on installation", async () => {
	const base = createStuckFactory();
	setChildSessionFactory(base.factory);
	assert.deepEqual(installBoundedChildShutdown({ deadlineMs: 25 }), { installed: true });
	const installed = childSessionFactory();
	assert.deepEqual(installBoundedChildShutdown({ deadlineMs: 25 }), { installed: false });
	assert.equal(childSessionFactory(), installed, "a second installation must not stack another wrapper");
	const child = await installed.create({} as never);
	assert.equal(child, base.children[0], "create must return the base factory's own object");
});

test("a detached child is left untouched, with the wrapper and without it", async () => {
	const wrappedBase = createStuckFactory({ detached: true });
	setChildSessionFactory(wrappedBase.factory);
	installBoundedChildShutdown({ deadlineMs: 25 });
	const detachedWrapped = await childSessionFactory().create({} as never) as StuckChild;
	await disposeChildSessions();
	assert.deepEqual(detachedWrapped.log, []);
	assert.equal(detachedWrapped.shutDown, undefined);
	setChildSessionFactory(undefined);
	// The same observation against the bare base factory.
	const plainBase = createStuckFactory({ detached: true });
	setChildSessionFactory(plainBase.factory);
	const detachedPlain = await childSessionFactory().create({} as never) as StuckChild;
	await disposeChildSessions();
	assert.deepEqual(detachedPlain.log, []);
	assert.equal(detachedPlain.shutDown, undefined);
	assert.deepEqual(detachedWrapped.log, detachedPlain.log);
});

test("a non-detached child beside a detached one still gets abort, dispose, and shutDown", async () => {
	const base = createStuckFactory();
	const wrapped = createBoundedChildShutdownFactory(base.factory, { scheduleDeadline: immediateDeadline });
	const attached = await wrapped.create({} as never) as StuckChild;
	const detached = await wrapped.create({} as never) as StuckChild;
	detached.detached = true;
	await wrapped.dispose();
	assert.deepEqual(attached.log, ["abort", "dispose"]);
	assert.equal(attached.shutDown, true);
	assert.deepEqual(detached.log, []);
	assert.equal(detached.shutDown, undefined);
});

test("the deadline also bounds the base factory dispose", async () => {
	// Базовая фабрика, которая держит ребёнка в live и после child.dispose():
	// её dispose() снова ждёт abort() без предела — ровно как upstream
	// (child-session.ts:386-393), если ребёнок не снялся с учёта.
	const live = new Set<ChildSession>();
	const base: ChildSessionFactory = {
		async create() {
			const child = {
				subscribe: () => () => {},
				prompt: async () => {},
				steer: async () => {},
				followUp: async () => {},
				abort: () => new Promise<void>(() => {}),
				dispose: async () => {},
				messages: [],
				sessionFile: undefined,
				sessionId: "held",
				modelId: undefined,
			} as unknown as ChildSession;
			live.add(child);
			return child;
		},
		async dispose() {
			await Promise.allSettled([...live].map((child) => child.abort()));
		},
	};
	const wrapper = createBoundedChildShutdownFactory(base, { scheduleDeadline: immediateDeadline });
	await wrapper.create({} as never);
	const settled = await Promise.race([
		wrapper.dispose().then(() => "returned" as const),
		new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
	]);
	assert.equal(settled, "returned");
});
