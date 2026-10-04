# Phase 10 — v1.6: Agent customization

Part of the harness-forge build plan. Progress is tracked in `docs/ROADMAP.md` (coordinator only). Shared names come
from `docs/DECISIONS.md` (ADR-044 … ADR-047, the amendment notes on ADR-024, ADR-036, ADR-041, ADR-042 and ADR-043,
and the contract seed; it wins on conflict); endpoints and DTOs from `docs/API.md` (the new schema sections from 4.28 on
for customizations, background tasks and Remember, the route sections from 5.28 on for the modules `customizations`,
`memory` and `chatTasks`, the stream section 6.10 for `data-task-result`, the notice `command-model-unavailable` and the
run origin `task`, the events `task.changed` / `customization.changed`, the two settings, the `GET /commands?projectId`
additions and the route key index); components, props, store and module signatures, shortcuts and test ids from
`docs/UI.md` (the 2.17 wireframes, 5.5 navigation, 7.28 commands and skills, 7.29 background agents, 7.30 Remember,
9.11 the plan-file fields, 9.12 Customize, 10.7, 11.7, 12, 13.11, 14, 15 and the amended 7.8, 7.25, 7.27); flows,
tables and security rules from `docs/ARCHITECTURE.md` (5 the stop order, 6.9 backups, the new 6.23 catalog, 6.24
commands, 6.25 skills, 6.26 background tasks, 6.27 plan files and Remember, 8 `0007`, 10.11 security, 12 log rules);
plugin API 1.4.0 (`contributes.agents` / `contributes.skills`, `ctx.agents` / `ctx.skills`) from `docs/PLUGINS.md`;
the two mock models from `docs/PROVIDERS.md` (8 "Customization mocks (Phase 10)", the probe contract); the user guide
`docs/guides/customizing-agents.md`. The new UI.md, ARCHITECTURE.md, PLUGINS.md and PROVIDERS.md sections and the guide
are written by D13 in P10-0a, API.md by C28 (C28 and D13 fix the final section numbers). W10.14 reconciles every doc
with the code in P10-B.

**Status (2026-10-04): in progress.** P10-00 is done: the baseline `pnpm check` is green with 9469 tests and
`git status --porcelain` was identical before and after it; CI run `37162957905` and Audit run `37162958016` are green
on `5481fb3` (`origin/main`, v1.5); there are no open PRs; both audit advisories are still unpatched (re-checked
2026-10-04, ignores kept); the `.tmp/v15` worktree (`5481fb3`) is installed and built. In P10-0a, K1 (DECISIONS, ROADMAP,
AGENT.md) and K2 (the `yaml` dependency) are done; the coordinator also wrote the contract skeletons
`packages/shared/src/util/{definitions,arguments,tool-names}.ts` and the agent-name ids in `packages/shared/src/ids.ts`
so C28 and C29 could work in parallel. C28, C29, D12, D13 and the K3 seed (agent K3S) run now. "Deviations from the
plan" holds the binding changes to the plan sections below; "Deviations found while building" will hold what each wave
changed; "Outcome" the gate results.

Paths: `S` = `apps/server/src`, `W` = `apps/web/app`, `SH` = `packages/shared/src`.

## Goal

Ship v1.6: Agent customization (Claude Code parity for shaping the agent), plus four extras.

- **Customization catalog** (ADR-044): agents, slash commands and skills are markdown files with YAML frontmatter (the
  body is the instructions, the prompt or the skill content). One catalog per project merges five sources, lowest
  first: builtin < plugin < user (table `customizations`, edited on Settings → Customize) < project
  `.claude/{agents,commands,skills}` < project `.harness/{agents,commands,skills}`; a higher source wins a name and the
  losers are listed as shadowed. One parser (`SH/util/definitions.ts`, dependency `yaml` 2) serves the server and the
  web; every problem is a diagnostic, never an error. Project files are untrusted and read-only: they are read only
  through the workspace path guard and can only restrict.
- **Custom agents** (ADR-045, amends ADR-043): `task.type` names any agent of the catalog (`explore` and `general` stay
  builtin and reserved; `general-purpose` is an alias of `general`); a custom agent's body becomes the child's
  instructions after the sub-agent preamble, its `tools` list narrows the child tool set (never widens it) and its
  `model` (or `inherit`) picks the child model. The instructions list the agent types (≤ 30).
- **Custom commands** (ADR-045): a command file expands `$ARGUMENTS`, `$1` … `$9` and `{{input}}`, runs its turn on its
  `model` (a per-turn override; the chat keeps its model) and narrows the turn's tools with `allowed-tools` (never a
  grant). `GET /commands?projectId=` lists the effective commands with their `source`; the composer groups them (App ·
  Project · Personal · Plugins) and shows the `argument-hint` as ghost text.
- **Skills** (ADR-045): skills are listed (name + description, ≤ 50) in the instructions and loaded on demand by the
  fourth `core-agent` tool `skill` (policy `safe`); a project skill points at its folder, whose supporting files the
  agent reads with `read_file`. Skills are not user-invocable (backlog).
- **Plugin API 1.4.0** (additive): `contributes.agents` / `contributes.skills`, `ctx.agents.register`,
  `ctx.skills.register`, registry kinds `agent` / `skill`; the example plugin `examples/plugins/agent-pack`.
- **Background sub-agents** (ADR-046, amends ADR-042 and ADR-043): `task` with `background: true` returns at once; the
  child runs detached under a per-chat manager, is persisted in `background_tasks`, and its result is delivered exactly
  once as a `data-task-result` part (at the next step boundary of a running reply, or through a turn the server starts
  with `origin: 'task'` when the chat is idle). The chat's Stop does not stop them; each has its own Stop.
- **Plan files and Remember** (ADR-047, amends ADR-041 and ADR-036): with `planFiles` on, an approved plan is written to
  `<planDirectory>/<YYYY-MM-DD>-<slug>.md` through the journal; `/remember <text>` appends a line to the project's
  `AGENTS.md` (else `CLAUDE.md`, else a new `AGENTS.md`), to the project's instructions or to the global Custom
  instructions (`POST /memory`).

Out of scope (ROADMAP backlog): nested sub-agents (depth stays 1), user shell hooks, project `.mcp.json` servers, output
styles, `!bash` and `@file` inside command files, user-invocable skills (`/skill`), editing project definition files in
the UI, importing definitions from the home folder (`~/.claude`), background tasks that survive a server restart (they
end `aborted`), a sidebar activity dot for background agents, and the live provider suite for custom agents, skills and
background agents with real models. Kept as documented behavior: `allowed-tools` only narrows (Claude Code pre-approves
with it); prompt injection through definition bodies is accepted like `AGENTS.md`; the cost of a background agent is in
its output and the chat totals, not in a message's metadata; a regenerate above a delivered result loses it from the
path (the task stays listed); share pages drop task results.

