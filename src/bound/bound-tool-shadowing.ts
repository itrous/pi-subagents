import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";
import type { BoundPackageExtensionProjectionV1 } from "./bound-package-extensions.ts";
import { toolDeclarationDigest } from "./bound-transcript.ts";

export const BOUND_TOOL_SHADOWING_VERSION = 1 as const;

/**
 * The closed set of builtins a bound leaf may have replaced (decision Q3): the
 * read-only ones. `bash`, `edit`, `write` and every other name stay the
 * runtime's own and can never be taken by a package.
 */
export const BOUND_SHADOWABLE_TOOLS: readonly string[] = Object.freeze(["find", "grep", "ls", "read"]);
const SHADOWABLE = new Set(BOUND_SHADOWABLE_TOOLS);

/** Request field `toolShadowing` (subplan A1R.6, sub-stage 3). */
export interface BoundToolShadowingRequestV1 {
	version: typeof BOUND_TOOL_SHADOWING_VERSION;
	/** Exact contract `ref` of a `relative` package extension of the agent. */
	extension: string;
	/** Non-empty, unique, code-unit ordered subset of `BOUND_SHADOWABLE_TOOLS`. */
	tools: string[];
}

/** Contract `toolRegistry.shadowing`: who may replace which builtins, bound to attested bytes. */
export interface BoundToolShadowingContractV1 {
	version: typeof BOUND_TOOL_SHADOWING_VERSION;
	tools: string[];
	extension: {
		ref: string;
		owner: BoundPackageExtensionProjectionV1["owner"];
		contentDigest: string;
		packageTreeDigest: string;
		evidenceRootDigest: string;
	};
}

/** Terminal evidence: the declaration of every replacement the attested owner registered. */
export interface BoundToolShadowingEvidenceV1 {
	version: typeof BOUND_TOOL_SHADOWING_VERSION;
	tools: string[];
	declarations: Record<string, string>;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Undefined when absent, null when malformed. The value is already a strict JSON clone. */
export function parseBoundToolShadowingRequest(value: unknown): BoundToolShadowingRequestV1 | undefined | null {
	if (value === undefined) return undefined;
	if (!plainRecord(value) || Object.keys(value).sort().join(",") !== "extension,tools,version") return null;
	if (value.version !== BOUND_TOOL_SHADOWING_VERSION) return null;
	const extension = value.extension;
	if (typeof extension !== "string" || !extension.trim() || /[\0\r\n]/u.test(extension) || Buffer.byteLength(extension, "utf8") > 1024) return null;
	const tools = value.tools;
	if (!Array.isArray(tools) || tools.length === 0 || tools.length > BOUND_SHADOWABLE_TOOLS.length) return null;
	for (let index = 0; index < tools.length; index++) {
		const name = tools[index];
		if (typeof name !== "string" || !SHADOWABLE.has(name)) return null;
		if (index > 0 && !((tools[index - 1] as string) < name)) return null;
	}
	return { version: BOUND_TOOL_SHADOWING_VERSION, extension, tools: [...tools as string[]] };
}

/**
 * Resolver side: the requested owner must be one of the agent's own attested
 * `relative` extensions, and every name a builtin of this runtime that the
 * launch's allowlist contains. Undefined when any condition fails.
 */
export function resolveBoundToolShadowing(
	request: BoundToolShadowingRequestV1,
	input: { packageExtensions: readonly BoundPackageExtensionProjectionV1[]; runtimeBuiltins: readonly string[]; effectiveAllowlist: readonly string[] },
): BoundToolShadowingContractV1 | undefined {
	const matches = input.packageExtensions.filter((entry) => entry.ref === request.extension);
	const entry = matches[0];
	if (matches.length !== 1 || !entry || entry.kind !== "relative" || entry.package !== undefined) return undefined;
	const builtins = new Set(input.runtimeBuiltins);
	const allowlist = new Set(input.effectiveAllowlist);
	if (request.tools.some((name) => !builtins.has(name) || !allowlist.has(name))) return undefined;
	return {
		version: BOUND_TOOL_SHADOWING_VERSION,
		tools: [...request.tools],
		extension: {
			ref: entry.ref,
			owner: { name: entry.owner.name, version: entry.owner.version, manifestDigest: entry.owner.manifestDigest },
			contentDigest: entry.contentDigest,
			packageTreeDigest: entry.packageTreeDigest,
			evidenceRootDigest: entry.evidenceRootDigest,
		},
	};
}

/** Runtime grant handed to the facade of the one attested owner factory. */
export interface BoundToolShadowingGrant {
	tools: ReadonlySet<string>;
	/** Name → digests of what the owner registered: full declaration, and the part `getAllTools()` reports. */
	registered: Map<string, { declaration: string; base: string }>;
}

export function createBoundToolShadowingGrant(contract: BoundToolShadowingContractV1): BoundToolShadowingGrant {
	return { tools: new Set(contract.tools), registered: new Map() };
}

export type BoundShadowingCheck =
	| { ok: true; evidence: BoundToolShadowingEvidenceV1; declarations: Map<string, string> }
	| { ok: false; code: "shadowing_incomplete" | "shadowing_mismatch" };

/**
 * After `bindExtensions`, before the barrier: every granted name was registered
 * by the owner, and the session's active definition of each is not the builtin
 * and carries exactly the declaration the owner registered. A builtin under the
 * same name never stands in for a missing replacement.
 */
export function verifyBoundToolShadowing(
	session: { getAllTools?: () => unknown },
	contract: BoundToolShadowingContractV1,
	grant: BoundToolShadowingGrant,
): BoundShadowingCheck {
	if (contract.tools.some((name) => !grant.registered.has(name)) || grant.registered.size !== contract.tools.length) return { ok: false, code: "shadowing_incomplete" };
	let all: unknown;
	try { all = typeof session.getAllTools === "function" ? session.getAllTools() : undefined; } catch { all = undefined; }
	if (!Array.isArray(all)) return { ok: false, code: "shadowing_mismatch" };
	for (const name of contract.tools) {
		const active = all.filter((tool) => tool && typeof tool === "object" && (tool as { name?: unknown }).name === name);
		if (active.length !== 1) return { ok: false, code: "shadowing_mismatch" };
		const tool = active[0] as { sourceInfo?: { source?: unknown } };
		const source = tool.sourceInfo && typeof tool.sourceInfo === "object" ? tool.sourceInfo.source : undefined;
		if (typeof source !== "string" || source === "builtin") return { ok: false, code: "shadowing_mismatch" };
		if (toolDeclarationDigest(tool, { base: true }) !== grant.registered.get(name)!.base) return { ok: false, code: "shadowing_mismatch" };
	}
	const declarations = new Map(contract.tools.map((name) => [name, grant.registered.get(name)!.declaration]));
	return {
		ok: true,
		declarations,
		evidence: { version: BOUND_TOOL_SHADOWING_VERSION, tools: [...contract.tools], declarations: Object.fromEntries(declarations) },
	};
}
