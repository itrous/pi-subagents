import type { Readable } from "node:stream";
import {
	TOOL_REGISTRY_MAX_FRAME_BYTES,
	TOOL_REGISTRY_MAX_NAMES,
	validToolRegistryName,
	type ToolRegistryChildFrameV1,
	type ToolRegistryProtocolErrorCode,
} from "./tool-registry-proof.ts";

export type ToolRegistryCollected =
	| { ok: true; frame: ToolRegistryChildFrameV1 }
	| { ok: false; code: Extract<ToolRegistryProtocolErrorCode, "missing_frame" | "invalid_frame" | "multiple_frames" | "frame_too_large">; partial?: boolean };

export interface ToolRegistryCollector {
	readonly result: Promise<ToolRegistryCollected>;
	finalize(): void;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function validNames(value: unknown): value is string[] {
	return Array.isArray(value) && value.length <= TOOL_REGISTRY_MAX_NAMES
		&& value.every(validToolRegistryName)
		&& value.every((name, index) => index === 0 || value[index - 1]! < name);
}

export function parseToolRegistryFrame(value: unknown, expectedNonce: string): ToolRegistryChildFrameV1 | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || typeof record.kind !== "string" || record.proofNonce !== expectedNonce) return undefined;
	if (record.kind === "registry") {
		if (!exactKeys(record, ["version", "kind", "projection", "proofNonce"]) || !record.projection || typeof record.projection !== "object" || Array.isArray(record.projection)) return undefined;
		const p = record.projection as Record<string, unknown>;
		if (!exactKeys(p, ["version", "projectionVersion", "required", "effectiveCallerTools", "internalTools", "missing", "digest"])
			|| p.version !== 1 || p.projectionVersion !== 1 || typeof p.digest !== "string" || !/^[0-9a-f]{64}$/u.test(p.digest)
			|| ![p.required, p.effectiveCallerTools, p.internalTools, p.missing].every(validNames)) return undefined;
		return { version: 1, kind: "registry", projection: record.projection } as ToolRegistryChildFrameV1;
	}
	if (record.kind === "unrepresentable") {
		if (!exactKeys(record, ["version", "kind", "code", "proofNonce"]) || !["too_many_tools", "invalid_tool_name", "frame_too_large"].includes(String(record.code))) return undefined;
		return { version: 1, kind: "unrepresentable", code: record.code } as ToolRegistryChildFrameV1;
	}
	if (record.kind === "protocol") {
		if (!exactKeys(record, ["version", "kind", "code", "proofNonce"]) || !["unsupported_payload_shape", "duplicate_tool_name", "active_registry_drift", "runtime_version_drift", "model_api_drift", "runtime_bytes_drift", "package_bytes_drift", "package_load_error"].includes(String(record.code))) return undefined;
		return { version: 1, kind: "protocol", code: record.code } as ToolRegistryChildFrameV1;
	}
	return undefined;
}

function parseCollectedBytes(chunks: Buffer[], bytes: number, expectedNonce: string): ToolRegistryCollected {
	if (bytes === 0) return { ok: false, code: "missing_frame" };
	let text: string;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
	catch { return { ok: false, code: "invalid_frame" }; }
	const lines = text.split("\n");
	if (lines.at(-1) !== "") return { ok: false, code: "invalid_frame", partial: true };
	lines.pop();
	if (lines.length === 0) return { ok: false, code: "missing_frame" };
	if (lines.length !== 1) return { ok: false, code: "multiple_frames" };
	let parsed: unknown;
	try { parsed = JSON.parse(lines[0]!); } catch { return { ok: false, code: "invalid_frame" }; }
	const frame = parseToolRegistryFrame(parsed, expectedNonce);
	return frame ? { ok: true, frame } : { ok: false, code: "invalid_frame" };
}

export function createToolRegistryCollector(stream: Readable, expectedNonce: string): ToolRegistryCollector {
	let settle!: (result: ToolRegistryCollected) => void;
	let settled = false; let bytes = 0;
	const chunks: Buffer[] = [];
	const result = new Promise<ToolRegistryCollected>((resolve) => { settle = resolve; });
	const finish = (value?: ToolRegistryCollected) => {
		if (settled) return;
		settled = true;
		stream.removeAllListeners("data"); stream.removeAllListeners("end"); stream.removeAllListeners("error");
		if (!stream.destroyed) stream.destroy();
		settle(value ?? parseCollectedBytes(chunks, bytes, expectedNonce));
	};
	stream.on("data", (chunk: Buffer | string) => {
		if (settled) return;
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > TOOL_REGISTRY_MAX_FRAME_BYTES) { finish({ ok: false, code: "frame_too_large" }); return; }
		chunks.push(Buffer.from(buffer));
	});
	stream.on("error", () => finish({ ok: false, code: "invalid_frame", partial: true }));
	stream.on("end", () => finish()); stream.on("close", () => finish());
	return { result, finalize: () => finish(bytes === 0 ? { ok: false, code: "missing_frame" } : { ok: false, code: "invalid_frame", partial: true }) };
}

export function collectToolRegistryFrame(stream: Readable, expectedNonce: string): Promise<ToolRegistryCollected> {
	return createToolRegistryCollector(stream, expectedNonce).result;
}
