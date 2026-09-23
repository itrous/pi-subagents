import { types as utilTypes } from "node:util";
import { canonicalSha256 } from "../shared/canonical-json.ts";
import { validToolRegistryName } from "./bound-tool-registry-projection.ts";

/**
 * Pi 0.87 hands the stream function a `TranscriptContext` (`{ messages }`): the
 * tools a call may use are the replay of `toolsAdded`/`toolsRemoved` on system
 * messages, not a `context.tools` field. The replay is pi-ai `getCurrentTools`
 * of the copy the loaded Pi runtime runs: the specifiers below are the ones Pi's
 * extension loader maps to its own modules (virtual modules in the bundled CLI,
 * dist aliases otherwise), never the fork's dev dependency or an owner's copy.
 * `boundTranscriptApiOf` and the self-check prove that identity; a copy that
 * fails the proof leaves the capability absent and every leaf refused.
 */
const MAX_TRANSCRIPT_MESSAGES = 100_000;

export interface BoundTranscriptApi {
	/** pi-ai `getCurrentTools` of the loaded runtime. */
	getCurrentTools(messages: readonly unknown[]): unknown;
	/** pi-agent-core `Agent` of the loaded runtime. */
	Agent: new (options: Record<string, unknown>) => BoundProbeAgent;
}

export interface BoundProbeAgent {
	state: { tools: unknown[] };
	prompt(input: string): Promise<void>;
}

export interface BoundTranscriptModules {
	ai: unknown;
	core: unknown;
}

export async function loadBoundTranscriptModules(): Promise<BoundTranscriptModules> {
	return {
		ai: await import("@earendil-works/pi-ai") as unknown,
		core: await import("@earendil-works/pi-agent-core") as unknown,
	};
}

function exported(namespace: unknown, name: string): unknown {
	if (!namespace || (typeof namespace !== "object" && typeof namespace !== "function")) return undefined;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(namespace, name);
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	} catch { return undefined; }
}

/**
 * The API only when pi-agent-core re-exports the very `uuidv7` binding of the
 * pi-ai module we hold: an ESM re-export is the same function object only for
 * the same module instance, so the replay function belongs to the pi-ai the
 * agent loop builds its context with.
 */
export function boundTranscriptApiOf(modules: BoundTranscriptModules): BoundTranscriptApi | undefined {
	const getCurrentTools = exported(modules.ai, "getCurrentTools");
	const aiUuid = exported(modules.ai, "uuidv7");
	const coreUuid = exported(modules.core, "uuidv7");
	const Agent = exported(modules.core, "Agent");
	if (typeof getCurrentTools !== "function" || typeof Agent !== "function" || typeof aiUuid !== "function" || aiUuid !== coreUuid) return undefined;
	return {
		getCurrentTools: getCurrentTools as BoundTranscriptApi["getCurrentTools"],
		Agent: Agent as BoundTranscriptApi["Agent"],
	};
}

export interface BoundTranscriptTools {
	ok: true;
	/** Tool names after the replay, in replay order. */
	names: string[];
	/** Name → SHA256 of the declaration the provider receives (name, description, parameters). */
	declarations: Map<string, string>;
}

export type BoundTranscriptToolsResult = BoundTranscriptTools | { ok: false };

function plainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function ownData(record: object, key: string): { present: boolean; value: unknown } {
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (!descriptor) return { present: false, value: undefined };
	if (!("value" in descriptor)) throw new TypeError("accessor");
	return { present: true, value: descriptor.value };
}

/**
 * Declaration the provider sees; the JSON round trip drops typebox symbols like
 * pi-ai's `toToolDeclaration`. `base` leaves out `constrainedSampling`, which
 * Pi's `getAllTools()` does not report.
 */
export function toolDeclarationDigest(tool: unknown, options: { base?: boolean } = {}): string | undefined {
	try {
		if (!tool || typeof tool !== "object" || utilTypes.isProxy(tool)) return undefined;
		const name = ownData(tool, "name").value;
		const description = ownData(tool, "description").value;
		const parameters = ownData(tool, "parameters").value;
		const constrainedSampling = ownData(tool, "constrainedSampling").value;
		if (!validToolRegistryName(name)) return undefined;
		const projected = JSON.parse(JSON.stringify({
			name, description: description ?? null, parameters: parameters ?? null,
			...(constrainedSampling === undefined || options.base ? {} : { constrainedSampling }),
		})) as unknown;
		return canonicalSha256(projected);
	} catch { return undefined; }
}

function toolList(value: unknown): unknown[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value) || utilTypes.isProxy(value)) return undefined;
	return value;
}

/**
 * The tool set of one model call. Refuses (ok: false) anything that is not the
 * exact transcript shape: a legacy `tools`/`systemPrompt` field, accessors,
 * proxies, a malformed system message, a duplicate name inside one delta, or a
 * runtime replay that disagrees with the fork's own replay of the same deltas.
 */
