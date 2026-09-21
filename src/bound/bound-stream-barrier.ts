import type { StreamFn } from "@earendil-works/pi-agent-core";
import { sortToolRegistryNames, toolRegistryProjection, type ToolRegistryProjectionV1 } from "./bound-tool-registry-projection.ts";

/**
 * Fixed fork text (decision D11). It must not match any pi-ai retry pattern:
 * a refused call that Pi classified as transient would be retried, and the
 * retry would again be refused, never reaching a provider but never settling.
 */
export const BOUND_BARRIER_ERROR_TEXT = "pi-subagents bound leaf: tool registry mismatch; the model call was refused before dispatch.";

export type BoundBarrierRefusalReason = "tool_registry_mismatch" | "compaction_forbidden" | "model_mismatch";

export interface BoundBarrierRefusal {
	reason: BoundBarrierRefusalReason;
	missing: string[];
	extra: string[];
}

export interface BoundBarrierExpectation {
	/** `contract.toolRegistry.projection.required`. */
	toolNames: readonly string[];
	/** `provider/id` of `contract.model`. */
	model: string;
	/** `contract.toolRegistry.modelApi`. */
	api: string;
}

export interface BoundStreamBarrier {
	/** Every later call is refused, whatever its tools and model are. */
	refuseAlways(refusal: BoundBarrierRefusal): void;
}

interface BarrierAgent {
	streamFunction: StreamFn;
}

export function compareToolNames(expected: readonly string[], actual: readonly string[]): { missing: string[]; extra: string[] } {
	const expectedSet = new Set(expected);
	const actualSet = new Set(actual);
	return {
		missing: sortToolRegistryNames([...expectedSet].filter((name) => !actualSet.has(name))),
		extra: sortToolRegistryNames([...actualSet].filter((name) => !expectedSet.has(name))),
	};
}

export type BoundRegistrySnapshot =
	| { ok: true; names: string[]; projection: ToolRegistryProjectionV1 }
	| { ok: false; names: string[]; missing: string[]; extra: string[]; projection?: ToolRegistryProjectionV1 };

/**
 * Snapshot of the live registry after `bindExtensions` (fact S2): the reference
 * is `getActiveToolNames()`, never `getAllTools()`. A duplicate name counts as a
 * mismatch because the provider would see an ambiguous tool list.
 */
export function snapshotBoundToolRegistry(
	session: { getActiveToolNames(): string[] },
	expected: { required: readonly string[]; internalTools: readonly string[] },
): BoundRegistrySnapshot {
	let names: string[];
	try {
		const raw = session.getActiveToolNames();
		if (!Array.isArray(raw) || raw.some((name) => typeof name !== "string")) return { ok: false, names: [], missing: [...expected.required], extra: [] };
		names = [...raw];
	} catch { return { ok: false, names: [], missing: [...expected.required], extra: [] }; }
	const projection = toolRegistryProjection({ required: expected.required, actual: names, internalExpected: expected.internalTools });
	const { missing, extra } = compareToolNames(expected.required, names);
	const duplicate = new Set(names).size !== names.length;
	if (!projection || duplicate || missing.length > 0 || extra.length > 0) {
		return { ok: false, names, missing, extra, ...(projection ? { projection } : {}) };
	}
	return { ok: true, names, projection };
}

function toolNamesOf(context: unknown): string[] | undefined {
	if (!context || typeof context !== "object") return undefined;
	const tools = (context as { tools?: unknown }).tools;
	if (!Array.isArray(tools)) return undefined;
	return tools.map((tool) => (tool && typeof tool === "object" && typeof (tool as { name?: unknown }).name === "string" ? (tool as { name: string }).name : ""));
}

/**
 * Wraps `agent.streamFunction` (fact S1). Every model call is checked before the
 * original stream function runs: the exact tool-name set, `provider/id`, and
 * `api`. A call without tools (compaction, branch summary) is refused (D7).
 * Returns undefined when the field is not a function: the barrier cannot be
 * installed, and the caller must close the run.
 */
export function installBoundStreamBarrier(
	agent: BarrierAgent | undefined,
	expectation: BoundBarrierExpectation,
	onRefusal: (refusal: BoundBarrierRefusal) => void,
): BoundStreamBarrier | undefined {
	if (!agent || typeof agent.streamFunction !== "function") return undefined;
	const original = agent.streamFunction;
	const expectedNames = [...expectation.toolNames];
	let forced: BoundBarrierRefusal | undefined;
	const refuse = (refusal: BoundBarrierRefusal): never => {
		onRefusal({ reason: refusal.reason, missing: [...refusal.missing], extra: [...refusal.extra] });
		throw new Error(BOUND_BARRIER_ERROR_TEXT);
	};
	const barrier: StreamFn = (model, context, options) => {
		if (forced) return refuse(forced);
		const names = toolNamesOf(context);
		if (!names || names.length === 0) return refuse({ reason: "compaction_forbidden", missing: [...expectedNames], extra: [] });
		const { missing, extra } = compareToolNames(expectedNames, names);
		if (missing.length > 0 || extra.length > 0 || new Set(names).size !== names.length) return refuse({ reason: "tool_registry_mismatch", missing, extra });
		const modelRef = model && typeof model === "object" ? `${String(model.provider)}/${String(model.id)}` : "";
		if (modelRef !== expectation.model || !model || model.api !== expectation.api) return refuse({ reason: "model_mismatch", missing: [], extra: [] });
		return original(model, context, options);
	};
	agent.streamFunction = barrier;
	return {
		refuseAlways(refusal) {
			forced ??= { reason: refusal.reason, missing: [...refusal.missing], extra: [...refusal.extra] };
		},
	};
}
