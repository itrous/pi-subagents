import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createLaunchReceiptService } from "../../src/api/launch-receipt.ts";
import { createBoundRuntimeService, type BoundPreflightSuccessV2, type BoundRuntimeService, type BoundRuntimeServiceOptions } from "../../src/bound/bound-runtime-service.ts";
import { BOUND_CHANNEL_VERSION, type BoundBindingV2 } from "../../src/bound/channel.ts";
import {
	createBoundFixture, FIXTURE_SERVER_INSTANCE_ID, fixtureSourceIdentity, type BoundFixture,
} from "../fixtures/bound/harness.ts";

let fixture: BoundFixture;
const services: BoundRuntimeService[] = [];

beforeEach(() => { fixture = createBoundFixture(); });
afterEach(() => {
	while (services.length) services.pop()!.dispose();
	fixture.cleanup();
});

function service(overrides: Record<string, unknown> = {}): BoundRuntimeService {
	const created = createBoundRuntimeService(fixture.serviceOptions(overrides) as unknown as BoundRuntimeServiceOptions);
	services.push(created);
	return created;
}

async function preflight(target: BoundRuntimeService, requestOverrides: Record<string, unknown> = {}) {
	return target.preflight(fixture.request(requestOverrides));
}

async function successful(target: BoundRuntimeService, requestOverrides: Record<string, unknown> = {}): Promise<BoundPreflightSuccessV2> {
	const outcome = await preflight(target, requestOverrides);
	assert.ok(outcome, "expected an answer for our own target");
	assert.equal(outcome.ok, true, outcome.ok ? "" : `refused with ${outcome.error.code}`);
	if (!outcome.ok) throw new Error("unreachable");
	return outcome.data;
}

function bindingOf(data: BoundPreflightSuccessV2): BoundBindingV2 {
	return {
		version: BOUND_CHANNEL_VERSION,
		targetServerInstanceId: data.serverInstanceId,
		prospectiveRunId: data.launchContract.prospectiveRunId,
		expectedSourceIdentityDigest: data.sourceIdentityDigest,
		expectedActiveSessionDigest: data.activeSessionDigest,
		requestDigest: data.requestDigest,
		expectedLaunchContractDigest: data.launchContractDigest,
		receipt: data.receipt,
		cancellationToken: data.cancellationToken,
	};
}

test("a successful preflight answers with exactly the declared keys", async () => {
	const data = await successful(service());
	assert.deepEqual(Object.keys(data).sort(), [
		"activeSessionDigest", "canonicalCwd", "cancellationToken", "launchContract", "launchContractDigest",
		"receipt", "requestDigest", "serverInstanceId", "sourceIdentityDigest", "version",
	].sort());
	assert.equal(data.version, 2);
	assert.equal(data.serverInstanceId, FIXTURE_SERVER_INSTANCE_ID);
	assert.equal(data.launchContractDigest, data.launchContract.digest);
	assert.equal(data.receipt.payload.launchContractDigest, data.launchContractDigest);
	assert.equal(data.cancellationToken.payload.requestId, "request-1");
});

test("a request addressed to another responder is silence, not a refusal", async () => {
	assert.equal(await preflight(service(), { targetServerInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }), undefined);
	assert.equal(await service().preflight({ nonsense: true }), undefined);
});

test("every refusal code is reachable and the body is only version and code", async () => {
	const expectations: Array<{ code: string; run: () => Promise<unknown> }> = [
		{ code: "invalid_request", run: () => preflight(service(), { turnBudget: { maxTurns: 2 } }) },
		{ code: "unverified_source", run: () => preflight(service({ resolveSourceIdentity: () => fixtureSourceIdentity(false) })) },
		{ code: "no_active_session", run: () => preflight(service({ getContext: () => null })) },
		{ code: "unverified_runtime", run: () => preflight(service({ attestRuntime: async () => ({ ok: false as const, code: "unverified_runtime" as const }) })) },
		{ code: "invalid_cwd", run: () => preflight(service(), { cwd: path.join(fixture.tempRoot, "absent") }) },
		{ code: "missing_agent", run: () => preflight(service(), { agent: "absent-agent" }) },
		{ code: "missing_skill", run: () => preflight(service(), { skill: "absent-skill" }) },
		{ code: "unavailable_model", run: () => preflight(service(), { model: "openai/absent" }) },
		{ code: "host_required", run: () => preflight(service({ config: { ...fixture.config, defaultSessionDir: path.join(fixture.tempRoot, "missing", "deep") } })) },
		{ code: "restricted_agent", run: () => preflight(service({ resolveCapabilityCeiling: () => ({ version: 1, allowedAgents: ["other"], denyExtensions: false, sources: ["test"] }) })) },
	];
	for (const expectation of expectations) {
		const outcome = await expectation.run() as { ok: boolean; error?: Record<string, unknown> } | undefined;
		assert.ok(outcome, `expected an answer for ${expectation.code}`);
		assert.equal(outcome.ok, false, `expected ${expectation.code} to refuse`);
		assert.deepEqual(outcome.error, { version: 2, code: expectation.code });
		assert.deepEqual(Object.keys(outcome.error!).sort(), ["code", "version"]);
	}
});

test("an unsupported agent mode is a closed code as well", async () => {
	fixture.writeAgent(fs.readFileSync(fixture.agentPath, "utf8").replace("inheritSkills: false", "inheritSkills: true"));
	const outcome = await preflight(service());
	assert.deepEqual(outcome, { ok: false, error: { version: 2, code: "unsupported_mode" } });
});

