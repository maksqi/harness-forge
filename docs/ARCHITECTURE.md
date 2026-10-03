# Architecture

harness-forge is a self-hosted, single-user, BYOK AI chat + agent harness. One Node process serves a JSON/SSE API
under `/api` and the prebuilt Nuxt SPA. LLM providers, models, tools, MCP servers and slash commands are all
contributed by plugins (builtin or user-installed).

Related docs: [API.md](./API.md) (every endpoint and DTO), [PLUGINS.md](./PLUGINS.md) (plugin contract),
[PROVIDERS.md](./PROVIDERS.md) (providers and model catalog), [UI.md](./UI.md) (web UI), [DECISIONS.md](./DECISIONS.md)
(ADRs and contract seed; wins on conflict).

## 1. System overview

```mermaid
flowchart LR
  subgraph Browser
    SPA["Nuxt 4 SPA<br/>(apps/web)"]
  end
  subgraph Server["Node process :8787 (apps/server)"]
    Static["Static SPA<br/>.output/public + 200.html"]
    API["Hono /api<br/>middleware + route modules"]
    Chat["chat/ pipeline<br/>AI SDK v7 streamText"]
    Host["plugins/ host<br/>builtin + user plugins"]
    Reg["registry/<br/>providers, models, tools, MCP, commands, hooks"]
    Cat["catalog/<br/>model catalog"]
    MCPM["mcp/ manager"]
    Svc["services/<br/>settings, secrets, chats, files, events, data, shares,<br/>images, audio, projects, keys, maintenance,<br/>checkpoints, shell-rules"]
    WS["workspace/<br/>path guard, file walker, shell runner,<br/>journal, file lock, git runner"]
    DB[("SQLite WAL<br/>data/harness.db")]
  end
  subgraph DataDir["HF_DATA_DIR (data/)"]
    Key["secret.key"]
    PDir["plugins/{id}/, plugins/.staging/"]
    Files["files/{aa}/{sha256}"]
    Ckpt["checkpoints/{aa}/{sha256}"]
    Cache["cache/ (models.dev refresh)"]
    WRoot["workspaces/ (default root)"]
  end
  Proj["Project folders<br/>(inside HF_WORKSPACE_ROOTS)"]
  LLM["LLM provider APIs<br/>(Anthropic, OpenAI, ..., Ollama)"]
  MCPS["MCP servers<br/>(stdio child processes, http, sse)"]
  MD["models.dev api.json"]

  SPA -- "fetch JSON, UI message stream (SSE),<br/>GET /api/events (SSE)" --> API
  Visitor["Share link visitor<br/>(no session)"] -- "GET /api/share/:token<br/>(public, rate-limited)" --> API
  SPA -- "GET / (assets)" --> Static
  API --> Chat
  API --> Svc
  API --> Host
  API --> Cat
  Chat --> Reg
  Chat --> Cat
  Host -- "ctx.*.register()" --> Reg
  Reg --> MCPM
  Chat -- "HTTPS (provider instances)" --> LLM
  Svc -- "generateImage, transcribe, generateSpeech" --> LLM
  Cat -- "live /models listing" --> LLM
  Cat -- "weekly refresh unless HF_OFFLINE=1" --> MD
  MCPM --> MCPS
  Chat -- "core-workspace tools" --> WS
  WS -- "files, bash -c (own process group),<br/>git (argument arrays)" --> Proj
  WS -- "before-states (Phase 8)" --> Ckpt
  Svc --> DB
  Cat --> DB
  Host --> DB
  Svc --> Key
  Svc --> Files
  Host --> PDir
  Cat --> Cache
```

Key properties:

- **One process, one port** in production (`HF_PORT`, default 8787). The SPA and the API share an origin, so the
  session cookie is `SameSite=Strict` and no CORS is configured.
- **The server owns all state**: chat history, settings, secrets, plugin state. The browser keeps only UI
  preferences (theme via `@nuxtjs/color-mode` key `hf-color-mode`, sidebar state, wizard drafts).
- **Everything pluggable goes through the registry.** Builtin features (the 13 providers, `current_time`,
  `web_fetch`, MCP servers, commands) are builtin plugins that use the same public SDK as user plugins (ADR-009).
- **The chat run is decoupled from the HTTP request**: a run survives client disconnects, can be resumed
  (`GET /api/chat/:id/stream`) and is stopped only by `POST /api/chat/:id/stop`.
- **Conversations are trees** (ADR-023): edits and regenerations add versions; the server keeps the chosen path
  (section 6.8).
- **Small public surface**: without a session only health, login, icons, the SPA files and the read-only share
  routes answer (section 10.1); share links serve sanitized snapshots, never live data (section 6.10).
- **Media through the user's own providers** (Phase 6): generated images are stored as files before they are streamed
  or saved, so no `data:` URL ever reaches the `messages` table (section 6.11); dictation and read-aloud pass audio and
  text through the server to the chosen provider and store nothing (sections 6.12, 10.8).
- **Agent workspace** (Phase 7): a chat can belong to a project folder inside the allowed roots; there the builtin
  `core-workspace` tools read, search and edit files through one path guard, and a shell runs approved commands in its
  own process group (sections 6.13, 10.9). The master key can be rotated (6.14) and orphaned files cleaned up (6.15).
- **Workspace 2.0** (Phase 8): every agent write to a project file is journaled with its previous state, so a chat's
  edits can be rewound or reverted file by file and every restore can be undone (6.16); a changes panel shows the
  chat's net changes and the project's Git status through one hardened git runner (6.17); the shell remembers its
  working folder between calls and runs commands that match the user's shell rules without asking (6.13, 6.2); an
  opt-in timer runs the orphaned-file cleanup (6.15).

## 2. Packages

| Package | Path | Responsibility | Depends on |
|---|---|---|---|
| `@harness-forge/shared` | `packages/shared` | zod DTO schemas + inferred types (including the plugin data shapes the API embeds: `PluginManifest`, `ModelInfo`, `CredentialField`, `SettingsSchema`, ...), enums, `HarnessError` class and error envelope, `apiRoutes` route table, `createApiClient`, chat message metadata and `data-*` part types, id helpers. Isomorphic (browser + Node), no Node built-ins. | `zod`, `ai` (types only) |
| `@harness-forge/plugin-sdk` | `packages/plugin-sdk` | The public plugin contract: runtime types (`PluginContext`, `ProviderDefinition`, `ToolDefinition`, `CommandDefinition`, `HookMap`, `PluginModule`, ...), `definePlugin`, `PLUGIN_API_VERSION`, `settingsValuesSchema()`, plus re-exports of the plugin data shapes and enums from `shared`. Type-only for plugin authors; runtime libraries reach plugins through `ctx`. | `shared`, `zod`, `ai`, `@ai-sdk/provider` |
| `@harness-forge/server` | `apps/server` | Hono app, security, SQLite via Drizzle, services, plugin host, registry, catalog, chat pipeline, MCP manager, builtin plugins, SPA static serving. | `shared`, `plugin-sdk`, AI SDK + providers, Hono, Drizzle |
| `@harness-forge/web` | `apps/web` | Nuxt 4 SPA (`ssr: false`): chat UI, Plugins tab, Settings, login. Talks to the server only through `createApiClient`, `useChat` (`DefaultChatTransport`) and `EventSource`. | `shared`, `plugin-sdk` (`settingsValuesSchema` for plugin settings forms), `ai`, `@ai-sdk/vue`, shadcn-vue, Pinia |

Rules: internal packages export TypeScript source (no build step); cross-package imports only by package name;
`plugin-sdk` depends on `shared`, never the reverse (no cycle): `shared` owns every JSON shape that crosses the HTTP
boundary and `plugin-sdk` re-exports the plugin data shapes (API.md 3.2).

## 3. Server layer map (`apps/server/src`)

