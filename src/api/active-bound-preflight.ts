import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";
import { cloneJsonWithinByteLimit } from "../slash/delegation-json.ts";
import { canonicalSha256 } from "../shared/canonical-json.ts";
import { parseActiveBoundEnvironment, type ActiveBoundEnvironmentV1 } from "./active-bound-environment.ts";
import type {
	SubagentDelegationJsonSchemaObject,
	SubagentDelegationThinking,
	SubagentDelegationToolBudget,
	SubagentDelegationTurnBudget,
} from "./delegation.ts";

export const ACTIVE_BOUND_PREFLIGHT_VERSION = 1 as const;
const RFC4122_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MODEL = /^[^\s/:]+\/[^\s:]+$/u;
const THINKING = new Set<SubagentDelegationThinking>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const FIELDS = new Set(["version", "targetServerInstanceId", "requestId", "ownerRunId", "nodeId", "prospectiveRunId", "agent", "task", "cwd", "context", "model", "thinking", "timeoutMs", "turnBudget", "toolBudget", "skill", "artifacts", "environment", "result"]);
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_REQUEST_CLONE_BYTES = 8 * 1024 * 1024;
const MAX_TASK_BYTES = 1024 * 1024;
const MAX_CWD_BYTES = 32 * 1024;
const MAX_SHORT_BYTES = 1024;

export interface ActiveBoundPreflightRequestV1 {
	version: typeof ACTIVE_BOUND_PREFLIGHT_VERSION;
	targetServerInstanceId: string;
	requestId: string;
	ownerRunId: string;
	nodeId: string;
	prospectiveRunId: string;
	agent: string;
	task: string;
	cwd: string;
	context: "fresh";
	model: string;
	thinking: SubagentDelegationThinking;
	timeoutMs?: number;
	turnBudget?: SubagentDelegationTurnBudget;
	toolBudget?: SubagentDelegationToolBudget;
	skill?: string | string[] | false;
	environment?: ActiveBoundEnvironmentV1;
	artifacts: false;
	result: { kind: "text" } | { kind: "structured"; schema: SubagentDelegationJsonSchemaObject };
}

export type ActiveBoundPreflightParseResult =
	| { ok: true; request: ActiveBoundPreflightRequestV1 }
	| { ok: false; code: "invalid_request" };

function fail(): ActiveBoundPreflightParseResult { return { ok: false, code: "invalid_request" }; }
function text(value: unknown, max = MAX_SHORT_BYTES): value is string {
	return typeof value === "string" && value.trim().length > 0 && !/[\r\n]/u.test(value) && Buffer.byteLength(value, "utf8") <= max;
}
function identity(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\r\n]/u.test(value);
}
function content(value: unknown, max: number): value is string {
	if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0") || Buffer.byteLength(value, "utf8") > max) return false;
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index++;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
	}
	return true;
}
function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}
function exactFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}
function plainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function parseTurnBudget(value: unknown): SubagentDelegationTurnBudget | undefined | null {
	if (value === undefined) return undefined;
	if (!plainRecord(value) || !exactFields(value, new Set(["maxTurns", "graceTurns"]))) return null;
	if (!Number.isSafeInteger(value.maxTurns) || (value.maxTurns as number) < 1) return null;
	if (value.graceTurns !== undefined && (!Number.isSafeInteger(value.graceTurns) || (value.graceTurns as number) < 0)) return null;
	return { maxTurns: value.maxTurns as number, ...(value.graceTurns !== undefined ? { graceTurns: value.graceTurns as number } : {}) };
}
function parseToolBudget(value: unknown): SubagentDelegationToolBudget | undefined | null {
	if (value === undefined) return undefined;
	if (!plainRecord(value) || !exactFields(value, new Set(["soft", "hard", "block"]))) return null;
	if (!Number.isSafeInteger(value.hard) || (value.hard as number) < 0) return null;
	if (value.soft !== undefined && (!Number.isSafeInteger(value.soft) || (value.soft as number) < 1 || (value.soft as number) > (value.hard as number))) return null;
	let block: string[] | "*" | undefined;
	if (value.block !== undefined) {
		if (value.block === "*") block = "*";
		else if (Array.isArray(value.block) && value.block.length > 0 && value.block.length <= 256 && value.block.every((entry) => text(entry))) block = [...value.block];
		else return null;
	}
	return { ...(value.soft !== undefined ? { soft: value.soft as number } : {}), hard: value.hard as number, ...(block !== undefined ? { block } : {}) };
}

/** Descriptor-safe target extraction used to keep multi-responder routing unambiguous. */
export function activeBoundPreflightTarget(input: unknown): string | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input) || utilTypes.isProxy(input)) return undefined;
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(input, "targetServerInstanceId");
	return descriptor && "value" in descriptor && typeof descriptor.value === "string" && RFC4122_UUID.test(descriptor.value)
		? descriptor.value
		: undefined;
}

function omitActiveOptionalUndefined(value: unknown, allowed: ReadonlySet<string>): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return value;
	const prototype = Object.getPrototypeOf(value); const keys = Reflect.ownKeys(value);
	if ((prototype !== Object.prototype && prototype !== null) || !keys.every((key): key is string => typeof key === "string" && allowed.has(key))) return value;
	const output: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
		if (!("value" in descriptor) || !descriptor.enumerable) return value;
		if (descriptor.value !== undefined) output[key] = descriptor.value;
	}
	return output;
}

