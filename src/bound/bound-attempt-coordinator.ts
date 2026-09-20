import { types as utilTypes } from "node:util";

const DEFAULT_IDENTITY_CAPACITY = 8_192;
// Generation-scoped key: A1 and A1R builds never coexist in one process, so an
// incompatible global is an error at registration, not something to upgrade.
export const BOUND_ATTEMPT_COORDINATOR_GLOBAL_KEY = "__piSubagentBoundAttemptCoordinatorV2";

export interface BoundAttemptIdentity {
	requestId: string;
	ownerRunId: string;
	nodeId: string;
}

export interface BoundTerminal extends BoundAttemptIdentity {
	status: string;
	[key: string]: unknown;
}

type TerminalSink = (terminal: BoundTerminal) => void;

interface AttemptRecord {
	tupleKey: string;
	nodeKey: string;
	ownerRuntimeId: string;
	request: BoundAttemptIdentity;
	controller: AbortController;
	stopped: boolean;
	settled: boolean;
	settledPromise: Promise<void>;
	resolveSettled: () => void;
	cancellationBindingKey: string;
}

export type BoundAttemptAdmission =
	| { accepted: true; signal: AbortSignal; isRunning: () => boolean; settle: (terminal: BoundTerminal) => void }
	| { accepted: false; reason: "duplicate_tuple" | "duplicate_node" | "capacity" };

/** Cancellation authority is always bound in v2: there is no unbound legacy branch. */
export function boundCancellationBindingKey(binding: unknown): string {
	if (!binding || typeof binding !== "object" || Array.isArray(binding) || utilTypes.isProxy(binding)) return "invalid-bound-cancellation-key";
	try {
		const read = (key: string): unknown => {
			const descriptor = Object.getOwnPropertyDescriptor(binding, key);
			return descriptor && "value" in descriptor ? descriptor.value : undefined;
		};
		const token = read("cancellationToken");
		const mac = token && typeof token === "object" && !Array.isArray(token)
			? (Object.getOwnPropertyDescriptor(token, "mac") as PropertyDescriptor | undefined)?.value
			: undefined;
		const values = [read("targetServerInstanceId"), read("prospectiveRunId"), read("requestDigest"), read("expectedLaunchContractDigest"), mac];
		return values.every((value) => typeof value === "string") ? JSON.stringify(values) : "invalid-bound-cancellation-key";
	} catch { return "invalid-bound-cancellation-key"; }
}

function effectiveTerminal(record: AttemptRecord, terminal: BoundTerminal): BoundTerminal {
	if (!record.stopped && !record.controller.signal.aborted) return terminal;
	return { requestId: record.request.requestId, ownerRunId: record.request.ownerRunId, nodeId: record.request.nodeId, status: "cancelled" };
}

export class BoundAttemptCoordinator {
	readonly contractVersion!: 2;
	private readonly attemptsByTuple = new Map<string, AttemptRecord>();
	private readonly nodeOwners = new Map<string, AttemptRecord>();
	private readonly terminalOutbox: Array<{ record: AttemptRecord; terminal: BoundTerminal }> = [];
	private readonly drainingByRuntime = new Map<string, Set<Promise<void>>>();
	private readonly settledTuples = new Set<string>();
	private identitySaturated = false;
	private activeSink: { runtimeId: string; sink: TerminalSink } | undefined;
	private readonly identityCapacity: number;

	constructor(identityCapacity = DEFAULT_IDENTITY_CAPACITY) {
		this.identityCapacity = identityCapacity;
		Object.defineProperty(this, "contractVersion", { value: 2, enumerable: false, configurable: false, writable: false });
	}

	static tupleKey(requestId: string, ownerRunId: string, nodeId: string): string {
		return JSON.stringify([requestId, ownerRunId, nodeId]);
	}

	static nodeKey(ownerRunId: string, nodeId: string): string {
		return JSON.stringify([ownerRunId, nodeId]);
	}

