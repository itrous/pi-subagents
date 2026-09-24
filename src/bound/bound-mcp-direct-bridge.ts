import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { computeMcpServerHash } from "../runs/shared/mcp-direct-tool-allowlist.ts";
import { normalizeMcpToolPrefix, planMcpDirectToolGrant, type ResolvedMcpDirectToolSelection } from "../runs/shared/mcp-direct-tool-grant.ts";
import { canonicalSha256 } from "../shared/canonical-json.ts";
import { cloneJsonWithinByteLimit } from "./bound-json.ts";
import {
	BOUND_MCP_ADAPTER_PACKAGE, BOUND_MCP_BRIDGE_RUNTIME_PATH, BOUND_MCP_CONFIG_EXTENSION, BOUND_MCP_PRIVATE_ENTRIES,
	type BoundMcpPrivateEntry,
} from "./bound-mcp-config.ts";
import type { BoundPackageExtensionProjectionV1 } from "./bound-package-extensions.ts";
import { createBoundPackageImporter, verifyBoundPackageAttestations, type BoundPackageAttestation } from "./bound-package-loader.ts";
import { toolDeclarationDigest } from "./bound-transcript.ts";

/**
 * Bound-only MCP bridge (S3 P2, plan D2). The one measured `package:pi-mcp-adapter`
 * record is consumed through exactly two private entries of the pinned adapter
 * build, `server-manager.ts` and `direct-tools.ts`, imported through the bound
 * attested-roots importer. This is an explicit narrow permission for a private,
 * pinned ABI, not a public adapter API: another version, other entry bytes, a
 * symlink or a missing export refuses the launch before any connection.
 *
 * Discovery is fresh for every attempt, instance-scoped (cwd, config, signal) and
 * never touches the adapter's persistent metadata cache, `process.cwd()`,
 * `process.env` or argv. Only explicit `server/tool` selectors become tools.
 */
export const BOUND_MCP_ADAPTER_PIN = Object.freeze({
	name: BOUND_MCP_ADAPTER_PACKAGE,
	version: "2.26.1",
	entryDigests: Object.freeze({
		"server-manager.ts": "dd920670643db7208934eca2fe63b7ba2689e49be2126853c87dfcdbe9591da6",
		"direct-tools.ts": "a1a45b8a329b6f2b97918877b1c6f94cc4bc0336af3df0caaa0fff679d562351",
	} satisfies Record<BoundMcpPrivateEntry, string>),
});

/** Numeric budgets of D2; requirements of the plan, not a measured SLA. */
export const BOUND_MCP_DISCOVERY_BUDGET = Object.freeze({
	discoveryMs: 10_000,
	closeMs: 2_000,
	maxMetadataBytes: 1024 * 1024,
	maxTools: 1024,
	maxPages: 32,
});

export type BoundMcpDiscoveryErrorCode =
	| "mcp_adapter_unverified" | "mcp_discovery_failed" | "mcp_discovery_timeout" | "mcp_metadata_invalid"
	| "mcp_selector_unresolved" | "mcp_discovery_aborted";

