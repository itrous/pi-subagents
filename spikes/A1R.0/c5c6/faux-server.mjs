// Faux OpenAI-compatible chat completions server: 1st turn -> call first "spike_*" tool, after tool result -> text.
import http from "node:http";
export function startFaux(log = () => {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let j = {};
        try { j = JSON.parse(body || "{}"); } catch {}
        const msgs = j.messages || [];
        const hasToolResult = msgs.some((m) => m.role === "tool");
        const tool = (j.tools || []).map((t) => t.function?.name).find((n) => n?.startsWith("spike_"));
        log(`faux ${req.method} ${req.url} msgs=${msgs.length} toolResult=${hasToolResult} tool=${tool}`);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: j.model || "faux-1" };
        const send = (o) => res.write(`data: ${JSON.stringify({ ...base, ...o })}\n\n`);
        if (!hasToolResult && tool) {
          send({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: tool, arguments: "{}" } }] }, finish_reason: null }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
        } else {
          send({ choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        }
        send({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
        res.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}
