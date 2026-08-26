import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverAgents } from "../../src/agents/agents.ts";
import { computeMcpServerHash } from "../../src/runs/shared/mcp-direct-tool-allowlist.ts";
import {
	TOOL_BUDGET_ENV,
	TOOL_BUDGET_ZERO_AUTH_ENV,
} from "../../src/runs/shared/tool-budget.ts";
import { WAIT_TOOL_ENABLED_ENV } from "../../src/runs/background/wait-config.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../src/shared/utils.ts";
import {
	CHILD_TOOL_DIAGNOSTIC_PATH_ENV,
	MCP_DIRECT_CHILD_TOOLS_ENV,
	REQUIRED_CHILD_TOOLS_ENV,
} from "../../src/runs/shared/tool-availability.ts";
import { CHILD_WATCHDOG_CONFIG_ENV } from "../../src/watchdog/child-status.ts";
import {
	PERMISSION_AUDIT_PATH_ENV,
	PERMISSION_POLICY_ENV,
} from "../../src/runs/shared/permissions.ts";
import {
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_PATH_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
	SUBAGENT_PARENT_SESSION_ENV,
	SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
	SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
	SUBAGENT_RUN_ID_ENV,
	PI_INTERCOM_STABLE_ID_ENV,
	PI_INTERCOM_SESSION_ID_ENV,
	applyThinkingSuffix,
	attestBoundRuntimeExtensions,
	buildPiArgs,
	projectLaunchResolvedChildExtensions,
	resolvePiLaunchToolPlan,
} from "../../src/runs/shared/pi-args.ts";

const originalEnv = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	PI_SUBAGENT_FANOUT_CHILD: process.env.PI_SUBAGENT_FANOUT_CHILD,
	PI_SUBAGENT_PARENT_EVENT_SINK: process.env.PI_SUBAGENT_PARENT_EVENT_SINK,
	PI_SUBAGENT_PARENT_CONTROL_INBOX:
		process.env.PI_SUBAGENT_PARENT_CONTROL_INBOX,
	PI_SUBAGENT_PARENT_ROOT_RUN_ID: process.env.PI_SUBAGENT_PARENT_ROOT_RUN_ID,
	PI_SUBAGENT_PARENT_RUN_ID: process.env.PI_SUBAGENT_PARENT_RUN_ID,
	PI_SUBAGENT_PARENT_CHILD_INDEX: process.env.PI_SUBAGENT_PARENT_CHILD_INDEX,
	PI_SUBAGENT_PARENT_DEPTH: process.env.PI_SUBAGENT_PARENT_DEPTH,
	PI_SUBAGENT_PARENT_PATH: process.env.PI_SUBAGENT_PARENT_PATH,
	PI_SUBAGENT_PARENT_CAPABILITY_TOKEN:
		process.env.PI_SUBAGENT_PARENT_CAPABILITY_TOKEN,
	PI_SUBAGENT_PARENT_SESSION: process.env.PI_SUBAGENT_PARENT_SESSION,
	PI_SUBAGENT_RUN_ID: process.env.PI_SUBAGENT_RUN_ID,
	[MCP_DIRECT_CHILD_TOOLS_ENV]: process.env[MCP_DIRECT_CHILD_TOOLS_ENV],
	[TOOL_BUDGET_ZERO_AUTH_ENV]: process.env[TOOL_BUDGET_ZERO_AUTH_ENV],
	[PI_CODING_AGENT_PACKAGE_ROOT_ENV]:
		process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV],
	[PI_INTERCOM_STABLE_ID_ENV]: process.env[PI_INTERCOM_STABLE_ID_ENV],
	[PI_INTERCOM_SESSION_ID_ENV]: process.env[PI_INTERCOM_SESSION_ID_ENV],
	MCP_HASH_ROOT: process.env.MCP_HASH_ROOT,
	MCP_HASH_TOKEN: process.env.MCP_HASH_TOKEN,
};
const originalCwd = process.cwd();
const tempRoots: string[] = [];

interface McpFixture {
	root: string;
	agentDir: string;
	projectDir: string;
}

function createMcpFixture(): McpFixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-mcp-"));
	tempRoots.push(root);
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".pi", "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.chdir(projectDir);
	return { root, agentDir, projectDir };
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeMcpFixture(
	fixture: McpFixture,
	options: {
		serverName?: string;
		definition?: Record<string, unknown>;
		settings?: Record<string, unknown>;
		tools?: Array<{ name: string; description?: string }>;
		resources?: Array<{ name: string; uri: string; description?: string }>;
		configPath?: string;
		cachedAt?: number;
		configHash?: string;
	} = {},
): void {
	const serverName = options.serverName ?? "chrome-devtools";
	const definition = {
		command: "npx",
		args: ["chrome-devtools-mcp"],
		...(options.definition ?? {}),
	};
	writeJson(options.configPath ?? path.join(fixture.agentDir, "mcp.json"), {
		...(options.settings ? { settings: options.settings } : {}),
		mcpServers: {
			[serverName]: definition,
		},
	});
	writeJson(path.join(fixture.agentDir, "mcp-cache.json"), {
		version: 1,
		servers: {
			[serverName]: {
				configHash: options.configHash ?? computeMcpServerHash(definition),
				cachedAt: options.cachedAt ?? Date.now(),
				tools: options.tools ?? [
					{ name: "take_screenshot" },
					{ name: "click" },
				],
				resources: options.resources ?? [],
			},
		},
	});
}

