/** Pi builtins shared by legacy and current runtimes. */
export const CORE_RUNTIME_OWNED_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"edit",
	"write",
]);

/** Exact active-bound builtin registry for the only admitted runtime, Pi 0.84.3. */
export const ACTIVE_BOUND_CORE_RUNTIME_OWNED_TOOLS: ReadonlySet<string> = new Set([
	...CORE_RUNTIME_OWNED_TOOLS,
	"powershell",
]);

/** Package-provided caller names must survive the comma-delimited Pi --tools wire. */
/** Runtime/internal names that package factories must never replace. */
export const ACTIVE_BOUND_RUNTIME_RESERVED_TOOLS: ReadonlySet<string> = new Set([
	...ACTIVE_BOUND_CORE_RUNTIME_OWNED_TOOLS,
	"subagent_wait",
	"contact_supervisor",
	"intercom",
	"structured_output",
	"cursor",
]);

export const ACTIVE_BOUND_PACKAGE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

export function isActiveBoundPackageToolName(value: unknown): value is string {
	return typeof value === "string" && ACTIVE_BOUND_PACKAGE_TOOL_NAME.test(value);
}
