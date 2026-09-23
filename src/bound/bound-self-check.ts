import type { PiCodingAgentModule } from "../runs/shared/child-session.ts";
import { getAgentDir } from "../shared/utils.ts";
import type { BoundExecutionProofs } from "./bound-execution-port.ts";
import {
	boundTranscriptApiOf, loadBoundTranscriptModules, probeBoundTranscriptContext, recordVerifiedBoundTranscriptApi,
	type BoundTranscriptApi, type BoundTranscriptModules,
} from "./bound-transcript.ts";

export interface BoundSelfCheckResult {
	/** `AgentSession.agent` exists on an instance. */
	agent: boolean;
	/** `Agent.streamFunction` is a function the barrier can wrap. */
	streamFunction: boolean;
	/** `AgentSession.getActiveToolNames` returns names: the registry snapshot depends on it. */
	getActiveToolNames: boolean;
	/** `"loaded" in loader`: the per-child extension cache reset depends on it. */
	loaded: boolean;
	/**
	 * pi-ai `getCurrentTools` and pi-agent-core `Agent` are the runtime's own
	 * copies: pi-agent-core re-exports the same pi-ai binding, and the session's
	 * agent is an instance of that `Agent`.
	 */
	transcriptApi: boolean;
	/** The runtime's agent loop hands the stream function a transcript whose replay the barrier reads correctly. */
	transcriptContext: boolean;
}

const FAILED: BoundSelfCheckResult = Object.freeze({
	agent: false, streamFunction: false, getActiveToolNames: false, loaded: false, transcriptApi: false, transcriptContext: false,
});

export interface BoundSelfCheckOptions {
	loadPiCodingAgent?: () => Promise<PiCodingAgentModule>;
	/** Test seam: the pi-ai/pi-agent-core modules; production imports what Pi's loader maps. */
	loadTranscriptModules?: () => Promise<BoundTranscriptModules>;
	cwd?: string;
}

/**
 * One-shot in-memory session (decision D9, probe P2): no `bindExtensions`, no
 * session `prompt`, no provider call, then `dispose()`. The first four fields
 * are the private Pi surface the bound layer relies on. The transcript fields
 * drive a separate `Agent` of the same runtime whose stream function records the
 * context and throws (`probeBoundTranscriptContext`): no provider, no network.
 * A fully passed check records the verified transcript API for the barrier; any
 * other outcome clears it.
 */
export async function runBoundSelfCheck(options: BoundSelfCheckOptions = {}): Promise<BoundSelfCheckResult> {
	recordVerifiedBoundTranscriptApi(undefined);
	try {
		const pi = await (options.loadPiCodingAgent ?? (() => import("@earendil-works/pi-coding-agent")))();
		let transcript: BoundTranscriptApi | undefined;
		try { transcript = boundTranscriptApiOf(await (options.loadTranscriptModules ?? loadBoundTranscriptModules)()); }
		catch { transcript = undefined; }
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
			const transcriptApi = transcript !== undefined && Boolean(agent) && agent instanceof transcript.Agent;
			const result: BoundSelfCheckResult = {
				agent: Boolean(agent) && typeof agent === "object",
				streamFunction: typeof agent?.streamFunction === "function",
				getActiveToolNames: Array.isArray(names) && names.every((name) => typeof name === "string"),
				loaded,
				transcriptApi,
				transcriptContext: transcriptApi && transcript !== undefined && await probeBoundTranscriptContext(transcript),
			};
			if (boundSelfCheckPassed(result)) recordVerifiedBoundTranscriptApi(transcript);
			return result;
		} finally { session.dispose(); }
	} catch { return FAILED; }
}

export function boundSelfCheckPassed(result: BoundSelfCheckResult | undefined): boolean {
	return Boolean(result && result.agent && result.streamFunction && result.getActiveToolNames && result.loaded
		&& result.transcriptApi && result.transcriptContext);
}

/**
 * Features of the leaf a consumer may require beside the leaf itself (subplan
 * A1R.6). A producer without them lacks the keys, and its strict request parser
 * refuses `toolShadowing`/`mcpConfig` as an invalid request.
 */
export const BOUND_LEAF_FEATURE_CAPABILITIES = Object.freeze({
	boundSessionBindings: Object.freeze({ version: 1 }),
	boundToolShadowing: Object.freeze({ version: 1 }),
	boundMcpConfig: Object.freeze({ version: 1 }),
});

/**
 * `boundForegroundLeaf: { version: 2 }` and the feature keys only when every
 * condition holds: a verified source identity, a passed self-check (including
 * the transcript checks), a connected execution port, and both proof
 * collectors. Any false condition removes every key and the client refuses closed.
 */
export function boundForegroundLeafCapability(input: {
	identityAvailable: boolean;
	selfCheck: BoundSelfCheckResult | undefined;
	port: boolean;
	proofs: Readonly<BoundExecutionProofs> | undefined;
}): Record<string, unknown> {
	const available = input.identityAvailable && boundSelfCheckPassed(input.selfCheck) && input.port
		&& input.proofs?.toolRegistry === true && input.proofs.deniedTools === true;
	return available
		? {
			boundForegroundLeaf: { version: 2 },
			...Object.fromEntries(Object.entries(BOUND_LEAF_FEATURE_CAPABILITIES).map(([key, value]) => [key, { ...value }])),
		}
		: {};
}
