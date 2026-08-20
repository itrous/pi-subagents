import * as path from "node:path";
import { types as utilTypes } from "node:util";
import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { resolveAsyncRunLocation } from "../runs/background/async-resume.ts";
import { deliverStopRequest } from "../runs/background/control-channel.ts";
import { reconcileAsyncRun } from "../runs/background/stale-run-reconciler.ts";
import { resolveSubagentRunId } from "../runs/background/run-id-resolver.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
import {
	type AsyncJobStep,
	type Details,
	type SubagentState,
	DIRS,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_PROCESS_TERMINAL_EVENT,
	SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
} from "../shared/types.ts";
import { readStatus } from "../shared/utils.ts";
import { SubagentParams } from "./schemas.ts";
import { formatWorkflowJsonPreview } from "../workflows/scripted-workflow.ts";
import { normalizePublicSubagentExecution } from "./public-execution.ts";
import { cloneJsonWithinByteLimit } from "../slash/delegation-json.ts";
import { activeBoundPreflightTarget } from "../api/active-bound-preflight.ts";
import type { ActiveBoundRuntimeService } from "../api/active-bound-runtime.ts";
import type { ActiveRuntimeSourceIdentityResolution } from "./source-identity.ts";

export const SUBAGENT_RPC_PROTOCOL_VERSION = 1;
export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";

export const SUBAGENT_RPC_METHODS = ["ping", "preflight", "status", "spawn", "steer", "interrupt", "stop", "resume"] as const;
export type SubagentRpcMethod = typeof SUBAGENT_RPC_METHODS[number];

export interface SubagentRpcRequestEnvelope {
	version: typeof SUBAGENT_RPC_PROTOCOL_VERSION;
	requestId: string;
	method: SubagentRpcMethod;
	params?: unknown;
	source?: {
		extension?: string;
		[key: string]: unknown;
	};
}

export type SubagentRpcReplyEnvelope<T = unknown> = {
	version: typeof SUBAGENT_RPC_PROTOCOL_VERSION;
	requestId: string;
	method?: SubagentRpcMethod;
	success: true;
	data: T;
} | {
	version: typeof SUBAGENT_RPC_PROTOCOL_VERSION;
	requestId: string;
	method?: SubagentRpcMethod;
	success: false;
	error: {
		code: SubagentRpcErrorCode;
		message: string;
	};
};

type SubagentRpcErrorCode =
	| "invalid_request"
	| "invalid_params"
	| "unsupported_version"
	| "unsupported_method"
	| "no_active_session"
	| "execution_failed"
	| "not_found"
	| "invalid_state";

interface EventBus {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

export interface SubagentRpcFleetEntry {
	/** Opaque key for client-side reconciliation; never a run or async identifier. */
	key: string;
	/** Resolved child agent/role name. */
	agent: string;
	role?: string;
	model?: string;
	effort?: string;
	startedAt: number;
	tokens: { input: number; output: number; total: number };
	goal?: string;
}

export interface SubagentRpcFleetStatus {
	version: 1;
	entries: SubagentRpcFleetEntry[];
	/** Total active children before the bounded entries window. */
	totalActive: number;
	omitted: number;
}

const MAX_RPC_ENVELOPE_BYTES = 9 * 1024 * 1024;
const MAX_FLEET_ENTRIES = 16;
const MAX_FLEET_CANDIDATES = 256;
const MAX_AGENT_LENGTH = 96;
const MAX_GOAL_LENGTH = 512;
const MAX_METADATA_LENGTH = 128;

function displayText(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	// Strip complete CSI/OSC/DCS/APC/PM strings and C1 controls before collapsing
	// whitespace; never leave CSI parameters behind after removing ESC.
	const normalized = value.slice(0, 4_096)
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b][\s\S]*?(?:\x07|\x1b\\)|\x1b[PX^_][\s\S]*?\x1b\\|[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ").trim();
	return normalized ? normalized.slice(0, maxLength) : undefined;
}

function publicTokens(value: unknown): { input: number; output: number; total: number } {
	const record = isRecord(value) ? value : {};
	const count = (field: "input" | "output" | "total") => {
		const raw = record[field];
		return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
			? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(raw))
			: 0;
	};
	const input = count("input");
	const output = count("output");
	const sum = Math.min(Number.MAX_SAFE_INTEGER, input + output);
	return { input, output, total: Math.max(sum, count("total")) };
}

