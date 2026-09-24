import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { types as utilTypes } from "node:util";
import { loadMcpConfig, resolveMcpDirectToolResolution, type McpDirectToolResolution } from "../runs/shared/mcp-direct-tool-allowlist.ts";
import { normalizeMcpToolPrefix } from "../runs/shared/mcp-direct-tool-grant.ts";
import { canonicalSha256 } from "../shared/canonical-json.ts";
import type { BoundPackageExtensionProjectionV1 } from "./bound-package-extensions.ts";

export const BOUND_MCP_CONFIG_VERSION = 1 as const;
/** The only extension an attested MCP configuration is handed to (subplan A1R.6, sub-stage 4). */
export const BOUND_MCP_CONFIG_EXTENSION = "package:pi-mcp-adapter" as const;
export const BOUND_MCP_ADAPTER_PACKAGE = "pi-mcp-adapter" as const;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_SERVERS = 64;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
/**
 * pi-mcp-adapter 2.26.1 starts servers with these lifecycles during its
 * load-time init against `process.cwd()` (`index.ts:356-378`): refused, so every
 * server starts in the session cwd.
 */
const FORBIDDEN_LIFECYCLES = new Set(["eager", "keep-alive"]);

export interface BoundMcpConfigRequestV1 {
	version: typeof BOUND_MCP_CONFIG_VERSION;
	/** Absolute canonical path of the configuration file. */
	path: string;
}

export interface BoundMcpConfigContractV1 {
	version: typeof BOUND_MCP_CONFIG_VERSION;
	extension: typeof BOUND_MCP_CONFIG_EXTENSION;
	sourcePathDigest: string;
	contentDigest: string;
	effectiveDigest: string;
	servers: string[];
}

export interface BoundMcpConfigMeasurement {
	config: Record<string, unknown>;
	contentDigest: string;
	effectiveDigest: string;
	servers: string[];
}

function plainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Repair contract (S3 P2, D2/D4): the cold-safe discovery configuration. The
 * prepare request carries no ticket; the final preflight/launch request carries
 * the producer-owned ticket and the snapshot digest the prepare reply returned.
 */
export const BOUND_MCP_CONFIG_V2_VERSION = 2 as const;
export const BOUND_MCP_BRIDGE_IMPLEMENTATION = "bound-direct/v1" as const;

export interface BoundMcpConfigPrepareRequestV2 {
	version: typeof BOUND_MCP_CONFIG_V2_VERSION;
	path: string;
	implementation: typeof BOUND_MCP_BRIDGE_IMPLEMENTATION;
}

export interface BoundMcpConfigFinalRequestV2 extends BoundMcpConfigPrepareRequestV2 {
	ticket: string;
	snapshotDigest: string;
}

export type BoundMcpConfigRequest = BoundMcpConfigRequestV1 | BoundMcpConfigPrepareRequestV2 | BoundMcpConfigFinalRequestV2;

/** Which v2 shape a request may carry: the prepare request has no ticket, the final one must. */
export type BoundMcpConfigRequestMode = "prepare" | "final";

const TICKET = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;

function canonicalAbsolutePath(target: unknown): target is string {
	return typeof target === "string" && path.isAbsolute(target) && path.resolve(target) === target
		&& !/[\0\r\n]/u.test(target) && Buffer.byteLength(target, "utf8") <= MAX_PATH_BYTES;
}

export function isBoundMcpConfigV2(value: BoundMcpConfigRequest | undefined): value is BoundMcpConfigPrepareRequestV2 | BoundMcpConfigFinalRequestV2 {
	return value !== undefined && value.version === BOUND_MCP_CONFIG_V2_VERSION;
}

export function isBoundMcpConfigFinal(value: BoundMcpConfigRequest | undefined): value is BoundMcpConfigFinalRequestV2 {
	return isBoundMcpConfigV2(value) && typeof (value as Partial<BoundMcpConfigFinalRequestV2>).ticket === "string";
}

/**
 * Undefined when absent, null when malformed. The value is already a strict JSON
 * clone. A v1 object keeps its exact closed shape; a v2 object is closed per mode
 * (`mcpConfigV2PrepareRequest` / `mcpConfigV2FinalRequest` of D4).
 */
