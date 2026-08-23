import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire, Module } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION as PI_RUNTIME_VERSION } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti/static";
import { cloneJsonWithinByteLimit } from "../../slash/delegation-json.ts";
import { attestBoundRuntimeExtensions } from "./bound-runtime-evidence.ts";
import { packageTreeEvidence } from "./package-tree-evidence.ts";
import {
	TOOL_REGISTRY_MAX_PAYLOAD_BYTES,
	encodeToolRegistryFrame,
	extractProviderPayloadToolNames,
	sortToolRegistryNames,
	toolRegistryProjection,
	validateBoundToolRegistryPolicy,
	type BoundToolRegistryPolicyV1,
	type ToolRegistryChildFrameV1,
} from "./tool-registry-proof.ts";

export const BOUND_TOOL_REGISTRY_ACTIVE_ENV = "PI_SUBAGENT_TOOL_REGISTRY_ACTIVE";
export const BOUND_TOOL_REGISTRY_POLICY_ENV = "PI_SUBAGENT_TOOL_REGISTRY_POLICY";
export const BOUND_TOOL_REGISTRY_FD_ENV = "PI_SUBAGENT_TOOL_REGISTRY_FD";
export const BOUND_TOOL_REGISTRY_HOST_NODE_MODULES_ENV = "PI_SUBAGENT_TOOL_REGISTRY_HOST_NODE_MODULES";
export const BOUND_TOOL_REGISTRY_MISMATCH_EXIT = 78;
export const BOUND_PACKAGE_MUTATION_EXIT = 76;
const writeProofBytes = fs.writeSync.bind(fs);
const closeProofFd = fs.closeSync.bind(fs);

interface RuntimeState {
	policy: BoundToolRegistryPolicyV1;
	fd: number;
	frameWritten: boolean;
	barrierCommitted: boolean;
	denialCalls: import("./denied-tool-proof.ts").DeniedToolCallV1[];
	denialOverflow: boolean;
	denialWritten: boolean;
	restoreResolver?: () => void;
	allowInputRegistrationNoop?: boolean;
	exit: (code: number) => never;
}
const runtimeHolder = createRequire(import.meta.url)("./bound-tool-registry-state.cjs") as { state?: RuntimeState };

export function initializeBoundToolRegistryBootstrap(): void {
	const active = process.env[BOUND_TOOL_REGISTRY_ACTIVE_ENV];
	const encoded = process.env[BOUND_TOOL_REGISTRY_POLICY_ENV];
	const fdText = process.env[BOUND_TOOL_REGISTRY_FD_ENV];
	delete process.env[BOUND_TOOL_REGISTRY_ACTIVE_ENV];
	delete process.env[BOUND_TOOL_REGISTRY_POLICY_ENV];
	delete process.env[BOUND_TOOL_REGISTRY_FD_ENV];
	if (active !== "1") return;
	if (!encoded || !fdText || !/^[1-9][0-9]*$/u.test(fdText) || Number(fdText) < 3) process.exit(BOUND_TOOL_REGISTRY_MISMATCH_EXIT);
	let parsed: unknown;
	try { parsed = JSON.parse(encoded!); } catch { process.exit(BOUND_TOOL_REGISTRY_MISMATCH_EXIT); }
	const policy = validateBoundToolRegistryPolicy(parsed);
	if (!policy) process.exit(BOUND_TOOL_REGISTRY_MISMATCH_EXIT);
	runtimeHolder.state = { policy, fd: Number(fdText), frameWritten: false, barrierCommitted: false, denialCalls: [], denialOverflow: false, denialWritten: false, exit: process.exit.bind(process) };
}

