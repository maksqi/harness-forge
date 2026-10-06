# Writing a code plugin

A **code plugin** is a `plugin.json` plus one JavaScript or TypeScript file. The file's `setup(ctx)` function
registers tools, providers, slash commands, MCP servers, hooks, (plugin API 1.4.0) sub-agent types and skills and
(plugin API 1.5.0) output styles through `ctx`. Use a code plugin when a manifest is not enough: a tool the model can
call, a provider for an unusual API, a command that computes its answer, a hook that changes prompts and tool calls, or
agents, skills and styles built from code. (Command hooks, the shell commands of Claude Code's `hooks` format, are
declared in `plugin.json` as `contributes.hooks`; plugin API 1.5.0 has no `ctx` API for them.)

> **Trust.** A code plugin runs **inside the server process with its full rights**. It can read every API key and
> conversation, the data directory and `process.env`, make any network request and start programs. harness-forge
> loads a code plugin only after you trust its exact files (a SHA-256 pin). Only install code you would run yourself.

Reference: [PLUGINS.md sections 8-13](../PLUGINS.md#8-code-plugins) · Runnable examples:
[`dice-roller`](../../examples/plugins/dice-roller/) (JavaScript tool),
[`echo-provider`](../../examples/plugins/echo-provider/) (TypeScript provider),
[`agent-pack`](../../examples/plugins/agent-pack/) (agents and skills, plugin API 1.4.0).

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
| `tools.register`, `providers.register`, `models.register`, `commands.register`, `mcp.register`, `hooks.on`, (1.4.0) `agents.register`, `skills.register`, (1.5.0) `outputStyles.register` | contributions (each returns a `Disposable`) |
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
  async execute(input, call) {             // call: { chatId, modelRef, toolCallId, messages, signal, workspace? }
    const response = await ctx.fetch(`https://api.example.com/items/${encodeURIComponent(input.id)}`, { signal: call.signal })
    if (!response.ok)
      throw new Error(`Lookup failed with HTTP ${response.status}`) // becomes an error result for the model
    return await response.json()          // JSON-serializable; capped at 64 KB
  },
})
```

- **Policy and approval.** In **Ask** mode, `safe` tools run at once while `ask` and `always` tools show an approval
  card. In **Accept edits** (plugin API 1.2.0, project chats) `safe` tools and `ask` tools with `workspace: 'write'`
  run; everything else asks. In **Plan** (plugin API 1.3.0) tools with `workspace: 'write'` / `'execute'` are not
  offered and the rest follow Ask. In **Auto** mode only `always` asks. A policy function
  (`input => input.path.startsWith('/tmp/') ? 'safe' : 'always'`) decides per call and can return `'deny'`. Users
  can override any tool in the plugin's tools table (Allow / Ask / Deny, or switch it off), and the override wins over
  your policy. With the permission mode **Off**, no tools are sent at all.
- **Stop and disable.** `call.signal` aborts when the user presses Stop, when the timeout passes, or when the plugin
  is disabled. Pass it to `fetch` and long loops.
- **Output.** Return plain data. When the model should see something shorter than what the UI shows, add
  `toModelOutput(output) { return { type: 'text', value: '...' } }`. It must be fast and deterministic, because it also
  runs when history is replayed.

### Workspace-aware tools (plugin API 1.2.0)

In a chat that belongs to a project ([using projects](./using-projects.md)), every tool call gets
`call.workspace = { projectId, name, root }`, where `root` is the verified real path of the project folder. A tool that
only makes sense there declares `workspace`: `'read'`, `'write'` or `'execute'`. Such a tool is offered to the model
only in project chats (and an `execute` tool only while the server allows the shell), and a `write` tool with policy
`ask` runs without an approval card in **Accept edits**. Declare `"engines": { "harness": "^1.2.0" }`, so an older
server reports the plugin `incompatible` instead of offering the tool everywhere.

```js
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

