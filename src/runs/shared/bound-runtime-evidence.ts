import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

export interface BoundRuntimeExtensionEvidenceV1 {
	version: 1;
	entries: Array<{ name: string; contentDigest: string }>;
}

const MAX_DEPENDENCY_FILES = 2048;
const MAX_DEPENDENCY_BYTES = 16 * 1024 * 1024;

function fileDigest(entry: string): string {
	const stat = fs.lstatSync(entry);
	if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(entry) !== entry) throw new Error(`Bound runtime file is not canonical: ${entry}`);
	return createHash("sha256").update(fs.readFileSync(entry)).digest("hex");
}

function packageRoot(moduleName: string): string {
	const require = createRequire(import.meta.url);
	let current = path.dirname(fs.realpathSync(require.resolve(moduleName)));
	while (true) {
		const manifest = path.join(current, "package.json");
		try {
			const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: unknown };
			if (parsed.name === moduleName) return current;
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const parent = path.dirname(current);
		if (parent === current) throw new Error(`Cannot locate package root for ${moduleName}.`);
		current = parent;
	}
}

function directoryTreeDigest(root: string, label: string): string {
	const records: string[] = [];
	let files = 0;
	let bytes = 0;
	const visit = (directory: string) => {
		for (const name of fs.readdirSync(directory).sort()) {
			if (name === "node_modules") continue;
			const absolute = path.join(directory, name);
			const stat = fs.lstatSync(absolute);
			if (stat.isSymbolicLink()) throw new Error(`Symlinked ${label} evidence entry.`);
			if (stat.isDirectory()) { visit(absolute); continue; }
			if (!stat.isFile() || ++files > MAX_DEPENDENCY_FILES || (bytes += stat.size) > MAX_DEPENDENCY_BYTES) throw new Error(`${label} evidence exceeds bounds.`);
			records.push(`${path.relative(root, absolute).split(path.sep).join("/")}\0${stat.size}\0${fileDigest(absolute)}`);
		}
	};
	visit(root);
	return createHash("sha256").update(records.join("\n")).digest("hex");
}
function packageTreeDigest(moduleName: string): string { return directoryTreeDigest(packageRoot(moduleName), `${moduleName} package`); }

export function attestBoundRuntimeExtensions(paths: readonly string[]): BoundRuntimeExtensionEvidenceV1 {
	const sharedDir = path.dirname(paths.find((entry) => path.basename(entry) === "bound-tool-registry-gate.ts") ?? paths[0] ?? "");
	const hasRegistryGate = paths.some((entry) => path.basename(entry) === "bound-tool-registry-gate.ts");
	const expanded = [...new Set([
		...paths,
		...(hasRegistryGate ? [
			path.join(sharedDir, "bound-tool-registry-runtime.ts"),
			path.join(sharedDir, "bound-tool-registry-state.cjs"),
			path.join(sharedDir, "tool-registry-proof.ts"),
			path.join(sharedDir, "bound-runtime-evidence.ts"),
			path.join(sharedDir, "package-tree-evidence.ts"),
			path.join(sharedDir, "../../slash/delegation-json.ts"),
			path.join(sharedDir, "../../shared/canonical-json.ts"),
		] : []),
	])];
	const entries = expanded.map((entry) => ({ name: path.basename(entry), contentDigest: fileDigest(entry) }));
	if (hasRegistryGate) {
		const projectRoot = path.resolve(sharedDir, "../../.."); const projectManifest = path.join(projectRoot, "package.json");
		const manifest = JSON.parse(fs.readFileSync(projectManifest, "utf8")) as { dependencies?: Record<string, unknown> };
		const dependencyNames = Object.keys(manifest.dependencies ?? {}).sort();
		if (dependencyNames.join(",") !== "jiti,typebox,yaml") throw new Error("Bound runtime dependency set changed without evidence policy.");
		entries.push({ name: "runtime:package.json", contentDigest: fileDigest(projectManifest) });
		for (const dependency of dependencyNames) entries.push({ name: `dependency:${dependency}`, contentDigest: packageTreeDigest(dependency) });
		entries.push({ name: "dependency:pi-subagents-src", contentDigest: directoryTreeDigest(path.resolve(sharedDir, "../.."), "pi-subagents src") });
	}
	if (new Set(entries.map((entry) => entry.name)).size !== entries.length) throw new Error("Bound runtime extension names are ambiguous.");
	return { version: 1, entries };
}
