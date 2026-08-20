import * as path from "node:path";
import { canonicalSha256 } from "../../shared/canonical-json.ts";
import type { BoundRuntimeExtensionEvidenceV1 } from "./bound-runtime-evidence.ts";

export const TOOL_REGISTRY_PROJECTION_VERSION = 1 as const;
export const TOOL_REGISTRY_MAX_NAMES = 128;
export const TOOL_REGISTRY_MAX_NAME_BYTES = 128;
export const TOOL_REGISTRY_MAX_FRAME_BYTES = 64 * 1024;
export const TOOL_REGISTRY_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

export const SUPPORTED_BOUND_PI_VERSIONS = new Set(["0.84.1", "0.84.2"]);
export const SUPPORTED_BOUND_MODEL_APIS = new Set([
	"openai-completions", "mistral-conversations", "openai-responses",
	"azure-openai-responses", "openai-codex-responses", "anthropic-messages",
	"bedrock-converse-stream", "google-generative-ai", "google-vertex", "pi-messages",
]);

export interface ToolRegistryProjectionV1 {
	version: 1;
	projectionVersion: 1;
	required: string[];
	effectiveCallerTools: string[];
	internalTools: string[];
	missing: string[];
	digest: string;
}

export interface BoundToolRegistryPolicyV1 {
	version: 1;
	modelApi: string;
	piRuntimeVersion: string;
	proofNonce: string;
	denialFd: 4;
	required: string[];
	internalTools: string[];
	packageExtensions: Array<{ path: string; contentDigest: string; evidenceRoot: string; evidenceRootDigest: string; packageTreeDigest: string }>;
	runtimeExtensions?: BoundRuntimeExtensionEvidenceV1;
}

export type ToolRegistryChildFrameV1 =
	| { version: 1; kind: "registry"; projection: ToolRegistryProjectionV1 }
	| { version: 1; kind: "unrepresentable"; code: "too_many_tools" | "invalid_tool_name" | "frame_too_large" }
	| { version: 1; kind: "protocol"; code: "unsupported_payload_shape" | "duplicate_tool_name" | "active_registry_drift" | "runtime_version_drift" | "model_api_drift" | "runtime_bytes_drift" | "package_bytes_drift" | "package_load_error" };
export type ToolRegistryChildWireFrameV1 = ToolRegistryChildFrameV1 & { proofNonce: string };

export type ToolRegistryProtocolErrorCode =
	| "missing_frame" | "invalid_frame" | "multiple_frames" | "frame_too_large"
	| "unsupported_payload_shape" | "duplicate_tool_name" | "active_registry_drift"
	| "runtime_version_drift" | "model_api_drift" | "runtime_bytes_drift" | "package_bytes_drift" | "package_load_error" | "package_runtime_mutation" | "too_many_tools" | "invalid_tool_name";

function hasUnpairedSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			if (index + 1 >= value.length) return true;
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return true;
			index++;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
	}
	return false;
}

export function validToolRegistryName(name: unknown): name is string {
	return typeof name === "string" && name.length > 0 && !hasUnpairedSurrogate(name)
		&& Buffer.byteLength(name, "utf8") <= TOOL_REGISTRY_MAX_NAME_BYTES
		&& !name.includes("\0");
}

const intrinsicArraySort = Function.call.bind(Array.prototype.sort) as (target: string[]) => string[];
const intrinsicJsonStringify = JSON.stringify.bind(JSON);
export function sortToolRegistryNames(names: Iterable<string>): string[] { return intrinsicArraySort([...names]); }

function normalizeNames(names: readonly string[]): string[] | undefined {
	if (names.length > TOOL_REGISTRY_MAX_NAMES || names.some((name) => !validToolRegistryName(name))) return undefined;
	return sortToolRegistryNames(new Set(names));
}

export function toolRegistryProjection(input: {
	required: readonly string[];
	actual: readonly string[];
	internalExpected: readonly string[];
}): ToolRegistryProjectionV1 | undefined {
	const required = normalizeNames(input.required);
	const actual = normalizeNames(input.actual);
	const internalExpected = normalizeNames(input.internalExpected);
	if (!required || !actual || !internalExpected || actual.length !== input.actual.length) return undefined;
	const actualSet = new Set(actual);
	const internalSet = new Set(internalExpected);
	const base = {
		version: 1 as const,
		projectionVersion: TOOL_REGISTRY_PROJECTION_VERSION,
		required,
		effectiveCallerTools: actual.filter((name) => !internalSet.has(name)),
		internalTools: actual.filter((name) => internalSet.has(name)),
		missing: required.filter((name) => !actualSet.has(name)),
	};
	return { ...base, digest: canonicalSha256(base) };
}

