/**
 * Родительский probe-extension для #4 (package-projection в делегированном
 * спавне). Пингует активный рантайм, затем делегирует два package-листа:
 * rel-leaf (относительный ref, контрольный - работает) и dep-leaf
 * (package:ref на dependency - воспроизводит issue #4).
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY = (id: string) => `subagents:rpc:v1:reply:${id}`;
const DELEGATION_REQUEST = "prompt-template:subagent:request";
const DELEGATION_STARTED = "prompt-template:subagent:started";
const DELEGATION_RESPONSE = "prompt-template:subagent:response";
const MODEL = "probe/child";

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
async function until(predicate: () => boolean, message: string, timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await sleep(20);
	if (!predicate()) throw new Error(`Timed out: ${message}`);
}
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

export default function registerProbe(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "pkg_projection_probe",
		label: "Package Projection Probe",
		description: "Reproduce issue #4: delegated spawn of a package agent with a package:ref.",
		parameters: { type: "object", properties: {}, required: [], additionalProperties: false } as any,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const requestId0 = randomUUID();
			const pings: any[] = [];
			const offPing = pi.events.on(RPC_REPLY(requestId0), (v) => pings.push(v));
			pi.events.emit(RPC_REQUEST, { version: 1, requestId: requestId0, method: "ping" });
			await sleep(150);
			offPing?.();
			assert(pings.length === 1, `expected one responder, got ${pings.length}`);
			assert(pings[0]?.success === true, "ping failed");
			const serverInstanceId = pings[0].data.serverInstanceId;

			const ownerRunId = `pkg-owner-${randomUUID()}`;
			const specs = [
				{ agent: "rel-leaf", task: "REL_0" },
				{ agent: "dep-leaf", task: "DEP_0" },
			];
			const terminals: any[] = [];
			const offs = [
				pi.events.on(DELEGATION_STARTED, () => {}),
				pi.events.on(DELEGATION_RESPONSE, (value) => terminals.push(value)),
			];
			try {
				for (const spec of specs) {
					const requestId = randomUUID(), nodeId = `pkg-${spec.task}`, prospectiveRunId = randomUUID();
					const reply = await new Promise((resolve, reject) => {
						const channel = RPC_REPLY(requestId);
						const t = setTimeout(() => { off2?.(); reject(new Error("preflight timed out")); }, 15_000);
						const off2 = pi.events.on(channel, (v) => { clearTimeout(t); off2?.(); resolve(v); });
						pi.events.emit(RPC_REQUEST, { version: 1, requestId, method: "preflight", params: {
							version: 1, targetServerInstanceId: serverInstanceId, requestId, ownerRunId, nodeId,
							prospectiveRunId, agent: spec.agent, task: spec.task, cwd: ctx.cwd,
							context: "fresh", model: MODEL, thinking: "off", artifacts: false, result: { kind: "text" },
						}});
					});
					process.stderr.write(`PREFLIGHT ${spec.agent}: ${JSON.stringify(reply).slice(0, 400)}\n`);
					assert(reply?.success === true, `${spec.agent} preflight failed: ${JSON.stringify(reply)}`);
					const d = reply.data;
					const binding = { version: 1, targetServerInstanceId: d.serverInstanceId, prospectiveRunId, expectedSourceIdentityDigest: d.sourceIdentityDigest, expectedActiveSessionDigest: d.activeSessionDigest, requestDigest: d.requestDigest, expectedLaunchContractDigest: d.launchContractDigest, receipt: d.receipt, cancellationToken: d.cancellationToken };
					const req = { requestId, ownerRunId, nodeId, agent: spec.agent, task: spec.task, context: "fresh", cwd: ctx.cwd, model: MODEL, thinking: "off", artifacts: false, result: { kind: "text" }, binding };
					process.stderr.write(`EMIT ${spec.agent}: ${JSON.stringify(req).slice(0, 300)}\n`);
					pi.events.emit(DELEGATION_REQUEST, req);
					await until(() => terminals.some((t) => t.requestId === requestId), `${spec.agent} terminal`);
					process.stderr.write(`TERMINAL ${spec.agent}: ${JSON.stringify(terminals.find((t) => t.requestId === requestId)).slice(0, 300)}\n`);
				}
				const out: Record<string, string> = {};
				for (const spec of specs) {
					const terminal = terminals.find((t) => t.nodeId === `pkg-${spec.task}`);
					out[spec.agent] = terminal.status;
				}
				return {
					content: [{ type: "text", text: Object.values(out).every((s) => s === "completed") ? "PKG_PROJECTION_OK" : "PKG_PROJECTION_FAIL" }],
					details: { serverInstanceId, statuses: out },
				};
			} finally {
				for (const dispose of offs) dispose?.();
			}
		},
	});
}
