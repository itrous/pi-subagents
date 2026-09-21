import * as fs from "node:fs";
import { MCP_DIRECT_TOOLS_ENV } from "../runs/shared/child-launch.ts";
import { resolveMcpDirectToolResolution } from "../runs/shared/mcp-direct-tool-allowlist.ts";
import {
	createDefaultChildSessionFactory, type ChildSession, type ChildSessionExtensionError, type ChildSessionFactory,
	type ChildSessionLaunch, type PiCodingAgentModule,
} from "../runs/shared/child-session.ts";
import { recheckBoundLaunch } from "./bound-launch-recheck.ts";
import { boundPackageFactoriesHook, loadBoundPackageFactories } from "./bound-package-loader.ts";
import { createBoundRunHook } from "./bound-run-hooks.ts";
import { boundRunIdOf, getBoundRunRegistry, type BoundRunFailure, type BoundRunRecord, type BoundRunRegistryV1 } from "./bound-run-registry.ts";
import { installBoundStreamBarrier, snapshotBoundToolRegistry, type BoundBarrierRefusal, type BoundStreamBarrier } from "./bound-stream-barrier.ts";

/**
 * Bound children get their own upper bound on `session_shutdown` (the upstream
 * default is 5 000 ms): the cancel deadline promised to the client is the port's
 * hard timer plus this value.
 */
export const BOUND_CHILD_SHUTDOWN_TIMEOUT_MS = 2_000;
export const BOUND_CHILD_REFUSED_TEXT = "pi-subagents bound leaf: the child session was refused before any model call.";

/** Collectors the bound child factory wires into every run; the capability requires both. */
export const BOUND_CHILD_FACTORY_PROOFS = Object.freeze({ toolRegistry: true, deniedTools: true });

type AgentSession = Awaited<ReturnType<PiCodingAgentModule["createAgentSession"]>>["session"];

export interface BoundChildSessionFactoryOptions {
	/** Test seam; production loads the host's in-process Pi module like the upstream factory. */
	loadPiCodingAgent?: () => Promise<PiCodingAgentModule>;
	shutdownTimeoutMs?: number;
	registry?: BoundRunRegistryV1;
	/** Test seam for the D10 gate. */
	processCwd?: () => string;
	/**
	 * Test seams for the positive controls of step Sh2 only: no env restoration
	 * at all, and a proxy that does not capture the session. Production never
	 * sets them.
	 */
	envRestore?: "window" | "none";
	captureSession?: boolean;
}

/**
 * MCP_DIRECT_TOOLS window (decision D2). Upstream applies `launch.processEnv`
 * inside its serialized `open()`; the accessor records the previous value at
 * exactly that moment, so a window that was still open for another launch when
 * this `create()` began is never mistaken for the process baseline. Restoring is
 * idempotent and happens at the first of: the end of the wrapped
 * `bindExtensions`, a failure at any point `open()` passes after the env was
 * applied, or the `finally` around `create()`.
 */
function createEnvWindow(value: string): { processEnv: Record<string, string>; restore(): void } {
	let snapshot: { had: boolean; value: string | undefined } | undefined;
	let restored = false;
	const processEnv: Record<string, string> = {};
	Object.defineProperty(processEnv, MCP_DIRECT_TOOLS_ENV, {
		enumerable: true,
		get() {
			snapshot ??= { had: Object.hasOwn(process.env, MCP_DIRECT_TOOLS_ENV), value: process.env[MCP_DIRECT_TOOLS_ENV] };
			return value;
		},
	});
	return {
		processEnv,
		restore() {
			if (!snapshot || restored) return;
			restored = true;
			if (snapshot.had && snapshot.value !== undefined) process.env[MCP_DIRECT_TOOLS_ENV] = snapshot.value;
			else delete process.env[MCP_DIRECT_TOOLS_ENV];
		},
	};
}

/**
 * Proxy over the real Pi module (decision D1): every member `open()` calls after
 * the env was applied restores the window when it throws, and the created
 * session is captured so `bindExtensions` can be shadowed.
 */
