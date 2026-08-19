import type { SubagentDelegationBindingV1 } from "../api/delegation.ts";

const GLOBAL_KEY = "__piSubagentBoundPendingCancellationRegistryV1";
const CAPACITY = 8192;
interface Entry { key: string; tokenMac: string; requestDigest: string; prospectiveRunId: string; target: string; expiresAt: number }
function key(tuple: { requestId: string; ownerRunId: string; nodeId: string }, binding: SubagentDelegationBindingV1): string { return JSON.stringify([binding.targetServerInstanceId, tuple.requestId, tuple.ownerRunId, tuple.nodeId, binding.cancellationToken.mac]); }
export class BoundPendingCancellationRegistryV1 {
	private entries = new Map<string, Entry>();
	private readonly clock: () => number;
	private readonly capacity: number;
	constructor(clock: () => number = () => Number(process.hrtime.bigint() / 1_000_000n), capacity = CAPACITY) { this.clock = clock; this.capacity = capacity; }
	private prune(): void { const now = this.clock(); for (const [id, entry] of this.entries) if (now >= entry.expiresAt) this.entries.delete(id); }
	remember(tuple: { requestId: string; ownerRunId: string; nodeId: string }, binding: SubagentDelegationBindingV1): boolean {
		this.prune(); const id = key(tuple, binding); if (this.entries.has(id)) return true; if (this.entries.size >= this.capacity) return false;
		this.entries.set(id, { key: id, tokenMac: binding.cancellationToken.mac, requestDigest: binding.requestDigest, prospectiveRunId: binding.prospectiveRunId, target: binding.targetServerInstanceId, expiresAt: binding.cancellationToken.payload.expiresAt }); return true;
	}
	consume(tuple: { requestId: string; ownerRunId: string; nodeId: string }, binding: SubagentDelegationBindingV1): boolean {
		this.prune(); const id = key(tuple, binding); const entry = this.entries.get(id); if (!entry) return false;
		if (entry.tokenMac !== binding.cancellationToken.mac || entry.requestDigest !== binding.requestDigest || entry.prospectiveRunId !== binding.prospectiveRunId || entry.target !== binding.targetServerInstanceId) return false;
		this.entries.delete(id); return true;
	}
	snapshot(): { pending: number } { this.prune(); return { pending: this.entries.size }; }
}
export function getBoundPendingCancellationRegistry(): BoundPendingCancellationRegistryV1 {
	const global = globalThis as Record<string, unknown>; const existing = global[GLOBAL_KEY];
	if (existing && typeof existing === "object" && typeof (existing as BoundPendingCancellationRegistryV1).remember === "function" && typeof (existing as BoundPendingCancellationRegistryV1).consume === "function") return existing as BoundPendingCancellationRegistryV1;
	const registry = new BoundPendingCancellationRegistryV1(); global[GLOBAL_KEY] = registry; return registry;
}