test("a receipt is accepted only when it is ours, live, and unmodified", async () => {
	let now = 1_000;
	const receipts = createLaunchReceiptService({ secret: new Uint8Array(32).fill(3), clock: () => now });
	const own = service({ receipts });
	const data = await successful(own);
	const binding = bindingOf(data);
	assert.ok(own.verifyActiveCancellation({ requestId: "request-1", ownerRunId: "owner-1", nodeId: "node-1" }, binding));
	// Подменённый receipt обязан дать отказ: исключение вылетело бы из синхронного
	// обработчика шины и потеряло бы отмену.
	for (const broken of [{}, { payload: null }, { payload: 1 }]) {
		const tampered = { ...binding, receipt: broken } as unknown as typeof binding;
		assert.equal(own.verifyActiveCancellation({ requestId: "request-1", ownerRunId: "owner-1", nodeId: "node-1" }, tampered), undefined);
		assert.equal(own.verifyPendingCancellation({ requestId: "request-1", ownerRunId: "owner-1", nodeId: "node-1" }, tampered), undefined);
	}
	// A foreign service holds a different secret.
	const foreign = service({ receipts: createLaunchReceiptService({ secret: new Uint8Array(32).fill(9), clock: () => now }) });
	assert.equal(foreign.verifyActiveCancellation({ requestId: "request-1", ownerRunId: "owner-1", nodeId: "node-1" }, binding), undefined);
	// Two services with identical payloads must not produce the same MAC.
	const mirrored = service({ receipts: createLaunchReceiptService({ secret: new Uint8Array(32).fill(9), clock: () => now }) });
	const mirroredData = await successful(mirrored);
	assert.equal(mirroredData.receipt.payload.launchContractDigest, data.receipt.payload.launchContractDigest);
	assert.notEqual(mirroredData.receipt.mac, data.receipt.mac);
	// Tampering with any payload field invalidates the MAC.
	const tampered = structuredClone(binding);
	tampered.cancellationToken.payload.nodeId = "node-2";
	assert.equal(own.verifyActiveCancellation({ requestId: "request-1", ownerRunId: "owner-1", nodeId: "node-2" }, tampered), undefined);
	// TTL закрывает окно приёма, а не жизнь принятой попытки (семантика A1).
	now = 1_000 + 30_000;
	// Pending-отмена приходит до приёма и живёт внутри того же окна.
	assert.equal(own.verifyPendingCancellation({ requestId: "request-1", ownerRunId: "owner-1", nodeId: "node-1" }, binding), undefined);
	// Принятая попытка работает дольше окна (таймаут листа — минуты), и адресная
	// отмена обязана её останавливать: проверяется подлинность, а не срок.
	assert.ok(own.verifyActiveCancellation({ requestId: "request-1", ownerRunId: "owner-1", nodeId: "node-1" }, binding));
	// Приём после истечения окна закрыт.
	assert.deepEqual(await own.admit(fixture.request(), binding), { ok: false, code: "invalid_request" });
	own.dispose();
	assert.equal(own.verifyPendingCancellation({ requestId: "request-1", ownerRunId: "owner-1", nodeId: "node-1" }, binding), undefined);
	assert.equal(own.verifyActiveCancellation({ requestId: "request-1", ownerRunId: "owner-1", nodeId: "node-1" }, binding), undefined);
});

test("admission repeats the whole resolution and refuses a drifted agent or binding", async () => {
	const own = service();
	const data = await successful(own);
	const binding = bindingOf(data);
	// Positive control: nothing changed, so the same input is admitted.
	const admitted = await own.admit(fixture.request(), binding);
	assert.equal(admitted.ok, true, admitted.ok ? "" : `refused with ${admitted.code}`);
	if (admitted.ok) assert.equal(admitted.launch.contract.digest, data.launchContractDigest);
	// Agent bytes changed between preflight and admission.
	fixture.writeAgent(fs.readFileSync(fixture.agentPath, "utf8").replace("Reviews a diff.", "Reviews a patch."));
	assert.deepEqual(await own.admit(fixture.request(), binding), { ok: false, code: "invalid_request" });
});

test("a binding changed after preflight is not admitted", async () => {
	const own = service();
	const data = await successful(own, { bindings: { ONECPI_REVIEW_ROOT: "/root" } });
	const binding = bindingOf(data);
	assert.equal((await own.admit(fixture.request({ bindings: { ONECPI_REVIEW_ROOT: "/root" } }), binding)).ok, true);
	assert.deepEqual(await own.admit(fixture.request({ bindings: { ONECPI_REVIEW_ROOT: "/other" } }), binding), { ok: false, code: "invalid_request" });
	assert.deepEqual(await own.admit(fixture.request(), binding), { ok: false, code: "invalid_request" });
});

test("a malformed or foreign binding never admits", async () => {
	const own = service();
	const data = await successful(own);
	const binding = bindingOf(data);
	assert.deepEqual(await own.admit(fixture.request(), { ...binding, targetServerInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }), { ok: false, code: "invalid_request" });
	assert.deepEqual(await own.admit(fixture.request(), { ...binding, extra: 1 }), { ok: false, code: "invalid_request" });
	assert.deepEqual(await own.admit(fixture.request(), undefined), { ok: false, code: "invalid_request" });
	assert.deepEqual(await own.admit({ nonsense: true }, binding), { ok: false, code: "invalid_request" });
});
