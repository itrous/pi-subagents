import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { installExactCommit, parseExactCommit, removeInstalledExtension } from "../../install-lib.mjs";

interface Fixture { root: string; source: string; remote: string; otherRemote: string; install: string; state: string; first: string; second: string }
let fixture: Fixture;

function git(args: string[], cwd?: string): string {
	const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
	assert.equal(result.status, 0, `${result.stderr}\ngit ${args.join(" ")}`);
	return result.stdout.trim();
}

function commit(source: string, text: string, message: string): string {
	fs.writeFileSync(path.join(source, "payload.txt"), text);
	git(["add", "payload.txt"], source);
	git(["commit", "-m", message], source);
	return git(["rev-parse", "HEAD"], source);
}

function createFixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-installer-"));
	const source = path.join(root, "source"); const remote = path.join(root, "fork.git"); const otherRemote = path.join(root, "other.git");
	fs.mkdirSync(source); git(["init", "--initial-branch=main"], source); git(["config", "user.name", "Installer Test"], source); git(["config", "user.email", "installer@example.invalid"], source);
	fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" })); fs.writeFileSync(path.join(source, ".gitignore"), "node_modules/\n"); fs.writeFileSync(path.join(source, ".gitattributes"), "payload.txt filter=mask\n"); fs.writeFileSync(path.join(source, "line\nbreak.txt"), "newline path\n"); git(["add", "package.json", ".gitignore", ".gitattributes", "line\nbreak.txt"], source);
	const first = commit(source, "first\n", "first");
	git(["clone", "--bare", source, remote], root); git(["remote", "add", "origin", remote], source);
	const second = commit(source, "second\n", "second"); git(["push", "origin", "main"], source);
	git(["clone", "--bare", source, otherRemote], root);
	return { root, source, remote, otherRemote, install: path.join(root, "extensions", "installed"), state: path.join(root, "installer-state"), first, second };
}

function install(commit: string, overrides: Record<string, unknown> = {}) {
	return installExactCommit({
		extensionDir: fixture.install,
		stateDir: fixture.state,
		commit,
		repositoryUrl: fixture.remote,
		expectedRepository: (value: string) => path.resolve(value) === path.resolve(fixture.remote),
		installDependencies: false,
		quiet: true,
		...overrides,
	});
}

function npmShim(mode: "prove-install" | "mutate-existing"): string {
	const target = path.join(fixture.root, `npm-${mode}.mjs`);
	fs.writeFileSync(target, `#!${process.execPath}\nimport fs from "node:fs"; import path from "node:path";\nconst args=process.argv.slice(2);\nif (${JSON.stringify(mode)} === "mutate-existing") fs.writeFileSync(process.env.MUTATE_CHECKOUT + "/payload.txt", "raced\\n");\nelse { if (process.env.NPM_CONFIG_DRY_RUN !== "false" || process.env.NPM_CONFIG_GLOBAL !== "false" || !args.includes("--global=false") || !args.includes("--location=project") || !args.includes("--dry-run=false") && args[0] === "ci") process.exit(41); const proof=path.join(process.cwd(), "node_modules", ".installer-proof"); if(args[0] === "ci"){fs.mkdirSync(path.dirname(proof),{recursive:true});fs.writeFileSync(proof,"ok");} else if(args[0] === "ls" && !fs.existsSync(proof)) process.exit(42); }\n`, { mode: 0o755 });
	return target;
}

function assertDetachedAt(commit: string): void {
	assert.equal(git(["rev-parse", "HEAD"], fixture.install), commit);
	const symbolic = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: fixture.install, encoding: "utf8" });
	assert.equal(symbolic.status, 1);
	assert.equal(git(["status", "--porcelain=v1", "--untracked-files=all"], fixture.install), "");
}

