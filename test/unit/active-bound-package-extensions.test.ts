import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverProjectAgentsRestricted } from "../../src/agents/agents.ts";
import { resolveActiveBoundPackageExtensions } from "../../src/api/active-bound-package-extensions.ts";
import { resolveActiveBoundLaunchContract } from "../../src/api/active-bound-resolver.ts";
import { resolvePiLaunchToolPlan } from "../../src/runs/shared/pi-args.ts";
import { packageEvidenceRoot, packageTreeDigest } from "../../src/runs/shared/package-tree-evidence.ts";

let root: string; let previousAgentDir: string | undefined;
function writeJson(file: string, value: unknown): void { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }
function fixture(refs = ["./relative.ts", "package:fixture-adapter"]): { project: string; owner: string; sentinel: string } {
	const project = path.join(root, "project"); const owner = path.join(root, "owner"); const adapter = path.join(owner, "node_modules", "fixture-adapter");
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true }); fs.mkdirSync(path.join(owner, "agents"), { recursive: true }); fs.mkdirSync(adapter, { recursive: true });
	const sentinel = path.join(root, "loaded");
	writeJson(path.join(owner, "package.json"), { name: "fixture-owner", version: "1.0.0", dependencies: { "fixture-adapter": "1.0.0" }, pi: { subagents: { agents: ["./agents"] } } });
	fs.writeFileSync(path.join(owner, "agents", "worker.md"), `---\nname: package-worker\ndescription: Package worker\ntools: read\nsubagentOnlyExtensions: ${refs.join(", ")}\n---\nWorker\n`);
	fs.writeFileSync(path.join(owner, "agents", "relative.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "relative"); export default function () {}`);
	writeJson(path.join(adapter, "package.json"), { name: "fixture-adapter", version: "2.0.0", main: "./entry.js", pi: { extensions: ["./index.ts"] } });
	fs.writeFileSync(path.join(adapter, "entry.js"), "export default {};\n");
	fs.writeFileSync(path.join(adapter, "index.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "adapter"); export default function () {}`);
	writeJson(path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), { packages: [{ source: `file:${owner}` }] });
	return { project, owner, sentinel };
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "bound-package-")); previousAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = path.join(root, "agent-home"); fs.mkdirSync(process.env.PI_CODING_AGENT_DIR); });
afterEach(() => { if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; fs.rmSync(root, { recursive: true, force: true }); });

