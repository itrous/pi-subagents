#!/bin/bash
# Reproduce C3 matrix. Each case: separate node process, own throwaway agent dir.
# cache states: cold = no mcp-cache.json; warm = valid cache (same server definition as prime);
# stale = cache file from prime but server definition differs (other marker => hash mismatch).
set -u
export C3_ADAPTER=/Users/kiriller/src/onecpi/node_modules/pi-mcp-adapter/index.ts  # pi-mcp-adapter 2.26.1, loaded read-only
P=v2261-
D="$(cd "$(dirname "$0")" && pwd)"
cd "$D"
run() { # name mode flags...
  local name=$1 mode=$2; shift 2
  env -u MCP_DIRECT_TOOLS HOME="$D/home" PI_CODING_AGENT_DIR="$D/runs/$P$name/agent" PI_MCP_CONFIG_MODE=exclusive PI_SKIP_VERSION_CHECK=1 PI_OFFLINE=1 \
    timeout 120 node c3.mjs "$mode" "$D/runs/$P$name/agent" "$@" > "$D/out/$P$name.json" 2> "$D/out/$P$name.stderr"
  echo "$name exit=$?"
}
rm -rf runs/${P}c3-* out/${P}c3-*; mkdir -p out
for m in none load bind; do mkdir -p runs/${P}c3-$m-cold/agent; run c3-$m-cold $m --trace; done
mkdir -p runs/${P}c3-prime/agent; run c3-prime bind --no-prompt --marker c3fixture-shared
for m in none load bind; do
  mkdir -p runs/${P}c3-$m-warm/agent;  cp runs/${P}c3-prime/agent/mcp-cache.json runs/${P}c3-$m-warm/agent/;  run c3-$m-warm  $m --trace --marker c3fixture-shared
  mkdir -p runs/${P}c3-$m-stale/agent; cp runs/${P}c3-prime/agent/mcp-cache.json runs/${P}c3-$m-stale/agent/; run c3-$m-stale $m --trace
done
# parent process has its own MCP_DIRECT_TOOLS=fx/beta,fx/delta; child requests fx/alpha,fx/gamma in the window
for m in load bind; do
  mkdir -p runs/${P}c3-$m-warm-penv/agent;  cp runs/${P}c3-prime/agent/mcp-cache.json runs/${P}c3-$m-warm-penv/agent/;  run c3-$m-warm-penv  $m --trace --marker c3fixture-shared --parent-env fx/beta,fx/delta
  mkdir -p runs/${P}c3-$m-stale-penv/agent; cp runs/${P}c3-prime/agent/mcp-cache.json runs/${P}c3-$m-stale-penv/agent/; run c3-$m-stale-penv $m --trace --parent-env fx/beta,fx/delta
done
