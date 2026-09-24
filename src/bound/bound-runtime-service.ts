import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLaunchReceiptService, type LaunchCancellationTokenV1, type LaunchReceiptService, type LaunchReceiptV1 } from "../api/launch-receipt.ts";
import type { ResolvedSubagentCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";
import { resolveActiveRuntimeSourceIdentity, type ActiveRuntimeSourceIdentityResolution } from "../extension/source-identity.ts";
import { toModelInfo } from "../shared/model-info.ts";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
import { resolveCurrentMaxSubagentDepth, type ExtensionConfig } from "../shared/types.ts";
import type { BoundAgentDiscoveryDeps } from "./bound-agent-discovery.ts";
import { boundLayerManifest, type BoundLayerManifestV2 } from "./bound-layer-manifest.ts";
import { boundRequestBaseDigest, boundRequestTarget, parseBoundRequest, type BoundRequestV2 } from "./bound-request.ts";
import {
	resolveBoundLaunchContract, resolveBoundMcpPreparationPlan, type BoundLaunchContractV2, type BoundResolutionErrorCode,
	type ResolveBoundLaunchContractInput,
} from "./bound-resolver.ts";
import {
	BOUND_MCP_BRIDGE_IMPLEMENTATION, BOUND_MCP_BRIDGE_RUNTIME_PATH, BOUND_MCP_CONFIG_EXTENSION, BOUND_MCP_CONFIG_V2_VERSION,
	boundMcpDefinitionsAgree, explicitBoundMcpSelectors, isBoundMcpConfigContractV2, isBoundMcpConfigFinal, isBoundMcpConfigV2,
	measureBoundMcpConfig, validBoundMcpBridgeConfig, type BoundMcpConfigContractV2,
} from "./bound-mcp-config.ts";
import {
	boundMcpPackageEvidenceDigest, discoverBoundMcp, loadBoundMcpAdapterAbi, measureBoundMcpAdapter,
	type BoundMcpDiscoveryErrorCode,
} from "./bound-mcp-direct-bridge.ts";
import {
	BOUND_MCP_PREPARATION_VERSION, BoundMcpPreparationRegistry, boundMcpParamsTarget, boundMcpSnapshotDigest,
	parseBoundMcpPreparationParams, parseBoundMcpReleaseParams, type BoundMcpPreparation, type BoundMcpPreparationReplyV1,
	type BoundMcpReleaseStatus, type BoundMcpSnapshotV1,
} from "./bound-mcp-preparation.ts";
import { issueBoundMcpSelections, type BoundMcpSelectionsHandle } from "./bound-mcp-selections.ts";
import { canonicalSha256 } from "../shared/canonical-json.ts";
import { attestPiRuntime, type PiRuntimeAttestationResult } from "./pi-runtime-attestation.ts";
import { BOUND_CHANNEL_VERSION, parseBoundBindingProof, type BoundBindingV2 } from "./channel.ts";
import type { AgentConfig } from "../agents/agents.ts";
import type { BoundResolvedPackageExtensions } from "./bound-package-extensions.ts";

export const BOUND_PREFLIGHT_VERSION = BOUND_CHANNEL_VERSION;
const DEFAULT_FOREGROUND_TIMEOUT_MS = 30 * 60 * 1000;

/** Discovery failures keep their own bounded reason (D2) instead of a generic `restricted_agent`. */
export type BoundMcpPreparationErrorCode =
	| BoundMcpDiscoveryErrorCode | "mcp_discovery_capacity" | "mcp_config_invalid" | "mcp_config_mismatch"
	| "mcp_selector_invalid" | "mcp_ticket_invalid" | "mcp_snapshot_drift" | "mcp_release_failed";

export type BoundPreflightErrorCode = BoundResolutionErrorCode | BoundMcpPreparationErrorCode | "invalid_request" | "no_active_session" | "unverified_runtime";

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

/**
 * The run's MCP snapshot (S3 P2): the preparation that measured it, the handle
 * the tool plan resolves names through, and the one close of its connections.
 * Ownership is transferred by `claimMcp` at admission, exactly once.
 */
export interface BoundLaunchMcp {
	preparation: BoundMcpPreparation;
	selections: BoundMcpSelectionsHandle;
	/** Idempotent bounded close of the run's MCP connections. */
	close(): Promise<"closed" | "timeout" | "failed">;
}

export interface BoundAuthorizedLaunch {
	request: BoundRequestV2;
	contract: BoundLaunchContractV2;
	agent: AgentConfig;
	packageExtensionPaths: string[];
	/** Private entry evidence the child factory re-measures before loading; never published. */
	packageAttestations: BoundResolvedPackageExtensions["attestations"];
	/** Present for a repair request with a v2 MCP configuration only. */
	mcp?: BoundLaunchMcp;
}

export type BoundMcpPrepareResult =
	| { ok: true; data: BoundMcpPreparationReplyV1 }
	| { ok: false; error: { version: typeof BOUND_PREFLIGHT_VERSION; code: BoundPreflightErrorCode } };

export type BoundMcpReleaseResult =
	| { ok: true; data: { version: typeof BOUND_MCP_PREPARATION_VERSION; status: BoundMcpReleaseStatus } }
	| { ok: false; error: { version: typeof BOUND_PREFLIGHT_VERSION; code: BoundPreflightErrorCode } };

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
	/** Seam: source identity needs a verified Linux or macOS 15+ Git checkout, so every test supplies it here. */
	resolveSourceIdentity?: () => ActiveRuntimeSourceIdentityResolution;
	attestRuntime?: (expectedVersion?: string) => Promise<PiRuntimeAttestationResult>;
	layerManifest?: () => BoundLayerManifestV2;
	receipts?: LaunchReceiptService;
	discoveryDeps?: BoundAgentDiscoveryDeps;
	currentDepth?: number;
	/** Test seams for the preparation budgets (D2); production uses the plan values. */
	mcpPreparations?: BoundMcpPreparationRegistry;
	mcpDiscoveryBudget?: Parameters<typeof discoverBoundMcp>[0]["budget"];
}

