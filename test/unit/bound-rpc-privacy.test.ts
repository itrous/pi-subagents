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

test("the model's own subagent tool by explicit id or prefix treats a bound run as unknown; positive control: a public run is interrupted", async () => {
	stand = createExecutorStand(fixture);
	const current = stand;
	const plain = await startPlain(current);
	const bound = await startBound(current);
	const tool = async (params: Record<string, unknown>) => {
		const result = await current.executor.executePublic("tool-call", params, new AbortController().signal, undefined, current.ctx as never);
		return { isError: result.isError, content: result.content };
	};
	const cases: Array<Record<string, unknown>> = [
		{ action: "interrupt" }, { action: "steer", message: "change course" }, { action: "resume", message: "go on" }, { action: "stop" }, { action: "dismiss" },
	];
	for (const base of cases) {
		for (const target of [bound.runId, bound.runId.slice(0, 8)]) {
			const unknown = target === bound.runId ? randomUUID() : "ffffffff";
			const aboutBound = await tool({ ...base, id: target });
			const aboutUnknown = await tool({ ...base, id: unknown });
			assert.deepEqual(aboutBound, JSON.parse(JSON.stringify(aboutUnknown).replaceAll(unknown, target)), `${String(base.action)} ${target}`);
		}
	}
	const interruptBound = await tool({ action: "interrupt", id: bound.runId });
	assert.equal(JSON.stringify(interruptBound).includes(bound.runId), false);
	assert.equal(current.boundProbe.aborts, 0, "the bound attempt was not interrupted");

	const interruptPlain = await tool({ action: "interrupt", id: plain.runId });
	assert.equal(interruptPlain.isError, undefined, JSON.stringify(interruptPlain));
	assert.ok(JSON.stringify(interruptPlain).includes(plain.runId));
	await until(() => current.plainAborts.length > 0, "public run interrupted");
	current.release();
	await Promise.all([bound.done, plain.done]);
});

type Detachable = { detach?: () => boolean };

test("a detached bound run stays private after its execution record closed; positive control: a detached public run stays visible", async () => {
	stand = createExecutorStand(fixture);
	const current = stand;
	const rpc = rpcClient(current);
	const plain = await startPlain(current);
	assert.equal((current.state.foregroundControls.get(plain.runId) as unknown as Detachable).detach?.(), true);
	await plain.done;
	const bound = await startBound(current);
	assert.equal((current.state.foregroundControls.get(bound.runId) as unknown as Detachable).detach?.(), true);
	await bound.done;
	// The port closes the execution record once the executor returned; the child is still held.
	getBoundRunRegistry().close(bound.runId);
	assert.equal(getBoundRunRegistry().has(bound.runId), false);
	assert.ok(current.state.foregroundControls.has(bound.runId), "the detached control is still in the process");

	const tool = async (params: Record<string, unknown>) => {
		const result = await current.executor.executePublic("tool-call", params, new AbortController().signal, undefined, current.ctx as never);
		return { isError: result.isError, content: result.content };
	};
	for (const base of [{ action: "status" }, { action: "interrupt" }, { action: "steer", message: "m" }, { action: "stop" }, { action: "dismiss" }] as Array<Record<string, unknown>>) {
		for (const target of [bound.runId, bound.runId.slice(0, 8)]) {
			const unknown = target === bound.runId ? randomUUID() : "ffffffff";
			assert.deepEqual(await tool({ ...base, id: target }), JSON.parse(JSON.stringify(await tool({ ...base, id: unknown })).replaceAll(unknown, target)), `tool ${String(base.action)} ${target}`);
		}
	}
	await assertAnswersAsUnknown(rpc, "interrupt", {}, bound.runId);
	await assertAnswersAsUnknown(rpc, "status", {}, bound.runId);
	const fleet = await rpc("status");
	assert.equal((fleet.data!.fleet as { totalActive: number }).totalActive, 1, "only the public run counts in Fleet");
	const fleetView = await rpc("status", { view: "fleet" });
	for (const reply of [fleet, fleetView]) assert.equal(JSON.stringify(reply).includes(bound.runId), false);
	// Positive control: the detached public run is still listed and named.
	assert.ok(JSON.stringify(fleetView).includes(plain.runId), "the detached public run is visible in view: fleet");
	assert.equal(current.boundProbe.aborts, 0, "the detached bound child was not interrupted");
	current.release();
});
