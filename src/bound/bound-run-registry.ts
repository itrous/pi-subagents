import { randomUUID } from "node:crypto";
import type { ChildSession } from "../runs/shared/child-session.ts";
import type { BoundBindingsV1 } from "./bound-bindings.ts";
import type { BoundSessionBindingsEntry } from "./bound-session-bindings.ts";
import type { BoundToolShadowingEvidenceV1 } from "./bound-tool-shadowing.ts";
import type { BoundAuthorizedLaunch } from "./bound-runtime-service.ts";
import type { ToolRegistryProjectionV1 } from "./bound-tool-registry-projection.ts";

// Generation-scoped like the other process-global bound registries: a live run
// is visible to every module instance of this build, including a reloaded one.
export const BOUND_RUN_REGISTRY_GLOBAL_KEY = "__piSubagentBoundRunRegistryV1";
export const BOUND_DENIED_TOOL_MAX_CALLS = 128;
/** Far above any plausible number of live foreground controls in one process. */
export const BOUND_PRIVATE_RUN_IDS_CAPACITY = 4096;

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
	| "package_load_error" | "package_mutation" | "policy_mismatch" | "barrier_unavailable" | "mcp_cwd_mismatch"
	| "context_unsupported" | "tool_definition_mismatch"
	| "shadowing_incomplete" | "shadowing_mismatch" | "shadowing_unverified" | "mcp_config_drift";

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
	/** Q3 evidence: the verified replacements, only when the contract grants shadowing. */
	shadowing: BoundToolShadowingEvidenceV1 | undefined;
	/** Set when the run's inputs are revoked (D3): the published evidence no longer changes. */
	sealed = false;

	recordProjection(projection: ToolRegistryProjectionV1): void {
		if (this.sealed) return;
		this.projection ??= projection;
	}

	recordShadowing(evidence: BoundToolShadowingEvidenceV1): void {
		if (this.sealed) return;
		this.shadowing ??= { version: evidence.version, tools: [...evidence.tools], declarations: { ...evidence.declarations } };
	}

	seal(): void {
		this.sealed = true;
	}

	fail(failure: BoundRunFailure): void {
		if (this.sealed) return;
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

	/** Set when the run's inputs are revoked (D3); a sealed list is never appended to. */
	sealed = false;

	seal(): void {
		this.sealed = true;
	}

	record(name: string): void {
		if (this.sealed) return;
		if (this.calls.length >= this.capacity) {
			this.overflow = true;
			return;
		}
		this.calls.push({ name, reason: "not_in_contract" });
	}
}

/** Where the run's one child session is (D3): the disposal handle exists from the start of creation. */
export type BoundChildCreation = "none" | "creating" | "attached" | "late" | "failed";

export interface BoundRunRecord {
	readonly runId: string;
	readonly launch: BoundAuthorizedLaunch;
	readonly bindings: Readonly<BoundBindingsV1>;
	readonly registry: BoundRegistryCollector;
	readonly denials: BoundDenialCollector;
	/** Bound runs are never visible through public surfaces (T3). */
	readonly private: true;
	child: ChildSession | undefined;
	/**
	 * Set by the port once the run's outcome is decided (before a deadline
	 * dispose). A child that appears afterwards is never attached; its factory
	 * disposes it.
	 */
	settled: boolean;
	creation: BoundChildCreation;
	/**
	 * Set by a cancellation (D3): session bindings are withdrawn, the stream
	 * barrier refuses every later provider call, tool calls are blocked and the
	 * MCP bridge refuses; the owner signal aborts in-flight MCP calls.
	 */
	revoked: boolean;
	readonly revocation: AbortController;
	/** The barrier's revocation hook, once the child factory installed the barrier. */
	revokeBarrier: (() => void) | undefined;
}

export class BoundRunRegistryV1 {
	/** 2 since S3 P2: revocation and the creation lifecycle; a version-1 registry of an older build refuses. */
	readonly contractVersion!: 2;
	private readonly runs = new Map<string, BoundRunRecord>();
	private readonly sessionBindings = new Map<string, { runId: string; bindings: Readonly<BoundBindingsV1> }>();
	/**
	 * Every bound run id this process ever opened. Privacy follows these ids, not
	 * the execution record: a detached leaf keeps its control and child after
	 * the executor returned and the record closed.
	 */
	private readonly privateRunIds = new Set<string>();

