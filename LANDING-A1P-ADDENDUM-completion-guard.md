# A1P addendum: completion guard для package-provided tools

Implementation review A1P выявил межмодульный инвариант: completion guard считает
неизвестный package-provided tool потенциально mutating capability, но вызов того
же tool не считается mutation attempt. После разрешения custom names это даёт
ложный completion failure. Immutable A1P brief не меняется; addendum ограничен
согласованием существующего консервативного классификатора.

## Решение

Добавить общий helper `isPotentialMutationToolCall(name,args)`:

- существующие `edit/write/bash/cursor` и иные доказанные мутации продолжают
  определяться `isMutatingTool` без изменений;
- встроенные явно read-only имена из текущего completion guard и внутренний
  `structured_output` остаются non-mutating;
- любое другое caller tool name, включая package-provided и MCP, консервативно
  считается потенциальной mutation attempt при фактическом tool call.

Использовать helper в `hasMutationToolCall` и только для
`observedMutationAttempt` foreground/background run. Long-running watchdog,
mutating-failure escalation и permission semantics сохраняют более точный
`isMutatingTool` и не меняются. Capability classification остаётся прежней, так
что capability и observed-call становятся согласованы.

## Тесты и acceptance

- custom package tool capability + его tool call не запускает completion guard;
- наличие capability без вызова по-прежнему запускает guard для implementation
  task;
- `git_read`/unknown custom call консервативно считается attempt, но read/grep и
  `structured_output` — нет;
- existing bash/cursor/checkpoint tests без изменений;
- foreground/background startup retry evidence получает
  `observedMutationAttempt:true` после custom call;
- full unit/integration и independent review без critical/high.

Не входит изменение tool permissions, denial proof, actual write classification,
watchdog, acceptance или A1 wire DTO.
