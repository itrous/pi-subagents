import * as path from "node:path";
import { buildSkillInjection, resolveSkills } from "../agents/skills.ts";
import type { ChildSessionLaunch } from "../runs/shared/child-session.ts";
import { canonicalSha256 } from "../shared/canonical-json.ts";
import { agentDefinitionDigest } from "../shared/launch-contract.ts";
import { boundFileDigest } from "./bound-agent-discovery.ts";
import type { BoundAuthorizedLaunch } from "./bound-runtime-service.ts";

export type BoundLaunchField =
	| "cwd" | "storage" | "model" | "tools" | "excludeTools" | "ambientExtensions" | "noSkills" | "noContextFiles"
	| "runtime.mcpDirectTools" | "runtime.requiredTools" | "runtime.capabilityCeiling" | "runtime.disabledPolicy"
	| "systemPrompt" | "extensionPaths" | "packageRefs";

export type BoundLaunchRecheckResult = { ok: true } | { ok: false; mismatches: BoundLaunchField[] };

export interface BoundLaunchRecheckDeps {
	/** Test seam; production resolves skills exactly as the executor does for a bound leaf. */
	resolveSkills?: (skillNames: string[], cwd: string) => ReturnType<typeof resolveSkills>;
}

/**
 * Traces of policy the contract declares off (`intercom`, `control`,
 * `watchdog`). `orchestratorSessionId`/`parentSessionId` are not traces: any
 * launch with a known parent carries them.
 */
const DISABLED_POLICY_RUNTIME_KEYS = ["intercomSessionName", "orchestratorTarget", "supervisorChannelDir", "childWatchdog", "watchdogStatus"] as const;

function sameList(left: readonly string[] | undefined, right: readonly string[]): boolean {
	const actual = left ?? [];
	return actual.length === right.length && actual.every((entry, index) => entry === right[index]);
}

function escapeXmlAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The child prompt a bound leaf must receive: the agent's base prompt plus the
 * skill block, tagged the way `buildInProcessChildLaunch` tags it. Memory and a
 * refinement overlay are refused at resolution, so they are deliberately not
 * reproduced here: an overlay that appeared after preflight makes the digest
 * differ instead of being accepted. Undefined when the agent or a skill no
 * longer matches the contract bytes.
 */
export function boundExpectedSystemPrompt(authorized: BoundAuthorizedLaunch, deps: BoundLaunchRecheckDeps = {}): string | undefined {
	const { agent, contract } = authorized;
	if (agent.name !== contract.agent.name || agentDefinitionDigest(agent) !== contract.agent.definitionDigest) return undefined;
	let prompt = agent.systemPrompt?.trim() ?? "";
	if (contract.skills.length > 0) {
		let resolved;
		try { resolved = (deps.resolveSkills ?? resolveSkills)(contract.skills.map((skill) => skill.name), contract.canonicalCwd); }
		catch { return undefined; }
		if (resolved.missing.length > 0 || resolved.resolved.length !== contract.skills.length) return undefined;
		for (let index = 0; index < contract.skills.length; index++) {
			const expected = contract.skills[index]!;
			const actual = resolved.resolved[index]!;
			let digest: string;
			try { digest = boundFileDigest(actual.path); } catch { return undefined; }
			if (actual.name !== expected.name || actual.source !== expected.source || digest !== expected.contentDigest) return undefined;
		}
		const injection = buildSkillInjection(resolved.resolved);
		prompt = prompt ? `${prompt}\n\n${injection}` : injection;
	}
	return `<active_agent name="${escapeXmlAttr(agent.name)}"/>\n\n${prompt}`;
}

/** Launch entry a contract ref produced: `package:` refs stay literal, relative refs become absolute (agents.ts). */
function rawRefEntry(ref: string, agentFilePath: string): string {
	return ref.startsWith("package:") ? ref : path.resolve(path.dirname(agentFilePath), ref);
}

/**
 * Final re-check of the upstream-built launch against the contract, before the
 * session exists (invariant I4.4). It runs on the launch exactly as upstream
 * built it, i.e. before the decorator removes the attested package refs.
 */
export function recheckBoundLaunch(launch: ChildSessionLaunch, authorized: BoundAuthorizedLaunch, deps: BoundLaunchRecheckDeps = {}): BoundLaunchRecheckResult {
	const { contract, agent } = authorized;
	const mismatches: BoundLaunchField[] = [];
	const runtime = launch.runtime;

	if (launch.cwd !== contract.canonicalCwd) mismatches.push("cwd");
	if (launch.storage.kind !== "file" || canonicalSha256(launch.storage.sessionFile) !== contract.roots.sessionFileDigest) mismatches.push("storage");
	if (launch.model !== contract.modelCandidates[0]) mismatches.push("model");
	if (!launch.tools || !sameList(launch.tools, contract.tools.effectiveAllowlist)) mismatches.push("tools");
	if (launch.excludeTools !== undefined && launch.excludeTools.length > 0) mismatches.push("excludeTools");
	if (launch.ambientExtensions !== false) mismatches.push("ambientExtensions");
	// The resolver refuses `inheritSkills` and `inheritProjectContext`, so a bound
	// leaf always runs without ambient skills and context files.
	if (launch.noSkills !== true) mismatches.push("noSkills");
	if (launch.noContextFiles !== true) mismatches.push("noContextFiles");
	if (!sameList(runtime.mcpDirectTools, contract.mcpDirectTools)) mismatches.push("runtime.mcpDirectTools");
	if (!sameList(runtime.requiredTools, contract.tools.requiredChildTools)) mismatches.push("runtime.requiredTools");
	if (canonicalSha256(runtime.capabilityCeiling ?? null) !== canonicalSha256(contract.tools.capabilityCeiling ?? null)) mismatches.push("runtime.capabilityCeiling");
	if (DISABLED_POLICY_RUNTIME_KEYS.some((key) => runtime[key] !== undefined)) mismatches.push("runtime.disabledPolicy");

	const expectedPrompt = boundExpectedSystemPrompt(authorized, deps);
	const [promptField, otherField] = agent.systemPromptMode === "replace"
		? [launch.systemPrompt, launch.appendSystemPrompt]
		: [launch.appendSystemPrompt, launch.systemPrompt];
	if (expectedPrompt === undefined || promptField === undefined || otherField !== undefined
		|| canonicalSha256(promptField) !== canonicalSha256(expectedPrompt)) mismatches.push("systemPrompt");

	// Every contract ref must appear exactly once among the raw entries, and
	// nothing else may remain once they are removed.
	const expectedEntries = contract.packageExtensions.map((entry) => rawRefEntry(entry.ref, agent.filePath));
	const remaining = [...launch.extensionPaths];
	let refsMatch = expectedEntries.length === authorized.packageExtensionPaths.length;
	for (const entry of expectedEntries) {
		const index = remaining.indexOf(entry);
		if (index < 0) { refsMatch = false; continue; }
		remaining.splice(index, 1);
	}
	if (!refsMatch) mismatches.push("packageRefs");
	if (remaining.length > 0) mismatches.push("extensionPaths");

	return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
}
