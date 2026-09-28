# Example plugins

Five small plugins that install as they are. Each folder is one plugin, and its name is the plugin id. Every example
has a README that explains how it works and how to change it.

| Example | Kind | What it shows | Needs |
|---|---|---|---|
| [`lmstudio`](./lmstudio/) | declarative | a keyless OpenAI-compatible provider on localhost | LM Studio's local server on port 1234 |
| [`together-ai`](./together-ai/) | declarative | a cloud provider with an API key, model filters and a reasoning effort mapping | a Together AI key |
| [`dice-roller`](./dice-roller/) | code (`index.mjs`, JSDoc) | a tool with a zod input schema and the `safe` policy | trust |
| [`echo-provider`](./echo-provider/) | code (`index.ts`, TypeScript) | a provider with a hand-written AI SDK `LanguageModelV4` (no key, no network) | trust |
| [`mcp-everything`](./mcp-everything/) | declarative + stdio MCP | an MCP server started with `npx`, whose tools the model can call | trust, `npx` on the server |

## Install an example

1. Open **Plugins** -> **Install…** -> **Local folder**.
2. Enter the absolute path of the example folder, for example `/home/me/harness-forge/examples/plugins/dice-roller`.
   The folder must be on the machine that runs the server.
3. Choose **Link** (the plugin runs from this folder and reloads when you edit it) or **Copy** (a snapshot is copied
   into the data directory).
4. Review the preview. Code plugins and plugins with a stdio MCP server show the trust warning. Check
   **I trust …** to load the plugin; when a password is set, you confirm it first.
5. Press **Install**.

You can also zip a folder (`zip -r dice-roller.zip dice-roller`) and use the **Zip** tab, which works when the
server runs on another machine or in Docker.

## Tests

`examples.test.ts` checks every manifest with the shared `pluginManifestSchema`. It then loads all five examples
into the real plugin host, with no network access and no `npx`. It calls the dice tool, streams a chat from the echo
provider, and runs the LM Studio and Together AI manifests against a fake OpenAI-compatible server. The examples are
a project of the root Vitest config:

```sh
pnpm exec vitest run --project examples
```

## Learn more

- [Writing a declarative provider](../../docs/guides/writing-a-declarative-provider.md)
- [Writing a code plugin](../../docs/guides/writing-a-code-plugin.md)
- [Adding an MCP server](../../docs/guides/adding-an-mcp-server.md)
- [PLUGINS.md](../../docs/PLUGINS.md): the complete plugin contract
