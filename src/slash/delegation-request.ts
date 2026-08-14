import { types as utilTypes } from "node:util";
import {
	type SubagentDelegationBindingV1,
	type SubagentDelegationRequest,
} from "../api/delegation.ts";
import type { LaunchReceiptV1 } from "../api/launch-receipt.ts";
import { parseActiveBoundEnvironment } from "../api/active-bound-environment.ts";
import { validateToolBudgetConfig } from "../runs/shared/tool-budget.ts";
import { resolveTurnBudgetConfig } from "../runs/shared/turn-budget.ts";
import { cloneJsonWithinByteLimit } from "./delegation-json.ts";

export type SubagentDelegationParseResult =
	| { ok: true; request: SubagentDelegationRequest }
	| { ok: false; requestId?: string; ownerRunId?: string; nodeId?: string; error: string };

const supportedFields = new Set([
	"requestId",
	"ownerRunId",
	"nodeId",
	"agent",
	"task",
	"context",
	"cwd",
	"model",
	"thinking",
	"timeoutMs",
	"turnBudget",
	"toolBudget",
	"skill",
	"environment",
	"artifacts",
	"artifactDir",
	"result",
	"binding",
]);

const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_TASK_BYTES = 1024 * 1024;
const MAX_CWD_BYTES = 32 * 1024;
const MAX_SHORT_TEXT_BYTES = 1024;
const MAX_SKILL_ENTRIES = 256;
const MAX_SKILL_AGGREGATE_BYTES = 64 * 1024;

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function validateId(value: unknown): string | undefined {
	if (!nonEmptyString(value) || value.length > 256 || /[\r\n]/.test(value)) return undefined;
	return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}
function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function subagentDelegationBindingTarget(input: unknown): string | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input) || utilTypes.isProxy(input)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(input, "binding");
	if (!descriptor || !("value" in descriptor) || !descriptor.value || typeof descriptor.value !== "object"
		|| Array.isArray(descriptor.value) || utilTypes.isProxy(descriptor.value)) return undefined;
	const prototype = Object.getPrototypeOf(descriptor.value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	const target = Object.getOwnPropertyDescriptor(descriptor.value, "targetServerInstanceId");
	return target && "value" in target && typeof target.value === "string" && UUID.test(target.value) ? target.value : undefined;
}

function parseBinding(input: unknown): SubagentDelegationBindingV1 | undefined {
	const inspected = cloneJsonWithinByteLimit(input, 32 * 1024);
	if (!inspected.ok || !record(inspected.value)) return undefined;
	const value = inspected.value;
	if (!exactKeys(value, ["version", "targetServerInstanceId", "prospectiveRunId", "expectedSourceIdentityDigest", "expectedActiveSessionDigest", "requestDigest", "expectedLaunchContractDigest", "receipt"])) return undefined;
	if (value.version !== 1 || typeof value.targetServerInstanceId !== "string" || !UUID.test(value.targetServerInstanceId)
		|| typeof value.prospectiveRunId !== "string" || !UUID.test(value.prospectiveRunId)
		|| ![value.expectedSourceIdentityDigest, value.expectedActiveSessionDigest, value.requestDigest, value.expectedLaunchContractDigest].every((entry) => typeof entry === "string" && DIGEST.test(entry))) return undefined;
	const receipt = value.receipt;
	if (!record(receipt) || !exactKeys(receipt, ["version", "algorithm", "payload", "mac"])
		|| receipt.version !== 1 || receipt.algorithm !== "HMAC-SHA256" || typeof receipt.mac !== "string" || !DIGEST.test(receipt.mac)
		|| !record(receipt.payload) || !exactKeys(receipt.payload, ["version", "serverInstanceId", "sourceIdentityDigest", "activeSessionDigest", "prospectiveRunId", "requestDigest", "launchContractDigest", "issuedAt", "expiresAt"])) return undefined;
	return {
		version: 1,
		targetServerInstanceId: value.targetServerInstanceId,
		prospectiveRunId: value.prospectiveRunId,
		expectedSourceIdentityDigest: value.expectedSourceIdentityDigest as string,
		expectedActiveSessionDigest: value.expectedActiveSessionDigest as string,
		requestDigest: value.requestDigest as string,
		expectedLaunchContractDigest: value.expectedLaunchContractDigest as string,
		receipt: receipt as unknown as LaunchReceiptV1,
	};
}