interface McpToolLike { name?: unknown; description?: unknown; inputSchema?: unknown }
interface ServerConnectionLike { status: string; tools: McpToolLike[]; toolsRevision?: number }
interface McpServerManagerLike {
	connect(name: string, definition: unknown, signal?: AbortSignal): Promise<ServerConnectionLike>;
	closeAll(): Promise<void>;
	getConnection(name: string): ServerConnectionLike | undefined;
	setMetadataListChangedListener(listener: ((serverName: string, reason: string) => void) | undefined): void;
	setRuntimeSignal(signal: AbortSignal | undefined): void;
	setTraceConfig(settings: { enabled?: boolean } | undefined): void;
}
interface DirectToolSpecLike { serverName: string; originalName: string; prefixedName: string; description: string; inputSchema?: unknown; resourceUri?: string; uiResourceUri?: string }
type DirectToolExecute = (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<unknown>;

export interface BoundMcpAdapterAbi {
	McpServerManager: new (defaultCwd?: string) => McpServerManagerLike;
	resolveDirectTools: (config: unknown, cache: unknown, prefix: string, envOverride?: string[]) => DirectToolSpecLike[];
	createDirectToolExecutor: (getState: () => unknown, getInitPromise: () => unknown, spec: DirectToolSpecLike) => DirectToolExecute;
}

export interface BoundMcpAdapterMeasurement {
	adapterRoot: string;
	entryDigests: Record<BoundMcpPrivateEntry, string>;
}

function sha256(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function within(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function regularFileBytes(file: string, root: string): Buffer | undefined {
	try {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file || !within(root, file)) return undefined;
		return fs.readFileSync(file);
	} catch { return undefined; }
}

/**
 * The single adapter record of the contract, measured: the projection names the
 * pinned package, its entry is the package root's `index.ts`, the manifest there
 * names the same package and version, and both private entries are regular
 * non-symlink files under that root with exactly the pinned bytes.
 */
export function measureBoundMcpAdapter(projection: BoundPackageExtensionProjectionV1, attestation: BoundPackageAttestation): BoundMcpAdapterMeasurement | undefined {
	if (projection.ref !== BOUND_MCP_CONFIG_EXTENSION || attestation.ref !== BOUND_MCP_CONFIG_EXTENSION || projection.kind !== "package"
		|| projection.package?.name !== BOUND_MCP_ADAPTER_PIN.name || projection.package.version !== BOUND_MCP_ADAPTER_PIN.version
		|| projection.contentDigest !== attestation.contentDigest) return undefined;
	const adapterRoot = path.dirname(attestation.path);
	if (path.basename(attestation.path) !== "index.ts" || !within(attestation.evidenceRoot, adapterRoot)) return undefined;
	try { if (fs.realpathSync(adapterRoot) !== adapterRoot) return undefined; } catch { return undefined; }
	const manifestBytes = regularFileBytes(path.join(adapterRoot, "package.json"), adapterRoot);
	if (!manifestBytes) return undefined;
	try {
		const manifest = JSON.parse(manifestBytes.toString("utf8")) as { name?: unknown; version?: unknown };
		if (manifest.name !== BOUND_MCP_ADAPTER_PIN.name || manifest.version !== BOUND_MCP_ADAPTER_PIN.version) return undefined;
	} catch { return undefined; }
	const entryDigests = {} as Record<BoundMcpPrivateEntry, string>;
	for (const entry of BOUND_MCP_PRIVATE_ENTRIES) {
		const bytes = regularFileBytes(path.join(adapterRoot, entry), adapterRoot);
		if (!bytes) return undefined;
		const digest = sha256(bytes);
		if (digest !== BOUND_MCP_ADAPTER_PIN.entryDigests[entry]) return undefined;
		entryDigests[entry] = digest;
	}
	return { adapterRoot, entryDigests };
}

/** `packageEvidenceDigest` of D4: the one adapter projection record, the private entries and the bridge. */
export function boundMcpPackageEvidenceDigest(input: {
	adapter: BoundPackageExtensionProjectionV1;
	entryDigests: Record<BoundMcpPrivateEntry, string>;
	bridge: { runtimePath: typeof BOUND_MCP_BRIDGE_RUNTIME_PATH; contentDigest: string };
}): string {
	return canonicalSha256({ adapter: input.adapter, entryDigests: input.entryDigests, bridge: input.bridge });
}

/**
 * Import the two private entries through the attested-roots guard. The package
 * closure is re-measured first and the entry bytes once more right before the
 * import; anything that is not the expected ABI shape is `undefined`.
 */
export async function loadBoundMcpAdapterAbi(attestation: BoundPackageAttestation, measurement: BoundMcpAdapterMeasurement): Promise<BoundMcpAdapterAbi | undefined> {
	const verified = verifyBoundPackageAttestations([attestation]);
	if (!verified.ok) return undefined;
	const importer = createBoundPackageImporter(verified.roots);
	const namespaces: Record<string, Record<string, unknown>> = {};
	for (const entry of BOUND_MCP_PRIVATE_ENTRIES) {
		const file = path.join(measurement.adapterRoot, entry);
		const bytes = regularFileBytes(file, measurement.adapterRoot);
		if (!bytes || sha256(bytes) !== measurement.entryDigests[entry]) return undefined;
		try {
			const namespace = await importer.importNamespace(file);
			if (!namespace || typeof namespace !== "object") return undefined;
			namespaces[entry] = namespace as Record<string, unknown>;
		} catch { return undefined; }
	}
	const manager = namespaces["server-manager.ts"]!.McpServerManager as BoundMcpAdapterAbi["McpServerManager"] | undefined;
	const resolveDirectTools = namespaces["direct-tools.ts"]!.resolveDirectTools;
	const createDirectToolExecutor = namespaces["direct-tools.ts"]!.createDirectToolExecutor;
	const prototype = typeof manager === "function" ? manager.prototype as Record<string, unknown> : undefined;
	if (!prototype || typeof resolveDirectTools !== "function" || typeof createDirectToolExecutor !== "function"
		|| !["connect", "closeAll", "getConnection", "setMetadataListChangedListener", "setRuntimeSignal", "setTraceConfig"].every((method) => typeof prototype[method] === "function")) return undefined;
	return {
		McpServerManager: manager!,
		resolveDirectTools: resolveDirectTools as BoundMcpAdapterAbi["resolveDirectTools"],
		createDirectToolExecutor: createDirectToolExecutor as BoundMcpAdapterAbi["createDirectToolExecutor"],
	};
}

/** One measured declaration of D4 (`{selector,name,description,inputSchema}`). */
export interface BoundMcpDeclarationV1 {
	selector: string;
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface BoundMcpDiscovery {
	readonly manager: McpServerManagerLike;
	readonly abi: BoundMcpAdapterAbi;
	readonly config: Record<string, unknown>;
	/** Connection objects measured at discovery; a later replacement invalidates the run. */
	readonly connections: ReadonlyMap<string, ServerConnectionLike>;
	readonly specs: readonly DirectToolSpecLike[];
	readonly selections: readonly ResolvedMcpDirectToolSelection[];
	readonly declarations: readonly BoundMcpDeclarationV1[];
	/** True once any selected server announced a changed list (tools/list_changed). */
	invalidated(): boolean;
	/** Subscribe to invalidation; returns the unsubscribe. */
	onInvalidate(listener: () => void): () => void;
	/** Bounded close of every connection this discovery opened: final once it finished, retried otherwise. */
	close(): Promise<"closed" | "timeout" | "failed">;
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function plainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function boundedClose(manager: McpServerManagerLike, timeoutMs: number): Promise<"closed" | "timeout" | "failed"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); timer.unref?.(); });
	const closing = Promise.resolve().then(() => manager.closeAll()).then(() => "closed" as const, () => "failed" as const);
	return Promise.race([closing, deadline]).finally(() => { if (timer) clearTimeout(timer); });
}