export interface BoundRuntimeService {
	readonly serverInstanceId: string;
	sourceIdentity(): ActiveRuntimeSourceIdentityResolution;
	preflight(params: unknown): Promise<BoundPreflightResult | undefined>;
	/** Final re-check: the contract is resolved again and must still hash the same. */
	admit(request: unknown, binding: unknown): Promise<BoundAdmissionResult>;
	verifyPendingCancellation(tuple: { requestId: string; ownerRunId: string; nodeId: string }, binding: unknown): BoundBindingV2 | undefined;
	verifyActiveCancellation(tuple: { requestId: string; ownerRunId: string; nodeId: string }, binding: unknown): BoundBindingV2 | undefined;
	/** `prepareMcp` (D2); undefined for a foreign target. */
	prepareMcp(params: unknown): Promise<BoundMcpPrepareResult | undefined>;
	/** `releaseMcp` (D2/D4); undefined for a foreign target. */
	releaseMcp(params: unknown): Promise<BoundMcpReleaseResult | undefined>;
	/**
	 * Atomic ownership transfer of an admitted launch's preparation into its run.
	 * True for a launch without MCP snapshot; false when a release, TTL or
	 * generation stop won.
	 */
	claimMcp(launch: BoundAuthorizedLaunch): boolean;
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

	const preparations = options.mcpPreparations ?? new BoundMcpPreparationRegistry();
	// A generation stop aborts every discovery still in flight (D2: reload closes resources).
	const generation = new AbortController();

	/** Everything the resolution reads from the host, or the refusal code. */
	const resolutionInput = async (request: BoundRequestV2) => {
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
		let input: ResolveBoundLaunchContractInput;
		try {
			input = {
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
			};
		} catch { return { ok: false as const, code: "host_required" as BoundPreflightErrorCode }; }
		return { ok: true as const, input, identity };
	};

	const bridgeEvidence = (manifest: BoundLayerManifestV2) => {
		const entry = manifest.entries.find((candidate) => candidate.name === BOUND_MCP_BRIDGE_RUNTIME_PATH);
		return entry ? { runtimePath: BOUND_MCP_BRIDGE_RUNTIME_PATH, contentDigest: entry.contentDigest } : undefined;
	};

