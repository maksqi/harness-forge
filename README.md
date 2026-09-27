# harness-forge

harness-forge is a self-hosted, bring-your-own-key (BYOK) AI chat and agent harness. It is one Node process
with a web UI. You connect your own API keys for Claude, ChatGPT, Gemini, Grok, DeepSeek and other providers, or
you point it at a local Ollama. From there you chat, stream reasoning, and let models call tools. Every tool call
needs your approval unless you decide otherwise. A **Plugins** tab adds new LLM providers, models, tools, MCP
servers and slash commands. The interface is a simplified version of the Claude Code desktop app and uses a dark
theme by default.

> **Status:** under active development. See [`docs/ROADMAP.md`](docs/ROADMAP.md) for progress.

## Features

- **Chat**: streaming markdown with highlighted code blocks, "Thinking…" reasoning rows, collapsed tool-call rows,
  inline tool-approval cards, file attachments, edit / regenerate / copy, stop, auto-generated titles, and
  per-message usage and cost.
- **Composer**: a model picker with provider icons and capability badges, a reasoning-effort menu (reasoning models
  only), a permission mode (Ask / Auto) for tools, and slash commands.
- **Sidebar**: a `Chat | Plugins` switch, chats grouped by date with live status dots, a Mod+K command palette, and
  a light/dark/system theme toggle.
- **Providers and models**: 13 built-in BYOK providers. Keys are encrypted at rest and shown only as masked hints,
  with an environment-variable fallback. Live model listings are enriched with models.dev metadata. You can mark
  favorites, hide models and add custom model ids.
- **Plugins**: declarative provider plugins (JSON only) created with a 5-step wizard. Code plugins start from a
  template and are edited in the browser, then hot-reloaded. You can install plugins from a zip, npm, a URL or a
  local folder, and code plugins require an explicit trust step.
- **Tools and MCP**: MCP servers over stdio, HTTP and SSE. Built-in tools are `current_time` and `web_fetch` (with
  an SSRF guard). Each tool gets its own approval policy.
- **Self-hosting**: SQLite storage, one port in production, an optional password, and a loopback-only bind unless
  you secure it.

## Supported providers

| Provider | Id | Notes |
|---|---|---|
| Anthropic (Claude) | `anthropic` | |
| OpenAI (ChatGPT) | `openai` | |
| Google (Gemini) | `google` | |
| xAI (Grok) | `xai` | |
| DeepSeek | `deepseek` | |
| Moonshot AI (Kimi) | `moonshotai` | |
| Alibaba (Qwen) | `alibaba` | |
| Z.ai (GLM) | `zai` | |
| MiniMax | `minimax` | |
| Mistral | `mistral` | |
| Groq | `groq` | |
| OpenRouter | `openrouter` | hundreds of models behind one key |
| Ollama (local) | `ollama` | no key; base URL `http://localhost:11434/v1` |

For any OpenAI-, Anthropic- or Gemini-compatible endpoint (LM Studio, vLLM, LiteLLM, Together, Fireworks, …),
create a declarative provider plugin. Model references use the form `providerId:modelId`, for example
`anthropic:claude-sonnet-5` or `ollama:llama3:8b`. Base URLs, icons and env var names are listed in
[`docs/PROVIDERS.md`](docs/PROVIDERS.md).

## Quick start

Requirements: **Node >= 22.12** and **pnpm 11**.

```sh
pnpm install
pnpm dev            # server on :8787 + web on :3000 (proxies /api)
```

Open http://localhost:3000, go to **Settings → Providers**, add a key and click **Test**, then start chatting.

Production (one process serving the API and the built SPA):

```sh
pnpm build && pnpm start
```

Then open http://localhost:8787. Runtime data (SQLite database, encryption key, plugins, uploads, caches) lives
in `./data` by default.

Docker support (`Dockerfile` + `docker-compose.yml` with a `/data` volume) arrives in Phase 4.

## Configuration

All variables are optional.