function descriptorIdentity(data: unknown): Partial<Pick<SubagentDelegationRequest, "requestId" | "ownerRunId" | "nodeId">> {
	if (!data || typeof data !== "object" || Array.isArray(data) || utilTypes.isProxy(data)) return {};
	const prototype = Object.getPrototypeOf(data);
	if (prototype !== Object.prototype && prototype !== null) return {};
	const descriptors = Object.getOwnPropertyDescriptors(data);
	const result: Partial<Pick<SubagentDelegationRequest, "requestId" | "ownerRunId" | "nodeId">> = {};
	for (const key of ["requestId", "ownerRunId", "nodeId"] as const) {
		const descriptor = descriptors[key];
		if (descriptor && "value" in descriptor) {
			const validated = validateId(descriptor.value);
			if (validated) result[key] = validated;
		}
	}
	return result;
}

function omitKnownOptionalUndefined(value: unknown, allowed: ReadonlySet<string>): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return value;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return value;
	const keys = Reflect.ownKeys(value);
	if (!keys.every((key): key is string => typeof key === "string" && allowed.has(key))) return value;
	const output: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
		if (!("value" in descriptor) || !descriptor.enumerable) return value;
		if (descriptor.value !== undefined) output[key] = descriptor.value;
	}
	return output;
}

