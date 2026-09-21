---
name: probe-drift
description: "A1R.5 canary: drift."
defaultContext: fresh
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
tools: read
subagentOnlyExtensions: ./ext/drift.ts
---

Answer the task.