ctx.tools.register({
  name: 'todo_count',
  description: 'Count the TODO comments in a file of the current project.',
  inputSchema: ctx.ai.z.object({ path: ctx.ai.z.string().describe('File path relative to the project folder') }),
  policy: 'safe',                 // read-only: no approval card
  workspace: 'read',              // offered only in project chats
  async execute({ path }, call) {
    if (!call.workspace)
      throw new Error('This tool works only in a project chat.')
    const { root } = call.workspace
    const file = await realpath(resolve(root, path)) // follow links first, then check where the file really is
    const rel = relative(root, file)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
      throw new Error('Path is outside the project folder.')
    const text = await readFile(file, { encoding: 'utf8', signal: call.signal })
    return { path: rel.split(sep).join('/'), todos: (text.match(/\bTODO\b/g) ?? []).length }
  },
  toModelOutput: output => ({ type: 'text', value: `${output.path}: ${output.todos} TODO comments.` }),
})
```

- **Stay inside `root` yourself.** The host does not confine plugin code: resolve every path against `root`, follow
  symbolic links with `realpath`, and refuse anything outside (the builtin tools also refuse writes inside `.git`).
  Return project-relative paths, never absolute ones.
- **Writes**: declare `workspace: 'write'` with policy `ask`, or a policy function that returns `'always'` for paths
  that deserve a look even in Accept edits (hidden folders, secrets), as the builtin `write_file` does.
- **No shells**: never start a shell or a program on the model's behalf from a plugin; the builtin `shell` tool
  already runs approved commands in a contained process group. `workspace: 'execute'` exists for tools that run
  something in the project; such tools disappear when the server sets `HF_WORKSPACE_SHELL=0`.
- `call.workspace` is set for every tool of a project chat, also tools without `workspace`, so an ordinary tool can
  adapt (for example, default a file name to the project).
- The builtin workspace tools (`read_file`, `edit_file`, `shell`, …) already cover files and commands; build a
  workspace tool for something they do not do (a linter, a project-specific index).
- **Not restorable** (v1.4): rewind and the changes panel restore only what the builtin `write_file` / `edit_file`
  wrote. Every call of a `write` or `execute` tool is journaled by name only, so the rewind dialog lists your tool
  under "Other tools changed files too", but its changes stay. An `execute` tool can never be "always allowed" (the
  server refuses that override), and the user's shell rules apply only to the builtin `shell`, never to your tool.
  Nothing changes in the plugin API (still 1.2.0).
- **Sub-agents** (v1.5): the builtin `task` tool runs a sub-agent that gets your tool only when it would run without a
  card in the chat's mode (a call that would ask is denied there); `call.toolCallId` then reads
  `<parent call id>/<child call id>`.

### Streaming tools (plugin API 1.3.0)

Write `execute` as an `async function*` to show progress: every `yield` is a preliminary output that the chat shows in
the tool row while the tool runs (at most one per 250 ms, the latest wins), and the last yielded value is the result
the model and the `tool.after` hooks see. The timeout and `call.signal` cover the whole loop, so stop when the signal
aborts. Declare `"engines": { "harness": "^1.3.0" }`, so an older server reports the plugin `incompatible`. Example in
[PLUGINS.md "Tools"](../PLUGINS.md#tools).

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
- Image and voice models (plugin API 1.1.0): add `createImageModel`, `createTranscriptionModel` or `createSpeechModel`
  (plus `imageParams`, `transcriptionOptions` and `voices` on speech models) and declare the models with
  `kind: 'image'`, `'transcription'` or `'speech'`; use `"engines": { "harness": "^1.1.0" }`. Seeds of these kinds are
  listed even next to a live listing, but only when the matching factory exists: without `createImageModel` your image
  models never show up. Image models appear in the composer's "Image models" group; transcription and speech models
  are picked in Settings → Media. A local Whisper server for dictation is
  [PLUGINS.md 15 (e)](../PLUGINS.md#e-code-provider-plugin-dictation-through-a-local-whisper-server-plugin-api-110);
  `ctx.images.generate()` creates images from plugin code (stored as files, usage recorded; since plugin API 1.2.0 the
  result also carries `modelName`; errors in [PLUGINS.md 9](../PLUGINS.md#plugincontext)). Keep the ids of files your
  plugin needs in `ctx.storage` or its settings: the storage cleanup (Settings → Data) keeps only files something
  references, and it does not look into `ctx.plugin.dataDir`.

## Commands

A command runs when a user message starts with `/name`. The text after the name is the input.

| Kind | Result |
|---|---|
| `template: 'Explain like I am five:\n\n{{input}}'` | the expanded text goes to the model; the transcript keeps `/name input` |
| `run` returning `{ type: 'prompt', text }` | `text` goes to the model instead of the message |
| `run` returning `{ type: 'reply', markdown }` | shown as the answer, with no model call (30 s limit) |

Command names are global: the first plugin to register a name wins, and a later registration throws. The names `new`,
`model`, `effort`, `mode`, `help`, (since v1.6) `remember` and (since v1.7) `output-style` belong to the composer, and
`compact` to the server: registering one of them throws `validation_error`. The builtin commands (`/explain`, `/review`,
`/translate`, ...) are listed in [PLUGINS.md section 1](../PLUGINS.md#builtin-plugins). Since v1.6 a user's personal
command (Settings -> Customize) or a project command (`.harness/commands/`, `.claude/commands/`) with the same name wins
over yours where it exists ([customizing agents](./customizing-agents.md)).

Since plugin API 1.5.0 a `template` can hold `` !`cmd` `` lines and `@path` references, like a project command file:
in a project chat the lines run in the project folder before the model is called and the files are inlined
([customizing agents](./customizing-agents.md#commands-harnesscommandsnamemd)); outside projects a template with
`` !`cmd` `` lines is refused and `@path` stays text. A declarative manifest whose template holds such a line requires
trust, like a code plugin. The prompt a `run` command returns is never scanned for them.

## Agents and skills (plugin API 1.4.0)

`ctx.agents.register()` adds a **sub-agent type**: the main agent starts it with the `task` tool
(`type: '<name>'`), and it runs with your `instructions` after the sub-agent preamble. `ctx.skills.register()` adds a
**skill**: the model sees its name and description and loads its `content` with the `skill` tool when a request
matches. Both return a `Disposable` and disappear when the plugin is disabled, reloaded or uninstalled.

```js
export default {
  setup(ctx) {
    ctx.agents.register({
      name: 'docs-writer', // a-z, 0-9 and "-", up to 64 characters; not explore, general or general-purpose
      description: 'Writes or updates documentation for code that changed. Use it after a feature is done.',
      instructions: 'You write concise documentation.',
      tools: ['read_file', 'find_files', 'write_file', 'edit_file'], // optional; only narrows
      model: 'inherit', // optional: 'provider:model' or 'inherit' (the chat's model)
    })
    ctx.skills.register({
      name: 'changelog-entry',
      description: 'How to add an entry to CHANGELOG.md. Load it before editing the changelog.',
      content: '# Changelog entries\n\nAdd the entry under "Unreleased".',
    })
  },
}
```

- **Validation**: the same rules as `contributes.agents` / `contributes.skills` (descriptions 1-1024 characters,
  `instructions` / `content` up to 64 KiB, at most 64 tool names or `mcp__<server>__*` prefixes). A bad field throws
  `validation_error`; a name another plugin already registered throws `conflict`, so catch it in `setup` if the plugin
  should load anyway.
- **Tools only narrow**: a sub-agent never gets a tool that would ask in the chat's mode, the agent tools or
  `generate_image`, whatever `tools` lists. Without `tools` it gets every tool a sub-agent may use.
- **Names are shared**: a personal agent or skill (Settings -> Customize) or a project file (`.harness/agents/`,
  `.claude/agents/`, `.harness/skills/<name>/SKILL.md`, ...) with the same name wins over yours where it exists.
- **No code needed** for fixed definitions: `contributes.agents` / `contributes.skills` in `plugin.json` take the same
  fields and run no code. Declare `"engines": { "harness": "^1.4.0" }` for either form.

Reference: [PLUGINS.md "Agents and skills"](../PLUGINS.md#agents-and-skills).

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
| `tool.after` | `output`; 1.5.0: `context` (a text the model reads at its next step; the reply shows it as a `PostToolUse` hook note from your plugin, labelled `tool.after`, at most 10,000 characters) | post-processing, redaction, a lint hint |
| `message.completed` | nothing (observe) | logging, usage accounting |
| `prompt.submit` (1.5.0) | `block` (refuse the message with a reason: a 409 `hook-blocked`, the message stays in the composer and nothing is stored), `context`; `input.command` is the slash command's name when the message is a command | a secret scanner, ticket context |
| `session.start` (1.5.0) | `context` (at a chat's first turn and after a compaction) | project facts, the current branch |
| `run.stop` (1.5.0) | `continue` (a reason: the agent goes on; at most 5 in a row) | "the tests are red, keep going" |
| `subagent.stop` (1.5.0) | `continue` (one more sub-agent round, at most 2) | a report that misses a section |
| `compact.before` (1.5.0) | nothing (observe) | logging |
| `notification` (1.5.0) | nothing (observe; a run waits for an approval) | desktop or chat notifications |

`prompt.submit`, `session.start` and `run.stop` carry `projectId` (null outside projects). Declare
`"engines": { "harness": "^1.5.0" }` when you use one. The 1.5.0 events run together with the command hooks of the same
event and are listed in Settings → Customize → Hooks under your plugin; the kill switches of command hooks (**Run
hooks**, `HF_WORKSPACE_SHELL=0`) do not stop them. A plugin can also ship **command hooks** without code:
`contributes.hooks` in `plugin.json`, Claude Code's format; such a plugin needs trust, and the trust pin covers
`plugin.json`, not the scripts its hooks call ([PLUGINS.md](../PLUGINS.md#declarative-hooks-plugin-api-150),
[hooks and project MCP servers](hooks-and-project-mcp.md)).

```js
// Refuse messages that contain an API key, and give the agent the time zone at the start of each chat.
ctx.hooks.on('prompt.submit', (input, output) => {
  if (/\bsk-[A-Za-z0-9_-]{20,}/.test(input.prompt))
    output.block = 'This message seems to contain an API key. Remove it and send it again.'
})
ctx.hooks.on('session.start', (_input, output) => {
  output.context = `The user's time zone is ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`
})
```

## Output styles (plugin API 1.5.0)

An output style changes how the agent writes its replies; the user picks it in the composer, per project or as the
default. Register one from code, or declare it in `contributes.outputStyles` (no code needed):

```js
ctx.outputStyles.register({
  name: 'release-manager',
  description: 'Replies as a release checklist with risks first.',
  content: 'Answer as a release manager: list the risks first, then a numbered checklist. Keep it short.',
  keepCodingInstructions: true, // false (the default) drops harness-forge's coding instructions while it is used
})
```

The name follows the agent and skill pattern and cannot be `default`, `explanatory` or `learning`; a personal or
project style of the same name wins. At most 20 styles per plugin (manifest and code together; more throws
`validation_error`); a name another plugin registered first throws `conflict` (a manifest entry is skipped with a
warning in the Logs tab instead). Guide: [output styles](output-styles.md).

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
const model = await ctx.models.resolve('anthropic:claude-haiku-4-5') // the user's key; provider_not_configured when unusable
const { text } = await ctx.ai.generateText({ model, prompt: 'Summarize: ...', abortSignal: ctx.signal })
```

`ctx.models.resolve` throws `provider_not_configured` when the provider is unknown (since plugin API 1.2.0; it was
`not_found`), switched off or missing its key, and `model_not_found` when the model is not in the provider's list.

Calls are billed to the user's key, so say in your description that the plugin makes them.

## Lifecycle, debugging and trust

- **States**: `active`, `disabled`, `untrusted` (the files changed since they were trusted), `incompatible`
  (`engines.harness` does not match the plugin API `1.5.0`, so use `"^1.0.0"`, or `"^1.1.0"` / `"^1.2.0"` /
  `"^1.3.0"` / `"^1.4.0"` / `"^1.5.0"` for the members of those versions),
  `error` (invalid manifest, `setup` threw or timed out, build failed). The plugin card and the detail header show the
  state and the last error.
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
