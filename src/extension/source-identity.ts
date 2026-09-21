import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type DarwinTreeEntry, type DarwinTreeVerifier, darwinHostSupported, openDarwinTreeVerifier } from "./source-identity-darwin.ts";

export const ACTIVE_RUNTIME_SOURCE_IDENTITY_VERSION = 1;
export const ACTIVE_RUNTIME_REPOSITORY = "https://github.com/itrous/pi-subagents.git";

export interface ActiveRuntimeSourceIdentity {
	version: 1;
	kind: "git";
	repository: typeof ACTIVE_RUNTIME_REPOSITORY;
	commit: string;
	digest: string;
}

export type SourceIdentityUnavailableReason =
	| "package_root_unavailable" | "package_root_symlink" | "package_manifest_unavailable"
	| "not_git" | "git_timeout" | "git_failed" | "output_too_large" | "malformed_output"
	| "wrong_root" | "dirty" | "attached_head" | "invalid_commit" | "wrong_remote" | "unverified_source";

export type ActiveRuntimeSourceIdentityResolution =
	| { available: true; sourceIdentity: ActiveRuntimeSourceIdentity }
	| { available: false; sourceIdentityUnavailable: { version: 1; reasonCode: SourceIdentityUnavailableReason } };

interface ProbeCommandResult { status: number | null; stdout: Buffer }
interface GitProbeResult { timedOut?: boolean; outputTooLarge?: boolean; outputBytes?: number; commands: ProbeCommandResult[] }
export type GitProbeRunner = (
	root: string,
	phase: "initial" | "final",
	commit: string | undefined,
	limits: { timeoutMs: number; outputBytes: number },
) => GitProbeResult;

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_OUTPUT_LIMIT = 4 * 1024 * 1024;
const TRACKED_CONTENT_LIMIT = 64 * 1024 * 1024;
const TRACKED_PATH_LIMIT = 4 * 1024 * 1024;
const TRACKED_ENTRY_LIMIT = 20_000;
const TRACKED_COMPONENT_LIMIT = 100_000;
const TRACKED_DEPTH_LIMIT = 64;

function unavailable(reasonCode: SourceIdentityUnavailableReason): ActiveRuntimeSourceIdentityResolution {
	return { available: false, sourceIdentityUnavailable: { version: 1, reasonCode } };
}

