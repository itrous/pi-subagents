import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const FORK_REPOSITORY_URL = "https://github.com/itrous/pi-subagents.git";
const EXACT_COMMIT = /^[0-9a-f]{40}$/;

export function parseExactCommit(value) {
	if (typeof value !== "string" || !EXACT_COMMIT.test(value)) {
		throw new Error("An exact lowercase 40-hex commit is required via --commit <sha>.");
	}
	return value;
}

export function normalizeForkRepository(value) {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().replace(/\/+$/, "");
	const scp = /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(trimmed);
	if (scp) return scp[1]?.toLowerCase() === "itrous" && scp[2]?.replace(/\.git$/i, "").toLowerCase() === "pi-subagents"
		? FORK_REPOSITORY_URL : undefined;
	return /^(?:https:\/\/github\.com|ssh:\/\/git@github\.com)\/itrous\/pi-subagents(?:\.git)?$/i.test(trimmed)
		? FORK_REPOSITORY_URL : undefined;
}

function gitEnvironment(env) {
	return {
		...Object.fromEntries(Object.entries(env).filter(([key]) => {
			const upper = key.toUpperCase();
			return !upper.startsWith("GIT_") && !upper.startsWith("NPM_CONFIG_") && upper !== "NODE_OPTIONS" && upper !== "NODE_PATH";
		})),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_TERMINAL_PROMPT: "0",
		NPM_CONFIG_DRY_RUN: "false",
		NPM_CONFIG_GLOBAL: "false",
		NPM_CONFIG_IGNORE_SCRIPTS: "true",
		NPM_CONFIG_OMIT: "dev",
		LC_ALL: "C",
	};
}

