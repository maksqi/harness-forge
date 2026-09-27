# Phase 0 — Foundation: reset, docs, scaffold, contracts

Part of the harness-forge build plan. Progress is tracked in `docs/ROADMAP.md` (coordinator only). Shared names come
from `docs/DECISIONS.md` (contract seed); if this file disagrees with DECISIONS.md, DECISIONS.md wins.

## Goal

Turn the empty `harness-forge` branch into a pnpm monorepo skeleton with **frozen contracts**: shared DTOs and route
table (`packages/shared`), plugin SDK (`packages/plugin-sdk`), Drizzle schema + migration 0000, server route stubs
and service interfaces, web layouts + store signatures, and design tokens. After Phase 0 every later agent can work
in parallel on single-owner paths without editing shared files.

## Entry criteria

- Branch `harness-forge` created from `main`; the approved plan exists.
- Nothing else (the repository is empty except `.git`).

## Exit criteria

- Every Phase 0 item in `docs/ROADMAP.md` is checked; the FREEZE list (below) is in force; checkpoint commit made.
- `pnpm install --frozen-lockfile && pnpm check && pnpm build` is green on the skeleton.
- `pnpm start:e2e` boots: `GET /api/health` returns 200; every other endpoint of `docs/API.md` returns **501** with
  the `HarnessError` envelope code `not_implemented`.
- Version pins hold: `pnpm why typescript` shows only `6.0.x`; `pnpm why vue-stream-markdown` shows only `1.x`.
- `pnpm dev` (coordinator) shows the dark app shell (sidebar with `Chat | Plugins`, theme toggle) while the OS prefers
  light.

## Steps

| Step | Owner | Status | Output |
|---|---|---|---|
| P0.1 Reset | coordinator | done | branch, backup, empty tree |
| P0.2 Core docs | coordinator | done | `AGENT.md`, `CLAUDE.md`, `docs/ROADMAP.md`, `docs/DECISIONS.md` |
| P0.3 Wave D + S | D1, D2, D3, D4, S0 | in progress | reference docs, phase docs, README, LICENSE, monorepo scaffold |
| Gate D+S | coordinator | — | docs consistency, `pnpm check && pnpm build`, commit |
| P0.4 Wave C-a | C1+C2, C3 | — | `packages/shared` + `packages/plugin-sdk` (one agent), web shell visuals |
| P0.5 Wave C-b | C4, C5, C6 | — | server skeleton, web skeleton, `core-providers` + `core-commands` |
| FREEZE + gate | coordinator | — | freeze contracts, gate, commit |

## Rules for every Phase 0 agent

- Read `AGENT.md` fully, then the docs named in your section. Stay inside your OWNED paths.
- Sub-agents never run pnpm/npm/npx, CLIs, git writes or servers on :3000/:8787. **Exception: S0** (see below).
- A glob in an ownership block never overrides the FREEZE list once it is in force (after P0.5).
- Report in the `AGENT.md` format (≤300 words), including CCRs and dependency requests.

---

## P0.1 Reset (done)

1. `git switch -c harness-forge` (from `main`; `main` is never touched, nothing is ever pushed).
2. Move the untracked files of the previous app (`.env`, `chat.db`, `.idea`, `.DS_Store`) to a backup folder outside the repository.
3. `git rm -r` every tracked file of the old Flask app (they stay in git history); verified that only `.git` remained.

## P0.2 Core docs (done)

`AGENT.md` (rules, stack, version facts, commands, conventions, freeze, CCR, report format), `CLAUDE.md`
(`@AGENT.md`), `docs/ROADMAP.md` (task checklist + wave log), `docs/DECISIONS.md` (ADR-001..016 + contract seed).

---

## P0.3 Wave D + S (parallel)

Five agents in one launch. Docs agents read the plan appendices named below; S0 builds the empty monorepo.

### D1 docs-architecture-api

- **Mission.** Write the system reference: components, flows, storage, security model, and every HTTP endpoint.
- **Owned.** `docs/ARCHITECTURE.md`, `docs/API.md`.
- **Read-only highlights.** `docs/DECISIONS.md`, plan Appendices B (API + DB) and C (chat pipeline).
- **Tasks.**
  1. **D1-T1 ARCHITECTURE.md** — process topology (dev: :3000 + :8787; prod: one process on :8787), server layers
     (`http/`, `security/`, `db/`, `services/`, `registry/`, `plugins/`, `catalog/`, `providers/`, `chat/`, `mcp/`,
     `builtin-plugins/`), composition root (how `app.ts` builds services), chat flow, plugin load flow, data dir,
     all 14 tables with columns, security model, production topology.
     *Accept:* every table in DECISIONS "Database tables" has a column list; every env var appears once.
  2. **D1-T2 API.md** — error envelope (codes, default HTTP status per code, `action`), auth rules (public
     endpoints), every endpoint (method, path, route module, request, response, errors), SSE event catalog, chat
     request + UI message stream protocol + resume + stop, the 501 stub envelope used in Phase 0.
     *Accept:* the endpoint list equals the DECISIONS route-module table 1:1 (same method, path, module).

