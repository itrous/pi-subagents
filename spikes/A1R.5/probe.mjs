// A1R.5: real probe of the installed pi-subagents on a Linux host.
//   usage: node probe.mjs <mode> <base>
//   mode: adapter-match | adapter-mismatch | adapter-mismatch-config | main | mismatch | foreign-config
// The parent is a Pi 0.85.1 SDK session whose resources come from the isolated
// PI_CODING_AGENT_DIR (settings.json packages: the Git-installed pi-subagents and
// the local owner package). The provider is a faux server on 127.0.0.1; no request
// leaves the host. Output: one JSON document on stdout.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { startFauxLlm } from "./faux-llm.mjs";

const [mode, baseArg] = process.argv.slice(2);
const MODES = ["adapter-match", "adapter-mismatch", "adapter-mismatch-config", "main", "mismatch", "foreign-config"];
if (!MODES.includes(mode) || !baseArg) throw new Error(`usage: node probe.mjs <${MODES.join("|")}> <base>`);
const BASE = fs.realpathSync(baseArg);
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (agentDir !== path.join(BASE, "home", ".pi", "agent")) throw new Error("PI_CODING_AGENT_DIR must be <base>/home/.pi/agent");
if ("MCP_DIRECT_TOOLS" in process.env) throw new Error("the parent must not carry MCP_DIRECT_TOOLS");
const SDK = path.join(BASE, "sdk", "node_modules", "@earendil-works", "pi-coding-agent");
const pi = await import(path.join(SDK, "dist", "index.js"));
const X = path.join(BASE, "ws-parent");
const Y = path.join(BASE, "ws-leaf");
const MCP_CONFIG = path.join(Y, ".pi", "mcp.json");
// Same server names as the project config, other commands: what a host `--mcp-config` flag can point at.
const FOREIGN_MCP_CONFIG = path.join(BASE, "ws-foreign", "mcp.json");
const OWNER = path.join(BASE, "owner");
const ADAPTER = path.join(OWNER, "node_modules", "pi-mcp-adapter", "index.ts");
const ONEC_PAIRS = [
	["bsl-ws", "search"], ["bsl-ws", "symbol_info"], ["bsl-ws", "graph"], ["bsl-ws", "metadata"], ["bsl-ws", "diagnostics"],
	["bsl-ws", "query"], ["bsl-ws", "event_log"], ["bsl-ref", "syntax_help"], ["bsl-ref", "search"], ["bsl-ref", "its_help"],
];
const ONEC_NAMES = ONEC_PAIRS.map(([server, tool]) => `${server}_${tool}`);
const ONEC_SELECTORS = ONEC_PAIRS.map(([server, tool]) => `${server}/${tool}`);
for (const dir of [X, path.join(Y, ".pi")]) fs.mkdirSync(dir, { recursive: true });
for (const candidate of [path.join(X, ".mcp.json"), path.join(X, ".pi", "mcp.json")]) if (fs.existsSync(candidate)) throw new Error(`the parent cwd must be config-free: ${candidate}`);

const faux = await startFauxLlm();
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
	providers: { faux: { baseUrl: `http://127.0.0.1:${faux.port}/v1`, api: "openai-completions", apiKey: "faux-key", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "faux-1", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000 }] } },
}, null, 2));
const processCwd = mode === "adapter-match" || mode === "main" || mode === "foreign-config" ? Y : X;
process.chdir(processCwd);
if (mode === "adapter-mismatch-config" || mode === "mismatch") process.argv.push("--mcp-config", MCP_CONFIG);
if (mode === "foreign-config") process.argv.push("--mcp-config", FOREIGN_MCP_CONFIG);
const envSnapshot = () => JSON.stringify(Object.keys(process.env).sort().map((key) => [key, process.env[key]]));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 20000) {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error(`timeout: ${label}`);
		await sleep(25);
	}
}

