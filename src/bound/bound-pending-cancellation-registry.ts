import type { BoundBindingV2 } from "./channel.ts";

// V3 deliberately starts empty across the A1.8 -> A1R.3 generation boundary:
// pending cancellations are server-generation scoped and must not transfer.
export const BOUND_PENDING_CANCELLATION_GLOBAL_KEY = "__piSubagentBoundPendingCancellationRegistryV3";
const CAPACITY = 8192;

interface Entry { key: string; tokenMac: string; requestDigest: string; prospectiveRunId: string; target: string; expiresAt: number }

type Tuple = { requestId: string; ownerRunId: string; nodeId: string };

function key(tuple: Tuple, binding: BoundBindingV2): string {
	return JSON.stringify([binding.targetServerInstanceId, tuple.requestId, tuple.ownerRunId, tuple.nodeId, binding.cancellationToken.mac]);
}

export type BoundPendingCancellationResult = false | "cancelled" | "consumed" | "saturated";

export class BoundPendingCancellationRegistryV2 {
	readonly contractVersion!: 3;
	private entries = new Map<string, Entry>();
	private consumed = new Map<string, { target: string; expiresAt: number }>();
	private saturatedTargets = new Map<string, number>();
	private readonly clock: () => number;
	private readonly capacity: number;

	constructor(clock: () => number = () => Number(process.hrtime.bigint() / 1_000_000n), capacity = CAPACITY) {
		this.clock = clock;
		this.capacity = capacity;
		Object.defineProperty(this, "contractVersion", { value: 3, enumerable: false, configurable: false, writable: false });
	}

	private prune(): void {
		const now = this.clock();
		for (const [id, entry] of this.entries) if (now >= entry.expiresAt) this.entries.delete(id);
		for (const [id, consumed] of this.consumed) if (now >= consumed.expiresAt) this.consumed.delete(id);
		for (const [target, expiresAt] of this.saturatedTargets) if (now >= expiresAt) this.saturatedTargets.delete(target);
	}

	remember(tuple: Tuple, binding: BoundBindingV2): boolean {
		this.prune();
		const target = binding.targetServerInstanceId; const id = key(tuple, binding);
		if (this.entries.has(id) || this.consumed.has(id)) return true;
		if (this.entries.size + this.consumed.size >= this.capacity) {
			this.saturatedTargets.set(target, Math.max(binding.cancellationToken.payload.expiresAt, this.saturatedTargets.get(target) ?? 0));
			return false;
		}
		this.entries.set(id, {
			key: id, tokenMac: binding.cancellationToken.mac, requestDigest: binding.requestDigest,
			prospectiveRunId: binding.prospectiveRunId, target, expiresAt: binding.cancellationToken.payload.expiresAt,
		});
		return true;
	}

	consume(tuple: Tuple, binding: BoundBindingV2): BoundPendingCancellationResult {
		this.prune();
		const id = key(tuple, binding);
		if (this.consumed.has(id)) return "consumed";
		const entry = this.entries.get(id);
		if (entry) {
			if (entry.tokenMac !== binding.cancellationToken.mac || entry.requestDigest !== binding.requestDigest
				|| entry.prospectiveRunId !== binding.prospectiveRunId || entry.target !== binding.targetServerInstanceId) return false;
			this.entries.delete(id);
			this.consumed.set(id, { target: entry.target, expiresAt: entry.expiresAt });
			return "cancelled";
		}
		return this.saturatedTargets.has(binding.targetServerInstanceId) ? "saturated" : false;
	}

	snapshot(): { pending: number; consumed: number; saturatedTargets: number } {
		this.prune();
		return { pending: this.entries.size, consumed: this.consumed.size, saturatedTargets: this.saturatedTargets.size };
	}
}

export function getBoundPendingCancellationRegistry(store: Record<string, unknown> = globalThis as Record<string, unknown>): BoundPendingCancellationRegistryV2 {
	const existing = store[BOUND_PENDING_CANCELLATION_GLOBAL_KEY];
	if (existing !== undefined) {
		if (!existing || typeof existing !== "object") throw new Error("Incompatible process-global pending cancellation registry.");
		const marker = Object.getOwnPropertyDescriptor(existing, "contractVersion");
		if (!marker || !("value" in marker) || marker.value !== 3 || marker.writable !== false || marker.configurable !== false
			|| typeof (existing as BoundPendingCancellationRegistryV2).remember !== "function"
			|| typeof (existing as BoundPendingCancellationRegistryV2).consume !== "function") throw new Error("Incompatible process-global pending cancellation registry.");
		return existing as BoundPendingCancellationRegistryV2;
	}
	const registry = new BoundPendingCancellationRegistryV2();
	store[BOUND_PENDING_CANCELLATION_GLOBAL_KEY] = registry;
	return registry;
}
