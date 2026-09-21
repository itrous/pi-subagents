import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BoundPackageViolation, createBoundPackageApi, createBoundPackageToolOwnership } from "../../src/bound/bound-package-api.ts";
import {
	boundPackageFactoriesHook, createBoundPackageImporter, loadBoundPackageFactories, verifyBoundPackageAttestations,
	type BoundPackageAttestation,
} from "../../src/bound/bound-package-loader.ts";
import { packageTreeDigest } from "../../src/runs/shared/package-tree-evidence.ts";

const PROBE = "__boundPackageLoaderProbe";
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

interface Fixture {
	root: string;
	owner: string;
	pkg: string;
	entry: string;
	attest(entry?: string): BoundPackageAttestation;
}

let fixture: Fixture;

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf8");
}

/**
 * Owner package with one declared dependency under `node_modules`: the attested
 * entry lives below a `node_modules` segment of the owner, which is exactly the
 * shape of `node_modules/pi-mcp-adapter/index.ts` in the 1C leaf.
 */
function createFixture(): Fixture {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bound-package-loader-")));
	const owner = path.join(root, "owner");
	const pkg = path.join(owner, "node_modules", "fixture-ext");
	write(path.join(owner, "package.json"), JSON.stringify({ name: "fixture-owner", version: "1.0.0", dependencies: { "fixture-ext": "1.0.0" } }));
	write(path.join(pkg, "package.json"), JSON.stringify({ name: "fixture-ext", version: "1.0.0", type: "module" }));
	write(path.join(pkg, "helper.ts"), 'export const label: string = "fixture-tool";\n');
	write(path.join(pkg, "native.mjs"), 'export const native = "mjs-ok";\n');
	write(path.join(pkg, "extra.cjs"), "module.exports = 1;\n");
	write(path.join(pkg, "index.ts"), [
		'import { label } from "./helper.ts";',
		'import { native } from "./native.mjs";',
		"export default function factory(pi: any): void {",
		`\t(globalThis as any).${PROBE}?.(pi, native);`,
		"\tpi.registerTool({ name: label, label, description: label, parameters: {}, execute: async () => ({ content: [], details: {} }) });",
		"}",
		"",
	].join("\n"));
	write(path.join(pkg, "escape.ts"), 'import { outside } from "../../../outside.ts";\nexport default function factory(): string { return outside; }\n');
	write(path.join(pkg, "unmeasured.ts"), 'import { x } from "../unmeasured-pkg/x.ts";\nexport default function factory(): string { return x; }\n');
	write(path.join(owner, "node_modules", "unmeasured-pkg", "package.json"), JSON.stringify({ name: "unmeasured-pkg", version: "1.0.0" }));
	write(path.join(owner, "node_modules", "unmeasured-pkg", "x.ts"), 'export const x = "unmeasured";\n');
	write(path.join(root, "outside.ts"), 'export const outside = "outside";\n');
	const entry = path.join(pkg, "index.ts");
	return {
		root, owner, pkg, entry,
		attest(target = entry) {
			return {
				path: target,
				contentDigest: sha256(fs.readFileSync(target)),
				evidenceRoot: owner,
				evidenceRootDigest: sha256(owner),
				packageTreeDigest: packageTreeDigest(target, owner, owner),
			};
		},
	};
}

function fakePi() {
	const registered: string[] = [];
	const handlers: string[] = [];
	const pi = {
		registerTool(tool: { name: string }) { registered.push(tool.name); },
		on(event: string) { handlers.push(event); },
		setModel() { throw new Error("must not be reached"); },
		getActiveTools: () => ["read"],
	};
	return { pi: pi as unknown as ExtensionAPI, registered, handlers };
}

