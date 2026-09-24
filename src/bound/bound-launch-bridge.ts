import { getBoundIdentityRegistry, type BoundIdentityRegistryV1 } from "../slash/bound-identity-registry.ts";
import { BoundAttemptCoordinator, boundCancellationBindingKey, type BoundTerminal } from "./bound-attempt-coordinator.ts";
import { getBoundPendingCancellationRegistry, type BoundPendingCancellationRegistryV2 } from "./bound-pending-cancellation-registry.ts";
import type { BoundAuthorizedLaunch, BoundRuntimeService } from "./bound-runtime-service.ts";
import {
	BOUND_CANCEL_EVENT, BOUND_LAUNCH_EVENT, BOUND_STARTED_EVENT, BOUND_TERMINAL_EVENT, BOUND_UPDATE_EVENT,
	boundBindingTarget, parseBoundCancelEnvelope, parseBoundLaunchEnvelope, type BoundEventBus,
} from "./channel.ts";

export interface BoundAttemptTuple {
	requestId: string;
	ownerRunId: string;
	nodeId: string;
}

export interface BoundExecutionUpdate extends BoundAttemptTuple {
	[key: string]: unknown;
}

/**
 * Execution of the bound leaf lands in A1R.4 (decision D9). Until a port is
 * installed, an admitted launch settles with exactly one `unavailable_context`
 * terminal instead of hanging or going silent (invariant I3.19).
 */
export interface BoundExecutionPort {
	run(input: {
		launch: BoundAuthorizedLaunch;
		signal: AbortSignal;
		onUpdate: (update: Omit<BoundExecutionUpdate, keyof BoundAttemptTuple>) => void;
		/**
		 * The attempt's terminal/cancel latch (D3): true when the outcome may be
		 * committed; false when a cancellation latched first.
		 */
		commit?: () => boolean;
	}): Promise<{ status: string } & Record<string, unknown>>;
}

export interface BoundLaunchBridgeOptions {
	events: BoundEventBus;
	service: BoundRuntimeService;
	coordinator: BoundAttemptCoordinator;
	runtimeId: string;
	executionPort?: BoundExecutionPort;
	identityRegistry?: BoundIdentityRegistryV1;
	pendingCancellations?: BoundPendingCancellationRegistryV2;
}

export interface BoundLaunchBridge {
	/** Terminal sink for this generation; the coordinator owns exactly-once delivery. */
	sink(terminal: BoundTerminal): void;
	dispose(): void;
}

function terminal(tuple: BoundAttemptTuple, status: string, extra: Record<string, unknown> = {}): BoundTerminal {
	return { requestId: tuple.requestId, ownerRunId: tuple.ownerRunId, nodeId: tuple.nodeId, status, ...extra };
}

