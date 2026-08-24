import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseActiveBoundPreflightRequest, type ActiveBoundPreflightRequestV1 } from "../../src/api/active-bound-preflight.ts";
import { resolveActiveBoundLaunchContract, type ResolveActiveBoundLaunchContractInput } from "../../src/api/active-bound-resolver.ts";
import { clearSkillCache } from "../../src/agents/skills.ts";
import { getAgentRefinementPath } from "../../src/agents/agent-refinements.ts";
import { agentDefinitionDigest } from "../../src/shared/launch-contract.ts";
import { discoverAgents } from "../../src/agents/agents.ts";
import { canonicalSha256 } from "../../src/shared/canonical-json.ts";

let root = "";
let previousHome: string | undefined;
let previousAgentDir: string | undefined;

function request(cwd: string, overrides: Partial<ActiveBoundPreflightRequestV1> = {}): ActiveBoundPreflightRequestV1 {
	const parsed = parseActiveBoundPreflightRequest({
		version: 1, targetServerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", requestId: "request", ownerRunId: "owner", nodeId: "node",
		prospectiveRunId: "123e4567-e89b-12d3-a456-426614174000", agent: "bound-worker", task: "Inspect", cwd,
		context: "fresh", model: "test/exact", thinking: "high", skill: ["bound-skill"], artifacts: false,
		result: { kind: "text" }, ...overrides,
	});
	assert.equal(parsed.ok, true);
	return parsed.request;
}
function setup(cwd: string): { agent: string; skill: string } {
	fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
	fs.mkdirSync(path.join(cwd, ".pi", "skills", "bound-skill"), { recursive: true });
	const agent = path.join(cwd, ".pi", "agents", "worker.md");
	const skill = path.join(cwd, ".pi", "skills", "bound-skill", "SKILL.md");
	fs.writeFileSync(agent, "---\nname: bound-worker\ndescription: Bound worker\ntools: read\n---\nBound prompt.\n");
	fs.writeFileSync(skill, "---\ndescription: bound skill\n---\nUse it.\n");
	return { agent, skill };
}
function input(cwd: string, req = request(cwd)): ResolveActiveBoundLaunchContractInput {
	return {
		request: req, activeCwd: cwd, sessionManager: { getSessionFile: () => path.join(root, "sessions", "parent.jsonl"), getSessionId: () => "pi-session" },
		projectTrusted: true, availableModels: [{ provider: "test", id: "exact", fullId: "test/exact", api: "openai-responses", reasoning: true }], serverInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceIdentityDigest: "a".repeat(64), defaultSessionDir: path.join(root, "child-sessions"),
		runtimePolicy: { foregroundTimeoutMs: 30 * 60 * 1000, waitToolEnabled: true },
	};
}