function writeFrame(frame: ToolRegistryChildFrameV1): void {
	if (!runtimeHolder.state || runtimeHolder.state.frameWritten) return;
	let encoded = encodeToolRegistryFrame({ ...frame, proofNonce: runtimeHolder.state.policy.proofNonce });
	if (!encoded) encoded = encodeToolRegistryFrame({ version: 1, kind: "unrepresentable", code: "frame_too_large", proofNonce: runtimeHolder.state.policy.proofNonce })!;
	runtimeHolder.state.frameWritten = true;
	try { writeProofBytes(runtimeHolder.state.fd, encoded, undefined, "utf8"); } finally { try { closeProofFd(runtimeHolder.state.fd); } catch {} }
}

function protocolExit(frame: ToolRegistryChildFrameV1): never {
	runtimeHolder.state?.restoreResolver?.();
	writeFrame(frame);
	return runtimeHolder.state!.exit(BOUND_TOOL_REGISTRY_MISMATCH_EXIT);
}
function packageMutationExit(): never { return runtimeHolder.state!.exit(BOUND_PACKAGE_MUTATION_EXIT); }

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

function opaqueFacade<T extends object>(source: T, resolve: (property: PropertyKey) => unknown): T {
	const target = Object.create(null) as object;
	return new Proxy(target, {
		get: (_target, property) => resolve(property),
		has: (_target, property) => property in source,
		ownKeys: () => Reflect.ownKeys(source),
		getOwnPropertyDescriptor: (_target, property) => property in source
			? { configurable: true, enumerable: Reflect.getOwnPropertyDescriptor(source, property)?.enumerable ?? true, writable: false, value: resolve(property) }
			: undefined,
		getPrototypeOf: () => null,
		set: packageMutationExit,
		defineProperty: packageMutationExit,
		deleteProperty: packageMutationExit,
		setPrototypeOf: packageMutationExit,
		preventExtensions: packageMutationExit,
	}) as T;
}

const SAFE_CONTEXT_METHODS = new Set(["isIdle", "isProjectTrusted", "hasPendingMessages", "getContextUsage", "getSystemPrompt", "getSystemPromptOptions"]);
function restrictedContext(ctx: ExtensionContext): ExtensionContext {
	const deniedRegistry = opaqueFacade(Object.create(null) as object, () => packageMutationExit);
	return opaqueFacade(ctx, (property) => {
		if (property === "modelRegistry") return deniedRegistry;
		if (property === "model" || property === "scopedModels") return immutableDetachedView(Reflect.get(ctx, property));
		if (property === "getModel") return () => immutableDetachedView((ctx as ExtensionContext & { getModel?: () => unknown }).getModel?.());
		const value = Reflect.get(ctx, property);
		if (typeof value === "function") return typeof property === "string" && SAFE_CONTEXT_METHODS.has(property) ? value.bind(ctx) : packageMutationExit;
		return immutableDetachedView(value);
	});
}

const ALLOWED_PACKAGE_EVENTS = new Set(["session_start", "session_shutdown", "tool_result"]);
const ALWAYS_DENIED_METHODS = new Set([
	"registerProvider", "unregisterProvider", "setModel", "setThinkingLevel",
]);
const NOOP_METHODS = new Set(["registerCommand", "registerShortcut", "registerFlag", "registerMessageRenderer", "registerMarkdownTransformer", "registerEntryRenderer", "sendMessage", "appendEntry", "setSessionName", "setLabel"]);
const SAFE_PACKAGE_METHODS = new Set(["getFlag", "getActiveTools", "getAllTools", "getCommands", "getSessionName", "getThinkingLevel"]);
const POST_BARRIER_MUTATORS = new Set(["registerTool", "unregisterTool", "setActiveTools"]);

function wrapTool(tool: unknown): unknown {
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
}