const LIST_METHODS = new Set(["tools/list", "resources/list", "prompts/list"]);

/**
 * Fresh live discovery of the selected servers only (D2): the metadata handshake
 * and the complete bounded tool listing, within the time, byte, tool and page
 * budgets. The budget observer is the manager's own trace hook, installed on this
 * manager instance only; `definition.trace` is refused by the config policy, so
 * it cannot switch the observer off. A failure closes what was opened.
 */
export interface BoundMcpDiscoveryInput {
	abi: BoundMcpAdapterAbi;
	config: Record<string, unknown>;
	cwd: string;
	selectors: readonly string[];
	signal?: AbortSignal;
	budget?: Partial<typeof BOUND_MCP_DISCOVERY_BUDGET>;
}

type BoundMcpDiscoveryResult = { ok: true; discovery: BoundMcpDiscovery } | { ok: false; code: BoundMcpDiscoveryErrorCode };

/**
 * Never throws: whatever the adapter or the untrusted metadata does, the result
 * is a discovery or one bounded code, every connection opened by a failed
 * discovery is closed, and the caller's signal keeps no listener of it.
 */
export async function discoverBoundMcp(input: BoundMcpDiscoveryInput): Promise<BoundMcpDiscoveryResult> {
	const budget = { ...BOUND_MCP_DISCOVERY_BUDGET, ...input.budget };
	const controller = new AbortController();
	const onExternalAbort = () => controller.abort(new Error("MCP discovery aborted"));
	if (input.signal?.aborted) onExternalAbort();
	else input.signal?.addEventListener("abort", onExternalAbort, { once: true });
	const opened: { manager?: McpServerManagerLike } = {};
	let result: BoundMcpDiscoveryResult;
	try { result = await discoverUnguarded(input, budget, controller, opened); }
	catch {
		controller.abort(new Error("MCP discovery failed"));
		if (opened.manager) await boundedClose(opened.manager, budget.closeMs);
		result = { ok: false, code: "mcp_discovery_failed" };
	} finally { input.signal?.removeEventListener("abort", onExternalAbort); }
	return result;
}