export function registerBoundLaunchBridge(options: BoundLaunchBridgeOptions): BoundLaunchBridge {
	const identities = options.identityRegistry ?? getBoundIdentityRegistry();
	const pending = options.pendingCancellations ?? getBoundPendingCancellationRegistry();
	const serverInstanceId = options.service.serverInstanceId;
	let stopped = false;

	const sink = (value: BoundTerminal): void => { options.events.emit(BOUND_TERMINAL_EVENT, value); };

	/**
	 * Отказ до записи попытки. Координатор хранит терминал и публикует его сам, но при
	 * исчерпании ёмкости запись не создаётся: тогда терминал уходит напрямую, иначе
	 * клиент ждал бы ответа, которого не будет. Повтор уже осевшей тройки молчит —
	 * второй терминал на одну попытку недопустим.
	 */
	// Тройки, терминал которых опубликован в обход координатора (ёмкость исчерпана,
	// записи нет): повтор того же конверта не должен дать второй терминал.
	const sunkByCapacity = new Set<string>();
	const rejectWithTerminal = (tuple: BoundAttemptTuple, code: string, extra: Record<string, unknown> = {}): void => {
		const value = terminal(tuple, code, extra);
		if (options.coordinator.commitRejected(tuple, options.runtimeId, value) !== "capacity") return;
		const key = `${tuple.requestId}\u0000${tuple.ownerRunId}\u0000${tuple.nodeId}`;
		if (sunkByCapacity.has(key)) return;
		sunkByCapacity.add(key);
		sink(value);
	};

	const onLaunch = async (raw: unknown): Promise<void> => {
		if (stopped) return;
		const envelope = parseBoundLaunchEnvelope(raw);
		// A malformed envelope or a foreign target is silence, never a reply.
		if (!envelope || boundBindingTarget(envelope.binding) !== serverInstanceId) return;
		const tuple: BoundAttemptTuple = { requestId: envelope.requestId, ownerRunId: envelope.ownerRunId, nodeId: envelope.nodeId };
		const bindingKey = boundCancellationBindingKey(envelope.binding);
		const admitted = await options.service.admit(envelope.request, envelope.binding);
		if (!admitted.ok) {
			rejectWithTerminal(tuple, admitted.code === "invalid_request" ? "invalid_request" : "unavailable_context");
			return;
		}
		// From here to `started` everything is synchronous: no cancel or release can
		// interleave between the checks below and the admission they guard.
		const launch = admitted.launch;
		const closeMcp = (): void => { void launch.mcp?.close().catch(() => "failed" as const); };
		// Тройка конверта должна совпадать с тройкой подписанного запроса: иначе
		// отчётность и отмена шли бы по одной тройке, а доказательство — по другой,
		// и попытка стала бы неотменяемой.
		const signed = launch.request;
		if (signed.requestId !== tuple.requestId || signed.ownerRunId !== tuple.ownerRunId || signed.nodeId !== tuple.nodeId) {
			rejectWithTerminal(tuple, "invalid_request");
			return;
		}
		// D3: an authenticated cancel that arrived before admission wins here, before
		// any identity, attempt or `started`. The tuple is tombstoned by its one
		// terminal, so a delayed launch with the same tuple or ticket never starts.
		const pendingProof = options.service.verifyPendingCancellation(tuple, envelope.binding);
		if (pendingProof && pending.consume(tuple, pendingProof) === "cancelled") {
			const elapsedMs = pending.elapsedSinceLastConsumed();
			const repair = launch.contract.safety !== undefined;
			rejectWithTerminal(tuple, "cancelled", {
				launchContractDigest: launch.contract.digest,
				...(repair ? {
					cancellationProof: {
						version: 1, phase: "notAdmitted",
						requestId: tuple.requestId, ownerRunId: tuple.ownerRunId, nodeId: tuple.nodeId,
						prospectiveRunId: launch.request.prospectiveRunId, serverInstanceId,
						launchContractDigest: launch.contract.digest,
						session: "notCreated", shutdown: "notStarted", execution: "notStarted",
						revoked: true, collectorsSealed: false, elapsedMs,
					},
				} : { transportIncomplete: true }),
			});
			// The preparation was never owned by a run: its ticket stays with the
			// consumer's release (or its TTL), which closes it.
			return;
		}
		const prospectiveRunId = launch.request.prospectiveRunId;
		const reservation = identities.reserve(serverInstanceId, prospectiveRunId);
		if (reservation !== "reserved") {
			rejectWithTerminal(tuple, reservation === "duplicate" ? "duplicate_node" : "unavailable_context");
			return;
		}
		// D2: the ticket's ownership moves into this admission exactly once; a release,
		// TTL or generation stop that won earlier refuses it.
		if (!options.service.claimMcp(launch)) {
			identities.release(serverInstanceId, prospectiveRunId);
			rejectWithTerminal(tuple, "unavailable_context");
			return;
		}
		const attempt = options.coordinator.admit(tuple, options.runtimeId, bindingKey);
		if (!attempt.accepted) {
			identities.release(serverInstanceId, prospectiveRunId);
			closeMcp();
			if (attempt.reason === "duplicate_node") {
				rejectWithTerminal(tuple, "duplicate_node");
			} else if (attempt.reason === "capacity") {
				rejectWithTerminal(tuple, "unavailable_context");
			}
			// A duplicate tuple was already settled once; a second terminal is not published.
			return;
		}
		identities.commit(serverInstanceId, prospectiveRunId);
		options.events.emit(BOUND_STARTED_EVENT, { version: 2, ...tuple });
		const onUpdate = (update: Record<string, unknown>): void => {
			if (!attempt.isRunning()) return;
			options.events.emit(BOUND_UPDATE_EVENT, { version: 2, ...tuple, ...update });
		};
		try {
			const outcome = options.executionPort
				? await options.executionPort.run({ launch, signal: attempt.signal, onUpdate, commit: attempt.commit })
				: (closeMcp(), { status: "unavailable_context" });
			const reserved = new Set(["status", "requestId", "ownerRunId", "nodeId"]);
			attempt.settle(terminal(tuple, outcome.status, Object.fromEntries(Object.entries(outcome).filter(([key]) => !reserved.has(key)))));
		} catch {
			closeMcp();
			attempt.settle(terminal(tuple, "failed"));
		}
	};

	const onCancel = (raw: unknown): void => {
		if (stopped) return;
		const envelope = parseBoundCancelEnvelope(raw);
		if (!envelope || envelope.targetServerInstanceId !== serverInstanceId || boundBindingTarget(envelope.binding) !== serverInstanceId) return;
		const tuple: BoundAttemptTuple = { requestId: envelope.requestId, ownerRunId: envelope.ownerRunId, nodeId: envelope.nodeId };
		const active = options.service.verifyActiveCancellation(tuple, envelope.binding);
		if (active && options.coordinator.cancel(tuple.requestId, tuple.ownerRunId, tuple.nodeId, boundCancellationBindingKey(active))) return;
		if (!options.coordinator.canRememberCancellation(tuple.requestId, tuple.ownerRunId, tuple.nodeId)) return;
		const proof = options.service.verifyPendingCancellation(tuple, envelope.binding);
		if (proof) pending.remember(tuple, proof);
	};

	// The handler returns its promise so a caller that drives the bus can await the
	// admission; a rejection never escapes as an unhandled rejection.
	const unsubscribeLaunch = options.events.on(BOUND_LAUNCH_EVENT, (raw) => onLaunch(raw).catch(() => {}));
	const unsubscribeCancel = options.events.on(BOUND_CANCEL_EVENT, onCancel);

	return {
		sink,
		dispose() {
			stopped = true;
			if (typeof unsubscribeLaunch === "function") unsubscribeLaunch();
			if (typeof unsubscribeCancel === "function") unsubscribeCancel();
		},
	};
}