| Path | Responsibility |
|---|---|
| `main.ts` | Process entry: dispatches the `rotate-key` CLI (Phase 7, 6.14) before anything boots; otherwise installs the signal handlers for graceful shutdown (before the boot starts, Phase 6 hotfix), then runs the boot sequence (section 5) with the key recovery and the `server.lock` hooks (Phase 7). |
| `env.ts` | Loads `<repo root>/.env`, parses and validates `HF_*` environment variables (zod) into a frozen `Env` object; resolves `HF_DATA_DIR` and `HF_WEB_DIR`; bind-safety check; Phase 7: the syntax of `HF_WORKSPACE_ROOTS` (`Env.workspaceRoots`, `workspaceRootsDefault`) and `HF_WORKSPACE_SHELL` (`Env.workspaceShell`), `DataPaths.workspaces`; Phase 8: `DataPaths.checkpoints` and the test-only `Env.testFileSweepDelayMs` (`HF_TEST_FILE_SWEEP_DELAY_MS`, honored only with `HF_MOCK_PROVIDER=1`, else ignored with a boot warning). |
| `deps.ts` | Composition root: `createDeps()` builds every service (eagerly, so a failing factory fails the boot), `startDeps()` / `stopDeps()` run the boot and shutdown steps (section 5; Phase 8: `checkpoints.start()` and `data.start()` last, `data.stop()` first). |
| `app.ts` | `createApp(deps)` app factory: mounts middleware and every route module under `/api`; used by `main.ts` and `createTestApp()`. |
| `paths.ts`, `logger.ts` | Package-relative locations (server package root, migrations, bundled assets, the SPA build, installed package versions); JSON-lines logger with redaction. |
| `http/middleware/` | Request id, structured access log (share tokens masked; it also runs the untrusted-proxy hint of `proxy-warning.ts`), secure headers + CSP, Origin check on non-GET, session auth, fresh auth (ADR-017), login rate limiter, body-size and content-type gate, the global error handler that renders `HarnessErrorEnvelope`; `request-info.ts` resolves the client address and scheme, trusting forwarded headers only from `HF_TRUST_PROXY` peers (section 10.6). |
| `http/routes/` | One Hono module per API area (`health`, `auth`, `settings`, `events`, `providers`, `credentials`, `models`, `icons`, `chats`, `chat`, `files`, `tools`, `mcp`, `commands`, `plugins`, `plugin-install`, `plugin-drafts`, `plugin-files`, `data`, `audio`, `shares`; Phase 7: `projects`, `keys`; Phase 8: `changes` (7 chat-scoped routes: changes, diff, git, revert, undo, rewind preview and apply; 6.16, 6.17) and `shell-rules` (3; 6.13)); thin: validate (`http/validate.ts` maps zod issues to `validation_error`), call services, map DTOs. `shares.ts` also serves the public `/share/:token` routes; `audio.ts` (Phase 6) parses the multipart recording of `POST /audio/transcriptions` itself and answers `POST /audio/speech` with audio bytes (section 6.12). |
| `http/static.ts` | Production SPA serving from `HF_WEB_DIR` (default `apps/web/.output/public`) with `200.html` fallback for client routes. |
| `security/` | `keyring.ts` (master key + HKDF subkeys; Phase 7: one frozen keyring whose key and `keyVersion` swap in place during a rotation, with the module-private controls `swapMasterKey`, `beginKeyChange`, `whenKeyStable`, 6.14), `password.ts` (scrypt), `session.ts` (HMAC session tokens + cookie), `headers.ts` (CSP/secure headers; Phase 6: `microphone=(self)` and the SPA's `media-src`, section 10.2), `ssrf.ts` (outbound URL guard), `redact.ts` (secret redactor for logs and errors; also masks share tokens), `proxy-trust.ts` (the `HF_TRUST_PROXY` matcher, section 10.6). Phase 8: `process-spawn.test.ts` fails when a non-test file other than `workspace/shell.ts`, `workspace/git.ts` and `mcp/stdio-transport.ts` imports `node:child_process`. |
| `db/` | Drizzle schema (`schema.ts`), libsql client, `migrate()` at boot, pragmas (WAL, foreign keys, busy timeout), transaction helper. |
| `services/settings/` | Typed global settings (defaults, validation, cache) over the `settings` table. |
| `services/secrets/` | Encrypted secret store (AES-256-GCM) over the `secrets` table: `get/set/delete/list(scope)`, masked hints, env fallback lookup. |
| `services/chats/` | Chat + message persistence, the message tree (`tree.ts`: active path, versions, latest leaf, the remembered leaf under a message; section 6.8), version switching, deleting a version (Phase 6), search, cursor pagination (`list.ts`: a row-value keyset cursor), export (md / json v2) and import (v1 / v2), usage rows and totals, title updates, `allIds` / `importChat` / `removeAll` for bulk data; Phase 7: `projectId` in records, summaries, search results and events, the project filter, the move of `update` (6.13), `approvals.ts` (`denyOpenApprovals`, used by the key rotation). |
| `services/data/` | Bulk data (ADR-024, section 6.9): summary, streamed zip export, import of a backup or a single chat, delete-all; Phase 7: the orphaned file cleanup (`cleanup.ts`: `cleanupPreview`, `cleanup`, `_files`; the reference scan in `references.ts`, 6.15). Imports, delete-all, cleanup and key rotation are serialized by `services/maintenance/`. Phase 8 (ADR-039): `start()` / `stop()` of the automatic sweep (`auto-sweep.ts`: `createAutoSweep`, the pure `nextSweepAt`), the loose plugin-data scan (`plugin-data-scan.ts`), `FileSweepStatus` in the summary and the preview; `references.ts` classifies every column of the new tables; delete-all also purges the checkpoint store. |
| `services/maintenance/` | `MaintenanceService` (Phase 7): `exclusive(kind, op, { blockRuns? })` runs one maintenance operation at a time (`import`, `delete-all`, `key-rotation`, `file-cleanup`; another one gets 409 `busy`), `current()`; while an operation with `blockRuns` (the key rotation) holds it, `POST /chat` answers 409 `busy`. |
| `services/keys/` | `KeyService` (Phase 7, ADR-034, section 6.14): `index.ts` (`status()` for `GET /keys`, read-only; `rotate()`, the online rotation), `rotate.ts` (the shared core `rotateSecretsTx` and the write-ahead `rotateWithKeyFile`), `check.ts` (the key check and `_keys`), `recover.ts` (the boot recovery `recoverKeyState`), `server-lock.ts` (`server.lock`) and `cli.ts` (the `rotate-key` CLI). |
| `services/checkpoints/` | `CheckpointService` (Phase 8, ADR-036 / ADR-037, sections 6.16, 6.17): `store.ts` (the content-addressed blob store `<dataDir>/checkpoints/`), `journal-service.ts` (`journal({ chatId, messageId, projectId })` for a run: the `workspace_changes` rows, `shell` / `untracked` rows, the coalesced `workspace.changed` events), `prune.ts` (age and budget eviction, orphan blobs, the 6-hour timer started by `start()`), `plan.ts` (the pure rewind / revert planner), `restore.ts` (per-file restore under the file lock), `rewind.ts`, `revert.ts`, `undo.ts`, `changes.ts` (`ChatChanges`, the chat diff), `git-changes.ts` (`GitStatus` and the HEAD diff over `workspace/git.ts`), `purge()` for delete-all. |
| `services/shell-rules/` | `ShellRuleService` (Phase 8, ADR-038, 6.13): rule CRUD over `shell_rules` (validation through the shared `parseShellRule`, 200 rules per scope, duplicates 409 `exists`) and `forRun(projectId)`, the global plus project rules a run matches against. |
| `services/projects/` | `ProjectService` (Phase 7, ADR-031, section 6.13): `roots.ts` (the allowed roots, checked first in `startDeps` by `start()`, and the folder checks), `index.ts` (project CRUD, the folder browser, `openWorkspace()`, `chatCount`, `project.changed`), `project-file.ts` (`AGENTS.md` / `CLAUDE.md` with its `@file.md` lines). |
| `workspace/` | The agent workspace (Phase 7, section 6.13): `paths.ts` (`resolveWorkspacePath` and the safe read / write helpers; frozen), `sensitive.ts` (secret-looking and hidden paths), `walk.ts` (the folder walker; `.gitignore` through `ignore`), `pattern-worker.ts` (globs through `picomatch` and regular expressions, matched in a killable Worker), `diff.ts` (diffs through `diff`), `trim.ts` (output caps), `text.ts`, `shell.ts` (the only shell runner: process groups, capped output; Phase 8: the working folder reported on fd 3, `killProcessGroup` exported) and `shell-env.ts` (the environment allowlist; Phase 8: empty and relative `PATH` entries dropped). Phase 8 (6.13, 6.16, 6.17): `run-scope.ts` (`bindRunScope` / `runScopeOf`: the server-only run scope bound to a tool call context), `file-lock.ts` (one promise chain per resolved path), `journal.ts` (`journaledWrite`: snapshot, write, journal row), `remove.ts` (the guarded unlink of a restore), `shell-cwd.ts` (`initialShellCwd(history)`, the clamp of the sticky folder) and `git.ts` (the hardened git runner; the only git spawn). |
| `services/shares/` | Share links (ADR-025, section 6.10): HMAC tokens, the allowlist sanitizer, snapshots, owner CRUD, the public view and file access, expiry, rate limits. |
| `services/files/` | Content-addressed upload store (`data/files/<aa>/<sha256>`), MIME/size validation, `files` rows, read streams; for bulk data `importFile` (deduplicated by sha256, keeps the preferred id when it is free) and `purge` (every row and blob); Phase 7: `sweep()` for the cleanup (`sweep.ts`), in-memory pins of fresh ids (`pins.ts`) and a shared / exclusive gate (`gate.ts`; 6.15); `saveGenerated` (Phase 6, rules in `generated.ts`) stores a generated raster image (PNG, JPEG, WebP or GIF whose magic bytes match its type, at most 20 MiB; a row with the same content and type is reused, and concurrent saves of the same bytes are serialized, section 6.11). Phase 8: `FileSweepInput.signal` (the automatic sweep aborts between batches); the store gate (`gate.ts`) is reused by the checkpoint store (6.16). |
| `services/images/` | `ImageService` (Phase 6, ADR-028, section 6.11): `generate()` runs `generateImage` with the provider's `imageParams`, writes the one usage row of a generation (`purpose: 'image'`), records the provider outcome and stores every image through `files.saveGenerated`; `generation.ts` holds the pure helpers (the checked `imageParams` result, token usage, estimated cost, revised prompt). Used by image turns and by `ctx.images` (the `generate_image` tool). |
| `services/audio/` | `AudioService` (Phase 6, ADR-029, section 6.12): `transcribe()` (type allowlist + magic-byte sniffing in `sniff.ts`, `transcribe()` of the AI SDK) and `speak()` (`generateSpeech()`); a usage row (`transcription` / `speech`) and the provider outcome only for a call that answers; one info log line per call; stores nothing. |
| `services/events/` | In-process event bus + SSE fan-out for `/api/events` (section 6.7); Phase 7: `disconnectAll()` (flushes queued events, then closes every stream; after a key rotation and a password change). |
| `registry/` | Typed registries for providers, models, tools, MCP server declarations, commands and hooks; every registration returns a `Disposable` and is tagged with its owner plugin id. |
| `plugins/host.ts` | Plugin host: discovery, load order, lifecycle state machine, enable/disable/reload, boot sentinel, safe mode. |
| `plugins/loader.ts` | Reads + validates `plugin.json`, checks id/dir/engines/trust, imports the entry module (cache-busted URL). |
| `plugins/context.ts` | Builds the per-plugin `PluginContext` (`ctx`): scoped logger, settings, secrets, storage, registries, hooks, `ai`, `fetch`, `signal`, and `images` (plugin API 1.1.0: `images.generate` through `ImageService`). |
| `plugins/guard.ts` | `guard(pluginId, fn, timeoutMs)`: timeouts, error capture into `plugin_error`, per-plugin log ring buffer, hook failure counters. |
| `plugins/declarative.ts` | Adapter that turns declarative `contributes.providers` into `ProviderDefinition`s (OpenAI-chat, OpenAI-responses, Anthropic, Google formats). |
| `plugins/compile.ts` | esbuild compile of `.ts` entries into one ESM file in `data/cache/plugins/<id>/` (SDK aliased to a shim), returns diagnostics. |
| `plugins/watch.ts` | `fs.watch` for linked folders or `HF_PLUGIN_WATCH=1`, 300 ms debounce, triggers reloads. |
| `plugins/state.ts` | Persistence of plugin rows (`plugins`, `plugin_settings`, `plugin_kv`), trust hashes, `loading_since`. |
| `plugins/install/` | Inspect + install from zip / npm / URL / folder into `plugins/.staging/<uuid>`, validation, review check (what was inspected is what gets installed), atomic swap, crash recovery of staging, export. `zip.ts` also provides `openZip()`, the lazy reader of data imports with the same guards (section 6.9). |
| `plugins/drafts/` | Declarative plugins created and edited in the browser (provider wizard): draft validation, SVG icon sanitizing, credentials saved as provider credentials, temporary-provider draft test. |
| `plugins/scaffold/` | Code plugins created from a template (`POST /plugins/scaffold`) and the traversal-safe files API: tree, read, atomic write, delete, build + reload, trust re-pinning of `created` plugins. |
| `plugins/templates/` | Template sources (tool, provider, MCP bridge, command pack): a JSDoc-typed `index.mjs` or a TypeScript `index.ts`, the vendored API types `harness-forge.d.ts` and a README. |
| `catalog/` | Model catalog: live listings with 24 h cache (`model_cache`), models.dev snapshot + weekly refresh, seeds, plugin models, custom ids, prefs, `classify()` (model kinds incl. `image`, `transcription`, `speech`; `imageOutput`), cost lookup (section 9). |
| `providers/` | Model resolution: `modelRef` -> provider -> credentials (stored or env) -> `LanguageModel` (`resolveModel`), and since Phase 6 image, transcription and speech models (`resolveImageModel`, `resolveTranscriptionModel`, `resolveSpeechModel`); provider test; provider status; error mapping to `HarnessError`; the LobeHub icon service (`/api/icons/lobe`). |
| `chat/` | Chat pipeline: runs registry (one active run per chat, stop, resume buffer), history assembly, approvals, slash commands, tool assembly, context trimming, titles, usage/cost, persistence; Phase 6: image turns (`images.ts`), generated-file storage for every run (`generated-files.ts`), the history carry-forward of generated images (`files.ts`), the run notices incl. `generated-file-dropped` (`notices.ts`); Phase 7: the project of a new chat, `openWorkspace` + the `workspace-unavailable` notice, the workspace tool filter and `ToolCallContext.workspace`, the `edits` approval mode, the instruction order with the workspace block and the project file, `projectMaxSteps` (6.13). Phase 8: binds the run scope (chat, assistant message id, journal, shell rules, sticky folder) to every tool call context and to policy contexts, records `shell` / `untracked` journal rows after each workspace call, ignores a stored `allow` override on `execute` tools, and says in the workspace block that `cd` persists (6.13, 6.16). |
| `mcp/` | MCP manager: one client per enabled server (`@ai-sdk/mcp`), status, reconnect with backoff, tool naming `mcp__<serverId>__<tool>`, hint -> policy mapping, close on disable; `{{settings.*}}` templating of plugin-declared servers; its own stdio transport (minimal environment, stderr lines in the owning plugin's log); the user-configured servers of the MCP panel (`mcp_servers`). Phase 8: `tools.ts` (`ToolService.update`) refuses `override: 'allow'` for tools with workspace access `execute` (400). |
| `builtin-plugins/index.ts` | Static list of builtin plugin modules, loaded first and trusted. |
| `builtin-plugins/core-providers/` | The 13 builtin providers (see PROVIDERS.md): definitions, seeds, reasoning mapping, error mapping; Phase 6 (version 1.1.0, `engines ^1.1.0`): the image, transcription and speech factories of OpenAI, xAI, Google, Mistral and Groq, `imageParams`, `transcriptionOptions` and the media seeds (`lib/media.ts`; PROVIDERS.md 13). |
| `builtin-plugins/core-tools/` | Builtin tools (version 1.2.0 since Phase 7, `engines ^1.2.0`): `current_time` (policy `safe`), `web_fetch` (policy `ask`, SSRF guard; setting "Allow localhost in web_fetch") and `generate_image` (Phase 6, `generate-image.ts`, policy `ask`, the `imageModelRef` setting; Phase 7: its output names the model with `modelName`; section 6.11). |
| `builtin-plugins/core-workspace/` | Phase 7 (ADR-032, version 1.0.0, `engines ^1.2.0`, permission `process`): the workspace tools `read_file`, `list_directory`, `find_files`, `search_files`, `write_file`, `edit_file` (one module each) and `shell` (`shell-tool.ts`; not on Windows, removed by `HF_WORKSPACE_SHELL=0`); `policies.ts` (the policy functions of the file tools), `common.ts` (guard timeouts, the model text helper); every tool declares its workspace access (section 6.13). Phase 8: `write_file` and `edit_file` write through `journaledWrite` (snapshot first; parallel edits of one file serialize), and `shell` gets the sticky working folder, the `shellPolicy` of the shell rules and the output fields `endCwd`, `cwdNote`, `allowedBy`. |
| `builtin-plugins/core-commands/` | Builtin server-side slash commands (prompt templates such as `/explain`, `/review`, `/commit`; list in PLUGINS.md). |
| `builtin-plugins/core-mcp/` | Owns the user-configured MCP servers (`mcp_servers` table): they are declared as its contributions, so disabling `core-mcp` closes them. Its settings (reconnect automatically, connect timeout) apply to every MCP server. |
| `builtin-plugins/mock/` | Dev-only `mock` provider (`HF_MOCK_PROVIDER=1`): `mock:echo`, `mock:reasoning`, `mock:tool-approval`, `mock:error` on `MockLanguageModelV4`, the Phase 6 media models `mock:image`, `mock:image-chat`, `mock:image-tool`, `mock:transcribe`, `mock:speech` (a PNG encoder and a silent WAV), plus the tool `mock_approval_tool`; Phase 7: `mock:workspace`, which walks through the workspace tools; Phase 8: `mock:checkpoint` (an edit per turn plus shell steps for rewind and the sticky folder) and `mock:shell` (runs the user text as one shell command) (behavior in PROVIDERS.md section 8). |
| `testing/` | In-process test harness: `createTestApp()` (real composition over an in-memory database) and fakes (Phase 6: `fake-media.ts` with fake image and audio services; the fake media resolvers live in `providers/testing.ts`, and `chat/testing.ts` has `createMediaTestApp()`; Phase 7: `fake-keyring.ts`, a deterministic, rotatable keyring). |
| `live/` | Opt-in live provider suite (`*.live.test.ts`, `pnpm test:live`, ADR-027): real provider calls with the keys in the environment; the image and voice checks only with `HF_LIVE_MEDIA=1`; excluded from `pnpm test` (PROVIDERS.md section 12). |
| `assets/catalog/models-dev.json` (package root) | Bundled models.dev snapshot (updated by `pnpm catalog:update`); read at runtime, so it ships next to `dist/` (section 11). |
| `drizzle/` (package root) | Generated SQL migrations, applied by `migrate()` at boot; ship next to `dist/`. |

Dependency direction (no cycles): `http/routes` -> `services`, `chat`, `catalog`, `providers`, `plugins`, `mcp` ->
`registry`, `db`, `security`. Plugin code never imports server modules; it only sees `ctx`.

## 4. Web app map (`apps/web/app`)

| Path | Responsibility |
|---|---|
| `app.vue`, `spa-loading-template.html` | Root component; dark-styled inline loading template (no light flash). |
| `assets/css/main.css` | Tailwind 4 entry + oklch design tokens (dark default, light) + fonts. |
| `layouts/` | App shell layout (sidebar + inset, settings variant; also mounts the Share dialog), the login layout and the public `share` layout (no sidebar); names and structure in UI.md. |
| `middleware/` | Route middleware: auth guard (redirect to `/login` when `AuthStatus.authenticated` is false); `/share/*` is exempt and never loads the auth status. |
| `plugins/` | `$api` plugin (`createApiClient` with a `fetch` wrapper: `unauthorized` -> `/login`), `events.client.ts` (`EventSource('/api/events')` -> store updates), `shortcuts.client.ts` (the single `keydown` listener of the shortcuts registry). |
| `pages/index.vue` | Empty state: greeting + composer; first send navigates to `/chat/:id`. |
| `pages/chat/[id].vue` | Chat transcript + composer for one chat (Phase 8: wrapped in `ChatWorkspace`, which adds the changes pane or sheet). |
| `pages/plugins.vue`, `pages/plugins/{index,new,[id]}.vue` | Parent route (hosts the single `InstallDialog`); plugin list (`?filter=`), new plugin (provider wizard / code template), plugin detail tabs. |
| `pages/settings/{providers,models,media,projects,general,appearance,data,about}.vue` | Settings pages (`/settings` redirects to providers); `media` = image model and voice (Phase 6); `projects` = the project list and the Add project dialog (Phase 7); `data` = backup, import, storage cleanup (Phase 7), shared links, the encryption key (Phase 7), delete-all. |
| `pages/share/[token].vue` | Public read-only share page (`share` layout): a store-free transcript of a share snapshot. |
| `pages/login.vue` | Password login. |
| `components/ui/` | shadcn-vue primitives (generated, frozen, no prefix). |
| `components/ai-elements/` | AI Elements Vue subset (copied, frozen, used with `Ai` prefix). |
| `components/app-shell/` | `AppSidebar`, `ChatNav` (Phase 7: the project switcher first), `PluginsNav`, `SettingsNav`, `ThemeToggle`, `CommandPalette` (Phase 7: a Projects section), `ShortcutsDialog` (Phase 6: a 56 px icon rail with 40 px targets on touch screens, UI.md 14.5). |
| `components/projects/`, `components/settings/projects/` | Phase 7 (UI.md 7.20, 9.10): `ProjectSwitcher`, `ProjectMenuItems`, `NewChatProjectPicker`, `ChatProjectChip`, `AddProjectDialog`, `FolderBrowser`, `ProjectInstructionsDialog`, `ProjectsSettings`, `ProjectMovedToast` (the "Moved to {name}" toast with Undo), `move-chat.ts` (`useMoveChat`), `folder-path.ts` (breadcrumbs of the folder browser), `projects-load.ts` (one quiet load of the projects for the chat UI). |
| `components/workspace/` | Phase 8 (UI.md 7.21 – 7.23): `ChatWorkspace` (the resizable pane next to the chat, the sheet below 1024 px, Alt+C), `changes/` (`ChangesToggle`, `ChangesPanel`, `ChangesFileRow`, `ChangesFileDiff`, `ChangesEmpty`, `RevertFileDialog`, `changes-rows.ts`), `rewind/RewindDialog`, `allowlist/` (`AllowRuleOption` on the shell approval card, `AllowlistEditor`, `AllowlistDialog`, `GlobalAllowlistSection`, `allow-rule.ts`). |
| `components/chat/parts/tools/` | Phase 7 (UI.md 7.19): the store-free registry `workspace-tools.ts` and the renderers `WorkspaceToolBody`, `DiffView`, `TerminalOutput`, `FileContent`, `FileList`, `ToolApprovalPreview`, `ToolRowSummary` (the `+12 −3` / `exit 1` summary of a row; all also used by the share page); `parts/tool-approval-context.ts` (the optional chat context of approval cards: tool mode, project name; Phase 8: project id, sticky shell folder). Phase 8: `ToolRuleBadge`, the spoken labels of row summaries, the sticky folder in `TerminalOutput`, the `DiffView` props `stats` / `lineNumbers`. |
| `components/chat/`, `components/chat/parts/`, `components/chat/composer/` | Transcript, message and part renderers (with the `BranchSwitcher` of message versions and the Delete-version action; Phase 6: `ImageGallery`, `GeneratingImages`, `ReadAloudButton`, the attachment chips of `MessageEditor`), composer (ModelPicker, EffortMenu, PermissionMenu, SlashMenu; Phase 6: `ImageOptionsMenu`, `MicButton`, `RecordingIndicator`). Pure Phase 6 helpers next to them: `chat-format.ts` (gallery blocks, the image-turn meta line), `attachment-toasts.ts` (the rejection toasts shared by the composer and the message editor), `parts/image-gallery.ts` (tiles, download links, placeholders), `parts/tool-row.ts` (the first argument of a tool row: the `generate_image` prompt), `composer/dictation.ts` (caret insertion, recorder type, clip name), `composer/image-options.ts` (the image options menu). |
| `components/plugins/*` | `list`, `detail`, `forms`, `install`, `wizard`, `code`, `mcp` component groups. |
| `components/share/` | `ShareDialog`, `SharesSettingsSection`, `SharedChatView`, `ShareToolRow`; the share page renders generated images as a gallery (Phase 6). |
| `components/settings/`, `components/settings/{data,media,images,voice}/`, `components/providers/`, `components/common/` | Settings forms (incl. the Data and Media pages; Phase 7: `data/EncryptionKeySection`, `RotateKeyDialog`, `StorageCleanupSection` and `data/data-context.ts`, which lets the sections reload the summary and Shared links after a cleanup or a rotation; `voice/voice-settings.ts`: the dictation languages, speeds, voice field rules and the Test voice text), `ProviderIcon`, shared pieces (`Markdown.vue`, empty states). |
| `composables/` | `useChatSession` (detached `useChat` registry), `useComposer*`, `useShortcuts`, `useGlobalShortcuts`, helpers; Phase 6: `useImageOptions`, `useVoiceInput` (dictation), `useSpeechPlayer` (the one read-aloud player), `useFreshAuth` (every password prompt; it replaced the three `fresh-auth.ts` helpers of `plugins/code`, `plugins/detail` and `share`, and the duplicate helpers of the data, install and MCP forms); Phase 8: `useChangesPanel` (the panel's open state, view and width in `localStorage`), `useChatSession` gains `cwd` and the shell rules of an approval. |
| `stores/` | Pinia stores `auth`, `chats` (Phase 7: the project filter), `providers`, `models`, `plugins`, `projects` (Phase 7), `settings`, `ui`, `workspace` and `shell-rules` (Phase 8: the changes panel data and the shell rules) (each `use<Name>Store`), implemented over the typed client and refreshed by `/api/events`. |
| `utils/` | Pure helpers (date grouping, formatting, `data-testid` constants, `speech-text.ts`: what read-aloud speaks; Phase 7: `line-diff.ts` for approval previews, `ansi.ts` for terminal output), test helpers (`utils/testing/`, incl. `fake-media.ts`). |

## 5. Boot sequence

```mermaid
sequenceDiagram
  autonumber
  participant Main as main.ts
  participant Env as env.ts
  participant DB as db/
  participant Deps as deps.ts
  participant Host as plugins/host
  participant Cat as catalog/
  participant MCP as mcp/
  participant HTTP as Hono + node-server
  Main->>Main: argv[2] = rotate-key -> run the offline rotation CLI instead of the server (6.14), then exit
  Main->>Env: load <repo root>/.env (variables already set win), parse HF_* (zod), fail fast on invalid values
  Env-->>Main: Env
  Main->>Main: bind check: non-loopback HF_HOST without HF_PASSWORD or HF_INSECURE=1 and no database yet -> exit 1
  Main->>Main: create the data dir (0700) and plugins/, plugins/.staging/, plugins/.data/, files/, cache/plugins/
  Main->>Main: write server.lock { pid, hostname, port, startedAt } atomically (0600), replacing a lock left by another process (Phase 7)
  Main->>DB: open data/harness.db (WAL, foreign_keys=ON, busy_timeout=5000), migrate()
  Main->>Main: recoverKeyState(): finish or drop an interrupted rotation (secret.key.next), load the master key (HF_MASTER_KEY or data/secret.key, generated 0600 on first boot), write _keys on the first v1.3 boot, keyVersion (Phase 7)
  Main->>Deps: createDeps(): keyring (at keyVersion) and every service
  Main->>Main: bind check again: a password stored in the database also allows a non-loopback bind (else exit 1)
  Main->>Deps: startDeps()
  Deps->>Deps: projects.start(): realpath and check HF_WORKSPACE_ROOTS, create the default root (0700) (Phase 7)
  Deps->>Deps: installer.recover(): restore an interrupted swap, clean plugins/.staging
  Deps->>Host: start(): builtins (static imports, trusted), then unless HF_SAFE_MODE=1 data/plugins/* + linked folders, sorted by id, each guarded
  Host-->>Deps: registry populated (providers, models, tools, MCP decls, commands, hooks)
  Deps->>Cat: start(): models.dev snapshot (bundled or data/cache refresh), model_cache
  Cat-)Cat: background: refresh stale listings (>24 h) and weekly models.dev (unless HF_OFFLINE=1)
  Deps->>MCP: start(): connect declared MCP servers in the background (never blocks boot)
  Deps->>Deps: checkpoints.start(): one prune (age, budget, orphan blobs, temp files), then every 6 h (Phase 8)
  Deps->>Deps: data.start(): the automatic file sweep timer, first check 24 h after boot (Phase 8, ADR-039)
  Main->>HTTP: createApp(deps): /api/*, plus the SPA with 200.html fallback when the web build exists
  HTTP-->>Main: listening on HF_HOST:HF_PORT
```

Notes:

- Boot fails (exit code 1, clear log line) on: invalid env (Phase 7: also an invalid `HF_WORKSPACE_ROOTS` syntax),
  non-loopback bind without a password (env or stored) or `HF_INSECURE=1`, unreadable/invalid master key (or a
  group/world readable `secret.key`), failed migration, a `secret.key.next` when neither it nor `secret.key` matches the
  stored key check (6.14), a workspace root that is missing, not a folder, not accessible, a filesystem root, the data
  dir or inside it (outside `<dataDir>/workspaces`; 6.13), a `server.lock` that cannot be written, a failing service
  factory. An existing `server.lock` never stops the boot: a stale one is replaced silently (debug log), one naming
  another live process on this host or a process on another host is replaced with a warning (two servers must not
  share a data directory). A broken **plugin** never fails boot: it ends in `error` or `incompatible` state and is
  reported in the Plugins tab. `unhandledRejection` and `uncaughtException` (typically from plugin code) are logged,
  never fatal.
- Boot sentinel: before loading a user plugin the host writes `plugins.loading_since = now`; after the load
  finishes it clears it. A row that still has `loading_since` at the next boot (the process crashed while loading
  it) is skipped and put into `error` with a "crashed during load" message until the user re-enables it.
- Staging recovery: a `plugins/.staging/<id>.prev-<uuid>` copy whose `plugins/<id>` directory is missing (crash in the
  middle of an atomic swap) is moved back; every other staging entry is deleted.
- MCP clients connect lazily in the background after their owning plugin is `active`; a failing MCP server never
  blocks boot.
- `HF_TRUST_PROXY` is parsed with the other variables: a boolean-like word, a hop count, a `/0` range, an unknown token
  or a list that names no proxy fails the boot like any invalid variable (`EnvError` on stderr with the format
  explained, exit code 1); when it is set, the boot log lists the trusted ranges (section 10.6).
- The first boot of v1.1 on a v1 data directory applies migration `0001`, which backfills a linear message tree for
  every existing chat (section 8, Migrations). The first boot of v1.2 on a v1.1 data directory applies `0002`, which
  records the active path of every chat as its remembered versions (`messages.selected_child_id`), and `0003`, which
  ages every successful cached model listing by one listing TTL (`fetched_at - 24 h`) so the v1.2 listing rules
  (media models, image output) apply at once: the first background cycle of the catalog (about 2 s after the start)
  lists every enabled provider with complete credentials again. Meanwhile, and after a failed refresh, the catalog keeps
  serving the cached listing as the last good one (section 9). The first boot of v1.3 on a v1.2 data directory applies
  `0004_projects` (table `projects`, `chats.project_id`, no backfill: every chat starts without a project) and writes
  `_keys = { version: 1, check, rotatedAt: null }` when the secrets table is empty or a row decrypts (6.14). The first
  boot of v1.4 on a v1.3 data directory applies `0005_workspace_checkpoints` (the tables `workspace_changes` and
  `shell_rules`, no change to an existing table): earlier agent edits have no checkpoints (a rewind to a message from
  before the upgrade has nothing to restore), no shell rule exists and `fileSweep` is `off`.
- Graceful shutdown (`SIGINT`/`SIGTERM`, `stopDeps()`): stop accepting connections, stop the automatic file sweep
  first (Phase 8, `data.stop()`: clears its timer and aborts a sweep in flight between batches), abort active runs
  (persisted as `aborted`; aborting a run kills its shell process groups and its git commands), dispose plugins (5 s
  guard each), close MCP clients (terminates stdio children), stop catalog timers and (Phase 8, `checkpoints.stop()`)
  the checkpoint prune timer, waiting for a running prune, close SSE streams, close the DB, then remove `server.lock`
  while it still names this process (Phase 7; a lock a newer server took over stays). A process-exit handler SIGKILLs
  any shell process group still alive, also when the server crashes (6.13). Every step runs even when an earlier one
  fails; a shutdown longer than 10 s exits with code 1, and a second signal exits immediately.
- The signal handlers are installed right after the logger, before the data directory, the database or any plugin
  (Phase 6 hotfix, `a5fd107`): `main.ts` keeps a boot state (database, deps, started, server, the current step,
  stopping). A signal during the boot waits for the running step (open, migrate, `startDeps`, listen), skips the rest,
  closes whatever was opened and exits 0; the log says `shutting down` with `phase: 'booting'` or `'listening'`, then
  `stopped`. `listening` is logged only once the handlers exist and the server is bound.

## 6. Flows

### 6.1 Chat send -> stream -> persist

The client keeps one `useChat` instance per open chat (`useChatSession(id)`), configured with
`transport: new DefaultChatTransport({ api: '/api/chat', prepareSendMessagesRequest })`,
`generateId: createMessageId` (from `shared`) and
`sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses`. `@ai-sdk/vue` 4 has no `resume` option
(React only), so `useChatSession` calls `resumeStream()` itself on mount when the chat has an active run
(`ChatSummary.running`, or a `run.started` event).
`prepareSendMessagesRequest` sends only the last message plus the composer state (`ChatRequestBody`, see API.md);
the server owns history. A new user message also carries `parentId` (the message before it on the path the user
sees, `null` for a first message); a regenerate carries `messageId` (section 6.8, ADR-023).

```mermaid
sequenceDiagram
  autonumber
  participant W as Web (useChat)
  participant R as POST /api/chat
  participant Runs as chat/runs
  participant P as chat/pipeline
  participant Prov as providers/
  participant DB as services/chats
  participant M as LLM provider
  participant Ev as events bus
  W->>R: ChatRequestBody (chatId, message, trigger, parentId?, messageId?, modelRef, reasoningEffort, toolMode, imageOptions?, projectId?)
  R->>R: zod validate (400 validation_error)
  alt a maintenance operation that blocks runs holds the lock (a key rotation, Phase 7)
    R-->>W: 409 conflict (reason busy)
  end
  R->>Runs: acquire(chatId)
  alt a run is active for chatId
    Runs-->>W: 409 conflict (reason run-active)
  end
  R->>DB: upsert chat (client uuidv7; projectId only when the request creates it, an unknown project is 404 before the row exists), save toolMode / reasoningEffort / modelRef
  R->>Prov: resolve(modelRef): provider, credentials (stored, then env), ModelInfo
  alt provider missing or required credentials absent
    Prov-->>W: 400 provider_not_configured (action configure-provider), run released
  end
  Note over R,Prov: an image model (kind image) goes to resolveImageModel and runs as an image turn (6.11)
  P->>DB: plan (kind new / regenerate / continuation): history = listPath(parent or target), supersede approvals on it, resolve the command, validate the message
  P->>P: openWorkspace for a chat-model run of a project chat that calls the model (6.13)
  P->>DB: commit in one transaction: superseded approvals, merged decisions or the new user message, the active leaf
  P-)Ev: run.started (chatId, messageId, modelRef)
  opt the chat has no title yet (title_source is null)
    P-)M: in parallel with the reply: generateText title (titleModelRef, else smallModelId, else chat model), 10 s timeout
    P->>DB: save title (fallback: first 60 chars), never overwrite a user title
    P-)Ev: chat.updated (id, title)
  end
  P->>P: file parts -> bytes, tools (registry + MCP, filtered; workspace tools only with an open folder), params + hooks
  P->>P: await convertToModelMessages(history, tools), hook chat.messages, trim to 85 percent of context
  P->>M: streamText(model, instructions, messages, tools, toolApproval, stopWhen isStepCount(maxSteps or projectMaxSteps), abortSignal run.signal)
  P->>P: result.consumeStream() so the run survives a client disconnect
  P->>P: createUIMessageStream: writer.merge(toUIMessageStream(result.stream) piped through storeGeneratedFiles)
  R-->>W: 200 createUIMessageStreamResponse(that stream) as SSE
  Note over R,Runs: consumeSseStream tees the SSE bytes into the run buffer for GET /api/chat/:id/stream
  M-->>W: start (metadata modelRef, startedAt), start-step, text / reasoning / tool chunks, finish-step ...
  Note over P,W: a generated file chunk (data: URL) is stored first and re-sent as /api/files/{id} (6.11)
  M-->>W: finish (metadata finishedAt, durationMs, reasoningMs, usage, costUsd, finishReason) then [DONE]
  P->>DB: onEnd persist: one transaction (upsert reply under its parent + CAS of the active leaf), usage row, updated_at, pending_approval
  P->>Prov: provider status update (connected / error)
  P->>Runs: release(chatId), drop the resume buffer
  P-)Ev: run.finished (chatId, messageId, outcome, awaitingApproval)
  P-)P: hook message.completed (guarded, background)
```

Notes:

- The assistant message id is generated by the server (`generateMessageId` = `createMessageId`, `msg_` + 16 chars).
  User message ids are generated by the client with the same `createMessageId` helper and validated by the server
  (format + uniqueness), so edits and regenerations can address them.
- History operations (the plan and commit steps of `chat/prepare.ts`; the message tree is described in 6.8). Every
  request is one of three kinds (`RequestKind`), and nothing is ever deleted:
  - **new** (`submit-message` with a new user message): the parent is `parentId`, or the chat's active leaf when the
    field is omitted (`null` = a new first message). An unknown parent -> `404 not_found`, an id already used ->
    `409 conflict` (`details.reason: 'exists'`). The history is the path from the root to that parent plus the new
    message. Pending approvals on that path (`approval-requested`, or `approval-responded` but never processed) are
    resolved as denied with reason `superseded`; approvals on other versions stay pending. The commit appends the user
    message and makes it the active leaf. An **edit** is a new request whose parent is the edited message's parent, so
    the edited message gets a sibling version.
  - **regenerate** (`regenerate-message`): the target is `messageId` or the active leaf. A user target is answered
    itself; an assistant target answers the previous message on its path, which must be a user message (else `400`,
    issue path `messageId`). Pending approvals on the path up to the answered message are superseded the same way; a
    `reply` command of the answered message runs again (a `prompt` command keeps its stored expansion). The active leaf
    becomes the answered message and the new reply becomes a sibling of the old one.
  - **continuation** (`submit-message` whose `message` is the active leaf, an assistant message with approval
    responses, see 6.2): only the approval decisions (`approval.id` -> `approved`, `reason`) are merged into the stored
    message; every other client-side change is ignored. Any other assistant message -> `404`; a continuation that
    answers no pending tool call -> `400`.
  - `messageId` on a user submit, or `parentId` on a regenerate or a continuation -> `400 validation_error` (the
    in-place edit of v1 was removed, ADR-023).
  - The commit writes the superseded approvals, the merged decisions or the new user message, and the active leaf in
    one transaction (a regenerate with nothing to supersede only moves the leaf). It sets the leaf unconditionally:
    version switches are refused while the run exists (6.3). Every failure before the commit is a normal JSON error
    response that leaves the history untouched (only the chat row may have been created).
- Persisting the reply (`onEnd`): one transaction upserts the assistant message under its reply parent (the new user
  message, the answered message, or the continued message's parent) and moves the active leaf to it with a
  compare-and-set that succeeds only while the leaf is still the reply parent or the reply itself, so nothing
  overwrites a leaf moved by someone else (the reply is then stored as a hidden version, a warning is logged and
  `pending_approval` is left alone). On a file database the transaction waits up to 5 s for a busy connection (section
  8). The usage row, `touch` and the provider outcome follow; `run.finished` is emitted only after all of that, so a
  client that refetches on it finds the reply on the active path. A run released by force (6.3) stores nothing and
  leaves the active leaf where the commit put it (the user message, or the continued message). Title generation,
  context trimming and notices work on the path.
- Slash commands (`/name args` at the start of a user text part, name registered in the commands registry): the
  user message keeps the original text and gets `metadata.command`; `prompt` commands replace the text sent to the
  model with the expansion; `reply` commands write the assistant reply with `createUIMessageStream` without a model
  call. Client-only commands (`/new`, `/model`, `/effort`, `/mode`, `/help`) never reach the server.
- Tool assembly: registry tools + connected MCP tools, filtered by `toolMode` (`off` = no tools), tool prefs
  (`enabled: false` removes the tool; an `override` only changes approval, see 6.2), and model capability
  `capabilities.tools` (no tools for models without it, with a `tools-unsupported` notice). Phase 7: tools that declare
  workspace access are offered only in chats whose project folder opened, `execute` tools only while
  `HF_WORKSPACE_SHELL` is on, and every tool of such a run gets `ToolCallContext.workspace` (6.13). Every tool is wrapped:
  owner-plugin-active check, `tool.before` / `tool.after` hooks, `guard()` timeout (default 60 s), output capped at
  64 KB (truncated with a marker).
- When a request sends no tools (tool mode `off`, a model without tool support, or no usable tool), earlier tool
  calls and results in the history are sent to the model as compact text (`[tool name(input) → ok: output]`,
  input ≤ 500 chars, output ≤ 2000) so providers that reject tool parts without tool definitions still work; the
  stored transcript is unchanged. The `tools-unsupported` notice appears at most once per chat and model.
- Errors after the stream started are sent as an `error` chunk whose `errorText` is the JSON envelope
  `{"error":{...HarnessErrorInit}}` and are persisted in `metadata.error` (see API.md, "Chat stream protocol").
- **What is saved equals what is streamed** (Phase 6, ADR-028). `toUIMessageStream`'s own `onEnd` builds the saved
  message from the chunks it produced itself, so a transform placed after it would change what the browser receives
  but not what is saved. Every chat-model run is therefore wrapped:
  `const ui = toUIMessageStream({ …, no onEnd })` and the response stream is `createUIMessageStream({ originalMessages:
  prepared.history, generateId: () => session.assistantId, onError, onEnd: session.onEnd, execute: ({ writer }) =>
  writer.merge(ui.pipeThrough(storeGeneratedFiles(session))) })`. The persistence of this section (`onEnd`) is
  unchanged; it now sees the transformed chunks. `storeGeneratedFiles` (`chat/generated-files.ts`) stores generated
  files, appends the images of the `generate_image` tool and rewrites the `finish` metadata when a tool cost was added
  (6.11). A model wrapper cannot do the swap: `streamText` turns every model-side file into a `data:` URL (and downloads
  `url` files). Image turns (6.11), reply commands and failures before the model call build their streams with
  `createUIMessageStream` and the same `session.onEnd` too, and the run's notices are injected right after the `start`
  chunk of every stream.
- Chat models with `capabilities.imageOutput` (Gemini `gemini-*-image` and `nano-banana*`, OpenRouter models whose
  listing reports image output) get the provider options of `definition.imageParams({ n: 1, aspectRatio, inputs: 0 },
  model)` as the base of the call's provider options (the aspect ratio of `imageOptions`; the reasoning options are
  deep-merged over them, then the `chat.params` hooks run; a throwing or invalid `imageParams` adds nothing); their
  image parts are stored like any generated file. `imageOptions` is refused (`400` on `['imageOptions']`) for a model
  that is neither an image model nor has `imageOutput`, and `n` / `editPrevious` for anything but an image model; an
  approval continuation sent with an image model is refused with `400` on `['modelRef']` (an image model cannot continue
  a tool call).
- History and generated images (`chat/files.ts` `prepareModelFiles`): most provider converters (Anthropic, OpenAI
  Responses, OpenRouter) drop images in assistant messages, so every `file` part of an assistant message becomes the
  text `[Generated image: <name>]` in place (`[Generated file: <name>]` for another type; the name falls back to
  `image` / `file`), so an assistant message never reaches a provider empty. For vision models the images of the most
  recent assistant message that has any (its latest 4) are also carried into the first user message after it, as data
  URLs placed before that message's own parts and introduced by the text part "(Images generated earlier in this
  chat:)"; nothing is carried when no user message follows. `reasoning-file` parts never go back to a model.

### 6.2 Tool approval round-trip

Approval is decided per tool call by the approval function passed to `streamText({ toolApproval })`. Approvals are
bound to the exact tool call by `experimental_toolApprovalSecret` (the HKDF `approval` subkey), so a modified
client cannot forge an approval for a different input.

Resolution order (first match wins), returning an AI SDK approval status:

| Step | Rule | Result |
|---|---|---|
| 1 | `tool_prefs.override` = `deny` / `allow` / `ask` (Phase 8: a stored `allow` on a tool with workspace access `execute` is ignored) | `denied` / `approved` / `user-approval` |
| 2 | `tool.approve` hook sets `decision` | `deny` -> `denied`, `allow` -> `approved`, `ask` -> `user-approval` |
| 3 | tool policy (static or function) returns `deny` (Phase 8: the `shell` policy is `shellPolicy`, below) | `denied` |
| 4 | chat `toolMode` = `ask`: policy `safe` | `not-applicable` (runs without a card) |
| 5 | chat `toolMode` = `ask`: policy `ask` or `always` | `user-approval` |
| 6 | chat `toolMode` = `edits` (Phase 7): policy `safe`, or policy `ask` with workspace access `write` | `not-applicable` |
| 7 | chat `toolMode` = `edits`: everything else (policy `ask` without workspace `write`, policy `always`) | `user-approval` |
| 8 | chat `toolMode` = `auto`: policy `always` | `user-approval` |
| 9 | chat `toolMode` = `auto`: policy `safe` or `ask` | `not-applicable` |

The approval function receives `ApprovalInput.workspace` (the tool's `ToolDefinition.workspace`, or null; any value
other than `read` or `write` counts as `execute`, `toolWorkspaceAccess`). A policy function gets the run's
`ToolCallContext.workspace` in its call context; the `tool.approve` hook input carries no project fields. A call to a
tool the run does not offer (a workspace tool without a workspace, a disabled tool) is denied as unavailable before
step 1. Without the `edits` rows the function's default branch would deny every call as "tools off". Accept edits is meant for project
chats: `write_file` and `edit_file` on ordinary paths run, while their policy function returns `always` for hidden or
secret paths, and `shell` (`ask`, access `execute`) always asks; in a chat without a project no workspace tool is
offered, so `edits` behaves like `ask`.

MCP tools derive their policy from annotations: `readOnlyHint` -> `safe`, `destructiveHint` -> `always`, otherwise
the server's configured `policy` (default `ask`). MCP tools never have workspace access, so they ask in `edits` mode
exactly as in `ask` mode.

**Shell rules** (Phase 8, ADR-038). The builtin `shell` tool has the policy function `shellPolicy`
(`core-workspace/shell-tool.ts`): it reads the run's rules through `runScopeOf(c)` (the global rules plus the
project's, loaded once per run by `shellRules.forRun(projectId)`, 6.13) and calls the shared `matchShellRules(command,
rules)` (`packages/shared/src/util/shell-command.ts`). It returns `safe` when every segment of the command (split on
`&&`, `||`, `;`, `|` and unquoted newlines) matches a rule or is a `cd` whose literal target resolves to a folder
inside the project (the policy resolves the `cdTargets` in order through the path guard, starting at the call's
folder), and `ask` otherwise, including every command the parser refuses (`$`, backticks, redirections other than
`N>&M` and to `/dev/null`, `( ) { }`, `&`, `|&`, here-docs and process substitution, unquoted globs, `~` / `#` words,
keywords, env-assignment prefixes, more than 32 segments; the parser fails closed). So in `ask` and `edits` a fully
matching command runs without a card (steps 4 and 6), `auto` is unchanged, `off` sends no tools, and an override
`deny` / `ask` or a `tool.approve` hook still decides first (steps 1 and 2). The matched prefixes are stored in the
output (`allowedBy`) so the UI can show why no card appeared. An `allow` override cannot be set on an `execute` tool
(`PATCH /tools/:name` answers 400 on `['override']`; `ToolService.update`), and one stored before v1.4 is ignored by
the approval function: the only way to skip the card for shell commands, short of Auto, is a rule. Rules apply only
to the core `shell` tool; a third-party `execute` tool always asks outside Auto.

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web (useChat)
  participant S as POST /api/chat
  participant P as chat/pipeline
  participant M as LLM provider
  W->>S: submit-message (user text)
  S->>P: streamText(..., toolApproval: approvalFn)
  M-->>P: tool call web_fetch(url)
  P->>P: approvalFn -> user-approval
  P-->>W: tool-input-available, tool-approval-request (approvalId), finish-step, finish
  P->>P: onEnd: persist message (part state approval-requested), chats.pending_approval = 1
  P-)W: event run.finished (awaitingApproval true), sidebar shows amber dot
  W->>U: AiConfirmation card "Allow web_fetch?" [Deny] [Allow] [x] Always allow web_fetch
  U->>W: Allow (optionally with Always allow checked)
  opt Always allow checked
    W->>S: PATCH /api/tools/web_fetch (override allow)
  end
  W->>W: addToolApprovalResponse({ id: approvalId, approved: true })
  Note over W: sendAutomaticallyWhen = lastAssistantMessageIsCompleteWithApprovalResponses is true
  W->>S: submit-message, message = last assistant message (part state approval-responded)
  S->>P: merge approval decisions by approval id into the stored message
  P->>P: verify approval signature, execute tool (guarded, hooks, 64 KB cap)
  P-->>W: tool-output-available, then the model continues in the same assistant message
  P->>P: onEnd: persist (isContinuation), pending_approval = 0
```

Deny path: `addToolApprovalResponse({ id, approved: false, reason })` -> continuation -> the SDK emits
`tool-output-denied`; the model is told the call was not approved. A new user message sent while approvals are
pending resolves the ones on its path as denied (`superseded`). Approvals pending on another version stay pending:
switching back to that version sets `chats.pending_approval` again, and the card works because the continuation
targets the active leaf (6.8). Only `user-approval` results show a card; `approved` and
`not-applicable` calls run directly, and automatic denials render as `output-denied` with
`approval.isAutomatic = true`. Phase 7: the web hides "Always allow" for tools with workspace access `execute`, and
for `write` tools it offers "Accept all edits in this chat", which switches the chat to `edits` before the
continuation (UI.md 7.3). A master-key rotation denies every open approval with "Expired after a key rotation." (the
approval signatures depend on the old `approval` subkey, 6.14). Phase 8: the shell card offers "Always allow commands
starting with …" instead; Run with it checked first creates the rules (`POST /api/shell-rules`, one per suggested
prefix), then sends the unchanged approval, so the continuation already matches them (UI.md 7.23).

### 6.3 Stop and resume

A run lives in the runs registry (`chat/`), keyed by chat id: `{ runId, chatId, messageId, abortController,
buffer, startedAt }`. At most one run per chat. The run's `AbortSignal` (not the request signal) is passed to
`streamText`, so closing the tab or reloading only drops the HTTP connection. The SSE bytes of the response are
teed into the run buffer by `consumeSseStream`; `GET /api/chat/:id/stream` replays the buffer from the start and
then follows live chunks.

Resume consistency rules (replayed chunks are applied on top of the client's last message, so they must never
overlap with persisted content):

- The in-flight assistant message is persisted only when the run ends (`onEnd`, including abort). While a run is
  active, `GET /api/chats/:id` returns the active path as the commit left it: it ends at the new user message, at the
  answered message of a regenerate, or at the continued message (whose merged approval decisions were persisted
  before streaming); the reply in flight is absent. Replaying the run from its first chunk on top of that path
  rebuilds the message exactly once.
- Version switches and version deletes (`POST /api/chats/:id/branch`, `DELETE /api/chats/:id/messages/:messageId`) are
  refused with `409 conflict` (`details.reason: 'run-active'`) while the runs registry holds the chat in any phase
  (`ChatRunner.hasRun`, including `preparing`), so neither races a commit or a persist.
- The resume endpoint returns `204` as soon as the run persists its reply (phase `finishing`), and the buffer is
  dropped when the run is released, so a replay never overlaps the persisted message. The web refetches a chat on
  `run.finished` unless its own `useChat` instance is streaming it, which covers a run that ends between loading the
  chat and resuming.

```mermaid
sequenceDiagram
  autonumber
  participant W as Web (useChat)
  participant C as /api/chat routes
  participant Runs as chat/runs
  participant P as chat/pipeline
  Note over W,P: Resume after reload or remount (useChatSession calls resumeStream when the chat has an active run)
  W->>C: GET /api/chat/:id/stream
  C->>Runs: get(chatId)
  alt no active run
    C-->>W: 204 No Content (useChat keeps persisted messages)
  else run active
    C-->>W: 200 SSE: replay the run from its first chunk, then live chunks until [DONE]
  end
  Note over W,P: Stop
  W->>C: POST /api/chat/:id/stop
  C->>Runs: abort(chatId)
  Runs->>P: abortController.abort()
  P-->>W: abort chunk, stream closes
  P->>P: onEnd (isAborted): persist partial message with metadata.aborted = true, usage so far
  P->>Runs: release(chatId)
  P-)W: event run.finished (outcome aborted)
  C-->>W: 200 { stopped: true }  (false when no run was active)
  W->>W: useChat stop() closes the local reader
