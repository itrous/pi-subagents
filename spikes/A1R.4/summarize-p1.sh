#!/bin/bash
D="$(cd "$(dirname "$0")" && pwd)"
python3 - "$D" <<'PY'
import json, sys, glob, os
d = sys.argv[1]
rows = []
for f in sorted(glob.glob(os.path.join(d, "out", "*p1-*.json"))):
    try: j = json.load(open(f))
    except Exception as e: rows.append((os.path.basename(f), "BAD", str(e))); continue
    rows.append((os.path.basename(f)[:-5], j["cwdMode"], j["layer"], j["configOverride"],
                 j["complete"]["afterCreate"], j["complete"]["afterSettle"], j["complete"]["afterPrompt"],
                 j["envEqualToInitial"], j["procs"]["afterDispose"], len(j["errors"])))
w = "{:<26} {:<9} {:<5} {:<6} {:<12} {:<12} {:<12} {:<8} {:<8} {}"
print(w.format("case","cwdMode","layer","ovr","@create","@settle","@prompt","envEq","procsEnd","errs"))
for r in rows: print(w.format(*[str(x) for x in r]))
PY