export function parseBoundMcpConfigRequest(value: unknown, mode: BoundMcpConfigRequestMode = "final"): BoundMcpConfigRequest | undefined | null {
	if (value === undefined) return undefined;
	if (!plainRecord(value)) return null;
	const keys = Object.keys(value).sort().join(",");
	if (value.version === BOUND_MCP_CONFIG_VERSION) {
		if (mode !== "final" || keys !== "path,version" || !canonicalAbsolutePath(value.path)) return null;
		return { version: BOUND_MCP_CONFIG_VERSION, path: value.path };
	}
	if (value.version !== BOUND_MCP_CONFIG_V2_VERSION || !canonicalAbsolutePath(value.path) || value.implementation !== BOUND_MCP_BRIDGE_IMPLEMENTATION) return null;
	if (mode === "prepare") {
		if (keys !== "implementation,path,version") return null;
		return { version: BOUND_MCP_CONFIG_V2_VERSION, path: value.path, implementation: BOUND_MCP_BRIDGE_IMPLEMENTATION };
	}
	if (keys !== "implementation,path,snapshotDigest,ticket,version") return null;
	if (typeof value.ticket !== "string" || !TICKET.test(value.ticket) || typeof value.snapshotDigest !== "string" || !HEX_64.test(value.snapshotDigest)) return null;
	return { version: BOUND_MCP_CONFIG_V2_VERSION, path: value.path, implementation: BOUND_MCP_BRIDGE_IMPLEMENTATION, ticket: value.ticket, snapshotDigest: value.snapshotDigest };
}

/**
 * The closed configuration shape the adapter receives as its programmatic
 * config: nothing that pulls further sources (`imports`, plugin paths, host
 * discovery) and no server that the adapter would start against `process.cwd()`.
 */
export function validBoundMcpConfig(config: unknown): config is Record<string, unknown> {
	if (!plainRecord(config)) return false;
	if (!Object.keys(config).every((key) => key === "mcpServers" || key === "settings")) return false;
	const servers = config.mcpServers;
	if (!plainRecord(servers)) return false;
	const names = Object.keys(servers);
	if (names.length === 0 || names.length > MAX_SERVERS) return false;
	for (const name of names) {
		const server = servers[name];
		if (!SERVER_NAME.test(name) || !plainRecord(server)) return false;
		if (server.lifecycle !== undefined && (typeof server.lifecycle !== "string" || FORBIDDEN_LIFECYCLES.has(server.lifecycle))) return false;
		if (server.cwd !== undefined && (typeof server.cwd !== "string" || !path.isAbsolute(server.cwd))) return false;
	}
	if (config.settings !== undefined) {
		const settings = config.settings;
		if (!plainRecord(settings)) return false;
		if (Object.hasOwn(settings, "agentPluginPaths")) return false;
		if (settings.hostConfigDiscovery !== undefined && settings.hostConfigDiscovery !== "off") return false;
	}
	return true;
}

/**
 * Read the file once: a regular, non-symlink file at its canonical path, within
 * the size bound, holding a JSON object of the closed shape. The returned config
 * is parsed from exactly the measured bytes.
 */
export function measureBoundMcpConfig(target: string): BoundMcpConfigMeasurement | undefined {
	try {
		const stat = fs.lstatSync(target);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES || fs.realpathSync(target) !== target) return undefined;
		const bytes = fs.readFileSync(target);
		if (bytes.length > MAX_CONFIG_BYTES) return undefined;
		const config = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
		if (!validBoundMcpConfig(config)) return undefined;
		return {
			config,
			contentDigest: createHash("sha256").update(bytes).digest("hex"),
			effectiveDigest: canonicalSha256(config),
			servers: Object.keys(config.mcpServers as Record<string, unknown>).sort(compareCodeUnits),
		};
	} catch { return undefined; }
}

type McpConfigOverride = Parameters<typeof resolveMcpDirectToolResolution>[3];

