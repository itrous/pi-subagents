import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BOUND_IDENTITY_REGISTRY_CAPACITY,
	BOUND_IDENTITY_REGISTRY_GLOBAL_KEY,
	BoundIdentityRegistry,
	getBoundIdentityRegistry,
} from "../../src/slash/bound-identity-registry.ts";

describe("active-bound identity registry", () => {
	it("reserves atomically, releases only tentative identities, and tombstones commits", () => {
		const registry = new BoundIdentityRegistry();
		assert.equal(registry.reserve("server", "run"), "reserved");
		assert.equal(registry.reserve("server", "run"), "duplicate");
		assert.equal(registry.release("server", "run"), true);
		assert.equal(registry.reserve("server", "run"), "reserved");
		assert.equal(registry.commit("server", "run"), true);
		assert.equal(registry.release("server", "run"), false);
		assert.equal(registry.reserve("server", "run"), "duplicate");
		assert.equal(registry.reserve("replacement", "run"), "reserved");
	});

	it("saturates exactly without eviction and preserves the first tombstone", () => {
		const registry = new BoundIdentityRegistry();
		for (let index = 0; index < BOUND_IDENTITY_REGISTRY_CAPACITY; index++) {
			assert.equal(registry.reserve("server", `run-${index}`), "reserved");
			assert.equal(registry.commit("server", `run-${index}`), true);
		}
		assert.equal(registry.size(), BOUND_IDENTITY_REGISTRY_CAPACITY);
		assert.equal(registry.reserve("server", "overflow"), "capacity");
		assert.equal(registry.reserve("server", "run-0"), "duplicate");
	});

	it("shares the registry across independent module generations", async () => {
		const globalStore = globalThis as Record<string, unknown>; const previous = globalStore[BOUND_IDENTITY_REGISTRY_GLOBAL_KEY];
		try {
			delete globalStore[BOUND_IDENTITY_REGISTRY_GLOBAL_KEY];
			const moduleUrl = new URL("../../src/slash/bound-identity-registry.ts", import.meta.url).href;
			const first = await import(`${moduleUrl}?generation=one`) as typeof import("../../src/slash/bound-identity-registry.ts");
			const second = await import(`${moduleUrl}?generation=two`) as typeof import("../../src/slash/bound-identity-registry.ts");
			assert.equal(first.getBoundIdentityRegistry(), second.getBoundIdentityRegistry());
		} finally { if (previous === undefined) delete globalStore[BOUND_IDENTITY_REGISTRY_GLOBAL_KEY]; else globalStore[BOUND_IDENTITY_REGISTRY_GLOBAL_KEY] = previous; }
	});

	it("reuses a compatible process-global registry and rejects incompatible state", () => {
		const store: Record<string, unknown> = {};
		assert.equal(getBoundIdentityRegistry(store), getBoundIdentityRegistry(store));
		assert.throws(() => getBoundIdentityRegistry({ __piSubagentBoundIdentityRegistryV1: { version: 1 } }), /Incompatible/);
		const globalStore = globalThis as Record<string, unknown>; const previous = globalStore[BOUND_IDENTITY_REGISTRY_GLOBAL_KEY];
		try { delete globalStore[BOUND_IDENTITY_REGISTRY_GLOBAL_KEY]; assert.equal(getBoundIdentityRegistry(), getBoundIdentityRegistry()); }
		finally { if (previous === undefined) delete globalStore[BOUND_IDENTITY_REGISTRY_GLOBAL_KEY]; else globalStore[BOUND_IDENTITY_REGISTRY_GLOBAL_KEY] = previous; }
	});
});