/** Descriptor-safe closed parser. It clones before inspecting any caller property. */
export function parseActiveBoundPreflightRequest(input: unknown): ActiveBoundPreflightParseResult {
	let cloneInput = input;
	if (input && typeof input === "object" && !Array.isArray(input) && !utilTypes.isProxy(input)) {
		const prototype = Object.getPrototypeOf(input);
		const keys = Reflect.ownKeys(input);
		if ((prototype === Object.prototype || prototype === null) && keys.every((key): key is string => typeof key === "string" && FIELDS.has(key))) {
			const prepared: Record<string, unknown> = Object.create(null); let safe = true;
			for (const key of keys) {
				const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
				if (!("value" in descriptor) || !descriptor.enumerable) { safe = false; break; }
				if (descriptor.value !== undefined) {
					prepared[key] = key === "turnBudget"
						? omitActiveOptionalUndefined(descriptor.value, new Set(["maxTurns", "graceTurns"]))
						: key === "toolBudget"
							? omitActiveOptionalUndefined(descriptor.value, new Set(["soft", "hard", "block"]))
							: key === "environment"
								? omitActiveOptionalUndefined(descriptor.value, new Set(["ONECPI_REVIEW_ROOT", "ONECPI_REVIEW_SUBJECT_PATH"]))
								: descriptor.value;
				}
			}
			if (safe) cloneInput = prepared;
		}
	}
	const cloned = cloneJsonWithinByteLimit(cloneInput, MAX_REQUEST_CLONE_BYTES);
	if (!cloned.ok || !plainRecord(cloned.value)) return fail();
	const value = cloned.value;
	if (!exactFields(value, FIELDS) || value.version !== 1) return fail();
	if (typeof value.targetServerInstanceId !== "string" || !RFC4122_UUID.test(value.targetServerInstanceId)
		|| !identity(value.requestId) || !identity(value.ownerRunId) || !identity(value.nodeId)) return fail();
	if (typeof value.prospectiveRunId !== "string" || !RFC4122_UUID.test(value.prospectiveRunId)) return fail();
	if (!text(value.agent) || !content(value.task, MAX_TASK_BYTES) || !text(value.cwd, MAX_CWD_BYTES)) return fail();
	if (value.context !== "fresh" || !text(value.model) || !MODEL.test(value.model)) return fail();
	if (typeof value.thinking !== "string" || !THINKING.has(value.thinking as SubagentDelegationThinking) || value.artifacts !== false) return fail();
	if (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 1 || (value.timeoutMs as number) > 2_147_483_647)) return fail();
	const turnBudget = parseTurnBudget(value.turnBudget);
	const toolBudget = parseToolBudget(value.toolBudget);
	if (turnBudget === null || toolBudget === null) return fail();
	let skill: string | string[] | false | undefined;
	if (value.skill !== undefined) {
		if (value.skill === false) skill = false;
		else if (text(value.skill)) skill = value.skill;
		else if (Array.isArray(value.skill) && value.skill.length > 0 && value.skill.length <= 256 && value.skill.every((entry) => text(entry))) {
			if (value.skill.reduce((sum, entry) => sum + Buffer.byteLength(entry, "utf8"), 0) > 64 * 1024) return fail();
			skill = [...value.skill];
		} else return fail();
	}
	const parsedEnvironment = parseActiveBoundEnvironment(value.environment);
	if (!parsedEnvironment.ok) return fail();
	if (!plainRecord(value.result)) return fail();
	let result: ActiveBoundPreflightRequestV1["result"];
	if (value.result.kind === "text" && exactFields(value.result, new Set(["kind"]))) result = { kind: "text" };
	else if (value.result.kind === "structured" && exactFields(value.result, new Set(["kind", "schema"]))) {
		const schema = cloneJsonWithinByteLimit(value.result.schema, MAX_SCHEMA_BYTES);
		if (!schema.ok || !plainRecord(schema.value)) return fail();
		result = { kind: "structured", schema: schema.value };
	} else return fail();
	return { ok: true, request: deepFreeze({
		version: 1, targetServerInstanceId: value.targetServerInstanceId, requestId: value.requestId,
		ownerRunId: value.ownerRunId, nodeId: value.nodeId, prospectiveRunId: value.prospectiveRunId,
		agent: value.agent, task: value.task, cwd: value.cwd, context: "fresh", model: value.model,
		thinking: value.thinking as SubagentDelegationThinking,
		...(value.timeoutMs !== undefined ? { timeoutMs: value.timeoutMs as number } : {}),
		...(turnBudget ? { turnBudget } : {}), ...(toolBudget ? { toolBudget } : {}), ...(skill !== undefined ? { skill } : {}),
		...(Object.keys(parsedEnvironment.environment).length ? { environment: parsedEnvironment.environment } : {}),
		artifacts: false, result,
	}) };
}

/** Fixed-order projection; schema object keys are canonicalized by canonical JSON. */
export function projectActiveBoundPreflightRequest(request: ActiveBoundPreflightRequestV1): Record<string, unknown> {
	return {
		version: request.version, targetServerInstanceId: request.targetServerInstanceId,
		requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId,
		prospectiveRunId: request.prospectiveRunId, agent: request.agent, task: request.task,
		cwd: request.cwd, context: request.context, model: request.model, thinking: request.thinking,
		...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
		...(request.turnBudget !== undefined ? { turnBudget: request.turnBudget } : {}),
		...(request.toolBudget !== undefined ? { toolBudget: request.toolBudget } : {}),
		...(request.skill !== undefined ? { skill: request.skill } : {}),
		...(request.environment && Object.keys(request.environment).length ? { environment: request.environment } : {}),
		artifacts: false, result: request.result,
	};
}

export function activeBoundPreflightRequestDigest(request: ActiveBoundPreflightRequestV1): string {
	return canonicalSha256(projectActiveBoundPreflightRequest(request));
}
