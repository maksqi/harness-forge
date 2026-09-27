# Phase 3 — Plugins, tools, MCP

Part of the harness-forge build plan. Progress is tracked in `docs/ROADMAP.md` (coordinator only). Shared names come
from `docs/DECISIONS.md`; plugin rules from `docs/PLUGINS.md`; endpoints from `docs/API.md`; components, props and
test ids from `docs/UI.md`.

## Goal

Make the Plugins tab complete: list/detail/settings/logs, install from zip/npm/URL/folder with a trust gate, the
declarative provider wizard, code plugins edited in the browser with build & hot reload, MCP servers and tool
preferences, the `core-tools` builtin, and `@plugins` e2e specs.

## Entry criteria

- Phase 2 exit criteria met; W2 checkpoint commit exists; `@smoke` green.
- Plugin host (W1.3) loads, validates, guards, compiles and hot-reloads plugins; `GET /api/plugins` works.
- The cross-agent component contracts below are fixed in `docs/UI.md` (names, props, emits) before launch.
- The coordinator has built the W2 checkpoint for the e2e agent.

## Exit criteria

- ROADMAP items W3.1–W3.6 checked; W3 gate green; checkpoint commit.
- A zip-installed declarative plugin, a wizard-created provider, a code plugin from the Tool template and an MCP
  stdio server all work in chat; disabling a plugin removes its contributions.
- `pnpm test:e2e --grep "@smoke|@plugins"` green with the OS color scheme emulated as light.

## Rules for every Phase 3 agent

- Server paths are under `apps/server/src/`; web paths under `apps/web/app/`. Tests live next to code.
- The plugin host, registry and declarative adapter (W1.3) are read-only: use the frozen `plugins/types.ts` and
  `registry/types.ts` interfaces; a missing host capability → CCR + local adapter.
- Every filesystem path derived from input is realpath-checked inside its root; archives are extracted only into
  `data/plugins/.staging/`.
- Cross-agent components are imported explicitly by path; props/emits come from UI.md.
- Verify commands — server: `pnpm -F @harness-forge/server test` · `pnpm typecheck`; web:
  `pnpm -F @harness-forge/web test` · `pnpm -F @harness-forge/web typecheck:fast`; all: `pnpm check:english`.

---

## Wave W3 (6 agents in one launch)

### W3.1 plugins-web

- **Mission.** Build the Plugins mode of the sidebar, the plugin list, the plugin detail page with its tabs, and the
  schema-driven settings form.
- **Owned.** `pages/plugins.vue` (parent route, C5 stub), `pages/plugins/index.vue`, `pages/plugins/[id].vue`,
  `components/plugins/{list,detail,forms}/**`, `components/app-shell/PluginsNav.vue` (+ test).
- **Read-only highlights.** `stores/plugins.ts`, `components/providers/ProviderIcon.vue`,
  `packages/shared/src/**` (`SettingsSchema`, ADR-018), `packages/plugin-sdk/src/**` (`settingsValuesSchema`),
  `docs/UI.md` (plugins UX).
