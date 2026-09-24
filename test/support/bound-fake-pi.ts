import type { PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { transcriptContext, transcriptTool } from "./bound-transcript.ts";

const ENV = "MCP_DIRECT_TOOLS";
/** Builtins this stand's Pi exposes; `read` is the one the fixture agents allow. */
const BUILTINS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export type FailurePoint = "reload" | "getExtensions" | "refresh" | "inheritProvider" | "sessionManager" | "resolveCliModel" | "createAgentSession" | "bindExtensions";

export interface Probe {
	envAtReload: Array<string | undefined>;
	envAtBind: Array<string | undefined>;
	hookNames: string[];
	/** Calls that reached the original stream function: the provider counter. */
	requests: number;
	disposed: number;
	prompts: number;
	aborts: number;
	sessions: number;
	/** Live registry snapshots taken by the layer, per session, in creation order. */
	activeToolNames: string[][];
	/** Releases the held prompt of session `index` (creation order). */
	release(index: number): void;
	releaseAll(): void;
}

export interface FakePiOptions {
	fail?: FailurePoint;
	activeTools?: (launchTools: string[]) => string[];
	requiredError?: string;
	childSessionId?: string;
	hangShutdown?: boolean;
	/** S3 P2: `session_shutdown` emission rejects, as a runner whose handler threw would. */
	throwShutdown?: boolean;
	/** Every prompt waits for this promise before its model call. */
	promptGate?: Promise<void>;
	/** Every prompt waits until `probe.release(index)`; an abort releases it too. */
	holdPrompts?: boolean;
	/** The model `resolveCliModel` returns; defaults to `openai/gpt-5`. */
	modelId?: string;
	/** A prompt that passed the barrier calls the registered `structured_output` tool with this value. */
	structuredValue?: unknown;
	/** `reload()` takes this long, e.g. to let a cancel land while `create()` is still loading. */
	reloadDelayMs?: number;
	/** Stand-in for pi-mcp-adapter: register one `server_tool` per `server/tool` selector in the window. */
	registerFromMcpWindow?: boolean;
	/** `getAllTools()` reports the builtin for these names although a package registered them. */
	builtinWins?: string[];
}

interface Tool { name: string; description?: string; parameters?: unknown; execute?: (...args: unknown[]) => unknown }
type Listener = (event: Record<string, unknown>) => void;

/**
 * Tier-1 stand-in for the Pi module: exactly the members upstream `open()` uses,
 * each able to fail on request. Each loader carries its own extension handlers
 * and tools; factories run during `reload()` and `session_start` fires inside
 * `bindExtensions()`, as in Pi. The active tool set is the launch allowlist
 * restricted to builtins and registered tools.
 */
export function fakePi(options: FakePiOptions = {}): { pi: PiCodingAgentModule; probe: Probe } {
	const gates: Array<() => void> = [];
	let loaders = 0;
	const releaseQueue = new Set<number>();
	const probe: Probe = {
		envAtReload: [], envAtBind: [], hookNames: [], requests: 0, disposed: 0, prompts: 0, aborts: 0, sessions: 0, activeToolNames: [],
		release(index) { releaseQueue.add(index); gates[index]?.(); },
		releaseAll() { for (let index = 0; index < Math.max(gates.length, 64); index++) probe.release(index); },
	};
	// Upstream's own child hooks also run here; members they touch but this stand does not model answer inertly.
	const inert = <T extends object>(target: T): T => new Proxy(target, { get: (object, property) => (property in object ? Reflect.get(object, property) : () => undefined) });

	class FakeLoader {
		loaded = false;
		readonly handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		readonly tools = new Map<string, Tool>();
		readonly sessionId: string;
		private readonly factories: Array<{ name: string; factory: (pi: unknown) => unknown }>;
		constructor(input: { extensionFactories?: Array<{ name: string; factory: (pi: unknown) => unknown }> }) {
			this.factories = input.extensionFactories ?? [];
			const ordinal = loaders++;
			this.sessionId = options.childSessionId ?? (ordinal === 0 ? "child-session" : `child-session-${ordinal}`);
		}
		get ctx() {
			return inert({ cwd: process.cwd(), hasUI: false, sessionManager: inert({ getSessionId: () => this.sessionId, getEntries: () => [], getBranch: () => [] }) });
		}
		async reload() {
			probe.envAtReload.push(process.env[ENV]);
			if (options.fail === "reload") throw new Error("injected reload failure");
			if (options.reloadDelayMs) await new Promise((resolve) => setTimeout(resolve, options.reloadDelayMs));
			const api = inert({
				on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => { this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]); },
				registerTool: (tool: Tool) => { this.tools.set(tool.name, tool); },
				getAllTools: () => [],
				getActiveTools: () => [],
			});
			const window = process.env[ENV];
			if (options.registerFromMcpWindow && window && window !== "__none__") {
				for (const selector of window.split(",")) if (selector.includes("/")) this.tools.set(selector.replace("/", "_"), { name: selector.replace("/", "_") });
			}
			for (const hook of this.factories) {
				probe.hookNames.push(hook.name);
				// Pi records a throwing inline factory as a load error and goes on.
				try { await hook.factory(api); } catch { /* recorded as a load error by Pi */ }
			}
		}
		getExtensions() {
			if (options.fail === "getExtensions") throw new Error("injected getExtensions failure");
			return {
				extensions: [],
				errors: options.requiredError ? [{ path: options.requiredError, error: "injected required failure" }] : [],
				runtime: options.fail === "refresh" ? { pendingProviderRegistrations: [{ name: "injected", config: {}, extensionPath: "/injected.ts" }] } : {},
			};
		}
		async emit(event: { type: string }) {
			// A `session_shutdown` handler that never returns, as in the S5 measurement.
			if (options.hangShutdown && event.type === "session_shutdown") return new Promise<void>(() => {});
			if (options.throwShutdown && event.type === "session_shutdown") throw new Error("shutdown handler failed");
			for (const handler of this.handlers.get(event.type) ?? []) await handler(event, this.ctx);
		}
	}

	const model = { provider: "openai", id: options.modelId ?? "gpt-5", api: "openai-responses" };
	const pi = {
		ModelRuntime: {
			create: async () => ({
				registerProvider() {},
				registerNativeProvider() {},
				async refresh() { if (options.fail === "refresh") throw new Error("injected refresh failure"); },
			}),
		},
		SettingsManager: { create: () => ({ getTheme: () => ({}) }) },
		DefaultResourceLoader: FakeLoader,
		SessionManager: new Proxy({}, {
			get: () => () => {
				if (options.fail === "sessionManager") throw new Error("injected session manager failure");
				return {};
			},
		}),
		resolveCliModel: () => options.fail === "resolveCliModel"
			? { error: "injected model failure" }
			: { model, thinkingLevel: "medium" },
		createAgentSession: async (input: { tools?: string[]; resourceLoader: FakeLoader }) => {
			if (options.fail === "createAgentSession") throw new Error("injected createAgentSession failure");
			const loader = input.resourceLoader;
			const index = probe.sessions++;
			let release!: () => void;
			const held = options.holdPrompts ? new Promise<void>((resolve) => { release = resolve; }) : undefined;
			if (held) { gates[index] = release; if (releaseQueue.has(index)) release(); }
			const launchTools = input.tools ?? [];
			const active = () => options.activeTools
				? options.activeTools(launchTools)
				: launchTools.filter((name) => BUILTINS.has(name) || loader.tools.has(name));
			const listeners = new Set<Listener>();
			const messages: Array<Record<string, unknown>> = [];
			let aborted = false;
			const emitEvent = (event: Record<string, unknown>) => {
				if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) messages.push(event.message as Record<string, unknown>);
				for (const listener of [...listeners]) listener(event);
			};
			const agent = {
				streamFunction: (() => { probe.requests += 1; return {}; }) as (model: unknown, context: unknown) => unknown,
				hasQueuedMessages: () => false,
			};
			const session = {
				agent,
				model,
				messages,
				sessionFile: undefined,
				sessionId: loader.sessionId,
				getAllTools: () => [
					...[...BUILTINS].filter((name) => !loader.tools.has(name) || options.builtinWins?.includes(name))
						.map((name) => ({ ...transcriptTool(name), sourceInfo: { source: "builtin", path: `<builtin:${name}>` } })),
					...[...loader.tools.values()].filter((tool) => !options.builtinWins?.includes(tool.name))
						.map((tool) => ({ name: tool.name, description: tool.description ?? tool.name, parameters: tool.parameters ?? {}, sourceInfo: { source: "local", path: "<inline>" } })),
				],
				getActiveToolNames: () => {
					const names = active();
					probe.activeToolNames[index] = [...names];
					return names;
				},
				async bindExtensions() {
					probe.envAtBind.push(process.env[ENV]);
					if (options.fail === "bindExtensions") throw new Error("injected bindExtensions failure");
					await loader.emit({ type: "session_start" });
				},
				extensionRunner: { hasHandlers: (event: string) => ((options.hangShutdown === true || options.throwShutdown === true) && event === "session_shutdown") || loader.handlers.has(event), emit: (event: { type: string }) => loader.emit(event) },
				subscribe: (listener: Listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
				async prompt() {
					probe.prompts += 1;
					await options.promptGate;
					await held;
					if (aborted) {
						emitEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "aborted" } });
						emitEvent({ type: "agent_end", messages: [...messages], willRetry: false });
						return;
					}
					let refusal: string | undefined;
					// Pi turns a stream-function failure into an error message, never a rejected prompt.
					try {
						// The provider is shown each active tool's own declaration, as Pi 0.87 does.
						agent.streamFunction(model, transcriptContext(active().map((name) => {
							const tool = loader.tools.get(name);
							return tool?.description !== undefined && !options.builtinWins?.includes(name)
								? { name, description: tool.description, parameters: (tool.parameters ?? {}) as object }
								: name;
						})));
					}
					catch (error) { refusal = error instanceof Error ? error.message : String(error); }
					if (!refusal && options.structuredValue !== undefined) {
						emitEvent({ type: "tool_execution_start", toolName: "structured_output", args: { value: options.structuredValue } });
						await loader.tools.get("structured_output")?.execute?.("structured", { value: options.structuredValue }, new AbortController().signal, undefined, loader.ctx);
						emitEvent({ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } });
						emitEvent({ type: "tool_execution_end", toolName: "structured_output" });
					}
					emitEvent({
						type: "message_end",
						message: refusal
							? { role: "assistant", content: [], model: model.id, stopReason: "error", errorMessage: refusal, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }
							: { role: "assistant", content: [{ type: "text", text: "done" }], model: model.id, stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } },
					});
					emitEvent({ type: "agent_end", messages: [...messages], willRetry: false });
					emitEvent({ type: "agent_settled" });
				},
				steer: async () => {}, followUp: async () => {},
				abort: async () => { probe.aborts += 1; aborted = true; release?.(); },
				dispose() { probe.disposed += 1; listeners.clear(); },
			};
			return { session };
		},
	};
	return { pi: pi as unknown as PiCodingAgentModule, probe };
}
