# Roadmap

Single source of truth for progress. Edited only by the coordinator; agents suggest updates in their reports.
Task details, owned paths and acceptance criteria live in `docs/phases/phase-N-*.md`.

Legend: `[x]` done · `[~]` in progress · `[ ]` not started.

## Phase 0 — Reset, docs, scaffold, contracts

- [x] P0.1 Reset: branch `harness-forge`, back up untracked files outside the repository, wipe repo
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
- [ ] P0.5 Wave C-b
  - [ ] C4 server skeleton (env, app factory, 501 route stubs, Drizzle schema + migration, interfaces, test harness)
  - [ ] C5 web skeleton (stub pages, Pinia stores, `$api`, SSE client, shortcuts registry, test ids)
  - [ ] C6 `core-providers` (13 providers) + `core-commands`
  - [ ] FREEZE + gate + checkpoint commit

## Phase 1 — Core services

- [ ] W1.1 server-core (middleware, auth, password, session, headers, bind safety, SPA serving)
- [ ] W1.2 secrets-settings (keyring, AES-256-GCM secrets, settings, provider credentials)
- [ ] W1.3 plugin-host (loader, registry, lifecycle, guard, declarative adapter, compile, hot reload, plugins API)
- [ ] W1.4 providers-catalog (model resolution, provider test, listings + cache + models.dev, prefs, icons, mock)
- [ ] W1.5 chats-events-files (chat CRUD/search/export, messages, SSE events, file uploads)
- [ ] Gate + checkpoint commit

## Phase 2 — Chat MVP + settings

- [ ] W2.1 chat-server (pipeline, runs, approvals, commands, titles, usage/cost, errors)
- [ ] W2.2 chat-web (useChatSession, transcript, part renderers, Markdown, empty state)
- [ ] W2.3 composer-web (composer, attachments, model picker, effort, permission, slash menu)
- [ ] W2.4 sidebar-web (chat list, status dots, palette, shortcuts dialog, global shortcuts)
- [ ] W2.5 settings-web (providers & keys, models, general, appearance, about, login)
- [ ] W2.6 e2e-core (smoke specs)
- [ ] Gate + checkpoint commit

## Phase 3 — Plugins, tools, MCP

- [ ] W3.1 plugins-web (list, detail, settings form, enable/disable/reload/uninstall/export)
- [ ] W3.2 plugin-install (staging, zip/npm/url/folder, inspect, trust)
- [ ] W3.3 provider-wizard (declarative provider plugin wizard + test)
- [ ] W3.4 code-plugins (scaffold templates, file API, CodeMirror editor, build & reload)
- [ ] W3.5 tools-mcp (MCP manager, tool prefs, core-tools, MCP panel)
- [ ] W3.6 e2e-plugins
- [ ] Gate + checkpoint commit

## Phase 4 — Hardening and release

- [ ] W4.1 security audit + fixes
- [ ] W4.2 UX polish (Claude Code parity, mobile, a11y, states, perf)
- [ ] W4.3 packaging (tsdown build, start, Docker, CI)
- [ ] W4.4 docs + example plugins
- [ ] W4.5 full e2e (3 green runs, screenshots)
- [ ] Final gate + checkpoint commit

## Backlog (not in v1)

Multi-user accounts · child-process isolation for code plugins · plugin marketplace/registry index ·
conversation branching · sharing links · knowledge/RAG · image generation · voice · desktop/CLI clients.

## Wave log

| Wave | Agents | Gate result | Commit |
|---|---|---|---|
| P0.1–P0.2 | coordinator | n/a | — |
| P0.3 D+S | D1, D2, D3, D4, S0 + R1 (reconcile) | check + build green on skeleton | 34a0940 |
| P0.4 C-a | C1+C2, C3 | audit ok; 205 tests; check + build green; dark 200.html verified | (this commit) |
