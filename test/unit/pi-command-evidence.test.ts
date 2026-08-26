import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { attestPiSpawnCommand, resolveAttestedPiSpawnCommand } from "../../src/runs/shared/pi-command-evidence.ts";

test("attests a closed shell Pi wrapper, interpreter, and target script", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-command-evidence-"));
	const wrapper = path.join(root, "pi"); const script = path.join(root, "cli.mjs");
	fs.writeFileSync(script, "console.log('0.84.2');\n"); fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.84.2" }));
	fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`); fs.chmodSync(wrapper, 0o755);
	const previous = process.env.PI_SUBAGENT_PI_BINARY; process.env.PI_SUBAGENT_PI_BINARY = wrapper;
	try {
		const first = attestPiSpawnCommand();
		assert.deepEqual(first.entries.map((entry) => entry.role), ["executable", "interpreter", "wrapper-target", "script", "runtime-package"]);
		fs.appendFileSync(script, "// drift\n");
		assert.notEqual(attestPiSpawnCommand().digest, first.digest);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_PI_BINARY; else process.env.PI_SUBAGENT_PI_BINARY = previous;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("materializes active-root Pi command before an external-cwd spawn", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-command-dual-root-")); const active = path.join(root, "active"); const external = path.join(root, "external"); fs.mkdirSync(active); fs.mkdirSync(external);
	const trusted = path.join(active, "pi"); const attacker = path.join(external, "pi"); const trustedScript = path.join(active, "cli.mjs"); fs.writeFileSync(trustedScript, "console.log('trusted');\n"); fs.writeFileSync(path.join(active, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.84.2" }));
	fs.writeFileSync(trusted, `#!/bin/sh\nexec "${process.execPath}" "./cli.mjs" "$@"\n`, { mode: 0o755 }); fs.writeFileSync(attacker, "#!/bin/sh\nexit 99\n", { mode: 0o755 }); fs.writeFileSync(path.join(external, "cli.mjs"), "throw new Error('attacker');\n");
	const previous = process.env.PI_SUBAGENT_PI_BINARY; process.env.PI_SUBAGENT_PI_BINARY = "./pi";
	try { const resolved = resolveAttestedPiSpawnCommand(["-p", "task"], active); assert.equal(resolved.command, fs.realpathSync(process.execPath)); assert.notEqual(resolved.command, attacker); assert.deepEqual(resolved.args, [trustedScript, "-p", "task"]); }
	finally { if (previous === undefined) delete process.env.PI_SUBAGENT_PI_BINARY; else process.env.PI_SUBAGENT_PI_BINARY = previous; fs.rmSync(root, { recursive: true, force: true }); }
});

test("materializes a nested shell-wrapper script and bounds cycles", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-command-nested-")); const outer = path.join(root, "pi"); const inner = path.join(root, "inner"); const script = path.join(root, "cli.mjs"); fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.84.2" })); fs.writeFileSync(script, "console.log('ok');\n");
	fs.writeFileSync(outer, "#!/bin/sh\nexec /bin/sh ./inner \"$@\"\n", { mode: 0o755 }); fs.writeFileSync(inner, `#!/bin/sh\nexec "${process.execPath}" ./cli.mjs \"$@\"\n`, { mode: 0o755 });
	const previous = process.env.PI_SUBAGENT_PI_BINARY; process.env.PI_SUBAGENT_PI_BINARY = outer;
	try { assert.deepEqual(resolveAttestedPiSpawnCommand(["-p", "task"], root), { command: fs.realpathSync(process.execPath), args: [script, "-p", "task"] }); assert.equal(attestPiSpawnCommand(root).entries.filter((entry) => entry.role === "wrapper-target").length, 2); fs.writeFileSync(inner, "#!/bin/sh\nexec /bin/sh ./inner \"$@\"\n", { mode: 0o755 }); assert.throws(() => resolveAttestedPiSpawnCommand([], root), /Cyclic/); }
	finally { if (previous === undefined) delete process.env.PI_SUBAGENT_PI_BINARY; else process.env.PI_SUBAGENT_PI_BINARY = previous; fs.rmSync(root, { recursive: true, force: true }); }
});
