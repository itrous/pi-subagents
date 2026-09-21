import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACTIVE_BOUND_INTERNAL_RESERVED_TOOLS, CORE_RUNTIME_OWNED_TOOLS } from "../runs/shared/core-runtime-tools.ts";

/** Thrown for every forbidden facade operation; the caller closes the run. */
export class BoundPackageViolation extends Error {
	readonly operation: string;

	constructor(operation: string) {
		super(`pi-subagents bound leaf: package factory attempted a forbidden operation (${operation}).`);
		this.name = "BoundPackageViolation";
		this.operation = operation;
	}
}

export interface BoundPackageToolOwnership {
	occupiedToolNames: Set<string>;
	packageToolOwners: Map<string, symbol>;
}

export interface BoundPackageApiOptions {
	/** True once the stream barrier is installed; the tool set is frozen from then on. */
	barrierCommitted: () => boolean;
	/** Receives every violation before it is thrown, so a swallowed throw still closes the run. */
	onViolation: (violation: BoundPackageViolation) => void;
	/** A1 parity for pi-mcp-adapter: its `input` handler is dropped instead of refused before the barrier. */
	allowInputRegistrationNoop?: boolean;
	/** The run's private `pi.events` (`createBoundPackageEventBus`); without it the facade exposes no bus methods. */
	events?: ExtensionAPI["events"];
}

/**
 * Private `pi.events` shared by the package factories of one run; the host bus
 * stays unreachable. A1 parity: the child process had a bus of its own.
 * pi-mcp-adapter emits a tool-approval request on it before every MCP call.
 * Same semantics as Pi's `createEventBus`.
 */
export function createBoundPackageEventBus(): ExtensionAPI["events"] {
	const emitter = new EventEmitter();
	return {
		emit: (channel, data) => { emitter.emit(channel, data); },
		on: (channel, handler) => {
			const safeHandler = async (data: unknown) => {
				try { await handler(data); }
				catch (error) { console.error(`Event handler error (${channel}):`, error); }
			};
			emitter.on(channel, safeHandler);
			return () => { emitter.off(channel, safeHandler); };
		},
	};
}

/**
 * Names a package factory may never register: host builtins attested in the
 * contract, the fork's own core list, runtime-internal names, and the
 * contract's internal tools. Names taken by another package factory of the same
 * run are refused through the ownership map.
 */
export function createBoundPackageToolOwnership(runtimeBuiltins: Iterable<string>, internalTools: Iterable<string>): BoundPackageToolOwnership {
	return {
		occupiedToolNames: new Set([...runtimeBuiltins, ...CORE_RUNTIME_OWNED_TOOLS, ...ACTIVE_BOUND_INTERNAL_RESERVED_TOOLS, ...internalTools]),
		packageToolOwners: new Map(),
	};
}

const ALLOWED_PACKAGE_EVENTS = new Set(["session_start", "session_shutdown", "tool_result"]);
const ALWAYS_DENIED_METHODS = new Set(["registerProvider", "unregisterProvider", "setModel", "setThinkingLevel"]);
const NOOP_METHODS = new Set([
	"registerCommand", "registerShortcut", "registerFlag", "registerMessageRenderer", "registerMarkdownTransformer",
	"registerEntryRenderer", "sendMessage", "appendEntry", "setSessionName", "setLabel",
]);
const SAFE_PACKAGE_METHODS = new Set(["getFlag", "getActiveTools", "getAllTools", "getCommands", "getSessionName", "getThinkingLevel"]);
const POST_BARRIER_MUTATORS = new Set(["unregisterTool", "setActiveTools"]);
const SAFE_CONTEXT_METHODS = new Set(["isIdle", "isProjectTrusted", "hasPendingMessages", "getContextUsage", "getSystemPrompt", "getSystemPromptOptions"]);
/** The child's own session id lets a package read its bindings; no other session method is reachable. */
const SAFE_SESSION_MANAGER_METHODS = new Set(["getSessionId"]);

function immutableDetachedView(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
	if (!value || typeof value !== "object") return value;
	const existing = seen.get(value);
	if (existing) return existing;
	const clone: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : Object.create(null) as Record<string, unknown>;
	seen.set(value, clone);
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "function") (clone as Record<string, unknown>)[key] = immutableDetachedView(entry, seen);
	}
	return Object.freeze(clone);
}

