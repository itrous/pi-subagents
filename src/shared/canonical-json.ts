import { createHash } from "node:crypto";

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Canonical JSON for already validated plain data. Object keys use UTF-16 code-unit order. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Canonical JSON numbers must be finite.");
		return JSON.stringify(Object.is(value, -0) ? 0 : value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value !== "object") throw new TypeError("Canonical JSON only supports plain JSON data.");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Canonical JSON objects must be plain.");
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const symbols = Object.getOwnPropertySymbols(value);
	if (symbols.length > 0) throw new TypeError("Canonical JSON objects cannot have symbol keys.");
	return `{${Object.keys(descriptors).sort(compareCodeUnits).flatMap((key) => {
		const descriptor = descriptors[key]!;
		if (!("value" in descriptor) || !descriptor.enumerable) throw new TypeError("Canonical JSON properties must be enumerable data properties.");
		if (descriptor.value === undefined) return [];
		return [`${JSON.stringify(key)}:${canonicalJson(descriptor.value)}`];
	}).join(",")}}`;
}

export function canonicalSha256(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
