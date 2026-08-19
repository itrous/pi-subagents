import type { SubagentDelegationRequest, SubagentDelegationResponse, SubagentDelegationTerminalResponse } from "../api/delegation.ts";

const DEFAULT_IDENTITY_CAPACITY = 8_192;
const GLOBAL_COORDINATOR_KEY = "__piSubagentStructuredAttemptCoordinatorV1";

type TerminalSink = (terminal: SubagentDelegationResponse) => void;
type AttemptIdentity = Pick<SubagentDelegationRequest, "requestId" | "ownerRunId" | "nodeId">;
type RejectedCommitResult = "committed" | "duplicate_tuple" | "capacity";

interface AttemptRecord {
	tupleKey: string;
	nodeKey: string;
	ownerRuntimeId: string;
	request: AttemptIdentity;
	controller: AbortController;
	stopped: boolean;
	settled: boolean;
	settledPromise: Promise<void>;
	resolveSettled: () => void;
}

export type StructuredAttemptAdmission =
	| { accepted: true; signal: AbortSignal; isRunning: () => boolean; settle: (terminal: SubagentDelegationResponse) => void }
	| { accepted: false; reason: "duplicate_tuple" | "duplicate_node" | "capacity" };

function effectiveTerminal(record: AttemptRecord, terminal: SubagentDelegationResponse): SubagentDelegationResponse {
	const native = terminal as SubagentDelegationTerminalResponse;
	const proofFailure = native.status === "native_tool_registry_mismatch" || native.status === "native_tool_registry_protocol_error" || native.status === "native_denied_tools_protocol_error";
	if ((!record.stopped && !record.controller.signal.aborted) || proofFailure) return terminal;
	return {
		requestId: record.request.requestId, ownerRunId: record.request.ownerRunId, nodeId: record.request.nodeId, status: "cancelled",
		...(native.launchContractDigest ? { launchContractDigest: native.launchContractDigest } : {}),
		...(native.toolRegistry ? { toolRegistry: native.toolRegistry } : {}),
		...(native.toolsMissing ? { toolsMissing: native.toolsMissing } : {}),
		...(native.toolsExtra ? { toolsExtra: native.toolsExtra } : {}),
		...(native.toolRegistryError ? { toolRegistryError: native.toolRegistryError } : {}),
		...(native.deniedToolCalls ? { deniedToolCalls: native.deniedToolCalls } : {}),
		...(native.deniedToolCallsOverflow ? { deniedToolCallsOverflow: true } : {}),
		...(native.deniedToolCallsError ? { deniedToolCallsError: native.deniedToolCallsError } : {}),
		...(native.transportIncomplete ? { transportIncomplete: true } : {}),
	};
}

export class StructuredAttemptCoordinator {
	readonly contractVersion = 2 as const;
	private readonly attemptsByTuple = new Map<string, AttemptRecord>();
	private readonly nodeOwners = new Map<string, AttemptRecord>();
	private readonly terminalOutbox: Array<{ record: AttemptRecord; terminal: SubagentDelegationResponse }> = [];
	private readonly drainingByRuntime = new Map<string, Set<Promise<void>>>();
	private readonly settledTuples = new Set<string>();
	private identitySaturated = false;
	private activeSink: { runtimeId: string; sink: TerminalSink } | undefined;
	private readonly identityCapacity: number;

	constructor(identityCapacity = DEFAULT_IDENTITY_CAPACITY) {
		this.identityCapacity = identityCapacity;
	}

	static tupleKey(requestId: string, ownerRunId: string, nodeId: string): string {
		return JSON.stringify([requestId, ownerRunId, nodeId]);
	}

	static nodeKey(ownerRunId: string, nodeId: string): string {
		return JSON.stringify([ownerRunId, nodeId]);
	}

	admit(request: SubagentDelegationRequest, ownerRuntimeId: string): StructuredAttemptAdmission {
		const tupleKey = StructuredAttemptCoordinator.tupleKey(request.requestId, request.ownerRunId, request.nodeId);
		if (this.attemptsByTuple.has(tupleKey) || this.settledTuples.has(tupleKey)) {
			return { accepted: false, reason: "duplicate_tuple" };
		}
		const nodeKey = StructuredAttemptCoordinator.nodeKey(request.ownerRunId, request.nodeId);
		if (this.nodeOwners.has(nodeKey)) return { accepted: false, reason: "duplicate_node" };
		if (this.identitySaturated || this.attemptsByTuple.size + this.settledTuples.size >= this.identityCapacity) {
			this.identitySaturated = true;
			return { accepted: false, reason: "capacity" };
		}
		let resolveSettled!: () => void;
		const settledPromise = new Promise<void>((resolve) => { resolveSettled = resolve; });
		const record: AttemptRecord = {
			tupleKey,
			nodeKey,
			ownerRuntimeId,
			request,
			controller: new AbortController(),
			stopped: false,
			settled: false,
			settledPromise,
			resolveSettled,
		};
		this.attemptsByTuple.set(tupleKey, record);
		this.nodeOwners.set(nodeKey, record);
		return {
			accepted: true,
			signal: record.controller.signal,
			isRunning: () => !record.settled && this.attemptsByTuple.get(record.tupleKey) === record,
			settle: (terminal) => this.settle(record, terminal),
		};
	}

