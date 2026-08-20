import { types as utilTypes } from "node:util";
import type { SubagentDelegationRequest, SubagentDelegationResponse, SubagentDelegationTerminalResponse } from "../api/delegation.ts";

const DEFAULT_IDENTITY_CAPACITY = 8_192;
const GLOBAL_COORDINATOR_KEY = "__piSubagentStructuredAttemptCoordinatorV1";

type TerminalSink = (terminal: SubagentDelegationResponse) => void;
type AttemptIdentity = Pick<SubagentDelegationRequest, "requestId" | "ownerRunId" | "nodeId">;
type RejectedCommitResult = "committed" | "duplicate_tuple" | "capacity";
export type StructuredCancellationAuthority = "legacy" | "bound";

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
	cancellationPolicy: StructuredCancellationAuthority;
	cancellationBindingKey?: string;
}

export type StructuredAttemptAdmission =
	| { accepted: true; signal: AbortSignal; isRunning: () => boolean; settle: (terminal: SubagentDelegationResponse) => void }
	| { accepted: false; reason: "duplicate_tuple" | "duplicate_node" | "capacity" };

export function structuredCancellationBindingKey(binding: SubagentDelegationRequest["binding"]): string | undefined {
	if (!binding) return undefined;
	try {
		const values = [binding.targetServerInstanceId, binding.prospectiveRunId, binding.requestDigest, binding.expectedLaunchContractDigest, binding.cancellationToken?.mac];
		return values.every((value) => typeof value === "string") ? JSON.stringify(values) : "invalid-bound-cancellation-key";
	} catch { return "invalid-bound-cancellation-key"; }
}

function cancellationBindingKeyFromRequest(request: unknown): string | undefined {
	if (!request || typeof request !== "object" || Array.isArray(request) || utilTypes.isProxy(request)) return "invalid-bound-cancellation-key";
	try { const descriptor = Object.getOwnPropertyDescriptor(request, "binding"); return descriptor && "value" in descriptor ? structuredCancellationBindingKey(descriptor.value as SubagentDelegationRequest["binding"]) : descriptor ? "invalid-bound-cancellation-key" : undefined; }
	catch { return "invalid-bound-cancellation-key"; }
}