### D2 docs-plugins-providers

- **Mission.** Write the plugin author reference and the provider reference.
- **Owned.** `docs/PLUGINS.md`, `docs/PROVIDERS.md`.
- **Read-only highlights.** `docs/DECISIONS.md`, plan Appendices A (plugin contract) and E (providers).
- **Tasks.**
  1. **D2-T1 PLUGINS.md** — manifest, kinds, contribution points, `PluginContext`, hooks, settings schema, lifecycle
     states, load order, validation, guard timeouts, safe mode, hot reload, install sources + guards, trust, one
     declarative and one code example, builtin template commands of `core-commands`.
     *Accept:* every field of Appendix A is documented; examples validate against the manifest rules.
  2. **D2-T2 PROVIDERS.md** — the 13 builtin providers + dev-only `mock` (id, UI name, package, base URL, icons,
     env var fallback, key URL, seed models, reasoning mapping), declarative provider format, mock models.
     *Accept:* ids equal DECISIONS "Builtin provider ids"; one env var per keyed provider.

### D3 docs-ui

- **Mission.** Write the UI specification every web agent builds from.
- **Owned.** `docs/UI.md`.
- **Read-only highlights.** Plan Appendix D, `AGENT.md` (shadcn-vue / AI Elements conventions).
- **Tasks.**
  1. **D3-T1 UI.md** — layout, design tokens (dark + light), fonts, density, routes and page owners, component
     inventory (shadcn-vue list, AI Elements subset), cross-agent component contracts (names, props, emits),
     shortcuts, `data-testid` contract, empty/loading/error states.
     *Accept:* every page in the plan layout has a section; every cross-agent component of Phases 2–3 has fixed
     props/emits; every test id is unique.

### D4 docs-phases

- **Mission.** Write the per-phase task lists (this file set), `README.md` and `LICENSE`.
- **Owned.** `docs/phases/phase-0-foundation.md`, `docs/phases/phase-1-core-services.md`,
  `docs/phases/phase-2-chat.md`, `docs/phases/phase-3-plugins.md`, `docs/phases/phase-4-hardening.md`, `README.md`,
  `LICENSE`.
- **Tasks.**
  1. **D4-T1 phase docs** — goal, entry/exit criteria, waves, agents (mission, owned globs, tasks with ids,
     acceptance, tests, verify commands), ownership JSON per wave, cross-agent contracts, gates.
     *Accept:* every ROADMAP task id has a section; every ownership block parses and has no overlapping globs.
  2. **D4-T2 README.md** — pitch, features, providers, quick start, configuration, plugins teaser, docs index,
     development, security note, license.
  3. **D4-T3 LICENSE** — MIT, `Copyright (c) 2025-2026 maksqi (https://github.com/maksqi)`.
- **Verify.** `perl -ne 'print "$ARGV:$.: $_" if /\p{Cyrillic}/' docs/phases/*.md README.md LICENSE` prints nothing.

### S0 scaffold

- **Mission.** Create the monorepo skeleton, install and pin every dependency, generate the shadcn-vue and AI
  Elements Vue components, and leave a skeleton that passes `pnpm check` and `pnpm build`.
- **Special permission.** S0 is the only sub-agent allowed to run pnpm and the scaffolding CLIs (`pnpm install`,
  `pnpm dlx`/`npx` for shadcn-vue and ai-elements-vue, `nuxi prepare`, `playwright install`). Still forbidden: git
  writes, dev servers on :3000/:8787.
- **Owned.** Root configs, `scripts/**`, `packages/**`, `apps/**` (placeholders; later waves take over the source
  paths). Exact globs in the ownership block below.
- **Read-only highlights.** Plan "Verified stack", Appendices D (nuxt.config, component lists) and F (dependencies,
  tooling), `AGENT.md` commands table.