	admit(request: BoundAttemptIdentity, ownerRuntimeId: string, cancellationBindingKey: string): BoundAttemptAdmission {
		const tupleKey = BoundAttemptCoordinator.tupleKey(request.requestId, request.ownerRunId, request.nodeId);
		if (this.attemptsByTuple.has(tupleKey) || this.settledTuples.has(tupleKey)) return { accepted: false, reason: "duplicate_tuple" };
		const nodeKey = BoundAttemptCoordinator.nodeKey(request.ownerRunId, request.nodeId);
		if (this.nodeOwners.has(nodeKey)) return { accepted: false, reason: "duplicate_node" };
		if (this.identitySaturated || this.attemptsByTuple.size + this.settledTuples.size >= this.identityCapacity) {
			this.identitySaturated = true;
			return { accepted: false, reason: "capacity" };
		}
		let resolveSettled!: () => void;
		const settledPromise = new Promise<void>((resolve) => { resolveSettled = resolve; });
		const record: AttemptRecord = {
			tupleKey, nodeKey, ownerRuntimeId,
			request: { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId },
			controller: new AbortController(), stopped: false, settled: false, settledPromise, resolveSettled,
			cancellationBindingKey,
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

	/** Publish a terminal for an identity that was never admitted, exactly once. */
	commitRejected(request: BoundAttemptIdentity, ownerRuntimeId: string, terminal: BoundTerminal): "committed" | "duplicate_tuple" | "capacity" {
		const tupleKey = BoundAttemptCoordinator.tupleKey(request.requestId, request.ownerRunId, request.nodeId);
		if (this.attemptsByTuple.has(tupleKey) || this.settledTuples.has(tupleKey)) return "duplicate_tuple";
		if (this.identitySaturated || this.attemptsByTuple.size + this.settledTuples.size >= this.identityCapacity) {
			this.identitySaturated = true;
			return "capacity";
		}
		let resolveSettled!: () => void;
		const record: AttemptRecord = {
			tupleKey,
			nodeKey: BoundAttemptCoordinator.nodeKey(request.ownerRunId, request.nodeId),
			ownerRuntimeId,
			request: { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId },
			controller: new AbortController(), stopped: false, settled: false,
			settledPromise: new Promise<void>((resolve) => { resolveSettled = resolve; }),
			resolveSettled: () => resolveSettled(),
			cancellationBindingKey: "invalid-bound-cancellation-key",
		};
		this.attemptsByTuple.set(tupleKey, record);
		this.settle(record, terminal);
		return "committed";
	}

	cancel(requestId: string, ownerRunId: string, nodeId: string, cancellationBindingKey: string): boolean {
		const record = this.attemptsByTuple.get(BoundAttemptCoordinator.tupleKey(requestId, ownerRunId, nodeId));
		if (!record || record.settled || record.cancellationBindingKey !== cancellationBindingKey) return false;
		record.controller.abort();
		return true;
	}

	canRememberCancellation(requestId: string, ownerRunId: string, nodeId: string): boolean {
		const key = BoundAttemptCoordinator.tupleKey(requestId, ownerRunId, nodeId);
		return !this.attemptsByTuple.has(key) && !this.settledTuples.has(key);
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

	/** Test-only bounded state projection; it contains no request payloads. */
	snapshot(): { attempts: number; nodes: number; pending: number; settled: number; activeRuntimeId?: string } {
		return {
			attempts: this.attemptsByTuple.size,
			nodes: this.nodeOwners.size,
			pending: this.terminalOutbox.length,
			settled: this.settledTuples.size,
			...(this.activeSink ? { activeRuntimeId: this.activeSink.runtimeId } : {}),
		};
	}

	private settle(record: AttemptRecord, terminal: BoundTerminal): void {
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
			// Commit delivery before invoking arbitrary listeners: node identity can be
			// reused synchronously, and a throwing listener must not cause a replay.
			this.attemptsByTuple.delete(record.tupleKey);
			if (this.nodeOwners.get(record.nodeKey) === record) this.nodeOwners.delete(record.nodeKey);
			this.settledTuples.add(record.tupleKey);
			try { active.sink(terminal); } catch { /* delivery is exactly once even when a listener throws */ }
		}
	}
}

function compatible(value: unknown): value is BoundAttemptCoordinator {
	if (!value || typeof value !== "object" || utilTypes.isProxy(value)) return false;
	let marker: PropertyDescriptor | undefined;
	try { marker = Object.getOwnPropertyDescriptor(value, "contractVersion"); } catch { return false; }
	if (!marker || !("value" in marker) || marker.value !== 2 || marker.writable !== false || marker.configurable !== false) return false;
	const candidate = value as Partial<BoundAttemptCoordinator>;
	return typeof candidate.admit === "function" && typeof candidate.cancel === "function"
		&& typeof candidate.activateSink === "function" && typeof candidate.canRememberCancellation === "function";
}

export function getBoundAttemptCoordinator(store: Record<string, unknown> = globalThis as Record<string, unknown>): BoundAttemptCoordinator {
	const existing = store[BOUND_ATTEMPT_COORDINATOR_GLOBAL_KEY];
	if (existing !== undefined) {
		if (!compatible(existing)) throw new Error("Incompatible process-global bound attempt coordinator.");
		return existing;
	}
	const coordinator = new BoundAttemptCoordinator();
	store[BOUND_ATTEMPT_COORDINATOR_GLOBAL_KEY] = coordinator;
	return coordinator;
}
