import type { ChildSession } from "../runs/shared/child-session.ts";
import type { BoundBindingsV1 } from "./bound-bindings.ts";
import type { BoundAuthorizedLaunch } from "./bound-runtime-service.ts";
import type { ToolRegistryProjectionV1 } from "./bound-tool-registry-projection.ts";

// Generation-scoped like the other process-global bound registries: a live run
// is visible to every module instance of this build, including a reloaded one.
export const BOUND_RUN_REGISTRY_GLOBAL_KEY = "__piSubagentBoundRunRegistryV1";
export const BOUND_DENIED_TOOL_MAX_CALLS = 128;

/**
 * Capability carried on the executor params. A symbol key never reaches
 * `JSON.stringify`, so neither events nor session files carry it, and only a
 * module holding this symbol can mark a launch as bound. The value is the
 * registry key, never the contract itself.
 */
const BOUND_RUN_PARAM = Symbol("pi-subagents:bound-run");

export function markBoundRunParams<T extends object>(params: T, runId: string): T {
	Object.defineProperty(params, BOUND_RUN_PARAM, { value: runId, enumerable: true, configurable: false, writable: false });
	return params;
}

export function boundRunIdOf(params: unknown): string | undefined {
	if (!params || typeof params !== "object") return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(params, BOUND_RUN_PARAM);
	return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
}

export type BoundToolRegistryError =
	| "launch_contract_mismatch" | "compaction_forbidden" | "model_mismatch" | "package_bytes_drift"
	| "package_load_error" | "package_mutation" | "policy_mismatch" | "barrier_unavailable";

/** First recorded failure wins; later ones are consequences of the first. */
export interface BoundRunFailure {
	status: "native_tool_registry_mismatch" | "unavailable_context";
	toolRegistryError?: BoundToolRegistryError;
	toolsMissing?: string[];
	toolsExtra?: string[];
}

export class BoundRegistryCollector {
	projection: ToolRegistryProjectionV1 | undefined;
	failure: BoundRunFailure | undefined;

	recordProjection(projection: ToolRegistryProjectionV1): void {
		this.projection ??= projection;
	}

	fail(failure: BoundRunFailure): void {
		this.failure ??= {
			status: failure.status,
			...(failure.toolRegistryError ? { toolRegistryError: failure.toolRegistryError } : {}),
			...(failure.toolsMissing ? { toolsMissing: [...failure.toolsMissing] } : {}),
			...(failure.toolsExtra ? { toolsExtra: [...failure.toolsExtra] } : {}),
		};
	}
}

export interface BoundDeniedToolCall {
	name: string;
	reason: "not_in_contract";
}

/** Bounded list plus an overflow flag: a loss is marked, never silent. */
export class BoundDenialCollector {
	readonly calls: BoundDeniedToolCall[] = [];
	overflow = false;
	private readonly capacity: number;

	constructor(capacity = BOUND_DENIED_TOOL_MAX_CALLS) {
		this.capacity = capacity;
	}

	record(name: string): void {
		if (this.calls.length >= this.capacity) {
			this.overflow = true;
			return;
		}
		this.calls.push({ name, reason: "not_in_contract" });
	}
}

export interface BoundRunRecord {
	readonly runId: string;
	readonly launch: BoundAuthorizedLaunch;
	readonly bindings: Readonly<BoundBindingsV1>;
	readonly registry: BoundRegistryCollector;
	readonly denials: BoundDenialCollector;
	/** Bound runs are never visible through public surfaces (T3). */
	readonly private: true;
	child: ChildSession | undefined;
}

export class BoundRunRegistryV1 {
	readonly contractVersion!: 1;
	private readonly runs = new Map<string, BoundRunRecord>();
	private readonly sessionBindings = new Map<string, { runId: string; bindings: Readonly<BoundBindingsV1> }>();

	constructor() {
		Object.defineProperty(this, "contractVersion", { value: 1, enumerable: false, configurable: false, writable: false });
	}

	/** Undefined when the run id is already live: two records must never share one key. */
	open(launch: BoundAuthorizedLaunch): BoundRunRecord | undefined {
		const runId = launch.request.prospectiveRunId;
		if (this.runs.has(runId)) return undefined;
		const record: BoundRunRecord = {
			runId,
			launch,
			bindings: Object.freeze({ ...(launch.request.bindings ?? {}) }),
			registry: new BoundRegistryCollector(),
			denials: new BoundDenialCollector(),
			private: true,
			child: undefined,
		};
		this.runs.set(runId, record);
		return record;
	}

	get(runId: string): BoundRunRecord | undefined {
		return this.runs.get(runId);
	}

	has(runId: string): boolean {
		return this.runs.has(runId);
	}

	attachChild(runId: string, child: ChildSession): boolean {
		const record = this.runs.get(runId);
		if (!record || record.child) return false;
		record.child = child;
		return true;
	}

	/** Children of live runs, for the bound-layer shutdown (D3). */
	liveChildren(): ChildSession[] {
		return [...this.runs.values()].flatMap((record) => (record.child ? [record.child] : []));
	}

	/** Key is the CHILD session id (fact S4); a session already bound to another run is refused. */
	publishSessionBindings(sessionId: string, runId: string): boolean {
		const record = this.runs.get(runId);
		if (!record || !sessionId) return false;
		const existing = this.sessionBindings.get(sessionId);
		if (existing && existing.runId !== runId) return false;
		this.sessionBindings.set(sessionId, { runId, bindings: record.bindings });
		return true;
	}

	sessionBindingsFor(sessionId: string): Readonly<BoundBindingsV1> | undefined {
		return this.sessionBindings.get(sessionId)?.bindings;
	}

	unpublishSessionBindings(sessionId: string, runId: string): void {
		if (this.sessionBindings.get(sessionId)?.runId === runId) this.sessionBindings.delete(sessionId);
	}

	close(runId: string): void {
		this.runs.delete(runId);
		for (const [sessionId, entry] of this.sessionBindings) if (entry.runId === runId) this.sessionBindings.delete(sessionId);
	}
}

export function getBoundRunRegistry(store: Record<string, unknown> = globalThis as Record<string, unknown>): BoundRunRegistryV1 {
	const existing = store[BOUND_RUN_REGISTRY_GLOBAL_KEY];
	if (existing !== undefined) {
		if (!existing || typeof existing !== "object") throw new Error("Incompatible process-global bound run registry.");
		const marker = Object.getOwnPropertyDescriptor(existing, "contractVersion");
		if (!marker || !("value" in marker) || marker.value !== 1 || marker.writable !== false || marker.configurable !== false
			|| typeof (existing as BoundRunRegistryV1).open !== "function"
			|| typeof (existing as BoundRunRegistryV1).close !== "function") throw new Error("Incompatible process-global bound run registry.");
		return existing as BoundRunRegistryV1;
	}
	const registry = new BoundRunRegistryV1();
	store[BOUND_RUN_REGISTRY_GLOBAL_KEY] = registry;
	return registry;
}

/** T3 privacy check: a live bound run answers like an unknown id on every public surface. */
export function isPrivateBoundRun(runId: string | undefined, store?: Record<string, unknown>): boolean {
	return typeof runId === "string" && getBoundRunRegistry(store).has(runId);
}