- **Tasks.**
  1. **S0-T1 Root files** — `package.json` (name `harness-forge`, private, `"type": "module"`, `engines.node
     ">=22.12"`, `packageManager` pnpm 11, scripts: `dev`, `build`, `start`, `start:e2e`, `test`, `test:e2e`,
     `lint`, `typecheck`, `check:english`, `check`, `db:generate`, `catalog:update`), `pnpm-workspace.yaml`
     (`packages`, `catalog`, `overrides`, `allowBuilds`, `strictDepBuilds` per Appendix F), `tsconfig.base.json`
     (strict, ESM, explicit `types`, no `baseUrl`), `.nvmrc`, `.editorconfig`, `.gitignore` (`node_modules`, `.nuxt`,
     `.output`, `dist`, `data/`, `.tmp/`, `.env`, `coverage`, `test-results`, `playwright-report`), `.env.example`
     (every variable of the DECISIONS env table, commented defaults), `eslint.config.js` (`@antfu/eslint-config`;
     ignore `components/ui`, `components/ai-elements`, migrations, build output; `vue/no-v-html` = error),
     `vitest.config.ts` (projects: node for packages + server, happy-dom for web), `playwright.config.ts`
     (Chromium only, `testDir: 'e2e'`, `baseURL` from `E2E_BASE_URL` else `http://127.0.0.1:8899`).
     *Accept:* `pnpm check:english` and `pnpm lint` run on the skeleton.
  2. **S0-T2 Scripts** — `scripts/check-english.mjs` (fails on `\p{Script=Cyrillic}` in
     `git ls-files -co --exclude-standard`, prints `file:line`), `scripts/audit-ownership.mjs <wave.json>` (changed
     paths since the last checkpoint commit, tracked + untracked; each must match exactly one agent's globs; prints
     unowned paths and paths owned twice; exit 1 on any violation; literal match before glob match),
     `scripts/update-catalog.ts` (stub; implemented by W1.4).
     *Accept:* `node scripts/audit-ownership.mjs .tmp/waves/D.json` exits 0 after this wave.
  3. **S0-T3 Package skeletons** — `packages/shared` and `packages/plugin-sdk` (package.json exporting TS source
     `./src/index.ts`, tsconfig, placeholder `src/index.ts`; `plugin-sdk` depends on `shared`), `apps/server`
     (package.json with Appendix F deps, tsconfig, `drizzle.config.ts`, `tsdown.config.ts`, placeholder
     `src/main.ts`), `apps/web` (package.json with `typecheck:fast` = `vue-tsc -b --noEmit`, tsconfig, placeholder
     `app/app.vue`).
  4. **S0-T4 Install** — install Appendix F dependencies; finalize `allowBuilds` from the blocked-build list;
     commit-ready `pnpm-lock.yaml`.
     *Accept:* `pnpm install --frozen-lockfile` succeeds with no blocked build warnings.
  5. **S0-T5 Nuxt config** — `apps/web/nuxt.config.ts` per Appendix D: `ssr: false`, `compatibilityDate:
     '2025-07-15'`, `app/` srcDir, modules (`shadcn-nuxt`, `@nuxtjs/color-mode`, `@pinia/nuxt`, `@vueuse/nuxt`),
     Tailwind via `@tailwindcss/vite`, `colorMode: { preference: 'dark', fallback: 'dark', classSuffix: '',
     storageKey: 'hf-color-mode' }`, `shadcn` component dirs (`components/ui` no prefix, `components/ai-elements`
     prefix `Ai`), `nitro.devProxy['/api']` targeting `${HF_API_TARGET ?? 'http://localhost:8787'}/api`,
     `typescript.typeCheck: false`; then `nuxi prepare`.
  6. **S0-T6 shadcn-vue** — `shadcn-vue init`, then one `add` with the full component list from UI.md / Appendix D.
     *Accept:* files land in `apps/web/app/components/ui/**` and `apps/web/app/lib/utils.ts` (CLI bug #1933: files
     outside `app/` must be moved); `apps/web/components.json` points at `app/`.
  7. **S0-T7 AI Elements Vue** — add the subset `conversation message prompt-input reasoning tool confirmation
     context sources shimmer loader code-block` into `apps/web/app/components/ai-elements/**`; they resolve as
     `Ai*` components. Local patches are recorded in `apps/web/AI_ELEMENTS_PATCHES.md`; after Phase 0 the copied
     files are frozen (W2.2 renders `Markdown.vue` instead of patching them).
  8. **S0-T8 Pins** — `pnpm why typescript` shows only `6.0.x`; `pnpm why vue-stream-markdown` shows only `1.x`
     (re-pin through `catalog` + `overrides` if not).
  9. **S0-T9 Browsers** — `pnpm exec playwright install chromium`.
  10. **S0-T10 Green skeleton** — `pnpm check` and `pnpm build` pass on placeholders.
- **Verify.** `pnpm check`, `pnpm build`, `pnpm why typescript vue-stream-markdown`, `pnpm check:english`.

### Wave D ownership

```json
{
  "wave": "D",
  "agents": {
    "D1": ["docs/ARCHITECTURE.md", "docs/API.md"],
    "D2": ["docs/PLUGINS.md", "docs/PROVIDERS.md"],
    "D3": ["docs/UI.md"],
    "D4": [
      "docs/phases/phase-0-foundation.md",
      "docs/phases/phase-1-core-services.md",
      "docs/phases/phase-2-chat.md",
      "docs/phases/phase-3-plugins.md",
      "docs/phases/phase-4-hardening.md",
      "README.md",
      "LICENSE"
    ],
    "S0": [
      "package.json",
      "pnpm-workspace.yaml",
      "pnpm-lock.yaml",
      "tsconfig*.json",
      "eslint.config.js",
      "vitest.config.ts",
      "playwright.config.ts",
      ".env.example",
      ".gitignore",
      ".editorconfig",
      ".nvmrc",
      "scripts/**",
      "packages/**",
      "apps/**"
    ]
  }
}
```

### Wave D cross-agent contracts

