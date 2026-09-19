// C2: host-side registry snapshot after bindExtensions vs context.tools of the first model call.
import { openSession, closeSession, installObserver, toolDef, verdictLine, sameSet, externalFetches } from "./harness.mjs";

const results = [];

async function scenario(name, opts, expectMatch, extra) {
	const ctx = await openSession(opts);
	try {
		const log = [];
		installObserver(ctx.session.agent, log);
		await ctx.session.prompt("hi");
		const first = log[0]?.actual;
		const match = first !== undefined && sameSet(ctx.snapshot.active, first);
		const detail = {
			preBind: ctx.snapshotPreBind,
			snapshotAfterBind: ctx.snapshot,
			firstCallContextTools: first,
			serverToolNames: ctx.server.state.requests[0]?.toolNames,
			snapshotActiveEqualsFirstCall: match,
			getAllToolsEqualsFirstCall: first !== undefined && sameSet(ctx.snapshot.all, first),
			...(extra ? extra() : {}),
		};
		results.push(verdictLine(name, match === expectMatch && ctx.server.state.count === 1, detail));
	} catch (err) {
		results.push(verdictLine(name, false, { threw: String(err?.stack ?? err) }));
	} finally {
		await closeSession(ctx);
	}
}

const registerNow = (n) => ({ name: `reg-${n}`, factory: (api) => api.registerTool(toolDef(n)) });
const registerOn = (event, n) => ({ name: `reg-${n}-on-${event}`, factory: (api) => api.on(event, () => { api.registerTool(toolDef(n)); }) });

await scenario("C2.B1 defaults, no extensions => snapshot == first call", {}, true);
await scenario("C2.B2 allowlist[read,probe] + factory-registered probe => snapshot == first call", { tools: ["read", "probe"], hooks: [registerNow("probe")] }, true);
await scenario("C2.B3 tool registered in session_start (no allowlist) => included in post-bind snapshot", { hooks: [registerOn("session_start", "late")] }, true);

// B4: tool registered after the snapshot (before_agent_start) => mismatch must be detectable.
const seenAtAgentStart = {};
const agentStartSpy = { name: "agent-start-spy", factory: (api) => api.on("agent_start", () => {
	seenAtAgentStart.extGetAllTools = api.getAllTools().map((t) => t.name).sort();
	seenAtAgentStart.extGetActiveTools = [...api.getActiveTools()].sort();
}) };
await scenario("C2.B4 control: tool registered in before_agent_start => mismatch detected", { hooks: [registerOn("before_agent_start", "sneaky"), agentStartSpy] }, false, () => ({ seenAtAgentStart }));
await scenario("C2.B4' allowlist[read] + before_agent_start registers sneaky => Pi filters, no mismatch", { tools: ["read"], hooks: [registerOn("before_agent_start", "sneaky")] }, true);

console.log(`externalFetches=${JSON.stringify(externalFetches)}`);
console.log(`C2 SUMMARY: ${results.filter(Boolean).length}/${results.length} PASS`);
process.exit(0);
