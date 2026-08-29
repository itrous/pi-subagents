import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ACTIVE_BOUND_CORE_RUNTIME_OWNED_TOOLS, CORE_RUNTIME_OWNED_TOOLS } from "../../src/runs/shared/core-runtime-tools.ts";
import { MCP_DIRECT_BUILTIN_TOOL_NAMES } from "../../src/runs/shared/mcp-direct-tool-allowlist.ts";
import { writeChildToolDiagnostic } from "../../src/runs/shared/tool-availability.ts";

describe("Pi 0.84.3 core tool ownership", () => {
	it("requires powershell to be measured in the running child registry", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-core-tools-"));
		try {
			const diagnostic = path.join(root, "diagnostic.json");
			assert.deepEqual(writeChildToolDiagnostic(diagnostic, ["powershell"], [])?.missing, ["powershell"]);
			assert.equal(writeChildToolDiagnostic(diagnostic, ["powershell"], ["powershell"]), undefined);
			assert.equal(fs.existsSync(diagnostic), false);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("keeps general MCP collisions legacy while active-bound reserves powershell", () => {
		assert.deepEqual([...MCP_DIRECT_BUILTIN_TOOL_NAMES], [...CORE_RUNTIME_OWNED_TOOLS, "mcp"]);
		assert.equal(MCP_DIRECT_BUILTIN_TOOL_NAMES.has("powershell"), false);
		assert.equal(ACTIVE_BOUND_CORE_RUNTIME_OWNED_TOOLS.has("powershell"), true);
		assert.equal(MCP_DIRECT_BUILTIN_TOOL_NAMES.has("mcp"), true);
		assert.equal(MCP_DIRECT_BUILTIN_TOOL_NAMES.has("structured_output"), false);
	});
});