export function createBoundPackageApi(pi: ExtensionAPI, ownership: BoundPackageToolOwnership, options: BoundPackageApiOptions): ExtensionAPI {
	const owner = Symbol("bound-package-factory");
	const deny = (operation: string): never => {
		const violation = new BoundPackageViolation(operation);
		options.onViolation(violation);
		throw violation;
	};

	const opaqueFacade = <T extends object>(source: T, resolve: (property: PropertyKey) => unknown): T => new Proxy(Object.create(null) as object, {
		get: (_target, property) => resolve(property),
		has: (_target, property) => property in source,
		ownKeys: () => Reflect.ownKeys(source),
		getOwnPropertyDescriptor: (_target, property) => property in source
			? { configurable: true, enumerable: Reflect.getOwnPropertyDescriptor(source, property)?.enumerable ?? true, writable: false, value: resolve(property) }
			: undefined,
		getPrototypeOf: () => null,
		set: () => deny("set"),
		defineProperty: () => deny("defineProperty"),
		deleteProperty: () => deny("deleteProperty"),
		setPrototypeOf: () => deny("setPrototypeOf"),
		preventExtensions: () => deny("preventExtensions"),
	}) as T;

	const restrictedSessionManager = (sessionManager: object): object => opaqueFacade(sessionManager, (property) => {
		const value = Reflect.get(sessionManager, property);
		if (typeof value === "function") return typeof property === "string" && SAFE_SESSION_MANAGER_METHODS.has(property) ? value.bind(sessionManager) : () => deny(`ctx.sessionManager.${String(property)}`);
		return immutableDetachedView(value);
	});

	const restrictedContext = (ctx: ExtensionContext): ExtensionContext => {
		const deniedRegistry = opaqueFacade(Object.create(null) as object, () => () => deny("modelRegistry"));
		return opaqueFacade(ctx, (property) => {
			if (property === "modelRegistry") return deniedRegistry;
			if (property === "sessionManager") {
				const sessionManager = Reflect.get(ctx, property);
				return sessionManager && typeof sessionManager === "object" ? restrictedSessionManager(sessionManager) : sessionManager;
			}
			if (property === "model" || property === "scopedModels") return immutableDetachedView(Reflect.get(ctx, property));
			if (property === "getModel") return () => immutableDetachedView((ctx as ExtensionContext & { getModel?: () => unknown }).getModel?.());
			const value = Reflect.get(ctx, property);
			if (typeof value === "function") return typeof property === "string" && SAFE_CONTEXT_METHODS.has(property) ? value.bind(ctx) : () => deny(`ctx.${String(property)}`);
			return immutableDetachedView(value);
		});
	};

	const wrapTool = (tool: unknown): unknown => {
		if (!tool || typeof tool !== "object") return tool;
		const candidate = tool as Record<string, unknown>;
		if (typeof candidate.execute !== "function") return tool;
		const execute = candidate.execute as (...args: unknown[]) => unknown;
		return {
			...candidate,
			execute(...args: unknown[]) {
				if (args[4] && typeof args[4] === "object") args[4] = restrictedContext(args[4] as ExtensionContext);
				return execute.apply(candidate, args);
			},
		};
	};

	return opaqueFacade(pi, (property) => {
		if (typeof property !== "string") return undefined;
		if (property === "events" && options.events) return options.events;
		if (ALWAYS_DENIED_METHODS.has(property)) return () => deny(property);
		if (NOOP_METHODS.has(property)) return () => undefined;
		if (property === "on") return (event: string, handler: (...args: unknown[]) => unknown) => {
			if (event === "input" && options.allowInputRegistrationNoop && !options.barrierCommitted()) return undefined;
			if (!ALLOWED_PACKAGE_EVENTS.has(event)) return deny(`on:${event}`);
			if (options.barrierCommitted()) return deny(`on:${event}:after-barrier`);
			const wrapped = (value: unknown, ctx: ExtensionContext) => handler(value, restrictedContext(ctx));
			return (pi.on as unknown as (name: string, callback: (...args: unknown[]) => unknown) => unknown)(event, wrapped as (...args: unknown[]) => unknown);
		};
		if (property === "registerTool") return (tool: unknown) => {
			if (options.barrierCommitted()) return deny("registerTool:after-barrier");
			const name = tool && typeof tool === "object" ? (tool as { name?: unknown }).name : undefined;
			if (typeof name !== "string" || !name) return deny("registerTool:unnamed");
			if (ownership.occupiedToolNames.has(name) && ownership.packageToolOwners.get(name) !== owner) return deny(`registerTool:${name}`);
			const result = (pi.registerTool as unknown as (value: unknown) => unknown)(wrapTool(tool));
			ownership.occupiedToolNames.add(name);
			ownership.packageToolOwners.set(name, owner);
			return result;
		};
		if (POST_BARRIER_MUTATORS.has(property)) return (...args: unknown[]) => {
			if (options.barrierCommitted()) return deny(`${property}:after-barrier`);
			const fn = Reflect.get(pi, property);
			return typeof fn === "function" ? fn.apply(pi, args) : undefined;
		};
		const value = Reflect.get(pi, property);
		if (typeof value === "function") return SAFE_PACKAGE_METHODS.has(property) ? value.bind(pi) : () => deny(property);
		return immutableDetachedView(value);
	});
}
