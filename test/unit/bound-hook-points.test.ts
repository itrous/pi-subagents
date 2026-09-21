import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { boundForegroundChildSessionFactory, boundForegroundRunId, isBoundForegroundLaunch } from "../../src/bound/bound-child-factory.ts";
import { BOUND_RUN_HOOK_NAME } from "../../src/bound/bound-run-hooks.ts";
import { getBoundRunRegistry, markBoundRunParams } from "../../src/bound/bound-run-registry.ts";
import { getLivePromptAudit } from "../../src/runs/foreground/prompt-audit.ts";
import { createBoundFixture, type BoundFixture } from "../fixtures/bound/harness.ts";
import { admitBoundLaunch } from "../support/bound-launch.ts";
import { createExecutorStand, until } from "../support/bound-executor.ts";

let fixture: BoundFixture;
let stand: ReturnType<typeof createExecutorStand> | undefined;
beforeEach(() => { fixture = createBoundFixture(); });
afterEach(() => { stand?.dispose(); stand = undefined; fixture.cleanup(); });

test("on non-bound params every T2 helper is inert (I4.14); on marked params the run id is prospectiveRunId", () => {
	const plain = { agent: "reviewer", task: "Review." };
	assert.equal(boundForegroundChildSessionFactory(plain, { runId: "random" }), undefined);
	assert.equal(boundForegroundRunId(plain), undefined);
	assert.equal(isBoundForegroundLaunch(plain), false);
	// A string key with the same text is not the capability.
	assert.equal(isBoundForegroundLaunch({ ...plain, "pi-subagents:bound-run": "x" }), false);
	const marked = markBoundRunParams({ ...plain }, "123e4567-e89b-42d3-a456-426614174000");
	assert.equal(boundForegroundRunId(marked), "123e4567-e89b-42d3-a456-426614174000");
	assert.equal(boundForegroundRunId({ ...marked }), "123e4567-e89b-42d3-a456-426614174000", "a spread copy keeps the capability");
	assert.equal(isBoundForegroundLaunch(marked), true);
	assert.ok(boundForegroundChildSessionFactory(marked, { runId: "123e4567-e89b-42d3-a456-426614174000" }));
});

test("through the real executor a non-bound launch keeps its random run id and the process factory", async () => {
	const launch = await admitBoundLaunch(fixture);
	stand = createExecutorStand(fixture);
	stand.release();
	await stand.run(stand.plain(launch));
	assert.equal(stand.plainLaunches.length, 1);
	assert.notEqual(stand.plainLaunches[0]!.runtime.runId, launch.contract.prospectiveRunId);
	assert.deepEqual(stand.boundProbe.hookNames, [], "the bound decorator was not used");
	assert.equal(fs.existsSync(path.join(fixture.sessionDir, launch.contract.prospectiveRunId)), false);
});

test("through the real executor a bound launch runs under prospectiveRunId in the bound factory", async () => {
	const launch = await admitBoundLaunch(fixture);
	stand = createExecutorStand(fixture);
	const running = stand.run(stand.bound(launch));
	const record = getBoundRunRegistry().get(launch.contract.prospectiveRunId)!;
	await until(() => stand!.boundProbe.prompts > 0, "bound prompt");
	assert.equal(stand.plainLaunches.length, 0, "the process-wide factory was not used");
	assert.equal(stand.boundProbe.hookNames[0], BOUND_RUN_HOOK_NAME);
	assert.equal(record.registry.failure, undefined, "the executor launch passed the recheck, session roots included");
	assert.ok(fs.existsSync(path.join(fixture.sessionDir, launch.contract.prospectiveRunId, "run-0")), "session roots follow the contract (D4)");
	assert.ok(stand.state.foregroundControls.has(launch.contract.prospectiveRunId));
	stand.release();
	await running;
	getBoundRunRegistry().close(launch.contract.prospectiveRunId);
});

test("a prompt redo of a bound run is refused before any execution; positive control: a public run keeps its redo contract", async () => {
	const launch = await admitBoundLaunch(fixture);
	const plainLaunch = await admitBoundLaunch(fixture);
	stand = createExecutorStand(fixture);
	const current = stand;
	const runId = launch.contract.prospectiveRunId;
	const running = current.run(current.bound(launch));
	await until(() => current.boundProbe.prompts > 0, "bound prompt");
	const control = current.state.foregroundControls.get(runId) as unknown as { promptAuditRedo?: (index: number, guidance: string) => Promise<{ text: string; isError?: boolean }> };
	const before = fs.readdirSync(path.join(fixture.sessionDir, runId));
	assert.equal(getLivePromptAudit(control as never, 0)?.rerun, undefined, "no rerun contract carries the bound capability");
	assert.deepEqual(await control.promptAuditRedo!(0, "be brief"), { text: "Redo is not safe for this prompt in this slice.", isError: true });
	assert.equal(current.boundProbe.prompts, 1, "no second child was created");
	assert.equal(getBoundRunRegistry().get(runId)!.registry.failure, undefined, "the live run's evidence is untouched");
	assert.deepEqual(fs.readdirSync(path.join(fixture.sessionDir, runId)), before);
	assert.equal(current.state.foregroundControls.get(runId), control);

	const plainRunning = current.run(current.plain(plainLaunch));
	await until(() => current.plainLaunches.length > 0, "plain child");
	const plainRunId = current.plainLaunches[0]!.runtime.runId!;
	await until(() => current.state.foregroundControls.has(plainRunId), "plain control");
	assert.ok(getLivePromptAudit(current.state.foregroundControls.get(plainRunId) as never, 0)?.rerun, "the public run is still redoable");
	current.release();
	await Promise.all([running, plainRunning]);
	getBoundRunRegistry().close(runId);
});
