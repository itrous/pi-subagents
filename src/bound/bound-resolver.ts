import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "../agents/agents.ts";
import { capabilityCeilingAgentRestrictionMessage, type ResolvedSubagentCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";
import { resolvePiLaunchToolPlan } from "../runs/shared/child-tool-plan.ts";
import { ACTIVE_BOUND_INTERNAL_RESERVED_TOOLS, CORE_RUNTIME_OWNED_TOOLS, isActiveBoundPackageToolName } from "../runs/shared/core-runtime-tools.ts";
import { checkModelScope } from "../runs/shared/model-scope.ts";
import { resolvePermissionRules } from "../runs/shared/permissions.ts";
import { validateToolBudgetConfig } from "../runs/shared/tool-budget.ts";
import { canonicalSha256 } from "../shared/canonical-json.ts";
import { AGENT_DEFINITION_PROJECTION_VERSION } from "../shared/launch-contract.ts";
import { getSupportedThinkingLevels, type ModelInfo } from "../shared/model-info.ts";
import { resolveRequiredChildExtensions } from "../shared/required-child-extensions.ts";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
import { resolveChildMaxSubagentDepth, type ExtensionConfig } from "../shared/types.ts";
import { resolveBoundAgent, type BoundAgentDiscoveryDeps, type BoundSkillEvidenceV1 } from "./bound-agent-discovery.ts";
import { projectBoundBindings, type BoundBindingsProjectionV1 } from "./bound-bindings.ts";
import { resolveBoundPackageExtensions, type BoundPackageEvidenceCache, type BoundPackageExtensionProjectionV1, type BoundResolvedPackageExtensions } from "./bound-package-extensions.ts";
import { isBoundMcpConfigFinal, resolveBoundMcpConfig, type BoundMcpConfigContract, type BoundMcpConfigContractV2 } from "./bound-mcp-config.ts";
import type { BoundMcpSelectionsHandle } from "./bound-mcp-selections.ts";
import { boundRequestDigest, type BoundRequestV2, type BoundSafetyV1 } from "./bound-request.ts";
import { resolveBoundToolShadowing, type BoundToolShadowingContractV1 } from "./bound-tool-shadowing.ts";
import { expectedToolRegistryProjection, SUPPORTED_BOUND_MODEL_APIS, type RuntimeBuiltinProjectionV1, type ToolRegistryProjectionV1 } from "./bound-tool-registry-projection.ts";
import type { BoundLayerManifestV2 } from "./bound-layer-manifest.ts";
import type { PiRuntimeAttestationV1 } from "./pi-runtime-attestation.ts";

export const BOUND_LAUNCH_CONTRACT_VERSION = 2 as const;

/**
 * `cancellationPolicy` of the repair contract (D3/D4): the port's hard timer,
 * the bound child's shutdown wait and the delivery grace the consumer adds.
 * Fixed values; the consumer checks them exactly.
 */
export const BOUND_CANCELLATION_POLICY = Object.freeze({ version: 1 as const, hardTimerMs: 3_000, shutdownTimeoutMs: 2_000, deliveryGraceMs: 1_000 });
export type BoundCancellationPolicyV1 = { version: 1; hardTimerMs: number; shutdownTimeoutMs: number; deliveryGraceMs: number };

interface SessionManagerLike {
	getSessionFile(): string | null | undefined;
	getSessionId(): string | null | undefined;
}

export interface BoundLaunchContractV2 {
	version: typeof BOUND_LAUNCH_CONTRACT_VERSION;
	prospectiveRunId: string;
	requestDigest: string;
	serverInstanceId: string;
	sourceIdentityDigest: string;
	activeSessionDigest: string;
	canonicalCwd: string;
	agent: { name: string; source: string; definitionProjectionVersion: number; definitionDigest: string; fileContentDigest: string };
	model: string;
	modelRegistryDigest: string;
	modelCandidates: [string];
	thinking: string;
	context: "fresh";
	taskDigest: string;
	skills: BoundSkillEvidenceV1[];
	bindings: BoundBindingsProjectionV1;
	packageExtensions: BoundPackageExtensionProjectionV1[];
	packageExtensionsDigest: string;
	tools: { effectiveAllowlist: string[]; requiredChildTools: string[]; disableAmbientExtensions: boolean; capabilityCeiling?: ResolvedSubagentCapabilityCeiling };
	mcpDirectTools: string[];
	/** Present only when the request asked for an attested MCP configuration (A1R.6 v1, or the S3 P2 v2 snapshot). */
	mcpConfig?: BoundMcpConfigContract;
	/** S3 P2 repair contract only: the request's `safety`, repeated. */
	safety?: BoundSafetyV1;
	/** S3 P2 repair contract only: the cancellation budgets (D3). */
	cancellationPolicy?: BoundCancellationPolicyV1;
	toolRegistry: {
		modelApi: string;
		piRuntime: PiRuntimeAttestationV1;
		piRuntimeVersion: string;
		projection: ToolRegistryProjectionV1;
		runtimeExtensions: BoundLayerManifestV2;
		runtimeBuiltins: RuntimeBuiltinProjectionV1;
		/** Present only when the request asked for attested shadowing (subplan A1R.6, sub-stage 3). */
		shadowing?: BoundToolShadowingContractV1;
		digest: string;
	};
	roots: { baseRootPathDigest: string; baseRootIdentityDigest?: string; baseRootParentIdentityDigest?: string; sessionRootDigest: string; sessionDirDigest: string; sessionFileDigest: string; artifactRootDigest?: string };
	policy: {
		foregroundOnly: true; async: false; clarify: false; share: false; acceptance: false; mission: false;
		output: false; outputMode: "inline"; artifacts: boolean; watchdog: false; control: false; intercom: false;
		usageBudget: false; waitToolEnabled: boolean; parentDepth: number; maxSubagentDepth: number;
		permissionsDigest?: string; modelScopeDigest: string;
	};
	result: BoundRequestV2["result"];
	timeoutMs?: number;
	toolBudget?: BoundRequestV2["toolBudget"];
	launchInputsDigest: string;
	digest: string;
}

export type BoundResolutionErrorCode =
	| "invalid_cwd" | "host_required" | "unverified_source" | "missing_agent" | "ambiguous_agent"
	| "missing_skill" | "unsupported_mode" | "unavailable_model" | "restricted_agent";

/**
 * What `prepareMcp` needs from the resolution before it may connect anything
 * (D2): every check up to the tool plan passed; nothing was created.
 */
export interface BoundMcpPreparationPlan {
	agent: AgentConfig;
	requestCwd: string;
	activeSessionDigest: string;
	selectors: string[];
	packageExtensions: BoundResolvedPackageExtensions;
}

export type ResolveBoundLaunchContractResult =
	| { ok: true; contract: BoundLaunchContractV2; requestDigest: string; launchContractDigest: string; activeSessionDigest: string; canonicalCwd: string; agent: AgentConfig; packageExtensionPaths: string[]; packageAttestations: BoundResolvedPackageExtensions["attestations"] }
	| { ok: false; code: BoundResolutionErrorCode };

export interface ResolveBoundLaunchContractInput {
	request: BoundRequestV2;
	/** Host session cwd; agent and skill discovery is anchored here, never in the leaf cwd. */
	discoveryCwd: string;
	sessionManager: SessionManagerLike;
	availableModels: readonly ModelInfo[];
	serverInstanceId: string;
	sourceIdentityDigest: string;
	piRuntime: PiRuntimeAttestationV1;
	runtimeBuiltins: RuntimeBuiltinProjectionV1;
	layerManifest: BoundLayerManifestV2;
	defaultSessionDir?: string;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	expandTilde?: (value: string) => string;
	discoveryDeps?: BoundAgentDiscoveryDeps;
	packageEvidenceCache?: BoundPackageEvidenceCache;
	/**
	 * S3 P2: the producer-owned snapshot of a final v2 MCP request, verified by the
	 * preparation service against the ticket. Without it a v2 request refuses.
	 */
	mcpSnapshot?: { selections: BoundMcpSelectionsHandle; contract: BoundMcpConfigContractV2 };
	runtimePolicy: {
		foregroundTimeoutMs: number;
		toolBudget?: ExtensionConfig["toolBudget"];
		permissions?: ExtensionConfig["permissions"];
		waitToolEnabled: boolean;
		maxSubagentDepth?: number;
		currentDepth?: number;
	};
}

function failure(code: BoundResolutionErrorCode): ResolveBoundLaunchContractResult {
	return { ok: false, code };
}
function optionalDigest(value: unknown): string {
	return canonicalSha256(value === undefined ? null : value);
}
function sessionRootFromFile(sessionFile: string): string {
	return path.join(path.dirname(sessionFile), path.basename(sessionFile, ".jsonl"));
}
function canonicalDirectory(directory: string): string | undefined {
	try {
		const resolved = fs.realpathSync(path.resolve(directory));
		return fs.statSync(resolved).isDirectory() ? resolved : undefined;
	} catch { return undefined; }
}
/** Resolve a future directory through a regular, non-symlink existing prefix. */
function canonicalFutureDirectory(directory: string): string | undefined {
	const absolute = path.resolve(directory);
	const parsed = path.parse(absolute);
	const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
	let current = parsed.root;
	for (let index = 0; index < parts.length; index++) {
		const next = path.join(current, parts[index]!);
		try {
			const stat = fs.lstatSync(next);
			if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
			current = fs.realpathSync(next);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
			return path.join(current, ...parts.slice(index));
		}
	}
	return current;
}
function directoryIdentityDigest(directory: string): string | undefined {
	try {
		const stat = fs.lstatSync(directory);
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("not a regular directory");
		return canonicalSha256({ dev: stat.dev, ino: stat.ino });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
function absentPath(target: string): boolean {
	try { fs.lstatSync(target); return false; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

/**
 * Observational resolver of the v2 launch contract. It reads bytes, resolves the
 * upstream tool plan, and hashes; it never creates a path, a session, or a
 * subscription (invariant I3.4).
 */
export function resolveBoundLaunchContract(input: ResolveBoundLaunchContractInput): ResolveBoundLaunchContractResult {
	return resolveBound(input, false) as ResolveBoundLaunchContractResult;
}

/**
 * `prepareMcp` (D2): the same resolution up to, and excluding, the tool plan;
 * the request is the prepare request (v2 configuration without a ticket).
 */
export function resolveBoundMcpPreparationPlan(input: ResolveBoundLaunchContractInput): { ok: true; plan: BoundMcpPreparationPlan } | { ok: false; code: BoundResolutionErrorCode } {
	return resolveBound(input, true) as { ok: true; plan: BoundMcpPreparationPlan } | { ok: false; code: BoundResolutionErrorCode };
}

function resolveBound(input: ResolveBoundLaunchContractInput, prepareOnly: boolean): ResolveBoundLaunchContractResult | { ok: true; plan: BoundMcpPreparationPlan } {
	const request = input.request;
	if (request.targetServerInstanceId !== input.serverInstanceId || !input.serverInstanceId.trim()
		|| !/^[0-9a-f]{64}$/u.test(input.sourceIdentityDigest)) return failure("unverified_source");
	const discoveryCwd = canonicalDirectory(input.discoveryCwd);
	if (!discoveryCwd) return failure("invalid_cwd");
	const requestedPath = path.isAbsolute(request.cwd) ? request.cwd : path.resolve(discoveryCwd, request.cwd);
	const requestCwd = canonicalDirectory(requestedPath);
	if (!requestCwd) return failure("invalid_cwd");
	const externalCwd = requestCwd !== discoveryCwd;
	// An existing exact-active alias keeps canonical realpath equality. A new
	// external execution root must itself be canonical, never a symlink alias.
	if (externalCwd) { try { if (fs.lstatSync(path.resolve(requestedPath)).isSymbolicLink()) return failure("invalid_cwd"); } catch { return failure("invalid_cwd"); } }
	if (request.context !== "fresh" || (externalCwd && request.artifacts !== false)) return failure("unsupported_mode");

	let parentSessionFile: string | null | undefined;
	let piSessionId: string | null | undefined;
	let currentSessionId: string;
	try {
		parentSessionFile = input.sessionManager.getSessionFile();
		piSessionId = input.sessionManager.getSessionId();
		currentSessionId = resolveCurrentSessionId({ getSessionFile: () => parentSessionFile, getSessionId: () => piSessionId });
	} catch { return failure("host_required"); }
	if (!currentSessionId.trim() || !piSessionId?.trim()) return failure("host_required");
	// A host that requires extensions in every child (registerRequiredChildExtensions)
	// would have them appended to the leaf's launch, which the contract cannot
	// describe: refuse here instead of at execution.
	if (resolveRequiredChildExtensions(piSessionId).length > 0) return failure("unsupported_mode");

	const rawBaseRoot = input.defaultSessionDir
		? path.resolve((input.expandTilde ?? ((value: string) => value))(input.defaultSessionDir))
		: parentSessionFile ? sessionRootFromFile(path.resolve(parentSessionFile)) : undefined;
	const baseRoot = rawBaseRoot ? canonicalFutureDirectory(rawBaseRoot) : undefined;
	if (!baseRoot) return failure("host_required");
	let baseRootIdentityDigest: string | undefined;
	let baseRootParentIdentityDigest: string | undefined;
	try { baseRootIdentityDigest = directoryIdentityDigest(baseRoot); }
	catch { return failure("host_required"); }
	if (baseRootIdentityDigest === undefined) {
		const baseParent = canonicalDirectory(path.dirname(baseRoot));
		if (!baseParent || path.join(baseParent, path.basename(baseRoot)) !== baseRoot) return failure("host_required");
		try { baseRootParentIdentityDigest = directoryIdentityDigest(baseParent); }
		catch { return failure("host_required"); }
		if (!baseRootParentIdentityDigest) return failure("host_required");
	}
	const sessionRoot = canonicalFutureDirectory(path.join(baseRoot, request.prospectiveRunId));
	if (!sessionRoot || sessionRoot !== path.join(baseRoot, request.prospectiveRunId) || !absentPath(sessionRoot)) return failure("host_required");
	const sessionDir = canonicalFutureDirectory(path.join(sessionRoot, "run-0"));
	const sessionFile = sessionDir ? canonicalFutureDirectory(path.join(sessionDir, "session.jsonl")) : undefined;
	if (!sessionDir || !sessionFile || sessionDir !== path.join(sessionRoot, "run-0") || sessionFile !== path.join(sessionDir, "session.jsonl")
		|| !absentPath(sessionDir) || !absentPath(sessionFile)) return failure("host_required");
	const artifactRoot = request.artifacts ? canonicalFutureDirectory(path.join(sessionRoot, "artifacts")) : undefined;
	if (request.artifacts && (!artifactRoot || artifactRoot !== path.join(sessionRoot, "artifacts") || !absentPath(artifactRoot))) return failure("host_required");

	const resolvedAgent = resolveBoundAgent({ agent: request.agent, ...(request.skill !== undefined ? { skill: request.skill } : {}), activeCwd: discoveryCwd, ...(input.discoveryDeps ? { deps: input.discoveryDeps } : {}) });
	if (!resolvedAgent.ok) return failure(externalCwd && (resolvedAgent.code === "missing_agent" || resolvedAgent.code === "ambiguous_agent") ? "invalid_cwd" : resolvedAgent.code);
	const { agent, definitionDigest, fileContentDigest, skillNames, skills, discovered } = resolvedAgent.resolution;
	if (externalCwd && agent.source !== "package") return failure("invalid_cwd");
	// D10: without an attested MCP configuration the adapter's early config
	// follows `process.cwd()`, so an external cwd cannot carry MCP tools.
	if (externalCwd && Boolean(agent.mcpDirectTools?.length) && !request.mcpConfig) return failure("unsupported_mode");
	if (capabilityCeilingAgentRestrictionMessage(agent.name, input.capabilityCeiling)) return failure("restricted_agent");

	const exactModel = input.availableModels.find((entry) => `${entry.provider}/${entry.id}` === request.model && (entry.fullId === undefined || entry.fullId === request.model));
	if (!exactModel || checkModelScope(request.model, discovered.modelScope, "explicit")
		|| !getSupportedThinkingLevels({ ...exactModel, fullId: request.model }).includes(request.thinking)) return failure("unavailable_model");
	if (!exactModel.api || !SUPPORTED_BOUND_MODEL_APIS.has(exactModel.api)) return failure("unsupported_mode");
	const modelRegistryDigest = canonicalSha256({
		provider: exactModel.provider, id: exactModel.id,
		...(exactModel.fullId !== undefined ? { fullId: exactModel.fullId } : {}),
		...(exactModel.api !== undefined ? { api: exactModel.api } : {}),
		...(exactModel.reasoning !== undefined ? { reasoning: exactModel.reasoning } : {}),
		...(exactModel.thinkingLevelMap !== undefined ? { thinkingLevelMap: exactModel.thinkingLevelMap } : {}),
	});

	let packageExtensions;
	try { packageExtensions = resolveBoundPackageExtensions(agent, input.packageEvidenceCache); }
	catch { return failure("unsupported_mode"); }
	if (packageExtensions.paths.length > 0 && input.capabilityCeiling?.denyExtensions) return failure("restricted_agent");

	const explicitAgentTools = agent.tools ?? [];
	if (new Set(explicitAgentTools).size !== explicitAgentTools.length) return failure("unsupported_mode");
	const runtimeBuiltinNames = new Set(input.runtimeBuiltins.names);
	// Names the runtime owns are never package-provided, whether or not this host
	// advertises them: the fork's own core list joins the host builtins.
	const reservedTools = new Set<string>([...runtimeBuiltinNames, ...CORE_RUNTIME_OWNED_TOOLS, ...ACTIVE_BOUND_INTERNAL_RESERVED_TOOLS]);
	const packageProvidedTools = explicitAgentTools.filter((tool) => !runtimeBuiltinNames.has(tool) && !CORE_RUNTIME_OWNED_TOOLS.has(tool));
	if (packageProvidedTools.some((tool) => !isActiveBoundPackageToolName(tool) || reservedTools.has(tool) || tool === "subagent" || tool.startsWith("mcp:"))
		|| (packageProvidedTools.length > 0 && (agent.source !== "package" || packageExtensions.paths.length === 0
			|| packageExtensions.paths.length !== packageExtensions.projection.length))) return failure("unsupported_mode");

	// S3 P2 (D1): the repair contract carries MCP tools only through the v2
	// snapshot; a v1 configuration or none is not the cold-safe contract.
	const mcpSelectors = agent.mcpDirectTools ?? [];
	if (prepareOnly) {
		if (!request.safety || mcpSelectors.length === 0 || !request.mcpConfig || request.mcpConfig.version !== 2) return failure("unsupported_mode");
		return {
			ok: true,
			plan: {
				agent, requestCwd,
				activeSessionDigest: canonicalSha256({ currentSessionId, piSessionId }),
				selectors: [...mcpSelectors],
				packageExtensions,
			},
		};
	}
	if (request.safety && mcpSelectors.length > 0 && !isBoundMcpConfigFinal(request.mcpConfig)) return failure("unsupported_mode");
	if (isBoundMcpConfigFinal(request.mcpConfig) && (!input.mcpSnapshot || mcpSelectors.length === 0)) return failure("unsupported_mode");
	const snapshot = isBoundMcpConfigFinal(request.mcpConfig) ? input.mcpSnapshot : undefined;

	const boundTools = skills.length > 0 && !explicitAgentTools.includes("read") ? ["read", ...explicitAgentTools] : explicitAgentTools;
	let toolPlan;
	try {
		toolPlan = resolvePiLaunchToolPlan({
			tools: boundTools,
			extensions: [],
			subagentOnlyExtensions: packageExtensions.paths,
			...(agent.mcpDirectTools ? { mcpDirectTools: agent.mcpDirectTools } : {}),
			// B1: the executor names MCP selectors from discovery in the leaf cwd, so
			// with an attested configuration the contract names come from there too.
			cwd: request.mcpConfig ? requestCwd : discoveryCwd,
			requireReadTool: skills.length > 0,
			structuredOutput: request.result.kind === "structured",
			...(input.capabilityCeiling ? { capabilityCeiling: input.capabilityCeiling } : {}),
			agentName: agent.name,
			...(snapshot ? { boundMcpSelections: snapshot.selections } : {}),
		});
	} catch { return failure("restricted_agent"); }
	if (packageProvidedTools.some((tool) => !toolPlan.effectiveToolAllowlist.includes(tool) || !toolPlan.requiredChildTools.includes(tool))) return failure("restricted_agent");
	if (!toolPlan.explicitToolAllowlist || !toolPlan.disableAmbientExtensions || toolPlan.fanoutAuthorized
		|| (skills.length > 0 && !toolPlan.effectiveToolAllowlist.includes("read"))) return failure("unsupported_mode");

	const timeoutMs = request.timeoutMs ?? agent.defaultTimeoutMs ?? input.runtimePolicy.foregroundTimeoutMs;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) return failure("unsupported_mode");
	const resolvedToolBudget = validateToolBudgetConfig(request.toolBudget ?? agent.toolBudget ?? input.runtimePolicy.toolBudget, "bound toolBudget", request.toolBudget ? { minimumHard: 0 } : undefined);
	if (resolvedToolBudget.error) return failure("unsupported_mode");
	const toolBudget = resolvedToolBudget.budget;
	const effectivePermissions = resolvePermissionRules(input.runtimePolicy.permissions, agent.permissions);
	if (effectivePermissions && Object.values(effectivePermissions).includes("ask")) return failure("restricted_agent");
	if ((skills.length > 0 && (effectivePermissions?.read === "deny" || effectivePermissions?.read === "ask"
		|| (toolBudget?.hard === 0 && (toolBudget.block === "*" || toolBudget.block.includes("read")))))
		|| (request.result.kind === "structured" && toolBudget?.hard === 0
			&& (toolBudget.block === "*" || toolBudget.block.includes("structured_output")))) return failure("restricted_agent");

	const runtimeMaxSubagentDepth = input.runtimePolicy.maxSubagentDepth ?? 1;
	const parentDepth = input.runtimePolicy.currentDepth ?? 0;
	if (!Number.isInteger(parentDepth) || parentDepth !== 0 || parentDepth >= runtimeMaxSubagentDepth) return failure("restricted_agent");
	const effectiveMaxSubagentDepth = resolveChildMaxSubagentDepth(runtimeMaxSubagentDepth, agent.maxSubagentDepth);

	const shadowing = request.toolShadowing
		? resolveBoundToolShadowing(request.toolShadowing, { packageExtensions: packageExtensions.projection, runtimeBuiltins: input.runtimeBuiltins.names, effectiveAllowlist: toolPlan.effectiveToolAllowlist })
		: undefined;
	if (request.toolShadowing && (!shadowing || agent.source !== "package")) return failure("unsupported_mode");
	const mcpConfig: BoundMcpConfigContract | undefined = snapshot
		? snapshot.contract
		: request.mcpConfig && request.mcpConfig.version === 1
			? resolveBoundMcpConfig(request.mcpConfig, {
				packageExtensions: packageExtensions.projection, mcpDirectTools: toolPlan.effectiveMcpTools,
				selectors: agent.mcpDirectTools ?? [], cwd: requestCwd,
			})
			: undefined;
	if (request.mcpConfig && !mcpConfig) return failure("unsupported_mode");
	const safety = request.safety ? { version: request.safety.version, cancellationProof: request.safety.cancellationProof } : undefined;
	const cancellationPolicy = safety ? { ...BOUND_CANCELLATION_POLICY } : undefined;

	const toolRegistryProjection = expectedToolRegistryProjection(toolPlan.effectiveToolAllowlist, toolPlan.internalTools);
	if (!toolRegistryProjection) return failure("unsupported_mode");
	const piRuntimeVersion = input.piRuntime.version;
	if (!piRuntimeVersion || Buffer.byteLength(piRuntimeVersion, "utf8") > 128 || /[\0\r\n]/u.test(piRuntimeVersion)) return failure("unsupported_mode");
	// `piRuntimeVersion` deliberately duplicates `piRuntime.version`: the v2 client
	// keeps the exact v1 version check and reads the new sub-object beside it.
	// A request without the new fields keeps the contract bytes it had before them.
	const toolRegistry = {
		modelApi: exactModel.api,
		piRuntime: input.piRuntime,
		piRuntimeVersion,
		projection: toolRegistryProjection,
		runtimeExtensions: input.layerManifest,
		runtimeBuiltins: input.runtimeBuiltins,
		...(shadowing ? { shadowing } : {}),
		digest: canonicalSha256({
			modelApi: exactModel.api, piRuntime: input.piRuntime, piRuntimeVersion,
			projection: toolRegistryProjection, runtimeExtensions: input.layerManifest, runtimeBuiltins: input.runtimeBuiltins,
			...(shadowing ? { shadowing } : {}),
		}),
	};

	const materializedModel = `${request.model}:${request.thinking}`;
	const bindings = projectBoundBindings(request.bindings);
	const activeSessionDigest = canonicalSha256({ currentSessionId, piSessionId });
	const requestDigest = boundRequestDigest(request);
	const roots = {
		baseRootPathDigest: canonicalSha256(baseRoot),
		...(baseRootIdentityDigest ? { baseRootIdentityDigest } : {}),
		...(baseRootParentIdentityDigest ? { baseRootParentIdentityDigest } : {}),
		sessionRootDigest: canonicalSha256(sessionRoot),
		...(artifactRoot ? { artifactRootDigest: canonicalSha256(artifactRoot) } : {}),
		sessionDirDigest: canonicalSha256(sessionDir),
		sessionFileDigest: canonicalSha256(sessionFile),
	};
	const policy = {
		foregroundOnly: true as const, async: false as const, clarify: false as const, share: false as const,
		acceptance: false as const, mission: false as const, output: false as const, outputMode: "inline" as const,
		artifacts: request.artifacts, watchdog: false as const, control: false as const, intercom: false as const,
		usageBudget: false as const, waitToolEnabled: input.runtimePolicy.waitToolEnabled,
		parentDepth, maxSubagentDepth: effectiveMaxSubagentDepth,
		...(effectivePermissions !== undefined ? { permissionsDigest: canonicalSha256(effectivePermissions) } : {}),
		modelScopeDigest: optionalDigest(discovered.modelScope),
	};
	const tools = {
		effectiveAllowlist: toolPlan.effectiveToolAllowlist,
		requiredChildTools: toolPlan.requiredChildTools,
		disableAmbientExtensions: toolPlan.disableAmbientExtensions,
		...(input.capabilityCeiling ? { capabilityCeiling: input.capabilityCeiling } : {}),
	};
	const result: BoundRequestV2["result"] = request.result.kind === "text"
		? { kind: "text" }
		: { kind: "structured", schema: structuredClone(request.result.schema) };
	// What the A1R.4 executor re-checks before it creates the session.
	const launchInputsDigest = canonicalSha256({
		version: BOUND_LAUNCH_CONTRACT_VERSION,
		definitionDigest, fileContentDigest, canonicalCwd: requestCwd,
		taskDigest: canonicalSha256(request.task),
		model: materializedModel, modelCandidates: [materializedModel], thinking: request.thinking,
		systemPromptDigest: canonicalSha256(agent.systemPrompt?.trim() ?? ""),
		systemPromptMode: agent.systemPromptMode,
		skills: skillNames, skillEvidence: skills,
		bindings, packageExtensions: packageExtensions.projection,
		tools: toolPlan.effectiveToolAllowlist, extensions: toolPlan.extensionArgs,
		subagentOnlyExtensions: packageExtensions.paths, mcpDirectTools: toolPlan.effectiveMcpTools,
		roots, policy, result,
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
		...(toolBudget ? { toolBudget } : {}),
		...(shadowing ? { toolShadowing: shadowing } : {}),
		...(mcpConfig ? { mcpConfig } : {}),
		...(safety ? { safety, cancellationPolicy } : {}),
	});
	const base: Omit<BoundLaunchContractV2, "digest"> = {
		version: BOUND_LAUNCH_CONTRACT_VERSION,
		prospectiveRunId: request.prospectiveRunId,
		requestDigest,
		serverInstanceId: input.serverInstanceId,
		sourceIdentityDigest: input.sourceIdentityDigest,
		activeSessionDigest,
		canonicalCwd: requestCwd,
		agent: { name: agent.name, source: agent.source, definitionProjectionVersion: AGENT_DEFINITION_PROJECTION_VERSION, definitionDigest, fileContentDigest },
		model: request.model,
		modelRegistryDigest,
		modelCandidates: [materializedModel],
		thinking: request.thinking,
		context: "fresh",
		taskDigest: canonicalSha256(request.task),
		skills,
		bindings,
		packageExtensions: packageExtensions.projection,
		packageExtensionsDigest: canonicalSha256(packageExtensions.projection),
		tools,
		mcpDirectTools: toolPlan.effectiveMcpTools,
		...(mcpConfig ? { mcpConfig } : {}),
		...(safety ? { safety, cancellationPolicy } : {}),
		toolRegistry,
		roots,
		policy,
		result,
		timeoutMs,
		...(toolBudget ? { toolBudget } : {}),
		launchInputsDigest,
	};
	const digest = canonicalSha256(base);
	return {
		ok: true,
		contract: { ...base, digest },
		requestDigest,
		launchContractDigest: digest,
		activeSessionDigest,
		canonicalCwd: requestCwd,
		agent,
		packageExtensionPaths: packageExtensions.paths,
		packageAttestations: packageExtensions.attestations,
	};
}
