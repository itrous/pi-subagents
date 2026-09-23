import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { types as utilTypes } from "node:util";
import { resolveMcpDirectToolResolution, type McpDirectToolResolution } from "../runs/shared/mcp-direct-tool-allowlist.ts";
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

/** Undefined when absent, null when malformed. The value is already a strict JSON clone. */
export function parseBoundMcpConfigRequest(value: unknown): BoundMcpConfigRequestV1 | undefined | null {
	if (value === undefined) return undefined;
	if (!plainRecord(value) || Object.keys(value).sort().join(",") !== "path,version" || value.version !== BOUND_MCP_CONFIG_VERSION) return null;
	const target = value.path;
	if (typeof target !== "string" || !path.isAbsolute(target) || path.resolve(target) !== target
		|| /[\0\r\n]/u.test(target) || Buffer.byteLength(target, "utf8") > MAX_PATH_BYTES) return null;
	return { version: BOUND_MCP_CONFIG_VERSION, path: target };
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
