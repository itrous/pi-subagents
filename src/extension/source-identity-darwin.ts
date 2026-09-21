import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceIdentityUnavailableReason } from "./source-identity.ts";

/** SHA256 of the tracked universal executable built by scripts/build-source-identity-darwin.mjs. */
export const DARWIN_HELPER_SHA256 = "4bfb1b9d111c51f626d1631639e83ac8ed1d09e525d40f0d58948e1cf50b06e0";
const HELPER_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "native", "source-identity-darwin");
const HELPER_SIZE_LIMIT = 1024 * 1024;
const REQUEST_MAGIC = Buffer.from("PISIDQ01", "ascii");
const RESPONSE_MAGIC = Buffer.from("PISIDR01", "ascii");
const RESPONSE_CODES: ReadonlyArray<SourceIdentityUnavailableReason | undefined> = [undefined, "dirty", "output_too_large", "git_timeout", "malformed_output"];
/** Darwin 24 is macOS 15, the oldest verified target. */
const MIN_DARWIN_KERNEL_MAJOR = 24;

export interface DarwinTreeEntry { executable: boolean; blob: string; path: Buffer }
export interface DarwinTreeVerifier {
	verify(rootFd: number, entries: readonly DarwinTreeEntry[], deadline: number, contentLimit: number): SourceIdentityUnavailableReason | undefined;
	dispose(): void;
}

export function darwinHostSupported(): boolean {
	if (process.platform !== "darwin" || (process.arch !== "arm64" && process.arch !== "x64")) return false;
	const major = Number(os.release().split(".")[0]);
	return Number.isInteger(major) && major >= MIN_DARWIN_KERNEL_MAJOR;
}

function readHelper(): Buffer | undefined {
	let fd: number;
	try { fd = fs.openSync(HELPER_PATH, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { return undefined; }
	try {
		const before = fs.fstatSync(fd);
		if (!before.isFile() || (before.mode & 0o100) === 0 || before.size > HELPER_SIZE_LIMIT) return undefined;
		const bytes = Buffer.alloc(before.size + 1);
		let length = 0;
		for (let read = -1; read !== 0 && length < bytes.length;) { read = fs.readSync(fd, bytes, length, bytes.length - length, null); length += read; }
		const after = fs.fstatSync(fd);
		if (length !== before.size || after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size
			|| after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return undefined;
		const helper = bytes.subarray(0, length);
		return createHash("sha256").update(helper).digest("hex") === DARWIN_HELPER_SHA256 ? helper : undefined;
	} catch { return undefined; }
	finally { fs.closeSync(fd); }
}

function encodeRequest(entries: readonly DarwinTreeEntry[], deadlineMs: number, contentLimit: number): Buffer {
	const header = Buffer.alloc(24);
	REQUEST_MAGIC.copy(header, 0);
	header.writeUInt32LE(deadlineMs, 8);
	header.writeUInt32LE(entries.length, 12);
	header.writeBigUInt64LE(BigInt(contentLimit), 16);
	const parts: Buffer[] = [header];
	for (const entry of entries) {
		const fixed = Buffer.alloc(25);
		fixed[0] = entry.executable ? 1 : 0;
		Buffer.from(entry.blob, "hex").copy(fixed, 1);
		fixed.writeUInt32LE(entry.path.length, 21);
		parts.push(fixed, entry.path);
	}
	return Buffer.concat(parts);
}

/**
 * Snapshots the pinned helper into a private directory so the executed bytes are
 * exactly the verified ones. Any failure leaves the Darwin backend unavailable.
 */
export function openDarwinTreeVerifier(): DarwinTreeVerifier | undefined {
	if (!darwinHostSupported()) return undefined;
	const helper = readHelper();
	if (!helper) return undefined;
	let directory: string;
	try { directory = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "pi-subagents-source-identity-")); } catch { return undefined; }
	const executable = path.join(directory, "verifier");
	const dispose = () => { try { fs.rmSync(executable, { force: true }); fs.rmdirSync(directory); } catch { /* best effort, own artifacts only */ } };
	try { fs.writeFileSync(executable, helper, { mode: 0o500, flag: "wx" }); } catch { dispose(); return undefined; }
	return {
		dispose,
		verify(rootFd, entries, deadline, contentLimit) {
			const remainingMs = Math.min(2_000, Math.floor(deadline - Date.now()));
			if (remainingMs <= 0) return "git_timeout";
			const result = spawnSync(executable, [], {
				input: encodeRequest(entries, remainingMs, contentLimit), stdio: ["pipe", "pipe", "ignore", rootFd],
				env: {}, timeout: remainingMs, killSignal: "SIGKILL", maxBuffer: RESPONSE_MAGIC.length + 1, windowsHide: true,
			});
			const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
			if (code === "ETIMEDOUT") return "git_timeout";
			if (code === "ENOBUFS") return "malformed_output";
			if (result.error || result.status !== 0 || result.signal) return "unverified_source";
			const out = result.stdout;
			if (!Buffer.isBuffer(out) || out.length !== RESPONSE_MAGIC.length + 1 || !out.subarray(0, RESPONSE_MAGIC.length).equals(RESPONSE_MAGIC)) return "malformed_output";
			const verdict = out[RESPONSE_MAGIC.length]!;
			return verdict < RESPONSE_CODES.length ? RESPONSE_CODES[verdict] : "malformed_output";
		},
	};
}