- D1 (API.md) is the source for the C1+C2 DTOs and route table and for C4's route stubs; D3 (UI.md) is the source
  for C3/C5 and every web agent; D2 (PLUGINS.md) is the source for the C1+C2 plugin shapes and for C6. All must use
  DECISIONS names verbatim.

### Gate D+S

1. `node scripts/audit-ownership.mjs .tmp/waves/D.json`
2. Docs consistency (coordinator): endpoint list of `docs/API.md` equals the DECISIONS route-module table (method,
   path, module); builtin provider ids in `docs/PROVIDERS.md` equal DECISIONS; every task id of `docs/ROADMAP.md`
   appears in `docs/phases/`; component names used in the phase docs exist in `docs/UI.md`.
3. `pnpm install --frozen-lockfile` → `pnpm check` → `pnpm build`.
4. `pnpm why typescript` (only 6.0.x) · `pnpm why vue-stream-markdown` (only 1.x).
5. Update ROADMAP + wave log → checkpoint commit (`chore: scaffold monorepo and write reference docs`).

---

## P0.4 Wave C-a (contracts, part 1)

Two agents in one launch: **C1+C2 contracts** (one agent, both contract packages) and **C3**. **Entry:** Gate D+S
green.

### C1+C2 contracts

- **Mission.** Implement both contract packages (ADR-018: `plugin-sdk` depends on `shared`, never the reverse):
  `@harness-forge/shared` — every DTO, the error envelope, the route table and the typed API client used by the
  server, the web app and e2e tests, plus the zod schemas of the plugin data shapes (`PluginManifest`,
  `DeclarativeProvider`, `McpServerDecl`, `CredentialField`, `ModelInfo`, `SettingsSchema`) and of every enum, which
  API DTOs embed; `@harness-forge/plugin-sdk` — re-exports of those shapes and enums plus the runtime plugin API and
  `definePlugin`. One agent owns both packages so the layering cannot drift.
- **Owned.** `packages/shared/**`, `packages/plugin-sdk/**`.
- **Read-only highlights.** `docs/API.md`, `docs/PLUGINS.md` (section 9), `docs/DECISIONS.md` (contract seed),
  `docs/ARCHITECTURE.md`, plan Appendix A.
- **Order.** `shared` errors, enums and plugin data schemas first (C1-T1, C1-T2, C2-T2), then the other `shared`
  tasks, then `plugin-sdk` (C2-T1, C2-T3, C2-T4), which imports from `@harness-forge/shared` and never redefines a
  shape.
- **Tasks — `packages/shared`.**
  1. **C1-T1 Errors** — `HarnessErrorCode` (the 16 codes of DECISIONS, including `not_implemented`),
     `HarnessErrorAction`, zod `harnessErrorEnvelopeSchema`, class `HarnessError` (`code`, `message`, `status?`,
     `providerId?`, `retryAfterMs?`, `action?`, `details?`) with `toJSON()` → envelope and `httpStatus`, the
     `errorStatusByCode` table of API.md (the HTTP status is derived from `code`, e.g. `auth_invalid` → 502,
     `not_implemented` → 501; the envelope `status` is the upstream provider status), `HarnessErrorInit` type.
     *Accept:* round trip `HarnessError` → JSON → `parse` preserves every field; unknown codes are rejected.
  2. **C1-T2 Enums and ids** — `ToolMode`, `ReasoningEffort`, `ToolPolicy`, tool override, plugin kind/source/state,
     provider status, `apiFormat`; `parseModelRef` (split on the first `:`), `formatModelRef`, plugin id / tool
     name / command name regexes, `isReservedPluginId`, `BUILTIN_PROVIDER_IDS`, `BUILTIN_PLUGIN_IDS`,
     `mcpToolName(serverId, tool)` (≤64 chars, truncated with a short hash), `createChatId`, `createMessageId`
     (`msg_` + 16 chars; ADR-019: user ids on the client, assistant ids on the server).
     *Accept:* `ollama:llama3:8b` → `{ providerId: 'ollama', modelId: 'llama3:8b' }`;
     `openrouter:anthropic/claude-sonnet-5` splits once; refs without `:` are rejected.
  3. **C1-T3 DTOs** — zod schemas + inferred types for health, auth, settings (keys + defaults from DECISIONS),
     providers (incl. `icon: { color?, mono? } | null` and credential hints `{ set, hint, source }`), models, model
     prefs, custom models, chats (incl. `pendingApproval`), messages, files, tools, MCP servers, commands, plugins
     (list, detail, settings, logs, inspect, install, drafts, scaffold, files); plugin DTOs embed the C2-T2 schemas.
  4. **C1-T4 Chat contract** — chat request schema (`chatId`, `message`, `trigger`, `messageId?`, `modelRef`,
     `reasoningEffort`, `toolMode`), `MessageMetadata` (incl. `reasoningMs`), `data-*` part types,
     `HarnessUIMessage`.
  5. **C1-T5 Events** — `ServerEvent` union for the 9 SSE event types, payload `{ type, data, at }`; `run.finished`
     data includes `awaitingApproval`.
  6. **C1-T6 Route table** — `src/api/routes.ts`: every endpoint `{ method, path, module, params?, query?, body?,
     response }`.
     *Accept:* a test parses `docs/API.md` and asserts the same set of (method, path, module); method + path is
     unique.
  7. **C1-T7 API client** — `createApiClient({ baseUrl, fetch })` with one typed function per route; non-2xx →
     throws `HarnessError` parsed from the envelope (fallback `internal_error`); streaming endpoints are excluded.
