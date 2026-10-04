# Roadmap

Single source of truth for progress. Edited only by the coordinator; agents suggest updates in their reports.
Task details, owned paths and acceptance criteria live in `docs/phases/phase-N-*.md`.

Legend: `[x]` done · `[~]` in progress · `[ ]` not started.

## Phase 0 — Reset, docs, scaffold, contracts

- [x] P0.1 Reset: back up untracked files outside the repository, wipe repo (built on a temporary branch that became `main`)
- [x] P0.2 Core docs: `AGENT.md`, `CLAUDE.md`, `docs/ROADMAP.md`, `docs/DECISIONS.md` (coordinator)
- [x] P0.3 Wave D + S (parallel)
  - [x] D1 `docs/ARCHITECTURE.md` + `docs/API.md`
  - [x] D2 `docs/PLUGINS.md` + `docs/PROVIDERS.md`
  - [x] D3 `docs/UI.md`
  - [x] D4 `docs/phases/phase-{0..4}-*.md` + `README.md` + `LICENSE`
  - [x] S0 scaffold: root configs, scripts, package.json files, install, Nuxt + shadcn-vue + AI Elements Vue, pins
  - [x] Gate D+S: docs consistency, `pnpm check && pnpm build` on skeleton, checkpoint commit
- [x] P0.4 Wave C-a
  - [x] C1+C2 contracts: `packages/shared` (schemas, DTOs, errors, route table, API client) + `packages/plugin-sdk` (plugin API types, `definePlugin`, re-exports)
  - [x] C3 web shell visuals (tokens, fonts, dark default, sidebar with Chat | Plugins, ProviderIcon, stub slots)
- [x] P0.5 Wave C-b
  - [x] C4 server skeleton (env, app factory, 501 route stubs, Drizzle schema + migration, interfaces, test harness)
  - [x] C5 web skeleton (stub pages, Pinia stores, `$api`, SSE client, shortcuts registry, test ids)
  - [x] C6 `core-providers` (13 providers) + `core-commands`
  - [x] FREEZE + gate + checkpoint commit

## Wave schedule (coordinator optimization)

Web UI agents depend only on frozen contracts, stores and shell components, so waves are merged:
- **Wave A** = W1.1–W1.5 (server core) + W2.2–W2.5 (chat/composer/sidebar/settings UI) — 9 agents.
- **Wave B** = W2.1 (chat server) + W3.1–W3.5 (plugins UI, install, wizard, code plugins, tools/MCP) — 6 agents.
- **Wave C** = W2.6 + W3.6 (e2e) + W4.1–W4.4 (security, UX polish, packaging, docs/examples) + W4.6 (core fixes) — 7 agents.
- **Wave D** = W4.5 (full e2e ×3, screenshots) + fix-ups.

## Phase 1 — Core services

- [x] W1.1 server-core (middleware, auth, password, session, headers, bind safety, SPA serving)
- [x] W1.2 secrets-settings (keyring, AES-256-GCM secrets, settings, provider credentials)
- [x] W1.3 plugin-host (loader, registry, lifecycle, guard, declarative adapter, compile, hot reload, plugins API)
- [x] W1.4 providers-catalog (model resolution, provider test, listings + cache + models.dev, prefs, icons, mock)
- [x] W1.5 chats-events-files (chat CRUD/search/export, messages, SSE events, file uploads)
- [x] Gate + checkpoint commit (Wave A)

## Phase 2 — Chat MVP + settings

- [x] W2.1 chat-server (pipeline, runs, approvals, commands, titles, usage/cost, errors)
- [x] W2.2 chat-web (useChatSession, transcript, part renderers, Markdown, empty state)
- [x] W2.3 composer-web (composer, attachments, model picker, effort, permission, slash menu)
- [x] W2.4 sidebar-web (chat list, status dots, palette, shortcuts dialog, global shortcuts)
- [x] W2.5 settings-web (providers & keys, models, general, appearance, about, login)
- [x] W2.6 e2e-core (smoke specs)
- [x] Gate + checkpoint commit (Wave B)

## Phase 3 — Plugins, tools, MCP

- [x] W3.1 plugins-web (list, detail, settings form, enable/disable/reload/uninstall/export)
- [x] W3.2 plugin-install (staging, zip/npm/url/folder, inspect, trust)
- [x] W3.3 provider-wizard (declarative provider plugin wizard + test)
- [x] W3.4 code-plugins (scaffold templates, file API, CodeMirror editor, build & reload)
- [x] W3.5 tools-mcp (MCP manager, tool prefs, core-tools, MCP panel)
- [x] W3.6 e2e-plugins
- [x] Gate + checkpoint commit (Waves B + C)

## Phase 4 — Hardening and release

- [x] W4.1 security audit + fixes
- [x] W4.2 UX polish (Claude Code parity, mobile, a11y, states, perf)
- [x] W4.3 packaging (tsdown build, start, Docker, CI)
- [x] W4.4 docs + example plugins
- [x] W4.6 core fixes (tool history with tools off, host refresh/onStateChange, credentials setFor, flaky watcher tests)
- [x] W4.5 full e2e (3 green runs, screenshots) — coordinator
- [x] Final gate + checkpoint commit

## Doc follow-ups (batched into W4.4)

- PLUGINS.md: list the 10 builtin `core-commands` (explain, summarize, review, fix, refactor, tests, docs, commit,
  translate, proofread); `ProviderDefinition.icon` accepts `string | { color?, mono? }`; clearing secret settings
  (`''` vs `null`) wording.
- PROVIDERS.md: MiniMax default `max_tokens` (131072 for M3, 65536 otherwise), OpenRouter `validate` via `GET /key`,
  Ollama effort menu from `/api/show` `thinking.values`, xAI returns 400 for a bad key (mapped to `auth_invalid`).

