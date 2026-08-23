#!/usr/bin/env node
/**
 * Воспроизведение issue #4 внутри форка: делегированный bound-спавн
 * package-агента с subagentOnlyExtensions: package:<dep>.
 *
 * Два листа из owner-пакета:
 * - rel-leaf: относительный ref ./ext/ref.ts (контрольный - проходит);
 * - dep-leaf: package:a1dep - dependency, materialized как РЕАЛЬНЫЙ каталог
 *   node_modules/a1dep (резолвер отвергает симлинки).
 *
 * Ожидание после фикса: оба терминала completed. Сейчас dep-leaf падает
 * native_tool_registry_protocol_error / package_load_error.
 *
 * Запуск из корня форка: node test/probes/active-runtime-package-projection.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const piBinary = fs.realpathSync.native(findExecutable("pi"));
const commit = process.env.A1_PROBE_EXPECTED_COMMIT || execGit(repoRoot, ["rev-parse", "HEAD"]);

function findExecutable(command) {
	if (path.isAbsolute(command) || command.includes(path.sep)) return command;
	for (const directory of (process.env.PATH || "").split(path.delimiter)) {
		const candidate = path.join(directory, command);
		try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
	}
	throw new Error(`not found in PATH: ${command}`);
}
function execGit(cwd, args) {
	const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" } });
	if (r.status !== 0) throw new Error(`git ${args}: ${r.stderr}`);
	return r.stdout.trim();
}

const root = fs.mkdtempSync(path.join(os.homedir(), ".cache", "a1-pkg-projection-"));
const cleanup = () => { if (process.env.A2_PROBE_KEEP !== "1") fs.rmSync(root, { recursive: true, force: true }); };
process.once("exit", cleanup);

const agentDir = path.join(root, "agent"), project = path.join(root, "project"), sessions = path.join(root, "sessions");
fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(sessions, { recursive: true });
const realHome = os.homedir();
const priorEnv = [["HOME", process.env.HOME], ["PI_CODING_AGENT_DIR", process.env.PI_CODING_AGENT_DIR]];
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = agentDir;

// --- 1. Установка форка в точный коммит текущей ветки ---
const { installExactCommit } = await import(pathToFileURL(path.join(repoRoot, "install-lib.mjs")).href);
const extensionDir = path.join(agentDir, "extensions", "subagent");
installExactCommit({ commit, extensionDir, stateDir: path.join(root, "installer-state"), repositoryUrl: repoRoot, expectedRepository: (v) => path.resolve(v) === repoRoot, npmCommand: ["npm", "--cache", path.join(realHome, ".npm")], quiet: true });
assert.equal(execGit(extensionDir, ["rev-parse", "HEAD"]), commit, "installed HEAD mismatch");
execGit(extensionDir, ["remote", "set-url", "origin", "https://github.com/itrous/pi-subagents.git"]);
	if (process.env.A2_PROBE_DEBUG) {
		// Лог каждого отказа резолвера с местом в коде (только для отладки).
		const resolverPath = path.join(extensionDir, "src", "api", "active-bound-resolver.ts");
		let resolver = fs.readFileSync(resolverPath, "utf8");
		resolver = resolver.replace(
			'function failure(code: ActiveBoundResolutionErrorCode): ResolveActiveBoundLaunchContractResult {\n\treturn { ok: false, code } as ResolveActiveBoundLaunchContractResult;\n}',
			'function failure(code: ActiveBoundResolutionErrorCode): ResolveActiveBoundLaunchContractResult {\n\tconst __e = new Error();\n\tError.captureStackTrace(__e, failure);\n\tconsole.error("A2RESOLVE", code, __e.stack?.split("\\n").slice(1, 3).join(" | "));\n\treturn { ok: false, code } as ResolveActiveBoundLaunchContractResult;\n}'
		);
		resolver = resolver.replace(
			'} catch { return failure("unsupported_mode"); }\n\tconst resolved = resolveAgentName',
			'} catch (e) { console.error("A2DISCOVER-FAIL", String(e && (e.stack || e))); return failure("unsupported_mode"); }\n\tconst resolved = resolveAgentName'
		);
		fs.writeFileSync(resolverPath, resolver);
		// Коммитим локально: identity резолвера = f(remote, HEAD), и bound-путь
		// в debug-прогоне должен существовать.
		spawnSync("git", ["add", "-A"], { cwd: extensionDir });
		const cr = spawnSync("git", ["commit", "-q", "-m", "a2-debug-instrumentation"], { cwd: extensionDir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "probe", GIT_AUTHOR_EMAIL: "probe@local", GIT_COMMITTER_NAME: "probe", GIT_COMMITTER_EMAIL: "probe@local" } });
		if (cr.status !== 0) process.stderr.write("debug commit skipped\n");
	}

// --- 2. Owner + dependency пакеты (реальные каталоги) ---
const ownerDir = path.join(root, "ownpkg"), depDir = path.join(root, "deppkg");
fs.mkdirSync(path.join(ownerDir, "agents", "ext"), { recursive: true });
fs.mkdirSync(path.join(depDir), { recursive: true });

// Dependency: единственная pi.extensions запись, фабрика регистрирует тул.
fs.writeFileSync(path.join(depDir, "package.json"), JSON.stringify({
	name: "a1dep", version: "1.0.0", private: true, type: "module",
	main: "./index.ts",
	pi: { extensions: ["./index.ts"] },
}, null, 2));
	const importTypebox = process.env.A2_DEP_IMPORTS_TYPEBOX === "1";
	const declarePeer = process.env.A2_DEP_PEER_TYPEBOX === "1";
	fs.writeFileSync(path.join(depDir, "index.ts"),
		(importTypebox ? `import { Type } from "typebox";\nconst flag = Type.Never();\n` : "") +
		`export default function depExtension(pi: any) {\n` +
		`\tpi.registerTool({ name: "dep_tool", label: "dep", description: "dep tool", parameters: { type: "object", properties: {}, required: [] }, async execute() { return { content: [], details: {} }; } });\n` +
		`}\n`);
	if (declarePeer) {
		const mf = path.join(depDir, "package.json");
		const d = JSON.parse(fs.readFileSync(mf, "utf8"));
		d.peerDependencies = { typebox: "*" };
		fs.writeFileSync(mf, JSON.stringify(d, null, 2));
	}
	{
		const tbSrc = process.env.A2_TYPEBOX_DIR || path.join(realHome, ".pi", "agent", "npm", "node_modules", "typebox");
		if (fs.existsSync(tbSrc)) fs.cpSync(tbSrc, path.join(ownerDir, "node_modules", "typebox"), { recursive: true });
	}

// Owner: агенты. rel-leaf - контрольный относительный ref; dep-leaf - package:ref.
fs.writeFileSync(path.join(ownerDir, "package.json"), JSON.stringify({
	name: "a1own", version: "1.0.0", private: true, type: "module",
	dependencies: { a1dep: "file:../deppkg" },
	pi: { subagents: { agents: ["./agents"] } },
}, null, 2));
const leaf = (name, taskMarker, extra) => fs.writeFileSync(path.join(ownerDir, "agents", `${name}.md`),
	`---\nname: "${name}"\ndescription: "${name} leaf"\ndefaultContext: fresh\nmodel: "probe/child"\nthinking: off\ntools: read${extra}\n---\n${taskMarker}\n`);
leaf("rel-leaf", "REL_OK", "\nsubagentOnlyExtensions: ./ext/ref.ts");
leaf("dep-leaf", "DEP_OK", "\nsubagentOnlyExtensions: package:a1dep");
fs.mkdirSync(path.join(ownerDir, "agents", "ext"), { recursive: true });
fs.writeFileSync(path.join(ownerDir, "agents", "ext", "ref.ts"),
	'export default function refExtension(pi: any) {\n\tpi.registerTool({ name: "ref_tool", label: "ref", description: "ref tool", parameters: { type: "object", properties: {}, required: [] }, async execute() { return { content: [], details: {} }; } });\n}\n');

// Материализуем node_modules/a1dep как РЕАЛЬНУЮ копию (не symlink):
// резолверы pinned A1 отвергают symlink-установки.
fs.mkdirSync(path.join(ownerDir, "node_modules"), { recursive: true });
fs.cpSync(depDir, path.join(ownerDir, "node_modules", "a1dep"), { recursive: true });

fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
	packages: [`file:./${path.relative(agentDir, ownerDir)}`],
}, null, 2));

// --- 3. Faux-провайдер: HTTP для детей ---
const bodies = new Map();
let parsedRequests = 0;
const providerServer = createServer((request, response) => {
	let body = "";
	request.setEncoding("utf8");
	request.on("data", (chunk) => { body += chunk; });
	request.on("end", () => {
		const match = /(REL_0|DEP_0)/.exec(body);
		let wireNames = [];
		try { wireNames = (JSON.parse(body).tools ?? []).map((t) => t?.function?.name ?? t); } catch {}
		if (!match) { response.writeHead(500); response.end("unexpected provider request"); return; }
		const key = match[1];
		bodies.set(key, { wireNames });
		parsedRequests++;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(`data: ${JSON.stringify({ id: "l", object: "chat.completion.chunk", created: 1, model: "child", choices: [{ index: 0, delta: { role: "assistant", content: `OK_${key}` }, finish_reason: null }] })}\n\n`);
		response.write(`data: ${JSON.stringify({ id: "l", object: "chat.completion.chunk", created: 1, model: "child", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
		response.end("data: [DONE]\n\n");
	});
});
await new Promise((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
providerServer.unref();
const port = providerServer.address().port;
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { probe: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "probe-key", models: [{ id: "child", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 512 }] } } }));

globalThis[Symbol.for("a1.pkg-projection-control.v1")] = {
	requestCount: () => parsedRequests,
	wireNames: (key) => bodies.get(key)?.wireNames ?? [],
};

// --- 4. Родительская сессия через SDK (faux с принудительным tool call) ---
const runtimeRoot = path.dirname(path.dirname(piBinary));
assert.ok(fs.existsSync(path.join(runtimeRoot, "package.json")), "pi binary вне runtime package");
const coding = await import(pathToFileURL(path.join(runtimeRoot, "dist", "index.js")).href);
const faux = await import(pathToFileURL(path.join(runtimeRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "faux.js")).href);
const { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = coding;

const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
modelRuntime.registerProvider("probe", { name: "Probe", baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "probe-key", models: [{ id: "child", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 512 }] });
const parentFaux = faux.fauxProvider({ provider: "faux-parent", models: [{ id: "parent", contextWindow: 200_000 }] });
modelRuntime.registerProvider(parentFaux.provider.id, { name: parentFaux.provider.name, api: parentFaux.api, apiKey: "faux", streamSimple: parentFaux.provider.streamSimple, models: [...parentFaux.models] });
parentFaux.setResponses([
	() => faux.fauxAssistantMessage([faux.fauxToolCall("pkg_projection_probe", {}, { id: "pkg-call" })], { stopReason: "toolUse" }),
	() => faux.fauxAssistantMessage([faux.fauxText("PARENT_OK")], { stopReason: "stop" }),
]);
const model = modelRuntime.getModel(parentFaux.provider.id, "parent");
assert.ok(model, "parent model missing");

const eventBus = createEventBus();
const settingsManager = SettingsManager.inMemory({ defaultProjectTrust: "always", compaction: { enabled: false }, retry: { enabled: false } });
const loader = new DefaultResourceLoader({
	cwd: project, agentDir, eventBus, settingsManager,
	additionalExtensionPaths: [path.join(repoRoot, "test", "probes", "package-projection-parent.mts")],
	noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	systemPrompt: "Call the pkg_projection_probe tool exactly once.",
});
await loader.reload();

const created = await createAgentSession({ cwd: project, agentDir, model, modelRuntime, resourceLoader: loader, sessionManager: SessionManager.create(project, sessions), settingsManager });
await created.session.bindExtensions({ shutdownHandler: () => {} });

let timer;
try {
	await Promise.race([
		created.session.prompt("Run the package projection probe.", { expandPromptTemplates: false }),
		new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("parent probe timed out")), 180_000); }),
	]);
} finally { clearTimeout(timer); }

const toolResult = [...created.session.messages].reverse().find((m) => m.role === "toolResult" && m.toolName === "pkg_projection_probe");
assert.ok(toolResult, "probe tool result missing");
assert.equal(toolResult.isError, false, String(toolResult.content?.map((c) => c.text).join("\n")));
const resultText = toolResult.content?.map((c) => c.text).join("\n");
assert.equal(resultText, "PKG_PROJECTION_OK", resultText);
assert.deepEqual(toolResult.details?.statuses, { "rel-leaf": "completed", "dep-leaf": "completed" });
assert.ok(parsedRequests >= 2, `expected at least two provider requests, got ${parsedRequests}`);
assert.ok(bodies.get("REL_0")?.wireNames.includes("ref_tool"), "rel_tool missing from provider wire");
assert.ok(bodies.get("DEP_0")?.wireNames.includes("dep_tool"), "dep_tool missing from provider wire");

try {
	await created.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
} catch {}
created.session.dispose();
providerServer.close(); providerServer.closeAllConnections();
for (const [key, value] of priorEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
cleanup();

console.log(JSON.stringify({
	ok: true,
	commit,
	relWire: bodies.get("REL_0")?.wireNames ?? [],
	depWire: bodies.get("DEP_0")?.wireNames ?? [],
}, null, 2));
