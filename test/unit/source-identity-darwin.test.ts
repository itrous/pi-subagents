import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	DARWIN_HELPER_SHA256,
	type DarwinTreeVerifier,
} from "../../src/extension/source-identity-darwin.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const helperPath = path.join(projectRoot, "native", "source-identity-darwin");
const wrapperPath = path.join(projectRoot, "src", "extension", "source-identity-darwin.ts");

interface LoadedDarwinWrapper {
	openDarwinTreeVerifier(): DarwinTreeVerifier | undefined;
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function temporaryWrapper(helper: Buffer | undefined, options: { pinHelper?: boolean; symlink?: boolean } = {}): Promise<{
	module: LoadedDarwinWrapper;
	root: string;
	cleanup(): void;
}> {
	const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-darwin-helper-test-")));
	const extensionDirectory = path.join(root, "src", "extension");
	const nativeDirectory = path.join(root, "native");
	fs.mkdirSync(extensionDirectory, { recursive: true });
	fs.mkdirSync(nativeDirectory, { recursive: true });
	const destination = path.join(nativeDirectory, "source-identity-darwin");
	if (options.symlink) fs.symlinkSync(helperPath, destination);
	else if (helper) fs.writeFileSync(destination, helper, { mode: 0o755 });
	let source = fs.readFileSync(wrapperPath, "utf8");
	if (helper && options.pinHelper) {
		source = source.replace(
		/export const DARWIN_HELPER_SHA256 = "[0-9a-f]{64}";/,
		`export const DARWIN_HELPER_SHA256 = "${sha256(helper)}";`,
		);
	}
	const modulePath = path.join(extensionDirectory, "source-identity-darwin.ts");
	fs.writeFileSync(modulePath, source);
	const loaded = await import(`${pathToFileURL(modulePath).href}?case=${Date.now()}-${Math.random()}`) as LoadedDarwinWrapper;
	return { module: loaded, root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function verifyEmpty(verifier: DarwinTreeVerifier, root: string): string | undefined {
	const rootFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
	try { return verifier.verify(rootFd, [], Date.now() + 1_000, 0); }
	finally { fs.closeSync(rootFd); verifier.dispose(); }
}

describe("pinned Darwin source-identity helper", { skip: process.platform !== "darwin" || (process.arch !== "arm64" && process.arch !== "x64") }, () => {
	it("matches the tracked executable and build metadata SHA256", () => {
		const bytes = fs.readFileSync(helperPath);
		const metadata = JSON.parse(fs.readFileSync(path.join(projectRoot, "native", "source-identity-darwin.build.json"), "utf8")) as {
			artifact: string;
			artifactSha256: string;
			source: string;
			sourceSha256: string;
			targets: string[];
		};
		assert.equal(sha256(bytes), DARWIN_HELPER_SHA256);
		assert.equal(metadata.artifact, "native/source-identity-darwin");
		assert.equal(metadata.artifactSha256, DARWIN_HELPER_SHA256);
		assert.equal(sha256(fs.readFileSync(path.join(projectRoot, metadata.source))), metadata.sourceSha256);
		assert.deepEqual(metadata.targets, ["arm64-apple-macos15.0", "x86_64-apple-macos15.0"]);
		assert.equal(fs.statSync(helperPath).mode & 0o100, 0o100);
		assert.equal(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8").includes('"native/**/*"'), true);
		assert.equal(fs.readFileSync(path.join(projectRoot, "scripts", "build-package.mjs"), "utf8").includes('"native"'), true);
	});

	it("refuses a missing helper", async () => {
		const fixture = await temporaryWrapper(undefined);
		try { assert.equal(fixture.module.openDarwinTreeVerifier(), undefined); }
		finally { fixture.cleanup(); }
	});

	it("refuses a truncated helper", async () => {
		const fixture = await temporaryWrapper(fs.readFileSync(helperPath).subarray(0, 32));
		try { assert.equal(fixture.module.openDarwinTreeVerifier(), undefined); }
		finally { fixture.cleanup(); }
	});

	it("refuses a helper whose bytes do not match the pinned hash", async () => {
		const bytes = Buffer.from(fs.readFileSync(helperPath));
		bytes[bytes.length - 1] ^= 0xff;
		const fixture = await temporaryWrapper(bytes);
		try { assert.equal(fixture.module.openDarwinTreeVerifier(), undefined); }
		finally { fixture.cleanup(); }
	});

	it("refuses a symlink at the helper path", async () => {
		const fixture = await temporaryWrapper(undefined, { symlink: true });
		try { assert.equal(fixture.module.openDarwinTreeVerifier(), undefined); }
		finally { fixture.cleanup(); }
	});

	it("fails closed when a pinned helper has the wrong architecture", async () => {
		const wrongArchitecture = Buffer.alloc(32);
		wrongArchitecture.writeUInt32LE(0xfeedfacf, 0);
		wrongArchitecture.writeUInt32LE(0x01000012, 4); // CPU_TYPE_POWERPC64
		wrongArchitecture.writeUInt32LE(0, 8);
		wrongArchitecture.writeUInt32LE(2, 12); // MH_EXECUTE
		const fixture = await temporaryWrapper(wrongArchitecture, { pinHelper: true });
		try {
			const verifier = fixture.module.openDarwinTreeVerifier();
			assert.ok(verifier);
			assert.equal(verifyEmpty(verifier, fixture.root), "unverified_source");
		} finally { fixture.cleanup(); }
	});

	it("fails closed when a pinned helper crashes", async () => {
		const fixture = await temporaryWrapper(Buffer.from("#!/bin/sh\nkill -SEGV $$\n"), { pinHelper: true });
		try {
			const verifier = fixture.module.openDarwinTreeVerifier();
			assert.ok(verifier);
			assert.equal(verifyEmpty(verifier, fixture.root), "unverified_source");
		} finally { fixture.cleanup(); }
	});

	it("rejects an unknown response protocol code", async () => {
		const fixture = await temporaryWrapper(Buffer.from("#!/bin/sh\nprintf 'PISIDR01\\377'\n"), { pinHelper: true });
		try {
			const verifier = fixture.module.openDarwinTreeVerifier();
			assert.ok(verifier);
			assert.equal(verifyEmpty(verifier, fixture.root), "malformed_output");
		} finally { fixture.cleanup(); }
	});
});
