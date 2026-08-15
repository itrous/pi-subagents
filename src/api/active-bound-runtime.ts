import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedSubagentCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
import { resolveCurrentMaxSubagentDepth, type ExtensionConfig } from "../shared/types.ts";
import type { AvailableModelInfo } from "../runs/shared/model-fallback.ts";
import {
	activeBoundPreflightRequestDigest,
	parseActiveBoundPreflightRequest,
	type ActiveBoundPreflightRequestV1,
} from "./active-bound-preflight.ts";
import {
	resolveActiveBoundLaunchContract,
	type ActiveBoundLaunchContractV1,
	type ResolveActiveBoundLaunchContractResult,
} from "./active-bound-resolver.ts";
import { createLaunchReceiptService, type LaunchReceiptService, type LaunchReceiptV1 } from "./launch-receipt.ts";

export interface ActiveBoundRuntimeContext extends Pick<ExtensionContext, "cwd" | "sessionManager" | "modelRegistry"> {
	isProjectTrusted?: () => boolean;
}

export interface ActiveBoundBindingV1 {
	version: 1;
	targetServerInstanceId: string;
	prospectiveRunId: string;
	expectedSourceIdentityDigest: string;
	expectedActiveSessionDigest: string;
	requestDigest: string;
	expectedLaunchContractDigest: string;
	receipt: LaunchReceiptV1;
}

export interface ActiveBoundRootIdentityV1 { dev: number; ino: number }

export interface ActiveBoundExecutionProofV1 {
	version: 1;
	request: ActiveBoundPreflightRequestV1;
	contract: ActiveBoundLaunchContractV1;
	launchContractDigest: string;
	receipt: LaunchReceiptV1;
}

export interface ActiveBoundRuntimeService {
	readonly version: 1;
	readonly serverInstanceId: string;
	readonly sourceIdentityDigest: string;
	preflight(input: unknown): ActiveBoundPreflightResponseV1;
	admit(request: ActiveBoundPreflightRequestV1, binding: ActiveBoundBindingV1): ActiveBoundAdmissionResult;
	claimBase(proof: ActiveBoundExecutionProofV1, identity: ActiveBoundRootIdentityV1, created: boolean): boolean;
	recheck(proof: ActiveBoundExecutionProofV1, options?: { ownedBaseRootIdentity?: ActiveBoundRootIdentityV1; ownedRootIdentity?: ActiveBoundRootIdentityV1; ownedSessionDirIdentity?: ActiveBoundRootIdentityV1 }): boolean;
	dispose(): void;
}

export type ActiveBoundPreflightErrorCode = "invalid_request" | "no_active_session" | "unverified_source" | "invalid_cwd" | "host_required" | "missing_agent" | "ambiguous_agent" | "missing_skill" | "unsupported_mode" | "unavailable_model" | "restricted_agent";
export type ActiveBoundPreflightResponseV1 =
	| {
		version: 1;
		serverInstanceId: string;
		sourceIdentityDigest: string;
		activeSessionDigest: string;
		canonicalCwd: string;
		requestDigest: string;
		launchContract: ActiveBoundLaunchContractV1;
		launchContractDigest: string;
		receipt: LaunchReceiptV1;
	}
	| { version: 1; code: ActiveBoundPreflightErrorCode };
export type ActiveBoundAdmissionResult =
	| { ok: true; proof: ActiveBoundExecutionProofV1 }
	| { ok: false; code: "invalid_request" | "unavailable_context" };

export interface CreateActiveBoundRuntimeServiceOptions {
	serverInstanceId: string;
	sourceIdentityDigest: string;
	getContext: () => ActiveBoundRuntimeContext | null;
	config: ExtensionConfig;
	waitToolEnabled: boolean;
	resolveCapabilityCeiling: (sessionId: string) => ResolvedSubagentCapabilityCeiling | undefined;
	currentDepth?: number;
	maxSubagentDepth?: number;
	verifySourceIdentity?: () => boolean;
	expandTilde?: (value: string) => string;
	receipts?: LaunchReceiptService;
}

function toModelInfo(model: unknown): AvailableModelInfo {
	return model as AvailableModelInfo;
}