async function discoverUnguarded(
	input: BoundMcpDiscoveryInput,
	budget: typeof BOUND_MCP_DISCOVERY_BUDGET,
	controller: AbortController,
	opened: { manager?: McpServerManagerLike },
): Promise<BoundMcpDiscoveryResult> {
	let timedOut = false;
	let overflow = false;
	const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("MCP discovery budget exceeded")); }, budget.discoveryMs);
	timer.unref?.();
	let manager: McpServerManagerLike;
	try { manager = new input.abi.McpServerManager(input.cwd); }
	catch { clearTimeout(timer); return { ok: false, code: "mcp_adapter_unverified" }; }
	opened.manager = manager;
	let invalidated = false;
	const listeners = new Set<() => void>();
	let pages = 0;
	let bytes = 0;
	// The budget covers the discovery only; later tool calls are the run's business.
	let measuring = true;
	const exceed = (): void => { overflow = true; controller.abort(new Error("MCP metadata budget exceeded")); };
	try {
		manager.setRuntimeSignal(controller.signal);
		// Instance field of the pinned 2.26.1 manager (`this.traceWriter ??= ...`):
		// the budget observer replaces the file writer, so nothing is written.
		Object.defineProperty(manager, "traceWriter", {
			configurable: true, enumerable: false, writable: true,
			value: {
				write(event: { direction?: unknown; kind?: unknown; method?: unknown; bytes?: unknown }) {
					if (!measuring) return;
					if (event.direction === "outbound" && event.kind === "request" && typeof event.method === "string" && LIST_METHODS.has(event.method)) {
						pages++;
						if (pages > budget.maxPages) exceed();
					}
					if (event.direction === "inbound" && typeof event.bytes === "number" && Number.isFinite(event.bytes)) {
						bytes += event.bytes;
						if (bytes > budget.maxMetadataBytes) exceed();
					}
				},
				flush: async () => {},
			},
		});
		manager.setTraceConfig({ enabled: true });
		manager.setMetadataListChangedListener(() => {
			invalidated = true;
			for (const listener of [...listeners]) { try { listener(); } catch { /* a listener never breaks the manager */ } }
		});
	} catch {
		clearTimeout(timer);
		await boundedClose(manager, budget.closeMs);
		return { ok: false, code: "mcp_adapter_unverified" };
	}
	let closing: Promise<"closed" | "timeout" | "failed"> | undefined;
	// Concurrent closes share one attempt; a close that did not finish may be retried.
	const close = (): Promise<"closed" | "timeout" | "failed"> => {
		controller.abort(new Error("MCP discovery closed"));
		return closing ??= boundedClose(manager, budget.closeMs).then((outcome) => {
			if (outcome !== "closed") closing = undefined;
			return outcome;
		});
	};
	const fail = async (code: BoundMcpDiscoveryErrorCode) => { await close(); return { ok: false as const, code }; };
	const servers = [...new Set(input.selectors.map((selector) => selector.split("/")[0]!))].sort(compareCodeUnits);
	const definitions = input.config.mcpServers as Record<string, unknown>;
	const connections = new Map<string, ServerConnectionLike>();
	// The deadline is enforced here, not trusted to the adapter: a connect that
	// ignores its AbortSignal still loses the race once the discovery is aborted.
	const stopped = new Promise<"stopped">((resolve) => {
		if (controller.signal.aborted) resolve("stopped");
		else controller.signal.addEventListener("abort", () => resolve("stopped"), { once: true });
	});
	try {
		for (const server of servers) {
			const connecting = Promise.resolve().then(() => manager.connect(server, structuredClone(definitions[server]), controller.signal));
			connecting.catch(() => {});
			const connection = await Promise.race([connecting, stopped]);
			if (connection === "stopped") throw new Error("MCP discovery stopped");
			if (!connection || connection.status !== "connected") return await fail("mcp_discovery_failed");
			connections.set(server, connection);
		}
	} catch {
		const code: BoundMcpDiscoveryErrorCode = overflow ? "mcp_metadata_invalid" : timedOut ? "mcp_discovery_timeout" : input.signal?.aborted ? "mcp_discovery_aborted" : "mcp_discovery_failed";
		return await fail(code);
	} finally {
		measuring = false;
		clearTimeout(timer);
	}
	if (overflow || invalidated) return await fail("mcp_metadata_invalid");
	if (timedOut) return await fail("mcp_discovery_timeout");
	if (controller.signal.aborted) return await fail("mcp_discovery_aborted");
	// Untrusted metadata: bounded, JSON-only, unique names per server.
	let total = 0;
	const metadata: Record<string, { configHash: string; cachedAt: number; tools: Array<{ name: string; description?: string; inputSchema?: unknown }>; resources: [] }> = {};
	const liveTools = new Map<string, { name: string; description: string; inputSchema: Record<string, unknown> }>();
	for (const [server, connection] of connections) {
		const tools: unknown[] = Array.isArray(connection.tools) ? connection.tools : [];
		total += tools.length;
		if (total > budget.maxTools || !tools.every(plainObject)) return await fail("mcp_metadata_invalid");
		// `description` and `inputSchema` are optional in MCP: absent stays absent.
		const cloned = cloneJsonWithinByteLimit((tools as McpToolLike[]).map((tool) => ({
			name: tool.name,
			...(tool.description !== undefined ? { description: tool.description } : {}),
			...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
		})), budget.maxMetadataBytes);
		if (!cloned.ok || !Array.isArray(cloned.value)) return await fail("mcp_metadata_invalid");
		const names = new Set<string>();
		const entries: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
		for (const tool of cloned.value as Array<Record<string, unknown>>) {
			if (typeof tool.name !== "string" || !tool.name || Buffer.byteLength(tool.name, "utf8") > 128 || names.has(tool.name)
				|| (tool.description !== undefined && typeof tool.description !== "string")
				|| (tool.inputSchema !== undefined && !plainObject(tool.inputSchema))) return await fail("mcp_metadata_invalid");
			names.add(tool.name);
			entries.push({ name: tool.name, ...(tool.description !== undefined ? { description: tool.description as string } : {}), ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}) });
			liveTools.set(`${server}/${tool.name}`, { name: tool.name, description: (tool.description as string | undefined) ?? "", inputSchema: (tool.inputSchema as Record<string, unknown> | undefined) ?? { type: "object", properties: {} } });
		}
		let configHash: string;
		try { configHash = computeMcpServerHash(definitions[server] as never); } catch { return await fail("mcp_metadata_invalid"); }
		metadata[server] = { configHash, cachedAt: Date.now(), tools: entries, resources: [] };
	}
	const prefix = normalizeMcpToolPrefix((input.config.settings as { toolPrefix?: unknown } | undefined)?.toolPrefix);
	let specs: DirectToolSpecLike[];
	try { specs = input.abi.resolveDirectTools(input.config, { version: 1, servers: metadata }, prefix, [...input.selectors]); }
	catch { return await fail("mcp_selector_unresolved"); }
	// The adapter's own resolution and the fork's grant must name each selector
	// identically, once, with no resource or UI tool among them: no partial grant.
	const grant = planMcpDirectToolGrant({ selectors: [...input.selectors], servers: definitions as never, metadata, toolPrefix: prefix });
	const bySelector = new Map<string, DirectToolSpecLike>();
	for (const spec of Array.isArray(specs) ? specs : []) {
		if (!spec || typeof spec.prefixedName !== "string" || typeof spec.serverName !== "string" || typeof spec.originalName !== "string"
			|| spec.resourceUri !== undefined || spec.uiResourceUri !== undefined) return await fail("mcp_selector_unresolved");
		const selector = `${spec.serverName}/${spec.originalName}`;
		if (bySelector.has(selector)) return await fail("mcp_selector_unresolved");
		bySelector.set(selector, spec);
	}
	const names = new Set([...bySelector.values()].map((spec) => spec.prefixedName));
	if (grant.unresolvedSelectors.length > 0 || bySelector.size !== input.selectors.length || names.size !== bySelector.size
		|| grant.selections.length !== input.selectors.length
		|| !input.selectors.every((selector) => bySelector.has(selector) && liveTools.has(selector))
		|| !grant.selections.every((selection) => bySelector.get(selection.selector)?.prefixedName === selection.name)) return await fail("mcp_selector_unresolved");
	const declarations = [...input.selectors].sort(compareCodeUnits).map((selector) => {
		const live = liveTools.get(selector)!;
		return { selector, name: bySelector.get(selector)!.prefixedName, description: live.description, inputSchema: live.inputSchema };
	});
	const discovery: BoundMcpDiscovery = Object.freeze({
		manager,
		abi: input.abi,
		config: input.config,
		connections,
		specs: Object.freeze(input.selectors.map((selector) => bySelector.get(selector)!)),
		selections: Object.freeze(grant.selections.map((selection) => Object.freeze({ ...selection }))),
		declarations: Object.freeze(declarations),
		invalidated: () => invalidated,
		onInvalidate: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		close,
	});
	return { ok: true, discovery };
}

