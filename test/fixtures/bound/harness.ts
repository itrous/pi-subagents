import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearAgentDiscoveryCache } from "../../../src/agents/agents.ts";
import { clearSkillCache } from "../../../src/agents/skills.ts";
import type { BoundLayerManifestV2 } from "../../../src/bound/bound-layer-manifest.ts";
import type { PiRuntimeAttestationV1 } from "../../../src/bound/pi-runtime-attestation.ts";
import type { RuntimeBuiltinProjectionV1 } from "../../../src/bound/bound-tool-registry-projection.ts";
import { canonicalSha256 } from "../../../src/shared/canonical-json.ts";
import type { ExtensionConfig } from "../../../src/shared/types.ts";
import type { ModelInfo } from "../../../src/shared/model-info.ts";
import { createSourceIdentity, type ActiveRuntimeSourceIdentityResolution } from "../../../src/extension/source-identity.ts";

export const FIXTURE_SERVER_INSTANCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const FIXTURE_PROSPECTIVE_RUN_ID = "123e4567-e89b-12d3-a456-426614174000";
export const FIXTURE_SOURCE_COMMIT = "0".repeat(40);

const MANAGED_ENV = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_EXTRA_AGENT_DIRS", "PI_OFFLINE", "PI_SUBAGENT_DEPTH"] as const;

/** Fixed attestation values: the golden contract must not move with a real Pi install. */
export const FIXTURE_PI_RUNTIME: PiRuntimeAttestationV1 = {
	name: "@earendil-works/pi-coding-agent",
	version: "0.85.1",
	packageRootDigest: "1".repeat(64),
	filesDigest: "2".repeat(64),
	fileCount: 1056,
};

export const FIXTURE_RUNTIME_BUILTINS: RuntimeBuiltinProjectionV1 = (() => {
	const base = { version: 1 as const, names: ["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"] };
	return { ...base, digest: canonicalSha256(base) };
})();

export const FIXTURE_LAYER_MANIFEST: BoundLayerManifestV2 = {
	version: 2,
	entries: [
		{ name: "bound/index.ts", contentDigest: "3".repeat(64) },
		{ name: "bound/bound-resolver.ts", contentDigest: "4".repeat(64) },
	],
};

