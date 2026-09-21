// Explicit release build of the Darwin source-identity tree verifier.
//   node scripts/build-source-identity-darwin.mjs          rebuild the tracked executable and its build record
//   node scripts/build-source-identity-darwin.mjs --check  rebuild into a temp dir and require identical bytes
// Runtime never compiles, downloads or searches for the helper; only this script needs a compiler/SDK.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = "native/source-identity-darwin.c";
const artifact = "native/source-identity-darwin";
const record = "native/source-identity-darwin.build.json";
const wrapper = "src/extension/source-identity-darwin.ts";
const targets = ["arm64-apple-macos15.0", "x86_64-apple-macos15.0"];
const flags = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-fno-common"];

if (process.platform !== "darwin") throw new Error("The Darwin helper is built on macOS only");
const check = process.argv.includes("--check");
const run = (file, args) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const clang = run("/usr/bin/xcrun", ["--sdk", "macosx", "--find", "clang"]);
const sdkPath = run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
const sdkVersion = run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"]);
const compiler = run(clang, ["--version"]).split("\n")[0];

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "source-identity-darwin-build-"));
try {
	const slices = targets.map((target) => {
		const output = path.join(scratch, target);
		execFileSync(clang, ["-target", target, "-isysroot", sdkPath, ...flags, path.join(root, source), "-o", output], { stdio: "inherit" });
		return output;
	});
	const universal = path.join(scratch, "universal");
	execFileSync("/usr/bin/xcrun", ["lipo", "-create", ...slices, "-output", universal], { stdio: "inherit" });
	const bytes = fs.readFileSync(universal);
	const built = {
		version: 1,
		source,
		sourceSha256: sha256(fs.readFileSync(path.join(root, source))),
		artifact,
		artifactSha256: sha256(bytes),
		compiler,
		sdkVersion,
		targets,
		flags,
	};
	const expected = /DARWIN_HELPER_SHA256 = "([0-9a-f]{64})"/.exec(fs.readFileSync(path.join(root, wrapper), "utf8"))?.[1];
	if (check) {
		const tracked = fs.readFileSync(path.join(root, artifact));
		const recorded = JSON.parse(fs.readFileSync(path.join(root, record), "utf8"));
		const failures = [];
		if (!tracked.equals(bytes)) failures.push(`rebuilt ${built.artifactSha256} differs from tracked ${sha256(tracked)} (recorded ${recorded.compiler}, SDK ${recorded.sdkVersion}; current ${compiler}, SDK ${sdkVersion})`);
		if (recorded.sourceSha256 !== built.sourceSha256) failures.push("build record does not match the source");
		if (recorded.artifactSha256 !== sha256(tracked)) failures.push("build record does not match the tracked executable");
		if (expected !== sha256(tracked)) failures.push(`${wrapper} pins ${expected ?? "nothing"}, tracked executable is ${sha256(tracked)}`);
		if ((fs.statSync(path.join(root, artifact)).mode & 0o111) === 0) failures.push("tracked executable has no executable bit");
		if (failures.length) { for (const failure of failures) console.error(failure); process.exit(1); }
		console.log(`ok ${built.artifactSha256}`);
	} else {
		fs.writeFileSync(path.join(root, artifact), bytes, { mode: 0o755 });
		fs.chmodSync(path.join(root, artifact), 0o755);
		fs.writeFileSync(path.join(root, record), `${JSON.stringify(built, null, 2)}\n`);
		console.log(built.artifactSha256);
		if (expected !== built.artifactSha256) console.log(`update DARWIN_HELPER_SHA256 in ${wrapper}`);
	}
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