- **Tasks.**
  1. **W3.1-T1 PluginsNav** — "New plugin ▾" (Provider → `/plugins/new?type=provider`, Code →
     `/plugins/new?type=code`), "Install…" (`ui.openInstall()`), Browse: All / Providers / Tools / MCP servers /
     Commands / Disabled with counts (`/plugins?filter=all|providers|tools|mcp|commands|disabled`), Installed list
     with icon + status dot. `pages/plugins.vue` is the parent route of every `/plugins/*` page: `<NuxtPage />` +
     the single `InstallDialog` instance bound to `ui.installDialogOpen` (`@installed` → `/plugins/<id>`).
  2. **W3.1-T2 List** — `PluginCard` (icon, name, version, source badge Core / Declarative / Code / npm / zip /
     local, contributions summary, "Runs code" badge, enable Switch, red border + "View logs" on error); builtins
     carry a Core badge and no Uninstall; `core-providers` is one card (its providers are toggled in Settings →
     Providers); `?filter=` + `?q=` search; empty state.
  3. **W3.1-T3 Detail** — header (icon, name, version, state badge, enable switch, Reload, Export, Uninstall via
     AlertDialog with a keep-data checkbox; `untrusted` → `TrustWarning`); tabs Overview / Configuration / Source /
     Logs synced with `?tab=`; Source renders `PluginSourceTab` for code plugins only.
  4. **W3.1-T4 Overview** — contributions: providers, models, tools (per-tool approval select allow / ask / deny +
     enable switch → `PATCH /api/tools/:name`), MCP servers (status + restart → `POST /api/mcp/:id/reconnect`),
     commands; for `core-mcp` render `McpServersPanel`.
  5. **W3.1-T5 Settings form** — `components/plugins/forms/**`: fields from `SettingsSchema` (string, enum → select,
     `format: 'secret'` → password input showing only the stored hint, `url`, `multiline`, number/integer with
     bounds, boolean → switch, string/enum arrays), validated with `settingsValuesSchema`, saved with
     `PUT /api/plugins/:id/settings`.
     *Accept:* every field type renders, validates and round-trips; a stored secret is never shown.
  6. **W3.1-T6 Logs** — history from `GET /api/plugins/:id/logs` + live `plugin.log` events, level filter, copy.
- **Tests.** settings form per field type, secret hint only, filter counts, uninstall confirm, builtins not
  removable.
- **Verify.** Web commands.

### W3.2 plugin-install

- **Mission.** Install plugins safely from zip, npm, URL and local folders through a staging area, with an inspect
  preview and an explicit trust step for code.
- **Owned.** `apps/server/src/plugins/install/**`, `apps/server/src/http/routes/plugin-install.ts` (+ test),
  `apps/web/app/components/plugins/install/**`.
- **Read-only highlights.** `plugins/types.ts` (host interface), `http/middleware/fresh-auth.ts` (fresh auth, W1.1),
  `stores/auth.ts`, `docs/PLUGINS.md` (install + trust), `docs/API.md`.
- **Tasks.**
  1. **W3.2-T1 Staging** — every install lands in `data/plugins/.staging/<uuid>`, is validated by the host pipeline,
     then renamed atomically to `data/plugins/<id>`; the previous version stays until the new one is `active`
     (rollback on failure); stale staging dirs are removed at boot.
  2. **W3.2-T2 Zip** — fflate; ≤20 MB compressed, ≤100 MB expanded, ≤2000 entries; reject absolute paths, `..`,
     drive letters, backslashes and symlinks; realpath check after extraction; a single top-level folder is
     unwrapped.
  3. **W3.2-T3 npm** — registry metadata → version → tarball → verify `dist.integrity` (sha512) → extract with the
     same guards; lifecycle scripts never run; manifest read from `package/plugin.json`.
  4. **W3.2-T4 URL** — https `.zip` / `.tgz` with a required `integrity` (SRI); same guards and limits; redirects
     capped.
  5. **W3.2-T5 Folder** — `link` (in place, watched, trust pinned to path + hash, `source = 'link'`) or `copy`.
  6. **W3.2-T6 API** — `POST /plugins/inspect` (preview without installing: manifest, kind, contributions, hosts
     contacted, secrets requested, permissions, sha256 of `plugin.json` + `main`, warnings), `POST /plugins/install`
     (multipart zip | `PluginInstallSource`: `{ source: 'npm', spec }` | `{ source: 'url', url, integrity }` |
     `{ source: 'path', path, mode }`; plus `trust?`, `enable?`), `POST /plugins/:id/trust` (records
     `trusted_hash`), `GET /plugins/:id/export` (zip of the plugin directory).
  7. **W3.2-T7 Fresh auth** — ADR-017 with the API.md mechanism: with a password configured, installing a plugin that
     requires trust (code or stdio MCP, with or without `trust`) and `POST /plugins/:id/trust` need a login within
     the last 10 minutes (`requireFreshAuth`, W1.1), else 403 `forbidden` with `action: 'login'`.
  8. **W3.2-T8 Web** — `InstallDialog.vue` (tabs Zip / npm / URL / Local folder → inspect preview → install),
     `TrustWarning.vue` (red warning with the PLUGINS.md text, sha256, "I trust <source>" checkbox) and
     `TrustDialog.vue`; when a password is set and the session is not fresh (`AuthStatus.freshUntil`), the dialogs
     show "Confirm your password" and call `POST /api/auth/login` right before install / trust (UI.md 8.3–8.4).