Totals after Phase 10: routes 100 → **109** (`customizations.list`, `customizations.source`, `customizations.create`,
`customizations.get`, `customizations.update`, `customizations.remove`, the one `memory` route `POST /memory`,
`chatTasks.list`, `chatTasks.stop`; none needs fresh auth; `commands.list` gains `?projectId=`), route modules 27 →
**30** (`customizations` 6, `memory` 1, `chatTasks` 2), tables 18 → **20** (`customizations`, `background_tasks`),
migration **`0007_customizations`** (2 CREATE TABLE + 3 CREATE [UNIQUE] INDEX, nothing else), SSE types 13 → **15**
(`task.changed`, `customization.changed`; `run.started.origin` gains `task`), settings keys 26 → **28** (`planFiles`,
`planDirectory`), notice codes 7 → **8** (`command-model-unavailable`), error codes **16** and conflict reasons
unchanged (`exists` for a duplicate personal definition, `run-active` while a background task runs), UI data part types
4 → **5** (`task-result`), `core-agent` tools 3 → **4** (`skill`), task status + `background`, run origins + `task`,
client commands + `remember`, usage purposes unchanged (`subagent` for background children), plugin API **1.4.0**
(additive), id prefixes **`cus_`**, **`bgt_`**, mock models **`mock:agents`**, **`mock:background`**, **56** new test ids
(UI.md 13.11; the plan's "~55"), ADR-044 … ADR-047, one new dependency (`yaml` 2) and no new environment variable.
Agents: 4 (P10-0a: C28, C29, D12, D13; plus the seed agent K3S) + 4 (P10-0b: C30, C31, C32, C33) + 12 (P10-A: W10.1 –
W10.12) + 2 (P10-B: W10.13, W10.14; W10.15 / W10.16 only for red P10-A gate items), in the Phase 5 wave method
(ADR-016).

## Entry criteria

- v1.5 is on `main` and pushed (`origin/main` = `5481fb3`, `chore: final gate for harness-forge v1.5`; CI run
  `37162957905` and Audit run `37162958016` are green; no open PRs): `pnpm check` (9469 tests), `pnpm build` and e2e 128
  passed ×3 (`chromium` + `mobile` + `tablet`).
- The approved plan and the design inputs exist in `.tmp/p10-designs/` (`plan.md`, `server.md`, `web.md`, `process.md`,
  `explore-{subagents,commands,web}.md`, `agent-rules.md`; the reconciliation in `plan.md` and `README.md` is binding
  and wins over the reports).
- K1 is done: DECISIONS.md carries ADR-044 … ADR-047, the amendment notes (ADR-024, ADR-036, ADR-041, ADR-042,
  ADR-043) and the Phase 10 contract seed (ids `cus_` / `bgt_`, agent and skill names, the definition folders, the
  plugin API note, enumerations, the HTTP table rows `customizations.ts` / `memory.ts` / `chat-tasks.ts`, events, the
  chat request note, the data parts, settings, the tables and `0007`, the mock models, the example plugin
  `agent-pack`, `customizations.json` in backups); ROADMAP.md has the Phase 10 section and the updated backlog; AGENT.md
  has the stack row (`yaml` 2), the "Plugin API 1.4.0" and "Customization" facts and the Phase 10 freeze line.
- K2 is done: `yaml: ^2.9.1` in the `pnpm-workspace.yaml` catalog, `"yaml": "catalog:"` in `packages/shared`,
  `apps/server` (tsdown `onlyBundle: []` and the Docker `--prod` install need it) and `apps/web`; the lockfile gained
  importer edges only (no new tarball, no build script, no `allowBuilds`).

## Exit criteria

- Every Phase 10 item in `docs/ROADMAP.md` is checked; every wave gate is green; the final checkpoint commit
  `chore: final gate for harness-forge v1.6` exists (pushed only when the user asks).
- `pnpm check` and `pnpm build` are green; the built-page CSP test passes with `HF_TEST_REQUIRE_WEB_BUILD=1`;
  `apps/server/dist/main.mjs` imports `yaml` as an external.
- `pnpm test:e2e` (projects `chromium` + `mobile` + `tablet`, OS color scheme emulated as light) is green 3× in a row,
  including the new specs `core/customize`, `core/custom-commands`, `core/custom-agents`, `core/skills`,
  `core/background-agents`, `core/remember`, `core/plan-files`, `plugins/plugin-agents`, `mobile/customize`, the
  extended `share`, `keyboard`, `data`, `settings`, `mobile/agent` and tablet touch-target specs; the `@screenshots` run
  (dark + light) was reviewed; the README images come from the `@readme` full-frame shots.
- The gate probes (Gate P10-A, repeated at the final gate on a fresh `.tmp/e2e`) and the P9-A and P8-A probe
  regressions (`node .tmp/gates/P9-A/probe.mjs`, `node .tmp/gates/P8-A/probe.mjs ws git`) are green.
- CI on `main` is green (`check`, `e2e`, `docker`, `audit`, `actionlint`); the advisory decision is recorded.
- A v1.5 data directory boots on v1.6 with every chat, secret, share, project and rule intact: `0007` applied (two empty
  tables), old `tool-task` parts unchanged, old chats keep their `toolMode`, pending approvals still pending, the
  seeded `.claude` / `.harness` definitions discovered read-only with the right precedence and diagnostics (the symlink
  skipped, the invalid and the over-cap files listed as invalid).
- The Docker image boots on a copy of the v1.5 seed; a custom agent from `/data/workspaces/<p>/.harness/agents` runs, a
  background agent completes and delivers, `/remember` writes `AGENTS.md` as uid 1000 (daemon permitting, else the CI
  `docker` job).
- `pnpm test` never calls a paid API, never touches the repository's `data/` or a folder outside a temp directory, and
  leaves `git status --porcelain` of the repository unchanged; `pnpm test:live` stays the user's.
- README status reads "v1.6".

Manual acceptance (coordinator, `HF_MOCK_PROVIDER=1 pnpm dev`):

- Settings → Customize → create a personal agent `reviewer`; invalid frontmatter in the body shows an inline error;
  export it, then import it on a clean data directory.
- A project with both `.claude/commands/greet.md` and `.harness/commands/greet.md` → the slash menu shows the `.harness`
  one in the Project group with its argument hint as ghost text; `/greet Ada` expands; the model override shows in the
  message meta.
- `mock:agents` with a custom agent → the task block is labelled "reviewer" and the child's tools are limited.
- `skill release-notes` → the row "Loaded skill release-notes".
- `mock:background` → the dock shows the background agent; the composer's Stop leaves it running; the dock's Stop stops
  it; a finished report starts the next turn by itself (the result note, then the reply).
- Plan files on → an approved plan appears in the changes panel; "Rewind files to here" removes it.
- `/remember` to each of the three targets; the project targets are disabled outside a project with the reason shown.
- A plugin's agents and skills on its detail page and under the "Agents and skills" filter.
- Mobile (390 px): the editor sheet and the dock (todo strip + background agents + queue + composer) fit.
- A v1.5 data directory boots on v1.6 with every chat, secret, share, project and rule intact; `.claude` definitions are
  discovered read-only.

With real keys (the user, optional): a custom reviewer and a background exploration on a real project.

## Steps

| Step | Owner | Output |
|---|---|---|
| P10-00 | coordinator | design reports → `.tmp/p10-designs` (+ README reconciliation, `agent-rules.md`); CI + Audit on `5481fb3` green; no open PRs; advisory re-check; baseline `pnpm check` 9469 + `git status --porcelain` before / after; `.tmp/v15` worktree installed and built |
| P10-0a | coordinator (K1, K2, K3-seed by K3S) + C28, C29, D12, D13 | decisions, ROADMAP, AGENT.md, `yaml`; every shared contract + plugin SDK 1.4.0 + 501 stubs + API.md; the definition helpers (complete); this file; every other doc; the v1.5 upgrade seed |
| Gate P10-0a | coordinator | audit, frozen install (`pnpm why yaml`, `pnpm why typescript`), check, build (`yaml` external, web entry size), CSP test, `pluginApiVersion` 1.4.0, 9 new routes mounted, e2e regression, `pnpm audit`, commit |
| P10-0b | coordinator (K3) + C30, C31, C32, C33 | schema + migration `0007`, server skeleton, chat seams, `core-agent` + the two mock models (complete), web skeleton, FREEZE |
| Gate P10-0b | coordinator | audit, `nuxi prepare`, check, build, CSP test, e2e regression on a fresh `.tmp/e2e`, v1.5 upgrade probe, seam no-op probe, FREEZE, commit |
| P10-A | W10.1 – W10.12 (one launch) | features |
| Gate P10-A | coordinator | CCR batch, `nuxi prepare`, check, build, CSP, probes + P9-A and P8-A regressions, e2e, screenshots, audit, commit |
| P10-B | W10.13, W10.14 (+ W10.15 / W10.16 when the P10-A gate is red) | feature e2e, docs reconciliation |
| Final gate | coordinator | e2e ×3, v1.5 → v1.6 upgrade, Docker, audit, ROADMAP, memory, commit |

## Deviations from the plan (binding)

The binding changes found while building are listed per wave in "Deviations found while building" below. The
coordinator records here every binding change to the plan sections below, with the gate that decided it; the agents
build against the plan sections of this file plus this list.

The three design reports (`.tmp/p10-designs/{server,web,process}.md`) are superseded where `plan.md` (its
"Reconciliation" table) and `.tmp/p10-designs/README.md` disagree with them. The replaced report items, for agents who
read the reports for depth (the list of `README.md`):

- **server.md**: `yaml` is not only an `apps/server` dependency — the one parser lives in `SH/util/definitions.ts`
  (`parseDefinition`, `formatDefinition`; C29, P10-0a) and `yaml` is declared in `packages/shared`, `apps/server` and
  `apps/web`; the Claude tool-name aliases live in `SH/util/tool-names.ts` (not the customization service);
  `customizations` has **6** routes (+ `customizations.source`: `GET /customizations/source?projectId&kind&name&source`
  for project / plugin / builtin bodies) → **109 routes / 30 modules**; SSE adds **`customization.changed`** too (15
  types, not 14); the migration is `0007_customizations` (not `0007_customizations_background_tasks`); the plan-file
  output is `planPath?` / `planError?` (not a warning only); `TaskOutput` gains `agent?: { source, description ≤ 200,
  path? }`; W10.7 owns `S/registry/**` incl. `validate*` (not `types.ts`).
- **web.md**: background tasks are **persisted** (`background_tasks`, restart → `aborted`, not in memory / "Lost");
  there is no `POST /chat/:id/tasks/stop` (Stop all loops in the client); the part is **`data-task-result`** `{ taskId,
  toolCallId, messageId, output: TaskOutput, deliveredAt }` (not `data-agent-result`), the run origin is **`task`** (not
  `agent`), the component is `TaskResultNote` (not `AgentResultNote`), the helpers are `taskResultsOf` /
  `isTaskResultMessage`, the test ids `task-result`, `task-result-toggle`, `task-result-report` (not `agent-result*`);
  the store is `W/stores/background-tasks.ts` (`useBackgroundTasksStore`, not `agent-tasks`); user rows store raw
  markdown `content` (create / update body `{ kind, content, enabled? }`; the editor serializes its fields with
  `formatDefinition`); the catalog route is `GET /customizations?projectId&kind&refresh` (not `/customizations/catalog`)
  and bodies come from `GET /customizations/source` (not `/catalog/markdown`); command source `harness` (not
  `builtin`); **skills are not user-invocable** (no `userInvocable`, no `customization-user-invocable`, no
  `slash-menu-item[data-skill]`, no `commandInvocationSchema.type: 'skill'`); the parser is `SH/util/definitions.ts`
  with `yaml` (not a dependency-free `customization-md.ts`); remember is **`POST /memory`** `{ target: project-file |
  project-instructions | global, text, chatId? }` (not `POST /remember`, not `project`, not `projectId`); the plan file
  output is `planPath?` / `planError?` (not `planFile`); share pages drop task-result parts (no `sharePartSchema`
  change); the web agent letters W10.A – W10.E are W10.8 – W10.12.
- **process.md**: the table is **`background_tasks`** (not `agent_tasks`), a restart leaves `aborted` (no
  `interrupted` status); route modules `customizations`, `memory`, `chatTasks` (files `customizations.ts`,
  `memory.ts`, `chat-tasks.ts`; not `remember.ts`); `splitSteers` stays unchanged — C29 adds a separate
  **`splitTaskResults`** + `taskResultText`; remember targets `project-file | project-instructions | global`; **2 mocks**
  (`mock:agents`, `mock:background`), not 4; ADRs: 044 catalog + definition files, 045 custom agents + commands +
  skills + plugin API 1.4.0, 046 background sub-agents, 047 plan files + remember; the settings page is
  `W/pages/settings/customize.vue` (not `customizations*`); the C33 component names and the P10-A split are the plan's
  (server agents from server.md section 8, web agents from web.md section 7).

Further report items replaced by the plan or DECISIONS.md (found by D12; same rule):

- **server.md**: a diagnostic `level` is `error | warning | info` (DECISIONS contract seed and the coordinator's
  skeleton `DEFINITION_DIAGNOSTIC_LEVELS`; `error` = the definition is `invalid`), not `warning | info`.
- **web.md**: diagnostics carry `level` (not `severity: error | warning`); `TaskOutput.agent` has no `name` (the name is
  `output.type`) and carries `path?`; `BackgroundTask` is the `background_tasks` row (`id, chatId, messageId,
  toolCallId, type, description, origin, status, output, createdAt, finishedAt, deliveredAt, deliveredMessageId`; C28
  fixes the DTO) — no `input`, no `delivery: pending | delivered` (`deliveredAt` null = pending), no `data-state="unknown"`
  "Lost" state (a restarted task is a persisted `aborted`); there is no personal-list route: the personal entries are
  the catalog entries with `source: user` (disabled ones with `state: off`) and their content comes from
  `GET /customizations/:id`; the agent letters' mocks `mock:custom-agent` / `mock:skill` are `mock:agents`; the test id
  count is 56 (57 minus `customization-user-invocable`, with `agent-result*` renamed).
- **process.md**: the catalog source enum is `builtin | plugin | user | project` (+ `path`), not `project-harness |
  project-claude`; the `customizations` table stores `content` (raw markdown) with denormalized `kind`, `name`,
  `description`, `enabled` (no `body`, no frontmatter JSON); remember lives in `S/services/customizations/memory.ts` and
  `S/http/routes/memory.ts` (not `S/services/remember/**`); `exitPlanModeOutput` gains `planPath?` / `planError?` (not
  `planFile?`); the C28 / C33 names `useCustomizations`, `useRemember`, `chat-tasks` store, `BackgroundTasksDock`,
  `TaskReportNote`, `DefinitionEditor`, `SkillBody` are the plan's `useCustomizationsStore`, the pure module
  `composer/remember.ts`, `useBackgroundTasksStore`, `BackgroundAgents`, `TaskResultNote`, `CustomizationEditor`,
  `SkillToolBody`; ~35 test ids → 56; the amendment notes are ADR-024, ADR-036, ADR-041, ADR-042 and ADR-043 (not
  ADR-031); the first cuts are the plan's (P10-A coordinator actions); the Gate P10-A commit reads `feat: add custom
  agents, commands, skills and background agents` (not "… background tasks").

Plan-level decisions (from the reports, kept by the plan):

- **One parser on both sides** (`SH/util/definitions.ts` with `yaml`: core schema, `maxAliasCount: 0`, unique keys,
  byte caps before parsing; frontmatter at byte 0, BOM allowed, ≤ 8 KiB). Rejected: a hand-written frontmatter parser
  (real Claude Code files use quoted colons, block scalars and lists) and two parsers (server / web drift).
- **Raw markdown for user rows**: the table stores `content` plus denormalized columns; the server re-parses on every
  create / update (400 with the diagnostics); import and export run in the browser (no routes).
- **Restrict-only definitions**: a definition never grants anything (no approval, mode, tool override, shell rule or
  provider); `allowed-tools` narrows the turn, unlike Claude Code, so a cloned repository can never pre-approve the
  shell. `exit_plan_mode` is kept in plan mode; a `Bash(git:*)` pattern keeps `shell` with a `tool-pattern` diagnostic.
- **Frontmatter-only discovery**: the catalog reads at most 8 KiB per file and caches per project (10 s, single-flight,
  event invalidation); bodies are re-read and re-validated by `load(entry)` when used.
- **A user-role carrier message** for server-started `task` turns (holding only `data-task-result` parts): the web
  treats it like a queue-started turn (refresh + resume); a bare assistant message would merge into the previous reply
  on resume.
- **A separate `splitTaskResults` stage** after `splitSteers` (unchanged), so text, export and share code that use
  `splitSteers` keep their behavior; `convertDataPart` was rejected (it keeps the part's role and has several call
  sites).
- **Persisted background tasks** (`background_tasks`), so a reload, a second tab and a restart (`aborted`) see them;
  the inbox of undelivered results is in memory and rebuilt from the table at boot.
- **The chat's Stop does not stop background tasks** (Claude Code parity); chat and project deletion, delete-all, key
  rotation and shutdown do; while one runs, its project is busy (409 `run-active`).
- **The web says "background agents"**, never "tasks" (that is the todo list).
- **Docs** are written by D13 and C28 (API.md) in P10-0a and reconciled by W10.14 in P10-B; P10-A agents never edit
  docs. **Feature e2e specs** are written in P10-B by W10.13. **Every new web test id** is added by C33 in P10-0b,
  copied verbatim from UI.md 13.11; `W/utils/testids.ts` is frozen during P10-A.

Open points decided by D12 while writing this file (to be confirmed by the coordinator at Gate P10-0a):

1. **`parseDefinition` options** follow the coordinator's skeleton (`{ fileName?, folderName?, maxBytes? }`), not the
   plan's `{ source, fileName }`: the parser does not need the source; the catalog stamps `source` / `path` on its
   entries. The skeleton also adds the diagnostic codes `invalid-field` and `tool-pattern` to the plan's sixteen codes
   (eighteen in `DEFINITION_DIAGNOSTIC_CODES`).
2. **Background stub ownership in P10-0b**: C30 writes `S/chat/background/types.ts` (frozen) and the stub
   `S/chat/background/index.ts` with its final factory signature (`launch` yields one `failed` output "Background agents
   are not available yet.", the rest answer empty); C31 wires it into `S/chat/index.ts` and `pipeline.ts`. In P10-A,
   W10.4 owns `S/chat/background/**` (not `types.ts`).
3. **The project-busy check**: C30 declares `ChatRunner.hasTasks(chatId)`, C31 implements it by delegating to the
   manager (false until W10.4); W10.4 adds the call to every guard in P10-A (`assertProjectIdle`, project remove, chat
   move, version delete) and `stopTasks` to chat deletion and delete-all.
4. **Stop and start order**: `SHUTDOWN_STEPS` = data, runs (`stopAll`: queues cleared → background tasks aborted,
   awaited ≤ 5 s, rows saved → runs aborted), customizations (the catalog cache), projectFiles, checkpoints, plugins,
   mcp, catalog, events; `startDeps` calls `runs.start()` after `checkpoints.start()` (the boot sweep: `running` rows →
   `aborted`, undelivered rows → the in-memory inbox, no turns at boot). C30 fixes the step names and reports them.
5. **The plugin filter** `agents` ("Agents and skills") and its `pluginMatchesFilter` branch in `W/stores/plugins.ts`
   are complete in P10-0b (C33): the store has no P10-A owner; W10.12 only renders.
6. **The example plugin's test pin**: W10.7 also owns `examples/plugins/examples.test.ts` (`EXAMPLE_IDS` gains
   `agent-pack`); PLUGINS.md snippets the test compares are "For W10.14" notes.
7. **Route order**: `GET /customizations/source` is registered before `GET /customizations/:id` (C28's stub and W10.1's
   module), so `source` never reaches the id validator.
8. **SDK compile fixes**: `PluginContext.agents` / `.skills` (C28) need members in `S/plugins/context.ts` before W10.7
   implements them; C28 adds members that throw `not_implemented` and lists the file as a `C28-compile-fixes` entry.
9. **Builtin catalog entries** are the agents `explore` and `general` only (plan section 1); the Customize page's
   Built-in section for commands lists `/compact` (from `GET /commands`, `source: harness`) and the client commands from
   the web's own list (UI.md 9.12 decides the layout).
10. **A steer and a task result at one boundary**: the model never sees two user messages in a row from the split;
    C29 fixes how `splitTaskResults` merges a result into an adjacent user message (reported, with a table test).
11. **Remember journal**: `deps.checkpoints.journal({ chatId, messageId: null, projectId })` with `toolCallId:
    'remember_<id>'` and `tool: 'remember'` (server.md G); the journal's `workspace.changed` keeps source `tool` (no
    enum change).
12. **Background task rows** are pruned per chat to `backgroundTasksKeptPerChat` (100), oldest delivered first (W10.4).
13. **Unowned in P10-A**: `S/chat/{approval,modes,runs,history,usage,title,files,scope,errors,generated-files,images,
    tool-history,testing}*`, `S/chat/compaction/**`, `S/workspace/**`, the composer files outside W10.9's list,
    `W/stores/plugins*`, `W/components/app-shell/**`: a needed change is a CCR, and new test helpers go into the agent's
    own files.
14. **Seed timing**: ROADMAP lists the v1.5 seed under P10-0b (K3); the plan runs it in P10-0a in the background (agent
    K3S), so it is ready before the P10-0b gate. The ROADMAP wording is the coordinator's.
15. **Slots**: P10-0a C28 k2, C29 k3, D12 k1 (D13 runs no server; K3S drives the `.tmp/v15` build on the coordinator's
    :8898); P10-0b C30 k3, C31 k5, C32 k6, C33 k4; P10-A W10.1 – W10.7 k1 – k7 (web agents run no server); W10.13 e2e
    8891.

### Deviations found while building (P10-0a – P10-B)

Recorded by the coordinator from the agent reports (`.tmp/waves/P10-*-notes.md`) and the gates; the code and the
reconciled docs (W10.14) follow these, not the task text further down.

- **P10-0a (C28, C29, D12, D13, K3S)**:
  - The coordinator confirmed D12's open points 1 – 9 and 11 – 15 as written. **Point 10 changed**: `splitTaskResults`
    does not merge a result into an adjacent user message; each result is its own user message, the same as
    `splitSteers` does for several steers at one boundary (consecutive user messages are already the Phase 9 behavior).
  - C28: `customizations.source` takes an optional `path` query (reads a shadowed project file; DECISIONS row
    updated); `runOriginSchema` lives in `SH/enums.ts` (import cycle between `events.ts` and
    `background-tasks.ts`; root exports unchanged); `SH/limits.ts` and `SH/enums.ts` import `util/definitions.ts`,
    so the util files must never import `limits.ts` / `enums.ts` (cycle). Compile fixes (behavior kept):
    `S/chat/subagent/index.ts` runs only `explore` / `general` (+ `general-purpose`) and fails any other type until the
    catalog reaches the runner; `ctx.agents.register` / `ctx.skills.register` throw `not_implemented` until W10.7;
    `core-agent/index.test.ts` skips `skill` until C32; `/remember` stays out of the slash menu until W10.9 (e2e keeps
    five client commands); registry contributions report `agents: []`, `skills: []` until W10.7.
  - C29: diagnostic messages already start with `Line N: ` (the web never adds it); a top-level `argument-hint: [a] [b]`
    is read as raw text before YAML; split ids: the result's user message id = `taskId`, later assistant halves
    `~r<k>`; `taskResultText` = report, else `Error: …`, else `(no report)`; a `tools` value that is neither text
    nor a list → `[]` + `invalid-field`; model refs via `safeParseModelRef`; precedence ties → path, then
    `pluginId`, then `id`; `formatDefinition` uses `doubleQuotedAsJSON` (a `yaml` 2.9.1 round-trip bug); an alias
    switches to the line reader (raw text kept, a warning without a line); `tool-names.ts` keeps a local cap of 64.
  - D13: `mock:agents` children write `agent.txt` when the prompt says `write` (needed by probe 2; PROVIDERS.md 8 is
    the contract C32 implements); the catalog lists plugin commands too (so shadowing is visible); `customizations.json`
    is always written into a backup and restored with "Restore settings"; `task-block[data-state="background"]`
    replaces web.md's "Lost"; UI.md 13.11 has 56 ids; the DTO is `Customization` (not `UserCustomization`).
  - K3S built the v1.5 seed in P10-0a (`.tmp/upgrade-v15`, ids `.tmp/upgrade-v15-ids.json`): 13 chats, 120 messages,
    3 pending approvals; a probe copies it and repoints `projects.path` by SQL; the cached mock listing predates the
    new mocks (refresh it).
- **P10-0b (K3, C30, C31, C32, C33)**: (none recorded yet)
- **P10-A (W10.1 – W10.12)**: (none recorded yet)
- **P10-B (W10.13, W10.14) and the final gate**: (none recorded yet)

## Rules for every Phase 10 agent

This section is the canonical copy of the agent rules (`.tmp/p10-designs/agent-rules.md` was its draft). The Phase 9
rules apply, renamed (P9-* → P10-*, W9.14 → W10.14; ports unchanged); the Phase 10 additions follow them.

- Read `AGENT.md` fully, your section of this file (or your task prompt) and the docs it names. Paths: `S` =
  `apps/server/src`, `W` = `apps/web/app`, `SH` = `packages/shared/src`. Stay inside your OWNED globs; the FREEZE list
  in AGENT.md overrides any owned glob.
- Never run: package installs or CLIs (`pnpm add`, `drizzle-kit`, `nuxi`, `shadcn-vue`), git write commands on this
  repository, `nuxt dev` / `nuxt build` / `nuxt prepare`, servers on :3000 / :8787 / :8899 / :8896–:8898, **never
  `pnpm test:live`** (the repository `.env` may hold real keys and the suite makes paid calls), and never
  `pnpm key:rotate` / `rotate-key` against the repository's `data/` (tests use temp data directories). Existing scripts
  are allowed.
- Your own server uses your slot: `HF_PORT=879k HF_DATA_DIR=.tmp/<agent-id>`; e2e agents use `889k` (k ≠ 9) with
  `E2E_BASE_URL`. Stop every process you started (shell children and background children included) before reporting.
  Prefer `createTestApp()` + `app.request()`.
- **Temp folders**: tests create workspaces, roots, repositories, definition folders and data directories with
  `realpath(await mkdtemp(join(tmpdir(), 'hf-')))` (macOS `/var` is a link to `/private/var`, so an un-resolved path
  fails every containment check) and remove them afterwards; never the repository's `data/`, `.tmp/e2e`, a seed folder
  or a real project folder.
- **Shell tests** use POSIX `sh` syntax only (CI runs Linux, where `/bin/sh` may be `dash`): no bash-only features
  (`[[ … ]]`, arrays, `$'…'`, `source`), generous time margins, and skipped on Windows (`process.platform === 'win32'`).
- **Never spawn a shell string outside `S/workspace/shell.ts`**: no `spawn(…, { shell: true })`, `exec`, `execSync` or
  `child_process` with a command string anywhere else. **git runs only through `S/workspace/git.ts`** (argument
  arrays, `shell: false`, its scrubbed environment and `-c` overrides; paths after `--`, resolved through
  `resolveWorkspacePath` first). The MCP stdio transport keeps its own argument-array spawn.
  `S/security/process-spawn.test.ts` enforces the list.
- **Git in tests**: never a git write command on the harness-forge repository. Tests run `git init` inside their own
  `realpath(mkdtemp())` folder, set the author with `-c user.name=… -c user.email=…`, point `HOME` /
  `GIT_CONFIG_GLOBAL` at the temp folder and use `describe.skipIf(!hasGit())`.
- **Every path a workspace tool, a mention, a definition read, a skill file listing, a plan file or a Remember append
  touches** resolves through the frozen `resolveWorkspacePath` (`S/workspace/paths.ts`) and the sensitive-path rules
  (`S/workspace/sensitive.ts`); no `fs` call on a model-supplied, user-supplied or file-supplied path without it.
- **Checkpoint blobs and journal rows only through the checkpoint store** (`S/services/checkpoints/**`); sub-agent and
  background sub-agent writes go through the same `journaledWrite` under the launching message's run scope; plan files
  through `journaledWrite`, Remember appends through `deps.checkpoints.journal(...)`.
- Every new text or JSON column goes into `REFERENCE_SOURCES` or `UNSCANNED_COLUMNS` (`S/services/data/references.ts`;
  Phase 10 adds the columns of `customizations` and `background_tasks`, classified by C30: `customizations.content` and
  `.description` scanned, every other new column unscanned).
- The shell command matcher (`SH/util/shell-command.ts`) fails closed: anything it cannot tokenize asks.
- **Logging**: never log key material, secret values, file contents, diffs, tool inputs or outputs, shell commands,
  compaction summaries, steer / todo / plan texts, sub-agent prompts or outputs or mention queries at `info`; Phase 10
  adds: never log definition or skill bodies, command expansions, background prompts or reports, or Remember texts at
  `info` (`debug` only, redacted; diagnostics carry project-relative paths and never file contents).
- Timers are `unref()`-ed and cleared in `stop()`; tests use fake timers (no real sleep over 2 s).
- Contracts: DTOs and route keys only from `@harness-forge/shared`, plugin shapes only from
  `@harness-forge/plugin-sdk`; server services only through the frozen `types.ts` interfaces. A missing member, a
  contract change, a frozen-file edit or a **new test id** is a CCR in your report (file, current shape, proposed shape,
  reason) plus a local adapter so you can keep working.
- New components are imported explicitly by path (`import TaskResultNote from './agent/TaskResultNote.vue'`): the
  coordinator runs `nuxi prepare` only at the gates, so auto-import types do not know files created mid-wave.
- The props, emits and root test ids of the P10-0b stub components and the signatures of the new stores, modules and
  `useChatSession` additions are frozen after P10-0b: implement behind them; a change is a CCR.
- No doc edits in P10-A: write "For W10.14" notes (facts, deviations, suspected doc errors) into your report.
- Web unit tests: Nuxt composables come through a local `nuxt-imports.ts` that tests `vi.mock`; every password prompt
  goes through `useFreshAuth()` (UI.md 8.4).
- e2e uses only `.tmp/e2e/workspaces/*` for project folders.
- Verify before reporting — server: `pnpm -F @harness-forge/server test` · `pnpm typecheck`; shared:
  `pnpm -F @harness-forge/shared test`; plugin SDK: `pnpm -F @harness-forge/plugin-sdk test`; web:
  `pnpm -F @harness-forge/web test` · `pnpm -F @harness-forge/web typecheck:fast`; all: `pnpm check:english`; lint
  your files with `pnpm exec eslint --fix <your files>`.
- Report ≤ 300 words in the AGENT.md format (tasks, files, commands + results, CCRs, dependency requests, open issues,
  suggested ROADMAP updates). Commits are made only by the coordinator; never add AI attribution anywhere.

Carried over from Phase 9:

- **Only mock models** in tests (`MockLanguageModelV4`, `simulateReadableStream` from `ai/test`, the `mock:*` provider);
  catalog, command, skill and background code never resolves a real provider (or a key from the environment) in tests.
  Never `pnpm test:live`.
- **Verify AI SDK names** in `node_modules/.pnpm/ai@7.0.127_zod@4.6.5/node_modules/ai/dist/index.d.ts` (and
  `@ai-sdk/provider-utils` `dist/index.d.ts`) before use: `streamText({ instructions, messages, tools, activeTools,
  prepareStep, toolApproval, stopWhen: isStepCount, abortSignal })`, the `prepareStep` result fields, async-generator
  `execute`, `convertToModelMessages` options, `UIMessageStreamWriter`, transient data chunks. Phase 10 needs no new SDK
  API (provider-hosted skills are rejected: Anthropic-only, not BYOK).
- **History-derived state** (`findCompaction`, `compactionMarkers`, `splitSteers`, `latestTodos`, and now
  `splitTaskResults`, `taskResultText`) only from `SH/util/agent-state.ts`; mention parsing / ranking only from
  `SH/util/mentions.ts`; no local re-implementation on the server or the web.
- **Plan mode is enforced on the server** (tool set + approval), never only in the UI; `allowed-tools` keeps
  `exit_plan_mode` in plan mode.
- **Sub-agents never create approval requests** (foreground and background): a tool that would ask is not offered or is
  denied; depth 1; a test proves `task` and `skill` are absent from the child tool set.
- **In-memory state** (the queue, the sub-agent semaphores, the file index, the catalog cache, the background inbox
  and snapshots) is keyed by chat / project, bounded, cleared on chat delete, key rotation and shutdown; timers
  `unref()`.
- **Feature agents implement behind the P10-0b seams** (`S/chat/{pipeline,tools,steps,markers,model-history,
  agent-scope}.ts`, `S/chat/subagent/host.ts`, the frozen service types and the stub modules).

Phase 10 additions:

- **Project definition files are untrusted input** (`.harness/{agents,commands,skills}`, `.claude/{…}`): their
  `tools` / `allowed-tools` only restrict (never add a tool), they never change the mode, grant an approval, create a
  tool override or a shell rule; `model` resolves only to providers the user configured; a command body is text (no
  `!bash` execution, no `@file` expansion). Prompt injection through bodies is accepted like `AGENTS.md` today.
- **Reading project definitions**: every read through `resolveWorkspacePath` / `openWorkspaceFile` (no links anywhere
  on the path, regular files only, binary skipped, byte caps before parsing, count / depth caps, sensitive rules);
  never read `~/.claude` or `~/.harness` (user-level definitions live in the DB only).
- **Parsing only with the C29 helpers** (`SH/util/{definitions,arguments,tool-names}.ts`); `yaml` is imported only by
  `SH/util/definitions.ts`; verify its API in `node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/*.d.ts`.
- **Background tasks** never create approvals; are bounded (3 per chat, 10 per server, 30 min, `subagentMaxSteps`);
  are stopped on chat / project delete, delete-all, key rotation and shutdown (a restart leaves `aborted`), **never by
  the chat's Stop**; are delivered exactly once (`delivered_at`); their writes are journaled under the launching
  message; a running task makes its project busy (409 `run-active` for rewind / revert / undo / project delete / chat
  move / version delete; a branch switch stays allowed).
- **Writes**: plan files and `AGENTS.md` / `CLAUDE.md` appends go only through the journal (`journaledWrite` /
  `checkpoints.journal(...)`) and the file lock; hidden-path write policies (`always`) are never relaxed, so the agent
  can never silently rewrite `.harness/**` or `.claude/**`.
- **New parts and their consumers**: `data-task-result` → model history (`splitTaskResults` stage, C31; injection and
  the carrier message, W10.4), search text, Markdown export, import, share drop (W10.6), `chat-format` /
  `TaskResultNote` (W10.11), the carrier turn (W10.10 refresh + resume, W10.11 rendering); `tool-skill` →
  `toModelOutput` (W10.5), the skill row + share row (W10.11). Each consumer is covered by its owner's test.
- **Hot files have one owner per wave** (P10-A: `prepare.ts`, `commands.ts`, `context.ts`, `notices.ts` → W10.2;
  `params.ts`, `subagent/**` → W10.3; `steer.ts`, `queue.ts`, `index.ts`, the chat / chats / chat-tasks routes →
  W10.4; `ChatComposer.vue`, `SlashMenu.vue` → W10.9; `ChatView.vue`, `useChatSession.ts`, `useServerEvents.ts` →
  W10.10; `ToolPart.vue`, `TaskBlock.vue`, `ChatMessage.vue`, `chat-format.ts` → W10.11);
  `S/chat/{pipeline,tools,steps,markers,model-history,agent-scope}.ts` are complete and frozen after P10-0b (a change is
  a CCR).
- The mock models `mock:agents` and `mock:background` are frozen after P10-0b; PROVIDERS.md 8 ("Customization mocks
  (Phase 10)") is the probe contract.

## FREEZE in Phase 10

In force since earlier phases (AGENT.md): `packages/*/src`, `S/app.ts`, `S/db/schema.ts`, `apps/server/drizzle/**`,
every `*/types.ts` under `S`, `S/builtin-plugins/index.ts`, `W/layouts/**`, store signatures in `W/stores/**`,
`apps/web/nuxt.config.ts`, every `package.json` and config file, `W/components/{ui,ai-elements}/**`, the CSS design
tokens in `W/assets/css/main.css`, `W/utils/testids.ts` (Phase 5), the Phase 5 – 8 additions (the services `types.ts`
files, `S/workspace/{paths,run-scope,file-lock,git}.ts`, `S/services/chats/approvals.ts`, the `main.ts` boot hooks,
`SH/util/shell-command.ts`, the props of the P6-0b, P7-0b and P8-0b stub components, `DiffView` props, the `projects`,
`workspace` and `shell-rules` stores, `useChangesPanel`, the `useChatSession` additions of Phases 7 and 8, the mock
models of Phases 6 – 8) and the Phase 9 additions (`S/services/project-files/types.ts`, the P9-0b versions of
`S/types.ts`, `S/chat/types.ts` and the deps order, `S/chat/{steps,markers,model-history,agent-scope}.ts`, the P9-0b stub
signatures, `S/builtin-plugins/{index.ts,core-agent/index.ts}`, the Phase 9 mock models, `SH/util/{agent-state,
mentions}.ts`, plugin SDK 1.3.0, the props / emits / root test ids of the P9-0b stub components, the `chat-queue`
store, the `useProjectFiles` / `useFileMentions` / `useModeCycle` signatures, the `useChatSession` additions, the
Phase 9 test ids).

P10-0a and P10-0b open the frozen files **only** for their named owners:

- P10-0a: K1 — `AGENT.md`, `docs/DECISIONS.md`, `docs/ROADMAP.md`; K2 — `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
  `packages/shared/package.json`, `apps/server/package.json`, `apps/web/package.json`; the coordinator — the contract
  skeletons `SH/util/{definitions,arguments,tool-names}.ts`, `SH/ids.ts` (agent names) and `SH/index.ts` (exports), and
  at the gate `examples/plugins/*/harness-forge.d.ts` (regenerated for 1.4.0); C28 — `SH/**` (not the C29 files),
  `packages/plugin-sdk/src/**`, `S/app.ts`, `S/plugins/templates/sdk-types.ts`; C29 —
  `SH/util/{definitions,arguments,tool-names,agent-state}{,.test}.ts` (complete).
- P10-0b: K3 — `S/db/schema.ts` (two tables, `TABLE_NAMES` 20) + `apps/server/drizzle/**`; C30 — `S/types.ts`
  (`AppServices.customizations`), `S/deps.ts` (factory, start and stop order), `S/env.ts` (compile fixes only),
  `S/main.ts` (the boot hook), `S/chat/types.ts` (the `ChatRunner` task members), `S/registry/types.ts` (kinds `agent`
  / `skill`, `agents`, `skills`, contributions), `S/services/customizations/types.ts` (new), `S/chat/background/types.ts`
  (new); C31 — `S/chat/{pipeline,tools,model-history,agent-scope}.ts` (the Phase 9 seams opened for the Phase 10
  additions; `steps.ts` and `markers.ts` only if a seam needs it, reported), `S/chat/subagent/host.ts` (new); C32 —
  `S/builtin-plugins/index.ts`, `S/builtin-plugins/core-agent/index.ts` (manifest `engines ^1.4.0`, the `task` schema
  and description, the `skill` tool), the mock models (`S/builtin-plugins/mock/**`); C33 — `W/utils/testids.ts`, the
  store signatures of `W/stores/customizations.ts` and `W/stores/background-tasks.ts` (new) and the `agents` filter in
  `W/stores/plugins.ts`, the prop / emit additions of the P9-0b components it touches (`TaskBlock` accepts any type
  string), the `useChatSession` interface additions.

Added to the freeze after Gate P10-0b:

- `S/services/customizations/types.ts`, `S/chat/background/types.ts` and `S/chat/subagent/host.ts` (new); the P10-0b
  versions of `S/types.ts`, `S/chat/types.ts`, `S/registry/types.ts`, the deps start / stop order and the boot sweep;
- `S/chat/{pipeline,tools,steps,markers,model-history,agent-scope}.ts` (complete, C31) and the signatures of the C31
  stubs (`prepareRun(…, { serverMessage })`, `resolveCommand(…, { catalog })`, `isServerCommandFor`,
  `turnToolRestriction`, `RunParamsInput.{agentTypes, skills}`, `runDetachedChild`, `S/chat/skills.ts`,
  `S/chat/plan-file.ts`, the background wiring of `S/chat/index.ts`);
- `S/builtin-plugins/{index.ts,core-agent/index.ts}` (the manifest, `engines ^1.4.0`, the four tool schemas,
  descriptions, policies and model texts, the builtin agent definitions);
- the mock models `mock:agents` and `mock:background` (PROVIDERS.md 8 ("Customization mocks (Phase 10)"));
- `SH/util/{definitions,arguments,tool-names,agent-state}.ts` (complete, C29; a behavior change after the gate is a
  CCR); the plugin SDK 1.4.0 and its template mirror;
- the props, emits and root test ids of the C33 stub components (`CustomizeSettings`, `CustomizationSection`,
  `CustomizationRow`, `CustomizationEditor`, `CustomizationViewer`, `ToolMultiSelect`, `MarkdownEditor`,
  `SlashArgumentHint`, `RememberDialog`, `BackgroundAgents`, `BackgroundAgentRow`, `TaskResultNote`, `SkillToolBody`,
  `PlanFileChip`, `PluginCustomizationList`);
- the `customizations` store (`useCustomizationsStore`) and the `background-tasks` store (`useBackgroundTasksStore`),
  the `AGENT_TASK_CONTEXT` injection key, `taskResultsOf` / `isTaskResultMessage`, the signatures of the pure modules
  (`customize.ts`, `remember.ts`, `background-agents.ts`, `downloadText`), the `useChatSession` additions;
- the Customize settings route (`/settings/customize`) and its nav entry; the Phase 10 test ids (UI.md 13.11) in
  `W/utils/testids.ts`.

No CCR is pre-approved for P10-A; the coordinator batches CCRs at Gate P10-A.

---

## Wave P10-00 — stabilization start (done)

1. **Design inputs** — the three Plan reports extracted into `.tmp/p10-designs/{server,web,process}.md` (with
   `.tmp/p8-designs/extract.mjs`, copied alongside), the exploration notes into `explore-{subagents,commands,web}.md`, the
   approved plan copied to `plan.md`, the reconciliation written to `README.md`, the rules draft to `agent-rules.md`.
2. **CI and PRs** — `origin/main` = `5481fb3`: the CI run `37162957905` (check, e2e, docker, actionlint) and the Audit
   run `37162958016` are green; `gh pr list` is empty (Dependabot #5 and #6 were merged on 2026-10-03).
3. **Audit advisories** — GHSA-86w9-cpqp-85rv (node-forge) and GHSA-vfj7-8cjw-p6xm (braces) re-checked with the P8-00
   decision rule (a) – (e): still `first_patched_version: null` → (d), both ignores stay; the backlog line carries the
   re-check date 2026-10-04.
4. **Baseline** — `pnpm check` green with 9469 tests (`.tmp/gates/P10-00/check.log`); `git status --porcelain` identical
   before and after (`status-before.txt`, `status-after.txt`).
5. **Old build for the seed** — `git worktree add .tmp/v15 5481fb3`, then `pnpm -C <abs>/.tmp/v15 install
   --frozen-lockfile` and `pnpm -C <abs>/.tmp/v15 build` (absolute paths, never `cd` into the worktree;
   `.tmp/gates/P10-00/v15-build.log`).
6. **Memory** — the note "v1.5 pushed (`5481fb3`, CI + Audit green); Phase 10 = Agent customization; plan in
   `.tmp/p10-designs`; seed `.tmp/upgrade-v15`" with the gotchas (`bash -c` loops, `mv` instead of `rm -rf`, `.tmp/e2e`
   moved aside before every gate, absolute paths / `git -C`, kill by port) is the coordinator's.

---

## Wave P10-0a — decisions, contracts, docs

Four agents in one launch (C28, C29, D12, D13) after K1 and K2; the K3 seed runs alongside (agent K3S).

### Coordinator actions

- **K1 (done)** — `docs/DECISIONS.md`: ADR-044 … ADR-047, the amendment notes on ADR-024 (personal definitions in
  backups, kept by delete-all), ADR-036 (background writes journaled under the launching message; plan files and
  Remember appends journaled), ADR-041 (plan files), ADR-042 (the steer step also delivers task results) and ADR-043
  (`type` names any catalog agent; a background child outlives its tool call); the contract seed (ids `cus_` / `bgt_`,
  agent and skill names, builtin agent types and the alias, the definition folders, the plugin API 1.4.0 line, the
  client command `remember`, enumerations, the HTTP module rows `customizations.ts` / `memory.ts` / `chat-tasks.ts`
  that `routes.test.ts` reads, events, the chat request note, the data parts, settings, the tables and `0007`, the mock
  models, the example plugin `agent-pack`, `customizations.json` in backups, the plugin filter `agents`).
  `docs/ROADMAP.md`: the Phase 10 section (one box per agent) and the backlog (removed: user-defined and background
  agents, plan files; added: the out-of-scope list of this file). `AGENT.md`: the stack row (`yaml` 2), the "Plugin API
  1.4.0" and "Customization" facts and the Phase 10 freeze line.
- **K2 (done)** — `yaml: ^2.9.1` in the `pnpm-workspace.yaml` catalog; `"yaml": "catalog:"` in `packages/shared` (the
  importer), `apps/server` (tsdown `onlyBundle: []` keeps runtime imports external and the Docker
  `--prod --filter=@harness-forge/server` install must find it) and `apps/web` (the same pattern as `zod` / `ai`);
  `pnpm install` (importer edges only; `yaml@2.9.1` was already in the lockfile transitively, ISC, no dependencies, no
  install script, so no `allowBuilds`).
- **Contract skeletons (done)** — `SH/util/definitions.ts` (`CUSTOMIZATION_KINDS`, `CUSTOMIZATION_SOURCES`,
  `DEFINITION_FOLDERS`, `DEFINITION_LIMITS`, `DEFINITION_DIAGNOSTIC_LEVELS` / `_CODES`, `DefinitionDiagnostic`, the
  per-kind field types, `ParsedDefinition`, `parseDefinition`, `formatDefinition`, `RankedDefinition`, `definitionRank`,
  `resolvePrecedence`), `SH/util/arguments.ts` (`splitArguments`, `expandArguments`), `SH/util/tool-names.ts`
  (`CLAUDE_TOOL_ALIASES`, `normalizeToolList`, `matchToolAllowlist`), `SH/ids.ts` (`AGENT_NAME_PATTERN`,
  `agentNameSchema`, `BUILTIN_AGENT_TYPES`, `AGENT_TYPE_ALIASES`, `isReservedAgentName`) and the three exports in
  `SH/index.ts`: the names and signatures are final, the bodies throw until C29 implements them.
- **K3 seed (background, agent K3S)** — the `.tmp/v15` build (`5481fb3`) on :8898 with `HF_MOCK_PROVIDER=1`,
  `HF_DATA_DIR=.tmp/gates/P10-0b/seed-data` and `HF_WORKSPACE_ROOTS=<repo>/.tmp/gates/P10-0b/seed-roots` (outside the
  data dir, so a copy keeps a valid project path), driven by `.tmp/gates/P10-0b/seed-v15.mjs` (derived from
  `.tmp/gates/P9-0b/seed-v14.mjs`), password `probe-pass-123`:
  - the v1.4 set: a provider key, an MCP header secret, a branched chat with a share link, a pending shell approval, a
    git project with `mock:checkpoint` turns and one rewind batch, project and global rules, `fileSweep: daily`, the long
    `mock:echo` chat;
  - the Phase 9 state: a project chat with `mock:subagent` turns (stored `tool-task` parts with `type: explore` and
    `general`), a `mock:plan` chat approved in `edits` (`notes.txt` journaled), one plan still awaiting approval, a
    `mock:todo` chat, a `/compact`-ed chat, a `mock:steer` chat with a delivered steer;
  - settings: non-empty `instructions`, `subagentMaxSteps: 12`, `defaultToolMode: 'edits'`; non-empty project
    instructions;
  - project files that v1.5 ignores and v1.6 must discover: `AGENTS.md` (with an `@notes.md` import),
    `.claude/agents/reviewer.md` and `.harness/agents/reviewer.md` (the `.harness` one wins), `.claude/agents/escalate.md`
    (`tools: [shell, write_file]`), `.claude/commands/greet.md` (`$ARGUMENTS`, `argument-hint`, `model: mock:echo`),
    `.claude/skills/release-notes/SKILL.md`, one file with invalid YAML, one file over 64 KiB, a symlink
    `.claude/commands/link.md → /etc/hosts`;
  - stop the server by port → copy to `.tmp/upgrade-v15` and the ids (chats, share token, project, pending approvals,
    message and `workspace_changes` counts) to `.tmp/upgrade-v15-ids.json` (never `.tmp/e2e`, which the gates migrate).
    No SQL plants: `0007` only creates tables. **Probes never write into `seed-roots`**: a probe that writes copies the
    roots and points `projects.path` at the copy by SQL before boot. Every later upgrade probe runs on a fresh copy of
    `.tmp/upgrade-v15`.
- Ownership file `.tmp/waves/P10-0a.json` (below).

### C28 contracts (k2)

- **Mission.** Write every shared contract of Phase 10, the plugin SDK 1.4.0, the nine new routes as 501 stubs and
  `docs/API.md`, keeping `pnpm check` green.
- **Owned.** `SH/**` (not the C29 files), `packages/plugin-sdk/src/**`, `S/plugins/templates/{sdk-types,templates.test}.ts`,
  `docs/API.md`, `S/app.ts`, `S/http/routes/{customizations,memory,chat-tasks}.ts` (new 501 stubs),
  `S/testing/api-samples.ts`, `S/http/routes-mounted.test.ts`, the route-table-driven security tests
  (`S/http/middleware/{session-auth,fresh-auth}.test.ts`, `S/security/{fresh-auth-routes,secret-leaks,request-guards}
  .test.ts`), `W/utils/testing/fixtures.ts`, and every fixture, count pin or compile fix the new required fields need
  (listed in the report; the coordinator accepts them in the audit as `C28-compile-fixes`; expected:
  `S/plugins/context.ts` for `PluginContext.agents` / `.skills`, see open point 8).
- **Read-only highlights.** `.tmp/p10-designs/**` (the plan's Reconciliation table, section 8 and README are binding),
  `docs/DECISIONS.md`, the coordinator's skeletons `SH/util/{definitions,arguments,tool-names}.ts` (C29 implements them),
  `SH/api/routes.test.ts` and `contract.test.ts` (doc-coupled: API.md section 8 and the DECISIONS module table),
  `SH/schemas/dto.test.ts` (the settings key count), `SH/isomorphic.test.ts` (exported value names),
  `packages/plugin-sdk/src/exports.test.ts`.
- **Tasks.**
  1. **C28-T1 Ids, enums, limits** — `SH/ids.ts`: `cus_` / `bgt_` patterns, schemas and generators (next to the
     coordinator's agent-name additions); `CLIENT_COMMANDS` + `remember` (a plugin `/remember` is then refused: a release
     note). `SH/enums.ts`: `customizationKindSchema` / `customizationSourceSchema` (built on the skeleton's
     `CUSTOMIZATION_KINDS` / `CUSTOMIZATION_SOURCES`), `customizationStateSchema` (`active | shadowed | invalid | off`),
     `commandSourceSchema` (`harness | plugin | user | project`), `rememberTargetSchema` (`project-file |
     project-instructions | global`). `LIMITS` Phase 10 group: `customizationContentBytes` 65536,
     `customizationFrontmatterBytes` 8192, `customizationFilesPerFolderMax` 200, `customizationDescriptionMaxChars` 1024,
     `customizationsPerKindMax` 200, `customizationIndexTtlMs` 10000, `agentTypesListedMax` 30, `skillsListedMax` 50,
     `listedDescriptionMaxChars` 250, `skillFilesListedMax` 50, `rememberTextMaxChars` 2000, `rememberFileMaxBytes`
     1 MiB, `backgroundTasksPerChatMax` 3, `backgroundTasksMax` 10, `backgroundTaskTimeoutMs` 1 800 000,
     `backgroundTasksKeptPerChat` 100. *Accept:* `ids.test.ts` (client and harness commands disjoint, `remember` a client
     command, the generators match their patterns), enum and limit tests; a test pins the three `DEFINITION_LIMITS` that
     mirror `LIMITS`.
  2. **C28-T2 Agent tool schemas (`SH/schemas/agent.ts`)** — `AGENT_TOOL_NAMES` + `skill` (4); `agentTypeInputSchema`
     (`z.string().trim().toLowerCase()` + `AGENT_NAME_PATTERN`; alias resolution is the server's); `taskInputSchema.type`
     = it, `background?: boolean`; `taskOutputSchema.type: agentNameSchema`, `taskId?`, `agent?: { source, description
     ≤ 200, path? }`; `taskStatusSchema` + `background`; `taskTypeSchema` stays the builtin enum (web icons);
     `exitPlanModeOutputSchema.planPath?` / `planError?`; `skillInputSchema` (`{ name }`) and `skillOutputSchema` (`{ name,
     description, source, content ≤ 64 KiB, truncated, baseDir?, files? ≤ 50 }`). *Accept:* v1.5 `tool-task` parts
     (`explore` / `general`) parse; `type: ' Reviewer'` → `reviewer`; a background output (`status: background`,
     `taskId`, no steps); a skill output at every cap serializes under the 64 KB tool output cap.
  3. **C28-T3 Customizations (`SH/schemas/customizations.ts`, new)** — the diagnostic (`{ level, code, message, line?,
     path?, kind?, name? }`, the skeleton's `DefinitionDiagnostic` as zod); `customizationEntrySchema` (`{ kind, name,
     description, source, id? (user), pluginId?, path? (project), namespace?, argumentHint?, modelRef?, tools?, enabled,
     state, shadowedBy?, diagnostics }`); the list query (`{ projectId?, kind?, refresh? }`) and result (`{ items,
     diagnostics (folder level), project: { available, issue?, folders, scannedAt } | null }`); the source query
     (`{ projectId?, kind, name, source }`) and result (`{ content, path? }`); the create body (strict `{ kind, content
     ≤ 64 KiB, enabled? }`) and the update body (the same fields; C28 fixes which are optional; a changed `kind` is
     refused); the user customization DTO (`{ id, kind, name, description, content, enabled, createdAt, updatedAt }`
     plus the parsed fields); the remember body (strict `{ target, text 1 – 2000, chatId? }`) and result (`{ target,
     file?, created?, project?, settings? }`); the backup item. *Accept:* samples; a 65 537-byte content refused; a
     remember body with an unknown key refused.
  4. **C28-T4 Background tasks (`SH/schemas/background-tasks.ts`, new)** — `backgroundTaskSchema` (the row: `{ id, chatId,
     messageId, toolCallId, type, description, origin, status, output: TaskOutput, createdAt, finishedAt, deliveredAt,
     deliveredMessageId }`, timestamps epoch ms), the list result (`{ items }`), `taskResultDataSchema` (`{ taskId,
     toolCallId, messageId, output, deliveredAt }`), `taskChangedDataSchema` (`{ chatId, task }`),
     `chatTaskParamsSchema` (`{ id, taskId }`). The stop answer is C28's (proposed: 200 with the task — `aborted`, or its
     final status when it had already ended — and 404 for an unknown task). *Accept:* samples.
  5. **C28-T5 Commands** — `commandSummarySchema`: `pluginId` optional, + `source`, `namespace?`, `argumentHint?`,
     `modelRef?`; `commandsQuerySchema` (`{ projectId? }`); `commandInvocationSchema` + `source?`, `modelRef?`,
     `allowedTools?` (≤ 64 tool names); notice `command-model-unavailable` (8 codes). *Accept:* a v1.5 command summary
     (with `pluginId`) and a v1.5 invocation parse.
  6. **C28-T6 Parts and events** — `harnessDataSchemas['task-result']` / `HarnessDataTypes` (5 data part types);
     `SERVER_EVENT_TYPES` + `task.changed`, `customization.changed` (`{ kind?, id?, projectId? }`) (15); `runOriginSchema`
     + `task`. *Accept:* a v1.5 message (every Phase 9 part) and a v1.5 `run.started` parse; a carrier user message with
     only `data-task-result` parts validates through `harnessDataSchemas`; the event count pin 15.
  7. **C28-T7 Settings** — `planFiles` (false), `planDirectory` (`.harness/plans`: a relative POSIX path, no absolute
     path, no `..` segment, no `.git` segment, ≤ 200 characters) → `SETTINGS_KEYS` 28; neither needs fresh auth.
     *Accept:* a v1.5 settings document parses with the defaults; `../x`, `.git/x`, `/abs` refused; `dto.test.ts` at 28.
  8. **C28-T8 Plugins and data** — `declarativeAgentSchema` (`name` per `AGENT_NAME_PATTERN`, not reserved,
     `description`, `instructions` ≤ 64 KiB, `tools?` ≤ 64 tool names, `model?`), `declarativeSkillSchema` (`name`,
     `description`, `content` ≤ 64 KiB), `contributes.agents` / `contributes.skills` (≤ 50 each), contributions `agents`
     / `skills` (name lists); `declarativeCommandSchema` refuses `remember` (through `CLIENT_COMMANDS`); backup
     `includes.customizations?`, export `customizations?`, import `restoreCustomizations?`, result `customizations?`.
     *Accept:* manifest samples; a `^1.3.0` manifest still parses; an agent named `explore` refused.
  9. **C28-T9 Route table** — `ApiModule` += `customizations`, `memory`, `chatTasks`; keys `customizations.list` (`GET
     /customizations`), `customizations.source` (`GET /customizations/source`), `customizations.create` (`POST
     /customizations`, 201), `customizations.get` / `.update` / `.remove` (`GET` / `PATCH` / `DELETE
     /customizations/:id`, 204 on delete), the `memory` route (`POST /memory`; key proposed `memory.remember`),
     `chatTasks.list` (`GET /chat/:id/tasks`), `chatTasks.stop` (`POST /chat/:id/tasks/:taskId/stop`); `commands.list`
     gains its query; none `fresh` → **109** routes, 30 modules. C28 may rename the keys (reported; API.md section 8 is
     the index). *Accept:* `routes.test.ts` (API.md section 8 index + the DECISIONS module table) and `contract.test.ts`
     at 109.
  10. **C28-T10 Plugin SDK 1.4.0** — `PLUGIN_API_VERSION` `'1.4.0'`; `AgentDefinition { name, description, instructions
      ≤ 64 KiB, tools?, model? }`, `SkillDefinition { name, description, content ≤ 64 KiB }`, `PluginContext.agents
      .register(definition): Disposable`, `PluginContext.skills.register(definition): Disposable`, the manifest
      `contributes.agents` / `.skills` (doc comments: restrict-only tools, reserved names, a duplicate across plugins is a
      conflict); the template mirror `S/plugins/templates/sdk-types.ts` follows (`templates.test.ts`); `exports.test.ts`
      pins. *Accept:* SDK tests; builtin manifests with `engines ^1.3.0` still load (a compatible minor).
  11. **C28-T11 `docs/API.md`** — the `LIMITS` rows; settings (28); notice codes (8); the new schema sections from 4.28
      (customizations, catalog entries and diagnostics, background tasks, Remember, the `task` / `skill` /
      `exit_plan_mode` additions in 4.25); the three modules from 5.28 with every answer (customizations: 200, 201, 204,
      400 with the diagnostics in `details`, 404 unknown id / project / name, 409 `exists`, the per-kind cap; memory: 200,
      400 no project chat / a link / the instruction cap, 404 unknown chat, 413 file cap; chat tasks: 200, 404); `GET
      /commands?projectId` (404 unknown project, the new item fields); the stream additions in 6.10 (`data-task-result`,
      the carrier message, `run.started.origin: 'task'`, `metadata.command.modelRef` / `.allowedTools`, the notice);
      the events (`task.changed`, `customization.changed`); the 109-route index in the parsed format.
  12. **C28-T12 Stubs and compile fixes** — `S/app.ts` mounts `customizations`, `memory` and `chatTasks`; the nine routes
      validate first (400) and answer `501 not_implemented`, `GET /customizations/source` registered before `GET
      /customizations/:id` (open point 7); `api-samples.ts`; the route-table security tests follow;
      `W/utils/testing/fixtures.ts` and every other fixture get the two settings keys and the new DTO fixtures.
      *Accept:* `routes-mounted.test.ts` green (no new route answers 404); `pnpm check` green; v1.5 messages (old task
      parts), settings, stop results and `^1.3.0` manifests still parse.
- **Tests.** Schema tests for every new DTO; route-table tests; the updated route-driven security tests.
- **Verify.** Shared, plugin SDK, server and web commands.

### C29 definition helpers (k3)

- **Mission.** The shared helpers that parse, format and rank definition files, normalize their tool lists, expand
  command arguments and split task results out of a message path, complete and tested (frozen after Gate P10-0b; used by
  C30 – C33, W10.1 – W10.6, W10.8, W10.9, W10.11).
- **Owned.** `SH/util/{definitions,arguments,tool-names}{,.test}.ts` (implementing the coordinator's skeletons: the
  exported names and signatures stay; an addition is listed in the report) and `SH/util/agent-state{,.test}.ts` (the
  task-result additions only; every C23 export and test unchanged).
- **Read-only highlights.** ADR-044, ADR-045, ADR-046; the plan's Reconciliation table and sections 1 – 5;
  `node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/*.d.ts` (`parse` / `parseDocument` options `schema`,
  `maxAliasCount`, `uniqueKeys`, `prettyErrors`, `strict`; verify every name); `SH/schemas/{agent,customizations,
  background-tasks}.ts` (C28); `SH/ids.ts` (`AGENT_NAME_PATTERN`, `COMMAND_NAME_PATTERN`, `isReservedAgentName`,
  `CLIENT_COMMANDS`, `HARNESS_COMMANDS`); `S/chat/commands.ts` (`expandTemplate`, the append rule).
- **Tasks.**
  1. **C29-T1 `parseDefinition(kind, text, options)`** — never throws; the byte cap (`maxBytes`, at most 64 KiB) before
     anything else (`too-large`); a NUL → `binary`; frontmatter only at byte 0 (BOM allowed, CRLF normalized), the
     closing `---` within 8 KiB (`invalid-frontmatter` otherwise); `yaml` with `schema: 'core'`, `maxAliasCount: 0`,
     `uniqueKeys: true`; the frontmatter must be a mapping; per kind: agents `name`, `description` (required), `tools`
     (comma string or list, through `normalizeToolList`), `model` (`provider:model` | `inherit`; `sonnet` / `opus` /
     `haiku` → null + `model-alias` (info); anything else → `invalid-model`); commands `description`, `argument-hint`
     (≤ 100), `model`, `allowed-tools`; skills `name`, `description`; the name falls back to the file stem (agents,
     commands) or the folder name (skills); name patterns (`invalid-name`), reserved names (`reserved-name`: builtin
     agent types and aliases; client and harness commands), descriptions cut at 1024 characters (warning), unknown keys
     → `ignored-key` (info); `line` set where `yaml` reports one; an `error` diagnostic → `definition: null`. *Accept:*
     table tests per kind (a real Claude Code agent file with quoted colons, a block scalar and a list; an empty
     frontmatter; `---` inside the body; a missing closing line; a duplicate key; an alias; a 64 KiB + 1 byte text; a
     BOM + CRLF file).
  2. **C29-T2 `formatDefinition(definition)`** — markdown with a frontmatter block that `parseDefinition` reads back to
     the same fields (stable key order, quoting where YAML needs it, a trailing newline). *Accept:* round-trip tables
     for every kind, incl. multi-line descriptions and names that look like numbers or booleans.
  3. **C29-T3 Precedence** — `definitionRank` (builtin 0 < plugin 1 < user 2 < project `.claude` 3 < project `.harness`
     4, from `path`) and `resolvePrecedence(entries)` → `{ active, shadowed: { entry, by }[] }` per (kind, name); within
     one folder the first sorted path wins (the catalog adds `duplicate-name`). *Accept:* tables (all five sources with
     one name; two files of one folder; different kinds with one name never shadow each other).
  4. **C29-T4 Tool lists** — `normalizeToolList(value)` (comma string or list; Claude Code names mapped through
     `CLAUDE_TOOL_ALIASES`; `mcp__*` kept; `Bash(git:*)`-style patterns keep the tool and add `tool-pattern`; other
     names kept for the catalog to check against the live list; deduplicated; ≤ 64 entries; absent → `tools: null`);
     `matchToolAllowlist(toolName, allowlist)` (exact names; `mcp__server__*` prefixes). A list only ever narrows.
     *Accept:* tables (aliases, duplicates, an empty list = no tools, `null` = no restriction, a non-string entry).
  5. **C29-T5 Arguments** — `splitArguments(input)` (whitespace split; double and single quotes group words; an
     unbalanced quote keeps the rest as one word); `expandArguments(body, input)` → `{ text, usedPlaceholder }`
     (`$ARGUMENTS` = the whole input, `$1` … `$9` = the words or empty, `{{input}}` = the whole input; no placeholder →
     the input appended after a blank line, the `expandTemplate` rule; `!` lines and `@file` stay text; `$10` is `$1`
     followed by `0`). *Accept:* tables.
  6. **C29-T6 Task results (`agent-state.ts`)** — `TASK_RESULT_PART_TYPE` (`data-task-result`), `taskResultText(data)`
     (`<background-task id="…" type="…" status="…">report or error</background-task>`, attribute values escaped) and
     `splitTaskResults(messages)`: an assistant message is split at each `data-task-result` part into assistant
     (before) / user (the result text) / assistant (after), empty halves dropped, halves keep the assistant id and
     metadata; a user-role carrier's `data-task-result` parts become text parts; no two user messages in a row (a result
     next to a steer's user half is merged into it; open point 10); other messages untouched. `splitSteers` stays as is.
     *Accept:* tables (one result, two results, a result and a steer at one boundary, a carrier message, a message
     without results returned as is); every C23 test unchanged and green.
  7. **C29-T7 Fuzz** — a seeded generator: `parseDefinition` never throws on alias bombs, 10 000-deep nesting, random
     bytes, CRLF, BOM, empty frontmatter and `---` inside the body, and stays fast (the caps apply first);
     `formatDefinition` → `parseDefinition` round-trips random valid fields; `expandArguments` never throws;
     `splitTaskResults` never produces two user messages in a row.
- **Tests.** The tasks above (`definitions.test.ts`, `arguments.test.ts`, `tool-names.test.ts`, `agent-state.test.ts`).
- **Verify.** `pnpm -F @harness-forge/shared test`; `pnpm check:english`; eslint on the eight files.

### D12 phase doc (k1)

- **Mission.** Write this file so P10-0b, P10-A and P10-B agents can build against it.
- **Owned.** `docs/phases/phase-10-v1-6.md` (new).
- **Tasks.**
  1. **D12-T1 Phase doc** — goal, totals, criteria, the binding deviations and open points, the rules for every agent,
     the FREEZE list, every wave with owned globs, tasks with acceptance criteria, ownership JSON, cross-agent
     contracts, gates and probes, risks; contradictions between the plan, DECISIONS.md and the reports listed in the
     report (the plan's version written here).
- **Verify.** `pnpm check:english`.

### D13 docs (no server)

- **Mission.** Update the user-facing and architecture docs for Phase 10 so P10-0b and P10-A agents can build against
  them.
- **Owned.** `docs/UI.md`, `docs/ARCHITECTURE.md`, `docs/PLUGINS.md`, `docs/PROVIDERS.md`, `docs/guides/**`,
  `README.md`, `.env.example`.
- **Tasks.**
  1. **D13-T1 UI.md** — the new 2.17 wireframes (Customize page and editor sheet, the grouped slash menu with the ghost
     hint, custom / background task blocks, the result note, the skill row, the plan-file chip, the background agents
     dock, the Remember dialog; desktop and 390 px); 5.5 navigation (Customize after Projects, `WandSparkles`, the
     palette entry); 6 the route `/settings/customize` (`?tab`, `?project`); amend 7.8 (groups, argument hints,
     `/remember`), 7.25 (the plan-file chip) and 7.27 (custom and background task blocks); new 7.28 commands and skills,
     7.29 background agents, 7.30 Remember; 9.11 (the two plan-file fields), 9.12 Customize; 10.7 contracts (props /
     emits / exposes of every P10-0b stub), 11.7 modules (the `customizations` and `background-tasks` stores,
     `AGENT_TASK_CONTEXT`, `taskResultsOf` / `isTaskResultMessage`, the pure modules, the `useChatSession` additions); 12
     shortcuts (Mod+Enter in the editor and the dialog, Esc never stops background agents); 13.11 test ids (56; the
     list in "C33 web skeleton" below); 14 accessibility (the announcer, the dialog focus, 40 px targets, no Tab capture
     in the editor); 15 copy (the term "background agent").
  2. **D13-T2 ARCHITECTURE.md** — 5 (stop order: queues → background tasks → runs; the catalog cache; the boot sweep),
     6.9 (backups carry `customizations.json`; delete-all keeps it), the new 6.23 catalog (sources, precedence,
     discovery guard, caps, cache), 6.24 commands (resolution order, expansion, the model override, `allowed-tools`),
     6.25 skills, 6.26 background tasks (launch, persistence, inbox, delivery, the carrier turn, chain depth 1, guards,
     restart), 6.27 plan files and Remember, 8 (`0007_customizations`, the two tables and their columns), 10.11 security
     (untrusted definitions, restrict-only, link refusal, YAML caps, hidden-path writes), 12 (log lines: no bodies,
     expansions, background prompts / reports or Remember texts at `info`).
  3. **D13-T3 PLUGINS.md** — API 1.4.0 (the version table row, `contributes.agents` / `.skills`, `ctx.agents.register`,
     `ctx.skills.register`, validation, conflicts, reserved names incl. the client command `remember`), the builtin
     `core-agent` gains `skill`. *Accept:* `manifest.test.ts` and `examples.test.ts` still parse PLUGINS.md.
  4. **D13-T4 PROVIDERS.md 8 ("Customization mocks (Phase 10)")** — the two mock models exactly as in "C32 core-agent and
     mock models" below (it is the probe contract).
  5. **D13-T5 Guide** — `docs/guides/customizing-agents.md`: the three kinds and their frontmatter, the folders and
     precedence (`.harness` over `.claude`, the personal set, plugins), the Claude Code compatibility notes (tool name
     mapping, `allowed-tools` only narrows, model aliases, `!bash` / `@file` stay text, skills are not slash commands),
     background agents (limits, Stop, restart), plan files, `/remember`.
  6. **D13-T6 README and `.env.example`** — features, the status "v1.6 in progress"; `.env.example` unchanged (no new
     variable).
- **Verify.** `pnpm check:english`; `pnpm -F @harness-forge/shared test` (doc-coupled tests).

### Wave P10-0a ownership

The audit cannot express "except": the C29 files match C28's `packages/shared/src/**` glob too (a warning; C29 owns
them). C28 lists the extra fixture and compile-fix files it had to touch in its report; the coordinator adds them to
`C28-compile-fixes`. K3S writes only below `.tmp/` (allowed). This is `.tmp/waves/P10-0a.json`:

```json
{
  "wave": "P10-0a",
  "agents": {
    "K1": [
      "AGENT.md",
      "docs/DECISIONS.md",
      "docs/ROADMAP.md"
    ],
    "K2": [
      "pnpm-workspace.yaml",
      "pnpm-lock.yaml",
      "packages/shared/package.json",
      "apps/server/package.json",
      "apps/web/package.json"
    ],
    "C28": [
      "packages/shared/src/**",
      "packages/plugin-sdk/src/**",
      "apps/server/src/plugins/templates/sdk-types.ts",
      "apps/server/src/plugins/templates/templates.test.ts",
      "docs/API.md",
      "apps/server/src/app.ts",
      "apps/server/src/http/routes/customizations.ts",
      "apps/server/src/http/routes/memory.ts",
      "apps/server/src/http/routes/chat-tasks.ts",
      "apps/server/src/testing/api-samples.ts",
      "apps/server/src/http/routes-mounted.test.ts",
      "apps/server/src/http/middleware/session-auth.test.ts",
      "apps/server/src/http/middleware/fresh-auth.test.ts",
      "apps/server/src/security/fresh-auth-routes.test.ts",
      "apps/server/src/security/secret-leaks.test.ts",
      "apps/server/src/security/request-guards.test.ts",
      "apps/web/app/utils/testing/fixtures.ts"
    ],
    "C29": [
      "packages/shared/src/util/definitions.ts",
      "packages/shared/src/util/definitions.test.ts",
      "packages/shared/src/util/arguments.ts",
      "packages/shared/src/util/arguments.test.ts",
      "packages/shared/src/util/tool-names.ts",
      "packages/shared/src/util/tool-names.test.ts",
      "packages/shared/src/util/agent-state.ts",
      "packages/shared/src/util/agent-state.test.ts"
    ],
    "D12": [
      "docs/phases/phase-10-v1-6.md"
    ],
    "D13": [
      "docs/UI.md",
      "docs/ARCHITECTURE.md",
      "docs/PLUGINS.md",
      "docs/PROVIDERS.md",
      "docs/guides/**",
      "README.md",
      ".env.example"
    ],
    "C28-compile-fixes": [],
    "coordinator-fixes": [
      "examples/plugins/*/harness-forge.d.ts"
    ]
  },
  "allow": [
    ".tmp/**"
  ]
}
```

### Wave P10-0a cross-agent contracts

| Producer → consumer | Contract |
|---|---|
| coordinator (skeletons) → C28, C29 | the exported names and signatures of `SH/util/{definitions,arguments,tool-names}.ts` and the agent-name ids of `SH/ids.ts` |
| C28 → C29, C30 – C33, every P10-A agent | the DTOs, enums, limits, route keys, events, settings, part schemas, agent tool schemas of `@harness-forge/shared`; the plugin SDK 1.4.0 (`AgentDefinition`, `SkillDefinition`, `ctx.agents` / `ctx.skills`, `contributes.agents` / `.skills`) |
| C29 → C30 – C33, W10.1 – W10.6, W10.8, W10.9, W10.11 | `parseDefinition`, `formatDefinition`, `definitionRank`, `resolvePrecedence`, `normalizeToolList`, `matchToolAllowlist`, `CLAUDE_TOOL_ALIASES`, `splitArguments`, `expandArguments`, `splitTaskResults`, `taskResultText`, `TASK_RESULT_PART_TYPE` (complete) |
| D12 → everyone | this file (owned globs, tasks, acceptance, gates) |
| D13 → C30 – C33, every P10-A agent | UI.md 2.17, 5.5, 7.8, 7.25, 7.27 – 7.30, 9.11, 9.12, 10.7, 11.7, 12, 13.11, 14, 15; ARCHITECTURE.md 5, 6.9, 6.23 – 6.27, 8, 10.11, 12; PLUGINS.md 1.4.0; PROVIDERS.md 8 ("Customization mocks (Phase 10)") |
| K3S → Gate P10-0b, Gate P10-A, the final gate | `.tmp/upgrade-v15` + `.tmp/upgrade-v15-ids.json`, `.tmp/gates/P10-0b/seed-roots` (read-only for probes) |

### Gate P10-0a

1. `node scripts/audit-ownership.mjs .tmp/waves/P10-0a.json`
2. `pnpm install --frozen-lockfile`; `pnpm why yaml` (one 2.9.x copy); `pnpm why typescript` (only 6.0.x).
3. `pnpm check` → `pnpm build`: `apps/server/dist/main.mjs` imports `yaml` as an external (grep); record the web
   `_nuxt` entry chunk size (gzip) against the `.tmp/v15` build of `5481fb3` (more than 40 KB larger → W10.8 loads the
   parser with a dynamic `import()` in the editor only).
4. `HF_TEST_REQUIRE_WEB_BUILD=1 pnpm -F @harness-forge/server exec vitest run src/http/static.test.ts`.
5. `mv .tmp/e2e .tmp/e2e-old-p10-0a` → `pnpm start:e2e` → `curl -sf http://127.0.0.1:8899/api/health` shows
   `"pluginApiVersion":"1.4.0"`; the nine new routes are mounted (run with `bash -c`: zsh does not word-split `$r`):
   ```sh
   b=http://127.0.0.1:8899/api; c=01920000-0000-7000-8000-000000000000
   u=cus_AAAAAAAAAAAAAAAA; t=bgt_AAAAAAAAAAAAAAAA
   for r in "GET /customizations" "GET /customizations/source?kind=agent&name=explore&source=builtin" \
            "POST /customizations" "GET /customizations/$u" "PATCH /customizations/$u" "DELETE /customizations/$u" \
            "POST /memory" "GET /chat/$c/tasks" "POST /chat/$c/tasks/$t/stop"; do
     set -- $r; curl -s -o /dev/null -w "%{http_code} $1 $2\n" -X "$1" "$b$2"
   done   # 501, or 400 where validation runs before the stub (routes-mounted.test.ts covers the full matrix)
   ```
