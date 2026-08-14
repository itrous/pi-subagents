import { randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";
import { activeBoundRequestFromDelegation, type ActiveBoundRuntimeService } from "../api/active-bound-runtime.ts";
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
import { parseSubagentDelegationRequest, subagentDelegationBindingTarget } from "./delegation-request.ts";
import {
	parsePromptTemplateRequest,
	toSubagentDelegationExecutionParams,
	toSubagentDelegationResponse,
	toSubagentDelegationUpdate,
	type DelegatedSubagentExecutionParams,
	type PromptTemplateBridgeResult,
	type PromptTemplateDelegationResponse,
} from "./delegation-adapters.ts";
import { getBoundIdentityRegistry, type BoundIdentityRegistryV1 } from "./bound-identity-registry.ts";
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
	activeBoundRuntime?: ActiveBoundRuntimeService;
	serverInstanceId?: string;
	boundIdentityRegistry?: BoundIdentityRegistryV1;
}

function hasStructuredDelegationMarker(data: unknown): boolean {
	if (!data || typeof data !== "object" || Array.isArray(data)) return false;
	if (utilTypes.isProxy(data)) return true;
	const descriptors = Object.getOwnPropertyDescriptors(data);
	return ["ownerRunId", "nodeId", "result", "version"].some((key) => key in descriptors);
}

function hasBindingMarker(data: unknown): boolean {
	if (!data || typeof data !== "object" || Array.isArray(data) || utilTypes.isProxy(data)) return false;
	const descriptor = Object.getOwnPropertyDescriptor(data, "binding");
	return Boolean(descriptor && "value" in descriptor && descriptor.value !== undefined);
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
	const boundRegistry = options.activeBoundRuntime ? options.boundIdentityRegistry ?? getBoundIdentityRegistry() : undefined;
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

		const boundMarker = hasBindingMarker(data);
		const bindingTarget = subagentDelegationBindingTarget(data);
		const targetServerInstanceId = options.activeBoundRuntime?.serverInstanceId ?? options.serverInstanceId;
		if (boundMarker && !bindingTarget) return;
		if (bindingTarget && targetServerInstanceId && bindingTarget !== targetServerInstanceId) return;
		const parsed = parseSubagentDelegationRequest(data);
		if (parsed.ok === false) {
			if (!parsed.requestId) return;
			const terminal = {
				requestId: parsed.requestId,
				...(parsed.ownerRunId ? { ownerRunId: parsed.ownerRunId } : {}),
				...(parsed.nodeId ? { nodeId: parsed.nodeId } : {}),
				status: "invalid_request", error: parsed.error,
			} satisfies SubagentDelegationInvalidResponse;
			if (bindingTarget && parsed.ownerRunId && parsed.nodeId) {
				try { options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, terminal); } catch { /* rejected bound proof owns no coordinator state */ }
			} else if (parsed.ownerRunId && parsed.nodeId) {
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
		executeStructured(parsed.request);
	});

	function rejectBound(request: SubagentDelegationRequest, status: "invalid_request" | "unavailable_context" | "duplicate_node", error?: string): void {
		// A rejected bound request never owns coordinator node state. Emitting its
		// terminal directly avoids replacing an already-running node owner.
		try {
			options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, status,
				...(error ? { error } : {}),
			} satisfies SubagentDelegationResponse);
		} catch { /* direct rejected terminal is one-shot even when a listener throws */ }
	}

	function executeStructured(request: SubagentDelegationRequest): void {
		if (!active || stopped) return;
		let prospectiveReservation: { serverInstanceId: string; prospectiveRunId: string } | undefined;
		let boundProof;
		if (request.binding) {
			const runtime = options.activeBoundRuntime;
			if (!runtime) {
				if (request.binding.targetServerInstanceId === options.serverInstanceId) rejectBound(request, "unavailable_context", "Active-bound runtime is unavailable.");
				return;
			}
			if (request.binding.targetServerInstanceId !== runtime.serverInstanceId) return;
			if (!boundRegistry) { rejectBound(request, "unavailable_context", "Active-bound identity registry is unavailable."); return; }
			const reserve = boundRegistry.reserve(runtime.serverInstanceId, request.binding.prospectiveRunId);
			if (reserve === "duplicate") { rejectBound(request, "duplicate_node"); return; }
			if (reserve === "capacity") { rejectBound(request, "unavailable_context", "Active-bound identity capacity is exhausted for this process."); return; }
			prospectiveReservation = { serverInstanceId: runtime.serverInstanceId, prospectiveRunId: request.binding.prospectiveRunId };
			const boundRequest = activeBoundRequestFromDelegation(request as Parameters<typeof activeBoundRequestFromDelegation>[0], request.binding);
			const verified = runtime.admit(boundRequest, request.binding);
			if (!verified.ok) {
				boundRegistry.release(runtime.serverInstanceId, request.binding.prospectiveRunId);
				prospectiveReservation = undefined;
				rejectBound(request, verified.code);
				return;
			}
			boundProof = verified.proof;
		}
		const admission = coordinator.admit(request, runtimeId);
		if (!admission.accepted) {
			if (prospectiveReservation) boundRegistry!.release(prospectiveReservation.serverInstanceId, prospectiveReservation.prospectiveRunId);
			if (request.binding) {
				rejectBound(request, admission.reason === "capacity" ? "unavailable_context" : "duplicate_node",
					admission.reason === "capacity" ? "Delegation identity capacity is exhausted for this process." : undefined);
				return;
			}
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
		if (prospectiveReservation && !boundRegistry!.commit(prospectiveReservation.serverInstanceId, prospectiveReservation.prospectiveRunId)) {
			admission.settle({ requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, status: "duplicate_node" });
			return;
		}
		void (async () => {
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
			const executionParams = toSubagentDelegationExecutionParams(request);
			if (boundProof) {
				executionParams.activeBoundProof = boundProof;
				executionParams.share = false;
				executionParams.mission = false;
			}
			const result = await executor(
				request.requestId,
				executionParams,
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
		})();
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
