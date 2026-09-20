import { types as utilTypes } from "node:util";
import type { LaunchCancellationTokenV1, LaunchReceiptV1 } from "../api/launch-receipt.ts";
import { BOUND_RFC4122_UUID } from "./bound-request.ts";

export const BOUND_CHANNEL_VERSION = 2 as const;
export const BOUND_READY_EVENT = "subagents:bound:v2:ready";
export const BOUND_REQUEST_EVENT = "subagents:bound:v2:request";
export const BOUND_REPLY_EVENT_PREFIX = "subagents:bound:v2:reply:";
export const BOUND_LAUNCH_EVENT = "subagents:bound:v2:launch";
export const BOUND_STARTED_EVENT = "subagents:bound:v2:started";
export const BOUND_UPDATE_EVENT = "subagents:bound:v2:update";
export const BOUND_TERMINAL_EVENT = "subagents:bound:v2:terminal";
export const BOUND_CANCEL_EVENT = "subagents:bound:v2:cancel";

export const BOUND_CHANNEL_EVENTS = {
	ready: BOUND_READY_EVENT,
	request: BOUND_REQUEST_EVENT,
	replyPrefix: BOUND_REPLY_EVENT_PREFIX,
	launch: BOUND_LAUNCH_EVENT,
	started: BOUND_STARTED_EVENT,
	update: BOUND_UPDATE_EVENT,
	terminal: BOUND_TERMINAL_EVENT,
	cancel: BOUND_CANCEL_EVENT,
} as const;

export const BOUND_METHODS = ["ping", "preflight"] as const;
export type BoundMethod = typeof BOUND_METHODS[number];

export function boundReplyEvent(requestId: string): string {
	return `${BOUND_REPLY_EVENT_PREFIX}${requestId}`;
}

export interface BoundEventBus {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

export interface BoundRequestEnvelopeV2 {
	version: typeof BOUND_CHANNEL_VERSION;
	requestId: string;
	method: BoundMethod;
	params?: unknown;
}

export type BoundReplyEnvelopeV2 =
	| { version: typeof BOUND_CHANNEL_VERSION; requestId: string; method?: BoundMethod; success: true; data: unknown }
	| { version: typeof BOUND_CHANNEL_VERSION; requestId: string; method?: BoundMethod; success: false; error: { version: typeof BOUND_CHANNEL_VERSION; code: string } };

/** Bound-layer proof a client must return to launch or cancel the attempt it preflighted. */
export interface BoundBindingV2 {
	version: typeof BOUND_CHANNEL_VERSION;
	targetServerInstanceId: string;
	prospectiveRunId: string;
	expectedSourceIdentityDigest: string;
	expectedActiveSessionDigest: string;
	requestDigest: string;
	expectedLaunchContractDigest: string;
	receipt: LaunchReceiptV1;
	cancellationToken: LaunchCancellationTokenV1;
}

export interface BoundLaunchEnvelopeV2 {
	version: typeof BOUND_CHANNEL_VERSION;
	requestId: string;
	ownerRunId: string;
	nodeId: string;
	/** The exact v2 preflight request this launch was authorized for. */
	request: unknown;
	binding: unknown;
}

export interface BoundCancelEnvelopeV2 {
	version: typeof BOUND_CHANNEL_VERSION;
	requestId: string;
	ownerRunId: string;
	nodeId: string;
	targetServerInstanceId: string;
	binding: unknown;
}

const HEX_64 = /^[0-9a-f]{64}$/u;

function plainObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	return value as Record<string, unknown>;
}

/** Read an own data property without invoking accessors. */
export function ownValue(value: unknown, key: string): unknown {
	const record = plainObject(value);
	if (!record) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	return descriptor && "value" in descriptor && descriptor.enumerable ? descriptor.value : undefined;
}

function identity(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\r\n]/u.test(value);
}