- **Tests.** archives generated in-test with fflate: `../evil`, `/abs`, `C:\x`, backslash names, symlink entries,
  size/entry limits; npm/URL integrity mismatch; failed install keeps the previous version; an untrusted code plugin
  stays unloaded until trusted; changing `main` invalidates trust.
- **Verify.** Server and web commands.

### W3.3 provider-wizard

- **Mission.** Let users create a declarative provider plugin with a 5-step wizard that tests the connection before
  saving.
- **Owned.** `apps/web/app/pages/plugins/new.vue`, `apps/web/app/components/plugins/wizard/**`,
  `apps/server/src/http/routes/plugin-drafts.ts` (+ test), `apps/server/src/plugins/drafts/**` (server helpers).
- **Read-only highlights.** `plugins/declarative.ts`, `plugins/types.ts`, `packages/shared/src/**` (manifest
  schemas, ADR-018), `docs/UI.md` (wizard), `docs/PLUGINS.md` (declarative format).
- **Tasks.**
  1. **W3.3-T1 New page** — `?type=provider` → wizard; `?type=code` → `CodePluginForm` (W3.4); no type → chooser.
  2. **W3.3-T2 Wizard** — TanStack Form + shared zod, draft in localStorage: Basics (name, id auto-slug with live
     validation and availability, icon: upload / LobeHub search via `GET /api/icons/lobe` / monogram) → API
     (`openai-chat` | `openai-responses` | `anthropic` | `google`, base URL, templates Together / Fireworks /
     LM Studio / vLLM / LiteLLM) → Credentials (fields, auth style bearer / header / none, headers with
     `{{credentials.<key>}}`) → Models (fetch through the draft test, or manual entry with capabilities, efforts,
     $/M) → Review (manifest JSON + Test 1-token ping with latency) → Create; credentials travel in
     `PluginDraft.credentials` and the server stores them as provider credentials (as `PUT
     /api/providers/:id/credentials` does), never in `plugin.json`.
  3. **W3.3-T3 Server** — `POST /plugins` (validate manifest; reserved ids rejected; existing id → 409 `conflict`;
     write `data/plugins/<id>/plugin.json`; load through the host; `source = 'created'`; a manifest with a stdio MCP
     server needs fresh auth and is pinned at creation),
     `POST /plugins/drafts/test` (ephemeral provider from the draft + supplied credentials: list models or 1-token
     ping → `DraftTestResult` `{ ok, latencyMs, models?, output?, error? }`; nothing persisted),
     `PUT /plugins/:id/manifest` (update a declarative manifest; hot reload; declaring or changing a stdio MCP
     server needs fresh auth and re-pins).
     *Accept:* a created provider appears in `GET /api/providers` and in the model picker without a restart.
- **Tests.** id conflict, reserved ids, draft test against an in-test mock OpenAI-compatible server, credentials not
  written to disk in plain text, wizard step validation.
- **Verify.** Server and web commands.

### W3.4 code-plugins

- **Mission.** Create code plugins from templates and edit them in the browser (CodeMirror) with a traversal-safe
  file API, esbuild diagnostics and build & reload.
- **Owned.** `apps/server/src/plugins/{scaffold,templates}/**`, `apps/server/src/http/routes/plugin-files.ts`
  (+ test), `apps/web/app/components/plugins/code/**`.
- **Read-only highlights.** `plugins/compile.ts`, `plugins/types.ts`, `packages/plugin-sdk/src/**`,
  `docs/PLUGINS.md` (code plugins, `ctx`), `docs/UI.md` (Source tab).
