import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT,
	registerPromptTemplateDelegationBridge,
	type PromptTemplateBridgeEvents,
} from "../../src/slash/prompt-template-bridge.ts";
import type { PromptTemplateBridgeResult } from "../../src/slash/delegation-adapters.ts";
import { BOUND_IDENTITY_REGISTRY_GLOBAL_KEY, BoundIdentityRegistry, getBoundIdentityRegistry } from "../../src/slash/bound-identity-registry.ts";
import { StructuredAttemptCoordinator } from "../../src/slash/structured-attempt-coordinator.ts";
import { BoundPendingCancellationRegistryV1 } from "../../src/slash/bound-pending-cancellation-registry.ts";

class FakeEvents implements PromptTemplateBridgeEvents {
	private handlers = new Map<string, Array<(data: unknown) => void>>();

	on(event: string, handler: (data: unknown) => void): () => void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return () => {
			const current = this.handlers.get(event) ?? [];
			this.handlers.set(event, current.filter((h) => h !== handler));
		};
	}

	emit(event: string, data: unknown): void {
		for (const handler of [...this.handlers.get(event) ?? []]) handler(data);
	}
}

function once(events: FakeEvents, event: string): Promise<unknown> {
	return new Promise((resolve) => {
		const unsubscribe = events.on(event, (payload) => {
			unsubscribe();
			resolve(payload);
		});
	});
}

function structuredRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		requestId: "r1",
		ownerRunId: "owner-1",
		nodeId: "node-1",
		agent: "worker",
		task: "do work",
		context: "fresh",
		model: "openai/gpt-5",
		cwd: "/repo",
		result: { kind: "text" },
		...overrides,
	};
}

function boundRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const target = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const run = "123e4567-e89b-12d3-a456-426614174000";
	return structuredRequest({
		context: "fresh", model: "openai/gpt-5", thinking: "off", artifacts: false,
		binding: {
			version: 1, targetServerInstanceId: target, prospectiveRunId: run,
			expectedSourceIdentityDigest: "a".repeat(64), expectedActiveSessionDigest: "b".repeat(64),
			requestDigest: "c".repeat(64), expectedLaunchContractDigest: "d".repeat(64),
			receipt: { version: 1, algorithm: "HMAC-SHA256", payload: { version: 1, serverInstanceId: target, sourceIdentityDigest: "a".repeat(64), activeSessionDigest: "b".repeat(64), prospectiveRunId: run, requestDigest: "c".repeat(64), launchContractDigest: "d".repeat(64), issuedAt: 1, expiresAt: 30001 }, mac: "e".repeat(64) },
			cancellationToken: { version: 1, algorithm: "HMAC-SHA256", payload: { version: 1, serverInstanceId: target, sourceIdentityDigest: "a".repeat(64), activeSessionDigest: "b".repeat(64), prospectiveRunId: run, requestDigest: "c".repeat(64), launchContractDigest: "d".repeat(64), issuedAt: 1, expiresAt: 30001, requestId: "r1", ownerRunId: "owner-1", nodeId: "node-1" }, mac: "f".repeat(64) },
		},
		...overrides,
	});
}