export function parseSubagentDelegationRequest(data: unknown): SubagentDelegationParseResult {
	const safeIdentity = descriptorIdentity(data);
	let cloneInput = data;
	if (data && typeof data === "object" && !Array.isArray(data) && !utilTypes.isProxy(data)) {
		const prototype = Object.getPrototypeOf(data);
		if (prototype === Object.prototype || prototype === null) {
			const keys = Reflect.ownKeys(data);
			const unsupported = keys.find((key) => typeof key === "string" && !supportedFields.has(key));
			if (typeof unsupported === "string") return { ok: false, ...safeIdentity, error: `Unsupported delegation field: ${unsupported}.` };
			if (keys.every((key): key is string => typeof key === "string")) {
				const descriptors = Object.getOwnPropertyDescriptors(data);
				const prepared: Record<string, unknown> = Object.create(null);
				let safe = true;
				for (const key of keys) {
					const descriptor = descriptors[key]!;
					if (!("value" in descriptor) || !descriptor.enumerable) { safe = false; break; }
					if (descriptor.value !== undefined) {
						prepared[key] = key === "turnBudget"
							? omitKnownOptionalUndefined(descriptor.value, new Set(["maxTurns", "graceTurns"]))
							: key === "toolBudget"
								? omitKnownOptionalUndefined(descriptor.value, new Set(["soft", "hard", "block"]))
								: key === "environment"
									? omitKnownOptionalUndefined(descriptor.value, new Set(["ONECPI_REVIEW_ROOT", "ONECPI_REVIEW_SUBJECT_PATH"]))
									: descriptor.value;
					}
				}
				if (safe) cloneInput = prepared;
			}
		}
	}
	const cloned = cloneJsonWithinByteLimit(cloneInput, 8 * 1024 * 1024);
	if (!cloned.ok || !record(cloned.value)) {
		return { ok: false, ...safeIdentity, error: "Delegation request must be closed plain data." };
	}
	const value = cloned.value;
	const requestId = validateId(value.requestId);
	if (!requestId) {
		return { ok: false, error: "Delegation requestId must be a non-empty string of at most 256 characters without newlines." };
	}
	const ownerRunId = validateId(value.ownerRunId);
	if (!ownerRunId) {
		return { ok: false, requestId, error: "Delegation ownerRunId must be a non-empty string of at most 256 characters without newlines." };
	}
	const nodeId = validateId(value.nodeId);
	if (!nodeId) {
		return { ok: false, requestId, ownerRunId, error: "Delegation nodeId must be a non-empty string of at most 256 characters without newlines." };
	}
	const identity = { requestId, ownerRunId, nodeId };
	const unsupportedField = Object.keys(value).find((key) => !supportedFields.has(key));
	if (unsupportedField) return { ok: false, ...identity, error: `Unsupported delegation field: ${unsupportedField}.` };
	if (!nonEmptyString(value.agent)) return { ok: false, ...identity, error: "Delegation agent must be a non-empty string." };
	if (!nonEmptyString(value.task)) return { ok: false, ...identity, error: "Delegation task must be a non-empty string." };
	if (value.context !== "fresh" && value.context !== "fork") {
		return { ok: false, ...identity, error: "Delegation context must be fresh or fork." };
	}
	if (!nonEmptyString(value.cwd)) return { ok: false, ...identity, error: "Delegation cwd must be a non-empty string." };
	if (value.model !== undefined && !nonEmptyString(value.model)) {
		return { ok: false, ...identity, error: "model must be a non-empty string when provided." };
	}
	if (value.timeoutMs !== undefined && (typeof value.timeoutMs !== "number" || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1)) {
		return { ok: false, ...identity, error: "timeoutMs must be an integer >= 1." };
	}
	const timeoutMs = typeof value.timeoutMs === "number" ? value.timeoutMs : undefined;
	if (timeoutMs !== undefined && timeoutMs > 2_147_483_647) {
		return { ok: false, ...identity, error: "timeoutMs must be <= 2147483647." };
	}
	const turnBudget = resolveTurnBudgetConfig(value.turnBudget);
	if (turnBudget.error) return { ok: false, ...identity, error: turnBudget.error };
	if (value.toolBudget && typeof value.toolBudget === "object" && !Array.isArray(value.toolBudget)) {
		const unsupportedToolBudgetField = Object.keys(value.toolBudget).find((key) => key !== "soft" && key !== "hard" && key !== "block");
		if (unsupportedToolBudgetField) {
			return { ok: false, ...identity, error: `toolBudget.${unsupportedToolBudgetField} is not supported.` };
		}
	}
	const toolBudget = validateToolBudgetConfig(value.toolBudget, "toolBudget", { minimumHard: 0 });
	if (toolBudget.error) return { ok: false, ...identity, error: toolBudget.error };
	if (value.skill !== undefined) {
		const validSkill = typeof value.skill === "boolean"
			|| nonEmptyString(value.skill)
			|| (Array.isArray(value.skill) && value.skill.length > 0 && value.skill.every(nonEmptyString));
		if (!validSkill) {
			return { ok: false, ...identity, error: "skill must be a boolean, non-empty string, or non-empty string array." };
		}
	}
	if (value.artifacts !== undefined && typeof value.artifacts !== "boolean") {
		return { ok: false, ...identity, error: "artifacts must be a boolean." };
	}
	if (value.artifactDir !== undefined && value.artifactDir !== "session") return { ok: false, ...identity, error: "artifactDir must be session when provided." };
	const binding = value.binding === undefined ? undefined : parseBinding(value.binding);
	if (value.binding !== undefined && !binding) return { ok: false, ...identity, error: "binding must be a closed active-bound v1 proof." };
	if (!binding && value.environment !== undefined) return { ok: false, ...identity, error: "environment is supported only for bound delegation." };
	if (!binding && value.artifactDir !== undefined) return { ok: false, ...identity, error: "artifactDir is supported only for bound delegation." };
	const parsedEnvironment = parseActiveBoundEnvironment(value.environment);
	if (!parsedEnvironment.ok) return { ok: false, ...identity, error: "environment must contain only bounded active-bound keys." };
	if (binding && (value.context !== "fresh" || typeof value.model !== "string" || typeof value.thinking !== "string" || value.skill === true
		|| ((value.artifacts !== false || value.artifactDir !== undefined) && (value.artifacts !== true || value.artifactDir !== "session")))) {
		return { ok: false, ...identity, error: "bound delegation requires fresh context, explicit model/thinking, a closed artifact policy, and explicit project skills." };
	}
	if (Buffer.byteLength(value.task as string, "utf8") > MAX_TASK_BYTES) {
		return { ok: false, ...identity, error: "Delegation task exceeds 1 MiB when UTF-8 encoded." };
	}
	if (Buffer.byteLength(value.cwd as string, "utf8") > MAX_CWD_BYTES) {
		return { ok: false, ...identity, error: "Delegation cwd exceeds 32 KiB when UTF-8 encoded." };
	}
	if (Buffer.byteLength(value.agent as string, "utf8") > MAX_SHORT_TEXT_BYTES) {
		return { ok: false, ...identity, error: "Delegation agent exceeds 1 KiB when UTF-8 encoded." };
	}
	if (typeof value.model === "string" && Buffer.byteLength(value.model, "utf8") > MAX_SHORT_TEXT_BYTES) {
		return { ok: false, ...identity, error: "Delegation model exceeds 1 KiB when UTF-8 encoded." };
	}
	const skillEntries = typeof value.skill === "string" ? [value.skill] : Array.isArray(value.skill) ? value.skill as string[] : [];
	if (skillEntries.length > MAX_SKILL_ENTRIES) {
		return { ok: false, ...identity, error: "Delegation skill supports at most 256 entries." };
	}
	if (skillEntries.some((entry) => Buffer.byteLength(entry, "utf8") > MAX_SHORT_TEXT_BYTES)) {
		return { ok: false, ...identity, error: "Delegation skill entry exceeds 1 KiB when UTF-8 encoded." };
	}
	if (skillEntries.reduce((total, entry) => total + Buffer.byteLength(entry, "utf8"), 0) > MAX_SKILL_AGGREGATE_BYTES) {
		return { ok: false, ...identity, error: "Delegation skill entries exceed 64 KiB in aggregate when UTF-8 encoded." };
	}
	if (value.thinking !== undefined && (typeof value.thinking !== "string" || !thinkingLevels.has(value.thinking))) {
		return { ok: false, ...identity, error: "thinking must be one of off, minimal, low, medium, high, xhigh, or max." };
	}
	if (!value.result || typeof value.result !== "object" || Array.isArray(value.result)) {
		return { ok: false, ...identity, error: "result must be { kind: \"text\" } or { kind: \"structured\", schema: object }." };
	}
	const result = value.result as Record<string, unknown>;
	let structuredSchema: Record<string, unknown> | undefined;
	if (result.kind === "text") {
		const unsupportedResultField = Object.keys(result).find((key) => key !== "kind");
		if (unsupportedResultField) return { ok: false, ...identity, error: `result.${unsupportedResultField} is not supported for text results.` };
	} else if (result.kind === "structured") {
		const unsupportedResultField = Object.keys(result).find((key) => key !== "kind" && key !== "schema");
		if (unsupportedResultField) return { ok: false, ...identity, error: `result.${unsupportedResultField} is not supported for structured results.` };
		if (!result.schema || typeof result.schema !== "object" || Array.isArray(result.schema)) {
			return { ok: false, ...identity, error: "result.schema must be a JSON Schema object." };
		}
		const inspectedSchema = cloneJsonWithinByteLimit(result.schema, MAX_SCHEMA_BYTES);
		if (inspectedSchema.ok === false) {
			return {
				ok: false,
				...identity,
				error: inspectedSchema.reason === "too_large"
					? "result.schema exceeds 64 KiB when encoded."
					: "result.schema must be plain JSON data.",
			};
		}
		structuredSchema = inspectedSchema.value as Record<string, unknown>;
	} else {
		return { ok: false, ...identity, error: "result.kind must be text or structured." };
	}
	const { environment: _rawEnvironment, ...requestValue } = value;
	return {
		ok: true,
		request: {
			...requestValue,
			...(Object.keys(parsedEnvironment.environment).length ? { environment: parsedEnvironment.environment } : {}),
			...(binding ? { binding } : {}),
			result: structuredSchema
				? { kind: "structured", schema: structuredSchema }
				: { kind: "text" },
		} as unknown as SubagentDelegationRequest,
	};
}