| Name | Default | Meaning |
|---|---|---|
| `HF_PORT` | `8787` | server port |
| `HF_HOST` | `127.0.0.1` | bind address; a non-loopback host requires `HF_PASSWORD` or `HF_INSECURE=1` |
| `HF_DATA_DIR` | `./data` | data directory (resolved against the repo root in dev) |
| `HF_PASSWORD` | unset | enables login; overrides a password stored in settings |
| `HF_MASTER_KEY` | unset | base64 32-byte master key; otherwise `data/secret.key` is generated (mode 0600) |
| `HF_MOCK_PROVIDER` | unset | `1` registers the dev-only `mock` provider |
| `HF_SAFE_MODE` | unset | `1` loads builtin plugins only |
| `HF_PLUGIN_WATCH` | unset | `1` hot-reloads code plugins on file change |
| `HF_OFFLINE` | unset | `1` disables network refresh of the models.dev snapshot |
| `HF_INSECURE` | unset | `1` allows a non-loopback bind without a password |
| `HF_API_TARGET` | `http://localhost:8787` | web dev proxy target |
| `<VENDOR>_API_KEY` | unset | provider key fallbacks, e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY` (full list in `docs/PROVIDERS.md`) |

A key saved in the UI takes precedence over its environment fallback. The UI shows which source is active.

## Plugins

A plugin is a folder with a `plugin.json`. A **declarative** plugin needs nothing else. This example adds LM
Studio as a provider:

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
        "auth": { "type": "none" },
        "credentials": [],
        "listModels": true
      }
    ]
  }
}
```

You can create the same plugin without writing JSON: open **Plugins → New plugin → Provider**. **Code** plugins
(a single ESM file with `definePlugin`) can register tools, providers, MCP servers, commands and hooks. You start
them from a template and edit them in the browser. See [`docs/PLUGINS.md`](docs/PLUGINS.md) for the manifest,
contribution points, `PluginContext`, lifecycle, install sources and trust.

## Documentation

| Document | Contents |
|---|---|
| [`AGENT.md`](AGENT.md) | rules for AI agents working on this repo (ownership, freeze, version facts, commands) |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | phases, tasks and progress (single source of truth) |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | architecture decision records and the contract seed |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | components, flows, data directory, database, security model |
| [`docs/API.md`](docs/API.md) | every HTTP endpoint, the error envelope, the chat stream protocol |
| [`docs/PLUGINS.md`](docs/PLUGINS.md) | plugin manifest, contribution points, context, lifecycle, install, trust |
| [`docs/PROVIDERS.md`](docs/PROVIDERS.md) | built-in providers, base URLs, icons, seed models, declarative format |
| [`docs/UI.md`](docs/UI.md) | layout, design tokens, components, routes, shortcuts, test ids |
| [`docs/phases/`](docs/phases/) | per-phase task lists: [0 foundation](docs/phases/phase-0-foundation.md), [1 core services](docs/phases/phase-1-core-services.md), [2 chat](docs/phases/phase-2-chat.md), [3 plugins](docs/phases/phase-3-plugins.md), [4 hardening](docs/phases/phase-4-hardening.md) |

## Development

The repository is a pnpm monorepo containing `apps/web`, `apps/server`, `packages/shared` and
`packages/plugin-sdk`:

- **web**: Nuxt 4 SPA with shadcn-vue and Tailwind 4.
- **server**: Hono with the Vercel AI SDK v7 and Drizzle on SQLite.
- **shared** and **plugin-sdk**: TypeScript-only packages.

| Command | Purpose |
|---|---|
| `pnpm dev` | server (`tsx watch`, :8787) + web (`nuxt dev`, :3000, proxies `/api`) |
| `pnpm build` | `nuxt generate` (web) + `tsdown` (server) |
| `pnpm start` | production server on :8787 serving API + SPA |
| `pnpm start:e2e` | production server with `HF_MOCK_PROVIDER=1 HF_PORT=8899 HF_DATA_DIR=.tmp/e2e` |
| `pnpm test` | Vitest (all projects); `pnpm -F <pkg> test` for one package |
| `pnpm test:e2e` | Playwright |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` for packages/server + `nuxi typecheck` for web |
| `pnpm -F @harness-forge/web typecheck:fast` | `vue-tsc -b --noEmit` (needs an existing `.nuxt`) |
| `pnpm check:english` | fail on any Cyrillic character in tracked + untracked (non-ignored) files |
| `pnpm check` | check:english + lint + typecheck + test |
| `pnpm db:generate` | drizzle-kit generate |
| `pnpm catalog:update` | refresh the bundled models.dev snapshot |

Everything in the repository is written in English (`pnpm check:english` enforces this). AI coding agents must
read [`AGENT.md`](AGENT.md) before making changes.

## Security

harness-forge is built for **one user** on their own machine or server:

- **Network exposure.** By default the server binds to `127.0.0.1`. Before you expose it, set `HF_PASSWORD`.
- **Stored secrets.** Provider keys and other secrets are encrypted with AES-256-GCM. The master key comes from
  `HF_MASTER_KEY` or from `data/secret.key`. The server never returns secrets to the browser.
- **Code plugins.** Code plugins and stdio MCP servers run **with the full permissions of the server process**.
  Install them only from sources you trust. The install dialog shows a hash, and a plugin will not load until you
  trust it. `HF_SAFE_MODE=1` starts the server with builtin plugins only.

## License

[MIT](LICENSE) © 2025-2026 maksqi