- UI.md 10.4/11: ChatMessage `busy`/`error`/`commandReply` + `startEdit()`, ChatView `header`/`empty` slots;
  `useChatSession` extra fields (`summary`, `persisted`, `loadError`, `busy`, `load`, `refresh`, `resumeIfRunning`);
  store additions marked `+` in C5's report (auth `markUnauthenticated`, chats `loaded`/`done`, plugins `*Loaded`,
  `refreshLoaded`); test ids `error-page`, `error-back`, `password-remove`.
- Hardening notes: flaky `plugins/host.test.ts` hot-reload timing under full-suite load; markstream CSS has unscoped
  `.container` rules; AI Elements `vue-stream-markdown` components unused (drop dependency?); rate limiter ignores
  `X-Forwarded-For` (document reverse-proxy caveat); ship `apps/server/assets/catalog/` with `dist/`.

- W3.x doc updates: `SchemaForm` extra props (`secretHints`, `saving`) + reset semantics; Source tab also for editable
  declarative plugins; `PluginCard` event `view-logs`; wizard test ids (`wizard-step-*` on panels only,
  `data-step-item` on stepper items); declarative credentials cannot use `envVar`; API.md 5.18 file API deviations
  (`.git`/`node_modules` never opened, hidden files not writable, save re-pins only previously trusted plugins);
  `core-tools`/`core-mcp` settings and `web_fetch` input/output; install `sha256` + inspection `sourceRef`.
- Core fixes for Wave C (W4.6): tool-call history when `toolMode` is `off`/model lacks tools; `PluginHost.refresh(id)`
  after trust re-pin (stale `trust.hash`); `CredentialService.setFor(providerId, fields, values)` instead of drafts
  writing the secret layout directly; `PluginHost.onStateChange` instead of the core-mcp bridge; flaky
  `host.test.ts` fs.watch tests; body-limit streamed-multipart cancel → unhandled rejection (W4.1).

## Phase 5 — v1.1: stabilization, branching, data, share

Details, owned paths and acceptance criteria: `docs/phases/phase-5-v1-1.md`. Decisions: ADR-023 … ADR-027.

- [x] P5-0a Decisions, docs, contracts
  - [x] K1 DECISIONS (ADR-023 … ADR-027, contract seed), ROADMAP, AGENT.md (coordinator)
  - [x] K2 remove `vue-stream-markdown` + configs (Playwright `mobile` project, `test:live`, live Vitest config;
    `pnpm audit` flags live in CI, no workspace `audit` key) (coordinator)
  - [x] C7 contracts: shared DTOs, 11 new routes, `docs/API.md`, 501 stubs (chat JSON export writes v2)
  - [x] D5 docs: `phase-5-v1-1.md`, UI.md, ARCHITECTURE.md, PROVIDERS.md, README, `.env.example`
  - [x] Gate + checkpoint commit
- [x] P5-0b Schema, migration `0001`, skeletons, FREEZE
  - [x] K3 schema + `pnpm db:generate` + backfill SQL (coordinator)
  - [x] C8 server skeleton (types, stub services, keyring `share`, `X-Robots-Tag`, upgrade test)
  - [x] C9 web skeleton (share layout, stub pages/components, test ids, Data nav, `ui.openShare`)
  - [x] Gate (incl. v1 data upgrade probe) + FREEZE + checkpoint commit
- [x] P5-A Features + stabilization (9 agents)
  - [x] W5.1 branching-server · [x] W5.2 branching-web
  - [x] W5.3 data-server · [x] W5.5 data-web
  - [x] W5.4 shares-server · [x] W5.6 shares-web
  - [x] W5.7 security-proxy (`HF_TRUST_PROXY`, CSP test gating, share-token masking)
  - [x] W5.8 e2e-stabilization (resume, keyboard, settings, mobile, screenshots)
  - [x] W5.9 quality (live provider suite, CI audit + CSP step, Dependabot, phase-4 checklist)
  - [x] Gate + checkpoint commit
- [x] P5-B Feature e2e, docs, fix-ups, final gate
  - [x] W5.10 e2e-features (branching, data, share) · [x] W5.11 docs-final
  - [x] W5.13 web fix-ups (touch targets, sheet width, Mod+B case, Settings → Models test ids); W5.12 (server
    fix-ups) not needed: the P5-A gate was green
  - [x] Final gate (e2e ×3, screenshots, audit, v1 → v1.1 upgrade) + checkpoint commit; Docker re-run and the live
    provider suite are left to CI / the user (see the wave log)

## Phase 6 — v1.2: multimodal + stabilization

Details, owned paths and acceptance criteria: `docs/phases/phase-6-v1-2.md`. Decisions: ADR-028 … ADR-030 (and an
ADR-027 consequence).

- [x] P6-00 Hotfix (coordinator): shutdown handlers before boot (red CI on `main`), Dependabot cooldown and groups,
  `actionlint` CI job
- [x] P6-0a Decisions, docs, contracts
  - [x] K1 DECISIONS (ADR-028 … ADR-030, contract seed), ROADMAP, AGENT.md (coordinator)
  - [x] C10 contracts: shared DTOs + plugin SDK 1.1.0, 3 new routes (76), `docs/API.md`, 501 stubs
  - [x] D6 docs: `phase-6-v1-2.md`, UI.md, ARCHITECTURE.md, PROVIDERS.md, PLUGINS.md, README, `.env.example`
  - [x] Gate + checkpoint commit
- [x] P6-0b Schema, migration `0002`, skeletons, FREEZE
  - [x] K3 schema + `pnpm db:generate` + backfill SQL; K4 Playwright config (coordinator)
  - [x] C11 server skeleton (types, stub services, mock media models, headers, fakes, upgrade test)
  - [x] C12 web skeleton (Media settings page, stub components and composables, test ids, fake media)
  - [x] Gate (incl. v1.1 data upgrade probe) + FREEZE + checkpoint commit
- [x] P6-A Features (11 agents)
  - [x] W6.1 image-pipeline · [x] W6.2 model-runtime · [x] W6.3 provider-media · [x] W6.4 image-host
  - [x] W6.5 voice-server · [x] W6.6 chats-server
  - [x] W6.7 chat-surface-web · [x] W6.8 media-parts-web · [x] W6.9 composer-web · [x] W6.10 media-settings-web
  - [x] W6.11 app-web (shared fresh-auth composable, tablet touch targets)
  - [x] Gate + checkpoint commit (K5: CCR batch, migration `0003` marks cached model listings stale)
