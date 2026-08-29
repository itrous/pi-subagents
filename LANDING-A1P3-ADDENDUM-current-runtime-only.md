# A1P3 addendum: current runtime only and PowerShell semantics

## Trigger

Implementation review found that a global `powershell` core set would falsely
advertise that tool on still-supported Pi 0.84.1/0.84.2, and that merely reserving
the new name does not classify its write/permission semantics. The publication
probe also became inconsistent with its documented command.

## Replacement decision

1. Active-bound execution supports exactly Pi 0.84.3 after this landing. Replace
   the old supported set rather than carrying version-dependent builtin sets.
   Pi 0.84.1/0.84.2 fail preflight with `unsupported_mode`; the onecpi installer
   follow-up likewise requires exactly 0.84.3.
2. Active-bound remains current-runtime-only, while general-mode core ownership
   must stay safe on older installed Pi. Export a pure version-to-core-set helper:
   the seven legacy names exist on 0.84.1/0.84.2 and `powershell` is added only for
   0.84.3; unknown versions conservatively get no unproved PowerShell ownership.
   Reserved, child-available and direct-MCP collision sets derive from that runtime
   set, while the active-bound preflight admits only 0.84.3.
3. Treat `powershell` as write-capable for agent memory. Conservatively classify
   every non-empty PowerShell invocation as mutating for completion/long-running
   guards; no incomplete shell-language parser may claim a command is read-only.
4. Permission configuration treats `powershell` like `bash`: user rules cannot
   override the runtime/guard policy, and its effective decision is allow at this
   layer.
5. The active-runtime publication probe directly requires Pi 0.84.3 and keeps the
   documented command `A1_PROBE_EXPECTED_COMMIT=<sha> npm run
   test:probe:active-runtime`; it must not require a second undocumented variable.
   Bundle-layout root discovery remains.
6. Update the coding-agent shim default and all positive active-bound policy
   fixtures from 0.84.2 to 0.84.3; retain old versions only in explicit negative
   or version-discovery tests. The required integration gate accepts exactly
   `0.84.3`, never skips an explicitly required unsupported patch.
7. Tests prove old-version preflight rejection, version-aware general core sets,
   exact 0.84.3 acceptance, PowerShell memory/mutation/permission behavior, and
   the real installed registry/probe gates. Re-run full typecheck, unit,
   integration and independent review.

## Non-goals

- no PowerShell command-language mutability parser;
- no compatibility mode for Pi 0.84.1/0.84.2;
- no changes outside active-bound/current-runtime support.
