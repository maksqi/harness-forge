# Phase 11 — v1.7: Hooks, project MCP and output styles

Part of the harness-forge build plan. Progress is tracked in `docs/ROADMAP.md` (coordinator only). Shared names come
from `docs/DECISIONS.md` (ADR-048 … ADR-052, the amendment notes on ADR-008, ADR-017, ADR-024, ADR-031, ADR-033,
ADR-034, ADR-040 and ADR-042 … ADR-046, and the Phase 11 contract seed; it wins on conflict); endpoints and DTOs from
`docs/API.md` (the new schema sections 4.31 (hooks, the `data-hook` part) and 4.32 (project trust and project MCP),
the route sections 5.31 – 5.33 for the modules `hooks`, `projectTrust` and `projectMcp`, the stream section 6.11 for
`data-hook`, the hook carrier message, the run origin `hook`, the activity kind `hooks`,
`metadata.command.kind` / `.inlined`, the request field `outputStyle`, the 409 reasons `hook-blocked` / `untrusted` and
the three notices, the events `hooks.changed` / `project-trust.changed` / `project-mcp.changed`, the two settings and
the 120-route key index; C34 fixes the final numbers); components, props, store and module signatures, shortcuts and
test ids from `docs/UI.md` (the 2.18 wireframes, 5.6 the main header (trust chip), 7.8 the Skills group of the slash
menu, 7.28 commands and skills (`!` / `@`, skill invocations), the new 7.31 hooks in the chat, 7.32 output styles in the
composer, 7.33 project trust and project MCP, 8.4 the trust warning (hook commands), 8.8 the plugin overview (hooks and
output styles), 9.4 General (Output style), 9.10 Projects (row menu), 9.13 Customize: Output styles and Hooks, 10.8
contracts, 11.8 modules, 12 shortcuts, 13.12 test ids, 14 accessibility, 15 copy); flows, tables and security rules
from `docs/ARCHITECTURE.md` (the stop order, backups, the new flow sections for hooks, project trust, project MCP,
output styles and command extras (6.28 – 6.32), `0008`, the Phase 11 security section (10.12), the log rules);
plugin API 1.5.0 (`contributes.hooks`, `contributes.outputStyles`, `ctx.outputStyles.register`, the new code hook
events) from `docs/PLUGINS.md`; the mock model `mock:hooks` from `docs/PROVIDERS.md` (8, "Hook mocks (Phase 11)":
the probe contract); the user guides `docs/guides/hooks-and-project-mcp.md` and `docs/guides/output-styles.md`. The new
UI.md, ARCHITECTURE.md, PLUGINS.md and PROVIDERS.md sections and the guides are written by D15 in P11-0a, API.md by
C34. W11.14 reconciles every doc with the code in P11-B.

**Status (2026-10-06): done.** v1.7 is complete (final gate commit `chore: final gate for harness-forge v1.7`). P11-00:
`4765743` (vue-tsc workaround), Dependabot #8 `fe6dbeb` and #7 `b636a1a`, `60389e0` (source-map-js override, four
devtools-only simple-git advisories ignored); P11-0a `d1f7836` (10912 tests); P11-0b `9f169a1` (11212 tests, v1.6
upgrade probe 57/57, seam probe 37/37); P11-A `3cff82d` (11760 tests, probes 356/356 after W11.15 / W11.16, P10-A /
P9-A / P8-A green, e2e 156); P11-B: W11.13 (25 new e2e tests), W11.14 (docs), W11.17 – W11.19 (fix-ups) and the final
gate (11787 tests, probes 345/345, e2e 191 ×3, Docker 49/49). "Deviations found while building" holds what each wave
changed; "Outcome" the gate results.

Paths: `S` = `apps/server/src`, `W` = `apps/web/app`, `SH` = `packages/shared/src`, `SDK` = `packages/plugin-sdk/src`.
File:line references point at `main` = `45e974c` (they drift as the waves land; search for the named symbol).

## Goal

Ship v1.7: Hooks, project MCP and output styles (Claude Code parity, continued), plus command extras and plugin API
1.5.0.