	constructor() {
		Object.defineProperty(this, "contractVersion", { value: 2, enumerable: false, configurable: false, writable: false });
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
			settled: false,
			creation: "none",
			revoked: false,
			revocation: new AbortController(),
			revokeBarrier: undefined,
		};
		this.runs.set(runId, record);
		this.privateRunIds.delete(runId);
		this.privateRunIds.add(runId);
		// Insertion order: the oldest id whose execution record is closed is evicted
		// first; a run that is still executing never loses its privacy.
		if (this.privateRunIds.size > BOUND_PRIVATE_RUN_IDS_CAPACITY) {
			for (const candidate of this.privateRunIds) {
				if (this.privateRunIds.size <= BOUND_PRIVATE_RUN_IDS_CAPACITY) break;
				if (!this.runs.has(candidate)) this.privateRunIds.delete(candidate);
			}
		}
		return record;
	}

	get(runId: string): BoundRunRecord | undefined {
		return this.runs.get(runId);
	}

	has(runId: string): boolean {
		return this.runs.has(runId);
	}

	isPrivate(runId: string): boolean {
		return this.privateRunIds.has(runId);
	}

	/** The upstream resolver accepts unique prefixes, so a prefix of a bound run names it too. */
	names(target: string): boolean {
		if (!target) return false;
		for (const runId of this.privateRunIds) if (runId.startsWith(target)) return true;
		return false;
	}

	/** The factory announces a creation before it starts one; a settled or revoked run gets none. */
	beginCreate(runId: string): boolean {
		const record = this.runs.get(runId);
		if (!record || record.settled || record.revoked || record.creation !== "none") return false;
		record.creation = "creating";
		return true;
	}

	/** A creation that failed before a child existed. */
	failCreate(runId: string): void {
		const record = this.runs.get(runId);
		if (record && record.creation === "creating") record.creation = "failed";
	}

	attachChild(runId: string, child: ChildSession): boolean {
		const record = this.runs.get(runId);
		if (!record || record.child || record.settled || record.revoked) {
			if (record && record.creation === "creating") record.creation = "late";
			return false;
		}
		record.child = child;
		record.creation = "attached";
		return true;
	}

	/**
	 * D3 revocation, synchronous and idempotent: bindings of every session of the
	 * run are unpublished, the barrier refuses from now on, and the owner signal of
	 * the run's MCP calls aborts. True when the run is known (revoked now or before).
	 */
	revoke(runId: string): boolean {
		const record = this.runs.get(runId);
		if (!record) return false;
		if (record.revoked) return true;
		record.revoked = true;
		for (const [sessionId, entry] of this.sessionBindings) if (entry.runId === runId) this.sessionBindings.delete(sessionId);
		try { record.revokeBarrier?.(); } catch { /* the barrier also checks the flag itself */ }
		record.revocation.abort();
		return true;
	}

	/** Children of live runs, for the bound-layer shutdown (D3). */
	liveChildren(): ChildSession[] {
		return [...this.runs.values()].flatMap((record) => (record.child ? [record.child] : []));
	}

	/** Key is the CHILD session id (fact S4); a session already bound to another run is refused. */
	publishSessionBindings(sessionId: string, runId: string): boolean {
		const record = this.runs.get(runId);
		if (!record || !sessionId || record.revoked) return false;
		const existing = this.sessionBindings.get(sessionId);
		if (existing && existing.runId !== runId) return false;
		this.sessionBindings.set(sessionId, { runId, bindings: record.bindings });
		return true;
	}

	sessionBindingsFor(sessionId: string): Readonly<BoundBindingsV1> | undefined {
		return this.sessionBindings.get(sessionId)?.bindings;
	}

	/** A session's entry only when that session is published for exactly this live run. */
	sessionBindingsForRun(sessionId: string, runId: string): BoundSessionBindingsEntry | undefined {
		const entry = this.sessionBindings.get(sessionId);
		const record = this.runs.get(runId);
		if (!entry || entry.runId !== runId || !record || record.revoked) return undefined;
		return { cwd: record.launch.contract.canonicalCwd, bindings: entry.bindings, valuesDigest: record.launch.contract.bindings.valuesDigest };
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
		if (!marker || !("value" in marker) || marker.value !== 2 || marker.writable !== false || marker.configurable !== false
			|| typeof (existing as BoundRunRegistryV1).open !== "function"
			|| typeof (existing as BoundRunRegistryV1).close !== "function"
			|| typeof (existing as BoundRunRegistryV1).isPrivate !== "function") throw new Error("Incompatible process-global bound run registry.");
		return existing as BoundRunRegistryV1;
	}
	const registry = new BoundRunRegistryV1();
	store[BOUND_RUN_REGISTRY_GLOBAL_KEY] = registry;
	return registry;
}

