// A1R.2: дифференциальная сверка MCP-разбора — версия форка (main) против базы upstream.
// Запуск: PI_CODING_AGENT_DIR=<fixture>/agent node --experimental-strip-types mcp-diff.mjs <repoRoot> <fixtureRoot>
import fs from "node:fs";
import path from "node:path";

const repo = process.argv[2];
const fixture = process.argv[3];

const PAIRS = [
	["bsl-ws", "search"], ["bsl-ws", "symbol_info"], ["bsl-ws", "graph"], ["bsl-ws", "metadata"],
	["bsl-ws", "diagnostics"], ["bsl-ws", "query"], ["bsl-ws", "event_log"],
	["bsl-ref", "syntax_help"], ["bsl-ref", "search"], ["bsl-ref", "its_help"],
];
const SELECTORS = PAIRS.map(([s, t]) => `${s}/${t}`);

const servers = {
	"bsl-ws": { command: "bsl-ws-stub", args: ["--serve"] },
	"bsl-ref": { command: "bsl-ref-stub", args: [] },
};
const toolsOf = (server) => PAIRS.filter(([s]) => s === server).map(([, t]) => ({ name: t }));

const agentDir = path.join(fixture, "agent");
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));

// configHash берём из самой реализации базы — обе версии считают его одинаково.
const { computeMcpServerHash } = await import(path.join(repo, "src/runs/shared/mcp-direct-tool-allowlist.ts"));
const hashOf = (def) => computeMcpServerHash(def);

const cache = { version: 1, servers: {} };
for (const name of Object.keys(servers)) {
	cache.servers[name] = { configHash: hashOf(servers[name]), tools: toolsOf(name), resources: [], cachedAt: Date.now() };
}
fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify(cache, null, 2));

const project = path.join(fixture, "project");
fs.mkdirSync(project, { recursive: true });

const names = async (modulePath, selectors) => {
	const mod = await import(modulePath);
	const sel = mod.resolveMcpDirectToolSelections(selectors, project);
	return sel.map((entry) => entry.name).sort();
};

const forkPath = path.join(repo, "src/runs/shared/__fork-mcp-allowlist.ts");
const basePath = path.join(repo, "src/runs/shared/mcp-direct-tool-allowlist.ts");

const exclude = SELECTORS.filter((s) => s !== "bsl-ws/event_log");

const fork10 = await names(forkPath, SELECTORS);
const base10 = await names(basePath, SELECTORS);
const fork9 = await names(forkPath, exclude);
const base9 = await names(basePath, exclude);

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const result = {
	forkNames: fork10,
	baseNames: base10,
	equal10: same(fork10, base10),
	count10: { fork: fork10.length, base: base10.length },
	control9: { fork: fork9.length, base: base9.length, equal: same(fork9, base9) },
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.equal10 && result.count10.fork === 10 && result.control9.equal && result.control9.fork === 9 ? 0 : 1);
