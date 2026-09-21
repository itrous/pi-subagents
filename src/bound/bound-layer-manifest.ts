import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const BOUND_LAYER_MANIFEST_VERSION = 2 as const;

/**
 * Fork-owned modules of the bound layer, in a fixed order. The v2 contract
 * publishes this list as `toolRegistry.runtimeExtensions` instead of the 18
 * child-extension names the v1 (A1) contract carried.
 *
 * Every member of the import closure of `src/bound/index.ts` that this fork owns
 * must appear here; `test/unit/bound-layer-manifest.test.ts` enforces that.
 */
export const BOUND_LAYER_MODULES = [
	"bound/bound-agent-discovery.ts",
	"bound/bound-attempt-coordinator.ts",
	"bound/bound-bindings.ts",
	"bound/bound-execution-port.ts",
	"bound/bound-json.ts",
	"bound/bound-launch-bridge.ts",
	"bound/bound-layer-manifest.ts",
	"bound/bound-package-extensions.ts",
	"bound/bound-pending-cancellation-registry.ts",
	"bound/bound-request.ts",
	"bound/bound-resolver.ts",
	"bound/bound-run-registry.ts",
	"bound/bound-runtime-service.ts",
	"bound/bound-tool-registry-projection.ts",
	"bound/bounded-child-shutdown.ts",
	"bound/channel.ts",
	"bound/index.ts",
	"bound/pi-runtime-attestation.ts",
	"api/launch-receipt.ts",
	"extension/source-identity.ts",
	"runs/shared/core-runtime-tools.ts",
	"runs/shared/package-tree-evidence.ts",
	"shared/canonical-json.ts",
	"slash/bound-identity-registry.ts",
] as const;

export type BoundLayerModule = typeof BOUND_LAYER_MODULES[number];

export interface BoundLayerEntryV1 {
	name: string;
	contentDigest: string;
}

export interface BoundLayerManifestV2 {
	version: typeof BOUND_LAYER_MANIFEST_VERSION;
	entries: BoundLayerEntryV1[];
}

export const BOUND_LAYER_SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function boundLayerModulePath(name: string, sourceRoot = BOUND_LAYER_SOURCE_ROOT): string {
	return path.join(sourceRoot, ...name.split("/"));
}

/** Read the layer's own bytes. A missing or unreadable module fails the attestation closed. */
export function boundLayerManifest(sourceRoot = BOUND_LAYER_SOURCE_ROOT): BoundLayerManifestV2 {
	return {
		version: BOUND_LAYER_MANIFEST_VERSION,
		entries: BOUND_LAYER_MODULES.map((name) => ({
			name,
			contentDigest: createHash("sha256").update(fs.readFileSync(boundLayerModulePath(name, sourceRoot))).digest("hex"),
		})),
	};
}
