import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti/static";
import type { ChildHookExtension } from "../runs/shared/child-session.ts";
import { packageTreeEvidence } from "../runs/shared/package-tree-evidence.ts";
import { createBoundPackageApi, createBoundPackageEventBus, createBoundPackageToolOwnership, type BoundPackageViolation } from "./bound-package-api.ts";
import type { BoundResolvedPackageExtensions } from "./bound-package-extensions.ts";
import { installBoundSessionBindingsResponder, type BoundSessionBindingsEntry } from "./bound-session-bindings.ts";
import type { BoundToolShadowingGrant } from "./bound-tool-shadowing.ts";

export type BoundPackageAttestation = BoundResolvedPackageExtensions["attestations"][number];
export type BoundPackageFailureCode = "package_bytes_drift" | "package_load_error";

export const BOUND_PACKAGE_HOOK_NAME = "pi-subagents:bound-packages";

export interface BoundLoadedPackageFactory {
	path: string;
	/** Attested entry bytes; the shadowing grant goes only to the factory whose bytes the contract names. */
	contentDigest?: string;
	factory: (pi: ExtensionAPI) => unknown;
	allowInputRegistrationNoop: boolean;
}

function sha256(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function within(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * A file is inside the attested closure when it lies in some measured package
 * root and its path relative to THAT root has no `node_modules` segment. The
 * attested entry `node_modules/pi-mcp-adapter/index.ts` passes through the
 * adapter's own root, while an unmeasured package under the owner does not.
 */
export function withinAttestedRoots(roots: readonly string[], filename: string): boolean {
	const target = path.resolve(filename);
	return roots.some((root) => within(root, target) && !path.relative(root, target).split(path.sep).includes("node_modules"));
}

/** Entry re-check at load time: regular non-symlink `.ts` at its canonical path with the attested bytes. */
function entryMatches(attestation: BoundPackageAttestation): boolean {
	try {
		if (path.extname(attestation.path) !== ".ts" || !path.isAbsolute(attestation.path)) return false;
		const stat = fs.lstatSync(attestation.path);
		if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(attestation.path) !== attestation.path) return false;
		return sha256(fs.readFileSync(attestation.path)) === attestation.contentDigest;
	} catch { return false; }
}

/**
 * Re-measure every attestation right before loading (step 2 of the package
 * section): entry bytes against `contentDigest`, the evidence root against its
 * digest, and the package tree against `packageTreeDigest`. Returns the union
 * of measured package roots, which bounds the transform guard.
 */
export function verifyBoundPackageAttestations(attestations: readonly BoundPackageAttestation[]): { ok: true; roots: string[] } | { ok: false; code: "package_bytes_drift" } {
	const drift = { ok: false as const, code: "package_bytes_drift" as const };
	const roots = new Set<string>();
	const treeByRoot = new Map<string, { digest: string; roots: string[] }>();
	try {
		for (const attestation of attestations) {
			if (sha256(attestation.evidenceRoot) !== attestation.evidenceRootDigest
				|| fs.realpathSync(attestation.evidenceRoot) !== attestation.evidenceRoot
				|| !within(attestation.evidenceRoot, attestation.path)
				|| !entryMatches(attestation)) return drift;
			let evidence = treeByRoot.get(attestation.evidenceRoot);
			if (!evidence) {
				evidence = packageTreeEvidence(attestation.path, attestation.evidenceRoot, attestation.evidenceRoot);
				treeByRoot.set(attestation.evidenceRoot, evidence);
			}
			if (evidence.digest !== attestation.packageTreeDigest || !withinAttestedRoots(evidence.roots, attestation.path)) return drift;
			for (const root of evidence.roots) roots.add(root);
		}
	} catch { return drift; }
	return { ok: true, roots: [...roots].sort() };
}

/**
 * A private jiti instance whose `transform` refuses any file outside the
 * attested roots (fact S6, decision D6). This is hygiene, not a boundary:
 * native `.mjs`/`.cjs` are not transformed, and `createRequire`,
 * `module.constructor._load`, or `fs` plus `new Function` are not contained.
 * No global resolver patch is installed, so the parent and sibling sessions
 * are untouched.
 */
export function createBoundPackageImporter(roots: readonly string[]): { import(entry: string): Promise<unknown>; importNamespace(entry: string): Promise<unknown> } {
	const transformer = createJiti(import.meta.url, { moduleCache: false });
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		tryNative: false,
		transform(options) {
			if (typeof options.filename !== "string" || !path.isAbsolute(options.filename) || !withinAttestedRoots(roots, options.filename)) {
				throw new Error("pi-subagents bound leaf: package factory transform escaped its attested roots.");
			}
			return { code: transformer.transform(options) };
		},
	});
	return { import: (entry) => jiti.import(entry, { default: true }), importNamespace: (entry) => jiti.import(entry) };
}

