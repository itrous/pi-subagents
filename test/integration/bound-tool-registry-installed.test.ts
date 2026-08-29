import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { resolveActiveBoundLaunchContract } from "../../src/api/active-bound-resolver.ts";
import { attestBoundRuntimeExtensions } from "../../src/runs/shared/bound-runtime-evidence.ts";
import { packageEvidenceRoot, packageTreeDigest } from "../../src/runs/shared/package-tree-evidence.ts";
import { resolvePiLaunchToolPlan } from "../../src/runs/shared/pi-args.ts";
import { SUPPORTED_BOUND_PI_VERSIONS } from "../../src/runs/shared/tool-registry-proof.ts";

const piBinary = process.env.PI_SUBAGENT_PI_BINARY || "pi";

export function assertRequiredPiVersion(actual: string, required: string | undefined): void {
	if (required === undefined) return;
	assert.equal(required, "0.84.3", `required installed Pi version must be 0.84.3, got ${required}`);
	assert.equal(actual, required, `required installed Pi ${required}, got ${actual || "unavailable"}`);
}

test("required installed Pi version gate rejects mismatch", () => {
	assert.throws(() => assertRequiredPiVersion("0.84.2", "0.84.2"), /must be 0\.84\.3/);
	assert.throws(() => assertRequiredPiVersion("0.84.2", "0.84.3"), /required installed Pi 0\.84\.3/);
	assert.doesNotThrow(() => assertRequiredPiVersion("0.84.3", "0.84.3"));
});

function runPi(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; fd3: number; fd4: number }): Promise<{ status: number | null; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(piBinary, args, {
			cwd: options.cwd,
			env: { ...options.env, PI_OFFLINE: "1" },
			stdio: ["ignore", "ignore", "pipe", options.fd3, options.fd4],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (status) => resolve({ status, stderr }));
	});
}

