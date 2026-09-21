import { Buffer } from "node:buffer";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { createSubagentExecutor, SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { canonicalSha256 } from "../shared/canonical-json.ts";
import type { Details, ExtensionConfig, SingleResult } from "../shared/types.ts";
import { BOUND_BINDINGS_NAMESPACE, projectBoundBindings } from "./bound-bindings.ts";
import { cloneJsonWithinByteLimit } from "./bound-json.ts";
import { BOUND_CHILD_FACTORY_PROOFS } from "./bound-child-factory.ts";
import type { BoundExecutionPort } from "./bound-launch-bridge.ts";
import { getBoundRunRegistry, markBoundRunParams, type BoundRunRecord, type BoundRunRegistryV1, type BoundToolRegistryError } from "./bound-run-registry.ts";
import type { BoundAuthorizedLaunch } from "./bound-runtime-service.ts";

export type BoundExecuteDelegated = ReturnType<typeof createSubagentExecutor>["executeDelegated"];
type DelegatedResult = Awaited<ReturnType<BoundExecuteDelegated>>;
type PortOutcome = Awaited<ReturnType<BoundExecutionPort["run"]>>;

/**
 * After a cancellation the port waits at most this long for the executor, then
 * disposes the child itself. The deadline promised for a `cancelled` terminal is
 * this value plus `BOUND_CHILD_SHUTDOWN_TIMEOUT_MS`.
 */
export const BOUND_CANCEL_HARD_TIMER_MS = 3_000;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_CURRENT_TOOL_BYTES = 128;
/** The client accepts at most this many UTF-8 bytes of `error`. */
const MAX_ERROR_BYTES = 4096;

function boundedError(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= MAX_ERROR_BYTES) return text;
	let end = MAX_ERROR_BYTES;
	while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > MAX_ERROR_BYTES) end--;
	return text.slice(0, end);
}

/** Private fields `executeDelegated` accepts and strips before execution. */
export interface BoundExecutionParams extends SubagentParamsLike {
	delegatedThinkingOverride: string;
	delegatedAllowZeroToolBudget: true;
}

export interface BoundExecutionPortOptions {
	executeDelegated: BoundExecuteDelegated;
	getContext: () => ExtensionContext | null;
	config: ExtensionConfig;
	registry?: BoundRunRegistryV1;
	/** Test seam; production uses `BOUND_CANCEL_HARD_TIMER_MS`. */
	hardTimerMs?: number;
	/** Test seam for the capability canaries; production takes the child factory's collectors. */
	proofs?: BoundExecutionProofs;
}

export interface BoundExecutionProofs {
	toolRegistry: boolean;
	deniedTools: boolean;
}

export interface BoundExecutionPortHandle extends BoundExecutionPort {
	/** Generation stop: no new run starts and no update of a live run is relayed. */
	dispose(): void;
	/** Settles once every run this port started has returned its outcome. */
	whenIdle(): Promise<void>;
	/** Collectors wired into every run by the bound child factory (T2 routes marked runs there). */
	readonly proofs: Readonly<BoundExecutionProofs>;
}

function refused(toolRegistryError?: BoundToolRegistryError): PortOutcome {
	return { status: "unavailable_context", ...(toolRegistryError ? { toolRegistryError } : {}) };
}

/**
 * Executor params built only from the admitted launch (the contract plus the
 * signed request it was resolved from), with the explicit switches of D14 for
 * policy the contract declares off. Undefined when the request no longer hashes
 * to the contract's task or bindings.
 */
export function buildBoundExecutionParams(launch: BoundAuthorizedLaunch): BoundExecutionParams | undefined {
	const { contract, request } = launch;
	if (canonicalSha256(request.task) !== contract.taskDigest
		|| projectBoundBindings(request.bindings).valuesDigest !== contract.bindings.valuesDigest
		|| request.prospectiveRunId !== contract.prospectiveRunId) return undefined;
	const bindings = request.bindings && Object.keys(request.bindings).length > 0 ? { ...request.bindings } : undefined;
	return {
		agent: contract.agent.name,
		task: request.task,
		cwd: contract.canonicalCwd,
		model: contract.model,
		delegatedThinkingOverride: contract.thinking,
		context: "fresh",
		foregroundOnly: true,
		async: false,
		clarify: false,
		share: false,
		acceptance: false,
		output: false,
		skill: contract.skills.length > 0 ? contract.skills.map((skill) => skill.name) : false,
		...(contract.timeoutMs !== undefined ? { timeoutMs: contract.timeoutMs } : {}),
		...(contract.toolBudget !== undefined ? { toolBudget: contract.toolBudget } : {}),
		delegatedAllowZeroToolBudget: true,
		...(contract.result.kind === "structured" ? { outputSchema: contract.result.schema } : {}),
		outputMode: contract.policy.outputMode,
		artifacts: contract.policy.artifacts,
		...(bindings ? { extensionBindings: { [BOUND_BINDINGS_NAMESPACE]: bindings } } : {}),
		control: { enabled: false },
		intercomBridge: { mode: "off" },
	};
}

function nonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** D13: only what the client reads — `model`, `durationMs`, `tokens`, `currentTool`. */
export function projectBoundUpdate(update: DelegatedResult): Record<string, unknown> {
	const details = update.details as Details | undefined;
	const progress = details?.progress?.[0];
	const model = progress?.model ?? details?.results?.[0]?.model;
	const currentTool = progress?.currentTool;
	return {
		...(typeof model === "string" && model ? { model } : {}),
		...(nonNegativeInteger(progress?.durationMs) ? { durationMs: progress.durationMs } : {}),
		...(nonNegativeInteger(progress?.tokens) ? { tokens: progress.tokens } : {}),
		...(typeof currentTool === "string" && currentTool && Buffer.byteLength(currentTool, "utf8") <= MAX_CURRENT_TOOL_BYTES ? { currentTool } : {}),
	};
}

function firstText(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string" && text.trim()) return text.trim();
		}
	}
	return undefined;
}

function executorStatus(result: DelegatedResult, child: SingleResult | undefined, aborted: boolean): string {
	const details = result.details as Details | undefined;
	if (aborted) return "cancelled";
	if (!child || child.detached) return "failed";
	if (details?.timedOut || child.timedOut) return "timed_out";
	if (child.structuredOutputFailed) return "structured_output_failed";
	if (child.turnBudgetExceeded) return "turn_budget_exhausted";
	if (child.toolBudgetBlocked) return "tool_budget_exhausted";
	if (details?.stopped || child.stopped || child.interrupted) return "interrupted";
	if ((result as { isError?: unknown }).isError === true || child.error || child.exitCode !== 0) return "failed";
	return "completed";
}

/**
 * D8: the status set is the one the A1 client already accepts; the reason is
 * refined through `toolRegistryError`. Evidence comes from the run's own
 * collectors, never from the child's text.
 */
export function projectBoundTerminal(record: BoundRunRecord, result: DelegatedResult, aborted: boolean): PortOutcome {
	const details = result.details as Details | undefined;
	const child = details?.results?.[0];
	const failure = record.registry.failure;
	let status = failure ? failure.status : executorStatus(result, child, aborted);
	let toolRegistryError: BoundToolRegistryError | undefined = failure?.toolRegistryError;
	let error = child?.error ?? (status === "failed" ? firstText(result.content) : undefined);
	let projected: Record<string, unknown> | undefined;
	// A completion without a registry snapshot means the barrier never stood in
	// front of the model: it is refused, not reported as success.
	if (status === "completed" && !record.registry.projection) {
		status = "native_tool_registry_mismatch";
		toolRegistryError = "barrier_unavailable";
	}
	if (status === "completed") {
		const kind = record.launch.contract.result.kind;
		if (kind === "text") {
			if (typeof child?.finalOutput !== "string") { status = "failed"; error = "Bound leaf did not capture a text result."; }
			else if (Buffer.byteLength(child.finalOutput, "utf8") > MAX_RESULT_BYTES) { status = "failed"; error = "Bound leaf text result exceeds 1 MiB when UTF-8 encoded."; }
			else projected = { kind: "text", text: child.finalOutput };
		} else if (child?.structuredOutput === undefined) {
			status = "failed";
			error = "Bound leaf did not capture the requested structured result.";
		} else {
			const cloned = cloneJsonWithinByteLimit(child.structuredOutput, MAX_RESULT_BYTES);
			if (!cloned.ok) { status = "failed"; error = cloned.reason === "too_large" ? "Bound leaf structured result exceeds 1 MiB when encoded." : "Bound leaf structured result is not plain JSON data."; }
			else projected = { kind: "structured", value: cloned.value };
		}
	}
	const denials = record.denials;
	const usage = child?.usage;
	return {
		status,
		...(error ? { error: boundedError(error) } : {}),
		...(details?.runId ? { runId: details.runId } : {}),
		...(child?.agent ? { agent: child.agent } : {}),
		...(child?.model ? { model: child.model } : {}),
		...(child?.thinking ? { thinking: child.thinking } : {}),
		...(typeof child?.exitCode === "number" ? { exitCode: child.exitCode } : {}),
		launchContractDigest: record.launch.contract.digest,
		...(record.registry.projection ? { toolRegistry: record.registry.projection } : {}),
		...(failure?.toolsMissing ? { toolsMissing: [...failure.toolsMissing] } : {}),
		...(failure?.toolsExtra ? { toolsExtra: [...failure.toolsExtra] } : {}),
		...(toolRegistryError ? { toolRegistryError } : {}),
		deniedToolCalls: denials.calls.map((call) => ({ ...call })),
		...(denials.overflow ? { deniedToolCallsOverflow: true } : {}),
		...(denials.calls.length > 0 || denials.overflow ? { transportIncomplete: true } : {}),
		...(projected ? { result: projected } : {}),
		...(usage ? {
			usage: {
				input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
				cost: usage.cost, turns: usage.turns,
				toolCalls: child?.progressSummary?.toolCount ?? 0,
				durationMs: child?.progressSummary?.durationMs ?? 0,
			},
		} : {}),
	};
}

