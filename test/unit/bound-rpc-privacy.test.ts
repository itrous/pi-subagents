import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { getBoundRunRegistry } from "../../src/bound/bound-run-registry.ts";
import { createBoundFixture, type BoundFixture } from "../fixtures/bound/harness.ts";
import { createExecutorStand, createRpcClient as rpcClient, until } from "../support/bound-executor.ts";
import { admitBoundLaunch } from "../support/bound-launch.ts";

let fixture: BoundFixture;
let stand: ReturnType<typeof createExecutorStand> | undefined;
const opened: string[] = [];
beforeEach(() => { fixture = createBoundFixture(); });
afterEach(() => {
	stand?.dispose();
	stand = undefined;
	for (const runId of opened.splice(0)) getBoundRunRegistry().close(runId);
	fixture.cleanup();
});

async function startBound(current: ReturnType<typeof createExecutorStand>): Promise<{ runId: string; done: Promise<unknown> }> {
	const launch = await admitBoundLaunch(fixture);
	opened.push(launch.contract.prospectiveRunId);
	const done = current.run(current.bound(launch));
	await until(() => current.boundProbe.prompts > 0 && current.state.foregroundControls.has(launch.contract.prospectiveRunId), "bound run live");
	return { runId: launch.contract.prospectiveRunId, done };
}

async function startPlain(current: ReturnType<typeof createExecutorStand>): Promise<{ runId: string; done: Promise<unknown> }> {
	const launch = await admitBoundLaunch(fixture);
	const done = current.run(current.plain(launch));
	await until(() => current.plainLaunches.length > 0, "plain child");
	const runId = current.plainLaunches[0]!.runtime.runId!;
	await until(() => current.state.foregroundControls.has(runId), "plain run live");
	return { runId, done };
}

/** A targeted request about the bound run must answer exactly like one about an id nobody knows. */
async function assertAnswersAsUnknown(rpc: ReturnType<typeof rpcClient>, method: string, params: Record<string, unknown>, runId: string): Promise<void> {
	const unknown = randomUUID();
	const aboutBound = await rpc(method, { ...params, id: runId }, "same-request");
	const aboutUnknown = await rpc(method, { ...params, id: unknown }, "same-request");
	assert.deepEqual(aboutBound, JSON.parse(JSON.stringify(aboutUnknown).replaceAll(unknown, runId)), method);
}

test("a live bound run is invisible to Fleet and answers like an unknown id to status, steer, interrupt and resume", async () => {
	stand = createExecutorStand(fixture);
	const rpc = rpcClient(stand);
	const bound = await startBound(stand);

	const status = await rpc("status");
	assert.equal(status.success, true);
	assert.equal((status.data!.fleet as { totalActive: number }).totalActive, 0);
	assert.equal(JSON.stringify(status).includes(bound.runId), false);

	await assertAnswersAsUnknown(rpc, "status", {}, bound.runId);
	await assertAnswersAsUnknown(rpc, "steer", { message: "change course" }, bound.runId);
	await assertAnswersAsUnknown(rpc, "interrupt", {}, bound.runId);
	await assertAnswersAsUnknown(rpc, "resume", { message: "go on" }, bound.runId);
	// A unique prefix names the run to the upstream resolver, so it is hidden too.
	await assertAnswersAsUnknown(rpc, "status", {}, bound.runId.slice(0, 8));

	const interruptWithoutId = await rpc("interrupt");
	assert.equal(interruptWithoutId.success, false);
	assert.equal(JSON.stringify(interruptWithoutId).includes(bound.runId), false);
	assert.equal(stand.boundProbe.aborts, 0, "the bound attempt was not interrupted");
	stand.release();
	await bound.done;
});

test("positive control: a non-bound run beside it is visible, interruptible without an id, and named", async () => {
	stand = createExecutorStand(fixture);
	const rpc = rpcClient(stand);
	// The bound run is the newest control, so a selection without a filter would pick it.
	const plain = await startPlain(stand);
	const bound = await startBound(stand);
	assert.equal(stand.state.lastForegroundControlId, bound.runId);

	const status = await rpc("status");
	assert.equal((status.data!.fleet as { totalActive: number }).totalActive, 1);
	assert.equal(JSON.stringify(status).includes(bound.runId), false);
	const targeted = await rpc("status", { id: plain.runId });
	assert.equal(targeted.success, true);

	const interrupted = await rpc("interrupt");
	assert.equal(interrupted.success, true, JSON.stringify(interrupted));
	assert.ok(JSON.stringify(interrupted).includes(plain.runId), "the reply names the public run");
	assert.equal(JSON.stringify(interrupted).includes(bound.runId), false);
	await until(() => stand!.plainAborts.length > 0, "plain child aborted");
	assert.equal(stand.boundProbe.aborts, 0, "the newest public control was chosen, not the bound one");
	stand.release();
	await Promise.all([bound.done, plain.done]);
});

const text = (reply: unknown): string => JSON.stringify(reply);

test("status views without an id show neither the bound run id, its agent, nor its transcript", async () => {
	stand = createExecutorStand(fixture);
	const rpc = rpcClient(stand);
	const bound = await startBound(stand);
	for (const view of ["fleet", "transcript"] as const) {
		const reply = await rpc("status", { view });
		assert.equal(text(reply).includes(bound.runId), false, view);
		assert.equal(text(reply).includes("reviewer"), false, `${view}: the agent name`);
		assert.equal(text(reply).includes("Review the diff."), false, `${view}: the task text`);
	}
	stand.release();
	await bound.done;
});

test("the subagent tool's own status by id or prefix answers as if the bound run did not exist", async () => {
	stand = createExecutorStand(fixture);
	const current = stand;
	const bound = await startBound(current);
	const status = async (id: string) => {
		const result = await current.executor.executePublic("tool-status", { action: "status", id }, new AbortController().signal, undefined, current.ctx as never);
		return { isError: result.isError, content: result.content };
	};
	for (const target of [bound.runId, bound.runId.slice(0, 8)]) {
		const unknown = target === bound.runId ? randomUUID() : "ffffffff";
		const aboutBound = await status(target);
		const aboutUnknown = await status(unknown);
		assert.deepEqual(aboutBound, JSON.parse(text(aboutUnknown).replaceAll(unknown, target)));
		assert.equal(text(aboutBound).includes("reviewer"), false);
	}
	current.release();
	await bound.done;
});

test("positive control: a public run is visible in the same status views and by id", async () => {
	stand = createExecutorStand(fixture);
	const current = stand;
	const rpc = rpcClient(current);
	const plain = await startPlain(current);
	const bound = await startBound(current);
	const fleet = await rpc("status", { view: "fleet" });
	assert.ok(text(fleet).includes(plain.runId), "fleet view names the public run");
	assert.equal(text(fleet).includes(bound.runId), false);
	const byId = await current.executor.executePublic("tool-status", { action: "status", id: plain.runId }, new AbortController().signal, undefined, current.ctx as never);
	assert.ok(text(byId).includes("reviewer"), "the public run's agent is shown");
	current.release();
	await Promise.all([bound.done, plain.done]);
});
