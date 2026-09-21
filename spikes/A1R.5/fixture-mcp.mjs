// Minimal stdio MCP server (newline-delimited JSON-RPC), no deps, no network.
//   usage: node fixture-mcp.mjs <marker> <tool,tool,...> [initializeDelayMs]
// The delay stands in for a real server's start-up time.
import { createInterface } from "node:readline";

const [marker, list, delay] = process.argv.slice(2);
const TOOLS = (list ?? "").split(",").filter(Boolean).map((name) => ({
	name,
	description: `fixture tool ${name}`,
	inputSchema: { type: "object", properties: { q: { type: "string" } } },
}));
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
	let message;
	try { message = JSON.parse(line); } catch { return; }
	if (message.id === undefined) return;
	switch (message.method) {
		case "initialize":
			return void setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: marker, version: "1.0.0" } } }), Number(delay ?? 0));
		case "tools/list":
			return send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
		case "tools/call":
			return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `fixture:${marker}:${message.params.name}` }] } });
		case "ping":
			return send({ jsonrpc: "2.0", id: message.id, result: {} });
		default:
			return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${message.method}` } });
	}
}).on("close", () => process.exit(0));
