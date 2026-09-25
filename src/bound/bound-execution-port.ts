import { Buffer } from "node:buffer";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { createSubagentExecutor, SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { canonicalSha256 } from "../shared/canonical-json.ts";
import type { Details, ExtensionConfig, SingleResult } from "../shared/types.ts";
import { BOUND_BINDINGS_NAMESPACE, projectBoundBindings } from "./bound-bindings.ts";
import { cloneJsonWithinByteLimit } from "./bound-json.ts";
import { BOUND_CHILD_FACTORY_PROOFS, BOUND_CHILD_SHUTDOWN_TIMEOUT_MS } from "./bound-child-factory.ts";
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
/**
 * How long past the child's own shutdown bound the port waits for the disposal
 * outcome before it reports the session as `pending` (never as disposed).
 */
export const BOUND_DISPOSAL_OBSERVATION_GRACE_MS = 250;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_CURRENT_TOOL_BYTES = 128;
/** The client accepts at most this many UTF-8 bytes of `error`. */
const MAX_ERROR_BYTES = 4096;

/**
 * pio192: the final assistant text of a `structured_output_failed` leaf travels
 * as `unstructuredText` under the same bound as a completed result.
 */
const MAX_UNSTRUCTURED_TEXT_BYTES = MAX_RESULT_BYTES;

/** The longest prefix of `text` within `maxBytes` UTF-8 bytes that does not end on a high surrogate. */
function boundedUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	// The prefix's byte length grows with its end: search for the longest that fits
	// (a linear walk is quadratic at 1 MiB).
	let low = 0;
	let high = Math.min(text.length, maxBytes);
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxBytes) low = middle;
		else high = middle - 1;
	}
	let end = low;
	// Never end on a high surrogate, however many of them precede the cut.
	while (end > 0 && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
	return text.slice(0, end);
}

function boundedError(text: string): string {
	return boundedUtf8(text, MAX_ERROR_BYTES);
}

export const BOUND_EXECUTOR_FAILED_TEXT = "Bound leaf executor failed without an error message.";

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
	/** Test seam; production uses `BOUND_CHILD_SHUTDOWN_TIMEOUT_MS`. */
	shutdownTimeoutMs?: number;
	/** Test seam for `elapsedMs`; production uses the monotonic clock. */
	now?: () => number;
	/** Test seam for the capability canaries; production takes the child factory's collectors. */
	proofs?: BoundExecutionProofs;
}

export interface BoundExecutionProofs {
	toolRegistry: boolean;
	deniedTools: boolean;
	/** The port issues `cancellationProof` from its own disposal lifecycle (S3 P2, D3). */
	cancellationProof?: boolean;
}

/** `cancellationProof` of D4, copied only from the port's own lifecycle, never from child text. */
export interface BoundCancellationProofV1 {
	version: 1;
	phase: "notAdmitted" | "admitted";
	requestId: string;
	ownerRunId: string;
	nodeId: string;
	prospectiveRunId: string;
	serverInstanceId: string;
	launchContractDigest: string;
	session: "notCreated" | "disposed" | "pending" | "failed";
	shutdown: "notStarted" | "completed" | "deadline" | "failed";
	execution: "notStarted" | "settled" | "unsettled";
	revoked: boolean;
	collectorsSealed: boolean;
	elapsedMs: number;
}

