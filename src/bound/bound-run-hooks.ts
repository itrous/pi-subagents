import type { ChildHookExtension } from "../runs/shared/child-session.ts";
import type { BoundRunRegistryV1 } from "./bound-run-registry.ts";

export const BOUND_RUN_HOOK_NAME = "<inline:pi-subagents:bound-run>";
export const BOUND_DENIED_TOOL_REASON = "pi-subagents bound leaf: the tool is not declared by the launch contract.";

interface HookSessionContext {
	sessionManager: { getSessionId(): string | null | undefined };
}

/**
 * Inline hook of one bound run; it must be the first hook of the launch so its
 * `tool_call` handler runs before any other.
 *
 * Bindings are held in the registry record and published under the id of the
 * session whose own `session_start` this is — the CHILD session, which is the
 * id the consuming extension reads (fact S4). The parent session id is never a
 * key here.
 */
export function createBoundRunHook(input: {
	runId: string;
	registry: BoundRunRegistryV1;
	allowedTools: readonly string[];
}): ChildHookExtension {
	const allowed = new Set(input.allowedTools);
	return {
		name: BOUND_RUN_HOOK_NAME,
		factory: (pi) => {
			let publishedSessionId: string | undefined;
			pi.on("tool_call", (event) => {
				if (allowed.has(event.toolName)) return undefined;
				input.registry.get(input.runId)?.denials.record(event.toolName);
				return { block: true, reason: BOUND_DENIED_TOOL_REASON };
			});
			pi.on("session_start", (_event, ctx) => {
				let sessionId: string | null | undefined;
				try { sessionId = (ctx as HookSessionContext).sessionManager.getSessionId(); } catch { sessionId = undefined; }
				if (typeof sessionId !== "string" || !sessionId) return;
				if (input.registry.publishSessionBindings(sessionId, input.runId)) publishedSessionId = sessionId;
			});
			pi.on("session_shutdown", () => {
				if (publishedSessionId === undefined) return;
				input.registry.unpublishSessionBindings(publishedSessionId, input.runId);
				publishedSessionId = undefined;
			});
		},
	};
}
