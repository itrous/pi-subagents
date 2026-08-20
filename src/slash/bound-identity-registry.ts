export const BOUND_IDENTITY_REGISTRY_VERSION = 1 as const;
export const BOUND_IDENTITY_REGISTRY_CAPACITY = 8192 as const;
export const BOUND_IDENTITY_REGISTRY_GLOBAL_KEY = "__piSubagentBoundIdentityRegistryV1";

type ReservationState = "tentative" | "committed";

export interface BoundIdentityRegistryV1 {
	readonly version: 1;
	reserve(serverInstanceId: string, prospectiveRunId: string): "reserved" | "duplicate" | "capacity";
	commit(serverInstanceId: string, prospectiveRunId: string): boolean;
	release(serverInstanceId: string, prospectiveRunId: string): boolean;
	has(serverInstanceId: string, prospectiveRunId: string): boolean;
	size(): number;
}

export class BoundIdentityRegistry implements BoundIdentityRegistryV1 {
	readonly version = BOUND_IDENTITY_REGISTRY_VERSION;
	private readonly identities = new Map<string, ReservationState>();
	private key(serverInstanceId: string, prospectiveRunId: string): string { return `${serverInstanceId}\0${prospectiveRunId}`; }
	reserve(serverInstanceId: string, prospectiveRunId: string): "reserved" | "duplicate" | "capacity" {
		const key = this.key(serverInstanceId, prospectiveRunId);
		if (this.identities.has(key)) return "duplicate";
		if (this.identities.size >= BOUND_IDENTITY_REGISTRY_CAPACITY) return "capacity";
		this.identities.set(key, "tentative");
		return "reserved";
	}
	commit(serverInstanceId: string, prospectiveRunId: string): boolean {
		const key = this.key(serverInstanceId, prospectiveRunId);
		if (this.identities.get(key) !== "tentative") return false;
		this.identities.set(key, "committed");
		return true;
	}
	release(serverInstanceId: string, prospectiveRunId: string): boolean {
		const key = this.key(serverInstanceId, prospectiveRunId);
		if (this.identities.get(key) !== "tentative") return false;
		return this.identities.delete(key);
	}
	has(serverInstanceId: string, prospectiveRunId: string): boolean {
		return this.identities.has(this.key(serverInstanceId, prospectiveRunId));
	}
	size(): number { return this.identities.size; }
}

function compatible(value: unknown): value is BoundIdentityRegistryV1 {
	if (!value || typeof value !== "object") return false;
	const registry = value as Partial<BoundIdentityRegistryV1>;
	return registry.version === 1 && typeof registry.reserve === "function" && typeof registry.commit === "function"
		&& typeof registry.release === "function" && typeof registry.has === "function" && typeof registry.size === "function";
}

/** Process-global, non-evicting identity tombstones. Incompatible reload state fails closed. */
export function getBoundIdentityRegistry(store: Record<string, unknown> = globalThis as Record<string, unknown>): BoundIdentityRegistryV1 {
	const current = store[BOUND_IDENTITY_REGISTRY_GLOBAL_KEY];
	if (current !== undefined) {
		if (!compatible(current)) throw new Error("Incompatible active-bound identity registry is already installed.");
		return current;
	}
	const registry = new BoundIdentityRegistry();
	store[BOUND_IDENTITY_REGISTRY_GLOBAL_KEY] = registry;
	return registry;
}