export function boundTranscriptTools(context: unknown, api: Pick<BoundTranscriptApi, "getCurrentTools">): BoundTranscriptToolsResult {
	try {
		if (!plainRecord(context)) return { ok: false };
		const keys = Reflect.ownKeys(context);
		if (keys.length !== 1 || keys[0] !== "messages") return { ok: false };
		const messages = ownData(context, "messages").value;
		if (!Array.isArray(messages) || utilTypes.isProxy(messages) || messages.length > MAX_TRANSCRIPT_MESSAGES) return { ok: false };
		const replay = new Map<string, unknown>();
		for (let index = 0; index < messages.length; index++) {
			const message = ownData(messages, String(index)).value;
			if (!message || typeof message !== "object" || utilTypes.isProxy(message)) return { ok: false };
			if (ownData(message, "role").value !== "system") {
				// Tool deltas outside a system message would be ignored by the runtime replay.
				if (ownData(message, "toolsAdded").present || ownData(message, "toolsRemoved").present) return { ok: false };
				continue;
			}
			const removed = toolList(ownData(message, "toolsRemoved").value);
			const added = toolList(ownData(message, "toolsAdded").value);
			if (!removed || !added) return { ok: false };
			for (const list of [removed, added]) {
				const seen = new Set<string>();
				for (const tool of list) {
					if (!tool || typeof tool !== "object" || utilTypes.isProxy(tool)) return { ok: false };
					const name = ownData(tool, "name").value;
					if (!validToolRegistryName(name) || seen.has(name)) return { ok: false };
					seen.add(name);
				}
			}
			for (const tool of removed) replay.delete(ownData(tool as object, "name").value as string);
			for (const tool of added) replay.set(ownData(tool as object, "name").value as string, tool);
		}
		const runtime = api.getCurrentTools(messages);
		if (!Array.isArray(runtime) || runtime.length !== replay.size) return { ok: false };
		const expected = [...replay.values()];
		if (runtime.some((tool, index) => tool !== expected[index])) return { ok: false };
		const declarations = new Map<string, string>();
		for (const [name, tool] of replay) {
			const digest = toolDeclarationDigest(tool);
			if (!digest) return { ok: false };
			declarations.set(name, digest);
		}
		return { ok: true, names: [...replay.keys()], declarations };
	} catch { return { ok: false }; }
}

const PROBE_TEXT = "pi-subagents bound self-check: transcript probe, no provider.";
const PROBE_MODEL = Object.freeze({
	id: "bound-self-check", name: "bound-self-check", provider: "bound-self-check", api: "openai-completions",
	baseUrl: "http://bound-self-check.invalid", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256,
});

function probeTool(name: string, description: string) {
	return {
		name, label: name, description,
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: async () => ({ content: [], details: undefined }),
	};
}

/**
 * Behavioral check of the loaded agent loop (no provider, no network): two
 * prompts on the runtime's own `Agent` with a stream function that records the
 * context and throws. The second loadout removes one tool, adds one, and
 * replaces the definition of a third; the replay must follow each step, the
 * replaced definition must be visible, and no legacy `tools` field may appear.
 */
export async function probeBoundTranscriptContext(api: BoundTranscriptApi): Promise<boolean> {
	try {
		const kept = probeTool("bound_self_check_kept", "kept v1");
		const dropped = probeTool("bound_self_check_dropped", "dropped");
		const replaced = probeTool("bound_self_check_kept", "kept v2");
		const added = probeTool("bound_self_check_added", "added");
		const captured: unknown[] = [];
		const agent = new api.Agent({
			initialState: { systemPrompt: "bound self-check", model: PROBE_MODEL, thinkingLevel: "off", tools: [kept, dropped], messages: [] },
			streamFn: (_model: unknown, context: unknown) => { captured.push(context); throw new Error(PROBE_TEXT); },
		});
		await agent.prompt("first");
		agent.state.tools = [replaced, added];
		await agent.prompt("second");
		if (captured.length !== 2) return false;
		const first = boundTranscriptTools(captured[0], api);
		const second = boundTranscriptTools(captured[1], api);
		if (!first.ok || !second.ok) return false;
		const sorted = (names: string[]) => [...names].sort().join(",");
		if (sorted(first.names) !== "bound_self_check_dropped,bound_self_check_kept") return false;
		if (sorted(second.names) !== "bound_self_check_added,bound_self_check_kept") return false;
		if (first.declarations.get("bound_self_check_kept") !== toolDeclarationDigest(kept)
			|| second.declarations.get("bound_self_check_kept") !== toolDeclarationDigest(replaced)
			|| toolDeclarationDigest(kept) === toolDeclarationDigest(replaced)) return false;
		// Negative control: the pre-0.87 shape is not a transcript.
		return !boundTranscriptTools({ tools: [kept] }, api).ok;
	} catch { return false; }
}

/**
 * The transcript API a passed self-check verified. A leaf is only launched on a
 * host whose capability was announced, and its barrier uses exactly this API;
 * without it the run is refused (`barrier_unavailable`).
 */
let verified: BoundTranscriptApi | undefined;

export function recordVerifiedBoundTranscriptApi(api: BoundTranscriptApi | undefined): void {
	verified = api;
}

export function verifiedBoundTranscriptApi(): BoundTranscriptApi | undefined {
	return verified;
}