export function canonicalSourceIdentityProjection(commit: string): string {
	return JSON.stringify({ version: 1, kind: "git", repository: ACTIVE_RUNTIME_REPOSITORY, commit });
}
export function sourceIdentityDigest(commit: string): string {
	return createHash("sha256").update(canonicalSourceIdentityProjection(commit), "utf8").digest("hex");
}
export function createSourceIdentity(commit: string): ActiveRuntimeSourceIdentity {
	return { version: 1, kind: "git", repository: ACTIVE_RUNTIME_REPOSITORY, commit, digest: sourceIdentityDigest(commit) };
}
export function normalizeForkRemote(value: string): typeof ACTIVE_RUNTIME_REPOSITORY | undefined {
	const trimmed = value.trim().replace(/\/+$/, "");
	const scp = /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(trimmed);
	if (scp) return scp[1]?.toLowerCase() === "itrous" && scp[2]?.replace(/\.git$/i, "").toLowerCase() === "pi-subagents"
		? ACTIVE_RUNTIME_REPOSITORY : undefined;
	return /^(?:https:\/\/github\.com|ssh:\/\/git@github\.com)\/itrous\/pi-subagents(?:\.git)?$/i.test(trimmed)
		? ACTIVE_RUNTIME_REPOSITORY : undefined;
}
export function gitIdentityEnvironment(_env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	// The probe starts a fresh Node process before Git. Use a closed environment so
	// loader/preload/search-path variables cannot execute code in either child.
	return { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
}

const PROBE_SCRIPT = String.raw`
const { spawn } = require("node:child_process");
const root = Buffer.from(process.argv[1], "base64url").toString("utf8");
const phase = process.argv[2], commit = process.argv[3] || undefined;
const timeout = Number(process.argv[4]), limit = Number(process.argv[5]), gitExecutable = process.argv[6];
const commands = phase === "initial" ? [
 ["rev-parse","--show-toplevel"], ["symbolic-ref","-q","HEAD"],
 ["rev-parse","--verify","HEAD^{commit}"],
 ["config","--local","--no-includes","--get-all","remote.origin.url"]
] : [
 ["rev-parse","--show-toplevel"], ["symbolic-ref","-q","HEAD"],
 ["rev-parse","--verify","HEAD^{commit}"],
 ["config","--local","--no-includes","--get-all","remote.origin.url"],
 ["diff-index","--quiet","--cached",commit,"--"],
 ["ls-files","--others","--exclude-standard","-z"]
];
let total=0, done=false, timedOut=false, outputTooLarge=false, active; const results=[], groups=new Set();
const killPid = pid => { try { if (pid && process.platform!=="win32") process.kill(-pid,"SIGKILL"); } catch {} };
const killAll = () => { for (const pid of groups) killPid(pid); try { active?.kill("SIGKILL"); } catch {} };
const finish = () => { if(done)return; done=true; clearTimeout(timer); killAll(); process.stdout.write(JSON.stringify({timedOut,outputTooLarge,commands:results.map(r=>({status:r.status,stdout:r.stdout.toString("base64")}))})); };
const timer=setTimeout(()=>{timedOut=true;finish()},timeout);
const run=args=>new Promise(resolve=>{
 if(done)return resolve(false);
 active=spawn(gitExecutable,["-c","core.fsmonitor=false","-C",root,...args],{detached:process.platform!=="win32",stdio:["ignore","pipe","ignore"],env:process.env,windowsHide:true});
 if (active.pid) groups.add(active.pid);
 const chunks=[];let size=0;
 active.stdout.on("data",chunk=>{if(done)return;size+=chunk.length;total+=chunk.length;if(total>limit){outputTooLarge=true;finish();return}chunks.push(chunk)});
 active.on("error",()=>{killPid(active?.pid);results.push({status:null,stdout:Buffer.alloc(0)});resolve(true)});
 active.on("close",code=>{const pid=active?.pid;killPid(pid);if(!done){results.push({status:code,stdout:Buffer.concat(chunks,size)});resolve(true)}});
});
(async()=>{
 for(const args of commands)if(!await run(args))return;
 if(phase==="initial") {
  const captured=results[2]?.stdout.toString("utf8").trim();
  if(!await run(["diff-index","--quiet","--cached",captured,"--"]))return;
  if(!await run(["ls-files","--others","--exclude-standard","-z"]))return;
  if(!await run(["ls-tree","-r","-z","--full-tree",captured]))return;
 }
 finish();
})().catch(()=>finish());
`;

function gitProbePlatform(): boolean {
	return process.platform === "linux" || process.platform === "darwin";
}

function trustedSystemGitExecutable(): string | undefined {
	if (!gitProbePlatform()) return undefined;
	const executable = "/usr/bin/git";
	try {
		for (const [candidate, kind] of [["/", "directory"], ["/usr", "directory"], ["/usr/bin", "directory"], [executable, "file"]] as const) {
			const stat = fs.lstatSync(candidate);
			if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0
				|| (kind === "directory" ? !stat.isDirectory() : !stat.isFile() || (stat.mode & 0o111) === 0)) return undefined;
		}
		return executable;
	} catch { return undefined; }
}

