# Phase 7 — v1.3: agent workspace + stabilization

Part of the harness-forge build plan. Progress is tracked in `docs/ROADMAP.md` (coordinator only). Shared names come
from `docs/DECISIONS.md` (ADR-031 … ADR-035, the ADR-028 consequence and the contract seed; it wins on conflict);
endpoints and DTOs from `docs/API.md` (the `projects.ts`, `keys.ts` and `data.ts` cleanup endpoints, the projects,
workspace tool, key and cleanup schemas, the chat request `projectId`, the `project.changed` / `key.rotated` events and
the route key index); components, props, store and composable signatures, shortcuts and test ids from `docs/UI.md`
(1.2, 2.12 – 2.14, 5.3, 5.5, 5.6, 7.1 – 7.3, 7.11, 7.19, 7.20, 8.4, 9.4, 9.8, 9.10, 10.3, 10.4, 11, 11.4, 13.8, 14, 15);
flows, tables and security rules from `docs/ARCHITECTURE.md` (3, 5, 6.2, 6.13 – 6.15, 7, 8, 10.3, 10.9, 11, 12); the
plugin API 1.2.0 and the builtin `core-workspace` from `docs/PLUGINS.md` (1, 9, 10); the `mock:workspace` model from
`docs/PROVIDERS.md` (8); the user guide `docs/guides/using-projects.md`.

**Status (2026-10-03):** P7-00 in progress: the math rendering tests are committed (`3af05be`); the Dependabot merges
(#2 → #3 → #4) are pending. P7-0a has started: K1 is done (DECISIONS.md, ROADMAP.md, AGENT.md); C13 (contracts,
API.md) and D7 (this file and the other docs) run in one launch. "Outcome" at the end of this file records what
actually happens in each wave; the plan sections below are corrected where the implementation differs from the plan.

## Goal

Ship v1.3: an agent workspace on real files, plus a stabilization track.

- **Projects** (ADR-031, supersedes ADR-015 with ADR-032 / ADR-033): a project is a named folder on the server host
  (`projects` table, id `prj_` + 16); a chat optionally belongs to one (`chats.project_id`, nullable, no foreign key);
  project folders live only inside the allowed roots `HF_WORKSPACE_ROOTS` (default `<dataDir>/workspaces`); creating
  a project needs fresh auth; `AGENTS.md` (else `CLAUDE.md`) from the project root joins the instructions; the sidebar
  filters chats by project.
- **Workspace tools and Accept edits** (ADR-032): the builtin plugin `core-workspace` registers `read_file`,
  `list_directory`, `find_files`, `search_files`, `write_file`, `edit_file` and `shell`; plugin API 1.2.0 adds
  `ToolCallContext.workspace`, `ToolDefinition.workspace` and `ImageGenerateResult.modelName`; the permission mode
  `edits` ("Accept edits") runs safe tools and project file edits without asking while everything else asks.
- **Shell with approval** (ADR-033): `bash -c` (else `sh -c`) in the project folder with the server's privileges, a
  minimal environment, its own process group, a timeout of at most 590 s and capped output; `HF_WORKSPACE_SHELL=0`
  removes it. No OS sandbox: Docker is the sandbox.
- **Web**: a project switcher in the sidebar, a project picker for new chats, a project chip and "Move to project" in
  chats, Settings → Projects with a folder browser, inline diffs and terminal output in tool rows, rich approval
  previews, the "Accept edits" mode and a `projectMaxSteps` setting (UI.md 1.2 amended: no side panes).
- **Stabilization**: Dependabot #2 – #4 merged (P7-00); master-key rotation online and through a CLI (ADR-034); a
  manual orphaned-file cleanup with a preview (ADR-035); small API fixes (`modelName` in the plugin image result; an
  unknown provider is `400 provider_not_configured` on the media routes, in `ctx.images` and in `ctx.ai` too).

Out of scope (ROADMAP backlog): checkpoints / undo of workspace edits, a changes side panel (git status and diffs), a
command allowlist for the shell, OS-level sandboxing of the shell, an automatic file sweep, a persistent shell session
(a `cd` that sticks), syntax highlighting in diffs, the shell on Windows, knowledge / RAG, child-process isolation for
code plugins, a plugin registry, multi-user accounts, desktop / CLI clients, video generation, audio attachments to chat
models, declarative image and voice providers.

Totals after Phase 7: routes 76 → **85** (`projects.list`, `projects.create`, `projects.update`, `projects.remove`,
`projects.browse`, `keys.get`, `keys.rotate`, `data.cleanupPreview`, `data.cleanup`), route modules 21 → **23**
(`projects`, `keys`), tables 15 → **16** (`projects`), migration **`0004_projects`** (table `projects` + 2 indexes +
`chats.project_id`, no backfill), ADR-031 … ADR-035 (+ the ADR-028 consequence), plugin API **1.2.0** (additive; the
builtins `core-workspace` 1.0.0 and `core-tools` 1.2.0 declare `^1.2.0`), the builtin plugin `core-workspace` with 7
tools, SSE events `project.changed` and `key.rotated`, conflict reasons `env-key` and `key-mismatch`, the notice code
`workspace-unavailable`, settings `projectMaxSteps` (100; `maxSteps` and `projectMaxSteps` accept 1–200). Agents: 2
(P7-0a: C13, D7) + 3 (P7-0b: C14, C15, C16) + 13 (P7-A: W7.1 – W7.13) + 2 (P7-B: W7.14, W7.15; W7.16 / W7.17 only
for red P7-A gate items), in the Phase 5 wave method (ADR-016).

## Entry criteria

- v1.2 is on `main` (`b5bb2ec` final gate, pushed, CI green) plus `3af05be` (`test: cover math rendering`):
  `pnpm check` (5091 tests at the v1.2 gate), `pnpm build` and e2e 61 passed (`chromium` + `mobile` + `tablet`).
- The approved plan exists; K1 is done: DECISIONS.md carries ADR-031 … ADR-035, the ADR-028 consequence and the Phase 7
  contract seed (environment variables, the data directory, ids, builtin plugin and tool names, `ToolMode`, the HTTP
  API table with `projects.ts` / `keys.ts` / the cleanup routes, events, settings keys, tables and migration `0004`, the
  mock model); ROADMAP.md has the Phase 7 section; AGENT.md has the plugin API 1.2.0 and agent workspace facts, the new
  variables, the `pnpm key:rotate` command and the Phase 7 freeze additions.

## Exit criteria

- Every Phase 7 item in `docs/ROADMAP.md` is checked; every wave gate is green; the final checkpoint commit
  `chore: final gate for harness-forge v1.3` exists (pushed only when the user asks).
- `pnpm check` and `pnpm build` are green; the built-page CSP test passes with `HF_TEST_REQUIRE_WEB_BUILD=1`.
- `pnpm test:e2e` (projects `chromium` + `mobile` + `tablet`) is green 3× in a row, including the new specs
  `core/projects`, `core/workspace-tools`, `core/data-maintenance`, `mobile/projects` and the extended tablet touch
  targets; the `@screenshots` run (dark + light) was reviewed.
- The gate probes (Gate P7-A, repeated at the final gate) are green.
- CI on `main` is green (`check`, `e2e`, `docker`, `audit`, `actionlint`); Dependabot #2 – #4 are merged with no
  downgrade.
- A v1.2 data directory boots on v1.3 with every chat, secret and share intact: migration `0004` applied, every
  `chats.project_id` null, `_keys` written and `GET /keys` → `keyCheck: 'ok'`; a rotation, the env-mode CLI round trip
  and a cleanup work on the upgraded data.
- The Docker image ships `bash` and `git`, and `rotate-key` runs inside the container (or the CI `docker` job proves
  the image when the local daemon is off).
- `pnpm test` never calls a paid API and never touches the repository's `data/` or a folder outside a temp directory;
  `pnpm test:live` stays the user's.
- README status reads "v1.3".

Manual acceptance (coordinator, `HF_MOCK_PROVIDER=1 pnpm dev`):

- Add project → browse → "New folder" (fresh auth) → the switcher shows the new project.
- A new chat in the project with `mock:workspace`: the edit approval shows the diff → Allow → the row reads `+1 −1` and
  expands to the diff → the shell approval (no "Always allow") → the terminal shows "workspace agent" and `exit 0`.
- Accept edits: edits run, the shell still asks; the approval checkbox "Accept all edits in this chat" switches the mode.
- Move a chat out of the project; delete the project (the chats stay, the folder stays).
- Settings → Data → Rotate key… (typed `ROTATE`) → another browser is signed out and the share link changes; Storage
  cleanup: preview, then remove.
- Math renders in dark and light (the katex 0.18 merge).
- A v1.2 data directory boots on v1.3 with every chat, secret and share intact.

With real keys (the user, optional): "Create hello.py that prints the date and run it" in a project chat.

## Steps

| Step | Owner | Output |
|---|---|---|
| P7-00 | coordinator | memory fix, math tests (`3af05be`), Dependabot #2 → #3 → #4 rebased, checked and merged |
| P7-0a | coordinator (K1, K2) + C13, D7 | decisions, ROADMAP, AGENT.md, dependencies + Docker; every shared / SDK contract + 501 stubs + API.md; every other doc |
| Gate P7-0a | coordinator | audit, frozen install, check, build, CSP test, 9 new routes mounted, e2e regression, Docker image check, commit |
| P7-0b | coordinator (K3) + C14, C15, C16 | v1.2 upgrade copy, schema + migration `0004`, server, keys / maintenance and web skeletons, `mock:workspace`, test ids, FREEZE |
| Gate P7-0b | coordinator | audit, `nuxi prepare`, check, build, CSP test, e2e regression, v1.2 upgrade probe, FREEZE, commit |
| P7-A | W7.1 – W7.13 (one launch) | features |
| Gate P7-A | coordinator | CCR batch, `nuxi prepare`, check, build, probes, e2e, screenshots, audit, commit |
| P7-B | W7.14, W7.15 (+ W7.16 / W7.17 fix-ups when the P7-A gate is red) | feature e2e, docs reconciliation |
| Final gate | coordinator | e2e ×3 (three projects), v1.2 → v1.3 upgrade, Docker, audit, ROADMAP, memory, commit |

## Deviations from the plan (binding)

The three planner reports (`.tmp/p7-designs/{server,web,stabilization}.md`) are superseded where the reconciliation
list (`.tmp/p7-designs/README.md`) disagrees with them:

- **`POST /projects` body** is `{ name, path, newFolder? }`: with `newFolder`, `path` is the parent folder and the
  folder is created (the web report's `{ create, parentPath, folderName }` is replaced).
- **`ProjectSummary`** = `{ id, name, path, instructions, available, issue, instructionsFile, chatCount, createdAt,
  updatedAt }` (the web report's `folderExists` is `available`).
- **Browse result** = `{ path, parent, roots: { path, available }[], entries: { name, path, projectId }[], truncated }`
  (roots are objects, not strings).
- **`project.changed`** data = `{ id, project: ProjectSummary | null }` (null = deleted; no `action` field).
- **Exports and backups never carry `projectId`**; imports never set it (the web report's "include in exports" is
  rejected). `chat.created` / `chat.updated` carry it through the chat summary; search results too.
- **Event name `key.rotated`** (not `keys.rotated`); the route module is still `keys` (`GET /keys`, `POST /keys/rotate`).
- **ADR numbers**: ADR-031 projects, ADR-032 workspace tools + Accept edits + plugin API 1.2.0, ADR-033 shell, ADR-034
  master-key rotation, ADR-035 orphaned file cleanup (the stabilization report used 033 / 034).
- **Delete-all keeps projects** (configuration, like MCP servers). `chats.project_id` has **no** foreign key (and no
  hand-written FK fallback); the project service detaches chats in a transaction.
- **`mock:workspace`** is implemented in P7-0b by C14, not by a P7-A agent.
- **Ownership**: the wave tables of this file (C13, D7, C14, C15, C16, W7.1 – W7.15) replace every ownership suggestion
  of the reports.
- **Steps**: `projectMaxSteps` (default 100, used for chats with a project); `maxSteps` and `projectMaxSteps` accept
  1–200; plain chats keep `maxSteps` 20.
- **The shell tool is named `shell`** (a probe in the stabilization report says `run_shell`: wrong).
- **Test ids**: the Settings → Data ids come from the stabilization report (`data-key-section`, `data-key-rotate`,
  `key-rotate-dialog`, `key-rotate-confirm`, `key-rotate-submit`, `data-cleanup-section`, `data-cleanup-check`,
  `data-cleanup-summary`, `data-cleanup-run`, `data-cleanup-confirm`); every other new id from `web.md` section 6. All
  60 are collected in UI.md 13.8.
- **Totals**: 85 routes (76 + 5 projects + 2 keys + 2 data cleanup), 23 modules, 16 tables, migration `0004_projects`.

Plan-level decisions (from the reports, kept by the plan):

- **No AI SDK `experimental_sandbox`**: its `run()` returns uncapped strings and only an exit code (no signal, no
  timeout flag), has no path guards and would leak an experimental type into the plugin API. The shell has its own
  runner (`S/workspace/shell.ts`).
- **Shell timeout at most 590 s**: the guard maximum of 600 s is frozen (`GUARD_TIMEOUT_MAX_MS`); the tool's
  `timeoutMs` is 600,000 and its own `timeout_ms` caps at 590,000, so its own timeout always fires first.
- **No `GET /projects/:id`** (no clash with `/projects/browse` in Hono); a single project comes from the list.
- **Deleting a project** sends one `project.changed` (`project: null`), not one `chat.updated` per detached chat; the
  web clears `projectId` locally.
- **Fresh auth** only on `POST /projects` and `POST /keys/rotate` (a session can already create chats and approve its
  own calls, so more prompts would add friction, not protection); the kill switch for code execution is
  `HF_WORKSPACE_SHELL`, which no session can change.
- **Docs** are written by D7 (UI, ARCHITECTURE, PLUGINS, PROVIDERS, the guides, README, `.env.example`, this file) and
  C13 (API.md) in P7-0a, and reconciled by W7.15 in P7-B. P7-A agents never edit docs.
- **Feature e2e specs** are written in P7-B by W7.14, not by the P7-A web agents.
- **Every new web test id** is added by C15 in P7-0b, copied verbatim from UI.md 13.8; `utils/testids.ts` is frozen
  during P7-A.
- **Ownership additions** (beyond the plan's globs, needed by the tasks): C15 also owns
  `W/components/app-shell/chat-nav/palette.test.ts` (the Projects nav entry adds `go-settings-projects`) and the
  `approval` emit type of `W/components/chat/parts/ToolPart.vue` and `W/components/chat/ChatMessage.vue` (`acceptEdits?`,
  type only); W7.12 also owns `W/components/settings/general.ts` (the "1 to 100" rule of Max steps lives there).

Open points decided by D7 while writing the docs (the coordinator confirms or changes them at Gate P7-0a):

- `core-workspace` loads after `core-mcp` and before `mock` (`BUILTIN_PLUGIN_IDS` order).
- More than 200 projects (`LIMITS.projectsMax`) → `400 validation_error` on `path` ("A server can have up to 200
  projects."), like the share-link cap.
- `GET /projects/browse` without `path` answers `path: null`, `parent: null`, `entries: []` and the roots; the browser
  lists the roots.
- C16's `recoverKeyState` stub already writes `_keys = { version: 1, check, rotatedAt: null }` at the first v1.3 boot
  (secrets table empty or one row decrypts), so the P7-0b upgrade probe can check it; the `secret.key.next` recovery
  table is W7.7's.
- A chat request answered `409 busy` (a key rotation blocks runs) shows the toast "The server is rotating its encryption
  key. Try again in a moment." and puts the message back into the composer; the Data page's busy toast becomes "Another
  data task is running. Try again when it finishes." (import, delete-all, rotation, cleanup).
- `project-add` marks every "Add project" control (the switcher item, the Settings → Projects button and its empty
  state), like `share-copy` marks every "Copy link".
- `mock:workspace` behavior after a failed (not denied) workspace call is left to C14; PROVIDERS.md 8 records what is
  built.

## Rules for every Phase 7 agent

- Read `AGENT.md` fully, your section of this file and the docs it names. Paths: `S` = `apps/server/src`,
  `W` = `apps/web/app`. Stay inside your OWNED globs; the FREEZE list below overrides any owned glob.
- Never run: package installs or CLIs (`pnpm add`, `drizzle-kit`, `nuxi`, `shadcn-vue`), git write commands,
  `nuxt dev` / `nuxt build` / `nuxt prepare`, servers on :3000 / :8787 / :8899, **never `pnpm test:live`** (the
  repository `.env` may hold real keys and the suite makes paid calls), and never `pnpm key:rotate` / `rotate-key`
  against the repository's `data/` (tests use temp data directories). Existing scripts are allowed.
- Your own server uses your slot: `HF_PORT=879k HF_DATA_DIR=.tmp/<agent-id>`; e2e agents use `889k` (k ≠ 9) with
  `E2E_BASE_URL`. Stop every process you started (shell children included) before reporting. Prefer `createTestApp()` +
  `app.request()`.
- **Temp folders**: tests create workspaces, roots and data directories with `realpath(await mkdtemp(join(tmpdir(),
  'hf-')))` (macOS `/var` is a link to `/private/var`, so an un-resolved path fails every containment check) and remove
  them afterwards; never the repository's `data/`, `.tmp/e2e` or a real project folder.
- **Shell tests** use POSIX `sh` syntax only (CI runs Linux, where `/bin/sh` may be `dash`): no bash-only features
  (`[[ … ]]`, arrays, `$'…'`, `source`), generous time margins, and skipped on Windows (`process.platform ===
  'win32'`).
- **Never spawn a shell string outside `S/workspace/shell.ts`**: no `spawn(…, { shell: true })`, `exec`, `execSync` or
  `child_process` with a command string anywhere else (the MCP stdio transport keeps its own argument-array spawn).
- **Every path a workspace tool touches** resolves through the frozen `resolveWorkspacePath` (`S/workspace/paths.ts`);
  no `fs` call on a model-supplied path without it.
- **Logging**: never log key material, secret values, file contents, tool inputs or outputs at `info`; the shell logs
  the exit code, duration and byte counts at `info` and the command only at `debug`, redacted.
- Contracts: DTOs and route keys only from `@harness-forge/shared`, plugin shapes only from `@harness-forge/plugin-sdk`;
  server services only through the frozen `types.ts` interfaces. A missing member, a contract change, a frozen-file
  edit or a **new test id** is a CCR in your report (file, current shape, proposed shape, reason) plus a local adapter
  so you can keep working.
- New components are imported explicitly by path (`import DiffView from './tools/DiffView.vue'`): the coordinator runs
  `nuxi prepare` only at the gates, so auto-import types do not know files created mid-wave.
- The props, emits and root test ids of the P7-0b stub components and the signatures of the `projects` store, the new
  `chats` store members and the `useChatSession` additions (UI.md 10.4, 11, 11.1) are frozen: implement behind them;
  a change is a CCR.
- No doc edits in P7-A: write "For W7.15" notes (facts, deviations, suspected doc errors) into your report.
- Web unit tests: Nuxt composables come through a local `nuxt-imports.ts` that tests `vi.mock`; every password prompt
  goes through `useFreshAuth()` (UI.md 8.4).
- Verify before reporting — server: `pnpm -F @harness-forge/server test` · `pnpm typecheck`; shared:
  `pnpm -F @harness-forge/shared test`; plugin SDK: `pnpm -F @harness-forge/plugin-sdk test`; web:
  `pnpm -F @harness-forge/web test` · `pnpm -F @harness-forge/web typecheck:fast`; all: `pnpm check:english`.
- Report ≤ 300 words in the AGENT.md format (tasks, files, commands + results, CCRs, dependency requests, open issues,
  suggested ROADMAP updates).

## FREEZE in Phase 7

In force since Phase 0 (AGENT.md): `packages/*/src`, `S/app.ts`, `S/db/schema.ts`, `apps/server/drizzle/**`, every
`*/types.ts` under `S`, `S/builtin-plugins/index.ts`, `W/layouts/**`, store signatures in `W/stores/**`,
`apps/web/nuxt.config.ts`, every `package.json` and config file, `W/components/{ui,ai-elements}/**`, the CSS design
tokens in `W/assets/css/main.css`. Added in Phase 5: `S/services/{data,shares}/types.ts`, `W/layouts/share.vue`, the ui
store members `shareChatId` / `openShare` / `closeShare`, and `W/utils/testids.ts` (a new test id is a CCR). Added in
Phase 6: `S/services/{images,audio}/types.ts`, the props of the P6-0b stub components and the signatures of
`useImageOptions`, `useVoiceInput` and `useSpeechPlayer`.

P7-0a and P7-0b open the frozen files **only** for their named owners:

- P7-0a: C13 — `packages/*/src/**`, `S/app.ts`; K2 — the `package.json` files, `pnpm-workspace.yaml`,
  `pnpm-lock.yaml`, `Dockerfile`, `docker-compose.yml`.
- P7-0b: K3 — `S/db/schema.ts` + `apps/server/drizzle/**`; C14 — `S/types.ts`, `S/services/{projects,chats,images}/types.ts`,
  `S/builtin-plugins/index.ts`; C16 — `S/security/types.ts`, `S/services/{keys,maintenance,events,files,data}/types.ts`;
  C15 — `W/utils/testids.ts`, the store signatures of `W/stores/projects.ts` (new) and `W/stores/chats.ts` (the new
  members only).

Added to the freeze after Gate P7-0b:

- `S/services/{projects,keys,maintenance}/types.ts` (new) and the P7-0b versions of
  `S/services/{chats,files,data,images,events}/types.ts`, `S/types.ts` and `S/security/types.ts`;
- `S/workspace/paths.ts` (`resolveWorkspacePath`, complete and tested by C14);
- `S/services/chats/approvals.ts` (`denyOpenApprovals`, C16);
- the boot hooks of `S/main.ts` (C16): the `rotate-key` dispatch on `argv[2]` before the boot, `recoverKeyState` after
  the migrations and before `createDeps` with the keyring factory taking its `keyVersion`, `acquireServerLock` after
  the data directory exists and its release at shutdown and on a failed boot;
- `W/utils/testids.ts` (again: the Phase 7 ids of UI.md 13.8 are in);
- the props, emits and root test ids of the P7-0b stub components (UI.md 10.4): `ProjectSwitcher`,
  `ProjectMenuItems`, `NewChatProjectPicker`, `ChatProjectChip`, `AddProjectDialog`, `FolderBrowser`,
  `ProjectInstructionsDialog`, `ProjectsSettings`, `WorkspaceToolBody`, `DiffView`, `TerminalOutput`, `FileContent`,
  `FileList`, `ToolApprovalPreview`, `EncryptionKeySection`, `RotateKeyDialog`, `StorageCleanupSection`, and the
  prop-only additions `ChatHeader.projectId?`, `ChatComposer.projectId?`, `PermissionMenu.modes?`,
  `ToolApprovalCard.workspace?`;
- the `projects` store signature and the `chats` store members `projectFilter` / `setProjectFilter` (UI.md 11);
- the `useChatSession` additions `projectId`, `setProject` and `ToolApprovalDecision.acceptEdits` (UI.md 11.1).

No CCR is pre-approved for P7-A; the coordinator batches CCRs at Gate P7-A.

---

## Wave P7-00 — stabilization start (in progress)

The coordinator runs this before P7-0a closes; merges are authorized by the user's choice, local commits are pushed
only when the user asks.

1. **Math tests (done, `3af05be`)** — `W/components/chat/parts/markdown/math.test.ts` (the KaTeX `\frac{a}{b}`
   annotation, `mhchem` `\ce{H2O}`, the CSS import) and `e2e/specs/core/math.spec.ts` (`mock:echo`; MathML
   annotations present, no `katex-error`, the KaTeX font family), so the katex 0.18 bump has a guard.
2. **Dependabot #2 (ai-sdk) → #3 (motion-v) → #4 (katex 0.18)**, one at a time: `gh pr comment N --body "@dependabot
   rebase"` → wait for a new head and `CLEAN` → check the diff for downgrades → `gh pr checks N --watch` → for #4 only:
   a worktree `.tmp/pr4`, `pnpm install --frozen-lockfile && pnpm build`, katex `exports` still allow
   `./dist/contrib/mhchem` and the CSS, a local math run on port 8897 → `gh pr merge N --squash --delete-branch` →
   watch the `main` CI run.
3. **After the merges**: `git pull --rebase` → `pnpm install --frozen-lockfile` → `pnpm why ai katex motion-v` (one
   version each) → `pnpm check` → `pnpm build` → the CSP test → e2e → `pnpm audit --prod --audit-level high`; manual:
   math in dark and light, the Shimmer animation, a chat send. Revert path: `git revert <katex squash commit>`.
4. The stale memory note ("5 commits unpushed") is corrected.

---

## Wave P7-0a — decisions, docs, contracts

Two agents in one launch (C13, D7) after K1; K2 runs alongside.

### Coordinator actions

- **K1 (done)** — `docs/DECISIONS.md`: ADR-031 … ADR-035, the ADR-028 consequence (`modelName`, the unknown-provider
  400), the contract seed (env, data dir, ids, builtins, tools, `ToolMode`, events, HTTP table, settings, tables,
  migration, mock). `docs/ROADMAP.md`: the Phase 7 section and the trimmed backlog with the Phase 7 follow-ups.
  `AGENT.md`: plugin API 1.2.0 and agent workspace facts, `HF_WORKSPACE_ROOTS`, `HF_WORKSPACE_SHELL`, the CLI-only
  `HF_NEW_MASTER_KEY`, `pnpm key:rotate`, the Phase 7 freeze additions.
- **K2** — `apps/server` dependencies `diff@^8.0.4`, `ignore@^7.0.10`, `picomatch@^4.0.7` and the dev dependency
  `@types/picomatch@^4` (verify the installed types; `path.matchesGlob` is the fallback for picomatch); the root
  script `key:rotate` (`node apps/server/dist/main.mjs rotate-key`); `Dockerfile` runtime `apk add --no-cache tini bash
  git`; `docker-compose.yml` `pids_limit: 512` and a commented `./workspaces:/workspaces` mount with
  `HF_WORKSPACE_ROOTS=/workspaces` (the folder must be writable by uid 1000).
- Ownership file `.tmp/waves/P7-0a.json` (below).

### C13 contracts (k2)

- **Mission.** Write every shared and plugin SDK contract of Phase 7, the nine new routes as 501 stubs and
  `docs/API.md`, keeping `pnpm check` green.
- **Owned.** `packages/*/src/**`, `docs/API.md`, `S/app.ts`, `S/http/routes/{projects,keys}.ts` (new 501 stubs),
  `S/http/routes/data.ts` (the two cleanup stubs only), `S/testing/api-samples.ts`, `S/http/routes-mounted.test.ts`,
  the route-table-driven security tests (`S/http/middleware/{session-auth,fresh-auth}.test.ts`,
  `S/security/{fresh-auth-routes,secret-leaks,request-guards}.test.ts`), `S/plugins/templates/sdk-types.ts` + its
  tests, `S/plugins/compile.test.ts`, `examples/plugins/*/harness-forge.d.ts`, `W/utils/testing/fixtures.ts`, and every
  fixture that needs a new required field (listed in the report; the coordinator accepts them in the audit).
- **Read-only highlights.** `.tmp/p7-designs/**` (the README reconciliation is binding), `docs/DECISIONS.md`,
  `packages/shared/src/api/routes.test.ts` and `contract.test.ts` (doc-coupled: API.md section 8 and the DECISIONS
  module table), `packages/shared/src/schemas/manifest.test.ts` (parses the PLUGINS.md manifests written by D7),
  `S/plugins/templates/templates.test.ts` (the mirror must match the SDK).
- **Tasks.**
  1. **C13-T1 Enums, limits, ids** — `toolModeSchema` += `edits`; `workspaceAccessSchema` (`read | write | execute`);
     `LIMITS` += `projectNameMaxChars` (80), `projectsMax` (200), `workspacePathMaxChars` (4096), `browseEntriesMax`
     (500), `projectFileBytes` (32,768) and the 200 step cap (`maxSteps` and `projectMaxSteps` 1–200);
     `PROJECT_ID_PATTERN`, `projectIdSchema`, `createProjectId()`; `BUILTIN_PLUGIN_IDS` += `core-workspace`. *Accept:*
     enum, limit and id tests.
  2. **C13-T2 Projects** — new `schemas/projects.ts`: `projectSummarySchema` (`{ id, name, path, instructions,
     available, issue, instructionsFile: 'AGENTS.md' | 'CLAUDE.md' | null, chatCount, createdAt, updatedAt }`),
     `projectCreateSchema` (strict `{ name, path, newFolder? }`; `folderNameSchema`: 1–255 characters, trimmed, no `/`,
     `\`, NUL or control characters, not `.` / `..`, no leading dot), `projectUpdateSchema` (strict `{ name?,
     instructions?: string | null }`, at least one key; the path never changes), `projectBrowseQuerySchema` (`{ path?
     }`), `projectBrowseSchema` (`{ path, parent, roots: { path, available }[], entries: { name, path, projectId }[],
     truncated }`), `projectParamsSchema`. *Accept:* valid and invalid samples (strictness, folder names, the
     at-least-one-key rule).
  3. **C13-T3 Workspace tools** — new `schemas/workspace.ts`: `WORKSPACE_TOOL_NAMES`, `WORKSPACE_LIMITS` (read 2000
     lines / 2000 characters per line / 48 KiB per call, list 1000 entries, find 1000 results (default 200), search 500
     matches (default 100), write 256 KiB, edit 64 KiB strings on files ≤ 1 MiB, shell 16 KiB command, timeout 1000 –
     590,000 ms (default 120,000), output ~60 KiB, diff ~24 KiB), every tool's input and output schema (ARCHITECTURE.md
     6.13), `workspaceDiffSchema` (`{ hunks: { oldStart, oldLines, newStart, newLines, lines }[], added, removed,
     truncated }`). *Accept:* samples for every schema, including the shell timeout bounds.
  4. **C13-T4 Keys and cleanup** — new `schemas/keys.ts`: `keyStatusSchema` (`{ source: 'env' | 'file', keyVersion,
     rotatedAt, keyCheck: 'ok' | 'mismatch' | 'unknown', secrets, unreadableSecrets, shares, pendingApprovals,
     canRotate }`), `keyRotateBodySchema` (strict `{ confirm: 'ROTATE' }`), `keyRotationResultSchema` (`{ keyVersion,
     rotatedAt, secrets, skippedSecrets, shares, approvalsExpired, chats, runsStopped }`); `schemas/data.ts`:
     `dataCleanupPreviewSchema` (`{ files, fileBytes, blobs, diskBytes, tempFiles, recentFiles, graceMs, lastRunAt }`),
     `dataCleanupResultSchema` (`{ files, fileBytes, blobs, diskBytes, tempFiles, ranAt }`). *Accept:* samples; the
     literal `ROTATE` only.
  5. **C13-T5 Chats, chat request, settings, events, tools, images** — `chatSummarySchema.projectId` (nullable),
     `chatCreateSchema.projectId?`, `chatUpdateSchema.projectId` (nullable, optional), `chatsQuerySchema.projectId`
     (`<id> | 'none'`); both chat export schemas omit `projectId`; `chatRequestBodySchema.projectId?`; notice code
     `workspace-unavailable`; settings `projectMaxSteps` (100), `maxSteps` up to 200, `defaultToolMode` accepts `edits`;
     events `project.changed` (`{ id, project }`) and `key.rotated` (`{ keyVersion, rotatedAt, chatIds }`); conflict
     reasons `env-key`, `key-mismatch`; `toolSummarySchema.workspace` (nullable); `generateImageToolOutputSchema.modelName`
     (optional, ≤ 200). *Accept:* chat export v1 and v2 fixtures written by v1.2 still parse; a settings document
     without the new key parses with the default; the export schemas reject nothing a v1.2 export contains.
  6. **C13-T6 Route table** — modules `projects` and `keys` in `ApiModule`; keys `projects.list`, `projects.create`
     (`fresh: true`, 201), `projects.update`, `projects.remove` (204), `projects.browse`, `keys.get`, `keys.rotate`
     (`fresh: true`), `data.cleanupPreview`, `data.cleanup` → **85** routes. *Accept:* `routes.test.ts` (API.md
     section 8 index + the DECISIONS module table) and `contract.test.ts` at 85.
  7. **C13-T7 Plugin SDK 1.2.0** — `PLUGIN_API_VERSION = '1.2.0'`; `ToolWorkspaceAccess`, `ToolWorkspace {
     projectId, name, root }`, `ToolCallContext.workspace?`, `ToolDefinition.workspace?`, `ImageGenerateResult.modelName`
     (PLUGINS.md 9); `ToolMode` includes `edits`; the mirror `S/plugins/templates/sdk-types.ts` (its `ToolMode` literal
     too); `compile.test.ts` expects `"1.2.0"`; the example `harness-forge.d.ts` files regenerated. *Accept:* the
     templates test (mirror vs SDK) green; a plugin with `engines.harness: "^1.0.0"` still loads.
  8. **C13-T8 `docs/API.md`** — the modules `projects` and `keys`, the projects / workspace / keys / cleanup schemas,
     the chats changes (`projectId`, the filter, the move answers 404 / 409 `run-active`), the chat request `projectId`
     rule, `workspace-unavailable`, the events, the conflict reasons, `projects.ts` and `keys.ts` endpoints with every
     answer, `data.ts` cleanup, the unknown-provider 400 on the media routes, the 85-route index in the parsed format.
  9. **C13-T9 Stubs and compile fixes** — `S/app.ts` mounts `projects` and `keys`; the nine routes answer `501
     not_implemented` (body and query validation may answer 400 first; `projects.create` and `keys.rotate` pass the
     fresh-auth middleware first); `api-samples.ts`; the route-table-driven security tests follow the new routes;
     `W/utils/testing/fixtures.ts` and every other fixture get `projectId: null`, `projectMaxSteps`, `workspace: null`.
     *Accept:* `routes-mounted.test.ts` green (no new route answers 404); `pnpm check` green.
- **Tests.** Schema tests for every new DTO; route-table tests; the updated route-driven security tests; the SDK export
  test.
- **Verify.** Shared, plugin SDK, server and web commands.

### D7 docs (k1)

- **Mission.** Write this file and update the user-facing and architecture docs so P7-0b and P7-A agents can build
  against them.
- **Owned.** `docs/phases/phase-7-v1-3.md` (new), `docs/UI.md`, `docs/ARCHITECTURE.md`, `docs/PLUGINS.md`,
  `docs/PROVIDERS.md`, `docs/guides/**`, `README.md`, `.env.example`.
- **Tasks.**
  1. **D7-T1 Phase doc** — this file: waves, agents, owned globs, tasks with acceptance criteria, gates and probes,
     ownership JSON, cross-agent contracts, risks.
  2. **D7-T2 UI.md** — principle 1.2 amended; wireframes 2.12 (switcher, new-chat picker, chip), 2.13 (Settings →
     Projects, Add project dialog), 2.14 (tool rows and approvals); the sidebar (5.3), settings nav (5.5), header (5.6),
     routes (6), parts and notices (7.1), tool rows (7.2), approval card (7.3), slash menu (7.8), permission menu
     (7.11), the new 7.19 workspace tool rendering and 7.20 projects in the chat, fresh auth (8.4), General (9.4), Data
     (9.8: Encryption key, Storage cleanup), the new 9.10 Projects, the inventory and contracts (10.3, 10.4), stores and
     composables (11, 11.1, the new 11.4), shortcuts (12), the new 13.8 test ids, accessibility and touch (14), copy
     (15).
  3. **D7-T3 ARCHITECTURE.md** — the server and web maps (3, 4), the boot (5: key recovery, `server.lock`,
     `projects.start()`), the approval table with `edits` (6.2), the new 6.13 agent workspace, 6.14 master-key rotation
     and 6.15 orphaned file cleanup, the data directory (7), the data model and migration `0004` (8), secrets at rest
     (10.3), the new 10.9 workspace security, topology and Docker (11), observability (12).
  4. **D7-T4 PLUGINS.md** — plugin API 1.2.0 and its changelog (including "an unknown provider in `ctx.ai` /
     `ctx.images` is now `provider_not_configured`"), the builtin `core-workspace` and its 7 tools, `ToolMode` `edits`
     in the approval section, the `ctx.storage` note for file ids (cleanup).
  5. **D7-T5 PROVIDERS.md** — the `mock:workspace` model (8); `modelName` where image results are described.
  6. **D7-T6 Guides** — the code-plugin guide for API 1.2.0 workspace-aware tools; the new
     `docs/guides/using-projects.md`.
  7. **D7-T7 README and `.env.example`** — features, the status "v1.3 in progress", the workspace setup note; the two
     new variables and the CLI-only `HF_NEW_MASTER_KEY`.
- **Verify.** `pnpm check:english`; `pnpm -F @harness-forge/shared test` (`manifest.test.ts` parses PLUGINS.md).

### Wave P7-0a ownership

C13 lists the extra fixture files it had to touch in its report; the coordinator adds them to `allow` for the audit.

```json
{
  "wave": "P7-0a",
  "agents": {
    "K1": ["AGENT.md", "docs/DECISIONS.md", "docs/ROADMAP.md"],
    "K2": ["Dockerfile", "docker-compose.yml", "package.json", "apps/server/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/web/package.json"],
    "P7-00": ["e2e/specs/core/math.spec.ts", "apps/web/app/components/chat/parts/markdown/math.test.ts"],
    "C13": [
      "packages/shared/src/**",
      "packages/plugin-sdk/src/**",
      "docs/API.md",
      "apps/server/src/app.ts",
      "apps/server/src/http/routes/projects.ts",
      "apps/server/src/http/routes/keys.ts",
      "apps/server/src/http/routes/data.ts",
      "apps/server/src/testing/api-samples.ts",
      "apps/server/src/http/routes-mounted.test.ts",
      "apps/server/src/http/middleware/session-auth.test.ts",
      "apps/server/src/http/middleware/fresh-auth.test.ts",
      "apps/server/src/security/fresh-auth-routes.test.ts",
      "apps/server/src/security/secret-leaks.test.ts",
      "apps/server/src/security/request-guards.test.ts",
      "apps/server/src/plugins/templates/sdk-types.ts",
      "apps/server/src/plugins/templates/*.test.ts",
      "apps/server/src/plugins/compile.test.ts",
      "examples/plugins/*/harness-forge.d.ts",
      "apps/web/app/utils/testing/fixtures.ts"
    ],
    "D7": [
      "docs/phases/phase-7-v1-3.md",
      "docs/UI.md",
      "docs/ARCHITECTURE.md",
      "docs/PLUGINS.md",
      "docs/PROVIDERS.md",
      "docs/guides/**",
      "README.md",
      ".env.example"
    ]
  },
  "allow": []
}
```

### Gate P7-0a

1. `node scripts/audit-ownership.mjs .tmp/waves/P7-0a.json`
2. `pnpm install --frozen-lockfile` → `pnpm check` → `pnpm build`.
3. `HF_TEST_REQUIRE_WEB_BUILD=1 pnpm -F @harness-forge/server exec vitest run src/http/static.test.ts`.
4. `pnpm start:e2e` → `curl -sf http://127.0.0.1:8899/api/health`; the nine new routes are mounted (run with `bash`:
   zsh does not word-split `$r`):
   ```sh
   b=http://127.0.0.1:8899/api; p=prj_AAAAAAAAAAAAAAAA
   for r in "GET /projects" "POST /projects" "PATCH /projects/$p" "DELETE /projects/$p" "GET /projects/browse" \
            "GET /keys" "POST /keys/rotate" "GET /data/cleanup" "POST /data/cleanup"; do
     set -- $r; curl -s -o /dev/null -w "%{http_code} $1 $2\n" -X "$1" "$b$2"
   done   # 501, or 400 where validation runs before the stub (routes-mounted.test.ts covers the full matrix)
   ```
5. `pnpm test:e2e` → 61 + the math spec passed (`chromium` + `mobile` + `tablet`).
6. `docker build -t harness-forge:p7 .` → `docker run --rm --entrypoint sh harness-forge:p7 -c 'bash --version && git
   --version'` (daemon off: the CI `docker` job after the commit).
7. `pnpm why typescript` (only 6.0.x).
8. ROADMAP + wave log → commit `feat: add phase 7 contracts and docs`.

---

## Wave P7-0b — schema, migration `0004`, skeletons, FREEZE

**Entry:** Gate P7-0a green. The coordinator lands K3 first; C14, C15 and C16 start in one launch once the migration
exists (C14's upgrade test needs it).

### Coordinator actions

- **K3 Schema and migration `0004`** —
  1. Before any P7-0b build touches it, seed a v1.2 data directory on the P7-0a build (which still runs v1.2 storage):
     a password, a provider key, a plugin secret, a share link, a pending approval (`mock:tool-approval` in `ask`), a
     referenced file and an orphaned file (a chat with an attachment, then the chat deleted); stop the server, then
     `rm -rf .tmp/upgrade-v12 && cp -R <that data dir> .tmp/upgrade-v12` (never `.tmp/e2e`, which the gate migrates).
  2. `S/db/schema.ts`: table `projects` (`id` text PK, `name` text NOT NULL, `path` text NOT NULL, `instructions` text,
     `created_at`, `updated_at` integer NOT NULL; unique index `projects_path_idx` on `path`); `chats.projectId`
     (`project_id` text, nullable, **no** `references`) + index `chats_project_idx` (`project_id`, `archived`,
     `updated_at` desc, `id` desc).
  3. `pnpm db:generate --name projects`.
  4. Inspect the SQL: exactly `CREATE TABLE projects`, the two `CREATE … INDEX` statements and ``ALTER TABLE `chats`
     ADD `project_id` text;``. **Reject** any `DROP TABLE`, `__new_` or `PRAGMA foreign_keys` statement (foreign keys
     are on; a rebuild of `chats` would cascade-delete messages inside the migration transaction).
- **After C14, C15, C16** — `nuxi prepare`; the gate below; the FREEZE additions.
- Ownership file `.tmp/waves/P7-0b.json` (below).

### C14 server skeleton (k3)

- **Mission.** Freeze the server side of the workspace: additive interfaces, the environment, the project service
  stub, the complete path resolver, the `core-workspace` skeleton, the complete `mock:workspace` model, fakes and the
  database tests.
- **Owned.** `S/types.ts`, `S/deps*.ts`, `S/env*.ts`, `S/db/**` (except `schema.ts`),
  `S/services/{projects,chats,images}/types.ts`, `S/services/projects/index.ts` (stub), `S/workspace/paths*`,
  `S/builtin-plugins/index.ts`, `S/builtin-plugins/core-workspace/**`, `S/builtin-plugins/mock/**`, `S/testing/**`
  (except `api-samples.ts` and `fake-keyring*`).
- **Read-only highlights.** `.tmp/p7-designs/server.md` sections 1 – 4 and 8; ARCHITECTURE.md 6.13, 8, 10.9; PROVIDERS.md
  8; PLUGINS.md 1 (`core-workspace`); `packages/shared/src/**` (C13's contracts); `apps/server/drizzle/0004_*.sql`;
  `S/plugins/scaffold/paths.ts` (`isWithin`, `readRegularFile`, `looksLikeText` to reuse); the C16 names
  (`createKeyService`, `createMaintenanceService`, agreed through the coordinator).
- **Tasks.**
  1. **C14-T1 Types (additive)** — `S/types.ts`: `AppServices.projects`, `.keys`, `.maintenance`; `S/env.ts`:
     `Env.workspaceRoots: readonly string[]`, `Env.workspaceRootsDefault: boolean`, `Env.workspaceShell: boolean`,
     `DataPaths.workspaces`; `loadEnv` checks the syntax of `HF_WORKSPACE_ROOTS` (split on `,`, trimmed, empty items
     dropped, deduplicated; each absolute, normalized with `resolve`; refused: relative paths, NUL, a filesystem root,
     a list that names no folder) and parses `HF_WORKSPACE_SHELL` as a flag (default on); new
     `S/services/projects/types.ts` (`ProjectService { start, roots, list, get, create, update, remove, browse,
     openWorkspace }`, `OpenWorkspace { projectId, name, root, instructions, projectFile: { name, content, truncated } |
     null }`, the `openWorkspace` result `{ ok: true, workspace } | { ok: false, name, message }`);
     `S/services/chats/types.ts`: `ChatRecord.projectId`, `ChatListQuery.projectId?: string | 'none'`,
     `ChatEnsureInput.projectId?` (applied only on creation), the move through `update` (a missing project = 404);
     `S/services/images/types.ts`: `ImageGenerationResult.modelName`. *Accept:* `pnpm typecheck` green.
  2. **C14-T2 Stubs and wiring** — `S/services/projects/index.ts`: every member throws `not_implemented` except
     `start()` (creates the default root with mode 0700 and resolves; W7.1 adds the checks) and `roots()`; `deps.ts`
     builds `projects`, `keys` and `maintenance` (C16's factories) and calls `projects.start()` first in `startDeps`.
     *Accept:* `deps.test.ts` "phase 7 skeleton" (the stubs answer `not_implemented`, the default root exists 0700).
  3. **C14-T3 `S/workspace/paths.ts` (complete)** — `resolveWorkspacePath(root, input, { allowMissing })` → `{
     absolute, rel, exists }` exactly as ARCHITECTURE.md 6.13 (input 1–4096 characters without control characters;
     `realpath(root) === root`; lexical containment; walk up through ENOENT / ENOTDIR with `lstat`, a dangling link
     refused; the deepest existing realpath inside the root; a missing tail only with `allowMissing` and an existing
     directory base; `rel` POSIX, `.` for the root) plus the shared write and read helpers it needs (`.git` segment
     refusal, `mkdir -p` with the re-check, `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` + `fstat` regular-file reads, the
     temp-file + rename write keeping the mode). *Accept:* `S/workspace/paths.test.ts`: `..`, absolute inside and
     outside, file links inside and outside, a link inside the missing tail, dangling links, ENOTDIR, a FIFO read does
     not hang, a replaced root, `.git` writes refused, the mode kept after a write.
  4. **C14-T4 `core-workspace` skeleton** — manifest (version 1.0.0, `engines.harness` `^1.2.0`, `permissions:
     ['process']`, no settings); the 7 definitions with the shared input schemas, `workspace` access, timeouts (read
     tools 30 s, `find_files` / `search_files` 60 s, write tools 30 s, `shell` 600 s) and placeholder policies (`safe`
     for read tools, `ask` for `write_file` / `edit_file` / `shell`; W7.2 makes `read_file`, `write_file` and
     `edit_file` policy functions); `execute` stubs that throw `not_implemented`; `shell-tool.ts` with a
     `createShellTool` stub; `shell` is not registered on Windows; `builtin-plugins/index.ts` loads `core-workspace`
     after `core-mcp`. *Accept:* the plugin loads active; `GET /tools` lists 7 tools with `workspace` set; a chat
     without a project offers none of them (once W7.4 filters).
  5. **C14-T5 `mock:workspace` (complete)** — PROVIDERS.md 8: `{ tools: true }`; the step comes from the number of
     workspace tool results after the last user message: `write_file mock-workspace.txt` ("Hello from the mock
     agent.\n"), `edit_file` "mock agent" → "workspace agent", `shell cat mock-workspace.txt` (skipped when `shell` is
     not offered), then the text "Workspace done: <stdout>" ("Workspace done." without the shell); a denied call →
     "The tool call was denied."; no workspace tool offered → "Workspace tools are not available.". *Accept:*
     `S/builtin-plugins/mock/index.test.ts` plans for every step, with and without the shell, denied, no tools.
  6. **C14-T6 Fakes** — `S/testing/**`: a fake `ProjectService` (projects in memory; `openWorkspace` on a
     `realpath(mkdtemp())` folder), `createTestApp({ workspaceRoots, workspaceShell })` options, so W7.1, W7.4 and W7.5
     can test without each other.
  7. **C14-T7 Database and env tests** — `db.test.ts` expects 16 tables and the new column; `upgrade.test.ts` migrates a
     temporary folder holding only `0000` … `0003` with chats, then the real folder, and checks that `0004` is plain
     `CREATE` / `ALTER` / `INDEX` (no rebuild) and that every chat survives with `project_id` null; `env.test.ts` for
     both variables (every refused form of `HF_WORKSPACE_ROOTS`).
- **Tests.** The tasks above; `deps.test.ts`.
- **Verify.** Server commands.

### C16 maintenance and keys skeleton (k5)

- **Mission.** Freeze the cross-cutting pieces of the stabilization track: the maintenance service (complete), the
  rotatable keyring, the keys skeleton and its boot hooks, `EventBus.disconnectAll()`, the files / data types for the
  cleanup and the `denyOpenApprovals` helper.
- **Owned.** `S/main.ts`, `S/main.test.ts`, `S/services/{keys,maintenance}/**`, `S/security/{keyring,types}*`,
  `S/testing/fake-keyring*`, `S/services/events/**`, `S/services/{files,data}/types.ts`, `S/services/data/index.ts`,
  `S/services/chats/{import,approvals}*`, `S/chat/index.ts`.
- **Read-only highlights.** `.tmp/p7-designs/stabilization.md` B1 – B6, C1 – C2; ARCHITECTURE.md 5, 6.9, 6.14, 6.15,
  10.3; `S/security/session.ts`, `S/services/shares/index.ts` (the subkey caches W7.7 changes).
- **Tasks.**
  1. **C16-T1 Maintenance (complete)** — `S/services/maintenance/{types,index}.ts`: `exclusive(kind, op, { blockRuns?
     })` (one operation at a time; another one → `409 conflict` `busy`), `current()`; kinds `import`, `delete-all`,
     `key-rotation`, `file-cleanup`; the data service's import and delete-all move onto it from their private mutex;
     `S/chat/index.ts`: `POST /chat` answers `409 busy` while an operation with `blockRuns` holds it. *Accept:*
     maintenance tests (exclusive, `busy`, release after a throw), a chat route test (409 during a `blockRuns`
     operation), the data tests stay green.
  2. **C16-T2 Rotatable keyring** — `createMasterKeyring` returns one frozen object whose `keyVersion` is a getter and
     whose `subkey()` reads closure state; module-private controls `swapMasterKey(keyring, key, version)`,
     `beginKeyChange(keyring) → end()`, `whenKeyStable(keyring)`; the doc comment on `Keyring.subkey` in
     `security/types.ts` ("the same bytes until a key rotation; cache a subkey only together with `keyVersion`");
     `createFakeKeyring` rebuilt on top, so route tests can rotate. *Accept:* keyring tests (swap changes every subkey
     and the version; `whenKeyStable` waits for `end()`; the frozen `deps.keyring` keeps returning the same object).
  3. **C16-T3 Keys skeleton and boot hooks** — `S/services/keys/types.ts` (`KeyService { status(), rotate(body,
     SensitiveOperationOptions) }`), an index stub (`not_implemented`), `recover.ts` (`recoverKeyState({ env, db,
     logger, redactor })` → `{ keyVersion }`: reads `_keys` (version 1 when absent) and writes `{ version: 1, check,
     rotatedAt: null }` at the first v1.3 boot when the secrets table is empty or one row decrypts; the
     `secret.key.next` table is W7.7's), `server-lock.ts` (stub acquire / release), `cli.ts` (stub). `main.ts`: the
     `rotate-key` dispatch on `argv[2]` before the boot, `recoverKeyState` after the migrations and before
     `createDeps` (the keyring factory takes its `keyVersion`), `acquireServerLock` after the data directory exists,
     the release at shutdown and on a failed boot. *Accept:* `main.test.ts` (a normal boot and shutdown still log
     `listening` / `stopped`; `rotate-key` is dispatched without starting the server).
  4. **C16-T4 Events** — `EventBus.disconnectAll()`: flushes queued events, then closes every stream. *Accept:* an
     event emitted right before `disconnectAll()` still reaches the stream.
  5. **C16-T5 Files and data types** — `FilesService.sweep({ referencedIds, createdBefore, dryRun }) →
     FileSweepResult`, the pin set and the shared / exclusive gate members; `DataService.cleanupPreview()` and
     `cleanup()` (stubs in `data/index.ts`). *Accept:* `pnpm typecheck` green; the stubs answer `not_implemented`.
  6. **C16-T6 `denyOpenApprovals`** — extracted from `S/services/chats/import.ts` into `S/services/chats/approvals.ts`
     (`denyOpenApprovals(parts, reason)`); the import uses it unchanged. *Accept:* the import tests stay green; a unit
     test for the helper (open requests and unprocessed responses denied with the reason, finished calls untouched).
- **Tests.** The tasks above.
- **Verify.** Server commands.

### C15 web skeleton (k4)

- **Mission.** Freeze the web side of Phase 7: every new test id, the Projects settings link and page, the stub
  components with their final props and root test ids, the projects store, the new chats store members, the pure module
  stubs, the prop-only additions and the `useChatSession` interface stubs.
- **Owned.** `W/utils/testids.ts`, `W/components/app-shell/navigation{,.test}.ts`,
  `W/components/app-shell/chat-nav/palette.test.ts`, `W/pages/settings/projects.vue` (stub),
  `W/components/{projects,settings/projects}/**` (stubs), `W/components/chat/parts/tools/**` (stubs),
  `W/components/settings/data/{EncryptionKeySection,RotateKeyDialog,StorageCleanupSection}*` (stubs),
  `W/stores/projects*`, `W/stores/chats*` (the new members only), `W/utils/{line-diff,ansi}*` (stubs), the prop-only
  additions in `W/components/chat/ChatHeader.vue`, `W/components/chat/composer/{ChatComposer,PermissionMenu}.vue`,
  `W/components/chat/parts/ToolApprovalCard.vue`, the `approval` emit type in `W/components/chat/parts/ToolPart.vue` and
  `W/components/chat/ChatMessage.vue`, and the interface stubs in `W/composables/useChatSession.ts`.
- **Read-only highlights.** UI.md 2.12 – 2.14, 5.5, 6, 7.19, 7.20, 9.8, 9.10, 10.4, 11, 11.1, 11.4, 13.8;
  `.tmp/p7-designs/web.md` sections 5 – 6.
- **Tasks.**
  1. **C15-T1 Test ids** — every id of UI.md 13.8 in `utils/testids.ts` (key = the camelCase of the id) under a
     `// Projects, workspace tools and data maintenance (Phase 7)` comment.
  2. **C15-T2 Settings link** — "Projects" (`FoldersIcon` from `@lucide/vue`, verified; `/settings/projects`,
     `testIds.settingsNavProjects`, key `projects`) in `SETTINGS_LINKS` right after Media; `navigation.test.ts` order;
     `palette.test.ts` expects `go-settings-projects`.
  3. **C15-T3 Page stub** — `pages/settings/projects.vue` renders `ProjectsSettings` in the settings frame (`PageHeader`
     "Projects").
  4. **C15-T4 Component stubs** — each stub has the UI.md 10.4 props / emits exactly and renders its root test id;
     `move-chat.ts`, `workspace-tools.ts`, `utils/line-diff.ts`, `utils/ansi.ts` export their UI.md 11.4 signatures
     with inert bodies (`workspaceToolView` returns `null`, so `ToolPart` keeps its generic blocks).
  5. **C15-T5 Stores** — `stores/projects.ts` with the final signature (UI.md 11; inert bodies that type-check);
     `stores/chats.ts` += `projectFilter` (state, default `'all'`) and `setProjectFilter(filter)` (stub: sets the
     state).
  6. **C15-T6 Prop-only additions** — `ChatHeader.projectId?`, `ChatComposer.projectId?`, `PermissionMenu.modes?`,
     `ToolApprovalCard.workspace?` (declared, not used yet); `acceptEdits?: boolean` in the `approval` emit payload of
     `ToolPart` and `ChatMessage`; `useChatSession`: `projectId` (computed `null`), `setProject` (rejects
     `not_implemented`), `ToolApprovalDecision.acceptEdits?`.
- **Tests.** `navigation.test.ts` (Projects after Media), `palette.test.ts`, one stub mount test per new component
  (root test id, props accepted), store shape tests.
- **Verify.** Web commands (`typecheck:fast` needs the coordinator's `.nuxt`; import new components by path).

### Wave P7-0b ownership

The audit cannot express "except": `S/db/schema.ts` matches C14's glob but is the coordinator's K3 edit, and
`S/testing/fake-keyring*` matches both C14 and C16 (a warning; C16 owns it).

```json
{
  "wave": "P7-0b",
  "agents": {
    "K3": [
      "apps/server/src/db/schema.ts",
      "apps/server/drizzle/**"
    ],
    "C14": [
      "apps/server/src/types.ts",
      "apps/server/src/deps*.ts",
      "apps/server/src/env*.ts",
      "apps/server/src/db/**",
      "apps/server/src/services/projects/**",
      "apps/server/src/services/chats/types.ts",
      "apps/server/src/services/images/types.ts",
      "apps/server/src/workspace/paths*",
      "apps/server/src/builtin-plugins/index.ts",
      "apps/server/src/builtin-plugins/core-workspace/**",
      "apps/server/src/builtin-plugins/mock/**",
      "apps/server/src/testing/**"
    ],
    "C16": [
      "apps/server/src/main.ts",
      "apps/server/src/main.test.ts",
      "apps/server/src/services/keys/**",
      "apps/server/src/services/maintenance/**",
      "apps/server/src/security/{keyring,types}*",
      "apps/server/src/testing/fake-keyring*",
      "apps/server/src/services/events/**",
      "apps/server/src/services/files/types.ts",
      "apps/server/src/services/data/types.ts",
      "apps/server/src/services/data/index.ts",
      "apps/server/src/services/chats/{import,approvals}*",
      "apps/server/src/chat/index.ts"
    ],
    "C15": [
      "apps/web/app/utils/testids.ts",
      "apps/web/app/components/app-shell/navigation{,.test}.ts",
      "apps/web/app/components/app-shell/chat-nav/palette.test.ts",
      "apps/web/app/pages/settings/projects.vue",
      "apps/web/app/components/projects/**",
      "apps/web/app/components/settings/projects/**",
      "apps/web/app/components/chat/parts/tools/**",
      "apps/web/app/components/settings/data/{EncryptionKeySection,RotateKeyDialog,StorageCleanupSection}*",
      "apps/web/app/stores/projects*",
      "apps/web/app/stores/chats*",
      "apps/web/app/utils/{line-diff,ansi}*",
      "apps/web/app/components/chat/ChatHeader.vue",
      "apps/web/app/components/chat/ChatMessage.vue",
      "apps/web/app/components/chat/composer/{ChatComposer,PermissionMenu}.vue",
      "apps/web/app/components/chat/parts/{ToolApprovalCard,ToolPart}.vue",
      "apps/web/app/composables/useChatSession.ts"
    ]
  },
  "allow": [
    "docs/ROADMAP.md",
    "docs/DECISIONS.md",
    "AGENT.md"
  ]
}
```

### Wave P7-0b cross-agent contracts

| Producer → consumer | Contract |
|---|---|
| C14 → W7.1, W7.4, W7.5 | `ProjectService` / `OpenWorkspace` (`S/services/projects/types.ts`), the chats type additions, the fake project service |
| C14 → W7.2, W7.3 | `resolveWorkspacePath` and the read / write helpers of `S/workspace/paths.ts` (frozen) |
| C14 → W7.2, W7.3, W7.6 | the `core-workspace` definitions (names, schemas, access, timeouts) |
| C14 → W7.14 | `mock:workspace` (PROVIDERS.md 8) |
| C13 → W7.2, W7.3, W7.11 | the workspace tool input / output schemas, `WORKSPACE_LIMITS`, `workspaceDiffSchema` |
| C16 → W7.7, W7.8 | `MaintenanceService` (`exclusive`, `current`), the rotatable keyring controls, `KeyService` types, `FilesService.sweep` / pins / gate, `DataService.cleanupPreview` / `cleanup` |
| C16 → W7.7 | `denyOpenApprovals`, `EventBus.disconnectAll()`, the `main.ts` hooks (recovery, lock, CLI dispatch) |
| C15 → W7.9 – W7.13 | the stub components, stores, pure modules and prop additions with frozen signatures (UI.md 10.4, 11, 11.4) |
| C15 → everyone | `utils/testids.ts` (frozen after the gate) |

### Gate P7-0b

1. `node scripts/audit-ownership.mjs .tmp/waves/P7-0b.json`
2. `nuxi prepare` → `pnpm check` → `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
3. `rm -rf .tmp/e2e` (a cached mock listing hides the new `mock:workspace` seed) → `pnpm start:e2e` → `pnpm test:e2e`
   (61 + math still green).
4. **Upgrade probe** on the copy made in K3 (never on `.tmp/e2e`):
   ```sh
   HF_MOCK_PROVIDER=1 HF_OFFLINE=1 HF_PORT=8898 HF_DATA_DIR=.tmp/upgrade-v12 node apps/server/dist/main.mjs &
   sqlite3 .tmp/upgrade-v12/harness.db "SELECT count(*) FROM __drizzle_migrations;
     SELECT count(*) FROM chats WHERE project_id IS NOT NULL;
     SELECT value FROM settings WHERE key = '_keys';"
   # 5 migrations; 0 chats with a project; {"version":1,"check":"…","rotatedAt":null}
   ```
   Then, logged in with the seeded password (`curl -c .tmp/gates/P7-0b/jar …/auth/login`): every seeded chat opens
   (`GET /chats/<id>`), the provider shows its stored key (`GET /providers`: status `connected` or a hint), the plugin
   secret is still set, the share link opens (`GET /share/<token>` 200). Stop the probe server afterwards. (Without the
   `sqlite3` CLI, run the queries through `node` + `@libsql/client`.)
5. FREEZE additions (see "FREEZE in Phase 7") → ROADMAP + wave log → commit
   `feat: add phase 7 schema, migration and skeletons`.

---

## Wave P7-A — features

Thirteen agents in one launch against the P7-0b checkpoint. Only server agents get slots (k1 – k8); web agents run no
server.

### Coordinator actions

- Before the launch: the ownership file `.tmp/waves/P7-A.json` (below), agent prompts with a "what exists now"
  section, the relevant plan and design sections, and the rules of this file.
- **At the gate**: audit; batch the CCRs; `nuxi prepare`; the gate commands and probes below; the screenshot review;
  `pnpm audit`; red items become W7.16 (server) / W7.17 (web) tasks with their globs. First cuts if the wave overflows:
  the CLI `--force`, the palette entries, the Settings → Projects instructions dialog.

### Wave rules

- Import new components explicitly by path; no `nuxt prepare` mid-wave.
- A new test id, a contract change or a frozen-file edit is a CCR in the report (with a local adapter).
- No doc edits ("For W7.15" notes in the report instead).
- Hot files have exactly one owner (table below): `S/chat/**` → W7.4; `S/services/chats/**` → W7.5;
  `useChatSession`, `useServerEvents` and the top-level chat components → W7.10; `chat/parts/**` and the share
  rendering files → W7.11; `chat/composer/**` → W7.12; `ChatNav`, `CommandPalette`, the projects and chats stores →
  W7.9; `settings/data/**` → W7.13.
- Server agents test against the C14 / C16 fakes for members other agents implement (the project service for W7.4 and
  W7.5, the maintenance service for W7.7 and W7.8); the real round trips are probed at the gate.

### W7.1 projects-server (k1)

- **Mission.** The project service and the `projects` routes.
- **Owned.** `S/services/projects/**` (not `types.ts`), `S/http/routes/projects{,.test}.ts`.
- **Read-only highlights.** `.tmp/p7-designs/server.md` sections 1 – 2; ARCHITECTURE.md 6.13, 10.9; API.md `projects.ts`
  and the projects schemas; `S/services/projects/types.ts`, `S/workspace/paths.ts`; `S/plugins/scaffold/paths.ts`.
- **Tasks.**
  1. **W7.1-T1 Roots** — `start()`: realpath every root; a missing explicit root, a root equal to the data dir or one
     inside it outside `<dataDir>/workspaces` → `EnvError` (exit 1 with the reason); the default root is created
     with mode 0700; a root that **contains** the data dir is allowed; `roots()` returns the checked list. *Accept:*
     `roots.test.ts` for each case (temp data dirs).
  2. **W7.1-T2 Create** — `create({ name, path, newFolder? })`: realpath (404 when missing), a directory inside a root
     (else 400 on `['path']`); with `newFolder`: `mkdir` without `recursive` (EEXIST → 409 `exists`), realpath again;
     a folder that equals, contains or sits inside the data dir → 400 "This folder contains the harness-forge data
     directory." (the default root's subtree excepted); more than `LIMITS.projectsMax` → 400; insert (a duplicate path
     → 409 `exists`, and a folder created by this call is removed again); `project.changed`. *Accept:* route tests:
     403 without fresh auth (password set), 201 with; `newFolder` creates the folder on disk; duplicate 409 and the new
     folder gone; outside the roots 400; inside the data dir 400; missing 404.
  3. **W7.1-T3 Update and remove** — `update(id, { name?, instructions? })` (the path never changes) →
     `project.changed`; `remove(id)`: 409 `run-active` while a chat of the project runs; one transaction sets
     `chats.project_id = NULL` and deletes the row; the folder is never touched; one `project.changed` with `project:
     null`. *Accept:* chats detached, folder and its files still there, one event, 409 during a run.
  4. **W7.1-T4 Browse** — `browse(path?)`: without `path` the roots (`path: null`, `parent: null`, `entries: []`);
     with a path: inside a root (else 400; `/etc` → 400), directories only (`Dirent.isDirectory()`, links not listed),
     dot folders, `node_modules` and the data dir hidden, sorted, at most 500 (`truncated`), each entry's `projectId`
     when a project uses it; `parent` null at a root. *Accept:* containment, hiding, the cap, `projectId`.
  5. **W7.1-T5 `openWorkspace` and the project file** — the stored path still equals its realpath, is a directory, is
     inside a current root and does not overlap the data dir, else `{ ok: false, name, message }` ("The project folder
     … is not available: …"); the project file: `AGENTS.md`, else `CLAUDE.md`, from the root only, through the
     resolver; a line made only of `@relative.md` is expanded one level inside the root; 32 KiB in total
     (`LIMITS.projectFileBytes`), then a truncation marker; read on every run. *Accept:* `project-file.test.ts`
     (precedence, `@` expansion, a link out of the root ignored, truncation); `openWorkspace` for a deleted, moved and
     replaced folder.
  6. **W7.1-T6 Summaries** — `chatCount` (one grouped query), `available` / `issue`, `instructionsFile`; `list()`
     sorted by name. *Accept:* `index.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Server commands.

### W7.2 workspace-files (k2)

- **Mission.** The six file tools of `core-workspace`, the walker, the search Worker, diffs and the sensitive-path
  rules.
- **Owned.** `S/workspace/**` (not `paths*`, not `shell*`), `S/builtin-plugins/core-workspace/**` (not `shell-tool*`).
- **Read-only highlights.** `.tmp/p7-designs/server.md` section 3; ARCHITECTURE.md 6.13, 10.9; PLUGINS.md 1
  (`core-workspace`); `packages/shared/src/schemas/workspace.ts`; `node_modules/diff`, `ignore`, `picomatch` types.
- **Tasks.**
  1. **W7.2-T1 Sensitive paths** — `S/workspace/sensitive.ts`: secret-looking (`.env`, `.env.*` except
     `.env.example` / `.env.sample` / `.env.template`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.pypirc`,
     `.netrc`, `*.p12`, `*.pfx`, `credentials*.json`, `secrets.*`) and hidden (any segment starting with `.`).
     *Accept:* `sensitive.test.ts` table.
  2. **W7.2-T2 `read_file`, `list_directory`** — text only (`looksLikeText` on the first 8 KiB), lines cut at 2000
     characters, at most 48 KiB per call, `offset` (1-based) / `limit` (≤ 2000); the model text is `cat -n` lines plus
     "[truncated; continue with offset=N]"; `list_directory` at most 1000 entries (`dir/` suffix in the model text).
     *Accept:* `read-file.test.ts` (offset / limit, a binary file refused, a FIFO refused, the model text),
     `list-directory.test.ts`.
  3. **W7.2-T3 Walker and `find_files`** — an async walker: `.git` always skipped; `node_modules` and gitignored paths
     (nested `.gitignore`, one `ignore` instance per folder) skipped unless `include_ignored`; folder links not
     entered; file links kept only when their realpath is inside the root; caps 100k entries, depth 64, 10 s, the abort
     signal; `picomatch` (dot files included; a pattern without `/` matches the file name at any depth). *Accept:*
     `walk.test.ts`, `find-files.test.ts`.
  4. **W7.2-T4 `search_files`** — the regex syntax checked on the main thread, the matching in an eval Worker
     (`resourceLimits` 256 MB, terminated after 20 s with "The search timed out — use a simpler pattern or a narrower
     path"); `literal`, `case_sensitive` (default true), `glob`, `max_results` (≤ 500, default 100); files over 1 MiB
     and secret-looking files skipped even with `include_ignored`. *Accept:* `search-files.test.ts` with an injected
     short timeout: `(a+)+$` on a long line times out while the event loop stays responsive.
  5. **W7.2-T5 `write_file`, `edit_file`** — through the resolver's write helper (`.git` refused, `mkdir -p`, temp file
     + rename keeping the mode); `write_file` ≤ 256 KiB → `{ path, created, bytes, lines, diff }`; `edit_file`: a unique
     match unless `replace_all`, "not found" asks the model to read the file again and match whitespace exactly,
     "occurs N times" asks for more context or `replace_all`, `old_string === new_string` is an error, files ≤ 1 MiB,
     CRLF-throughout files matched on LF text and written back as CRLF, a BOM kept → `{ path, replacements, diff }`;
     diffs from `structuredPatch(…, { context: 3, timeout: 2000 })` (`diff: null` on timeout). *Accept:*
     `write-file.test.ts`, `edit-file.test.ts` (CRLF, BOM, `replace_all`, ambiguous, mode kept, `.git` refused).
  6. **W7.2-T6 Policies, trimming, model text** — policy functions: `read_file` → `ask` for secret-looking paths, else
     `safe`; `write_file` / `edit_file` → `always` for hidden or secret paths, else `ask`; outputs trimmed to ~60 KiB of
     JSON (a diff ~24 KiB with lines cut at 500 characters, `truncated: true`); `toModelOutput` built only from the
     stored output ("Created x (N lines).", "Updated x (+a -r lines).", "Edited x: N replacement(s) (+a -r lines).").
     *Accept:* policy tables; a diff past the cap is truncated; the texts.
- **Tests.** One test file per tool plus the helpers above.
- **Verify.** Server commands.

### W7.3 workspace-shell (k3)

- **Mission.** The shell runner and the `shell` tool.
- **Owned.** `S/workspace/shell*`, `S/builtin-plugins/core-workspace/shell-tool*`.
- **Read-only highlights.** `.tmp/p7-designs/server.md` section 3 (shell runner); ARCHITECTURE.md 6.13, 10.9, 12;
  `S/mcp/stdio-transport.ts` (env allowlist and kill pattern to compare); `S/workspace/paths.ts`.
- **Tasks.**
  1. **W7.3-T1 Runner** — `spawn(sh, ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
     shell: false })`, `sh` = `/bin/bash` when executable, else `/bin/sh`; the environment allowlist `HOME LOGNAME USER
     PATH LANG LC_ALL LC_CTYPE TZ TMPDIR` plus `SHELL=<sh>`, `TERM=dumb`, `NO_COLOR=1`, `PAGER=cat`, `GIT_PAGER=cat`,
     `GIT_TERMINAL_PROMPT=0` (never `HF_*`, provider keys, `NODE_ENV`); the kill = `process.kill(-pid, 'SIGTERM')`, then
     `SIGKILL` after 2 s, repeated until ESRCH; it fires on the timeout (a normal result with `timedOut: true`), on the
     abort signal (AbortError), when the shell exits with its pipes still open after 500 ms (background processes), and
     from a process-exit handler for every live group; output per stream = the first 4 KiB + the last 16 KiB with "[…
     N bytes omitted …]", ANSI stripped, `\r\n` → `\n`, a `\r` progress line keeps its last segment; one info log line
     (exit code, duration, byte counts), the command only at `debug`, redacted. *Accept:* `shell.test.ts` (POSIX `sh`):
     exit 0 and 3, stderr kept; `sleep 5` with a 300 ms timeout → `timedOut`; an abort kills `sleep 30` (`process.kill(pid,
     0)` then throws ESRCH); `sleep 30 & echo $!` returns quickly and that pid is dead; the caps; the environment lacks an
     injected `HF_PASSWORD` / `OPENAI_API_KEY`; ANSI and `\r`.
  2. **W7.3-T2 Tool** — `createShellTool`: input `{ command ≤ 16 KiB, cwd?, timeout_ms? 1000–590000 (120000),
     description? ≤ 200 }`, `cwd` project-relative through the resolver (default the root), tool `timeoutMs` 600,000,
     output `{ command, cwd, exitCode, signal, timedOut, durationMs, stdout, stderr, stdoutBytes, stderrBytes }`, model
     text "Exit code: N" or "Stopped after 120 s (timeout)", then stdout and stderr; the description says each call is a
     new process (no `cd` persistence, no stdin, background processes are stopped); not registered on Windows. *Accept:*
     `shell-tool.test.ts` (`cwd` inside and outside the project, defaults, the model text).
- **Tests.** The tasks above.
- **Verify.** Server commands.

### W7.4 chat-pipeline (k4)

- **Mission.** Projects and workspaces in the chat pipeline.
- **Owned.** `S/chat/**` (not `types.ts`), `S/http/routes/chat{,.test}.ts`.
- **Read-only highlights.** `.tmp/p7-designs/server.md` sections 4 – 6; ARCHITECTURE.md 6.1, 6.2, 6.13; API.md
  `chat.ts`, the chat request `projectId`, the notice codes; `S/services/projects/types.ts`, the fakes.
- **Tasks.**
  1. **W7.4-T1 Project on creation** — the chat request's `projectId` is honored only when the request creates the
     chat (`chats.ensure({ …, projectId })`); an unknown project → 404 before the chat row exists; ignored for an
     existing chat. *Accept:* prepare and route tests (no chat row after the 404).
  2. **W7.4-T2 Workspace and notice** — every chat-model run of a chat with a project calls `openWorkspace`;
     `PreparedRun.workspace: OpenWorkspace | null`; a folder that cannot be opened → the run continues without
     workspace tools and with the notice `workspace-unavailable` (level warning, the service's message). *Accept:*
     a removed folder gives the notice and no workspace tool.
  3. **W7.4-T3 Tools** — `assembleTools` drops tools that declare `definition.workspace` when there is no workspace and
     `execute` tools when `!env.workspaceShell`; `wrapToolExecute` adds the frozen `{ projectId, name, root }` to the
     call context (`ToolCallContext.workspace`) for every tool of such a run; `evaluatePolicy` receives it. *Accept:*
     `tools.test.ts` (no project, a project, the shell switched off).
  4. **W7.4-T4 Approvals** — `ApprovalInput.workspace`; `case 'edits'`: `safe` and (`ask` + workspace `write`) run,
     everything else asks (including `always`); overrides and the `tool.approve` hook keep precedence. *Accept:*
     `approval.test.ts` for all four modes × policies × access.
  5. **W7.4-T5 Instructions** — in `buildRunParams`, before the `chat.params` hook: global → the workspace block
     (project name, folder, OS, the rules built from the offered tools) → the project file → the project instructions
     → the chat instructions. *Accept:* `params.test.ts` order, the block without tools.
  6. **W7.4-T6 Steps** — chats with a project use `projectMaxSteps`; the `chat.params` clamp moves from 100 to 200.
     *Accept:* `params.test.ts`; a pipeline test with `mock:workspace` on a temp project in `edits` mode: write and
     edit run, the shell asks.
- **Tests.** The tasks above; `pipeline.test.ts` stays green.
- **Verify.** Server commands.

### W7.5 chats-server (k5)

- **Mission.** `projectId` in the chat service and routes.
- **Owned.** `S/services/chats/**` (not `types.ts`, not `approvals*`), `S/http/routes/chats{,.test}.ts`,
  `S/testing/fake-chats*`.
- **Read-only highlights.** `.tmp/p7-designs/server.md` sections 1 and 4; ARCHITECTURE.md 6.9, 8; API.md `chats.ts`;
  `S/services/chats/types.ts`, `apps/server/drizzle/0004_*.sql`.
- **Tasks.**
  1. **W7.5-T1 Records and events** — `projectId` in records, summaries, `chat.created` / `chat.updated` and search
     results. *Accept:* event tests.
  2. **W7.5-T2 Filter** — `GET /chats?projectId=<id>` and `projectId=none` (the cursor pagination keeps working; the
     `chats_project_idx` index is used). *Accept:* list tests with both filters.
  3. **W7.5-T3 Ensure and move** — `ensure` applies `projectId` only on creation; `PATCH /chats/:id { projectId }`
     moves (`UPDATE … WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?)`; a missing project → 404; `null` = out of the
     project; 409 `run-active` while the chat runs); `chat.updated`. *Accept:* route tests 200 / 404 / 409.
  4. **W7.5-T4 Exports and imports** — `export.ts` strips `projectId` (it spreads the summary); imports never set it;
     the v1 and v2 fixtures of v1.2 still import. *Accept:* export tests (no `projectId`), import tests.
- **Tests.** The tasks above.
- **Verify.** Server commands.

### W7.6 tools-media-api (k6)

- **Mission.** `ToolDefinition.workspace` in the registry and the tools list, `modelName`, and the unknown-provider
  400 on the media paths.
- **Owned.** `S/registry/validate*`, `S/mcp/tools*`, `S/services/{images,audio}/**` (not `types.ts`),
  `S/providers/**` (not `types.ts`), `S/plugins/{context,host}*`, `S/builtin-plugins/core-tools/**`, `S/live/**`.
- **Read-only highlights.** `.tmp/p7-designs/stabilization.md` D; PLUGINS.md 9; API.md 2.2, `audio.ts`, the images
  schemas; ARCHITECTURE.md 6.11.
- **Tasks.**
  1. **W7.6-T1 Validation** — `ToolDefinition.workspace` must be `read`, `write` or `execute` when present
     (`validation_error` naming the tool). *Accept:* `validate.test.ts`.
  2. **W7.6-T2 Tools list** — `ToolSummary.workspace` = the definition's access (null for MCP tools and tools without
     one). *Accept:* `GET /tools` lists the 7 `core-workspace` tools with their access.
  3. **W7.6-T3 `modelName`** — `ImageGenerationResult.modelName` (the catalog name, else the model id) →
     `ImageGenerateResult.modelName` (`toImageGenerateResult`) → the `generate_image` output `modelName` → the model text
     `generatedImagesText(count, out.modelName ?? out.modelRef)`; `core-tools` 1.2.0 with `engines: ^1.2.0`. *Accept:*
     `generate-image.test.ts` (both texts: with `modelName` and an old output without it); `templates.test.ts` green.
  4. **W7.6-T4 Unknown provider** — `resolveBase` throws `notConfigured(providerId, 'The provider "<id>" is not
     available. Pick another model or install the provider.')` → `400 provider_not_configured` with action
     `configure-provider` for transcription, speech, `ctx.images`, `generate_image` and `ctx.ai` / `ctx.models.resolve`.
     *Accept:* `audio/index.test.ts` (both routes 400), the resolver table in `providers/index.test.ts`,
     `providers/testing.ts`, a `ctx.images` test.
- **Tests.** The tasks above.
- **Verify.** Server commands (never the live suite).

### W7.7 key-rotation (k7)

- **Mission.** Boot recovery, the server lock, online rotation, the CLI and every key cache.
- **Owned.** `S/services/keys/**` (not `types.ts`), `S/security/{keyring,session}*` (not `types.ts`),
  `S/services/secrets/**`, `S/services/shares/{index,token}*`, `S/http/routes/{keys,auth}{,.test}.ts`,
  `S/http/middleware/session-auth*`.
- **Read-only highlights.** `.tmp/p7-designs/stabilization.md` B; ARCHITECTURE.md 5, 6.14, 10.1, 10.3; API.md
  `keys.ts`, the keys schemas; `S/services/{keys,maintenance}/types.ts`, `S/services/chats/approvals.ts`.
- **Tasks.**
  1. **W7.7-T1 Recovery** — `recoverKeyState` (file mode): no `.next` → nothing; check(`.next`) = the stored check →
     rename over `secret.key` + fsync the folder; check(`secret.key`) = the stored check → delete `.next` and warn;
     neither → exit 1 with a clear message; env mode: a mismatch warns and `GET /keys` says `mismatch`. *Accept:*
     `recover.test.ts` with crash injection after each step (`.next` written, the transaction failed, the commit done
     but not the rename, the rename done).
  2. **W7.7-T2 Server lock** — `server.lock` (`{ pid, hostname, port, startedAt }`) written after the data directory
     exists, removed at shutdown and on a failed boot. *Accept:* `server-lock.test.ts`.
  3. **W7.7-T3 Caches** — `session.ts` and the shares token cache keep `{ version, value }` and derive again when
     `keyring.keyVersion` changes; `SecretStore.get` / `set` / `delete` await `whenKeyStable()`; the session middleware
     drops a rolling token signed under an older version. *Accept:* a secret write during a rotation waits and uses
     the new key; an old cookie is 401 after a swap; an old share token 404, the new one 200.
  4. **W7.7-T4 Online rotation** — `KeyService.rotate` (file mode; ARCHITECTURE.md 6.14 steps): fresh auth checked again,
     `confirm`, 409 `env-key` / `key-mismatch`, `maintenance.exclusive('key-rotation', …, { blockRuns: true })` (409
     `busy`), stop runs, `beginKeyChange`, write `secret.key.next` (0600, exclusive, fsync file and folder), one
     transaction (`rotateSecretsTx`: every readable row to V+1, unreadable rows skipped and counted; open approvals
     denied "Expired after a key rotation."; `pending_approval` cleared; `_keys`), rename, swap, `redactor.addSecret`,
     `key.rotated`, `disconnectAll()`; the route issues one new cookie keeping `authAt`; `GET /keys` status. *Accept:*
     `keys.test.ts` route tests: 403 without fresh auth, 409 `env-key` / `busy`, exactly one valid `Set-Cookie`, the old
     cookie 401, the old share token 404 and the new 200, approvals denied and flags cleared, the event emitted and the
     streams closed, no key text in the logs.
  5. **W7.7-T5 CLI** — `rotate-key [--force]`: loads `.env` and the environment like the server, migrates; env mode
     needs `HF_NEW_MASTER_KEY` (validated, different from the old key; never generated or printed); file mode generates
     and runs the same write-ahead flow; refuses with exit 2 when `/api/health` answers within 1 s (`0.0.0.0` probed as
     `127.0.0.1`) or the lock names a live pid on this host; a lock from another host needs `--force`; the summary goes
     to stderr; exit codes 0 / 1 / 2. *Accept:* `cli.test.ts` (refuses while running, lock rules, env round trip:
     restart with the new key `keyCheck: ok`, with the old `mismatch`).
  6. **W7.7-T6 Password change** — `PUT /auth/password` calls `events.disconnectAll()` too. *Accept:* `auth.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Server commands.

### W7.8 file-cleanup (k8)

- **Mission.** The orphaned file cleanup.
- **Owned.** `S/services/{files,data}/**` (not `types.ts`), `S/http/routes/data{,.test}.ts`.
- **Read-only highlights.** `.tmp/p7-designs/stabilization.md` C; ARCHITECTURE.md 6.9, 6.15, 8; API.md `data.ts`
  cleanup, the cleanup schemas; `S/services/{files,data,maintenance}/types.ts`.
- **Tasks.**
  1. **W7.8-T1 References** — `S/services/data/references.ts`: keyset batches of 500 rows, a pre-filter
     `instr(col, 'file_') > 0`, then the loose regex `/file_[\dA-Za-z]{16}/g` over `messages.parts` and `metadata`,
     `chat_shares.snapshot` and `file_ids`, `plugin_kv.value`, `plugin_settings.values`, `settings.value`,
     `chats.settings` and every JSON or text column of `projects`. *Accept:* `references.test.ts` per source, and a
     **schema-coverage test** that fails when a JSON or text column is neither scanned nor explicitly excluded
     (`secrets`, `usage`, `model_cache`, …).
  2. **W7.8-T2 Pins and gate** — the files service pins every id `upload`, `importFile` and `saveGenerated` returned
     within the grace period (in memory); those calls hold the gate shared around their blob write + insert; the sweep
     holds it exclusive. *Accept:* a pinned reuse during a sweep is kept.
  3. **W7.8-T3 Sweep** — candidates older than 24 h, unreferenced and unpinned; `DELETE … WHERE id IN (…) AND id NOT IN
     (referencedFileIdsQuery())`; a blob unlinked only when no row keeps its sha256; rowless 64-hex blobs past the cutoff
     and `.tmp` files older than 1 h removed (`lstat`, regular files only; unknown names stay); `dryRun` deletes
     nothing. *Accept:* `sweep.test.ts` (a message committed after the scan keeps its file, a shared blob kept, the
     rowless and temp rules).
  4. **W7.8-T4 Service and routes** — `cleanupPreview()` / `cleanup()` under `maintenance.exclusive('file-cleanup')`
     (no run blocking), `_files.lastCleanup`, the counts logged; `GET /data/cleanup` and `POST /data/cleanup` (not
     fresh; 409 `busy`); `GET /data` stays cheap. *Accept:* `data.test.ts` (preview, cleanup, 409 during an import).
- **Tests.** The tasks above.
- **Verify.** Server commands.

### W7.9 projects-web

- **Mission.** The projects store, the chat filter, the switcher, the pickers, the Add dialog with the folder browser,
  Settings → Projects, the move submenu and the palette entries.
- **Owned.** `W/stores/{projects,chats}*`, `W/components/projects/**`, `W/components/settings/projects/**`,
  `W/pages/settings/projects.vue`, `W/components/app-shell/{ChatNav,CommandPalette}*`, `W/components/app-shell/chat-nav/**`.
- **Read-only highlights.** UI.md 2.12, 2.13, 5.3, 7.20, 8.4, 9.10, 10.4, 11, 11.4, 13.8, 14, 15;
  `.tmp/p7-designs/web.md` sections 1 – 2, 5, 7; `W/composables/useFreshAuth.ts`.
- **Tasks.**
  1. **W7.9-T1 Projects store** — `fetchAll`, `create` (the caller wraps it in `freshAuth.run`), `update` (optimistic,
     rolled back on error), `remove`, `browse(path, { signal })`, `applyEvent` (`project.changed`), `byId`, `sorted`.
     *Accept:* `projects.test.ts` (CRUD, rollback, events).
  2. **W7.9-T2 Chats store filter** — `projectFilter` in `localStorage['hf-project-filter']` (an id unknown once the
     projects loaded falls back to `all`); `setProjectFilter` resets the list and fetches page one with `projectId`;
     `upsertSummary` inserts rows that match and removes rows that no longer do; `update` patches `projectId`
     optimistically; `project.changed` with `project: null` clears `projectId` on loaded rows and resets a filter on it
     to `all` with a toast; `search` ignores the filter. *Accept:* `chats.test.ts`.
  3. **W7.9-T3 Switcher and menus** — `ProjectSwitcher` (UI.md 7.20; icon mode, mobile), `ProjectMenuItems`, the row
     menu "Move to project ▸" in `ChatNav`; `useMoveChat` (optimistic PATCH, toast "Moved to {name}" with Undo, the 409
     toast). *Accept:* component tests.
  4. **W7.9-T4 Pickers** — `NewChatProjectPicker` (default and filter-follows-pick rules) and `ChatProjectChip`
     (W7.10 mounts both). *Accept:* component tests.
  5. **W7.9-T5 Add dialog** — `AddProjectDialog` + `FolderBrowser` (UI.md 9.10): breadcrumb, Up, entries, "Project"
     badges, roots, New folder (name rules), the default name, `useFreshAuth().run(…, { required: true })`, the inline
     errors by code, the no-roots alert. *Accept:* tests for fresh auth, every error code and the folder-name rules.
  6. **W7.9-T6 Settings → Projects** — `ProjectsSettings`: rows, "Folder not found", rename, `ProjectInstructionsDialog`,
     delete confirm, empty state, `?add=1`. *Accept:* `ProjectsSettings.test.ts`.
  7. **W7.9-T7 Palette** — the "Projects" section while searching (show all / without a project / a project, Add
     project…, move the open chat). *Accept:* `palette.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W7.10 chat-surface-web

- **Mission.** The project of a chat in the session, the request and the header, the accept-edits decision and the
  new server events.
- **Owned.** `W/composables/{useChatSession,useServerEvents}*`, `W/components/chat/{ChatView,ChatHeader,ChatMessage,
  ChatTranscript,NewChatHeader,ChatGreeting,chat-format,chat-context,nuxt-imports}*`, `W/pages/{index,chat/[id]}.vue`,
  `W/utils/testing/fixtures.ts`.
- **Read-only highlights.** UI.md 5.6, 7.3, 7.4, 7.20, 10.4, 11, 11.1, 13.8; `.tmp/p7-designs/web.md` sections 1, 3
  (approval cards), 5; the stubs `ChatProjectChip`, `NewChatProjectPicker`, `useMoveChat` (W7.9's).
- **Tasks.**
  1. **W7.10-T1 Session project** — `projectId`: for a new chat the user's pick, else the filter when it names a known
     project; for a saved chat `chats.byId(id)?.projectId ?? summary.projectId`; `setProject` (a new chat: local; a
     persisted chat: PATCH, throws `HarnessError` on 409); `buildChatRequestBody` sends `projectId` only while the chat
     is not persisted and the request kind is `new`. *Accept:* `useChatSession.test.ts` (default, first-request body,
     `setProject` for new and saved chats).
  2. **W7.10-T2 Accept edits decision** — `approve({ …, acceptEdits: true })` sets `toolMode = 'edits'` before it sends
     the approval, so the continuation already runs in edits mode. *Accept:* session test (mode switched before the
     request).
  3. **W7.10-T3 Header and new chat** — `ChatHeader` mounts `ChatProjectChip` and "Move to project ▸" in its menu;
     `pages/index.vue` mounts `NewChatProjectPicker` under `ChatGreeting`; `ChatView` passes `projectId` to the
     composer. *Accept:* `ChatHeader` and `ChatView` tests.
  4. **W7.10-T4 Events** — `project.changed` → `projects.applyEvent` + `chats.applyEvent`; `key.rotated` → reload the
     chats store, refresh the open session when its chat is in `chatIds`, toast "The encryption key was rotated.";
     `refetchLoadedStores()` also calls `projects.fetchAll()` when that store is loaded. *Accept:*
     `useServerEvents.test.ts`.
  5. **W7.10-T5 Busy chat request** — a chat request answered `409 busy` → toast "The server is rotating its encryption
     key. Try again in a moment." and the unstored message goes back into the composer (like `run-active`). *Accept:*
     `ChatView` test.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W7.11 tool-ui-web

- **Mission.** The workspace tool registry and renderers, row summaries, approval previews and share parity.
- **Owned.** `W/components/chat/parts/**`, `W/components/share/{SharedMessage,ShareToolRow,share-view}*`,
  `W/utils/{line-diff,ansi}*`.
- **Read-only highlights.** UI.md 2.14, 7.2, 7.3, 7.19, 10.4, 11.4, 13.8, 14; `.tmp/p7-designs/web.md` section 3;
  `packages/shared/src/schemas/workspace.ts`.
- **Tasks.**
  1. **W7.11-T1 Registry** — `workspace-tools.ts`: `workspaceToolView`, `workspaceApprovalView`, `workspaceRowArgument`,
     `workspaceRowSummary`, `workspaceToolIcon`; outputs parsed with the shared schemas, `null` on failure (a plugin tool
     with the same name, a share value cut to a `[truncated]` string). *Accept:* `workspace-tools.test.ts` (parse
     guards incl. the string fallback, row arguments, row summaries).
  2. **W7.11-T2 Renderers** — `DiffView`, `TerminalOutput`, `FileContent`, `FileList`, `WorkspaceToolBody` (+ "Raw input
     and output"). *Accept:* component tests (folding, Show N more, truncated notes, the tail and Show all, ANSI,
     timeout, signal).
  3. **W7.11-T3 Rows** — `ToolPart` uses the registry (icon, argument, summary, body) and falls back to the generic
     blocks. *Accept:* `ToolPart.test.ts`.
  4. **W7.11-T4 Approval previews** — `ToolApprovalPreview` (edit → `diffLines(old_string, new_string)`, write → the
     content preview, shell → the command block + warning); `ToolApprovalCard`: no "Always allow" for `workspace:
     'execute'`, "Accept all edits in this chat" for `write` tools (emits `acceptEdits`). *Accept:* card tests (shell
     hides Always allow, the accept-edits decision).
  5. **W7.11-T5 Utilities** — `utils/line-diff.ts` (`diffLines`, LCS, the size cap) and `utils/ansi.ts`
     (`stripAnsi`, `\r` collapse). *Accept:* `line-diff.test.ts` (identical, pure add / delete, replace, folding, the
     cap, CRLF, trailing newline), `ansi.test.ts`.
  6. **W7.11-T6 Share parity** — `ShareToolRow` and `SharedMessage` render workspace tools through the same registry
     when tool details are shared. *Accept:* share tests.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W7.12 composer-web

- **Mission.** The Accept edits mode in the composer and `/mode`, and the step settings.
- **Owned.** `W/components/chat/composer/**`, `W/components/settings/{GeneralSettings,general}*`.
- **Read-only highlights.** UI.md 7.8, 7.11, 9.4, 13.8, 15; `.tmp/p7-designs/web.md` section 4.
- **Tasks.**
  1. **W7.12-T1 Permission menu** — `TOOL_MODE_OPTIONS`: Ask · Accept edits (`FilePenLine`) · Auto · Off;
     `PermissionMenu.modes`; `ChatComposer` shows `edits` only for a project chat (`projectId`) or when it is already
     selected. *Accept:* `PermissionMenu.test.ts`, `ChatComposer.test.ts`.
  2. **W7.12-T2 `/mode edits`** — plus the aliases `accept-edits` and "accept edits"; outside a project chat the
     error "Accept edits works in project chats." *Accept:* `slash-commands.test.ts`.
  3. **W7.12-T3 Settings → General** — "Max steps per response" 1–200, "Max steps in project chats"
     (`settings-project-max-steps`, 1–200, `projectMaxSteps`); the default permission mode select maps
     `TOOL_MODE_OPTIONS`. *Accept:* `GeneralSettings.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W7.13 data-settings-web

- **Mission.** The Encryption key and Storage cleanup sections of Settings → Data.
- **Owned.** `W/components/settings/data/**`.
- **Read-only highlights.** UI.md 9.8, 8.4, 13.8, 15; API.md `keys.ts`, `data.ts` cleanup.
- **Tasks.**
  1. **W7.13-T1 Encryption key** — `EncryptionKeySection` + `RotateKeyDialog` (UI.md 9.8): status, mismatch alert, env
     mode (button disabled, the CLI command shown), the dialog's effects list, typed `ROTATE`,
     `useFreshAuth().run(…, { required: true })`, the toast, the summary and shares reload. *Accept:*
     `EncryptionKeySection.test.ts`, `RotateKeyDialog.test.ts`.
  2. **W7.13-T2 Storage cleanup** — `StorageCleanupSection`: check, summary, Remove… confirm, toast, `busy`. *Accept:*
     `StorageCleanupSection.test.ts`.
  3. **W7.13-T3 Page** — `DataSettings` order (summary, Export, Import, Storage cleanup, Shared links, Encryption key,
     Danger zone); the busy text. *Accept:* `DataSettings.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### Wave P7-A ownership

These globs are the plan's table (brace globs are supported by `scripts/audit-ownership.mjs`) plus the additions listed
in "Deviations". The audit cannot express "except": every `types.ts` of `S`, `S/workspace/paths*`,
`S/services/chats/approvals*` and the `main.ts` hooks stay frozen despite the globs; `S/workspace/shell*` and
`S/builtin-plugins/core-workspace/shell-tool*` match W7.2's globs too (a warning; W7.3 owns them).

```json
{
  "wave": "P7-A",
  "agents": {
    "W7.1": [
      "apps/server/src/services/projects/**",
      "apps/server/src/http/routes/projects{,.test}.ts"
    ],
    "W7.2": [
      "apps/server/src/workspace/**",
      "apps/server/src/builtin-plugins/core-workspace/**"
    ],
    "W7.3": [
      "apps/server/src/workspace/shell*",
      "apps/server/src/builtin-plugins/core-workspace/shell-tool*"
    ],
    "W7.4": [
      "apps/server/src/chat/**",
      "apps/server/src/http/routes/chat{,.test}.ts"
    ],
    "W7.5": [
      "apps/server/src/services/chats/**",
      "apps/server/src/http/routes/chats{,.test}.ts",
      "apps/server/src/testing/fake-chats*"
    ],
    "W7.6": [
      "apps/server/src/registry/validate*",
      "apps/server/src/mcp/tools*",
      "apps/server/src/services/images/**",
      "apps/server/src/services/audio/**",
      "apps/server/src/providers/**",
      "apps/server/src/plugins/{context,host}*",
      "apps/server/src/builtin-plugins/core-tools/**",
      "apps/server/src/live/**"
    ],
    "W7.7": [
      "apps/server/src/services/keys/**",
      "apps/server/src/security/{keyring,session}*",
      "apps/server/src/services/secrets/**",
      "apps/server/src/services/shares/{index,token}*",
      "apps/server/src/http/routes/{keys,auth}{,.test}.ts",
      "apps/server/src/http/middleware/session-auth*"
    ],
    "W7.8": [
      "apps/server/src/services/files/**",
      "apps/server/src/services/data/**",
      "apps/server/src/http/routes/data{,.test}.ts"
    ],
    "W7.9": [
      "apps/web/app/stores/{projects,chats}*",
      "apps/web/app/components/projects/**",
      "apps/web/app/components/settings/projects/**",
      "apps/web/app/pages/settings/projects.vue",
      "apps/web/app/components/app-shell/{ChatNav,CommandPalette}*",
      "apps/web/app/components/app-shell/chat-nav/**"
    ],
    "W7.10": [
      "apps/web/app/composables/{useChatSession,useServerEvents}*",
      "apps/web/app/components/chat/{ChatView,ChatHeader,ChatMessage,ChatTranscript,NewChatHeader,ChatGreeting,chat-format,chat-context,nuxt-imports}*",
      "apps/web/app/pages/{index,chat/[id]}.vue",
      "apps/web/app/utils/testing/fixtures.ts"
    ],
    "W7.11": [
      "apps/web/app/components/chat/parts/**",
      "apps/web/app/components/share/{SharedMessage,ShareToolRow,share-view}*",
      "apps/web/app/utils/{line-diff,ansi}*"
    ],
    "W7.12": [
      "apps/web/app/components/chat/composer/**",
      "apps/web/app/components/settings/{GeneralSettings,general}*"
    ],
    "W7.13": ["apps/web/app/components/settings/data/**"]
  },
  "allow": [
    "docs/ROADMAP.md",
    "docs/DECISIONS.md",
    "AGENT.md",
    "pnpm-lock.yaml"
  ]
}
```

### Wave P7-A cross-agent contracts

The props below are frozen in the P7-0b stubs or documented in UI.md 10.4; the server members in the frozen `types.ts`.

| Producer → consumer | Contract |
|---|---|
| C14 → W7.1, W7.4, W7.5 | `ProjectService` (implemented by W7.1; the fake meanwhile): `openWorkspace` result, `OpenWorkspace`, the detach and `chatCount` queries stay in the project service |
| C14 → W7.2, W7.3 | `resolveWorkspacePath` and its helpers (frozen) |
| C13 → W7.2, W7.3, W7.11 | the workspace tool output schemas: the server writes exactly these shapes, the web parses them |
| W7.2 / W7.3 → W7.4 | `core-workspace` tools declare `workspace` access; `shell` is `execute`; the policies are functions of the input and `ToolCallContext.workspace` |
| W7.4 only | `ApprovalInput.workspace` and the `edits` case |
| W7.1 → W7.4 | `openWorkspace(id)` on every chat-model run; the project file content and `truncated`; the message of an unavailable folder (used as the notice text) |
| W7.5 → W7.9, W7.10 | `ChatSummary.projectId` in lists, events and search; `PATCH /chats/:id { projectId }` answers 404 / 409 `run-active` |
| W7.1 → W7.9 | `ProjectSummary`, the browse result, `POST /projects` errors (409 `exists`, 400 on `['path']`, 404, 403 fresh auth) |
| C16 → W7.7, W7.8 | `MaintenanceService` (`exclusive`, `current`); `blockRuns` only for the key rotation |
| C16 → W7.7 | `denyOpenApprovals`, `disconnectAll()`, the keyring controls, the `main.ts` hooks calling `recoverKeyState`, `acquireServerLock` and the CLI |
| W7.7 → W7.13, W7.10 | `GET /keys` (`KeyStatus`), `POST /keys/rotate` (`KeyRotationResult`, one new cookie), `key.rotated` |
| W7.8 → W7.13 | `GET /data/cleanup` (`DataCleanupPreview`), `POST /data/cleanup` (`DataCleanupResult`), 409 `busy` |
| W7.6 → W7.11 | `ToolSummary.workspace` (the card hides "Always allow" for `execute`, offers "Accept all edits" for `write`) |
| C15 stubs: W7.9 → W7.10 | `ChatProjectChip { chatId, projectId }`, `NewChatProjectPicker { modelValue, disabled? }`, `useMoveChat()`; W7.10 mounts them |
| W7.11 only | `ToolApprovalCard.workspace` and its `decide` payload `{ approved, alwaysAllow, acceptEdits? }`; W7.10 re-emits `acceptEdits` through `ChatMessage` and the session |
| W7.12 only | `PermissionMenu.modes`, `ChatComposer.projectId` (W7.10 passes it) |

### Gate P7-A

1. `node scripts/audit-ownership.mjs .tmp/waves/P7-A.json`
2. Batch the CCRs → `nuxi prepare` → `pnpm check` → `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
3. `rm -rf .tmp/e2e` → probes on `pnpm start:e2e` (`b=http://127.0.0.1:8899/api`, log redirected to
   `.tmp/gates/P7-A/server.log`) and on probe servers (`HF_PORT=8897` / `8898`, `HF_DATA_DIR=.tmp/gates/P7-A/<name>`,
   one with `HF_PASSWORD`); loops run through `bash -c` (zsh does not word-split). Projects are created under the
   default root `<dataDir>/workspaces`:
   - **Projects** — `POST $b/projects` on the password server: 403 without a fresh login, 201 with; `{ "name": "Demo",
     "path": "<root>", "newFolder": "demo" }` creates `<root>/demo`; the same path again → 409 `exists`;
     `GET $b/projects/browse?path=/etc` → 400; a path inside the data dir → 400; `DELETE $b/projects/<id>` detaches the
     chats (`GET $b/chats?projectId=none` lists them) and the folder stays; delete or move during a long `mock:echo`
     reply → 409 `run-active`.
   - **Workspace run** — a new chat with `projectId`, `modelRef: 'mock:workspace'`, `toolMode: 'edits'` → `write_file`
     and `edit_file` run, `shell` asks; approve → stdout "Hello from the workspace agent."; the file on disk changed;
     the tool parts carry relative paths and diff hunks; with `toolMode: 'ask'` the edit asks; a server with
     `HF_WORKSPACE_SHELL=0` offers no `shell` (the mock answers "Workspace done."); a chat without a project gets no
     workspace tool ("Workspace tools are not available."); the folder removed on disk → the `workspace-unavailable`
     notice.
   - **Shell safety** — `sleep 30` through `shell` + `POST $b/chat/<id>/stop` → the process is gone (`kill -0 <pid>`
     fails); `env` output lacks `HF_PASSWORD` and every provider key; a `search_files` with `(a+)+$` on a large file
     times out while `curl $b/health` keeps answering.
   - **Keys** — `GET $b/keys` → `keyCheck: ok`; seed a credential, a share and a pending approval; rotate without a
     cookie → 401, with a fresh login → 200 (`approvalsExpired: 1`, `keyVersion: 2`, one `Set-Cookie`); the old cookie
     → 401; the old share URL → 404, the new one → 200; the pending part → `output-denied` "Expired after a key
     rotation."; `SELECT DISTINCT key_version FROM secrets` → 2; only `secret.key` left (0600, changed); `curl -sN
     $b/events` shows `key.rotated`, then the stream closes; no key text in the log; a random `secret.key.next` at boot
     is removed with a warning; env mode: the API → 409 `env-key`, the CLI while the server runs → exit 2, stopped +
     `HF_NEW_MASTER_KEY` → exit 0, a restart with the new key → `keyCheck: ok`, with the old one → `mismatch`.
   - **Cleanup** — a fresh upload → preview `recentFiles: 1`; aged (`UPDATE files SET created_at = …`) → preview
     `files: 1` → cleanup → `GET /files/<id>` 404; two identical uploads, one referenced → the blob is kept; an id only
     in `plugin_kv` → kept; a rowless aged blob and a stale `.tmp` → removed; a cleanup during an import → 409 `busy`.
   - **API fixes** — `mock:image-tool` (with `imageModelRef: 'mock:image'`) → the output has `modelName` and the model
     text names it; `POST $b/audio/speech` and a transcription with `modelRef: 'nope:x'` → 400
     `provider_not_configured` with action `configure-provider`.
   - **Logs** — the base64 text of the old and the new master key (read from `secret.key` before and after the
     rotation) appears nowhere in `.tmp/gates/P7-A/server.log` (`grep -c -F "<key text>"` → 0); no `cat
     mock-workspace` command text at `info`.
4. `pnpm test:e2e` (`chromium` + `mobile` + `tablet`; the feature specs come in P7-B) green; the math spec green.
5. `E2E_SCREENSHOTS=1 pnpm test:e2e --grep @screenshots` → review `.tmp/screenshots/{dark,light}/`.
6. `pnpm audit --prod --audit-level high` clean.
7. ROADMAP + wave log → commit `feat: add projects, workspace tools, key rotation and file cleanup`.

---

## Wave P7-B — feature e2e, docs, fix-ups

### Coordinator actions

- Before the launch: the P7-A checkpoint build for W7.14; W7.16 / W7.17 globs from the red P7-A gate items added to
  `.tmp/waves/P7-B.json` (launched only when needed); the P7-A reports handed to W7.15 as the digest
  `.tmp/waves/P7-A-notes.md` (contract facts, deviations, items marked "For W7.15").
- The final gate below; ROADMAP (every Phase 7 box, the backlog, the wave log); the memory file; push only when the
  user asks.

### W7.14 e2e-features (e2e 8891)

- **Mission.** End-to-end specs for projects, workspace tools, key rotation and cleanup, mobile and tablet checks,
  and screenshots of the new screens.
- **Owned.** `e2e/**`.
- **Read-only highlights.** UI.md 2.12 – 2.14, 7.19, 7.20, 9.8, 9.10, 13.8, 14; PROVIDERS.md 8 (`mock:workspace`);
  `playwright.config.ts`; `e2e/README.md`.
- **Tasks.**
  1. **W7.14-T1 Helper** — `e2e/helpers/workspace.ts` seeds `.tmp/e2e/workspaces/demo` (inside the e2e server's default
     root) and removes it afterwards.
  2. **W7.14-T2 `core/projects.spec.ts`** — create a project from an existing folder through the browser; create one
     with "New folder" and assert the folder exists on disk; the filter (All chats / No project / the project); move a
     chat to and out of a project; delete a project (the chats stay, the folder stays); the filter and the mode
     persist across a reload.
  3. **W7.14-T3 `core/workspace-tools.spec.ts`** — `mock:workspace`: the edit preview shows the diff → Allow → the row
     reads `+N −M` and expands to the diff; the shell approval has no "Always allow" → the terminal shows exit 0; Accept
     edits skips the edit approval but asks for the shell; the approval checkbox switches the mode to edits; a shared
     chat (tool details on) shows the diff.
  4. **W7.14-T4 `core/data-maintenance.spec.ts`** — rotate the key through the UI (typed `ROTATE`) → the toast, a new
     share URL works, an expired approval shows denied; the cleanup preview and run.
  5. **W7.14-T5 Mobile and tablet** — `mobile/projects.spec.ts` (the switcher in the sheet, no horizontal overflow with
     a diff open, the chip icon-only); the tablet touch-target spec covers the switcher, the chip and the approval
     controls.
  6. **W7.14-T6 Screenshots** — the switcher open, the new-chat picker, the Add dialog, the edit and shell approvals, an
     expanded diff, terminal output, Settings → Projects, the two Data sections, a mobile diff (dark + light).
  7. **W7.14-T7 README** — `e2e/README.md` lists the new specs and the workspace helper.
- **Verify.** `pnpm test:e2e --list`; slot runs (`HF_MOCK_PROVIDER=1 HF_OFFLINE=1 HF_PORT=8891
  HF_DATA_DIR=.tmp/W7.14/data node apps/server/dist/main.mjs`, `E2E_BASE_URL=http://127.0.0.1:8891 pnpm test:e2e`);
  three green runs of the new specs.

### W7.15 docs-final

- **Mission.** Reconcile every doc with the code and the agent reports.
- **Owned.** `README.md`, `.env.example`, `docs/**` except `DECISIONS.md` and `ROADMAP.md`.
- **Read-only highlights.** `.tmp/waves/P7-A-notes.md`, the code of every Phase 7 area.
- **Tasks.**
  1. **W7.15-T1 Reconcile** — API.md vs the route table and the implemented answers (projects, keys, cleanup, the
     chat request `projectId`, the media 400); UI.md 13.8 vs `utils/testids.ts`, the component contracts (10.4), the
     stores and composables (11, 11.4), the copy (15); ARCHITECTURE.md vs the implemented flows (6.13 – 6.15, the boot,
     the approval table, the security rules, the log fields); PLUGINS.md vs the SDK 1.2.0 names and `core-workspace`;
     PROVIDERS.md 8 vs `mock:workspace`; the guides.
  2. **W7.15-T2 Status** — README "v1.3" (features: projects and workspace tools, Accept edits, key rotation, storage
     cleanup); refresh `docs/assets/screenshots/` only when a README image changed visibly (copied from
     `.tmp/screenshots/`).
  3. **W7.15-T3 This file** — what actually happened (status, deviations, gate results per wave).
- **Verify.** `pnpm check:english`; `pnpm -F @harness-forge/shared test` (doc-coupled tests).

### W7.16 / W7.17 fix-ups

Launched only for red P7-A gate items (W7.16 server, W7.17 web), with the globs of those items.

### Wave P7-B ownership

```json
{
  "wave": "P7-B",
  "agents": {
    "W7.14": ["e2e/**"],
    "W7.15": [
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

1. `node scripts/audit-ownership.mjs .tmp/waves/P7-B.json` → `pnpm install --frozen-lockfile` → `pnpm check` →
   `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
2. The P7-A probes again (after `rm -rf .tmp/e2e`).
3. `for i in 1 2 3; do pnpm test:e2e || exit 1; done` (`chromium` + `mobile` + `tablet`), with the OS color scheme
   emulated as light.
4. `E2E_SCREENSHOTS=1 pnpm test:e2e --grep @screenshots` → dark + light reviewed.
5. `pnpm audit --prod --audit-level high`.
6. **Real v1.2 → v1.3 upgrade**: `git worktree add .tmp/v12 b5bb2ec`, install and build there, run it on a fresh data
   directory and seed the full set (password, provider / plugin / MCP secrets, a share link, a pending approval,
   branched chats, referenced and orphaned files, a generated image), stop it, start v1.3 on the same data directory →
   `0004` applied, everything intact, secrets readable, `keyCheck: ok`; then a rotation, the env-mode CLI round trip and
   a cleanup on the upgraded data.
7. Docker (daemon permitting): the image has `bash` and `git`; `rotate-key` inside the container (`docker run --rm -v
   <volume>:/data -e HF_MASTER_KEY=… -e HF_NEW_MASTER_KEY=… harness-forge node apps/server/dist/main.mjs rotate-key`
   with the server container stopped); else left to CI.
8. ROADMAP + wave log → commit `chore: final gate for harness-forge v1.3`; write the project memory (state, commits,
   user actions); push only when the user asks. The live provider suite stays the user's (paid).

---

## Outcome

Filled in as the waves finish (the gate results are copied from the ROADMAP wave log; "audit" is the ownership audit
of `scripts/audit-ownership.mjs`).

| Wave | Agents | Gate result | Commit |
|---|---|---|---|
| P7-00 | coordinator | math tests committed; Dependabot merges pending | `3af05be` |

---

## Risks

State before P7-0a.

| Risk | Mitigation |
|---|---|
| Prompt injection drives the shell or exfiltrates secrets | approval by default; Accept edits instead of Auto for edits; secret-looking reads ask, hidden-path writes always ask; the environment allowlist; `HF_WORKSPACE_SHELL=0`; the accepted risks documented (ADR-033, ARCHITECTURE.md 10.9) |
| Path escape (symbolic links, `..`, the data dir) | one frozen resolver (C14) with exhaustive tests; a realpath re-check on every call; roots validated at boot; the data dir excluded |
| Runaway processes or a ReDoS freeze the server | the process-group kill + exit handler + timeouts; compose `pids_limit`; the search regex in a killable Worker |
| Old exports / backups stop importing (`projectId` required) | the export schemas omit `projectId`; import tests with v1 / v2 fixtures |
| Migration `0004` rebuilds `chats` | rebuild statements rejected at review; the upgrade test, the `.tmp/upgrade-v12` probe and the real v1.2 → v1.3 upgrade |
| The new key is lost in a crash, or a secret is written with the old key | the write-ahead `secret.key.next`, the key check, the recovery table and crash-injection tests; the `whenKeyStable` gate |
| The CLI runs against a live server, or an env key is lost | the health probe + `server.lock`; the CLI never generates or prints an env key |
| The cleanup deletes a file still in use | a loose scan of every JSON column + the coverage test; the 24 h grace; pins; the DELETE re-check; manual with a preview |
| katex 0.18 breaks math | the math tests landed first; the worktree check; a one-commit revert |
| Hot files (`S/chat/**`, `S/services/chats/**`, `useChatSession`, `parts/**`, `ChatNav`) | one owner per file per wave; the cross-cutting pieces (`approvals.ts`, maintenance, `blockRuns`, the resolver) land in P7-0b |
| Doc-coupled route count (85) | all 9 routes and API.md section 8 land with C13 |
| A cached mock listing hides `mock:workspace` | `.tmp/e2e` is wiped before every gate |
| Wave size (13 agents) | fix-up agents in P7-B; first cuts: the CLI `--force`, the palette entries, the Settings → Projects instructions dialog |
| `@types/picomatch` fetch or `diff` API drift | K2 verifies the installed types; `path.matchesGlob` as the fallback |
| Shell tests are flaky on CI (timing, `dash`) | POSIX syntax only, generous margins, `kill -0` / ESRCH checks instead of sleeps where possible |