export function expectedToolRegistryProjection(required: readonly string[], internalTools: readonly string[]): ToolRegistryProjectionV1 | undefined {
	const projection = toolRegistryProjection({ required, actual: required, internalExpected: internalTools });
	return projection && encodeToolRegistryFrame({ version: 1, kind: "registry", projection, proofNonce: "0".repeat(64) }) ? projection : undefined;
}

export function validateBoundToolRegistryPolicy(value: unknown): BoundToolRegistryPolicyV1 | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).sort().join(",") !== "denialFd,internalTools,modelApi,packageExtensions,piRuntimeVersion,proofNonce,required,runtimeExtensions,version"
		|| record.version !== 1 || record.denialFd !== 4 || typeof record.modelApi !== "string" || typeof record.piRuntimeVersion !== "string" || typeof record.proofNonce !== "string" || !/^[0-9a-f]{64}$/u.test(record.proofNonce)
		|| !SUPPORTED_BOUND_MODEL_APIS.has(record.modelApi) || !SUPPORTED_BOUND_PI_VERSIONS.has(record.piRuntimeVersion)
		|| !Array.isArray(record.required) || !Array.isArray(record.internalTools) || !Array.isArray(record.packageExtensions)
		|| !record.runtimeExtensions || typeof record.runtimeExtensions !== "object" || Array.isArray(record.runtimeExtensions)
		|| record.packageExtensions.length > 16 || record.packageExtensions.some((entry) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
			const value = entry as Record<string, unknown>;
			return Object.keys(value).sort().join(",") !== "contentDigest,evidenceRoot,evidenceRootDigest,packageTreeDigest,path"
				|| typeof value.path !== "string" || !path.isAbsolute(value.path) || Buffer.byteLength(value.path, "utf8") > 4096
				|| typeof value.evidenceRoot !== "string" || !path.isAbsolute(value.evidenceRoot) || Buffer.byteLength(value.evidenceRoot, "utf8") > 4096
				|| typeof value.contentDigest !== "string" || !/^[0-9a-f]{64}$/u.test(value.contentDigest)
				|| typeof value.evidenceRootDigest !== "string" || !/^[0-9a-f]{64}$/u.test(value.evidenceRootDigest)
				|| typeof value.packageTreeDigest !== "string" || !/^[0-9a-f]{64}$/u.test(value.packageTreeDigest);
		})) return undefined;
	const runtimeExtensions = record.runtimeExtensions as Record<string, unknown>;
	if (Object.keys(runtimeExtensions).sort().join(",") !== "entries,version" || runtimeExtensions.version !== 1 || !Array.isArray(runtimeExtensions.entries)
		|| runtimeExtensions.entries.length > 32 || runtimeExtensions.entries.some((entry) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
			const value = entry as Record<string, unknown>;
			return Object.keys(value).sort().join(",") !== "contentDigest,name" || typeof value.name !== "string" || !value.name
				|| Buffer.byteLength(value.name, "utf8") > 128 || typeof value.contentDigest !== "string" || !/^[0-9a-f]{64}$/u.test(value.contentDigest);
		})) return undefined;
	const required = normalizeNames(record.required as string[]);
	const internalTools = normalizeNames(record.internalTools as string[]);
	if (!required || !internalTools || required.length !== record.required.length || internalTools.length !== record.internalTools.length
		|| internalTools.some((name) => !required.includes(name)) || !expectedToolRegistryProjection(required, internalTools)) return undefined;
	return {
		version: 1, modelApi: record.modelApi, piRuntimeVersion: record.piRuntimeVersion, proofNonce: record.proofNonce, denialFd: 4,
		required, internalTools,
		packageExtensions: (record.packageExtensions as Array<{ path: string; contentDigest: string; evidenceRoot: string; evidenceRootDigest: string; packageTreeDigest: string }>).map((entry) => ({ ...entry })),
		runtimeExtensions: { version: 1, entries: (runtimeExtensions.entries as Array<{ name: string; contentDigest: string }>).map((entry) => ({ ...entry })) },
	};
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean {
	const allowedSet = new Set(allowed);
	return required.every((key) => key in value) && Object.keys(value).every((key) => allowedSet.has(key));
}

export type ExtractPayloadToolsResult =
	| { ok: true; names: string[] }
	| { ok: false; code: "unsupported_payload_shape" | "duplicate_tool_name" | "too_many_tools" | "invalid_tool_name" };