/** Test seam for process-tree and limit probes; production identity never accepts this path from ambient input. */
export const runGitProbeWithExecutable = (root: string, phase: "initial" | "final", commit: string | undefined, limits: { timeoutMs: number; outputBytes: number }, gitExecutable: string): GitProbeResult => {
	if (!gitProbePlatform() || !path.isAbsolute(gitExecutable)) return { commands: [] };
	const result = spawnSync(process.execPath, ["-e", PROBE_SCRIPT, Buffer.from(root).toString("base64url"), phase, commit ?? "", String(limits.timeoutMs), String(limits.outputBytes), gitExecutable], {
		encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: limits.timeoutMs + 1_000,
		killSignal: "SIGKILL", maxBuffer: PROBE_OUTPUT_LIMIT * 2, env: gitIdentityEnvironment(), windowsHide: true,
	});
	const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
	if (code === "ETIMEDOUT") return { timedOut: true, commands: [] };
	if (code === "ENOBUFS") return { outputTooLarge: true, commands: [] };
	try {
		const parsed = JSON.parse(result.stdout) as { timedOut?: boolean; outputTooLarge?: boolean; commands: Array<{ status: number | null; stdout: string }> };
		const commands = parsed.commands.map((entry) => ({ status: entry.status, stdout: Buffer.from(entry.stdout, "base64") }));
		return { ...(parsed.timedOut ? { timedOut: true } : {}), ...(parsed.outputTooLarge ? { outputTooLarge: true } : {}), outputBytes: commands.reduce((n, c) => n + c.stdout.length, 0), commands };
	} catch { return { commands: [] }; }
};

export const runGitProbe: GitProbeRunner = (root, phase, commit, limits) => {
	const gitExecutable = trustedSystemGitExecutable();
	return gitExecutable ? runGitProbeWithExecutable(root, phase, commit, limits, gitExecutable) : { commands: [] };
};

function oneLine(buffer: Buffer): string | undefined {
	const value = buffer.toString("utf8").replace(/\r\n/g, "\n").replace(/\n$/, "");
	return !value || value.includes("\n") || value.includes("\0") || /[\u0000-\u001f\u007f]/.test(value) ? undefined : value;
}
function sameStat(a: fs.Stats, b: fs.Stats): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function sameNode(a: fs.Stats, b: fs.Stats): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.isDirectory() === b.isDirectory() && a.isFile() === b.isFile() && a.isSymbolicLink() === b.isSymbolicLink();
}
function procPath(fd: number, component?: Buffer): Buffer {
	const base = Buffer.from(`/proc/self/fd/${fd}`);
	return component ? Buffer.concat([base, Buffer.from("/"), component]) : base;
}
function validComponent(component: Buffer): boolean {
	return component.length > 0 && !component.equals(Buffer.from(".")) && !component.equals(Buffer.from("..")) && !component.includes(0) && !component.includes(47);
}
function gitBlobHash(bytes: Buffer): string {
	return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function verifyNamespace(rootFd: number, components: Buffer[], heldDirectoryStats: fs.Stats[], finalStat: fs.Stats, deadline: number): boolean {
	const reopened: number[] = [];
	let parentFd = rootFd;
	try {
		for (let index = 0; index < components.length - 1; index += 1) {
			if (Date.now() >= deadline) return false;
			const fd = fs.openSync(procPath(parentFd, components[index]!), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
			reopened.push(fd);
			if (!sameNode(fs.fstatSync(fd), heldDirectoryStats[index]!)) return false;
			parentFd = fd;
		}
		const finalPath = procPath(parentFd, components.at(-1)!);
		const fresh = fs.lstatSync(finalPath);
		return sameNode(fresh, finalStat) && sameStat(fresh, finalStat);
	} catch { return false; }
	finally { for (const fd of reopened.reverse()) fs.closeSync(fd); }
}

interface TreeRecord { mode: "100644" | "100755"; blob: string; relative: Buffer; components: Buffer[] }
interface TreeCounters { entries: number; pathBytes: number; componentCount: number }

function parseTreeRecord(raw: string, counters: TreeCounters): TreeRecord | SourceIdentityUnavailableReason {
	if (!raw) return "malformed_output";
	if (++counters.entries > TRACKED_ENTRY_LIMIT) return "output_too_large";
	const record = Buffer.from(raw, "latin1"), tab = record.indexOf(9);
	if (tab < 0) return "malformed_output";
	const match = /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40})$/.exec(record.subarray(0, tab).toString("ascii"));
	if (!match) return "malformed_output";
	if (match[1] === "120000" || match[1] === "160000") return "unverified_source";
	const relative = record.subarray(tab + 1);
	counters.pathBytes += relative.length;
	if (counters.pathBytes > TRACKED_PATH_LIMIT || relative.length === 0 || relative[0] === 47) return "output_too_large";
	const components = relative.toString("latin1").split("/").map((value) => Buffer.from(value, "latin1"));
	counters.componentCount += components.length;
	if (components.length > TRACKED_DEPTH_LIMIT || counters.componentCount > TRACKED_COMPONENT_LIMIT) return "output_too_large";
	if (!components.every(validComponent)) return "malformed_output";
	return { mode: match[1] as TreeRecord["mode"], blob: match[3]!, relative, components };
}

