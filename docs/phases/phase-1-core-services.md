# Phase 1 — Core services

Part of the harness-forge build plan. Progress is tracked in `docs/ROADMAP.md` (coordinator only). Shared names come
from `docs/DECISIONS.md`; endpoint shapes from `docs/API.md`; tables from `docs/ARCHITECTURE.md`.

## Goal

Replace the Phase 0 server stubs with working core services: HTTP hardening and auth, encrypted secrets and
settings, the plugin host and registry, providers + model catalog + icons + the mock provider, and chats, events
and file uploads. No chat streaming yet (Phase 2).

## Entry criteria

- Phase 0 exit criteria met; FREEZE in force; checkpoint commit exists.
- `createTestApp()` and the 501 route stubs exist; migration 0000 is generated; `core-providers` registers 13
  providers through the SDK.

## Exit criteria

- ROADMAP items W1.1–W1.5 checked; W1 gate green; checkpoint commit.
- `GET /api/providers` lists the 13 builtin providers (+ `mock` with `HF_MOCK_PROVIDER=1`); stored keys come back
  only as masked hints; provider enable/disable survives a restart.
- With a password set, every `/api/*` route except the public ones returns 401 `unauthorized` without a session.
- Every endpoint owned by this phase answers per `docs/API.md`; the remaining ones still return the 501 envelope.

## Rules for every Phase 1 agent

- Paths below are repo-relative; all server source lives in `apps/server/src/`. Tests live next to code
  (`x.ts` + `x.test.ts`); ownership lists both.
- Frozen files stay frozen even when an owned glob matches them: `*/types.ts`, `app.ts`, `db/schema.ts`,
  `builtin-plugins/index.ts`, `packages/*/src`. Keep the export names and signatures that `app.ts` imports.
- Each route module keeps the export name used by `app.ts`, validates input with `@hono/zod-validator` + schemas from
  `@harness-forge/shared`, and throws `HarnessError` for every failure (never ad-hoc JSON).
- Prefer in-process tests (`createTestApp()` + `app.request()`). Own server only on your slot:
  `HF_PORT=879k HF_DATA_DIR=.tmp/<agent-id>`; stop it before reporting.
- Verify library APIs in the installed `.d.ts` (Hono 4.13, AI SDK v7, `@ai-sdk/*`, drizzle 0.45, zod 4).
- Common verify commands: `pnpm -F @harness-forge/server test` · `pnpm typecheck` · `pnpm check:english`.

---

## Wave W1 (5 agents in one launch)

### W1.1 server-core

- **Mission.** Harden the HTTP layer: error envelope, password + session auth, Origin check, rate limiting, secure
  headers, safe bind, and serving the built SPA.
- **Owned.** `main.ts`, `env.ts`, `http/middleware/**`, `http/routes/{health,auth}.ts`, `http/static.ts`,
  `security/{session,password,headers}.ts` (+ tests).
- **Read-only highlights.** `app.ts`, `security/types.ts` (keyring interface), `services/secrets/types.ts`,
  `services/settings/types.ts`, `docs/API.md` (auth rules, envelope), `docs/ARCHITECTURE.md` (security model).
- **Depends on.** W1.2 keyring (`session` subkey) and secrets service through their frozen interfaces; tests use the
  fake keyring from `createTestApp()`.
