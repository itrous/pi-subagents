import { childSessionFactory, setChildSessionFactory, type ChildSession, type ChildSessionFactory } from "../runs/shared/child-session.ts";

export const BOUND_CHILD_SHUTDOWN_DEADLINE_MS = 3_000;
const MARKER = Symbol.for("pi-subagents.boundedChildShutdown");

export interface BoundedChildShutdownOptions {
	deadlineMs?: number;
	/** Test seam for the deadline timer; production uses an unref'd `setTimeout`. */
	scheduleDeadline?: (deadlineMs: number) => { promise: Promise<void>; cancel: () => void };
}

function defaultDeadline(deadlineMs: number): { promise: Promise<void>; cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, deadlineMs);
		timer.unref?.();
	});
	return { promise, cancel: () => { if (timer) clearTimeout(timer); } };
}

/**
 * Transparent wrapper around the process-wide child session factory (decision D3).
 * Upstream `factory.dispose()` awaits every `abort()` without a bound; a child
 * whose abort never settles would hang `session_shutdown`. The wrapper adds the
 * deadline and nothing else, so every delegation path keeps its behaviour, and
 * it covers all children, not only bound ones.
 */
export function createBoundedChildShutdownFactory(base: ChildSessionFactory, options: BoundedChildShutdownOptions = {}): ChildSessionFactory {
	const deadlineMs = options.deadlineMs ?? BOUND_CHILD_SHUTDOWN_DEADLINE_MS;
	const schedule = options.scheduleDeadline ?? defaultDeadline;
	const live = new Set<ChildSession>();
	const wrapper: ChildSessionFactory = {
		async create(launch) {
			const child = await base.create(launch);
			live.add(child);
			return child;
		},
		async dispose() {
			// Same selection as upstream: detached children keep running by contract.
			const children = [...live].filter((child) => !child.detached);
			for (const child of children) live.delete(child);
			for (const child of children) child.shutDown = true;
			const deadline = schedule(deadlineMs);
			try {
				await Promise.race([Promise.allSettled(children.map((child) => child.abort())), deadline.promise]);
			} finally {
				deadline.cancel();
			}
			// Dispose before returning, not on a later tick: the caller must observe a
			// released child, and upstream already bounds this step by its own timeout.
			await Promise.allSettled(children.map((child) => {
				try { return child.dispose(); } catch { return Promise.resolve(); }
			}));
			await base.dispose();
		},
	};
	Object.defineProperty(wrapper, MARKER, { value: true, enumerable: false, configurable: false, writable: false });
	return wrapper;
}

function isBounded(factory: ChildSessionFactory | undefined): boolean {
	return Boolean(factory && (factory as unknown as Record<symbol, unknown>)[MARKER] === true);
}

/** Idempotent installation; a second registration never stacks a second wrapper. */
export function installBoundedChildShutdown(options: BoundedChildShutdownOptions = {}): { installed: boolean } {
	const current = childSessionFactory();
	if (isBounded(current)) return { installed: false };
	setChildSessionFactory(createBoundedChildShutdownFactory(current, options));
	return { installed: true };
}