- **Tasks — `packages/plugin-sdk`.**
  1. **C2-T1 Types** — the runtime types of Appendix A / PLUGINS.md section 9 (`ProviderRuntime`, `ReasoningParams`,
     `ProviderDefinition`, `ToolDefinition`, `CommandDefinition`, `HookMap`, `PluginContext`, `PluginModule`,
     `Disposable`, `KV`, `Logger`, `HostAi`), `PLUGIN_API_VERSION = '1.0.0'`, and unchanged re-exports of the data
     shapes and enums from `shared` (`PluginManifest`, `DeclarativeProvider`, `McpServerDecl`, `CredentialField`,
     `ModelInfo`, `SettingsSchema`, `ReasoningEffort`, `ToolPolicy`, `HarnessErrorInit`, ...). AI SDK types are
     type-only imports verified in the installed `.d.ts` (`LanguageModelV4`, `FlexibleSchema`, `ModelMessage`,
     `UIMessage`, ...).
  2. **C2-T2 Schemas** — zod `pluginManifestSchema`, `declarativeProviderSchema`, `credentialFieldSchema`,
     `modelInfoSchema`, `mcpServerDeclSchema`, `settingsSchemaSchema`, implemented in `packages/shared/src`
     (ADR-018) and re-exported by `plugin-sdk`; `settingsValuesSchema(schema)` in `plugin-sdk` (builds a zod schema
     for settings values, applies defaults).
     *Accept:* reserved ids (`core-x`, `mock`, `openai`), invalid ids (uppercase, 41 chars, leading `-`) and
     provider ids that are not `<pluginId>` or `<pluginId>-*` are rejected with a clear path.
  3. **C2-T3 `definePlugin`** — identity helper, default export of a code plugin's `main`.
  4. **C2-T4 Sample plugin** — `src/examples/sample-plugin.ts` registering a provider, a tool, a command and a hook;
     not exported from the package entry.
     *Accept:* it typechecks under `pnpm typecheck` with no casts.
- **Tests.** `shared`: `errors.test.ts`, `ids.test.ts`, `routes.test.ts`, `client.test.ts` (fake `fetch`),
  `manifest.test.ts` (both PLUGINS.md examples parse); `plugin-sdk`: `settings.test.ts`, `exports.test.ts`
  (re-exports are the same objects as in `shared`).
- **Verify.** `pnpm -F @harness-forge/shared test` · `pnpm -F @harness-forge/plugin-sdk test` · `pnpm typecheck` ·
  `pnpm check:english`.

### C3 web-shell

- **Mission.** Build the visual shell: tokens, fonts, dark default, the sidebar with `Chat | Plugins`, theme toggle,
  settings nav, `ProviderIcon`, and stub slot components that later agents replace.
- **Owned.** `apps/web/app/{app.vue, spa-loading-template.html, assets/**, layouts/**, components/app-shell/**,
  components/providers/**, components/common/**}`, `apps/web/public/**` (favicon).
- **Read-only highlights.** `docs/UI.md`, `apps/web/nuxt.config.ts`, `apps/web/app/components/{ui,ai-elements}/**`.
- **Tasks.**
  1. **C3-T1 Tokens** — `assets/css/main.css`: Tailwind 4 + `tw-animate-css`, oklch tokens for dark (default) and
     light per UI.md, `success`/`warning`/`info`, radius `.625rem`, density variables (`data-density=compact`),
     fonts via `@fontsource-variable` (Hanken Grotesk, Source Serif 4, JetBrains Mono).
     *Accept:* no hard-coded colors outside `main.css`; `html.dark` and light both render readable text.
  2. **C3-T2 Dark default** — `app.vue`, dark-styled inline `spa-loading-template.html`.
     *Accept:* with the OS preferring light and empty storage, `<html>` has class `dark` before first paint (the
     color-mode script is present in the generated `200.html`).
  3. **C3-T3 Layouts** — `layouts/**` per UI.md: `SidebarProvider` (16.5rem, Mod+B) → `AppSidebar` +
     `SidebarInset`; mobile = Sheet; a bare layout for `/login`.
  4. **C3-T4 Sidebar** — `AppSidebar.vue` (ember mark + mono wordmark + trigger; `Tabs` Chat | Plugins driven by the
     route; `/settings/*` swaps tabs for "← Back to app" + `SettingsNav`; footer Settings + `ThemeToggle`),
     `ThemeToggle.vue` (ToggleGroup Moon/Sun/Monitor → `useColorMode().preference`; collapsed → dropdown),
     `SettingsNav.vue`.
  5. **C3-T5 Stub slots** — `ChatNav.vue`, `PluginsNav.vue`, `CommandPalette.vue`, `ShortcutsDialog.vue` with the
     props/emits from UI.md and placeholder content; mounted by the layout/sidebar.
  6. **C3-T6 ProviderIcon** — `components/providers/ProviderIcon.vue`: mono → `<span>` with CSS `mask-image` over
     `bg-current`; color → `<img>` on a `bg-muted` tile; fallback monogram on `oklch(0.45 0.09 h)` (dark) /
     `oklch(0.90 0.05 h)` (light), `h` from an id hash. Never `v-html`.
  7. **C3-T7 Shared components** — the other `providers/` and `common/` components of UI.md 10.3 with their 10.4
     contracts: `ModelCaps`, `ModelLabel`, `ProviderStatusBadge`, `BrandMark`, `StatusDot`, `KbdCombo`,
     `PageHeader`, `CopyButton`, `InlineRename`, `ConfirmDialog`, `ConfirmPasswordDialog` (presentational fresh-auth
     prompt), `HarnessErrorAlert`, `FileChip`, `RelativeTime` (`Markdown` belongs to W2.2).