export function activeBoundRequestFromDelegation(
	request: {
		requestId: string; ownerRunId: string; nodeId: string; agent: string; task: string; context: "fresh";
		cwd: string; model: string; thinking: ActiveBoundPreflightRequestV1["thinking"]; timeoutMs?: number;
		turnBudget?: ActiveBoundPreflightRequestV1["turnBudget"]; toolBudget?: ActiveBoundPreflightRequestV1["toolBudget"];
		skill?: ActiveBoundPreflightRequestV1["skill"]; environment?: ActiveBoundPreflightRequestV1["environment"];
		artifacts: boolean; artifactDir?: "session"; result: ActiveBoundPreflightRequestV1["result"];
	},
	binding: ActiveBoundBindingV1,
): ActiveBoundPreflightRequestV1 {
	return {
		version: 1,
		targetServerInstanceId: binding.targetServerInstanceId,
		requestId: request.requestId,
		ownerRunId: request.ownerRunId,
		nodeId: request.nodeId,
		prospectiveRunId: binding.prospectiveRunId,
		agent: request.agent,
		task: request.task,
		cwd: request.cwd,
		context: "fresh",
		model: request.model,
		thinking: request.thinking,
		...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
		...(request.turnBudget !== undefined ? { turnBudget: request.turnBudget } : {}),
		...(request.toolBudget !== undefined ? { toolBudget: request.toolBudget } : {}),
		...(request.skill !== undefined ? { skill: request.skill } : {}),
		...(request.environment && Object.keys(request.environment).length ? { environment: Object.assign(Object.create(null), request.environment) as ActiveBoundPreflightRequestV1["environment"] } : {}),
		artifacts: request.artifacts,
		...(request.artifactDir ? { artifactDir: request.artifactDir } : {}),
		result: request.result,
	};
}