describe("prompt-template delegation bridge", () => {
	it("is passive before activation and emits nothing", async () => {
		const events = new FakeEvents();
		let executeCalls = 0;
		let observable = 0;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => { executeCalls++; return {}; },
		});
		events.on(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, () => { observable++; });
		events.on(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, () => { observable++; });
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, structuredRequest({ requestId: "passive" }));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(executeCalls, 0);
		assert.equal(observable, 0);
		bridge.dispose();
	});

	it("emits started/update/response on successful structured request", async () => {
		const events = new FakeEvents();
		let executeCalls = 0;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			executeStructured: async (_requestId, _request, _signal, _ctx, onUpdate) => {
				executeCalls++;
				onUpdate({
					details: {
						results: [{ agent: "worker", model: "openai/gpt-5-mini" }],
						progress: [{
							index: 0,
							agent: "worker",
							currentTool: "read",
							currentToolArgs: "src/extension/index.ts",
							recentOutput: ["line 1"],
							recentTools: [{ tool: "read", args: '{"path":"src/extension/index.ts"}' }],
							toolCount: 1,
							durationMs: 10,
							tokens: 42,
						}],
					},
				});
				return {
					details: {
						results: [{ agent: "worker", finalOutput: "ok", exitCode: 0 }],
					},
				};
			},
			execute: async () => { throw new Error("structured request should use executeStructured"); },
		});
		bridge.activate();
		bridge.activateTerminalSink();

		const startedPromise = once(events, PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT);
		const updatePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT);
		const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);

		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, structuredRequest());

		const started = await startedPromise as { requestId: string; ownerRunId: string; nodeId: string };
		assert.deepEqual(started, { requestId: "r1", ownerRunId: "owner-1", nodeId: "node-1" });

		const update = await updatePromise as {
			requestId: string;
			ownerRunId: string;
			nodeId: string;
			currentTool?: string;
			toolCount?: number;
			recentOutputLines?: string[];
			recentTools?: Array<{ tool: string; args: string }>;
			model?: string;
			taskProgress?: Array<{ model?: string }>;
		};
		assert.equal(update.requestId, "r1");
		assert.equal(update.ownerRunId, "owner-1");
		assert.equal(update.nodeId, "node-1");
		assert.equal(update.currentTool, "read");
		assert.equal(update.toolCount, 1);
		assert.deepEqual(update.recentOutputLines, ["line 1"]);
		assert.deepEqual(update.recentTools, [{ tool: "read", args: '{"path":"src/extension/index.ts"}' }]);

		const response = await responsePromise as { requestId: string; ownerRunId: string; nodeId: string; status: string; result?: { kind: string; text?: string } };
		assert.equal(response.requestId, "r1");
		assert.equal(response.ownerRunId, "owner-1");
		assert.equal(response.nodeId, "node-1");
		assert.equal(response.status, "completed");
		assert.deepEqual(response.result, { kind: "text", text: "ok" });
		assert.equal(executeCalls, 1);

		bridge.dispose();
	});

	it("commits a bound UUID before synchronous started and rejects a reentrant replay", async () => {
		const events = new FakeEvents();
		const globalStore = globalThis as Record<string, unknown>; const previousRegistry = globalStore[BOUND_IDENTITY_REGISTRY_GLOBAL_KEY]; delete globalStore[BOUND_IDENTITY_REGISTRY_GLOBAL_KEY];
		const registry = getBoundIdentityRegistry();
		let calls = 0; let admits = 0;
		const proof = { version: 1, request: {}, contract: {}, launchContractDigest: "d".repeat(64) } as any;
		const runtime = {
			version: 1 as const, serverInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceIdentityDigest: "a".repeat(64),
			preflight: () => ({ version: 1 as const, code: "invalid_request" as const }), admit: () => ++admits === 1 ? ({ ok: true as const, proof }) : ({ ok: false as const, code: "invalid_request" as const }), recheck: () => true, dispose: () => {},
		};
		const bridge = registerPromptTemplateDelegationBridge({
			events, coordinator: new StructuredAttemptCoordinator(), activeBoundRuntime: runtime,
			getContext: () => ({ cwd: "/repo" }), executeStructured: async (id, params) => {
				calls++; assert.equal(id, "r1"); assert.equal((params as any).activeBoundProof, proof);
				return { details: { results: [{ agent: "worker", exitCode: 0, finalOutput: "done" }] } };
			}, execute: async () => assert.fail(),
		});
		bridge.activate(); bridge.activateTerminalSink();
		const terminals: Array<{ requestId: string; status: string }> = [];
		events.on(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, (value) => terminals.push(value as any));
		let startedSynchronously = false;
		events.on(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, () => {
			startedSynchronously = true;
			assert.equal(registry.has(runtime.serverInstanceId, "123e4567-e89b-12d3-a456-426614174000"), true);
			assert.equal(registry.release(runtime.serverInstanceId, "123e4567-e89b-12d3-a456-426614174000"), false);
			events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, boundRequest());
		});
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, boundRequest());
		assert.equal(startedSynchronously, true);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(calls, 1); assert.equal(admits, 1);
		assert.equal(registry.release(runtime.serverInstanceId, "123e4567-e89b-12d3-a456-426614174000"), false);
		assert.deepEqual(terminals.map((entry) => [entry.requestId, entry.status]).sort(), [["r1", "completed"], ["r1", "duplicate_node"]]);
		bridge.dispose();
		if (previousRegistry === undefined) delete globalStore[BOUND_IDENTITY_REGISTRY_GLOBAL_KEY]; else globalStore[BOUND_IDENTITY_REGISTRY_GLOBAL_KEY] = previousRegistry;
	});

	it("releases a tentative bound UUID when coordinator rejects the node", async () => {
		const events = new FakeEvents(); const registry = new BoundIdentityRegistry(); const coordinator = new StructuredAttemptCoordinator();
		const blocker = coordinator.admit({ requestId: "other", ownerRunId: "owner-1", nodeId: "node-1" }, "other-runtime"); assert.equal(blocker.accepted, true);
		const runtime = { version: 1 as const, serverInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceIdentityDigest: "a".repeat(64), preflight: () => ({ version: 1 as const, code: "invalid_request" as const }), admit: () => ({ ok: true as const, proof: {} as any }), recheck: () => true, claimBase: () => true, dispose: () => {} };
		const bridge = registerPromptTemplateDelegationBridge({ events, coordinator, activeBoundRuntime: runtime, boundIdentityRegistry: registry, getContext: () => ({ cwd: "/repo" }), executeStructured: async () => assert.fail("coordinator rejection must not execute"), execute: async () => assert.fail() });
		bridge.activate(); bridge.activateTerminalSink();
		const terminal = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT) as Promise<{ status: string }>;
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, boundRequest());
		assert.equal((await terminal).status, "duplicate_node");
		assert.equal(registry.reserve(runtime.serverInstanceId, "123e4567-e89b-12d3-a456-426614174000"), "reserved");
		assert.equal(registry.release(runtime.serverInstanceId, "123e4567-e89b-12d3-a456-426614174000"), true);
		if (blocker.accepted) blocker.settle({ requestId: "other", ownerRunId: "owner-1", nodeId: "node-1", status: "cancelled" });
		bridge.dispose();
	});

	it("rejects a bound top-level accessor without invoking it", async () => {
		const events = new FakeEvents(); let getterCalls = 0;
		const runtime = {
			version: 1 as const, serverInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceIdentityDigest: "a".repeat(64),
			preflight: () => ({ version: 1 as const, code: "invalid_request" as const }), admit: () => assert.fail("invalid accessor must not reach admission"), recheck: () => false, dispose: () => {},
		};
		const bridge = registerPromptTemplateDelegationBridge({ events, activeBoundRuntime: runtime, boundIdentityRegistry: new BoundIdentityRegistry(), getContext: () => ({ cwd: "/repo" }), execute: async () => assert.fail() });
		bridge.activate(); bridge.activateTerminalSink();
		const request = boundRequest({ requestId: "accessor", ownerRunId: "accessor-owner", nodeId: "accessor-node" });
		Object.defineProperty(request, "task", { enumerable: true, get() { getterCalls++; throw new Error("getter ran"); } });
		const terminal = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT) as Promise<{ status: string }>;
		assert.doesNotThrow(() => events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, request));
		assert.equal((await terminal).status, "invalid_request");
		assert.equal(getterCalls, 0);
		bridge.dispose();
	});

	it("returns structured error when no active context", async () => {
		const events = new FakeEvents();
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => null,
			execute: async () => ({ details: { results: [{ messages: [] }] } }),
		});
		bridge.activate();
		bridge.activateTerminalSink();

		const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, structuredRequest({ requestId: "r2" }));

		const response = await responsePromise as { status: string; error?: string };
		assert.equal(response.status, "unavailable_context");
		assert.match(response.error ?? "", /No active extension context/);

		bridge.dispose();
	});

	it("remembers legacy cancel before the structured attempt starts", async () => {
		const events = new FakeEvents();
		let executeCalls = 0;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => {
				executeCalls++;
				return { details: { results: [{ agent: "worker", exitCode: 0, finalOutput: "done" }] } };
			},
		});
		bridge.activate();
		bridge.activateTerminalSink();

		events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, { requestId: "r4", ownerRunId: "owner-1", nodeId: "node-1" });
		const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, structuredRequest({ requestId: "r4" }));

		const response = await responsePromise as { status: string };
		assert.equal(response.status, "cancelled");
		assert.equal(executeCalls, 0);

		bridge.dispose();
	});

	it("authenticates and consumes a bound cancel before synchronous started", () => {
		const events = new FakeEvents(); const responses: any[] = []; const started: any[] = []; let executes = 0;
		events.on(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, (value) => responses.push(value)); events.on(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, (value) => started.push(value));
		const request = boundRequest(); const binding = request.binding as any;
		const runtime = { version: 1 as const, serverInstanceId: binding.targetServerInstanceId, sourceIdentityDigest: "a".repeat(64), preflight: () => ({ version: 1 as const, code: "invalid_request" as const }), admit: (candidate: any) => candidate.task === "do work" ? ({ ok: true as const, proof: {} as any }) : ({ ok: false as const, code: "invalid_request" as const }), verifyPendingCancellation: () => true, verifyActiveCancellation: () => true, recheck: () => true, claimBase: () => true, dispose: () => {} };
		const bridge = registerPromptTemplateDelegationBridge({ events, coordinator: new StructuredAttemptCoordinator(), activeBoundRuntime: runtime, boundIdentityRegistry: new BoundIdentityRegistry(), pendingCancellationRegistry: new BoundPendingCancellationRegistryV1(() => 1, 8), getContext: () => ({ cwd: "/repo" }), executeStructured: async () => { executes++; return {} as any; }, execute: async () => assert.fail() });
		bridge.activate(); bridge.activateTerminalSink();
		let accessorRead = false; const maliciousCancel = { requestId: "r1", ownerRunId: "owner-1", nodeId: "node-1", targetServerInstanceId: binding.targetServerInstanceId } as Record<string, unknown>;
		Object.defineProperty(maliciousCancel, "binding", { enumerable: true, get() { accessorRead = true; throw new Error("must not read"); } });
		assert.doesNotThrow(() => events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, maliciousCancel)); assert.equal(accessorRead, false);
		events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, { requestId: "r1", ownerRunId: "owner-1", nodeId: "node-1", targetServerInstanceId: binding.targetServerInstanceId, binding });
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, { ...request, task: "tampered" });
		assert.equal(responses.length, 1); assert.equal(responses[0].status, "invalid_request");
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, request);
		assert.equal(executes, 0); assert.deepEqual(started, []); assert.equal(responses.length, 2); assert.equal(responses[1].status, "cancelled");
		bridge.dispose();
	});

	it("requires authenticated bound cancel and suppresses positive-control late updates", async () => {
		const events = new FakeEvents(); const request = boundRequest(); const binding = request.binding as any; let admittedSignal: AbortSignal | undefined; let pushUpdate!: (value: PromptTemplateBridgeResult) => void; let updates = 0; const pending = new BoundPendingCancellationRegistryV1(() => 1, 8);
		const runtime = { version: 1 as const, serverInstanceId: binding.targetServerInstanceId, sourceIdentityDigest: "a".repeat(64), preflight: () => ({ version: 1 as const, code: "invalid_request" as const }), admit: () => ({ ok: true as const, proof: {} as any }), verifyPendingCancellation: (_tuple: unknown, candidate: any) => candidate?.cancellationToken?.mac === binding.cancellationToken.mac || candidate?.cancellationToken?.mac === "a".repeat(64), verifyActiveCancellation: (_tuple: unknown, candidate: any) => candidate?.cancellationToken?.mac === binding.cancellationToken.mac || candidate?.cancellationToken?.mac === "a".repeat(64), recheck: () => true, claimBase: () => true, dispose: () => {} };
		const bridge = registerPromptTemplateDelegationBridge({ events, coordinator: new StructuredAttemptCoordinator(), activeBoundRuntime: runtime, boundIdentityRegistry: new BoundIdentityRegistry(), pendingCancellationRegistry: pending, getContext: () => ({ cwd: "/repo" }), executeStructured: async (_id, _params, signal, _ctx, onUpdate) => await new Promise((_resolve, reject) => { admittedSignal = signal; pushUpdate = onUpdate; signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }), execute: async () => assert.fail() });
		bridge.activate(); bridge.activateTerminalSink(); events.on(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, () => { updates++; }); const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, request);
		events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, { requestId: "r1", ownerRunId: "owner-1", nodeId: "node-1" });
		assert.equal(admittedSignal?.aborted, false, "legacy cancel must not cancel a live bound tuple");
		pushUpdate({ details: { progress: [{ agent: "worker", currentTool: "read" }] } }); assert.equal(updates, 1);
		const otherValidBinding = structuredClone(binding); otherValidBinding.prospectiveRunId = "123e4567-e89b-12d3-a456-426614174099"; otherValidBinding.requestDigest = "9".repeat(64); otherValidBinding.cancellationToken.payload.prospectiveRunId = otherValidBinding.prospectiveRunId; otherValidBinding.cancellationToken.payload.requestDigest = otherValidBinding.requestDigest; otherValidBinding.cancellationToken.mac = "a".repeat(64); events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, { requestId: "r1", ownerRunId: "owner-1", nodeId: "node-1", targetServerInstanceId: binding.targetServerInstanceId, binding: otherValidBinding }); assert.equal(admittedSignal?.aborted, false, "another valid preflight binding for the tuple must not cancel the active binding");
		const forged = structuredClone(binding); forged.cancellationToken.mac = "0".repeat(64);
		events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, { requestId: "r1", ownerRunId: "owner-1", nodeId: "node-1", targetServerInstanceId: binding.targetServerInstanceId, binding: forged });
		assert.equal(admittedSignal?.aborted, false);
		events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, { requestId: "r1", ownerRunId: "owner-1", nodeId: "node-1", targetServerInstanceId: binding.targetServerInstanceId, binding });
		pushUpdate({ details: { progress: [{ agent: "worker", currentTool: "bash" }] } }); assert.equal(updates, 1, "late update after authenticated cancel must be suppressed");
		assert.equal((await responsePromise as { status: string }).status, "cancelled");
		events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, { requestId: "r1", ownerRunId: "owner-1", nodeId: "node-1", targetServerInstanceId: binding.targetServerInstanceId, binding }); assert.equal(pending.snapshot().pending, 0, "terminal cancel replay must not consume pending capacity");
		bridge.dispose();
	});

	it("preserves an own undefined binding as fail-closed cancellation policy after parsing", async () => {
		const events = new FakeEvents(); let signal: AbortSignal | undefined; let settle!: (value: PromptTemplateBridgeResult) => void;
		const bridge = registerPromptTemplateDelegationBridge({ events, coordinator: new StructuredAttemptCoordinator(), getContext: () => ({ cwd: "/repo" }), execute: async (_id, _params, current) => { signal = current; return await new Promise((resolve) => { settle = resolve; }); } }); bridge.activate(); bridge.activateTerminalSink();
		const value = structuredRequest({ requestId: "undefined-binding", nodeId: "undefined-binding", binding: undefined }); events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, value); await new Promise((resolve) => setImmediate(resolve));
		events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, { requestId: "undefined-binding", ownerRunId: "owner-1", nodeId: "undefined-binding" }); assert.equal(signal?.aborted, false);
		settle({ details: { results: [{ agent: "worker", exitCode: 0, finalOutput: "ok" }] } }); await new Promise((resolve) => setImmediate(resolve)); bridge.dispose();
	});

	it("does not dispatch after a reentrant stop from the started listener", async () => {
		const events = new FakeEvents();
		const coordinator = new StructuredAttemptCoordinator();
		let executeCalls = 0;
		const bridge = registerPromptTemplateDelegationBridge({
			events, coordinator, getContext: () => ({ cwd: "/repo" }),
			execute: async () => { executeCalls++; return {}; },
		});
		bridge.activate(); bridge.activateTerminalSink();
		events.on(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, () => bridge.stop({ preserveSink: true }));
		const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, structuredRequest({ requestId: "reentrant-stop" }));
		assert.equal((await responsePromise as { status: string }).status, "cancelled");
		assert.equal(executeCalls, 0);
		assert.equal(coordinator.snapshot().attempts, 0);
		bridge.dispose();
	});

	it("settles admission when a started listener throws", async () => {
		const events = new FakeEvents();
		const coordinator = new StructuredAttemptCoordinator();
		const bridge = registerPromptTemplateDelegationBridge({
			events, coordinator, getContext: () => ({ cwd: "/repo" }), execute: async () => assert.fail(),
		});
		bridge.activate(); bridge.activateTerminalSink();
		events.on(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, () => { throw new Error("started failed"); });
		const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, structuredRequest({ requestId: "started-throws" }));
		const response = await responsePromise as { status: string; error?: string };
		assert.equal(response.status, "failed");
		assert.match(response.error ?? "", /started failed/);
		assert.equal(coordinator.snapshot().attempts, 0);
		bridge.dispose();
	});

	it("stop suppresses updates and waits for settlement before cancelled terminal", async () => {
		const events = new FakeEvents();
		let settle!: (value: PromptTemplateBridgeResult) => void;
		let pushUpdate!: (value: PromptTemplateBridgeResult) => void;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async (_id, _params, _signal, _ctx, onUpdate) => {
				pushUpdate = onUpdate;
				return await new Promise((resolve) => { settle = resolve; });
			},
		});
		bridge.activate(); bridge.activateTerminalSink();
		let updates = 0;
		const terminals: Array<{ status: string }> = [];
		events.on(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, () => { updates++; });
		events.on(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, (value) => terminals.push(value as { status: string }));
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, structuredRequest({ requestId: "drain" }));
		await new Promise((resolve) => setImmediate(resolve));
		bridge.stop({ preserveSink: true });
		pushUpdate({ details: { progress: [{ agent: "worker", currentTool: "read" }] } });
		assert.equal(updates, 0);
		assert.equal(terminals.length, 0);
		settle({ details: { results: [{ finalOutput: "late" }] } });
		await bridge.drain();
		assert.deepEqual(terminals.map((entry) => entry.status), ["cancelled"]);
		bridge.dispose();
	});

	it("suppresses executor updates after terminal settlement", async () => {
		const events = new FakeEvents();
		let lateUpdate!: (value: PromptTemplateBridgeResult) => void;
		const bridge = registerPromptTemplateDelegationBridge({
			events, coordinator: new StructuredAttemptCoordinator(), getContext: () => ({ cwd: "/repo" }),
			execute: async (_id, _params, _signal, _ctx, onUpdate) => {
				lateUpdate = onUpdate;
				return { details: { results: [{ agent: "worker", exitCode: 0, finalOutput: "done" }] } };
			},
		});
		bridge.activate(); bridge.activateTerminalSink();
		let updates = 0;
		events.on(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, () => { updates++; });
		const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, structuredRequest({ requestId: "late-update" }));
		await responsePromise;
		lateUpdate({ details: { progress: [{ agent: "worker", currentTool: "read" }] } });
		assert.equal(updates, 0);
		bridge.dispose();
	});

	it("routes an old owner through a replacement and drains a gap through the next active sink", async () => {
		const events = new FakeEvents();
		const coordinator = new StructuredAttemptCoordinator();
		let settle!: (value: PromptTemplateBridgeResult) => void; let pushUpdate!: (value: PromptTemplateBridgeResult) => void;
		const runtimeA = registerPromptTemplateDelegationBridge({
			events, coordinator, runtimeId: "A", getContext: () => ({ cwd: "/repo" }),
			execute: async (_id, _params, _signal, _ctx, onUpdate) => { pushUpdate = onUpdate; return await new Promise((resolve) => { settle = resolve; }); },
		});
		runtimeA.activate(); runtimeA.activateTerminalSink();
		const terminals: Array<{ status: string }> = []; let updates = 0;
		events.on(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, (value) => terminals.push(value as { status: string })); events.on(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, () => { updates++; });
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, structuredRequest({ requestId: "from-a" }));
		await new Promise((resolve) => setImmediate(resolve));
		runtimeA.stop();
		pushUpdate({ details: { progress: [{ agent: "worker", currentTool: "read" }] } }); assert.equal(updates, 0, "old-owner late update must be suppressed after stop");

		const runtimeB = registerPromptTemplateDelegationBridge({
			events, coordinator, runtimeId: "B", getContext: () => ({ cwd: "/repo" }), execute: async () => assert.fail(),
		});
		// B was constructed but never received session_start. Its cancel handler and
		// terminal sink must remain passive during this gap.
		events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, { requestId: "from-a", ownerRunId: "owner-1", nodeId: "node-1" });
		settle({ details: { results: [{ finalOutput: "late" }] } });
		await runtimeA.drain();
		assert.equal(terminals.length, 0);

		const runtimeC = registerPromptTemplateDelegationBridge({
			events, coordinator, runtimeId: "C", getContext: () => ({ cwd: "/repo" }), execute: async () => assert.fail(),
		});
		runtimeC.activate(); runtimeC.activateTerminalSink();
		assert.deepEqual(terminals.map((entry) => entry.status), ["cancelled"]);
		runtimeA.dispose(); runtimeB.dispose(); runtimeC.dispose();
	});

	it("commits a fully identified invalid tuple once", async () => {
		const events = new FakeEvents();
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			coordinator: new StructuredAttemptCoordinator(),
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => assert.fail(),
		});
		bridge.activate(); bridge.activateTerminalSink();
		const terminals: unknown[] = [];
		events.on(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, (value) => terminals.push(value));
		const invalid = structuredRequest({ task: "", requestId: "invalid-once" });
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, invalid);
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, invalid);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(terminals.length, 1);
		assert.equal((terminals[0] as { status: string }).status, "invalid_request");
		bridge.dispose();
	});

	it("cancels in-flight structured delegated execution", async () => {
		const events = new FakeEvents();
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async (_requestId, _request, signal) =>
				await new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		});
		bridge.activate();
		bridge.activateTerminalSink();

		const startedPromise = once(events, PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT);
		const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);

		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, structuredRequest({ requestId: "r5" }));

		await startedPromise;
		events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, { requestId: "r5", ownerRunId: "owner-1", nodeId: "node-1" });

		const response = await responsePromise as { status: string; error?: string };
		assert.equal(response.status, "cancelled");

		bridge.dispose();
	});

	it("rejects legacy direct payloads without executor dispatch", async () => {
		const events = new FakeEvents();
		let executeCalls = 0;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => { executeCalls++; return {}; },
		});
		bridge.activate();
		bridge.activateTerminalSink();

		const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, {
			requestId: "legacy-1",
			agent: "worker",
			task: "do work",
			context: "fresh",
			model: "openai/gpt-5",
			cwd: "/repo",
		});

		const response = await responsePromise as { isError: boolean; errorText?: string };
		assert.equal(response.isError, true);
		assert.match(response.errorText ?? "", /Legacy prompt-template direct delegation was removed/);
		assert.equal(executeCalls, 0);
		bridge.dispose();
	});

	it("rejects removed tasks and worktree payloads without executor dispatch", async () => {
		const events = new FakeEvents();
		let executeCalls = 0;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => { executeCalls++; return {}; },
		});
		bridge.activate();
		bridge.activateTerminalSink();

		const tasksResponse = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, {
			requestId: "r6",
			tasks: [{ agent: "worker-a", task: "A" }],
			context: "fresh",
			model: "openai/gpt-5",
			cwd: "/repo",
		});
		const response = await tasksResponse as { isError: boolean; errorText?: string };
		assert.equal(response.isError, true);
		assert.match(response.errorText ?? "", /removed.*workflowScript/i);
		const longIdResponse = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, {
			requestId: "x".repeat(257), tasks: [{ agent: "worker-a", task: "A" }], context: "fresh", cwd: "/repo",
		});
		assert.equal((await longIdResponse as { isError: boolean }).isError, true);
		assert.equal(executeCalls, 0);
		bridge.dispose();
	});
});
