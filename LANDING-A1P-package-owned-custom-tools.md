# Landing A1P: active-bound package-owned custom tools

## Основание

Landing E reviewer onecpi требует native basic lens с `git_read` и adjudicator с
`review_read`. Pinned A1 landing поддерживает attested package factories и pre-turn
exact registry proof, но `active-bound-resolver.ts` дополнительно отклоняет любое
имя agent tool вне `FIXED_CHILD_TOOLS`. Поэтому уже attested package extension не
может объявить свой caller tool. Исправление выполняется в owner fork
`itrous/pi-subagents`, не обходом onecpi. База — fork `origin/main` merge
`28307bc19fa39dc106ca22f8851b97b388f00d01`; исходный проверенный A1 implementation
SHA `9cbdccfe0d63f6227fbe4aa280713212ea0282a5`. Master-plan onecpi sha256:
`ed09dee29891548d6ce367eaf7ada0ceeb7427ef115ee03017ffeb415a772048`.
После plan gate этот brief неизменяем; изменение контракта требует addendum и
повторного plan review.

## Цель

Разрешить active-bound package agent объявлять caller tool с произвольным
валидным именем только тогда, когда agent имеет хотя бы один успешно attested
package-owned `subagentOnlyExtensions` factory. До первого model turn runtime
обязан загрузить factory через существующий package mediator, заменить
placeholder, exact-сверить final provider/active registry и вернуть тот же proof в
terminal. Это generic A1 capability, без знаний имён `git_read`/`review_read`.

## Не входит

- Изменение ordinary/project agents, ambient extensions или model-facing
  delegation API.
- Request-time path/ref/tool grant, загрузка extension вне package owner closure.
- Ослабление package tree evidence, package resolution guard, restricted
  ExtensionAPI, source identity, launch digest, cancellation или denial proof.
- Изменение MCP selectors/package refs, fixed builtin semantics, permission
  policy, default runtime installation или pin onecpi.
- Push/merge/release без отдельного разрешения пользователя.

## Resolver policy

Разделить имена на core runtime-owned builtins
`read/grep/find/ls/bash/edit/write` и package-provided names. Исторические
`web_search/fetch_content/get_search_content` остаются допустимыми agent tool
names, но не считаются core: как и новый custom name, они требуют attested package
factory. Package-provided names допустимы
только если одновременно:

1. agent source — `package` (уже требуется active-bound mode);
2. package extension projection непуст и каждый entry прошёл существующий
   `resolveActiveBoundPackageExtensions`/owner-tree attestation;
3. имя входит в wire-safe subset `/^[A-Za-z][A-Za-z0-9_-]{0,63}$/`: запятые,
   whitespace, Unicode/control/NUL и CSV-разделители запрещены до spawn, поэтому
   существующий `--tools` comma-join однозначен; sorted unique projection остаётся
   representable;
4. имя не является `structured_output`, `subagent`, `mcp:*`, slash/path/script
   selector или runtime-owned tool;
5. explicit allowlist, `requiredChildTools` и tool-registry expected projection
   включают custom имя дословно.

Custom name без attested package factory даёт pre-start `unsupported_mode`.
Дубли, malformed/oversized names и collision с builtin/internal также дают
pre-start отказ. Request не может добавить имя: источник — только attested agent
definition, его digest входит в launch contract.

## Runtime invariants

Существующий bound runtime остаётся авторитетным:

- ambient extensions выключены;
- до factory load для каждого required non-runtime tool есть placeholder;
- package mediator загружает только attested bytes из owner closure и factory
  обязан зарегистрировать exact name, заменив placeholder;
- missing factory/name, duplicate owner, extra callable name, package mutation,
  bytes drift или registry mismatch завершаются до provider request именованным
  protocol/mismatch terminal;
- `before_provider_request` сравнивает provider payload, active registry и
  expected sorted projection exact equality;
- terminal proof и denied-tool proof остаются обязательными;
- custom tool execute получает restricted context и не расширяет registry после
  barrier.

Preflight `packageExtensions`, runtime extension evidence, expected registry
projection and launch digest должны меняться при изменении factory bytes/path,
agent tool list или owner package tree.

## Реализация

1. Вынести единый exported core runtime-owned set из семи Pi builtins для
   resolver, placeholder loader и package collision ownership. Исторические
   web-tools намеренно в него не входят и regression test фиксирует, что без
   attested package factory они получают pre-start отказ, а с factory проходят
   тот же exact package-provided путь.
2. Добавить bounded wire-safe validation package custom names рядом с resolver
   policy; убрать только blanket `!FIXED_CHILD_TOOLS` отказ.
3. После resolution package extensions fail-closed проверить custom set и наличие
   attested factory projection; передать полный agent tool list в существующий
   `resolvePiLaunchToolPlan`.
4. Не добавлять special-case tool names и не менять wire DTO versions.
5. Расширить unit tests resolver/tool plan/runtime package mediator, включая
   comma/Unicode/whitespace/oversize names, collisions со всеми core tools и
   web-tool positive/negative controls.
6. Добавить packed owner-package probe: agent с одним custom read-only tool и
   factory, exact preflight projection, real foreground child/provider request,
   terminal proof; мутанты missing factory, wrong registered name, extra name,
   duplicate/collision/malformed/oversized tool дают zero provider request или
   pre-start refusal согласно фазе.
7. Проверить legacy package agents/fixed tools и full upstream suite.

## Cancellation и compatibility

Accepted custom-tool leaf использует прежние exact request/owner/node binding,
first-wins cancel и bounded terminal cleanup. Старые consumers и package agents
только с fixed tools получают byte-identical policy/projection. Project/user
agents, external runners, ambient extensions и legacy unbound delegation не
получают новую возможность.

## Acceptance

- preflight package agent `tools:[read,…,custom]` + attested owner factory успешен;
- projection `required/effectiveCallerTools` содержит custom exact один раз,
  internal tools отдельно; digest independently воспроизводим;
- real child видит custom tool, может вызвать его, provider request count bounded,
  terminal registry/denial proof exact;
- missing/wrong/extra factory tool блокируется до первого provider request;
- custom name без package extension, comma/Unicode/whitespace/oversize,
  malformed/duplicate/collision запрещён до spawn/preflight;
- resolver, placeholder loader и package ownership используют один exact
  seven-name core set; web tool без factory отклоняется до spawn, а attested
  web/custom factory заменяет placeholder и проходит exact registry;
- package byte/tool-list mutation меняет contract digest или fail-closed;
- core-fixed-only active-bound и legacy suites без regressions; historical web
  names have explicit package-factory compatibility tests;
- full tests, packed probe и independent implementation review без critical/high;
- новый immutable commit становится candidate pin только после этих gate.

## Stop conditions

Не продолжать Landing E onecpi, если custom tool можно получить без attested
package owner/factory, extra registry доходит до provider, placeholder survives,
proof не exact, package execute получает unrestricted host mutation surface,
accepted failure допускает duplicate fallback или full fork suite не проходит.
