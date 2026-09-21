#!/bin/sh
# Runs every C6 case in its own node process (no shared native require cache), guard and control.
# The symlink case is created only for the run: a tracked symlink makes the checkout's
# source identity unverified_source (A1R.5).
cd "$(dirname "$0")"
ln -s ../outside.js c6/pkg/link-to-outside.js
trap 'rm -f c6/pkg/link-to-outside.js' EXIT
for mode in --no-guard "" --prologue; do
  for c in $(ls c6/pkg | grep -E '^(ok|esc)-' | sort); do
    C6_CASE=$c node c6-host.mjs $mode | grep -E "^(ok|esc)-"
  done
  C6_CASE=none node c6-host.mjs $mode | grep -E "^(mode|Module)"
  echo
done
