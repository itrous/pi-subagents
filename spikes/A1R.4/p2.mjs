// П2 (Ш0): is a one-shot in-memory session a safe self-check of the Pi fields the
// bound layer depends on (Д9)?  usage: node p2.mjs <agentDir> [--fake-no-stream]
// Measures: provider requests, filesystem drift of the throwaway root, duration.
import fs from "node:fs";
import path from "node:path";
import { PI_ROOT, pi as realPi, writeModelsJson } from "../A1R.0/c3c4/host.mjs";
import { startFauxLlm } from "../A1R.0/c3c4/faux-llm.mjs";

const [agentDirArg, ...flags] = process.argv.slice(2);
const agentDir = path.resolve(agentDirArg);
if (process.env.PI_CODING_AGENT_DIR !== agentDir) throw new Error("run with PI_CODING_AGENT_DIR=" + agentDir);
const fakeNoStream = flags.includes("--fake-no-stream");

const run = path.dirname(agentDir);
const cwd = path.join(run, "ws");
fs.mkdirSync(cwd, { recursive: true });

function snapshot(root) {
	const out = [];
	const walk = (dir) => {
		for (const name of fs.readdirSync(dir).sort()) {
			const abs = path.join(dir, name);
			const st = fs.lstatSync(abs);
			if (st.isDirectory()) { out.push(["d", path.relative(root, abs)]); walk(abs); continue; }
			out.push([st.isSymbolicLink() ? "l" : "f", path.relative(root, abs), st.size, st.mtimeMs]);
		}
	};
	walk(root);
	return JSON.stringify(out);
}

const faux = await startFauxLlm();
writeModelsJson(agentDir, faux.port);

// Positive control for the verdict: a module whose Agent carries no streamFunction.
const pi = fakeNoStream
	? { ...realPi, createAgentSession: async (input) => {
			const { session } = await realPi.createAgentSession(input);
			Object.defineProperty(session, "agent", { value: { ...session.agent, streamFunction: undefined }, configurable: true });
			return { session };
		} }
	: realPi;

/** The self-check exactly as Ш9/Д9 would run it at capability publication. */
async function selfCheck() {
	const modelRuntime = await pi.ModelRuntime.create();
	const settingsManager = pi.SettingsManager.create(cwd, agentDir);
	const loader = new pi.DefaultResourceLoader({
		cwd, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	});
	const hasLoaded = "loaded" in loader;
	const resolved = pi.resolveCliModel({ cliModel: "faux/faux-1", modelRuntime });
	if (resolved.error) throw new Error(resolved.error);
	const sessionManager = pi.SessionManager.inMemory(cwd);
	const { session } = await pi.createAgentSession({
		cwd, agentDir, modelRuntime, model: resolved.model,
		resourceLoader: loader, sessionManager, settingsManager,
		sessionStartEvent: { type: "session_start", reason: "startup" },
	});
	try {
		const agent = session.agent;
		return {
			hasLoaded,
			hasAgent: Boolean(agent),
			hasStreamFunction: typeof agent?.streamFunction === "function",
			hasGetActiveToolNames: typeof session.getActiveToolNames === "function",
			activeToolNamesSample: typeof session.getActiveToolNames === "function" ? session.getActiveToolNames().length : null,
			canShadowStreamFunction: (() => {
				if (!agent || typeof agent.streamFunction !== "function") return false;
				const own = agent.streamFunction;
				try { agent.streamFunction = own; return agent.streamFunction === own; } catch { return false; }
			})(),
		};
	} finally { session.dispose(); }
}

const before = snapshot(run);
const t0 = process.hrtime.bigint();
let checks, error = null;
try { checks = await selfCheck(); } catch (e) { error = String(e?.stack ?? e); }
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
await new Promise((r) => setTimeout(r, 500)); // let any deferred write land before the snapshot
const after = snapshot(run);
faux.server.close();

const verdict = Boolean(checks && checks.hasAgent && checks.hasStreamFunction && checks.hasGetActiveToolNames && checks.hasLoaded);
console.log(JSON.stringify({
	mode: fakeNoStream ? "fake-no-stream" : "real", piRoot: PI_ROOT,
	checks, error, verdict, durationMs: Number(ms.toFixed(1)),
	providerRequests: faux.log.length,
	fsUnchanged: before === after,
	fsDiff: before === after ? null : { before: JSON.parse(before).length, after: JSON.parse(after).length },
}, null, 2));
process.exit(0);
