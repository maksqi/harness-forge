# Adding an MCP server

[Model Context Protocol](https://modelcontextprotocol.io) servers expose tools. harness-forge connects to them and
hands their tools to the model. The tools are named `mcp__<serverId>__<tool>` and use the same approval flow as any
other tool.

There are three ways to add a server:

| Way | Best for | Trust |
|---|---|---|
| [The MCP servers panel](#1-the-mcp-servers-panel) | your own servers, set up in the UI | stdio servers need a password confirmation (when a password is set) |
| [A declarative plugin](#2-a-declarative-plugin) | sharing a server setup as a folder, zip or npm package | stdio servers need trust |
| [A code plugin](#3-a-code-plugin) | servers that depend on settings or logic (`ctx.mcp.register`) | always (code plugin) |

Transports:

| `type` | Connects to | Notes |
|---|---|---|
| `stdio` | a local program started by the server (`npx`, `uvx`, a binary) | runs on the server machine, so it needs trust |
| `http` | a Streamable HTTP endpoint (`https://…/mcp`) | redirects are rejected |
| `sse` | a legacy HTTP + SSE endpoint (`https://…/sse`) | for older servers |

Reference: [PLUGINS.md section 5](../PLUGINS.md#5-declarative-mcp-servers) · Runnable example:
[`mcp-everything`](../../examples/plugins/mcp-everything/).

## 1. The MCP servers panel

1. Open **Plugins** and the builtin plugin **MCP servers**. Its Overview is the panel.
2. Press **Add server** and fill in:
   - **Name** (shown on tool rows) and **Id**: a slug of up to 32 characters, unique across the panel and plugins.
     Tool names use it, so keep it short.
   - The transport tab:
     - **stdio**: **Command** (`npx`), the arguments one per line (`-y`, then `@modelcontextprotocol/server-everything`),
       and environment variables.
     - **HTTP** or **SSE**: the **URL** and headers (for example `Authorization: Bearer …`).
   - **Approval policy**: Safe, Ask (default) or Always ask. It applies to tools without annotations.
3. Save. For a stdio server, confirm your password when asked; the confirmation stays valid for 10 minutes.

Header and environment **values** are stored encrypted (scope `mcp:<id>`) and never shown again. An empty field
keeps the stored value when you edit the server. Each row shows the status: "Connecting…", "Connected · 12 tools",
"Error: …" or "Disabled", plus an enable switch, **Restart**, and **Edit** / **Delete**.

## 2. A declarative plugin

List the server under `contributes.mcpServers`. The server id must be the plugin id or start with `<pluginId>-`.

An HTTP server whose token comes from the plugin's settings (the token is entered once in the **Configuration** tab
and stored encrypted):

```json
{
  "manifestVersion": 1,
  "id": "acme-search",
  "name": "Acme search",
  "version": "1.0.0",
  "description": "Search the Acme knowledge base from the chat.",
  "engines": { "harness": "^1.0.0" },
  "permissions": ["network"],
  "settings": {
    "type": "object",
    "required": ["token"],
    "properties": {
      "token": { "type": "string", "format": "secret", "title": "Access token" }
    }
  },
  "contributes": {
    "mcpServers": [
      {
        "id": "acme-search",
        "name": "Acme search",
        "policy": "safe",
        "transport": {
          "type": "http",
          "url": "https://mcp.acme.example/mcp",
          "headers": { "Authorization": "Bearer {{settings.token}}" }
        }
      }
    ]
  }
}
```

A stdio server that gets its key through the environment:

```json
{
  "manifestVersion": 1,
  "id": "acme-files",
  "name": "Acme files",
  "version": "1.0.0",
  "description": "The Acme files MCP server, started locally.",
  "engines": { "harness": "^1.0.0" },
  "permissions": ["process"],
  "settings": {
    "type": "object",
    "required": ["apiKey"],
    "properties": {
      "apiKey": { "type": "string", "format": "secret", "title": "Acme API key" },
      "root": { "type": "string", "title": "Root folder", "default": "/srv/acme" }
    }
  },
  "contributes": {
    "mcpServers": [
      {
        "id": "acme-files",
        "name": "Acme files",
        "transport": {
          "type": "stdio",
          "command": "/opt/acme/bin/acme-mcp",
          "args": ["--root", "{{settings.root}}"],
          "env": { "ACME_API_KEY": "{{settings.apiKey}}" }
        }
      }
    ]
  }
}
```

- `{{settings.<key>}}` placeholders are allowed in `url`, header values, `args` items and `env` values. They are
  resolved when the server connects, and saving the settings reconnects the server. An empty value drops the header
  or env entry; an empty value in `url` or an argument fails the connection with a message naming the setting.
  `command` cannot contain placeholders.
- Put secrets in `env` or `headers`, never in `args`: command lines are visible to other users of the machine.
- A plugin with a stdio server needs trust. The pin covers `plugin.json`, so changing the command or its arguments
  makes it `untrusted` until it is trusted again. HTTP and SSE servers need no trust.
- Install the folder like any plugin: **Plugins** -> **Install…** -> **Local folder** -> Link or Copy. The plugin's
  detail page shows each server's status with a **Restart** button, and its tools.

## 3. A code plugin

`ctx.mcp.register(decl)` takes the same declaration as `contributes.mcpServers` and returns a `Disposable`, so a plugin
can connect, switch or drop servers at runtime. The **MCP bridge** code template does this: it registers the server
once a URL is set in the plugin's settings and follows settings changes.

```js
let server
const connect = (settings) => {
  server?.dispose()
  server = undefined
  if (typeof settings.serverUrl !== 'string' || settings.serverUrl === '')
    return
  server = ctx.mcp.register({
    id: 'my-bridge',
    name: 'My bridge',
    transport: { type: 'http', url: settings.serverUrl, headers: { Authorization: 'Bearer {{settings.token}}' } },
  })
}
connect(ctx.settings.get())
ctx.settings.onChange(connect)
```

## How the stdio process runs

- It starts without a shell, and stdin/stdout carry the protocol. The working directory is the plugin directory;
  for panel servers it is the private data folder of **MCP servers** (`data/plugins/.data/core-mcp/`).
- stderr lines go to the owning plugin's **Logs** tab: the plugin's own, or **MCP servers** for panel servers. On
  Windows stderr is ignored.
- It inherits only a minimal environment (`PATH`, `HOME`, `USER`, `SHELL`, `TERM`, `LOGNAME`) plus the declared
  `env`. The server's `HF_*` variables and provider keys are never passed on.
- It stops when the server or its plugin is disabled, reloaded or removed, and when harness-forge shuts down (stdin
  closed, then `SIGTERM`, then `SIGKILL`).
- `npx -y <package>` downloads the package on first start, which can take longer than the 20 s connect timeout on a
  slow network. Pin versions (`<package>@<version>`) for repeatable behavior.
- In the Docker image, `node`, `npm` and `npx` are available; Python launchers such as `uvx` are not, unless you
  build your own image.

## Tool approval

Each MCP tool gets a policy from its annotations first, then from the server's policy:

| Tool annotation | Policy | In **Ask** mode | In **Auto** mode |
|---|---|---|---|
| `readOnlyHint: true` | `safe` | runs | runs |
| `destructiveHint: true` | `always` | asks | asks |
| neither | the server's `policy` (default `ask`) | asks (`safe`: runs) | runs (`always`: asks) |

MCP tools never have workspace access, so in the **Accept edits** mode of project chats (v1.3) they ask exactly as in
**Ask** mode. Annotations come from the server and are only hints. For a server you do not fully trust, set **Ask** on its tools:
in the tools table of the plugin detail page, each tool has an enable switch and an approval override (Default /
Allow / Ask / Deny) that wins over the policy. Checking **Always allow** on an approval card before **Allow** sets the
override to Allow.

## Connection settings and troubleshooting

The settings of the builtin **MCP servers** plugin apply to every MCP server:

- **Reconnect automatically** (default on): retries a failed or dropped connection with increasing delays, for up to
  about 9 minutes.
- **Connect timeout (seconds)** (5-120, default 20).

| Status or log line | What to check |
|---|---|
| `Error: … ENOENT` for a stdio server | the command is not on the server's `PATH` (the process sees only the minimal environment above); use an absolute path |
| `Error: … timed out` | the program is slow to start (first `npx` download) or never speaks MCP on stdout: raise the connect timeout, run the command by hand |
| `Error: … 401` / `403` | the token or headers; with `{{settings.*}}`, check the Configuration tab |
| The plugin is `untrusted` | its `plugin.json` changed; review it and press **Trust** |
| Connected, but the model never calls the tools | the chat's permission mode is **Off**, the model lacks tool support, or the tools are switched off |
| Tool names look cut | names longer than 64 characters are shortened, with a hash suffix to keep them unique |

Every connection attempt, error and stderr line is written to the owning plugin's **Logs** tab.
