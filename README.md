# harness-forge

harness-forge is a self-hosted, bring-your-own-key (BYOK) AI chat and agent harness. It runs as one Node process
with a web UI. Connect your own API keys for Claude, ChatGPT, Gemini, Grok, DeepSeek, Kimi, Qwen, GLM and more, or
point it at a local Ollama. Then chat, watch the models reason, and let them call tools. By default, every tool call
waits for your approval. A **Plugins** tab adds LLM providers, models, tools, MCP servers and slash commands, either
from a JSON manifest or from code you edit in the browser. The interface is a simplified take on the Claude Code
desktop app, and it starts in dark mode.

> **Status:** Phase 4 (hardening and release). Progress lives in [`docs/ROADMAP.md`](docs/ROADMAP.md).

![Chat with a code block, a reasoning row and a tool approval card (dark theme)](docs/assets/screenshots/chat-dark.png)

| Plugins | Provider wizard |
|---|---|
| ![The Plugins tab with the builtin plugins and a declarative provider](docs/assets/screenshots/plugins-dark.png) | ![The provider wizard, API step, with the LM Studio template](docs/assets/screenshots/provider-wizard-dark.png) |
| **Settings -> Providers** | **Light theme** |
| ![Settings, providers with brand icons and status](docs/assets/screenshots/settings-dark.png) | ![The chat in the light theme](docs/assets/screenshots/chat-light.png) |

## Features

- **Chat**:
  - Streaming markdown with highlighted code, "Thinking" rows for reasoning, and collapsible tool-call rows.
  - Inline approval cards for tool calls, file attachments, and edit, regenerate, copy and stop.
  - Automatic chat titles, per-message token usage and cost, and a context-usage ring.
- **Composer**:
  - A model picker with provider icons and capability badges.
  - A reasoning-effort menu (Auto, Off, Low, Medium, High, Max) and a permission mode (Ask, Auto, Off) for tools.
  - Slash commands: `/explain`, `/review`, `/fix`, `/translate`, `/proofread` and more, plus commands from plugins.
- **Sidebar and navigation**: a Chat | Plugins switch, chats grouped by date with live status dots (running, needs
  approval, unread), a Mod+K command palette, keyboard shortcuts, and a Light / Dark / System theme toggle.