- **Tasks.**
  1. **W1.1-T1 Envelope + request id** — `http/middleware/`: request id (`x-request-id` in and out), `onError`
     mapping (`HarnessError` → HTTP status `errorStatusByCode[code]`, never the envelope `status`, which is the
     upstream provider status; zod/validator failures → 400 `validation_error` with `details`; unknown → 500
     `internal_error` without stack or message leakage), access log without bodies or secrets.
     *Accept:* a thrown `Error('secret sk-123')` yields `{ error: { code: 'internal_error', ... } }` and the string
     `sk-123` appears in neither the response nor the log.
  2. **W1.1-T2 Password** — `security/password.ts`: scrypt hash (parameters + salt encoded in the hash string),
     constant-time verify. Source of truth: `HF_PASSWORD` if set (overrides), else the stored hash (secrets scope
     `auth`).
     *Accept:* verify rejects a wrong password and a tampered hash; hashing the same password twice yields
     different strings.
  3. **W1.1-T3 Session** — `security/session.ts`: HMAC-SHA256 signed cookie `hf_session` (HttpOnly,
     SameSite=Strict, Path=/, Secure on HTTPS), key = keyring `session` subkey, payload `{ iat, exp, authAt, epoch }`
     (ARCHITECTURE.md 10.1; `authAt` drives fresh auth), expiry encoded and checked; a password change invalidates
     every existing session.
     *Accept:* a modified cookie, an expired cookie and a cookie issued before a password change are all rejected.
  4. **W1.1-T4 Auth routes** — `auth.ts`: `GET /auth/status` (`AuthStatus`: `enabled`, `authenticated`, `source`,
     `freshUntil`), `POST /auth/login` (rate limit per ARCHITECTURE.md 10.1: 5 failures per 15 min per address, 50
     globally → 429 `rate_limited` with `retryAfterMs`), `POST /auth/logout`, `PUT /auth/password` (fresh auth;
     set/change/clear; requires the current password; `conflict` while `HF_PASSWORD` is set).
  5. **W1.1-T5 Auth middleware** — when a password is configured every `/api/*` route requires a valid session
     except the public ones (`GET /health`, `GET /auth/status`, `POST /auth/login`, `POST /auth/logout`,
     `GET /icons/lobe`, `GET /icons/lobe/:slug`) → 401 `unauthorized` with `action: 'login'`. Fresh auth
     (ADR-017, API.md): routes marked `fresh` in the route table need a session whose `authAt` is at most 10 min
     old, else 403 `forbidden` with `action: 'login'`; `http/middleware/fresh-auth.ts` exports a
     `requireFreshAuth(c)` helper for the conditional cases (install of a plugin that requires trust, stdio MCP
     servers, drafts with a stdio server).
     *Accept:* a test iterates the shared route table with a password set and no cookie: all non-public routes
     return 401; with a stale session every `fresh` route returns 403.
  6. **W1.1-T6 Origin check** — per ARCHITECTURE.md 10.2, on every non-GET/HEAD/OPTIONS request: a present
     `Origin` must equal the server origin (in dev also `http://localhost:3000` / `http://127.0.0.1:3000`); without
     `Origin`, `Sec-Fetch-Site` must be absent, `same-origin` or `none` (so curl without these headers passes) →
     otherwise 403 `forbidden`. No CORS headers are ever sent.
  7. **W1.1-T7 Secure headers** — `security/headers.ts`: CSP (`default-src 'self'`; `script-src 'self'` + sha256
     hashes of the inline scripts found in `200.html` at startup; `style-src 'self' 'unsafe-inline'`;
     `img-src 'self' data: blob:`; `connect-src 'self'`; `object-src 'none'`; `base-uri 'none'`;
     `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
     `Cross-Origin-Opener-Policy: same-origin` (the complete header and CSP lists are in ARCHITECTURE.md 10.2).
     *Accept:* no `unsafe-eval`; the color-mode inline script is allowed by hash.
  8. **W1.1-T8 Safe bind** — `main.ts`: a non-loopback `HF_HOST` without a password and without `HF_INSECURE=1`
     exits with code 1 and a clear message; SIGINT/SIGTERM close the server cleanly.
  9. **W1.1-T9 SPA serving** — `http/static.ts`: serve `apps/web/.output/public` in production (`/_nuxt/*` with
     immutable caching), fallback to `200.html` for non-`/api` GET requests, unknown `/api/*` → 404 envelope, no
     directory listing, no traversal outside the root.
  10. **W1.1-T10 Health** — `health.ts`: `GET /health` → `Health` `{ ok, version, node, uptimeSec, versions: { ai,
      hono, nuxt? } }` (public; versions read from the installed packages at boot).
- **Tests.** envelope mapping, password, session tamper/expiry/rotation, login + rate limit, 401 matrix, Origin 403,
  CSP hashes (fixture `200.html` in a temp dir), bind safety (unit), static fallback + traversal.
- **Verify.** Common commands.

### W1.2 secrets-settings

- **Mission.** Implement the master keyring, AES-256-GCM secrets, global settings and write-only provider credentials.
- **Owned.** `security/keyring.ts`, `services/settings/**`, `services/secrets/**`,
  `http/routes/{settings,credentials}.ts` (+ tests).
- **Read-only highlights.** `security/types.ts`, `services/{settings,secrets}/types.ts`, `registry/types.ts`
  (credential fields of a provider), `docs/API.md`.
- **Tasks.**
  1. **W1.2-T1 Keyring** — master key from `HF_MASTER_KEY` (base64, exactly 32 bytes; invalid → startup error) or
     `data/secret.key` generated once with mode 0600; HKDF-SHA256 subkeys `encryption`, `session`, `approval`;
     `key_version` recorded for rotation.
     *Accept:* the key file is created once, reused on restart, and has mode 0600.
  2. **W1.2-T2 Secrets service** — AES-256-GCM with a random 12-byte IV and AAD = `<scope>/<name>`;
     `get/set/delete/list(scope)`; scopes `provider:<id>`, `plugin:<id>`, `mcp:<id>`, `auth`.
     *Accept:* decrypting with a different scope/name (AAD) or a tampered ciphertext throws; values never reach
     logs.
  3. **W1.2-T3 Settings service** — typed keys + defaults from `@harness-forge/shared`; `get()`, `update(patch)`
     validated with zod; unknown keys rejected.
  4. **W1.2-T4 Settings routes** — `GET /settings`, `PUT /settings` (partial update; 400 `validation_error` on bad
     values).
  5. **W1.2-T5 Credentials** — `credentials.ts`: `PUT /providers/:id/credentials` (validated against the provider's
     `CredentialField[]`; secret fields encrypted under `provider:<id>`), `DELETE /providers/:id/credentials`;
     `resolveCredentials(providerId)` for W1.4 with env fallback (`CredentialField.envVar`); responses expose only
     `{ set, hint, source: 'stored' | 'env' }` with hints like `sk-…9fQ2` (short values fully masked); emits
     `provider.changed`.
     *Accept:* a test stores a key and asserts the raw key string appears in no response body of any endpoint.
- **Tests.** keyring (env key, file key, bad key), secrets (round trip, AAD, tamper), settings validation,
  credentials (masking table, env fallback, delete).
- **Verify.** Common commands.

### W1.3 plugin-host

- **Mission.** Implement the plugin host: discovery, validation, states, guarded execution, `PluginContext`, the
  registry, the declarative adapter, `.ts` compilation, hot reload and the plugins API.
- **Owned.** `plugins/{host,loader,context,guard,declarative,compile,watch,state}.ts` (+ tests),
  `plugins/__fixtures__/**`, `registry/**`, `http/routes/plugins.ts` (+ test).
- **Read-only highlights.** `plugins/types.ts`, `registry/types.ts`, `builtin-plugins/index.ts`,
  `packages/plugin-sdk/src/**`, `docs/PLUGINS.md`.
- **Tasks.**
  1. **W1.3-T1 Loader** — builtins (static imports, trusted, not removable) → `data/plugins/*` + linked folders
     (`plugins.source = 'link'`), sorted by id; validation: manifest zod → dir name = id → not reserved →
     `engines.harness` satisfied (else `incompatible`) → realpath of `main` inside the dir → code and stdio-MCP
     plugins need `trusted_hash == sha256(plugin.json + main)` (else `untrusted`).
  2. **W1.3-T2 States** — `state.ts`: `disabled | untrusted | incompatible | loading → active | error`, persisted in
     `plugins`, `plugin.changed` event on every transition; `HF_SAFE_MODE=1` loads builtins only.
  3. **W1.3-T3 Guard** — `guard(pluginId, fn, timeoutMs)`: setup 10 s, hooks 3 s, tools 60 s default, dispose 5 s;
     throw/timeout → `plugin_error` + per-plugin log ring buffer + `plugin.log` event; 5 consecutive failures
     disable that hook handler; boot sentinel `plugins.loading_since` skips a plugin that crashed during the
     previous load; `unhandledRejection` is logged, never fatal.
     *Accept:* a fixture plugin whose `setup` never resolves ends in `error` after 10 s (fake timers) while the
     other plugins become `active`.
  4. **W1.3-T4 Context** — `context.ts`: `PluginContext` (settings with `onChange`, secrets under `plugin:<id>`,
     storage over `plugin_kv`, `plugin.dataDir` = `data/plugins/.data/<id>/` (created 0700 before `setup`),
     `providers/models/tools/mcp/commands.register`, `hooks.on` with priority,
     `ai` host copies, `fetch`, `signal`, `logger`); every registration returns a `Disposable` tracked in a
     DisposableStore; disable = `dispose()` → unregister everything → abort `ctx.signal`; in-flight calls to a
     disposed tool return "tool unavailable".
  5. **W1.3-T5 Registry** — `registry/**`: providers (id rule `<pluginId>` or `<pluginId>-*` for plugins), models
     (held until their provider is registered), tools (globally unique names; a duplicate fails the second
     registration with `plugin_error`), commands, hooks (priority order), MCP declarations; change notifications.
  6. **W1.3-T6 Declarative adapter** — `declarative.ts`: `DeclarativeProvider` → `ProviderDefinition` with
     `createOpenAICompatible` (`openai-chat`), `createOpenAI` (`openai-responses`), `createAnthropic`,
     `createGoogleGenerativeAI`; auth `bearer | header | none`; header templates `{{credentials.<key>}}`;
     `listModels` (path, include/exclude regex); `reasoningStyle`; contributed models, commands and MCP servers.
  7. **W1.3-T7 Compile** — `compile.ts`: `.ts` entries bundled with esbuild into one ESM file
     `data/cache/plugins/<id>/<sha256>.mjs` (never inside the plugin dir); `@harness-forge/plugin-sdk` resolved to a
     virtual shim exporting `definePlugin`;
     returns diagnostics (file, line, column, message) for W3.4.
  8. **W1.3-T8 Hot reload** — `watch.ts`: `fs.watch` on linked folders or with `HF_PLUGIN_WATCH=1`, 300 ms debounce
     → disable → `import(url + '?v=' + hash)` → enable; declarative plugins reload on manifest change.
  9. **W1.3-T9 Plugins API** — `plugins.ts`: `GET /plugins`, `GET /plugins/:id`, `DELETE /plugins/:id?keepData`
     (builtins → `forbidden`; purges settings/KV/secrets and `data/plugins/.data/<id>/` unless `keepData`),
     `POST /plugins/:id/{enable,disable,
     reload}`, `GET|PUT /plugins/:id/settings` (validated with `settingsValuesSchema`; `format: 'secret'` values
     stored in secrets and returned masked), `GET /plugins/:id/icon` (file inside the plugin dir only, svg/png,
     `nosniff`), `GET /plugins/:id/logs`.
- **Tests.** fixtures (valid declarative, `.mjs` code, `.ts` code, throwing setup, hanging setup, reserved id,
  id ≠ dir, incompatible engines, untrusted code) → expected states; a broken plugin never blocks others; disable
  removes every contribution; hot reload serves the new version; safe mode; sentinel; settings secrets masked.
- **Verify.** Common commands.

### W1.4 providers-catalog

- **Mission.** Resolve model refs to AI SDK language models, test providers, build the model catalog (live listings,
  cache, models.dev, prefs, custom ids), serve LobeHub icons and ship the dev-only mock provider.
- **Owned.** `providers/**`, `catalog/**`, `builtin-plugins/mock/**`, `http/routes/{providers,models,icons}.ts`
  (+ tests), `apps/server/assets/catalog/**`, `scripts/update-catalog.ts`.
- **Read-only highlights.** `providers/types.ts`, `catalog/types.ts`, `registry/types.ts`,
  `builtin-plugins/core-providers/**`, `docs/PROVIDERS.md`, installed `ai/test` and `@lobehub/icons-static-svg`.
- **Depends on.** W1.2 `resolveCredentials`, W1.3 registry (through frozen interfaces; tests use fakes).
- **Tasks.**
  1. **W1.4-T1 Model resolution** — `resolveModel(modelRef)`: split on the first `:` → registered + enabled
     provider (else `not_found`) → credentials with env fallback (missing required field →
     `provider_not_configured`, action `configure-provider`, before any network call) → guarded
     `createLanguageModel` → `{ model, info, provider }` (unknown model id → `model_not_found`, action
     `refresh-models`).
  2. **W1.4-T2 Providers API** — `GET /providers` (DTO: id, name, icon URLs, status `connected | not_configured |
     env | error`, credential hints, enabled, model count, key URL, owning plugin), `PATCH /providers/:id`
     (`ProviderUpdate` `{ enabled }`, persisted in `provider_configs`; `baseURL` and other non-secret credential
     fields are saved by W1.2's `PUT /providers/:id/credentials`), `POST /providers/:id/test`
     (`validate()` → else `listModels` → else 1-token ping on `smallModelId`; stores status, `last_error`,
     `validated_at`; returns latency); emits `provider.changed`.
     *Accept:* disabling a provider persists across a restart on the same data dir and hides its models.
  3. **W1.4-T3 Catalog** — live listing cached 24 h in `model_cache` (background refresh, last good kept on
     failure) + bundled models.dev snapshot (refreshed weekly into `data/cache` unless `HF_OFFLINE=1`) + seeds +
     plugin models + custom ids; field precedence user custom → live → models.dev → seed; `classify()` hides
     non-chat models (models.dev modalities, else regex `embed|tts|whisper|transcri|image|moderation|rerank|audio`);
     emits `catalog.changed`.
  4. **W1.4-T4 Models API** — `GET /models` (visible models with capabilities, limits, efforts, cost; order
     favorites → recent → by provider), `POST /providers/:id/models/refresh`, `PUT /model-prefs` (hidden, favorite,
     alias), `POST /custom-models`, `DELETE /custom-models?providerId&modelId`.
  5. **W1.4-T5 Icons** — `GET /icons/lobe` (slug list), `GET /icons/lobe/:slug` (slug `^[a-z0-9-]+$`, file read only
     from the package directory, `image/svg+xml`, long cache, `nosniff`); provider DTO icon URLs point here or at
     `/api/plugins/<id>/icon`.
     *Accept:* `../`, `%2e%2e` and unknown slugs return 400/404 envelopes, never a file outside the package.
  6. **W1.4-T6 Mock provider** — `builtin-plugins/mock/**`, registered only with `HF_MOCK_PROVIDER=1`, built on
     `MockLanguageModelV4` + `simulateReadableStream`, behaving exactly as PROVIDERS.md section 8 specifies:
     `mock:echo` (echoes the user text one word per chunk, first chunk after 50 ms, then every 25 ms; a 400-word
     message streams for about 10 s, so Stop is testable), `mock:reasoning` (reasoning words every 100 ms, then
     `Answer: <user text>`), `mock:tool-approval` (calls the tool `mock_approval_tool`, policy `ask`, registered by
     the same builtin), `mock:error` (`APICallError` 401 mapped to `auth_invalid`, delivered in the stream).
  7. **W1.4-T7 Snapshot script** — `scripts/update-catalog.ts` fetches `https://models.dev/api.json`, keeps the
     builtin provider keys and the fields the catalog uses, writes `apps/server/assets/catalog/models-dev.json`
     (the coordinator runs `pnpm catalog:update`; tests use a small fixture under `catalog/`).
- **Tests.** model ref cases, `provider_not_configured` without network, status `env` from an env key, cache TTL +
  keep-last-good (fake clock), classify, precedence merge, prefs, custom models, icon traversal, mock gated by env,
  persistence across two `createTestApp()` instances sharing one database file.
- **Verify.** Common commands.

### W1.5 chats-events-files

- **Mission.** Implement chat storage (CRUD, search, pagination, export), message persistence APIs for the chat
  pipeline, the SSE event bus and content-addressed file uploads.
- **Owned.** `services/{chats,files,events}/**`, `http/routes/{chats,files,events}.ts` (+ tests).
- **Read-only highlights.** `services/{chats,files,events}/types.ts`, `db/schema.ts`, `docs/API.md`.
- **Tasks.**
  1. **W1.5-T1 Event bus + SSE** — in-process bus (`emit(type, data)`, subscribe/unsubscribe) and `GET /events`:
     `{ type, data, at }` frames, heartbeat comment every 25 s (API.md section 7), cleanup on disconnect, never
     buffered.
     *Accept:* two subscribers both receive an event; a closed connection leaves no listener behind.
  2. **W1.5-T2 Chats service** — create with a client uuidv7 (validated), get with messages ordered by `seq`, list
     with an opaque cursor (`updated_at` desc, id tiebreak), search `q` over titles and message text (LIKE with `%`
     and `_` escaped), rename (`title_source = 'user'`), pin/archive, delete (cascade); emits `chat.created`,
     `chat.updated`, `chat.deleted`.
  3. **W1.5-T3 Message persistence** — the `services/chats/types.ts` API used by W2.1: idempotent upsert of a
     message, replace-from (`messageId` and later), append usage rows, touch `updated_at`.
  4. **W1.5-T4 Chats API** — `GET /chats?cursor&q`, `POST /chats`, `GET|PATCH|DELETE /chats/:id`,
     `GET /chats/:id/export?format=md|json` (attachment with a sanitized filename; no secrets, no internal ids beyond
     the chat's own).
  5. **W1.5-T5 Files** — `POST /files` (multipart; size limit per API.md → 413 `payload_too_large`; sha256 →
     `data/files/<aa>/<sha256>`; dedupe; row in `files`), `GET /files/:id` (id validated; stored MIME;
     `nosniff`; `inline` only for PNG, JPEG, GIF, WebP, AVIF and PDF, otherwise `attachment`, SVG included).
- **Tests.** pagination stability under inserts, search escaping, export snapshot (md + json), cascade delete, SSE
  delivery + heartbeat, upload dedupe, 413, invalid id, path traversal attempt on `GET /files/:id`.
- **Verify.** Common commands.

### Wave W1 ownership

```json
{
  "wave": "W1",
  "agents": {
    "W1.1": [
      "apps/server/src/main.ts",
      "apps/server/src/main.test.ts",
      "apps/server/src/env.ts",
      "apps/server/src/env.test.ts",
      "apps/server/src/http/middleware/**",
      "apps/server/src/http/routes/health.ts",
      "apps/server/src/http/routes/health.test.ts",
      "apps/server/src/http/routes/auth.ts",
      "apps/server/src/http/routes/auth.test.ts",
      "apps/server/src/http/static.ts",
      "apps/server/src/http/static.test.ts",
      "apps/server/src/security/session.ts",
      "apps/server/src/security/session.test.ts",
      "apps/server/src/security/password.ts",
      "apps/server/src/security/password.test.ts",
      "apps/server/src/security/headers.ts",
      "apps/server/src/security/headers.test.ts"
    ],
    "W1.2": [
      "apps/server/src/security/keyring.ts",
      "apps/server/src/security/keyring.test.ts",
      "apps/server/src/services/settings/**",
      "apps/server/src/services/secrets/**",
      "apps/server/src/http/routes/settings.ts",
      "apps/server/src/http/routes/settings.test.ts",
      "apps/server/src/http/routes/credentials.ts",
      "apps/server/src/http/routes/credentials.test.ts"
    ],
    "W1.3": [
      "apps/server/src/plugins/host.ts",
      "apps/server/src/plugins/host.test.ts",
      "apps/server/src/plugins/loader.ts",
      "apps/server/src/plugins/loader.test.ts",
      "apps/server/src/plugins/context.ts",
      "apps/server/src/plugins/context.test.ts",
      "apps/server/src/plugins/guard.ts",
      "apps/server/src/plugins/guard.test.ts",
      "apps/server/src/plugins/declarative.ts",
      "apps/server/src/plugins/declarative.test.ts",
      "apps/server/src/plugins/compile.ts",
      "apps/server/src/plugins/compile.test.ts",
      "apps/server/src/plugins/watch.ts",
      "apps/server/src/plugins/watch.test.ts",
      "apps/server/src/plugins/state.ts",
      "apps/server/src/plugins/state.test.ts",
      "apps/server/src/plugins/__fixtures__/**",
      "apps/server/src/registry/**",
      "apps/server/src/http/routes/plugins.ts",
      "apps/server/src/http/routes/plugins.test.ts"
    ],
    "W1.4": [
      "apps/server/src/providers/**",
      "apps/server/src/catalog/**",
      "apps/server/src/builtin-plugins/mock/**",
      "apps/server/src/http/routes/providers.ts",
      "apps/server/src/http/routes/providers.test.ts",
      "apps/server/src/http/routes/models.ts",
      "apps/server/src/http/routes/models.test.ts",
      "apps/server/src/http/routes/icons.ts",
      "apps/server/src/http/routes/icons.test.ts",
      "apps/server/assets/catalog/**",
      "scripts/update-catalog.ts"
    ],
    "W1.5": [
      "apps/server/src/services/chats/**",
      "apps/server/src/services/files/**",
      "apps/server/src/services/events/**",
      "apps/server/src/http/routes/chats.ts",
      "apps/server/src/http/routes/chats.test.ts",
      "apps/server/src/http/routes/files.ts",
      "apps/server/src/http/routes/files.test.ts",
      "apps/server/src/http/routes/events.ts",
      "apps/server/src/http/routes/events.test.ts"
    ]
  }
}
```

### Wave W1 cross-agent contracts

All of these go through frozen interfaces (`*/types.ts`) so the five agents never import each other's unfinished
implementations; tests use the fakes provided by `createTestApp()`.

| Producer → consumer | Contract |
|---|---|
| W1.2 → W1.1 | keyring `session` subkey signs `hf_session`; the password hash lives in secrets scope `auth` |
| W1.2 → W1.4 | `resolveCredentials(providerId)` → values + `source: 'stored' \| 'env'`; `provider.changed` on write |
| W1.3 → W1.4 | registry lookup of `ProviderDefinition`s and plugin models; the mock builtin registers through `ctx` |
| W1.4 → W1.3 | provider enabled state (`provider_configs`) filters what `GET /providers` and `GET /models` expose |
| W1.5 → all | event bus `emit(type, data)`: W1.3 `plugin.changed`/`plugin.log`, W1.4 `provider.changed`/`catalog.changed`, W1.2 `provider.changed`, W1.5 `chat.*` |
| W1.1 → all | auth + Origin middleware run before every route; `GET /events` is authenticated and never compressed |

## Gate W1

1. `node scripts/audit-ownership.mjs .tmp/waves/W1.json`
2. `pnpm catalog:update` (coordinator; produces the models.dev snapshot) → `pnpm install --frozen-lockfile` (if deps
   changed) → `pnpm check` → `pnpm build`.
3. `pnpm start:e2e` (`HF_MOCK_PROVIDER=1 HF_PORT=8899 HF_DATA_DIR=.tmp/e2e`), then:
   - `curl -sf :8899/api/health`
   - `curl -s :8899/api/providers | jq` → the 13 builtin ids + `mock`, each with `icon` URLs and a status.
   - Keys masked: `PUT /api/providers/deepseek/credentials` with a fake key (body per API.md, header
     `Origin: http://127.0.0.1:8899`) → `GET /api/providers` shows only `{ set: true, hint, source: 'stored' }`;
     grepping every response for the raw key finds nothing.
   - Enable/disable survives restart: `PATCH /api/providers/groq` `{"enabled": false}` → restart `pnpm start:e2e`
     on the same data dir → `groq` is still disabled and its models are absent from `GET /api/models`.
   - `curl -s :8899/api/models | jq` includes `mock:echo`; `curl -sI :8899/api/icons/lobe/claude-color` →
     `image/svg+xml`.
   - `curl -N :8899/api/events` receives `provider.changed` when a provider is toggled.
   - Auth: restart with `HF_PASSWORD=secret pnpm start:e2e` → `curl -s -o /dev/null -w '%{http_code}'
     :8899/api/providers` prints `401`; `/api/health` and `/api/auth/status` print `200`.
4. No UI changes in this wave (no screenshots needed unless the web app was touched).
5. Update ROADMAP + wave log → checkpoint commit.
