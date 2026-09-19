// Minimal host reproducing upstream child-session.ts open() path (8bd275bb):
// DefaultResourceLoader -> loader.reload() -> createAgentSession -> bindExtensions({mode:"print"}) -> prompt().
import fs from "node:fs";
import path from "node:path";
import { startFauxServer } from "./faux-server.mjs";

export const PI_ROOT = "/opt/homebrew/Cellar/pi-coding-agent/0.85.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent";
const HERE = path.dirname(new URL(import.meta.url).pathname);

for (const k of ["HOME", "PI_CODING_AGENT_DIR", "PI_OFFLINE"]) {
	if (!process.env[k]) throw new Error(`env ${k} must be set by the run command`);
}
if (!process.env.PI_CODING_AGENT_DIR.startsWith(HERE) || !process.env.HOME.startsWith(HERE)) {
	throw new Error("HOME / PI_CODING_AGENT_DIR must be inside the spike directory");
}

// Record any non-loopback fetch (evidence that nothing leaves the host).
export const externalFetches = [];
const origFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
	const url = typeof input === "string" ? input : input?.url ?? String(input);
	if (!/^https?:\/\/127\.0\.0\.1[:/]/.test(url)) externalFetches.push(url);
	return origFetch(input, init);
};

export const pi = await import(path.join(PI_ROOT, "dist/index.js"));

export const toolDef = (name) => ({
	name,
	label: name,
	description: `spike tool ${name}`,
	parameters: { type: "object", properties: {}, additionalProperties: false },
	async execute() { return { content: [{ type: "text", text: `${name} done` }], details: {} }; },
});

const sortNames = (xs) => [...xs].sort();
export const sameSet = (a, b) => JSON.stringify(sortNames(new Set(a))) === JSON.stringify(sortNames(new Set(b)));

/**
 * Barrier: wrap session.agent.streamFunction; on tool-set mismatch do NOT call the
 * original stream, throw instead (agent.runWithLifecycle -> handleRunFailure -> stopReason "error").
 */
export function installToolBarrier(agent, expectedNames, log) {
	if (!agent || typeof agent.streamFunction !== "function") throw new Error("barrier self-check: agent.streamFunction is not a function");
	const base = agent.streamFunction;
	const wrapped = function toolBarrierStreamFn(model, context, options) {
		const actual = (context?.tools ?? []).map((t) => t.name);
		log.push({ at: "barrier", model: model?.id, actual: sortNames(actual), expected: sortNames(expectedNames) });
		if (!sameSet(actual, expectedNames)) {
			throw new Error(`TOOL_BARRIER: tool set mismatch expected=[${sortNames(expectedNames)}] actual=[${sortNames(actual)}]`);
		}
		return base(model, context, options);
	};
	agent.streamFunction = wrapped;
	return wrapped;
}

/** Transparent observer of context.tools (used for C2 and for unwrapped controls). */
export function installObserver(agent, log) {
	const base = agent.streamFunction;
	agent.streamFunction = (model, context, options) => {
		log.push({ at: "observer", model: model?.id, actual: sortNames((context?.tools ?? []).map((t) => t.name)) });
		return base(model, context, options);
	};
}

let seq = 0;
export async function openSession({ hooks = [], tools, excludeTools, script = [], retryEnabled = false, settings = {} } = {}) {
	const server = await startFauxServer();
	server.state.script.push(...script);
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			faux: {
				baseUrl: `http://127.0.0.1:${server.port}/v1`,
				api: "openai-completions",
				apiKey: "faux-key",
				compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
				models: [{ id: "faux-1", reasoning: false }, { id: "faux-2", reasoning: false }],
			},
		},
	}, null, 2));
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ ...(retryEnabled ? {} : { retry: { enabled: false } }), ...settings }));
	const cwd = path.join(HERE, "work", `s${++seq}`);
	fs.mkdirSync(cwd, { recursive: true });

	const modelRuntime = await pi.ModelRuntime.create();
	const settingsManager = pi.SettingsManager.create(cwd, agentDir);
	const loader = new pi.DefaultResourceLoader({
		cwd, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [],
		extensionFactories: hooks,
	});
	const selfCheck = { loaderHasLoadedField: "loaded" in loader };
	if (selfCheck.loaderHasLoadedField) loader.loaded = true; // upstream resetExtensionCacheOnReload
	await loader.reload();
	selfCheck.loadErrors = loader.getExtensions().errors;
	const resolved = pi.resolveCliModel({ cliModel: "faux/faux-1", modelRuntime });
	if (resolved.error) throw new Error(resolved.error);
	const extErrors = [];
	const { session } = await pi.createAgentSession({
		cwd, agentDir, modelRuntime,
		model: resolved.model,
		...(tools ? { tools } : {}),
		...(excludeTools ? { excludeTools } : {}),
		resourceLoader: loader,
		sessionManager: pi.SessionManager.inMemory(cwd),
		settingsManager,
		sessionStartEvent: { type: "session_start", reason: "startup" },
	});
	selfCheck.streamFunctionIsFunction = typeof session.agent?.streamFunction === "function";
	const snapshotPreBind = { active: sortNames(session.getActiveToolNames()), all: sortNames(session.getAllTools().map((t) => t.name)) };
	await session.bindExtensions({ mode: "print", onError: (e) => extErrors.push({ event: e.event, error: String(e.error) }) });
	const snapshot = {
		active: sortNames(session.getActiveToolNames()),
		all: sortNames(session.getAllTools().map((t) => t.name)),
	};
	const events = [];
	session.subscribe((ev) => {
		if (ev.type === "message_end" && ev.message?.role === "assistant") {
			events.push({ type: "assistant_end", stopReason: ev.message.stopReason, errorMessage: ev.message.errorMessage });
		}
		if (ev.type === "auto_retry_start") events.push({ type: "auto_retry_start" });
	});
	return { session, server, loader, modelRuntime, selfCheck, snapshotPreBind, snapshot, events, extErrors };
}

export async function closeSession(ctx) {
	try { ctx.session.dispose(); } catch {}
	await ctx.server.close();
}

export function verdictLine(name, ok, detail) {
	const line = `${ok ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(detail)}`;
	console.log(line);
	return ok;
}