/**
 * Child-launch seam (S3 P2): the MCP selections handle of a live bound run, for
 * the executor's recheck of the tool plan. Undefined for every other run id,
 * and for a registry of an incompatible build (no bound run of this build exists then).
 */
export function boundMcpSelectionsForRun(runId: string, store?: Record<string, unknown>): unknown {
	let registry: BoundRunRegistryV1;
	try { registry = getBoundRunRegistry(store); } catch { return undefined; }
	return registry.get(runId)?.launch.mcp?.selections;
}

/** T3 privacy check: a bound run answers like an unknown id on every public surface, for as long as it leaves traces. */
export function isPrivateBoundRun(runId: string | undefined, store?: Record<string, unknown>): boolean {
	return typeof runId === "string" && getBoundRunRegistry(store).isPrivate(runId);
}

/**
 * Public view of the executor state for status reads (T2): every read of
 * `foregroundControls` sees a map without bound runs, and
 * `lastForegroundControlId` reads undefined when it names one. Every other read
 * and every write goes to the real object, so budget and session fields never
 * diverge.
 */
export function publicBoundStatusState<T extends { foregroundControls: Map<string, unknown>; lastForegroundControlId?: string | null }>(state: T, store?: Record<string, unknown>): T {
	const registry = getBoundRunRegistry(store);
	return new Proxy(state, {
		get(target, property, receiver) {
			if (property === "foregroundControls") {
				return new Map([...target.foregroundControls].filter(([runId]) => !registry.isPrivate(runId)));
			}
			if (property === "lastForegroundControlId") {
				const latest = target.lastForegroundControlId;
				return typeof latest === "string" && registry.isPrivate(latest) ? undefined : latest;
			}
			return Reflect.get(target, property, receiver);
		},
	});
}

function replaceStrings(value: unknown, from: string, to: string): unknown {
	if (typeof value === "string") return value.replaceAll(from, to);
	if (Array.isArray(value)) return value.map((entry) => replaceStrings(entry, from, to));
	if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceStrings(entry, from, to)]));
	}
	return value;
}

/**
 * T3: a request that targets a bound run (by id, run id, or unique prefix)
 * is executed against a fresh id nothing answers to, and that id is written back
 * to the requested one in the reply. The public answer is therefore exactly the
 * "unknown id" answer for the requested target, and the run is never touched.
 */
export function maskPrivateBoundTarget<T extends { id?: string; runId?: string }>(params: T, store?: Record<string, unknown>): {
	params: T;
	unmask<V>(value: V): V;
	unmaskError(error: unknown): unknown;
} {
	const registry = getBoundRunRegistry(store);
	const hidden = [params.id, params.runId].find((target): target is string => typeof target === "string" && registry.names(target));
	if (hidden === undefined) return { params, unmask: (value) => value, unmaskError: (error) => error };
	const standIn = randomUUID();
	return {
		params: {
			...params,
			...(params.id === hidden ? { id: standIn } : {}),
			...(params.runId === hidden ? { runId: standIn } : {}),
		},
		unmask: (value) => replaceStrings(value, standIn, hidden) as typeof value,
		unmaskError: (error) => {
			if (error instanceof Error) error.message = error.message.replaceAll(standIn, hidden);
			return error;
		},
	};
}
