#!/bin/bash
D="$(cd "$(dirname "$0")" && pwd)"
for f in "$D"/out/${1:-}c3-*.json; do echo "== $(basename $f .json)"; node -e '
const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
console.log(JSON.stringify({mode:j.windowMode,toolsAfterCreate:j.toolsAfterCreate,toolsAfterPrompt:j.toolsAfterPrompt,llmSaw:j.llmToolsSeen?.[0],result:(j.results||[]).map(r=>r.text),procs:j.procs,envEqual:j.envEqualToInitial,parentNow:j.parentMCP_DIRECT_TOOLS_now,errors:j.errors.length,adapterReads:(j.mcpDirectToolsReads||[]).filter(r=>r.frames.length).map(r=>`${r.phase}|${r.value??"<unset>"}|${r.frames[0].replace(/^.*\(pi-mcp-adapter\//,"").replace(/\)$/,"")}`)}))' "$f"; done
