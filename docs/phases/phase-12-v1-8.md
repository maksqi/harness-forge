# Phase 12 — v1.8: Claude Code ecosystem

Part of the harness-forge build plan. Progress is tracked in `docs/ROADMAP.md` (coordinator only). Shared names come
from `docs/DECISIONS.md` (ADR-053 … ADR-058, the amendment notes on ADR-008, ADR-017, ADR-024, ADR-036, ADR-038, ADR-043
… ADR-045, ADR-048 … ADR-050 and ADR-052, and the Phase 12 contract seed; it wins on conflict); endpoints and DTOs from
`docs/API.md` (the new schema sections 4.33 (marketplaces and the Claude plugin info), 4.34 (the home-folder import) and
4.35 (project definition files), the hook, setting and data additions, the route sections 5.34 – 5.36 for the modules
`marketplaces`, `claudeImport` and `projectDefinitions`, the `pluginInstall` bodies with the `github` / `marketplace`
sources and `format`, the event `marketplace.changed`, the conflict reason `offline`, the two settings and the 132-route
key index; C40 fixed these numbers); components, props, store and module signatures, routes, shortcuts and test ids from
`docs/UI.md` (the 2.19 wireframes, 5.4 the Plugins mode contents (the Marketplaces row) and the 5.5 note, 6 routes
(`/plugins/marketplaces`, `/settings/customize?import=claude`), the new 7.34 chat additions, 8.13 marketplaces and
Claude Code plugins, 9.14 the import wizard, project file editing and the Hooks additions, 10.9 contracts, 11.9 modules,
13.13 the 70 test ids, 14.1, 14.2 and 14.5 – 14.7 accessibility, 15 copy); flows, tables and security rules from
`docs/ARCHITECTURE.md` (the new flow sections 6.33 – 6.38 for Claude Code plugins, marketplaces and archive sources, the
home-folder import, project definition edits, prompt hooks / the new events / transcripts and frontmatter compatibility,
the stop order, backups, `0009`, the Phase 12 security section 10.13, the log rules); plugin API 1.6.0 (the version
rows), section 17 "Claude Code plugins" and the example 15 (h) `claude-review-kit` from `docs/PLUGINS.md`; the mock
model `mock:prompt-hook` from `docs/PROVIDERS.md` (8, "Prompt hook mock (Phase 12)": the probe contract); the user
guides `docs/guides/claude-code-import.md` and `docs/guides/claude-code-plugins.md` (and the updated
`docs/guides/hooks-and-project-mcp.md` and `docs/guides/customizing-agents.md`). The UI.md, ARCHITECTURE.md, PLUGINS.md
and PROVIDERS.md sections and the guides were written by D17 in P12-0a, API.md by C40. W12.15 reconciles every doc with
the code in P12-B.

**Status (2026-10-06): in progress.** P12-00 is done: `c89ca97` `ci: pin ubuntu-24.04 runners` (pushed; actionlint
1.7.12 clean), `bdc9348` `chore(deps): patch shell-quote (GHSA-pqg4-j6r4-53mv)` (a pnpm override; on `main`, pushed with
the next push the user asks for), the baseline `pnpm check` on `b3fa452` green with **11787 tests** and `git status`
unchanged, the six ignored advisories re-checked (still unpatched; katex < 0.18.2 through mermaid is low and left as
is), `.tmp/v17` (a worktree of `b3fa452`) installed and built, the old `.tmp` content archived. P12-0a runs now.
"Deviations found while building" is empty until the first gate; "Outcome" is filled in at each gate.

Paths: `S` = `apps/server/src`, `W` = `apps/web/app`, `SH` = `packages/shared/src`, `SDK` = `packages/plugin-sdk/src`.
File:line references point at `main` = `b3fa452` (the source files are identical on `bdc9348`; the references drift as
the waves land: search for the named symbol).

## Goal

Ship v1.8: the Claude Code ecosystem — what users already have in Claude Code works in harness-forge — plus the four
Phase 11 leftovers and plugin API 1.6.0.