/** Adapter parity (`utils.ts:277`): the direct tool parameters without `$schema`/`additionalProperties`. */
function normalizeInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
	const { $schema: _schema, additionalProperties: _additional, ...normalized } = schema;
	return normalized;
}

function promptSnippet(description: string, serverName: string): string {
	const text = description.trim();
	if (!text) return `MCP tool from ${serverName}`;
	if (text.length <= 100) return text;
	const cut = text.slice(0, 100);
	const space = cut.lastIndexOf(" ");
	return `${(space > 50 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

function refusedCall(text: string, code: string): { content: Array<{ type: "text"; text: string }>; details: { error: string } } {
	return { content: [{ type: "text", text }], details: { error: code } };
}

export const BOUND_MCP_REVOKED_TEXT = "pi-subagents bound leaf: the MCP tool is no longer available to this run.";
export const BOUND_MCP_INVALIDATED_TEXT = "pi-subagents bound leaf: the MCP server changed after discovery; the call was refused.";

/**
 * Package factory of the bridge: registers exactly the measured direct tools
 * through the bound package facade, each executed by the adapter's own direct
 * executor over the prepared connections. Before every call the connection must
 * still be the measured one and the run must not be revoked; a replaced
 * connection or a changed list invalidates the run instead of reconnecting
 * (which would also write the adapter's persistent cache).
 */
export function createBoundMcpBridgeFactory(input: {
	discovery: BoundMcpDiscovery;
	isRevoked: () => boolean;
	onInvalidate: () => void;
	/** Aborted when the run is revoked; in-flight MCP calls see it as the owner signal. */
	signal: AbortSignal;
	/** The contract's effective MCP names (after a capability ceiling); nothing else is registered. */
	names: readonly string[];
}): ((pi: ExtensionAPI) => void) & { readonly declarations: ReadonlyMap<string, string> } {
	const { discovery } = input;
	// Name → declaration digest of every registered MCP tool: the barrier pins the
	// provider-visible definitions to exactly these before the first call (D2).
	const declarations = new Map<string, string>();
	const state = {
		owner: { signal: input.signal },
		manager: discovery.manager,
		lifecycle: { markKeepAlive() {} },
		toolMetadata: new Map(), resourceCounts: new Map(), promptMetadata: new Map(), promptMetadataLive: new Set(),
		serverInstructions: new Map(),
		config: discovery.config,
		failureTracker: new Map(), failureMessages: new Map(), approvedToolCalls: new Map(),
	};
	const allowed = new Set(input.names);
	const factory = (pi: ExtensionAPI): void => {
		for (const spec of discovery.specs) {
			if (!allowed.has(spec.prefixedName)) continue;
			const executor = discovery.abi.createDirectToolExecutor(() => state, () => null, spec);
			const measured = discovery.connections.get(spec.serverName);
			const inputSchema = discovery.declarations.find((declaration) => declaration.name === spec.prefixedName)?.inputSchema ?? { type: "object", properties: {} };
			const tool = {
				name: spec.prefixedName,
				label: `MCP: ${spec.originalName}`,
				description: spec.description || "(no description)",
				promptSnippet: promptSnippet(spec.description, spec.serverName),
				parameters: Type.Unsafe(normalizeInputSchema(structuredClone(inputSchema))),
				execute: async (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => {
					if (input.isRevoked() || input.signal.aborted) return refusedCall(BOUND_MCP_REVOKED_TEXT, "bound_revoked");
					const current = discovery.manager.getConnection(spec.serverName);
					if (discovery.invalidated() || !measured || current !== measured || current.status !== "connected" || (current.toolsRevision ?? 0) !== 0) {
						input.onInvalidate();
						return refusedCall(BOUND_MCP_INVALIDATED_TEXT, "bound_mcp_invalidated");
					}
					return executor(toolCallId, params, signal, onUpdate, ctx);
				},
			};
			const digest = toolDeclarationDigest(tool);
			if (!digest) throw new Error("pi-subagents bound leaf: an MCP declaration cannot be measured.");
			(pi.registerTool as unknown as (value: unknown) => unknown)(tool);
			declarations.set(spec.prefixedName, digest);
		}
	};
	return Object.assign(factory, { declarations: declarations as ReadonlyMap<string, string> });
}