// ---- Adapter-only measurement (outcome C of P1, repeated on Linux with the installed adapter) ----
async function adapterMeasurement() {
	const settingsManager = pi.SettingsManager.create(Y, agentDir);
	const loader = new pi.DefaultResourceLoader({ cwd: Y, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [ADAPTER] });
	const modelRuntime = await pi.ModelRuntime.create();
	const { model } = pi.resolveCliModel({ cliModel: "faux/faux-1", modelRuntime });
	const before = envSnapshot();
	process.env.MCP_DIRECT_TOOLS = ONEC_SELECTORS.join(",");
	let session;
	const errors = [];
	try {
		if ("loaded" in loader) loader.loaded = true;
		await loader.reload();
		({ session } = await pi.createAgentSession({ cwd: Y, agentDir, modelRuntime, model, resourceLoader: loader, sessionManager: pi.SessionManager.inMemory(Y), settingsManager, sessionStartEvent: { type: "session_start", reason: "startup" } }));
		await session.bindExtensions({ mode: "print", onError: (error) => errors.push(String(error.error?.stack ?? error.error)) });
	} finally { delete process.env.MCP_DIRECT_TOOLS; }
	const onec = () => session.getActiveToolNames().filter((name) => ONEC_NAMES.includes(name)).sort();
	const afterCreate = onec();
	await sleep(2500);
	const afterSettle = onec();
	const runner = session.extensionRunner;
	if (runner.hasHandlers("session_shutdown")) await Promise.race([runner.emit({ type: "session_shutdown", reason: "quit" }), sleep(5000)]);
	session.dispose();
	const cache = path.join(agentDir, "mcp-cache.json");
	return {
		afterCreate, afterSettle,
		complete: { afterCreate: afterCreate.length === 10, afterSettle: afterSettle.length === 10 },
		cacheServers: fs.existsSync(cache) ? Object.keys(JSON.parse(fs.readFileSync(cache, "utf8")).servers ?? {}).sort() : [],
		envEqualToInitial: envSnapshot() === before,
		errors,
	};
}

// ---- Bound probe over the real parent session ----
const BOUND = "subagents:bound:v2:";
const bus = pi.createEventBus();
const seen = [];
for (const name of ["ready", "started", "update", "terminal"]) bus.on(`${BOUND}${name}`, (data) => seen.push({ event: name, data }));
const of = (name) => seen.filter((entry) => entry.event === name).map((entry) => entry.data);

async function request(method, params, waitMs) {
	const requestId = randomUUID();
	const replies = [];
	const off = bus.on(`${BOUND}reply:${requestId}`, (data) => replies.push(data));
	bus.emit(`${BOUND}request`, { version: 2, requestId, method, ...(params !== undefined ? { params } : {}) });
	if (method === "ping") await sleep(waitMs ?? 300);
	else {
		try { await until(() => replies.length > 0, `${method} reply`, waitMs ?? 60000); }
		catch { /* silence is a result */ }
		await sleep(100);
	}
	off();
	return replies;
}

let sequence = 0;
function leafRequest(serverInstanceId, overrides = {}) {
	sequence += 1;
	return {
		version: 2, targetServerInstanceId: serverInstanceId, requestId: `a1r5-request-${sequence}`, ownerRunId: "a1r5-owner", nodeId: `a1r5-node-${sequence}`,
		prospectiveRunId: randomUUID(), agent: "probe-plain", task: "Answer with one word.", cwd: Y, context: "fresh",
		model: "faux/faux-1", thinking: "off", artifacts: false, result: { kind: "text" }, ...overrides,
	};
}
const bindingOf = (data) => ({
	version: 2, targetServerInstanceId: data.serverInstanceId, prospectiveRunId: data.launchContract.prospectiveRunId,
	expectedSourceIdentityDigest: data.sourceIdentityDigest, expectedActiveSessionDigest: data.activeSessionDigest,
	requestDigest: data.requestDigest, expectedLaunchContractDigest: data.launchContractDigest,
	receipt: data.receipt, cancellationToken: data.cancellationToken,
});
const tupleOf = (req) => ({ requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId });
const terminalsOf = (tuple) => of("terminal").filter((entry) => entry.requestId === tuple.requestId && entry.nodeId === tuple.nodeId);

