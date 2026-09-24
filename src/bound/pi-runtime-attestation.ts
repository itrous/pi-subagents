import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runtimeBuiltinProjection, validRuntimeVersionIdentity, type RuntimeBuiltinProjectionV1 } from "./bound-tool-registry-projection.ts";

export const PI_RUNTIME_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
/** Pi keeps no public export for the builtin tool list; this private path is the only source (risk noted in FORK.md). */
export const PI_RUNTIME_TOOLS_MODULE = ["dist", "core", "tools", "index.js"] as const;
const MAX_ATTESTED_FILES = 32_768;
const MAX_ATTESTED_BYTES = 256 * 1024 * 1024;
const MAX_ATTESTED_DEPTH = 32;

export interface PiRuntimeAttestationV1 {
	name: string;
	version: string;
	packageRootDigest: string;
	filesDigest: string;
	fileCount: number;
}

export interface PiRuntimeAttestation {
	attestation: PiRuntimeAttestationV1;
	runtimeBuiltins: RuntimeBuiltinProjectionV1;
	packageRoot: string;
}

export type PiRuntimeAttestationResult =
	| { ok: true; runtime: PiRuntimeAttestation }
	| { ok: false; code: "unverified_runtime" };

export interface AttestPiRuntimeOptions {
	/** Absolute root of the loaded Pi package; defaults to the module this build actually imports. */
	packageRoot?: string;
	/**
	 * Version this bound layer already attested for that root. A manifest that no
	 * longer matches it means the package on disk drifted from the loaded runtime.
	 */
	expectedVersion?: string;
	/** Test seam for the resolution of the loaded package entry. */
	resolveEntry?: () => string;
	/** Test seam for the loaded Pi module the bundled-Pi fallback asks for its package dir. */
	loadPiCodingAgent?: () => Promise<unknown>;
}

const cache = new Map<string, PiRuntimeAttestation>();

/** Test-only seam; production attests each package root once per process. */
export function resetPiRuntimeAttestationCache(): void {
	cache.clear();
}

