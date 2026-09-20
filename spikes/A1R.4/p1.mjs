// П1 (Ш0): does the bound leaf get its full MCP direct-tool set when the parent's
// process.cwd() differs from the leaf's session cwd?
//   usage: node p1.mjs <cwdMode match|mismatch> <agentDir> [--layer pi|mcp] [--config-override] [--no-prompt]
// The project MCP config always lives next to the LEAF cwd (Y); the parent process
// runs in X. `match` chdir's to Y, `mismatch` to X.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createChild, envSnapshot, toolResultsOf, writeModelsJson } from "../A1R.0/c3c4/host.mjs";
import { startFauxLlm } from "../A1R.0/c3c4/faux-llm.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIXTURE = path.join(HERE, "..", "A1R.0", "c3c4", "fixture-mcp-server.mjs");
const ADAPTER = process.env.P1_ADAPTER ?? "/Users/kiriller/src/onecpi/node_modules/pi-mcp-adapter/index.ts";
const [cwdMode, agentDirArg, ...flags] = process.argv.slice(2);
if (cwdMode !== "match" && cwdMode !== "mismatch") throw new Error("cwdMode must be match|mismatch");
const agentDir = path.resolve(agentDirArg);
if (process.env.PI_CODING_AGENT_DIR !== agentDir) throw new Error("run with PI_CODING_AGENT_DIR=" + agentDir);
if ("MCP_DIRECT_TOOLS" in process.env) throw new Error("parent must not have MCP_DIRECT_TOOLS");
const layerIdx = flags.indexOf("--layer");
const layer = layerIdx >= 0 ? flags[layerIdx + 1] : "pi";
const configOverride = flags.includes("--config-override");
const noPrompt = flags.includes("--no-prompt");

const run = path.dirname(agentDir);
const X = path.join(run, "ws-parent");
const Y = path.join(run, "ws-leaf");
for (const d of [X, Y, path.join(Y, ".pi")]) fs.mkdirSync(d, { recursive: true });
const MARKER = `p1-${path.basename(run)}`;
const servers = {
  fx: { command: process.execPath, args: [FIXTURE, `${MARKER}-fx`] },
  fy: { command: process.execPath, args: [FIXTURE, `${MARKER}-fy`] },
};
const configPath = layer === "mcp" ? path.join(Y, ".mcp.json") : path.join(Y, ".pi", "mcp.json");
fs.writeFileSync(configPath, JSON.stringify({ mcpServers: servers }, null, 2));
// Positive control on the measurement itself: X must never hold a project config.
for (const p of [path.join(X, ".mcp.json"), path.join(X, ".pi", "mcp.json")]) if (fs.existsSync(p)) throw new Error("parent cwd must be config-free: " + p);

const REQUESTED = "fx/alpha,fx/gamma,fy/beta,fy/delta";
const EXPECTED = ["fx_alpha", "fx_gamma", "fy_beta", "fy_delta"];

if (configOverride) process.argv.push("--mcp-config", configPath);

const faux = await startFauxLlm();
writeModelsJson(agentDir, faux.port);
process.chdir(cwdMode === "match" ? Y : X);

const mcpish = (n) => n === "mcp" || n.startsWith("fx_") || n.startsWith("fy_");
const procs = () => execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
	.split("\n").filter((l) => l.includes(MARKER) && l.includes("fixture-mcp-server.mjs")).length;

const snap0 = envSnapshot();
const procs0 = procs();
const child = await createChild({
	cwd: Y, agentDir, extensionPaths: [ADAPTER],
	processEnv: { MCP_DIRECT_TOOLS: REQUESTED }, windowMode: "bind",
});
const activeAfterCreate = child.session.getActiveToolNames().filter(mcpish).sort();
const allAfterCreate = child.session.getAllTools().map((t) => t.name).filter(mcpish).sort();
const procsAfterCreate = procs();

let activeAfterSettle, allAfterSettle, activeAfterPrompt, results, llmToolsSeen;
await new Promise((r) => setTimeout(r, 2500)); // async hot-load of direct tools, if any
activeAfterSettle = child.session.getActiveToolNames().filter(mcpish).sort();
allAfterSettle = child.session.getAllTools().map((t) => t.name).filter(mcpish).sort();
if (!noPrompt) {
	await child.session.prompt('CALLS:[{"name":"fx_alpha","args":{"x":"1"}}]');
	await new Promise((r) => setTimeout(r, 1500));
	activeAfterPrompt = child.session.getActiveToolNames().filter(mcpish).sort();
	results = toolResultsOf(child.session);
	llmToolsSeen = faux.log.map((e) => (e.tools ?? []).filter(mcpish).sort());
}
await child.dispose();
let procsAfterDispose = procs();
for (let i = 0; i < 30 && procsAfterDispose > procs0; i++) { await new Promise((r) => setTimeout(r, 100)); procsAfterDispose = procs(); }
faux.server.close();

const has = (set) => EXPECTED.every((n) => set?.includes(n));
console.log(JSON.stringify({
	cwdMode, layer, configOverride, adapter: ADAPTER,
	processCwd: process.cwd(), sessionCwd: Y, configPath,
	requested: REQUESTED, expected: EXPECTED,
	activeAfterCreate, allAfterCreate, activeAfterSettle, allAfterSettle, activeAfterPrompt,
	complete: { afterCreate: has(activeAfterCreate), afterSettle: has(activeAfterSettle), afterPrompt: noPrompt ? null : has(activeAfterPrompt) },
	results, llmToolsSeen,
	procs: { before: procs0, afterCreate: procsAfterCreate, afterDispose: procsAfterDispose },
	envEqualToInitial: envSnapshot() === snap0,
	parentMCP_DIRECT_TOOLS_now: process.env.MCP_DIRECT_TOOLS ?? null,
	errors: child.errors,
}, null, 2));
process.exit(0);
