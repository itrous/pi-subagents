import type { Readable } from "node:stream";
import { validToolRegistryName } from "./tool-registry-proof.ts";

export const DENIED_TOOL_MAX_CALLS = 128;
export const DENIED_TOOL_MAX_FRAME_BYTES = 128 * 1024;
export type DeniedToolReasonV1 = "permission_rule" | "tool_budget";
export interface DeniedToolCallV1 { tool: string; reason: DeniedToolReasonV1 }
export interface DeniedToolProofFrameV1 { version: 1; kind: "denied_tool_calls"; calls: DeniedToolCallV1[]; overflow: boolean }
export type DeniedToolProofErrorCode = "missing_frame" | "invalid_frame" | "multiple_frames" | "frame_too_large";
export type DeniedToolCollected = { ok: true; frame: DeniedToolProofFrameV1 } | { ok: false; code: DeniedToolProofErrorCode; partial?: boolean };
export interface DeniedToolCollector { result: Promise<DeniedToolCollected>; finalize(): void }

const intrinsicStringify = JSON.stringify.bind(JSON);
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value); return actual.length === keys.length && actual.every((key) => keys.includes(key)); }
export function validDeniedToolCall(value: unknown): value is DeniedToolCallV1 {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value)
		&& exactKeys(value as Record<string, unknown>, ["tool", "reason"])
		&& validToolRegistryName((value as { tool?: unknown }).tool)
		&& ((value as { reason?: unknown }).reason === "permission_rule" || (value as { reason?: unknown }).reason === "tool_budget");
}
export function encodeDeniedToolFrame(frame: DeniedToolProofFrameV1 & { proofNonce: string }): string | undefined {
	if (frame.version !== 1 || frame.kind !== "denied_tool_calls" || typeof frame.overflow !== "boolean"
		|| !/^[0-9a-f]{64}$/u.test(frame.proofNonce) || !Array.isArray(frame.calls) || frame.calls.length > DENIED_TOOL_MAX_CALLS
		|| (frame.overflow && frame.calls.length !== DENIED_TOOL_MAX_CALLS)
		|| frame.calls.some((call) => !validDeniedToolCall(call))) return undefined;
	const encoded = `${intrinsicStringify(frame)}\n`;
	return Buffer.byteLength(encoded, "utf8") <= DENIED_TOOL_MAX_FRAME_BYTES ? encoded : undefined;
}
function parse(bytes: Buffer, nonce: string): DeniedToolCollected {
	if (!bytes.length) return { ok: false, code: "missing_frame" };
	let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return { ok: false, code: "invalid_frame", ...(bytes.at(-1) !== 0x0a ? { partial: true } : {}) }; }
	const lines = text.split("\n"); if (lines.at(-1) !== "") return { ok: false, code: "invalid_frame", partial: true }; lines.pop();
	if (lines.length !== 1) return { ok: false, code: lines.length === 0 ? "missing_frame" : "multiple_frames" };
	let parsed: unknown; try { parsed = JSON.parse(lines[0]!); } catch { return { ok: false, code: "invalid_frame" }; }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, code: "invalid_frame" };
	const record = parsed as Record<string, unknown>;
	if (!exactKeys(record, ["version", "kind", "calls", "overflow", "proofNonce"]) || record.version !== 1 || record.kind !== "denied_tool_calls"
		|| record.proofNonce !== nonce || typeof record.overflow !== "boolean" || !Array.isArray(record.calls)
		|| record.calls.length > DENIED_TOOL_MAX_CALLS || (record.overflow && record.calls.length !== DENIED_TOOL_MAX_CALLS)
		|| record.calls.some((call) => !validDeniedToolCall(call))) return { ok: false, code: "invalid_frame" };
	return { ok: true, frame: { version: 1, kind: "denied_tool_calls", calls: record.calls.map((call) => ({ ...(call as DeniedToolCallV1) })), overflow: record.overflow } };
}
export function createDeniedToolCollector(stream: Readable, nonce: string): DeniedToolCollector {
	let settle!: (value: DeniedToolCollected) => void; let settled = false; let size = 0; const chunks: Buffer[] = [];
	const result = new Promise<DeniedToolCollected>((resolve) => { settle = resolve; });
	const finish = (value?: DeniedToolCollected) => { if (settled) return; settled = true; stream.removeAllListeners("data"); stream.removeAllListeners("end"); stream.removeAllListeners("error"); if (!stream.destroyed) stream.destroy(); settle(value ?? parse(Buffer.concat(chunks, size), nonce)); };
	stream.on("data", (chunk: Buffer | string) => { if (settled) return; const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length; if (size > DENIED_TOOL_MAX_FRAME_BYTES) finish({ ok: false, code: "frame_too_large" }); else chunks.push(Buffer.from(bytes)); });
	stream.on("error", () => finish({ ok: false, code: "invalid_frame", partial: true })); stream.on("end", () => finish()); stream.on("close", () => finish());
	return { result, finalize: () => finish(size === 0 ? { ok: false, code: "missing_frame" } : { ok: false, code: "invalid_frame", partial: true }) };
}
