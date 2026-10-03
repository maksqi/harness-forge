# Phase 8 — v1.4: Workspace 2.0

Part of the harness-forge build plan. Progress is tracked in `docs/ROADMAP.md` (coordinator only). Shared names come
from `docs/DECISIONS.md` (ADR-036 … ADR-039, the amendment notes on ADR-031, ADR-033 and ADR-035, and the contract
seed; it wins on conflict); endpoints and DTOs from `docs/API.md` (the `changes.ts` and `shell-rules.ts` endpoints, the
changes, git, rewind, restore and shell rule schemas, the shell output fields `endCwd` / `cwdNote` / `allowedBy`, the
`fileSweep` setting and `FileSweepStatus`, the `workspace.changed` event and the route key index); components, props,
store and composable signatures, shortcuts and test ids from `docs/UI.md` (the 1.2 amendment, the 2.15 wireframes, 7.21
changes panel, 7.22 rewind, 7.23 shell rules, 9.8, 9.10, 10.5, 11.5, 12, 13.9, 14); flows, tables and security rules
from `docs/ARCHITECTURE.md` (5, 6.2, 6.13, 6.15, the new 6.16 checkpoints and 6.17 changes and git, 7, 8, 10.9, 12);
the `mock:checkpoint` and `mock:shell` models from `docs/PROVIDERS.md` (8); the user guide
`docs/guides/using-projects.md`. The new UI.md and ARCHITECTURE.md sections are written by D9 in P8-0a, API.md by C17.

**Status (2026-10-03):** P8-00 is done (`1a95805`); P8-0a is in progress. "Deviations from the plan" lists where the
build differs from the design reports (the plan sections below already follow the reconciliation); "Outcome" at the
end of this file is written by the coordinator at the final gate.

Paths: `S` = `apps/server/src`, `W` = `apps/web/app`, `SH` = `packages/shared/src`.

## Goal

Ship v1.4: Workspace 2.0 (Claude Code parity for agent work on real files), plus a stabilization track.

- **Checkpoints and rewind** (ADR-036): before every agent `write_file` / `edit_file` (and before every server-side
  revert, rewind or undo) the file's previous state is stored content-addressed in `<dataDir>/checkpoints/` and
  journaled in `workspace_changes`; **Rewind files to here** on a user message restores every file the chat changed
  since that message was sent (time-based, across versions), with conflict detection (skip or force); every restore is
  one undoable batch (`wcb_` id). Shell changes and third-party plugin writes are not restorable: they are journaled
  as `shell` / `untracked` rows and listed in the rewind dialog. No git needed; the plugin API stays 1.2.0.
- **Changes panel and git** (ADR-037, amends ADR-031 and UI.md 1.2): one side panel in project chats (desktop right
  pane, a right sheet below 1024 px) with "This chat" (net changes from the journal) and "Git" (`git status` + diff
  against HEAD) views; a per-file **Revert** with confirmation that is itself reversible (snapshot first); no stage /
  commit. git runs only through one hardened runner (`S/workspace/git.ts`).
- **Sticky working folder** (ADR-038, amends ADR-033): every `shell` call is still a new process (same isolation,
  timeouts and group kill), but the folder it ends in is where the chat's next call starts (clamped to the project;
  derived from the last shell output on the active path). Environment variables do not persist.
- **Shell rules** (ADR-038): an allowlist of command prefixes per project plus a global list (`shell_rules`, `srl_`
  ids); a command runs without asking in the `ask` and `edits` modes when every segment matches a rule; `$`, backticks,
  redirections, subshells, globs, here-docs and env prefixes always ask; the parser is shared by web and server and
  fails closed. Rules are added from the shell approval card and managed in Settings → Projects.
- **Automatic file sweep** (ADR-039, amends ADR-035): the opt-in setting `fileSweep` (`off` | `daily` | `weekly`)
  runs the ADR-035 cleanup from a timer; the reference scan also reads plugin data loosely.
- **Stabilization**: screen-reader text for tool row summaries, `DiffView` props instead of a slot and fall-through
  attributes, the legacy fake files service, the audit advisories re-checked, the Phase 7 ROADMAP bookkeeping, the stale
  "cd does not persist" texts.

Out of scope (ROADMAP backlog): the `.gitignore` ReDoS heuristic on the main thread, OS-level sandboxing of the shell,
the shell on Windows, Alt+V on Firefox / Windows, the live suite with `HF_LIVE_MEDIA`, syntax highlighting in diffs,
stage / commit from the changes panel, a terminal pane, a persistent shell process (environment variables that stick),
restoring shell changes (whole-tree snapshots), removing the two ignored audit advisories before patched releases
ship, multi-user accounts, child-process isolation for code plugins, a plugin registry, knowledge / RAG, desktop / CLI
clients, video generation, audio attachments to chat models, declarative image and voice providers. Kept as documented
behavior: `GET /models?providerId=<unknown>` answers 404; `pendingApprovals` counts messages while `approvalsExpired`
counts tool parts.

Totals after Phase 8: routes 85 → **95** (`changes.list`, `changes.diff`, `changes.git`, `changes.revert`,
`changes.undo`, `changes.rewindPreview`, `changes.rewind`, `shellRules.list`, `shellRules.create`,
`shellRules.remove`; none needs fresh auth), route modules 23 → **25** (`changes`, `shellRules`), tables 16 → **18**
(`workspace_changes`, `shell_rules`), migration **`0005_workspace_checkpoints`** (CREATE TABLE / INDEX only, real
foreign keys with `ON DELETE CASCADE` to `chats` / `projects`), settings keys 20 → **21** (`fileSweep`, default `off`),
SSE types 11 → **12** (`workspace.changed`), ADR-036 … ADR-039 (+ amendment notes on ADR-031, ADR-033, ADR-035), ids
`srl_` (shell rule) and `wcb_` (change batch), data dir `checkpoints/<aa>/<sha256>`, the test-only variable
`HF_TEST_FILE_SWEEP_DELAY_MS`, mock models `mock:checkpoint` and `mock:shell`, 39 new test ids (UI.md 13.9), plugin API
unchanged (**1.2.0**), no new conflict reason, error code or notice code. Agents: 4 (P8-0a: C17, C18, D8, D9) + 3
(P8-0b: C19, C20, C21) + 11 (P8-A: W8.1 – W8.11) + 2 (P8-B: W8.12, W8.13; W8.14 / W8.15 only for red P8-A gate items),
in the Phase 5 wave method (ADR-016).

## Entry criteria

- v1.3 is on `main` (`8879e6e` final gate, pushed, CI green) plus `1a95805` (`docs: fix phase 7 roadmap
  bookkeeping`): `pnpm check` (6995 tests), `pnpm build` and e2e 77 passed (`chromium` + `mobile` + `tablet`).
- The approved plan and the design inputs exist in `.tmp/p8-designs/` (`plan.md`, `server.md`, `web.md`, `process.md`;
  the reconciliation in `README.md` is binding and wins over the three reports).
- K1 is done: DECISIONS.md carries ADR-036 … ADR-039, the amendment notes and the Phase 8 contract seed (the test-only
  variable, the data directory, ids, enumerations, the HTTP table with `changes.ts` / `shell-rules.ts`, events,
  settings, tables and migration `0005`, the mock models); ROADMAP.md has the Phase 8 section and the trimmed backlog;
  AGENT.md has the Workspace 2.0 facts, the git rules for agents, the new variable and the Phase 8 freeze additions.

## Exit criteria

- Every Phase 8 item in `docs/ROADMAP.md` is checked; every wave gate is green; the final checkpoint commit
  `chore: final gate for harness-forge v1.4` exists (pushed only when the user asks).
- `pnpm check` and `pnpm build` are green; the built-page CSP test passes with `HF_TEST_REQUIRE_WEB_BUILD=1`.
- `pnpm test:e2e` (projects `chromium` + `mobile` + `tablet`, OS color scheme emulated as light) is green 3× in a row,
  including the new specs `core/changes-panel`, `core/rewind`, `core/shell-rules`, `mobile/changes`, the extended
  `workspace-tools`, `share`, `data-maintenance`, `keyboard` and tablet touch-target specs; the `@screenshots` run (dark
  + light) was reviewed.
- The gate probes (Gate P8-A, repeated at the final gate on a fresh `.tmp/e2e`) are green.
- CI on `main` is green (`check`, `e2e`, `docker`, `audit`, `actionlint`); the advisory decision is recorded.
- A v1.3 data directory boots on v1.4 with every chat, secret, share and project intact: migration `0005` applied, old
  tool parts render, a rewind on a pre-v1.4 message reports nothing to restore, the Git view works, `fileSweep` is off.
- The Docker image runs `git --version`; the Git view works on the default root; a volume owned by another uid answers
  `refused` with the documented reason.
- `pnpm test` never calls a paid API, never touches the repository's `data/` or a folder outside a temp directory, and
  leaves `git status --porcelain` of the repository unchanged; `pnpm test:live` stays the user's.
- README status reads "v1.4".

Manual acceptance (coordinator, `HF_MOCK_PROVIDER=1 pnpm dev`):

- A project chat with `mock:checkpoint` → Alt+C opens the panel; "This chat" lists `checkpoint.txt` with its diff.
- A second turn → "Rewind files to here" on the second user message → the preview lists the file and the
  `mkdir -p mock-dir && cd mock-dir` command → Restore → the content is back; the toast's Undo works.
- Revert in the panel + Undo; a git project shows the Git view (branch, an untracked file, revert to HEAD).
- The shell approval "Always allow commands starting with `ls`" (This project) → the next `ls` runs without asking and
  its row shows the rule badge; `cd mock-dir` sticks (the terminal prompt shows `mock-dir`).
- Settings → Projects: the rules editor of a project and the global section; Settings → Data: the automatic cleanup
  switch persists and shows the next run.
- Mobile: the panel is a right sheet; Esc returns focus to the toggle.
- A v1.3 data directory boots on v1.4 with every chat, secret, share and project intact.

With real keys (the user, optional): "Refactor X, run the tests" in a project chat → rewind to before it.

## Steps

| Step | Owner | Output |
|---|---|---|
| P8-00 | coordinator | design reports → `.tmp/p8-designs`; CI on `8879e6e` green; ROADMAP bookkeeping (`1a95805`); advisory check; memory; the `backup/pre-trailer-rewrite` branch only with the user's approval |
| P8-0a | coordinator (K1, K2) + C17, C18, D8, D9 | decisions, ROADMAP, AGENT.md; every shared contract + 501 stubs + API.md; the shell command parser (complete); this file; every other doc |
| Gate P8-0a | coordinator | audit, frozen install, check, build, CSP test, 10 new routes mounted, e2e regression, `pnpm why typescript`, commit |
| P8-0b | coordinator (K3) + C19, C20, C21 | v1.3 upgrade copy, schema + migration `0005`, server and web skeletons, the git runner (complete), the mock models, FREEZE |
| Gate P8-0b | coordinator | audit, `nuxi prepare`, check, build, CSP test, e2e regression, v1.3 upgrade probe, FREEZE, commit |
| P8-A | W8.1 – W8.11 (one launch) | features |
| Gate P8-A | coordinator | CCR batch, `nuxi prepare`, check, build, probes, e2e, screenshots, audit, commit |
| P8-B | W8.12, W8.13 (+ W8.14 / W8.15 when the P8-A gate is red) | feature e2e, docs reconciliation |
| Final gate | coordinator | e2e ×3, v1.3 → v1.4 upgrade, Docker git, audit, ROADMAP, memory, commit |

## Deviations from the plan (binding)

The three design reports (`.tmp/p8-designs/{server,web,process}.md`) are superseded where the reconciliation list
(`.tmp/p8-designs/README.md`, items 1 – 18) disagrees with them:

1. **Routes follow `server.md`**: module `changes` (7: `GET /chats/:id/changes`, `GET /chats/:id/changes/diff`,
   `GET /chats/:id/git`, `POST /chats/:id/changes/revert`, `POST /chats/:id/changes/undo`, `GET /chats/:id/rewind`,
   `POST /chats/:id/rewind`) + module `shellRules` (3: `GET /shell-rules`, `POST /shell-rules`,
   `DELETE /shell-rules/:id`) → 95 routes / 25 modules. No `cleanupStatus` route: the sweep status rides on `GET /data`
   and `GET /data/cleanup` (`FileSweepStatus`). The web report's `api.workspace.*`, `api.chats.rewind*` and
   `api.data.cleanupStatus` calls and its DTOs (`WorkspaceFileChange`, `GitChanges`, `WorkspaceFileDiff`) are replaced
   by the route keys and the shared `ChatChanges`, `FileDiff`, `GitStatus`, `RewindPreview`, `RestoreResult`.
2. **Setting `fileSweep`** (`off | daily | weekly`), not `cleanupSchedule`.
3. **No rule edit**: remove + add. The web ids `allowlist-rule-edit` / `allowlist-rule-input` and the store `update`
   action are dropped.
4. **Undo is keyed by `batchId`** (`POST /chats/:id/changes/undo { batchId, conflicts }`), not `checkpointId`.
5. **Revert body** `{ source, path, expectedSha? }`; a disk state other than `expectedSha` → 409 `stale` (an existing
   conflict reason). No `force` on revert: the dialog warns when the file `changedOutside` and sends the `currentSha`
   it showed.