- **Tasks.**
  1. **W3.4-T1 Templates** — `plugins/templates/**`: tool, provider, MCP bridge, command pack; each is a
     `plugin.json` + JSDoc-typed `index.mjs` that uses only `ctx` (no runtime imports).
     *Accept:* every template loads to `active` through the host in a test.
  2. **W3.4-T2 Scaffold** — `plugins/scaffold/**` + `POST /plugins/scaffold` (fresh auth; `{ template, id, name }` →
     `data/plugins/<id>/`, `source = 'created'`, trust pinned at creation).
  3. **W3.4-T3 File API** — `GET /plugins/:id/files` (tree), `GET|PUT|DELETE /plugins/:id/files/*` (decode once;
     reject `..`, absolute paths, NUL, backslashes, symlinks; realpath inside the plugin dir; text files ≤1 MB; only
     `created`, `copy` and `link` plugins are writable (`PluginDetail.editable`); `plugin.json` and the `main` entry
     cannot be deleted; rename = write the new path + delete the old one). A save of a `created` plugin re-pins its
     trust hash automatically (ADR-017); `POST /plugins/:id/build` (fresh auth; compile via the host → diagnostics
     `{ file, line, column, message }`, `.ts` output in `data/cache/plugins/<id>/`; re-pins trust and reloads on
     success; progress as `plugin.log` events).
  4. **W3.4-T4 Web** — `CodePluginForm.vue` (template picker + id/name → scaffold → `/plugins/<id>?tab=source`) and
     `PluginSourceTab.vue` (file tree with new / rename / delete | CodeMirror 6 tabs for js/ts/json/md themed from
     the tokens | build/log panel fed by `plugin.log`; Mod+S saves; "Build & reload"; inline diagnostics;
     unsaved-changes guard); fresh-auth failures follow UI.md 7.4.
- **Tests.** traversal (`../`, `%2e%2e%2f`, absolute, symlink), size limit, zip/npm plugins read-only, delete
  (entry and `plugin.json` refused), a save of a `created` plugin keeps it trusted, diagnostics for a syntax error,
  templates load.
- **Verify.** Server and web commands.

### W3.5 tools-mcp

- **Mission.** Implement the MCP manager, tool preferences, the `core-tools` and `core-mcp` builtins, and the MCP
  servers panel.
- **Owned.** `apps/server/src/mcp/**`, `apps/server/src/builtin-plugins/{core-mcp,core-tools}/**`,
  `apps/server/src/http/routes/{tools,mcp}.ts` (+ tests), `apps/web/app/components/plugins/mcp/**`.
- **Read-only highlights.** `mcp/types.ts`, `registry/**`, `chat/approval.ts` (policy consumer),
  installed `@ai-sdk/mcp` `.d.ts`, `docs/PLUGINS.md` (MCP), `docs/API.md`.
- **Tasks.**
  1. **W3.5-T1 MCP manager** — servers from `mcp_servers`, plugin `contributes.mcpServers` and `ctx.mcp.register`;
     `createMCPClient` for http, sse and stdio (`@ai-sdk/mcp/mcp-stdio`); status connecting / connected / error with
     the last error; reconnect with backoff; clients closed on disable, delete and shutdown; tools registered as
     `mcp__<serverId>__<tool>` (≤64 chars, truncated with a short hash); `readOnlyHint` → `safe`,
     `destructiveHint` → `always`, else the server policy (default `ask`); stdio servers from plugins need trust.
  2. **W3.5-T2 MCP API** — `GET /mcp`, `POST /mcp`, `PATCH /mcp/:id`, `DELETE /mcp/:id`, `POST /mcp/:id/reconnect`;
     header and env values stored as secrets under `mcp:<id>` and returned masked; creating a stdio server or
     switching one to stdio needs fresh auth (`requireFreshAuth`, W1.1).
  3. **W3.5-T3 Tools API** — `GET /tools` (name, description, source plugin or MCP server, policy, enabled,
     override), `PATCH /tools/:name` (`enabled`, override `allow | ask | deny` in `tool_prefs`).
  4. **W3.5-T4 core-tools** — `current_time` (policy `safe`) and `web_fetch` (policy `ask`; http/https only; DNS
     resolved and loopback, private, link-local, CGNAT, cloud-metadata and IPv6 ULA/link-local targets blocked;
     re-checked on every redirect (≤5); 10 s timeout; 2 MB response cap (ARCHITECTURE.md 10.4); text extraction).
  5. **W3.5-T5 core-mcp** — builtin that exposes the stored MCP servers as its contributions; not removable.
  6. **W3.5-T6 Web** — `McpServersPanel.vue` (+ sub-components): list with status dot, add/edit dialog (stdio
     command/args/env, http/sse URL/headers), policy select, enable switch, reconnect, delete with confirm.
