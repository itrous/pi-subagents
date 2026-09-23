import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BOUND_BINDINGS_NAMESPACE, type BoundBindingsV1 } from "./bound-bindings.ts";

export const BOUND_SESSION_BINDINGS_VERSION = 1 as const;
export const BOUND_SESSION_BINDINGS_REQUEST_EVENT = "subagents:bound:bindings:v1:request";
export const BOUND_SESSION_BINDINGS_REPLY_PREFIX = "subagents:bound:bindings:v1:reply:";

export function boundSessionBindingsReplyEvent(requestId: string): string {
	return `${BOUND_SESSION_BINDINGS_REPLY_PREFIX}${requestId}`;
}

/** What the run's own registry entry says about one child session of that run. */
export interface BoundSessionBindingsEntry {
	cwd: string;
	bindings: Readonly<BoundBindingsV1>;
	valuesDigest: string;
}

export interface BoundSessionBindingsDataV1 {
	version: typeof BOUND_SESSION_BINDINGS_VERSION;
	namespace: typeof BOUND_BINDINGS_NAMESPACE;
	sessionId: string;
	cwd: string;
	bindings: Readonly<BoundBindingsV1>;
	valuesDigest: string;
}

export type BoundSessionBindingsReplyV1 =
	| { version: typeof BOUND_SESSION_BINDINGS_VERSION; requestId: string; success: true; data: BoundSessionBindingsDataV1 }
	| { version: typeof BOUND_SESSION_BINDINGS_VERSION; requestId: string; success: false; error: { version: typeof BOUND_SESSION_BINDINGS_VERSION; code: "invalid_request" | "unknown_session" } };

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const FIELDS = "requestId,sessionId,version";

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

/** Descriptor-safe: never invokes an accessor or a Proxy trap of the caller's object. */
function parseRequest(raw: unknown): { requestId?: string; sessionId?: string; valid: boolean } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw) || utilTypes.isProxy(raw)) return { valid: false };
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== Object.prototype && prototype !== null) return { valid: false };
	const read = (key: string): unknown => {
		const descriptor = Object.getOwnPropertyDescriptor(raw, key);
		return descriptor && "value" in descriptor && descriptor.enumerable ? descriptor.value : undefined;
	};
	const requestId = read("requestId");
	const usableId = typeof requestId === "string" && REQUEST_ID.test(requestId) ? requestId : undefined;
	const keys = Reflect.ownKeys(raw);
	const sessionId = read("sessionId");
	const valid = usableId !== undefined
		&& keys.every((key) => typeof key === "string") && [...keys as string[]].sort().join(",") === FIELDS
		&& keys.every((key) => { const descriptor = Object.getOwnPropertyDescriptor(raw, key)!; return "value" in descriptor && descriptor.enumerable; })
		&& read("version") === BOUND_SESSION_BINDINGS_VERSION
		&& typeof sessionId === "string" && sessionId.trim().length > 0 && !/[\r\n\0]/u.test(sessionId)
		&& Buffer.byteLength(sessionId, "utf8") <= 256;
	return { ...(usableId ? { requestId: usableId } : {}), ...(valid ? { sessionId: sessionId as string } : {}), valid };
}

/**
 * Responder on the run's private package bus (subplan A1R.6, sub-stage 2). Only
 * the package factories of this run can reach that bus; `lookup` answers only
 * for sessions this run published, so a request can read nothing but its own
 * run's bindings. The reply is emitted synchronously inside the request's
 * `emit`: a consumer subscribes to its reply event first.
 */
export function installBoundSessionBindingsResponder(
	events: ExtensionAPI["events"],
	lookup: (sessionId: string) => BoundSessionBindingsEntry | undefined,
): () => void {
	return events.on(BOUND_SESSION_BINDINGS_REQUEST_EVENT, (raw) => {
		const request = parseRequest(raw);
		if (!request.requestId) return;
		const reply = (message: BoundSessionBindingsReplyV1): void => { events.emit(boundSessionBindingsReplyEvent(request.requestId!), deepFreeze(message)); };
		if (!request.valid || request.sessionId === undefined) {
			reply({ version: 1, requestId: request.requestId, success: false, error: { version: 1, code: "invalid_request" } });
			return;
		}
		let entry: BoundSessionBindingsEntry | undefined;
		try { entry = lookup(request.sessionId); } catch { entry = undefined; }
		if (!entry) {
			reply({ version: 1, requestId: request.requestId, success: false, error: { version: 1, code: "unknown_session" } });
			return;
		}
		reply({
			version: 1, requestId: request.requestId, success: true,
			data: {
				version: 1, namespace: BOUND_BINDINGS_NAMESPACE, sessionId: request.sessionId,
				cwd: entry.cwd, bindings: { ...entry.bindings }, valuesDigest: entry.valuesDigest,
			},
		});
	}) as () => void;
}
