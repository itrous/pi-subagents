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
});
