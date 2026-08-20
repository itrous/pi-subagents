import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
test("bound denial runtime records redacted decisions at agent_settled using captured primordials", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bound-denial-runtime-")); const proof = path.join(dir, "proof"); const fd = fs.openSync(proof, "w");
	const runtimeUrl = pathToFileURL(path.join(root, "src/runs/shared/bound-denied-tool-runtime.ts")).href;
	const statePath = path.join(root, "src/runs/shared/bound-tool-registry-state.cjs");
	const script = `import { createRequire } from 'node:module'; import fs from 'node:fs'; const holder=createRequire(import.meta.url)(${JSON.stringify(statePath)}); holder.state={policy:{proofNonce:'${"a".repeat(64)}',denialFd:4},denialCalls:[],denialOverflow:false,denialWritten:false,exit:(code)=>{throw new Error('exit:'+code)}}; const m=await import(${JSON.stringify(runtimeUrl)}); const handlers={}; m.registerBoundDeniedToolLifecycle({on:(name,handler)=>{handlers[name]=handler}}); m.recordBoundDeniedTool('read','permission_rule'); JSON.stringify=()=>{throw new Error('ambient stringify')}; fs.writeSync=()=>{throw new Error('ambient write')}; handlers.agent_settled(); handlers.session_shutdown();`;
	const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "ignore", fd] }); fs.closeSync(fd);
	try { assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(fs.readFileSync(proof, "utf8")), { version: 1, kind: "denied_tool_calls", calls: [{ tool: "read", reason: "permission_rule" }], overflow: false, proofNonce: "a".repeat(64) }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("session_shutdown emits the one-shot empty fallback proof without agent_settled", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bound-denial-shutdown-")); const proof = path.join(dir, "proof"); const fd = fs.openSync(proof, "w");
	const runtimeUrl = pathToFileURL(path.join(root, "src/runs/shared/bound-denied-tool-runtime.ts")).href; const statePath = path.join(root, "src/runs/shared/bound-tool-registry-state.cjs");
	const script = `import { createRequire } from 'node:module'; const holder=createRequire(import.meta.url)(${JSON.stringify(statePath)}); holder.state={policy:{proofNonce:'${"b".repeat(64)}',denialFd:4},denialCalls:[],denialOverflow:false,denialWritten:false,exit:(code)=>{throw new Error('exit:'+code)}}; const m=await import(${JSON.stringify(runtimeUrl)}); const handlers={}; m.registerBoundDeniedToolLifecycle({on:(name,handler)=>{handlers[name]=handler}}); handlers.session_shutdown();`;
	const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "ignore", fd] }); fs.closeSync(fd);
	try { assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(fs.readFileSync(proof, "utf8")), { version: 1, kind: "denied_tool_calls", calls: [], overflow: false, proofNonce: "b".repeat(64) }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
