import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
	ACTIVE_RUNTIME_REPOSITORY,
	canonicalSourceIdentityProjection,
	createSourceIdentity,
	gitIdentityEnvironment,
	normalizeForkRemote,
	resolveActiveRuntimeSourceIdentity,
	runGitProbe,
	runGitProbeWithExecutable,
	type ActiveRuntimeSourceIdentityResolution,
} from "../../src/extension/source-identity.ts";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(): { root: string; commit: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-source-identity-"));
	git(root, ["init", "-q"]);
	git(root, ["config", "user.name", "Identity Test"]);
	git(root, ["config", "user.email", "identity@example.test"]);
	git(root, ["remote", "add", "origin", ACTIVE_RUNTIME_REPOSITORY]);
	fs.mkdirSync(path.join(root, "src"));
	fs.writeFileSync(path.join(root, "package.json"), '{"name":"pi-subagents"}\n');
	fs.writeFileSync(path.join(root, "src", "tracked.txt"), "base\n");
	git(root, ["add", "package.json", "src/tracked.txt"]);
	git(root, ["commit", "-q", "-m", "base"]);
	const commit = git(root, ["rev-parse", "HEAD"]);
	git(root, ["checkout", "-q", "--detach", commit]);
	return { root, commit, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function reason(result: ActiveRuntimeSourceIdentityResolution): string | undefined {
	return result.available ? undefined : result.sourceIdentityUnavailable.reasonCode;
}

describe("active runtime source identity", { skip: process.platform !== "linux" }, () => {
	it("matches the canonical digest vector and exact remote normalization", () => {
		const commit = "0123456789abcdef0123456789abcdef01234567";
		const projection = `{"version":1,"kind":"git","repository":"${ACTIVE_RUNTIME_REPOSITORY}","commit":"${commit}"}`;
		assert.equal(canonicalSourceIdentityProjection(commit), projection);
		assert.equal(createSourceIdentity(commit).digest, createHash("sha256").update(projection).digest("hex"));
		assert.equal(normalizeForkRemote("git@github.com:itrous/pi-subagents.git"), ACTIVE_RUNTIME_REPOSITORY);
		assert.equal(normalizeForkRemote("ssh://git@github.com/itrous/pi-subagents.git"), ACTIVE_RUNTIME_REPOSITORY);
		assert.equal(normalizeForkRemote("https://github.com/other/pi-subagents.git"), undefined);
	});

	it("rejects non-ignored untracked files but permits ignored dependency state", () => {
		const repo = fixture();
		try {
			fs.writeFileSync(path.join(repo.root, "untracked"), "dirty\n");
			assert.equal(reason(resolveActiveRuntimeSourceIdentity({ packageRoot: repo.root })), "dirty");
			fs.rmSync(path.join(repo.root, "untracked"));
			fs.appendFileSync(path.join(repo.root, ".git", "info", "exclude"), "ignored-runtime\n");
			fs.writeFileSync(path.join(repo.root, "ignored-runtime"), "ignored\n");
			const result = resolveActiveRuntimeSourceIdentity({ packageRoot: repo.root });
			assert.equal(result.available, true);
			if (result.available) assert.equal(result.sourceIdentity.commit, repo.commit);
		} finally { repo.cleanup(); }
	});

	it("fails closed for dirty worktree, staged index, attached head, and wrong remote", () => {
		for (const variant of ["dirty", "staged", "attached", "remote"] as const) {
			const repo = fixture();
			try {
				if (variant === "dirty") fs.appendFileSync(path.join(repo.root, "src", "tracked.txt"), "dirty\n");
				if (variant === "staged") { fs.appendFileSync(path.join(repo.root, "package.json"), " \n"); git(repo.root, ["add", "package.json"]); }
				if (variant === "attached") git(repo.root, ["checkout", "-q", "-b", "attached"]);
				if (variant === "remote") git(repo.root, ["remote", "set-url", "origin", "https://github.com/other/repo.git"]);
				assert.equal(resolveActiveRuntimeSourceIdentity({ packageRoot: repo.root }).available, false, variant);
			} finally { repo.cleanup(); }
		}
	});

	it("directly verifies assume-unchanged and skip-worktree files without clean filters", () => {
		for (const flag of ["--assume-unchanged", "--skip-worktree"] as const) {
			const repo = fixture();
			try {
				git(repo.root, ["update-index", flag, "src/tracked.txt"]);
				assert.equal(resolveActiveRuntimeSourceIdentity({ packageRoot: repo.root }).available, true);
				git(repo.root, ["config", "filter.hide.clean", "printf 'base\\n'"]);
				fs.writeFileSync(path.join(repo.root, ".git", "info", "attributes"), "src/tracked.txt filter=hide\n");
				fs.writeFileSync(path.join(repo.root, "src", "tracked.txt"), "evil\n");
				assert.equal(reason(resolveActiveRuntimeSourceIdentity({ packageRoot: repo.root })), "dirty");
			} finally { repo.cleanup(); }
		}
	});

	it("does not execute repository clean filters while checking source identity", () => {
		const repo = fixture();
		const marker = path.join(repo.root, ".git", "clean-filter-ran");
		try {
			git(repo.root, ["config", "filter.sideeffect.clean", `/usr/bin/touch ${marker}; /usr/bin/cat`]);
			fs.writeFileSync(path.join(repo.root, ".git", "info", "attributes"), "src/tracked.txt filter=sideeffect\n");
			assert.equal(resolveActiveRuntimeSourceIdentity({ packageRoot: repo.root }).available, true);
			assert.equal(fs.existsSync(marker), false);
		} finally { repo.cleanup(); }
	});

	it("ignores bogus fsmonitor and inherited Git discovery environment", () => {
		const repo = fixture();
		const saved = { GIT_DIR: process.env.GIT_DIR, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT };
		try {
			git(repo.root, ["config", "core.fsmonitor", "/nonexistent-monitor"]);
			process.env.GIT_DIR = "/nonexistent";
			process.env.GIT_CONFIG_COUNT = "1";
			const result = resolveActiveRuntimeSourceIdentity({ packageRoot: repo.root });
			assert.equal(result.available, true);
			assert.deepEqual(gitIdentityEnvironment({ PATH: "/hostile", NODE_OPTIONS: "--require hostile", LD_PRELOAD: "hostile.so", Git_DIR: "x" }), { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
		} finally {
			if (saved.GIT_DIR === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.GIT_DIR;
			if (saved.GIT_CONFIG_COUNT === undefined) delete process.env.GIT_CONFIG_COUNT; else process.env.GIT_CONFIG_COUNT = saved.GIT_CONFIG_COUNT;
			repo.cleanup();
		}
	});

	it("uses owner execute semantics and rejects FIFO without blocking", () => {
		if (process.platform !== "linux") return;
		const repo = fixture();
		try {
			fs.chmodSync(path.join(repo.root, "src", "tracked.txt"), 0o654);
			assert.equal(resolveActiveRuntimeSourceIdentity({ packageRoot: repo.root }).available, true, "group execute must not imply Git executable mode");
			fs.chmodSync(path.join(repo.root, "src", "tracked.txt"), 0o744);
			assert.equal(reason(resolveActiveRuntimeSourceIdentity({ packageRoot: repo.root })), "dirty", "owner execute must imply Git executable mode");
			fs.unlinkSync(path.join(repo.root, "src", "tracked.txt"));
			execFileSync("mkfifo", [path.join(repo.root, "src", "tracked.txt")]);
			const started = Date.now();
			assert.equal(reason(resolveActiveRuntimeSourceIdentity({ packageRoot: repo.root })), "dirty");
			assert.ok(Date.now() - started < 1_000, "FIFO verification must not block");
		} finally { repo.cleanup(); }
	});

	it("rejects malformed ls-tree without a terminating NUL", () => {
		const repo = fixture();
		try {
			const real = runGitProbe(repo.root, "initial", undefined, { timeoutMs: 2_000, outputBytes: 4 * 1024 * 1024 });
			const runner = (_root: string, phase: "initial" | "final", commit: string | undefined, limits: { timeoutMs: number; outputBytes: number }) => {
				if (phase === "final") return runGitProbe(repo.root, phase, commit, limits);
				return { ...real, commands: real.commands.map((entry, index) => index === 6 ? { ...entry, stdout: entry.stdout.subarray(0, -1) } : entry) };
			};
			assert.equal(reason(resolveActiveRuntimeSourceIdentity({ packageRoot: repo.root, runProbe: runner })), "malformed_output");
		} finally { repo.cleanup(); }
	});

	it("rechecks tracked bytes after the final metadata probe", () => {
		const repo = fixture();
		let mutated = false;
		try {
			const result = resolveActiveRuntimeSourceIdentity({
				packageRoot: repo.root,
				runProbe(root, phase, commit, limits) {
					const probe = runGitProbe(root, phase, commit, limits);
					if (phase === "final") {
						mutated = true;
						fs.writeFileSync(path.join(root, "src", "tracked.txt"), "evil\n");
					}
					return probe;
				},
			});
			assert.equal(mutated, true);
			assert.equal(reason(result), "dirty");
		} finally { repo.cleanup(); }
	});

	it("runs final metadata only after filesystem verification with one aggregate budget", () => {
		const repo = fixture();
		try {
			const phases: string[] = [];
			let firstBudget = 0;
			const runner = (root: string, phase: "initial" | "final", commit: string | undefined, limits: { timeoutMs: number; outputBytes: number }) => {
				phases.push(phase);
				if (phase === "initial") firstBudget = limits.outputBytes;
				else assert.ok(limits.outputBytes < firstBudget, "final must receive remaining aggregate output budget");
				return runGitProbe(root, phase, commit, limits);
			};
			assert.equal(resolveActiveRuntimeSourceIdentity({ packageRoot: repo.root, runProbe: runner }).available, true);
			assert.deepEqual(phases, ["initial", "final"]);
		} finally { repo.cleanup(); }
	});

	it("rejects child-directory namespace swap after anchored read", () => {
		const repo = fixture();
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-swap-"));
		let swapped = false;
		try {
			fs.writeFileSync(path.join(outside, "tracked.txt"), "base\n");
			const result = resolveActiveRuntimeSourceIdentity({
				packageRoot: repo.root,
				onEntryReadForTest(relative) {
					if (swapped || relative.toString() !== "src/tracked.txt") return;
					swapped = true;
					fs.renameSync(path.join(repo.root, "src"), path.join(repo.root, "src-held"));
					fs.symlinkSync(outside, path.join(repo.root, "src"), "dir");
				},
			});
			assert.equal(reason(result), "dirty");
		} finally { repo.cleanup(); fs.rmSync(outside, { recursive: true, force: true }); }
	});

	it("fails closed for tracked symlinks", () => {
		const repo = fixture();
		try {
			fs.symlinkSync("src/tracked.txt", path.join(repo.root, "tracked-link"));
			git(repo.root, ["add", "tracked-link"]);
			git(repo.root, ["commit", "-q", "-m", "tracked symlink"]);
			assert.equal(reason(resolveActiveRuntimeSourceIdentity({ packageRoot: repo.root })), "unverified_source");
		} finally { repo.cleanup(); }
	});

	it("fails closed for intermediate symlink escape", () => {
		const repo = fixture();
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-outside-"));
		try {
			fs.writeFileSync(path.join(outside, "tracked.txt"), "base\n");
			fs.rmSync(path.join(repo.root, "src"), { recursive: true });
			fs.symlinkSync(outside, path.join(repo.root, "src"), "dir");
			assert.equal(resolveActiveRuntimeSourceIdentity({ packageRoot: repo.root }).available, false);
		} finally { repo.cleanup(); fs.rmSync(outside, { recursive: true, force: true }); }
	});

	it("checks the aggregate deadline during direct tree verification", () => {
		const repo = fixture();
		let delayed = false;
		try {
			const result = resolveActiveRuntimeSourceIdentity({
				packageRoot: repo.root,
				onEntryReadForTest() {
					if (delayed) return;
					delayed = true;
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_050);
				},
			});
			assert.equal(reason(result), "git_timeout");
		} finally { repo.cleanup(); }
	});

	it("ignores an ambient PATH Git wrapper in the production probe", () => {
		if (process.platform !== "linux") return;
		const repo = fixture();
		const bin = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-fake-path-git-"));
		const oldPath = process.env.PATH;
		try {
			fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
			process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ""}`;
			const probe = runGitProbe(repo.root, "initial", undefined, { timeoutMs: 2_000, outputBytes: 4 * 1024 * 1024 });
			assert.equal(probe.commands[0]?.status, 0);
		} finally {
			if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
			repo.cleanup(); fs.rmSync(bin, { recursive: true, force: true });
		}
	});

	it("kills descendants left by an earlier completed Git command", async () => {
		if (process.platform !== "linux") return;
		const repo = fixture();
		const bin = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-git-orphan-"));
		const pidFile = path.join(bin, "pid");
		const oldPath = process.env.PATH;
		try {
			const realGit = "/usr/bin/git";
			fs.writeFileSync(path.join(bin, "git"), [
				"#!/bin/sh",
				"case \" $* \" in",
				`  *' rev-parse --show-toplevel '*) (sleep 30) >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidFile)}; exec ${JSON.stringify(realGit)} \"$@\" ;;`,
				"  *) sleep 30 ;;",
				"esac",
			].join("\n"), { mode: 0o755 });
			process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ""}`;
			assert.equal(runGitProbeWithExecutable(repo.root, "initial", undefined, { timeoutMs: 300, outputBytes: 4 * 1024 * 1024 }, path.join(bin, "git")).timedOut, true);
			const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
			let alive = true;
			for (let attempt = 0; attempt < 20; attempt += 1) {
				try { process.kill(pid, 0); } catch { alive = false; break; }
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.equal(alive, false);
		} finally {
			if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
			repo.cleanup(); fs.rmSync(bin, { recursive: true, force: true });
		}
	});

	it("bounds the whole Git process tree", () => {
		if (process.platform !== "linux") return;
		const bin = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-git-wrapper-"));
		const oldPath = process.env.PATH;
		try {
			fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\n(sleep 8) &\nwait\n", { mode: 0o755 });
			process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ""}`;
			const started = Date.now();
			assert.equal(runGitProbeWithExecutable(process.cwd(), "initial", undefined, { timeoutMs: 2_000, outputBytes: 4 * 1024 * 1024 }, path.join(bin, "git")).timedOut, true);
			assert.ok(Date.now() - started < 4_000);
		} finally { process.env.PATH = oldPath; fs.rmSync(bin, { recursive: true, force: true }); }
	});

	it("fails closed on aggregate timeout and aggregate output from injected probe", () => {
		const repo = fixture();
		try {
			const timed = () => ({ timedOut: true as const, commands: [] });
			const oversized = () => ({ outputTooLarge: true as const, commands: [] });
			assert.equal(reason(resolveActiveRuntimeSourceIdentity({ packageRoot: repo.root, runProbe: timed })), "git_timeout");
			assert.equal(reason(resolveActiveRuntimeSourceIdentity({ packageRoot: repo.root, runProbe: oversized })), "output_too_large");
		} finally { repo.cleanup(); }
	});
});

describe("fork checkout", () => {
	it("tracks no symlink or gitlink: source identity refuses either as unverified_source", () => {
		const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
		const modes = git(root, ["ls-files", "-s", "-z"]).split("\0").filter(Boolean).map((entry) => entry.split(" ")[0]);
		assert.ok(modes.length > 0);
		assert.deepEqual(modes.filter((mode) => mode === "120000" || mode === "160000"), []);
	});
});
