import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { attestBoundRuntimeExtensions } from "../../src/runs/shared/bound-runtime-evidence.ts";
import { packageEvidenceRoot, packageTreeDigest } from "../../src/runs/shared/package-tree-evidence.ts";
import {
	BOUND_TOOL_REGISTRY_ACTIVE_ENV,
	BOUND_TOOL_REGISTRY_FD_ENV,
	BOUND_TOOL_REGISTRY_POLICY_ENV,
	boundPiVersionProbeArgs,
	createBoundPackageApi,
	initializeBoundToolRegistryBootstrap,
	loadBoundPackageFactories,
	registerBoundToolRegistryGate,
	resetBoundToolRegistryRuntimeForTests,
} from "../../src/runs/shared/bound-tool-registry-runtime.ts";

function policy(packageExtensionPaths: string[] = [], modelApi = "openai-responses") {
	process.env[BOUND_TOOL_REGISTRY_ACTIVE_ENV] = "1";
	const packageExtensions = packageExtensionPaths.map((entry) => {
		const evidenceRoot = packageEvidenceRoot(path.dirname(entry));
		return { path: entry, contentDigest: createHash("sha256").update(fs.readFileSync(entry)).digest("hex"), evidenceRoot, evidenceRootDigest: createHash("sha256").update(evidenceRoot).digest("hex"), packageTreeDigest: packageTreeDigest(entry, evidenceRoot) };
	});
	const sharedDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../src/runs/shared");
	const runtimeExtensions = attestBoundRuntimeExtensions([
		path.join(sharedDir, "bound-tool-registry-bootstrap.ts"), path.join(sharedDir, "subagent-prompt-runtime.ts"), path.join(sharedDir, "bound-package-mediator.ts"), path.join(sharedDir, "bound-tool-registry-gate.ts"),
	]);
	return { version: 1, modelApi, piRuntimeVersion: "0.84.2", proofNonce: "d".repeat(64), denialFd: 4, required: ["a"], internalTools: [], packageExtensions, runtimeExtensions };
}

function openAiPayload() {
	return { model: "x", tools: [{ type: "function", name: "a", description: "x", parameters: {} }] };
}

