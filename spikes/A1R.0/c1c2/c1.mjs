// C1: barrier before provider via session.agent.streamFunction wrapper.
import { pi, openSession, closeSession, installToolBarrier, installObserver, toolDef, verdictLine, externalFetches } from "./harness.mjs";

const results = [];
const last = (events) => events.filter((e) => e.type === "assistant_end").at(-1);

async function scenario(name, opts, run) {
	const ctx = await openSession(opts);
	try {
		const out = await run(ctx);
		results.push(verdictLine(name, out.ok, out.detail));
	} catch (err) {
		results.push(verdictLine(name, false, { threw: String(err?.stack ?? err) }));
	} finally {
		await closeSession(ctx);
	}
}

const probeHook = (onExecute) => ({
	name: "probe-tool",
	factory: (api) => api.registerTool({ ...toolDef("probe"), async execute() { onExecute?.(api); return { content: [{ type: "text", text: "probe done" }], details: {} }; } }),
});

// A1: mismatch -> 0 provider requests, run ends with error.
await scenario("C1.A1 mismatch+barrier => 0 requests, error", { tools: ["read"] }, async (ctx) => {
	const log = [];
	installToolBarrier(ctx.session.agent, ["read", "bash"], log);
	let promptRejected = null;
	try { await ctx.session.prompt("hi"); } catch (e) { promptRejected = String(e); }
	const end = last(ctx.events);
	return {
		ok: ctx.server.state.count === 0 && end?.stopReason === "error" && /TOOL_BARRIER/.test(end.errorMessage ?? ""),
		detail: { selfCheck: ctx.selfCheck, snapshot: ctx.snapshot, requests: ctx.server.state.count, barrier: log, end, promptRejected, retries: ctx.events.filter((e) => e.type === "auto_retry_start").length },
	};
});

// A2 (control 1): same scenario, no barrier -> >=1 request.
await scenario("C1.A2 control: mismatch, no barrier => >=1 request", { tools: ["read"] }, async (ctx) => {
	const log = [];
	installObserver(ctx.session.agent, log);
	await ctx.session.prompt("hi");
	return { ok: ctx.server.state.count >= 1, detail: { requests: ctx.server.state.count, serverSaw: ctx.server.state.requests, observer: log, end: last(ctx.events) } };
});

// A3 (control 2): matching set -> request passes normally.
await scenario("C1.A3 control: match+barrier => request passes", { tools: ["read"] }, async (ctx) => {
	const log = [];
	installToolBarrier(ctx.session.agent, ["read"], log);
	await ctx.session.prompt("hi");
	const end = last(ctx.events);
	return { ok: ctx.server.state.count === 1 && end?.stopReason === "stop", detail: { requests: ctx.server.state.count, serverSaw: ctx.server.state.requests, barrier: log, end } };
});

// A4a: extension widens active tools in before_agent_start (no allowlist) -> caught.
const widenHook = { name: "widen", factory: (api) => api.on("before_agent_start", () => { api.setActiveTools([...api.getActiveTools(), "grep"]); }) };
await scenario("C1.A4a before_agent_start widens (+grep) + barrier => 0 requests", { hooks: [widenHook] }, async (ctx) => {
	const log = [];
	installToolBarrier(ctx.session.agent, ctx.snapshot.active, log);
	await ctx.session.prompt("hi");
	const end = last(ctx.events);
	return { ok: ctx.server.state.count === 0 && end?.stopReason === "error", detail: { snapshot: ctx.snapshot, requests: ctx.server.state.count, barrier: log, end } };
});
await scenario("C1.A4a' control: same widen, no barrier => request carries grep", { hooks: [widenHook] }, async (ctx) => {
	const log = [];
	installObserver(ctx.session.agent, log);
	await ctx.session.prompt("hi");
	return { ok: ctx.server.state.count === 1 && ctx.server.state.requests[0].toolNames.includes("grep"), detail: { snapshot: ctx.snapshot, serverSaw: ctx.server.state.requests } };
});

// A4b: with allowlist, extension narrows active tools in before_agent_start -> caught.
const narrowHook = { name: "narrow", factory: (api) => api.on("before_agent_start", () => { api.setActiveTools(["read"]); }) };
await scenario("C1.A4b allowlist[read,bash] + before_agent_start narrows + barrier => 0 requests", { tools: ["read", "bash"], hooks: [narrowHook] }, async (ctx) => {
	const log = [];
	installToolBarrier(ctx.session.agent, ["read", "bash"], log);
	await ctx.session.prompt("hi");
	const end = last(ctx.events);
	return { ok: ctx.server.state.count === 0 && end?.stopReason === "error", detail: { snapshot: ctx.snapshot, requests: ctx.server.state.count, barrier: log, end } };
});
// A4c: with allowlist, extension tries to widen to a non-allowed tool -> Pi itself filters, no mismatch.
await scenario("C1.A4c allowlist[read] + before_agent_start tries +grep => Pi filters, barrier passes", { tools: ["read"], hooks: [widenHook] }, async (ctx) => {
	const log = [];
	installToolBarrier(ctx.session.agent, ["read"], log);
	await ctx.session.prompt("hi");
	const end = last(ctx.events);
	return { ok: ctx.server.state.count === 1 && end?.stopReason === "stop", detail: { snapshot: ctx.snapshot, serverSaw: ctx.server.state.requests, barrier: log, end } };
});

