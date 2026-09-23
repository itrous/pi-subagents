import * as fs from "node:fs";
import { discoverAgents, type AgentConfig } from "../../src/agents/agents.ts";
import { setBoundForegroundChildSessionFactoryOptions } from "../../src/bound/bound-child-factory.ts";
import { buildBoundExecutionParams } from "../../src/bound/bound-execution-port.ts";
import { getBoundRunRegistry, markBoundRunParams } from "../../src/bound/bound-run-registry.ts";
import type { BoundAuthorizedLaunch } from "../../src/bound/bound-runtime-service.ts";
import { createSubagentExecutor, type SubagentParamsLike } from "../../src/runs/foreground/subagent-executor.ts";
import { setChildSessionFactory, type ChildSession, type ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";
import type { ExtensionConfig, SubagentState } from "../../src/shared/types.ts";
import type { BoundFixture } from "../fixtures/bound/harness.ts";
import { registerSubagentRpcBridge, SUBAGENT_RPC_REQUEST_EVENT } from "../../src/extension/rpc.ts";
import { fakePi, type FakePiOptions } from "./bound-fake-pi.ts";
import { TEST_TRANSCRIPT_API } from "./bound-transcript.ts";

export const STAND_SESSION_ID = "parent-session-id";

/**
 * The real upstream executor over the bound fixture. Non-bound children come
 * from a scripted process-wide factory; bound children come from the T2
 * decorator over a tier-1 fake Pi module. Both hold their prompt until released.
 */
export function createExecutorStand(fixture: BoundFixture, host: Partial<ExtensionConfig> = {}, stand: {
	/** Replaces the default fake Pi (prompts held until `release()`). */
	fake?: FakePiOptions;
	/** Agents discovered beside the fixture project's own. */
	agents?: AgentConfig[];
	/** The host UI object handed to the executor. */
	ui?: object;
} = {}) {
	fs.mkdirSync(fixture.sessionDir, { recursive: true });
	const state = {
		baseCwd: fixture.project, currentSessionId: fixture.sessionManager.getSessionFile(), statusProjectionSessionId: fixture.sessionManager.getSessionFile(),
		asyncJobs: new Map(), foregroundControls: new Map(), foregroundRuns: new Map(), lastForegroundControlId: null, cleanupTimers: new Map(),
		lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} as unknown as SubagentState;
	const executor = createSubagentExecutor({
		pi: { getSessionName: () => "host-session", events: { on: () => () => {}, emit() {} } } as never,
		state,
		config: { ...fixture.config, ...host } as ExtensionConfig,
		asyncByDefault: false, tempArtifactsDir: fixture.tempRoot, getSubagentSessionRoot: () => fixture.sessionDir,
		expandTilde: (value: string) => value,
		discoverAgents: (cwd, scope) => {
			const discovered = discoverAgents(cwd, scope);
			return stand.agents ? { ...discovered, agents: [...discovered.agents, ...stand.agents] } : discovered;
		},
	} as Parameters<typeof createSubagentExecutor>[0]);
	const context = fixture.context();
	const ctx = {
		...context, ui: stand.ui ?? {},
		sessionManager: { ...context.sessionManager, getEntries: () => [], getBranch: () => [] },
		// Upstream hands the parent's provider registry to every foreground child.
		modelRegistry: { ...context.modelRegistry, getRegisteredProviderIds: () => [], getRegisteredProviderConfig: () => undefined, getRegisteredNativeProvider: () => undefined },
	};

	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const plainLaunches: ChildSessionLaunch[] = [];
	const plainAborts: string[] = [];
	setChildSessionFactory({
		async create(launch) {
			plainLaunches.push(launch);
			const child: ChildSession = {
				subscribe: () => () => {},
				prompt: async () => { await gate; },
				steer: async () => {}, followUp: async () => {},
				abort: async () => { plainAborts.push(launch.runtime.runId ?? ""); },
				dispose: async () => {},
				messages: [], sessionFile: undefined, sessionId: `plain-${plainLaunches.length}`, modelId: "openai/gpt-5",
			};
			return child;
		},
		async dispose() {},
	});
	const bound = fakePi(stand.fake ?? { promptGate: gate });
	setBoundForegroundChildSessionFactoryOptions({ loadPiCodingAgent: async () => bound.pi, processCwd: () => fs.realpathSync(fixture.project), transcriptApi: TEST_TRANSCRIPT_API });

	const run = (params: SubagentParamsLike, signal = new AbortController().signal) => executor.executeDelegated(`stand-${Math.random()}`, params, signal, undefined, ctx as never);
	return {
		state, executor, ctx, plainLaunches, plainAborts, boundProbe: bound.probe, release,
		/** Unmarked params of the same contract: an ordinary delegated launch. */
		plain(launch: BoundAuthorizedLaunch): SubagentParamsLike { return buildBoundExecutionParams(launch)!; },
		/** Marked params plus a live registry record, as the execution port prepares them. */
		bound(launch: BoundAuthorizedLaunch): SubagentParamsLike {
			const record = getBoundRunRegistry().open(launch);
			if (!record) throw new Error("run id already live");
			return markBoundRunParams(buildBoundExecutionParams(launch)!, record.runId);
		},
		run,
		dispose() {
			release();
			setChildSessionFactory(undefined);
			setBoundForegroundChildSessionFactoryOptions(undefined);
		},
	};
}

export async function until(condition: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 1000; attempt++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error(`timed out waiting for ${label}`);
}

export type RpcReply = { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };

/** The public upstream RPC bridge over the stand's executor. */
export function createRpcClient(current: ReturnType<typeof createExecutorStand>) {
	let handler: ((raw: unknown) => unknown) | undefined;
	const replies = new Map<string, RpcReply>();
	registerSubagentRpcBridge({
		events: {
			on(event: string, listener: (raw: unknown) => unknown) { if (event === SUBAGENT_RPC_REQUEST_EVENT) handler = listener; return () => {}; },
			emit(_event: string, data: unknown) { const reply = data as RpcReply & { requestId: string }; replies.set(reply.requestId, reply); },
		},
		getContext: () => current.ctx,
		execute: (id, params, signal, onUpdate, ctx) => current.executor.executePublic(id, params, signal, onUpdate, ctx),
		state: current.state,
	} as unknown as Parameters<typeof registerSubagentRpcBridge>[0]);
	let sequence = 0;
	return async (method: string, params: Record<string, unknown> = {}, requestId = `request-${++sequence}`): Promise<RpcReply> => {
		await handler!({ version: 1, requestId, method, params });
		await until(() => replies.has(requestId), `${method} reply`);
		const { success, data, error } = replies.get(requestId)!;
		replies.delete(requestId);
		return { success, ...(data ? { data } : {}), ...(error ? { error } : {}) };
	};
}
