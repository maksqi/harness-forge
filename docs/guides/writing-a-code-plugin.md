# Writing a code plugin

A **code plugin** is a `plugin.json` plus one JavaScript or TypeScript file. The file's `setup(ctx)` function
registers tools, providers, slash commands, MCP servers and hooks through `ctx`. Use a code plugin when a manifest is
not enough: a tool the model can call, a provider for an unusual API, a command that computes its answer, or a hook
that changes prompts and tool calls.

> **Trust.** A code plugin runs **inside the server process with its full rights**. It can read every API key and
> conversation, the data directory and `process.env`, make any network request and start programs. harness-forge
> loads a code plugin only after you trust its exact files (a SHA-256 pin). Only install code you would run yourself.

Reference: [PLUGINS.md sections 8-13](../PLUGINS.md#8-code-plugins) · Runnable examples:
[`dice-roller`](../../examples/plugins/dice-roller/) (JavaScript tool),
[`echo-provider`](../../examples/plugins/echo-provider/) (TypeScript provider).

## Two ways to work

**In the browser.** **Plugins** -> **New plugin** -> **Code plugin**, then enter a name and pick a template:

| Template | Starts you with |
|---|---|
| Tool | one tool with a zod input schema and the `ask` policy |
| Provider | a provider for any OpenAI-compatible API (base URL and key in Settings -> Providers) |
| MCP bridge | a remote MCP server configured in the plugin's settings |
| Command pack | a template command and a `run` command |

**Create plugin** writes `plugin.json`, `index.mjs`, `harness-forge.d.ts` (editor types) and a `README.md`, trusts the
new plugin and opens its **Source** tab. With a password set, you confirm the password first; the confirmation lasts 10
minutes. Edit the files, save with **Mod+S**, then press **Build & reload**. Build errors show up in the editor and the
build panel, and `ctx.logger` output shows up in the **Logs** tab. Saving and building keep a `created` plugin
trusted. The form creates JavaScript entries; the API (`POST /api/plugins/scaffold` with `"language": "ts"`) creates
the same templates in TypeScript.

**In your own editor.** Create a folder whose name is the plugin id, add `plugin.json` and the entry, then install
it with **Plugins** -> **Install…** -> **Local folder** -> **Link** and trust it once. A linked folder is pinned by its
path, so every save hot-reloads the plugin without asking for trust again. Copy `harness-forge.d.ts` from
[an example](../../examples/plugins/dice-roller/harness-forge.d.ts) to get types and completion without installing
anything.

## Anatomy

`plugin.json`: `main` makes it a code plugin, and `permissions` tells users what the code does. Permissions are shown
in the trust dialog but not enforced.

| Permission | Declare it when the plugin |
|---|---|
| `network` | calls other hosts (`ctx.fetch`) |
| `secrets` | stores secrets (`ctx.secrets`) |
| `storage` | stores data (`ctx.storage`, `ctx.plugin.dataDir`) |
| `hooks` | registers hooks (it can read and change conversations) |
| `process` | starts programs (for example a stdio MCP server) |

The entry default-exports `{ setup(ctx), dispose? }`:

- `setup` must finish within 10 s. Start long work without awaiting it, and stop it when `ctx.signal` aborts.
- Everything registered through `ctx` is removed automatically on disable, reload and uninstall. `dispose()` (5 s) is
  only for resources you created yourself, such as timers or sockets.
- **One file, no packages.** Only Node built-ins (`node:crypto`, `node:timers/promises`, ...) can be imported. zod
  and the AI SDK come from `ctx.ai`: `z`, `tool`, `jsonSchema`, `generateText`, `createOpenAICompatible`,
  `createAnthropic`, `createOpenAI`, `createGoogleGenerativeAI`. A relative import or a package import fails the load
  with a message that names the replacement.

| `ctx` member | Use |
|---|---|
| `tools.register`, `providers.register`, `models.register`, `commands.register`, `mcp.register`, `hooks.on` | contributions (each returns a `Disposable`) |
| `settings.get()`, `settings.onChange()` | the plugin's settings form (Configuration tab) |
| `secrets`, `storage` | encrypted strings and JSON values scoped to the plugin |
| `models.resolve(ref)` + `ai.generateText` | call any configured model |
| `logger` | the Logs tab and the server log (secrets redacted) |
| `fetch`, `signal`, `plugin.dir`, `plugin.dataDir` | network access, lifetime, paths |

## A complete plugin, step by step

The plugin **house-style** adds three things: a house style to every chat (a hook), a style checker the model can
call (a tool), and `/style` to show the current settings (a command).

`house-style/plugin.json`:

```json
{
  "manifestVersion": 1,
  "id": "house-style",
  "name": "House style",
  "version": "0.1.0",
  "description": "Adds the house style to every chat, a style check tool and a /style command.",
  "engines": { "harness": "^1.0.0" },
  "main": "index.mjs",
  "permissions": ["hooks"],
  "settings": {
    "type": "object",
    "properties": {
      "style": {
        "type": "string",
        "format": "multiline",
        "title": "Style instructions",
        "description": "Appended to the instructions of every chat.",
        "default": "Use British English. Prefer short sentences."
      },
      "bannedWords": {
        "type": "array",
        "items": { "type": "string" },
        "title": "Banned words",
        "default": ["synergy", "leverage"]
      }
    }
  }
}
```

`house-style/index.mjs`:

```js
// @ts-check
/// <reference path="./harness-forge.d.ts" />

/** @typedef {{ style?: string, bannedWords?: string[] }} Settings */

/** @type {import('@harness-forge/plugin-sdk').PluginModule} */
export default {
  setup(ctx) {
    const { z } = ctx.ai
    /** @returns {Settings} */
    const settings = () => ctx.settings.get()

    // A tool the model can call. Tool names are global: prefix them with something plugin-specific.
    ctx.tools.register({
      name: 'house_style_check',
      description: 'Check a text against the house style. Returns the banned words it contains.',
      inputSchema: z.object({ text: z.string().max(100_000).describe('The text to check') }),
      policy: 'safe', // read-only: runs without an approval card in "Ask" mode
      async execute({ text }) {
        const lower = text.toLowerCase()
        const found = (settings().bannedWords ?? []).filter(word => lower.includes(word.toLowerCase()))
        ctx.logger.debug('checked a text', { found: found.length })
        return { ok: found.length === 0, found }
      },
    })

    // A slash command that answers without calling the model.
    ctx.commands.register({
      name: 'style',
      description: 'Show the house style',
      async run() {
        const { style = '', bannedWords = [] } = settings()
        const lines = [`**Style:** ${style || '(none)'}`, `**Banned words:** ${bannedWords.join(', ') || '(none)'}`]
        return { type: 'reply', markdown: lines.join('\n\n') }
      },
    })

    // A hook that appends the style to the instructions of every chat.
    ctx.hooks.on('chat.params', (_input, output) => {
      const { style } = settings()
      if (style)
        output.instructions = `${output.instructions}\n\n${style}`.trim()
    })
  },
}
```

Try it: link the folder, trust it, and change the settings in the **Configuration** tab. Type `/style` in a chat,
then ask a tool-capable model to "check this paragraph against the house style: ...".

### The same plugin in TypeScript

Set `"main": "index.ts"`. The host compiles the entry with esbuild when the plugin loads and on **Build & reload**.
The build strips types without checking them, so run `tsc --noEmit` yourself when you want type errors. From
`@harness-forge/plugin-sdk` only `definePlugin` and `PLUGIN_API_VERSION` exist at runtime; import everything else with
`import type`.

`house-style/index.ts`:

```ts
/// <reference path="./harness-forge.d.ts" />
import type { CommandDefinition, ToolDefinition } from '@harness-forge/plugin-sdk'
import { definePlugin } from '@harness-forge/plugin-sdk'

interface Settings { style?: string, bannedWords?: string[] }

export default definePlugin({
  setup(ctx) {
    const { z } = ctx.ai
    const settings = (): Settings => ctx.settings.get<Settings>()

    const check: ToolDefinition<{ text: string }, { ok: boolean, found: string[] }> = {
      name: 'house_style_check',
      description: 'Check a text against the house style. Returns the banned words it contains.',
      inputSchema: z.object({ text: z.string().max(100_000).describe('The text to check') }),
      policy: 'safe',
      async execute({ text }) {
        const lower = text.toLowerCase()
        const found = (settings().bannedWords ?? []).filter(word => lower.includes(word.toLowerCase()))
        return { ok: found.length === 0, found }
      },
    }
    ctx.tools.register(check)

    const style: CommandDefinition = {
      name: 'style',
      description: 'Show the house style',
      async run() {
        const { style = '', bannedWords = [] } = settings()
        return { type: 'reply', markdown: `**Style:** ${style || '(none)'}\n\n**Banned words:** ${bannedWords.join(', ') || '(none)'}` }
      },
    }
    ctx.commands.register(style)

    ctx.hooks.on('chat.params', (_input, output) => {
      const { style } = settings()
      if (style)
        output.instructions = `${output.instructions}\n\n${style}`.trim()
    })
  },
})
```

## Tools

```js
ctx.tools.register({
  name: 'myplugin_lookup',                 // ^[a-zA-Z0-9_-]{1,64}$, globally unique, `mcp__` is reserved
  description: 'What the tool does and when to use it (sent to the model, <= 1024 characters).',
  inputSchema: ctx.ai.z.object({ id: ctx.ai.z.string() }), // must describe a JSON object
  policy: 'ask',                           // 'safe' | 'ask' | 'always', or a function of the input
  timeoutMs: 30_000,                       // default 60 s, max 600 s
  async execute(input, call) {             // call: { chatId, modelRef, toolCallId, messages, signal }
    const response = await ctx.fetch(`https://api.example.com/items/${encodeURIComponent(input.id)}`, { signal: call.signal })
    if (!response.ok)
      throw new Error(`Lookup failed with HTTP ${response.status}`) // becomes an error result for the model
    return await response.json()          // JSON-serializable; capped at 64 KB
  },
})
```

- **Policy and approval.** In **Ask** mode, `safe` tools run at once while `ask` and `always` tools show an approval
  card. In **Auto** mode only `always` asks. A policy function (`input => input.path.startsWith('/tmp/') ? 'safe' :
  'always'`) decides per call and can return `'deny'`. Users can override any tool in the plugin's tools table (Allow /
  Ask / Deny, or switch it off), and the override wins over your policy. With the permission mode **Off**, no tools
  are sent at all.
- **Stop and disable.** `call.signal` aborts when the user presses Stop, when the timeout passes, or when the plugin
  is disabled. Pass it to `fetch` and long loops.
- **Output.** Return plain data. When the model should see something shorter than what the UI shows, add
  `toModelOutput(output) { return { type: 'text', value: '...' } }`. It must be fast and deterministic, because it also
  runs when history is replayed.

## Providers

For an OpenAI-compatible API, a provider is a few lines. The **Provider** template generates the same code.

```js
ctx.providers.register({
  id: 'my-gateway',                         // `<pluginId>` or `<pluginId>-<suffix>`
  name: 'My gateway',
  keyUrl: 'https://llm.example.com/keys',  // "Get a key" link
  credentials: [                            // fields of the key dialog in Settings -> Providers
    { key: 'apiKey', label: 'API key', type: 'secret', required: true, envVar: 'MY_GATEWAY_API_KEY' },
    { key: 'baseURL', label: 'Base URL', type: 'url', default: 'https://llm.example.com/v1', advanced: true },
  ],
  seedModels: [{ id: 'large', name: 'Large', capabilities: { tools: true, reasoning: true }, reasoningEfforts: ['low', 'medium', 'high'] }],
  createLanguageModel(modelId, rt) {        // per request; no network I/O here
    return ctx.ai.createOpenAICompatible({
      name: 'my-gateway',
      baseURL: rt.credentials.baseURL,
      apiKey: rt.credentials.apiKey,
      fetch: rt.fetch,                      // aborted with the run, same-origin redirects only
      includeUsage: true,
    }).chatModel(modelId)
  },
  reasoning(effort) {                       // the effort menu -> AI SDK `reasoning` option
    return effort === 'auto' ? undefined : { reasoning: { off: 'none', low: 'low', medium: 'medium', high: 'high', max: 'xhigh' }[effort] }
  },
})
```

- `rt.credentials` holds the resolved values: the stored value, then the environment variable (`envVar`, which is
  allowed only in code plugins), then the `default`.
- Optional members: `listModels(rt)` for the live model list (cached 24 h, also the **Test** button), `validate(rt)`
  for a custom credential check, `mapError(err)` to turn API errors into clear messages (for example a quota error
  into `rate_limited`), and `smallModelId` for chat titles. A complete gateway example is in
  [PLUGINS.md 15 (c)](../PLUGINS.md#c-code-provider-plugin-openai-compatible-gateway-with-a-custom-header-and-listmodels).
- For an API with its own wire format, `createLanguageModel` returns your own AI SDK `LanguageModelV4` object with
  `doGenerate` and `doStream`. [`echo-provider`](../../examples/plugins/echo-provider/index.ts) implements a
  streaming one, with usage and Stop support.
- `ctx.models.register('openrouter', [{ id: 'vendor/new-model' }])` adds models to any provider, builtins included.

## Commands

A command runs when a user message starts with `/name`. The text after the name is the input.

| Kind | Result |
|---|---|
| `template: 'Explain like I am five:\n\n{{input}}'` | the expanded text goes to the model; the transcript keeps `/name input` |
| `run` returning `{ type: 'prompt', text }` | `text` goes to the model instead of the message |
| `run` returning `{ type: 'reply', markdown }` | shown as the answer, with no model call (30 s limit) |

Command names are global: the first plugin to register a name wins, and a later registration throws. The names
`new`, `model`, `effort`, `mode` and `help` belong to the composer. The builtin commands (`/explain`, `/review`,
`/translate`, ...) are listed in [PLUGINS.md section 1](../PLUGINS.md#builtin-plugins).

## Hooks

Hooks see and change what the chat pipeline sends. Declare the `hooks` permission. Each handler gets a frozen `input`
and a mutable `output` draft, has 3 seconds, and runs by `priority` (higher first). A handler that throws has its
changes discarded; after 5 failures in a row it is switched off until the plugin reloads.

| Hook | Change | Typical use |
|---|---|---|
| `chat.params` | `instructions`, `temperature`, `maxOutputTokens`, `maxSteps`, `reasoning`, `providerOptions` | house rules, per-model tuning |
| `chat.headers` | `headers` of every model request of the run | tracing or routing headers for a gateway |
| `chat.messages` | `messages` sent to the model | inject context, strip content |
| `tool.approve` | `decision`: `allow` / `ask` / `deny` | auto-approve trusted inputs, deny dangerous ones |
| `tool.before` | `input`; **throw to block the call** | validation, redaction |
| `tool.after` | `output` | post-processing, redaction |
| `message.completed` | nothing (observe) | logging, usage accounting |

## Settings, secrets and storage

- **Settings**: declare a `settings` schema in `plugin.json` (strings, numbers, booleans, enums, string arrays, and
  `format: "secret"` for write-only values). Users edit it in the **Configuration** tab. `ctx.settings.get()` returns
  the values with defaults applied and secrets decrypted. `ctx.settings.onChange(cb)` runs after each save.
- **Secrets**: `await ctx.secrets.set('token', value)` for tokens the plugin manages itself (encrypted, never
  returned by any API).
- **Storage**: `await ctx.storage.set('cache', { ... })` stores JSON values (up to 256 KB each, 10 MB per plugin).
  `ctx.plugin.dataDir` is a private folder for files. Both survive updates and are deleted on uninstall unless the
  user keeps the data.

## Calling a model

```js
const model = await ctx.models.resolve('anthropic:claude-haiku-4-5') // uses the user's key; throws when not configured
const { text } = await ctx.ai.generateText({ model, prompt: 'Summarize: ...', abortSignal: ctx.signal })
```

Calls are billed to the user's key, so say in your description that the plugin makes them.

## Lifecycle, debugging and trust

- **States**: `active`, `disabled`, `untrusted` (the files changed since they were trusted), `incompatible`
  (`engines.harness` does not match the plugin API `1.0.0`, so use `"^1.0.0"`), `error` (invalid manifest, `setup`
  threw or timed out, build failed). The plugin card and the detail header show the state and the last error.
- **Logs**: `ctx.logger.debug/info/warn/error(message, data)` shows up in the Logs tab (last 500 entries) and the
  server log.
- **Reloading**: linked folders reload on save. Code plugins inside the data directory reload on **Build & reload**
  or **Reload**, or on save when the server runs with `HF_PLUGIN_WATCH=1`. Node never unloads modules, so restart the
  server after long editing sessions.
- **Safe mode**: if a plugin hangs the server at startup, start it with `HF_SAFE_MODE=1` (builtins only), then disable
  or uninstall the plugin.
- **Trust**: the pin is the SHA-256 of `plugin.json` and the entry file. Any change on disk makes the plugin
  `untrusted` until someone presses **Trust** again. The exceptions are editor saves of a `created` plugin that was
  trusted before (re-pinned automatically), a successful **Build & reload**, and linked folders (pinned by path).
  With a password set, trusting, creating and building code plugins ask for the password again when the last login
  is older than 10 minutes.

## Package and publish

- **Zip**: `zip -r house-style.zip house-style`. `plugin.json` must be at the root of the archive or in its single
  top-level folder. Users install it from the **Zip** tab.
- **npm**: put `plugin.json` at the package root and publish. `dependencies` are ignored and lifecycle scripts never
  run. Users install `name@version` from the **npm** tab.
- **URL**: an `https:` link to a `.zip` or `.tgz` plus its SRI hash (`sha256-...` or `sha512-...`).
- **Export**: the plugin's export action downloads the folder as a zip, without settings, storage or secrets.

Every update of a code plugin changes its pin, so users review and trust each new version.
