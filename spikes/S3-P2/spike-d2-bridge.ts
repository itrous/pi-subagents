// S3 P2 spike D2 (go/no-go before production code): the private pinned ABI of
// pi-mcp-adapter 2.26.1 through exactly two direct entries, `server-manager.ts`
// and `direct-tools.ts`, imported through the bound attested-roots importer.
//   usage: PI_SUBAGENTS_MCP_OWNER=<owner> node --experimental-strip-types spikes/S3-P2/spike-d2-bridge.ts
// No model, no network, no persistent cache: the agent dir is a fresh temp dir
// whose listing is compared before and after.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createBoundPackageImporter } from "../../src/bound/bound-package-loader.ts";
import { packageTreeEvidence } from "../../src/runs/shared/package-tree-evidence.ts";
import { computeMcpServerHash } from "../../src/runs/shared/mcp-direct-tool-allowlist.ts";

const owner = fs.realpathSync(process.env.PI_SUBAGENTS_MCP_OWNER ?? "");
const adapterRoot = path.join(owner, "node_modules", "pi-mcp-adapter");
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "A1R.5", "fixture-mcp.mjs");
const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const out: Record<string, unknown> = {};

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "s3p2-spike-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const listing = () => fs.readdirSync(agentDir, { recursive: true }).map(String).sort();
const before = listing();

const version = JSON.parse(fs.readFileSync(path.join(adapterRoot, "package.json"), "utf8")).version;
assert.equal(version, "2.26.1");
out.adapterVersion = version;
out.entryDigests = { "server-manager.ts": sha(path.join(adapterRoot, "server-manager.ts")), "direct-tools.ts": sha(path.join(adapterRoot, "direct-tools.ts")) };

const evidence = packageTreeEvidence(path.join(adapterRoot, "index.ts"), owner, owner);
const importer = createBoundPackageImporter(evidence.roots);
const sm = await importer.importNamespace(path.join(adapterRoot, "server-manager.ts")) as Record<string, any>;
const dt = await importer.importNamespace(path.join(adapterRoot, "direct-tools.ts")) as Record<string, any>;
out.abi = {
	McpServerManager: typeof sm.McpServerManager,
	resolveDirectTools: typeof dt.resolveDirectTools,
	createDirectToolExecutor: typeof dt.createDirectToolExecutor,
	managerMethods: ["connect", "close", "closeAll", "getConnection", "setMetadataListChangedListener", "setRuntimeSignal"].map((m) => [m, typeof sm.McpServerManager?.prototype?.[m]]),
};

// Guard: a file outside the attested roots is refused by the importer.
try { await importer.importNamespace(path.join(path.dirname(fileURLToPath(import.meta.url)), "outside.ts")); out.guard = "NOT_REFUSED"; }
catch (error) { out.guard = String((error as Error).message).includes("escaped its attested roots") ? "refused" : `other: ${(error as Error).message}`; }

const tools = ["search", "read", "execute"];
const definition = { command: process.execPath, args: [FIXTURE, "spike", tools.join(","), "200"] };
const config = { mcpServers: { fx: definition }, settings: { disableProxyTool: true } };
const cwd = fs.realpathSync(os.tmpdir());
const controller = new AbortController();
const manager = new sm.McpServerManager(cwd);
manager.setRuntimeSignal(controller.signal);
let listChanged = 0;
manager.setMetadataListChangedListener(() => { listChanged++; });
const t0 = performance.now();
const connection = await manager.connect("fx", definition, controller.signal);
out.connectMs = Math.round(performance.now() - t0);
out.status = connection.status;
out.liveTools = connection.tools.map((tool: { name: string }) => tool.name);
const pid = (connection.transport as { pid?: number | null }).pid ?? null;
out.childPid = typeof pid === "number";

// An in-memory metadata object built only from the live connection.
const cache = { version: 1, servers: { fx: { configHash: computeMcpServerHash(definition as never), cachedAt: Date.now(), tools: connection.tools.map((tool: Record<string, unknown>) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })), resources: [] } } };
const specs = dt.resolveDirectTools(config, cache, "server", ["fx/search", "fx/read"]) as Array<Record<string, unknown>>;
out.specs = specs.map((spec) => spec.prefixedName);
assert.deepEqual(out.specs, ["fx_search", "fx_read"], "explicit selectors only; execute not active");

const state = {
	owner: { signal: controller.signal },
	manager,
	lifecycle: { markKeepAlive() { throw new Error("lifecycle must not be reached for a lazy server"); } },
	toolMetadata: new Map(), resourceCounts: new Map(), promptMetadata: new Map(), promptMetadataLive: new Set(), serverInstructions: new Map(),
	config, failureTracker: new Map(), failureMessages: new Map(), approvedToolCalls: new Map(),
};
const execute = dt.createDirectToolExecutor(() => state, () => null, specs[0]);
const result = await execute("call-1", { q: "x" }, undefined, undefined, {});
out.callResult = result.content?.[0]?.text;
assert.equal(out.callResult, "fixture:spike:search");

// Bounded cleanup: close the one server and observe the process exit.
const t1 = performance.now();
await manager.close("fx");
out.closeMs = Math.round(performance.now() - t1);
out.connectionAfterClose = manager.getConnection("fx")?.status ?? "absent";
let alive = true;
if (typeof pid === "number") { for (let i = 0; i < 40 && alive; i++) { try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive = false; } } }
out.childExited = !alive;
// After close, the executor must not silently reconnect for a bound run: record what it does.
const failureTracker = state.failureTracker;
out.listChanged = listChanged;
const after = listing();
out.agentDirUnchanged = JSON.stringify(before) === JSON.stringify(after);
out.agentDirAfter = after;
out.failureTracker = failureTracker.size;
fs.rmSync(agentDir, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 2));
