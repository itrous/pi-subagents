import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalSha256 } from "../../shared/canonical-json.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";
import { packageTreeEvidence } from "./package-tree-evidence.ts";

type PiCommandRole = "executable" | "script" | "interpreter" | "wrapper-target" | "runtime-package";
export interface PiCommandEvidenceV1 {
	version: 1;
	entries: Array<{ role: PiCommandRole; pathDigest: string; contentDigest: string }>;
	digest: string;
}

function resolvePathCommand(command: string, cwd: string): string {
	if (path.isAbsolute(command)) return command;
	if (command.includes(path.sep)) return path.resolve(cwd, command);
	const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
	for (const rawDirectory of (process.env.PATH ?? "").split(path.delimiter)) {
		const directory = rawDirectory ? path.resolve(cwd, rawDirectory) : cwd;
		for (const extension of extensions) {
			const candidate = path.join(directory, process.platform === "win32" && !path.extname(command) ? `${command}${extension.toLowerCase()}` : command);
			try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
		}
	}
	throw new Error("Cannot resolve Pi executable.");
}
function measured(role: PiCommandRole, file: string): { evidence: PiCommandEvidenceV1["entries"][number]; canonical: string; bytes: Buffer } {
	const canonical = fs.realpathSync(path.resolve(file)); const stat = fs.statSync(canonical);
	if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("Unsafe Pi command entry.");
	const bytes = fs.readFileSync(canonical);
	return { evidence: { role, pathDigest: canonicalSha256(canonical), contentDigest: createHash("sha256").update(bytes).digest("hex") }, canonical, bytes };
}
function piPackageRoot(script: string): string {
	let current = path.dirname(script);
	while (true) {
		const manifest = path.join(current, "package.json");
		try {
			const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: unknown };
			if (parsed.name === "@earendil-works/pi-coding-agent") return current;
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const parent = path.dirname(current); if (parent === current) throw new Error("Pi script is not package-owned."); current = parent;
	}
}
function packageEvidence(root: string, script: string): PiCommandEvidenceV1["entries"][number] {
	const evidence = packageTreeEvidence(script, root);
	return { role: "runtime-package", pathDigest: canonicalSha256(evidence.roots), contentDigest: evidence.digest };
}
function token(...values: Array<string | undefined>): string {
	const value = values.find((entry) => entry !== undefined);
	if (!value || /[\0\r\n$`\\!~*?\[\]{}();<>|&]/u.test(value)) throw new Error("Unsupported Pi wrapper token.");
	return value;
}
function addInterpreterEvidence(entries: PiCommandEvidenceV1["entries"], shebang: string, cwd: string): string {
	const parts = shebang.trim().split(/\s+/u); const interpreter = resolvePathCommand(parts[0]!, cwd);
	entries.push(measured("interpreter", interpreter).evidence);
	if (path.basename(interpreter) === "env") {
		if (parts.length !== 2) throw new Error("Unsupported env shebang.");
		const target = resolvePathCommand(parts[1]!, cwd); entries.push(measured("interpreter", target).evidence); return target;
	}
	if (parts.length !== 1) throw new Error("Unsupported interpreter arguments.");
	return interpreter;
}
function attestScriptPackage(entries: PiCommandEvidenceV1["entries"], script: string): void { entries.push(packageEvidence(piPackageRoot(script), script)); }
function isNativeExecutable(bytes: Buffer): boolean {
	return bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
		|| bytes.subarray(0, 2).equals(Buffer.from("MZ"))
		|| ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(bytes.subarray(0, 4).toString("hex"));
}
function attestShebang(entries: PiCommandEvidenceV1["entries"], executable: { canonical: string; bytes: Buffer }, cwd: string, plainScript = false): void {
	const source = executable.bytes.toString("utf8");
	if (!source.startsWith("#!")) {
		// A native standalone executable is the host-selected, fully measured command TCB.
		// Its behavior is not inferred; script wrappers instead use the closed parsing below.
		if (plainScript || isNativeExecutable(executable.bytes)) return;
		throw new Error("Unsupported Pi command wrapper.");
	}
	const newline = source.indexOf("\n"); if (newline < 0) throw new Error("Invalid Pi shebang.");
	const interpreter = addInterpreterEvidence(entries, source.slice(2, newline), cwd);
	if (!/^(?:da)?sh$/u.test(path.basename(interpreter))) { attestScriptPackage(entries, executable.canonical); return; }
	const body = source.slice(newline + 1).split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
	if (body.length !== 1) throw new Error("Unsupported shell Pi wrapper.");
	const match = /^exec\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+"\$@"$/u.exec(body[0]!);
	if (!match) throw new Error("Unsupported shell Pi wrapper.");
	const targetCommand = token(match[1], match[2], match[3]); const targetScript = token(match[4], match[5], match[6]);
	const target = measured("wrapper-target", resolvePathCommand(targetCommand, cwd)); entries.push(target.evidence); attestShebang(entries, target, cwd);
	const script = measured("script", path.isAbsolute(targetScript) ? targetScript : path.resolve(cwd, targetScript)); entries.push(script.evidence); attestScriptPackage(entries, script.canonical);
}

export function attestPiSpawnCommand(cwd = process.cwd()): PiCommandEvidenceV1 {
	const spawn = getPiSpawnCommand([]); const executable = measured("executable", resolvePathCommand(spawn.command, cwd));
	const entries: PiCommandEvidenceV1["entries"] = [executable.evidence]; attestShebang(entries, executable, cwd);
	if (spawn.args[0]) {
		const script = measured("script", path.isAbsolute(spawn.args[0]) ? spawn.args[0] : path.resolve(cwd, spawn.args[0])); entries.push(script.evidence); attestShebang(entries, script, cwd, true); attestScriptPackage(entries, script.canonical);
	}
	const deduped = entries.filter((entry, index) => entries.findIndex((candidate) => candidate.role === entry.role && candidate.pathDigest === entry.pathDigest) === index);
	return { version: 1, entries: deduped, digest: canonicalSha256({ version: 1, entries: deduped }) };
}