	/**
	 * Final recheck of a v2 request against its ticket (D2): the record is still
	 * prepared, for this tuple, run, source and request; the configuration bytes
	 * are those of the snapshot; nothing announced a changed list.
	 */
	const preparationFor = (request: BoundRequestV2, sourceIdentityDigest: string): BoundMcpPreparation | BoundPreflightErrorCode => {
		const mcpConfig = request.mcpConfig;
		if (!isBoundMcpConfigFinal(mcpConfig)) return "invalid_request";
		const preparation = preparations.prepared(mcpConfig.ticket);
		if (!preparation || preparation.serverInstanceId !== options.serverInstanceId
			|| preparation.requestId !== request.requestId || preparation.ownerRunId !== request.ownerRunId || preparation.nodeId !== request.nodeId
			|| preparation.prospectiveRunId !== request.prospectiveRunId || preparation.sourceIdentityDigest !== sourceIdentityDigest
			|| preparation.snapshotDigest !== mcpConfig.snapshotDigest || preparation.configPath !== mcpConfig.path
			|| boundRequestBaseDigest(request) !== preparation.snapshot.requestBaseDigest) return "mcp_ticket_invalid";
		const measured = measureBoundMcpConfig(mcpConfig.path);
		if (preparation.discovery.invalidated() || !measured || !validBoundMcpBridgeConfig(measured.config)
			|| measured.contentDigest !== preparation.snapshot.contentDigest || measured.effectiveDigest !== preparation.snapshot.effectiveDigest) return "mcp_snapshot_drift";
		return preparation;
	};

	/** The adapter record, its private entries and the bridge still measure to the snapshot's evidence. */
	const packageEvidenceAgrees = (resolved: { contract: BoundLaunchContractV2; packageAttestations: BoundResolvedPackageExtensions["attestations"] }, contract: BoundMcpConfigContractV2): boolean => {
		const adapters = resolved.contract.packageExtensions.filter((entry) => entry.ref === BOUND_MCP_CONFIG_EXTENSION);
		const attestations = resolved.packageAttestations.filter((entry) => entry.ref === BOUND_MCP_CONFIG_EXTENSION);
		if (adapters.length !== 1 || attestations.length !== 1) return false;
		const measurement = measureBoundMcpAdapter(adapters[0]!, attestations[0]!);
		const bridge = bridgeEvidence(readManifest());
		if (!measurement || !bridge || bridge.contentDigest !== contract.bridge.contentDigest) return false;
		return canonicalSha256(measurement.entryDigests) === canonicalSha256(contract.entryDigests)
			&& boundMcpPackageEvidenceDigest({ adapter: adapters[0]!, entryDigests: measurement.entryDigests, bridge }) === contract.packageEvidenceDigest;
	};