function run(command, args, options) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		env: options.env,
		encoding: "utf8",
		stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
		windowsHide: true,
		maxBuffer: 4 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) {
		const detail = typeof result.stderr === "string" ? result.stderr.trim() : "";
		throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`, { cause: result.error });
	}
	return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

function git(args, cwd, env, inherit = false) {
	return run("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env, inherit });
}

function localOriginUrls(checkout, env) {
	return git(["config", "--local", "--no-includes", "-z", "--get-all", "remote.origin.url"], checkout, env)
		.split("\0").filter((value) => value.length > 0);
}

function assertOrigin(checkout, expectedRepository, env) {
	let urls;
	try { urls = localOriginUrls(checkout, env); }
	catch { throw new Error("Installation has no readable local origin remote."); }
	if (urls.length !== 1 || !expectedRepository(urls[0])) {
		throw new Error(`Installation has a rejected origin remote (${urls.length} configured value${urls.length === 1 ? "" : "s"}).`);
	}
}

function assertPlainCheckout(extensionDir, expectedRepository, env) {
	const stat = fs.lstatSync(extensionDir);
	const gitDir = path.join(extensionDir, ".git");
	const gitStat = fs.lstatSync(gitDir);
	if (!stat.isDirectory() || stat.isSymbolicLink() || !gitStat.isDirectory() || gitStat.isSymbolicLink()) {
		throw new Error(`Existing installation is not a plain Git checkout: ${extensionDir}`);
	}
	const top = fs.realpathSync.native(git(["rev-parse", "--show-toplevel"], extensionDir, env));
	if (top !== fs.realpathSync.native(extensionDir)) throw new Error("Existing installation Git root does not match its installation directory.");
	assertOrigin(extensionDir, expectedRepository, env);
	const head = git(["rev-parse", "--verify", "HEAD^{commit}"], extensionDir, env);
	return { rootDev: stat.dev, rootIno: stat.ino, gitDev: gitStat.dev, gitIno: gitStat.ino, head };
}

function assertRawTrackedTree(extensionDir, env) {
	const tree = git(["ls-tree", "-r", "-z", "--full-tree", "HEAD"], extensionDir, env);
	let entries = 0, bytes = 0;
	for (const record of tree.split("\0").filter(Boolean)) {
		if (++entries > 20_000) throw new Error("Tracked tree exceeds installer entry limit.");
		const tab = record.indexOf("\t"), header = tab < 0 ? "" : record.slice(0, tab), relative = tab < 0 ? "" : record.slice(tab + 1);
		const match = /^(100644|100755) blob ([0-9a-f]{40})$/.exec(header);
		if (!match || !relative || relative.includes("�")) throw new Error("Tracked tree contains an unsupported entry.");
		const components = relative.split("/"); if (components.some((part) => !part || part === "." || part === "..")) throw new Error("Tracked tree contains an unsafe path.");
		let current = extensionDir;
		for (const component of components) { current = path.join(current, component); const stat = fs.lstatSync(current); if (stat.isSymbolicLink()) throw new Error("Tracked tree contains a symlink."); }
		const stat = fs.lstatSync(current); if (!stat.isFile() || Boolean(stat.mode & 0o100) !== (match[1] === "100755")) throw new Error("Tracked file mode differs from HEAD.");
		if (stat.size > 64 * 1024 * 1024 - bytes) throw new Error("Tracked tree exceeds installer byte limit.");
		const content = fs.readFileSync(current); bytes += content.length;
		const digest = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
		if (digest !== match[2]) throw new Error("Tracked checkout bytes differ from HEAD.");
	}
}

function assertCleanCheckout(extensionDir, env) {
	const indexed = git(["ls-files", "-v", "-z"], extensionDir, env).split("\0").filter(Boolean);
	if (indexed.some((entry) => !entry.startsWith("H "))) {
		throw new Error("Existing installation has hidden or nonstandard index flags; refusing to update it.");
	}
	try {
		git(["diff-index", "--quiet", "--cached", "HEAD", "--"], extensionDir, env);
		git(["diff-files", "--quiet", "--"], extensionDir, env);
	} catch { throw new Error("Existing installation is dirty; refusing to discard local changes."); }
	if (git(["status", "--porcelain=v1", "--untracked-files=all"], extensionDir, env)) {
		throw new Error("Existing installation is dirty; refusing to discard local changes.");
	}
	assertRawTrackedTree(extensionDir, env);
}

function verifyInstalledCheckout(extensionDir, commit, expectedRepository, env) {
	const flags = fs.constants.O_RDONLY | (process.platform === "linux" ? fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW : 0);
	const rootFd = fs.openSync(extensionDir, flags); const held = fs.fstatSync(rootFd);
	const anchored = process.platform === "linux" && fs.existsSync("/proc/self/fd") ? `/proc/self/fd/${rootFd}` : extensionDir;
	try {
		const gitStat = fs.lstatSync(path.join(anchored, ".git"));
		if (!held.isDirectory() || gitStat.isSymbolicLink() || !gitStat.isDirectory()) throw new Error("Installed checkout is not a plain Git directory.");
		const head = git(["rev-parse", "--verify", "HEAD^{commit}"], anchored, env);
		if (head !== commit) throw new Error(`Installed HEAD ${head || "<missing>"} does not equal requested commit ${commit}.`);
		const symbolic = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "symbolic-ref", "-q", "HEAD"], {
			cwd: anchored, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
		});
		if (symbolic.status !== 1) throw new Error("Installed checkout is not detached.");
		assertOrigin(anchored, expectedRepository, env); assertCleanCheckout(anchored, env);
		const finalPath = fs.lstatSync(extensionDir), finalHeld = fs.fstatSync(rootFd);
		if (finalPath.isSymbolicLink() || !finalPath.isDirectory() || finalPath.dev !== held.dev || finalPath.ino !== held.ino || finalHeld.dev !== held.dev || finalHeld.ino !== held.ino) throw new Error("Installed checkout path changed during verification.");
	} finally { fs.closeSync(rootFd); }
}

function createCandidate(stateDir, repositoryUrl, commit, expectedRepository, env, options) {
	const candidate = fs.mkdtempSync(path.join(stateDir, "candidate-"));
	try {
		git(["init"], candidate, env, options.quiet !== true);
		git(["remote", "add", "origin", repositoryUrl], candidate, env);
		assertOrigin(candidate, expectedRepository, env);
		// Fetch from the literal repository in this new config-only checkout. No
		// existing installation config can rewrite or redirect the transport.
		git(["fetch", "--no-tags", "--depth=1", "--", repositoryUrl, commit], candidate, env, options.quiet !== true);
		git(["checkout", "--detach", commit], candidate, env, options.quiet !== true);
		if (options.installDependencies !== false) {
			const npmRun = (args) => {
				if (Array.isArray(options.npmCommand)) return run(options.npmCommand[0], [...options.npmCommand.slice(1), ...args], { cwd: candidate, env, inherit: options.quiet !== true });
				if (process.platform === "win32" && options.npmCommand === undefined) return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`], { cwd: candidate, env, inherit: options.quiet !== true });
				return run(options.npmCommand ?? "npm", args, { cwd: candidate, env, inherit: options.quiet !== true });
			};
			npmRun(["ci", "--location=project", "--global=false", "--omit=dev", "--ignore-scripts", "--dry-run=false", "--package-lock=true", "--audit=false", "--fund=false"]);
			npmRun(["ls", "--location=project", "--global=false", "--omit=dev", "--all"]);
		}
		verifyInstalledCheckout(candidate, commit, expectedRepository, env);
		return candidate;
	} catch (error) {
		fs.rmSync(candidate, { recursive: true, force: true });
		throw error;
	}
}

