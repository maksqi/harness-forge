# Phase 9 — v1.5: Agent 2.0

Part of the harness-forge build plan. Progress is tracked in `docs/ROADMAP.md` (coordinator only). Shared names come
from `docs/DECISIONS.md` (ADR-040 … ADR-043, the amendment notes on ADR-023, ADR-032, ADR-036 and ADR-038, and the
contract seed; it wins on conflict); endpoints and DTOs from `docs/API.md` (the queue routes 4.24 and the project file
routes 4.25, the agent tool schemas, the data parts `data-compaction` / `data-steer` / `data-activity`, preliminary tool
outputs, the `queue.changed` event and `run.started.origin`, the five settings, `ChatStopResult.dropped`, the route key
index); components, props, store and composable signatures, shortcuts and test ids from `docs/UI.md` (the 2.16
wireframes, 7.24 compaction, 7.25 plan mode and todos, 7.26 mentions, queue and steering, 7.27 sub-agents, 9.11 agent
settings, 10.6, 11.6, 12, 13.10, 14, 15 and the amended 7.1 – 7.3, 7.6 – 7.8, 7.11, 7.12, 7.15); flows, tables and
security rules from `docs/ARCHITECTURE.md` (5, the new 6.18 compaction, 6.19 plan mode and todos, 6.20 steer queue, 6.21
file mentions, 6.22 sub-agents, 8, 10, 12); plugin API 1.3.0, `core-agent` and async-generator tools from
`docs/PLUGINS.md`; the five mock models from `docs/PROVIDERS.md` (9, the probe contract); the user guide
`docs/guides/agent-features.md`. The new UI.md, ARCHITECTURE.md, PLUGINS.md and PROVIDERS.md sections and the guide are
written by D11 in P9-0a, API.md by C22.

**Status (2026-10-03):** P9-00 is done (design inputs in `.tmp/p9-designs`, CI on `316319a` green, advisories
re-checked, memory updated, baseline 8327 tests). P9-0a is in progress: K1 is done (ADR-040 … ADR-043, the contract
seed, the ROADMAP section and the AGENT.md facts, committed at Gate P9-0a); C22, C23, D10 (this file) and D11 run in one
launch; the K3 v1.4 upgrade seed is built in the background. "Deviations from the plan" holds the binding changes to the
plan sections below, the design-report items the plan replaced and the open points decided while writing this file;
"Deviations found while building" is filled in per wave from the agent reports and the gates; "Outcome" at the end of
this file is completed by the coordinator at the final gate.

Paths: `S` = `apps/server/src`, `W` = `apps/web/app`, `SH` = `packages/shared/src`.

## Goal

Ship v1.5: Agent 2.0 (Claude Code parity for long agent runs), plus a stabilization track.

- **Context compaction** (ADR-040): `/compact [focus]` (a reserved harness command run by the server) and automatic
  compaction replace older context with a model-written summary, stored as a `data-compaction` part on the message
  path. For the model, the latest marker on the path replaces everything before it (positional, so it survives chat
  import id remapping; `keep: last-user` keeps the turn's user message). Automatic compaction runs before every model
  call (`prepareStep`, step 0 included) once the estimate passes 80 % of the context window, so long agent runs compact
  in place. Stored messages are never rewritten and stay visible (dimmed); a branch above a marker ignores it; a
  failed or disabled compaction falls back to today's trimming (notice `compaction-failed` / `context-trimmed`).
- **Plan mode and todos** (ADR-041, amends ADR-032): the fifth permission mode `plan` is read-only (tools with
  workspace access `write` / `execute` are not offered); the agent calls `exit_plan_mode` with a markdown plan, which
  the user approves (switching to Accept edits or Ask; the run continues) or rejects with feedback; `todo_write`
  replaces the agent's todo list, and the latest call on the active path is the todo state (no table). Shift+Tab in the
  composer cycles Ask → Accept edits → Plan (setting `shiftTabModes`). Plan mode is enforced on the server.
- **Steer queue and file mentions** (ADR-042): a message sent while a run is active joins an in-memory per-chat queue
  (`/chat/:id/queue`, SSE `queue.changed`); at the next step boundary the run takes every queued message and the model
  sees it as a user message (stored as `data-steer` inside the running reply); a message still queued when the run
  completes becomes the next turn, started by the server. `@` in the composer of a project chat searches the project's
  files (`GET /projects/:id/files`) and attaches the picked file as an upload snapshot
  (`POST /projects/:id/files/attach`); the chat request body is unchanged.
- **Sub-agents** (ADR-043, amends ADR-036): the `task` tool (builtin plugin `core-agent`, policy `safe`) runs a child
  agent loop with its own context (types `explore` = read-only, `general`); a child only gets the tools that would run
  without approval in the parent's mode and its approval function turns any request for approval into a denial (no
  approval card ever comes from a child); depth 1; at most 3 children at once (20 per run), `subagentMaxSteps` (30) and
  a 570 s deadline each; progress streams as preliminary tool output (plugin API 1.3.0: an async-generator `execute`);
  only the final report reaches the parent model; child writes are journaled under the parent assistant message.
- **Stabilization** (Phase 8 follow-ups): unique shell rules (migration `0006_shell_rule_unique`, 409 `exists` from the
  index), the effective tool override in `GET /tools` and "Decided per call" in the Plugins tools table, one
  `NO_PROJECT_MESSAGE` and one chat lookup, the changes sheet keeping its open state below 1024 px, full-frame README
  screenshots, the audit advisories re-checked.

Out of scope (ROADMAP backlog): a steer queue that survives a server restart, nested sub-agents, user-defined agent
types and background agents, plan files saved to the project, micro-compaction of single large tool outputs, `@`
mentions of symbols and URLs, a provider `context_overflow` retry after compaction, the live suite for compaction, plan
mode and sub-agents with real models, the `.gitignore` ReDoS heuristic of the workspace walker (`find_files`,
`search_files`, the `@` file index) on the main thread, and every Phase 8 backlog item (OS-level sandboxing of the
shell, the shell on Windows, a terminal pane, stage / commit, multi-user accounts, …). Kept as documented behavior: the
queue is lost on a restart; the nested trace of a stopped sub-agent is lost after a reload; share pages never show
compaction summaries; a queued server command (incl. `/compact`) is never steered.

Totals after Phase 9: routes 95 → **100** (`chatQueue.list`, `chatQueue.add`, `chatQueue.remove`,
`projectFiles.search`, `projectFiles.attach`; none needs fresh auth), route modules 25 → **27** (`chatQueue` 3,
`projectFiles` 2), tables **18** (unchanged), migration **`0006_shell_rule_unique`** (one DELETE of duplicate rules, one
UPDATE of `tool_prefs`, two partial unique indexes; no table, no rebuild), SSE types 12 → **13** (`queue.changed`;
`run.started` gains `origin?` and `userMessageId?`), settings keys 21 → **26** (`autoCompact`, `compactModelRef`,
`subagentModelRef`, `subagentMaxSteps`, `shiftTabModes`; `defaultToolMode` accepts `plan`), notice codes 6 → **7**
(`compaction-failed`), error codes **16** (unchanged; conflict reasons + `run-idle`, `queue-full`), UI data part types
1 → **4** (`notice`, `compaction`, `steer`, the transient `activity`), `ToolMode` 4 → **5** (`plan`), usage purposes +
`compact`, `subagent` (type-only), builtin plugin **`core-agent`** (`todo_write`, `exit_plan_mode`, `task`), harness
command `/compact`, plugin API **1.3.0** (additive), ADR-040 … ADR-043, mock models `mock:compact`, `mock:plan`,
`mock:todo`, `mock:subagent`, `mock:steer` (five more in the mock listing), 32 new test ids (UI.md 13.10), no new
environment variable and no new id prefix. Agents: 4 (P9-0a: C22, C23, D10, D11) + 4 (P9-0b: C24, C25, C26, C27) + 12
(P9-A: W9.1 – W9.12) + 2 (P9-B: W9.13, W9.14; W9.15 / W9.16 only for red P9-A gate items), in the Phase 5 wave method
(ADR-016).

## Entry criteria

- v1.4 is on `main` and pushed (`origin/main` = `316319a`, `chore: final gate for harness-forge v1.4`; the CI and Audit
  runs are green): `pnpm check` (8327 tests), `pnpm build` and e2e 96 passed (`chromium` + `mobile` + `tablet`).
- The approved plan and the design inputs exist in `.tmp/p9-designs/` (`plan.md`, `server.md`, `web.md`, `process.md`,
  `explore-{server,web,contracts}.md`, `agent-rules.md`; the reconciliation in `plan.md` and `README.md` is binding and
  wins over the reports).
- K1 is done: DECISIONS.md carries ADR-040 … ADR-043, the amendment notes and the Phase 9 contract seed (ids, the
  plugin API note, enumerations, conflict reasons, the HTTP table with `chat-queue.ts` / `project-files.ts`, events,
  the chat request note, the data parts, settings, migration `0006`, the mock models); ROADMAP.md has the Phase 9
  section and the updated backlog; AGENT.md has the plugin API 1.3.0 and Agent 2.0 facts and the Phase 9 freeze
  additions.

## Exit criteria

- Every Phase 9 item in `docs/ROADMAP.md` is checked; every wave gate is green; the final checkpoint commit
  `chore: final gate for harness-forge v1.5` exists (pushed only when the user asks).
- `pnpm check` and `pnpm build` are green; the built-page CSP test passes with `HF_TEST_REQUIRE_WEB_BUILD=1`.
- `pnpm test:e2e` (projects `chromium` + `mobile` + `tablet`, OS color scheme emulated as light) is green 3× in a row,
  including the new specs `core/compaction`, `core/plan-mode`, `core/todos`, `core/subagents`, `core/mentions`,
  `core/steer-queue`, `mobile/agent`, the extended `share`, `keyboard`, `settings`, `mobile/changes` and tablet
  touch-target specs; the `@screenshots` run (dark + light) was reviewed; the README images come from the `@readme`
  full-frame shots.
- The gate probes (Gate P9-A, repeated at the final gate on a fresh `.tmp/e2e`) and the P8-A probe regression
  (`node .tmp/gates/P8-A/probe.mjs ws git`) are green.
- CI on `main` is green (`check`, `e2e`, `docker`, `audit`, `actionlint`); the advisory decision is recorded.
- A v1.4 data directory boots on v1.5 with every chat, secret, share, project and rule intact: migration `0006` applied
  (exact duplicate rules removed, the oldest kept; a stored `allow` on `shell` cleared, other overrides kept), old tool
  parts and the rewind preview unchanged, the queue empty, old chats keep their `toolMode`, the long seeded chat
  compacts on its first `mock:compact` turn and continues, plan mode, the queue and sub-agents work on the old project.
- The Docker image boots on a copy of the v1.4 seed; `/compact`, a `mock:subagent` run in `/data/workspaces` and a queue
  round trip work there (daemon permitting, else the CI `docker` job).
- `pnpm test` never calls a paid API, never touches the repository's `data/` or a folder outside a temp directory, and
  leaves `git status --porcelain` of the repository unchanged; `pnpm test:live` stays the user's.
- README status reads "v1.5".

Manual acceptance (coordinator, `HF_MOCK_PROVIDER=1 pnpm dev`):

- A project chat → Shift+Tab to Plan (the polite announcement "Permission mode: Plan") → `mock:plan` shows the plan
  card → "Approve, accept edits" → `notes.txt` is written without another card and appears in the changes panel.
- `mock:todo` → the todo strip goes 1/3 → 3/3 and hides after the run; the `todo_write` row reads "3/3".
- `mock:subagent` → two live task blocks; expanding one shows its steps and its report.
- `mock:steer` with `steps 5` → typing while it runs queues the message; the steer note appears mid-reply and the final
  text lists it; a message queued during the last step starts the next turn by itself.
- `@che` in a project chat → `checkpoint.txt` in the menu → Enter → the `@checkpoint.txt` text and a project chip.
- `/compact` → the divider "Conversation compacted" with "Show summary"; the older rows are dimmed.
- Settings → General → Agent: the four fields and the Shift+Tab switch persist after a reload.
- Mobile (390 px): the dock (todo strip + queued messages + composer) fits; the plan buttons stack.
- A v1.4 data directory boots on v1.5 with every chat, secret, share, project and rule intact (duplicates removed).

With real keys (the user, optional): plan → implement a small change in a project; `/compact` on a long chat; a
sub-agent exploration.

## Steps

| Step | Owner | Output |
|---|---|---|
| P9-00 | coordinator | design reports → `.tmp/p9-designs` (+ README reconciliation, `agent-rules.md`); CI on `316319a` green; advisory re-check; memory (v1.4 pushed, Phase 9 plan); baseline `pnpm check` 8327; the `backup/pre-trailer-rewrite` branch only with the user's approval |
| P9-0a | coordinator (K1, K2, K3 seed) + C22, C23, D10, D11 | decisions, ROADMAP, AGENT.md; every shared contract + plugin SDK 1.3.0 + 501 stubs + API.md; the agent-state and mention helpers (complete); this file; every other doc; the v1.4 upgrade seed |
| Gate P9-0a | coordinator | audit, frozen install, check, build, CSP test, `pluginApiVersion` 1.3.0, 5 new routes mounted, e2e regression, `pnpm why typescript`, commit |
| P9-0b | coordinator (K3) + C24, C25, C26, C27 | schema + migration `0006`, server skeleton, web skeleton, chat seams, `core-agent` skeleton + the five mock models (complete), FREEZE |
| Gate P9-0b | coordinator | audit, `nuxi prepare`, check, build, CSP test, e2e regression on a fresh `.tmp/e2e`, v1.4 upgrade probe, seam no-op probe, FREEZE, commit |
| P9-A | W9.1 – W9.12 (one launch) | features + stabilization |
| Gate P9-A | coordinator | CCR batch, `nuxi prepare`, check, build, CSP, probes + P8-A regression, e2e, screenshots, audit, commit |
| P9-B | W9.13, W9.14 (+ W9.15 / W9.16 when the P9-A gate is red) | feature e2e, docs reconciliation |
| Final gate | coordinator | e2e ×3, v1.4 → v1.5 upgrade, Docker, audit, ROADMAP, memory, commit |

## Deviations from the plan (binding)

None yet. The coordinator records here every binding change to the plan sections below, with the gate that decided
it; the agents build against the plan sections of this file plus this list.

The three design reports (`.tmp/p9-designs/{server,web,process}.md`) are superseded where `plan.md` (its
"Reconciliation" table) and `.tmp/p9-designs/README.md` disagree with them. The replaced report items, for agents who
read the reports for depth:

- **web.md**: the queue routes are `/chat/:id/queue` (not `/chats/:id/queue`); the `POST` body is `{ message, modelRef,
  reasoningEffort, toolMode }` (not `{ id, text, fileIds, … }`); an idle chat answers 409 `run-idle` (not `no-run`); a
  `DELETE` after delivery answers 404 (not 409 `delivered`); the compaction data has no `state`, `through`, `variant`
  or `kind` (it is positional: use `findCompaction` / `compactionMarkers`; progress is the transient `data-activity`,
  failure the notice `compaction-failed`); the steer data is `{ id, parts, queuedAt, deliveredAt }`; the setting is
  `compactModelRef` (not `compactionModelRef`; the test id stays `settings-compaction-model`); the `task` input field
  is `type` (not `agent`) and its output is the server shape (`status: queued | running | completed | failed |
  aborted | limit`, `steps` with `toolCallId` / `toolName` / `summary` / `state` / `resultPreview?`, `stepsOmitted`,
  `report`); the mention search answers `{ items: { path, kind }[], truncated, indexedAt }` and the attach cap is
  5 MiB; share pages need no `sharePartSchema` change (steers become user share messages, compaction parts are
  dropped); the store is `W/stores/chat-queue.ts` (`useChatQueueStore`, not `message-queue`); the web report's agent
  letters (W9.A – W9.E) are replaced by W9.8 – W9.12.
- **server.md**: settings add `shiftTabModes` (26 keys, not 25); migration `0006_shell_rule_unique` exists
  (stabilization; "no migration" is replaced); `S/chat/steps.ts` is complete in P9-0b (C26), not a coordinator stub;
  `findCompaction`, `splitSteers` and `latestTodos` live in `SH/util/agent-state.ts` (C23), not `SH/util/todos.ts`; the
  SSE event is `queue.changed` (not `chat.queue`); the agent split is the plan's P9-A table (its W9.1 – W9.6 are
  replaced).
- **process.md**: the queue routes are under `/chat/:id/queue` (module `chatQueue`, not `/chats/…`); four skeleton
  agents (C24 server skeleton, C25 web skeleton, C26 chat seams, C27 `core-agent` + mocks; not three); the seam file is
  `S/chat/steps.ts` (not `step-hooks.ts`) and the queue lives in `S/chat/queue.ts` behind `ChatRunner` (no
  `S/services/chat-queue/`, no `S/agents/`); no `mock_wait` tool (`mock:steer` uses `current_time` with `stepDelayMs`);
  the usage purpose is `compact` (not `compaction`); the helper names are `findCompaction`, `compactionMarkers`,
  `splitSteers`, `latestTodos`, `mentionTokenAt`, `formatMention`, `scorePath`, `rankPaths` (not `compactionCut`,
  `modelVisiblePath`, `currentTodos`, `planState`, `parseMentions`); `mock:plan` writes `notes.txt` (not
  `plan-result.txt`); the optional live-test agent W9.17 is not planned (the live suite stays in the backlog).

Plan-level decisions (from the reports, kept by the plan):

- **Agent tools are a builtin plugin** (`core-agent`, like `core-workspace`): listed in the Tools tab, disabled per
  tool, with prefs and hooks; server internals reach them through the private side channel `S/chat/agent-scope.ts`
  (a WeakMap like `S/workspace/run-scope.ts`); server code recognizes them by `pluginId === 'core-agent'`. Rejected: a
  public `ToolCallContext.agent` in the plugin API (it would expose the sub-agent runner to third-party plugins).
- **One step-boundary composer** (`S/chat/steps.ts`, fixed order: context guard → steer → sub-agent finalize nudge),
  so three features share `prepareStep` without editing one hot function.
- **Positional compaction** (no `keptMessageId`, no `through`): import replaces message ids, a positional rule
  survives that and is branch-aware for free.
- **Steers are split UI messages**, not `convertDataPart` output (that keeps a data part in the same message role, so a
  steer could never become a user message).
- **The queue lives on the server**, in memory: `useChat` never sends a second `POST /chat` during a run; a server
  restart kills runs anyway.
- **Mentions are attachments**: the chat request body is unchanged; the text keeps `@path` so the model sees the path.
- **Sub-agents never ask**: a child's tool set and approval come from the parent's mode, with `user-approval` mapped
  to a denial; no nested approval UI.
- **No new table**: compaction and steers are message parts, the queue and the file index are in memory, todos and the
  plan state are derived from history. The only migration is the stabilization `0006`.
- **Docs** are written by D10 / D11 and C22 (API.md) in P9-0a and reconciled by W9.14 in P9-B; P9-A agents never edit
  docs. **Feature e2e specs** are written in P9-B by W9.13. **Every new web test id** is added by C25 in P9-0b, copied
  verbatim from UI.md 13.10; `W/utils/testids.ts` is frozen during P9-A.

Open points decided by D10 while writing this file (confirmed by the coordinator at Gate P9-0a; point 9 uses the UI.md
name `activity`):

1. **`RunContext` lives in `S/chat/pipeline.ts`**, not in `S/chat/types.ts`: C24 adds only the `ChatRunner` queue
   members to `types.ts`; `RunContext.onReleased(ending, awaitingApproval)` is C26's (in `pipeline.ts`).
