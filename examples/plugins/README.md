# Example plugins

Eight small plugins that install as they are. Each folder is one plugin, and its name is the plugin id (the Claude Code
example takes its id from the `name` of its `.claude-plugin/plugin.json`: `review-kit`). Every example has a README that
explains how it works and how to change it.

| Example | Kind | What it shows | Needs |
|---|---|---|---|
| [`lmstudio`](./lmstudio/) | declarative | a keyless OpenAI-compatible provider on localhost | LM Studio's local server on port 1234 |
| [`together-ai`](./together-ai/) | declarative | a cloud provider with an API key, model filters and a reasoning effort mapping | a Together AI key |
| [`dice-roller`](./dice-roller/) | code (`index.mjs`, JSDoc) | a tool with a zod input schema and the `safe` policy | trust |
| [`echo-provider`](./echo-provider/) | code (`index.ts`, TypeScript) | a provider with a hand-written AI SDK `LanguageModelV4` (no key, no network) | trust |
| [`mcp-everything`](./mcp-everything/) | declarative + stdio MCP | an MCP server started with `npx`, whose tools the model can call | trust, `npx` on the server |
| [`agent-pack`](./agent-pack/) | code (`index.mjs`) + `contributes` | sub-agent types and skills (plugin API 1.4.0), declared in `plugin.json` and registered from code | trust, a harness with plugin API 1.4.0 |
| [`hook-pack`](./hook-pack/) | declarative + command hook | a `PostToolUse` command hook that reminds the agent to run the tests after a file edit, and the output style `reviewer` (plugin API 1.5.0) | trust, POSIX `sh` on the server, a harness with plugin API 1.5.0 |
| [`claude-review-kit`](./claude-review-kit/) | Claude Code plugin (format `claude`, `.claude-plugin/plugin.json`) | Claude Code's own layout (plugin API 1.6.0): the qualified commands `/review-kit:review` and `/review-kit:db:migrate`, the agent `review-kit:code-reviewer`, the skill `review-kit:checklist` with a supporting file, the output style `review-kit:terse`, a `PostToolUse` command hook, an inline http MCP server and a `userConfig` with a secret option | trust (over every file of the folder), POSIX `sh` on the server, a harness with plugin API 1.6.0 |

## Install an example

1. Open **Plugins** -> **Install…** -> **Local folder**.
2. Enter the absolute path of the example folder, for example `/home/me/harness-forge/examples/plugins/dice-roller`.
   The folder must be on the machine that runs the server.
3. Choose **Link** (the plugin runs from this folder and reloads when you edit it) or **Copy** (a snapshot is copied
   into the data directory).
4. Review the preview. Code plugins, plugins with a stdio MCP server and (plugin API 1.5.0) plugins with command hooks
   or commands with `` !`cmd` `` lines show the trust warning, which lists the commands such a plugin runs. The Claude
   Code example shows **Claude Code plugin**, its qualified names and the settings it asks for, and its trust pin
   covers every file of the folder. Check **I trust …** to load the plugin; when a password is set, you confirm it
   first.
5. Press **Install**.

You can also zip a folder (`zip -r dice-roller.zip dice-roller`) and use the **Zip** tab, which works when the
server runs on another machine or in Docker.

## Tests

`examples.test.ts` checks every manifest with the shared `pluginManifestSchema` (and each `engines.harness` range). It
then loads all eight examples into the real plugin host, with no network access and no `npx`. It calls the dice tool,
streams a chat from the echo provider, runs the LM Studio and Together AI manifests against a fake OpenAI-compatible
server, checks that the agent pack registers its two agents and two skills (one of each from `plugin.json`, one of
each from `index.mjs`) without a warning, and checks that the hook pack requires trust, registers its command hook
(rooted at the plugin folder) and its style, and that its script prints a `PostToolUse` context under POSIX `sh`. The
Claude Code example installs from its folder with the format `claude` (id `review-kit`, no harness `plugin.json`, an
inline MCP server and no `.mcp.json`), loads as a trusted plugin with its qualified commands, agent, skill and style,
its MCP server (the secret reaches it as `{{settings.DOCS_TOKEN}}`) and its hook (whose script prints a `PostToolUse`
context under POSIX `sh`). It also checks that the snippets of `docs/PLUGINS.md` equal the shipped files (including the
agent pack's `plugin.json` and `index.mjs`, the hook pack's `plugin.json` and `scripts/remind-tests.sh`, and the Claude
Code example's `.claude-plugin/plugin.json`, `hooks/hooks.json` and `commands/review.md`) and that the manifests of the
guides parse. The examples are a project of the root Vitest config:

```sh
pnpm exec vitest run --project examples
```

## Learn more

- [Writing a declarative provider](../../docs/guides/writing-a-declarative-provider.md)
- [Writing a code plugin](../../docs/guides/writing-a-code-plugin.md)
- [Adding an MCP server](../../docs/guides/adding-an-mcp-server.md)
- [Hooks and project MCP servers](../../docs/guides/hooks-and-project-mcp.md) and
  [output styles](../../docs/guides/output-styles.md) (plugin API 1.5.0)
- [Claude Code plugins](../../docs/guides/claude-code-plugins.md) and PLUGINS.md section 17 (the Claude Code format)
- [PLUGINS.md](../../docs/PLUGINS.md): the complete plugin contract
