import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";
import { canonicalSha256 } from "../shared/canonical-json.ts";

export const ACTIVE_BOUND_ENVIRONMENT_VERSION = 1 as const;
export const ACTIVE_BOUND_ENVIRONMENT_NAMES = ["ONECPI_REVIEW_ROOT", "ONECPI_REVIEW_SUBJECT_PATH"] as const;
export type ActiveBoundEnvironmentName = typeof ACTIVE_BOUND_ENVIRONMENT_NAMES[number];
export type ActiveBoundEnvironmentV1 = Partial<Record<ActiveBoundEnvironmentName, string>>;
export interface ActiveBoundEnvironmentProjectionV1 {
	version: typeof ACTIVE_BOUND_ENVIRONMENT_VERSION;
	names: ActiveBoundEnvironmentName[];
	valuesDigest: string;
}

const NAMES = new Set<string>(ACTIVE_BOUND_ENVIRONMENT_NAMES);
const MAX_VALUE_BYTES = 4096;
const MAX_TOTAL_BYTES = 8192;

function validUnicode(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
			index++;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
	}
	return true;
}

export function parseActiveBoundEnvironment(value: unknown): { ok: true; environment: ActiveBoundEnvironmentV1 } | { ok: false } {
	if (value === undefined) return { ok: true, environment: Object.create(null) as ActiveBoundEnvironmentV1 };
	if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return { ok: false };
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return { ok: false };
	const keys = Reflect.ownKeys(value);
	if (keys.length > ACTIVE_BOUND_ENVIRONMENT_NAMES.length || !keys.every((key): key is string => typeof key === "string" && NAMES.has(key))) return { ok: false };
	const environment = Object.create(null) as ActiveBoundEnvironmentV1;
	let totalBytes = 0;
	for (const key of [...keys].sort()) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
		if (!descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") return { ok: false };
		const entry = descriptor.value;
		const valueBytes = Buffer.byteLength(entry, "utf8");
		if (!entry.length || entry.includes("\0") || !validUnicode(entry) || valueBytes > MAX_VALUE_BYTES) return { ok: false };
		totalBytes += Buffer.byteLength(key, "utf8") + valueBytes;
		if (totalBytes > MAX_TOTAL_BYTES) return { ok: false };
		environment[key as ActiveBoundEnvironmentName] = entry;
	}
	return { ok: true, environment };
}

export function projectActiveBoundEnvironment(environment: ActiveBoundEnvironmentV1 | undefined): ActiveBoundEnvironmentProjectionV1 {
	const names = ACTIVE_BOUND_ENVIRONMENT_NAMES.filter((name) => environment !== undefined && Object.hasOwn(environment, name) && environment[name] !== undefined);
	const entries = names.map((name) => ({ name, value: environment![name]! }));
	return { version: 1, names, valuesDigest: canonicalSha256({ version: 1, entries }) };
}

/** Pure per-spawn materialization. Input objects are never mutated. */
export function buildActiveBoundSpawnEnvironment(
	inherited: NodeJS.ProcessEnv,
	requested: ActiveBoundEnvironmentV1,
): NodeJS.ProcessEnv {
	const output: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
	for (const [key, value] of Object.entries(inherited)) {
		const folded = key.replace(/[a-z]/g, (character) => character.toUpperCase());
		if (NAMES.has(folded) || folded.startsWith("PI_SUBAGENT_") || folded.startsWith("PI_INTERCOM_")) continue;
		output[key] = value;
	}
	for (const name of ACTIVE_BOUND_ENVIRONMENT_NAMES) {
		const value = Object.hasOwn(requested, name) ? requested[name] : undefined;
		if (value !== undefined) output[name] = value;
	}
	return output;
}