6. **`workspace.changed`** `{ projectId, chatId | null, batchId | null, source: 'tool' | 'rewind' | 'revert' | 'undo',
   paths ≤ 200 }` is also emitted for agent tool edits (coalesced to at most one event per second per chat), so the
   panel is live during a run (`server.md`'s "tool edits produce no event" is replaced).
7. **Shared parser names from `server.md`**: `parseShellCommand`, `parseShellRule`, `matchShellRules`,
   `suggestShellRules` in `SH/util/shell-command.ts` (the web report's `suggestShellRulePrefix`, `splitShellSegments`
   and `shellRulePrefixSchema` are not built).
8. **Web store `useShellRulesStore`** in `W/stores/shell-rules.ts` (not `useAllowlistStore` / `stores/allowlist.ts`).
9. **The Git view endpoint is chat-scoped** (`GET /chats/:id/git`), not project-scoped; the web store keys git data by
   chat id.
10. **Migration `0005_workspace_checkpoints`** (`pnpm db:generate --name workspace_checkpoints`; `process.md`'s
    `0005_checkpoints` is replaced); the plugin API stays 1.2.0.
11. **git `safe.directory` is not overridden**: dubious ownership → `refused` (documented for Docker bind mounts;
    `process.md`'s `-c safe.directory=<root>` option is rejected).
12. **Rewind / revert / undo → 409 `run-active`** (`details.chatId`) while **any** chat of the project runs.
13. **Shell output** gains `endCwd?`, `cwdNote?`, `allowedBy?: string[]` (the matched prefixes; the web report's
    `allowedBy: { prefix, scope } | null` is replaced, so `ToolRuleBadge` takes `prefixes`).
14. **Mock models**: `mock:checkpoint` (from `server.md`; it is also `process.md`'s "model that edits a file again on
    each turn") and `mock:shell` (the user text = one shell command; it replaces the web report's `cd sub && pwd`
    variant).
15. **Agent numbering from the plan**: C17 contracts, C18 parser, D8 / D9 docs; C19 server skeleton, C20 web skeleton,
    C21 git runner; W8.1 – W8.11; W8.12 e2e, W8.13 docs-final. `process.md`'s numbering (C18 server skeleton, C19 web,
    C20 git runner) and its W8.x scopes are replaced by the wave tables of this file.
16. **`suggestShellRules(command)`** returns one prefix per segment that needs a rule (deduplicated, in order; `cd`
    segments need none), or `[]` when the command always asks or a segment has no valid rule. The approval decision
    carries **`allowRules?: { prefixes: string[], scope: 'project' | 'global' }`** (not `allowRule`);
    `session.approve()` creates one rule per prefix (`POST /shell-rules`) before it answers. The card shows the
    suggested prefixes; a single prefix is editable.
17. **The P8-0a parser stub** (`SH/util/shell-command.ts`, exported from the package index) fixes the signatures:
    `parseShellCommand`, `parseShellRule`, `matchShellRules(command, rules)` (returns `cdTargets` for the caller to
    resolve; no `isCdInside` callback as in plan section 3.2), `suggestShellRules`. C18 may add `ShellAskReason`
    members (reported).
18. **Docs are split**: D8 writes this file; D9 updates UI.md, ARCHITECTURE.md, PLUGINS.md, PROVIDERS.md, the guides,
    README and `.env.example` (the plan had one docs agent, so P8-0a has four agents, not three).

Smaller replacements that follow from the list: the `DiffView` props are `stats?` + `lineNumbers?` (`process.md`'s
`additions?` / `deletions?` are replaced) and land with C20 (not C19); the spec names are `core/rewind.spec.ts`,
`core/shell-rules.spec.ts` and `mobile/changes.spec.ts` (`process.md`'s `core/checkpoints`, the web report's
`core/allowlist`, `mobile/changes-panel`); the screenshot `settings-projects-rules` is dropped (it is the same screen as
`settings-projects-allowlist`); the test id count is **39** (the web report's 41 minus the two edit ids; the plan said
"about 37").

Plan-level decisions (from the reports, kept by the plan):

- **Capture is a server-internal side channel** (a run scope bound to the tool call context by the host wrapper).
  Rejected: a plugin API 1.3.0 `recordEdit` (a public promise that in-process plugins writing with `fs` break anyway; a
  version bump and a mirror update for no new capability) and a snapshot in `wrapToolExecute` (it would guess paths from
  inputs, race with the tool's own read-modify-write and miss the after-state).
- **A separate blob tree** `<dataDir>/checkpoints/`, never `files/` (the file sweep deletes rowless blobs there, and
  project content must never be reachable through `/files/:id`); never in backups, exports or imports.
- **Rewind is time-based** ("the files as they were when message M was sent"); the server never moves the
  conversation: "Restore files and edit" = rewind + the existing edit / branch flow (ADR-023).
- **Shell rules are not settings** (a crafted backup must not grant shell rights) and are not in backups.
- **No fresh auth** on the 10 new routes (a session can already approve its own shell calls; ARCHITECTURE.md 10.9).
- **Never `git diff`**: diffs are computed by the server from the HEAD blob and the disk (`computeWorkspaceDiff`).
- **A right sheet** below 1024 px (a vaul drawer's drag-to-close fights long diff scrolling); **Alt+C** (Alt+D focuses
  the address bar on Windows, Mod+Shift+D bookmarks all tabs, Mod+\ fails on AltGr layouts); the pane width is stored
  in px (`localStorage['hf-changes-width']`, reka's `autoSaveId` stores percentages).
- **Docs** are written by D8 / D9 and C17 (API.md) in P8-0a and reconciled by W8.13 in P8-B; P8-A agents never edit
  docs. **Feature e2e specs** are written in P8-B by W8.12. **Every new web test id** is added by C20 in P8-0b, copied
  verbatim from UI.md 13.9; `W/utils/testids.ts` is frozen during P8-A.

Open points decided by D8 while writing this file (the coordinator confirms or changes them at Gate P8-0a):

- **Boot and shutdown order** (C19): `startDeps` = projects → **checkpoints** → installer recovery → plugins →
  catalog → MCP → **data** (last); `stopDeps` = **data** (first) → runs → **checkpoints** → plugins → MCP → catalog →
  events (the runs stop before the journal stops, the sweep stops before everything).
- **`killProcessGroup` is already exported** from `S/workspace/shell.ts` (verified on `1a95805`): C21 imports it and
  does not edit `shell.ts`.
- **Shared git test helper**: C21 writes `S/workspace/git.test-util.ts` (`hasGit()`, a temp repository helper that
  runs `git init` / commit with `-c user.name=… -c user.email=…` and `HOME` / `GIT_CONFIG_GLOBAL` pointed at the temp
  folder); W8.2 and W8.3 use it.
- **Fakes for parallel work**: C19 adds a `CheckpointBlobStore` interface to `S/services/checkpoints/types.ts` and an
  in-memory fake in `S/testing/`, so W8.2 / W8.3 test restore and listing without W8.1's real store (journal rows go
  into the in-memory test database; the real round trip is probed at Gate P8-A).
- **Ownership additions**: W8.8 also owns `W/components/app-shell/chat-nav/palette*` (the palette items are built in
  `palette.ts`); C20 also owns `W/utils/testing/**` in P8-0b (C17 owns `fixtures.ts` in P8-0a).
- **The upgrade seed's project** lives under `HF_WORKSPACE_ROOTS=<repo>/.tmp/gates/P8-0b/seed2-roots` (project
  `git-demo`), outside the data dir, so the copied data dir keeps a valid project path; every upgrade probe runs on a
  fresh copy of `.tmp/upgrade-v13`, so the seed stays at v1.3 for the later probes (the project folder itself is
  shared; probes may change its files).
- **`revertible`** in `ChatChanges` is true when the base state can be restored: `stored`, or `missing` for a file the
  chat created (restored by deleting it); `too-large` / `evicted` bases are not revertible.
- **`allowedBy`** is set whenever the whole command matched the run's rules (whatever the permission mode), else it is
  absent.
- The workspace store carries no rewind members (P8-0b, C20 followed UI.md 11.5): `RewindDialog` calls
  `api.changes.rewindPreview` / `api.changes.rewind` itself; the store keeps `fileDiff`, `revert`, `undo`.

### Deviations found while building (P8-0a – P8-B)

The coordinator records them here at each gate from the agent reports; the code and the reconciled docs
follow these, not the task text further down.

- **P8-0a**: C18 added `ShellAskReason` `syntax` / `escape` and `ShellRuleRejectReason` `shell-builtin`; `&>/dev/null`
  asks (dash backgrounds `cmd &>/dev/null`); `>&M` only for M 0–2. Timestamps in the new DTOs are epoch-ms.
- **P8-0b (C20)**: UI.md 10.5 / 11.5 won over this file's C20 section: `ChangesFileRow` takes `row: ChangesRow` +
  `chatId`; `ChangesEmpty` reasons use `GitUnavailableReason`; `RevertFileDialog` takes `row` + `expectedSha?` and
  emits `reverted: [result, path]`; `AllowlistEditor` takes `{ projectId }` only; the workspace store entry type is
  `ChangesEntry`, without `entries()` / `ChangesFileEntry`, with `fileDiff(chatId, source, path, opts)`,
  `revert(chatId, input)`, `undo(chatId, batchId)` and no rewind members; the shell rules store uses `applyEvent`
  (not `dropProject`).
- **P8-A** (details in `.tmp/waves/P8-A-notes.md`, for W8.13): `journaledWrite(c, root, { tool, path },
  produce(before, resolved))` records only when the run scope, the journal scope and `c.workspace` share the project;
  a failed before-blob store keeps the write and records `before_state = evicted`; the chat pipeline builds the run
  scope in `chat/scope.ts` (`createRunScope`, fallbacks: no journal / empty rules / `.` on errors) and records `shell` /
  `untracked` rows before the `tool.after` hooks; `initialShellCwd` and the web's `currentShellCwd` skip finished
  outputs without `endCwd` (the web returns `null` for the project folder); `allowedBy` is absent when no rule matched
  (e.g. a command that is only `cd`); the shell's policy is a function, so `GET /tools` shows `policy: null` for it; a
  chat revert of a `too-large` / `evicted` base answers 200 with the file skipped as `unavailable` (API.md), not 400;
  a chat without a project answers 400 "This chat has no project."; git-view failures on revert / diff are 400 on
  `['source']`; the rewind preview lists shell commands newest first (the last 50); the workspace store also refreshes
  the open chat's This chat view on `workspace.changed`; the rewind result toast lives in `ChatView`
  (`REWIND_DIALOG_HOST` hands 404 / 409 from the dialog to the view); `ChatTranscript` gained the optional prop
  `projectId`; the Storage cleanup status uses `data-state` `off | never | done | skipped | failed`; the automatic
  sweep's busy retry is `min(10 min, check interval)` and its skip logs at info; the plugin data budget counts entries;
  `mock:checkpoint` nests `mock-dir/mock-dir` on a second turn (the sticky folder).

## Rules for every Phase 8 agent

This section is the canonical copy of the agent rules (`.tmp/p8-designs/agent-rules.md` was its draft).

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
  `resolveWorkspacePath` first); never through the shell runner, `exec`, a shell string or a git library. The MCP stdio
  transport keeps its own argument-array spawn. `S/security/process-spawn.test.ts` enforces the list.
- **Git in tests**: never a git write command on the harness-forge repository. Tests run `git init` inside their own
  `realpath(mkdtemp())` folder, set the author with `-c user.name=… -c user.email=…`, point `HOME` /
  `GIT_CONFIG_GLOBAL` at the temp folder and use `describe.skipIf(!hasGit())`. Malicious-repository tests touch
  sentinel files inside their temp folder only.
- **Every path a workspace tool touches** resolves through the frozen `resolveWorkspacePath` (`S/workspace/paths.ts`);
  no `fs` call on a model-supplied or user-supplied path without it.
- **Checkpoint blobs and journal rows only through the checkpoint store** (`S/services/checkpoints/**`): nothing else
  writes `<dataDir>/checkpoints/`; no snapshot goes into `files/` or a `files` row; revert, rewind and undo write
  through the journaled writer / restore primitive.
- Every new text or JSON column goes into `REFERENCE_SOURCES` or `UNSCANNED_COLUMNS` (`S/services/data/references.ts`).
- The shell command matcher (`SH/util/shell-command.ts`) fails closed: anything it cannot tokenize asks; `$`, backticks,
  redirections (other than to `/dev/null` or fd duplication), process substitution, subshells, globs and here-docs
  always ask.
- **Logging**: never log key material, secret values, file contents, diffs, tool inputs or outputs, or shell commands
  at `info`; the shell logs the exit code, duration and byte counts at `info` and the command only at `debug`,
  redacted; git arguments and project-relative paths only at `debug`.
- Timers are `unref()`-ed and cleared in `stop()`; tests use fake timers (no real sleep over 2 s).
- Contracts: DTOs and route keys only from `@harness-forge/shared`, plugin shapes only from
  `@harness-forge/plugin-sdk`; server services only through the frozen `types.ts` interfaces. A missing member, a
  contract change, a frozen-file edit or a **new test id** is a CCR in your report (file, current shape, proposed shape,
  reason) plus a local adapter so you can keep working.
- New components are imported explicitly by path (`import DiffView from './tools/DiffView.vue'`): the coordinator runs
  `nuxi prepare` only at the gates, so auto-import types do not know files created mid-wave.
- The props, emits and root test ids of the P8-0b stub components and the signatures of the new stores, composables
  and `useChatSession` additions are frozen after P8-0b: implement behind them; a change is a CCR.
- No doc edits in P8-A: write "For W8.13" notes (facts, deviations, suspected doc errors) into your report.
- Web unit tests: Nuxt composables come through a local `nuxt-imports.ts` that tests `vi.mock`; every password prompt
  goes through `useFreshAuth()` (UI.md 8.4).
- e2e uses only `.tmp/e2e/workspaces/*` for project folders.
- Verify before reporting — server: `pnpm -F @harness-forge/server test` · `pnpm typecheck`; shared:
  `pnpm -F @harness-forge/shared test`; plugin SDK: `pnpm -F @harness-forge/plugin-sdk test`; web:
  `pnpm -F @harness-forge/web test` · `pnpm -F @harness-forge/web typecheck:fast`; all: `pnpm check:english`; lint
  your files with `pnpm exec eslint --fix <your files>`.
- Report ≤ 300 words in the AGENT.md format (tasks, files, commands + results, CCRs, dependency requests, open issues,
  suggested ROADMAP updates).

## FREEZE in Phase 8

In force since earlier phases (AGENT.md): `packages/*/src`, `S/app.ts`, `S/db/schema.ts`, `apps/server/drizzle/**`,
every `*/types.ts` under `S`, `S/builtin-plugins/index.ts`, `W/layouts/**`, store signatures in `W/stores/**`,
`apps/web/nuxt.config.ts`, every `package.json` and config file, `W/components/{ui,ai-elements}/**`, the CSS design
tokens in `W/assets/css/main.css`, `W/utils/testids.ts` (Phase 5), the Phase 5 – 7 additions (the services `types.ts`
files, `S/workspace/paths.ts`, `S/services/chats/approvals.ts`, the `main.ts` boot hooks, the props of the P6-0b and
P7-0b stub components, the `projects` store, the `useChatSession` additions of Phase 7).

P8-0a and P8-0b open the frozen files **only** for their named owners:

