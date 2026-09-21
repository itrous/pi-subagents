import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { afterEach, beforeEach, test, type TestContext } from "node:test";
import { discoverAgents } from "../../src/agents/agents.ts";
import { buildBoundExecutionParams } from "../../src/bound/bound-execution-port.ts";
import { recheckBoundLaunch, type BoundLaunchField } from "../../src/bound/bound-launch-recheck.ts";
import { createBoundRuntimeService, type BoundAuthorizedLaunch, type BoundRuntimeServiceOptions } from "../../src/bound/bound-runtime-service.ts";
import { BOUND_CHANNEL_VERSION } from "../../src/bound/channel.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { setChildSessionFactory, type ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";
import type { ExtensionConfig, SubagentState } from "../../src/shared/types.ts";
import { createBoundFixture, type BoundFixture } from "../fixtures/bound/harness.ts";

let fixture: BoundFixture;
beforeEach(() => { fixture = createBoundFixture(); });
afterEach(() => { setChildSessionFactory(undefined); fixture.cleanup(); });

async function admittedLaunch(): Promise<BoundAuthorizedLaunch> {
	const service = createBoundRuntimeService(fixture.serviceOptions() as unknown as BoundRuntimeServiceOptions);
	try {
		const request = fixture.request();
		const preflight = await service.preflight(request);
		assert.ok(preflight?.ok, "preflight must succeed");
		const data = preflight.data;
		const admitted = await service.admit(request, {
			version: BOUND_CHANNEL_VERSION, targetServerInstanceId: data.serverInstanceId, prospectiveRunId: data.launchContract.prospectiveRunId,
			expectedSourceIdentityDigest: data.sourceIdentityDigest, expectedActiveSessionDigest: data.activeSessionDigest,
			requestDigest: data.requestDigest, expectedLaunchContractDigest: data.launchContractDigest,
			receipt: data.receipt, cancellationToken: data.cancellationToken,
		});
		assert.ok(admitted.ok, "admission must succeed");
		return admitted.launch;
	} finally { service.dispose(); }
}

/**
 * Drive the real upstream executor with the port's params and capture the
 * launch it hands to the child-session factory. The first `randomUUID` of the
 * single foreground path is the run id; returning `prospectiveRunId` for it
 * stands in for the T2 fragment of decision D4 (second delivery), which the
 * contract's session roots depend on.
 */
async function captureExecutorLaunch(t: TestContext, authorized: BoundAuthorizedLaunch, options: { switches: boolean; host: Partial<ExtensionConfig> }): Promise<ChildSessionLaunch> {
	const realRandomUUID = crypto.randomUUID.bind(crypto);
	let first = true;
	t.mock.method(crypto, "randomUUID", () => {
		if (!first) return realRandomUUID();
		first = false;
		return authorized.contract.prospectiveRunId;
	});
	syncBuiltinESMExports();
	const captured: ChildSessionLaunch[] = [];
	setChildSessionFactory({ async create(launch) { captured.push(launch); throw new Error("launch captured"); }, async dispose() {} });
	try {
		const state = {
			baseCwd: fixture.project, currentSessionId: "parent-session-id", asyncJobs: new Map(), foregroundControls: new Map(),
			lastForegroundControlId: null, cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(),
			watcher: null, watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear: () => {} },
		} as unknown as SubagentState;
		const executor = createSubagentExecutor({
			pi: { getSessionName: () => "host-session", events: { on: () => () => {}, emit() {} } } as never,
			state,
			config: { ...fixture.config, ...options.host } as ExtensionConfig,
			asyncByDefault: false, tempArtifactsDir: fixture.tempRoot, getSubagentSessionRoot: () => fixture.sessionDir,
			expandTilde: (value: string) => value, discoverAgents: (cwd, scope) => discoverAgents(cwd, scope),
		} as Parameters<typeof createSubagentExecutor>[0]);
		const params = buildBoundExecutionParams(authorized) as Record<string, unknown> | undefined;
		assert.ok(params);
		if (!options.switches) { delete params.control; delete params.intercomBridge; }
		const context = fixture.context();
		const ctx = { ...context, ui: {}, sessionManager: { ...context.sessionManager, getEntries: () => [], getBranch: () => [] } };
		await executor.executeDelegated("recheck-request", params, new AbortController().signal, undefined, ctx as never);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
	assert.equal(captured.length, 1, "the executor must reach the child-session factory exactly once");
	return captured[0]!;
}

const HOSTILE_HOST: Partial<ExtensionConfig> = { intercomBridge: { mode: "always" }, control: { enabled: true } };

test("the unmodified executor launch passes the recheck", async (t) => {
	const authorized = await admittedLaunch();
	const launch = await captureExecutorLaunch(t, authorized, { switches: true, host: {} });
	assert.deepEqual(recheckBoundLaunch(launch, authorized), { ok: true });
});

test("a hostile host (intercom always, control on) is neutralised by the D14 switches", async (t) => {
	const authorized = await admittedLaunch();
	const launch = await captureExecutorLaunch(t, authorized, { switches: true, host: HOSTILE_HOST });
	assert.deepEqual(recheckBoundLaunch(launch, authorized), { ok: true });
	assert.doesNotMatch(launch.systemPrompt ?? launch.appendSystemPrompt ?? "", /Intercom orchestration channel:/);
});