export const FIXTURE_MODELS: ModelInfo[] = [
	{ provider: "openai", id: "gpt-5", fullId: "openai/gpt-5", api: "openai-responses", reasoning: true, thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high" } },
];

/** Source identity is Linux-only upstream, so every test injects it through this seam. */
export function fixtureSourceIdentity(available = true): ActiveRuntimeSourceIdentityResolution {
	return available
		? { available: true, sourceIdentity: createSourceIdentity(FIXTURE_SOURCE_COMMIT) }
		: { available: false, sourceIdentityUnavailable: { version: 1, reasonCode: "unverified_source" } };
}

export interface FixtureContextLike {
	cwd: string;
	sessionManager: { getSessionFile(): string | null; getSessionId(): string | null };
	modelRegistry: { getAvailable(): ModelInfo[] };
	hasUI: boolean;
}

export interface BoundFixture {
	tempRoot: string;
	home: string;
	project: string;
	sessionDir: string;
	agentPath: string;
	skillPath: string;
	config: ExtensionConfig;
	sessionManager: { getSessionFile(): string | null; getSessionId(): string | null };
	request(overrides?: Record<string, unknown>): Record<string, unknown>;
	context(): FixtureContextLike;
	serviceOptions(overrides?: Record<string, unknown>): Record<string, unknown>;
	writeAgent(body: string): void;
	writeSkill(body: string): void;
	cleanup(): void;
}

const AGENT_DEFINITION = [
	"---",
	"name: reviewer",
	"description: Reviews a diff.",
	"tools: read",
	"inheritProjectContext: false",
	"inheritSkills: false",
	"inheritGlobalContext: false",
	"skills: review-notes",
	"---",
	"",
	"You review the supplied diff and report findings.",
	"",
].join("\n");

const SKILL_DEFINITION = [
	"---",
	"name: review-notes",
	"description: How to phrase review findings.",
	"---",
	"",
	"Phrase every finding as an observation.",
	"",
].join("\n");

export function createBoundFixture(): BoundFixture {
	// The resolver refuses a symlinked path prefix; on darwin os.tmpdir() is /var -> /private/var.
	const tempRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-bound-fixture-"));
	const home = path.join(tempRoot, "home");
	const project = path.join(tempRoot, "project");
	const sessionDir = path.join(tempRoot, "sessions");
	const agentPath = path.join(project, ".pi", "agents", "reviewer.md");
	const skillPath = path.join(project, ".pi", "skills", "review-notes", "SKILL.md");
	const previous: Record<string, string | undefined> = {};
	for (const name of MANAGED_ENV) previous[name] = process.env[name];
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
	process.env.PI_OFFLINE = "true";
	delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
	delete process.env.PI_SUBAGENT_DEPTH;
	fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	fs.mkdirSync(sessionDir, { recursive: true });
	fs.mkdirSync(path.dirname(agentPath), { recursive: true });
	fs.mkdirSync(path.dirname(skillPath), { recursive: true });
	fs.writeFileSync(agentPath, AGENT_DEFINITION, "utf8");
	fs.writeFileSync(skillPath, SKILL_DEFINITION, "utf8");
	clearAgentDiscoveryCache();
	clearSkillCache();
	return {
		tempRoot, home, project, sessionDir, agentPath, skillPath,
		config: { defaultSessionDir: sessionDir, maxSubagentDepth: 1 },
		sessionManager: {
			getSessionFile: () => path.join(sessionDir, "parent.jsonl"),
			getSessionId: () => "parent-session-id",
		},
		request(overrides: Record<string, unknown> = {}) {
			return {
				version: 2,
				targetServerInstanceId: FIXTURE_SERVER_INSTANCE_ID,
				requestId: "request-1",
				ownerRunId: "owner-1",
				nodeId: "node-1",
				prospectiveRunId: FIXTURE_PROSPECTIVE_RUN_ID,
				agent: "reviewer",
				task: "Review the diff.",
				cwd: fs.realpathSync(project),
				context: "fresh",
				model: "openai/gpt-5",
				thinking: "medium",
				artifacts: false,
				result: { kind: "text" },
				...overrides,
			};
		},
		context() {
			return {
				cwd: fs.realpathSync(project),
				sessionManager: {
					getSessionFile: () => path.join(sessionDir, "parent.jsonl"),
					getSessionId: () => "parent-session-id",
				},
				modelRegistry: { getAvailable: () => FIXTURE_MODELS },
				hasUI: false,
			};
		},
		serviceOptions(overrides: Record<string, unknown> = {}) {
			const self = this as BoundFixture;
			return {
				serverInstanceId: FIXTURE_SERVER_INSTANCE_ID,
				getContext: () => self.context(),
				config: self.config,
				waitToolEnabled: false,
				resolveCapabilityCeiling: () => undefined,
				resolveSourceIdentity: () => fixtureSourceIdentity(),
				attestRuntime: async () => ({ ok: true as const, runtime: { attestation: FIXTURE_PI_RUNTIME, runtimeBuiltins: FIXTURE_RUNTIME_BUILTINS, packageRoot: "/fixture/pi" } }),
				layerManifest: () => FIXTURE_LAYER_MANIFEST,
				...overrides,
			};
		},
		writeAgent(body: string) { fs.writeFileSync(agentPath, body, "utf8"); clearAgentDiscoveryCache(); clearSkillCache(); },
		writeSkill(body: string) { fs.writeFileSync(skillPath, body, "utf8"); clearAgentDiscoveryCache(); clearSkillCache(); },
		cleanup() {
			clearAgentDiscoveryCache();
			clearSkillCache();
			for (const name of MANAGED_ENV) {
				const value = previous[name];
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			fs.rmSync(tempRoot, { recursive: true, force: true });
		},
	};
}