export function createBoundPackageApi(pi: ExtensionAPI): ExtensionAPI {
	// Supported Pi 0.84.1/0.84.2 expose this exact builtin registry. Protect it and
	// runtime-owned internal tools without calling action APIs during extension load.
	const occupiedToolNames = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", ...(runtimeHolder.state?.policy.internalTools ?? [])]);
	return opaqueFacade(pi, (property) => {
		if (typeof property !== "string") return undefined;
		if (ALWAYS_DENIED_METHODS.has(property)) return packageMutationExit;
		if (NOOP_METHODS.has(property)) return () => undefined;
		if (property === "on") return (event: string, handler: (...args: unknown[]) => unknown) => {
			if (event === "input" && runtimeHolder.state?.allowInputRegistrationNoop && !runtimeHolder.state.barrierCommitted) return undefined;
			if (!ALLOWED_PACKAGE_EVENTS.has(event) || runtimeHolder.state?.barrierCommitted) packageMutationExit();
			const wrapped = ((value: unknown, ctx: ExtensionContext) => handler(value, restrictedContext(ctx))) as unknown as (...args: unknown[]) => unknown;
			return (pi.on as unknown as (name: string, callback: (...args: unknown[]) => unknown) => unknown)(event, wrapped);
		};
		if (property === "registerTool") return (tool: unknown) => {
			if (runtimeHolder.state?.barrierCommitted) packageMutationExit();
			const name = tool && typeof tool === "object" ? (tool as { name?: unknown }).name : undefined;
			if (typeof name !== "string" || !name || occupiedToolNames.has(name)) packageMutationExit();
			const result = (pi.registerTool as unknown as (value: unknown) => unknown)(wrapTool(tool));
			occupiedToolNames.add(name);
			return result;
		};
		if (POST_BARRIER_MUTATORS.has(property)) return (...args: unknown[]) => {
			if (runtimeHolder.state?.barrierCommitted) packageMutationExit();
			const fn = Reflect.get(pi, property);
			return typeof fn === "function" ? fn.apply(pi, args) : undefined;
		};
		const value = Reflect.get(pi, property);
		if (typeof value === "function") return SAFE_PACKAGE_METHODS.has(property) ? value.bind(pi) : packageMutationExit;
		return immutableDetachedView(value);
	});
}

