import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { canonicalSha256 } from "../../src/shared/canonical-json.ts";
import { launchBindingDigest } from "../../src/shared/launch-contract.ts";
import {
	expectedToolRegistryProjection,
	extractProviderPayloadToolNames,
	runtimeBuiltinProjection,
	toolRegistryProjection,
	validateBoundToolRegistryPolicy,
} from "../../src/runs/shared/tool-registry-proof.ts";
import { collectToolRegistryFrame, createToolRegistryCollector } from "../../src/runs/shared/tool-registry-collector.ts";

function openai(names: string[]) {
	return { tools: names.map((name) => ({ type: "function", name, description: "x", parameters: {} })) };
}

describe("bound tool registry projection", () => {
	it("builds deterministic expected and measured projections", () => {
		const expected = expectedToolRegistryProjection(["structured_output", "read"], ["structured_output"]);
		assert.ok(expected);
		assert.deepEqual(expected.required, ["read", "structured_output"]);
		assert.deepEqual(expected.effectiveCallerTools, ["read"]);
		assert.deepEqual(expected.internalTools, ["structured_output"]);
		assert.deepEqual(expected.missing, []);
		const { digest, ...base } = expected;
		assert.equal(digest, canonicalSha256(base));
		const measured = toolRegistryProjection({ required: expected.required, actual: ["extra", "structured_output"], internalExpected: ["structured_output"] });
		assert.deepEqual(measured?.effectiveCallerTools, ["extra"]);
		assert.deepEqual(measured?.missing, ["read"]);
	});

	it("fails closed for invalid policy bounds, APIs, and non-scalar Unicode", () => {
		assert.equal(validateBoundToolRegistryPolicy({ version: 1, modelApi: "unknown", piRuntimeVersion: "0.84.3", required: [], internalTools: [], packageExtensions: [] }), undefined);
		assert.equal(validateBoundToolRegistryPolicy({ version: 1, modelApi: "openai-responses", piRuntimeVersion: "0.84.3", required: ["x", "x"], internalTools: [], packageExtensions: [] }), undefined);
		assert.equal(expectedToolRegistryProjection(["\ud800"], []), undefined);
		assert.equal(expectedToolRegistryProjection(["\udc00"], []), undefined);
		const runtimeBuiltins = runtimeBuiltinProjection([{ name: "read", sourceInfo: { source: "builtin" } }, { name: "custom", sourceInfo: { source: "package" } }])!;
		assert.deepEqual(runtimeBuiltins.names, ["read"]);
		const policy = (piRuntimeVersion: string) => ({ version: 1, modelApi: "openai-responses", piRuntimeVersion, proofNonce: "d".repeat(64), denialFd: 4, required: ["x"], internalTools: [], packageExtensions: [{ path: "/owner/ext.ts", contentDigest: "a".repeat(64), evidenceRoot: "/owner", evidenceRootDigest: "b".repeat(64), packageTreeDigest: "c".repeat(64) }], runtimeExtensions: { version: 1, entries: [] }, runtimeBuiltins });
		assert.ok(validateBoundToolRegistryPolicy(policy("0.84.3"))); assert.ok(validateBoundToolRegistryPolicy(policy("0.84.4"))); assert.ok(validateBoundToolRegistryPolicy(policy("future-compatible-runtime"))); assert.equal(validateBoundToolRegistryPolicy(policy("bad\nversion")), undefined);
		assert.equal(runtimeBuiltinProjection([{ name: "read", sourceInfo: { source: "builtin" } }, { name: "read", sourceInfo: { source: "package" } }]), undefined);
		const escaped = Array.from({ length: 128 }, (_, index) => `${index.toString().padStart(3, "0")}${"\u0001".repeat(125)}`);
		assert.equal(expectedToolRegistryProjection(escaped, []), undefined);
	});

	it("binds the complete tool registry policy into launch evidence", () => {
		const base = { definitionDigest: "d", inheritProjectContext: false, inheritSkills: false };
		const first = launchBindingDigest({ ...base, toolRegistry: { modelApi: "openai-responses", required: ["read"] } });
		const second = launchBindingDigest({ ...base, toolRegistry: { modelApi: "anthropic-messages", required: ["read"] } });
		assert.notEqual(first, second);
	});
});

