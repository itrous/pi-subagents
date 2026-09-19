// C5 spike: in-process child session (upstream child-session.ts path) + abort()/dispose() while a tool runs.
// Usage: node c5-host.mjs <ignore|respect|sync> [--hang-shutdown]
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { startFaux } from "./faux-server.mjs";

const PI = "/opt/homebrew/Cellar/pi-coding-agent/0.85.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const mode = process.argv[2] ?? "ignore";
const hangShutdown = process.argv.includes("--hang-shutdown");
const DIR = path.dirname(new URL(import.meta.url).pathname);
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir || !agentDir.startsWith(DIR) || !process.env.HOME.startsWith(DIR)) throw new Error("throwaway HOME/PI_CODING_AGENT_DIR required");
const cwd = path.join(DIR, "work");
const ticks = path.join(DIR, `ticks-${mode}${hangShutdown ? "-hang" : ""}.log`);
fs.rmSync(ticks, { force: true });
const T0 = Date.now();
const t = () => `+${String(Date.now() - T0).padStart(5)}ms`;
const log = (...a) => console.log(t(), ...a);

const { server, port } = await startFaux((m) => log(m));
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
  providers: { faux: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "faux",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: true },
    models: [{ id: "faux-1", reasoning: false, contextWindow: 100000, maxTokens: 1000 }] } },
}));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let childPid;
const tick = (s) => fs.appendFileSync(ticks, `${Date.now() - T0} ${s}\n`);

function extension(pi) {
  pi.registerTool({
    name: `spike_${mode}`, label: "spike", description: "spike tool, call it",
    parameters: { type: "object", properties: {} },
    async execute(_id, _params, signal) {
      tick("start");
      if (mode === "sync") { tick("sync-loop-enter"); for (;;) {} }
      const child = spawn("sleep", ["30"], mode === "respect" ? { signal, stdio: "ignore" } : { stdio: "ignore" });
      child.on("error", () => {});
      childPid = child.pid; tick(`spawned sleep pid=${child.pid}`);
      for (let i = 1; i <= 10; i++) {
        if (mode === "respect" && signal?.aborted) { tick(`aborted-observed i=${i}`); throw new Error("aborted"); }
        await (mode === "respect"
          ? new Promise((r, j) => { const h = setTimeout(r, 1000); signal?.addEventListener("abort", () => { clearTimeout(h); r(); }, { once: true }); })
          : sleep(1000));
        tick(`tick ${i} signal.aborted=${signal?.aborted}`);
      }
      tick("end");
      return { content: [{ type: "text", text: "tool finished" }], details: {} };
    },
  });
  pi.on("session_shutdown", async () => {
    tick("session_shutdown handler start");
    if (hangShutdown) await sleep(20000);
    tick("session_shutdown handler end");
  });
}

const pic = await import(PI);
log("pi module loaded, exports:", ["createAgentSession", "DefaultResourceLoader", "ModelRuntime", "SessionManager", "SettingsManager", "resolveCliModel"].map((k) => `${k}:${typeof pic[k]}`).join(" "));
const modelRuntime = await pic.ModelRuntime.create();
const settingsManager = pic.SettingsManager.create(cwd, agentDir);
const loader = new pic.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [{ name: "spike", factory: extension }] });
if ("loaded" in loader) loader.loaded = true; // upstream resetExtensionCacheOnReload
await loader.reload();
const resolved = pic.resolveCliModel({ cliModel: "faux/faux-1", modelRuntime });
if (resolved.error) throw new Error(resolved.error);
const { session } = await pic.createAgentSession({ cwd, agentDir, modelRuntime, model: resolved.model, resourceLoader: loader, sessionManager: pic.SessionManager.inMemory(cwd), settingsManager, sessionStartEvent: { type: "session_start", reason: "startup" } });
await session.bindExtensions({ mode: "print", onError: (e) => log("ext error", e.event, String(e.error)) });

let disposed = false;
const eventsAfterDispose = [];
session.subscribe((ev) => {
  if (disposed) eventsAfterDispose.push(ev.type);
  if (["tool_execution_start", "tool_execution_end", "agent_end", "turn_end", "message_end"].includes(ev.type)) log(`event ${ev.type}${ev.toolName ? " " + ev.toolName : ""}${ev.isError !== undefined ? " isError=" + ev.isError : ""}`);
});
// Also observe at agent level (session.dispose() clears session listeners).
session.agent.subscribe?.((ev) => { if (disposed) eventsAfterDispose.push("agent:" + ev.type); });

if (mode === "sync") setInterval(() => log("heartbeat"), 250).unref();

const toolStarted = new Promise((r) => session.subscribe((ev) => ev.type === "tool_execution_start" && r()));
log("prompt() start");
const promptP = session.prompt("go").then(() => ({ ok: true }), (e) => ({ ok: false, err: String(e) }));
promptP.then((r) => log("prompt() settled", JSON.stringify(r), "lastStop=", session.messages.at(-1)?.stopReason, "lastRole=", session.messages.at(-1)?.role));
await toolStarted;
await sleep(1500);

log("abort() called");
const tA = Date.now();
const abortP = session.abort().then(() => log(`abort() resolved after ${Date.now() - tA}ms`), (e) => log("abort() rejected", String(e)));
// upstream: abortChild() is void; kill() hard-settles after 3000 ms, then finish() -> child.dispose()
const settled = await Promise.race([abortP.then(() => "abort"), sleep(3000).then(() => "hard-timer-3000")]);
log(`settle via ${settled}`);

// upstream child.dispose(): race session_shutdown vs shutdownTimeoutMs (5000), then session.dispose()
const tD = Date.now();
log("dispose() called");
const runner = session.extensionRunner;
if (runner.hasHandlers("session_shutdown")) await Promise.race([runner.emit({ type: "session_shutdown", reason: "quit" }), sleep(5000)]);
session.dispose();
disposed = true;
log(`dispose() resolved after ${Date.now() - tD}ms`);

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
log(`child sleep pid=${childPid} alive=${childPid ? alive(childPid) : "n/a"}`);
await sleep(mode === "respect" ? 2000 : 11000);
log(`after wait: child sleep pid=${childPid} alive=${childPid ? alive(childPid) : "n/a"}`);
log("events after dispose:", JSON.stringify(eventsAfterDispose));
log("ticks file:\n" + fs.readFileSync(ticks, "utf8"));
if (childPid && alive(childPid)) { process.kill(childPid, "SIGKILL"); log(`cleanup: killed own child ${childPid}`); }
server.close();
process.exit(0);