export function extractProviderPayloadToolNames(api: string, payload: unknown, expectedToolCount = 0): ExtractPayloadToolsResult {
	const root = object(payload);
	if (!root) return { ok: false, code: "unsupported_payload_shape" };
	let container: unknown;
	if (api === "bedrock-converse-stream") {
		const config = root.toolConfig === undefined ? undefined : object(root.toolConfig);
		if (root.toolConfig !== undefined && !config) return { ok: false, code: "unsupported_payload_shape" };
		container = config?.tools;
	} else if (api === "google-generative-ai" || api === "google-vertex") {
		const config = object(root.config);
		if (!config) return { ok: false, code: "unsupported_payload_shape" };
		container = config.tools;
	} else if (api === "pi-messages") {
		const context = object(root.context);
		if (!context) return { ok: false, code: "unsupported_payload_shape" };
		container = context.tools;
	} else {
		container = root.tools;
	}
	if (container === undefined && expectedToolCount > 0) return { ok: false, code: "unsupported_payload_shape" };
	const raw = container === undefined ? [] : Array.isArray(container) ? container : undefined;
	if (!raw) return { ok: false, code: "unsupported_payload_shape" };
	const names: string[] = [];
	const add = (name: unknown): boolean => { if (!validToolRegistryName(name)) return false; names.push(name); return true; };
	for (const entry of raw) {
		const item = object(entry);
		if (!item) return { ok: false, code: "unsupported_payload_shape" };
		if (api === "openai-completions" || api === "mistral-conversations") {
			if (item.type === "function") {
				const fn = object(item.function);
				if (!exactKeys(item, api === "openai-completions" ? ["type", "function", "cache_control"] : ["type", "function"], ["type", "function"]) || !fn || !exactKeys(fn, ["name", "description", "parameters", "strict"], ["name"])) return { ok: false, code: "unsupported_payload_shape" };
				if (!add(fn.name)) return { ok: false, code: "invalid_tool_name" };
			} else if (api === "openai-completions" && item.type === "custom") {
				const custom = object(item.custom);
				if (!exactKeys(item, ["type", "custom", "cache_control"], ["type", "custom"]) || !custom || !exactKeys(custom, ["name", "description", "format"], ["name"])) return { ok: false, code: "unsupported_payload_shape" };
				if (!add(custom.name)) return { ok: false, code: "invalid_tool_name" };
			} else return { ok: false, code: "unsupported_payload_shape" };
		} else if (["openai-responses", "azure-openai-responses", "openai-codex-responses"].includes(api)) {
			if ((item.type !== "function" && item.type !== "custom") || "defer_loading" in item
				|| !exactKeys(item, item.type === "function" ? ["type", "name", "description", "parameters", "strict"] : ["type", "name", "description", "format"], ["type", "name"])) return { ok: false, code: "unsupported_payload_shape" };
			if (!add(item.name)) return { ok: false, code: "invalid_tool_name" };
		} else if (api === "anthropic-messages") {
			if ("defer_loading" in item || !exactKeys(item, ["name", "description", "input_schema", "eager_input_streaming", "strict", "cache_control"], ["name", "input_schema"])) return { ok: false, code: "unsupported_payload_shape" };
			if (!add(item.name)) return { ok: false, code: "invalid_tool_name" };
		} else if (api === "bedrock-converse-stream") {
			const spec = object(item.toolSpec);
			if (!spec || !exactKeys(item, ["toolSpec"], ["toolSpec"]) || !exactKeys(spec, ["name", "description", "inputSchema", "strict"], ["name"])) return { ok: false, code: "unsupported_payload_shape" };
			if (!add(spec.name)) return { ok: false, code: "invalid_tool_name" };
		} else if (api === "google-generative-ai" || api === "google-vertex") {
			if (!exactKeys(item, ["functionDeclarations"], ["functionDeclarations"]) || !Array.isArray(item.functionDeclarations)) return { ok: false, code: "unsupported_payload_shape" };
			for (const declaration of item.functionDeclarations) {
				const fn = object(declaration);
				if (!fn || !exactKeys(fn, ["name", "description", "parameters", "parametersJsonSchema"], ["name"])) return { ok: false, code: "unsupported_payload_shape" };
				if (!add(fn.name)) return { ok: false, code: "invalid_tool_name" };
			}
		} else if (api === "pi-messages") {
			if (!exactKeys(item, ["name", "label", "description", "parameters", "executionMode", "constrainedSampling", "promptSnippet", "promptGuidelines"], ["name", "description", "parameters"])) return { ok: false, code: "unsupported_payload_shape" };
			if (!add(item.name)) return { ok: false, code: "invalid_tool_name" };
		} else return { ok: false, code: "unsupported_payload_shape" };
	}
	if (names.length > TOOL_REGISTRY_MAX_NAMES) return { ok: false, code: "too_many_tools" };
	if (new Set(names).size !== names.length) return { ok: false, code: "duplicate_tool_name" };
	return { ok: true, names: sortToolRegistryNames(names) };
}

export function encodeToolRegistryFrame(frame: ToolRegistryChildWireFrameV1): string | undefined {
	const encoded = `${intrinsicJsonStringify(frame)}\n`;
	return Buffer.byteLength(encoded, "utf8") <= TOOL_REGISTRY_MAX_FRAME_BYTES ? encoded : undefined;
}