- [x] P6-B Feature e2e, docs, live media checks, fix-ups, final gate
  - [x] W6.12 e2e-features · [x] W6.13 docs-final · [x] W6.14 live-media (W6.15 / W6.16 fix-ups not needed)
  - [x] Final gate (e2e ×3, screenshots, audit, v1.1 → v1.2 upgrade) + checkpoint commit; the live provider suite
    (incl. `HF_LIVE_MEDIA=1`) is left to the user (paid, needs keys)

## Phase 7 — v1.3: agent workspace + stabilization

Details, owned paths and acceptance criteria: `docs/phases/phase-7-v1-3.md`. Decisions: ADR-031 … ADR-035 (and an
ADR-028 consequence). Plan: projects (folders inside `HF_WORKSPACE_ROOTS`), the builtin `core-workspace` tools (file
tools + a shell with approval), the Accept edits permission mode, master-key rotation, orphaned file cleanup.

- [x] P7-00 Stabilization start (coordinator): math rendering tests (`0cc670e`); Dependabot rebases replaced #2 by #5
  (ai-sdk group, 16 updates, `ai` 7.0.127) and #3 by #6 (minor-and-patch group, 8 updates), and moved #4 to katex
  0.19.0 (checked locally with the math tests before the merge); all three squash-merged on GitHub (`aac10a5`,
  `121db32`, `9341590`); two new build-tooling advisories (node-forge, braces; no patched release yet) ignored in
  `pnpm-workspace.yaml` `auditConfig`
- [x] P7-0a Decisions, docs, contracts
  - [x] K1 DECISIONS (ADR-031 … ADR-035, contract seed), ROADMAP, AGENT.md (coordinator)
  - [x] K2 dependencies (`diff`, `ignore`, `picomatch`), `key:rotate` script, Dockerfile `bash git`, compose (coordinator)
  - [x] C13 contracts: shared DTOs + plugin SDK 1.2.0, 9 new routes (85), `docs/API.md`, 501 stubs
  - [x] D7 docs: `phase-7-v1-3.md`, UI.md, ARCHITECTURE.md, PLUGINS.md, PROVIDERS.md, guides, README, `.env.example`
  - [x] Gate + checkpoint commit
- [x] P7-0b Schema, migration `0004`, skeletons, FREEZE
  - [x] K3 schema + `pnpm db:generate` (coordinator; v1.2 upgrade copy first)
  - [x] C14 server skeleton (types, env, deps, workspace path resolver, `core-workspace` skeleton, `mock:workspace`)
  - [x] C16 maintenance + keys skeleton (rotatable keyring, maintenance service, boot hooks, approvals helper)
  - [x] C15 web skeleton (test ids, Projects nav, stub components, projects store, chats store members)
  - [x] Gate (incl. v1.2 data upgrade probe) + FREEZE + checkpoint commit
- [x] P7-A Features (13 agents)
  - [x] W7.1 projects-server · [x] W7.2 workspace-files · [x] W7.3 workspace-shell · [x] W7.4 chat-pipeline
  - [x] W7.5 chats-server · [x] W7.6 tools-media-api · [x] W7.7 key-rotation · [x] W7.8 file-cleanup
  - [x] W7.9 projects-web · [x] W7.10 chat-surface-web · [x] W7.11 tool-ui-web · [x] W7.12 composer-web
  - [x] W7.13 data-settings-web
  - [x] Gate + checkpoint commit
- [x] P7-B Feature e2e, docs, fix-ups, final gate
  - [x] W7.14 e2e-features · [x] W7.15 docs-final (W7.16 / W7.17 fix-ups only if the P7-A gate is red)
  - [x] Final gate (e2e ×3, screenshots, audit, v1.2 → v1.3 upgrade) + checkpoint commit

## Phase 8 — v1.4: Workspace 2.0

Details, owned paths and acceptance criteria: `docs/phases/phase-8-v1-4.md`. Decisions: ADR-036 … ADR-039 (and
amendments of ADR-031, ADR-033, ADR-035). Plan: per-edit checkpoints and "Rewind files to here", a changes side panel
(This chat + Git views, reversible revert), a sticky shell working folder, shell rules (allowlist), an opt-in
automatic file sweep, backlog stabilization.

- [x] P8-00 Stabilization start (coordinator): design reports in `.tmp/p8-designs`, CI on `8879e6e` green, Phase 7
  bookkeeping (`1a95805`), audit advisories re-checked (both still unpatched: ignores kept), baseline 6995 tests
- [x] P8-0a Decisions, docs, contracts
  - [x] K1 DECISIONS (ADR-036 … ADR-039, contract seed), ROADMAP, AGENT.md (coordinator); K2 no new dependency
  - [x] C17 contracts: shared DTOs, 10 new routes (95), `docs/API.md`, 501 stubs
  - [x] C18 shell command parser (`packages/shared/src/util/shell-command.ts`)
  - [x] D8 phase doc `phase-8-v1-4.md` · [x] D9 docs: UI.md, ARCHITECTURE.md, PLUGINS.md, PROVIDERS.md, guides, README,
    `.env.example`
  - [x] Gate + checkpoint commit
- [x] P8-0b Schema, migration `0005`, skeletons, FREEZE
  - [x] K3 v1.3 upgrade copy + schema + `pnpm db:generate` (coordinator)
  - [x] C19 server skeleton · [x] C20 web skeleton · [x] C21 git runner + spawn guard
  - [x] Gate (incl. v1.3 data upgrade probe) + FREEZE + checkpoint commit
