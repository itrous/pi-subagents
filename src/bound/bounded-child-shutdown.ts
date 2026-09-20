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
			// Штатно утилизированный ребёнок снимается с учёта: иначе следующая остановка
			// сессии снова звала бы ему abort(), а detached-дети держались бы вечно.
			const ownDispose = child.dispose.bind(child);
			child.dispose = (...args: Parameters<ChildSession["dispose"]>) => {
				live.delete(child);
				return ownDispose(...args);
			};
			return child;
		},
		async dispose() {
			// Same selection as upstream: detached children keep running by contract.
			const children = [...live].filter((child) => !child.detached);
			for (const child of children) live.delete(child);
			for (const child of children) child.shutDown = true;
			// Дедлайн один на всю остановку, а не на каждую фазу: И3.11 обещает возврат в
			// пределах дедлайна, а не трёх подряд.
			const deadline = schedule(deadlineMs);
			const within = async (work: () => Promise<unknown>): Promise<void> => {
				await Promise.race([work(), deadline.promise]);
			};
			try {
				await within(() => Promise.allSettled(children.map((child) => child.abort())));
				// Dispose before returning, not on a later tick: the caller must observe a
				// released child. Собственный dispose ребёнка тоже под дедлайном: у
				// remote-детей он ходит к чужому процессу и не ограничен ничем.
				await within(() => Promise.allSettled(children.map((child) => {
					try { return child.dispose(); } catch { return Promise.resolve(); }
				})));
				// Базовая фабрика держит тех же детей в своём live-наборе и в dispose() снова
				// ждёт их abort() без предела (upstream child-session.ts:386-393). Без этой
				// гонки дедлайн был бы мёртв: остановка сессии всё равно висела бы вечно.
				await within(() => base.dispose());
			} finally {
				deadline.cancel();
			}
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
