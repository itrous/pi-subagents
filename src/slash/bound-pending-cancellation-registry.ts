import type { SubagentDelegationBindingV1 } from "../api/delegation.ts";

// V2 deliberately starts empty across the A1.7→A1.8 code-generation boundary:
// pending cancellations are server-generation scoped and must not transfer.
const GLOBAL_KEY = "__piSubagentBoundPendingCancellationRegistryV2";
const CAPACITY = 8192;
interface Entry { key: string; tokenMac: string; requestDigest: string; prospectiveRunId: string; target: string; expiresAt: number }
function key(tuple: { requestId: string; ownerRunId: string; nodeId: string }, binding: SubagentDelegationBindingV1): string { return JSON.stringify([binding.targetServerInstanceId, tuple.requestId, tuple.ownerRunId, tuple.nodeId, binding.cancellationToken.mac]); }
export type BoundPendingCancellationResult = false | "cancelled" | "consumed" | "saturated";

export class BoundPendingCancellationRegistryV1 {
	readonly contractVersion!: 2;
	private entries = new Map<string, Entry>();
	private consumed = new Map<string, { target: string; expiresAt: number }>();
	private saturatedTargets = new Map<string, number>();
	private readonly clock: () => number;
	private readonly capacity: number;
	constructor(clock: () => number = () => Number(process.hrtime.bigint() / 1_000_000n), capacity = CAPACITY) { this.clock = clock; this.capacity = capacity; Object.defineProperty(this, "contractVersion", { value: 2, enumerable: false, configurable: false, writable: false }); }
	private prune(): void { const now = this.clock(); for (const [id, entry] of this.entries) if (now >= entry.expiresAt) this.entries.delete(id); for (const [id, consumed] of this.consumed) if (now >= consumed.expiresAt) this.consumed.delete(id); for (const [target, expiresAt] of this.saturatedTargets) if (now >= expiresAt) this.saturatedTargets.delete(target); }
	remember(tuple: { requestId: string; ownerRunId: string; nodeId: string }, binding: SubagentDelegationBindingV1): boolean {
		this.prune(); const target = binding.targetServerInstanceId; const id = key(tuple, binding); if (this.entries.has(id) || this.consumed.has(id)) return true;
		if (this.entries.size + this.consumed.size >= this.capacity) { this.saturatedTargets.set(target, Math.max(binding.cancellationToken.payload.expiresAt, this.saturatedTargets.get(target) ?? 0)); return false; }
		this.entries.set(id, { key: id, tokenMac: binding.cancellationToken.mac, requestDigest: binding.requestDigest, prospectiveRunId: binding.prospectiveRunId, target, expiresAt: binding.cancellationToken.payload.expiresAt }); return true;
	}
	consume(tuple: { requestId: string; ownerRunId: string; nodeId: string }, binding: SubagentDelegationBindingV1): BoundPendingCancellationResult {
		this.prune(); const id = key(tuple, binding); if (this.consumed.has(id)) return "consumed"; const entry = this.entries.get(id);
		if (entry) { if (entry.tokenMac !== binding.cancellationToken.mac || entry.requestDigest !== binding.requestDigest || entry.prospectiveRunId !== binding.prospectiveRunId || entry.target !== binding.targetServerInstanceId) return false; this.entries.delete(id); this.consumed.set(id, { target: entry.target, expiresAt: entry.expiresAt }); return "cancelled"; }
		return this.saturatedTargets.has(binding.targetServerInstanceId) ? "saturated" : false;
	}
	snapshot(): { pending: number; consumed: number; saturatedTargets: number } { this.prune(); return { pending: this.entries.size, consumed: this.consumed.size, saturatedTargets: this.saturatedTargets.size }; }
}
export function getBoundPendingCancellationRegistry(): BoundPendingCancellationRegistryV1 {
	const global = globalThis as Record<string, unknown>; const existing = global[GLOBAL_KEY];
	if (existing !== undefined) { if (!existing || typeof existing !== "object") throw new Error("Incompatible process-global pending cancellation registry."); const marker = Object.getOwnPropertyDescriptor(existing, "contractVersion"); if (!marker || !("value" in marker) || marker.value !== 2 || marker.writable !== false || marker.configurable !== false || typeof (existing as BoundPendingCancellationRegistryV1).remember !== "function" || typeof (existing as BoundPendingCancellationRegistryV1).consume !== "function") throw new Error("Incompatible process-global pending cancellation registry."); return existing as BoundPendingCancellationRegistryV1; }
	const registry = new BoundPendingCancellationRegistryV1(); global[GLOBAL_KEY] = registry; return registry;
}
