import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { AgentConfig, ActiveBoundPackageIdentity } from "../agents/agents.ts";
import { packageEvidenceRoot, packageTreeDigest } from "../runs/shared/package-tree-evidence.ts";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_REFS = 16;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u;
const SAFE_VERSION = /^(?=.*[A-Za-z0-9])[A-Za-z0-9.+_-]+$/u;

export interface ActiveBoundPackageExtensionProjectionV1 {
	kind: "relative" | "package";
	ref: string;
	owner: { name: string; version: string; manifestDigest: string };
	package?: { name: string; version: string; manifestDigest: string };
	entryDigest: string;
	contentDigest: string;
	packageTreeDigest: string;
	evidenceRootDigest: string;
}

export interface ActiveBoundResolvedPackageExtensions {
	paths: string[];
	projection: ActiveBoundPackageExtensionProjectionV1[];
	/** Private path/digest pairs in factory execution order. */
	attestations: Array<{ path: string; contentDigest: string; evidenceRoot: string; evidenceRootDigest: string; packageTreeDigest: string }>;
}

function digest(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function publicIdentity(identity: ActiveBoundPackageIdentity): ActiveBoundPackageExtensionProjectionV1["owner"] {
	return { name: identity.name, version: identity.version, manifestDigest: identity.manifestDigest };
}
function within(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function safeRelative(value: string): boolean {
	return value.startsWith("./") && !value.split(/[\\/]/u).some((part) => part === "..") && !path.isAbsolute(value);
}
function safeManifestEntry(value: string, root: string): boolean {
	return value.length > 0 && !path.isAbsolute(value) && within(root, path.resolve(root, value));
}
function regularCanonicalFile(filePath: string, root: string): { path: string; bytes: Buffer } {
	const absolute = path.resolve(filePath); const stat = fs.lstatSync(absolute);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsupported active-bound extension entry.");
	const canonical = fs.realpathSync(absolute);
	if (canonical !== absolute || !within(root, canonical)) throw new Error("Unsafe active-bound extension entry.");
	return { path: canonical, bytes: fs.readFileSync(canonical) };
}
function packageManifest(manifestPath: string, expectedName: string): { identity: ActiveBoundPackageIdentity; raw: Record<string, unknown> } {
	const absolute = path.resolve(manifestPath); const stat = fs.lstatSync(absolute);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES || fs.realpathSync(absolute) !== absolute) throw new Error("Unsupported active-bound dependency manifest.");
	const bytes = fs.readFileSync(absolute); const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid active-bound dependency manifest.");
	const raw = parsed as Record<string, unknown>; const name = raw.name; const version = raw.version;
	const packageBaseName = typeof name === "string" ? name.split("/").at(-1)?.toLowerCase() : undefined;
	if (name !== expectedName || typeof name !== "string" || name.trim() !== name || /[\r\n]/u.test(name) || !PACKAGE_NAME.test(name) || packageBaseName === "node_modules" || packageBaseName === "favicon.ico" || Buffer.byteLength(name, "utf8") > 214
		|| typeof version !== "string" || version.trim() !== version || /[\r\n]/u.test(version) || !SAFE_VERSION.test(version) || Buffer.byteLength(version, "utf8") > 64) throw new Error("Invalid active-bound dependency identity.");
	const rootPath = path.dirname(absolute); const rootStat = fs.lstatSync(rootPath);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(rootPath) !== rootPath) throw new Error("Unsafe active-bound dependency root.");
	return { identity: { name, version, manifestDigest: digest(bytes), rootPath }, raw };
}
function resolveDependencyManifest(agent: AgentConfig, moduleName: string): string {
	const owner = agent.activeBoundPackageOwner!;
	const ownerManifest = path.join(owner.rootPath, "package.json");
	const ownerStat = fs.lstatSync(ownerManifest);
	if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > MAX_FILE_BYTES || fs.realpathSync(ownerManifest) !== ownerManifest) throw new Error("Unsafe active-bound owner manifest.");
	const ownerRaw = JSON.parse(fs.readFileSync(ownerManifest, "utf8")) as { dependencies?: Record<string, unknown> };
	if (!ownerRaw.dependencies || typeof ownerRaw.dependencies !== "object" || Array.isArray(ownerRaw.dependencies)
		|| !Object.hasOwn(ownerRaw.dependencies, moduleName) || typeof ownerRaw.dependencies[moduleName] !== "string") throw new Error("Undeclared active-bound extension package.");
	const moduleParts = moduleName.split("/");
	const allowedInstallations: string[] = [];
	let ancestor = owner.rootPath;
	while (true) {
		allowedInstallations.push(path.join(ancestor, "node_modules", ...moduleParts));
		const parent = path.dirname(ancestor);
		if (parent === ancestor) break;
		ancestor = parent;
	}
	const require = createRequire(agent.filePath);
	const resolvedEntry = path.resolve(require.resolve(moduleName));
	const entry = fs.realpathSync(resolvedEntry);
	if (entry !== resolvedEntry) throw new Error("Symlinked active-bound dependency entry.");
	let current = path.dirname(entry);
	while (true) {
		const candidate = path.join(current, "package.json");
		try {
			const stat = fs.lstatSync(candidate);
			if (stat.isFile() && !stat.isSymbolicLink()) {
				const installation = allowedInstallations.find((root) => within(root, current));
				if (!installation) throw new Error("Escaped active-bound dependency installation.");
				const installationStat = fs.lstatSync(installation);
				if (!installationStat.isDirectory() || installationStat.isSymbolicLink() || fs.realpathSync(installation) !== installation
					|| fs.realpathSync(current) !== current) throw new Error("Unsafe active-bound dependency installation.");
				return candidate;
			}
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new Error("Missing active-bound dependency manifest.");
}

/** Resolve package-owned refs without importing extension code. */
export function resolveActiveBoundPackageExtensions(agent: AgentConfig): ActiveBoundResolvedPackageExtensions {
	const refs = agent.subagentOnlyExtensions ?? [];
	if (agent.source !== "package" || !agent.activeBoundPackageOwner) {
		if (refs.length) throw new Error("Only package agents may own active-bound extension refs.");
		return { paths: [], projection: [], attestations: [] };
	}
	if (refs.length > MAX_REFS || new Set(refs).size !== refs.length) throw new Error("Invalid active-bound extension refs.");
	const owner = agent.activeBoundPackageOwner; const paths: string[] = []; const projection: ActiveBoundPackageExtensionProjectionV1[] = []; const evidenceRootByPath = new Map<string, string>();
	const treeDigestByRoot = new Map<string, string>();
	const treeDigest = (entry: string, evidenceRoot: string): string => {
		const relative = path.relative(evidenceRoot, entry);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Package entry escapes its package root.");
		const cached = treeDigestByRoot.get(evidenceRoot); if (cached) return cached;
		const measured = packageTreeDigest(entry, evidenceRoot, owner.rootPath); treeDigestByRoot.set(evidenceRoot, measured); return measured;
	};
	for (const ref of refs) {
		if (typeof ref !== "string") throw new Error("Invalid active-bound extension ref.");
		if (safeRelative(ref)) {
			const entry = regularCanonicalFile(path.resolve(path.dirname(agent.filePath), ref), owner.rootPath);
			const evidenceRoot = packageEvidenceRoot(owner.rootPath);
			paths.push(entry.path); evidenceRootByPath.set(entry.path, evidenceRoot); projection.push({ kind: "relative", ref, owner: publicIdentity(owner), entryDigest: digest(ref), contentDigest: digest(entry.bytes), evidenceRootDigest: digest(evidenceRoot), packageTreeDigest: treeDigest(entry.path, evidenceRoot) });
			continue;
		}
		if (!ref.startsWith("package:")) throw new Error("Invalid active-bound extension ref.");
		const moduleName = ref.slice("package:".length);
		const moduleBaseName = moduleName.split("/").at(-1)?.toLowerCase();
		if (moduleName.trim() !== moduleName || /[\r\n]/u.test(moduleName) || !PACKAGE_NAME.test(moduleName)
			|| moduleBaseName === "node_modules" || moduleBaseName === "favicon.ico" || Buffer.byteLength(moduleName, "utf8") > 214) throw new Error("Invalid active-bound extension package name.");
		const dependency = packageManifest(resolveDependencyManifest(agent, moduleName), moduleName);
		const pi = dependency.raw.pi;
		if (!pi || typeof pi !== "object" || Array.isArray(pi)) throw new Error("Missing active-bound dependency pi manifest.");
		const entries = (pi as { extensions?: unknown }).extensions;
		if (!Array.isArray(entries) || entries.length !== 1 || typeof entries[0] !== "string" || !safeManifestEntry(entries[0], dependency.identity.rootPath)) throw new Error("Ambiguous active-bound dependency extension entry.");
		const entry = regularCanonicalFile(path.resolve(dependency.identity.rootPath, entries[0]), dependency.identity.rootPath);
		const evidenceRoot = packageEvidenceRoot(owner.rootPath);
		paths.push(entry.path); evidenceRootByPath.set(entry.path, evidenceRoot); projection.push({ kind: "package", ref, owner: publicIdentity(owner), package: publicIdentity(dependency.identity), entryDigest: digest(entries[0]), contentDigest: digest(entry.bytes), evidenceRootDigest: digest(evidenceRoot), packageTreeDigest: treeDigest(entry.path, evidenceRoot) });
	}
	if (new Set(paths).size !== paths.length) throw new Error("Duplicate active-bound extension entry.");
	const evidenceByPath = new Map(paths.map((entry, index) => {
		const projected = projection[index]!; const evidenceRoot = evidenceRootByPath.get(entry)!;
		return [entry, { contentDigest: projected.contentDigest, evidenceRoot, evidenceRootDigest: projected.evidenceRootDigest, packageTreeDigest: projected.packageTreeDigest }];
	}));
	const attestations = paths.map((entry) => ({ path: entry, ...evidenceByPath.get(entry)! }));
	if (Buffer.byteLength(JSON.stringify(attestations), "utf8") > 48 * 1024) throw new Error("Active-bound package evidence policy is too large.");
	return {
		paths,
		projection: projection.sort((left, right) => left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0),
		attestations,
	};
}
