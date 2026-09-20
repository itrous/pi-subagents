import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { attestPiRuntime, PI_RUNTIME_PACKAGE_NAME, resetPiRuntimeAttestationCache } from "../../src/bound/pi-runtime-attestation.ts";

let tempRoot = "";

function writePackage(root: string, options: { version?: string; tools?: string; extraFile?: string } = {}): string {
	fs.mkdirSync(path.join(root, "dist", "core", "tools"), { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: PI_RUNTIME_PACKAGE_NAME, version: options.version ?? "0.85.1", type: "module" }, null, 2), "utf8");
	fs.writeFileSync(path.join(root, "dist", "core", "tools", "index.js"), options.tools ?? 'export const allToolNames = ["read","bash","edit","write","grep","find","ls","powershell"];\n', "utf8");
	fs.writeFileSync(path.join(root, "dist", "marker.js"), options.extraFile ?? "export const marker = 1;\n", "utf8");
	// node_modules must never enter the attestation.
	fs.mkdirSync(path.join(root, "node_modules", "ignored"), { recursive: true });
	fs.writeFileSync(path.join(root, "node_modules", "ignored", "index.js"), "export const ignored = 1;\n", "utf8");
	return root;
}

beforeEach(() => {
	tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bound-attestation-"));
	resetPiRuntimeAttestationCache();
});

afterEach(() => {
	resetPiRuntimeAttestationCache();
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("the loaded package is attested by manifest identity, own bytes, and builtin names", async () => {
	const root = writePackage(path.join(tempRoot, "pkg"));
	const result = await attestPiRuntime({ packageRoot: root });
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.runtime.attestation.name, PI_RUNTIME_PACKAGE_NAME);
	assert.equal(result.runtime.attestation.version, "0.85.1");
	assert.equal(result.runtime.attestation.fileCount, 3);
	assert.match(result.runtime.attestation.filesDigest, /^[0-9a-f]{64}$/u);
	assert.match(result.runtime.attestation.packageRootDigest, /^[0-9a-f]{64}$/u);
	assert.deepEqual(result.runtime.runtimeBuiltins.names, ["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"]);
});

test("changing one byte of the package changes the attestation digest", async () => {
	const root = writePackage(path.join(tempRoot, "pkg"));
	const first = await attestPiRuntime({ packageRoot: root });
	assert.equal(first.ok, true);
	if (!first.ok) return;
	// Positive control: the cache would otherwise hide the change.
	const cached = await attestPiRuntime({ packageRoot: root });
	assert.equal(cached.ok && cached.runtime.attestation.filesDigest, first.runtime.attestation.filesDigest);
	fs.writeFileSync(path.join(root, "dist", "marker.js"), "export const marker = 2;\n", "utf8");
	resetPiRuntimeAttestationCache();
	const second = await attestPiRuntime({ packageRoot: root });
	assert.equal(second.ok, true);
	if (!second.ok) return;
	assert.notEqual(second.runtime.attestation.filesDigest, first.runtime.attestation.filesDigest);
	assert.equal(second.runtime.attestation.version, first.runtime.attestation.version);
});

test("a manifest version that no longer matches the loaded runtime fails closed", async () => {
	const root = writePackage(path.join(tempRoot, "pkg"));
	const first = await attestPiRuntime({ packageRoot: root });
	assert.equal(first.ok, true);
	if (!first.ok) return;
	assert.deepEqual(await attestPiRuntime({ packageRoot: root, expectedVersion: "0.85.0" }), { ok: false, code: "unverified_runtime" });
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: PI_RUNTIME_PACKAGE_NAME, version: "0.86.0", type: "module" }, null, 2), "utf8");
	resetPiRuntimeAttestationCache();
	assert.deepEqual(await attestPiRuntime({ packageRoot: root, expectedVersion: "0.85.1" }), { ok: false, code: "unverified_runtime" });
	const reattested = await attestPiRuntime({ packageRoot: root, expectedVersion: "0.86.0" });
	assert.equal(reattested.ok, true);
});

test("a foreign or unreadable package, or a missing builtin export, is unverified_runtime", async () => {
	assert.deepEqual(await attestPiRuntime({ packageRoot: path.join(tempRoot, "absent") }), { ok: false, code: "unverified_runtime" });
	const foreign = path.join(tempRoot, "foreign");
	fs.mkdirSync(foreign, { recursive: true });
	fs.writeFileSync(path.join(foreign, "package.json"), JSON.stringify({ name: "other", version: "1.0.0" }), "utf8");
	assert.deepEqual(await attestPiRuntime({ packageRoot: foreign }), { ok: false, code: "unverified_runtime" });
	const noTools = writePackage(path.join(tempRoot, "no-tools"), { tools: "export const somethingElse = 1;\n" });
	assert.deepEqual(await attestPiRuntime({ packageRoot: noTools }), { ok: false, code: "unverified_runtime" });
	const emptyTools = writePackage(path.join(tempRoot, "empty-tools"), { tools: "export const allToolNames = [];\n" });
	assert.deepEqual(await attestPiRuntime({ packageRoot: emptyTools }), { ok: false, code: "unverified_runtime" });
});

test("the resolved entry decides the package root when no root is supplied", async () => {
	const root = writePackage(path.join(tempRoot, "pkg"));
	const result = await attestPiRuntime({ resolveEntry: () => path.join(root, "dist", "marker.js") });
	assert.equal(result.ok, true);
	assert.equal(result.ok && result.runtime.packageRoot, root);
});