describe("restricted active-bound resolver", () => {
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "active-bound-"));
		previousHome = process.env.HOME; previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.HOME = path.join(root, "home"); process.env.PI_CODING_AGENT_DIR = path.join(root, "home", ".pi", "agent");
		fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true }); clearSkillCache();
	});
	afterEach(() => {
		clearSkillCache();
		if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("resolves deterministically with exact model, canonical cwd/session and no filesystem writes", () => {
		const cwd = path.join(root, "repo"); setup(cwd);
		const alias = path.join(root, "repo-alias"); fs.symlinkSync(cwd, alias);
		const before = new Set(fs.readdirSync(root));
		const first = resolveActiveBoundLaunchContract(input(alias, request(alias)));
		const second = resolveActiveBoundLaunchContract(input(alias, request(alias)));
		assert.equal(first.ok, true); assert.equal(second.ok, true);
		assert.equal(first.contract.digest, second.contract.digest);
		assert.equal(first.contract.canonicalCwd, fs.realpathSync(cwd));
		assert.deepEqual(first.contract.modelCandidates, ["test/exact:high"]);
		assert.equal(first.contract.policy.artifacts, false);
		assert.equal(first.contract.tools.disableAmbientExtensions, true);
		assert.equal(first.contract.toolRegistry.modelApi, "openai-responses");
		assert.equal(first.contract.toolRegistry.piRuntimeVersion, "0.84.2");
		assert.deepEqual(first.contract.toolRegistry.projection.effectiveCallerTools, ["read"]);
		assert.deepEqual(first.contract.toolRegistry.projection.missing, []);
		assert.match(first.contract.toolRegistry.digest, /^[0-9a-f]{64}$/);
		assert.equal(first.contract.timeoutMs, 30 * 60 * 1000);
		assert.equal(first.contract.agent.definitionDigest, agentDefinitionDigest(discoverAgents(cwd, "both").agents.find((agent) => agent.name === "bound-worker")!));
		assert.equal(Object.hasOwn(first.contract.agent, "filePath"), false);
		assert.equal(Object.hasOwn(first.contract.skills[0] ?? {}, "path"), false);
		assert.equal(Object.hasOwn(first.contract, "launchBinding"), false);
		assert.equal(fs.existsSync(path.join(root, "child-sessions")), false);
		assert.deepEqual(new Set(fs.readdirSync(root)), before);
		const withEnvironment = resolveActiveBoundLaunchContract(input(alias, request(alias, { environment: { ONECPI_REVIEW_ROOT: "/private/root" } })));
		assert.equal(withEnvironment.ok, true); if (!withEnvironment.ok) return;
		assert.deepEqual(withEnvironment.contract.environment.names, ["ONECPI_REVIEW_ROOT"]);
		assert.doesNotMatch(JSON.stringify(withEnvironment.contract), /private\/root/);
		assert.notEqual(withEnvironment.contract.launchInputsDigest, first.contract.launchInputsDigest);
		assert.notEqual(withEnvironment.contract.digest, first.contract.digest);
		const withArtifacts = resolveActiveBoundLaunchContract(input(alias, request(alias, { artifacts: true, artifactDir: "session" })));
		assert.equal(withArtifacts.ok, true); if (!withArtifacts.ok) return;
		assert.equal(withArtifacts.contract.policy.artifacts, true); assert.equal(withArtifacts.contract.policy.artifactDir, "session"); assert.match(withArtifacts.contract.roots.artifactRootDigest ?? "", /^[0-9a-f]{64}$/);
		assert.notEqual(withArtifacts.contract.launchInputsDigest, first.contract.launchInputsDigest); assert.equal(fs.existsSync(path.join(root, "child-sessions")), false);
	});

	it("fails exact model, cwd, session and deterministic-root restrictions closed", () => {
		const cwd = path.join(root, "repo"); setup(cwd);
		assert.deepEqual(resolveActiveBoundLaunchContract(input(cwd, { ...request(cwd), artifacts: true } as ActiveBoundPreflightRequestV1)), { ok: false, code: "unsupported_mode" });
		assert.deepEqual(resolveActiveBoundLaunchContract({ ...input(cwd), sourceIdentityDigest: "" }), { ok: false, code: "unverified_source" });
		assert.deepEqual(resolveActiveBoundLaunchContract({ ...input(cwd), serverInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }), { ok: false, code: "unverified_source" });
		assert.deepEqual(resolveActiveBoundLaunchContract({ ...input(cwd), availableModels: [{ provider: "test", id: "other", fullId: "test/other" }] }), { ok: false, code: "unavailable_model" });
		assert.deepEqual(resolveActiveBoundLaunchContract({ ...input(cwd), availableModels: [{ provider: "test", id: "exact", fullId: "test/exact", api: "openai-responses", reasoning: false }] }), { ok: false, code: "unavailable_model" });
		assert.deepEqual(resolveActiveBoundLaunchContract({ ...input(cwd), activeCwd: root }), { ok: false, code: "invalid_cwd" });
		assert.deepEqual(resolveActiveBoundLaunchContract({ ...input(cwd), sessionManager: { getSessionFile: () => null, getSessionId: () => "pi" }, defaultSessionDir: undefined }), { ok: false, code: "host_required" });
		assert.deepEqual(resolveActiveBoundLaunchContract({ ...input(cwd), sessionManager: { getSessionFile: () => null, getSessionId: () => null } }), { ok: false, code: "host_required" });
		assert.deepEqual(resolveActiveBoundLaunchContract({ ...input(cwd), sessionManager: { getSessionFile() { throw new Error("closed"); }, getSessionId: () => "pi" } }), { ok: false, code: "host_required" });
		let fileReads = 0; let idReads = 0;
		const stable = resolveActiveBoundLaunchContract({ ...input(cwd), sessionManager: {
			getSessionFile: () => { fileReads++; return path.join(root, "sessions", `parent-${fileReads}.jsonl`); },
			getSessionId: () => { idReads++; return `pi-${idReads}`; },
		} });
		assert.equal(stable.ok, true);
		assert.deepEqual({ fileReads, idReads }, { fileReads: 1, idReads: 1 });
	});

	it("resolves project agents and skills from a nested cwd", () => {
		const project = path.join(root, "nested-project"); setup(project);
		const cwd = path.join(project, "packages", "app"); fs.mkdirSync(cwd, { recursive: true });
		const result = resolveActiveBoundLaunchContract({ ...input(cwd, request(cwd)), activeCwd: cwd });
		assert.equal(result.ok, true);
		assert.equal(result.contract.skills[0]?.name, "bound-skill");
	});

	it("rejects external agent roots and non-project injected agents", () => {
		const cwd = path.join(root, "linked-agents");
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		const external = path.join(root, "external-agents"); fs.mkdirSync(external, { recursive: true });
		fs.writeFileSync(path.join(external, "worker.md"), "---\nname: bound-worker\ndescription: Worker\ntools: read\n---\nPrompt.\n");
		fs.symlinkSync(external, path.join(cwd, ".pi", "agents"), "dir");
		assert.deepEqual(resolveActiveBoundLaunchContract(input(cwd, request(cwd, { skill: false }))), { ok: false, code: "missing_agent" });

		const project = path.join(root, "injected-user"); setup(project);
		const discovered = discoverAgents(project, "both");
		const userAgent = { ...discovered.agents.find((agent) => agent.name === "bound-worker")!, source: "user" as const };
		assert.deepEqual(resolveActiveBoundLaunchContract({
			...input(project, request(project, { skill: false })),
			discover: (() => ({ agents: [userAgent], projectAgentsDir: null })) as typeof discoverAgents,
		}), { ok: false, code: "unsupported_mode" });
	});

	it("rejects unsupported refinement filenames without throwing", () => {
		const cwd = path.join(root, "odd-agent-name"); setup(cwd);
		fs.writeFileSync(path.join(cwd, ".pi", "agents", "worker.md"), "---\nname: worker..v1\ndescription: Worker\ntools: read\n---\nPrompt.\n");
		assert.deepEqual(resolveActiveBoundLaunchContract(input(cwd, request(cwd, { agent: "worker..v1", skill: false }))), { ok: false, code: "unsupported_mode" });
	});

	it("rejects fallback, external runner, extensions and package/custom skill refs", () => {
		for (const extra of ["fallbackModels: test/other", "runner:\n  type: external-cli\n  command: x", "extensions: /tmp/x.ts", "skillPath: /tmp/skills"]) {
			const cwd = path.join(root, extra.split(":")[0]!.replace(/[^a-z]/g, "")); setup(cwd);
			const file = path.join(cwd, ".pi", "agents", "worker.md");
			fs.writeFileSync(file, `---\nname: bound-worker\ndescription: Bound worker\ntools: read\n${extra}\n---\nPrompt.\n`);
			clearSkillCache();
			assert.deepEqual(resolveActiveBoundLaunchContract(input(cwd)), { ok: false, code: "unsupported_mode" });
		}
	});

	it("rejects project-owned custom, historical web, and supervisor tools", () => {
		for (const tool of ["git_read", "web_search", "fetch_content", "get_search_content", "intercom", "contact_supervisor"]) {
			const cwd = path.join(root, `no-${tool}`); setup(cwd);
			fs.writeFileSync(path.join(cwd, ".pi", "agents", "worker.md"), `---\nname: bound-worker\ndescription: Worker\ntools: ${tool}\n---\nPrompt.\n`);
			assert.deepEqual(resolveActiveBoundLaunchContract(input(cwd, request(cwd, { skill: false }))), { ok: false, code: "unsupported_mode" });
		}
	});

	it("rejects an empty tool list, denied read and zero read budget when a skill requires read", () => {
		const cwd = path.join(root, "empty-tools-with-skill"); setup(cwd);
		fs.writeFileSync(path.join(cwd, ".pi", "agents", "worker.md"), "---\nname: bound-worker\ndescription: Bound worker\ntools:\n---\nPrompt.\n");
		const autoRead = resolveActiveBoundLaunchContract(input(cwd));
		assert.equal(autoRead.ok, true);
		assert.deepEqual(autoRead.contract.tools.effectiveAllowlist, ["read"]);
		const denied = path.join(root, "denied-skill-read"); setup(denied);
		fs.writeFileSync(path.join(denied, ".pi", "agents", "worker.md"), "---\nname: bound-worker\ndescription: Bound worker\ntools: read\nskills: bound-skill\npermissions:\n  read: deny\n---\nPrompt.\n");
		assert.deepEqual(resolveActiveBoundLaunchContract(input(denied)), { ok: false, code: "restricted_agent" });
		const budgeted = path.join(root, "zero-skill-read"); setup(budgeted);
		assert.deepEqual(resolveActiveBoundLaunchContract(input(budgeted, request(budgeted, { toolBudget: { hard: 0 } }))), { ok: false, code: "restricted_agent" });
		assert.deepEqual(resolveActiveBoundLaunchContract({ ...input(budgeted), runtimePolicy: { foregroundTimeoutMs: 99, waitToolEnabled: false, permissions: { rules: { read: "ask" } } } }), { ok: false, code: "restricted_agent" });
		assert.deepEqual(resolveActiveBoundLaunchContract(input(budgeted, request(budgeted, { skill: false, result: { kind: "structured", schema: { type: "object" } }, toolBudget: { hard: 0, block: "*" } }))), { ok: false, code: "restricted_agent" });
	});

	it("rejects implicit tools, inherited context, memory, reads, refinements and custom skills", () => {
		for (const [name, frontmatter] of [
			["implicit", ""],
			["context", "tools: read\ninheritProjectContext: true"],
			["skills", "tools: read\ninheritSkills: true"],
			["memory", "tools: read\nmemory:\n  scope: project\n  path: notes"],
			["reads", "tools: read\ndefaultReads: README.md"],
		] as const) {
			const cwd = path.join(root, name); setup(cwd);
			fs.writeFileSync(path.join(cwd, ".pi", "agents", "worker.md"), `---\nname: bound-worker\ndescription: Bound worker\n${frontmatter}\n---\nPrompt.\n`);
			assert.deepEqual(resolveActiveBoundLaunchContract(input(cwd)), { ok: false, code: "unsupported_mode" });
		}

		const refined = path.join(root, "refined"); setup(refined);
		const refinement = getAgentRefinementPath(refined, "bound-worker");
		fs.mkdirSync(path.dirname(refinement), { recursive: true }); fs.writeFileSync(refinement, "refinement");
		assert.deepEqual(resolveActiveBoundLaunchContract(input(refined)), { ok: false, code: "unsupported_mode" });

		const custom = path.join(root, "custom"); setup(custom);
		const external = path.join(root, "external", "remote-skill"); fs.mkdirSync(external, { recursive: true });
		fs.writeFileSync(path.join(external, "SKILL.md"), "---\ndescription: remote\n---\nRemote.\n");
		fs.writeFileSync(path.join(custom, ".pi", "settings.json"), JSON.stringify({ skills: [path.dirname(external)] }));
		assert.deepEqual(resolveActiveBoundLaunchContract(input(custom, request(custom, { skill: ["remote-skill"] }))), { ok: false, code: "unsupported_mode" });
	});

	it("binds effective agent/runtime defaults and policy", () => {
		const cwd = path.join(root, "defaults"); setup(cwd);
		const agent = path.join(cwd, ".pi", "agents", "worker.md");
		fs.writeFileSync(agent, "---\nname: bound-worker\ndescription: Bound worker\ntools: read\ntimeoutMs: 10\nturnBudget: {\"maxTurns\":4}\ntoolBudget: {\"hard\":2}\n---\nPrompt.\n");
		const result = resolveActiveBoundLaunchContract({
			...input(cwd, request(cwd, { skill: false })),
			runtimePolicy: { foregroundTimeoutMs: 99, waitToolEnabled: false, maxSubagentDepth: 1, permissions: { read: "allow" } as never },
		});
		assert.equal(result.ok, true);
		assert.equal(result.contract.timeoutMs, 10);
		assert.deepEqual(result.contract.turnBudget, { maxTurns: 4, graceTurns: 1 });
		assert.deepEqual(result.contract.toolBudget, { hard: 2, block: ["read", "grep", "find", "ls"] });
		assert.equal(result.contract.policy.waitToolEnabled, false);
		assert.equal(result.contract.policy.permissionsDigest, undefined);
	});

	it("binds effective permission and child-depth policy without ambient depth env", () => {
		const cwd = path.join(root, "effective-policy"); setup(cwd);
		fs.writeFileSync(path.join(cwd, ".pi", "agents", "worker.md"), "---\nname: bound-worker\ndescription: Bound worker\ntools: read\nmaxSubagentDepth: 0\npermissions:\n  read: deny\n---\nPrompt.\n");
		const previousDepth = process.env.PI_SUBAGENT_MAX_DEPTH;
		process.env.PI_SUBAGENT_MAX_DEPTH = "7";
		const result = resolveActiveBoundLaunchContract({
			...input(cwd, request(cwd, { skill: false })),
			runtimePolicy: { foregroundTimeoutMs: 99, waitToolEnabled: false, maxSubagentDepth: 5, permissions: { rules: { read: "ask" } } },
		});
		if (previousDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH; else process.env.PI_SUBAGENT_MAX_DEPTH = previousDepth;
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.contract.policy.maxSubagentDepth, 0);
		assert.deepEqual(resolveActiveBoundLaunchContract({ ...input(cwd, request(cwd, { skill: false })), runtimePolicy: { foregroundTimeoutMs: 99, waitToolEnabled: false, maxSubagentDepth: 0 } }), { ok: false, code: "restricted_agent" });
		assert.equal(result.contract.policy.permissionsDigest, canonicalSha256({ read: "deny" }));
	});

	it("enforces model scope, timer bounds, fixed watchdog policy and exact parent-session roots", () => {
		const scoped = path.join(root, "scoped"); setup(scoped);
		fs.writeFileSync(path.join(scoped, ".pi", "settings.json"), JSON.stringify({ subagents: { modelScope: { enforce: true, allow: ["allowed/*"] } } }));
		assert.deepEqual(resolveActiveBoundLaunchContract(input(scoped)), { ok: false, code: "unavailable_model" });

		const timeout = path.join(root, "timeout"); setup(timeout);
		fs.writeFileSync(path.join(timeout, ".pi", "agents", "worker.md"), "---\nname: bound-worker\ndescription: Bound worker\ntools: read\ntimeoutMs: 2147483648\n---\nPrompt.\n");
		assert.deepEqual(resolveActiveBoundLaunchContract(input(timeout)), { ok: false, code: "unsupported_mode" });

		const watched = path.join(root, "watched"); setup(watched);
		const before = resolveActiveBoundLaunchContract(input(watched)); assert.equal(before.ok, true);
		fs.writeFileSync(path.join(watched, ".pi", "settings.json"), JSON.stringify({ subagents: { watchdog: { enabled: true, children: { enabled: true } } } }));
		const after = resolveActiveBoundLaunchContract(input(watched)); assert.equal(after.ok, true);
		assert.equal(after.contract.digest, before.contract.digest);
		assert.equal(after.contract.policy.watchdog, false);

		const firstScopeDigest = after.contract.policy.modelScopeDigest;
		fs.writeFileSync(path.join(watched, ".pi", "settings.json"), JSON.stringify({ subagents: { modelScope: { enforce: true, allow: ["test/*"] } } }));
		const scopedAgain = resolveActiveBoundLaunchContract(input(watched)); assert.equal(scopedAgain.ok, true);
		assert.notEqual(scopedAgain.contract.policy.modelScopeDigest, firstScopeDigest);
		assert.notEqual(scopedAgain.contract.digest, after.contract.digest);

		const linkedRoot = path.join(root, "linked-session-root");
		const targetRoot = path.join(root, "real-session-root"); fs.mkdirSync(targetRoot); fs.symlinkSync(targetRoot, linkedRoot, "dir");
		assert.deepEqual(resolveActiveBoundLaunchContract({ ...input(watched), defaultSessionDir: linkedRoot }), { ok: false, code: "host_required" });
		const safeBase = path.join(root, "safe-base"); const outside = path.join(root, "outside-base"); fs.mkdirSync(safeBase); fs.mkdirSync(outside);
		fs.symlinkSync(outside, path.join(safeBase, request(watched).prospectiveRunId), "dir");
		assert.deepEqual(resolveActiveBoundLaunchContract({ ...input(watched), defaultSessionDir: safeBase }), { ok: false, code: "host_required" });

		const session = path.join(root, "session-extension"); setup(session);
		const sessionFile = path.join(root, "sessions", "parent.session");
		const sessionResult = resolveActiveBoundLaunchContract({ ...input(session), defaultSessionDir: undefined, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "pi-session" } });
		assert.equal(sessionResult.ok, true);
		assert.equal(sessionResult.contract.roots.sessionRootDigest, canonicalSha256(path.join(root, "sessions", "parent.session", sessionResult.contract.prospectiveRunId)));
		assert.equal(JSON.stringify(sessionResult.contract).includes("parent.session"), false);
	});

	it("resolves a regular flat project skill", () => {
		const cwd = path.join(root, "flat-skill"); setup(cwd);
		fs.rmSync(path.join(cwd, ".pi", "skills", "bound-skill"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "skills", "bound-skill.md"), "---\ndescription: flat skill\n---\nFlat.\n");
		const result = resolveActiveBoundLaunchContract(input(cwd));
		assert.equal(result.ok, true);
		assert.equal(result.contract.skills[0]?.name, "bound-skill");
	});

	it("rejects project skill symlinks that escape the owned roots", () => {
		const cwd = path.join(root, "symlink-skill"); setup(cwd);
		const external = path.join(root, "external-skill"); fs.mkdirSync(external, { recursive: true });
		fs.writeFileSync(path.join(external, "SKILL.md"), "---\ndescription: external\n---\nExternal.\n");
		fs.symlinkSync(external, path.join(cwd, ".pi", "skills", "linked"), "dir");
		assert.deepEqual(resolveActiveBoundLaunchContract(input(cwd, request(cwd, { skill: ["linked"] }))), { ok: false, code: "missing_skill" });
		const localReal = path.join(cwd, ".pi", "skills", "local-real"); fs.mkdirSync(localReal, { recursive: true });
		fs.writeFileSync(path.join(localReal, "SKILL.md"), "---\ndescription: local\n---\nLocal.\n");
		fs.symlinkSync("local-real", path.join(cwd, ".pi", "skills", "local-link"), "dir");
		assert.deepEqual(resolveActiveBoundLaunchContract(input(cwd, request(cwd, { skill: ["local-link"] }))), { ok: false, code: "missing_skill" });
	});

	it("rejects a mixed agent snapshot when bytes change during discovery", () => {
		const cwd = path.join(root, "agent-race"); const files = setup(cwd);
		const stale = discoverAgents(cwd, "both");
		let calls = 0;
		const result = resolveActiveBoundLaunchContract({
			...input(cwd),
			discover: ((discoveryCwd: string, scope: "user" | "project" | "both") => {
				calls++;
				if (calls === 1) {
					fs.writeFileSync(files.agent, "---\nname: bound-worker\ndescription: Bound worker\ntools: read\nskills: bound-skill\n---\nChanged prompt.\n");
					return stale;
				}
				return discoverAgents(discoveryCwd, scope);
			}) as typeof discoverAgents,
		});
		assert.deepEqual(result, { ok: false, code: "unsupported_mode" });
	});

	it("rereads direct agent and skill bytes even when mtimes are restored", () => {
		const cwd = path.join(root, "repo"); const files = setup(cwd);
		const before = resolveActiveBoundLaunchContract(input(cwd)); assert.equal(before.ok, true);
		const agentStat = fs.statSync(files.agent); const skillStat = fs.statSync(files.skill);
		const agentBytes = fs.readFileSync(files.agent, "utf8").replace("Bound prompt", "Other prompt");
		const skillBytes = fs.readFileSync(files.skill, "utf8").replace("bound skill", "fresh skill").replace("Use it.", "Changed");
		fs.writeFileSync(files.agent, agentBytes); fs.writeFileSync(files.skill, skillBytes);
		fs.utimesSync(files.agent, agentStat.atime, agentStat.mtime); fs.utimesSync(files.skill, skillStat.atime, skillStat.mtime);
		const after = resolveActiveBoundLaunchContract(input(cwd)); assert.equal(after.ok, true);
		assert.notEqual(after.contract.agent.fileContentDigest, before.contract.agent.fileContentDigest);
		assert.notEqual(after.contract.skills[0]!.contentDigest, before.contract.skills[0]!.contentDigest);
		assert.notEqual(after.contract.digest, before.contract.digest);
		const withoutCacheReset = after.contract.digest;
		clearSkillCache();
		const afterReset = resolveActiveBoundLaunchContract(input(cwd)); assert.equal(afterReset.ok, true);
		assert.equal(afterReset.contract.digest, withoutCacheReset);
	});
});
