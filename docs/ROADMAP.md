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
- [ ] P7-0b Schema, migration `0004`, skeletons, FREEZE
  - [ ] K3 schema + `pnpm db:generate` (coordinator; v1.2 upgrade copy first)
  - [ ] C14 server skeleton (types, env, deps, workspace path resolver, `core-workspace` skeleton, `mock:workspace`)
  - [ ] C16 maintenance + keys skeleton (rotatable keyring, maintenance service, boot hooks, approvals helper)
  - [ ] C15 web skeleton (test ids, Projects nav, stub components, projects store, chats store members)
  - [ ] Gate (incl. v1.2 data upgrade probe) + FREEZE + checkpoint commit
- [ ] P7-A Features (13 agents)
  - [ ] W7.1 projects-server · [ ] W7.2 workspace-files · [ ] W7.3 workspace-shell · [ ] W7.4 chat-pipeline
  - [ ] W7.5 chats-server · [ ] W7.6 tools-media-api · [ ] W7.7 key-rotation · [ ] W7.8 file-cleanup
  - [ ] W7.9 projects-web · [ ] W7.10 chat-surface-web · [ ] W7.11 tool-ui-web · [ ] W7.12 composer-web
  - [ ] W7.13 data-settings-web
  - [ ] Gate + checkpoint commit
- [ ] P7-B Feature e2e, docs, fix-ups, final gate
  - [ ] W7.14 e2e-features · [ ] W7.15 docs-final (W7.16 / W7.17 fix-ups only if the P7-A gate is red)
  - [ ] Final gate (e2e ×3, screenshots, audit, v1.2 → v1.3 upgrade) + checkpoint commit

## Backlog (not in v1.3)

Multi-user accounts · child-process isolation for code plugins · plugin marketplace/registry index ·
knowledge/RAG · desktop/CLI clients · audio attachments to chat models · declarative image and voice providers ·
provider-native image tools (e.g. the OpenAI Responses image tool) · on-device speech synthesis · video generation ·
verify Alt+V dictation on Firefox / Windows (Alt+J is the documented fallback) · run the live provider suite with
`HF_LIVE_MEDIA=1` and record the results (PROVIDERS.md 11) · Phase 7 follow-ups: checkpoints / undo of workspace
edits · a changes side panel (git status and diffs) · a command allowlist for the shell · OS-level sandboxing of the
shell · an automatic file sweep · a persistent shell session (`cd` that sticks) · remove the two ignored audit
advisories (GHSA-86w9-cpqp-85rv node-forge, GHSA-vfj7-8cjw-p6xm braces) once patched releases ship.

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