- [x] P8-A Features (11 agents)
  - [x] W8.1 checkpoint-store · [x] W8.2 restore-rewind · [x] W8.3 changes-list · [x] W8.4 shell-runtime
  - [x] W8.5 chat-pipeline · [x] W8.6 shell-rules · [x] W8.7 files-maintenance
  - [x] W8.8 changes-panel-web · [x] W8.9 rewind-web · [x] W8.10 tool-ui-web · [x] W8.11 settings-web
  - [x] Gate + checkpoint commit
- [x] P8-B Feature e2e, docs, fix-ups, final gate
  - [x] W8.12 e2e-features · [x] W8.13 docs-final (W8.14 / W8.15 fix-ups not needed: the P8-A gate was green)
  - [x] Final gate (e2e ×3, screenshots, audit, v1.3 → v1.4 upgrade, Docker git) + checkpoint commit

## Phase 9 — v1.5: Agent 2.0

Details, owned paths and acceptance criteria: `docs/phases/phase-9-v1-5.md`. Decisions: ADR-040 … ADR-043 (and
amendment notes on ADR-023, ADR-032, ADR-036, ADR-038). Plan: context compaction (`/compact`, automatic, also inside
long runs), plan mode + `todo_write` (plugin API 1.3.0, builtin `core-agent`), `@` file mentions and a steer queue,
sub-agents (`task`), stabilization (unique shell rules, migration `0006`).

- [x] P9-00 Stabilization start (coordinator): design reports in `.tmp/p9-designs`, CI on `316319a` green, audit
  advisories re-checked (both still unpatched: ignores kept), memory updated, baseline 8327 tests
- [x] P9-0a Decisions, docs, contracts
  - [x] K1 DECISIONS (ADR-040 … ADR-043, contract seed), ROADMAP, AGENT.md (coordinator); K2 no new dependency
  - [x] C22 contracts: shared DTOs + plugin SDK 1.3.0, 5 new routes (100), `docs/API.md`, 501 stubs
  - [x] C23 agent-state + mention helpers (`packages/shared/src/util/{agent-state,mentions}.ts`)
  - [x] D10 phase doc `phase-9-v1-5.md` · [x] D11 docs: UI.md, ARCHITECTURE.md, PLUGINS.md, PROVIDERS.md, guides, README
  - [x] Gate + checkpoint commit
- [x] P9-0b Schema, migration `0006`, skeletons, FREEZE
  - [x] K3 v1.4 upgrade seed (from a `316319a` worktree) + schema + `pnpm db:generate` (coordinator)
  - [x] C24 server skeleton · [x] C25 web skeleton · [x] C26 chat seams · [x] C27 `core-agent` skeleton + mock models
  - [x] Gate (incl. v1.4 data upgrade probe) + FREEZE + checkpoint commit
- [x] P9-A Features (12 agents)
  - [x] W9.1 compaction-server · [x] W9.2 steer-queue-server · [x] W9.3 plan-mode-server · [x] W9.4 todo-instructions-server
  - [x] W9.5 subagents-server · [x] W9.6 mentions-server · [x] W9.7 stabilization-server
  - [x] W9.8 composer-web · [x] W9.9 session-web · [x] W9.10 agent-tools-web · [x] W9.11 transcript-web
  - [x] W9.12 settings-stabilization-web
  - [x] Gate + checkpoint commit
- [x] P9-B Feature e2e, docs, fix-ups, final gate
  - [x] W9.13 e2e-features · [x] W9.14 docs-final (W9.15 / W9.16 fix-ups only if the P9-A gate is red)
  - [x] Final gate (e2e ×3, screenshots, audit, v1.4 → v1.5 upgrade, Docker) + checkpoint commit

## Phase 10 — v1.6: Agent customization

Details, owned paths and acceptance criteria: `docs/phases/phase-10-v1-6.md`. Decisions: ADR-044 … ADR-047 (and
amendment notes on ADR-024, ADR-036, ADR-041, ADR-042, ADR-043). Plan: custom sub-agent types, custom slash commands
and skills from markdown files (project `.harness/` over `.claude/`, personal ones in the database, plugin ones through
plugin API 1.4.0) on a new Settings → Customize page, background sub-agents, plan files saved to the project, a
Remember flow (`/remember`).

- [x] P10-00 Stabilization start (coordinator): design reports in `.tmp/p10-designs`, CI + Audit on `5481fb3` green, no
  open PRs, audit advisories re-checked (both still unpatched: ignores kept), baseline 9469 tests, `.tmp/v15` worktree
  built
- [x] P10-0a Decisions, docs, contracts
  - [x] K1 DECISIONS (ADR-044 … ADR-047, contract seed), ROADMAP, AGENT.md (coordinator); K2 dependency `yaml` 2
  - [x] C28 contracts: shared DTOs + plugin SDK 1.4.0, 9 new routes (109), `docs/API.md`, 501 stubs
  - [x] C29 definition helpers (`packages/shared/src/util/{definitions,arguments,tool-names}.ts`, `splitTaskResults`)
  - [x] D12 phase doc `phase-10-v1-6.md` · [x] D13 docs: UI.md, ARCHITECTURE.md, PLUGINS.md, PROVIDERS.md, guides, README
  - [x] Gate + checkpoint commit
- [x] P10-0b Schema, migration `0007`, skeletons, FREEZE
  - [x] K3 schema + `pnpm db:generate` (coordinator; the v1.5 upgrade seed from a `5481fb3` worktree was built in P10-0a by K3S)
  - [x] C30 server skeleton · [x] C31 chat seams · [x] C32 `core-agent` + mock models · [x] C33 web skeleton
  - [x] Gate (incl. v1.5 data upgrade probe) + FREEZE + checkpoint commit
- [x] P10-A Features (12 agents)
  - [x] W10.1 customizations-server · [x] W10.2 commands-server · [x] W10.3 agents-server · [x] W10.4 background-server
  - [x] W10.5 skills-plan-server · [x] W10.6 memory-data-server · [x] W10.7 plugin-api-server
  - [x] W10.8 customize-web · [x] W10.9 composer-web · [x] W10.10 session-dock-web · [x] W10.11 transcript-web
  - [x] W10.12 settings-plugins-web
  - [x] Gate + checkpoint commit
