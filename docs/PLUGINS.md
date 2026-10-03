# Plugins

The authoritative contract of the harness-forge plugin system and the plugin authoring guide. The types and
schemas of this document are implemented verbatim by `@harness-forge/shared` (zod schemas of the plugin data shapes
and enums, ADR-018) and `@harness-forge/plugin-sdk` (re-exports them and adds the runtime API and `definePlugin`);
the plugin host (`apps/server/src/plugins/`) implements the behavior. Plugin authors import everything from
`@harness-forge/plugin-sdk`.

Related: [PROVIDERS.md](./PROVIDERS.md) (builtin providers, reasoning mappings, wizard templates),
[API.md](./API.md) (endpoints and DTOs), [ARCHITECTURE.md](./ARCHITECTURE.md) (sections 6.2 approvals, 6.4 lifecycle,
6.5 install, 6.13 agent workspace), [DECISIONS.md](./DECISIONS.md) (contract seed; wins on conflict).

Contents: [1 Concepts](#1-concepts) · [2 Directory layout](#2-plugin-directory-layout) ·
[3 Manifest](#3-manifest-reference-pluginjson) · [4 Declarative providers](#4-declarative-providers) ·
[5 Declarative MCP servers](#5-declarative-mcp-servers) · [6 Declarative commands](#6-declarative-commands) ·
[7 Settings schema](#7-settings-schema) · [8 Code plugins](#8-code-plugins) · [9 API reference](#9-api-reference) ·
[10 Tool approval](#10-tool-approval) · [11 Lifecycle](#11-lifecycle) · [12 Installing](#12-installing-plugins) ·
[13 Trust and security](#13-trust-and-security) · [14 Naming rules](#14-naming-rules) ·
[15 Authoring guide](#15-authoring-guide) · [16 FAQ](#16-faq)

## 1. Concepts

A **plugin** is a directory with a `plugin.json` manifest. It can contribute:

| Contribution | Declarative (`plugin.json`) | Code (`ctx` in `setup`) |
|---|---|---|
| LLM providers | `contributes.providers` | `ctx.providers.register()` |
| Models for any provider (incl. builtins) | `contributes.models`, `providers[].models` | `ctx.models.register()` |
| Image, speech-to-text and text-to-speech models (API 1.1.0) | — (backlog) | `ProviderDefinition.createImageModel` / `createTranscriptionModel` / `createSpeechModel` |
| Generated images from plugin code (API 1.1.0) | — | `ctx.images.generate()` |
| Tools | — | `ctx.tools.register()` |
| Tools that work on the chat's project folder (API 1.2.0) | — | `ToolDefinition.workspace` + `ToolCallContext.workspace` |
| MCP servers (their tools become tools) | `contributes.mcpServers` | `ctx.mcp.register()` |
| Slash commands | `contributes.commands` (template) | `ctx.commands.register()` (template or `run`) |
| Hooks into the chat pipeline | — | `ctx.hooks.on()` |
| A settings form | `settings` | `settings` (read with `ctx.settings.get()`) |

### Plugin kinds (`PluginKind`)

| | `declarative` | `code` |
|---|---|---|
| Detected by | no `main` in the manifest | `main` present |
| Files | `plugin.json` (+ optional icon) | `plugin.json` + one ESM entry file (`.mjs`, `.js` or `.ts`) |
| Runs code on the server | No. Exception: a declared **stdio** MCP server spawns a local process | Yes, **in-process with the full rights of the server process** |
| Trust required | Only when it declares a stdio MCP server | Always |
| Typical origin | provider wizard, zip / npm / URL / folder | code templates in the browser, zip / npm / URL / folder |

### Builtin plugins

Builtins ship with the server, are statically imported, always trusted, loaded even in safe mode, and cannot be
uninstalled (`source = builtin`). They use the same `PluginContext` API as user plugins (ADR-009); because they are
part of the server they may import server dependencies (for example the official `@ai-sdk/*` packages) directly.

| Id (card name) | Contributes | Notes |
|---|---|---|
| `core-providers` (Core providers) | the 13 builtin providers ([PROVIDERS.md](./PROVIDERS.md)), since Phase 6 with image, transcription and speech models ([PROVIDERS.md 13](./PROVIDERS.md#13-image-and-voice-models)) | individual providers can be disabled (`PATCH /api/providers/:id`) |
| `core-tools` (Core tools) | 3 tools: `current_time` (policy `safe`), `web_fetch` (policy `ask`, SSRF guard) and `generate_image` (Phase 6, policy `ask`) | setting `allowLocalhost` (below); `generate_image` uses the image model of Settings → Media (`imageModelRef`) |
| `core-commands` (Core commands) | 10 template slash commands (below) | client-only commands (`/new`, `/model`, `/effort`, `/mode`, `/help`) never reach the server |
| `core-mcp` (MCP servers) | MCP servers configured in the MCP panel (`mcp_servers` table); the panel is its Overview | settings `autoReconnect`, `connectTimeoutSeconds` (below) |
| `core-workspace` (Workspace tools, Phase 7) | 7 workspace tools: `read_file`, `list_directory`, `find_files`, `search_files`, `write_file`, `edit_file`, `shell` (below) | offered only in chats whose project folder opened; `shell` is not registered on Windows and is removed by `HF_WORKSPACE_SHELL=0`; no settings |
| `mock` (Mock provider) | provider `mock` (chat models, and since Phase 6 image, transcription and speech models; Phase 7 adds `mock:workspace`) and tool `mock_approval_tool` | registered only with `HF_MOCK_PROVIDER=1` (dev / e2e) |

Builtin manifests in v1.3: `core-tools` is version 1.2.0 and declares `engines.harness` `"^1.2.0"` (its
`generate_image` output carries the 1.2 `modelName`); `core-workspace` is version 1.0.0 with `"^1.2.0"` and the
permission `process` (it uses `ToolDefinition.workspace` and `ToolCallContext.workspace`); `core-providers` stays 1.1.0
with `"^1.1.0"`; `mock` stays version 1.0.0 with `"^1.1.0"`; `core-commands` and `core-mcp` stay 1.0.0 with
`"^1.0.0"`. Load order: `core-providers`, `core-tools`, `core-commands`, `core-mcp`, `core-workspace`, then `mock`.

Builtin tools (`core-tools`):

| Tool | Input | Output |
|---|---|---|
| `current_time` | `{ timezone? }`: IANA name (`Europe/Berlin`, `UTC`); default the server time zone; an unknown zone is a `validation_error` | `{ iso, unixMs, timezone, local, utcOffset, weekday }` (`local` = `YYYY-MM-DD HH:mm:ss`, `utcOffset` = `+02:00`) |
| `web_fetch` | `{ url, maxChars? }`: `http:` / `https:` URL (<= 2048 characters); `maxChars` 1000-40000, default 20000 | `{ url, status, contentType, title, text, truncated }`: `url` after redirects, the readable text of an HTML page (`title` from `<title>` or `og:title`) or the text of a text document (plain, markdown, JSON, XML, ...); other content types are refused |
| `generate_image` (Phase 6, ADR-028) | `{ prompt, n?, aspectRatio? }`: prompt 1-32000 characters (trimmed), `n` 1-4 (default 1), `aspectRatio` one of `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, `9:16` (default: the model's) | `{ modelRef, modelName?, images: [{ fileId, url, mediaType, name }], costUsd?, revisedPrompt? }` (1-4 images; `modelName` since 1.2.0: the catalog name of the model, else its id, absent in outputs saved before v1.3; `costUsd` when the catalog prices the model; `revisedPrompt` cut to fit 16 KB of JSON): file references only, well under the 64 KB output cap. The model sees a short text instead ("Generated 2 images with <model name>; they are shown to the user below this call.", or "Generated 1 image with <model name>; it is shown to the user below this call."; an old output without `modelName` names the model ref), and the chat pipeline appends one image `file` part per image after the call and adds the tool's `costUsd` to the cost of the message, only for this tool of `core-tools` (checked by owner: a tool of the same name from another plugin never gets images appended). The tool is always registered; while `imageModelRef` is null a call fails with "Choose an image model in Settings → Media."; other failures are the `ctx.images` errors (section 9). Timeout 300 s |

`web_fetch` goes through the SSRF guard: public addresses only, every redirect re-checked (at most 5), 10 s timeout,
2 MB body.

Builtin workspace tools (`core-workspace`, Phase 7, ADR-032 / ADR-033; behavior in
[ARCHITECTURE.md 6.13](./ARCHITECTURE.md#613-agent-workspace-projects-workspace-tools-and-the-shell-adr-031-adr-032-adr-033),
schemas in `@harness-forge/shared`). Paths in inputs and outputs are relative to the project folder (POSIX); every path
resolves through the server's path guard (realpath containment, no `.git` writes). Each output is trimmed to about
60 KiB, and the model gets a short text built from the stored output (`toModelOutput`):

| Tool | Access / policy / timeout | Input | Output |
|---|---|---|---|
| `read_file` | `read` / `safe`, `ask` for a secret-looking path (`.env`, `*.pem`, `id_rsa*`, …) / 30 s | `{ path, offset?, limit? }` (1-based offset, 1-2000 lines) | `{ path, content, startLine, endLine, totalLines, truncated }` (text files, ≤ 48 KiB per call) |
| `list_directory` | `read` / `safe` / 30 s | `{ path? }` (default `.`) | `{ path, entries: [{ name, type }], truncated }` (≤ 1000) |
| `find_files` | `read` / `safe` / 60 s | `{ pattern, path?, include_ignored?, max_results? }` (a glob; ≤ 1000, default 200) | `{ pattern, paths, truncated }` |
| `search_files` | `read` / `safe` / 60 s | `{ pattern, literal?, case_sensitive?, glob?, path?, include_ignored?, max_results? }` (a JS regex; ≤ 500, default 100) | `{ pattern, matches: [{ path, line, text }], filesSearched, truncated }` |
| `write_file` | `write` / `ask`, `always` for a hidden or secret path / 30 s | `{ path, content }` (≤ 256 KiB) | `{ path, created, bytes, lines, diff }` |
| `edit_file` | `write` / as `write_file` / 30 s | `{ path, old_string, new_string, replace_all? }` (a unique exact match unless `replace_all`; files ≤ 1 MiB) | `{ path, replacements, diff }` |
| `shell` | `execute` / `ask` / 600 s | `{ command, cwd?, timeout_ms?, description? }` (≤ 16 KiB; `timeout_ms` 1000-590000, default 120000) | `{ command, cwd, exitCode, signal, timedOut, durationMs, stdout, stderr, stdoutBytes, stderrBytes }` |

`diff` is `{ hunks: [{ oldStart, oldLines, newStart, newLines, lines }], added, removed, truncated }` (or `null` when
it could not be computed in 2 s); the web draws it inside the tool row. `find_files` and `search_files` skip `.git`
always and `node_modules` and gitignored files unless `include_ignored`; `search_files` runs the regex in a Worker that
is stopped after 20 s and skips secret-looking files. `shell` runs `bash -c` (else `sh -c`) in the project folder (or
`cwd` inside it) with a minimal environment (no `HF_*`, no provider keys), in its own process group that is killed on
Stop, on the timeout and when the server exits; each call is a new process (no `cd` that sticks, no stdin, background
processes are stopped); each stream keeps its first 4 KiB and last 16 KiB. The `core-tools` setting **Allow localhost in web_fetch** (`allowLocalhost`, default off) also admits
loopback addresses (a local dev server); private, link-local and cloud metadata addresses stay blocked.

Builtin commands (`core-commands`, all `template` commands): `/explain` (code or a concept, step by step),
`/summarize` (text, or the conversation so far when no text is given), `/review` (bugs, security, readability),
`/fix` (root cause and fix), `/refactor` (clarity without behavior changes), `/tests` (unit tests), `/docs`
(documentation comments), `/commit` (a commit message for a diff), `/translate` (into English, or into the language
named first), `/proofread` (grammar, spelling, style).

`core-mcp` settings apply to every MCP server (panel and plugins): **Reconnect automatically** (`autoReconnect`,
default on: retries a failed or dropped connection with increasing delays, up to about 9 minutes) and **Connect
timeout (seconds)** (`connectTimeoutSeconds`, 5-120, default 20).

### API version

```ts
export const PLUGIN_API_VERSION = '1.2.0'
```

`PLUGIN_API_VERSION` versions the plugin API (not the app). Minor versions only add; a major version breaks. A
manifest declares the API range it supports in `engines.harness`; the host checks
`semver.satisfies(PLUGIN_API_VERSION, engines.harness)` and marks the plugin `incompatible` when it fails. Use
`"^1.0.0"`, or `"^1.1.0"` / `"^1.2.0"` when the plugin uses a member of that version.

| Version | Changes |
|---|---|
| `1.0.0` | v1 (Phase 0 – 5) |
| `1.1.0` | Phase 6 (additive): the optional `ProviderDefinition` members `createImageModel`, `imageParams`, `createTranscriptionModel`, `createSpeechModel`, `transcriptionOptions`; `PluginContext.images.generate`; model kinds `transcription` and `speech`, `ModelInfo.voices`, `capabilities.imageOutput` |
| `1.2.0` | Phase 7 (additive, ADR-032): `ToolCallContext.workspace?: ToolWorkspace` (`{ projectId, name, root }`, set for every tool in a chat whose project folder opened); `ToolDefinition.workspace?: 'read' \| 'write' \| 'execute'` (such a tool is offered only in those chats; `execute` tools only while `HF_WORKSPACE_SHELL` is on; `write` + policy `ask` runs without a card in the new permission mode `edits`); `ToolMode` gains `edits` ("Accept edits"; visible to hooks in `chat.params`); `ImageGenerateResult.modelName`. Behavior change: an unknown provider in `ctx.ai` (`ctx.models.resolve`) and `ctx.images` is now `provider_not_configured` (400, action `configure-provider`), as on chat; it was `not_found` |

A plugin written for 1.0 keeps working unchanged (`"^1.0.0"` accepts `1.1.0` and `1.2.0`; a plugin that catches the
old `not_found` of an unknown provider should also accept `provider_not_configured`). A plugin that uses a newer member
should declare that version (`"^1.1.0"`, `"^1.2.0"`), so an older host reports it `incompatible` instead of silently
ignoring the member: a 1.1 host would offer a tool with `workspace` in every chat and never fill `c.workspace`. The
builtins follow the same rule: `core-tools` (1.2.0) and `core-workspace` declare `"^1.2.0"`, `core-providers` and
`mock` `"^1.1.0"`. The in-browser templates and the example plugins still declare `"^1.0.0"` (they use no newer
member).

## 2. Plugin directory layout

```
data/plugins/
  <id>/                       one installed plugin; the directory name equals the plugin id
    plugin.json               manifest (required, UTF-8 JSON, <= 256 KB)
    index.mjs                 code entry (code plugins only; any name/extension allowed by "main")
    icon.svg                  optional icon (.svg or .png, <= 256 KB), referenced by "icon"
    ...                       other files: ignored by the host, readable by the plugin via ctx.plugin.dir
  .staging/                   host-managed: in-progress installs and .prev copies (cleaned at boot)
  .data/<id>/                 host-managed: ctx.plugin.dataDir, survives updates, removed on uninstall
```

- The host ignores every entry of `data/plugins/` whose name starts with `.`.
- **Linked folders** (`source = link`) have the same layout at any absolute path outside the data directory; they are
  recorded in the `plugins` table (`source_ref` = realpath) instead of being copied. The folder name must still
  equal the plugin id.
- Builtins live in `apps/server/src/builtin-plugins/<id>/` and have no `plugin.json` on disk; their manifest is an
  object exported by the module.

## 3. Manifest reference (`plugin.json`)

### Top-level fields

| Field | Type | Required | Validation |
|---|---|---|---|
| `$schema` | string | no | ignored (lets editors attach a JSON schema) |
| `manifestVersion` | `1` | yes | the literal number `1` |
| `id` | string | yes | `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`; equals the directory name; not reserved (below) |
| `name` | string | yes | 1-64 characters after trimming |
| `version` | string | yes | valid semver (`1.2.0`, `2.0.0-beta.1`) |
| `description` | string | no | <= 280 characters |
| `author` | string | no | <= 100 characters |
| `homepage` | string | no | absolute `https:` or `http:` URL |
| `icon` | string | no | `lobe:<slug>` where `<slug>` is a file name (without `.svg`) of the bundled `@lobehub/icons-static-svg` set, **or** a relative path to a `.svg` / `.png` file (<= 256 KB) whose realpath is inside the plugin directory |
| `engines` | `{ harness: string }` | yes | `harness` is a valid semver range |
| `main` | string | no | presence makes the plugin a code plugin; relative POSIX path; extension `.mjs`, `.js` or `.ts`; realpath inside the plugin directory |
| `permissions` | `PluginPermission[]` | no | unique values of `network`, `secrets`, `storage`, `hooks`, `process` (advisory, see below) |
| `settings` | `SettingsSchema` | no | [section 7](#7-settings-schema) |
| `contributes` | object | no | fields below |

Validation is strict: unknown keys are rejected with `validation_error`. Exception: `engines.harness` is read with a
lenient pre-parse first, so a manifest written for a newer plugin API is reported as `incompatible`, not as
`error`.

**Reserved plugin ids:** every id starting with `core-`, `mock`, and every builtin provider id (`anthropic`,
`openai`, `google`, `xai`, `deepseek`, `moonshotai`, `alibaba`, `zai`, `minimax`, `mistral`, `groq`, `openrouter`,
`ollama`).

**Icons:** `lobe:<slug>` resolves to the server-served LobeHub icon: the mono variant is `<slug>` (without a
`-color` suffix) and the color variant is `<slug>-color`, each used when the file exists (`lobe:together` and
`lobe:together-color` both yield `{ color: together-color, mono: together }`). A file icon is served at
`/api/plugins/<id>/icon` and used as the color variant. No icon means a monogram. Details:
[PROVIDERS.md, Icons](./PROVIDERS.md#10-icons).

### `contributes`

| Field | Type | Notes |
|---|---|---|
| `providers` | `DeclarativeProvider[]` | [section 4](#4-declarative-providers) |
| `models` | `{ providerId: string; models: ModelInfo[] }[]` | adds models (or metadata) to any provider, including builtins; held until that provider is registered |
| `mcpServers` | `McpServerDecl[]` | [section 5](#5-declarative-mcp-servers); a `stdio` server makes the plugin require trust |
| `commands` | `DeclarativeCommand[]` | [section 6](#6-declarative-commands) |

### Permissions (advisory)

Code runs in-process, so permissions are **not enforced**. They are shown in the trust dialog and in the plugin
detail. The host writes one `warn` log entry the first time a plugin uses a capability it did not declare.

| Permission | Declare when the plugin | Trust dialog label | Detected use |
|---|---|---|---|
| `network` | makes HTTP requests other than to its declared provider base URLs and MCP URLs | Connects to the network | `ctx.fetch` |
| `secrets` | stores secrets (`ctx.secrets`) | Stores secrets | `ctx.secrets.*` |
| `storage` | stores data (`ctx.storage`, files in `ctx.plugin.dataDir`) | Stores data | `ctx.storage.*` |
| `hooks` | registers hooks (it can read and change prompts, messages and tool calls) | Reads and changes conversations | `ctx.hooks.on` |
| `process` | starts processes, including stdio MCP servers | Starts programs | stdio `McpServerDecl` |

### Example (declarative, with settings, a command and an HTTP MCP server)

```json
{
  "manifestVersion": 1,
  "id": "acme-docs",
  "name": "Acme docs",
  "version": "1.0.0",
  "description": "Search the Acme documentation from the chat.",
  "author": "Acme Inc.",
  "homepage": "https://docs.example.com",
  "icon": "icon.svg",
  "engines": { "harness": "^1.0.0" },
  "permissions": ["network"],
  "settings": {
    "type": "object",
    "required": ["token"],
    "properties": {
      "token": { "type": "string", "format": "secret", "title": "API token" }
    }
  },
  "contributes": {
    "mcpServers": [
      {
        "id": "acme-docs",
        "name": "Acme docs search",
        "policy": "safe",
        "transport": {
          "type": "http",
          "url": "https://mcp.example.com/mcp",
          "headers": { "Authorization": "Bearer {{settings.token}}" }
        }
      }
    ],
    "commands": [
      {
        "name": "acme",
        "description": "Answer using the Acme docs",
        "template": "Use the Acme docs search tools to answer:\n\n{{input}}"
      }
    ]
  }
}
```

## 4. Declarative providers

A declarative provider turns an HTTP API in one of four wire formats into a provider of the model picker without
any code. The provider wizard (Plugins -> New plugin -> Provider) writes exactly this format.

### Fields (`DeclarativeProvider`)

| Field | Type | Required | Default | Validation / meaning |
|---|---|---|---|---|
| `id` | string | yes | | `<pluginId>` or `<pluginId>-<suffix>` ([section 14](#14-naming-rules)) |
| `name` | string | yes | | 1-64 characters; shown in the picker and in Settings -> Providers |
| `icon` | string | no | the plugin icon | `lobe:<slug>` only |
| `baseURL` | string | yes | | absolute `http:` / `https:` URL without credentials, query or fragment; a trailing `/` is removed |
| `apiFormat` | `ApiFormat` | yes | | `openai-chat`, `openai-responses`, `anthropic` or `google` |
| `auth` | `{ type, header? }` | no | per `apiFormat` (below) | `type`: `bearer`, `header` or `none`; `header` is required with `type: 'header'` and forbidden otherwise |
| `credentials` | `CredentialField[]` | no | `[{ key: 'apiKey', label: 'API key', type: 'secret', required: true }]`; `[]` when `auth.type` is `none` | keys unique; `envVar` is **not allowed** in declarative manifests |
| `headers` | `Record<string, string>` | no | `{}` | extra request headers; values may contain `{{credentials.<key>}}` |
| `models` | `ModelInfo[]` | no | `[]` | always listed for this provider (plugin models tier) |
| `listModels` | `boolean \| { path?, include?, exclude? }` | no | `true` | live model listing |
| `reasoningStyle` | `ReasoningStyle` | no | `none` | how the effort menu maps to request options |
| `modelsDevId` | string | no | the provider id | models.dev provider key used for model metadata (for example `togetherai`) |
| `smallModelId` | string | no | | cheap model used for chat titles and for the 1-token credential test |

Rules:

- If `auth.type` is not `none`, `credentials` must contain a field with key `apiKey`; its value is the credential
  sent by `auth`.
- The base URL is set by the plugin author and shown in the install preview. Plain `http:` to a non-loopback host is
  allowed (LAN servers) but the UI shows a warning.

### `apiFormat` -> AI SDK factory

The host's declarative adapter (`plugins/declarative.ts`) builds a `ProviderDefinition` whose `createLanguageModel`
calls one of these factories. `rt.fetch` is always passed as `fetch`; the provider id is passed as `name`.

| `apiFormat` | Factory call | Request |
|---|---|---|
| `openai-chat` | `createOpenAICompatible({ name, baseURL, apiKey?, headers, fetch, includeUsage: true }).chatModel(modelId)` | `POST {baseURL}/chat/completions` |
| `openai-responses` | `createOpenAI({ name, baseURL, apiKey, headers, fetch }).responses(modelId)` | `POST {baseURL}/responses` |
| `anthropic` | `createAnthropic({ name, baseURL, apiKey \| authToken, headers, fetch })(modelId)` | `POST {baseURL}/messages` (the base URL must include the version segment, for example `https://api.example.com/anthropic/v1`) |
| `google` | `createGoogleGenerativeAI({ name, baseURL, apiKey, headers, fetch })(modelId)` | `POST {baseURL}/models/{modelId}:streamGenerateContent` (base URL like `https://generativelanguage.googleapis.com/v1beta`) |

Provider options keys used by the adapter (and accepted by these factories regardless of `name`): `openaiCompatible`,
`openai`, `anthropic`, `google`.

### `auth` styles

| `auth` | Header sent | Default for |
|---|---|---|
| `{ "type": "bearer" }` | `Authorization: Bearer <apiKey>` | `openai-chat`, `openai-responses` |
| `{ "type": "header", "header": "x-api-key" }` | `x-api-key: <apiKey>` (the SDK adds `anthropic-version`) | `anthropic` |
| `{ "type": "header", "header": "x-goog-api-key" }` | `x-goog-api-key: <apiKey>` | `google` |
| `{ "type": "header", "header": "<Name>" }` | `<Name>: <apiKey>` (for example Azure-style `api-key`) | |
| `{ "type": "none" }` | nothing | |

- `bearer` with `apiFormat: 'anthropic'` uses the SDK's `authToken` option (`Authorization: Bearer`).
- If the `apiKey` field is optional and empty, no auth header is sent (for example vLLM started without
  `--api-key`).
- For other schemes (`Authorization: Token ...`), use `auth: { "type": "none" }` plus `headers`.

**Adapter security rules (normative):**

1. The adapter always passes credentials to the factory explicitly. SDK environment fallbacks (`OPENAI_API_KEY`,
   `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`) must never apply to
   a plugin provider, otherwise a third-party base URL could receive the user's builtin keys. When no key is sent,
   the adapter passes a non-secret placeholder `apiKey` and strips the placeholder header in its `fetch` wrapper.
2. A `headers` entry must not set the header used by `auth` (validation error), nor `Host`, `Content-Length`,
   `Connection`, `Transfer-Encoding` or `Cookie`.
3. Provider requests never follow cross-origin redirects (see `ProviderRuntime.fetch`).

### `headers` templating

- Syntax: `{{credentials.<key>}}`, where `<key>` is declared in `credentials`. No whitespace inside the braces. Any
  other `{{...}}` in a header value is a validation error.
- Placeholders may be mixed with literal text: `"OpenAI-Organization": "{{credentials.organization}}"`,
  `"X-Tenant": "tenant-{{credentials.tenant}}"`.
- Values are resolved per request (stored value -> field `default`). If any referenced credential resolves to an
  empty value, the whole header is omitted.
- Header names must be RFC 7230 tokens. Headers that contain a secret credential are redacted in logs.

### `listModels`

| Value | Behavior |
|---|---|
| `true` (default) | `GET {baseURL}/models` |
| `false` | no live listing; the provider shows `models`, `contributes.models` and user custom ids |
| `{ "path"?, "include"?, "exclude"? }` | `path` (default `/models`) is a path starting with `/` appended to `baseURL`, or an absolute URL with the **same origin** as `baseURL`; `include` / `exclude` are JavaScript regular expression sources (<= 256 characters each) compiled with the `i` flag and tested against model ids (`exclude` wins) |

Request: `GET` with the same auth and headers as chat requests, 15 s timeout. Format-specific paging:
`anthropic` adds `?limit=1000` and follows `has_more` / `after_id`; `google` adds `?pageSize=1000` and follows
`nextPageToken`; at most 10 pages.

Response parsing (first matching shape wins; at most 5000 models):

| Shape | Example APIs | Model id |
|---|---|---|
| object with a `data` array | OpenAI, Anthropic, most gateways | `item.id` |
| object with a `models` array | Google, Ollama-style | `item.name` without a leading `models/`, else `item.id`; Google items whose `supportedGenerationMethods` lacks `generateContent` are skipped |
| bare array | Together AI | `item.id`, or the item itself when it is a string |

Optional fields picked up when present: name <- `display_name` / `displayName` / `name`; `contextWindow` <-
`context_length` / `context_window` / `max_context_length` / `inputTokenLimit` / `max_input_tokens`;
`maxOutputTokens` <- `max_output_tokens` / `max_completion_tokens` / `outputTokenLimit` / `max_tokens`; `kind` <-
`type` (`chat`, `language`, `text` -> `chat`; `embedding`, `embeddings` -> `embedding`; `image` -> `image`; `audio`,
`tts`, `stt`, `transcribe` -> `audio`; anything else -> `other`). Listings are cached for 24 h; a failed refresh
keeps the last good listing (see [ARCHITECTURE.md, Model catalog](./ARCHITECTURE.md#9-model-catalog)).

Since Phase 6 a declarative provider has no media factories, so the catalog leaves out its listed models of kind
`image`, `transcription` or `speech` (a `type` of `image`, or an id the host classifies that way, such as `dall-e-3` or
`whisper-1`); `audio`, `embedding` and `other` models stay listed but hidden. Declarative image and voice providers are
in the backlog; a code plugin can provide them ([section 9](#providerdefinition)).

### `reasoningStyle`

The effort menu is shown only for models with `capabilities.reasoning: true` and a provider whose
`reasoningStyle` is not `none`. The adapter's `reasoning()` returns `ReasoningParams`
([section 9](#providerdefinition)); `reasoning` is the portable top-level `reasoning` call option of AI SDK v7,
which each SDK provider translates to its wire format.

| `ReasoningEffort` | `openai-effort` | `anthropic-thinking` | `google-thinking` |
|---|---|---|---|
| `auto` | nothing | nothing | nothing |
| `off` | `reasoning: 'none'` | `providerOptions.anthropic.thinking = { type: 'disabled' }` | `reasoning: 'none'` |
| `low` | `reasoning: 'low'` | `thinking = { type: 'enabled', budgetTokens: 2048 }` | `reasoning: 'low'` + `providerOptions.google.thinkingConfig.includeThoughts = true` |
| `medium` | `reasoning: 'medium'` | `budgetTokens: 8192` | `reasoning: 'medium'` + `includeThoughts` |
| `high` | `reasoning: 'high'` | `budgetTokens: 16384` | `reasoning: 'high'` + `includeThoughts` |
| `max` | `reasoning: 'xhigh'` | `budgetTokens: 32768` | `reasoning: 'xhigh'` + `includeThoughts` |
| On the wire | `openai-chat`: `reasoning_effort: <value>`; `openai-responses`: `reasoning.effort` (the SDK also requests a `detailed` reasoning summary) | `thinking: { type, budget_tokens }`; the SDK adds the budget to `max_tokens` | Gemini 3+: `thinkingLevel` (`none` becomes the lowest level); Gemini 2.5: `thinkingBudget` |

Use `openai-effort` with `openai-chat` / `openai-responses`, `anthropic-thinking` with `anthropic`, and
`google-thinking` with `google`; other combinations are validation errors. Many OpenAI-compatible servers accept only
`low | medium | high`: list the supported levels in `ModelInfo.reasoningEfforts` (`max` is offered only when listed).

With `openai-responses`, the adapter also sets `providerOptions.openai.forceReasoning = true` whenever it sends a
`reasoning` value: `@ai-sdk/openai` sends `reasoning.effort` only for model ids it recognizes as reasoning models, and
`forceReasoning` marks an unknown id as one (it also switches the system message to the `developer` role).

## 5. Declarative MCP servers

### Fields (`McpServerDecl`)

| Field | Type | Required | Validation / meaning |
|---|---|---|---|
| `id` | string | yes | `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`; must be `<pluginId>` or `<pluginId>-<suffix>`; unique across plugins and the MCP panel |
| `name` | string | yes | 1-64 characters; shown as the MCP server badge on tool rows |
| `policy` | `ToolPolicy` | no | policy of tools without annotations (default `ask`, see [section 10](#10-tool-approval)) |
| `transport` | object | yes | one of the transports below |

| `transport.type` | Fields | Behavior |
|---|---|---|
| `http` | `url`, `headers?` | Streamable HTTP (`createMCPClient` from `@ai-sdk/mcp`); redirects are rejected |
| `sse` | `url`, `headers?` | legacy HTTP+SSE transport |
| `stdio` | `command`, `args?`, `env?` | child process via `Experimental_StdioMCPTransport` from `@ai-sdk/mcp/mcp-stdio`; **requires trust** |

stdio details:

- Spawned without a shell (`shell: false`), working directory = the plugin directory, stdin/stdout = the MCP
  protocol (newline-delimited JSON-RPC). The MCP manager spawns the child through its own `MCPTransport`
  (`mcp/stdio-transport.ts`): stderr lines go to the owning plugin's log (`core-mcp` for servers of the MCP panel),
  and closing ends stdin, sends `SIGTERM`, then `SIGKILL` after a grace period. On Windows, where `.cmd` shims such as
  `npx` need resolving, the stock `Experimental_StdioMCPTransport` is used and stderr is ignored.
- Environment: only a minimal inherited set (POSIX `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`; Windows
  `APPDATA`, `HOMEDRIVE`, `HOMEPATH`, `LOCALAPPDATA`, `PATH`, `PROCESSOR_ARCHITECTURE`, `SYSTEMDRIVE`, `SYSTEMROOT`,
  `TEMP`, `USERNAME`, `USERPROFILE`) plus the declared `env`. `HF_*` variables and provider keys of the server are
  never inherited.
- The process is terminated when the server is disabled, the plugin is disabled or reloaded, or the server shuts
  down.

Templating: `url`, `headers` values, `args` items and `env` values may contain `{{settings.<key>}}`, resolved from the
plugin's settings (secret settings are decrypted at connect time). An empty value omits the header / env entry; an
empty value in `url` or an `args` item makes the connection fail with a message naming the missing setting. Prefer
`env` or `headers` for secrets: command lines are visible to other local users. `command` cannot be templated.

Connection lifecycle: servers connect in the background after the plugin is `active` (connect timeout 20 s, the
`core-mcp` setting `connectTimeoutSeconds`), never block boot, show their status on the plugin's detail page (with
**Restart**, `POST /api/mcp/:id/reconnect`), retry a failed or dropped connection with increasing delays (unless the
`core-mcp` setting `autoReconnect` is off), and are closed when their plugin is disabled. Tool names are
`mcp__<serverId>__<tool>` ([section 14](#14-naming-rules)). Step-by-step: [Adding an MCP server](./guides/adding-an-mcp-server.md).

## 6. Declarative commands

```json
{ "name": "tldr", "description": "Summarize text in three bullets", "template": "Summarize in three bullets:\n\n{{input}}" }
```

| Field | Validation / meaning |
|---|---|
| `name` | `^[a-z][a-z0-9-]{0,31}$`; not `new`, `model`, `effort`, `mode`, `help` (client-only); typed as `/name` |
| `description` | 1-120 characters, shown in the slash menu |
| `template` | 1 character to 16 KB; every `{{input}}` is replaced with the text after `/name ` (trimmed) |

- A command runs when the first text part of a user message starts with `/name` followed by whitespace or the end of
  the text. `/name` alone gives an empty input.
- If the template contains no `{{input}}` and the input is not empty, the input is appended after a blank line.
- The expanded text is sent to the model; the transcript keeps the original `/name input` and stores the expansion
  in the message `metadata.command` ([API.md](./API.md)).
- Duplicate names: the first registration wins (builtins first, then plugins in load order); later ones are rejected
  and logged.

## 7. Settings schema

A JSON-Schema-like subset rendered as the form of the plugin detail "Configuration" tab.

```ts
export interface SettingsSchema {
  type: 'object'
  required?: string[]
  properties: Record<string, SettingsProperty>
}
export type SettingsProperty = { title: string; description?: string; default?: unknown } & (
  | { type: 'string'; enum?: string[]; format?: 'secret' | 'url' | 'multiline'; pattern?: string }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number }
  | { type: 'boolean' }
  | { type: 'array'; items: { type: 'string'; enum?: string[] } }
)
```

Rules: property keys match `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`; at most 50 properties, rendered in key order; every
`required` key exists; `default` must validate against its property; `enum` (<= 100 values) and `format` do not
combine; `format: 'secret'` has no `default`; `pattern` is a JavaScript regular expression source (<= 256 characters,
compiled with the `u` flag, not implicitly anchored).

| Property | UI control | Validation |
|---|---|---|
| `string` | text input | `pattern` |
| `string` + `format: 'url'` | URL input | absolute `http:` / `https:` URL |
| `string` + `format: 'multiline'` | autosizing textarea | `pattern` |
| `string` + `format: 'secret'` | write-only password input: shows "Set" with Replace / Clear once stored; the value is never returned | none |
| `string` + `enum` | select | value in `enum` |
| `number` / `integer` | number input (step 1 for `integer`) | `minimum` / `maximum`, integer check |
| `boolean` | switch | |
| `array` + `items.enum` | multi-select (checkbox group) | unique values in `enum` |
| `array` of strings | tag input | unique non-empty strings |

`title` is the label, `description` the help text (plain text, never HTML). `required` fields show a marker and are
validated on save.

Storage and API:

- Non-secret values: `plugin_settings.values`. Secret values: encrypted in `secrets`, scope `plugin:<id>`, name
  `settings.<key>`.
- `GET /api/plugins/:id/settings` returns secrets only as set/unset markers with a masked hint; `PUT` validates the
  patch with `settingsValuesSchema(schema, { partial: true })` (unknown keys -> `validation_error`,
  [API.md](./API.md)):

  | `PUT` value | Non-secret property | Secret property (`format: 'secret'`) |
  |---|---|---|
  | key omitted | unchanged | unchanged (the stored secret is kept) |
  | `null` | stored value removed (the `default` applies again) | stored secret deleted |
  | `''` | stored as the empty string (optional strings may be empty) | stored secret deleted |
  | any other value | validated and stored | stored encrypted (any non-empty string) |

  A `required` property cannot be removed: `null` is rejected, and a required string (secret or not) must not be
  blank. The Configuration tab sends only changed fields; its secret input's **Clear** sends `''`.
- `ctx.settings.get()` returns stored values merged over defaults, with secrets decrypted (server memory only).
- After a successful `PUT`, `ctx.settings.onChange` callbacks run (guarded, 3 s) and MCP servers that use
  `{{settings.*}}` reconnect.

## 8. Code plugins

### Entry module

The file named by `main` is an ES module whose **default export** is a `PluginModule`:

```ts
export interface PluginModule {
  setup(ctx: PluginContext): void | Promise<void>
  dispose?(): void | Promise<void>
}
export function definePlugin(m: PluginModule): PluginModule   // identity helper for typing
```

- `setup(ctx)` registers contributions through `ctx`. It must resolve within 10 s (module evaluation + `setup`);
  start long-running work without awaiting it and stop it when `ctx.signal` aborts.
- Everything registered through `ctx` is removed automatically on disable, reload and uninstall. Each `register`
  also returns a `Disposable` for dynamic changes.
- `dispose()` (optional, 5 s) releases resources not created through `ctx` (timers, sockets, child processes).
- The loader rejects a module whose default export has no `setup` function.

### Runtime libraries come only from `ctx.ai`

Code plugins never install dependencies. The host injects its own copies of the libraries a plugin needs:

| `ctx.ai` member | Source | Typical use |
|---|---|---|
| `z` | `zod` (v4) | tool input schemas |
| `tool` | `ai` | building AI SDK tools for nested `generateText` calls |
| `jsonSchema` | `ai` | tool input schemas from plain JSON Schema |
| `generateText` | `ai` | calling a model from plugin code (with `ctx.models.resolve`) |
| `createOpenAICompatible` | `@ai-sdk/openai-compatible` | providers for OpenAI-compatible APIs |
| `createAnthropic` | `@ai-sdk/anthropic` | Anthropic-compatible APIs |
| `createOpenAI` | `@ai-sdk/openai` | OpenAI Responses-compatible APIs |
| `createGoogleGenerativeAI` | `@ai-sdk/google` (alias of `createGoogle`) | Gemini-compatible APIs |

Using the host's copies keeps one AI SDK and one zod in the process (schemas and model instances created by the
plugin are recognized by the host) and keeps plugins single-file.

Media (1.1.0): `ctx.ai` has no `generateImage`, `transcribe` or `generateSpeech`. A plugin *provides* image,
transcription and speech models through its `ProviderDefinition` (`createOpenAI(...).transcription(id)`, for example,
returns a `TranscriptionModelV4`), and *generates* images with `ctx.images.generate()`, which stores the files and
records the usage.

### Allowed imports

| Specifier | `.mjs` / `.js` entry | `.ts` entry |
|---|---|---|
| Node built-ins (`node:fs`, `node:crypto`, ...) | yes | yes (kept external) |
| `@harness-forge/plugin-sdk` | types only, through JSDoc `import('@harness-forge/plugin-sdk')` | `import type ...`, plus `definePlugin` / `PLUGIN_API_VERSION` (aliased to the host shim at build) |
| relative imports (`./util.js`) | no | no |
| any other package | no | no |

A code plugin is **one file**: the trust hash covers `plugin.json` and the entry only, and hot reload re-imports the
entry only. The host checks imports when loading (`.mjs` / `.js`: an esbuild import scan; `.ts`: the build) and
fails the load with a clear message on a forbidden import. There is no `npm install` and no lifecycle script, ever.

### `.mjs` / `.js` entries

Loaded directly with `import()`. Type them with JSDoc:

```js
// @ts-check
/** @type {import('@harness-forge/plugin-sdk').PluginModule} */
export default {
  setup(ctx) {
    ctx.logger.info('hello from my plugin')
  },
}
```

If the SDK types cannot be resolved by your editor, JSDoc types degrade to `any`; the host validates everything at
runtime anyway. To resolve them without installing anything, put a copy of `harness-forge.d.ts` next to the entry and
reference it at the top of the entry, after `// @ts-check` (`/// <reference path="./harness-forge.d.ts" />`): every
code template writes this
file (an ambient `declare module '@harness-forge/plugin-sdk'` mirroring section 9, with the `ctx.ai` libraries typed
as `any`), and the code examples ship it. The host ignores the file and it is not part of the trust hash.

### `.ts` entries

Compiled by the host with esbuild when the plugin loads and on "Build & reload" (`POST /api/plugins/:id/build`):
`bundle: true`, `format: 'esm'`, `platform: 'node'`, `target: 'node22'`, `sourcemap: 'inline'`,
`alias: { '@harness-forge/plugin-sdk': <host shim> }`, Node built-ins external. The output goes to
`data/cache/plugins/<id>/<sha256>.mjs` and is imported from there. esbuild strips types without type checking; build
errors are returned as diagnostics (Source tab) and written to the plugin log. The shim exports `definePlugin` and
`PLUGIN_API_VERSION`; everything else in the SDK is types. Type-only imports of other packages
(`import type { LanguageModelV4 } from '@ai-sdk/provider'`) compile too, because esbuild removes them, but an editor
resolves them only where that package is installed.

The **Code plugin** form of the UI creates `index.mjs` entries; `POST /api/plugins/scaffold` with
`"language": "ts"` creates the same templates as `index.ts`. Both write `plugin.json`, the entry,
`harness-forge.d.ts` and a `README.md`. Walkthrough: [Writing a code plugin](./guides/writing-a-code-plugin.md).

## 9. API reference

### Types (authoritative)

```ts
import type {
  ImageModelV3, ImageModelV4, LanguageModelV3, LanguageModelV4, SharedV4ProviderOptions,
  SpeechModelV3, SpeechModelV4, TranscriptionModelV3, TranscriptionModelV4,
} from '@ai-sdk/provider'
import type {
  FlexibleSchema, LanguageModel, LanguageModelCallOptions, LanguageModelUsage,
  ModelMessage, Tool, UIMessage,
} from 'ai'

export const PLUGIN_API_VERSION = '1.2.0'

/** Same type as the AI SDK `ProviderOptions` (`ai` does not re-export it). */
export type ProviderOptions = SharedV4ProviderOptions

// ---------- enumerations (DECISIONS.md) ----------
export type PluginKind = 'declarative' | 'code'
export type PluginSource = 'builtin' | 'created' | 'zip' | 'npm' | 'url' | 'link' | 'copy'
export type PluginState = 'disabled' | 'untrusted' | 'incompatible' | 'loading' | 'active' | 'error'
export type PluginPermission = 'network' | 'secrets' | 'storage' | 'hooks' | 'process'
export type ToolMode = 'off' | 'ask' | 'edits' | 'auto'                      // 1.2: + edits ("Accept edits")
export type ToolWorkspaceAccess = 'read' | 'write' | 'execute'               // 1.2 (shared WorkspaceAccess)
export type ToolPolicy = 'safe' | 'ask' | 'always'
export type ReasoningEffort = 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max'
/** AI SDK v7 top-level `reasoning` values without 'provider-default':
 *  'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' */
export type ReasoningLevel = Exclude<NonNullable<LanguageModelCallOptions['reasoning']>, 'provider-default'>
export type ApiFormat = 'openai-chat' | 'openai-responses' | 'anthropic' | 'google'
export type ReasoningStyle = 'openai-effort' | 'anthropic-thinking' | 'google-thinking' | 'none'
export type ModelKind = 'chat' | 'embedding' | 'image' | 'audio' | 'transcription' | 'speech' | 'other'  // 1.1: + transcription, speech
export type ImageAspectRatio = '1:1' | '3:2' | '2:3' | '4:3' | '3:4' | '16:9' | '9:16'       // 1.1 (IMAGE_ASPECT_RATIOS)
export type HarnessErrorCode =                   // from @harness-forge/shared (DECISIONS error envelope)
  | 'validation_error' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'payload_too_large'
  | 'provider_not_configured' | 'auth_invalid' | 'rate_limited' | 'model_not_found' | 'context_overflow'
  | 'provider_unreachable' | 'provider_error' | 'plugin_error' | 'internal_error' | 'not_implemented'
export type HarnessErrorAction = 'configure-provider' | 'refresh-models' | 'login' | 'retry'

// ---------- manifest ----------
export interface PluginManifest {
  $schema?: string
  manifestVersion: 1
  id: string
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  icon?: string                                   // 'lobe:<slug>' | relative .svg/.png path
  engines: { harness: string }                    // semver range vs PLUGIN_API_VERSION
  main?: string                                   // present => code plugin (.mjs | .js | .ts)
  permissions?: PluginPermission[]
  settings?: SettingsSchema
  contributes?: {
    providers?: DeclarativeProvider[]
    models?: { providerId: string; models: ModelInfo[] }[]
    mcpServers?: McpServerDecl[]
    commands?: DeclarativeCommand[]
  }
}
export interface DeclarativeProvider {
  id: string
  name: string
  icon?: string
  baseURL: string
  apiFormat: ApiFormat
  auth?: { type: 'bearer' | 'header' | 'none'; header?: string }
  credentials?: CredentialField[]                 // envVar not allowed here
  headers?: Record<string, string>                // '{{credentials.<key>}}'
  models?: ModelInfo[]
  listModels?: boolean | { path?: string; include?: string; exclude?: string }
  reasoningStyle?: ReasoningStyle                 // default 'none'
  modelsDevId?: string
  smallModelId?: string
}
export interface McpServerDecl {
  id: string
  name: string
  policy?: ToolPolicy                             // default 'ask'
  transport:
    | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
    | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
}
export interface DeclarativeCommand { name: string; description: string; template: string }
// SettingsSchema / SettingsProperty: section 7

// ---------- providers and models ----------
export interface CredentialField {
  key: string                                     // ^[a-zA-Z][a-zA-Z0-9_]{0,63}$
  label: string
  type: 'secret' | 'text' | 'url' | 'select'
  required?: boolean                              // default false
  default?: string
  options?: string[]                              // required for 'select'
  envVar?: string | string[]                      // env fallback names, first non-empty wins
  helpUrl?: string                                // "where do I get this" link
  advanced?: boolean                              // rendered in the "Advanced" section
}
export interface ModelInfo {
  id: string
  name?: string
  kind?: ModelKind                                // absent: classified by the host (most models are 'chat')
  contextWindow?: number
  maxOutputTokens?: number
  capabilities?: {
    tools?: boolean; vision?: boolean; pdf?: boolean; reasoning?: boolean; structuredOutput?: boolean
    imageOutput?: boolean                         // 1.1: a chat model that can return images (Gemini *-image)
  }
  reasoningEfforts?: ReasoningEffort[]
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }   // USD per 1M tokens
  voices?: string[]                               // 1.1: speech models: voice names to suggest (<= 100, unique)
}
export interface ProviderRuntime {
  credentials: Record<string, string>
  fetch: typeof globalThis.fetch
  signal?: AbortSignal
}
export interface ReasoningParams {
  reasoning?: ReasoningLevel                      // AI SDK v7 top-level `reasoning` call option
  providerOptions?: ProviderOptions
  maxOutputTokens?: number
}
export interface HarnessErrorInit {                // shape of API.md section 2.1
  code: HarnessErrorCode
  message: string
  status?: number                                 // upstream HTTP status (the response status derives from code)
  providerId?: string
  retryAfterMs?: number
  action?: HarnessErrorAction
  details?: unknown
}
// ---------- 1.1.0: image and transcription requests (Phase 6) ----------
export interface ImageParamsRequest {             // input of ProviderDefinition.imageParams()
  n: number                                       // images to generate, 1..4 (always 1 for a chat model with image output)
  aspectRatio?: ImageAspectRatio                  // omitted = the provider default ("Auto")
  inputs: number                                  // input images sent with the prompt (an edit); 0 = a new image
}
export interface ImageParamsResult {              // call additions returned by imageParams()
  size?: `${number}x${number}`                    // generateImage({ size }) of an image model, e.g. '1536x1024'
  aspectRatio?: `${number}:${number}`             // generateImage({ aspectRatio }) of an image model, e.g. '16:9'
  providerOptions?: ProviderOptions               // deep-merged: generateImage (image model) or streamText (imageOutput chat model)
}
export interface TranscriptionHints {             // input of ProviderDefinition.transcriptionOptions()
  language?: string                               // ISO 639 code of the spoken language; absent = detect automatically
}
export interface ProviderDefinition {
  id: string
  name: string
  icon?: string | { color?: string; mono?: string } // 'lobe:<slug>' (or a pair); default: the plugin icon
  credentials: CredentialField[]
  modelsDevId?: string
  smallModelId?: string
  seedModels?: ModelInfo[]
  keyUrl?: string
  createLanguageModel(modelId: string, rt: ProviderRuntime): LanguageModelV4 | LanguageModelV3
  listModels?(rt: ProviderRuntime): Promise<ModelInfo[]>
  validate?(rt: ProviderRuntime): Promise<void>
  reasoning?(effort: ReasoningEffort, model: ModelInfo): ReasoningParams | undefined
  mapError?(err: unknown): HarnessErrorInit | undefined
  // ---------- 1.1.0 (Phase 6, all optional) ----------
  createImageModel?(modelId: string, rt: ProviderRuntime): ImageModelV4 | ImageModelV3
  imageParams?(request: ImageParamsRequest, model: ModelInfo): ImageParamsResult | undefined
  createTranscriptionModel?(modelId: string, rt: ProviderRuntime): TranscriptionModelV4 | TranscriptionModelV3
  createSpeechModel?(modelId: string, rt: ProviderRuntime): SpeechModelV4 | SpeechModelV3
  transcriptionOptions?(hints: TranscriptionHints): ProviderOptions | undefined
}

// ---------- tools ----------
/** The AI SDK tool result output union ('text' | 'json' | 'execution-denied' | 'error-text' | 'error-json' |
 *  'content'); `ai` does not export the name, so the SDK derives it. */
export type ToolResultOutput = Awaited<ReturnType<NonNullable<Tool['toModelOutput']>>>
// ---------- 1.2.0: workspace (Phase 7) ----------
export interface ToolWorkspace {                  // the open project folder of the chat
  readonly projectId: string                      // 'prj_' + 16 characters
  readonly name: string                           // the project name
  readonly root: string                           // absolute, verified realpath of the project folder
}
export interface ToolCallContext {
  chatId: string
  modelRef: string
  toolCallId: string
  messages: ModelMessage[]                        // messages sent to the model for this step (read-only)
  signal: AbortSignal                             // aborted on stop, timeout, or plugin disable
  workspace?: ToolWorkspace                       // 1.2: set for every tool in a chat whose project folder opened
}
export interface ToolDefinition<I = unknown, O = unknown> {
  name: string                                    // ^[a-zA-Z0-9_-]{1,64}$, globally unique
  description: string
  inputSchema: FlexibleSchema<I>                  // ctx.ai.z object schema or ctx.ai.jsonSchema()
  policy?: ToolPolicy | ((input: I, c: ToolCallContext) => ToolPolicy | 'deny' | Promise<ToolPolicy | 'deny'>)
  timeoutMs?: number                              // default 60_000, max 600_000
  workspace?: ToolWorkspaceAccess                 // 1.2: offered only with an open workspace; 'write' + policy 'ask'
                                                  // runs without a card in mode 'edits'; 'execute' needs HF_WORKSPACE_SHELL
  execute(input: I, c: ToolCallContext): Promise<O>
  toModelOutput?(output: O, c: { toolCallId: string; input: I }): ToolResultOutput | Promise<ToolResultOutput>
}

// ---------- commands ----------
export interface CommandDefinition {
  name: string                                    // ^[a-z][a-z0-9-]{0,31}$
  description: string
  template?: string                               // exactly one of template / run
  run?(i: { input: string; chatId: string; signal: AbortSignal }):
    Promise<{ type: 'prompt'; text: string } | { type: 'reply'; markdown: string }>
}

// ---------- hooks ----------
type C = { chatId: string; modelRef: string }
export interface HookMap {                        // [input, output]; handlers mutate output
  'chat.params': [C & { model: ModelInfo; reasoningEffort: ReasoningEffort; toolMode: ToolMode },
    { instructions: string; temperature?: number; maxOutputTokens?: number; maxSteps: number;
      reasoning?: ReasoningLevel; providerOptions: ProviderOptions }]
  'chat.headers': [C, { headers: Record<string, string> }]
  'chat.messages': [C, { messages: ModelMessage[] }]
  'tool.approve': [C & { tool: string; toolCallId: string; input: unknown }, { decision?: 'allow' | 'ask' | 'deny' }]
  'tool.before': [C & { tool: string; toolCallId: string }, { input: unknown }]   // throw => blocked
  'tool.after': [C & { tool: string; toolCallId: string; input: unknown }, { output: unknown }]
  'message.completed': [C & { message: UIMessage; usage: LanguageModelUsage; costUsd?: number; aborted: boolean }, void]
}
export type HookName = keyof HookMap

// ---------- context ----------
export interface Disposable { dispose(): void }
export interface Logger {
  debug(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
}
export interface KV<V = unknown> {
  get<T extends V = V>(key: string): Promise<T | undefined>
  set(key: string, value: V): Promise<void>
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<string[]>
}
export interface HostAi {
  z: typeof import('zod').z
  tool: typeof import('ai').tool
  jsonSchema: typeof import('ai').jsonSchema
  generateText: typeof import('ai').generateText
  createOpenAICompatible: typeof import('@ai-sdk/openai-compatible').createOpenAICompatible
  createAnthropic: typeof import('@ai-sdk/anthropic').createAnthropic
  createOpenAI: typeof import('@ai-sdk/openai').createOpenAI
  createGoogleGenerativeAI: typeof import('@ai-sdk/google').createGoogleGenerativeAI
}
// ---------- 1.1.0: ctx.images (Phase 6) ----------
export interface ImageGenerateOptions {
  prompt: string                                  // 1..32000 characters (trimmed)
  modelRef?: string                               // an image model; default: the imageModelRef setting (Settings -> Media)
  n?: number                                      // 1..4, default 1
  aspectRatio?: ImageAspectRatio
  chatId?: string                                 // attributes the usage row to a chat
  signal?: AbortSignal
}
export interface GeneratedImageFile {             // one generated image, stored as a file
  fileId: string
  url: string                                     // '/api/files/<fileId>', usable as the url of a UI file part
  mediaType: string                               // 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  name: string                                    // e.g. 'image-1.png'
  size: number                                    // bytes
}
export interface ImageGenerateResult {
  modelRef: string                                // the image model used
  modelName: string                               // 1.2: its display name (the catalog name, else the model id)
  images: GeneratedImageFile[]
  costUsd?: number                                // estimated from catalog prices; absent when unknown
  revisedPrompt?: string                          // the prompt as rewritten by the provider, when it reports one
}
export interface PluginImagesApi {
  generate(options: ImageGenerateOptions): Promise<ImageGenerateResult>
}
export interface PluginContext {
  plugin: { id: string; version: string; dir: string; dataDir: string }
  logger: Logger
  signal: AbortSignal                             // aborted on disable / reload / uninstall / shutdown
  settings: {
    get<T = Record<string, unknown>>(): T
    onChange(cb: (values: Record<string, unknown>) => void | Promise<void>): Disposable
  }
  secrets: KV<string>
  storage: KV
  providers: { register(d: ProviderDefinition): Disposable }
  models: {
    register(providerId: string, models: ModelInfo[]): Disposable
    resolve(ref: string): Promise<Exclude<LanguageModel, string>>
  }
  tools: { register<I, O>(d: ToolDefinition<I, O>): Disposable }
  mcp: { register(d: McpServerDecl): Disposable }
  commands: { register(d: CommandDefinition): Disposable }
  hooks: {
    on<K extends HookName>(name: K, fn: (...args: HookMap[K]) => unknown, options?: { priority?: number }): Disposable
  }
  ai: HostAi
  fetch: typeof globalThis.fetch
  images: PluginImagesApi                         // 1.1.0 (Phase 6)
}
export interface PluginModule {
  setup(ctx: PluginContext): void | Promise<void>
  dispose?(): void | Promise<void>
}
export function definePlugin(m: PluginModule): PluginModule { return m }
```

Package layering (ADR-018): the data shapes (`PluginManifest`, `DeclarativeProvider`, `McpServerDecl`,
`DeclarativeCommand`, `CredentialField`, `ModelInfo`, `SettingsSchema`) and every enum are zod schemas in
`@harness-forge/shared` (`pluginManifestSchema`, `declarativeProviderSchema`, `mcpServerDeclSchema`,
`credentialFieldSchema`, `modelInfoSchema`, `settingsSchemaSchema`, `reasoningEffortSchema`, `toolPolicySchema`,
`apiFormatSchema`, `harnessErrorCodeSchema`, `modelKindSchema`, `imageAspectRatioSchema`, ...; see
[API.md](./API.md)), and the types above are inferred from
them. `@harness-forge/plugin-sdk` re-exports them unchanged (the types, and the manifest and plugin data schemas as
values) and adds the runtime contract (`PluginContext`, `ProviderDefinition`, `ToolDefinition`, `CommandDefinition`,
`HookMap`, `PluginModule`, `definePlugin`, `PLUGIN_API_VERSION`) plus `settingsValuesSchema(schema)`, which builds the
zod validator of a settings form. Plugin API 1.1.0 adds the type exports `ImageParamsRequest`, `ImageParamsResult`,
`TranscriptionHints`, `PluginImagesApi`, `ImageGenerateOptions`, `ImageGenerateResult` and `GeneratedImageFile`, and
re-exports the types `ImageAspectRatio` and `ModelKind` from shared. Plugin API 1.2.0 adds `ToolWorkspace` and
`ToolWorkspaceAccess` (the shared `WorkspaceAccess` / `workspaceAccessSchema`). The template mirror
`apps/server/src/plugins/templates/sdk-types.ts` (the `harness-forge.d.ts` of the templates and examples) follows the
SDK, including the `ToolMode` literal. `ModelInfo` must be imported from these packages,
not from `ai` (which exports an unrelated type of the same name).

### `PluginContext`

| Member | Semantics |
|---|---|
| `plugin.id`, `plugin.version` | from the manifest |
| `plugin.dir` | absolute realpath of the plugin directory (read-only by convention; for builtins, their source directory) |
| `plugin.dataDir` | absolute path of `data/plugins/.data/<id>/`, created (mode 0700) before `setup`; survives updates; removed on uninstall unless `keepData` |
| `logger` | writes to the per-plugin ring buffer (last 500 entries, `message` capped at 4 KB, `data` must be JSON-serializable) and to the process log with `pluginId`; the plugin's secret values are redacted; each entry is published as a `plugin.log` event |
| `signal` | aborted when the plugin is disabled, reloaded, uninstalled, or the server shuts down |
| `settings.get()` | current settings: stored values over defaults, secrets decrypted; synchronous (cached in memory) |
| `settings.onChange(cb)` | called with the full new values after a successful save (guarded, 3 s) |
| `secrets` | encrypted plugin-scoped strings (scope `plugin:<id>`, name `kv.<key>`); keys `^[A-Za-z0-9._:-]{1,128}$`, values <= 16 KB; never returned by any API; `list()` returns keys only |
| `storage` | plugin-scoped JSON values in `plugin_kv`; keys 1-256 characters without control characters; values JSON-serializable, <= 256 KB each, <= 10 MB per plugin; `set(key, undefined)` is an error (use `delete`). Phase 7: the storage cleanup (Settings → Data, ADR-035) keeps every file whose id (`file_` + 16 characters) appears in a `ctx.storage` value or a plugin setting, so keep the ids of files your plugin needs there, never only in files under `plugin.dataDir` (those are not scanned, and such files may be removed once no chat references them) |
| `providers.register(d)` | validates `d` (id namespace, credential fields, functions), then adds the provider; a duplicate id throws `conflict` |
| `models.register(providerId, models)` | adds models / metadata to any provider (plugin models tier); held until the provider exists |
| `models.resolve(ref)` | returns a model instance for `providerId:modelId` with the user's credentials; throws `provider_not_configured` (a disabled provider, missing credentials and, since 1.2.0, an unknown provider) / `not_found` (an unknown model); use with `ctx.ai.generateText` |
| `tools.register(d)` | validates name, schema and policy; a duplicate or `mcp__`-prefixed name throws `conflict` |
| `mcp.register(d)` | same rules as `contributes.mcpServers` |
| `commands.register(d)` | exactly one of `template` / `run`; a duplicate name throws `conflict` |
| `hooks.on(name, fn, { priority })` | registers a hook handler; see [Hooks](#hooks) |
| `images.generate(o)` | 1.1.0 (ADR-028): generates `o.n` images (default 1) with `o.modelRef` or the `imageModelRef` setting, stores every image as a file (PNG, JPEG, WebP or GIF, at most 20 MB, the same bytes reuse one file) and returns an `ImageGenerateResult` with file references (`url` = `/api/files/<fileId>`; `costUsd` only when the catalog prices the model; `modelName` since 1.2.0). Writes exactly one usage row (`purpose: 'image'`, attributed to `o.chatId` when given, else no chat) with the estimated cost. Aborted by `o.signal` and by `ctx.signal`: the promise rejects with the abort reason (a provider answer that arrives after the abort still writes its usage row but stores no image). Errors (`HarnessError`): options that fail the checks (the `generate_image` input rules, a `modelRef`, `chatId` <= 128 characters) → `validation_error`; no model → `validation_error` "Choose an image model in Settings → Media."; a model that is not an image model → `validation_error` (`modelRef: The model "<ref>" is not an image model.`); an image model whose provider has no `createImageModel` → `model_not_found`; an unknown provider (since 1.2.0; 1.1 answered `not_found`), a disabled provider or a missing key → `provider_not_configured` (action `configure-provider`); provider failures mapped as for chats (`auth_invalid`, `rate_limited`, `provider_error`, ...); every returned image refused by the file store → `provider_error` "The image model returned no image that could be stored: only PNG, JPEG, WebP and GIF images of at most 20 MB are kept."; a call after the plugin was disposed → `plugin_error`. The builtin `generate_image` tool uses it. `ctx.ai` has no `generateImage`: images made through `ctx.images` are stored and accounted for |
| `ai` | host library copies ([section 8](#8-code-plugins)) |
| `fetch` | global `fetch` combined with `ctx.signal` (`AbortSignal.any`) and a default `User-Agent: harness-forge/<appVersion> plugin/<id>`; no SSRF guard (code plugins are trusted); no default timeout |

All `register` calls are valid during and after `setup` until the plugin is disposed; calls after disposal throw.

### `ProviderDefinition`

| Member | Required | Semantics |
|---|---|---|
| `id` | yes | builtins: models.dev keys (DECISIONS); plugins: `<pluginId>` or `<pluginId>-<suffix>` |
| `name` | yes | UI name (Settings -> Providers, picker group header) |
| `icon` | no | `lobe:<slug>`, or `{ color?: 'lobe:<slug>', mono?: 'lobe:<slug>' }` when the two variants have different slugs (`{ color: 'lobe:zhipu-color', mono: 'lobe:zai' }`); a single `lobe:<x>` also offers `<x>-color`, and `lobe:<x>-color` also offers `<x>`, when those files exist; omitted or unresolvable -> the plugin icon (file icons included), else a monogram |
| `credentials` | yes | fields of the key dialog; `[]` for keyless providers |
| `modelsDevId` | no | models.dev key for metadata (default: `id`) |
| `smallModelId` | no | cheap model for chat titles and the default credential ping |
| `seedModels` | no | chat seeds are used when there is no live listing and no cached listing; seeds with a media kind (`image`, `transcription`, `speech`; 1.1) are always listed, even next to a live listing, when the provider defines the matching factory |
| `keyUrl` | no | "Get a key" link in the key dialog |
| `createLanguageModel(modelId, rt)` | yes | returns a provider **instance** model; called per request; must not perform network I/O; guarded (5 s); any model id may be requested (custom ids) |
| `listModels(rt)` | no | live listing; guarded (15 s); cached 24 h; a failure keeps the last good listing |
| `validate(rt)` | no | credential test; guarded (15 s). Default: `listModels(rt)` when defined, else a 1-token `generateText` on `smallModelId` (else the first chat seed, else the first visible chat model; never an image, transcription or speech model) |
| `reasoning(effort, model)` | no | synchronous; called only when `effort !== 'auto'`, `model.capabilities.reasoning` is true and `effort` is offered for the model; returns request additions or `undefined` |
| `mapError(err)` | no | synchronous; first chance to map an error of this provider; return `undefined` to fall back to the default mapping |
| `createImageModel(modelId, rt)` | no (1.1.0) | returns an `ImageModelV4` (or `V3`) instance for a model of kind `image`; called per generation; no network I/O; guarded (5 s; a returned promise is awaited inside the guard; a throw, a timeout or a value that is not a model instance is a `plugin_error`). Without it the provider's image models are left out of the catalog; a custom image model id the user adds stays listed and resolves to `model_not_found` |
| `imageParams(request, model)` | no (1.1.0) | synchronous; maps an `ImageParamsRequest` `{ n, aspectRatio?, inputs }` (images requested, the aspect ratio, input images) to an `ImageParamsResult` `{ size?, aspectRatio?, providerOptions? }` for this model, or `undefined`. Used for dedicated image models (`size`, `aspectRatio` and `providerOptions` go to `generateImage`; without `imageParams` the aspect ratio is passed as is) and for chat models with `capabilities.imageOutput` (called with `n: 1`, `inputs: 0`; only `providerOptions` is used, deep-merged under the `reasoning()` options). The result is checked (`size` as `WxH`, `aspectRatio` as `W:H`, `providerOptions` an object of objects; anything else is dropped); a throw is logged and ignored. Examples in [PROVIDERS.md 13](./PROVIDERS.md#13-image-and-voice-models) |
| `createTranscriptionModel(modelId, rt)` | no (1.1.0) | returns a `TranscriptionModelV4` (or `V3`) instance for a model of kind `transcription` (dictation); no network I/O; guarded like `createImageModel`. Without it the provider's transcription models are left out of Settings → Media; a custom one answers `validation_error` (`modelRef: The provider "<name>" cannot transcribe speech, so the model "<ref>" cannot be used.`) |
| `createSpeechModel(modelId, rt)` | no (1.1.0) | returns a `SpeechModelV4` (or `V3`) instance for a model of kind `speech` (read-aloud); no network I/O; guarded like `createImageModel`. Without it the provider's speech models are left out (a custom one answers `validation_error`, "cannot read text aloud") |
| `transcriptionOptions(hints)` | no (1.1.0) | synchronous; turns `TranscriptionHints` `{ language? }` into provider options for `transcribe()`, e.g. `{ openai: { language } }`; `undefined` = send nothing. The host calls it only with an ISO 639 code (the setting "Detect automatically" never reaches it); a throw or a value that is not an object of objects sends no language |

Registration (`ctx.providers.register`, and the definitions built from declarative providers) checks the data fields
and the functions: `createLanguageModel` is required; `listModels`, `validate`, `reasoning`, `mapError` and the 1.1
members `createImageModel`, `imageParams`, `createTranscriptionModel`, `createSpeechModel` and `transcriptionOptions`
must be functions when present (`validation_error` `Provider "<id>": "<member>" must be a function.`).

`ProviderRuntime`:

| Member | Semantics |
|---|---|
| `credentials` | resolved values of every declared field: stored value -> environment variable (`envVar`, builtin and code plugins only) -> `default`; unresolved optional fields are absent |
| `fetch` | host `fetch` for provider requests: aborted with the run (or the guard timeout), follows at most 5 **same-origin** redirects (cross-origin redirects fail with `provider_error`), logs method + URL at `debug` (never headers or bodies) |
| `signal` | the run signal for `createLanguageModel`, the guard signal for `listModels` / `validate` |

`ReasoningParams`: `reasoning` is passed as `streamText({ reasoning })`, `providerOptions` is deep-merged into the
call's provider options, `maxOutputTokens` overrides the call value. In AI SDK v7, reasoning settings inside
`providerOptions` take full precedence over the top-level `reasoning` value (they are never merged).

`CredentialField`: `secret` values are encrypted (scope `provider:<id>`, name = key) and never returned; `text` /
`url` / `select` values are stored in `provider_configs.options`. `envVar` lists fallback variable names (first
non-empty wins); a provider whose required fields resolve only from the environment reports status `env`.

`ModelInfo`:

| Field | Meaning |
|---|---|
| `id` | model id sent to the API; unique per provider; <= 256 characters, may contain `:` and `/` |
| `name` | display name (default: `id`) |
| `kind` | absent: the host classifies the model (the image id pattern, models.dev modalities, else the id; [ARCHITECTURE.md 9](./ARCHITECTURE.md#9-model-catalog)), and most models are `chat`. An explicit `kind` wins over that classification. `image` models appear in the composer's "Image models" group; `transcription` and `speech` models (1.1) are chosen in Settings → Media; `embedding`, `audio` and `other` are hidden. Image, transcription and speech models are listed only when the provider defines the matching factory (a custom model id excepted); seeds of those three kinds are listed even next to a live listing |
| `contextWindow` / `maxOutputTokens` | token limits (positive integers); used for trimming and the usage ring |
| `capabilities.tools` | `false` -> tools are not sent to this model |
| `capabilities.vision` / `pdf` | image / PDF attachments are sent as file parts |
| `capabilities.reasoning` | shows the effort menu |
| `capabilities.structuredOutput` | informational |
| `capabilities.imageOutput` | 1.1: a chat model that can return images in its reply; the composer offers the aspect ratio and the provider's `imageParams` adds the provider options. Only chat models report it (the catalog sets it to `false` on every other kind); models.dev sets it for a text + image output |
| `reasoningEfforts` | efforts offered in the effort menu besides `auto` (which is always offered); when omitted on a reasoning model: `off`, `low`, `medium`, `high`; `max` only when listed; an effort that is not offered is treated as `auto` |
| `cost` | USD per 1M tokens (`input`, `output`, `cacheRead`, `cacheWrite`); image models use `input` / `output` for the image token usage (an estimate: `(input tokens × input + output tokens × output) / 1e6`; no cost without a price or without token counts) |
| `voices` | 1.1: speech models only; up to 100 unique voice names (1-64 characters) suggested in Settings → Media; the user may type any other name. Seeds and `models.register` must pass this rule (else `validation_error`); a live listing's list is cleaned instead (invalid names dropped, duplicates removed, capped at 100) |

### Tools

Execution of a registered tool (wrapped by the host):

0. Offering (1.2.0): a tool with `workspace` set is sent to the model only in a chat whose project folder opened, and a
   tool with `workspace: 'execute'` only while `HF_WORKSPACE_SHELL` is not `0`. Every tool of such a run (with or
   without `workspace`) gets `c.workspace = { projectId, name, root }` (frozen; `root` is the verified realpath).
1. The owner plugin must be `active`, else the result is the error "tool unavailable".
2. Approval ([section 10](#10-tool-approval)).
3. `tool.before` hooks; the (possibly changed) input is re-validated against `inputSchema`.
4. `execute(input, c)` under `guard` (`timeoutMs`, default 60 s, max 600 s). `c.signal` aborts on user stop, timeout
   or plugin disable.
5. `tool.after` hooks.
6. The output must be JSON-serializable; it is capped at 64 KB of serialized JSON (truncated with a marker).
7. `toModelOutput(output, { toolCallId, input })`, when defined, converts the stored output for the model. It also
   runs when history is converted with `convertToModelMessages`, so it must be fast and deterministic (guarded, 3 s;
   on failure or when the tool is no longer registered the output is sent as JSON).

A throw in `execute` becomes an error result for the model (`error-text` with the message), a failed tool row in the
UI, and a `plugin_error` log entry. `inputSchema` must describe a JSON object. `description` is sent to the model
(<= 1024 characters).

Workspace tools (1.2.0): `workspace` declares what the tool does with the project folder (`read`, `write`,
`execute`); registration rejects any other value (`validation_error` naming the tool), and `GET /api/tools` reports it
as `ToolSummary.workspace` (the web hides "Always allow" for `execute` tools and offers "Accept all edits in this chat"
for `write` tools). The host does **not** confine a plugin tool to `c.workspace.root`: a code plugin runs with the
server's rights (section 13), so resolve every path against `root` and refuse anything outside it yourself (resolve
symbolic links with `realpath` and compare the result with `root`), as the builtin `core-workspace` tools do. Never
start a shell from a plugin tool; offer the builtin `shell` instead.

### Commands

`template` commands behave like [declarative commands](#6-declarative-commands). `run` commands are guarded (30 s):
`{ type: 'prompt', text }` replaces the text sent to the model; `{ type: 'reply', markdown }` is written as the
assistant message without a model call. A throw or timeout is shown as a `plugin_error` in the chat.

### Hooks

Handlers run sequentially: higher `priority` first (default 0), then plugin load order, then registration order.
The `input` object is frozen; each handler receives the current `output` draft and mutates it in place. Return
values are ignored. Changes of a handler that throws or times out are discarded (the host passes a copy and commits
it on success). A handler that fails 5 times in a row is disabled until its plugin reloads (a `warn` entry is
logged and the plugin detail shows it).

| Hook | Input (read-only) | Output (mutable) | When it runs | Timeout | Failure behavior |
|---|---|---|---|---|---|
| `chat.params` | `chatId`, `modelRef`, `model`, `reasoningEffort`, `toolMode` | `instructions`, `temperature?`, `maxOutputTokens?`, `maxSteps`, `reasoning?`, `providerOptions` | once per chat run (not for image turns, which call no chat model), after model resolution and `provider.reasoning()`, before `streamText`; for a chat model with image output `providerOptions` already holds the `imageParams()` options | 3 s | changes discarded, run continues |
| `chat.headers` | `chatId`, `modelRef` | `headers` (sent with every model request of the run) | once per chat run, after `chat.params` (not for image turns) | 3 s | changes discarded |
| `chat.messages` | `chatId`, `modelRef` | `messages` (`ModelMessage[]` after `convertToModelMessages`, before context trimming): the path being answered, from the first message to the new or answered user message; other versions of edited or regenerated messages are never included (ADR-023) | once per chat run (image turns send no history and run no `chat.*` hook) | 3 s | changes discarded |
| `tool.approve` | `chatId`, `modelRef`, `tool`, `toolCallId`, `input` | `decision?` (`allow` / `ask` / `deny`) | per tool call in `ask` / `auto` mode, step 2 of the approval order | 3 s | ignored; resolution falls through to the policy |
| `tool.before` | `chatId`, `modelRef`, `tool`, `toolCallId` | `input` | per execution, after approval, before `execute` | 3 s | **a throw blocks the call** (error result `Blocked by <pluginId>: <message>`, not counted as a failure); a timeout also blocks and counts |
| `tool.after` | `chatId`, `modelRef`, `tool`, `toolCallId`, `input` | `output` | per successful execution, before the 64 KB cap | 3 s | changes discarded (original output kept) |
| `message.completed` | `chatId`, `modelRef`, `message`, `usage`, `costUsd?`, `aborted` | none | once per run after the assistant message is persisted (finished, aborted or failed runs; errors are in `message.metadata.error`); image turns included (their `usage` holds the image token counts); `costUsd` includes an image turn's estimated cost and the `costUsd` of `generate_image` outputs | 3 s | logged only |

## 10. Tool approval

The approval function passed to `streamText({ toolApproval })` returns an AI SDK `ToolApprovalStatus`. Resolution
order (first match wins; same table as [ARCHITECTURE.md 6.2](./ARCHITECTURE.md#62-tool-approval-round-trip)):

| Step | Rule | Result |
|---|---|---|
| 1 | user override in `tool_prefs.override` = `deny` / `allow` / `ask` | `denied` / `approved` / `user-approval` |
| 2 | `tool.approve` hook sets `decision` = `deny` / `allow` / `ask` | `denied` / `approved` / `user-approval` |
| 3 | tool policy (static or function) is `deny` | `denied` |
| 4 | chat `toolMode` = `ask`, policy `safe` | `not-applicable` (runs, no card) |
| 5 | chat `toolMode` = `ask`, policy `ask` or `always` | `user-approval` (approval card) |
| 6 | chat `toolMode` = `edits` (1.2.0, "Accept edits"), policy `safe`, or policy `ask` with `workspace: 'write'` | `not-applicable` |
| 7 | chat `toolMode` = `edits`, any other tool (policy `ask` without workspace `write`, policy `always`) | `user-approval` |
| 8 | chat `toolMode` = `auto`, policy `always` | `user-approval` |
| 9 | chat `toolMode` = `auto`, policy `safe` or `ask` | `not-applicable` |

- `toolMode = off`: no tools are sent to the model. Tools disabled in prefs (`enabled = false`) or with override
  `deny` are not sent either; step 1 only catches calls to them that still arrive.
- `approved` / `denied` are recorded as automatic decisions (no card; denials render as `output-denied`);
  `user-approval` shows the approval card ("Allow **tool**?" with Deny / Allow and an "Always allow **tool**"
  checkbox). Allow with the checkbox checked also writes override `allow` (`PATCH /api/tools/:name`).
- Policy defaults to `ask`. A policy **function** is guarded (3 s); a throw or timeout is treated as `always`. It
  receives the call context, so a workspace tool can decide by path (the builtin `write_file` returns `always` for
  hidden and secret-looking paths, so they ask even in Accept edits).
- `edits` is meant for project chats: a `write` tool with policy `ask` runs there without a card, while `execute` tools
  (the shell) and every non-workspace tool that would ask in `ask` mode still ask. The `tool.approve` hook and user
  overrides keep their precedence (steps 1 and 2); hooks see `toolMode: 'edits'` in `chat.params`.
- MCP tool policy: `readOnlyHint: true` -> `safe`; else `destructiveHint: true` -> `always`; else the server's
  `policy` (default `ask`). Annotations come from the MCP server and are advisory: if you do not fully trust a
  server, set an override (`ask`) on its tools.

## 11. Lifecycle

### Load order

1. Builtins (static imports, trusted): `core-providers`, `core-tools`, `core-commands`, `core-mcp`, `core-workspace`
   (Phase 7), then `mock` when `HF_MOCK_PROVIDER=1`.
2. Unless `HF_SAFE_MODE=1`: every directory in `data/plugins/*` (not starting with `.`) plus linked folders, sorted
   by id (ASCII), each loaded independently and guarded.

Models registered for a provider that is not registered yet are held and attached when it appears.

### Validation steps (state `loading`)

| # | Check | On failure |
|---|---|---|
| 1 | `plugin.json` exists, <= 256 KB, valid JSON | `error` |
| 2 | lenient pre-parse: `engines.harness` satisfied by `PLUGIN_API_VERSION` | `incompatible` |
| 3 | strict manifest schema (zod) | `error` |
| 4 | directory name equals `id`; `id` not reserved | `error` |
| 5 | realpath of `main` (and of a file `icon`) inside the plugin directory; allowed extension | `error` |
| 6 | code plugins and plugins with a stdio MCP server: trust pin matches ([section 13](#13-trust-and-security)) | `untrusted` |
| 7 | declarative: build `ProviderDefinition`s and register contributions; code: build (`.ts`) / import scan, `import(<file URL>?v=<sha256>)`, guarded `setup(ctx)` (10 s) | `error` |
| 8 | success | `active` |

### States (`PluginState`)

| State | Meaning | Leaves by |
|---|---|---|
| `disabled` | the user disabled it (or safe mode skips it); not loaded | enable -> `loading` |
| `untrusted` | code / stdio plugin whose pin does not match | trust (fresh auth) -> `loading`; disable |
| `incompatible` | `engines.harness` excludes the running API | update the plugin -> `loading`; disable |
| `loading` | validating, importing, running `setup` | `active`, `error`, `untrusted`, `incompatible` |
| `active` | contributions registered | disable, reload, uninstall |
| `error` | invalid manifest, `setup` threw or timed out, build failed, or skipped by the boot sentinel; `last_error` holds the `HarnessError` | reload / enable -> `loading`; disable |

Runtime failures of an `active` plugin (a tool throws, a hook times out) do not change its state.

### Guards

Every call into plugin code runs through `guard(pluginId, fn, timeoutMs)`:

| Call | Timeout |
|---|---|
| module evaluation + `setup` | 10 s |
| `dispose` | 5 s |
| each hook handler, policy function, `toModelOutput`, `settings.onChange` callback | 3 s |
| tool `execute` | `timeoutMs` (default 60 s, max 600 s) |
| command `run` | 30 s |
| `createLanguageModel` | 5 s |
| `createImageModel`, `createTranscriptionModel`, `createSpeechModel` (1.1) | 5 s |
| `listModels`, `validate` | 15 s |
| MCP connect | 20 s |

A throw or timeout becomes a `plugin_error` (with the plugin id) plus a plugin log entry. In-process code cannot be
killed: on timeout the host stops waiting, aborts the related `AbortSignal` and continues; a plugin stuck in a
synchronous loop blocks the whole server (recover with safe mode). `unhandledRejection` events are logged (attributed
to a plugin when possible) and never crash the process.

The synchronous provider members `reasoning`, `imageParams` and `transcriptionOptions` (1.1) have no timeout: a throw
or an invalid result is logged and ignored (the request goes out without those additions).

### Boot sentinel and safe mode

- Before loading a user plugin the host writes `plugins.loading_since = now` and clears it when the load finishes.
  A plugin that still has `loading_since` at the next boot (the process died while loading it) is skipped and set to
  `error` ("crashed during load") until the user enables or reloads it.
- `HF_SAFE_MODE=1` loads builtins only; user plugins are listed but not loaded and the Plugins tab shows a safe-mode
  banner.

### Disable, reload, uninstall

Disable: guarded `dispose()` (5 s) -> the plugin's `DisposableStore` unregisters every contribution (providers,
models, tools, MCP servers, commands, hooks) -> its MCP clients close (stdio children terminate) -> `ctx.signal`
aborts -> `plugin.changed` and `catalog.changed` events. In-flight tool calls of the plugin get "tool unavailable";
chats whose model belongs to a removed provider fail with `provider_not_configured` until it returns.

Reload = disable + load (state `loading`), keeping settings, storage and secrets.

### Hot reload

| Plugin | Trigger |
|---|---|
| declarative | saving the manifest reloads it: the wizard (`PUT /api/plugins/:id/manifest`) or `plugin.json` in the Source tab of an editable plugin (`PUT /api/plugins/:id/files/plugin.json`) |
| code, linked folder (`source = link`) | always watched: `fs.watch` on the folder, 300 ms debounce |
| code in `data/plugins/*` | watched only with `HF_PLUGIN_WATCH=1`; otherwise "Build & reload" / "Reload" |

A code reload runs: disable -> build (`.ts`) -> `import(<file URL>?v=<sha256 of the entry>)` -> `setup`. Node never
unloads ES modules, so each reload keeps the previous module in memory; restart the server after long editing
sessions. A reload of a hash-pinned plugin whose files changed ends in `untrusted` ([section 13](#13-trust-and-security)).

## 12. Installing plugins

### Sources (`PluginSource`)

| Source | Input | Notes |
|---|---|---|
| `created` | Plugins -> New plugin: provider wizard (declarative, `POST /api/plugins`) or code template (`POST /api/plugins/scaffold`, fresh auth) | code plugins are trusted (pinned) at creation |
| `zip` | `.zip` upload (multipart) | guards below |
| `npm` | package spec `name`, `@scope/name`, `name@version` or `name@range` from `https://registry.npmjs.org` | `plugin.json` must be at the package root; the tarball `dist.integrity` (sha512) is verified; `dependencies` are ignored; lifecycle scripts never run |
| `url` | `https:` URL of a `.zip` or `.tgz` plus a required `integrity` (SRI `sha256-` or `sha512-`, API.md) | SSRF guard applies (no loopback / private hosts: use a folder install for local files); <= 20 MB download |
| `link` | absolute path of a local folder outside the data directory | used in place; always watched; trust pinned to the folder realpath; uninstall never deletes the folder |
| `copy` | absolute path of a local folder | copied into staging, then treated like a zip |
| `builtin` | shipped with the server | cannot be installed, exported or uninstalled |

### Flow

1. **Inspect** (`POST /api/plugins/inspect`): the host fetches / extracts into `data/plugins/.staging/<uuid>`,
   validates, and returns a preview: manifest, kind, contributions (providers with base URLs, models, MCP servers
   with URLs / commands, commands, settings), requested secrets, permissions, the sha256 pin, warnings (plain HTTP
   host, downgrade, replaces an installed version), and whether trust is required. The staging copy is removed.
2. **Review**: the Install dialog shows the preview; code plugins and stdio MCP plugins show the trust warning
   ([section 13](#13-trust-and-security)) and the "I trust <source>" checkbox. Installing without trust is allowed:
   the plugin is installed `untrusted` (inert) until it is trusted.
3. **Install** (`POST /api/plugins/install`; fresh auth for every plugin that requires trust, ADR-017): the source
   is fetched and validated again, then committed with an atomic swap:
   - an installed version is renamed to `data/plugins/.staging/<id>.prev-<uuid>` and disabled;
   - `data/plugins/.staging/<uuid>` is renamed to `data/plugins/<id>` (same filesystem);
   - the `plugins` row is upserted (source, `source_ref`, version, `enabled`, `trusted_hash` when trusted);
   - the plugin loads; if it reaches a non-error state the `.prev` copy is deleted, otherwise the `.prev` copy is
     restored and reloaded.

Request and response shapes: [API.md](./API.md). Installing an id that already exists from the **same source** is
an update: settings, storage, secrets and `dataDir` are kept; a code or stdio plugin must be trusted again whenever
its pin changes. The same id from a different source is rejected with `409 conflict` (uninstall first).

### Archive rules

- `plugin.json` must be at the archive root, or inside exactly one top-level directory (a zipped folder); npm
  tarballs use their `package/` directory.
- Limits: <= 20 MB compressed, <= 100 MB expanded (enforced while extracting), <= 2000 entries.
- Rejected entries: absolute paths, `..` segments, drive letters (`C:`), backslashes, NUL or control characters,
  symlinks and hard links, device / FIFO entries, duplicate paths. After extraction the realpath of every file must be
  inside the staging directory.
- Extracted files get mode 0644 and directories 0755; archive permissions are ignored.

### Uninstall and export

- `DELETE /api/plugins/:id?keepData=<bool>`: dispose -> remove `data/plugins/<id>` (for `link`: only forget the
  link) -> unless `keepData=true`, purge `plugin_settings`, `plugin_kv`, secrets of scope `plugin:<id>`,
  `data/plugins/.data/<id>/` and the credentials/configs of the plugin's providers. Tool preferences
  (`tool_prefs`) are user data and are kept.
- `GET /api/plugins/:id/export` returns a zip of the plugin directory without `node_modules`, `.git` and build
  output (no settings, storage or secrets), installable with `POST /api/plugins/install`.

## 13. Trust and security

### What a code plugin can do

A code plugin (and a stdio MCP server) runs with the server's operating-system user and full process access: it can
read every stored API key and conversation, the data directory and `process.env`, make any network request, and
start processes. Guards limit accidents, not attacks. Isolation in a child process is on the backlog.

### Trust warning (exact UI text)

Shown in red in the install dialog and next to the Trust button for every code plugin and every plugin that declares
a stdio MCP server:

> Runs code on your server with harness-forge's permissions. It can read API keys and conversations and make network requests. Only install plugins from sources you trust.

The dialog also shows the source (`npm name@version`, URL, file name or folder path), the sha256 pin, the declared
permissions, and the contributions (hosts, stdio commands). The user must check **"I trust <source>"**. When a
password is set, installing or trusting such a plugin requires a login within the last 10 minutes (fresh auth,
ADR-017): the install and trust dialogs ask for the password first.

### Pinning

| Plugin | Pin (`plugins.trusted_hash`) |
|---|---|
| code plugin | lowercase hex SHA-256 of the raw bytes of `plugin.json`, one `0x00` byte, and the raw bytes of the entry file named by `main` (the `.ts` source, not the build output) |
| declarative plugin with a stdio MCP server | SHA-256 of the raw bytes of `plugin.json` |
| `link` source | `path:` + SHA-256 of the folder realpath: content edits hot-reload without re-trust; moving the folder requires re-trust |
| declarative plugin without stdio | no pin needed |

The pin is re-checked on every load. Any change of the hashed bytes makes the plugin `untrusted` until it is pinned
again by:

- the Trust action (`POST /api/plugins/:id/trust`) or trusting in the install dialog (installs and updates);
- for plugins with source `created`: saving or deleting a file in the in-browser editor (`PUT` / `DELETE
  /api/plugins/:id/files/*`) re-pins automatically (ADR-017) when the plugin was trusted before the edit (a plugin
  whose files had changed outside the editor stays `untrusted` and logs a warning), and a successful "Build & reload"
  (`POST /api/plugins/:id/build`) re-pins it; for code plugins these writes require fresh auth when a password is
  set. Editor saves of `copy` plugins never re-pin (use Trust); `link` plugins are pinned to their path;
- creating a declarative plugin with a stdio MCP server in the UI (`POST /api/plugins`) pins it at creation.

Files changed on disk outside the editor require re-trust, except in linked folders (pinned to the path). Which
routes require fresh auth is defined in [API.md](./API.md) (routes marked **fresh**: trusting, installing a plugin
that requires trust, scaffolding and building code plugins, creating or changing stdio MCP servers, changing the
password).

### Declarative plugin safety

Declarative plugins without stdio servers run no code and need no trust:

- a provider sends credentials only to its own `baseURL` (and same-origin listing URLs); declarative manifests cannot
  read environment variables (`envVar` is rejected) and cannot reference other providers' credentials;
- HTTP MCP servers receive only what the model sends to their tools;
- the install preview lists every host a declarative plugin talks to. A base URL may point at a loopback or LAN
  address (local model servers are legitimate); it is set by whoever writes the manifest, so review it.

### Other protections

- Plugin-provided strings (names, descriptions, tool output, logs) are rendered as text or through the escaping
  markdown renderer; icons only via `<img>` or CSS mask from server URLs; never `v-html`.
- Logs pass through the secret redactor; the API never exposes one plugin's `ctx.secrets` or `ctx.storage` to another
  (in-process code can still reach anything, hence trust).

## 14. Naming rules

| Name | Rule | Uniqueness |
|---|---|---|
| Plugin id | `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`; equals the directory name; reserved: `core-*`, `mock`, builtin provider ids | unique (installing an existing id updates it) |
| Provider id | builtins: models.dev keys; plugins: `<pluginId>` or `<pluginId>-<suffix>` with `<suffix>` matching `[a-z0-9-]+`, total <= 64 characters | first registration wins, later ones throw `conflict` |
| Model ref | `providerId:modelId`, split on the **first** `:` (`ollama:llama3:8b`); never in URL paths | |
| Tool name | `^[a-zA-Z0-9_-]{1,64}$`; the prefix `mcp__` is reserved for MCP tools; prefer a plugin-specific prefix (`dice_roll`) | global; duplicates throw `conflict` |
| MCP tool name | `mcp__<serverId>__<tool>`; characters of `<tool>` outside `[a-zA-Z0-9_-]` become `_`; longer than 64 characters -> the first 55 characters + `_` + 8 hex characters of the FNV-1a hash of the full name (`mcpToolName()` in `@harness-forge/shared`, synchronous and browser-safe) | global |
| MCP server id | `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`; plugin servers: `<pluginId>` or `<pluginId>-<suffix>` (so plugins with ids longer than 32 characters cannot declare MCP servers) | across plugins and the MCP panel |
| Command name | `^[a-z][a-z0-9-]{0,31}$`; reserved client-only: `new`, `model`, `effort`, `mode`, `help` | first wins |
| Credential key, setting key | `^[a-zA-Z][a-zA-Z0-9_]{0,63}$` | within the provider / schema |
| Secret scopes | `provider:<id>`, `plugin:<id>`, `mcp:<id>`, `auth` | |

## 15. Authoring guide

Workflow: create the plugin folder, install it with **Install… -> Local folder -> Link** (hot reload on save), watch
the Logs tab, then publish it as a zip, an npm package (with `plugin.json` at the package root) or a URL with an
integrity hash. The in-browser alternative is Plugins -> New plugin -> Code plugin (templates: tool, provider, MCP
bridge, command pack). Step-by-step guides: [declarative provider](./guides/writing-a-declarative-provider.md),
[code plugin](./guides/writing-a-code-plugin.md), [MCP server](./guides/adding-an-mcp-server.md).

The examples below are copies of runnable plugins in [`examples/plugins/`](../examples/plugins/) (`together-ai`,
`dice-roller`, `mcp-everything`, plus `lmstudio` and the TypeScript provider `echo-provider`); `examples.test.ts`
loads each of them into the plugin host. Examples (c) and (e) are patterns without a folder (they need a real gateway
or a local Whisper server).

### (a) Declarative OpenAI-compatible provider: Together AI

`together-ai/plugin.json`:

```json
{
  "manifestVersion": 1,
  "id": "together-ai",
  "name": "Together AI",
  "version": "1.0.0",
  "description": "Together AI models through the OpenAI-compatible API.",
  "author": "harness-forge examples",
  "homepage": "https://www.together.ai",
  "icon": "lobe:together",
  "engines": { "harness": "^1.0.0" },
  "contributes": {
    "providers": [
      {
        "id": "together-ai",
        "name": "Together AI",
        "baseURL": "https://api.together.xyz/v1",
        "apiFormat": "openai-chat",
        "auth": { "type": "bearer" },
        "credentials": [
          {
            "key": "apiKey",
            "label": "API key",
            "type": "secret",
            "required": true,
            "helpUrl": "https://api.together.ai/settings/api-keys"
          }
        ],
        "listModels": { "exclude": "embed|rerank|whisper|flux|stable-diffusion|tts|guard" },
        "reasoningStyle": "openai-effort",
        "modelsDevId": "togetherai",
        "smallModelId": "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        "models": [
          {
            "id": "openai/gpt-oss-120b",
            "name": "gpt-oss 120B",
            "contextWindow": 131072,
            "capabilities": { "tools": true, "reasoning": true },
            "reasoningEfforts": ["low", "medium", "high"]
          }
        ]
      }
    ]
  }
}
```

After install: Settings -> Providers -> Together AI -> paste the key -> Test -> Save. Models appear as
`together-ai:<model id>` (for example `together-ai:openai/gpt-oss-120b`).

### (b) Code tool plugin: dice roller (`index.mjs`, policy `safe`)

`dice-roller/plugin.json`:

```json
{
  "manifestVersion": 1,
  "id": "dice-roller",
  "name": "Dice roller",
  "version": "1.0.0",
  "description": "Adds a roll_dice tool that rolls dice in standard notation (2d6+3).",
  "author": "harness-forge examples",
  "icon": "icon.svg",
  "engines": { "harness": "^1.0.0" },
  "main": "index.mjs",
  "permissions": []
}
```

`dice-roller/index.mjs` (the folder also holds `icon.svg` and the editor types `harness-forge.d.ts`):

```js
// @ts-check
/// <reference path="./harness-forge.d.ts" />
import { randomInt } from 'node:crypto'

const NOTATION = /^(\d{1,3})d(\d{1,4})([+-]\d{1,5})?$/

/** @type {import('@harness-forge/plugin-sdk').PluginModule} */
export default {
  setup(ctx) {
    const { z } = ctx.ai

    ctx.tools.register({
      name: 'roll_dice',
      description: 'Roll dice in standard notation, for example "1d20" or "2d6+3". Returns every roll and the total.',
      inputSchema: z.object({
        notation: z.string().regex(NOTATION).describe('Dice notation: <count>d<sides>[+|-<modifier>], count <= 100'),
      }),
      policy: 'safe', // read-only and harmless: runs without an approval card in "ask" mode
      async execute({ notation }) {
        const parts = notation.match(NOTATION)
        if (!parts)
          throw new Error(`Invalid notation: ${notation}`)
        const count = Number(parts[1])
        const sides = Number(parts[2])
        const modifier = Number(parts[3] ?? 0)
        if (count < 1 || count > 100 || sides < 2)
          throw new Error('Use 1-100 dice with at least 2 sides.')
        const rolls = Array.from({ length: count }, () => randomInt(1, sides + 1))
        const total = rolls.reduce((sum, roll) => sum + roll, 0) + modifier
        ctx.logger.debug('rolled', { notation, total })
        return { notation, rolls, modifier, total }
      },
    })
  },
}
```

Install (link the folder), enable, trust it (it is a code plugin), then ask "Roll 2d6+3" in a chat with a
tool-capable model.

### (c) Code provider plugin: OpenAI-compatible gateway with a custom header and `listModels`

A gateway that needs a team header on every request and returns capability flags in its model listing (something a
declarative provider cannot express). `acme-gateway/plugin.json`:

```json
{
  "manifestVersion": 1,
  "id": "acme-gateway",
  "name": "Acme gateway",
  "version": "1.0.0",
  "description": "Models of the Acme LLM gateway.",
  "icon": "icon.svg",
  "engines": { "harness": "^1.0.0" },
  "main": "index.mjs",
  "permissions": ["network"]
}
```

`acme-gateway/index.mjs`:

```js
// @ts-check
const DEFAULT_BASE_URL = 'https://llm.example.com/v1'
const EFFORT = /** @type {const} */ ({ off: 'none', low: 'low', medium: 'medium', high: 'high', max: 'xhigh' })

/** @param {Record<string, string>} credentials */
function baseURL(credentials) {
  return (credentials.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

/** @param {Record<string, string>} credentials */
function extraHeaders(credentials) {
  return { 'X-Acme-Team': credentials.team, 'X-Acme-Client': 'harness-forge' }
}

/** @type {import('@harness-forge/plugin-sdk').PluginModule} */
export default {
  setup(ctx) {
    ctx.providers.register({
      id: 'acme-gateway',
      name: 'Acme gateway',
      keyUrl: 'https://llm.example.com/keys',
      smallModelId: 'acme-small',
      credentials: [
        { key: 'apiKey', label: 'API key', type: 'secret', required: true, envVar: 'ACME_API_KEY' },
        { key: 'team', label: 'Team', type: 'text', required: true },
        { key: 'baseURL', label: 'Base URL', type: 'url', default: DEFAULT_BASE_URL, advanced: true },
      ],
      seedModels: [
        { id: 'acme-large', name: 'Acme Large', capabilities: { tools: true, reasoning: true } },
        { id: 'acme-small', name: 'Acme Small', capabilities: { tools: true } },
      ],

      createLanguageModel(modelId, rt) {
        const provider = ctx.ai.createOpenAICompatible({
          name: 'acme-gateway',
          baseURL: baseURL(rt.credentials),
          apiKey: rt.credentials.apiKey,
          headers: extraHeaders(rt.credentials),
          fetch: rt.fetch,
          includeUsage: true,
        })
        return provider.chatModel(modelId)
      },

      async listModels(rt) {
        const res = await rt.fetch(`${baseURL(rt.credentials)}/models`, {
          headers: { Authorization: `Bearer ${rt.credentials.apiKey}`, ...extraHeaders(rt.credentials) },
          signal: rt.signal,
        })
        if (!res.ok)
          throw new Error(`Model listing failed with HTTP ${res.status}`)
        /** @type {{ data: { id: string, context_window?: number, capabilities?: string[] }[] }} */
        const body = await res.json()
        return body.data
          .filter(model => model.capabilities?.includes('chat'))
          .map(model => ({
            id: model.id,
            contextWindow: model.context_window,
            capabilities: {
              tools: model.capabilities?.includes('tools') ?? false,
              vision: model.capabilities?.includes('vision') ?? false,
              reasoning: model.capabilities?.includes('reasoning') ?? false,
            },
          }))
      },

      reasoning(effort) {
        // Portable AI SDK v7 `reasoning` option -> `reasoning_effort` on the wire.
        return effort === 'auto' ? undefined : { reasoning: EFFORT[effort] }
      },

      mapError(err) {
        if (err && typeof err === 'object' && 'statusCode' in err && err.statusCode === 402)
          return { code: 'rate_limited', message: 'The Acme team quota is exhausted.', action: 'retry' }
        return undefined // default mapping
      },
    })
  },
}
```

### (d) Declarative MCP server: `server-everything` over stdio

`mcp-everything/plugin.json`:

```json
{
  "manifestVersion": 1,
  "id": "mcp-everything",
  "name": "MCP Everything (demo)",
  "version": "1.0.0",
  "description": "The MCP reference test server, started with npx over stdio.",
  "author": "harness-forge examples",
  "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/everything",
  "icon": "lobe:mcp",
  "engines": { "harness": "^1.0.0" },
  "permissions": ["process", "network"],
  "contributes": {
    "mcpServers": [
      {
        "id": "mcp-everything",
        "name": "Everything",
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-everything"]
        }
      }
    ]
  }
}
```

Because it declares a stdio server, the plugin needs trust. Its tools appear as `mcp__mcp-everything__<tool>`
(for example `mcp__mcp-everything__echo`) with the policy from their annotations, else `ask`. `npx` must be on the
server's `PATH`; the first start downloads the package.

### (e) Code provider plugin: dictation through a local Whisper server (plugin API 1.1.0)

A speech-to-text provider for a Whisper server on your own machine that offers the OpenAI-compatible
`POST /v1/audio/transcriptions` endpoint (several local Whisper servers do). Audio then never leaves the machine. Like
(c), this is a pattern without a folder (it needs a running server). `local-whisper/plugin.json`:

```json
{
  "manifestVersion": 1,
  "id": "local-whisper",
  "name": "Local Whisper",
  "version": "1.0.0",
  "description": "Dictation through a Whisper server on this machine (OpenAI-compatible transcription API).",
  "engines": { "harness": "^1.1.0" },
  "main": "index.mjs",
  "permissions": []
}
```

`engines.harness` is `^1.1.0` because the plugin uses `createTranscriptionModel`. `local-whisper/index.mjs`:

```js
// @ts-check
const DEFAULT_BASE_URL = 'http://localhost:8000/v1'

/** @param {Record<string, string>} credentials */
function baseURL(credentials) {
  return (credentials.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

/** @type {import('@harness-forge/plugin-sdk').PluginModule} */
export default {
  setup(ctx) {
    ctx.providers.register({
      id: 'local-whisper',
      name: 'Local Whisper',
      credentials: [
        { key: 'baseURL', label: 'Base URL', type: 'url', required: true, default: DEFAULT_BASE_URL },
        { key: 'apiKey', label: 'API key', type: 'secret', advanced: true },
      ],
      // An explicit kind: listed for Settings -> Media -> Speech to text, never in the chat picker.
      seedModels: [{ id: 'whisper-large-v3-turbo', name: 'Whisper large v3 turbo (local)', kind: 'transcription' }],

      // Required by the API; this provider has no chat model, so nothing calls it.
      createLanguageModel(modelId) {
        throw new Error(`${modelId} is a speech-to-text model.`)
      },

      // Plugin API 1.1.0: the model behind dictation. Pass the key explicitly (a placeholder when the local server
      // needs none), so the SDK never falls back to OPENAI_API_KEY from the server environment.
      createTranscriptionModel(modelId, rt) {
        return ctx.ai.createOpenAI({
          name: 'local-whisper',
          baseURL: baseURL(rt.credentials),
          apiKey: rt.credentials.apiKey || 'local',
          fetch: rt.fetch,
        }).transcription(modelId)
      },

      // Settings -> Media -> Language: an ISO 639 code, or nothing for "Detect automatically".
      transcriptionOptions({ language }) {
        return language ? { openai: { language } } : undefined
      },

      // The Test button: the default ping needs a chat model, so check the server instead.
      async validate(rt) {
        const res = await rt.fetch(`${baseURL(rt.credentials)}/models`, { signal: rt.signal })
        if (!res.ok)
          throw new Error(`The Whisper server answered HTTP ${res.status}`)
      },
    })
  },
}
```

After install and trust: Settings → Providers → Local Whisper → Test; then Settings → Media → Speech to text → "Whisper
large v3 turbo (local)", and dictate with the microphone button (Alt+V). A text-to-speech provider looks the same with
`createSpeechModel(modelId, rt)` (for example `ctx.ai.createOpenAI({ … }).speech(modelId)`), seeds with
`kind: 'speech'` and a `voices` list. An image provider adds `createImageModel` (`.image(modelId)` of a compatible
factory), seeds with `kind: 'image'` and an `imageParams` that maps the aspect ratio to what the API accepts.

### TypeScript entry

Set `"main": "index.ts"`. The host compiles it with esbuild on load and on "Build & reload"; `definePlugin` is
aliased to the host shim, so it is the only value import allowed from the SDK (besides `PLUGIN_API_VERSION`):

```ts
import type { ToolDefinition } from '@harness-forge/plugin-sdk'
import { definePlugin } from '@harness-forge/plugin-sdk'

export default definePlugin({
  setup(ctx) {
    const { z } = ctx.ai
    const wordCount: ToolDefinition<{ text: string }, { words: number }> = {
      name: 'word_count',
      description: 'Count the words in a text.',
      inputSchema: z.object({ text: z.string().max(100_000) }),
      policy: 'safe',
      async execute({ text }) {
        const trimmed = text.trim()
        return { words: trimmed ? trimmed.split(/\s+/).length : 0 }
      },
    }
    ctx.tools.register(wordCount)
  },
})
```

esbuild does not type-check: run `tsc --noEmit` in your own checkout if you want type errors. A syntax error is
shown in the Source tab and the plugin stays in its previous state (or `error` on first load).

## 16. FAQ

**Can I use npm packages in a code plugin?** No. A code plugin is a single file without dependencies. Use `ctx.ai`
for zod and the AI SDK, Node built-ins for the rest, and inline small helpers.

**Why can't I `import { z } from 'zod'`?** There is no `node_modules` next to your plugin, and one shared copy keeps
schemas and model instances compatible with the host. Use `ctx.ai.z`.

**Where do I keep an API key my tool needs?** Declare a setting with `"format": "secret"` (the user enters it in the
Configuration tab; read it with `ctx.settings.get()`). Use `ctx.secrets` for tokens the plugin manages itself.

**My plugin became `untrusted` after I edited it.** Its files changed on disk, so its pin no longer matches. Edit
`created` plugins in the in-browser editor (saves re-pin automatically), use the Trust action, or develop from a
linked folder (pinned to the path).

**My plugin is `incompatible`.** `engines.harness` does not include `PLUGIN_API_VERSION` (`1.2.0`). Use `"^1.0.0"`
(or `"^1.1.0"` when the plugin uses a 1.1 member such as `createTranscriptionModel` or `ctx.images`, `"^1.2.0"` for a
1.2 member such as `ToolDefinition.workspace`).

**How do I write a tool that works on the chat's project folder?** Set `workspace: 'read'` (or `'write'`) and use
`c.workspace.root` (plugin API 1.2.0, `"^1.2.0"`); the tool is offered only in project chats. Resolve paths yourself
and stay inside `root`; a `write` tool with policy `ask` runs without a card in Accept edits. Example in
[the code plugin guide](./guides/writing-a-code-plugin.md#workspace-aware-tools-plugin-api-120).

**Can my plugin rely on file ids surviving the storage cleanup?** Yes, when the ids are in `ctx.storage` or a plugin
setting: the cleanup scans both (and every chat, share and setting) and removes only files older than 24 hours that
nothing references.

**How do I generate an image from a plugin?** `const { images } = await ctx.images.generate({ prompt, chatId })` uses
the image model the user chose in Settings → Media (or pass `modelRef`) and returns stored files (`images[0].url` is
`/api/files/<fileId>`). A tool that returns such references can say so in `toModelOutput`; only the builtin
`generate_image` tool gets its images appended to the chat automatically. Pass the tool's `c.signal` as `signal` so a
Stop aborts the generation; the errors are listed under `images.generate` in [section 9](#plugincontext) (without an
image model in Settings → Media the call fails with "Choose an image model in Settings → Media.").

**How do I add a speech-to-text or text-to-speech provider?** Give your `ProviderDefinition` a
`createTranscriptionModel` or `createSpeechModel` (plus `transcriptionOptions` for languages and `voices` on speech
models) and declare the models with `kind: 'transcription'` / `'speech'`; example (e) in section 15.

**The server hangs or crashes at start after installing a plugin.** Start with `HF_SAFE_MODE=1` and disable or
uninstall it. A plugin that crashed the process while loading is skipped automatically at the next start (boot
sentinel).

**How do I add a model to a builtin provider?** `contributes.models: [{ "providerId": "openrouter", "models": [...] }]`
or `ctx.models.register('openrouter', [...])`. Users can also add custom model ids in Settings -> Models.

**Can a plugin replace a builtin provider?** No. Builtin provider ids are reserved and plugin provider ids are
namespaced by the plugin id. Register your own provider instead.

**How do I call a model from plugin code?** `const model = await ctx.models.resolve('anthropic:claude-haiku-4-5')`,
then `await ctx.ai.generateText({ model, prompt })`. Calls are billed to the user's key; say so in your description.

**How do I require approval only for some inputs?** Use a policy function:
`policy: input => input.path.startsWith('/tmp/') ? 'safe' : 'always'`.

**Do declarative plugins need trust?** Only when they declare a stdio MCP server.

**What happens to a running tool call when my plugin is disabled?** `c.signal` aborts and the model receives "tool
unavailable".

**Can hooks see the system prompt and every message?** Yes (`chat.params`, `chat.messages`: every message of the
path being answered), which is why `hooks` is a permission shown in the trust dialog.

**Is my plugin part of a Settings → Data backup?** No. A backup (ADR-024) holds chats, their attachments and, when
chosen, the public app settings; plugins, plugin settings and storage, secrets, MCP servers, projects and model or tool
preferences stay out, and "Delete all data" leaves them alone too. A master-key rotation re-encrypts `ctx.secrets`
values in place; nothing changes for the plugin. To move everything, copy the whole data directory
(`HF_DATA_DIR`, including `secret.key`, or keep the same `HF_MASTER_KEY`) while the server is stopped.

**How do I debug?** `ctx.logger` entries appear in the plugin's Logs tab and in the server log; link the folder for
hot reload; set `HF_PLUGIN_WATCH=1` to hot-reload code plugins installed in `data/plugins/`.

## Hardening notes (Phase 4)

- **Export exclusions:** `GET /api/plugins/:id/export` never includes `.env*`, `.npmrc`, build output, `node_modules`
  or `.git`.
- **Linked folders:** a folder linked with `mode: 'link'` is refused when it (or a parent folder) is writable by other
  users, because another account could replace trusted code.
- **Reviewed hash:** the install request may carry the `sha256` shown in the inspect preview; a different staged hash
  fails with `409 conflict` (`reason: 'stale'`) and the dialog re-inspects.
- **MCP manager:** follows the `core-mcp` plugin through `PluginHost.onStateChange` (disabling `core-mcp` closes the
  user-managed servers).