describe("active-bound package extension refs", () => {
	it("uses the exact owning package rather than the whole npm ecosystem as evidence root", () => {
		const packageRoot = path.join(root, "npm", "node_modules", "owner", "node_modules", "adapter");
		assert.equal(packageEvidenceRoot(packageRoot), packageRoot);
	});

	it("bounds package evidence directory depth", () => {
		const evidenceRoot = path.join(root, "deep-package"); fs.mkdirSync(evidenceRoot); writeJson(path.join(evidenceRoot, "package.json"), { name: "deep-package", version: "1.0.0" });
		const entry = path.join(evidenceRoot, "entry.ts"); fs.writeFileSync(entry, "export default 1;\n");
		let current = evidenceRoot; for (let index = 0; index < 66; index++) { current = path.join(current, "d"); fs.mkdirSync(current); }
		assert.throws(() => packageTreeDigest(entry, evidenceRoot), /too deep/);
	});

	it("discovers only the active settings package and resolves refs without importing code", () => {
		const f = fixture();
		const unregistered = path.join(f.project, "node_modules", "ambient"); fs.mkdirSync(unregistered, { recursive: true });
		writeJson(path.join(unregistered, "package.json"), { name: "ambient", version: "1.0.0", pi: { subagents: { agents: ["agents"] } } });
		const discovered = discoverProjectAgentsRestricted(f.project, true); assert.equal(discovered.agents.length, 1);
		const agent = discovered.agents[0]!; assert.equal(agent.source, "package");
		const resolved = resolveActiveBoundPackageExtensions(agent);
		assert.equal(fs.existsSync(f.sentinel), false, "metadata resolution must not import extension code");
		assert.deepEqual(resolved.projection.map((entry) => entry.kind), ["relative", "package"]);
		assert.deepEqual(resolved.projection.map((entry) => entry.ref), ["./relative.ts", "package:fixture-adapter"]);
		assert.doesNotMatch(JSON.stringify(resolved.projection), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		const plan = resolvePiLaunchToolPlan({ tools: ["read"], extensions: [], subagentOnlyExtensions: resolved.paths, disablePermissionSystemExtension: true });
		assert.equal(plan.disableAmbientExtensions, true); for (const entry of resolved.paths) assert.ok(plan.extensionArgs.includes(entry));
	});

	it("publishes only the bound projection and rejects an external extension ceiling", () => {
		const f = fixture(); const sessions = path.join(root, "sessions"); fs.mkdirSync(sessions);
		const request = { version: 1 as const, targetServerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", requestId: "request", ownerRunId: "owner", nodeId: "node", prospectiveRunId: "123e4567-e89b-12d3-a456-426614174000", agent: "package-worker", task: "Inspect", cwd: f.project, context: "fresh" as const, model: "test/exact", thinking: "off" as const, artifacts: false, result: { kind: "text" as const } };
		const input = { request, activeCwd: f.project, projectTrusted: true, sessionManager: { getSessionFile: () => path.join(root, "parent.jsonl"), getSessionId: () => "session" }, availableModels: [{ provider: "test", id: "exact", fullId: "test/exact", api: "openai-responses", reasoning: false }], serverInstanceId: request.targetServerInstanceId, sourceIdentityDigest: "a".repeat(64), defaultSessionDir: sessions, runtimePolicy: { foregroundTimeoutMs: 1000, waitToolEnabled: false, currentDepth: 0, maxSubagentDepth: 1 } };
		const resolved = resolveActiveBoundLaunchContract(input); assert.equal(resolved.ok, true); if (!resolved.ok) return;
		assert.equal(resolved.contract.packageExtensions.length, 2); const serialized = JSON.stringify(resolved.contract);
		assert.doesNotMatch(serialized, new RegExp(f.owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(resolveActiveBoundLaunchContract({ ...input, capabilityCeiling: { version: 1, denyExtensions: true, sources: ["test"] } }).ok, false);
	});

	it("binds extension byte mutations and preserves external denyExtensions", () => {
		const f = fixture(); const agent = discoverProjectAgentsRestricted(f.project, true).agents[0]!;
		const first = resolveActiveBoundPackageExtensions(agent); fs.appendFileSync(first.paths[0]!, "\n// drift");
		const second = resolveActiveBoundPackageExtensions(discoverProjectAgentsRestricted(f.project, true).agents[0]!);
		assert.notEqual(first.projection[0]!.contentDigest, second.projection[0]!.contentDigest);
		const denied = resolvePiLaunchToolPlan({ tools: ["read"], extensions: [], subagentOnlyExtensions: second.paths, capabilityCeiling: { version: 1, denyExtensions: true, sources: ["test"] }, disablePermissionSystemExtension: true });
		assert.deepEqual(denied.configuredExtensions, []); assert.equal(denied.capabilityAudit?.removedExtensionCount, 2);
	});

	it("binds transitive package-tree byte mutations", () => {
		const f = fixture(); const agent = discoverProjectAgentsRestricted(f.project, true).agents[0]!;
		const first = resolveActiveBoundPackageExtensions(agent);
		fs.writeFileSync(path.join(f.owner, "node_modules", "fixture-adapter", "helper.ts"), "export const drift = 1;\n");
		const second = resolveActiveBoundPackageExtensions(discoverProjectAgentsRestricted(f.project, true).agents[0]!);
		assert.notEqual(first.projection.find((entry) => entry.kind === "package")!.packageTreeDigest, second.projection.find((entry) => entry.kind === "package")!.packageTreeDigest);
	});

	it("supports a hoisted dependency and bare-relative manifest entry", () => {
		const f = fixture(); const local = path.join(f.owner, "node_modules", "fixture-adapter"); const hoisted = path.join(root, "node_modules", "fixture-adapter");
		fs.mkdirSync(path.dirname(hoisted), { recursive: true }); fs.renameSync(local, hoisted);
		const manifest = JSON.parse(fs.readFileSync(path.join(hoisted, "package.json"), "utf8")); manifest.pi.extensions = ["index.ts"]; writeJson(path.join(hoisted, "package.json"), manifest);
		const resolved = resolveActiveBoundPackageExtensions(discoverProjectAgentsRestricted(f.project, true).agents[0]!);
		assert.equal(resolved.projection.find((entry) => entry.kind === "package")?.contentDigest.length, 64);
	});

	it("rejects dependency symlink escape and duplicate cross-scope roots", () => {
		const f = fixture(); const adapter = path.join(f.owner, "node_modules", "fixture-adapter"); const outside = path.join(root, "outside-adapter");
		fs.renameSync(adapter, outside); fs.symlinkSync(outside, adapter);
		assert.throws(() => resolveActiveBoundPackageExtensions(discoverProjectAgentsRestricted(f.project, true).agents[0]!));
		fs.rmSync(adapter); fs.renameSync(outside, adapter);
		writeJson(path.join(f.project, ".pi", "settings.json"), { packages: [`file:${f.owner}`] });
		assert.throws(() => discoverProjectAgentsRestricted(f.project, true), /Duplicate active-bound package root/);
	});

	it("keeps the user registry available without project config and defaults trust closed", () => {
		const f = fixture(); fs.rmSync(path.join(f.project, ".pi"), { recursive: true, force: true });
		assert.equal(discoverProjectAgentsRestricted(f.project).agents.some((agent) => agent.name === "package-worker"), true);
		fs.mkdirSync(path.join(f.project, ".pi"), { recursive: true });
		writeJson(path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), {});
		writeJson(path.join(f.project, ".pi", "settings.json"), { packages: [`file:${f.owner}`] });
		assert.equal(discoverProjectAgentsRestricted(f.project).agents.length, 0);
	});

	it("fails closed for owner/ref grammar and project trust", () => {
		const f = fixture(["./nested/../relative.ts"]); assert.throws(() => discoverProjectAgentsRestricted(f.project, true));
		fs.writeFileSync(path.join(f.owner, "agents", "worker.md"), "---\nname: package-worker\ndescription: Package worker\ntools: read\nsubagentOnlyExtensions: ./relative.ts, package:fixture-adapter\n---\nWorker\n");
		assert.equal(discoverProjectAgentsRestricted(f.project, false).agents.length, 1, "user registry remains available");
		writeJson(path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), {}); writeJson(path.join(f.project, ".pi", "settings.json"), { packages: [`file:${f.owner}`] });
		assert.equal(discoverProjectAgentsRestricted(f.project, false).agents.length, 0, "untrusted project registry is excluded");
		writeJson(path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), { packages: [{ source: `file:${f.owner}`, extra: true }] });
		assert.throws(() => discoverProjectAgentsRestricted(f.project, true));
		writeJson(path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), { packages: [f.owner] });
		assert.throws(() => discoverProjectAgentsRestricted(f.project, true));
	});
});
