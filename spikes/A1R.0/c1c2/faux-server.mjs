// Faux OpenAI chat-completions SSE server on 127.0.0.1 with request counter.
import http from "node:http";

export async function startFauxServer() {
	const state = {
		count: 0,
		requests: [], // { toolNames, messagesCount, model }
		script: [], // queue of "text" | { toolCall: name }
	};
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			state.count++;
			let parsed = {};
			try { parsed = JSON.parse(body); } catch {}
			const toolNames = (parsed.tools ?? []).map((t) => t.function?.name ?? t.name).sort();
			state.requests.push({ url: req.url, model: parsed.model, toolNames, messagesCount: parsed.messages?.length });
			const step = state.script.shift() ?? "text";
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
			const chunk = (delta, finish) => ({
				id: "faux", object: "chat.completion.chunk", created: 0, model: parsed.model ?? "faux",
				choices: [{ index: 0, delta, finish_reason: finish }],
			});
			const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
			if (step !== "text" && step.toolCall) {
				send(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${state.count}`, type: "function", function: { name: step.toolCall, arguments: "{}" } }] }, null));
				send({ ...chunk({}, "tool_calls"), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
			} else {
				send(chunk({ role: "assistant", content: "ok" }, null));
				send({ ...chunk({}, "stop"), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
			}
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	return { state, port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
