// Runs c5-host.mjs in "sync" mode (tool = synchronous infinite loop) in a separate node process with a hard timeout.
import { spawn } from "node:child_process";
import path from "node:path";
const DIR = path.dirname(new URL(import.meta.url).pathname);
const T0 = Date.now();
const child = spawn(process.execPath, [path.join(DIR, "c5-host.mjs"), "sync"], { cwd: DIR, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
let last = Date.now();
child.stdout.on("data", (d) => { last = Date.now(); process.stdout.write(`[child] ${d}`.replace(/\n(?=.)/g, "\n[child] ")); });
child.stderr.on("data", (d) => process.stdout.write(`[child-err] ${d}`));
const TIMEOUT = 10000;
const timer = setTimeout(() => {
  console.log(`[wrapper +${Date.now() - T0}ms] TIMEOUT: child pid=${child.pid} silent for ${Date.now() - last}ms; SIGTERM`);
  child.kill("SIGTERM");
  setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { console.log(`[wrapper] SIGTERM ignored; SIGKILL ${child.pid}`); child.kill("SIGKILL"); } }, 2000);
}, TIMEOUT);
child.on("exit", (code, sig) => { clearTimeout(timer); console.log(`[wrapper +${Date.now() - T0}ms] child exit code=${code} signal=${sig}`); });