function within(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function installPackageResolutionGuard(roots: readonly string[], deniedPaths: ReadonlySet<string>): void {
	if (!runtimeHolder.state || roots.length === 0) return;
	const measured = (target: string): boolean => roots.some((root) => {
		if (!within(root, target)) return false;
		return !path.relative(root, target).split(path.sep).includes("node_modules");
	});
	const moduleInternals = Module as unknown as { _resolveFilename: (request: string, parent: { filename?: string } | undefined, isMain?: boolean, options?: unknown) => unknown };
	const original = moduleInternals._resolveFilename;
	moduleInternals._resolveFilename = function (request, parent, isMain, options) {
		const resolved = original.call(this, request, parent, isMain, options); const parentFilename = parent?.filename;
		if (typeof parentFilename === "string" && measured(parentFilename)
			&& typeof resolved === "string" && path.isAbsolute(resolved) && (deniedPaths.has(path.resolve(resolved)) || !measured(resolved))) {
			throw new Error("Package factory import escaped its attested resolution roots.");
		}
		return resolved;
	};
	runtimeHolder.state.restoreResolver = () => { moduleInternals._resolveFilename = original; };
}

function verifyPackageEvidence(): string[] {
	if (!runtimeHolder.state) return [];
	try {
		const byRoot = new Map<string, (typeof runtimeHolder.state.policy.packageExtensions)[number]>();
		for (const attestation of runtimeHolder.state.policy.packageExtensions) {
			const prior = byRoot.get(attestation.evidenceRoot);
			if ((prior && (prior.evidenceRootDigest !== attestation.evidenceRootDigest || prior.packageTreeDigest !== attestation.packageTreeDigest))
				|| createHash("sha256").update(attestation.evidenceRoot).digest("hex") !== attestation.evidenceRootDigest
				|| fs.realpathSync(attestation.evidenceRoot) !== attestation.evidenceRoot || !within(attestation.evidenceRoot, attestation.path)) throw new Error("package bytes drift");
			byRoot.set(attestation.evidenceRoot, attestation);
		}
		const resolutionRoots = new Set<string>();
		for (const attestation of byRoot.values()) {
			const evidence = packageTreeEvidence(attestation.path, attestation.evidenceRoot);
			if (evidence.digest !== attestation.packageTreeDigest) throw new Error("package bytes drift");
			for (const root of evidence.roots) resolutionRoots.add(root);
		}
		return [...resolutionRoots];
	} catch { protocolExit({ version: 1, kind: "protocol", code: "package_bytes_drift" }); }
}

function verifyRuntimeEvidence(): ReturnType<typeof attestBoundRuntimeExtensions> {
	const sharedDir = path.dirname(fileURLToPath(import.meta.url));
	const runtimeEvidence = attestBoundRuntimeExtensions([
		path.join(sharedDir, "bound-tool-registry-bootstrap.ts"),
		path.join(sharedDir, "subagent-prompt-runtime.ts"),
		path.join(sharedDir, "bound-package-mediator.ts"),
		path.join(sharedDir, "bound-tool-registry-gate.ts"),
	]);
	if (!runtimeHolder.state || JSON.stringify(runtimeEvidence) !== JSON.stringify(runtimeHolder.state.policy.runtimeExtensions)) {
		protocolExit({ version: 1, kind: "protocol", code: "runtime_bytes_drift" });
	}
	return runtimeEvidence;
}

export async function loadBoundPackageFactories(pi: ExtensionAPI): Promise<void> {
	if (!runtimeHolder.state) return;
	const mediated = createBoundPackageApi(pi);
	const hostNm = process.env[BOUND_TOOL_REGISTRY_HOST_NODE_MODULES_ENV];
	delete process.env[BOUND_TOOL_REGISTRY_HOST_NODE_MODULES_ENV];
	const peerAlias: Record<string, string> = {};
	const peerDirs: string[] = [];
	if (hostNm) {
	 for (const attestation of runtimeHolder.state.policy.packageExtensions) {
	  try {
	   const mf = JSON.parse(fs.readFileSync(path.join(attestation.evidenceRoot, "package.json"), "utf8"));
	   for (const name of Object.keys(mf.peerDependencies ?? {})) {
	    try {
	     const resolved = fs.realpathSync(path.join(hostNm, ...name.split("/")));
	     if (!peerAlias[name]) { peerAlias[name] = resolved; peerDirs.push(resolved); }
	    } catch {}
	   }
	  } catch {}
	 }
	}
 const sharedDir = path.dirname(fileURLToPath(import.meta.url));
	const runtimeEvidence = verifyRuntimeEvidence();
	const evidenceRoots = verifyPackageEvidence();
			try { fs.appendFileSync(process.env.A1POLICY_LOG || "/tmp/a1policy.log", "CHILD roots=" + JSON.stringify(evidenceRoots) + " policyCount=" + runtimeHolder.state.policy.packageExtensions.length + "\n"); } catch {}
const deniedRuntimePaths = new Set(runtimeEvidence.entries.filter((entry) => !entry.name.startsWith("dependency:")).map((entry) => path.join(sharedDir, entry.name)));
	const allowedRoots = [...evidenceRoots, ...peerDirs];
	installPackageResolutionGuard(allowedRoots, deniedRuntimePaths);
	const transformer = createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true, alias: peerAlias });
	const jiti = createJiti(import.meta.url, {
		moduleCache: false, tsconfigPaths: true, tryNative: false, alias: peerAlias,
		transform(options) {
			const __deny = typeof options.filename === "string" && path.isAbsolute(options.filename)
				&& (deniedRuntimePaths.has(path.resolve(options.filename)) || !allowedRoots.some((root) => within(root, options.filename!) && !path.relative(root, options.filename!).split(path.sep).includes("node_modules")));
			if (__deny) { try { fs.appendFileSync(process.env.A1POLICY_LOG || "/tmp/a1policy.log", "ESC " + String(options.filename) + " roots=" + JSON.stringify(evidenceRoots) + "\n"); } catch {} throw new Error("Package factory transform escaped its attested resolution roots."); }
			return { code: transformer.transform(options) };
		},
	});
	for (const attestation of runtimeHolder.state.policy.packageExtensions) {
		let factory: unknown;
		try {
			const stat = fs.lstatSync(attestation.path);
			if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(attestation.path) !== attestation.path
				|| createHash("sha256").update(fs.readFileSync(attestation.path)).digest("hex") !== attestation.contentDigest) throw new Error("attestation drift");
			factory = await jiti.import(attestation.path, { default: true });
		}
		catch (e) { try { fs.appendFileSync(process.env.A1POLICY_LOG || "/tmp/a1policy.log", "LOAD-FAIL " + String(e && (e.stack || e)) + "\n"); } catch {} protocolExit({ version: 1, kind: "protocol", code: "package_load_error" }); }
		if (typeof factory !== "function") protocolExit({ version: 1, kind: "protocol", code: "package_load_error" });
		try {
			const manifest = JSON.parse(fs.readFileSync(path.join(attestation.evidenceRoot, "package.json"), "utf8")) as { name?: unknown };
			runtimeHolder.state!.allowInputRegistrationNoop = manifest.name === "pi-mcp-adapter";
			await factory(mediated);
		}
		catch (e) { try { fs.appendFileSync(process.env.A1POLICY_LOG || "/tmp/a1policy.log", "LOAD-FAIL " + String(e && (e.stack || e)) + "\n"); } catch {} protocolExit({ version: 1, kind: "protocol", code: "package_load_error" }); }
		finally { if (runtimeHolder.state) runtimeHolder.state.allowInputRegistrationNoop = false; }
	}
}