export function parseBoundRequestEnvelope(raw: unknown): BoundRequestEnvelopeV2 | undefined {
	const record = plainObject(raw);
	if (!record) return undefined;
	const version = ownValue(record, "version");
	const requestId = ownValue(record, "requestId");
	const method = ownValue(record, "method");
	if (version !== BOUND_CHANNEL_VERSION || !identity(requestId) || typeof method !== "string"
		|| !(BOUND_METHODS as readonly string[]).includes(method)) return undefined;
	const params = ownValue(record, "params");
	return { version: BOUND_CHANNEL_VERSION, requestId, method: method as BoundMethod, ...(params !== undefined ? { params } : {}) };
}

export function parseBoundLaunchEnvelope(raw: unknown): BoundLaunchEnvelopeV2 | undefined {
	const record = plainObject(raw);
	if (!record) return undefined;
	const version = ownValue(record, "version");
	const requestId = ownValue(record, "requestId");
	const ownerRunId = ownValue(record, "ownerRunId");
	const nodeId = ownValue(record, "nodeId");
	if (version !== BOUND_CHANNEL_VERSION || !identity(requestId) || !identity(ownerRunId) || !identity(nodeId)) return undefined;
	return { version: BOUND_CHANNEL_VERSION, requestId, ownerRunId, nodeId, request: ownValue(record, "request"), binding: ownValue(record, "binding") };
}

export function parseBoundCancelEnvelope(raw: unknown): BoundCancelEnvelopeV2 | undefined {
	const record = plainObject(raw);
	if (!record) return undefined;
	const version = ownValue(record, "version");
	const requestId = ownValue(record, "requestId");
	const ownerRunId = ownValue(record, "ownerRunId");
	const nodeId = ownValue(record, "nodeId");
	const targetServerInstanceId = ownValue(record, "targetServerInstanceId");
	if (version !== BOUND_CHANNEL_VERSION || !identity(requestId) || !identity(ownerRunId) || !identity(nodeId)
		|| typeof targetServerInstanceId !== "string" || !BOUND_RFC4122_UUID.test(targetServerInstanceId)) return undefined;
	return { version: BOUND_CHANNEL_VERSION, requestId, ownerRunId, nodeId, targetServerInstanceId, binding: ownValue(record, "binding") };
}

/** Descriptor-safe routing key: which responder a launch or cancel addresses. */
export function boundBindingTarget(binding: unknown): string | undefined {
	const target = ownValue(binding, "targetServerInstanceId");
	return typeof target === "string" && BOUND_RFC4122_UUID.test(target) ? target : undefined;
}

/** Shape check only; authenticity is the receipt service's job. */
export function parseBoundBindingProof(raw: unknown): BoundBindingV2 | undefined {
	const record = plainObject(raw);
	if (!record) return undefined;
	const keys = Object.keys(record).sort().join(",");
	if (keys !== "cancellationToken,expectedActiveSessionDigest,expectedLaunchContractDigest,expectedSourceIdentityDigest,prospectiveRunId,receipt,requestDigest,targetServerInstanceId,version") return undefined;
	const target = ownValue(record, "targetServerInstanceId");
	const prospectiveRunId = ownValue(record, "prospectiveRunId");
	const digests = ["expectedSourceIdentityDigest", "expectedActiveSessionDigest", "requestDigest", "expectedLaunchContractDigest"].map((key) => ownValue(record, key));
	if (ownValue(record, "version") !== BOUND_CHANNEL_VERSION
		|| typeof target !== "string" || !BOUND_RFC4122_UUID.test(target)
		|| typeof prospectiveRunId !== "string" || !BOUND_RFC4122_UUID.test(prospectiveRunId)
		|| !digests.every((value) => typeof value === "string" && HEX_64.test(value))) return undefined;
	const receipt = ownValue(record, "receipt");
	const cancellationToken = ownValue(record, "cancellationToken");
	if (!plainObject(receipt) || !plainObject(cancellationToken)) return undefined;
	return {
		version: BOUND_CHANNEL_VERSION,
		targetServerInstanceId: target,
		prospectiveRunId,
		expectedSourceIdentityDigest: digests[0] as string,
		expectedActiveSessionDigest: digests[1] as string,
		requestDigest: digests[2] as string,
		expectedLaunchContractDigest: digests[3] as string,
		receipt: receipt as unknown as LaunchReceiptV1,
		cancellationToken: cancellationToken as unknown as LaunchCancellationTokenV1,
	};
}
