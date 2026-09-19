// C3: pi-mcp-adapter as a child-session extension with MCP_DIRECT_TOOLS applied only in a window.
// usage: node c3.mjs <windowMode none|load|bind> <agentDir> [--trace] [--no-prompt] [--marker <name>] [--parent-env <MCP_DIRECT_TOOLS of parent>]
// --marker is part of the MCP server args, hence of the adapter cache hash: same marker as prime => valid cache.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createChild, envSnapshot, toolResultsOf, writeModelsJson } from "./host.mjs";
import { startFauxLlm } from "./faux-llm.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ADAPTER = process.env.C3_ADAPTER ?? "/Users/kiriller/.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts";
const [windowMode, agentDirArg, ...flags] = process.argv.slice(2);
const agentDir = path.resolve(agentDirArg);
const trace = flags.includes("--trace");
const noPrompt = flags.includes("--no-prompt");
const markerIdx = flags.indexOf("--marker");
const MARKER = markerIdx >= 0 ? flags[markerIdx + 1] : `c3fixture-${path.basename(path.dirname(agentDir))}`;
const REQUESTED = "fx/alpha,fx/gamma";

if (process.env.PI_CODING_AGENT_DIR !== agentDir) throw new Error("run with PI_CODING_AGENT_DIR=" + agentDir);
const parentIdx = flags.indexOf("--parent-env");
if (parentIdx >= 0) process.env.MCP_DIRECT_TOOLS = flags[parentIdx + 1]; // parent process has its own selection
else if ("MCP_DIRECT_TOOLS" in process.env) throw new Error("parent must not have MCP_DIRECT_TOOLS");

const faux = await startFauxLlm();
writeModelsJson(agentDir, faux.port);
fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({
  mcpServers: { fx: { command: process.execPath, args: [path.join(HERE, "fixture-mcp-server.mjs"), MARKER] } },
}, null, 2));
const cacheBefore = fs.existsSync(path.join(agentDir, "mcp-cache.json"));

const fixtureProcs = () => {
  const out = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" });
  return out.split("\n").filter((l) => l.includes(MARKER) && l.includes("fixture-mcp-server.mjs")).map((l) => Number(l.trim().split(/\s+/)[0]));
};

let phase = "pre-create/in-window";
const reads = [];
if (trace) {
  const real = process.env;
  process.env = new Proxy(real, {
    get(t, k, r) {
      if (k === "MCP_DIRECT_TOOLS") {
        const frames = new Error().stack.split("\n").slice(2).filter((f) => f.includes("pi-mcp-adapter")).slice(0, 2).map((f) => f.trim().replace(/^at /, "").replace(/^.*node_modules\//, ""));
        reads.push({ phase, value: t[k], frames });
      }
      return Reflect.get(t, k, r);
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

const snap0 = envSnapshot();
const procs0 = fixtureProcs().length;
const snaps = {};
const child = await createChild({
  cwd: path.join(HERE, "ws/parent"), agentDir, extensionPaths: [ADAPTER],
  processEnv: { MCP_DIRECT_TOOLS: REQUESTED }, windowMode,
  onWindowClosed: (at) => { phase = `after-window(${at})`; snaps.afterWindow = envSnapshot(); },
});
if (windowMode === "none") { phase = "after-create"; }
snaps.afterCreate = envSnapshot();
const mcpTools = () => child.session.getAllTools().map((t) => t.name).filter((n) => n === "mcp" || n.startsWith("fx_")).sort();
const toolsAfterCreate = mcpTools();
const activeAfterCreate = child.session.getActiveToolNames().filter((n) => n === "mcp" || n.startsWith("fx_")).sort();
const procsAfterCreate = fixtureProcs().length;

let toolsAfterPrompt, results, procsAfterPrompt, llmToolsSeen;
if (!noPrompt) {
  phase = "prompt";
  await child.session.prompt('CALLS:[{"name":"fx_alpha","args":{"x":"1"}}]');
  // allow async hot-load to settle
  await new Promise((r) => setTimeout(r, 1500));
  toolsAfterPrompt = mcpTools();
  results = toolResultsOf(child.session);
  procsAfterPrompt = fixtureProcs().length;
  llmToolsSeen = faux.log.map((e) => (e.tools ?? []).filter((n) => n === "mcp" || n.startsWith("fx_")));
  snaps.afterPrompt = envSnapshot();
}
phase = "dispose";
await child.dispose();
let procsAfterDispose = fixtureProcs().length;
for (let i = 0; i < 30 && procsAfterDispose > procs0; i++) { await new Promise((r) => setTimeout(r, 100)); procsAfterDispose = fixtureProcs().length; }
phase = "post";
snaps.afterDispose = envSnapshot();
faux.server.close();

const eq = Object.fromEntries(Object.entries(snaps).map(([k, v]) => [k, v === snap0]));
console.log(JSON.stringify({
  windowMode, requested: REQUESTED, cacheExistedBefore: cacheBefore,
  cacheExistsAfter: fs.existsSync(path.join(agentDir, "mcp-cache.json")),
  toolsAfterCreate, activeAfterCreate, toolsAfterPrompt, llmToolsSeen, results,
  procs: { before: procs0, afterCreate: procsAfterCreate, afterPrompt: procsAfterPrompt, afterDispose: procsAfterDispose },
  envEqualToInitial: eq, parentMCP_DIRECT_TOOLS_now: process.env.MCP_DIRECT_TOOLS ?? null,
  errors: child.errors, ...(trace ? { mcpDirectToolsReads: reads } : {}),
}, null, 2));
process.exit(0);