- **Providers and models**:
  - 13 builtin BYOK providers. Keys are encrypted at rest, shown only as masked hints, and can fall back to
    environment variables.
  - Live model lists enriched with [models.dev](https://models.dev) metadata (limits, capabilities, prices).
  - Favorites, hidden models and custom model ids.
- **Plugins**:
  - Declarative provider plugins, built with a five-step wizard or written as `plugin.json`.
  - Code plugins (tools, providers, commands, hooks, MCP servers) from templates, edited and rebuilt in the browser.
  - Install from a zip, npm, a URL with an integrity hash, or a local folder, with an explicit trust step for code.
- **Tools and MCP**: MCP servers over stdio, Streamable HTTP and SSE. The builtin tools are `current_time` and
  `web_fetch` (SSRF-guarded). Every tool has an approval policy and a per-tool override.
- **Self-hosting**: SQLite storage, one port, an optional password, a loopback-only bind unless you secure it, and a
  Docker image with a `/data` volume.

## Supported providers

| Provider | Id | Key environment variable | Notes |
|---|---|---|---|
| Anthropic (Claude) | `anthropic` | `ANTHROPIC_API_KEY` | |
| OpenAI (ChatGPT) | `openai` | `OPENAI_API_KEY` | Responses API |
| Google (Gemini) | `google` | `GOOGLE_GENERATIVE_AI_API_KEY` (`GEMINI_API_KEY`, `GOOGLE_API_KEY`) | |
| xAI (Grok) | `xai` | `XAI_API_KEY` | |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | |
| Moonshot AI (Kimi) | `moonshotai` | `MOONSHOT_API_KEY` | |
| Alibaba (Qwen) | `alibaba` | `ALIBABA_API_KEY` (`DASHSCOPE_API_KEY`) | international endpoint by default |
| Z.ai (GLM) | `zai` | `ZAI_API_KEY` (`ZHIPU_API_KEY`) | Coding Plan keys need the Coding Plan base URL |
| MiniMax | `minimax` | `MINIMAX_API_KEY` | Anthropic-compatible endpoint |
| Mistral | `mistral` | `MISTRAL_API_KEY` | |
| Groq | `groq` | `GROQ_API_KEY` | |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | hundreds of models behind one key, with provider-reported cost |
| Ollama (local) | `ollama` | none | base URL `http://localhost:11434/v1`, remote hosts allowed |

Any OpenAI-, Anthropic- or Gemini-compatible endpoint (LM Studio, vLLM, llama.cpp, LiteLLM, Together, Fireworks, …)
can be added as a declarative provider plugin, without code. Model references have the form `providerId:modelId`, for
example `anthropic:claude-sonnet-5` or `ollama:llama3:8b`. Base URLs, reasoning mappings, seed models and icons are in
[`docs/PROVIDERS.md`](docs/PROVIDERS.md).

## Quick start

### Development

Requirements: **Node >= 22.12** and **pnpm 11**.

```sh
pnpm install
pnpm dev            # server on :8787 (tsx watch) + web on :3000 (nuxt dev, proxies /api)
```

Open http://localhost:3000. Go to **Settings** -> **Providers**, add a key, press **Test**, then start a chat.
`HF_MOCK_PROVIDER=1 pnpm dev` adds a keyless `mock` provider for trying the UI.

### Production

```sh
pnpm install --frozen-lockfile
pnpm build          # nuxt generate (web) + tsdown (server)
pnpm start          # one process on http://127.0.0.1:8787 serving the API and the web app
```

Runtime data (SQLite database, encryption key, plugins, uploads, caches) lives in `./data` unless `HF_DATA_DIR` says
otherwise. The server reads a `.env` file from the repository root at start; variables that are already set win.
To serve other machines, bind to all interfaces and set a password:
`HF_HOST=0.0.0.0 HF_PASSWORD='a long passphrase' pnpm start`. See [Security](#security).

### Docker

The image serves the app on port **8787** and keeps all data in the **`/data`** volume. Inside the container the
server listens on all interfaces, so it refuses to start without **`HF_PASSWORD`** (unless a password is already
stored in the volume, or `HF_INSECURE=1` is set behind another authentication layer).

```sh
# Compose reads HF_PASSWORD from the .env file next to docker-compose.yml.
printf 'HF_PASSWORD=%s\n' "$(openssl rand -base64 24)" >> .env   # or write your own long password there
docker compose up -d
```

Open http://localhost:8787 and log in with that password. Chats, keys and plugins stay in the volume across restarts
and image updates. Without Compose:

```sh
docker build -t harness-forge .
docker run -d --name harness-forge -p 8787:8787 -v harness-forge-data:/data -e HF_PASSWORD='a long passphrase' harness-forge
```

The container runs as the unprivileged `node` user (uid 1000); a bind-mounted data directory must be writable by
it. Put a TLS reverse proxy in front before exposing it beyond your machine or LAN.

## Configuration

Every variable is optional. [`.env.example`](.env.example) lists them with comments.

| Name | Default | Meaning |
|---|---|---|
| `HF_PORT` | `8787` | server port (`0` = any free port) |
| `HF_HOST` | `127.0.0.1` | bind address; a non-loopback host requires `HF_PASSWORD`, a password stored in Settings, or `HF_INSECURE=1` |
| `HF_DATA_DIR` | `./data` | data directory; relative paths resolve against the repository root (Docker: `/data`) |
| `HF_PASSWORD` | unset | enables the login screen; overrides a password stored in Settings |
| `HF_MASTER_KEY` | unset | base64 of 32 bytes used to encrypt secrets; otherwise `data/secret.key` is generated (mode 0600) |
| `HF_MOCK_PROVIDER` | unset | `1` registers the dev-only `mock` provider (deterministic models for tests and demos) |
| `HF_SAFE_MODE` | unset | `1` loads builtin plugins only (recovery when a plugin breaks the start) |
| `HF_PLUGIN_WATCH` | unset | `1` hot-reloads code plugins in the data directory when their files change (linked folders always reload) |
| `HF_OFFLINE` | unset | `1` never downloads the models.dev catalog (the bundled snapshot is used) |
| `HF_INSECURE` | unset | `1` allows a non-loopback bind without a password (only behind another authentication layer); it also disables the DNS-rebinding guard that restricts a password-less server to `localhost` host names |
| `HF_WEB_DIR` | `apps/web/.output/public` | directory of the built web app served in production |
| `HF_API_TARGET` | `http://localhost:8787` | where `nuxt dev` proxies `/api` (development only) |
| `NODE_ENV` | unset | `development` forces dev mode (debug logs, `:3000` origins allowed), `production` forces production; by default dev mode means running from TypeScript sources |
| `<VENDOR>_API_KEY` | unset | provider key fallbacks, see [Supported providers](#supported-providers) |

A key saved in Settings wins over its environment variable; the key dialog shows which source is active ("From env").
Flags accept `1` / `true` / `yes` / `on` and `0` / `false` / `no` / `off`.

## Plugins

A plugin is a folder with a `plugin.json`. A **declarative** plugin needs nothing else. This one adds LM Studio as a
provider:

```json
{
  "manifestVersion": 1,
  "id": "lmstudio",
  "name": "LM Studio",
  "version": "1.0.0",
  "icon": "lobe:lmstudio",
  "engines": { "harness": "^1.0.0" },
  "contributes": {
    "providers": [
      {
        "id": "lmstudio",
        "name": "LM Studio",
        "baseURL": "http://localhost:1234/v1",
        "apiFormat": "openai-chat",
        "auth": { "type": "none" }
      }
    ]
  }
}
```

The same plugin can be built without JSON in **Plugins** -> **New plugin** -> **Provider**. **Code** plugins are a
single JavaScript or TypeScript file whose `setup(ctx)` registers tools, providers, commands, MCP servers and hooks.
Start one from a template (**New plugin** -> **Code plugin**), then edit it and use **Build & reload** in the browser.
Or develop in your own editor with a linked folder that reloads on save.

- Guides: [writing a declarative provider](docs/guides/writing-a-declarative-provider.md),
  [writing a code plugin](docs/guides/writing-a-code-plugin.md), [adding an MCP server](docs/guides/adding-an-mcp-server.md).
- Examples that load as they are: [`examples/plugins/`](examples/plugins/) (LM Studio, Together AI, a dice-roller
  tool, a TypeScript echo provider, the MCP "everything" server).
- The full contract (manifest, `PluginContext`, hooks, lifecycle, install, trust): [`docs/PLUGINS.md`](docs/PLUGINS.md).

## Security

harness-forge is built for **one user** on their own machine or server.

- **Network exposure.** The server binds to `127.0.0.1` by default and refuses a non-loopback bind without a
  password. Set `HF_PASSWORD` (or a password in Settings -> General) before exposing it, and use TLS through a
  reverse proxy for anything beyond your LAN.
- **Reverse proxies.** Forward the `Host` header and set `X-Forwarded-Proto: https`, which makes the session cookie
  `Secure` and turns on HSTS. The login rate limiter counts failures per TCP peer and ignores `X-Forwarded-For`,
  which any client can forge. Behind a proxy, all clients therefore share one limit, and 5 failed logins lock
  everyone out for up to 15 minutes. Restrict access at the proxy (allow list, VPN or basic auth) when the server is
  reachable from the internet.
- **Sessions and CSRF.** An HttpOnly, SameSite=Strict HMAC session cookie; state-changing requests must come from
  the same origin. With a password set, installing or trusting code plugins, building them and changing the password
  require a login within the last 10 minutes.
- **Secrets.** Provider keys and plugin secrets are encrypted with AES-256-GCM under a master key from
  `HF_MASTER_KEY` or `data/secret.key`. The API never returns a secret, and logs are redacted.
- **Plugins.** Code plugins and stdio MCP servers run **with the full rights of the server process**. They load only
  after you trust their exact files (SHA-256 pin) and become untrusted again when those files change. Declarative
  plugins run no code. `HF_SAFE_MODE=1` starts with builtin plugins only.
- **Tools.** Tool calls wait for approval in **Ask** mode, except tools marked safe. `web_fetch` reaches only public
  addresses (loopback only when you allow it in the Core tools settings), and every redirect is re-checked. Model
  output is rendered as escaped markdown, never as raw HTML.

Details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#10-security-model).

## Documentation

| Document | Contents |
|---|---|
| [`docs/guides/`](docs/guides/) | step-by-step guides: [declarative provider](docs/guides/writing-a-declarative-provider.md), [code plugin](docs/guides/writing-a-code-plugin.md), [MCP server](docs/guides/adding-an-mcp-server.md) |
| [`examples/plugins/`](examples/plugins/) | five example plugins with READMEs and a test that loads them |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | components, flows, data directory, database, security model, topology |
| [`docs/API.md`](docs/API.md) | every HTTP endpoint, the error envelope, the chat stream protocol, server events |
| [`docs/PLUGINS.md`](docs/PLUGINS.md) | plugin manifest, contribution points, `PluginContext`, hooks, lifecycle, install, trust |
| [`docs/PROVIDERS.md`](docs/PROVIDERS.md) | builtin providers, base URLs, reasoning mappings, seed models, wizard templates, icons |
| [`docs/UI.md`](docs/UI.md) | layout, design tokens, components, routes, shortcuts, test ids |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | phases, tasks and progress |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | architecture decision records and the contract seed |
| [`docs/phases/`](docs/phases/) | per-phase task lists: [0 foundation](docs/phases/phase-0-foundation.md), [1 core services](docs/phases/phase-1-core-services.md), [2 chat](docs/phases/phase-2-chat.md), [3 plugins](docs/phases/phase-3-plugins.md), [4 hardening](docs/phases/phase-4-hardening.md) |
| [`AGENT.md`](AGENT.md) | rules for AI agents working on this repository |

## Development

A pnpm monorepo: `apps/web` (Nuxt 4 SPA, shadcn-vue, Tailwind 4), `apps/server` (Hono, Vercel AI SDK v7, Drizzle
on SQLite), and the TypeScript-only packages `packages/shared` (schemas, DTOs, route table, API client) and
`packages/plugin-sdk` (plugin API types and `definePlugin`).

| Command | Purpose |
|---|---|
| `pnpm dev` | server (`tsx watch`, :8787) + web (`nuxt dev`, :3000, proxies `/api`) |
| `pnpm build` | `nuxt generate` (web) + `tsdown` (server) |
| `pnpm start` | production server on :8787 serving the API and the web app |
| `pnpm start:e2e` | production server with `HF_MOCK_PROVIDER=1 HF_PORT=8899 HF_DATA_DIR=.tmp/e2e` |
| `pnpm test` | Vitest (all projects); `pnpm -F <pkg> test` for one package; `pnpm exec vitest run --project examples` for the example plugins |
| `pnpm test:e2e` | Playwright |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` for packages and server + `nuxi typecheck` for web |
| `pnpm check:english` | fails on any Cyrillic character in the repository |
| `pnpm check` | check:english + lint + typecheck + test |
| `pnpm db:generate` | drizzle-kit generate (after schema changes) |
| `pnpm catalog:update` | refresh the bundled models.dev snapshot |

All development happens on the `main` branch. CI (`.github/workflows/ci.yml`) runs `pnpm check`, the build with the
Playwright e2e suite, and the Docker image build on every push to `main` and on pull requests.

Everything in the repository is written in English (`pnpm check:english` enforces it). AI coding agents read
[`AGENT.md`](AGENT.md) first.

## License

[MIT](LICENSE) © 2025-2026 maksqi
