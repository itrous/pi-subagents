import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";
import { canonicalSha256 } from "../shared/canonical-json.ts";
import { cloneJsonWithinByteLimit } from "./bound-json.ts";
import { BOUND_BINDING_NAMES, parseBoundBindings, type BoundBindingsV1 } from "./bound-bindings.ts";
import type {
	SubagentDelegationJsonSchemaObject,
	SubagentDelegationThinking,
	SubagentDelegationToolBudget,
} from "../api/delegation.ts";

export const BOUND_REQUEST_VERSION = 2 as const;
export const BOUND_RFC4122_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MODEL = /^[^\s/:]+\/[^\s:]+$/u;
const THINKING = new Set<SubagentDelegationThinking>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
// `turnBudget` and `artifactDir` of the v1 contract are absent as a class (D8).
const FIELDS = new Set([
	"version", "targetServerInstanceId", "requestId", "ownerRunId", "nodeId", "prospectiveRunId",
	"agent", "task", "cwd", "context", "model", "thinking", "timeoutMs", "toolBudget", "skill",
	"bindings", "artifacts", "result",
]);
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_REQUEST_CLONE_BYTES = 8 * 1024 * 1024;
const MAX_TASK_BYTES = 1024 * 1024;
const MAX_CWD_BYTES = 32 * 1024;
const MAX_SHORT_BYTES = 1024;

export interface BoundRequestV2 {
	version: typeof BOUND_REQUEST_VERSION;
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
	toolBudget?: SubagentDelegationToolBudget;
	skill?: string | string[] | false;
	bindings?: BoundBindingsV1;
	artifacts: boolean;
	result: { kind: "text" } | { kind: "structured"; schema: SubagentDelegationJsonSchemaObject };
}

export type BoundRequestParseResult = { ok: true; request: BoundRequestV2 } | { ok: false; code: "invalid_request" };

function fail(): BoundRequestParseResult { return { ok: false, code: "invalid_request" }; }
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
	return value !== null && typeof value === "object" && !Array.isArray(value)
		&& (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
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

/** Descriptor-safe target extraction; routing decides before anything is parsed. */
export function boundRequestTarget(input: unknown): string | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input) || utilTypes.isProxy(input)) return undefined;
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(input, "targetServerInstanceId");
	return descriptor && "value" in descriptor && typeof descriptor.value === "string" && BOUND_RFC4122_UUID.test(descriptor.value)
		? descriptor.value
		: undefined;
}

function omitOptionalUndefined(value: unknown, allowed: ReadonlySet<string>): unknown {
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

/** Closed descriptor-safe parser. It clones before inspecting any caller property. */
export function parseBoundRequest(input: unknown): BoundRequestParseResult {
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
					prepared[key] = key === "toolBudget"
						? omitOptionalUndefined(descriptor.value, new Set(["soft", "hard", "block"]))
						: key === "bindings"
							? omitOptionalUndefined(descriptor.value, new Set(BOUND_BINDING_NAMES))
							: descriptor.value;
				}
			}
			if (safe) cloneInput = prepared;
		}
	}
	const cloned = cloneJsonWithinByteLimit(cloneInput, MAX_REQUEST_CLONE_BYTES);
	if (!cloned.ok || !plainRecord(cloned.value)) return fail();
	const value = cloned.value;
	if (!exactFields(value, FIELDS) || value.version !== BOUND_REQUEST_VERSION) return fail();
	if (typeof value.targetServerInstanceId !== "string" || !BOUND_RFC4122_UUID.test(value.targetServerInstanceId)
		|| !identity(value.requestId) || !identity(value.ownerRunId) || !identity(value.nodeId)) return fail();
	if (typeof value.prospectiveRunId !== "string" || !BOUND_RFC4122_UUID.test(value.prospectiveRunId)) return fail();
	if (!text(value.agent) || !content(value.task, MAX_TASK_BYTES) || !text(value.cwd, MAX_CWD_BYTES)) return fail();
	if (value.context !== "fresh" || !text(value.model) || !MODEL.test(value.model)) return fail();
	if (typeof value.thinking !== "string" || !THINKING.has(value.thinking as SubagentDelegationThinking)) return fail();
	if (value.artifacts !== false && value.artifacts !== true) return fail();
	if (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 1 || (value.timeoutMs as number) > 2_147_483_647)) return fail();
	const toolBudget = parseToolBudget(value.toolBudget);
	if (toolBudget === null) return fail();
	let skill: string | string[] | false | undefined;
	if (value.skill !== undefined) {
		if (value.skill === false) skill = false;
		else if (text(value.skill)) skill = value.skill;
		else if (Array.isArray(value.skill) && value.skill.length > 0 && value.skill.length <= 256 && value.skill.every((entry) => text(entry))) {
			if (value.skill.reduce((sum, entry) => sum + Buffer.byteLength(entry, "utf8"), 0) > 64 * 1024) return fail();
			skill = [...value.skill];
		} else return fail();
	}
	const parsedBindings = parseBoundBindings(value.bindings);
	if (!parsedBindings.ok) return fail();
	if (!plainRecord(value.result)) return fail();
	let result: BoundRequestV2["result"];
	if (value.result.kind === "text" && exactFields(value.result, new Set(["kind"]))) result = { kind: "text" };
	else if (value.result.kind === "structured" && exactFields(value.result, new Set(["kind", "schema"]))) {
		const schema = cloneJsonWithinByteLimit(value.result.schema, MAX_SCHEMA_BYTES);
		if (!schema.ok || !plainRecord(schema.value)) return fail();
		result = { kind: "structured", schema: schema.value };
	} else return fail();
	return { ok: true, request: deepFreeze({
		version: BOUND_REQUEST_VERSION, targetServerInstanceId: value.targetServerInstanceId, requestId: value.requestId,
		ownerRunId: value.ownerRunId, nodeId: value.nodeId, prospectiveRunId: value.prospectiveRunId,
		agent: value.agent, task: value.task, cwd: value.cwd, context: "fresh" as const, model: value.model,
		thinking: value.thinking as SubagentDelegationThinking,
		...(value.timeoutMs !== undefined ? { timeoutMs: value.timeoutMs as number } : {}),
		...(toolBudget ? { toolBudget } : {}),
		...(skill !== undefined ? { skill } : {}),
		...(Object.keys(parsedBindings.bindings).length ? { bindings: parsedBindings.bindings } : {}),
		artifacts: value.artifacts as boolean, result,
	}) };
}

/** Fixed-order projection; schema object keys are canonicalized by canonical JSON. */
export function projectBoundRequest(request: BoundRequestV2): Record<string, unknown> {
	return {
		version: request.version, targetServerInstanceId: request.targetServerInstanceId,
		requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId,
		prospectiveRunId: request.prospectiveRunId, agent: request.agent, task: request.task,
		cwd: request.cwd, context: request.context, model: request.model, thinking: request.thinking,
		...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
		...(request.toolBudget !== undefined ? { toolBudget: request.toolBudget } : {}),
		...(request.skill !== undefined ? { skill: request.skill } : {}),
		...(request.bindings && Object.keys(request.bindings).length ? { bindings: { ...request.bindings } } : {}),
		artifacts: request.artifacts, result: request.result,
	};
}

export function boundRequestDigest(request: BoundRequestV2): string {
	return canonicalSha256(projectBoundRequest(request));
}