- **Tests.** `ProviderIcon.test.ts` (mono/color/fallback, no raw HTML), `ThemeToggle.test.ts` (sets `preference`).
- **Verify.** `pnpm -F @harness-forge/web test` · `pnpm -F @harness-forge/web typecheck:fast` ·
  `pnpm check:english`.

### Wave C-a ownership

```json
{
  "wave": "C-a",
  "agents": {
    "C1+C2": ["packages/shared/**", "packages/plugin-sdk/**"],
    "C3": [
      "apps/web/app/app.vue",
      "apps/web/app/spa-loading-template.html",
      "apps/web/app/assets/**",
      "apps/web/app/layouts/**",
      "apps/web/app/components/app-shell/**",
      "apps/web/app/components/providers/**",
      "apps/web/app/components/common/**",
      "apps/web/public/**"
    ]
  }
}
```

### Gate C-a

1. `node scripts/audit-ownership.mjs .tmp/waves/C-a.json`
2. `pnpm check` → `pnpm build`.
3. Coordinator `pnpm dev`: shell renders dark with the OS emulated as light; theme toggle switches and persists
   (`hf-color-mode`); screenshots (dark + light) into `.tmp/gates/C-a/`.
4. Update ROADMAP + wave log → checkpoint commit.

---

## P0.5 Wave C-b (contracts, part 2)

Three agents in one launch. **Entry:** Gate C-a green. The coordinator runs `pnpm db:generate` as soon as C4
reports (C4 cannot run drizzle-kit) and re-runs C4's DB-backed tests before the gate.

### C4 server-skeleton

- **Mission.** Build the server skeleton: env, app factory with every route module mounted as a 501 stub, Drizzle
  schema, frozen service/registry interfaces, builtin plugin index, test harness.
- **Owned.** `apps/server/src/**` except `builtin-plugins/{core-providers,core-commands}/**` (exact globs below).
- **Read-only highlights.** `docs/ARCHITECTURE.md`, `docs/API.md`, `packages/shared/src/**`,
  `packages/plugin-sdk/src/**`.
- **Tasks.**
  1. **C4-T1 env** — `env.ts`: zod-parsed env (every DECISIONS variable with its default); `HF_DATA_DIR` resolved
     against the repo root in dev; typed `Env`.
  2. **C4-T2 App factory** — `app.ts` `createApp(deps)`: Hono app under `/api`, request id, `onError` → envelope,
     `notFound` → `not_found` envelope; mounts all 18 modules of `http/routes/` (`health auth settings credentials
     events providers models icons chats chat files tools mcp commands plugins plugin-install plugin-drafts
     plugin-files`) using the endpoint → module mapping of API.md. Every stub endpoint returns **501
     `not_implemented`** (`{ error: { code: 'not_implemented', message } }`, status from `errorStatusByCode`);
     `GET /api/health` is real (`200`, `Health` DTO of API.md) so gates can probe it.
  3. **C4-T3 Database** — `db/schema.ts` (14 tables, ARCHITECTURE.md columns), `db/client.ts` (libsql, WAL,
     `foreign_keys = ON`), `db/migrate.ts` (`migrate()` at boot, migrations folder resolved from the package).
     *Accept:* after the coordinator's `pnpm db:generate`, `apps/server/drizzle/0000_*.sql` creates every table.
  4. **C4-T4 Interfaces** — `types.ts` in `services/{settings,secrets,chats,files,events}/`, `security/`,
     `registry/`, `plugins/`, `providers/`, `catalog/`, `chat/`, `mcp/`, plus stub factories (`index.ts` throwing
     `not implemented`) with the export names `app.ts` imports. Later agents replace the implementations and keep
     the names.
  5. **C4-T5 Builtin index** — `builtin-plugins/index.ts` statically imports `core-providers`, `core-commands`,
     `core-tools`, `core-mcp`, and `mock` (the latter only when `HF_MOCK_PROVIDER=1`); C4 creates
     `definePlugin({ setup() {} })` stubs for `core-tools`, `core-mcp`, `mock`.
  6. **C4-T6 Entry + logger** — `main.ts` (env → db → migrate → app → `serve`, graceful shutdown), `logger.ts`
     (levels, request id, redaction of `authorization`, `cookie`, `x-api-key` and keys matching
     `key|secret|password|token`).
  7. **C4-T7 Test harness** — `testing/create-test-app.ts`: `createTestApp(overrides?)` → `{ app, deps, db }` with
     in-memory libsql, migrations applied, a fake keyring and an optional `builtins` override.
     *Accept:* `routes-mounted.test.ts` iterates the shared route table: every endpoint answers 501 with code
     `not_implemented` (health 200); none answers 404.