function boundPiModule(pi: PiCodingAgentModule, hooks: { restore(): void; onSession(session: AgentSession): void }): PiCodingAgentModule {
	const guarded = <A extends unknown[], R>(fn: (...args: A) => R, self: unknown) => (...args: A): R => {
		try { return fn.apply(self, args); } catch (error) { hooks.restore(); throw error; }
	};
	class BoundResourceLoader extends pi.DefaultResourceLoader {
		override async reload(...args: Parameters<InstanceType<PiCodingAgentModule["DefaultResourceLoader"]>["reload"]>): Promise<void> {
			try { await super.reload(...args); } catch (error) { hooks.restore(); throw error; }
		}

		// Read by open() right after reload (required-extension check, provider flush).
		override getExtensions(...args: Parameters<InstanceType<PiCodingAgentModule["DefaultResourceLoader"]>["getExtensions"]>): ReturnType<InstanceType<PiCodingAgentModule["DefaultResourceLoader"]>["getExtensions"]> {
			try { return super.getExtensions(...args); } catch (error) { hooks.restore(); throw error; }
		}
	}
	const sessionManager = new Proxy(pi.SessionManager, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver) as unknown;
			return typeof value === "function" && (property === "open" || property === "create" || property === "inMemory")
				? guarded(value as (...args: unknown[]) => unknown, target)
				: value;
		},
	});
	const resolveCliModel: PiCodingAgentModule["resolveCliModel"] = (input) => {
		const resolved = guarded(pi.resolveCliModel, pi)(input);
		// `open()` throws on a returned error itself, outside any proxied call.
		if (resolved.error) hooks.restore();
		return resolved;
	};
	const createAgentSession: PiCodingAgentModule["createAgentSession"] = async (input) => {
		let created: Awaited<ReturnType<PiCodingAgentModule["createAgentSession"]>>;
		try { created = await pi.createAgentSession(input); } catch (error) { hooks.restore(); throw error; }
		hooks.onSession(created.session);
		return created;
	};
	return { ...pi, DefaultResourceLoader: BoundResourceLoader, SessionManager: sessionManager, resolveCliModel, createAgentSession };
}

/**
 * The window value for the effective direct tools only. The recheck already tied
 * `launch.runtime.mcpDirectTools` to `contract.mcpDirectTools`, the names left
 * after a capability ceiling; each name is mapped back to its own `server/tool`
 * selector through the same upstream resolution the tool plan used. A foreground
 * launch carries no `processEnv` (upstream sets it for the runner host only), so
 * the value cannot be taken from the launch. Undefined when a name no longer
 * resolves.
 */
function effectiveMcpWindow(record: BoundRunRecord): string | undefined {
	const { contract, agent } = record.launch;
	if (contract.mcpDirectTools.length === 0) return "__none__";
	let resolution: ReturnType<typeof resolveMcpDirectToolResolution>;
	try { resolution = resolveMcpDirectToolResolution(agent.mcpDirectTools, contract.canonicalCwd); } catch { return undefined; }
	if (resolution.unresolvedSelectors.length > 0) return undefined;
	const selectorByName = new Map(resolution.selections.map((selection) => [selection.name, selection.selector]));
	const selectors = contract.mcpDirectTools.map((name) => selectorByName.get(name));
	return selectors.every((selector): selector is string => typeof selector === "string") ? selectors.join(",") : undefined;
}

function refusalFailure(refusal: BoundBarrierRefusal): BoundRunFailure {
	if (refusal.reason === "tool_registry_mismatch") return { status: "native_tool_registry_mismatch", toolsMissing: refusal.missing, toolsExtra: refusal.extra };
	return { status: "native_tool_registry_mismatch", toolRegistryError: refusal.reason };
}

/** The upstream launch with the bound layer's edits; the recheck already passed on the original. */
function boundLaunch(launch: ChildSessionLaunch, extra: { hooks: ChildSessionLaunch["hooks"]; processEnv: Record<string, string>; onExtensionError: NonNullable<ChildSessionLaunch["onExtensionError"]> }): ChildSessionLaunch {
	return {
		...launch,
		// Attested `package:` and relative refs leave the path list; their factories
		// run through the package hook instead of Pi's unchecked loader.
		extensionPaths: [],
		requiredExtensions: [],
		hooks: extra.hooks,
		processEnv: extra.processEnv,
		onExtensionError: extra.onExtensionError,
	};
}