2. **Stop and shutdown**: `POST /chat/:id/stop` clears the chat's queue first (reason `stopped`, the removed items
   become `dropped`), then stops the run; `ChatRunner.stopAll()` clears every queue before it aborts the runs (children
   abort through their parent's signal). `stopDeps` = data (sweep) → runs (queues → children → runs) → project file
   index → checkpoints → plugins → MCP → catalog → events. C24 fixes the member names and reports them.
3. **`stepInjector` and `RunSession.inject` are complete in P9-0b** (C26): both W9.1 (in-run compaction markers) and
   W9.2 (steers) inject at step boundaries, so neither may depend on the other's wave work. W9.2 owns `steer.ts` in P9-A
   and keeps the injector's signature.
4. **The old step-0 trim** (`pipeline.ts:636-638`) stays where it is in P9-0b (unchanged behavior); W9.1 moves it into
   the context guard.
5. **`applyCompaction(history)` returns `{ messages, summaryText }`** (`summaryText` null without a marker); the frozen
   `S/chat/model-history.ts` merges `summaryText` as the first part of the following user message (or a standalone user
   message when the first remaining message is not a user message). The summary wording is W9.1's
   (`compactionSummaryText`).
6. **`checkPlanApprovalMode` lives in `S/chat/modes.ts`** (W9.3), called from `prepare.ts` (W9.1's file) by the C26
   wiring, so W9.3 never edits `prepare.ts`.
7. **`GET /commands` lists `/compact`** with `pluginId: 'core-agent'` (`CommandSummary.pluginId` is required); C26 owns
   `S/http/routes/commands{,.test}.ts` in P9-0b for it.
8. **Plan feedback is capped at `LIMITS.approvalReasonMaxChars` (2000)**, not 4000 (the plan's web text): it is sent as
   the approval `reason`, which the server accepts up to 2000 characters.
9. **The session also exposes `activity: Readonly<Ref<'compacting' | null>>`** (driven by the transient `data-activity`
   in `onData`; UI.md 11.6), passed as the optional prop `activity` through `ChatView` → `ChatTranscript` → `ChatMessage` (the
   "Compacting conversation…" shimmer of W9.11 needs it); C25 adds it with the other session and prop additions.
10. **`mock:todo` states**: all three pending → the first completed, the second in progress, the third pending → all
    completed, with `stepDelayMs` 400 (the e2e strip goes 1/3 → 3/3 visibly; probe 3 sees all completed); the keyword
    `invalid` sends one list with duplicate ids first (PROVIDERS.md 8 is authoritative; probe 3's "an invalid list → an error part, the run continues"
    needs a mock that sends one).
11. **The `mock:compact` `seen?` reporter ignores `MOCK-SUMMARY:` lines** of the prompt (the merged summary carries
    `sentinels=OLD-1`, which would otherwise always be "seen").
12. **The attach size copy reads "Files can be up to 5 MB."** (the web report's 20 MB is the upload limit; the attach
    cap is 5 MiB).
13. **Web-only mention helpers** that neither parse nor rank (inserting the picked entry, highlight segments from
    `scorePath` ranges) live in `W/components/chat/composer/mention-menu.ts` (W9.8).
14. **Ownership additions**: C27 also owns `S/builtin-plugins/index.test.ts` (the builtin plugin count pin); W9.6 also
    owns `S/testing/fake-project-files*`. `S/chat/{scope,files,generated-files,images,errors,tool-history,testing}*`
    have no P9-A owner: a needed change is a CCR, and new test helpers go into the agent's own files.
15. **A failed manual `/compact`** ends its reply as failed (the error in the metadata, no marker, no trimming); only
    the automatic guard falls back to trimming.
16. **In `plan` mode** `todo_write` and `task` are offered (a `task` child is then read-only); tools without a workspace
    access level (MCP, third-party plugins) keep their policy and ask like in `ask` (plan behaves as `ask` for every
    tool it offers).
17. **The divider has no `data-state`** (the compaction data has no state); `compaction-divider` carries `data-kind`
    (`manual | auto`), `data-variant` (`history | run`) and `data-count` (messages compacted).
18. **Slots**: P9-0a C22 k2, C23 k3, D10 k1 (D11 runs no server); P9-0b C24 k3, C25 k4, C26 k5, C27 k6; P9-A W9.1 –
    W9.7 k1 – k7 (web agents run no server); W9.13 e2e 8891.

### Deviations found while building (P9-0a – P9-B)

Recorded by the coordinator from the agent reports (`.tmp/waves/P9-*-notes.md`) and the gates; the code and the
reconciled docs (W9.14) follow these, not the task text further down.

- **P9-0a (C22, C23, D10, D11)**:
  - Timestamps of the new DTOs (`createdAt`, `queuedAt`, `deliveredAt`, `indexedAt`, the task `startedAt` /
    `finishedAt`) are epoch ms (`timestampSchema`, API.md 1), not ISO strings (C22 CCR, accepted).
  - Route keys are `chatQueue.list` / `chatQueue.add` / `chatQueue.remove` and `projectFiles.search` /
    `projectFiles.attach`.
  - `core-agent` is not yet in `BUILTIN_PLUGIN_IDS` (`builtin-plugins/index.test.ts` pins the list against the
    registered plugins): C27 adds it together with the plugin; C27 therefore also owns `SH/ids.ts` and `SH/ids.test.ts`
    for that one change.
  - `LIMITS.mentionQueryMaxChars` = 256 (equal to `MENTION_QUERY_MAX_CHARS` of `SH/util/mentions.ts`, pinned by a
    test) bounds `GET /projects/:id/files?q`.
  - `messageUsageSchema` moved to `SH/schemas/usage.ts` (import cycle); `SH/chat.ts` re-exports it.
  - The widened `ToolDefinition.execute` return type (`… | AsyncIterable<O>`) needs a cast in tests that `await
    tool.execute(…)`: `promiseTool()` in `S/builtin-plugins/core-workspace/test-helpers.ts`.
  - C23's helpers also export `compactionCutoff`, `countTodos`, `isContentPart`, `isMentionablePath`,
    `NON_CONTENT_PART_TYPES`, `COMPACTION_PART_TYPE`, `STEER_PART_TYPE`, `TODO_WRITE_PART_TYPE`,
    `MENTION_QUERY_MAX_CHARS`; markers, steers and todo calls only count in assistant messages; `formatMention`
    returns null for an empty path or one with `"` or a line break.
  - **UI.md 10.6 / 11.6 win** for component props, emits, exposes and composable / store signatures (D11 added
    `QueuedMessages.cancelling`, `PlanApprovalCard.disabled`, `PlanBody.feedback`, `cancelQueued(id):
    Promise<'cancelled' | 'gone'>`, the session `activity`); **PROVIDERS.md 8 ("Agent mocks (Phase 9)") wins** for
    mock behavior (step delays: `mock:todo` / `mock:steer` 400 ms, sub-agent child steps 300 ms; parallel call ids
    `mock_call_<n>_<i>`; the summarizer prompt's `Focus:` line; `mock:todo`'s `invalid` keyword).
- **P9-0b (K3, C24, C25, C26, C27)**: recorded at Gate P9-0b.
- **P9-A (W9.1 – W9.12)**: recorded at Gate P9-A.
- **P9-B (W9.13, W9.14) and the final gate**: recorded by the coordinator.

## Rules for every Phase 9 agent

This section is the canonical copy of the agent rules (`.tmp/p9-designs/agent-rules.md` was its draft). The Phase 8
rules apply, renamed; the Phase 9 additions follow them.

- Read `AGENT.md` fully, your section of this file (or your task prompt) and the docs it names. Paths: `S` =
  `apps/server/src`, `W` = `apps/web/app`, `SH` = `packages/shared/src`. Stay inside your OWNED globs; the FREEZE list
  in AGENT.md overrides any owned glob.
- Never run: package installs or CLIs (`pnpm add`, `drizzle-kit`, `nuxi`, `shadcn-vue`), git write commands on this
  repository, `nuxt dev` / `nuxt build` / `nuxt prepare`, servers on :3000 / :8787 / :8899 / :8896–:8898, **never
  `pnpm test:live`** (the repository `.env` may hold real keys and the suite makes paid calls), and never
  `pnpm key:rotate` / `rotate-key` against the repository's `data/` (tests use temp data directories). Existing scripts
  are allowed.
- Your own server uses your slot: `HF_PORT=879k HF_DATA_DIR=.tmp/<agent-id>`; e2e agents use `889k` (k ≠ 9) with
  `E2E_BASE_URL`. Stop every process you started (shell children included) before reporting. Prefer
  `createTestApp()` + `app.request()`.
- **Temp folders**: tests create workspaces, roots, repositories and data directories with
  `realpath(await mkdtemp(join(tmpdir(), 'hf-')))` (macOS `/var` is a link to `/private/var`, so an un-resolved path
  fails every containment check) and remove them afterwards; never the repository's `data/`, `.tmp/e2e` or a real
  project folder.
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
- **Every path a workspace tool or a mention touches** resolves through the frozen `resolveWorkspacePath`
  (`S/workspace/paths.ts`) and the sensitive-path rules (`S/workspace/sensitive.ts`); no `fs` call on a model-supplied
  or user-supplied path without it.
- **Checkpoint blobs and journal rows only through the checkpoint store** (`S/services/checkpoints/**`); sub-agent
  writes go through the same `journaledWrite` under the parent's run scope.
- Every new text or JSON column goes into `REFERENCE_SOURCES` or `UNSCANNED_COLUMNS` (`S/services/data/references.ts`;
  Phase 9 adds no column).
- The shell command matcher (`SH/util/shell-command.ts`) fails closed: anything it cannot tokenize asks.
- **Logging**: never log key material, secret values, file contents, diffs, tool inputs or outputs, or shell commands
  at `info`; Phase 9 adds: never log compaction summaries, steer / todo / plan texts, sub-agent prompts or outputs,
  mention queries or the paths they return at `info` (`debug` only, redacted).
- Timers are `unref()`-ed and cleared in `stop()`; tests use fake timers (no real sleep over 2 s).
- Contracts: DTOs and route keys only from `@harness-forge/shared`, plugin shapes only from
  `@harness-forge/plugin-sdk`; server services only through the frozen `types.ts` interfaces. A missing member, a
  contract change, a frozen-file edit or a **new test id** is a CCR in your report (file, current shape, proposed shape,
  reason) plus a local adapter so you can keep working.
- New components are imported explicitly by path (`import TaskBlock from './agent/TaskBlock.vue'`): the coordinator
  runs `nuxi prepare` only at the gates, so auto-import types do not know files created mid-wave.
- The props, emits and root test ids of the P9-0b stub components and the signatures of the new store, composables and
  `useChatSession` additions are frozen after P9-0b: implement behind them; a change is a CCR.
- No doc edits in P9-A: write "For W9.14" notes (facts, deviations, suspected doc errors) into your report.
- Web unit tests: Nuxt composables come through a local `nuxt-imports.ts` that tests `vi.mock`; every password prompt
  goes through `useFreshAuth()` (UI.md 8.4).
- e2e uses only `.tmp/e2e/workspaces/*` for project folders.
- Verify before reporting — server: `pnpm -F @harness-forge/server test` · `pnpm typecheck`; shared:
  `pnpm -F @harness-forge/shared test`; plugin SDK: `pnpm -F @harness-forge/plugin-sdk test`; web:
  `pnpm -F @harness-forge/web test` · `pnpm -F @harness-forge/web typecheck:fast`; all: `pnpm check:english`; lint
  your files with `pnpm exec eslint --fix <your files>`.
- Report ≤ 300 words in the AGENT.md format (tasks, files, commands + results, CCRs, dependency requests, open issues,
  suggested ROADMAP updates). Commits are made only by the coordinator; never add AI attribution anywhere.

Phase 9 additions:

- **Only mock models** in tests (`MockLanguageModelV4`, `simulateReadableStream` from `ai/test`, the `mock:*` provider);
  compaction and sub-agent code never resolves a real provider (or a key from the environment) in tests. Never
  `pnpm test:live`.
- **Verify AI SDK names** in `node_modules/.pnpm/ai@7.0.127_zod@4.6.5/node_modules/ai/dist/index.d.ts` (and
  `@ai-sdk/provider-utils` `dist/index.d.ts`) before use: the `prepareStep` result fields (`messages`, `activeTools`,
  `instructions`), async-generator `execute` (preliminary outputs: the last yield is re-emitted as the final output),
  the `convertToModelMessages` options (`ignoreIncompleteToolCalls` drops still-preliminary parts), the
  `UIMessageStreamWriter`, transient data chunks (reach only `onData`) and data chunks with a known id (replace the part
  in place).
- **History-derived state** (`findCompaction`, `compactionMarkers`, `splitSteers`, `latestTodos`) only from
  `SH/util/agent-state.ts`; mention parsing / ranking (`mentionTokenAt`, `formatMention`, `scorePath`, `rankPaths`) only
  from `SH/util/mentions.ts`; no local re-implementation on the server or the web.
- **Plan mode is enforced on the server** (tool set + approval), never only in the UI.
- **Sub-agents never create approval requests**: a tool that would ask is not offered or is denied; depth 1; a test
  proves `task` is absent from the child tool set.
- **In-memory state** (the queue, the sub-agent semaphores, the file index cache) is keyed by chat / project, bounded,
  cleared on chat delete, Stop, key rotation and shutdown; timers `unref()`.
- **Each new part has listed consumers** (model history, search text, Markdown export, import, share sanitizer,
  `chat-format`), each covered by its owner's test: `data-compaction` → W9.1 (model history), W9.7 (export, import,
  share drop), W9.11 (`chat-format`, divider); `data-steer` → W9.2 (model history), W9.7 (search text, export, import,
  share split), W9.11; `data-activity` → transient only (W9.1 writes it, W9.9 reads it in `onData`).
- **Mention paths** resolve through `resolveWorkspacePath` and the sensitive-path rules; the index reuses
  `S/workspace/walk.ts` (no new `.gitignore` parser, no new regex path).
- **Feature agents implement behind the P9-0b seams** (`S/chat/steps.ts`, `S/chat/model-history.ts`,
  `S/chat/agent-scope.ts`, `S/chat/markers.ts` and the stub modules); the mock models are frozen and PROVIDERS.md 8 ("Agent mocks (Phase 9)") is
  the probe contract.
- **Hot files have one owner per wave** (`pipeline.ts`, `prepare.ts` → W9.1; `runs.ts`, `index.ts` → W9.2;
  `approval.ts` → W9.3; `params.ts` → W9.4; `tools.ts`, `history.ts` → W9.5; `ChatComposer.vue` → W9.8;
  `useChatSession.ts`, `useServerEvents.ts`, `ChatView.vue` → W9.9; `ToolPart.vue` → W9.10; `ChatTranscript.vue`,
  `ChatMessage.vue`, `chat-format.ts` → W9.11).

## FREEZE in Phase 9

In force since earlier phases (AGENT.md): `packages/*/src`, `S/app.ts`, `S/db/schema.ts`, `apps/server/drizzle/**`,
every `*/types.ts` under `S`, `S/builtin-plugins/index.ts`, `W/layouts/**`, store signatures in `W/stores/**`,
`apps/web/nuxt.config.ts`, every `package.json` and config file, `W/components/{ui,ai-elements}/**`, the CSS design
tokens in `W/assets/css/main.css`, `W/utils/testids.ts` (Phase 5), the Phase 5 – 8 additions (the services `types.ts`
files, `S/workspace/{paths,run-scope,file-lock,git}.ts`, `S/services/chats/approvals.ts`, the `main.ts` boot hooks,
`SH/util/shell-command.ts`, the props of the P6-0b, P7-0b and P8-0b stub components, `DiffView` props, the `projects`,
`workspace` and `shell-rules` stores, `useChangesPanel`, the `useChatSession` additions of Phases 7 and 8, the mock
models of Phases 6 – 8).

P9-0a and P9-0b open the frozen files **only** for their named owners:

- P9-0a: K1 — `AGENT.md`, `docs/DECISIONS.md`, `docs/ROADMAP.md`; C22 — `SH/**` (not `util/{agent-state,mentions}*`),
  `packages/plugin-sdk/src/**`, `S/app.ts`, `S/plugins/templates/sdk-types.ts`; C23 —
  `SH/util/{agent-state,mentions}{,.test}.ts` (new, complete).
- P9-0b: K3 — `S/db/schema.ts` (the two partial unique indexes, `UsagePurpose` + `compact` / `subagent`) +
  `apps/server/drizzle/**`; C24 — `S/types.ts`, `S/deps.ts` (factory and the stop order), `S/env.ts` (compile fixes
  only), `S/chat/types.ts` (the `ChatRunner` queue members), `S/services/project-files/types.ts` (new); C26 — nothing
  frozen (its new `S/chat/{steps,markers,model-history,agent-scope}.ts` and the stub signatures are frozen after the
  gate); C27 — `S/builtin-plugins/index.ts` (registers `core-agent`), the mock models (`S/builtin-plugins/mock/**`); C25
  — `W/utils/testids.ts`, the store signature of `W/stores/chat-queue.ts` (new), the approval payload of `ToolPart` /
  `ChatMessage` / `ChatTranscript` (`planMode?`, `reason?`), the prop-only additions (`ChatMessage.compacted` /
  `activity`, `ChatTranscript.activity`), the `useChatSession` interface additions.

Added to the freeze after Gate P9-0b:

- `S/services/project-files/types.ts` (new) and the P9-0b versions of `S/types.ts` (`AppServices.projectFiles`),
  `S/chat/types.ts` (the `ChatRunner` queue members) and the `S/deps.ts` stop order;
- `S/chat/{steps,markers,model-history,agent-scope}.ts` (complete, C26), the signatures of the C26 stub modules
  (`S/chat/compaction/{history,guard,stream,summarize,prompt}.ts`, `queue.ts`, `steer.ts` incl. the complete
  `stepInjector`, `modes.ts`, `subagent/{index,tools,history}.ts`), `RunSession.inject` / `addExtraCost` /
  `writeTransient` and `RunContext.onReleased`;
- `S/builtin-plugins/{index.ts,core-agent/index.ts}` (the manifest, `engines ^1.3.0`, the three tool schemas,
  descriptions, policies and model texts);
- the mock models `mock:compact`, `mock:plan`, `mock:todo`, `mock:subagent`, `mock:steer` and the `MockPlan` additions
  (`toolCalls?`, `stepDelayMs?`) (PROVIDERS.md 8 ("Agent mocks (Phase 9)"));
- `SH/util/{agent-state,mentions}.ts` (complete, C23; a behavior change after the gate is a CCR); the plugin SDK 1.3.0
  and its template mirror;
- the props, emits, exposes and root test ids of the P9-0b stub components (`CompactionDivider`, `SteerNote`,
  `TaskBlock`, `TaskBody`, `TaskStepRow`, `TodoList`, `TodoStrip`, `PlanApprovalCard`, `PlanBody`, `MentionMenu`,
  `QueuedMessages`, `AgentSettingsSection`), the prop / emit additions of `ChatMessage`, `ChatTranscript`, `ToolPart`,
  `SendStopButton`, `ComposerAddMenu` and `ChatComposerExposed.restoreQueued`;
- the `chat-queue` store (`useChatQueueStore`), the signatures of `useProjectFiles`, `useFileMentions`, `useModeCycle` /
  `nextToolMode`, `compactionLayout` and `todoState` / `todoStripVisible`;
- the `useChatSession` additions (`submit`, `queue`, `cancelQueued`, `stop(): Promise<QueueItem[]>`, `todos`,
  `activity`, `ToolApprovalDecision.planMode` / `.reason`);
- the Phase 9 test ids (UI.md 13.10) in `W/utils/testids.ts`.

No CCR is pre-approved for P9-A; the coordinator batches CCRs at Gate P9-A.

---

## Wave P9-00 — stabilization start (done)

1. **Design inputs** — the three Plan reports extracted into `.tmp/p9-designs/{server,web,process}.md` (with
   `.tmp/p8-designs/extract.mjs`, copied alongside), the exploration notes into `explore-{server,web,contracts}.md`, the
   approved plan copied to `plan.md`, the reconciliation written to `README.md`, the rules draft to `agent-rules.md`.
2. **CI** — `origin/main` = `316319a`: the CI run (check, e2e, docker, actionlint) and the Audit run are green.
3. **Stabilization triage** — the plan's section 5: `shell_rules` uniqueness (K3 `0006` + W9.7), the stale `allow` on
   `shell` (K3 + W9.7 + W9.12), `NO_PROJECT_MESSAGE` twice and the double chat lookup (W9.7), the changes sheet below
   1024 px (W9.12), the README screenshots (W9.13 `@readme` shots + the final gate); the `.gitignore` ReDoS heuristic
   stays in the backlog (the mention index reuses `S/workspace/walk.ts` unchanged).
4. **Audit advisories** — GHSA-86w9-cpqp-85rv (node-forge) and GHSA-vfj7-8cjw-p6xm (braces) re-checked with the P8-00
   decision rule (a) – (e): still no patched release → (d), both ignores stay; the backlog line carries the re-check
   date 2026-10-03.
5. **Memory** — "v1.4 pushed (`316319a`, CI green); Phase 9 = Agent 2.0; plan in `.tmp/p9-designs`". The local
   `backup/pre-trailer-rewrite` branch is deleted only after the user approves (still present).
6. **Baseline** — `pnpm check` green with 8327 tests (`.tmp/gates/P9-00/check.log`); the `316319a` worktree
   `.tmp/v14` installed and built for the K3 seed.

---

## Wave P9-0a — decisions, contracts, docs

Four agents in one launch (C22, C23, D10, D11) after K1; K2 and the K3 seed run alongside.

### Coordinator actions

- **K1 (done)** — `docs/DECISIONS.md`: ADR-040 … ADR-043, the amendment notes on ADR-023 (the compaction marker lives on
  the tree), ADR-032 (`plan` mode), ADR-036 (sub-agent writes journaled under the parent message) and ADR-038 (unique
  rules, `0006`), the contract seed (builtin plugin and tool names, plugin API 1.3.0, the harness command `/compact`,
  enumerations, conflict reasons, the HTTP module rows `chat-queue.ts` / `project-files.ts` that `routes.test.ts` reads,
  events, the chat request note, the data parts, settings, migration `0006`, the mock models). `docs/ROADMAP.md`: the
  Phase 9 section (one box per agent) and the backlog (new items: a queue that survives restarts, nested / user-defined
  / background agents, plan files saved to the project, micro-compaction, `@` mentions of symbols / URLs, the live suite
  for the new features; the ReDoS item reworded to include the `@` index). `AGENT.md`: the plugin API 1.3.0 and Agent
  2.0 facts (the verified AI SDK names, the seams) and the Phase 9 freeze additions.
- **K2** — no dependency expected: fuzzy ranking, the queue, the summarizer and the child loop are local code on the
  installed AI SDK. Any package need is a DEPENDENCY REQUEST.
- **K3 seed (background)** — `git worktree add .tmp/v14 316319a` → install + build there → seed
  `.tmp/gates/P9-0b/seed-data` with `HF_WORKSPACE_ROOTS=<repo>/.tmp/gates/P9-0b/seed-roots` (outside the data dir, so a
  copy keeps a valid project path) through `.tmp/gates/P9-0b/seed-v14.mjs` (derived from
  `.tmp/gates/P8-0b/seed-v13.mjs`; see "K3 seed contents" in P9-0b) → stop it → the SQL additions on the stopped data
  dir → copy to `.tmp/upgrade-v14` and the ids to `.tmp/upgrade-v14-ids.json` (never `.tmp/e2e`, which the gates
  migrate). Every later upgrade probe runs on a fresh copy of `.tmp/upgrade-v14`.
- Ownership file `.tmp/waves/P9-0a.json` (below).

### C22 contracts (k2)

- **Mission.** Write every shared contract of Phase 9, the plugin SDK 1.3.0, the five new routes as 501 stubs and
  `docs/API.md`, keeping `pnpm check` green.
- **Owned.** `SH/**` (not `util/{agent-state,mentions}*`), `packages/plugin-sdk/src/**`,
  `S/plugins/templates/{sdk-types.ts,templates.test.ts}`, `docs/API.md`, `S/app.ts`,
  `S/http/routes/{chat-queue,project-files}.ts` (new 501 stubs), `S/testing/api-samples.ts`,
  `S/http/routes-mounted.test.ts`, the route-table-driven security tests (`S/http/middleware/{session-auth,fresh-auth}
  .test.ts`, `S/security/{fresh-auth-routes,secret-leaks,request-guards}.test.ts`), `W/utils/testing/fixtures.ts`, and
  every fixture or count pin that needs the new required fields (listed in the report; the coordinator accepts them in
  the audit as `C22-compile-fixes`).
- **Read-only highlights.** `.tmp/p9-designs/**` (the plan's Reconciliation table and README are binding),
  `docs/DECISIONS.md`, `SH/util/{agent-state,mentions}.ts` (C23), `SH/api/routes.test.ts` and `contract.test.ts`
  (doc-coupled: API.md section 8 and the DECISIONS module table), `SH/schemas/dto.test.ts` (the settings key count),
  `SH/isomorphic.test.ts` (exported value names), `packages/plugin-sdk/src/exports.test.ts`.
- **Tasks.**
  1. **C22-T1 Enums, ids, errors, limits** — `toolModeSchema` = `off | ask | edits | plan | auto`; `todoStatusSchema`
     (`pending | in_progress | completed`), `taskTypeSchema` (`explore | general`); `HARNESS_COMMANDS = ['compact']` and
     `isHarnessCommand` next to `CLIENT_COMMANDS` (`SH/ids.ts`); `core-agent` in `BUILTIN_PLUGIN_IDS` (before `mock`);
     `conflictReasonSchema` + `run-idle`, `queue-full` (error codes stay 16); `LIMITS` Phase 9 group:
     `compactionSummaryMaxChars` 60000, `compactFocusMaxChars` 1000, `compactionsPerRunMax` 10, `todoItemsMax` 50,
     `planMaxChars` 50000, `approvalReasonMaxChars` 2000, `taskPromptMaxChars` 20000, `taskReportMaxChars` 32000,
     `taskStepsShownMax` 50, `subagentParallelMax` 3, `subagentsPerRunMax` 20, `subagentTimeoutMs` 570000,
     `queueItemsMax` 10, `queueItemBytes` 262144, `mentionResultsMax` 50, `mentionFileMaxBytes` 5 MiB,
     `mentionIndexFilesMax` 50000, `mentionIndexTtlMs` 30000. *Accept:* `ids.test.ts` (harness and client commands are
     disjoint), `errors.test.ts` (16 codes, the two reasons), enum and limit tests.
  2. **C22-T2 Chat parts** — `commandInvocationSchema.type` + `compact`; `noticeCodeSchema` + `compaction-failed` (7);
     `compactionDataSchema` (`{ trigger: manual | auto, keep: none | last-user, summary ≤ 60 000, focus? ≤ 1000, todos?,
     modelRef, messagesCompacted, tokensBefore, tokensAfter, createdAt }`, no state field), `steerDataSchema` (`{ id
     (= the queued message id), parts (text | file), queuedAt, deliveredAt }`), `activityDataSchema` (`{ kind:
     compacting | idle }`) in `harnessDataSchemas` / `HarnessDataTypes` (4 data part types). *Accept:* samples; a v1.4
     message (notice parts only) validates; a message with every new part validates through `harnessDataSchemas`
     (import and the web `dataPartSchemas` depend on it).
  3. **C22-T3 `SH/schemas/agent.ts` (new)** — `AGENT_TOOL_NAMES` (`todo_write`, `exit_plan_mode`, `task`), the todo item
     (`{ id 1–64 (unique in the list), content 1–500, status, activeForm? ≤ 200 }`), `todo_write` input (≤ 50 items) and
     output (`{ todos, counts }`), `exit_plan_mode` input (`{ plan 1–50 000 }`) and output (`{ approved: true, mode:
     edits | ask }`), `task` input (`{ description 3–80, prompt ≤ 20 000, type }`), the task step (`{ toolCallId,
     toolName, summary ≤ 200, state: running | done | error | denied, resultPreview? ≤ 300 }`) and the task output
     (`{ status: queued | running | completed | failed | aborted | limit, type, description, modelRef, steps (≤ 50),
     stepsOmitted, report ≤ 32 000, usage?, costUsd?, startedAt, finishedAt?, error? }`). *Accept:* valid and invalid
     samples (duplicate todo ids, 51 items, a 50 001-character plan, 51 steps, an over-long report); a task output at
     every cap serializes under the 64 KB tool output cap.
  4. **C22-T4 Queue** — `SH/schemas/queue.ts` (new): the queue item (`{ id, message, modelRef, reasoningEffort,
     toolMode, createdAt, turnOnly }`), the add body (strict `{ message: a user UI message with a client `msg_` id and
     text + uploaded file parts, ≤ 256 KiB serialized, modelRef, reasoningEffort, toolMode }`), the list (`{ items }`),
     the removal reason (`delivered | started | cancelled | stopped | failed`), the `queue.changed` data (`{ chatId,
     items, removed?: { id, reason, error? }[] }`); `chatQueueItemParamsSchema` (`{ id, itemId }`) in `params.ts`;
     `ChatStopResult.dropped` (the queued items the stop removed; additive, C22 fixes its optionality). *Accept:*
     samples; a 257 KiB message refused; an assistant message refused; a v1.4 stop result parses.
  5. **C22-T5 Project files** — `SH/schemas/project-files.ts` (new): the query (`{ q ≤ 200 (default ''), limit 1–50
     (default 50) }`), the entry (`{ path, kind: file | dir }`), the search result (`{ items, truncated, indexedAt }`),
     the attach body (strict `{ path }` over `workspaceToolPathSchema`); the attach answer is a `FileRef`. *Accept:*
     samples (a control character in the path refused).
  6. **C22-T6 Events** — `queue.changed` in `SERVER_EVENT_TYPES` (13); `run.started` data gains `origin?: 'request' |
     'queue'` and `userMessageId?`. *Accept:* `parseServerEvent` keeps both; the event count pin 13; a v1.4
     `run.started` parses.
  7. **C22-T7 Settings** — `autoCompact` (true), `compactModelRef` (null = the chat model), `subagentModelRef` (null =
     the chat model), `subagentMaxSteps` (1–200, default 30), `shiftTabModes` (true) → `SETTINGS_KEYS` 26;
     `defaultToolMode` accepts `plan`. None needs fresh auth. *Accept:* a v1.4 settings document parses with the
     defaults; `dto.test.ts` at 26.
  8. **C22-T8 Route table** — `ApiModule` += `chatQueue`, `projectFiles`; keys `chatQueue.list` (`GET /chat/:id/queue`),
     `chatQueue.add` (`POST /chat/:id/queue`, 201 item), `chatQueue.remove` (`DELETE /chat/:id/queue/:itemId`, 204),
     `projectFiles.search` (`GET /projects/:id/files`), `projectFiles.attach` (`POST /projects/:id/files/attach`, 201
     `FileRef`); none `fresh` → **100** routes, 27 modules; `chat.stop` response + `dropped`. The comment above the
     `projects` routes (no `GET /projects/:id`) still holds: the new paths have more segments than `/projects/browse`.
     C22 may rename the keys (reported; API.md section 8 is the index). *Accept:* `routes.test.ts` (API.md section 8
     index + the DECISIONS module table) and `contract.test.ts` at 100.
  9. **C22-T9 Plugin SDK 1.3.0** — `PLUGIN_API_VERSION` `'1.3.0'`; `ToolMode` + `plan`; `ToolDefinition.execute` may be
     an `async function*` (or return an `AsyncIterable`): every yield is a preliminary output, the last one the final
     output; the timeout covers the whole iteration (doc comments); the template mirror
     `S/plugins/templates/sdk-types.ts` follows (`templates.test.ts`: the mirror's `ToolMode` and `execute` type equal
     the SDK's); `exports.test.ts` pins. *Accept:* SDK tests; builtin manifests with `engines ^1.2.0` still load (a
     compatible minor).
  10. **C22-T10 `docs/API.md`** — the `ToolMode` and `LIMITS` rows; settings (26); notice codes (7); conflict reasons;
      the agent tool schemas (4.21); the data parts and preliminary tool outputs in the chat stream protocol (6.4: the
      `data-compaction` / `data-steer` parts, the transient `data-activity`, `output-available` with `preliminary:
      true`); `/compact` in `GET /commands`; the two modules (4.24 queue, 4.25 project files) with every answer (queue:
      201, 204, 400, 404 unknown chat or item, 409 `run-idle` / `queue-full` / `exists`, `DELETE` 404 once delivered or
      started; files: 400 for a refused path, `.git`, a secret-looking path or an unavailable folder (the
      `openWorkspace` message), 404 unknown project, 413 over 5 MiB, the upload's own type errors); `chat.stop`
      `dropped`; the events (`queue.changed`, `run.started.origin` / `userMessageId`); `PATCH /tools/exit_plan_mode {
      override: 'allow' }` → 400; the 100-route index in the parsed format.
  11. **C22-T11 Stubs and compile fixes** — `S/app.ts` mounts `chatQueue` and `projectFiles`; the five routes validate
      first (400) and answer `501 not_implemented`; `api-samples.ts`; the route-table security tests follow;
      `W/utils/testing/fixtures.ts` and every other fixture get the five settings keys. *Accept:*
      `routes-mounted.test.ts` green (no new route answers 404); `pnpm check` green; v1.4 message, settings and shell
      output samples still parse.
- **Tests.** Schema tests for every new DTO; route-table tests; the updated route-driven security tests.
- **Verify.** Shared, plugin SDK, server and web commands.

### C23 pure helpers (k3)

- **Mission.** The shared helpers that derive agent state from a message path and parse / rank file mentions,
  complete and tested (frozen after Gate P9-0b; used by C25, C26 and W9.1, W9.2, W9.4, W9.6, W9.8 – W9.11).
- **Owned.** `SH/util/{agent-state,mentions}{,.test}.ts` (new; exported from `SH/index.ts` through C22, who owns the
  index file — C23 lists the export lines in its report if C22 has not added them).
- **Read-only highlights.** ADR-040 … ADR-042; the plan sections 1 – 3 and the Reconciliation table; `SH/chat.ts`
  (C22's part schemas), `SH/schemas/{agent,project-files}.ts`; `S/workspace/shell-cwd.ts` (`initialShellCwd`, the
  scanning precedent).
- **Tasks.**
  1. **C23-T1 `findCompaction(path)`** — the latest valid `data-compaction` part on the path (messages scanned last to
     first, parts last to first): `{ messageIndex, partIndex, data, keptUserIndex } | null`, where `keptUserIndex` is
     the index of the last user message before `messageIndex` when `keep` is `last-user`, else null; parts that fail
     `compactionDataSchema` are ignored. *Accept:* table tests: no marker; a manual marker alone in a `/compact` reply;
     an automatic marker at step 0 with `last-user`; an in-run marker at part p of a reply; several markers (the latest
     wins); a path without the marker (a branch above it); an invalid part.
  2. **C23-T2 `compactionMarkers(path)`** — every valid marker in path order (`{ messageIndex, partIndex, data }[]`),
     for the transcript divider layout. *Accept:* tables.
  3. **C23-T3 `splitSteers(messages)`** — every assistant message split at each `data-steer` part into assistant
     (before) / user (the steer's parts, id = the steer id) / assistant (after); empty assistant halves dropped; the
     `data-steer` parts removed; halves keep the assistant id and metadata; other messages untouched. *Accept:* tables
     (one steer, two steers, a steer first or last in the reply, the half after a steer starts with `step-start`, a
     message without steers is returned as is, no two user messages produced in a row by a split).
  4. **C23-T4 `latestTodos(path)`** — the output of the last `tool-todo_write` part in `output-available` (not
     preliminary) whose output parses, with where it was found (message index / id, tool call id), or null; errored and
     denied calls skipped; todo calls inside `task` outputs are not tool parts and are ignored. C23 fixes the exact
     return shape (report). *Accept:* tables (branch-aware: a path that ends before the last call shows the earlier
     list; an error part after a valid one keeps the valid one).
  5. **C23-T5 Mentions** — `mentionTokenAt(text, caret)` → `{ start, end, query } | null` (an `@` at the start of the
     text or after whitespace, no whitespace between it and the caret, at most 256 characters; `a@b` → null);
     `formatMention(path)` → `@path` (paths with spaces quoted); `scorePath(query, path)` → `{ score, ranges } | null`
     (case-insensitive: basename prefix > basename substring > path substring > subsequence, then shorter paths; ranges
     for highlighting); `rankPaths(query, entries, limit)` → the best entries (ties by path; an empty query keeps the
     input order). *Accept:* tables (`chk` ranks `checkpoint.txt` before `src/check/x.ts`).
  6. **C23-T6 Fuzz** — a seeded generator: no helper throws on random paths, parts and texts; ranges stay in bounds,
     sorted and non-overlapping; `mentionTokenAt(formatMention(p) …)` round-trips the path; `rankPaths` is stable.
- **Tests.** The tasks above (`agent-state.test.ts`, `mentions.test.ts`).
- **Verify.** `pnpm -F @harness-forge/shared test`; `pnpm check:english`; eslint on the four files.

### D10 phase doc (k1)

- **Mission.** Write this file so P9-0b, P9-A and P9-B agents can build against it.
- **Owned.** `docs/phases/phase-9-v1-5.md` (new).
- **Tasks.**
  1. **D10-T1 Phase doc** — goal, totals, criteria, the binding deviations and open points, the rules for every agent,
     the FREEZE list, every wave with owned globs, tasks with acceptance criteria, ownership JSON, cross-agent
     contracts, gates and probes, risks.
- **Verify.** `pnpm check:english`.

### D11 docs (no server)

- **Mission.** Update the user-facing and architecture docs for Phase 9 so P9-0b and P9-A agents can build against them.
- **Owned.** `docs/UI.md`, `docs/ARCHITECTURE.md`, `docs/PLUGINS.md`, `docs/PROVIDERS.md`, `docs/guides/**`,
  `README.md`, `.env.example`.
- **Tasks.**
  1. **D11-T1 UI.md** — the new 2.16 wireframes (divider, plan card, todo strip, task blocks, mention menu, queued
     messages and steer note; desktop and 390 px), 7.24 Compaction, 7.25 Plan mode and todos, 7.26 File mentions, queue
     and steering, 7.27 Sub-agents, 9.11 Agent settings, 10.6 contracts (props / emits / exposes of every P9-0b stub),
     11.6 modules (the `chat-queue` store, `useProjectFiles`, `useFileMentions`, `useModeCycle`, `compactionLayout`,
     `todoState`, the `useChatSession` additions), 13.10 test ids (32); amend 7.1 (part table), 7.2 (preliminary
     outputs, agent rows), 7.3 (plan card), 7.6 – 7.7 (composer while running, the queue button, placeholder, `@`,
     "Mention a file", restore after Stop), 7.8 (`/compact`, `/mode plan`), 7.11 (Plan, Shift+Tab), 7.12 (ring note),
     7.15 (share), 12 (a Shift+Tab row; Enter while running = queue; the Esc priority: the mention menu first), 14
     (focus, dock stacking, 40 px targets), 15 (sub-agent, queue, steer, compaction).
  2. **D11-T2 ARCHITECTURE.md** — 5 (stop order: queues cleared → sub-agents aborted → runs; the project file index),
     the new 6.18 compaction, 6.19 plan mode and todos, 6.20 steer queue, 6.21 file mentions, 6.22 sub-agents, 8
     (`0006_shell_rule_unique`), 10.x security notes (plan-mode enforcement, children never ask, mention path guard and
     secret refusal, the queue limits), 12 (log lines: no summaries, steer / todo / plan texts, child prompts or
     outputs, mention queries at `info`).
  3. **D11-T3 PLUGINS.md** — API 1.3.0 (the version table row, `ToolMode` `plan`, async-generator `execute` with
     preliminary outputs and the 250 ms throttle), the builtin `core-agent` (its three tools, `exit_plan_mode` always
     asks), the reserved command name `compact`. *Accept:* `manifest.test.ts` parses PLUGINS.md.
  4. **D11-T4 PROVIDERS.md 8 ("Agent mocks (Phase 9)")** — the five mock models exactly as in "C27 core-agent and mock models" below (it is the
     probe contract).
  5. **D11-T5 Guide** — `docs/guides/agent-features.md`: compaction (manual, automatic, the setting, what the model
     sees), plan mode and Shift+Tab, todos, the queue and steering (lost on restart, Stop returns messages), `@`
     mentions (snapshots, the 5 MiB cap, secret paths), sub-agents (types, no approvals inside, limits, cost).
  6. **D11-T6 README and `.env.example`** — features, the status "v1.5 in progress"; `.env.example` unchanged unless a
     variable appears (none expected).
- **Verify.** `pnpm check:english`; `pnpm -F @harness-forge/shared test` (`manifest.test.ts` parses PLUGINS.md).

### Wave P9-0a ownership

The audit cannot express "except": `SH/util/{agent-state,mentions}*` match C22's glob too (a warning; C23 owns them).
C22 lists the extra fixture files it had to touch in its report; the coordinator adds them to `C22-compile-fixes`.

```json
{
  "wave": "P9-0a",
  "agents": {
    "K1": ["AGENT.md", "docs/DECISIONS.md", "docs/ROADMAP.md"],
    "C22": [
      "packages/shared/src/**",
      "packages/plugin-sdk/src/**",
      "apps/server/src/plugins/templates/sdk-types.ts",
      "apps/server/src/plugins/templates/templates.test.ts",
      "docs/API.md",
      "apps/server/src/app.ts",
      "apps/server/src/http/routes/chat-queue.ts",
      "apps/server/src/http/routes/project-files.ts",
      "apps/server/src/testing/api-samples.ts",
      "apps/server/src/http/routes-mounted.test.ts",
      "apps/server/src/http/middleware/session-auth.test.ts",
      "apps/server/src/http/middleware/fresh-auth.test.ts",
      "apps/server/src/security/fresh-auth-routes.test.ts",
      "apps/server/src/security/secret-leaks.test.ts",
      "apps/server/src/security/request-guards.test.ts",
      "apps/web/app/utils/testing/fixtures.ts"
    ],
    "C23": [
      "packages/shared/src/util/agent-state.ts",
      "packages/shared/src/util/agent-state.test.ts",
      "packages/shared/src/util/mentions.ts",
      "packages/shared/src/util/mentions.test.ts"
    ],
    "D10": ["docs/phases/phase-9-v1-5.md"],
    "D11": ["docs/UI.md", "docs/ARCHITECTURE.md", "docs/PLUGINS.md", "docs/PROVIDERS.md", "docs/guides/**", "README.md", ".env.example"],
    "C22-compile-fixes": []
  },
  "allow": ["pnpm-lock.yaml"]
}
```

### Wave P9-0a cross-agent contracts

| Producer → consumer | Contract |
|---|---|
| C22 → C23, C24 – C27, every P9-A agent | the DTOs, enums, limits, route keys, events, settings, part schemas, agent tool schemas of `@harness-forge/shared`; the plugin SDK 1.3.0 (`ToolMode` `plan`, async-generator `execute`) |
| C23 → C25, C26, W9.1, W9.2, W9.4, W9.6, W9.8 – W9.11 | `findCompaction`, `compactionMarkers`, `splitSteers`, `latestTodos`, `mentionTokenAt`, `formatMention`, `scorePath`, `rankPaths` (complete) |
| D10 → everyone | this file (owned globs, tasks, acceptance, gates) |
| D11 → C24 – C27, every P9-A agent | UI.md 2.16, 7.24 – 7.27, 9.11, 10.6, 11.6, 12, 13.10; ARCHITECTURE.md 5, 6.18 – 6.22, 8; PLUGINS.md 1.3.0; PROVIDERS.md 8 ("Agent mocks (Phase 9)") |

### Gate P9-0a

1. `node scripts/audit-ownership.mjs .tmp/waves/P9-0a.json`
2. `pnpm install --frozen-lockfile` → `pnpm check` → `pnpm build`.
3. `HF_TEST_REQUIRE_WEB_BUILD=1 pnpm -F @harness-forge/server exec vitest run src/http/static.test.ts`.
4. `pnpm start:e2e` → `curl -sf http://127.0.0.1:8899/api/health` shows `"pluginApiVersion":"1.3.0"`; the five new
   routes are mounted (run with `bash -c`: zsh does not word-split `$r`):
   ```sh
   b=http://127.0.0.1:8899/api; c=01920000-0000-7000-8000-000000000000
   m=msg_AAAAAAAAAAAAAAAA; p=prj_AAAAAAAAAAAAAAAA
   for r in "GET /chat/$c/queue" "POST /chat/$c/queue" "DELETE /chat/$c/queue/$m" \
            "GET /projects/$p/files?q=a" "POST /projects/$p/files/attach"; do
     set -- $r; curl -s -o /dev/null -w "%{http_code} $1 $2\n" -X "$1" "$b$2"
   done   # 501, or 400 where validation runs before the stub (routes-mounted.test.ts covers the full matrix)
   ```
5. `pnpm test:e2e` → 96 passed (`chromium` + `mobile` + `tablet`).
6. `pnpm why typescript` (only 6.0.x).
7. ROADMAP + wave log → commit `feat: add phase 9 contracts and docs`.

---

## Wave P9-0b — schema, migration `0006`, skeletons, FREEZE

**Entry:** Gate P9-0a green. The coordinator lands K3 first; C24, C25, C26 and C27 start in one launch once the
migration exists (C24's upgrade test needs it).

### Coordinator actions

- **K3 seed contents** (built during P9-0a, see its coordinator actions): a password (`probe-pass-123`); a provider key;
  an MCP header secret; a branched chat (an edit and a regenerate); a share link; a pending shell approval
  (`mock:shell` in `ask` in the project); a project `git-demo` under `.tmp/gates/P9-0b/seed-roots` (`git init` + one
  commit with the `-c user.name / -c user.email` flags) with a chat of `mock:checkpoint` turns and one rewind batch
  (`POST /chats/:id/rewind`); project rules and global rules; `fileSweep: daily`; one long `mock:echo` chat (about 40
  turns, far beyond 80 % of `mock:compact`'s 2000-token window). Then SQL on the stopped data dir: a duplicate rule (the
  same scope and prefix as a seeded one, a later `created_at`), `override = 'allow'` on `shell` and on `current_time`
  in `tool_prefs` (the second must survive `0006`). The ids (chats, share token, project, the oldest and the duplicate
  rule ids, message and `workspace_changes` counts) go to `.tmp/upgrade-v14-ids.json`.
- **K3 Schema and migration `0006`** —
  1. `S/db/schema.ts`: on `shell_rules`,
     ``uniqueIndex('shell_rules_global_prefix_uq').on(t.prefix).where(sql`project_id is null`)`` and
     ``uniqueIndex('shell_rules_project_prefix_uq').on(t.projectId, t.prefix).where(sql`project_id is not null`)``
     (the existing `shell_rules_project_idx` stays); `UsagePurpose` += `compact` | `subagent` (type only: the `purpose`
     column is text without a CHECK).
  2. `pnpm db:generate --name shell_rule_unique` → `apps/server/drizzle/0006_shell_rule_unique.sql` + snapshot.
  3. Hand-prepend (each statement separated by `--> statement-breakpoint`; hand-written SQL has precedents in `0002` /
     `0003`):
     ```sql
     DELETE FROM shell_rules WHERE id IN (
       SELECT r.id FROM shell_rules r JOIN shell_rules k
         ON coalesce(k.project_id, '') = coalesce(r.project_id, '') AND k.prefix = r.prefix
        AND (k.created_at < r.created_at OR (k.created_at = r.created_at AND k.id < r.id))
     );
     --> statement-breakpoint
     UPDATE tool_prefs SET override = NULL WHERE tool_name = 'shell' AND override = 'allow';
     --> statement-breakpoint
     -- generated by drizzle-kit:
     CREATE UNIQUE INDEX `shell_rules_global_prefix_uq` ON `shell_rules` (`prefix`) WHERE project_id is null;
     --> statement-breakpoint
     CREATE UNIQUE INDEX `shell_rules_project_prefix_uq` ON `shell_rules` (`project_id`,`prefix`) WHERE project_id is not null;
     ```
  4. Inspect the SQL: exactly 1 `DELETE`, 1 `UPDATE` and 2 `CREATE UNIQUE INDEX … WHERE`. **Reject** any `DROP`,
     `__new_`, `PRAGMA` or `ALTER TABLE` (foreign keys are on; a rebuild of a table would cascade inside the migration
     transaction). A second `pnpm db:generate` reports no changes.
  5. Fallback when drizzle-kit drops the `WHERE`: one expression index
     ``uniqueIndex('shell_rules_scope_prefix_uq').on(sql`coalesce(project_id, '')`, t.prefix)`` and the inspection again
     (then 1 `CREATE UNIQUE INDEX`).
- **After C24, C25, C26, C27** — `nuxi prepare`; the gate below; the FREEZE additions.
- Ownership file `.tmp/waves/P9-0b.json` (below).

### C24 server skeleton (k3)

- **Mission.** Freeze the server side of Phase 9 outside the chat pipeline: the additive interfaces, the
  project-files service type with a stub whose signatures are final, the `ChatRunner` queue members, the stop order,
  fakes and the database tests of `0006`.
- **Owned.** `S/types.ts`, `S/deps*.ts`, `S/env*.ts`, `S/db/**` (not `schema.ts`), `S/chat/types.ts`,
  `S/services/project-files/**`, `S/testing/**` (not `api-samples.ts`).
- **Read-only highlights.** `.tmp/p9-designs/plan.md` 3, 5, 7, `server.md` 1C, `process.md` 3; ARCHITECTURE.md 5, 6.20,
  6.21, 8; API.md 4.24, 4.25; `SH/schemas/{queue,project-files}.ts`; `apps/server/drizzle/0006_*.sql`;
  `S/workspace/{walk,paths,sensitive}.ts`; `S/services/files/types.ts` (`upload`).
- **Tasks.**
  1. **C24-T1 Types (additive)** — `S/types.ts`: `AppServices.projectFiles: ProjectFileService`; `S/chat/types.ts`: the
     `ChatRunner` queue members (proposed: `queueList(chatId): QueueItem[]`, `enqueue(chatId, body: QueueAddBody,
     options: ChatRunOptions): Promise<QueueItem>` (throws 404 / 409 `run-idle` / `queue-full` / `exists`),
     `dequeue(chatId, itemId): boolean` (false → 404), `clearQueue(chatId, reason): QueueItem[]`), `stopAll()`
     documented as "clears every queue, then aborts every run". C24 fixes the exact names and lists them in its report.
     *Accept:* `pnpm typecheck` green.
  2. **C24-T2 `S/services/project-files/types.ts` (frozen after the gate)** — `ProjectFileService { search(projectId,
     query: ProjectFilesQuery): Promise<ProjectFileSearch>, attach(projectId, body: ProjectFileAttachBody):
     Promise<FileRef>, invalidate(projectId): void, stop(): void }`; the stub `index.ts`
     (`createProjectFileService(deps)`) with the final signature: `search` / `attach` throw `not_implemented`,
     `invalidate` / `stop` are no-ops. *Accept:* `deps.test.ts` "phase 9 skeleton".
  3. **C24-T3 Deps** — the factory `createProjectFileService`; `stopDeps` = data (sweep) → runs (`stopAll`: queues
     cleared → children aborted through the run signal → runs) → project file index (`projectFiles.stop()`) →
     checkpoints → plugins → MCP → catalog → events; `startDeps` unchanged (the index builds lazily). *Accept:*
     `deps.test.ts` checks the order (a failing step still lets the next run).
  4. **C24-T4 Environment** — no new variable (Phase 9 adds none); `S/env*` only for compile fixes (reported).
  5. **C24-T5 Fakes** — `S/testing/fake-project-files.ts` (an in-memory list of paths searched with `rankPaths`,
     `attach` returning a fixed `FileRef`, call counters), `createTestApp({ projectFiles? })`. *Accept:*
     `fakes.test.ts`.
  6. **C24-T6 Database tests** — `db.test.ts`: 18 tables, the migration tags `0000` … `0006`, both partial unique
     indexes in `sqlite_master` with their `WHERE`; `upgrade.test.ts`: a temporary folder holding only `0000` … `0005`
     with duplicate rules (two global `ls`, two project `ls` of one project, different `created_at`; an equal
     `created_at` pair decided by `id`), `allow` on `shell` and on `current_time`, then the real folder: the oldest rule
     of each scope + prefix kept, the global and the project `ls` both kept, the `shell` override null, the
     `current_time` override `allow`, a second identical insert fails with a unique violation, every chat, message and
     project survives. *Accept:* green.
- **Tests.** The tasks above.
- **Verify.** Server commands.

### C26 chat seams (k5)

- **Mission.** Land every seam of the chat pipeline that the four server feature agents share, so each P9-A agent owns
  its hot file alone: the step composer, the markers, the model history builder, the agent side channel and the step
  injector **complete**; every other new module as a stub with its final signature, wired at its call site with
  unchanged behavior.
- **Owned.** `S/chat/**` (not `types.ts`), `S/http/routes/commands{,.test}.ts` (`GET /commands` lists `/compact`).
- **Read-only highlights.** `.tmp/p9-designs/plan.md` 1 – 4, `server.md` 0, 1A – 1D (insertion points with line
  numbers); the AI SDK `.d.ts` (`prepareStep`, `PrepareStepResult`, `UIMessageStreamWriter`, transient data chunks);
  `SH/util/agent-state.ts`, `SH/schemas/agent.ts`; `S/workspace/run-scope.ts` (the WeakMap precedent).
- **Tasks.**
  1. **C26-T1 `steps.ts` (complete)** — `createPrepareStep({ contextGuard, steer, finalize? })` returns the
     `prepareStep` function for `streamText`: the pieces run in this fixed order on one step input (context guard →
     steer → sub-agent finalize nudge), each sees the messages the previous piece returned; the result carries
     `messages` only when a piece changed them (plus `activeTools` / `instructions` from `finalize`), nothing otherwise;
     only an abort error propagates (a piece's other errors are its own business: the guard falls back, the steer piece
     logs). *Accept:* `steps.test.ts` (the order; carry-forward of returned messages to the next piece; an empty result
     when nothing changed; an abort propagates; a recording `MockLanguageModelV4` sees the returned messages at steps N
     and N+1).
  2. **C26-T2 `markers.ts` (complete)** — `COMPACT_INSTRUCTIONS_MARKER` and `SUBAGENT_INSTRUCTIONS_MARKER` (distinct,
     never shown to users; the mock models read them). *Accept:* a constants test.
  3. **C26-T3 `model-history.ts` (complete)** — `buildModelHistory(history)`: `applyCompaction` (stub: `{ messages:
     history, summaryText: null }`) → `splitSteers` → `reduceAgentOutputs` (stub: identity) → `applyCommandExpansions`
     (`S/chat/context.ts:23`) → `summaryText` merged as the first part of the following user message (or a standalone
     user message); `modelStream` calls it where `applyCommandExpansions(history)` was (`pipeline.ts:618`), so
     `prepareModelFiles` runs on the result. *Accept:* `model-history.test.ts` with fake pieces (the order, the merge,
     no two user messages in a row, a v1.4 history unchanged).
  4. **C26-T4 `agent-scope.ts` (complete)** — a module-private `WeakMap<object, AgentRunScope>`, `bindAgentScope(c,
     scope)`, `agentScopeOf(c): AgentRunScope | null`; `AgentRunScope { toolMode, runSubagent(input, { toolCallId,
     signal }): AsyncIterable<TaskOutput>, todos(): <latestTodos result> }`; bound by `wrapToolExecute` next to
     `bindRunScope` for every run with tools (project or not), never inside children. *Accept:* unbound → null; nothing
     reachable through the plugin context.
  5. **C26-T5 Stubs with final signatures** —
     - `compaction/history.ts` `applyCompaction(history)` (identity), `compactionSummaryText(data)`;
     - `compaction/guard.ts` `createContextGuard(input)` (a no-op piece; the old step-0 trim stays in `pipeline.ts`);
     - `compaction/stream.ts` `compactStream(session, focus)` (the reply "There is nothing to compact yet.");
     - `compaction/summarize.ts` `summarizeHistory(input)`, `compaction/prompt.ts` `compactionInstructions(focus)`,
       `renderTranscript(messages, budgetChars)` (throw `not_implemented`; unused until W9.1);
     - `queue.ts` `createChatQueue(deps)` (the `ChatQueue` type W9.2 implements; members throw `not_implemented`);
     - `steer.ts` `createSteerStep(input)` (a no-op piece) and `stepInjector(session)` **complete**: counts
       `finish-step` chunks, emits the injected chunks whose step is ≤ the finished steps right before the next
       `start-step`, flushes the rest when the stream ends (in order even when the consumer falls a whole step behind);
     - `modes.ts` `applyToolMode(tools, { toolMode, continuation })` → `{ tools, activeTools? }` (tools unchanged) and
       `checkPlanApprovalMode(stored, merged, toolMode)` (no-op);
     - `subagent/index.ts` `createSubagentRunner(input)` (`runSubagent` yields one `failed` output "Sub-agents are not
       available yet."), `subagent/tools.ts` `childTools(input)` (empty), `subagent/history.ts`
       `reduceAgentOutputs(messages)` (identity).
     *Accept:* typecheck; one smoke test per stub; `stepInjector.test.ts` (slow consumer, flush at the end).
  6. **C26-T6 `pipeline.ts` wiring** — `RunSession.inject(chunk, stepNumber)`, `RunSession.addExtraCost(usd)`
     (generalizes the tool cost, `pipeline.ts:190-247`, `:494-502`), `RunSession.writeTransient(chunk)` (the writer
     `execute` records), `RunContext.onReleased(ending, awaitingApproval)` called once right after `registry.release`
     (`:480-488`); `modelStream`: `buildModelHistory`, `prepareStep: createPrepareStep({ contextGuard, steer })`,
     `activeTools` from `AssembledTools.activeTools?` passed to `streamText`, `ui.pipeThrough(stepInjector(session))
     .pipeThrough(generatedFiles)` (`:698`), `createSubagentRunner` + `bindAgentScope`; `RunSession.finalMessage`
     (`:391-402`) appends an injected steer missing from the response; `launchRun` (`:746-754`) dispatches
     `command.kind === 'compact'` to `compactStream`. *Accept:* `pipeline.test.ts` green unchanged; new tests: an
     injected chunk lands before the next `start-step`; `onReleased` runs once with the ending.
  7. **C26-T7 Commands, prepare, runner, approval** — `resolveCommand` (`commands.ts:82-120`) checks `compact` before
     the registry (`{ kind: 'compact', invocation: { name: 'compact', input, type: 'compact' }, focus }`; a focus over
     1000 characters → 400 on `['message']`); `regeneratedCommand` (`prepare.ts:285-290`) re-runs it; the continuation
     branch (`prepare.ts:414-417`) calls `checkPlanApprovalMode`; `GET /commands` lists `/compact` (description
     "Summarize the conversation to free up context", `pluginId: 'core-agent'`); `chat/index.ts` creates the queue and
     implements the `ChatRunner` queue members by delegation (the stubs throw `not_implemented`); `approval.ts` `case
     'plan'` = `ask` (so `plan` asks until W9.3). *Accept:* commands tests (`/compact keep numbers` → compact with the
     focus; `/compactx` is not compact); `GET /commands` lists it; an approval test for `plan`.
- **Tests.** The tasks above; every existing chat test stays green.
- **Verify.** Server commands.

### C27 core-agent and mock models (k6)

- **Mission.** The builtin plugin `core-agent` with its final tool definitions (schemas, descriptions, policies, model
  texts; execute stubs), the reserved command name `compact`, and the five mock models **complete** (they are frozen
  after the gate and drive every probe and e2e spec).
- **Owned.** `S/builtin-plugins/index{,.test}.ts`, `S/builtin-plugins/core-agent/**`, `S/builtin-plugins/mock/**`,
  `S/registry/validate*`, `S/plugins/templates/names*`, `SH/ids{,.test}.ts` (only to add `core-agent` to
  `BUILTIN_PLUGIN_IDS`).
- **Read-only highlights.** `.tmp/p9-designs/plan.md` 2, 4, 8, `server.md` 1B, 1D, 3; PROVIDERS.md 8 ("Agent mocks (Phase 9)") (D11 writes it from
  this section); `SH/schemas/agent.ts`; `S/chat/markers.ts` (C26; until it lands, C27 imports the two constants from
  there by name — coordinate through the report); `S/builtin-plugins/core-workspace/index.ts` (the builtin precedent);
  `S/builtin-plugins/mock/{models,workspace}.ts` (`MockPlan`, `streamSchedule`, `offeredTools`, `toolCallPlan`,
  `afterLastUser`).
- **Tasks.**
  1. **C27-T1 `core-agent` (frozen manifest)** — `S/builtin-plugins/core-agent/index.ts`: id `core-agent`, builtin,
     `engines ^1.3.0`, registered in `S/builtin-plugins/index.ts` before `mock`; tools: `todo_write` (policy `safe`, no
     workspace access; model text one line, e.g. "Todo list updated: 1 in progress, 2 pending, 0 completed."),
     `exit_plan_mode` (policy `always`; model text "The user approved the plan. Mode is now <label>. Implement it now;
     track progress with todo_write."), `task` (policy `safe`, `timeoutMs` 600 000, `toModelOutput` = the report only,
     or "Sub-agent failed: <error>; partial report: <report>"); input schemas from `SH/schemas/agent.ts`; final
     model-facing descriptions; execute stubs in `todo-write.ts`, `exit-plan-mode.ts` (throw `not_implemented`) and
     `task.ts` (an async generator yielding one `failed` output), `common.ts` helpers. *Accept:*
     `core-agent/index.test.ts` (names, policies, schemas, `engines`); `builtin-plugins/index.test.ts` count pin (7
     builtin plugins with `mock`).
  2. **C27-T2 Reserved command** — `S/registry/validate.ts` refuses a plugin command named `compact` (like the client
     commands); `S/plugins/templates/names.ts` treats it as taken. *Accept:* validate and names tests.
  3. **C27-T3 Mock plan additions** — `MockPlan.toolCalls?` (several calls in one step = parallel calls;
     `streamSchedule` emits each) and `stepDelayMs?` (an abortable wait before the step's first chunk);
     `MOCK_MODEL_IDS` + 5; the helpers generalized for the agent tools (`afterLastUser` counts only workspace tool
     results today). *Accept:* `models.test.ts` (two calls in one step, the delay with fake timers, an abort during the
     delay).
  4. **C27-T4 The five mock models (complete; PROVIDERS.md 8 ("Agent mocks (Phase 9)") is the probe contract)** — exact fallback texts not given
     below are C27's choice (reported; PROVIDERS.md 8 ("Agent mocks (Phase 9)") records them):
     - **`mock:compact`** (`{ tools: true }`, `contextWindow: 2000`):
       - instructions containing `COMPACT_INSTRUCTIONS_MARKER` (the summarizer call) → one text `MOCK-SUMMARY: <the
         first words of the first user text> | steps-done=<K> | focus=<focus or none> | sentinels=<the distinct OLD-<n>
         tokens of the transcript, comma-separated, or none>`, where K = the `steps-done` of an earlier summary in the
         transcript plus the `Step k done.` texts after it;
       - the last user text contains `seen?` → `summary:<yes|no> seen:<the distinct OLD-<n> tokens of the prompt,
         comma-separated, or none>`: `yes` when a `MOCK-SUMMARY:` text is in the prompt; the tokens are collected after
         removing every `MOCK-SUMMARY:` line (the summary's own `sentinels=` never counts);
       - `loop N` (in any text of the prompt, merged summaries included) → steps until N are done: each step writes
         `Step <k> done.` plus 120 filler words and calls `todo_write`; done = the `steps-done` of the latest summary
         plus the `Step k done.` texts after it; then `Loop finished after N steps.`;
       - anything else → the user text echoed plus 150 filler words (the context grows turn by turn).
     - **`mock:plan`** (`{ tools: true }`): every reply starts with the text `tools: <offered tool names, sorted>`; then
       - `exit_plan_mode` offered and not yet called after the last user message → `todo_write` (2 items) →
         `list_directory` (if offered) → `exit_plan_mode { plan: "# Plan\n1. Create notes.txt …" }`;
       - after a denied `exit_plan_mode` (its reason in the history) → `Revising: <reason>` plus a revised
         `exit_plan_mode` call;
       - after an approved `exit_plan_mode` result → `write_file notes.txt` (if offered) → `Plan done in mode <mode>.`;
       - `exit_plan_mode` not offered and no approved result → `Plan mode is off.`
     - **`mock:todo`** (`{ tools: true }`, `stepDelayMs` 400): three `todo_write` steps over three items — all pending →
       the first completed, the second in progress (with `activeForm`), the third pending → all completed — then
       `All 3 tasks done.`; `invalid` in the user text → first one `todo_write` with duplicate ids (the tool answers
       with an error), then the three steps.
     - **`mock:subagent`** (`{ tools: true }`):
       - parent (`task` offered, no `task` result after the last user message) → one step with two parallel `task`
         calls: `explore` with the prompt "List the project files" and `general` with the prompt "Check the time"; the
         user text `parallel N` → N calls; the keywords `write` / `loop` of the user text are copied into the `general`
         prompt; after the results → `Reports: <report 1> || <report 2>` (in call order);
       - child (instructions containing `SUBAGENT_INSTRUCTIONS_MARKER`) → the first offered of `list_directory` /
         `current_time`; `write` in the prompt and `write_file` offered → `write_file`; `loop` in the prompt → a tool
         call on every step until the step limit; finally (or when no tool is offered: the finalize step) `Report:
         <prompt> | tools: <offered tool names, sorted>`.
     - **`mock:steer`** (`{ tools: true }`, `stepDelayMs` 400): a new turn with the user text `steps N` → N steps, each
       calling `current_time`; a user message right after a tool message (a steer delivered at that boundary) → that
       step's text `Steered: <text>.`; after N results → `Finished N steps. Steers: <steer texts, or none>`; any other
       new turn → echo.
     *Accept:* `mock/index.test.ts` / `models.test.ts`: a plan per branch of every model (the summarizer call, `seen?`
     with and without a summary, `loop` across a summary, the plan / deny / approve / off branches, the three todo
     states, parent / child / parallel / write / loop / finalize, steps with and without a steer), and the listing
     (`contextWindow` 2000 for `mock:compact`).
  5. **C27-T5 Count pins** — the mock listing (five more models; the visible count and `modelCount`), the builtin plugin
     count, the template names test; listed in the report.
- **Tests.** The tasks above.
- **Verify.** Server commands.

### C25 web skeleton (k4)

- **Mission.** Freeze the web side of Phase 9: every new test id, the stub components with their final props, emits,
  exposes and root test ids, the `chat-queue` store, the new composables and pure modules (inert), the mounts and emit
  chains through the hot files, and the `useChatSession` interface additions.
- **Owned.** `W/utils/testids.ts`, `W/utils/testing/**`, `W/components/chat/{agent,queue,compaction,steer}/**` (new
  stubs), `W/components/chat/composer/**` (`MentionMenu`, `mode-cycle.ts`, `ChatComposer` mounts, the `SendStopButton` /
  `ComposerAddMenu` declarations, `plan` in `permission.ts`), `W/components/chat/{ChatView,ChatTranscript,ChatMessage,
  chat-format}*`, `W/components/chat/parts/{ToolPart,ToolApprovalCard,tool-approval-context}*`,
  `W/stores/chat-queue*`, `W/composables/{useChatSession,useServerEvents,useProjectFiles,useFileMentions}*`,
  `W/components/settings/agent/**`, `W/components/settings/GeneralSettings*`.
- **Read-only highlights.** UI.md 2.16, 7.24 – 7.27, 9.11, 10.6, 11.6, 12, 13.10; `.tmp/p9-designs/web.md` 1 – 4 (with
  the reconciliation); `SH/schemas/{agent,queue,project-files}.ts`, `SH/chat.ts`, `SH/util/{agent-state,mentions}.ts`.
- **Tasks.**
  1. **C25-T1 Test ids** — the 32 ids of UI.md 13.10 in `utils/testids.ts` (key = the camelCase of the id) under a `//
     Agent 2.0: compaction, plan mode, todos, sub-agents, mentions, queue, agent settings (Phase 9)` comment:
     `compaction-divider`, `compaction-toggle`, `compaction-summary`, `plan-approval`, `plan-approval-plan`,
     `plan-feedback`, `plan-approve-edits`, `plan-approve-ask`, `plan-keep-planning`, `todo-strip`, `todo-strip-toggle`,
     `todo-list`, `todo-item`, `task-block`, `task-block-trigger`, `task-step`, `task-steps-more`, `task-report`,
     `mention-menu`, `mention-menu-item`, `composer-mention`, `queued-messages`, `queued-message`,
     `queued-message-edit`, `queued-message-cancel`, `composer-queue`, `steer-note`, `settings-auto-compact`,
     `settings-compaction-model`, `settings-subagent-model`, `settings-subagent-max-steps`, `settings-shift-tab-modes`.
     New attribute names: `data-compacted` (on `message-user` / `message-assistant`); `composer-attachment` gains
     `data-kind` (`upload | project`) and `data-path`; `permission-option` gets `data-value="plan"`. Hooks that are not
     test ids: `data-slot` `task-live`, `todo-progress`, `compaction-meta`, `mention-highlight`.
  2. **C25-T2 Stub components** — each renders its root test id (where UI.md 13.10 names one) and declares exactly
     (UI.md 10.6 wins where it is more precise; report the difference):
     ```ts
     CompactionDivider    { data: CompactionData; variant: 'history' | 'run' }          // chat/compaction/
     SteerNote            { steer: SteerData }                                           // chat/steer/
     TodoList             { todos: readonly TodoItem[]; variant?: 'row' | 'strip' }      // chat/agent/
     TodoStrip            { state: TodoState | null; running: boolean }
     PlanBody             { plan: string; feedback?: string | null }
     PlanApprovalCard     { part: ToolPartLike; source?: string | null }
                          // emits decide: [{ approved: boolean; mode?: 'edits' | 'ask'; feedback?: string }]
     TaskBlock            { part: ToolPartLike; streaming: boolean; superseded?: boolean }
                          // emits approval: [the ToolPart approval payload]
     TaskBody             { input: unknown; output: unknown; running: boolean }          // store-free (share reuses it)
     TaskStepRow          { step: TaskStep; running: boolean }
     MentionMenu          { open: boolean; query: string; items: readonly ProjectFileEntry[];
                            state: 'loading' | 'ready' | 'error'; errorMessage?: string | null;
                            truncated: boolean; projectName: string | null }             // chat/composer/
                          // emits select: [ProjectFileEntry], close: []; exposes { handleKeydown, activeId, listId }
     QueuedMessages       { items: readonly QueueItem[]; waitingForApproval?: boolean }  // chat/queue/
                          // emits cancel: [id: string], edit: [id: string]
     AgentSettingsSection {}                                                             // settings/agent/
     ```
     *Accept:* one stub mount test per component (root test id, props accepted).
  3. **C25-T3 Store, composables, pure modules (inert, typed)** — `useChatQueueStore` (`W/stores/chat-queue.ts`):
     state per chat, getter `items(chatId)`, actions `fetch(chatId)`, `enqueue(chatId, body)`, `cancel(chatId, itemId)`,
     `markDelivered(chatId, id)`, `applyEvent(event)` (`queue.changed`, `chat.deleted`), `refreshLoaded()`;
     `useProjectFiles()` → `{ search(projectId, q, { signal?, limit? }), attach(projectId, path, { signal? }) }`;
     `useFileMentions({ projectId, text, caret })` → `{ token, open, items, state, error, truncated, dismiss, apply }`;
     `W/components/chat/composer/mode-cycle.ts`: `nextToolMode(current, { projectChat })`, `useModeCycle({ enabled,
     current, projectChat, set, announce })` → `{ handleKeydown(event): boolean }` (returns false);
     `W/components/chat/compaction/compaction.ts`: `compactionLayout(messages)` (dim index + dividers per message, over
     `compactionMarkers`); `W/components/chat/agent/todos.ts`: `TodoState`, `todoState(messages, { running })` (over
     `latestTodos`), `todoStripVisible(state, running)`. *Accept:* store shape tests; the modules type-check.
  4. **C25-T4 Mounts and chains** — `chat-format` kinds `compaction` (`data-compaction`), `steer` (`data-steer`), `task`
     (a tool part named `task`) — complete; `ChatMessage`: the `compaction`, `steer` and `task` branches, the props
     `compacted?` and `activity?`; `ChatTranscript`: the divider slot after a row, the `activity?` prop and the
     `v-memo` keys (compacted, dividers); `ToolPart`: the `PlanApprovalCard` branch (awaiting an `exit_plan_mode`
     decision), the preliminary status (`output-available` + `preliminary` = running while streaming, stopped
     otherwise), the approval payload `planMode?` / `reason?` through `ChatMessage` → `ChatTranscript` → `ChatView` →
     `ToolApprovalDecision`; `ChatView`: the dock (`TodoStrip` + `QueuedMessages` before the composer); `ChatComposer`:
     the `MentionMenu` mount after `SlashMenu`, the keydown chain (mention → slash), the aria switch to the open menu,
     the `useModeCycle` call, the `canQueue` pass-through; `SendStopButton` (`canQueue` prop, `queue` emit) and
     `ComposerAddMenu` (`projectChat` prop, `mention` emit) declarations; `ChatComposerExposed.restoreQueued(items)`;
     `plan` in `TOOL_MODE_OPTIONS` (typecheck; offered like `edits`); `useServerEvents` dispatches `queue.changed` and
     `chat.deleted` to the queue store and calls `refreshLoaded()` on reconnect; `GeneralSettings` mounts
     `AgentSettingsSection` between the Chat section and Custom instructions. *Accept:* the existing `ChatView`,
     `ChatTranscript`, `ChatMessage`, `ToolPart`, `ChatComposer`, `useServerEvents`, `GeneralSettings` tests stay green;
     mount tests for the dock and the composer chain.
  5. **C25-T5 `useChatSession` interface** — `submit(input): Promise<'sent' | 'queued'>` (sends for now), `queue:
     ComputedRef<readonly QueueItem[]>`, `cancelQueued(id): Promise<void>`, `stop(): Promise<QueueItem[]>` (returns `[]`
     for now), `todos` (the todo state of the shown path), `activity: Readonly<Ref<'compacting' | null>>`;
     `ToolApprovalDecision.planMode?: 'edits' | 'ask'`, `.reason?: string` (declared; `approve` ignores them until
     W9.9). *Accept:* session tests green.
- **Tests.** The tasks above.
- **Verify.** Web commands (`typecheck:fast` needs the coordinator's `.nuxt`; import new components by path).

### Wave P9-0b ownership

The audit cannot express "except": `S/db/schema.ts` matches C24's glob but is the coordinator's K3 edit;
`S/chat/types.ts` matches C26's glob but is C24's; `S/testing/api-samples.ts` stays C22's file from P9-0a (untouched in
P9-0b). C24, C26 and C27 list the count pins and fixtures outside their globs in their reports (`*-test-fixes`).

```json
{
  "wave": "P9-0b",
  "agents": {
    "K3": [
      "apps/server/src/db/schema.ts",
      "apps/server/drizzle/**"
    ],
    "C24": [
      "apps/server/src/types.ts",
      "apps/server/src/deps*.ts",
      "apps/server/src/env*.ts",
      "apps/server/src/db/**",
      "apps/server/src/chat/types.ts",
      "apps/server/src/services/project-files/**",
      "apps/server/src/testing/**"
    ],
    "C26": [
      "apps/server/src/chat/**",
      "apps/server/src/http/routes/commands.ts",
      "apps/server/src/http/routes/commands.test.ts"
    ],
    "C27": [
      "apps/server/src/builtin-plugins/index.ts",
      "apps/server/src/builtin-plugins/index.test.ts",
      "apps/server/src/builtin-plugins/core-agent/**",
      "apps/server/src/builtin-plugins/mock/**",
      "apps/server/src/registry/validate*",
      "apps/server/src/plugins/templates/names*"
    ],
    "C25": [
      "apps/web/app/utils/testids.ts",
      "apps/web/app/utils/testing/**",
      "apps/web/app/components/chat/{agent,queue,compaction,steer}/**",
      "apps/web/app/components/chat/composer/**",
      "apps/web/app/components/chat/{ChatView,ChatTranscript,ChatMessage,chat-format}*",
      "apps/web/app/components/chat/parts/{ToolPart,ToolApprovalCard,tool-approval-context}*",
      "apps/web/app/stores/chat-queue*",
      "apps/web/app/composables/{useChatSession,useServerEvents,useProjectFiles,useFileMentions}*",
      "apps/web/app/components/settings/agent/**",
      "apps/web/app/components/settings/GeneralSettings*"
    ]
  },
  "allow": [
    "docs/ROADMAP.md",
    "docs/DECISIONS.md",
    "AGENT.md",
    "docs/phases/phase-9-v1-5.md"
  ]
}
```

### Wave P9-0b cross-agent contracts

| Producer → consumer | Contract |
|---|---|
| K3 → C24, W9.7 | `0006`: the two partial unique indexes (the unique violation W9.7 maps to 409 `exists`), the cleared `shell` override |
| C24 → W9.2, W9.6, W9.9 | the `ChatRunner` queue members and `stopAll` semantics; `ProjectFileService` + the stub; `createTestApp({ projectFiles? })` and the fake; the stop order |
| C26 → W9.1, W9.2, W9.3, W9.5 | `steps.ts` (order guard → steer → finalize), `markers.ts`, `buildModelHistory`, `agentScopeOf`, `stepInjector` + `RunSession.inject` / `addExtraCost` / `writeTransient`, `RunContext.onReleased`, the stub signatures (`applyCompaction`, `compactionSummaryText`, `createContextGuard`, `compactStream`, `summarizeHistory`, `compactionInstructions`, `renderTranscript`, `createChatQueue`, `createSteerStep`, `applyToolMode`, `checkPlanApprovalMode`, `createSubagentRunner`, `childTools`, `reduceAgentOutputs`) |
| C27 → W9.3, W9.4, W9.5 | the `core-agent` manifest, tool schemas, descriptions, policies and model texts (frozen); the execute files they implement |
| C27 → W9.13 and the gates | the five mock models (PROVIDERS.md 8 ("Agent mocks (Phase 9)")) |
| C25 → W9.8 – W9.12 | the stub components, the store, the composables and pure modules, the emit chains and props, the `useChatSession` additions (frozen) |
| C25 → everyone | `utils/testids.ts` (frozen after the gate) |

### Gate P9-0b

1. `node scripts/audit-ownership.mjs .tmp/waves/P9-0b.json`
2. `nuxi prepare` → `pnpm check` → `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
3. `mv .tmp/e2e .tmp/e2e-old-p9-0b` (a cached mock listing hides the new mock models; `mv`, not `rm -rf`) →
   `pnpm start:e2e` → `pnpm test:e2e` (96 still green).
4. **Upgrade probe** on a fresh copy of the K3 seed (never on `.tmp/e2e`, never on the seed itself):
   ```sh
   d=.tmp/gates/P9-0b/upgrade-$(date +%s); cp -R .tmp/upgrade-v14 "$d"
   HF_MOCK_PROVIDER=1 HF_OFFLINE=1 HF_PORT=8898 HF_DATA_DIR="$d" \
     HF_WORKSPACE_ROOTS=$PWD/.tmp/gates/P9-0b/seed-roots node apps/server/dist/main.mjs &
   # through node + @libsql/client (or the sqlite3 CLI), ids from .tmp/upgrade-v14-ids.json:
   #   SELECT count(*) FROM __drizzle_migrations;                                   -> 7
   #   SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'shell_rules';
   #                                                    -> both *_prefix_uq indexes, each with its WHERE
   #   SELECT coalesce(project_id, ''), prefix FROM shell_rules GROUP BY 1, 2 HAVING count(*) > 1;   -> no rows
   #   SELECT id FROM shell_rules WHERE id IN (<oldest id>, <duplicate id>);         -> only the oldest
   #   SELECT tool_name, override FROM tool_prefs;           -> shell: null, current_time: 'allow'
   #   PRAGMA foreign_key_check; PRAGMA integrity_check;     -> no rows; ok
   #   SELECT count(*) FROM messages; SELECT count(*) FROM workspace_changes;   -> the seeded counts
   ```
   Then, logged in with the seeded password: every seeded chat opens (`GET /chats/<id>`, the old tool parts intact),
   the share link opens (`GET /share/<token>` 200), the pending approval is still pending, `GET /plugins` lists
   `core-agent` active, `GET /settings` has the five new keys at their defaults and `fileSweep: 'daily'`, `GET
   /shell-rules` lists the seeded count minus the duplicates, `GET /tools` shows no override on `shell` and `allow` on
   `current_time`, `GET /chat/<id>/queue` → 501 (stub) or `{ items: [] }`. Stop the probe server afterwards.
5. **Seam no-op probe** (`pnpm start:e2e` or the 8898 server): a project chat with `mock:workspace` in `auto` still
   writes `mock-workspace.txt` and journals it (`GET /chats/<id>/changes` lists it); a chat request with `toolMode:
   'plan'` is accepted and the `mock:tool-approval` call asks (`awaitingApproval: true`); `/compact` answers "There is
   nothing to compact yet."; `GET /commands` lists `compact`.
6. FREEZE additions (see "FREEZE in Phase 9") → ROADMAP + wave log → commit
   `feat: add phase 9 schema, migration and skeletons`.

---

## Wave P9-A — features

Twelve agents in one launch against the P9-0b checkpoint. Only server agents get slots (k1 – k7); web agents run no
server.

### Coordinator actions

- Before the launch: the ownership file `.tmp/waves/P9-A.json` (below), agent prompts with a "what exists now"
  section, their section of this file and "Rules for every Phase 9 agent".
- **At the gate**: audit; batch the CCRs; `nuxi prepare`; the gate commands and probes below; the screenshot review;
  `pnpm audit`; red items become W9.15 (server) / W9.16 (web) tasks with their globs; the reports are digested into
  `.tmp/waves/P9-A-notes.md` for W9.14. **First cuts if the wave overflows** (in this order): in-run compaction (keep
  the pre-run and manual compaction), parallel children (cap 1), the `general` sub-agent type, the server-started next
  turn (a leftover queued item returns to the composer instead), share bodies of task blocks (plain tool rows),
  `compactModelRef` (the run model only).

### Wave rules

- Import new components explicitly by path; no `nuxt prepare` mid-wave.
- A new test id, a contract change or a frozen-file edit is a CCR in the report (with a local adapter).
- No doc edits ("For W9.14" notes in the report instead).
- Hot files have exactly one owner (table below): `pipeline.ts`, `prepare.ts`, `commands.ts`, `context.ts`,
  `notices.ts` → W9.1; `queue.ts`, `steer.ts`, `runs.ts`, `index.ts` and the chat / queue routes → W9.2; `approval.ts`,
  `modes.ts` → W9.3; `params.ts`, `usage.ts`, `title.ts`, the chats service index → W9.4; `tools.ts`, `history.ts`,
  `subagent/**` → W9.5; `ChatComposer.vue` and the queue list → W9.8; `useChatSession.ts`, `useServerEvents.ts`,
  `ChatView.vue` → W9.9; `ToolPart.vue`, `chat/agent/**`, the permission and slash modules → W9.10;
  `ChatTranscript.vue`, `ChatMessage.vue`, `chat-format.ts` → W9.11.
- Server agents implement behind the C26 seams and test against them with `MockLanguageModelV4` (and the C24 fake
  project-files service); where a feature needs another agent's piece (W9.5 needs W9.3's `applyToolMode`, W9.9 needs
  W9.2's routes), test against the frozen signature with a fake; the real round trips are probed at the gate.
- The mock models are frozen: a test that needs another script uses `MockLanguageModelV4` directly.

### W9.1 compaction-server (k1)

- **Mission.** `/compact [focus]`, automatic compaction before and inside runs (the context guard), the summarizer, the
  history rule, the fallback and notices, the usage row and cost.
- **Owned.** `S/chat/{compaction/**,context*,pipeline*,prepare*,commands*,notices*}`.
- **Read-only highlights.** ADR-040; `.tmp/p9-designs/plan.md` 1, `server.md` 1A; ARCHITECTURE.md 6.18; API.md 6.4;
  `SH/util/agent-state.ts` (`findCompaction`, `latestTodos`), `SH/chat.ts` (`compactionDataSchema`);
  `S/chat/{steps,markers,model-history}.ts` (frozen); `S/chat/title.ts` (the reasoning-off one-shot call pattern);
  PROVIDERS.md 8 ("Agent mocks (Phase 9)") (`mock:compact`).
- **Tasks.**
  1. **W9.1-T1 History rule (`compaction/history.ts`)** — `applyCompaction(history)` over `findCompaction`: the model
     history = summary ++ (`keep: last-user` ? the last user message before M_k : []) ++ M_k's parts after p ++ the
     later messages; `{ messages, summaryText }`; `compactionSummaryText(data)` = a fixed prefix, the summary, "Current
     todo list:" plus the items when `todos` is set, and for `auto` "Continue the latest request without asking the user
     to repeat anything." *Accept:* `compaction/history.test.ts` (none; manual; auto at step 0 with `last-user`; in-run
     at part p: later parts kept, earlier dropped; several markers: the latest wins; a branch above the marker: full
     history; a regenerate: the old reply's marker is not on the path; a deleted compaction message: the previous
     marker; a chat imported with new ids: same result).
  2. **W9.1-T2 Manual `/compact` (`compaction/stream.ts`)** — `start` → transient `data-activity { kind: 'compacting' }`
     → summarize `buildModelHistory(history without the /compact message)` → one `data-compaction` (`trigger: manual`,
     `keep: none`, `focus`) → `data-activity idle` → `finish`; nothing after the latest marker → "There is nothing to
     compact yet."; a regenerate re-runs it; the reply's `metadata.usage.contextTokens = tokensAfter` (the context ring
     drops); an image model as the run model → 400 on `['modelRef']`; a summarizer failure ends the reply as failed (no
     marker, history unchanged); abort → `aborted`. *Accept:* `compaction/stream.test.ts` with `MockLanguageModelV4`.
  3. **W9.1-T3 Context guard (`compaction/guard.ts`)** — the first piece of `prepareStep` (every model call, step 0
     included): estimate = max(`estimateTokens(messages, instructions)`, the last step's input + output); compact when
     the estimate is > 0.8 × `contextWindow` (`COMPACT_TRIGGER_RATIO`), `autoCompact` is on, the window is known and the
     run has used < `compactionsPerRunMax` (10); new messages = `[merge(summaryText, keptUser)]` (`keep: last-user`,
     where `keptUser` is the run's turn user message after expansions and files; `keep: none` when that would still
     exceed 0.85 × the window); inject `data-compaction` (`trigger: auto`) for that step through `session.inject`;
     transient activity around the call. The old step-0 trim (`pipeline.ts:636-638`) moves here: a non-abort failure or
     `autoCompact` off → `trimToContext` on step 0 only + notice `compaction-failed` (failure) or `context-trimmed`
     (off); an abort re-throws; silent mode for children (no injection, the usage row only). *Accept:*
     `compaction/guard.test.ts` (below the threshold nothing; above: one marker and the new messages; the per-run cap;
     an unknown window; off → trim + `context-trimmed`; a summarizer error → trim + `compaction-failed`; abort → the run
     ends `aborted`; silent mode injects nothing).
  4. **W9.1-T4 Summarizer (`compaction/{summarize,prompt}.ts`)** — the transcript rendered as text (tool calls `[tool
     name(args ≤ 500 chars)]`, results ≤ 2000 characters, files → `[file …]`, reasoning dropped; above 0.85 × the
     summarizer window the middle is cut, keeping the head (a previous summary) and the newest part); `generateText`
     with instructions carrying `COMPACT_INSTRUCTIONS_MARKER` and Claude Code-style sections (request and intent, files
     and code, errors and fixes, all user messages, pending tasks, current work, next step, the focus), reasoning off,
     `maxOutputTokens = clamp(0.2 × window, 256, 8192)`, the run signal, 120 s, `maxRetries: 2`; the model
     `compactModelRef ?? run model` (an unresolvable setting → the run model + a warning); the summary capped at 60 000;
     `todos` from `latestTodos`; one usage row purpose `compact` (`messageId` = the assistant id), the cost through
     `session.addExtraCost`. *Accept:* `compaction/prompt.test.ts` (caps, the middle cut, no tool-call / tool-result
     model parts in the summarizer input), `compaction/summarize.test.ts` (the marker and the focus in the instructions,
     the setting model, the fallback, the usage row, the summary never logged at `info`).
  5. **W9.1-T5 Equivalence and carry-forward** — the model messages after an in-run compaction at step N equal
     `buildModelHistory` of the saved message (the next turn's history); a recording mock sees the summary first at
     steps N+1 and N+2; a `loop` run compacts between steps and finishes. *Accept:* `pipeline.test.ts` (new cases).
  6. **W9.1-T6 Notices and commands** — `compaction-failed` in `notices.ts` ("Couldn't compact the conversation. Older
     messages were left out instead."); `/compact` resolution edge cases (focus cap, `/compact` while a plugin command
     list changes). *Accept:* tests.
- **Tests.** The tasks above; every existing pipeline / prepare / context test stays green. The Markdown export of the
  marker is W9.7's.
- **Verify.** Server commands.

### W9.2 steer-queue-server (k2)

- **Mission.** The queue, its routes and event, steer delivery at step boundaries, the server-started next turn, and
  clearing on Stop, chat delete, key rotation and shutdown.
- **Owned.** `S/chat/{queue,steer,runs,index}*`, `S/http/routes/{chat,chat-queue}{,.test}.ts`.
- **Read-only highlights.** ADR-042; `.tmp/p9-designs/plan.md` 3, `server.md` 1C; API.md 4.24, 5.10, 6.6, 7;
  ARCHITECTURE.md 6.20; `S/chat/{steps,pipeline}.ts` (`RunContext.onReleased`, `RunSession.inject`),
  `S/chat/files.ts` (`normalizeUserParts`, `prepareModelFiles`), `SH/schemas/queue.ts`, `SH/util/agent-state.ts`
  (`splitSteers`).
- **Tasks.**
  1. **W9.2-T1 Queue (`queue.ts`)** — per chat ≤ 10 items of ≤ 256 KB; item `{ id, message, modelRef, reasoningEffort,
     toolMode, createdAt, turnOnly }`; parts normalized through `normalizeUserParts` (uploaded `/api/files/<id>` only);
     `turnOnly` when the first text is a server command (`/compact` or a registered plugin command); add: 404 unknown
     chat, 409 `run-idle` (no run and no pending approval), 409 `queue-full`, 409 `exists` (the id is used by a message
     of the chat or already queued); remove: 404 once delivered or started; every change emits `queue.changed { chatId,
     items, removed? }`; a synchronous take of the steerable items (skips `turnOnly`), a take of the next item, a clear
     with a reason. *Accept:* `queue.test.ts` (caps, every 409, take vs. remove, the `removed` reasons).
  2. **W9.2-T2 Routes** — `GET /chat/:id/queue` (`{ items }`), `POST /chat/:id/queue` (201 item),
     `DELETE /chat/:id/queue/:itemId` (204 / 404); `POST /chat/:id/stop` clears the queue (reason `stopped`) and then
     stops: `{ stopped, dropped }`. *Accept:* `chat-queue.test.ts` covers every answer of API.md 4.24; `chat.test.ts`
     (stop with queued items).
  3. **W9.2-T3 Steer step (`steer.ts` `createSteerStep`)** — the second piece of `prepareStep`: takes every steerable
     item synchronously, converts each into a user model message (a one-message UI history through `prepareModelFiles` +
     `convertToModelMessages`), appends them to `messages` (carried forward), injects `data-steer { id, parts, queuedAt,
     deliveredAt }` for that step (`session.inject`), emits `queue.changed` with `removed: delivered`; step 0 counts
     (the first call of a continuation or a new turn). *Accept:* a recording mock sees the steer as a user message at
     step N+1 and later; the stored reply holds `data-steer` between the steps; `buildModelHistory` of the saved message
     equals the in-run messages.
  4. **W9.2-T4 Run end (`index.ts`, `onReleased`)** — completed without a pending approval → the first item becomes the
     next turn: `runner.start({ chatId, message, trigger: 'submit-message', modelRef, reasoningEffort, toolMode },
     { logger, requestId: 'queue_…' })`, the response body cancelled (the tee keeps the replay buffer), `run.started
     { origin: 'queue', userMessageId }`, `removed: started`; a lost race with a user `POST /chat` (409) re-queues the
     item at the head (it is steered into that run); other errors → `removed: failed`; a pending approval → the items
     wait (delivered at step 0 of the next run); aborted / failed → every item removed (`stopped` / `failed`). *Accept:*
     through `createTestApp()` + `app.request()`: the U/A/U/A path after an item queued during the last step; the 409
     race; the approval wait; an abort clears.
  5. **W9.2-T5 Clearing and bounds** — chat delete (`chat.deleted`), key rotation (`key.rotated`) and shutdown
     (`stopAll` clears every queue before it aborts the runs); no entry left for a deleted chat; no timers (or
     `unref()`). *Accept:* a test per trigger.
  6. **W9.2-T6 Events** — `run.started.origin` is `request` for user requests and `queue` for server-started turns, with
     `userMessageId`. *Accept:* event tests.
- **Tests.** The tasks above; queue texts never logged at `info`.
- **Verify.** Server commands.

### W9.3 plan-mode-server (k3)

- **Mission.** The `plan` tool set and `activeTools`, the approval case, `exit_plan_mode`, the continuation mode check.
- **Owned.** `S/chat/{approval,modes}*`, `S/builtin-plugins/core-agent/{exit-plan-mode,common}*`.
- **Read-only highlights.** ADR-041, ADR-032; `.tmp/p9-designs/plan.md` 2, `server.md` 1B; ARCHITECTURE.md 6.19;
  `S/chat/{tools,prepare,agent-scope}.ts`; `S/builtin-plugins/core-agent/index.ts` (frozen).
- **Tasks.**
  1. **W9.3-T1 Tool set (`modes.ts` `applyToolMode`)** — in `plan`: tools with workspace access `write` / `execute` are
     not offered; `exit_plan_mode` is offered only in `plan`, except a continuation whose message holds an approved
     `exit_plan_mode` part (kept in `tools` so the SDK executes it, excluded from `activeTools`); `todo_write` and
     `task` stay; tools without an access level keep their policy (and ask). The server accepts `plan` in any chat (the
     UI offers it only in project chats; outside a project there are no workspace tools to drop). *Accept:*
     `modes.test.ts` (each mode's tool set; the continuation exception; `activeTools` only when needed; `plan` in a chat
     without a project).
  2. **W9.3-T2 Approval (`approval.ts`)** — `case 'plan'` = `ask` in `resolveApproval` (`:59-80`); `createToolApproval`
     (`:179-224`) returns `user-approval` for `core-agent`'s `exit_plan_mode` before overrides and hooks; on a
     continuation that result is not `denied`, so the SDK keeps the user's approval. *Accept:* `approval.test.ts` (a
     table with `plan`; `exit_plan_mode` asks with a stored `allow` override and with an approving `tool.approve` hook).
  3. **W9.3-T3 `exit_plan_mode`** — execute reads `agentScopeOf(c).toolMode` and returns `{ approved: true, mode }`
     (`edits` / `ask`); the frozen model text; a rejection is a denied approval whose `reason` (≤ 2000) is the feedback.
     *Accept:* `exit-plan-mode.test.ts`.
  4. **W9.3-T4 `checkPlanApprovalMode`** — approving an `exit_plan_mode` call while the continuation's `toolMode` is
     `off` or `plan` → 400 `validation_error` on `['toolMode']`. *Accept:* `modes.test.ts`; a continuation through
     `createTestApp()` with a scripted `MockLanguageModelV4`: approve in `edits` → `exit_plan_mode` executes (hidden
     from the model by `activeTools`) and a following `write_file` runs without another approval; deny with feedback in
     `plan` → the model receives the reason.
- **Tests.** The tasks above.
- **Verify.** Server commands.

### W9.4 todo-instructions-server (k4)

- **Mission.** `todo_write`, the instruction blocks for plan mode, todos and sub-agents, and the usage purposes in the
  chat totals.
- **Owned.** `S/chat/{params,usage,title}*`, `S/builtin-plugins/core-agent/todo-write*`, `S/services/chats/index*`.
- **Read-only highlights.** ADR-041, ADR-043; `.tmp/p9-designs/plan.md` 2, `server.md` 1B; `SH/schemas/agent.ts`;
  `S/chat/params.ts:94-103` (`runInstructions`), `S/services/chats/index.ts:88` (totals).
- **Tasks.**
  1. **W9.4-T1 `todo_write`** — the validated input replaces the list; output `{ todos, counts }`; the frozen one-line
     model text; policy `safe`, no workspace access (offered in every chat with tools, plan mode included); an invalid
     list → a tool error, the run continues. *Accept:* `todo-write.test.ts`.
  2. **W9.4-T2 Instructions (`params.ts`)** — `runInstructions` gains the tool mode and the offered agent tool names;
     after the workspace block: the plan block (in `plan`: investigate read-only, call `exit_plan_mode` with a complete
     markdown plan, answer plain questions directly), the todo hint (when `todo_write` is offered), the `task` hint
     (when offered: `explore` vs `general`, children can't ask for approval, give a complete prompt). *Accept:*
     `params.test.ts` (each block present / absent per mode and offered tools; the order).
  3. **W9.4-T3 Usage purposes and totals** — the `compact` and `subagent` rows (written by W9.1 / W9.5 through the
     existing usage writer) count in the chat totals (`chat`, `image`, `compact`, `subagent`); the usage helpers in
     `usage.ts` for child usage sums (`sumUsage`, `roundUsd`) stay shared. `title.ts` is unchanged unless the purpose
     typing needs it. *Accept:* a chats service totals test with every purpose.
- **Tests.** The tasks above.
- **Verify.** Server commands.

### W9.5 subagents-server (k5)

- **Mission.** Streaming tools (async-generator `execute`), the `task` tool, the child runner, the child tool set and
  its denial gate, the semaphore and caps, journal ids, usage, and the finalize rule.
- **Owned.** `S/chat/{subagent/**,tools*,history*}`, `S/builtin-plugins/core-agent/task*`.
- **Read-only highlights.** ADR-043, ADR-036; `.tmp/p9-designs/plan.md` 4, `server.md` 0, 1D; ARCHITECTURE.md 6.22;
  the AI SDK `.d.ts` (`ToolExecuteFunction` returning `AsyncIterable`, preliminary outputs); `S/chat/{modes,approval,
  agent-scope,steps,markers}.ts`; `S/workspace/run-scope.ts`.
- **Tasks.**
  1. **W9.5-T1 Streaming tool wrapper (`tools.ts:176-238`)** — an async-generator `execute` → `wrapToolExecute` returns
     an async generator; the iteration runs inside `plugins.guard` (timeout and abort over the whole iteration);
     preliminary values throttled to ≤ 1 per 250 ms (latest wins), each `capToolOutput`-ed, ≤ 2000 sent, the final value
     always passed; `tool.after` hooks on the final value only; the settled-call record after settle; a non-generator
     that resolves to an `AsyncIterable` is drained (last value). *Accept:* `tools.test.ts` with fake timers (10 yields
     in 100 ms → at most one preliminary plus the final; the timeout over the iteration; abort; `tool.after` once; the
     cap per value; the 2000 cap; the drain fallback).
  2. **W9.5-T2 `task` (`core-agent/task.ts`)** — an `async function*` delegating to `agentScopeOf(c).runSubagent(input,
     { toolCallId, signal })`; no agent scope (a child, a context without a run) → one `failed` output. *Accept:*
     `task.test.ts`.
  3. **W9.5-T3 Child runner (`subagent/index.ts` `createSubagentRunner`)** — model `subagentModelRef ?? run model`;
     `buildRunParams` with the child tool list and a preamble carrying `SUBAGENT_INSTRUCTIONS_MARKER`; messages `[user:
     prompt]`; `stopWhen: isStepCount(subagentMaxSteps)`; at the last allowed step the finalize piece returns
     `activeTools: []` and "Write the final report now."; the context guard in silent mode;
     `AbortSignal.any([run.signal, AbortSignal.timeout(570 s)])`; a per-run semaphore (`subagentParallelMax` 3; waiting
     calls yield `queued`) and `subagentsPerRunMax` 20 (more → `failed`); a `TaskOutput` snapshot on tool start / finish
     and step end (steps ≤ 50 kept + `stepsOmitted`, summary ≤ 200, preview ≤ 300, report ≤ 32 000); `limit` when the
     step limit or the deadline ended it (with the partial report). *Accept:* `subagent/index.test.ts` with
     `MockLanguageModelV4` (snapshots; five calls → three running and two queued; the per-run cap; abort from the parent
     signal; the deadline with fake timers; the step limit → `limit`; the finalize nudge).
  4. **W9.5-T4 Child tools and denial (`subagent/tools.ts` `childTools`)** — `assembleTools` with the parent's mode,
     then `applyToolMode` (W9.3's frozen signature), minus the tools that can only ask in that mode, minus `core-agent`
     tools and `generate_image`, minus `deny` / `ask` overrides; `explore` (or a parent in `plan`) also drops `write` /
     `execute` and lowers the mode to `ask`; the child's `toolApproval = createToolApproval(parent mode)` with
     `user-approval` mapped to `denied` ("Sub-agents cannot ask the user: this call needs approval."). *Accept:*
     `subagent/tools.test.ts`: a table mode × type (ask → safe + read; edits → + workspace writes and rule-matched
     shell; auto → everything except `always`); **`task` is never in the child set**; a call that would ask → a `denied`
     step and never an `approval-requested` part; a call to a missing tool → an `error` step.
  5. **W9.5-T5 Journal, cwd, usage** — child calls bind the parent's run scope with `toolCallId = parentCallId + '/' +
     childCallId` (journaled under the parent assistant message, so rewind and the changes panel cover them); a copy of
     `shellCwd` (a child's `cd` does not move the parent); no agent scope in children (depth 1); one usage row purpose
     `subagent` per child (the child's provider and model), the cost through `session.addExtraCost`. *Accept:* a child
     `write_file` creates a `workspace_changes` row with the parent message id and a `<parent>/<child>` tool call id; a
     child `cd` leaves the parent's folder; one usage row per child.
  6. **W9.5-T6 History (`subagent/history.ts`, `history.ts`)** — `reduceAgentOutputs` turns stored `tool-task` outputs
     into `{ status, report }` for the model; `finalizeParts` (`history.ts:156-171`) turns a part still preliminary at
     the run end into `output-error` (the stopped / failed text); `REASON_MAX_CHARS` (`history.ts:19`) →
     `LIMITS.approvalReasonMaxChars` (2000). *Accept:* `history.test.ts`, `subagent/history.test.ts`.
- **Tests.** The tasks above; child prompts and outputs never logged at `info`.
- **Verify.** Server commands.

### W9.6 mentions-server (k6)

- **Mission.** The per-project file index, ranking, invalidation, search and attach.
- **Owned.** `S/services/project-files/**` (not `types.ts`), `S/http/routes/project-files{,.test}.ts`,
  `S/testing/fake-project-files*`.
- **Read-only highlights.** ADR-042; `.tmp/p9-designs/plan.md` 3, `server.md` 1C; API.md 4.25; ARCHITECTURE.md 6.21;
  `S/workspace/{walk,paths,sensitive}.ts` (`walkWorkspace`, `resolveWorkspacePath`, `readWorkspaceFile`,
  `isSecretLookingPath`); `S/services/files/types.ts` (`upload`); `SH/util/mentions.ts`.
- **Tasks.**
  1. **W9.6-T1 Index** — per project through `walkWorkspace` (`.gitignore`, `node_modules`, the entry / depth / 10 s
     limits; no new pattern code): relative POSIX file paths ≤ 50 000 (`truncated`), folders derived from the file
     paths; secret-looking paths and `.git` never listed; single-flight builds; 30 s TTL (fake timers in tests); dropped
     on `workspace.changed` for the project and on `project.changed`; a bounded number of cached projects (W9.6 fixes
     the cap, reported); `stop()` clears everything. *Accept:* `index.test.ts` (a gitignored `dist/`, `node_modules`,
     `.git`, `.env` absent; the cap → `truncated`; TTL; invalidation; two concurrent searches build once; a hostile
     `.gitignore` returns within the walker limits).
  2. **W9.6-T2 Search** — `GET /projects/:id/files?q=&limit=` → `rankPaths(q, entries, limit)` → `{ items, truncated,
     indexedAt }`; unknown project 404; an unavailable folder 400 (the `openWorkspace` message). *Accept:* route tests
     (`?q=chk` ranks `checkpoint.txt` first; the limit).
  3. **W9.6-T3 Attach** — `POST /projects/:id/files/attach { path }`: `resolveWorkspacePath` + `readWorkspaceFile` →
     refuse a `.git` segment or a secret-looking path (400), a folder (400), more than 5 MiB (413) → `files.upload(new
     File([bytes], basename))` (type sniffing: text, image, PDF, else the upload's own error; pins) → 201 `FileRef`.
     *Accept:* route tests (`../x`, an absolute path, a link out of the root, `.git/config`, `.env` → 400; ok → 201 and
     `GET /files/:id` returns the bytes; 6 MiB → 413; a binary blob → the upload's error).
  4. **W9.6-T4 Logging** — queries and paths only at `debug`. *Accept:* a captured-log test.
- **Tests.** The tasks above (`realpath(mkdtemp())` projects).
- **Verify.** Server commands.

### W9.7 stabilization-server (k7)

- **Mission.** Unique shell rules, the effective override, the refused `allow` on `exit_plan_mode`, the duplicated
  `NO_PROJECT_MESSAGE`, and the consumers of the new parts (share, Markdown export, search text, import).
- **Owned.** `S/services/shell-rules/**`, `S/services/checkpoints/{restore-scope,changes-common}*`,
  `S/http/routes/{changes,tools}{,.test}.ts`, `S/mcp/tools*`, `S/services/shares/**`,
  `S/services/chats/{export,import,text}*`.
- **Read-only highlights.** ADR-038, ADR-040 – ADR-042; `.tmp/p9-designs/plan.md` 1 – 3, 5;
  `apps/server/drizzle/0006_*`; `S/services/shares/snapshot.ts:181-216` (`sanitizePart`),
  `S/services/chats/export.ts:106-123`, `S/services/chats/text.ts:56-66`, `S/services/chats/import.ts`;
  `SH/util/agent-state.ts` (`splitSteers`).
- **Tasks.**
  1. **W9.7-T1 Unique rules** — create maps the unique-index violation to 409 `exists` (the index is the authority; the
     in-process serialization may stay). *Accept:* two concurrent identical creates → one 201 and one 409; the same
     prefix global and in a project → both 201.
  2. **W9.7-T2 Overrides** — `GET /tools` reports the effective override for `execute` tools (a stored `allow` → null);
     `PATCH /tools/exit_plan_mode { override: 'allow' }` → 400 `validation_error` on `['override']` (the plan approval
     always asks); `ask` / `deny` still accepted. *Accept:* `tools.test.ts`.
  3. **W9.7-T3 One message, one lookup** — one `NO_PROJECT_MESSAGE` shared by `restore-scope.ts` and
     `changes-common.ts`; the chat looked up once per request. *Accept:* the changes tests green; a call-count test on
     the fake chats service.
  4. **W9.7-T4 Part consumers** — share sanitizer (`snapshot.ts`): assistant messages split at steers into user share
     messages (text and files), `data-compaction` / `data-activity` dropped, no `sharePartSchema` change; Markdown
     export (`export.ts`): the marker as "_Conversation compacted (N messages summarized)_" plus the summary as a quote,
     a steer as "## User (during the run)"; search text (`messagePlainText`): steer text indexed, summaries not; import:
     a chat export with `data-compaction` / `data-steer` parts round-trips. *Accept:* `snapshot.test.ts`,
     `export.test.ts`, `text.test.ts`, `import.test.ts` (one case per part).
- **Tests.** The tasks above.
- **Verify.** Server commands.

### W9.8 composer-web

- **Mission.** The `@` mention menu and project chips, the queue button / placeholder / restore in the composer, and
  the queued messages list.
- **Owned.** The composer files listed in the ownership JSON (every file of `W/components/chat/composer/` except
  `permission*`, `PermissionMenu*`, `mode-cycle*`, `slash-commands*` → W9.10 and `ContextRing*`, `context-usage*` →
  W9.11), `W/components/chat/queue/**`, `W/composables/{useFileMentions,useProjectFiles,useComposerAttachments,
  useComposerDraft,useComposerShortcuts}*`.
- **Read-only highlights.** UI.md 7.6, 7.7, 7.26, 10.6, 11.6, 12, 13.10, 14, 15; `.tmp/p9-designs/web.md` 1.5, 1.6;
  `SH/util/mentions.ts`; `SlashMenu.vue` (the menu contract); the `chat-queue` store (W9.9's, frozen signature).
- **Tasks.**
  1. **W9.8-T1 Mention menu** — `MentionMenu.vue` (the `SlashMenu` contract: exposed `handleKeydown`, `activeId`,
     `listId`; `role="listbox"` labelled "Files in {project}", `aria-busy` while loading; "Searching files…" after 150
     ms, "No matching files", "Couldn't search files." / "The project folder is unavailable.", "Showing the first 50
     matches. Type more to narrow it down."; highlight runs from `scorePath` ranges without `v-html`; 40 px rows on
     coarse pointers, `max-h-[40dvh]`; a polite count announcement debounced 500 ms); `useFileMentions` (80 ms debounce,
     aborts the previous request, a 20-query cache, dismissed-token memory; the token from `mentionTokenAt`);
     `useProjectFiles` (search / attach through `useApi`). *Accept:* `MentionMenu.test.ts`, `useFileMentions.test.ts`
     (fake timers: debounce, abort, cache, dismiss), `useProjectFiles.test.ts`.
  2. **W9.8-T2 Picking** — a file inserts `formatMention(path) + ' '` through `setTextAndCaret` and calls
     `attachments.addProject(projectId, path)` (chip `data-kind="project"`, `data-path`, `FileCode`, base name + full
     path tooltip; chip and text independent); a folder inserts `@dir/` and keeps the menu open; no menu outside project
     chats or for `a@b`; keydown chain mention → slash; `aria-controls` / `aria-activedescendant` follow the open menu;
     `ComposerAddMenu` "Mention a file" (`AtSign`, `composer-mention`) in project chats; attach failures → a toast
     "{path} can't be attached" (413 "Files can be up to 5 MB.", 404 "The file no longer exists.", type errors "Attach
     images, PDFs or text files."). *Accept:* `ChatComposer.test.ts` (`@pars` + Enter, folder drill-down, `a@b`, outside
     a project), `useComposerAttachments.test.ts` (`addProject` dedupe by path, uploading → done, failure through
     `onReject`, `addRefs`).
  3. **W9.8-T3 Queue in the composer** — `submit` drops the `running` guards (`ChatComposer.vue:414,430`; the voice and
     upload guards stay); placeholder "Queue a message…" while running; `SendStopButton` shows an outline "Queue
     message" button (`composer-queue`) left of Stop while running and the composer has content (Stop never moves);
     Enter queues, Esc still stops; `restoreQueued(items)` appends the texts with blank lines between them, restores the
     chips through `addRefs` and shows the toast "Queued messages moved back to the composer." *Accept:* composer tests.
  4. **W9.8-T4 `QueuedMessages`** — rows (`queued-message[data-message-id]`) with Edit (cancels the item, then restores
     it into the composer) and Cancel; the header "Queued · {n} · sent at the next step" or "Sent after you answer the
     approval" (`waitingForApproval`); a delivering row shows a spinner and disabled actions; on mobile more than 2 rows
     collapse behind "Show {n} more"; after a cancel, focus moves to the next row's Cancel, else to the textarea.
     *Accept:* `QueuedMessages.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W9.9 session-web

- **Mission.** The session's submit / enqueue / cancel / stop-restore, `onData` (steers, compacting), plan approval
  with a mode, queue-started turns, todos, the queue store and the event dispatch, the chat view's dock and
  announcements.
- **Owned.** `W/composables/{useChatSession,useServerEvents}*`, `W/stores/chat-queue*`,
  `W/components/chat/{ChatView,chat-context}*`.
- **Read-only highlights.** UI.md 7.6, 7.25, 7.26, 10.6, 11.6, 14; `.tmp/p9-designs/web.md` 1.2, 1.6; API.md 4.24, 5.10,
  7; `SH/util/agent-state.ts`; `W/components/chat/agent/todos.ts` (W9.10's, frozen signature).
- **Tasks.**
  1. **W9.9-T1 Store** — `useChatQueueStore`: `items(chatId)`, `fetch`, `enqueue` (`POST`), `cancel` (`DELETE`; 404 →
     "Already sent to the agent."), `markDelivered`, `applyEvent` (`queue.changed`, `chat.deleted`), `refreshLoaded`.
     *Accept:* `chat-queue.test.ts`.
  2. **W9.9-T2 Submit and stop** — `submit(input)` → `'sent' | 'queued'` (enqueue while busy, resuming or the chats
     store says running; 409 `run-idle` → `whenIdle()` then `send()`); `queue`, `cancelQueued(id)`; `stop()` resolves
     with the stop result's `dropped`; `ChatView.onSubmit` drops its busy check (`ChatView.vue:254`) and announces
     "Message queued"; `onStop` hands the dropped items to `composer.restoreQueued` (only the stopping tab restores
     them; other tabs just see the queue empty through `queue.changed`). *Accept:* session and ChatView tests.
  3. **W9.9-T3 `onData`** — `useChat` `onData`: a `data-steer` marks the item delivered; `data-activity` drives
     `compacting` ("Compacting conversation…"); `ChatView` announces "Conversation compacted" once per new marker.
     *Accept:* session tests with a streamed fake.
  4. **W9.9-T4 Plan approval** — `approve()` (`:1086-1105`) with `decision.planMode` sets `toolMode` first, then
     `addToolApprovalResponse({ id, approved, reason })`; a denial sends the feedback as `reason` and keeps `plan`;
     announcements "Plan approved. Permission mode: Accept edits." / "Feedback sent. The agent keeps planning."
     *Accept:* session tests (the call order).
  5. **W9.9-T5 Queue-started turns** — `run.started` with `origin: 'queue'` and a `userMessageId` not on the shown path
     → `refresh()` then `resumeStream()` (deferred until idle when busy); `useServerEvents` dispatches `queue.changed` /
     `chat.deleted` and refetches the loaded queues on reconnect. *Accept:* session tests with two sessions (two tabs);
     `useServerEvents.test.ts`.
  6. **W9.9-T6 Todos and the dock** — `todos` via `todoState` over the shown path; `ChatView` shows `TodoStrip` (when
     `todoStripVisible`) and `QueuedMessages` (with `waitingForApproval`) above the composer. *Accept:* ChatView tests.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W9.10 agent-tools-web

- **Mission.** The plan card, the todo row and strip, the task blocks, the preliminary status, the `plan` permission
  mode and Shift+Tab, `/mode plan`, and the share bodies of the agent tools.
- **Owned.** `W/components/chat/{agent,parts}/**`, `W/components/chat/composer/{permission,PermissionMenu,mode-cycle,
  slash-commands}*`, `W/components/share/ShareToolRow*`.
- **Read-only highlights.** UI.md 7.2, 7.3, 7.8, 7.11, 7.25, 7.27, 10.6, 11.6, 12, 13.10, 14, 15;
  `.tmp/p9-designs/web.md` 1.2 – 1.4; `SH/schemas/agent.ts`, `SH/util/agent-state.ts`.
- **Tasks.**
  1. **W9.10-T1 Plan card** — `PlanApprovalCard` (`AiConfirmation`, `border-info/50 bg-info/5`, `role="group"` "Plan
     ready for review"; the plan region `max-h-[45dvh]`, `tabindex=0`, `role="region"` "Plan"; the textarea "Feedback
     for the agent (optional)", 1 – 4 rows, at most `LIMITS.approvalReasonMaxChars`; buttons "Keep planning" · "Approve,
     ask before edits" · "Approve, accept edits"; no implicit Enter approval; every control disabled while sending;
     mobile `flex-col-reverse sm:flex-row`, full width, ≥ 40 px); `PlanBody` (Markdown + "Your feedback: …"). *Accept:*
     `PlanApprovalCard.test.ts` (each button's payload, the cap, disabled while sending).
  2. **W9.10-T2 `ToolPart` and rows** — the plan card when awaiting an `exit_plan_mode` decision (payload `planMode`,
     `reason`); the preliminary status (running while streaming, stopped otherwise; `ToolPart.vue:133-134` maps every
     `output-available` to done today); `exit_plan_mode` row (`ClipboardList`, argument = the plan's first heading,
     "Plan ready for review", "Kept planning" with `PencilLine`, "Approved · Accept edits" / "Approved · Ask");
     `todo_write` row (`ListTodo`, argument = the current `activeForm`, summary "3/7", body `TodoList`; never
     auto-expanded); a value that fails its schema falls back to the generic row. *Accept:* `ToolPart.test.ts`,
     `tool-row.test.ts`.
  3. **W9.10-T3 Todos** — `TodoList` (`role="list"`, `Circle` / `CircleDot` / `CircleCheck`, sr prefixes "Done:" / "In
     progress:" / "To do:", `todo-item[data-status|data-index]`); `TodoStrip` (collapsed "3/7 · Running tests" or "All
     tasks done", a `Progress` w-16 hidden below `sm`, h-9 / 40 px on coarse pointers; expanded ≤ 40 dvh;
     `localStorage['hf-todo-expanded']`; toggle "Show tasks, 3 of 7 done" / "Hide tasks", `aria-expanded`,
     `aria-controls`; `todo-strip[data-state|data-count|data-value]`); `todos.ts` (`todoState`, `todoStripVisible`:
     visible while running, or while the latest reply's list is unfinished). *Accept:* tests.
  4. **W9.10-T4 Task blocks** — `TaskBlock` / `TaskBody` (store-free) / `TaskStepRow`: a two-line collapsible (line 1:
     chevron, `Telescope` explore / `Bot` general, "Explore" / "Agent", the description, "{n} tool calls · 41s", the
     status; line 2 `data-slot="task-live"` `aria-hidden`: the last step while running, the report's first sentence when
     done); expanded: the prompt, the steps (last 50, "{k} earlier steps were not kept"), the report Markdown
     (`task-report`), the meta line "{model} · 18.2K tokens · $0.004 · 41s", a failure alert; a denied step's tooltip
     "Sub-agents can't ask for approval, so this was skipped."; the trigger's name "Explore sub-agent: {description},
     running, 4 tool calls"; status running = preliminary + streaming, stopped = preliminary + not streaming or
     `aborted`; an output that does not parse renders the generic `ToolPart`. *Accept:* tests (running, done, failed,
     stopped, limit, denied step, parallel blocks stack).
  5. **W9.10-T5 Permission and Shift+Tab** — `plan` in `TOOL_MODE_OPTIONS` (`ClipboardList`, "Plan", "Explore and plan;
     change nothing until you approve the plan", `text-info`), offered like `edits`; `PLAN_NEEDS_PROJECT` "Plan mode
     works in project chats."; `PermissionMenu` `aria-keyshortcuts="Shift+Tab"` while the cycle is on; `nextToolMode`
     (Ask → Accept edits → Plan → Ask in project chats, Ask only outside, Auto / Off → Ask); `useModeCycle` takes
     Shift+Tab only without other modifiers, outside IME composition, with `shiftTabModes` on, the permission menu
     visible, no slash / mention menu open and ≥ 2 modes, and announces "Permission mode: Plan"; otherwise it returns
     false (native focus move, no keyboard trap); Alt+P stays. *Accept:* `mode-cycle.test.ts`, `permission.test.ts`,
     `PermissionMenu.test.ts`.
  6. **W9.10-T6 Slash** — `/compact` comes from `GET /commands` (no client code); `/mode plan` outside a project chat →
     "Plan mode works in project chats."; the `/mode` help lists `plan` only in project chats. *Accept:*
     `slash-commands.test.ts`.
  7. **W9.10-T7 Share** — `ShareToolRow` renders `TaskBody` / `TodoList` / `PlanBody` when tool details are shared, the
     labels "Sub-agent", "Updated tasks", "Plan" without them. *Accept:* `ShareToolRow.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W9.11 transcript-web

- **Mission.** The compaction divider and dimming, the steer note, the compacting shimmer, the context ring text, the
  rewind visibility for sub-agent edits, and the share view of the new parts.
- **Owned.** `W/components/chat/{ChatTranscript,ChatMessage,MessageActions,chat-format}*`,
  `W/components/chat/{compaction,steer}/**`, `W/components/chat/composer/{ContextRing,context-usage}*`,
  `W/components/share/{SharedMessage,SharedChatView,share-view}*`.
- **Read-only highlights.** UI.md 7.1, 7.12, 7.15, 7.24, 7.26, 10.6, 11.6, 13.10, 14; `.tmp/p9-designs/web.md` 1.1, 1.6,
  1.8; `SH/util/agent-state.ts` (`compactionMarkers`).
- **Tasks.**
  1. **W9.11-T1 `chat-format`** — the block kinds `compaction`, `steer`, `task`; `data-activity` is never a block.
     *Accept:* `chat-format.test.ts`.
  2. **W9.11-T2 Divider and dimming** — `compactionLayout(messages)` over `compactionMarkers` (cached per message);
     `CompactionDivider` ("Conversation compacted" / "Conversation compacted automatically" / "Context compacted during
     this response"; "Show summary" / "Hide summary"; meta "{n} messages summarized · 182K → 9K tokens" hidden below
     `sm`; expanded: "Focus: …", the summary Markdown with Copy, the footnote "The model sees this summary instead of
     the messages above."; `role="group"` with the label, the rules `aria-hidden`, the toggle `aria-expanded` /
     `aria-controls`; the summary `max-h-[50dvh]` on mobile; `compaction-divider[data-kind|data-variant|data-count]`);
     rows before the cut get `data-compacted` + `opacity-70` (restored on hover / focus-within); inside a reply with an
     in-run marker the blocks before it are dimmed; the `v-memo` keys cover it. *Accept:* tests (manual, auto, in-run,
     several markers, a branch without the marker shows no dimming).
  3. **W9.11-T3 Steer note** — `SteerNote` (right-aligned `bg-muted/70 rounded-2xl` bubble, `max-w-[85%]`, files as
     chips, `role="note"`, sr "You said while the agent worked:", `steer-note[data-message-id]`). *Accept:* tests.
  4. **W9.11-T4 Compacting shimmer** — a streaming reply while `compacting` shows `AiShimmer` "Compacting conversation…"
     instead of "Thinking…". *Accept:* `ChatMessage.test.ts`.
  5. **W9.11-T5 Context ring** — the footer per `autoCompact` (on: "Older messages are summarized automatically near the
     limit. Type /compact to do it now."; off: "Automatic compaction is off. Older messages are left out near the
     limit."); the ring drops after `/compact` (the reply's `contextTokens`). *Accept:* tests.
  6. **W9.11-T6 Rewind visibility** — `ChatTranscript` (`hasFinishedEdit`, `:176-178`) also counts a `task` output with
     a done `write_file` / `edit_file` step. *Accept:* `ChatTranscript.test.ts`.
  7. **W9.11-T7 Share view** — `share-view.ts` / `SharedMessage`: the server-split steer messages render as user
     bubbles; `task` / `todo_write` / `exit_plan_mode` tool parts go to `ShareToolRow` (W9.10 renders the bodies); no
     compaction on share pages. *Accept:* `share-view.test.ts`, `SharedChatView.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W9.12 settings-stabilization-web

- **Mission.** The Agent settings section and the Shift+Tab switch, the changes sheet fix, and "Decided per call" in
  the Plugins tools table.
- **Owned.** `W/components/settings/{agent/**,GeneralSettings*,general*}`, `W/components/workspace/ChatWorkspace*`,
  `W/composables/useChangesPanel*`, `W/components/plugins/detail/PluginToolsTable*`.
- **Read-only highlights.** UI.md 9.4, 9.11, 7.21, 13.10, 15; `.tmp/p9-designs/web.md` 1.7; API.md (settings, `GET
  /tools`); `W/components/settings/SettingsModelSelect.vue`.
- **Tasks.**
  1. **W9.12-T1 Agent section** — `AgentSettingsSection` ("Agent", "Long chats and sub-agents."): Automatic compaction
     (`Switch`, `settings-auto-compact`, "Summarize older messages when a chat nears the model's context window. When
     off, older messages are left out instead."), Compaction model (`SettingsModelSelect`, `allowNone` "Same model as
     the chat", `settings-compaction-model`, key `compactModelRef`), Sub-agent model (the same select,
     `settings-subagent-model`; the warning "{model} can't call tools, so sub-agents can't use it." for a model without
     `capabilities.tools`), Sub-agent max steps (1 – 200, `settings-subagent-max-steps`, "How many tool calls one
     sub-agent may chain (1–200)."; the `maxSteps` save and validation rules). *Accept:* tests (each field persists
     through `settings.update`, rollback with a toast on failure, validation).
  2. **W9.12-T2 Shift+Tab switch** — "Shift+Tab switches the permission mode" (`settings-shift-tab-modes`, "In the
     composer, Shift+Tab cycles Ask, Accept edits and Plan. Off: Shift+Tab moves focus.") after the Alt shortcuts field;
     the default permission mode select lists Plan like Accept edits (`general.ts`). *Accept:*
     `GeneralSettings.test.ts`.
  3. **W9.12-T3 Changes sheet** — `hf-changes-open` is written only on an explicit toggle or close (a viewport below
     1024 px no longer clears the saved open state). *Accept:* `useChangesPanel.test.ts`, `ChatWorkspace.test.ts`
     (narrow and back keeps the pane open).
  4. **W9.12-T4 Tools table** — `PluginToolsTable` shows "Decided per call" for function policies (instead of
     `dynamic`) and the effective override from `GET /tools`. *Accept:* `PluginToolsTable.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### Wave P9-A ownership

These globs are the plan's table plus the additions listed in "Deviations" (open point 14). The audit cannot express
"except": every `types.ts` of `S`, `S/chat/{steps,markers,model-history,agent-scope}.ts`,
`S/builtin-plugins/core-agent/index.ts`, the mock models, `SH/util/{agent-state,mentions}.ts` and the P9-0b stub props
stay frozen despite the globs; `S/services/project-files/types.ts` matches W9.6's glob (frozen). W9.8's composer files
are enumerated so that every composer file has exactly one owner.

```json
{
  "wave": "P9-A",
  "agents": {
    "W9.1": [
      "apps/server/src/chat/{compaction/**,context*,pipeline*,prepare*,commands*,notices*}"
    ],
    "W9.2": [
      "apps/server/src/chat/{queue,steer,runs,index}*",
      "apps/server/src/http/routes/{chat,chat-queue}{,.test}.ts"
    ],
    "W9.3": [
      "apps/server/src/chat/{approval,modes}*",
      "apps/server/src/builtin-plugins/core-agent/{exit-plan-mode,common}*"
    ],
    "W9.4": [
      "apps/server/src/chat/{params,usage,title}*",
      "apps/server/src/builtin-plugins/core-agent/todo-write*",
      "apps/server/src/services/chats/index*"
    ],
    "W9.5": [
      "apps/server/src/chat/{subagent/**,tools*,history*}",
      "apps/server/src/builtin-plugins/core-agent/task*"
    ],
    "W9.6": [
      "apps/server/src/services/project-files/**",
      "apps/server/src/http/routes/project-files{,.test}.ts",
      "apps/server/src/testing/fake-project-files*"
    ],
    "W9.7": [
      "apps/server/src/services/shell-rules/**",
      "apps/server/src/services/checkpoints/{restore-scope,changes-common}*",
      "apps/server/src/http/routes/{changes,tools}{,.test}.ts",
      "apps/server/src/mcp/tools*",
      "apps/server/src/services/shares/**",
      "apps/server/src/services/chats/{export,import,text}*"
    ],
    "W9.8": [
      "apps/web/app/components/chat/composer/{ChatComposer,ComposerAddMenu,ComposerAttachments,DropOverlay,EffortMenu,ImageOptionsMenu,MentionMenu,MicButton,ModelPicker,ModelPickerList,ModelPickerTrigger,RecordingIndicator,SendStopButton,SlashMenu}{.vue,.test.ts}",
      "apps/web/app/components/chat/composer/{attachments,composer-test-utils,dictation,effort,image-options,mention-menu,model-picker,nuxt-imports,send-key,types}{.ts,.test.ts}",
      "apps/web/app/components/chat/queue/**",
      "apps/web/app/composables/{useFileMentions,useProjectFiles,useComposerAttachments,useComposerDraft,useComposerShortcuts}*"
    ],
    "W9.9": [
      "apps/web/app/composables/{useChatSession,useServerEvents}*",
      "apps/web/app/stores/chat-queue*",
      "apps/web/app/components/chat/{ChatView,chat-context}*"
    ],
    "W9.10": [
      "apps/web/app/components/chat/{agent,parts}/**",
      "apps/web/app/components/chat/composer/{permission,PermissionMenu,mode-cycle,slash-commands}*",
      "apps/web/app/components/share/ShareToolRow*"
    ],
    "W9.11": [
      "apps/web/app/components/chat/{ChatTranscript,ChatMessage,MessageActions,chat-format}*",
      "apps/web/app/components/chat/{compaction,steer}/**",
      "apps/web/app/components/chat/composer/{ContextRing,context-usage}*",
      "apps/web/app/components/share/{SharedMessage,SharedChatView,share-view}*"
    ],
    "W9.12": [
      "apps/web/app/components/settings/{agent/**,GeneralSettings*,general*}",
      "apps/web/app/components/workspace/ChatWorkspace*",
      "apps/web/app/composables/useChangesPanel*",
      "apps/web/app/components/plugins/detail/PluginToolsTable*"
    ]
  },
  "allow": [
    "docs/ROADMAP.md",
    "docs/DECISIONS.md",
    "AGENT.md",
    "pnpm-lock.yaml"
  ]
}
```

A composer file that a P9-A agent creates and that is not in W9.8's lists (or in W9.10's / W9.11's globs) is a CCR:
the coordinator adds it to the wave file at the gate.

### Wave P9-A cross-agent contracts

The props below are frozen in the P9-0b stubs or documented in UI.md 10.6; the server members in the frozen files.

| Producer → consumer | Contract |
|---|---|
| C26 → W9.1, W9.2, W9.3, W9.5 | `steps.ts` order (guard → steer → finalize), `session.inject`, `stepInjector`, `buildModelHistory`, `agentScopeOf`, the stub signatures (frozen) |
| W9.3 → W9.5 | `applyToolMode(tools, { toolMode, continuation })` and the `plan` row of `createToolApproval` (frozen signature; W9.5 tests against a fake) |
| W9.1 → W9.5 | the context guard in silent mode for children (`createContextGuard({ …, silent: true })`) |
| W9.2 ↔ W9.1 | W9.2's steer piece and W9.1's guard both run inside the C26 composer; the in-run messages of both equal `buildModelHistory` of the saved message |
| C23 → W9.1, W9.2, W9.4, W9.6, W9.8 – W9.11 | `findCompaction`, `compactionMarkers`, `splitSteers`, `latestTodos`, `mentionTokenAt`, `formatMention`, `scorePath`, `rankPaths` |
| C22 → W9.7, W9.11 | the `data-compaction` / `data-steer` shapes (export, import, share, divider, steer note) |
| C22 → W9.5, W9.10 | the `task` output shape (preliminary and final), the todo and plan schemas |
| C22 → W9.2, W9.9 | the queue DTOs, `queue.changed`, `run.started.origin` / `userMessageId`, `dropped`, 409 `run-idle` / `queue-full` / `exists` |
| C22 → W9.4, W9.12 | the settings keys `autoCompact`, `compactModelRef`, `subagentModelRef`, `subagentMaxSteps`, `shiftTabModes` |
| W9.6 → W9.8 | `GET /projects/:id/files` (`{ items, truncated, indexedAt }`), `POST …/attach` (201 `FileRef`, 400 / 404 / 413) |
| W9.7 → W9.12 | `GET /tools`: the effective override; `exit_plan_mode` refuses `allow` |
| W9.9 → W9.8 | `session.submit`, `session.queue`, `cancelQueued`, the dropped items handed to `restoreQueued` |
| W9.9 → W9.10, W9.11 | `session.approve({ planMode, reason })`, `session.todos`, `session.activity` (C25's interface, implemented by W9.9) |
| W9.10 → W9.9, W9.11 | `todoState` / `todoStripVisible`, `TodoStrip`, `TaskBlock`, `PlanApprovalCard` (frozen props) |
| W9.11 → W9.9 | `compactionLayout` (the "Conversation compacted" announcement keys on new markers) |

### Gate P9-A

1. `node scripts/audit-ownership.mjs .tmp/waves/P9-A.json`
2. Batch the CCRs → `nuxi prepare` → `pnpm check` → `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
3. `mv .tmp/e2e .tmp/e2e-old-p9-a` → probes (`.tmp/gates/P9-A/probe.mjs`, built on the P8-A harness: `startServer`,
   `client`, libsql `rows`, `check`, `newProject`, `uuidv7`, `msgId`; new helpers `chatStream(chatId, text, extra,
   onChunk)` (an incremental parse of the UI stream `data:` lines), `events(c).waitFor(type, pred, ms)` (an
   `/api/events` subscriber) and `approveAndContinue(c, chatId, toolName, { approved, mode, reason })` (rebuilt from
   `buildChatRequestBody`, checked once against `e2e/helpers/chat.ts`)) on probe servers 8896 (agent features), 8897
   (mentions) and 8898 (upgrade), `HF_DATA_DIR=.tmp/gates/P9-A/<run>/<name>`; loops run through `bash -c`; project
   folders in the probe servers' default roots:
   1. **Compaction** (`mock:compact`) — three turns containing `OLD-1`, then `/compact keep numbers` → exactly one
      `data-compaction` (`trigger: manual`, `focus: 'keep numbers'`) and one `compact` usage row; the next turn `seen?`
      answers `summary:yes` and `seen:` does not contain `OLD-1`; editing turn 2 (a sibling above the marker) answers
      `summary:no seen:OLD-1`; `autoCompact: true` with an oversized history → an automatic marker before the reply;
      `autoCompact: false` → no marker and the `context-trimmed` notice; a `loop 6` run → a marker between steps and the
      run finishes ("Loop finished after 6 steps."); `compactModelRef: 'mock:error'` → the run still answers, with the
      `compaction-failed` notice, and the stored history is unchanged; the Markdown export shows "Conversation
      compacted"; the share snapshot has no compaction part; a chat export → import round-trips the marker (the next
      `seen?` in the imported chat still answers `summary:yes`).
   2. **Plan mode** (project, `mock:plan`) — `toolMode: 'plan'` → `tools:` lists the read tools, `todo_write`, `task`
      and `exit_plan_mode`, no `write_file` / `edit_file` / `shell`; `read_file` / `list_directory` run without
      approval; `exit_plan_mode` ends the run with `awaitingApproval: true` and no file written; approve with `toolMode:
      'edits'` → `notes.txt` exists without another approval and a `workspace_changes` row exists; deny with feedback in
      `plan` → "Revising: <feedback>", no write; `mock:workspace` in `plan` gets no write tool; `PATCH
      /tools/exit_plan_mode { "override": "allow" }` → 400; approving with `toolMode: 'plan'` (and `off`) → 400 on
      `['toolMode']`; `defaultToolMode: 'plan'` round-trips through `PUT /settings`.
   3. **Todos** (`mock:todo`, `ask`) — no approval anywhere; `latestTodos` of the stored path = all three completed; a
      branch whose path ends before the last call shows the earlier state; `invalid` in the user text → the first
      `todo_write` (duplicate ids) ends as an error part and the run continues to "All 3 tasks done."; after `/compact`
      (`compactModelRef: 'mock:compact'`) the marker's `todos` holds the completed list (that the model then reads
      "Current todo list:" in the merged summary is W9.1's unit test).
   4. **Steer / queue** (`mock:steer`) — `steps 5`; `POST …/queue` during step 1 → 201 and `queue.changed` (1 item); at
      the boundary `queue.changed` with 0 items (`removed: delivered`), a `data-steer` between the steps, the final text
      lists the steer; queued during the last step → a server-started turn (`run.started.origin = 'queue'`, the path
      reads U/A/U/A, the new user message carries the queued id); `DELETE` before the boundary → 204, nothing injected,
      no new turn; Stop with a queued item → the stop result's `dropped` holds it and the queue is empty; 11 items → 409
      `queue-full`; unknown item → 404; an idle chat → 409 `run-idle`; a queued `FileRef` reaches the next turn (the
      server-started turn's stored user message holds the file part); a restart → `GET …/queue` is empty.
   5. **Sub-agents** (project, `mock:subagent`, `subagentModelRef: 'mock:subagent'`) — in `ask`: two parallel `task`
      calls, no `approval-requested` part anywhere, `pending_approval` 0, at least one preliminary
      `tool-output-available` before the final one, the parent quotes both reports; a child's `tools:` never contains
      `task`, `write_file` (in `ask`) or `shell`; in `edits` a `general` child with `write` writes, and its
      `workspace_changes` row carries the parent message id and a `<parent>/<child>` tool call id; `parallel 5` with the
      cap 3 → never more than 3 children overlap (start / end timestamps); Stop mid-children → aborted outputs and
      `GET /chat/:id/stream` answers 204; one `subagent` usage row per child; `subagentMaxSteps: 2` stops a `loop` child
      with status `limit`.
   6. **Mentions** (8897) — `?q=chk` ranks `checkpoint.txt` first; `limit` and `truncated`; a gitignored `dist/`,
      `node_modules` and `.git` are never listed; a hostile `.gitignore` returns within 2 s; attach `../x`, an absolute
      path, a link pointing outside, `.git/config`, `.env` → 400; an ok attach → 201 `FileRef` and `GET /files/:id`
      returns the bytes; a 6 MiB file → 413; a file written by `write_file` is found by the next search; an unknown
      project → 404; a missing project folder → 400.
   7. **Stabilization** — two concurrent identical `POST /shell-rules` → one 201 and one 409 `exists`; the same prefix
      global and in a project → both 201; a SQL-planted `allow` on an `execute` tool → `GET /tools` shows the override
      null.
   8. **Hygiene** — `git status --porcelain` of the repository is identical before and after `pnpm test`; the server
      logs hold no summary, steer / todo / plan text, child prompt or output, mention query or file content at `info`;
      only `mock:*` model refs in the usage rows.
   9. **Upgrade** (8898, a fresh copy of `.tmp/upgrade-v14`, real services) — the long v1.4 chat compacts automatically
      on its first `mock:compact` turn and answers; old tool parts and the rewind preview of the git project chat are
      unchanged; the queue is empty; old chats keep their `toolMode`; the rule and override fixes hold.
   10. **P8-A regression** — `node .tmp/gates/P8-A/probe.mjs ws git` green.
4. `pnpm test:e2e` (`chromium` + `mobile` + `tablet`; the feature specs come in P9-B) green.
5. `E2E_SCREENSHOTS=1 pnpm test:e2e --grep @screenshots` → review `.tmp/screenshots/{dark,light}/`.
6. `pnpm audit --prod --audit-level high` clean (the two ignored advisories excepted).
7. ROADMAP + wave log → commit `feat: add compaction, plan mode, steer queue and sub-agents`.

---

## Wave P9-B — feature e2e, docs, fix-ups

### Coordinator actions

- Before the launch: the P9-A checkpoint build for W9.13; W9.15 / W9.16 globs from the red P9-A gate items added to
  `.tmp/waves/P9-B.json` (launched only when needed); the P9-A reports handed to W9.14 as the digest
  `.tmp/waves/P9-A-notes.md` (contract facts, deviations, items marked "For W9.14").
- The final gate below; ROADMAP (every Phase 9 box, the backlog, the wave log); the memory file; push only when the
  user asks.

### W9.13 e2e-features (e2e 8891)

- **Mission.** End-to-end specs for compaction, plan mode, todos, sub-agents, mentions and the steer queue, mobile and
  tablet checks, screenshots of the new screens and full-frame README shots.
- **Owned.** `e2e/**`.
- **Read-only highlights.** UI.md 2.16, 7.24 – 7.27, 9.11, 12, 13.10, 14; PROVIDERS.md 8 ("Agent mocks (Phase 9)") (the five mock models);
  `playwright.config.ts`; `e2e/README.md`; `e2e/helpers/{chat,workspace,keyboard}.ts`.
- **Tasks.**
  1. **W9.13-T1 `core/compaction.spec.ts`** — `/compact` in the slash menu; running it shows the divider (`data-kind=
     manual`), dims the rows above (`data-compacted`), the summary toggle works; a reload keeps it; automatic compaction
     with `mock:compact` (`data-kind=auto`) and the ring drops; with `autoCompact` off the `context-trimmed` notice
     shows instead.
  2. **W9.13-T2 `core/plan-mode.spec.ts`** — the permission menu offers Plan in a project chat; Shift+Tab cycles and
     announces "Permission mode: Plan"; `/mode plan`; Plan is not offered outside projects; "Keep planning" with
     feedback → a second plan card ("Revising: …"); "Approve, accept edits" → `write_file` runs without a card and
     `notes.txt` is in the changes panel; "Approve, ask before edits" → a write approval card; with `shiftTabModes` off
     Shift+Tab moves focus.
  3. **W9.13-T3 `core/todos.spec.ts`** — the strip goes 1/3 → 3/3, hides after the run, expands to show the items; the
     row summary reads "3/3"; a reload keeps the row.
  4. **W9.13-T4 `core/subagents.spec.ts`** — two blocks run in parallel, the live line updates, expanding shows the
     steps and the report; Stop leaves them stopped; "Rewind files to here" covers a sub-agent's edit.
  5. **W9.13-T5 `core/mentions.spec.ts`** — `@pars` + Enter inserts the text and adds a project chip that is done; a
     folder drills down; no menu in a chat without a project; `a@b` does not open it; the error state (an unavailable
     folder).
  6. **W9.13-T6 `core/steer-queue.spec.ts`** — queue during a run (`composer-queue`, Enter); delivery as a `steer-note`;
     cancel before delivery; a message queued at the end of the run becomes the next turn and the tab follows it; Stop
     restores the composer (text + chips, the toast); a second page sees the queue.
  7. **W9.13-T7 Extensions** — `share` (steers as user messages, task / todo / plan bodies with tool details, no
     compaction), `keyboard` (Shift+Tab, Enter while running queues, Esc closes the mention menu first), `settings` (the
     Agent fields and the Shift+Tab switch persist).
  8. **W9.13-T8 Mobile and tablet** — `mobile/agent.spec.ts` (390 px: the dock fits, no horizontal scroll with a task
     block or a summary expanded, the plan buttons stack at ≥ 40 px, the mention menu fits); `mobile/changes` (the open
     state survives a narrow viewport); the tablet touch-target spec covers queue Edit / Cancel, the strip toggle, the
     task trigger, the plan buttons and mention items (≥ 40 px).
  9. **W9.13-T9 Screenshots** — `chat-plan-approval`*, `chat-todo-strip`*, `chat-subagents`, `chat-compacted`,
     `chat-steer`*, `composer-mention`*, `settings-general-agent` (dark + light; * = also mobile) and `@readme`
     full-frame shots for every README image (`chat-dark`, `chat-light`, `plugins-dark`, `provider-wizard-dark`,
     `settings-dark`, `workspace-dark`, `changes-panel-dark`; no crops).
  10. **W9.13-T10 README** — `e2e/README.md` lists the new specs and the `@readme` tag.
- **Verify.** `pnpm test:e2e --list`; slot runs (`HF_MOCK_PROVIDER=1 HF_OFFLINE=1 HF_PORT=8891
  HF_DATA_DIR=.tmp/W9.13/data node apps/server/dist/main.mjs`, `E2E_BASE_URL=http://127.0.0.1:8891 pnpm test:e2e`);
  three green runs of the new specs.

### W9.14 docs-final

- **Mission.** Reconcile every doc with the code and the agent reports.
- **Owned.** `README.md`, `.env.example`, `docs/**` except `DECISIONS.md` and `ROADMAP.md`.
- **Read-only highlights.** `.tmp/waves/P9-A-notes.md`, the code of every Phase 9 area.
- **Tasks.**
  1. **W9.14-T1 Reconcile** — API.md vs the route table and the implemented answers (`chatQueue`, `projectFiles`,
     `dropped`, the events, the agent tool schemas, preliminary outputs, the `exit_plan_mode` override refusal); UI.md
     13.10 vs `utils/testids.ts`, the contracts (10.6), the stores and composables (11.6), the copy (15), the shortcuts
     (12); ARCHITECTURE.md vs the implemented flows (5, 6.18 – 6.22, 8, the log fields); PLUGINS.md (1.3.0,
     `core-agent`, streaming tools); PROVIDERS.md 8 ("Agent mocks (Phase 9)") vs the mock models; the guide `agent-features.md`.
  2. **W9.14-T2 Status** — README "v1.5" (features: compaction, plan mode and todos, the steer queue and `@` mentions,
     sub-agents); `docs/assets/screenshots/` refreshed from the `@readme` shots at the final gate (the coordinator
     copies them).
  3. **W9.14-T3 This file** — what actually happened (status, "Deviations found while building", gate results per
     wave).
- **Verify.** `pnpm check:english`; `pnpm -F @harness-forge/shared test` (doc-coupled tests).

### W9.15 / W9.16 fix-ups

Launched only for red P9-A gate items (W9.15 server, W9.16 web), with the globs of those items.

### Wave P9-B ownership

```json
{
  "wave": "P9-B",
  "agents": {
    "W9.13": ["e2e/**"],
    "W9.14": [
      "README.md",
      ".env.example",
      "docs/API.md",
      "docs/UI.md",
      "docs/ARCHITECTURE.md",
      "docs/PLUGINS.md",
      "docs/PROVIDERS.md",
      "docs/guides/**",
      "docs/phases/phase-9-v1-5.md",
      "docs/assets/**"
    ]
  },
  "allow": [
    "docs/ROADMAP.md",
    "docs/DECISIONS.md",
    "AGENT.md",
    "pnpm-lock.yaml"
  ]
}
```

### Final gate

1. `node scripts/audit-ownership.mjs .tmp/waves/P9-B.json` → `pnpm install --frozen-lockfile` → `pnpm check` →
   `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
2. The P9-A probes again (after `mv .tmp/e2e .tmp/e2e-old-final`) plus the P8-A regression.
3. `for i in 1 2 3; do pnpm test:e2e || exit 1; done` (`chromium` + `mobile` + `tablet`), with the OS color scheme
   emulated as light; `E2E_SCREENSHOTS=1 pnpm test:e2e --grep @screenshots` → dark + light reviewed (the plan card, the
   strip, the task blocks, the divider, the queue and the mention menu on desktop and mobile); the README images copied
   from the `@readme` shots.
4. `pnpm audit --prod --audit-level high`; the two advisories re-checked with the P8-00 rule.
5. **Real v1.4 → v1.5 upgrade**: the `.tmp/v14` worktree build (`316319a`) seeds a fresh data directory with the full
   set (the K3 seed contents incl. the SQL duplicates and the stored `allow` on `shell`), stop it, start v1.5 on the
   same data directory → `0006` applied, everything intact, the old tool parts render, the long chat compacts and
   continues, plan mode, the queue and sub-agents work on the old project.
6. Docker (daemon permitting, else the CI `docker` job): boot on a copy of the v1.4 seed; `/compact`; a `mock:subagent`
   run in a project under `/data/workspaces`; a queue round trip (queue during a `mock:steer` run → a steer note).
7. `git status --porcelain` of the repository unchanged by `pnpm test`.
8. ROADMAP + wave log → commit `chore: final gate for harness-forge v1.5`; write the project memory (state, commits,
   user actions); push only when the user asks. The live provider suite stays the user's (paid).

---

## Outcome

Completed by the coordinator at the final gate ("audit" is the ownership audit of `scripts/audit-ownership.mjs`).

| Wave | Agents | Gate result | Commit |
|---|---|---|---|
| P9-00 | coordinator | CI on `316319a` green; advisories still unpatched (ignores kept, re-checked 2026-10-03); memory updated; `pnpm check` 8327 tests | (no commit) |
| P9-0a | coordinator (K1, K3 seed), C22, C23, D10, D11 | pending | `feat: add phase 9 contracts and docs` |
| P9-0b | coordinator (K3), C24, C25, C26, C27 | pending | `feat: add phase 9 schema, migration and skeletons` |
| P9-A | W9.1 – W9.12 | pending | `feat: add compaction, plan mode, steer queue and sub-agents` |
| P9-B + final gate | W9.13, W9.14 (W9.15 / W9.16 if needed), coordinator | pending | `chore: final gate for harness-forge v1.5` |

Fixes made by the coordinator at the gates, CCRs, follow-ups and deferred items: recorded here at the final gate.

---

## Risks

State before P9-0a.

| Risk | Mitigation |
|---|---|
| Compaction breaks the model history (a tool call split from its result, a provider rejects the sequence) | cuts at message / step boundaries only; the summary merged into a user message (no two user messages in a row); C23 tables + fuzz; the equivalence tests (in-run = rebuilt); the trimming fallback; stored messages never rewritten |
| Three features share `prepareStep` | one composer (`S/chat/steps.ts`) with a fixed order, complete and frozen in P9-0b; the pieces in separate files with separate owners |
| A steer races the run end | a synchronous take; `onReleased` after the release; a lost 409 race re-queues at the head; probe 4 |
| A server-started turn has no HTTP client | the tee + replay buffer; `run.started.origin` / `userMessageId`; the web refreshes and resumes; the two-page e2e |
| Sub-agents bypass approval or run away | the child approval = the parent's rules with ask → denied; `task` never in the child set (depth 1); the semaphore, the per-run cap, `subagentMaxSteps`, the 570 s deadline, abort through the run signal; usage rows; probe 5 |
| Plan-mode bypass (a hallucinated or third-party tool) | the server-side tool set and approval; the `allow` override refused; the continuation mode check; probe 2 |
| Mention traversal or a secret leak | `resolveWorkspacePath`, the sensitive rules, the `.git` refusal, links refused by the guard; probe 6 |
| Index cost on huge repositories | the walker caps, `truncated`, the TTL, invalidation on `workspace.changed`, a bounded project cache |
| Preliminary output volume in the replay buffer | the 250 ms throttle, ≤ 2000 values, capped values, steps ≤ 50 |
| A rough token estimate compacts too late | the 0.8 trigger with the real usage of the last step; the trimming fallback; a provider overflow retry stays in the backlog |
| New parts break consumers (share, export, import, search, the web) | the consumer list in the rules, a test per consumer owner; probes 1 and 4 |
| Shift+Tab hurts keyboard users | narrow conditions, native focus move otherwise (no trap), the `shiftTabModes` opt-out, Alt+P |
| `0006` deletes a wanted rule | exact duplicates only (same scope and prefix), the oldest kept; the upgrade test, the upgrade probe and the real upgrade |
| Hot files (`pipeline.ts`, `tools.ts`, `prepare.ts`, `approval.ts`, `useChatSession.ts`, `ChatComposer.vue`, `ToolPart.vue`, `ChatView.vue`) | one owner per wave; every mount and seam lands in P9-0b |
| W9.1 and W9.2 both inject at step boundaries | `stepInjector` and `RunSession.inject` complete in P9-0b (C26), so neither waits for the other |
| Count pins (routes 100, modules 27, events 13, settings 26, notices 7, the mock listing, builtin plugins) | C22 / C24 / C27 list them in their reports; the coordinator accepts them in the audit |
| A cached mock listing hides the new mocks | `.tmp/e2e` moved aside before every gate |
| The upgrade seed loses its project path when copied | the seed's project lives under `.tmp/gates/P9-0b/seed-roots` outside the data dir; probes run on fresh copies |
| Queue lost on a restart; queued file ids swept | documented (ADR-042, the guide); upload pins cover queued files |
| Share privacy (summaries, child prompts) | compaction parts never shared; task bodies only with tool details on |
| Wave size (12 + 4 skeleton agents) | the first cuts listed in P9-A; W9.15 / W9.16 fix-ups |