- **Verify.** `pnpm -F @harness-forge/server test` · `pnpm typecheck` · `pnpm check:english`.

### C5 web-skeleton

- **Mission.** Build the web skeleton: every page as a stub, Pinia stores over the typed client, `$api`, the SSE
  client, the shortcuts registry and the `data-testid` constants.
- **Owned.** `apps/web/app/{pages,stores,composables,middleware,plugins,utils}/**`, `apps/web/app/error.vue`.
- **Read-only highlights.** `docs/UI.md`, `docs/API.md`, `packages/shared/src/**`, C3 output.
- **Tasks.**
  1. **C5-T1 Pages** — stubs for `index`, `chat/[id]`, `plugins` (parent route `pages/plugins.vue`: `<NuxtPage />` +
     the slot for the single `InstallDialog`; W3.1 builds it), `plugins/{index,new,[id]}`, `settings/{index,
     providers,models,general,appearance,about}` (`settings/index` redirects to `/settings/providers`), `login`, and
     `app/error.vue` ("Page not found"); each renders its UI.md root `data-testid`.
  2. **C5-T2 `$api`** — `plugins/api.ts` provides `createApiClient` (same-origin cookies). A 401 whose envelope code
     is `unauthorized` redirects to `/login?redirect=…`; `auth_invalid` (bad provider key, HTTP 502) never
     redirects.
  3. **C5-T3 SSE** — `plugins/events.client.ts`: one `EventSource('/api/events')`, reconnect with backoff, typed
     dispatch into stores (`chat.*`, `run.*`, `provider.changed`, `catalog.changed`, `plugin.*`).
  4. **C5-T4 Stores** — `stores/{auth,chats,providers,models,plugins,settings,ui}.ts`, `use<Name>Store`, implemented
     over `$api`. The chats store holds per-chat status (`statusOf(id)`: `running | approval | unread | null`),
     seeded from `ChatSummary.running` / `pendingApproval`, updated by `run.*` events (`awaitingApproval`) and by
     the chat session, and read by the sidebar.
     *Accept:* signatures documented in UI.md; they freeze at the end of this wave.
  5. **C5-T5 Middleware** — `middleware/auth.global.ts`: when a password is required and there is no session, route
     to `/login?redirect=<path>`.
  6. **C5-T6 Shortcuts** — `composables/useShortcuts.ts`: registry (id, keys, description, group, handler,
     enabled), Mod = Meta on macOS else Ctrl, Alt shortcuts matched by `event.code` and ignored with Ctrl, list API
     for `ShortcutsDialog`; `plugins/shortcuts.client.ts` installs the single `keydown` listener. Global handlers are
     registered later by W2.4 (`useGlobalShortcuts()`, called from `CommandPalette.vue`).
  7. **C5-T7 Test ids** — `utils/testids.ts`: every id of the UI.md `data-testid` contract (e2e imports it).
- **Tests.** store tests with a mocked `$api`, `useShortcuts.test.ts`, `api.test.ts` (401 handling).
- **Verify.** `pnpm -F @harness-forge/web test` · `pnpm -F @harness-forge/web typecheck:fast` ·
  `pnpm check:english`.

### C6 core-providers

- **Mission.** Implement the `core-providers` builtin plugin (13 providers through the public SDK) and
  `core-commands`.
- **Owned.** `apps/server/src/builtin-plugins/{core-providers,core-commands}/**`.
- **Read-only highlights.** `docs/PROVIDERS.md`, `docs/PLUGINS.md`, `packages/plugin-sdk/src/**`, installed
  `@ai-sdk/*` and `@openrouter/ai-sdk-provider` `.d.ts` files.