/** A proof that confirms a cancellation (D4); any other combination is incomplete. */
export function boundCancellationProofConfirms(proof: BoundCancellationProofV1): boolean {
	if (proof.phase === "notAdmitted") {
		return proof.session === "notCreated" && proof.shutdown === "notStarted" && proof.execution === "notStarted"
			&& proof.revoked && !proof.collectorsSealed;
	}
	return proof.session === "disposed" && proof.revoked && proof.collectorsSealed
		&& (proof.shutdown === "completed" || proof.shutdown === "deadline");
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
	// Q3: a contract that grants shadowing completes only with the verified replacements.
	if (status === "completed" && record.launch.contract.toolRegistry.shadowing && !record.registry.shadowing) {
		status = "native_tool_registry_mismatch";
		toolRegistryError = "shadowing_unverified";
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
	// pio192: a session that ended cleanly without calling structured_output
	// hands its final text to the client beside, never as, the result.
	let unstructuredText: { text: string; truncated: boolean } | undefined;
	if (status === "structured_output_failed" && typeof child?.finalOutput === "string" && child.finalOutput.trim() !== "") {
		unstructuredText = {
			text: boundedUtf8(child.finalOutput, MAX_UNSTRUCTURED_TEXT_BYTES),
			truncated: Buffer.byteLength(child.finalOutput, "utf8") > MAX_UNSTRUCTURED_TEXT_BYTES,
		};
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
		...(record.registry.shadowing ? { toolShadowing: record.registry.shadowing } : {}),
		...(failure?.toolsMissing ? { toolsMissing: [...failure.toolsMissing] } : {}),
		...(failure?.toolsExtra ? { toolsExtra: [...failure.toolsExtra] } : {}),
		...(toolRegistryError ? { toolRegistryError } : {}),
		deniedToolCalls: denials.calls.map((call) => ({ ...call })),
		...(denials.overflow ? { deniedToolCallsOverflow: true } : {}),
		...(denials.calls.length > 0 || denials.overflow ? { transportIncomplete: true } : {}),
		...(projected ? { result: projected } : {}),
		...(unstructuredText ? { unstructuredText } : {}),
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

const INCOMPLETE_REASON: Record<BoundCancellationProofV1["session"], string> = {
	notCreated: "Bound cancellation: no child session was measured; the registry evidence is incomplete.",
	disposed: "Bound cancellation: the run's evidence is incomplete.",
	pending: "Bound cancellation: disposal of the child session was not confirmed within the bound.",
	failed: "Bound cancellation: disposal of the child session failed.",
};

/**
 * D3: the terminal of a cancelled run keeps every measured evidence (a cancel
 * never erases it) and never a result. It confirms the cancellation only with a
 * confirming proof and the full old evidence: exact measured registry,
 * shadowing when granted, a sealed empty denial list, no overflow, no failure.
 * Anything less is `transportIncomplete: true` with a bounded reason.
 */
export function projectBoundCancelledTerminal(record: BoundRunRecord, result: DelegatedResult | undefined, proof: BoundCancellationProofV1 | undefined): PortOutcome {
	const details = result?.details as Details | undefined;
	const child = details?.results?.[0];
	const failure = record.registry.failure;
	const denials = record.denials;
	const shadowingRequired = Boolean(record.launch.contract.toolRegistry.shadowing);
	const evidenceComplete = record.registry.projection !== undefined && !failure && (!shadowingRequired || record.registry.shadowing !== undefined)
		&& denials.calls.length === 0 && !denials.overflow;
	const confirmed = proof !== undefined && boundCancellationProofConfirms(proof) && evidenceComplete;
	const usage = child?.usage;
	const reason = confirmed ? undefined : proof ? INCOMPLETE_REASON[proof.session] : "Bound cancellation: this contract carries no disposal proof.";
	return {
		status: "cancelled",
		...(reason ? { error: reason } : {}),
		...(details?.runId ? { runId: details.runId } : {}),
		...(child?.agent ? { agent: child.agent } : {}),
		...(child?.model ? { model: child.model } : {}),
		...(child?.thinking ? { thinking: child.thinking } : {}),
		...(typeof child?.exitCode === "number" ? { exitCode: child.exitCode } : {}),
		launchContractDigest: record.launch.contract.digest,
		...(record.registry.projection ? { toolRegistry: record.registry.projection } : {}),
		...(record.registry.shadowing ? { toolShadowing: record.registry.shadowing } : {}),
		...(failure?.toolsMissing ? { toolsMissing: [...failure.toolsMissing] } : {}),
		...(failure?.toolsExtra ? { toolsExtra: [...failure.toolsExtra] } : {}),
		...(failure?.toolRegistryError ? { toolRegistryError: failure.toolRegistryError } : {}),
		deniedToolCalls: denials.calls.map((call) => ({ ...call })),
		...(denials.overflow ? { deniedToolCallsOverflow: true } : {}),
		...(confirmed ? {} : { transportIncomplete: true }),
		...(usage ? {
			usage: {
				input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
				cost: usage.cost, turns: usage.turns,
				toolCalls: child?.progressSummary?.toolCount ?? 0,
				durationMs: child?.progressSummary?.durationMs ?? 0,
			},
		} : {}),
		...(proof ? { cancellationProof: { ...proof } } : {}),
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

	const shutdownTimeoutMs = options.shutdownTimeoutMs ?? BOUND_CHILD_SHUTDOWN_TIMEOUT_MS;
	const now = options.now ?? (() => performance.now());

	/**
	 * D3 disposal handle of one run: from the start of the child's creation, not
	 * only after attach. A child created after the cut-off is never attached and
	 * its factory disposes it; that late disposal cannot confirm this terminal.
	 */
	const disposeChild = async (record: BoundRunRecord): Promise<Pick<BoundCancellationProofV1, "session" | "shutdown">> => {
		const child = record.child;
		if (!child) {
			if (record.creation === "none") return { session: "notCreated", shutdown: "notStarted" };
			if (record.creation === "failed") return { session: "failed", shutdown: "notStarted" };
			return { session: "pending", shutdown: "notStarted" };
		}
		let started: Promise<void>;
		try { started = child.dispose(); } catch { return { session: "failed", shutdown: "failed" }; }
		started.catch(() => {});
		const observed = child.disposalOutcome?.();
		if (!observed) return { session: "pending", shutdown: "notStarted" };
		let timer: ReturnType<typeof setTimeout> | undefined;
		const limit = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), shutdownTimeoutMs + BOUND_DISPOSAL_OBSERVATION_GRACE_MS); });
		try {
			const outcome = await Promise.race([observed.catch(() => "error" as const), limit]);
			if (outcome === "timeout") return { session: "pending", shutdown: "deadline" };
			if (outcome === "error") return { session: "failed", shutdown: "failed" };
			return { session: outcome.disposed ? "disposed" : "failed", shutdown: outcome.shutdown };
		} finally { if (timer) clearTimeout(timer); }
	};

	const execute = async ({ launch, signal, onUpdate, commit }: Parameters<BoundExecutionPort["run"]>[0]): Promise<PortOutcome> => {
		// Every refusal before the run exists still closes the run's MCP connections.
		const closeMcp = (): void => { void launch.mcp?.close().catch(() => "failed" as const); };
		const refuse = (toolRegistryError?: BoundToolRegistryError): PortOutcome => { closeMcp(); return refused(toolRegistryError); };
		if (disposed) return refuse();
		// D15: the executor falls back to the host budget and no value switches it
		// off, while the contract fixes `usageBudget: false`.
		if (options.config.usageBudget !== undefined) return refuse("policy_mismatch");
		const ctx = options.getContext();
		if (!ctx) return refuse();
		const params = buildBoundExecutionParams(launch);
		if (!params) return refuse("launch_contract_mismatch");
		const record = registry.open(launch);
		if (!record) return refuse();
		markBoundRunParams(params, record.runId);
		const repair = launch.contract.safety !== undefined;
		// D3: the cancel latch closes provider/tool admission, bindings and the update
		// relay synchronously, and starts abort without awaiting it.
		let cancelAcceptedAt: number | undefined;
		const onCancel = (): void => {
			cancelAcceptedAt ??= now();
			registry.revoke(record.runId);
			const child = record.child;
			if (child) { try { void child.abort().catch(() => {}); } catch { /* abort is best effort; disposal decides */ } }
		};
		if (signal.aborted) onCancel();
		else signal.addEventListener("abort", onCancel, { once: true });
		const relay = (update: DelegatedResult): void => {
			if (disposed || signal.aborted || record.revoked || registry.get(record.runId) !== record) return;
			const projected = projectBoundUpdate(update);
			if (Object.keys(projected).length > 0) onUpdate(projected);
		};
		const emptyResult: DelegatedResult = { content: [], details: { mode: "single", results: [] } };
		let executionState: BoundCancellationProofV1["execution"] = "notStarted";
		// A launch cancelled before the executor ran never reaches it.
		const execution: Promise<DelegatedResult> | undefined = signal.aborted ? undefined : (async (): Promise<DelegatedResult> => {
			executionState = "unsettled";
			try { return await options.executeDelegated(launch.request.requestId, params, signal, relay, ctx); }
			// A thrown executor still reports the run's evidence; without a child result it is `failed`.
			catch (thrown) {
				const reason = thrown instanceof Error ? thrown.message : typeof thrown === "string" ? thrown : "";
				return { content: [{ type: "text", text: reason.trim() ? reason : BOUND_EXECUTOR_FAILED_TEXT }], details: emptyResult.details };
			} finally { executionState = "settled"; }
		})();
		// The record, and with it the run's privacy (T3), lives exactly as long as
		// the executor does, even when the outcome was returned at the deadline.
		if (execution) void execution.finally(() => { registry.close(record.runId); closeMcp(); });
		else registry.close(record.runId);
		// Cancellation never waits for `prompt()` or `abort()` (fact S5): after the
		// hard timer the port disposes the child itself and settles.
		let timer: ReturnType<typeof setTimeout> | undefined;
		let startTimer: (() => void) | undefined;
		const deadline = new Promise<"deadline">((resolve) => {
			startTimer = () => { timer = setTimeout(() => resolve("deadline"), hardTimerMs); };
			if (signal.aborted) startTimer();
			else signal.addEventListener("abort", startTimer, { once: true });
		});
		const winner = execution ? await Promise.race([execution, deadline]) : "deadline";
		if (timer) clearTimeout(timer);
		if (startTimer) signal.removeEventListener("abort", startTimer);
		// The single terminal commit point: an executor outcome that arrives before any
		// cancel is committed; a cancel that latched first forbids completed/result.
		if (winner !== "deadline" && !signal.aborted && (commit?.() ?? true)) {
			record.settled = true;
			signal.removeEventListener("abort", onCancel);
			return projectBoundTerminal(record, winner, false);
		}
		// Cancelled: before any dispose, so a child the factory finishes later is refused and disposed there.
		record.settled = true;
		onCancel();
		const disposal = await disposeChild(record);
		record.registry.seal();
		record.denials.seal();
		closeMcp();
		const proof: BoundCancellationProofV1 | undefined = repair ? {
			version: 1,
			phase: "admitted",
			requestId: launch.request.requestId,
			ownerRunId: launch.request.ownerRunId,
			nodeId: launch.request.nodeId,
			prospectiveRunId: launch.request.prospectiveRunId,
			serverInstanceId: launch.contract.serverInstanceId,
			launchContractDigest: launch.contract.digest,
			session: disposal.session,
			shutdown: disposal.shutdown,
			execution: executionState,
			revoked: record.revoked,
			collectorsSealed: record.registry.sealed && record.denials.sealed,
			elapsedMs: Math.max(0, Math.round(now() - (cancelAcceptedAt ?? now()))),
		} : undefined;
		return projectBoundCancelledTerminal(record, winner === "deadline" ? undefined : winner, proof);
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
		proofs: Object.freeze({ ...(options.proofs ?? { ...BOUND_CHILD_FACTORY_PROOFS, cancellationProof: true }) }),
	};
}