	const resolveContract = async (request: BoundRequestV2) => {
		const prepared = await resolutionInput(request);
		if (!prepared.ok) return prepared;
		const { input, identity } = prepared;
		let preparation: BoundMcpPreparation | undefined;
		if (isBoundMcpConfigV2(request.mcpConfig)) {
			const found = preparationFor(request, identity.sourceIdentity.digest);
			if (typeof found === "string") return { ok: false as const, code: found };
			preparation = found;
		}
		let resolved;
		try {
			resolved = resolveBoundLaunchContract({
				...input,
				...(preparation ? { mcpSnapshot: { selections: preparation.selections, contract: preparation.contract } } : {}),
			});
		} catch { return { ok: false as const, code: "host_required" as BoundPreflightErrorCode }; }
		if (!resolved.ok) return { ok: false as const, code: resolved.code as BoundPreflightErrorCode };
		if (preparation && (resolved.activeSessionDigest !== preparation.activeSessionDigest || resolved.canonicalCwd !== preparation.snapshot.canonicalCwd
			|| !isBoundMcpConfigContractV2(resolved.contract.mcpConfig) || !packageEvidenceAgrees(resolved, preparation.contract))) {
			return { ok: false as const, code: "mcp_snapshot_drift" as BoundPreflightErrorCode };
		}
		return { ok: true as const, resolved, identity, preparation };
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


	async function prepare(params: unknown): Promise<BoundMcpPrepareResult> {
		const refuse = (code: BoundPreflightErrorCode): BoundMcpPrepareResult => ({ ok: false, error: { version: BOUND_PREFLIGHT_VERSION, code } });
		const envelope = parseBoundMcpPreparationParams(params);
		if (!envelope) return refuse("invalid_request");
		const parsed = parseBoundRequest(envelope.request, { mcpConfigMode: "prepare" });
		if (!parsed.ok || parsed.request.targetServerInstanceId !== envelope.targetServerInstanceId || !isBoundMcpConfigV2(parsed.request.mcpConfig)) return refuse("invalid_request");
		const request = parsed.request;
		const mcpRequest = request.mcpConfig as { path: string };
		const requestBaseDigest = boundRequestBaseDigest(request);
		if (!requestBaseDigest) return refuse("invalid_request");
		// Every check that needs no connection comes first (D2).
		const inputs = await resolutionInput(request);
		if (!inputs.ok) return refuse(inputs.code);
		let planned;
		try { planned = resolveBoundMcpPreparationPlan(inputs.input); } catch { return refuse("host_required"); }
		if (!planned.ok) return refuse(planned.code);
		const plan = planned.plan;
		const adapters = plan.packageExtensions.projection.filter((entry) => entry.ref === BOUND_MCP_CONFIG_EXTENSION);
		const attestations = plan.packageExtensions.attestations.filter((entry) => entry.ref === BOUND_MCP_CONFIG_EXTENSION);
		if (adapters.length !== 1 || attestations.length !== 1) return refuse("mcp_adapter_unverified");
		const measurement = measureBoundMcpAdapter(adapters[0]!, attestations[0]!);
		const bridge = bridgeEvidence(readManifest());
		if (!measurement || !bridge) return refuse("mcp_adapter_unverified");
		const measured = measureBoundMcpConfig(mcpRequest.path);
		if (!measured || !validBoundMcpBridgeConfig(measured.config)) return refuse("mcp_config_invalid");
		const selectors = explicitBoundMcpSelectors(plan.selectors, measured.config);
		if (!selectors) return refuse("mcp_selector_invalid");
		if (!boundMcpDefinitionsAgree(selectors, plan.requestCwd, measured.config)) return refuse("mcp_config_mismatch");
		if (!preparations.reserve()) return refuse("mcp_discovery_capacity");
		let reserved = true;
		const unreserve = () => { if (reserved) { reserved = false; preparations.unreserve(); } };
		try {
			const abi = await loadBoundMcpAdapterAbi(attestations[0]!, measurement);
			if (!abi) return refuse("mcp_adapter_unverified");
			if (disposed) return refuse("unverified_source");
			const discovered = await discoverBoundMcp({
				abi, config: measured.config, cwd: plan.requestCwd, selectors, signal: generation.signal,
				...(options.mcpDiscoveryBudget ? { budget: options.mcpDiscoveryBudget } : {}),
			});
			if (!discovered.ok) return refuse(discovered.code);
			const discovery = discovered.discovery;
			if (disposed) { await discovery.close(); return refuse("unverified_source"); }
			const packageEvidenceDigest = boundMcpPackageEvidenceDigest({ adapter: adapters[0]!, entryDigests: measurement.entryDigests, bridge });
			const sourcePathDigest = canonicalSha256(mcpRequest.path);
			const snapshot: BoundMcpSnapshotV1 = {
				requestBaseDigest,
				requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId,
				prospectiveRunId: request.prospectiveRunId,
				serverInstanceId: options.serverInstanceId,
				sourceIdentityDigest: inputs.identity.sourceIdentity.digest,
				activeSessionDigest: plan.activeSessionDigest,
				canonicalCwd: plan.requestCwd,
				sourcePathDigest, contentDigest: measured.contentDigest, effectiveDigest: measured.effectiveDigest,
				packageEvidenceDigest,
				selectors: [...selectors],
				declarations: discovery.declarations.map((declaration) => structuredClone(declaration)),
			};
			const snapshotDigest = boundMcpSnapshotDigest(snapshot);
			const contract: BoundMcpConfigContractV2 = {
				version: BOUND_MCP_CONFIG_V2_VERSION,
				extension: BOUND_MCP_CONFIG_EXTENSION,
				sourcePathDigest, contentDigest: measured.contentDigest, effectiveDigest: measured.effectiveDigest,
				servers: measured.servers,
				implementation: BOUND_MCP_BRIDGE_IMPLEMENTATION,
				snapshotDigest,
				packageEvidenceDigest,
				entryDigests: { ...measurement.entryDigests },
				bridge: { ...bridge },
			};
			const ticket = preparations.newTicket();
			const expiresAtMono = preparations.now() + preparations.ttl();
			const expiresAt = Date.now() + preparations.ttl();
			const deepFreeze = <T>(value: T): T => {
				if (value && typeof value === "object" && !Object.isFrozen(value)) {
					for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
					Object.freeze(value);
				}
				return value;
			};
			const preparation: BoundMcpPreparation = Object.freeze({
				ticket,
				requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId,
				prospectiveRunId: request.prospectiveRunId,
				serverInstanceId: options.serverInstanceId,
				sourceIdentityDigest: inputs.identity.sourceIdentity.digest,
				activeSessionDigest: plan.activeSessionDigest,
				configPath: mcpRequest.path,
				config: deepFreeze(structuredClone(measured.config)),
				snapshot: deepFreeze(structuredClone(snapshot)),
				snapshotDigest,
				contract: deepFreeze(structuredClone(contract)),
				discovery,
				selections: issueBoundMcpSelections({ selectors, cwd: plan.requestCwd, selections: discovery.selections }),
				expiresAt,
				close: () => discovery.close(),
			});
			unreserve();
			if (!preparations.add(preparation, expiresAtMono)) { await discovery.close(); return refuse("unverified_source"); }
			return { ok: true, data: { version: BOUND_MCP_PREPARATION_VERSION, ticket, snapshot, snapshotDigest, expiresAt } };
		} finally { unreserve(); }
	}

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
			const { resolved, preparation } = outcome;
			// The whole resolution is repeated: a definition, skill, or binding that
			// changed since preflight produces a different contract digest here.
			if (resolved.requestDigest !== binding.requestDigest
				|| resolved.launchContractDigest !== binding.expectedLaunchContractDigest) return { ok: false, code: "invalid_request" };
			let mcp: BoundLaunchMcp | undefined;
			if (preparation) {
				const ticket = preparation.ticket;
				let closing: Promise<"closed" | "timeout" | "failed"> | undefined;
				mcp = {
					preparation,
					selections: preparation.selections,
					// The run's admitted marker (and its capacity slot) goes only once the
					// connections are closed; an unfinished close may be retried.
					close: () => closing ??= preparation.close().then((outcome) => {
						if (outcome === "closed") preparations.forget(ticket);
						else closing = undefined;
						return outcome;
					}, () => { closing = undefined; return "failed" as const; }),
				};
			}
			return {
				ok: true,
				launch: {
					request: parsed.request, contract: resolved.contract, agent: resolved.agent, packageExtensionPaths: resolved.packageExtensionPaths,
					packageAttestations: resolved.packageAttestations, ...(mcp ? { mcp } : {}),
				},
			};
		},
		claimMcp(launch) {
			if (!launch.mcp) return true;
			if (disposed) return false;
			return preparations.claim(launch.mcp.preparation.ticket, launch.mcp.preparation);
		},
		async prepareMcp(params) {
			if (boundMcpParamsTarget(params) !== options.serverInstanceId) return undefined;
			// Every failure is one bounded reply, never a rejection the bus would swallow into silence.
			try { return await prepare(params); }
			catch { return { ok: false, error: { version: BOUND_PREFLIGHT_VERSION, code: "host_required" } }; }
		},
		async releaseMcp(params) {
			if (boundMcpParamsTarget(params) !== options.serverInstanceId) return undefined;
			const refuse = (code: BoundPreflightErrorCode): BoundMcpReleaseResult => ({ ok: false, error: { version: BOUND_PREFLIGHT_VERSION, code } });
			const parsed = parseBoundMcpReleaseParams(params);
			if (!parsed) return refuse("invalid_request");
			let released: Awaited<ReturnType<BoundMcpPreparationRegistry["release"]>>;
			try { released = await preparations.release(parsed); }
			catch { return refuse("mcp_release_failed"); }
			return released.ok
				? { ok: true, data: { version: BOUND_MCP_PREPARATION_VERSION, status: released.status } }
				: refuse(released.code);
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
			generation.abort();
			preparations.dispose();
		},
	};
}