export function boundPiVersionProbeArgs(argv: readonly string[]): string[] {
	return argv[1] && !argv[1].startsWith("-") ? [argv[1], "--version"] : ["--version"];
}

function runningPiVersion(): string | undefined {
	const env = { ...process.env };
	delete env[BOUND_TOOL_REGISTRY_ACTIVE_ENV]; delete env[BOUND_TOOL_REGISTRY_POLICY_ENV]; delete env[BOUND_TOOL_REGISTRY_FD_ENV];
	const probeArgs = boundPiVersionProbeArgs(process.argv);
	const probe = spawnSync(process.execPath, probeArgs, { encoding: "utf8", env, timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
	return probe.status === 0 ? probe.stdout.trim() : undefined;
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
	return true;
}

function enumerableDataCopy(value: object, omitted: ReadonlySet<string>): Record<string, unknown> | undefined {
	const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !descriptor.enumerable) continue;
		if (typeof key !== "string" || !("value" in descriptor)) return undefined;
		if (!omitted.has(key)) Object.defineProperty(output, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true });
	}
	return output;
}

function cloneOutgoingPayload(api: string, payload: unknown): { ok: true; value: unknown } | { ok: false } {
	if (api === "pi-messages") {
		const cloned = cloneJsonWithinByteLimit(payload, TOOL_REGISTRY_MAX_PAYLOAD_BYTES, { ignoreNonEnumerable: true, omitNonJsonProperties: true });
		return cloned.ok ? { ok: true, value: cloned.value } : { ok: false };
	}
	if (api === "google-generative-ai" || api === "google-vertex") {
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false };
		const rootDescriptor = Object.getOwnPropertyDescriptor(payload, "config");
		if (!rootDescriptor || !rootDescriptor.enumerable || !("value" in rootDescriptor)
			|| !rootDescriptor.value || typeof rootDescriptor.value !== "object" || Array.isArray(rootDescriptor.value)) return { ok: false };
		const config = rootDescriptor.value as object;
		const abortDescriptor = Object.getOwnPropertyDescriptor(config, "abortSignal");
		if (abortDescriptor && abortDescriptor.enumerable && !("value" in abortDescriptor)) return { ok: false };
		const abortSignal = abortDescriptor && "value" in abortDescriptor ? abortDescriptor.value : undefined;
		if (abortSignal !== undefined && !(abortSignal instanceof AbortSignal)) return { ok: false };
		const rootCopy = enumerableDataCopy(payload, new Set(["config"]));
		const configCopy = enumerableDataCopy(config, new Set(["abortSignal"]));
		if (!rootCopy || !configCopy) return { ok: false };
		Object.defineProperty(rootCopy, "config", { value: configCopy, enumerable: true, configurable: true, writable: true });
		const cloned = cloneJsonWithinByteLimit(rootCopy, TOOL_REGISTRY_MAX_PAYLOAD_BYTES, { ignoreNonEnumerable: true, omitUndefinedProperties: true });
		if (!cloned.ok || !cloned.value || typeof cloned.value !== "object" || Array.isArray(cloned.value)) return { ok: false };
		if (abortSignal !== undefined) Object.defineProperty((cloned.value as Record<string, unknown>).config as object, "abortSignal", { value: abortSignal, enumerable: true, configurable: true, writable: true });
		return { ok: true, value: cloned.value };
	}
	const cloned = cloneJsonWithinByteLimit(payload, TOOL_REGISTRY_MAX_PAYLOAD_BYTES, { ignoreNonEnumerable: true, omitUndefinedProperties: true });
	return cloned.ok ? { ok: true, value: cloned.value } : { ok: false };
}

