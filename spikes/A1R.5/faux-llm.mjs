// Faux OpenAI chat-completions (streaming) server on 127.0.0.1; every request is counted.
// Last user text:
//   "HOLD:<key>"        -> the response stays open until release(key) or the client aborts;
//   "CALLS:[{...}]"     -> one assistant turn with those tool calls, then "DONE";
// a request offering `structured_output` gets one call of it with value {"ok":true}; otherwise "DONE".
import http from "node:http";

function textOf(message) {
	if (!message) return "";
	return typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.text ?? "").join("");
}

export async function startFauxLlm() {
	const requests = [];
	const held = new Map();
	const aborted = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			const json = JSON.parse(body || "{}");
			const messages = json.messages ?? [];
			const last = messages.at(-1);
			const firstUser = textOf(messages.find((message) => message.role === "user"));
			const tools = (json.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
			const toolTexts = messages.filter((message) => message.role === "tool").map((message) => textOf(message).slice(0, 120));
			requests.push({ tools, lastRole: last?.role, task: firstUser.slice(0, 200), toolTexts });
			const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: "faux", object: "chat.completion.chunk", created: 0, model: json.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
			const finish = () => {
				res.write(`data: ${JSON.stringify({ id: "faux", object: "chat.completion.chunk", created: 0, model: json.model, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
				res.end("data: [DONE]\n\n");
			};
			const toolCalls = (calls) => {
				chunk({ role: "assistant", content: null, tool_calls: calls.map((call, index) => ({ index, id: `call_${requests.length}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) });
				chunk({}, "tool_calls");
				finish();
			};
			const done = () => { chunk({ role: "assistant", content: "DONE" }); chunk({}, "stop"); finish(); };
			res.writeHead(200, { "content-type": "text/event-stream" });
			const hold = /HOLD:([A-Za-z0-9-]+)/u.exec(firstUser)?.[1];
			if (last?.role === "user" && hold) {
				held.set(hold, done);
				res.on("close", () => { if (held.get(hold) === done) { held.delete(hold); aborted.push(hold); } });
				return;
			}
			const calls = last?.role === "user" ? /CALLS:(\[.*\])/su.exec(textOf(last))?.[1] : undefined;
			if (calls) return toolCalls(JSON.parse(calls));
			if (last?.role === "user" && tools.includes("structured_output")) return toolCalls([{ name: "structured_output", args: { value: { ok: true } } }]);
			return done();
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		server, requests, aborted, port: server.address().port,
		isHeld: (key) => held.has(key),
		release(key) { const reply = held.get(key); held.delete(key); reply?.(); return Boolean(reply); },
	};
}
