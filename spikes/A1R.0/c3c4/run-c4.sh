#!/bin/bash
set -u
D="$(cd "$(dirname "$0")" && pwd)"
rm -rf "$D/runs/c4"; mkdir -p "$D/runs/c4/agent" "$D/out"
cd "$D/ws/parent"
env -u PI_SUBAGENT_EXTENSION_BINDINGS HOME="$D/home" PI_CODING_AGENT_DIR="$D/runs/c4/agent" PI_SKIP_VERSION_CHECK=1 PI_OFFLINE=1 \
  timeout 120 node "$D/c4.mjs" > "$D/out/c4.json" 2> "$D/out/c4.stderr"
echo "c4 exit=$?"