- **Tests.** stdio echo MCP server spawned in-test, name truncation + hash, hint → policy, clients closed on
  disable, SSRF table (`127.0.0.1`, `10.0.0.1`, `169.254.169.254`, `[::1]`, `[fd00::1]`, redirect to a private IP),
  tool pref overrides.
- **Verify.** Server and web commands.

### W3.6 e2e-plugins

- **Mission.** Write the `@plugins` Playwright specs and the fixtures they need.
- **Owned.** `e2e/specs/plugins/**`, `e2e/fixtures/**`.
- **Read-only highlights.** `e2e/support/**`, `e2e/specs/core/**`, `playwright.config.ts`,
  `apps/web/app/utils/testids.ts`, `docs/UI.md`.
- **Tasks.**
  1. **W3.6-T1 Fixtures** — mock OpenAI-compatible server (`/v1/models`; streaming `/v1/chat/completions`; when the
     request offers tools it calls the first tool, then echoes the tool result), stdio MCP echo server (Node
     script), plugin sources zipped at test time; each started in `beforeAll` on an ephemeral port.
  2. **W3.6-T2 Specs** — `e2e/specs/plugins/*.spec.ts`, each tagged `@plugins`:
     1. install a declarative plugin zip → preview → install → provider listed in Settings and in the picker;
     2. wizard → provider pointing at the mock OpenAI server → Test ✓ → Create → a chat streams through it;
     3. code plugin from the Tool template → edit in the Source tab → Build & reload → chat calls the tool →
        approval card → result row;
     4. MCP stdio echo server added in the MCP panel → connected → its tool is called in chat → result row with the
        MCP badge;
     5. disabling a plugin removes its provider from the picker and its tools from `GET /api/tools`.
- **Verify.** `pnpm test:e2e --list`; specs that need only Phase 2 UI can run on the agent slot against the W2
  build (`HF_MOCK_PROVIDER=1 HF_PORT=889k HF_DATA_DIR=.tmp/W3.6 pnpm start`,
  `E2E_BASE_URL=http://127.0.0.1:889k pnpm test:e2e --grep @plugins`).

### Wave W3 ownership

`?id?.vue` matches the literal Nuxt file `[id].vue` (square brackets are glob character classes).

