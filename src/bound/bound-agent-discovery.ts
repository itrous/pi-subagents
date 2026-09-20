import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { clearAgentDiscoveryCache, discoverAgents, resolveAgentName, type AgentConfig, type AgentDiscoveryResult } from "../agents/agents.ts";
import { clearSkillCache, normalizeSkillInput, resolveSkills } from "../agents/skills.ts";
import { getAgentRefinementPath } from "../agents/agent-refinements.ts";
import { agentDefinitionDigest } from "../shared/launch-contract.ts";

export interface BoundSkillEvidenceV1 {
	name: string;
	source: string;
	contentDigest: string;
}

export interface BoundAgentResolution {
	agent: AgentConfig;
	definitionDigest: string;
	fileContentDigest: string;
	skillNames: string[];
	skills: BoundSkillEvidenceV1[];
	discovered: AgentDiscoveryResult;
}

export type BoundAgentResolutionCode = "missing_agent" | "ambiguous_agent" | "missing_skill" | "unsupported_mode";

export interface BoundAgentDiscoveryDeps {
	/** Test seam; production always uses the cache-cleared upstream discovery. */
	discover?: (cwd: string) => AgentDiscoveryResult;
	resolveSkills?: (skillNames: string[], cwd: string) => { resolved: Array<{ name: string; source: string; path: string }>; missing: string[] };
	clearCaches?: () => void;
	/** Test seam for the project refinement overlay probe. */
	refinementExists?: (cwd: string, agentName: string) => boolean;
}

/**
 * Decision D4: both in-memory discovery caches are dropped before every
 * resolution, because `resolveSkills` otherwise answers from `skillCache` on an
 * unchanged `mtimeMs` and the published digest would lag the bytes on disk.
 * Neither clear touches the filesystem.
 */
export function clearBoundDiscoveryCaches(): void {
	clearAgentDiscoveryCache();
	clearSkillCache();
}

export function boundFileDigest(filePath: string): string {
	return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** Launch modes the bound leaf refuses to describe; each one would widen the contract silently. */
export function forbiddenBoundAgentMode(agent: AgentConfig): boolean {
	return (agent.source !== "project" && agent.source !== "package")
		|| agent.runner?.type === "external-cli"
		|| !Array.isArray(agent.tools)
		|| agent.extensions !== undefined
		// Пустой список в frontmatter upstream нормализует в `[]`: он не даёт листу ни
		// одного расширения, поэтому закрывать запуск незачем.
		|| (agent.source !== "package" && agent.subagentOnlyExtensions !== undefined && agent.subagentOnlyExtensions.length > 0)
		|| Boolean(agent.skillPath?.length)
		|| (agent.source === "package" && Boolean(agent.skills?.length))
		|| agent.inheritProjectContext || agent.inheritSkills || Boolean(agent.memory)
		|| Boolean(agent.defaultReads?.length)
		|| (agent.source === "package" && agent.defaultContext === "fork")
		|| agent.defaultAsync === true
		|| agent.defaultAcceptance !== undefined
		|| (agent.source === "package" && agent.acceptanceRole !== undefined)
		|| agent.output !== undefined
		|| agent.disabled === true
		|| agent.machine !== undefined
		|| Boolean(agent.tools.some((tool) => tool === "subagent" || tool.startsWith("mcp:") || tool.includes("/") || /\.(?:ts|js)$/u.test(tool)));
}

/** Strict re-read of the agent definition and its skills from bytes on disk. */
export function resolveBoundAgent(input: {
	agent: string;
	skill?: string | string[] | false;
	activeCwd: string;
	deps?: BoundAgentDiscoveryDeps;
}): { ok: true; resolution: BoundAgentResolution } | { ok: false; code: BoundAgentResolutionCode } {
	const deps = input.deps ?? {};
	(deps.clearCaches ?? clearBoundDiscoveryCaches)();
	let discovered: AgentDiscoveryResult;
	try { discovered = (deps.discover ?? ((cwd: string) => discoverAgents(cwd, "both")))(input.activeCwd); }
	catch { return { ok: false, code: "unsupported_mode" }; }
	const resolved = resolveAgentName(input.agent, discovered.agents);
	if (resolved.error) return { ok: false, code: "ambiguous_agent" };
	if (!resolved.agent) return { ok: false, code: "missing_agent" };
	const agent = resolved.agent;
	if (forbiddenBoundAgentMode(agent)) return { ok: false, code: "unsupported_mode" };
	// Refinement-оверлей проекта попадает в системный промпт листа через
	// buildEffectiveSystemPrompt, но не в digest контракта. Пока он не аттестован,
	// запуск отвергается — как это делал A1 (main:src/api/active-bound-resolver.ts:269).
	let hasRefinement: boolean;
	try { hasRefinement = (deps.refinementExists ?? ((cwd: string, name: string) => fs.existsSync(getAgentRefinementPath(cwd, name))))(input.activeCwd, agent.name); }
	catch { return { ok: false, code: "unsupported_mode" }; }
	if (hasRefinement) return { ok: false, code: "unsupported_mode" };
	const explicitSkills = Array.isArray(input.skill)
		? input.skill.map((name) => name.trim()).filter(Boolean)
		: normalizeSkillInput(input.skill);
	if (agent.source === "package" && explicitSkills !== undefined && explicitSkills !== false && explicitSkills.length > 0) return { ok: false, code: "unsupported_mode" };
	const skillNames = explicitSkills === false ? [] : explicitSkills ?? agent.skills ?? [];
	const resolvedSkills = (deps.resolveSkills ?? ((names: string[], cwd: string) => resolveSkills(names, cwd)))(skillNames, input.activeCwd);
	if (resolvedSkills.missing.length > 0) return { ok: false, code: "missing_skill" };
	let skills: BoundSkillEvidenceV1[];
	let fileContentDigest: string;
	try {
		skills = resolvedSkills.resolved.map((skill) => ({ name: skill.name, source: skill.source, contentDigest: boundFileDigest(skill.path) }));
		fileContentDigest = boundFileDigest(agent.filePath);
	} catch { return { ok: false, code: "unsupported_mode" }; }
	return {
		ok: true,
		resolution: { agent, definitionDigest: agentDefinitionDigest(agent), fileContentDigest, skillNames, skills, discovered },
	};
}
