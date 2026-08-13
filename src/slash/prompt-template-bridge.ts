import { randomUUID } from "node:crypto";
import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
	SUBAGENT_DELEGATION_UPDATE_EVENT,
	type SubagentDelegationInvalidResponse,
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
} from "../api/delegation.ts";
import { parseSubagentDelegationRequest } from "./delegation-request.ts";
import {
	parsePromptTemplateRequest,
	toSubagentDelegationExecutionParams,
	toSubagentDelegationResponse,
	toSubagentDelegationUpdate,
	type DelegatedSubagentExecutionParams,
	type PromptTemplateBridgeResult,
	type PromptTemplateDelegationResponse,
} from "./delegation-adapters.ts";
import { getStructuredAttemptCoordinator, type StructuredAttemptCoordinator } from "./structured-attempt-coordinator.ts";

export const PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT = SUBAGENT_DELEGATION_REQUEST_EVENT;
export const PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT = SUBAGENT_DELEGATION_STARTED_EVENT;
export const PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT = SUBAGENT_DELEGATION_RESPONSE_EVENT;
export const PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT = SUBAGENT_DELEGATION_UPDATE_EVENT;
export const PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT = SUBAGENT_DELEGATION_CANCEL_EVENT;

export interface PromptTemplateBridgeEvents {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

interface PromptTemplateBridgeOptions<Ctx extends { cwd?: string }> {
	events: PromptTemplateBridgeEvents;
	getContext: () => Ctx | null;
	execute: (
		requestId: string,
		params: DelegatedSubagentExecutionParams,
		signal: AbortSignal,
		ctx: Ctx,
		onUpdate: (result: PromptTemplateBridgeResult) => void,
	) => Promise<PromptTemplateBridgeResult>;
	executeStructured?: (
		requestId: string,
		params: DelegatedSubagentExecutionParams,
		signal: AbortSignal,
		ctx: Ctx,
		onUpdate: (result: PromptTemplateBridgeResult) => void,
	) => Promise<PromptTemplateBridgeResult>;
	runtimeId?: string;
	coordinator?: StructuredAttemptCoordinator;
}

function hasStructuredDelegationMarker(data: unknown): boolean {
	if (!data || typeof data !== "object" || Array.isArray(data)) return false;
	const value = data as Record<string, unknown>;
	return Object.hasOwn(value, "ownerRunId") || Object.hasOwn(value, "nodeId")
		|| Object.hasOwn(value, "result") || Object.hasOwn(value, "version");
}

function validId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\r\n]/.test(value);
}

