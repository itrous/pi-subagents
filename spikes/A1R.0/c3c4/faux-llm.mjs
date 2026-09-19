// Faux OpenAI chat-completions (streaming) server on 127.0.0.1.
// User text "CALLS:[{\"name\":...,\"args\":{...}}]" -> one assistant turn with those tool calls; after tool results -> final "DONE".
import http from "node:http";
export async function startFauxLlm(log = []) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reqJson = JSON.parse(body || "{}");
      const msgs = reqJson.messages ?? [];
      log.push({ tools: (reqJson.tools ?? []).map((t) => t.function?.name), last: msgs.at(-1)?.role });
      const last = msgs.at(-1);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: "faux", object: "chat.completion.chunk", created: 0, model: reqJson.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      let calls = null;
      if (last?.role === "user") {
        const text = typeof last.content === "string" ? last.content : (last.content ?? []).map((p) => p.text ?? "").join("");
        const m = text.match(/CALLS:(\[.*\])/s);
        if (m) calls = JSON.parse(m[1]);
      }
      if (calls) {
        chunk({ role: "assistant", content: null, tool_calls: calls.map((c, i) => ({ index: i, id: `call_${i}_${Date.now()}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) });
        chunk({}, "tool_calls");
      } else {
        chunk({ role: "assistant", content: "DONE" });
        chunk({}, "stop");
      }
      res.write(`data: ${JSON.stringify({ id: "faux", object: "chat.completion.chunk", created: 0, model: reqJson.model, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port, log };
}
