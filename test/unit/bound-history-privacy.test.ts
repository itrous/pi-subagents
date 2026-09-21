import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { getBoundRunRegistry } from "../../src/bound/bound-run-registry.ts";
import type { SubagentState } from "../../src/shared/types.ts";
import { createBoundFixture, type BoundFixture } from "../fixtures/bound/harness.ts";
import { createExecutorStand, until } from "../support/bound-executor.ts";
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

type Control = { detach?: () => boolean };
const remembered = (state: SubagentState): Map<string, { children: Array<{ status?: string }> }> =>
	(state.foregroundRuns ?? new Map()) as unknown as Map<string, { children: Array<{ status?: string }> }>;

test("an ordinary completion: the bound run is absent from history, the non-bound run is present", async () => {
	const boundLaunch = await admitBoundLaunch(fixture);
	const plainLaunch = await admitBoundLaunch(fixture);
	stand = createExecutorStand(fixture);
	stand.release();
	opened.push(boundLaunch.contract.prospectiveRunId);
	await stand.run(stand.bound(boundLaunch));
	await stand.run(stand.plain(plainLaunch));
	const plainRunId = stand.plainLaunches[0]!.runtime.runId!;
	assert.equal(remembered(stand.state).has(boundLaunch.contract.prospectiveRunId), false);
	assert.equal(remembered(stand.state).has(plainRunId), true, "positive control: the non-bound run is remembered");
});

test("a detached exit: the bound run never reaches history, the non-bound run is updated by the detached writer", async () => {
	const boundLaunch = await admitBoundLaunch(fixture);
	const plainLaunch = await admitBoundLaunch(fixture);
	stand = createExecutorStand(fixture);
	const current = stand;
	opened.push(boundLaunch.contract.prospectiveRunId);

	const boundRun = current.run(current.bound(boundLaunch));
	await until(() => current.boundProbe.prompts > 0, "bound child prompt");
	const boundControl = current.state.foregroundControls.get(boundLaunch.contract.prospectiveRunId) as unknown as Control;
	assert.equal(boundControl.detach?.(), true);
	await boundRun;

	const plainRun = current.run(current.plain(plainLaunch));
	await until(() => current.plainLaunches.length > 0, "plain child");
	const plainRunId = current.plainLaunches[0]!.runtime.runId!;
	await until(() => current.state.foregroundControls.has(plainRunId), "plain control");
	assert.equal((current.state.foregroundControls.get(plainRunId) as unknown as Control).detach?.(), true);
	await plainRun;
	assert.equal(remembered(current.state).get(plainRunId)?.children[0]?.status, "detached");

	// Both detached children now finish; only the non-bound one is written back.
	current.release();
	await until(() => remembered(current.state).get(plainRunId)?.children[0]?.status !== "detached", "detached writer of the non-bound run");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(remembered(current.state).has(boundLaunch.contract.prospectiveRunId), false);
});