	commitRejected(request: AttemptIdentity, ownerRuntimeId: string, terminal: SubagentDelegationResponse): RejectedCommitResult {
		const tupleKey = StructuredAttemptCoordinator.tupleKey(request.requestId, request.ownerRunId, request.nodeId);
		if (this.attemptsByTuple.has(tupleKey) || this.settledTuples.has(tupleKey)) return "duplicate_tuple";
		if (this.identitySaturated || this.attemptsByTuple.size + this.settledTuples.size >= this.identityCapacity) {
			this.identitySaturated = true;
			return "capacity";
		}
		let resolveSettled!: () => void;
		const record: AttemptRecord = {
			tupleKey,
			nodeKey: StructuredAttemptCoordinator.nodeKey(request.ownerRunId, request.nodeId),
			ownerRuntimeId,
			request,
			controller: new AbortController(),
			stopped: false,
			settled: false,
			settledPromise: new Promise<void>((resolve) => { resolveSettled = resolve; }),
			resolveSettled: () => resolveSettled(),
		};
		this.attemptsByTuple.set(tupleKey, record);
		this.settle(record, terminal);
		return "committed";
	}

	cancel(requestId: string, ownerRunId: string, nodeId: string): boolean {
		const record = this.attemptsByTuple.get(StructuredAttemptCoordinator.tupleKey(requestId, ownerRunId, nodeId));
		if (!record || record.settled) return false;
		record.controller.abort();
		return true;
	}

	stopOwner(ownerRuntimeId: string): void {
		let draining = this.drainingByRuntime.get(ownerRuntimeId);
		for (const record of this.attemptsByTuple.values()) {
			if (record.ownerRuntimeId !== ownerRuntimeId || record.settled) continue;
			record.stopped = true;
			record.controller.abort();
			draining ??= new Set<Promise<void>>();
			draining.add(record.settledPromise);
			void record.settledPromise.finally(() => {
				draining?.delete(record.settledPromise);
				if (draining?.size === 0) this.drainingByRuntime.delete(ownerRuntimeId);
			});
		}
		if (draining?.size) this.drainingByRuntime.set(ownerRuntimeId, draining);
	}

	activateSink(runtimeId: string, sink: TerminalSink): void {
		this.activeSink = { runtimeId, sink };
		this.flush();
	}

	deactivateSink(runtimeId: string): void {
		if (this.activeSink?.runtimeId === runtimeId) this.activeSink = undefined;
	}

	async drainOwner(ownerRuntimeId: string): Promise<void> {
		await Promise.all([...(this.drainingByRuntime.get(ownerRuntimeId) ?? [])]);
	}

	hasDrainingOwner(ownerRuntimeId: string): boolean {
		return (this.drainingByRuntime.get(ownerRuntimeId)?.size ?? 0) > 0;
	}

	/** Test-only bounded state projection; contains no request payloads. */
	snapshot(): { attempts: number; nodes: number; pending: number; settled: number; activeRuntimeId?: string } {
		return {
			attempts: this.attemptsByTuple.size,
			nodes: this.nodeOwners.size,
			pending: this.terminalOutbox.length,
			settled: this.settledTuples.size,
			...(this.activeSink ? { activeRuntimeId: this.activeSink.runtimeId } : {}),
		};
	}

	private settle(record: AttemptRecord, terminal: SubagentDelegationResponse): void {
		if (record.settled || this.attemptsByTuple.get(record.tupleKey) !== record) return;
		record.settled = true;
		const projected = effectiveTerminal(record, terminal);
		record.resolveSettled();
		this.terminalOutbox.push({ record, terminal: projected });
		this.flush();
	}

	private flush(): void {
		const active = this.activeSink;
		if (!active) return;
		while (this.terminalOutbox.length > 0 && this.activeSink === active) {
			const pending = this.terminalOutbox.shift();
			if (!pending) break;
			const { record, terminal } = pending;
			// Commit delivery before invoking arbitrary listeners. This both enables
			// synchronous node reuse and prevents replay when a later listener throws.
			this.attemptsByTuple.delete(record.tupleKey);
			if (this.nodeOwners.get(record.nodeKey) === record) this.nodeOwners.delete(record.nodeKey);
			this.settledTuples.add(record.tupleKey);
			try {
				active.sink(terminal);
			} catch {
				// A delivery attempt is exactly once even when an event listener throws.
			}
		}
	}
}

export function getStructuredAttemptCoordinator(): StructuredAttemptCoordinator {
	const store = globalThis as Record<string, unknown>;
	const existing = store[GLOBAL_COORDINATOR_KEY];
	if (existing instanceof StructuredAttemptCoordinator) return existing;
	// Across extension reloads the previous class identity can differ. Preserve any
	// coordinator implementing the exact process-wide contract instead of replacing it.
	if (existing && typeof existing === "object"
		&& typeof (existing as StructuredAttemptCoordinator).admit === "function"
		&& typeof (existing as StructuredAttemptCoordinator).activateSink === "function") {
		const legacy = existing as { contractVersion?: number; settle?: (record: AttemptRecord, terminal: SubagentDelegationResponse) => void };
		if (legacy.contractVersion !== 2) {
			const originalSettle = legacy.settle;
			if (typeof originalSettle !== "function") throw new Error("Incompatible process-global structured attempt coordinator.");
			legacy.settle = function (this: unknown, record: AttemptRecord, terminal: SubagentDelegationResponse) {
				const projected = effectiveTerminal(record, terminal);
				const stopped = record.stopped; const controller = record.controller;
				if (stopped || controller.signal.aborted) { record.stopped = false; record.controller = new AbortController(); }
				try { return originalSettle.call(this, record, projected); }
				finally { record.stopped = stopped; record.controller = controller; }
			};
			Object.defineProperty(legacy, "contractVersion", { value: 2, enumerable: false, configurable: false, writable: false });
		}
		return legacy as unknown as StructuredAttemptCoordinator;
	}
	const coordinator = new StructuredAttemptCoordinator();
	store[GLOBAL_COORDINATOR_KEY] = coordinator;
	return coordinator;
}
