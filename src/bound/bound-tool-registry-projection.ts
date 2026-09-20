import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";
import { canonicalSha256 } from "../shared/canonical-json.ts";

export const TOOL_REGISTRY_PROJECTION_VERSION = 1 as const;
export const TOOL_REGISTRY_MAX_NAMES = 128;
export const TOOL_REGISTRY_MAX_VISIBLE_TOOLS = 4096;
export const TOOL_REGISTRY_MAX_NAME_BYTES = 128;

export const SUPPORTED_BOUND_MODEL_APIS = new Set([
	"openai-completions", "mistral-conversations", "openai-responses",
	"azure-openai-responses", "openai-codex-responses", "anthropic-messages",
	"bedrock-converse-stream", "google-generative-ai", "google-vertex", "pi-messages",
]);

export interface RuntimeBuiltinProjectionV1 {
	version: 1;
	names: string[];
	digest: string;
}

export interface ToolRegistryProjectionV1 {
	version: 1;
	projectionVersion: 1;
	required: string[];
	effectiveCallerTools: string[];
	internalTools: string[];
	missing: string[];
	digest: string;
}

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
export function sortToolRegistryNames(names: Iterable<string>): string[] { return intrinsicArraySort([...names]); }

function normalizeNames(names: readonly string[]): string[] | undefined {
	if (names.length > TOOL_REGISTRY_MAX_NAMES || names.some((name) => !validToolRegistryName(name))) return undefined;
	return sortToolRegistryNames(new Set(names));
}

export function validRuntimeVersionIdentity(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 128 && !/[\0\r\n]/u.test(value);
}

/** Projection of the host runtime's builtin tool names; descriptor-safe over caller data. */
export function runtimeBuiltinProjection(tools: readonly unknown[], options: { allowEmpty?: boolean } = {}): RuntimeBuiltinProjectionV1 | undefined {
	if (!Array.isArray(tools) || tools.length > TOOL_REGISTRY_MAX_VISIBLE_TOOLS) return undefined;
	const names: string[] = [];
	const allNames = new Set<string>();
	for (const entry of tools) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry) || utilTypes.isProxy(entry)) return undefined;
		const nameDescriptor = Object.getOwnPropertyDescriptor(entry, "name");
		const sourceDescriptor = Object.getOwnPropertyDescriptor(entry, "sourceInfo");
		if (!nameDescriptor || !("value" in nameDescriptor) || !sourceDescriptor || !("value" in sourceDescriptor) || !validToolRegistryName(nameDescriptor.value)) return undefined;
		if (allNames.has(nameDescriptor.value)) return undefined;
		allNames.add(nameDescriptor.value);
		const sourceInfo = sourceDescriptor.value;
		if (!sourceInfo || typeof sourceInfo !== "object" || Array.isArray(sourceInfo) || utilTypes.isProxy(sourceInfo)) return undefined;
		const source = Object.getOwnPropertyDescriptor(sourceInfo, "source");
		if (!source || !("value" in source) || typeof source.value !== "string" || !source.value || Buffer.byteLength(source.value, "utf8") > 256) return undefined;
		if (source.value === "builtin") names.push(nameDescriptor.value);
	}
	const normalized = normalizeNames(names);
	if (!normalized || (normalized.length === 0 && options.allowEmpty !== true)) return undefined;
	const base = { version: 1 as const, names: normalized };
	return { ...base, digest: canonicalSha256(base) };
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

/** Contract-side expectation: the registry the child must expose for this launch. */
export function expectedToolRegistryProjection(required: readonly string[], internalTools: readonly string[]): ToolRegistryProjectionV1 | undefined {
	return toolRegistryProjection({ required, actual: required, internalExpected: internalTools });
}