// A5a: persistence across turns inside one prompt (tool call -> 2nd turn) and across prompts.
await scenario("C1.A5a barrier persists across turns and prompts", { tools: ["read", "probe"], hooks: [probeHook()], script: [{ toolCall: "probe" }, "text"] }, async (ctx) => {
	const log = [];
	const wrapped = installToolBarrier(ctx.session.agent, ["read", "probe"], log);
	await ctx.session.prompt("first");
	const afterFirst = { requests: ctx.server.state.count, barrierCalls: log.length };
	await ctx.session.prompt("second");
	const end = last(ctx.events);
	return {
		ok: afterFirst.requests === 2 && afterFirst.barrierCalls === 2 && ctx.server.state.count === 3 && log.length === 3 && ctx.session.agent.streamFunction === wrapped && end?.stopReason === "stop",
		detail: { afterFirst, total: { requests: ctx.server.state.count, barrierCalls: log.length }, stillWrapped: ctx.session.agent.streamFunction === wrapped, ends: ctx.events },
	};
});

// A5b: tool execution changes active tools mid-run -> 2nd turn blocked.
await scenario("C1.A5b mid-run setActiveTools in tool execute => 2nd turn blocked", { tools: ["read", "probe"], hooks: [probeHook((api) => api.setActiveTools(["read"]))], script: [{ toolCall: "probe" }, "text"] }, async (ctx) => {
	const log = [];
	installToolBarrier(ctx.session.agent, ["read", "probe"], log);
	await ctx.session.prompt("first");
	const end = last(ctx.events);
	return { ok: ctx.server.state.count === 1 && log.length === 2 && end?.stopReason === "error", detail: { requests: ctx.server.state.count, barrier: log, ends: ctx.events } };
});

// A6: model switch keeps the wrapper (Pi does not reassign streamFunction).
await scenario("C1.A6 setModel(faux-2) keeps wrapper", { tools: ["read"] }, async (ctx) => {
	const log = [];
	const wrapped = installToolBarrier(ctx.session.agent, ["read"], log);
	const m2 = pi.resolveCliModel({ cliModel: "faux/faux-2", modelRuntime: ctx.modelRuntime }).model;
	await ctx.session.setModel(m2);
	const stillWrapped = ctx.session.agent.streamFunction === wrapped;
	await ctx.session.prompt("hi");
	return { ok: stillWrapped && log.length === 1 && log[0].model === "faux-2" && ctx.server.state.requests[0]?.model === "faux-2", detail: { stillWrapped, barrier: log, serverSaw: ctx.server.state.requests } };
});

// A7: plan fact — throwing before_provider_request handler is swallowed, request still goes out.
const throwingBpr = { name: "throwing-bpr", factory: (api) => api.on("before_provider_request", () => { throw new Error("deny from before_provider_request"); }) };
await scenario("C1.A7 fact: throwing before_provider_request does NOT block", { tools: ["read"], hooks: [throwingBpr] }, async (ctx) => {
	await ctx.session.prompt("hi");
	return { ok: ctx.server.state.count === 1 && ctx.extErrors.some((e) => e.event === "before_provider_request"), detail: { requests: ctx.server.state.count, extErrors: ctx.extErrors, end: last(ctx.events) } };
});


// A1r: same as A1 but with Pi default retry settings -> barrier error is not auto-retried.
await scenario("C1.A1r mismatch+barrier, default retry settings => no retry, 0 requests", { tools: ["read"], retryEnabled: true }, async (ctx) => {
	const log = [];
	installToolBarrier(ctx.session.agent, ["read", "bash"], log);
	await ctx.session.prompt("hi");
	const end = last(ctx.events);
	return { ok: ctx.server.state.count === 0 && log.length === 1 && end?.stopReason === "error", detail: { retrySettings: ctx.session.settingsManager.getRetrySettings(), requests: ctx.server.state.count, barrierCalls: log.length, ends: ctx.events } };
});

// A8: fragility probe — compaction/summarization reuses agent.streamFunction with a context WITHOUT tools.
await scenario("C1.A8 probe: compact() goes through the barrier (context.tools empty)", { tools: ["read"], script: ["text", "text", "text"], settings: { compaction: { keepRecentTokens: 1 } } }, async (ctx) => {
	const log = [];
	installToolBarrier(ctx.session.agent, ["read"], log);
	await ctx.session.prompt("first");
	await ctx.session.prompt("second");
	const before = ctx.server.state.count;
	let compactError = null, compactResult = null;
	try { compactResult = await ctx.session.compact(); } catch (e) { compactError = String(e?.message ?? e); }
	return { ok: compactError?.includes("TOOL_BARRIER") && ctx.server.state.count === before, detail: { requestsBeforeCompact: before, requestsAfter: ctx.server.state.count, barrier: log, compactError, compactResult: compactResult && Object.keys(compactResult) } };
});

// A9: fact probe — upstream requiredTools diagnostic throws from agent_start; does that block the request?
const throwingAgentStart = { name: "throwing-agent-start", factory: (api) => api.on("agent_start", () => { throw new Error("deny from agent_start"); }) };
await scenario("C1.A9 fact: throwing agent_start handler does NOT block", { tools: ["read"], hooks: [throwingAgentStart] }, async (ctx) => {
	await ctx.session.prompt("hi");
	return { ok: ctx.server.state.count === 1 && ctx.extErrors.some((e) => e.event === "agent_start"), detail: { requests: ctx.server.state.count, extErrors: ctx.extErrors, end: last(ctx.events) } };
});

console.log(`externalFetches=${JSON.stringify(externalFetches)}`);
console.log(`C1 SUMMARY: ${results.filter(Boolean).length}/${results.length} PASS`);
process.exit(0);