function activeState(value: unknown): boolean {
	return value === "running" || value === "queued" || value === "pending";
}

interface FleetKeyState {
	sessionId: string | null;
	next: number;
	keys: Map<string, string>;
}

interface FleetCandidate {
	internalKey: string;
	agent: unknown;
	role?: unknown;
	model?: unknown;
	effort?: unknown;
	startedAt: unknown;
	tokens?: unknown;
	goal?: unknown;
}

function buildFleetStatus(
	state: SubagentState | undefined,
	keyState: FleetKeyState,
	sessionId: string | null | undefined,
): SubagentRpcFleetStatus {
	const authoritativeSessionId = sessionId ?? null;
	if (keyState.sessionId !== authoritativeSessionId) {
		keyState.sessionId = authoritativeSessionId;
		keyState.next = 0;
		keyState.keys.clear();
	}
	if (!state || !authoritativeSessionId || state.currentSessionId !== authoritativeSessionId) {
		keyState.keys.clear();
		return { version: 1, entries: [], totalActive: 0, omitted: 0 };
	}

	let totalActive = 0;
	const candidates: FleetCandidate[] = [];
	const addCandidate = (candidate: FleetCandidate) => {
		totalActive += 1;
		if (candidates.length < MAX_FLEET_CANDIDATES) candidates.push(candidate);
	};
	for (const control of state.foregroundControls.values()) {
		if (control.sessionId !== authoritativeSessionId) continue;
		const publicDescription = control.activeBound ? undefined : control.description;
		if (control.activeChildren?.size) {
			for (const child of control.activeChildren.values()) addCandidate({
				internalKey: `foreground:${control.runId}:${child.index}`,
				agent: child.agent,
				model: child.model,
				effort: child.thinking,
				startedAt: child.startedAt,
				tokens: { input: child.inputTokens ?? 0, output: child.outputTokens ?? 0, total: child.tokens ?? 0 },
				goal: control.activeBound ? undefined : child.description ?? publicDescription,
			});
		} else {
			addCandidate({
				internalKey: `foreground:${control.runId}:${control.currentIndex ?? 0}`,
				agent: control.currentAgent ?? control.mode,
				model: control.model,
				effort: control.thinking,
				startedAt: control.startedAt,
				tokens: { input: control.inputTokens ?? 0, output: control.outputTokens ?? 0, total: control.tokens ?? 0 },
				goal: publicDescription,
			});
		}
	}
	for (const job of state.asyncJobs.values()) {
		if (job.sessionId !== authoritativeSessionId || !activeState(job.status)) continue;
		const startedAt = job.startedAt ?? job.updatedAt;
		if (job.mode === "workflow") {
			const latestEmit = job.workflow?.emits?.length ? formatWorkflowJsonPreview(job.workflow.emits.at(-1), 120) : undefined;
			addCandidate({
				internalKey: `async:${job.asyncId}`,
				agent: "workflow",
				startedAt,
				tokens: job.totalTokens,
				goal: latestEmit !== undefined ? `latest emit: ${latestEmit}` : job.description,
			});
			continue;
		}
		const steps: AsyncJobStep[] | undefined = job.steps?.length
			? job.steps
			: job.agents?.map((agent, index) => ({
				agent,
				index,
				status: job.status === "queued" ? "pending" : "running",
			}));
		if (!steps?.length) {
			addCandidate({
				internalKey: `async:${job.asyncId}`,
				agent: job.mode ?? "subagent",
				startedAt,
				tokens: job.totalTokens,
				goal: job.description,
			});
			continue;
		}
		for (const [offset, step] of steps.entries()) {
			if (!activeState(step.status)) continue;
			const index = step.index ?? offset;
			if (step.status === "pending" && job.mode === "chain" && !job.activeParallelGroup && index !== (job.currentStep ?? 0)) continue;
			addCandidate({
				internalKey: `async:${job.asyncId}:${index}`,
				agent: step.agent,
				role: step.label,
				model: step.model,
				effort: step.thinking,
				startedAt: step.startedAt ?? startedAt,
				tokens: step.tokens ?? (steps.length === 1 ? job.totalTokens : undefined),
				goal: job.description,
			});
		}
	}

	candidates.sort((left, right) => {
		const leftStarted = typeof left.startedAt === "number" ? left.startedAt : Number.MAX_SAFE_INTEGER;
		const rightStarted = typeof right.startedAt === "number" ? right.startedAt : Number.MAX_SAFE_INTEGER;
		return leftStarted - rightStarted || left.internalKey.localeCompare(right.internalKey);
	});
	const activeKeys = new Set(candidates.map((candidate) => candidate.internalKey));
	const entries: SubagentRpcFleetEntry[] = [];
	for (const candidate of candidates) {
		if (entries.length >= MAX_FLEET_ENTRIES) break;
		const agent = displayText(candidate.agent, MAX_AGENT_LENGTH);
		const startedAt = candidate.startedAt;
		if (!agent || typeof startedAt !== "number" || !Number.isSafeInteger(startedAt) || startedAt < 0) continue;
		let key = keyState.keys.get(candidate.internalKey);
		if (!key) {
			key = `fleet-${++keyState.next}`;
			keyState.keys.set(candidate.internalKey, key);
		}
		const role = displayText(candidate.role, MAX_AGENT_LENGTH);
		const model = displayText(candidate.model, MAX_METADATA_LENGTH);
		const effort = displayText(candidate.effort, MAX_METADATA_LENGTH);
		const goal = displayText(candidate.goal, MAX_GOAL_LENGTH);
		entries.push({
			key,
			agent,
			...(role ? { role } : {}),
			...(model ? { model } : {}),
			...(effort ? { effort } : {}),
			startedAt,
			tokens: publicTokens(candidate.tokens),
			...(goal ? { goal } : {}),
		});
	}
	for (const internalKey of keyState.keys.keys()) {
		if (!activeKeys.has(internalKey)) keyState.keys.delete(internalKey);
	}
	const omitted = Math.max(0, totalActive - entries.length);
	return { version: 1, entries, totalActive, omitted };
}

