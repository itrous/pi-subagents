// C6 spike: per-instance jiti with a root check in `transform`; global Module._resolveFilename untouched.
// Usage: node c6-host.mjs [--no-guard]
import fs from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";

const JITI = "/opt/homebrew/Cellar/pi-coding-agent/0.85.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti";
const { createJiti } = await import(`${JITI}/lib/jiti-static.mjs`);
const babelTransform = createRequire(import.meta.url)(`${JITI}/dist/babel.cjs`);
const DIR = path.dirname(new URL(import.meta.url).pathname);
const PKG = fs.realpathSync(path.join(DIR, "c6", "pkg"));
const guard = !process.argv.includes("--no-guard");
const prologue = process.argv.includes("--prologue");
// Variant: additionally rebind the per-module `require`/`jitiImport` wrapper params so every specifier is resolved and checked first.
const GK = Symbol.for("c6.guard");
globalThis[GK] = {
  check(resolved, from, spec) { if (typeof resolved === "string" && path.isAbsolute(resolved) && !attested(fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved)) throw new Error(`C6_BLOCKED_RESOLVE ${spec} from ${from} -> ${resolved}`); },
  req(orig, from) { const g = (spec) => { globalThis[GK].check(orig.resolve(spec), from, spec); return orig(spec); }; return Object.assign(g, orig); },
  imp(orig, req, from) { return (spec, o) => { globalThis[GK].check(req.resolve(spec), from, spec); return orig(spec, o); }; },
};
const PROLOGUE = `require = globalThis[Symbol.for("c6.guard")].req(require, __filename); jitiImport = globalThis[Symbol.for("c6.guard")].imp(jitiImport, require, __filename);`;
const roots = [PKG];
const within = (root, t) => { const r = path.relative(root, t); return r === "" || (!r.startsWith(`..${path.sep}`) && r !== ".." && !path.isAbsolute(r)); };
const attested = (f) => roots.some((root) => within(root, f));
const seen = [];

function guardedTransform(opts) {
  const f = opts.filename;
  const real = f && fs.existsSync(f) ? fs.realpathSync(f) : f;
  seen.push(path.relative(DIR, f ?? "<none>") + (real !== f ? ` (real ${path.relative(DIR, real)})` : ""));
  if (!f || !attested(f) || !attested(real)) throw new Error(`C6_BLOCKED transform of ${f}`);
  const out = babelTransform(opts);
  if (prologue && out.code) out.code = out.code.startsWith('"use strict";') ? '"use strict";' + PROLOGUE + out.code.slice(13) : PROLOGUE + out.code;
  return out;
}

const before = { resolve: Module._resolveFilename, load: Module._load, extJs: Module._extensions[".js"] };
const cases = fs.readdirSync(PKG).filter((f) => /^(ok|esc)-/.test(f) && (!process.env.C6_CASE || f === process.env.C6_CASE)).sort();
globalThis.__escaped = [];
const results = [];
for (const c of cases) {
  globalThis.__escaped = [];
  seen.length = 0;
  const jiti = createJiti(path.join(PKG, "__host__.js"), { moduleCache: false, fsCache: false, ...(guard ? { transform: guardedTransform } : {}) });
  let outcome;
  try {
    const factory = await jiti.import(path.join(PKG, c), { default: true });
    const value = await factory({});
    outcome = `LOADED value=${JSON.stringify(value)}`;
  } catch (e) {
    outcome = `THREW ${String(e?.message ?? e).split("\n")[0].replace(DIR, "$D")}`;
  }
  const escaped = globalThis.__escaped.length ? `escaped-code-ran=${JSON.stringify(globalThis.__escaped)}` : "escaped-code-ran=[]";
  results.push(`${c.padEnd(26)} ${outcome.padEnd(70)} ${escaped}${guard ? "  transformed=" + JSON.stringify(seen) : ""}`);
}
console.log(`mode=${guard ? (prologue ? "GUARD+PROLOGUE (transform check + require/jitiImport rebinding)" : "GUARD (transform check)") : "CONTROL (no check)"} root=${path.relative(DIR, PKG)}`);
for (const r of results) console.log(r.replaceAll(DIR, "$D"));
const after = { resolve: Module._resolveFilename, load: Module._load, extJs: Module._extensions[".js"] };
console.log(`Module._resolveFilename unchanged: ${before.resolve === after.resolve}; Module._load unchanged: ${before.load === after.load}; _extensions[.js] unchanged: ${before.extJs === after.extJs}`);
console.log(`Module._resolveFilename.name=${after.resolve.name} source-starts=${String(after.resolve).slice(0, 40).replace(/\s+/g, " ")}`);
