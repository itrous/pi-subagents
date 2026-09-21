import type { PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";

const ENV = "MCP_DIRECT_TOOLS";

export type FailurePoint = "reload" | "refresh" | "inheritProvider" | "sessionManager" | "resolveCliModel" | "createAgentSession" | "bindExtensions";

export interface Probe {
	envAtReload: Array<string | undefined>;
	envAtBind: Array<string | undefined>;
	hookNames: string[];
	requests: number;
	disposed: number;
	prompts: number;
	aborts: number;
}

/**
 * Tier-1 stand-in for the Pi module: exactly the members upstream `open()` uses,
 * each able to fail on request. Extension factories run during `reload()` and
 * `session_start` fires inside `bindExtensions()`, as in Pi.
 */
export function fakePi(options: { fail?: FailurePoint; activeTools?: (launchTools: string[]) => string[]; requiredError?: string; childSessionId?: string; hangShutdown?: boolean; promptGate?: Promise<void> } = {}): { pi: PiCodingAgentModule; probe: Probe } {
	const probe: Probe = { envAtReload: [], envAtBind: [], hookNames: [], requests: 0, disposed: 0, prompts: 0, aborts: 0 };
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const sessionId = options.childSessionId ?? "child-session";
	// Upstream's own child hooks also run here; members they touch but this stand does not model answer inertly.
	const inert = <T extends object>(target: T): T => new Proxy(target, { get: (object, property) => (property in object ? Reflect.get(object, property) : () => undefined) });
	const ctx = inert({ cwd: process.cwd(), hasUI: false, sessionManager: inert({ getSessionId: () => sessionId, getEntries: () => [], getBranch: () => [] }) });
	const api = inert({
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		registerTool() {},
		getAllTools: () => [],
		getActiveTools: () => [],
	});
	const emit = async (event: { type: string }) => {
		// A `session_shutdown` handler that never returns, as in the S5 measurement.
		if (options.hangShutdown && event.type === "session_shutdown") return new Promise<void>(() => {});
		for (const handler of handlers.get(event.type) ?? []) await handler(event, ctx);
	};
	const pi = {
		ModelRuntime: {
			create: async () => ({
				registerProvider() {},
				registerNativeProvider() {},
				async refresh() { if (options.fail === "refresh") throw new Error("injected refresh failure"); },
			}),
		},
		SettingsManager: { create: () => ({ getTheme: () => ({}) }) },
		DefaultResourceLoader: class {
			loaded = false;
			private readonly factories: Array<{ name: string; factory: (pi: unknown) => unknown }>;
			constructor(input: { extensionFactories?: Array<{ name: string; factory: (pi: unknown) => unknown }> }) { this.factories = input.extensionFactories ?? []; }
			async reload() {
				probe.envAtReload.push(process.env[ENV]);
				if (options.fail === "reload") throw new Error("injected reload failure");
				for (const hook of this.factories) { probe.hookNames.push(hook.name); await hook.factory(api); }
			}
			getExtensions() {
				return {
					extensions: [],
					errors: options.requiredError ? [{ path: options.requiredError, error: "injected required failure" }] : [],
					runtime: options.fail === "refresh" ? { pendingProviderRegistrations: [{ name: "injected", config: {}, extensionPath: "/injected.ts" }] } : {},
				};
			}
		},
		SessionManager: new Proxy({}, {
			get: () => () => {
				if (options.fail === "sessionManager") throw new Error("injected session manager failure");
				return {};
			},
		}),
		resolveCliModel: () => options.fail === "resolveCliModel"
			? { error: "injected model failure" }
			: { model: { provider: "openai", id: "gpt-5", api: "openai-responses" }, thinkingLevel: "medium" },
		createAgentSession: async (input: { tools?: string[] }) => {
			if (options.fail === "createAgentSession") throw new Error("injected createAgentSession failure");
			const launchTools = input.tools ?? [];
			const active = options.activeTools ? options.activeTools(launchTools) : launchTools;
			const model = { provider: "openai", id: "gpt-5", api: "openai-responses" };
			const agent = {
				streamFunction: (() => { probe.requests += 1; return {}; }) as (model: unknown, context: unknown) => unknown,
				hasQueuedMessages: () => false,
			};
			const session = {
				agent,
				model,
				messages: [],
				sessionFile: undefined,
				sessionId,
				getActiveToolNames: () => [...active],
				async bindExtensions() {
					probe.envAtBind.push(process.env[ENV]);
					if (options.fail === "bindExtensions") throw new Error("injected bindExtensions failure");
					await emit({ type: "session_start" });
				},
				extensionRunner: { hasHandlers: (event: string) => (options.hangShutdown === true && event === "session_shutdown") || handlers.has(event), emit },
				subscribe: () => () => {},
				async prompt() {
					probe.prompts += 1;
					await options.promptGate;
					// Pi turns a stream-function failure into an error message, never a rejected prompt.
					try { agent.streamFunction(model, { tools: active.map((name) => ({ name })) }); } catch { /* recorded by the barrier */ }
				},
				steer: async () => {}, followUp: async () => {}, abort: async () => { probe.aborts += 1; },
				dispose() { probe.disposed += 1; },
			};
			return { session };
		},
	};
	return { pi: pi as unknown as PiCodingAgentModule, probe };
}