function sameCheckoutSnapshot(a, b) {
	return a.rootDev === b.rootDev && a.rootIno === b.rootIno && a.gitDev === b.gitDev && a.gitIno === b.gitIno;
}

function publicationPaths(stateDir) {
	return { backup: path.join(stateDir, "previous"), marker: path.join(stateDir, "install-state.json") };
}

function fsyncDirectory(directory) {
	const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
	try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function syncPublicationDirectories(extensionDir, stateDir) {
	fsyncDirectory(path.dirname(extensionDir)); fsyncDirectory(stateDir);
}

function writePublishMarker(marker, candidateCommit, previousCommit) {
	const fd = fs.openSync(marker, "wx", 0o600);
	try { fs.writeFileSync(fd, JSON.stringify({ version: 1, candidateCommit, previousCommit })); fs.fsyncSync(fd); }
	finally { fs.closeSync(fd); }
	fsyncDirectory(path.dirname(marker));
}

function readPublishMarker(marker) {
	let state;
	try { state = JSON.parse(fs.readFileSync(marker, "utf8")); } catch { throw new Error("Interrupted installer marker is missing or malformed; refusing automatic recovery."); }
	if (state?.version !== 1) throw new Error("Interrupted installer marker has an unsupported version; refusing automatic recovery.");
	return { candidateCommit: parseExactCommit(state.candidateCommit), previousCommit: parseExactCommit(state.previousCommit) };
}

function recoverInterruptedPublish(extensionDir, stateDir, expectedRepository, env) {
	const { backup, marker } = publicationPaths(stateDir);
	const hasBackup = fs.existsSync(backup), hasMarker = fs.existsSync(marker);
	if (!hasBackup && !hasMarker) return;
	if (!hasMarker) {
		if (!fs.existsSync(extensionDir)) { const snapshot = assertPlainCheckout(backup, expectedRepository, env); verifyInstalledCheckout(backup, snapshot.head, expectedRepository, env); fs.renameSync(backup, extensionDir); return; }
		const archive = path.join(stateDir, `archive-${Date.now()}-${process.pid}`);
		fs.renameSync(backup, archive); return;
	}
	const state = readPublishMarker(marker);
	if (!hasBackup) {
		try { verifyInstalledCheckout(extensionDir, state.candidateCommit, expectedRepository, env); }
		catch { verifyInstalledCheckout(extensionDir, state.previousCommit, expectedRepository, env); }
		fs.rmSync(marker, { force: true }); return;
	}
	// The previous checkout is never deleted or restored until its exact old
	// commit and cleanliness have both been re-established.
	verifyInstalledCheckout(backup, state.previousCommit, expectedRepository, env);
	if (!fs.existsSync(extensionDir)) {
		fs.renameSync(backup, extensionDir); fs.rmSync(marker, { force: true }); return;
	}
	try { verifyInstalledCheckout(extensionDir, state.candidateCommit, expectedRepository, env); }
	catch (error) {
		const failed = path.join(stateDir, `failed-${Date.now()}-${process.pid}`);
		fs.renameSync(extensionDir, failed); fs.renameSync(backup, extensionDir); fs.rmSync(marker, { force: true });
		throw new Error(`Recovered the previous installation; preserved the interrupted candidate at ${failed}.`, { cause: error });
	}
	// Finish recovery only after candidate verification. A later archive failure
	// leaves both valid checkouts and the marker intact for another attempt.
	const archive = path.join(stateDir, `archive-${Date.now()}-${process.pid}`);
	fs.renameSync(backup, archive); fs.rmSync(marker, { force: true });
}

function cleanupOrphanCandidates(stateDir) {
	for (const name of fs.readdirSync(stateDir)) {
		if (!/^candidate-[A-Za-z0-9]+$/.test(name)) continue;
		const candidate = path.join(stateDir, name), stat = fs.lstatSync(candidate);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing to clean malformed installer candidate ${name}.`);
		fs.rmSync(candidate, { recursive: true });
	}
}

function verifyAtomicPublicationBoundary(parentDir, stateDir) {
	const source = path.join(stateDir, `rename-probe-${process.pid}-${Date.now()}`), target = path.join(parentDir, `.rename-probe-${process.pid}-${Date.now()}`);
	fs.writeFileSync(source, "");
	try { fs.renameSync(source, target); fs.renameSync(target, source); }
	finally { fs.rmSync(source, { force: true }); fs.rmSync(target, { force: true }); }
}

function acquireInstallerLock(stateDir) {
	const lockDir = path.join(stateDir, "install.lock"), token = `${process.pid}-${randomUUID()}`;
	try {
		fs.mkdirSync(lockDir);
		fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ version: 1, pid: process.pid, token }), { flag: "wx", mode: 0o600 });
	} catch (error) {
		if (error?.code === "EEXIST") throw new Error(`Installer lock already exists at ${lockDir}; refuse automatic stale-lock takeover.`);
		throw error;
	}
	return () => {
		let current; try { current = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")); } catch {}
		if (current?.token !== token) throw new Error("Installer lock ownership changed before release.");
		fs.rmSync(lockDir, { recursive: true, force: true });
	};
}

function publishCandidate(candidate, extensionDir, stateDir, commit, originalSnapshot, expectedRepository, env) {
	if (!fs.existsSync(extensionDir)) { fs.renameSync(candidate, extensionDir); syncPublicationDirectories(extensionDir, stateDir); return { fresh: true }; }
	const currentSnapshot = assertPlainCheckout(extensionDir, expectedRepository, env); assertCleanCheckout(extensionDir, env);
	if (!originalSnapshot || !sameCheckoutSnapshot(originalSnapshot, currentSnapshot)) throw new Error("Existing installation changed while the candidate was prepared; refusing to replace it.");
	const { backup, marker } = publicationPaths(stateDir);
	if (fs.existsSync(backup) || fs.existsSync(marker)) throw new Error("A previous installer publication has not been recovered.");
	writePublishMarker(marker, commit, originalSnapshot.head);
	fs.renameSync(extensionDir, backup); syncPublicationDirectories(extensionDir, stateDir);
	try {
		const movedSnapshot = assertPlainCheckout(backup, expectedRepository, env); assertCleanCheckout(backup, env);
		if (!sameCheckoutSnapshot(originalSnapshot, movedSnapshot) || movedSnapshot.head !== originalSnapshot.head) throw new Error("The installation changed during publication.");
		fs.renameSync(candidate, extensionDir); syncPublicationDirectories(extensionDir, stateDir);
		return { backup, marker };
	} catch (error) {
		if (!fs.existsSync(extensionDir) && fs.existsSync(backup)) fs.renameSync(backup, extensionDir);
		fs.rmSync(marker, { force: true });
		throw error;
	}
}

export function installExactCommit(options) {
	if (process.platform !== "linux" || !fs.existsSync("/proc/self/fd")) throw new Error("The attested active-runtime installer requires Linux procfs.");
	const commit = parseExactCommit(options.commit);
	const repositoryUrl = options.repositoryUrl ?? FORK_REPOSITORY_URL;
	if (typeof options.extensionDir !== "string" || typeof options.stateDir !== "string") throw new Error("Installer extensionDir and stateDir are required.");
	const extensionDir = path.resolve(options.extensionDir);
	const parentDir = path.dirname(extensionDir);
	const stateDir = path.resolve(options.stateDir);
	if (stateDir === extensionDir || stateDir.startsWith(`${extensionDir}${path.sep}`) || stateDir === parentDir || stateDir.startsWith(`${parentDir}${path.sep}`)) throw new Error("Installer stateDir must be outside Pi's extensions directory.");
	const env = gitEnvironment(options.env ?? process.env);
	const expectedRepository = options.expectedRepository ?? ((value) => normalizeForkRepository(value) === FORK_REPOSITORY_URL);

	fs.mkdirSync(parentDir, { recursive: true }); fs.mkdirSync(stateDir, { recursive: true });
	const realParentDir = fs.realpathSync.native(parentDir), realStateDir = fs.realpathSync.native(stateDir);
	if (realStateDir === realParentDir || realStateDir.startsWith(`${realParentDir}${path.sep}`)) throw new Error("Installer stateDir resolves inside Pi's extensions directory.");
	if (fs.statSync(realParentDir).dev !== fs.statSync(realStateDir).dev) throw new Error("Installer state and extension directories must share one filesystem for atomic publication.");
	const releaseLock = acquireInstallerLock(stateDir);
	try {
		cleanupOrphanCandidates(realStateDir);
		verifyAtomicPublicationBoundary(realParentDir, realStateDir);
		recoverInterruptedPublish(extensionDir, stateDir, expectedRepository, env);
		let originalSnapshot;
		if (fs.existsSync(extensionDir)) {
			originalSnapshot = assertPlainCheckout(extensionDir, expectedRepository, env);
			assertCleanCheckout(extensionDir, env);
		}
		const candidate = createCandidate(stateDir, repositoryUrl, commit, expectedRepository, env, options);
		let publication;
		try {
			publication = publishCandidate(candidate, extensionDir, stateDir, commit, originalSnapshot, expectedRepository, env);
			verifyInstalledCheckout(extensionDir, commit, expectedRepository, env);
		} catch (error) {
			if (fs.existsSync(candidate)) fs.rmSync(candidate, { recursive: true, force: true });
			if (publication?.fresh && fs.existsSync(extensionDir)) {
				fs.renameSync(extensionDir, path.join(stateDir, `failed-${Date.now()}-${process.pid}`));
			}
			if (publication?.backup && fs.existsSync(publication.backup)) {
				if (fs.existsSync(extensionDir)) fs.renameSync(extensionDir, path.join(stateDir, `failed-${Date.now()}-${process.pid}`));
				fs.renameSync(publication.backup, extensionDir); fs.rmSync(publication.marker, { force: true });
			}
			throw error;
		}
		if (publication?.backup) {
			const finalOldSnapshot = assertPlainCheckout(publication.backup, expectedRepository, env); assertCleanCheckout(publication.backup, env);
			if (!originalSnapshot || !sameCheckoutSnapshot(originalSnapshot, finalOldSnapshot) || finalOldSnapshot.head !== originalSnapshot.head) throw new Error("Previous installation changed before cleanup; preserving it for recovery.");
			// Never recursively delete the old checkout: Git cleanliness intentionally
			// ignores ignored files such as node_modules and cannot classify them as
			// disposable user data. The backup is archived on the next update.
		}
		if (publication?.marker) { fs.rmSync(publication.marker, { force: true }); fsyncDirectory(stateDir); }
		return { extensionDir, commit, repository: repositoryUrl };
	} finally { releaseLock(); }
}

function archivePreviousForRemoval(stateDir) {
	const { backup, marker } = publicationPaths(stateDir);
	if (fs.existsSync(backup)) fs.renameSync(backup, path.join(stateDir, `archive-removed-${Date.now()}-${process.pid}`));
	fs.rmSync(marker, { force: true }); fsyncDirectory(stateDir);
}

export function removeInstalledExtension(options) {
	if (process.platform !== "linux" || !fs.existsSync("/proc/self/fd")) throw new Error("The attested active-runtime installer requires Linux procfs.");
	if (typeof options.extensionDir !== "string" || typeof options.stateDir !== "string") throw new Error("Installer extensionDir and stateDir are required.");
	const extensionDir = path.resolve(options.extensionDir), parentDir = path.dirname(extensionDir), stateDir = path.resolve(options.stateDir);
	fs.mkdirSync(parentDir, { recursive: true }); fs.mkdirSync(stateDir, { recursive: true });
	const realParentDir = fs.realpathSync.native(parentDir), realStateDir = fs.realpathSync.native(stateDir);
	if (realStateDir === realParentDir || realStateDir.startsWith(`${realParentDir}${path.sep}`)) throw new Error("Installer stateDir resolves inside Pi's extensions directory.");
	const releaseLock = acquireInstallerLock(realStateDir);
	try {
		archivePreviousForRemoval(realStateDir);
		let stat; try { stat = fs.lstatSync(extensionDir); } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Refusing to remove a non-directory or symlink installation path.");
		fs.rmSync(extensionDir, { recursive: true }); fsyncDirectory(parentDir); return true;
	} finally { releaseLock(); }
}
