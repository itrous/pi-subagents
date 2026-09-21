import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { discoverAgents, type AgentConfig } from "../../src/agents/agents.ts";
import { resolveBoundPackageExtensions } from "../../src/bound/bound-package-extensions.ts";
import { createBoundFixture, type BoundFixture } from "../fixtures/bound/harness.ts";

let fixture: BoundFixture;
beforeEach(() => { fixture = createBoundFixture(); });
afterEach(() => { fixture.cleanup(); });

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf8");
}

/** A package agent as upstream discovery returns it: the owner package is the project root. */
function packageAgent(ref: string): AgentConfig {
	const owner = path.join(fixture.tempRoot, "owner");
	write(path.join(owner, "package.json"), JSON.stringify({ name: "fixture-owner", version: "1.0.0", pi: { subagents: { agents: ["./agents"] } } }));
	write(path.join(owner, "agents", "ext", "tool.ts"), "export default function tool(): void {}\n");
	write(path.join(fixture.tempRoot, "outside.ts"), "export default function outside(): void {}\n");
	write(path.join(owner, "agents", "leaf.md"), `---\nname: leaf\ndescription: Leaf.\ntools: read\nsubagentOnlyExtensions: ${ref}\n---\n\nAnswer.\n`);
	const agent = discoverAgents(owner, "both").agents.find((entry) => entry.name === "leaf");
	assert.equal(agent?.source, "package");
	return agent!;
}

test("a relative ref that upstream discovery made absolute keeps its relative contract spelling", () => {
	const agent = packageAgent("./ext/tool.ts");
	const [raw] = agent.subagentOnlyExtensions!;
	assert.ok(path.isAbsolute(raw!), "upstream resolves the ref against the agent file");
	const resolved = resolveBoundPackageExtensions(agent);
	assert.deepEqual(resolved.projection.map((entry) => [entry.kind, entry.ref]), [["relative", "./ext/tool.ts"]]);
	assert.deepEqual(resolved.paths, [fs.realpathSync(raw!)]);
	// `recheckBoundLaunch` resolves the contract ref back to the entry upstream put in the launch.
	assert.equal(path.resolve(path.dirname(agent.filePath), resolved.projection[0]!.ref), raw);
});

test("a ref that leaves the agent directory stays refused", () => {
	assert.throws(() => resolveBoundPackageExtensions(packageAgent("../../outside.ts")), /Invalid bound extension ref/u);
});