- **Claude Code plugins** (ADR-053, amends ADR-008, ADR-017, ADR-024, ADR-044 and ADR-052): a plugin folder in Claude
  Code's layout (`.claude-plugin/plugin.json` optional; `commands/` with subfolders, `agents/`, `skills/<name>/SKILL.md`
  with its supporting files, a root `SKILL.md`, `output-styles/`, `hooks/hooks.json`, `.mcp.json`, and the component
  path fields of `plugin.json` with their replace / add / merge rules) installs as a third format (`plugins.format =
  claude`), stored byte for byte under `<dataDir>/plugins/<id>/` with its owner exec bits and read in place by
  `S/plugins/claude/**` through the shared definition, hook and MCP parsers; the DTO manifest is synthesized (no
  `contributes`). Its commands, agents, skills and output styles register under **qualified names**
  `<pluginId>:<seg>…:<name>` (a bare name resolves when exactly one active entry ends with `:<bare>` and nothing has the
  exact name), its hooks and MCP servers like a harness plugin's. A plugin that runs anything (a command hook handler, a
  stdio MCP server, a `` !`cmd` `` span) needs a trust pin over the sha256 of its **whole file tree**
  (`hf-claude-plugin/v1`: paths, modes, sizes, contents, the marketplace overlay). `userConfig` becomes the plugin
  settings form (sensitive options are secret settings); `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`,
  `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SKILL_DIR}` and `${user_config.KEY}` are substituted where Claude Code substitutes
  them (never from the server environment; secret values never in markdown bodies; `${user_config.*}` refused in
  shell-form hooks); the `skill` tool reads a plugin skill's supporting files (`file`); `.lsp.json`, `bin/`, `themes/`,
  `monitors/`, `workflows/` and the plugin's `settings.json` are listed as ignored and never run; `defaultEnabled:
  false` installs disabled; Claude plugins are not editable in the plugin editor and never in backups.
- **Marketplaces and HTTPS archive sources** (ADR-054, amends ADR-008 and ADR-017): a marketplace
  (`.claude-plugin/marketplace.json`) is added from a GitHub repository (`owner/repo[#ref]`), a hosted
  `marketplace.json` URL or a server folder (table `marketplaces`, `mkt_` ids), browsed on Plugins → Marketplaces and
  installed from with the normal review. GitHub sources (marketplaces, entries, the install dialog's new GitHub tab)
  resolve a ref to a commit through `api.github.com` and download that commit's zip from `codeload.github.com`; **there
  is no git anywhere** and every request goes through `safeFetch` (https only). Entries with relative sources come from
  the stored commit's subtree; `github`, `archive` (sha256 checked when given) and `npm` (default registry) entries
  install; other git hosts and `command` sources are listed as unsupported; `strict` follows Claude Code (the entry
  overlay lives in `plugins.origin`, the files stay identical). No automatic refresh or update: "update available"
  compares the entry version, else the commit, and an update is a new review + trust pin. Removing a marketplace keeps
  its plugins; the official names are accepted only from `anthropics/*` repositories; the official marketplace is a
  suggestion card that sends nothing before a click; `HF_OFFLINE=1`: adding or refreshing a `github` or `url`
  marketplace and installing from a `github` or `marketplace` source answer 409 `offline` (a folder marketplace still
  works); no GitHub token (60 unauthenticated requests per hour).
- **Import from a Claude Code home folder** (ADR-055, amends ADR-038, ADR-044, ADR-048 and ADR-050): Settings →
  Customize → Import from Claude Code (also linked from Settings → Data; `/settings/customize?import=claude`) reads a
  `.claude` folder picked in the browser (plus an optional `.claude.json`), an uploaded zip, or the server's own folder
  (`HF_CLAUDE_HOME`, default `~/.claude`, `0` = off, the Docker image's default; fresh auth). The server builds the plan
  (`cip_` id, in memory, 10 minutes) from an **allowlist only**, the wizard previews it (new / update / unchanged /
  conflict / unsupported / invalid) and the picked items are copied once into personal sources: agents, commands, skills
  and output styles (personal definitions), `settings.json` hooks (personal hooks; command hooks and `!` commands arrive
  turned off unless enabled), `permissions.allow` `Bash(...)` rules (global shell rules), whole-tool `deny` rules (tool
  overrides), `outputStyle`, `CLAUDE.md` (global instructions, append or replace) and the `mcpServers` of
  `~/.claude.json` (per-project ones as disabled global servers). Contents and env / header values stay in the
  server-side plan; apply needs fresh auth; re-import compares by kind + name (skip, overwrite or rename).
- **Editing project definition files** (ADR-056, amends ADR-036, ADR-044 and ADR-049): Customize (Edit… / Delete… on
  project rows, New {kind} from a section heading), the Hooks tab and the project MCP dialog (Edit .mcp.json…) write a
  project's definition files under `.claude/` and `.harness/`, the `hooks` key of its four settings files and the
  `mcpServers` key of `.mcp.json` (`/projects/:id/definitions/file`): the workspace path guard, the per-file lock, an
  `expectedSha256` check (409 `stale`), shared-parser validation (400 with diagnostics), not journaled
  (`workspace.changed` source `user`), allowed while a run is active, no fresh auth — **saving never approves
  anything**: a saved hook, server or `!` command stays pending until the trust dialog approves it (the answer carries
  the pending count).
- **Prompt hooks, five more events, handler fields and `transcript_path`** (ADR-057, amends ADR-043 and ADR-048): hook
  handlers `type: 'prompt'` (a small model answers `{ ok, reason?, impossible? }` about the hook input; handler `model`
  → setting `hookModelRef` → the provider's small model → the run model; ≤ 8 calls at once; usage purpose `hook`; an
  answer never grants a permission) for `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`,
  `SubagentStop` and `PermissionRequest`; the events `PostToolUseFailure`, `PermissionRequest` (may answer the approval
  card; main agent only), `SubagentStart`, `PostCompact` and `SessionEnd` (a single chat delete) join the eight of
  ADR-048 (13); command handlers gain `args` (exec form), `async`, `if` and `statusMessage`; the payload gains
  `transcript_path` (a Claude Code-compatible JSONL subset at `<dataDir>/transcripts/<chatId>.jsonl`, written lazily,
  0600, never in backups). Project prompt hooks need approval (trust item v2); items without the new fields keep their
  v1 bytes, so **every v1.7 approval stays valid**. `hooksEnabled: false` and `HF_SAFE_MODE` turn prompt hooks off
  (`HF_WORKSPACE_SHELL=0` does not).
- **Frontmatter compatibility** (ADR-058, amends ADR-044 and ADR-045): agents `disallowedTools`, `maxTurns`, `color`,
  `skills` (preloaded into the child's instructions) and Claude model aliases (setting `modelAliases`); commands and
  skills `when_to_use`, `arguments` (named arguments), `disallowed-tools`, `context: fork` with `agent`; skills
  `allowed-tools` and `model`; bodies `$ARGUMENTS[N]`, `$name`, `\$`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}` and
  `${CLAUDE_SESSION_ID}`; the argument base is 0 when a body uses `$0` or `$ARGUMENTS[` or declares `arguments`, else 1
  (every v1.6 / v1.7 template keeps its meaning); keys Claude Code supports but the harness does not are `ignored-key`
  info diagnostics; the restrict-only rules hold.
- **Phase 11 leftovers**: the hook rows of untrusted plugins ("Plugin not trusted" + "Review plugin…"); the trust
  dialog's partial "Select all" shows a mixed checkbox; a hook `allow` the harness still asks about is recorded with
  `harnessAsked` ("Allowed by hook · still asks"); the backup restore result counts the commands it turned off
  (`customizations.turnedOff`).
- **Plugin API 1.6.0** (additive): `CommandDefinition.{ syntax?: 'template' | 'markdown', argumentHint?, model?,
  allowedTools? }`, `SkillDefinition.{ baseDir?, argumentHint?, userInvocable?, modelInvocable? }`,
  `contributes.skills[].baseDir?`, agent fields `disallowedTools?`, `maxTurns?`, `color?`, `skills?`, `HookEventName` +
  the five events, command hook `args?` / `async?` / `if?` / `statusMessage?`, prompt hook handlers (`type: 'prompt'`;
  prompt-only hooks need no trust pin), names qualified with the plugin's own id, `PluginSource` + `github`,
  `marketplace`; `^1.5.0` plugins keep loading; the template mirror follows; the example
  `examples/plugins/claude-review-kit` (the only folder of the repository with a `.claude-plugin/plugin.json`; its MCP
  server is declared inline, there is no `.mcp.json`).

Out of scope (ROADMAP backlog): a project's `enabledPlugins` / `extraKnownMarketplaces` recommendations (the import
lists them as unsupported), git clone sources (other git hosts stay "unsupported source"), a GitHub token and private
repositories, LSP servers (`.lsp.json`, `lspServers`), themes, monitors, workflows, plugin `bin/` on the shell's `PATH`,
`http` / `mcp_tool` / `agent` hook handlers (`unsupported-type` warnings), OAuth-only remote MCP servers (a diagnostic,
no connection), editing Claude plugins in the plugin editor, unpinning the CI runners from `ubuntu-24.04`, the other
Claude Code hook events (info diagnostics), automatic marketplace refresh and auto-update, and everything else in the
backlog. Kept as documented behavior: project definition files saved from the UI are not journaled (rewind sees them as
outside changes); GitHub zip bytes are not pinned (the commit and the tree hash are); an `archive` entry without
`sha256` is trusted on first use (its tree hash is still reviewed); `HF_OFFLINE=1` refuses only `github` / `url`
marketplaces and `github` / `marketplace` installs (a folder marketplace, npm and URL installs are unchanged); a
marketplace URL source fetches only the JSON, so its relative entries are unsupported; plugin `allowed-tools` never
pre-approve a tool; plugin MCP servers that use `${CLAUDE_PROJECT_DIR}` are skipped (plugin servers are global); hook
scripts that need `python3`, `jq` or `node` may fail in the alpine Docker image; the transcript is a best-effort subset
of the active path (it may lag, like Claude Code's); a prompt hook's `ok: true` decides nothing; removing a marketplace
keeps the plugins installed from it; an untrusted Claude plugin's hooks are shown on its plugin page, not in `GET
/hooks`.

Totals after Phase 12: routes 120 → **132** (`marketplaces.list` `GET /marketplaces`, `marketplaces.add` `POST
/marketplaces` (201), `marketplaces.get` `GET /marketplaces/:id`, `marketplaces.refresh` `POST
/marketplaces/:id/refresh`, `marketplaces.remove` `DELETE /marketplaces/:id` (204), `claudeImport.home` `GET
/claude-import/home`, `claudeImport.scan` `POST /claude-import/scan` (fresh), `claudeImport.upload` `POST
/claude-import/upload` (multipart), `claudeImport.apply` `POST /claude-import/apply` (fresh), `projectDefinitions.read`
`GET /projects/:id/definitions/file?path`, `projectDefinitions.write` `PUT /projects/:id/definitions/file`,
`projectDefinitions.remove` `DELETE /projects/:id/definitions/file?path&expectedSha256`), route modules 33 → **36**
(`marketplaces` 5, `claudeImport` 4, `projectDefinitions` 3; files `marketplaces.ts`, `claude-import.ts`,
`project-definitions.ts`), routes with `fresh: true` 12 → **14**; the `pluginInstall.inspect` / `install` bodies gain
the `github` / `marketplace` sources and `format?`; tables 22 → **23** (`marketplaces`), migration
**`0009_claude_ecosystem`** (1 CREATE TABLE + 1 CREATE UNIQUE INDEX + `plugins` ADD `format` (default `harness`) /
`origin` + `hooks` ADD `type` (default `command`) / `prompt` / `model` / `options`; nothing else), SSE types 18 → **19**
(`marketplace.changed`), settings keys 30 → **32** (`hookModelRef`, `modelAliases`), conflict reasons 14 → **15**
(`offline`), error codes **16**, notice codes **11** and UI data part types **6** unchanged, hook events 8 → **13**,
workspace change sources + **`user`**, usage purposes + **`hook`**, id prefixes **`mkt_`** (marketplaces), **`cip_`**
(import plans, in memory), reserved plugin ids + `new`, `marketplaces`, plugin API **1.6.0** (additive), mock models 17
→ **18** (**`mock:prompt-hook`**), the environment variable **`HF_CLAUDE_HOME`** and the test-only
**`HF_TEST_REMOTE_URL`**, **70** new test ids (UI.md 13.13), ADR-053 … ADR-058, **no new dependency**. Agents: 5
(P12-0a: C40, C41, C42, D16, D17; plus the seed agent K3S) + 4 (P12-0b: C43, C44, C45, C46; plus the upgrade-probe agent
G12B) + 13 (P12-A: W12.1 – W12.13; plus the gate-probe agent G12P) + 2 (P12-B: W12.14, W12.15; W12.16 / W12.17 only for
red P12-A gate items) = 24 (27 with the probe and seed agents, 29 with the fix-ups), in the Phase 5 wave method
(ADR-016).

## Entry criteria

- v1.7 is on `main` and pushed (`origin/main` = `b3fa452`, `chore: final gate for harness-forge v1.7`; CI run
  `37443973625` and the scheduled Audit run are green; no open pull request): `pnpm check` (11787 tests), `pnpm build`
  and e2e 191 passed ×3 (`chromium` + `mobile` + `tablet`).
- P12-00 is done (see "Wave P12-00"): the runners pinned to `ubuntu-24.04` and pushed (`c89ca97`), the shell-quote
  override (`bdc9348`), `.tmp/v17` built, the baseline recorded.
- The approved plan and the design inputs exist in `.tmp/p12-designs/` (`plan.md`, `README.md`, `agent-rules.md`,
  `server-plugins.md`, `server-import.md`, `web-process.md`, `claude-formats.md`, `explore-{catalog,plugins}.md`; the
  "Reconciliation" table and the "Totals" of `plan.md` and the deviations listed in `README.md` are binding and win over
  the reports).
- K1 is done: DECISIONS.md carries ADR-053 … ADR-058, the amendment notes and the Phase 12 contract seed (ids `mkt_` /
  `cip_`, the qualified catalog names, the reserved plugin ids `new` / `marketplaces`, the Phase 12 names (13 hook
  events, handler types `command | prompt`, agent colors, Claude model aliases, the import allowlist, the reserved
  marketplace names, the official suggestion), the HTTP module rows `marketplaces.ts` / `claude-import.ts` /
  `project-definitions.ts` that `routes.test.ts` reads, the event, the two settings, the table and `0009`,
  `plugins/.data/<id>` as `${CLAUDE_PLUGIN_DATA}`, `HF_CLAUDE_HOME` and the test-only `HF_TEST_REMOTE_URL`, the mock
  model, the example plugin `claude-review-kit`, the backup contents, the UI query parameters); ROADMAP.md has the Phase
  12 section and the updated backlog; AGENT.md has the "Plugin API 1.6.0" and "Claude Code ecosystem" facts, the
  repository rule (now also `.claude-plugin/`, anywhere in the repository) and the Phase 12 freeze line.
- K2 is done: no new dependency (the installer's zip and tar readers, `node:crypto` for sha256, the existing `yaml` 2,
  `safeFetch`, the AI SDK's `generateText`); `start:e2e` is unchanged (e2e uses uploads and local folders, never the
  server scan).
- The contract skeletons exist: `SH/util/{claude-plugins,claude-import,claude-permissions}.ts` (final names and
  signatures, bodies throw until C41 implements them) and their exports in `SH/index.ts`.

## Exit criteria

- Every Phase 12 item in `docs/ROADMAP.md` is checked; every wave gate is green; the final checkpoint commit `chore:
  final gate for harness-forge v1.8` exists (pushed only when the user asks).
- `pnpm check` and `pnpm build` are green; the built-page CSP test passes with `HF_TEST_REQUIRE_WEB_BUILD=1`.
- `pnpm test:e2e` (projects `chromium` + `mobile` + `tablet`, OS color scheme emulated as light) is green 3× in a row,
  including the new specs `core/claude-import`, `core/project-edit`, `core/prompt-hooks`, `plugins/marketplaces`,
  `plugins/claude-plugin`, `plugins/plugin-update`, `mobile/marketplaces`, `mobile/claude-import` and the extended
  `customize`, `hooks`, `project-trust`, `data` and tablet touch-target specs (about 215 tests; the 30-minute CI e2e
  budget holds); the `@screenshots` run (dark + light) was reviewed; the README images come from the `@readme`
  full-frame shots.
- The gate probes (Gate P12-A, repeated at the final gate on a fresh `.tmp/e2e`) and the regressions (the coordinator's
  copies `.tmp/gates/P12-A/p11a-regression.mjs` and `.tmp/gates/P12-A/p10a-regression.mjs`, `node
  .tmp/gates/P9-A/probe.mjs`, `node .tmp/gates/P8-A/probe.mjs ws git`) are green.
- CI on `main` is green on `ubuntu-24.04` (`check`, `e2e`, `docker`, `audit`, `actionlint`); the advisory decision is
  recorded.
- **Upgrade**: a v1.7 data directory (seeded by the `.tmp/v17` build) boots on v1.8 with every chat, secret, share,
  project, rule, personal definition, personal hook, approval, style and background task intact: `0009` applied (an
  empty `marketplaces`, `plugins.format = 'harness'` and `hooks.type = 'command'` on every row), `integrity_check` /
  `foreign_key_check` clean, the stored expansions and hook parts byte-identical; **every v1.7 approval still matches**
  (hooks, `.mcp.json` servers, `!` command files) and its item still runs; the pending item stays pending; **nothing new
  runs before approval** (the v1.8-only `prompt` and `SessionEnd` hooks are pending, their sentinels absent); approving
  the `prompt` hook makes it work; the v1.7 backup with a `!` command restores it turned off and reports `turnedOff`.
- **Docker** (Node 24 alpine, uid 1000; daemon permitting, else the CI `docker` job): the default scan answers
  `disabled`; with `-v <fake home>:/claude:ro -e HF_CLAUDE_HOME=/claude` the scan plans as uid 1000 and never opens the
  canaries; a Claude plugin zip whose `hooks/hooks.json` runs `${CLAUDE_PLUGIN_ROOT}/scripts/mark.sh` keeps mode 0755
  and writes `id -u` = 1000 only after trust; `docker stop` leaves no orphan.
- `pnpm test` never calls a paid API, never touches the repository's `data/`, the real `~/.claude` or `~/.claude.json`,
  or a folder outside a temp directory, leaves `git status --porcelain` of the repository unchanged, creates no
  `.claude/`, `.harness/`, `.claude-plugin/` or `.mcp.json` anywhere in the repository, uses loopback only and leaves no
  fixture process behind; `pnpm test:live` stays the user's.
- README status reads "v1.8".

Manual acceptance (coordinator, `HF_MOCK_PROVIDER=1 pnpm dev` with `HF_CLAUDE_HOME=<a temp fake home>`):

- Customize → Import from Claude Code → scan or folder → preview → Import (password prompt) → the agents, commands,
  hooks, MCP servers and shell rules appear; command hooks are off.
- Plugins → Marketplaces → add a local marketplace folder → install a Claude plugin (the trust consent lists its hook) →
  `/<plugin>:<command>` runs.
- A Claude plugin zip with `userConfig` shows the secret field in its settings.
- Customize → a project row → Edit… → Save → "1 item needs your approval." → Review opens the trust dialog.
- A prompt hook (`mock:prompt-hook`) blocks a write.
- The trust dialog shows the mixed "Select all" checkbox.
- 390 px: the Marketplaces page, the import wizard and the project file editor fit.
- A v1.7 data directory boots on v1.8 intact with every v1.7 approval still valid and nothing new run before approval.

With real keys and network (the user, optional): add `anthropics/claude-plugins-official`, install a real plugin, import
the real `~/.claude`.

## Steps

| Step | Owner | Output |
|---|---|---|
| P12-00 | coordinator | design reports → `.tmp/p12-designs` (+ README reconciliation, `agent-rules.md`); baseline `pnpm check` 11787 + `git status --porcelain` before / after; CI runners pinned + pushed (`c89ca97`); advisories (`bdc9348`); `.tmp/v17` worktree installed and built; old `.tmp` content archived; memory |
| P12-0a | coordinator (K1, K2, contract skeletons, K3 seed by K3S) + C40, C41, C42, D16, D17 | decisions, ROADMAP, AGENT.md; every shared contract + plugin SDK 1.6.0 + 501 stubs + API.md; the shared helpers (complete); this file; every other doc; the v1.7 upgrade seed |
| Gate P12-0a | coordinator | audit, frozen install (`pnpm why typescript\|yaml`), check, build (web entry size vs `.tmp/v17`), CSP test, `pluginApiVersion` 1.6.0, 12 new routes mounted, e2e 191, `pnpm audit`, examples' `.d.ts`, commit |
| P12-0b | coordinator (K3) + C43, C44, C45, C46, G12B | schema + migration `0009`, server skeleton, chat seams (complete), mocks + fixtures + fake remote (complete), web skeleton, upgrade probe, FREEZE |
| Gate P12-0b | coordinator | audit, `0009` inspection, `nuxi prepare`, check, build, CSP test, e2e 191 on a fresh `.tmp/e2e`, v1.7 upgrade probe + seam no-op probe (G12B), FREEZE, commit |
| P12-A | W12.1 – W12.13 + G12P (one launch) | features + gate probes |
| Gate P12-A | coordinator | CCR batch, `nuxi prepare`, check, build, CSP, G12P probes + the P11-A / P10-A copies, P9-A, P8-A regressions, e2e 191, screenshots, audit, commit |
| P12-B | W12.14, W12.15 (+ W12.16 / W12.17 when the P12-A gate is red) | feature e2e, docs reconciliation |
| Final gate | coordinator | e2e ×3, v1.7 → v1.8 upgrade, Docker, audit, hermetic `pnpm test`, ROADMAP, memory, commit |

## Deviations from the plan (binding)

The binding changes found while building are listed per wave in "Deviations found while building" below. The coordinator
records there every binding change to the plan sections of this file, with the gate that decided it; the agents build
against the plan sections of this file plus that list.

Binding order of the design inputs: `.tmp/p12-designs/plan.md` (its "Reconciliation" table and "Totals") >
`docs/DECISIONS.md` (after K1) > this file (after D16) > the design reports (`server-plugins.md`, `server-import.md`,
`web-process.md`, `claude-formats.md`, `explore-{catalog,plugins}.md`). The reports are superseded where the plan and
`.tmp/p12-designs/README.md` disagree with them. The replaced report items, for agents who read the reports for depth
(the list of `README.md`, refined):

- **All reports — the counts**: 12 new routes in 3 modules (`marketplaces` 5: list, add, get, refresh, remove;
  `claudeImport` 4: home, scan*, upload, apply*; `projectDefinitions` 3: read, write, remove; * = fresh) → **132**
  routes / **36** modules / **14** fresh routes (server-plugins.md's 125 / 34 and server-import.md's 127 / 35 are
  superseded); one migration `0009_claude_ecosystem` for both server workstreams; **23** tables; **32** settings
  (server-plugins.md's "settings unchanged" is superseded); **19** SSE types (server-import.md's "SSE 18 unchanged" is
  superseded); **15** conflict reasons (`offline`); 18 mocks; 13 hook events.
- **All reports — the ADRs**: six ADRs with the plan's amendment lists: ADR-053 Claude Code plugin format (amends
  ADR-008, ADR-017, ADR-024, ADR-044, ADR-052), ADR-054 marketplaces + HTTPS archive sources (ADR-008, ADR-017), ADR-055
  home-folder import (ADR-044, ADR-038, ADR-048, ADR-050), ADR-056 editing project definition files (ADR-036, ADR-044,
  ADR-049), ADR-057 prompt hooks / events / handler fields / `transcript_path` (ADR-043, ADR-048), ADR-058 frontmatter
  compatibility (ADR-044, ADR-045). web-process.md's ADR-056 "409 `run-active`" is superseded (no idle rule).
- **server-plugins.md**:
  - The open questions are answered by the plan: removing a marketplace keeps its plugins; no GitHub token; `HF_OFFLINE`
    refuses adding or refreshing a `github` / `url` marketplace and installing from a `github` / `marketplace` source (a
    folder marketplace, npm and url installs unchanged); no id override (409 `exists`); harness plugins keep bare names;
    plugin MCP servers using `${CLAUDE_PROJECT_DIR}` are skipped; `allowed-tools` never pre-approve; `defaultEnabled:
    false` installs disabled; `.mcp.json` with or without the `mcpServers` wrapper; the hooks workstream (W12.5) owns
    the prompt runner and the exec form, the plugin workstream (W12.1) fills `HookCommandsRegistration.env`; the
    reserved names are `claude-plugins-official`, `claude-code-plugins`, `claude-community` and `anthropic-*`, accepted
    only from `anthropics/*`.
  - Its section 8 fixture folders (`S/plugins/__fixtures__/claude/**`, a committed `marketplace/.claude-plugin/…`) are
    superseded: fixtures are **builders** in `S/testing/claude-fixtures.ts` (C45) written into `realpath(mkdtemp())`
    folders at test time; the only committed Claude layout is `examples/plugins/claude-review-kit/`.
  - "`S/deps.ts:193` `marketplaces.stop()` before plugins" is C43's `SHUTDOWN_STEPS` (`S/deps.ts:177`, below).
  - "Item 1 reuses `MarketplaceService.add` for `extraKnownMarketplaces`" is superseded: the import lists
    `enabledPlugins` / `extraKnownMarketplaces` as unsupported (backlog).
- **server-import.md**:
  - The open questions are answered by the plan: the argument base heuristic (0 when `$0` / `$ARGUMENTS[` / `arguments`
    is used, else the legacy 1); `SessionEnd` only on a single chat delete; the home scan follows links to regular files
    outside the data directory; `.claude.json` project servers import as disabled global servers; whole-tool `deny`
    rules map to tool override `deny` (first cut); a user `/name` with `context: fork` expands with a delegation
    directive (the `skill` tool runs a child); imported command hooks are off by default for every source; project
    definition edits need no fresh auth and have no idle rule.
  - "Conflict reasons, SSE (18) unchanged" is superseded (the plugin workstream adds `offline` and
    `marketplace.changed`).
- **web-process.md**:
  - Project file edits have **no idle rule** (no 409 `run-active`) and **no fresh auth**; stale protection by
    `expectedSha256` (409 `stale`); not journaled; `workspace.changed { source: 'user' }`. The copy "A chat in {project}
    is running. Save when it has finished." is dropped.
  - The import plan is **built on the server** (an upload of browser-filtered files or a zip, or a fresh scan); the web
    never parses zips and never sees env / header values; `useClaudeImport` uploads and applies by `planId`.
  - Docker: `HF_CLAUDE_HOME=0` by default (the scan answers `disabled`); the Docker probe mounts a fake home read-only
    with `HF_CLAUDE_HOME=/claude` (not "the scan finds `/home/node/.claude` copied in").
  - The SH helper files are `SH/util/{claude-plugins,claude-import,claude-permissions}.ts` (+ additions in `hooks` /
    `trust` / `definitions` / `arguments` / `tool-names`), not `claude-plugin` / `marketplace` / `prompt-hooks` /
    `transcript` files; transcripts are written by the server (`S/services/hooks/transcripts.ts`, W12.5).
  - The service folders are `S/plugins/marketplaces/**` (not `S/services/marketplaces`), `S/services/claude-import/**`,
    `S/services/project-definitions/**` (not `project-edits`); the route files `marketplaces.ts`, `claude-import.ts`,
    `project-definitions.ts`.
  - The mock is `mock:prompt-hook` (not `mock:hook-judge`); the fake remote is `S/testing/fake-remote.ts` and the
    builders `S/testing/claude-fixtures.ts` (not `claude-home.ts` / `claude-plugins.ts`).
  - `start:e2e` gains `HF_CLAUDE_HOME=0` (Gate P12-0a; e2e uses uploads and stubs the home route); K3S writes only
    what v1.7 needs (no fake home, no local marketplace folder: the C45 builders make those later).
  - The `RESERVED_PLUGIN_IDS` proposal is C40's `isReservedPluginId` reserving `new` and `marketplaces`.
  - The P12-A split is the plan's: W12.4 is "project-definitions-server", W12.13 is "chat-web" and also owns
    `W/components/chat/composer/**` (qualified slash names); the first cuts and the G12P groups are the plan's.
  - The `ubuntu-26.04` dispatch run at the final gate is dropped (unpinning goes to the backlog).
- **claude-formats.md** is the format reference (facts from the raw `code.claude.com/docs/en/*.md` pages); what the
  harness supports of it is the plan's (13 of the 33 events, `command` and `prompt` handlers, the allowlist).
- **explore-{catalog,plugins}.md** are facts at `b3fa452`; the conversion approach of explore-plugins.md's last section
  is rejected (the native format wins, server-plugins.md section 0).

Plan-level decisions (from the reports, kept by the plan):

- **Native format, no conversion**: a harness `plugin.json` cannot hold a Claude plugin (the 256 KB manifest cap
  `S/plugins/loader.ts:38`, skills without folders, the strict hooks schema, command names and `{{input}}` templates,
  the `plugin.json`-only `contentHash` `loader.ts:80`, byte identity), so Claude plugins keep their own layout and get a
  reader.
- **Whole-tree trust**: `hf-claude-plugin/v1` covers every regular file (path, mode, size, sha256) and the marketplace
  overlay; links or special files make the plugin `error`; exec bits only for this format (an exec bit alone runs
  nothing).
- **No git**: GitHub is reached only through its HTTPS API, `raw.githubusercontent.com` and `codeload.github.com` via
  `safeFetch` (https only, DNS pinned, redirects re-checked, codeload without redirects); `S/workspace/git.ts` keeps its
  read-only allowlist (`GIT_ALLOWED_COMMANDS`, `git.ts:100`) and the spawn allowlist stays at 3 modules.
- **The import plan lives on the server**: the browser filters a picked folder with the shared allowlist and uploads;
  the server re-checks the allowlist, plans, keeps payloads and secrets, and applies by `planId` + item keys only.
- **Project edits are user edits**: not journaled (`workspace_changes.chat_id` is NOT NULL), `workspace.changed` source
  `user`, no fresh auth and no idle rule, because nothing written there can run before a fresh trust approval and the
  agent can already write the same files.
- **Prompt hooks run inside the hook snapshot** as one more handler kind: their outcome comes from the shared
  `promptHookOutcome`, so the existing chat seams apply the effects; an answer never allows.
- **Trust hash stability**: `trustHashInput` keeps the v1 layout for items without `extra` (golden tests); only hooks
  with prompt or Claude handler fields hash as v2.
- **The argument base heuristic** keeps every v1.6 / v1.7 template meaning while new bodies get Claude's 0-based
  indexing.
- **`harnessAsked` is a flag**, not a new outcome: the replay map `OUTCOME_DECISIONS` (`S/chat/hooks.ts:235`) stays.
- **Docs** are written by D17 and C40 (API.md) in P12-0a and reconciled by W12.15 in P12-B; P12-A agents never edit
  docs. **Feature e2e specs** are written in P12-B by W12.14. **Every new web test id** is added by C46 in P12-0b,
  copied verbatim from UI.md 13.13; `W/utils/testids.ts` is frozen during P12-A.

Open points decided by D16 while writing this file (confirmed or changed by the coordinator at Gate P12-0a):

1. **`statusMessage` reaches the activity line** (the plan says "activity label" and probe 10 checks it, but names no
   carrier): C40 adds `activityDataSchema.label?: string` (≤ 200; `SH/chat.ts:202`, the transient `data-activity` part),
   C43 adds `HookSnapshot.statusMessage(event, target?): string | null` (the first matching handler's `statusMessage`),
   C44 writes it into the `data-activity` it emits before hooks run, C46 widens `useChatSession().hookActivity` with
   `label: string | null`, W12.13 shows it instead of "Running hook…". State at the end of P12-0a: C40's `SH/chat.ts`
   has no `label` yet, so the coordinator adds the optional field at Gate P12-0a (else it is the first CCR of P12-0b).
2. **The trust item shows prompt hooks and handler fields**: done by C40 — `trustHookDetailSchema`
   (`SH/schemas/project-trust.ts`) gained `type?`, `prompt?`, `model?`, `continueOnBlock?`, `args?`, `async?`, `if?` and
   `statusMessage?`; `command` stays a string (empty for a prompt hook, like the `hooks` rows). The trust dialog shows
   exactly what runs (W12.5 fills the fields, W12.13 renders them).
3. **The web event and session wiring has no P12-A owner**, so C46 owns
   `W/composables/{useClaudeImport,useServerEvents,useChatSession}*` in P12-0b and completes them: `marketplace.changed`
   and `plugin.changed` → the marketplaces store (`applyEvent`), `refreshLoaded()` of the marketplaces store on
   reconnect, the `hookActivity` label (point 1). Nobody owns them in P12-A (a change is a CCR).
4. **`W/pages/settings/customize.vue` in P12-0b** belongs to C46 (the frozen import query `?import=claude` and the
   `ClaudeImportDialog` mount); W12.10 owns it in P12-A.
5. **`S/chat/types.ts` in P12-0b** belongs to C43 (the Phase 11 precedent: C36); C44's `S/chat/**` glob excludes it in
   prose.
6. **C43 also writes `S/plugins/claude/{types,detect,skill-files}.ts`** (types + two stubs with final signatures:
   `detectPluginLayout(paths)` → `{ format, prefix } | null` and the skill-file list / read helper), because the plan
   fixes three cross-agent contracts in P12-0b that live there: detection (W12.1's host for hand-placed folders and
   W12.2's installer for archives), the skill-files helper (W12.1 → W12.7) and `ClaudePluginRead`. W12.1 implements them
   in P12-A; `types.ts` stays frozen.
7. **No overlapping P12-A owners**: W12.7's catalog glob is the explicit list of the stems of
   `S/services/customizations/` other than `plugins*` (+ the new stems `import*` and `qualified*`), so W12.1 alone owns
   `plugins*`. A new file outside an agent's globs is a CCR (added to the wave file at the gate).
8. **Bare-alias resolution lives in the catalog** (W12.7): the snapshot getters `agent` / `skill` / `command` /
   `style(name)` and `resolveCommand` accept a qualified name exactly and a bare name by the plan's rule; a harness
   plugin's `<pluginId>:<name>` resolves to its bare entry. The registry (W12.1) stores exact names and checks the owner
   prefix. No interface member is added.
9. **Where the new definition keys apply**: agent `disallowedTools`, `maxTurns` and the `skills` preload in the
   sub-agent code (W12.6, behind C44's `subagent/host.ts` seam); command / skill `disallowed-tools`, skill
   `allowed-tools` / `model`, `when_to_use`, `arguments`, the argument base and fork skills in the catalog and command
   code (W12.7); `resolveClaudeModel` (`S/chat/model-aliases.ts`, C44 stub, W12.7) is the one resolver used by W12.5
   (prompt-hook models), W12.6 (child models) and W12.7 (commands, skills).
10. **The fork skill seam**: C44 widens `AgentRunScope.loadSkill(name, signal, options?: { file?: string, toolCallId?:
    string })` (`S/chat/agent-scope.ts`); a fork skill's report comes back as the skill output's `content` (no new DTO
    field).
11. **The settings splice re-serializes JSON**: `PUT …/definitions/file { hooks }` keeps the values of every other key
    and the key order, writes `JSON.stringify(value, null, 2)` + a newline (the formatting of other keys may change;
    their trust hashes do not, they are canonical); documented by W12.15.
12. **e2e and the real home folder** (changed by the coordinator at Gate P12-0a): `start:e2e` sets `HF_CLAUDE_HOME=0`,
    so the e2e server can never read the machine's `~/.claude` (the home route answers `{ available: false, reason:
    'disabled' }`); W12.14 tests the disabled scan option as is and, to show the available state, stubs
    `GET /api/claude-import/home` with `page.route` (a fixed `{ available: true, path: '/home/node/.claude' }`) and
    never sends a real scan (a stubbed `POST /api/claude-import/scan` when the flow needs one).
13. **Selecting `mock:prompt-hook`**: probes and e2e set `hookModelRef` (or the handler's `model`) to
    `mock:prompt-hook`; the mock provider's `smallModelId` stays `echo` (titles depend on it), so a prompt hook without
    a model runs on `mock:echo`, whose answer is not a verdict (a non-blocking error: the "invalid answer" path).
14. **Untrusted plugin hook rows** come from harness manifests' `contributes.hooks` (the plan); an untrusted Claude
    plugin's hooks are shown on its plugin page (the inspection / detail `claude.executables`), not in `GET /hooks`
    (backlog). The web shows them as `hook-row[data-source=plugin][data-state=pending]` with the badge "Plugin not
    trusted" (UI.md 13.13; no new state value).
15. **The reserved marketplace names** are refused with the answer API.md fixes (proposed: 400 `validation_error` on
    `['source']`; the conflict reasons stay at 15).
16. **`defaultEnabled: false`** is applied by the installer (W12.2): the plugin is installed disabled unless the request
    sets `enable`.
17. **Slots**: P12-0a C40 k2, C41 k3, C42 k4, D16 k1, D17 k5 (no server), K3S :8898 (the `.tmp/v17` build); P12-0b C43
    k3, C44 k5, C45 k6, C46 k4, G12B :8898 after the coordinator's build; P12-A W12.1 – W12.7 k1 – k7 (web agents run no
    server), G12P on :8896 – :8898 only after the coordinator's build signal; W12.14 e2e 8891.
18. **Regression copies**: the coordinator copies `.tmp/gates/P11-A/{probe,lib,s-*}.mjs` to
    `.tmp/gates/P12-A/p11a-regression/` (pins relaxed: `pluginApiVersion` ≥ 1.5.0, the migration count ≥ 9 with `0008`
    checked by tag) and keeps `.tmp/gates/P11-A/p10a-regression.mjs` (its pin `≥ 8` still holds) as the P10-A copy.
19. **Frozen files inside P12-A globs**: `S/plugins/install/testing.ts` (C45) and `S/plugins/marketplaces/types.ts`
    (C43) match W12.2's globs, `S/plugins/claude/types.ts` W12.1's, `S/services/data/{types,references}*` W12.3's, every
    `types.ts` of the service folders its owner's: they stay frozen (prose exceptions, like Phase 11).
20. **The P12-0a ownership file** is the coordinator's `.tmp/waves/P12-0a.json` (C40's `packages/shared/src/**` glob
    also matches the C41 / C42 files and the coordinator's skeletons: audit warnings, owned as listed in prose).
21. **The project MCP dialog** (decided by the coordinator with D17): its "Edit .mcp.json…" action
    (`data-action="edit-mcp-json"`, also in the empty state, where it creates the file) opens the project file editor
    with kind `mcp`, so W12.13 owns `W/components/projects/{trust,mcp}/**` in P12-A and C46 also covers
    `W/components/projects/mcp/**` in P12-0b (the stub and test-id changes).
22. **Web states documented by D17** (binding): a hook record with `harnessAsked` shows `data-state="still-asks"` on the
    existing `hook-note` / `tool-row-hook` (no new outcome value); untrusted plugin hook rows are `data-state="pending"`
    with source `plugin` (open point 14); the project file editor has no run-active state; the Hook model sits in
    Settings → General → Agent next to the "Claude model names" selects (`settings-model-alias`, `data-name`); the
    `CLAUDE.md` mode is Append / Replace / Skip (`claude-import-instructions-mode`); project files can also be created
    from a Customize section heading (`data-action="new-project-file"`, `project-file-editor` `data-mode="new"`) and
    deleted (`customization-delete` on project rows).

### Deviations found while building (P12-0a – P12-B)

Recorded by the coordinator from the agent reports (`.tmp/waves/P12-*-notes.md`) and the gates; the code and the
reconciled docs (W12.15) follow these, not the task text further down.

- **Gate P12-0a** (coordinator):
  - Import plan statuses (C41): a reserved, builtin or duplicate definition name is `conflict` with the actions **skip
    / rename** (the plan said "rename only"); an MCP server whose id exists with another fingerprint is `conflict`
    with skip / overwrite / rename. W12.3 builds `ClaudeImportBaseline.hooks` with `claudeImportHookIdentity` and the MCP
    fingerprints with `claudeImportMcpFingerprint` (else no status matches); `planClaudeImport` compares contents byte
    for byte (`digest` unused).
  - Open point 1 applied: `activityDataSchema.label?` (≤ 200) added to `SH/chat.ts` by the coordinator.
  - Open point 12 changed: `start:e2e` sets `HF_CLAUDE_HOME=0` (see the point).
  - Open point 21: W12.13 owns `W/components/projects/{trust,mcp}/**`.
  - Script files named in exec-form `args` are not trust refs yet (C42): **W12.5** adds them to the hook's trust item.
  - An `if` rule on a shell command the parser cannot split counts as a match (the hook runs: fail-safe for guards).
  - C42: a legacy template with a literal `$0` (e.g. an awk snippet) next to `$1` switches to 0-based (the plan's
    rule; documented by W12.15).
  - The five new hook event descriptions in `W/components/settings/customize/hooks.ts` are placeholders: **W12.12**.
  - The multipart `pluginInstall.inspect` route reads only the `file` part (C40): **W12.2** reads `format` too.
  - `createTestApp` must set a temp `HF_CLAUDE_HOME`: **C43**.
  - e2e: `core/customize.spec.ts` "Import… reads a Claude Code file with notes" updated by the coordinator (`color` is
    read now, the model-alias note reads "Claude model names use the model aliases of the settings").
  - **Pre-existing flake** (reproduced on the v1.7 build: 1 of 6 runs): `mobile/agent.spec.ts:191` "the dock fits with a
    running background agent" — after the row's Stop the server answers `aborted` (logged, 200 in 2 ms) but the row
    keeps `data-state="running"` for 5 s. **W12.13** owns `W/components/chat/background/**` and
    `W/stores/background-tasks*` in P12-A and fixes it (find why the stop answer / `task.changed` does not reach the
    row; a regression test that stops a task while progress events arrive); W12.14 runs the spec 10× after the fix.
- **Gate P12-0b** (coordinator):
  - G12B upgrade probe 95/98: the v1.8-only project `prompt` hook is not listed yet (server reads project hooks without
    `{ prompts: true }`); **W12.5** lists project prompt hooks as v2 trust items; the check moves to G12P (upgrade group)
    and the final upgrade. Seam probe 76/76.
  - `HF_TEST_REMOTE_URL`: an invalid value fails the boot even without `HF_MOCK_PROVIDER=1`; a valid loopback value without
    the flag is ignored with a warning (C43; consistent with DECISIONS).
  - CCRs applied: `hookModelText` gives feedback for a blocked `PostToolUseFailure` (C44); `renderCommandExpansion(…,
    options?)` computes one argument base for the whole body (C44); `hookEntrySchema` gains `position?` for project hooks
    (C46; W12.5 fills it, W12.12 uses it).
  - C46 deviations (UI.md won; W12.15 updates UI.md 10.9 / 11.9): see `.tmp/waves/P12-0b-notes.md` (C46).
  - `examples.test.ts`: the registered hook commands of `hook-pack` carry `env: {}` and `prompts: []`.

## Rules for every Phase 12 agent

This section is the canonical copy of the agent rules (`.tmp/p12-designs/agent-rules.md` was its draft). The Phase 11
rules apply, renamed (P11-* → P12-*, W11.14 → W12.15; the ports :3000 / :8787 / :8899 / :8896 – :8898 are the
coordinator's; your slot is `879k`, e2e `889k`); the Phase 12 additions follow them.

- Read `AGENT.md` fully, your section of this file (or your task prompt) and the docs it names. Paths: `S` =
  `apps/server/src`, `W` = `apps/web/app`, `SH` = `packages/shared/src`, `SDK` = `packages/plugin-sdk/src`. Stay inside
  your OWNED globs; the FREEZE list in AGENT.md overrides any owned glob.
- Never run: package installs or CLIs (`pnpm add`, `npx`, `drizzle-kit`, `nuxi`, `shadcn-vue`), git write commands on
  this repository, `nuxt dev` / `nuxt build` / `nuxt prepare`, servers on :3000 / :8787 / :8899 / :8896 – :8898, **never
  `pnpm test:live`** (the repository `.env` may hold real keys and the suite makes paid calls), and never `pnpm
  key:rotate` / `rotate-key` against the repository's `data/` (tests use temp data directories). Existing scripts are
  allowed (`pnpm -F <pkg> test`, `pnpm typecheck`, `pnpm -F @harness-forge/web typecheck:fast`, `pnpm check:english`,
  `pnpm exec eslint --fix <your files>`).
- Shell hygiene in your own commands: never `cd` (use absolute paths, `pnpm -C <abs>`, `git -C <abs>`); never inline `sh
  -c` strings (a security hook blocks them: use script files or argument arrays); zsh does not word-split `$var` (use
  `bash -c` when you need it); `rm -rf` is denied (move things aside with `mv` under `.tmp/`).
- Your own server uses your slot: `HF_PORT=879k HF_DATA_DIR=.tmp/<agent-id>`; e2e agents use `889k` (k ≠ 9) with
  `E2E_BASE_URL`. Stop every process you started (shell children, hook, MCP and fake-remote fixture children and
  background children included; kill by port) before reporting. Prefer `createTestApp()` + `app.request()`.
- **Temp folders**: tests create workspaces, roots, repositories, definition and settings folders, fake home folders,
  plugin and marketplace folders and data directories with `realpath(await mkdtemp(join(tmpdir(), 'hf-')))` (macOS
  `/var` is a link to `/private/var`, so an un-resolved path fails every containment check) and remove them afterwards;
  never the repository's `data/`, `.tmp/e2e`, a seed folder or a real project folder.
- **Shell tests** use POSIX `sh` syntax only (CI runs Linux, where `/bin/sh` may be `dash`; Docker has busybox): no
  bash-only features (`[[ … ]]`, arrays, `$'…'`, `source`), generous time margins, and skipped on Windows
  (`process.platform === 'win32'`).
- **Never spawn a shell string outside `S/workspace/shell.ts`**: no `spawn(…, { shell: true })`, `exec`, `execSync` or
  `child_process` with a command string anywhere else. **git runs only through `S/workspace/git.ts`** (argument arrays,
  `shell: false`, its scrubbed environment and `-c` overrides; paths after `--`, resolved through `resolveWorkspacePath`
  first). The MCP stdio transport keeps its own argument-array spawn. `S/security/process-spawn.test.ts` enforces the
  list (3 modules).
- **Git in tests**: never a git write command on the harness-forge repository. Tests run `git init` inside their own
  `realpath(mkdtemp())` folder, set the author with `-c user.name=… -c user.email=…`, point `HOME` / `GIT_CONFIG_GLOBAL`
  at the temp folder and use `describe.skipIf(!hasGit())`.
- **Every path a workspace tool, a mention, a definition read or write, a settings or `.mcp.json` read or write, a
  referenced script, an `@path` reference, a skill file listing or read, a plan file or a Remember append touches**
  resolves through the frozen `resolveWorkspacePath` (`S/workspace/paths.ts`) and the sensitive-path rules
  (`S/workspace/sensitive.ts`); no `fs` call on a model-supplied, user-supplied or file-supplied path without it (a
  plugin skill folder uses the plugin's realpath as the root).
- **Checkpoint blobs and journal rows only through the checkpoint store** (`S/services/checkpoints/**`); sub-agent and
  background sub-agent writes go through the same `journaledWrite` under the launching message's run scope; plan files
  through `journaledWrite`, Remember appends through `deps.checkpoints.journal(...)`. Hook processes, `!` spans and
  project definition files saved from the UI (`writeWithoutRecording`) are not journaled (documented).
- Every new text or JSON column goes into `REFERENCE_SOURCES` or `UNSCANNED_COLUMNS` (`S/services/data/references.ts`;
  Phase 12 adds `marketplaces.*`, `plugins.format` / `origin` and `hooks.type` / `prompt` / `model` / `options`,
  classified by C43).
- The shell command matcher (`SH/util/shell-command.ts`) fails closed: anything it cannot tokenize asks; imported
  `Bash(...)` rules and hook `if` rules go through it too.
- **Logging**: never log key material, secret values, file contents, diffs, tool inputs or outputs, shell commands,
  compaction summaries, steer / todo / plan texts, sub-agent prompts or outputs, mention queries, definition or skill
  bodies, command expansions, background prompts or reports or Remember texts at `info` (`debug` only, redacted;
  diagnostics carry project-relative paths and never file contents); the Phase 11 and Phase 12 additions below.
- Timers are `unref()`-ed and cleared in `stop()`; tests use fake timers (no real sleep over 2 s; hook and prompt-hook
  timeouts in tests are small per-handler timeouts, never the 60 s / 30 s defaults).
- Contracts: DTOs and route keys only from `@harness-forge/shared`, plugin shapes only from `@harness-forge/plugin-sdk`;
  server services only through the frozen `types.ts` interfaces. A missing member, a contract change, a frozen-file edit
  or a **new test id** is a CCR in your report (file, current shape, proposed shape, reason) plus a local adapter so you
  can keep working.
- New components are imported explicitly by path (`import MarketplaceEntryRow from './MarketplaceEntryRow.vue'`): the
  coordinator runs `nuxi prepare` only at the gates, so auto-import types do not know files created mid-wave.
- The props, emits and root test ids of the P12-0b stub components and the signatures of the new stores, modules and
  `useChatSession` / `useServerEvents` / `useClaudeImport` additions are frozen after P12-0b: implement behind them; a
  change is a CCR.
- No doc edits in P12-A: write "For W12.15" notes (facts, deviations, suspected doc errors) into your report.
- Web unit tests: Nuxt composables come through a local `nuxt-imports.ts` that tests `vi.mock`; every password prompt
  goes through `useFreshAuth()` (UI.md 8.4).
- e2e uses only `.tmp/e2e/workspaces/*` for project folders; fake homes, plugin folders and marketplace folders of e2e
  specs live in `realpath(mkdtemp())` folders outside the repository.
- Verify before reporting — server: `pnpm -F @harness-forge/server test` · `pnpm typecheck`; shared: `pnpm -F
  @harness-forge/shared test`; plugin SDK: `pnpm -F @harness-forge/plugin-sdk test`; web: `pnpm -F @harness-forge/web
  test` · `pnpm -F @harness-forge/web typecheck:fast`; all: `pnpm check:english`; lint your files with `pnpm exec eslint
  --fix <your files>`.
- Report ≤ 300 words in the AGENT.md format (tasks, files, commands + results, CCRs, dependency requests, open issues,
  suggested ROADMAP updates, "For W12.15" notes). Commits are made only by the coordinator; never add AI attribution
  anywhere.

Carried over from Phase 9:

- **Only mock models** in tests (`MockLanguageModelV4`, `simulateReadableStream` from `ai/test`, the `mock:*` provider);
  catalog, command, skill, hook, prompt-hook and background code never resolves a real provider (or a key from the
  environment) in tests. Never `pnpm test:live`.
- **Verify AI SDK names** in `node_modules/.pnpm/ai@7.0.127_zod@4.6.5/node_modules/ai/dist/index.d.ts` (and
  `@ai-sdk/provider-utils` `dist/index.d.ts`) before use: `streamText({ instructions, messages, tools, activeTools,
  prepareStep, toolApproval, stopWhen, abortSignal })` (`stopWhen` is `Arrayable<StopCondition>`), the `prepareStep`
  result fields, async-generator `execute`, `convertToModelMessages` options, `UIMessageStreamWriter`, transient data
  chunks; Phase 12 adds `generateText` for prompt hooks (the `S/chat/title.ts` call is the precedent: reasoning off,
  `maxRetries: 0`, an output-token cap, an abort signal).
- **History-derived state** (`findCompaction`, `compactionMarkers`, `splitSteers`, `latestTodos`, `splitTaskResults`,
  `taskResultText`, `splitHooks`, `hookModelText`, `isHookCarrier`, `hookChainLength`, `sessionStartSource`) only from
  `SH/util/agent-state.ts`; mention parsing / ranking only from `SH/util/mentions.ts`; no local re-implementation on the
  server or the web.
- **Plan mode is enforced on the server** (tool set + approval), never only in the UI; `allowed-tools` keeps
  `exit_plan_mode` in plan mode; a hook `allow` (PreToolUse or PermissionRequest) never skips the plan-mode rules.
- **Sub-agents never create approval requests** (foreground and background): a tool that would ask is not offered or is
  denied (a hook `ask` in a child is a denial; `PermissionRequest` runs for the main agent only); depth 1; `task` and
  `skill` are absent from the child tool set.
- **In-memory state** (the queue, the sub-agent semaphores, the file index, the catalog cache, the background inbox and
  snapshots, the hooks and project-config caches, the hook run log, the project MCP runtimes, the prompt-hook call
  limiter, the async hook processes, the import plans, the tree-hash cache) is keyed by chat / project / plugin,
  bounded, cleared on chat / project delete, key rotation and shutdown; timers `unref()`.
- **Feature agents implement behind the P12-0b seams**
  (`S/chat/{pipeline,tools,approval,steps,markers,model-history,agent-scope,hooks}.ts`, `S/chat/subagent/host.ts`,
  `S/workspace/shell.ts`, `S/mcp/stdio-transport.ts`, the frozen service types and the stub modules).

Carried over from Phase 10:

- **Project definition files are untrusted input** (`.harness/{agents,commands,skills,output-styles}`, `.claude/{…}`):
  their `tools` / `allowed-tools` / `disallowedTools` / `disallowed-tools` only restrict (never add a tool), they never
  change the mode, grant an approval, create a tool override or a shell rule; `model` resolves only to providers the
  user configured (Claude aliases through `modelAliases`). Prompt injection through bodies is accepted like `AGENTS.md`
  today. The only exception is an **approved** executable item (a hook, a `.mcp.json` server, the `!` spans of a command
  file).
- **Reading project definitions**: every read through `resolveWorkspacePath` / `openWorkspaceFile` (no links anywhere on
  the path, regular files only, binary skipped, byte caps before parsing, count / depth caps, sensitive rules).
  User-level definitions and hooks live in the DB only: `~/.harness` is never read, and since Phase 12 the **only**
  reader of `~/.claude` is the explicit import scan (an allowlist at `HF_CLAUDE_HOME`, below).
- **Parsing only with the shared helpers** (`SH/util/{definitions,arguments,tool-names}.ts`,
  `SH/util/{hooks,trust,mcp-config,command-template,output-styles}.ts` and now
  `SH/util/{claude-plugins,claude-import,claude-permissions}.ts`); `yaml` is imported only by `SH/util/definitions.ts`;
  verify its API in `node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/*.d.ts`.
- **Background tasks** never create approvals; are bounded (3 per chat, 10 per server, 30 min, `subagentMaxSteps`); are
  stopped on chat / project delete, delete-all, key rotation and shutdown (a restart leaves `aborted`), **never by the
  chat's Stop**; are delivered exactly once (`delivered_at`); their writes are journaled under the launching message; a
  running task makes its project busy (409 `run-active` for rewind / revert / undo / project delete / chat move /
  version delete; a branch switch stays allowed; project definition edits are not refused).
- **Writes**: plan files and `AGENTS.md` / `CLAUDE.md` appends go only through the journal (`journaledWrite` /
  `checkpoints.journal(...)`) and the file lock; hidden-path write policies (`always`) are never relaxed, so the agent
  can never silently rewrite `.harness/**`, `.claude/**` or `.mcp.json` (a hook `allow` does not skip them either).
- **Parts and their consumers**: `data-task-result`, `tool-skill` and `data-hook` keep their consumers; Phase 12 adds no
  part type (the `data-hook` additions `hooks[].kind` / `model` and `harnessAsked` are optional and read by the owners
  of `HookNote` / `ToolHookBadge`, W12.13).
- The mock models (`mock:agents`, `mock:background`, `mock:hooks` and now `mock:prompt-hook`) are frozen after P12-0b;
  PROVIDERS.md 8 is the probe contract.

Carried over from Phase 11:

- **Repository content is untrusted**: `.claude` / `.harness` `settings.json` and `settings.local.json` (only the
  `hooks` key is read), `.mcp.json`, output styles, command and skill files. Read them only through
  `resolveWorkspacePath` / `openWorkspaceFile` (no links anywhere on the path, regular files only, byte caps before
  `JSON.parse` / YAML, count caps, diagnostics instead of errors).
- **Executable items run only after hash approval** (project hooks incl. prompt hooks, `.mcp.json` servers incl. http /
  sse, command files with `` !`cmd` `` spans): the sha256 of `trustHashInput(item)` covers the item **and the script
  files it references** and is re-checked right before every spawn or model call (verify-before-run); a missing approval
  means "pending" (never "ask at run time"); the approve and variables routes are `fresh` and tests prove 403 without a
  fresh login.
- **Never read `process.env`** for `.mcp.json`, imported or plugin MCP variables or to build a hook / MCP environment
  beyond `shellEnvironment` / `stdioEnvironment` + `HARNESS_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` (+ `HARNESS_PLUGIN_ROOT`
  / `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and `CLAUDE_PLUGIN_OPTION_<KEY>` for plugin hooks).
- **Hooks and `!` spans run only through `runShellCommand`** (with `input` / `env`; exec-form handlers through
  `execFormCommand` quoting, still `runShellCommand`); the spawn allowlist (`S/security/process-spawn.test.ts`) stays at
  3 modules; timeouts, Stop and shutdown kill process groups (async hooks included).
- **Kill switches**: the setting `hooksEnabled: false`, `HF_WORKSPACE_SHELL=0` (no shell string at all: no `shell` tool,
  no command hook, no `!` span) and `HF_SAFE_MODE` (no command hooks, no project MCP servers, no user plugins) block
  command hooks; `hooksEnabled: false` and `HF_SAFE_MODE` also block prompt hooks (`HF_WORKSPACE_SHELL=0` does not);
  plugin code hooks still run.
- **Hook scripts in tests** are POSIX `sh` files inside `realpath(mkdtemp())` projects or plugin folders, invoked as `sh
  <relative path>` (or exec form with `args`): never inline `sh -c` strings (a security hook blocks them in the
  coordinator's session), no `jq`, busybox-compatible (use `S/testing/hook-scripts.ts`); every spawned pid is dead at
  test end (assert it).
- **MCP tests** use loopback fixtures only (port 0; `example.invalid` for unreachable hosts; the stdio fixtures of
  `S/mcp/__fixtures__`); never `npx`, never a remote URL.
- **Logging**: never log at `info` hook stdin payloads, stdout / stderr, hook command strings, `!` commands or their
  output, `@file` contents, `.mcp.json` variable values or resolved env / args / headers; hook runs log only the event,
  source, label hash prefix, exit code, duration and outcome.
- **Continuation turns** (Stop hooks and prompt Stop hooks, origin `hook`) are capped (5 in a row) and never start while
  an approval is pending; a user Stop ends the chain.
- **Web**: never put `//` inside a component prop value in a template (vue-tsc 3.3.12 regression
  vuejs/language-tools#6240 corrupts the generated code; `W/components/template-literals.test.ts` guards it); URLs go
  into script constants (marketplace and GitHub URLs included).

Phase 12 additions:

- **Never read the real `~/.claude` or `~/.claude.json`**: tests use a temp `HF_CLAUDE_HOME` built by
  `S/testing/claude-fixtures.ts` in `realpath(mkdtemp())` (probes also set a temp `HOME` with a sentinel); the scan
  reads only the allowlist (`agents/*.md`, `commands/**/*.md` ≤ 3 levels, `skills/<name>/SKILL.md`,
  `output-styles/*.md`, `settings.json`, `CLAUDE.md`, `.claude.json`); never `.credentials.json`, `projects/`,
  `history.jsonl`, `todos/`, `shell-snapshots/`, `statsig/`, `plugins/`, `settings.local.json`; from `.claude.json` only
  `mcpServers` and `projects[*].mcpServers` are kept.
- **Never fetch real GitHub / codeload / raw / npm / archive hosts**: unit tests inject `safeFetch`
  (`createFakeSafeFetch`, the `InstallerOptions` / `MarketplaceServiceOptions` overrides); probes use
  `HF_TEST_REMOTE_URL` (only with `HF_MOCK_PROVIDER=1`, `http://127.0.0.1:<port>`) and the loopback fake in
  `S/testing/fake-remote.ts`.
- **Never commit or create `.claude/`, `.harness/`, `.claude-plugin/` or `.mcp.json` inside the repository** (Claude
  Code discovers nested `.claude/` folders and would configure the coordinator's session): fixtures are built at test
  time in temp folders; seeds live under `.tmp/`; the only committed exception is
  `examples/plugins/claude-review-kit/.claude-plugin/plugin.json` (with inline `mcpServers`, no `.mcp.json`).
- **Archives go only through the installer's guards** (`checkEntryPath`, `EntryCollector`, exclusive writes,
  `verifyTree`); no git, no shell for downloads; marketplace JSON, Claude `plugin.json`, `hooks.json`, `.mcp.json` and
  `.claude.json` are untrusted input (byte caps before `JSON.parse`, diagnostics instead of errors).
- **Claude plugins that run anything** (command hooks, stdio MCP servers, `!` spans) need a whole-tree trust pin
  (`hf-claude-plugin/v1` hash); exec bits are kept only for the claude format; `bin/`, `.lsp.json`, `monitors/`,
  `themes/`, `workflows/` are never executed.
- **Variables**: `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SKILL_DIR}`,
  `${user_config.KEY}` are substituted only where the plan's variable table allows (`substitutePluginVariables`);
  `${user_config.*}` is refused in shell-form hooks; sensitive values never enter markdown bodies; **never
  `process.env`** for any substitution.
- **Saving a project file never approves** anything; every UI write goes through `resolveWorkspacePath` (rel equality,
  no links), the file lock and the `expectedSha256` check inside the lock; writes only under `.claude/`, `.harness/` or
  `.mcp.json`; settings files keep every key other than `hooks`.
- **Imported executables arrive turned off** (command hooks, `!` commands) unless the user enables them in the
  fresh-auth apply; secrets (env / header values) from the home folder stay in the server-side plan and never reach a
  DTO, a log or an error.
- **Prompt hooks**: the model answer is parsed only by `readPromptHookAnswer` and never grants a permission (`ok: true`
  decides nothing); calls are bounded (timeout, 8 server-wide); usage purpose `hook`; tests use `mock:prompt-hook` or
  `MockLanguageModelV4` only.
- **v1 trust hashes are byte-stable**: `trustHashInput` keeps the v1 layout for items without `extra` (golden tests);
  every approval of a v1.7 data folder must still match after the upgrade.
- **Qualified names** (`<pluginId>:<seg>…:<name>`) only through the shared helpers (`catalogNameSchema`,
  `qualifiedName`, `splitQualifiedName`); harness plugins keep bare names.
- **Logging**: never log at `info` imported file contents, hook commands, prompts or prompt-hook answers, `userConfig`
  values, tokens, env / header values, marketplace JSON or transcript lines; marketplace logs carry only id, name, repo
  and a 12-char sha; import logs carry the source, counts and duration (the root path at `debug` only).
- **Hot files have one owner in P12-A**: `S/plugins/host.ts`, `S/registry/**` → W12.1; `S/plugins/install/index.ts` →
  W12.2; `S/services/data/restore.ts` → W12.3; `S/services/hooks/snapshot.ts` → W12.5; `S/chat/{index,queue,steer}.ts`,
  `subagent/**` (not `host.ts`) → W12.6; `S/chat/{commands,prepare,skills,params}.ts` → W12.7; `InstallDialog.vue` →
  W12.9; `CustomizeSettings.vue` → W12.11; `HookEditor.vue` → W12.12; `ProjectTrustDialog.vue`, `ToolPart.vue`,
  `TaskBlock.vue`, `SlashMenu.vue`, `ProjectMcpDialog.vue` → W12.13.
  `S/chat/{hooks,approval,tools,steps,pipeline,model-history,agent-scope}.ts` and `S/chat/subagent/host.ts` are complete
  and frozen after P12-0b (`markers.ts` stays frozen as before; a change is a CCR).
- **No doc edits in P12-A**: write "For W12.15" notes into your report.

## FREEZE in Phase 12

In force since earlier phases (AGENT.md): `packages/*/src`, `S/app.ts`, `S/db/schema.ts`, `apps/server/drizzle/**`,
every `*/types.ts` under `S`, `S/builtin-plugins/index.ts`, `W/layouts/**`, store signatures in `W/stores/**`,
`apps/web/nuxt.config.ts`, every `package.json` and config file, `W/components/{ui,ai-elements}/**`, the CSS design
tokens in `W/assets/css/main.css`, `W/utils/testids.ts` (Phase 5), the Phase 5 – 10 additions (see AGENT.md) and the
Phase 11 additions (`S/services/{hooks,project-config,project-trust}/types.ts`, `S/mcp/types.ts`, the P11-0b versions of
`S/types.ts`, `S/chat/types.ts`, `S/registry/types.ts` and the deps start / stop order,
`S/chat/{pipeline,tools,approval,steps,model-history,agent-scope,hooks}.ts`, `S/chat/subagent/host.ts`, the signatures
of the P11-0b chat stubs, `S/workspace/shell.ts`, `S/mcp/stdio-transport.ts`,
`S/builtin-plugins/{index.ts,core-agent/**}` incl. the builtin output styles, the mock models incl. `mock:hooks`,
`SH/util/{hooks,trust,mcp-config,command-template,output-styles,definitions,agent-state}.ts`, plugin SDK 1.5.0 and its
template mirror, the props / emits / root test ids of the P11-0b stub components, the `hooks`, `project-trust` and
`project-mcp` stores, the pure-module signatures, the `useChatSession` additions, the Customize tab query and the Phase
11 test ids).

P12-0a and P12-0b open the frozen files **only** for their named owners:

- P12-0a: K1 — `AGENT.md`, `docs/DECISIONS.md`, `docs/ROADMAP.md`; K2 — nothing (no new dependency: the package files
  and the lockfile stay closed); the coordinator — the contract skeletons
  `SH/util/{claude-plugins,claude-import,claude-permissions}.ts` and `SH/index.ts` (exports), and at the gate
  `examples/plugins/*/harness-forge.d.ts` (regenerated for 1.6.0); C40 — `SH/**` (not the C41 / C42 files, not
  `SH/index.ts`: export lines are requested in its report), `SDK/**`, `S/app.ts`, the template mirror
  `S/plugins/templates/sdk-types.ts` (and the compile fixes it lists: the `catalogNameSchema` widening and the
  `PluginSource` values reach web maps, slash / customize / share code); C41 —
  `SH/util/{claude-plugins,claude-import,claude-permissions}{,.test}.ts` (complete); C42 —
  `SH/util/{hooks,trust,definitions,arguments,tool-names}{,.test}.ts` (complete) and the compile fixes its hook-event
  and definition-field changes force.
- P12-0b: K3 — `S/db/schema.ts` (`marketplaces`, `plugins.format` / `origin`, `hooks.type` / `prompt` / `model` /
  `options`, `UsagePurpose` + `hook`, `TABLE_NAMES` 23) + `apps/server/drizzle/**`; C43 — `S/types.ts`
  (`AppServices.{marketplaces, claudeImport, projectDefinitions}`), `S/deps.ts` (factories, the stop order), `S/env.ts`
  (`HF_CLAUDE_HOME`, `HF_TEST_REMOTE_URL`), `S/main.ts`, `S/chat/types.ts`, `S/plugins/types.ts` (`PluginRecord.format`
  / `origin`, `inspectDirectory` options), `S/registry/types.ts` (`HookCommandsRegistration.env?` / `prompts`,
  `McpServerRegistry.register(…, { claudeName? })`), `S/services/{hooks,customizations}/types.ts` (`importPersonal`,
  `sessionEnd`, `HookRunInput` additions, `HookSnapshot.statusMessage`, `importDefinitions`,
  `CustomizationRestoreResult.turnedOff`), the new `S/plugins/marketplaces/types.ts`,
  `S/services/{claude-import,project-definitions}/types.ts` and `S/plugins/claude/types.ts`,
  `S/services/data/references*`, `Dockerfile`; C44 —
  `S/chat/{hooks,approval,tools,steps,pipeline,model-history,agent-scope}.ts`, `S/chat/subagent/host.ts`,
  `S/chat/compaction/{guard,stream}.ts` (call sites); C45 — `S/builtin-plugins/{index,index.test}.ts`, the mock models
  (`S/builtin-plugins/mock/**`), `S/security/ssrf*`, `S/plugins/install/testing.ts`; C46 — `W/utils/testids.ts`, the
  store signatures of `W/stores/{customizations,hooks,plugins,ui}.ts` and the new `marketplaces` store, the prop / emit
  additions of the earlier stub and hot components it touches (`InstallDialog` → `InstallReview`, `HookEditor` (`mode:
  'project'`, `target`), `HookRow`, `CustomizationRow`, `CustomizationViewer` (`edit`), `ToolHookBadge`, `HookNote`,
  `TaskBlock`, `InspectPreview`, `PluginCard`, `DataImportResultPanel`, `ProjectMcpDialog` (Edit .mcp.json…)), the
  `useChatSession` / `useServerEvents` additions, the frozen-signature types of plan section 8.

Added to the freeze after Gate P12-0b:

- the new `S/plugins/marketplaces/types.ts`, `S/services/{claude-import,project-definitions}/types.ts` and
  `S/plugins/claude/types.ts`; the P12-0b versions of `S/types.ts`, `S/chat/types.ts`, `S/plugins/types.ts`,
  `S/registry/types.ts`, `S/services/{hooks,customizations}/types.ts` and the deps start / stop order;
- `S/chat/{hooks,approval,tools,steps,pipeline,model-history,agent-scope}.ts` and `S/chat/subagent/host.ts` (complete,
  C44) and the signatures of the C44 stubs (`resolveClaudeModel` in `S/chat/model-aliases.ts`, the widened
  `AgentRunScope.loadSkill`, the `expandArguments` options at the call sites, the `sessionEnd` call in the chat delete
  route, the PostCompact call sites in `compaction/{guard,stream}.ts`);
- the signatures of the C43 stubs (`createMarketplaceService`, `createClaudeImportService`,
  `createProjectDefinitionsService`, `detectPluginLayout`, the skill-files helper) and the `createTestApp` options;
- the mock model `mock:prompt-hook` (PROVIDERS.md 8), the fake remote (`S/testing/fake-remote.ts`,
  `createFakeSafeFetch`, `githubZipOf`), the fixture builders (`S/testing/claude-fixtures.ts`), the `HF_TEST_REMOTE_URL`
  routing in `S/security/ssrf.ts`;
- `SH/util/{claude-plugins,claude-import,claude-permissions,hooks,trust,definitions,arguments,tool-names}.ts` (complete,
  C41 / C42; a behavior change after the gate is a CCR); the plugin SDK 1.6.0 and its template mirror;
- the props, emits and root test ids of the C46 stub components (`MarketplacesView`, `MarketplaceSuggestion`,
  `MarketplaceStrip`, `MarketplaceAddDialog`, `MarketplaceEntryRow`, `MarketplaceInstallDialog`, `InstallReview`,
  `PluginUpdateBanner`, `ClaudeImportDialog`, `ClaudeImportSource`, `ClaudeImportPreview`, `ClaudeImportGroup`,
  `ClaudeImportItem`, `ClaudeImportResult`, `ProjectFileEditor`) and the CCR props of section 8 of the plan;
- the `marketplaces` store, `useClaudeImport`, the pure-module signatures (`plugins/marketplaces/marketplaces.ts`,
  `settings/claude-import/claude-import.ts`, the additions to `plugins/install/install.ts`,
  `settings/customize/{customize,hooks}.ts`), the `useServerEvents` / `useChatSession` additions, the Customize import
  query (`?import=claude`), the Marketplaces route and its nav row, the Phase 12 test ids (UI.md 13.13) in
  `W/utils/testids.ts`.

No CCR is pre-approved for P12-A; the coordinator batches CCRs at Gate P12-A.

---

## Wave P12-00 — stabilization start (done)

1. **Design inputs (done)** — the six reports of the planning session extracted with `.tmp/p10-designs/extract.mjs` into
   `.tmp/p12-designs/{explore-catalog,explore-plugins,claude-formats,server-plugins,server-import,web-process}.md`, the
   approved plan copied to `plan.md`, the binding order and the known deviations written to `README.md`, the rules draft
   to `agent-rules.md`.
2. **Baseline (done)** — `git status --porcelain` → `pnpm check` on `b3fa452` green with 11787 tests → `git status
   --porcelain` again, identical (`.tmp/gates/P12-00/{status-before,check,status-after}.*`).
3. **Old build for the seed (done)** — `git worktree add .tmp/v17 b3fa452`, then `pnpm -C <abs>/.tmp/v17 install
   --frozen-lockfile` and `pnpm -C <abs>/.tmp/v17 build` (absolute paths, never `cd` into the worktree;
   `.tmp/gates/P12-00/v17-{install,build}.log`). The worktree stays at `b3fa452` (the real v1.7) after `main` moves.
4. **CI runners pinned (done)** — `runs-on: ubuntu-24.04` in `ci.yml` (four jobs), `audit.yml` and `live.yml` before
   `ubuntu-latest` moves to Ubuntu 26 (2026-10-19): Playwright `--with-deps` and the Docker job on a brand-new image
   would turn gates red for reasons outside this phase; actionlint 1.7.12 clean; commit `c89ca97` `ci: pin ubuntu-24.04
   runners`, pushed (this plan approved that push). The first CI run on `c89ca97` was red only in Audit
   (GHSA-pqg4-j6r4-53mv, shell-quote). Unpinning is in the backlog.
5. **Audit advisories (done)** — shell-quote (GHSA-pqg4-j6r4-53mv) fixed with a pnpm override, commit `bdc9348`
   `chore(deps): patch shell-quote (GHSA-pqg4-j6r4-53mv)` (`.tmp/gates/P12-00/install-shell-quote.log`); katex < 0.18.2
   through mermaid (low; mermaid pins `^0.16`) left as is; the six ignored advisories re-checked with the P8-00 decision
   rule: still unpatched, the ignores stay (the backlog line carries the re-check date 2026-10-06).
6. **Archive (done)** — the old `.tmp` content moved into `.tmp/_archive/` with `mv` (`e2e-old-*`, the `W11.*` agent
   folders, `e2e-W11.13*`, `upgrade-v13`, `upgrade-v14` (+ ids), `v16`, old `.old-*` copies); kept: `upgrade-v15`,
   `upgrade-v16` (+ ids), `gates/**`, `p*-designs`, `waves`, `release`, `e2e`, `v17` (the regression probes read them).
   The user deletes `.tmp/_archive` with one command.
7. **Memory** — the coordinator rewrites `harness-forge-state.md`: v1.7 pushed (`b3fa452`), the runners pinned
   (`c89ca97`); Phase 12 = Claude Code ecosystem; plan in `.tmp/p12-designs`; seed `.tmp/upgrade-v17`; gotchas: never
   `.claude/`, `.harness/`, `.claude-plugin/` or `.mcp.json` anywhere in the repository, never the real `~/.claude`,
   never real GitHub in tests, the regression copies of the P11-A probes.

---

## Wave P12-0a — decisions, contracts, docs

Five agents in one launch (C40, C41, C42, D16, D17) after K1, K2 and the contract skeletons; the K3 seed runs alongside
(agent K3S).

### Coordinator actions

- **K1 (done)** — `docs/DECISIONS.md`: ADR-053 … ADR-058; the amendment notes on ADR-008 (a third on-disk format, Claude
  Code plugins, read in place), ADR-017 (fresh auth for installing or updating a Claude plugin that runs anything, the
  home scan and the import apply; not for saving a project definition file), ADR-024 (marketplaces, Claude plugins,
  transcripts and import plans never in a backup; `customizations.turnedOff`), ADR-036 (UI saves are not journaled;
  `workspace.changed` source `user`), ADR-038 (imported `Bash(...)` rules become global shell rules through
  `parseShellRule`), ADR-043 (`SubagentStart`, `maxTurns`, `disallowedTools`, preloaded `skills`, fork skills), ADR-044
  (the import scan is the only home-folder reader; project files editable from the UI; qualified plugin names), ADR-045
  (the new command / skill keys, named arguments, the argument base rule, model aliases), ADR-048 (prompt hooks, 13
  events, the handler fields, `transcript_path`), ADR-049 (saving never approves; trust item v2), ADR-050 (`.mcp.json`
  editable from the UI; imported `~/.claude.json` servers) and ADR-052 (plugin API 1.6.0); the contract seed (see "Entry
  criteria"). `docs/ROADMAP.md`: the Phase 12 section (one box per agent) and the backlog (removed: `~/.claude` import,
  in-UI editing of project definition files, prompt hooks, `transcript_path`, the four Phase 11 leftovers; added: the
  out-of-scope list of "Goal"). `AGENT.md`: the "Plugin API 1.6.0" and "Claude Code ecosystem" facts, the repository
  rule (`.claude/`, `.harness/`, `.claude-plugin/`, `.mcp.json` anywhere; the `claude-review-kit` exception) and the
  Phase 12 freeze line.
- **K2 (done)** — no new dependency (justified in "Entry criteria"); a DEPENDENCY REQUEST from an agent is declined
  unless a gate proves the need; `start:e2e` is unchanged.
- **Contract skeletons (done)** — `SH/util/claude-plugins.ts` (`CLAUDE_PLUGIN_LIMITS`, `CLAUDE_PLUGIN_DIAGNOSTIC_CODES`,
  `ClaudePluginDiagnostic`, `ClaudePluginAuthor`, `CLAUDE_USER_CONFIG_TYPES`, `ClaudeUserConfigOption`,
  `ClaudeComponentPaths`, `ClaudeInlineCommand`, `ClaudePluginManifest`, `parseClaudePluginManifest`,
  `CLAUDE_ENTRY_SOURCE_KINDS`, `ClaudeEntrySource`, `ClaudeMarketplaceEntry`, `ClaudeMarketplace`,
  `parseMarketplaceJson`, `claudePluginId`, `mergeEntryOverlay`, `PluginVariables`, `substitutePluginVariables`,
  `userConfigToSettings`, `MarketplaceShorthand`, `parseMarketplaceShorthand`), `SH/util/claude-import.ts`
  (`CLAUDE_HOME_LIMITS`, `CLAUDE_JSON_PATH`, `isClaudeHomeImportPath`, `ClaudeHomeFile`, `CLAUDE_IMPORT_KINDS`,
  `CLAUDE_IMPORT_STATUSES`, `CLAUDE_IMPORT_ACTIONS`, `CLAUDE_IMPORT_WARNINGS`, `ClaudeImportDiagnostic`,
  `ClaudeImportPayload`, `ClaudeImportPlanItem`, `ClaudeImportBaseline`, `ClaudeImportPlanDraft`, `planClaudeImport`,
  `claudeImportItemKey`, `extractClaudeJsonMcpServers`), `SH/util/claude-permissions.ts` (`ClaudePermissionRule`,
  `parseClaudePermissionRule`, `SHELL_RULE_FROM_PERMISSION_REASONS`, `ShellRuleFromPermission`,
  `shellRuleFromPermission`, `toolNamesFromPermission`) and their three exports in `SH/index.ts`: the names and
  signatures are final (adding members is fine, a rename or a removal is a CCR), the bodies throw until C41 implements
  them. The util files never import `limits.ts` / `enums.ts` (the Phase 10 import cycle); `LIMITS` mirrors their limit
  constants (C40 pins the mirror).
- **K3 seed (background, agent K3S)** — the `.tmp/v17` build (`b3fa452`) on :8898 with `HF_MOCK_PROVIDER=1
  HF_OFFLINE=1`, `HF_DATA_DIR=.tmp/gates/P12-0b/seed-data` and `HF_WORKSPACE_ROOTS=<repo>/.tmp/gates/P12-0b/seed-roots`
  (outside the data dir, so a copy keeps a valid project path), driven by `.tmp/gates/P12-0b/seed-v17.mjs` (derived from
  `.tmp/gates/P11-0b/seed-v16.mjs`) and `run-seed.sh` / `check-seed.mjs` (bash script files, never inline `sh -c`):
  - the full v1.6 seed set (see Phase 11 "K3 seed");
  - the Phase 11 state v1.7 supports: a project's `.claude/settings.json` hooks approved with fresh auth (PreToolUse `sh
    .claude/hooks/guard.sh`, a PostToolUse hook, a Stop hook that blocks once), a `.mcp.json` stdio server (the
    dependency-free `mcp-min.mjs` copied into the project) with a per-project variable, a command file with `` !`echo
    seeded` `` run once (its frozen expansion stored); **one** item left pending (a second hook in
    `.harness/settings.json`); a personal hook (PreToolUse `Write`, an `sh` script in the project); personal and project
    output styles, a chat-level style, the project style; `examples/plugins/hook-pack` installed from its folder and
    trusted (fresh auth); a Stop-hook continuation turn (origin `hook`); `hooksEnabled` true;
  - project files with **v1.8-only keys** v1.7 ignores or reports (what v1.7 says is recorded in the ids file):
    `.claude/settings.json` with a `type: "prompt"` Stop hook (its prompt holds `[[ph:ok]]`) and a `SessionEnd` command
    hook (a sentinel script that must never run under v1.7 nor before approval under v1.8);
    `.claude/agents/reviewer2.md` (`disallowedTools: Bash`, `color: purple`, `maxTurns: 5`, `model: sonnet`);
    `.claude/skills/forked/SKILL.md` (`context: fork`, `agent: general`, `allowed-tools: Read`);
    `.claude/commands/args0.md` (`$0`, `$ARGUMENTS[1]`); `.claude/commands/args1.md` (legacy `$1` / `$2`, run once on
    v1.7 so its expansion is stored);
  - a **v1.7 backup zip** (the v1.7 `/api/data` export) holding a personal command with a `!` span →
    `.tmp/upgrade-v17-backup.zip` (sha256 recorded);
  - stop the server by port → `check-seed.mjs` (counts, the SessionEnd sentinel and any unapproved hook run absent,
    `integrity_check`) → copy to `.tmp/upgrade-v17/{data,roots}` (`cp -R` keeps links), the ids (chats, messages,
    projects, hooks, trust hashes, the plugin, styles, the backup sha256, the pending item, the v1.8-only files and what
    v1.7 reported) to `.tmp/upgrade-v17-ids.json`, `seed-summary.json` (never `.tmp/e2e`, which the gates migrate). No
    SQL plants: `0009` only creates a table and adds columns. No fake home, marketplace or Claude plugin folder is
    written here (the C45 builders make those later). **Probes never write into `seed-roots`**: a probe copies the roots
    and points `projects.path` at the copy by SQL before boot. Every later upgrade probe runs on a fresh copy of
    `.tmp/upgrade-v17`. `run-seed.sh` runs green twice in a row (the second run moves the first aside).
- Ownership file `.tmp/waves/P12-0a.json` (below).

### C40 contracts (k2)

- **Mission.** Write every shared contract of Phase 12, the plugin SDK 1.6.0, the twelve new routes as 501 stubs and
  `docs/API.md`, keeping `pnpm check` green (with the compile fixes the qualified names and the new plugin sources
  need).
- **Owned.** `SH/**` except the C41 files (`SH/util/{claude-plugins,claude-import,claude-permissions}{,.test}.ts`), the
  C42 files (`SH/util/{hooks,trust,definitions,arguments,tool-names}{,.test}.ts`) and `SH/index.ts` (the coordinator's:
  export lines go into the report); `SDK/**`; `S/plugins/templates/{sdk-types,templates.test}.ts`; `docs/API.md`;
  `S/app.ts`; the new 501 stubs `S/http/routes/{marketplaces,claude-import,project-definitions}.ts`;
  `S/testing/api-samples.ts`; the route-driven tests (`S/http/routes-mounted.test.ts`,
  `S/http/middleware/{session-auth,fresh-auth}.test.ts`,
  `S/security/{fresh-auth-routes,secret-leaks,request-guards}.test.ts`); `W/utils/testing/fixtures.ts`; and every
  fixture, count pin or compile fix the new required fields need (listed in the report; the coordinator accepts them in
  the audit as `C40-compile-fixes`; expected: the `catalogNameSchema` widening reaching the web slash menu
  (`W/components/chat/composer/slash-commands.ts`), Customize (`W/components/settings/customize/customize.ts`) and share
  code, the `PluginSource` maps of `W/components/plugins/{install/install.ts,list/plugin-display.ts}` and
  `S/plugins/install/**` labels, and the count pins of `SH/schemas/{dto,customizations,agent}.test.ts`,
  `SH/api/routes.test.ts`). A file that needs edits from both C40 and C42 is C40's (C42 says what it needs).
- **Read-only highlights.** `.tmp/p12-designs/**` (the plan's Reconciliation table, Totals and sections 1 – 7 and
  `README.md` are binding; `server-plugins.md` section 4 and `server-import.md` section 2 are the detailed contract
  diffs); `docs/DECISIONS.md` (the Phase 12 contract seed); the coordinator's skeletons (C41 implements them);
  `SH/api/routes.test.ts:94,110,297` and `SH/contract.test.ts` (doc-coupled: API.md section 8 and the DECISIONS module
  table), `SH/schemas/dto.test.ts:135` (settings) and `:785` (events), `SH/isomorphic.test.ts` (exported value names, no
  Node built-ins, no `process.` text), `SDK/exports.test.ts`; `SH/ids.ts:212` (`isReservedPluginId`), `SH/enums.ts:122`
  (`workspaceChangedSourceSchema`), `SH/errors.ts:113` (`conflictReasonSchema`), `SH/chat.ts:41` / `:202` / `:377`,
  `SH/schemas/agent.ts:93` (`catalogNameInputSchema`), `SH/schemas/tools.ts:167` (`commandSummarySchema`),
  `SH/schemas/data.ts:183`.
- **Tasks.**
  1. **C40-T1 Ids** — `SH/ids.ts`: `mkt_` (`MARKETPLACE_ID_PATTERN`, `marketplaceIdSchema`, `newMarketplaceId()`) and
     `cip_` (import plan ids, same style); `QUALIFIED_NAME_PATTERN` (`<pluginId>:<seg>` with 1 – 3 segments of
     `[a-z][\da-z-]{0,63}`, ≤ 128 characters), `CATALOG_NAME_PATTERN` (bare or qualified), `catalogNameSchema`,
     `qualifiedName(pluginId, …segments)`, `splitQualifiedName(name)`; `isReservedPluginId` also reserves `new` and
     `marketplaces` (the web routes `/plugins/new`, `/plugins/marketplaces`). *Accept:* `ids.test.ts` (generators match
     their patterns; qualified-name tables incl. 129 characters refused, 4 segments refused, a bare name accepted; the
     reserved ids).
  2. **C40-T2 Enums, errors, events, limits** — `SH/enums.ts`: `pluginSourceSchema` + `github`, `marketplace`;
     `pluginFormatSchema` (`harness | claude`); `marketplaceSourceTypeSchema` (`github | url | path`);
     `marketplaceEntrySourceKindSchema` (built on `CLAUDE_ENTRY_SOURCE_KINDS`); `workspaceChangedSourceSchema` + `user`;
     `SH/errors.ts`: conflict reason `offline` (15; the doc comment explains it); `SH/events.ts`: `marketplace.changed {
     id, marketplace: MarketplaceSummary | null }` (19); `LIMITS` Phase 12 group, values identical to
     `CLAUDE_PLUGIN_LIMITS`, `CLAUDE_HOME_LIMITS` and server-import.md's table (`claudeImportItemsMax` 1000,
     `claudeImportBytesMax` 32 MiB, `claudeJsonBytes` 16 MiB, `claudeMdBytes` 1 MiB, `claudeImportPlanTtlMs` 600 000,
     `claudeImportPlansMax` 4, `promptHookTimeoutDefaultMs` 30 000, `promptHookPromptMaxChars` 16 384,
     `hookModelCallsMax` 8, `transcriptBytesMax` 8 MiB, `sessionEndBudgetMs` 1500, `agentSkillsPreloadMax` 5,
     `agentSkillsPreloadBytes` 32 KiB, `marketplacesMax` 50, `marketplaceJsonBytes` 1 MiB, `marketplaceEntriesMax` 1000,
     `repoArchiveBytes` 50 MiB, `claudeComponentsPerKindMax` 100, `qualifiedNameMaxChars` 128, `skillFileReadBytes` 65
     536). *Accept:* enum tests; a v1.7 `workspace.changed` parses; a test pins every `LIMITS` value mirrored by the
     util constants; the event count pin 19.
  3. **C40-T3 Plugins (`SH/schemas/plugins.ts`)** — install sources `{ source: 'github', repo, ref?, path? }` and `{
     source: 'marketplace', marketplaceId, plugin }`; every variant and the form get `format?`; the summary gains
     `format`; the detail gains `origin: pluginOriginSchema | null` (marketplace / github shapes of server-plugins.md
     section 2 minus `overlay`) and `claude: claudePluginInfoSchema | null`; the inspection gains `format` and `claude |
     null`; `claudePluginInfoSchema` (`name`, `displayName?`, `version | null`, `namespace`, `components { commands,
     agents, skills, outputStyles, hooks, mcpServers }`, `executables[{ kind: 'hook' | 'mcp' | 'span', label, command ≤
     4096 }] ≤ 200` (exactly what the trust consent shows), `hosts`, `userConfig[{ key, title, sensitive, required }]`,
     `unsupported[{ component, reason }]`, `diagnostics[{ level, component, path?, code, message }] ≤ 200`);
     `pluginUpdateSchema`; `pluginContributionsSchema` names widened to `catalogNameSchema`. *Accept:* samples; a v1.7
     plugin summary / detail parses (`format` defaulted where the DTO allows); an unknown source refused.
  4. **C40-T4 Marketplaces (`SH/schemas/marketplaces.ts`, new)** — `marketplaceNameSchema` (`[A-Za-z0-9._-]{1,64}`,
     starts alphanumeric, no `..`), `githubRepoSchema`, `gitRefSchema` (`[A-Za-z0-9._/-]`, no `..`, no leading `/`),
     `commitShaSchema` (40 hex), `marketplaceSourceSchema` (`github { repo, ref? }` | `url { url (https) }` | `path {
     path (absolute) }`), `marketplaceAddBodySchema` (strict `{ source }`), `marketplaceSummarySchema`,
     `marketplaceEntrySchema` (name, description, version, category, tags, source kind + display text, `supported`,
     `unsupportedReason`, installed `pluginId | null`, `update` available), `marketplaceDetailSchema` (+ diagnostics),
     `marketplaceListSchema { items, suggestions, updates }`, `MARKETPLACE_SUGGESTIONS` (only
     `anthropics/claude-plugins-official`). *Accept:* samples; `../x` refs and `owner/repo/extra` refused.
  5. **C40-T5 Import (`SH/schemas/claude-import.ts`, new)** — the DTO side of `SH/util/claude-import.ts` (payloads are
     never part of a DTO): `claudeImportHomeSchema { available, reason?: 'disabled' | 'missing' | 'unreadable', path }`;
     the plan item (key, kind, name, source `{ file, project? }`, status, actions, defaultAction, renameTo?, summary ≤
     300, warnings, diagnostics, variables? (names), executable) and the plan (`id` = `cip_`, source `upload | scan`,
     root (display), createdAt, expiresAt, items ≤ 1000, skipped ≤ 200, diagnostics); the apply body (strict `{ planId,
     items[{ key, action, renameTo?, enable? }], instructions?: 'append' | 'replace', variables?: record(itemKey,
     record(NAME, string)) }`); the apply result (`results[{ key, outcome: created | updated | unchanged | skipped |
     failed, id?, message? }]`, counts, warnings). *Accept:* samples; an apply body with an unknown key refused; no
     schema field can carry an env or header value.
  6. **C40-T6 Project definitions (`SH/schemas/project-definitions.ts`, new)** — `projectDefinitionFileSchema { path,
     kind: agent | command | skill | style | settings | mcp, exists, content | null, sha256 | null, diagnostics }`; the
     write body union by path type (`{ path, expectedSha256 | null, content }`, `{ path, expectedSha256 | null, hooks:
     object | null }`, `{ path: '.mcp.json', expectedSha256 | null, mcpServers: object | null }`); the result `{ path,
     sha256, created, diagnostics, trust: { pending } }`; the read / remove query schemas (`path`, `expectedSha256`).
     *Accept:* samples; a body with both `content` and `hooks` refused; a lowercase-hex check on `expectedSha256`.
  7. **C40-T7 Hooks, chat, agent, customizations, settings, data, trust** — `SH/schemas/hooks.ts`: the personal hook
     create / update / DTO become a union on `type` (default `command`) with `prompt`, `model?`, `continueOnBlock?` and
     the command options `args?`, `async?`, `if?`, `statusMessage?` (C42's names: `HookSpec.{ args, async, if,
     statusMessage }`, `PromptHookSpec`); listing entries gain `type` + `prompt?`; plugin rows may be `state: 'pending'`
     (an untrusted plugin). `SH/chat.ts`: `hookResultSchema.{ kind?: 'command' | 'prompt', model? }`,
     `hookDataSchema.harnessAsked?`, `activityDataSchema.label?` (open point 1), `commandInvocationSchema.name` /
     `commandSummarySchema.name` → `catalogNameSchema`, `outputStyle` → `catalogNameSchema`. `SH/schemas/agent.ts`:
     `catalogNameInputSchema` (`task.type`, `skill.name`) → `catalogNameSchema`; `skillInputSchema.file?` (a safe
     relative path ≤ 512); `skillOutputSchema.{ fileAccess?: 'workspace' | 'skill', file?: { path, content, truncated }
     }`; `taskOutputSchema.type`. The other name widenings (`outputStyle` in chats / projects / system / the chat
     request, shares, plugin contributions). `SH/schemas/customizations.ts`: entry fields named exactly like C42's
     parsed fields (agents `disallowedTools?`, `maxTurns?`, `color?` (`AGENT_COLORS`), `skills?`, `modelAlias?`;
     commands / skills `whenToUse?`, `arguments?`, `disallowedTools?`, `context?: 'fork'`, `agent?`, `modelAlias?`;
     skills `allowedTools?`, `model?`). `SH/schemas/system.ts`: `hookModelRef` (model ref | null, default null) and
     `modelAliases { sonnet, opus, haiku, fable }` (each a model ref | null, default null) → 32 keys, neither needs
     fresh auth. `SH/schemas/data.ts`: `customizations.turnedOff?` (int). `SH/schemas/project-trust.ts`:
     `trustHookDetailSchema` gains `type?`, `prompt?`, `model?`, `args?`, `async?`, `if?` and a nullable `command` (open
     point 2). *Accept:* a v1.7 message (every Phase 9 – 11 part, a hook carrier), a v1.7 settings document, a v1.7 chat
     detail, a v1.7 hook listing and trust listing parse; `dto.test.ts` at 32 settings.
  8. **C40-T8 Plugin SDK 1.6.0 and manifests** — `PLUGIN_API_VERSION` `'1.6.0'`; `CommandDefinition.{ syntax?:
     'template' | 'markdown', argumentHint?, model?, allowedTools? }` (markdown bodies ≤ 64 KiB), `SkillDefinition.{
     baseDir?, argumentHint?, userInvocable?, modelInvocable? }`, agent fields `disallowedTools?`, `maxTurns?`,
     `color?`, `skills?`; `HookEventName` + the five events (from C42's `HOOK_EVENTS`); command hook `args?` / `async?`
     / `if?` / `statusMessage?`; a prompt hook spec (`type: 'prompt'`, `prompt`, `model?`, `timeout?`,
     `continueOnBlock?`); the manifest `contributes.hooks` accepts the 13 events and prompt handlers (an unknown event
     stays an error in harness manifests), `contributes.skills[].baseDir?`; names may be qualified with the plugin's own
     id; `manifestRequiresTrust` stays true for command handlers, stdio MCP servers and `!` spans and is **not** set by
     prompt-only hooks; `PluginSource` + `github`, `marketplace`; the template mirror `S/plugins/templates/sdk-types.ts`
     follows (`templates.test.ts`); `exports.test.ts` pins. *Accept:* SDK tests; `^1.5.0` manifests (`hook-pack`,
     `agent-pack`) still parse and builtin manifests with `engines ^1.5.0` still load.
  9. **C40-T9 Route table** — `ApiModule` += `marketplaces`, `claudeImport`, `projectDefinitions`; the twelve keys of
     "Totals" with their paths (`/marketplaces`, `/marketplaces/:id`, `/marketplaces/:id/refresh`,
     `/claude-import/{home,scan,upload,apply}`, `/projects/:id/definitions/file`); `fresh: true` on `claudeImport.scan`
     and `claudeImport.apply` only (14 in total); `marketplaces.add` 201, `marketplaces.remove` 204 → **132** routes, 36
     modules; `pluginInstall.inspect` / `install` keep their keys (their bodies gain the new sources). *Accept:*
     `routes.test.ts` (the API.md section 8 index + the DECISIONS module table) and `contract.test.ts` at 132.
  10. **C40-T10 `docs/API.md`** — the `LIMITS` rows; settings (32); conflict reasons (15); the new schema sections 4.33
      (marketplaces, the Claude plugin info, the plugin origin, the install sources), 4.34 (the import: home, plan,
      apply body and result) and 4.35 (project definition files), plus the hook (prompt union, listing `type`), chat
      (`hookResult.kind` / `model`, `harnessAsked`, the activity label), agent (`skill.file`, `fileAccess`),
      customization, settings, data (`turnedOff`) and trust (hook detail) additions; the three modules 5.34 – 5.36 with
      every answer (marketplaces: 200, 201, 204, 400 (a reserved name, open point 15), 404, 409 `exists` / `offline`,
      429 `rate_limited`, 502; import: 200, 400, 403 without fresh auth, 404 (expired plan), 409 `disabled`, 413 / 400
      over the upload cap (C40 fixes it); project definitions: 200, 400 with diagnostics, 404, 409 `stale`); the
      `pluginInstall` bodies; the event; the 132-route key index in the parsed format; report the final section numbers
      (done: 4.33 – 4.35, 5.34 – 5.36; D16 / D17 cite them).
  11. **C40-T11 Stubs and compile fixes** — `S/app.ts` mounts `marketplaces`, `claudeImport` and `projectDefinitions`;
      the twelve routes validate first (params, query, body; the multipart upload checks its content type) → 400, then
      answer `501 not_implemented`; `api-samples.ts`; the route-table security tests follow (the two fresh routes, the
      guards, the leak canaries: fake `oauthAccount` / `primaryApiKey` / MCP token values);
      `W/utils/testing/fixtures.ts` and every other fixture get the two settings keys and the new DTO fixtures;
      `C40-compile-fixes` (see Owned); count pins (132 / 36 + the fresh list, SSE 19, settings 32, conflict reasons 15).
      *Accept:* `routes-mounted.test.ts` green (no new route answers 404); `pnpm check` green, or the failures caused
      only by the unfinished C41 / C42 skeleton bodies listed exactly; v1.7 messages, settings, chat settings with
      `outputStyle` and `^1.5.0` manifests still parse.
- **Tests.** Schema tests for every new DTO; route-table tests; the updated route-driven security tests.
- **Verify.** Shared, plugin SDK, server and web commands.

### C41 Claude helpers (k3)

- **Mission.** The shared Claude Code helpers — the plugin and marketplace parsers, the id rule, the overlay, the
  variables, the `userConfig` mapping, the shorthand, the permission mapping and the import planner — complete and
  tested (frozen after Gate P12-0b; used by C43 – C46, W12.1 – W12.4, W12.8 – W12.10).
- **Owned.** `SH/util/{claude-plugins,claude-import,claude-permissions}{,.test}.ts` (implementing the coordinator's
  skeletons: the exported names and signatures stay; an addition is listed in the report).
- **Read-only highlights.** ADR-053 … ADR-055; the plan's Reconciliation rows (Plugin format, Plugin id, Version,
  Variables, userConfig, Marketplaces, Import, Import statuses, Import rules); `claude-formats.md` (the real formats);
  `server-plugins.md` D1 – D4, D8, D10, D11, D18, D19 and section 7; `server-import.md` A3 – A10, section 2 and 7;
  `SH/util/{definitions,hooks,mcp-config,command-template,shell-command,tool-names}.ts` (`parseDefinition`,
  `readSettingsHooks` / `readHooksConfig`, `parseMcpJson` / `mcpServerIdFromName`, `planCommandExpansion`,
  `parseShellRule`, `CLAUDE_TOOL_ALIASES`); `SH/schemas/plugin-settings.ts` (the settings schema shape).
- **Tasks.**
  1. **C41-T1 `claude-plugins.ts`** — `parseClaudePluginManifest` (byte cap before `JSON.parse`; name rules: kebab, no
     spaces / `@` / `:` / `/` / control characters; every documented field incl. the component path fields in their
     string / array / object forms; paths must start with `./` and stay inside (`..` → `path-outside-root`); unknown
     top-level keys dropped with `unknown-field` warnings; known-but-unsupported keys (`lspServers`, `channels`,
     `themes`, `monitors`, `workflows`, `settings`, `dependencies`, `experimental`) listed in `unsupported`);
     `parseMarketplaceJson` (name rule, owner, `metadata.pluginRoot`, entries with every source variant classified by
     `CLAUDE_ENTRY_SOURCE_KINDS` — github.com `url` / `git-subdir` entries become `github` (+ path), `command` and
     non-GitHub git → unsupported with a reason, npm with a custom `registry` → unsupported; `strict` default true;
     inline plugin fields kept in `overlay`; an invalid entry dropped with a diagnostic, never the whole file);
     `claudePluginId` (the slug rule; `digest` and `isReserved` passed in); `mergeEntryOverlay` (strict semantics);
     `substitutePluginVariables` (`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`,
     `${CLAUDE_SKILL_DIR}`, `${user_config.KEY}`; sensitive keys never substituted in `markdown` mode; `\$` escapes;
     unknown references literal and reported); `userConfigToSettings` (`sensitive` → `format: 'secret'` without
     default + warning; options → enum; multiple → array; number min / max; boolean; directory / file → string with
     pattern `^/`; required list; keys outside the settings field-key pattern skipped; ≤ 50);
     `parseMarketplaceShorthand`. *Accept:* tables with real files from `claude-formats.md` (`plugin.json` with every
     field form, `marketplace.json` with every source kind incl. `strict: false`); id slugging (long names, reserved
     ids, an empty slug); variable substitution incl. sensitive keys and escapes.
  2. **C41-T2 `claude-permissions.ts`** — `parseClaudePermissionRule` (`Tool` or `Tool(specifier)`, ≤ 4096, never
     throws); `shellRuleFromPermission` (`Bash(p:*)` / `Bash(p *)` → `p`; `Bash(p)` → `p` + `prefix-broader`; bare
     `Bash`, `Bash(*)`, inner wildcards and prefixes `parseShellRule` refuses → the reason); `toolNamesFromPermission`
     (the reversed `CLAUDE_TOOL_ALIASES`; `mcp__x__*` kept). *Accept:* the permission mapping table (incl. `Bash(npm run
     test:*)`, `Bash(git *)`, `Bash(rm -rf *)`, `Bash(python *)`, `Read(./.env)`, `WebFetch`, `mcp__github__*`).
  3. **C41-T3 `claude-import.ts`** — `isClaudeHomeImportPath` (the allowlist exactly as the skeleton documents;
     normalized; `..`, absolute paths, backslashes and hidden segments refused except the `.claude.json` sentinel);
     `extractClaudeJsonMcpServers` (parse once, keep only the MCP maps, drop the rest at once; never another key in a
     diagnostic); `claudeImportItemKey`; `planClaudeImport`: definitions through `parseDefinition(kind, text, {
     fileName | folderName })` (C42 extends it in parallel; call it, never re-implement it), a missing `name:` inserted
     with C42's `setDefinitionName`, nested commands `commands/db/migrate.md` → `db-migrate` (≤ 32, the
     `COMMAND_NAME_PATTERN` slug rules, an info diagnostic); statuses against the baseline (`unchanged` byte-equal,
     `update` default `skip` with skip / overwrite / rename, `conflict` for reserved / builtin names (rename only),
     `invalid` with the parser diagnostics); commands with `!` spans `executable`; `settings.json` hooks via
     `readSettingsHooks` / `readHooksConfig` (one item per handler; command handlers `executable`; identity = canonical
     `{ event, matcher, handler }`); `permissions.allow` Bash rules → `shell-rule` items, other allow / ask / deny rules
     → `permission` items `unsupported` with a reason, whole-tool `deny` → `tool-deny` items; `outputStyle` → a
     `setting` item (the style exists in the baseline or comes with the plan; `styleNameFromLabel`); `model` → an info
     item; `env` → one `env` item listing the names (values only in `draft.env`); `apiKeyHelper`, `statusLine`,
     `awsAuthRefresh` → `unsupported` (never run); `enabledPlugins`, `extraKnownMarketplaces` → `plugin` / `marketplace`
     items `unsupported` ("Install plugins from Plugins → Marketplaces."); `CLAUDE.md` → one `instructions` item (append
     / replace / skip; `unchanged` when already contained; `invalid` over 20 000 characters; warning `imports-kept` for
     `@path` lines); `.claude.json` → `mcp-server` items via `parseMcpJson` on a re-serialized `{ mcpServers }` (ids
     from `mcpServerIdFromName`; fingerprint = command, args, url, env / header **names**; `conflict` when the id exists
     with another fingerprint; stdio `executable`; `variables` = `${VAR}` names not in `env`, warning `needs-variables`;
     per-project servers with `project` + warning `project-server`); the caps of `CLAUDE_HOME_LIMITS`; summaries never
     quote values; a deterministic order. *Accept:* a planner fixture (an in-memory file list) covering every status; a
     realistic `settings.json` (hooks + permissions + env + statusLine); a `.claude.json` with `oauthAccount` /
     `primaryApiKey` / `projects` canaries that never appear in any output.
  4. **C41-T4 Fuzz** — a seeded generator: every exported parser and the planner never throw on random JSON / text,
     apply the caps first and stay fast. Folder-like fixtures are in-memory file lists only (never `.claude/` or
     `.claude-plugin/` on disk).
- **Tests.** The tasks above (`claude-plugins.test.ts`, `claude-permissions.test.ts`, `claude-import.test.ts`); tests
  that depend on C42's unfinished `setDefinitionName` / new hook fields may be listed as pending.
- **Verify.** `pnpm -F @harness-forge/shared test`; `pnpm exec tsc --noEmit -p packages/shared`; `isomorphic.test.ts`
  green; `pnpm check:english`; eslint on the six files.

### C42 hook and frontmatter helpers (k4)

- **Mission.** Extend the shared hook, trust, definition, argument and tool-name helpers for prompt hooks, the five
  events, the handler fields, `transcript_path`, the trust item v2, the frontmatter keys, named arguments, the argument
  base and model aliases — complete and tested, every Phase 9 – 11 behavior unchanged (frozen after Gate P12-0b).
- **Owned.** `SH/util/{hooks,trust,definitions,arguments,tool-names}{,.test}.ts` and the compile fixes its changes force
  in server / web files (code switching over `HOOK_EVENTS`, exhaustive event or definition-field maps in
  `W/components/settings/customize/**`, `S/services/hooks/**`; listed in the report as `C42-compile-fixes`).
- **Read-only highlights.** ADR-057, ADR-058; the plan's Reconciliation rows (Prompt hooks, New events, Handler fields,
  Transcript, Allow record, Frontmatter, Arguments, Model aliases) and sections 5 – 6; `server-import.md` section 1 C1 –
  C5, D1 – D3 and section 2; `claude-formats.md` 3 and 5 (the raw hook and frontmatter text); `SH/util/hooks.ts:38`
  (`HOOK_EVENTS`), `:58` (`HOOK_MATCHER_SUBJECTS`), `:93` (`HOOK_DIAGNOSTIC_CODES`), `:302` (`readHandler`, today's
  `unsupported-type` for `prompt`), `:567` (`HookPayloadInput`), `:673` (`buildUnchecked`), `:947` (`readHookOutput`);
  `SH/util/trust.ts:149,191`; `SH/util/definitions.ts:884,937`; `SH/util/arguments.ts:65`; C41's
  `parseClaudePermissionRule`.
- **Tasks.**
  1. **C42-T1 `hooks.ts`** — `HOOK_EVENTS` + `PostToolUseFailure`, `PermissionRequest`, `SubagentStart`, `PostCompact`,
     `SessionEnd` (13); matcher subjects (`tool` for PostToolUseFailure / PermissionRequest, `agent` for SubagentStart /
     SubagentStop (the agent type, Claude names included: `general-purpose` matches `general`), `trigger` for
     PostCompact, `reason` for SessionEnd); diagnostic codes `invalid-prompt`, `invalid-if`, `invalid-model`;
     `HookSpec.{ args?, async?, if?, statusMessage? }`; `PromptHookSpec { event, matcher, prompt, model, timeoutSec,
     continueOnBlock, position, file? }` and `ReadHooksResult.prompts` (always present, `[]` unless the option `{
     prompts: true }`); prompt handlers allowed for the seven events (elsewhere `unsupported-type`); `http` / `mcp_tool`
     / `agent` handlers → `unsupported-type` warnings; `asyncRewake` / `once` → info; `shell: 'powershell'` → invalid;
     unknown events stay `unknown-event` info and never invalidate a source; `HookPayloadInput.{ transcriptPath?,
     error?, agent?: { id, type }, sessionEndReason? }` + the payload fields (`transcript_path`, `error`, `agent_id`,
     `agent_type`, `reason`); `readHookOutput` for the new events incl. the PermissionRequest
     `hookSpecificOutput.decision.{ behavior: 'allow' | 'deny', updatedInput?, message?, interrupt? }` (exit 2 not
     honored for PermissionRequest); the pure functions `expandHookPrompt(prompt, payloadJson)`,
     `readPromptHookAnswer(text)`, `promptHookOutcome(event, answer, { continueOnBlock })` (the plan's effect table;
     `ok: true` never allows), `execFormCommand(command, args, vars)` (`${CLAUDE_*}` substituted as plain text, every
     word single-quoted for `runShellCommand`), `matchHookIf(ifRule, target)` (a bare tool name or `Bash(p:*)` / `Bash(p
     *)` / `Bash(p)` via `parseClaudePermissionRule`; anything else invalid, never runs). *Accept:* tables per event ×
     handler type; the prompt-answer parser (fences, garbage, a missing reason); the `promptHookOutcome` matrix (event ×
     `continueOnBlock` × `impossible`); `execFormCommand` quoting (spaces, quotes, `$`, newlines: no injection);
     `matchHookIf`; every C35 test unchanged.
  2. **C42-T2 `trust.ts`** — the hook trust item gains `extra?` (prompt fields or args / async / if); **without `extra`
     the canonical layout stays byte-identical** (`['hook', 1, …]`), with it `['hook', 2, event, matcher, command |
     null, timeout, extra, refs]`. *Accept:* golden tests computed with the current code **before** the change pin
     today's v1 outputs for representative hooks, MCP servers and commands.
  3. **C42-T3 `definitions.ts`** — the new keys, present in the parsed fields only when set (existing parses stay
     deep-equal): agents `disallowedTools?`, `maxTurns?` (1 – 200), `color?` (`AGENT_COLORS` = red, blue, green, yellow,
     purple, orange, pink, cyan), `skills?` (≤ 5), `modelAlias?` (`model` stays null; lowercased, `[1m]` removed,
     `opusplan` → `opus`, info `model-alias`); commands and skills `whenToUse?`, `arguments?` (≤ 9 names,
     `^[a-z_][a-z0-9_]{0,31}$`), `disallowedTools?`, `context?: 'fork'`, `agent?`, `modelAlias?`; skills
     `allowedTools?`, `model?`; read-but-ignored keys with an `ignored-key` info (`permissionMode`, `mcpServers`,
     `hooks`, `memory`, `background`, `effort`, `isolation`, `initialPrompt`, `paths`, `shell`, `metadata`, `license`,
     `compatibility`); `formatDefinition` writes the new keys; `setDefinitionName(text, name)` inserts or replaces
     `name:` inside the frontmatter (adds a frontmatter block when there is none) and keeps every other line byte for
     byte. *Accept:* round trips with every new key; `setDefinitionName` tables; every C29 / C35 test unchanged.
  4. **C42-T4 `arguments.ts`** — `expandArguments(body, input, options?: { names?, base?, vars? })` (without options
     unchanged) with `$ARGUMENTS[N]`, `$N` relative to `base`, `$name` from `names`, `\$` escapes, `${CLAUDE_SKILL_DIR}`
     / `${CLAUDE_PROJECT_DIR}` / `${CLAUDE_SESSION_ID}` (+ plugin vars in `vars`; unknown ones literal);
     `argumentBase(body, names)` → 0 when the body uses `$0` or `$ARGUMENTS[` or `names` is non-empty, else 1. *Accept:*
     regression tests with the Phase 10 examples (every v1.6 / v1.7 template keeps its meaning).
  5. **C42-T5 `tool-names.ts`** — what the above needs (the `Agent` / `Task` aliases for agent matching,
     `general-purpose` → `general`); `CLAUDE_TOOL_ALIASES` stays backward compatible.
  6. **C42-T6 Fuzz** — a seeded generator for the new parsers (`readPromptHookAnswer`, the new handler fields,
     `setDefinitionName`, `expandArguments` with options): never throw, caps first, no `RegExp` built from input.
- **Tests.** The tasks above; every C23 / C29 / C35 test unchanged and green (tests that need C41's
  `parseClaudePermissionRule` may be pending until it lands).
- **Verify.** `pnpm -F @harness-forge/shared test`; `pnpm typecheck`; `pnpm -F @harness-forge/server test`; `pnpm -F
  @harness-forge/web typecheck:fast` and `pnpm -F @harness-forge/web test` after the compile fixes;
  `isomorphic.test.ts`; `pnpm check:english`; eslint on its files.

### D16 phase doc (k1)

- **Mission.** Write this file so P12-0b, P12-A and P12-B agents can build against it.
- **Owned.** `docs/phases/phase-12-v1-8.md` (new).
- **Tasks.**
  1. **D16-T1 Phase doc** — goal, totals, criteria, the binding deviations and open points, the rules for every agent,
     the FREEZE list, every wave with owned globs, tasks with acceptance criteria, ownership JSON, cross-agent
     contracts, gates and probes, the mock and fixture contract, risks; contradictions between the plan, DECISIONS.md,
     the skeletons and the reports listed in the report (the plan's version written here).
- **Verify.** `pnpm check:english`.

### D17 docs (k5, no server)

- **Mission.** Update the user-facing and architecture docs for Phase 12 so P12-0b and P12-A agents can build against
  them.
- **Owned.** `docs/UI.md`, `docs/ARCHITECTURE.md`, `docs/PLUGINS.md`, `docs/PROVIDERS.md`, `docs/guides/**`,
  `README.md`, `.env.example`.
- **Tasks.**
  1. **D17-T1 UI.md** — 2.19 wireframes (the Marketplaces page, the install dialog's GitHub tab and the Claude preview,
     the Import from Claude Code wizard (3 steps), the project file editor with the conflict state, the hook editor's
     Prompt type, the trust dialog's mixed select-all; desktop and 390 px); 5.4 (the Plugins nav row "Marketplaces" with
     its update badge) and the 5.5 note; 6 (the routes `/plugins/marketplaces` (`?m=&q=&category=`) and
     `/settings/customize?import=claude`); the new 7.34 (chat additions); 8.13 (marketplaces and Claude plugins: entry
     states, the update badge and banner, "Asks for:", "Ignored", namespaced names); 9.14 (the import wizard, Edit… on
     project rows, the Hooks tab additions (Prompt type, 13 events, untrusted plugin rows), the Hook model and the model
     aliases in the Agent section, the Data turned-off count); 10.9 contracts (the props / emits of the new components
     and the extracted `InstallReview`, see "C46 web skeleton"); 11.9 modules (the `marketplaces` store,
     `useClaudeImport`, the pure modules, the `useChatSession` / `useServerEvents` additions); 13.13 test ids
     (web-process.md's list, reconciled: **no** run-active state in the project edit flow); 14.1, 14.2, 14.5 – 14.7
     accessibility; 15 copy (exact strings; "A chat in {project} is running…" dropped). Done: 13.13 holds 70 ids (incl.
     `settings-model-alias`).
  2. **D17-T2 ARCHITECTURE.md** — new flow sections 6.33 – 6.38 for the Claude plugin format (detection, whole-tree
     trust hash, exec bits, qualified names, variables, `userConfig`, skill files), marketplaces and HTTPS archive
     sources (commit resolution, codeload, `safeFetch`, offline, updates, reserved names), the home-folder import
     (allowlist, server-side plan, upload / scan, apply, secrets never leave the server), project definition file
     editing (the write path, `workspace.changed { source: 'user' }`, stale protection, never approves), prompt hooks /
     the new events / handler fields / `transcript_path`, frontmatter compatibility + the argument base + model aliases;
     the stop order additions; `0009_claude_ecosystem`; the security section 10.13; the log rules; the backup contents.
  3. **D17-T3 PLUGINS.md** — API 1.6.0 (every additive field; the version table row) and section 17 "Claude Code
     plugins" (the supported layout and fields, the unsupported parts, naming, the variables table, the `userConfig`
     mapping, the trust rule, exec bits, updates, marketplaces) with the example 15 (h) `claude-review-kit`. *Accept:*
     `SH/schemas/manifest.test.ts` and `examples.test.ts` still parse PLUGINS.md (1.6.0-only samples marked so the test
     skips them until C40 lands, reported).
  4. **D17-T4 PROVIDERS.md 8 "Prompt hook mock (Phase 12)"** — `mock:prompt-hook` exactly as in "Mock and fixture
     contract" below (it is the probe contract); the Hook model setting and `modelAliases` where model selection is
     described.
  5. **D17-T5 Guides** — new `docs/guides/claude-code-import.md` (what is imported and what never is, upload vs scan,
     the Docker default `HF_CLAUDE_HOME=0` and the `-v ~/.claude:/claude:ro -e HF_CLAUDE_HOME=/claude` recipe,
     re-import, turned-off executables) and `docs/guides/claude-code-plugins.md` (GitHub / zip / folder installs,
     marketplaces, the official suggestion, trust, updates, offline); `docs/guides/hooks-and-project-mcp.md` updated
     (prompt hooks, the five events, the handler fields, `transcript_path`, editing project files in the UI) and
     `docs/guides/customizing-agents.md` (the new frontmatter keys).
  6. **D17-T6 README and `.env.example`** — the status "v1.8 in progress" + feature bullets; `.env.example` gains
     `HF_CLAUDE_HOME` (unset = `~/.claude`, `0` = off, an absolute path); `HF_TEST_REMOTE_URL` is test-only and is not
     listed there.
- **Verify.** `pnpm check:english`; `pnpm -F @harness-forge/shared test` (doc-coupled tests).

### Wave P12-0a ownership

This is `.tmp/waves/P12-0a.json` (the coordinator's file). The audit cannot express "except": the C41 and C42 files and
the coordinator's skeletons match C40's `packages/shared/src/**` glob too (warnings; C41 / C42 own their files, the
skeletons were the coordinator's before the launch, `SH/index.ts` stays the coordinator's). C40 and C42 list the extra
fixture and compile-fix files they had to touch in their reports; the coordinator adds them to `C40-compile-fixes` /
`C42-compile-fixes`. K2 changes nothing; K3S and D16's checks write only below `.tmp/` (ignored by git).

```json
{
  "wave": "P12-0a",
  "agents": {
    "K1": ["AGENT.md", "docs/DECISIONS.md", "docs/ROADMAP.md"],
    "coordinator-skeletons": [
      "packages/shared/src/index.ts",
      "packages/shared/src/util/claude-plugins.ts",
      "packages/shared/src/util/claude-import.ts",
      "packages/shared/src/util/claude-permissions.ts"
    ],
    "C40": [
      "packages/shared/src/**",
      "packages/plugin-sdk/src/**",
      "apps/server/src/plugins/templates/sdk-types.ts",
      "apps/server/src/plugins/templates/templates.test.ts",
      "docs/API.md",
      "apps/server/src/app.ts",
      "apps/server/src/http/routes/marketplaces.ts",
      "apps/server/src/http/routes/claude-import.ts",
      "apps/server/src/http/routes/project-definitions.ts",
      "apps/server/src/testing/api-samples.ts",
      "apps/server/src/http/routes-mounted.test.ts",
      "apps/server/src/http/middleware/session-auth.test.ts",
      "apps/server/src/http/middleware/fresh-auth.test.ts",
      "apps/server/src/security/fresh-auth-routes.test.ts",
      "apps/server/src/security/secret-leaks.test.ts",
      "apps/server/src/security/request-guards.test.ts",
      "apps/web/app/utils/testing/fixtures.ts"
    ],
    "C41": [
      "packages/shared/src/util/claude-plugins.ts",
      "packages/shared/src/util/claude-plugins.test.ts",
      "packages/shared/src/util/claude-import.ts",
      "packages/shared/src/util/claude-import.test.ts",
      "packages/shared/src/util/claude-permissions.ts",
      "packages/shared/src/util/claude-permissions.test.ts"
    ],
    "C42": [
      "packages/shared/src/util/hooks.ts",
      "packages/shared/src/util/hooks.test.ts",
      "packages/shared/src/util/trust.ts",
      "packages/shared/src/util/trust.test.ts",
      "packages/shared/src/util/definitions.ts",
      "packages/shared/src/util/definitions.test.ts",
      "packages/shared/src/util/arguments.ts",
      "packages/shared/src/util/arguments.test.ts",
      "packages/shared/src/util/tool-names.ts",
      "packages/shared/src/util/tool-names.test.ts"
    ],
    "D16": ["docs/phases/phase-12-v1-8.md"],
    "D17": ["docs/UI.md", "docs/ARCHITECTURE.md", "docs/PLUGINS.md", "docs/PROVIDERS.md", "docs/guides/**", "README.md", ".env.example"],
    "C40-compile-fixes": [],
    "C42-compile-fixes": []
  },
  "allow": []
}
```

### Wave P12-0a cross-agent contracts

| Producer → consumer | Contract |
|---|---|
| coordinator (skeletons) → C40, C41, C42 | the exported names and signatures of `SH/util/{claude-plugins,claude-import,claude-permissions}.ts` |
| C40 → C41 – C46, every P12-A agent | the DTOs, enums, limits, route keys, the event, settings, `catalogNameSchema` / `qualifiedName` / `splitQualifiedName`, the plugin / marketplace / import / project-definition / hook / trust schemas, the conflict reason `offline`, the activity label; the plugin SDK 1.6.0 (`CommandDefinition.syntax`, `SkillDefinition.baseDir`, the agent fields, the 13 events, prompt handlers, `manifestRequiresTrust`, `PluginSource`) |
| C41 → C43 – C46, W12.1 – W12.4, W12.8 – W12.10 | `parseClaudePluginManifest`, `parseMarketplaceJson`, `claudePluginId`, `mergeEntryOverlay`, `substitutePluginVariables`, `userConfigToSettings`, `parseMarketplaceShorthand`, `isClaudeHomeImportPath`, `extractClaudeJsonMcpServers`, `planClaudeImport`, `claudeImportItemKey`, `parseClaudePermissionRule`, `shellRuleFromPermission`, `toolNamesFromPermission` (complete) |
| C42 → C41, C43 – C46, W12.1, W12.5 – W12.7, W12.11 – W12.13 | the 13 events and matcher subjects, `HookSpec` fields, `PromptHookSpec`, `ReadHooksResult.prompts`, `HookPayloadInput` additions, `expandHookPrompt`, `readPromptHookAnswer`, `promptHookOutcome`, `execFormCommand`, `matchHookIf`, the trust item `extra` (v2), the definition keys + `AGENT_COLORS` + `setDefinitionName`, `expandArguments` options + `argumentBase` (complete) |
| D16 → everyone | this file (owned globs, tasks, acceptance, gates) |
| D17 → C43 – C46, every P12-A agent | UI.md 2.19, 5.4, 5.5, 6, 7.34, 8.13, 9.14, 10.9, 11.9, 13.13, 14.1, 14.2, 14.5 – 14.7, 15; ARCHITECTURE.md 6.33 – 6.38 and 10.13; PLUGINS.md 1.6.0 + section 17 "Claude Code plugins" + example 15 (h); PROVIDERS.md 8 "Prompt hook mock (Phase 12)"; the two new guides and the updated `hooks-and-project-mcp.md` / `customizing-agents.md` |
| K3S → G12B, Gate P12-A (probe 16), the final gate | `.tmp/upgrade-v17/{data,roots}` + `.tmp/upgrade-v17-ids.json` + `.tmp/upgrade-v17-backup.zip`, `.tmp/gates/P12-0b/seed-roots` (read-only for probes) |

### Gate P12-0a

1. `node scripts/audit-ownership.mjs .tmp/waves/P12-0a.json`
2. `pnpm install --frozen-lockfile`; `pnpm why typescript` (only 6.0.x); `pnpm why yaml` (one 2.9.x copy).
3. `pnpm check` → `pnpm build`: record the web `_nuxt` entry chunk size (gzip) against the `.tmp/v17` build of `b3fa452`
   (more than 40 KB larger → W12.8 / W12.10 load the Marketplaces page and the import wizard lazily).
4. `HF_TEST_REQUIRE_WEB_BUILD=1 pnpm -F @harness-forge/server exec vitest run src/http/static.test.ts`.
5. `mv .tmp/e2e .tmp/e2e-old-p12-0a` → `pnpm start:e2e` → `curl -sf http://127.0.0.1:8899/api/health` shows
   `"pluginApiVersion":"1.6.0"`; the twelve new routes are mounted (run with `bash -c`: zsh does not word-split `$r`):
   ```sh
   b=http://127.0.0.1:8899/api; p=prj_AAAAAAAAAAAAAAAA; m=mkt_AAAAAAAAAAAAAAAA
   s=0000000000000000000000000000000000000000000000000000000000000000; f=.claude/agents/x.md
   for r in "GET /marketplaces" "POST /marketplaces" "GET /marketplaces/$m" "POST /marketplaces/$m/refresh" \
            "DELETE /marketplaces/$m" "GET /claude-import/home" "POST /claude-import/scan" \
            "POST /claude-import/upload" "POST /claude-import/apply" "GET /projects/$p/definitions/file?path=$f" \
            "PUT /projects/$p/definitions/file" "DELETE /projects/$p/definitions/file?path=$f&expectedSha256=$s"; do
     set -- $r; curl -s -o /dev/null -w "%{http_code} $1 $2\n" -X "$1" "$b$2"
   done   # 501, or 400 where validation runs before the stub (routes-mounted.test.ts covers the full matrix)
   ```
6. `pnpm test:e2e` → 191 passed (`chromium` + `mobile` + `tablet`).
7. `pnpm audit --prod --audit-level high` clean (the six ignored advisories excepted).
8. The coordinator fixes (`examples/plugins/*/harness-forge.d.ts` regenerated for 1.6.0; the `SH/index.ts` export lines
   C40 asks for); D16's open points decided; ROADMAP + wave log → commit `feat: add phase 12 contracts and docs`.

---

## Wave P12-0b — schema, migration `0009`, skeletons, FREEZE

**Entry:** Gate P12-0a green and the v1.7 seed in `.tmp/upgrade-v17`. The coordinator lands K3 first; C43, C44, C45 and
C46 start in one launch once the migration exists (C43's upgrade test needs it); G12B writes its probes during the wave
and runs them after the coordinator's build.

### Coordinator actions

- **K3 Schema and migration `0009`** —
  1. `S/db/schema.ts`: table `marketplaces` (`id` text primary key (`mkt_`), `name` text not null, `source` text not
     null (JSON `MarketplaceSource`), `resolved_ref` text nullable (40-hex commit | sha256 of a URL JSON | null for a
     path), `catalog` text nullable (JSON, validated and normalized, ≤ 1 MiB), `fetched_at` integer nullable,
     `last_error` text nullable (JSON `HarnessErrorInit`), `created_at`, `updated_at` integer not null) with a unique
     index on `name`; columns `plugins.format` (text, not null, default `'harness'`) and `plugins.origin` (text,
     nullable; JSON `StoredPluginOrigin`); columns `hooks.type` (text, not null, default `'command'`), `hooks.prompt`,
     `hooks.model`, `hooks.options` (text, nullable; `options` = JSON with `continueOnBlock`, `args`, `async`, `if`,
     `statusMessage`; prompt rows store `command = ''`, so no table rebuild); `UsagePurpose` (`S/db/schema.ts:55`) +
     `'hook'` (a type only); `TABLE_NAMES` 23.
  2. `pnpm db:generate --name claude_ecosystem` → `apps/server/drizzle/0009_claude_ecosystem.sql` + snapshot. Expected:
     ```sql
     CREATE TABLE `marketplaces` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `source` text NOT NULL,
       `resolved_ref` text, `catalog` text, `fetched_at` integer, `last_error` text,
       `created_at` integer NOT NULL, `updated_at` integer NOT NULL);
     CREATE UNIQUE INDEX `marketplaces_name_unique` ON `marketplaces` (`name`);
     ALTER TABLE `plugins` ADD `format` text DEFAULT 'harness' NOT NULL;
     ALTER TABLE `plugins` ADD `origin` text;
     ALTER TABLE `hooks` ADD `type` text DEFAULT 'command' NOT NULL;
     ALTER TABLE `hooks` ADD `prompt` text;
     ALTER TABLE `hooks` ADD `model` text;
     ALTER TABLE `hooks` ADD `options` text;
     ```
  3. Inspect the SQL: exactly 1 `CREATE TABLE`, exactly 1 `CREATE UNIQUE INDEX`, exactly 6 `ALTER TABLE … ADD` (2 on
     `plugins`, 4 on `hooks`). **Reject** any `DROP`, `__new_`, `PRAGMA`, other `ALTER TABLE`, `DELETE` or `UPDATE`
     (foreign keys are on, and a table rebuild would cascade inside the migration transaction). A second `pnpm
     db:generate` reports no changes.
- **After C43, C44, C45, C46** — `nuxi prepare`; the build signal for G12B; the gate below; the FREEZE additions.
- Ownership file `.tmp/waves/P12-0b.json` (below).

### C43 server skeleton (k3)

- **Mission.** Freeze the server side of Phase 12 outside the chat pipeline: the additive interfaces, the marketplace,
  import and project-definition service types with stubs whose signatures are final, the Claude plugin types and the two
  shared stubs (detection, skill files), the registry members, the environment, the start / stop order, the column
  classification, the fakes and the database tests of `0009`.
- **Owned.** `S/types.ts`, `S/deps*.ts`, `S/env*.ts`, `S/main.ts`, `S/db/**` (not `schema.ts`), `S/chat/types.ts`,
  `S/plugins/types.ts`, `S/plugins/claude/{types,detect,skill-files}.ts` (open point 6), `S/plugins/marketplaces/**`
  (types + stubs), `S/services/{claude-import,project-definitions}/**` (types + stubs), `S/http/routes/claude-import.ts`
  (the `home` route only, below), `S/registry/types.ts`, `S/services/{hooks,customizations}/types.ts`,
  `S/services/data/references{,.test}.ts`, the testing files
  `S/testing/{create-test-app,fakes,fake-marketplaces,fake-claude-import,fake-project-definitions,fake-hooks,
  fake-customizations}*`, `Dockerfile`, and the compile fixes the interface changes force (`S/plugins/host.ts` accepting
  the `inspectDirectory` options, records with `format`; listed as `C43-compile-fixes`).
- **Read-only highlights.** `.tmp/p12-designs/plan.md` 1 – 5, 9; `server-plugins.md` sections 2, 4, 5;
  `server-import.md` sections 4 – 6; API.md (C40's sections 4.33 – 4.35, 5.34 – 5.36);
  `SH/schemas/{plugins,marketplaces,claude-import,project-definitions,hooks}.ts`,
  `SH/util/{claude-plugins,claude-import,hooks}.ts`; `apps/server/drizzle/0009_*.sql`; `S/deps.ts:143` (`BOOT_STEPS`),
  `:177` (`SHUTDOWN_STEPS`); `S/env.ts:66` / `:238` / `:316` (`HF_OFFLINE`), the `HF_TEST_FILE_SWEEP_DELAY_MS` precedent
  (test-only, honored only with `HF_MOCK_PROVIDER=1`); `S/registry/types.ts:103` (`HookCommandsRegistration`);
  `S/services/customizations/types.ts:101` (`CustomizationRestoreResult`), `:117`; `S/services/hooks/types.ts` (Phase
  11); the Phase 11 stub precedents (`S/testing/fake-hooks.ts`, `S/services/hooks/index.ts` as it was at P11-0b).
- **Tasks.**
  1. **C43-T1 Types (additive)** — `S/types.ts`: `AppServices.{ marketplaces: MarketplaceService, claudeImport:
     ClaudeImportService, projectDefinitions: ProjectDefinitionsService }`; `S/plugins/types.ts`: `PluginRecord.format`
     / `.origin` (`StoredPluginOrigin`: marketplace `{ marketplaceId, marketplace, plugin, sourceKind, commit?,
     archiveSha256?, npmVersion?, path?, version | null, overlay? }` | github `{ repo, ref | null, commit, path | null
     }`), `PluginRecordInput.format?` / `.origin?`, `PluginDirectoryInspection.format` / `.claude`,
     `inspectDirectory(dir, options?: { format?, overlay?, nameHint? })`; `S/registry/types.ts`:
     `HookCommandsRegistration.env?` and `.prompts?` (`PromptHookSpec[]`), `RegisteredHookCommands.env` / `.prompts`,
     `McpServerRegistry.register(…, options?: { claudeName? })`, `RegisteredMcpServer.claudeName?`;
     `S/services/hooks/types.ts`: `HookService.importPersonal(items)` (one `hooks.changed`), `.sessionEnd(chat)`
     (detached, never rejects), `HookRunInput.{ error?, agent?, sessionEndReason? }`, `HookSnapshot.statusMessage(event,
     target?)` (open point 1); `S/services/customizations/types.ts`: `CustomizationService.importDefinitions(items)`
     (one batch in the write queue, one `customization.changed {}`), `CustomizationRestoreResult.turnedOff`;
     `S/chat/types.ts`: what C44's seams need (C43 fixes the names with C44 and lists them). *Accept:* `pnpm typecheck`
     green.
  2. **C43-T2 `S/plugins/marketplaces/types.ts` + stub** — `MarketplaceService { list(), add(body), get(id),
     refresh(id), remove(id), stop() }`, `MarketplaceServiceOptions { safeFetch?, githubApi?, githubRaw?,
     githubCodeload? }` (and the same overrides on `InstallerOptions`), `StoredMarketplaceCatalog`; the stub
     `createMarketplaceService(deps, options?)`: `list` → `{ items: [], suggestions: MARKETPLACE_SUGGESTIONS, updates:
     [] }`, the writes throw `not_implemented`, `stop` a no-op. *Accept:* a smoke test per member.
  3. **C43-T3 `S/services/claude-import/types.ts` + stub** — `ClaudeImportService { home(), scan(options?:
     SensitiveOperationOptions), upload(form), apply(body, options?), stop() }` (the plans in memory: `cip_`, 10 min, ≤
     4; dropped on apply, expiry, `key.rotated` and `stop()`); the stub `createClaudeImportService(deps)`: `home()` is
     real (`{ available, reason?, path }` from `env.claudeHome` and one `stat` of the root, never reading a file), the
     rest `not_implemented`; `S/http/routes/claude-import.ts`: `claudeImport.home` answers through the stub (the other
     three routes stay C40's 501 until W12.3). *Accept:* `HF_CLAUDE_HOME=0` → `{ available: false, reason: 'disabled'
     }`; a missing folder → `missing`.
  4. **C43-T4 `S/services/project-definitions/types.ts` + stub** — `ProjectDefinitionsService { read(projectId, path,
     signal?), write(projectId, body), remove(projectId, path, expectedSha256) }`; the stub `not_implemented`. *Accept:*
     typecheck; a smoke test.
  5. **C43-T5 Claude plugin types and stubs** — `S/plugins/claude/types.ts` (`ClaudePluginRead`, the component and
     executable shapes, the reader options), `detect.ts` (`detectPluginLayout(paths: readonly string[])` → `{ format:
     'harness' | 'claude', prefix: string } | null`: a root `plugin.json` → harness, else `.claude-plugin/plugin.json`
     or a Claude component → claude, at the root or inside one top folder; stub: harness when a root `plugin.json`
     exists, else null), `skill-files.ts` (`listPluginSkillFiles(root, baseDir, signal)` and `readPluginSkillFile(root,
     baseDir, file, signal)` → `{ path, content, truncated }`; stub: `[]` / `not_found`). W12.1 implements them.
     *Accept:* typecheck; smoke tests.
  6. **C43-T6 Deps, environment, boot** — the three factories; `SHUTDOWN_STEPS` = **claudeImport** (the plans), data,
     runs, hooks (command, async and SessionEnd processes, the transcript writer), projectMcp, customizations,
     projectConfig, projectFiles, checkpoints, **marketplaces** (in-flight fetches aborted), plugins, mcp, catalog,
     events; `projectDefinitions` holds no state (no step); `BOOT_STEPS` unchanged (the new services are lazy; C43
     confirms). `S/env.ts`: `claudeHome: string | null` (`HF_CLAUDE_HOME`: unset → `os.homedir()/.claude`; `0` → null =
     off; any other value must be absolute, else the boot fails) and `testRemoteUrl: string | null`
     (`HF_TEST_REMOTE_URL`: honored only with `HF_MOCK_PROVIDER=1`, must be `http://127.0.0.1:<port>`, any other value
     fails the boot; ignored with a warning without the mock flag); `deps.ts` builds the plugin-source `safeFetch` with
     C45's factory (open point: C43 and C45 agree on its name through the coordinator and list it). *Accept:*
     `deps.test.ts` checks both orders; `env.test.ts` tables for both variables.
  7. **C43-T7 Database tests** — `db.test.ts`: 23 tables, the migration tags `0000` … `0009`; `upgrade.test.ts`: a
     temporary folder holding only `0000` … `0008` with plugins, personal hooks, customizations and chats, then the real
     folder: `marketplaces` exists and is empty, every plugin row has `format = 'harness'` and `origin` null, every hook
     row `type = 'command'` and null `prompt` / `model` / `options`, every row survives, a second marketplace with the
     same name fails on the unique index. *Accept:* green (the pins `db.test.ts:74`, `upgrade.test.ts:805,977` updated).
  8. **C43-T8 Column classification** — `marketplaces.*`, `plugins.format` / `origin`, `hooks.type` / `prompt` / `model`
     / `options` in `UNSCANNED_COLUMNS` (`S/services/data/references.ts`). *Accept:* `references.test.ts` (every column
     of every table classified).
  9. **C43-T9 Fakes** — `fake-marketplaces.ts`, `fake-claude-import.ts`, `fake-project-definitions.ts`, the fake hooks
     service and snapshot (`importPersonal`, `sessionEnd`, `statusMessage`, scripted prompt results) and the fake
     customizations (`importDefinitions`, `turnedOff`); `createTestApp({ marketplaces?, claudeImport?,
     projectDefinitions? })` with a temp `HF_CLAUDE_HOME` default (never the real home). *Accept:* `fakes.test.ts`.
  10. **C43-T10 Docker** — `Dockerfile` sets `ENV HF_CLAUDE_HOME=0` (the scan off; the comment shows the read-only mount
      recipe `-v ~/.claude:/claude:ro -e HF_CLAUDE_HOME=/claude`). *Accept:* the Dockerfile lint step of CI (if any) and
      a review at the gate.
- **Tests.** The tasks above.
- **Verify.** Server commands.

### C44 chat seams (k5)

- **Mission.** Land every seam of the chat pipeline that the hook, frontmatter and import agents share, so each P12-A
  agent owns its hot file alone: `hooks.ts`, `approval.ts`, `tools.ts`, `steps.ts`, `pipeline.ts`, `model-history.ts`,
  `agent-scope.ts` and `subagent/host.ts` **complete**; every other new module or call site as a stub with its final
  signature, wired at its call site with unchanged behavior.
- **Owned.** `S/chat/**` (not `types.ts`, not `background/types.ts`), `S/http/routes/chats{,.test}.ts` (the SessionEnd
  call site).
- **Read-only highlights.** `.tmp/p12-designs/plan.md` 5, 6 and the Reconciliation rows (Prompt hooks, New events,
  Handler fields, Allow record, Frontmatter, Arguments, Model aliases); `server-import.md` C1 – C5, D1 – D3 and section
  6 (items 6 – 9); `explore-catalog.md` 6 and 7; `SH/util/{hooks,definitions,arguments,agent-state}.ts` (C42),
  `SH/chat.ts` (C40); `S/services/hooks/types.ts` (C43); `S/chat/hooks.ts:108` (`ToolHooks`), `:235`
  (`OUTCOME_DECISIONS`), `:379` (`preToolUse`), `:540` (`forChild`); `S/chat/approval.ts:255` (`applyHookDecision`),
  `:277` (`allowApproves`), `:336` (`createToolApproval`), `:354`; `S/chat/agent-scope.ts` (`AgentRunScope.loadSkill`);
  `S/chat/compaction/guard.ts:135` (`preCompact`), `stream.ts:154` (`compactStream`); `S/http/routes/chats.ts:51`
  (`chats.remove`); the AI SDK `.d.ts`.
- **Tasks.**
  1. **C44-T1 `hooks.ts` (complete)** — `ToolHooks.permissionRequest(call, signal)` (main agent only),
     `ToolHooks.postToolUseFailure(call, error, signal)` (feedback queued for the next step like PostToolUse; `error` ≤
     16 KiB), `ToolHooks.settle(callId, { harnessAsked })` (the PreToolUse record stays pending until `approval.ts`
     settles it, also from the catch path), `RunHooks.postCompact(input, signal)` (observe only; the record placed after
     the marker), `ChildHooks.subagentStart(agent, signal)` (the context for the child's first message); the MCP server
     names for hook targets use `RegisteredMcpServer.claudeName` when present (`mcp__plugin_<name>_<server>__*`
     matches); the activity label (open point 1); `OUTCOME_DECISIONS` unchanged. *Accept:* `hooks.test.ts` with the C43
     fake snapshot (each new member; `harnessAsked` set when a hook allowed and the harness still asks).
  2. **C44-T2 `approval.ts` (complete)** — after the PreToolUse combination, when the result is `user-approval` and the
     call is unanswered: `PermissionRequest` (main agent only); `decision.behavior: 'allow'` approves only through the
     same `allowApproves` gate as a PreToolUse `allow` (`approval.ts:277`; never in plan mode, never for `execute` tools
     or `always` policies), `'deny'` → `denied` ("Blocked by hook: …"), `updatedInput` applied like PreToolUse's; then
     `settle(callId, { harnessAsked })`. *Accept:* `approval.test.ts` (each decision × mode × access; children never run
     it; exactly one PermissionRequest across a request and its approved continuation).
  3. **C44-T3 `tools.ts` (complete)** — `PostToolUseFailure` in the catch paths of `runToolCall` and `streamToolCall`
     (never on an abort; a prompt hook's block → feedback, the turn continues). *Accept:* `tools.test.ts` (a failing
     tool runs it once; an aborted one does not).
  4. **C44-T4 `subagent/host.ts` (complete)** — `SubagentStart` through `ChildHooks.subagentStart` before the child's
     step 0 (matcher = the agent type incl. Claude names), its `additionalContext` added to the child's first user
     message; the child spec carries `maxTurns`, the preloaded `skills` text and `disallowedTools` (W12.6 computes and
     applies them; defaults keep today's behavior). *Accept:* every sub-agent test green unchanged; a seam test with the
     fake snapshot.
  5. **C44-T5 Call sites with unchanged behavior** — `compaction/guard.ts` / `stream.ts`: `RunHooks.postCompact` after
     the marker (trigger `auto` / `manual`); `S/http/routes/chats.ts` `chats.remove` (`:51`):
     `deps.hooks.sessionEnd(chat)` after the delete (detached; delete-all and project deletion never call it);
     `steps.ts` / `pipeline.ts` / `model-history.ts`: whatever the new feedback paths need (the hooks piece already
     appends queued contexts) and the transient `data-activity` with `label`. *Accept:* every existing chat, compaction
     and route test green.
  6. **C44-T6 Stubs with final signatures** — `S/chat/model-aliases.ts` `resolveClaudeModel(alias, context)` (stub: the
     existing fallback); `AgentRunScope.loadSkill(name, signal, options?: { file?, toolCallId? })` (open point 10;
     `S/chat/skills.ts` ignores the options until W12.7); `expandArguments` options at every call site (`commands.ts`,
     `skills.ts`, `prepare.ts`; today's behavior: no names, base 1); qualified names pass through unchanged (resolution
     is W12.7's, open point 8). *Accept:* typecheck; one smoke test per stub; every existing chat test green.
- **Tests.** The tasks above; every existing chat test stays green.
- **Verify.** Server commands.

### C45 processes, mocks, fixtures and the fake remote (k6)

- **Mission.** The mock model `mock:prompt-hook`, the fake remote, the fixture builders, the hook scripts the new events
  need, the `HF_TEST_REMOTE_URL` routing and the GitHub zip helper — **complete** (frozen after the gate; they drive
  every probe and e2e spec). The contract is the section "Mock and fixture contract" below.
- **Owned.** `S/builtin-plugins/{index,index.test}.ts`, `S/builtin-plugins/mock/**`,
  `S/testing/{fake-remote,claude-fixtures,hook-scripts}*`, `S/security/ssrf*`, `S/plugins/install/testing.ts`.
- **Read-only highlights.** `.tmp/p12-designs/plan.md` 9 and 11; `server-plugins.md` section 8; `server-import.md`
  section 8; `claude-formats.md` 1 – 5 (the real shapes the builders mirror); PROVIDERS.md 8 (D17 writes it from this
  file); `S/builtin-plugins/mock/{models,index,hooks}.ts` (`MOCK_MODEL_IDS` `models.ts:53`, `smallModelId: 'echo'`
  `index.ts:236`); `S/security/ssrf.ts:219` (`isBlockedAddress`), `:577` (`createSafeFetch`, `allowLoopback`);
  `S/plugins/install/testing.ts:86,94,241` (`zipOf`, `unixMode`, `tarOf`); `S/security/process-spawn.test.ts:22`.
- **Tasks.**
  1. **C45-T1 `mock:prompt-hook`** (`S/builtin-plugins/mock/prompt-hook.ts`; the 18th mock) — exactly as the contract
     below; `MOCK_MODEL_IDS`, the listing count and `modelCount` pins updated (PROVIDERS.md 8: 21 mock models,
     `modelCount` 18; listed in the report). *Accept:* `mock/index.test.ts` / `models.test.ts`: one case per marker, the
     search order, the usage.
  2. **C45-T2 Fake remote** (`S/testing/fake-remote.ts`) and `createFakeSafeFetch`; `githubZipOf(repo, sha, files)` in
     `S/plugins/install/testing.ts`. *Accept:* a smoke test per route and variant; the request log.
  3. **C45-T3 `HF_TEST_REMOTE_URL` routing** (`S/security/ssrf.ts`) — one factory (proposed `createPluginSourceFetch({
     testRemoteUrl })`) that returns the normal `safeFetch` (https only) without the variable and, with it, a
     `safeFetch` that rewrites `https://<host>/<path>` to `<base>/<host>/<path>` and allows loopback **only** for that
     base (every other address rule unchanged). *Accept:* `ssrf.test.ts` (a rewritten request reaches the fake; a plain
     `http://127.0.0.1` URL is still refused; no rewrite without the variable).
  4. **C45-T4 Fixture builders** (`S/testing/claude-fixtures.ts`) — exactly as the contract below; never committed
     folders. *Accept:* a smoke test per builder (written into `realpath(mkdtemp())`, parsed with the C41 / C42
     helpers).
  5. **C45-T5 Hook scripts** (`S/testing/hook-scripts.ts`) — `permission-allow` / `permission-deny`
     (`hookSpecificOutput.decision.behavior`), `print-args` (writes each argument on its own line to `.hook-args`, for
     exec-form quoting), `agent-context` (`hookSpecificOutput.additionalContext` for SubagentStart); POSIX `sh`, read
     stdin first, no `jq`. *Accept:* a smoke test per script.
  6. **C45-T6 Pins** — `builtin-plugins/index.test.ts` (the mock listing), the spawn allowlist unchanged at 3 modules.
- **Tests.** The tasks above.
- **Verify.** Server commands.

### C46 web skeleton (k4)

- **Mission.** Freeze the web side of Phase 12: every new test id, the Marketplaces route and nav row, the stub
  components with their final props, emits and root test ids, the `marketplaces` store and the pure modules (inert),
  `useClaudeImport`, the `InstallReview` extraction, the frozen-signature CCRs of plan section 8 as types, the event and
  session wiring (open point 3) and the mounts and emit chains through the hot files.
- **Owned.** `W/utils/testids.ts`, `W/utils/testing/**`, `W/pages/plugins/marketplaces.vue`,
  `W/pages/settings/customize.vue`, `W/components/plugins/{marketplaces,install,detail,list}/**`,
  `W/components/app-shell/PluginsNav*`, `W/components/settings/{claude-import,customize,agent,data}/**`,
  `W/components/projects/{trust,mcp}/**`, `W/components/chat/{agent,hooks,parts,composer}/**`,
  `W/stores/{marketplaces,customizations,hooks,plugins,ui}*`,
  `W/composables/{useClaudeImport,useServerEvents,useChatSession}*`.
- **Read-only highlights.** UI.md 2.19, 5.4, 5.5, 6, 7.34, 8.13, 9.14, 10.9, 11.9, 13.13, 14, 15;
  `.tmp/p12-designs/web-process.md` part (1) (with the reconciliation above);
  `SH/schemas/{marketplaces,claude-import,project-definitions,plugins,hooks}.ts`,
  `SH/util/{claude-plugins,claude-import,hooks,definitions}.ts`; facts: `PluginsNav.vue:54-56` (`activePluginId` skips
  only `new`), `W/stores/ui.ts:13` (`InstallSource`), `install.ts:21-29` (`InstallTab`), `:284` (`runCommands` reads a
  harness manifest), `InstallDialog.vue:104` (the step), `ProjectTrustDialog.vue:104-134` (`selectAllState`,
  `selectAll`), `:485`, `W/components/ui/checkbox/Checkbox.vue:20-32` (the default slot gets reka's slot props),
  `HookRow.vue:61` (the untrusted check), `:207` (the project menu), `CustomizationRow.vue:272-276` (Review… / View…),
  `customize/hooks.ts:20` (`HookAction`), `:23` (`HookDraft`), `:45` (`HOOK_EVENT_INFO`), `:79` (`promptIgnored`),
  `:277` (`importHooks`), `HookEditor.vue:46` (`mode`), `DataImportResultPanel.vue:29`.
- **Tasks.**
  1. **C46-T1 Test ids** — the ids of UI.md 13.13 in `utils/testids.ts` (key = the camelCase of the id) under a `//
     Claude Code ecosystem (Phase 12)` comment. The draft list (web-process.md, reconciled; UI.md 13.13 wins on any
     difference, reported): marketplaces `plugins-marketplaces`, `marketplaces-page`, `marketplace-add`,
     `marketplace-add-dialog`, `marketplace-add-source` (`data-value` github | url | folder), `marketplace-add-input`,
     `marketplace-add-submit`, `marketplace-add-error`, `marketplace-suggestion`, `marketplace-suggestion-add`,
     `marketplace-suggestion-dismiss`, `marketplace-row` (`data-marketplace-id`, `data-state`), `marketplace-row-menu`,
     `marketplace-refresh`, `marketplace-refresh-all`, `marketplace-remove`, `marketplace-remove-confirm`,
     `marketplace-search`, `marketplace-category`, `marketplace-entry` (`data-name`, `data-state` available |
     installed | update | unsupported), `marketplace-entry-install`, `marketplace-entry-update`, `marketplace-empty`,
     `marketplace-error`, `marketplace-install-dialog`; plugins `install-tab-github`, `install-github-repo`,
     `install-github-ref`, `install-github-path`, `plugin-update-available` (`data-version`), `plugin-update`; import
     `customize-import-claude`, `data-import-claude`, `claude-import-dialog` (`data-step`), `claude-import-source`
     (`data-value` folder | zip | server), `claude-import-folder-input`, `claude-import-config-input`,
     `claude-import-zip-input`, `claude-import-scan`, `claude-import-continue`, `claude-import-preview`,
     `claude-import-group` (`data-kind`, `data-count`), `claude-import-select-all`, `claude-import-item` (`data-kind`,
     `data-status`, `data-name`), `claude-import-select`, `claude-import-resolution`, `claude-import-instructions-mode`,
     `claude-import-submit` (`data-count`), `claude-import-back`, `claude-import-error`, `claude-import-result`; project
     files `project-file-editor` (`data-kind`, `data-path`), `project-file-content`, `project-file-save`,
     `project-file-conflict`, `project-file-reload`, `project-file-overwrite`, `project-file-error` (`data-code`),
     `project-file-discard-confirm`; hooks `hook-type` (`data-value`), `hook-prompt`, `settings-hook-model`,
     `settings-model-alias` (`data-name`); frontmatter `customization-disallowed-tools`, `customization-max-turns`,
     `customization-color`, `customization-skills`, `customization-when-to-use`, `customization-fork`,
     `customization-fork-agent`; new values on existing ids `hook-row[data-source=plugin][data-state=pending]`
     (untrusted plugin rows), `hook-row[data-kind=prompt]`, `plugin-hook[data-kind=prompt]`, `data-state="still-asks"`
     on `hook-note` / `tool-row-hook` (`harnessAsked`), `project-trust-select-all[data-state=indeterminate]`,
     `customization-edit` / `customization-delete` and `hook-edit` / `hook-delete` on project rows,
     `hook-editor[data-mode=project]`, the five new `hook-event` values, qualified names in
     `slash-menu-item[data-value]` (UI.md 13.13 is the list: 70 ids).
  2. **C46-T2 Route and nav row** — `W/pages/plugins/marketplaces.vue` (a thin page around the `MarketplacesView` stub;
     the static route wins over `[id].vue`); `PluginsNav` row "Marketplaces" (`plugins-marketplaces`, `Store` icon, a
     count badge slot) between Install… and Browse; `activePluginId` skips `new` and `marketplaces`. *Accept:*
     `PluginsNav.test.ts`, a route test.
  3. **C46-T3 Stub components** — each renders its root test id and declares exactly (UI.md 10.9 wins where it is more
     precise; report the difference):
     ```ts
     MarketplacesView          {}                                         // plugins/marketplaces/
     MarketplaceSuggestion     {}                                         // emits add: [], dismiss: []
     MarketplaceStrip          { items: readonly MarketplaceSummary[]; selectedId: string | null;
                                 busyIds?: readonly string[] }
                               // emits select: [string | null], refresh: [string], remove: [string]
     MarketplaceAddDialog      { open: boolean }    // emits update:open: [boolean], added: [MarketplaceDetail]
     MarketplaceEntryRow       { entry: MarketplaceEntryView; busy?: boolean }   // emits install: [], update: []
     MarketplaceInstallDialog  { open: boolean; marketplaceId: string | null; entryName: string | null;
                                 mode: 'install' | 'update' }   // emits update:open: [boolean], installed: [string]
     InstallReview             { inspection: PluginInspection; request: PluginInstallRequest;
                                 sourceLabel: string }                    // plugins/install/
                               // emits back: [], installed: [PluginDetail], stale: []
     PluginUpdateBanner        { pluginId: string }   // plugins/detail/; opens MarketplaceInstallDialog (update)
     ClaudeImportDialog        { open: boolean }                          // settings/claude-import/
                               // emits update:open: [boolean], imported: [ClaudeImportApplyResult]
     ClaudeImportSource        { busy: boolean; serverHome: ClaudeImportHome | null }
                               // emits folder: [File[], File | null], zip: [File], scan: []
     ClaudeImportPreview       { plan: ClaudeImportPlan; selection: ClaudeImportSelection }
                               // emits update:selection: [ClaudeImportSelection]
     ClaudeImportGroup         { kind: ClaudeImportKind; items: readonly ClaudeImportPlanItem[];
                                 selection: ClaudeImportSelection }
                               // emits update:selection: [ClaudeImportSelection]
     ClaudeImportItem          { item: ClaudeImportPlanItem; selected: boolean; choice: ClaudeImportChoice }
                               // emits toggle: [], update:choice: [ClaudeImportChoice]
     ClaudeImportResult        { result: ClaudeImportApplyResult }
     ProjectFileEditor         { open: boolean; projectId: string | null; entry: ProjectFileTarget | null }
                               // settings/customize/; emits update:open: [boolean],
                               // saved: [{ path: string; pending: number }], review: [string | undefined]
     ```
     The type names (`MarketplaceEntryView`, `ClaudeImportSelection`, `ClaudeImportChoice`, `ProjectFileTarget`) are
     C46's, exported from the pure modules; the DTO types come from `@harness-forge/shared`. *Accept:* one stub mount
     test per component (root test id, props accepted).
  4. **C46-T4 Stores, composables and pure modules (inert, typed)** — `useMarketplacesStore`
     (`W/stores/marketplaces.ts`): getters `items`, `byId(id)`, `entries(id | null)`, `updateCount`; actions `fetchAll({
     maxAgeMs? })`, `add(source)`, `refresh(id)`, `refreshAll()`, `remove(id)`, `applyEvent(event)`
     (`marketplace.changed`, `plugin.changed`), `refreshLoaded()`. `useClaudeImport()` (no store): `serverHome()`,
     `scanServer()`, `planFromFiles(files, claudeJson?)`, `planFromZip(file)`, `apply(planId, selection)` (throws 403
     `login` for the component's `useFreshAuth().run`). Pure modules with final signatures:
     `plugins/marketplaces/marketplaces.ts` (`parseMarketplaceInput(text)` over SH `parseMarketplaceShorthand`,
     `entryState(entry, plugins)`, `sourceText`, `filterEntries`, `categoriesOf`, `OFFICIAL_MARKETPLACE`),
     `settings/claude-import/claude-import.ts` (`pickClaudeFiles(fileList)` over SH `isClaudeHomeImportPath` + the caps,
     `defaultSelection`, `groupState` → `boolean | 'indeterminate'`, `needsFreshAuth(plan, selection)`, `resultLines`,
     `STATUS_TEXT`), `plugins/install/install.ts` (`InstallTab` + `github`, the draft's `githubRepo` / `githubRef` /
     `githubPath`, `parseGithubSpec('owner/repo#ref')`). UI.md 11.9 wins on any difference. *Accept:* store shape tests;
     `pickClaudeFiles` complete (it guards the upload) with a table test; the modules type-check.
  5. **C46-T5 `InstallReview` extraction** — the preview, trust, inline password and install steps move from
     `InstallDialog` into `InstallReview` with unchanged behavior (one fresh-auth flow, reused by
     `MarketplaceInstallDialog`). *Accept:* `InstallDialog.test.ts` green unchanged; an `InstallReview` mount test.
  6. **C46-T6 Frozen-signature CCRs as types** — `W/stores/ui.ts` `InstallSource` + `'github'`; `W/stores/plugins.ts` an
     optional `updates` filter (first cut); `W/stores/customizations.ts` `projectSource(projectId, entry)` and
     `saveProjectFile(projectId, body)`; `W/stores/hooks.ts` `saveProjectHook(projectId, target, hooks,
     expectedSha256)`; `HookDraft` + `type`, `prompt`, `model`, `continueOnBlock`; `HookEditor.mode` + `'project'` and
     the prop `target?: ProjectHookTarget`; `CustomizationDraft` + the new keys; `HookAction` + `'trust-plugin'`;
     `CustomizationViewer` emit `edit`; `useChatSession().hookActivity` + `label` (open point 1). *Accept:* typecheck;
     every existing test green.
  7. **C46-T7 Mounts, chains and events** — `customize.vue`: `?import=claude` opens the `ClaudeImportDialog` stub and
     the header button `customize-import-claude`; Settings → Data: the link `data-import-claude` (→ `?import=claude`);
     `PluginDetailView`: the `PluginUpdateBanner` slot; `PluginCard`: the `plugin-update-available` badge slot;
     `CustomizationRow` (project rows): Edit… → `ProjectFileEditor` (stub) through `CustomizeSettings`; `HookRow`: the
     `trust-plugin` menu item and the project Edit…; `ProjectMcpDialog`: **Edit .mcp.json…**
     (`data-action="edit-mcp-json"`, also in the empty state) → the project file editor with kind `mcp`;
     `useServerEvents`: `marketplace.changed` and `plugin.changed` → the marketplaces store, `refreshLoaded()` on
     reconnect (complete); `useChatSession`: the activity label (complete). *Accept:* the existing `PluginsNav`,
     `InstallDialog`, `PluginDetailView`, `PluginCard`, `CustomizeSettings`, `CustomizationRow`, `HookRow`,
     `HookEditor`, `DataSettings`, `useServerEvents`, `useChatSession` tests stay green; mount tests for the new mounts.
- **Tests.** The tasks above; `W/components/template-literals.test.ts` stays green (no `//` in component prop values).
- **Verify.** Web commands (`typecheck:fast` needs the coordinator's `.nuxt`; import new components by path).

### G12B upgrade and seam probes (:8898)

- **Mission.** Write `.tmp/gates/P12-0b/{upgrade-probe-v17,seam-probe-v18}.mjs` during the wave (from the Phase 11
  `.tmp/gates/P11-0b/{upgrade-probe-v16,seam-probe-v17}.mjs` and `probe-lib.mjs`) and run them on :8898 after the
  coordinator's build signal; report every check ("spec differs" with the evidence when the code is right and the spec
  is not).
- **Owned.** `.tmp/gates/P12-0b/**` (not K3S's seed files).
- **Checks.** See Gate P12-0b steps 5 and 6.

### Wave P12-0b ownership

The audit cannot express "except": `S/db/schema.ts` matches C43's glob but is the coordinator's K3 edit;
`S/chat/types.ts` matches C44's glob but is C43's; `S/chat/background/types.ts` stays frozen; `S/testing/api-samples.ts`
stays C40's file from P12-0a (untouched in P12-0b). C43, C44, C45 and C46 list the count pins and fixtures outside their
globs in their reports (`*-test-fixes`, `C43-compile-fixes`).

```json
{
  "wave": "P12-0b",
  "agents": {
    "K3": [
      "apps/server/src/db/schema.ts",
      "apps/server/drizzle/**"
    ],
    "C43": [
      "apps/server/src/types.ts",
      "apps/server/src/deps*.ts",
      "apps/server/src/env*.ts",
      "apps/server/src/main.ts",
      "apps/server/src/db/**",
      "apps/server/src/chat/types.ts",
      "apps/server/src/plugins/types.ts",
      "apps/server/src/plugins/claude/{types,detect,skill-files}.ts",
      "apps/server/src/plugins/marketplaces/**",
      "apps/server/src/services/{claude-import,project-definitions}/**",
      "apps/server/src/http/routes/claude-import.ts",
      "apps/server/src/registry/types.ts",
      "apps/server/src/services/{hooks,customizations}/types.ts",
      "apps/server/src/services/data/references.ts",
      "apps/server/src/services/data/references.test.ts",
      "apps/server/src/testing/{create-test-app,fakes,fake-marketplaces,fake-claude-import,fake-project-definitions,fake-hooks,fake-customizations}*",
      "Dockerfile"
    ],
    "C44": [
      "apps/server/src/chat/**",
      "apps/server/src/http/routes/chats.ts",
      "apps/server/src/http/routes/chats.test.ts"
    ],
    "C45": [
      "apps/server/src/builtin-plugins/index.ts",
      "apps/server/src/builtin-plugins/index.test.ts",
      "apps/server/src/builtin-plugins/mock/**",
      "apps/server/src/testing/{fake-remote,claude-fixtures,hook-scripts}*",
      "apps/server/src/security/ssrf*",
      "apps/server/src/plugins/install/testing.ts"
    ],
    "C46": [
      "apps/web/app/utils/testids.ts",
      "apps/web/app/utils/testing/**",
      "apps/web/app/pages/plugins/marketplaces.vue",
      "apps/web/app/pages/settings/customize.vue",
      "apps/web/app/components/plugins/{marketplaces,install,detail,list}/**",
      "apps/web/app/components/app-shell/PluginsNav*",
      "apps/web/app/components/settings/{claude-import,customize,agent,data}/**",
      "apps/web/app/components/projects/{trust,mcp}/**",
      "apps/web/app/components/chat/{agent,hooks,parts,composer}/**",
      "apps/web/app/stores/{marketplaces,customizations,hooks,plugins,ui}*",
      "apps/web/app/composables/{useClaudeImport,useServerEvents,useChatSession}*"
    ],
    "G12B": [
      ".tmp/gates/P12-0b/**"
    ]
  },
  "allow": [
    "docs/ROADMAP.md",
    "docs/DECISIONS.md",
    "AGENT.md",
    "docs/phases/phase-12-v1-8.md",
    ".tmp/**"
  ]
}
```

### Wave P12-0b cross-agent contracts

| Producer → consumer | Contract |
|---|---|
| K3 → C43, W12.2, W12.5 | `0009`: `marketplaces` (unique `name`), `plugins.format` / `origin`, `hooks.type` / `prompt` / `model` / `options` |
| C43 → C44, W12.1 – W12.7 | `MarketplaceService`, `ClaudeImportService`, `ProjectDefinitionsService` + stubs; `PluginRecord.format` / `origin`, `inspectDirectory` options; `HookCommandsRegistration.env` / `prompts`, `claudeName`; `importPersonal`, `sessionEnd`, `HookRunInput` additions, `HookSnapshot.statusMessage`; `importDefinitions`, `turnedOff`; `S/plugins/claude/types.ts`, `detectPluginLayout`, the skill-files helper; `env.claudeHome` / `env.testRemoteUrl`; `createTestApp` options and the fakes; the start / stop order |
| C44 → W12.5 – W12.7 | `hooks.ts` / `approval.ts` / `tools.ts` / `steps.ts` / `pipeline.ts` / `model-history.ts` / `agent-scope.ts` / `subagent/host.ts` (complete: `permissionRequest`, `postToolUseFailure`, `settle`, `postCompact`, `subagentStart`, the activity label), the stubs (`resolveClaudeModel`, `loadSkill` options, `expandArguments` options at the call sites, the `sessionEnd` and PostCompact call sites) |
| C45 → W12.1 – W12.7, G12P, W12.14 | `mock:prompt-hook` (PROVIDERS.md 8), the fake remote + `createFakeSafeFetch` + `githubZipOf`, the fixture builders, the hook scripts, the `HF_TEST_REMOTE_URL` factory |
| C45 ↔ C43 | the plugin-source `safeFetch` factory name (agreed through the coordinator) |
| C46 → W12.8 – W12.13 | the stub components, the `marketplaces` store, `useClaudeImport`, the pure modules, `InstallReview`, the frozen-signature CCRs, the event and session wiring (frozen) |
| C46 → everyone | `utils/testids.ts` (frozen after the gate) |

### Gate P12-0b

1. `node scripts/audit-ownership.mjs .tmp/waves/P12-0b.json`
2. Inspect `0009` (K3 step 3).
3. `nuxi prepare` → `pnpm check` → `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
4. `mv .tmp/e2e .tmp/e2e-old-p12-0b` (a cached mock listing hides `mock:prompt-hook`; `mv`, not `rm -rf`) → `pnpm
   start:e2e` → `pnpm test:e2e` (191 still green).
5. **Upgrade probe (G12B)** on a fresh copy of the K3S seed (never on `.tmp/e2e`, never on the seed itself), on :8898:
   ```sh
   d=.tmp/gates/P12-0b/upgrade-$(date +%s); cp -R .tmp/upgrade-v17 "$d"   # data + roots
   # before boot, by SQL: projects.path → "$PWD/$d/roots/<p>", the global stdio server's path → the copied fixture
   HF_MOCK_PROVIDER=1 HF_OFFLINE=1 HF_PORT=8898 HF_DATA_DIR="$d/data" \
     HF_WORKSPACE_ROOTS="$PWD/$d/roots" HOME="$d/home" node apps/server/dist/main.mjs &
   # through node + @libsql/client, ids from .tmp/upgrade-v17-ids.json:
   #   SELECT count(*) FROM __drizzle_migrations;                          -> 10
   #   SELECT count(*) FROM marketplaces;                                  -> 0
   #   SELECT count(*) FROM plugins WHERE format <> 'harness';            -> 0
   #   SELECT count(*) FROM hooks WHERE type <> 'command';                -> 0
   #   PRAGMA foreign_key_check; PRAGMA integrity_check;                  -> no rows; ok
   #   counts of chats, messages, workspace_changes, customizations, background_tasks, hooks, project_trust -> seeded
   ```
   Then, logged in with the seeded password: every seeded chat opens (the stored expansions, `data-hook` parts and the
   hook carrier byte-identical to the seed's); `GET /projects/<p>/trust` lists every seeded approval as `approved`
   **with the seeded sha256** (v1 hashes unchanged) and the pending item still `pending`; the approved hook runs in a
   `mock:hooks` turn (the guard's record), the approved `.mcp.json` server's tool is offered, the approved command's
   spans run; the v1.8-only `prompt` and `SessionEnd` hooks are listed and `pending` (parsed, not run: no sentinel);
   `GET /settings` has `hookModelRef: null` and `modelAliases` all null; `hook-pack` is still trusted and active; the
   v1.7 backup zip restores its `!` command with `enabled: false`. Stop the probe server (kill by port).
6. **Seam no-op probe (G12B)** — the Phase 11 seam probe (`.tmp/gates/P11-0b/seam-probe-v17.mjs` checks, on a copy of
   the roots) passes unchanged; `GET /models` lists `mock:prompt-hook`; a restart with `HF_CLAUDE_HOME=0` answers `GET
   /claude-import/home` with `{ available: false, reason: 'disabled' }`; `HF_CLAUDE_HOME=relative/path` fails the boot;
   `HF_TEST_REMOTE_URL=http://example.com` (or without `HF_MOCK_PROVIDER=1`) fails / is ignored as `S/env.ts` documents;
   the other eleven new routes still answer 501.
7. FREEZE additions (see "FREEZE in Phase 12") → ROADMAP + wave log → commit `feat: add phase 12 schema, migration and
   skeletons`.

---

## Mock and fixture contract (complete and frozen after P12-0b)

C45 builds this; PROVIDERS.md 8 "Prompt hook mock (Phase 12)" (D17) is the probe contract for the mock and wins on any
difference (reported); this section summarizes it.

### `mock:prompt-hook`

- The 18th mock model (`S/builtin-plugins/mock/prompt-hook.ts`): `kind: 'chat'`, no capabilities (it never calls a
  tool), listed and visible like the other chat mocks, so it can be chosen as the Hook model; it streams and answers at
  once (no waits), ignores the reasoning setting and the output-token cap; usage fixed at 10 input / 5 output tokens
  (`finishReason: 'stop'`).
- **Input**: the text of the call's user messages in order (the runner sends the hook's prompt with `$ARGUMENTS`
  replaced by the hook input JSON, or the JSON appended). The mock answers from the **first marker** in that text, so a
  marker in the hook's prompt wins over one inside the hook input (unless the prompt places `$ARGUMENTS` before its own
  marker); the system text is never searched:

  | Marker | Answer (the whole reply) | |---|---| | `[[ph:ok]]` | `{"ok":true}` | | `[[ph:deny R]]` |
  `{"ok":false,"reason":"R"}` (`R` = the text between `deny` and `]]`, trimmed; may be empty) | | `[[ph:impossible
  R]]` | `{"ok":false,"reason":"R","impossible":true}` | | `[[ph:fenced]]` | the line `Here is my answer:`, then
  `{"ok":false,"reason":"fenced"}` inside a `json` code fence (proves the fence stripping) | | `[[ph:invalid]]` | `I
  cannot decide.` (no JSON: a non-blocking error) | | none | `{"ok":true}` |

- Selected through the setting `hookModelRef` or the handler's `model` (`mock:prompt-hook`). The mock provider's
  `smallModelId` stays `echo` (titles), so a prompt hook without a model runs on `mock:echo`, whose answer is not a
  verdict: the "invalid answer" path (open point 13).
- End-to-end with the Phase 11 mock: a PreToolUse prompt hook + `mock:hooks` `call write_file {"path":"a.txt",
  "content":"[[ph:deny x]]"}`: without `continueOnBlock` the call is denied ("Blocked by hook: x") and the turn ends;
  with `continueOnBlock: true` the reply reads `Called write_file: denied | Blocked by hook: x | hooks: none`;
  `[[ph:ok]]` never approves (in Ask mode the card still shows); `[[ph:invalid]]` → the call runs and a note reads "A
  PreToolUse hook failed"; a Stop prompt hook holding `[[ph:deny run the tests]]` → a turn with `origin: 'hook'`.
  Timeouts are tested with `MockLanguageModelV4` in unit tests, never with the mock.

### The fake remote (`S/testing/fake-remote.ts`)

- A loopback HTTP server on port 0 (started by tests and probes, stopped at the end) serving, under host prefixes
  (`<base>/<host>/<path>`): `api.github.com/repos/{o}/{r}/commits/{ref}` (`Accept: application/vnd.github.sha` → the
  40-hex sha; an unknown repo 404; a rate-limit switch → 403 with `x-ratelimit-remaining: 0`),
  `raw.githubusercontent.com/{o}/{r}/{sha}/{path}` (a file at that commit), `codeload.github.com/{o}/{r}/zip/{sha}` and
  `/zip/refs/heads/{ref}` (a zip from `githubZipOf`: top folder `<r>-<sha>/`, the zip comment = the sha; no redirects),
  archive hosts (registered bytes at a path) and, for npm entries, `registry.npmjs.org` (registered packuments and
  tarballs).
- Repositories are registered in memory (`files` per commit) with **movable refs** (a ref moved to a new commit), and
  variants: oversize, a traversal entry, a link entry, a wrong zip comment, a wrong top folder, exec bits
  (`unixMode(0o755)`).
- Every request is logged (`{ method, host, path, status }`); probes assert that this log is the only network.
- `createFakeSafeFetch(routes)` — a `SafeFetch` for unit tests mapping `https://api.github.com/…`,
  `https://raw.githubusercontent.com/…`, `https://codeload.github.com/…` and archive URLs to in-memory responses,
  recording the calls and refusing anything unmapped; injected through `InstallerOptions` / `MarketplaceServiceOptions`
  `{ safeFetch, githubApi, githubRaw, githubCodeload }`.
- `githubZipOf(repo, sha, files)` — in `S/plugins/install/testing.ts` next to `zipOf` / `unixMode` / `tarOf`.
- `HF_TEST_REMOTE_URL` (test-only, `S/env.ts` + `S/security/ssrf.ts`): honored only with `HF_MOCK_PROVIDER=1`; must be
  `http://127.0.0.1:<port>`; every plugin-source and marketplace fetch to `https://<host>/<path>` goes to
  `<base>/<host>/<path>`, and loopback is allowed only for that base.

### The fixture builders (`S/testing/claude-fixtures.ts`)

Builders return in-memory file maps (path → text or bytes + mode) and write them into a given `realpath(mkdtemp())`
folder; **nothing is committed**. Proposed names (C45 fixes them): `claudePluginFiles(name)`,
`claudeMarketplaceFiles()`, `fakeClaudeHomeFiles()`, `writeFileTree(root, files)`.

- **Claude plugins**: `review-kit` — `.claude-plugin/plugin.json` with `userConfig` (a url `API_URL` and a sensitive
  `API_TOKEN`), an http MCP server using `${user_config.API_TOKEN}` and a stdio server running the dependency-free
  `mcp-min.mjs` fixture (one of them in `.mcp.json`), `commands/review.md`, `commands/db/migrate.md`,
  `commands/clean_gone.md`, `agents/code-reviewer.md` (`model: sonnet`), `skills/pdf/{SKILL.md, reference.md,
  scripts/fill.sh}` (0755), `output-styles/terse.md`, `hooks/hooks.json` (a PostToolUse handler running
  `${CLAUDE_PLUGIN_ROOT}/hooks/format.sh` + an unknown event + an `http` handler), `hooks/format.sh` (0755),
  `.lsp.json`, `bin/tool`; `notes-only` (commands only, no manifest, no trust needed); `single-skill` (a root
  `SKILL.md`); `broken` (invalid JSON, `../` paths); a variant whose hook runs `${CLAUDE_PLUGIN_ROOT}/scripts/mark.sh`
  (writes `id -u`; the Docker check).
- **A marketplace**: `.claude-plugin/marketplace.json` with one entry of every source kind (relative, `github`, a
  github.com git `url`, `git-subdir`, `archive` + `sha256`, `npm`, `npm` with a custom registry, `command`, git on
  another host), a `strict: false` entry with inline components, invalid entries, and the plugin folders its relative
  entries point at.
- **A fake home**: `.claude/{agents,commands (nested),skills,output-styles}`, `settings.json` (command and prompt hooks,
  `permissions.allow` Bash rules incl. refused prefixes, a whole-tool `deny`, an `ask` rule, a non-Bash rule, `env`,
  `outputStyle`, `model`, `statusLine`, `apiKeyHelper`, `enabledPlugins`, `extraKnownMarketplaces`), `CLAUDE.md` with an
  `@path` line, a sibling `.claude.json` (top-level `mcpServers`: stdio + http with a `${VAR}` header; a
  `projects[<path>].mcpServers` entry), and the canaries `oauthAccount`, `primaryApiKey`, `.credentials.json`,
  `projects/x.jsonl`, `history.jsonl`, `settings.local.json`; every canary value is a unique `HF_CANARY_…` string that
  the hygiene checks search for in answers and logs.
- Users: unit tests (C41 / C42 use in-memory lists of their own; server tests use the builders), G12B / G12P (written
  into their run folders under `.tmp/gates/`), W12.14 (its own temp folders, outside the repository).

---

## Wave P12-A — features

Thirteen agents and the gate-probe agent G12P in one launch against the P12-0b checkpoint. Only server agents get slots
(k1 – k7); web agents run no server; G12P runs its probes on :8896 – :8898 only after the coordinator's build signal.

### Coordinator actions

- Before the launch: the ownership file `.tmp/waves/P12-A.json` (below), agent prompts with a "what exists now" section,
  their section of this file and "Rules for every Phase 12 agent"; the regression copies of open point 18.
- During the wave: when every server and web agent has reported, the coordinator runs `nuxi prepare` → `pnpm build` and
  sends G12P the build signal (`BUILD_READY`); G12P then runs its probes while the coordinator runs e2e on :8899. Facts
  one agent reports that another needs are relayed with SendMessage.
- **At the gate**: audit; batch the CCRs; `nuxi prepare`; the gate commands and probes below; the screenshot review;
  `pnpm audit`; red items become W12.16 (server) / W12.17 (web) tasks with their globs; the reports are digested into
  `.tmp/waves/P12-A-notes.md` for W12.15. **First cuts if the wave overflows** (in this order): the tool-deny import →
  the category / tag filters of the Marketplaces page → named arguments (`arguments`, `$name`) → the agent color in
  tasks → the Claude plugin npm / archive sources → `PostCompact` / `SessionEnd` → the handler `async` / `if` fields →
  the zip intake of the import → the instructions "Replace" mode → the GitHub folder field of the install dialog.

### Wave rules

- Import new components explicitly by path; no `nuxt prepare` mid-wave.
- A new test id, a contract change or a frozen-file edit is a CCR in the report (with a local adapter).
- No doc edits ("For W12.15" notes in the report instead).
- Hot files have exactly one owner (the list in "Rules for every Phase 12 agent");
  `S/chat/{hooks,approval,tools,steps,pipeline,markers,model-history,agent-scope}.ts`, `S/chat/subagent/host.ts`,
  `S/workspace/shell.ts` and `S/mcp/stdio-transport.ts` are frozen.
- Server agents implement behind the C43 / C44 seams and test against them with `MockLanguageModelV4`, the C43 fakes,
  the C45 mock, fake remote, builders and hook scripts; where a feature needs another agent's piece (W12.2 needs W12.1's
  reader through `inspectDirectory`, W12.3 needs W12.7's `importDefinitions` and W12.5's `importPersonal`, W12.6 needs
  W12.5's prompt runner, W12.7 needs W12.1's skill-files helper, W12.5 / W12.6 need W12.7's `resolveClaudeModel`, the
  web agents the routes), test against the frozen signature with a fake; the real round trips are probed at the gate.
- The mock models are frozen: a test that needs another script uses `MockLanguageModelV4` directly.
- Network in tests: `createFakeSafeFetch` or the fake remote only; never a real host. Home folders: a temp
  `HF_CLAUDE_HOME` from the builders only. Hook processes: `S/testing/hook-scripts.ts` scripts in `realpath(mkdtemp())`
  folders, small timeouts, every pid asserted dead.

### W12.1 claude-plugin-server (k1)

- **Mission.** The Claude Code plugin format on the server: layout detection, the reader and its component path rules,
  the whole-tree trust hash, variables and `userConfig`, the MCP / hook / command / agent / skill / style registration
  with qualified names, the skill-files helper, the plugin info, the host's format dispatch, the registry, the catalog
  mapping of plugin entries and the example `claude-review-kit`.
- **Owned.** `S/plugins/claude/**` (not `types.ts`), `S/plugins/{formats,declarative,loader,context,host}*`,
  `S/registry/**` (not `types.ts`), `S/services/customizations/plugins*`, `examples/plugins/claude-review-kit/**`,
  `examples/plugins/examples.test.ts`.
- **Read-only highlights.** ADR-053, ADR-052; the plan's Reconciliation rows (Plugin format, Detection, Plugin id,
  Version, Trust, Exec bits, Names, MCP ids, Variables, userConfig, Plugin skill files, Plugin commands, Plugin hooks)
  and section 1; `server-plugins.md` D1 – D15, D19, D22, the variable table and section 5; `claude-formats.md` 1;
  PLUGINS.md "Claude Code plugins"; `SH/util/claude-plugins.ts` (C41),
  `SH/util/{definitions,hooks,mcp-config,trust,arguments}.ts` (C42); `S/plugins/types.ts`, `S/plugins/claude/types.ts`,
  `S/registry/types.ts` (frozen, C43); `S/services/customizations/discover.ts:124` (`readDefinitionFile`);
  `S/plugins/loader.ts:38` (`MANIFEST_MAX_BYTES`), `:80` (`contentHash`), `:85` (`pathPin`); `S/plugins/host.ts:271`
  (`contributionsOf`), `:277` (`isPinned`), `:289` (`required`), `:317` (`runsCode`), `:331` (`editable`), `:536` /
  `:560` (`startRuntime`), `:700` / `:707` (`loadUserLocked`, hand-placed folders), `:749`, `:1145` (`trust`), `:1170`
  (`updateSettings`); `S/plugins/declarative.ts:442` (`registerDeclaredContributions`), `:475`;
  `S/plugins/context.ts:443` (`registerHookCommands`); `S/registry/validate.ts:273`, `:333`, `:354`, `:427`
  (`validateHookCommands`, the > 50 throw `:437`); `S/registry/hook-commands.ts:1-8`;
  `S/services/customizations/plugins.ts:44-45` (commands mapped with `argumentHint: null`), `:93`;
  `S/mcp/index.ts:341-350` (`assertTrusted`), `:375` (stdio cwd = the plugin folder); `S/chat/skills.ts:143`
  (`listSkillFiles`, the project-skill precedent).
- **Tasks.**
  1. **W12.1-T1 Detection and reader** (`detect.ts`, `reader.ts`, `layout.ts`, `files.ts`, `formats.ts`) — implement
     C43's `detectPluginLayout`; `readClaudePluginDirectory(dir, { overlay?, nameHint?, digest })` →
     `PluginDirectoryRead` (the synthesized manifest: id per `claudePluginId`, name = `displayName ?? name` ≤ 64, the
     version rule (`plugin.json` → entry → 12-char commit / archive sha → `0.0.0`; the DTO semver = the raw value when
     valid, else `0.0.0+<sanitized>`), `engines.harness: '^1.6.0'`, description ≤ 280, `author.name`, an http(s)
     homepage, `settings` from `userConfig`; no `contributes`) + `ClaudePluginRead`; the layout rules (`commands` paths
     **replace** the `commands/` scan and subfolders become segments, the object form adds inline commands; `agents`
     replace; `skills` add (`.` = the root `SKILL.md`); `outputStyles` replace; `hooks` merge with `hooks/hooks.json`;
     `mcpServers` merge with `.mcp.json`, wrapper or flat map, the later name wins); every path `./…` inside the root
     (realpath; `path-outside-root` otherwise); files read through `readDefinitionFile` with the plugin root (no links,
     regular files, ≤ 64 KiB, NUL probe) and parsed with `parseDefinition(kind, text, { fileName | folderName })` (the
     new keys); stems slugified (`clean_gone` → `clean-gone`, info); `S/plugins/formats.ts`
     `readPluginDirectoryFor(format, dir, opts)` used by the host. C41 facts (`SH/util/claude-plugins.ts`): manifest
     paths are stored without the leading `./` (the root is `.`; a `..` segment is an error diagnostic);
     `ClaudePluginManifest.appendToDefault?`: when a `strict: true` marketplace entry adds commands, agents or output
     styles that `plugin.json` did not declare, the default folder scan stays and the entry's paths are added
     (`CLAUDE_REPLACING_COMPONENTS` names the kinds whose paths otherwise replace the scan); `plugin.json` wins
     `version` in both strict modes; only an entry's inline hook maps replace the manifest's hooks per event (hook files
     append); `OFFICIAL_MARKETPLACE_NAMES` / `isOfficialMarketplaceName` exist for the impersonation rule (W12.2 applies
     it). *Accept:* the C45 builders `review-kit`, `notes-only`, `single-skill`, `broken`: counts, names, diagnostics;
     `../` paths and linked files refused; a hand-placed claude folder is detected.
  2. **W12.1-T2 Tree hash** (`tree-hash.ts`) — `hf-claude-plugin/v1\0`, then per regular file in UTF-8 byte order of its
     POSIX path `F\0<path>\0<755|644>\0<size>\0` + sha256(content), then `O\0` + `canonicalJson(overlay)` when an
     overlay exists; links / specials → the plugin is `error`; linked folders skip `.git` / `node_modules`, ignore links
     and stay pinned by path (`pathPin`); cached by (path, size, mtime, inode); caps 2000 entries / 100 MB; trust
     (`host.ts:1145`) re-reads the tree and refuses a mismatch (409 `stale`). *Accept:* a golden hash of a fixed tree;
     editing a script, flipping an exec bit or changing the overlay changes it; the overlay's key order does not.
  3. **W12.1-T3 Variables and `userConfig`** (`variables.ts`, `user-config.ts`) — through C41's
     `substitutePluginVariables` / `userConfigToSettings`, per the variable table (shell-form hooks: env; exec-form
     hooks: literal at load, then quoted; stdio / http MCP: literal, `${user_config.KEY}` → `{{settings.KEY}}`, inside
     `command` → server skipped, other `${VAR}` → secret setting `env_<VAR>`; markdown bodies: absolute paths,
     non-sensitive `userConfig` only, sensitive → `''` + a warning); `CLAUDE_PLUGIN_OPTION_<KEY>` env for hooks; never
     `process.env`; saving settings reloads a claude plugin (`host.ts:1170`). C41 facts: the names are
     `CLAUDE_PLUGIN_VARIABLE_NAMES`; a sensitive `${user_config.KEY}` becomes `''` in markdown; `\${…}` of a known
     variable stays literal. *Accept:* the variable table as tests (sensitive values never in bodies; `${user_config.*}`
     in a shell-form hook → the handler skipped + a diagnostic; a `process.env` canary never appears).
  4. **W12.1-T4 MCP** (`mcp.ts`) — servers merged and parsed by `parseMcpJson`, mapped to `McpServerDecl` with
     `{{settings.*}}`; ids `<pluginId>` (one server) / `<pluginId>-<slug>` / `<pluginId>-<4hex>` / skipped with a
     diagnostic (≤ 32); `register(…, { claudeName: 'plugin_<name>_<server>' })` so `mcp__plugin_<name>_<server>__*`
     names are rewritten in agent `tools` / `allowed-tools` and match hooks; `${CLAUDE_PROJECT_DIR}` → server skipped;
     `headersHelper`, `.mcpb`, ws and OAuth-only servers → diagnostics; stdio servers start only for a trusted plugin
     (`assertTrusted`) with cwd = the plugin folder. *Accept:* the id table; the `userConfig` secret reaches the http
     fixture as a header and never appears in a body or a log.
  5. **W12.1-T5 Hooks** (`hooks.ts`) — `hooks/hooks.json` (wrapper; `readSettingsHooks` with prompts on), inline and
     path / array forms merged per event, read with `readHooksConfig(…, { source: 'plugin', prompts: true })`; unknown
     events and handler types → diagnostics (the plugin stays active); > 50 handlers trimmed + a diagnostic **before**
     `validateHookCommands` (which throws above 50); registered through the runtime with `root`, `env`
     (`CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` = `paths.pluginData/<id>`, `CLAUDE_PLUGIN_OPTION_*`) and the prompts.
     *Accept:* the `review-kit` hooks → 1 command handler, 2 diagnostics, an active plugin once trusted; an untrusted
     plugin registers nothing.
  6. **W12.1-T6 Registration and host** (`register.ts`, `host.ts`) — `registerClaudeContributions(ctx, read, runtime)`:
     commands with `syntax: 'markdown'` (body, `argumentHint`, `model`, `allowedTools`), agents (incl.
     `disallowedTools`, `maxTurns`, `color`, `skills`, `model` / `modelAlias`), skills with `baseDir`, styles — all
     under qualified names `<pluginId>:<seg>…:<name>` (≤ 3 segments, ≤ 128); the host: `runsCode` from
     `read.requiresTrust` (`:317`), `editable` false for claude (`:331`), `contributionsOf` (`:271`), `startRuntime`
     dispatch by format (`:536`, `:560`), format detection for hand-placed folders (`:700`), `updateSettings` reload
     (`:1170`). *Accept:* a claude plugin loads and lists `/review-kit:review`, `/review-kit:db:migrate` and the agent
     `review-kit:code-reviewer`; a pure-markdown plugin is active without trust; a plugin with a hook stays `untrusted`
     until pinned.
  7. **W12.1-T7 Registry and declarative 1.6.0** (`S/registry/**`, `declarative.ts`, `context.ts`) — qualified names
     accepted only when the first segment is the owner's id (harness plugins keep bare names); markdown command syntax
     (≤ 64 KiB); `baseDir` validated (relative, inside the plugin); `HookCommandsRegistration.env` / `prompts`;
     `claudeName`; harness manifests' 1.6.0 fields (`contributes.skills[].baseDir`, prompt hooks in `contributes.hooks`,
     the agent fields) through `registerDeclaredContributions` (`:442`, `:475`). *Accept:* validate tests; `^1.5.0`
     manifests (`hook-pack`, `agent-pack`) load unchanged.
  8. **W12.1-T8 Catalog mapping** (`S/services/customizations/plugins.ts:44-45`, `:93`) — plugin commands keep
     `argumentHint`, `model`, `allowedTools` (no longer `null`), skills `userInvocable` / `modelInvocable` /
     `argumentHint` / `baseDir`, agents the new fields; entry names are the qualified names. *Accept:* the catalog
     entries of the `review-kit` plugin.
  9. **W12.1-T9 Skill files** (`skill-files.ts`, C43's signatures) — list (≤ 50, 3 levels) and read one file inside the
     skill folder of an active plugin (`resolveWorkspacePath` / `openWorkspaceFile` with the plugin realpath as the
     root; no links, regular, not hidden, not `isSecretLookingPath`, not binary, ≤ 64 KiB, truncated). *Accept:* `../`,
     a link, `.env` and a binary file refused; `scripts/fill.sh` read.
  10. **W12.1-T10 Info** (`info.ts`) — the `claudePluginInfoSchema` value for the inspection and the detail
      (`executables` = exactly what the trust consent shows: every command hook with its args, every stdio command line,
      every `!` span; hosts; `userConfig` with the secret ones flagged; `unsupported` (`.lsp.json`, `bin/`, `themes/`,
      `monitors/`, `workflows/`, the plugin's `settings.json`, `lspServers`, `channels`, …); diagnostics ≤ 200).
      *Accept:* the `review-kit` info; `.lsp.json` / `bin/` listed and never spawned.
  11. **W12.1-T11 Example** — `examples/plugins/claude-review-kit/` (`.claude-plugin/plugin.json` with inline
      `mcpServers` and **no** `.mcp.json`, a command, an agent, a skill with a supporting file, a style,
      `hooks/hooks.json` with a POSIX `sh` script, a README); `examples.test.ts` learns the claude format
      (`EXAMPLE_IDS` + `claude-review-kit`, installed from its folder, listed with format `claude`). *Accept:*
      `examples.test.ts`; no other `.claude-plugin/` folder in the repository.
- **Tests.** The tasks above; plugin contents, `userConfig` values and commands never logged at `info`.
- **Verify.** Server commands.

### W12.2 sources-marketplaces-server (k2)

- **Mission.** The HTTPS archive sources (GitHub, marketplace entries), the Claude-aware installer (exec bits, subtree
  selection, the detection-aware root, the new stages, origin and format checks, `defaultEnabled`), the marketplace
  service (add / refresh / remove, the catalog, unsupported rows, updates, offline, reserved names) and the routes.
- **Owned.** `S/plugins/install/**` (not `testing.ts`), `S/plugins/marketplaces/**` (not `types.ts`),
  `S/http/routes/{marketplaces,plugin-install,plugins}*`.
- **Read-only highlights.** ADR-054, ADR-053; the plan's Reconciliation rows (Detection, Plugin id, Version, Exec bits,
  Marketplaces) and section 2; `server-plugins.md` D2, D3, D7, D16 – D22 and sections 2, 3, 5, 7; `claude-formats.md` 2;
  API.md 4.33 and 5.34; `SH/schemas/{plugins,marketplaces}.ts`, `SH/util/claude-plugins.ts`;
  `S/plugins/marketplaces/types.ts`, `S/plugins/types.ts` (`inspectDirectory` options),
  `S/plugins/claude/{types,detect}.ts` (frozen); `S/plugins/install/archive.ts:37` (`EntryCollector`), `:110`
  (`pluginRootPrefix`), `:127` (`writeEntries`, mode 0644 `:142`), `:150` (`verifyTree`, `:175`);
  `install/index.ts:147-194` (the stages, `stage` `:181`), `:213` (`examine`, the source check `:227`), `:296-345` (the
  atomic commit and rollback); `install/zip.ts:459` (`openZip`); `install/inspection.ts:161` (`buildInspection`);
  `install/reviews.ts`; `S/http/routes/plugin-install.ts:154-157` (fresh auth when trust is required);
  `S/security/ssrf.ts`; the fake remote and `createFakeSafeFetch` (C45).
- **Tasks.**
  1. **W12.2-T1 Archives** — `ArchiveEntry.executable`; the zip mode from the external attributes of Unix hosts, the tar
     header mode, `lstat` for folder copies; `writeEntries` / `verifyTree` `{ preserveExec }` (claude format only: 0755
     / 0644; harness plugins unchanged at 0644); `select(path)`: entries outside the chosen subtree are skipped before
     admission (never written, not counted, links there ignored); repo zips ≤ 50 MB compressed; the root prefix from
     `detectPluginLayout` (W12.1) for claude archives. *Accept:* zips from `zipOf` / `unixMode` / `githubZipOf`: the
     exec bit kept for claude, dropped for harness; a link inside the subtree refused, outside ignored; caps counted on
     the subtree only.
  2. **W12.2-T2 GitHub staging** (`install/github.ts`) — `{ source: 'github', repo, ref?, path? }`: `GET
     https://api.github.com/repos/{o}/{r}/commits/{ref|HEAD}` with `Accept: application/vnd.github.sha` → the sha;
     `https://codeload.github.com/{o}/{r}/zip/{sha}` without redirects (the top folder must be `<repo>-<sha>/`, the zip
     comment must equal the sha); a rate-limited API → the fallback `codeload …/zip/refs/heads/{ref}` with the sha read
     from the comment; `sourceRef = o/r@<sha12>[/path]`; everything through the injected `safeFetch` with `['https:']`;
     owner / repo / ref validated before a URL is built. *Accept:* `createFakeSafeFetch` tests; a moved ref gives a new
     sha; oversize / traversal / link / wrong-comment / wrong-top-folder archives refused; no `git` spawn
     (`process-spawn.test.ts` unchanged).
  3. **W12.2-T3 Installer** (`install/index.ts`, `inspection.ts`, `reviews.ts`) — new `stage` cases `github` and
     `marketplace` (the entry → a staged source through `marketplaces/sources.ts`); `examine` compares the origin key
     and the format (another origin or format holding the id → 409 `exists`); `inspectDirectory(dir, { format, overlay,
     nameHint })`; the record's `format` and `origin`; a claude plugin with `defaultEnabled: false` installs disabled
     unless the request sets `enable` (open point 16); review keys for the new sources (install re-stages and requires
     the reviewed sha256 = the tree hash, else 409 `stale`); inspection labels and claude warnings ("Claude Code
     plugin", the executables, the hosts, `Asks for:`, the ignored parts). *Accept:* inspect → install round trips for
     zip / folder / github / marketplace claude plugins; 409 `stale` after the archive changed; 409 `exists` for another
     origin; 403 without fresh auth when trust is required.
  4. **W12.2-T4 Marketplace service** (`S/plugins/marketplaces/{index,store,github,catalog,sources,updates,testing}.ts`)
     — `list`, `add(source)` (fetched immediately: github → the commit +
     `raw.githubusercontent.com/{o}/{r}/{sha}/.claude-plugin/marketplace.json` ≤ 1 MiB; url → the JSON (its sha256 =
     `resolved_ref`); path → the folder's `.claude-plugin/marketplace.json`; parsed by `parseMarketplaceJson`; no row on
     failure), `get`, `refresh`, `remove` (installed plugins kept; their origin dangles), `stop` (in-flight fetches
     aborted); ≤ 50 marketplaces; reserved names only from `anthropics/*` (`isOfficialMarketplaceName` /
     `OFFICIAL_MARKETPLACE_NAMES` of `SH/util/claude-plugins.ts`; open point 15); entries: relative (the stored commit's
     subtree with `metadata.pluginRoot`; unsupported for url marketplaces), `github`, github.com `url` / `git-subdir` →
     github (+ path), `archive` (sha256 checked when given), `npm` (default registry) supported; other git hosts,
     `command`, a custom npm registry → unsupported with a reason; `strict` → `mergeEntryOverlay`, the overlay stored in
     `plugins.origin`; updates (`updates.ts`): the entry version ≠ `origin.version`, else (no version) the marketplace /
     entry commit differs; events `marketplace.changed { id, marketplace | null }` on add / refresh / remove (update
     badges through `plugin.changed`); logs carry id, name, repo and sha12 only; never in backups, kept by delete-all.
     *Accept:* add github / url / path with the fake fetch; unsupported rows; an impersonated official name refused; 409
     `exists`, 404, 413 (a catalog over 1 MiB), 429 `rate_limited`, 502; a moved ref → refresh → update available →
     update = inspect → install again (review + trust re-pin + fresh auth); remove keeps plugins.
  5. **W12.2-T5 Offline** — `HF_OFFLINE=1` (ARCHITECTURE.md, D17): adding or refreshing a `github` or `url` marketplace
     and installing from a `github` or `marketplace` source answer 409 `offline`; a folder (`path`) marketplace still
     works, and so does installing its relative entries (the e2e server runs with `HF_OFFLINE=1`); npm and url plugin
     installs unchanged. *Accept:* one test per path, incl. a folder marketplace install offline.
  6. **W12.2-T6 Routes** — `S/http/routes/marketplaces.ts` (replacing C40's stub; every answer of API.md 5.34),
     `plugin-install.ts` (the new sources, `format?`), `plugins.ts` (the detail's `origin` / `claude`; `editable` false
     for claude). *Accept:* route tests for every answer in API.md.
- **Tests.** The tasks above; loopback / injected fetch only; marketplace JSON and archive contents never logged.
- **Verify.** Server commands.

### W12.3 claude-import-server (k3)

- **Mission.** The home-folder import: the disk and upload collectors, the baseline, the in-memory plans, apply, the
  routes; and the `turnedOff` count of a backup restore.
- **Owned.** `S/services/claude-import/**` (not `types.ts`), `S/http/routes/claude-import*`, `S/services/data/**` (not
  `types.ts`, not `references*`).
- **Read-only highlights.** ADR-055, ADR-024; the plan's Reconciliation rows (Import, Import statuses, Import rules,
  Leftovers) and section 3; `server-import.md` A1 – A11, E2 and section 7; API.md 4.34 and 5.35;
  `SH/util/{claude-import,claude-permissions}.ts` (C41), `SH/schemas/claude-import.ts`;
  `S/services/claude-import/types.ts` (frozen); `S/plugins/install/zip.ts:459` (`openZip`) and `archive.ts:37`
  (`EntryCollector`); `S/services/customizations/types.ts` (`importDefinitions`), `S/services/hooks/types.ts`
  (`importPersonal`), `S/services/shell-rules/types.ts` (`ShellRuleService`), `S/mcp/types.ts` (`ToolService.update` for
  tool overrides), the MCP manager's `create` / `update` (fresh options); `S/services/data/restore.ts:561`
  (`restoreBackup` call), `:576` (`run.customizations`); `S/services/customizations/store.ts:356-415` (the restore
  counts `turnedOff` and only logs it).
- **Tasks.**
  1. **W12.3-T1 Disk collector** (`collect-disk.ts`) — the root = `env.claudeHome` resolved once with `realpath`; the
     allowlist only (`isClaudeHomeImportPath`); folders listed with `opendir` (≤ 2000 entries per folder, ≤ 3 levels);
     files opened with `O_NONBLOCK`, `fstat` regular; symbolic links followed (dotfile managers) to regular files
     outside `HF_DATA_DIR` (marked `linked`); `.claude.json` read next to a root named `.claude` (or inside the root);
     the caps of `CLAUDE_HOME_LIMITS` and a 10 s deadline; `HF_CLAUDE_HOME=0` → 409 `disabled`. *Accept:* a fake home
     from the builders; the canaries never opened (a spy on `open`) and never returned or logged; a linked `CLAUDE.md`
     read; a link into the data dir refused.
  2. **W12.3-T2 Upload collector** (`collect-upload.ts`) — multipart ≤ 32 MiB: one zip (`openZip` + `EntryCollector`;
     only allowlisted entries inflated; one shared top folder stripped; the zip guards) or `files[]` named by relative
     path + an optional `.claude.json` file; anything outside the allowlist ignored (listed as skipped without content).
     *Accept:* the same fake home as folder files and as a zip gives the same plan as the scan.
  3. **W12.3-T3 Baseline and plans** (`baseline.ts`, `plans.ts`) — the baseline (personal definitions with their raw
     markdown, reserved / builtin names, the personal hooks as `claudeImportHookIdentity` values, the global MCP servers
     as `{ id, fingerprint: claudeImportMcpFingerprint(…) }` — both helpers are in `SH/util/claude-import.ts`, any other
     encoding makes every status miss —, global shell rules, tool denies, the instructions, the global `outputStyle`
     (`outputStyle?`), existing style names); statuses as C41 implemented them: a reserved or duplicate name →
     `conflict` (skip / rename), an MCP id with another fingerprint → `conflict` (skip / overwrite / rename), contents
     compared byte for byte (the `digest` option is unused); `planClaudeImport(files, baseline)` stored under a `cip_`
     id (10 min, ≤ 4 plans, the oldest dropped; dropped on apply, expiry, `key.rotated` and `stop()`); the DTO = the
     plan without payloads and env values. *Accept:* the leak test (fake `oauthAccount`, `primaryApiKey`, MCP header /
     env values never in a DTO, a log line or an error).
  4. **W12.3-T4 Apply** (`apply.ts`) — `{ planId, items[{ key, action, renameTo?, enable? }], instructions?, variables?
     }` (fresh; an unknown or expired plan → 404): every status re-checked against a fresh baseline; definitions through
     `customizations.importDefinitions` (create / overwrite (keeps `enabled`) / rename via `setDefinitionName`; `!`
     commands off unless `enable`), hooks through `hooks.importPersonal` (command hooks off unless `enable`; prompt
     hooks on), MCP servers through the MCP manager's create / update with fresh options (`${VAR}` from `variables`,
     then the plan's `env`, then the default; **never `process.env`**; unresolved → `failed` `needs-variables`;
     per-project servers `enabled: false`), shell rules through `ShellRuleService` (global; refused prefixes stay
     unsupported), tool denies through the tool overrides (`deny`), `CLAUDE.md` append (after a blank line) / replace (≤
     20 000 characters, else failed), `outputStyle`; exactly **one** `customization.changed` and **one**
     `hooks.changed`; the result `{ results, counts, warnings }`. *Accept:* 403 without fresh auth; one event of each;
     overwrite / rename; Bash rules → shell rules; a `process.env` canary never used; project servers disabled; an
     expired plan → 404.
  5. **W12.3-T5 Routes** (`claude-import.ts`) — `GET /claude-import/home` (already C43's), `POST /scan` (fresh; 409
     `disabled`), `POST /upload` (multipart; no side effects), `POST /apply` (fresh). *Accept:* route tests for every
     answer of API.md 5.35.
  6. **W12.3-T6 Restore `turnedOff`** (`S/services/data/restore.ts`) — `CustomizationRestoreResult.turnedOff` →
     `run.customizations.turnedOff` → `dataImportResultSchema.customizations.turnedOff`. *Accept:* restoring a backup
     with a `!` command reports `turnedOff: 1`.
  7. **W12.3-T7 Backups** — marketplaces, Claude plugins, transcripts and import plans are never in a backup (the
     explicit backup list); delete-all keeps marketplaces. *Accept:* a backup zip listing test.
- **Tests.** The tasks above; the root path only at `debug`; never contents, env or header values at any level.
- **Verify.** Server commands.

### W12.4 project-definitions-server (k4)

- **Mission.** Read, write and remove a project's definition files, the `hooks` key of its settings files and the
  `mcpServers` key of `.mcp.json` from the UI: path guard, lock, stale check, validation, events, the pending count.
- **Owned.** `S/services/project-definitions/**` (not `types.ts`), `S/http/routes/project-definitions*`.
- **Read-only highlights.** ADR-056, ADR-049; the plan's Reconciliation row (Project files) and section 4;
  `server-import.md` B1 – B6; API.md 4.35 and 5.36; `SH/schemas/project-definitions.ts`,
  `SH/util/{definitions,hooks,mcp-config}.ts`; `S/services/project-definitions/types.ts` (frozen);
  `S/services/checkpoints/disk.ts:137` (`writeWithoutRecording`); `S/workspace/paths.ts:181` (`resolveWorkspacePath`,
  `allowMissing`), `:258` (`openWorkspaceFile`), `:328` (`writeWorkspaceFile`, refuses `.git`);
  `S/workspace/sensitive.ts:53` (`isSecretLookingPath`); `S/workspace/file-lock.ts:24`;
  `S/services/customizations/memory.ts:200` (the rel-equality precedent); `S/services/customizations/index.ts:100`
  (`touchesDefinitions`), `S/services/hooks/index.ts:88` (`touchesProjectHooks`),
  `S/services/project-config/index.ts:419` (`touchesConfig`); `S/services/project-trust/types.ts` (`pending`).
- **Tasks.**
  1. **W12.4-T1 Paths** (`paths.ts`) — allowed: definition markdown under
     `.claude/{agents,commands,skills,output-styles}` and `.harness/{…}` (the discovery rules: commands with subfolders,
     `skills/<name>/SKILL.md`), the four settings files, `.mcp.json`; anything else 400; `resolveWorkspacePath(root,
     path, { allowMissing: true })` must give `rel === path` (no link anywhere on the path), re-checked inside the lock;
     `.git` and secret-looking names refused. *Accept:* a linked `.claude` folder, `../x`, `.git/config`, `.env`,
     `.claude/agents/../../x.md` refused.
  2. **W12.4-T2 Read** — `GET /projects/:id/definitions/file?path` → `{ path, kind, exists, content | null, sha256 |
     null, diagnostics }` through `openWorkspaceFile` (regular; ≤ 64 KiB definitions, ≤ 256 KiB settings / `.mcp.json`;
     the parser diagnostics). *Accept:* each kind; a missing file `exists: false`.
  3. **W12.4-T3 Write** (`index.ts`, `settings-file.ts`) — the three body shapes; markdown validated by
     `parseDefinition(kind, text, { fileName | folderName })` (an error → 400 with `details.diagnostics`), settings
     `hooks` by `readHooksConfig(…, { prompts: true })` (errors → 400, warnings kept), `.mcp.json` `mcpServers` by
     `parseMcpJson`; the settings splice keeps every other key and their order (`hooks: null` removes the key; a missing
     file is created; open point 11); written with `writeWithoutRecording` (`withFileLock` + `writeWorkspaceFile`; **not
     journaled**); `expectedSha256` checked inside `produce(before)` (null = must not exist) → 409 `stale`;
     `workspace.changed { projectId, chatId: null, batchId: null, source: 'user', paths: [path] }`;
     `projectConfig.invalidate(projectId)`, then the answer `{ path, sha256, created, diagnostics, trust: { pending } }`
     (`projectTrust.pending(projectId)`). No fresh auth, no idle rule. *Accept:* create / update a definition; the
     settings splice keeps the other keys; `.mcp.json`; 409 `stale`; works while a run is active; `source: 'user'`.
  4. **W12.4-T4 Remove** — `DELETE …/file?path&expectedSha256` (markdown definitions only; settings and `.mcp.json` →
     400; an empty skill folder removed; the same stale check and events). *Accept:* tests.
  5. **W12.4-T5 Never approves** — a saved hook, server or `!` command stays pending: no `project_trust` row is written
     and nothing runs. *Accept:* save a hook → `trust.pending ≥ 1`, the hook absent from the snapshot until approved.
- **Tests.** The tasks above; file contents never logged.
- **Verify.** Server commands.

### W12.5 hooks-server (k5)

- **Mission.** The hooks service side of ADR-057: the prompt-hook runner, the exec form, `if`, `async`, `statusMessage`,
  transcripts, the SessionEnd runner, the new events in the snapshot, personal prompt hooks, `importPersonal`, untrusted
  plugin rows and the trust v2 items.
- **Owned.** `S/services/{hooks,project-config,project-trust}/**` (not `types.ts`),
  `S/http/routes/{hooks,project-trust}*`.
- **Read-only highlights.** ADR-057, ADR-048, ADR-049; the plan's Reconciliation rows (Prompt hooks, New events, Handler
  fields, Transcript, Allow record, Leftovers) and section 5; `server-import.md` C1 – C5, E1 and section 8;
  `claude-formats.md` 3; API.md (hooks, trust); `SH/util/{hooks,trust}.ts` (C42), `SH/schemas/{hooks,project-trust}.ts`;
  `S/services/hooks/types.ts` (frozen); `S/services/hooks/index.ts:83` (`commandHooksAllowed`), `:369` (`sourcesOf`),
  `snapshot.ts:230-234` (the plugin env), `runner.ts:74` (`runCommandHook`), `personal.ts:115` (create), `listing.ts:67`
  (`pluginCommandEntries`), `record.ts:45`; `S/chat/title.ts:76` (`titleModelCandidates`), `:114` (`addUsage`), the
  `generateText` call there; `S/chat/model-aliases.ts` (`resolveClaudeModel`, W12.7); `S/registry/hook-commands.ts:1-8`
  (untrusted plugins register nothing).
- **Tasks.**
  1. **W12.5-T1 Prompt-hook runner** (`prompt-hooks.ts`) — a `PromptHookSpec` runs inside `snapshot.run` as a `RanHook`:
     `expandHookPrompt(prompt, payloadJson)`; the model = the handler's `model` (a ref, or a Claude alias through
     `resolveClaudeModel`) → `hookModelRef` → the provider's `smallModelId` → the run model (the `titleModelCandidates`
     pattern); `generateText` with reasoning off, `maxRetries: 0`, 512 output tokens, the handler timeout (default 30 s,
     ≤ 600 s) and the run signal; ≤ 8 calls server-wide (`hookModelCallsMax`, a semaphore); the answer through
     `readPromptHookAnswer`, the outcome through `promptHookOutcome(event, answer, { continueOnBlock })` (C42's helpers;
     the caps `HOOK_LIMITS.promptMaxChars`, `.promptTimeoutDefaultSec`, `.errorMaxChars`); a usage row `purpose:
     'hook'`; no model → a non-blocking error; `hooksEnabled: false` and `HF_SAFE_MODE` → no prompt hook
     (`HF_WORKSPACE_SHELL=0` does not stop them); project prompt hooks only when approved (v2 hash, verify-before-run).
     *Accept:* `MockLanguageModelV4` tests per event × answer (ok / deny / impossible / fenced / invalid / timeout); the
     usage row; the 9th call waits; the kill switches; prompts and answers never at `info`.
  2. **W12.5-T2 Exec form, `if`, `async`, `statusMessage`** (`exec-form.ts`, `runner.ts`, `snapshot.ts`) — `args` →
     `execFormCommand(command, args, vars)` (still `runShellCommand`); `${CLAUDE_PROJECT_DIR}` substituted at spawn in
     exec form; `if` via `checkHookIf` / `matchHookIf` (invalid → `invalid-if`, never runs; a shell command the matcher
     cannot read counts as a match, so the hook runs); `HOOK_LIMITS.argsMax`, `.ifMaxChars`, `.statusMessageMaxChars`;
     `async` → detached, tracked, timeout enforced, killed on `stop()`, outcome ignored (run log only);
     `HookSnapshot.statusMessage(event, target)`; plugin env from `registered.env` (`snapshot.ts:230-234`:
     `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_OPTION_*`). *Accept:* `print-args` quoting (`;`, `$( )`, quotes, newlines: no
     injection); an `async` hook's pid dead after its timeout and after `stop()`; the `if` table.
  3. **W12.5-T3 Transcripts** (`transcripts.ts`) — written lazily inside `snapshot.run` when a matching command or
     prompt hook will run, before the payload: `<dataDir>/transcripts/<chatId>.jsonl` (folder 0700, file 0600), rebuilt
     from the active path when the leaf changed (temp + rename); lines `{ type, uuid, parentUuid, sessionId, timestamp,
     cwd, isSidechain: false, userType: 'external', version: 'harness-forge/<v>', message: { role, content } }` (text +
     `tool_use` / `tool_result` blocks with Claude tool names, results ≤ 16 KiB; reasoning, files and `data-hook` parts
     dropped); ≤ 8 MiB (oldest first), parts ≤ 64 KiB; removed on `chat.deleted` + an orphan sweep at first use; a
     failure → `transcript_path` absent. *Accept:* written only when a hook runs, 0600, valid JSONL, deleted with the
     chat.
  4. **W12.5-T4 SessionEnd** (`session-end.ts`) — `HookService.sessionEnd(chat)` (called by the chat delete route):
     `reason: 'other'`, detached and tracked, a 1.5 s budget raised by explicit handler timeouts up to 60 s, killed on
     `stop()`. *Accept:* the `record` script sees one SessionEnd per single delete; none for delete-all or a project
     delete.
  5. **W12.5-T5 The new events in the snapshot** — the matcher subjects (`tool`, `agent` incl. Claude names through
     C42's `hookAgentNames`, `trigger`, `reason`), the payload inputs (`transcriptPath`, `error`, `agent`,
     `sessionEndReason`), PermissionRequest outputs through `readHookOutput`, prompt handlers only for the seven events
     (elsewhere a diagnostic). *Accept:* a test per event with the `record` script.
  6. **W12.5-T6 Personal prompt hooks and `importPersonal`** (`personal.ts`) — `type: 'command' | 'prompt'` (the columns
     `type`, `prompt`, `model`, `options`; prompt rows store `command = ''`); create / update fresh as today (update
     without fresh auth only for `{ enabled: false }`); `importPersonal(items)` (one `hooks.changed`; command hooks off
     unless enabled; the 100-row cap). *Accept:* CRUD of a prompt hook; 403 without fresh auth; `importPersonal` emits
     once.
  7. **W12.5-T7 Untrusted plugin rows** (`listing.ts`) — plugins in state `untrusted`: their manifest's
     `contributes.hooks` as entries `state: 'pending'`, `source: 'plugin'` (open point 14). *Accept:* an untrusted
     `hook-pack` lists its PostToolUse hook as pending; trusting it makes the row active.
  8. **W12.5-T8 Trust v2** (`S/services/{project-config,project-trust}/**`) — project prompt hooks and command hooks
     with `args` / `async` / `if` hash as v2 (`trustHashInput` with `extra`); v1 items keep their bytes; the script
     files named in exec-form `args` become trust refs too (C42's `extractCommandFileRefs` reads only the command: the
     project config reader adds the refs of every argument before hashing, so editing such a script makes the item
     pending); the trust listing's hook detail shows the prompt and the fields (open point 2); a W12.4 save
     (`project-config.invalidate` + `workspace.changed`) updates the pending count and emits `project-trust.changed`.
     *Accept:* golden v1 hashes of the seeded items unchanged; a project prompt hook pending until approved.
- **Tests.** The tasks above; every spawned pid dead at test end; no prompt, answer, command or payload at `info`.
- **Verify.** Server commands.

### W12.6 hook-events-server (k6)

- **Mission.** The event logic behind C44's call sites: SubagentStart and SubagentStop agent matching, `maxTurns`, the
  skills preload and agent `disallowedTools` in children, PostCompact, the SessionEnd call site, prompt hooks on the run
  events, and the usage totals.
- **Owned.** `S/chat/{hooks-prompt,steer,queue,index}*`, `S/chat/{subagent,compaction,background}/**` (not `host.ts`,
  not `background/types.ts`), `S/http/routes/{chat,chats,chat-queue}*`, `S/services/chats/**` (not `types.ts`).
- **Read-only highlights.** ADR-057, ADR-058, ADR-043; the plan's Reconciliation rows (New events, Prompt hooks,
  Frontmatter) and sections 5 – 6; `server-import.md` C1-effects, C2, D1; API.md;
  `S/chat/{hooks,approval,tools,steps,pipeline,model-history,agent-scope}.ts`, `S/chat/subagent/host.ts` (frozen, C44);
  `S/chat/subagent/index.ts` (search for `createSubagentRunnerWith`; the Phase 11 SubagentStop rounds);
  `S/chat/background/index.ts` (`finalize`); `S/chat/compaction/guard.ts:135`, `stream.ts:154`;
  `S/http/routes/chats.ts:51`; `S/services/chats/index.ts:96` (`TOTALS_PURPOSES`); `SH/util/definitions.ts` (the agent
  keys); `S/chat/model-aliases.ts` (W12.7).
- **Tasks.**
  1. **W12.6-T1 SubagentStart** — foreground and background children: before step 0 through `ChildHooks.subagentStart`;
     the matcher on the agent type incl. Claude names (`general` matches `general-purpose`; the snapshot matches through
     `hookAgentNames`, W12.5); `additionalContext` (the `agent-context` script) → the child's first user message.
     *Accept:* the context reaches the child prompt (`MockLanguageModelV4` capturing it); a non-matching matcher runs
     nothing.
  2. **W12.6-T2 SubagentStop** — `agent_id` / `agent_type` in the payload and agent matching; prompt SubagentStop hooks:
     `ok: false` → one more child round unless `impossible` (the Phase 11 cap of 2 rounds holds). *Accept:* tests per
     path.
  3. **W12.6-T3 Agent keys in children** — `maxTurns` (child steps = min(`subagentMaxSteps`, `maxTurns`)), the `skills`
     preload (≤ 5, ≤ 32 KiB in total, bodies through `customizations.load`, appended to the child's instructions),
     `disallowedTools` removed before `tools` (restrict-only; a specifier removes the whole tool); the child's Claude
     model alias through `resolveClaudeModel` (W12.7). *Accept:* a child of an agent with `maxTurns: 2` stops at 2
     steps; a preloaded skill's text is in the child instructions; `disallowedTools: Bash` removes `shell`.
  4. **W12.6-T4 PostCompact** (`compaction/guard.ts`, `stream.ts`) — after the marker, `trigger: 'auto' | 'manual'`,
     observe only, the record after the marker. *Accept:* the payload of both triggers; nothing changes when a hook
     fails.
  5. **W12.6-T5 Run events with prompt hooks** — UserPromptSubmit prompt hooks at submit and at enqueue
     (`hooks-prompt.ts`, `queue.ts`): `ok: false` → 409 `hook-blocked`, nothing stored; Stop prompt hooks: `ok: false` →
     a hook turn (origin `hook`, cap 5) unless `impossible`; PostToolUseFailure and PermissionRequest covered end to end
     through `createTestApp()` (one test each; a seam bug is a CCR). *Accept:* tests per path.
  6. **W12.6-T6 SessionEnd call site** (`S/http/routes/chats.ts`) — only `chats.remove` calls `hooks.sessionEnd(chat)`;
     delete-all and project deletion never do. *Accept:* route tests.
  7. **W12.6-T7 Usage totals** — `TOTALS_PURPOSES` (`S/services/chats/index.ts:96`) + `hook`, so prompt-hook cost counts
     in the chat's totals; the usage listing shows `hook`. *Accept:* `index.test.ts`.
- **Tests.** The tasks above; prompts, contexts, answers and reasons never at `info`.
- **Verify.** Server commands.

### W12.7 catalog-frontmatter-server (k7)

- **Mission.** The new definition keys in the catalog and the command / skill paths, `importDefinitions`, qualified
  names with the bare alias, markdown plugin commands, the argument options, fork skills, skill `file` reads and the
  Claude model aliases.
- **Owned.**
  `S/services/customizations/{builtins,cache,catalog,discover,entries,index,memory,notifier,snapshot,store,import,
  qualified}*` (every stem but `plugins*` and `types.ts`; open point 7),
  `S/chat/{commands,prepare,context,notices,params,output-style,skills,model-aliases}*`, `S/chat/inline/**`,
  `S/http/routes/{commands,customizations}*`, `S/builtin-plugins/core-agent/skill*`.
- **Read-only highlights.** ADR-058, ADR-045, ADR-044, ADR-053 (qualified names); the plan's Reconciliation rows (Names,
  Plugin skill files, Plugin commands, Frontmatter, Arguments, Model aliases) and section 6; `server-import.md` D1 – D3;
  `SH/util/{definitions,arguments}.ts` (C42), `SH/ids.ts` (`catalogNameSchema`, `splitQualifiedName`, C40),
  `SH/schemas/{customizations,agent}.ts`; `S/services/customizations/types.ts` (frozen); `store.ts:83` (`parseUsable`),
  `:144` (`serialized`), `:266` (`create`), `:356` (`restoreBackup`, `turnedOff` `:365-415`); `index.ts:100`, `:409`
  (`personalChanged`), `:489`; `S/chat/commands.ts:75` (`COMMAND_PREFIX`), `:88` (`expandTemplate`), `:321`
  (`definitionResolution`), `:381` (`resolveCommand`), `:441` (`listServerCommands`), `:490` (`isServerCommandFor`);
  `S/chat/params.ts:227` (`skillsBlock`), `:254` (`agentBlocks`); `S/chat/skills.ts:143` (`listSkillFiles`), `:173`
  (`loadSkill`); `S/chat/inline/shell.ts:56` (`spanEnvironment`); `S/builtin-plugins/core-agent/skill.ts` (the tool,
  `SKILL_DESCRIPTION`); `S/chat/agent-scope.ts` (`loadSkill` options, C44); `S/plugins/claude/skill-files.ts` (W12.1).
- **Tasks.**
  1. **W12.7-T1 New keys in the catalog** (`entries.ts`, `snapshot.ts`, `params.ts`) — agents `disallowedTools`,
     `maxTurns`, `color`, `skills`, `modelAlias`; commands / skills `whenToUse`, `arguments`, `disallowedTools`,
     `context`, `agent`, `modelAlias`; skills `allowedTools`, `model`; `when_to_use` appended to the description in the
     listings (`skillsBlock`, the agent-type listing, `GET /commands`); `ignored-key` diagnostics visible in `GET
     /customizations` (C42's names: `AGENT_COLORS`, `CLAUDE_UNSUPPORTED_DEFINITION_KEYS`). *Accept:* catalog and params
     tests; v1.7 entries unchanged.
  2. **W12.7-T2 `importDefinitions`** (`store.ts`, `index.ts`, `import*`) — one pass in the write queue: create /
     overwrite (keeps `enabled`) / rename (`setDefinitionName`); a missing `name:` inserted; `!` commands turned off
     unless enabled; the 200-per-kind cap; per-item outcomes; **one** `customization.changed {}`; `restoreBackup`
     returns `turnedOff`. *Accept:* store tests (one event for N items; a span command off; overwrite keeps `enabled`).
  3. **W12.7-T3 Qualified names and the bare alias** (`snapshot.ts`, `qualified*`, `commands.ts`) — the getters `agent`
     / `skill` / `command` / `style(name)` and `resolveCommand` accept a qualified name exactly and a bare name only
     when exactly one active entry ends in `:<bare>` and nothing has the exact name; a harness plugin's
     `<pluginId>:<name>` resolves to its bare entry; `COMMAND_PREFIX` (`:75`) widened to qualified names (≤ 128); the
     resolution order unchanged (client → harness → definition command → plugin command → skill); `listServerCommands` /
     `isServerCommandFor` list and accept qualified names; Claude agent type names (`general-purpose`, …) map through
     C42's `claudeAgentTypeNames`. *Accept:* `/review-kit:review`, `/review-kit:db:migrate`, the bare `/review` when
     unique, a collision → no alias; `task.type` and `skill` with qualified names.
  4. **W12.7-T4 Markdown plugin commands** (`commands.ts`, `inline/**`) — `syntax: 'markdown'` takes the definition path
     (`definitionResolution`, `:321`): `expandArguments` with options, `!` spans as a trusted plugin source with
     `spanEnvironment(root, pluginEnv)` (`CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, the options), `@path`, `model`,
     `allowed-tools` restrict-only (plugin `allowed-tools` never pre-approve). *Accept:* a markdown plugin command
     expands `$ARGUMENTS` and runs a span only when the plugin is trusted.
  5. **W12.7-T5 Arguments** — every `expandArguments` call passes `{ names: definition.arguments, base:
     argumentBase(body, names), vars }` (`CLAUDE_SKILL_DIR` (the project skill folder; the absolute plugin skill
     folder), `CLAUDE_PROJECT_DIR` (when a project is open), `CLAUDE_SESSION_ID` (the chat id), the plugin variables for
     plugin commands; C42's names: `argumentBase`, `ExpandArgumentsOptions`). *Accept:* `$0` / `$ARGUMENTS[1]` / `$name`
     bodies; the Phase 10 `$1` examples unchanged; a personal skill's `${CLAUDE_SKILL_DIR}` stays literal.
  6. **W12.7-T6 Fork skills** (`skills.ts`, `core-agent/skill*`, `commands.ts`) — a `context: 'fork'` skill loaded
     through the `skill` tool runs a child of type `agent` (default `general`) through the scope's `runSubagent` (the
     `toolCallId` of C44's `loadSkill` options) and returns its report as `content`; a user `/name` of a fork skill
     expands with a delegation directive asking the main agent to call `task` (type = the skill's `agent`). *Accept:*
     the child runs once; the report reaches the model; `/name` produces the directive.
  7. **W12.7-T7 Skill `file` reads** (`skills.ts`, `core-agent/skill*`) — `skill { name, file }` for a plugin skill
     reads through W12.1's skill-files helper (`fileAccess: 'skill'`, `file: { path, content, truncated }`); project
     skills keep `fileAccess: 'workspace'` (`read_file`); `read_file` is not widened; the tool description mentions
     `file` (`index.test.ts` pins updated, reported). *Accept:* a plugin skill file read; `../` refused with a tool
     error.
  8. **W12.7-T8 Model aliases** (`model-aliases.ts`) — `resolveClaudeModel` (the parsed alias comes from C42's
     `claudeModelAlias`): the `modelAliases` setting → for a full `claude-*` id `anthropic:<id>` when it resolves → the
     existing fallback + the notice; used by commands and skills (`model:` on `/name`), plugin agents, prompt hooks
     (W12.5) and children (W12.6). *Accept:* a table (alias set / unset, a full id with and without an Anthropic key,
     `opusplan`).
  9. **W12.7-T9 Restrict-only** — command / skill `disallowed-tools` and skill `allowed-tools` narrow the turn's tools
     on `/name` (`prepare.ts`, `params.ts`); never a grant; `exit_plan_mode` kept in plan mode. *Accept:* tests.
- **Tests.** The tasks above; every existing commands / prepare / context / skills test stays green; bodies and
  expansions never at `info`.
- **Verify.** Server commands.

### W12.8 marketplaces-web

- **Mission.** The Marketplaces page, the official suggestion, the add dialog, the entry rows, the install / update
  dialog, the `marketplaces` store and the Plugins nav row.
- **Owned.** `W/pages/plugins/marketplaces*`, `W/components/plugins/marketplaces/**`, `W/stores/marketplaces*`,
  `W/components/app-shell/PluginsNav*`.
- **Read-only highlights.** UI.md 2.19, 5.4, 5.5, 6, 8.13, 10.9, 11.9, 13.13, 14, 15; `.tmp/p12-designs/web-process.md`
  part (1) (Marketplaces, wireframes, copy); API.md 4.33, 5.34 (`marketplace.changed`); `SH/schemas/marketplaces.ts`,
  `SH/util/claude-plugins.ts` (`parseMarketplaceShorthand`); `InstallReview` (W12.9's, frozen props); the
  `useServerEvents` wiring (C46, frozen).
- **Tasks.**
  1. **W12.8-T1 Store** — `useMarketplacesStore` behind C46's signature: single flight, per-key versions, `maxAgeMs`, an
     answer older than the last event never wins; `marketplace.changed` replaces or drops a row, `plugin.changed` marks
     the entries' install state stale; `updateCount` from `GET /marketplaces` `updates`. *Accept:*
     `marketplaces.test.ts` (store).
  2. **W12.8-T2 Page** — `MarketplacesView` ("Marketplaces", "Browse plugins from Claude Code marketplaces.", Refresh
     all · Add marketplace…; query `?m=&q=&category=`); `MarketplaceStrip` (chips with counts and update counts on
     desktop, a `Select` below `sm`; the row menu Refresh · Remove…; "Removing a marketplace keeps the plugins you
     installed from it."); search and category filter (`filterEntries`, `categoriesOf`); "refreshed {time}" and the last
     error ("Could not refresh {name}: {message}"); empty and error states. *Accept:* `MarketplacesView.test.ts`,
     `MarketplaceStrip.test.ts`.
  3. **W12.8-T3 Suggestion** — `MarketplaceSuggestion` ("Anthropic's official plugins",
     `anthropics/claude-plugins-official`, Add marketplace / ×); the dismissal in `localStorage`
     `hf-marketplace-suggestion-dismissed` (wrapped in try/catch); **no request before a click**; hidden once that
     marketplace exists. *Accept:* a test that counts zero API calls until Add.
  4. **W12.8-T4 Add dialog** — `MarketplaceAddDialog` ("GitHub repository, marketplace.json URL or a folder on this
     server"; `parseMarketplaceInput`; `marketplace-add-source[data-value]`); errors mapped by code / reason (409
     `exists` / `offline`, 404, 429 `rate_limited`, 502, 400 reserved name); Mod+Enter adds. *Accept:*
     `MarketplaceAddDialog.test.ts`.
  5. **W12.8-T5 Entries and install** — `MarketplaceEntryRow` (`<article>` named "{name}, {state}"; `entryState`:
     available · installed · "Update to {version}" · "Unsupported source ({type})"; "Install {name}" / "Update…"
     buttons, 40 px at 390 px); `MarketplaceInstallDialog` (mode install / update) around `InstallReview` with the
     request `{ source: 'marketplace', marketplaceId, plugin }` (one fresh-auth flow; Install never the default button);
     `installed` → the plugin page. *Accept:* `MarketplaceEntryRow.test.ts`, `MarketplaceInstallDialog.test.ts`.
  6. **W12.8-T6 Nav row** — `PluginsNav` "Marketplaces" with the update count badge (`updateCount`), active on
     `/plugins/marketplaces`. *Accept:* `PluginsNav.test.ts`.
- **Tests.** The tasks above; no `//` inside a component prop value (the repository and URL placeholders are script
  constants).
- **Verify.** Web commands.

### W12.9 plugins-install-web

- **Mission.** The install dialog's GitHub tab, `InstallReview`, the Claude preview, the trust warning for Claude
  plugins, the update banner and badge, the plugin detail's origin and Claude sections, the plugins store additions.
- **Owned.** `W/components/plugins/{install,detail,list}/**`, `W/stores/plugins*`.
- **Read-only highlights.** UI.md 2.19, 8.13, 10.9, 11.9, 13.13, 15; web-process.md part (1) (Install, Detail and list);
  API.md 4.33 (inspection `format` / `claude`, detail `origin` / `claude`); `SH/schemas/plugins.ts`; `install.ts:21-29`
  (`InstallTab`), `:32` (`TRUST_WARNING_TEXT`), `:267` (`stdioCommands`), `:284` (`runCommands`, a harness manifest
  reader); `InstallDialog.vue:104`; `MarketplaceInstallDialog` props (W12.8's, frozen).
- **Tasks.**
  1. **W12.9-T1 `InstallReview`** — behind C46's extraction: the preview, the trust consent, the inline password and the
     install; `stale` → back to the source step with "The plugin changed while you were reviewing it."; one fresh-auth
     flow shared with the marketplace dialog. *Accept:* `InstallReview.test.ts`, `InstallDialog.test.ts`.
  2. **W12.9-T2 GitHub tab** — `install-tab-github` with Repository (`install-github-repo`,
     `parseGithubSpec('owner/repo#ref')` fills the ref), "Branch, tag or commit (optional)" (`install-github-ref`),
     "Folder in the repository (optional)" (`install-github-path`, first cut), the help "Downloads an archive of the
     exact commit over HTTPS. Nothing runs before you review it."; `openInstall('github')`. *Accept:* `install.test.ts`,
     `InstallDialog.test.ts`.
  3. **W12.9-T3 Claude preview** — `InspectPreview`: the format badge (`data-slot="install-format"`, "Claude Code
     plugin"), the contributions with namespaced names ("Commands run as /{plugin}:{command}."), "Asks for:"
     (`userConfig`, secret ones marked), "Resolved commit {sha7}", "Ignored: …" (`claude.unsupported`); `TrustWarning`
     lists `inspection.claude.executables` for Claude plugins (not `runCommands(manifest)`). *Accept:* `InspectPreview`
     / `TrustWarning` tests with a Claude inspection fixture.
  4. **W12.9-T4 Updates** — `PluginUpdateBanner` on the detail page ("Version {version} is available from
     {marketplace}." → `MarketplaceInstallDialog` in update mode); `PluginCard` badge
     `plugin-update-available[data-version]`; the optional `updates` filter of the plugins store (first cut). *Accept:*
     `PluginUpdateBanner.test.ts`, `PluginCard.test.ts`, `plugins.test.ts`.
  5. **W12.9-T5 Detail and labels** — the origin (marketplace name + commit, or `owner/repo@sha7`), the Claude section
     (components, ignored parts, diagnostics), `editable` false (no editor entry for Claude plugins);
     `plugin-display.ts` source labels (`github` → "GitHub", `marketplace` → its name); `userConfig` renders through the
     existing `SchemaForm` (a `format: secret` field). *Accept:* `PluginDetailView.test.ts`, `plugin-display.test.ts`.
- **Tests.** The tasks above; no `//` inside a component prop value.
- **Verify.** Web commands.

### W12.10 claude-import-web

- **Mission.** The Import from Claude Code wizard, `useClaudeImport`, the Customize header entry and the Data entry and
  turned-off count.
- **Owned.** `W/components/settings/claude-import/**`, `W/composables/useClaudeImport*`,
  `W/pages/settings/customize.vue`, `W/components/settings/data/**`.
- **Read-only highlights.** UI.md 2.19, 6, 9.14, 10.9, 11.9, 12, 13.13, 14, 15; web-process.md part (1) (Import,
  wireframes, copy, accessibility); API.md 4.34, 5.35; `SH/schemas/claude-import.ts`, `SH/util/claude-import.ts`;
  `useFreshAuth()`; `importHooks` (W12.12's module, for hook labels); `DataImportResultPanel.vue:29`.
- **Tasks.**
  1. **W12.10-T1 `useClaudeImport`** — behind C46's signature: `serverHome()`, `scanServer()` (fresh),
     `planFromFiles(files, claudeJson?)` (multipart `files[]` of `pickClaudeFiles` only, the caps enforced before the
     upload), `planFromZip(file)`, `apply(planId, selection)` (fresh when `needsFreshAuth`); never parses a zip; never
     holds a value the server keeps (env / header values are not in the DTO). *Accept:* `useClaudeImport.test.ts`
     (non-allowlisted files never uploaded; 403 → the fresh-auth prompt).
  2. **W12.10-T2 Wizard** — `ClaudeImportDialog` (3 steps, "Step {n} of 3" as text, the step heading takes focus, full
     screen with a sticky footer at 390 px); `ClaudeImportSource` (Choose your .claude folder… + .claude.json (MCP
     servers), Upload a zip…, Scan {path} on this server (disabled with the reason when `available` is false); the help
     "Only agents, commands, skills, output styles, settings.json, CLAUDE.md and the mcpServers of .claude.json are
     read."); `ClaudeImportPreview` / `Group` / `Item` ("Found {n} items" in a polite live region; groups with a mixed
     select-all; statuses as words: New · Replaces yours · Unchanged · Conflict · Unsupported · Invalid; the resolution
     select (the item's `actions`: skip / overwrite / rename) for update and conflict; executables "Imported turned off:
     it runs shell lines." with a per-item enable; the `CLAUDE.md` mode Append / Replace / Skip
     (`claude-import-instructions-mode`); inputs for `needs-variables` names; "Includes {n} items that run commands on
     this server."; Import never the default button); `ClaudeImportResult` (`resultLines`; Open Customize · MCP servers
     · Close). *Accept:* `ClaudeImportDialog.test.ts`, `ClaudeImportPreview.test.ts`, `claude-import.test.ts` (pure
     module).
  3. **W12.10-T3 Entry points** — `customize.vue`: `?import=claude` opens the wizard; the header button "Import from
     Claude Code…" (`customize-import-claude`); Settings → Data: "Import from Claude Code…" (`data-import-claude`).
     *Accept:* page and `DataSettings` tests.
  4. **W12.10-T4 Turned-off count** — `DataImportResultPanel` shows "{t} commands turned off (they run shell lines)"
     (`data-slot="data-import-turned-off"`) from `customizations.turnedOff`. *Accept:* `DataImportResultPanel.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W12.11 customize-defs-web

- **Mission.** The project file editor, Edit… on project rows, the new frontmatter fields of the editor, qualified names
  in Customize, the customizations store additions.
- **Owned.**
  `W/components/settings/customize/{Customization*,customize*,CustomizeSettings*,ProjectFile*,ToolMultiSelect*,
  StyleScopeBar*}`, `W/stores/customizations*`.
- **Read-only highlights.** UI.md 2.19, 9.14, 10.9, 11.9, 12, 13.13, 14, 15; web-process.md part (1) (Customize,
  wireframes, copy); API.md 4.35, 5.36; `SH/schemas/{project-definitions,customizations}.ts`, `SH/util/definitions.ts`;
  `CustomizationRow.vue:272-276`; `ProjectTrustDialog` props (W12.13's, frozen).
- **Tasks.**
  1. **W12.11-T1 `ProjectFileEditor`** — a sheet ("Edit {file}", the path with a copy button): the raw file in
     `MarkdownEditor` (unknown keys survive byte for byte), the parsed summary and the diagnostics beside it; Save
     through the store's `saveProjectFile` (PUT with `expectedSha256`); 409 `stale` → the conflict banner
     (`project-file-conflict`, `role="alert"`, takes focus: "{file} changed on disk after you opened it." Load from disk
     · Overwrite); success → "Saved {path}. {n} items need your approval." with Review (→ `ProjectTrustDialog`) and the
     note "Saving never approves hooks or shell lines."; a discard confirm on a dirty close; Mod+Enter saves; no
     run-active state. *Accept:* `ProjectFileEditor.test.ts` (save, stale → reload / overwrite, pending count → review,
     discard).
  2. **W12.11-T2 Edit… on project rows** — `CustomizationRow` Edit… (`customization-edit[data-source=project]`) after
     Review…; Delete… on project rows (`customization-delete[data-source=project]`, the DELETE route, markdown only);
     New {kind} in {project} from a section heading (`data-action="new-project-file"`, the editor in `data-mode="new"`);
     the `CustomizationViewer` footer Edit (the `edit` emit); `CustomizeSettings` hosts the editor. *Accept:*
     `CustomizationRow.test.ts`, `CustomizationViewer.test.ts`, `CustomizeSettings.test.ts`.
  3. **W12.11-T3 New fields** — `CustomizationEditor`: agents Tools not allowed (`customization-disallowed-tools`,
     through `ToolMultiSelect`), Max turns, Color (the 8 names with a dot), Skills; skills Allowed tools, Model, When to
     use, "Run in a sub-agent" + Agent; commands When to use; the body help for `$ARGUMENTS[N]`, `$name`,
     `${CLAUDE_SKILL_DIR}`; round trips through `formatDefinition`. *Accept:* `CustomizationEditor.test.ts`,
     `customize.test.ts`.
  4. **W12.11-T4 Store and names** — `projectSource(projectId, entry)` and `saveProjectFile(projectId, body)` behind
     C46's signatures; qualified plugin entry names shown as is. *Accept:* `customizations.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W12.12 hooks-web

- **Mission.** The Prompt hook type and the 13 events in the hook editor, project hook editing, untrusted plugin rows,
  the hook import's prompt support, the Hook model and model aliases in the Agent settings, the hooks store additions.
- **Owned.** `W/components/settings/customize/{Hook*,hooks*}`, `W/stores/hooks*`, `W/components/settings/agent/**`.
- **Read-only highlights.** UI.md 2.19, 9.14, 10.9, 11.9, 13.13, 14, 15; web-process.md part (1) (HookEditor, HookRow,
  Settings); API.md (hooks, settings); `SH/util/hooks.ts` (C42), `SH/schemas/hooks.ts`;
  `customize/hooks.ts:20,23,45,79,277`; `HookRow.vue:61` (the untrusted check that never fired), `:207`;
  `HookEditor.vue:46`; `TrustDialog` (`W/components/plugins/install/`, W12.9's; used as is); `AgentSettingsSection.vue`.
- **Tasks.**
  1. **W12.12-T1 `HookEditor`** — the Type toggle Command | Prompt (`hook-type[data-value]`); Prompt (`hook-prompt`,
     mono; help "Runs with {model} (Settings → Agent → Hook model). It answers ok, or not ok with a reason."; Model;
     "Continue after a block"); the 13 events (`HOOK_EVENT_INFO`: `toolMatcher` true for PostToolUseFailure and
     PermissionRequest; the placeholder descriptions C42's compile fix left for the five new events in
     `customize/hooks.ts` replaced with real ones); "Prompt hooks work only for {events}."; the command options Args /
     Run in background (`async`) / Only if (`if`) / Status message; `mode: 'project'` + `target` saves through the
     store's `saveProjectHook` (PUT the settings file's `hooks` key; stale → the conflict banner; the saved answer's
     pending count → Review). *Accept:* `HookEditor.test.ts` (prompt create, the event list, project save, stale).
  2. **W12.12-T2 Rows and sections** — project rows Edit… (`hook-edit`); untrusted plugin rows (a pending plugin row:
     `hook-row[data-source=plugin][data-state=pending]`, "Plugin not trusted" + "Review plugin…"
     `data-action="trust-plugin"` → `TrustDialog`; harness-format plugins only); prompt rows `data-kind="prompt"`; the
     project section shows `unknown-event` / `unsupported-type` diagnostics; prompt hooks show their prompt instead of a
     command. *Accept:* `HookRow.test.ts`, `HookSection.test.ts`, `HooksPanel.test.ts`.
  3. **W12.12-T3 Import** — `importHooks` keeps prompt hooks (no "prompt hooks aren't supported" note; `http` /
     `mcp_tool` / `agent` still noted as ignored); the five events. *Accept:* `HookImportDialog.test.ts`,
     `hooks.test.ts`.
  4. **W12.12-T4 Agent settings** (Settings → General → Agent) — "Hook model" (`settings-hook-model`, setting
     `hookModelRef`, "Automatic" = the provider's small model) and the "Claude model names" selects
     (`settings-model-alias[data-name]`) Sonnet / Opus / Haiku / Fable (each a model or "Not set"; help: used by
     definitions that say `model: sonnet` and the like). *Accept:* `AgentSettingsSection.test.ts`.
  5. **W12.12-T5 Store** — `saveProjectHook(...)` behind C46's signature; stale on `workspace.changed` for settings
     files. *Accept:* `hooks.test.ts` (store).
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W12.13 chat-web

- **Mission.** The trust dialog's mixed select-all and prompt-hook items, the agent color in tasks, the `harnessAsked`
  badge and note, prompt-hook and new-event notes, the hook activity label, qualified slash names, skill file reads and
  fork reports, share rows, and the project MCP dialog's Edit .mcp.json… entry.
- **Owned.** `W/components/projects/{trust,mcp}/**`, `W/components/chat/{agent,hooks,parts,composer}/**`,
  `W/components/share/**`.
- **Read-only highlights.** UI.md 2.19, 7.8 (the slash menu), 7.33 (project MCP), 7.34 (the chat additions), 9.14, 10.9,
  11.9, 13.13, 14, 15; web-process.md part (1) (Settings, data and chat); `SH/chat.ts` (`hookDataSchema.harnessAsked`,
  `hookResult.kind` / `model`, the activity label), `SH/schemas/{project-trust,agent}.ts`;
  `ProjectTrustDialog.vue:104-134`, `:485`; `W/components/ui/checkbox/Checkbox.vue:20-32`; `TaskBlock.vue`;
  `ToolHookBadge.vue`; `hook-notes.ts`; `slash-commands.ts` (`HINT_PATTERN` `:161`, `QUERY_PATTERN` `:216`);
  `useChatSession().hookActivity` (C46, frozen).
- **Tasks.**
  1. **W12.13-T1 Trust dialog** — the select-all checkbox renders its own `MinusIcon` for `indeterminate` (else
     `CheckIcon`) through the frozen Checkbox's default slot (no CCR; reka sets `aria-checked="mixed"` and
     `data-state=indeterminate`); trust items show prompt hooks (the prompt in the `<pre>` named "Prompt", the model)
     and the handler fields (args, async, if). *Accept:* `ProjectTrustDialog.test.ts` (a partial selection shows the
     minus and `aria-checked="mixed"`), `ProjectTrustItem.test.ts`.
  2. **W12.13-T2 Agent color** — `TaskBlock`: an 8 px dot and a 2 px left rule mapped to existing tokens (red →
     destructive, green → success, yellow → warning, blue → info, purple / orange / pink / cyan → chart-1 … chart-4),
     `aria-hidden` (the agent type stays text; `data-slot="task-agent-color"` with `data-value`). *Accept:*
     `TaskBlock.test.ts`.
  3. **W12.13-T3 Hook badges and notes** — `ToolHookBadge` "Allowed by hook · still asks" when `harnessAsked`
     (`data-state="still-asks"` on `tool-row-hook` and `hook-note`; tooltip "harness-forge still asks for this call
     (plan mode, a tool that runs commands, or an Always ask policy)."); `HookNote` / `hook-notes.ts` for prompt-hook
     records (`hooks[].kind: 'prompt'`, the model) and the new events (PostToolUseFailure feedback, PermissionRequest
     decisions, SubagentStart context, PostCompact); "Running hook…" shows the activity `label` when present. *Accept:*
     `ToolHookBadge.test.ts`, `HookNote.test.ts`, `hook-notes.test.ts`.
  4. **W12.13-T4 Slash menu** — qualified names (`/review-kit:db:migrate`, ≤ 128 characters) in the patterns and the
     menu (the plugin namespace muted), bare aliases shown only when the server lists them. *Accept:*
     `SlashMenu.test.ts`, `slash-commands.test.ts`.
  5. **W12.13-T5 Skill and share rows** — `SkillToolBody` shows a read `file` (`fileAccess: 'skill'`) and a fork report;
     share rows keep qualified names and still drop hook parts. *Accept:* `SkillToolBody.test.ts`,
     `ShareToolRow.test.ts`.
  6. **W12.13-T6 Edit .mcp.json…** — `ProjectMcpDialog` (`W/components/projects/mcp/`, open point 21): the footer action
     **Edit .mcp.json…** (`data-action="edit-mcp-json"`; also in the empty state, where it creates the file) → the
     project file editor with kind `mcp` (W12.11's `ProjectFileEditor`, frozen props; mounted as UI.md 10.9 says); a
     saved server stays pending until it is approved in the dialog. *Accept:* `ProjectMcpDialog.test.ts`.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### G12P gate probes

- **Mission.** Write `.tmp/gates/P12-A/probe.mjs` (the catalogue in "Gate probes" below) during the wave against the
  contracts of this file, API.md and PROVIDERS.md 8; run it after the coordinator's build signal on :8896 – :8898 while
  the coordinator runs e2e on :8899; report every check with its result ("spec differs" when the code is right and the
  spec is not, with the evidence).
- **Owned.** `.tmp/gates/P12-A/**`.
- **Read-only highlights.** `.tmp/gates/P11-A/{lib,probe,s-*}.mjs` (the harness: `startServer`, `client`, `login`,
  `newProject`, `say`, `settle`, `rows`, `writeDefs`, `sentinel`, `hookScript`, `writeHooks`, `approve`, `copyMcpMin`,
  `mcpHttpFixture`, `zipText`, `check`, `section`, `guarded`, `stopAll`), `.tmp/upgrade-v17-ids.json`, PROVIDERS.md 8,
  `S/testing/{fake-remote,claude-fixtures,hook-scripts}.ts` (copy what the probes need; the probes run the built server,
  not the TypeScript sources).
- **Rules.** New helpers `fakeRemote()` (the loopback fake, port 0, its request log), `claudeHome(dir)` (a fake home
  with canaries), `claudePlugin(dir, name)`, `marketplaceDir(dir)`, `uploadFolder(c, files)` (multipart), `canaries()`
  (the `HF_CANARY_…` strings), `trustRows`, `hookRows`, `alive(pid)`; every probe server runs with `HF_MOCK_PROVIDER=1
  HF_TEST_REMOTE_URL=<fake> HOME=<temp folder with a sentinel file>` and its own `HF_DATA_DIR` / `HF_WORKSPACE_ROOTS`
  under `.tmp/gates/P12-A/run-<ts>/`; the import server also with `HF_CLAUDE_HOME=<temp fake home>`; hook scripts are
  `sh` files (never `sh -c` strings); every server, fixture and fake-remote process stopped at the end (kill by port,
  pids checked).

### Wave P12-A ownership

These globs are the plan's table, with W12.7's catalog glob written as the explicit stem list (open point 7), so no path
has two owners. The audit cannot express "except": every `types.ts` of `S` (`S/plugins/claude/types.ts`,
`S/plugins/marketplaces/types.ts`, the service `types.ts` files), `S/registry/types.ts`, `S/services/data/references*`,
`S/plugins/install/testing.ts`, `S/chat/subagent/host.ts`, `S/chat/background/types.ts`, `S/services/chats/types.ts`,
the C41 / C42 helpers and the P12-0b stub props stay frozen despite the globs; `S/http/routes/{chat,chats,chat-queue}*`
also matches `chat-tasks*` (no other owner; W12.6's).

```json
{
  "wave": "P12-A",
  "agents": {
    "W12.1": [
      "apps/server/src/plugins/claude/**",
      "apps/server/src/plugins/{formats,declarative,loader,context,host}*",
      "apps/server/src/registry/**",
      "apps/server/src/services/customizations/plugins*",
      "examples/plugins/claude-review-kit/**",
      "examples/plugins/examples.test.ts"
    ],
    "W12.2": [
      "apps/server/src/plugins/install/**",
      "apps/server/src/plugins/marketplaces/**",
      "apps/server/src/http/routes/{marketplaces,plugin-install,plugins}*"
    ],
    "W12.3": [
      "apps/server/src/services/claude-import/**",
      "apps/server/src/http/routes/claude-import*",
      "apps/server/src/services/data/**"
    ],
    "W12.4": [
      "apps/server/src/services/project-definitions/**",
      "apps/server/src/http/routes/project-definitions*"
    ],
    "W12.5": [
      "apps/server/src/services/{hooks,project-config,project-trust}/**",
      "apps/server/src/http/routes/{hooks,project-trust}*"
    ],
    "W12.6": [
      "apps/server/src/chat/{hooks-prompt,steer,queue,index}*",
      "apps/server/src/chat/{subagent,compaction,background}/**",
      "apps/server/src/http/routes/{chat,chats,chat-queue}*",
      "apps/server/src/services/chats/**"
    ],
    "W12.7": [
      "apps/server/src/services/customizations/{builtins,cache,catalog,discover,entries,index,memory,notifier,snapshot,store,import,qualified}*",
      "apps/server/src/chat/{commands,prepare,context,notices,params,output-style,skills,model-aliases}*",
      "apps/server/src/chat/inline/**",
      "apps/server/src/http/routes/{commands,customizations}*",
      "apps/server/src/builtin-plugins/core-agent/skill*"
    ],
    "W12.8": [
      "apps/web/app/pages/plugins/marketplaces*",
      "apps/web/app/components/plugins/marketplaces/**",
      "apps/web/app/stores/marketplaces*",
      "apps/web/app/components/app-shell/PluginsNav*"
    ],
    "W12.9": [
      "apps/web/app/components/plugins/{install,detail,list}/**",
      "apps/web/app/stores/plugins*"
    ],
    "W12.10": [
      "apps/web/app/components/settings/claude-import/**",
      "apps/web/app/composables/useClaudeImport*",
      "apps/web/app/pages/settings/customize.vue",
      "apps/web/app/components/settings/data/**"
    ],
    "W12.11": [
      "apps/web/app/components/settings/customize/{Customization*,customize*,CustomizeSettings*,ProjectFile*,ToolMultiSelect*,StyleScopeBar*}",
      "apps/web/app/stores/customizations*"
    ],
    "W12.12": [
      "apps/web/app/components/settings/customize/{Hook*,hooks*}",
      "apps/web/app/stores/hooks*",
      "apps/web/app/components/settings/agent/**"
    ],
    "W12.13": [
      "apps/web/app/components/projects/{trust,mcp}/**",
      "apps/web/app/components/chat/{agent,hooks,parts,composer,background}/**",
      "apps/web/app/stores/background-tasks*",
      "apps/web/app/components/share/**"
    ],
    "G12P": [
      ".tmp/gates/P12-A/**"
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

A file a P12-A agent creates outside its globs is a CCR: the coordinator adds it to the wave file at the gate. Unowned
in P12-A (a needed change is a CCR; new test helpers go into the agent's own files):
`S/chat/{hooks,approval,tools,steps,pipeline,markers,model-history,agent-scope}.ts`, `S/chat/subagent/host.ts`,
`S/chat/{modes,runs,history,usage,title,files,scope,errors,generated-files,images,tool-history,plan-file,testing}*`,
`S/workspace/**`, `S/mcp/**`, `S/security/**`, `S/env*`, `S/deps*`, `S/testing/**`, `S/builtin-plugins/` other than
`core-agent/skill*`, `W/utils/testids.ts`, `W/stores/ui.ts`, `W/composables/{useServerEvents,useChatSession}*`,
`W/components/app-shell/` other than `PluginsNav*`, `W/components/chat/` outside `{agent,hooks,parts,composer}/`.

### Wave P12-A cross-agent contracts

The props below are frozen in the P12-0b stubs or documented in UI.md 10.9; the server members in the frozen files.

| Producer → consumer | Contract |
|---|---|
| C43 / C44 / C45 → every server agent | the service interfaces, the seams, the fakes, the mock, the fake remote, the builders |
| W12.2 → W12.1 | the staged folder + `sourceRef` (the commit) passed to `inspectDirectory(dir, { format, overlay, nameHint })` |
| W12.1 → W12.2 | `readClaudePluginDirectory` behind `inspectDirectory` (the inspection's `format` / `claude`, the tree hash as the reviewed sha256); `detectPluginLayout` |
| W12.1 → W12.7 | the skill-files helper (`S/plugins/claude/skill-files.ts`); plugin entries with qualified names and `syntax: 'markdown'` |
| W12.5 → W12.6 | the prompt-hook runner through `HookSnapshot.run`; `statusMessage`; `sessionEnd` |
| W12.7 → W12.3 | `customizations.importDefinitions`, `turnedOff` from `restoreBackup` |
| W12.5 → W12.3 | `hooks.importPersonal` |
| W12.7 → W12.5, W12.6 | `resolveClaudeModel` |
| W12.4 ↔ W12.5 | `project-config.invalidate` + `workspace.changed { source: 'user' }` → `project-trust.changed` with the new pending count |
| W12.9 → W12.8 | the `InstallReview` props |
| W12.8 → W12.9 | the `MarketplaceInstallDialog` props (the update banner opens it) |
| W12.12 → W12.10 | `importHooks` (hook labels in the import preview) |
| W12.13 → W12.11, W12.12 | the `ProjectTrustDialog` props (Review after a save) |

### Gate probes (`.tmp/gates/P12-A/probe.mjs`)

Built on the P11-A harness plus `fakeRemote`, `claudeHome`, `claudePlugin`, `marketplaceDir`, `uploadFolder`. Probe
servers: **8896** plugins and marketplaces (groups 1 – 3, 14), **8897** import, project files and hooks (groups 4 – 13,
15), **8898** upgrade (group 16); each with `HF_MOCK_PROVIDER=1 HF_TEST_REMOTE_URL=<fake> HOME=<temp with a sentinel>`,
its own `HF_DATA_DIR=.tmp/gates/P12-A/run-<ts>/<name>` and `HF_WORKSPACE_ROOTS`; 8897 also `HF_CLAUDE_HOME=<temp fake
home>`; restarts with `HF_OFFLINE=1`, `HF_CLAUDE_HOME=0`, `HF_SAFE_MODE=1` where a group says so. Prompt hooks use
`hookModelRef: 'mock:prompt-hook'` (or the handler `model`). Loops run through `bash -c`.

1. **Claude plugin (zip / folder)** — the `review-kit` zip and folder are detected as `claude`; the id is the slug; the
   inspection lists the executables, hosts, `userConfig` (the secret flagged) and the ignored `.lsp.json` / `bin/`;
   `/review-kit:review` and `/review-kit:db:migrate` expand; the bare `/review` works while unique and stops after a
   second plugin adds `review`; install without fresh auth → 403 when trust is needed; the `notes-only` plugin installs
   without trust and works; the `userConfig` secret reaches the http MCP fixture as a header and appears in no body, no
   answer and no log; the `${CLAUDE_PLUGIN_ROOT}` hook writes its sentinel only after trust; the exec bit of
   `hooks/format.sh` is kept (0755) and the hook runs; editing one script on disk → the plugin is untrusted (whole-tree
   hash) and the hook stops; `skill { name: 'review-kit:pdf', file: 'scripts/fill.sh' }` reads the file, `../x` is
   refused; `.lsp.json` / `bin/tool` never spawned; a `defaultEnabled: false` variant installs disabled.
2. **GitHub source** — `{ source: 'github', repo, ref }`: the fake log shows the commits API, then the codeload zip of
   that sha; `sourceRef` names the sha; oversize, traversal, link, wrong-comment and wrong-top-folder archives refused
   with clear errors; the rate-limit switch → the `refs/heads` fallback with the sha from the comment; no `git` process
   at any time (the spawn allowlist test passes; no `git` in the process list); `HF_OFFLINE=1` → a GitHub install 409
   `offline`.
3. **Marketplaces** — add github / url / path sources; unsupported rows (git elsewhere, command, custom npm registry)
   with reasons; a relative entry installs from the stored commit's subtree (after the ref moved, the old commit is
   still used until a refresh); install with fresh auth; ref moves → refresh → "update available" → update re-reviews (a
   new tree hash needs a new trust); remove keeps the installed plugins; the official suggestion sends **0** requests
   before a click (the fake log is empty); `claude-plugins-official` from a non-`anthropics` repo refused; 429
   `rate_limited`; `marketplace.changed` events; `HF_OFFLINE=1` → 409 `offline` for adding or refreshing a github / url
   marketplace and for a marketplace install that needs the network, while a folder marketplace still adds, refreshes
   and installs.
4. **Import scan** (`HF_CLAUDE_HOME` = the temp fake home) — `GET /claude-import/home` available; `POST /scan` 403
   without fresh auth; the plan statuses new / update / unchanged / conflict / unsupported / invalid each present; the
   canaries (`.credentials.json`, `projects/`, `oauthAccount`, `primaryApiKey`, `history.jsonl`) never opened (no
   `HF_CANARY_…` string in any answer, event or log line); a restart with `HF_CLAUDE_HOME=0` → home `disabled` and scan
   409 `disabled`.
5. **Import upload** — the same fake home as folder files (`files[]` + `.claude.json`) and as a zip gives the same plan
   (items, statuses, keys) as the scan; non-allowlisted files in the upload are ignored and never echoed.
6. **Import apply** — 403 without fresh auth; exactly one `customization.changed` and one `hooks.changed`; command hooks
   and `!` commands off unless enabled; overwrite keeps `enabled`, rename gives `<name>-2`; Bash rules → global shell
   rules (refused prefixes stay unsupported); `CLAUDE.md` append and replace; `.claude.json` servers created (`${VAR}`
   from the settings `env`; a `process.env` canary set in the server's own environment never used); per-project servers
   disabled; an expired plan (or one applied twice) → 404.
7. **Project files** — create / update / delete an agent; the settings `hooks` splice keeps the other keys; `.mcp.json`
   `mcpServers` saved; 409 `stale` on a changed file; a link, `.git/config`, `.env` and an outside path refused;
   `workspace.changed { source: 'user', chatId: null }`; a saved hook is pending and does not run (sentinel);
   `trust.pending` in the answer; a save during an active run succeeds.
8. **Prompt hooks** (`mock:prompt-hook`) — per event: PreToolUse deny ends the turn (and with `continueOnBlock` only
   denies); PostToolUse feedback; PostToolUseFailure feedback; UserPromptSubmit 409 `hook-blocked`; Stop continues once
   (origin `hook`) unless `impossible`; SubagentStop; PermissionRequest records only; `[[ph:fenced]]` works,
   `[[ph:invalid]]` and a missing model are non-blocking errors; a usage row with purpose `hook`; a project prompt hook
   pending until approved (v2 item); `hooksEnabled: false` and `HF_SAFE_MODE=1` → none runs; `HF_WORKSPACE_SHELL=0` →
   prompt hooks still run.
9. **New events** — PostToolUseFailure feedback after a failing tool (not after an abort); PermissionRequest `allow`
   approves a write in `ask` but never in plan mode or for `shell`, `deny` blocks, a child never runs it; SubagentStart
   context reaches the child (`mock:hooks agent …`); PostCompact recorded after the marker (`/compact` and automatic);
   SessionEnd on a single chat delete only (none on delete-all or a project delete).
10. **Handler fields** — `args` quoting (the `print-args` script sees each argument verbatim, no injection); `async`
    runs detached and is killed at its timeout (pid dead); `if` matching (`Bash(git:*)` runs only for git commands) and
    an invalid `if` → `invalid-if`, never runs; `statusMessage` is the activity `label` in the stream.
11. **`transcript_path`** — the file exists only when a hook ran, mode 0600, valid JSONL with Claude tool names, absent
    from the backup zip, deleted with the chat.
12. **Frontmatter** — `disallowedTools`, `maxTurns`, the `skills` preload, `model: sonnet` through `modelAliases`, a
    fork skill through `skill`, `$0` / `$ARGUMENTS[1]` / `$name`, the legacy `$1` unchanged, `${CLAUDE_SKILL_DIR}`, the
    ignored keys as info diagnostics.
13. **Leftovers** — an untrusted plugin's hook rows (`pending`, source `plugin`); `harnessAsked` on a hook `allow` in
    plan mode; a restore of a backup with a `!` command reports `turnedOff: 1`.
14. **Plugin API 1.6.0** — health `pluginApiVersion` 1.6.0; `^1.5.0` plugins (`hook-pack`, `agent-pack`) load; a harness
    manifest with a prompt-only hook installs without trust; the golden v1 trust hashes unchanged.
15. **Hygiene** — the fake-remote log is the only network; `git status` identical around `pnpm test`; no secrets,
    prompts, answers, commands or `HF_CANARY_…` strings at `info`; no `.claude*` / `.harness` / `.mcp.json` in the
    repository; the `HOME` sentinel untouched; no orphan processes; the ports free.
16. **Upgrade** (8898, a fresh `.tmp/upgrade-v17` copy with copied roots) — the Gate P12-0b checks (G12B), plus:
    approving the v1.8-only `prompt` hook makes it run; the `SessionEnd` hook, once approved, runs on a single delete;
    the seeded `reviewer2` agent shows its new keys; `args0` / `args1` expand with their bases; the stored v1.7
    expansions are reused.

### Gate P12-A

1. `node scripts/audit-ownership.mjs .tmp/waves/P12-A.json`
2. Batch the CCRs → `nuxi prepare` → `pnpm check` → `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
3. `mv .tmp/e2e .tmp/e2e-old-p12-a` → the G12P probes (the catalogue above).
4. **Regressions** (one after another: shared ports) — the coordinator's copy `.tmp/gates/P12-A/p11a-regression/` (open
   point 18; every section incl. its v1.6 upgrade on `.tmp/upgrade-v16`), the P10-A copy
   `.tmp/gates/P11-A/p10a-regression.mjs` (incl. its v1.5 upgrade), `node .tmp/gates/P9-A/probe.mjs` (incl. its v1.4
   upgrade) and `node .tmp/gates/P8-A/probe.mjs ws git`.
5. `pnpm test:e2e` (`chromium` + `mobile` + `tablet`; the feature specs come in P12-B) → 191 green.
6. `E2E_SCREENSHOTS=1 pnpm test:e2e --grep @screenshots` → review `.tmp/screenshots/{dark,light}/` (the new screens on
   desktop and 390 px).
7. `pnpm audit --prod --audit-level high` clean (the ignored advisories excepted).
8. Digest `.tmp/waves/P12-A-notes.md`; red items → W12.16 / W12.17; ROADMAP + wave log → commit `feat: add claude code
   plugins, marketplaces and home import`.

---

## Wave P12-B — feature e2e, docs, fix-ups

### Coordinator actions

- Before the launch: the P12-A checkpoint build for W12.14; W12.16 / W12.17 globs from the red P12-A gate items added to
  `.tmp/waves/P12-B.json` (launched only when needed); the P12-A reports handed to W12.15 as the digest
  `.tmp/waves/P12-A-notes.md` (contract facts, deviations, items marked "For W12.15").
- The final gate below; ROADMAP (every Phase 12 box, the backlog, the wave log); the memory file; push only when the
  user asks.

### W12.14 e2e-features (e2e 8891)

- **Mission.** End-to-end specs for the import, project file editing, prompt hooks, marketplaces, Claude plugins and
  plugin updates; the extensions of existing specs; mobile and tablet checks; screenshots of the new screens and
  full-frame README shots.
- **Owned.** `e2e/**`.
- **Read-only highlights.** UI.md 2.19, 8.13, 9.14, 12, 13.13, 14; PROVIDERS.md 8 (`mock:prompt-hook`, `mock:hooks`);
  `playwright.config.ts`; `e2e/README.md`; `e2e/helpers/{chat,workspace,customize,hooks,data,keyboard,fixtures}.ts`;
  `e2e/fixtures/{zip.ts,plugins.ts}`; the builders of `S/testing/claude-fixtures.ts` (copy their shapes into e2e
  helpers; e2e never imports server code).
- **Rules.** Project folders only under `.tmp/e2e/workspaces/*`; fake homes, Claude plugin folders and marketplace
  folders in `realpath(mkdtemp())` folders **outside the repository**, removed after the spec; marketplaces use
  **local-folder** sources (no fake remote, no network; they work with the e2e server's `HF_OFFLINE=1`); the server scan
  is never triggered and `GET /api/claude-import/home` is stubbed with `page.route` wherever the import dialog renders
  (open point 12); hook scripts are POSIX `sh` files invoked as `sh <relative path>`; prompt hooks use `hookModelRef:
  'mock:prompt-hook'`; never `.claude/`, `.harness/`, `.claude-plugin/` or `.mcp.json` in the repository.
- **Tasks.**
  1. **W12.14-T1 `core/claude-import.spec.ts`** — Customize → Import from Claude Code (and `?import=claude` from
     Settings → Data); the folder upload of a temp fake home (+ `.claude.json`); the preview groups and statuses; the
     mixed group checkbox; an executable item turned off by default and enabled; Import with the password prompt; the
     result lines; the imported agents, commands, hooks (off), MCP servers and shell rules appear; a re-import shows
     Unchanged / Replaces yours.
  2. **W12.14-T2 `core/project-edit.spec.ts`** — a project row → Edit… → change → Save → "1 item needs your approval." →
     Review; a stale save (the file edited on disk) → the conflict banner → Load from disk / Overwrite; a project hook
     edited in the hook editor; saving never approves (the hook does not run until approved).
  3. **W12.14-T3 `core/prompt-hooks.spec.ts`** — a personal Prompt hook (the Type toggle) on PreToolUse: `mock:hooks
     call write_file {… [[ph:deny x]] …}` → "Blocked by hook"; `continueOnBlock`; a UserPromptSubmit prompt hook refuses
     a message (the text stays in the composer); the Hook model setting. (Distinct from the Phase 11
     `core/hook-prompts.spec.ts`, which covers UserPromptSubmit command hooks.)
  4. **W12.14-T4 `plugins/marketplaces.spec.ts`** — the official suggestion card (dismiss; no request — a `page.route`
     counter on `/api/marketplaces` POST); add a local-folder marketplace; the strip, search and category; unsupported
     rows; install an entry with the trust consent and the password; remove the marketplace (the plugin stays).
  5. **W12.14-T5 `plugins/claude-plugin.spec.ts`** — install a Claude plugin from a zip and from a folder: the format
     badge, namespaced names, "Asks for:" with the secret field, "Ignored"; the settings form shows the `userConfig`
     secret; `/<plugin>:<command>` runs in a chat; the plugin page lists its components and has no editor.
  6. **W12.14-T6 `plugins/plugin-update.spec.ts`** — bump the version in the local marketplace folder → Refresh → the
     update badge and banner → Update… → the review → updated.
  7. **W12.14-T7 Extensions** — `customize` (the new editor fields, Edit… on project rows), `hooks` (Prompt type, the 13
     events, an untrusted plugin row with "Review plugin…"), `project-trust` (the mixed "Select all": `aria-checked`
     `mixed`), `data` (a restore reports the turned-off count).
  8. **W12.14-T8 Mobile and tablet** — `mobile/marketplaces.spec.ts` and `mobile/claude-import.spec.ts` (390 px: the
     strip becomes a select, the wizard is full screen with a sticky footer, the file editor sheet fits, no horizontal
     scroll); the tablet touch-target spec covers the entry buttons, the wizard checkboxes and resolution selects, the
     file editor buttons and the hook type toggle (≥ 40 px).
  9. **W12.14-T9 Screenshots** — `plugins-marketplaces`*, `install-github`, `install-claude-preview`*,
     `claude-import-preview`*, `project-file-editor`*, `hook-editor-prompt`, `trust-select-partial` (dark + light; * =
     also mobile; the import home path stubbed) and the `@readme` full-frame shots for every README image.
  10. **W12.14-T10 README** — `e2e/README.md` lists the new specs.
- **Verify.** `pnpm test:e2e --list`; slot runs (`HF_MOCK_PROVIDER=1 HF_OFFLINE=1 HF_PORT=8891
  HF_DATA_DIR=.tmp/W12.14/data node apps/server/dist/main.mjs`, `E2E_BASE_URL=http://127.0.0.1:8891 pnpm test:e2e`);
  three green runs of the new specs; watch the CI e2e job budget (about 215 tests, 30 minutes).

### W12.15 docs-final

- **Mission.** Reconcile every doc with the code and the agent reports.
- **Owned.** `README.md`, `.env.example`, `docs/**` except `DECISIONS.md` and `ROADMAP.md`, `docs/assets/**`,
  `examples/plugins/README.md`.
- **Read-only highlights.** `.tmp/waves/P12-A-notes.md`, the code of every Phase 12 area.
- **Tasks.**
  1. **W12.15-T1 Reconcile** — API.md vs the route table and the implemented answers (`marketplaces`, `claudeImport`,
     `projectDefinitions`, the `pluginInstall` sources, `marketplace.changed`, `offline`, the hook / trust / agent /
     setting / data additions); UI.md 13.13 vs `utils/testids.ts`, the contracts (10.9), the stores and modules (11.9),
     the copy (15), the shortcuts (12); ARCHITECTURE.md vs the implemented flows (Claude plugins, marketplaces, import,
     project edits, prompt hooks / events / transcripts, frontmatter, the stop order, backups, `0009`, security 10.13,
     log rules); PLUGINS.md (1.6.0, "Claude Code plugins", `claude-review-kit`, the snippets `examples.test.ts`
     compares); PROVIDERS.md 8 (`mock:prompt-hook`) vs the mock model; the guides `claude-code-import.md`,
     `claude-code-plugins.md`, `hooks-and-project-mcp.md`; `examples/plugins/README.md` (eight examples); the settings
     splice formatting (open point 11).
  2. **W12.15-T2 Status** — README "v1.8" (features: Claude Code plugins and marketplaces, GitHub installs without git,
     the import from Claude Code, editing project definition files, prompt hooks and the new events, frontmatter
     compatibility, plugin API 1.6.0); `docs/assets/screenshots/` refreshed from the `@readme` shots at the final gate
     (the coordinator copies them).
  3. **W12.15-T3 This file** — what actually happened (status, "Deviations found while building", gate results per
     wave).
- **Verify.** `pnpm check:english`; `pnpm -F @harness-forge/shared test` (doc-coupled tests).

### W12.16 / W12.17 fix-ups

Launched only for red P12-A gate items (W12.16 server, W12.17 web), with the globs of those items.

### Wave P12-B ownership

```json
{
  "wave": "P12-B",
  "agents": {
    "W12.14": ["e2e/**"],
    "W12.15": [
      "README.md",
      ".env.example",
      "docs/API.md",
      "docs/UI.md",
      "docs/ARCHITECTURE.md",
      "docs/PLUGINS.md",
      "docs/PROVIDERS.md",
      "docs/guides/**",
      "docs/phases/phase-12-v1-8.md",
      "docs/assets/**",
      "examples/plugins/README.md"
    ],
    "W12.16": [],
    "W12.17": []
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

1. `node scripts/audit-ownership.mjs .tmp/waves/P12-B.json` → `pnpm install --frozen-lockfile` → `pnpm check` → `pnpm
   build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
2. The P12-A probes again (after `mv .tmp/e2e .tmp/e2e-old-final-v18`) plus the regressions (the P11-A and P10-A copies,
   P9-A, P8-A `ws git`; one after another: shared ports).
3. `for i in 1 2 3; do pnpm test:e2e || exit 1; done` (`chromium` + `mobile` + `tablet`), with the OS color scheme
   emulated as light; `E2E_SCREENSHOTS=1 pnpm test:e2e --grep @screenshots` → dark + light reviewed (the Marketplaces
   page, the GitHub tab and the Claude preview, the import wizard, the project file editor, the hook editor's Prompt
   type, the partial trust selection on desktop and mobile); the README images copied from the `@readme` shots.
4. `pnpm audit --prod --audit-level high`; the advisories re-checked with the P8-00 rule.
5. **Real v1.7 → v1.8 upgrade**: the `.tmp/v17` worktree build (`b3fa452`) seeds a fresh data directory with the full
   K3S seed set, stop it, start v1.8 on the same data directory → the G12B checks (`0009` applied, every v1.7 approval
   still approved and running, the pending item pending, nothing new run before approval); approving the new `prompt`
   hook works.
6. **Docker** (daemon permitting, else the CI `docker` job), uid 1000: the default `GET /claude-import/home` →
   `disabled`; with `-v <fake home>:/claude:ro -e HF_CLAUDE_HOME=/claude` the scan plans as uid 1000 and never opens the
   canaries; a Claude plugin zip whose `hooks/hooks.json` runs `${CLAUDE_PLUGIN_ROOT}/scripts/mark.sh` keeps mode 0755
   (`docker exec stat`) and writes `id -u` = 1000 only after trust (a fresh login); `docker stop` leaves no orphan.
7. `pnpm test` is hermetic: `git status --porcelain` of the repository unchanged, no `.claude/`, `.harness/`,
   `.claude-plugin/` or `.mcp.json` created in the repository, the real `~/.claude` never read, no network beyond
   loopback, no leftover processes.
8. ROADMAP (every box, the backlog, the wave log) + memory → commit `chore: final gate for harness-forge v1.8`; push
   only when the user asks. The live provider suite stays the user's (paid).

---

## Outcome

Completed by the coordinator at each gate ("audit" is the ownership audit of `scripts/audit-ownership.mjs`). P12-00 is
summarized in the status line at the top.

(Nothing yet.)

---

## Risks

State before P12-0a.

| Risk | Mitigation |
|---|---|
| Remote code from a marketplace or GitHub | whole-tree hash, the review + fresh auth, no automatic add or update, update = a new review, the pinned commit shown; probes 1 – 3 |
| Supply-chain drift on a moving ref | resolved to a commit sha at add / install; relative entries from the stored commit; probe 3 |
| Secrets in `~/.claude` / `~/.claude.json` | the allowlist (browser and server), `mcpServers` extracted first, the plan stays server-side, canary probes; probes 4 – 6 |
| Tests touching the real home or the network | a temp `HF_CLAUDE_HOME` and `HOME`, the fake remote, the injected fetch, the hygiene probe, the e2e `page.route` stub; probe 15 |
| v1.7 approvals orphaned by hash changes | the v1 layout unchanged without `extra`; golden tests (C42); the upgrade probes (G12B, probe 16, the final gate) |
| Qualified names ripple through ~12 schemas and the web | C40's widening + compile fixes at P12-0a; the bare-alias rule in one place (W12.7) |
| UI writes racing the agent | the file lock + the sha check (409 `stale`); not journaled (documented) |
| Prompt-hook cost or loops | the timeout, the 8-call limit, the continuation cap of 5, the usage purpose `hook`, the kill switches |
| Exec bits / missing interpreters (`python3`, `jq`) in Docker | fixtures use POSIX `sh`; the docs note; the Docker check |
| GitHub rate limit (60 / h) | one commit resolution per add / refresh / install; the codeload fallback; a clear 429 |
| Ubuntu 26 runner churn | runners pinned to `ubuntu-24.04` (`c89ca97`); unpinning in the backlog |
| Archive size and subtree selection (repo zips with big trees) | the 50 MB repo cap, `select(path)` before admission, caps counted on the subtree |
| OAuth-only remote MCP servers in official plugins | a diagnostic, no connection (documented) |
| Frozen signature churn (chat seams, stores, `useChatSession`, the trust dialog) | every seam complete in P12-0b; one owner per hot file in P12-A; the open points decided at Gate P12-0a |
| Wave size (13 + G12P) | the first cuts; W12.16 / W12.17 |
| Count pins (routes 132 / 36, fresh 14, SSE 19, settings 32, conflict reasons 15, tables 23, mocks 18, hook events 13, test ids) | listed by C40 / C43 / C45 / C46; accepted at the audits; the regression probe copies |
| A cached mock listing hides `mock:prompt-hook` | `mv .tmp/e2e` before every gate |
| CI e2e budget (~215 tests) | watch the 30-minute job |