```

Rules: the web calls `POST /api/chat/:id/stop` first and then `stop()` of `useChat` (a client-side abort alone is
only a disconnect). Stopping a chat without a run is a no-op (`{ stopped: false }`). `DELETE /api/chats/:id` stops
the run first. Server shutdown aborts every run through the same path. `stop` waits up to 15 s (5 s at shutdown) for
the run to persist; a run that does not settle is released by force: its late end callback stores nothing and, when
it was streaming, `run.finished` reports `aborted`. A run stopped while still `preparing` ends its request with
`409 conflict` (`details.reason: 'stale'`) before its history is committed (delete-all relies on this, 6.9).

### 6.4 Plugin lifecycle

States (`PluginState`): `disabled | untrusted | incompatible | loading | active | error`. The state is computed by
the host and reported in `PluginSummary.state`; `plugins.enabled` stores the user intent.

```mermaid
stateDiagram-v2
  [*] --> disabled: installed with enabled = false
  [*] --> loading: installed / boot with enabled = true
  disabled --> loading: enable
  loading --> incompatible: engines.harness not satisfied
  loading --> untrusted: code or stdio-MCP plugin and trusted_hash differs from sha256
  loading --> error: invalid manifest, setup() throws or times out (10 s), crashed during load
  loading --> active: setup() resolved, contributions registered
  untrusted --> loading: trust (pins sha256)
  incompatible --> loading: reload after update
  error --> loading: reload / enable
  active --> loading: reload or file change (hot reload)
  active --> disabled: disable (dispose, 5 s guard)
  untrusted --> disabled: disable
  incompatible --> disabled: disable
  error --> disabled: disable
  disabled --> [*]: uninstall
```

Runtime failures of an `active` plugin (a tool throws or times out, a hook fails) do not change its state: they are
returned as `plugin_error`, written to the plugin log ring buffer, and a hook handler that fails 5 times in a row is
disabled until the next reload.

Validation order in `loading` (PLUGINS.md 11): `plugin.json` readable (<= 256 KB, JSON) -> lenient pre-parse:
`engines.harness` satisfies `PLUGIN_API_VERSION` (else `incompatible`) -> strict manifest zod -> directory name
equals `id` and id not reserved -> realpath of `main` (and of a file `icon`) inside the plugin dir -> code plugins
and stdio MCP declarations require `trusted_hash == sha256(plugin.json + main)` (else `untrusted`) -> build or import
scan, import (cache-busted URL) or declarative adapter -> guarded `setup(ctx)` -> `active`.

Disable / reload / uninstall: guarded `dispose()` (5 s) -> the plugin's `DisposableStore` unregisters every
contribution (providers, models, tools, MCP servers, commands, hooks) -> MCP clients closed -> `ctx.signal`
aborted -> `plugin.changed` + `catalog.changed` events. In-flight calls to a disposed tool resolve as
"tool unavailable". Builtins cannot be uninstalled; `core-providers` can disable individual providers
(`PATCH /api/providers/:id`). Details: [PLUGINS.md](./PLUGINS.md).

### 6.5 Plugin install (staging + atomic swap)

```mermaid
sequenceDiagram
  autonumber
  participant W as Web (InstallDialog)
  participant I as plugins/install
  participant FS as data/plugins
  participant H as plugins/host
  participant DB as plugins table
  W->>I: POST /api/plugins/inspect (zip | npm | url | path)
  I->>FS: fetch / extract into plugins/.staging/{uuid} (size, entry, path guards)
  I->>I: validate manifest, compute sha256(plugin.json + main), contributions, hosts, secrets
  I->>FS: remove staging dir
  I-->>W: PluginInspection (warnings, requiresTrust)
  W->>W: user reviews, checks "I trust {source}" for code plugins
  W->>I: POST /api/plugins/install (same source, trust true)
  I->>FS: fetch / extract into plugins/.staging/{uuid} again, validate again
  alt validation fails
    I->>FS: delete staging dir
    I-->>W: 400 validation_error / plugin_error, nothing changed
  end
  alt the source now yields other files than the reviewed ones (moved npm tag, edited folder)
    I->>FS: delete staging dir
    I-->>W: 409 conflict (stale): inspect again
  end
  I->>I: requires trust (code or stdio MCP)? fresh auth when a password is set
  opt a previous version exists
    I->>FS: rename plugins/{id} to plugins/.staging/{id}.prev-{uuid} (kept until the new one is active)
    I->>H: disable old version (dispose)
  end
  I->>FS: rename .staging/{uuid} to plugins/{id} (atomic, same filesystem)
  I->>DB: upsert plugins row (source, source_ref, version, enabled, trusted_hash when trust = true)
  I->>H: load(id)
  alt new version reaches active (or a non-error state for a disabled or untrusted install)
    I->>FS: delete the .prev copy
  else new version fails to load
    I->>FS: restore the .prev copy, reload it
  end
  H-)W: event plugin.changed, catalog.changed
  I-->>W: 201 PluginDetail
```

Guards (all sources): zip <= 20 MB compressed, <= 100 MB expanded, <= 2000 entries; reject absolute paths, `..`,
drive letters, backslashes, symlinks; realpath of every extracted file inside the staging dir. npm: registry
metadata -> tarball -> verify `dist.integrity` (sha512) -> same guards, lifecycle scripts never run. URL: an
`integrity` value (`sha256-...` or `sha512-...`, SRI format) is required. Folder: `link` (used in place, watched,
trust pinned to the realpath) or `copy` (copied into staging, then the normal path). When a password is set,
installing a plugin that requires trust (code or stdio MCP, ADR-017) and trust changes require a login within the
last 10 minutes (fresh auth, section 10.1).

### 6.6 Provider credentials: test -> save -> validate -> model refresh

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web (key dialog)
  participant A as /api providers + credentials
  participant Sec as services/secrets
  participant Prov as providers/
  participant Cat as catalog/
  participant M as Provider API
  participant Ev as events bus
  U->>W: paste API key, optional base URL
  W->>A: POST /api/providers/:id/test { values }
  A->>Prov: validate(candidate values merged over stored values), 15 s timeout
  Prov->>M: provider.validate(): listModels, else 1-token ping on smallModelId
  M-->>Prov: ok / 401 / network error
  A-->>W: 200 ProviderTestResult { ok, latencyMs, modelCount?, error? } (nothing persisted)
  U->>W: Save
  W->>A: PUT /api/providers/:id/credentials { values }
  A->>Sec: secret fields -> AES-256-GCM in secrets (scope provider:{id}), other fields -> provider_configs.options
  A->>Prov: recompute status, clear last_error
  A-->>W: 200 ProviderSummary (credentials as set / hint / source, never values)
  A-)Ev: provider.changed
  A-)Prov: background validate() with stored credentials
  Prov->>Cat: refresh(providerId): live listing -> model_cache (keep last good on failure)
  Cat-)Ev: provider.changed (status, validatedAt, lastError), catalog.changed (providerId)
  Ev-)W: stores refetch providers and models, picker shows the new models
```

Credential resolution for a request: stored value (`secrets` / `provider_configs.options`) -> environment variable
named by `CredentialField.envVar` (for example `ANTHROPIC_API_KEY`) -> `CredentialField.default`. A provider whose
required fields resolve only from env reports status `env`. `DELETE /api/providers/:id/credentials` removes stored
values only; env fallbacks keep working.

### 6.7 `/api/events` SSE fan-out

```mermaid
sequenceDiagram
  autonumber
  participant Src as services / chat / plugins / catalog
  participant Bus as services/events
  participant C1 as SSE connection (tab 1)
  participant C2 as SSE connection (tab 2)
  C1->>Bus: GET /api/events (session required), subscribe
  C2->>Bus: GET /api/events, subscribe
  Src->>Bus: emit({ type: 'chat.updated', data })
  Bus->>Bus: stamp at = Date.now(), assign monotonically increasing id
  Bus-)C1: id: 42, event: chat.updated, data: ServerEvent JSON
  Bus-)C2: id: 42, event: chat.updated, data: ServerEvent JSON
  loop every 25 s
    Bus-)C1: ": ping" comment (keeps proxies from closing the stream)
  end
  C1-xBus: tab closed, unsubscribe on abort
```

- The bus is in-process (`EventEmitter`-like, typed by `ServerEvent`). Producers never block on slow consumers:
  each connection has a bounded queue (256 events); on overflow the connection is closed and the browser
  `EventSource` reconnects, then the web refetches its stores (it cannot know what it missed).
- Events are notifications, not the source of truth: every handler in the web refetches or patches the relevant
  store from the payload. No replay of missed events (`Last-Event-ID` is ignored).
- Event names and payloads: API.md, "Server events". Phase 7 adds `project.changed` (`{ id, project }`, `project` null
  = deleted; 6.13) and `key.rotated` (`{ keyVersion, rotatedAt, chatIds }`; 6.14); Phase 8 adds `workspace.changed`
  (`{ projectId, chatId, batchId, source, paths }`, 6.16: after every revert, rewind or undo batch that wrote
  something, and for agent edits at most once a second per chat). `disconnectAll()` flushes the queued
  events and then closes every connection: after a key rotation (`key.rotated` is the last event a stream sees) and
  after a password change, so a revoked session stops listening at once; the browsers reconnect with backoff, and a
  revoked one gets 401 and the login page.

### 6.8 Message tree and version switching (ADR-023)

The messages of a chat form a tree. `messages.parent_id` points at the previous message of the path (`null` for a
first message) and siblings share a parent: they are the **versions** of a message. `seq` stays unique per chat and is
the creation order, so a parent always has a lower `seq` than its children and the most recent leaf under a message is
the message with the highest `seq` in its subtree. `chats.active_leaf_id` is the last message of the path the user
sees (`null` for an empty chat).

```mermaid
flowchart LR
  A["user A (seq 0)"] --> RA["reply (seq 1)"] --> B["user B (seq 2)"] --> RB["reply (seq 3)"]
  A2["user A2, edit of A (seq 4)"] --> RA2["reply (seq 5)"]
  RA2 -.- L(["active leaf"])
```

Here A and A2 are siblings (both first messages). The active path is A2 -> reply, so `GET /api/chats/:id` returns
those two messages with `branches = { <A2>: { siblings: [<A>, <A2>], index: 1 } }`. Switching to A makes the path last
shown under A active again (Phase 6, remembered versions; here it ends at the reply at seq 3, which is also the latest
leaf under A), which brings back A -> reply -> B -> reply.

- **Reading**: `listPath(chatId, leafId)` walks up `parent_id` with a recursive query (guard `m.seq < path.seq`, so bad
  data cannot loop). `branches` comes from the pure helpers of `services/chats/tree.ts` (`pathTo`, `branchesOf`,
  `latestLeafUnder`, `resolveLeaf`, and since Phase 6 `rememberedLeafUnder`) over a light `(id, parent_id, seq, role,
  selected_child_id)` query: every path message with at least
  two versions maps to its siblings (`seq` order) and the index of the shown one. A stored leaf that is not a message
  of the chat falls back to its most recent message. `ChatDetail` has no `activeLeafId`: it always equals the id of the
  last message of `messages`, also during a run.
- **Writing**: `appendMessage(chatId, message, parentId)` (404 for a parent outside the chat, 409 for a used id),
  `upsertMessage(chatId, message, parentId)` (the parent is used on insert only) and `setActiveLeaf(chatId, leafId,
  onlyFrom?)` (compare-and-set). Only the commit and persist transactions of the pipeline (6.1), the switch route and
  the delete route move the active leaf.