/**
 * Execution port of the bound leaf (A1R.3 decision D9 slot). One run: registry
 * record under `prospectiveRunId`, collectors created before the executor is
 * called, executor params marked with the bound capability, then exactly one
 * outcome for the coordinator.
 */
export function createBoundExecutionPort(options: BoundExecutionPortOptions): BoundExecutionPortHandle {
	const registry = options.registry ?? getBoundRunRegistry();
	const hardTimerMs = options.hardTimerMs ?? BOUND_CANCEL_HARD_TIMER_MS;
	const inFlight = new Set<Promise<unknown>>();
	let disposed = false;

	const execute = async ({ launch, signal, onUpdate }: Parameters<BoundExecutionPort["run"]>[0]): Promise<PortOutcome> => {
		if (disposed) return refused();
		// D15: the executor falls back to the host budget and no value switches it
		// off, while the contract fixes `usageBudget: false`.
		if (options.config.usageBudget !== undefined) return refused("policy_mismatch");
		const ctx = options.getContext();
		if (!ctx) return refused();
		const params = buildBoundExecutionParams(launch);
		if (!params) return refused("launch_contract_mismatch");
		const record = registry.open(launch);
		if (!record) return refused();
		markBoundRunParams(params, record.runId);
		const relay = (update: DelegatedResult): void => {
			if (disposed || signal.aborted || registry.get(record.runId) !== record) return;
			const projected = projectBoundUpdate(update);
			if (Object.keys(projected).length > 0) onUpdate(projected);
		};
		const emptyResult: DelegatedResult = { content: [], details: { mode: "single", results: [] } };
		const execution = (async (): Promise<DelegatedResult> => {
			try { return await options.executeDelegated(launch.request.requestId, params, signal, relay, ctx); }
			// A thrown executor still reports the run's evidence; without a child result it is `failed`.
			catch (thrown) {
				const reason = thrown instanceof Error ? thrown.message : String(thrown);
				return reason ? { content: [{ type: "text", text: reason }], details: emptyResult.details } : emptyResult;
			}
		})();
		// The record, and with it the run's privacy (T3), lives exactly as long as
		// the executor does, even when the outcome was returned at the deadline.
		void execution.finally(() => registry.close(record.runId));
		// Cancellation never waits for `prompt()` or `abort()` (fact S5): after the
		// hard timer the port disposes the child itself and settles.
		let timer: ReturnType<typeof setTimeout> | undefined;
		let startTimer: (() => void) | undefined;
		const deadline = new Promise<"deadline">((resolve) => {
			startTimer = () => { timer = setTimeout(() => resolve("deadline"), hardTimerMs); };
			if (signal.aborted) startTimer();
			else signal.addEventListener("abort", startTimer, { once: true });
		});
		const winner = await Promise.race([execution, deadline]);
		if (timer) clearTimeout(timer);
		if (startTimer) signal.removeEventListener("abort", startTimer);
		// Before any dispose: a child the factory finishes later is refused and disposed there.
		record.settled = true;
		if (winner !== "deadline") return projectBoundTerminal(record, winner, signal.aborted);
		try { await record.child?.dispose(); } catch { /* the outcome is cancelled either way */ }
		return projectBoundTerminal(record, emptyResult, true);
	};

	return {
		run(input) {
			const running = execute(input);
			inFlight.add(running);
			const forget = (): void => { inFlight.delete(running); };
			running.then(forget, forget);
			return running;
		},
		dispose() {
			disposed = true;
		},
		async whenIdle() {
			await Promise.allSettled([...inFlight]);
		},
		proofs: Object.freeze({ ...(options.proofs ?? BOUND_CHILD_FACTORY_PROOFS) }),
	};
}