describe("provider payload tool extraction", () => {
	it("covers every supported wire grammar", () => {
		assert.deepEqual(extractProviderPayloadToolNames("openai-responses", openai(["b", "a"])), { ok: true, names: ["a", "b"] });
		assert.deepEqual(extractProviderPayloadToolNames("azure-openai-responses", openai(["a"])), { ok: true, names: ["a"] });
		assert.deepEqual(extractProviderPayloadToolNames("openai-codex-responses", openai(["a"])), { ok: true, names: ["a"] });
		assert.deepEqual(extractProviderPayloadToolNames("anthropic-messages", { tools: [{ name: "a", description: "x", input_schema: {} }] }), { ok: true, names: ["a"] });
		const chat = { tools: [{ type: "function", function: { name: "a", description: "x", parameters: {} } }] };
		assert.deepEqual(extractProviderPayloadToolNames("openai-completions", chat), { ok: true, names: ["a"] });
		assert.deepEqual(extractProviderPayloadToolNames("openai-completions", { tools: [{ ...chat.tools[0], cache_control: { type: "ephemeral" } }] }), { ok: true, names: ["a"] });
		assert.deepEqual(extractProviderPayloadToolNames("mistral-conversations", chat), { ok: true, names: ["a"] });
		assert.deepEqual(extractProviderPayloadToolNames("bedrock-converse-stream", { toolConfig: { tools: [{ toolSpec: { name: "a", inputSchema: {} } }] } }), { ok: true, names: ["a"] });
		const google = { config: { tools: [{ functionDeclarations: [{ name: "a", parametersJsonSchema: {} }] }] } };
		assert.deepEqual(extractProviderPayloadToolNames("google-generative-ai", google), { ok: true, names: ["a"] });
		assert.deepEqual(extractProviderPayloadToolNames("google-vertex", google), { ok: true, names: ["a"] });
		assert.deepEqual(extractProviderPayloadToolNames("pi-messages", { context: { tools: [{ name: "a", label: "a", description: "x", parameters: {}, executionMode: "parallel", constrainedSampling: { type: "json_schema", strict: "prefer" }, promptSnippet: "Read files", promptGuidelines: ["Use offsets"] }] } }), { ok: true, names: ["a"] });
		assert.deepEqual(extractProviderPayloadToolNames("pi-messages", { context: { tools: [{ name: "a", description: "x", parameters: {} }] } }), { ok: true, names: ["a"] });
	});

	it("rejects duplicate, deferred, API-crossed, wrapper-extra, and missing nonzero shapes", () => {
		assert.deepEqual(extractProviderPayloadToolNames("openai-responses", openai(["a", "a"])), { ok: false, code: "duplicate_tool_name" });
		assert.deepEqual(extractProviderPayloadToolNames("openai-responses", { tools: [{ type: "function", name: "a", defer_loading: true }] }), { ok: false, code: "unsupported_payload_shape" });
		assert.deepEqual(extractProviderPayloadToolNames("openai-responses", { tools: [{ name: "a", input_schema: {} }] }), { ok: false, code: "unsupported_payload_shape" });
		assert.deepEqual(extractProviderPayloadToolNames("anthropic-messages", openai(["a"])), { ok: false, code: "unsupported_payload_shape" });
		assert.deepEqual(extractProviderPayloadToolNames("mistral-conversations", { tools: [{ type: "function", function: { name: "a" }, extra: true }] }), { ok: false, code: "unsupported_payload_shape" });
		assert.deepEqual(extractProviderPayloadToolNames("mistral-conversations", { tools: [{ type: "custom", custom: { name: "a" } }] }), { ok: false, code: "unsupported_payload_shape" });
		assert.deepEqual(extractProviderPayloadToolNames("openai-responses", { model: "x" }, 1), { ok: false, code: "unsupported_payload_shape" });
		assert.deepEqual(extractProviderPayloadToolNames("openai-responses", { model: "x" }, 0), { ok: true, names: [] });
		assert.deepEqual(extractProviderPayloadToolNames("openai-responses", openai([""])), { ok: false, code: "invalid_tool_name" });
	});
});

describe("tool registry pipe collector", () => {
	const proofNonce = "f".repeat(64);
	async function collect(chunks: Array<string | Buffer>) {
		const stream = new PassThrough();
		const result = collectToolRegistryFrame(stream, proofNonce);
		for (const chunk of chunks) stream.write(chunk);
		stream.end();
		return result;
	}
	it("accepts literal U+FFFD and rejects missing/multiple/fatal invalid utf8", async () => {
		const projection = expectedToolRegistryProjection(["�"], [])!;
		assert.equal((await collect([`${JSON.stringify({ version: 1, kind: "registry", projection, proofNonce })}\n`])).ok, true);
		assert.deepEqual(await collect([`${JSON.stringify({ version: 1, kind: "registry", projection, proofNonce: "0".repeat(64) })}\n`]), { ok: false, code: "invalid_frame" });
		assert.deepEqual(await collect([]), { ok: false, code: "missing_frame" });
		assert.deepEqual(await collect(["{}\n{}\n"]), { ok: false, code: "multiple_frames" });
		assert.deepEqual(await collect([Buffer.from([0xff, 0x0a])]), { ok: false, code: "invalid_frame" });
	});

	it("settles immediately on overflow and explicitly finalizes an inherited open pipe", async () => {
		const overflow = new PassThrough();
		const bounded = createToolRegistryCollector(overflow, proofNonce);
		overflow.write(Buffer.alloc(64 * 1024 + 1));
		assert.deepEqual(await bounded.result, { ok: false, code: "frame_too_large" });

		const closed = new PassThrough(); const closeCollected = createToolRegistryCollector(closed, proofNonce); closed.destroy();
		assert.deepEqual(await closeCollected.result, { ok: false, code: "missing_frame" });

		const inherited = new PassThrough();
		const finalizable = createToolRegistryCollector(inherited, proofNonce);
		inherited.write("{}\n");
		finalizable.finalize();
		assert.deepEqual(await finalizable.result, { ok: false, code: "invalid_frame", partial: true });
	});
});
