// Minimal stdio MCP server (newline-delimited JSON-RPC), no deps. Marker arg lets tests count processes.
import { createInterface } from "node:readline";
const TOOLS = ["alpha", "beta", "gamma", "delta"].map((name) => ({
  name,
  description: `fixture tool ${name}`,
  inputSchema: { type: "object", properties: { x: { type: "string" } } },
}));
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notification
  switch (msg.method) {
    case "initialize":
      return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } } });
    case "tools/list":
      return send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    case "tools/call":
      return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `fixture:${msg.params.name}:pid=${process.pid}` }] } });
    case "ping":
      return send({ jsonrpc: "2.0", id: msg.id, result: {} });
    default:
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } });
  }
});
rl.on("close", () => process.exit(0));
