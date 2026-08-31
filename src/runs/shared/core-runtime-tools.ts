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

/** Runtime/internal names that are plugin-owned regardless of the host builtin set. */
export const ACTIVE_BOUND_INTERNAL_RESERVED_TOOLS: ReadonlySet<string> = new Set([
	"subagent_wait",
	"contact_supervisor",
	"intercom",
	"structured_output",
	"cursor",
]);

export function activeBoundRuntimeReservedTools(runtimeBuiltins: Iterable<string>): ReadonlySet<string> {
	return new Set([...runtimeBuiltins, ...ACTIVE_BOUND_INTERNAL_RESERVED_TOOLS]);
}

/** Package-provided caller names must survive the comma-delimited Pi --tools wire. */

export const ACTIVE_BOUND_PACKAGE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

export function isActiveBoundPackageToolName(value: unknown): value is string {
	return typeof value === "string" && ACTIVE_BOUND_PACKAGE_TOOL_NAME.test(value);
}