async function preflight(serverInstanceId, overrides) {
	const req = leafRequest(serverInstanceId, overrides);
	const started = Date.now();
	const replies = await request("preflight", req);
	return { req, replies, ms: Date.now() - started };
}
function launch(req, data) {
	const binding = bindingOf(data);
	bus.emit(`${BOUND}launch`, { version: 2, ...tupleOf(req), request: req, binding });
	return { tuple: tupleOf(req), binding, digest: data.launchContractDigest };
}
function cancel(tuple, binding, target) {
	bus.emit(`${BOUND}cancel`, { version: 2, ...tuple, targetServerInstanceId: target ?? binding.targetServerInstanceId, binding });
}
function summarizeTerminal(terminal) {
	if (!terminal) return null;
	const { requestId, ownerRunId, nodeId, ...rest } = terminal;
	const projection = rest.toolRegistry?.projection ?? rest.toolRegistry;
	return {
		status: rest.status, toolRegistryError: rest.toolRegistryError, toolsMissing: rest.toolsMissing, toolsExtra: rest.toolsExtra,
		launchContractDigest: rest.launchContractDigest, deniedToolCalls: rest.deniedToolCalls, result: rest.result,
		error: typeof rest.error === "string" ? rest.error.slice(0, 300) : rest.error,
		registryNames: Array.isArray(projection?.names) ? projection.names : undefined,
		keys: Object.keys(rest).sort(),
	};
}

/** Preflight, launch, wait for the single terminal; count the provider requests of this leaf. */
async function runLeaf(serverInstanceId, overrides = {}, { beforeLaunch } = {}) {
	const pf = await preflight(serverInstanceId, overrides);
	const reply = pf.replies[0];
	if (!reply?.success) return { preflight: { replies: pf.replies.length, error: reply?.error ?? null, ms: pf.ms } };
	await beforeLaunch?.();
	const providerBefore = faux.requests.length;
	const leaf = launch(pf.req, reply.data);
	await until(() => terminalsOf(leaf.tuple).length > 0, `terminal of ${pf.req.agent}`, 90000);
	await sleep(200);
	const requests = faux.requests.slice(providerBefore);
	return {
		preflight: { replies: pf.replies.length, ms: pf.ms, contract: { tools: reply.data.launchContract.tools, mcpDirectTools: reply.data.launchContract.mcpDirectTools, canonicalCwd: reply.data.launchContract.canonicalCwd } },
		started: of("started").filter((entry) => entry.requestId === leaf.tuple.requestId).length,
		terminals: terminalsOf(leaf.tuple).map(summarizeTerminal),
		digestMatches: terminalsOf(leaf.tuple)[0]?.launchContractDigest === leaf.digest,
		providerRequests: requests.length,
		providerTools: requests.map((entry) => entry.tools.slice().sort()),
		toolTexts: requests.flatMap((entry) => entry.toolTexts),
	};
}

async function startParent() {
	const settingsManager = pi.SettingsManager.create(Y, agentDir);
	const loader = new pi.DefaultResourceLoader({ cwd: Y, agentDir, settingsManager, eventBus: bus });
	await loader.reload();
	const loaded = loader.getExtensions();
	const modelRuntime = await pi.ModelRuntime.create();
	const { model, error } = pi.resolveCliModel({ cliModel: "faux/faux-1", modelRuntime });
	if (error) throw new Error(error);
	const sessionManager = pi.SessionManager.create(Y, path.join(BASE, `sessions-${mode}`));
	const { session } = await pi.createAgentSession({ cwd: Y, agentDir, modelRuntime, model, resourceLoader: loader, sessionManager, settingsManager, sessionStartEvent: { type: "session_start", reason: "startup" } });
	const errors = [];
	await session.bindExtensions({ mode: "print", onError: (entry) => errors.push({ event: entry.event, path: entry.extensionPath, error: String(entry.error?.stack ?? entry.error) }) });
	return {
		session, loader, errors,
		extensionPaths: loaded.extensions.map((entry) => entry.path ?? entry.resolvedPath),
		loadErrors: loaded.errors.map((entry) => ({ path: entry.path, error: String(entry.error) })),
	};
}

