#!/bin/bash
set -u
D="$(cd "$(dirname "$0")" && pwd)"
run() { # name flags...
  local name=$1; shift
  mkdir -p "$D/runs/$name/agent"
  env -u MCP_DIRECT_TOOLS HOME="$D/home" PI_CODING_AGENT_DIR="$D/runs/$name/agent" \
    PI_SKIP_VERSION_CHECK=1 PI_OFFLINE=1 \
    timeout 120 node "$D/p2.mjs" "$D/runs/$name/agent" "$@" > "$D/out/$name.json" 2> "$D/out/$name.stderr"
  echo "$name exit=$?"
}
mkdir -p "$D/out" "$D/home"
rm -rf "$D"/runs/p2-* "$D"/out/p2-*
run p2-real
run p2-real-repeat
run p2-fake-no-stream --fake-no-stream

# The production shape: the agent dir already carries auth.json/models-store.json,
# which ModelRuntime.create() writes on a cold dir. Re-running in the same dir must
# show no filesystem drift at all.
mkdir -p "$D/runs/p2-warm/agent"
cp "$D/runs/p2-real/agent/"*.json "$D/runs/p2-warm/agent/"
run p2-warm
env -u MCP_DIRECT_TOOLS HOME="$D/home" PI_CODING_AGENT_DIR="$D/runs/p2-warm/agent" PI_SKIP_VERSION_CHECK=1 PI_OFFLINE=1 timeout 120 node "$D/p2.mjs" "$D/runs/p2-warm/agent" > "$D/out/p2-warm-again.json" 2> "$D/out/p2-warm-again.stderr"; echo "p2-warm-again exit=$?"