describe("exact fork installer", () => {
	beforeEach(() => { fixture = createFixture(); });
	afterEach(() => { fs.rmSync(fixture.root, { recursive: true, force: true }); });

	it("normalizes PI_CODING_AGENT_DIR like Pi for the protected installation root", () => {
		const cases = [
			[path.join(fixture.root, "custom-agent-dir"), path.join(fixture.root, "custom-agent-dir")],
			[pathToFileURL(path.join(fixture.root, "file-agent-dir")).href, path.join(fixture.root, "file-agent-dir")],
			["~/tilde-agent-dir", path.join(os.homedir(), "tilde-agent-dir")],
		] as const;
		for (const [configured, agentDir] of cases) {
			const result = spawnSync(process.execPath, [path.resolve("install.mjs"), "--help"], { cwd: path.resolve("."), encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: configured } });
			assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, new RegExp(path.join(agentDir, "extensions", "subagent").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		}
	});

	it("serializes --remove with installer publication", () => {
		const agentDir = path.join(fixture.root, "remove-agent"), installed = path.join(agentDir, "extensions", "subagent"), lock = path.join(agentDir, ".pi-subagents-installer", "install.lock");
		fs.mkdirSync(installed, { recursive: true }); fs.mkdirSync(lock, { recursive: true }); fs.writeFileSync(path.join(lock, "owner.json"), "{}");
		let result = spawnSync(process.execPath, [path.resolve("install.mjs"), "--remove"], { cwd: path.resolve("."), encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
		assert.equal(result.status, 1); assert.equal(fs.existsSync(installed), true);
		fs.rmSync(lock, { recursive: true, force: true });
		result = spawnSync(process.execPath, [path.resolve("install.mjs"), "--remove"], { cwd: path.resolve("."), encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
		assert.equal(result.status, 0, result.stderr); assert.equal(fs.existsSync(installed), false);
	});

	it("requires an immutable full lowercase commit", () => {
		assert.equal(parseExactCommit(fixture.first), fixture.first);
		for (const value of [undefined, "main", fixture.first.slice(0, 12), fixture.first.toUpperCase(), "0".repeat(39), `${"0".repeat(40)}x`]) {
			assert.throws(() => parseExactCommit(value), /exact lowercase 40-hex commit/i);
		}
	});

	it("rejects a state-directory symlink into Pi extension discovery", () => {
		const extensions = path.dirname(fixture.install); const target = path.join(extensions, "installer-state"); fs.mkdirSync(target, { recursive: true });
		const stateLink = path.join(fixture.root, "state-link"); fs.symlinkSync(target, stateLink, process.platform === "win32" ? "junction" : "dir");
		assert.throws(() => install(fixture.first, { stateDir: stateLink }), /resolves inside Pi's extensions/i);
	});

	it("fresh-installs the requested commit with detached HEAD", () => {
		install(fixture.first);
		assertDetachedAt(fixture.first);
		assert.equal(fs.readFileSync(path.join(fixture.install, "payload.txt"), "utf8"), "first\n");
		assert.equal(git(["config", "--local", "--get", "remote.origin.url"], fixture.install), fixture.remote);
	});

	it("updates a clean existing checkout to another exact detached commit", () => {
		install(fixture.first); install(fixture.second);
		assertDetachedAt(fixture.second);
		assert.equal(fs.readFileSync(path.join(fixture.install, "payload.txt"), "utf8"), "second\n");
	});

	it("rejects a wrong origin without changing HEAD or the remote", () => {
		install(fixture.first); git(["remote", "set-url", "origin", fixture.otherRemote], fixture.install);
		assert.throws(() => install(fixture.second), /rejected origin remote/i);
		assert.equal(git(["rev-parse", "HEAD"], fixture.install), fixture.first);
		assert.equal(git(["config", "--local", "--get", "remote.origin.url"], fixture.install), fixture.otherRemote);
	});

	it("does not honor replacement refs or existing-checkout URL rewrites", () => {
		install(fixture.first);
		git(["fetch", fixture.remote, fixture.second], fixture.install);
		git(["replace", fixture.first, fixture.second], fixture.install);
		git(["config", "--local", "--add", `url.${fixture.otherRemote}.insteadOf`, fixture.remote], fixture.install);
		install(fixture.second);
		assertDetachedAt(fixture.second);
		assert.equal(fs.readFileSync(path.join(fixture.install, "payload.txt"), "utf8"), "second\n");
		assert.equal(fs.existsSync(path.join(fixture.install, ".git", "refs", "replace", fixture.first)), false);
	});

	it("rejects multiple origin URLs before fetching", () => {
		install(fixture.first); git(["config", "--local", "--add", "remote.origin.url", fixture.otherRemote], fixture.install);
		assert.throws(() => install(fixture.second), /rejected origin remote/i);
		assert.equal(git(["rev-parse", "HEAD"], fixture.install), fixture.first);
	});

	it("rejects raw tracked changes with a Git clean filter configured", () => {
		install(fixture.first); git(["config", "--local", "filter.mask.clean", "printf 'first\\n'"], fixture.install); fs.writeFileSync(path.join(fixture.install, "payload.txt"), "masked dirt\n");
		assert.throws(() => install(fixture.second), /dirty|bytes differ from HEAD/i);
		assert.equal(fs.readFileSync(path.join(fixture.install, "payload.txt"), "utf8"), "masked dirt\n");
	});

	it("rejects tracked, staged, untracked, and index-hidden dirt without discarding it", () => {
		for (const kind of ["tracked", "staged", "untracked", "hidden"] as const) {
			fs.rmSync(fixture.install, { recursive: true, force: true }); install(fixture.first);
			if (kind === "untracked") fs.writeFileSync(path.join(fixture.install, "local.txt"), "keep\n");
			else { if (kind === "hidden") git(["update-index", "--assume-unchanged", "payload.txt"], fixture.install); fs.writeFileSync(path.join(fixture.install, "payload.txt"), `${kind}\n`); if (kind === "staged") git(["add", "payload.txt"], fixture.install); }
			const before = git(["status", "--porcelain=v1", "--untracked-files=all"], fixture.install);
			assert.throws(() => install(fixture.second), /dirty|index flags/i);
			assert.equal(git(["rev-parse", "HEAD"], fixture.install), fixture.first);
			assert.equal(git(["status", "--porcelain=v1", "--untracked-files=all"], fixture.install), before);
		}
	});

	it("overrides ambient npm dry-run and verifies the installed dependency tree", () => {
		const npm = npmShim("prove-install");
		install(fixture.second, { installDependencies: true, npmCommand: [process.execPath, npm], env: { ...process.env, NPM_CONFIG_DRY_RUN: "true" } });
		assertDetachedAt(fixture.second);
		assert.equal(fs.readFileSync(path.join(fixture.install, "node_modules", ".installer-proof"), "utf8"), "ok");
	});

	it("rechecks and preserves an existing checkout changed during candidate preparation", () => {
		install(fixture.first); const npm = npmShim("mutate-existing");
		assert.throws(() => install(fixture.second, { installDependencies: true, npmCommand: [process.execPath, npm], env: { ...process.env, MUTATE_CHECKOUT: fixture.install } }), /dirty|changed/i);
		assert.equal(git(["rev-parse", "HEAD"], fixture.install), fixture.first);
		assert.equal(fs.readFileSync(path.join(fixture.install, "payload.txt"), "utf8"), "raced\n");
	});

	it("preserves ignored old-checkout files in hidden archives across updates", () => {
		install(fixture.first); const local = path.join(fixture.install, "node_modules", "local-state"); fs.mkdirSync(path.dirname(local), { recursive: true }); fs.writeFileSync(local, "keep\n");
		install(fixture.second);
		const backup = path.join(fixture.state, "previous"); assert.equal(fs.readFileSync(path.join(backup, "node_modules", "local-state"), "utf8"), "keep\n");
		install(fixture.second);
		const archive = fs.readdirSync(fixture.state).find((name) => name.startsWith("archive-")); assert.ok(archive); assert.equal(fs.readFileSync(path.join(fixture.state, archive, "node_modules", "local-state"), "utf8"), "keep\n");
	});

	it("recovers an interrupted pre-rename marker before updating", () => {
		install(fixture.first);
		const marker = path.join(fixture.state, "install-state.json");
		fs.writeFileSync(marker, JSON.stringify({ version: 1, candidateCommit: fixture.second, previousCommit: fixture.first }));
		install(fixture.second);
		assertDetachedAt(fixture.second); assert.equal(fs.existsSync(marker), false);
	});

	it("accepts marker-only recovery after candidate publication", () => {
		install(fixture.second);
		const marker = path.join(fixture.state, "install-state.json"); fs.writeFileSync(marker, JSON.stringify({ version: 1, candidateCommit: fixture.second, previousCommit: fixture.first }));
		install(fixture.second); assert.equal(fs.existsSync(marker), false); assertDetachedAt(fixture.second);
	});

	it("never deletes or auto-loads a dirty interrupted backup", () => {
		const previous = path.join(fixture.root, "other-extensions", "previous-checkout");
		installExactCommit({ extensionDir: previous, stateDir: path.join(fixture.root, "previous-state"), commit: fixture.first, repositoryUrl: fixture.remote, expectedRepository: (value: string) => path.resolve(value) === path.resolve(fixture.remote), installDependencies: false, quiet: true });
		install(fixture.second);
		const backup = path.join(fixture.state, "previous"); const marker = path.join(fixture.state, "install-state.json");
		fs.renameSync(previous, backup); fs.writeFileSync(marker, JSON.stringify({ version: 1, candidateCommit: fixture.second, previousCommit: fixture.first }));
		fs.writeFileSync(path.join(backup, "payload.txt"), "preserve me\n");
		assert.throws(() => install(fixture.second), /dirty/i);
		assert.equal(fs.readFileSync(path.join(backup, "payload.txt"), "utf8"), "preserve me\n");
		assert.equal(git(["rev-parse", "HEAD"], fixture.install), fixture.second);
		assert.equal(backup.startsWith(`${path.dirname(fixture.install)}${path.sep}`), false); assert.equal(fs.existsSync(marker), true);
	});

	it("does not resurrect a retained backup after explicit removal", () => {
		install(fixture.first); install(fixture.second); assert.equal(fs.existsSync(path.join(fixture.state, "previous")), true);
		assert.equal(removeInstalledExtension({ extensionDir: fixture.install, stateDir: fixture.state }), true); assert.equal(fs.existsSync(fixture.install), false); assert.equal(fs.existsSync(path.join(fixture.state, "previous")), false);
		assert.throws(() => install("f".repeat(40)), /fetch|failed/i); assert.equal(fs.existsSync(fixture.install), false);
	});

	it("keeps an existing checkout intact when candidate preparation fails", () => {
		install(fixture.first);
		assert.throws(() => install(fixture.second, { installDependencies: true, npmCommand: path.join(fixture.root, "missing-npm") }), /missing-npm/i);
		assertDetachedAt(fixture.first);
		assert.equal(fs.readFileSync(path.join(fixture.install, "payload.txt"), "utf8"), "first\n");
		assert.deepEqual(fs.readdirSync(fixture.state).filter((name) => name.startsWith("candidate-")), []);
	});
});
