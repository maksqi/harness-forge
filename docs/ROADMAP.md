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

## Backlog (not in v1)

Multi-user accounts · child-process isolation for code plugins · plugin marketplace/registry index ·
conversation branching · sharing links · knowledge/RAG · image generation · voice · desktop/CLI clients.

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
