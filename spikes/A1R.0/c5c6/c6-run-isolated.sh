#!/bin/sh
# Runs every C6 case in its own node process (no shared native require cache), guard and control.
cd "$(dirname "$0")"
for mode in --no-guard "" --prologue; do
  for c in $(ls c6/pkg | grep -E '^(ok|esc)-' | sort); do
    C6_CASE=$c node c6-host.mjs $mode | grep -E "^(ok|esc)-"
  done
  C6_CASE=none node c6-host.mjs $mode | grep -E "^(mode|Module)"
  echo
done