async function awaitCapability() {
	let last;
	const started = Date.now();
	while (Date.now() - started < 15000) {
		const replies = await request("ping", undefined, 200);
		last = replies;
		if (replies[0]?.data?.capabilities?.boundForegroundLeaf) break;
	}
	return last;
}
const pingSummary = (replies) => ({
	responders: replies.length,
	serverInstanceIds: replies.map((reply) => reply.data?.serverInstanceId),
	sourceIdentity: replies[0]?.data?.sourceIdentity ?? null,
	sourceIdentityUnavailable: replies[0]?.data?.sourceIdentityUnavailable ?? null,
	capabilities: replies[0]?.data?.capabilities ?? null,
	session: replies[0]?.data?.session ?? null,
});

async function mainProbe() {
	const out = {};
	const parent = await startParent();
	out.parent = {
		processCwd: process.cwd(), sessionCwd: Y, hasUI: parent.session.extensionRunner?.hasUI?.() ?? null,
		extensionPaths: parent.extensionPaths, loadErrors: parent.loadErrors, bindErrors: parent.errors,
		piSubagentsCopies: parent.extensionPaths.filter((entry) => /pi-subagents/u.test(entry)).length,
	};
	const ping = await awaitCapability();
	out.ping = pingSummary(ping);
	const sid = ping[0]?.data?.serverInstanceId;
	out.readyEvents = of("ready").length;
	if (!sid || !ping[0]?.data?.capabilities?.boundForegroundLeaf) { out.stop = "no bound capability"; return out; }
	out.generationSlot = globalThis.__piSubagentBoundControlPlaneV2?.serverInstanceId === sid;
	const envBefore = envSnapshot();

	if (mode === "foreign-config") {
		out.mcpForeign = await runLeaf(sid, { agent: "probe-1c", task: 'CALLS:[{"name":"bsl-ws_search","args":{"q":"x"}}]' });
		out.envEqualToInitial = envSnapshot() === envBefore;
		return out;
	}

	if (mode === "mismatch") {
		out.mcpMismatch = await runLeaf(sid, { agent: "probe-1c", task: 'CALLS:[{"name":"bsl-ws_search","args":{"q":"x"}}]' });
		out.plainMismatch = await runLeaf(sid, {});
		out.envEqualToInitial = envSnapshot() === envBefore;
		return out;
	}

	out.plain = await runLeaf(sid, {});
	out.structured = await runLeaf(sid, { result: { kind: "structured", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } });
	out.mcp = await runLeaf(sid, { agent: "probe-1c", task: 'CALLS:[{"name":"bsl-ws_search","args":{"q":"x"}},{"name":"bsl-ref_its_help","args":{"q":"y"}}]' });
	out.mcpToolResults = faux.requests.filter((entry) => entry.lastRole === "tool").length;

	// Exact cancellation: foreign target, forged MAC, crossed binding, then the exact token twice.
	{
		const a = await preflight(sid, { task: "HOLD:cancel-a" });
		const b = await preflight(sid, { task: "HOLD:cancel-b" });
		const leafA = launch(a.req, a.replies[0].data);
		const leafB = launch(b.req, b.replies[0].data);
		await until(() => faux.isHeld("cancel-a") && faux.isHeld("cancel-b"), "two held leaves");
		const forged = structuredClone(leafA.binding);
		forged.cancellationToken.mac = forged.cancellationToken.mac.replace(/.$/u, (last) => (last === "0" ? "1" : "0"));
		cancel(leafA.tuple, leafA.binding, randomUUID());
		cancel(leafA.tuple, forged);
		cancel(leafB.tuple, leafA.binding);
		bus.emit(`${BOUND}cancel`, { ...leafA.tuple });
		await sleep(300);
		const afterWrong = { terminals: terminalsOf(leafA.tuple).length + terminalsOf(leafB.tuple).length, heldA: faux.isHeld("cancel-a"), heldB: faux.isHeld("cancel-b") };
		const cancelStarted = Date.now();
		cancel(leafA.tuple, leafA.binding);
		cancel(leafA.tuple, leafA.binding);
		await until(() => terminalsOf(leafA.tuple).length > 0, "cancel terminal", 15000);
		const cancelMs = Date.now() - cancelStarted;
		await sleep(500);
		const updatesAfterCancel = of("update").filter((entry) => entry.requestId === leafA.tuple.requestId).length;
		await sleep(500);
		faux.release("cancel-b");
		await until(() => terminalsOf(leafB.tuple).length > 0, "neighbour terminal", 30000);
		out.cancel = {
			afterWrongTokens: afterWrong,
			cancelled: terminalsOf(leafA.tuple).map(summarizeTerminal), cancelMs,
			providerAborted: faux.aborted.includes("cancel-a"),
			updatesStableAfterCancel: of("update").filter((entry) => entry.requestId === leafA.tuple.requestId).length === updatesAfterCancel,
			neighbour: terminalsOf(leafB.tuple).map(summarizeTerminal),
		};
	}

	// Closed canaries: each is counted against the provider.
	const drift = path.join(OWNER, "agents", "ext", "drift.ts");
	const driftBytes = fs.readFileSync(drift);
	out.canaries = {
		narrow: await runLeaf(sid, { agent: "probe-narrow" }),
		shadow: await runLeaf(sid, { agent: "probe-shadow" }),
		drift: await runLeaf(sid, { agent: "probe-drift" }, { beforeLaunch: () => fs.appendFileSync(drift, "\n// drift\n") }),
	};
	fs.writeFileSync(drift, driftBytes);
	out.canaries.positiveControl = await runLeaf(sid, {});

	// Private bound runs on the public RPC surface: Fleet does not count a live bound leaf.
	{
		const held = await preflight(sid, { task: "HOLD:privacy" });
		const leaf = launch(held.req, held.replies[0].data);
		await until(() => faux.isHeld("privacy"), "held privacy leaf");
		const statusId = randomUUID();
		const statusReplies = [];
		const off = bus.on(`subagents:rpc:v1:reply:${statusId}`, (data) => statusReplies.push(data));
		bus.emit("subagents:rpc:v1:request", { version: 1, requestId: statusId, method: "status" });
		await sleep(500);
		off();
		const text = JSON.stringify(statusReplies);
		faux.release("privacy");
		await until(() => terminalsOf(leaf.tuple).length > 0, "privacy terminal");
		out.privacy = { rpcStatusReplies: statusReplies.length, fleet: statusReplies[0]?.data?.fleet ?? null, mentionsRunId: text.includes(held.req.prospectiveRunId), mentionsAgent: text.includes("probe-plain"), terminal: summarizeTerminal(terminalsOf(leaf.tuple)[0]) };
	}

	// Reload: the old generation's live attempt ends once; the old id is silent; exactly one responder remains.
	{
		const held = await preflight(sid, { task: "HOLD:reload" });
		const leaf = launch(held.req, held.replies[0].data);
		await until(() => faux.isHeld("reload"), "held reload leaf");
		const reloadStarted = Date.now();
		await parent.session.reload();
		const reloadMs = Date.now() - reloadStarted;
		await until(() => terminalsOf(leaf.tuple).length > 0, "reload terminal", 15000);
		const ping2 = await awaitCapability();
		const sid2 = ping2[0]?.data?.serverInstanceId;
		const stale = await request("preflight", leafRequest(sid), 1500);
		const fresh = sid2 ? await runLeaf(sid2, {}) : null;
		await sleep(300);
		out.reload = {
			reloadMs, oldTerminals: terminalsOf(leaf.tuple).map(summarizeTerminal), ping: pingSummary(ping2),
			newGeneration: Boolean(sid2) && sid2 !== sid, staleTargetReplies: stale.length, fresh,
			generationSlot: globalThis.__piSubagentBoundControlPlaneV2?.serverInstanceId === sid2,
		};
	}
	out.envEqualToInitial = envSnapshot() === envBefore;
	out.finalPing = pingSummary(await request("ping"));
	return out;
}

const started = Date.now();
let result;
try {
	result = mode.startsWith("adapter") ? await adapterMeasurement() : await mainProbe();
} catch (error) {
	result = { fatal: String(error?.stack ?? error) };
}
faux.server.close();
console.log(JSON.stringify({ mode, processCwd, sessionCwd: Y, argvHasMcpConfig: process.argv.includes("--mcp-config"), node: process.version, pi: pi.VERSION, ms: Date.now() - started, providerRequestsTotal: faux.requests.length, result }, null, 2));
process.exit(0);