function digestOf(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function manifestAt(root: string): { name: unknown; version: unknown } {
	const manifest = path.join(root, "package.json");
	const stat = fs.lstatSync(manifest);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("Unsafe Pi runtime manifest.");
	const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid Pi runtime manifest.");
	return parsed as { name: unknown; version: unknown };
}

function packageRootOf(entry: string): string {
	let current = path.dirname(path.resolve(entry));
	for (let depth = 0; depth < 64; depth++) {
		try {
			const candidate = manifestAt(current);
			if (candidate.name !== PI_RUNTIME_PACKAGE_NAME) throw new Error("Unexpected Pi runtime package root.");
			return current;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new Error("Pi runtime package root is unavailable.");
}

/** Hash the package's own files; the dependency closure is not part of this attestation. */
function attestOwnFiles(root: string): { filesDigest: string; fileCount: number } {
	const hash = createHash("sha256");
	let fileCount = 0;
	let bytes = 0;
	const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
	while (pending.length) {
		const { directory, depth } = pending.pop()!;
		if (depth > MAX_ATTESTED_DEPTH) throw new Error("Pi runtime tree is too deep.");
		for (const name of fs.readdirSync(directory).sort().reverse()) {
			if (name === "node_modules") continue;
			const absolute = path.join(directory, name);
			const stat = fs.lstatSync(absolute);
			if (stat.isDirectory()) { pending.push({ directory: absolute, depth: depth + 1 }); continue; }
			if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsupported Pi runtime entry.");
			if (++fileCount > MAX_ATTESTED_FILES) throw new Error("Pi runtime tree has too many entries.");
			if (stat.size > MAX_ATTESTED_BYTES - bytes) throw new Error("Pi runtime tree is too large.");
			const relative = path.relative(root, absolute).split(path.sep).join("/");
			const content = fs.readFileSync(absolute);
			bytes += content.length;
			hash.update(`F\0${relative}\0${content.length}\0`);
			hash.update(content);
			hash.update("\0");
		}
	}
	return { filesDigest: hash.digest("hex"), fileCount };
}

function defaultEntry(): string {
	return fileURLToPath(import.meta.resolve(PI_RUNTIME_PACKAGE_NAME));
}

/**
 * Root of the Pi package this process loaded. Pi's `pi` command is an esbuild
 * bundle: an extension there gets VIRTUAL_MODULES only, and resolving the package
 * specifier fails. The loaded module itself then names its package dir. An
 * overridden PI_PACKAGE_DIR no longer ties that dir to the loaded module: refused.
 */
async function loadedPackageRoot(options: AttestPiRuntimeOptions): Promise<string> {
	try { return packageRootOf((options.resolveEntry ?? defaultEntry)()); } catch { /* bundled Pi: no resolution path */ }
	if (process.env.PI_PACKAGE_DIR) throw new Error("PI_PACKAGE_DIR overrides the loaded Pi package dir.");
	const pi = await (options.loadPiCodingAgent ?? (() => import(PI_RUNTIME_PACKAGE_NAME)))() as { getPackageDir?: unknown } | undefined;
	const getPackageDir = pi?.getPackageDir;
	if (typeof getPackageDir !== "function") throw new Error("Loaded Pi exposes no package dir.");
	const dir: unknown = getPackageDir();
	if (typeof dir !== "string" || !path.isAbsolute(dir)) throw new Error("Loaded Pi package dir is not absolute.");
	return packageRootOf(path.join(dir, "package.json"));
}

/**
 * Decision R2: attest the Pi package this process actually loaded. The result is
 * cached per absolute package root, so production pays for it once.
 */
export async function attestPiRuntime(options: AttestPiRuntimeOptions = {}): Promise<PiRuntimeAttestationResult> {
	let root: string;
	try {
		root = options.packageRoot !== undefined
			? path.resolve(options.packageRoot)
			: await loadedPackageRoot(options);
	} catch { return { ok: false, code: "unverified_runtime" }; }
	const cached = cache.get(root);
	if (cached) {
		return options.expectedVersion !== undefined && options.expectedVersion !== cached.attestation.version
			? { ok: false, code: "unverified_runtime" }
			: { ok: true, runtime: cached };
	}
	let name: unknown; let version: unknown; let files: { filesDigest: string; fileCount: number };
	try {
		({ name, version } = manifestAt(root));
		if (name !== PI_RUNTIME_PACKAGE_NAME || !validRuntimeVersionIdentity(version)) return { ok: false, code: "unverified_runtime" };
		if (options.expectedVersion !== undefined && options.expectedVersion !== version) return { ok: false, code: "unverified_runtime" };
		files = attestOwnFiles(root);
	} catch { return { ok: false, code: "unverified_runtime" }; }
	let names: unknown;
	try {
		const toolsModule = path.join(root, ...PI_RUNTIME_TOOLS_MODULE);
		const stat = fs.lstatSync(toolsModule);
		if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, code: "unverified_runtime" };
		const module = await import(pathToFileURL(toolsModule).href) as { allToolNames?: unknown };
		names = module.allToolNames;
	} catch { return { ok: false, code: "unverified_runtime" }; }
	if (!Array.isArray(names) && !(names instanceof Set)) return { ok: false, code: "unverified_runtime" };
	const runtimeBuiltins = runtimeBuiltinProjection([...names as Iterable<unknown>].map((entry) => ({ name: entry, sourceInfo: { source: "builtin" } })));
	if (!runtimeBuiltins) return { ok: false, code: "unverified_runtime" };
	const runtime: PiRuntimeAttestation = {
		attestation: {
			name: PI_RUNTIME_PACKAGE_NAME,
			version: version as string,
			packageRootDigest: digestOf(root),
			filesDigest: files.filesDigest,
			fileCount: files.fileCount,
		},
		runtimeBuiltins,
		packageRoot: root,
	};
	cache.set(root, runtime);
	return { ok: true, runtime };
}