beforeEach(() => { fixture = createFixture(); });
afterEach(() => {
	delete (globalThis as Record<string, unknown>)[PROBE];
	fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("an attested entry below node_modules loads and its factory receives the facade", async () => {
	const loaded = await loadBoundPackageFactories([fixture.attest()]);
	assert.equal(loaded.ok, true, JSON.stringify(loaded));
	if (!loaded.ok) return;
	assert.deepEqual(loaded.factories.map((factory) => factory.path), [fixture.entry]);
	let received: ExtensionAPI | undefined;
	let native: unknown;
	(globalThis as Record<string, unknown>)[PROBE] = (pi: ExtensionAPI, value: unknown) => { received = pi; native = value; };
	const host = fakePi();
	const violations: BoundPackageViolation[] = [];
	const hook = boundPackageFactoriesHook(loaded.factories, {
		runtimeBuiltins: ["read"], internalTools: [], barrierCommitted: () => false,
		onViolation: (violation) => violations.push(violation), onFactoryError: () => {},
	});
	await hook.factory(host.pi);
	assert.deepEqual(host.registered, ["fixture-tool"]);
	assert.ok(received && received !== host.pi, "the factory gets a facade, not the host API");
	assert.equal(native, "mjs-ok", "a native .mjs inside the tree does not break loading");
	assert.throws(() => (received as unknown as { setModel(): void }).setModel(), BoundPackageViolation);
	assert.equal(violations.length, 1);
});

test("a changed entry byte refuses the load as package_bytes_drift", async () => {
	const attestation = fixture.attest();
	fs.appendFileSync(fixture.entry, "\n");
	assert.deepEqual(await loadBoundPackageFactories([attestation]), { ok: false, code: "package_bytes_drift" });
});

test("a changed byte elsewhere in the tree refuses the load as package_bytes_drift", async () => {
	const attestation = fixture.attest();
	fs.appendFileSync(path.join(fixture.pkg, "helper.ts"), "\n");
	assert.deepEqual(await loadBoundPackageFactories([attestation]), { ok: false, code: "package_bytes_drift" });
});

test("an .mjs entry and a symlinked entry are refused even with matching digests", async () => {
	assert.deepEqual(await loadBoundPackageFactories([fixture.attest(path.join(fixture.pkg, "native.mjs"))]), { ok: false, code: "package_bytes_drift" });
	// The link sits where the tree walk does not look (a `node_modules` directory),
	// so only the entry check can refuse it.
	const attestation = { ...fixture.attest(fixture.entry), path: path.join(fixture.owner, "node_modules", "link.ts") };
	fs.symlinkSync(fixture.entry, attestation.path);
	assert.deepEqual(verifyBoundPackageAttestations([attestation]), { ok: false, code: "package_bytes_drift" });
});

test("positive control: .mjs and .cjs inside the tree, not as the entry, keep the attestation valid", () => {
	const verified = verifyBoundPackageAttestations([fixture.attest()]);
	assert.equal(verified.ok, true);
	if (verified.ok) assert.deepEqual(verified.roots, [fixture.owner, fixture.pkg]);
});

test("an import beyond the attested roots throws from transform", async () => {
	const verified = verifyBoundPackageAttestations([fixture.attest()]);
	assert.equal(verified.ok, true);
	if (!verified.ok) return;
	const importer = createBoundPackageImporter(verified.roots);
	await assert.rejects(importer.import(path.join(fixture.pkg, "escape.ts")), /escaped its attested roots/);
	// An unmeasured package under the owner's node_modules is outside every root.
	await assert.rejects(importer.import(path.join(fixture.pkg, "unmeasured.ts")), /escaped its attested roots/);
	// Positive control: an import inside a root passes.
	assert.equal(typeof await importer.import(fixture.entry), "function");
	assert.deepEqual(await loadBoundPackageFactories([fixture.attest(path.join(fixture.pkg, "escape.ts"))]), { ok: false, code: "package_load_error" });
});

test("the facade refuses an occupied name, a foreign package's name, and any registration after the barrier", () => {
	const host = fakePi();
	const violations: BoundPackageViolation[] = [];
	let barrier = false;
	const ownership = createBoundPackageToolOwnership(["read", "bash"], ["structured_output"]);
	const options = { barrierCommitted: () => barrier, onViolation: (violation: BoundPackageViolation) => violations.push(violation) };
	const first = createBoundPackageApi(host.pi, ownership, options);
	const second = createBoundPackageApi(host.pi, ownership, options);
	const tool = (name: string) => ({ name, label: name, description: name, parameters: {}, execute: async () => ({ content: [], details: {} }) }) as never;
	for (const occupied of ["read", "edit", "structured_output", "subagent_wait"]) assert.throws(() => first.registerTool(tool(occupied)), BoundPackageViolation);
	first.registerTool(tool("bsl-search"));
	assert.throws(() => second.registerTool(tool("bsl-search")), BoundPackageViolation);
	first.on("session_start", () => {});
	assert.throws(() => first.on("before_agent_start", () => {}), BoundPackageViolation);
	barrier = true;
	assert.throws(() => first.registerTool(tool("bsl-other")), BoundPackageViolation);
	assert.throws(() => first.setActiveTools(["read"]), BoundPackageViolation);
	assert.throws(() => first.on("session_shutdown", () => {}), BoundPackageViolation);
	assert.deepEqual(host.registered, ["bsl-search"]);
	assert.deepEqual(host.handlers, ["session_start"]);
	assert.equal(violations.length, 9);
});

test("package factories of one run share a private events bus; the host bus stays unreachable", async () => {
	const host = fakePi();
	const hostBus: string[] = [];
	(host.pi as unknown as { events: unknown }).events = { emit: () => hostBus.push("emit"), on: () => { hostBus.push("on"); return () => {}; } };
	const received: unknown[] = [];
	const factories = [
		{ path: "/listener.ts", allowInputRegistrationNoop: false, factory: (pi: ExtensionAPI) => { pi.events.on("mcp:approval", (data) => { received.push(data); }); } },
		// pi-mcp-adapter emits its tool-approval request on `pi.events` before every MCP call.
		{ path: "/emitter.ts", allowInputRegistrationNoop: false, factory: (pi: ExtensionAPI) => { pi.events.emit("mcp:approval", { tool: "bsl-ws_search" }); } },
	];
	const hook = boundPackageFactoriesHook(factories, {
		runtimeBuiltins: ["read"], internalTools: [], barrierCommitted: () => false, onViolation: () => {}, onFactoryError: () => {},
	});
	await hook.factory(host.pi);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(received, [{ tool: "bsl-ws_search" }]);
	assert.deepEqual(hostBus, []);
	// A second run gets a bus of its own.
	received.length = 0;
	const lone = boundPackageFactoriesHook([factories[1]!], { runtimeBuiltins: ["read"], internalTools: [], barrierCommitted: () => false, onViolation: () => {}, onFactoryError: () => {} });
	await lone.factory(host.pi);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(received, []);
});

test("the facade opens only the current child's read-only ctx.sessionManager.getSessionId()", async () => {
	class ChildSessionManager {
		sessionId = "child-session-1";
		leafId: string | null = "leaf-1";
		getSessionId() { return this.sessionId; }
		getSessionFile() { return "/child.jsonl"; }
		getEntries() { return []; }
		appendMessage() { this.leafId = "leaf-2"; return "leaf-2"; }
		newSession() { this.sessionId = "replaced"; }
	}
	const sessionManager = new ChildSessionManager();
	const ctx = { cwd: "/work", sessionManager };
	const handlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
	const tools: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> = [];
	const pi = {
		on(_event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.push(handler); },
		registerTool(tool: { execute: (...args: unknown[]) => Promise<unknown> }) { tools.push(tool); },
	} as unknown as ExtensionAPI;
	const violations: BoundPackageViolation[] = [];
	const api = createBoundPackageApi(pi, createBoundPackageToolOwnership([], []), { barrierCommitted: () => false, onViolation: (violation) => violations.push(violation) });
	const seen: unknown[] = [];
	api.on("session_start", (_event, facadeCtx) => { seen.push(facadeCtx.sessionManager); });
	api.registerTool({ name: "bsl-bindings", label: "b", description: "b", parameters: {}, execute: async (_id, _params, _signal, _update, facadeCtx) => { seen.push(facadeCtx.sessionManager); return { content: [], details: {} }; } } as never);
	await handlers[0]!({}, ctx);
	await tools[0]!.execute("call-1", {}, undefined, undefined, ctx);
	assert.equal(seen.length, 2);
	for (const facade of seen as ChildSessionManager[]) {
		assert.notEqual(facade, sessionManager);
		assert.equal(facade.getSessionId(), "child-session-1");
		for (const method of ["getSessionFile", "getEntries", "appendMessage", "newSession"] as const) {
			assert.throws(() => (facade[method] as () => unknown)(), (error: unknown) => error instanceof BoundPackageViolation && error.operation === `ctx.sessionManager.${method}`);
		}
		assert.throws(() => { facade.sessionId = "forged"; }, BoundPackageViolation);
		assert.throws(() => { (facade as unknown as Record<string, unknown>).getSessionId = () => "forged"; }, BoundPackageViolation);
		assert.equal(facade.getSessionId(), "child-session-1");
	}
	assert.equal(violations.length, 12);
	assert.equal(sessionManager.sessionId, "child-session-1");
	assert.equal(sessionManager.leafId, "leaf-1");
});
