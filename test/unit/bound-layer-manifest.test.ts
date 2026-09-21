import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	BOUND_LAYER_MANIFEST_VERSION, BOUND_LAYER_MODULES, BOUND_LAYER_SOURCE_ROOT,
	boundLayerManifest, boundLayerModulePath,
} from "../../src/bound/bound-layer-manifest.ts";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

/**
 * Modules of the A1 delta the fork still owns outside `src/bound/`.
 * `src/api/active-bound-environment.ts` was removed in this stage (decision D6),
 * so there are six of them.
 */
const KEPT_A1_MODULES = [
	"api/launch-receipt.ts",
	"extension/source-identity.ts",
	"runs/shared/core-runtime-tools.ts",
	"runs/shared/package-tree-evidence.ts",
	"shared/canonical-json.ts",
	"slash/bound-identity-registry.ts",
] as const;

/**
 * Upstream modules the bound layer is allowed to depend on directly. The closure
 * is walked through fork-owned files only: upstream never imports a fork module,
 * so the fork-owned intersection is the same as for a full closure, while this
 * list stays the fork's actual boundary with upstream and a new entry here is a
 * visible decision rather than transitive upstream noise.
 */
const EXPECTED_UPSTREAM_DEPENDENCIES = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-coding-agent",
	"agents/agent-refinements.ts",
	"agents/agents.ts",
	"agents/skills.ts",
	"api/delegation.ts",
	"jiti/static",
	"runs/foreground/subagent-executor.ts",
	"runs/shared/capability-ceiling.ts",
	"runs/shared/child-launch.ts",
	"runs/shared/child-session.ts",
	"runs/shared/child-tool-plan.ts",
	"runs/shared/model-scope.ts",
	"runs/shared/permissions.ts",
	"runs/shared/tool-budget.ts",
	"shared/launch-contract.ts",
	"shared/model-info.ts",
	"shared/session-identity.ts",
	"shared/types.ts",
	"shared/utils.ts",
] as const;

const IMPORT_SPECIFIER = /(?:^|[\s;{(])(?:import|export)\s*(?:type\s*)?(?:[^'"()]*?\bfrom\s*)?["']([^"']+)["']/gm;

function listForkOwned(extra: readonly string[] = [], root: string = sourceRoot): Set<string> {
	const owned = new Set<string>(KEPT_A1_MODULES);
	for (const entry of fs.readdirSync(path.join(root, "bound"))) owned.add(`bound/${entry}`);
	for (const entry of extra) owned.add(entry);
	return owned;
}

function importsOf(moduleName: string, root: string = sourceRoot): string[] {
	const source = fs.readFileSync(path.join(root, ...moduleName.split("/")), "utf8");
	const found: string[] = [];
	for (const match of source.matchAll(IMPORT_SPECIFIER)) {
		const specifier = match[1]!;
		if (specifier.startsWith("node:")) continue;
		if (!specifier.startsWith(".")) { found.push(specifier); continue; }
		const resolved = path.relative(root, path.resolve(path.dirname(path.join(root, ...moduleName.split("/"))), specifier));
		found.push(resolved.split(path.sep).join("/"));
	}
	return found;
}

function auditLayer(extraOwned: readonly string[] = [], root: string = sourceRoot): { owned: string[]; upstream: string[] } {
	const forkOwned = listForkOwned(extraOwned, root);
	const seen = new Set<string>();
	const upstream = new Set<string>();
	const queue = ["bound/index.ts"];
	while (queue.length) {
		const current = queue.pop()!;
		if (seen.has(current)) continue;
		seen.add(current);
		for (const dependency of importsOf(current, root)) {
			if (forkOwned.has(dependency)) queue.push(dependency);
			else upstream.add(dependency);
		}
	}
	return { owned: [...seen].sort(), upstream: [...upstream].sort() };
}

test("every manifest entry points at a real file and carries its exact bytes", () => {
	const manifest = boundLayerManifest();
	assert.equal(manifest.version, BOUND_LAYER_MANIFEST_VERSION);
	assert.equal(manifest.entries.length, BOUND_LAYER_MODULES.length);
	assert.deepEqual(manifest.entries.map((entry) => entry.name), [...BOUND_LAYER_MODULES]);
	for (const entry of manifest.entries) {
		const bytes = fs.readFileSync(boundLayerModulePath(entry.name));
		assert.equal(entry.contentDigest, createHash("sha256").update(bytes).digest("hex"));
	}
});

test("the manifest order is fixed and reading it twice is stable", () => {
	assert.deepEqual(boundLayerManifest(), boundLayerManifest());
	assert.deepEqual([...BOUND_LAYER_MODULES], [...BOUND_LAYER_MODULES].sort((left, right) => {
		const boundLeft = left.startsWith("bound/") ? 0 : 1;
		const boundRight = right.startsWith("bound/") ? 0 : 1;
		return boundLeft - boundRight || (left < right ? -1 : left > right ? 1 : 0);
	}));
	assert.equal(BOUND_LAYER_SOURCE_ROOT, sourceRoot);
});

// Acceptance criterion of step S9: by now every module of the layer exists, so
// the closure is complete.
test("the import closure of the layer entry equals the manifest, fork-owned module for fork-owned module", () => {
	const audit = auditLayer();
	assert.deepEqual(audit.owned, [...BOUND_LAYER_MODULES].sort());
	assert.deepEqual(audit.upstream, [...EXPECTED_UPSTREAM_DEPENDENCIES].sort());
});

test("a fork module outside the manifest fails the audit", () => {
	// Проба идёт по копии слоя во временном каталоге: рабочее дерево не трогается,
	// поэтому прерывание прогона не оставляет в src/bound инородный импорт.
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bound-manifest-audit-"));
	try {
		// Копируется весь src: обход спускается и в сохранённые модули A1 вне bound/.
		fs.cpSync(sourceRoot, root, { recursive: true });
		fs.writeFileSync(path.join(root, "bound", "__manifest-audit-probe.ts"), 'export const probe = 1;\n', "utf8");
		const entry = path.join(root, "bound", "index.ts");
		fs.writeFileSync(entry, `import "./__manifest-audit-probe.ts";\n${fs.readFileSync(entry, "utf8")}`, "utf8");
		const audit = auditLayer([], root);
		assert.ok(audit.owned.includes("bound/__manifest-audit-probe.ts"));
		assert.notDeepEqual(audit.owned, [...BOUND_LAYER_MODULES].sort());
		// Положительный контроль: рабочее дерево осталось нетронутым.
		assert.equal(fs.existsSync(path.join(sourceRoot, "bound", "__manifest-audit-probe.ts")), false);
		assert.deepEqual(auditLayer().owned, [...BOUND_LAYER_MODULES].sort());
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