/**
 * Decorator of `ChildSessionFactory` for exactly one bound run. Before the base
 * factory: recheck, D10 gate, package loading. Inside the base factory's
 * `open()`: env window, registry snapshot, and the stream barrier. Anything that
 * fails records the run's failure and rejects `create()` without a model call.
 */
export function createBoundChildSessionFactory(input: { runId: string; expectedRunId: string }, options: BoundChildSessionFactoryOptions = {}): ChildSessionFactory {
	const registry = options.registry ?? getBoundRunRegistry();
	const loadPi = options.loadPiCodingAgent ?? (() => import("@earendil-works/pi-coding-agent"));
	const processCwd = options.processCwd ?? (() => fs.realpathSync(process.cwd()));
	let base: ChildSessionFactory | undefined;
	let used = false;

	const refuse = (record: BoundRunRecord | undefined, failure: BoundRunFailure): Error => {
		record?.registry.fail(failure);
		return new Error(BOUND_CHILD_REFUSED_TEXT);
	};

	return {
		async create(launch) {
			const record = registry.get(input.runId);
			if (!record || input.runId !== input.expectedRunId || used) throw refuse(record, { status: "unavailable_context", toolRegistryError: "launch_contract_mismatch" });
			used = true;
			const { contract } = record.launch;
			if (!recheckBoundLaunch(launch, record.launch).ok) throw refuse(record, { status: "unavailable_context", toolRegistryError: "launch_contract_mismatch" });
			// D10 (probe P1, outcome B): pi-mcp-adapter reads its early config from
			// `process.cwd()`, so the direct-tool set is incomplete at the barrier
			// whenever that differs from the leaf cwd.
			let cwd: string | undefined;
			try { cwd = processCwd(); } catch { cwd = undefined; }
			if (contract.mcpDirectTools.length > 0 && cwd !== contract.canonicalCwd) throw refuse(record, { status: "unavailable_context", toolRegistryError: "mcp_cwd_mismatch" });
			const loaded = await loadBoundPackageFactories(record.launch.packageAttestations);
			if (!loaded.ok) throw refuse(record, { status: "unavailable_context", toolRegistryError: loaded.code });

			let barrier: BoundStreamBarrier | undefined;
			let committed = false;
			let bindWrapped = false;
			const closeRun = (failure: BoundRunFailure): void => {
				record.registry.fail(failure);
				barrier?.refuseAlways({ reason: "tool_registry_mismatch", missing: [], extra: [] });
			};
			const expectation = {
				toolNames: contract.toolRegistry.projection.required,
				model: contract.model,
				api: contract.toolRegistry.modelApi,
			};
			const windowValue = effectiveMcpWindow(record);
			if (windowValue === undefined) throw refuse(record, { status: "unavailable_context", toolRegistryError: "launch_contract_mismatch" });
			const window = createEnvWindow(windowValue);
			const envWindow = options.envRestore === "none" ? { processEnv: window.processEnv, restore: () => {} } : window;
			const commitBarrier = (session: AgentSession): void => {
				const snapshot = snapshotBoundToolRegistry(session, { required: contract.toolRegistry.projection.required, internalTools: contract.toolRegistry.projection.internalTools });
				if (snapshot.projection) record.registry.recordProjection(snapshot.projection);
				barrier = installBoundStreamBarrier(session.agent, expectation, (refusal) => record.registry.fail(refusalFailure(refusal)));
				if (!barrier) {
					record.registry.fail({ status: "native_tool_registry_mismatch", toolRegistryError: "barrier_unavailable" });
					throw new Error(BOUND_CHILD_REFUSED_TEXT);
				}
				if (!snapshot.ok) {
					record.registry.fail({ status: "native_tool_registry_mismatch", toolsMissing: snapshot.missing, toolsExtra: snapshot.extra });
					barrier.refuseAlways({ reason: "tool_registry_mismatch", missing: snapshot.missing, extra: snapshot.extra });
				}
				// A package failure recorded while the extensions loaded closes the run too.
				if (record.registry.failure) barrier.refuseAlways({ reason: "tool_registry_mismatch", missing: [], extra: [] });
				committed = true;
			};
			const onSession = (session: AgentSession): void => {
				if (options.captureSession === false) return;
				const original = session.bindExtensions.bind(session);
				session.bindExtensions = async (bindings) => {
					try { await original(bindings); } finally { envWindow.restore(); }
					commitBarrier(session);
				};
				bindWrapped = true;
			};
			const hooks: ChildSessionLaunch["hooks"] = [
				createBoundRunHook({ runId: record.runId, registry, allowedTools: contract.toolRegistry.projection.required }),
				...(loaded.factories.length > 0 ? [boundPackageFactoriesHook(loaded.factories, {
					runtimeBuiltins: contract.toolRegistry.runtimeBuiltins.names,
					internalTools: contract.toolRegistry.projection.internalTools,
					barrierCommitted: () => committed,
					onViolation: () => closeRun({ status: "native_tool_registry_mismatch", toolRegistryError: "package_mutation" }),
					onFactoryError: () => closeRun({ status: "unavailable_context", toolRegistryError: "package_load_error" }),
				})] : []),
				...launch.hooks,
			];
			const upstreamOnError = launch.onExtensionError;
			const onExtensionError = (error: ChildSessionExtensionError): void => {
				// Both are reported immediately before `open()` throws; restore first, so a
				// throwing upstream callback cannot skip it.
				if (error.event === "inherit_provider" || error.event === "refresh_providers") envWindow.restore();
				upstreamOnError?.(error);
			};
			base = createDefaultChildSessionFactory({
				loadPiCodingAgent: async () => boundPiModule(await loadPi(), { restore: envWindow.restore, onSession }),
				shutdownTimeoutMs: options.shutdownTimeoutMs ?? BOUND_CHILD_SHUTDOWN_TIMEOUT_MS,
			});
			// The pre-work above awaits; a run settled meanwhile gets no session at all.
			if (record.settled || registry.get(record.runId) !== record) throw refuse(record, { status: "unavailable_context", toolRegistryError: "launch_contract_mismatch" });
			let child: ChildSession;
			try { child = await base.create(boundLaunch(launch, { hooks, processEnv: envWindow.processEnv, onExtensionError })); }
			// D2 (c): the last safety net; the window normally closed inside open().
			finally { envWindow.restore(); }
			if (!bindWrapped || !committed) {
				record.registry.fail({ status: "native_tool_registry_mismatch", toolRegistryError: "barrier_unavailable" });
				await child.dispose();
				throw new Error(BOUND_CHILD_REFUSED_TEXT);
			}
			// A cancel can settle the run while the session was being created: that child
			// belongs to nobody, so it is disposed here and never handed to the executor.
			if (!registry.attachChild(record.runId, child)) {
				await child.dispose();
				throw new Error(BOUND_CHILD_REFUSED_TEXT);
			}
			return child;
		},
		async dispose() {
			await base?.dispose();
		},
	};
}

