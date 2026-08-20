import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_TREE_ENTRIES = 32768;
const MAX_TREE_BYTES = 128 * 1024 * 1024;
const MAX_PACKAGE_ROOTS = 512;

export interface PackageTreeEvidence {
	digest: string;
	roots: string[];
}

/** Package root supplied by owner/dependency attestation, not a whole npm ecosystem. */
export function packageEvidenceRoot(packageRoot: string): string { return path.resolve(packageRoot); }

function manifestAt(root: string): { bytes: Buffer; value: Record<string, unknown> } {
	const manifest = path.join(root, "package.json");
	const stat = fs.lstatSync(manifest);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || fs.realpathSync(manifest) !== manifest) throw new Error("Unsafe package evidence manifest.");
	const bytes = fs.readFileSync(manifest); const value = JSON.parse(bytes.toString("utf8")) as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid package evidence manifest.");
	return { bytes, value: value as Record<string, unknown> };
}

function resolvedPackageRoot(fromRoot: string, packageName: string): string | undefined {
	const parts = packageName.split("/"); let current = fromRoot;
	while (true) {
		const candidate = path.join(current, "node_modules", ...parts);
		try {
			const canonical = fs.realpathSync(candidate);
			if (canonical !== candidate || manifestAt(canonical).value.name !== packageName) throw new Error("Unsafe package evidence dependency root.");
			return canonical;
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const parent = path.dirname(current); if (parent === current) return undefined; current = parent;
	}
}

/** Hash exactly the package and declared runtime dependency closure Node may execute. */
export function packageTreeEvidence(entryPath: string, packageRoot: string): PackageTreeEvidence {
	const root = path.resolve(packageRoot); const entry = path.resolve(entryPath);
	const relativeEntry = path.relative(root, entry);
	if (relativeEntry === ".." || relativeEntry.startsWith(`..${path.sep}`) || path.isAbsolute(relativeEntry)) throw new Error("Package entry escapes its package root.");
	const roots = new Set<string>(); const pendingRoots = [root];
	while (pendingRoots.length) {
		const current = pendingRoots.pop()!;
		if (roots.has(current)) continue;
		if (roots.size >= MAX_PACKAGE_ROOTS) throw new Error("Package evidence dependency closure is too large.");
		const rootStat = fs.lstatSync(current);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(current) !== current) throw new Error("Unsafe package evidence root.");
		roots.add(current);
		const manifest = manifestAt(current).value;
		for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
			const dependencies = manifest[field]; if (dependencies === undefined) continue;
			if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) throw new Error("Invalid package dependency evidence.");
			for (const packageName of Object.keys(dependencies as Record<string, unknown>).sort()) {
				const dependencyRoot = resolvedPackageRoot(current, packageName);
				if (dependencyRoot) pendingRoots.push(dependencyRoot);
				else if (field === "dependencies") throw new Error(`Missing package evidence dependency: ${packageName}`);
			}
		}
	}

	const orderedRoots = [...roots].sort(); const hash = createHash("sha256");
	let entries = 0; let bytes = 0;
	for (const packageDirectory of orderedRoots) {
		const packageName = String(manifestAt(packageDirectory).value.name ?? "");
		hash.update(`P\0${packageName}\0${createHash("sha256").update(packageDirectory).digest("hex")}\0`);
		const pending: Array<{ directory: string; depth: number }> = [{ directory: packageDirectory, depth: 0 }];
		while (pending.length) {
			const { directory, depth } = pending.pop()!;
			if (depth > 64) throw new Error("Package evidence tree is too deep.");
			for (const name of fs.readdirSync(directory).sort().reverse()) {
				if (name === "node_modules") continue;
				if (++entries > MAX_TREE_ENTRIES) throw new Error("Package evidence tree has too many entries.");
				const absolute = path.join(directory, name); const relative = path.relative(packageDirectory, absolute).split(path.sep).join("/");
				const stat = fs.lstatSync(absolute);
				if (stat.isDirectory()) { pending.push({ directory: absolute, depth: depth + 1 }); continue; }
				if (stat.isSymbolicLink()) throw new Error("Symlinked package evidence entry.");
				if (!stat.isFile()) throw new Error("Unsupported package evidence entry.");
				if (stat.size > MAX_TREE_BYTES - bytes) throw new Error("Package evidence tree is too large.");
				const content = fs.readFileSync(absolute); bytes += content.length;
				hash.update(`F\0${relative}\0${content.length}\0`); hash.update(content); hash.update("\0");
			}
		}
	}
	return { digest: hash.digest("hex"), roots: orderedRoots };
}

export function packageTreeDigest(entryPath: string, packageRoot: string): string {
	return packageTreeEvidence(entryPath, packageRoot).digest;
}
