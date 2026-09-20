#!/bin/bash
# П1 matrix. Each case: own node process, own throwaway HOME and agent dir.
# P1_ADAPTER selects the adapter; default is the onecpi pin 2.26.1.
set -u
D="$(cd "$(dirname "$0")" && pwd)"
P="${P1_PREFIX:-v2261-}"
run() { # name cwdMode flags...
  local name=$1 mode=$2; shift 2
  mkdir -p "$D/runs/$P$name/agent"
  env -u MCP_DIRECT_TOOLS HOME="$D/home" PI_CODING_AGENT_DIR="$D/runs/$P$name/agent" \
    ${P1_CONFIG_MODE:+PI_MCP_CONFIG_MODE=$P1_CONFIG_MODE} PI_SKIP_VERSION_CHECK=1 PI_OFFLINE=1 \
    timeout 180 node "$D/p1.mjs" "$mode" "$D/runs/$P$name/agent" "$@" > "$D/out/$P$name.json" 2> "$D/out/$P$name.stderr"
  echo "$name exit=$?"
}
mkdir -p "$D/out" "$D/home"
rm -rf "$D/runs/$P"p1-* "$D/out/$P"p1-*
run p1-match         match                  # positive control: process.cwd() == leaf cwd
run p1-mismatch      mismatch               # the case under test
run p1-mismatch-mcp  mismatch --layer mcp   # same, project config in <cwd>/.mcp.json
run p1-mismatch-ovr  mismatch --config-override  # outcome C: config passed explicitly

# warm cache: the metadata cache of the matching run is reused by a mismatching one
if [ -f "$D/runs/${P}p1-match/agent/mcp-cache.json" ]; then
  mkdir -p "$D/runs/${P}p1-mismatch-warm/agent"
  cp "$D/runs/${P}p1-match/agent/mcp-cache.json" "$D/runs/${P}p1-mismatch-warm/agent/"
  run p1-mismatch-warm mismatch
fi
