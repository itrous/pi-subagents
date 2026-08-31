#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installExactCommit } from "../../install-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const piBinary = process.env.PI_SUBAGENT_PI_BINARY || "pi";
function findExecutable(command) { if (path.isAbsolute(command) || command.includes(path.sep)) return command; for (const directory of (process.env.PATH || "").split(path.delimiter)) { const candidate = path.join(directory, command); try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {} } return ""; }
const resolvedPiBinary = fs.realpathSync.native(findExecutable(piBinary)); let inferredRuntimeRoot = path.dirname(resolvedPiBinary);
while (path.dirname(inferredRuntimeRoot) !== inferredRuntimeRoot) { const manifest = path.join(inferredRuntimeRoot, "package.json"); try { if (fs.existsSync(path.join(inferredRuntimeRoot, "dist", "index.js")) && JSON.parse(fs.readFileSync(manifest, "utf8")).name === "@earendil-works/pi-coding-agent") break; } catch {} inferredRuntimeRoot = path.dirname(inferredRuntimeRoot); }
const runtimeRoot = process.env.A1_PROBE_PI_RUNTIME_ROOT || inferredRuntimeRoot;
assert.ok(fs.existsSync(path.join(inferredRuntimeRoot, "dist", "index.js")), "Pi binary must resolve inside its runtime package"); assert.equal(fs.realpathSync.native(runtimeRoot), fs.realpathSync.native(inferredRuntimeRoot), "SDK runtime root differs from launched Pi runtime");
const coding = await import(pathToFileURL(path.join(runtimeRoot, "dist", "index.js")).href);
const runtimeTools = await import(pathToFileURL(path.join(runtimeRoot, "dist", "core", "tools", "index.js")).href);
const piAiRoot = path.join(runtimeRoot, "node_modules", "@earendil-works", "pi-ai");
const faux = await import(pathToFileURL(path.join(piAiRoot, "dist", "providers", "faux.js")).href);
const { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = coding;
const { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } = faux;

function git(args, cwd) {
	const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))), GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env });
	if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}
function text(content) { return Array.isArray(content) ? content.map((part) => part?.type === "text" ? part.text : "").join("") : ""; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

const commit = process.env.A1_PROBE_EXPECTED_COMMIT;
assert.match(commit || "", /^[0-9a-f]{40}$/, "A1_PROBE_EXPECTED_COMMIT must be an explicit exact SHA");
const mode = process.env.A1_PROBE_SOURCE_MODE || "local";
assert.ok(mode === "local" || mode === "github");
const canonicalRepository = "https://github.com/itrous/pi-subagents.git";
const repositoryUrl = mode === "github" ? canonicalRepository : repoRoot;
const probeBase = path.resolve(process.env.A1_PROBE_ROOT || path.join(os.homedir(), ".cache")); fs.mkdirSync(probeBase, { recursive: true });
const root = fs.mkdtempSync(path.join(probeBase, "pi-subagents-a1-real-probe-")), keepRoot = process.env.A1_PROBE_KEEP === "1";
const cleanupRoot = () => { if (!keepRoot) fs.rmSync(root, { recursive: true, force: true }); }; process.once("exit", cleanupRoot);
const agentDir = path.join(root, "agent"), installerState = path.join(root, "installer-state"), extensionDir = path.join(agentDir, "extensions", "subagent"), project = path.join(root, "project"), sessions = path.join(root, "sessions");
fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(sessions, { recursive: true });
const priorEnv = new Map([["HOME", process.env.HOME], ["PI_CODING_AGENT_DIR", process.env.PI_CODING_AGENT_DIR], ["PI_SUBAGENT_PI_BINARY", process.env.PI_SUBAGENT_PI_BINARY], ["A1_PROBE_EXPECTED_COMMIT", process.env.A1_PROBE_EXPECTED_COMMIT]]);
const npmCache = path.resolve(process.env.A1_PROBE_NPM_CACHE || path.join(os.homedir(), ".npm"));
process.env.HOME = root; process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_SUBAGENT_PI_BINARY = resolvedPiBinary; process.env.A1_PROBE_EXPECTED_COMMIT = commit;

const versionProbe = spawnSync(resolvedPiBinary, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 }); assert.equal(versionProbe.status, 0, versionProbe.stderr); const piVersion = versionProbe.stdout.trim();
assert.ok(piVersion && Buffer.byteLength(piVersion, "utf8") <= 128 && !/[\0\r\n]/.test(piVersion), "active-runtime identity is unavailable"); assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeRoot, "package.json"), "utf8")).version, piVersion, "Pi binary and SDK package versions differ");
const runtimeBuiltinNames = [...runtimeTools.allToolNames].sort(); assert.ok(runtimeBuiltinNames.length > 0, "active runtime exposes no builtin capability set");
installExactCommit({ extensionDir, stateDir: installerState, repositoryUrl, commit, expectedRepository: mode === "github" ? undefined : (value) => path.resolve(value) === repoRoot, npmCommand: ["npm", "--cache", npmCache], quiet: true });
if (mode === "local") git(["remote", "set-url", "origin", canonicalRepository], extensionDir);
assert.equal(git(["rev-parse", "HEAD"], extensionDir), commit); assert.equal(git(["status", "--porcelain=v1", "--untracked-files=all"], extensionDir), "");

fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
fs.writeFileSync(path.join(project, ".pi", "agents", "real-echo.md"), `---\nname: real-echo\ndescription: Real installed A1 probe leaf\ntools: read\ncompletionGuard: false\n---\nReturn a concise marker.\n`);
function childPids() { const parentByPid = new Map(); for (const name of fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) { const pid = Number(name); try { const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/); parentByPid.set(pid, Number(fields[1])); } catch {} } const descendants = new Set([process.pid]); let changed = true; while (changed) { changed = false; for (const [pid, ppid] of parentByPid) if (descendants.has(ppid) && !descendants.has(pid)) { descendants.add(pid); changed = true; } } descendants.delete(process.pid); return [...descendants].sort((a, b) => a - b); }
function socketOwnerPid(socket) {
	const localPort = Number(socket.remotePort).toString(16).toUpperCase().padStart(4, "0"), remotePort = Number(socket.localPort).toString(16).toUpperCase().padStart(4, "0"); let inode;
	for (const line of fs.readFileSync("/proc/net/tcp", "utf8").trim().split("\n").slice(1)) { const fields = line.trim().split(/\s+/); if (fields[1]?.endsWith(`:${localPort}`) && fields[2]?.endsWith(`:${remotePort}`)) { inode = fields[9]; break; } }
	if (!inode) return undefined;
	for (const pid of childPids()) { try { for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) { try { if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`) return pid; } catch {} } } catch {} }
	return undefined;
}
const requests = new Map(), allRequests = [], waiters = new Map(); let parsedRequests = 0;
function beginSse(record) { record.released = true; if (!record.response.headersSent) record.response.writeHead(200, { "content-type": "text/event-stream" }); }
function finishText(record, index, text = `REAL_CHILD_${index}`) { beginSse(record); record.response.write(`data: ${JSON.stringify({ id: `leaf-${index}`, object: "chat.completion.chunk", created: 1, model: "child", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`); record.response.write(`data: ${JSON.stringify({ id: `leaf-${index}`, object: "chat.completion.chunk", created: 1, model: "child", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`); record.response.end("data: [DONE]\n\n"); }
function finishDeniedToolCall(record) { beginSse(record); record.response.write(`data: ${JSON.stringify({ id: "denial-tool", object: "chat.completion.chunk", created: 1, model: "child", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "denied-read-call", type: "function", function: { name: "read", arguments: '{"path":"forbidden"}' } }] }, finish_reason: null }] })}\n\n`); record.response.write(`data: ${JSON.stringify({ id: "denial-tool", object: "chat.completion.chunk", created: 1, model: "child", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`); record.response.end("data: [DONE]\n\n"); }
const providerServer = createServer((request, response) => {
	const record = { index: -1, attempt: -1, request, response, receivedAt: Date.now(), released: false, closedAt: undefined, wireNames: [], pid: undefined }; allRequests.push(record);
	let body = ""; request.setEncoding("utf8"); request.on("data", (chunk) => { body += chunk; });
	request.on("end", () => {
		const match = /(?:REAL|RELOAD|DENIAL)_LEAF_([0-5])/.exec(body); const index = match ? Number(match[1]) : -1; let wireNames = [];
		try { const payload = JSON.parse(body); wireNames = (payload.tools ?? []).map((tool) => tool?.function?.name); } catch {}
		record.index = index; record.wireNames = wireNames; record.pid = socketOwnerPid(request.socket); parsedRequests++;
		const records = requests.get(index) ?? []; record.attempt = records.length;
		if (!match || !record.pid || (index !== 5 && records.length > 0) || (index === 5 && records.length > 1)) { response.writeHead(500); response.end("unexpected, duplicate, or ownerless provider request"); return; }
		records.push(record); requests.set(index, records); response.on("close", () => { if (!record.released) { record.closedAt = Date.now(); for (const resolve of waiters.get(index) ?? []) resolve(); waiters.delete(index); } });
		if (index === 5 && record.attempt === 0) finishDeniedToolCall(record); else if (index === 5) finishText(record, index, "DENIAL_COMPLETE");
	});
});
providerServer.on("connection", (socket) => socket.unref());
await new Promise((resolve) => providerServer.listen(0, "127.0.0.1", resolve)); providerServer.unref();
const address = providerServer.address(); assert.ok(address && typeof address === "object");
const release = (index) => { const record = requests.get(index)?.[0]; assert.ok(record, `provider request ${index} missing`); finishText(record, index); };
function childSessionEntries() { const entries = []; const walk = (directory) => { if (!fs.existsSync(directory)) return; for (const name of fs.readdirSync(directory).sort()) { const target = path.join(directory, name), relative = path.relative(sessions, target); entries.push(relative); if (fs.lstatSync(target).isDirectory()) walk(target); } }; walk(sessions); return entries; }
function tcpUnackedBytes(socket) { let inode; try { const link = fs.readlinkSync(`/proc/self/fd/${socket._handle.fd}`), match = /^socket:\[(\d+)\]$/.exec(link); inode = match?.[1]; } catch {} if (!inode) return undefined; const localPort = Number(socket.localPort).toString(16).toUpperCase().padStart(4, "0"), remotePort = Number(socket.remotePort).toString(16).toUpperCase().padStart(4, "0"); for (const line of fs.readFileSync("/proc/net/tcp", "utf8").trim().split("\n").slice(1)) { const fields = line.trim().split(/\s+/); if (fields[9] === inode && fields[1]?.endsWith(`:${localPort}`) && fields[2]?.endsWith(`:${remotePort}`)) return parseInt(fields[4]?.split(":")[0] || "0", 16); } return undefined; }
const control = { requestCount: () => allRequests.length, readyCount: () => parsedRequests, childSessionEntries, childPids, pidExists: (pid) => fs.existsSync(`/proc/${pid}`), pausePid: (pid) => process.kill(pid, "SIGSTOP"), resumePid: (pid) => process.kill(pid, "SIGCONT"), pid: (index) => requests.get(index)?.[0]?.pid, wireNames: (index, attempt = 0) => requests.get(index)?.[attempt]?.wireNames ?? [], release, closedAt: (index) => requests.get(index)?.[0]?.closedAt ?? 0, providerEvent: async (index, marker) => { const record = requests.get(index)?.[0]; if (!record || record.response.destroyed) return { destroyedBefore: true, accepted: false, flushed: false }; if (!record.response.headersSent) record.response.writeHead(200, { "content-type": "text/event-stream" }); const destroyedBefore = record.response.destroyed; return await new Promise((resolve) => { let settled = false; const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); }; const timer = setTimeout(() => finish({ destroyedBefore, accepted: false, flushed: false }), 5_000); const accepted = record.response.write(`data: ${JSON.stringify({ id: `event-${marker}`, object: "chat.completion.chunk", created: 1, model: "child", choices: [{ index: 0, delta: { content: marker }, finish_reason: null }] })}\n\n`, (error) => { if (error) { finish({ destroyedBefore, accepted, flushed: false, acknowledged: false }); return; } const deadline = Date.now() + 1_000; const poll = () => { const unacked = tcpUnackedBytes(record.request.socket); if (unacked === 0) finish({ destroyedBefore, accepted, flushed: true, acknowledged: true, acknowledgedAt: Date.now() }); else if (Date.now() >= deadline || unacked === undefined) finish({ destroyedBefore, accepted, flushed: true, acknowledged: false }); else setTimeout(poll, 1); }; poll(); }); }); },
 waitClosed: async (index) => { if (requests.get(index)?.[0]?.closedAt) return; await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`provider ${index} did not close`)), 30_000); const list = waiters.get(index) ?? []; list.push(() => { clearTimeout(timer); resolve(); }); waiters.set(index, list); }); } };
globalThis[Symbol.for("pi-subagents.a1-real-probe-control.v1")] = control;

fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { probe: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "probe-key", models: [{ id: "child", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 512 }] } } }));
async function runRegistryStopGate() {
	const runtimeExtensionPaths = ["bound-tool-registry-bootstrap.ts", "subagent-prompt-runtime.ts", "bound-package-mediator.ts", "bound-tool-registry-gate.ts"].map((name) => path.join(extensionDir, "src", "runs", "shared", name));
	const evidenceModule = await import(pathToFileURL(path.join(extensionDir, "src", "runs", "shared", "bound-runtime-evidence.ts")).href);
	const registryModule = await import(pathToFileURL(path.join(extensionDir, "src", "runs", "shared", "tool-registry-proof.ts")).href);
	const runtimeBuiltins = registryModule.runtimeBuiltinProjection(runtimeBuiltinNames.map((name) => ({ name, sourceInfo: { source: "builtin" } })));
	assert.ok(runtimeBuiltins, "runtime builtin projection unavailable");
	const proofNonce = "9".repeat(64), beforeRequests = allRequests.length;
	const policy = { version: 1, modelApi: "openai-completions", piRuntimeVersion: piVersion, proofNonce, denialFd: 4, required: ["powershell"], internalTools: [], runtimeExtensions: evidenceModule.attestBoundRuntimeExtensions(runtimeExtensionPaths), runtimeBuiltins, packageExtensions: [] };
	const proofPath = path.join(root, "negative-registry-proof.json"), denialPath = path.join(root, "negative-denial-proof.json"), proofFd = fs.openSync(proofPath, "w"), denialFd = fs.openSync(denialPath, "w");
	let stdout = "", stdoutOverflow = false, stderr = "", stderrOverflow = false, outcome;
	try {
		outcome = await new Promise((resolve, reject) => { const child = spawn(resolvedPiBinary, ["--no-extensions", "--no-context-files", "--no-skills", "--no-themes", "--no-session", "--model", "probe/child", "--tools", "read", "--extension", runtimeExtensionPaths[0], "--extension", runtimeExtensionPaths[1], "--extension", runtimeExtensionPaths[2], "--extension", runtimeExtensionPaths[3], "--mode", "json", "REAL_NEGATIVE_REGISTRY"], { cwd: project, env: { ...process.env, PI_OFFLINE: "1", PI_SUBAGENT_TOOL_REGISTRY_ACTIVE: "1", PI_SUBAGENT_TOOL_REGISTRY_POLICY: JSON.stringify(policy), PI_SUBAGENT_TOOL_REGISTRY_FD: "3", PI_SUBAGENT_TOOL_REGISTRY_CWD: fs.realpathSync(project) }, stdio: ["ignore", "pipe", "pipe", proofFd, denialFd] }); child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > 64 * 1024) { stdoutOverflow = true; child.kill("SIGKILL"); return; } stdout += chunk; }); child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { if (Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > 64 * 1024) { stderrOverflow = true; child.kill("SIGKILL"); return; } stderr += chunk; }); child.once("error", reject); const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} reject(new Error("negative registry child timed out")); }, 30_000); child.once("close", (code, signal) => { clearTimeout(timer); if (stdoutOverflow || stderrOverflow) reject(new Error("negative registry output exceeded 64 KiB")); else resolve({ code, signal }); }); });
	} finally { fs.closeSync(proofFd); fs.closeSync(denialFd); }
	const providerRequests = allRequests.length - beforeRequests, turns = stdout.split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return undefined; } }).filter((event) => event?.type === "turn_end").length; assert.deepEqual(outcome, { code: 78, signal: null }, stderr); assert.equal(providerRequests, 0, "registry mismatch reached provider turn"); assert.equal(turns, 0, `registry mismatch completed a Pi turn: ${stdout}`);
	const proofBytes = fs.readFileSync(proofPath, "utf8"); assert.ok(Buffer.byteLength(proofBytes) > 0 && Buffer.byteLength(proofBytes) <= 64 * 1024, `negative registry proof is empty or oversized: ${JSON.stringify({ outcome, stderr, stdout })}`); const frame = JSON.parse(proofBytes); assert.equal(frame.kind, "protocol"); assert.equal(frame.code, "active_registry_drift");
	return { status: outcome.code, signal: outcome.signal, providerRequests, turns, capabilityError: frame.code };
}

const eventBus = createEventBus();
const probeExtension = path.join(repoRoot, "test", "fixtures", "active-runtime-parent-probe.ts");
const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
modelRuntime.registerProvider("probe", { name: "Probe", baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "probe-key", models: [{ id: "child", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 512 }] });

async function createParent(name, phase, oldServerInstanceId) {
	const provider = fauxProvider({ provider: `faux-${name}`, models: [{ id: "parent", contextWindow: 200_000 }] });
	modelRuntime.registerProvider(provider.provider.id, { name: provider.provider.name, api: provider.api, apiKey: "faux", streamSimple: provider.provider.streamSimple, models: [...provider.models] });
	const model = modelRuntime.getModel(provider.provider.id, "parent"); assert.ok(model);
	const setPhase = (nextPhase, previousServerInstanceId) => provider.setResponses([
		() => fauxAssistantMessage([fauxToolCall("active_runtime_probe", { phase: nextPhase, ...(previousServerInstanceId ? { oldServerInstanceId: previousServerInstanceId } : {}) }, { id: `probe-${name}-${nextPhase}` })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage([fauxText(`PARENT_${nextPhase.toUpperCase()}_OK`)], { stopReason: "stop" }),
	]); setPhase(phase, oldServerInstanceId);
	const settingsManager = SettingsManager.inMemory({ defaultProjectTrust: "always", compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd: project, agentDir, eventBus, settingsManager, additionalExtensionPaths: [probeExtension], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Call the active_runtime_probe tool exactly once." });
	await loader.reload();
	const loadedExtensions = loader.getExtensions(); const extensionList = Array.isArray(loadedExtensions) ? loadedExtensions : loadedExtensions.extensions;
	const installedPaths = extensionList.filter((entry) => path.resolve(entry.path).startsWith(`${path.resolve(extensionDir)}${path.sep}`));
	assert.equal(installedPaths.length, 1, `expected one installed pi-subagents extension, got ${installedPaths.map((entry) => entry.path).join(",")}`);
	const created = await createAgentSession({ cwd: project, agentDir, model, modelRuntime, resourceLoader: loader, sessionManager: SessionManager.create(project, sessions), settingsManager });
	await created.session.bindExtensions({ shutdownHandler: () => {} });
	return { session: created.session, loader, setPhase };
}

async function runParent(parent, prompt) {
	let timer; try { await Promise.race([parent.session.prompt(prompt, { expandPromptTemplates: false }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("parent probe timed out")), 90_000); })]); } finally { if (timer) clearTimeout(timer); }
	const result = [...parent.session.messages].reverse().find((message) => message.role === "toolResult" && message.toolName === "active_runtime_probe");
	assert.ok(result, "probe ToolDefinition.execute result missing"); assert.equal(result.isError, false, text(result.content)); return result.details;
}

async function bounded(promise, label, timeoutMs = 30_000) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); })]); } finally { if (timer) clearTimeout(timer); } }

let parentA;
try {
	parentA = await createParent("a", "lifecycle");
	const lifecycle = await runParent(parentA, "Run lifecycle probe.");
	assert.equal(lifecycle.phase, "lifecycle"); assert.equal(lifecycle.responderCount, 1); assert.equal(lifecycle.started, 4); assert.equal(lifecycle.terminals.length, 4); assert.equal(lifecycle.providerRequests, 4); assert.equal(lifecycle.denialProviderRequests, 2); assert.equal(lifecycle.fleetActive, 4); assert.equal(lifecycle.fleetFinal, 0);
	const registryStopGate = await runRegistryStopGate(); assert.equal(registryStopGate.providerRequests, 0); assert.equal(registryStopGate.turns, 0);
	await bounded(parentA.session.reload(), "real parent reload"); parentA.setPhase("replacement", lifecycle.serverInstanceId);
	const replacement = await runParent(parentA, "Run replacement probe.");
	assert.equal(replacement.phase, "replacement"); assert.equal(replacement.responderCount, 1); assert.equal(replacement.boundPreflight, true); assert.equal(replacement.boundSpawn, true); assert.notEqual(replacement.serverInstanceId, lifecycle.serverInstanceId);
	console.log(JSON.stringify({ ok: true, mode, commit, piVersion, toolDefinitionExecute: true, oneInstalledExtensionPath: true, headless: true, lifecycle, registryStopGate, replacement }, null, 2));
} finally {
	for (const parent of [parentA]) { if (!parent) continue; try { await parent.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } catch {} try { parent.session.dispose(); } catch {} }
	providerServer.close(); providerServer.closeAllConnections(); delete globalThis[Symbol.for("pi-subagents.a1-real-probe-control.v1")];
	for (const [key, value] of priorEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	cleanupRoot(); process.off("exit", cleanupRoot);
}
