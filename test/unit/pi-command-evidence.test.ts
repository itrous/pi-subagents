import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { attestPiSpawnCommand } from "../../src/runs/shared/pi-command-evidence.ts";

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
