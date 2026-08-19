import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { attestBoundRuntimeExtensions } from "../../src/runs/shared/bound-runtime-evidence.ts";
import { packageEvidenceRoot, packageTreeDigest } from "../../src/runs/shared/package-tree-evidence.ts";
import { SUPPORTED_BOUND_PI_VERSIONS } from "../../src/runs/shared/tool-registry-proof.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const piBinary = process.env.PI_SUBAGENT_PI_BINARY || "pi";

function runPi(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; fd3: number }): Promise<{ status: number | null; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(piBinary, args, {
			cwd: options.cwd,
			env: { ...options.env, PI_OFFLINE: "1" },
			stdio: ["ignore", "ignore", "pipe", options.fd3],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (status) => resolve({ status, stderr }));
	});
}

test("installed Pi loads an exact mediated registry before one loopback provider request", async (t) => {
	const versionProbe = spawnSync(piBinary, ["--version"], { encoding: "utf8", timeout: 10_000 });
	const version = versionProbe.status === 0 ? versionProbe.stdout.trim() : "";
	if (!SUPPORTED_BOUND_PI_VERSIONS.has(version)) return t.skip(`installed Pi ${version || "unavailable"} is outside the bound set`);

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bound-registry-installed-"));
	let providerRequests = 0; let wireNames: Array<string | undefined> | undefined; let wireBody = ""; const sockets = new Set<import("node:net").Socket>();
	const server = createServer((request, response) => {
		providerRequests++;
		let body = "";
		request.setEncoding("utf8"); request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			wireBody = body; const payload = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> };
			wireNames = payload.tools?.map((tool) => tool.function?.name);
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(`data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
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
		const packageDir = path.join(root, "package"); fs.mkdirSync(packageDir);
		fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "bound-registry-probe", version: "1.0.0" }));
		const packageExtension = path.join(packageDir, "package.ts");
		fs.writeFileSync(packageExtension, `import { appendFileSync } from "node:fs";\nexport default function (pi: any) { appendFileSync(process.env.BOUND_MARKER!, "factory:" + String(process.env.PI_SUBAGENT_TOOL_REGISTRY_POLICY) + "\\n"); pi.on("session_start", () => { appendFileSync(process.env.BOUND_MARKER!, "session_start\\n"); pi.registerTool({ name: "probe_tool", label: "Probe", description: "Probe", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "ok" }] }; } }); pi.setActiveTools(["probe_tool"]); }); }\n`);
		const runtimeExtensionPaths = [
			path.join(repoRoot, "src/runs/shared/bound-tool-registry-bootstrap.ts"),
			path.join(repoRoot, "src/runs/shared/subagent-prompt-runtime.ts"),
			path.join(repoRoot, "src/runs/shared/bound-package-mediator.ts"),
			path.join(repoRoot, "src/runs/shared/bound-tool-registry-gate.ts"),
		];
		const evidenceRoot = packageEvidenceRoot(packageDir);
		const policy = {
			version: 1, modelApi: "openai-completions", piRuntimeVersion: version, proofNonce: "e".repeat(64), required: ["probe_tool"], internalTools: [],
			runtimeExtensions: attestBoundRuntimeExtensions(runtimeExtensionPaths),
			packageExtensions: [{ path: packageExtension, contentDigest: createHash("sha256").update(fs.readFileSync(packageExtension)).digest("hex"), evidenceRoot, evidenceRootDigest: createHash("sha256").update(evidenceRoot).digest("hex"), packageTreeDigest: packageTreeDigest(packageExtension, evidenceRoot) }],
		};
		const proofPath = path.join(root, "proof");
		const proofFd = fs.openSync(proofPath, "w");
		let gated;
		try {
			gated = await runPi([
				"--no-extensions", "--no-context-files", "--no-skills", "--no-themes", "--no-session",
				"--model", "probe/probe", "--tools", "probe_tool",
				"--extension", runtimeExtensionPaths[0]!, "--extension", runtimeExtensionPaths[1]!, "--extension", runtimeExtensionPaths[2]!, "--extension", runtimeExtensionPaths[3]!,
				"-p", "probe",
			], {
				cwd: project,
				env: {
					...process.env, PI_CODING_AGENT_DIR: agentDir, BOUND_MARKER: marker,
					PI_SUBAGENT_TOOL_REGISTRY_ACTIVE: "1", PI_SUBAGENT_TOOL_REGISTRY_POLICY: JSON.stringify(policy), PI_SUBAGENT_TOOL_REGISTRY_FD: "3",
				},
				fd3: proofFd,
			});
		} finally { fs.closeSync(proofFd); }
		assert.equal(gated.status, 0, gated.stderr);
		assert.equal(providerRequests, 1);
		assert.deepEqual(wireNames, ["probe_tool"], wireBody);
		assert.deepEqual(fs.readFileSync(marker, "utf8").trim().split("\n"), ["factory:undefined", "session_start"]);
		const frame = JSON.parse(fs.readFileSync(proofPath, "utf8"));
		assert.equal(frame.kind, "registry");
		assert.deepEqual(frame.projection.required, ["probe_tool"]);
		assert.deepEqual(frame.projection.effectiveCallerTools, ["probe_tool"]);
	} finally {
		server.close(); server.closeAllConnections(); for (const socket of sockets) socket.destroy();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
