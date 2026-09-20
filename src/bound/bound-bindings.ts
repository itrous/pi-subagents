import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";
import { canonicalSha256 } from "../shared/canonical-json.ts";

export const BOUND_BINDINGS_VERSION = 1 as const;
export const BOUND_BINDINGS_NAMESPACE = "onecpi-review/1" as const;

/**
 * Closed binding namespace of the OneCPI native review transport (decision D2).
 * The fork does not carry a configurable namespace registry: the whole space is
 * this literal list, and anything else is an invalid request.
 */
export const BOUND_BINDING_NAMES = [
	"ONECPI_REVIEW_ROOT",
	"ONECPI_REVIEW_SUBJECT_PATH",
	"ONECPI_REVIEW_WORKSPACE_ROOT",
	"ONECPI_REVIEW_WORKSPACE_SUBJECTS",
	"ONECPI_REVIEW_WORKSPACE_POLICY_DIGEST",
	"ONECPI_REVIEW_WORKSPACE_LOG",
] as const;

export type BoundBindingName = typeof BOUND_BINDING_NAMES[number];
export type BoundBindingsV1 = Partial<Record<BoundBindingName, string>>;

export interface BoundBindingsProjectionV1 {
	version: typeof BOUND_BINDINGS_VERSION;
	namespace: typeof BOUND_BINDINGS_NAMESPACE;
	names: BoundBindingName[];
	valuesDigest: string;
}

const NAMES = new Set<string>(BOUND_BINDING_NAMES);
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

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Descriptor-safe parser. It never invokes an accessor or a Proxy trap. */
export function parseBoundBindings(value: unknown): { ok: true; bindings: BoundBindingsV1 } | { ok: false } {
	if (value === undefined) return { ok: true, bindings: Object.create(null) as BoundBindingsV1 };
	if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return { ok: false };
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return { ok: false };
	const keys = Reflect.ownKeys(value);
	if (keys.length > BOUND_BINDING_NAMES.length || !keys.every((key): key is string => typeof key === "string" && NAMES.has(key))) return { ok: false };
	const bindings = Object.create(null) as BoundBindingsV1;
	let totalBytes = 0;
	for (const key of [...keys].sort(compareCodeUnits)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
		if (!descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") return { ok: false };
		const entry = descriptor.value;
		const valueBytes = Buffer.byteLength(entry, "utf8");
		if (!entry.length || entry.includes("\0") || !validUnicode(entry) || valueBytes > MAX_VALUE_BYTES) return { ok: false };
		totalBytes += Buffer.byteLength(key, "utf8") + valueBytes;
		if (totalBytes > MAX_TOTAL_BYTES) return { ok: false };
		bindings[key as BoundBindingName] = entry;
	}
	return { ok: true, bindings };
}

/** Public contract projection: names in code-unit order plus a digest over the values. */
export function projectBoundBindings(bindings: BoundBindingsV1 | undefined): BoundBindingsProjectionV1 {
	const names = [...BOUND_BINDING_NAMES]
		.filter((name) => bindings !== undefined && Object.hasOwn(bindings, name) && bindings[name] !== undefined)
		.sort(compareCodeUnits);
	const entries = names.map((name) => ({ name, value: bindings![name]! }));
	return {
		version: BOUND_BINDINGS_VERSION,
		namespace: BOUND_BINDINGS_NAMESPACE,
		names,
		valuesDigest: canonicalSha256({ version: BOUND_BINDINGS_VERSION, entries }),
	};
}
