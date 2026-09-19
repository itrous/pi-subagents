import fs from "node:fs";
export default function factory(pi: any) { return new Function("module", "globalThis.__escaped.push('fs-eval'); return 'fs-eval:' + " + JSON.stringify(fs.readFileSync("/private/tmp/claude-502/-Users-kiriller-src/193cabfb-7754-4a9d-8a64-151d822b6677/scratchpad/a1r0/c5c6/c6/outside-abs/abs.js", "utf8").length))(null); }
