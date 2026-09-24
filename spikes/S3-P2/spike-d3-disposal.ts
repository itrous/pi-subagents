// S3 P2 spike D3 (go/no-go before production code): what disposal of a child
// session is observable on the real Pi SDK, for a completed, a hanging and a
// throwing `session_shutdown` handler.
//   usage: PI_SUBAGENTS_NATIVE_SDK=<sdk> node --experimental-strip-types spikes/S3-P2/spike-d3-disposal.ts
// No provider, no network: the session is in memory and never prompted.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDefaultChildSessionFactory, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";

const sdkRoot = process.env.PI_SUBAGENTS_NATIVE_SDK ?? "";
const resolveInSdk = (specifier: string): string => execFileSync(process.execPath, ["--input-type=module", "-e", `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`], { cwd: sdkRoot, encoding: "utf8" }).trim();
const pi = await import(resolveInSdk("@earendil-works/pi-coding-agent")) as PiCodingAgentModule & { VERSION?: string };
assert.equal(pi.VERSION, "0.87.1");
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "s3p2-d3-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "s3p2-d3-cwd-"));

const keepAlive = setInterval(() => {}, 1_000);
type Mode = "completed" | "hang" | "throw";
const results: Record<string, unknown> = { version: pi.VERSION };
for (const mode of ["completed", "hang", "throw"] as Mode[]) {
	let handlerCalls = 0;
	let captured: { cwd?: string; isIdle?: () => boolean } | undefined;
	const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi, shutdownTimeoutMs: 2_000 });
	const child = await factory.create({
		cwd, storage: { kind: "memory" }, extensionPaths: [], noSkills: true, noContextFiles: true, ambientExtensions: false,
		hooks: [{ name: `spike-${mode}`, factory: (api) => {
			api.on("session_start", (_event, ctx) => { captured = ctx as never; });
			api.on("session_shutdown", async () => {
				handlerCalls++;
				if (mode === "hang") await new Promise(() => {});
				if (mode === "throw") throw new Error("shutdown hook failed");
			});
		} }],
		onExtensionError: () => {},
	} as never);
	let staleBefore: string;
	try { captured?.isIdle?.(); staleBefore = "usable"; } catch { staleBefore = "stale"; }
	const started = performance.now();
	await child.dispose();
	const elapsedMs = Math.round(performance.now() - started);
	let staleAfter: string;
	try { captured?.isIdle?.(); staleAfter = "usable"; } catch (error) { staleAfter = String((error as Error).message).includes("stale") ? "stale" : "other-error"; }
	const again = performance.now();
	await child.dispose();
	results[mode] = { handlerCalls, elapsedMs, staleBefore, staleAfter, secondDisposeMs: Math.round(performance.now() - again) };
	await factory.dispose();
}
fs.rmSync(agentDir, { recursive: true, force: true });
fs.rmSync(cwd, { recursive: true, force: true });
clearInterval(keepAlive);
console.log(JSON.stringify(results, null, 2));
