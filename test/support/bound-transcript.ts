import type { BoundTranscriptApi } from "../../src/bound/bound-transcript.ts";

export interface TranscriptTool { name: string; description: string; parameters: object }

/** Tier-1 stand-in for pi-ai 0.87 `getCurrentTools`: the same replay of system-message deltas. */
export const TEST_TRANSCRIPT_API: Pick<BoundTranscriptApi, "getCurrentTools"> = {
	getCurrentTools(messages) {
		const tools = new Map<string, unknown>();
		for (const message of messages as Array<{ role?: string; toolsAdded?: TranscriptTool[]; toolsRemoved?: TranscriptTool[] }>) {
			if (message.role !== "system") continue;
			for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
			for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
		}
		return [...tools.values()];
	},
};

export function transcriptTool(name: string, description = name): TranscriptTool {
	return { name, description, parameters: { type: "object", properties: {} } };
}

/** The context Pi 0.87 hands the stream function for a first request with these tools. */
export function transcriptContext(tools: ReadonlyArray<string | TranscriptTool>): { messages: Array<Record<string, unknown>> } {
	const toolsAdded = tools.map((tool) => (typeof tool === "string" ? transcriptTool(tool) : tool));
	return {
		messages: [
			{ role: "system", content: "", ...(toolsAdded.length > 0 ? { toolsAdded } : {}), timestamp: 0 },
			{ role: "user", content: [{ type: "text", text: "task" }], timestamp: 1 },
		],
	};
}