export function registerPromptTemplateDelegationBridge<Ctx extends { cwd?: string }>(
	options: PromptTemplateBridgeOptions<Ctx>,
): {
	activate: () => void;
	activateTerminalSink: () => void;
	stop: (options?: { preserveSink?: boolean }) => void;
	cancelAll: () => void;
	drain: () => Promise<void>;
	hasDraining: () => boolean;
	dispose: () => void;
	runtimeId: string;
} {
	const coordinator = options.coordinator ?? getStructuredAttemptCoordinator();
	const runtimeId = options.runtimeId ?? randomUUID();
	const subscriptions: Array<() => void> = [];
	let active = false;
	let stopped = false;

	const subscribe = (event: string, handler: (data: unknown) => void): void => {
		const unsubscribe = options.events.on(event, handler);
		if (typeof unsubscribe === "function") subscriptions.push(unsubscribe);
	};

	subscribe(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, (data) => {
		if (!active || stopped || !data || typeof data !== "object" || Array.isArray(data)) return;
		const value = data as Record<string, unknown>;
		if (!validId(value.requestId) || !validId(value.ownerRunId) || !validId(value.nodeId)) return;
		if (Object.keys(value).some((key) => key !== "requestId" && key !== "ownerRunId" && key !== "nodeId")) return;
		coordinator.cancel(value.requestId, value.ownerRunId, value.nodeId);
	});

	subscribe(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
		if (!active || stopped) return;
		if (!hasStructuredDelegationMarker(data)) {
			if (data && typeof data === "object" && !Array.isArray(data)) {
				const legacy = data as Record<string, unknown>;
				if ((legacy.tasks !== undefined || legacy.worktree !== undefined)
					&& typeof legacy.requestId === "string" && legacy.requestId.length > 0) {
					options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
						requestId: legacy.requestId, messages: [], isError: true,
						errorText: "Legacy prompt-template tasks/worktree orchestration was removed; use workflowScript.",
					});
					return;
				}
			}
			const legacy = parsePromptTemplateRequest(data);
			if (legacy) options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...legacy, messages: [], isError: true,
				errorText: "Legacy prompt-template direct delegation was removed; use workflowScript through the subagent tool or structured delegation.",
			} satisfies PromptTemplateDelegationResponse);
			return;
		}

		const parsed = parseSubagentDelegationRequest(data);
		if (parsed.ok === false) {
			if (!parsed.requestId) return;
			const terminal = {
				requestId: parsed.requestId,
				...(parsed.ownerRunId ? { ownerRunId: parsed.ownerRunId } : {}),
				...(parsed.nodeId ? { nodeId: parsed.nodeId } : {}),
				status: "invalid_request", error: parsed.error,
			} satisfies SubagentDelegationInvalidResponse;
			if (parsed.ownerRunId && parsed.nodeId) {
				const committed = coordinator.commitRejected({
					requestId: parsed.requestId,
					ownerRunId: parsed.ownerRunId,
					nodeId: parsed.nodeId,
				}, runtimeId, terminal);
				if (committed === "capacity") options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					requestId: parsed.requestId, ownerRunId: parsed.ownerRunId, nodeId: parsed.nodeId,
					status: "unavailable_context", error: "Delegation identity capacity is exhausted for this process.",
				} satisfies SubagentDelegationResponse);
			} else {
				options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, terminal);
			}
			return;
		}
		void executeStructured(parsed.request);
	});

	async function executeStructured(request: SubagentDelegationRequest): Promise<void> {
		if (!active || stopped) return;
		const admission = coordinator.admit(request, runtimeId);
		if (!admission.accepted) {
			if (admission.reason === "duplicate_node") {
				const committed = coordinator.commitRejected(request, runtimeId, {
					requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, status: "duplicate_node",
				});
				if (committed === "capacity") options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId,
					status: "unavailable_context", error: "Delegation identity capacity is exhausted for this process.",
				} satisfies SubagentDelegationResponse);
			} else if (admission.reason === "capacity") options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId,
				status: "unavailable_context", error: "Delegation identity capacity is exhausted for this process.",
			} satisfies SubagentDelegationResponse);
			return;
		}
		try {
			if (admission.signal.aborted) {
				admission.settle({ requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, status: "cancelled" });
				return;
			}
			const ctx = options.getContext();
			if (!ctx) {
				admission.settle({
					requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId,
					status: "unavailable_context", error: "No active extension context for delegated subagent execution.",
				});
				return;
			}
			options.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, {
				requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId,
			});
			if (!active || stopped || admission.signal.aborted) {
				admission.settle({ requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, status: "cancelled" });
				return;
			}
			const executor = options.executeStructured ?? options.execute;
			const result = await executor(
				request.requestId,
				toSubagentDelegationExecutionParams(request),
				admission.signal,
				ctx,
				(update) => {
					if (!active || stopped || admission.signal.aborted || !admission.isRunning()) return;
					const payload = toSubagentDelegationUpdate(request, update);
					if (payload) options.events.emit(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, payload);
				},
			);
			admission.settle(toSubagentDelegationResponse(request, result, admission.signal.aborted));
		} catch (error) {
			admission.settle({
				requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId,
				status: admission.signal.aborted ? "cancelled" : "failed",
				...(admission.signal.aborted ? {} : { error: error instanceof Error ? error.message : String(error) }),
			});
		}
	}

	const stop = (stopOptions: { preserveSink?: boolean } = {}): void => {
		if (stopped) return;
		stopped = true;
		active = false;
		coordinator.stopOwner(runtimeId);
		if (!stopOptions.preserveSink) coordinator.deactivateSink(runtimeId);
	};

	return {
		runtimeId,
		activate: () => { if (!stopped) active = true; },
		activateTerminalSink: () => {
			if (!stopped) coordinator.activateSink(runtimeId, (terminal) => options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, terminal));
		},
		stop,
		cancelAll: stop,
		drain: () => coordinator.drainOwner(runtimeId),
		hasDraining: () => coordinator.hasDrainingOwner(runtimeId),
		dispose: () => {
			stop();
			coordinator.deactivateSink(runtimeId);
			for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
		},
	};
}
