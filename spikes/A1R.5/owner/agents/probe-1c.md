---
name: probe-1c
description: "A1R.5 1C leaf with exact-ten MCP tools."
defaultContext: fresh
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
tools: read, mcp:bsl-ws/search, mcp:bsl-ws/symbol_info, mcp:bsl-ws/graph, mcp:bsl-ws/metadata, mcp:bsl-ws/diagnostics, mcp:bsl-ws/query, mcp:bsl-ws/event_log, mcp:bsl-ref/syntax_help, mcp:bsl-ref/search, mcp:bsl-ref/its_help
subagentOnlyExtensions: package:pi-mcp-adapter
---

Answer the task.