export function registerBoundToolRegistryGate(pi: ExtensionAPI): void {
	if (!runtimeHolder.state) return;
	const failStopExit = runtimeHolder.state.exit;
	if (runningPiVersion() !== runtimeHolder.state.policy.piRuntimeVersion || PI_RUNTIME_VERSION !== runtimeHolder.state.policy.piRuntimeVersion) {
		protocolExit({ version: 1, kind: "protocol", code: "runtime_version_drift" });
	}
	pi.on("agent_start", () => { pi.getActiveTools(); });
	(pi.on as unknown as (event: string, handler: (event: { payload?: unknown }, ctx: ExtensionContext) => unknown) => void)("before_provider_request", (event, ctx) => {
		try {
		if (!runtimeHolder.state || runtimeHolder.state.barrierCommitted) return event.payload;
		if (ctx.model?.api !== runtimeHolder.state.policy.modelApi) protocolExit({ version: 1, kind: "protocol", code: "model_api_drift" });
		verifyRuntimeEvidence(); verifyPackageEvidence();
		const cloned = cloneOutgoingPayload(runtimeHolder.state.policy.modelApi, event.payload);
		if (!cloned.ok) protocolExit({ version: 1, kind: "protocol", code: "unsupported_payload_shape" });
		const extracted = extractProviderPayloadToolNames(runtimeHolder.state.policy.modelApi, cloned.value, runtimeHolder.state.policy.required.length);
		if (!extracted.ok) {
			if (extracted.code === "too_many_tools" || extracted.code === "invalid_tool_name") protocolExit({ version: 1, kind: "unrepresentable", code: extracted.code });
			protocolExit({ version: 1, kind: "protocol", code: extracted.code });
		}
		const live = sortToolRegistryNames(pi.getActiveTools());
		if (!sameNames(extracted.names, live)) protocolExit({ version: 1, kind: "protocol", code: "active_registry_drift" });
		const projection = toolRegistryProjection({ required: runtimeHolder.state.policy.required, actual: extracted.names, internalExpected: runtimeHolder.state.policy.internalTools });
		if (!projection) protocolExit({ version: 1, kind: "unrepresentable", code: "invalid_tool_name" });
		writeFrame({ version: 1, kind: "registry", projection });
		runtimeHolder.state.barrierCommitted = true;
		if (!sameNames(extracted.names, runtimeHolder.state.policy.required)) return runtimeHolder.state.exit(BOUND_TOOL_REGISTRY_MISMATCH_EXIT);
		return cloned.value;
		} catch { return failStopExit(BOUND_TOOL_REGISTRY_MISMATCH_EXIT); }
	});
}

export function resetBoundToolRegistryRuntimeForTests(): void { runtimeHolder.state?.restoreResolver?.(); delete runtimeHolder.state; }
