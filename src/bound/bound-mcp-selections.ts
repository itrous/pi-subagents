import * as path from "node:path";
import type { McpDirectToolResolution } from "../runs/shared/mcp-direct-tool-allowlist.ts";
import { normalizeMcpDirectToolSelectors, type ResolvedMcpDirectToolSelection } from "../runs/shared/mcp-direct-tool-grant.ts";

/**
 * Producer-owned MCP selections for the two bound resolutions of the tool plan
 * (preflight and the executor's recheck, plan D2). The shared resolver accepts a
 * handle only when this module issued it: a caller cannot pass its own
 * metadata, and an unknown or foreign handle refuses instead of falling back
 * to the metadata cache. Unbound call sites pass no handle and are unchanged.
 */
export interface BoundMcpSelectionsHandle {
	readonly boundMcpSelections: true;
}

interface IssuedSelections {
	selectors: string[];
	cwd: string;
	selections: ResolvedMcpDirectToolSelection[];
}

const issued = new WeakMap<object, IssuedSelections>();

export function issueBoundMcpSelections(input: { selectors: readonly string[]; cwd: string; selections: readonly ResolvedMcpDirectToolSelection[] }): BoundMcpSelectionsHandle {
	const handle = Object.freeze({ boundMcpSelections: true as const });
	issued.set(handle, {
		selectors: normalizeMcpDirectToolSelectors(input.selectors),
		cwd: path.resolve(input.cwd),
		selections: input.selections.map((selection) => ({ name: selection.name, selector: selection.selector })),
	});
	return handle;
}

/**
 * The resolution the handle stands for, when it was issued here for exactly
 * these selectors and this cwd; otherwise undefined and the caller refuses.
 */
export function resolveBoundMcpSelectionsHandle(
	handle: unknown,
	selectors: readonly string[] | undefined,
	cwd: string,
): McpDirectToolResolution | undefined {
	if (!handle || typeof handle !== "object") return undefined;
	const entry = issued.get(handle);
	if (!entry) return undefined;
	const requested = normalizeMcpDirectToolSelectors(selectors);
	if (requested.length !== entry.selectors.length || requested.some((selector, index) => selector !== entry.selectors[index])) return undefined;
	if (!cwd || path.resolve(cwd) !== entry.cwd) return undefined;
	return { selections: entry.selections.map((selection) => ({ ...selection })), unresolvedSelectors: [] };
}