- **Hooks** (ADR-048, amends ADR-033, ADR-040, ADR-042, ADR-043 and ADR-046): user-configured shell commands run at
  eight points of the agent's work (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Notification`, `Stop`,
  `SubagentStop`, `PreCompact`, `SessionStart`) in Claude Code's `hooks` format (`{ <Event>: [{ matcher?, hooks: [{
  type: 'command', command, timeout? }] }] }`), from three additive sources: personal hooks (table `hooks`, Settings →
  Customize → Hooks), the `hooks` key of a project's `.harness/settings{,.local}.json` and
  `.claude/settings{,.local}.json` (only after approval) and plugins. A hook gets a JSON payload on stdin (Claude Code
  fields + a `harness` object); exit 0 continues (a JSON stdout may decide), exit 2 blocks with stderr as the reason,
  any other exit is a non-blocking error. Hook output is a persisted `data-hook` part; a blocking `Stop` hook makes the
  server start a follow-up turn (`run.started.origin = hook`, at most 5 in a row). Hooks run only through the
  workspace shell runner.
- **Project trust** (ADR-049, amends ADR-017 and ADR-044): every executable item of a project folder (a project hook,
  a `.mcp.json` server incl. http / sse, a command file with `` !`cmd` `` spans) runs only when the sha256 of
  `trustHashInput(item)` (the canonical item **and** the script files its command names) is approved for that project
  (table `project_trust`, fresh auth); the hash is re-checked right before every spawn and any change makes the item
  pending again. The review dialog shows the exact commands, URLs and environment / header / variable names.
- **Project MCP servers** (ADR-050, amends ADR-024, ADR-031 and ADR-034): a project's `.mcp.json` adds MCP servers to
  that project's chats only; they connect lazily after approval, take `${VAR}` / `${VAR:-default}` values only from
  encrypted per-project variables (never from the server environment), shadow a global server with the same id in those
  chats and stop when idle, revoked, changed, deleted or at shutdown. Every stdio MCP server now runs in its own process
  group.
- **Output styles** (ADR-051, amends ADR-043 and ADR-044): a fourth catalog kind `style` (builtins `default`,
  `explanatory`, `learning`; personal rows; `.harness/output-styles` over `.claude/output-styles`; plugin
  contributions); the effective style is the chat's choice, else the project's, else the global setting `outputStyle`;
  its block goes first in the main agent's instructions (never in sub-agents'); `keep-coding-instructions: false` drops
  the workspace tool rules and the todo / task hints; picked in the composer (`OutputStyleMenu`) or with the client
  command `/output-style`.
- **Command extras and user-invocable skills** (ADR-052, amends ADR-008, ADR-017, ADR-044 and ADR-045): `` !`cmd` ``
  spans of a trusted command file run in the project folder before the model call and their output replaces them;
  `@path` inlines a project file; the result is frozen in the stored expansion. Skills with `user-invocable` (default
  true) run from the slash menu as `/name [arguments]` (a Skills group); `disable-model-invocation` keeps a skill away
  from the model.
- **Plugin API 1.5.0** (additive): `contributes.hooks` (needs a trust pin like a stdio MCP declaration; so does a `!`
  span in a command template), `contributes.outputStyles`, `ctx.outputStyles.register` (`OutputStyleDefinition`), the
  code hook events `prompt.submit`, `session.start`, `run.stop`, `subagent.stop`, `compact.before`, `notification`,
  `tool.after` output `context?`; registry `styles`, `hookCommands`; the example plugin `examples/plugins/hook-pack`.

Out of scope (ROADMAP backlog): importing definitions or settings from the home folder (`~/.claude`), editing project
definition and settings files in the UI, `prompt`-type hooks (Claude Code's model-evaluated hooks: listed as
`unsupported-type`), `transcript_path` in the hook payload, SessionStart sources `resume` / `clear`, a stored copy of
the approved text ("Previously approved" view), an SSRF block for project MCP URLs (a review warning instead), hook
timeouts above 600 s, nested sub-agents (depth stays 1) and everything else in the backlog. Kept as documented
behavior: a hook `allow` is narrower than Claude Code (it never skips the card for an `execute` tool or an `always`
policy); plugin scripts are unpinned (the declarative trust hash covers `plugin.json` only, as for code plugins); a
command that runs repository code (`npm test` and the like) runs whatever the repository holds at that moment (the
`runs-repository-code` warning); `!` span output is not journaled (like a command the user types in a terminal); tool
preferences apply by name, also to a shadowing project server; a hook context injected just before an automatic
compaction is summarized, not replayed.

Totals after Phase 11: routes 109 → **120** (`hooks.list` `GET /hooks?projectId`, `hooks.runs` `GET /hooks/runs`,
`hooks.create` `POST /hooks` (201, fresh), `hooks.update` `PATCH /hooks/:id` (fresh unless it only turns the hook
off), `hooks.remove` `DELETE /hooks/:id` (204), `projectTrust.list` `GET /projects/:id/trust`, `projectTrust.approve`
`POST /projects/:id/trust` (fresh), `projectTrust.revoke` `DELETE /projects/:id/trust/:sha256`, `projectMcp.list`
`GET /projects/:id/mcp`, `projectMcp.setVariables` `PUT /projects/:id/mcp/variables` (fresh),
`projectMcp.reconnect` `POST /projects/:id/mcp/:serverId/reconnect`), route modules 30 → **33** (`hooks` 5,
`projectTrust` 3, `projectMcp` 3; files `hooks.ts`, `project-trust.ts`, `project-mcp.ts`), tables 20 → **22**
(`hooks`, `project_trust`), migration **`0008_hooks_trust`** (2 CREATE TABLE + 1 `ALTER TABLE projects ADD
output_style`, nothing else), SSE types 15 → **18** (`hooks.changed`, `project-trust.changed`, `project-mcp.changed`),
settings keys 28 → **30** (`outputStyle`, `hooksEnabled`), notice codes 8 → **11** (`output-style-unavailable`,
`hook-continuation-limit`, `project-mcp-unavailable`), conflict reasons 12 → **14** (`hook-blocked`, `untrusted`),
error codes **16** (unchanged), UI data part types 5 → **6** (`hook`), run origins + **`hook`**, `data-activity`
kind + **`hooks`**, catalog kinds 3 → **4** (`style`), client commands + **`output-style`**, plugin API **1.5.0**
(additive), id prefixes **`hok_`** (personal hooks), **`hev_`** (hook records), mock models 16 → **17**
(**`mock:hooks`**), **~75** new test ids (UI.md 13.12), ADR-048 … ADR-052, **no new dependency and no new environment
variable**. Agents: 4 (P11-0a: C34, C35, D14, D15; plus the seed agent K3S) + 4 (P11-0b: C36, C37, C38, C39) + 12
(P11-A: W11.1 – W11.12; plus the gate-probe agent G11P) + 2 (P11-B: W11.13, W11.14; W11.15 / W11.16 only for red P11-A
gate items) = 24 (26 with the fix-ups), in the Phase 5 wave method (ADR-016).

## Entry criteria

- v1.6 is on `main` and pushed (`origin/main` = `45e974c`, `chore: final gate for harness-forge v1.6`; CI run
  `37230817339` and the scheduled Audit run are green): `pnpm check` (10562 tests), `pnpm build` and e2e 156 passed ×3
  (`chromium` + `mobile` + `tablet`).
- The vue-tsc workaround `4765743` is pushed; Dependabot #8 and #7 are merged (or explicitly deferred by the user) and
  `main` is green again with `pnpm why typescript` showing 6.0.x only.
- The approved plan and the design inputs exist in `.tmp/p11-designs/` (`plan.md`, `server.md`, `web.md`, `process.md`,
  `explore-{pipeline,mcp,catalog}.md`, `agent-rules.md`; the reconciliation in `plan.md` and `README.md` is binding and
  wins over the reports).
- K1 is done: DECISIONS.md carries ADR-048 … ADR-052, the amendment notes and the Phase 11 contract seed (ids `hok_` /
  `hev_`, the Phase 11 names, the secret scope `project:<projectId>`, enumerations, the HTTP module rows `hooks.ts` /
  `project-trust.ts` / `project-mcp.ts` that `routes.test.ts` reads, the events, the chat request note, the data part
  `hook`, the notices, the settings, the tables and `0008`, `<dataDir>/hooks`, the mock model, the example plugin
  `hook-pack`, the backup contents, the Customize tab values); ROADMAP.md has the Phase 11 section and the updated
  backlog; AGENT.md has the "Plugin API 1.5.0" and "Hooks, trust and project MCP" facts, the repository-root rule, the
  vue-tsc fact, the `HF_WORKSPACE_SHELL` note and the Phase 11 freeze line.
- K2 is done: no new dependency (`node:crypto` for sha256, `JSON.parse` after byte caps, the existing `yaml` 2 for
  style frontmatter, `@ai-sdk/mcp` + the existing stdio transport, a hand-written matcher; MCP fixtures use the root dev
  dependency `@modelcontextprotocol/sdk` plus a new dependency-free stdio fixture).
- The contract skeletons exist: `SH/util/{hooks,trust,mcp-config,command-template,output-styles}.ts` (final names and
  signatures, bodies throw until C35 implements them) and their exports in `SH/index.ts`.

## Exit criteria

- Every Phase 11 item in `docs/ROADMAP.md` is checked; every wave gate is green; the final checkpoint commit
  `chore: final gate for harness-forge v1.7` exists (pushed only when the user asks).
- `pnpm check` and `pnpm build` are green; the built-page CSP test passes with `HF_TEST_REQUIRE_WEB_BUILD=1`.
- `pnpm test:e2e` (projects `chromium` + `mobile` + `tablet`, OS color scheme emulated as light) is green 3× in a row,
  including the new specs `core/hooks`, `core/hook-import`, `core/hook-prompts`, `core/hook-continuation`,
  `core/project-trust`, `core/project-mcp`, `core/output-styles`, `core/command-shell`, the extended `core/skills`,
  `plugins/plugin-hooks`, `mobile/hooks` and the extended `share`, `keyboard`, `data`, `customize`, `mobile/agent` and
  tablet touch-target specs (about 185 tests; the 30-minute CI e2e budget holds); the `@screenshots` run (dark + light)
  was reviewed; the README images come from the `@readme` full-frame shots.
- The gate probes (Gate P11-A, repeated at the final gate on a fresh `.tmp/e2e`) and the regressions (the coordinator's
  P10-A copy `.tmp/gates/P11-A/p10a-regression.mjs` with the migration pin `≥ 8`, `node .tmp/gates/P9-A/probe.mjs`,
  `node .tmp/gates/P8-A/probe.mjs ws git`) are green.
- CI on `main` is green (`check`, `e2e`, `docker`, `audit`, `actionlint`); Dependabot #7 / #8 resolved (or deferred by
  the user); the advisory decision is recorded.
- **Upgrade**: a v1.6 data directory (seeded by the `.tmp/v16` build) boots on v1.7 with every chat, secret, share,
  project, rule, personal definition and background task intact: `0008` applied (two empty tables, `output_style` null
  everywhere), `integrity_check` / `foreign_key_check` clean, the stored `data-task-result` parts and the `/status`
  expansion byte-identical, pending approvals still pending; **nothing executes before approval** (no hook sentinel, no
  `.mcp-started-*` file, no `.hook-log/`); approving each kind (hook, MCP server, command spans) makes it work; the v1.6
  `/status` expansion is reused on regenerate (no `!` execution); the seeded styles and skills are discovered with the
  right precedence.
- **Docker** (Node 24 alpine, uid 1000; daemon permitting, else the CI `docker` job) on a copy of that seed: a
  `.harness/settings.json` hook (`sh .harness/hooks/mark.sh`, busybox `sh`, no `jq`) writes `id -u` = 1000 only after a
  fresh login and approval; a `.mcp.json` stdio server (the dependency-free fixture) has no process before approval,
  its tool is offered in the project chat after it, and the process is gone after revoke; `docker stop` leaves no
  orphan; a restart with `HF_SAFE_MODE=1` runs no hooks.
- `pnpm test` never calls a paid API, never touches the repository's `data/` or a folder outside a temp directory,
  leaves `git status --porcelain` of the repository unchanged, creates no `.claude/`, `.harness/` or `.mcp.json` at the
  repository root, leaves no fixture process behind and uses loopback only; `pnpm test:live` stays the user's.
- README status reads "v1.7".

Manual acceptance (coordinator, `HF_MOCK_PROVIDER=1 pnpm dev`):

- A personal PreToolUse hook (created after the password prompt) blocks a write; the tool row reads "Blocked by hook"
  and the reason shows.
- A project with `.claude/settings.json` shows "N to review" in the chat header; nothing runs before approval; editing
  the settings file **or the script it names** makes the item pending again.
- `.mcp.json` variables → the server connects in that project's chats only; revoke stops it.
- `/output-style learning`; the project default and the global default; the Customize Output styles tab.
- `/status` inlines `git status` and `@README.md`.
- `/deploy prod` from the Skills group of the slash menu.
- A Stop hook continues the agent, then the cap of 5 holds.
- The `hook-pack` trust consent lists its hook commands.
- 390 px: the trust dialog, the hook editor and the composer refusal fit.
- `HF_SAFE_MODE=1` and `HF_WORKSPACE_SHELL=0` explain on the Hooks tab why hooks don't run.
- A v1.6 data directory boots on v1.7 intact with nothing executed before approval; Docker runs hooks as uid 1000.

With real keys (the user, optional): a real Claude Code `settings.json` + `.mcp.json` on a real project.

## Steps

| Step | Owner | Output |
|---|---|---|
| P11-00 | coordinator | design reports → `.tmp/p11-designs` (+ README reconciliation, `agent-rules.md`); baseline `pnpm check` 10562 + `git status --porcelain` before / after; vue-tsc fix `4765743` + push; Dependabot #8 / #7 merged; advisory re-check; `.tmp/v16` worktree installed and built; old `.tmp` content archived; memory |
| P11-0a | coordinator (K1, K2, contract skeletons, K3-seed by K3S) + C34, C35, D14, D15 | decisions, ROADMAP, AGENT.md; every shared contract + plugin SDK 1.5.0 + 501 stubs + API.md; the shared helpers (complete); this file; every other doc; the v1.6 upgrade seed |
| Gate P11-0a | coordinator | audit, frozen install (`pnpm why typescript\|yaml\|@modelcontextprotocol/sdk`), check, build (web entry size vs `.tmp/v16`), CSP test, `pluginApiVersion` 1.5.0, 11 new routes mounted, e2e 156, `pnpm audit`, examples' `.d.ts`, commit |
| P11-0b | coordinator (K3) + C36, C37, C38, C39 | schema + migration `0008`, server skeleton, chat seams (complete), processes + mock + fixtures (complete), web skeleton, FREEZE |
| Gate P11-0b | coordinator | audit, `0008` inspection, `nuxi prepare`, check, build, CSP test, e2e 156 on a fresh `.tmp/e2e`, v1.6 upgrade probe, seam no-op probe, FREEZE, commit |
| P11-A | W11.1 – W11.12 + G11P (one launch) | features + gate probes |
| Gate P11-A | coordinator | CCR batch, `nuxi prepare`, check, build, CSP, G11P probes + P10-A copy, P9-A, P8-A regressions, e2e, screenshots, audit, commit |
| P11-B | W11.13, W11.14 (+ W11.15 / W11.16 when the P11-A gate is red) | feature e2e, docs reconciliation |
| Final gate | coordinator | e2e ×3, v1.6 → v1.7 upgrade, Docker, audit, hermetic `pnpm test`, ROADMAP, memory, commit |

## Deviations from the plan (binding)

The binding changes found while building are listed per wave in "Deviations found while building" below. The
coordinator records here every binding change to the plan sections below, with the gate that decided it; the agents
build against the plan sections of this file plus this list.

Binding order of the design inputs: `.tmp/p11-designs/plan.md` (its "Reconciliation" table and "Totals") >
`docs/DECISIONS.md` (after K1) > this file (after D14) > the design reports (`server.md`, `web.md`, `process.md`,
`explore-{pipeline,mcp,catalog}.md`). The reports are superseded where the plan and `.tmp/p11-designs/README.md`
disagree with them. The replaced report items, for agents who read the reports for depth (the list of `README.md`,
refined):

- **All reports — the ADRs**: five ADRs: ADR-048 shell hooks (incl. their effects in runs, Stop turns and the origin
  `hook`), ADR-049 project trust, ADR-050 project `.mcp.json` servers, ADR-051 output styles, ADR-052 command `!` /
  `@`, user-invocable skills and plugin API 1.5.0. There is no ADR-053 (process.md's split into six is superseded).
- **server.md**:
  - `trustHashInput`, `canonicalJson` and `extractCommandFileRefs` live in `SH/util/trust.ts` (not `hooks.ts`).
  - The approve body is a batch: `POST /projects/:id/trust { items: [{ kind, sha256 }] ≤ 50 }` (fresh auth; 409
    `stale` if any hash is not current, nothing written); revoke stays `DELETE /projects/:id/trust/:sha256`.
  - `PUT /projects/:id/mcp/variables` **is fresh** (a variable can change what an approved stdio server runs).
  - `PATCH /hooks/:id` is fresh unless the body only turns the hook off; create fresh; delete not fresh.
  - UserPromptSubmit runs **at submit**: in `prepareRun` for `POST /chat` new turns and synchronously at enqueue for
    `POST /chat/:id/queue` (a block → 409 `hook-blocked`; a context is kept with the queued item and attached when it
    is delivered: as a `data-hook` on the queued turn's user message, or injected with the steer). The "steered items
    run it in the steer piece" variant of server.md D2 is superseded.
  - `S/workspace/shell.ts` (`input`, `env`) and `S/mcp/stdio-transport.ts` (process group) belong to **C38** (not
    C36); the stdio process group applies to every stdio server.
  - The skeleton signatures win over server.md's sketches: `planCommandExpansion(body)` (no input; the arguments are
    applied by `renderCommandExpansion(plan, results, input)` on the text parts only) and `hookTargetNames(tool, {
    mcpServerName? })`.
  - server.md's P11-A split ("W11.4 owns `S/mcp/{project*,stdio-transport*}`", "W11.5 commands", "W11.6 styles",
    first cuts) is replaced by the plan's split (below).
- **web.md**:
  - The `data-hook` shape is the server's: `{ id: hev_…, event, outcome, toolCallId?, toolName?, createdAt, hooks:
    [{ source, label, pluginId?, exitCode, timedOut?, durationMs, error?, systemMessage? }] ≤ 20, context?, reason?,
    updatedInput? }`; the outcome enum is `context | denied | asked | allowed | rewritten | blocked | continued |
    stopped | error` (no `input-changed` → `rewritten`, no `feedback` → `blocked`, no `message` →
    `hooks[].systemMessage`, no `capped` → the notice `hook-continuation-limit`; no `originalInput`, `stderr`, `command`
    fields: the tool part keeps the model's input, the hook part carries `updatedInput`).
  - SSE names `hooks.changed`, `project-trust.changed` (not `trust.changed`), `project-mcp.changed` (`{ projectId,
    servers }`, not an upsert of one server); the activity kind is `hooks` (not `hook`), so `activity` widens to
    `'compacting' | 'hooks' | null`.
  - Routes per the plan: no `GET /hooks/:id`; `GET /hooks/runs`; project MCP variables per project (`PUT
    /projects/:id/mcp/variables`), not per server; the project MCP DTOs are server.md's (`{ id, name, transport, state,
    sha256, error?, tools, shadows?, missingVariables }`, list `{ items, variables: [{ name, set, hint, usedBy }] }`);
    the hook list carries `switches: { setting, shell, safeMode }` (not `disabledBy`); hook sources are `personal |
    project | plugin` (not `user`); the hook timeout field is the server's (seconds, `1 – 600`).
  - Trust items are keyed by `sha256` (not `key` / `hash`); there is no `approvedAt` / `approvedText` (the "Previously
    approved" view is cut); there is no `ProjectSummary.trustPending` (pending counts are fetched lazily;
    `project-trust.changed` carries `pending`).
  - No notices `trust-pending` / `command-shell-skipped`: commands refuse with 409 `untrusted`, prompts with 409
    `hook-blocked` (conflict reasons); the three new notices are `output-style-unavailable`, `hook-continuation-limit`,
    `project-mcp-unavailable`. No `CommandSummary.trust`, no `commandInvocationSchema.type: 'skill'` /
    `.shell` / `.files`: the invocation gains `kind` (`command | skill`) and `inlined: { shell: count, files: paths }`.
  - The chat's style lives in `chats.settings.outputStyle` (no column); only `mock:hooks` exists (its `style?` trigger
    replaces `mock:style` / `mock:styles`).
  - The web agents a – e are W11.8 – W11.12.
- **process.md**:
  - The SH helper files are `SH/util/{hooks,trust,mcp-config,command-template,output-styles}.ts` with the coordinator's
    names (not `command-inline.ts`, not `parseHooksConfig` / `matchHook` / `toServerId` / `findBangSpans` …).
  - Migration `0008_hooks_trust` = 2 CREATE TABLE + 1 `ALTER TABLE projects ADD output_style` (no `chats.output_style`,
    no index); generated with `pnpm db:generate --name hooks_trust`.
  - Services `S/services/{hooks,project-config,project-trust}/`, project MCP in `S/mcp/project*.ts` with the interface
    in `S/mcp/types.ts` (not `S/services/trust`, not `S/mcp/project/**`, no `TrustItemSource` registry).
  - One mock model `mock:hooks` (no `mock:styles`); 17 mocks.
  - The P11-A split, the hot-file owners and the first cuts are the plan's (server agents from server.md D, web agents
    from web.md B – F); process.md's W11.5 "styles-server", W11.6 "commands-skills-server", W11.11
    "session-transcript-web" and W11.12 "settings-plugins-web" are superseded.
  - The open point "personal hooks in backups" is decided: never in backups (ADR-048); personal output styles travel in
    `customizations.json`; personal commands with `!` spans are restored turned off.

Plan-level decisions (from the reports, kept by the plan):

- **Claude Code format, safe subset**: only the `hooks` key of the settings files is read (`permissions`, `env` and
  every other key are ignored); `prompt` hooks are `unsupported-type`; the matcher is a hand-written safe subset
  (`|` alternatives of `[A-Za-z0-9_.\- *]`, `*` / `.*` wildcards, full match, case-sensitive; `^ $ [ ( + ? \ {` →
  `invalid-matcher`, never runs) matched against the harness name, the Claude Code aliases (`CLAUDE_TOOL_ALIASES`
  reversed) and `mcp__<claudeName>__<tool>`; no `RegExp` is ever built from input.
- **Verify-before-run**: the trust hash covers the canonical item and up to 8 referenced script files (≤ 1 MiB each)
  and is recomputed right before every spawn; a mismatch skips the item as pending. Hashing only the item text was
  rejected (a hook `"$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh` would keep its hash while the script changes).
- **PreToolUse in `createToolApproval`**, once per tool call: skipped for answered toolCallIds (the SDK re-runs the
  approval function on approved continuations) and replayed from the stored part; `updatedInput` is applied in
  `prepareInput` (before `tool.before`, then the schema re-validation, fail closed). `experimental_refineToolInput` was
  rejected (no toolCallId, runs in the stream parser, must re-derive the same output on continuation, and the approval
  HMAC signs the original input).
- **Stop needs a gate before `finish`** (`prepareStep` never runs after a text-only step): `hookGate` holds `finish`,
  and a block becomes a server-started follow-up turn (origin `hook`) from a user-role carrier message holding only
  `data-hook` parts (the same pattern as the Phase 10 `task` carrier).
- **One history stage `splitHooks`** after `splitTaskResults` (compaction → steer split → task-result split → hook
  split → task output reduction → command expansions); model text only through `hookModelText`
  (`<hook-context …>` / `<hook-feedback event="Stop">`).
- **Project MCP variables never come from `process.env`** (that would leak `HF_*` and provider keys): encrypted per
  project (secret scope `project:<projectId>`, names `mcp.var.<NAME>`).
- **No SSRF block for project MCP URLs** (local development servers are the main use case): http / sse need approval
  and show a `private-network` warning; redirects are refused.
- **The chat's style is never pinned**: `pinChoices` keeps "Automatic" automatic; the inherit option is named
  "Automatic" (the builtin is named "Default").
- **Docs** are written by D15 and C34 (API.md) in P11-0a and reconciled by W11.14 in P11-B; P11-A agents never edit
  docs. **Feature e2e specs** are written in P11-B by W11.13. **Every new web test id** is added by C39 in P11-0b,
  copied verbatim from UI.md 13.12; `W/utils/testids.ts` is frozen during P11-A.

Open points decided by D14 while writing this file (confirmed by the coordinator at Gate P11-0a):

1. **The two enum entries** (`'style'` in `CUSTOMIZATION_KINDS`, `'output-style'` in `CLIENT_COMMANDS`): decided by the
   coordinator — C35 added `style` (`SH/util/definitions.ts`) with the compile fixes it forced (the customization
   service and the web Customize maps), C34 added `output-style` (`SH/ids.ts`) with its compile fixes
   (`CLIENT_COMMAND_DESCRIPTIONS`, a "not available yet" toast until W11.10); Gate P11-0a compiles.
2. **Conditional fresh auth of `hooks.update`** is enforced by the server only (like `mcp.update` with stdio): the route
   table marks `fresh: true` on `hooks.create`, `projectTrust.approve` and `projectMcp.setVariables`; `hooks.update`
   has no flag and its handler requires fresh auth unless the body is exactly `{ enabled: false }`. The route-driven
   security tests learn the exception.
3. **C36 owns the project MCP stub and the new registries in P11-0b**: `S/mcp/types.ts` (`ProjectMcpManager`) plus the
   stub `S/mcp/project.ts` (final factory signature; `toolsFor` answers `{ tools: [], shadowed: new Set(), unavailable:
   [] }`), and `S/registry/{types,index,styles,hook-commands}*` (empty `styles` / `hookCommands` registries wired in,
   contributions `hooks: 0`, `outputStyles: []`). In P11-A W11.4 owns `S/mcp/project*` and W11.7 `S/registry/**` (not
   `types.ts`).
4. **`ProjectSummary.outputStyle` before `0008`**: C34's compile fix makes the projects service answer
   `outputStyle: null` (the column does not exist yet); C36's upgrade test covers the column; W11.7 reads and writes it
   (`PATCH /projects/:id { outputStyle }`) in P11-A. An unknown style name is accepted there and falls back at run time
   with the notice `output-style-unavailable`.
5. **Builtin output styles**: SH holds the names, labels, descriptions and texts (`BUILTIN_OUTPUT_STYLES`, C35); C38
   adapts them in `S/builtin-plugins/core-agent/styles.ts` (like `core-agent/agents.ts` for the builtin agent types;
   frozen with `core-agent/**`); W11.6's `S/services/customizations/builtins.ts` lists them as catalog builtins.
6. **`core-agent/**` is frozen after P11-0b, yet W11.6 owns `core-agent/skill*`**: the frozen parts are the manifest,
   the tool schemas, descriptions, policies, model texts and the builtin styles; the refusal of a
   `disable-model-invocation` skill lives in `loadSkill` (`S/chat/skills.ts`, W11.6), so `skill.ts` changes only if a
   test needs it (a behavior change of the frozen parts is a CCR).
7. **W11.7 also owns `examples/plugins/examples.test.ts`** (`EXAMPLE_IDS` gains `hook-pack`; the Phase 10 open point 6
   precedent); PLUGINS.md snippets the test compares are "For W11.14" notes.
8. **Trust and project MCP are coupled by events**: W11.3 never calls the MCP manager; W11.4's manager subscribes to
   `project-trust.changed` (and the project-config invalidation) and stops or restarts the runtimes whose approval or
   hash changed. Project deletion: the `project_trust` rows cascade (foreign key); W11.4 stops the runtimes and deletes
   the secret scope `project:<id>` on `project.changed { project: null }`; W11.1 drops the project's hooks cache.
9. **Personal commands with `!` spans restored from a backup come back `enabled: false`**: implemented in the
   customizations store's restore (`S/services/customizations/store.ts`, W11.6); W11.7 covers the round trip in the
   data tests.
10. **Project MCP variables are per project**, so `ProjectMcpServerRow` emits no `save`; the variables panel lives in
    `ProjectMcpDialog` (`variables: [{ name, set, hint, usedBy }]`), and its fresh-auth prompt reads "Saving project
    variables needs your password." for every server type (the route is always fresh).
11. **The web pure module `settings/customize/hooks.ts`** exports `HOOK_EVENT_COPY` (label, description, whether the
    matcher matches tools), not web.md's `HOOK_EVENTS` (that name is SH's).
12. **The trust dialog's "Changed" state**: the trust DTO has `state: approved | pending` only. Proposed: C34 adds an
    optional `changed: boolean` to the trust item (a pending item whose kind and label match an approved row whose hash
    the scan no longer finds; W11.3 computes it); without it the dialog shows New and Approved only (the "Changed"
    copy is then cut). **Decided by the coordinator: C34 added `changed?: boolean`; the dialog shows New / Changed / Approved.**
13. **SessionStart on server-started turns**: SessionStart runs for `request` and `queue` turns only (a queued turn can
    only be `compact`-sourced: the queue exists only while a run is active); never for `task` and `hook` turns; a block
    on a `queue` turn fails the item like any other prepare error (W11.2 reports the exact behavior).
14. **UserPromptSubmit on the `/` page**: a block stores nothing, also no chat row; C37 places the call site so it runs
    before the chat row is created (or the creation is rolled back in the same transaction) and reports which.
15. **Unowned in P11-A**: `S/chat/{approval,pipeline,tools,steps,markers,model-history,agent-scope,hooks}.ts` and
    `S/chat/subagent/host.ts` (frozen), `S/chat/{modes,runs,history,usage,title,files,scope,errors,generated-files,
    images,tool-history,plan-file,testing}*`, `S/workspace/**`, `S/mcp/{index,internal,mcp-tools,policy,tools,
    templating,user-servers,errors}*`, `S/builtin-plugins/{core-mcp,core-tools,core-workspace}/**`, the mock models,
    `W/stores/plugins*`, `W/components/app-shell/**`, `W/components/plugins/mcp/**`: a needed change is a CCR, and new
    test helpers go into the agent's own files.
16. **Seed timing**: the plan runs the v1.6 seed in P11-0a in the background (agent K3S), so it is ready before Gate
    P11-0b; the upgrade copy is `.tmp/upgrade-v16/{data,roots}` + `.tmp/upgrade-v16-ids.json`.
17. **Slots**: P11-0a C34 k2, C35 k3, D14 k1 (D15 runs no server; K3S drives the `.tmp/v16` build on the coordinator's
    :8898); P11-0b C36 k3, C37 k5, C38 k6, C39 k4; P11-A W11.1 – W11.7 k1 – k7 (web agents run no server), G11P on
    :8896 – :8898 only after the coordinator's build signal; W11.13 e2e 8891.

### Deviations found while building (P11-0a – P11-B)

Recorded by the coordinator from the agent reports (`.tmp/waves/P11-*-notes.md`) and the gates; the code and the
reconciled docs (W11.14) follow these, not the task text further down.

- **P11-0a (K1, K2, K3S, C34, C35, D14, D15)**:
  - Open points: 1 kept as prompted (C35 adds `style` to `CUSTOMIZATION_KINDS`, C34 adds `output-style` to
    `CLIENT_COMMANDS`, each with its compile fixes, the web maps included); 2 accepted (no route flag on
    `hooks.update`: the handler asks for fresh auth unless the body is exactly `{ enabled: false }`); 12 decided: the
    optional `changed?: boolean` of a trust item (C34 adds it, W11.3 computes it; "Changed" instead of "New"); the
    others accepted as written.
  - C34: the plugin contributions count is **`commandHooks: number`** (`hooks: string[]` keeps listing the code hooks);
    the outcome enum is `hookRecordOutcomeSchema` / `HookRecordOutcome` (`HookOutcome` is the helper type of
    `util/hooks.ts`); `details.hook` of a 409 `hook-blocked` is checked only as an object in `errors.ts` (import cycle
    with `chat.ts`); `/output-style` showed a "not available yet" toast until W11.10; the secret scope `project:` landed
    in `services/secrets/types.ts` (C36). Pins: 120 routes / 33 modules, 18 SSE types, 30 settings, 11 notices, 14
    conflict reasons, 6 data parts, 7 client commands, the origin `hook`, 4 customization kinds.
  - C35: `limits.ts` imports no util file (cycle limits → trust → shell-command → limits): the Phase 11 limits are
    literals with an equality test against the util mirrors; the skill keys `userInvocable` / `modelInvocable` /
    `argumentHint` are optional (present only when not the default; `skillInvocation()` applies the defaults); new
    exports `HOOK_MATCHER_SUBJECTS`, `isAllowedMcpUrl`, `extractArgsFileRefs`, `skillInvocation`,
    `styleNameFromLabel`, `DEFINITION_LIMITS.labelMaxChars` (128); `hookTargetNames` also maps `task` / `todo_write` /
    `exit_plan_mode` / `skill` to `Task` / `TodoWrite` / `ExitPlanMode` / `Skill`; `sessionStartSource` is `compact`
    only when no user-authored message and no SessionStart record follow the latest compaction marker; fenced code
    blocks are plain text for `!` spans and `@` references; a cut payload carries `harness.truncated: true`; the model
    text is `<hook-context event tool>` / `<hook-feedback>` with the fallback `(no reason given)`; in `.mcp.json` a URL
    with variables must start with `http(s)://` or a variable and a default cannot hold another variable; discovery
    scans eight folders (`output-styles` included).
  - D15: W11.8 owns the Data copy (`W/components/settings/data/{DataExportSection,DataImportSection}*`); a 409
    `hook-blocked` carries `details.hook`; `project-mcp-variable[data-state]` = `set | default | missing`,
    `hooks-disabled[data-reason]` = `safe-mode | shell-off`; UI.md 13.12 lists 79 test ids.
  - K3S: the v1.6 seed `.tmp/upgrade-v16/{data,roots}` (20 chats, 136 messages; the projects `git-demo` with Phase 11
    files and `untrusted` with invalid, oversized and linked files); v1.6 already runs user stdio servers in
    `<dataDir>/plugins/.data/core-mcp` (a `.mcp-started-*` marker exists there), so the "nothing ran" checks look only
    at project folders.
  - P11-00 completion: Dependabot #8 and #7 merged; the source-map-js advisory is overridden, the simple-git advisories
    (only through the disabled `@nuxt/devtools`) are ignored with a dated comment (`60389e0`).
  - Gate: the examples' `harness-forge.d.ts` regenerated; the agent-pack contributions expectation gained
    `commandHooks: 0` and `outputStyles: []`.
- **P11-0b (K3, C36, C37, C38, C39)**:
  - K3: `0008_hooks_trust` = 2 CREATE TABLE (`hooks`; `project_trust` with the primary key project + sha256 and a
    cascading foreign key) + 1 `ALTER TABLE projects ADD output_style`, no index; 22 tables; a second `db:generate`
    reports no changes.
  - C36 / C37 names (full list in `.tmp/waves/P11-0b-notes.md`): `HookScope`,
    `HookService.snapshot(scope, { signal? })`, `HookSnapshot { scope, has, run }`, `HookRunInput` (+ `command?`;
    SubagentStop passes the `task` call as `input.tool`), `HookEventResult`,
    `ProjectMcpManager.toolsFor(projectId, { signal, waitMs })` → `{ tools, shadowed, unavailable }`,
    `RunReleaseFollowUp = { kind: 'hook', data }` (an interface; no new `ChatRunner` member),
    `ProjectConfigService { snapshot, verify, invalidate, stop }`, `ProjectTrustService.revoke` answers the list; the
    fake snapshot option is `present`; `<dataDir>/hooks` has no `env.paths` entry (joined from the data directory).
  - C37: `applyHookDecision` writes "Blocked by hook: …"; a hook `allow` applies only when the call would ask, is not an
    `execute` tool and its policy is `safe` / `ask`; a rewrite happens before `tool.before` (fail closed); PostToolUse
    runs on success only; `steps.ts` runs guard → hooks → steer → finalize; **open point 14**: a `hook-blocked` refusal
    deletes the chat row the request created (`chat.created`, then `chat.deleted`); Notification is fired by the
    pipeline itself; PreCompact runs through `HostSession.hooks.preCompact`; `carrierParts` holds task results or hook
    parts, never both; `ensureRunChat` saves `outputStyle` only when it creates the chat; `GET /commands` items carry
    `kind: 'command'`.
  - C38: `RunShellOptions.input` / `.env` (`SHELL_ENV_RESERVED`, `mergeShellEnvironment`); every stdio MCP server
    (global ones too) runs in its own process group on POSIX; the fixtures `mcp-min.mjs` / `grandchild.mjs`; the
    `mock:hooks` continuation rules apply only when the last user message is not a steer; the `record` script writes a
    `.hook-log` file (not a folder); the mock listing has 20 models (`GET /api/models` 18).
  - C39: Customize tabs `agents | commands | skills | output-styles | hooks`; UI.md won over the task text: `focusKey` /
    `data-key` (not the sha256), `HOOK_EVENT_INFO` (not `HOOK_EVENT_COPY`), `HookAction` without `copy-to-personal`,
    the extra props `ProjectTrustItem.variables?` and `ProjectMcpServerRow.trust`; the stores `hooks` (+ `runs()`),
    `project-trust` (`pending()` → `number | null`) and `project-mcp` (`saveVariables`).
  - Gate: 11212 tests; the v1.6 upgrade probe 57/57 and the seam probe 37/37; after a real upgrade the cached v1.6 mock
    listing hides `mock:hooks` until a refresh; `GET /tools` still lists `shell` with `HF_WORKSPACE_SHELL=0`
    (registered, not offered; unchanged).
- **P11-A (W11.1 – W11.12, G11P; fix-ups W11.15, W11.16)** (full digest: `.tmp/waves/P11-A-notes.md`):
  - Coordinator CCRs applied during the wave: `chat/pipeline.ts` counts only model-invocable skills for
    `skillsAvailable` (W11.6); `SH/schemas/shares.ts` command `{ name: slashNameSchema, kind?: invocationKindSchema }`
    (W11.12: skills up to 64 characters, share pages read "Skill"); `chat/tools.ts` passes the `tool.after` draft to
    `postToolUse`, so a plugin's `tool.after` `context` is recorded as a `PostToolUse` record (source plugin, label
    `tool.after`, outcome `context`) and reaches the model at the next step (W11.1); `services/secrets/scope.ts` accepts
    `project:` scopes (found by W11.7).
  - W11.1: outcomes: a Stop block → `continued`, a SubagentStop block → `blocked`, `continue: false` → `stopped` (wins
    over a Stop block), a `systemMessage` alone → `context`; labels are the redacted command head (project items
    prefixed `<file>: `); code hooks are listed as `plugin:<id>:code:<event>:<n>` and logged once per plugin (`exitCode`
    null); a hook snapshot opens the project folder 0 times; a `workspace.changed` under `.claude/` / `.harness/` emits
    `hooks.changed { projectId }`.
  - W11.2: two hook snapshots per request (prepare + run; the pin of `pipeline-hooks.test.ts` changed); hook turns use
    request ids `hook_…`; UserPromptSubmit also runs at enqueue (the records travel with the queue entry); the
    PreCompact record sits right before the marker; each SubagentStop round gets the child's remaining steps; `/compact`
    and each enqueue open the project folder once (for the hook scope).
  - W11.3: revoke answers **200 with the list** (not 204); more `project-trust.changed` emits (a hash change after a
    rebuild or a verify mismatch, a pending-count change, `{ pending: 0 }` on project delete); `orphaned` is 0 while
    the folder is unavailable; a span longer than 4096 characters is never listed; linked, oversized or unreadable
    settings files are `not-an-object` / `too-large` diagnostics; no DNS lookups for `private-network`; no folder
    opens per run.
  - W11.4: stored variables no server uses are listed with `usedBy: []`; `reconnect` of a pending or needs-variables
    server answers 200 with that state; `shadows` only for approved servers; `.mcp.json` is read again every 15 s while
    a server runs; a crashed server is retried at the next run (no timer); the manager subscribes to events at its first
    use.
  - W11.5: one `TurnWorkspace` per turn (the folder opens at most once in prepare, the run reuses it); 409 `untrusted` /
    `disabled` also delete the chat row the request created (400 keeps the v1.6 behavior); plugin templates run spans
    and references too; `@README.md,` keeps the comma (frozen mention grammar) and is not inlined (backlog); the frozen
    expansion carries `kind: 'command'`, and `inlined` only when something was inlined.
  - W11.6: a plugin style with a builtin name is `invalid`; a restored command with `!` spans is turned off; the style
    resolves chat ?? project ?? setting, and an unavailable one runs as `default` with the notice once per model.
  - W11.7: `runsCode` is true for declarative plugins with command hooks or `!` spans (it follows
    `manifestRequiresTrust`); the first plugin that registers a style name wins (the second is logged as skipped); the
    restore warnings said "agents, commands or skills" (styles included; W11.17 changed them to "personal
    definitions").
  - W11.8: the CCRs stay local adapters (`CustomizationDraft.label?`, the `HookSection` slots `notices` /
    `empty-actions`, `customizeRoute` with `'style' | 'hook'`); the hooks panel reads on / off from `state` (`HookEntry`
    has no `enabled`).
  - W11.9: the variables prompt uses UI.md's text; Enter never approves; more than 50 approvals go in batches of 50;
    Review… in the MCP dialog opens a nested trust dialog.
  - W11.10: the style menu gets its project scope through the `OUTPUT_STYLE_SCOPE` provide / inject adapter (kept at the
    gate, no prop change); a plugin hook's refusal line reads "Plugin hook" (no plugin name in the data).
  - W11.11 / W11.16: on `/` the page moves to `/chat/<id>` once the server accepted the first request (a 2xx answer,
    seen by the transport's `fetch`; the additive frozen member `ChatSession.accepted`), not at the first chunk (an
    image turn streams nothing before its image: the e2e regression of the gate); a refused first message keeps the
    page on `/`; a refused edit puts the text and the files back in the composer and the previous version reloads.
  - W11.12: hook notes read "Project hook" (`HookData` has no path).
  - G11P: 353 checks passed, 3 failed; regressions (P10-A copy, P9-A, P8-A `ws git`) green. Fix-ups: **W11.15** —
    `PUT /settings { hooksEnabled }` emits `hooks.changed { projectId: null }`; a PreToolUse `allow` never skips the
    card in plan mode (`applyHookDecision(…, toolMode?)`; known limitation: the record keeps the hook's outcome
    `allowed` while the harness still asks, in plan mode, for `execute` tools and `always` policies); bare script names
    (`sh count.sh`, `node hook.mjs`) are trust references (a security fix in `SH/util/trust.ts`); a personal hook that
    is off reads `off` before `blocked` (already so; tests added). **W11.16** — `created` on an accepted response; the
    import result copy "{n} personal definitions restored · {k} kept · {f} failed". Spec differences settled in the
    docs: a regex-looking project matcher is only a diagnostic (its group is dropped), `shadows` is absent until the
    server is approved, a linked `.claude` folder is `not-an-object`.
  - Backlog: `@path,` keeps the comma; dedicated diagnostic codes for linked / oversized settings files; a
    `turnedOff` count in the import result; the plugin name in a plugin hook's refusal line.
- **P11-B (W11.13, W11.14, W11.17, W11.18)**: W11.14 reconciled README, `.env.example`, API.md, ARCHITECTURE.md,
  PLUGINS.md, PROVIDERS.md, UI.md, the guides and `examples/plugins/README.md` with the code of `3cff82d`, then with the
  round-2 fix-ups it triggered. W11.17 (server): `POST /plugins` and every manifest save ask for fresh auth whenever the
  manifest requires trust (`manifestRequiresTrust`: a stdio MCP server, command hooks or `!` spans; the pin is set only
  after the check, and dropping the trust-requiring parts clears it); the restore warnings say "personal definitions";
  `SessionStart` / `UserPromptSubmit` run before a command's `!` spans and `@path` reads (the checks still come first,
  the trust hash is checked again right before the spans, a hook block runs nothing; image turns expand while
  planning); foreground and background sub-agents use the parent run's project MCP result (shadowing and the project
  tools under the child ceiling). W11.18 (web): the data-slot `hook-system-message`; the tool-row hook badge's tooltip
  opens while the row button has keyboard focus; the install preview lists agents and skills; the shadowed tooltip says
  "output style"; the hook command help says "Runs with bash (or sh when bash is missing) …". The final gate adds the
  rest.

## Rules for every Phase 11 agent

This section is the canonical copy of the agent rules (`.tmp/p11-designs/agent-rules.md` was its draft). The Phase 10
rules apply, renamed (P10-* → P11-*, W10.14 → W11.14; the ports :3000 / :8787 / :8899 / :8896 – :8898 are the
coordinator's; your slot is `879k`, e2e `889k`); the Phase 11 additions follow them.

- Read `AGENT.md` fully, your section of this file (or your task prompt) and the docs it names. Paths: `S` =
  `apps/server/src`, `W` = `apps/web/app`, `SH` = `packages/shared/src`, `SDK` = `packages/plugin-sdk/src`. Stay
  inside your OWNED globs; the FREEZE list in AGENT.md overrides any owned glob.
- Never run: package installs or CLIs (`pnpm add`, `npx`, `drizzle-kit`, `nuxi`, `shadcn-vue`), git write commands on
  this repository, `nuxt dev` / `nuxt build` / `nuxt prepare`, servers on :3000 / :8787 / :8899 / :8896 – :8898,
  **never `pnpm test:live`** (the repository `.env` may hold real keys and the suite makes paid calls), and never
  `pnpm key:rotate` / `rotate-key` against the repository's `data/` (tests use temp data directories). Existing scripts
  are allowed (`pnpm -F <pkg> test`, `pnpm typecheck`, `pnpm -F @harness-forge/web typecheck:fast`,
  `pnpm check:english`, `pnpm exec eslint --fix <your files>`).
- Shell hygiene in your own commands: never `cd` (use absolute paths, `pnpm -C <abs>`, `git -C <abs>`); never inline
  `sh -c` strings (a security hook blocks them: use script files or argument arrays); zsh does not word-split `$var`
  (use `bash -c` when you need it); `rm -rf` is denied (move things aside with `mv` under `.tmp/`).
- Your own server uses your slot: `HF_PORT=879k HF_DATA_DIR=.tmp/<agent-id>`; e2e agents use `889k` (k ≠ 9) with
  `E2E_BASE_URL`. Stop every process you started (shell children, hook and MCP fixture children and background children
  included; kill by port) before reporting. Prefer `createTestApp()` + `app.request()`.
- **Temp folders**: tests create workspaces, roots, repositories, definition and settings folders and data directories
  with `realpath(await mkdtemp(join(tmpdir(), 'hf-')))` (macOS `/var` is a link to `/private/var`, so an un-resolved
  path fails every containment check) and remove them afterwards; never the repository's `data/`, `.tmp/e2e`, a seed
  folder or a real project folder.
- **Shell tests** use POSIX `sh` syntax only (CI runs Linux, where `/bin/sh` may be `dash`; Docker has busybox): no
  bash-only features (`[[ … ]]`, arrays, `$'…'`, `source`), generous time margins, and skipped on Windows
  (`process.platform === 'win32'`).
- **Never spawn a shell string outside `S/workspace/shell.ts`**: no `spawn(…, { shell: true })`, `exec`, `execSync` or
  `child_process` with a command string anywhere else. **git runs only through `S/workspace/git.ts`** (argument
  arrays, `shell: false`, its scrubbed environment and `-c` overrides; paths after `--`, resolved through
  `resolveWorkspacePath` first). The MCP stdio transport keeps its own argument-array spawn.
  `S/security/process-spawn.test.ts` enforces the list (3 modules).
- **Git in tests**: never a git write command on the harness-forge repository. Tests run `git init` inside their own
  `realpath(mkdtemp())` folder, set the author with `-c user.name=… -c user.email=…`, point `HOME` /
  `GIT_CONFIG_GLOBAL` at the temp folder and use `describe.skipIf(!hasGit())`.
- **Every path a workspace tool, a mention, a definition read, a settings or `.mcp.json` read, a referenced script, an
  `@path` reference, a skill file listing, a plan file or a Remember append touches** resolves through the frozen
  `resolveWorkspacePath` (`S/workspace/paths.ts`) and the sensitive-path rules (`S/workspace/sensitive.ts`); no `fs`
  call on a model-supplied, user-supplied or file-supplied path without it.
- **Checkpoint blobs and journal rows only through the checkpoint store** (`S/services/checkpoints/**`); sub-agent and
  background sub-agent writes go through the same `journaledWrite` under the launching message's run scope; plan files
  through `journaledWrite`, Remember appends through `deps.checkpoints.journal(...)`. Hook processes and `!` spans are
  not journaled (documented).
- Every new text or JSON column goes into `REFERENCE_SOURCES` or `UNSCANNED_COLUMNS` (`S/services/data/references.ts`;
  Phase 11 adds `hooks.*`, `project_trust.*` and `projects.output_style`, all unscanned, classified by C36).
- The shell command matcher (`SH/util/shell-command.ts`) fails closed: anything it cannot tokenize asks.
- **Logging**: never log key material, secret values, file contents, diffs, tool inputs or outputs, shell commands,
  compaction summaries, steer / todo / plan texts, sub-agent prompts or outputs, mention queries, definition or skill
  bodies, command expansions, background prompts or reports or Remember texts at `info` (`debug` only, redacted;
  diagnostics carry project-relative paths and never file contents); Phase 11 additions below.
- Timers are `unref()`-ed and cleared in `stop()`; tests use fake timers (no real sleep over 2 s; hook timeouts in
  tests use small per-hook timeouts, never the 60 s default).
- Contracts: DTOs and route keys only from `@harness-forge/shared`, plugin shapes only from
  `@harness-forge/plugin-sdk`; server services only through the frozen `types.ts` interfaces. A missing member, a
  contract change, a frozen-file edit or a **new test id** is a CCR in your report (file, current shape, proposed shape,
  reason) plus a local adapter so you can keep working.
- New components are imported explicitly by path (`import HookNote from './hooks/HookNote.vue'`): the coordinator runs
  `nuxi prepare` only at the gates, so auto-import types do not know files created mid-wave.
- The props, emits and root test ids of the P11-0b stub components and the signatures of the new stores, modules and
  `useChatSession` additions are frozen after P11-0b: implement behind them; a change is a CCR.
- No doc edits in P11-A: write "For W11.14" notes (facts, deviations, suspected doc errors) into your report.
- Web unit tests: Nuxt composables come through a local `nuxt-imports.ts` that tests `vi.mock`; every password prompt
  goes through `useFreshAuth()` (UI.md 8.4).
- e2e uses only `.tmp/e2e/workspaces/*` for project folders.
- Verify before reporting — server: `pnpm -F @harness-forge/server test` · `pnpm typecheck`; shared:
  `pnpm -F @harness-forge/shared test`; plugin SDK: `pnpm -F @harness-forge/plugin-sdk test`; web:
  `pnpm -F @harness-forge/web test` · `pnpm -F @harness-forge/web typecheck:fast`; all: `pnpm check:english`; lint
  your files with `pnpm exec eslint --fix <your files>`.
- Report ≤ 300 words in the AGENT.md format (tasks, files, commands + results, CCRs, dependency requests, open issues,
  suggested ROADMAP updates, "For W11.14" notes). Commits are made only by the coordinator; never add AI attribution
  anywhere.

Carried over from Phase 9:

- **Only mock models** in tests (`MockLanguageModelV4`, `simulateReadableStream` from `ai/test`, the `mock:*` provider);
  catalog, command, skill, hook and background code never resolves a real provider (or a key from the environment) in
  tests. Never `pnpm test:live`.
- **Verify AI SDK names** in `node_modules/.pnpm/ai@7.0.127_zod@4.6.5/node_modules/ai/dist/index.d.ts` (and
  `@ai-sdk/provider-utils` `dist/index.d.ts`) before use: `streamText({ instructions, messages, tools, activeTools,
  prepareStep, toolApproval, stopWhen, abortSignal })` (`stopWhen` is `Arrayable<StopCondition>`), the `prepareStep`
  result fields, async-generator `execute`, `convertToModelMessages` options, `UIMessageStreamWriter`, transient data
  chunks. Phase 11 needs no new SDK API (`experimental_refineToolInput` is rejected for `updatedInput`).
- **History-derived state** (`findCompaction`, `compactionMarkers`, `splitSteers`, `latestTodos`, `splitTaskResults`,
  `taskResultText`, and now `splitHooks`, `hookModelText`, `isHookCarrier`, `hookChainLength`, `sessionStartSource`)
  only from `SH/util/agent-state.ts`; mention parsing / ranking only from `SH/util/mentions.ts`; no local
  re-implementation on the server or the web.
- **Plan mode is enforced on the server** (tool set + approval), never only in the UI; `allowed-tools` keeps
  `exit_plan_mode` in plan mode; a hook `allow` never skips the plan-mode rules.
- **Sub-agents never create approval requests** (foreground and background): a tool that would ask is not offered or is
  denied (a hook `ask` in a child is a denial); depth 1; `task` and `skill` are absent from the child tool set.
- **In-memory state** (the queue, the sub-agent semaphores, the file index, the catalog cache, the background inbox and
  snapshots, the hooks and project-config caches, the hook run log, the project MCP runtimes) is keyed by chat /
  project, bounded, cleared on chat / project delete, key rotation and shutdown; timers `unref()`.
- **Feature agents implement behind the P11-0b seams** (`S/chat/{pipeline,tools,approval,steps,markers,model-history,
  agent-scope,hooks}.ts`, `S/chat/subagent/host.ts`, `S/workspace/shell.ts`, `S/mcp/stdio-transport.ts`, the frozen
  service types and the stub modules).

Carried over from Phase 10:

- **Project definition files are untrusted input** (`.harness/{agents,commands,skills,output-styles}`, `.claude/{…}`):
  their `tools` / `allowed-tools` only restrict (never add a tool), they never change the mode, grant an approval,
  create a tool override or a shell rule; `model` resolves only to providers the user configured. Prompt injection
  through bodies is accepted like `AGENTS.md` today. Since Phase 11 the only exception is an **approved** executable
  item (a hook, a `.mcp.json` server, the `!` spans of a command file).
- **Reading project definitions**: every read through `resolveWorkspacePath` / `openWorkspaceFile` (no links anywhere
  on the path, regular files only, binary skipped, byte caps before parsing, count / depth caps, sensitive rules);
  never read `~/.claude` or `~/.harness` (user-level definitions and hooks live in the DB only).
- **Parsing only with the shared helpers** (`SH/util/{definitions,arguments,tool-names}.ts` and now
  `SH/util/{hooks,trust,mcp-config,command-template,output-styles}.ts`); `yaml` is imported only by
  `SH/util/definitions.ts`; verify its API in `node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/*.d.ts`.
- **Background tasks** never create approvals; are bounded (3 per chat, 10 per server, 30 min, `subagentMaxSteps`);
  are stopped on chat / project delete, delete-all, key rotation and shutdown (a restart leaves `aborted`), **never by
  the chat's Stop**; are delivered exactly once (`delivered_at`); their writes are journaled under the launching
  message; a running task makes its project busy (409 `run-active`).
- **Writes**: plan files and `AGENTS.md` / `CLAUDE.md` appends go only through the journal and the file lock;
  hidden-path write policies (`always`) are never relaxed, so the agent can never silently rewrite `.harness/**`,
  `.claude/**` or `.mcp.json` (a hook `allow` does not skip them either).
- **Parts and their consumers** (Phase 10): `data-task-result` and `tool-skill` keep their consumers; Phase 11 adds
  `data-hook` (below).
- **Hot files have one owner per wave** (P11-A): `prepare.ts`, `commands.ts`, `context.ts`, `notices.ts`, `inline/**`
  → W11.5; `params.ts`, `output-style.ts`, `skills.ts` → W11.6; `hooks-prompt.ts`, `steer.ts`, `queue.ts`, `index.ts`,
  `subagent/**` (not `host.ts`), `compaction/**`, `background/**` (not `types.ts`) and the chat / chats / chat-queue
  routes → W11.2; `S/services/hooks/**` → W11.1; `S/services/{project-config,project-trust}/**` → W11.3;
  `S/mcp/project*` → W11.4; `S/services/customizations/**` → W11.6; `S/registry/**`, `S/plugins/{context,declarative,
  loader,host}*`, `S/services/{data,shares}/**`, `S/services/projects/index*` → W11.7; `CustomizeSettings.vue`,
  `customize.ts` → W11.8; `ChatHeader.vue`, `ChatProjectChip.vue`, `ProjectsSettings.vue` → W11.9;
  `ChatComposer.vue`, `SlashMenu.vue`, `slash-commands.ts` → W11.10; `ChatView.vue`, `useChatSession.ts`,
  `useServerEvents.ts` → W11.11; `ChatMessage.vue`, `ChatTranscript.vue`, `chat-format.ts`, `ToolPart.vue`,
  `ToolApprovalCard.vue` → W11.12. `S/chat/{pipeline,tools,approval,steps,markers,model-history,agent-scope,hooks}.ts`,
  `S/chat/subagent/host.ts`, `S/workspace/shell.ts` and `S/mcp/stdio-transport.ts` are complete and frozen after
  P11-0b (a change is a CCR).
- The mock models (`mock:agents`, `mock:background` and now `mock:hooks`) are frozen after P11-0b; PROVIDERS.md 8 is the
  probe contract.

Phase 11 additions:

- **Repository content is untrusted**: `.claude` / `.harness` `settings.json` and `settings.local.json` (only the
  `hooks` key is read), `.mcp.json`, output styles, command and skill files. Read them only through
  `resolveWorkspacePath` / `openWorkspaceFile` (no links anywhere on the path, regular files only, byte caps before
  `JSON.parse` / YAML, count caps, diagnostics instead of errors); never read `~/.claude` or `~/.harness`.
- **Executable items run only after hash approval** (project hooks, `.mcp.json` servers incl. http / sse, command files
  with `` !`cmd` `` spans): the sha256 of `trustHashInput(item)` covers the item **and the script files it references**
  and is re-checked right before every spawn (verify-before-run); a missing approval means "pending" (never "ask at run
  time"); the approve and variables routes are `fresh` and tests prove 403 without a fresh login.
- **Never read `process.env`** for `.mcp.json` variables or to build a hook / MCP environment beyond
  `shellEnvironment` / `stdioEnvironment` + `HARNESS_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` (+ `HARNESS_PLUGIN_ROOT` /
  `CLAUDE_PLUGIN_ROOT` for plugin hooks).
- **Hooks and `!` spans run only through `runShellCommand`** (with `input` / `env`); the spawn allowlist
  (`S/security/process-spawn.test.ts`) stays at 3 modules; timeouts, Stop and shutdown kill process groups.
- **Kill switches**: the setting `hooksEnabled: false`, `HF_WORKSPACE_SHELL=0` (no shell string at all: no `shell`
  tool, no command hook, no `!` span) and `HF_SAFE_MODE` (no command hooks, no project MCP servers) block command
  hooks; plugin code hooks still run.
- **Hook scripts in tests** are POSIX `sh` files inside `realpath(mkdtemp())` projects, invoked as
  `sh <relative path>`: never inline `sh -c` strings (a security hook blocks them in the coordinator's session), no
  `jq`, busybox-compatible (use `S/testing/hook-scripts.ts`); every spawned pid is dead at test end (assert it).
- **MCP tests** use loopback fixtures only (port 0; `example.invalid` for unreachable hosts; the stdio fixtures of
  `S/mcp/__fixtures__`); never `npx`, never a remote URL.
- **Never create `.claude/`, `.harness/` or `.mcp.json` at the repository root** (they would configure the
  coordinator's own Claude Code session); seeds and fixtures live in temp folders or under `.tmp/`.
- **Logging**: never log at `info` hook stdin payloads, stdout / stderr, hook command strings, `!` commands or their
  output, `@file` contents, `.mcp.json` variable values or resolved env / args / headers; hook runs log only the event,
  source, label hash prefix, exit code, duration and outcome.
- **Continuation turns** (Stop hooks, origin `hook`) are capped (5 in a row) and never start while an approval is
  pending; a user Stop ends the chain.
- **`data-hook` consumers** each covered by their owner's test: model history (`splitHooks`, C37), search text /
  Markdown export / import / share drop (W11.7), `HookNote`, the tool-row badges and the carrier turn (W11.12),
  `useChatSession` origin `hook` (W11.11).
- **Web**: never put `//` inside a component prop value in a template (vue-tsc 3.3.12 regression
  vuejs/language-tools#6240 corrupts the generated code; `W/components/template-literals.test.ts` guards it); URLs go
  into script constants.
- **No doc edits in P11-A**: write "For W11.14" notes into your report.

## FREEZE in Phase 11

In force since earlier phases (AGENT.md): `packages/*/src`, `S/app.ts`, `S/db/schema.ts`, `apps/server/drizzle/**`,
every `*/types.ts` under `S`, `S/builtin-plugins/index.ts`, `W/layouts/**`, store signatures in `W/stores/**`,
`apps/web/nuxt.config.ts`, every `package.json` and config file, `W/components/{ui,ai-elements}/**`, the CSS design
tokens in `W/assets/css/main.css`, `W/utils/testids.ts` (Phase 5), the Phase 5 – 8 additions (the services `types.ts`
files, `S/workspace/{paths,run-scope,file-lock,git}.ts`, `S/services/chats/approvals.ts`, the `main.ts` boot hooks,
`SH/util/shell-command.ts`, the props of the P6-0b, P7-0b and P8-0b stub components, `DiffView` props, the `projects`,
`workspace` and `shell-rules` stores, `useChangesPanel`, the `useChatSession` additions of Phases 7 and 8, the mock
models of Phases 6 – 8), the Phase 9 additions (`S/services/project-files/types.ts`, the P9-0b versions of
`S/types.ts`, `S/chat/types.ts` and the deps order, `S/chat/{steps,markers,model-history,agent-scope}.ts`, the P9-0b
stub signatures, `S/builtin-plugins/{index.ts,core-agent/index.ts}`, the Phase 9 mock models, `SH/util/{agent-state,
mentions}.ts`, plugin SDK 1.3.0, the props / emits / root test ids of the P9-0b stub components, the `chat-queue`
store, the `useProjectFiles` / `useFileMentions` / `useModeCycle` signatures, the `useChatSession` additions, the
Phase 9 test ids) and the Phase 10 additions (`S/services/customizations/types.ts`, `S/chat/background/types.ts`,
`S/chat/subagent/host.ts`, the P10-0b versions of `S/types.ts`, `S/chat/types.ts`, `S/registry/types.ts`, the deps
start / stop order and the boot sweep, `S/chat/{pipeline,tools,steps,markers,model-history,agent-scope}.ts`, the
signatures of the P10-0b chat stubs, `S/builtin-plugins/{index.ts,core-agent/index.ts}`, the mock models `mock:agents` /
`mock:background`, `SH/util/{definitions,arguments,tool-names,agent-state}.ts`, plugin SDK 1.4.0, the props / emits /
root test ids of the P10-0b stub components, the `customizations` and `background-tasks` stores, the
`AGENT_TASK_CONTEXT` injection key, `taskResultsOf` / `isTaskResultMessage`, the P10-0b pure-module signatures, the
`useChatSession` additions, the Customize settings route and its nav entry, the Phase 10 test ids).

P11-0a and P11-0b open the frozen files **only** for their named owners:

- P11-0a: K1 — `AGENT.md`, `docs/DECISIONS.md`, `docs/ROADMAP.md`; K2 — nothing (no new dependency: the package files
  and the lockfile stay closed); the coordinator — the contract skeletons `SH/util/{hooks,trust,mcp-config,
  command-template,output-styles}.ts` and `SH/index.ts` (exports) (+ the two enum entries of open point 1), and at the
  gate `examples/plugins/*/harness-forge.d.ts` (regenerated for 1.5.0); C34 — `SH/**` (not the C35 files), `SDK/**`,
  `S/app.ts`, the template mirror `S/plugins/templates/sdk-types.ts` (and the compile fixes it lists, among them frozen
  web files whose kind maps the `style` kind breaks); C35 — `SH/util/{hooks,trust,mcp-config,command-template,
  output-styles,definitions,agent-state}{,.test}.ts` (complete).
- P11-0b: K3 — `S/db/schema.ts` (`hooks`, `project_trust`, `projects.output_style`, `TABLE_NAMES` 22) +
  `apps/server/drizzle/**`; C36 — `S/types.ts` (`AppServices.{hooks, projectConfig, projectTrust, projectMcp}`),
  `S/deps.ts` (factories, start and stop order), `S/env.ts` (compile fixes only), `S/main.ts`, `S/chat/types.ts`,
  `S/registry/types.ts` (`styles`, `hookCommands`, contributions),
  `S/services/{secrets,projects,customizations}/types.ts` (the scope `project:<projectId>`, `outputStyle`, `styles()` /
  `style(name)`), `S/mcp/types.ts` (`ProjectMcpManager`), the new
  `S/services/{hooks,project-config,project-trust}/types.ts`; C37 — `S/chat/{pipeline,tools,approval,steps,
  model-history,agent-scope}.ts` and the new `S/chat/hooks.ts`, `S/chat/subagent/host.ts` (`markers.ts` only if a seam
  needs it, reported); C38 — `S/workspace/shell.ts`, `S/mcp/stdio-transport.ts`, `S/builtin-plugins/index.ts`,
  `S/builtin-plugins/core-agent/**` (incl. the new builtin styles), the mock models (`S/builtin-plugins/mock/**`); C39 —
  `W/utils/testids.ts`, the store signatures of `W/stores/{customizations,plugins}.ts` and the new `hooks`,
  `project-trust`, `project-mcp` stores, the prop / emit / expose additions of the earlier stub and hot components it
  touches (`ChatComposer` (`outputStyle`, `showRefusal`, `restoreInput`), `ChatTranscript` / `ChatMessage` /
  `SubmittedPlaceholder` (activity), `ToolPart` (`hooks`), `ToolApprovalCard` (`hookReason`), `CommandBadge` (`kind`),
  `PluginCustomizationList` (`kind: style`)), `CHAT_VIEW_ACTIONS`, the `useChatSession` interface additions.

Added to the freeze after Gate P11-0b:

- `S/services/{hooks,project-config,project-trust}/types.ts` and `S/mcp/types.ts` (new members); the P11-0b versions of
  `S/types.ts`, `S/chat/types.ts`, `S/registry/types.ts` and the deps start / stop order;
- `S/chat/{pipeline,tools,approval,steps,model-history,agent-scope,hooks}.ts` and `S/chat/subagent/host.ts` (complete,
  C37) and the signatures of the C37 stubs (`prepareRun` hook / style call sites, `CommandContext.expansion`,
  `RunParamsInput.outputStyle`, `agentBlocks(…, { codingHints })`, `startHookTurn`, `onReleased(…, followUp)`, the
  widened `carrierParts`, `S/chat/{hooks-prompt,output-style}.ts`);
- `S/workspace/shell.ts` (`RunShellOptions.input` / `.env`) and `S/mcp/stdio-transport.ts` (`processGroup`);
- `S/builtin-plugins/{index.ts,core-agent/**}` (incl. the builtin output styles), the mock model `mock:hooks`
  (PROVIDERS.md 8, "Hook mocks (Phase 11)");
- `SH/util/{hooks,trust,mcp-config,command-template,output-styles,definitions,agent-state}.ts` (complete, C35; a
  behavior change after the gate is a CCR); the plugin SDK 1.5.0 and its template mirror;
- the props, emits and root test ids of the C39 stub components (`HooksPanel`, `HookSection`, `HookRow`, `HookEditor`,
  `HookImportDialog`, `StyleScopeBar`, `ProjectTrustDialog`, `ProjectTrustItem`, `ProjectTrustChip`,
  `ProjectMcpDialog`, `ProjectMcpServerRow`, `HookNote`, `ToolHookBadge`, `OutputStyleMenu`, `ComposerRefusal`,
  `PluginHookList`);
- the `hooks`, `project-trust` and `project-mcp` stores, the pure-module signatures (`customize/hooks.ts`,
  `projects/trust/project-trust.ts`, `chat/hooks/hook-notes.ts`, `chat/composer/output-style.ts`), the `HOOK_ACTIVITY`
  injection key and the `CHAT_VIEW_ACTIONS` additions, the `useChatSession` additions, the Customize tab query
  (`?tab=agents|commands|skills|output-styles|hooks`), the Phase 11 test ids (UI.md 13.12) in `W/utils/testids.ts`.

No CCR is pre-approved for P11-A; the coordinator batches CCRs at Gate P11-A.

---

## Wave P11-00 — stabilization start (done)

1. **Design inputs (done)** — the six reports of the planning session extracted with `.tmp/p10-designs/extract.mjs`
   into `.tmp/p11-designs/{explore-pipeline,explore-mcp,explore-catalog,server,web,process}.md`, the approved plan
   copied to `plan.md`, the binding order and the known deviations written to `README.md`, the rules draft to
   `agent-rules.md`.
2. **Baseline (done)** — `git status --porcelain` → `pnpm check` on `45e974c` green with 10562 tests → `git status
   --porcelain` again, identical (`.tmp/gates/P11-00/{status-before,check,status-after}.*`).
3. **Old build for the seed (done)** — `git worktree add .tmp/v16 45e974c`, then `pnpm -C <abs>/.tmp/v16 install
   --frozen-lockfile` and `pnpm -C <abs>/.tmp/v16 build` (absolute paths, never `cd` into the worktree;
   `.tmp/gates/P11-00/v16-{install,build}.log`). The worktree stays at `45e974c` (the real v1.6) after `main` moves.
4. **vue-tsc 3.3.12 workaround (done)** — vuejs/language-tools#6240 (fix PR #6241 still open) turns every `//` in the
   inferred props of a component into a block comment, including `//` inside string literals, so the enclosing
   `v-for` / `v-slot` variables lose their types. Commit `4765743` `fix(web): keep URL literals out of component props`
   moves the URL placeholders of `W/components/plugins/mcp/McpServerDialog.vue`,
   `W/components/plugins/wizard/WizardCredentialsStep.vue`, `W/components/plugins/install/InstallDialog.vue` and
   `W/components/plugins/forms/SchemaField.vue` into script constants (rendered values unchanged) and adds the guard
   test `W/components/template-literals.test.ts` (fails on `//` inside an attribute value of a PascalCase tag);
   verified on #7's branch in a temporary worktree `.tmp/pr7` (cherry-pick, frozen install, `pnpm check`: 10563 passed,
   1 skipped — the first unit-test run of #7; `.tmp/gates/P11-00/pr7-check.log`), the worktree removed; pushed to
   `origin main`.
5. **Dependabot (in progress)** — #8 (`diff` 8 → 9; we only call `structuredPatch(…)` and read `hunks`) squash-merged
   after green; `@dependabot rebase` on #7 (minor-and-patch, 9 updates: hono, ignore, `@nuxt/test-utils`, eslint,
   `@modelcontextprotocol/sdk` 1.32 (fixtures only), markstream-vue, motion-v, `@lucide/vue`, …), every check green,
   squash-merged; then `git pull --ff-only`, `pnpm install --frozen-lockfile`, `pnpm why typescript` (6.0.x only),
   `pnpm check`, `pnpm build`, `mv .tmp/e2e .tmp/e2e-old-p11-00` + e2e 156; the CI run id of the new `main` is
   recorded in "Outcome".
6. **Audit advisories (done)** — GHSA-86w9-cpqp-85rv (node-forge) and GHSA-vfj7-8cjw-p6xm (braces) re-checked with the
   P8-00 decision rule (a) – (e): still `first_patched_version: null` → (d), both ignores stay; the backlog line carries
   the re-check date 2026-10-06.
7. **Archive (done)** — the old `.tmp` content moved into `.tmp/_archive/` with `mv` (`upgrade-v1`, `upgrade-v11`,
   `upgrade-v12`, `e2e-old-*`, the agent folders `C*` / `W*`, the `gate-*.log` / `*.pid` / cookie files of Phases 0 – 5,
   old `screenshots-*`, `demo*`); kept: `upgrade-v13` … `upgrade-v15` (+ ids), `gates/**`, `p*-designs`, `waves`,
   `release`, `e2e`, `v16` (the regression probes read them). The user deletes `.tmp/_archive` with one command.
8. **Memory** — the coordinator rewrites `harness-forge-state.md`: v1.6 pushed (`45e974c`, CI + Audit green); Phase 11
   = Hooks + project MCP + output styles; plan in `.tmp/p11-designs`; seed `.tmp/upgrade-v16`; gotchas: vue-tsc #6240,
   the P10-A probe migration pin, hook probes use script files (never `sh -c` strings), never create `.claude/`,
   `.harness/` or `.mcp.json` at the repository root.

---

## Wave P11-0a — decisions, contracts, docs

Four agents in one launch (C34, C35, D14, D15) after K1, K2 and the contract skeletons; the K3 seed runs alongside
(agent K3S).

### Coordinator actions

- **K1 (done)** — `docs/DECISIONS.md`: ADR-048 … ADR-052; the amendment notes on ADR-008 (declarative hooks / `!` spans
  need a trust pin), ADR-017 (fresh auth for personal hooks, approvals and project MCP variables), ADR-024 (backups:
  personal styles yes; hooks, approvals and variables never; commands with spans restored off), ADR-031 (project
  deletion drops approvals and variables; `projects.output_style`), ADR-033 (the shell runner runs hooks and `!` spans;
  `HF_WORKSPACE_SHELL=0` turns every shell string off), ADR-034 (rotation re-encrypts the project variables), ADR-040
  (PreCompact, SessionStart `compact`), ADR-042 (UserPromptSubmit at enqueue; a hook turn only with an empty queue),
  ADR-043 (children run PreToolUse / PostToolUse / SubagentStop, never a style), ADR-044 (the `style` kind; approved
  executable items are the only project content that can run), ADR-045 (spans, `@path`, user-invocable skills) and
  ADR-046 (background children run hooks; the origin `hook` and its ordering); the contract seed (the Phase 11 names,
  ids `hok_` / `hev_`, the secret scope, enumerations, the HTTP module rows, events, the chat request note, the data
  part, the notices, the settings, the tables and `0008`, `<dataDir>/hooks`, `HF_SAFE_MODE` / `HF_WORKSPACE_SHELL`
  notes, the mock model, the example plugin `hook-pack`, the backup contents, the Customize tab values).
  `docs/ROADMAP.md`: the Phase 11 section (one box per agent) and the backlog (removed: user shell hooks, project
  `.mcp.json` servers, output styles, `!bash` / `@file` in command files, user-invocable skills; kept: `~/.claude`
  import, editing project definition files in the UI). `AGENT.md`: the "Plugin API 1.5.0" and "Hooks, trust and project
  MCP" facts, the repository-root rule, the vue-tsc 3.3.12 fact, the `HF_WORKSPACE_SHELL` note and the Phase 11 freeze
  line.
- **K2 (done)** — no new dependency (justified in "Entry criteria"); a DEPENDENCY REQUEST from an agent is declined
  unless a gate proves the need.
- **Contract skeletons (done)** — `SH/util/hooks.ts` (`HOOK_EVENTS`, `TOOL_HOOK_EVENTS`, `HOOK_SOURCES`, `HOOK_LIMITS`,
  `HOOK_DIAGNOSTIC_CODES`, `HookDiagnostic`, `HookSpec`, `readHooksConfig`, `readSettingsHooks`, `compileMatcher`,
  `hookTargetNames`, `claudeToolName`, `hookPermissionMode`, `HookPayloadInput`, `buildHookPayload`,
  `HookProcessResult`, `HookOutcome`, `readHookOutput`, `SourcedHookOutcome`, `CombinedHookOutcome`,
  `combineHookOutcomes`), `SH/util/trust.ts` (`TRUST_ITEM_KINDS`, `TRUST_LIMITS`, `TrustRef`, `TrustHashItem`,
  `canonicalJson`, `trustHashInput`, `extractCommandFileRefs`), `SH/util/mcp-config.ts` (`MCP_JSON_TRANSPORTS`,
  `MCP_VARIABLE_NAME_PATTERN`, `MCP_CONFIG_LIMITS`, `MCP_CONFIG_DIAGNOSTIC_CODES`, `McpJsonServer`, `parseMcpJson`,
  `mcpServerIdFromName`, `extractVariables`, `serverVariables`, `expandVariables`), `SH/util/command-template.ts`
  (`COMMAND_TEMPLATE_LIMITS`, `CommandTemplatePart`, `CommandTemplatePlan`, `planCommandExpansion`, `ShellSpanResult`,
  `FileBlock`, `formatShellSpanOutput`, `RenderedCommand`, `renderCommandExpansion`), `SH/util/output-styles.ts`
  (`DEFAULT_OUTPUT_STYLE`, `BUILTIN_OUTPUT_STYLE_NAMES`, `BUILTIN_OUTPUT_STYLES`, `OUTPUT_STYLE_HEADER`,
  `isBuiltinOutputStyle`, `effectiveStyleName`, `outputStyleBlock`) and their five exports in `SH/index.ts`: the names
  and signatures are final, the bodies throw until C35 implements them. The util files never import `limits.ts` /
  `enums.ts` (the Phase 10 import cycle); `LIMITS` mirrors their limit constants (C34 pins the mirror). Open point 1:
  `'style'` in `CUSTOMIZATION_KINDS` and `'output-style'` in `CLIENT_COMMANDS`.
- **K3 seed (background, agent K3S)** — the `.tmp/v16` build (`45e974c`) on :8898 with `HF_MOCK_PROVIDER=1
  HF_OFFLINE=1`, `HF_DATA_DIR=.tmp/gates/P11-0b/seed-data` and `HF_WORKSPACE_ROOTS=<repo>/.tmp/gates/P11-0b/seed-roots`
  (outside the data dir, so a copy keeps a valid project path), driven by `.tmp/gates/P11-0b/seed-v16.mjs` (derived from
  `.tmp/gates/P10-0b/seed-v15.mjs`), password `probe-pass-123`:
  - the full v1.5 seed set (a provider key, the disabled MCP server `probe-http` with a header secret, a branched chat
    with a share link, an attachment + an orphan, an image, the three pending approvals (tool, shell, plan), a git
    project with checkpoints and one rewind batch, project and global rules, `fileSweep`, the long chat, the sub-agent /
    plan / todo / compact / steer chats, the settings, project instructions, the `AGENTS.md` import, the Phase 10
    definition files incl. the bad ones);
  - the Phase 10 state: personal agent, command and skill rows (one disabled); a `/greet Ada` turn (`metadata.command`
    with `source` and `modelRef`); a custom-agent task turn and a `skill release-notes` turn; `background_tasks` rows
    (one delivered through a `task` carrier with `data-task-result`, one stopped); `planFiles` on + an approved plan
    file (journaled); `/remember` to `AGENTS.md` and to the global instructions; `agent-pack` installed if available;
  - project files v1.6 ignores and v1.7 must discover (and must **not** run before approval): `.mcp.json` with
    `local-echo` (stdio `node tools/mcp-min.mjs`, env `TOKEN=${MCP_TOKEN}`), `remote` (http
    `http://127.0.0.1:${MCP_PORT:-9}/mcp`, header `Authorization: Bearer ${MCP_TOKEN}`), `events` (sse), `probe-http`
    (shadows the global id), `My_Server.v2` (id mapping) and one invalid entry; `tools/mcp-min.mjs` (a dependency-free
    stdio MCP server: initialize, `tools/list`, `tools/call echo`; writes `.mcp-started-<pid>` on start);
    `.claude/settings.json` with PreToolUse `Bash|Write` → `sh .claude/hooks/guard.sh` (exit 2 on `secret`),
    PostToolUse `*` → `sh .claude/hooks/log.sh` (appends stdin to `.hook-log/`), UserPromptSubmit (context) and Stop
    (blocks once through a marker file), plus ignored `permissions` / `env` keys; `.claude/settings.local.json` with
    SessionStart; `.harness/settings.json` with PreCompact, Notification and SubagentStop; a second project `untrusted`
    (invalid JSON settings, an oversized `.harness/settings.json`, a linked `.mcp.json → /etc/hosts`, a hook whose
    script writes a sentinel that must never appear at boot or upgrade); output styles `.claude/output-styles/terse.md`
    and `.harness/output-styles/terse.md` (the `.harness` one wins), `broken.md`, `explanatory.md` (a builtin name),
    `plain.md` (`keep-coding-instructions: false`); commands `.claude/commands/status.md` (`` !`git status --short` ``,
    `@README.md`, `$ARGUMENTS`; v1.6 runs `/status` once and stores a literal expansion) and `leak.md`
    (`@../outside.md`, `@.env`); skills `deploy/SKILL.md` (`user-invocable: true`, `argument-hint: [env]`) and
    `internal/SKILL.md` (`disable-model-invocation: true`); an enabled global stdio MCP server `node
    <seed-roots>/_tools/mcp-min.mjs` (probes repoint it by SQL);
  - stop the server by port → copy to `.tmp/upgrade-v16/{data,roots}` and the ids (chats, share token, projects,
    pending approvals, message / `workspace_changes` / `customizations` / `background_tasks` counts, the stored
    `/status` expansion, the sentinel paths) to `.tmp/upgrade-v16-ids.json` (never `.tmp/e2e`, which the gates
    migrate). No SQL plants: `0008` only creates tables and adds a nullable column. **Probes never write into
    `seed-roots`**: a probe copies the roots and points `projects.path` (and the global stdio server's path) at the
    copy by SQL before boot. Every later upgrade probe runs on a fresh copy of `.tmp/upgrade-v16`.
- Ownership file `.tmp/waves/P11-0a.json` (below).

### C34 contracts (k2)

- **Mission.** Write every shared contract of Phase 11, the plugin SDK 1.5.0, the eleven new routes as 501 stubs and
  `docs/API.md`, keeping `pnpm check` green (with the compile fixes the `style` kind and the `output-style` command
  need).
- **Owned.** `SH/**` (not the C35 files), `SDK/**`, `S/plugins/templates/{sdk-types,templates.test}.ts`, `docs/API.md`,
  `S/app.ts`, `S/http/routes/{hooks,project-trust,project-mcp}.ts` (new 501 stubs), `S/testing/api-samples.ts`,
  `S/http/routes-mounted.test.ts`, the route-table-driven security tests (`S/http/middleware/{session-auth,fresh-auth}
  .test.ts`, `S/security/{fresh-auth-routes,secret-leaks,request-guards}.test.ts`), `W/utils/testing/fixtures.ts`, and
  every fixture, count pin or compile fix the new required fields need (listed in the report; the coordinator accepts
  them in the audit as `C34-compile-fixes`; expected: the web kind maps of `W/components/settings/customize/
  {customize.ts,CustomizeSettings.vue,CustomizationEditor.vue,CustomizationViewer.vue,CustomizationRow.vue}`,
  `W/pages/settings/customize.vue` (the "New {kind}" label), `CLIENT_COMMAND_DESCRIPTIONS` in
  `W/components/chat/composer/slash-commands.ts`, the server kind switches of `S/services/customizations/{discover,
  entries,snapshot,plugins,index}.ts` (style entries ignored until W11.6), `S/plugins/context.ts`
  (`ctx.outputStyles.register` throws `not_implemented` until W11.7), the projects service (`outputStyle: null`, open
  point 4), and the count pins of `SH/schemas/{dto,customizations,agent}.test.ts`, `SH/api/routes.test.ts`).
- **Read-only highlights.** `.tmp/p11-designs/**` (the plan's Reconciliation table, Totals and section 6 and `README.md`
  are binding; `server.md` B is the detailed contract), `docs/DECISIONS.md`, the coordinator's skeletons (C35
  implements them), `SH/api/routes.test.ts` and `contract.test.ts` (doc-coupled: API.md section 8 and the DECISIONS
  module table), `SH/schemas/dto.test.ts` (the settings key count `:132`, the event count `:779`),
  `SH/schemas/customizations.test.ts` (`:106-120`), `SH/schemas/agent.test.ts` (`:55`, `:199`), `SH/isomorphic.test.ts`
  (exported value names), `SDK/exports.test.ts`.
- **Tasks.**
  1. **C34-T1 Ids, enums, limits** — `SH/ids.ts`: `hok_` / `hev_` patterns, schemas and generators; `slashNameSchema`
     (`AGENT_NAME_PATTERN`, ≤ 64; commands keep `commandNameSchema` ≤ 32); `CLIENT_COMMANDS` + `output-style` (open
     point 1; a plugin `/output-style` is then refused: a release note). `SH/enums.ts`: `hookEventSchema` (built on
     `HOOK_EVENTS`), `hookSourceSchema` (`HOOK_SOURCES`), `hookStateSchema` (`active | pending | off | invalid |
     blocked`), `hookOutcomeSchema` (`context | denied | asked | allowed | rewritten | blocked | continued | stopped |
     error`), `trustItemKindSchema` (`TRUST_ITEM_KINDS`), `trustStateSchema` (`approved | pending`),
     `projectMcpStateSchema` (`pending | needs-variables | idle | connecting | connected | error | disabled`),
     `runOriginSchema` + `hook`, `activityKindSchema` + `hooks` (`activityDataSchema` + `event?`, `toolCallId?`),
     `invocationKindSchema` (`command | skill`). `SH/errors.ts`: conflict reasons + `hook-blocked`, `untrusted` (14;
     the doc comment explains both). `LIMITS` Phase 11 group: `hookTimeoutDefaultMs` 60 000, `hookTimeoutMaxMs`
     600 000, `hooksPerEventMax` 20, `personalHooksMax` 100, `hookProcessesMax` 16, `hookPayloadBytes` 262 144,
     `hookStdoutBytes` 65 536, `hookStderrBytes` 16 384, `hookContextMaxChars` 10 000, `hookReasonMaxChars` 2000,
     `hookUpdatedInputBytes` 65 536, `hookContinuationsMax` 5, `subagentStopContinuationsMax` 2, `hookRunsKept` 200,
     `projectSettingsFileBytes` 262 144, `projectHookItemsMax` 100, `projectMcpServersMax` 20,
     `projectMcpVariablesMax` 50, `projectMcpConnectWaitMs` 5000, `projectMcpIdleMs` 600 000, `trustItemsMax` 200,
     `trustRefFilesMax` 8, `trustRefFileBytes` 1 048 576, `commandShellSpansMax` 10, `commandShellTimeoutMs` 30 000,
     `commandShellTotalMs` 60 000, `commandShellOutputBytes` 16 384, `commandFileRefsMax` 10, `commandFileRefBytes`
     32 768. *Accept:* `ids.test.ts` (client and harness commands disjoint, `output-style` a client command, the
     generators match their patterns); enum and limit tests; a test pins every `LIMITS` value mirrored by `HOOK_LIMITS`,
     `TRUST_LIMITS`, `MCP_CONFIG_LIMITS` and `COMMAND_TEMPLATE_LIMITS`.
  2. **C34-T2 Hooks (`SH/schemas/hooks.ts`, new)** — the personal hook DTO (`{ id, event, matcher: string | null ≤ 200,
     command 1 – 4096, timeout: int 1 – 600 (seconds) | null, enabled, createdAt, updatedAt }`); `hookCreateSchema`
     (strict, the same fields without id and timestamps) and `hookUpdateSchema` (strict, partial, at least one key); the
     matcher refined with `compileMatcher` (an invalid matcher → a validation issue on `['matcher']`); the listing entry
     (`{ key, source, kind: 'command' | 'code', event, matcher, command?, timeout, state, id?, pluginId?, path?,
     sha256?, diagnostics }`); the list (`{ items ≤ 300, diagnostics, switches: { setting, shell, safeMode } }`) and its
     query (`{ projectId? }`); the run-log entry (`{ id, at, event, source, label, chatId?, exitCode | null, timedOut,
     durationMs, outcome, error? ≤ 500 }`) and the runs answer (`{ items }`). *Accept:* samples; a regex-looking matcher
     refused; a 4097-character command refused; an unknown key refused.
  3. **C34-T3 The `data-hook` part, notices, chat request (`SH/chat.ts`)** — `hookDataSchema` (`{ id: hev_…, event,
     outcome, toolCallId?, toolName?, createdAt, hooks: [{ source, label ≤ 200, pluginId?, exitCode | null, timedOut?,
     durationMs, error? ≤ 2000, systemMessage? ≤ 2000 }] ≤ 20, context? ≤ 10 000, reason? ≤ 2000, updatedInput? (JSON
     ≤ 64 KiB) }`); `harnessDataSchemas.hook` / `HarnessDataTypes` (6 data part types); notice codes +
     `output-style-unavailable`, `hook-continuation-limit`, `project-mcp-unavailable` (11);
     `commandInvocationSchema.name: slashNameSchema` + `kind?: invocationKind`, `inlined?: { shell: int ≤ 10, files:
     string[] ≤ 10 }`; `commandSummarySchema.name: slashNameSchema` + `kind?`; `chatRequestBodySchema.outputStyle?:
     agentName | null` (saved when the request creates the chat). *Accept:* a v1.6 message (every Phase 9 / 10 part,
     a `task` carrier) and a v1.6 invocation parse; a hook carrier user message with only `data-hook` parts validates
     through `harnessDataSchemas`.
  4. **C34-T4 Trust and project MCP (`SH/schemas/project-trust.ts`, new)** — the trust item (`{ kind, sha256 (hex 64),
     state, label ≤ 200, path, refs: [{ path, sha256 | null }] ≤ 8, warnings: ('private-network' |
     'referenced-file-missing' | 'runs-repository-code')[], detail }`, `detail` discriminated by kind: hook `{ event,
     matcher, command, timeout }`, mcp `{ name, id, transport, command?, args?, url?, envNames, headerNames,
     variables }`, command `{ name, spans: string[] ≤ 10 }`; open point 12: an optional `changed`); the list (`{ items ≤
     200, orphaned: int, scannedAt, available, issue? }`); the approve body (strict `{ items: [{ kind, sha256 }] 1 – 50
     }`); the revoke params (`{ id, sha256 }`); the project MCP server (`{ id, name, transport, state, sha256, error?:
     HarnessErrorInit, tools: string[] ≤ 1000, shadows?: string, missingVariables: string[] }`); the MCP list (`{ items,
     variables: [{ name, set, hint | null, usedBy: string[] }] }`); the variables body (strict `{ values: record(name
     per `MCP_VARIABLE_NAME_PATTERN`, string 1 – 4096 | null) }`, ≤ 50 keys); the reconnect params (`{ id, serverId }`).
     *Accept:* samples; 51 approve items refused; a lowercase-hex check on `sha256`.
  5. **C34-T5 Settings, chats, projects, customizations** — `outputStyle` (`agentNameSchema`, default `'default'`) and
     `hooksEnabled` (default `true`) → `SETTINGS_KEYS` 30, neither needs fresh auth; `chatSettingsSchema` +
     `outputStyle` (nullable in the update); `projectSummarySchema` + `outputStyle: string | null`,
     `projectUpdateSchema` + `outputStyle?` (nullable); the customization entry + `label?`, `keepCodingInstructions?`,
     `userInvocable?`, `modelInvocable?`; `customizationProjectScanSchema.folders.max(8)`; the `style` member of the
     customization field schemas and of the user customization union; the backup item cap scaled for four kinds.
     *Accept:* a v1.6 settings document parses with the defaults; `dto.test.ts` at 30; a v1.6 chat detail and project
     summary parse.
  6. **C34-T6 Events** — `SERVER_EVENT_TYPES` + `hooks.changed` (`{ projectId: string | null }`),
     `project-trust.changed` (`{ projectId, pending: int }`), `project-mcp.changed` (`{ projectId, servers }`) (18).
     *Accept:* a v1.6 `run.started` parses; the event count pin 18; `run.started.origin: 'hook'` parses.
  7. **C34-T7 Plugin SDK 1.5.0 and manifests** — `PLUGIN_API_VERSION` `'1.5.0'`; `HookEventName`, `CommandHookSpec`
     (`{ type: 'command', command, timeout? }`), `HookMatcherGroup`, `HooksConfig`, `OutputStyleDefinition { name,
     description, content ≤ 64 KiB, keepCodingInstructions? }`, `PluginContext.outputStyles.register(definition):
     Disposable`, the `HookMap` additions (`prompt.submit` → `{ block?, context? }`, `session.start` → `{ context? }`,
     `run.stop` → `{ continue? }`, `subagent.stop` → `{ continue? }`, `compact.before`, `notification`; `tool.after`
     output `context?`; each with `HookChatContext` + the event fields of server.md B); the manifest
     `contributes.hooks` (Claude format, ≤ 50 handlers) and `contributes.outputStyles` (≤ 20, reserved builtin names
     refused); `manifestRequiresTrust` also true with non-empty `contributes.hooks` or a `!` span in a command template;
     contributions `hooks: number`, `outputStyles: string[]`; a declarative command named `output-style` refused; the
     template mirror `S/plugins/templates/sdk-types.ts` follows (`templates.test.ts`); `exports.test.ts` pins.
     *Accept:* SDK tests; `^1.4.0` manifests still parse and builtin manifests with `engines ^1.4.0` still load.
  8. **C34-T8 Route table** — `ApiModule` += `hooks`, `projectTrust`, `projectMcp`; the eleven keys of "Totals";
     `fresh: true` on `hooks.create`, `projectTrust.approve`, `projectMcp.setVariables` (`hooks.update` is a
     server-enforced conditional case, open point 2); `hooks.create` 201, `hooks.remove` and `projectTrust.revoke` 204 →
     **120** routes, 33 modules. *Accept:* `routes.test.ts` (API.md section 8 index + the DECISIONS module table) and
     `contract.test.ts` at 120.
  9. **C34-T9 `docs/API.md`** — the `LIMITS` rows; settings (30); notice codes (11); conflict reasons (14); the new
     schema sections (4.x: hooks, the `data-hook` part, project trust, project MCP; the customization `style` kind and
     the skill keys); the three modules (5.x) with every answer (hooks: 200, 201, 204, 400 with the matcher issue, 403
     without fresh auth, 404 unknown id / project, 409 at the 100-row cap (C34 fixes the answer); trust: 200, 204, 400,
     403, 404, 409 `stale`; project MCP: 200, 400, 403, 404, 409 `disabled` in safe mode (C34 fixes it)); `GET
     /commands?projectId` (skills with `kind`, 64-character names); the stream additions (6.x: `data-hook` placements,
     the hook carrier, `run.started.origin: 'hook'`, `data-activity` kind `hooks`, `metadata.command.kind` /
     `.inlined`, the request field `outputStyle`, 409 `hook-blocked` / `untrusted` before streaming, the three
     notices); the events; the 120-route index in the parsed format.
  10. **C34-T10 Stubs and compile fixes** — `S/app.ts` mounts `hooks`, `projectTrust` and `projectMcp`; the eleven
      routes validate first (400) and answer `501 not_implemented`; `api-samples.ts`; the route-table security tests
      follow (the conditional `hooks.update` included); `W/utils/testing/fixtures.ts` and every other fixture get the
      two settings keys, `outputStyle` on chats / projects and the new DTO fixtures; `C34-compile-fixes` (see Owned).
      *Accept:* `routes-mounted.test.ts` green (no new route answers 404); `pnpm check` green; v1.6 messages, settings,
      chat details and `^1.4.0` manifests still parse.
- **Tests.** Schema tests for every new DTO; route-table tests; the updated route-driven security tests.
- **Verify.** Shared, plugin SDK, server and web commands.

### C35 shared helpers (k3)

- **Mission.** The shared helpers that read hook configurations, match tools, build payloads, read hook outputs,
  canonicalize trust items, parse `.mcp.json`, plan and render command extras, define the builtin output styles, add the
  `style` kind and the skill keys to the definition parser and split hook parts out of a message path — complete and
  tested (frozen after Gate P11-0b; used by C36 – C39, W11.1 – W11.8, W11.10, W11.12).
- **Owned.** `SH/util/{hooks,trust,mcp-config,command-template,output-styles}{,.test}.ts` (implementing the
  coordinator's skeletons: the exported names and signatures stay; an addition is listed in the report),
  `SH/util/definitions{,.test}.ts` (kind `style`, skill keys; every C29 export and test unchanged) and
  `SH/util/agent-state{,.test}.ts` (the hook additions only; every C23 / C29 export and test unchanged).
- **Read-only highlights.** ADR-048 … ADR-052; the plan's Reconciliation table and sections 1 – 5; `server.md` C;
  `SH/util/{tool-names,shell-command,mentions,arguments}.ts` (`CLAUDE_TOOL_ALIASES`, `parseShellCommand`, the mention
  grammar, `expandArguments`); `SH/schemas/{hooks,project-trust,chat}.ts` (C34); real Claude Code settings files
  (`hooks` examples from Claude Code's documentation, written into the tests as fixtures).
- **Tasks.**
  1. **C35-T1 `SH/util/hooks.ts`** — `readHooksConfig(value, { source, file? })` (the Claude format; `prompt` hooks →
     `unsupported-type` and skipped; unknown events → `unknown-event` (info); `invalid-matcher` (error, the handler
     never runs); `invalid-command` / `invalid-timeout`; ≤ `HOOK_LIMITS.itemsMax` handlers (`too-many`); `too-long`);
     `readSettingsHooks(text, { file, maxBytes })` (the byte cap before `JSON.parse`; only the `hooks` key:
     `permissions`, `env` and every other key ignored); `compileMatcher` (the safe subset of the module comment; never a
     `RegExp` from input); `hookTargetNames(tool, { mcpServerName? })` (the harness name, the reversed
     `CLAUDE_TOOL_ALIASES` — `shell` → `Bash`, `edit_file` → `Edit` and `MultiEdit`, … — and
     `mcp__<claudeName>__<tool>`); `claudeToolName`; `hookPermissionMode` (`ask` / `off` → `default`, `plan` → `plan`,
     `edits` → `acceptEdits`, `auto` → `bypassPermissions`); `buildHookPayload(event, input, { maxBytes })` (the Claude
     fields `session_id` (chat id), `cwd`, `hook_event_name`, `permission_mode`, `tool_name` (the Claude alias when one
     exists), `tool_input`, `tool_use_id`, `tool_response`, `prompt`, `stop_hook_active`, `trigger`,
     `custom_instructions`, `source`, `message`, `notification_type`, only those that apply to the event, + `harness: {
     version: 1, chatId, projectId, messageId?, modelRef, origin, tool?, source }`; `tool_response`, then `tool_input`
     cut to fit; no `transcript_path`); `readHookOutput(event, result)` (exit 0 → a JSON object on stdout decides, else
     plain stdout is context for UserPromptSubmit / SessionStart; exit 2 → blocked with stderr as the reason; any other
     exit or a timeout → a non-blocking error; the recognized fields of the module comment, each event honoring only its
     own; `decision: approve` = allow (legacy); `hookEventName` must match); `combineHookOutcomes(event, outcomes)`
     (deny > ask > allow; the first `updatedInput` in source order personal → plugin → project, a conflict adds a
     diagnostic; contexts and reasons joined and capped; `continue` = AND). *Accept:* matcher tables (`Edit|Write`,
     `mcp__memory__.*`, `Notebook*`, `*`, empty, `^Bash` invalid, `Bash(git:*)` invalid, case sensitivity); alias
     tables; an output-reader table per event × exit code × JSON field; the combination order; payload truncation at
     exactly the cap; real Claude Code settings files (with `permissions` / `env` ignored).
  2. **C35-T2 `SH/util/trust.ts`** — `canonicalJson` (keys sorted recursively, no whitespace); `trustHashInput(item)` (a
     JSON array `[kind, 1, …fields, refs]`, refs sorted by path: hook = event, matcher, command, timeout; mcp = name and
     the raw unexpanded server object; command = name and the span list); `extractCommandFileRefs(command)` (the tokens
     of `parseShellCommand`, else a whitespace split; `$CLAUDE_PROJECT_DIR/…`, `${CLAUDE_PROJECT_DIR}/…`,
     `"$HARNESS_PROJECT_DIR"/…`, `./…`, `.claude/…`, `.harness/…`, or a relative path with `/` and a script extension;
     normalized, never with `..`; ≤ 8). *Accept:* stability under key order and whitespace (a reformatted settings file
     keeps every hash); a changed command, matcher, timeout, ref hash or ref path changes the input; ref extraction
     tables (quoted, `${…}`, `..` refused, URLs ignored).
  3. **C35-T3 `SH/util/mcp-config.ts`** — `parseMcpJson(text, { maxBytes })` (the byte cap before `JSON.parse`;
     `mcpServers` required; type inferred (`command` → stdio, else `type ?? 'http'`); `http:` / `https:` URLs only; the
     caps of `MCP_CONFIG_LIMITS`; ids through `mcpServerIdFromName` with the taken set; `raw` kept for the hash; every
     problem a diagnostic); `mcpServerIdFromName` (lowercase, `[\s_.]` → `-`, other characters dropped, ≤ 32, `server`
     when empty, `-2` … on collisions); `extractVariables` / `serverVariables` (`${VAR}` and `${VAR:-default}` in
     command, args, env values, url and header values; names per `MCP_VARIABLE_NAME_PATTERN`); `expandVariables` (values
     only, never `process.env`; any other `$…` literal; `$$` literal). *Accept:* `.mcp.json` samples (Claude Code's
     documented shapes, `My_Server.v2` → `my-server-v2`, collisions, an invalid entry beside valid ones, a `file:` URL
     refused); variable tables (default, missing, nested, `$$`).
  4. **C35-T4 `SH/util/command-template.ts`** — `planCommandExpansion(body)` (a span is `` !`cmd` `` on one line with a
     non-empty command and no backtick inside; `@path` per the `mentions.ts` grammar holding a `.` or `/`, never inside
     a span, never an e-mail; spans inside code fences stay text (C35 decides and documents); ≤ 10 spans and ≤ 10 paths
     (later ones stay text, with a diagnostic)); `formatShellSpanOutput` (the output, plus a short note for a non-zero
     exit, a timeout or `[skipped: time limit]`); `renderCommandExpansion(plan, results, input)` (span outputs in place,
     `<file path="…">…</file>` blocks appended for the files that were read, `expandArguments` on the text parts only,
     the append-input rule when no placeholder was used). *Accept:* tables (spans in code fences, `@` in e-mails, the
     arguments `x ; touch pwned` never inside a span, a binary file marker, a missing file kept as text).
  5. **C35-T5 `SH/util/output-styles.ts`** — the `explanatory` and `learning` texts (Claude-like,
     `keepCodingInstructions: true`; `default` empty); `isBuiltinOutputStyle`; `effectiveStyleName(chat, project,
     global)` (empty strings unset; `default` last); `outputStyleBlock` (`Output style: <label>` + body; null for an
     empty body). *Accept:* tables.
  6. **C35-T6 `SH/util/definitions.ts` additions** — kind `style` (folder `output-styles`, top-level `*.md`; keys
     `name`, `description`, `keep-coding-instructions` (default false); names slugified (lowercase, spaces → `-`) with
     the original kept as `label`; builtin style names `reserved-name`); skill keys `user-invocable` (default true),
     `disable-model-invocation` (default false), `argument-hint`; `formatDefinition` handles `style` and the new skill
     keys; `definitionRank` / `resolvePrecedence` cover the fourth kind (kinds never shadow each other). *Accept:* table
     tests per new key; round trips; the Phase 10 test `definitions.test.ts:350` (`disable-model-invocation` ignored)
     updated to the new meaning (reported).
  7. **C35-T7 `SH/util/agent-state.ts` additions** — `HOOK_PART_TYPE` (`data-hook`); `hookModelText(data, role)`
     (assistant: `<hook-context event="…" tool="…">context</hook-context>` when `context` is set, a block reason as
     feedback text; carrier: `<hook-feedback event="Stop">reason</hook-feedback>`; else null; attribute values escaped);
     `splitHooks(messages)` (assistant messages split at model-text hook parts like `splitTaskResults`, split ids
     `~h<k>`; display-only hook parts dropped, then empty halves; in user messages hook parts become text parts or are
     dropped; a carrier without model text is dropped; no two user messages merged); `isHookCarrier`;
     `hookChainLength(path)` (consecutive hook carriers since the last user-authored message; task carriers do not
     reset it); `sessionStartSource(path)` (`startup` when the path before the new message is empty; `compact` when the
     newest compaction marker is newer than the newest SessionStart record; else null). *Accept:* tables (a carrier, a
     steer boundary, a task result and a hook at one boundary, a v1.6 history returned unchanged); every C23 / C29 test
     unchanged and green.
  8. **C35-T8 Fuzz** — a seeded generator: `readHooksConfig` / `readSettingsHooks`, `compileMatcher`,
     `parseMcpJson`, `planCommandExpansion`, `buildHookPayload`, `readHookOutput` never throw on random bytes, deep
     nesting and huge strings, apply the caps first and stay fast; no `RegExp` is built from input (a spy on the
     `RegExp` constructor); `trustHashInput` is stable under key order; `splitHooks` never produces an invalid history.
- **Tests.** The tasks above (`hooks.test.ts`, `trust.test.ts`, `mcp-config.test.ts`, `command-template.test.ts`,
  `output-styles.test.ts`, `definitions.test.ts`, `agent-state.test.ts`).
- **Verify.** `pnpm -F @harness-forge/shared test`; `pnpm check:english`; eslint on the fourteen files.

### D14 phase doc (k1)

- **Mission.** Write this file so P11-0b, P11-A and P11-B agents can build against it.
- **Owned.** `docs/phases/phase-11-v1-7.md` (new).
- **Tasks.**
  1. **D14-T1 Phase doc** — goal, totals, criteria, the binding deviations and open points, the rules for every agent,
     the FREEZE list, every wave with owned globs, tasks with acceptance criteria, ownership JSON, cross-agent
     contracts, gates and probes, risks; contradictions between the plan, DECISIONS.md, the skeletons and the reports
     listed in the report (the plan's version written here).
- **Verify.** `pnpm check:english`.

### D15 docs (no server)

- **Mission.** Update the user-facing and architecture docs for Phase 11 so P11-0b and P11-A agents can build against
  them.
- **Owned.** `docs/UI.md`, `docs/ARCHITECTURE.md`, `docs/PLUGINS.md`, `docs/PROVIDERS.md`, `docs/guides/**`,
  `README.md`, `.env.example`.
- **Tasks.**
  1. **D15-T1 UI.md** — the new 2.18 wireframes (the Hooks tab, the hook editor and the import dialog, the Output styles
     tab and the style editor, the trust dialog, the project MCP dialog, the composer style picker, the composer
     refusal, the hook notes and tool badges, the hook carrier turn; desktop and 390 px; web.md C); 5.6 the main header
     (the trust chip); 7.8 the slash menu (the Skills group, 64-character names, `/output-style`); 7.28 (`!` / `@` in
     the command badge, skill invocations); new 7.31 hooks in the chat, 7.32 output styles in the composer, 7.33 project
     trust and project MCP; 8.4 (the trust warning lists hook commands); 8.8 (the plugin Hooks and Output styles
     sections); 9.4 General (Output style); 9.10 Projects (the row menu items and the "{n} to review" badge); 9.13
     Customize: Output styles and Hooks; 10.8 contracts (props / emits / exposes of every P11-0b stub, see "C39 web
     skeleton"); 11.8 modules (the three stores, `HOOK_ACTIVITY`, the `CHAT_VIEW_ACTIONS` additions, the pure modules,
     the `useChatSession` additions); 12 shortcuts (Mod+Enter in the hook editor and the import dialog; Esc never
     dismisses the refusal or approves anything); 13.12 test ids (~75; the list in "C39 web skeleton" below,
     reconciled); 14 accessibility (the trust dialog focus and "no default Approve", `HookNote` `role="note"`, the
     refusal `role="alert"`, 40 px targets); 15 copy (web.md E, reconciled).
  2. **D15-T2 ARCHITECTURE.md** — the stop order (data → runs → hooks → projectMcp → customizations → projectConfig →
     …); the backups (personal styles yes; hooks, approvals and variables never; commands with spans restored off); new
     flow sections: hooks (sources, snapshot, runner, the eight events and where they fire, the Stop turn, kill
     switches), project trust (config reader, hash input + referenced files, verify-before-run, approve / revoke),
     project MCP (variables, lazy runtimes, shadowing, stop paths), output styles (catalog kind, effective style,
     instruction order) and command extras (`!` / `@`, trust, frozen expansion, skills in `/`); the data model (`0008`,
     the two tables and the column); the Phase 11 security section (untrusted repository content, hash pinning, no
     `process.env`, the spawn allowlist, process groups, kill switches, private-network warning); the log rules (no
     payloads, outputs, commands, `!` output, `@file` contents or variable values at `info`); `<dataDir>/hooks`.
  3. **D15-T3 PLUGINS.md** — API 1.5.0 (the version table row, `contributes.hooks` (and the trust pin), a `!` span in a
     command template needs trust too, `contributes.outputStyles`, `ctx.outputStyles.register`, the new code hook events
     and `tool.after` output `context?`, the reserved client command `output-style`, plugin scripts unpinned).
     *Accept:* `manifest.test.ts` and `examples.test.ts` still parse PLUGINS.md.
  4. **D15-T4 PROVIDERS.md 8 ("Hook mocks (Phase 11)")** — `mock:hooks` exactly as in "C38 processes, mocks and
     fixtures" below (it is the probe contract).
  5. **D15-T5 Guides** — `docs/guides/hooks-and-project-mcp.md` (the format, the eight events and their payloads, exit
     codes and JSON output, matchers and aliases, sources and precedence, trust and re-approval, project `.mcp.json` and
     variables, kill switches, differences from Claude Code: the narrower `allow`, no `prompt` hooks, no
     `transcript_path`, the safe matcher subset, `HARNESS_*` variables) and `docs/guides/output-styles.md` (builtins,
     files, `keep-coding-instructions`, selection chat > project > global, `/output-style`).
  6. **D15-T6 README and `.env.example`** — features, the status "v1.7 in progress"; `.env.example` gains no variable
     (the `HF_SAFE_MODE` / `HF_WORKSPACE_SHELL` comments mention hooks and project MCP).
- **Verify.** `pnpm check:english`; `pnpm -F @harness-forge/shared test` (doc-coupled tests).

### Wave P11-0a ownership

The audit cannot express "except": the C35 files and the coordinator's skeletons match C34's `packages/shared/src/**`
glob too (a warning; C35 owns its files, the skeletons were the coordinator's before the launch). C34 and C35 list the
extra fixture and compile-fix files they had to touch in their reports; the coordinator adds them to
`C34-compile-fixes` / `C35-compile-fixes`. K2 changes nothing; K3S writes only below `.tmp/` (allowed). This is
`.tmp/waves/P11-0a.json`:

```json
{
  "wave": "P11-0a",
  "agents": {
    "K1": [
      "AGENT.md",
      "docs/DECISIONS.md",
      "docs/ROADMAP.md"
    ],
    "K2": [],
    "coordinator-skeletons": [
      "packages/shared/src/util/hooks.ts",
      "packages/shared/src/util/trust.ts",
      "packages/shared/src/util/mcp-config.ts",
      "packages/shared/src/util/command-template.ts",
      "packages/shared/src/util/output-styles.ts",
      "packages/shared/src/index.ts"
    ],
    "K3S": [],
    "C34": [
      "packages/shared/src/**",
      "packages/plugin-sdk/src/**",
      "apps/server/src/plugins/templates/sdk-types.ts",
      "apps/server/src/plugins/templates/templates.test.ts",
      "docs/API.md",
      "apps/server/src/app.ts",
      "apps/server/src/http/routes/hooks.ts",
      "apps/server/src/http/routes/project-trust.ts",
      "apps/server/src/http/routes/project-mcp.ts",
      "apps/server/src/testing/api-samples.ts",
      "apps/server/src/http/routes-mounted.test.ts",
      "apps/server/src/http/middleware/session-auth.test.ts",
      "apps/server/src/http/middleware/fresh-auth.test.ts",
      "apps/server/src/security/fresh-auth-routes.test.ts",
      "apps/server/src/security/secret-leaks.test.ts",
      "apps/server/src/security/request-guards.test.ts",
      "apps/web/app/utils/testing/fixtures.ts"
    ],
    "C35": [
      "packages/shared/src/util/{hooks,trust,mcp-config,command-template,output-styles,definitions,agent-state}.ts",
      "packages/shared/src/util/{hooks,trust,mcp-config,command-template,output-styles,definitions,agent-state}.test.ts"
    ],
    "D14": [
      "docs/phases/phase-11-v1-7.md"
    ],
    "D15": [
      "docs/UI.md",
      "docs/ARCHITECTURE.md",
      "docs/PLUGINS.md",
      "docs/PROVIDERS.md",
      "docs/guides/**",
      "README.md",
      ".env.example"
    ],
    "C34-compile-fixes": [],
    "C35-compile-fixes": [],
    "coordinator-fixes": [
      "examples/plugins/*/harness-forge.d.ts"
    ]
  },
  "allow": [
    ".tmp/**"
  ]
}
```

### Wave P11-0a cross-agent contracts

| Producer → consumer | Contract |
|---|---|
| coordinator (skeletons) → C34, C35 | the exported names and signatures of `SH/util/{hooks,trust,mcp-config,command-template,output-styles}.ts` (+ the two enum entries of open point 1) |
| C34 → C35, C36 – C39, every P11-A agent | the DTOs, enums, limits, route keys, events, settings, the `data-hook` schema, the trust / project MCP / hook schemas, the notices, conflict reasons, `slashNameSchema`; the plugin SDK 1.5.0 (`HooksConfig`, `OutputStyleDefinition`, `ctx.outputStyles`, the `HookMap` events, `contributes.hooks` / `.outputStyles`, `manifestRequiresTrust`) |
| C35 → C36 – C39, W11.1 – W11.8, W11.10, W11.12 | `readHooksConfig`, `readSettingsHooks`, `compileMatcher`, `hookTargetNames`, `claudeToolName`, `hookPermissionMode`, `buildHookPayload`, `readHookOutput`, `combineHookOutcomes`, `canonicalJson`, `trustHashInput`, `extractCommandFileRefs`, `parseMcpJson`, `mcpServerIdFromName`, `extractVariables`, `serverVariables`, `expandVariables`, `planCommandExpansion`, `formatShellSpanOutput`, `renderCommandExpansion`, `BUILTIN_OUTPUT_STYLES`, `effectiveStyleName`, `outputStyleBlock`, the `style` kind and skill keys, `HOOK_PART_TYPE`, `hookModelText`, `splitHooks`, `isHookCarrier`, `hookChainLength`, `sessionStartSource` (complete) |
| D14 → everyone | this file (owned globs, tasks, acceptance, gates) |
| D15 → C36 – C39, every P11-A agent | UI.md 2.18, 5.6, 7.8, 7.28, 7.31 – 7.33, 8.4, 8.8, 9.4, 9.10, 9.13, 10.8, 11.8, 12, 13.12, 14, 15; the ARCHITECTURE.md Phase 11 sections; PLUGINS.md 1.5.0; PROVIDERS.md 8 ("Hook mocks (Phase 11)"); the two guides |
| K3S → Gate P11-0b, Gate P11-A, the final gate | `.tmp/upgrade-v16/{data,roots}` + `.tmp/upgrade-v16-ids.json`, `.tmp/gates/P11-0b/seed-roots` (read-only for probes) |

### Gate P11-0a

1. `node scripts/audit-ownership.mjs .tmp/waves/P11-0a.json`
2. `pnpm install --frozen-lockfile`; `pnpm why typescript` (only 6.0.x); `pnpm why yaml` (one 2.9.x copy);
   `pnpm why @modelcontextprotocol/sdk` (root dev dependency only).
3. `pnpm check` → `pnpm build`: record the web `_nuxt` entry chunk size (gzip) against the `.tmp/v16` build of
   `45e974c` (more than 40 KB larger → W11.8 loads the hook editor / import pieces lazily).
4. `HF_TEST_REQUIRE_WEB_BUILD=1 pnpm -F @harness-forge/server exec vitest run src/http/static.test.ts`.
5. `mv .tmp/e2e .tmp/e2e-old-p11-0a` → `pnpm start:e2e` → `curl -sf http://127.0.0.1:8899/api/health` shows
   `"pluginApiVersion":"1.5.0"`; the eleven new routes are mounted (run with `bash -c`: zsh does not word-split `$r`):
   ```sh
   b=http://127.0.0.1:8899/api; p=prj_AAAAAAAAAAAAAAAA; h=hok_AAAAAAAAAAAAAAAA
   s=0000000000000000000000000000000000000000000000000000000000000000
   for r in "GET /hooks" "GET /hooks/runs" "POST /hooks" "PATCH /hooks/$h" "DELETE /hooks/$h" \
            "GET /projects/$p/trust" "POST /projects/$p/trust" "DELETE /projects/$p/trust/$s" \
            "GET /projects/$p/mcp" "PUT /projects/$p/mcp/variables" "POST /projects/$p/mcp/echo/reconnect"; do
     set -- $r; curl -s -o /dev/null -w "%{http_code} $1 $2\n" -X "$1" "$b$2"
   done   # 501, or 400 where validation runs before the stub (routes-mounted.test.ts covers the full matrix)
   ```
