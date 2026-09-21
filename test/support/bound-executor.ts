import * as fs from "node:fs";
import { discoverAgents } from "../../src/agents/agents.ts";
import { setBoundForegroundChildSessionFactoryOptions } from "../../src/bound/bound-child-factory.ts";
import { buildBoundExecutionParams } from "../../src/bound/bound-execution-port.ts";
import { getBoundRunRegistry, markBoundRunParams } from "../../src/bound/bound-run-registry.ts";
import type { BoundAuthorizedLaunch } from "../../src/bound/bound-runtime-service.ts";
import { createSubagentExecutor, type SubagentParamsLike } from "../../src/runs/foreground/subagent-executor.ts";
import { setChildSessionFactory, type ChildSession, type ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";
import type { ExtensionConfig, SubagentState } from "../../src/shared/types.ts";
import type { BoundFixture } from "../fixtures/bound/harness.ts";
import { fakePi } from "./bound-fake-pi.ts";

export const STAND_SESSION_ID = "parent-session-id";

/**
 * The real upstream executor over the bound fixture. Non-bound children come
 * from a scripted process-wide factory; bound children come from the T2
 * decorator over a tier-1 fake Pi module. Both hold their prompt until released.
 */
export function createExecutorStand(fixture: BoundFixture, host: Partial<ExtensionConfig> = {}) {
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
		expandTilde: (value: string) => value, discoverAgents: (cwd, scope) => discoverAgents(cwd, scope),
	} as Parameters<typeof createSubagentExecutor>[0]);
	const context = fixture.context();
	const ctx = {
		...context, ui: {},
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
	const bound = fakePi({ promptGate: gate });
	setBoundForegroundChildSessionFactoryOptions({ loadPiCodingAgent: async () => bound.pi, processCwd: () => fs.realpathSync(fixture.project) });

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