let foregroundFactoryOptions: BoundChildSessionFactoryOptions = {};

/**
 * Replace the options of the factories T2 builds, like `setChildSessionFactory`
 * upstream: tier-1 tests install a fake Pi module; undefined restores the
 * production defaults.
 */
export function setBoundForegroundChildSessionFactoryOptions(options: BoundChildSessionFactoryOptions | undefined): void {
	foregroundFactoryOptions = options ?? {};
}

/** T2 and T3 select public targets through the same registry check. */
export { isPrivateBoundRun, publicBoundStatusState } from "./bound-run-registry.ts";

/** T2: a marked launch runs under the contract's `prospectiveRunId` (decision D4). */
export function boundForegroundRunId(params: unknown): string | undefined {
	return boundRunIdOf(params);
}

/** T2: history writers skip every marked launch (decision D5). */
export function isBoundForegroundLaunch(params: unknown): boolean {
	return boundRunIdOf(params) !== undefined;
}

/**
 * T2: undefined for a non-bound launch, so `compactOptional` drops the field and
 * the upstream call stays as it was (I4.14). A marked launch always gets the
 * decorator, which refuses when the run id does not match its record.
 */
export function boundForegroundChildSessionFactory(params: unknown, input: { runId: string }): ChildSessionFactory | undefined {
	const runId = boundRunIdOf(params);
	return runId === undefined ? undefined : createBoundChildSessionFactory({ runId, expectedRunId: input.runId }, foregroundFactoryOptions);
}
