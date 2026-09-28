# MCP Everything (demo)

A declarative plugin that starts the MCP reference test server
([`@modelcontextprotocol/server-everything`](https://github.com/modelcontextprotocol/servers/tree/main/src/everything))
over stdio with `npx`. The model can then call its demo tools: echo, add, a long-running operation, an image, and more.

| | |
|---|---|
| Kind | declarative, but it declares a **stdio** MCP server, which starts a program. That needs trust. |
| Contributes | MCP server `mcp-everything`, tools `mcp__mcp-everything__<tool>` |
| Permissions | `process` (starts `npx`), `network` (npx downloads the package) |
| Needs | `npx` (Node.js) on the `PATH` of the server |

## Try it

1. Install this folder: **Plugins** -> **Install…** -> **Local folder** -> Link or Copy, then check **I trust …**
   (see [the examples README](../README.md#install-an-example)).
2. The server connects in the background. The first start downloads the package, which can take a while. The
   plugin's detail page shows the server status (with **Restart**) and its tools.
3. In a chat with a tool-capable model, ask "Use the echo tool to say hello" or "Add 2 and 3 with your tools".

Tools that the server marks read-only (`readOnlyHint`) run without asking. Destructive tools (`destructiveHint`)
always ask. The others follow the server's `policy`, which defaults to `ask`. In the tools table of the detail page
you can switch each tool off or override its approval (Allow, Ask or Deny).

## How it works

```json
{ "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] }
```

- The process starts without a shell, in the plugin directory. It gets only a minimal environment (`PATH`, `HOME`, …)
  plus the declared `env`: the server's `HF_*` variables and provider keys are never passed to it.
- It stops when the plugin is disabled or reloaded, or when the server shuts down. **Restart** on the detail page
  starts it again.
- The trust pin covers `plugin.json`. Any change to the command or its arguments makes the plugin untrusted until
  you trust it again.

## Adapt it

- Any stdio MCP server works the same way: `"command": "uvx", "args": ["mcp-server-fetch"]`, or an absolute path to
  a binary. Pin a version (`@modelcontextprotocol/server-everything@<version>`) for repeatable installs.
- Secrets belong in `env` or `headers`, filled from the plugin's settings (`{{settings.token}}`). Command lines are
  visible to other local users.
- A remote server needs no trust: use `"transport": { "type": "http", "url": "https://…/mcp" }`.
- You can also add a server without writing a plugin: open the builtin **MCP servers** plugin in the Plugins tab
  and press **Add server**.

See [Adding an MCP server](../../../docs/guides/adding-an-mcp-server.md).