```json
{
  "wave": "W3",
  "agents": {
    "W3.1": [
      "apps/web/app/pages/plugins.vue",
      "apps/web/app/pages/plugins/index.vue",
      "apps/web/app/pages/plugins/?id?.vue",
      "apps/web/app/components/plugins/list/**",
      "apps/web/app/components/plugins/detail/**",
      "apps/web/app/components/plugins/forms/**",
      "apps/web/app/components/app-shell/PluginsNav.vue",
      "apps/web/app/components/app-shell/PluginsNav.test.ts"
    ],
    "W3.2": [
      "apps/server/src/plugins/install/**",
      "apps/server/src/http/routes/plugin-install.ts",
      "apps/server/src/http/routes/plugin-install.test.ts",
      "apps/web/app/components/plugins/install/**"
    ],
    "W3.3": [
      "apps/web/app/pages/plugins/new.vue",
      "apps/web/app/components/plugins/wizard/**",
      "apps/server/src/http/routes/plugin-drafts.ts",
      "apps/server/src/http/routes/plugin-drafts.test.ts",
      "apps/server/src/plugins/drafts/**"
    ],
    "W3.4": [
      "apps/server/src/plugins/scaffold/**",
      "apps/server/src/plugins/templates/**",
      "apps/server/src/http/routes/plugin-files.ts",
      "apps/server/src/http/routes/plugin-files.test.ts",
      "apps/web/app/components/plugins/code/**"
    ],
    "W3.5": [
      "apps/server/src/mcp/**",
      "apps/server/src/builtin-plugins/core-mcp/**",
      "apps/server/src/builtin-plugins/core-tools/**",
      "apps/server/src/http/routes/tools.ts",
      "apps/server/src/http/routes/tools.test.ts",
      "apps/server/src/http/routes/mcp.ts",
      "apps/server/src/http/routes/mcp.test.ts",
      "apps/web/app/components/plugins/mcp/**"
    ],
    "W3.6": ["e2e/specs/plugins/**", "e2e/fixtures/**"]
  }
}
```

### Wave W3 cross-agent contracts

Fixed in UI.md before launch (names, props, emits); consumers import by path.

| Component / endpoint | Owner | Used by |
|---|---|---|
| `components/plugins/code/PluginSourceTab.vue` | W3.4 | `pages/plugins/[id].vue` Source tab, code plugins only (W3.1) |
| `components/plugins/mcp/McpServersPanel.vue` | W3.5 | `pages/plugins/[id].vue` Overview of `core-mcp` (W3.1) |
| `components/plugins/code/CodePluginForm.vue` | W3.4 | `pages/plugins/new.vue` with `?type=code` (W3.3) |
| `components/plugins/install/InstallDialog.vue`, `TrustWarning.vue`, `TrustDialog.vue` | W3.2 | `InstallDialog`: one instance in `pages/plugins.vue`, opened by `ui.openInstall()` from the list page and `PluginsNav` "Install…" (W3.1); `TrustWarning` / `TrustDialog` also on the card and detail page of `untrusted` plugins |
| `PATCH /api/tools/:name`, `POST /api/mcp/:id/reconnect` | W3.5 | Overview tab tool and MCP rows (W3.1) |
| `plugin.log` SSE events | W1.3 host (read-only) | build panel (W3.4), Logs tab (W3.1) |
| host interface in `plugins/types.ts` | W1.3 (frozen) | install (W3.2), drafts (W3.3), scaffold/build (W3.4), MCP (W3.5) |
| mock OpenAI-compatible server fixture | W3.6 | only e2e; server tests start their own in-test servers |

## Gate W3

1. `node scripts/audit-ownership.mjs .tmp/waves/W3.json`
2. `pnpm install --frozen-lockfile` (if deps changed) → `pnpm check` → `pnpm build`.
3. `pnpm start:e2e` → `curl -sf :8899/api/health`, then:
   - `curl -s :8899/api/plugins | jq` → `core-providers`, `core-tools`, `core-commands`, `core-mcp`, `mock` active;
   - `curl -s :8899/api/tools | jq` → `current_time` and `web_fetch`; `curl -s :8899/api/mcp | jq` answers;
   - `POST /api/plugins/scaffold` (Tool template) → `GET /api/plugins/<id>/files` lists the files;
     `GET /api/plugins/<id>/files/..%2f..%2fpackage.json` → 400/404 envelope;
   - `curl -N` chat stream with `mock:echo` (as in the W2 gate) still streams.
4. `pnpm test:e2e --grep "@smoke|@plugins"` with the OS color scheme emulated as light, asserting `html.dark`.
5. Screenshots (dark + light) of `/plugins`, `/plugins/<id>` (every tab), every wizard step,
   `/plugins/new?type=code`, the install dialog, the trust warning and the MCP panel into `.tmp/gates/W3/`.
6. Update ROADMAP + wave log → checkpoint commit.