- [ ] P10-B Feature e2e, docs, fix-ups, final gate
  - [ ] W10.13 e2e-features · [ ] W10.14 docs-final (W10.15 / W10.16 fix-ups only if the P10-A gate is red)
  - [ ] Final gate (e2e ×3, screenshots, audit, v1.5 → v1.6 upgrade, Docker) + checkpoint commit

## Backlog (not in v1.6)

Multi-user accounts · child-process isolation for code plugins · plugin marketplace/registry index ·
knowledge/RAG · desktop/CLI clients · audio attachments to chat models · declarative image and voice providers ·
provider-native image tools (e.g. the OpenAI Responses image tool) · on-device speech synthesis · video generation ·
verify Alt+V dictation on Firefox / Windows (Alt+J is the documented fallback) · run the live provider suite with
`HF_LIVE_MEDIA=1` and record the results (PROVIDERS.md 11) · OS-level sandboxing of the shell · the shell on Windows ·
syntax highlighting in diffs · stage / commit from the changes panel · a terminal pane · a persistent shell process
(environment variables that stick) · restoring shell changes (whole-tree snapshots) · remove the two ignored audit
advisories (GHSA-86w9-cpqp-85rv node-forge, GHSA-vfj7-8cjw-p6xm braces) once patched releases ship (re-checked
2026-10-04: still unpatched) · move the `.gitignore` ReDoS heuristic of the workspace walker (`find_files`,
`search_files`, the `@` file index) off the main thread · a steer queue that survives a server restart · nested
sub-agents · micro-compaction of
single large tool outputs · retry a provider context overflow after compaction · `@` mentions of symbols and URLs ·
run the live provider suite for compaction, plan mode and sub-agents with real models · user-defined shell hooks ·
project `.mcp.json` servers · output styles · `!bash` and `@file` inside command files · user-invocable skills (`/skill`)
· editing project definition files in the UI · importing definitions from the home folder (`~/.claude`) · background
tasks that survive a server restart · a sidebar activity dot for background agents · run the live provider suite for
custom agents, skills and background agents with real models.

## Wave log

