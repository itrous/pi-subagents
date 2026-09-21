import type { PiCodingAgentModule } from "../runs/shared/child-session.ts";
import { getAgentDir } from "../shared/utils.ts";
import type { BoundExecutionProofs } from "./bound-execution-port.ts";

export interface BoundSelfCheckResult {
	/** `AgentSession.agent` exists on an instance. */
	agent: boolean;
	/** `Agent.streamFunction` is a function the barrier can wrap. */
	streamFunction: boolean;
	/** `AgentSession.getActiveToolNames` returns names: the registry snapshot depends on it. */
	getActiveToolNames: boolean;
	/** `"loaded" in loader`: the per-child extension cache reset depends on it. */
	loaded: boolean;
}

const FAILED: BoundSelfCheckResult = Object.freeze({ agent: false, streamFunction: false, getActiveToolNames: false, loaded: false });

/**
 * One-shot in-memory session (decision D9, probe P2): no `bindExtensions`, no
 * `prompt`, no provider call, then `dispose()`. The four fields are exactly the
 * private Pi surface the bound layer relies on.
 */
export async function runBoundSelfCheck(options: { loadPiCodingAgent?: () => Promise<PiCodingAgentModule>; cwd?: string } = {}): Promise<BoundSelfCheckResult> {
	try {
		const pi = await (options.loadPiCodingAgent ?? (() => import("@earendil-works/pi-coding-agent")))();
		const cwd = options.cwd ?? process.cwd();
		const agentDir = getAgentDir();
		const modelRuntime = await pi.ModelRuntime.create();
		const settingsManager = pi.SettingsManager.create(cwd, agentDir);
		const loader = new pi.DefaultResourceLoader({
			cwd, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		const loaded = "loaded" in loader;
		const { session } = await pi.createAgentSession({
			cwd, agentDir, modelRuntime, resourceLoader: loader, settingsManager,
			sessionManager: pi.SessionManager.inMemory(cwd),
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
		try {
			const agent = (session as { agent?: { streamFunction?: unknown } }).agent;
			let names: unknown;
			try { names = typeof session.getActiveToolNames === "function" ? session.getActiveToolNames() : undefined; } catch { names = undefined; }
			return {
				agent: Boolean(agent) && typeof agent === "object",
				streamFunction: typeof agent?.streamFunction === "function",
				getActiveToolNames: Array.isArray(names) && names.every((name) => typeof name === "string"),
				loaded,
			};
		} finally { session.dispose(); }
	} catch { return FAILED; }
}

export function boundSelfCheckPassed(result: BoundSelfCheckResult | undefined): boolean {
	return Boolean(result && result.agent && result.streamFunction && result.getActiveToolNames && result.loaded);
}

/**
 * `boundForegroundLeaf: { version: 2 }` only when every condition holds: a
 * verified source identity, a passed self-check, a connected execution port, and
 * both proof collectors. Any false condition removes the key and the client
 * refuses closed.
 */
export function boundForegroundLeafCapability(input: {
	identityAvailable: boolean;
	selfCheck: BoundSelfCheckResult | undefined;
	port: boolean;
	proofs: Readonly<BoundExecutionProofs> | undefined;
}): Record<string, unknown> {
	const available = input.identityAvailable && boundSelfCheckPassed(input.selfCheck) && input.port
		&& input.proofs?.toolRegistry === true && input.proofs.deniedTools === true;
	return available ? { boundForegroundLeaf: { version: 2 } } : {};
}