describe("bound tool registry child runtime", () => {
	const originalArgv1 = process.argv[1];
	const fakePiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "registry-runtime-pi-package-"));
	const fakePiCli = path.join(fakePiRoot, "dist", "cli.js");
	fs.mkdirSync(path.dirname(fakePiCli), { recursive: true });
	fs.writeFileSync(fakePiCli, "if (process.argv.includes('--version')) console.log('0.84.2');\n");
	before(() => { process.argv[1] = fakePiCli; });
	after(() => {
		if (originalArgv1 === undefined) delete process.argv[1]; else process.argv[1] = originalArgv1;
		fs.rmSync(fakePiRoot, { recursive: true, force: true });
	});
	afterEach(() => {
		delete process.env[BOUND_TOOL_REGISTRY_ACTIVE_ENV];
		delete process.env[BOUND_TOOL_REGISTRY_POLICY_ENV];
		delete process.env[BOUND_TOOL_REGISTRY_FD_ENV];
		resetBoundToolRegistryRuntimeForTests();
	});

	it("probes script wrappers and standalone Pi with the correct argv shape", () => {
		assert.deepEqual(boundPiVersionProbeArgs(["/usr/bin/node", "/wrapper/pi.js", "-p"]), ["/wrapper/pi.js", "--version"]);
		assert.deepEqual(boundPiVersionProbeArgs(["/standalone/pi", "--no-session", "-p"]), ["--version"]);
	});

	it("ignores and removes ambient proof variables without the active-bound marker", async () => {
		process.env[BOUND_TOOL_REGISTRY_POLICY_ENV] = "not-json";
		process.env[BOUND_TOOL_REGISTRY_FD_ENV] = "3";
		initializeBoundToolRegistryBootstrap();
		await loadBoundPackageFactories({} as any);
		assert.equal(process.env[BOUND_TOOL_REGISTRY_POLICY_ENV], undefined);
		assert.equal(process.env[BOUND_TOOL_REGISTRY_FD_ENV], undefined);
	});

	it("returns a detached exact outgoing payload and writes one projection", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-runtime-"));
		const output = path.join(root, "proof");
		const fd = fs.openSync(output, "w");
		process.env[BOUND_TOOL_REGISTRY_POLICY_ENV] = JSON.stringify(policy());
		process.env[BOUND_TOOL_REGISTRY_FD_ENV] = String(fd);
		initializeBoundToolRegistryBootstrap();
		assert.equal(process.env[BOUND_TOOL_REGISTRY_POLICY_ENV], undefined);
		let providerHandler: ((event: { payload: unknown }, ctx: any) => unknown) | undefined;
		const pi = {
			on(event: string, handler: (event: { payload: unknown }, ctx: any) => unknown) { if (event === "before_provider_request") providerHandler = handler; },
			getActiveTools() { return ["a"]; },
		} as any;
		registerBoundToolRegistryGate(pi);
		const original = { model: "x", tools: [{ type: "function", name: "a", description: "x", parameters: {} }] };
		const outgoing = providerHandler!({ payload: original }, { model: { api: "openai-responses" } }) as typeof original;
		assert.notEqual(outgoing, original);
		original.tools[0]!.name = "mutated";
		assert.equal(outgoing.tools[0]!.name, "a");
		const frame = JSON.parse(fs.readFileSync(output, "utf8"));
		assert.equal(frame.kind, "registry");
		assert.deepEqual(frame.projection.effectiveCallerTools, ["a"]);
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("serializes pi-messages exactly as its provider before proof", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-runtime-pi-messages-"));
		const output = path.join(root, "proof");
		const fd = fs.openSync(output, "w");
		process.env[BOUND_TOOL_REGISTRY_POLICY_ENV] = JSON.stringify(policy([], "pi-messages"));
		process.env[BOUND_TOOL_REGISTRY_FD_ENV] = String(fd);
		initializeBoundToolRegistryBootstrap();
		let providerHandler: ((event: { payload: unknown }, ctx: any) => unknown) | undefined;
		const pi = { on(_event: string, handler: typeof providerHandler) { providerHandler = handler; }, getActiveTools() { return ["a"]; } } as any;
		registerBoundToolRegistryGate(pi);
		const constrainedSampling = { type: "json_schema", strict: "prefer" };
		const outgoing = providerHandler!({ payload: { model: "x", context: { tools: [{ name: "a", label: "A", description: "x", parameters: {}, constrainedSampling, execute() {} }] }, options: {} } }, { model: { api: "pi-messages" } }) as any;
		assert.deepEqual(outgoing.context.tools[0], { name: "a", label: "A", description: "x", parameters: {}, constrainedSampling });
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("omits Google abortSignal only while cloning and restores the validated transport signal", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-runtime-google-"));
		const output = path.join(root, "proof");
		const fd = fs.openSync(output, "w");
		process.env[BOUND_TOOL_REGISTRY_POLICY_ENV] = JSON.stringify(policy([], "google-generative-ai"));
		process.env[BOUND_TOOL_REGISTRY_FD_ENV] = String(fd);
		initializeBoundToolRegistryBootstrap();
		let providerHandler: ((event: { payload: unknown }, ctx: any) => unknown) | undefined;
		const pi = { on(_event: string, handler: typeof providerHandler) { providerHandler = handler; }, getActiveTools() { return ["a"]; } } as any;
		registerBoundToolRegistryGate(pi);
		const signal = new AbortController().signal;
		const original = { model: "x", contents: [], config: { abortSignal: signal, tools: [{ functionDeclarations: [{ name: "a", description: "x", parametersJsonSchema: {} }] }] } };
		const outgoing = providerHandler!({ payload: original }, { model: { api: "google-generative-ai" } }) as any;
		assert.notEqual(outgoing, original);
		assert.notEqual(outgoing.config, original.config);
		assert.equal(outgoing.config.abortSignal, signal);
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("rejects a child model API that drifts from the bound policy", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-runtime-model-api-"));
		const output = path.join(root, "proof");
		const fd = fs.openSync(output, "w");
		process.env[BOUND_TOOL_REGISTRY_POLICY_ENV] = JSON.stringify(policy());
		process.env[BOUND_TOOL_REGISTRY_FD_ENV] = String(fd);
		const originalExit = process.exit; (process as any).exit = (code: number) => { throw new Error(`exit:${code}`); };
		let providerHandler: ((event: { payload: unknown }, ctx: any) => unknown) | undefined;
		try {
			initializeBoundToolRegistryBootstrap();
			const pi = { on(_event: string, handler: typeof providerHandler) { providerHandler = handler; }, getActiveTools() { return ["a"]; } } as any;
			registerBoundToolRegistryGate(pi);
			assert.throws(() => providerHandler!({ payload: openAiPayload() }, { model: { api: "anthropic-messages" } }), /exit:78/);
		} finally { process.exit = originalExit; }
		assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).code, "model_api_drift");
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("fails stop when proof writing throws", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-runtime-write-failure-"));
		const fd = fs.openSync(path.join(root, "proof"), "w");
		process.env[BOUND_TOOL_REGISTRY_POLICY_ENV] = JSON.stringify(policy()); process.env[BOUND_TOOL_REGISTRY_FD_ENV] = String(fd);
		const originalExit = process.exit; (process as any).exit = (code: number) => { throw new Error(`exit:${code}`); };
		let providerHandler: ((event: { payload: unknown }, ctx: any) => unknown) | undefined;
		try {
			initializeBoundToolRegistryBootstrap(); fs.closeSync(fd);
			registerBoundToolRegistryGate({ on(_event: string, handler: typeof providerHandler) { providerHandler = handler; }, getActiveTools() { return ["a"]; } } as any);
			assert.throws(() => providerHandler!({ payload: openAiPayload() }, { model: { api: "openai-responses" } }), /exit:78/);
		} finally { process.exit = originalExit; fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("loads TypeScript package factories with Pi-compatible jiti semantics", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-runtime-jiti-"));
		const extension = path.join(root, "extension.ts"); fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pi-mcp-adapter", version: "1.0.0" }));
		fs.writeFileSync(extension, "export default function (pi: any) { pi.on('input', () => ({ action: 'handled' })); pi.registerTool({ name: 'a', label: 'A', description: 'A', parameters: {}, async execute() { return { content: [] }; } }); }\n");
		const output = path.join(root, "proof");
		const fd = fs.openSync(output, "w");
		process.env[BOUND_TOOL_REGISTRY_POLICY_ENV] = JSON.stringify(policy([extension]));
		process.env[BOUND_TOOL_REGISTRY_FD_ENV] = String(fd);
		initializeBoundToolRegistryBootstrap();
		const registered: string[] = [];
		await loadBoundPackageFactories({ on() { throw new Error("input hook must not be delegated"); }, registerTool(tool: { name: string }) { registered.push(tool.name); } } as any);
		assert.deepEqual(registered, ["a"]);
		fs.closeSync(fd);
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("rejects package imports which escape the attested resolution root", async () => {
		const parent = fs.mkdtempSync(path.join(os.tmpdir(), "registry-runtime-escape-"));
		const root = path.join(parent, "package"); fs.mkdirSync(root);
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "probe", version: "1.0.0" }));
		fs.writeFileSync(path.join(parent, "outside.ts"), "export const outside = true;\n");
		const extension = path.join(root, "extension.ts");
		fs.writeFileSync(extension, "import { outside } from '../outside.ts'; export default function () { if (!outside) throw new Error(); }\n");
		const output = path.join(parent, "proof"); const fd = fs.openSync(output, "w");
		process.env[BOUND_TOOL_REGISTRY_POLICY_ENV] = JSON.stringify(policy([extension]));
		process.env[BOUND_TOOL_REGISTRY_FD_ENV] = String(fd);
		const originalExit = process.exit; (process as any).exit = (code: number) => { throw new Error(`exit:${code}`); };
		try { initializeBoundToolRegistryBootstrap(); await assert.rejects(loadBoundPackageFactories({} as any), /exit:78/); }
		finally { process.exit = originalExit; }
		assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).code, "package_load_error");
		fs.rmSync(parent, { recursive: true, force: true });
	});

	it("suppresses command surfaces and exposes detached immutable model views", () => {
		const registered: string[] = [];
		const model = { id: "m", api: "openai-responses", baseUrl: "https://trusted.example" };
		const scopedModels = [{ model }];
		const rawRegistry = { getAll: () => [] };
		const rawSetModel = () => { throw new Error("must not delegate"); };
		const pi = {
			registerCommand() { throw new Error("must not delegate"); },
			setModel: rawSetModel,
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				registered.push(event);
				handler({}, { modelRegistry: rawRegistry, model, scopedModels, getModel: () => model, isIdle: () => true });
			},
		} as any;
		const mediated = createBoundPackageApi(pi) as any;
		mediated.registerCommand("mcp", () => {});
		assert.equal(Object.getPrototypeOf(mediated), null);
		assert.notEqual(Object.getOwnPropertyDescriptor(mediated, "setModel")?.value, rawSetModel);
		mediated.on("session_start", (_event: unknown, ctx: any) => {
			assert.equal(ctx.isIdle(), true);
			assert.notEqual(ctx.model, model);
			assert.notEqual(ctx.scopedModels, scopedModels);
			assert.notEqual(ctx.getModel(), model);
			assert.equal(Object.getPrototypeOf(ctx), null);
			assert.notEqual(Object.getOwnPropertyDescriptor(ctx, "model")?.value, model);
			assert.notEqual(Object.getOwnPropertyDescriptor(ctx, "modelRegistry")?.value, rawRegistry);
			assert.throws(() => { ctx.model.baseUrl = "https://evil.example"; }, TypeError);
		});
		assert.equal(model.baseUrl, "https://trusted.example");
		assert.deepEqual(registered, ["session_start"]);
	});
});
