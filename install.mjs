#!/usr/bin/env node

/**
 * Exact-commit installer for the itrous/pi-subagents fork.
 *
 * Usage:
 *   npx pi-subagents --commit <40-hex-sha>
 *   npx pi-subagents --remove
 */

import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FORK_REPOSITORY_URL, installExactCommit, parseExactCommit, removeInstalledExtension } from "./install-lib.mjs";

function normalizeAgentDir(input) {
	let value = input;
	if (process.platform === "win32" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) {
		const match = value.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
		if (match) value = `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
	}
	if (value === "~") value = os.homedir();
	else if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) value = path.join(os.homedir(), value.slice(2));
	if (/^file:\/\//.test(value)) value = fileURLToPath(value);
	return path.resolve(value);
}

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ? normalizeAgentDir(process.env.PI_CODING_AGENT_DIR) : path.join(os.homedir(), ".pi", "agent");
const EXTENSION_DIR = path.join(AGENT_DIR, "extensions", "subagent");
const INSTALLER_STATE_DIR = path.join(AGENT_DIR, ".pi-subagents-installer");
const args = process.argv.slice(2);
const isRemove = args.includes("--remove") || args.includes("-r");
const isHelp = args.includes("--help") || args.includes("-h");

function commitArgument(argv) {
	if (argv.length !== 2 || (argv[0] !== "--commit" && argv[0] !== "--sha")) return undefined;
	return argv[1];
}

function printHelp() {
	console.log(`
pi-subagents fork - exact-commit Pi extension installer

Usage:
  npx pi-subagents --commit <40-hex-sha>  Install/update to an immutable fork commit
  npx pi-subagents --remove               Remove the extension
  npx pi-subagents --help                 Show this help

Repository: ${FORK_REPOSITORY_URL}
Installation directory: ${EXTENSION_DIR}

A branch, tag, abbreviated SHA, or omitted commit is intentionally rejected.
`);
}

if (isHelp) {
	printHelp();
	process.exit(0);
}

if (isRemove) {
	if (args.length !== 1) {
		console.error("--remove cannot be combined with installation arguments.");
		process.exit(1);
	}
	try {
		const removed = removeInstalledExtension({ extensionDir: EXTENSION_DIR, stateDir: INSTALLER_STATE_DIR });
		console.log(removed ? "pi-subagents removed" : "pi-subagents is not installed");
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error)); process.exit(1);
	}
	process.exit(0);
}

const commitValue = commitArgument(args);
if (args.length !== 2 || commitValue === undefined) {
	console.error("Unknown or malformed installer arguments.");
	printHelp();
	process.exit(1);
}

try {
	const commit = parseExactCommit(commitValue);
	console.log(`Installing pi-subagents fork at ${commit}...\n`);
	installExactCommit({ extensionDir: EXTENSION_DIR, stateDir: INSTALLER_STATE_DIR, commit });
	console.log(`
pi-subagents installed at detached commit ${commit}.

The extension is available to new Pi sessions. Tools added:
  • subagent - Delegate tasks to agents and inspect run status
  • subagent_wait - Wait for owned background or detached foreground results

Documentation: ${EXTENSION_DIR}/FORK.md
`);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
