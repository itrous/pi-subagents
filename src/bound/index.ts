import { randomUUID } from "node:crypto";
import type { ExtensionContext, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { LaunchReceiptService } from "../api/launch-receipt.ts";
import type { ResolvedSubagentCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";
import type { ActiveRuntimeSourceIdentityResolution } from "../extension/source-identity.ts";
import type { ExtensionConfig } from "../shared/types.ts";
import { BoundAttemptCoordinator, getBoundAttemptCoordinator } from "./bound-attempt-coordinator.ts";
import { registerBoundLaunchBridge, type BoundExecutionPort } from "./bound-launch-bridge.ts";
import { createBoundRuntimeService, type BoundRuntimeService, type BoundRuntimeServiceOptions } from "./bound-runtime-service.ts";
import { installBoundedChildShutdown, type BoundedChildShutdownOptions } from "./bounded-child-shutdown.ts";
import {
	BOUND_CHANNEL_EVENTS, BOUND_CHANNEL_VERSION, BOUND_METHODS, BOUND_READY_EVENT, BOUND_REQUEST_EVENT,
	boundReplyEvent, parseBoundRequestEnvelope, type BoundEventBus, type BoundReplyEnvelopeV2,
} from "./channel.ts";

export const BOUND_CONTROL_PLANE_GLOBAL_KEY = "__piSubagentBoundControlPlaneV2";

interface BoundControlPlanePi {
	on(event: "session_start", handler: (event: SessionStartEvent, ctx: ExtensionContext) => unknown): unknown;
	on(event: "session_shutdown", handler: (event: SessionShutdownEvent, ctx: ExtensionContext) => unknown): unknown;
}

export interface BoundSessionProjection {
	cwd?: string;
	sessionId?: string;
	sessionFile?: string | null;
}

export interface BoundPingV2 {
	serverInstanceId: string;
	sourceIdentity?: { version: 1; kind: "git"; repository: string; commit: string; digest: string };
	sourceIdentityUnavailable?: { version: 1; reasonCode: string };
	version: typeof BOUND_CHANNEL_VERSION;
	methods: string[];
	capabilities: Record<string, unknown>;
	events: Record<string, string>;
	session: BoundSessionProjection;
}

export interface RegisterBoundControlPlaneOptions {
	pi: BoundControlPlanePi;
	events: BoundEventBus;
	getContext: () => ExtensionContext | null;
	config: ExtensionConfig;
	waitToolEnabled: boolean;
	resolveCapabilityCeiling: (sessionId: string) => ResolvedSubagentCapabilityCeiling | undefined;
	expandTilde?: (value: string) => string;
	/** Optional seams; T1 passes none, only tests do. */
	serverInstanceId?: string;
	resolveSourceIdentity?: () => ActiveRuntimeSourceIdentityResolution;
	attestRuntime?: BoundRuntimeServiceOptions["attestRuntime"];
	layerManifest?: BoundRuntimeServiceOptions["layerManifest"];
	receipts?: LaunchReceiptService;
	discoveryDeps?: BoundRuntimeServiceOptions["discoveryDeps"];
	coordinator?: BoundAttemptCoordinator;
	executionPort?: BoundExecutionPort;
	childShutdown?: BoundedChildShutdownOptions | false;
	store?: Record<string, unknown>;
}

export interface BoundControlPlane {
	serverInstanceId: string;
	stop(options?: { keepSink?: boolean }): void;
}

interface PublishedGeneration {
	serverInstanceId: string;
	stop(options?: { keepSink?: boolean }): void;
}

function sessionProjection(ctx: ExtensionContext | null): BoundSessionProjection {
	if (!ctx) return {};
	return {
		cwd: ctx.cwd,
		sessionId: ctx.sessionManager.getSessionId() ?? undefined,
		sessionFile: ctx.sessionManager.getSessionFile() ?? null,
	};
}

export function buildBoundPing(serverInstanceId: string, identity: ActiveRuntimeSourceIdentityResolution, ctx: ExtensionContext | null): BoundPingV2 {
	// D5: `activeRuntimeIdentity` only with a verified checkout; `boundForegroundLeaf`
	// is not announced at all until the end of A1R.4.
	return {
		serverInstanceId,
		...(identity.available ? { sourceIdentity: identity.sourceIdentity } : { sourceIdentityUnavailable: identity.sourceIdentityUnavailable }),
		version: BOUND_CHANNEL_VERSION,
		methods: [...BOUND_METHODS],
		capabilities: identity.available ? { activeRuntimeIdentity: { version: 2 } } : {},
		events: { ...BOUND_CHANNEL_EVENTS },
		session: sessionProjection(ctx),
	};
}

/**
 * Bring up the fork control plane on `subagents:bound:v2:*`. The upstream
 * `subagents:rpc:v1:*` and `prompt-template:subagent:*` channels are neither
 * listened to nor occupied (decision R7).
 */
export function registerBoundControlPlane(options: RegisterBoundControlPlaneOptions): BoundControlPlane {
	const store = options.store ?? (globalThis as Record<string, unknown>);
	const serverInstanceId = options.serverInstanceId ?? randomUUID();
	const runtimeId = serverInstanceId;
	const coordinator = options.coordinator ?? getBoundAttemptCoordinator(store);
	let currentContext: ExtensionContext | null = null;
	let stopped = false;
	let published = false;

	const contextForReply = (): ExtensionContext | null => currentContext ?? options.getContext();
	const service: BoundRuntimeService = createBoundRuntimeService({
		serverInstanceId,
		getContext: contextForReply,
		config: options.config,
		waitToolEnabled: options.waitToolEnabled,
		resolveCapabilityCeiling: options.resolveCapabilityCeiling,
		...(options.expandTilde ? { expandTilde: options.expandTilde } : {}),
		...(options.resolveSourceIdentity ? { resolveSourceIdentity: options.resolveSourceIdentity } : {}),
		...(options.attestRuntime ? { attestRuntime: options.attestRuntime } : {}),
		...(options.layerManifest ? { layerManifest: options.layerManifest } : {}),
		...(options.receipts ? { receipts: options.receipts } : {}),
		...(options.discoveryDeps ? { discoveryDeps: options.discoveryDeps } : {}),
	});

	const bridge = registerBoundLaunchBridge({
		events: options.events,
		service,
		coordinator,
		runtimeId,
		...(options.executionPort ? { executionPort: options.executionPort } : {}),
	});

	const reply = (envelope: BoundReplyEnvelopeV2): void => { options.events.emit(boundReplyEvent(envelope.requestId), envelope); };

	const unsubscribeRequest = options.events.on(BOUND_REQUEST_EVENT, (raw) => {
		// The promise is returned so a caller that drives the bus can await the reply.
		return (async () => {
			if (stopped || !published) return;
			const request = parseBoundRequestEnvelope(raw);
			// An unparseable envelope has no addressable requestId: stay silent.
			if (!request) return;
			if (request.method === "ping") {
				reply({ version: BOUND_CHANNEL_VERSION, requestId: request.requestId, method: "ping", success: true, data: buildBoundPing(serverInstanceId, service.sourceIdentity(), contextForReply()) });
				return;
			}
			const outcome = await service.preflight(request.params);
			// A foreign target belongs to another responder in this process.
			if (!outcome || stopped) return;
			reply(outcome.ok
				? { version: BOUND_CHANNEL_VERSION, requestId: request.requestId, method: "preflight", success: true, data: outcome.data }
				: { version: BOUND_CHANNEL_VERSION, requestId: request.requestId, method: "preflight", success: false, error: outcome.error });
		})().catch(() => {});
	});

	const stop = (stopOptions: { keepSink?: boolean } = {}): void => {
		if (stopped) return;
		stopped = true;
		if (typeof unsubscribeRequest === "function") unsubscribeRequest();
		bridge.dispose();
		service.dispose();
		// Live attempts of this generation are aborted; their single terminal is
		// delivered through whichever sink is active when they settle.
		coordinator.stopOwner(runtimeId);
		if (!stopOptions.keepSink) coordinator.deactivateSink(runtimeId);
		if (store[BOUND_CONTROL_PLANE_GLOBAL_KEY] === generation) delete store[BOUND_CONTROL_PLANE_GLOBAL_KEY];
	};

	const generation: PublishedGeneration = { serverInstanceId, stop };

	// Publication: take the slot, stop the previous generation, then activate this
	// sink. A failure before publication leaves the previous generation untouched.
	const previous = store[BOUND_CONTROL_PLANE_GLOBAL_KEY] as PublishedGeneration | undefined;
	if (previous !== undefined && (typeof previous !== "object" || typeof previous.stop !== "function" || typeof previous.serverInstanceId !== "string")) {
		bridge.dispose();
		service.dispose();
		if (typeof unsubscribeRequest === "function") unsubscribeRequest();
		throw new Error("Incompatible process-global bound control plane generation.");
	}
	store[BOUND_CONTROL_PLANE_GLOBAL_KEY] = generation;
	if (previous) {
		try { previous.stop(); } catch { /* the replaced generation is best-effort */ }
	}
	coordinator.activateSink(runtimeId, bridge.sink);
	if (options.childShutdown !== false) installBoundedChildShutdown(options.childShutdown ?? {});
	published = true;

	// Registered from T1, before the upstream handlers: `session_start` (:1162)
	// assigns `state.lastUiContext`, so the ready payload takes the context from
	// this handler's own argument instead.
	options.pi.on("session_start", (_event, ctx) => {
		if (stopped) return;
		currentContext = ctx ?? null;
		options.events.emit(BOUND_READY_EVENT, buildBoundPing(serverInstanceId, service.sourceIdentity(), currentContext));
	});

	options.pi.on("session_shutdown", () => {
		// The time limit lives in the child-session factory wrapper, so this handler
		// never awaits `abort()`; it only stops intake and settles live attempts.
		stop({ keepSink: true });
	});

	return generation;
}
