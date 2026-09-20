import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { WAIT_TOOL_ENABLED_ENV } from "../../src/runs/background/subagent-wait.ts";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/child-runtime-config.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parentToolEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env[SUBAGENT_CHILD_ENV];
	delete env[WAIT_TOOL_ENABLED_ENV];
	return env;
}

interface RegistrationReport {
	startHandlerCount: number;
	shutdownHandlerCount: number;
	boundStartIndex: number;
	upstreamStartIndex: number;
	boundShutdownIndex: number;
	upstreamShutdownIndex: number;
	readyEventsWithoutSessionStart: number;
	readyEventsAfterOneSessionStart: number;
	readySessionCwd: string | undefined;
	staleContextCwd: string;
	pingRepliesBeforeShutdown: number;
	pingRepliesAfterBoundShutdown: number;
}

/**
 * Load the real extension with a fake `pi` and report where T1 landed relative to
 * the upstream handlers (src/extension/index.ts:1162 and :1191). Other subsystems
 * register earlier handlers of their own, so the claim under test is ordering
 * against those two, not against every handler in the file.
 */
function inspectRegistration(): RegistrationReport {
	const script = String.raw`
		import registerSubagentExtension from "./index.ts";
		import { setChildSessionFactory } from "./src/runs/shared/child-session.ts";
		const handlers = [];
		const emitted = [];
		const busHandlers = new Map();
		const events = {
			on(event, handler) {
				const list = busHandlers.get(event) ?? [];
				list.push(handler);
				busHandlers.set(event, list);
				return () => busHandlers.set(event, (busHandlers.get(event) ?? []).filter((entry) => entry !== handler));
			},
			emit(event, data) { emitted.push({ event, data }); },
		};
		const deliver = (event, data) => { for (const handler of [...(busHandlers.get(event) ?? [])]) handler(data); };
		const staleContextCwd = "/stale/context";
		const sessionManager = new Proxy({
			getSessionId: () => "session-test",
			getSessionFile: () => null,
			getEntries: () => [],
			getMessages: () => [],
			getSessionDir: () => process.cwd(),
		}, { get: (target, prop) => (prop in target ? target[prop] : () => undefined) });
		const makeContext = (cwd) => ({ cwd, hasUI: false, sessionManager, modelRegistry: { getAvailable: () => [] }, isProjectTrusted: () => false });
		const liveContext = makeContext(process.cwd());
		const fakePi = new Proxy({
			events,
			on(event, handler) { handlers.push({ event, handler }); },
			registerTool() {},
			registerCommand() {},
			registerShortcut() {},
			registerMessageRenderer() {},
			sendMessage() {},
			getSessionName() { return undefined; },
		}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
		registerSubagentExtension(fakePi);

		const readyEventsWithoutSessionStart = emitted.filter((record) => record.event === "subagents:bound:v2:ready").length;
		const startHandlers = handlers.filter((entry) => entry.event === "session_start");
		const shutdownHandlers = handlers.filter((entry) => entry.event === "session_shutdown");
		let boundStartIndex = -1;
		let upstreamStartIndex = -1;
		for (const [index, entry] of startHandlers.entries()) {
			const before = emitted.length;
			try { entry.handler({ reason: "startup" }, liveContext); } catch {}
			const fresh = emitted.slice(before).map((record) => record.event);
			if (fresh.includes("subagents:bound:v2:ready")) boundStartIndex = index;
			if (fresh.includes("subagents:rpc:v1:ready")) upstreamStartIndex = index;
		}
		const readyEvents = emitted.filter((record) => record.event === "subagents:bound:v2:ready");

		const pingBefore = emitted.length;
		deliver("subagents:bound:v2:request", { version: 2, requestId: "ping-before", method: "ping" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const pingRepliesBeforeShutdown = emitted.slice(pingBefore).filter((record) => record.event === "subagents:bound:v2:reply:ping-before").length;

		// A scripted factory reveals which handler is the upstream one: only that
		// handler awaits disposeChildSessions().
		let disposeCalls = 0;
		setChildSessionFactory({ async create() { throw new Error("unused"); }, async dispose() { disposeCalls++; } });
		let boundShutdownIndex = -1;
		let upstreamShutdownIndex = -1;
		let pingRepliesAfterBoundShutdown = -1;
		for (const [index, entry] of shutdownHandlers.entries()) {
			const disposeBefore = disposeCalls;
			try { await entry.handler({ reason: "quit" }, liveContext); } catch {}
			if (disposeCalls > disposeBefore && upstreamShutdownIndex === -1) upstreamShutdownIndex = index;
			const pingAt = emitted.length;
			deliver("subagents:bound:v2:request", { version: 2, requestId: "ping-" + index, method: "ping" });
			await new Promise((resolve) => setTimeout(resolve, 20));
			const replies = emitted.slice(pingAt).filter((record) => record.event === "subagents:bound:v2:reply:ping-" + index).length;
			if (replies === 0 && boundShutdownIndex === -1) {
				boundShutdownIndex = index;
				pingRepliesAfterBoundShutdown = replies;
			}
		}

		process.stdout.write(JSON.stringify({
			startHandlerCount: startHandlers.length,
			shutdownHandlerCount: shutdownHandlers.length,
			boundStartIndex,
			upstreamStartIndex,
			boundShutdownIndex,
			upstreamShutdownIndex,
			readyEventsWithoutSessionStart,
			readyEventsAfterOneSessionStart: readyEvents.length,
			readySessionCwd: readyEvents[0]?.data?.session?.cwd,
			staleContextCwd,
			pingRepliesBeforeShutdown,
			pingRepliesAfterBoundShutdown,
		}));
	`;
	const output = execFileSync(
		process.execPath,
		["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script],
		{ cwd: projectRoot, env: parentToolEnv(), stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
	);
	return JSON.parse(output) as RegistrationReport;
}

const report = inspectRegistration();

test("the bound session_start handler runs before the upstream one", () => {
	assert.ok(report.startHandlerCount >= 2, `expected several session_start handlers, got ${report.startHandlerCount}`);
	assert.notEqual(report.boundStartIndex, -1, "no session_start handler emitted the bound ready event");
	assert.notEqual(report.upstreamStartIndex, -1, "no session_start handler emitted the upstream ready event");
	assert.ok(report.boundStartIndex < report.upstreamStartIndex,
		`bound session_start at ${report.boundStartIndex} must precede the upstream one at ${report.upstreamStartIndex}`);
});

test("the bound session_shutdown handler runs before the upstream disposeChildSessions", () => {
	assert.notEqual(report.boundShutdownIndex, -1, "no session_shutdown handler stopped the responder");
	assert.notEqual(report.upstreamShutdownIndex, -1, "no session_shutdown handler disposed child sessions");
	assert.ok(report.boundShutdownIndex < report.upstreamShutdownIndex,
		`bound session_shutdown at ${report.boundShutdownIndex} must precede the upstream one at ${report.upstreamShutdownIndex}`);
	assert.equal(report.pingRepliesBeforeShutdown, 1, "the control plane must answer before shutdown");
	assert.equal(report.pingRepliesAfterBoundShutdown, 0);
});

test("ready is emitted once per session_start and never at registration time", () => {
	assert.equal(report.readyEventsWithoutSessionStart, 0);
	assert.equal(report.readyEventsAfterOneSessionStart, 1);
	// The payload takes the context from the handler argument, not from the stale
	// getContext() source the upstream session_start assigns later.
	assert.equal(report.readySessionCwd, projectRoot);
	assert.notEqual(report.readySessionCwd, report.staleContextCwd);
});