function cancellationPolicyFromRequest(request: unknown): StructuredCancellationAuthority {
	if (!request || typeof request !== "object" || Array.isArray(request) || utilTypes.isProxy(request)) return "bound";
	try {
		// Parsed unbound requests omit binding. Any own binding descriptor whose
		// meaning is ambiguous (including an accessor or explicit undefined) is
		// conservatively bound without invoking user code.
		return Object.getOwnPropertyDescriptor(request, "binding") === undefined ? "legacy" : "bound";
	} catch {
		return "bound";
	}
}

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
	readonly contractVersion!: 2;
	readonly cancellationContractVersion!: 1;
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
		Object.defineProperties(this, { contractVersion: { value: 2, enumerable: false, configurable: false, writable: false }, cancellationContractVersion: { value: 1, enumerable: false, configurable: false, writable: false } });
	}

	static tupleKey(requestId: string, ownerRunId: string, nodeId: string): string {
		return JSON.stringify([requestId, ownerRunId, nodeId]);
	}

	static nodeKey(ownerRunId: string, nodeId: string): string {
		return JSON.stringify([ownerRunId, nodeId]);
	}

	admit(request: SubagentDelegationRequest, ownerRuntimeId: string, cancellationPolicy = cancellationPolicyFromRequest(request)): StructuredAttemptAdmission {
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
			cancellationPolicy,
			...(cancellationPolicy === "bound" ? { cancellationBindingKey: cancellationBindingKeyFromRequest(request) } : {}),
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
			cancellationPolicy: "bound",
		};
		this.attemptsByTuple.set(tupleKey, record);
		this.settle(record, terminal);
		return "committed";
	}

	cancel(requestId: string, ownerRunId: string, nodeId: string, authority: StructuredCancellationAuthority = "legacy", cancellationBindingKey?: string): boolean {
		const record = this.attemptsByTuple.get(StructuredAttemptCoordinator.tupleKey(requestId, ownerRunId, nodeId));
		if (!record || record.settled || record.cancellationPolicy !== authority || (authority === "bound" && record.cancellationBindingKey !== cancellationBindingKey)) return false;
		record.controller.abort();
		return true;
	}

	canRememberCancellation(requestId: string, ownerRunId: string, nodeId: string): boolean {
		const key = StructuredAttemptCoordinator.tupleKey(requestId, ownerRunId, nodeId);
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

interface LegacyStructuredAttemptCoordinator {
	contractVersion?: number;
	cancellationContractVersion?: number;
	attemptsByTuple?: Map<string, unknown>;
	admit?: (request: SubagentDelegationRequest, ownerRuntimeId: string, cancellationPolicy?: StructuredCancellationAuthority) => StructuredAttemptAdmission;
	cancel?: (requestId: string, ownerRunId: string, nodeId: string, authority?: StructuredCancellationAuthority, cancellationBindingKey?: string) => boolean;
	canRememberCancellation?: (requestId: string, ownerRunId: string, nodeId: string) => boolean;
	settle?: (record: AttemptRecord, terminal: SubagentDelegationResponse) => void;
	activateSink?: (runtimeId: string, sink: TerminalSink) => void;
}

function compatibleMethodTarget(target: object, name: "admit" | "cancel" | "canRememberCancellation"): boolean {
	const own = Object.getOwnPropertyDescriptor(target, name);
	return own === undefined
		? Object.isExtensible(target)
		: "value" in own && own.writable === true && (own.configurable === true || own.enumerable === false);
}

function coordinatorMarkerIsExact(legacy: LegacyStructuredAttemptCoordinator): boolean {
	let descriptor: PropertyDescriptor | undefined;
	try { descriptor = Object.getOwnPropertyDescriptor(legacy, "contractVersion"); } catch { return false; }
	return Boolean(descriptor && "value" in descriptor && descriptor.value === 2 && descriptor.writable === false && descriptor.configurable === false);
}

function coordinatorMarkerCanFreeze(legacy: LegacyStructuredAttemptCoordinator): boolean {
	let descriptor: PropertyDescriptor | undefined;
	try { descriptor = Object.getOwnPropertyDescriptor(legacy, "contractVersion"); } catch { return false; }
	return Boolean(descriptor && "value" in descriptor && descriptor.value === 2
		&& (descriptor.configurable === true || (descriptor.configurable === false && descriptor.writable === false)));
}

function cancellationMarkerIsExact(legacy: LegacyStructuredAttemptCoordinator): boolean {
	let descriptor: PropertyDescriptor | undefined;
	try { descriptor = Object.getOwnPropertyDescriptor(legacy, "cancellationContractVersion"); } catch { return false; }
	return Boolean(descriptor && "value" in descriptor && descriptor.value === 1 && descriptor.writable === false && descriptor.configurable === false);
}

function validateCancellationContract(legacy: LegacyStructuredAttemptCoordinator): void {
	if (utilTypes.isProxy(legacy) || !coordinatorMarkerIsExact(legacy) || !cancellationMarkerIsExact(legacy) || !(legacy.attemptsByTuple instanceof Map) || !((legacy as { settledTuples?: unknown }).settledTuples instanceof Set)
		|| typeof legacy.admit !== "function" || typeof legacy.cancel !== "function" || typeof legacy.canRememberCancellation !== "function") {
		throw new Error("Incompatible process-global structured attempt cancellation coordinator.");
	}
}

function upgradeCancellationContract(legacy: LegacyStructuredAttemptCoordinator): void {
	let marker: PropertyDescriptor | undefined;
	try { marker = Object.getOwnPropertyDescriptor(legacy, "cancellationContractVersion"); }
	catch { throw new Error("Incompatible process-global structured attempt cancellation coordinator."); }
	if (marker !== undefined) {
		if (!cancellationMarkerIsExact(legacy)) throw new Error("Incompatible process-global structured attempt cancellation coordinator.");
		validateCancellationContract(legacy);
		return;
	}
	if (utilTypes.isProxy(legacy) || !coordinatorMarkerCanFreeze(legacy) || !(legacy.attemptsByTuple instanceof Map) || !((legacy as { settledTuples?: unknown }).settledTuples instanceof Set)
		|| typeof legacy.admit !== "function" || typeof legacy.cancel !== "function"
		|| !Object.isExtensible(legacy) || !compatibleMethodTarget(legacy, "admit") || !compatibleMethodTarget(legacy, "cancel") || !compatibleMethodTarget(legacy, "canRememberCancellation")) {
		throw new Error("Incompatible process-global structured attempt cancellation coordinator.");
	}
	const policies = new WeakMap<object, StructuredCancellationAuthority>(); const bindingKeys = new WeakMap<object, string>();
	for (const record of legacy.attemptsByTuple.values()) {
		if (!record || typeof record !== "object") throw new Error("Incompatible process-global structured attempt cancellation record.");
		const request = (record as { request?: SubagentDelegationRequest }).request; const policy = cancellationPolicyFromRequest(request); policies.set(record, policy); const bindingKey = policy === "bound" ? cancellationBindingKeyFromRequest(request) : undefined; if (bindingKey) bindingKeys.set(record, bindingKey);
	}
	const attempts = legacy.attemptsByTuple;
	const originalAdmit = legacy.admit;
	const originalCancel = legacy.cancel;
	const admit = function (this: unknown, request: SubagentDelegationRequest, ownerRuntimeId: string, requestedPolicy?: StructuredCancellationAuthority): StructuredAttemptAdmission {
		const policy = requestedPolicy === "bound" || requestedPolicy === "legacy" ? requestedPolicy : cancellationPolicyFromRequest(request);
		const admitted = originalAdmit.call(this, request, ownerRuntimeId);
		if (admitted.accepted) {
			const record = attempts.get(StructuredAttemptCoordinator.tupleKey(request.requestId, request.ownerRunId, request.nodeId));
			if (!record || typeof record !== "object") {
				originalCancel.call(this, request.requestId, request.ownerRunId, request.nodeId);
				throw new Error("Incompatible process-global structured attempt admission record.");
			}
			policies.set(record, policy); const bindingKey = policy === "bound" ? cancellationBindingKeyFromRequest(request) : undefined; if (bindingKey) bindingKeys.set(record, bindingKey);
		}
		return admitted;
	};
	const cancel = function (this: unknown, requestId: string, ownerRunId: string, nodeId: string, authority: StructuredCancellationAuthority = "legacy", cancellationBindingKey?: string): boolean {
		if (authority !== "legacy" && authority !== "bound") return false;
		const record = attempts.get(StructuredAttemptCoordinator.tupleKey(requestId, ownerRunId, nodeId));
		if (!record || typeof record !== "object" || policies.get(record) !== authority || (authority === "bound" && bindingKeys.get(record) !== cancellationBindingKey)) return false;
		return originalCancel.call(this, requestId, ownerRunId, nodeId);
	};
	const canRememberCancellation = function (this: unknown, requestId: string, ownerRunId: string, nodeId: string): boolean {
		const key = StructuredAttemptCoordinator.tupleKey(requestId, ownerRunId, nodeId);
		const settled = (this as { settledTuples?: Set<string> }).settledTuples;
		return !attempts.has(key) && settled instanceof Set && !settled.has(key);
	};
	// All compatibility checks and existing-record classifications happen first.
	// The immutable marker is defined last in the same descriptor operation, so
	// consumers never observe a published v1 policy with the old methods.
	Object.defineProperties(legacy, {
		contractVersion: { value: 2, enumerable: Object.getOwnPropertyDescriptor(legacy, "contractVersion")?.enumerable ?? false, configurable: false, writable: false },
		admit: { value: admit, enumerable: false, configurable: false, writable: false },
		cancel: { value: cancel, enumerable: false, configurable: false, writable: false },
		canRememberCancellation: { value: canRememberCancellation, enumerable: false, configurable: false, writable: false },
		cancellationContractVersion: { value: 1, enumerable: false, configurable: false, writable: false },
	});
	validateCancellationContract(legacy);
}

/** Final publication barrier: call only after candidate registration can no longer roll back to the old bridge. */
export function prepareStructuredAttemptCoordinator(coordinator: StructuredAttemptCoordinator): void {
	upgradeCancellationContract(coordinator as unknown as LegacyStructuredAttemptCoordinator);
}

export function getStructuredAttemptCoordinator(): StructuredAttemptCoordinator {
	const store = globalThis as Record<string, unknown>;
	const existing = store[GLOBAL_COORDINATOR_KEY];
	if (existing && typeof existing === "object"
		&& typeof (existing as LegacyStructuredAttemptCoordinator).admit === "function"
		&& typeof (existing as LegacyStructuredAttemptCoordinator).activateSink === "function") {
		const legacy = existing as LegacyStructuredAttemptCoordinator;
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