- P8-0a: K1 — `AGENT.md`, `docs/DECISIONS.md`, `docs/ROADMAP.md`; C17 — `SH/**` (not `util/shell-command*`),
  `S/app.ts`; C18 — `SH/util/shell-command{,.test}.ts` (complete; its signatures are the P8-0a stub's).
- P8-0b: K3 — `S/db/schema.ts` + `apps/server/drizzle/**`; C19 — `S/types.ts`, `S/deps.ts` (factories and the
  start / stop order), `S/env.ts`, `S/services/{checkpoints,shell-rules}/types.ts` (new),
  `S/services/{data,files}/types.ts`; C20 — `W/utils/testids.ts`, the store signatures of `W/stores/workspace.ts` and
  `W/stores/shell-rules.ts` (new), the props of the P7-0b stubs `DiffView` (`stats`, `lineNumbers`), `TerminalOutput`
  (`cwd`) and `ToolApprovalCard` (the `decide` payload `allowRules`), the `useChatSession` interface additions;
  C21 — nothing frozen (`S/workspace/git.ts` is new and frozen after the gate).

Added to the freeze after Gate P8-0b:

- `S/services/{checkpoints,shell-rules}/types.ts` (new) and the P8-0b versions of `S/services/{data,files}/types.ts`,
  `S/types.ts`, the `S/deps.ts` start / stop order, `S/env.ts` (`DataPaths.checkpoints`, `Env.testFileSweepDelayMs`);
- `S/workspace/run-scope.ts`, `S/workspace/file-lock.ts` (complete, C19) and `S/workspace/git.ts` (complete, C21);
- `SH/util/shell-command.ts` (complete, C18; a behavior change after the gate is a CCR);
- the props, emits and root test ids of the P8-0b stub components (`W/components/workspace/**`: `ChatWorkspace`,
  `ChangesToggle`, `ChangesPanel`, `ChangesFileRow`, `ChangesFileDiff`, `ChangesEmpty`, `RevertFileDialog`,
  `RewindDialog`, `AllowRuleOption`, `AllowlistEditor`, `AllowlistDialog`, `GlobalAllowlistSection`) and
  `W/components/chat/parts/tools/ToolRuleBadge.vue`; the `DiffView` props; the prop-only additions
  `MessageActions.canRewind` + `rewind`, `ChatMessage.canRewind` + `rewind`, `ChatTranscript` `rewind` + the exposed
  `startEdit` / `focusRewind`, `TerminalOutput.cwd`, the `allowRules` pass-through of `ToolApprovalCard`, `ToolPart`
  and `ChatMessage`;
- the `workspace` store (`useWorkspaceStore`, including its `ChangesFileEntry` view model), the `shell-rules` store
  (`useShellRulesStore`) and `useChangesPanel`;
- the `useChatSession` additions `cwd` and `ToolApprovalDecision.allowRules`;
- the `TOOL_APPROVAL_CONTEXT` additions `projectId()` and `shellCwd()`;
- the Phase 8 test ids (UI.md 13.9) in `W/utils/testids.ts`;
- the mock models `mock:checkpoint` and `mock:shell` (PROVIDERS.md 8).

No CCR is pre-approved for P8-A; the coordinator batches CCRs at Gate P8-A.

---

## Wave P8-00 — stabilization start (done)

1. **Design inputs** — the three Plan reports extracted into `.tmp/p8-designs/{server,web,process}.md`, the approved
   plan copied to `plan.md`, the reconciliation written to `README.md`, the rules draft to `agent-rules.md`.
2. **CI** — `origin/main` = `8879e6e`: the CI run (check, e2e, docker, actionlint) and the Audit run are green; no
   open pull requests.
3. **ROADMAP bookkeeping** — the Phase 7 boxes W7.2, W7.3, W7.4, W7.6, W7.7, W7.8, W7.10, W7.11, W7.12 and W7.15
   ticked; the backlog trimmed (the rejected "`modelName` required" item dropped, the Phase 8 items moved into the
   Phase 8 section) → `1a95805` (`docs: fix phase 7 roadmap bookkeeping`).
4. **Audit advisories** — `gh api /advisories/GHSA-86w9-cpqp-85rv` (node-forge) and `…/GHSA-vfj7-8cjw-p6xm` (braces)
   both answer `first_patched_version: null`; the latest releases are still node-forge 1.4.0 and braces 3.0.3; both
   arrive only through `nuxt` (listhen; nitropack → globby → micromatch), never under `@harness-forge/server`. Decision
   rule: (a) a patched release at least one day old inside the parent's range → `pnpm update -r --depth Infinity` and
   drop the ignore; (b) a patch only outside the range in the same major → a scoped override; (c) a parent release that
   drops the package → update the parent (minor / patch in the nuxt chain only); (d) no patch → keep both ignores and
   re-check at the final gate; (e) either package under `@harness-forge/server` must be fixed before v1.4. Result:
   (d), the ignores stay (re-check date in the ROADMAP backlog).
5. **Memory** — "v1.3 shipped and pushed; Phase 8 = Workspace 2.0". The local `backup/pre-trailer-rewrite` branch
   (`5a7d90d`) is deleted only after the user approves.
6. **Baseline** — `pnpm check` green with 6995 tests.

---

## Wave P8-0a — decisions, docs, contracts

Four agents in one launch (C17, C18, D8, D9) after K1; K2 runs alongside.

### Coordinator actions

- **K1 (done)** — `docs/DECISIONS.md`: ADR-036 … ADR-039, the amendment notes on ADR-031 / ADR-033 / ADR-035, the
  contract seed (the test-only variable, the data directory, ids, the plugin API note, enumerations, the conflict
  reasons note, the HTTP table, events, settings, tables, migration `0005`, the mock models). `docs/ROADMAP.md`: the
  Phase 8 section (one box per agent) and the trimmed backlog. `AGENT.md`: the Workspace 2.0 facts, the git exception
  for tests in rule 5, `HF_TEST_FILE_SWEEP_DELAY_MS`, the Phase 8 freeze additions. The parser stub
  `SH/util/shell-command.ts` (signatures only) and its export from `SH/index.ts`.
- **K2** — no dependency expected: git has been in the Docker image since Phase 7, and the parser, the runner and the
  checkpoint store are local code. Any package need is a DEPENDENCY REQUEST.
- Ownership file `.tmp/waves/P8-0a.json` (below).

### C17 contracts (k2)

- **Mission.** Write every shared contract of Phase 8, the ten new routes as 501 stubs and `docs/API.md`, keeping
  `pnpm check` green.
- **Owned.** `SH/**` (not `util/shell-command*`), `docs/API.md`, `S/app.ts`, `S/http/routes/{changes,shell-rules}.ts`
  (new 501 stubs), `S/testing/api-samples.ts`, `S/http/routes-mounted.test.ts`, the route-table-driven security tests
  (`S/http/middleware/{session-auth,fresh-auth}.test.ts`, `S/security/{fresh-auth-routes,secret-leaks,
  request-guards}.test.ts`), `W/utils/testing/fixtures.ts`, and every fixture or count pin that needs the new required
  fields (listed in the report; the coordinator accepts them in the audit as `C17-compile-fixes`).
- **Read-only highlights.** `.tmp/p8-designs/**` (the README reconciliation is binding), `docs/DECISIONS.md`,
  `SH/util/shell-command.ts` (C18), `SH/api/routes.test.ts` and `contract.test.ts` (doc-coupled: API.md section 8 and
  the DECISIONS module table), `SH/schemas/dto.test.ts` (the settings key count).
- **Tasks.**
  1. **C17-T1 Ids, limits, enumerations** — `srl_` + 16 (`SHELL_RULE_ID_PATTERN`, `shellRuleIdSchema`,
     `createShellRuleId()`), `wcb_` + 16 (`CHANGE_BATCH_ID_PATTERN`, `changeBatchIdSchema`, `createChangeBatchId()`);
     `LIMITS` += `checkpointFileMaxBytes` (8 MiB), `checkpointProjectMaxBytes` (512 MiB), `checkpointMaxAgeMs` (30 d),
     the rule caps (200 rules per scope, prefix ≤ 200 characters) and the changes / git / rewind caps of the plan
     (changes list 500 files, line counts for the first 200 text files ≤ 256 KiB, diff sides ≤ 1 MiB, git status 2000
     files, git timeout 15 s, git stdout 8 MiB, rewind preview 500 files, untracked lists 50 each, event paths 200,
     journal command 1000 characters; C17 names them and lists the names in API.md 3); enums
     (DECISIONS "Enumerations"): workspace change `kind`, before-state, `workspace.changed` source, change view source
     `chat | git`, conflict handling `skip | force`, `fileSweep` mode. *Accept:* id, limit and enum tests.
  2. **C17-T2 `schemas/changes.ts` (new)** — `chatChangesSchema` (`{ available, reason: 'no-project' |
     'folder-unavailable' | null, projectId, files: { path, status: added | modified | deleted | unchanged, edits,
     changedOutside, revertible, added, removed, lastEditAt }[], truncated, untracked: { shellCommands, toolCalls } }`;
     `added` / `removed` nullable), `fileDiffQuerySchema` (`{ source, path }`), `fileDiffSchema` (`{ source, path,
     status, binary, tooLarge, diff: WorkspaceDiff | null, currentSha: string | null, baseAvailable }`),
     `gitStatusSchema` (`{ available, reason: no-project | folder-unavailable | git-missing | not-a-repo | refused |
     timeout | failed | null, branch, head, prefix, files: { path, origPath, status: modified | added | deleted |
     renamed | untracked | conflicted | typechange, staged, unstaged }[], truncated }`), `changesRevertBodySchema`
     (strict `{ source, path, expectedSha? }`), `changesUndoBodySchema` (strict `{ batchId, conflicts }`),
     `rewindPreviewQuerySchema` (`{ messageId }`), `rewindPreviewSchema` (`{ messageId, files: { path, action:
     unchanged | restore | delete | unavailable, conflict, edits }[], untracked: { shellCount, shell: { command, at,
     messageId }[], tools: { tool, at, messageId }[] }, truncated }`), `rewindBodySchema` (strict `{ messageId,
     conflicts }`), `restoreResultSchema` (`{ batchId: string | null, restored: string[], deleted: string[],
     unchanged: string[], skipped: { path, reason: conflict | unavailable | refused | failed, message }[] }`).
     *Accept:* valid and invalid samples (strictness, caps, the sha format, a path with a control character refused).
  3. **C17-T3 `schemas/shell-rules.ts` (new)** — `shellRuleSchema` (`{ id, projectId: string | null, prefix, createdAt
     }`), `shellRuleListSchema` (`{ items }`), `shellRuleCreateSchema` (strict `{ projectId: id | null, prefix: 1 – 200
     characters }`; the server validates the rule again through `parseShellRule`), `shellRuleParamsSchema`. *Accept:*
     samples.
  4. **C17-T4 Shell output** — `shellToolOutputSchema` += `endCwd?` (project-relative, `.` = the project folder),
     `cwdNote?`, `allowedBy?: string[]`. *Accept:* a v1.3 shell output (none of the fields) still parses.
  5. **C17-T5 Settings** — `fileSweep` (`off | daily | weekly`, default `off`, not fresh) → `SETTINGS_KEYS` 21.
     *Accept:* a settings document without the key parses with the default; `dto.test.ts` at 21.
  6. **C17-T6 Data** — `fileSweepStatusSchema` (`{ mode, lastAttempt: { at, status: done | skipped | failed, reason:
     plugin-data-limit | error | null, files, diskBytes } | null, nextRunAt: timestamp | null }`);
     `dataSummarySchema.fileSweep` (required) and `.checkpoints?` (`{ bytes, blobs }`);
     `dataCleanupPreviewSchema` += `fileSweep`, `pluginData`; `dataCleanupResultSchema` += `pluginData` (`complete |
     partial`; C17 fixes the enum). *Accept:* samples; a v1.3 cleanup preview is not required to parse (server DTO).
  7. **C17-T7 Event** — `workspace.changed` in `SERVER_EVENT_TYPES` (12) with its data schema (`{ projectId, chatId |
     null, batchId | null, source, paths ≤ 200 }`). *Accept:* `parseServerEvent` keeps it; the event-type count pin 12.
  8. **C17-T8 Route table** — `ApiModule` += `changes`, `shellRules`; keys `changes.list`, `changes.diff`,
     `changes.git`, `changes.revert`, `changes.undo`, `changes.rewindPreview`, `changes.rewind`, `shellRules.list`,
     `shellRules.create` (201), `shellRules.remove` (204); none `fresh` → **95** routes, 25 modules. *Accept:*
     `routes.test.ts` (API.md section 8 index + the DECISIONS module table) and `contract.test.ts` at 95.
  9. **C17-T9 `docs/API.md`** — the two modules, every new schema, the shell output fields, `fileSweep`,
     `FileSweepStatus` in `GET /data` / `GET /data/cleanup`, the event, every answer of the ten routes (400
     `validation_error` with the `openWorkspace` message for writes without a project or with an unavailable folder;
     `available: false` + reason on the GETs; 400 for a non-user `messageId`; 409 `run-active` with `details.chatId`;
     409 `stale`; 409 `exists`; 400 for a refused rule; 404), the `PATCH /tools/:name` 400 for `override: 'allow'` on
     an `execute` tool, the 95-route index in the parsed format.
  10. **C17-T10 Stubs and compile fixes** — `S/app.ts` mounts `changes` and `shellRules`; the ten routes answer `501
      not_implemented` (body, query and params validation may answer 400 first); `api-samples.ts`; the route-table
      security tests follow; `W/utils/testing/fixtures.ts` and every other fixture get `fileSweep: 'off'` and the data
      summary `fileSweep`; the server data summary returns the `off` status until W8.7 (a compile fix, reported).
      *Accept:* `routes-mounted.test.ts` green (no new route answers 404); `pnpm check` green.
- **Tests.** Schema tests for every new DTO; route-table tests; the updated route-driven security tests.
- **Verify.** Shared, server and web commands.

### C18 shell command parser (k3)

- **Mission.** Implement the shared parser, matcher and suggester behind the P8-0a stub signatures, complete and
  tested (it is frozen after Gate P8-0b and used by W8.4, W8.6, W8.10 and W8.11).
- **Owned.** `SH/util/shell-command{,.test}.ts`.
- **Read-only highlights.** ADR-038; `.tmp/p8-designs/plan.md` 3.2, `server.md` F, README items 16 – 17;
  `SH/schemas/workspace.ts` (`WORKSPACE_LIMITS`, the 16 KiB command cap).
- **Tasks.**
  1. **C18-T1 `parseShellCommand`** — a tokenizer with single quotes, double quotes holding only literal text, and
     backslash escapes; segments split on `&&`, `||`, `;`, `|` and an unquoted newline (`\n` operator). **Always ask**
     (`ok: false` with a `ShellAskReason`): any `$`; backticks; `( ) { }`; `&`, `|&`; a redirection other than `N>&M`,
     `>/dev/null`, `N>/dev/null`, `&>/dev/null`; `<`, `<<`, `<<<`, `<(`, `>(`; unquoted `* ? [`; a word starting with
     `~` or `#`; shell keywords, `!`, `[[`, `((`; an env-assignment prefix (`FOO=1 cmd`); more than 32 segments;
     control characters; an unterminated quote; an empty command. *Accept:* one table row per construct (quoted globs
     and operators are literal and parse; a `$` or a backtick asks wherever it appears).
  2. **C18-T2 `parseShellRule`** — tokens and a canonical text (single spaces); refused: empty, over 200 characters,
     anything that is not plain words (an operator or an always-ask character), a first word that runs its arguments
     as a command (`sh bash zsh dash ksh fish eval exec source . command builtin env sudo doas su xargs nohup nice
     timeout time watch stdbuf chroot setsid ssh parallel`), a single-word interpreter or downloader rule (`node python
     python3 ruby perl php deno bun npx pnpx bunx`), `cd`. *Accept:* a table with every refused form and its message.
  3. **C18-T3 `matchShellRules(command, rules)`** — every segment must start with the tokens of a rule (`pnpm test`
     matches `pnpm test --run x`, not `pnpm testx` and not `pnpm -C x test`; words compared after unquoting; the command
     word is literal: `pnpm` ≠ `./pnpm`); `cd <literal>` segments need no rule and are returned in `cdTargets` (the
     caller resolves them in order, each relative to the previous one); `cd`, `cd -`, `pushd`, `popd` never match;
     `matched` unique in first-match order, `unmatched` the raw segments. *Accept:* table tests, including compound
     commands where one segment fails.
  4. **C18-T4 `suggestShellRules(command)`** — README item 16: one prefix per segment that needs a rule (deduplicated,
     in order; `cd` segments none); the command word, plus the subcommand for multi-command tools (`git npm pnpm yarn
     cargo go docker …`), plus the script name after `run` / `exec`; `[]` when the command always asks or a segment has
     no valid rule; every suggestion passes `parseShellRule` and matches its segment. The stub's doc comment ("most
     specific first") is rewritten to these semantics. *Accept:* `pnpm test --filter x` → `['pnpm test']`; `ls -la` →
     `['ls']`; `pnpm run build && ls` → `['pnpm run build', 'ls']`; `bash -c x` → `[]`.
  5. **C18-T5 Fuzz** — random input (a seeded generator) never throws, and `matchShellRules` never answers `allowed`
     for a command containing `$`, a backtick or a redirection outside the allowed `/dev/null` forms.
- **Tests.** The tasks above (`shell-command.test.ts`).
- **Verify.** `pnpm -F @harness-forge/shared test`; `pnpm check:english`; eslint on the two files.

### D8 phase doc (k1)

- **Mission.** Write this file so P8-0b, P8-A and P8-B agents can build against it.
- **Owned.** `docs/phases/phase-8-v1-4.md` (new).
- **Tasks.**
  1. **D8-T1 Phase doc** — goal, totals, criteria, the binding deviations, the rules for every agent, the FREEZE list,
     every wave with owned globs, tasks with acceptance criteria, ownership JSON, cross-agent contracts, gates and
     probes, risks.
- **Verify.** `pnpm check:english`.

### D9 docs (no server)

- **Mission.** Update the user-facing and architecture docs for Phase 8 so P8-0b and P8-A agents can build against
  them.
- **Owned.** `docs/UI.md`, `docs/ARCHITECTURE.md`, `docs/PLUGINS.md`, `docs/PROVIDERS.md`, `docs/guides/**`,
  `README.md`, `.env.example`.
- **Tasks.**
  1. **D9-T1 UI.md** — principle 1.2 amended (one changes panel in project chats) and the "never in a side pane"
     wording of 2.14 / 7.19; the new 2.15 wireframes (desktop pane, mobile sheet); the new 7.21 changes panel, 7.22
     rewind and 7.23 shell rules (the approval card option, the rule badge, the cwd prompt); 9.8 (Automatic cleanup),
     9.10 (Allowed commands); the new 10.5 contracts and 11.5 modules (stores, `useChangesPanel`, the `useChatSession`
     additions, `TOOL_APPROVAL_CONTEXT`); 12 (Alt+C); the new 13.9 test ids (39); 14 (the tool row screen-reader labels,
     the panel focus rules, 40 px targets); 15 (copy).
  2. **D9-T2 ARCHITECTURE.md** — 5 (boot and shutdown order: checkpoints, the data service timer), 6.2 (`shellPolicy`,
     the refused `allow` override), 6.13 (sticky cwd, `journaledWrite`), 6.15 (the automatic sweep, the plugin data
     scan), the new 6.16 checkpoints and rewind and 6.17 changes and git, 7 (`checkpoints/`), 8 (tables and `0005`),
     10.9 (the git runner hardening, the rule risks), 12 (log lines).
  3. **D9-T3 PLUGINS.md** — the plugin API stays 1.2.0; `core-workspace` writes are journaled; tools of other plugins
     with workspace access `write` / `execute` are listed as untracked in the rewind dialog; MCP tools declare no
     workspace access (invisible to the journal); plugin data is scanned loosely by the file sweep.
  4. **D9-T4 PROVIDERS.md** — `mock:checkpoint` and `mock:shell` (8).
  5. **D9-T5 Guides** — `docs/guides/using-projects.md`: rewind, the changes panel, revert + undo, shell rules, the
     sticky working folder, the Docker `safe.directory` note; the automatic cleanup where the data guide covers cleanup.
  6. **D9-T6 README and `.env.example`** — features, the status "v1.4 in progress"; the
     `HF_TEST_FILE_SWEEP_DELAY_MS` comment (test-only, needs `HF_MOCK_PROVIDER=1`).
- **Verify.** `pnpm check:english`; `pnpm -F @harness-forge/shared test` (`manifest.test.ts` parses PLUGINS.md).

### Wave P8-0a ownership

The audit cannot express "except": `SH/util/shell-command*` matches C17's glob too (a warning; C18 owns it). C17 lists
the extra fixture files it had to touch in its report; the coordinator adds them to `C17-compile-fixes`.

```json
{
  "wave": "P8-0a",
  "agents": {
    "K1": ["AGENT.md", "docs/DECISIONS.md", "docs/ROADMAP.md"],
    "C17": [
      "packages/shared/src/**",
      "docs/API.md",
      "apps/server/src/app.ts",
      "apps/server/src/http/routes/changes.ts",
      "apps/server/src/http/routes/shell-rules.ts",
      "apps/server/src/testing/api-samples.ts",
      "apps/server/src/http/routes-mounted.test.ts",
      "apps/server/src/http/middleware/session-auth.test.ts",
      "apps/server/src/http/middleware/fresh-auth.test.ts",
      "apps/server/src/security/fresh-auth-routes.test.ts",
      "apps/server/src/security/secret-leaks.test.ts",
      "apps/server/src/security/request-guards.test.ts",
      "apps/web/app/utils/testing/fixtures.ts"
    ],
    "C18": [
      "packages/shared/src/util/shell-command.ts",
      "packages/shared/src/util/shell-command.test.ts"
    ],
    "D8": ["docs/phases/phase-8-v1-4.md"],
    "C17-compile-fixes": [],
    "D9": [
      "docs/UI.md",
      "docs/ARCHITECTURE.md",
      "docs/PLUGINS.md",
      "docs/PROVIDERS.md",
      "docs/guides/**",
      "README.md",
      ".env.example"
    ]
  },
  "allow": ["pnpm-lock.yaml"]
}
```

### Wave P8-0a cross-agent contracts

| Producer → consumer | Contract |
|---|---|
| C17 → C19, C20, C21, every P8-A agent | the DTOs, ids, limits, enums, route keys, the event and the setting of `@harness-forge/shared` |
| C18 → W8.4, W8.6, W8.10, W8.11 | `parseShellCommand`, `parseShellRule`, `matchShellRules` (`cdTargets` resolved by the caller), `suggestShellRules` |
| D8 → everyone | this file (owned globs, tasks, acceptance, gates) |
| D9 → C19, C20, every P8-A agent | UI.md 2.15, 7.21 – 7.23, 10.5, 11.5, 13.9; ARCHITECTURE.md 6.16, 6.17, 10.9; PROVIDERS.md 8 |

### Gate P8-0a

1. `node scripts/audit-ownership.mjs .tmp/waves/P8-0a.json`
2. `pnpm install --frozen-lockfile` → `pnpm check` → `pnpm build`.
3. `HF_TEST_REQUIRE_WEB_BUILD=1 pnpm -F @harness-forge/server exec vitest run src/http/static.test.ts`.
4. `pnpm start:e2e` → `curl -sf http://127.0.0.1:8899/api/health`; the ten new routes are mounted (run with `bash`:
   zsh does not word-split `$r`):
   ```sh
   b=http://127.0.0.1:8899/api; c=01920000-0000-7000-8000-000000000000
   m=msg_AAAAAAAAAAAAAAAA; s=srl_AAAAAAAAAAAAAAAA
   for r in "GET /chats/$c/changes" "GET /chats/$c/changes/diff?source=chat&path=a.txt" "GET /chats/$c/git" \
            "POST /chats/$c/changes/revert" "POST /chats/$c/changes/undo" "GET /chats/$c/rewind?messageId=$m" \
            "POST /chats/$c/rewind" "GET /shell-rules" "POST /shell-rules" "DELETE /shell-rules/$s"; do
     set -- $r; curl -s -o /dev/null -w "%{http_code} $1 $2\n" -X "$1" "$b$2"
   done   # 501, or 400 where validation runs before the stub (routes-mounted.test.ts covers the full matrix)
   ```
5. `pnpm test:e2e` → 77 passed (`chromium` + `mobile` + `tablet`).
6. `pnpm why typescript` (only 6.0.x).
7. ROADMAP + wave log → commit `feat: add phase 8 contracts and docs`.

---

## Wave P8-0b — schema, migration `0005`, skeletons, FREEZE

**Entry:** Gate P8-0a green. The coordinator lands K3 first; C19, C20 and C21 start in one launch once the migration
exists (C19's upgrade test needs it).

### Coordinator actions

- **K3 Schema and migration `0005`** —
  1. **(Done early, during P8-0a.)** A v1.3 build from a `1a95805` worktree (`.tmp/v13`) seeded
     `.tmp/gates/P8-0b/seed2-data` with `HF_WORKSPACE_ROOTS=<repo>/.tmp/gates/P8-0b/seed2-roots` (outside the data
     dir, so the copy keeps a valid project path) through `.tmp/gates/P8-0b/seed-v13.mjs` + `seed-kv.mjs`: a password
     (`probe-pass-123`); a provider key; an MCP header secret; a branched chat; a share link; a pending approval
     (`mock:tool-approval` in `ask`); a project `git-demo` (`git init` + one commit with the `-c user.name/-c
     user.email` flags) with a chat that ran `mock:workspace` in `auto`; a referenced upload and an orphaned one; a
     generated image (`mock:image`); a manual cleanup (`POST /data/cleanup`, so `_files.lastCleanup` is set); a
     `plugin_kv` value holding the orphan's file id (SQL on the stopped data dir). The data dir was copied to
     `.tmp/upgrade-v13` and the ids to `.tmp/upgrade-v13-ids.json` (never `.tmp/e2e`, which the gate migrates). Every
     later upgrade probe runs on a fresh copy of `.tmp/upgrade-v13`.
  2. `S/db/schema.ts`: table `workspace_changes` (`id` integer PK autoincrement; `chat_id` text NOT NULL references
     `chats.id` on delete cascade; `project_id` text NOT NULL references `projects.id` on delete cascade; `message_seq`
     integer NOT NULL; `message_id`, `tool_call_id`, `batch_id`, `tool`, `path`, `command` text; `kind` text NOT NULL;
     `before_state` text; `before_sha` text; `before_size`, `before_mode` integer; `after_sha` text; `after_size`
     integer; `created_at` integer NOT NULL) with the indexes `(chat_id, path, id)`, `(chat_id, message_seq)`,
     `(project_id, id)`, `(before_sha)`; table `shell_rules` (`id` text PK, `project_id` text references `projects.id`
     on delete cascade, null = global; `prefix` text NOT NULL; `created_at` integer NOT NULL) with an index on
     `project_id` (uniqueness and caps are enforced by the service).
  3. `pnpm db:generate --name workspace_checkpoints` → `apps/server/drizzle/0005_workspace_checkpoints.sql` + snapshot.
  4. Inspect the SQL: exactly two `CREATE TABLE` and five `CREATE … INDEX` statements. **Reject** any `DROP TABLE`,
     `__new_`, `PRAGMA foreign_keys` or `ALTER TABLE` of an existing table (foreign keys are on; a rebuild of `chats`
     would cascade-delete messages inside the migration transaction).
- **After C19, C20, C21** — `nuxi prepare`; the gate below; the FREEZE additions.
- Ownership file `.tmp/waves/P8-0b.json` (below).

### C19 server skeleton (k3)

- **Mission.** Freeze the server side of Workspace 2.0: the additive interfaces, the environment, the service types
  with stub modules whose function signatures are final, the complete run scope and file lock, the boot order, the
  column classification, the complete mock models, fakes and the database tests.
- **Owned.** `S/types.ts`, `S/deps*.ts`, `S/env*.ts`, `S/db/**` (except `schema.ts`), `S/services/checkpoints/**`,
  `S/services/shell-rules/**`, `S/services/{data,files}/types.ts`, `S/services/data/{index,references}*`,
  `S/workspace/{run-scope,file-lock}*`, `S/testing/**` (except `api-samples.ts`), `S/builtin-plugins/mock/**`.
- **Read-only highlights.** `.tmp/p8-designs/server.md` A – C, E, F, `process.md` A; ARCHITECTURE.md 5, 6.16, 6.17, 8;
  PROVIDERS.md 8; `SH/**` (C17's contracts); `apps/server/drizzle/0005_*.sql`; `S/services/files/gate.ts`
  (`createStoreGate`); `S/workspace/paths.ts`; `S/catalog/index.ts` (`scheduleCycle`, the `background` switch).
- **Tasks.**
  1. **C19-T1 Types (additive)** — `S/types.ts`: `AppServices.checkpoints: CheckpointService`,
     `.shellRules: ShellRuleService`; `S/env.ts`: `DataPaths.checkpoints` (`<dataDir>/checkpoints`),
     `Env.testFileSweepDelayMs: number | null` (`HF_TEST_FILE_SWEEP_DELAY_MS`, 1000 – 86,400,000, honored only with
     `HF_MOCK_PROVIDER=1`, otherwise null and a boot warning); `S/services/files/types.ts`: `FileSweepInput.signal?:
     AbortSignal` (checked between batches); `S/services/data/types.ts`: `DataService.start()` / `stop()`,
     `DataServiceOptions.background?` (default on, off under Vitest). *Accept:* `pnpm typecheck` green; `env.test.ts`
     (range, ignored without the mock flag with a warning).
  2. **C19-T2 `S/services/checkpoints/types.ts` (frozen after the gate)** —
     `CheckpointScope { chatId, messageId: string | null, projectId }`;
     `CheckpointJournal { write(input), recordShell(input), recordUntracked(input) }`: `write({ toolCallId, tool, root,
     resolved, produce, signal })` is the core of `journaledWrite` (before-state → `produce(before)` → blob → frozen
     `writeWorkspaceFile` → row, under the file lock) and returns the write result plus the before bytes the tool needs
     for its diff; `recordShell({ toolCallId, command })`; `recordUntracked({ toolCallId, tool })`;
     `CheckpointService { journal(scope): CheckpointJournal, listChanges(chatId): ChatChanges, fileDiff(chatId,
     query): FileDiff, gitStatus(chatId): GitStatus, revert(chatId, body): RestoreResult, undo(chatId, body):
     RestoreResult, rewindPreview(chatId, messageId): RewindPreview, rewind(chatId, body): RestoreResult, start(),
     stop(), prune(options?: { now? }): PruneResult, purge(), summary(): { bytes, blobs } }` (every member async);
     `CheckpointBlobStore { put(bytes) → sha, read(sha), has(sha), remove(sha) }` (the injected store of the restore
     and listing modules); `PruneResult` counts. C19 fixes the exact parameter types and lists them in its report.
     *Accept:* `pnpm typecheck`; the members match ARCHITECTURE.md 6.16 / 6.17.
  3. **C19-T3 `S/services/shell-rules/types.ts`** — `ShellRuleService { list(): ShellRule[], create(input:
     ShellRuleCreate): ShellRule, remove(id): void, forRun(projectId: string | null): ShellRuleSet }` (async);
     `ShellRuleSet` = the canonical prefixes of the global rules and the project's, read once per run (empty for a null
     project). *Accept:* `pnpm typecheck`.
  4. **C19-T4 Module stubs with final signatures** — `S/services/checkpoints/{index,store,journal-service,prune}.ts`
     (W8.1), `{plan,restore,rewind,revert,undo}.ts` (W8.2), `{changes,git-changes}.ts` (W8.3), `S/services/shell-rules/
     index.ts` (W8.6): each exports the functions its P8-A owner implements, with their final parameter and return
     types (for example `planRewind(rows, current)` and `planUndo(rows, current)` pure in `plan.ts`; `applyRestore(deps,
     plan, { kind, batchId, conflicts })` in `restore.ts`; `mapGitStatus(info, entries)` pure in `git-changes.ts`) and
     throws `not_implemented`; `createCheckpointService` composes them; `start()` creates `checkpoints/` (0700) and
     resolves; `journal()` returns a journal whose `write` writes without recording (so the tools keep working until
     W8.1); `shellRules.forRun()` resolves an empty set; `stop()` resolves. *Accept:* `deps.test.ts` "phase 8 skeleton"
     (the route-facing members answer `not_implemented`, `checkpoints/` exists 0700, a chat run still works).
  5. **C19-T5 Deps** — factories `createCheckpointService`, `createShellRuleService`; `startDeps` = projects →
     checkpoints → installer recovery → plugins → catalog → MCP → data (last); `stopDeps` = data (first) → runs →
     checkpoints → plugins → MCP → catalog → events. *Accept:* `deps.test.ts` checks both orders (a failing step still
     lets the next run).
  6. **C19-T6 Data service skeleton** — `S/services/data/index.ts`: no-op `start()` / `stop()`;
     `S/services/data/references.ts`: every column of `workspace_changes` and `shell_rules` in `UNSCANNED_COLUMNS`
     ("checkpoint journal / shell rules: ids, paths, commands, hashes; never a data/files id"). *Accept:* the
     schema-coverage test green.
  7. **C19-T7 `S/workspace/run-scope.ts` and `S/workspace/file-lock.ts` (complete)** — a module-private
     `WeakMap<object, WorkspaceRunScope>`, `bindRunScope(c, scope)`, `runScopeOf(c): WorkspaceRunScope | null`, scope
     `{ chatId, messageId, projectId, toolCallId, journal: CheckpointJournal | null, shellRules: ShellRuleSet,
     shellCwd: { current: string } }` (`shellCwd` is one shared object per run); `withFileLock(absolutePath, fn)`: a
     process-wide promise chain per resolved absolute path, released after a throw, the map entry removed when the
     chain is idle. *Accept:* tests: a context object without a binding → null, nothing reachable through the plugin
     context; two locked sections on one path serialize, on two paths run in parallel; a throw releases; no entry left
     after idle.
  8. **C19-T8 Mock models (complete)** — PROVIDERS.md 8: `mock:checkpoint` (`{ tools: true }`; the step comes from the
     workspace tool results after the last user message: `write_file checkpoint.txt` = "Turn <n>\n" (n = user messages
     on the path), `shell "mkdir -p mock-dir && cd mock-dir"`, `shell "ls"` (its stored `cwd` is `mock-dir`), then
     "Checkpoint done."; shell steps skipped when `shell` is not offered); `mock:shell` (runs the user message text as
     one `shell` command, then "Shell done: <stdout>"); a denied call → "The tool call was denied."; no tool offered →
     a short "not available" answer (C19 picks the text; PROVIDERS.md 8 records it); `MOCK_MODEL_IDS` and its test
     updated.
     *Accept:* `mock/index.test.ts` plans for every step, with and without the shell, denied, no tools.
  9. **C19-T9 Fakes** — `S/testing/**`: an in-memory fake `CheckpointService`, a fake `CheckpointBlobStore`, a fake
     `ShellRuleService`, `createTestApp({ checkpoints?, shellRules? })` options, the fake data service's no-op `start` /
     `stop`, a helper that inserts `workspace_changes` rows into the test database (W8.2 / W8.3 unit tests). *Accept:*
     `fakes.test.ts`.
  10. **C19-T10 Database tests** — `db.test.ts` expects 18 tables and both foreign keys; `upgrade.test.ts` migrates a
      temporary folder holding only `0000` … `0004` with chats and a project, then the real folder: `0005` is plain
      `CREATE TABLE` / `CREATE INDEX`, every chat and project survives, deleting a chat removes its `workspace_changes`
      rows, deleting a project removes its rows and rules while global rules stay. *Accept:* green.
- **Tests.** The tasks above.
- **Verify.** Server commands.

### C20 web skeleton (k4)

- **Mission.** Freeze the web side of Phase 8: every new test id, the stub components with their final props, emits
  and root test ids, the two stores, `useChangesPanel`, the mounts and emit chains, the `useChatSession` interface
  additions, the `workspace-tools.ts` helper stubs and the complete `DiffView` props.
- **Owned.** `W/utils/testids.ts`, `W/utils/testing/**`, `W/components/workspace/**` (stubs),
  `W/stores/{workspace,shell-rules}*`, `W/composables/{useChangesPanel,useServerEvents,useChatSession}*` (interfaces
  and dispatch only), `W/pages/chat/[id].vue`, `W/components/chat/{ChatHeader,ChatView,ChatTranscript,ChatMessage,
  MessageActions}*` (mounts and prop-only additions), `W/components/chat/parts/{ToolPart,ToolApprovalCard,
  tool-approval-context}*` (pass-through and the context type), `W/components/chat/parts/tools/**`.
- **Read-only highlights.** UI.md 2.15, 7.19, 7.21 – 7.23, 9.8, 9.10, 10.5, 11.5, 12, 13.9; `.tmp/p8-designs/web.md`
  B – H (with the reconciliation); `SH/schemas/{changes,shell-rules,workspace}.ts`; `SH/util/shell-command.ts`.
- **Tasks.**
  1. **C20-T1 Test ids** — the 39 ids of UI.md 13.9 in `utils/testids.ts` (key = the camelCase of the id) under a
     `// Workspace 2.0: changes, rewind, shell rules, cwd, automatic cleanup (Phase 8)` comment: `changes-toggle`,
     `changes-panel`, `changes-view-option`, `changes-refresh`, `changes-close`, `changes-resize`, `changes-summary`,
     `changes-file`, `changes-file-revert`, `changes-empty`, `changes-error`, `changes-revert-confirm`,
     `message-rewind`, `rewind-dialog`, `rewind-file`, `rewind-shell-command`, `rewind-force`, `rewind-restore`,
     `rewind-restore-edit`, `rewind-error`, `tool-approval-allow-rule`, `tool-approval-rule-prefix`,
     `tool-approval-rule-scope`, `tool-approval-rule-error`, `tool-row-rule`, `project-allowlist`, `allowlist-dialog`,
     `allowlist-section`, `allowlist-input`, `allowlist-add`, `allowlist-error`, `allowlist-rule`,
     `allowlist-rule-remove`, `allowlist-empty`, `terminal-cwd`, `terminal-cwd-change`, `data-cleanup-auto`,
     `data-cleanup-interval`, `data-cleanup-auto-status` (new data attributes `data-conflict`, `data-view`,
     `data-rule-id`). The Undo toasts reuse `toast-undo`, the palette item `command-palette-item`
     (`data-value="toggle-changes"`).
  2. **C20-T2 Stub components** — each renders its root test id and declares exactly (UI.md 10.5 wins where it is
     more precise):
     ```ts
     ChatWorkspace          { chatId: string; projectId: string | null }            // default slot: the ChatView
     ChangesToggle          { chatId: string; projectId: string | null }
     ChangesPanel           { chatId: string; projectId: string; variant: 'pane' | 'sheet' }   emits close
     ChangesFileRow         { change: ChangesFileEntry; view: ChangesView; open: boolean }
                            // emits update:open, revert
     ChangesFileDiff        { chatId: string; view: ChangesView; path: string }
     ChangesEmpty           { reason: 'none' | 'clean' | 'not-a-repo' | 'no-git' | 'refused' | 'unavailable' }
     RevertFileDialog       { open: boolean; change: ChangesFileEntry | null; view: ChangesView; chatId: string }
                            // emits update:open, reverted: [RestoreResult]
     RewindDialog           { open: boolean; chatId: string; messageId: string | null }
                            // emits update:open, restored: [RestoreResult, then: 'none' | 'edit']
     AllowRuleOption        { command: string; disabled?: boolean }
                            // v-model: { prefixes: string[]; scope: 'project' | 'global' } | null
                            // emits valid: [boolean]
     AllowlistEditor        { scope: 'project' | 'global'; projectId?: string | null }
     AllowlistDialog        { open: boolean; project: ProjectSummary | null }      emits update:open
     GlobalAllowlistSection {}
     ToolRuleBadge          { prefixes: string[] }                                   // parts/tools/ToolRuleBadge.vue
     ```
     `ChangesView` = `'chat' | 'git'`. The folders: `W/components/workspace/{ChatWorkspace.vue,changes/,rewind/,
     allowlist/}`. *Accept:* one stub mount test per component (root test id, props accepted).
  3. **C20-T3 Stores and composable** — `useWorkspaceStore` (`W/stores/workspace.ts`): state `chat:
     Record<chatId, Entry<ChatChanges>>`, `git: Record<chatId, Entry<GitStatus>>` (`Entry = { data, loading, error,
     loadedAt }`); getters `chatChanges(id)`, `changeCount(id)`, `gitStatus(id)`, `entries(id, view):
     ChangesFileEntry[]` (one view model for both sources: `{ path, origPath, status, added, removed, changedOutside,
     revertible, staged, unstaged }`); actions `fetchChatChanges(id, { force? })`, `fetchGit(id, { force? })`,
     `fileDiff({ chatId, source, path }, { signal? })`, `revertFile({ chatId, source, path, expectedSha? })`,
     `undo({ chatId, batchId, conflicts })`, `rewindPreview(chatId, messageId)`, `rewind(chatId, { messageId,
     conflicts })`, `applyEvent(event)`, `refreshLoaded()`. `useShellRulesStore` (`W/stores/shell-rules.ts`): state
     `items: ShellRule[]`, `loaded`, `loading`; getters `global`, `forProject(id)`, `countForProject(id)`; actions
     `fetchAll()`, `create({ projectId, prefix })`, `remove(id)`, `dropProject(id)` (no `update`). `useChangesPanel()`
     (a module singleton): `{ open, view, width, focusRequest, setOpen(value, { focus? }), toggle({ focus? }) }`
     backed by `hf-changes-open`, `hf-changes-view`, `hf-changes-width`. Inert bodies that type-check. *Accept:* store
     shape tests.
  4. **C20-T4 Mounts and chains** — `pages/chat/[id].vue` wraps `ChatView` in `ChatWorkspace` (`projectId =
     sessions.get(chatId)?.projectId.value ?? null`); `ChatHeader` mounts `ChangesToggle` between `ChatProjectChip` and
     `⋯`; `ChatView` mounts `RewindDialog` and provides `TOOL_APPROVAL_CONTEXT.projectId()` / `.shellCwd()` (the
     context type in `tool-approval-context.ts`); `MessageActions.canRewind?` + emit `rewind` → `ChatMessage`
     (`canRewind?`, re-emits) → `ChatTranscript` (emit `rewind: [messageId]`, exposes `startEdit(id)` and
     `focusRewind(id)`); `ToolPart` mounts `ToolRuleBadge` (renders nothing without `allowedBy`); the `allowRules`
     field in the `decide` payload of `ToolApprovalCard` and the `approval` emits of `ToolPart` / `ChatMessage` (type
     only); `useServerEvents` dispatches `workspace.changed` to the workspace store, `project.changed` with `project:
     null` to `shellRules.dropProject`, and `refetchLoadedStores` calls `workspace.refreshLoaded()`. *Accept:* the
     existing `ChatView`, `ChatHeader`, `ChatTranscript`, `useServerEvents` tests stay green; a mount test for the page
     wrapper.
  5. **C20-T5 `useChatSession` interface** — `cwd: ComputedRef<string | null>` over `currentShellCwd(messages)`;
     `ToolApprovalDecision.allowRules?: { prefixes: string[]; scope: 'project' | 'global' }` (declared; `approve`
     ignores it until W8.10). *Accept:* session tests green.
  6. **C20-T6 `workspace-tools.ts` stubs** — `currentShellCwd(messages)` (returns null), `WorkspaceRowSummary.label`
     (the visible text for now), `diffStatsLabel(additions, deletions)`, the terminal view's `cwd: string | null`.
     *Accept:* `workspace-tools.test.ts` green.
  7. **C20-T7 `DiffView` props (complete)** — `stats?: { additions: number; deletions: number } | null` (null = counted
     from the hunks), `lineNumbers?: boolean` (default true); the root renders `data-numbers="on|off"` itself; the
     `stats` slot and the `useAttrs` read are removed; the header totals are `aria-hidden` with an sr-only
     `diffStatsLabel` text; callers: `WorkspaceToolBody` (`:stats`), `ToolApprovalPreview` (`:line-numbers="false"`);
     tests: `renderers.test.ts`, `ToolApprovalPreview.test.ts`, `WorkspaceToolBody.test.ts`. *Accept:* no caller passes
     `data-numbers` or fills a `stats` slot; prop tests; the workspace e2e stays green.
  8. **C20-T8 Pure helpers (UI.md 11.5)** — `W/components/workspace/changes/changes-rows.ts`: the types
     (`ChangesView`, `ChangesFileEntry`, `ChangesEmptyReason`, …) and stub bodies (W8.8 implements them);
     `W/components/workspace/allowlist/allow-rule.ts` **complete** (the copy of UI.md 7.23 over the shared parser:
     `ShellRuleScope`, suggestion, validation messages), so W8.10 and W8.11 do not depend on each other. Where this
     section and UI.md 10.5 / 11.5 differ, UI.md wins (report the difference). *Accept:* `allow-rule.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Web commands (`typecheck:fast` needs the coordinator's `.nuxt`; import new components by path).

### C21 git runner (k5)

- **Mission.** The hardened git runner, complete and frozen: one place that runs git, with a malicious-repository
  sentinel suite and the spawn guard.
- **Owned.** `S/workspace/git*` (`git.ts`, `git.test.ts`, `git.test-util.ts`), `S/security/process-spawn.test.ts`.
- **Read-only highlights.** ADR-037; `.tmp/p8-designs/server.md` D, `plan.md` 2.3; `S/workspace/shell.ts`
  (`killProcessGroup`, already exported), `S/workspace/shell-env.ts` (`shellEnvironment`), `S/workspace/paths.ts`;
  `S/mcp/stdio-transport.ts` (the other argument-array spawn).
- **Tasks.**
  1. **C21-T1 Runner** — `runGit(args, { cwd, root, signal })`: `spawn('git', [...fixedArgs, ...args], { cwd, env,
     shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })`; the group kill (`killProcessGroup`) on the
     15 s timeout and on abort; stdout ≤ 8 MiB (more → `failed`), stderr capped; `ENOENT` → `git-missing` (cached
     60 s); "dubious ownership" → `refused`; no `safe.directory` override. *Accept:* `git.test.ts` (timeout with a fake
     slow git on `PATH`, abort, the cap, `git-missing` with an empty `PATH`).
  2. **C21-T2 Environment** — the `shellEnvironment` allowlist plus `GIT_OPTIONAL_LOCKS=0`, `GIT_CONFIG_NOSYSTEM=1`,
     `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `LC_ALL=C`, `GIT_CEILING_DIRECTORIES=dirname(<allowed root holding the
     project>)`; inherited `GIT_DIR`, `GIT_WORK_TREE` and every `GIT_CONFIG_*` dropped. *Accept:* a parent `GIT_DIR` /
     `GIT_CONFIG_COUNT` pointing at a decoy is ignored; a project under a root inside a temp repository is `not-a-repo`.
  3. **C21-T3 Fixed overrides** — every call: `--no-pager -c core.fsmonitor=false -c core.hooksPath=/dev/null -c
     diff.external= -c core.pager=cat -c color.ui=false -c core.quotepath=false -c protocol.allow=never`; filter drivers
     found with `git config -z --name-only --get-regexp '^filter\.'` are neutralized with `-c filter.<n>.clean= -c
     filter.<n>.smudge= -c filter.<n>.process=`; a repository where the neutralization cannot be proven → `refused`.
  4. **C21-T4 Helpers** — `gitRepoInfo(root)` (`rev-parse --is-inside-work-tree --show-prefix --abbrev-ref HEAD`;
     `{ branch, head, prefix }` or a reason; an unborn HEAD gives `head: null` and the branch through a read-only
     command C21 picks); `gitStatus(root)` (`status --porcelain=v2 -z --untracked-files=all --ignore-submodules=all --
     .` parsed into raw entries: ordinary `1`, rename `2` with `origPath`, unmerged `u`, untracked `?`, with XY and the
     modes; paths mapped through the prefix, entries outside it dropped; ≤ 2000 + `truncated`); `gitHeadBlob(root,
     path)` (`ls-tree -z HEAD -- <path>` → mode + oid, `cat-file -s`, `cat-file blob <oid>` within the cap; null when
     absent; symbolic links `120000` and submodules `160000` flagged); `gitFilterAttr(root, paths)` (`check-attr -z
     filter -- <paths>`, for the LFS refusal). Paths after `--`, resolved through `resolveWorkspacePath` first. W8.3
     maps the raw entries to the `GitStatus` DTO. *Accept:* a project in a repository subfolder, untracked / rename /
     delete / binary files, an unborn HEAD, the 2000 cap.
  5. **C21-T5 Sentinel suite** — a repository whose config sets `core.fsmonitor`, `diff.external`, a `textconv`
     driver, a filter `clean` / `smudge` / `process` driver, `core.hooksPath`, `core.pager` and an `include.path` chain,
     each pointing at a script that touches a sentinel inside the temp folder; after `gitRepoInfo`, `gitStatus`,
     `gitHeadBlob` and `gitFilterAttr` no sentinel exists. *Accept:* the suite (skipped without git).
  6. **C21-T6 Test helper** — `git.test-util.ts`: `hasGit()`, a temp repository helper (`git init`, add, commit with
     `-c user.name=… -c user.email=…`, `HOME` / `GIT_CONFIG_GLOBAL` at the temp folder) through `execFile` with argument
     arrays (test code only). *Accept:* used by `git.test.ts`.
  7. **C21-T7 Spawn guard** — `S/security/process-spawn.test.ts` fails when a non-test file under `S` other than
     `workspace/shell.ts`, `workspace/git.ts` and `mcp/stdio-transport.ts` imports `node:child_process` (or
     `child_process`). *Accept:* green on the tree; a planted import in a temp copy of the scan input fails it.
- **Tests.** The tasks above (`describe.skipIf(!hasGit())`).
- **Verify.** Server commands.

### Wave P8-0b ownership

The audit cannot express "except": `S/db/schema.ts` matches C19's glob but is the coordinator's K3 edit, and
`S/testing/api-samples.ts` stays C17's file from P8-0a (untouched in P8-0b).

```json
{
  "wave": "P8-0b",
  "agents": {
    "K3": [
      "apps/server/src/db/schema.ts",
      "apps/server/drizzle/**"
    ],
    "C19": [
      "apps/server/src/types.ts",
      "apps/server/src/deps*.ts",
      "apps/server/src/env*.ts",
      "apps/server/src/db/**",
      "apps/server/src/services/checkpoints/**",
      "apps/server/src/services/shell-rules/**",
      "apps/server/src/services/data/types.ts",
      "apps/server/src/services/files/types.ts",
      "apps/server/src/services/data/{index,references}*",
      "apps/server/src/workspace/{run-scope,file-lock}*",
      "apps/server/src/testing/**",
      "apps/server/src/builtin-plugins/mock/**"
    ],
    "C20": [
      "apps/web/app/utils/testids.ts",
      "apps/web/app/utils/testing/**",
      "apps/web/app/components/workspace/**",
      "apps/web/app/stores/{workspace,shell-rules}*",
      "apps/web/app/composables/{useChangesPanel,useServerEvents,useChatSession}*",
      "apps/web/app/pages/chat/[id].vue",
      "apps/web/app/components/chat/{ChatHeader,ChatView,ChatTranscript,ChatMessage,MessageActions}*",
      "apps/web/app/components/chat/parts/{ToolPart,ToolApprovalCard,tool-approval-context}*",
      "apps/web/app/components/chat/parts/tools/**"
    ],
    "C21": [
      "apps/server/src/workspace/git*",
      "apps/server/src/security/process-spawn.test.ts"
    ]
  },
  "allow": [
    "docs/ROADMAP.md",
    "docs/DECISIONS.md",
    "AGENT.md"
  ]
}
```

### Wave P8-0b cross-agent contracts

| Producer → consumer | Contract |
|---|---|
| C19 → W8.1, W8.2, W8.3 | `CheckpointService`, `CheckpointJournal`, `CheckpointBlobStore` (`S/services/checkpoints/types.ts`) and the module stubs with their final signatures; the fakes and the row-insert test helper |
| C19 → W8.1, W8.2, W8.4, W8.5 | `bindRunScope` / `runScopeOf` / `WorkspaceRunScope` and `withFileLock` (frozen, complete) |
| C19 → W8.5, W8.6 | `ShellRuleService.forRun(projectId)` → `ShellRuleSet` |
| C19 → W8.7 | `DataService.start` / `stop`, `FileSweepInput.signal`, `Env.testFileSweepDelayMs`, the deps order |
| C19 → W8.12 | `mock:checkpoint`, `mock:shell` (PROVIDERS.md 8) |
| C21 → W8.2, W8.3 | `runGit`, `gitRepoInfo`, `gitStatus` (raw entries), `gitHeadBlob`, `gitFilterAttr`, `git.test-util.ts` |
| C18 → W8.4, W8.6, W8.10, W8.11 | the parser (frozen, complete) |
| C20 → W8.8 – W8.11 | the stub components, stores, `useChangesPanel`, the emit chains, the `useChatSession` and `TOOL_APPROVAL_CONTEXT` additions, `DiffView` props (frozen) |
| C20 → everyone | `utils/testids.ts` (frozen after the gate) |

### Gate P8-0b

1. `node scripts/audit-ownership.mjs .tmp/waves/P8-0b.json`
2. `nuxi prepare` → `pnpm check` → `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
3. `rm -rf .tmp/e2e` (a cached mock listing hides the new mock models) → `pnpm start:e2e` → `pnpm test:e2e` (77
   still green).
4. **Upgrade probe** on a fresh copy of the K3 seed (never on `.tmp/e2e`, never on the seed itself):
   ```sh
   rm -rf .tmp/gates/P8-0b/upgrade && mkdir -p .tmp/gates/P8-0b && cp -R .tmp/upgrade-v13 .tmp/gates/P8-0b/upgrade
   HF_MOCK_PROVIDER=1 HF_OFFLINE=1 HF_PORT=8898 HF_DATA_DIR=.tmp/gates/P8-0b/upgrade \
     HF_WORKSPACE_ROOTS=$PWD/.tmp/gates/P8-0b/seed2-roots node apps/server/dist/main.mjs &
   # through node + @libsql/client (or the sqlite3 CLI):
   #   SELECT count(*) FROM __drizzle_migrations;                    -> 6
   #   SELECT count(*) FROM workspace_changes; SELECT count(*) FROM shell_rules;   -> 0, 0
   #   SELECT value FROM settings WHERE key = '_files';             -> lastCleanup kept, no lastAutoSweep
   #   PRAGMA foreign_key_check;                                     -> no rows
   ```
   Then, logged in with the seeded password: every seeded chat opens (`GET /chats/<id>`, the old tool parts intact),
   the provider shows its stored key, the plugin and MCP secrets are still set, the share link opens (`GET
   /share/<token>` 200), the pending approval is still pending, `GET /projects` lists the project with `available:
   true`, `GET /settings` → `fileSweep: 'off'`, `GET /data` → `fileSweep.mode: 'off'` and `nextRunAt: null`, the
   referenced and the orphaned upload both still exist (no sweep at boot). Stop the probe server afterwards.
5. FREEZE additions (see "FREEZE in Phase 8") → ROADMAP + wave log → commit
   `feat: add phase 8 schema, migration and skeletons`.

---

## Wave P8-A — features

Eleven agents in one launch against the P8-0b checkpoint. Only server agents get slots (k1 – k7); web agents run no
server.

### Coordinator actions

- Before the launch: the ownership file `.tmp/waves/P8-A.json` (below), agent prompts with a "what exists now"
  section, their section of this file and "Rules for every Phase 8 agent".
- **At the gate**: audit; batch the CCRs; `nuxi prepare`; the gate commands and probes below; the screenshot review;
  `pnpm audit`; red items become W8.14 (server) / W8.15 (web) tasks with their globs; the reports are digested into
  `.tmp/waves/P8-A-notes.md` for W8.13. First cuts if the wave overflows: the global rules UI (project rules stay), the
  `weekly` option, the per-view count badge.

### Wave rules

- Import new components explicitly by path; no `nuxt prepare` mid-wave.
- A new test id, a contract change or a frozen-file edit is a CCR in the report (with a local adapter).
- No doc edits ("For W8.13" notes in the report instead).
- Hot files have exactly one owner (table below): `S/chat/**` → W8.5; `S/workspace/shell*` and `shell-tool*` → W8.4;
  the checkpoint store, `journal*` and the write tools → W8.1; restore, rewind and the `changes` routes → W8.2;
  `S/mcp/tools*` → W8.6; `S/services/{files,data}/**` → W8.7; `ChatView`, `ChatTranscript`, `ChatMessage`,
  `MessageActions`, `ChatHeader` → W8.9; `chat/parts/**`, the share rendering files and `useChatSession` → W8.10;
  `useServerEvents`, the panel and the palette → W8.8; `settings/{projects,data}/**` and the shell rules store → W8.11.
- Server agents test against the C19 fakes for members other agents implement (the blob store fake and inserted rows
  for W8.2 / W8.3, the fake checkpoint and rule services for W8.5); the real round trips are probed at the gate.
- git only through `S/workspace/git.ts`; journal rows and blobs only through the checkpoint store.

### W8.1 checkpoint-store (k1)

- **Mission.** The checkpoint blob store, the journaled writer, the journal rows, prune, purge, the summary and the
  live `workspace.changed` events for tool edits.
- **Owned.** `S/services/checkpoints/{index,store,journal-service,prune}*`, `S/workspace/journal*`,
  `S/builtin-plugins/core-workspace/{write-file,edit-file,common}*`.
- **Read-only highlights.** ADR-036; `.tmp/p8-designs/server.md` A – B, `plan.md` 1.1 – 1.2; ARCHITECTURE.md 6.16;
  `S/services/checkpoints/types.ts`, `S/workspace/{run-scope,file-lock,paths}.ts`, `S/services/files/gate.ts`,
  `S/catalog/index.ts` (`scheduleCycle`).
- **Tasks.**
  1. **W8.1-T1 Blob store** — `<dataDir>/checkpoints/<aa>/<sha256>`: raw before-bytes, deduplicated (an existing blob
     is kept), folders 0700 / files 0600, temp file + fsync + rename; names validated as 64 hex; never a path outside
     `paths.checkpoints`; writers hold `createStoreGate()` shared from the blob write until the row insert. *Accept:*
     `store.test.ts` (dedup, modes, an interrupted write leaves only a temp file, a bad name refused).
  2. **W8.1-T2 `journaledWrite(c, root, input, produce)`** (`S/workspace/journal.ts`) — resolve with `allowMissing`
     and refuse `.git` early → lock the resolved absolute path → read the before-state (`readWorkspaceFile` with 8 MiB;
     `payload_too_large` → `too-large`; mode from `fstat`; a missing file → `missing`) → `data = await
     produce(before)` (an error = nothing snapshotted) → `signal.throwIfAborted()` → save the blob → frozen
     `writeWorkspaceFile` → insert the row with the after-sha and size → unlock. A call without a run scope (no chat)
     writes without recording; a recording failure logs a warning (`checkpoint not recorded`, no path at `info`) and
     keeps the tool result; an orphaned blob is left to prune. *Accept:* `journal.test.ts` (two parallel `edit_file`
     calls on one file serialize and both edits land; a before-state over 8 MiB is `too-large` and the write still
     runs; binary bytes round-trip; a failed insert keeps the file and the result; an abort before the write leaves
     the file and the rows unchanged).
  3. **W8.1-T3 Write tools on it** — `write_file` and `edit_file` go through `journaledWrite`; the diff is computed from
     the same before bytes; `readPreviousText` goes; the outputs and model texts are unchanged. *Accept:* the existing
     write / edit tests green plus a lost-update test.
  4. **W8.1-T4 Rows** — `message_seq` = `coalesce(max(seq), 0)` of the chat at insert; `message_id` /
     `tool_call_id` from the scope; `kind` `edit`; `path` project-relative POSIX; `recordShell` (`kind` `shell`, tool
     `shell`, the command cut at 1000 characters) and `recordUntracked` (`kind` `untracked`, the tool name, no path) for
     W8.5; the row and blob primitives W8.2 uses for `revert` / `rewind` / `undo` rows (with their `batch_id`).
     *Accept:* row tests per kind; a continuation keeps the assistant message id.
  5. **W8.1-T5 Prune** — `start()` runs it, then every 6 h (a chained `setTimeout().unref()`, cleared in `stop()`), and
     60 s after a `chat.deleted` event (debounced); evict by age (30 d), then by the project budget (512 MiB, oldest
     first; the row stays with `before_state = evicted`), unlink blobs no `stored` row references when older than 1 h,
     remove stale temp files; holds the gate exclusive. *Accept:* `prune.test.ts` with fake timers and an injected `now`
     (age, budget, a referenced blob kept, a young orphan kept, `stop()` cancels).
  6. **W8.1-T6 Purge and summary** — `purge()` removes every blob and temp file (delete-all, W8.7 calls it inside its
     maintenance operation); `summary()` → `{ bytes, blobs }` for `DataSummary.checkpoints`. *Accept:* tests.
  7. **W8.1-T7 Tool events** — `workspace.changed` with `source: 'tool'`, `batchId: null`, the changed paths
     (deduplicated, ≤ 200), coalesced to at most one event per second per chat; pending events flushed or dropped on
     `stop()` (documented). *Accept:* fake timers: five edits within a second → one event with every path; another chat
     → its own event.
- **Tests.** The tasks above.
- **Verify.** Server commands.

### W8.2 restore-rewind (k2)

- **Mission.** Rewind (preview and apply), revert (chat and git sources), undo, the restore primitive, conflicts,
  the 409s, the batch events and all seven `changes` route handlers.
- **Owned.** `S/services/checkpoints/{plan,restore,rewind,revert,undo}*`, `S/workspace/remove*`,
  `S/http/routes/changes{,.test}.ts`.
- **Read-only highlights.** ADR-036, ADR-037; `.tmp/p8-designs/server.md` C – D, `plan.md` 1.3, 2.1 – 2.2;
  ARCHITECTURE.md 6.16, 6.17; API.md `changes.ts`; `S/services/checkpoints/types.ts`, `S/workspace/{git,file-lock,
  paths}.ts`, `S/chat/runs.ts` (`hasRun`), `S/services/projects/index.ts` (the project `run-active` check to mirror).
- **Tasks.**
  1. **W8.2-T1 Plan (pure, `plan.ts`)** — per path: target = the before-state of the earliest row in range, expected =
     the after-state of the latest, current = the disk sha (streamed through `openWorkspaceFile`) or missing; actions
     `unchanged` (current = target), `restore`, `delete` (target missing), `unavailable` (target `too-large` /
     `evicted`); conflict = current ≠ expected; rows of another project ignored (every query filters on the chat's
     current project); idempotent. *Accept:* `plan.test.ts` (earliest / latest, rows from two versions, a second plan
     after an apply is all `unchanged`, another project's rows ignored).
  2. **W8.2-T2 Remove primitive** — `S/workspace/remove.ts`: resolve, refuse `.git`, `lstat` a regular file (a folder
     or a link is refused), unlink. *Accept:* tests.
  3. **W8.2-T3 Restore primitive (`restore.ts`)** — newest-edited first; per file under its lock: re-read and re-check
     the conflict (skipped unless `conflicts: 'force'`), snapshot the current state (blob + a row of the batch kind with
     the batch id), write the target with `writeWorkspaceFile` (+ `chmod(before_mode)` when re-created) or remove it;
     a failure is `skipped` with `failed` and the batch continues; created folders stay; `batchId: null` when nothing
     was written. *Accept:* `restore.test.ts` (skip vs force, delete and re-create with the mode, a writer injected to
     fail after file N then a resume, undo of a partial batch).
  4. **W8.2-T4 Rewind (`rewind.ts`)** — the range = every file row of the chat (current project) with `message_seq >=`
     the target's `seq`, on any branch; only user messages of the chat are targets (400 otherwise, 404 unknown);
     preview: `files` ≤ 500 + `truncated`, `untracked.shellCount`, the last 50 shell commands and 50 untracked tool
     calls of the range; apply: 409 `run-active` (`details.chatId`) while any chat of the project runs, one `rewind`
     batch. *Accept:* route tests (preview, apply, a message before every edit → nothing to restore, conflict skip /
     force, 409 during a run in another chat of the project).
  5. **W8.2-T5 Revert (`revert.ts`)** — `chat` source: the base state (before the chat first changed the file); `git`
     source: the raw HEAD blob (`100755` stays executable), an untracked or added file is deleted after a snapshot, a
     rename restores `origPath` and deletes `path`; refused (400): conflicted files, symbolic links (`120000`),
     submodules, paths with a `filter` attribute (LFS); `expectedSha` ≠ the disk → 409 `stale`; the git index is never
     touched; one undoable `revert` batch; 409 `run-active` as above. *Accept:* route tests per case (git tests skipped
     without git).
  6. **W8.2-T6 Undo (`undo.ts`)** — restores the before-states of a batch's rows (expected = their after-states) as an
     `undo` batch; `conflicts: skip | force`; a batch of another chat or an unknown one → 404. *Accept:* revert → undo
     → the agent version; rewind → undo → the pre-rewind state.
  7. **W8.2-T7 Events** — `workspace.changed` (`source` `rewind` / `revert` / `undo`, the batch id, paths ≤ 200) after
     each batch that wrote something. *Accept:* event tests.
  8. **W8.2-T8 Routes** — all seven handlers in `S/http/routes/changes.ts` (`changes.list`, `changes.diff`,
     `changes.git` delegate to W8.3's members through `deps.checkpoints`); writes on a chat without a project or with an
     unavailable folder → 400 `validation_error` with the `openWorkspace` message; GETs answer `available: false` + the
     reason; unknown chat → 404. *Accept:* `changes.test.ts` covers every answer of API.md.
- **Tests.** The tasks above.
- **Verify.** Server commands.

### W8.3 changes-list (k3)

- **Mission.** The "This chat" list, file diffs for both sources and the `GitStatus` mapping on C21's runner.
- **Owned.** `S/services/checkpoints/{changes,git-changes}*`.
- **Read-only highlights.** ADR-037; `.tmp/p8-designs/server.md` D, `plan.md` 2.1, 2.3; ARCHITECTURE.md 6.17;
  `S/workspace/{git,diff,paths}.ts`; `SH/schemas/changes.ts`.
- **Tasks.**
  1. **W8.3-T1 `ChatChanges`** — one entry per path (≤ 500 + `truncated`) from base (earliest before-state), expected
     (latest after-state) and current (disk); `status` added / modified / deleted / unchanged; `edits`;
     `changedOutside` (current ≠ expected); `revertible` (base `stored`, or `missing` for a created file); `added` /
     `removed` only for the first 200 text files ≤ 256 KiB (else null); `lastEditAt`; `untracked.{shellCommands,
     toolCalls}`; `available: false` with `no-project` / `folder-unavailable`. *Accept:* `changes.test.ts` (each status,
     a file edited outside, the caps, a moved chat lists nothing of its old project).
  2. **W8.3-T2 `FileDiff` (chat)** — base vs current through `computeWorkspaceDiff`, sides ≤ 1 MiB (else `tooLarge`),
     binary = a NUL in the first 8 KiB or a failed `decodeText`; `currentSha`; `baseAvailable`. *Accept:* tests (text,
     binary, too large, a deleted file).
  3. **W8.3-T3 `FileDiff` (git)** — the HEAD blob vs the disk: untracked / added = `''` vs the file, deleted = HEAD vs
     `''`, renamed = HEAD of `origPath` vs `path`, unborn HEAD = everything added; never `git diff`. *Accept:*
     `git-changes.test.ts` (skipped without git).
  4. **W8.3-T4 `GitStatus` mapping** — from `gitRepoInfo` and the raw `gitStatus` entries: XY → `modified | added |
     deleted | renamed | untracked | conflicted | typechange` with `staged` / `unstaged`; `branch`, `head`, `prefix`;
     ≤ 2000 + `truncated`; reasons `no-project | folder-unavailable | git-missing | not-a-repo | refused | timeout |
     failed`. *Accept:* a pure mapping table plus real repositories (a subfolder project, untracked, rename, delete,
     binary, unborn HEAD).
- **Tests.** The tasks above.
- **Verify.** Server commands.

### W8.4 shell-runtime (k4)

- **Mission.** The sticky working folder, its clamping and model text, `shellPolicy`, `allowedBy` and the `PATH`
  hardening.
- **Owned.** `S/workspace/{shell,shell-env,shell-cwd}*`, `S/builtin-plugins/core-workspace/shell-tool*`.
- **Read-only highlights.** ADR-038; `.tmp/p8-designs/server.md` E – F, `plan.md` 3.1 – 3.2; ARCHITECTURE.md 6.13,
  10.9; `S/workspace/run-scope.ts`; `SH/util/shell-command.ts`.
- **Tasks.**
  1. **W8.4-T1 `reportCwd`** — `runShellCommand({ …, reportCwd: true })` runs `sh -c "trap 'pwd -P 2>/dev/null >&3'
     EXIT; <command>"` with stdio `['ignore', 'pipe', 'pipe', 'pipe']`; fd 3 read up to 4 KiB, the last absolute line →
     `ShellRunResult.endCwd: string | null`; the group kill, timeouts and environment unchanged. *Accept:*
     `shell.test.ts` under `/bin/sh` (and bash when present): `exit 3` and a `set -e` failure report with the exit
     status kept; `exec`, a timeout kill and a user `trap … EXIT` report nothing; `(cd x)` and `cd x | cat` stay
     unchanged.
  2. **W8.4-T2 Sticky cwd in the tool** — the start folder = the explicit `cwd` input, else `scope.shellCwd.current`,
     else `.`; re-checked at the call start (`resolveShellCwd`; a missing folder → the root + a note); the end folder
     must resolve inside the root and be a folder, else `endCwd: '.'` and `cwdNote` "The command ended outside the
     project folder; the next call starts in the project folder."; the output gets `endCwd` / `cwdNote`;
     `scope.shellCwd.current` follows finished calls (the last to finish wins). *Accept:* `cd sub` then the next call
     starts in `sub`; `cd /` is clamped; a symbolic link out of the root is clamped; a deleted folder → the root.
  3. **W8.4-T3 `initialShellCwd(history)`** (`S/workspace/shell-cwd.ts`) — the `endCwd` of the last `tool-shell` part
     with output on the run's active path; default `.`; an old output without the field counts as `.`. *Accept:* tests
     including two branches with different folders.
  4. **W8.4-T4 Model text and description** — `shellModelText` adds "The working folder is now packages/web (the next
     call starts there)." (or the `cwdNote`) after the status line when the folder changed; the tool description says
     the working folder carries over and environment variables do not (the stale "cd does not persist" text goes).
     *Accept:* text tests.
  5. **W8.4-T5 `shellPolicy`** — the `shell` definition's policy function: the rules from `runScopeOf(c)`,
     `matchShellRules(command, prefixes)`, and every `cdTargets` entry resolved in order (from the call's start folder)
     inside the root as a folder → `safe`, else `ask`; no scope → `ask`; the output's `allowedBy` = the matched prefixes
     when the whole command matched. *Accept:* policy tables (a match, a compound with one unmatched segment, `$(…)`,
     a redirection, a `cd` outside the project, no rules).
  6. **W8.4-T6 `PATH` hardening** — `shell-env.ts` drops empty and relative `PATH` entries (so `pnpm` never resolves to
     a file in the project). *Accept:* `shell-env.test.ts`.
- **Tests.** The tasks above (POSIX `sh` only, skipped on Windows).
- **Verify.** Server commands.

### W8.5 chat-pipeline (k5)

- **Mission.** The run scope in the chat pipeline (tools and policies), the untracked rows, the instructions text and
  the ignored `allow` override on `execute` tools.
- **Owned.** `S/chat/**` (not `types.ts`), `S/http/routes/chat{,.test}.ts`.
- **Read-only highlights.** ADR-036, ADR-038; `.tmp/p8-designs/server.md` B, E, F; ARCHITECTURE.md 6.1, 6.2, 6.13;
  `S/workspace/{run-scope,shell-cwd}.ts`, `S/services/{checkpoints,shell-rules}/types.ts`, the C19 fakes.
- **Tasks.**
  1. **W8.5-T1 Scope assembly** — `ToolAssemblyInput` / `ToolWrapContext` (`S/chat/tools.ts`) gain `messageId` and
     `scope`; for a run with a workspace the pipeline (`assembleTools` in `S/chat/pipeline.ts`) passes
     `session.assistantId`, `deps.checkpoints.journal({ chatId, messageId, projectId })`,
     `await deps.shellRules.forRun(projectId)` and `{ current: initialShellCwd(history) }`; a continuation after an
     approval reuses the same assistant message id. *Accept:* pipeline tests (the scope of a first run and of a
     continuation).
  2. **W8.5-T2 Binding** — `wrapToolExecute` binds `{ ...scope, toolCallId }` to the call context right before
     `definition.execute`; `evaluatePolicy` (`S/chat/approval.ts`) binds it to the context object it creates, so policy
     functions see the rules; no public property of the plugin context exposes it. *Accept:* a test tool reading
     `runScopeOf(c)` sees the chat, message and tool call ids; a policy function sees the rules.
  3. **W8.5-T3 Untracked rows** — after every settled call (success or failure): the `core-workspace` `shell` →
     `journal.recordShell({ toolCallId, command })`; any other tool with workspace access `write` or `execute` →
     `recordUntracked({ toolCallId, tool })`; `core-workspace`'s `write_file` / `edit_file` journal themselves and are
     skipped; MCP tools declare no access and record nothing. *Accept:* tools tests per case.
  4. **W8.5-T4 Approval** — `createToolApproval` ignores a stored `override: 'allow'` on an `execute` tool (treated as
     no override); `ask` and `edits` run a `safe` policy result without asking, `auto` is unchanged, `off` sends no
     tools; a `tool.approve` hook and the `deny` / `ask` overrides keep precedence. *Accept:* `approval.test.ts`
     (allowlisted commands in `ask` and `edits`, a stored `allow` on `shell` ignored, a hook still wins).
  5. **W8.5-T5 Instructions text** — the workspace block line of `S/chat/params.ts` says each shell call is a new
     process, the working folder carries over (cd persists inside the project folder), environment variables do not.
     *Accept:* `params.test.ts`.
- **Tests.** The tasks above; `pipeline.test.ts` stays green.
- **Verify.** Server commands.

### W8.6 shell-rules (k6)

- **Mission.** Rule storage, validation, caps and routes, `forRun`, and the refused `allow` override.
- **Owned.** `S/services/shell-rules/**` (not `types.ts`), `S/http/routes/shell-rules{,.test}.ts`, `S/mcp/tools*`,
  `S/http/routes/tools{,.test}.ts`.
- **Read-only highlights.** ADR-038; `.tmp/p8-designs/server.md` F, `plan.md` 3.2; API.md `shell-rules.ts`,
  `tools.ts`; `SH/util/shell-command.ts`, `SH/schemas/shell-rules.ts`.
- **Tasks.**
  1. **W8.6-T1 CRUD** — `list()` (global first, then by project, each sorted by prefix); `create({ projectId, prefix
     })`: `parseShellRule` (a refused rule → 400 `validation_error` on `['prefix']` with the parser's message), an
     unknown project → 404, the same canonical prefix in the same scope → 409 `exists`, more than 200 rules in the
     scope → 400; `srl_` id; `remove(id)` (404 when unknown); routes not fresh. *Accept:* `shell-rules.test.ts` route
     tests for 201 / 400 / 404 / 409 / 204.
  2. **W8.6-T2 `forRun(projectId)`** — the canonical prefixes of the global rules and the project's (one query), empty
     for null. *Accept:* a rule of project A is not in B's set; a global rule is in both.
  3. **W8.6-T3 Refused override** — `ToolService.update` (`S/mcp/tools.ts`) answers 400 `validation_error` on
     `['override']` for `override: 'allow'` on a tool with workspace access `execute` ("Shell commands can't be always
     allowed. Add a shell rule instead."); other tools and the `ask` / `deny` overrides unchanged. *Accept:*
     `tools.test.ts` (`PATCH /tools/shell { override: 'allow' }` → 400, `deny` → 200).
  4. **W8.6-T4 Cascade and logs** — deleting a project removes its rules (foreign key); rule prefixes are logged only
     at `debug`. *Accept:* a service test after a project delete.
- **Tests.** The tasks above.
- **Verify.** Server commands.

### W8.7 files-maintenance (k7)

- **Mission.** The automatic file sweep, the plugin data scan, `FileSweepStatus`, the delete-all purge call and the
  fake files service fix.
- **Owned.** `S/services/{files,data}/**` (not `types.ts`), `S/http/routes/data{,.test}.ts`,
  `S/testing/fakes{,.test}.ts`.
- **Read-only highlights.** ADR-035, ADR-039; `.tmp/p8-designs/process.md` A – B, `plan.md` 4.1; ARCHITECTURE.md 6.9,
  6.15; API.md `data.ts`; `S/services/{files,data,maintenance,checkpoints}/types.ts`; `S/catalog/index.ts`.
- **Tasks.**
  1. **W8.7-T1 Timer** — `S/services/data/auto-sweep.ts`: `createAutoSweep` and the pure `nextSweepAt(state, mode,
     bootAt)` = `max(bootAt + 24 h, lastCleanup + interval, a failed or skipped lastAutoSweep.at + interval)` (daily
     24 h, weekly 7 d, null when off); the first check at `bootAt + 24 h` (or `Env.testFileSweepDelayMs`), then hourly
     (the same delay in tests); each check re-reads the setting and `_files`; `DataService.start()` / `stop()` (stop
     aborts a sweep in flight and clears the timer); `background` off under Vitest. *Accept:* fake-timer tests: off →
     nothing in 30 days; daily → nothing at 23:59 after boot, a run at 24 h; a manual cleanup pushes the next run back;
     weekly; switching off → daily applies at the next hourly check; `stop()` aborts and no check runs after it.
  2. **W8.7-T2 Run** — `maintenance.exclusive('file-cleanup', () => runCleanup(…, { trigger: 'auto', signal }))`;
     409 `busy` → retry in 10 min, nothing stored (debug log); a failure is stored as `failed` / `error` (warn log with
     the error, no paths) and retried only after a full interval; a finished run sets `lastCleanup` and
     `lastAutoSweep`. *Accept:* busy, failure and success tests.
  3. **W8.7-T3 Plugin data scan** — `S/services/data/plugin-data-scan.ts`, one code path for the manual and the
     automatic run: a loose `file_` id scan of `paths.pluginData/**` (disabled plugins and `keepData` leftovers too);
     `readdir` with file types + `lstat`, links never followed, regular files only (`O_RDONLY | O_NOFOLLOW |
     O_NONBLOCK` + `fstat`), 1 MiB chunks with a 20-byte carry-over; budget 256 MiB / 50,000 files / depth 32 / the
     abort signal; over budget → the automatic run is `skipped` (`plugin-data-limit`, nothing deleted), a manual run
     proceeds with `pluginData: 'partial'`. *Accept:* an id split across a chunk boundary is found, a link is not
     followed, a FIFO is skipped, the budget skip.
  4. **W8.7-T4 Status** — `_files.lastAutoSweep { at, status, reason, files, diskBytes }`; `FileSweepStatus { mode,
     lastAttempt, nextRunAt }` in `GET /data` (cheap: no scan) and `GET /data/cleanup`; logs: counts only (`automatic
     file sweep finished` / `… skipped`, manual runs log `trigger: 'manual'`), never ids, names or paths. *Accept:*
     route tests; no `file_` id in the captured logs.
  5. **W8.7-T5 Checkpoints** — delete-all calls `checkpoints.purge()` inside its maintenance operation; the sweep walks
     only `paths.files` (a `checkpoints/aa/<64 hex>` file survives). *Accept:* tests.
  6. **W8.7-T6 Fake files service** — `/** @deprecated */ export const createFakeFilesService = createFilesService`
     (the real service has pins and the gate); call sites unchanged. *Accept:* reused rows from `importFile` and
     `saveGenerated` are pinned; both wait while the exclusive gate is held; the full server suite green.
- **Tests.** The tasks above (`vi.useFakeTimers()` + an injected `now`).
- **Verify.** Server commands.

### W8.8 changes-panel-web

- **Mission.** The changes pane and sheet, the toggle, the rows and diffs, revert with undo, the refresh triggers,
  Alt+C and the palette entry.
- **Owned.** `W/components/workspace/{ChatWorkspace*,changes/**}`, `W/stores/workspace*`,
  `W/composables/{useChangesPanel,useServerEvents}*`, `W/components/app-shell/CommandPalette*`,
  `W/components/app-shell/chat-nav/palette*`.
- **Read-only highlights.** UI.md 1.2, 2.15, 7.21, 10.5, 11.5, 12, 13.9, 14; `.tmp/p8-designs/web.md` A – B;
  `W/components/ui/{resizable,sheet,tabs}`; `W/composables/useShortcuts.ts`;
  `W/components/chat/parts/tools/DiffView.vue`.
- **Tasks.**
  1. **W8.8-T1 Layout** — `ChatWorkspace` always renders a `ResizablePanelGroup` around the chat (so toggling never
     remounts `ChatView`); ≥ 1024 px with a project and the panel open: a right `<aside>` pane labelled by its `h2`
     "Changes" (default 440 px, min 320, max 720, the chat keeps ≥ 40 %; the px width in `hf-changes-width` from
     `@resize`; a 24 px handle hit area on coarse pointers; arrow keys resize); below 1024 px: a right `Sheet` (full
     width below `sm`, `sm:max-w-lg`, its own 40 px close button); the transcript keeps `max-w-3xl` centred in the rest.
     *Accept:* component tests (no remount on toggle, the width restored in px, the sheet below lg).
  2. **W8.8-T2 Toggle** — ghost `PanelRight` button with a count pill ("9+" cap), `aria-pressed`, `aria-controls`, the
     label "Show changes, 3 files changed" / "Hide changes", 40 px on coarse pointers, not rendered without a project;
     fetches the chat's changes once on mount. *Accept:* `ChangesToggle.test.ts`.
  3. **W8.8-T3 Panel, rows and diffs** — tabs This chat | Git (`hf-changes-view`), refresh and close; the summary
     line; accordion rows (`aria-expanded`, the status tile A / M / D / U / R with sr text, the path, `+a −d`, the
     conflict icon with "changed outside this chat", "Revert {path}" with `Undo2`, shown on hover / focus and always on
     coarse pointers at 40 px); `ChangesFileDiff` loads lazily and renders `DiffView` ("Binary file. No preview."); the
     states of UI.md 7.21 (skeleton, refresh spinner with `aria-busy`, error + Retry, the empty texts, not a repo, no
     git, refused, folder missing; "Showing the first 500 files."). *Accept:* tests per state.
  4. **W8.8-T4 Revert and undo** — `RevertFileDialog` (the texts per source of UI.md 7.21, the `changedOutside`
     warning, "The current version is saved first, so you can undo this.", the destructive "Revert file") sends
     `expectedSha` = the shown `currentSha`; a toast "Reverted {path}" with Undo (`POST …/undo { batchId }`); 409
     `run-active` → "Wait for the response to finish before reverting files."; 409 `stale` → refresh + a toast; focus
     moves to the next row, else the previous, else the tabs; a polite region announces the revert. *Accept:* tests.
  5. **W8.8-T5 Refresh** — `workspace.changed` (debounced 300 ms per chat), `run.finished` of the chat, the event
     stream reconnect (`refreshLoaded`), window focus while the Git view shows, the ⟳ button; no polling. *Accept:*
     store and `useServerEvents` tests.
  6. **W8.8-T6 Shortcut and palette** — Alt+C (`toggle-changes`, `alt+code:KeyC`, `alt: true`, allowed in inputs,
     only on project chat pages, obeys `altShortcuts`) registered by `ChatWorkspace`; the palette item "Show changes" /
     "Hide changes" (`data-value="toggle-changes"`) in the Actions section; Alt+C and the palette focus the active tab,
     close returns focus to the toggle, the sheet traps focus and closes with Esc. *Accept:* shortcut and palette tests.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W8.9 rewind-web

- **Mission.** The rewind action on user messages, the rewind dialog, restore-and-edit, the result toasts and errors,
  and the chat view's approval context values.
- **Owned.** `W/components/workspace/rewind/**`, `W/components/chat/{ChatView,ChatTranscript,ChatMessage,
  MessageActions,ChatHeader}*`.
- **Read-only highlights.** UI.md 7.5, 7.22, 10.5, 11.5, 13.9, 15; `.tmp/p8-designs/web.md` C; the workspace store
  (W8.8's, frozen signature); `W/composables/useChatSession.ts`.
- **Tasks.**
  1. **W8.9-T1 Visibility** — "Rewind files to here" (`History` icon, after Edit, before Delete version) on a user
     message only when the chat has a project, nothing runs (`data-busy`) and a `write_file` / `edit_file` part in
     `output-available` follows it on the shown path; `ChatTranscript` computes the set in one backwards pass and adds
     it to `v-memo`. *Accept:* `ChatTranscript.test.ts` and `MessageActions.test.ts`.
  2. **W8.9-T2 Dialog** — `RewindDialog` loads the preview on open: the title and text of UI.md 7.22, the file list
     (Restore / Delete badge, the conflict icon), the unchecked "Also restore files changed outside this chat" (→
     `force`), "Shell changes aren't tracked." plus up to 10 commands and "and {n} more", Cancel · Restore files and
     edit · Restore files; an empty preview reads "Nothing to restore. The files already match." with Close only.
     *Accept:* dialog tests.
  3. **W8.9-T3 Result and edit** — a toast "Restored {n} files" (description "Skipped {k} changed outside this chat")
     with Undo; "Restore files and edit" → `transcript.startEdit(messageId)` (the existing `MessageEditor` and
     `session.edit()` branch flow). *Accept:* `ChatView.test.ts`.
  4. **W8.9-T4 Errors and focus** — 409 `run-active` → "Wait for the response to finish before rewinding files." then
     `setRunState` + `resumeIfRunning`; 404 → the stale-chat toast and a refresh; others inline (`rewind-error`); Cancel
     returns focus to `message-rewind`. *Accept:* tests.
  5. **W8.9-T5 Approval context** — `ChatView` provides `TOOL_APPROVAL_CONTEXT.projectId()` and `.shellCwd()` (from
     `session.cwd`) and shows "Could not save the rule" when `session.approve()` rethrows a rule failure. *Accept:*
     `ChatView.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W8.10 tool-ui-web

- **Mission.** The allow-rule option on the shell approval card and its decision flow, the rule badge, the cwd
  prompt and badge, `session.cwd`, the screen-reader labels of tool rows and share parity.
- **Owned.** `W/components/chat/parts/**`, `W/components/share/{SharedMessage,ShareToolRow,share-view}*`,
  `W/components/workspace/allowlist/AllowRuleOption*`, `W/composables/useChatSession*`.
- **Read-only highlights.** UI.md 7.2, 7.3, 7.19, 7.23, 10.5, 11.5, 13.9, 14; `.tmp/p8-designs/web.md` D, E, G;
  `SH/util/shell-command.ts`; the shell rules store (W8.11's, frozen signature).
- **Tasks.**
  1. **W8.10-T1 `AllowRuleOption`** — for `execute` tools: "Always allow commands starting with" the prefixes of
     `suggestShellRules(command)` (a single prefix is editable), the scope toggle This project | All projects (default
     This project), "Combined commands run only when every part matches a rule."; hidden with "Commands with
     redirections or substitutions always ask." when the suggestion is empty; inline errors (`tool-approval-rule-error`)
     from `parseShellRule` and a prefix that does not match its segment; Run disabled while the option is checked and
     invalid. *Accept:* `AllowRuleOption.test.ts` and card tests.
  2. **W8.10-T2 Decision flow** — the card's `decide` payload carries `allowRules`; `ToolPart` / `ChatMessage` pass it
     through; `session.approve()` awaits `shellRules.create` for each prefix before `addToolApprovalResponse` (the
     continuation then already sees the rules); a failure still sends the approval, then rethrows. *Accept:* session
     tests (the order of the calls, the failure path).
  3. **W8.10-T3 Rule badge and terminal** — `ToolRuleBadge` (muted `ShieldCheck` before the summary, sr ", allowed by
     rule {prefix}") from `allowedBy`; `TerminalOutput`: the prompt `{cwd} $ command` (`terminal-cwd`, hidden for `.`),
     the footer "Now in {endCwd}" / "Now in the project folder" (`terminal-cwd-change`), "Allowed by rule: …", the
     `cwd` prop while running; `currentShellCwd(messages)`; `session.cwd`; the approval meta "In {project}/{cwd}".
     *Accept:* renderer tests.
  4. **W8.10-T4 Screen-reader labels** — `WorkspaceRowSummary.label` ("12 lines added, 3 removed", "1 line added",
     "New file, 40 lines", "Updated, 40 lines", "Exit code 1", "Timed out", "Killed by SIGTERM", "Exited without an exit
     code", "Lines 1 to 120 of 340"; other summaries reuse their text); `ToolRowSummary` renders the visible text
     `aria-hidden` plus a sibling `sr-only` label; `diffStatsLabel` shared. *Accept:* a label table per tool; the
     visible text unchanged (e2e `toHaveText('+1 −1')` stays green).
  5. **W8.10-T5 Share parity** — `ShareToolRow` / `SharedMessage` render the cwd prompt, the labels and the rule badge.
     *Accept:* share tests.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W8.11 settings-web

- **Mission.** The shell rules store and editors (per project and global), the automatic cleanup controls and status,
  the Alt+C hint.
- **Owned.** `W/components/settings/{projects,data}/**`, `W/pages/settings/projects.vue`, `W/stores/shell-rules*`,
  `W/components/workspace/allowlist/**` (not `AllowRuleOption*`), `W/components/settings/{GeneralSettings,general}*`.
- **Read-only highlights.** UI.md 9.4, 9.8, 9.10, 10.5, 11.5, 13.9, 15; `.tmp/p8-designs/web.md` D, F; API.md
  `shell-rules.ts`, `data.ts`; `SH/util/shell-command.ts`.
- **Tasks.**
  1. **W8.11-T1 Store** — `useShellRulesStore`: `fetchAll`, `create` (409 → a typed error the editors map), `remove`,
     `dropProject`, the getters. *Accept:* `shell-rules.test.ts`.
  2. **W8.11-T2 Editors** — `AllowlistEditor` (rows with the prefix in mono and "Remove {prefix}"; the add input with
     placeholder "pnpm test" and Add; validation through `parseShellRule`; 409 "This rule already exists."; the
     non-blocking warning "This allows every {word} command." for one-word prefixes; the empty state "No allowed
     commands yet."; the explanation text of UI.md 9.10); `AllowlistDialog` from the project row menu "Allowed
     commands…" (`project-allowlist`, `ShieldCheck`) and "{n} allowed commands" in the row meta;
     `GlobalAllowlistSection` ("Allowed in every project") below the project list. *Accept:* component tests.
  3. **W8.11-T3 Automatic cleanup** — `StorageCleanupSection`: the "Automatic cleanup" switch and the Every day / Every
     week select writing `fileSweep` through `settings.update` (optimistic, rolled back with a toast), the warning text,
     the status line from `GET /data` (last run, next run, a failure or skip; `data-state` per UI.md 9.8). *Accept:*
     `StorageCleanupSection.test.ts`.
  4. **W8.11-T4 General** — the Alt shortcuts help text mentions Alt+C for changes. *Accept:* `GeneralSettings.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### Wave P8-A ownership

These globs are the plan's table plus the addition listed in "Deviations" (`chat-nav/palette*` for W8.8). The audit
cannot express "except": every `types.ts` of `S`, `S/workspace/{paths,run-scope,file-lock,git}.ts` and the P8-0b stub
props stay frozen despite the globs; `S/workspace/shell*` covers `shell-env` and `shell-cwd` (one owner, W8.4);
`W/components/workspace/allowlist/AllowRuleOption*` matches W8.11's glob too (a warning; W8.10 owns it). Added at Gate P8-0b: W8.1
owns `S/services/checkpoints/disk*` and `S/testing/fake-checkpoints*`, W8.6 `S/testing/fake-shell-rules*`, W8.8
`W/components/workspace/nuxt-imports*`; `W/components/workspace/allowlist/stubs.test.ts` is W8.11's (W8.10 keeps the
`AllowRuleOption` stub assertions passing and writes its own `AllowRuleOption.test.ts`).

```json{
  "wave": "P8-A",
  "agents": {
    "W8.1": [
      "apps/server/src/services/checkpoints/{index,store,journal-service,prune}*",
      "apps/server/src/workspace/journal*",
      "apps/server/src/builtin-plugins/core-workspace/{write-file,edit-file,common}*",
      "apps/server/src/services/checkpoints/disk*",
      "apps/server/src/testing/fake-checkpoints*"
    ],
    "W8.2": [
      "apps/server/src/services/checkpoints/{plan,restore,rewind,revert,undo}*",
      "apps/server/src/workspace/remove*",
      "apps/server/src/http/routes/changes{,.test}.ts"
    ],
    "W8.3": [
      "apps/server/src/services/checkpoints/{changes,git-changes}*"
    ],
    "W8.4": [
      "apps/server/src/workspace/{shell,shell-env,shell-cwd}*",
      "apps/server/src/builtin-plugins/core-workspace/shell-tool*"
    ],
    "W8.5": [
      "apps/server/src/chat/**",
      "apps/server/src/http/routes/chat{,.test}.ts"
    ],
    "W8.6": [
      "apps/server/src/services/shell-rules/**",
      "apps/server/src/http/routes/shell-rules{,.test}.ts",
      "apps/server/src/mcp/tools*",
      "apps/server/src/http/routes/tools{,.test}.ts",
      "apps/server/src/testing/fake-shell-rules*"
    ],
    "W8.7": [
      "apps/server/src/services/files/**",
      "apps/server/src/services/data/**",
      "apps/server/src/http/routes/data{,.test}.ts",
      "apps/server/src/testing/fakes{,.test}.ts"
    ],
    "W8.8": [
      "apps/web/app/components/workspace/{ChatWorkspace*,changes/**}",
      "apps/web/app/stores/workspace*",
      "apps/web/app/composables/{useChangesPanel,useServerEvents}*",
      "apps/web/app/components/app-shell/CommandPalette*",
      "apps/web/app/components/app-shell/chat-nav/palette*",
      "apps/web/app/components/workspace/nuxt-imports*"
    ],
    "W8.9": [
      "apps/web/app/components/workspace/rewind/**",
      "apps/web/app/components/chat/{ChatView,ChatTranscript,ChatMessage,MessageActions,ChatHeader}*"
    ],
    "W8.10": [
      "apps/web/app/components/chat/parts/**",
      "apps/web/app/components/share/{SharedMessage,ShareToolRow,share-view}*",
      "apps/web/app/components/workspace/allowlist/AllowRuleOption*",
      "apps/web/app/composables/useChatSession*"
    ],
    "W8.11": [
      "apps/web/app/components/settings/projects/**",
      "apps/web/app/components/settings/data/**",
      "apps/web/app/pages/settings/projects.vue",
      "apps/web/app/stores/shell-rules*",
      "apps/web/app/components/workspace/allowlist/**",
      "apps/web/app/components/settings/{GeneralSettings,general}*"
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

### Wave P8-A cross-agent contracts

The props below are frozen in the P8-0b stubs or documented in UI.md 10.5; the server members in the frozen `types.ts`.

| Producer → consumer | Contract |
|---|---|
| W8.1 → W8.2 | the blob store and row primitives (`CheckpointBlobStore`, the row insert with `kind` + `batch_id`), the per-file lock order (lock → read → write → row) |
| W8.1 → W8.5 | `deps.checkpoints.journal(scope)` → `write` / `recordShell` / `recordUntracked` |
| W8.1 → W8.7 | `checkpoints.purge()` (delete-all), `checkpoints.summary()` (`DataSummary.checkpoints`) |
| W8.2 ↔ W8.3 | the `changes` route handlers (W8.2) call `listChanges`, `fileDiff`, `gitStatus` (W8.3) through `deps.checkpoints`; both use the same base / expected / current rule |
| C21 → W8.2, W8.3 | `runGit`, `gitRepoInfo`, `gitStatus`, `gitHeadBlob`, `gitFilterAttr` (frozen) |
| W8.4 → W8.5 | `initialShellCwd(history)`, `shellPolicy` reads `runScopeOf(c).shellRules`, `scope.shellCwd` |
| W8.6 → W8.5 | `shellRules.forRun(projectId)`; W8.5 alone ignores a stored `allow` on `execute` tools, W8.6 alone refuses new ones |
| W8.7 only | `FileSweepStatus`, `_files.lastAutoSweep`, the plugin data scan |
| W8.2 / W8.3 → W8.8, W8.9 | `ChatChanges`, `FileDiff`, `GitStatus`, `RewindPreview`, `RestoreResult`; 409 `run-active` / `stale`; `workspace.changed` |
| W8.4 → W8.10 | the shell output `endCwd`, `cwdNote`, `allowedBy` |
| W8.6 → W8.10, W8.11 | `POST /shell-rules` (201, 400, 404, 409 `exists`), `DELETE /shell-rules/:id` (204) |
| W8.7 → W8.11 | `GET /data` `fileSweep`, the `fileSweep` setting |
| W8.8 → W8.9 | `useWorkspaceStore.undo(chatId, batchId)` (the toast Undo; frozen signature, implemented by W8.8); `RewindDialog` calls `api.changes.rewindPreview` / `api.changes.rewind` itself (P8-0b, UI.md 11.5: the store carries no rewind members) |
| W8.11 → W8.10 | `useShellRulesStore.create` (frozen signature, implemented by W8.11) |
| W8.10 → W8.9 | `session.cwd`, the rethrown rule failure of `session.approve()` |
| C18 → W8.4, W8.6, W8.10, W8.11 | the parser; the server and the web agree because both call it |

### Gate P8-A

1. `node scripts/audit-ownership.mjs .tmp/waves/P8-A.json`
2. Batch the CCRs → `nuxi prepare` → `pnpm check` → `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
3. `rm -rf .tmp/e2e` → probes (`.tmp/gates/P8-A/probe.mjs`, built on the P7-A harness: `startServer`, a client,
   libsql) on `pnpm start:e2e` (`b=http://127.0.0.1:8899/api`, log in `.tmp/gates/P8-A/server.log`) and on probe
   servers 8896 (rules and cwd), 8897 (git; one instance with `PATH` set to an empty temp folder) and 8898
   (`HF_TEST_FILE_SWEEP_DELAY_MS=2000`, later the upgrade), `HF_DATA_DIR=.tmp/gates/P8-A/<name>`; loops run through
   `bash -c`; project folders under `.tmp/e2e/workspaces/*` or the probe servers' default roots:
   1. **Checkpoints** — `mock:checkpoint` in a project chat: an `edit` row (`before_state` `missing`) and `shell` rows;
      a second turn → an `edit` row with `before_state` `stored` and a blob `checkpoints/<aa>/<sha>` holding "Turn
      1\n"; the `files` row count unchanged; `GET $b/chats/<id>/changes` lists `checkpoint.txt`.
   2. **Rewind** — the preview on the second user message lists `checkpoint.txt` (`restore`) and the shell commands;
      apply → "Turn 1\n"; a rewind to the first message → the file is deleted; an edit on disk afterwards → the
      preview shows `conflict: true`, `skip` keeps the disk version, `force` restores; `POST …/changes/undo {
      batchId }` brings the pre-rewind state back; a rewind while another chat of the project runs (`mock:shell`
      `sleep 5` in `auto`) → 409 `run-active` with `details.chatId`.
   3. **Revert** — a git project: tracked `a.txt` changed → revert `source: 'git'` → the HEAD content, undo → the
      changed version; an untracked `new.txt` → deleted, undo → restored; a stale `expectedSha` → 409 `stale`; a
      `chat`-source revert of `checkpoint.txt` + undo.
   4. **No git** — a non-repo project → `GET /chats/<id>/git` `available: false`, `reason: 'not-a-repo'`; the 8897
      instance with an empty `PATH` folder → `git-missing`.
   5. **Malicious config** — a repository whose config sets `core.fsmonitor`, `diff.external`, a `textconv` driver,
      a filter `clean` / `smudge` / `process` driver, `core.hooksPath`, `core.pager` and an `include.path` chain, each
      touching a sentinel: after `GET …/git`, `GET …/changes/diff?source=git` and a revert no sentinel exists; a server
      started with `GIT_DIR` / `GIT_WORK_TREE` / `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor
      GIT_CONFIG_VALUE_0=<sentinel script>` ignores them; a project in `.tmp/e2e/workspaces/x` never discovers the
      harness-forge repository (`not-a-repo`).
   6. **Sticky cwd** (8896, `mock:shell`, `auto`) — `mkdir -p sub && cd sub` → the next `pwd` prints `<root>/sub`;
      `cd /` → `endCwd: '.'` with the note and the next `pwd` prints the root; the remembered folder removed → the next
      call runs at the root with a note; `export X=1` → `echo "[$X]"` prints `[]`.
   7. **Rules** (8896) — a project A rule `ls` → in `ask` the `ls` call runs without approval (`allowedBy: ['ls']`);
      `ls && rm x` asks; `ls $(whoami)` and `echo a > f` ask; in project B `ls` asks; a global rule applies in both; a
      duplicate → 409 `exists`; `prefix: 'bash'` → 400; `PATCH $b/tools/shell { "override": "allow" }` → 400; a
      server with `HF_WORKSPACE_SHELL=0` offers no shell.
   8. **Sweep** (8898) — two aged orphans (`UPDATE files SET created_at = …`), one of them referenced from
      `plugins/.data/p/state.json`, a checkpoint blob; `PUT $b/settings { "fileSweep": "daily" }` → within 10 s the
      unreferenced orphan answers 404, the other is kept, the checkpoint blob is untouched; `GET $b/data` →
      `fileSweep.lastAttempt.status === 'done'` and `nextRunAt` about 24 h later; no file id in the log; without
      `HF_MOCK_PROVIDER` the variable is ignored with a boot warning.
   9. **Hygiene** — `git status --porcelain` of the repository is identical before and after `pnpm test`; the server
      logs hold no shell command (`mkdir -p mock-dir`), no file content ("Turn 1") and no file id at `info`.
   10. **Upgrade** — a fresh copy of `.tmp/upgrade-v13` on 8898 (as in Gate P8-0b) with the real services: the seeded
       project chat lists no changes, a rewind preview on its pre-v1.4 user message has nothing to restore, `GET
       …/git` is available with the branch, `fileSweep` is off.
4. `pnpm test:e2e` (`chromium` + `mobile` + `tablet`; the feature specs come in P8-B) green.
5. `E2E_SCREENSHOTS=1 pnpm test:e2e --grep @screenshots` → review `.tmp/screenshots/{dark,light}/`.
6. `pnpm audit --prod --audit-level high` clean (the two ignored advisories excepted).
7. ROADMAP + wave log → commit `feat: add checkpoints, changes panel, shell rules and file sweep`.

---

## Wave P8-B — feature e2e, docs, fix-ups

### Coordinator actions

- Before the launch: the P8-A checkpoint build for W8.12; W8.14 / W8.15 globs from the red P8-A gate items added to
  `.tmp/waves/P8-B.json` (launched only when needed); the P8-A reports handed to W8.13 as the digest
  `.tmp/waves/P8-A-notes.md` (contract facts, deviations, items marked "For W8.13").
- The final gate below; ROADMAP (every Phase 8 box, the backlog, the wave log); the memory file; push only when the
  user asks.

### W8.12 e2e-features (e2e 8891)

- **Mission.** End-to-end specs for the changes panel, rewind, shell rules, the sticky working folder and the automatic
  cleanup, mobile and tablet checks, and screenshots of the new screens.
- **Owned.** `e2e/**`.
- **Read-only highlights.** UI.md 2.15, 7.21 – 7.23, 9.8, 9.10, 12, 13.9, 14; PROVIDERS.md 8 (`mock:checkpoint`,
  `mock:shell`); `playwright.config.ts`; `e2e/README.md`; `e2e/helpers/workspace.ts`.
- **Tasks.**
  1. **W8.12-T1 Helper** — `seedGitProject` in `e2e/helpers/workspace.ts`: a folder under `.tmp/e2e/workspaces/`,
     `execFile('git', [...])` with argument arrays (`init`, `add`, `commit` with `-c user.name=… -c user.email=…`,
     `HOME` / `GIT_CONFIG_GLOBAL` at a temp folder), skipped when git is missing; removed afterwards.
  2. **W8.12-T2 `core/changes-panel.spec.ts`** — the count badge; This chat: the list, expand, the diff; revert → the
     file changed on disk → Undo brings it back; the Git view on a repository, a non-repository and a clean tree; the
     width and the open state survive a reload; Alt+C; the palette entry.
  3. **W8.12-T3 `core/rewind.spec.ts`** — the button shows only after edits; the preview lists the file and the shell
     command; Restore; Restore and edit opens the editor; a conflict + force; 409 during a run.
  4. **W8.12-T4 `core/shell-rules.spec.ts`** — the card option creates a rule → the next run executes without asking
     and shows `tool-row-rule`; the Settings dialog and the global section (add, remove, validation, 409).
  5. **W8.12-T5 Extensions** — `workspace-tools` (the cwd prompt and badge, the screen-reader labels, e.g.
     `getByText('1 line added, 1 removed')`), `share` (parity), `data-maintenance` (the automatic cleanup setting
     persists and shows the next run), `keyboard` (Alt+C).
  6. **W8.12-T6 Mobile and tablet** — `mobile/changes.spec.ts` (the right sheet, no horizontal overflow with a diff
     open at 390 px, Esc returns focus to the toggle, the rewind dialog fits); the tablet touch-target spec covers the
     toggle, the rows, revert, `message-rewind`, the rule checkbox and the scope toggle (≥ 40 px).
  7. **W8.12-T7 Screenshots** — `chat-changes-panel`, `chat-changes-git`, `chat-changes-sheet`, `chat-revert-confirm`,
     `chat-rewind-dialog`, `chat-shell-approval-rule`, `chat-terminal-cwd`, `settings-projects-allowlist`,
     `settings-data-auto-cleanup` (dark + light; desktop and mobile where relevant).
  8. **W8.12-T8 README** — `e2e/README.md` lists the new specs and the git helper.
- **Verify.** `pnpm test:e2e --list`; slot runs (`HF_MOCK_PROVIDER=1 HF_OFFLINE=1 HF_PORT=8891
  HF_DATA_DIR=.tmp/W8.12/data node apps/server/dist/main.mjs`, `E2E_BASE_URL=http://127.0.0.1:8891 pnpm test:e2e`);
  three green runs of the new specs.

### W8.13 docs-final

- **Mission.** Reconcile every doc with the code and the agent reports.
- **Owned.** `README.md`, `.env.example`, `docs/**` except `DECISIONS.md` and `ROADMAP.md`.
- **Read-only highlights.** `.tmp/waves/P8-A-notes.md`, the code of every Phase 8 area.
- **Tasks.**
  1. **W8.13-T1 Reconcile** — API.md vs the route table and the implemented answers (`changes`, `shellRules`, the
     shell output fields, `fileSweep`, `FileSweepStatus`, the `PATCH /tools/:name` refusal); UI.md 13.9 vs
     `utils/testids.ts`, the contracts (10.5), the stores and composables (11.5), the copy (15); ARCHITECTURE.md vs the
     implemented flows (6.13, 6.15 – 6.17, the boot order, the git hardening, the log fields); PLUGINS.md (the journal
     and the untracked rows, the plugin data scan); PROVIDERS.md 8 vs the mock models; the guides.
  2. **W8.13-T2 Status** — README "v1.4" (features: checkpoints and rewind, the changes panel, shell rules and the
     sticky working folder, the automatic cleanup); refresh `docs/assets/screenshots/` only when a README image changed
     visibly (copied from `.tmp/screenshots/`).
  3. **W8.13-T3 This file** — what actually happened (status, deviations, gate results per wave).
- **Verify.** `pnpm check:english`; `pnpm -F @harness-forge/shared test` (doc-coupled tests).

### W8.14 / W8.15 fix-ups

Launched only for red P8-A gate items (W8.14 server, W8.15 web), with the globs of those items.

### Wave P8-B ownership

```json
{
  "wave": "P8-B",
  "agents": {
    "W8.12": ["e2e/**"],
    "W8.13": [
      "README.md",
      ".env.example",
      "docs/API.md",
      "docs/ARCHITECTURE.md",
      "docs/PLUGINS.md",
      "docs/PROVIDERS.md",
      "docs/UI.md",
      "docs/phases/**",
      "docs/guides/**",
      "docs/assets/**"
    ]
  },
  "allow": [
    "docs/ROADMAP.md",
    "docs/DECISIONS.md",
    "AGENT.md"
  ]
}
```

### Final gate

1. `node scripts/audit-ownership.mjs .tmp/waves/P8-B.json` → `pnpm install --frozen-lockfile` → `pnpm check` →
   `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
2. The P8-A probes again (after `rm -rf .tmp/e2e`).
3. `for i in 1 2 3; do pnpm test:e2e || exit 1; done` (`chromium` + `mobile` + `tablet`), with the OS color scheme
   emulated as light; `E2E_SCREENSHOTS=1 pnpm test:e2e --grep @screenshots` → dark + light reviewed (the panel on
   desktop and the mobile sheet included).
4. `pnpm audit --prod --audit-level high`; the two advisories re-checked with the P8-00 rule.
5. **Real v1.3 → v1.4 upgrade**: `git worktree add .tmp/v13 8879e6e`, install and build there, run it on a fresh data
   directory and seed the full set (password, provider / plugin / MCP secrets, a share link, a pending approval,
   branched chats, referenced and orphaned files, a generated image, a git project with agent edits), stop it, start
   v1.4 on the same data directory → `0005` applied, everything intact, the old tool parts render, a rewind on a
   pre-v1.4 message reports nothing to restore, the Git view works, `fileSweep` is off.
6. Docker (daemon permitting): `git --version` in the image; the Git view on the default root; a volume owned by
   another uid → `refused` with the documented reason; else left to the CI `docker` job.
7. `git status --porcelain` of the repository unchanged by `pnpm test`.
8. ROADMAP + wave log → commit `chore: final gate for harness-forge v1.4`; write the project memory (state, commits,
   user actions); push only when the user asks. The live provider suite stays the user's (paid).

---

## Outcome

Written by the coordinator at the final gate.

---

## Risks

State before P8-0a.

| Risk | Mitigation |
|---|---|
| Repository config runs code through git (fsmonitor, filters, textconv, hooks, pager, includes) | one hardened runner frozen in P8-0b (C21); the fixed `-c` overrides and the filter neutralization; `GIT_CEILING_DIRECTORIES`; the sentinel suite and probe 5; never `git diff` |
| A revert or rewind destroys work | a snapshot first, undo batches, conflict detection with an explicit force, 409 `run-active` for the whole project, the per-file lock |
| Allowlist bypass through shell syntax | the fail-closed shared parser (C18) with table and fuzz tests, server-side enforcement, refused rule words, probe 7 |
| The working folder escapes the project | clamped and re-resolved on every call through `resolveWorkspacePath`; derived from stored outputs, never trusted from the client |
| The sweep deletes a file in use | opt-in, the 24 h grace plus the 24 h boot delay, pins, the DELETE re-check, the plugin data scan, the automatic run skipped when the scan is partial |
| A server restarted more often than daily never sweeps | `nextRunAt` shown in Settings → Data; the manual cleanup still works |
| Checkpoint storage grows | 8 MiB per file, 512 MiB per project, 30 days, the prune timer, cascade deletes, `purge` on delete-all |
| Shell and plugin edits are not restorable | journaled as `shell` / `untracked` rows and listed in the rewind dialog; documented (PLUGINS.md, the guide) |
| The per-file lock only works inside the server process | one server per data dir (`server.lock`); documented |
| Hot files (`S/chat/**`, `ChatView`, `ToolApprovalCard`, `useChatSession`, `MessageActions`) | one owner per file per wave; the mounts, emit chains and interfaces land in P8-0b (C20) |
| Parallel W8.1 / W8.2 / W8.3 depend on each other's store | the frozen `CheckpointBlobStore` + fakes and a row-insert helper from C19; the real round trip probed at the gate |
| Migration `0005` rebuilds tables | CREATE only, the SQL inspection in K3, the upgrade test, the upgrade probe and the real upgrade |
| git missing or "dubious ownership" (Docker bind mounts) | `describe.skipIf(!hasGit())`, explicit reasons (`git-missing`, `refused`), the docs, the Docker probe |
| Doc-coupled counts (routes 95, events 12, settings 21, tables 18) | every contract and API.md in C17; the tables in C19 |
| A cached mock listing hides `mock:checkpoint` / `mock:shell` | `.tmp/e2e` is wiped before every gate |
| The upgrade seed loses its project path when copied | the seed's project lives under `.tmp/gates/P8-0b/seed2-roots` outside the data dir; probes run on fresh copies |
| Wave size (11 agents + 3 skeleton agents) | fix-up agents in P8-B; first cuts: the global rules UI, the `weekly` option, the per-view count badge |