- **Tasks.**
  1. **C6-T1 Entry stubs first** — `core-providers/index.ts` and `core-commands/index.ts` default-export a
     `definePlugin(...)` module before anything else, so C4's `builtin-plugins/index.ts` resolves.
  2. **C6-T2 Providers** — one `ProviderDefinition` per builtin id (`anthropic openai google xai deepseek moonshotai
     alibaba zai minimax mistral groq openrouter ollama`): name, icon (`lobe:<slug>` color/mono), credentials
     (`apiKey` secret with env fallback, Advanced `baseURL`; Ollama has no key), `keyUrl`, `modelsDevId`,
     `smallModelId`, `seedModels`, `createLanguageModel` returning a provider **instance** (never a string id),
     `listModels` where the vendor supports it (Ollama via `/api/tags`).
  3. **C6-T3 Reasoning** — `reasoning(effort, model)` returns `ReasoningParams` exactly as PROVIDERS.md section 4
     maps it: the portable AI SDK v7 top-level `reasoning` option where the package translates it, `providerOptions`
     only where PROVIDERS.md says so (e.g. MiniMax, Z.ai, OpenRouter, Anthropic `max`), plus the always-on options
     (Groq `reasoningFormat`, OpenRouter `usage`); `auto` returns `undefined`.
  4. **C6-T4 Errors** — `mapError` for vendor quirks (401/403, 429 with retry-after, model not found, context
     length).
  5. **C6-T5 Commands** — `core-commands` registers the builtin template commands listed in PLUGINS.md.
- **Tests.** providers (ids equal DECISIONS; `createLanguageModel` yields the right `provider`/`modelId` without
  network; `reasoning('auto', m)` is `undefined` for all; seeds validate against `modelInfoSchema`), commands (names
  match the command regex; templates contain `{{input}}`).
- **Verify.** `pnpm -F @harness-forge/server test` · `pnpm typecheck` · `pnpm check:english`.

### Wave C-b ownership

```json
{
  "wave": "C-b",
  "agents": {
    "C4": [
      "apps/server/src/*.ts",
      "apps/server/src/http/**",
      "apps/server/src/security/**",
      "apps/server/src/db/**",
      "apps/server/src/services/**",
      "apps/server/src/registry/**",
      "apps/server/src/plugins/**",
      "apps/server/src/catalog/**",
      "apps/server/src/providers/**",
      "apps/server/src/chat/**",
      "apps/server/src/mcp/**",
      "apps/server/src/testing/**",
      "apps/server/src/builtin-plugins/index.ts",
      "apps/server/src/builtin-plugins/index.test.ts",
      "apps/server/src/builtin-plugins/core-tools/**",
      "apps/server/src/builtin-plugins/core-mcp/**",
      "apps/server/src/builtin-plugins/mock/**"
    ],
    "C5": [
      "apps/web/app/pages/**",
      "apps/web/app/stores/**",
      "apps/web/app/composables/**",
      "apps/web/app/middleware/**",
      "apps/web/app/plugins/**",
      "apps/web/app/utils/**",
      "apps/web/app/error.vue"
    ],
    "C6": [
      "apps/server/src/builtin-plugins/core-providers/**",
      "apps/server/src/builtin-plugins/core-commands/**"
    ]
  }
}
```

`apps/server/drizzle/**` is generated by the coordinator (`pnpm db:generate`) and is not agent-owned.

### Wave C-b cross-agent contracts

- C4 `builtin-plugins/index.ts` imports the default exports of C6's two entry files (C6-T1 lands them first).
- C5 stores call only `createApiClient` functions from `@harness-forge/shared`; C4 route stubs follow the same route
  table, so the web skeleton and server agree on paths before any endpoint is implemented.

## FREEZE (in force after P0.5, copied from AGENT.md)

Coordinator-only from now on: `packages/*/src`, `apps/server/src/app.ts`, `apps/server/src/db/schema.ts`,
`apps/server/drizzle/**`, every `*/types.ts` under `apps/server/src`, `apps/server/src/builtin-plugins/index.ts`,
`apps/web/app/layouts/**`, store signatures in `apps/web/app/stores/**`, `apps/web/nuxt.config.ts`, every
`package.json` and config file, `apps/web/app/components/{ui,ai-elements}/**`, CSS design tokens in
`apps/web/app/assets/css/main.css`.

Changes go through a CCR in the agent report; the coordinator batches them between waves.

### Gate C-b (final Phase 0 gate)

1. `pnpm db:generate` (coordinator, once C4 reports) → `node scripts/audit-ownership.mjs .tmp/waves/C-b.json`
2. `pnpm install --frozen-lockfile` (if deps changed) → `pnpm check` → `pnpm build`.
3. `pnpm start:e2e` (`HF_MOCK_PROVIDER=1 HF_PORT=8899 HF_DATA_DIR=.tmp/e2e`) → `curl -sf :8899/api/health`; every
   other route returns 501 with the `not_implemented` envelope, e.g.:
   ```sh
   for p in settings providers models chats tools mcp commands plugins icons/lobe auth/status; do
     curl -s -o /dev/null -w "%{http_code} GET /api/$p\n" "http://127.0.0.1:8899/api/$p"
   done   # every line prints 501
   ```
   (the full method × path matrix is covered by `routes-mounted.test.ts`).
4. `pnpm why typescript` (only 6.0.x) · `pnpm why vue-stream-markdown` (only 1.x).
5. Screenshots of the shell and stub pages (dark + light) into `.tmp/gates/C-b/`.
6. Apply FREEZE → update ROADMAP + wave log → checkpoint commit.
