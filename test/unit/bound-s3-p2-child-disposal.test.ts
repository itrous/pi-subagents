import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createDefaultChildSessionFactory, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { fakePi } from "../support/bound-fake-pi.ts";

// S3 P2 seam in child-session: a throwing error reporter must not skip
// `session.dispose()`; the disposal outcome says what happened.
test("a throwing shutdown handler and a throwing error reporter still dispose the session", async () => {
	const { pi, probe } = fakePi({ throwShutdown: true });
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "s3p2-disposal-"));
	try {
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi as unknown as PiCodingAgentModule, shutdownTimeoutMs: 50 });
		const child = await factory.create({
			cwd, storage: { kind: "memory" }, extensionPaths: [], hooks: [], ambientExtensions: false, noSkills: true, noContextFiles: true,
			onExtensionError: (error) => { if (error.event === "session_shutdown") throw new Error("reporter failed"); },
		} as never);
		await assert.rejects(child.dispose(), /reporter failed/u, "the reporter's error still rejects dispose()");
		assert.equal(probe.disposed, 1, "the session was disposed anyway");
		assert.deepEqual(await child.disposalOutcome?.(), { shutdown: "failed", disposed: true });
	} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