afterEach(() => {
	process.chdir(originalCwd);
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("buildPiArgs session wiring", () => {
	it("projects launch-resolved extension identifiers without raw paths", () => {
		const privateExt = path.join(
			os.tmpdir(),
			"private-extension-root",
			"secret-extension.ts",
		);
		const toolExt = path.join(
			os.tmpdir(),
			"tool-extension-root",
			"tool-extension.ts",
		);
		const plan = resolvePiLaunchToolPlan({
			tools: ["read", toolExt],
			extensions: [privateExt],
			subagentOnlyExtensions: ["package-extension"],
		});

		const projection = projectLaunchResolvedChildExtensions(plan);

		assert.equal(projection.version, 1);
		assert.equal(projection.source, "launch-resolved");
		assert.equal(projection.disableAmbientExtensions, true);
		assert.ok(
			projection.runtime.length >= 1,
			`expected at least 1 runtime extension, got ${projection.runtime.length}`,
		);
		assert.equal(projection.configured.length, 3);
		assert.ok(
			projection.effective.length >= 4,
			`expected at least 4 effective extensions, got ${projection.effective.length}`,
		);
		for (const id of [
			...projection.runtime,
			...projection.configured,
			...projection.effective,
		]) {
			assert.match(id, /^sha256:[a-f0-9]{16}$/);
		}
		assert.ok(
			!JSON.stringify(projection).includes(os.tmpdir()),
			"projection should not expose raw extension paths",
		);
	});

	it("uses --session when sessionFile is provided", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-session-"));
		try {
			const sessionFile = path.join(tempDir, "nested", "session.jsonl");
			const { args } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: true,
				sessionFile,
				sessionDir: "/tmp/should-not-be-used",
				inheritProjectContext: false,
				inheritSkills: false,
			});

			assert.ok(args.includes("--session"));
			assert.ok(args.includes(sessionFile));
			assert.ok(fs.existsSync(path.dirname(sessionFile)));
			assert.ok(
				!args.includes("--session-dir"),
				"--session-dir should not be emitted with --session",
			);
			assert.ok(
				!args.includes("--no-session"),
				"--no-session should not be emitted with --session",
			);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps fresh mode behavior (sessionDir + no session file)", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: true,
			sessionDir: "/tmp/subagent-sessions",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--session-dir"));
		assert.ok(args.includes("/tmp/subagent-sessions"));
		assert.ok(!args.includes("--session"));
	});

	it("emits explicit parent session env for permission forwarding", () => {
		process.env.PI_SUBAGENT_PARENT_SESSION = "inherited-parent";
		const { env } = buildPiArgs({
			parentSessionId: "direct-parent",
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.equal(env[SUBAGENT_PARENT_SESSION_ENV], "direct-parent");
	});

	it("falls back to inherited parent session env for permission forwarding", () => {
		process.env.PI_SUBAGENT_PARENT_SESSION = "inherited-parent";
		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.equal(env[SUBAGENT_PARENT_SESSION_ENV], "inherited-parent");
	});

	it("passes the effective wait-tool setting explicitly to children", () => {
		assert.equal(
			buildPiArgs({
				baseArgs: [],
				task: "test",
				sessionEnabled: false,
				inheritProjectContext: true,
				inheritSkills: true,
				waitToolEnabled: false,
			}).env[WAIT_TOOL_ENABLED_ENV],
			"false",
		);
		assert.equal(
			buildPiArgs({
				baseArgs: [],
				task: "test",
				sessionEnabled: false,
				inheritProjectContext: true,
				inheritSkills: true,
				waitToolEnabled: true,
			}).env[WAIT_TOOL_ENABLED_ENV],
			"true",
		);
	});

	it("passes child watchdog config only when explicitly provided", () => {
		const withoutWatchdog = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
		});
		assert.equal(withoutWatchdog.env[CHILD_WATCHDOG_CONFIG_ENV], undefined);

		const withWatchdog = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			childWatchdog: {
				enabled: true,
				runId: "run-1",
				agent: "worker",
				childIndex: 2,
				watchdogTailTimeoutMs: 1234,
				agentEndTimeoutMs: 500,
				maxWarnings: 1,
				lsp: { enabled: false, timeoutMs: 50, maxFiles: 2, maxDiagnostics: 3 },
				autoFollowBlockers: true,
				autoFollowMaxAttempts: 3,
				stalemateRepeats: 2,
			},
		});
		const encoded = withWatchdog.env[CHILD_WATCHDOG_CONFIG_ENV];
		assert.equal(typeof encoded, "string");
		assert.deepEqual(JSON.parse(encoded ?? "{}"), {
			enabled: true,
			runId: "run-1",
			agent: "worker",
			childIndex: 2,
			watchdogTailTimeoutMs: 1234,
			agentEndTimeoutMs: 500,
			maxWarnings: 1,
			lsp: { enabled: false, timeoutMs: 50, maxFiles: 2, maxDiagnostics: 3 },
			autoFollowBlockers: true,
			autoFollowMaxAttempts: 3,
			stalemateRepeats: 2,
		});
	});
});

describe("buildPiArgs model wiring", () => {
	it("uses --model for provider-qualified model ids", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model: "openai-codex/gpt-5.4-mini",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--model"));
		assert.ok(args.includes("openai-codex/gpt-5.4-mini"));
		assert.ok(!args.includes("--models"));
	});

	it("uses --model for bare model ids too", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model: "kimi-k2.5",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--model"));
		assert.ok(args.includes("kimi-k2.5"));
		assert.ok(!args.includes("--models"));
	});

	it("preserves thinking suffixes on model args", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model: "openai-codex/gpt-5.4-mini",
			thinking: "high",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.equal(
			applyThinkingSuffix("openai-codex/gpt-5.4-mini", "high"),
			"openai-codex/gpt-5.4-mini:high",
		);
		assert.ok(args.includes("--model"));
		assert.ok(args.includes("openai-codex/gpt-5.4-mini:high"));
	});

	it("passes max thinking through to the model argument", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			model: "openai/gpt-5",
			thinking: "max",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.equal(
			applyThinkingSuffix("openai/gpt-5", "max"),
			"openai/gpt-5:max",
		);
		assert.equal(
			applyThinkingSuffix("openai/gpt-5:max", "high"),
			"openai/gpt-5:max",
		);
		assert.equal(
			applyThinkingSuffix("openai/gpt-5:max", "high", true),
			"openai/gpt-5:high",
		);
		assert.ok(args.includes("--model"));
		assert.ok(args.includes("openai/gpt-5:max"));
	});

	it("passes explicit thinking off through to the model arg", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model: "anthropic/claude-haiku-4-5",
			thinking: "off",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.equal(
			applyThinkingSuffix("anthropic/claude-haiku-4-5", "off"),
			"anthropic/claude-haiku-4-5:off",
		);
		assert.equal(
			applyThinkingSuffix("anthropic/claude-haiku-4-5:high", "off", true),
			"anthropic/claude-haiku-4-5:off",
		);
		assert.ok(args.includes("--model"));
		assert.ok(args.includes("anthropic/claude-haiku-4-5:off"));
	});

	it("does not append a thinking suffix for boolean false", () => {
		const model = "glm-5.2-short-fast";
		const once = applyThinkingSuffix(model, false);
		assert.equal(once, model);
		assert.equal(applyThinkingSuffix(once, false), model);

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model,
			thinking: false,
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--model"));
		assert.ok(args.includes(model));
		assert.ok(!args.some((arg) => arg.includes(":false")));
	});

	it("leaves provider-specific model suffixes untouched when thinking is disabled", () => {
		const model = "openai-compatible/qwen2.5-coder:7b";
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model,
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--model"));
		assert.ok(args.includes(model));
		assert.ok(!args.includes(`${model}:high`));
	});
});