export function createActiveBoundRuntimeService(options: CreateActiveBoundRuntimeServiceOptions): ActiveBoundRuntimeService {
	const receipts = options.receipts ?? createLaunchReceiptService();
	let disposed = false;
	const ownedFutureBaseIdentities = new Map<string, ActiveBoundRootIdentityV1>();
	const runtimeMaxSubagentDepth = options.maxSubagentDepth ?? resolveCurrentMaxSubagentDepth(options.config.maxSubagentDepth);
	const ambientDepth = Number(process.env.PI_SUBAGENT_DEPTH);
	const runtimeCurrentDepth = options.currentDepth ?? (process.env.PI_SUBAGENT_DEPTH === undefined ? 0 : ambientDepth);
	const resolve = (request: ActiveBoundPreflightRequestV1, ownedRootIdentity?: ActiveBoundRootIdentityV1, ownedSessionDirIdentity?: ActiveBoundRootIdentityV1, ownedBaseRootIdentity?: ActiveBoundRootIdentityV1, projectOwnedBaseAsFuture = false): ResolveActiveBoundLaunchContractResult => {
		if (disposed) return { ok: false, code: "unverified_source" };
		try {
			if (options.verifySourceIdentity && !options.verifySourceIdentity()) return { ok: false, code: "unverified_source" };
			const ctx = options.getContext();
			if (!ctx) return { ok: false, code: "host_required" };
			let sessionId: string;
			try { sessionId = resolveCurrentSessionId(ctx.sessionManager); } catch { sessionId = ""; }
			return resolveActiveBoundLaunchContract({
				request,
				activeCwd: ctx.cwd,
				sessionManager: ctx.sessionManager,
				availableModels: ctx.modelRegistry.getAvailable().map(toModelInfo),
				serverInstanceId: options.serverInstanceId,
				sourceIdentityDigest: options.sourceIdentityDigest,
				isProjectTrusted: ctx.isProjectTrusted,
				defaultSessionDir: options.config.defaultSessionDir,
				ownedBaseRootIdentity,
				projectOwnedBaseAsFuture,
				ownedRootIdentity,
				ownedSessionDirIdentity,
				capabilityCeiling: sessionId ? options.resolveCapabilityCeiling(sessionId) : undefined,
				expandTilde: options.expandTilde,
				runtimePolicy: {
					foregroundTimeoutMs: 30 * 60 * 1000,
					turnBudget: options.config.turnBudget,
					toolBudget: options.config.toolBudget,
					permissions: options.config.permissions,
					waitToolEnabled: options.waitToolEnabled,
					maxSubagentDepth: runtimeMaxSubagentDepth,
					currentDepth: runtimeCurrentDepth,
				},
			});
		} catch { return { ok: false, code: "host_required" }; }
	};
	return {
		version: 1,
		serverInstanceId: options.serverInstanceId,
		sourceIdentityDigest: options.sourceIdentityDigest,
		preflight(input) {
			const parsed = parseActiveBoundPreflightRequest(input);
			if (!parsed.ok) return { version: 1, code: "invalid_request" };
			if (parsed.request.targetServerInstanceId !== options.serverInstanceId) return { version: 1, code: "invalid_request" };
			try { if (!options.getContext()) return { version: 1, code: "no_active_session" }; }
			catch { return { version: 1, code: "host_required" }; }
			const resolved = resolve(parsed.request);
			if (!resolved.ok) return { version: 1, code: resolved.code };
			const receipt = receipts.issue({
				serverInstanceId: options.serverInstanceId,
				sourceIdentityDigest: options.sourceIdentityDigest,
				activeSessionDigest: resolved.activeSessionDigest,
				prospectiveRunId: parsed.request.prospectiveRunId,
				requestDigest: resolved.requestDigest,
				launchContractDigest: resolved.launchContractDigest,
			});
			return {
				version: 1,
				serverInstanceId: options.serverInstanceId,
				sourceIdentityDigest: options.sourceIdentityDigest,
				activeSessionDigest: resolved.activeSessionDigest,
				canonicalCwd: resolved.canonicalCwd,
				requestDigest: resolved.requestDigest,
				launchContract: resolved.contract,
				launchContractDigest: resolved.launchContractDigest,
				receipt,
			};
		},
		admit(request, binding) {
			if (disposed || binding.version !== 1 || binding.targetServerInstanceId !== options.serverInstanceId
				|| binding.prospectiveRunId !== request.prospectiveRunId
				|| binding.expectedSourceIdentityDigest !== options.sourceIdentityDigest
				|| binding.requestDigest !== activeBoundPreflightRequestDigest(request)
				|| binding.receipt.payload.serverInstanceId !== options.serverInstanceId
				|| binding.receipt.payload.sourceIdentityDigest !== options.sourceIdentityDigest
				|| binding.receipt.payload.activeSessionDigest !== binding.expectedActiveSessionDigest
				|| binding.receipt.payload.prospectiveRunId !== binding.prospectiveRunId
				|| binding.receipt.payload.requestDigest !== binding.requestDigest
				|| binding.receipt.payload.launchContractDigest !== binding.expectedLaunchContractDigest
				|| !receipts.verify(binding.receipt)) return { ok: false, code: "invalid_request" };
			let resolved = resolve(request);
			const ownedFutureBaseIdentity = resolved.ok ? ownedFutureBaseIdentities.get(resolved.contract.roots.baseRootPathDigest) : undefined;
			if (resolved.ok && resolved.launchContractDigest !== binding.expectedLaunchContractDigest && ownedFutureBaseIdentity) {
				resolved = resolve(request, undefined, undefined, ownedFutureBaseIdentity, true);
			}
			if (!resolved.ok) return { ok: false, code: resolved.code === "host_required" ? "unavailable_context" : "invalid_request" };
			if (resolved.activeSessionDigest !== binding.expectedActiveSessionDigest
				|| resolved.requestDigest !== binding.requestDigest
				|| resolved.launchContractDigest !== binding.expectedLaunchContractDigest) return { ok: false, code: "invalid_request" };
			return { ok: true, proof: { version: 1, request, contract: resolved.contract, launchContractDigest: resolved.launchContractDigest, receipt: binding.receipt } };
		},
		claimBase(proof, identity, created) {
			if (disposed || proof.version !== 1) return false;
			if (proof.contract.roots.baseRootIdentityDigest !== undefined) return true;
			const key = proof.contract.roots.baseRootPathDigest;
			const ownedFutureBaseIdentity = ownedFutureBaseIdentities.get(key);
			if (!ownedFutureBaseIdentity) {
				if (!created) return false;
				ownedFutureBaseIdentities.set(key, { ...identity });
				return true;
			}
			return ownedFutureBaseIdentity.dev === identity.dev && ownedFutureBaseIdentity.ino === identity.ino;
		},
		recheck(proof, recheckOptions) {
			if (disposed || proof.version !== 1) return false;
			const ownedBaseRootIdentity = recheckOptions?.ownedBaseRootIdentity ?? ownedFutureBaseIdentities.get(proof.contract.roots.baseRootPathDigest);
			const projectOwnedBaseAsFuture = proof.contract.roots.baseRootIdentityDigest === undefined && ownedBaseRootIdentity !== undefined;
			const resolved = resolve(proof.request, recheckOptions?.ownedRootIdentity, recheckOptions?.ownedSessionDirIdentity, ownedBaseRootIdentity, projectOwnedBaseAsFuture);
			const matches = resolved.ok && resolved.launchContractDigest === proof.launchContractDigest;
			if (matches && projectOwnedBaseAsFuture && ownedBaseRootIdentity) ownedFutureBaseIdentities.set(proof.contract.roots.baseRootPathDigest, { ...ownedBaseRootIdentity });
			return matches;
		},
		dispose() { if (!disposed) { disposed = true; receipts.dispose(); } },
	};
}
