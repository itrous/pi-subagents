import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAgents, discoverProjectAgentsRestricted, resolveAgentName, type AgentConfig } from "../agents/agents.ts";
import { buildBoundSkillInjection, normalizeSkillInput, resolveProjectSkillsUncached } from "../agents/skills.ts";
import { getAgentRefinementPath } from "../agents/agent-refinements.ts";
import { applyThinkingSuffix, resolvePiLaunchToolPlan } from "../runs/shared/pi-args.ts";
import { appendTurnBudgetSystemPrompt, resolveTurnBudgetConfig } from "../runs/shared/turn-budget.ts";
import { validateToolBudgetConfig } from "../runs/shared/tool-budget.ts";
import { capabilityCeilingAgentRestrictionMessage, intersectSubagentCapabilityCeilings, type ResolvedSubagentCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";
import type { AvailableModelInfo } from "../runs/shared/model-fallback.ts";
import { checkModelScope } from "../runs/shared/model-scope.ts";
import { getSupportedThinkingLevels } from "../shared/model-info.ts";
import { canonicalSha256 } from "../shared/canonical-json.ts";
import { AGENT_DEFINITION_PROJECTION_VERSION, agentDefinitionDigest, launchBindingDigest } from "../shared/launch-contract.ts";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
import { resolveChildMaxSubagentDepth, type ExtensionConfig } from "../shared/types.ts";
import { resolvePermissionRules } from "../runs/shared/permissions.ts";
import type { ActiveBoundPreflightRequestV1 } from "./active-bound-preflight.ts";
import type { ActiveBoundRootIdentityV1 } from "./active-bound-runtime.ts";
import { activeBoundPreflightRequestDigest } from "./active-bound-preflight.ts";
import { projectActiveBoundEnvironment, type ActiveBoundEnvironmentProjectionV1 } from "./active-bound-environment.ts";

export const ACTIVE_BOUND_LAUNCH_CONTRACT_VERSION = 1 as const;
const FIXED_CHILD_TOOLS = new Set([
	"read", "grep", "find", "ls", "bash", "edit", "write",
	"web_search", "fetch_content", "get_search_content",
]);

interface SessionManager {
	getSessionFile(): string | null | undefined;
	getSessionId(): string | null | undefined;
}

export interface ResolveActiveBoundLaunchContractInput {
	request: ActiveBoundPreflightRequestV1;
	activeCwd: string;
	sessionManager: SessionManager;
	availableModels: ReadonlyArray<AvailableModelInfo>;
	serverInstanceId: string;
	sourceIdentityDigest: string;
	defaultSessionDir?: string;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	expandTilde?: (value: string) => string;
	discover?: typeof discoverAgents;
	/** Private executor barrier permits only the exact directory created by this launch. */
	ownedBaseRootIdentity?: ActiveBoundRootIdentityV1;
	projectOwnedBaseAsFuture?: boolean;
	ownedRootIdentity?: ActiveBoundRootIdentityV1;
	ownedSessionDirIdentity?: ActiveBoundRootIdentityV1;
	runtimePolicy: {
		foregroundTimeoutMs: number;
		turnBudget?: ExtensionConfig["turnBudget"];
		toolBudget?: ExtensionConfig["toolBudget"];
		permissions?: ExtensionConfig["permissions"];
		waitToolEnabled: boolean;
		maxSubagentDepth?: number;
		currentDepth?: number;
	};
}

export interface ActiveBoundLaunchContractV1 {
	version: typeof ACTIVE_BOUND_LAUNCH_CONTRACT_VERSION;
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
	skills: Array<{ name: string; source: string; contentDigest: string }>;
	environment: ActiveBoundEnvironmentProjectionV1;
	tools: { effectiveAllowlist: string[]; requiredChildTools: string[]; disableAmbientExtensions: boolean; capabilityCeiling?: ResolvedSubagentCapabilityCeiling };
	roots: { baseRootPathDigest: string; baseRootIdentityDigest?: string; sessionRootDigest: string; sessionDirDigest: string; sessionFileDigest: string };
	policy: { foregroundOnly: true; async: false; clarify: false; share: false; acceptance: false; mission: false; output: false; outputMode: "inline"; artifacts: false; watchdog: false; control: false; intercom: false; usageBudget: false; waitToolEnabled: boolean; parentDepth: number; maxSubagentDepth?: number; permissionsDigest?: string; modelScopeDigest: string };
	result: ActiveBoundPreflightRequestV1["result"];
	timeoutMs?: number;
	turnBudget?: ActiveBoundPreflightRequestV1["turnBudget"];
	toolBudget?: ActiveBoundPreflightRequestV1["toolBudget"];
	launchInputsDigest: string;
	digest: string;
}

export type ActiveBoundResolutionErrorCode = "invalid_cwd" | "host_required" | "unverified_source" | "missing_agent" | "ambiguous_agent" | "missing_skill" | "unsupported_mode" | "unavailable_model" | "restricted_agent";
export type ResolveActiveBoundLaunchContractResult =
	| { ok: true; contract: ActiveBoundLaunchContractV1; requestDigest: string; launchContractDigest: string; activeSessionDigest: string; canonicalCwd: string }
	| { ok: false; code: ActiveBoundResolutionErrorCode };

function failure(code: ActiveBoundResolutionErrorCode): ResolveActiveBoundLaunchContractResult {
	return { ok: false, code } as ResolveActiveBoundLaunchContractResult;
}
function fileDigest(filePath: string): string {
	return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
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
			const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
			if (code !== "ENOENT") return undefined;
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

function forbiddenAgentMode(agent: AgentConfig): boolean {
	return agent.source !== "project" || agent.runner?.type === "external-cli" || Boolean(agent.fallbackModels?.length)
		|| !Array.isArray(agent.tools) || Boolean(agent.extensions?.length) || Boolean(agent.subagentOnlyExtensions?.length)
		|| Boolean(agent.skillPath?.length) || agent.inheritProjectContext || agent.inheritSkills || Boolean(agent.memory)
		|| Boolean(agent.defaultReads?.length) || agent.defaultAsync === true || agent.defaultAcceptance !== undefined
		|| Boolean(agent.tools.some((tool) => tool === "subagent" || tool.startsWith("mcp:") || tool.includes("/") || /\.(?:ts|js)$/u.test(tool)))
		|| Boolean(agent.mcpDirectTools?.length);
}

/** Synchronous, observational active resolver. It never creates launch paths. */
export function resolveActiveBoundLaunchContract(input: ResolveActiveBoundLaunchContractInput): ResolveActiveBoundLaunchContractResult {
	if (input.request.targetServerInstanceId !== input.serverInstanceId
		|| !input.serverInstanceId.trim() || !/^[0-9a-f]{64}$/u.test(input.sourceIdentityDigest)) return failure("unverified_source");
	const requestCwd = canonicalDirectory(input.request.cwd);
	const activeCwd = canonicalDirectory(input.activeCwd);
	if (!requestCwd || !activeCwd || requestCwd !== activeCwd) return failure("invalid_cwd");
	if (input.request.context !== "fresh" || input.request.artifacts !== false) return failure("unsupported_mode");
	let parentSessionFile: string | null | undefined;
	let piSessionId: string | null | undefined;
	let currentSessionId: string;
	try {
		parentSessionFile = input.sessionManager.getSessionFile();
		piSessionId = input.sessionManager.getSessionId();
		currentSessionId = resolveCurrentSessionId({
			getSessionFile: () => parentSessionFile,
			getSessionId: () => piSessionId,
		});
	} catch { return failure("host_required"); }
	if (!currentSessionId.trim() || !piSessionId?.trim()) return failure("host_required");
	const rawBaseRoot = input.defaultSessionDir
		? path.resolve((input.expandTilde ?? ((value) => value))(input.defaultSessionDir))
		: parentSessionFile ? sessionRootFromFile(path.resolve(parentSessionFile)) : undefined;
	const baseRoot = rawBaseRoot ? canonicalFutureDirectory(rawBaseRoot) : undefined;
	if (!baseRoot) return failure("host_required");
	let baseRootIdentityDigest: string | undefined;
	try {
		baseRootIdentityDigest = directoryIdentityDigest(baseRoot);
		if (input.projectOwnedBaseAsFuture) {
			const stat = fs.lstatSync(baseRoot);
			if (!input.ownedBaseRootIdentity || stat.dev !== input.ownedBaseRootIdentity.dev || stat.ino !== input.ownedBaseRootIdentity.ino) return failure("host_required");
			baseRootIdentityDigest = undefined;
		}
	} catch { return failure("host_required"); }
	const rawSessionRoot = path.join(baseRoot, input.request.prospectiveRunId);
	try {
		const existing = fs.lstatSync(rawSessionRoot);
		if (!input.ownedRootIdentity || existing.isSymbolicLink() || !existing.isDirectory()
			|| existing.dev !== input.ownedRootIdentity.dev || existing.ino !== input.ownedRootIdentity.ino) return failure("host_required");
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code !== "ENOENT" || input.ownedRootIdentity) return failure("host_required");
	}
	const sessionRoot = canonicalFutureDirectory(rawSessionRoot);
	if (!sessionRoot || sessionRoot !== rawSessionRoot) return failure("host_required");
	const sessionDir = canonicalFutureDirectory(path.join(sessionRoot, "run-0"));
	const sessionFile = sessionDir ? canonicalFutureDirectory(path.join(sessionDir, "session.jsonl")) : undefined;
	if (!sessionDir || !sessionFile || sessionDir !== path.join(sessionRoot, "run-0") || sessionFile !== path.join(sessionDir, "session.jsonl")) return failure("host_required");
	try {
		const existing = fs.lstatSync(sessionDir);
		if (!input.ownedSessionDirIdentity || existing.isSymbolicLink() || !existing.isDirectory()
			|| existing.dev !== input.ownedSessionDirIdentity.dev || existing.ino !== input.ownedSessionDirIdentity.ino) return failure("host_required");
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code !== "ENOENT" || input.ownedSessionDirIdentity) return failure("host_required");
	}
	try { fs.lstatSync(sessionFile); return failure("host_required"); }
	catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code !== "ENOENT") return failure("host_required");
	}
	let discovered: ReturnType<typeof discoverAgents>;
	try { discovered = (input.discover ?? discoverProjectAgentsRestricted)(requestCwd, "project"); }
	catch { return failure("unsupported_mode"); }
	const resolved = resolveAgentName(input.request.agent, discovered.agents);
	if (resolved.error) return failure("ambiguous_agent");
	if (!resolved.agent) return failure("missing_agent");
	const agent = resolved.agent;
	let hasRefinement: boolean;
	try { hasRefinement = fs.existsSync(getAgentRefinementPath(requestCwd, agent.name)); }
	catch { return failure("unsupported_mode"); }
	if (forbiddenAgentMode(agent) || hasRefinement) return failure("unsupported_mode");
	if (capabilityCeilingAgentRestrictionMessage(agent.name, input.capabilityCeiling)) return failure("restricted_agent");
	const exactModel = input.availableModels.find((entry) => `${entry.provider}/${entry.id}` === input.request.model && (entry.fullId === undefined || entry.fullId === input.request.model));
	if (!exactModel || checkModelScope(input.request.model, discovered.modelScope, "explicit")
		|| !getSupportedThinkingLevels({ ...exactModel, fullId: input.request.model }).includes(input.request.thinking)) return failure("unavailable_model");
	const modelRegistryDigest = canonicalSha256({
		provider: exactModel.provider, id: exactModel.id,
		...(exactModel.fullId !== undefined ? { fullId: exactModel.fullId } : {}),
		...(exactModel.api !== undefined ? { api: exactModel.api } : {}),
		...(exactModel.baseUrl !== undefined ? { baseUrl: exactModel.baseUrl } : {}),
		...(exactModel.reasoning !== undefined ? { reasoning: exactModel.reasoning } : {}),
		...(exactModel.thinkingLevelMap !== undefined ? { thinkingLevelMap: exactModel.thinkingLevelMap } : {}),
	});
	const explicitSkills = Array.isArray(input.request.skill)
		? input.request.skill.map((name) => name.trim()).filter(Boolean)
		: normalizeSkillInput(input.request.skill);
	const skillNames = explicitSkills === false ? [] : explicitSkills ?? agent.skills ?? [];
	const resolvedSkills = resolveProjectSkillsUncached(skillNames, requestCwd);
	if (resolvedSkills.missing.length > 0) return failure("missing_skill");
	const boundCeiling = intersectSubagentCapabilityCeilings(input.capabilityCeiling, {
		version: 1, denyExtensions: true, sources: ["active-bound-v1"],
	});
	const explicitAgentTools = agent.tools ?? [];
	if (explicitAgentTools.some((tool) => !FIXED_CHILD_TOOLS.has(tool))) return failure("unsupported_mode");
	const boundTools = resolvedSkills.resolved.length > 0 && !explicitAgentTools.includes("read") ? ["read", ...explicitAgentTools] : explicitAgentTools;
	let toolPlan;
	try {
		toolPlan = resolvePiLaunchToolPlan({
			tools: boundTools, cwd: requestCwd, requireReadTool: resolvedSkills.resolved.length > 0,
			structuredOutput: input.request.result.kind === "structured", capabilityCeiling: boundCeiling, agentName: agent.name,
		});
	} catch { return failure("restricted_agent"); }
	if (!toolPlan.explicitToolAllowlist || !toolPlan.disableAmbientExtensions || toolPlan.fanoutAuthorized
		|| (resolvedSkills.resolved.length > 0 && !toolPlan.effectiveToolAllowlist.includes("read"))
		|| toolPlan.extensionArgs.some((entry) => !toolPlan.runtimeExtensions.includes(entry))) return failure("unsupported_mode");
	let skillEvidence: ActiveBoundLaunchContractV1["skills"];
	let agentBytesDigest: string;
	try {
		skillEvidence = resolvedSkills.resolved.map((skill) => ({ name: skill.name, source: skill.source, contentDigest: fileDigest(skill.path) }));
		agentBytesDigest = fileDigest(agent.filePath);
	} catch { return failure("unsupported_mode"); }
	let systemPrompt = agent.systemPrompt?.trim() ?? "";
	if (resolvedSkills.resolved.length > 0) systemPrompt = [systemPrompt, buildBoundSkillInjection(resolvedSkills.resolved)].filter(Boolean).join("\n\n");
	const timeoutMs = input.request.timeoutMs ?? agent.defaultTimeoutMs ?? input.runtimePolicy.foregroundTimeoutMs;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) return failure("unsupported_mode");
	const rawTurnBudget = input.request.turnBudget ?? agent.defaultTurnBudget ?? input.runtimePolicy.turnBudget;
	const resolvedTurnBudget = resolveTurnBudgetConfig(rawTurnBudget);
	if (resolvedTurnBudget.error) return failure("unsupported_mode");
	const turnBudget = resolvedTurnBudget.turnBudget;
	const rawToolBudget = input.request.toolBudget ?? agent.toolBudget ?? input.runtimePolicy.toolBudget;
	const resolvedToolBudget = validateToolBudgetConfig(rawToolBudget, "active bound toolBudget", input.request.toolBudget ? { minimumHard: 0 } : undefined);
	if (resolvedToolBudget.error) return failure("unsupported_mode");
	const toolBudget = resolvedToolBudget.budget;
	const effectivePermissions = resolvePermissionRules(input.runtimePolicy.permissions, agent.permissions);
	if (effectivePermissions && Object.values(effectivePermissions).includes("ask")) return failure("restricted_agent");
	if ((resolvedSkills.resolved.length > 0 && (effectivePermissions?.read === "deny" || effectivePermissions?.read === "ask"
		|| (toolBudget?.hard === 0 && (toolBudget.block === "*" || toolBudget.block.includes("read")))))
		|| (input.request.result.kind === "structured" && toolBudget?.hard === 0
			&& (toolBudget.block === "*" || toolBudget.block.includes("structured_output")))) return failure("restricted_agent");
	systemPrompt = appendTurnBudgetSystemPrompt(systemPrompt, turnBudget);
	const activeSessionDigest = canonicalSha256({ currentSessionId, piSessionId });
	const requestDigest = activeBoundPreflightRequestDigest(input.request);
	const definitionDigest = agentDefinitionDigest(agent);
	const runtimeMaxSubagentDepth = input.runtimePolicy.maxSubagentDepth ?? 1;
	const parentDepth = input.runtimePolicy.currentDepth ?? 0;
	if (!Number.isInteger(parentDepth) || parentDepth !== 0 || parentDepth >= runtimeMaxSubagentDepth) return failure("restricted_agent");
	const effectiveMaxSubagentDepth = resolveChildMaxSubagentDepth(runtimeMaxSubagentDepth, agent.maxSubagentDepth);
	const materializedModel = applyThinkingSuffix(input.request.model, input.request.thinking, true)!;
	const environment = projectActiveBoundEnvironment(input.request.environment);
	const launchBindingInput = {
		definitionDigest, task: input.request.task,
		modelCandidates: [materializedModel], thinking: input.request.thinking, systemPrompt,
		systemPromptMode: agent.systemPromptMode, inheritProjectContext: agent.inheritProjectContext, inheritSkills: agent.inheritSkills,
		skills: skillNames, environment, tools: toolPlan.effectiveToolAllowlist, extensions: toolPlan.extensionArgs, subagentOnlyExtensions: agent.subagentOnlyExtensions ?? [], mcpDirectTools: toolPlan.effectiveMcpTools, permissionRules: effectivePermissions,
		outputMode: "inline" as const, ...(input.request.result.kind === "structured" ? { structuredOutputSchema: input.request.result.schema } : {}),
	};
	const base: Omit<ActiveBoundLaunchContractV1, "digest"> = {
		version: 1, prospectiveRunId: input.request.prospectiveRunId, requestDigest,
		serverInstanceId: input.serverInstanceId, sourceIdentityDigest: input.sourceIdentityDigest, activeSessionDigest, canonicalCwd: requestCwd,
		agent: { name: agent.name, source: agent.source, definitionProjectionVersion: AGENT_DEFINITION_PROJECTION_VERSION, definitionDigest, fileContentDigest: agentBytesDigest },
		model: input.request.model, modelRegistryDigest, modelCandidates: [materializedModel], thinking: input.request.thinking, context: "fresh", taskDigest: canonicalSha256(input.request.task),
		skills: skillEvidence,
		environment,
		tools: { effectiveAllowlist: toolPlan.effectiveToolAllowlist, requiredChildTools: toolPlan.requiredChildTools, disableAmbientExtensions: toolPlan.disableAmbientExtensions, ...(boundCeiling ? { capabilityCeiling: boundCeiling } : {}) },
		roots: {
			baseRootPathDigest: canonicalSha256(baseRoot),
			...(baseRootIdentityDigest ? { baseRootIdentityDigest } : {}),
			sessionRootDigest: canonicalSha256(sessionRoot),
			sessionDirDigest: canonicalSha256(sessionDir),
			sessionFileDigest: canonicalSha256(sessionFile),
		},
		policy: {
			foregroundOnly: true, async: false, clarify: false, share: false, acceptance: false, mission: false,
			output: false, outputMode: "inline", artifacts: false, watchdog: false, control: false, intercom: false, usageBudget: false,
			waitToolEnabled: input.runtimePolicy.waitToolEnabled,
			parentDepth,
			maxSubagentDepth: effectiveMaxSubagentDepth,
			...(effectivePermissions !== undefined ? { permissionsDigest: canonicalSha256(effectivePermissions) } : {}),
			modelScopeDigest: optionalDigest(discovered.modelScope),
		},
		result: input.request.result.kind === "text"
			? { kind: "text" }
			: { kind: "structured", schema: structuredClone(input.request.result.schema) },
		timeoutMs, ...(turnBudget ? { turnBudget } : {}),
		...(toolBudget ? { toolBudget } : {}), launchInputsDigest: launchBindingDigest(launchBindingInput),
	};
	const digest = canonicalSha256(base);
	// Reject a hybrid snapshot if files/settings changed while this observational
	// pass was resolving them. Later C2 barriers repeat the whole resolver.
	try {
		const freshBaseRoot = rawBaseRoot ? canonicalFutureDirectory(rawBaseRoot) : undefined;
		if (freshBaseRoot && !input.projectOwnedBaseAsFuture && directoryIdentityDigest(freshBaseRoot) !== baseRootIdentityDigest) return failure("host_required");
		try {
			const existing = fs.lstatSync(rawSessionRoot);
			if (!input.ownedRootIdentity || existing.isSymbolicLink() || !existing.isDirectory()
				|| existing.dev !== input.ownedRootIdentity.dev || existing.ino !== input.ownedRootIdentity.ino) return failure("host_required");
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || input.ownedRootIdentity) return failure("host_required"); }
		const freshSessionRoot = freshBaseRoot ? canonicalFutureDirectory(path.join(freshBaseRoot, input.request.prospectiveRunId)) : undefined;
		const freshSessionDir = freshSessionRoot ? canonicalFutureDirectory(path.join(freshSessionRoot, "run-0")) : undefined;
		const freshSessionFile = freshSessionDir ? canonicalFutureDirectory(path.join(freshSessionDir, "session.jsonl")) : undefined;
		try {
			const existing = fs.lstatSync(path.join(sessionRoot, "run-0"));
			if (!input.ownedSessionDirIdentity || existing.isSymbolicLink() || !existing.isDirectory()
				|| existing.dev !== input.ownedSessionDirIdentity.dev || existing.ino !== input.ownedSessionDirIdentity.ino) return failure("host_required");
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || input.ownedSessionDirIdentity) return failure("host_required"); }
		if (freshBaseRoot !== baseRoot || freshSessionRoot !== sessionRoot || freshSessionDir !== sessionDir || freshSessionFile !== sessionFile) return failure("host_required");
		const freshDiscovery = (input.discover ?? discoverProjectAgentsRestricted)(requestCwd, "project");
		const freshResolved = resolveAgentName(input.request.agent, freshDiscovery.agents);
		if (freshResolved.error || !freshResolved.agent || freshResolved.agent.name !== agent.name
			|| agentDefinitionDigest(freshResolved.agent) !== definitionDigest
			|| fileDigest(freshResolved.agent.filePath) !== agentBytesDigest
			|| optionalDigest(freshDiscovery.modelScope) !== optionalDigest(discovered.modelScope)
			|| fs.existsSync(getAgentRefinementPath(requestCwd, freshResolved.agent.name))) return failure("unsupported_mode");
		const freshSkills = resolveProjectSkillsUncached(skillNames, requestCwd);
		if (freshSkills.missing.length > 0) return failure("missing_skill");
		const freshSkillEvidence = freshSkills.resolved.map((skill) => ({ name: skill.name, source: skill.source, contentDigest: fileDigest(skill.path) }));
		if (canonicalSha256(freshSkillEvidence) !== canonicalSha256(skillEvidence)) return failure("unsupported_mode");
		let freshSystemPrompt = freshResolved.agent.systemPrompt?.trim() ?? "";
		if (freshSkills.resolved.length > 0) freshSystemPrompt = [freshSystemPrompt, buildBoundSkillInjection(freshSkills.resolved)].filter(Boolean).join("\n\n");
		freshSystemPrompt = appendTurnBudgetSystemPrompt(freshSystemPrompt, turnBudget);
		if (canonicalSha256(freshSystemPrompt) !== canonicalSha256(systemPrompt)) return failure("unsupported_mode");
		const freshPermissions = resolvePermissionRules(input.runtimePolicy.permissions, freshResolved.agent.permissions);
		const freshMaxDepth = resolveChildMaxSubagentDepth(input.runtimePolicy.maxSubagentDepth ?? 1, freshResolved.agent.maxSubagentDepth);
		if (optionalDigest(freshPermissions) !== optionalDigest(effectivePermissions) || freshMaxDepth !== effectiveMaxSubagentDepth) return failure("unsupported_mode");
		if (input.projectOwnedBaseAsFuture) {
			const finalBase = fs.lstatSync(baseRoot);
			if (!input.ownedBaseRootIdentity || finalBase.dev !== input.ownedBaseRootIdentity.dev || finalBase.ino !== input.ownedBaseRootIdentity.ino) return failure("host_required");
		} else if (directoryIdentityDigest(baseRoot) !== baseRootIdentityDigest) return failure("host_required");
		try {
			const finalRoot = fs.lstatSync(rawSessionRoot);
			if (!input.ownedRootIdentity || finalRoot.isSymbolicLink() || !finalRoot.isDirectory()
				|| finalRoot.dev !== input.ownedRootIdentity.dev || finalRoot.ino !== input.ownedRootIdentity.ino) return failure("host_required");
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || input.ownedRootIdentity) return failure("host_required"); }
		try {
			const finalSessionDir = fs.lstatSync(path.join(rawSessionRoot, "run-0"));
			if (!input.ownedSessionDirIdentity || finalSessionDir.isSymbolicLink() || !finalSessionDir.isDirectory()
				|| finalSessionDir.dev !== input.ownedSessionDirIdentity.dev || finalSessionDir.ino !== input.ownedSessionDirIdentity.ino) return failure("host_required");
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || input.ownedSessionDirIdentity) return failure("host_required"); }
		try { fs.lstatSync(path.join(rawSessionRoot, "run-0", "session.jsonl")); return failure("host_required"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return failure("host_required"); }
	} catch { return failure("unsupported_mode"); }
	return { ok: true, contract: { ...base, digest }, requestDigest, launchContractDigest: digest, activeSessionDigest, canonicalCwd: requestCwd };
}