function selectionKey(resolution: McpDirectToolResolution): string | undefined {
	if (resolution.unresolvedSelectors.length > 0 || (resolution.runtimeServerNames?.length ?? 0) > 0) return undefined;
	return resolution.selections.map((selection) => `${selection.selector}\0${selection.name}`).sort(compareCodeUnits).join("\n");
}

/**
 * Name resolution with the attested configuration. The upstream executor
 * resolves the leaf's `server/tool` selectors from the files it discovers in
 * the leaf cwd (plus the metadata cache), which the bound layer does not own;
 * the adapter serves them from the attested object. Both must name the same
 * tools, or the launch is refused: since the cache holds one entry per server,
 * validated by the definition hash, agreement also means the discovered and the
 * attested definitions of every selected server are the same.
 */
export function resolveBoundMcpSelections(selectors: readonly string[], cwd: string, config: Record<string, unknown>): McpDirectToolResolution["selections"] | undefined {
	try {
		const attested = resolveMcpDirectToolResolution([...selectors], cwd, undefined, config as unknown as McpConfigOverride);
		const discovered = resolveMcpDirectToolResolution([...selectors], cwd);
		const key = selectionKey(attested);
		return key !== undefined && key === selectionKey(discovered) ? attested.selections : undefined;
	} catch { return undefined; }
}

/**
 * Preflight: an attested configuration only for a leaf with MCP direct tools
 * whose one `package:pi-mcp-adapter` extension is the adapter package itself,
 * and whose names the attested and the discovered configuration agree on.
 */
export function resolveBoundMcpConfig(
	request: BoundMcpConfigRequestV1,
	input: {
		packageExtensions: readonly BoundPackageExtensionProjectionV1[];
		/** Contract names (`toolPlan.effectiveMcpTools`). */
		mcpDirectTools: readonly string[];
		/** The agent's `server/tool` selectors and the leaf cwd upstream resolves them in. */
		selectors: readonly string[];
		cwd: string;
	},
): BoundMcpConfigContractV1 | undefined {
	if (input.mcpDirectTools.length === 0) return undefined;
	const adapters = input.packageExtensions.filter((entry) => entry.ref === BOUND_MCP_CONFIG_EXTENSION);
	if (adapters.length !== 1 || adapters[0]!.kind !== "package" || adapters[0]!.package?.name !== BOUND_MCP_ADAPTER_PACKAGE) return undefined;
	const measured = measureBoundMcpConfig(request.path);
	if (!measured) return undefined;
	const selections = resolveBoundMcpSelections(input.selectors, input.cwd, measured.config);
	const names = new Set(selections?.map((selection) => selection.name));
	if (!selections || input.mcpDirectTools.some((name) => !names.has(name))) return undefined;
	return {
		version: BOUND_MCP_CONFIG_VERSION,
		extension: BOUND_MCP_CONFIG_EXTENSION,
		sourcePathDigest: canonicalSha256(request.path),
		contentDigest: measured.contentDigest,
		effectiveDigest: measured.effectiveDigest,
		servers: measured.servers,
	};
}

/** Load time: the same path, bytes and effective config as the contract, or nothing. */
export function recheckBoundMcpConfig(request: BoundMcpConfigRequestV1 | undefined, contract: BoundMcpConfigContractV1): Record<string, unknown> | undefined {
	if (!request || canonicalSha256(request.path) !== contract.sourcePathDigest) return undefined;
	const measured = measureBoundMcpConfig(request.path);
	if (!measured || measured.contentDigest !== contract.contentDigest || measured.effectiveDigest !== contract.effectiveDigest
		|| measured.servers.join("\0") !== contract.servers.join("\0")) return undefined;
	return measured.config;
}

/** The two private pinned entries of pi-mcp-adapter the bridge imports (D2); nothing else. */
export const BOUND_MCP_PRIVATE_ENTRIES = ["server-manager.ts", "direct-tools.ts"] as const;
export type BoundMcpPrivateEntry = typeof BOUND_MCP_PRIVATE_ENTRIES[number];
export const BOUND_MCP_BRIDGE_RUNTIME_PATH = "bound/bound-mcp-direct-bridge.ts" as const;

