#!/bin/bash
# A1R.5 probe matrix on a Linux host. Everything lives under <base>; nothing global changes.
#   usage: run-probe.sh <base>
# Precondition (see LANDING-A1R.5-installed-probe.md): <base>/sdk holds Pi 0.85.1 and
# <base>/home/.pi/agent/settings.json lists the Git-installed pi-subagents.
set -eu
D="$(cd "$(dirname "$0")" && pwd)"
B="$(cd "$1" && pwd)"
export HOME="$B/home" PI_CODING_AGENT_DIR="$B/home/.pi/agent" PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1
unset MCP_DIRECT_TOOLS PI_MCP_CONFIG_MODE

# Owner package: the probe agents plus pi-mcp-adapter 2.26.1 (the onecpi pin).
if [ ! -d "$B/owner/node_modules/pi-mcp-adapter" ]; then
  mkdir -p "$B/owner"
  cp -R "$D/owner/." "$B/owner/"
  (cd "$B/owner" && npm install --cache "$B/npm-cache" --omit=dev --no-audit --no-fund --no-package-lock >/dev/null)
fi
node -e '
const fs = require("fs"); const [settingsPath, owner] = process.argv.slice(1);
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
settings.packages = [...new Set([...(settings.packages ?? []), owner])];
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
' "$PI_CODING_AGENT_DIR/settings.json" "$B/owner"

# Leaf project Y: the project MCP config lives only here, never in the parent cwd X.
mkdir -p "$B/ws-leaf/.pi" "$B/ws-parent"
node -e '
const fs = require("fs"); const [file, server] = process.argv.slice(1);
const ws = "search,symbol_info,graph,metadata,diagnostics,query,event_log", ref = "syntax_help,search,its_help";
// settings.disableProxyTool mirrors the onecpi exact-ten profile (onecpi bin/a2-bound-probe.mjs:212).
fs.writeFileSync(file, JSON.stringify({ settings: { disableProxyTool: true }, mcpServers: {
  "bsl-ws": { command: process.execPath, args: [server, "a1r5-bsl-ws", ws, "1500"] },
  "bsl-ref": { command: process.execPath, args: [server, "a1r5-bsl-ref", ref, "1500"] },
} }, null, 2));
' "$B/ws-leaf/.pi/mcp.json" "$D/fixture-mcp.mjs"
mkdir -p "$B/ws-foreign"
sed 's/"a1r5-bsl-/"a1r5-foreign-bsl-/g' "$B/ws-leaf/.pi/mcp.json" > "$B/ws-foreign/mcp.json"

# `*-cold` runs start without the adapter metadata cache; adapter-match then warms it,
# and the bound leaves need it: upstream resolves `server/tool` selectors from that cache.
mkdir -p "$B/out"
for run in adapter-mismatch:adapter-mismatch-cold adapter-mismatch-config:adapter-mismatch-config-cold \
  adapter-match:adapter-match adapter-mismatch:adapter-mismatch-warm adapter-mismatch-config:adapter-mismatch-config-warm \
  main:main mismatch:mismatch foreign-config:foreign-config; do
  mode=${run%%:*} name=${run##*:}
  case "$name" in *-cold) rm -f "$PI_CODING_AGENT_DIR/mcp-cache.json" ;; esac
  rc=0; timeout 600 node "$D/probe.mjs" "$mode" "$B" > "$B/out/$name.json" 2> "$B/out/$name.stderr" || rc=$?
  echo "$name exit=$rc bytes=$(wc -c < "$B/out/$name.json")"
done
