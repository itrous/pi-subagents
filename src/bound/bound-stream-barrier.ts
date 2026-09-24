import type { StreamFn } from "@earendil-works/pi-agent-core";
import { sortToolRegistryNames, toolRegistryProjection, type ToolRegistryProjectionV1 } from "./bound-tool-registry-projection.ts";
import { boundTranscriptTools, type BoundTranscriptApi } from "./bound-transcript.ts";

/**
 * Fixed fork text (decision D11). It must not match any pi-ai retry pattern:
 * a refused call that Pi classified as transient would be retried, and the
 * retry would again be refused, never reaching a provider but never settling.
 */
export const BOUND_BARRIER_ERROR_TEXT = "pi-subagents bound leaf: tool registry mismatch; the model call was refused before dispatch.";

export type BoundBarrierRefusalReason =
	| "tool_registry_mismatch" | "compaction_forbidden" | "model_mismatch"
	| "context_unsupported" | "tool_definition_mismatch";

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
	/**
	 * Declarations that must reach the provider exactly as given (name → digest
	 * of name/description/parameters), e.g. an attested shadowing definition.
	 */
	declarations?: ReadonlyMap<string, string>;
}

export interface BoundStreamBarrier {
	/** Every later call is refused, whatever its tools and model are. */
	refuseAlways(refusal: BoundBarrierRefusal): void;
	/**
	 * Cancellation (D3): every later provider call is refused without recording a
	 * registry failure; a revoked run's evidence is not rewritten by its own cut-off.
	 */
	revoke(): void;
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

/**
 * Wraps `agent.streamFunction` (fact S1). Every model call is checked before the
 * original stream function runs, on the tool set the call itself declares: the
 * replay of the transcript's system-message deltas through the runtime's own
 * pi-ai (`boundTranscriptTools`), never an expected list standing in for the
 * measurement. Refused in this order: a context that is not the exact transcript
 * shape (`context_unsupported`); a call that declares no tools (compaction,
 * branch summary, D7); a name set other than the contract's or a duplicate
 * (`tool_registry_mismatch`); another model or api; a declaration that differs
 * from a pinned one (`tool_definition_mismatch`). The declarations of the first
 * admitted call are pinned: the registry is frozen after the barrier, so a later
 * definition replacement under the same name is drift, not a new loadout.
 * Returns undefined when the field is not a function or no verified transcript
 * API is at hand: the barrier cannot be installed, and the caller must close the run.
 */
export function installBoundStreamBarrier(
	agent: BarrierAgent | undefined,
	expectation: BoundBarrierExpectation,
	onRefusal: (refusal: BoundBarrierRefusal) => void,
	transcript: Pick<BoundTranscriptApi, "getCurrentTools"> | undefined,
): BoundStreamBarrier | undefined {
	if (!agent || typeof agent.streamFunction !== "function" || !transcript || typeof transcript.getCurrentTools !== "function") return undefined;
	const original = agent.streamFunction;
	const expectedNames = [...expectation.toolNames];
	const required = expectation.declarations ? new Map(expectation.declarations) : undefined;
	let pinned: Map<string, string> | undefined;
	let forced: BoundBarrierRefusal | undefined;
	let revoked = false;
	const refuse = (refusal: BoundBarrierRefusal): never => {
		onRefusal({ reason: refusal.reason, missing: [...refusal.missing], extra: [...refusal.extra] });
		throw new Error(BOUND_BARRIER_ERROR_TEXT);
	};
	const barrier: StreamFn = (model, context, options) => {
		if (revoked) throw new Error(BOUND_BARRIER_ERROR_TEXT);
		if (forced) return refuse(forced);
		const declared = boundTranscriptTools(context, transcript);
		if (!declared.ok) return refuse({ reason: "context_unsupported", missing: [], extra: [] });
		const names = declared.names;
		if (names.length === 0) return refuse({ reason: "compaction_forbidden", missing: [...expectedNames], extra: [] });
		const { missing, extra } = compareToolNames(expectedNames, names);
		if (missing.length > 0 || extra.length > 0 || new Set(names).size !== names.length) return refuse({ reason: "tool_registry_mismatch", missing, extra });
		const modelRef = model && typeof model === "object" ? `${String(model.provider)}/${String(model.id)}` : "";
		if (modelRef !== expectation.model || !model || model.api !== expectation.api) return refuse({ reason: "model_mismatch", missing: [], extra: [] });
		const changed = sortToolRegistryNames(names.filter((name) => {
			const digest = declared.declarations.get(name);
			return (required?.has(name) && required.get(name) !== digest) || (pinned !== undefined && pinned.get(name) !== digest);
		}));
		if (changed.length > 0) return refuse({ reason: "tool_definition_mismatch", missing: changed, extra: changed });
		pinned ??= new Map(declared.declarations);
		return original(model, context, options);
	};
	agent.streamFunction = barrier;
	return {
		refuseAlways(refusal) {
			forced ??= { reason: refusal.reason, missing: [...refusal.missing], extra: [...refusal.extra] };
		},
		revoke() {
			revoked = true;
		},
	};
}
