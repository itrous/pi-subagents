import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLaunchReceiptService, type LaunchCancellationTokenV1, type LaunchReceiptService, type LaunchReceiptV1 } from "../api/launch-receipt.ts";
import type { ResolvedSubagentCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";
import { resolveActiveRuntimeSourceIdentity, type ActiveRuntimeSourceIdentityResolution } from "../extension/source-identity.ts";
import { toModelInfo } from "../shared/model-info.ts";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
import { resolveCurrentMaxSubagentDepth, type ExtensionConfig } from "../shared/types.ts";
import type { BoundAgentDiscoveryDeps } from "./bound-agent-discovery.ts";
import { boundLayerManifest, type BoundLayerManifestV2 } from "./bound-layer-manifest.ts";
import { boundRequestTarget, parseBoundRequest, type BoundRequestV2 } from "./bound-request.ts";
import { resolveBoundLaunchContract, type BoundLaunchContractV2, type BoundResolutionErrorCode } from "./bound-resolver.ts";
import { attestPiRuntime, type PiRuntimeAttestationResult } from "./pi-runtime-attestation.ts";
import { BOUND_CHANNEL_VERSION, parseBoundBindingProof, type BoundBindingV2 } from "./channel.ts";
import type { AgentConfig } from "../agents/agents.ts";

export const BOUND_PREFLIGHT_VERSION = BOUND_CHANNEL_VERSION;
const DEFAULT_FOREGROUND_TIMEOUT_MS = 30 * 60 * 1000;

export type BoundPreflightErrorCode = BoundResolutionErrorCode | "invalid_request" | "no_active_session" | "unverified_runtime";

export interface BoundPreflightSuccessV2 {
	version: typeof BOUND_PREFLIGHT_VERSION;
	serverInstanceId: string;
	sourceIdentityDigest: string;
	activeSessionDigest: string;
	canonicalCwd: string;
	requestDigest: string;
	launchContract: BoundLaunchContractV2;
	launchContractDigest: string;
	receipt: LaunchReceiptV1;
	cancellationToken: LaunchCancellationTokenV1;
}

export type BoundPreflightResult =
	| { ok: true; data: BoundPreflightSuccessV2 }
	| { ok: false; error: { version: typeof BOUND_PREFLIGHT_VERSION; code: BoundPreflightErrorCode } };

export interface BoundAuthorizedLaunch {
	request: BoundRequestV2;
	contract: BoundLaunchContractV2;
	agent: AgentConfig;
	packageExtensionPaths: string[];
}

export type BoundAdmissionResult =
	| { ok: true; launch: BoundAuthorizedLaunch }
	| { ok: false; code: BoundPreflightErrorCode };

export interface BoundRuntimeServiceOptions {
	serverInstanceId: string;
	getContext: () => ExtensionContext | null;
	config: ExtensionConfig;
	waitToolEnabled: boolean;
	resolveCapabilityCeiling: (sessionId: string) => ResolvedSubagentCapabilityCeiling | undefined;
	expandTilde?: (value: string) => string;
	/** Seam: source identity is Linux-only upstream, so every test supplies it here. */
	resolveSourceIdentity?: () => ActiveRuntimeSourceIdentityResolution;
	attestRuntime?: (expectedVersion?: string) => Promise<PiRuntimeAttestationResult>;
	layerManifest?: () => BoundLayerManifestV2;
	receipts?: LaunchReceiptService;
	discoveryDeps?: BoundAgentDiscoveryDeps;
	currentDepth?: number;
}

export interface BoundRuntimeService {
	readonly serverInstanceId: string;
	sourceIdentity(): ActiveRuntimeSourceIdentityResolution;
	preflight(params: unknown): Promise<BoundPreflightResult | undefined>;
	/** Final re-check: the contract is resolved again and must still hash the same. */
	admit(request: unknown, binding: unknown): Promise<BoundAdmissionResult>;
	verifyPendingCancellation(tuple: { requestId: string; ownerRunId: string; nodeId: string }, binding: unknown): BoundBindingV2 | undefined;
	verifyActiveCancellation(tuple: { requestId: string; ownerRunId: string; nodeId: string }, binding: unknown): BoundBindingV2 | undefined;
	dispose(): void;
}

function failure(code: BoundPreflightErrorCode): BoundPreflightResult {
	return { ok: false, error: { version: BOUND_PREFLIGHT_VERSION, code } };
}

export function createBoundRuntimeService(options: BoundRuntimeServiceOptions): BoundRuntimeService {
	const receipts = options.receipts ?? createLaunchReceiptService();
	const resolveIdentity = options.resolveSourceIdentity ?? (() => resolveActiveRuntimeSourceIdentity());
	const readManifest = options.layerManifest ?? (() => boundLayerManifest());
	const attest = options.attestRuntime ?? ((expectedVersion?: string) => attestPiRuntime(expectedVersion === undefined ? {} : { expectedVersion }));
	let disposed = false;
	let attestedVersion: string | undefined;

	const foregroundTimeoutMs = (): number => {
		const configured = options.config.timeoutMs;
		return typeof configured === "number" && Number.isInteger(configured) && configured > 0 && configured <= 2_147_483_647
			? configured
			: DEFAULT_FOREGROUND_TIMEOUT_MS;
	};

	const resolveContract = async (request: BoundRequestV2) => {
		if (disposed) return { ok: false as const, code: "unverified_source" as BoundPreflightErrorCode };
		const identity = resolveIdentity();
		if (!identity.available) return { ok: false as const, code: "unverified_source" as BoundPreflightErrorCode };
		const ctx = options.getContext();
		if (!ctx) return { ok: false as const, code: "no_active_session" as BoundPreflightErrorCode };
		const attested = await attest(attestedVersion);
		if (!attested.ok) return { ok: false as const, code: "unverified_runtime" as BoundPreflightErrorCode };
		attestedVersion ??= attested.runtime.attestation.version;
		let sessionId = "";
		try { sessionId = resolveCurrentSessionId(ctx.sessionManager); } catch { sessionId = ""; }
		let capabilityCeiling: ResolvedSubagentCapabilityCeiling | undefined;
		try { capabilityCeiling = sessionId ? options.resolveCapabilityCeiling(sessionId) : undefined; } catch { capabilityCeiling = undefined; }
		let resolved;
		try {
			resolved = resolveBoundLaunchContract({
				request,
				discoveryCwd: ctx.cwd,
				sessionManager: ctx.sessionManager,
				availableModels: ctx.modelRegistry.getAvailable().map(toModelInfo),
				serverInstanceId: options.serverInstanceId,
				sourceIdentityDigest: identity.sourceIdentity.digest,
				piRuntime: attested.runtime.attestation,
				runtimeBuiltins: attested.runtime.runtimeBuiltins,
				layerManifest: readManifest(),
				...(options.config.defaultSessionDir !== undefined ? { defaultSessionDir: options.config.defaultSessionDir } : {}),
				...(capabilityCeiling ? { capabilityCeiling } : {}),
				...(options.expandTilde ? { expandTilde: options.expandTilde } : {}),
				...(options.discoveryDeps ? { discoveryDeps: options.discoveryDeps } : {}),
				runtimePolicy: {
					foregroundTimeoutMs: foregroundTimeoutMs(),
					...(options.config.toolBudget !== undefined ? { toolBudget: options.config.toolBudget } : {}),
					...(options.config.permissions !== undefined ? { permissions: options.config.permissions } : {}),
					waitToolEnabled: options.waitToolEnabled,
					maxSubagentDepth: resolveCurrentMaxSubagentDepth(options.config.maxSubagentDepth),
					currentDepth: options.currentDepth ?? 0,
				},
			});
		} catch { return { ok: false as const, code: "host_required" as BoundPreflightErrorCode }; }
		return resolved.ok ? { ok: true as const, resolved, identity } : { ok: false as const, code: resolved.code as BoundPreflightErrorCode };
	};

	const verifyBinding = (
		tuple: { requestId: string; ownerRunId: string; nodeId: string },
		raw: unknown,
		enforceAdmissionLifetime: boolean,
	): BoundBindingV2 | undefined => {
		if (disposed) return undefined;
		const binding = parseBoundBindingProof(raw);
		if (!binding || binding.targetServerInstanceId !== options.serverInstanceId) return undefined;
		const identity = resolveIdentity();
		if (!identity.available || binding.expectedSourceIdentityDigest !== identity.sourceIdentity.digest) return undefined;
		if (enforceAdmissionLifetime
			? !receipts.verify(binding.receipt) || !receipts.verifyCancellation(binding.cancellationToken)
			: !receipts.verifyCancellationAuthenticity(binding.cancellationToken)) return undefined;
		// Ветка без проверки срока не ходит в receipts.verify, поэтому структуру receipt
		// проверяем здесь: подменённый `{}` обязан дать отказ, а не TypeError из
		// синхронного обработчика шины.
		if (!binding.receipt || typeof binding.receipt !== "object" || !binding.receipt.payload || typeof binding.receipt.payload !== "object") return undefined;
		const receipt = binding.receipt.payload; const token = binding.cancellationToken.payload;
		const consistent = receipt.serverInstanceId === options.serverInstanceId
			&& token.serverInstanceId === receipt.serverInstanceId && token.sourceIdentityDigest === receipt.sourceIdentityDigest
			&& token.activeSessionDigest === receipt.activeSessionDigest && token.prospectiveRunId === receipt.prospectiveRunId
			&& token.requestDigest === receipt.requestDigest && token.launchContractDigest === receipt.launchContractDigest
			&& token.issuedAt === receipt.issuedAt && token.expiresAt === receipt.expiresAt
			&& token.requestId === tuple.requestId && token.ownerRunId === tuple.ownerRunId && token.nodeId === tuple.nodeId
			&& receipt.activeSessionDigest === binding.expectedActiveSessionDigest
			&& receipt.sourceIdentityDigest === binding.expectedSourceIdentityDigest
			&& receipt.prospectiveRunId === binding.prospectiveRunId && receipt.requestDigest === binding.requestDigest
			&& receipt.launchContractDigest === binding.expectedLaunchContractDigest;
		return consistent ? binding : undefined;
	};

	return {
		serverInstanceId: options.serverInstanceId,
		sourceIdentity: () => resolveIdentity(),
		async preflight(params) {
			// Silence, not an error, when another responder in this process owns the target.
			if (boundRequestTarget(params) !== options.serverInstanceId) return undefined;
			const parsed = parseBoundRequest(params);
			if (!parsed.ok) return failure("invalid_request");
			const outcome = await resolveContract(parsed.request);
			if (!outcome.ok) return failure(outcome.code);
			const { resolved, identity } = outcome;
			let receipt: LaunchReceiptV1;
			let cancellationToken: LaunchCancellationTokenV1;
			try {
				receipt = receipts.issue({
					serverInstanceId: options.serverInstanceId,
					sourceIdentityDigest: identity.sourceIdentity.digest,
					activeSessionDigest: resolved.activeSessionDigest,
					prospectiveRunId: parsed.request.prospectiveRunId,
					requestDigest: resolved.requestDigest,
					launchContractDigest: resolved.launchContractDigest,
				});
				cancellationToken = receipts.issueCancellation(receipt, {
					requestId: parsed.request.requestId, ownerRunId: parsed.request.ownerRunId, nodeId: parsed.request.nodeId,
				});
			} catch { return failure("host_required"); }
			return {
				ok: true,
				data: {
					version: BOUND_PREFLIGHT_VERSION,
					serverInstanceId: options.serverInstanceId,
					sourceIdentityDigest: identity.sourceIdentity.digest,
					activeSessionDigest: resolved.activeSessionDigest,
					canonicalCwd: resolved.canonicalCwd,
					requestDigest: resolved.requestDigest,
					launchContract: resolved.contract,
					launchContractDigest: resolved.launchContractDigest,
					receipt,
					cancellationToken,
				},
			};
		},
		async admit(rawRequest, rawBinding) {
			if (disposed) return { ok: false, code: "unverified_source" };
			const parsed = parseBoundRequest(rawRequest);
			if (!parsed.ok) return { ok: false, code: "invalid_request" };
			const tuple = { requestId: parsed.request.requestId, ownerRunId: parsed.request.ownerRunId, nodeId: parsed.request.nodeId };
			const binding = verifyBinding(tuple, rawBinding, true);
			if (!binding || binding.prospectiveRunId !== parsed.request.prospectiveRunId) return { ok: false, code: "invalid_request" };
			const outcome = await resolveContract(parsed.request);
			if (!outcome.ok) return { ok: false, code: outcome.code };
			const { resolved } = outcome;
			// The whole resolution is repeated: a definition, skill, or binding that
			// changed since preflight produces a different contract digest here.
			if (resolved.requestDigest !== binding.requestDigest
				|| resolved.launchContractDigest !== binding.expectedLaunchContractDigest) return { ok: false, code: "invalid_request" };
			return {
				ok: true,
				launch: { request: parsed.request, contract: resolved.contract, agent: resolved.agent, packageExtensionPaths: resolved.packageExtensionPaths },
			};
		},
		// Семантика A1: TTL receipt ограничивает окно приёма, а не срок жизни принятой
		// попытки. Поэтому время проверяется у pending-отмены (запуск ещё не принят) и
		// НЕ проверяется у активной: иначе попытку нельзя остановить через 30 с.
		verifyPendingCancellation(tuple, binding) { return verifyBinding(tuple, binding, true); },
		verifyActiveCancellation(tuple, binding) { return verifyBinding(tuple, binding, false); },
		dispose() {
			if (disposed) return;
			disposed = true;
			receipts.dispose();
		},
	};
}