6. `pnpm test:e2e` → 156 passed (`chromium` + `mobile` + `tablet`).
7. `pnpm audit --prod --audit-level high` clean (the two ignored advisories excepted).
8. The coordinator fixes (`examples/plugins/*/harness-forge.d.ts` regenerated for 1.5.0); D14's open points decided;
   ROADMAP + wave log → commit `feat: add phase 11 contracts and docs`.

---

## Wave P11-0b — schema, migration `0008`, skeletons, FREEZE

**Entry:** Gate P11-0a green and the v1.6 seed in `.tmp/upgrade-v16`. The coordinator lands K3 first; C36, C37, C38 and
C39 start in one launch once the migration exists (C36's upgrade test needs it).

### Coordinator actions

- **K3 Schema and migration `0008`** —
  1. `S/db/schema.ts`: table `hooks` (`id` text primary key (`hok_`), `event` text not null, `matcher` text nullable,
     `command` text not null, `timeout` integer nullable (seconds), `enabled` integer boolean default true not null,
     `created_at`, `updated_at` integer not null); table `project_trust` (`project_id` text not null with a foreign key
     to `projects.id` ON DELETE CASCADE, `sha256` text not null, `kind` text not null, `label` text not null,
     `created_at` integer not null; primary key (`project_id`, `sha256`)); column `projects.output_style` (text,
     nullable, no default; null = the global setting); `TABLE_NAMES` 22; `UsagePurpose` unchanged; no index (the primary
     keys suffice).
  2. `pnpm db:generate --name hooks_trust` → `apps/server/drizzle/0008_hooks_trust.sql` + snapshot. Expected:
     ```sql
     CREATE TABLE `hooks` (`id` text PRIMARY KEY NOT NULL, `event` text NOT NULL, `matcher` text,
       `command` text NOT NULL, `timeout` integer, `enabled` integer DEFAULT true NOT NULL,
       `created_at` integer NOT NULL, `updated_at` integer NOT NULL);
     CREATE TABLE `project_trust` (`project_id` text NOT NULL, `sha256` text NOT NULL, `kind` text NOT NULL,
       `label` text NOT NULL, `created_at` integer NOT NULL, PRIMARY KEY(`project_id`, `sha256`),
       FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade);
     ALTER TABLE `projects` ADD `output_style` text;
     ```
  3. Inspect the SQL: exactly 2 `CREATE TABLE`, exactly 1 `ALTER TABLE \`projects\` ADD \`output_style\` text`, no
     index. **Reject** any `DROP`, `__new_`, `PRAGMA`, other `ALTER TABLE`, `DELETE` or `UPDATE` (the only `UPDATE`
     match allowed is the foreign key's `ON UPDATE no action`; foreign keys are on, and a table rebuild would cascade
     inside the migration transaction). A second `pnpm db:generate` reports no changes.
- **After C36, C37, C38, C39** — `nuxi prepare`; the gate below; the FREEZE additions.
- Ownership file `.tmp/waves/P11-0b.json` (below).

### C36 server skeleton (k3)

- **Mission.** Freeze the server side of Phase 11 outside the chat pipeline: the additive interfaces, the hooks,
  project-config, project-trust and project MCP service types with stubs whose signatures are final, the registry
  members, the secret scope, the start / stop order, the column classification, fakes and the database tests of `0008`.
- **Owned.** `S/types.ts`, `S/deps*.ts`, `S/env*.ts`, `S/main.ts`, `S/db/**` (not `schema.ts`), `S/chat/types.ts`,
  `S/services/{hooks,project-config,project-trust}/**` (types + stubs), the frozen edits
  `S/services/{secrets,projects,customizations}/types.ts`, `S/registry/{types,index,styles,hook-commands}*`,
  `S/mcp/types.ts` + the stub `S/mcp/project*` (open point 3), `S/services/data/references{,.test}.ts`, `S/testing/**`
  (not `api-samples.ts`, not `hook-scripts.ts`).
- **Read-only highlights.** `.tmp/p11-designs/plan.md` 1 – 4, 6, 8, `server.md` D1, D3, D4, D7; API.md (C34's hooks,
  trust and project MCP schemas); `SH/schemas/{hooks,project-trust}.ts`, `SH/util/{hooks,trust,mcp-config}.ts`;
  `apps/server/drizzle/0008_*.sql`; `S/services/customizations/{types,index}.ts` and `S/testing/fake-customizations.ts`
  (the Phase 10 stub precedent); `S/registry/{index,types,hooks}.ts`; `S/mcp/{index,types}.ts`;
  `S/services/secrets/types.ts:7` (the closed `SecretScope` union).
- **Tasks.**
  1. **C36-T1 Types (additive)** — `S/types.ts`: `AppServices.{hooks: HookService, projectConfig: ProjectConfigService,
     projectTrust: ProjectTrustService, projectMcp: ProjectMcpManager}`; `S/chat/types.ts`: the run origin `hook`, the
     `RunReleaseFollowUp` (`{ kind: 'hook', data: HookData }`) and whatever `ChatRunner` member the hook turn needs
     (C36 fixes the names with C37 and lists them); `S/registry/types.ts`: `Registry.styles` (list, get, owner,
     `onChange`; `OutputStyleDefinition` from the SDK) and `Registry.hookCommands` (per-plugin `HookSpec[]` with the
     plugin root; `onChange`), contributions `hooks: number`, `outputStyles: string[]`;
     `S/services/secrets/types.ts`: `SecretScope` + `` `project:${string}` ``; `S/services/projects/types.ts`:
     `outputStyle` in the summary and the update; `S/services/customizations/types.ts`: `CustomizationCatalog.styles()`
     / `style(name)`. *Accept:* `pnpm typecheck` green.
  2. **C36-T2 `S/services/hooks/types.ts` + stub (frozen after the gate)** — `HookService { snapshot(scope, { signal
     }?): Promise<HookSnapshot>, list(query): Promise<HookList>, create(body, options?: SensitiveOperationOptions),
     update(id, body, options?), remove(id), runs(limit?): HookRun[], invalidate(projectId | null): void, stop():
     Promise<void> }`; `HookScope` (chat id, project id, the open workspace or null, tool mode, origin, model ref);
     `HookSnapshot { has(event): boolean, run(event, input, { signal, target?, aliases? }): Promise<HookEventResult> }`;
     `HookEventResult { ran, decision | null, reason | null, context | null, updatedInput?, block, continue, stopReason
     | null, record: HookData | null }`; the stub `createHookService(deps)` with the final signature: `snapshot` → a
     snapshot whose `has()` is false and whose `run()` answers "nothing ran"; `list` → the personal list from the table
     plus `switches`; CRUD and `runs` throw `not_implemented` / answer `[]`; `invalidate` / `stop` no-ops. *Accept:*
     `deps.test.ts` "phase 11 skeleton".
  3. **C36-T3 `S/services/project-config/types.ts` + stub** — `ProjectConfigService { snapshot(projectId, { signal,
     refresh }?): Promise<ProjectConfigSnapshot>, invalidate(projectId | null), stop() }`; `ProjectConfigSnapshot` (the
     available flag / issue, the settings files read, the hook items and MCP servers with their `TrustRef`s and
     sha256, diagnostics, `scannedAt`) and the verify-before-run member (proposed `verify(projectId, item, signal):
     Promise<boolean>`, recomputing the referenced files; C36 fixes the name); the stub answers an empty snapshot.
     *Accept:* typecheck; a smoke test.
  4. **C36-T4 `S/services/project-trust/types.ts` + stub** — `ProjectTrustService { approved(projectId):
     Promise<ReadonlySet<string>>, list(projectId), approve(projectId, items, options?: SensitiveOperationOptions),
     revoke(projectId, sha256), pending(projectId): Promise<number> }`; the stub: `approved` → the table's rows (empty),
     `list` → no items, `approve` / `revoke` throw `not_implemented`. *Accept:* a smoke test per member.
  5. **C36-T5 `S/mcp/types.ts` + stub `S/mcp/project.ts`** — `ProjectMcpManager { toolsFor(projectId, { signal, waitMs
     }): Promise<{ tools: RegisteredTool[], shadowed: ReadonlySet<string>, unavailable: string[] }>, list(projectId),
     setVariables(projectId, values, options?), reconnect(projectId, serverId), stopProject(projectId), stop() }`; the
     stub: no tools, nothing shadowed, `list` → the parsed servers as `pending` (or empty), the writes
     `not_implemented`, the stops no-ops. *Accept:* a smoke test per member.
  6. **C36-T6 Registries** — empty `styles` / `hookCommands` registries wired into `S/registry/index.ts` (list empty,
     `onChange` subscribable, contributions `hooks: 0`, `outputStyles: []`); W11.7 implements registration and
     validation. *Accept:* registry tests green.
  7. **C36-T7 Deps and boot** — the four factories; `SHUTDOWN_STEPS` = data, runs, **hooks**, **projectMcp**,
     customizations, **projectConfig**, projectFiles, checkpoints, plugins, mcp, catalog, events (hooks are killed
     before the project MCP processes; a failing step still lets the next run); `BOOT_STEPS` unchanged (the new services
     are lazy; C36 confirms); `<dataDir>/hooks` is created lazily by W11.1, not at boot. *Accept:* `deps.test.ts` checks
     both orders.
  8. **C36-T8 Environment** — no new variable; `S/env*` only for compile fixes (reported).
  9. **C36-T9 Column classification** — every column of `hooks` and `project_trust` and `projects.output_style` in
     `UNSCANNED_COLUMNS` (shell text, hashes, a style name). *Accept:* `references.test.ts` (every column of every
     table classified).
  10. **C36-T10 Fakes** — `S/testing/fake-hooks.ts` (a scripted snapshot: results per event and target set by the test,
      a call log), `fake-project-config.ts`, `fake-project-trust.ts` (an in-memory approved set), `fake-project-mcp.ts`
      (scripted tools / shadowed / unavailable); `createTestApp({ hooks?, projectConfig?, projectTrust?, projectMcp?
      })`. *Accept:* `fakes.test.ts`.
  11. **C36-T11 Database tests** — `db.test.ts`: 22 tables, the migration tags `0000` … `0008`; `upgrade.test.ts`: a
      temporary folder holding only `0000` … `0007` with chats, messages, projects, customizations and background tasks,
      then the real folder: both tables exist and are empty, `output_style` is null on every project, every row
      survives, deleting a project cascades to its `project_trust` rows, a second (project, sha256) insert fails with a
      primary-key violation. *Accept:* green (the pins `db.test.ts:74`, `upgrade.test.ts` tables / migrations updated).
- **Tests.** The tasks above.
- **Verify.** Server commands.

### C37 chat seams (k5)

- **Mission.** Land every seam of the chat pipeline that the hook, style, command and project MCP agents share, so each
  P11-A agent owns its hot file alone: `pipeline.ts`, `tools.ts`, `approval.ts`, `steps.ts`, `model-history.ts`,
  `agent-scope.ts`, the new `hooks.ts` and `subagent/host.ts` **complete**; every other new module as a stub with its
  final signature, wired at its call site with unchanged behavior.
- **Owned.** `S/chat/**` (not `types.ts`, `background/types.ts`), `S/http/routes/commands{,.test}.ts`.
- **Read-only highlights.** `.tmp/p11-designs/plan.md` 1, 3 – 5, `server.md` A, D2, D4 – D6 (insertion points);
  `explore-pipeline.md`; `SH/util/{agent-state,hooks,command-template,output-styles}.ts` (C35), `SH/chat.ts`;
  `S/services/hooks/types.ts`, `S/mcp/types.ts` (C36); the AI SDK `.d.ts` (`toolApproval` re-run on approved
  continuations, `stopWhen` arrays, `experimental_toolApprovalSecret`).
- **Tasks.**
  1. **C37-T1 `hooks.ts` (new, complete)** — `RunHooks`, the per-run runtime over one `HookSnapshot`: `record(data)` →
     `session.inject({ type: 'data-hook', data }, session.stepNumber + 1)` (tracked, never lost); queued model-visible
     contexts for the next step; `answered` = the toolCallIds with approval responses in `prepared.continued`;
     `decisions` = the PreToolUse records of `prepared.continued`, keyed by toolCallId; `hookGate(session)` (Stop, T5);
     `forChild(callIdPrefix)` for sub-agents (PreToolUse with `ask` → deny, PostToolUse context into the child's own
     composer, never UserPromptSubmit / SessionStart / Stop); a no-op instance when the snapshot has no hooks.
     *Accept:* `hooks.test.ts` with the C36 fake snapshot.
  2. **C37-T2 `approval.ts` (complete)** — PreToolUse in `createToolApproval` (`approval.ts:215`) after "unknown →
     denied" and "`exit_plan_mode` → user-approval", before the user override (`:229-234`): target = the tool and its
     aliases; **skipped when the toolCallId is answered** (the SDK re-runs the function on approved continuations; only
     a `denied` result counts then) and replayed from the stored decision; the harness result is computed as today and
     combined: a harness `denied` wins; hook `deny` → `denied` ("Blocked by hook: <reason>"); hook `ask` →
     `user-approval` (a denial in children through `denyUserApproval`); hook `allow` → `approved` **only** when the
     harness result was `user-approval`, the tool's workspace access is not `execute` and its policy is not `always`;
     the record (outcome + `updatedInput`) injected; plan mode unchanged. *Accept:* `approval.test.ts`: each decision ×
     mode (ask / edits / plan / auto) × access; exactly one PreToolUse run across a request and its approved
     continuation; children turn `ask` into a denial.
  3. **C37-T3 `tools.ts` (complete)** — `updatedInput` applied in `prepareInput` (`tools.ts:245`) before `tool.before`,
     then the existing schema re-validation; too large or invalid → `ToolFailure` (fail closed); the tool part keeps the
     model's input; PostToolUse after `tool.after` in `runToolCall` (`:330`) and `streamToolCall` (`:473`), on success
     only, before `capToolOutput`: context / exit 2 / `decision: block` → model-visible feedback queued for the next
     step, `continue: false` → `session.hookStop`; `assembleTools({ …, extraTools, shadowedMcpServers })`: registry
     tools whose `mcpServerId` is shadowed are dropped, the extras added before `applyToolMode` (`:631`). *Accept:*
     `tools.test.ts` (rewrite + re-validation, fail closed, PostToolUse only on success, shadowing, extras pass the
     mode filter).
  4. **C37-T4 `steps.ts` (complete)** — `PieceName` + `hooks`; the composer order **guard → hooks → steer → finalize**;
     the hooks piece records `session.stepNumber` and appends the queued contexts as user model messages, so the in-run
     order equals what `splitHooks` rebuilds. *Accept:* `steps.test.ts` (the order; a context lands at step N+1).
  5. **C37-T5 `pipeline.ts` (complete)** — `RunContext.origin` + `hook`; one `RunHooks` per run (one snapshot);
     `RunSession.#missingInjections` widened to `data-hook` (by `data.id`); the `hookGate` transform piped after
     `stepInjector`: it holds `finish` when the run is a model run, not aborted, saw no `error` /
     `tool-approval-request` chunk, no `hookStop`, the chat queue is empty and `snapshot.has('Stop')`; writes a
     transient `data-activity { kind: 'hooks', event: 'Stop' }`, runs the Stop hooks with `stop_hook_active` = (origin
     is `hook`), enqueues the record before `finish`; a block → `session.followUp = { kind: 'hook', data }` unless
     `hookChainLength ≥ 5` (then the notice `hook-continuation-limit`); an abort during the hooks cancels the follow-up;
     an extra `stopWhen` condition for `continue: false`; `onReleased(ending, awaitingApproval, followUp)`; for project
     chats with an open workspace `modelStream` (`pipeline.ts:774`) calls `projectMcp.toolsFor(projectId, { signal,
     waitMs: 5000 })` and passes `extraTools` / `shadowedMcpServers` to `assembleTools` (`:808-827`); servers not ready
     → the notice `project-mcp-unavailable`; the style block reaches `buildRunParams` (`:839`) through
     `PreparedRun.outputStyle`. *Accept:* `pipeline.test.ts` green unchanged; new tests: the gate holds `finish` only
     with Stop hooks (zero cost without), a block yields a follow-up, the cap emits the notice, an abort cancels, a
     missing `data-hook` injection is appended once, `toolsFor` is called only for project chats.
  6. **C37-T6 `model-history.ts`** — the `splitHooks` stage after `splitTaskResults`: compaction → steer split →
     task-result split → **hook split** → task output reduction → command expansions; `keptUserMessage` applies
     `splitHooks` too. *Accept:* `model-history.test.ts` (the order; a v1.6 history unchanged; a hook carrier becomes a
     `<hook-feedback>` user text; a SessionStart context on a user message survives compaction).
  7. **C37-T7 `agent-scope.ts` and `subagent/host.ts`** — the child host gains the `RunHooks.forChild` handle
     (`ChildSession`, `createDetachedSession`), so foreground and background children run PreToolUse / PostToolUse and
     SubagentStop can be called by W11.2; never reachable through the plugin context. *Accept:* unbound → no hooks;
     every sub-agent and compaction test green unchanged.
  8. **C37-T8 Stubs with final signatures** — the `prepareRun` call sites (`prepare.ts:482-596`): SessionStart and
     UserPromptSubmit after `openRunWorkspace` (`:483`) through `S/chat/hooks-prompt.ts` (stub: no hooks, nothing
     blocked; placed so a block stores nothing, open point 14) and the style resolution through
     `S/chat/output-style.ts` (`resolveRunOutputStyle` stub → `default`) → `PreparedRun.outputStyle`;
     `CommandContext.expansion?: { workspace(): Promise<OpenWorkspace | null>, shellEnabled, trusted(projectId,
     sha256): Promise<boolean>, projectId }` (accepted, not yet used); `RunParamsInput.outputStyle` (ignored);
     `agentBlocks(…, { codingHints })` (default true); `startHookTurn(chatId, data)` in `index.ts` (stub: no turn);
     `onRunReleased(…, followUp)` wiring (priority queued item > hook turn > `background.onChatIdle`, the hook branch a
     no-op until W11.2); the widened `carrierParts` (`prepare.ts:327`; a user-role carrier whose parts are all
     `data-task-result` **or** all `data-hook`); `chatRequestBody.outputStyle` saved by `ensureChat` for new chats.
     *Accept:* typecheck; one smoke test per stub; every existing chat test green.
  9. **C37-T9 `GET /commands`** — items accept `kind` (`command` for today's entries); the skills listing is W11.5's.
     *Accept:* commands route tests.
- **Tests.** The tasks above; every existing chat test stays green.
- **Verify.** Server commands.

### C38 processes, mocks and fixtures (k6)

- **Mission.** The shell runner's stdin and environment options, the stdio MCP process group, the MCP fixtures, the
  builtin output styles, the reserved names and the mock model `mock:hooks` with its hook scripts — **complete** (frozen
  after the gate; they drive every probe and e2e spec).
- **Owned.** `S/workspace/shell{,.test}.ts`, `S/mcp/stdio-transport{,.test}.ts`, `S/mcp/__fixtures__/**`,
  `S/builtin-plugins/{index,index.test}.ts`, `S/builtin-plugins/core-agent/**`, `S/builtin-plugins/mock/**`,
  `S/registry/validate*`, `S/plugins/templates/names*`, `S/testing/hook-scripts.ts`.
- **Read-only highlights.** `.tmp/p11-designs/plan.md` 1, 3, 8, `server.md` A9, A10, E; PROVIDERS.md 8 ("Hook mocks
  (Phase 11)", D15 writes it from this section); `S/workspace/{shell,shell-env}.ts` (`runShellCommand` `:519`,
  `stdio: ['ignore', …]` `:535-541`, `killProcessGroup` `:333`); `S/mcp/stdio-transport.ts` (`:137-143`, `:224-246`);
  `S/security/process-spawn.test.ts:22`; `S/builtin-plugins/mock/{models,turn,common}.ts`; `SH/util/output-styles.ts`.
- **Tasks.**
  1. **C38-T1 `runShellCommand({ input, env })`** — `input?: string`: stdin becomes a pipe, the input is written then
     closed, EPIPE swallowed (a hook that never reads stdin is fine); the default stays `ignore`; `env?: Record<string,
     string>`: extra variables merged after `shellEnvironment`, overriding an allowlisted or fixed key refused; the
     process group, caps, timeout and abort unchanged; `reportCwd` stays off for these callers. *Accept:*
     `shell.test.ts` (stdin echo, a script that ignores stdin, a refused override, a timeout kills the hook and its
     grandchild: both pids dead).
  2. **C38-T2 Stdio MCP process group** — `ChildProcessMcpTransport` gains `processGroup` (on POSIX `detached: true` +
     `killProcessGroup` on close, timeout and shutdown); on for **every** stdio server (global ones included); the
     Windows fallback unchanged; still the same argument-array spawn (the allowlist stays at 3 modules). *Accept:*
     `stdio-transport.test.ts` (a server that spawns a grandchild: both pids dead after close, after a failed start and
     after the manager's stop).
  3. **C38-T3 Fixtures** — `S/mcp/__fixtures__/echo-server.mjs` gains the `pid` and `env` tools; a new
     dependency-free stdio MCP fixture (`mcp-min.mjs`: initialize, `tools/list`, `tools/call echo` / `pid` / `env`;
     optionally writes `.mcp-started-<pid>` into its cwd; Docker-safe, no `@modelcontextprotocol/sdk`) and a grandchild
     fixture. *Accept:* fixture smoke tests.
  4. **C38-T4 `core-agent` and builtin styles** — `S/builtin-plugins/core-agent/styles.ts`: the builtin styles adapted
     from SH `BUILTIN_OUTPUT_STYLES` (name, label, description, content, `keepCodingInstructions`) for the catalog
     builtins (open point 5); the `skill` tool description mentions only model-invocable skills (the filter is W11.6's);
     the manifest `engines` stays compatible (C38 decides `^1.4.0` or `^1.5.0`, reported). *Accept:*
     `core-agent/index.test.ts`; `builtin-plugins/index.test.ts` pins.
  5. **C38-T5 Reserved names** — `S/registry/validate.ts` refuses a plugin command named `output-style` (through
     `CLIENT_COMMANDS`) and a plugin style named like a builtin; `S/plugins/templates/names.ts` treats `output-style` as
     taken. *Accept:* validate and names tests.
  6. **C38-T6 `S/testing/hook-scripts.ts`** — writes POSIX `sh` scripts into a temp project (each reads stdin first;
     busybox-compatible, no `jq`): `deny`, `ask`, `allow` (JSON `permissionDecision`), `rewrite` (fixed `updatedInput
     {"command":"echo rewritten"}`), `context` (`additionalContext`), `exit2` (stderr `nope`), `error` (exit 1), `sleep`
     (timeout), `record` (appends the payload to `$HARNESS_PROJECT_DIR/.hook-log`), `env` (`env > …/.hook-env`),
     `stop-once` (`grep -q '"stop_hook_active":true'` || prints `{"decision":"block","reason":"run the tests"}`),
     `prompt-block` (exit 2 with a reason); each invoked as `sh <relative path>`. *Accept:* a smoke test per script.
  7. **C38-T7 `mock:hooks` (complete; `{ tools: true }`; the 17th mock)** — the trigger is the last non-empty line of
     the last user text:
     - `call <tool> <json>` → one call of that tool with that input; after the result: `Called <tool>: ok|denied|failed
       | <first 120 characters of the result text or the denial reason> | hooks: <the first line of each hook block
       after the result, or none>`;
     - `run <cmd>` → the same with `shell { command }`;
     - `context?` → `Context: <event:first line of every hook-context / hook-feedback block in the prompt> | none`;
     - `style?` → `Style: <the name after "Output style: " | none> | workspace-rules: yes|no | todo-hint: yes|no`;
     - `mcp?` → `MCP tools: <the offered mcp__ tool names, sorted>`;
     - `tools?` → `Tools: <the offered tool names, sorted>`;
     - `agent <prompt>` → one `task { type: 'general', description: 'Hook child', prompt }` → `Agent report: <report>`;
       the child (system text holds the sub-agent marker) answers `Child done`, or `Child continued: <reason>` when a
       SubagentStop feedback is present;
     - a last user message holding `<hook-feedback` → `Hook continuation: <the reason's first line>`;
     - anything else → `Hooks mock: <user text>` (the user text is the command expansion, so `!` / `@` expansions and
       skill invocations are visible).
     *Accept:* `mock/index.test.ts` / `models.test.ts`: a plan per branch; the listing.
  8. **C38-T8 Count pins** — the mock listing (one more model; the visible count and `modelCount`), `MOCK_MODEL_IDS`,
     the template names test; listed in the report.
- **Tests.** The tasks above; `S/security/process-spawn.test.ts` unchanged and green (3 modules).
- **Verify.** Server commands.

### C39 web skeleton (k4)

- **Mission.** Freeze the web side of Phase 11: every new test id, the Customize tabs, the stub components with their
  final props, emits, exposes and root test ids, the three stores and the pure modules (inert), the frozen-signature
  CCRs of plan section 7 as types, the mounts and emit chains through the hot files and the `useChatSession` interface
  additions.
- **Owned.** `W/utils/testids.ts`, `W/utils/testing/**`, `W/components/settings/customize/**`,
  `W/components/{projects,chat/hooks}/**`, `W/components/chat/composer/**`, `W/components/chat/parts/**`,
  `W/components/chat/{ChatView,ChatHeader,ChatTranscript,ChatMessage,UserMessageBubble,MessageActions,
  SubmittedPlaceholder,chat-format,chat-context}*`, `W/components/plugins/{detail,install}/**`,
  `W/components/settings/{GeneralSettings,projects/ProjectsSettings}*`, `W/stores/{hooks,project-trust,project-mcp,
  customizations,plugins}*`, `W/composables/{useChatSession,useServerEvents}*`.
- **Read-only highlights.** UI.md 2.18, 5.6, 7.8, 7.28, 7.31 – 7.33, 8.4, 8.8, 9.4, 9.10, 9.13, 10.8, 11.8, 12, 13.12,
  14, 15; `.tmp/p11-designs/web.md` A – F (with the reconciliation above); `SH/schemas/{hooks,project-trust,
  customizations,chats,projects}.ts`, `SH/chat.ts`, `SH/util/{hooks,agent-state,definitions,output-styles}.ts`;
  web.md A facts (`CustomizeSettings.vue:63,111,508,561`, `customize.ts:49,108,136`, `useChatSession.ts:274,391,541,
  962`, `ChatTranscript.vue:63,453`, `ChatMessage.vue:85,214`, `SubmittedPlaceholder.vue:10`, `chat-format.ts:188`,
  `ToolPart.vue:135,201`, `ChatComposer.vue:593-595`, `ChatView.vue:383,419-441,472`).
- **Tasks.**
  1. **C39-T1 Test ids** — the ids of UI.md 13.12 in `utils/testids.ts` (key = the camelCase of the id) under a
     `// Hooks, project trust, project MCP and output styles (Phase 11)` comment. The draft list (web.md E, reconciled;
     UI.md 13.12 wins on any difference, reported): Hooks tab `hooks-panel`, `hooks-enabled`, `hooks-disabled`,
     `hooks-section`, `hooks-empty`, `hook-row`, `hook-row-menu`, `hook-edit`, `hook-duplicate`, `hook-toggle`,
     `hook-copy-json`, `hook-review`, `hook-delete`, `hook-delete-confirm`, `customize-trust-review`; editor and import
     `hook-editor`, `hook-warning`, `hook-event`, `hook-matcher`, `hook-matcher-preview`, `hook-command`,
     `hook-timeout`, `hook-editor-enabled`, `hook-save`, `hook-error`, `hook-discard-confirm`, `hook-import-dialog`,
     `hook-import-input`, `hook-import-file`, `hook-import-preview`, `hook-import-item`, `hook-import-submit`,
     `hook-import-error`; styles and skills `customize-style-default`, `customization-keep-coding`,
     `customization-user-invocable`, `customization-model-invocation`, `customization-set-default`,
     `customization-review`, `settings-output-style`; trust `project-trust`, `project-trust-pending`,
     `project-trust-dialog`, `project-trust-warning`, `project-trust-filter`, `project-trust-group`,
     `project-trust-select-all`, `project-trust-item`, `project-trust-select`, `project-trust-revoke`,
     `project-trust-approve`, `project-trust-error`, `project-trust-empty`, `project-trust-chip`, `chat-project-trust`,
     `chat-project-mcp`; project MCP `project-mcp`, `project-mcp-dialog`, `project-mcp-server`,
     `project-mcp-variables`, `project-mcp-variable`, `project-mcp-variables-save`, `project-mcp-reconnect`,
     `project-mcp-review`, `project-mcp-error`, `project-mcp-empty`; composer `output-style-trigger`,
     `output-style-option`, `output-style-manage`, `composer-refusal`, `composer-refusal-dismiss`,
     `composer-refusal-review`; transcript and plugins `hook-note`, `hook-note-toggle`, `hook-note-details`,
     `tool-row-hook`, `tool-approval-hook`, `plugin-hooks`, `plugin-hook`. New attribute names: `data-event`,
     `data-outcome`, `data-hook-id`, `data-sha256` (web.md's `data-key`), `data-trust`, `data-reason`,
     `data-transport`; new attribute values: `customize-tab[data-value=output-styles|hooks]`,
     `slash-menu-item[data-group=skill]`, `plugin-customizations[data-kind=style]`, `hook-note[data-outcome]` = the
     server's outcome enum; slots `running-hook`, `hook-context` and the error-detail slot (web.md's `hook-stderr`; the
     part carries `hooks[].error`; UI.md names it).
  2. **C39-T2 Customize tabs** — `CustomizeTab = CustomizationKind | 'hook'`, `tabOf()`, query values `agents |
     commands | skills | output-styles | hooks` (the style tab value is the folder name, so `kindFolders` keeps
     matching); `CustomizeSettings` renders the Output styles tab through the kind sections and the Hooks tab through
     `HooksPanel`; the header buttons follow the tab. *Accept:* `CustomizeSettings.test.ts`, `customize.test.ts`.
  3. **C39-T3 Stub components** — each renders its root test id and declares exactly (UI.md 10.8 wins where it is more
     precise; report the difference):
     ```ts
     HooksPanel          { projectId: string | null; projectName: string | null }      // settings/customize/
                         // exposes create(): void, import(): void
     HookSection         { source: HookSource; entries: readonly HookEntry[]; projectName?: string | null;
                           files?: readonly string[]; pending?: number; issue?: string | null;
                           busyIds?: readonly string[] }
                         // emits action: [HookAction, HookEntry], review: []
     HookRow             { entry: HookEntry; busy?: boolean }                         // emits action: [HookAction]
     HookEditor          { open: boolean; mode: 'new' | 'edit' | 'copy'; hook: PersonalHook | null;
                           draft?: HookDraft | null }                                 // fresh auth inside
                         // emits update:open: [boolean], saved: [PersonalHook]
     HookImportDialog    { open: boolean }                // emits update:open: [boolean], imported: [PersonalHook[]]
     StyleScopeBar       { projectId: string | null; projectName: string | null;
                           options: readonly OutputStyleOption[] }                    // root customize-style-default
     ProjectTrustDialog  { open: boolean; projectId: string | null; focusSha256?: string | null }  // projects/trust/
                         // emits update:open: [boolean]
     ProjectTrustItem    { item: TrustItem; selected: boolean; busy: boolean }       // emits toggle: [], revoke: []
     ProjectTrustChip    { projectId: string | null }                                 // injects CHAT_VIEW_ACTIONS
     ProjectMcpDialog    { open: boolean; projectId: string | null; focusServerId?: string | null }  // projects/mcp/
                         // emits update:open: [boolean]; hosts the per-project variables panel
     ProjectMcpServerRow { server: ProjectMcpServer; expanded: boolean; busy: boolean }
                         // emits toggle: [], reconnect: [], review: []
     HookNote            { data: HookData; variant: 'inline' | 'turn' | 'tool'; pluginName?: string | null }
                         // chat/hooks/; store-free
     ToolHookBadge       { hooks: readonly HookData[] }                               // chat/parts/tools/; store-free
     OutputStyleMenu     { open: boolean; modelValue: string | null; options: readonly OutputStyleOption[];
                           automatic: OutputStyleOption | null; returnFocusTo?: HTMLElement | null }  // chat/composer/
                         // emits update:open: [boolean], update:modelValue: [string | null]; root output-style-trigger
     ComposerRefusal     { refusal: ComposerRefusalData | null }                      // emits dismiss: [], review: []
     PluginHookList      { entries: readonly HookEntry[]; codeHooks: readonly string[] }  // plugins/detail/
     ```
     `HookAction` = `edit | duplicate | toggle | copy-json | delete | review | copy-to-personal | open-plugin`;
     `HookDraft` = the editor's fields (`event`, `matcher`, `command`, `timeout`, `enabled`); `OutputStyleOption` = `{
     name, label, description, source, pluginId? }`; `ComposerRefusalData` = `{ code: 'hook-blocked' | 'untrusted',
     message, event?, source?, commandName? }`. *Accept:* one stub mount test per component (root test id, props
     accepted).
  4. **C39-T4 Stores and pure modules (inert, typed)** — `useHooksStore` (`W/stores/hooks.ts`, key `projectId ?? ''`):
     getters `list(projectId)`, `personal`; actions `fetch(projectId, { maxAgeMs?, refresh? })`, `create(body)`,
     `update(id, patch)` (`{ enabled: false }` optimistic), `remove(id)`, `runs()`, `applyEvent(event)`
     (`hooks.changed`, `project-trust.changed`, `plugin.changed` → stale), `refreshLoaded()`. `useProjectTrustStore`
     (`W/stores/project-trust.ts`): getters `trust(projectId)`, `pending(projectId): number` (the list, else the last
     `project-trust.changed` count; fetched lazily); actions `fetch(projectId, { maxAgeMs? })`, `approve(projectId,
     items: readonly { kind, sha256 }[])` (409 `stale` → refetch, then throw), `revoke(projectId, sha256)`,
     `applyEvent(event)`, `refreshLoaded()`. `useProjectMcpStore` (`W/stores/project-mcp.ts`): getters
     `servers(projectId)`, `variables(projectId)`, `byId(projectId, serverId)`; actions `fetch(projectId)`,
     `setVariables(projectId, values: Record<string, string | null>)`, `reconnect(projectId, serverId)`,
     `applyEvent(event)` (`project-mcp.changed`, `project-trust.changed`), `refreshLoaded()`. The stores throw 403
     `login`; components wrap their calls in `useFreshAuth().run(task, { required })`. Pure modules with final
     signatures: `settings/customize/hooks.ts` (`HOOK_EVENT_COPY` (open point 11), `hookStateBadge`, `hookRowMeta`,
     `matcherPreview(matcher, tools)` (over SH `compileMatcher` / `hookTargetNames`), `draftFromHook`,
     `hookJson(entries)`, `importHooks(text)` (`{ items, notes }` over SH `readHooksConfig` / `readSettingsHooks`),
     `HOOK_COPY`, `hookDeleteCopy`), `projects/trust/project-trust.ts` (`trustGroups`, `trustStateText`,
     `approveLabel(n)`, `staleText(n)`, `variableStateText`), `chat/hooks/hook-notes.ts` (`hookDataOf(part)`,
     `toolHooksOf(parts): Map<string, HookData[]>` and `isHookCarrierMessage(message)` **complete**,
     `hookOutcomeText(data)`, `hookSourceText(data, pluginName)`, `hookAnnouncement(data)`),
     `chat/composer/output-style.ts` (`styleOptions(entries)`, `automaticStyle(projectStyle, globalStyle, options)`,
     `resolveStyleQuery(query, options)`, `refusalOf(error): ComposerRefusalData | null`). UI.md 11.8 wins on any
     difference. *Accept:* store shape tests; `hook-notes.test.ts` for the two complete helpers; the modules type-check.
  5. **C39-T5 Frozen-signature CCRs as types** — `useChatSession`: `outputStyle: WritableComputedRef<string | null>`
     (the chat's own choice, never pinned by `pinChoices`), `hookActivity: Readonly<Ref<{ event: HookEvent; toolCallId:
     string | null } | null>>`, `activity` widened to `'compacting' | 'hooks' | null`, `run.started` origin `hook` like
     `task` (`useChatSession.ts:962`), the request body `outputStyle`; the activity props of `ChatTranscript` /
     `ChatMessage` / `SubmittedPlaceholder` widened + the `HOOK_ACTIVITY` injection key (per-tool activity comes through
     injection: the transcript rows are `v-memo`ed); `ChatComposer`: prop `outputStyle: string | null`, emit
     `update:outputStyle`, `ChatComposerExposed.showRefusal(refusal: ComposerRefusalData | null)` and
     `.restoreInput(input: ComposerSubmitInput)`; `CHAT_VIEW_ACTIONS` + `openProjectTrust(focusSha256?: string)`,
     `openProjectMcp(serverId?: string)`; `MessageBlock` + `{ kind: 'hook', key, index, data: HookData }` (tool hook
     parts are not emitted as blocks); `ToolPart.hooks?: readonly HookData[]`; `ToolApprovalCard.hookReason?: string |
     null`; `slash-commands.ts`: `SlashGroup` + `skill` ("Skills", last), `SlashItem.skill?` / `.pending?`,
     `ClientCommandAction` + `{ type: 'open', menu: 'style' }` and `{ type: 'set-style', style: string | null }`,
     `ClientCommandContext.styles`, the name patterns widened to 64 (`:96,137,161`),
     `CLIENT_COMMAND_DESCRIPTIONS['output-style']` "Set the output style"; `customize.ts`: `CustomizationDraft` +
     `keepCodingInstructions`, `userInvocable`, `modelInvocation` (`argumentHint` reused for skills),
     `CustomizationAction` + `review`, `set-default`; `PluginCustomizationList.kind` + `style`; `CommandBadge.kind?:
     'command' | 'skill'`. *Accept:* typecheck; every existing test green.
  6. **C39-T6 Mounts and chains** — `ChatView`: the trust and MCP dialogs, the `CHAT_VIEW_ACTIONS` additions,
     `provide(HOOK_ACTIVITY)`, the refusal branches (stubbed); `ChatHeader`: `ProjectTrustChip`; `ChatProjectChip`:
     the menu items "Review commands and hooks…" (`chat-project-trust`) and "MCP servers…" (`chat-project-mcp`);
     `ChatMessage`: the hook block, the hook carrier branch (`isHookCarrierMessage`: no bubble, no actions, no edit, no
     rewind), the user-message hook parts, the tool hooks; `ToolPart`: the `hooks` prop and the badge slot;
     `ChatComposer`: `OutputStyleMenu` after `EffortMenu`, `ComposerRefusal`, the new exposes; `useServerEvents`: the
     three new events to the three stores (+ `project-trust.changed` to the hooks store), `refreshLoaded()` of the
     three stores on reconnect; `useChatSession`: origin `hook`, `outputStyle`, `hookActivity`; `CustomizeSettings`:
     the Hooks tab with `HooksPanel`; `ProjectsSettings`: the row menu items "Review commands and hooks…"
     (`project-trust`) and "MCP servers…" (`project-mcp`); `PluginContributions`: the Hooks section through
     `PluginHookList` and the Output styles section; `GeneralSettings`: the Output style field (stub). *Accept:* the
     existing `ChatView`, `ChatHeader`, `ChatTranscript`, `ChatMessage`, `ToolPart`, `ChatComposer`, `SlashMenu`,
     `useServerEvents`, `useChatSession`, `CustomizeSettings`, `PluginDetailView`, `ProjectsSettings`,
     `GeneralSettings` tests stay green; mount tests for the new mounts.
- **Tests.** The tasks above; `W/components/template-literals.test.ts` stays green (no `//` in component prop values).
- **Verify.** Web commands (`typecheck:fast` needs the coordinator's `.nuxt`; import new components by path).

### Wave P11-0b ownership

The audit cannot express "except": `S/db/schema.ts` matches C36's glob but is the coordinator's K3 edit;
`S/chat/types.ts` matches C37's glob but is C36's; `S/testing/hook-scripts.ts` matches C36's glob but is C38's;
`S/testing/api-samples.ts` stays C34's file from P11-0a (untouched in P11-0b); `S/chat/background/types.ts` stays
frozen. C36, C37, C38 and C39 list the count pins and fixtures outside their globs in their reports (`*-test-fixes`).

```json
{
  "wave": "P11-0b",
  "agents": {
    "K3": [
      "apps/server/src/db/schema.ts",
      "apps/server/drizzle/**"
    ],
    "C36": [
      "apps/server/src/types.ts",
      "apps/server/src/deps*.ts",
      "apps/server/src/env*.ts",
      "apps/server/src/main.ts",
      "apps/server/src/db/**",
      "apps/server/src/chat/types.ts",
      "apps/server/src/services/{hooks,project-config,project-trust}/**",
      "apps/server/src/services/{secrets,projects,customizations}/types.ts",
      "apps/server/src/registry/{types,index,styles,hook-commands}*",
      "apps/server/src/mcp/types.ts",
      "apps/server/src/mcp/project*",
      "apps/server/src/services/data/references.ts",
      "apps/server/src/services/data/references.test.ts",
      "apps/server/src/testing/**"
    ],
    "C37": [
      "apps/server/src/chat/**",
      "apps/server/src/http/routes/commands.ts",
      "apps/server/src/http/routes/commands.test.ts"
    ],
    "C38": [
      "apps/server/src/workspace/shell.ts",
      "apps/server/src/workspace/shell.test.ts",
      "apps/server/src/mcp/stdio-transport.ts",
      "apps/server/src/mcp/stdio-transport.test.ts",
      "apps/server/src/mcp/__fixtures__/**",
      "apps/server/src/builtin-plugins/index.ts",
      "apps/server/src/builtin-plugins/index.test.ts",
      "apps/server/src/builtin-plugins/core-agent/**",
      "apps/server/src/builtin-plugins/mock/**",
      "apps/server/src/registry/validate*",
      "apps/server/src/plugins/templates/names*",
      "apps/server/src/testing/hook-scripts.ts"
    ],
    "C39": [
      "apps/web/app/utils/testids.ts",
      "apps/web/app/utils/testing/**",
      "apps/web/app/components/settings/customize/**",
      "apps/web/app/components/{projects,chat/hooks}/**",
      "apps/web/app/components/chat/composer/**",
      "apps/web/app/components/chat/parts/**",
      "apps/web/app/components/chat/{ChatView,ChatHeader,ChatTranscript,ChatMessage,UserMessageBubble,MessageActions,SubmittedPlaceholder,chat-format,chat-context}*",
      "apps/web/app/components/plugins/{detail,install}/**",
      "apps/web/app/components/settings/{GeneralSettings,projects/ProjectsSettings}*",
      "apps/web/app/stores/{hooks,project-trust,project-mcp,customizations,plugins}*",
      "apps/web/app/composables/{useChatSession,useServerEvents}*"
    ]
  },
  "allow": [
    "docs/ROADMAP.md",
    "docs/DECISIONS.md",
    "AGENT.md",
    "docs/phases/phase-11-v1-7.md",
    ".tmp/**"
  ]
}
```

### Wave P11-0b cross-agent contracts

| Producer → consumer | Contract |
|---|---|
| K3 → C36, W11.1, W11.3, W11.7 | `0008`: `hooks` (the personal rows), `project_trust` (primary key (project, sha256), cascade from `projects`), `projects.output_style` |
| C36 → C37, W11.1 – W11.7 | `HookService` / `HookSnapshot` / `HookEventResult` + the stub; `ProjectConfigService` (+ the verify member); `ProjectTrustService`; `ProjectMcpManager` + the stub; `AppServices` members; the registry `styles` / `hookCommands`; the secret scope `project:<projectId>`; `CustomizationCatalog.styles()` / `style(name)`; `createTestApp({ hooks?, projectConfig?, projectTrust?, projectMcp? })` and the fakes; the start / stop order |
| C37 → W11.2, W11.4 – W11.6 | `pipeline.ts` / `tools.ts` / `approval.ts` / `steps.ts` / `model-history.ts` / `agent-scope.ts` / `hooks.ts` / `subagent/host.ts` (complete: `RunHooks`, `hookGate`, `forChild`, `followUp`, `toolsFor` call, `extraTools` / `shadowedMcpServers`), the stub signatures (`hooks-prompt.ts`, `output-style.ts`, `CommandContext.expansion`, `RunParamsInput.outputStyle`, `agentBlocks(…, { codingHints })`, `startHookTurn`, `onReleased(…, followUp)`, the widened `carrierParts`) |
| C38 → W11.1, W11.4, W11.5 | `runShellCommand({ input, env })`; the stdio `processGroup`; the MCP fixtures; `S/testing/hook-scripts.ts` |
| C38 → W11.6 | `core-agent/styles.ts` (the builtin output styles) |
| C38 → W11.13 and the gates | `mock:hooks` (PROVIDERS.md 8, "Hook mocks (Phase 11)") |
| C39 → W11.8 – W11.12 | the stub components, the three stores, the pure modules, `HOOK_ACTIVITY`, `CHAT_VIEW_ACTIONS`, `toolHooksOf` / `isHookCarrierMessage`, the emit chains and props, the `useChatSession` additions (frozen) |
| C39 → everyone | `utils/testids.ts` (frozen after the gate) |

### Gate P11-0b

1. `node scripts/audit-ownership.mjs .tmp/waves/P11-0b.json`
2. Inspect `0008` (K3 step 3).
3. `nuxi prepare` → `pnpm check` → `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
4. `mv .tmp/e2e .tmp/e2e-old-p11-0b` (a cached mock listing hides `mock:hooks`; `mv`, not `rm -rf`) →
   `pnpm start:e2e` → `pnpm test:e2e` (156 still green).
5. **Upgrade probe** on a fresh copy of the K3S seed (never on `.tmp/e2e`, never on the seed itself), on :8898:
   ```sh
   d=.tmp/gates/P11-0b/upgrade-$(date +%s); cp -R .tmp/upgrade-v16 "$d"   # data + roots
   # before boot, by SQL: projects.path → "$PWD/$d/roots/<p>", the global stdio server's path → the copied fixture
   HF_MOCK_PROVIDER=1 HF_OFFLINE=1 HF_PORT=8898 HF_DATA_DIR="$d/data" \
     HF_WORKSPACE_ROOTS="$PWD/$d/roots" node apps/server/dist/main.mjs &
   # through node + @libsql/client, ids from .tmp/upgrade-v16-ids.json:
   #   SELECT count(*) FROM __drizzle_migrations;                          -> 9
   #   SELECT count(*) FROM hooks; SELECT count(*) FROM project_trust;    -> 0, 0
   #   SELECT count(*) FROM projects WHERE output_style IS NOT NULL;      -> 0
   #   PRAGMA foreign_key_check; PRAGMA integrity_check;                  -> no rows; ok
   #   counts of chats, messages, workspace_changes, customizations, background_tasks -> the seeded counts
   ```
   Then, logged in with the seeded password: every seeded chat opens (`GET /chats/<id>`; the stored `data-task-result`
   parts and the `/status` command message (`metadata.command.expansion`) byte-identical to the seed's); the three
   approvals are still pending; the share link opens (`GET /share/<token>` 200); the provider key is readable; the
   global stdio server connects (`GET /mcp`); `GET /settings` has `outputStyle: 'default'` and `hooksEnabled: true`;
   `GET /hooks`, `GET /projects/<p>/trust` and `GET /projects/<p>/mcp` answer the stub values; **nothing ran: no hook
   sentinel, no `.mcp-started-*` file, no `.hook-log/` in the copied roots**. Stop the probe server afterwards (kill by
   port).
6. **Seam no-op probe** (the 8898 server on a copy of the roots with `projects.path` repointed by SQL, or
   `pnpm start:e2e`): `mock:workspace` in `auto` writes `mock-workspace.txt` and journals it; `mock:shell` runs;
   `mock:subagent` in `ask` runs its children without approvals; `mock:background` delivers; `/compact` works; a
   `mock:plan` approved in `edits` writes `notes.txt`; `GET /models` lists `mock:hooks`; a restart with
   `HF_WORKSPACE_SHELL=0` still removes `shell`; disabling a global stdio MCP fixture that spawns a grandchild leaves
   **both pids dead**, and so does a SIGTERM shutdown.
7. FREEZE additions (see "FREEZE in Phase 11") → ROADMAP + wave log → commit
   `feat: add phase 11 schema, migration and skeletons`.

---

## Wave P11-A — features

Twelve agents and the gate-probe agent G11P in one launch against the P11-0b checkpoint. Only server agents get slots
(k1 – k7); web agents run no server; G11P runs its probes on :8896 – :8898 only after the coordinator's build signal.

### Coordinator actions

- Before the launch: the ownership file `.tmp/waves/P11-A.json` (below), agent prompts with a "what exists now"
  section, their section of this file and "Rules for every Phase 11 agent".
- During the wave: when every server and web agent has reported, the coordinator runs `nuxi prepare` → `pnpm build`
  and sends G11P the build signal (`BUILD_READY`); G11P then runs its probes while the coordinator runs e2e on :8899.
- **At the gate**: audit; batch the CCRs; `nuxi prepare`; the gate commands and probes below; the screenshot review;
  `pnpm audit`; red items become W11.15 (server) / W11.16 (web) tasks with their globs; the reports are digested into
  `.tmp/waves/P11-A-notes.md` for W11.14. **First cuts if the wave overflows** (in this order): the SubagentStop
  continuation (observe only) → the code `HookMap` events other than `prompt.submit` / `run.stop` →
  `ctx.outputStyles.register` (keep `contributes.outputStyles`) → the `.mcp.json` sse transport → `hooks.runs` (the
  route answers an empty list) → the project MCP idle stop → web: the hook import file chooser (paste only), Copy as
  JSON, the matcher preview, the style scope bar ("Use by default" and General stay), the per-tool "Running hook…" (keep
  the message-level line), the slash-menu trust badge.

### Wave rules

- Import new components explicitly by path; no `nuxt prepare` mid-wave.
- A new test id, a contract change or a frozen-file edit is a CCR in the report (with a local adapter).
- No doc edits ("For W11.14" notes in the report instead).
- Hot files have exactly one owner (the list in "Rules for every Phase 11 agent"); `pipeline.ts`, `tools.ts`,
  `approval.ts`, `steps.ts`, `markers.ts`, `model-history.ts`, `agent-scope.ts`, `hooks.ts`, `subagent/host.ts`,
  `S/workspace/shell.ts` and `S/mcp/stdio-transport.ts` are frozen.
- Server agents implement behind the C36 / C37 seams and test against them with `MockLanguageModelV4`, the C36 fakes
  and the C38 hook scripts and fixtures; where a feature needs another agent's piece (W11.2 and W11.5 need W11.1's
  snapshot, W11.1 / W11.4 / W11.5 need W11.3's approvals, W11.1 and W11.6 need W11.7's registries, the web agents the
  routes), test against the frozen signature with a fake; the real round trips are probed at the gate.
- The mock models are frozen: a test that needs another script uses `MockLanguageModelV4` directly.
- Hook processes in tests: `S/testing/hook-scripts.ts` scripts in `realpath(mkdtemp())` projects, small timeouts, every
  pid asserted dead; MCP processes: the `S/mcp/__fixtures__` servers on loopback only.

### W11.1 hooks-server (k1)

- **Mission.** The hooks service: the three sources, the merged effective list, the snapshot, the runner (stdin, caps,
  semaphore, parallel), the combination, the kill switches, verify-before-run, the run log, personal CRUD with fresh
  auth, the routes and `hooks.changed`.
- **Owned.** `S/services/hooks/**` (not `types.ts`), `S/http/routes/hooks*`, `S/testing/fake-hooks*`.
- **Read-only highlights.** ADR-048, ADR-049; the plan's Reconciliation rows (hook format, events, matcher, payload,
  output, execution, kill switches, `data-hook`, personal hooks), `server.md` D1; API.md (the hooks schemas and module);
  ARCHITECTURE.md (the hooks flow); `SH/util/{hooks,trust}.ts`, `SH/schemas/hooks.ts`; `S/services/hooks/types.ts`,
  `S/services/{project-config,project-trust}/types.ts` (frozen); `S/workspace/{shell,shell-env}.ts`
  (`runShellCommand({ input, env })`, `shellEnvironment`, `killProcessGroup`); `S/registry/types.ts` (`hookCommands`,
  `hooks.run`), `S/registry/hooks.ts:10-12` (the 3 s guard, 5 failures disable a handler);
  `S/http/middleware/fresh-auth.ts` (`requireFreshAuth`, `SensitiveOperationOptions`); `S/testing/hook-scripts.ts`.
- **Tasks.**
  1. **W11.1-T1 Sources** — personal rows (`hooks` table, `enabled`); project items from `projectConfig.snapshot(
     projectId)` only when the run's workspace opened and their sha256 ∈ `projectTrust.approved(projectId)` (identical
     hashes across the four settings files run once); plugin declarative hooks (`registry.hookCommands`, the owner
     active and trusted; `HARNESS_PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` = the plugin folder); plugin code events through
     `registry.hooks.run` (3 s guard). Everything is additive; `snapshot(scope, { signal })` is taken once per run and
     once per prepare. *Accept:* a test with all three sources running for one event; a pending project item never in
     the snapshot.
  2. **W11.1-T2 Matching** — `compileMatcher` once per snapshot; PreToolUse / PostToolUse targets from
     `hookTargetNames(tool, { mcpServerName })` (the project MCP name for `mcp__<name>__<tool>`); non-tool events
     follow the module comment of `SH/util/hooks.ts`; an invalid matcher never runs (a diagnostic in the listing).
     *Accept:* `Write` matches `write_file`, `Bash|Write` and `*` match, `^Bash` never runs.
  3. **W11.1-T3 Runner** — `runShellCommand({ command, cwd, input: payload.json, env, timeoutMs, signal })`; cwd = the
     workspace root, else `<dataDir>/hooks` (created lazily, mode 0700); env = `shellEnvironment` +
     `HARNESS_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` (= cwd) (+ the plugin root variables); stdout capped at 64 KiB (head),
     stderr at 16 KiB; per-hook timeout `timeout × 1000` (default 60 s, ≤ 600 s); matching handlers in parallel (≤ 20
     per event; more → `too-many`, the first 20 run); a server-wide semaphore of 16 processes acquired with the run
     signal; abort, timeout and `stop()` kill the process groups (awaited); `buildHookPayload` per event;
     `readHookOutput` per process; `combineHookOutcomes` per event → `HookEventResult`; `record` (a `HookData` with a
     `hev_` id, `hooks[]` ≤ 20 entries `{ source, label ≤ 200 (the file / plugin label and a redacted command head),
     pluginId?, exitCode, timedOut?, durationMs, error?, systemMessage? }`, `context?`, `reason?`, `updatedInput?`) only
     when something is worth showing (a decision, context, an error, a system message, a block); a silent success
     leaves no record. *Accept:* the `record` script sees the payload on stdin; the `env` script shows the project-dir
     variables and no `HF_*` / provider keys; cwd root vs `<dataDir>/hooks`; the `sleep` script times out and its
     grandchild dies; 17 concurrent hooks wait for the semaphore; caps.
  4. **W11.1-T4 Verify-before-run** — a project item's hash is recomputed (the command and its referenced files re-read
     through the project-config verify member) right before its spawn; a mismatch skips it as pending and lets the trust
     service emit `project-trust.changed`. *Accept:* editing the referenced script between the snapshot and the run →
     not run.
  5. **W11.1-T5 Kill switches** — `settings.hooksEnabled === false`, `env.workspaceShell === false`, `env.safeMode` →
     no command hook spawns (entries `blocked` in `GET /hooks`, `switches: { setting, shell, safeMode }`); code hooks
     still run. *Accept:* one test per switch (no process spawned).
  6. **W11.1-T6 Run log and logging** — a ring of `hookRunsKept` (200) entries `{ id, at, event, source, label, chatId?,
     exitCode, timedOut, durationMs, outcome, error? ≤ 500 }` behind `GET /hooks/runs` (first cut); `info` logs the
     event, source, label hash prefix, exit code, duration and outcome only; commands, stdin, stdout and stderr only at
     `debug`, redacted. *Accept:* a captured-log test (no command, payload or output at `info`).
  7. **W11.1-T7 Personal CRUD, routes, events** — `GET /hooks?projectId` (personal + project entries with their state
     `active | pending | invalid | blocked | off` + plugin entries (command and code), diagnostics, switches; 404 for an
     unknown project); `POST /hooks` (fresh, 201; at most 100 rows: the answer API.md fixes); `PATCH /hooks/:id` (fresh
     unless the body is exactly `{ enabled: false }`, enforced in the handler); `DELETE /hooks/:id` (204, not fresh);
     the matcher validated with `compileMatcher`, the command 1 – 4096 characters, the timeout 1 – 600; every change →
     `hooks.changed { projectId: null }`; `invalidate(projectId | null)` on `project-trust.changed`, `project.changed`,
     `workspace.changed` of the settings files and registry changes. *Accept:* route tests for every answer in API.md;
     403 without fresh auth on create / update; an off-only PATCH without fresh auth succeeds.
  8. **W11.1-T8 Fake** — `S/testing/fake-hooks.ts` kept behind the frozen interface (scripted results per event and
     target, a call log) for W11.2 / W11.5 tests.
- **Tests.** The tasks above; every spawned pid dead at test end.
- **Verify.** Server commands.

### W11.2 hook-events-server (k2)

- **Mission.** The run-level hook events: UserPromptSubmit (at submit and at enqueue) and SessionStart, Stop turns (the
  hook turn, the cap, the ordering with queued and background turns), SubagentStop, PreCompact and Notification.
- **Owned.** `S/chat/{hooks-prompt,steer,queue,index}*`, `S/chat/{subagent,compaction}/**` (not `host.ts`),
  `S/chat/background/**` (not `types.ts`), `S/http/routes/{chat,chats,chat-queue}*`.
- **Read-only highlights.** ADR-040, ADR-042, ADR-043, ADR-046, ADR-048; the plan's Reconciliation rows
  (UserPromptSubmit, SessionStart, Stop, SubagentStop / PreCompact / Notification), `server.md` D2,
  `explore-pipeline.md` 1 and 4; API.md (409 `hook-blocked`, the hook carrier, `run.started.origin: 'hook'`, the
  notice); `S/chat/{pipeline,hooks,steps,model-history}.ts`, `S/chat/subagent/host.ts` (frozen: `RunHooks`,
  `hookGate`, `forChild`, `followUp`, `onReleased`), the C37 stubs in `prepare.ts` (W11.5 owns the file),
  `SH/util/agent-state.ts` (`sessionStartSource`, `hookChainLength`, `hookModelText`); the C36 fake snapshot.
- **Tasks.**
  1. **W11.2-T1 UserPromptSubmit at submit (`hooks-prompt.ts`)** — for `POST /chat` new turns (kind `new`, not a server
     message, a chat model, not a reply / compact command), at C37's call site after `openRunWorkspace`
     (`prepare.ts:483`): the payload's `prompt` = the user text of the new message; a block or `continue: false`
     → `HarnessError` 409 `conflict` `details.reason: 'hook-blocked'` (the message = the reason) before anything is
     committed (on `/`: no chat row, open point 14); a context → a `data-hook` part appended to the user message
     (validated by `validateMessage`); an edit re-runs it, regenerate and continuation reuse the stored part. *Accept:*
     through `createTestApp()` + `app.request()`: a block stores nothing (no message, no chat on `/`), a context lands
     on the user message and in the model text, a regenerate does not re-run.
  2. **W11.2-T2 UserPromptSubmit at enqueue (`queue.ts`, the chat-queue route)** — synchronous at `POST
     /chat/:id/queue`: a block → 409 `hook-blocked`, nothing queued; a context is kept with the queued item and
     attached on delivery (a queue-started turn → the `data-hook` on its user message; a steered item → injected with
     the steer, `steer.ts:137` / `stepInjector` `:48`, the model text through `hookModelText`). *Accept:* a blocked
     enqueue; a context delivered once through each path.
  3. **W11.2-T3 SessionStart** — at the same call site, before UserPromptSubmit, when `sessionStartSource(path)` is not
     null (`startup`: the path before the new message is empty; `compact`: the newest compaction marker is newer than
     the newest SessionStart record); a context on the user message (it survives compaction through
     `keptUserMessage`); `continue: false` → 409 `hook-blocked`; request and queue turns only (open point 13).
     *Accept:* `startup` fires once; `compact` fires at the first turn after `/compact`.
  4. **W11.2-T4 Stop turns (`index.ts`)** — `onReleased(ending, awaitingApproval, followUp)` (`index.ts:159-176`) →
     `startHookTurn(chatId, data)` = `startRun(…, 'hook', { serverMessage: true })` with a user-role carrier holding
     only `data-hook` parts (C37's widened `carrierParts`); priority: a queued item > the hook turn >
     `background.onChatIdle`; never while an approval is pending; a lost race (409 `run-active`) drops it;
     `run.started { origin: 'hook', userMessageId }`; the hook turn's step 0 takes the background inbox; the cap (5 in a
     row, `hookChainLength`) and the notice come from C37's gate; a user Stop during the hooks or the hook turn ends the
     chain. *Accept:* the `stop-once` script → one hook turn, `Hook continuation:`, then a stop; an always-blocking
     hook → 5 turns, then `hook-continuation-limit`; a queued item wins; an approval or an abort → no hook turn; a
     background delivery inside a hook turn.
  5. **W11.2-T5 SubagentStop** — foreground: `executeChild` after the stream loop (`subagent/index.ts:~650`) when the
     status would be `completed`; background: `finalize` (`background/index.ts:374`, before `pushInbox` / `deliver`
     `:400-403`); a block → one more child round (`streamText` with the prior response messages + a feedback user
     message), at most `subagentStopContinuationsMax` (2), `stop_hook_active` from the second round; never persisted
     (logged only). *Accept:* `mock:hooks` `agent …` with a blocking SubagentStop → `Child continued: <reason>`; the
     cap.
  6. **W11.2-T6 PreCompact** — `compact()` (`compaction/guard.ts:140`, trigger `auto`) and `compactStream`
     (`compaction/stream.ts:116`, trigger `manual`, `custom_instructions` = the `/compact` focus); observe only
     (`continue: false` ignored with a diagnostic); the record injected at the compaction step or written into the
     reply. *Accept:* the payload of both triggers.
  7. **W11.2-T7 Notification** — in `onRunReleased` when `awaitingApproval` (`notification_type: permission_prompt`,
     `message` naming the tool); fire-and-forget through the `TaskTracker`; observe only; the run log only. *Accept:*
     the `record` script sees one Notification per approval request.
  8. **W11.2-T8 Children** — the `RunHooks.forChild(prefix)` handle (C37) passed into foreground and background
     children: PreToolUse `ask` → denied, PostToolUse context into the child's composer; never UserPromptSubmit,
     SessionStart or Stop in a child. *Accept:* a child `ask` hook → a denial, no approval card.
- **Tests.** The tasks above; prompts, contexts and reasons never logged at `info`.
- **Verify.** Server commands.

### W11.3 trust-server (k3)

- **Mission.** The project config reader and its cache, the trust hash inputs with the referenced files, the approved
  set, the trust listing, approve (fresh, stale) / revoke, the routes and `project-trust.changed`.
- **Owned.** `S/services/{project-config,project-trust}/**` (not `types.ts`), `S/http/routes/project-trust*`.
- **Read-only highlights.** ADR-049, ADR-050; the plan's Reconciliation rows (trust, project config), `server.md` D3,
  `explore-mcp.md` 4 and 5; API.md (trust schemas and module); `SH/util/{hooks,trust,mcp-config,command-template}.ts`;
  `S/services/{project-config,project-trust}/types.ts` (frozen); `S/workspace/{paths,sensitive}.ts`
  (`resolveWorkspacePath`, `openWorkspaceFile`); `S/services/customizations/discover.ts:1-22,124-176` (the reader to
  copy: `rel` equality, O_NOFOLLOW, caps); `S/services/customizations/index.ts:165-212` (the invalidation pattern);
  `S/plugins/{loader,host}.ts` (`sha256Hex` `loader.ts:65`, the plugin `trust(id, sha256)` → 409 `stale` precedent
  `host.ts:1135-1155`); `S/security/ssrf.ts` (`classifyAddress`).
- **Tasks.**
  1. **W11.3-T1 Config reader (`project-config`)** — `snapshot(projectId, { signal, refresh })` reads
     `.claude/settings.json`, `.claude/settings.local.json`, `.harness/settings.json`, `.harness/settings.local.json`
     and `.mcp.json` through `resolveWorkspacePath` (`rel` equality: no link anywhere on the path) / `openWorkspaceFile`
     (O_NOFOLLOW, regular files), ≤ 256 KiB before `JSON.parse`; parses with `readSettingsHooks` / `parseMcpJson`;
     referenced files from `extractCommandFileRefs` read and hashed (≤ 8, ≤ 1 MiB; missing, too large, linked or
     sensitive → `sha256: null` + warning `referenced-file-missing`); every item's `sha256 = sha256Hex(trustHashInput(
     item))`; diagnostics with project-relative paths, never contents. Cache 10 s, single flight, dropped on
     `workspace.changed` of the project, `project.changed` and `run.finished` (shell writes emit no
     `workspace.changed`); the verify member recomputes one item right before a spawn. *Accept:* `realpath(mkdtemp())`
     projects: a linked settings file, a linked `.claude` folder, an over-cap file, invalid JSON → diagnostics and no
     content in the answer; a reformatted settings file keeps every hash; editing the command or the referenced script
     changes it.
  2. **W11.3-T2 Approved set** — `approved(projectId)` → a memoized `Set` of the table rows; cleared on approve, revoke
     and project deletion.
  3. **W11.3-T3 Listing** — `list(projectId)`: hooks + MCP servers + the project command files with `!` spans (bodies
     through `customizations.load`, spans through `planCommandExpansion`; the hash input `{ kind: 'command', name,
     spans, refs }`); each item `{ kind, sha256, state, label, path, refs, warnings, detail }` with warnings
     `private-network` (an http / sse host classified private or loopback), `referenced-file-missing`,
     `runs-repository-code` (a command that runs repository code through a package manager or build tool; W11.3 fixes
     the token table with a test); `orphaned` (approved hashes the scan no longer finds), `scannedAt`, `available`,
     `issue?`; the optional `changed` of open point 12 if C34 added it. *Accept:* the listing of a fixture with every
     kind; the warnings.
  4. **W11.3-T4 Approve** — `POST /projects/:id/trust { items ≤ 50 }` (fresh): a re-scan with `refresh`; any hash that
     is not a current item → 409 `stale`, nothing written; rows inserted (`kind`, `label`, `created_at`); events
     `project-trust.changed { projectId, pending }` + `hooks.changed { projectId }`. *Accept:* 403 without fresh auth;
     a wrong hash → 409; an approved hook appears in the hooks snapshot.
  5. **W11.3-T5 Revoke** — `DELETE /projects/:id/trust/:sha256` (204, not fresh, idempotent; also removes an orphaned
     hash); the same events. *Accept:* revoke of an unknown hash → 204; the hook drops out of the snapshot.
  6. **W11.3-T6 Lifecycle** — rows cascade with the project (foreign key); never in backups or exports; delete-all
     keeps them (`S/services/data/index.ts:124`, W11.7's file: a test only). *Accept:* the cascade.
- **Tests.** The tasks above; no file content or command at `info`.
- **Verify.** Server commands.

### W11.4 project-mcp-server (k4)

- **Mission.** Project `.mcp.json` servers: the encrypted per-project variables, the lazy runtimes, `toolsFor`,
  shadowing, the stop paths, the status, safe mode, the routes and `project-mcp.changed`.
- **Owned.** `S/mcp/project*`, `S/http/routes/project-mcp*`.
- **Read-only highlights.** ADR-050, ADR-049; the plan's Reconciliation row (project MCP) and section 3, `server.md` D4,
  `explore-mcp.md`; API.md (project MCP schemas and module); `S/mcp/types.ts` (frozen `ProjectMcpManager`);
  `S/mcp/{index,stdio-transport,mcp-tools,policy,errors}.ts` (`createMCPClient` usage `index.ts:538-547`, the http
  transport with `redirect: 'error'` `:415`, `mcpToolDefinition` `mcp-tools.ts:96`, `mcpToolPolicy` `policy.ts:12-21`,
  the generation pattern `:67-89`, `ChildProcessMcpTransport` with `processGroup`); `S/services/secrets/types.ts`
  (scope `project:<projectId>`); `SH/util/mcp-config.ts`; `S/services/project-config/types.ts`; the MCP fixtures.
- **Tasks.**
  1. **W11.4-T1 Variables** — secret scope `project:<projectId>`, names `mcp.var.<NAME>` (`MCP_VARIABLE_NAME_PATTERN`);
     `PUT /projects/:id/mcp/variables { values: { NAME: string | null } }` (fresh; ≤ 50 keys; null clears); values
     registered with the redactor; expanded with `expandVariables`, never from `process.env`; a change restarts the
     affected runtimes; `project-mcp.changed`. *Accept:* the stored values are ciphertext in the DB; 403 without fresh
     auth; a server started with `MCP_TOKEN=env-leak` in its own environment still sends the stored value.
  2. **W11.4-T2 Runtimes** — one per (project, id) with a generation; created lazily by `toolsFor(projectId, { signal,
     waitMs: 5000 })` → `{ tools, shadowed, unavailable }`; states `pending` (not approved), `needs-variables`,
     `idle`, `connecting`, `connected`, `error`, `disabled` (safe mode); verify-before-run (the `.mcp.json` item
     re-hashed) before every start. *Accept:* no process at boot; the first project chat connects.
  3. **W11.4-T3 Transports** — stdio through `ChildProcessMcpTransport` with `processGroup: true`, cwd = the project
     root, env = `stdioEnvironment` + the expanded declared env; http / sse through the SDK with `redirect: 'error'`,
     http(s) only; the connect timeout and the `tools/list` caps of the global manager. *Accept:* the stdio fixture, the
     http fixture on port 0, `${VAR:-d}`, a missing variable → `needs-variables` and no connect.
  4. **W11.4-T4 Tools and shadowing** — `mcpToolDefinition(tool, { serverId: id, pluginId: 'core-mcp', serverPolicy:
     'ask', call })` (policy from annotations only); names `mcp__<id>__<tool>`; hooks see `mcp__<name>__<tool>`; a
     project server whose id equals a global server id → `shadowed` (C37's `assembleTools` drops the global's tools in
     that project's chats only); servers not ready within the wait → `unavailable` (C37 emits the notice). *Accept:* the
     tools only in that project's chats; `My_Server.v2` mapped; shadowing only in that project.
  5. **W11.4-T5 Stops** — after `projectMcpIdleMs` (10 min) without a run (first cut); on revoke and on a hash change
     (subscribed to `project-trust.changed` and the project-config invalidation, open point 8); a variables change
     (restart); project deletion (`project.changed { project: null }` → `stopProject` + `secrets.deleteScope(
     'project:<id>')`); shutdown (`stop()`). *Accept:* pid and group dead after each path (the grandchild fixture).
  6. **W11.4-T6 Routes and events** — `GET /projects/:id/mcp` (`{ items: [{ id, name, transport, state, sha256, error?,
     tools, shadows?, missingVariables }], variables: [{ name, set, hint, usedBy }] }`; 404 unknown project), `PUT
     …/variables`, `POST /projects/:id/mcp/:serverId/reconnect` (waits ≤ 10 s like the global reconnect; 404 unknown
     server; safe mode → the answer API.md fixes); `project-mcp.changed { projectId, servers }`. *Accept:* route tests
     for every answer.
- **Tests.** The tasks above; variable values, resolved env / args / headers never logged at `info`; loopback only.
- **Verify.** Server commands.

### W11.5 commands-server (k5)

- **Mission.** `!` spans and `@path` in command files (trust, execution, the frozen expansion), user-invocable skills
  in `/`, and the `prepareRun` call sites (prompt hooks, output style, the expansion host, the new notices).
- **Owned.** `S/chat/{commands,prepare,context,notices}*`, `S/chat/inline/**`, `S/http/routes/commands*`.
- **Read-only highlights.** ADR-044, ADR-045, ADR-052; the plan's Reconciliation rows (commands `!` / `@`, skills),
  `server.md` D6, `explore-catalog.md` 3 and 4; API.md (`GET /commands`, 409 `untrusted`, `metadata.command`);
  `SH/util/{command-template,arguments,trust}.ts`; `S/chat/{pipeline,tools}.ts` (frozen), the C37 stubs;
  `S/workspace/{shell,paths,sensitive}.ts`; `S/services/project-trust/types.ts`; `S/services/customizations/types.ts`.
- **Tasks.**
  1. **W11.5-T1 Expansion host** — `CommandContext.expansion = { workspace(), shellEnabled, trusted(projectId, sha256),
     projectId }` built in `buildUserMessage` (`prepare.ts:339-347`); the workspace opened once and lazily (commands
     resolve before `openRunWorkspace`, `prepare.ts:483-484`). *Accept:* the workspace opens at most once per turn.
  2. **W11.5-T2 `!` spans** — in `definitionResolution` (`commands.ts:188-216`) after the load and before the arguments
     (`:210`): `planCommandExpansion(body)`; spans present → no project chat → 400 `validation_error`; the shell off →
     409 `conflict` `disabled`; trusted sources only: personal, a loaded plugin template, a project file whose
     `sha256(trustHashInput({ kind: 'command', name, spans, refs }))` is approved (else 409 `untrusted`); the spans run
     one after another in the project root through `runShellCommand` (`S/chat/inline/**`), 30 s each, 60 s in total
     (later spans `[skipped: time limit]` through `formatShellSpanOutput`), 16 KiB each; verify-before-run before the
     first span; any tool mode. *Accept:* `/x ; touch pwned` → no `pwned` file (arguments never inside a span); an
     unapproved project file → 409 `untrusted`; personal and plugin spans run; non-project 400; shell off 409.
  3. **W11.5-T3 `@path`** — project chats only: `resolveWorkspacePath` + the secret-looking-path refusal +
     `openWorkspaceFile`; ≤ 32 KiB each, ≤ 10; binary → a marker; missing or refused → the reference stays text.
     *Accept:* `@README.md` inlined; `@../outside.md`, `@.env` and a linked file refused.
  4. **W11.5-T4 Render and freeze** — `renderCommandExpansion(plan, { shell, files }, input)`; ≤ 64 KB, else 400
     (`tooLong`); stored in `metadata.command.expansion` with `kind: 'command'` and `inlined { shell, files }`;
     regenerate and continuation reuse it (`context.ts` `applyCommandExpansions` unchanged); queued commands expand when
     their turn starts; span output not journaled. *Accept:* a regenerate keeps the span's counter file unchanged; a
     v1.6 `/status` expansion is reused as stored.
  5. **W11.5-T5 Skills in `/`** — resolution client → harness → definition command → plugin registry command → an
     active `userInvocable` skill (`catalog.skill(name)`); a command wins a name; the expansion =
     `expandArguments(content, input)` (text only, no spans); invocation `{ kind: 'skill', source }`; `COMMAND_PREFIX`
     widened to 64 (`commands.ts:48`; command names stay ≤ 32); `listServerCommands` (`:275`) adds skills (`kind:
     'skill'`, `argumentHint`); `isServerCommandFor` (`:309`) includes them; `GET /commands?projectId`. *Accept:*
     `/deploy prod` expands; a command `deploy` wins; `user-invocable: false` hidden; a `disable-model-invocation` skill
     still runs as `/internal`.
  6. **W11.5-T6 Prepare call sites** — the C37 stubs wired to the real modules: SessionStart / UserPromptSubmit
     (W11.2's `hooks-prompt.ts`), the style resolution (W11.6's `resolveRunOutputStyle`) → `PreparedRun.outputStyle`;
     `chatRequestBody.outputStyle` saved by `ensureChat` for new chats; the texts of the three new notices in
     `notices.ts` (`output-style-unavailable`, `hook-continuation-limit`, `project-mcp-unavailable`). *Accept:* prepare
     tests (a new chat with `outputStyle` keeps it; the notices once).
- **Tests.** The tasks above; every existing prepare / commands / context test stays green; `!` commands, their output
  and `@file` contents never logged at `info`.
- **Verify.** Server commands.

### W11.6 styles-catalog-server (k6)

- **Mission.** The catalog kind `style` (discovery, builtins, plugin styles, user rows), the effective style and its
  instruction block, `keep-coding-instructions`, and the model-invocation filter of skills.
- **Owned.** `S/services/customizations/**` (not `types.ts`), `S/chat/{params,output-style,skills}*`,
  `S/builtin-plugins/core-agent/skill*` (open point 6).
- **Read-only highlights.** ADR-044, ADR-045, ADR-051; the plan's Reconciliation row (output styles) and section 4,
  `server.md` D5, `explore-catalog.md` 1, 2, 4, 5; `SH/util/{definitions,output-styles}.ts`;
  `S/services/customizations/types.ts` (frozen `styles()` / `style(name)`); `S/builtin-plugins/core-agent/styles.ts`
  (C38); `S/registry/types.ts` (`styles`); `S/chat/{pipeline,steps}.ts` (frozen).
- **Tasks.**
  1. **W11.6-T1 Discovery** — `DEFINITION_KIND_FOLDERS` (`discover.ts:34`) + `output-styles` (top-level `*.md`; 8
     project folders), the `discoverProject` switch (`:526`), `isDefinitionPath` (`index.ts:108-123`, so a
     `workspace.changed` in a style folder drops the cache), `entryFromParse` (`entries.ts:83`: `label`,
     `keepCodingInstructions`, `userInvocable`, `modelInvocable`), the snapshot getters `styles()` / `style(name)`
     (`snapshot.ts:78-99`). *Accept:* `.harness` `terse` over `.claude` `terse` (one shadowed); `broken.md` invalid;
     `explanatory.md` `reserved-name`.
  2. **W11.6-T2 Builtins and plugin styles** — `default` / `explanatory` / `learning` from `core-agent/styles.ts` in
     `builtins.ts`; plugin entries from `registry.styles` (`plugins.ts:26-42`, fixing the fall-through at `:69`);
     `onRegistryChange` (`index.ts:202`) covers styles. *Accept:* a plugin style is listed and gone after the plugin is
     disabled.
  3. **W11.6-T3 User rows and backups** — kind `style` in the store (the 200-per-kind cap); personal styles in
     `customizations.json` (`store.ts:335-399`); the restore turns personal commands with `!` spans off (open point 9).
     *Accept:* store tests.
  4. **W11.6-T4 Effective style (`S/chat/output-style.ts`)** — `resolveRunOutputStyle`: the name = the chat's
     (`chats.settings.outputStyle`) ?? `projects.output_style` (from the row, independent of the folder) ?? the setting
     `outputStyle` (`effectiveStyleName`); an inactive or missing entry → `default` + the notice
     `output-style-unavailable` once (through `alreadyNoticed`); the body through `customizations.load` →
     `PreparedRun.outputStyle`. *Accept:* chat > project > global; an unknown name → the notice once.
  5. **W11.6-T5 Instructions (`params.ts:258-274`)** — `RunParamsInput.outputStyle` → `joinInstructions(styleBlock,
     global, workspaceBlock(ws, keep ? tools : []), ...agentBlocks(mode, tools, listings, { codingHints: keep }), file,
     project, chat)`; `styleBlock = outputStyleBlock(style)`; `default` adds nothing; `keep = false` drops the workspace
     tool rules, `TODO_HINT` and `TASK_HINT` (the head line, the plan block and the agent-type / skill listings stay —
     they are the format contract of the mocks); main agent only (sub-agents never pass it). *Accept:*
     `params.test.ts` (the block first; keep = false; a child without a style).
  6. **W11.6-T6 Skills** — `disable-model-invocation` removes a skill from `skillsBlock` (`params.ts:216`), from
     `skillsAvailable` and from `loadSkill` (`skills.ts:153-208`: a tool error listing the model-invocable skills);
     `user-invocable` is read by W11.5 from the entry. *Accept:* `internal` absent from the skills block and refused by
     the `skill` tool.
- **Tests.** The tasks above; style bodies never logged at `info`.
- **Verify.** Server commands.

### W11.7 plugins-data-server (k7)

- **Mission.** The plugin API 1.5.0 host (registries, context, declarative contributions, trust), the example plugin
  `hook-pack`, every `data-hook` consumer outside the model history, backups, and the project side of output styles and
  deletion.
- **Owned.** `S/registry/**` (not `types.ts`), `S/plugins/{context,declarative,loader,host}*`,
  `examples/plugins/hook-pack/**`, `examples/plugins/examples.test.ts` (open point 7), `S/services/data/**` (not
  `types` / `references`), `S/services/chats/{export,text,import}*`, `S/services/shares/**`,
  `S/services/projects/index*`, `S/http/routes/projects*`.
- **Read-only highlights.** ADR-008, ADR-024, ADR-031, ADR-048, ADR-051, ADR-052; the plan's Reconciliation row
  (plugin API 1.5.0) and section 6, `server.md` B (plugin API) and D7; PLUGINS.md 1.5.0; `SDK/**` (1.5.0),
  `SH/schemas/{plugin-manifest,plugin-data,plugins,data}.ts`; `S/registry/types.ts` (frozen); `S/plugins/loader.ts`
  (`contentHash` `:65-78`, `declaredContributions` `:151`), `S/plugins/host.ts` (`isPinned` / `trustOf` `:270-289`,
  safe mode `:704`), `S/plugins/declarative.ts:427` (the command registration precedent);
  `S/services/shares/snapshot.ts` (`sanitizePart`), `S/services/chats/{export,text,import}.ts`,
  `S/services/data/{backup,restore,index}.ts`.
- **Tasks.**
  1. **W11.7-T1 Registries** — `registry.styles` / `registry.hookCommands`: per-plugin ownership, disposed when the
     plugin is disabled or unloaded, `onChange`; a duplicate style name across plugins → a conflict (the second refused,
     logged in the plugin log); builtin style names refused; validation (`validate.ts`: sizes, names, ≤ 50 hooks, ≤ 20
     styles). *Accept:* registry tests.
  2. **W11.7-T2 Context** — `ctx.outputStyles.register(definition)` → a disposable owned by the plugin (replacing C34's
     compile-fix member); the code events `prompt.submit`, `session.start`, `run.stop`, `subagent.stop`,
     `compact.before`, `notification` and the `tool.after` output `context?` dispatched through `registry.hooks` (3 s
     guard). *Accept:* a code plugin fixture registers a style and receives each event.
  3. **W11.7-T3 Declarative and trust** — `contributes.hooks` (≤ 50 handlers, `readHooksConfig(…, { source: 'plugin'
     })`) → `registry.hookCommands` with the plugin root; `contributes.outputStyles` (≤ 20) → `registry.styles`;
     `declaredContributions` / `registry.contributions` gain `hooks` / `outputStyles`; a manifest that
     `manifestRequiresTrust` (hooks, or a `!` span in a command template) stays `untrusted` until pinned (installed with
     fresh auth); the declarative trust hash still covers `plugin.json` only (plugin scripts unpinned, documented);
     plugins with `engines ^1.4.0` load unchanged. *Accept:* loader / declarative tests (untrusted → no hook runs;
     trusted → the hooks are in the snapshot).
  4. **W11.7-T4 Example `hook-pack`** — a PostToolUse hook running a POSIX `sh` script from the plugin folder
     (`"$CLAUDE_PLUGIN_ROOT"/…`), one output style, a README, its own `harness-forge.d.ts`; declarative or code (W11.7
     picks, reported); `EXAMPLE_IDS` gains `hook-pack`. *Accept:* `examples.test.ts` (installs and lists it).
  5. **W11.7-T5 `data-hook` consumers** — search text (`messagePlainText`: the context and the reason); Markdown export
     (a "Hook: <event> (<outcome>)" line + the context / reason); import (a chat export with hook parts and a hook
     carrier round-trips through `harnessDataSchemas`); share snapshots drop `data-hook` parts and hook carriers (the
     allowlist; a hook-denied tool reads "Denied"). *Accept:* `export.test.ts`, `text.test.ts`, `import.test.ts`,
     `snapshot.test.ts` (one case per consumer).
  6. **W11.7-T6 Backups** — the settings `outputStyle` / `hooksEnabled` included; personal styles in
     `customizations.json`; `hooks`, `project_trust` and the project MCP variables never; a personal command with spans
     restored `enabled: false` (W11.6's store); delete-all keeps hooks, approvals and variables. *Accept:*
     `backup.test.ts` / `restore.test.ts` round trip on a fresh data dir.
  7. **W11.7-T7 Projects** — `projects.output_style` read and written (`PATCH /projects/:id { outputStyle }`,
     `ProjectSummary.outputStyle`); project deletion cascades `project_trust` (foreign key) while W11.4 stops the MCP
     runtimes and deletes the variables and W11.1 drops the hooks cache (events, open point 8). *Accept:* projects
     route tests (the style round trip; the cascade).
- **Tests.** The tasks above.
- **Verify.** Server commands.

### W11.8 customize-web

- **Mission.** The Customize Hooks and Output styles tabs, the hook editor and the import dialog, the hooks store, the
  skill and style fields of the editor, the General output style field, and the plugin hooks / output styles sections
  and trust warning.
- **Owned.** `W/pages/settings/customize.vue`, `W/components/settings/customize/**`, `W/stores/{hooks,customizations}*`,
  `W/components/settings/{GeneralSettings,general}*`, `W/components/plugins/detail/{PluginContributions,
  PluginCustomizationList,PluginHookList}*`, `W/components/plugins/list/plugin-display*`,
  `W/components/plugins/install/{install,TrustWarning}*`.
- **Read-only highlights.** UI.md 2.18, 8.4, 8.8, 9.4, 9.13, 10.8, 11.8, 12, 13.12, 14, 15; `.tmp/p11-designs/web.md`
  A, B (Hooks tab, styles, settings fields, plugins), C (wireframes), E (copy); API.md (hooks, customizations,
  settings); `SH/util/{hooks,definitions,output-styles}.ts`, `SH/schemas/hooks.ts`; `ProjectTrustDialog` props and
  `useProjectTrustStore().pending` (W11.9's, frozen); `styleOptions` / `automaticStyle` (W11.10's, frozen).
- **Tasks.**
  1. **W11.8-T1 Hooks store** — `useHooksStore` behind C39's frozen signature: single flight per key, per-key versions,
     `maxAgeMs`, an answer older than the last event never wins, stale on `hooks.changed` / `project-trust.changed` /
     `plugin.changed`; CRUD through `useApi`; `{ enabled: false }` optimistic with rollback; 403 `login` thrown for the
     component's `useFreshAuth().run`. *Accept:* `hooks.test.ts` (single flight, staleness, event ordering, rollback).
  2. **W11.8-T2 Tabs** — Agents · Commands · Skills · Output styles (`?tab=output-styles`) · Hooks (`?tab=hooks`); the
     page description "Agents, commands, skills, output styles and hooks: yours, your projects' and your plugins'."; the
     header buttons follow the tab ("New output style" / "New hook"); Import… opens the `.md` import for kinds and the
     JSON import for hooks; `customize-tab[data-value|data-count]`. *Accept:* `CustomizeSettings.test.ts`.
  3. **W11.8-T3 `HooksPanel`** — the "Run hooks" switch (`hooks-enabled`, setting `hooksEnabled`, help "Shell commands
     that run at points of the agent's work, like before a tool call. Off: no command hook runs, from any source."); the
     server-switch alert (`hooks-disabled[data-reason]`: "Hooks are turned off on this server
     (HF_WORKSPACE_SHELL=0)." / "… (safe mode)."); sections Personal (editable) · In {project} (the scanned files in
     mono, "Review {n}…" → `ProjectTrustDialog`, `customize-trust-review`) · From plugins (command and code hooks);
     rows (`HookRow`: event, matcher or "All tools", mono command, source, "timeout {n}s", state badges "Needs
     approval" / "Approved" / "Plugin not trusted" / Off / Invalid with the diagnostics) sorted by event order; the
     row menus (personal: Edit… · Duplicate · Turn off / on · Copy as JSON · Delete…; project: Review… · Copy to
     personal · Copy as JSON; plugin: Open plugin · Copy as JSON); empty states. *Accept:* `HooksPanel.test.ts`,
     `HookSection.test.ts`, `HookRow.test.ts`, `hooks.test.ts` (the pure module).
  4. **W11.8-T4 `HookEditor`** — a right `Sheet` (`w-full sm:max-w-2xl`, sticky 40 px footer), fresh auth inside
     ("Saving a hook needs your password."): the warning (`hook-warning`), Event (`hook-event`, descriptions from
     `HOOK_EVENT_COPY`), Tools (`hook-matcher`, for tool events; the preview `hook-matcher-preview` "Matches {list}" /
     "No tool is named {name} now." through `matcherPreview`, debounced 300 ms, `aria-live="polite"`), Command
     (`hook-command`, mono, help text), Timeout (1 – 600 seconds), On; Mod+Enter saves; "Discard changes?" on a dirty
     close; server errors mapped (`hook-error[data-code]`); opens on Event (new) or Command (edit); no Tab capture.
     *Accept:* `HookEditor.test.ts` (create, edit, invalid matcher, fresh-auth prompt, discard confirm, Mod+Enter).
  5. **W11.8-T5 `HookImportDialog`** — paste Claude Code settings JSON (the whole file or its `hooks` object) or Choose
     file… (first cut); `importHooks(text)` → the preview "Found {n} hooks" with invalid items unchecked
     (`hook-import-item[data-state=invalid]`, "Use tool names, | and * only.") and the ignored notes ("Ignored: "prompt"
     hooks aren't supported."); "Add {n} hooks" (one fresh-auth window for all); "This isn't valid JSON." / "No hooks
     found.". *Accept:* `HookImportDialog.test.ts` (a real Claude settings file, an invalid matcher, a prompt hook).
  6. **W11.8-T6 Output styles tab** — rows through the existing sections (Personal · In {project} · From plugins ·
     Built-in), the row meta "Keeps coding instructions" / "Replaces coding instructions", the badges "Your default" /
     "Default in {project}", the menu item "Use by default" (`customization-set-default`); `StyleScopeBar`
     (`customize-style-default`: "Your default [▾]" without a project, "Style in {project} [Same as your default ▾]"
     with one → `projects.update(id, { outputStyle })`); the editor for `style` (name, description, "Keep coding
     instructions" `customization-keep-coding`, the body; no Tools / Model fields); empty states. *Accept:*
     `StyleScopeBar.test.ts`, `CustomizationEditor.test.ts` (the style kind), `customize.test.ts`.
  7. **W11.8-T7 Skill fields** — the editor's "Show in the slash menu" (`customization-user-invocable`) and "Only when
     you run it" (`customization-model-invocation`, help "The agent doesn't load it by itself; it runs only as /name.")
     and the argument hint for skills. *Accept:* editor tests (round trip through `formatDefinition`).
  8. **W11.8-T8 General** — "Output style" (`settings-output-style`, the setting `outputStyle`, help "How replies are
     written in chats that don't choose one. Projects can choose their own."). *Accept:* `GeneralSettings.test.ts`.
  9. **W11.8-T9 Plugins** — `PluginContributions`: the Hooks section through `PluginHookList` (`plugin-hooks`, rows
     `plugin-hook[data-event|data-kind]`: command hooks with event, matcher and the mono command + "Runs only while you
     trust this plugin."; code hooks as chips) and an Output styles section (`PluginCustomizationList` kind `style`,
     "How the agent writes its replies."); `TrustWarning` lists the hook commands under "Runs these commands"
     (`install.ts` next to `stdioCommands`, `:252`); `contributionsSummary` adds "2 hooks · 1 output style". *Accept:*
     `PluginContributions.test.ts`, `PluginHookList.test.ts`, `TrustWarning.test.ts`, `plugin-display.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W11.9 trust-mcp-web

- **Mission.** The project trust dialog and chip, the project MCP dialog, their stores and the Projects / chat-chip
  entry points.
- **Owned.** `W/components/projects/{trust,mcp}/**`, `W/components/projects/ChatProjectChip*`,
  `W/stores/{project-trust,project-mcp}*`, `W/components/settings/projects/ProjectsSettings*`,
  `W/components/chat/ChatHeader*`.
- **Read-only highlights.** UI.md 2.18, 5.6, 7.33, 9.10, 10.8, 11.8, 13.12, 14, 15; `.tmp/p11-designs/web.md` B (trust
  review, project MCP), C, E; API.md (trust, project MCP, events); `SH/schemas/project-trust.ts`;
  `W/components/plugins/mcp/McpSecretRows*` and `mcp-form.ts` (patterns to copy, not to edit); `CHAT_VIEW_ACTIONS`
  (W11.11's host, frozen).
- **Tasks.**
  1. **W11.9-T1 Stores** — `useProjectTrustStore` and `useProjectMcpStore` behind C39's signatures: single flight,
     per-key versions, events (`project-trust.changed` carries `pending`; `project-mcp.changed` replaces the servers),
     409 `stale` → refetch, then throw; 403 → the component's `useFreshAuth().run`. *Accept:* `project-trust.test.ts`,
     `project-mcp.test.ts`.
  2. **W11.9-T2 `ProjectTrustDialog` + `ProjectTrustItem`** — "Review {project}"; the intro ("Files in this project can
     run commands on your server. Nothing below runs until you approve it. Any change needs a new approval."); the
     warning (`project-trust-warning`); the filter Needs review · {n} / All · {n}; groups Hooks · MCP servers · Commands
     with shell lines (`project-trust-group[data-kind|data-count]`); each item (`<article>` "{kind} {label}, {state}")
     with the exact command / args / URL in a `<pre>` named "Command" (Copy), the environment / header / variable
     names, the file, the warnings, the state (New · Changed (open point 12) · Approved); a per-item checkbox; a
     per-group "Select all {n}" only after the group was shown; **no Approve all**; Approve never on Enter and never the
     default button; Revoke (no fresh auth; focus to the item's checkbox); "Approve {n} items" with fresh auth
     ("Approving project commands needs your password."); the stale alert ("{n} items changed while you were
     reviewing. Check them again.", `role="alert"`, takes focus); the empty state; 390 px full screen with a sticky
     footer; closing returns focus to the opener. *Accept:* `ProjectTrustDialog.test.ts`, `ProjectTrustItem.test.ts`,
     `project-trust.test.ts` (the pure module).
  3. **W11.9-T3 Chip and chat-chip menu** — `ProjectTrustChip` in `ChatHeader` (only while items are pending: "{n} to
     review", accessible name "Review {n} items in {project} that can run commands", opens the dialog through
     `CHAT_VIEW_ACTIONS.openProjectTrust`); `ChatProjectChip` menu items "Review commands and hooks…"
     (`chat-project-trust`) and "MCP servers…" (`chat-project-mcp`). *Accept:* `ProjectTrustChip.test.ts`,
     `ChatHeader.test.ts`, `ChatProjectChip.test.ts`.
  4. **W11.9-T4 `ProjectMcpDialog` + `ProjectMcpServerRow`** — "MCP servers in {project}" + the intro; rows with status,
     transport, the exact command or URL, "Replaces your server {id} in this project's chats.", Reconnect, Review…
     while pending; the per-project variables panel (open point 10: write-only inputs with masked hints, "Default:
     {value}", Clear, "Save variables" with fresh auth "Saving project variables needs your password.", the help
     "Values are encrypted on this server and used only for this project's servers. harness-forge never reads them from
     the server's environment."); "This project has no .mcp.json."; 390 px full width. *Accept:*
     `ProjectMcpDialog.test.ts`, `ProjectMcpServerRow.test.ts`.
  5. **W11.9-T5 Projects settings** — the row menu items "Review commands and hooks…" (`project-trust`) and "MCP
     servers…" (`project-mcp`) and the meta badge "{n} to review" (`project-trust-pending[data-count]`, fetched lazily
     per row). *Accept:* `ProjectsSettings.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W11.10 composer-web

- **Mission.** The output style picker and `/output-style`, the Skills group of the slash menu, the slash-menu trust
  badge, the composer refusal and `restoreInput`.
- **Owned.** `W/components/chat/composer/**`.
- **Read-only highlights.** UI.md 7.8, 7.28, 7.32, 10.8, 11.8, 12, 13.12, 14, 15; `.tmp/p11-designs/web.md` B
  (composer style picker, slash menu, refused prompt), C, E; API.md (`GET /commands`, 409 `hook-blocked` /
  `untrusted`); the customizations store (`catalog(projectId)` style entries; W11.8's, frozen); the project-trust store
  (W11.9's, frozen).
- **Tasks.**
  1. **W11.10-T1 `OutputStyleMenu`** — in the left tools after `EffortMenu`, hidden for image models; the trigger a
     ghost h-8 `Feather` icon + the label (≥ `sm`) when the effective style is not Default, icon-only with a dot below
     `sm` (`output-style-trigger[data-value|data-source]`, named "Output style: {name}" + "(automatic)"); a radio group:
     "Automatic" ("Uses {name}, set for {project}" / "Uses {name}, your default in Settings"), the builtins, then
     personal, project and plugin styles (description under the name, the source muted on the right); footer "Manage
     output styles" → `/settings/customize?tab=output-styles&project=`; `styleOptions` / `automaticStyle`. *Accept:*
     `OutputStyleMenu.test.ts`, `output-style.test.ts`.
  2. **W11.10-T2 `/output-style`** — without an argument it opens the menu (`{ type: 'open', menu: 'style' }`);
     `/output-style <name>` or `auto` sets the style (`set-style`); an unknown name → "Unknown output style "{value}".
     Use auto, default, explanatory, learning…" (`resolveStyleQuery`); the description "Set the output style".
     *Accept:* `slash-commands.test.ts`, `ChatComposer.test.ts`.
  3. **W11.10-T3 Skills group** — `SlashGroup` `skill` last ("Skills", `slash-menu-item[data-group=skill]`, `BookOpen`,
     the argument hint and the source on the right); names up to 64 characters in `HINT_PATTERN` / `QUERY_PATTERN` /
     `COMMAND_PATTERN` (`slash-commands.ts:96,137,161`); project commands with unapproved spans show "Needs approval"
     (`ShieldQuestionMark`, `data-trust="pending"`; from the project-trust store's pending `command` items; first cut);
     selecting one still inserts it. *Accept:* `SlashMenu.test.ts`, `slash-commands.test.ts`.
  4. **W11.10-T4 Refusal** — `ComposerRefusal` above the text inside the card (`composer-refusal[data-code|data-event]`,
     `role="alert"`, linked from the textarea's `aria-describedby`; focus stays in the textarea): "A hook blocked this
     message" + the reason + "{event} · {source}"; the `untrusted` variant "/{name} runs shell lines you haven't
     approved." + Review… (emits `review` → the host opens the trust dialog); it clears on a text change, a send or ×
     ("Dismiss"), never on Esc; `showRefusal` / `restoreInput` (text **and** files) exposed; `refusalOf(error)` maps 409
     `hook-blocked` / `untrusted`. *Accept:* `ComposerRefusal.test.ts`, `ChatComposer.test.ts`.
- **Tests.** The tasks above; no `//` inside a component prop value.
- **Verify.** Web commands.

### W11.11 session-web

- **Mission.** The session side: the chat's output style choice and request body, the origin `hook`, the hook
  activity, the refusal flow, hosting the trust / MCP dialogs, the three events and the announcements.
- **Owned.** `W/composables/{useChatSession,useServerEvents}*`, `W/components/chat/{ChatView,chat-context}*`,
  `W/stores/chat-queue*`.
- **Read-only highlights.** UI.md 7.31 – 7.33, 10.8, 11.8, 14, 15; `.tmp/p11-designs/web.md` A 5 – 7, 12, 13, B, D;
  API.md (`run.started.origin`, `data-activity`, the 409 reasons, the events, `chats.update` settings);
  `isHookCarrierMessage` / `hookAnnouncement` (W11.12's, frozen); `showRefusal` / `restoreInput` / `refusalOf`
  (W11.10's, frozen); the dialog props (W11.9's, frozen).
- **Tasks.**
  1. **W11.11-T1 Output style** — `outputStyle` = the chat's own choice (`ChatDetail.settings.outputStyle`); writing it
     saves through `chats.update(id, { settings: { outputStyle } })` and applies from the next turn; `pinChoices`
     (`useChatSession.ts:541`) never pins it ("Automatic" stays automatic); a new chat sends `outputStyle` in the
     request body; the announcement "Output style: {name}". *Accept:* session tests (per-chat memory across a reload;
     never pinned).
  2. **W11.11-T2 Origin `hook`** — `run.started` with `origin: 'hook'` joins the queue / task path
     (`useChatSession.ts:962`): `refresh()` + `resumeStream()` when the `userMessageId` is not on the shown path
     (deferred until idle); a second tab follows. *Accept:* session tests with two sessions.
  3. **W11.11-T3 Activity** — `activity` `'compacting' | 'hooks' | null` and `hookActivity { event, toolCallId | null }`
     from the transient `data-activity { kind: 'hooks', event, toolCallId? }` (cleared by `idle`); `ChatView` provides
     `HOOK_ACTIVITY`. *Accept:* session tests.
  4. **W11.11-T4 Refusal flow** — `POST /chat` and `POST /chat/:id/queue` answering 409 `hook-blocked` / `untrusted`
     before streaming → `composer.restoreInput(input)` (text + files) and `composer.showRefusal(refusalOf(error))`; the
     `error` watcher (`ChatView.vue:419-441`) and `onSubmitFailed` (`:472`) extended; `isUnstoredFailure`
     (`useChatSession.ts:391`) keeps these unstored; an edit refused by a hook moves the text to the composer and
     reloads the previous version; on `/` no chat is created; Review… opens the trust dialog. *Accept:*
     `ChatView.test.ts` (each path; files restored).
  5. **W11.11-T5 Dialog hosting** — `ChatView` hosts `ProjectTrustDialog` / `ProjectMcpDialog`; `CHAT_VIEW_ACTIONS
     .openProjectTrust(focusSha256?)` / `.openProjectMcp(serverId?)`. *Accept:* `ChatView.test.ts`.
  6. **W11.11-T6 Events** — `useServerEvents` dispatches `hooks.changed` → the hooks store, `project-trust.changed` →
     the trust store and the hooks store, `project-mcp.changed` → the MCP store; `refreshLoaded()` of the three stores
     on reconnect. *Accept:* `useServerEvents.test.ts`.
  7. **W11.11-T7 Announcements and the queue** — "A hook asked the agent to continue" once per new hook carrier
     (`hookAnnouncement`), "A hook blocked {tool}" once per part per tab (as for compaction markers); a queued message
     refused at enqueue returns its text to the composer with the refusal (`W/stores/chat-queue*`). *Accept:*
     `ChatView.test.ts`, `chat-queue.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W11.12 transcript-web

- **Mission.** `HookNote` and the hook block, the tool-row badges and the approval banner, the hook carrier turn, the
  user-message hook parts, the running-hook lines, the command badge, the new notices and the share rows.
- **Owned.** `W/components/chat/{ChatMessage,ChatTranscript,UserMessageBubble,MessageActions,SubmittedPlaceholder,
  chat-format}*`, `W/components/chat/{hooks,parts,agent}/**`, `W/components/share/**`.
- **Read-only highlights.** UI.md 7.28, 7.31, 10.8, 11.8, 13.12, 14, 15; `.tmp/p11-designs/web.md` A 7 – 9, 14, B
  (transcript), C (HookNote variants), E; `SH/chat.ts` (`hookDataSchema`), `SH/util/agent-state.ts`;
  `HOOK_ACTIVITY` (W11.11's, frozen); the project-MCP store for project server names (W11.9's, frozen; read-only).
- **Tasks.**
  1. **W11.12-T1 `HookNote`** (store-free; `role="note"` named "Hook {event}: {summary}"; the toggle with
     `aria-expanded` / `aria-controls`) — by outcome: `context` "Hook added context · {event}" (Show context / Hide
     context → the context as text); a system message "Hook: {message}"; `error` "A {event} hook failed: exit {n}" /
     "… timed out after {n}s" (Show output → `hooks[].error`); `stopped` "A hook stopped the agent: {reason}";
     `blocked` (PostToolUse) "A PostToolUse hook told the agent: {reason}"; `continued` (variant `turn`) "A Stop hook
     asked the agent to continue" + the reason + the caption "Sent to the agent"; the source line "Personal hook" /
     "Project: {path}" / "From {plugin}" (`hookSourceText`). *Accept:* `HookNote.test.ts`, `hook-notes.test.ts`.
  2. **W11.12-T2 `chat-format` and `ChatMessage`** — the block kind `hook` for assistant hook parts not linked to a
     tool; tool hooks through `toolHooksOf` rendered inside the tool row (hooks on `task` calls inline after the
     `TaskBlock`); user-message `data-hook` parts (UserPromptSubmit / SessionStart context) as notes under the bubble;
     the hook carrier (`isHookCarrierMessage`): no bubble, no actions, no edit, no rewind. *Accept:*
     `chat-format.test.ts`, `ChatMessage.test.ts`, `UserMessageBubble` / `MessageActions` tests.
  3. **W11.12-T3 Tool rows** — `ToolHookBadge` in `ToolPart` (`tool-row-hook[data-value=denied|allowed|rewritten]`):
     "Blocked by hook" replaces "Denied" (`ShieldBan`, the body "Blocked by a PreToolUse hook: {reason}"), "Allowed by
     hook" (icon + tooltip), "Input changed by hook" (icon + tooltip; the body shows the rewritten input from the hook
     record next to the model's input, "Original input"); screen-reader texts ", blocked by hook" / ", allowed by hook"
     / ", input changed by hook" (the `ToolRuleBadge` pattern); `ToolApprovalCard.hookReason` → the banner "A hook asks
     you to confirm this call: {reason}" (`tool-approval-hook`); project MCP server names from the project-MCP store.
     *Accept:* `ToolPart.test.ts`, `ToolHookBadge.test.ts`.
  4. **W11.12-T4 Running hooks** — "Running hook…" (shimmer, slot `running-hook`) in the status cell of the matching
     tool row (from `HOOK_ACTIVITY`, an injection because the rows are `v-memo`ed); "Running hooks…" at the end of the
     reply for message-level events (UserPromptSubmit, SessionStart, Stop, PreCompact) even after text
     (`showPlaceholder`, `ChatMessage.vue:214`) and in `SubmittedPlaceholder`. *Accept:* `ChatMessage.test.ts`,
     `ChatTranscript.test.ts`.
  5. **W11.12-T5 Command badge and notices** — `CommandBadge` kind `skill` (`BookOpen`, "Skill") and the tooltip lines
     "Ran {n} shell commands" / "Included {paths}" from `inlined` (first cut for the lines); `NoticePart` texts for
     `output-style-unavailable`, `hook-continuation-limit` ("Stopped after {n} hook continuations in a row.") and
     `project-mcp-unavailable` (with "MCP servers…" through `CHAT_VIEW_ACTIONS`). *Accept:* `CommandBadge.test.ts`,
     `parts.test.ts`.
  6. **W11.12-T6 Share** — hook notes and hook carriers are absent (the server drops them); a hook-denied tool reads
     "Denied" in `ShareToolRow`; skill invocations show their badge. *Accept:* `ShareToolRow.test.ts`,
     `share-view.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### G11P gate probes

- **Mission.** Write `.tmp/gates/P11-A/probe.mjs` (the catalogue in "Gate P11-A" below) during the wave against the
  contracts of this file, API.md and PROVIDERS.md 8; run it after the coordinator's build signal on :8896 – :8898 while
  the coordinator runs e2e on :8899; report every check with its result ("spec differs" when the code is right and the
  spec is not, with the evidence).
- **Owned.** `.tmp/gates/P11-A/**`.
- **Read-only highlights.** `.tmp/gates/P10-A/probe.mjs` (the harness: `startServer`, `client`, `rows`, `check`,
  `section`, `guarded`, `newProject`, `uuidv7`, `msgId`, `chunksOf`, `answer`, `login`, `waitFor`, `events(c)`,
  `writeDefs`, `portsFree`, sentinel hygiene), `.tmp/upgrade-v16-ids.json`, PROVIDERS.md 8 ("Hook mocks (Phase 11)"),
  `S/testing/hook-scripts.ts` (the script bodies to copy into probe projects).
- **Rules.** New helpers `writeHooks(root, file, hooks)`, `hookScript(root, rel, body)` (sh files, invoked as
  `sh <relative path>`; never `sh -c` strings), `trustItems(c, projectId)`, `approve(c, projectId, hashes)` (after a
  fresh login), `mcpHttpFixture()` (loopback, port 0), `copyMcpMin(root)`, `alive(pid)`, `sentinel(path, ms)`,
  `trustRows`, `hookRows`; project folders only in the probe servers' own roots (the seed roots only as copies with
  `projects.path` repointed by SQL); every server and fixture process stopped (kill by port, pids checked) at the end.

### Wave P11-A ownership

These globs are the plan's table plus `examples/plugins/examples.test.ts` for W11.7 (open point 7). The audit cannot
express "except": every `types.ts` of `S`, `S/chat/{pipeline,tools,approval,steps,markers,model-history,agent-scope,
hooks}.ts`, `S/chat/subagent/host.ts`, `S/workspace/shell.ts`, `S/mcp/stdio-transport.ts`, `S/builtin-plugins/
core-agent/**` (except W11.6's `skill*`, open point 6), the mock models, the C35 helpers and the P11-0b stub props stay
frozen despite the globs; `S/services/data/{types,references}*` match W11.7's glob but stay frozen / C36's;
`S/http/routes/{chat,chats,chat-queue}*` also matches `chat-tasks*` (no other owner; W11.2's).

```json
{
  "wave": "P11-A",
  "agents": {
    "W11.1": [
      "apps/server/src/services/hooks/**",
      "apps/server/src/http/routes/hooks*",
      "apps/server/src/testing/fake-hooks*"
    ],
    "W11.2": [
      "apps/server/src/chat/{hooks-prompt,steer,queue,index}*",
      "apps/server/src/chat/{subagent,compaction}/**",
      "apps/server/src/chat/background/**",
      "apps/server/src/http/routes/{chat,chats,chat-queue}*"
    ],
    "W11.3": [
      "apps/server/src/services/{project-config,project-trust}/**",
      "apps/server/src/http/routes/project-trust*"
    ],
    "W11.4": [
      "apps/server/src/mcp/project*",
      "apps/server/src/http/routes/project-mcp*"
    ],
    "W11.5": [
      "apps/server/src/chat/{commands,prepare,context,notices}*",
      "apps/server/src/chat/inline/**",
      "apps/server/src/http/routes/commands*"
    ],
    "W11.6": [
      "apps/server/src/services/customizations/**",
      "apps/server/src/chat/{params,output-style,skills}*",
      "apps/server/src/builtin-plugins/core-agent/skill*"
    ],
    "W11.7": [
      "apps/server/src/registry/**",
      "apps/server/src/plugins/{context,declarative,loader,host}*",
      "examples/plugins/hook-pack/**",
      "examples/plugins/examples.test.ts",
      "apps/server/src/services/data/**",
      "apps/server/src/services/chats/{export,text,import}*",
      "apps/server/src/services/shares/**",
      "apps/server/src/services/projects/index*",
      "apps/server/src/http/routes/projects*"
    ],
    "W11.8": [
      "apps/web/app/pages/settings/customize.vue",
      "apps/web/app/components/settings/customize/**",
      "apps/web/app/stores/{hooks,customizations}*",
      "apps/web/app/components/settings/{GeneralSettings,general}*",
      "apps/web/app/components/plugins/detail/{PluginContributions,PluginCustomizationList,PluginHookList}*",
      "apps/web/app/components/plugins/list/plugin-display*",
      "apps/web/app/components/plugins/install/{install,TrustWarning}*"
    ],
    "W11.9": [
      "apps/web/app/components/projects/{trust,mcp}/**",
      "apps/web/app/components/projects/ChatProjectChip*",
      "apps/web/app/stores/{project-trust,project-mcp}*",
      "apps/web/app/components/settings/projects/ProjectsSettings*",
      "apps/web/app/components/chat/ChatHeader*"
    ],
    "W11.10": [
      "apps/web/app/components/chat/composer/**"
    ],
    "W11.11": [
      "apps/web/app/composables/{useChatSession,useServerEvents}*",
      "apps/web/app/components/chat/{ChatView,chat-context}*",
      "apps/web/app/stores/chat-queue*"
    ],
    "W11.12": [
      "apps/web/app/components/chat/{ChatMessage,ChatTranscript,UserMessageBubble,MessageActions,SubmittedPlaceholder,chat-format}*",
      "apps/web/app/components/chat/{hooks,parts,agent}/**",
      "apps/web/app/components/share/**"
    ],
    "G11P": [
      ".tmp/gates/P11-A/**"
    ]
  },
  "allow": [
    "docs/ROADMAP.md",
    "docs/DECISIONS.md",
    "AGENT.md",
    "pnpm-lock.yaml",
    ".tmp/**"
  ]
}
```

A file a P11-A agent creates outside its globs is a CCR: the coordinator adds it to the wave file at the gate.

### Wave P11-A cross-agent contracts

The props below are frozen in the P11-0b stubs or documented in UI.md 10.8; the server members in the frozen files.

| Producer → consumer | Contract |
|---|---|
| C36 / C37 → every server agent | the service interfaces, the seams, the fakes (W11.2 and W11.5 test with the C36 fake snapshot) |
| W11.1 → W11.2, W11.5 | `HookSnapshot` (`has`, `run` → `HookEventResult` with `record`), `hooks.invalidate` |
| W11.3 → W11.1, W11.4, W11.5 | `projectTrust.approved()`, `projectConfig.snapshot()` and the verify member; `project-trust.changed` (W11.4 reacts, open point 8) |
| W11.4 → the pipeline seam (C37) | `projectMcp.toolsFor(projectId, { signal, waitMs })` → `{ tools, shadowed, unavailable }` |
| W11.7 → W11.1, W11.6 | `registry.hookCommands` (plugin command hooks with their root), `registry.styles`, the code `HookMap` events through `registry.hooks` |
| W11.6 → W11.5 | the catalog's `style(name)` / `styles()`, the skill entries' `userInvocable` / `modelInvocable`; `resolveRunOutputStyle` |
| W11.2 → W11.5 | `hooks-prompt.ts` (the SessionStart / UserPromptSubmit runners W11.5 calls from `prepareRun`) |
| W11.6 ↔ W11.7 | personal styles and the "commands with spans restored off" rule in the customizations store (W11.6), the backup round trip (W11.7) |
| W11.9 → W11.11, W11.8 | the `ProjectTrustDialog` / `ProjectMcpDialog` props; `useProjectTrustStore().pending(projectId)` |
| W11.11 → W11.9, W11.12 | `CHAT_VIEW_ACTIONS.openProjectTrust` / `.openProjectMcp`; `HOOK_ACTIVITY` |
| W11.10 → W11.11 | `showRefusal`, `restoreInput`, `ComposerRefusalData`, `refusalOf(error)` |
| W11.10 ↔ W11.8 | `styleOptions`, `automaticStyle` (W11.10); the catalog style entries of the customizations store (W11.8) |
| W11.12 → W11.11 | `isHookCarrierMessage`, `hookAnnouncement` |
| W11.8 → W11.12 | the hook entry source texts (`hookSourceText` lives in W11.12's module) |

### Gate P11-A

1. `node scripts/audit-ownership.mjs .tmp/waves/P11-A.json`
2. Batch the CCRs → `nuxi prepare` → `pnpm check` → `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
3. `mv .tmp/e2e .tmp/e2e-old-p11-a` → the G11P probes (`.tmp/gates/P11-A/probe.mjs`, built on the P10-A harness plus
   `writeHooks`, `hookScript`, `trustItems`, `approve`, `mcpHttpFixture`, `copyMcpMin`, `alive(pid)`, `sentinel`) on
   probe servers 8896 (hooks, trust, commands, styles, kill switches), 8897 (project MCP, plugins, data) and 8898
   (upgrade), `HF_DATA_DIR=.tmp/gates/P11-A/run-<ts>/<name>`; loops run through `bash -c`:
   1. **Personal hooks** — CRUD 201 / 400 (invalid matcher) / 403 without fresh auth; an off-only PATCH without fresh
      auth succeeds; `switches` reflect the setting, `HF_WORKSPACE_SHELL=0` and `HF_SAFE_MODE` (no process spawned).
   2. **PreToolUse** (`mock:hooks run …` / `call …`) — the `Write` alias matches `write_file`, `Bash|Write` and `*`
      match; exit 2 → `execution-denied` with the reason reaching the model, no write; `deny`; `ask` in `auto` → an
      approval card; `allow` in `ask` runs `write_file` without a card but not `shell` (it still asks); not in plan mode
      or in children; `rewrite` → the rewritten output while the tool part's input is unchanged; exactly one PreToolUse
      record across an approval and its continuation (`record` script); a regex-looking matcher → a diagnostic and no
      run.
   3. **PostToolUse** — `context` → a `data-hook` part + the model text (`hooks:` in the mock answer); `exit2` → the
      feedback is visible to the model; a regenerate keeps the history consistent.
   4. **UserPromptSubmit / SessionStart** — a block → 409 `hook-blocked`, nothing stored (also at enqueue; on `/` no
      chat row); a context → `context?` lists it; a regenerate does not re-run it; SessionStart `startup` fires once and
      `compact` after `/compact`.
   5. **Stop** — `stop-once` → `run.started { origin: 'hook' }`, the carrier, `Hook continuation:`, then a stop; an
      always-blocking hook → 5 turns, then `hook-continuation-limit`; a queued item wins; awaiting an approval or a user
      abort → no Stop turn; a background delivery inside a hook turn.
   6. **Sub-agents / PreCompact / Notification** — a child `ask` → denied; SubagentStop → `Child continued`; PreCompact
      `manual` / `auto` payloads (`custom_instructions`); a Notification on an approval request.
   7. **All events** — the payload has the Claude fields + `harness`; the environment has the project-dir variables and
      no `HF_*` / provider keys; cwd = the project root, else `<dataDir>/hooks`; a timeout kills the hook and its
      grandchild (pids dead) and leaves a non-blocking error part; the sources are additive (personal + project +
      plugin all run); the parts survive a reload.
   8. **Trust** — a pending project hook never runs (sentinel); approve without fresh auth → 403, with it → it runs;
      editing the command **or the referenced script** → pending again; a wrong hash → 409 `stale`; revoke; the rows
      cascade on project delete; absent from the backup zip; invalid / over-cap / linked settings files → diagnostics.
   9. **Project MCP** — no process at boot; approve → `needs-variables` → PUT (fresh) → connected on the first project
      chat; the tools only in that project's chats; it shadows a global id there only; the `${MCP_TOKEN}` header reaches
      the fixture while the server's environment holds a different value; `${VAR:-d}`; a missing variable → no connect;
      the variables are ciphertext in the DB; `My_Server.v2` mapped; stops (pid + group dead) on revoke, a file change,
      project delete and shutdown; safe mode → none.
   10. **Output styles** — the builtins + the `.harness` `terse` over the `.claude` one + the invalid one; chat >
       project > global; `style?` reports the block first; keep = false → `todo-hint: no`; a child has no style; an
       unknown style → the notice; a plugin `/output-style` refused.
   11. **Commands / skills** — an approved `/status` inlines the git output, frozen (a regenerate keeps the counter
       file); arguments never inside spans (`/x ; touch pwned` → no file); `@README.md` inlined, `@../outside.md` /
       `@.env` / a linked file refused; unapproved project spans → 409 `untrusted`; personal and trusted plugin spans
       run; a non-project chat → 400; the shell off → 409; `/deploy prod` expands; a command wins a clash; `internal`
       absent from `skills?` and refused by `skill`.
   12. **Plugin API 1.5.0** — health 1.5.0; `hook-pack`'s hooks run only after trust (fresh); the code events fire; its
       style is listed; disabling it removes both; `^1.4.0` plugins load.
   13. **Kill switches** — `HF_WORKSPACE_SHELL=0` → no hook, no `!`, no `shell`; `HF_SAFE_MODE=1` → no command hooks,
       no project MCP, the builtin `core-mcp` still starts; `hooksEnabled: false` → none.
   14. **Hygiene** — `git status` identical around `pnpm test`; no payloads / outputs / commands / `!` output / variable
       or header values at `info`; only `mock:*` usage rows; no repository-root `.claude` / `.harness` / `.mcp.json`; no
       orphan processes; the ports free.
   15. **Upgrade** (8898, a fresh `.tmp/upgrade-v16` copy with copied roots) — the Gate P11-0b checks; all seeded items
       pending; the `untrusted` project's sentinel absent; approving each kind works; the seeded styles and skills
       discovered with the right precedence; the old `/status` expansion reused; the global stdio server and its group
       dead after shutdown.
4. **Regressions** (one after another: shared ports) — the coordinator's copy `.tmp/gates/P11-A/p10a-regression.mjs`
   (the P10-A probe with the migration pin `≥ 8` and `0007` checked by tag; every section incl. its v1.5 upgrade on
   `.tmp/upgrade-v15`), `node .tmp/gates/P9-A/probe.mjs` (incl. its v1.4 upgrade) and
   `node .tmp/gates/P8-A/probe.mjs ws git`.
5. `pnpm test:e2e` (`chromium` + `mobile` + `tablet`; the feature specs come in P11-B) → 156 green.
6. `E2E_SCREENSHOTS=1 pnpm test:e2e --grep @screenshots` → review `.tmp/screenshots/{dark,light}/` (the new screens on
   desktop and 390 px).
7. `pnpm audit --prod --audit-level high` clean (the two ignored advisories excepted).
8. Digest `.tmp/waves/P11-A-notes.md`; red items → W11.15 / W11.16; ROADMAP + wave log → commit
   `feat: add hooks, project mcp servers and output styles`.

---

## Wave P11-B — feature e2e, docs, fix-ups

### Coordinator actions

- Before the launch: the P11-A checkpoint build for W11.13; W11.15 / W11.16 globs from the red P11-A gate items added to
  `.tmp/waves/P11-B.json` (launched only when needed); the P11-A reports handed to W11.14 as the digest
  `.tmp/waves/P11-A-notes.md` (contract facts, deviations, items marked "For W11.14").
- The final gate below; ROADMAP (every Phase 11 box, the backlog, the wave log); the memory file; push only when the
  user asks.

### W11.13 e2e-features (e2e 8891)

- **Mission.** End-to-end specs for hooks (personal, project, plugin), the hook import, prompt hooks, Stop
  continuations, project trust, project MCP, output styles, command spans and `@path`, user-invocable skills and plugin
  hooks; mobile and tablet checks; screenshots of the new screens and full-frame README shots.
- **Owned.** `e2e/**`.
- **Read-only highlights.** UI.md 2.18, 7.31 – 7.33, 9.13, 12, 13.12, 14; PROVIDERS.md 8 ("Hook mocks (Phase 11)");
  `playwright.config.ts`; `e2e/README.md`; `e2e/helpers/{chat,workspace,customize,keyboard}.ts`;
  `e2e/fixtures/mcp-echo-server.mjs`.
- **Rules.** Project folders only under `.tmp/e2e/workspaces/*`; hook scripts are POSIX `sh` files invoked as
  `sh <relative path>` (busybox-compatible, no `jq`); MCP fixtures on loopback only; never `.claude/`, `.harness/` or
  `.mcp.json` at the repository root.
- **Tasks.**
  1. **W11.13-T1 `core/hooks.spec.ts`** — the Hooks tab; create a personal hook with the password prompt; the matcher
     alias preview; a PreToolUse hook with exit 2 → "Blocked by hook" + the reason; a JSON `allow` runs without a card;
     `ask` → the card banner; `updatedInput` → "Input changed by hook"; a PostToolUse context note; exit 1 → the error
     note; a timeout; Turn off; Delete; "Run hooks" off.
  2. **W11.13-T2 `core/hook-import.spec.ts`** — paste a Claude Code settings JSON; the preview with invalid and ignored
     items; Add.
  3. **W11.13-T3 `core/hook-prompts.spec.ts`** — a UserPromptSubmit block: the text and the attachment chips stay, the
     refusal shows, nothing in the transcript; also while a run is active (the queue) and on the `/` page (no chat
     created); the `additionalContext` and SessionStart notes.
  4. **W11.13-T4 `core/hook-continuation.spec.ts`** — a Stop hook → a carrier note + a reply without user action, then
     the cap note; a second page follows the hook turn.
  5. **W11.13-T5 `core/project-trust.spec.ts`** — a fixture project with `.harness/settings.json`, `.mcp.json` and a
     command with a `!` span: the chip "3 to review"; pending items don't run; approve (fresh auth) → they run; editing
     the file on disk → pending again (Changed when open point 12 lands) and it stops running; revoke; a stale 409 while
     the dialog is open; the entry points in Projects and Customize.
  6. **W11.13-T6 `core/project-mcp.spec.ts`** — `e2e/fixtures/mcp-echo-server.mjs` with `${TOKEN}`: missing → set →
     approve → connected; the tools only in that project's chats; shadowing a global id; an http server needs approval;
     Reconnect.
  7. **W11.13-T7 `core/output-styles.spec.ts`** — the builtins; create a style with "Keep coding instructions"; the
     General default; a project style; the composer "Automatic" label; a per-chat choice survives a reload;
     `/output-style learning`, `/output-style` (opens the menu), an unknown name; `mock:hooks` `style?` reports the
     block.
  8. **W11.13-T8 `core/command-shell.spec.ts`** — `` !`echo hi` `` and `@README.md` frozen into the expansion (a
     regenerate reuses it); an untrusted project command refuses with Review…, approve, then it runs; the shell off →
     the refusal.
  9. **W11.13-T9 `core/skills.spec.ts` (extended)** — the Skills group with the hint, a 64-character name, the command
     badge kind skill, a non-invocable skill absent from the menu.
  10. **W11.13-T10 `plugins/plugin-hooks.spec.ts`** — `hook-pack`'s trust warning lists its commands; untrusted hooks
      don't run; the detail sections (Hooks, Output styles); the card summary.
  11. **W11.13-T11 Extensions** — `share` (no hook notes; a blocked tool reads "Denied"), `keyboard` (Esc never
      dismisses the refusal; Mod+Enter in the hook editor and the import dialog), `data` (a backup round trip without
      hooks, approvals or variables; personal styles restored), `customize` (five tabs).
  12. **W11.13-T12 Mobile and tablet** — `mobile/hooks.spec.ts` (390 px: the tabs scroll, the hook editor sheet and its
      sticky footer, the trust and MCP dialogs, no horizontal scroll); `mobile/agent` (the toolbar with the style
      trigger at 390 px; the refusal fits); the tablet touch-target spec covers the row menus, the trust checkboxes,
      Approve, Reconnect, the variable inputs and the style trigger and options (≥ 40 px).
  13. **W11.13-T13 Screenshots** — `settings-customize-hooks`*, `hook-editor`*, `hook-import`, `project-trust-dialog`*,
      `project-mcp-dialog`*, `customize-output-styles`, `composer-output-style`*, `composer-refusal`*,
      `chat-hook-notes`, `chat-hook-continuation`, `plugin-detail-hooks` (dark + light; * = also mobile) and the
      `@readme` full-frame shots for every README image.
  14. **W11.13-T14 README** — `e2e/README.md` lists the new specs.
- **Verify.** `pnpm test:e2e --list`; slot runs (`HF_MOCK_PROVIDER=1 HF_OFFLINE=1 HF_PORT=8891
  HF_DATA_DIR=.tmp/W11.13/data node apps/server/dist/main.mjs`, `E2E_BASE_URL=http://127.0.0.1:8891 pnpm test:e2e`);
  three green runs of the new specs; watch the CI e2e job budget (about 185 tests, 30 minutes).

### W11.14 docs-final

- **Mission.** Reconcile every doc with the code and the agent reports.
- **Owned.** `README.md`, `.env.example`, `docs/**` except `DECISIONS.md` and `ROADMAP.md`, `docs/assets/**`.
- **Read-only highlights.** `.tmp/waves/P11-A-notes.md`, the code of every Phase 11 area.
- **Tasks.**
  1. **W11.14-T1 Reconcile** — API.md vs the route table and the implemented answers (`hooks`, `projectTrust`,
     `projectMcp`, `GET /commands?projectId` with skills, the events, the `data-hook` placements, the hook carrier, the
     409 reasons, the notices); UI.md 13.12 vs `utils/testids.ts`, the contracts (10.8), the stores and modules (11.8),
     the copy (15), the shortcuts (12); ARCHITECTURE.md vs the implemented flows (hooks, trust, project MCP, styles,
     command extras, the stop order, backups, `0008`, security, log rules); PLUGINS.md (1.5.0, `hook-pack`, the
     snippets `examples.test.ts` compares); PROVIDERS.md 8 ("Hook mocks (Phase 11)") vs the mock model; the guides
     `hooks-and-project-mcp.md` and `output-styles.md`; `examples/plugins/README.md` (seven examples) when it lists
     them.
  2. **W11.14-T2 Status** — README "v1.7" (features: hooks, project trust, project MCP servers, output styles, command
     `!` / `@`, user-invocable skills, plugin API 1.5.0); `docs/assets/screenshots/` refreshed from the `@readme` shots
     at the final gate (the coordinator copies them).
  3. **W11.14-T3 This file** — what actually happened (status, "Deviations found while building", gate results per
     wave).
- **Verify.** `pnpm check:english`; `pnpm -F @harness-forge/shared test` (doc-coupled tests).

### W11.15 / W11.16 fix-ups

Launched only for red P11-A gate items (W11.15 server, W11.16 web), with the globs of those items.

### Wave P11-B ownership

```json
{
  "wave": "P11-B",
  "agents": {
    "W11.13": ["e2e/**"],
    "W11.14": [
      "README.md",
      ".env.example",
      "docs/API.md",
      "docs/UI.md",
      "docs/ARCHITECTURE.md",
      "docs/PLUGINS.md",
      "docs/PROVIDERS.md",
      "docs/guides/**",
      "docs/phases/phase-11-v1-7.md",
      "docs/assets/**"
    ],
    "W11.15": [],
    "W11.16": []
  },
  "allow": [
    "docs/ROADMAP.md",
    "docs/DECISIONS.md",
    "AGENT.md",
    "pnpm-lock.yaml",
    ".tmp/**"
  ]
}
```

### Final gate

1. `node scripts/audit-ownership.mjs .tmp/waves/P11-B.json` → `pnpm install --frozen-lockfile` → `pnpm check` →
   `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
2. The P11-A probes again (after `mv .tmp/e2e .tmp/e2e-old-final-v17`) plus the regressions (the P10-A copy, P9-A,
   P8-A `ws git`; one after another: shared ports).
3. `for i in 1 2 3; do pnpm test:e2e || exit 1; done` (`chromium` + `mobile` + `tablet`), with the OS color scheme
   emulated as light; `E2E_SCREENSHOTS=1 pnpm test:e2e --grep @screenshots` → dark + light reviewed (the Hooks tab, the
   hook editor and import, the trust and MCP dialogs, the Output styles tab, the composer style picker and refusal, the
   hook notes and the continuation, the plugin hooks section on desktop and mobile); the README images copied from the
   `@readme` shots.
4. `pnpm audit --prod --audit-level high`; the two advisories re-checked with the P8-00 rule.
5. **Real v1.6 → v1.7 upgrade**: the `.tmp/v16` worktree build (`45e974c`) seeds a fresh data directory with the full
   K3S seed set, stop it, start v1.7 on the same data directory → `0008` applied, everything intact; **nothing executes
   before approval** (no hook sentinel, no `.mcp-started-*`, no `.hook-log/`); approving each kind (a hook, an MCP
   server, the `/status` spans) makes it work; the v1.6 `/status` expansion is reused on regenerate (no `!`
   execution); the seeded styles and skills are discovered with the right precedence.
6. **Docker** (daemon permitting, else the CI `docker` job), on a copy of that seed: a project under
   `/data/workspaces/hooks` with `.harness/settings.json` → `sh .harness/hooks/mark.sh` (writes `id -u`; busybox `sh`,
   no `jq`): no file before approval; after a fresh login and the approval a `mock:hooks` turn writes `1000` and the
   file is owned by uid 1000; a `.mcp.json` stdio server (`node tools/mcp-min.mjs`, the dependency-free fixture, written
   with `docker exec -i tee`): no process before approval (`docker exec ps`), its tool is offered in the project chat
   after it, the process is gone after revoke; `docker stop` leaves no orphan; a restart with `HF_SAFE_MODE=1` runs no
   hooks.
7. `pnpm test` is hermetic: `git status --porcelain` of the repository unchanged, no `.claude/`, `.harness/` or
   `.mcp.json` at the repository root, no leftover fixture processes, loopback only.
8. ROADMAP (every box, the backlog, the wave log) + memory → commit `chore: final gate for harness-forge v1.7`; push
   only when the user asks. The live provider suite stays the user's (paid).

---

## Outcome

Completed by the coordinator at each gate ("audit" is the ownership audit of `scripts/audit-ownership.mjs`).

| Wave | Agents | Gate result | Commit |
|---|---|---|---|
| P11-00 | coordinator | baseline `pnpm check` 10562 green on `45e974c`, `git status` unchanged; vue-tsc workaround pushed; #8 / #7 merged; `60389e0` audit fix; advisories still unpatched (ignores kept, re-checked 2026-10-06); design reports in `.tmp/p11-designs`; `.tmp/v16` built; `.tmp` archived | `4765743` `fix(web): keep URL literals out of component props` |
| P11-0a | coordinator (K1, K2, contract skeletons, K3 seed by K3S), C34, C35, D14, D15 | audit ok (130 paths); 10912 tests; build ok; CSP 38/38; 11 new routes 501 / 400 (18/18); `pluginApiVersion` 1.5.0; e2e 156; v1.6 seed 20 chats / 136 messages | `d1f7836` |
| P11-0b | coordinator (K3), C36, C37, C38, C39, G11B | audit ok (189 paths); `0008` = 2 CREATE TABLE + 1 ALTER ADD; 11212 tests; build ok; CSP 38/38; e2e 156; v1.6 upgrade probe 57/57; seam probe 37/37 | `9f169a1` |
| P11-A | W11.1 – W11.12, G11P, W11.15 / W11.16 | audit ok (249 paths); 11760 tests; build ok; CSP 38/38; probes 356/356 after the fix-ups + P10-A copy 173/0 + P9-A + P8-A 47/0; e2e 156 | `3cff82d` |
| P11-B | W11.13, W11.14, W11.17 – W11.19, G11D | 11787 tests; build ok; CSP 38/38; probes 345/345 (incl. the real v1.6 → v1.7 upgrade 45/45) + regressions; e2e 191 ×3; screenshots reviewed; audit clean (6 ignored); Docker 49/49 | (final gate commit) |
| Final gate v1.7 | coordinator | see the row above and the ROADMAP wave log (frozen install, check, build, CSP, probes + regressions on fresh data, e2e ×3, screenshots, audit, real v1.6 → v1.7 upgrade, Docker) | `chore: final gate for harness-forge v1.7` |

---

## Risks

State before P11-0a.

| Risk | Mitigation |
|---|---|
| Remote code execution from a cloned repository | per-item hash approval incl. the referenced scripts, verify-before-run, fresh auth, the exact commands shown, the `runs-repository-code` warning, kill switches; probes 8, 15 |
| Canonicalization drift (a reformat re-pends everything, or a hash misses a field) | one SH `trustHashInput`; C35 tables + fuzz |
| Variable exfiltration / SSRF through `.mcp.json` | never `process.env`; http needs approval; the `private-network` warning; encrypted values; masked logs |
| Hook loops / slow hooks | the cap of 5, timeouts, process-group kill, Stop cancels, output caps, the semaphore |
| PreToolUse re-run on approved continuations | answered toolCallIds skipped and the stored decisions replayed (frozen seam); probe 2 |
| Approval honesty with `updatedInput` | the hook part linked by `toolCallId` shows the rewritten input on the row / card |
| Process leaks (hooks, stdio grandchildren) | process groups, the stop order, pid checks, Docker `stop` |
| `0008` damaging v1.6 data | CREATE + one `ALTER ADD`; the upgrade test, the upgrade probe and the real upgrade |
| The `style` kind / `output-style` break the web build at P11-0a | C34's compile fixes include the web maps (open point 1) |
| vue-tsc #6240 recurring | the rule, the AGENT.md fact, the guard test `template-literals.test.ts` |
| Frozen signature churn (pipeline, tools, approval, steps, model-history, `useChatSession`, composer) | all seams complete in P11-0b, one owner per hot file in P11-A |
| Count pins (routes 120 / 33, SSE 18, settings 30, notices 11, conflict reasons 14, tables 22, parts 6, origins, kinds, mocks, test ids) | listed by C34 / C36 / C38 / C39; accepted at the audits; the P10-A probe regression copy |
| A cached mock listing hides `mock:hooks` | `mv .tmp/e2e` before every gate |
| CI e2e budget (~185 tests) | watch the 30-minute job |
| Wave size (12 + G11P) | the first cuts; W11.15 / W11.16 |