/** Darwin has no descriptor-relative path in Node: the pinned helper walks the parsed tree from the held root FD. */
function verifyTreeDarwin(rootFd: number, records: string[], deadline: number, verifier: DarwinTreeVerifier): SourceIdentityUnavailableReason | undefined {
	const counters: TreeCounters = { entries: 0, pathBytes: 0, componentCount: 0 };
	const entries: DarwinTreeEntry[] = [];
	for (const raw of records) {
		if (Date.now() >= deadline) return "git_timeout";
		const parsed = parseTreeRecord(raw, counters);
		if (typeof parsed === "string") return parsed;
		entries.push({ executable: parsed.mode === "100755", blob: parsed.blob, path: parsed.relative });
	}
	return verifier.verify(rootFd, entries, deadline, TRACKED_CONTENT_LIMIT);
}

function verifyTree(rootFd: number, tree: Buffer, deadline: number, onEntryReadForTest?: (relativePath: Buffer) => void, darwin?: DarwinTreeVerifier): SourceIdentityUnavailableReason | undefined {
	if (tree.length > 0 && tree.at(-1) !== 0) return "malformed_output";
	if (tree.length === 0) return undefined;
	const records = tree.subarray(0, tree.length - 1).toString("latin1").split("\0");
	if (darwin) return verifyTreeDarwin(rootFd, records, deadline, darwin);
	const counters: TreeCounters = { entries: 0, pathBytes: 0, componentCount: 0 };
	let contentBytes = 0;
	const verifiedEntries: Array<{ components: Buffer[]; directoryStats: fs.Stats[]; finalStat: fs.Stats }> = [];
	for (const raw of records) {
		if (Date.now() >= deadline) return "git_timeout";
		const parsed = parseTreeRecord(raw, counters);
		if (typeof parsed === "string") return parsed;
		const { mode, blob, relative, components } = parsed;
		const opened: number[] = [], heldDirectoryStats: fs.Stats[] = [];
		let parentFd = rootFd;
		try {
			for (const component of components.slice(0, -1)) {
				if (Date.now() >= deadline) return "git_timeout";
				const fd = fs.openSync(procPath(parentFd, component), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
				opened.push(fd); heldDirectoryStats.push(fs.fstatSync(fd)); parentFd = fd;
			}
			const finalPath = procPath(parentFd, components.at(-1)!);
			let bytesRead: Buffer, finalStat: fs.Stats;
			const fd = fs.openSync(finalPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
			try {
				const before = fs.fstatSync(fd); finalStat = before;
				if (!before.isFile() || Boolean(before.mode & 0o100) !== (mode === "100755")) return "dirty";
				if (before.size > TRACKED_CONTENT_LIMIT - contentBytes) return "output_too_large";
				bytesRead = fs.readFileSync(fd);
				if (!sameStat(before, fs.fstatSync(fd)) || bytesRead.length !== before.size) return "dirty";
			} finally { fs.closeSync(fd); }
			contentBytes += bytesRead.length;
			if (contentBytes > TRACKED_CONTENT_LIMIT || gitBlobHash(bytesRead) !== blob) return "dirty";
			onEntryReadForTest?.(Buffer.from(relative));
			if (Date.now() >= deadline) return "git_timeout";
			if (!verifyNamespace(rootFd, components, heldDirectoryStats, finalStat, deadline)) return Date.now() >= deadline ? "git_timeout" : "dirty";
			verifiedEntries.push({ components: components.map((component) => Buffer.from(component)), directoryStats: [...heldDirectoryStats], finalStat });
		} catch { return "dirty"; }
		finally { for (const fd of opened.reverse()) fs.closeSync(fd); }
	}
	// A later entry may race and mutate one already verified. Recheck every
	// namespace binding and complete stat only after the full tree was read.
	for (const entry of verifiedEntries) {
		if (Date.now() >= deadline) return "git_timeout";
		if (!verifyNamespace(rootFd, entry.components, entry.directoryStats, entry.finalStat, deadline)) return Date.now() >= deadline ? "git_timeout" : "dirty";
	}
	return undefined;
}

function probeFailure(probe: GitProbeResult, expectedCommands: number, remainingOutput: number): SourceIdentityUnavailableReason | undefined {
	const bytes = probe.commands.reduce((n, command) => n + command.stdout.length, 0);
	if (probe.outputTooLarge || (probe.outputBytes ?? bytes) > remainingOutput || bytes > remainingOutput) return "output_too_large";
	if (probe.timedOut) return "git_timeout";
	if (probe.commands.length !== expectedCommands) return "git_failed";
	return undefined;
}
function parseMetadata(commands: ProbeCommandResult[], packageRoot: string, commit?: string): { commit: string } | SourceIdentityUnavailableReason {
	const [top, symbolic, head, remote, cached] = commands;
	if (top!.status !== 0) return "not_git";
	const topText = oneLine(top!.stdout);
	if (!topText || !path.isAbsolute(topText)) return "malformed_output";
	let realTop: string;
	try { realTop = fs.realpathSync.native(topText); } catch { return "wrong_root"; }
	if (realTop !== packageRoot) return "wrong_root";
	if (symbolic!.status === 0) return "attached_head";
	if (symbolic!.status !== 1) return "git_failed";
	const parsedCommit = oneLine(head!.stdout);
	if (head!.status !== 0 || !parsedCommit || !/^[0-9a-f]{40}$/.test(parsedCommit) || (commit && parsedCommit !== commit)) return "invalid_commit";
	const remoteText = oneLine(remote!.stdout);
	if (remote!.status !== 0 || !remoteText || normalizeForkRemote(remoteText) !== ACTIVE_RUNTIME_REPOSITORY) return "wrong_remote";
	if (cached!.status === 1) return "dirty";
	if (cached!.status !== 0) return "git_failed";
	return { commit: parsedCommit };
}

export function resolveActiveRuntimeSourceIdentity(options: {
	packageRoot?: string;
	runProbe?: GitProbeRunner;
	/** Test-only race seam, invoked after anchored bytes are read and before namespace recheck. Linux only: on Darwin the helper process walks the tree and the seam is never invoked. */
	onEntryReadForTest?: (relativePath: Buffer) => void;
} = {}): ActiveRuntimeSourceIdentityResolution {
	const linux = process.platform === "linux" && fs.existsSync("/proc/self/fd");
	if (!linux && !darwinHostSupported()) return unavailable("unverified_source");
	const lexicalRoot = path.resolve(options.packageRoot ?? PACKAGE_ROOT);
	let packageRoot: string;
	try { packageRoot = fs.realpathSync.native(lexicalRoot); } catch { return unavailable("package_root_unavailable"); }
	if (packageRoot !== lexicalRoot) return unavailable("package_root_symlink");
	try { const manifest = fs.lstatSync(path.join(packageRoot, "package.json")); if (!manifest.isFile() || manifest.isSymbolicLink()) return unavailable("package_manifest_unavailable"); }
	catch { return unavailable("package_manifest_unavailable"); }
	if (!fs.existsSync(path.join(packageRoot, ".git"))) return unavailable("not_git");
	let rootFd: number;
	try { rootFd = fs.openSync(packageRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
	catch { return unavailable("package_root_unavailable"); }
	let darwin: DarwinTreeVerifier | undefined;
	try {
		const rootStat = fs.fstatSync(rootFd), runner = options.runProbe ?? runGitProbe, startedAt = Date.now();
		if (!linux) {
			if (!options.runProbe && !trustedSystemGitExecutable()) return unavailable("unverified_source");
			darwin = openDarwinTreeVerifier();
			if (!darwin) return unavailable("unverified_source");
		}
		let usedOutput = 0;
		const remaining = () => ({ timeoutMs: Math.max(1, PROBE_TIMEOUT_MS - (Date.now() - startedAt)), outputBytes: Math.max(0, PROBE_OUTPUT_LIMIT - usedOutput) });
		let initial: GitProbeResult;
		try { initial = runner(packageRoot, "initial", undefined, remaining()); } catch { return unavailable("git_failed"); }
		let failure = probeFailure(initial, 7, PROBE_OUTPUT_LIMIT - usedOutput);
		if (failure) return unavailable(failure);
		usedOutput += initial.outputBytes ?? initial.commands.reduce((n, c) => n + c.stdout.length, 0);
		// Git reports "not a repository" as 128; the Darwin /usr/bin/git shim exits otherwise when its toolchain is unusable.
		if (darwin && initial.commands[0]!.status !== 0 && initial.commands[0]!.status !== 128) return unavailable("git_failed");
		const initialMetadata = parseMetadata(initial.commands, packageRoot);
		if (typeof initialMetadata === "string") return unavailable(initialMetadata);
		const initialStatus = initial.commands[5]!;
		if (initialStatus.status !== 0) return unavailable("git_failed");
		if (initialStatus.stdout.length !== 0) return unavailable("dirty");
		const tree = initial.commands[6]!;
		if (tree.status !== 0) return unavailable("git_failed");
		const treeFailure = verifyTree(rootFd, tree.stdout, startedAt + PROBE_TIMEOUT_MS, options.onEntryReadForTest, darwin);
		if (treeFailure) return unavailable(treeFailure);
		if (Date.now() - startedAt >= PROBE_TIMEOUT_MS) return unavailable("git_timeout");
		let final: GitProbeResult;
		try { final = runner(packageRoot, "final", initialMetadata.commit, remaining()); } catch { return unavailable("git_failed"); }
		failure = probeFailure(final, 6, PROBE_OUTPUT_LIMIT - usedOutput);
		if (failure) return unavailable(failure);
		if (Date.now() - startedAt >= PROBE_TIMEOUT_MS) return unavailable("git_timeout");
		const finalMetadata = parseMetadata(final.commands, packageRoot, initialMetadata.commit);
		if (typeof finalMetadata === "string") return unavailable(finalMetadata);
		const finalStatus = final.commands[5]!;
		if (finalStatus.status !== 0) return unavailable("git_failed");
		if (finalStatus.stdout.length !== 0) return unavailable("dirty");
		// Metadata commands consume time during which the worktree can change.
		// Re-read the anchored HEAD tree after that probe before publishing identity.
		const finalTreeFailure = verifyTree(rootFd, tree.stdout, startedAt + PROBE_TIMEOUT_MS, undefined, darwin);
		if (finalTreeFailure) return unavailable(finalTreeFailure);
		let freshRoot: fs.Stats;
		try { freshRoot = fs.lstatSync(packageRoot); } catch { return unavailable("wrong_root"); }
		if (!freshRoot.isDirectory() || freshRoot.isSymbolicLink() || freshRoot.dev !== rootStat.dev || freshRoot.ino !== rootStat.ino) return unavailable("wrong_root");
		return { available: true, sourceIdentity: createSourceIdentity(initialMetadata.commit) };
	} finally { darwin?.dispose(); fs.closeSync(rootFd); }
}