test("the same launch without the switches fails on the prompt digest and the runtime traces", async (t) => {
	const authorized = await admittedLaunch();
	const launch = await captureExecutorLaunch(t, authorized, { switches: false, host: HOSTILE_HOST });
	const result = recheckBoundLaunch(launch, authorized);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.ok(result.mismatches.includes("systemPrompt"));
	assert.ok(result.mismatches.includes("runtime.disabledPolicy"));
	// Positive control: the host config really does give an unswitched launch the intercom bridge.
	assert.match(launch.systemPrompt ?? launch.appendSystemPrompt ?? "", /Intercom orchestration channel:/);
	assert.ok(launch.tools?.includes("contact_supervisor"));
	assert.equal(typeof launch.runtime.intercomSessionName, "string");
});

type Mutation = [BoundLaunchField, (launch: ChildSessionLaunch) => ChildSessionLaunch];
const withRuntime = (launch: ChildSessionLaunch, patch: Record<string, unknown>): ChildSessionLaunch => ({ ...launch, runtime: { ...launch.runtime, ...patch } });
const MUTATIONS: Mutation[] = [
	["cwd", (launch) => ({ ...launch, cwd: path.dirname(launch.cwd) })],
	["storage", (launch) => ({ ...launch, storage: { kind: "file", sessionFile: `${(launch.storage as { sessionFile: string }).sessionFile}.other` } })],
	["storage", (launch) => ({ ...launch, storage: { kind: "memory" } })],
	["model", (launch) => ({ ...launch, model: "openai/gpt-5:high" })],
	["tools", (launch) => ({ ...launch, tools: [...(launch.tools ?? []), "bash"] })],
	["excludeTools", (launch) => ({ ...launch, excludeTools: ["bash"] })],
	["ambientExtensions", (launch) => ({ ...launch, ambientExtensions: true })],
	["noSkills", (launch) => ({ ...launch, noSkills: false })],
	["noContextFiles", (launch) => ({ ...launch, noContextFiles: false })],
	["runtime.mcpDirectTools", (launch) => withRuntime(launch, { mcpDirectTools: ["fixture/alpha"] })],
	["runtime.requiredTools", (launch) => withRuntime(launch, { requiredTools: ["read", "bash"] })],
	["runtime.capabilityCeiling", (launch) => withRuntime(launch, { capabilityCeiling: { version: 1, denyExtensions: true, sources: ["host"] } })],
	["runtime.disabledPolicy", (launch) => withRuntime(launch, { intercomSessionName: "leaf" })],
	["runtime.disabledPolicy", (launch) => withRuntime(launch, { orchestratorTarget: "host" })],
	["runtime.disabledPolicy", (launch) => withRuntime(launch, { supervisorChannelDir: "/tmp/channel" })],
	["runtime.disabledPolicy", (launch) => withRuntime(launch, { childWatchdog: {} })],
	["runtime.disabledPolicy", (launch) => withRuntime(launch, { watchdogStatus: () => {} })],
	["systemPrompt", (launch) => launch.systemPrompt !== undefined ? { ...launch, systemPrompt: `${launch.systemPrompt}\n\nextra` } : { ...launch, appendSystemPrompt: `${launch.appendSystemPrompt}\n\nextra` }],
	["systemPrompt", (launch) => ({ ...launch, systemPrompt: launch.systemPrompt ?? "x", appendSystemPrompt: launch.appendSystemPrompt ?? "x" })],
	["extensionPaths", (launch) => ({ ...launch, extensionPaths: [...launch.extensionPaths, "/fixture/ambient.ts"] })],
];

test("every checked field, changed alone, fails the recheck on exactly that field", async (t) => {
	const authorized = await admittedLaunch();
	const launch = await captureExecutorLaunch(t, authorized, { switches: true, host: {} });
	for (const [field, mutate] of MUTATIONS) {
		assert.deepEqual(recheckBoundLaunch(mutate(launch), authorized), { ok: false, mismatches: [field] }, field);
	}
	// A skill whose bytes changed after admission changes the expected prompt.
	fixture.writeSkill("---\nname: review-notes\ndescription: Changed.\n---\n\nChanged.\n");
	assert.deepEqual(recheckBoundLaunch(launch, authorized), { ok: false, mismatches: ["systemPrompt"] });
});

test("raw package refs must match the contract refs one to one", async (t) => {
	const authorized = await admittedLaunch();
	const launch = await captureExecutorLaunch(t, authorized, { switches: true, host: {} });
	const projection = { kind: "package" as const, ref: "package:fixture-ext", owner: { name: "o", version: "1", manifestDigest: "0".repeat(64) }, entryDigest: "1".repeat(64), contentDigest: "2".repeat(64), packageTreeDigest: "3".repeat(64), evidenceRootDigest: "4".repeat(64) };
	const withRef: BoundAuthorizedLaunch = { ...authorized, contract: { ...authorized.contract, packageExtensions: [projection] }, packageExtensionPaths: ["/owner/node_modules/fixture-ext/index.ts"] };
	assert.deepEqual(recheckBoundLaunch({ ...launch, extensionPaths: ["package:fixture-ext"] }, withRef), { ok: true });
	assert.deepEqual(recheckBoundLaunch(launch, withRef), { ok: false, mismatches: ["packageRefs"] });
	assert.deepEqual(recheckBoundLaunch({ ...launch, extensionPaths: ["package:other"] }, withRef), { ok: false, mismatches: ["packageRefs", "extensionPaths"] });
	assert.deepEqual(recheckBoundLaunch({ ...launch, extensionPaths: ["package:fixture-ext", "package:fixture-ext"] }, withRef), { ok: false, mismatches: ["extensionPaths"] });
	assert.deepEqual(recheckBoundLaunch({ ...launch, extensionPaths: ["package:fixture-ext"] }, { ...withRef, packageExtensionPaths: [] }), { ok: false, mismatches: ["packageRefs"] });
});