6. `pnpm test:e2e` → 128 passed (`chromium` + `mobile` + `tablet`).
7. `pnpm audit --prod --audit-level high` clean (the two ignored advisories excepted).
8. The coordinator fixes (`examples/plugins/*/harness-forge.d.ts` regenerated for 1.4.0) → ROADMAP + wave log → commit
   `feat: add phase 10 contracts and docs`.

---

## Wave P10-0b — schema, migration `0007`, skeletons, FREEZE

**Entry:** Gate P10-0a green and the v1.5 seed in `.tmp/upgrade-v15`. The coordinator lands K3 first; C30, C31, C32 and
C33 start in one launch once the migration exists (C30's upgrade test needs it).

### Coordinator actions

- **K3 Schema and migration `0007`** —
  1. `S/db/schema.ts`: table `customizations` (`id` text primary key, `kind`, `name`, `description`, `content` text not
     null, `enabled` integer boolean default true, `created_at`, `updated_at` integer not null; unique index
     `customizations_kind_name_uq` on (`kind`, `name`)); table `background_tasks` (`id` text primary key, `chat_id`
     text not null with a foreign key to `chats.id` ON DELETE CASCADE, `message_id`, `tool_call_id`, `type`,
     `description`, `status`, `origin`, `output` (JSON text) not null, `created_at` not null, `finished_at`,
     `delivered_at`, `delivered_message_id` nullable; indexes `background_tasks_chat_idx` (`chat_id`, `created_at`) and
     `background_tasks_pending_idx` (`delivered_at`, `status`)); `TABLE_NAMES` 20; `UsagePurpose` unchanged.
  2. `pnpm db:generate --name customizations` → `apps/server/drizzle/0007_customizations.sql` + snapshot. Expected:
     ```sql
     CREATE TABLE `customizations` (`id` text PRIMARY KEY NOT NULL, `kind` text NOT NULL, `name` text NOT NULL,
       `description` text NOT NULL, `content` text NOT NULL, `enabled` integer DEFAULT true NOT NULL,
       `created_at` integer NOT NULL, `updated_at` integer NOT NULL);
     CREATE UNIQUE INDEX `customizations_kind_name_uq` ON `customizations` (`kind`,`name`);
     CREATE TABLE `background_tasks` (`id` text PRIMARY KEY NOT NULL, `chat_id` text NOT NULL, `message_id` text NOT NULL,
       `tool_call_id` text NOT NULL, `type` text NOT NULL, `description` text NOT NULL, `status` text NOT NULL,
       `origin` text NOT NULL, `output` text NOT NULL, `created_at` integer NOT NULL, `finished_at` integer,
       `delivered_at` integer, `delivered_message_id` text,
       FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade);
     CREATE INDEX `background_tasks_chat_idx` ON `background_tasks` (`chat_id`,`created_at`);
     CREATE INDEX `background_tasks_pending_idx` ON `background_tasks` (`delivered_at`,`status`);
     ```
  3. Inspect the SQL: exactly 2 `CREATE TABLE` and 3 `CREATE [UNIQUE] INDEX`. **Reject** any `DROP`, `__new_`, `PRAGMA`,
     `ALTER TABLE`, `DELETE` or `UPDATE` (foreign keys are on; a rebuild of a table would cascade inside the migration
     transaction). A second `pnpm db:generate` reports no changes.
- **After C30, C31, C32, C33** — `nuxi prepare`; the gate below; the FREEZE additions.
- Ownership file `.tmp/waves/P10-0b.json` (below).

### C30 server skeleton (k3)

- **Mission.** Freeze the server side of Phase 10 outside the chat pipeline: the additive interfaces, the catalog and
  background service types with stubs whose signatures are final, the registry kinds, the `ChatRunner` task members, the
  start / stop order and the boot sweep hook, the column classification, fakes and the database tests of `0007`.
- **Owned.** `S/types.ts`, `S/deps*.ts`, `S/env*.ts`, `S/main.ts`, `S/db/**` (not `schema.ts`), `S/chat/types.ts`,
  `S/chat/background/**` (types + stub, open point 2), `S/registry/{types,index,agents,skills}*`,
  `S/services/customizations/**`, `S/services/data/references{,.test}.ts`, `S/testing/**` (not `api-samples.ts`).
- **Read-only highlights.** `.tmp/p10-designs/plan.md` 1, 5, 8, `server.md` 2A, 2E, 4; ARCHITECTURE.md 5, 6.23, 6.26, 8;
  API.md (C28's customizations and background-task schemas); `SH/schemas/{customizations,background-tasks}.ts`,
  `SH/util/definitions.ts`; `apps/server/drizzle/0007_*.sql`; `S/services/project-files/{types,index}.ts` and
  `S/testing/fake-project-files.ts` (the Phase 9 stub precedent); `S/registry/{index,types}.ts`.
- **Tasks.**
  1. **C30-T1 Types (additive)** — `S/types.ts`: `AppServices.customizations: CustomizationService`;
     `S/chat/types.ts`: the `ChatRunner` task members (proposed: `taskList(chatId): Promise<BackgroundTask[]>`,
     `stopTask(chatId, taskId): Promise<BackgroundTask | null>`, `stopTasks(chatId): Promise<number>`,
     `hasTasks(chatId): boolean`, `start(): Promise<void>` (the boot sweep)), `stopAll()` documented as "clears every
     queue, aborts every background task (awaited ≤ 5 s, rows saved), then aborts every run"; `S/registry/types.ts`:
     kinds `agent` / `skill`, `Registry.agents` / `Registry.skills` (list, get, owner, `onChange`; registration through
     the plugin context), contributions `agents` / `skills`. C30 fixes the exact names and lists them in its report.
     *Accept:* `pnpm typecheck` green.
  2. **C30-T2 `S/services/customizations/types.ts` (frozen after the gate)** — `CustomizationService` (proposed:
     `catalog(projectId | null, options?: { refresh?, signal? }): Promise<CustomizationCatalog>`, `list(query)` (the
     route answer), `source(query): Promise<{ content, path? }>`, `load(entry, signal?)` (the parsed definition with its
     body, re-read and re-validated), `get(id)`, `create(body)`, `update(id, body)`, `remove(id)`, `invalidate(projectId |
     null)`, `stop()`); `CustomizationCatalog` (the run snapshot: `entries`, `agents()`, `commands()`, `skills()`,
     `agent(name)` (aliases resolved), `command(name)`, `skill(name)`, `diagnostics`, `project`); the stub
     `createCustomizationService(deps)` with the final signature: a builtins-only catalog (`explore`, `general` from
     C32's definitions), the user members and `source` throw `not_implemented`, `load` of a builtin works,
     `invalidate` / `stop` no-ops. *Accept:* `deps.test.ts` "phase 10 skeleton".
  3. **C30-T3 `S/chat/background/types.ts` + stub** — `BackgroundTasks` (proposed: `launch(input):
     Promise<TaskOutput>` (the immediate `{ status: 'background', taskId }` or a `failed` output), `takeResults(chatId):
     TaskResultData[]` (synchronous), `onChatIdle(chatId): void`, `list(chatId)`, `stop(chatId, taskId)`,
     `stopChat(chatId)`, `hasRunning(chatId)`, `start()` (boot sweep), `stopAll()`); the launch input `{ chatId,
     messageId, toolCallId, task, origin, model, toolMode, workspace, scope, settings, reasoningEffort, chatInstructions,
     catalog, logger }`; the stub `createBackgroundTasks(deps)` with the final signature: `launch` → `failed` "Background
     agents are not available yet.", reads answer empty, stops answer null / 0. *Accept:* a smoke test per member.
  4. **C30-T4 Registries** — empty `agents` / `skills` registries wired into the registry (list empty, `onChange`
     subscribable, contributions `agents: []`, `skills: []`); W10.7 implements registration and validation. *Accept:*
     registry tests green.
  5. **C30-T5 Deps and boot** — the factory `createCustomizationService`; `SHUTDOWN_STEPS` = data, runs (`stopAll`:
     queues → background tasks → runs), customizations, projectFiles, checkpoints, plugins, mcp, catalog, events;
     `startDeps`: `runs.start()` after `checkpoints.start()` (the boot sweep hook; a no-op until W10.4); `S/main.ts`
     calls it once at boot. *Accept:* `deps.test.ts` checks both orders (a failing step still lets the next run).
  6. **C30-T6 Environment** — no new variable; `S/env*` only for compile fixes (reported).
  7. **C30-T7 Column classification** — `customizations.content` and `.description` in `REFERENCE_SOURCES` (scanned
     like `projects.instructions`); every other column of both tables in `UNSCANNED_COLUMNS`. *Accept:*
     `references.test.ts` (every column of every table classified).
  8. **C30-T8 Fakes** — `S/testing/fake-customizations.ts` (an in-memory catalog per project with entries, bodies and
     diagnostics set by the test, user CRUD in memory, call counters), a fake `BackgroundTasks` (scripted launches and
     results), `createTestApp({ customizations?, backgroundTasks? })`. *Accept:* `fakes.test.ts`.
  9. **C30-T9 Database tests** — `db.test.ts`: 20 tables, the migration tags `0000` … `0007`, the three indexes;
     `upgrade.test.ts`: a temporary folder holding only `0000` … `0006` with chats, messages and a project, then the real
     folder: both tables exist and are empty, every chat, message and project survives, a second (kind, name) insert
     fails with a unique violation, deleting a chat cascades to its `background_tasks` rows. *Accept:* green.
- **Tests.** The tasks above.
- **Verify.** Server commands.

### C31 chat seams (k5)

- **Mission.** Land every seam of the chat pipeline that the five server chat agents share, so each P10-A agent owns
  its hot file alone: `pipeline.ts`, `tools.ts`, `model-history.ts`, `agent-scope.ts` and `subagent/host.ts`
  **complete**; every other new module as a stub with its final signature, wired at its call site with unchanged
  behavior.
- **Owned.** `S/chat/**` (not `types.ts`, `background/**`), `S/http/routes/commands{,.test}.ts`.
- **Read-only highlights.** `.tmp/p10-designs/plan.md` 2 – 6, `server.md` 2B – 2F (insertion points with line numbers);
  `explore-{subagents,commands}.md`; `SH/util/{agent-state,tool-names,arguments}.ts` (C29), `SH/schemas/agent.ts`,
  `SH/chat.ts`; `S/chat/background/types.ts`, `S/services/customizations/types.ts` (C30); the AI SDK `.d.ts`.
- **Tasks.**
  1. **C31-T1 `pipeline.ts` (complete)** — `RunContext.background` and `RunContext.origin` (`request | queue | task`);
     `PreparedRun.{catalog, requestModelRef, turnRestriction}` consumed; the pipeline touches (`pipeline.ts:943`,
     `:589-592`) write `requestModelRef`, so a command's model never becomes the chat's model (`run.started.modelRef`
     stays the model that ran); injected task results tracked like steers (`RunSession.#missingSteers`, `:507-517`,
     also appends a missing `data-task-result`); the catalog passed to the sub-agent runner, to `buildRunParams`
     (`agentTypes`, `skills`) and to `assembleTools`; `loadSkill` / `savePlan` bound into the agent scope from the
     `skills.ts` / `plan-file.ts` stubs. *Accept:* `pipeline.test.ts` green unchanged; new tests: a touch keeps the chat
     model when `requestModelRef` differs from the run model; an injected task result missing from the response is
     appended once.
  2. **C31-T2 `tools.ts` (complete)** — `assembleTools({ …, allowedTools, skillsAvailable })`: `allowedTools` applied
     after `applyToolMode` (`tools.ts:631`) through `matchToolAllowlist` (narrows only; `exit_plan_mode` kept in plan
     mode; an empty list leaves no tools), `skill` dropped when the catalog has no skills and in children. *Accept:*
     `tools.test.ts` (narrowing per mode, `exit_plan_mode` in plan mode, `skill` absent without skills, nothing ever
     added).
  3. **C31-T3 `model-history.ts`** — the `splitTaskResults` stage after `splitSteers` (compaction → steer split →
     task-result split → task output reduction → command expansions). *Accept:* `model-history.test.ts` (the order; a
     v1.5 history unchanged; a carrier message becomes a user text).
  4. **C31-T4 `agent-scope.ts`** — `AgentRunScope` gains `loadSkill(name, signal)` and `savePlan(plan, c)`; still never
     bound inside children. *Accept:* unbound → null; nothing reachable through the plugin context.
  5. **C31-T5 `subagent/host.ts` (complete)** — the structural `ChildSession` (what a child needs from its host: ids,
     `inject`-free usage and cost hooks, the logger, the run scope copy), replacing `RunSession` in the signatures of
     `subagent/{index,tools}.ts` and `compaction/{guard,summarize}.ts`; behavior unchanged. *Accept:* every sub-agent
     and compaction test green unchanged.
  6. **C31-T6 Stubs with final signatures** — `prepareRun(…, { serverMessage })` (the option accepted, not yet used);
     `resolveCommand(services, text, { chatId, signal, catalog })` (file commands not yet resolved);
     `isServerCommandFor(deps, projectId, text)` (today's `isServerCommand` behavior), called by `queue.ts`;
     `turnToolRestriction(history)` (null); `RunParamsInput.{agentTypes, skills}` (ignored); `runDetachedChild(…)`
     (throws `not_implemented`); `S/chat/skills.ts` (`loadSkill` → a `not_found` error); `S/chat/plan-file.ts`
     (`savePlan` → no file); `S/chat/index.ts`: the C30 background stub created inside the `ChatRunner`, `taskList` /
     `stopTask` / `stopTasks` / `hasTasks` delegating to it (open point 3), `stopAll` in the documented order,
     `onRunReleased` calling `background.onChatIdle` when no queued item starts. *Accept:* typecheck; one smoke test per
     stub; `task { background: true }` yields one `failed` output "Background agents are not available yet."
  7. **C31-T7 `GET /commands`** — items carry `source` (`harness` for `/compact`, `plugin` + `pluginId` for plugin
     commands); `?projectId=` accepted (the project listing is W10.2's). *Accept:* commands route tests.
- **Tests.** The tasks above; every existing chat test stays green.
- **Verify.** Server commands.

### C32 core-agent and mock models (k6)

- **Mission.** The `core-agent` manifest for API 1.4.0 with the final `task` and `skill` definitions (schemas,
  descriptions, policies, model texts; execute stubs), the builtin agent definitions, the reserved command name
  `remember`, and the two mock models **complete** (frozen after the gate; they drive every probe and e2e spec).
- **Owned.** `S/builtin-plugins/index{,.test}.ts`, `S/builtin-plugins/core-agent/**`, `S/builtin-plugins/mock/**`,
  `S/registry/validate*`, `S/plugins/templates/names*`.
- **Read-only highlights.** `.tmp/p10-designs/plan.md` 2, 4, 9, `server.md` 5; PROVIDERS.md 8 ("Customization mocks
  (Phase 10)") (D13 writes it from this section); `SH/schemas/agent.ts`; `S/chat/markers.ts`
  (`SUBAGENT_INSTRUCTIONS_MARKER`); `S/builtin-plugins/mock/{models,turn,subagent,steer}.ts` (`MockPlan`,
  `toolCalls`, `stepDelayMs`, `turnOf`, `systemText`, `offeredToolNames`, `textStep`, `callStep`).
- **Tasks.**
  1. **C32-T1 `core-agent` (frozen manifest)** — `engines ^1.4.0`; tools in this order: `todo_write`, `exit_plan_mode`
     (the model text gains "The plan was saved to <path>." when `planPath` is set, or one line naming `planError`),
     `task` (input from `SH/schemas/agent.ts`: `type` a name, `background?`; the description points at the "Agent
     types" block of the instructions and explains `background: true` — the call returns at once and the result arrives
     later as a message; the model text for `status: background` reads "Started background agent <taskId>. Its report
     will arrive as a message; keep working."), `skill` (new; policy `safe`, no workspace access level, input `{ name }`,
     a description that points at the skills block, the model text = the content plus "Base folder: <baseDir> — read
     supporting files with read_file" when `baseDir` is set; execute stub in `skill.ts` returning a tool error "Skills
     are not available yet."); the builtin agent definitions `explore` and `general` (name, description, read-only flag)
     exported for C30's builtin catalog entries. *Accept:* `core-agent/index.test.ts` (names, order, policies, schemas,
     `engines`, the model texts); `builtin-plugins/index.test.ts` count pin.
  2. **C32-T2 Reserved command** — `S/registry/validate.ts` refuses a plugin command named `remember` (through
     `CLIENT_COMMANDS`); `S/plugins/templates/names.ts` treats it as taken. *Accept:* validate and names tests.
  3. **C32-T3 `mock:agents` (complete; `{ tools: true }`)** —
     - child (system text contains `SUBAGENT_INSTRUCTIONS_MARKER`): `list_directory` once if offered, then `Report:
       persona=<the value after "PERSONA:" in the system text, or none> | tools: <offered tool names, sorted> |
       model=<own model id>`;
     - parent, by the last user text: `agent <type> [write]` → one `task { type, description: 'Run <type>', prompt }`
       (`write` copied into the prompt) → `Agent report: <report>`; `agents?` → `Agent types: <the names listed in the
       instructions' agent types block>`; `skills?` → `Skills: <the names in the skills block>`; `skill <name>` → one
       `skill { name }` → `Skill loaded: <the first 80 characters of the content>` (or `Skills are not available.` when
       `skill` is not offered); `tools?` → `Tools: <offered tool names, sorted>`; anything else → `Agents mock: <user
       text>` (the user text is the command expansion, so commands are visible).
  4. **C32-T4 `mock:background` (complete; `{ tools: true }`)** —
     - child: `current_time` steps of 500 ms (`slow K` in the prompt → K steps, default 2; `loop` → until the step limit),
       then `Report: background done`;
     - parent: `bg [type] [steps N]` → `task { type: type ?? 'explore', description: 'Background <type>', prompt,
       background: true }`; without `steps` → `Started in background: <taskId>`; with `steps N` → N `current_time` steps
       of 400 ms that stop once a user message holding `<background-task` follows a tool message → `Finished: in-run
       result <status>` (or `Finished N steps without a result`);
     - a turn whose last user message holds `<background-task` → `Background result: <status> | <first report line>`.
     The existing `mock:plan` and `mock:echo` cover plan files, commands and Remember. *Accept:* `mock/index.test.ts` /
     `models.test.ts`: a plan per branch of both models (child persona / no persona, `write`, `agents?`, `skills?`,
     `skill` offered / not offered, `tools?`, the fallback; background launch, `steps N` with and without an in-run
     result, the carrier turn, `slow`, `loop`) and the listing.
  5. **C32-T5 Count pins** — the mock listing (two more models; the visible count and `modelCount`), `MOCK_MODEL_IDS`,
     the builtin plugin tool count, `AGENT_TOOL_NAMES` consumers, the template names test; listed in the report.
- **Tests.** The tasks above.
- **Verify.** Server commands.

### C33 web skeleton (k4)

- **Mission.** Freeze the web side of Phase 10: every new test id, the Customize route and nav entry, the stub
  components with their final props, emits, exposes and root test ids, the two stores and the pure modules (inert), the
  mounts and emit chains through the hot files, and the `useChatSession` interface additions.
- **Owned.** `W/utils/testids.ts`, `W/utils/testing/**`, `W/pages/settings/customize.vue`,
  `W/components/app-shell/navigation*`, `W/components/settings/customize/**`, `W/components/common/MarkdownEditor*`,
  `W/components/chat/composer/**`, `W/components/chat/background/**`, `W/components/chat/agent/**`,
  `W/components/chat/parts/ToolPart*`, `W/components/chat/{ChatView,ChatTranscript,ChatMessage,UserMessageBubble,
  MessageActions,chat-format,chat-context}*`, `W/components/plugins/detail/{PluginContributions,PluginCustomizationList}*`,
  `W/components/settings/projects/ProjectsSettings*`, `W/stores/{customizations,background-tasks,plugins}*`,
  `W/composables/{useChatSession,useServerEvents}*`.
- **Read-only highlights.** UI.md 2.17, 5.5, 7.8, 7.25, 7.27 – 7.30, 9.11, 9.12, 10.7, 11.7, 12, 13.11, 14, 15;
  `.tmp/p10-designs/web.md` 1 – 7 (with the reconciliation); `SH/schemas/{customizations,background-tasks,agent}.ts`,
  `SH/chat.ts`, `SH/util/{definitions,agent-state}.ts`.
- **Tasks.**
  1. **C33-T1 Test ids** — the 56 ids of UI.md 13.11 in `utils/testids.ts` (key = the camelCase of the id) under a `//
     Agent customization: Customize, commands, skills, background agents, Remember (Phase 10)` comment:
     `settings-nav-customize`, `customize-settings`, `customize-tab`, `customize-project-select`, `customize-new`,
     `customize-import`, `customize-import-input`, `customize-section`, `customize-empty`, `customization-row`,
     `customization-row-menu`, `customization-edit`, `customization-view`, `customization-duplicate`,
     `customization-export`, `customization-toggle`, `customization-delete`, `customization-delete-confirm`,
     `customization-diagnostics`, `customization-editor`, `customization-name`, `customization-description`,
     `customization-tools-mode`, `customization-tools`, `customization-tool-option`, `customization-tool-chip`,
     `customization-model`, `customization-argument-hint`, `customization-body`, `customization-save`,
     `customization-error`, `customization-import-notes`, `customization-viewer`, `customization-discard-confirm`,
     `slash-argument-hint`, `remember-dialog`, `remember-text`, `remember-target`, `remember-save`, `remember-error`,
     `task-result`, `task-result-toggle`, `task-result-report`, `task-block-reveal`, `plan-file`, `background-agents`,
     `background-agents-toggle`, `background-agents-stop-all`, `background-agent`, `background-agent-toggle`,
     `background-agent-stop`, `settings-plan-files`, `settings-plan-directory`, `plugin-customizations`,
     `plugin-customization`, `project-customizations`. New attribute values (not ids): `task-block[data-kind="custom"]`,
     `task-block[data-agent-type]`, `task-block[data-background]`, `slash-menu-item[data-group]`,
     `tool-row[data-tool-name="skill"]`; slots `skill-body`, `background-agents-announcer`, `task-result-meta`. UI.md
     13.11 wins on any difference (reported).
  2. **C33-T2 Route, navigation, filter** — `pages/settings/customize.vue` (a thin `SettingsPage` around
     `CustomizeSettings`); the `SettingsLink` `customize` ("Customize", `WandSparkles`) after Projects (the command
     palette entry follows automatically); `PLUGIN_FILTERS` + `agents` ("Agents and skills", `Bot`) with its complete
     `pluginMatchesFilter` branch (agents or skills in the contributions; open point 5). *Accept:* `navigation.test.ts`,
     `plugins.test.ts`.
  3. **C33-T3 Stub components** — each renders its root test id and declares exactly (UI.md 10.7 wins where it is more
     precise; report the difference):
     ```ts
     CustomizeSettings       {}                                                       // settings/customize/; reads ?tab, ?project
     CustomizationSection    { source: CustomizationSource; kind: CustomizationKind; entries: readonly CustomizationEntry[];
                               projectName?: string | null; folders?: readonly string[] }
                             // emits action: [CustomizationAction, CustomizationEntry]
     CustomizationRow        { entry: CustomizationEntry }                            // emits action: [CustomizationAction]
     CustomizationEditor     { open: boolean; kind: CustomizationKind; customization: Customization | null;
                               draft?: CustomizationDraft | null; notes?: readonly string[] }
                             // emits update:open: [boolean], saved: [Customization]
     CustomizationViewer     { open: boolean; entry: CustomizationEntry | null; projectId: string | null }
                             // emits update:open: [boolean], copy: [CustomizationDraft]
     ToolMultiSelect         { modelValue: string[] | null; tools: readonly ToolSummary[]; label: string }
                             // emits update:modelValue: [string[] | null]
     MarkdownEditor          { modelValue: string; label: string; readonly?: boolean;
                               diagnostics?: readonly DefinitionDiagnostic[] }      // common/; data-slot="markdown-editor"
                             // emits update:modelValue: [string], submit: []   (Mod+Enter)
     SlashArgumentHint       { text: string; hint: string | null }                    // chat/composer/
     RememberDialog          { open: boolean; text: string; projectId: string | null; chatId: string | null }
                             // emits update:open: [boolean], saved: [RememberResult]
     BackgroundAgents        { tasks: readonly BackgroundTask[]; stopping?: readonly string[];
                               reveal?: { taskId: string; n: number } | null }       // chat/background/
                             // emits stop: [taskId: string], stop-all: []
     BackgroundAgentRow      { task: BackgroundTask; stopping: boolean }              // emits stop: []
     TaskResultNote          { result: TaskResultData; variant: 'inline' | 'turn' }   // chat/agent/; store-free
     SkillToolBody           { input: unknown; output: unknown }                      // chat/agent/; store-free
     PlanFileChip            { planPath: string | null; planError: string | null; projectChat: boolean }
     PluginCustomizationList { kind: 'agent' | 'skill'; entries: readonly CustomizationEntry[]; missing: readonly string[] }
     ```
     `CustomizationAction` = `edit | view | duplicate | export | toggle | delete | open-plugin`; `CustomizationDraft` =
     the editor's structured fields (`kind`, `name`, `description`, `tools`, `model`, `argumentHint`, `body`).
     *Accept:* one stub mount test per component (root test id, props accepted).
  4. **C33-T4 Stores and pure modules (inert, typed)** — `useCustomizationsStore` (`W/stores/customizations.ts`): state
     per project key (`projectId ?? ''`) with `loadedAt` and a stale flag; getters `catalog(projectId)`,
     `personal(kind)` (the `source: user` entries of `catalog(null)`), `slashCommands(projectId)`; actions
     `fetchCatalog(projectId, { maxAgeMs?, refresh? })`, `fetchCommands(projectId, { maxAgeMs? })`, `sourceOf(entry,
     projectId): Promise<string>`, `get(id)`, `create(body)`, `update(id, body)`, `remove(id)`, `applyEvent(event)`
     (`customization.changed`, `plugin.changed` → stale), `refreshLoaded()`. `useBackgroundTasksStore`
     (`W/stores/background-tasks.ts`): state per chat; getters `tasks(chatId)`, `visible(chatId)` (running, or finished
     with `deliveredAt` null), `byId(chatId, taskId)`; actions `fetch(chatId)`, `stop(chatId, taskId): Promise<'stopped'
     | 'gone'>`, `stopAll(chatId): Promise<number>` (loops `stop`), `applyEvent(event)` (`task.changed` upsert,
     `chat.deleted` drop), `refreshLoaded()`. Pure modules with final signatures: `settings/customize/customize.ts`
     (`sectionsOf`, `stateBadge`, `rowMeta`, `draftFromUser`, `draftFromEntry`, `importDraft(file, kind)` over
     `parseDefinition`, `EDITOR_COPY`), `chat/composer/remember.ts` (`REMEMBER_TARGETS`, `defaultTarget`,
     `rememberToast`, `rememberErrorText`), `chat/background/background-agents.ts` (`visibleTasks`, `summaryLine`,
     `announcementFor(previous, next)`); `chat-format.ts`: the block kind `task-result`, `taskResultsOf(messages):
     Map<string, TaskResultData>` and `isTaskResultMessage(message)` **complete**; `chat-context.ts`:
     `AGENT_TASK_CONTEXT: InjectionKey<{ projectId(): string | null; task(id): BackgroundTask | null; tasksLoaded():
     boolean; result(id): TaskResultData | null; reveal(id): void; showResult(id): boolean }>`. UI.md 11.7 wins on any
     difference. *Accept:* store shape tests; `chat-format.test.ts` for the two helpers; the modules type-check.
  5. **C33-T5 Mounts and chains** — `ChatView`: `BackgroundAgents` in the dock between `TodoStrip` and
     `QueuedMessages`, `provide(AGENT_TASK_CONTEXT)`; `useServerEvents`: `task.changed` and `chat.deleted` to the
     background-tasks store, `customization.changed` and `plugin.changed` to the customizations store, `refreshLoaded()`
     of both on reconnect; `ChatMessage` / `UserMessageBubble`: the `task-result` branch and the carrier branch
     (`isTaskResultMessage`); `MessageActions` hidden for carriers; `ChatComposer`: `slashCommands(projectId)` instead of
     `plugins.commands` (`ChatComposer.vue:224-227`), the `SlashArgumentHint` and `RememberDialog` mounts, the
     `remember` client action; `slash-commands.ts`: `SlashItem.group` (`app | project | personal | plugin`),
     `argumentHint?`, `namespace?`, `CLIENT_COMMAND_DESCRIPTIONS.remember` ("Save a note to your instructions"),
     `ClientCommandAction` `remember`; `ToolPart`: the `skill` branch (`SkillToolBody`) and the `PlanFileChip` slot of
     the `exit_plan_mode` row; `TaskBlock`: accepts any type string (custom types render the generic label for now);
     `PluginContributions`: the Agents and Skills sections (`PluginCustomizationList`); `ProjectsSettings`: the row menu
     item "Agents, commands and skills…" (`project-customizations`, → `/settings/customize?project=<id>`). *Accept:* the
     existing `ChatView`, `ChatTranscript`, `ChatMessage`, `ToolPart`, `TaskBlock`, `ChatComposer`, `SlashMenu`,
     `useServerEvents`, `PluginDetailView`, `ProjectsSettings` tests stay green; mount tests for the dock, the carrier
     branch and the composer mounts.
  6. **C33-T6 `useChatSession` interface** — `load()` also calls `backgroundTasks.fetch(chatId)`; `run.started` with
     `origin: 'task'` joins the queue path (`refresh()` + `resumeStream()` when the `userMessageId` is not on the shown
     path; deferred until idle); the session exposes `backgroundTasks: ComputedRef<readonly BackgroundTask[]>` and
     `stopBackgroundTask(taskId): Promise<'stopped' | 'gone'>` (declared; delegating to the store). *Accept:* session
     tests green.
- **Tests.** The tasks above.
- **Verify.** Web commands (`typecheck:fast` needs the coordinator's `.nuxt`; import new components by path).

### Wave P10-0b ownership

The audit cannot express "except": `S/db/schema.ts` matches C30's glob but is the coordinator's K3 edit;
`S/chat/types.ts` and `S/chat/background/**` match C31's glob but are C30's; `S/registry/validate*` belongs to C32;
`S/testing/api-samples.ts` stays C28's file from P10-0a (untouched in P10-0b). C30, C31 and C32 list the count pins and
fixtures outside their globs in their reports (`*-test-fixes`).

```json
{
  "wave": "P10-0b",
  "agents": {
    "K3": [
      "apps/server/src/db/schema.ts",
      "apps/server/drizzle/**"
    ],
    "C30": [
      "apps/server/src/types.ts",
      "apps/server/src/deps*.ts",
      "apps/server/src/env*.ts",
      "apps/server/src/main.ts",
      "apps/server/src/db/**",
      "apps/server/src/chat/types.ts",
      "apps/server/src/chat/background/**",
      "apps/server/src/registry/{types,index,agents,skills}*",
      "apps/server/src/services/customizations/**",
      "apps/server/src/services/data/references.ts",
      "apps/server/src/services/data/references.test.ts",
      "apps/server/src/testing/**"
    ],
    "C31": [
      "apps/server/src/chat/**",
      "apps/server/src/http/routes/commands.ts",
      "apps/server/src/http/routes/commands.test.ts"
    ],
    "C32": [
      "apps/server/src/builtin-plugins/index.ts",
      "apps/server/src/builtin-plugins/index.test.ts",
      "apps/server/src/builtin-plugins/core-agent/**",
      "apps/server/src/builtin-plugins/mock/**",
      "apps/server/src/registry/validate*",
      "apps/server/src/plugins/templates/names*"
    ],
    "C33": [
      "apps/web/app/utils/testids.ts",
      "apps/web/app/utils/testing/**",
      "apps/web/app/pages/settings/customize.vue",
      "apps/web/app/components/app-shell/navigation*",
      "apps/web/app/components/settings/customize/**",
      "apps/web/app/components/common/MarkdownEditor*",
      "apps/web/app/components/chat/composer/**",
      "apps/web/app/components/chat/background/**",
      "apps/web/app/components/chat/agent/**",
      "apps/web/app/components/chat/parts/ToolPart*",
      "apps/web/app/components/chat/{ChatView,ChatTranscript,ChatMessage,UserMessageBubble,MessageActions,chat-format,chat-context}*",
      "apps/web/app/components/plugins/detail/{PluginContributions,PluginCustomizationList}*",
      "apps/web/app/components/settings/projects/ProjectsSettings*",
      "apps/web/app/stores/{customizations,background-tasks,plugins}*",
      "apps/web/app/composables/{useChatSession,useServerEvents}*"
    ]
  },
  "allow": [
    "docs/ROADMAP.md",
    "docs/DECISIONS.md",
    "AGENT.md",
    "docs/phases/phase-10-v1-6.md",
    ".tmp/**"
  ]
}
```

### Wave P10-0b cross-agent contracts

| Producer → consumer | Contract |
|---|---|
| K3 → C30, W10.1, W10.4 | `0007`: `customizations` (unique (kind, name) → the 409 `exists` W10.1 maps), `background_tasks` (cascade from `chats`, the two indexes) |
| C30 → C31, W10.1 – W10.7 | `CustomizationService` + `CustomizationCatalog` + the stub; `BackgroundTasks` + the stub; the `ChatRunner` task members and `stopAll` order; the registry kinds; `createTestApp({ customizations?, backgroundTasks? })` and the fakes; the start / stop order and the boot hook |
| C31 → W10.2 – W10.6 | `pipeline.ts` / `tools.ts` / `model-history.ts` / `agent-scope.ts` (complete), `ChildSession`, the stub signatures (`prepareRun(…, { serverMessage })`, `resolveCommand(…, { catalog })`, `isServerCommandFor`, `turnToolRestriction`, `RunParamsInput.{agentTypes, skills}`, `runDetachedChild`, `loadSkill`, `savePlan`) |
| C32 → W10.3, W10.5 | the `core-agent` manifest, the `task` / `skill` / `exit_plan_mode` schemas, descriptions, policies and model texts (frozen); the execute files they implement; the builtin agent definitions (→ W10.1) |
| C32 → W10.13 and the gates | the two mock models (PROVIDERS.md 8 ("Customization mocks (Phase 10)")) |
| C33 → W10.8 – W10.12 | the stub components, the two stores, the pure modules, `AGENT_TASK_CONTEXT`, `taskResultsOf` / `isTaskResultMessage`, the emit chains and props, the `useChatSession` additions (frozen) |
| C33 → everyone | `utils/testids.ts` (frozen after the gate) |

### Gate P10-0b

1. `node scripts/audit-ownership.mjs .tmp/waves/P10-0b.json`
2. `nuxi prepare` → `pnpm check` → `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
3. `mv .tmp/e2e .tmp/e2e-old-p10-0b` (a cached mock listing hides the new mock models; `mv`, not `rm -rf`) →
   `pnpm start:e2e` → `pnpm test:e2e` (128 still green).
4. **Upgrade probe** on a fresh copy of the K3 seed (never on `.tmp/e2e`, never on the seed itself):
   ```sh
   d=.tmp/gates/P10-0b/upgrade-$(date +%s); cp -R .tmp/upgrade-v15 "$d"
   HF_MOCK_PROVIDER=1 HF_OFFLINE=1 HF_PORT=8898 HF_DATA_DIR="$d" \
     HF_WORKSPACE_ROOTS=$PWD/.tmp/gates/P10-0b/seed-roots node apps/server/dist/main.mjs &
   # through node + @libsql/client (or the sqlite3 CLI), ids from .tmp/upgrade-v15-ids.json:
   #   SELECT count(*) FROM __drizzle_migrations;                                   -> 8
   #   SELECT count(*) FROM customizations; SELECT count(*) FROM background_tasks; -> 0, 0
   #   SELECT name FROM sqlite_master WHERE type = 'index'
   #     AND tbl_name IN ('customizations', 'background_tasks');                    -> the three indexes
   #   PRAGMA foreign_key_check; PRAGMA integrity_check;                            -> no rows; ok
   #   SELECT count(*) FROM messages; SELECT count(*) FROM workspace_changes;     -> the seeded counts
   ```
   Then, logged in with the seeded password: every seeded chat opens (`GET /chats/<id>`; the old `tool-task` parts are
   byte-identical to the seed's), the share link opens (`GET /share/<token>` 200), the shell approval and the plan
   approval are still pending, `GET /plugins` lists `core-agent` active and `GET /tools` lists `skill`, `GET /settings`
   has `planFiles: false`, `planDirectory: '.harness/plans'`, the seeded `instructions` and `subagentMaxSteps: 12`,
   `GET /customizations?projectId=<p>` answers the builtins-only stub catalog (or 501), `GET /chat/<id>/tasks` → `{
   items: [] }` (or 501). The probe only reads the seed roots. Stop the probe server afterwards.
5. **Seam no-op probe** (`pnpm start:e2e`, or the 8898 server on a copy of the roots with `projects.path` repointed by
   SQL): `mock:subagent` in `ask` still runs `explore` + `general` (now catalog builtins) without approvals; `mock:background`
   `bg` → one `failed` `task` output "Background agents are not available yet."; `/compact` works; `GET /commands`
   lists `compact` with `source: 'harness'`; `mock:workspace` in `auto` writes `mock-workspace.txt` and journals it;
   approving `mock:plan` in `edits` writes `notes.txt` and no plan file; `GET /models` lists `mock:agents` and
   `mock:background`.
6. FREEZE additions (see "FREEZE in Phase 10") → ROADMAP + wave log → commit
   `feat: add phase 10 schema, migration and skeletons`.

---

## Wave P10-A — features

Twelve agents in one launch against the P10-0b checkpoint. Only server agents get slots (k1 – k7); web agents run no
server.

### Coordinator actions

- Before the launch: the ownership file `.tmp/waves/P10-A.json` (below), agent prompts with a "what exists now"
  section, their section of this file and "Rules for every Phase 10 agent".
- **At the gate**: audit; batch the CCRs; `nuxi prepare`; the gate commands and probes below; the screenshot review;
  `pnpm audit`; red items become W10.15 (server) / W10.16 (web) tasks with their globs; the reports are digested into
  `.tmp/waves/P10-A-notes.md` for W10.14. **First cuts if the wave overflows** (in this order): in-run delivery of
  background results (idle and next-run delivery only), code-plugin `ctx.agents.register` / `ctx.skills.register` (keep
  the declarative `contributes`), skill supporting files, the import / export UI (keep the export of the stored
  `content`), `$1` … `$9`, viewer lint markers, Undo after delete, the argument-hint ghost (the hint in the menu only),
  Stop all.

### Wave rules

- Import new components explicitly by path; no `nuxt prepare` mid-wave.
- A new test id, a contract change or a frozen-file edit is a CCR in the report (with a local adapter).
- No doc edits ("For W10.14" notes in the report instead).
- Hot files have exactly one owner (table below): `prepare.ts`, `commands.ts`, `context.ts`, `notices.ts` → W10.2;
  `params.ts`, `subagent/**` (not `host.ts`) → W10.3; `steer.ts`, `queue.ts`, `index.ts`, `background/**` (not
  `types.ts`) and the chat / chats / chat-tasks routes → W10.4; `skills.ts`, `plan-file.ts` → W10.5; `ChatComposer.vue`,
  `SlashMenu.vue` → W10.9; `useChatSession.ts`, `useServerEvents.ts`, `ChatView.vue` → W10.10; `ToolPart.vue`,
  `TaskBlock.vue`, `ChatMessage.vue`, `ChatTranscript.vue`, `chat-format.ts` → W10.11. `pipeline.ts`, `tools.ts`,
  `steps.ts`, `markers.ts`, `model-history.ts` and `agent-scope.ts` are frozen.
- Server agents implement behind the C30 / C31 seams and test against them with `MockLanguageModelV4` and the C30
  fakes; where a feature needs another agent's piece (W10.2 – W10.5 need W10.1's catalog, W10.3 ↔ W10.4 the
  `BackgroundTasks` API, W10.8 / W10.9 the routes), test against the frozen signature with a fake; the real round trips
  are probed at the gate.
- The mock models are frozen: a test that needs another script uses `MockLanguageModelV4` directly.

### W10.1 customizations-server (k1)

- **Mission.** The catalog: discovery of the project folders, parsing and checks, the user store, the merge with
  precedence and diagnostics, the cache and its invalidation, `load`, the routes and `customization.changed`.
- **Owned.** `S/services/customizations/**` (not `types.ts`, `memory*`), `S/http/routes/customizations{,.test}.ts`,
  `S/testing/fake-customizations*`.
- **Read-only highlights.** ADR-044, ADR-045; `.tmp/p10-designs/plan.md` 1, `server.md` 2A; API.md (customizations
  schemas and module); ARCHITECTURE.md 6.23; `SH/util/{definitions,tool-names}.ts`, `SH/schemas/customizations.ts`;
  `S/services/customizations/types.ts` (frozen); `S/workspace/{paths,sensitive}.ts` (`resolveWorkspacePath`,
  `openWorkspaceFile`); `S/services/projects/project-file.ts` (`readCapped`, the NUL probe); `S/registry/types.ts`
  (`agents`, `skills`, `onChange`); `S/builtin-plugins/core-agent/index.ts` (the builtin agent definitions).
- **Tasks.**
  1. **W10.1-T1 Discovery (`discover.ts`)** — for F in `.claude/{kind}`, `.harness/{kind}`: `resolveWorkspacePath(root,
     F)`; F must exist, be a directory and have `resolved.rel === F` (equality proves no link sits on the path; else a
     `link` diagnostic); `opendir` with dirents, only `dirent.isFile()` entries (links skipped with `link`), no hidden
     names, extension `.md`; agents at the top level, commands `**/*.md` up to 3 folders deep (the folder path is the
     display-only `namespace`, the name is the file stem), skills `<dir>/SKILL.md` (the folder name is the fallback
     name); each file through `openWorkspaceFile` (O_NOFOLLOW) + `fstat` ≤ 64 KiB (`too-large`), the first 8 KiB read,
     the NUL probe (`binary`), UTF-8; ≤ 200 entries per folder (`limit`). The root comes from
     `deps.projects.openWorkspace(projectId)` (command resolution runs before `openRunWorkspace`, `S/chat/prepare.ts:
     332-347`); unavailable → no project entries + `project-unavailable`. Diagnostics carry project-relative paths only.
     *Accept:* `discover.test.ts` (`realpath(mkdtemp())` projects): a linked file, a linked `.harness/agents` folder, a
     70 KiB file, a binary file, invalid YAML, hidden files, a command 4 folders deep ignored, 201 files → `limit`; a spy
     proves no linked target is ever opened.
  2. **W10.1-T2 Parse and check** — the frontmatter through `parseDefinition` (C29); the catalog adds `duplicate-name`
     and `shadowed`; tool names checked against the live tool list (`unknown-tool` warning, never an error); `model`
     refs checked for a configured provider (`invalid-model` warning; resolution stays the run's). *Accept:* tables per
     kind; `explore.md` → `reserved-name`, state `invalid`; `compact.md` (a command) → `reserved-name`.
  3. **W10.1-T3 User store** — `cus_` ids; create / update re-parse `content` with the C29 parser (400 with the
     diagnostics in `details`), denormalize `kind`, `name`, `description`, `enabled`; unique (kind, name) → 409 `exists`
     (from the index); at most 200 per kind (the answer API.md fixes); a renamed `name` in the content renames the row
     (409 when taken); disabled rows listed with `state: off`. *Accept:* store tests (create, duplicate, update, rename,
     toggle, delete, the cap).
  4. **W10.1-T4 Merge (`catalog.ts`)** — builtin `explore` / `general` (read-only) → `registry.agents` /
     `registry.skills` and the plugin commands (disabled plugins are disposed and drop out; `HF_SAFE_MODE` → none) →
     the DB rows → the project folders; `resolvePrecedence` (C29) → `state: shadowed` + `shadowedBy`; within one folder
     the first sorted path wins (`duplicate-name`); the run snapshot `CustomizationCatalog` (aliases resolved by
     `agent(name)`). *Accept:* `catalog.test.ts` (five sources with one name: the `.harness` file wins, four shadowed; a
     plugin disabled → gone; safe mode; the same name in two kinds never shadows).
  5. **W10.1-T5 Cache** — per project (and `null`), TTL `customizationIndexTtlMs` (10 s), single-flight builds, a
     bounded number of cached projects (W10.1 fixes the cap, reported); dropped on `workspace.changed`,
     `project.changed` and `run.finished` of the project, on registry agent / skill / command changes and on user CRUD;
     `refresh: true` bypasses it; `stop()` clears everything; timers `unref()`. *Accept:* fake timers (TTL, single
     flight, every invalidation trigger).
  6. **W10.1-T6 `load(entry)`** — re-reads the whole file (≤ 64 KiB) through the same guard, re-parses it, checks that
     the name still matches; a missing, renamed or now invalid file → `not_found` / an invalid diagnostic; builtin,
     plugin and user bodies come from their source. *Accept:* tests (deleted after listing, renamed, grown past the cap,
     swapped for a link).
  7. **W10.1-T7 Routes and events** — `GET /customizations?projectId&kind&refresh` (404 unknown project),
     `GET /customizations/source?projectId&kind&name&source` (`{ content, path? }` for project / plugin / builtin
     entries), `POST /customizations` (201), `GET` / `PATCH` / `DELETE /customizations/:id` (204); `customization.changed`
     `{ kind, id }` on every user change, `{ kind }` on registry changes, `{ projectId }` on a project invalidation
     (coalesced, at most one per second per project). *Accept:* route tests for every answer in API.md; bodies and
     content never logged at `info` (a captured-log test).
- **Tests.** The tasks above.
- **Verify.** Server commands.

### W10.2 commands-server (k2)

- **Mission.** Command resolution over the catalog, argument expansion, the invocation fields, the per-turn model
  override with its notice, the turn's tool restriction, `isServerCommandFor`, the server-message path of `prepareRun`
  and the project-aware `GET /commands`.
- **Owned.** `S/chat/{commands,prepare,context,notices}*`, `S/http/routes/commands{,.test}.ts`.
- **Read-only highlights.** ADR-045; `.tmp/p10-designs/plan.md` 3, `server.md` 2C, `explore-commands.md`; API.md
  (`GET /commands`, 6.10); ARCHITECTURE.md 6.24; `SH/util/{arguments,tool-names}.ts`, `SH/chat.ts`
  (`commandInvocationSchema`); `S/chat/{pipeline,tools}.ts` (frozen: `requestModelRef`, `turnRestriction`,
  `allowedTools`); `S/services/customizations/types.ts`.
- **Tasks.**
  1. **W10.2-T1 Resolution (`commands.ts`)** — `resolveCommand(services, text, { chatId, signal, catalog })`: client
     commands never resolve on the server; then harness (`/compact`) → project `.harness` → `.claude` → user → plugin
     registry (the catalog's precedence); a file or user command → `load()` the body → `{ kind: 'prompt', invocation:
     { name, input, type: 'prompt', expansion, source, modelRef?, allowedTools? } }` with `expansion` from
     `expandArguments` (≤ 64 KB, else 400 on `['message']`); a plugin command keeps today's path. *Accept:* tables
     (each source; a plugin `/x` shadowed by a project `/x` only in that project's chats; `$ARGUMENTS`, `$1`, quotes, no
     placeholder → appended; `!` lines and `@file` untouched).
  2. **W10.2-T2 Model override (`prepare.ts` `planRun`, `prepare.ts:359`)** — the command is resolved before the
     target: `resolveTarget(invocation.modelRef ?? body.modelRef)`; an unavailable override (unknown or unconfigured
     provider, an image model) → the chat's model and the notice `command-model-unavailable` (text in `notices.ts`);
     `PreparedRun.requestModelRef` = the body's model; a regenerate reads the stored `metadata.command.modelRef`.
     *Accept:* prepare tests (`chats.model_ref` unchanged after an override turn; `run.started.modelRef` = the model
     that ran; the notice once).
  3. **W10.2-T3 `turnToolRestriction(history)`** — the turn user message's `metadata.command.allowedTools` (continuations
     and regenerates read it again); `PreparedRun.turnRestriction`. *Accept:* the restriction holds after an approval
     continuation and in `auto`.
  4. **W10.2-T4 `isServerCommandFor(deps, projectId, text)`** — true for harness commands and every effective file,
     user or plugin command of the project (the queue marks them `turnOnly`). *Accept:* a queued `/review` is
     `turnOnly`; a client command is not a server command.
  5. **W10.2-T5 Server message path** — `prepareRun(…, { serverMessage })`: skips `normalizeUserParts` (it rejects data
     parts, `files.ts:43-66`), validates with `validateMessage`, accepts only a user-role carrier whose parts are all
     `data-task-result`. *Accept:* tests (a carrier accepted; a text part refused).
  6. **W10.2-T6 Listing and expansions** — `GET /commands?projectId=` (404 unknown project): harness + the effective
     entries with `source`, `pluginId?`, `namespace?`, `argumentHint?`, `modelRef?`; `context.ts`
     (`applyCommandExpansions`) keeps using the stored expansion (a file changed after the turn does not matter).
     *Accept:* route tests (another project's chat does not see the command; no `projectId` → global entries only).
- **Tests.** The tasks above; every existing prepare / commands / context test stays green.
- **Verify.** Server commands.

### W10.3 agents-server (k3)

- **Mission.** Custom agent types in the child runner (type resolution, allowlist, model, instructions, the agent
  snapshot), `runDetachedChild` and the background branch of `runSubagent`, and the agent-types and skills blocks of the
  instructions.
- **Owned.** `S/chat/subagent/**` (not `host.ts`), `S/chat/params*`, `S/builtin-plugins/core-agent/task*`.
- **Read-only highlights.** ADR-043, ADR-045, ADR-046; `.tmp/p10-designs/plan.md` 2, 5, `server.md` 2B,
  `explore-subagents.md` (line references); ARCHITECTURE.md 6.22, 6.26; `S/chat/{tools,agent-scope,markers}.ts`,
  `S/chat/subagent/host.ts` (frozen); `S/chat/background/types.ts` (the launch input); `SH/util/tool-names.ts`.
- **Tasks.**
  1. **W10.3-T1 Type resolution** — `agentTypeInputSchema` (trim, lowercase), the alias `general-purpose` → `general`;
     the run catalog's agent; an unknown type → one `failed` output listing the available types ("Unknown agent type x.
     Available: explore, general, reviewer."). *Accept:* tests.
  2. **W10.3-T2 Tools** — `childTools({ …, allowlist })` filters after the `offeredToChild` ceiling
     (`subagent/tools.ts:91-99,137-145`) with `matchToolAllowlist`; it never adds a tool and never adds an
     approval-requiring tool; custom agents run in `childToolMode('general', parent)` (`explore` stays read-only).
     *Accept:* `subagent/tools.test.ts`: a table allowlist × mode (ask / edits / auto); `escalate` (`shell`,
     `write_file`) in `ask` gets neither; **`task` and `skill` are never in the child set**.
  3. **W10.3-T3 Model** — a frontmatter ref is resolved (failure → `subagentModelRef ?? parent` + a warning); `inherit`
     → the parent's run model; omitted → `subagentModelRef ?? parent` (`resolveChildModel`, `:193-209`);
     `output.modelRef` is the model that ran. *Accept:* tests per case.
  4. **W10.3-T4 Instructions and snapshot** — `joinInstructions(SUBAGENT_PREAMBLE (the marker first), body,
     settings.instructions)` (`:378`); `TaskOutput.agent` = `{ source, description ≤ 200, path? }` of the entry used.
     *Accept:* a recording mock sees the marker first and the body after it.
  5. **W10.3-T5 Background branch and `runDetachedChild`** — `runSubagent` with `input.background` →
     `ctx.background.launch({ chatId, messageId, toolCallId, task, origin, model, toolMode, workspace, scope, settings,
     reasoningEffort, chatInstructions, catalog, logger })` → yields its output at once (`status: background`,
     `taskId`, or `failed` past a cap); a launch counts toward `subagentsPerRunMax`, not the run's slots;
     `runDetachedChild(…)` runs a child against a `ChildSession` with the task's own signal (W10.4 calls it); the child's
     tool calls bind the copied run scope with `<parent>/<child>` ids; `reduceAgentOutputs` keeps `taskId`; `task.ts`
     keeps delegating to the agent scope. *Accept:* tests with the C30 fake `BackgroundTasks` (the immediate output; the
     run cap; a detached child writes a journal row under the launching message).
  6. **W10.3-T6 Instruction blocks (`params.ts`)** — `RunParamsInput.{agentTypes, skills}`: after `TASK_HINT` an "Agent
     types" block (≤ 30 entries, name + description ≤ 250 characters; only when `task` is offered) and a skills block
     (≤ 50, ≤ 250; only when `skill` is offered), both before the project file. *Accept:* `params.test.ts` (present /
     absent, caps, order).
- **Tests.** The tasks above; child prompts and outputs never logged at `info`.
- **Verify.** Server commands.

### W10.4 background-server (k4)

- **Mission.** The background task manager: launch caps, the detached children, persistence, `task.changed`, the
  inbox and exactly-once delivery (the steer step and server-started `task` turns), the chain rule, the boot sweep, the
  routes, every guard, and stopping on chat / project delete, delete-all, key rotation and shutdown.
- **Owned.** `S/chat/background/**` (not `types.ts`), `S/chat/{steer,queue,index}*`,
  `S/http/routes/{chat-tasks,chat,chats}{,.test}.ts`, `S/services/checkpoints/restore-scope*`,
  `S/services/projects/index*`, `S/services/chats/index*`, `S/services/data/index*`.
- **Read-only highlights.** ADR-042, ADR-043, ADR-046; `.tmp/p10-designs/plan.md` 5, `server.md` 2E; API.md (chat
  tasks, `task.changed`, 6.10); ARCHITECTURE.md 6.20, 6.26; `S/chat/background/types.ts`, `S/chat/types.ts` (frozen);
  `S/chat/{pipeline,steps,model-history}.ts` (frozen: `RunSession.inject`, task-result tracking); `S/chat/subagent/host.ts`;
  `SH/util/agent-state.ts` (`taskResultText`), `SH/schemas/background-tasks.ts`.
- **Tasks.**
  1. **W10.4-T1 Launch** — caps first (`backgroundTasksPerChatMax` 3 running per chat, `backgroundTasksMax` 10 per
     server; past a cap → `failed` "At most 3 background agents run per chat. Wait for one to finish."); insert the row
     (`bgt_` id, `running`, the launching run's `origin`); a detached child through W10.3's `runDetachedChild` with its
     own AbortController (the task's Stop and the `backgroundTaskTimeoutMs` 30 min deadline; never the 600 s tool
     guard); `subagentMaxSteps` applies. *Accept:* `background/index.test.ts` with `MockLanguageModelV4` (the fourth
     task fails; the deadline with fake timers → `limit`; a child never creates an approval).
  2. **W10.4-T2 Progress and persistence** — snapshots in memory → `task.changed { chatId, task }` at most once per
     second per task plus every status change; the row written at start and at the end (`status`, `output`,
     `finished_at`); child writes journaled under the launching message; one usage row purpose `subagent` per child
     (message = the launching reply; the cost in `TaskOutput.costUsd` and the chat totals); at most
     `backgroundTasksKeptPerChat` (100) rows per chat (oldest delivered pruned). *Accept:* event throttling with fake
     timers; the rows; the usage row.
  3. **W10.4-T3 Inbox and idle delivery** — a finished task's `TaskResultData` goes into the chat's inbox →
     `deliver(chatId)`: a registered run → nothing (the steer step or `onRunReleased` takes it); else, when the task
     ended naturally (`completed`, `failed`, `limit`), was launched by a `request` / `queue` run (chain depth 1), no
     approval is pending, the chat is not `busy` and its model is not an image model → `startRun(…, origin 'task')`
     with a user-role carrier message of `data-task-result` parts through `prepareRun(…, { serverMessage })`; a lost
     race (409 `run-active`) puts it back at the head of the inbox (the `startQueuedTurn` pattern, `index.ts:84-112`);
     other errors keep it undelivered (a warning); a stopped task (`aborted`) is delivered at the next turn, never by an
     automatic turn. *Accept:* through `createTestApp()` + `app.request()`: the idle path (`run.started { origin: 'task',
     userMessageId }`); the 409 race; the approval wait; a task from an `origin: 'task'` turn starts no turn.
  4. **W10.4-T4 Steer take (`steer.ts`, `steer.ts:106-125`)** — one synchronous take of the steerable queue items, then
     `background.takeResults(chatId)`: one `data-task-result` per result injected for that step, user model messages
     with `taskResultText`, rows marked delivered (`delivered_at`, `delivered_message_id`); step 0 counts (a pending
     approval's continuation takes the results at its step 0). *Accept:* a recording mock sees the result as a user
     message at step N+1; the stored reply holds `data-task-result` between the steps; `buildModelHistory` of the saved
     message equals the in-run messages; delivered exactly once.
  5. **W10.4-T5 Run end and restart** — `onRunReleased` (`index.ts:129-144`): a queued item first (its step 0 takes the
     inbox), else `background.onChatIdle(chatId)`; aborted or failed runs keep the inbox (the chat's Stop never touches
     tasks); `start()` (after `checkpoints.start()`): `running` rows → `aborted` ("The server restarted before the task
     finished."), undelivered rows → the in-memory inbox (delivered at that chat's next run), no turns at boot.
     *Accept:* tests (a restart with a running and an undelivered row).
  6. **W10.4-T6 Routes and stop paths** — `GET /chat/:id/tasks` (`{ items }`), `POST /chat/:id/tasks/:taskId/stop`
     (the answers of API.md); `POST /chat/:id/stop` leaves tasks running; `DELETE /chats/:id` → `stopTasks` first, the
     rows go with the chat (cascade); `deleteEverything` (`S/services/data/index.ts:114-121`) stops every task and keeps
     the `customizations` rows; the manager subscribes to `chat.deleted` and `key.rotated`; `stopAll`: queues →
     background tasks (abort, await ≤ 5 s, rows saved) → runs. *Accept:* a test per trigger.
  7. **W10.4-T7 Guards** — `ChatRunner.hasTasks(chatId)` in `assertProjectIdle` (`restore-scope.ts:56-66`: rewind,
     revert, undo), project remove (`S/services/projects/index.ts:278`), chat move (`S/services/chats/index.ts:283,530`)
     and version delete (`S/http/routes/chats.ts:71-75`) → 409 `run-active`; a branch switch stays allowed. *Accept:*
     tests per guard.
- **Tests.** The tasks above; background prompts and reports never logged at `info`.
- **Verify.** Server commands.

### W10.5 skills-plan-server (k5)

- **Mission.** `loadSkill` and the `skill` tool, plan files (`savePlan`) and the `exit_plan_mode` output and model text.
- **Owned.** `S/chat/{skills,plan-file}*`, `S/builtin-plugins/core-agent/{skill,exit-plan-mode,common}*`.
- **Read-only highlights.** ADR-041, ADR-045, ADR-047; `.tmp/p10-designs/plan.md` 4, 6, `server.md` 2D, 2F;
  ARCHITECTURE.md 6.25, 6.27; `S/workspace/{walk,journal,sensitive}.ts` (`walkWorkspace`, `journaledWrite`);
  `S/builtin-plugins/core-workspace/policies.ts` (hidden-path writes `always`); `S/chat/agent-scope.ts` (frozen).
- **Tasks.**
  1. **W10.5-T1 `loadSkill(name, signal)` (`S/chat/skills.ts`)** — the run catalog → `load()`; output `{ name,
     description, source, content ≤ 64 KiB, truncated, baseDir?, files? }`; a project skill lists its supporting files
     through `walkWorkspace` from the skill folder (depth 3, ≤ `skillFilesListedMax` 50, no links, hidden or
     secret-looking names); an unknown or disabled skill → a tool error listing the available skills. *Accept:* tests
     (`realpath(mkdtemp())`: `pdf/SKILL.md` + `ref.md` → `files: ['ref.md']`; a link in the folder skipped; the caps).
  2. **W10.5-T2 `skill` execute (`core-agent/skill.ts`)** — calls `agentScopeOf(c).loadSkill`; no scope (a child, a
     context without a run) → a tool error; the frozen model text (the content + "Base folder: <baseDir> — read
     supporting files with read_file"). `read_file` of `.harness/**` stays `safe`; hidden-path writes stay `always`.
     *Accept:* `skill.test.ts`; a `read_file` of the skill's `ref.md` needs no approval in `ask`.
  3. **W10.5-T3 `savePlan(plan, c)` (`S/chat/plan-file.ts`)** — only with `planFiles` on and `c.workspace` set; the slug
     from the plan's first heading or first line (`[a-z0-9-]`, ≤ 48, fallback `plan`), the UTC date;
     `journaledWrite(c, root, { tool: 'exit_plan_mode', path: <planDirectory>/<YYYY-MM-DD>-<slug>.md }, produce)`
     (`S/workspace/journal.ts:40`; `produce` throws when `before` exists → the next suffix `-2`, `-3` …); the folder is
     created through the guard; a failure → `planError` + a warning, the approval unaffected. *Accept:* tests
     (collision → `-2`; a link at the plan folder refused; off / no project → no file).
  4. **W10.5-T4 `exit_plan_mode`** — on the approved continuation calls `scope.savePlan`; output `{ approved, mode,
     planPath?, planError? }`; the frozen model text names the path. *Accept:* `exit-plan-mode.test.ts`; a journal row
     with tool `exit_plan_mode`; rewind removes the file, undo restores it.
- **Tests.** The tasks above.
- **Verify.** Server commands.

### W10.6 memory-data-server (k6)

- **Mission.** Remember (`POST /memory`), `customizations.json` in backups and restores, the column classification
  check, and every consumer of `data-task-result` outside the model history.
- **Owned.** `S/services/customizations/memory*`, `S/http/routes/memory{,.test}.ts`,
  `S/services/data/{backup,restore,references}*`, `S/services/chats/{export,text,import}*`, `S/services/shares/**`.
- **Read-only highlights.** ADR-024, ADR-036, ADR-046, ADR-047; `.tmp/p10-designs/plan.md` 5 (item 7), 6,
  `server.md` 2E, 2G; API.md (memory, data, 6.10); ARCHITECTURE.md 6.9, 6.27; `S/services/projects/project-file.ts`;
  `S/services/checkpoints/types.ts` (`journal`); `S/services/shares/snapshot.ts` (`sanitizePart`),
  `S/services/chats/{export,text}.ts`.
- **Tasks.**
  1. **W10.6-T1 Remember** — strict body; project targets need a project chat (`chatId`; the project comes from the
     chat; else 400); control characters except `\n` stripped; `project-file`: `AGENTS.md` if it exists, else
     `CLAUDE.md`, else a new `AGENTS.md`; `lstat` refuses a link (400); a line `- <text>` appended; the result ≤
     `rememberFileMaxBytes` (1 MiB, else 413); written through `deps.checkpoints.journal({ chatId, messageId: null,
     projectId })` with `toolCallId: 'remember_<id>'`, `tool: 'remember'` under the file lock (rewindable, revertible,
     listed in `GET /chats/:id/changes`); `project-instructions` → `projects.update` (over 20 000 characters → 400);
     `global` → `settings.update({ instructions })` (the same cap); result `{ target, file?, created?, project?,
     settings? }`. *Accept:* route tests (CLAUDE.md only → appended there; neither → AGENTS.md created; a linked
     AGENTS.md → 400; the caps; no project chat → 400; the change listed); the text never logged at `info`.
  2. **W10.6-T2 Backup and restore** — `customizations.json` (kind, name, enabled, raw `content`; no secrets) in the
     backup zip when included; a restore keeps an existing entry with the same kind and name (counted as skipped) and
     re-validates every content with the C29 parser; the result counts; `background_tasks` never in backups or exports.
     *Accept:* `backup.test.ts` / `restore.test.ts` round trip on a fresh data dir.
  3. **W10.6-T3 Column classification** — C30's classification of the two tables re-checked (`references.test.ts`
     covers every column). *Accept:* green.
  4. **W10.6-T4 `data-task-result` consumers** — Markdown export ("## Background task: <description> (<status>)" + the
     report); search text (`messagePlainText`: the report); import (a chat export with task-result parts and a carrier
     message round-trips through `harnessDataSchemas`); share snapshots drop task-result parts and a carrier message
     that holds only such parts (no `sharePartSchema` change). *Accept:* `export.test.ts`, `text.test.ts`,
     `import.test.ts`, `snapshot.test.ts` (one case per consumer).
- **Tests.** The tasks above.
- **Verify.** Server commands.

### W10.7 plugin-api-server (k7)

- **Mission.** The agent and skill registries, their validation, the `ctx.agents` / `ctx.skills` members, declarative
  contributions and summaries, and the example plugin `agent-pack`.
- **Owned.** `S/registry/**` (not `types.ts`), `S/plugins/{context,declarative,loader}*`, `examples/plugins/agent-pack/**`,
  `examples/plugins/examples.test.ts` (open point 6).
- **Read-only highlights.** ADR-045; `.tmp/p10-designs/plan.md` (Reconciliation "Plugin API"), `server.md` 2H; PLUGINS.md
  1.4.0; `packages/plugin-sdk/src/**` (1.4.0), `SH/schemas/{plugin-manifest,plugin-data,plugins}.ts`;
  `S/registry/types.ts` (frozen); `S/plugins/declarative.ts:427` (the command registration precedent),
  `S/plugins/loader.ts:151` (`declaredContributions`).
- **Tasks.**
  1. **W10.7-T1 Registries** — `registry.agents` / `registry.skills`: per-plugin ownership, disposed when the plugin is
     disabled or unloaded, `onChange` notifications; a duplicate name across plugins → a conflict (the second refused,
     logged in the plugin log); `explore`, `general` and the alias refused. *Accept:* `registry` tests.
  2. **W10.7-T2 Validation (`validate.ts`)** — name pattern, reserved names, sizes (instructions / content ≤ 64 KiB,
     description ≤ 1024), tool-name pattern (≤ 64 entries), model ref format. *Accept:* tables.
  3. **W10.7-T3 Context (`context.ts`)** — `ctx.agents.register(definition)` / `ctx.skills.register(definition)` →
     disposables owned by the plugin (replacing C28's compile-fix members). *Accept:* a code plugin fixture registers
     and disposes.
  4. **W10.7-T4 Declarative (`declarative.ts`, `loader.ts`)** — `contributes.agents` / `.skills` (≤ 50 each) registered
     like commands; `declaredContributions` and `registry.contributions` gain `agents` / `skills`; plugins with
     `engines ^1.3.0` load unchanged. *Accept:* loader / declarative tests.
  5. **W10.7-T5 Example `agent-pack`** — contributes at least one agent and one skill (W10.7 picks the plugin kind and,
     if it allows, also one `ctx` registration; reported), its own `harness-forge.d.ts`, a README; `EXAMPLE_IDS` gains
     `agent-pack`. *Accept:* `examples.test.ts` (installs and lists it).
- **Tests.** The tasks above.
- **Verify.** Server commands.

### W10.8 customize-web

- **Mission.** The Settings → Customize page, the editor and the viewer, import and export, and the customizations store
  (incl. `fetchCommands` for the composer).
- **Owned.** `W/pages/settings/customize.vue`, `W/components/settings/customize/**`,
  `W/components/common/MarkdownEditor*`, `W/components/plugins/code/editor-setup*`, `W/stores/customizations*`,
  `W/utils/download*`, `W/components/settings/data/{DataExportSection,DataImportSection}*`.
- **Read-only highlights.** UI.md 2.17, 9.12, 10.7, 11.7, 12, 13.11, 14, 15; `.tmp/p10-designs/web.md` 1, 6;
  API.md (customizations); `SH/util/definitions.ts`, `SH/schemas/customizations.ts`;
  `W/components/settings/SettingsModelSelect.vue`; the Gate P10-0a entry-size result (lazy parser import or not).
- **Tasks.**
  1. **W10.8-T1 Store** — `useCustomizationsStore` behind C33's frozen signature: single-flight per key, `loadedAt` +
     stale flag, `maxAgeMs`, an answer older than the last event never wins; `fetchCommands(projectId, { maxAgeMs })`
     and `slashCommands(projectId)` (W10.9's contract); CRUD through `useApi`; `applyEvent` / `refreshLoaded`.
     *Accept:* `customizations.test.ts` (single flight, staleness, event ordering, 409 kept as a typed error).
  2. **W10.8-T2 Page** — `CustomizeSettings` (`?tab=agents|commands|skills`, `?project=<id>`): header (Import…, New
     agent / command / skill), tabs with counts (`customize-tab[data-value|data-count]`, scrolling below `sm`), the project
     select, the source sections in order Personal (editable) · In {project} (read-only, the scanned folders in mono) ·
     From plugins · Built-in; rows (`CustomizationRow`: icon, name, description, source badge, namespace, model, "{n}
     tools" / "All tools", argument hint; badges Shadowed / Invalid + the inline diagnostics / "{n} warnings" / Off; the ⋯
     menu Edit / Duplicate / Export .md / Turn off / Delete for personal rows, View / Copy to personal / Export / Open
     plugin for the others); empty states; `SettingsLoadError` with Retry. *Accept:* `CustomizeSettings.test.ts`,
     `CustomizationRow.test.ts`, `customize.test.ts` (sections, badges, row meta).
  3. **W10.8-T3 Editor** — `CustomizationEditor` (a right `Sheet`, `w-full sm:max-w-2xl`, sticky footer;
     `@tanstack/vue-form` + the shared zod schemas): name (`/` adornment for commands), description, tools (All / Only
     these + `ToolMultiSelect`: a Popover list grouped by plugin, unknown names as warning chips), model
     (`SettingsModelSelect`, none = "Default sub-agent model" / "The chat's model"), argument hint (commands), the body in
     `MarkdownEditor` (CodeMirror through `editor-setup`'s new `createMarkdownEditor`; no Tab capture, Mod+Enter saves,
     lint markers from the diagnostics); the fields serialized with `formatDefinition`; the server diagnostics mapped to
     fields; 409 on the name field ("You already have a {kind} named {name}."); "Discard changes?" on a dirty close.
     *Accept:* `CustomizationEditor.test.ts` (create, edit, reserved name, duplicate 409, discard confirm, Mod+Enter),
     `ToolMultiSelect.test.ts`, `MarkdownEditor.test.ts` (Tab moves focus).
  4. **W10.8-T4 Viewer** — `CustomizationViewer` (read-only sheet: the frontmatter as a definition list, the raw file in
     a read-only `MarkdownEditor` with lint markers, the path with Copy path; Copy to personal opens the editor prefilled
     in `data-mode="import"`; Export .md). *Accept:* tests.
  5. **W10.8-T5 Import and export** — Import…: the hidden input (`.md`, ≤ 256 KB, UTF-8, BOM and CRLF normalized) →
     `parseDefinition` (a dynamic `import()` when Gate P10-0a asked for it) → the editor prefilled + the notes Alert;
     export: the stored `content` (personal) or `formatDefinition` / the source (others) → `downloadText(text,
     '<name>.md', 'text/markdown')` (new in `W/utils/download.ts`). *Accept:* tests (a fixture with ignored keys → notes;
     export round trip).
  6. **W10.8-T6 Delete, toggle, duplicate** — the delete confirm ("Delete {name}?") and the toast "Deleted {name}" with
     Undo (re-created from memory); Turn off / Turn on; Duplicate (a free name). *Accept:* tests.
  7. **W10.8-T7 Data section copy** — the backup "Include settings" help and the restore option mention the personal
     agents, commands and skills. *Accept:* `DataSettings.test.ts` green.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W10.9 composer-web

- **Mission.** The grouped slash menu over the project's commands, the argument-hint ghost text and `/remember` with its
  dialog.
- **Owned.** `W/components/chat/composer/{ChatComposer,SlashMenu,SlashArgumentHint,RememberDialog}{.vue,.test.ts}`,
  `W/components/chat/composer/{slash-commands,remember}{.ts,.test.ts}`.
- **Read-only highlights.** UI.md 7.8, 7.28, 7.30, 10.7, 11.7, 12, 13.11, 14, 15; `.tmp/p10-designs/web.md` 2;
  API.md (`GET /commands`, `POST /memory`); the customizations store (W10.8's, frozen signature); the settings and
  projects stores.
- **Tasks.**
  1. **W10.9-T1 Groups** — the composer reads `useCustomizationsStore().slashCommands(projectId)`, fetched on mount, on a
     project change and when the slash menu opens (`maxAgeMs` 15 s); `SlashItem.group` App (client commands incl.
     `/remember`, harness `/compact`) · Project · Personal · Plugins in that order; rows show `/name`, the argument hint
     (muted mono, hidden below `sm`), the description and the namespace or plugin name; `slash-menu-item[data-group]`;
     name-prefix filtering unchanged. *Accept:* `slash-commands.test.ts`, `SlashMenu.test.ts`.
  2. **W10.9-T2 Ghost hint** — `SlashArgumentHint`: an `aria-hidden` mirror over the textarea (same padding, font, line
     height) showing an invisible `/name ` and the muted hint while the text is exactly `/name ` plus blanks on one line;
     hidden at the first argument character; an sr-only `aria-describedby` text "Arguments: <hint>"; it never takes keys.
     *Accept:* `SlashArgumentHint.test.ts`, `ChatComposer.test.ts`.
  3. **W10.9-T3 `/remember`** — `resolveClientCommand` `remember` → the input cleared and `RememberDialog` opened with
     the text; the dialog: `remember-text` (≤ 2000, counter), the targets `project-file` ("{file} in {project}" or
     "AGENTS.md in {project} (new file)"), `project-instructions`, `global`; the project targets disabled outside a
     project ("Open a chat in a project to use this.", `aria-disabled` + `aria-describedby`); the default from
     `localStorage['hf-remember-target']` when enabled; Mod+Enter saves; `POST /memory` → the returned project or
     settings applied to their stores; toasts; inline errors (`remember-error[data-code]`, `role="alert"`); focus back
     to the textarea on close (desktop). *Accept:* `RememberDialog.test.ts`, `remember.test.ts`.
  4. **W10.9-T4 Keyboard** — the chain mention menu → slash menu → mode cycle unchanged; Esc in the composer stops the
     run only (never a background agent). *Accept:* composer tests.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W10.10 session-dock-web

- **Mission.** The background-tasks store and its events, the dock, server-started `task` turns, the context that task
  blocks read, and the announcements.
- **Owned.** `W/composables/{useChatSession,useServerEvents}*`, `W/stores/background-tasks*`,
  `W/components/chat/{ChatView,chat-context}*`, `W/components/chat/background/**`.
- **Read-only highlights.** UI.md 2.17, 7.29, 10.7, 11.7, 14, 15; `.tmp/p10-designs/web.md` 3, 4; API.md (chat tasks,
  `task.changed`, `run.started.origin`); `taskResultsOf` (C33, `chat-format.ts`); `TaskBody` (W10.11's, frozen props).
- **Tasks.**
  1. **W10.10-T1 Store** — `useBackgroundTasksStore`: `fetch`, `stop` (`'stopped' | 'gone'`), `stopAll` (loops `stop`
     over the running tasks), `applyEvent` (`task.changed` upsert, ignoring an older snapshot; `chat.deleted` drop),
     `refreshLoaded`. *Accept:* `background-tasks.test.ts`.
  2. **W10.10-T2 Events** — `useServerEvents` dispatches `task.changed`, `customization.changed`, `plugin.changed` and
     `chat.deleted`; both stores refresh their loaded keys on reconnect. *Accept:* `useServerEvents.test.ts`.
  3. **W10.10-T3 Session** — `load()` fetches the chat's tasks; `run.started` with `origin: 'task'` and a
     `userMessageId` not on the shown path → `refresh()` then `resumeStream()` (deferred until idle when busy);
     `ChatView` announces "Background agent finished: {description}" once per new carrier. *Accept:* session tests with
     two sessions (two tabs).
  4. **W10.10-T4 Dock** — `BackgroundAgents` (hidden without visible tasks; collapsed: one h-9 line, h-10 on touch,
     "2 background agents · {latest description} · 1m 12s" / "1 background agent finished · reports next", the toggle
     named "Show background agents, 2 running"; collapsed by default below `md`; `localStorage['hf-background-expanded']`;
     expanded: `max-h-[40dvh]`, "Background agents · {n} running", Stop all, rows `BackgroundAgentRow` (chevron →
     `TaskBody`, type icon and label, description, live step, duration, status, Stop with `aria-busy` while stopping),
     the footnote "They keep running after the reply. Stop in the composer doesn't stop them."); a polite announcer per
     transition this tab observed; after a stop the focus moves to the next row's Stop, else the toggle; "It already
     finished." for `gone`. *Accept:* `BackgroundAgents.test.ts`, `BackgroundAgentRow.test.ts`,
     `background-agents.test.ts`.
  5. **W10.10-T5 Context** — `ChatView` provides `AGENT_TASK_CONTEXT` (`task(id)` from the store, `result(id)` from
     `taskResultsOf` of the shown path, `reveal(id)` expands the dock and scrolls to the row, `showResult(id)` scrolls to
     the note). *Accept:* `ChatView.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W10.11 transcript-web

- **Mission.** Custom and background task blocks, the task-result note and the carrier turn, the skill row, the
  plan-file chip, the command badge and the share rows.
- **Owned.** `W/components/chat/{agent,parts}/**`, `W/components/chat/{ChatMessage,ChatTranscript,UserMessageBubble,
  MessageActions,chat-format}*`, `W/components/share/{ShareToolRow,SharedMessage,share-view}*`.
- **Read-only highlights.** UI.md 2.17, 7.25, 7.27 – 7.29, 10.7, 11.7, 13.11, 14, 15; `.tmp/p10-designs/web.md` 3, 5;
  `SH/schemas/{agent,background-tasks}.ts`; `AGENT_TASK_CONTEXT` (W10.10's, frozen); `useChangesPanel`.
- **Tasks.**
  1. **W10.11-T1 Custom types** — `agent-tools.ts` `taskKindOf(type)` / `taskTypeLabel(type)`; `TaskBlock`
     `data-kind="custom"` + `data-agent-type`, the agent name as the label, `BotMessageSquare`; a HoverCard from
     `output.agent` (description and source: "Personal agent", "From {plugin}", "Project: {path}"); the trigger name
     "Sub-agent {name}: {description}, running, 4 tool calls". *Accept:* `TaskBlock.test.ts`, `agent-tools.test.ts`.
  2. **W10.11-T2 Background blocks** — `data-background`; the live status from `AGENT_TASK_CONTEXT.task(taskId)`, the
     delivered status from `result(taskId)`; "In background", the meta "Background · 8 tool calls · 1m 2s", the live
     step; expanded: `TaskBody` with the store snapshot and `task-block-reveal` ("Show in background agents" while it
     runs, "Go to the result" once delivered); the trigger name adds "running in the background". *Accept:* tests.
  3. **W10.11-T3 Result note and carrier** — `TaskResultNote` (full width, dashed muted, `role="note"` "Background agent
     result: {description}", "Background agent finished / failed / stopped / reached its step limit", the first sentence,
     Show report / Hide report → the Markdown report with Copy and the meta line); `chat-format` kind `task-result`;
     inline in a reply, or as the carrier turn (`isTaskResultMessage`: no bubble, no actions, no edit, no rewind, the
     caption "Sent to the agent"). *Accept:* `TaskResultNote.test.ts`, `ChatMessage.test.ts`, `chat-format.test.ts`.
  4. **W10.11-T4 Skill row** — `tool-row[data-tool-name=skill]`: `BookOpen`, "Loaded skill" + the mono name, the source
     on the right, "Loading skill" / "Couldn't load skill"; `SkillToolBody` (description, base folder, the content as
     Markdown with "The agent read these instructions."). *Accept:* `ToolPart.test.ts`, `SkillToolBody.test.ts`.
  5. **W10.11-T5 Plan-file chip** — `PlanFileChip` (`plan-file[data-state=saved|failed][data-path]`: "Saved to" + the
     path chip, Copy path, Show changes in project chats through `useChangesPanel`; failed: "Couldn't save the plan file:
     {error}"). *Accept:* `PlanFileChip.test.ts`.
  6. **W10.11-T6 Command badge** — `CommandBadge` shows the command's source and, with an override, its model.
     *Accept:* tests.
  7. **W10.11-T7 Share** — `ShareToolRow`: the custom label and icon, "· in the background", skill rows "Loaded skill
     {name}" (body only with tool details); `share-view` / `SharedMessage` need no task-result rendering (the server
     drops those parts). *Accept:* `ShareToolRow.test.ts`, `share-view.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W10.12 settings-plugins-web

- **Mission.** The plan-file settings, the plugin Agents / Skills sections and card summary, and the project link to
  Customize.
- **Owned.** `W/components/settings/agent/**`, `W/components/settings/projects/ProjectsSettings*`,
  `W/components/plugins/detail/{PluginContributions,PluginCustomizationList}*`, `W/components/plugins/list/plugin-display*`.
- **Read-only highlights.** UI.md 8, 9.10, 9.11, 9.12, 13.11, 15; `.tmp/p10-designs/web.md` 5; the customizations store
  (`catalog(null)`, W10.8's); `W/stores/plugins.ts` (the `agents` filter, complete in P10-0b).
- **Tasks.**
  1. **W10.12-T1 Plan settings** — `AgentSettingsSection` ("Long chats, sub-agents and plans."): Save approved plans
     (`settings-plan-files`, Switch, `planFiles`; "When you approve a plan in a project chat, it's saved as a Markdown
     file in the project.") and Plan folder (`settings-plan-directory`, mono Input, disabled while off, placeholder
     `.harness/plans`, saves on blur / Enter, restores on Esc; "Use a folder inside the project, like .harness/plans." /
     "Use at most 200 characters."). *Accept:* `AgentSettingsSection.test.ts`.
  2. **W10.12-T2 Plugin sections** — `PluginContributions` gains Agents ("Sub-agents the main agent can start.") and
     Skills ("Instructions the agent loads when a task needs them.") after Commands, both `PluginCustomizationList`
     (`plugin-customizations[data-kind]`, rows `plugin-customization[data-name]`: mono name, description, model / "{n}
     tools"; entries from `catalog(null)` by `pluginId`; contribution names without an entry as name-only rows; "Open in
     Customize"). *Accept:* tests.
  3. **W10.12-T3 Card summary** — `contributionsSummary` adds "2 agents · 1 skill"; a glyph for agent packs where the
     display needs one. *Accept:* `plugin-display.test.ts`.
  4. **W10.12-T4 Project link** — the Projects row menu item "Agents, commands and skills…" (`project-customizations`)
     → `/settings/customize?project=<id>`. *Accept:* `ProjectsSettings.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### Wave P10-A ownership

These globs are the plan's table plus the additions listed in "Deviations" (open points 2 and 6). The audit cannot
express "except": every `types.ts` of `S`, `S/chat/{pipeline,tools,steps,markers,model-history,agent-scope}.ts`,
`S/chat/subagent/host.ts`, `S/builtin-plugins/core-agent/index.ts`, the mock models, the C29 helpers and the P10-0b stub
props stay frozen despite the globs; `S/services/customizations/memory*` matches W10.1's glob but is W10.6's;
`S/services/customizations/types.ts`, `S/chat/background/types.ts` and `S/registry/types.ts` match W10.1's, W10.4's and
W10.7's globs (frozen). W10.9's composer files are enumerated: every other composer file has no P10-A owner.

```json
{
  "wave": "P10-A",
  "agents": {
    "W10.1": [
      "apps/server/src/services/customizations/**",
      "apps/server/src/http/routes/customizations{,.test}.ts",
      "apps/server/src/testing/fake-customizations*"
    ],
    "W10.2": [
      "apps/server/src/chat/{commands,prepare,context,notices}*",
      "apps/server/src/http/routes/commands{,.test}.ts"
    ],
    "W10.3": [
      "apps/server/src/chat/subagent/**",
      "apps/server/src/chat/params*",
      "apps/server/src/builtin-plugins/core-agent/task*"
    ],
    "W10.4": [
      "apps/server/src/chat/background/**",
      "apps/server/src/chat/{steer,queue,index}*",
      "apps/server/src/http/routes/{chat-tasks,chat,chats}{,.test}.ts",
      "apps/server/src/services/checkpoints/restore-scope*",
      "apps/server/src/services/projects/index*",
      "apps/server/src/services/chats/index*",
      "apps/server/src/services/data/index*"
    ],
    "W10.5": [
      "apps/server/src/chat/{skills,plan-file}*",
      "apps/server/src/builtin-plugins/core-agent/{skill,exit-plan-mode,common}*"
    ],
    "W10.6": [
      "apps/server/src/services/customizations/memory*",
      "apps/server/src/http/routes/memory{,.test}.ts",
      "apps/server/src/services/data/{backup,restore,references}*",
      "apps/server/src/services/chats/{export,text,import}*",
      "apps/server/src/services/shares/**"
    ],
    "W10.7": [
      "apps/server/src/registry/**",
      "apps/server/src/plugins/{context,declarative,loader}*",
      "examples/plugins/agent-pack/**",
      "examples/plugins/examples.test.ts"
    ],
    "W10.8": [
      "apps/web/app/pages/settings/customize.vue",
      "apps/web/app/components/settings/customize/**",
      "apps/web/app/components/common/MarkdownEditor*",
      "apps/web/app/components/plugins/code/editor-setup*",
      "apps/web/app/stores/customizations*",
      "apps/web/app/utils/download*",
      "apps/web/app/components/settings/data/{DataExportSection,DataImportSection}*"
    ],
    "W10.9": [
      "apps/web/app/components/chat/composer/{ChatComposer,SlashMenu,SlashArgumentHint,RememberDialog}{.vue,.test.ts}",
      "apps/web/app/components/chat/composer/{slash-commands,remember}{.ts,.test.ts}"
    ],
    "W10.10": [
      "apps/web/app/composables/{useChatSession,useServerEvents}*",
      "apps/web/app/stores/background-tasks*",
      "apps/web/app/components/chat/{ChatView,chat-context}*",
      "apps/web/app/components/chat/background/**"
    ],
    "W10.11": [
      "apps/web/app/components/chat/{agent,parts}/**",
      "apps/web/app/components/chat/{ChatMessage,ChatTranscript,UserMessageBubble,MessageActions,chat-format}*",
      "apps/web/app/components/share/{ShareToolRow,SharedMessage,share-view}*"
    ],
    "W10.12": [
      "apps/web/app/components/settings/agent/**",
      "apps/web/app/components/settings/projects/ProjectsSettings*",
      "apps/web/app/components/plugins/detail/{PluginContributions,PluginCustomizationList}*",
      "apps/web/app/components/plugins/list/plugin-display*"
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

A file a P10-A agent creates outside its globs (or a composer file not in W10.9's lists) is a CCR: the coordinator
adds it to the wave file at the gate.

### Wave P10-A cross-agent contracts

The props below are frozen in the P10-0b stubs or documented in UI.md 10.7; the server members in the frozen files.

| Producer → consumer | Contract |
|---|---|
| C30 → W10.1 – W10.5 | `CustomizationService` / `CustomizationCatalog` (W10.2 – W10.5 test with the C30 fake) |
| W10.1 → W10.2 – W10.5 | the real catalog behind that interface: precedence, `load()`, the cache |
| W10.3 ↔ W10.4 | the `BackgroundTasks` API (`launch` input and output, `takeResults`, `onChatIdle`) and `runDetachedChild(…)` (W10.3 implements, W10.4 calls) |
| C29 → W10.4, W10.6 | `splitTaskResults` / `taskResultText` (injection text, consumers) |
| C31 → W10.2 – W10.5 | `requestModelRef`, `turnRestriction`, `allowedTools`, `skillsAvailable`, `loadSkill` / `savePlan`, `prepareRun(…, { serverMessage })` (frozen) |
| W10.2 → W10.4 | the server-message path of `prepareRun` (the carrier), `isServerCommandFor` (queue `turnOnly`) |
| W10.5 → W10.11 | the `skill` output and `planPath` / `planError` (rendered by the skill row and `PlanFileChip`) |
| W10.7 → W10.1, W10.12 | the registry `agents` / `skills` interfaces and contributions (the catalog's plugin entries, the plugin detail sections) |
| W10.8 → W10.9 | `slashCommands(projectId)` / `fetchCommands(projectId, { maxAgeMs })` |
| W10.8 → W10.12 | `catalog(null)` (plugin entries by `pluginId`) |
| W10.10 → W10.11 | `AGENT_TASK_CONTEXT` (`task`, `result`, `reveal`, `showResult`) |
| W10.11 → W10.10 | `taskResultsOf` / `TaskBody` props (frozen) |
| W10.6 → W10.8 | the backup / restore flags and result counts of API.md (the Data section copy) |

### Gate P10-A

1. `node scripts/audit-ownership.mjs .tmp/waves/P10-A.json`
2. Batch the CCRs → `nuxi prepare` → `pnpm check` → `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
3. `mv .tmp/e2e .tmp/e2e-old-p10-a` → probes (`.tmp/gates/P10-A/probe.mjs`, built on the P9-A harness: `startServer`,
   `client`, libsql `rows`, `check`, `newProject`, `uuidv7`, `msgId`, `chatStream`, `events(c).waitFor(type, pred, ms)`,
   `approveAndContinue`; new helpers `writeDefs(root, tree)` (files, symlinks and oversized files on disk) and
   `taskRows(dataDir, chatId)`) on probe servers 8896 (agents, commands, skills, background, plan files, Remember,
   hygiene), 8897 (catalog, plugins, data) and 8898 (upgrade), `HF_DATA_DIR=.tmp/gates/P10-A/run-<ts>/<name>`; loops run
   through `bash -c`; project folders in the probe servers' default roots (the seed roots only as copies):
   1. **Catalog** (8897) — a project with `.claude/agents/a.md` and `.harness/agents/a.md` → one active `a` (the
      `.harness` file) and one shadowed; invalid YAML, a linked file, a linked `.harness/agents` folder, a 70 KiB file, a
      binary file and `explore.md` → diagnostics (`invalid-frontmatter`, `link`, `too-large`, `binary`, `reserved-name`)
      and no linked content anywhere in the answer; user CRUD 201 / 409 `exists` / 400 with diagnostics / PATCH / 204,
      each with `customization.changed`; a file added on disk shows after the invalidation or with `?refresh=1`; the
      backup zip holds `customizations.json` and restores on a fresh server (an existing same-name entry kept).
   2. **Agents** (`mock:agents`, project, `ask`) — the persona is applied (`persona=` in the child report); the child's
      `tools:` ⊆ allowlist ∩ the `ask` ceiling (no `write_file` even when listed); `escalate` gets neither `shell` nor
      `write_file`; in `edits` an allowed `write_file` is journaled with a `<parent>/<child>` tool call id; no
      `approval-requested` part anywhere; `model: mock:echo` → `output.modelRef`; an unknown type → `failed` with the list;
      `general-purpose` → `general`; `task` never in the child set; a `write_file` into `.harness/agents/x.md` asks even
      in `edits`.
   3. **Commands** — `/review a b` → `$ARGUMENTS` / `$1` expanded (`Agents mock: …`), `source: project`; `model:
      mock:agents` → the reply runs on it and `chats.model_ref` is unchanged; a missing model → the
      `command-model-unavailable` notice and the chat model; `allowed-tools: Read` → `Tools: read_file`, held after an
      approval continuation and in `auto`; a plugin command shadowed only in the project chat; `compact.md` →
      `reserved-name`; another project's chat does not see the command; a queued `/review` is `turnOnly`.
   4. **Skills** — `skills?` lists `pdf`; `skill pdf` → the body, `baseDir`, `files: ['ref.md']`; `read_file ref.md`
      runs without approval in `ask`; a project without skills → `skill` not offered; a plugin skill is listed and gone
      after the plugin is disabled.
   5. **Background** (`mock:background`) — the idle path: `status: background` + `taskId` → `task.changed` → `run.started
      { origin: 'task' }` → "Background result: completed", `GET /chat/:id/tasks` shows it delivered; the in-run path: a
      `data-task-result` between steps ("Finished: in-run result completed"); the stop route → `aborted`, delivered at the
      next user turn, no automatic turn; the chat's Stop leaves it running; while it runs rewind / revert / project
      delete / chat move / version delete → 409 `run-active`, a branch switch is fine; chat delete stops it and removes
      the rows; a fourth task in one chat → `failed`; a pending approval holds the result until its continuation's step
      0; a restart → an `aborted` row, delivered later; a task from an `origin: 'task'` turn starts no turn; one
      `subagent` usage row per child; `pending_approval` stays 0.
   6. **Plan files** (`mock:plan`, project) — `planFiles` on → approve in `edits` → `.harness/plans/<date>-<slug>.md`, a
      journal row (`exit_plan_mode`), `planPath` in the output, the changes list shows it, rewind removes it, undo
      restores it; off / a chat without a project / a denied plan → no file; `planDirectory: '../x'` or `'.git/x'` →
      400; a collision → `-2`.
   7. **Remember** — a CLAUDE.md-only project → CLAUDE.md appended; neither file → AGENTS.md created; a linked AGENTS.md
      → 400; the caps → 400 / 413; no project chat → 400 for the project targets; the change appears in `GET
      /chats/:id/changes`; the project-instructions and global targets append.
   8. **Plugin API** (8897) — `pluginApiVersion` 1.4.0; `agent-pack`'s agents and skills listed in the contributions,
      the catalog and usable in a chat; a duplicate across two plugins → a conflict in the plugin log; an agent named
      `explore` refused; a plugin command `/remember` refused; `^1.3.0` plugins load.
   9. **Hygiene** — `git status --porcelain` of the repository is identical before and after `pnpm test`; the server
      logs hold no definition or skill body, command expansion, background prompt or report, or Remember text at `info`;
      only `mock:*` model refs in the usage rows.
   10. **Upgrade** (8898, a fresh copy of `.tmp/upgrade-v15` with copied roots) — the seeded definitions are listed
       read-only (`reviewer` from `.harness` active, the `.claude` one shadowed; `escalate`; `greet` with its hint;
       `release-notes`; the invalid and over-cap files invalid; the symlink skipped); old task parts intact; `mock:subagent`
       works; old chats keep their `toolMode`; the long chat continues; `0007` = 2 tables + 3 indexes,
       `integrity_check` clean.
   11. **Regressions** (one after another: shared ports) — `node .tmp/gates/P9-A/probe.mjs` (every section, incl. its v1.4
       upgrade) and `node .tmp/gates/P8-A/probe.mjs ws git`.
4. `pnpm test:e2e` (`chromium` + `mobile` + `tablet`; the feature specs come in P10-B) green.
5. `E2E_SCREENSHOTS=1 pnpm test:e2e --grep @screenshots` → review `.tmp/screenshots/{dark,light}/`.
6. `pnpm audit --prod --audit-level high` clean (the two ignored advisories excepted).
7. ROADMAP + wave log → commit `feat: add custom agents, commands, skills and background agents`.

---

## Wave P10-B — feature e2e, docs, fix-ups

### Coordinator actions

- Before the launch: the P10-A checkpoint build for W10.13; W10.15 / W10.16 globs from the red P10-A gate items added to
  `.tmp/waves/P10-B.json` (launched only when needed); the P10-A reports handed to W10.14 as the digest
  `.tmp/waves/P10-A-notes.md` (contract facts, deviations, items marked "For W10.14").
- The final gate below; ROADMAP (every Phase 10 box, the backlog, the wave log); the memory file; push only when the
  user asks.

### W10.13 e2e-features (e2e 8891)

- **Mission.** End-to-end specs for the Customize page, custom commands, custom agents, skills, background agents,
  Remember, plan files and plugin agents, mobile and tablet checks, screenshots of the new screens and full-frame README
  shots.
- **Owned.** `e2e/**`.
- **Read-only highlights.** UI.md 2.17, 7.28 – 7.30, 9.11, 9.12, 12, 13.11, 14; PROVIDERS.md 8 ("Customization mocks
  (Phase 10)"); `playwright.config.ts`; `e2e/README.md`; `e2e/helpers/{chat,workspace,keyboard}.ts`.
- **Tasks.**
  1. **W10.13-T1 `core/customize.spec.ts`** — the nav entry and the palette entry; create an agent (an empty name, the
     reserved `explore`, a duplicate → 409 on the name field); tools "Only these"; a model; Turn off; edit; delete +
     Undo; import a fixture `.md` with ignored keys (the notes); export through the download event with a content round
     trip; the project select with fixture `.harness/agents` + `.claude/agents` (shadowed, invalid with diagnostics);
     the viewer; Copy to personal; a reload keeps everything.
  2. **W10.13-T2 `core/custom-commands.spec.ts`** — the groups App / Project / Personal / Plugins (`data-group`); the
     ghost hint; `$ARGUMENTS` expansion shown by `mock:agents`; the namespace label; a project command absent outside
     the project; the command badge (source, model).
  3. **W10.13-T3 `core/custom-agents.spec.ts`** — the custom task block (label, icon, tooltip); the allowlist visible
     in the child report (`tools:`).
  4. **W10.13-T4 `core/skills.spec.ts`** — the "Loaded skill" row and its body.
  5. **W10.13-T5 `core/background-agents.spec.ts`** — a block "In background"; the dock's live line; the composer's
     Stop leaves it running; a row Stop → the stopped note at the next turn; Stop all; an idle completion → the carrier
     note and a reply without user action; a mid-run completion → an inline note; a reload restores the dock; a second
     page sees it.
  6. **W10.13-T6 `core/remember.spec.ts`** — the three targets (the global one shows in General, the project file in the
     changes panel, the project instructions in the dialog text); the targets disabled outside projects; the limit
     error.
  7. **W10.13-T7 `core/plan-files.spec.ts`** — the setting on → approve → the `plan-file` chip; the changes panel lists
     the file; rewind removes it.
  8. **W10.13-T8 `plugins/plugin-agents.spec.ts`** — the "Agents and skills" filter, the card summary, the detail
     sections.
  9. **W10.13-T9 Extensions** — `share` (custom and background task rows, skill rows, no result notes), `keyboard` (Esc
     never stops background agents; the Remember dialog focus; Mod+Enter in the editor), `data` (the backup round trip
     with personal definitions), `settings` (the plan-file fields persist).
  10. **W10.13-T10 Mobile and tablet** — `mobile/customize.spec.ts` (390 px: no horizontal scroll on
      `/settings/customize`, the editor sheet fits, the tabs scroll, 40 px row menus); `mobile/agent` (the dock with
      strip + background agents + queue + composer fits; the Remember dialog; the grouped slash menu); the tablet
      touch-target spec covers the dock toggle, row Stop, Stop all, the customize row menus, the Remember radios and the
      editor footer (≥ 40 px).
  11. **W10.13-T11 Screenshots** — `settings-customize`*, `customization-editor`*, `composer-slash-groups`,
      `chat-background-agents`*, `chat-task-result`, `remember-dialog`*, `plugin-detail-agents` (dark + light; * = also
      mobile) and the `@readme` full-frame shots for every README image.
  12. **W10.13-T12 README** — `e2e/README.md` lists the new specs.
- **Verify.** `pnpm test:e2e --list`; slot runs (`HF_MOCK_PROVIDER=1 HF_OFFLINE=1 HF_PORT=8891
  HF_DATA_DIR=.tmp/W10.13/data node apps/server/dist/main.mjs`, `E2E_BASE_URL=http://127.0.0.1:8891 pnpm test:e2e`);
  three green runs of the new specs; watch the CI e2e job budget (about 165 tests).

### W10.14 docs-final

- **Mission.** Reconcile every doc with the code and the agent reports.
- **Owned.** `README.md`, `.env.example`, `docs/**` except `DECISIONS.md` and `ROADMAP.md`.
- **Read-only highlights.** `.tmp/waves/P10-A-notes.md`, the code of every Phase 10 area.
- **Tasks.**
  1. **W10.14-T1 Reconcile** — API.md vs the route table and the implemented answers (`customizations`, `memory`,
     `chatTasks`, `GET /commands?projectId`, the events, the agent tool schemas, the carrier message); UI.md 13.11 vs
     `utils/testids.ts`, the contracts (10.7), the stores and modules (11.7), the copy (15), the shortcuts (12);
     ARCHITECTURE.md vs the implemented flows (5, 6.9, 6.23 – 6.27, 8, 10.11, 12); PLUGINS.md (1.4.0, `agent-pack`, the
     snippets `examples.test.ts` compares); PROVIDERS.md 8 ("Customization mocks (Phase 10)") vs the mock models; the
     guide `customizing-agents.md`.
  2. **W10.14-T2 Status** — README "v1.6" (features: custom agents, commands and skills, the Customize page, background
     agents, plan files, Remember, plugin API 1.4.0); `docs/assets/screenshots/` refreshed from the `@readme` shots at the
     final gate (the coordinator copies them).
  3. **W10.14-T3 This file** — what actually happened (status, "Deviations found while building", gate results per
     wave).
- **Verify.** `pnpm check:english`; `pnpm -F @harness-forge/shared test` (doc-coupled tests).

### W10.15 / W10.16 fix-ups

Launched only for red P10-A gate items (W10.15 server, W10.16 web), with the globs of those items.

### Wave P10-B ownership

```json
{
  "wave": "P10-B",
  "agents": {
    "W10.13": ["e2e/**"],
    "W10.14": [
      "README.md",
      ".env.example",
      "docs/API.md",
      "docs/UI.md",
      "docs/ARCHITECTURE.md",
      "docs/PLUGINS.md",
      "docs/PROVIDERS.md",
      "docs/guides/**",
      "docs/phases/phase-10-v1-6.md",
      "docs/assets/**"
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

### Final gate

1. `node scripts/audit-ownership.mjs .tmp/waves/P10-B.json` → `pnpm install --frozen-lockfile` → `pnpm check` →
   `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
2. The P10-A probes again (after `mv .tmp/e2e .tmp/e2e-old-final-v16`) plus the P9-A and P8-A regressions (one after
   another: shared ports).
3. `for i in 1 2 3; do pnpm test:e2e || exit 1; done` (`chromium` + `mobile` + `tablet`), with the OS color scheme
   emulated as light; `E2E_SCREENSHOTS=1 pnpm test:e2e --grep @screenshots` → dark + light reviewed (the Customize page
   and editor, the grouped slash menu, the dock, the result note, the Remember dialog, the plugin sections on desktop and
   mobile); the README images copied from the `@readme` shots.
4. `pnpm audit --prod --audit-level high`; the two advisories re-checked with the P8-00 rule.
5. **Real v1.5 → v1.6 upgrade**: the `.tmp/v15` worktree build (`5481fb3`) seeds a fresh data directory with the full
   K3 seed set, stop it, start v1.6 on the same data directory → `0007` applied, everything intact, the old task parts
   render, the `.claude` / `.harness` definitions discovered read-only with the right precedence and diagnostics.
6. Docker (daemon permitting, else the CI `docker` job): boot on a copy of that seed; a custom agent from
   `/data/workspaces/<p>/.harness/agents` runs; a background agent completes and delivers; `/remember` writes
   `AGENTS.md` as uid 1000.
7. `git status --porcelain` of the repository unchanged by `pnpm test`.
8. ROADMAP + wave log → commit `chore: final gate for harness-forge v1.6`; write the project memory (state, commits,
   user actions); push only when the user asks. The live provider suite stays the user's (paid).

---

## Outcome

Completed by the coordinator at each gate ("audit" is the ownership audit of `scripts/audit-ownership.mjs`).

| Wave | Agents | Gate result | Commit |
|---|---|---|---|
| P10-00 | coordinator | CI `37162957905` + Audit `37162958016` on `5481fb3` green; no open PRs; advisories still unpatched (ignores kept, re-checked 2026-10-04); design reports in `.tmp/p10-designs`; `pnpm check` 9469 tests, `git status` unchanged; `.tmp/v15` built | (no commit) |
| P10-0a | coordinator (K1, K2, contract skeletons, K3 seed by K3S), C28, C29, D12, D13 | (pending) | (pending) `feat: add phase 10 contracts and docs` |
| P10-0b | coordinator (K3), C30, C31, C32, C33 | (pending) | (pending) `feat: add phase 10 schema, migration and skeletons` |
| P10-A | W10.1 – W10.12 | (pending) | (pending) `feat: add custom agents, commands, skills and background agents` |
| P10-B | W10.13, W10.14 (+ W10.15 / W10.16 if needed) | (pending) | (final gate commit) |
| Final gate v1.6 | coordinator | (pending) | (pending) `chore: final gate for harness-forge v1.6` |

---

## Risks

State before P10-0b.

| Risk | Mitigation |
|---|---|
| Hostile repository `.claude/` / `.harness/` files (prompt injection, privilege) | instructions-only trust like `AGENTS.md`; restrict-only allowlists; no grants, mode changes, overrides or rules; skill bodies only on an explicit `skill` call; capped listings; the source shown in the UI; hidden-path writes always ask; probes 2 and 10 |
| YAML or discovery denial of service (alias bombs, deep nesting, huge folders) | byte caps before parsing, `maxAliasCount: 0`, 8 KiB frontmatter, 200 entries per folder, depth 3, frontmatter-only discovery, the TTL and single-flight; C29 fuzz |
| Link escape or traversal in the definition folders | `rel` equality, O_NOFOLLOW, dirent types, no hidden names; probes 1, 7 and 10 |
| Ambiguous precedence | one resolver in SH (`resolvePrecedence`) with table tests; shadowed badges and `shadowedBy` in the UI |
| Background runaway cost or leaks | caps (3 / 10 / 30 min / `subagentMaxSteps`), chain depth 1, no automatic turn while an approval is pending, during maintenance or at boot, Stop in the UI, the cost in the output, persisted status, every stop path; probe 5 |
| Delivery races (the run end, a user POST) | the synchronous inbox take, `onRunReleased`, the 409 requeue at the head, `delivered_at` once |
| Background writes vs rewind / move | the `hasTasks` guards (409 `run-active`); probe 5 |
| Resume merge of a server-started turn | the user-role carrier message (the web treats it like a queue turn) |
| A model override persisted as the chat model | `requestModelRef` in the pipeline touches; probe 3 |
| `allowed-tools` differs from Claude Code | documented "narrows only"; diagnostics for patterns; the guide |
| The widened `task.type` breaks old parts or the web | `taskTypeSchema` kept for icons, new name schemas, the generic label fallback, upgrade probes |
| `yaml` bloats the SPA or is missing at runtime | the entry-size check at Gate P10-0a with the lazy-import fallback; declared in the server package (tsdown / Docker), the build grep, the Docker probe |
| Stale project commands after disk edits | the 10 s TTL, the events, the revalidation on slash-menu open, `?refresh=1` |
| `remember` becomes reserved | a release note; plugin validation refuses it |
| `0007` damages a v1.5 data directory | CREATE-only inspection; the upgrade test, the upgrade probe and the real upgrade |
| A plan file outside the project | the zod refinement of `planDirectory`, the path guard, `journaledWrite`; probe 6 |
| Hot files (`pipeline.ts`, `tools.ts`, `prepare.ts`, `commands.ts`, `params.ts`, `steer.ts`, `index.ts`, `subagent/**`, `ChatComposer.vue`, `ChatView.vue`, `ChatMessage.vue`, `ToolPart.vue`, `useChatSession.ts`, `useServerEvents.ts`) | `pipeline.ts` / `tools.ts` complete and frozen in P10-0b; one owner per file in P10-A |
| Count pins (routes 109, modules 30, events 15, settings 28, notices 8, tables 20, `AGENT_TOOL_NAMES`, the mock listing, builtin tools, `EXAMPLE_IDS`) | listed by C28 / C30 / C32 / W10.7 in their reports; accepted at the audit |
| A cached mock listing hides the new mocks | `.tmp/e2e` moved aside before every gate |
| A probe mutates the seed project | the copy-roots rule (copy + SQL-repoint `projects.path`) |
| CI e2e time (about 165 tests) | watch the 30-minute job budget |
| Wave size (12 + 4 skeleton agents) | the first cuts listed in P10-A; W10.15 / W10.16 fix-ups |
