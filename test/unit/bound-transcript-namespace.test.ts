import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { boundTranscriptApiOf } from "../../src/bound/bound-transcript.ts";

// Pi's `pi` command is an esbuild bundle: extensions receive `@earendil-works/pi-ai`
// and `@earendil-works/pi-agent-core` from its VIRTUAL_MODULES, where every export
// is an enumerable getter (esbuild `__export`), not the data property of a real ESM
// namespace. The transcript API must be recognised in both shapes, while a foreign
// binding (different `uuidv7`) or an unsafe accessor still refuses closed.

function uuidv7(): string { return "0"; }
function getCurrentTools(): unknown { return []; }
class Agent {}

/** The esbuild `__export(target, all)` shape: one enumerable getter per export. */
function esbuildNamespace(exports: Record<string, unknown>): object {
	const target = {};
	for (const [name, value] of Object.entries(exports)) Object.defineProperty(target, name, { get: () => value, enumerable: true });
	return target;
}

/** A real ESM namespace: data properties on a null-prototype, non-extensible object. */
async function esmNamespace(source: string): Promise<object> {
	return await import(`data:text/javascript,${encodeURIComponent(source)}`) as object;
}

test("esbuild bundle namespaces (getter exports) yield the transcript API", () => {
	const api = boundTranscriptApiOf({
		ai: esbuildNamespace({ getCurrentTools, uuidv7 }),
		core: esbuildNamespace({ Agent, uuidv7 }),
	});
	assert.ok(api, "bundled Pi exposes exports as getters; the API must still be recognised");
	assert.equal(api.getCurrentTools, getCurrentTools);
	assert.equal(api.Agent, Agent);
});

test("real ESM namespaces (data exports) yield the transcript API", async () => {
	const aiSource = "export function uuidv7() {} export function getCurrentTools() { return []; }";
	const ai = await esmNamespace(aiSource);
	// pi-agent-core re-exports pi-ai's binding: the same module URL is the same instance.
	const core = await esmNamespace(`export { uuidv7 } from "data:text/javascript,${encodeURIComponent(aiSource)}"; export class Agent {}`);
	assert.equal("value" in Object.getOwnPropertyDescriptor(ai, "uuidv7")!, true);
	assert.ok(boundTranscriptApiOf({ ai, core }));
});

test("a foreign pi-agent-core (different uuidv7 binding) refuses in the bundle shape", () => {
	assert.equal(boundTranscriptApiOf({
		ai: esbuildNamespace({ getCurrentTools, uuidv7 }),
		core: esbuildNamespace({ Agent, uuidv7: () => "other" }),
	}), undefined);
});

test("an accessor with a setter is not an export binding and refuses", () => {
	const ai = esbuildNamespace({ uuidv7 });
	Object.defineProperty(ai, "getCurrentTools", { get: () => getCurrentTools, set: () => {}, enumerable: true });
	assert.equal(boundTranscriptApiOf({ ai, core: esbuildNamespace({ Agent, uuidv7 }) }), undefined);
});

test("a throwing or non-enumerable getter refuses without throwing", () => {
	const throwing = esbuildNamespace({ uuidv7 });
	Object.defineProperty(throwing, "getCurrentTools", { get: () => { throw new Error("boom"); }, enumerable: true });
	assert.equal(boundTranscriptApiOf({ ai: throwing, core: esbuildNamespace({ Agent, uuidv7 }) }), undefined);
	const hidden = esbuildNamespace({ uuidv7 });
	Object.defineProperty(hidden, "getCurrentTools", { get: () => getCurrentTools, enumerable: false });
	assert.equal(boundTranscriptApiOf({ ai: hidden, core: esbuildNamespace({ Agent, uuidv7 }) }), undefined);
});

test("an inherited export is not an own binding and refuses", () => {
	const ai = Object.create(esbuildNamespace({ getCurrentTools, uuidv7 })) as object;
	assert.equal(boundTranscriptApiOf({ ai, core: esbuildNamespace({ Agent, uuidv7 }) }), undefined);
});

// Positive control on the real bundle: the installed Pi's VIRTUAL_MODULES chunk.
const piRoot = process.env.PI_SUBAGENTS_BUNDLED_PI;
const chunk = piRoot ? fs.readdirSync(path.join(piRoot, "dist", "bundle", "chunks")).find((name) => /^virtual-modules-.*\.js$/u.test(name)) : undefined;
test("installed Pi bundle VIRTUAL_MODULES yield the transcript API", { skip: !chunk && "Set PI_SUBAGENTS_BUNDLED_PI to the installed @earendil-works/pi-coding-agent root" }, async () => {
	const { VIRTUAL_MODULES } = await import(pathToFileURL(path.join(piRoot!, "dist", "bundle", "chunks", chunk!)).href) as { VIRTUAL_MODULES: Record<string, object> };
	const ai = VIRTUAL_MODULES["@earendil-works/pi-ai"]!, core = VIRTUAL_MODULES["@earendil-works/pi-agent-core"]!;
	assert.equal("value" in Object.getOwnPropertyDescriptor(ai, "getCurrentTools")!, false, "the bundle must expose getters, else this control tests nothing");
	assert.ok(boundTranscriptApiOf({ ai, core }));
});
