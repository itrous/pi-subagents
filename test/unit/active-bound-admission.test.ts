import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseActiveBoundPreflightRequest } from "../../src/api/active-bound-preflight.ts";
import { createActiveBoundRuntimeService } from "../../src/api/active-bound-runtime.ts";
import { createLaunchReceiptService, type LaunchReceiptService } from "../../src/api/launch-receipt.ts";

function fixture(config: Record<string, unknown> = {}, receipts?: LaunchReceiptService) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bound-admission-"));
	const project = path.join(root, "project");
	fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(path.join(project, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: Worker\ntools: read\n---\nWorker\n");
	const sessionRoot = path.join(root, "children"); fs.mkdirSync(sessionRoot);
	const request = parseActiveBoundPreflightRequest({
		version: 1, targetServerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", requestId: "request", ownerRunId: "owner", nodeId: "node",
		prospectiveRunId: "123e4567-e89b-12d3-a456-426614174000", agent: "worker", task: "Inspect", cwd: project,
		context: "fresh", model: "test/exact", thinking: "off", artifacts: false, result: { kind: "text" },
	});
	assert.equal(request.ok, true);
	const ctx = {
		cwd: project,
		isProjectTrusted: () => true,
		sessionManager: { getSessionFile: () => path.join(root, "parent.jsonl"), getSessionId: () => "pi-session" },
		modelRegistry: { getAvailable: () => [{ provider: "test", id: "exact", fullId: "test/exact", api: "openai-responses", reasoning: false }] },
	} as any;
	const runtimeConfig = { defaultSessionDir: sessionRoot, ...config };
	const runtime = createActiveBoundRuntimeService({
		serverInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceIdentityDigest: "a".repeat(64), getContext: () => ctx,
		config: runtimeConfig, waitToolEnabled: false, resolveCapabilityCeiling: () => undefined,
		receipts,
	});
	return { root, project, sessionRoot, request: request.request, runtime, runtimeConfig };
}

describe("active-bound runtime admission", () => {
	it("issues a closed response and admits only its exact proof", () => {
		const f = fixture();
		try {
			const response = f.runtime.preflight(f.request);
			assert.equal("code" in response, false, JSON.stringify(response));
			if ("code" in response) return;
			assert.deepEqual(Object.keys(response), ["version", "serverInstanceId", "sourceIdentityDigest", "activeSessionDigest", "canonicalCwd", "requestDigest", "launchContract", "launchContractDigest", "receipt", "cancellationToken"]);
			const binding = {
				version: 1 as const, targetServerInstanceId: response.serverInstanceId, prospectiveRunId: f.request.prospectiveRunId,
				expectedSourceIdentityDigest: response.sourceIdentityDigest, expectedActiveSessionDigest: response.activeSessionDigest,
				requestDigest: response.requestDigest, expectedLaunchContractDigest: response.launchContractDigest, receipt: response.receipt, cancellationToken: response.cancellationToken,
			};
			assert.equal(f.runtime.verifyPendingCancellation({ requestId: f.request.requestId, ownerRunId: f.request.ownerRunId, nodeId: f.request.nodeId }, binding), true);
			assert.equal(f.runtime.verifyPendingCancellation({ requestId: "wrong", ownerRunId: f.request.ownerRunId, nodeId: f.request.nodeId }, binding), false);
			const admitted = f.runtime.admit(f.request, binding);
			assert.equal(admitted.ok, true);
			if (!admitted.ok) return;
			assert.equal(f.runtime.recheck(admitted.proof), true);
			assert.equal(f.runtime.recheck(admitted.proof, { ownedRootIdentity: { dev: 0, ino: 0 } }), false);
			assert.equal(f.runtime.admit(f.request, { ...binding, requestDigest: "b".repeat(64) }).ok, false);
			const rootPath = path.join(f.sessionRoot, f.request.prospectiveRunId);
			fs.mkdirSync(rootPath);
			const owned = fs.lstatSync(rootPath);
			const identity = { dev: owned.dev, ino: owned.ino };
			assert.equal(f.runtime.recheck(admitted.proof), false);
			assert.equal(f.runtime.recheck(admitted.proof, { ownedRootIdentity: identity }), true);
			fs.rmSync(rootPath, { recursive: true }); fs.mkdirSync(rootPath);
			assert.equal(f.runtime.recheck(admitted.proof, { ownedRootIdentity: identity }), false);
		} finally { f.runtime.dispose(); fs.rmSync(f.root, { recursive: true, force: true }); }
	});

	it("claims a future base without preflight or admission filesystem writes", () => {
		const f = fixture(); fs.rmdirSync(f.sessionRoot);
		try {
			const beforeEntries = fs.readdirSync(f.root, { recursive: true }).map(String).sort();
			const response = f.runtime.preflight(f.request); assert.equal("code" in response, false, JSON.stringify(response)); if ("code" in response) return;
			assert.equal(fs.existsSync(f.sessionRoot), false);
			assert.deepEqual(fs.readdirSync(f.root, { recursive: true }).map(String).sort(), beforeEntries);
			const binding = { version: 1 as const, targetServerInstanceId: response.serverInstanceId, prospectiveRunId: f.request.prospectiveRunId, expectedSourceIdentityDigest: response.sourceIdentityDigest, expectedActiveSessionDigest: response.activeSessionDigest, requestDigest: response.requestDigest, expectedLaunchContractDigest: response.launchContractDigest, receipt: response.receipt, cancellationToken: response.cancellationToken };
			const admitted = f.runtime.admit(f.request, binding); assert.equal(admitted.ok, true); if (!admitted.ok) return;
			assert.equal(fs.existsSync(f.sessionRoot), false);
			assert.deepEqual(fs.readdirSync(f.root, { recursive: true }).map(String).sort(), beforeEntries);
			fs.mkdirSync(f.sessionRoot); const base = fs.lstatSync(f.sessionRoot); const baseIdentity = { dev: base.dev, ino: base.ino };
			assert.equal(f.runtime.claimBase(admitted.proof, baseIdentity, true), true);
			const runRoot = path.join(f.sessionRoot, f.request.prospectiveRunId); const runDir = path.join(runRoot, "run-0"); fs.mkdirSync(runDir, { recursive: true });
			const rootStat = fs.lstatSync(runRoot); const dirStat = fs.lstatSync(runDir);
			assert.equal(f.runtime.recheck(admitted.proof, { ownedBaseRootIdentity: baseIdentity, ownedRootIdentity: { dev: rootStat.dev, ino: rootStat.ino }, ownedSessionDirIdentity: { dev: dirStat.dev, ino: dirStat.ino } }), true);
			fs.rmdirSync(runDir); fs.mkdirSync(runDir);
			assert.equal(f.runtime.recheck(admitted.proof, { ownedBaseRootIdentity: baseIdentity, ownedRootIdentity: { dev: rootStat.dev, ino: rootStat.ino }, ownedSessionDirIdentity: { dev: dirStat.dev, ino: dirStat.ino } }), false);
			fs.renameSync(f.sessionRoot, `${f.sessionRoot}-old`); fs.mkdirSync(f.sessionRoot);
			assert.equal(f.runtime.recheck(admitted.proof, { ownedBaseRootIdentity: baseIdentity, ownedRootIdentity: { dev: rootStat.dev, ino: rootStat.ino }, ownedSessionDirIdentity: { dev: dirStat.dev, ino: dirStat.ino } }), false);
		} finally { f.runtime.dispose(); fs.rmSync(f.root, { recursive: true, force: true }); }
	});

	it("keeps exact active cancellation authority after admission TTL", () => {
		let now = 1000;
		const receipts = createLaunchReceiptService({ secret: Buffer.alloc(32, 4), clock: () => now });
		const f = fixture({}, receipts);
		try {
			const response = f.runtime.preflight(f.request);
			assert.equal("code" in response, false, JSON.stringify(response));
			if ("code" in response) return;
			const binding = { version: 1 as const, targetServerInstanceId: response.serverInstanceId, prospectiveRunId: f.request.prospectiveRunId, expectedSourceIdentityDigest: response.sourceIdentityDigest, expectedActiveSessionDigest: response.activeSessionDigest, requestDigest: response.requestDigest, expectedLaunchContractDigest: response.launchContractDigest, receipt: response.receipt, cancellationToken: response.cancellationToken };
			assert.equal(f.runtime.admit(f.request, binding).ok, true);
			now = response.receipt.payload.expiresAt;
			assert.equal(f.runtime.verifyPendingCancellation(f.request, binding), false);
			assert.equal(f.runtime.verifyActiveCancellation(f.request, binding), true);
			assert.equal(f.runtime.verifyActiveCancellation({ ...f.request, nodeId: "wrong" }, binding), false);
		} finally { f.runtime.dispose(); fs.rmSync(f.root, { recursive: true, force: true }); }
	});

	it("binds the same validated config timeout used by foreground execution", () => {
		for (const [configured, expected] of [[12_345, 12_345], [2_147_483_648, 30 * 60 * 1000], [-1, 30 * 60 * 1000]] as const) {
			const f = fixture({ timeoutMs: configured });
			try {
				const response = f.runtime.preflight(f.request);
				assert.equal("code" in response, false, JSON.stringify(response));
				if (!("code" in response)) assert.equal(response.launchContract.timeoutMs, expected);
			} finally { f.runtime.dispose(); fs.rmSync(f.root, { recursive: true, force: true }); }
		}
	});

	it("rejects a future base whose immediate parent is absent", () => {
		const f = fixture();
		const missingParent = path.join(f.root, "missing-parent");
		f.runtimeConfig.defaultSessionDir = path.join(missingParent, "children");
		try {
			assert.deepEqual(f.runtime.preflight(f.request), { version: 1, code: "host_required" });
			assert.equal(fs.existsSync(missingParent), false);
		} finally { f.runtime.dispose(); fs.rmSync(f.root, { recursive: true, force: true }); }
	});

	it("rejects replacement of a future base parent", () => {
		const f = fixture();
		const baseParent = path.join(f.root, "base-parent");
		fs.mkdirSync(baseParent);
		f.runtimeConfig.defaultSessionDir = path.join(baseParent, "children");
		try {
			const response = f.runtime.preflight(f.request);
			assert.equal("code" in response, false, JSON.stringify(response));
			if ("code" in response) return;
			const binding = { version: 1 as const, targetServerInstanceId: response.serverInstanceId, prospectiveRunId: f.request.prospectiveRunId, expectedSourceIdentityDigest: response.sourceIdentityDigest, expectedActiveSessionDigest: response.activeSessionDigest, requestDigest: response.requestDigest, expectedLaunchContractDigest: response.launchContractDigest, receipt: response.receipt, cancellationToken: response.cancellationToken };
			const admitted = f.runtime.admit(f.request, binding);
			assert.equal(admitted.ok, true);
			if (!admitted.ok) return;
			fs.renameSync(baseParent, `${baseParent}-old`); fs.mkdirSync(baseParent);
			assert.equal(f.runtime.recheck(admitted.proof), false);
		} finally { f.runtime.dispose(); fs.rmSync(f.root, { recursive: true, force: true }); }
	});

	it("rejects config timeout drift during recheck", () => {
		const f = fixture({ timeoutMs: 12_345 });
		try {
			const response = f.runtime.preflight(f.request);
			assert.equal("code" in response, false, JSON.stringify(response));
			if ("code" in response) return;
			const binding = { version: 1 as const, targetServerInstanceId: response.serverInstanceId, prospectiveRunId: f.request.prospectiveRunId, expectedSourceIdentityDigest: response.sourceIdentityDigest, expectedActiveSessionDigest: response.activeSessionDigest, requestDigest: response.requestDigest, expectedLaunchContractDigest: response.launchContractDigest, receipt: response.receipt, cancellationToken: response.cancellationToken };
			const admitted = f.runtime.admit(f.request, binding);
			assert.equal(admitted.ok, true);
			if (!admitted.ok) return;
			f.runtimeConfig.timeoutMs = 54_321;
			assert.equal(f.runtime.recheck(admitted.proof), false);
		} finally { f.runtime.dispose(); fs.rmSync(f.root, { recursive: true, force: true }); }
	});

	it("rejects max-depth config drift during recheck", () => {
		const f = fixture({ maxSubagentDepth: 3 });
		try {
			const response = f.runtime.preflight(f.request);
			assert.equal("code" in response, false, JSON.stringify(response));
			if ("code" in response) return;
			const binding = { version: 1 as const, targetServerInstanceId: response.serverInstanceId, prospectiveRunId: f.request.prospectiveRunId, expectedSourceIdentityDigest: response.sourceIdentityDigest, expectedActiveSessionDigest: response.activeSessionDigest, requestDigest: response.requestDigest, expectedLaunchContractDigest: response.launchContractDigest, receipt: response.receipt, cancellationToken: response.cancellationToken };
			const admitted = f.runtime.admit(f.request, binding);
			assert.equal(admitted.ok, true);
			if (!admitted.ok) return;
			f.runtimeConfig.maxSubagentDepth = 2;
			assert.equal(f.runtime.recheck(admitted.proof), false);
		} finally { f.runtime.dispose(); fs.rmSync(f.root, { recursive: true, force: true }); }
	});

	it("rejects when inherited depth is already exhausted", () => {
		const previousDepth = process.env.PI_SUBAGENT_DEPTH; const previousMax = process.env.PI_SUBAGENT_MAX_DEPTH;
		process.env.PI_SUBAGENT_DEPTH = "1"; process.env.PI_SUBAGENT_MAX_DEPTH = "1";
		const f = fixture({ maxSubagentDepth: 2 });
		try { assert.deepEqual(f.runtime.preflight(f.request), { version: 1, code: "restricted_agent" }); }
		finally {
			f.runtime.dispose(); fs.rmSync(f.root, { recursive: true, force: true });
			if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH; else process.env.PI_SUBAGENT_DEPTH = previousDepth;
			if (previousMax === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH; else process.env.PI_SUBAGENT_MAX_DEPTH = previousMax;
		}
	});

	it("rejects drift and a prospective root collision without consuming filesystem state", () => {
		const f = fixture();
		try {
			const response = f.runtime.preflight(f.request); assert.equal("code" in response, false, JSON.stringify(response)); if ("code" in response) return;
			const binding = { version: 1 as const, targetServerInstanceId: response.serverInstanceId, prospectiveRunId: f.request.prospectiveRunId, expectedSourceIdentityDigest: response.sourceIdentityDigest, expectedActiveSessionDigest: response.activeSessionDigest, requestDigest: response.requestDigest, expectedLaunchContractDigest: response.launchContractDigest, receipt: response.receipt, cancellationToken: response.cancellationToken };
			fs.mkdirSync(path.join(f.sessionRoot, f.request.prospectiveRunId));
			assert.equal(f.runtime.admit(f.request, binding).ok, false);
			fs.rmSync(path.join(f.sessionRoot, f.request.prospectiveRunId), { recursive: true });
			fs.appendFileSync(path.join(f.project, ".pi", "agents", "worker.md"), "drift");
			assert.equal(f.runtime.admit(f.request, binding).ok, false);
		} finally { f.runtime.dispose(); fs.rmSync(f.root, { recursive: true, force: true }); }
	});
});