describe("buildPiArgs system prompt mode wiring", () => {
	it("uses --append-system-prompt by default", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			systemPrompt: "You are a worker",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--append-system-prompt"));
		assert.ok(!args.includes("--system-prompt"));
	});

	it("uses --system-prompt when systemPromptMode=replace", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			systemPrompt: "You are a worker",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--system-prompt"));
		assert.ok(!args.includes("--append-system-prompt"));
	});

	it("injects the subagent prompt runtime extension and env flags", () => {
		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: true,
		});

		const extensionArgs = args.filter(
			(arg, index) => args[index - 1] === "--extension",
		);
		assert.ok(
			extensionArgs.some((arg) =>
				arg.endsWith(
					path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"),
				),
			),
		);
		assert.ok(args.includes("--no-context-files"));
		assert.equal(env.PI_SUBAGENT_CHILD, "1");
		assert.equal(env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT, "0");
		assert.equal(env.PI_SUBAGENT_INHERIT_SKILLS, "1");
	});

	it("keeps context file loading enabled when project context is inherited", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: true,
			inheritSkills: true,
		});

		assert.equal(args.includes("--no-context-files"), false);
	});

	it("passes tool budget through env", () => {
		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			toolBudget: { soft: 2, hard: 3, block: ["read"] },
		});

		assert.deepEqual(JSON.parse(env[TOOL_BUDGET_ENV] ?? "{}"), {
			soft: 2,
			hard: 3,
			block: ["read"],
		});
		assert.equal(env[TOOL_BUDGET_ZERO_AUTH_ENV], undefined);
	});

	it("clears inherited zero tool-budget authorization unless this launch owns it", () => {
		process.env[TOOL_BUDGET_ZERO_AUTH_ENV] = "1";
		const inherited = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			toolBudget: { hard: 1, block: ["read"] },
		});
		assert.equal(inherited.env[TOOL_BUDGET_ZERO_AUTH_ENV], undefined);

		const owned = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			toolBudget: { hard: 0, block: "*" },
			allowZeroToolBudget: true,
		});
		assert.equal(owned.env[TOOL_BUDGET_ZERO_AUTH_ENV], "1");
	});

	it("clears inherited MCP direct-tool metadata for non-MCP launches", () => {
		for (const staleValue of [JSON.stringify(["fixture_search"]), "not-json"]) {
			process.env[MCP_DIRECT_CHILD_TOOLS_ENV] = staleValue;
			const { env } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritSkills: false,
				tools: ["read", "fixture_search"],
			});

			assert.equal(env[MCP_DIRECT_CHILD_TOOLS_ENV], undefined);
		}
	});

	it("passes child intercom and orchestrator metadata through env", () => {
		process.env[PI_INTERCOM_STABLE_ID_ENV] = "subagent-chat-parent";
		process.env[PI_INTERCOM_SESSION_ID_ENV] = "session-parent-runtime";
		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: true,
			inheritSkills: true,
			intercomSessionName: "subagent-worker-78f659a3",
			orchestratorIntercomTarget: "subagent-chat-parent",
			parentSessionId: "session-parent-123",
			runId: "78f659a3",
			childAgentName: "worker",
			childIndex: 2,
		});

		assert.equal(
			env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
			"subagent-worker-78f659a3",
		);
		assert.equal(env[PI_INTERCOM_STABLE_ID_ENV], "subagent-worker-78f659a3");
		assert.equal(env[PI_INTERCOM_SESSION_ID_ENV], undefined);
		assert.equal(env.PI_SUBAGENT_ORCHESTRATOR_TARGET, "subagent-chat-parent");
		assert.equal(
			env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV],
			"session-parent-123",
		);
		assert.equal(env.PI_SUBAGENT_RUN_ID, "78f659a3");
		assert.equal(env.PI_SUBAGENT_CHILD_AGENT, "worker");
		assert.equal(env.PI_SUBAGENT_CHILD_INDEX, "2");
		assert.equal(typeof env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV], "string");
		assert.match(
			env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] ?? "",
			/supervisor-channels/,
		);
	});

	it("clears inherited pi-intercom identity when no child intercom session name is set", () => {
		process.env[PI_INTERCOM_STABLE_ID_ENV] = "subagent-chat-parent";
		process.env[PI_INTERCOM_SESSION_ID_ENV] = "session-parent-runtime";
		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: true,
			inheritSkills: true,
		});

		assert.equal(env[PI_INTERCOM_STABLE_ID_ENV], undefined);
		assert.equal(env[PI_INTERCOM_SESSION_ID_ENV], undefined);
	});

	it("creates a private permission audit path without enabling the supervisor channel", () => {
		const { env, tempDir } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: true,
			inheritSkills: true,
			parentSessionId: "session-parent-123",
			runId: "permission-run",
			childAgentName: "worker",
			childIndex: 3,
			permissionRules: { write: "ask" },
		});

		assert.equal(env.PI_SUBAGENT_ORCHESTRATOR_TARGET, undefined);
		assert.equal(env[PERMISSION_POLICY_ENV], JSON.stringify({ write: "ask" }));
		assert.equal(env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV], undefined);
		assert.equal(
			env[PERMISSION_AUDIT_PATH_ENV],
			path.join(tempDir!, "permission-audit.jsonl"),
		);
	});

	it("does not create a supervisor channel without an exact parent session id", () => {
		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: true,
			inheritSkills: true,
			orchestratorIntercomTarget: "subagent-chat-parent",
			runId: "78f659a3",
			childAgentName: "worker",
			childIndex: 2,
		});

		assert.equal(env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV], undefined);
		assert.equal(env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV], undefined);
	});

	it("emits explicit builtin tool allowlists", () => {
		const { args, env, toolDiagnosticPath } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: [
				"read",
				"grep",
				"find",
				"ls",
				"bash",
				"edit",
				"write",
				"contact_supervisor",
			],
		});

		const toolsArg = args[args.indexOf("--tools") + 1];
		assert.equal(
			toolsArg,
			"read,grep,find,ls,bash,edit,write,contact_supervisor",
		);
		assert.deepEqual(
			JSON.parse(env[REQUIRED_CHILD_TOOLS_ENV] ?? "[]"),
			toolsArg.split(","),
		);
		assert.equal(env[CHILD_TOOL_DIAGNOSTIC_PATH_ENV], toolDiagnosticPath);
	});

	it("launches the bundled reviewer without mutation-capable tools", () => {
		const reviewer = discoverAgents(process.cwd(), "project").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer, "expected bundled reviewer");
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "Review this change.",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: reviewer.tools,
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls,intercom");
		assert.doesNotMatch(args[args.indexOf("--tools") + 1] ?? "", /\b(?:bash|edit|write)\b/);
	});

	it("keeps structured_output available under explicit tool allowlists", () => {
		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "fixture_search"],
			structuredOutput: {
				schema: { type: "object", properties: {}, additionalProperties: false },
				schemaPath: "/tmp/schema.json",
				outputPath: "/tmp/output.json",
			},
		});

		assert.equal(
			args[args.indexOf("--tools") + 1],
			"read,fixture_search,structured_output",
		);
		assert.deepEqual(JSON.parse(env[REQUIRED_CHILD_TOOLS_ENV] ?? "[]"), [
			"read",
			"fixture_search",
			"structured_output",
		]);
		assert.throws(() => buildPiArgs({
			baseArgs: ["-p"], task: "hello", sessionEnabled: false, inheritProjectContext: false, inheritSkills: false,
			tools: ["structured_output"], activeBoundPackageMediator: true,
			structuredOutput: { schema: { type: "object" }, schemaPath: "/tmp/schema.json", outputPath: "/tmp/output.json" },
		}), /must not overlap/);
	});

	it("forwards the Pi package root to child processes for host peer resolution", () => {
		process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = "/opt/pi-coding-agent";
		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.equal(env[PI_CODING_AGENT_PACKAGE_ROOT_ENV], "/opt/pi-coding-agent");
	});

	it("adds read to explicit tool allowlists when skills must be loaded lazily", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			requireReadTool: true,
			tools: ["bash"],
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,bash");
	});

	it("does not duplicate read in explicit tool allowlists for lazy skills", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			requireReadTool: true,
			tools: ["read", "bash"],
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,bash");
	});

	it("includes adapter tool filters, request headers, and protocol version in MCP cache identity", () => {
		const base = { command: "npx", args: ["browser-mcp"] };

		assert.notEqual(
			computeMcpServerHash(base),
			computeMcpServerHash({ ...base, includeTools: ["browser_navigate"] }),
		);
		assert.notEqual(
			computeMcpServerHash(base),
			computeMcpServerHash({ ...base, protocolVersion: "2025-03-26" }),
		);
		assert.notEqual(
			computeMcpServerHash(base),
			computeMcpServerHash({ ...base, requestHeadersCommand: { command: "headers", args: ["--json"] } }),
		);
	});

	it("matches pi-mcp-adapter 2.26.1 metadata cache hashes", () => {
		process.env.MCP_HASH_ROOT = "/tmp/mcp-root";
		process.env.MCP_HASH_TOKEN = "token-value";

		assert.deepEqual(
			[
				computeMcpServerHash({
					command: "npx",
					args: ["-y", "browser-mcp"],
					env: { ROOT: "{env:MCP_HASH_ROOT}", SECRET_COMMAND: "!op read test" },
					cwd: "${MCP_HASH_ROOT}/server",
					exposeResources: false,
					includeTools: ["browser_navigate"],
					excludeTools: ["browser_close"],
				}),
				computeMcpServerHash({
					url: "https://example.test/$env:MCP_HASH_TOKEN",
					headers: {
						Authorization: "Bearer ${MCP_HASH_TOKEN}",
						Secret: "!op read test",
					},
					auth: "bearer",
					bearerTokenEnv: "MCP_HASH_TOKEN",
				}),
				computeMcpServerHash({ socket: "{env:MCP_HASH_ROOT}/rmcp.sock" }),
			],
			[
				"2c6d629872df1d4243906b17c57ebf688d8be0426e471bc2b0c956d952823c63",
				"d4a4e16e9f0a22fe1d7743c2483774d7dfc463431053fa124f9794c820fb1410",
				"592c6a094c7ba78133bffa5498e268e70dac7b9c450f9c23d9a46585a54edb50",
			],
		);
	});

	it("augments explicit builtin allowlists with selected direct MCP tool names", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture);

		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "bash"],
			mcpDirectTools: ["chrome-devtools"],
		});

		assert.equal(
			args[args.indexOf("--tools") + 1],
			"read,bash,chrome-devtools_take_screenshot,chrome-devtools_click",
		);
		assert.equal(env.MCP_DIRECT_TOOLS, "chrome-devtools");
		assert.equal(
			env[REQUIRED_CHILD_TOOLS_ENV],
			JSON.stringify([
				"read",
				"bash",
				"chrome-devtools_take_screenshot",
				"chrome-devtools_click",
			]),
		);
		assert.equal(
			env[MCP_DIRECT_CHILD_TOOLS_ENV],
			JSON.stringify([
				"chrome-devtools_take_screenshot",
				"chrome-devtools_click",
			]),
		);
	});

	it("resolves direct MCP tool selections from adapter-style protocol version cache entries", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture, {
			serverName: "github",
			definition: { command: "github-mcp", protocolVersion: "2025-03-26" },
			configHash: "e2be19d9c42c791c8c125397cc9a5c1b592effe15c422a7f7d5fbf2eb6397251",
			tools: [{ name: "search_repositories" }],
		});

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
			mcpDirectTools: ["github/search_repositories"],
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,github_search_repositories");
	});

	it("emits --no-tools for explicit empty tool allowlists", () => {
		for (const requireReadTool of [false, true]) {
			const { args, env } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritSkills: false,
				requireReadTool,
				tools: [],
			});

			assert.ok(args.includes("--no-tools"));
			assert.equal(args.includes("--tools"), false);
			assert.equal(env.MCP_DIRECT_TOOLS, "__none__");
		}
	});

	it("restricts MCP-only agents to selected direct MCP tool names", () => {
		for (const requireReadTool of [false, true]) {
			const fixture = createMcpFixture();
			writeMcpFixture(fixture);

			const { args, env } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritSkills: false,
				requireReadTool,
				mcpDirectTools: ["chrome-devtools"],
			});

			assert.equal(
				args[args.indexOf("--tools") + 1],
				"chrome-devtools_take_screenshot,chrome-devtools_click",
			);
			assert.equal(env.MCP_DIRECT_TOOLS, "chrome-devtools");
		}
	});

	it("fails closed with --no-tools when MCP-only names cannot be resolved", () => {
		for (const requireReadTool of [false, true]) {
			const fixture = createMcpFixture();
			writeJson(path.join(fixture.agentDir, "mcp.json"), {
				mcpServers: {
					"chrome-devtools": { command: "npx", args: ["chrome-devtools-mcp"] },
				},
			});

			const { args, env } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritSkills: false,
				requireReadTool,
				mcpDirectTools: ["chrome-devtools"],
			});

			assert.ok(args.includes("--no-tools"));
			assert.equal(args.includes("--tools"), false);
			assert.equal(env.MCP_DIRECT_TOOLS, "chrome-devtools");
		}
	});

	it("supports direct MCP server/tool filters", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture, {
			serverName: "github",
			definition: { command: "github-mcp" },
			tools: [{ name: "search_repositories" }, { name: "create_issue" }],
		});

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
			mcpDirectTools: ["github/search_repositories"],
		});

		assert.equal(
			args[args.indexOf("--tools") + 1],
			"read,github_search_repositories",
		);
	});

	it("matches adapter filtering, visibility, and punctuation", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture, {
			serverName: "git-hub",
			definition: { includeTools: ["foo-*"] },
			tools: [
				{ name: "foo-bar" },
				{ name: "foo.hidden", uiVisibility: ["app"] } as any,
				{ name: "blocked" },
			],
		});
		const { args } = buildPiArgs({
			baseArgs: ["-p"], task: "hello", sessionEnabled: false,
			inheritProjectContext: false, inheritSkills: false, tools: ["read"],
			mcpDirectTools: ["git-hub"],
		});
		assert.equal(args[args.indexOf("--tools") + 1], "read,git-hub_foo-bar");
	});

	it("supports non-colliding legacy adapter filter aliases", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture, {
			serverName: "git-hub",
			definition: { excludeTools: ["git_hub_foo_bar"] },
			tools: [{ name: "foo-bar" }],
		});
		const { args } = buildPiArgs({
			baseArgs: ["-p"], task: "hello", sessionEnabled: false,
			inheritProjectContext: false, inheritSkills: false, tools: ["read"], mcpDirectTools: ["git-hub"],
		});
		assert.equal(args[args.indexOf("--tools") + 1], "read");
	});

	it("does not apply a legacy alias that collides with another current tool", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture, {
			serverName: "git-hub",
			definition: { excludeTools: ["git-hub_foo_bar"] },
			tools: [{ name: "foo-bar" }, { name: "foo_bar" }],
		});
		const { args } = buildPiArgs({
			baseArgs: ["-p"], task: "hello", sessionEnabled: false,
			inheritProjectContext: false, inheritSkills: false, tools: ["read"], mcpDirectTools: ["git-hub"],
		});
		assert.equal(args[args.indexOf("--tools") + 1], "read,git-hub_foo-bar");
	});

	it("matches adapter prefix modes for direct MCP names", () => {
		for (const [prefix, expected] of [
			["server", "read,linear-mcp_list_issues"],
			["short", "read,linear_list_issues"],
			["none", "read,list_issues"],
			["mcp", "read,mcp__linear-mcp_list_issues"],
		] as const) {
			const fixture = createMcpFixture();
			writeMcpFixture(fixture, {
				serverName: "linear-mcp",
				settings: { toolPrefix: prefix },
				tools: [{ name: "list_issues" }],
			});

			const { args } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritSkills: false,
				tools: ["read"],
				mcpDirectTools: ["linear-mcp"],
			});

			assert.equal(args[args.indexOf("--tools") + 1], expected);
		}
	});

	it("includes resource tools and respects excludeTools", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture, {
			serverName: "browser-mcp",
			definition: { excludeTools: ["browser_click"] },
			tools: [{ name: "click" }, { name: "navigate" }],
			resources: [{ name: "Console Logs", uri: "resource://console" }],
		});

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
			mcpDirectTools: ["browser-mcp"],
		});

		assert.equal(
			args[args.indexOf("--tools") + 1],
			"read,browser-mcp_navigate,browser-mcp_read_console_logs",
		);
	});

	it("falls back to explicit builtins when direct MCP cache or config is missing or invalid", () => {
		const missingFixture = createMcpFixture();
		writeJson(path.join(missingFixture.agentDir, "mcp.json"), {
			mcpServers: {
				"chrome-devtools": { command: "npx", args: ["chrome-devtools-mcp"] },
			},
		});
		const missingCache = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "bash"],
			mcpDirectTools: ["chrome-devtools"],
		});
		assert.equal(
			missingCache.args[missingCache.args.indexOf("--tools") + 1],
			"read,bash",
		);

		const invalidFixture = createMcpFixture();
		writeMcpFixture(invalidFixture, {
			cachedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
		});
		const staleCache = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "bash"],
			mcpDirectTools: ["chrome-devtools"],
		});
		assert.equal(
			staleCache.args[staleCache.args.indexOf("--tools") + 1],
			"read,bash",
		);
	});

	it("resolves project MCP config from the child cwd and expands PI_CODING_AGENT_DIR", () => {
		const fixture = createMcpFixture();
		process.env.PI_CODING_AGENT_DIR = "~/.pi/agent";
		process.chdir(fixture.root);
		writeMcpFixture(fixture, {
			serverName: "project-mcp",
			configPath: path.join(fixture.projectDir, ".mcp.json"),
			tools: [{ name: "inspect" }],
		});

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
			mcpDirectTools: ["project-mcp"],
			cwd: fixture.projectDir,
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,project-mcp_inspect");
	});

	it("uses active-bound discovery cwd for MCP config while preserving child cwd", () => {
		const fixture = createMcpFixture(); const external = path.join(fixture.root, "external"); fs.mkdirSync(external);
		process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
		writeMcpFixture(fixture, { serverName: "active-mcp", configPath: path.join(fixture.projectDir, ".mcp.json"), tools: [{ name: "inspect" }] });
		writeJson(path.join(external, ".mcp.json"), { mcpServers: { attacker: { command: "false" } } });
		const { args } = buildPiArgs({ baseArgs: ["-p"], task: "hello", sessionEnabled: false, inheritProjectContext: false, inheritSkills: false, tools: ["read"], mcpDirectTools: ["active-mcp"], cwd: external, discoveryCwd: fixture.projectDir });
		assert.equal(args[args.indexOf("--tools") + 1], "read,active-mcp_inspect");
	});

	it("keeps selected tools when an unselected server has invalid cache identity", () => {
		const fixture = createMcpFixture();
		const good = { command: "good" };
		writeJson(path.join(fixture.agentDir, "mcp.json"), { mcpServers: { good, bad: { url: "${MISSING_URL}" } } });
		writeJson(path.join(fixture.agentDir, "mcp-cache.json"), { version: 1, servers: {
			good: { configHash: computeMcpServerHash(good), cachedAt: Date.now(), tools: [{ name: "t" }] },
			bad: { configHash: "invalid", cachedAt: Date.now(), tools: [{ name: "x" }] },
		} });
		const { args } = buildPiArgs({ baseArgs: ["-p"], task: "hello", sessionEnabled: false, inheritProjectContext: false, inheritSkills: false, tools: ["read"], mcpDirectTools: ["good"] });
		assert.equal(args[args.indexOf("--tools") + 1], "read,good_t");
	});

	it("merges partial server definitions field by field", () => {
		const fixture = createMcpFixture();
		const merged = { command: "server", requestHeadersCommand: { command: "sign" } };
		writeJson(path.join(fixture.agentDir, "mcp.json"), { mcpServers: { s: { command: "server" } } });
		writeJson(path.join(fixture.projectDir, ".mcp.json"), { mcpServers: { s: { requestHeadersCommand: { command: "sign" } } } });
		writeJson(path.join(fixture.agentDir, "mcp-cache.json"), { version: 1, servers: { s: { configHash: computeMcpServerHash(merged), cachedAt: Date.now(), tools: [{ name: "foo" }] } } });
		const { args } = buildPiArgs({ baseArgs: ["-p"], task: "hello", sessionEnabled: false, inheritProjectContext: false, inheritSkills: false, tools: ["read"], mcpDirectTools: ["s"] });
		assert.equal(args[args.indexOf("--tools") + 1], "read,s_foo");
	});

	it("drops URL-bound credentials when a higher-precedence source changes URL", () => {
		const fixture = createMcpFixture();
		const effective = { url: "https://new.test/mcp" };
		writeJson(path.join(fixture.agentDir, "mcp.json"), { mcpServers: { s: { url: "https://old.test/mcp", headers: { Authorization: "Bearer old" } } } });
		writeJson(path.join(fixture.projectDir, ".mcp.json"), { mcpServers: { s: effective } });
		writeJson(path.join(fixture.agentDir, "mcp-cache.json"), { version: 1, servers: { s: { configHash: computeMcpServerHash(effective), cachedAt: Date.now(), tools: [{ name: "foo" }] } } });
		const { args } = buildPiArgs({ baseArgs: ["-p"], task: "hello", sessionEnabled: false, inheritProjectContext: false, inheritSkills: false, tools: ["read"], mcpDirectTools: ["s"] });
		assert.equal(args[args.indexOf("--tools") + 1], "read,s_foo");
	});

	it("merges local server overrides with imported definitions", () => {
		const fixture = createMcpFixture();
		const merged = { command: "server", includeTools: ["foo"] };
		writeJson(path.join(fixture.projectDir, ".vscode", "mcp.json"), { mcpServers: { s: { command: "server" } } });
		writeJson(path.join(fixture.agentDir, "mcp.json"), { imports: ["vscode"], mcpServers: { s: { includeTools: ["foo"] } } });
		writeJson(path.join(fixture.agentDir, "mcp-cache.json"), { version: 1, servers: { s: { configHash: computeMcpServerHash(merged), cachedAt: Date.now(), tools: [{ name: "foo" }] } } });
		const { args } = buildPiArgs({ baseArgs: ["-p"], task: "hello", sessionEnabled: false, inheritProjectContext: false, inheritSkills: false, tools: ["read"], mcpDirectTools: ["s"] });
		assert.equal(args[args.indexOf("--tools") + 1], "read,s_foo");
	});

	it("keeps tool extension paths when explicit extensions are allowlisted", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture, { tools: [{ name: "take_screenshot" }] });

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "./custom-tool.ts"],
			extensions: ["./allowed-ext.ts"],
			mcpDirectTools: ["chrome-devtools"],
		});

		const extensionArgs = args.filter(
			(arg, index) => args[index - 1] === "--extension",
		);
		assert.equal(
			args[args.indexOf("--tools") + 1],
			"read,chrome-devtools_take_screenshot",
		);
		assert.ok(
			extensionArgs.some((arg) =>
				arg.endsWith(
					path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"),
				),
			),
		);
		assert.ok(extensionArgs.includes("./custom-tool.ts"));
		assert.ok(extensionArgs.includes("./allowed-ext.ts"));
	});

	it("loads subagent-only extension paths only through child process extension args", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
			extensions: ["./main-allowed-ext.ts"],
			subagentOnlyExtensions: ["./child-tool.ts"],
		});

		const extensionArgs = args.filter(
			(arg, index) => args[index - 1] === "--extension",
		);
		assert.ok(args.includes("--no-extensions"));
		assert.equal(args[args.indexOf("--tools") + 1], "read");
		assert.ok(extensionArgs.includes("./main-allowed-ext.ts"));
		assert.ok(extensionArgs.includes("./child-tool.ts"));
	});

	it("authorizes child fanout only from exact declared builtin subagent", () => {
		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "subagent"],
			runId: "parent-run",
			childIndex: 1,
			parentEventSink: "/tmp/root/events",
			parentControlInbox: "/tmp/root/control",
			parentRootRunId: "root-run",
			parentCapabilityToken: "token-1",
		});

		const extensionArgs = args.filter(
			(arg, index) => args[index - 1] === "--extension",
		);
		assert.equal(args[args.indexOf("--tools") + 1], "read,subagent");
		assert.equal(env[SUBAGENT_FANOUT_CHILD_ENV], "1");
		assert.equal(env[SUBAGENT_PARENT_EVENT_SINK_ENV], "/tmp/root/events");
		assert.equal(env[SUBAGENT_PARENT_CONTROL_INBOX_ENV], "/tmp/root/control");
		assert.equal(env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV], "root-run");
		assert.equal(env[SUBAGENT_PARENT_RUN_ID_ENV], "parent-run");
		assert.equal(env[SUBAGENT_PARENT_CHILD_INDEX_ENV], "1");
		assert.equal(env[SUBAGENT_PARENT_DEPTH_ENV], "1");
		assert.deepEqual(JSON.parse(env[SUBAGENT_PARENT_PATH_ENV] ?? "[]"), [
			{ runId: "parent-run", stepIndex: 1 },
		]);
		assert.equal(env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV], "token-1");
		assert.ok(
			extensionArgs.some((arg) =>
				arg.endsWith(path.join("src", "extension", "fanout-child.ts")),
			),
		);
	});

	it("clears all fanout routing env values for non-fanout children", () => {
		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "mcp:server/subagent"],
			parentEventSink: "/tmp/should-not-leak/events",
			parentControlInbox: "/tmp/should-not-leak/control",
			parentRootRunId: "root-should-not-leak",
			parentRunId: "should-not-leak",
			parentChildIndex: 9,
			parentCapabilityToken: "token-should-not-leak",
		});

		const extensionArgs = args.filter(
			(arg, index) => args[index - 1] === "--extension",
		);
		assert.equal(env[SUBAGENT_FANOUT_CHILD_ENV], "0");
		assert.equal(env[SUBAGENT_PARENT_EVENT_SINK_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_CONTROL_INBOX_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_RUN_ID_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_CHILD_INDEX_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_DEPTH_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_PATH_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV], "");
		assert.ok(
			!extensionArgs.some((arg) =>
				arg.endsWith(path.join("src", "extension", "fanout-child.ts")),
			),
		);
	});

	it("inherits routing env only for authorized fanout children", () => {
		process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = "/tmp/inherited/events";
		process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = "/tmp/inherited/control";
		process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = "inherited-root";
		process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "inherited-run";
		process.env[SUBAGENT_RUN_ID_ENV] = "owner-run";
		process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "4";
		process.env[SUBAGENT_PARENT_DEPTH_ENV] = "2";
		process.env[SUBAGENT_PARENT_PATH_ENV] = JSON.stringify([
			{ runId: "root-run", stepIndex: 0 },
			{ runId: "../unsafe", stepIndex: 1 },
			{ runId: "owner-run", stepIndex: 1 },
		]);
		process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = "inherited-token";

		const fanout = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["subagent"],
		});
		assert.equal(
			fanout.env[SUBAGENT_PARENT_EVENT_SINK_ENV],
			"/tmp/inherited/events",
		);
		assert.equal(
			fanout.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV],
			"/tmp/inherited/control",
		);
		assert.equal(fanout.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV], "inherited-root");
		assert.equal(fanout.env[SUBAGENT_PARENT_RUN_ID_ENV], "owner-run");
		assert.equal(fanout.env[SUBAGENT_PARENT_CHILD_INDEX_ENV], "4");
		assert.equal(fanout.env[SUBAGENT_PARENT_DEPTH_ENV], "3");
		assert.deepEqual(JSON.parse(fanout.env[SUBAGENT_PARENT_PATH_ENV] ?? "[]"), [
			{ runId: "root-run", stepIndex: 0 },
			{ runId: "owner-run", stepIndex: 1 },
			{ runId: "owner-run", stepIndex: 4 },
		]);
		assert.equal(
			fanout.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV],
			"inherited-token",
		);

		const nonFanout = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
		});
		assert.equal(nonFanout.env[SUBAGENT_FANOUT_CHILD_ENV], "0");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_EVENT_SINK_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_RUN_ID_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_CHILD_INDEX_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_DEPTH_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_PATH_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV], "");
	});

	it("prefers the current subagent run id over inherited ancestor ids for nested fanout routing", () => {
		process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = "/tmp/inherited/events";
		process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = "/tmp/inherited/control";
		process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = "root-run";
		process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "older-parent";
		process.env[SUBAGENT_RUN_ID_ENV] = "ancestor-run";
		process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "4";
		process.env[SUBAGENT_PARENT_DEPTH_ENV] = "1";
		process.env[SUBAGENT_PARENT_PATH_ENV] = JSON.stringify([
			{ runId: "root-run", stepIndex: 0 },
		]);
		process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = "inherited-token";

		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["subagent"],
			runId: "current-nested-run",
			childIndex: 2,
		});

		assert.equal(env[SUBAGENT_PARENT_RUN_ID_ENV], "current-nested-run");
		assert.equal(env[SUBAGENT_PARENT_CHILD_INDEX_ENV], "2");
		assert.equal(env[SUBAGENT_PARENT_DEPTH_ENV], "2");
		assert.deepEqual(JSON.parse(env[SUBAGENT_PARENT_PATH_ENV] ?? "[]"), [
			{ runId: "root-run", stepIndex: 0 },
			{ runId: "current-nested-run", stepIndex: 2 },
		]);
	});

	it("does not let direct MCP tools authorize child fanout", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture, {
			serverName: "delegator",
			definition: { command: "delegator-mcp" },
			tools: [{ name: "subagent" }],
		});

		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
			mcpDirectTools: ["delegator"],
		});

		const extensionArgs = args.filter(
			(arg, index) => args[index - 1] === "--extension",
		);
		assert.equal(args[args.indexOf("--tools") + 1], "read,delegator_subagent");
		assert.equal(env[SUBAGENT_FANOUT_CHILD_ENV], "0");
		assert.ok(
			!extensionArgs.some((arg) =>
				arg.endsWith(path.join("src", "extension", "fanout-child.ts")),
			),
		);
	});

	it("keeps child-safe fanout registration in explicit extensions mode", () => {
		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["subagent"],
			extensions: ["./agent-allowed-ext.ts"],
		});

		const extensionArgs = args.filter(
			(arg, index) => args[index - 1] === "--extension",
		);
		assert.ok(args.includes("--no-extensions"));
		assert.equal(env[SUBAGENT_FANOUT_CHILD_ENV], "1");
		assert.ok(
			extensionArgs.some((arg) =>
				arg.endsWith(path.join("src", "extension", "fanout-child.ts")),
			),
		);
		assert.ok(extensionArgs.includes("./agent-allowed-ext.ts"));
	});

	it("emits an empty prompt file when replace mode is used with an empty prompt", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			systemPrompt: "",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--system-prompt"));
	});
});

