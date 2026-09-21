import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { boundExpectedSystemPrompt } from "../../src/bound/bound-launch-recheck.ts";
import { createBoundRuntimeService, type BoundAuthorizedLaunch, type BoundRuntimeServiceOptions } from "../../src/bound/bound-runtime-service.ts";
import { BOUND_CHANNEL_VERSION, type BoundBindingV2 } from "../../src/bound/channel.ts";
import type { ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";
import type { BoundFixture } from "../fixtures/bound/harness.ts";

export function boundBindingOf(data: { serverInstanceId: string; launchContract: { prospectiveRunId: string }; sourceIdentityDigest: string; activeSessionDigest: string; requestDigest: string; launchContractDigest: string; receipt: unknown; cancellationToken: unknown }): BoundBindingV2 {
	return {
		version: BOUND_CHANNEL_VERSION, targetServerInstanceId: data.serverInstanceId, prospectiveRunId: data.launchContract.prospectiveRunId,
		expectedSourceIdentityDigest: data.sourceIdentityDigest, expectedActiveSessionDigest: data.activeSessionDigest,
		requestDigest: data.requestDigest, expectedLaunchContractDigest: data.launchContractDigest,
		receipt: data.receipt, cancellationToken: data.cancellationToken,
	} as BoundBindingV2;
}

/** A real preflight plus admission; each call takes a fresh run id, since run ids are reserved process-wide. */
export async function admitBoundLaunch(fixture: BoundFixture, requestOverrides: Record<string, unknown> = {}): Promise<BoundAuthorizedLaunch> {
	const service = createBoundRuntimeService(fixture.serviceOptions() as unknown as BoundRuntimeServiceOptions);
	try {
		const request = fixture.request({ prospectiveRunId: randomUUID(), ...requestOverrides });
		const preflight = await service.preflight(request);
		assert.ok(preflight?.ok, "preflight must succeed");
		const admitted = await service.admit(request, boundBindingOf(preflight.data));
		assert.ok(admitted.ok, "admission must succeed");
		return admitted.launch;
	} finally { service.dispose(); }
}

/** The launch upstream builds for this contract: it passes `recheckBoundLaunch` unchanged. */
export function contractLaunch(fixture: BoundFixture, authorized: BoundAuthorizedLaunch): ChildSessionLaunch {
	const { contract, agent } = authorized;
	const prompt = boundExpectedSystemPrompt(authorized);
	assert.ok(prompt !== undefined, "the fixture agent must still match its contract");
	return {
		cwd: contract.canonicalCwd,
		storage: { kind: "file", sessionFile: path.join(fixture.sessionDir, contract.prospectiveRunId, "run-0", "session.jsonl") },
		model: contract.modelCandidates[0],
		tools: [...contract.tools.effectiveAllowlist],
		extensionPaths: [],
		ambientExtensions: false,
		hooks: [],
		noSkills: true,
		noContextFiles: true,
		...(agent.systemPromptMode === "replace" ? { systemPrompt: prompt } : { appendSystemPrompt: prompt }),
		runtime: {
			runId: contract.prospectiveRunId, agent: agent.name, fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false,
			...(contract.tools.requiredChildTools.length > 0 ? { requiredTools: [...contract.tools.requiredChildTools] } : {}),
			...(contract.mcpDirectTools.length > 0 ? { mcpDirectTools: [...contract.mcpDirectTools] } : {}),
		} as ChildSessionLaunch["runtime"],
	};
}
