import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createBoundRuntimeService, type BoundRuntimeServiceOptions } from "../../src/bound/bound-runtime-service.ts";
import { getBoundIdentityRegistry, type BoundIdentityRegistryV1 } from "../../src/slash/bound-identity-registry.ts";
import { setChildSessionFactory, type ChildSession, type ChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { createBoundFixture, FIXTURE_MODELS, type BoundFixture } from "../fixtures/bound/harness.ts";

let fixture: BoundFixture;

beforeEach(() => { fixture = createBoundFixture(); });
afterEach(() => {
	setChildSessionFactory(undefined);
	fixture.cleanup();
});

interface Observation {
	paths: string[];
	sessionsCreated: number;
	subscriptions: number;
	identities: number;
	environment: string;
	providerTraps: string[];
}

function listPaths(root: string): string[] {
	const found: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : 1)) {
			const absolute = path.join(directory, entry.name);
			found.push(path.relative(root, absolute));
			if (entry.isDirectory()) walk(absolute);
		}
	};
	walk(root);
	return found;
}

function scriptedFactory(): { factory: ChildSessionFactory; created: () => number } {
	let created = 0;
	const factory: ChildSessionFactory = {
		async create() {
			created++;
			const child: ChildSession = {
				subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, followUp: async () => {},
				abort: async () => {}, dispose: async () => {}, messages: [], sessionFile: undefined,
				sessionId: `scripted-${created}`, modelId: undefined,
			} as unknown as ChildSession;
			return child;
		},
		async dispose() {},
	};
	return { factory, created: () => created };
}

/** Everything the preflight is forbidden to touch, sampled around one call. */
async function observe(run: (context: {
	options: Record<string, unknown>;
	registry: BoundIdentityRegistryV1;
	factory: ChildSessionFactory;
	events: { on(event: string, handler: (data: unknown) => void): () => void; emit(event: string, data: unknown): void; subscriptions: number };
	piHandlers: number;
}) => Promise<void>): Promise<{ before: Observation; after: Observation }> {
	// The same registry instance the launch bridge reserves into; a preflight that
	// consumed prospectiveRunId would show up in its size().
	const registry = getBoundIdentityRegistry({});
	const scripted = scriptedFactory();
	setChildSessionFactory(scripted.factory);
	const bus = {
		subscriptions: 0,
		on(_event: string, _handler: (data: unknown) => void) { bus.subscriptions++; return () => { bus.subscriptions--; }; },
		emit() {},
	};
	let piHandlers = 0;
	const providerTraps: string[] = [];
	const provider = new Proxy({ complete: () => "never" }, {
		get(target, key, receiver) { providerTraps.push(`get:${String(key)}`); return Reflect.get(target, key, receiver); },
		apply() { providerTraps.push("apply"); return undefined; },
	});
	const context = {
		cwd: fs.realpathSync(fixture.project),
		sessionManager: fixture.context().sessionManager,
		modelRegistry: { getAvailable: () => FIXTURE_MODELS, provider },
		hasUI: false,
		pi: { on: () => { piHandlers++; } },
	};
	const options = fixture.serviceOptions({ getContext: () => context });
	const sample = (): Observation => ({
		paths: [...listPaths(fixture.tempRoot)],
		sessionsCreated: scripted.created(),
		subscriptions: bus.subscriptions,
		identities: registry.size(),
		environment: JSON.stringify(Object.entries(process.env).sort()),
		providerTraps: [...providerTraps],
	});
	const before = sample();
	await run({ options, registry, factory: scripted.factory, events: bus, piHandlers });
	// piHandlers is read after the run through the same closure variable.
	const after = { ...sample(), piHandlers } as Observation & { piHandlers?: number };
	assert.equal(piHandlers, 0, "preflight registered an extension handler");
	return { before, after };
}

test("preflight leaves the filesystem, sessions, subscriptions, identities, process.env, and the provider untouched", async () => {
	const { before, after } = await observe(async ({ options }) => {
		const service = createBoundRuntimeService(options as unknown as BoundRuntimeServiceOptions);
		const outcome = await service.preflight(fixture.request());
		assert.ok(outcome && outcome.ok, "expected a resolved contract");
		service.dispose();
	});
	assert.deepEqual(after.paths, before.paths);
	assert.equal(after.sessionsCreated, before.sessionsCreated);
	assert.equal(after.subscriptions, before.subscriptions);
	assert.equal(after.identities, before.identities);
	assert.equal(after.environment, before.environment);
	assert.deepEqual(after.providerTraps, []);
});

test("a dirty twin fails every one of the six observations", async () => {
	const { before, after } = await observe(async ({ options, registry, factory, events }) => {
		const context = (options.getContext as () => { modelRegistry: { provider: { complete: () => string } } })();
		fs.mkdirSync(path.join(fixture.tempRoot, "side-effect"), { recursive: true });
		await factory.create({} as never);
		events.on("some:event", () => {});
		registry.reserve("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "123e4567-e89b-12d3-a456-426614174000");
		process.env.PI_SUBAGENTS_DIRTY_TWIN = "1";
		context.modelRegistry.provider.complete();
	});
	delete process.env.PI_SUBAGENTS_DIRTY_TWIN;
	assert.notDeepEqual(after.paths, before.paths);
	assert.notEqual(after.sessionsCreated, before.sessionsCreated);
	assert.notEqual(after.subscriptions, before.subscriptions);
	assert.notEqual(after.identities, before.identities);
	assert.notEqual(after.environment, before.environment);
	assert.notDeepEqual(after.providerTraps, []);
});

test("a refused preflight is just as free of side effects", async () => {
	const { before, after } = await observe(async ({ options }) => {
		const service = createBoundRuntimeService(options as unknown as BoundRuntimeServiceOptions);
		const outcome = await service.preflight(fixture.request({ agent: "absent-agent" }));
		assert.deepEqual(outcome, { ok: false, error: { version: 2, code: "missing_agent" } });
		service.dispose();
	});
	assert.deepEqual(after.paths, before.paths);
	assert.equal(after.sessionsCreated, before.sessionsCreated);
	assert.equal(after.subscriptions, before.subscriptions);
	assert.equal(after.identities, before.identities);
	assert.equal(after.environment, before.environment);
	assert.deepEqual(after.providerTraps, []);
});
