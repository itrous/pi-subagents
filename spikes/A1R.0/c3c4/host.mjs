// Minimal in-process child-session host reproducing upstream child-session.ts open() (8bd275bb, ~:285-345).
import fs from "node:fs";
import path from "node:path";

export const PI_ROOT = "/opt/homebrew/Cellar/pi-coding-agent/0.85.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent";
export const pi = await import(path.join(PI_ROOT, "dist/index.js"));

export function writeModelsJson(agentDir, port) {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      faux: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: "faux-key",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: "faux-1", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000 }],
      },
    },
  }, null, 2));
}

export function envSnapshot() {
  const keys = Object.keys(process.env).sort();
  return JSON.stringify(keys.map((k) => [k, process.env[k]]));
}

function applyEnv(values) {
  const saved = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
}

let loading = Promise.resolve();

/**
 * windowMode:
 *   "none"  - processEnv is not applied at all
 *   "load"  - applied only around loader.reload() (extension factory calls), restored right after
 *   "bind"  - applied from reload through bindExtensions (upstream window), restored right after
 */
export async function createChild({ cwd, agentDir, extensionPaths = [], hooks = [], processEnv, windowMode = "none", onWindowClosed, modelRef = "faux/faux-1" }) {
  const modelRuntime = await pi.ModelRuntime.create();
  const settingsManager = pi.SettingsManager.create(cwd, agentDir);
  const themeKey = Symbol.for("@earendil-works/pi-coding-agent:theme");
  if (!globalThis[themeKey] && typeof pi.initTheme === "function") pi.initTheme(settingsManager.getTheme());
  const loader = new pi.DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: extensionPaths,
    extensionFactories: hooks,
  });
  const errors = [];
  const open = async () => {
    let restore = () => {};
    if (windowMode !== "none") restore = applyEnv(processEnv);
    if ("loaded" in loader) loader.loaded = true; // upstream resetExtensionCacheOnReload
    await loader.reload();
    if (windowMode === "load") { restore(); restore = () => {}; onWindowClosed?.("after-reload"); }
    const ext = loader.getExtensions();
    for (const e of ext.errors) errors.push({ phase: "load", path: e.path, error: String(e.error) });
    const resolved = pi.resolveCliModel({ cliModel: modelRef, modelRuntime });
    if (resolved.error) throw new Error(resolved.error);
    const sessionManager = pi.SessionManager.inMemory(cwd);
    const { session } = await pi.createAgentSession({
      cwd, agentDir, modelRuntime, model: resolved.model,
      resourceLoader: loader, sessionManager, settingsManager,
      sessionStartEvent: { type: "session_start", reason: "startup" },
    });
    await session.bindExtensions({ mode: "print", onError: (e) => errors.push({ phase: e.event, path: e.extensionPath, error: String(e.error?.stack ?? e.error) }) });
    if (windowMode === "bind") { restore(); onWindowClosed?.("after-bind"); }
    return session;
  };
  const opened = loading.catch(() => {}).then(open);
  loading = opened;
  const session = await opened;
  const dispose = async () => {
    const runner = session.extensionRunner;
    if (runner.hasHandlers("session_shutdown")) {
      await Promise.race([runner.emit({ type: "session_shutdown", reason: "quit" }), new Promise((r) => setTimeout(r, 5000).unref?.())]);
    }
    session.dispose();
  };
  return { session, errors, dispose };
}

export function toolResultsOf(session, maxLen = 300) {
  return session.messages.filter((m) => m.role === "toolResult").map((m) => ({
    tool: m.toolName, isError: m.isError, text: (m.content ?? []).map((c) => c.text ?? "").join("").slice(0, maxLen),
  }));
}