| Wave | Agents | Gate result | Commit |
|---|---|---|---|
| P0.1–P0.2 | coordinator | n/a | — |
| P0.3 D+S | D1, D2, D3, D4, S0 + R1 (reconcile) | check + build green on skeleton | 9e31ac5 |
| P0.4 C-a | C1+C2, C3 | audit ok; 205 tests; check + build green; dark 200.html verified | d688e62 |
| P0.5 C-b | C4, C5, C6 | audit ok; 834 tests; check + build green; 501 stubs verified; pins ok | 8e06bac |
| Wave A | W1.1–W1.5, W2.2–W2.5 | audit ok; 2064 tests; build ok; providers/keys/persistence/auth/SSE/icons probes ok | 6d2ba77 |
| Wave B | W2.1, W3.1–W3.5 | audit ok; 3108/3109 tests (known flaky fs.watch test passes alone); build ok; chat stream, approval, commands, tools, plugins, scaffold probes ok | d9dedb0 |
| Wave C | W2.6, W3.6, W4.1–W4.4, W4.6 | audit ok; 3530 tests; frozen install ok; build ok; e2e 27/27 (core 15 + plugins 12) | f142fcc |
| Final gate | coordinator | e2e 27/27 ×3; `pnpm start` from empty data dir ok (secret.key 0600); Docker image (Node 24, non-root) smoke ok | 6e3b442 |
| P5-0a | coordinator (K1, K2), C7, D5 | audit ok; 3623 tests; build ok; built-page CSP test 38/38; 11 new routes mounted (501 / 400 body validation); e2e 27/27; `vue-stream-markdown` gone, TypeScript 6.0.3 only | 0b56f45 |
| P5-0b | coordinator (K3, K4), C8, C9 | audit ok; 3676 tests; build ok; CSP 38/38; e2e 27/27; v1 data upgrade probe ok (12/12 messages, parent chain + active leaves correct); `.gitignore` `data/` → `/data/` (source folders named `data` were ignored); FREEZE | c4207b5 |
| P5-A | W5.1–W5.9 | audit ok (147 paths); 4202 tests; build ok; CSP 38/38 with `HF_TEST_REQUIRE_WEB_BUILD=1`; probes ok (branch switch + 409 run-active, export v2 round trip, backup without secrets + import/skip on a fresh server, anonymous share view + revoke 404 + masked token logs, trusted-proxy limiter buckets + `X-Forwarded-Host` 403); e2e 41 passed (chromium + mobile) + 4 screenshot tests (96 PNGs reviewed); `pnpm audit --prod` clean | 69f1676 |
| P5-B | W5.10, W5.11, W5.13 (+ coordinator: Mod+Shift+B left to the browser, 413 `limitEntries`, DECISIONS wording) | audit ok (40 paths); 4211 tests; build ok; CSP 38/38; all P5-A probes again green; e2e 44 passed ×3 (chromium + mobile; 48 tests in 25 files); screenshots of versions, Share dialog, share page reviewed; `pnpm audit --prod` clean; real v1 → v1.1 upgrade (v1 built from `4c461a0` in a worktree, 2 chats seeded, then v1.1 on the same data: parent chains + leaves correct, branching probe 11/11, old chat continues) | 0a6fa4e |
| Final gate v1.1 | coordinator | frozen install ok; check 4211 tests; build ok; CSP 38/38; probes green; e2e 44/44 ×3; audit clean; v1 → v1.1 upgrade ok. Docker not re-run locally (daemon off; the CI `docker` job builds the image); live provider suite not run (needs the user's keys) | (this commit) |
| P6-00 | coordinator (hotfix) | `pnpm check` 4212 tests; `main.test.ts` 3× green (the new SIGTERM-during-boot test fails on the old `main.ts`); `actionlint` 1.7.12 exit 0 | a5fd107 |
| P6-0a | coordinator (K1), C10, D6 | audit ok (67 paths; 7 compile-fix files accepted); 4256 tests; build ok; CSP 38/38; 3 new routes mounted (501); e2e 44 passed; CI on `a5fd107` green; Dependabot now opens separate katex / ai-sdk / minor PRs (#2-#4, green) | (this commit) |
| P6-0b | coordinator (K3, K4), C11, C12 | audit ok (75 paths; 4 test/fake files accepted); 4374 tests; build ok; CSP 38/38 incl. `media-src 'self' blob:`; `Permissions-Policy: microphone=(self)`; e2e 44 passed (new fake-media Playwright config, empty `tablet` project); upgrade probe on a seeded v1.1 copy: `0002` applied, remembered pointers only on the active path (A → RA → B → RB), 0 invalid, `GET /chats/:id` unchanged, 24 chats; FREEZE | (this commit) |
| P6-A | W6.1 – W6.11 (+ coordinator K5: 3 stale skeleton tests, 2 frozen doc comments, plugins-list e2e 3 tools, builtin `engines ^1.1.0`, migration `0003`) | audit ok (199 paths, no frozen file touched); 5060 tests; build ok; CSP 38/38; probes 21/21 (image turn 2 stored files + metadata, image-output chat, `generate_image` tool, no `data:` URL saved, transcription + 400 / 413, speech WAV no-store + 400, headers, remembered path, delete version 200 / `only-version` / `run-active`, `chat.updated.activeLeafId`, no transcript in logs); e2e 44 passed; screenshots reviewed (versions trash icon, mic, Image models group, Media nav); `pnpm audit --prod` clean | (this commit) |
| P6-B | W6.12, W6.13, W6.14 (+ coordinator: migration `0003` now ages listings by one TTL instead of clearing them (W6.13 found that null hid cached listings), stale classification comments + the plugin-sdk `seedModels` doc, PROVIDERS.md 12 media subsection, `live.yml` `media` input, the expanded sidebar trigger's 40 px touch target (W6.12 found it)) | audit ok (39 paths); e2e 61 run tests + 4 screenshot tests; new specs 17/17 ×3; docs reconciled; live media unit tests 52 | (final gate commit) |
| Final gate v1.2 | coordinator | frozen install ok; 5091 tests; build ok; CSP 38/38; probes 21/21; e2e 61 passed ×3 (chromium + mobile + tablet); 5 new screens reviewed; `pnpm audit --prod` clean; real v1.1 → v1.2 upgrade 9/9 (v1.1 from `30da884` in a worktree). Live provider suite not run (needs the user's keys) | (this commit) |
| P7-00 | coordinator | math tests (unit + e2e) green on katex 0.16 and on the PR #4 build (katex 0.19); Dependabot #5 (replaces #2), #6 (replaces #3), #4 squash-merged on GitHub after green check / e2e / docker (audit red only from two new build-tooling advisories, ignored locally) | `aac10a5`, `121db32`, `9341590`, `0cc670e` |
| P7-0a | coordinator (K1, K2), C13, D7 | audit ok (78 paths; 15 C13 compile-fix files accepted); frozen install ok; 5195 tests; build ok; CSP 38/38; 9 new routes mounted (501, 400 on invalid input; `pluginApiVersion` 1.2.0); e2e 62 passed (61 + math); Docker image builds with bash 5.3 + git 2.54 (uid 1000); `pnpm audit --prod` clean with the two ignored advisories | (this commit) |
| P7-0b | coordinator (K3), C14, C15, C16 (+ coordinator: C14 test fixes for the new builtin plugin and mock model accepted) | audit ok (135 paths); `0004_projects` = CREATE TABLE + 2 indexes + ALTER ADD (no rebuild); 5424 tests; build ok; CSP 38/38; e2e 62 passed (fresh `.tmp/e2e`: `workspaces/` 0700 created); upgrade probe on a v1.2 copy (seeded on the real v1.2 dist) 15/15: 5 migrations, `_keys` written (version 1), secrets readable, branched path + attachment + pending approval + share intact, `projectId` null; FREEZE | (this commit) |
| P7-A | W7.1 – W7.13 (+ coordinator: CCR comments in `providers/types.ts`, `chats/types.ts`, `files/types.ts`; `fakes.test.ts` + `deps.test.ts` updates; W7.10 follow-up for the approval context; `modelName` stays optional — tests cover the fallback; the legacy fake files service reuse path deferred) | audit ok (218 paths, no frozen file touched); 6995 tests; build ok; CSP 38/38; e2e 62 passed on a fresh `.tmp/e2e`; probes 47/47 (projects CRUD + browse limits + data-dir refusal, `mock:workspace` in auto / edits / ask, no project → no tools, `HF_WORKSPACE_SHELL=0`, missing folder → `workspace-unavailable`, delete detaches chats and keeps the folder, `modelName`, unknown provider 400, keys: 401 / rotate 200 with one cookie / old cookie 401 / old share 404 + new 200 / approval expired / key_version 2 / `.next` recovery / `server.lock` / env-mode 409 + CLI exit 2 then 0 + keyCheck ok / mismatch, cleanup recent → removable → removed); screenshots of the new screens reviewed (desktop + phone); `pnpm audit --prod` clean (2 ignored) | (this commit) |
| P7-B | W7.14, W7.15 (+ coordinator: DECISIONS corrections from W7.15; the approval checkbox hit area 40 px on coarse pointers (found by W7.14, `pointer-coarse:after:-inset-[13px]`: the hit area is inset from the 14 px padding box); a `FolderCodeIcon` glyph for the builtin Workspace tools plugin card; README screenshots) | audit ok (25 paths); new specs (projects 5, workspace tools 4, data maintenance 2, mobile 2, tablet +2) green 3× on 8891; docs reconciled (API, ARCHITECTURE, UI, PLUGINS, PROVIDERS, guides, README "v1.3") | (final gate commit) |
| Final gate v1.3 | coordinator | frozen install ok; 6995 tests; build ok; CSP 38/38; probes 47/47; e2e 77 passed ×3 (chromium + mobile + tablet); `@screenshots` dark + light reviewed (86 per theme), README images refreshed + a workspace image; `pnpm audit --prod` clean (2 ignored build-tooling advisories); real v1.2 → v1.3 upgrade (v1.2 built from `b5bb2ec` in a worktree, seeded with password, provider key, MCP header secret, branched chat, attachment, orphan upload, generated image, pending approval, share): 15/15 + 11 extra (rotation on upgraded data re-encrypts every secret, the v1.2 pending approval expires, cleanup removes only the orphan); Docker image (Node 24, bash 5.3, git 2.54): boot with `server.lock` + `workspaces/`, offline `rotate-key` in a second container exit 0, restart with the new key `keyVersion` 2 `keyCheck` ok. Live provider suite not run (needs the user's keys) | (this commit) |
| P8-00 | coordinator | CI on `8879e6e` green; Phase 7 ROADMAP boxes ticked; advisories still unpatched (ignores kept); `pnpm check` 6995 tests | `1a95805` |
| P8-0a | coordinator (K1; K3 seeding done early), C17, C18, D8, D9 (+ coordinator: AGENT.md `allowRules`, phase-doc seed paths, C20-T8 helpers, `shell-rules.ts` comment; C18 follow-up: `&>` asks) | audit ok (55 paths; 10 C17 compile-fix files accepted); frozen install ok; 7514 tests; build ok; CSP 38/38; 10 new routes answer 501 / 400; e2e 77 passed on a fresh `.tmp/e2e`; TypeScript 6.0.3 only | (this commit) |
| P8-0b | coordinator (K3: schema + `0005_workspace_checkpoints`, v1.3 seed from a `1a95805` worktree), C19, C20, C21 (+ coordinator: phase-doc deviations from C20 (UI.md 10.5 / 11.5 won), the rewind contract (RewindDialog calls the API itself), P8-A ownership additions; C21's `trackGroup` CCR declined: git keeps its own live-group set) | audit ok (117 paths; 3 C19 test fixes + the page test accepted); `0005` = 2 CREATE TABLE + 5 CREATE INDEX; 7722 tests; build ok; CSP 38/38; e2e 77 passed on a fresh `.tmp/e2e`; upgrade probe on a v1.3 copy 19/19 (6 migrations, empty new tables, no FK violations, `_files.lastCleanup` kept, secrets / MCP header / share / pending approval / project + old tool parts intact, `fileSweep` off, orphan kept); FREEZE | (this commit) |
| P8-A | W8.1 – W8.11 (+ coordinator: `deps.test.ts` phase 8 tests rewritten for the implemented members, `core-workspace/index.test.ts` `shell: shellPolicy`; follow-ups: W8.10 `currentShellCwd` aligned with the server's skip rule) | audit ok (152 paths, no frozen file touched); 8327 tests; build ok; CSP 38/38; probes 57/57 (`.tmp/gates/P8-A/probe.mjs`: checkpoints + journal rows + 0700 store, changes list, rewind preview / apply / idempotent / undo / conflict skip + force, 400 non-user message, chat revert + stale 409 + undo, run-active 409 from another chat of the project, sticky cwd + clamp + no env persistence, rules 201 / 409 / refused 400 / allowed in ask / compound, substitution and redirection ask / project scoping / `override: allow` 400, git modified + untracked + revert / undo both, not-a-repo without discovering the repository above, malicious repository config fires nothing, git missing, automatic sweep (orphan removed, plugin-data id kept, checkpoint blob untouched, status + next run, no ids outside the access log, test variable ignored without the mock flag), upgrade (old project chat: no changes, nothing to rewind, Git view works, sweep off)); e2e 77 passed on a fresh `.tmp/e2e`; screenshots of the panel (pane, diff, Git, revert confirm), rewind dialog, shell approval rule, Settings → Projects rules, Data automatic cleanup, mobile sheet reviewed; `pnpm audit --prod` clean (2 ignored) | (this commit) |
| P8-B | W8.12, W8.13 (+ coordinator: the raw arguments under the write / edit approval preview (a P8-A regression found by W8.13), the resize handle's arrow keys (found by W8.12: reka looks the handle up once at setup; the handle now mounts disabled and is enabled on the next tick), "Git view" wording, 40 px coarse-pointer cleanup controls, shared schema comments, ADR-036 … ADR-039 / AGENT.md wording, PROVIDERS.md `mock:shell` empty output) | audit ok (34 paths); new specs (changes panel, rewind, shell rules, mobile changes) + extensions 3× green on 8891; docs reconciled; README "v1.4" | (final gate commit) |
| Final gate v1.4 | coordinator | frozen install ok; 8327 tests; repository `git status` unchanged by `pnpm check`; build ok; CSP 38/38; probes 57/57 (incl. the real v1.3 → v1.4 upgrade of a seed made by the v1.3 build); e2e 96 passed ×3 (chromium + mobile + tablet); `@screenshots` dark + light reviewed (15 new Phase 8 screens per theme); `pnpm audit --prod` clean (2 ignored, still unpatched); Docker image (Node 24, git 2.54, bash 5.3): Git view, This chat, rewind and checkpoints/ 0700 in the container, a repository owned by another uid answers refused (8/8) | (this commit) |
| P9-00 | coordinator | CI + Audit on `316319a` green; advisories still unpatched (ignores kept); `pnpm check` 8327 tests; design reports in `.tmp/p9-designs` | — |
| P9-0a | coordinator (K1; K3 seed done early), C22, C23, D10, D11 (+ coordinator: the example plugins' `harness-forge.d.ts` regenerated for API 1.3.0, phase-doc reconciliation with D11 (`activity`, `chatQueue.add`, PROVIDERS.md 8, `mock:todo` 400 ms + `invalid`), C27 also owns `SH/ids*` for `core-agent`) | audit ok (69 paths; 16 C22 compile-fix files accepted); frozen install ok; 8528 tests; build ok; CSP 38/38; `pluginApiVersion` 1.3.0, 5 new routes answer 501 / 400; e2e 96 passed on a fresh `.tmp/e2e`; TypeScript 6.0.3 only | (this commit) |
| P9-0b | coordinator (K3: schema + `0006_shell_rule_unique`, v1.4 seed from a `316319a` worktree), C24, C25, C26, C27 (+ coordinator: `declarativeCommandSchema` refuses `/compact` (C27 CCR), ownership additions for P9-A) | audit ok (162 paths; 11 test-fix files accepted); `0006` = 1 DELETE + 1 UPDATE + 2 partial `CREATE UNIQUE INDEX`; 8974 tests; build ok; CSP 38/38; e2e 96 passed on a fresh `.tmp/e2e`; upgrade probe on a v1.4 copy 31/31 (7 migrations, duplicates removed keeping the oldest, shell `allow` cleared, `current_time` kept, data intact, `core-agent` active, new settings defaulted); seam probe 7/7 (`mock:workspace` in auto writes + journals, `plan` accepted and asks, `/compact` listed, 5 agent mocks listed); FREEZE | (this commit) |
| P9-A | W9.1 – W9.12 (+ coordinator: `truncated` covers matches beyond the limit, share snapshots leave out `/compact` exchanges, the `core-agent` stub test and the `deps` project-files pins updated; relays: `agentTools` + the pre-mode tool set for history (W9.1), the lowered child mode (W9.5), `isPlanExitTool` (W9.7)) | audit ok (175 paths, no frozen file touched); 9467 tests; build ok; CSP 38/38; probes 71/71 (`.tmp/gates/P9-A/probe.mjs`: manual + automatic + in-run compaction, branch above the marker, failure fallback, export / share; plan tool set, card, approve with Accept edits writes + journals, keep planning with feedback, 400s; todos incl. invalid list and the compaction snapshot; steer between steps, server-started next turn, cancel, Stop `dropped`, `run-idle`; parallel sub-agents without approvals, preliminary outputs, journal `<parent>/<child>`, cap, Stop, step limit; mentions ranking, ignores, attach guards, 413; unique rules race; v1.4 upgrade compaction); P8-A regression 47/47; e2e 96 passed on a fresh `.tmp/e2e`; 22 screenshots of the new screens reviewed (desktop + phone); `pnpm audit --prod` clean (2 ignored) | (this commit) |
| P9-B | W9.13, W9.14 (+ coordinator: Shift+Tab listed in the shortcuts dialog, same-tick announcements joined (a `/compact` reply is announced), `exit_plan_mode` effective override always null, DECISIONS wording; both e2e `fixme`s enabled) | audit ok (35 paths); 30 new e2e tests (chromium +23, mobile +5, tablet +2), 126 passed ×3 on 8891; docs reconciled; README "v1.5" | (final gate commit) |
| Final gate v1.5 | coordinator | frozen install ok; 9469 tests (Phase 5 flaky share-token test fixed); repository `git status` unchanged by `pnpm check`; build ok; CSP 38/38; probes 71/71 + full P8-A probes 57/57; e2e 128 passed ×3 (chromium + mobile + tablet); `@screenshots` dark + light reviewed, README images from full-frame `@readme` shots; `pnpm audit --prod` clean (2 ignored, still unpatched); real v1.4 → v1.5 upgrade (fresh seed by the `316319a` build) 31/31; Docker (Node 24, uid 1000) on that seed 10/10 | (this commit) |
| P10-0a | coordinator (K1, K2; contract skeletons of `SH/util/{definitions,arguments,tool-names}.ts` + agent-name ids), C28, C29, D12, D13, K3S (v1.5 seed, built early) (+ coordinator: D12 open points confirmed, point 10 changed (task results are separate user messages, like steers), C28 CCRs accepted (`customizations.source` `path` query, `runOriginSchema` in `enums.ts`), 33 C28 compile-fix files accepted) | audit ok (104 paths); frozen install ok (`yaml` 2.9.1 only, TypeScript 6.0.3 only); 9790 tests; build ok (web +10 KB gz vs v1.5); CSP 38/38; `pluginApiVersion` 1.4.0, 9 new routes answer 501 / 400; e2e 128 passed on a fresh `.tmp/e2e`; `pnpm audit --prod` clean (2 ignored) | (this commit) |
| P10-0b | coordinator (K3: schema + `0007_customizations`), C30, C31, C32, C33 (+ coordinator: 11 test-fix files of C30 / C32 / C33 accepted; deviations recorded: `ChatRunner.boot()` boot sweep, `takeResults(chatId, messageId)`, customization backup members, the instruction-block shape the mocks read) | audit ok (170 paths); `0007` = 2 CREATE TABLE + 3 indexes, a second generate: no changes; 9999 tests; build ok; CSP 38/38; seam probe 16/16; upgrade probe on a v1.5 copy 42/42 (8 migrations, empty new tables, counts unchanged, old task parts byte-identical, 3 approvals pending, `skill` listed, new settings defaulted); e2e 128 passed on a fresh `.tmp/e2e`; `pnpm audit --prod` clean (2 ignored); FREEZE | (this commit) |
| P10-A | W10.1 – W10.12, G10P (gate probes) (+ coordinator: CCR `taskAgent.pluginId` applied; follow-ups: one announcement per finished background agent (W10.10), `background_tasks.output` scanned (W10.6); test pins in `deps.test.ts`, `pipeline.test.ts`, `workspace.test.ts`; the import result panel line for restored definitions; e2e pins for `/remember` and the Agent section copy) | audit ok (189 paths, no frozen file touched beyond the accepted CCR); 10561 tests; build ok (`yaml` external in `dist/main.mjs`); CSP 38/38; probes 173/173 (`.tmp/gates/P10-A/probe.mjs`: catalog, agents, commands, skills, background, plan files, Remember, plugin API, hygiene, v1.5 upgrade) + P9-A 71/71 + P8-A 47/47; e2e 128 passed on a fresh `.tmp/e2e`; screenshots of the Customize page, editor, slash groups, argument hint, Remember (desktop + phone) reviewed; `pnpm audit --prod` clean (2 ignored) | (this commit) |
