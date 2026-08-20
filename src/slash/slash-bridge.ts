import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizePublicSubagentExecution } from "../extension/public-execution.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import {
	SLASH_SUBAGENT_CANCEL_EVENT,
	SLASH_SUBAGENT_REQUEST_EVENT,
	SLASH_SUBAGENT_RESPONSE_EVENT,
	SLASH_SUBAGENT_STARTED_EVENT,
	SLASH_SUBAGENT_UPDATE_EVENT,
	type Details,
} from "../shared/types.ts";

interface SlashSubagentRequest {
	requestId: string;
	params: SubagentParamsLike;
	/** Optional requester context for in-process extension bridge calls. */
	ctx?: ExtensionContext;
}

export interface SlashSubagentResponse {
	requestId: string;
	result: AgentToolResult<Details>;
	isError: boolean;
	errorText?: string;
}

export interface SlashSubagentUpdate {
	requestId: string;
	progress?: Details["progress"];
	currentTool?: string;
	toolCount?: number;
}

interface EventBus {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

interface SlashBridgeOptions {
	events: EventBus;
	getContext: () => ExtensionContext | null;
	execute: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
}

export function registerSlashSubagentBridge(options: SlashBridgeOptions): {
	activate: () => void;
	stop: () => void;
	cancelAll: () => void;
	dispose: () => void;
} {
	const controllers = new Map<string, AbortController>();
	const pendingCancels = new Set<string>();
	const subscriptions: Array<() => void> = [];
	let active = false;
	let stopped = false;

	const subscribe = (event: string, handler: (data: unknown) => void): void => {
		const unsubscribe = options.events.on(event, handler);
		if (typeof unsubscribe === "function") subscriptions.push(unsubscribe);
	};

	subscribe(SLASH_SUBAGENT_CANCEL_EVENT, (data) => {
		if (!active || stopped || !data || typeof data !== "object") return;
		const requestId = (data as { requestId?: unknown }).requestId;
		if (typeof requestId !== "string") return;
		const controller = controllers.get(requestId);
		if (controller) {
			controller.abort();
			return;
		}
		pendingCancels.add(requestId);
	});

	subscribe(SLASH_SUBAGENT_REQUEST_EVENT, async (data) => {
		if (!active || stopped || !data || typeof data !== "object") return;
		const request = data as Partial<SlashSubagentRequest>;
		if (typeof request.requestId !== "string" || !request.params) return;
		const { requestId } = request as SlashSubagentRequest;
		if (controllers.has(requestId)) return;
		const normalized = normalizePublicSubagentExecution((request as SlashSubagentRequest).params);
		if (!normalized.ok) {
			options.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId,
				result: {
					content: [{ type: "text", text: normalized.error }],
					isError: true,
					details: { mode: normalized.mode, results: [] },
				},
				isError: true,
				errorText: normalized.error,
			} satisfies SlashSubagentResponse);
			return;
		}
		const params = normalized.params;

		const ctx = request.ctx ?? options.getContext();
		if (!ctx) {
			const response: SlashSubagentResponse = {
				requestId,
				result: {
					content: [{ type: "text", text: "No active extension context for slash subagent execution." }],
					details: { mode: "single" as const, results: [] },
				},
				isError: true,
				errorText: "No active extension context.",
			};
			options.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, response);
			return;
		}

		const controller = new AbortController();
		controllers.set(requestId, controller);

		if (pendingCancels.delete(requestId)) {
			controller.abort();
			const response: SlashSubagentResponse = {
				requestId,
				result: {
					content: [{ type: "text", text: "Cancelled." }],
					details: { mode: "single" as const, results: [] },
				},
				isError: true,
				errorText: "Cancelled before start.",
			};
			options.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, response);
			controllers.delete(requestId);
			return;
		}

		try {
			options.events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
			if (!active || stopped || controller.signal.aborted || controllers.get(requestId) !== controller) return;
			const result = await options.execute(
				requestId,
				params,
				controller.signal,
				(update) => {
					if (!active || stopped || controllers.get(requestId) !== controller) return;
					const progress = update.details?.progress;
					const first = progress?.[0];
					const payload: SlashSubagentUpdate = {
						requestId,
						progress,
						currentTool: first?.currentTool,
						toolCount: first?.toolCount,
					};
					options.events.emit(SLASH_SUBAGENT_UPDATE_EVENT, payload);
				},
				ctx,
			);

			if (!active || stopped || controllers.get(requestId) !== controller) return;
			const response: SlashSubagentResponse = {
				requestId,
				result,
				isError: (result as { isError?: boolean }).isError === true,
				errorText: (result as { isError?: boolean }).isError
					? result.content.find((c) => c.type === "text")?.text
					: undefined,
			};
			options.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, response);
		} catch (error) {
			if (!active || stopped || controllers.get(requestId) !== controller) return;
			const response: SlashSubagentResponse = {
				requestId,
				result: {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: { mode: "single" as const, results: [] },
				},
				isError: true,
				errorText: error instanceof Error ? error.message : String(error),
			};
			options.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, response);
		} finally {
			if (controllers.get(requestId) === controller) controllers.delete(requestId);
		}
	});

	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		active = false;
		for (const controller of controllers.values()) controller.abort();
		controllers.clear();
		pendingCancels.clear();
	};
	return {
		activate: () => { if (!stopped) active = true; },
		stop,
		cancelAll: stop,
		dispose: () => {
			stop();
			for (const unsubscribe of subscriptions) unsubscribe();
			subscriptions.length = 0;
		},
	};
}