test("installed Pi loads and executes a packed owner tool after exact mediated registry proof", async (t) => {
	const versionProbe = spawnSync(piBinary, ["--version"], { encoding: "utf8", timeout: 10_000 });
	const version = versionProbe.status === 0 ? versionProbe.stdout.trim() : "";
	assertRequiredPiVersion(version, process.env.PI_SUBAGENT_REQUIRED_PI_VERSION);
	if (!SUPPORTED_BOUND_PI_VERSIONS.has(version)) return t.skip(`installed Pi ${version || "unavailable"} is outside the bound set`);

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bound-registry-installed-"));
	let providerRequests = 0; const wireNames: Array<Array<string | undefined>> = []; let wireBody = ""; const sockets = new Set<import("node:net").Socket>();
	const server = createServer((request, response) => {
		providerRequests++;
		let body = "";
		request.setEncoding("utf8"); request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			wireBody = body; const payload = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> };
			wireNames.push(payload.tools?.map((tool) => tool.function?.name) ?? []);
			response.writeHead(200, { "content-type": "text/event-stream" });
			if (providerRequests === 1) {
				response.write(`data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "probe-call", type: "function", function: { name: "probe_tool", arguments: "{}" } }] }, finish_reason: null }] })}\n\n`);
				response.write(`data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
			} else {
				response.write(`data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
				response.write(`data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
			}
			response.end("data: [DONE]\n\n");
		});
	});
	server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); server.unref();
	try {
		const address = server.address();
		assert.ok(address && typeof address === "object");
		const project = path.join(root, "project"); fs.mkdirSync(project);
		const agentDir = path.join(root, "agent"); fs.mkdirSync(agentDir);
		fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { probe: {
			baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "probe-key",
			models: [{ id: "probe", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 256 }],
		} } }));

		const marker = path.join(root, "marker");
		const packageSource = path.join(root, "package-source"); fs.mkdirSync(path.join(packageSource, "agents"), { recursive: true });
		fs.writeFileSync(path.join(packageSource, "package.json"), JSON.stringify({ name: "bound-registry-probe", version: "1.0.0", pi: { subagents: { agents: ["./agents"] } } }));
		fs.writeFileSync(path.join(packageSource, "agents", "package.ts"), `import { appendFileSync } from "node:fs";\nexport default function (pi: any) { appendFileSync(process.env.BOUND_MARKER!, "factory:" + String(process.env.PI_SUBAGENT_TOOL_REGISTRY_POLICY) + "\\n"); pi.on("session_start", () => { appendFileSync(process.env.BOUND_MARKER!, "session_start\\n"); pi.registerTool({ name: "probe_tool", label: "Probe", description: "Probe", parameters: { type: "object", properties: {} }, async execute() { appendFileSync(process.env.BOUND_MARKER!, "tool_execute\\n"); return { content: [{ type: "text", text: "ok" }] }; } }); pi.setActiveTools(["probe_tool"]); }); }\n`);
		fs.writeFileSync(path.join(packageSource, "agents", "probe.md"), "---\nname: package-probe\ndescription: Package probe\ntools: probe_tool\nsubagentOnlyExtensions: ./package.ts\n---\nProbe.\n");
		const packed = spawnSync("npm", ["pack", packageSource, "--ignore-scripts", "--pack-destination", root], { encoding: "utf8", timeout: 30_000 });
		assert.equal(packed.status, 0, packed.stderr); const tarball = path.join(root, packed.stdout.trim().split("\n").at(-1)!);
		const unpackRoot = path.join(root, "packed"); fs.mkdirSync(unpackRoot);
		const unpacked = spawnSync("tar", ["-xzf", tarball, "-C", unpackRoot], { encoding: "utf8", timeout: 30_000 }); assert.equal(unpacked.status, 0, unpacked.stderr);
		const packageDir = path.join(unpackRoot, "package"); const packageExtension = path.join(packageDir, "agents", "package.ts");
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [{ source: `file:${packageDir}` }] }));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		let preflight;
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			preflight = resolveActiveBoundLaunchContract({
				request: { version: 1, targetServerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", requestId: "probe-request", ownerRunId: "probe-owner", nodeId: "probe-node", prospectiveRunId: "123e4567-e89b-12d3-a456-426614174000", agent: "package-probe", task: "Probe", cwd: project, context: "fresh", model: "probe/probe", thinking: "off", artifacts: false, result: { kind: "text" } },
				activeCwd: project, projectTrusted: true, sessionManager: { getSessionFile: () => path.join(root, "parent.jsonl"), getSessionId: () => "parent-session" },
				availableModels: [{ provider: "probe", id: "probe", fullId: "probe/probe", api: "openai-completions", reasoning: false }],
				serverInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceIdentityDigest: "a".repeat(64), defaultSessionDir: path.join(root, "sessions"),
				runtimePolicy: { foregroundTimeoutMs: 30_000, waitToolEnabled: false, currentDepth: 0, maxSubagentDepth: 1 },
			});
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		assert.equal(preflight.ok, true, JSON.stringify(preflight)); if (!preflight.ok) return;
		assert.deepEqual(preflight.contract.tools.requiredChildTools, ["probe_tool"]);
		assert.deepEqual(preflight.contract.toolRegistry.projection.effectiveCallerTools, ["probe_tool"]);
		assert.equal(preflight.contract.packageExtensions.length, 1);
		const toolPlan = resolvePiLaunchToolPlan({
			tools: ["probe_tool"], extensions: [], subagentOnlyExtensions: [packageExtension],
			activeBoundPackageMediator: true, disablePermissionSystemExtension: true,
		});
		assert.deepEqual(toolPlan.effectiveToolAllowlist, ["probe_tool"]);
		assert.deepEqual(toolPlan.requiredChildTools, ["probe_tool"]);
		assert.equal(toolPlan.extensionArgs.includes(packageExtension), false);
		const runtimeExtensionPaths = toolPlan.runtimeExtensions;
		const evidenceRoot = packageEvidenceRoot(packageDir);
		const policy = {
			version: 1, modelApi: "openai-completions", piRuntimeVersion: version, proofNonce: "e".repeat(64), denialFd: 4, required: ["probe_tool"], internalTools: [],
			runtimeExtensions: attestBoundRuntimeExtensions(runtimeExtensionPaths),
			packageExtensions: [{ path: packageExtension, contentDigest: createHash("sha256").update(fs.readFileSync(packageExtension)).digest("hex"), evidenceRoot, evidenceRootDigest: createHash("sha256").update(evidenceRoot).digest("hex"), packageTreeDigest: packageTreeDigest(packageExtension, evidenceRoot) }],
		};
		const proofPath = path.join(root, "proof");
		const proofFd = fs.openSync(proofPath, "w"); const denialPath = path.join(root, "denial-proof"); const denialFd = fs.openSync(denialPath, "w");
		let gated;
		try {
			gated = await runPi([
				"--no-extensions", "--no-context-files", "--no-skills", "--no-themes", "--no-session",
				"--model", "probe/probe", "--tools", toolPlan.effectiveToolAllowlist.join(","),
				...runtimeExtensionPaths.flatMap((extension) => ["--extension", extension]),
				"-p", "probe",
			], {
				cwd: project,
				env: {
					...process.env, PI_CODING_AGENT_DIR: agentDir, BOUND_MARKER: marker,
					PI_SUBAGENT_TOOL_REGISTRY_ACTIVE: "1", PI_SUBAGENT_TOOL_REGISTRY_POLICY: JSON.stringify(policy), PI_SUBAGENT_TOOL_REGISTRY_FD: "3", PI_SUBAGENT_TOOL_REGISTRY_CWD: fs.realpathSync(project),
				},
				fd3: proofFd, fd4: denialFd,
			});
		} finally { fs.closeSync(proofFd); fs.closeSync(denialFd); }
		assert.equal(gated.status, 0, gated.stderr);
		assert.equal(providerRequests, 2);
		assert.deepEqual(wireNames, [["probe_tool"], ["probe_tool"]], wireBody);
		assert.deepEqual(fs.readFileSync(marker, "utf8").trim().split("\n"), ["factory:undefined", "session_start", "tool_execute"]);
		const frame = JSON.parse(fs.readFileSync(proofPath, "utf8"));
		assert.equal(frame.kind, "registry");
		assert.deepEqual(frame.projection.required, ["probe_tool"]);
		assert.deepEqual(frame.projection.effectiveCallerTools, ["probe_tool"]);
		assert.deepEqual(JSON.parse(fs.readFileSync(denialPath, "utf8")), { version: 1, kind: "denied_tool_calls", calls: [], overflow: false, proofNonce: "e".repeat(64) });
	} finally {
		server.close(); server.closeAllConnections(); for (const socket of sockets) socket.destroy();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