interface RegisterSubagentRpcBridgeOptions {
	events: EventBus;
	getContext: () => ExtensionContext | null;
	execute: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
	asyncDirRoot?: string;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
	/** Native live state, projected into the optional public fleet-status capability. */
	state?: SubagentState;
	serverInstanceId?: string;
	sourceIdentityResolution?: ActiveRuntimeSourceIdentityResolution;
	activeBoundRuntime?: ActiveBoundRuntimeService;
}

class SubagentRpcError extends Error {
	readonly code: SubagentRpcErrorCode;

	constructor(code: SubagentRpcErrorCode, message: string) {
		super(message);
		this.name = "SubagentRpcError";
		this.code = code;
	}
}

const subagentParamsValidator = Compile(SubagentParams);

export function subagentRpcReplyEvent(requestId: string): string {
	return `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertRequestId(value: unknown, _allowLegacySpawnLength = false): string {
	if (typeof value !== "string" || value.trim().length === 0 || /[\r\n]/.test(value)) {
		throw new SubagentRpcError("invalid_request", "RPC requestId must be a non-empty string without newlines.");
	}
	return value;
}

function assertRecordParams(params: unknown, method: SubagentRpcMethod): Record<string, unknown> {
	if (params === undefined) return {};
	if (!isRecord(params)) throw new SubagentRpcError("invalid_params", `RPC ${method} params must be an object.`);
	return params;
}

function assertSubagentParams(params: SubagentParamsLike, label: string): void {
	if (subagentParamsValidator.Check(params)) return;
	const messages = [...subagentParamsValidator.Errors(params)]
		.slice(0, 4)
		.map((error) => error.message);
	throw new SubagentRpcError("invalid_params", `${label}: ${messages.join("; ") || "invalid subagent parameters"}`);
}

function textFromToolResult(result: AgentToolResult<Details>): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

type ToolResultWithError = AgentToolResult<Details> & { isError?: boolean };

function dataFromToolResult(result: ToolResultWithError): { text: string; details?: Details; isError?: boolean } {
	return {
		text: textFromToolResult(result),
		...(result.details ? { details: result.details } : {}),
		...(result.isError ? { isError: true } : {}),
	};
}

function failIfToolError(result: ToolResultWithError): void {
	if (!result.isError) return;
	throw new SubagentRpcError("execution_failed", textFromToolResult(result) || "Subagent RPC execution failed.");
}

function normalizeTargetParams(params: unknown, method: SubagentRpcMethod): Pick<SubagentParamsLike, "id" | "runId" | "dir" | "index"> {
	const input = assertRecordParams(params, method);
	const output: Pick<SubagentParamsLike, "id" | "runId" | "dir" | "index"> = {};
	if (input.id !== undefined) output.id = input.id as string;
	if (input.runId !== undefined) output.runId = input.runId as string;
	if (input.dir !== undefined) output.dir = input.dir as string;
	if (input.index !== undefined) output.index = input.index as number;
	return output;
}

function sessionData(ctx: ExtensionContext | null): { cwd?: string; sessionId?: string; sessionFile?: string | null } {
	if (!ctx) return {};
	return {
		cwd: ctx.cwd,
		sessionId: ctx.sessionManager.getSessionId() ?? undefined,
		sessionFile: ctx.sessionManager.getSessionFile() ?? null,
	};
}

function pingData(ctx: ExtensionContext | null, identity: {
	serverInstanceId: string;
	sourceIdentityResolution: ActiveRuntimeSourceIdentityResolution;
	activeBoundRuntime?: ActiveBoundRuntimeService;
}) {
	const source = identity.sourceIdentityResolution;
	return {
		serverInstanceId: identity.serverInstanceId,
		...(source.available
			? { sourceIdentity: { ...source.sourceIdentity } }
			: { sourceIdentityUnavailable: { ...source.sourceIdentityUnavailable } }),
		version: SUBAGENT_RPC_PROTOCOL_VERSION,
		methods: [...SUBAGENT_RPC_METHODS],
		capabilities: {
			status: true,
			...(source.available ? { activeRuntimeIdentity: { version: 1 } } : {}),
			...(source.available && identity.activeBoundRuntime ? { boundForegroundLeaf: { version: 1 } } : {}),
			fleetStatus: { version: 1 },
			asyncSpawn: true,
			steer: true,
			nonRecoveringSteer: true,
			interrupt: true,
			stop: true,
			resume: true,
			launchResolvedExtensions: { version: 1, source: "launch-resolved" },
			runtimeAcknowledgedExtensions: { version: 1, source: "child-runtime", event: "subagent:acknowledge-extension" },
			processTerminalProof: { version: 1, lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION },
		},
		events: {
			ready: SUBAGENT_RPC_READY_EVENT,
			request: SUBAGENT_RPC_REQUEST_EVENT,
			replyPrefix: SUBAGENT_RPC_REPLY_EVENT_PREFIX,
			asyncComplete: SUBAGENT_ASYNC_COMPLETE_EVENT,
			processTerminal: SUBAGENT_PROCESS_TERMINAL_EVENT,
		},
		session: sessionData(ctx),
	};
}

async function executeChecked(
	options: RegisterSubagentRpcBridgeOptions,
	ctx: ExtensionContext,
	requestId: string,
	method: SubagentRpcMethod,
	params: SubagentParamsLike,
): Promise<{ text: string; details?: Details; isError?: boolean }> {
	assertSubagentParams(params, `RPC ${method} params`);
	const controller = new AbortController();
	const result = await options.execute(`rpc-${method}-${requestId}`, params, controller.signal, undefined, ctx);
	failIfToolError(result);
	return dataFromToolResult(result);
}

function spawnParams(params: unknown): SubagentParamsLike {
	const input = assertRecordParams(params, "spawn");
	const normalized = normalizePublicSubagentExecution(input);
	if (!normalized.ok) throw new SubagentRpcError("invalid_params", normalized.error);
	if (normalized.params.action !== undefined) {
		throw new SubagentRpcError("invalid_params", "RPC spawn does not accept management/control actions. Use status or interrupt RPC methods instead.");
	}
	if (input.async === false) {
		throw new SubagentRpcError("invalid_params", "RPC spawn only supports detached async launches; omit async or set async: true.");
	}
	return { ...(normalized.params as SubagentParamsLike), async: true };
}

function steerParams(params: unknown): SubagentParamsLike {
	const input = assertRecordParams(params, "steer");
	if (typeof input.message !== "string" || !input.message.trim())
		throw new SubagentRpcError("invalid_params", "RPC steer requires a non-empty message.");
	const target = normalizeTargetParams(input, "steer");
	if (!target.id && !target.runId && !target.dir) throw new SubagentRpcError("invalid_params", "RPC steer requires id, runId, or dir.");
	if (input.mode !== undefined && input.mode !== "steer" && input.mode !== "follow_up" && input.mode !== "auto") throw new SubagentRpcError("invalid_params", "RPC steer mode must be steer, follow_up, or auto.");
	return {
		action: "steer",
		...target,
		message: input.message.trim(),
		...(typeof input.mode === "string" ? { mode: input.mode as "steer" | "follow_up" | "auto" } : {}),
		steeringRecovery: false,
	};
}

function resumeParams(params: unknown): SubagentParamsLike {
	const input = assertRecordParams(params, "resume");
	if (typeof input.message !== "string" || !input.message.trim())
		throw new SubagentRpcError("invalid_params", "RPC resume requires a non-empty message.");
	const target = normalizeTargetParams(input, "resume");
	if (!target.id && !target.runId && !target.dir) throw new SubagentRpcError("invalid_params", "RPC resume requires id, runId, or dir.");
	if (input.output !== undefined && (typeof input.output !== "string" || !input.output.trim()))
		throw new SubagentRpcError("invalid_params", "RPC resume output must be a non-empty path.");
	if (input.outputMode !== undefined && input.outputMode !== "file-only")
		throw new SubagentRpcError("invalid_params", "RPC resume supports only file-only output mode.");
	return {
		action: "resume",
		...target,
		message: input.message.trim(),
		...(typeof input.output === "string" ? { output: input.output.trim(), outputMode: "file-only" } : {}),
	};
}

function stopAsyncRun(
	params: unknown,
	options: RegisterSubagentRpcBridgeOptions,
	ctx: ExtensionContext,
): { runId: string; asyncDir: string; previousState: string; state: "stopping"; message: string } {
	const target = normalizeTargetParams(params, "stop");
	assertSubagentParams({ action: "status", ...target }, "RPC stop target params");
	const asyncDirRoot = options.asyncDirRoot ?? DIRS.async;
	const resultsDir = options.resultsDir ?? DIRS.results;
	let location;
	try {
		location = resolveAsyncRunLocation(target, asyncDirRoot, resultsDir);
	} catch (error) {
		throw new SubagentRpcError("invalid_params", error instanceof Error ? error.message : String(error));
	}
	if (!location.asyncDir) {
		throw new SubagentRpcError("not_found", "Async run not found or already completed; stop requires a live async run directory.");
	}

	const currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
	const initialStatus = readStatus(location.asyncDir);
	const initialRunId = initialStatus?.runId ?? location.resolvedId ?? path.basename(location.asyncDir);
	if (!initialStatus) throw new SubagentRpcError("not_found", `Status file not found for async run '${initialRunId}'.`);
	if (!currentSessionId || initialStatus.sessionId !== currentSessionId) {
		throw new SubagentRpcError("not_found", `Async run '${initialRunId}' was not found in the active session.`);
	}

	let status;
	try {
		status = reconcileAsyncRun(location.asyncDir, { resultsDir, kill: options.kill, now: options.now }).status;
	} catch (error) {
		throw new SubagentRpcError("execution_failed", error instanceof Error ? error.message : String(error));
	}
	const runId = status?.runId ?? initialRunId;
	if (!status) throw new SubagentRpcError("not_found", `Status file not found for async run '${runId}'.`);
	if (status.sessionId !== currentSessionId) {
		throw new SubagentRpcError("not_found", `Async run '${runId}' was not found in the active session.`);
	}
	if (status.state !== "running") {
		throw new SubagentRpcError("invalid_state", `Async run ${runId} is ${status.state}; stop only supports running async runs.`);
	}

	try {
		deliverStopRequest({
			asyncDir: location.asyncDir,
			pid: status.pid,
			kill: options.kill,
			now: options.now,
			source: "rpc-stop",
		});
	} catch (error) {
		throw new SubagentRpcError("execution_failed", error instanceof Error ? error.message : String(error));
	}

	return {
		runId,
		asyncDir: location.asyncDir,
		previousState: status.state,
		state: "stopping",
		message: `Stop requested for async run ${runId}.`,
	};
}

function privateBoundStatusRequested(params: SubagentParamsLike, options: RegisterSubagentRpcBridgeOptions, ctx: ExtensionContext, preferRunId = false): boolean {
	const state = options.state; const sessionId = resolveCurrentSessionId(ctx.sessionManager);
	if (!state || !sessionId) return false;
	const isPrivate = (runId: string) => state.foregroundControls.get(runId)?.sessionId === sessionId && state.foregroundControls.get(runId)?.activeBound === true
		|| state.foregroundRuns?.get(runId)?.sessionId === sessionId && state.foregroundRuns.get(runId)?.activeBound === true;
	const privateIds = [...state.foregroundControls.keys(), ...(state.foregroundRuns?.keys() ?? [])].filter(isPrivate);
	const target = preferRunId ? params.runId ?? params.id : params.id ?? params.runId;
	if (!target) {
		if (Boolean(params.dir)) return false;
		const preferred = state.lastForegroundControlId ? state.foregroundControls.get(state.lastForegroundControlId) : undefined;
		const latest = preferred ?? [...state.foregroundControls.values()].filter((control) => control.sessionId === sessionId).sort((left, right) => right.updatedAt - left.updatedAt)[0];
		return latest?.activeBound === true;
	}
	if (typeof target !== "string") return false;
	try {
		const resolved = resolveSubagentRunId(target, { state });
		if (resolved) return resolved.kind === "foreground" && isPrivate(resolved.id);
		return privateIds.length > 0;
	} catch { return privateIds.some((runId) => runId.startsWith(target)); }
}

function normalizedInterruptParams(params: unknown): SubagentParamsLike {
	const target = normalizeTargetParams(params, "interrupt");
	for (const value of [target.id, target.runId]) {
		if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) throw new SubagentRpcError("invalid_params", "RPC interrupt id/runId must be a non-empty string.");
	}
	const normalized: SubagentParamsLike = { action: "interrupt", ...target };
	assertSubagentParams(normalized, "RPC interrupt params");
	return normalized;
}

async function handleRequest(
	request: SubagentRpcRequestEnvelope,
	options: RegisterSubagentRpcBridgeOptions,
	fleetKeys: FleetKeyState,
): Promise<unknown> {
	const ctx = options.getContext();
	if (!ctx) throw new SubagentRpcError("no_active_session", "No active extension context for subagent RPC.");

	if (request.method === "preflight") {
		if (!options.activeBoundRuntime) throw new SubagentRpcError("unsupported_method", "Active-bound preflight is unavailable.");
		const response = options.activeBoundRuntime.preflight(request.params);
		if ("code" in response) throw new SubagentRpcError(response.code === "no_active_session" ? "no_active_session" : "invalid_params", response.code);
		return response;
	}
	if (request.method === "spawn") {
		return executeChecked(options, ctx, request.requestId, request.method, spawnParams(request.params));
	}
	if (request.method === "status") {
		const statusParams: SubagentParamsLike = { action: "status", ...normalizeTargetParams(request.params, "status") };
		assertSubagentParams(statusParams, "RPC status params");
		const fleet = buildFleetStatus(options.state, fleetKeys, resolveCurrentSessionId(ctx.sessionManager));
		// The legacy management status text contains private foreground run IDs.
		// While a bound leaf is live, expose only its bounded opaque Fleet projection.
		if (privateBoundStatusRequested(statusParams, options, ctx)) return { text: "", fleet };
		const status = await executeChecked(options, ctx, request.requestId, request.method, statusParams);
		return { ...status, fleet };
	}
	if (request.method === "steer") {
		const params = steerParams(request.params);
		if (privateBoundStatusRequested(params, options, ctx, true)) throw new SubagentRpcError("not_found", "No steerable run found in this session.");
		return executeChecked(options, ctx, request.requestId, request.method, params);
	}
	if (request.method === "interrupt") {
		const params = normalizedInterruptParams(request.params);
		return executeChecked(options, ctx, request.requestId, request.method, params);
	}
	if (request.method === "stop") {
		return stopAsyncRun(request.params, options, ctx);
	}
	if (request.method === "resume") {
		const params = resumeParams(request.params);
		if (privateBoundStatusRequested(params, options, ctx)) throw new SubagentRpcError("not_found", "No resumable run found in this session.");
		return executeChecked(options, ctx, request.requestId, request.method, params);
	}
	throw new SubagentRpcError("unsupported_method", `Unsupported subagent RPC method: ${String(request.method)}`);
}

function parseRequest(input: unknown): SubagentRpcRequestEnvelope {
	let raw: Record<string, unknown>;
	if (ownDataField(input, "method") === "spawn") {
		if (!input || typeof input !== "object" || Array.isArray(input) || utilTypes.isProxy(input)) throw new SubagentRpcError("invalid_request", "Subagent RPC request must be a plain object.");
		const prototype = Object.getPrototypeOf(input); if (prototype !== Object.prototype && prototype !== null) throw new SubagentRpcError("invalid_request", "Subagent RPC request must be a plain object.");
		raw = {};
		for (const field of ["version", "requestId", "method", "params", "source"] as const) {
			const descriptor = Object.getOwnPropertyDescriptor(input, field); if (descriptor && (!("value" in descriptor) || !descriptor.enumerable)) throw new SubagentRpcError("invalid_request", "Subagent RPC request fields must be plain data.");
			if (!descriptor) continue;
			if (field === "params" && descriptor.value !== undefined) { const cloned = cloneJsonWithinByteLimit(descriptor.value, Number.MAX_SAFE_INTEGER, { omitUndefinedProperties: true }); if (!cloned.ok) throw new SubagentRpcError("invalid_request", "RPC spawn params must be plain JSON data."); raw[field] = cloned.value; }
			else raw[field] = descriptor.value;
		}
	} else {
		const cloned = cloneJsonWithinByteLimit(input, MAX_RPC_ENVELOPE_BYTES, { omitUndefinedProperties: true });
		if (!cloned.ok || !isRecord(cloned.value)) throw new SubagentRpcError("invalid_request", "Subagent RPC request must be bounded plain JSON data.");
		raw = cloned.value;
	}
	if (raw.version !== SUBAGENT_RPC_PROTOCOL_VERSION) {
		throw new SubagentRpcError("unsupported_version", `Unsupported subagent RPC version: ${String(raw.version)}.`);
	}
	if (typeof raw.method !== "string" || !(SUBAGENT_RPC_METHODS as readonly string[]).includes(raw.method)) {
		throw new SubagentRpcError("unsupported_method", `Unsupported subagent RPC method: ${String(raw.method)}.`);
	}
	const requestId = assertRequestId(raw.requestId, raw.method === "spawn");
	return {
		version: SUBAGENT_RPC_PROTOCOL_VERSION,
		requestId,
		method: raw.method as SubagentRpcMethod,
		...(raw.params !== undefined ? { params: raw.params } : {}),
		...(isRecord(raw.source) ? { source: raw.source as SubagentRpcRequestEnvelope["source"] } : {}),
	};
}

function ownDataField(raw: unknown, field: "requestId" | "method" | "params"): unknown {
	if (!raw || typeof raw !== "object" || Array.isArray(raw) || utilTypes.isProxy(raw)) return undefined;
	try { const descriptor = Object.getOwnPropertyDescriptor(raw, field); return descriptor && "value" in descriptor ? descriptor.value : undefined; }
	catch { return undefined; }
}

function safeReplyRequestId(raw: unknown): string {
	const requestId = ownDataField(raw, "requestId"); const method = ownDataField(raw, "method");
	return typeof requestId === "string" && requestId.trim().length > 0 && (method === "spawn" || Buffer.byteLength(requestId, "utf8") <= MAX_RPC_ENVELOPE_BYTES) && !/[\r\n]/.test(requestId) ? requestId : "unknown";
}

function errorReply(raw: unknown, error: unknown): SubagentRpcReplyEnvelope {
	const requestId = safeReplyRequestId(raw);
	const rawMethod = ownDataField(raw, "method");
	const method = typeof rawMethod === "string" && (SUBAGENT_RPC_METHODS as readonly string[]).includes(rawMethod) ? rawMethod as SubagentRpcMethod : undefined;
	const rpcError = error instanceof SubagentRpcError
		? error
		: new SubagentRpcError("execution_failed", error instanceof Error ? error.message : String(error));
	return {
		version: SUBAGENT_RPC_PROTOCOL_VERSION,
		requestId,
		...(method ? { method } : {}),
		success: false,
		error: {
			code: rpcError.code,
			message: rpcError.message,
		},
	};
}

export function registerSubagentRpcBridge(options: RegisterSubagentRpcBridgeOptions): {
	prepare: () => void;
	activate: () => void;
	stop: () => void;
	emitReady: (ctx?: ExtensionContext | null) => void;
	dispose: () => void;
} {
	const fleetKeys: FleetKeyState = { sessionId: null, next: 0, keys: new Map() };
	const source = options.sourceIdentityResolution ?? {
		available: false as const,
		sourceIdentityUnavailable: { version: 1 as const, reasonCode: "unverified_source" as const },
	};
	const identity = {
		serverInstanceId: options.serverInstanceId ?? randomUUID(),
		...(options.activeBoundRuntime ? { activeBoundRuntime: options.activeBoundRuntime } : {}),
		sourceIdentityResolution: source.available
			? { available: true as const, sourceIdentity: { ...source.sourceIdentity } }
			: { available: false as const, sourceIdentityUnavailable: { ...source.sourceIdentityUnavailable } },
	};
	let lifecycle: "passive" | "prepared" | "active" | "stopped" = "passive";
	let unsubscribed = false;
	const emitSuccess = (request: SubagentRpcRequestEnvelope, data: unknown): void => {
		options.events.emit(subagentRpcReplyEvent(request.requestId), {
			version: SUBAGENT_RPC_PROTOCOL_VERSION,
			requestId: request.requestId,
			method: request.method,
			success: true,
			data,
		} satisfies SubagentRpcReplyEnvelope);
	};
	const unsubscribe = options.events.on(SUBAGENT_RPC_REQUEST_EVENT, (raw) => {
		if (lifecycle === "passive" || lifecycle === "stopped") return;
		if (ownDataField(raw, "method") === "preflight") {
			const earlyTarget = activeBoundPreflightTarget(ownDataField(raw, "params"));
			if (earlyTarget && earlyTarget !== identity.serverInstanceId) return;
		}
		let request: SubagentRpcRequestEnvelope;
		try {
			request = parseRequest(raw);
		} catch (error) {
			if (lifecycle !== "active") return;
			const reply = errorReply(raw, error);
			options.events.emit(subagentRpcReplyEvent(reply.requestId), reply);
			return;
		}
		if (request.method === "preflight" && activeBoundPreflightTarget(request.params) !== identity.serverInstanceId) return;
		if (request.method === "preflight" && lifecycle === "active") {
			// Active preflight is a closed synchronous DTO. Domain failures remain
			// data-only and never expose diagnostics or receipt authority state.
			emitSuccess(request, options.activeBoundRuntime?.preflight(request.params) ?? { version: 1, code: "unverified_source" });
			return;
		}
		if (request.method === "ping") {
			// Reply-listener failures propagate as delivery failures. They must never
			// be reinterpreted as a second error reply for the same ping.
			emitSuccess(request, pingData(options.getContext(), identity));
			return;
		}
		if (lifecycle === "prepared") {
			void Promise.resolve().then(() => {
				if (lifecycle === "stopped") return;
				try {
					options.events.emit(subagentRpcReplyEvent(request.requestId), errorReply(
						request,
						new SubagentRpcError("no_active_session", "No active extension context for subagent RPC."),
					));
				} catch { /* isolate reply listener failures */ }
			});
			return;
		}
		void handleRequest(request, options, fleetKeys).then(
			(data) => {
				if (lifecycle !== "active") return;
				try { emitSuccess(request, data); } catch { /* isolate reply listener failures */ }
			},
			(error) => {
				if (lifecycle !== "active") return;
				try { options.events.emit(subagentRpcReplyEvent(request.requestId), errorReply(request, error)); } catch { /* isolate reply listener failures */ }
			},
		);
	});

	const stop = (): void => { lifecycle = "stopped"; };
	return {
		prepare: () => { if (lifecycle === "passive") lifecycle = "prepared"; },
		activate: () => { if (lifecycle === "prepared") lifecycle = "active"; },
		stop,
		emitReady: (ctx) => {
			if (lifecycle === "active") options.events.emit(SUBAGENT_RPC_READY_EVENT, pingData(ctx ?? options.getContext(), identity));
		},
		dispose: () => {
			stop();
			if (unsubscribed) return;
			unsubscribed = true;
			if (typeof unsubscribe === "function") unsubscribe();
		},
	};
}