- **Remembered versions** (Phase 6, ADR-030): `messages.selected_child_id` is the child last shown under a message, a
  hint without a foreign key. `rememberPathSql(chatId, leafId, when?)` (`services/chats/store.ts`) is the backfill of
  migration `0002` anchored on one leaf: one `UPDATE … FROM` over the recursive path of that leaf (the walk guarded by
  `parent.seq < child.seq` and the chat, and `messages.seq < path.seq` in the update, so only effective parents are
  written) that points each parent at its child on the path, skips rows that already do (`selected_child_id IS NOT
  path.id`) and writes nothing unless `when` holds (default: `leafId` is the chat's active leaf). Every write that moves
  the leaf records the path in the same atomic step and under the same condition: `setActiveLeaf` runs it with its
  compare-and-set condition before the move (one batch on the database, in order inside the pipeline's transactions),
  so both are written or neither and every commit and persist records the path it shows; `switchBranch`,
  `deleteMessage` and the import batch do the same. `rememberedLeafUnder(tree, messageId)` walks down from a message:
  the remembered child when it is still one of the node's children, else the only child, else `latestLeafUnder(node)`
  (a message without children is its own leaf; an unknown id → `null`). The pointer is not exported (chat export v2 and
  backups are unchanged; an import re-derives it from the active path) and share snapshots do not use it.
- **Switching** (`POST /api/chats/:id/branch { messageId }`, any message of the chat): 404 for an unknown chat or
  message; `409 conflict` (`details.reason: 'run-active'`) while a run holds the chat (6.3); otherwise the active leaf
  becomes `rememberedLeafUnder(messageId)` (Phase 6: the path last shown under that version; v1.1 took the latest
  leaf). The switch is one batch: the new path is remembered and the leaf moved under a compare-and-set against the
  leaf it read that also requires the new leaf to still exist (a version delete may have taken it). When that write
  misses, the reason is derived again: 404 when the chat or the message is gone, else `409 run-active` "The chat changed
  while switching versions. Wait until the reply finishes, then try again.". `pending_approval` is recomputed from the
  new path, `chat.updated` is emitted, `updated_at` stays (a switch is not activity), and the response is the new
  `ChatDetail`.
- **Deleting a version** (Phase 6, `DELETE /api/chats/:id/messages/:messageId` → `ChatDetail`): deletes one version and
  every message after it (its subtree). Answers: `404` "Chat <id> not found." / "Message <messageId> not found in chat
  <id>."; `409 conflict` "This is the only version of the message. Delete the chat instead." (`details.reason:
  'only-version'`) when the message has no sibling; `409 run-active` "A reply is already being generated for this chat.
  Stop it or wait until it finishes." while the runs registry holds the chat (checked by the route), and "The chat
  changed while deleting the version. Wait until the reply finishes, then try again." when a concurrent change made the
  guarded write miss (nothing is deleted then; the reason is derived again, so a vanished chat or message still answers
  404 and a message whose other versions were deleted meanwhile answers `only-version`). When the active path goes
  through the message, the new target is its previous sibling by `seq`, else the next one, and the new leaf is
  `rememberedLeafUnder(target)`; `pending_approval` is recomputed like a switch. One `db.batch` then holds
  `rememberPathSql` and the compare-and-set `UPDATE chats … WHERE active_leaf_id IS <old leaf>` (both also requiring
  that the message, another of its versions and the new leaf exist) and the recursive-CTE `DELETE` of the subtree
  (`deleteSubtreeSql`), which runs only when the leaf is the new one by then, the new leaf exists and another version
  exists. A version that is not on the active path is deleted by one guarded `DELETE` (the leaf is still the one read,
  another version exists) and the leaf does not move. The subtree walk carries planner hints (`CROSS JOIN` and `+c.seq`)
  so each step looks the children up in `messages_chat_parent_idx` (a 3,000-message subtree took 4.9 s without them and
  6 ms with them); a test asserts that query plan (`store.test.ts`). `chat.updated` follows every delete (also an
  off-path one, with the unchanged leaf). `updated_at`, usage rows (totals keep paying for deleted versions), share
  snapshots and files stay; `search_text` goes with the rows.
- **Other tabs**: `chat.updated` carries the chat summary plus `activeLeafId` (ADR-030) for every update, touch, title,
  switch and deletion. It is the stored `chats.active_leaf_id`, so it can be `null` or name a missing message while
  `GET /api/chats/:id` falls back to the newest message. An idle web session whose last stored message is not that leaf
  reloads the path (`followActiveLeaf()`, coalesced: at most one reload in flight, one more when another leaf arrives
  meanwhile); a leaf that the reloaded path still does not end at (null or dangling) is not followed again until a
  different leaf is announced (UI.md 11.1).
- **Clients**: the web sends `parentId` explicitly (the message before the new one on the path it shows), so a stale
  tab or a failed request cannot attach a message to a path the user did not see; an unknown parent answers 404 and
  the web reloads the chat, puts the unsent text back into the composer and says so in a toast (UI.md 11.1, 15). A
  user message whose request failed with an HTTP error was never stored, so the web never names it as a parent.
- **Search** covers every version, so a snippet may come from a hidden version. **Totals** (`ChatDetail.totals`) sum
  the chat's usage rows of purpose `chat` and (Phase 6) `image`, every version included, deleted ones too: the cost
  actually paid for replies and images (title rows are not counted; transcription and speech rows belong to no chat).
  The composer's chat cost sums the visible path only (UI.md 7.12).
- **Export and import**: JSON export v2 carries every version in `seq` order, `parentIds` aligned by index and
  `activeLeafId`; Markdown exports the active path. `POST /api/chats` and the data import (6.9) accept v1 (linear) and
  v2: each parent must be an earlier message and the ids unique (else 400 with the field path, e.g. `parentIds.1`), and
  the active leaf is the latest leaf under `activeLeafId` (or under the last message). Message ids are kept when they
  are valid and unused, else replaced; an import as a copy gets new ids throughout. Imported messages are
  deep-validated, streaming parts are finalized and pending approvals are resolved as denied (reason `imported`).
- Deleting a chat deletes every version; a single version is deleted with the route above.

### 6.9 Backup, import and delete-all (ADR-024)

Settings -> Data uses the four routes of `http/routes/data.ts` (API.md): `GET /api/data` (summary),
`GET /api/data/export?files&settings` (the backup), `POST /api/data/import` (multipart) and `POST /api/data/delete`
(fresh auth); Phase 7 adds the cleanup routes `GET` / `POST /api/data/cleanup` (6.15). `services/data/` implements them on top of `ChatsService` (`allIds`, `importChat`, `removeAll`),
`FilesService` (`importFile`, `purge`) and the settings service. There are no new event types: imports emit
`chat.created` and deletions `chat.deleted`, one per chat.

Zip layout, in write order (every entry mode 0644, mtime = `exportedAt`; JSON entries deflated):

```
settings.json          the public Settings (only when includes.settings)
chats/<chatId>.json    exactly GET /api/chats/:id/export?format=json (chat export v2), one per chat in id order,
                       archived chats included
files/<sha256>         each referenced blob once: stored for images and PDF, deflated for text/* (only when
                       includes.files)
files/index.json       BackupFileIndex { items: [{ id, sha256, name, mime, size, createdAt }] }: one item per file row
                       whose blob was written and still matched its sha256 (only when includes.files)
manifest.json          BackupManifest { format: 'harness-forge.backup', version: 1, exportedAt, appVersion,
                       chatExportVersion: 2, includes: { files, settings }, counts: { chats, messages, files,
                       fileBytes } } (written last)
```

A backup never contains secrets, credentials, the password, plugins, MCP servers, model or tool preferences, share
links or usage rows (the per-message `metadata.usage` survives, so `ChatDetail.totals` restarts at 0 after an import).

- **Export** is streamed: an fflate `Zip` with `ZipPassThrough` / `ZipDeflate` entries inside a pull-based
  `ReadableStream` (high-water mark 0, so nothing is read before the first pull); each pull pushes 64 KB pieces of a
  chat or chunks of a file until the zip emits bytes, so memory stays flat. `manifest.json` is written last so its
  counts are exact. fflate cannot write zip64, so a pre-check (database queries only, before anything is streamed)
  refuses a backup with more than 50,000 entries (`LIMITS.backupEntriesMax`, the import's cap; the referenced file rows
  count too) or an estimated size above 3.5 GiB with `413 payload_too_large`; the message suggests `files=false` only
  when the backup without attachments would fit. A zip that still outgrows the format while it is written (65,535
  entries or 4 GiB, because chats grew meanwhile) fails the stream instead of producing a broken archive. A chat
  deleted during the export is left out; a blob that is missing on disk or no longer matches its sha256 is left out of
  the index (the import reports it missing). A HEAD request gets the headers only: the stream is cancelled before
  anything is read.
- **Import**:
  1. the body limit is 256 MiB + 64 KiB (the upload itself at most 256 MiB, `LIMITS.backupImportBytes`); the route
     parses the multipart body itself (the part `file` plus the `DataImportForm` fields; unknown fields are refused),
     so the upload is not buffered twice; the first bytes decide: `PK` = a backup, `{` (after an optional BOM and
     whitespace) = a single chat JSON (v1 or v2, at most 64 MiB); anything else -> `400`;
  2. a zip is read lazily by `openZip()` in `plugins/install/zip.ts`, which reuses the plugin installer's guards:
     path traversal, symlinks, duplicate names, entry count (50,000), declared vs actual size, exact inflation, CRC,
     encryption, compression methods and overlapping entries; the declared sizes may add up to at most 8 GiB; a single
     top-level folder is accepted; unknown entries become warnings;
  3. the whole upload is refused (nothing is imported) for a structural guard failure, a missing, invalid or newer
     `manifest.json` or an invalid `files/index.json` (`400 validation_error`, `413` for the size caps), and, for a
     single chat JSON, for an invalid chat;
  4. then chats are imported one at a time in entry name order, each atomically through `chats.importChat`. A chat
     entry that is damaged (CRC or inflation mismatch), larger than 64 MiB (checked before inflating), not valid JSON
     or not a valid export (its tree included) fails only that chat. With `skip` a chat whose id exists is left alone
     (so running an import twice is idempotent), with `copy` it is imported with new ids and " (imported)" appended to
     its title; pinned, archived, dates and titles are restored;
  5. the files a chat references are imported first: each blob is re-hashed against the index and its type checked
     again (at most 20 MiB each); `files.importFile` dedupes by sha256 and keeps the original id when it is free;
     `/api/files/<id>` URLs in `file` and `reasoning-file` parts are rewritten to the resulting ids. A blob that is
     absent or unusable (hash mismatch, too large, a type that is not allowed) is replaced by a file already stored
     here under the same id (with the same sha256 when the index names it) when there is one; otherwise it counts in
     `filesMissing` with a warning, and its part keeps its URL;
  6. with `restoreSettings` (backup zips only), only known settings keys are applied, each validated on its own;
     unknown or invalid keys become warnings;
  7. the answer (`DataImportResult`) lists every chat with its status (`imported`, `copied`, `skipped` or `failed` with
     a message), the counts and at most 100 warnings; one failing chat never stops the others.
- **Delete-all** (`{ confirm: 'DELETE', files?, usage? }`): take the mutex -> `chats.allIds()` -> `runs.stop` for
  every id (this also covers runs that are still `preparing`) -> `chats.removeAll({ usage })` in one batch (share links
  cascade; usage rows are deleted or kept detached) -> optionally `files.purge()` (rows and blobs) -> stop any run whose
  chat appeared meanwhile. Settings, keys, plugins and (Phase 7) projects stay; the chats' project folders are never
  touched. Phase 8: the journal rows of the deleted chats go with them (foreign-key cascade) and `checkpoints.purge()`
  empties the checkpoint store inside the same maintenance operation; shell rules stay (they belong to projects).
- **Mutex**: one import or delete-all at a time per process; another one gets `409 conflict` with
  `details.reason: 'busy'`. Exports do not take it. Phase 7: the mutex moved into `services/maintenance/`
  (`exclusive('import' | 'delete-all', …)`), which also serializes the key rotation (6.14) and the file cleanup (6.15).
- **Projects**: backups and chat exports never carry `projectId` (projects are host-specific); imported chats have no
  project. Phase 8: checkpoints (`workspace_changes` and the blobs) and shell rules are never exported or imported
  either (host-specific; a crafted backup must not grant shell rights); the setting `fileSweep` is a public setting and
  is restored with `restoreSettings`.
- The zip is a portable backup of conversations. Moving a whole server (keys, plugins, settings) still means copying
  the data directory (section 7).

### 6.10 Share links (ADR-025)

A share is a `chat_shares` row holding a sanitized **snapshot** of a chat's active path, taken when the link is created
and again only when the owner asks ("Update snapshot", `PATCH /api/shares/:id { refresh: true }`). The public routes
never read live messages.

```mermaid
sequenceDiagram
  autonumber
  participant O as Owner (Share dialog)
  participant S as /api/shares (session, fresh auth)
  participant Sh as services/shares
  participant C as services/chats
  participant V as Visitor (/share/token page)
  participant P as /api/share/:token (public)
  O->>S: POST /api/shares { chatId, options, expiresAt }
  S->>Sh: create
  Sh->>C: get(chatId): the active path
  Sh->>Sh: allowlist sanitizer, collect file ids, size check (10 MiB)
  Sh->>Sh: insert chat_shares (snapshot, options, file_ids, message_count, snapshot_at)
  S-->>O: 201 ShareSummary { path: '/share/{token}' } (token recomputed, never stored)
  V->>P: GET /api/share/{token}
  P->>P: rate limits, parse the token, recompute the HMAC, timing-safe compare
  P->>Sh: row by share id, not expired, chat still exists
  P-->>V: 200 ShareView (file URLs /api/share/{token}/files/{id}), or the same 404 for every failure
```

- **Token** = the 16-char suffix of the share id (`shr_` + 16 chars) + the first 22 base64url chars of
  `HMAC-SHA256(keyring subkey 'share', 'harness-forge/share/v1:' + shareId)`, i.e. `^[0-9A-Za-z]{16}[\w-]{22}$`.
  Nothing token-like is stored: the owner's list recomputes it (the link can be copied again), revoking deletes the
  row, and a new master key invalidates every link. Verification recomputes the token from its id suffix and compares
  the whole string in constant time. Phase 7: the token signer caches the `share` subkey together with the keyring's
  `keyVersion`, so a master-key rotation changes every link at once (owners copy the new links; the old URLs answer
  404, 6.14).
- **Sanitizer (allowlist)**, applied when the snapshot is taken (`services/shares/snapshot.ts`): only the fields of the
  share DTOs are copied, so anything unknown (a new AI SDK part type, a new metadata field) is dropped rather than
  published. Kept are `user` and `assistant` messages with their text parts, `file` parts (app files `/api/files/<id>`,
  whose ids join `file_ids`, or data URLs of raster images: PNG, JPEG, GIF, WebP, AVIF, never SVG), http(s)
  `source-url` and `source-document` parts, reasoning text, tool parts (name, status `done` / `error` / `denied` /
  `stopped`, the input, the output and the error text), the model ref of a reply, the command name of a user message
  and a `stopped` / `failed` status. A tool input or output longer than 16,384 characters
  (`LIMITS.shareToolValueChars`; a value that is not a string is measured as its JSON text) becomes a string: the
  first characters of that text plus `\n[truncated]`, 16,384 characters in total; an error text is cut at 4096
  characters. Dropped: system messages, chat and global instructions, `metadata.error` (only the `failed` status
  remains), usage and cost, `command.expansion`, provider metadata, approvals, `data-*`, `step-start`,
  `reasoning-file` and `custom` parts, other URLs and anything unknown. A snapshot above 10 MiB (serialized) ->
  `413 payload_too_large`. `file_ids` stores the only files the share may serve.
- **Options** (`{ reasoning: false, toolDetails: false, attachments: true }` by default) are applied when the view is
  served: without `reasoning` the reasoning parts are left out, without `toolDetails` tool parts keep only their name
  and status, without `attachments` the file parts are left out and `shares.file` serves nothing. A changed option
  therefore applies to the share page at once, without a new snapshot (API.md, `shares.ts`); `refresh: true` takes a
  new snapshot of the current active path.
- **Freshness**: `ShareSummary.outdated` = the chat changed after the snapshot: `chats.updated_at > snapshot_at`, or
  the active path now holds another number of `user` and `assistant` messages than `message_count` (a version switch
  keeps `updated_at`, the count catches it). `snapshot_at` is taken before the chat is read, so a change that races the
  snapshot marks the share outdated instead of leaving it silently stale. `expired` = `expires_at <= now` (the link
  answers 404 until a `PATCH` moves or removes `expiresAt`). At most 20 links per chat (`400 validation_error` on
  `chatId`, checked under a lock); `expiresAt` must be in the future and at most 365 days ahead.
- **Owner routes** (`shares.list`, `shares.create`, `shares.update`, `shares.remove`) need a session; create and update
  also need fresh auth, because publishing a link turns brief session access into lasting remote access (ADR-017).
  There are no share events; the owner UI refetches.
- **Public routes** (`shares.view`, `shares.file`) are listed in 10.1 and protected as described in 10.7.
- Deleting a chat, or delete-all, removes its shares (`ON DELETE CASCADE`).

### 6.11 Image generation (ADR-028)

Three ways lead to an image, all through the user's own providers; each ends as `file` parts with `/api/files/<id>`
URLs, so the transcript, share links (6.10), backups (6.9) and history treat generated images like attachments. There
is no image route and no image table.

| Way | Model | What runs |
|---|---|---|
| Image turn | a dedicated image model (`kind: 'image'`, e.g. `openai:gpt-image-1`, `xai:grok-imagine-image`) picked in the composer | `chat/images.ts` `imageStream()` → `ImageService.generate()` → `generateImage()` |
| Image output of a chat model | a chat model with `capabilities.imageOutput` (Gemini `gemini-*-image` and `nano-banana*`, OpenRouter models whose listing reports image output) | the normal chat run (6.1) with `imageParams` provider options; `storeGeneratedFiles` stores the image parts |
| `generate_image` tool | the model of the `imageModelRef` setting (Settings → Media) | `core-tools` tool → `ctx.images.generate()` → `ImageService.generate()`; the pipeline appends the images after the tool call |

```mermaid
sequenceDiagram
  autonumber
  participant W as Web (useChat)
  participant P as chat/pipeline + chat/images.ts
  participant I as services/images
  participant F as services/files
  participant M as Image model (provider)
  W->>P: POST /api/chat (modelRef = an image model, imageOptions { n, aspectRatio?, editPrevious? })
  P->>P: resolveImageModel, prompt = the user text after slash expansion, input images (vision models: attached, or the parent reply's)
  P-->>W: start (metadata modelRef, startedAt, image { n, aspectRatio?, inputs }), start-step
  loop every 15 s until the images exist
    P-->>W: message-metadata (the start metadata again: keep-alive for proxies)
  end
  P->>I: generate({ resolved, prompt, inputFileIds, n, aspectRatio, signal: run.signal, chatId, messageId })
  I->>M: generateImage({ model, prompt, n, size? / aspectRatio?, providerOptions, maxRetries 1, abortSignal })
  M-->>I: images (bytes), usage, provider metadata
  I->>I: one usage row (purpose image, estimated costUsd), provider outcome ok
  I->>F: saveGenerated(each image): raster only, 20 MiB, magic bytes, dedupe
  P-->>W: file { url: /api/files/{id}, mediaType } per stored image (+ data-notice generated-file-dropped), finish-step, finish (usage, costUsd, image.revisedPrompt?)
  P->>P: onEnd persist (6.1): the reply holds only file parts with stored URLs
```

- **Image turns** (`chat/prepare.ts`): the catalog entry of the model decides: kind `image` →
  `providers.resolveImageModel(ref)`, anything else → `resolveModel`, which refuses image models (`validation_error` on
  `modelRef`: "The model "<ref>" is an image model: it answers image turns only."); an unknown provider is
  `provider_not_configured` for both. `PreparedRun.resolved` is a `ResolvedModelBase` plus `target: { kind: 'chat',
  model, aspectRatio? } | { kind: 'image', model, options }`. The prompt is the text of the answered user message after
  slash-command expansion (text parts joined and trimmed; `400` on `['message', 'parts']` when empty or longer than
  32,000 characters, `LIMITS.imagePromptMaxChars`, unless a reply command writes the reply). Input images need an image
  model with `vision`: the raster images (PNG, JPEG, WebP, GIF) attached to the message, at most 4
  (`LIMITS.imageInputsMax`); else, when none are attached and `editPrevious !== false`, the generated images of the
  parent assistant reply that are still stored (its latest 4). Attachments that are not sent (other types, images
  beyond 4, any image for a model without `vision`) produce the `attachments-unsupported` notice when the message is
  new. `n` defaults to 1. An image turn sends no history; a regenerate takes its input images from the same parent reply
  (the message before the answered user message); an approval continuation never runs on an image model (`400` on
  `['modelRef']`). The chat title of an image
  turn comes from `titleModelRef`, else the provider's `smallModelId`, else the default title stays (the image model
  is never asked).
- **The stream** (`imageStream(session)`) is built with `createUIMessageStream({ originalMessages, generateId: () =>
  assistantId, execute, onError, onEnd: session.onEnd })`, so persistence, `run.finished`, resume and Stop work as for
  chat runs: `start` (metadata with `image: { n, aspectRatio?, inputs }`), `start-step`, a `message-metadata`
  keep-alive with the same metadata every 15 s (`ChatRunnerOptions.imageKeepAliveMs`), one `file` chunk per stored
  image, a `data-notice` (`generated-file-dropped`) when images were refused, `finish-step`, `finish` (`finishReason:
  'stop'`; metadata `usage`, `costUsd?`, `image.revisedPrompt?`). A failure is `recordFatal` + an `error` chunk
  (persisted in `metadata.error`); Stop is an `abort` chunk and the reply is saved with `aborted: true`; a failed or
  stopped turn keeps `metadata.image` and `finishedAt` but holds no file (the web stops its placeholders on
  `finishedAt`, an error or `aborted`). A resume replays the buffer, which holds URLs only, and the `start` metadata
  tells the web how many placeholders to draw. Regenerate adds a version like any reply (6.8). The pipeline writes no
  usage row and records no provider outcome for an image turn: the service does both.
- **`ImageService.generate(input)`** (`services/images/`) → `{ modelRef, modelName, images: { file, url }[], usage,
  costUsd | null, revisedPrompt?, dropped }` (`modelName` since Phase 7: the catalog display name, where the user's
  alias wins, else the model id; trimmed, at most 200 characters):
  1. checks the input (a prompt of 1–32,000 characters after trimming, `n` 1–4, a known aspect ratio, at most 4 input
     files; `validation_error`);
  2. takes the model from `input.resolved` (image turns), else `resolveImageModel(input.modelRef ??
     settings.imageModelRef)`; neither → `validation_error` "Choose an image model in Settings → Media.";
  3. reads the input images from `files` (`not_found`; a file that is not a raster image → `validation_error`);
  4. maps the request with `definition.imageParams({ n, aspectRatio, inputs }, model)` (OpenAI `size`: 1:1 →
     1024x1024, portrait → 1024x1536, landscape → 1536x1024, Auto → none; details in PROVIDERS.md 13), whose result is
     checked like plugin data (`size` as `WxH`, `aspectRatio` as `W:H`, provider options as an object of objects; a
     throw adds nothing); a provider without `imageParams` gets the aspect ratio as is;
  5. runs `generateImage()` with the caller's signal and `maxRetries: 1` (each try may be billed): an abort rejects with
     the signal's reason and records no provider outcome; a result without an image is `provider_error` "<Provider>
     returned no image." (action `retry`); other failures go through `providers.mapError`, and provider failures are
     recorded as the provider's outcome;
  6. once the provider answered, writes exactly one usage row (`purpose: 'image'`, `chats.addUsage`, the input's
     `chatId` / `messageId`), even when the caller stopped meanwhile (the call was billed; the caller then gets the
     abort and nothing is stored), records the provider as working and stores every image, in the provider's order,
     through `files.saveGenerated` (named `image-<n>.<ext>`): an image that is refused (type, size, bytes) or cannot be
     decoded counts in `dropped`, any other storage error fails the call (`internal_error`), and `images` may be empty.

  `costUsd` = (input tokens × `cost.input` + output tokens × `cost.output`) / 1,000,000, rounded to 1e-10: `null`
  without a catalog price, when the provider reports no input or output token count (xAI; a total alone does not
  count) or when a used token kind has no price; the web labels it "estimated". `revisedPrompt` is the first
  `revisedPrompt` of the per-image provider metadata (trimmed, at most 32,000 characters).
- **`files.saveGenerated({ data, mediaType, name })`** (`services/files/generated.ts`): the canonical type (parameters
  dropped, `image/jpg` read as `image/jpeg`) must be one of `GENERATED_IMAGE_MIME_TYPES` (PNG, JPEG, WebP, GIF; else
  `validation_error` on `mediaType`), the bytes at most `LIMITS.generatedImageBytes` (20 MiB, the upload cap, so a
  backup restores every generated image; else `payload_too_large` with `details.limitBytes`) and their magic bytes must
  match the type (else `validation_error` on `data`). The name is sanitized like an upload name (the extension of the
  type added when it has none). A row with the same sha256 and type is returned as it is (its id and name are reused,
  for example an earlier upload's; its blob is written again when missing), else a new row is inserted; saves of the
  same bytes are serialized, so concurrent saves give one row.
- **Generated files of chat runs** (`storeGeneratedFiles`, 6.1): a `file` or `reasoning-file` chunk with a base64
  `data:` URL is stored through `saveGenerated` (named `image-<n>.<ext>`, numbered after the files a continued message
  already holds) and re-sent with the stored URL, keeping `providerMetadata` (Gemini thought signatures); anything that
  is not an allowed raster image, is too large or refused, or has no `data:` URL (another URL is never followed) is
  dropped and replaced by an inline `data-notice` with code `generated-file-dropped`. `finalMessage()` adds the file
  name to the saved part (a UI `file` chunk cannot carry it: the name of the stored row, which is an earlier file's
  when the same bytes were stored before) and drops any leftover `data:` part. **No base64 ever reaches the `messages`
  table.**
- **`ctx.images.generate({ prompt, modelRef?, n?, aspectRatio?, chatId?, signal? })`** (plugin API 1.1.0,
  `plugins/context.ts`): the options are checked (`validation_error`), `n` defaults to 1, and the call goes to
  `ImageService.generate` with `messageId: null` and a signal that both `ctx.signal` and `signal` abort; the result
  lists `{ fileId, url, mediaType, name, size }` per image (`costUsd` omitted when unknown) and, since plugin API 1.2.0,
  `modelName`. When every image was
  dropped it fails with `provider_error` "The image model returned no image that could be stored: only PNG, JPEG, WebP
  and GIF images of at most 20 MB are kept." `ctx.ai` has no `generateImage` (plugins could not store images or record
  usage with it).
- **The `generate_image` tool** (`core-tools/generate-image.ts`, policy `ask`, timeout 300 s, always registered): input
  `{ prompt, n?, aspectRatio? }`, execute = `ctx.images.generate({ ...input, chatId, signal })`, output `{ modelRef,
  images: [{ fileId, url, mediaType, name }], costUsd?, revisedPrompt? }` (file references; `revisedPrompt` is capped at
  16 KB of JSON, so the output stays far below the 64 KB tool output cap, whose truncation would make it unparsable);
  `toModelOutput` is text only: "Generated 2 images with <model ref>; they are shown to the user below this call." (one
  image: "Generated 1 image with <model ref>; it is shown to the user below this call."; the output carries the model
  ref; Phase 7: the output also carries `modelName`, the catalog display name, else the model id, and the text names
  `modelName ?? modelRef`, so outputs saved before v1.3 keep their text). When the final `tool-output-available` of
  `generate_image` comes from `core-tools` and
  parses with `generateImageToolOutputSchema`, `storeGeneratedFiles` appends one `file` chunk per image whose URL is
  `/api/files/<fileId>` of a stored raster image, and adds the tool's `costUsd` to the message cost (a `toolCallId →
  toolName` map, seeded from the continued message, covers approval continuations). A tool of the same name from
  another plugin never injects files. Without `imageModelRef` the tool fails with "Choose an image model in Settings →
  Media.".
- **Usage and totals**: every generation writes one usage row (with the chat id for image turns and the tool); image
  rows count in `ChatDetail.totals` (the `chat` and `image` purposes); message metadata carries the turn's `usage` and
  `costUsd`, and a tool's cost is added to the cost of its reply.
- **Visibility**: an image model is listed only when its provider defines `createImageModel` (OpenAI, xAI and the mock
  provider; section 9), and it is then visible in the composer's "Image models" group; Gemini images come from chat
  models with image output (Google defines no image factory); declarative providers cannot generate images (backlog).
- **Disk**: generated images live in `data/files/` like uploads; they are removed by delete-all with files, or by the
  manual storage cleanup once nothing references them (Phase 7, 6.15), not when a chat or a version is deleted.
- **Unknown provider** (Phase 7, ADR-028 consequence): a model ref whose provider does not exist (an uninstalled
  plugin) is `400 provider_not_configured` with action `configure-provider` on the media routes, in `ctx.images` and
  `generate_image`, and in `ctx.ai` / `ctx.models.resolve`, as on chat (v1.2 answered `404 not_found` there): every
  resolver says 'The provider "<id>" is not available. Pick another model or install the provider.'. Routes that name a
  provider directly rather than resolving a model ref keep `404 not_found`: `GET /models?providerId=<unknown>` and
  `POST /providers/<unknown>/models/refresh`.

### 6.12 Voice: dictation and read-aloud (ADR-029)

Both features are opt-in: dictation needs `transcriptionModelRef`, read-aloud `speechModelRef` (Settings → Media). The
browser never transcribes or synthesizes speech itself (browser recognition would send audio to a third party and break
bring-your-own-key).

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser (MediaRecorder / HTMLAudioElement)
  participant A as /api/audio (session + Origin check)
  participant S as services/audio
  participant M as Provider model
  B->>A: POST /api/audio/transcriptions (multipart: file = the recording, modelRef?, language?)
  A->>S: transcribe({ file, form, signal: request signal })
  S->>S: size, type allowlist + magic bytes, model = form.modelRef ?? transcriptionModelRef, language hints
  S->>M: transcribe({ model, audio, providerOptions, maxRetries 1, abortSignal }) within 120 s
  M-->>S: { text, language, durationInSeconds }
  S-->>B: 200 AudioTranscription { text, language, durationSec, modelRef } (text trimmed, '' = no speech; no-store)
  B->>A: POST /api/audio/speech { text up to 4096, modelRef?, voice? } (one sentence chunk)
  A->>S: speak({ text, modelRef?, voice?, signal: request signal })
  S->>M: generateSpeech({ model, text, voice, maxRetries 1, abortSignal }) within 60 s
  M-->>B: 200 audio bytes (allowlisted Content-Type, Content-Length, Cache-Control no-store, nosniff)
```

- **Routes** (`http/routes/audio.ts`, module `audio`): `audio.transcribe` and `audio.speech` need a session and pass the
  Origin check; neither needs fresh auth (they run no code and create nothing lasting). Provider errors go through
  `providers.mapError` and `recordOutcome` (the provider status in Settings → Providers).
- **Transcription input**: the route reads the multipart body itself (like the data import): a body that is not
  `multipart/form-data` → `400`; exactly one `file` part ("Send exactly one recording.", "Attach the recording in the
  part named "file".", a text part named `file` or a file in another field → `400`) plus the `AudioTranscribeForm`
  fields (`modelRef`, `language`; an unknown field → "Unknown field "x".", a repeated one → "The field "x" is sent more
  than once."). The service then checks, in order: more than 25 MiB (`LIMITS.audioUploadBytes`) → `413` "Recordings
  are limited to 25 MB." (`details.limitBytes`; above 25 MiB + 64 KiB the body limit answers first); fewer than 64
  bytes → `400` "The recording is empty."; the type. Accepted declared types, parameters stripped and lowercased:
  `audio/webm` (+ `video/webm`), `audio/ogg`, `audio/mp4` (+ `audio/x-m4a`, `video/mp4`), `audio/mpeg` (+ `audio/mp3`),
  `audio/wav` (+ `audio/x-wav`, `audio/wave`), `audio/flac` (+ `audio/x-flac`); `application/octet-stream` or a part
  without a type (an untyped `Blob`) lets the bytes decide; a multipart file part without a `Content-Type` header is
  parsed as `text/plain` and refused. Any other type → `400` "The type X is not accepted: send a WebM, Ogg, MP4, MP3,
  WAV or FLAC recording."; a declared type the bytes do not match → "The recording does not match its type (X)."; bytes
  of no accepted format (octet-stream) → "The recording is not in a supported format: …". The magic bytes
  (`services/audio/sniff.ts`):

  | Type | Recognized by |
  |---|---|
  | WebM | an EBML header (`1A 45 DF A3`) whose DocType element, read within the first 1 KiB, is `webm` (Matroska files say `matroska` and are refused) |
  | Ogg | `OggS` |
  | MP4 | an `ftyp` box none of whose brands (major and compatible) is an image brand (AVIF, HEIF / HEIC, MIAF, Canon raw share the container) |
  | MP3 | an ID3v2 tag (unless FLAC or an AAC ADTS frame follows it), or an MPEG audio frame header (frame sync, layer I–III, a usable bitrate and sample rate); AAC ADTS frames are refused |
  | WAV | `RIFF` … `WAVE` |
  | FLAC | `fLaC`, also after an ID3v2 tag |

  This checking applies to this route only: chat uploads keep their own rules. The server does not parse durations;
  the web stops at 10 minutes.
- **Transcription**: model = `form.modelRef ?? settings.transcriptionModelRef` (neither → `400` "Choose a
  speech-to-text model in Settings → Media."; an empty field is a `400`, an omitted one falls back to the settings).
  Language = `form.language ?? settings.transcriptionLanguage`; `auto` sends nothing, a code goes through the provider's
  `transcriptionOptions` hook (`openai.language`, `google.languageCodes`, `xai.language`, `mistral.language`,
  `groq.language`; a throwing hook or an invalid result sends no hint). The call runs in `withTimeout(120 s, …,
  c.req.raw.signal)` with `maxRetries: 1` (a timeout is `provider_unreachable`). The text is trimmed;
  `NoTranscriptGeneratedError` → `200` with `text: ''`. The response carries `Cache-Control: no-store`.
- **Speech**: `AudioSpeechBody` (`text` 1–4,096 characters, trimmed; `modelRef?`, `voice?`); the model and the voice
  come from the settings unless the body names them (no model → `400` "Choose a read-aloud model in Settings →
  Media."; voice = `voice ?? speechVoice`, so a client cannot ask for the provider default while `speechVoice` is set;
  both null = the provider default). Nothing but the text and the voice reaches the provider: `outputFormat`, `speed`,
  `instructions` and `language` are never passed (unsupported options make the SDK print warnings); the playback speed
  is applied by the browser. 60 s timeout, `maxRetries: 1`. The reported audio type is normalized (`audio/mp3` →
  `audio/mpeg`, `audio/x-wav` / `audio/wave` → `audio/wav`, `audio/x-flac` → `audio/flac`, `audio/x-m4a` →
  `audio/mp4`) and must be one of `SPEECH_AUDIO_MIME_TYPES` (`audio/mpeg`, `wav`, `ogg`, `webm`, `mp4`, `aac`, `flac`),
  else `502 provider_error` "<Provider> returned audio in a format that cannot be played (type)."; no audio → `502`
  "<Provider> returned no audio.". The response is the audio as the provider returned it, with that `Content-Type`,
  `Content-Length`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- **A client that goes away**: both calls get the request signal, so a disconnect aborts the provider call; the
  request then fails with `400 validation_error` "The request was canceled." that nobody reads (only the logs see it):
  no provider outcome and no usage row.
- **Resolvers** (`providers/`): `resolveTranscriptionModel(ref)` / `resolveSpeechModel(ref)` →
  `ResolvedAudioModel<M> { modelRef, providerId, modelId, info, entry, provider, model }`, with the checks of
  `resolveModel`; a model of another kind → `validation_error` on `modelRef` ("The model "<ref>" is not a speech-to-text
  model." / "… a text-to-speech model."), a provider without the factory → `validation_error` ("The provider "<name>"
  cannot transcribe speech, so the model "<ref>" cannot be used." / "… cannot read text aloud, …"), a factory that
  throws, times out (5 s guard) or returns no model instance → `plugin_error`. xAI's transcription and speech
  instances carry an empty `modelId` (the package takes none), so usage rows and logs use the resolved model ref.
- **Usage and outcome**: only a call that answers `200` writes a usage row (`purpose` `transcription` or `speech`,
  `chat_id` null, 0 tokens, `cost_usd` null) and records the provider as working; a failed provider call records the
  failure; a canceled call records neither.
- **Nothing is stored**: no audio, transcript or speech text is written to the database or the data directory. Each
  call logs one info line, `audio transcription` (provider, model, bytes, type, `durationSec` when reported, ms,
  `outcome` `ok` / `empty` / `canceled` / `failed`, `code` on failure) or `audio speech` (provider, model, characters,
  the audio type and bytes on success, ms, `outcome`, `code`); never the recording, the transcript, the speech text or
  an error object (AI SDK errors carry the request). A provider error whose message or upstream detail repeats any
  24-character run of the speech text (the whole text when it is shorter; texts under 4 characters are not checked) is
  replaced by "<Provider> returned an error." (details dropped), so the text cannot reach a log through the error
  handler (10.8, 12).
- **Web**: dictation records with `MediaRecorder` (`audio/webm;codecs=opus`, `audio/webm`, `audio/ogg;codecs=opus`,
  `audio/mp4`, else the browser default; 32 kbps), discards clips under 0.5 s, stops at 10 minutes and uploads the clip
  as `dictation.<ext>` without a model or a language (the server's settings decide); read-aloud splits a reply into
  sentence chunks (first ≤ 300 characters, then ≤ 1,500) and fetches the next chunk while one plays (UI.md 7.17, 7.18).
  The microphone needs a secure context (HTTPS or localhost) and the page's `Permissions-Policy` allows it for the
  app's own origin only (10.2).

### 6.13 Agent workspace: projects, workspace tools and the shell (ADR-031, ADR-032, ADR-033)

A **project** is a named folder on the server host; a chat optionally belongs to one (`chats.project_id`). In a chat
whose project folder opens, the builtin plugin `core-workspace` offers file tools and a shell that work inside that
folder. Everything below runs in the server process (the shell in child processes); there is no OS sandbox, and Docker
is the recommended boundary (section 10.9).

**Allowed roots.** `HF_WORKSPACE_ROOTS` (default `<dataDir>/workspaces`) is a comma list of absolute folders that may
hold project folders. `env.ts` checks only the syntax (split on `,`, trimmed, empty items dropped, deduplicated; each
item absolute and normalized; refused: relative paths, NUL, a filesystem root, a list that names no folder).
`projects.start()`, the first step of `startDeps()`, does the filesystem checks (`services/projects/roots.ts`): the
default root is created with mode 0700 when it is one of the roots; each root is `realpath`ed and must exist, be
accessible, be a directory and not resolve to a filesystem root; a root equal to the data dir, or inside it but outside
`<dataDir>/workspaces`, is refused; each refusal is an `EnvError` naming the root (`HF_WORKSPACE_ROOTS: <root> does not
exist. …`, exit 1). A root that **contains** the data dir is allowed (normal in development, where the repository holds
`data/`).

**Project lifecycle** (`services/projects/`, routes `projects.ts`; API.md, projects):

| Operation | Rules |
|---|---|
| `POST /projects` (fresh auth, 201) `{ name, path, newFolder? }` | `path` must be absolute (else 400 "Use an absolute folder path."); `realpath(path)`: a missing folder or a dangling link → 404 "The folder <path> does not exist."; not a directory → 400 "This path is not a folder." (permission denied, a link loop and a too long path are 400 too, all on `['path']`); outside every root → 400 "Choose a folder inside the workspace folders."; a folder that equals, contains or sits inside the data dir is refused (400 "This folder contains the harness-forge data directory." / "This folder is inside the harness-forge data directory."; the default root's subtree excepted; with `newFolder` the parent may contain the data dir; to run harness-forge on its own repository, set `HF_DATA_DIR` outside it); at most 200 projects (`LIMITS.projectsMax`, 400 "A server can have up to 200 projects.", checked before any folder is created); with `newFolder`, `path` is the parent: `mkdir` without `recursive` (EEXIST → 409 `exists` "A folder with this name already exists."), then `realpath` and the root and data-dir checks again; insert (a duplicate path → 409 `exists` "A project for this folder already exists.", and a folder this call created is removed again while still empty); info log `project created`; `project.changed` |
| `PATCH /projects/:id` `{ name?, instructions? }` | the path never changes; `instructions: ''` is stored as null; `project.changed` |
| `DELETE /projects/:id` (204) | 409 `run-active` ("A chat of this project is running. Stop it first, then try again.", `details.chatId`) while a chat of the project runs; one batch sets `chats.project_id = NULL` for its chats and deletes the row; the folder is **never touched**; info log `project deleted` with the number of detached chats; one `project.changed` with `project: null` (no `chat.updated` per chat: the web clears `projectId` locally) |
| `GET /projects/browse?path` | without `path`: the roots (`{ path, available }`), `path: null`, `parent: null`, no entries; with a path: the folder rules of `POST` (absolute, 404 when missing, 400 when not a folder or outside the roots; a folder inside the data dir → 400, one that contains it may be browsed); its subfolders (`Dirent.isDirectory()`, so links are not listed) without dot folders, `node_modules`, the data dir and names a path cannot carry (control characters, too long), in natural case-insensitive order (`app2` before `app10`), at most 500 (`truncated`), each with the `projectId` that uses it; `parent` null at a root |
| `GET /projects` | `ProjectSummary` per project, sorted by name (natural order): `available` / `issue` (the `openWorkspace` folder checks below; `issue` is one of "The folder does not exist.", "The folder was moved or replaced by a symbolic link.", "The path is not a folder.", "The folder cannot be accessed (permission denied).", "The folder is outside the workspace folders (HF_WORKSPACE_ROOTS).", "The folder overlaps the harness-forge data directory."), `instructionsFile` (`AGENTS.md` / `CLAUDE.md` / null; probed only for an available folder), `chatCount` (one grouped query over `chats_project_idx`, archived chats included) |

A chat joins a project when it is created (`ChatRequestBody.projectId`, honored only when that request creates the
chat; an unknown project is a 404 before the chat row exists, and the id is stored through a subquery on `projects`, so
a project deleted in between leaves no dangling id; an existing chat keeps its project whatever the request says) or
later through `PATCH /chats/:id { projectId }` (`null` = out of the project; 409 `run-active` whenever `projectId` is in
the patch while the chat runs, even for the same project; an unknown project is 404, checked in the same `UPDATE …
WHERE EXISTS`, so none of the patch's other fields is applied either; a move keeps `updated_at`, so the chat keeps its
place in the list, and emits `chat.updated`). `GET /chats?projectId=<id>|none` lists the chats of one project or those
without one (an unknown id lists nothing) through the index `chats_project_idx` with the same row-value keyset cursor as
the plain list: `(updated_at, id) < (?, ?)`, which SQLite runs as one range of the index (the equivalent `updated_at < ?
OR (updated_at = ? AND id < ?)` would become a multi-index OR plus a sort). `chats.project_id` has no foreign key (like
`active_leaf_id`): the project service owns the two cross-table queries (the detach and `chatCount`). Projects are configuration: they are not in backups or chat exports (export v1 /
v2 omit `projectId`, imports never set it), and delete-all keeps them (6.9).

```mermaid
sequenceDiagram
  autonumber
  participant W as Web (useChat)
  participant P as chat/prepare + pipeline
  participant Pr as services/projects
  participant M as LLM provider
  participant T as core-workspace tool
  participant FS as project folder
  W->>P: POST /api/chat (projectId only when the request creates the chat)
  P->>Pr: openWorkspace(chat.projectId)
  alt the folder is not available
    Pr-->>P: { ok: false, name, message }
    P-->>W: data-notice workspace-unavailable (warning, every run); the run continues without workspace tools, still with projectMaxSteps
  end
  Pr-->>P: { projectId, name, root (verified realpath), instructions, projectFile }
  P->>P: assembleTools (workspace tools only with a workspace; execute tools only with HF_WORKSPACE_SHELL on)
  P->>P: buildRunParams: instructions with the workspace block + project file; maxSteps = projectMaxSteps
  P->>M: streamText(tools, toolApproval (mode edits), stopWhen isStepCount(projectMaxSteps))
  M-->>P: tool call edit_file { path, old_string, new_string }
  P->>P: approval (6.2); wrapToolExecute adds ToolCallContext.workspace = { projectId, name, root }
  P->>T: execute(input, c)
  T->>FS: journaledWrite (Phase 8): lock, resolve, snapshot the before-state, replace, temp file + rename, journal row
  T-->>W: tool-output-available { path, replacements, diff } (the model gets "Edited src/a.ts: 1 replacement (+3 -1 lines).")
```

**`openWorkspace(id)`** runs (in `prepareRun`, before the history commit) on every chat-model run of a chat with a
project that calls the model: image turns (no tools) and reply or failed slash commands (no model call) skip it, prompt
commands open it. The stored path must still equal its realpath, be a directory, sit inside a current root and not
overlap the data dir. Otherwise the run continues without workspace tools and starts with the warning notice
`workspace-unavailable`, on every run for as long as the folder stays unavailable: "The project folder <path> is not
available: <issue>" (the `issue` texts of `GET /projects`), or "The project of this chat no longer exists." for a
deleted project; the server logs `the project folder of the chat is not available` (info, the project id). The result
carries the project file (`project-file.ts`), read again on every run: `AGENTS.md`, else `CLAUDE.md`, from the project
root only, opened through the path guard; a candidate that is missing, not a regular file, a link out of the root or
binary (a NUL byte in its first 8 KiB) is skipped and the next name is tried. A line made only of `@relative.md` is
replaced by that file (one level: the imported text is not scanned again; the target must be a relative path ending in
`.md`, resolved inside the root through the guard; at most 64 such lines per file; a refused, missing or binary target
leaves the line as written; this repository's `CLAUDE.md` is just `@AGENT.md`). The whole text is at most 32 KiB of
UTF-8 (`LIMITS.projectFileBytes`, cut at a character boundary), then the marker `[The project file was cut at 32 KiB.]`
after a blank line.

**Tool assembly** (`chat/tools.ts`): a tool that declares `ToolDefinition.workspace` (plugin API 1.2.0) is offered only
when the run has a workspace; a tool with access `execute` only while `HF_WORKSPACE_SHELL` is on. `wrapToolExecute`
puts the frozen `{ projectId, name, root }` into the call context of **every** tool of such a run
(`ToolCallContext.workspace`), and the policy function receives it too (6.2). Hook inputs (`tool.approve`,
`tool.before`, `tool.after`, `chat.params`) carry no project fields; the `chat.params` draft holds the assembled
instructions. Deleting or moving the chat's project during a run is refused (409), and a folder renamed on disk fails
the next tool call through the root re-check.

**Instructions** (`chat/params.ts`, before the `chat.params` hook), in this order, each part trimmed, empty parts
skipped, joined with a blank line: the global instructions → the workspace block → the project file, as `Instructions
from AGENTS.md in the project folder:` (or `CLAUDE.md`), a blank line and the content → the project's own
instructions → the chat instructions. The workspace block is its first line, then one `- ` rule per line, each only
when the tools it names are offered in this run (without workspace tools only the first line):

```text
Project "<name as a JSON string>", folder <root> (<OS: macOS, Linux, ...>).
- Use paths relative to the project folder.                                       (any workspace tool)
- Read a file with read_file before you change it.                                (read_file + edit_file or write_file)
- edit_file: old_string must match the file exactly, including whitespace and indentation, and must be unique in it;
  add surrounding lines to make it unique, or set replace_all.                    (edit_file)
- Prefer edit_file for changes to an existing file; use write_file to create a file or to replace all of its content.
                                                                                  (edit_file + write_file)
- Each shell call runs in a new process: the working folder carries over (cd persists inside the project folder),
  environment variables do not; there is no stdin (interactive commands cannot work), and background processes are
  stopped when the command ends.                                                  (shell)
```

(Each rule is one line in the real text; the parentheses name its condition and are not sent. v1.3 said "cd does not
persist between calls (use cwd, or cd dir && command)"; Phase 8 changed the shell line with the sticky folder.)

**Steps**: every run of a chat with a project uses the setting `projectMaxSteps` (default 100) instead of `maxSteps`
(default 20), also when its folder could not be opened; both accept 1–200, and the clamp after the `chat.params` hooks
moved from 100 to 200 (`LIMITS.stepsMax`).

**Path resolution** (`workspace/paths.ts`, frozen after P7-0b): `resolveWorkspacePath(root, input, { allowMissing })`
→ `{ absolute, rel, exists }`:

1. The input has 1–4096 characters and no control characters; `realpath(root)` must equal `root`, else "The project
   folder moved or was replaced by a link." ("The project folder no longer exists." when it is gone).
2. `lexical = resolve(root, input)` (absolute inputs are accepted) must be inside `root` (`isWithin`), else "Path is
   outside the project folder."
3. Walk up from `lexical` until `realpath` succeeds: on ENOENT / ENOTDIR the path is `lstat`ed; if it exists it is a
   dangling link and is refused, otherwise its name joins the missing tail and the walk continues with the parent.
4. The realpath of the deepest existing entry must be inside `root`, else "… resolves outside the project folder
   (symbolic link)."
5. A missing tail is allowed only with `allowMissing` (writes), and its existing base must be a directory. `rel` is
   POSIX, `.` for the root.

Writes refuse any `.git` segment and directories, `mkdir -p` the missing tail and re-check the realpath of the parent,
then write a temp file in the same folder (`open('wx')`, `.hf-write-<random>`), give it the old file's mode and
`rename` it over the target. Reads open with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` and refuse anything that is not a
regular file after `fstat` (without `O_NONBLOCK` a FIFO would hang the read). TOCTOU: only the last path component is
protected (`O_NOFOLLOW` / `O_EXCL`); Node has no `openat2` / `RESOLVE_BENEATH`, so a parent folder swapped for a link
between the check and the open is not caught, and hard links are not detected. These guards protect against model
mistakes and injected paths, not against code already running in the workspace; the shell has the server's rights
anyway (10.9).

**The tools** (`builtin-plugins/core-workspace/`, version 1.0.0, `engines ^1.2.0`, permission `process`, no settings;
schemas in `@harness-forge/shared`, `WORKSPACE_LIMITS`):

| Tool | Input | Policy / access / timeout | Output (stored) and the model's text |
|---|---|---|---|
| `read_file` | `path`, `offset?` (1-based), `limit?` (1–2000) | secret-looking path → `ask`, else `safe` / `read` / 30 s | `{ path, content, startLine, endLine, totalLines, truncated }`; text files only (the first 8 KiB must look like text), read as a stream: lines cut at 2000 characters, at most 48 KiB per call, a trailing `\r` and a leading BOM dropped; after the window the rest is counted while that costs at most 8 MiB, else `totalLines` is null; the model sees `cat -n` lines (the line number right-aligned in 6 columns, a tab, the line), then "[truncated; continue with offset=N]" when the file goes on, or "[lines longer than 2000 characters were cut]"; "(x is empty)", "(x has N lines; offset M is past the end)" |
| `list_directory` | `path?` (`.`) | `safe` / `read` / 30 s | `{ path, entries: { name, type }[], truncated }`, sorted, at most 1000, links not followed, `.hf-write-*` temp files hidden; one name per line, `name/` for a folder, `name@` for a link, "(x is an empty folder)", "[truncated: only the first N entries are listed]" |
| `find_files` | `pattern` (glob; dot files included; without `/` it matches the name at any depth, else the path relative to the searched folder), `path?`, `include_ignored?`, `max_results?` (≤ 1000, 200) | `safe` / `read` / 60 s | `{ pattern, paths, truncated }`, files only, sorted; one path per line, "No files match.", "[truncated: showing N paths; narrow the pattern or the path]" |
| `search_files` | `pattern` (JS regex), `literal?`, `case_sensitive?` (true), `glob?`, `path?` (a folder, or a single file that is not secret-looking), `include_ignored?`, `max_results?` (≤ 500, 100) | `safe` / `read` / 60 s | `{ pattern, matches: { path, line, text }[], filesSearched, truncated }`; `path:line: text` lines, "No matches (N files searched).", "[truncated: showing N matches; narrow the pattern, the glob or the path]" |
| `write_file` | `path`, `content` (≤ 256 KiB) | hidden or secret path → `always`, else `ask` / `write` / 30 s | `{ path, created, bytes, lines, diff }`; "Created x (1 line)." / "Updated x (+a -r lines)." / "Updated x (N lines)." (no diff: an old file over 1 MiB or a diff that timed out) |
| `edit_file` | `path`, `old_string` (1 – 64 KiB), `new_string` (≤ 64 KiB), `replace_all?` | as `write_file` | `{ path, replacements, diff }`; "Edited x: 1 replacement (+a -r lines)." / "Edited x: N replacements." (no diff) |
| `shell` | `command` (≤ 16 KiB), `cwd?` (a project folder; a refused one is `validation_error` on `['cwd']`), `timeout_ms?` (1000–590,000, 120,000), `description?` (≤ 200, shown on the approval card) | `ask` (Phase 8: `shellPolicy`, `safe` when shell rules match, 6.2) / `execute` / 600 s | `{ command, cwd, exitCode, signal, timedOut, durationMs, stdout, stderr, stdoutBytes, stderrBytes }`, Phase 8 `endCwd?`, `cwdNote?`, `allowedBy?`; the text below |

- Paths in every input and output are project-relative POSIX paths. Every output is trimmed to about 60 KiB of JSON
  before the 64 KB host cap (a diff to about 24 KiB with lines cut at 500 characters and `truncated: true`), and
  `toModelOutput` builds the model's text only from the stored output, so a replayed history gives the same text.
- `edit_file`: the match must be unique unless `replace_all` ("not found" tells the model to read the file again and
  match whitespace exactly; "occurs N times" to add context or set `replace_all`; `old_string === new_string` is an
  error; the replacement is literal); files up to 1 MiB (the result too); a file that is CRLF throughout is matched on
  its LF text and written back as CRLF (mixed endings are matched raw); a BOM is kept. Diffs come from
  `diff.structuredPatch(…, { context: 3, timeout: 2000 })` (`diff: null` when it times out); an empty side of a hunk
  starts at the line before it (0 for an empty file), and a trailing `\r` is dropped from displayed lines.
- Secret-looking paths (`workspace/sensitive.ts`): `.env`, `.env.*` (not `.env.example` / `.sample` / `.template`),
  `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.pypirc`, `.netrc`, `*.p12`, `*.pfx`, `credentials*.json`,
  `secrets.*`. Hidden paths: any segment that starts with `.` (git hooks, `.husky`, `.vscode`, `.github` workflows).
  Reading a secret-looking file asks (in Ask and Accept edits); writing a hidden or secret path always asks. The
  policy functions (`core-workspace/policies.ts`) check the path as written and, with the call's workspace, the path it
  resolves to through the guard, so a link named `notes.txt` that points at `.env` asks too (a path the guard refuses
  is judged by its spelling; the call fails anyway). A user override `allow` on the tool still wins (6.2). Phase 8:
  both file tools write through `journaledWrite` (below), so every write is restorable.
- Walking (`find_files`, `search_files`; `workspace/walk.ts`): an async depth-first walker; `.git` (a folder or a
  worktree file) and the `.hf-write-*` temp files are always skipped; `node_modules` and gitignored paths are skipped
  unless `include_ignored` (every folder's `.gitignore` gets its own `ignore` instance, the deepest verdict wins, an
  ignored folder is never entered; the files between the root and the start folder apply unless they ignore the start
  folder itself); folder links are not entered, a file link is kept only when its realpath is a regular file inside
  the root; FIFOs, sockets and devices are skipped; every folder is re-checked against its realpath before it is read;
  caps 100,000 entries, depth 64, 10 s and the abort signal (a cap ends the walk with `truncated: true`). The
  `.gitignore` rules run on the main thread, so a hostile repository must not stall the server: a `.gitignore` over
  256 KiB is skipped, and a line longer than 512 characters or with more than 3 runs of `*` is dropped (a heuristic
  guard against backtracking patterns).
- Pattern matching (`workspace/pattern-worker.ts`): the regular expression of `search_files` (JavaScript syntax, `u`
  when the pattern allows it, `i` unless `case_sensitive`, escaped with `literal`) and every glob (`picomatch`, dot
  files included; the `find_files` pattern and the `search_files` `glob`) are compiled on the main thread only to check
  their syntax; the matching runs in an eval `Worker` (`resourceLimits` 256 MB) that the server terminates when the call
  ends, when the run is aborted or after 20 s ("The search timed out — use a simpler pattern or a narrower path."; out
  of memory: "The search ran out of memory — …"), so a pattern like `(a+)+$` on a long line, or a glob like `*a*a*a…b`
  on a long name, cannot freeze the single-process server. The Worker never touches the filesystem: the main thread
  walks and reads through the path guard. `search_files` skips files over 1 MiB, files whose first 8 KiB do not look
  like text and secret-looking files (a link to one too), even with `include_ignored`.

**The shell runner** (`workspace/shell.ts`; the only place that starts a shell):

- `spawn(sh, ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false })` with
  `sh` = `/bin/bash` when it is executable, else `/bin/sh` (checked once); `cwd` = the project-relative `cwd` through
  the resolver (default the root; a refused one fails the call with `validation_error` on `['cwd']`). Not registered
  on Windows.
- Environment (`workspace/shell-env.ts`): the allowlist `HOME LOGNAME USER PATH LANG LC_ALL LC_CTYPE TZ TMPDIR` (when
  set and not empty; values starting with `()`, exported shell functions, are skipped; `PATH` falls back to
  `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`), plus `SHELL=<sh>`, `TERM=dumb`, `NO_COLOR=1`,
  `PAGER=cat`, `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`. Never passed: `HF_*`, provider keys, `NODE_ENV`. Phase 8:
  empty and relative `PATH` entries are dropped, so `pnpm` can never resolve to a file inside the project.
- The process gets its own process group (`detached`). The kill = `process.kill(-pid, 'SIGTERM')`, then `SIGKILL`
  after 2 s, repeated every 200 ms (at most 25 times) until ESRCH (which also catches fork loops). It fires on the
  timeout (the result says `timedOut: true`; a normal result, not an error), on the run's abort signal (Stop, the guard
  timeout, a disabled plugin: an AbortError once the group is gone), when the shell exits while its pipes stay open for
  500 ms or its group still has members (background processes are stopped even when they closed their pipes; the tool
  description says so), and from a process-exit handler that SIGKILLs every live group, because detached groups
  outlive a crashed server. A process that called `setsid` escapes the group; its pipes are closed by force so the call
  still ends.
- Output: each stream keeps its first 4 KiB and last 16 KiB; when bytes were dropped, the marker `[… N bytes omitted …]`
  stands on its own line between them. ANSI escape sequences and every other control character (tab and newline
  aside) are stripped, `\r\n` becomes `\n`, and a `\r` progress line keeps only its last segment; `stdoutBytes` /
  `stderrBytes` count the raw streams. The stored output stays under 60 KiB of JSON: both streams lose bytes from their
  middle in proportion to their size (their markers grow), and the command is cut only when both streams are empty.
- The model's text (`shellModelText`, built from the stored output): a status line `Exit code: N`, `Stopped after <s> s
  (timeout)` or `Terminated by signal SIG…`, then `stdout:` and the text (trailing newlines trimmed) or `(empty)`, then
  `stderr:` and its text only when stderr is not empty. An output that does not parse goes to the model as JSON.
- Logs (the `core-workspace` plugin logger, so also in its Plugins tab log): `shell command finished` (info: chat id,
  tool call id, exit code, signal, timed out, duration, byte counts), `shell command stopped` (info, aborted),
  `shell command failed to start` (warn, the error message); the command only at `debug`, cut at 1,000 characters and
  redacted; never the output.
- `HF_WORKSPACE_SHELL=0` removes every `execute` tool from every run: a kill switch that no session can change.

**Run scope and journaled writes** (Phase 8, ADR-036; `workspace/run-scope.ts`, `file-lock.ts`, `journal.ts`). The
pipeline (`chat/pipeline.ts`) passes `session.assistantId` and a run scope to `assembleTools` (`chat/tools.ts`):
`{ chatId, messageId, projectId, toolCallId, journal, shellRules, shellCwd: { current } }` with `journal =
checkpoints.journal({ chatId, messageId, projectId })`, `shellRules = await shellRules.forRun(projectId)` and
`shellCwd.current = initialShellCwd(history)`. `wrapToolExecute` binds it (with the call's `toolCallId`) to the
`ToolCallContext` object right before `definition.execute`, and `evaluatePolicy` binds it to the context object of a
policy function; `runScopeOf(c)` reads it from a module-private `WeakMap`, so only server code (the builtin
`core-workspace` tools) can reach it: the plugin API stays 1.2.0 and third-party plugins see nothing new. A
continuation after an approval reuses the same assistant message id.

`journaledWrite(c, root, input, produce)`: resolve the path (`allowMissing`; a `.git` segment is refused early) → take
the per-file lock (`file-lock.ts`: one promise chain per resolved absolute path, process-wide) → read the before-state
(`readWorkspaceFile`, at most 8 MiB, else `too-large`; the mode through `fstat`; `missing` when there is no file) →
`data = await produce(before)` (`edit_file` applies its replacement here; when it throws nothing is snapshotted) →
`signal.throwIfAborted()` → store the before blob (the store gate held shared) → the frozen `writeWorkspaceFile` →
insert the `workspace_changes` row with the after sha → release the lock. A failure to record logs the warning
`checkpoint not recorded` and keeps the tool's result; a blob left by a failed write is removed by the next prune.
`write_file` and `edit_file` compute their diff from the same before bytes (`readPreviousText` is gone), so two parallel
`edit_file` calls on one file in one step now serialize and the second sees the first's result (v1.3 could lose one).
Rewind, revert and undo take the same lock, and so do the writes of other chats to that file.

After every settled call (success or failure) `wrapToolExecute` records a `shell` row for the core `shell` (its
command, cut at 1,000 characters) and an `untracked` row (the tool name only) for any other tool with workspace access
`write` or `execute`: the rewind dialog lists them and they are never restored (6.16). MCP tools declare no workspace
access and are invisible to the journal.

**Sticky working folder** (Phase 8, ADR-038; `workspace/shell.ts`, `shell-cwd.ts`). Each call is still a new process
(same isolation, environment, timeouts and group kill), but the folder it ends in is where the chat's next call starts:

- `runShellCommand({ …, reportCwd: true })` runs `sh -c "trap 'pwd -P 2>/dev/null >&3' EXIT; <command>"` (one line, so
  bash's line numbers stay) with stdio `['ignore', 'pipe', 'pipe', 'pipe']`; fd 3 is read up to 4 KiB and its last
  absolute line becomes `ShellRunResult.endCwd`. `exit N`, a `set -e` failure and a normal end report it (EXIT traps
  run under bash and dash; the exit status is kept); `exec`, a SIGKILL (timeout, Stop), a user `trap … EXIT` or a
  syntax error on the first line report nothing, so the folder stays as it was; subshells (`(cd x)`, `cd x | cat`)
  correctly leave it unchanged. fd 3 is inherited by the command; a program that writes to it can only pick a folder
  inside the project (the clamp below).
- The state is derived, not stored: `initialShellCwd(history)` takes the `endCwd` of the last `tool-shell` part with
  an output on the run's active path (default `.`; outputs saved before v1.4 count as `.`), so it follows versions
  and survives restarts. Inside a run `scope.shellCwd.current` follows the finished calls (for parallel calls in one
  step the call that finishes last wins).
- Clamp: the reported folder must resolve inside the root and be a folder (`resolveWorkspacePath`; `pwd -P` has
  already resolved links), else the output has `endCwd: '.'` and the `cwdNote` "The command ended outside the project
  folder; the next call starts in the project folder." At each call start the remembered folder is checked again: a
  folder that no longer exists means the call runs in the project folder, with a note. An explicit `cwd` input
  (relative to the project folder) overrides the remembered folder for that call, and its end folder is remembered.
- Output: `{ command, cwd, …, endCwd?, cwdNote?, allowedBy? }` (`cwd` = the folder the call started in). The model's
  text gains one line after the status line when the folder changed: "The working folder is now packages/web (the
  next call starts there)." (or the `cwdNote`). Environment variables still never carry over (`export X=1` is gone at
  the next call); the tool description says so.

**Shell rules** (Phase 8, ADR-038; `services/shell-rules/`, route module `shell-rules.ts`; their effect on approvals
is in 6.2). Table `shell_rules` (`srl_` ids; `project_id` null = a global rule, else the project, deleted with it); a
rule is a canonical prefix (`parseShellRule` of the shared parser: the words after unquoting, joined by single spaces,
at most 200 characters); at most 200 rules per scope; a duplicate is 409 `exists`. Refused prefixes: an empty one, one
with shell syntax, a first word that runs its arguments as a command (`sh bash zsh dash ksh fish eval exec source .
command builtin env sudo doas su xargs nohup nice timeout time watch stdbuf chroot setsid ssh parallel`), a single word
naming an interpreter or a package runner (`node python python3 ruby perl php deno bun npx pnpx bunx`), and `cd` (it
needs no rule). Routes: `GET /shell-rules` → `{ items: ShellRule[] }`, `POST /shell-rules { projectId | null, prefix }`
→ 201 (an unknown project is 404), `DELETE /shell-rules/:id` → 204; none needs fresh auth (a session can already
approve its own shell calls, 10.9). Rules are not settings (public settings travel in backups, and a crafted backup
must not grant shell rights) and are never exported or imported. `forRun(projectId)` loads the global and the project's
rules once per run; a rule added during a run applies from the next run (the web adds the rules of an approval card
before it sends the approval, whose continuation is a new run).

The dev-only model `mock:workspace` walks through `write_file`, `edit_file` and `shell` deterministically for tests and
e2e; Phase 8 adds `mock:checkpoint` (one edit per turn, then shell steps that create and enter a folder) and
`mock:shell` (runs the user's text as one command) (PROVIDERS.md 8).

### 6.14 Master-key rotation (ADR-034)

Rotation re-encrypts every secret with a new master key. It runs online (Settings → Data → Rotate key…, `POST
/api/keys/rotate`) when the key comes from `data/secret.key`, and offline through the `rotate-key` CLI when the key
comes from `HF_MASTER_KEY` (the server cannot change its own environment).

**Key state.** The internal setting `_keys = { version, check, rotatedAt }`, where `check` = base64url of
`HMAC-SHA256(encryption subkey, 'harness-forge/key-check/v1')` (`services/keys/check.ts`). The keyring's version is
`_keys.version` (1 when absent), and a rotation writes every secret row with `key_version` = V+1. At the first v1.3
boot `_keys = { version: 1, check, rotatedAt: null }` is written when the secrets table is empty or at least one row
decrypts; otherwise nothing is recorded (a wrong key must not become the recorded one) and a warning is logged. A
stored `_keys` that does not parse is never overwritten (warning; the version is then the highest `key_version` of the
rows). `GET /keys` → `KeyStatus { source, keyVersion, rotatedAt, keyCheck: 'ok' | 'mismatch' | 'unknown', secrets,
unreadableSecrets, shares, pendingApprovals, canRotate }` is **read-only**: it waits for `whenKeyStable()`, never writes
`_keys` (when the row is missing, e.g. every secret was unreadable at boot, it computes in memory what the recovery
would record, else `unknown`), counts in `pendingApprovals` the **messages** with an open approval, and `canRotate` is
true only for source `file`, key check `ok` and a rotatable keyring.

**A live swap without breaking the frozen deps.** `createMasterKeyring` returns one frozen object whose `keyVersion`
is a getter and whose `subkey()` reads closure state; module-private controls (`swapMasterKey`, `beginKeyChange`,
`whenKeyStable`) change it in place, so `deps.keyring` keeps returning the same object. Every cache of a subkey keeps
`{ version, value }` and derives again when `keyring.keyVersion` changes (the session signer, the share token signer);
`SecretStore.get` / `set` / `delete` / `deleteScope` first `await whenKeyStable()`, so nothing is read or written with
the old key while a rotation runs, and an operation that a rotation overtook anyway (it began while the statement was
in flight) is done again under the new key; the session middleware signs a rolling cookie before the handler runs and
drops it when `keyring.keyVersion` changed during the request (the rotation route issues the caller's cookie itself).

**Online rotation** (`KeyService.rotate`, `services/keys/index.ts` + `rotate.ts`):

1. The route runs the fresh-auth middleware (10.1); the service calls `requireFreshAuth()` again and checks `{ confirm:
   'ROTATE' }` (else `400 validation_error` "Type ROTATE to confirm.").
2. Refused with 409 `env-key` when the key comes from `HF_MASTER_KEY` ("The master key comes from HF_MASTER_KEY and
   cannot be rotated online. Stop the server and run "rotate-key" with HF_NEW_MASTER_KEY set (pnpm key:rotate).").
3. `maintenance.exclusive('key-rotation', …, { blockRuns: true })`: another maintenance operation (an import,
   delete-all, a cleanup) gets 409 `busy` ("Another data task is running. Try again when it finishes."), and every
   `POST /chat` while it runs gets 409 `busy` ("The server is rotating its encryption key. Try again in a moment.").
4. Inside the lock: 409 `key-mismatch` unless the live key matches the stored check ("The master key in use does not
   match the key the secrets were written with; a rotation would lose them. Restore the original key first.").
5. Every running chat is stopped (`runs.stop(id)`; preparing runs are refused).
6. `beginKeyChange()` (secret reads and writes wait); the new key (`randomBytes(32)`) is generated and its text added
   to the redactor before it is written anywhere.
7. A `secret.key.next` left by an earlier rotation is settled: when it holds the key in use (a committed rotation whose
   rename failed) the rename is finished, anything else is removed (warnings). Then the new key is written to
   `secret.key.next` (mode 0600, exclusive create, fsync of the file and the folder) **before** anything commits, so a
   crash can never lose it.
8. One `db.transaction` (`rotateSecretsTx`, shared with the CLI): every row of version V that decrypts with the old
   encryption subkey is encrypted with the new one (`key_version` V+1; `hint` and `updated_at` kept; rows of another
   version or failing GCM stay as they are and count as `skippedSecrets`); every message with an open approval goes
   through `denyOpenApprovals(parts, 'Expired after a key rotation.')` (`approvalsExpired` counts the denied **tool
   parts**); every `chats.pending_approval` flag is cleared (`chats` counts them); `_keys = { version: V+1, check,
   rotatedAt }`. A failed transaction deletes `.next`, ends the key change and rethrows (nothing changed).
9. `rename(secret.key.next, secret.key)` + fsync of the folder; a failed rename is logged (error) and finished by the
   next boot's recovery (or the next rotation, step 7).
10. `swapMasterKey()`, then `end()` (waiting secret operations resume under the new key); the key buffer is zeroed when
    the rotation returns.
11. One info log line `master key rotated` with the counts (never the key), then `key.rotated { keyVersion, rotatedAt,
    chatIds }` (the chats whose run was stopped, whose approvals expired or whose flag was cleared; sorted, at most
    1000), then `events.disconnectAll()`: queued events are flushed, then every event stream closes (revoked sessions
    must not keep listening; `PUT /auth/password` calls it too).
12. The route sets exactly one new session cookie for the caller (`authAt` kept, so the session stays fresh); with auth
    disabled there is no cookie. The answer is `KeyRotationResult { keyVersion, rotatedAt, secrets, skippedSecrets,
    shares, approvalsExpired, chats, runsStopped }`.

Effects: every other session is invalid (signed with the old `session` subkey), every share URL changes (tokens are
HMACs of the `share` subkey; owners copy the new links), every pending approval is denied, running replies stop, event
streams reconnect. **There is no downgrade to v1.2 after a rotation**: v1.2 always reads secrets as version 1.

**Boot recovery** (`recoverKeyState`, `services/keys/recover.ts`, after the migrations and before `createDeps`; the CLI
runs it too). A `secret.key.next` is decided **before** the key file is loaded, so a missing `secret.key` is never
generated while `.next` may hold the key in use:

| State at boot (file mode) | Action |
|---|---|
| no `secret.key.next` | nothing |
| `_keys` absent | nothing committed (a commit writes `_keys`): delete `.next`, log a warning |
| `_keys` present but invalid | cannot decide: `.next` is left in place, log a warning |
| the check of `.next` equals the stored check | the rotation committed: rename `.next` over `secret.key`, fsync the folder (info log) |
| the check of `secret.key` equals the stored check | the rotation did not commit: delete `.next`, log a warning |
| neither matches | `KeyRecoveryError` naming both files ("Keep both files, restore the key file that belongs to this database …"): the boot fails with exit code 1 |

In env mode (`HF_MASTER_KEY` set) a `.next` is ignored with a warning (only the file mode writes it), and a key that
does not match the check logs a warning; `GET /keys` then reports `keyCheck: 'mismatch'`.

**`server.lock`** (`services/keys/server-lock.ts`): right after the data directory exists the server writes
`<dataDir>/server.lock` (`{ pid, hostname, port, startedAt }`, a temporary file renamed into place, mode 0600, folder
fsynced). An existing lock never stops the boot: a stale one (dead pid) is replaced silently, one naming another live
process on this host or a process on another host is replaced with a warning. The lock is removed at shutdown (after
the database is closed) and when the boot fails, but only while it still names this process (pid and `startedAt`), so
a lock a newer server took over is never removed. It keeps the CLI away from a running server.

**Offline CLI** (`node apps/server/dist/main.mjs rotate-key [--force]`, root script `pnpm key:rotate`; `main.ts`
dispatches on `argv[2]` before it boots anything; `services/keys/cli.ts`):

1. It loads `.env` and the environment like the server; an unknown argument fails with the usage `rotate-key [--force]
   (env mode: set HF_NEW_MASTER_KEY to the new base64 key)`; the database must exist ("there is no database at …").
2. It refuses (exit 2) while a server may use the data directory: `GET /api/health` on the configured host and port
   answers within 1 s (`0.0.0.0` is probed as `127.0.0.1`, `::` as `::1`; no probe with `HF_PORT=0`): "refused: a
   server answers at <url>. Stop the server first, then run rotate-key again."; or `server.lock` names a live process
   on this host: "refused: <path> names a running process (pid N). …" (never overridable). A lock written on another
   host ("refused: <path> was written on another host (<host>, pid N). Make sure that server is stopped, then run again
   with --force.") or one that cannot be read needs `--force`; a stale local lock only warns.
3. It migrates the database, settles an interrupted online rotation (`secret.key.next`, file mode) and records the key
   check like the boot (`recoverKeyState`).
4. The old key: `HF_MASTER_KEY`, else `secret.key` (it never creates a key file); it must match the stored key check,
   and the check must be recorded (else exit 1, "Nothing was changed."). In env mode an existing `secret.key` only
   warns ("… exists but is not used while HF_MASTER_KEY is set; it is left unchanged.").
5. The new key in env mode: `HF_NEW_MASTER_KEY` is **required** (base64 of 32 bytes, different from the old key; "failed:
   HF_NEW_MASTER_KEY is not set. …"); the CLI never generates or prints a key. In file mode a set `HF_NEW_MASTER_KEY`
   is ignored with a warning and the CLI generates the key and runs the same `.next` + transaction + rename flow as
   the online rotation.
6. One transaction (`rotateSecretsTx`), then the summary "rotated the master key to version N: S secrets re-encrypted,
   U unreadable left unchanged, L share links changed, A pending approvals expired." and the next step (env mode: "now
   replace HF_MASTER_KEY with the value of HF_NEW_MASTER_KEY (then unset HF_NEW_MASTER_KEY) and start the server.";
   file mode: "<path> holds the new key; start the server.").

Every line goes to stderr, prefixed `harness-forge rotate-key:` (refusals `refused: …`, failures `failed: …`, warnings
`warning: …`), through a redactor that knows `HF_MASTER_KEY`, `HF_NEW_MASTER_KEY`, `HF_PASSWORD` and both keys. Exit
codes: 0 done, 1 failed, 2 refused. Docker: stop the server container, then run the CLI in a one-off container on the
same volume (the command is in `docs/guides/using-projects.md`).

### 6.15 Orphaned file cleanup (ADR-035)

Generated images and the attachments of deleted chats and versions stay in `data/files/` (deleting a chat or a version
keeps its files, 6.8, 6.11). Settings → Data → Storage cleanup removes them by hand, after a preview. Phase 7 had no
automatic sweep (deletion cannot be undone, and a plugin may keep file ids outside the database); Phase 8 (ADR-039)
adds an opt-in timer that runs the same cleanup and scans plugin data too (below).

- **Routes** (`data.ts`): `GET /data/cleanup` → `DataCleanupPreview { files, fileBytes, blobs, diskBytes, tempFiles,
  recentFiles, graceMs, lastRunAt }` (a dry run); `POST /data/cleanup` → `DataCleanupResult { files, fileBytes, blobs,
  diskBytes, tempFiles, ranAt }`. Neither needs fresh auth; both run under the maintenance lock and answer 409 `busy`
  ("Another data task is running. Try again when it finishes.") while another maintenance operation runs. `GET /data`
  stays cheap (the scan reads every message, so it has its own route). No event.
- **Referenced ids** (`services/data/references.ts`, collected without any lock before the sweep): batches of 500 rows
  (keyset by `rowid`), pre-filtered with `instr(col, 'file_') > 0`, then every `file_` followed by 16 letters or digits
  counts as a reference, matched with a lookahead (`/file_(?=([\dA-Za-z]{16}))/g`) so overlapping candidates are all
  found (a loose scan: it may keep an extra file, never miss one), over `messages.parts` and `metadata`,
  `chat_shares.snapshot` and `file_ids`, `plugin_kv.key` and `value`, `plugin_settings.values`, `settings.value`,
  `chats.settings` and `projects.name`, `path` and `instructions`. A schema-coverage test fails when a JSON, text or
  blob column is neither scanned nor explicitly excluded with a reason (`secrets`, `usage`, `model_cache`, …), so a new
  column cannot silently lose files. Phase 8: every text column of `workspace_changes` and `shell_rules` is in
  `UNSCANNED_COLUMNS` (ids, project paths, commands, hashes; never a `data/files` id).
- **Plugin data** (Phase 8, ADR-039; `services/data/plugin-data-scan.ts`, the manual and the automatic run): the same
  loose `file_` scan over the files under `paths.pluginData` (`plugins/.data/**`, disabled plugins and `keepData`
  leftovers included): `readdir` with file types plus `lstat`, links never followed, regular files only, opened
  `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` and checked with `fstat`, read as a stream in 1 MiB chunks with a 20-byte carry
  over (an id split across two chunks is found) and the same lookahead regex on latin1. Budget: 256 MiB, 50,000 files,
  depth 32, plus the abort signal. Over budget, an automatic run is skipped (nothing is deleted, `skipped` /
  `plugin-data-limit`) while a manual run proceeds and reports `pluginData: 'partial'` in the preview (v1.3 scanned
  no plugin data at all). Installed plugin folders, `cache/`, `workspaces/` and `checkpoints/` are not scanned.
- **Candidates**: file rows created before the cutoff (`now - 24 h`, `graceMs`, taken before the scan), not referenced
  and not **pinned**: the files service pins in memory, for the grace period, every id that `upload`, `importFile` or
  `saveGenerated` returned (a run may reuse an old row before its message is saved; pins are lost on restart, like the
  runs that held them). Unreferenced rows that are younger or pinned are counted as `recentFiles` (preview only).
- **Sweep** (`FilesService.sweep`, `services/files/sweep.ts`, under the files service's exclusive gate, which `purge`
  takes too; `upload`, `importFile` and `saveGenerated` hold the gate shared around their blob write + insert + pin, and
  waiters are served in arrival order, so uploads cannot starve a sweep): candidates are read in keyset batches by id;
  `DELETE … WHERE id IN (…) AND id NOT IN (referencedFileIdsQuery())` (the statement re-checks message references, so a
  message committed after the scan keeps its file); a blob is unlinked only when no row is left with its sha256; then
  `files/<aa>/` is walked: a 64-hex blob in its own shard without a row and with an mtime before the cutoff is deleted,
  `.<sha256>.<uuid>.tmp` files older than 1 hour are deleted, anything else is skipped (`lstat`, regular files only).
  `dryRun` (the preview) deletes nothing and skips the DELETE re-check, so a preview may count a file that the real run
  then keeps.
- **Counts** (`FileSweepResult`, the cleanup DTOs): `files` / `fileBytes` = the rows removed and their sizes; `blobs` =
  only the leftover blobs that no row has at all (the walk), not the blobs of the removed rows; `tempFiles` = the stale
  temp files; `diskBytes` = every byte freed on disk (the unshared blobs of the removed rows, the leftover blobs and the
  temp files). Only counts are logged, never ids, names or paths; paths come only from validated sha256 names.
- **Exclusivity**: `maintenance.exclusive('file-cleanup', …)` without blocking runs (the pins and the grace period cover
  them); imports, delete-all and key rotation are serialized against it. A real run stores its time in the internal
  setting `_files` (`{ lastCleanup }`, the preview's `lastRunAt`) and logs `orphaned files cleaned up` (info: the
  counts and `recentFiles`); a file that cannot be removed logs a warning with the error code only.
- **Plugins** that keep file ids should keep them in `ctx.storage` or their settings (scanned exactly); since Phase 8
  the files under `ctx.plugin.dataDir` are scanned loosely within the budget above (PLUGINS.md 9).
- **Checkpoints** (6.16) are a separate store: the sweep walks only `paths.files` (64-hex names in their own shard), so
  a `checkpoints/aa/<sha256>` blob is never touched (a test proves it), and checkpoint retention follows ADR-036.

**Automatic sweep** (Phase 8, ADR-039; `services/data/auto-sweep.ts`: `createAutoSweep` and the pure `nextSweepAt(state,
mode, bootAt)`):

- The setting `fileSweep` = `off` (default) | `daily` | `weekly` (a public setting, no fresh auth, restored by a backup
  like any setting). `DataService.start()` (the last step of `startDeps`) starts a timer like the catalog's
  `scheduleCycle`: a chained `setTimeout(…).unref()` plus a `stopped` flag; the first check comes at `bootAt + 24 h`
  (`FILE_CLEANUP_GRACE_MS`, so the in-memory pins lost at a restart never matter), then one check per hour. Each check
  reads the setting and `_files` again, so a change applies within an hour without a subscription.
  `DataServiceOptions.background` is off under Vitest; `stop()` (the first step of `stopDeps`) clears the timer and
  aborts a sweep in flight (`FileSweepInput.signal`, checked between batches).
- Due time: `nextRunAt = max(bootAt + 24 h, (lastCleanup ?? 0) + interval, lastAutoSweep failed or skipped ?
  lastAutoSweep.at + interval : 0)` with interval 24 h (`daily`) or 7 days (`weekly`); `null` while `off`. A manual
  cleanup sets `lastCleanup`, so it resets the clock.
- Run: `maintenance.exclusive('file-cleanup', () => runCleanup(deps, now, { trigger: 'auto', signal }))`, the same
  lock as the manual run (no `blockRuns`). A 409 `busy` (an import, delete-all, a rotation or a manual cleanup is
  running) stores nothing and retries in 10 minutes (debug log). A failure is stored (`failed`, reason `error`) with a
  warning (`err`, no paths) and is retried only after a full interval, so it cannot loop. A finished run sets both
  `lastCleanup` and `lastAutoSweep`, so the existing "Last cleanup" line covers both kinds.
- State: the internal setting `_files = { lastCleanup?, lastAutoSweep?: { at, status: 'done' | 'skipped' | 'failed',
  reason: 'plugin-data-limit' | 'error' | null, files, diskBytes } }`. DTO `FileSweepStatus { mode, lastAttempt,
  nextRunAt }` in `GET /data` (`DataSummary.fileSweep`: one internal setting read, so the section renders without a
  scan) and in `GET /data/cleanup`. No new route and no new event: the Data page loads `GET /data` when it opens.
- Logs: info `automatic file sweep finished` (`trigger`, the counts, `recentFiles`, `pluginDataFiles`,
  `pluginDataBytes`, `durationMs`) or `automatic file sweep skipped` (`reason`); manual runs log `trigger: 'manual'`;
  never ids, names or paths.
- Test hook: `HF_TEST_FILE_SWEEP_DELAY_MS` (1000 – 86,400,000) replaces the boot delay and the hourly check, honored
  only with `HF_MOCK_PROVIDER=1` (otherwise ignored with a boot warning); the 24 h `created_at` grace stays, so probes
  age rows with SQL.

### 6.16 Checkpoints and rewind (ADR-036)

Before every agent `write_file` / `edit_file` and before every server-side revert, rewind or undo, the previous state of
the file is stored content-addressed and journaled, so a chat's file changes can be rewound to any of its user
messages, reverted file by file (6.17), and every restore can itself be undone. No git is needed. Shell commands and
third-party tools are journaled but not restorable. Services: `services/checkpoints/` (`CheckpointService`), the
capture path in 6.13 (run scope, `journaledWrite`).

- **Journal** (`workspace_changes`, section 8): one row per change, in global order (`id`, inserted under the file
  lock, so per path it follows the write order): `chat_id`, `project_id`, `message_seq` (`coalesce(max(seq), 0)` of
  the chat's messages at insert time: the rewind watermark; the user message is committed before its run starts),
  `message_id` / `tool_call_id` (null for user operations), `batch_id` (`wcb_` + 16: one revert, rewind or undo),
  `kind` (`edit` | `revert` | `rewind` | `undo` | `shell` | `untracked`), `tool`, `path` (project-relative POSIX),
  `command` (shell rows, cut at 1,000 characters), the before-state (`before_state` `missing` | `stored` | `too-large`
  | `evicted`, `before_sha`, `before_size`, `before_mode`) and the after-state (`after_sha`, null = removed;
  `after_size`; only hashes, never content).
- **Blob store** (`checkpoints/<aa>/<sha256>` in the data directory, `DataPaths.checkpoints`): the raw before-bytes,
  deduplicated by sha256, folders 0700, files 0600, written to a temp file, fsynced, then renamed. Binary files are
  stored like text. It is a separate tree from `files/`: the file sweep deletes blobs that have no `files` row (6.15),
  and project content must never be reachable through `/api/files/:id`. No route serves it, and it is never in a
  backup, export or import.
- **Limits** (`LIMITS`, no settings key): `checkpointFileMaxBytes` 8 MiB (a bigger before-state is recorded as
  `too-large`: the edit still runs, the file just cannot be restored), `checkpointProjectMaxBytes` 512 MiB per project
  and `checkpointMaxAgeMs` 30 days.
- **Prune** (`prune.ts`): at boot (`checkpoints.start()`), every 6 hours (a chained `setTimeout(…).unref()` like the
  catalog cycle; `stop()` clears it) and 60 s after a `chat.deleted` (debounced). In order: evict blobs older than the
  age limit, then the oldest blobs of each project over its budget (the row stays with `before_state = 'evicted'`),
  unlink blobs that no `stored` row references and that are older than 1 hour, remove stale temp files. Concurrency:
  the store gate of `services/files/gate.ts` (`createStoreGate()`): writers hold it shared from the blob write to the
  row insert, prune holds it exclusive.
- **Lifecycle**: deleting a chat or a project deletes its rows (foreign keys with `ON DELETE CASCADE`; foreign keys are
  on); delete-all also calls `checkpoints.purge()` inside its maintenance operation (6.9); deleting a message version
  keeps the rows (the disk history is time-based, not branch-based); a chat moved to another project keeps its old
  rows, but every query filters on the chat's current project, so they are ignored. `DataSummary.checkpoints { bytes,
  blobs }` reports the store (optional).

**Rewind** ("Rewind files to here", UI.md 7.22) is time-based: "the files as they were when user message M was sent".

1. Scope: every file row of the chat in its current project with `message_seq >= M.seq`, on any branch (abandoned
   versions, an older message continued after M, earlier reverts and rewinds). Only user messages are targets (400
   otherwise). Edits of other chats are never undone; when they touched the same files they show as conflicts.
2. Plan (`plan.ts`, pure), per path: **target** = the before-state of the earliest row in the range, **expected** = the
   after-state of the latest row, **current** = the disk (a sha256 streamed through `openWorkspaceFile`, or missing).
   Actions: `unchanged` (current = target), `restore`, `delete` (the target is missing), `unavailable` (the target is
   `too-large` or `evicted`). **Conflict** = current ≠ expected (the file changed after the chat's last recorded
   change). The plan is idempotent: a second rewind sees its own rows and every file comes out `unchanged`.
3. Preview: `GET /chats/:id/rewind?messageId=` → `RewindPreview { messageId, files: { path, action, conflict, edits
   }[] (≤ 500), untracked: { shellCount, shell: { command, at, messageId }[] (≤ 50), tools: { tool, at, messageId }[]
   (≤ 50) }, truncated }`.
4. Apply: `POST /chats/:id/rewind { messageId, conflicts: 'skip' | 'force' }`. Refused with 409 `run-active`
   (`details.chatId`) while **any** chat of the project runs (`runs.hasRun`, the check of project deletion). Files are
   processed newest-edited first; each one under its file lock: read the current state again and re-check the conflict
   (skipped unless `force`), snapshot the current state, then write the target through `writeWorkspaceFile` (plus
   `chmod(before_mode)` when the file is re-created) or remove it through `workspace/remove.ts` (resolve, refuse
   `.git`, `lstat` a regular file, unlink), and insert a `rewind` row with the batch id. Folders the agent created stay.
   There is no multi-file transaction: every write is atomic and journaled right after it, so running the rewind again
   resumes it and undoing a partial batch works. Answer: `RestoreResult { batchId | null, restored[], deleted[],
   unchanged[], skipped: { path, reason: 'conflict' | 'unavailable' | 'refused' | 'failed', message }[] }`
   (`batchId` null = nothing was written).
5. The server never moves the conversation: "Restore files and edit" is a rewind followed by the existing edit flow of
   the web (a new version, ADR-023).

**Undo** (`POST /chats/:id/changes/undo { batchId, conflicts }`) restores the before-states of a batch's rows
(expected = their after-states) as a new batch of kind `undo`, with the same lock, conflict and 409 rules; so a revert,
a rewind and an undo can all be reversed.

**Events**: `workspace.changed { projectId, chatId | null, batchId | null, source: 'tool' | 'rewind' | 'revert' |
'undo', paths (≤ 200) }` after every batch that wrote something, and for agent edits (`source: 'tool'`, coalesced to at
most one event per second per chat), so the changes panel follows a run live.

**Errors**: the write routes answer 400 `validation_error` with the `openWorkspace` message for a chat without a
project or with an unavailable folder, 404 for an unknown chat, message or batch, 409 `run-active` as above; the read
routes answer `available: false` with a reason instead. No new conflict reason or error code.

### 6.17 Changes panel data and the git runner (ADR-037)

The changes panel (UI.md 7.21) reads the module `changes` (`http/routes/changes.ts`; none of its routes needs fresh
auth). Its "This chat" view comes from the journal (6.16) and needs no git; its "Git" view runs git through one
hardened runner.

| Route | Answer |
|---|---|
| `GET /chats/:id/changes` | `ChatChanges { available, reason: no-project \| folder-unavailable \| null, projectId, files: { path, status: added \| modified \| deleted \| unchanged, edits, changedOutside, revertible, added, removed, lastEditAt }[] (≤ 500, most recently changed first), truncated, untracked: { shellCommands, toolCalls } }`: per path, base = the earliest before-state, expected = the latest after-state, current = the disk; `changedOutside` = current ≠ expected; `revertible` = the base is stored or missing; the line counts only for the first 200 text files of at most 256 KiB (else null) |
| `GET /chats/:id/changes/diff?source=chat\|git&path=` | `FileDiff { source, path, origPath, status, binary, tooLarge, diff, currentSha, baseAvailable }` (`diff` null when binary, too large or the base is not available): `computeWorkspaceDiff` with its caps on sides of at most 1 MiB; binary = a NUL byte in the first 8 KiB or a failed `decodeText`; `currentSha` = the sha256 on disk (null when missing), which the web sends back as `expectedSha` |
| `GET /chats/:id/git` | `GitStatus { available, reason: no-project \| folder-unavailable \| git-missing \| not-a-repo \| refused \| timeout \| failed \| null, branch, head, prefix, files: { path, origPath, status: modified \| added \| deleted \| renamed \| untracked \| conflicted \| typechange, staged, unstaged }[] (≤ 2000), truncated }` |
| `POST /chats/:id/changes/revert` `{ source, path, expectedSha? }` | `RestoreResult` (one batch, undoable, 6.16); 409 `stale` when the disk is not `expectedSha` (`null` = the file was missing; omitted = no check), 409 `run-active` while any chat of the project runs |
| `POST /chats/:id/changes/undo` `{ batchId, conflicts }` | `RestoreResult` (6.16) |

**Revert** (`revert.ts`): `chat` → the base state (the file before this chat first changed it; a base that is
`too-large` or `evicted` cannot be restored, 400); `git` → the raw HEAD blob (mode 100755 stays executable); an
untracked or added file is deleted after a snapshot; a rename restores `origPath` and deletes `path`. Refused with 400:
conflicted files, symbolic links (mode 120000), submodules and paths whose `check-attr filter` is set (Git LFS and other
filters). The git index is never touched. Every path resolves through `resolveWorkspacePath`; every write goes through
the restore primitive of 6.16 (lock, snapshot, journal row, `workspace.changed`). There is no `force`: a revert whose
`expectedSha` no longer matches is refused, and the web shows the newer diff first.

**The git runner** (`workspace/git.ts`; complete and frozen since P8-0b; the only module that spawns git):

- `runGit(args, { cwd, signal })`: `spawn('git', args, { shell: false, detached: true })` with an argument array (never
  a shell string), killed with `killProcessGroup` (exported from `workspace/shell.ts`) on the abort signal and after
  15 s (`timeout`); stdout is capped at 8 MiB (`failed` beyond it).
- Environment: the shell's allowlist (`shell-env.ts`) plus `GIT_OPTIONAL_LOCKS=0` (`status` never writes the index),
  `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `LC_ALL=C` and `GIT_CEILING_DIRECTORIES` = the
  parent of the project's workspace root, so git never discovers a repository above the allowed root (in development
  never the harness-forge repository that holds `data/workspaces`); inherited `GIT_DIR`, `GIT_WORK_TREE` and
  `GIT_CONFIG_*` variables are dropped.
- Every call starts with `--no-pager -c core.fsmonitor=false -c core.hooksPath=/dev/null -c diff.external= -c
  core.pager=cat -c color.ui=false -c core.quotepath=false -c protocol.allow=never`. Filter drivers that the
  repository configures (`git config -z --name-only --get-regexp '^filter\.'`) are neutralized with `-c
  filter.<name>.clean= -c filter.<name>.smudge= -c filter.<name>.process=`; a sentinel test suite proves that no
  configured program runs (fsmonitor, `diff.external`, textconv, filter clean / smudge / process, `core.hooksPath`,
  `core.pager`, an `include.path` chain, inherited `GIT_DIR` / `GIT_CONFIG_*`), and when that cannot be guaranteed the
  answer is `refused`.
- Commands: `rev-parse --is-inside-work-tree --show-prefix --abbrev-ref HEAD` (the prefix maps repository paths to
  project paths: a project may be a subfolder of a repository); `status --porcelain=v2 -z --untracked-files=all
  --ignore-submodules=all -- .` from the project root (entries `1`, `2` (a rename with `origPath`), `u` (conflicted)
  and `?`; paths outside the prefix are dropped); `ls-tree -z HEAD -- <path>` (mode and blob id) and `cat-file -s` /
  `cat-file blob <oid>` (size and content). Paths from the model or the user resolve through `resolveWorkspacePath`
  first and always follow `--`. `git diff` is never run: a diff is the HEAD blob against the disk through
  `computeWorkspaceDiff` (untracked or added: empty against the file; deleted: HEAD against empty; renamed: HEAD of
  `origPath` against `path`; an unborn HEAD: everything added).
- Reasons: `git-missing` (`ENOENT` when spawning, cached for 60 s), `not-a-repo`, `refused` (git's "dubious ownership"
  check: `safe.directory` is **not** overridden, so a repository owned by another user, typically a Docker bind mount
  with another uid, stays refused; `docs/guides/using-projects.md` explains the fix), `timeout`, `failed`, plus
  `no-project` / `folder-unavailable` from the project checks.
- Spawn guard: `security/process-spawn.test.ts` fails when a non-test file other than `workspace/shell.ts`,
  `workspace/git.ts` and `mcp/stdio-transport.ts` imports `node:child_process`. Tests create repositories with `git
  init` inside `realpath(mkdtemp())` (author through `-c user.name` / `-c user.email`, `HOME` and `GIT_CONFIG_GLOBAL`
  pointed at the temp folder) and skip without git.

## 7. Data directory

```
data/                      HF_DATA_DIR (default ./data, resolved against the repo root in dev; /data in Docker)
  harness.db               SQLite database (WAL mode: also harness.db-wal, harness.db-shm)
  secret.key               master key when HF_MASTER_KEY is unset (32 random bytes, base64, mode 0600)
  plugins/<id>/            installed plugins (plugin.json, entry, assets); linked folders are recorded in the DB
  plugins/.staging/        in-progress installs and .prev copies (cleaned at boot)
  plugins/.data/<id>/      plugin private data (ctx.plugin.dataDir, 0700); kept on update, purged on uninstall
                           unless keepData
  files/<aa>/<sha256>      uploaded attachments and generated images, content-addressed (<aa> = first 2 hex chars
                           of the sha256)
  cache/                   models.dev snapshot refreshes (models-dev.json + fetched-at), misc caches
  cache/plugins/<id>/      compiled output of .ts code plugins (<sha256>.mjs), rebuilt on demand
  workspaces/              default workspace root (0700; Phase 7): project folders when HF_WORKSPACE_ROOTS is unset
  checkpoints/<aa>/<sha256>  before-states of project files changed by the agent or by a restore (Phase 8, 6.16;
                           folders 0700, files 0600; never served, never in a backup, not touched by the file sweep)
  secret.key.next          transient: the new master key during a rotation (0600; renamed over secret.key, 6.14)
  server.lock              { pid, hostname, port, startedAt } of the running server; removed at shutdown (6.14)
```

The directory is created with mode 0700 when missing. Backups: copy the whole directory while the server is
stopped (or use `sqlite3 .backup` for the DB); that is the full backup. Settings -> Data additionally exports a
portable zip of every chat and attachment (section 6.9), without keys, plugins or MCP servers. Losing `secret.key` (or
changing `HF_MASTER_KEY`) makes every stored secret unreadable and invalidates every share link (their tokens are
HMACs of the master key's `share` subkey); the server then reports affected providers as `not_configured` and logs a
warning, it does not crash. To replace the key on purpose, rotate it (Phase 7, 6.14): the secrets are re-encrypted and
nothing is lost. `workspaces/` holds project folders only when the default root is used; project folders elsewhere
(inside `HF_WORKSPACE_ROOTS`) are not part of the data directory, its backups or the Settings -> Data zip. A copied data
directory keeps its `projects` rows, whose paths may not exist on the new host (they show "Folder not found").
`checkpoints/` (Phase 8) belongs to the journal rows in the database: copy it together with the database; without it
the files whose earlier versions it held cannot be restored (rewind and revert skip or refuse them).

## 8. Data model

SQLite via Drizzle ORM 0.45 + `@libsql/client` (`apps/server/src/db/schema.ts`). Pragmas at connect:
`journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`; the busy timeout of 5000 ms is the libsql client
`timeout` option, so it applies to every pooled connection (the chat pipeline's commit and persist transactions wait
for a busy database instead of failing). In-memory test databases use a single connection: while a transaction is
open, a concurrent query fails fast (a background title write may then log a warning). Migrations are generated by
drizzle-kit (coordinator) into `apps/server/drizzle/` and applied with `migrate()` at boot.

Column conventions:

| Kind | SQLite type | Drizzle | Notes |
|---|---|---|---|
| id / text | `TEXT` | `text()` | |
| timestamp | `INTEGER` | `integer({ mode: 'number' })` | Unix epoch **milliseconds** (`Date.now()`) |
| boolean | `INTEGER` | `integer({ mode: 'boolean' })` | 0 / 1 |
| json | `TEXT` | `text({ mode: 'json' }).$type<T>()` | JSON text; `T` from `shared` / `plugin-sdk` |
| money | `REAL` | `real()` | USD |
| bytes | `BLOB` | `blob({ mode: 'buffer' })` | |

### Tables

**`settings`** — global settings (keys listed in API.md `Settings`) and internal keys (prefix `_`, never returned
by the API, e.g. `_auth.sessionEpoch`; Phase 7: `_keys` = `{ version, check, rotatedAt }`, the master-key state of
6.14, and `_files` = `{ lastCleanup }`, 6.15; Phase 8: `_files.lastAutoSweep` = `{ at, status, reason, files,
diskBytes }` of the automatic sweep, and the public key `fileSweep`).

| Column | Type | Constraints |
|---|---|---|
| `key` | text | PK |
| `value` | json | NOT NULL |
| `updated_at` | timestamp | NOT NULL |

**`secrets`** — every secret, encrypted (section 10).

| Column | Type | Constraints |
|---|---|---|
| `scope` | text | NOT NULL; `provider:<id>` \| `plugin:<id>` \| `mcp:<id>` \| `auth` |
| `name` | text | NOT NULL; e.g. `apiKey`, `settings.<key>`, `header.<Name>`, `env.<NAME>`, `password` |
| `ciphertext` | bytes | NOT NULL; `iv (12 B) \|\| AES-256-GCM ciphertext \|\| tag (16 B)` |
| `hint` | text | NULL; masked hint computed at write time (`sk-…9fQ2`), never the value |
| `key_version` | integer | NOT NULL DEFAULT 1; equals `_keys.version` after a rotation (6.14); a row of another version cannot be read |
| `updated_at` | timestamp | NOT NULL |
| | | PK (`scope`, `name`); index on `scope` via the PK prefix |

**`provider_configs`** — per-provider user configuration; a missing row means defaults (enabled, no options).

| Column | Type | Constraints |
|---|---|---|
| `provider_id` | text | PK |
| `enabled` | boolean | NOT NULL DEFAULT 1 |
| `options` | json `Record<string,string>` | NOT NULL DEFAULT `{}`; non-secret credential values (e.g. `baseURL`) |
| `status` | text | NULL; `ProviderStatus` computed at the last check |
| `last_error` | json `HarnessErrorInit` | NULL |
| `validated_at` | timestamp | NULL; last successful validation |
| `updated_at` | timestamp | NOT NULL |

**`model_cache`** — last good live listing per provider.

| Column | Type | Constraints |
|---|---|---|
| `provider_id` | text | PK |
| `models` | json `ModelInfo[]` | NOT NULL DEFAULT `[]` |
| `fetched_at` | timestamp | NULL; last successful fetch |
| `attempted_at` | timestamp | NOT NULL; last attempt (backoff) |
| `error` | json `HarnessErrorInit` | NULL; error of the last failed attempt |

**`model_prefs`** — user preferences and custom models.

| Column | Type | Constraints |
|---|---|---|
| `provider_id` | text | NOT NULL |
| `model_id` | text | NOT NULL |
| `hidden` | boolean | NULL; NULL = default from `classify()` |
| `favorite` | boolean | NOT NULL DEFAULT 0 |
| `alias` | text | NULL; display name override |
| `custom` | boolean | NOT NULL DEFAULT 0; user-added model id |
| `info` | json `ModelInfo` | NULL; metadata of custom models |
| `last_used_at` | timestamp | NULL; drives "recent" in the picker |
| `updated_at` | timestamp | NOT NULL |
| | | PK (`provider_id`, `model_id`) |

**`chats`**

| Column | Type | Constraints |
|---|---|---|
| `id` | text | PK; uuidv7 (client-generated) |
| `title` | text | NULL |
| `title_source` | text | NULL; `auto` \| `fallback` \| `user` |
| `model_ref` | text | NULL; last used model ref |
| `settings` | json `ChatSettings` | NOT NULL DEFAULT `{}` |
| `pinned` | boolean | NOT NULL DEFAULT 0 |
| `archived` | boolean | NOT NULL DEFAULT 0 |
| `pending_approval` | boolean | NOT NULL DEFAULT 0; the last message of the active path waits for an approval |
| `active_leaf_id` | text | NULL; last message of the shown path (ADR-023, 6.8); `null` = empty chat; no FK (see Migrations) |
| `project_id` | text | NULL; the chat's project (`prj_` + 16, Phase 7, ADR-031); `null` = no project; no FK (the project service detaches chats in a transaction, 6.13) |
| `created_at` | timestamp | NOT NULL |
| `updated_at` | timestamp | NOT NULL; last activity (a version switch does not change it) |
| | | index `chats_list_idx` (`archived`, `updated_at` DESC, `id` DESC); index `chats_project_idx` (`project_id`, `archived`, `updated_at` DESC, `id` DESC) for the project filter |

**`messages`**

| Column | Type | Constraints |
|---|---|---|
| `id` | text | PK; `msg_` + 16 chars |
| `chat_id` | text | NOT NULL; FK -> `chats.id` ON DELETE CASCADE |
| `parent_id` | text | NULL; the previous message of its path (`null` = a first message); siblings are versions (ADR-023, 6.8); no FK (see Migrations) |
| `seq` | integer | NOT NULL; creation order within the chat (0-based, unique; a parent's `seq` is lower than its children's) |
| `role` | text | NOT NULL; `user` \| `assistant` \| `system` |
| `parts` | json `UIMessage['parts']` | NOT NULL |
| `metadata` | json `MessageMetadata` | NULL |
| `selected_child_id` | text | NULL; the child last shown under this message (ADR-030, 6.8), a hint: `null` or a missing child means "the latest leaf"; no FK (see Migrations) |
| `search_text` | text | NOT NULL DEFAULT `''`; concatenated text parts, Unicode-normalized and lowercased (ADR-021), used by `GET /chats?q=`; not for display |
| `created_at` | timestamp | NOT NULL |
| `updated_at` | timestamp | NOT NULL; changes on approval continuations |
| | | unique index `messages_chat_seq_idx` (`chat_id`, `seq`); index `messages_chat_parent_idx` (`chat_id`, `parent_id`) |

**`usage`** — one row per model call (chat run, title generation, image generation, transcription or speech); kept
when a chat is deleted.

| Column | Type | Constraints |
|---|---|---|
| `id` | integer | PK AUTOINCREMENT |
| `chat_id` | text | NULL; FK -> `chats.id` ON DELETE SET NULL |
| `message_id` | text | NULL |
| `purpose` | text | NOT NULL DEFAULT `chat`; `chat` \| `title` \| `image` \| `transcription` \| `speech` (`UsagePurpose`, a TypeScript type: the Phase 6 values needed no migration; transcription and speech rows have `chat_id` null, 0 tokens and `cost_usd` null) |
| `provider_id` | text | NOT NULL |
| `model_id` | text | NOT NULL |
| `input` | integer | NOT NULL DEFAULT 0; input tokens |
| `output` | integer | NOT NULL DEFAULT 0; output tokens |
| `reasoning` | integer | NOT NULL DEFAULT 0; reasoning tokens (subset of output) |
| `cache_read` | integer | NOT NULL DEFAULT 0 |
| `cache_write` | integer | NOT NULL DEFAULT 0 |
| `cost_usd` | money | NULL; unknown price = NULL |
| `created_at` | timestamp | NOT NULL |
| | | indexes `usage_chat_idx` (`chat_id`), `usage_created_idx` (`created_at`) |

**`plugins`** — one row per known plugin (builtins get a row at first boot).

| Column | Type | Constraints |
|---|---|---|
| `id` | text | PK; plugin id = directory name |
| `source` | text | NOT NULL; `builtin` \| `created` \| `zip` \| `npm` \| `url` \| `link` \| `copy` |
| `source_ref` | text | NULL; npm spec, URL, linked absolute path, or zip file name |
| `version` | text | NOT NULL |
| `enabled` | boolean | NOT NULL DEFAULT 1; user intent |
| `trusted_hash` | text | NULL; trust pin (PLUGINS.md 13): sha256 hex of `plugin.json` + entry, or `path:` + sha256 of the realpath for `link` |
| `loading_since` | timestamp | NULL; boot sentinel |
| `last_error` | json `HarnessErrorInit` | NULL |
| `installed_at` | timestamp | NOT NULL |
| `updated_at` | timestamp | NOT NULL |

**`plugin_settings`** — non-secret settings values (settings with `format: 'secret'` live in `secrets`, scope
`plugin:<id>`, name `settings.<key>`). No FK, so `DELETE /plugins/:id?keepData=true` can keep the row.

| Column | Type | Constraints |
|---|---|---|
| `plugin_id` | text | PK |
| `values` | json `Record<string, unknown>` | NOT NULL DEFAULT `{}` |
| `updated_at` | timestamp | NOT NULL |

**`plugin_kv`** — `ctx.storage` (values <= 256 KB each, <= 10 MB per plugin). No FK (same reason).

| Column | Type | Constraints |
|---|---|---|
| `plugin_id` | text | NOT NULL |
| `key` | text | NOT NULL; <= 256 chars |
| `value` | json | NOT NULL |
| `updated_at` | timestamp | NOT NULL |
| | | PK (`plugin_id`, `key`) |

**`tool_prefs`**

| Column | Type | Constraints |
|---|---|---|
| `tool_name` | text | PK |
| `enabled` | boolean | NOT NULL DEFAULT 1 |
| `override` | text | NULL; `allow` \| `ask` \| `deny` |
| `updated_at` | timestamp | NOT NULL |

**`mcp_servers`** — user-configured MCP servers (owned by `core-mcp`). Header and env **values** are secrets
(`secrets` scope `mcp:<id>`, names `header.<Name>` / `env.<NAME>`); `transport` stores only their names.

| Column | Type | Constraints |
|---|---|---|
| `id` | text | PK; `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$` |
| `name` | text | NOT NULL |
| `transport` | json | NOT NULL; `{ type: 'http' \| 'sse', url, headerNames[] }` or `{ type: 'stdio', command, args[], envNames[] }` |
| `policy` | text | NOT NULL DEFAULT `ask`; `ToolPolicy` |
| `enabled` | boolean | NOT NULL DEFAULT 1 |
| `created_at` | timestamp | NOT NULL |
| `updated_at` | timestamp | NOT NULL |

**`files`** — upload metadata; bytes live in `data/files/<aa>/<sha256>` (deduplicated).

| Column | Type | Constraints |
|---|---|---|
| `id` | text | PK; `file_` + 16 chars |
| `sha256` | text | NOT NULL; lowercase hex |
| `name` | text | NOT NULL; sanitized original name (<= 255 chars) |
| `mime` | text | NOT NULL |
| `size` | integer | NOT NULL; bytes |
| `created_at` | timestamp | NOT NULL |
| | | index `files_sha256_idx` (`sha256`) |

**`projects`** — project folders (Phase 7, ADR-031, 6.13). Not in backups or exports; delete-all keeps them.

| Column | Type | Constraints |
|---|---|---|
| `id` | text | PK; `prj_` + 16 chars |
| `name` | text | NOT NULL; <= 80 chars |
| `path` | text | NOT NULL; the canonical realpath of the folder on the server host; unique index `projects_path_idx` |
| `instructions` | text | NULL; the project's own instructions (<= 20,000 chars), added after `AGENTS.md` / `CLAUDE.md` |
| `created_at` | timestamp | NOT NULL |
| `updated_at` | timestamp | NOT NULL |

**`workspace_changes`** — the checkpoint journal (Phase 8, ADR-036, 6.16): one row per change of a project file. Not in
backups or exports; deleted with its chat or project.

| Column | Type | Constraints |
|---|---|---|
| `id` | integer | PK AUTOINCREMENT; the global order (inserted under the file lock) |
| `chat_id` | text | NOT NULL; FK -> `chats.id` ON DELETE CASCADE |
| `project_id` | text | NOT NULL; FK -> `projects.id` ON DELETE CASCADE |
| `message_seq` | integer | NOT NULL; `coalesce(max(seq), 0)` of the chat's messages at insert time (the rewind watermark) |
| `message_id` | text | NULL; the assistant message of the run (a continuation keeps its id); null for user operations; no FK |
| `tool_call_id` | text | NULL; the tool call; null for user operations |
| `batch_id` | text | NULL; `wcb_` + 16 chars: one revert, rewind or undo |
| `kind` | text | NOT NULL; `edit` \| `revert` \| `rewind` \| `undo` \| `shell` \| `untracked` |
| `tool` | text | NULL; `write_file`, `edit_file`, `shell` or the plugin tool's name |
| `path` | text | NULL; project-relative POSIX path (null for `shell` and `untracked` rows) |
| `command` | text | NULL; `shell` rows only, cut at 1,000 characters |
| `before_state` | text | NULL; `missing` \| `stored` \| `too-large` \| `evicted` |
| `before_sha` | text | NULL; sha256 hex of the before-state (the blob name when `stored`) |
| `before_size` | integer | NULL; bytes |
| `before_mode` | integer | NULL; the file mode, restored when a file is re-created |
| `after_sha` | text | NULL; sha256 hex after the change; null = the file was removed |
| `after_size` | integer | NULL; bytes |
| `created_at` | timestamp | NOT NULL |
| | | indexes (`chat_id`, `path`, `id`), (`chat_id`, `message_seq`), (`project_id`, `id`), (`before_sha`) |

**`shell_rules`** — command prefixes that let `shell` calls run without a card (Phase 8, ADR-038, 6.13). Not settings,
not in backups; deleted with their project.

| Column | Type | Constraints |
|---|---|---|
| `id` | text | PK; `srl_` + 16 chars |
| `project_id` | text | NULL = a global rule; FK -> `projects.id` ON DELETE CASCADE; indexed |
| `prefix` | text | NOT NULL; the canonical prefix (<= 200 chars); unique per scope (checked by the service) |
| `created_at` | timestamp | NOT NULL |

**`chat_shares`** — read-only share links (ADR-025, 6.10). There is no token column: tokens are recomputed from the id.

| Column | Type | Constraints |
|---|---|---|
| `id` | text | PK; `shr_` + 16 chars |
| `chat_id` | text | NOT NULL; FK -> `chats.id` ON DELETE CASCADE; index `chat_shares_chat_idx` |
| `title` | text | NULL; a custom title of the share (`null` = the chat title at snapshot time) |
| `options` | json `ShareOptions` | NOT NULL; `{ reasoning, toolDetails, attachments }` |
| `snapshot` | json `ShareSnapshot` | NOT NULL; the sanitized active path; file URLs stored as `/api/files/<id>` |
| `file_ids` | json `string[]` | NOT NULL DEFAULT `[]`; the only files the share may serve |
| `message_count` | integer | NOT NULL DEFAULT 0; `user` and `assistant` messages in the snapshot (compared for `outdated`) |
| `snapshot_at` | timestamp | NOT NULL; when the snapshot was taken |
| `expires_at` | timestamp | NULL = never expires |
| `created_at` | timestamp | NOT NULL |
| `updated_at` | timestamp | NOT NULL |

### Migrations

| Migration | Content |
|---|---|
| `0000_initial_schema` | the 14 tables of v1 |
| `0001_message_tree_and_shares` (Phase 5) | table `chat_shares` + index `chat_shares_chat_idx`, `ALTER TABLE chats ADD active_leaf_id`, `ALTER TABLE messages ADD parent_id`, index `messages_chat_parent_idx`, then a hand-written backfill |
| `0002_remembered_versions` (Phase 6) | `ALTER TABLE messages ADD selected_child_id` (nullable, no FK, no index), then a hand-written backfill of every active path |
| `0003_refresh_model_listings` (Phase 6) | hand-written, no schema change: one ``UPDATE `model_cache` SET `fetched_at` = `fetched_at` - 86400000 WHERE `fetched_at` IS NOT NULL;`` that makes every successful cached provider listing stale |
| `0004_projects` (Phase 7) | generated: `CREATE TABLE projects`, unique index `projects_path_idx`, ``ALTER TABLE `chats` ADD `project_id` text`` (nullable, no FK), index `chats_project_idx`; no backfill |
| `0005_workspace_checkpoints` (Phase 8) | generated: `CREATE TABLE workspace_changes` and `CREATE TABLE shell_rules` with their indexes; no change to an existing table, no backfill |

The backfill turns every existing chat into a linear chain: each message's parent is the previous message by `seq`,
and the active leaf is the last message (`null` for an empty chat):

```sql
UPDATE `messages` SET `parent_id` = (SELECT p.`id` FROM `messages` p WHERE p.`chat_id` = `messages`.`chat_id`
  AND p.`seq` < `messages`.`seq` ORDER BY p.`seq` DESC LIMIT 1);
UPDATE `chats` SET `active_leaf_id` = (SELECT m.`id` FROM `messages` m WHERE m.`chat_id` = `chats`.`id`
  ORDER BY m.`seq` DESC LIMIT 1);
```

Why the two new columns have no foreign keys: drizzle-kit writes `ALTER TABLE … ADD … REFERENCES` without the
`ON DELETE` clause, and a `chats.active_leaf_id -> messages.id` key would break chat deletion, which removes a chat's
messages before the chat. Both columns are nullable without a default, so SQLite adds them in place. A generated
migration that rebuilds a table (`DROP TABLE`, `__new_…`) is rejected at review: foreign keys are on, and the rebuild's
`DROP` would cascade-delete messages inside the migration transaction. `migrate()` applies a migration in one
transaction, so a half-done backfill cannot happen; `db/upgrade.test.ts` migrates a v1-shaped database through `0001`
(and fails when the backfill is missing).

`0002` (Phase 6, ADR-030) adds `messages.selected_child_id` the same way (nullable, no default, no foreign key: it is a
hint that may name a deleted child) and records every chat's active path, so switching away and back after the upgrade
restores what the user saw:

```sql
WITH RECURSIVE path(chat_id, id, parent_id, seq) AS (
  SELECT m.chat_id, m.id, m.parent_id, m.seq FROM chats c JOIN messages m ON m.chat_id = c.id AND m.id = c.active_leaf_id
  UNION ALL SELECT p.chat_id, p.id, p.parent_id, p.seq FROM messages p
  JOIN path ON p.id = path.parent_id AND p.chat_id = path.chat_id AND p.seq < path.seq)
UPDATE messages SET selected_child_id = path.id FROM path
WHERE messages.id = path.parent_id AND messages.chat_id = path.chat_id;
```

Only the parents on active paths get a pointer; every other message keeps `null` (its latest leaf wins until it is
shown). The generated SQL must be exactly one `ALTER TABLE … ADD` (a `DROP TABLE`, `__new_` or `PRAGMA foreign_keys`
statement is rejected) and is never regenerated after the hand edit; `db/upgrade.test.ts` migrates a database holding
only `0000` + `0001` with branched chats and fails when the backfill is missing.

`0003` (Phase 6, added at the P6-A gate) changes no schema. v1.2 changes what a provider listing contains (media model
ids with their kinds, image output from the listing's output modalities, e.g. OpenRouter's `output_modalities`, new
seed models of the builtin plugins), and the catalog refreshes a cached listing only when it is older than 24 hours:
without the migration a listing cached by v1.1 would hide those models for up to a day (the e2e server's cached mock
listing hid the new chat seeds `mock:image-chat` and `mock:image-tool`). The migration therefore ages every successful
listing by one listing TTL (`fetched_at - 86400000`) once, so it counts as stale at the first start of v1.2 and is
fetched again in the catalog's first background cycle, while it stays the last good listing the catalog serves (a
failed refresh keeps it). Rows without a successful fetch (`fetched_at` null: "never listed") are left alone. The UI
shows such a listing as one day older than it is until the refresh. `db/upgrade.test.ts` checks that `0003` is exactly
that one `UPDATE`, that it keeps the cached models and ages `fetched_at` by the TTL, and that never-fetched rows stay
null.

`0004` (Phase 7, ADR-031) adds the table `projects` and the column `chats.project_id` the same way: nullable, without a
default and without a foreign key (a key to `projects.id` would need an `ON DELETE SET NULL` that drizzle-kit does not
write for an added column, and a rebuild of `chats` is refused), so SQLite adds it in place and every existing chat
starts without a project. The generated SQL must be exactly the `CREATE TABLE`, the two `CREATE … INDEX` and the `ALTER
TABLE … ADD` statements (a `DROP TABLE`, `__new_` or `PRAGMA foreign_keys` statement is rejected);
`db/upgrade.test.ts` migrates a database holding only `0000` … `0003` with chats and checks that they survive with
`project_id` null. Key rotation and the file cleanup need no columns: their state lives in the internal settings `_keys`
and `_files`.

`0005` (Phase 8, ADR-036 / ADR-038) only creates the two new tables. Because they are new, their foreign keys can carry
`ON DELETE CASCADE` (to `chats` and `projects`; foreign keys are on), so deleting a chat or a project removes its
journal rows and rules without service code; nothing references them. The generated SQL must be only `CREATE TABLE` and
`CREATE … INDEX` statements (a `DROP TABLE`, `__new_` or `PRAGMA foreign_keys` statement is rejected);
`db/upgrade.test.ts` migrates a database holding `0000` … `0004` and checks 18 tables, the old data intact and the
cascades. Every text column of both tables is listed in `UNSCANNED_COLUMNS` of `services/data/references.ts` (ids,
paths, commands and hashes, never a `data/files` id), so the schema-coverage test of the file cleanup stays green.

Not stored in the DB: sessions (stateless HMAC cookie), active runs and resume buffers (memory), plugin logs
(memory ring buffer), SSE subscribers (memory), share tokens (recomputed from the share id), rate-limit counters and
the maintenance lock (memory; Phase 7, it replaced the import / delete-all mutex), the file cleanup's pins (memory),
the running server's identity (`server.lock` in the data directory), and (Phase 6) recordings, transcripts and speech
audio or text, which only pass through (10.8). Generated images are stored as files like uploads. Project folders are
files on the host, never copied into the database. Phase 8: the per-file locks and the run scopes (memory), the sticky
shell folder (derived from the stored shell outputs) and the checkpoint blobs (`checkpoints/`, the rows hold only
hashes).

## 9. Model catalog

Summary; the full rules (per-provider listing quirks, seeds, reasoning mapping) are in
[PROVIDERS.md](./PROVIDERS.md).

| Source | Where | Refresh |
|---|---|---|
| Live listing | provider `listModels()` (declarative: `GET {baseURL}/models`, Ollama `/api/tags`) | cached 24 h in `model_cache`; background refresh when stale; last good kept on failure; forced by `POST /providers/:id/models/refresh` and after credentials change |
| models.dev | bundled `apps/server/assets/catalog/models-dev.json` (key = `ProviderDefinition.modelsDevId ?? id`) | weekly refresh into `data/cache/models-dev.json` unless `HF_OFFLINE=1`; `pnpm catalog:update` refreshes the bundled copy |
| Seeds | `ProviderDefinition.seedModels` | static |
| Plugin models | manifest `contributes.models`, `ctx.models.register()` | while the plugin is active (held until the provider is registered) |
| Custom ids | `model_prefs` rows with `custom = 1` | user (`POST /custom-models`) |

- **Entry set** per provider: the live listing (the seeds when there is no successful listing: no `model_cache` row, or
  `fetched_at` null) + plugin models + custom ids. Phase 6: seeds with an explicit media kind (`image`, `transcription`,
  `speech`) are always listed, even next to a live listing, so the media models of a provider exist whatever its
  `/models` endpoint returns. Then every entry of a media kind whose factory the provider does not define
  (`createImageModel`, `createTranscriptionModel`, `createSpeechModel`) is left out, whatever layer it came from
  (listing, seed, plugin model; its kind may come from models.dev), so Settings → Media never offers a model that cannot
  be served (for example `alibaba:qwen3-asr-flash`, a transcription model for models.dev, while Alibaba defines no
  transcription factory); user custom models stay listed (the resolvers explain the error, 6.11, 6.12). After migration
  `0003` every successful cached listing is one TTL older, so it is stale and refreshed at the first start while it
  stays served meanwhile (section 8).
- **Field precedence** per model: user custom -> live provider data -> models.dev -> seed (seeds and plugin models
  share the last tier).
- **Kinds** (`ModelKind` = `chat | embedding | image | audio | transcription | speech | other`), decided by `classify()`
  (`catalog/classify.ts`) in this order (Phase 6):
  1. the id regex `/(?:^|\/)(?:gpt-image|chatgpt-image|dall-e|imagen|grok-imagine-image)/i` → `image` (models.dev lists
     `gpt-image-1-mini`, `gpt-image-1.5` and `chatgpt-image-latest` with a text and image output, so modalities alone
     would call them chat models; ids that merely contain "image", such as Gemini's `*-image` chat models, are not
     matched);
  2. models.dev modalities when known: no text output → `image` (image output), `speech` (audio output with a text
     input), `audio` (other audio output) or `other`; a text output with inputs that do not include text →
     `transcription` (audio input) or `other`; embedding, moderation and rerank ids → `embedding` / `other`; everything
     else with text in and text out → `chat`;
  3. without modalities, the id alone: the id regex of step 1 → `image`, `embed` → `embedding`, `tts` → `speech`,
     `whisper|transcri` → `transcription`, other `audio` → `audio`, `moderation|rerank` → `other`, else `chat` (an id
     that merely contains "image" is a chat model: providers give their image-output chat models an explicit kind).
  An explicit `kind` of any layer (custom, live, plugin or seed, in the field precedence order) wins over `classify()`.
- **Image output** (`capabilities.imageOutput`, chat models only; a dedicated image model is `kind: 'image'` instead):
  from the first layer that sets it: a custom model's "Image output" checkbox, the live listing (Google marks
  `gemini-*-image` and `nano-banana*`, OpenRouter reads `architecture.output_modalities`; both give these models the
  explicit kind `chat`), models.dev (a text and image output), then seeds and plugin models.
- **Visibility** (the default of `hidden`; `model_prefs.hidden` true/false overrides it): chat models are visible, image
  models are visible when their provider defines `createImageModel` (the composer's "Image models" group), and every
  other kind is hidden. Transcription and speech models are never offered by the chat picker; Settings → Media lists
  them with `includeHidden` (UI.md 9.9). `ModelInfo.voices` becomes `CatalogModel.voices` (names of 1–64 characters,
  unique, at most 100; the first layer that has a list wins). `stats().modelCount` (the provider list's model count)
  counts visible chat models only.
- **Chat-only choices**: the credential ping (`validate` without a listing) uses `smallModelId`, else the first chat
  seed, else the first visible chat model, never a media model; `resolveModel` refuses image models. In the web the
  default model of new chats and the default and title model selects of Settings → Models take chat models only
  (UI.md 9.3, 11), and an image turn never asks its image model for a chat title (6.11).
- **Picker order**: favorites -> recent (`model_prefs.last_used_at`) -> by provider (registry order), then name; the
  "Image models" group follows the provider groups.
- **Cost** (`costUsd`): provider-reported cost when available (OpenRouter), else catalog prices (USD per 1M tokens):
  non-cached input x `cost.input` + cache reads x `cost.cacheRead` + cache writes x `cost.cacheWrite` + output
  (reasoning included) x `cost.output`. Unknown price -> `costUsd` omitted. Image generations (Phase 6) cost (input
  tokens x `cost.input` + output tokens x `cost.output`) / 1,000,000 of the image model, rounded to 1e-10, and are shown
  as estimates; no catalog price, no reported token counts (xAI) or a used token kind without a price gives no cost
  (6.11); transcription and speech rows carry no cost.
- Changes emit `catalog.changed` (`{ providerId? }`); the web refetches `GET /api/models`.

## 10. Security model

Threat model: a single trusted user; the server may be reachable from a LAN or the internet behind a reverse proxy;
attackers may control web pages the user visits (CSRF/XSS), model output (prompt injection), MCP servers and
third-party plugins. Multi-user isolation is out of scope (ADR-012).

### 10.1 Authentication and sessions

| Topic | Rule |
|---|---|
| Password | Optional. Source: `HF_PASSWORD` (wins) or a hash stored in `secrets` (scope `auth`, name `password`), set with `PUT /api/auth/password`. Hash = scrypt (N = 2^15, r = 8, p = 1, 32-byte key, 16-byte random salt, `maxmem` 64 MB), encoded `scrypt$15$8$1$<salt b64>$<hash b64>`. `HF_PASSWORD` is hashed in memory at boot; comparisons use `timingSafeEqual`. |
| No password | Every request is authenticated. Allowed only on a loopback bind unless `HF_INSECURE=1`. |
| DNS-rebinding guard | Without a password, `/api` answers `403 forbidden` to any request whose `Host` is not `localhost`, `*.localhost` or a loopback IP (unless `HF_INSECURE=1`): a web page whose DNS name is rebound to 127.0.0.1 would otherwise be same-origin with itself and drive the whole API. With a password every host name is allowed (sessions protect it). The guard reads only `Host`, never `X-Forwarded-Host` (10.6), and also covers the public share routes: exposing share links requires a password. |
| Bind safety | At boot, `HF_HOST` outside `127.0.0.0/8`, `::1`, `localhost` requires a configured password (`HF_PASSWORD` or one stored in the data directory) or `HF_INSECURE=1` (else exit 1). At runtime, removing the password while bound to a non-loopback host is rejected (`409 conflict`). |
| Session cookie | Name `hf_session`; value `v1.<payload b64url>.<HMAC-SHA256 b64url>` signed with the HKDF `session` subkey; payload `{ iat, exp, authAt, epoch }` (ms). Attributes: `HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` (30 days) plus `Secure` when the request is HTTPS (`X-Forwarded-Proto: https` counts: only from a trusted proxy when `HF_TRUST_PROXY` is set, from any peer when it is unset; 10.6). Re-issued when older than 24 h (rolling). |
| Revocation | `epoch` must equal the internal setting `_auth.sessionEpoch`; changing or removing the password increments it, which invalidates every session (the caller gets a fresh cookie). Logout clears the cookie. Phase 7: a master-key rotation also invalidates every session (cookies are signed with the `session` subkey; the rotating caller gets a new cookie that keeps its `authAt`), and both the rotation and a password change close every event stream (`events.disconnectAll()`, 6.14). |
| Fresh auth | ADR-017. When a password is set, sensitive operations require `now - authAt <= 10 min`, else `403 forbidden` with `action: 'login'` (the web asks for the password — inline in the install and trust dialogs, else in `ConfirmPasswordDialog` — calls `POST /api/auth/login` and retries): installing a plugin that requires trust (code or stdio MCP, with or without `trust`), `POST /api/plugins/:id/trust`, scaffolding a code plugin, `POST /api/plugins/:id/build`, `POST /api/plugins/:id/reload` of a code plugin, writing or deleting files of a plugin that runs code (`PUT` / `DELETE /api/plugins/:id/files/*`), creating or changing a stdio MCP server (also inside a created declarative plugin), `PUT /api/auth/password`, creating or updating a share link (`POST /api/shares`, `PATCH /api/shares/:id`), deleting all data (`POST /api/data/delete`) and, since Phase 7, creating a project (`POST /api/projects`) and rotating the master key (`POST /api/keys/rotate`). The window is 10 minutes, so the editor asks at most once per window; such an editor save also re-pins a trusted `created` plugin (10.4). |
| Login rate limit | Failed password checks (`POST /api/auth/login` and the current-password check of `PUT /api/auth/password`): 5 per 15 min per client address and 50 per 15 min globally, then `429 rate_limited` with `retryAfterMs` and a `Retry-After` header. A successful login resets the per-address counter. The client address is the TCP peer, or, when the peer is a proxy listed in `HF_TRUST_PROXY`, the client named by `X-Forwarded-For` (10.6); a forwarded header from any other peer is ignored because any client can forge it. **Without `HF_TRUST_PROXY`** every client behind a proxy shares the proxy's address, so 5 failed attempts from anyone lock out every client (including you) for up to 15 minutes: set `HF_TRUST_PROXY` for your proxy, and limit access at the proxy (IP allow list, VPN, basic auth) when the server is reachable from the internet. The global cap stays the backstop against forged addresses. |
| Public endpoints | `GET /api/health`, `GET /api/auth/status`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/icons/lobe`, `GET /api/icons/lobe/:slug`, the share routes `GET /api/share/:token` and `GET /api/share/:token/files/:fileId` (a valid share token is the credential; rate-limited; 10.7), and the SPA static files (the `/share/<token>` page is a client route of the SPA). Everything else returns `401 unauthorized` without a valid session. |

### 10.2 CSRF and headers

- **Origin check** on every non-`GET`/`HEAD`/`OPTIONS` request under `/api`: if `Origin` is present it must equal the
  server origin (the request scheme of 10.6 + `Host`; `X-Forwarded-Host` never counts) or, in development,
  `http://localhost:3000` / `http://127.0.0.1:3000`; if `Origin`
  is absent, `Sec-Fetch-Site` must be absent, `same-origin` or `none`. Violations -> `403 forbidden`. Non-browser
  clients (curl) without these headers pass; they cannot ride on the user's cookie. Together with
  `SameSite=Strict` this closes CSRF. No CORS headers are ever sent.
- **Secure headers** (all responses): `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`,
  `Permissions-Policy: camera=(), microphone=(self), geolocation=()`, `X-Robots-Tag: noindex, nofollow` (Phase 5: keeps
  share links and everything else out of search engines), `Strict-Transport-Security: max-age=31536000` only over
  HTTPS (`X-Forwarded-Proto: https` counts under the rule of 10.6). `microphone=(self)` (Phase 6, ADR-029; v1.1 sent
  `microphone=()`, which blocked dictation) lets only the app's own origin ask for the microphone; no frame or other
  origin can, and the browser still asks the user.
- **CSP for the SPA HTML**: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' <sha256 hashes of the inline
  scripts of the served HTML document, recomputed when the file changes>; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:;
  object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. `'wasm-unsafe-eval'` only allows
  compiling WebAssembly (the syntax highlighter of code blocks), not JavaScript `eval`. Remote images in model output
  are therefore blocked (no data exfiltration through image URLs); the markdown renderer shows them as links.
  `media-src 'self' blob:` (Phase 6) lets read-aloud play the audio it fetched (object URLs of the speech responses);
  without it `media-src` falls back to `default-src 'self'` and blob audio would be blocked. Generated images are
  same-origin files (`img-src 'self'`).
- **CSP for API responses**: `default-src 'none'; frame-ancestors 'none'`; icons, files and share files use their own
  CSP (API.md).

### 10.3 Secrets at rest

- Master key: `HF_MASTER_KEY` (base64, 32 bytes) or `data/secret.key` (generated with `crypto.randomBytes(32)`,
  mode 0600; the server refuses to start if the file is group/world readable).
- Subkeys: HKDF-SHA256(masterKey, salt `harness-forge/v1`, info `encryption` | `session` | `approval` | `share`,
  32 bytes). `approval` feeds `experimental_toolApprovalSecret`; `share` signs share tokens (10.7), so a new master
  key invalidates every share link.
- Encryption: AES-256-GCM, random 12-byte IV per write, AAD = UTF-8 of `<scope>/<name>` (a ciphertext copied to
  another row fails to decrypt), stored with `key_version`.
- Key check and rotation (Phase 7, ADR-034, 6.14): the internal setting `_keys = { version, check, rotatedAt }` holds
  the HMAC of the `encryption` subkey over `harness-forge/key-check/v1`, so the server can tell a wrong key from a
  damaged row (`GET /keys` → `keyCheck`). Online rotation (file mode, fresh auth, typed `ROTATE`) writes the new key to
  `secret.key.next` first, re-encrypts every readable row to `key_version` V+1 in one transaction, then renames the
  file over `secret.key` and swaps the live keyring; a crash at any step is resolved at the next boot by comparing both
  files with the check. With `HF_MASTER_KEY` the rotation is offline only (`rotate-key` CLI, the new key from
  `HF_NEW_MASTER_KEY`, never generated or printed). A rotation invalidates every session, share URL and pending
  approval (all keyed by subkeys), and v1.2 cannot read the secrets afterwards (no downgrade).
- The secrets API is **write-only**: credentials, plugin secret settings, MCP headers/env are never returned; DTOs
  carry `{ set, hint, source }` only. Values are decrypted only in memory at the point of use (provider call, MCP
  connect, `ctx.secrets.get` of the owning plugin).
- Logs and error messages pass through a redactor (known secret values, `Authorization`, `x-api-key`, `api-key`,
  `cookie` headers, `sk-...`-like tokens).

### 10.4 Plugins, tools and outbound requests

- **Trust**: code plugins and stdio MCP declarations run with the server's privileges. They load only when
  `trusted_hash` equals sha256 of `plugin.json` + entry file; any change (update, edit, hot reload of an unpinned
  file) makes them `untrusted` until re-trusted. Plugins created in the browser (`source = created`) are re-pinned
  automatically when a file is saved or deleted through the in-browser editor (`PUT` / `DELETE
  /api/plugins/:id/files/*`, ADR-017), as long as they were trusted before that edit, and by
  `POST /api/plugins/:id/build` (a fresh-auth operation); files changed on disk still require an explicit Trust.
  The editor never opens `.git` or `node_modules` and cannot create or change hidden files. Linked folders
  (`source = link`) pin trust to the realpath: content changes under a trusted linked path hot-reload without
  re-trust (developer workflow).
- **Guards**: every call into plugin code runs through `guard()` (setup 10 s, dispose 5 s, hooks 3 s, tools
  default 60 s); failures become `plugin_error`; 5 consecutive hook failures disable that handler;
  `unhandledRejection` is logged, never fatal. `HF_SAFE_MODE=1` loads builtins only.
- **Filesystem**: every path from user input (plugin files API, install extraction, linked folders) is resolved
  with `realpath` and must stay inside its root; relative POSIX paths only, no `..`, no absolute paths, no
  backslashes, no NUL. Phase 7: paths of the workspace tools (which may be absolute inside the project) go through
  `resolveWorkspacePath` (6.13); project folders must sit inside `HF_WORKSPACE_ROOTS` and away from the data dir (10.9).
- **SSRF guard** (`security/ssrf.ts`, used by `web_fetch` and URL installs): `http:`/`https:` only; DNS-resolve and
  reject loopback, private (RFC 1918), link-local (incl. `169.254.169.254`), CGNAT, multicast, unspecified,
  IPv6 ULA / link-local and IPv4-mapped forms of these; connect to the checked IP (no re-resolve); at most 5
  redirects, each re-checked; 10 s timeout; response body capped (2 MB for `web_fetch`, 20 MB for installs).
  The `core-tools` setting "Allow localhost in web_fetch" (default off) lets `web_fetch` reach loopback addresses
  only; private, link-local and metadata addresses stay blocked. Provider base URLs are exempt (local providers such
  as Ollama are legitimate) but are set only by the user or a plugin manifest they reviewed.
- **Limits**: JSON bodies 1 MB (plugin file writes: 1 MB of content, the JSON body up to twice that + 64 KiB for
  string escaping; chat requests 2 MB, chat imports 20 MB), uploads
  20 MB per file (`image/*`, `application/pdf`, `text/*`), plugin zips 20 MB compressed / 100 MB expanded / 2000
  entries, tool output 64 KB, chat title 200 chars; data imports 256 MiB + 64 KiB (a backup zip or a chat JSON; 64 MiB
  per chat entry, 20 MiB per file entry, 50,000 entries, 6.9); share snapshots 10 MiB, with each tool input or output
  cut at 16,384 characters and each error text at 4096 (6.10); Phase 6: a dictation recording 64 bytes to 25 MiB (the
  body limit of `POST /audio/transcriptions` is 25 MiB + 64 KiB), a speech request 4,096 characters, an image prompt
  32,000 characters, 1–4 images per turn and at most 4 input images, a generated image 20 MiB, the `revisedPrompt` of a
  `generate_image` output 16 KB of JSON (6.11, 6.12); Phase 7: 200 projects, project names 80 characters, paths 4096
  characters, 500 browse entries, a project file of 32 KiB, the workspace tool limits of 6.13 (reads 48 KiB per call,
  writes 256 KiB, edits on files up to 1 MiB, a shell command 16 KiB, a shell timeout of at most 590 s, each stored
  output about 60 KiB), and at most 200 steps per run (`maxSteps`, `projectMaxSteps`). A
  non-empty body of a JSON route must be `application/json` (multipart routes also accept `multipart/form-data`), so
  HTML forms cannot post to the API.

### 10.5 XSS rules (web)

- `v-html` is forbidden (lint rule). Model output, tool output, plugin strings and file names render as text or
  through `Markdown.vue`, which uses markstream-vue with `html-policy="escape"` (raw HTML is escaped, not parsed).
- Links in markdown: only `http:`, `https:`, `mailto:`; `target="_blank" rel="noopener noreferrer"`.
- Icons are never inlined: mono icons via CSS `mask-image` on a `<span>`, color icons via `<img>`; both point at
  server URLs (`/api/icons/lobe/<slug>`, `/api/plugins/<id>/icon`) served with a restrictive CSP.
- Uploaded files are served with `nosniff`, a sandboxing CSP (not for PDF) and `Content-Disposition: attachment`
  except raster images and PDF (API.md, `GET /files/:id`); share links serve them the same way (10.7).

### 10.6 Trusted reverse proxies (ADR-026)

`HF_TRUST_PROXY` is a comma-separated list of `loopback` (127.0.0.0/8, ::1), `private` (10.0.0.0/8, 172.16.0.0/12,
192.168.0.0/16, fc00::/7), IP addresses and CIDR ranges. Unset keeps the v1 behavior. `security/proxy-trust.ts` parses
it at boot into canonical entries (`Env.trustProxy`): keywords lowercase, IPv6 lowercase and compressed, IPv4-mapped
IPv6 written as IPv4 (`::ffff:a.b.c.d/96` or longer is the IPv4 range it maps), a `/32` or `/128` range written as its
address, duplicates and empty items dropped. Refused with an `EnvError` that explains the format (the boot exits with
code 1):

- boolean-like words (`true`, `false`, `yes`, `no`, `on`, `off`, `all`, `any`, `everyone`, `*`), hop counts (any
  number, `1` included) and `/0` ranges (`::ffff:0.0.0.0/96` included): each would trust every peer, so anyone who
  reaches the port directly could forge `X-Forwarded-For`;
- prefix lengths above 32 (IPv4) or 128 (IPv6), and unknown tokens: host names, ports, brackets, zone ids, IPv4 with
  leading zeros; `localhost` gets its own hint ("use loopback");
- a list that names no proxy (only commas; an empty value counts as unset).

The matcher is a `node:net` `BlockList` compiled once per list; addresses are normalized (IPv4-mapped IPv6 as IPv4)
before every check.

| Header | Honored when | Effect |
|---|---|---|
| `X-Forwarded-For` | the TCP peer is trusted | client address = the list walked right to left, skipping trusted hops: the first untrusted entry is the client; a malformed entry or the 32-entry limit stops the walk at the last well-formed address seen (a trusted hop), so a forged or broken header never yields an arbitrary string |
| `X-Forwarded-Proto` | with `HF_TRUST_PROXY` set: only from a trusted peer; unset: from any peer (v1) | its first value (`http` or `https`) is the request scheme: the `Secure` session cookie, HSTS, the scheme of the Origin check |
| `X-Forwarded-Host` | never | proxies must forward the original `Host` |
| `Forwarded` | never | ignored |

- The client address (`clientAddress(c, deps.env)`) keys the login rate limiter (10.1) and the share rate limits
  (10.7); failed-login warnings log both the resolved `address` and the TCP `peer`; the access log records no
  addresses.
- `X-Forwarded-Host` is never honored, neither by the Origin check nor by the password-less host guard: a DNS-rebinding
  page is same-origin with itself, reaches the server from 127.0.0.1 and can set any header, so with `loopback` trusted,
  honoring it would bypass the guard. Caddy and Traefik forward `Host` by default; nginx needs `proxy_set_header Host
  $host`.
- Logs: with `HF_TRUST_PROXY` set, the boot log line `trusting reverse proxies (HF_TRUST_PROXY)` carries `trustProxy`
  (the canonical entries) and `ranges` (keywords expanded). A request whose TCP peer is not trusted but that carries a
  forwarded header the server would honor from a trusted proxy is logged once per peer address (`warn`, fields `peer`
  and `headers`: the header names, never their values), a hint that `HF_TRUST_PROXY` is missing or too narrow. Unset,
  only `X-Forwarded-For` counts: "X-Forwarded-For ignored: HF_TRUST_PROXY is not set. Behind a reverse proxy, set
  HF_TRUST_PROXY to its address (for example loopback) so the login rate limit sees the real clients." Set, also
  `X-Forwarded-Proto`: "Forwarded headers ignored: the peer is not listed in HF_TRUST_PROXY." At most 256 peer
  addresses are remembered; after them one last warning says "Further peers sending ignored forwarded headers are not
  logged."
- Unset, `X-Forwarded-Proto` is still honored from anyone: harmless, because browsers ignore HSTS over plain HTTP and a
  cross-site page cannot send the header without a failing preflight.
- Misconfiguration: `private` on a LAN where other machines reach :8787 directly lets them choose their limiter bucket
  with a forged `X-Forwarded-For`. Prefer the proxy's exact address; the global cap (50 failures per 15 min) stays the
  backstop.

### 10.7 Share links (ADR-025)

- The public routes answer the same `404 not_found` ("This share link is unavailable.") for a malformed, bad-MAC,
  revoked or expired token, for a deleted chat (re-checked on every request) and for a file outside the share; they
  check the token themselves, so a malformed one is a 404 too, never a 400. The MAC comparison is timing-safe. The view
  answers with `Cache-Control: no-store`.
- `GET /api/share/:token/files/:fileId` serves only ids listed in the share's `file_ids`, and only while the share's
  `attachments` option is on, with `Cache-Control: no-store` (no `ETag`: a revoked link stops serving at once),
  `X-Content-Type-Options: nosniff`, the CSP of `GET /api/files/:id` (sandboxed except for PDF) and
  `Content-Disposition: inline` only for raster images and PDF (`attachment` otherwise); `HEAD` is supported (the file
  is released at once). The session-only `GET /api/files/:id` is never used by the share page. GET routes write
  nothing (no view counters).
- Rate limits (memory, one sliding-window limiter per app, `429 rate_limited` with `retryAfterMs` + `Retry-After`):
  views 60 per minute per client address, files 600 per minute per address, 20 refused tokens per 10 minutes per
  address (the address is then refused on both routes until the oldest refusal leaves the window), 6000 requests per
  minute over both routes and every address. A refused (429) request is not counted. Only failures about the token
  (malformed, bad MAC, revoked, expired, deleted chat) count as refused tokens; a file-only failure (an id outside the
  share, a malformed file id, attachments off, a missing blob) does not. Behind a proxy the client address follows
  10.6 (`clientAddress(c, deps.env)`).
- `X-Robots-Tag: noindex, nofollow` is on every response and the share page adds `robots` and `referrer` meta tags;
  `Referrer-Policy: no-referrer` keeps the token out of `Referer` headers when a visitor follows a link.
- Tokens never reach logs: the access log and the error handler log the path with the segment after `/share/` masked,
  whatever its shape (`/api/share/[redacted]/files/<id>`, `/share/[redacted]`), and `redactText` masks
  `/share/<token>` (also with `%2F` separators) in any other logged text and in error messages (12).
- The password-less host guard (10.1) is unchanged: without `HF_PASSWORD` the share routes answer only on local host
  names, so exposing share links requires a password (the Share dialog warns when there is none).
- Snapshots are sanitized by an allowlist (6.10), so a new AI SDK part type is dropped rather than leaked; the view
  and the file route apply the share's options on every request.

### 10.8 Privacy of media (Phase 6, ADR-028, ADR-029)

- **Opt-in**: no image, transcription or speech model is chosen automatically. `imageModelRef`,
  `transcriptionModelRef` and `speechModelRef` start as `null` (the `generate_image` tool, dictation and read-aloud are
  off) and are set by the user in Settings → Media, which says: "Audio and text go to the provider you choose;
  harness-forge doesn't store them."
- **What leaves the server**: a dictation's recording goes to the chosen transcription provider; the text of a reply
  that is read aloud goes, sentence chunk by sentence chunk, to the chosen speech provider; an image prompt (and its
  input images) goes to the image provider. Nothing else from the chat is sent for these features (an image turn sends
  no history).
- **Nothing is stored or logged**: recordings, transcripts and speech text or audio are never written to the database,
  the data directory or a cache, and never appear in logs at any level; both audio responses carry `Cache-Control:
  no-store`. The log line of an audio call holds the provider, the model, the byte or character count, the media type,
  the duration, the milliseconds and the outcome (12), never an error object (AI SDK errors carry the request); a
  provider error that repeats part of the speech text is replaced by a generic message before anything logs it (6.12).
  A transcript only becomes chat data when the user sends it as a message. Generated images are chat data: they are
  stored as files and follow the chat (share links, backups, delete-all); image prompts are never logged by the image
  service.
- **Secure context for the microphone**: browsers expose `getUserMedia` only on HTTPS or `localhost`, so on plain HTTP
  across a LAN the mic button is disabled ("Voice input needs HTTPS or localhost"); serve the app through a TLS
  reverse proxy (README, "Behind a reverse proxy"). `Permissions-Policy: microphone=(self)` keeps every other origin and
  every frame away from the microphone (10.2); the browser's own permission prompt still applies.
- **Uploads**: the recording is accepted only by `POST /audio/transcriptions`, only with an allowlisted audio type
  whose magic bytes match, at most 25 MiB (6.12); chat uploads keep their own rules, so audio files cannot be attached
  to chat messages (audio attachments are in the backlog).
- **Generated files**: only PNG, JPEG, WebP and GIF images whose bytes match their type are stored (at most 20 MiB);
  anything else a model returns is dropped with the `generated-file-dropped` notice, never stored or rendered (6.11).

### 10.9 Workspace security (Phase 7, ADR-031 … ADR-033)

The workspace tools act on real files with the server's privileges, and the shell runs any command the user approves.
There is no OS sandbox: run harness-forge in its Docker container (or as a dedicated user) when the workspace matters.

| Threat | Mitigation | Accepted risk |
|---|---|---|
| Prompt injection drives the shell in Auto mode | Auto is an explicit choice; Accept edits exists so Auto is not needed for edits; the shell asks in Ask and Accept edits unless the user's shell rules match the whole command (Phase 8), and an `allow` override on it is refused; hidden-path writes always ask | Auto = full trust in the model |
| Reading `.env`, then sending it out with `web_fetch` | secret-looking reads ask; `search_files` skips them; `web_fetch` asks outside Auto and the card shows the URL | a shell `cat` in Auto mode |
| Planting git hooks, CI files, editor tasks, `.npmrc` | hidden or secret paths: writes always ask (policy `always`), even in Accept edits; `.git` is never written by the file tools | a user override `allow` on the tool, or the shell |
| Symlink escape, `..`, absolute paths | one resolver with realpath containment on every call; dangling links refused; folder links not walked; the root re-checked against its realpath | TOCTOU between check and open, hard links (6.13) |
| Huge files, FIFOs, binary files | windowed reads with caps, `O_NONBLOCK` + `fstat` regular-file checks, binary detection, size limits on edits and searches | — |
| ReDoS in `search_files` / `find_files` | the regex and every glob are matched in a Worker that is terminated after 20 s (or when the call ends); `.gitignore` rules, which run on the main thread, drop lines longer than 512 characters or with more than 3 runs of `*` | a crafted `.gitignore` line below those limits (a heuristic guard) |
| Fork bombs, long-running or background processes | its own process group killed on Stop, timeout, a background leftover and server exit; timeouts of at most 590 s; capped output; compose `pids_limit: 512` | a process that calls `setsid` escapes the group kill |
| A stolen session uses the workspace | fresh auth on `POST /projects` (a new folder needs the password); the roots and `HF_WORKSPACE_SHELL` come only from the environment | a valid session can approve its own shell calls: code execution as the server user |
| Secrets readable by the shell | the environment allowlist (no `HF_*`, no provider keys) | anything the server user can read (`/proc/<ppid>/environ`, `data/secret.key`, the database) |
| A project that exposes the data directory | a project folder may not equal, contain or sit inside the data dir; roots may not be the data dir or inside it (except `<dataDir>/workspaces`) | a root that contains the data dir is allowed (development), but no project can reach it |
| Repository config runs code through git (Phase 8: fsmonitor, hooks, filter drivers, textconv, external diff, pager, `include.path` chains) | one hardened runner (6.17): argument arrays, no shell, scrubbed environment (no inherited `GIT_DIR` / `GIT_CONFIG_*`, `GIT_CONFIG_NOSYSTEM`), `-c` overrides for fsmonitor, hooks, external diff and pager, every configured filter neutralized (else `refused`), never `git diff`, a sentinel test suite and gate probe; 15 s timeout, capped output | a vulnerability in the git binary itself |
| git finds a repository above the project, e.g. the harness-forge repository in development (Phase 8) | `GIT_CEILING_DIRECTORIES` = the parent of the workspace root; the prefix of `rev-parse` maps paths and drops anything outside the project | a project that is itself a subfolder of a repository sees that repository's status for its own files (intended) |
| A repository owned by another user (Phase 8) | git's "dubious ownership" check stays on (`safe.directory` is not overridden): the Git view answers `refused` | the user configures `safe.directory` (or fixes ownership) deliberately; the projects guide documents it for Docker bind mounts |
| Shell syntax slips past a shell rule (Phase 8) | the shared parser fails closed: every segment must match, and `$`, backticks, redirections (other than to `/dev/null` or fd copies), subshells, here-docs, globs, `~`, keywords and env prefixes always ask; enforcement is on the server; rules for command runners (`sh`, `env`, `xargs`, `sudo`, …) and single-word interpreter rules are refused; table and fuzz tests, a gate probe | argument-level side effects of an allowed command (`git diff --output=…`, `find … -delete`); a rule for a script runner (`pnpm test`, `make`, `npm run x`) runs any code the agent wrote into the project, so with Accept edits it is about as strong as Auto for the shell |
| A crafted backup grants shell rights (Phase 8) | shell rules are not settings and are never exported or imported; `fileSweep` is the only new public setting | — |
| The sticky folder escapes the project (Phase 8) | the reported folder is clamped through the path guard at the end of each call and re-checked at the start of the next; an explicit `cwd` is resolved like any path | a command can still `cd` anywhere while it runs (as before: no sandbox) |
| A revert or rewind destroys work (Phase 8) | the current state is snapshotted first and every batch can be undone; conflict detection (current ≠ expected) with an explicit force; `expectedSha` on a revert; 409 `run-active` while any chat of the project runs; the per-file lock | changes made by shell commands and third-party tools are not restorable (listed in the dialog); the lock works only inside the server process |
| Checkpoints expose project content (Phase 8) | a separate tree (`checkpoints/`, 0700 / 0600), never served by a route (never under `/api/files`), never in backups or exports; deleted with the chat or project | anyone who can read the data directory |
| Checkpoint storage grows (Phase 8) | 8 MiB per file, 512 MiB per project, 30 days, prune at boot and every 6 h, cascade deletes, `purge()` on delete-all | — |
| The automatic sweep deletes a file in use (Phase 8) | opt-in (`fileSweep` off by default); the 24 h grace, the first run 24 h after boot, the pins, the DELETE re-check, the plugin-data scan (skipped when incomplete); checkpoint blobs are never touched | a plugin that keeps file ids only in files beyond the scan budget (the automatic run is skipped then, a manual one proceeds) |

- **Kill switch**: `HF_WORKSPACE_SHELL=0` removes every tool with workspace access `execute` (the `shell` tool) from
  every run. No session can change it; file tools keep working.
- **Fresh auth** is required only to create a project. Adding it elsewhere would add friction without protection: a
  session can already create chats in existing projects and approve its own calls.
- **Logs**: the shell logs one `info` line per call (`shell command finished`: exit code, signal, timed out, duration,
  byte counts; or `shell command stopped`), a warning when it fails to start, the command text only at `debug`, cut at
  1,000 characters and redacted; file contents and tool inputs and outputs never at `info` (12).
- **Windows**: the `shell` tool is not registered (the file tools work); the process-group kill needs POSIX.
- **Docker** (11): the image ships `bash` and `git` for the shell; mount project folders at `/workspaces` and set
  `HF_WORKSPACE_ROOTS=/workspaces`; the container runs as uid 1000, so the mounted folders must be writable by it.
  Phase 8: a bind-mounted repository owned by another uid makes git refuse it ("dubious ownership"), so the Git view
  shows `refused`; fix the ownership or add `safe.directory` to the git configuration of the container user yourself
  (`docs/guides/using-projects.md`); the server never overrides it.
- **Shell rules** (Phase 8): adding or removing a rule needs no fresh auth (a session can already approve its own shell
  calls, so a rule adds no power that session lacks); rules apply only to the core `shell` tool; `HF_WORKSPACE_SHELL=0`
  still removes the shell whatever the rules say.
- **Git and the shell** (Phase 8): git runs only through `workspace/git.ts` and shell strings only through
  `workspace/shell.ts` (a spawn guard test enforces it, 6.17); git never writes the index or runs a write command.

## 11. Topology

### Development (`pnpm dev`, coordinator only)

```mermaid
flowchart LR
  B["Browser http://localhost:3000"] --> N["nuxt dev :3000<br/>(Vite HMR)"]
  N -- "nitro.devProxy /api -> HF_API_TARGET/api<br/>(default http://localhost:8787, changeOrigin)" --> S["tsx watch apps/server/src/main.ts<br/>:8787, data in ./data"]
  S --> P["LLM providers / MCP servers"]
```

- The web is served by `nuxt dev` (the server's CSP is not applied to dev HTML); `/api` requests, including SSE and
  the UI message stream, are proxied to the server. The Origin check accepts `http://localhost:3000` and
  `http://127.0.0.1:3000` only in development.
- `HF_DATA_DIR` is resolved against the repo root, so `./data` is shared by both dev processes.
- Agents use their own slot: `HF_PORT=879k HF_DATA_DIR=.tmp/<agent-id>` (e2e: `889k`); e2e gate uses
  `pnpm start:e2e` (`HF_MOCK_PROVIDER=1 HF_PORT=8899 HF_DATA_DIR=.tmp/e2e`).

### Production (`pnpm build && pnpm start`)

```mermaid
flowchart LR
  B["Browser"] -- "HTTPS (optional reverse proxy)" --> RP["Caddy / nginx<br/>(optional, TLS)"]
  RP --> S["node apps/server/dist/main.mjs :8787"]
  B -. "direct on LAN or localhost" .-> S
  S --> SPA["SPA files: HF_WEB_DIR or apps/web/.output/public<br/>(200.html fallback)"]
  S --> API["/api/*"]
  S --> V[("HF_DATA_DIR<br/>Docker volume /data")]
```

- One Node process (`tsdown` build of the server) serves `/api/*` and the generated SPA from `HF_WEB_DIR` (default
  `apps/web/.output/public`, picked up even when it is built after the server started): existing files are served
  with long cache headers for hashed assets (`/_nuxt/*`: `public, max-age=31536000, immutable`), other files with
  `no-cache` + `ETag`; any other non-`/api` GET that accepts `text/html` gets `200.html` (`Cache-Control: no-cache`).
  Unknown `/api/*` paths return `404 not_found` JSON, never the SPA.
- What a deployment needs: `dist/main.mjs` bundles the workspace packages only, and the server locates its package
  root by walking up to `apps/server/package.json`, so ship the server package as a whole: `package.json`, `dist/`,
  `drizzle/` (migrations), `assets/catalog/models-dev.json` (bundled model metadata) and its production
  `node_modules` (AI SDK providers, `@lobehub/icons-static-svg` for icons, `esbuild` for `.ts` plugins), plus the
  generated SPA (or point `HF_WEB_DIR` at it). The app version comes from the root `package.json`.
- Docker: `docker compose up -d` starts the image on port 8787 with the data directory on the `/data`
  volume (`HF_DATA_DIR=/data`). The container listens on all interfaces, so the bind rule requires `HF_PASSWORD`
  (or `HF_INSECURE=1`, not recommended): set it in the compose environment before the first start. Phase 7: the
  runtime image installs `tini`, `bash` and `git` (the shell tool and git commands in projects); the compose file sets
  `pids_limit: 512` (a fork bomb in a shell call cannot exhaust the host) and has a commented example that mounts
  `./workspaces:/workspaces` with `HF_WORKSPACE_ROOTS=/workspaces` (the folder must be writable by uid 1000). Without
  it, projects live in the default root `/data/workspaces` inside the volume. The container is the shell's sandbox:
  commands run as the unprivileged `node` user and see only the container's files and the mounted folders.
- Master-key rotation with `HF_MASTER_KEY` in Docker: stop the server container, run the `rotate-key` CLI in a one-off
  container on the same volume with `HF_MASTER_KEY` (old) and `HF_NEW_MASTER_KEY` (new), then start the server with the
  new `HF_MASTER_KEY` (`docs/guides/using-projects.md`).
- Reverse proxy (TLS): forward the original `Host` header (the Origin check compares it with `Origin`;
  `X-Forwarded-Host` is never used), set `X-Forwarded-For` and `X-Forwarded-Proto`, and list the proxy in
  `HF_TRUST_PROXY`: `loopback` when it runs on the same machine, its exact address, or `private` for a proxy container
  on a Docker network. Then the session cookie is `Secure`, HSTS is on, and the login limiter and the share rate limits
  see the real clients (section 10.6); without `HF_TRUST_PROXY` every client shares the proxy's address (10.1). The
  proxy must allow request bodies of at least 256 MB for data imports (nginx: `client_max_body_size`) and must not
  buffer the SSE responses (the server sends `X-Accel-Buffering: no`). The README has Caddy, nginx and Docker Compose
  examples.
- Share links need `HF_PASSWORD`: without it, `/api` answers only local host names (section 10.1).
- Dictation needs a secure context: from another machine, reach the app through HTTPS (the TLS proxy above); plain
  `http://<lan-address>:8787` disables the microphone (section 10.8). A proxy must allow request bodies of at least
  25 MB for recordings (the 256 MB of data imports covers it).
- Stdio MCP servers, code plugins and (Phase 7) shell commands of the workspace tools run inside the same
  container/user as the server.
- Git in Docker (Phase 8): the Git view of the changes panel needs `git` (shipped) and repositories the container user
  owns. A bind mount owned by another uid is refused by git ("dubious ownership"; the panel says "Git refused to read
  this repository"): `chown` the folder to uid 1000, or set `safe.directory` for that path in the git configuration of
  the `node` user yourself (10.9). The "This chat" view and rewind work without git.

## 12. Observability

- **Request id**: every request gets an id (incoming `X-Request-Id` if it matches `^[A-Za-z0-9._-]{8,64}$`, else a
  new one), echoed as the `X-Request-Id` response header and attached to every log line of that request. The web
  shows it in "copy diagnostics" for failed calls.
- **Structured logs**: JSON lines on stdout: `{ time, level, msg, reqId?, pluginId?, chatId?, ...fields }`. Access log
  per request: method, path (never the query string; the segment after `/share/` masked as `[redacted]`, as in the
  error handler's log line), status, duration, bytes; no headers, bodies or client addresses. Level `info` in
  production, `debug` in development. Never logged: API keys and other secrets (redactor, section 10.3), cookies, share
  tokens (`redactText` masks `/share/<token>` in any text), message contents and tool inputs/outputs (only at `debug`,
  still redacted), uploaded file contents; Phase 6: image prompts (only at `debug`, like message contents),
  recordings, transcripts and speech text or audio (at no level, 10.8).
- **Media calls** (Phase 6): an image generation logs `image generated` (info: `providerId`, `modelId`, `n`,
  `aspectRatio` (`auto` when none), `inputs`, `stored`, `dropped`, `bytes`, `inputTokens`, `outputTokens`, `costUsd`,
  `ms`), `image generation failed` (warn: the same facts plus `code`, `status`, `ms`) or, per refused image, `generated
  image dropped` (warn: provider, model, media type, bytes, reason); a generated file of a chat run that is not kept
  logs `a generated file was dropped` (info: media type, bytes) or `a generated file was refused` (warn). An audio call
  logs one info line, `audio transcription` (`providerId`, `modelId`, `bytes`, `type`, `durationSec` when the provider
  reports it, `ms`, `outcome` `ok` / `empty` / `canceled` / `failed`, `code` on failure) or `audio speech`
  (`providerId`, `modelId`, `chars`, the audio `type` and `bytes` on success, `ms`, `outcome`, `code`). Both services
  record the provider outcome (Settings → Providers status) for answers and provider failures, never for a canceled
  call. None of these lines carries the prompt, the transcript or the speech text.
- **Workspace** (Phase 7): a shell call logs one `info` line through the `core-workspace` plugin logger (so with
  `pluginId` and in its plugin log): `shell command finished` (chat id, tool call id, exit code, signal, timed out,
  duration, byte counts of both streams) or `shell command stopped` (aborted, duration); `shell command failed to
  start` is a warning; the command text only at `debug`, cut at 1,000 characters and redacted; file contents, tool
  inputs and outputs never at `info`. A run whose project folder cannot be opened logs `the project folder of the chat
  is not available` (info, the project id; the reason goes to the chat as the notice). The project service logs
  `project created` (project id, whether a new folder was made) and `project deleted` (project id, detached chats).
- **Maintenance** (Phase 7): `master key rotated` (info, with the counts of `KeyRotationResult`; never key material:
  the new key text is added to the redactor before it is written anywhere), the boot recovery's lines (`finished an
  interrupted key rotation: …` info, warnings for a removed or kept `secret.key.next`, a key that does not match the
  stored check, an unrecorded key check), the `server.lock` warnings (a lock of another live process or host
  replaced), the CLI's lines on stderr (6.14), and `orphaned files cleaned up` (info: files, file bytes, blobs, disk
  bytes, temp files, recent files).
- **Workspace 2.0** (Phase 8): counts and ids only at `info`, never file contents, diffs, commands, rule prefixes or
  paths (those only at `debug`, redacted). `checkpoint not recorded` (warn: chat id, tool call id, the error code) when
  a journal row or blob could not be written (the tool result is kept); the prune logs `checkpoints pruned` (info:
  evicted blobs, unlinked blobs, temp files, bytes freed) when it removed something; a rewind, revert or undo logs one
  info line (`files rewound` / `file reverted` / `restore undone`: chat id, batch id, the counts of restored, deleted,
  unchanged and skipped files); the git runner logs failures at `debug` (the arguments, the exit code) and a spawn
  failure (`git-missing`) once per minute at most; the shell rule service logs `shell rule added` / `shell rule
  removed` (info: rule id, global or project id); the automatic sweep logs `automatic file sweep finished` (info:
  trigger, counts, `recentFiles`, `pluginDataFiles`, `pluginDataBytes`, `durationMs`), `automatic file sweep skipped`
  (info: reason) or a warning with the error on failure (6.15); a shell call allowed by rules adds `allowedByRule:
  true` to its `shell command finished` line.
- **Proxy trust** (texts in section 10.6): the boot log line `trusting reverse proxies (HF_TRUST_PROXY)` lists the
  canonical entries and the trusted ranges; one warning per untrusted peer address that sends a forwarded header the
  server would honor from a trusted proxy (header names only, at most 256 addresses); failed-login warnings carry the
  resolved `address` and the TCP `peer`.
- **Chat runs**: `run.started` / `run.finished` log lines with chat id, model ref, duration, token usage, cost,
  finish reason, outcome, error code.
- **Plugin logs**: `ctx.logger` and guard failures write to a per-plugin ring buffer (last 500 entries, each
  `{ at, level, message, data? }` with `message` capped at 4 KB) and to the process log with `pluginId`.
  `GET /api/plugins/:id/logs` returns the buffer; each new entry is also published as a `plugin.log` event
  (at most 20 events per second per plugin; excess entries are counted and reported as one "N entries dropped"
  entry). Build output of `POST /api/plugins/:id/build` goes through the same channel.
- **Health**: `GET /api/health` for liveness (Docker `HEALTHCHECK`, gate scripts).
