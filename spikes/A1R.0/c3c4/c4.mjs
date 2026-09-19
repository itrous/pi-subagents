// C4: two parallel in-process child sessions with different cwd and bindings.
// usage (cwd = ws/parent): node ../../c4.mjs
import path from "node:path";
import { createChild, toolResultsOf, writeModelsJson, envSnapshot } from "./host.mjs";
import { startFauxLlm } from "./faux-llm.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const agentDir = process.env.PI_CODING_AGENT_DIR;
const PROBE = path.join(HERE, "ext/probe-ext.ts");
const BINDINGS_ENV = "PI_SUBAGENT_EXTENSION_BINDINGS";
const REGISTRY = Symbol.for("c4.sessionBindings");
globalThis[REGISTRY] = new Map();

const faux = await startFauxLlm();
writeModelsJson(agentDir, faux.port);
const parentCwd = process.cwd();
const snap0 = envSnapshot();

// Inline hook (upstream `hooks` / extensionFactories path): bindings captured in a closure per launch.
const inlineHook = (bindings) => ({
  name: "<inline:c4-probe>",
  factory: (pi) => pi.registerTool({
    name: "probe_inline", label: "probe_inline", description: "closure bindings", parameters: { type: "object", properties: {} },
    async execute(_id, _p, _s, _u, ctx) { return { content: [{ type: "text", text: "INLINE" + JSON.stringify({ ctxCwd: ctx.cwd, closureBindings: bindings }) }] }; },
  }),
});

const specs = [
  { name: "A", cwd: path.join(HERE, "ws/a"), bindings: { "onecpi.review/1": { subject: "A-subject", root: "/root/A" } } },
  { name: "B", cwd: path.join(HERE, "ws/b"), bindings: { "onecpi.review/1": { subject: "B-subject", root: "/root/B" } } },
];
const children = [];
for (const s of specs) {
  const child = await createChild({
    cwd: s.cwd, agentDir, extensionPaths: [PROBE], hooks: [inlineHook(s.bindings)],
    processEnv: { [BINDINGS_ENV]: JSON.stringify(s.bindings) }, windowMode: "bind", // upstream env delivery, window restored
  });
  globalThis[REGISTRY].set(child.session.sessionId, s.bindings); // alternative delivery: Map by session id
  children.push({ ...s, child });
}
const prompt = 'CALLS:[{"name":"probe"},{"name":"probe_inline"},{"name":"read","args":{"path":"hello.txt"}}]';
await Promise.all(children.map(({ child }) => child.session.prompt(prompt)));

const out = { parentCwd, envEqualAfterRuns: envSnapshot() === snap0, sessions: {} };
for (const { name, cwd, bindings, child } of children) {
  const res = toolResultsOf(child.session, Infinity);
  const probe = JSON.parse(res.find((r) => r.tool === "probe").text.slice(5));
  out.sessions[name] = {
    expectedCwd: cwd, sessionId: child.session.sessionId, expectedBindings: bindings,
    probe, inline: JSON.parse(res.find((r) => r.tool === "probe_inline").text.slice(6)),
    read: res.find((r) => r.tool === "read"), errors: child.errors,
  };
}
const [a, b] = [out.sessions.A.probe, out.sessions.B.probe];
out.overlapMs = Math.min(a.endedAt, b.endedAt) - Math.max(a.startedAt, b.startedAt);
for (const { child } of children) await child.dispose();
faux.server.close();
console.log(JSON.stringify(out, null, 2));
process.exit(0);