function packageNameForEntry(entry: string, evidenceRoot: string): string | undefined {
	let current = path.dirname(entry);
	while (within(evidenceRoot, current)) {
		try {
			const manifest = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8")) as { name?: unknown };
			return typeof manifest.name === "string" ? manifest.name : undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
		}
		if (current === evidenceRoot) break;
		current = path.dirname(current);
	}
	return undefined;
}

export interface BoundPackageLoadOptions {
	/**
	 * Attested MCP configuration (sub-stage 4): the factory of the extension with
	 * this contract ref is built as `createMcpAdapter({ config })` from its
	 * attested entry's namespace instead of its default export, so the adapter
	 * discovers no configuration file at all.
	 */
	mcpConfig?: { ref: string; config: Record<string, unknown> };
}

/** Verify, then import every attested factory in execution order. Nothing is invoked yet. */
export async function loadBoundPackageFactories(attestations: readonly BoundPackageAttestation[], options: BoundPackageLoadOptions = {}): Promise<
	{ ok: true; factories: BoundLoadedPackageFactory[] } | { ok: false; code: BoundPackageFailureCode }
> {
	const verified = verifyBoundPackageAttestations(attestations);
	if (!verified.ok) return verified;
	const importer = createBoundPackageImporter(verified.roots);
	const factories: BoundLoadedPackageFactory[] = [];
	for (const attestation of attestations) {
		// The bytes are read again immediately before the import: the tree walk
		// above takes seconds on a real closure.
		if (!entryMatches(attestation)) return { ok: false, code: "package_bytes_drift" };
		let factory: unknown;
		try {
			if (options.mcpConfig && attestation.ref === options.mcpConfig.ref) {
				const namespace = await importer.importNamespace(attestation.path) as { createMcpAdapter?: unknown } | undefined;
				const create = namespace && typeof namespace === "object" ? namespace.createMcpAdapter : undefined;
				factory = typeof create === "function" ? (create as (input: { config: Record<string, unknown> }) => unknown)({ config: structuredClone(options.mcpConfig.config) }) : undefined;
			} else factory = await importer.import(attestation.path);
		}
		catch { return { ok: false, code: "package_load_error" }; }
		if (typeof factory !== "function") return { ok: false, code: "package_load_error" };
		factories.push({
			path: attestation.path,
			contentDigest: attestation.contentDigest,
			factory: factory as (pi: ExtensionAPI) => unknown,
			allowInputRegistrationNoop: packageNameForEntry(attestation.path, attestation.evidenceRoot) === "pi-mcp-adapter",
		});
	}
	return { ok: true, factories };
}

export interface BoundPackageHookOptions {
	runtimeBuiltins: readonly string[];
	internalTools: readonly string[];
	barrierCommitted: () => boolean;
	onViolation: (violation: BoundPackageViolation) => void;
	/** A factory that threw; Pi only records the load error, so the run is closed through this callback. */
	onFactoryError: (entry: string, error: unknown) => void;
	/** Bindings of a child session published for this run only (sub-stage 2); absent means no responder. */
	sessionBindings?: (sessionId: string) => BoundSessionBindingsEntry | undefined;
	/** Shadowing grant (sub-stage 3) and the attested entry path it belongs to. */
	shadowing?: { path: string; contentDigest: string; grant: BoundToolShadowingGrant };
}

/** Inline hook that calls each loaded factory with its own facade over one shared ownership map and one private bus. */
export function boundPackageFactoriesHook(factories: readonly BoundLoadedPackageFactory[], options: BoundPackageHookOptions): ChildHookExtension {
	return {
		name: BOUND_PACKAGE_HOOK_NAME,
		factory: async (pi) => {
			const ownership = createBoundPackageToolOwnership(options.runtimeBuiltins, options.internalTools);
			const events = createBoundPackageEventBus();
			// Subscribed before any factory runs, so every package of the run reaches it.
			if (options.sessionBindings) installBoundSessionBindingsResponder(events, options.sessionBindings);
			for (const loaded of factories) {
				const owner = options.shadowing !== undefined && loaded.path === options.shadowing.path
					&& loaded.contentDigest === options.shadowing.contentDigest;
				const api = createBoundPackageApi(pi, ownership, {
					barrierCommitted: options.barrierCommitted,
					onViolation: options.onViolation,
					allowInputRegistrationNoop: loaded.allowInputRegistrationNoop,
					events,
					...(owner ? { shadowing: options.shadowing!.grant } : {}),
				});
				try { await loaded.factory(api); }
				catch (error) {
					options.onFactoryError(loaded.path, error);
					throw error;
				}
			}
		},
	};
}