export interface BoundMcpConfigContractV2 {
	version: typeof BOUND_MCP_CONFIG_V2_VERSION;
	extension: typeof BOUND_MCP_CONFIG_EXTENSION;
	sourcePathDigest: string;
	contentDigest: string;
	effectiveDigest: string;
	servers: string[];
	implementation: typeof BOUND_MCP_BRIDGE_IMPLEMENTATION;
	snapshotDigest: string;
	packageEvidenceDigest: string;
	entryDigests: Record<BoundMcpPrivateEntry, string>;
	bridge: { runtimePath: typeof BOUND_MCP_BRIDGE_RUNTIME_PATH; contentDigest: string };
}

export type BoundMcpConfigContract = BoundMcpConfigContractV1 | BoundMcpConfigContractV2;

export function isBoundMcpConfigContractV2(value: BoundMcpConfigContract | undefined): value is BoundMcpConfigContractV2 {
	return value !== undefined && value.version === BOUND_MCP_CONFIG_V2_VERSION;
}

/**
 * Server keys the bound-direct bridge refuses (D1/D2): an HTTP or OAuth server
 * reaches ambient credential storage and interactive auth; `trace` would switch
 * off the metadata budget observer; `pluginDataDir` creates a directory during
 * discovery. The production 1C servers are stdio servers without any of them.
 */
const BRIDGE_REFUSED_SERVER_KEYS = ["url", "auth", "oauth", "bearerToken", "bearerTokenEnv", "headers", "requestHeadersCommand", "httpTransport", "trace", "pluginDataDir"];

/** The v1 closed shape plus the refusals of the bridge; every selected server must be a local stdio or socket server. */
export function validBoundMcpBridgeConfig(config: unknown): config is Record<string, unknown> {
	if (!validBoundMcpConfig(config)) return false;
	const servers = config.mcpServers as Record<string, Record<string, unknown>>;
	for (const server of Object.values(servers)) {
		if (BRIDGE_REFUSED_SERVER_KEYS.some((key) => Object.hasOwn(server, key))) return false;
		const transports = [server.command, server.socket].filter((value) => value !== undefined);
		if (transports.length !== 1 || !transports.every((value) => typeof value === "string" && value.length > 0)) return false;
	}
	return true;
}

/**
 * `server/tool` selectors only (D2): no whole-server selector, no wildcard, no
 * duplicate; every named server is configured and not disabled.
 */
export function explicitBoundMcpSelectors(selectors: readonly string[], config: Record<string, unknown>): string[] | undefined {
	const servers = config.mcpServers as Record<string, Record<string, unknown>>;
	const seen = new Set<string>();
	for (const selector of selectors) {
		if (typeof selector !== "string" || seen.has(selector)) return undefined;
		const parts = selector.split("/");
		if (parts.length !== 2 || !SERVER_NAME.test(parts[0]!) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(parts[1]!)) return undefined;
		const server = Object.hasOwn(servers, parts[0]!) ? servers[parts[0]!] : undefined;
		if (!server || server.disabled === true || server.enabled === false) return undefined;
		seen.add(selector);
	}
	return seen.size > 0 ? [...seen] : undefined;
}

/**
 * D2: the definitions upstream discovery finds in the leaf cwd must equal the
 * attested ones for every selected server, and so must the tool prefix. No
 * metadata cache is read here.
 */
export function boundMcpDefinitionsAgree(selectors: readonly string[], cwd: string, config: Record<string, unknown>): boolean {
	try {
		const discovered = loadMcpConfig(cwd);
		const attested = config.mcpServers as Record<string, unknown>;
		const settings = config.settings as { toolPrefix?: unknown } | undefined;
		if (normalizeMcpToolPrefix(discovered.settings?.toolPrefix) !== normalizeMcpToolPrefix(settings?.toolPrefix)) return false;
		for (const server of new Set(selectors.map((selector) => selector.split("/")[0]!))) {
			const found = Object.hasOwn(discovered.mcpServers, server) ? discovered.mcpServers[server] : undefined;
			if (!found || canonicalSha256(found) !== canonicalSha256(attested[server])) return false;
		}
		return true;
	} catch { return false; }
}
