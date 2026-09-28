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
    Svc["services/<br/>settings, secrets, chats, files, events"]
    DB[("SQLite WAL<br/>data/harness.db")]
  end
  subgraph DataDir["HF_DATA_DIR (data/)"]
    Key["secret.key"]
    PDir["plugins/{id}/, plugins/.staging/"]
    Files["files/{aa}/{sha256}"]
    Cache["cache/ (models.dev refresh)"]
  end
  LLM["LLM provider APIs<br/>(Anthropic, OpenAI, ..., Ollama)"]
  MCPS["MCP servers<br/>(stdio child processes, http, sse)"]
  MD["models.dev api.json"]

  SPA -- "fetch JSON, UI message stream (SSE),<br/>GET /api/events (SSE)" --> API
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
  Cat -- "live /models listing" --> LLM
  Cat -- "weekly refresh unless HF_OFFLINE=1" --> MD
  MCPM --> MCPS
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
| `main.ts` | Process entry: runs the boot sequence (section 5), installs signal handlers for graceful shutdown. |
| `env.ts` | Loads `<repo root>/.env`, parses and validates `HF_*` environment variables (zod) into a frozen `Env` object; resolves `HF_DATA_DIR` and `HF_WEB_DIR`; bind-safety check. |
| `deps.ts` | Composition root: `createDeps()` builds every service (eagerly, so a failing factory fails the boot), `startDeps()` / `stopDeps()` run the boot and shutdown steps (section 5). |
| `app.ts` | `createApp(deps)` app factory: mounts middleware and every route module under `/api`; used by `main.ts` and `createTestApp()`. |
| `paths.ts`, `logger.ts` | Package-relative locations (server package root, migrations, bundled assets, the SPA build, installed package versions); JSON-lines logger with redaction. |
| `http/middleware/` | Request id, structured access log, secure headers + CSP, Origin check on non-GET, session auth, fresh auth (ADR-017), login rate limiter, body-size and content-type gate, the global error handler that renders `HarnessErrorEnvelope`. |
| `http/routes/` | One Hono module per API area (`health`, `auth`, `settings`, `events`, `providers`, `credentials`, `models`, `icons`, `chats`, `chat`, `files`, `tools`, `mcp`, `commands`, `plugins`, `plugin-install`, `plugin-drafts`, `plugin-files`); thin: validate (`http/validate.ts` maps zod issues to `validation_error`), call services, map DTOs. |
| `http/static.ts` | Production SPA serving from `HF_WEB_DIR` (default `apps/web/.output/public`) with `200.html` fallback for client routes. |
| `security/` | `keyring.ts` (master key + HKDF subkeys), `password.ts` (scrypt), `session.ts` (HMAC session tokens + cookie), `headers.ts` (CSP/secure headers), `ssrf.ts` (outbound URL guard), `redact.ts` (secret redactor for logs and errors). |
| `db/` | Drizzle schema (`schema.ts`), libsql client, `migrate()` at boot, pragmas (WAL, foreign keys, busy timeout), transaction helper. |
| `services/settings/` | Typed global settings (defaults, validation, cache) over the `settings` table. |
| `services/secrets/` | Encrypted secret store (AES-256-GCM) over the `secrets` table: `get/set/delete/list(scope)`, masked hints, env fallback lookup. |
| `services/chats/` | Chat + message persistence, search, cursor pagination, export (md/json), usage rows, title updates. |
| `services/files/` | Content-addressed upload store (`data/files/<aa>/<sha256>`), MIME/size validation, `files` rows, read streams. |
| `services/events/` | In-process event bus + SSE fan-out for `/api/events` (section 6.7). |
| `registry/` | Typed registries for providers, models, tools, MCP server declarations, commands and hooks; every registration returns a `Disposable` and is tagged with its owner plugin id. |
| `plugins/host.ts` | Plugin host: discovery, load order, lifecycle state machine, enable/disable/reload, boot sentinel, safe mode. |
| `plugins/loader.ts` | Reads + validates `plugin.json`, checks id/dir/engines/trust, imports the entry module (cache-busted URL). |
| `plugins/context.ts` | Builds the per-plugin `PluginContext` (`ctx`): scoped logger, settings, secrets, storage, registries, hooks, `ai`, `fetch`, `signal`. |
| `plugins/guard.ts` | `guard(pluginId, fn, timeoutMs)`: timeouts, error capture into `plugin_error`, per-plugin log ring buffer, hook failure counters. |
| `plugins/declarative.ts` | Adapter that turns declarative `contributes.providers` into `ProviderDefinition`s (OpenAI-chat, OpenAI-responses, Anthropic, Google formats). |
| `plugins/compile.ts` | esbuild compile of `.ts` entries into one ESM file in `data/cache/plugins/<id>/` (SDK aliased to a shim), returns diagnostics. |
| `plugins/watch.ts` | `fs.watch` for linked folders or `HF_PLUGIN_WATCH=1`, 300 ms debounce, triggers reloads. |
| `plugins/state.ts` | Persistence of plugin rows (`plugins`, `plugin_settings`, `plugin_kv`), trust hashes, `loading_since`. |
| `plugins/install/` | Inspect + install from zip / npm / URL / folder into `plugins/.staging/<uuid>`, validation, review check (what was inspected is what gets installed), atomic swap, crash recovery of staging, export. |
| `plugins/drafts/` | Declarative plugins created and edited in the browser (provider wizard): draft validation, SVG icon sanitizing, credentials saved as provider credentials, temporary-provider draft test. |
| `plugins/scaffold/` | Code plugins created from a template (`POST /plugins/scaffold`) and the traversal-safe files API: tree, read, atomic write, delete, build + reload, trust re-pinning of `created` plugins. |
| `plugins/templates/` | Template sources (tool, provider, MCP bridge, command pack): a JSDoc-typed `index.mjs` or a TypeScript `index.ts`, the vendored API types `harness-forge.d.ts` and a README. |
| `catalog/` | Model catalog: live listings with 24 h cache (`model_cache`), models.dev snapshot + weekly refresh, seeds, plugin models, custom ids, prefs, `classify()`, cost lookup. |
| `providers/` | Model resolution: `modelRef` -> provider -> credentials (stored or env) -> `LanguageModel`; provider test; provider status; error mapping to `HarnessError`; the LobeHub icon service (`/api/icons/lobe`). |
| `chat/` | Chat pipeline: runs registry (one active run per chat, stop, resume buffer), history assembly, approvals, slash commands, tool assembly, context trimming, titles, usage/cost, persistence. |
| `mcp/` | MCP manager: one client per enabled server (`@ai-sdk/mcp`), status, reconnect with backoff, tool naming `mcp__<serverId>__<tool>`, hint -> policy mapping, close on disable; `{{settings.*}}` templating of plugin-declared servers; its own stdio transport (minimal environment, stderr lines in the owning plugin's log); the user-configured servers of the MCP panel (`mcp_servers`). |
| `builtin-plugins/index.ts` | Static list of builtin plugin modules, loaded first and trusted. |
| `builtin-plugins/core-providers/` | The 13 builtin providers (see PROVIDERS.md): definitions, seeds, reasoning mapping, error mapping. |
| `builtin-plugins/core-tools/` | Builtin tools: `current_time` (policy `safe`) and `web_fetch` (policy `ask`, SSRF guard; setting "Allow localhost in web_fetch"). |
| `builtin-plugins/core-commands/` | Builtin server-side slash commands (prompt templates such as `/explain`, `/review`, `/commit`; list in PLUGINS.md). |
| `builtin-plugins/core-mcp/` | Owns the user-configured MCP servers (`mcp_servers` table): they are declared as its contributions, so disabling `core-mcp` closes them. Its settings (reconnect automatically, connect timeout) apply to every MCP server. |
| `builtin-plugins/mock/` | Dev-only `mock` provider (`HF_MOCK_PROVIDER=1`): `mock:echo`, `mock:reasoning`, `mock:tool-approval`, `mock:error` on `MockLanguageModelV4`, plus the tool `mock_approval_tool` (behavior in PROVIDERS.md section 8). |
| `testing/` | In-process test harness: `createTestApp()` (real composition over an in-memory database) and fakes. |
| `assets/catalog/models-dev.json` (package root) | Bundled models.dev snapshot (updated by `pnpm catalog:update`); read at runtime, so it ships next to `dist/` (section 11). |
| `drizzle/` (package root) | Generated SQL migrations, applied by `migrate()` at boot; ship next to `dist/`. |

Dependency direction (no cycles): `http/routes` -> `services`, `chat`, `catalog`, `providers`, `plugins`, `mcp` ->
`registry`, `db`, `security`. Plugin code never imports server modules; it only sees `ctx`.

## 4. Web app map (`apps/web/app`)

| Path | Responsibility |
|---|---|
| `app.vue`, `spa-loading-template.html` | Root component; dark-styled inline loading template (no light flash). |
| `assets/css/main.css` | Tailwind 4 entry + oklch design tokens (dark default, light) + fonts. |
| `layouts/` | App shell layout (sidebar + inset, settings variant) and the login layout; names and structure in UI.md. |
| `middleware/` | Route middleware: auth guard (redirect to `/login` when `AuthStatus.authenticated` is false). |
| `plugins/` | `$api` plugin (`createApiClient` with a `fetch` wrapper: `unauthorized` -> `/login`), `events.client.ts` (`EventSource('/api/events')` -> store updates), `shortcuts.client.ts` (the single `keydown` listener of the shortcuts registry). |
| `pages/index.vue` | Empty state: greeting + composer; first send navigates to `/chat/:id`. |
| `pages/chat/[id].vue` | Chat transcript + composer for one chat. |
| `pages/plugins.vue`, `pages/plugins/{index,new,[id]}.vue` | Parent route (hosts the single `InstallDialog`); plugin list (`?filter=`), new plugin (provider wizard / code template), plugin detail tabs. |
| `pages/settings/{providers,models,general,appearance,about}.vue` | Settings pages (`/settings` redirects to providers). |
| `pages/login.vue` | Password login. |
| `components/ui/` | shadcn-vue primitives (generated, frozen, no prefix). |
| `components/ai-elements/` | AI Elements Vue subset (copied, frozen, used with `Ai` prefix). |
| `components/app-shell/` | `AppSidebar`, `ChatNav`, `PluginsNav`, `SettingsNav`, `ThemeToggle`, `CommandPalette`, `ShortcutsDialog`. |
| `components/chat/`, `components/chat/parts/`, `components/chat/composer/` | Transcript, message and part renderers, composer (ModelPicker, EffortMenu, PermissionMenu, SlashMenu). |
| `components/plugins/*` | `list`, `detail`, `forms`, `install`, `wizard`, `code`, `mcp` component groups. |
| `components/settings/`, `components/providers/`, `components/common/` | Settings forms, `ProviderIcon`, shared pieces (`Markdown.vue`, empty states). |
| `composables/` | `useChatSession` (detached `useChat` registry), `useComposer*`, `useShortcuts`, `useGlobalShortcuts`, helpers. |
| `stores/` | Pinia stores `auth`, `chats`, `providers`, `models`, `plugins`, `settings`, `ui` (each `use<Name>Store`), implemented over the typed client and refreshed by `/api/events`. |
| `utils/` | Pure helpers (date grouping, formatting, `data-testid` constants). |

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
  Main->>Env: load <repo root>/.env (variables already set win), parse HF_* (zod), fail fast on invalid values
  Env-->>Main: Env
  Main->>Main: bind check: non-loopback HF_HOST without HF_PASSWORD or HF_INSECURE=1 and no database yet -> exit 1
  Main->>Main: create the data dir (0700) and plugins/, plugins/.staging/, plugins/.data/, files/, cache/plugins/
  Main->>DB: open data/harness.db (WAL, foreign_keys=ON, busy_timeout=5000), migrate()
  Main->>Deps: createDeps(): keyring (HF_MASTER_KEY or data/secret.key, generated 0600 on first boot) and every service
  Main->>Main: bind check again: a password stored in the database also allows a non-loopback bind (else exit 1)
  Main->>Deps: startDeps()
  Deps->>Deps: installer.recover(): restore an interrupted swap, clean plugins/.staging
  Deps->>Host: start(): builtins (static imports, trusted), then unless HF_SAFE_MODE=1 data/plugins/* + linked folders, sorted by id, each guarded
  Host-->>Deps: registry populated (providers, models, tools, MCP decls, commands, hooks)
  Deps->>Cat: start(): models.dev snapshot (bundled or data/cache refresh), model_cache
  Cat-)Cat: background: refresh stale listings (>24 h) and weekly models.dev (unless HF_OFFLINE=1)
  Deps->>MCP: start(): connect declared MCP servers in the background (never blocks boot)
  Main->>HTTP: createApp(deps): /api/*, plus the SPA with 200.html fallback when the web build exists
  HTTP-->>Main: listening on HF_HOST:HF_PORT
```

Notes:

- Boot fails (exit code 1, clear log line) on: invalid env, non-loopback bind without a password (env or stored) or
  `HF_INSECURE=1`, unreadable/invalid master key (or a group/world readable `secret.key`), failed migration, a
  failing service factory. A broken **plugin** never fails boot: it ends in `error` or `incompatible` state and is
  reported in the Plugins tab. `unhandledRejection` and `uncaughtException` (typically from plugin code) are logged,
  never fatal.
- Boot sentinel: before loading a user plugin the host writes `plugins.loading_since = now`; after the load
  finishes it clears it. A row that still has `loading_since` at the next boot (the process crashed while loading
  it) is skipped and put into `error` with a "crashed during load" message until the user re-enables it.
- Staging recovery: a `plugins/.staging/<id>.prev-<uuid>` copy whose `plugins/<id>` directory is missing (crash in the
  middle of an atomic swap) is moved back; every other staging entry is deleted.
- MCP clients connect lazily in the background after their owning plugin is `active`; a failing MCP server never
  blocks boot.
- Graceful shutdown (`SIGINT`/`SIGTERM`, `stopDeps()`): stop accepting connections, abort active runs (persisted as
  `aborted`), dispose plugins (5 s guard each), close MCP clients (terminates stdio children), stop catalog timers,
  close SSE streams, then close the DB. Every step runs even when an earlier one fails; a shutdown longer than 10 s
  exits with code 1, and a second signal exits immediately.

## 6. Flows

### 6.1 Chat send -> stream -> persist

The client keeps one `useChat` instance per open chat (`useChatSession(id)`), configured with
`transport: new DefaultChatTransport({ api: '/api/chat', prepareSendMessagesRequest })`,
`generateId: createMessageId` (from `shared`) and
`sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses`. `@ai-sdk/vue` 4 has no `resume` option
(React only), so `useChatSession` calls `resumeStream()` itself on mount when the chat has an active run
(`ChatSummary.running`, or a `run.started` event).
`prepareSendMessagesRequest` sends only the last message plus the composer state (`ChatRequestBody`, see API.md);
the server owns history.

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
  W->>R: ChatRequestBody (chatId, message, trigger, messageId?, modelRef, reasoningEffort, toolMode)
  R->>R: zod validate (400 validation_error)
  R->>Runs: acquire(chatId)
  alt a run is active for chatId
    Runs-->>W: 409 conflict
  end
  R->>DB: upsert chat (client uuidv7), save toolMode / reasoningEffort / modelRef
  R->>Prov: resolve(modelRef): provider, credentials (stored, then env), ModelInfo
  alt provider missing or required credentials absent
    Prov-->>W: 400 provider_not_configured (action configure-provider), run released
  end
  P->>DB: transaction: expand slash command, supersede pending approvals, apply edit / regenerate / continuation, save user message
  P->>P: validateUIMessages, file parts -> bytes, tools (registry + MCP, filtered), params + hooks
  P->>P: await convertToModelMessages(history, tools), hook chat.messages, trim to 85 percent of context
  P->>M: streamText(model, instructions, messages, tools, toolApproval, stopWhen isStepCount(maxSteps), abortSignal run.signal)
  P->>P: result.consumeStream() so the run survives a client disconnect
  R-->>W: 200 createUIMessageStreamResponse(toUIMessageStream(result.stream, ...)) as SSE
  Note over R,Runs: consumeSseStream tees the SSE bytes into the run buffer for GET /api/chat/:id/stream
  R-)Ev: run.started (chatId, messageId, modelRef)
  M-->>W: start (metadata modelRef, startedAt), start-step, text / reasoning / tool chunks, finish-step ...
  M-->>W: finish (metadata finishedAt, durationMs, reasoningMs, usage, costUsd, finishReason) then [DONE]
  P->>DB: onEnd: idempotent upsert of the assistant message, usage row, chats.updated_at, pending_approval
  P->>Prov: provider status update (connected / error)
  P-)P: hook message.completed (guarded)
  P->>Runs: release(chatId), drop the resume buffer
  P-)Ev: run.finished (chatId, messageId, outcome, awaitingApproval)
  opt first turn and title_source is null
    P-)M: generateText title (titleModelRef, else smallModelId, else chat model), 10 s timeout
    P->>DB: save title (fallback: first 60 chars), never overwrite a user title
    P-)Ev: chat.updated (id, title)
  end
```

Notes:

- The assistant message id is generated by the server (`generateMessageId` = `createMessageId`, `msg_` + 16 chars).
  User message ids are generated by the client with the same `createMessageId` helper and validated by the server
  (format + uniqueness), so edits and regenerations can address them.
- History operations (step "transaction"):
  - `submit-message` with a new user message: append it. Pending `approval-requested` parts of the previous
    assistant message are resolved as denied with reason `superseded`.
  - `submit-message` with `messageId` (edit): replace that user message and delete every later message.
  - `regenerate-message`: delete the assistant message `messageId` (default: the last assistant message) and every
    later message, then generate from the remaining history.
  - `submit-message` whose `message` is the last assistant message (approval continuation, see 6.2): only the
    approval decisions (`approval.id` -> `approved`, `reason`) are merged into the stored message; every other
    client-side change is ignored.
- Slash commands (`/name args` at the start of a user text part, name registered in the commands registry): the
  user message keeps the original text and gets `metadata.command`; `prompt` commands replace the text sent to the
  model with the expansion; `reply` commands write the assistant reply with `createUIMessageStream` without a model
  call. Client-only commands (`/new`, `/model`, `/effort`, `/mode`, `/help`) never reach the server.
- Tool assembly: registry tools + connected MCP tools, filtered by `toolMode` (`off` = no tools), tool prefs
  (`enabled: false` removes the tool; an `override` only changes approval, see 6.2), and model capability
  `capabilities.tools` (no tools for models without it, with a `tools-unsupported` notice). Every tool is wrapped:
  owner-plugin-active check, `tool.before` / `tool.after` hooks, `guard()` timeout (default 60 s), output capped at
  64 KB (truncated with a marker).
- When a request sends no tools (tool mode `off`, a model without tool support, or no usable tool), earlier tool
  calls and results in the history are sent to the model as compact text (`[tool name(input) → ok: output]`,
  input ≤ 500 chars, output ≤ 2000) so providers that reject tool parts without tool definitions still work; the
  stored transcript is unchanged. The `tools-unsupported` notice appears at most once per chat and model.
- Errors after the stream started are sent as an `error` chunk whose `errorText` is the JSON envelope
  `{"error":{...HarnessErrorInit}}` and are persisted in `metadata.error` (see API.md, "Chat stream protocol").

### 6.2 Tool approval round-trip

Approval is decided per tool call by the approval function passed to `streamText({ toolApproval })`. Approvals are
bound to the exact tool call by `experimental_toolApprovalSecret` (the HKDF `approval` subkey), so a modified
client cannot forge an approval for a different input.

Resolution order (first match wins), returning an AI SDK approval status:

| Step | Rule | Result |
|---|---|---|
| 1 | `tool_prefs.override` = `deny` / `allow` / `ask` | `denied` / `approved` / `user-approval` |
| 2 | `tool.approve` hook sets `decision` | `deny` -> `denied`, `allow` -> `approved`, `ask` -> `user-approval` |
| 3 | tool policy (static or function) returns `deny` | `denied` |
| 4 | chat `toolMode` = `ask`: policy `safe` | `not-applicable` (runs without a card) |
| 5 | chat `toolMode` = `ask`: policy `ask` or `always` | `user-approval` |
| 6 | chat `toolMode` = `auto`: policy `always` | `user-approval` |
| 7 | chat `toolMode` = `auto`: policy `safe` or `ask` | `not-applicable` |

MCP tools derive their policy from annotations: `readOnlyHint` -> `safe`, `destructiveHint` -> `always`, otherwise
the server's configured `policy` (default `ask`).

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
pending resolves them as denied (`superseded`). Only `user-approval` results show a card; `approved` and
`not-applicable` calls run directly, and automatic denials render as `output-denied` with
`approval.isAutomatic = true`.

### 6.3 Stop and resume

A run lives in the runs registry (`chat/`), keyed by chat id: `{ runId, chatId, messageId, abortController,
buffer, startedAt }`. At most one run per chat. The run's `AbortSignal` (not the request signal) is passed to
`streamText`, so closing the tab or reloading only drops the HTTP connection. The SSE bytes of the response are
teed into the run buffer by `consumeSseStream`; `GET /api/chat/:id/stream` replays the buffer from the start and
then follows live chunks.

Resume consistency rules (replayed chunks are applied on top of the client's last message, so they must never
overlap with persisted content):

- The in-flight assistant message is persisted only when the run ends (`onEnd`, including abort). While a run is
  active, `GET /api/chats/:id` returns history as it was when the run started: a new reply is absent, an approval
  continuation shows the stored message with the merged decisions (persisted before streaming). Replaying the
  run from its first chunk on top of that snapshot rebuilds the message exactly once.
- The buffer is dropped when the run is released (after persistence); from then on the resume endpoint returns
  `204`. The web refetches a chat on `run.finished` unless its own `useChat` instance is streaming it, which covers
  a run that ends between loading the chat and resuming.

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
the run first. Server shutdown aborts every run through the same path.

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
- Event names and payloads: API.md, "Server events".

## 7. Data directory

```
data/                      HF_DATA_DIR (default ./data, resolved against the repo root in dev; /data in Docker)
  harness.db               SQLite database (WAL mode: also harness.db-wal, harness.db-shm)
  secret.key               master key when HF_MASTER_KEY is unset (32 random bytes, base64, mode 0600)
  plugins/<id>/            installed plugins (plugin.json, entry, assets); linked folders are recorded in the DB
  plugins/.staging/        in-progress installs and .prev copies (cleaned at boot)
  plugins/.data/<id>/      plugin private data (ctx.plugin.dataDir, 0700); kept on update, purged on uninstall
                           unless keepData
  files/<aa>/<sha256>      uploaded attachments, content-addressed (<aa> = first 2 hex chars of the sha256)
  cache/                   models.dev snapshot refreshes (models-dev.json + fetched-at), misc caches
  cache/plugins/<id>/      compiled output of .ts code plugins (<sha256>.mjs), rebuilt on demand
```

The directory is created with mode 0700 when missing. Backups: copy the whole directory while the server is
stopped (or use `sqlite3 .backup` for the DB). Losing `secret.key` (or changing `HF_MASTER_KEY`) makes every stored
secret unreadable; the server then reports affected providers as `not_configured` and logs a warning, it does not
crash.

## 8. Data model

SQLite via Drizzle ORM 0.45 + `@libsql/client` (`apps/server/src/db/schema.ts`). Pragmas at connect:
`journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`. Migrations are generated by
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
by the API, e.g. `_auth.sessionEpoch`).

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
| `key_version` | integer | NOT NULL DEFAULT 1 |
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
| `pending_approval` | boolean | NOT NULL DEFAULT 0; last assistant message waits for an approval |
| `created_at` | timestamp | NOT NULL |
| `updated_at` | timestamp | NOT NULL |
| | | index `chats_list_idx` (`archived`, `updated_at` DESC, `id` DESC) |

**`messages`**

| Column | Type | Constraints |
|---|---|---|
| `id` | text | PK; `msg_` + 16 chars |
| `chat_id` | text | NOT NULL; FK -> `chats.id` ON DELETE CASCADE |
| `seq` | integer | NOT NULL; 0-based position in the chat |
| `role` | text | NOT NULL; `user` \| `assistant` \| `system` |
| `parts` | json `UIMessage['parts']` | NOT NULL |
| `metadata` | json `MessageMetadata` | NULL |
| `search_text` | text | NOT NULL DEFAULT `''`; concatenated text parts, Unicode-normalized and lowercased (ADR-021), used by `GET /chats?q=`; not for display |
| `created_at` | timestamp | NOT NULL |
| `updated_at` | timestamp | NOT NULL; changes on approval continuations |
| | | unique index `messages_chat_seq_idx` (`chat_id`, `seq`) |

**`usage`** — one row per model call (chat run or title generation); kept when a chat is deleted.

| Column | Type | Constraints |
|---|---|---|
| `id` | integer | PK AUTOINCREMENT |
| `chat_id` | text | NULL; FK -> `chats.id` ON DELETE SET NULL |
| `message_id` | text | NULL |
| `purpose` | text | NOT NULL DEFAULT `chat`; `chat` \| `title` |
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

Not stored in the DB: sessions (stateless HMAC cookie), active runs and resume buffers (memory), plugin logs
(memory ring buffer), SSE subscribers (memory).

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

- **Entry set** per provider: live listing (seeds when there is no listing and no cached listing) + plugin models +
  custom ids.
- **Field precedence** per model: user custom -> live provider data -> models.dev -> seed (seeds and plugin models
  share the last tier).
- **`classify()`** marks non-chat models hidden: models.dev modalities when known, else the id regex
  `embed|tts|whisper|transcri|image|moderation|rerank|audio`. `model_prefs.hidden` (true/false) overrides it.
- **Picker order**: favorites -> recent (`model_prefs.last_used_at`) -> by provider (registry order), then name.
- **Cost** (`costUsd`): provider-reported cost when available (OpenRouter), else catalog prices (USD per 1M tokens):
  non-cached input x `cost.input` + cache reads x `cost.cacheRead` + cache writes x `cost.cacheWrite` + output
  (reasoning included) x `cost.output`. Unknown price -> `costUsd` omitted.
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
| DNS-rebinding guard | Without a password, `/api` answers `403 forbidden` to any request whose `Host` is not `localhost`, `*.localhost` or a loopback IP (unless `HF_INSECURE=1`): a web page whose DNS name is rebound to 127.0.0.1 would otherwise be same-origin with itself and drive the whole API. With a password every host name is allowed (sessions protect it). |
| Bind safety | At boot, `HF_HOST` outside `127.0.0.0/8`, `::1`, `localhost` requires a configured password (`HF_PASSWORD` or one stored in the data directory) or `HF_INSECURE=1` (else exit 1). At runtime, removing the password while bound to a non-loopback host is rejected (`409 conflict`). |
| Session cookie | Name `hf_session`; value `v1.<payload b64url>.<HMAC-SHA256 b64url>` signed with the HKDF `session` subkey; payload `{ iat, exp, authAt, epoch }` (ms). Attributes: `HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` (30 days) plus `Secure` when the request is HTTPS (`X-Forwarded-Proto: https` counts). Re-issued when older than 24 h (rolling). |
| Revocation | `epoch` must equal the internal setting `_auth.sessionEpoch`; changing or removing the password increments it, which invalidates every session (the caller gets a fresh cookie). Logout clears the cookie. |
| Fresh auth | ADR-017. When a password is set, sensitive operations require `now - authAt <= 10 min`, else `403 forbidden` with `action: 'login'` (the web asks for the password — inline in the install and trust dialogs, else in `ConfirmPasswordDialog` — calls `POST /api/auth/login` and retries): installing a plugin that requires trust (code or stdio MCP, with or without `trust`), `POST /api/plugins/:id/trust`, scaffolding a code plugin, `POST /api/plugins/:id/build`, `POST /api/plugins/:id/reload` of a code plugin, writing or deleting files of a plugin that runs code (`PUT` / `DELETE /api/plugins/:id/files/*`), creating or changing a stdio MCP server (also inside a created declarative plugin), `PUT /api/auth/password`. The window is 10 minutes, so the editor asks at most once per window; such an editor save also re-pins a trusted `created` plugin (10.4). |
| Login rate limit | Failed password checks (`POST /api/auth/login` and the current-password check of `PUT /api/auth/password`): 5 per 15 min per remote address and 50 per 15 min globally, then `429 rate_limited` with `retryAfterMs` and a `Retry-After` header. A successful login resets the per-address counter. The address is the TCP peer: `X-Forwarded-For` is ignored because any client can forge it. **Reverse-proxy caveat:** behind a proxy every client shares the proxy's address, so 5 failed attempts from anyone lock out every client (including you) for up to 15 minutes; limit access at the proxy (IP allow list, VPN, basic auth) when the server is reachable from the internet. |
| Public endpoints | `GET /api/health`, `GET /api/auth/status`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/icons/lobe`, `GET /api/icons/lobe/:slug`, and the SPA static files. Everything else returns `401 unauthorized` without a valid session. |

### 10.2 CSRF and headers

- **Origin check** on every non-`GET`/`HEAD`/`OPTIONS` request under `/api`: if `Origin` is present it must equal the
  server origin (scheme + `Host`) or, in development, `http://localhost:3000` / `http://127.0.0.1:3000`; if `Origin`
  is absent, `Sec-Fetch-Site` must be absent, `same-origin` or `none`. Violations -> `403 forbidden`. Non-browser
  clients (curl) without these headers pass; they cannot ride on the user's cookie. Together with
  `SameSite=Strict` this closes CSRF. No CORS headers are ever sent.
- **Secure headers** (all responses): `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `Strict-Transport-Security: max-age=31536000`
  only over HTTPS (`X-Forwarded-Proto: https` counts).
- **CSP for the SPA HTML**: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' <sha256 hashes of the inline
  scripts of the served HTML document, recomputed when the file changes>; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:;
  object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. `'wasm-unsafe-eval'` only allows
  compiling WebAssembly (the syntax highlighter of code blocks), not JavaScript `eval`. Remote images in model output
  are therefore blocked (no data exfiltration through image URLs); the markdown renderer shows them as links.
- **CSP for API responses**: `default-src 'none'; frame-ancestors 'none'`; icons and files use their own CSP (API.md).

### 10.3 Secrets at rest

- Master key: `HF_MASTER_KEY` (base64, 32 bytes) or `data/secret.key` (generated with `crypto.randomBytes(32)`,
  mode 0600; the server refuses to start if the file is group/world readable).
- Subkeys: HKDF-SHA256(masterKey, salt `harness-forge/v1`, info `encryption` | `session` | `approval`, 32 bytes).
  `approval` feeds `experimental_toolApprovalSecret`.
- Encryption: AES-256-GCM, random 12-byte IV per write, AAD = UTF-8 of `<scope>/<name>` (a ciphertext copied to
  another row fails to decrypt), stored with `key_version` for future rotation.
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
  backslashes, no NUL.
- **SSRF guard** (`security/ssrf.ts`, used by `web_fetch` and URL installs): `http:`/`https:` only; DNS-resolve and
  reject loopback, private (RFC 1918), link-local (incl. `169.254.169.254`), CGNAT, multicast, unspecified,
  IPv6 ULA / link-local and IPv4-mapped forms of these; connect to the checked IP (no re-resolve); at most 5
  redirects, each re-checked; 10 s timeout; response body capped (2 MB for `web_fetch`, 20 MB for installs).
  The `core-tools` setting "Allow localhost in web_fetch" (default off) lets `web_fetch` reach loopback addresses
  only; private, link-local and metadata addresses stay blocked. Provider base URLs are exempt (local providers such
  as Ollama are legitimate) but are set only by the user or a plugin manifest they reviewed.
- **Limits**: JSON bodies 1 MB (plugin file writes 1 MB + envelope, chat requests 2 MB, chat imports 20 MB), uploads
  20 MB per file (`image/*`, `application/pdf`, `text/*`), plugin zips 20 MB compressed / 100 MB expanded / 2000
  entries, tool output 64 KB, chat title 200 chars. A non-empty body of a JSON route must be `application/json`
  (multipart routes also accept `multipart/form-data`), so HTML forms cannot post to the API.

### 10.5 XSS rules (web)

- `v-html` is forbidden (lint rule). Model output, tool output, plugin strings and file names render as text or
  through `Markdown.vue`, which uses markstream-vue with `html-policy="escape"` (raw HTML is escaped, not parsed).
- Links in markdown: only `http:`, `https:`, `mailto:`; `target="_blank" rel="noopener noreferrer"`.
- Icons are never inlined: mono icons via CSS `mask-image` on a `<span>`, color icons via `<img>`; both point at
  server URLs (`/api/icons/lobe/<slug>`, `/api/plugins/<id>/icon`) served with a restrictive CSP.
- Uploaded files are served with `nosniff`, a sandboxing CSP and `Content-Disposition: attachment` except raster
  images and PDF (API.md, `GET /files/:id`).

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
  (or `HF_INSECURE=1`, not recommended): set it in the compose environment before the first start.
- Reverse proxy (TLS): forward the original `Host` header (the Origin check compares it with `Origin`) and set
  `X-Forwarded-Proto: https`, which makes the session cookie `Secure` and enables HSTS. The login rate limiter sees
  only the proxy's address (section 10.1).
- Stdio MCP servers and code plugins run inside the same container/user as the server.

## 12. Observability

- **Request id**: every request gets an id (incoming `X-Request-Id` if it matches `^[A-Za-z0-9._-]{8,64}$`, else a
  new one), echoed as the `X-Request-Id` response header and attached to every log line of that request. The web
  shows it in "copy diagnostics" for failed calls.
- **Structured logs**: JSON lines on stdout: `{ time, level, msg, reqId?, pluginId?, chatId?, ...fields }`. Access log
  per request: method, path (no query string values for secrets), status, duration, bytes. Level `info` in
  production, `debug` in development. Never logged: API keys and other secrets (redactor, section 10.3), cookies,
  message contents and tool inputs/outputs (only at `debug`, still redacted), uploaded file contents.
- **Chat runs**: `run.started` / `run.finished` log lines with chat id, model ref, duration, token usage, cost,
  finish reason, outcome, error code.
- **Plugin logs**: `ctx.logger` and guard failures write to a per-plugin ring buffer (last 500 entries, each
  `{ at, level, message, data? }` with `message` capped at 4 KB) and to the process log with `pluginId`.
  `GET /api/plugins/:id/logs` returns the buffer; each new entry is also published as a `plugin.log` event
  (at most 20 events per second per plugin; excess entries are counted and reported as one "N entries dropped"
  entry). Build output of `POST /api/plugins/:id/build` goes through the same channel.
- **Health**: `GET /api/health` for liveness (Docker `HEALTHCHECK`, gate scripts).
