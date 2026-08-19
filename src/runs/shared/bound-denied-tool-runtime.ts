import * as fs from "node:fs";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DENIED_TOOL_MAX_CALLS, encodeDeniedToolFrame, validDeniedToolCall, type DeniedToolCallV1 } from "./denied-tool-proof.ts";
import type { BoundToolRegistryPolicyV1 } from "./tool-registry-proof.ts";

interface RuntimeState { policy: BoundToolRegistryPolicyV1; denialCalls: DeniedToolCallV1[]; denialOverflow: boolean; denialWritten: boolean; exit: (code: number) => never }
const holder = createRequire(import.meta.url)("./bound-tool-registry-state.cjs") as { state?: RuntimeState };
const write = fs.writeSync.bind(fs); const close = fs.closeSync.bind(fs); const toBuffer = Buffer.from.bind(Buffer);

export function recordBoundDeniedTool(tool: string, reason: DeniedToolCallV1["reason"]): void {
	const state = holder.state; if (!state) return;
	const call = { tool, reason } as DeniedToolCallV1;
	if (!validDeniedToolCall(call)) state.exit(78);
	if (state.denialCalls.length < DENIED_TOOL_MAX_CALLS) state.denialCalls.push(call); else state.denialOverflow = true;
}
function emitProof(): void {
	const state = holder.state; if (!state || state.denialWritten) return;
	state.denialWritten = true;
	const encoded = encodeDeniedToolFrame({ version: 1, kind: "denied_tool_calls", calls: state.denialCalls, overflow: state.denialOverflow, proofNonce: state.policy.proofNonce });
	if (!encoded) state.exit(78);
	try {
		const bytes = toBuffer(encoded!, "utf8"); let offset = 0;
		while (offset < bytes.length) { const written = write(state.policy.denialFd, bytes, offset, bytes.length - offset); if (!Number.isInteger(written) || written <= 0) state.exit(78); offset += written; }
	}
	catch { try { close(state.policy.denialFd); } catch {} return state.exit(78); }
	try { close(state.policy.denialFd); } catch { state.exit(78); }
}
export function registerBoundDeniedToolLifecycle(pi: ExtensionAPI): void {
	if (!holder.state) return;
	const on = pi.on as unknown as (event: string, handler: () => unknown) => void;
	on("agent_settled", emitProof); on("session_shutdown", emitProof);
}
