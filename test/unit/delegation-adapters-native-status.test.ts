import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toSubagentDelegationResponse } from "../../src/slash/delegation-adapters.ts";

describe("delegation native terminal priority", () => {
	it("keeps a registry mismatch terminal status when cancellation races it", () => {
		const response = toSubagentDelegationResponse(
			{ requestId: "r", ownerRunId: "o", nodeId: "n", result: { kind: "text" } } as any,
			{ isError: true, content: [], details: { results: [{ exitCode: 1, nativeStatus: "native_tool_registry_mismatch", transportIncomplete: true, toolsExtra: ["extra"] }] } } as any,
			true,
		);
		assert.equal(response.status, "native_tool_registry_mismatch");
		assert.deepEqual(response.toolsExtra, ["extra"]);
	});
	it("keeps registry mismatch priority while projecting a missing denial frame", () => {
		const response = toSubagentDelegationResponse(
			{ requestId: "r", ownerRunId: "o", nodeId: "n", result: { kind: "text" }, binding: {} } as any,
			{ isError: true, content: [], details: { results: [{ exitCode: 1, nativeStatus: "native_tool_registry_mismatch", toolsMissing: ["read"], deniedToolCallsError: "missing_frame", transportIncomplete: true }] } } as any,
			false,
		);
		assert.equal(response.status, "native_tool_registry_mismatch");
		assert.deepEqual(response.toolsMissing, ["read"]);
		assert.equal(response.deniedToolCallsError, "missing_frame");
	});

	it("projects denial proof while preserving completed result", () => {
		const response = toSubagentDelegationResponse(
			{ requestId: "r", ownerRunId: "o", nodeId: "n", result: { kind: "text" }, binding: {} } as any,
			{ content: [], details: { results: [{ exitCode: 0, finalOutput: "ok", deniedToolCalls: [{ tool: "read", reason: "permission_rule" }], transportIncomplete: true }] } } as any,
			false,
		);
		assert.equal(response.status, "completed"); assert.deepEqual(response.result, { kind: "text", text: "ok" });
		assert.deepEqual(response.deniedToolCalls, [{ tool: "read", reason: "permission_rule" }]); assert.equal(response.transportIncomplete, true);
	});
	it("fails malformed denial fields closed before public projection", () => {
		const response = toSubagentDelegationResponse(
			{ requestId: "r", ownerRunId: "o", nodeId: "n", result: { kind: "text" }, binding: {} } as any,
			{ content: [], details: { results: [{ exitCode: 0, finalOutput: "must not project", deniedToolCalls: [{ tool: "read", reason: "forged", args: "secret" }], deniedToolCallsOverflow: true }] } } as any,
			false,
		);
		assert.equal(response.status, "native_denied_tools_protocol_error"); assert.equal(response.result, undefined);
		assert.equal(response.deniedToolCalls, undefined); assert.equal(response.deniedToolCallsError, "invalid_frame"); assert.equal(response.transportIncomplete, true);
	});
	it("omits denial proof fields from unbound legacy responses", () => {
		const response = toSubagentDelegationResponse(
			{ requestId: "r", ownerRunId: "o", nodeId: "n", result: { kind: "text" } } as any,
			{ content: [], details: { results: [{ exitCode: 0, finalOutput: "ok", deniedToolCalls: [{ tool: "read", reason: "permission_rule" }], transportIncomplete: true }] } } as any,
			false,
		);
		assert.equal(response.status, "completed"); assert.equal(response.deniedToolCalls, undefined);
	});
	it("projects denial protocol error without fabricated zero", () => {
		const response = toSubagentDelegationResponse(
			{ requestId: "r", ownerRunId: "o", nodeId: "n", result: { kind: "text" }, binding: {} } as any,
			{ isError: true, content: [], details: { results: [{ exitCode: 1, nativeStatus: "native_denied_tools_protocol_error", deniedToolCallsError: "missing_frame", transportIncomplete: true }] } } as any,
			false,
		);
		assert.equal(response.status, "native_denied_tools_protocol_error"); assert.equal(response.deniedToolCalls, undefined); assert.equal(response.deniedToolCallsError, "missing_frame");
	});
});