describe("bound runtime extension evidence", () => {
	it("binds ordered runtime extension bytes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bound-runtime-evidence-"));
		const first = path.join(root, "first.ts");
		const second = path.join(root, "second.ts");
		fs.writeFileSync(first, "first"); fs.writeFileSync(second, "second");
		const before = attestBoundRuntimeExtensions([first, second]);
		fs.writeFileSync(second, "changed");
		const after = attestBoundRuntimeExtensions([first, second]);
		assert.notDeepEqual(after, before);
		assert.deepEqual(before.entries.map((entry) => entry.name), ["first.ts", "second.ts"]);
		fs.rmSync(root, { recursive: true, force: true });
	});
});

describe("active-bound mediated extension order", () => {
	it("accepts exact package-provided caller names only with a factory projection", () => {
		const plan = resolvePiLaunchToolPlan({
			tools: ["read", "git_read", "web_search"], extensions: [], subagentOnlyExtensions: ["/trusted/package-extension.ts"],
			activeBoundPackageMediator: true, disablePermissionSystemExtension: true,
		});
		assert.deepEqual(plan.effectiveToolAllowlist, ["read", "git_read", "web_search"]);
		assert.deepEqual(plan.requiredChildTools, ["read", "git_read", "web_search"]);
		for (const tools of [
			["read", "git_read"],
			["read", "bad,name"],
			["read", "bad name"],
			["read", "工具"],
			["read", `a${"x".repeat(64)}`],
			["read", "read"],
			["read", "subagent"],
			["read", "subagent_wait"],
			["read", "contact_supervisor"],
			["read", "intercom"],
			["read", "cursor"],
		] as string[][]) {
			assert.throws(() => resolvePiLaunchToolPlan({
				tools, extensions: [], subagentOnlyExtensions: tools[1] === "git_read" ? [] : ["/trusted/package-extension.ts"],
				activeBoundPackageMediator: true, disablePermissionSystemExtension: true,
			}), /Active-bound/);
		}
	});

	it("loads bootstrap, mediator and registry gate without direct package entries", () => {
		const plan = resolvePiLaunchToolPlan({
			tools: ["read"], extensions: [], subagentOnlyExtensions: ["/trusted/package-extension.ts"],
			activeBoundPackageMediator: true, disablePermissionSystemExtension: true,
		});
		assert.equal(plan.disableAmbientExtensions, true);
		assert.equal(plan.extensionArgs.length, 4);
		assert.ok(plan.extensionArgs[0]!.endsWith(path.join("runs", "shared", "bound-tool-registry-bootstrap.ts")));
		assert.ok(plan.extensionArgs[1]!.endsWith(path.join("runs", "shared", "subagent-prompt-runtime.ts")));
		assert.ok(plan.extensionArgs[2]!.endsWith(path.join("runs", "shared", "bound-package-mediator.ts")));
		assert.ok(plan.extensionArgs[3]!.endsWith(path.join("runs", "shared", "bound-tool-registry-gate.ts")));
		assert.ok(!plan.extensionArgs.includes("/trusted/package-extension.ts"));
		const evidenceNames = attestBoundRuntimeExtensions(plan.runtimeExtensions).entries.map((entry) => entry.name);
		assert.ok(evidenceNames.includes("bound-tool-registry-runtime.ts"));
		assert.ok(evidenceNames.includes("tool-registry-proof.ts"));
		assert.ok(evidenceNames.includes("delegation-json.ts"));
		assert.ok(evidenceNames.includes("canonical-json.ts"));
	});
});
