# Adding an MCP server

[Model Context Protocol](https://modelcontextprotocol.io) servers expose tools. harness-forge connects to them and
hands their tools to the model. The tools are named `mcp__<serverId>__<tool>` and use the same approval flow as any
other tool.

There are four ways to add a server:

| Way | Best for | Trust |
|---|---|---|
| [The MCP servers panel](#1-the-mcp-servers-panel) | your own servers, set up in the UI | stdio servers need a password confirmation (when a password is set) |
| [A declarative plugin](#2-a-declarative-plugin) | sharing a server setup as a folder, zip or npm package | stdio servers need trust |
| [A code plugin](#3-a-code-plugin) | servers that depend on settings or logic (`ctx.mcp.register`) | always (code plugin) |
| A project's `.mcp.json` (v1.7) | servers a repository needs, only in that project's chats | each server is approved in the project's review dialog; `${VARIABLES}` are stored per project ([hooks and project MCP servers](hooks-and-project-mcp.md#7-mcpjson-mcp-servers-of-a-project)) |

v1.8 adds two more sources: the MCP servers of a **Claude Code plugin** (its `.mcp.json` and the MCP servers of its
`plugin.json`; a stdio server runs only once the plugin is trusted: [Claude Code plugins](claude-code-plugins.md)), and
**Import from Claude Code**, which copies the
servers of your `~/.claude.json` into the MCP servers panel once (stdio servers arrive turned off:
[Import from Claude Code](claude-code-import.md)).

v1.9 (ADR-059 … ADR-061) uses more of the protocol: remote servers that need an account **sign in** with OAuth
([section 4](#4-sign-in-oauth-v19) and the [MCP sign-in guide](mcp-oauth.md)), a server's **prompts** become slash
commands ([section 5](#5-prompts-as-slash-commands-v19)), its **resources** can be attached with `@`
([section 6](#6-resources-in--mentions-v19)), and a server can **ask you for details** in a form while its tool runs
([elicitation](#elicitation-a-server-asks-you-v19)).

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
     - **HTTP** or **SSE**: the **URL** and headers (for example `Authorization: Bearer …`). v1.9: a server that
       needs an account can sign in instead of a token header; the collapsible **Sign-in (OAuth) · optional** section
       takes a pre-registered **Client ID**, **Client secret** and **Scopes** and shows the **Redirect URI** to
       register (section 4).
   - **Approval policy**: Safe, Ask (default) or Always ask. It applies to tools without annotations.
3. Save. For a stdio server, confirm your password when asked; the confirmation stays valid for 10 minutes.

Header and environment **values** are stored encrypted (scope `mcp:<id>`) and never shown again. An empty field
keeps the stored value when you edit the server. Each row shows the status: "Connecting…", "Connected · 12 tools",
"Error: …" or "Disabled", plus an enable switch, **Restart**, and **Edit** / **Delete**. v1.9 adds "Sign in required"
with a **Sign in** button, "Connected · 12 tools · Signed in", and **Sign out…** in the row's menu.

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
- v1.9 (plugin API 1.7.0): an HTTP or SSE server can name a pre-registered OAuth client instead of a token header,
  `"oauth": { "clientId": "{{settings.clientId}}", "scopes": "docs:read" }` inside `transport` (no client secret in a
  plugin); without it the server still signs in through dynamic registration when it supports that (section 4).
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

## 4. Sign in (OAuth, v1.9)

A remote server that answers "401 Unauthorized" and publishes MCP authorization metadata shows **Sign in required**
and a **Sign in** button: on its row in the MCP servers panel, on its plugin's page, or in the project's MCP servers
dialog for a `.mcp.json` server (after you approve it). **Sign in** opens the server's sign-in page in the same tab and
comes back through harness-forge's `/oauth/callback` page; the row then reads "Connected · {n} tools · Signed in".
Tokens are stored encrypted and refreshed by themselves; **Sign out…** forgets them.

- Only HTTP and SSE servers without an `Authorization` header sign in, and only when the server publishes its
  protected-resource metadata ("This server asked for sign-in but does not support OAuth." otherwise). A server whose
  `Authorization` header is answered with 401 reads "The server rejected its Authorization header." and offers
  **Edit…**: fix the header.
- A server that needs sign-in is never retried on a timer, and its tools are unavailable (also to sub-agents and
  background agents) until you sign in. Nothing ever asks you to sign in in the middle of a reply.
- Pre-registered clients, the redirect URI to register, `.mcp.json` `oauth`, Claude Code plugins and troubleshooting:
  [Signing in to remote MCP servers](mcp-oauth.md).

## 5. Prompts as slash commands (v1.9)

The prompts a connected server offers appear in the slash menu under **MCP** (after Plugins, before Skills), named like
Claude Code's: `/mcp__<serverId>__<prompt>` (sanitized like tool names, at most 64 characters). The row shows the
server's name and the prompt's arguments as a hint (`<required> [optional]`); the sent message carries the badge
"MCP · {server}".

```
/mcp__github__review_pr 42 main
/mcp__github__review_pr pr=42 base=main
```

- **Arguments** bind in the order the prompt declares them, or by name with `name=value`; quotes group words, and the
  last argument takes the rest of the line. A missing required argument ("Missing argument: pr. Usage:
  /mcp__github__review_pr <pr> [base]"), a server that is not connected (or needs sign-in: "Sign in to the MCP server
  "github" first."), a prompt the server does not list or a prompt that fails gives a reply that says so instead of a
  model answer. A `/mcp__…` name whose server harness-forge does not know is sent to the model as typed text.
- The prompt is fetched **once**, when you send it (the server has 30 seconds to answer), and the text it returns is
  kept with your message (at most 64 KB; a longer text is cut and ends with "[The MCP prompt was cut: it is longer
  than 64 KB.]"): a regenerate or a later turn reuses it and never asks the server again. Messages the prompt adds for the assistant
  are kept with their role; embedded text resources are inlined; images and other binary content become a one-line
  placeholder.
- A project's `.mcp.json` servers add their prompts only in that project's chats (a project server with the id of a
  global one replaces its prompts there). Servers that wait for approval or for a sign-in list no prompts. Opening the
  slash menu never starts a project server: an approved project server starts with the first reply that uses tools
  (as before), and its prompts appear in the menu from then on (before that, sending one of them answers that the
  server is not connected).
- The list follows the server: it is read when the server connects, when a stdio server announces a change, and again
  when the menu asks and the list is more than a minute old; the menu never waits for a server that is not
  connected.

## 6. Resources in `@` mentions (v1.9)

In every chat whose permission mode is not **Off**, `@` in the composer also lists the **resources** of your connected
servers (and, in a project chat, of the project's servers) in a section "MCP resources", under "Files in {project}"
when the chat has a project. Typing after `@` filters both.

- Picking a resource reads it once (the server has 60 seconds to answer) and attaches it to the message like an
  uploaded file (a chip under the composer); the text shows `@<serverId>:<uri>`, which is only a label: the
  attachment is what the model reads (a text resource is put into the message as text, like an attached text file).
- Text resources attach as text (several text parts are joined); binary resources only when they are an image or a PDF.
  A resource over 5 MB cannot be attached ("This resource is larger than 5 MB."; a resource whose listed size is
  larger is refused before it is read); a server that needs sign-in answers "Sign in to {server} first.".
- The "MCP resources" section shows only when one of the chat's servers offers resources. Like prompts, a project
  server's resources are listed only once a reply has started the server (the `@` menu never starts one).
- Resource templates (URIs with parameters) are not listed.
- v1.9 also makes tool results more readable: a tool result that returns a resource or a resource link reaches the
  model as text instead of raw JSON.

## Elicitation: a server asks you (v1.9)

While one of its tools runs, a server can ask you for details ("Which branch should I deploy?"). The tool's row then
reads "Waiting for your input" and a form card opens under it: "{server} needs more information", the server's message
as plain text, the fields it asks for (text, email, URL, date, number, yes / no, one or several choices; at most 20),
and the caution "Share only what you would give {server}. Never enter passwords here."

- **Submit** sends the values to the server and the tool continues; **Decline** answers no; the × ("Dismiss request")
  cancels. The sidebar shows "Needs your input" for the chat meanwhile, and a pill in the chat leads to the card when it
  is scrolled away.
- The card waits **8 minutes** (a countdown shows it); then the request is cancelled. **Stop**, deleting the chat, a
  master key rotation and a server stop cancel it too. Reloading the page shows the card again while the reply runs.
- The values you enter go only to the server: the saved tool result keeps the question, the field names and your answer
  (submitted, declined, cancelled), **never the values**. The finished tool row shows one line per request ("You
  answered {server}'s request.", "{server}'s request expired.", "Stopped before you answered.", …) with "Asked for:
  {fields}".
- Sub-agents and background agents never ask you: their servers' questions are declined automatically. A question
  harness-forge cannot tie to one chat (the server is busy in several chats at once) is declined too, and so is a form
  harness-forge cannot show (nested fields, a "URL mode" request).
- A `Notification` hook runs when a question waits (`notification_type` `elicitation_dialog`,
  [hooks](hooks-and-project-mcp.md)).
- Only stdio servers and HTTP servers that keep a session with streamed answers can ask; servers on MCP protocol
  `2026-07-28` cannot ask through harness-forge yet.

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

v1.9: an MCP tool call may take up to 10 minutes in total, but at most 60 s of that may pass without the server
answering while nobody is asked anything: the time a form card waits for you does not count.

MCP tools never have workspace access, so in the **Accept edits** mode of project chats (v1.3) they ask exactly as in
**Ask** mode. Annotations come from the server and are only hints. For a server you do not fully trust, set **Ask** on its tools:
in the tools table of the plugin detail page, each tool has an enable switch and an approval override (Default /
Allow / Ask / Deny) that wins over the policy. Checking **Always allow** on an approval card before **Allow** sets the
override to Allow.

## Connection settings and troubleshooting

The settings of the builtin **MCP servers** plugin apply to every MCP server:

- **Reconnect automatically** (default on): retries a failed or dropped connection with increasing delays, for up to
  about 9 minutes (v1.9: never a server that needs sign-in).
- **Connect timeout (seconds)** (5-120, default 20).

| Status or log line | What to check |
|---|---|
| `Error: … ENOENT` for a stdio server | the command is not on the server's `PATH` (the process sees only the minimal environment above); use an absolute path |
| `Error: … timed out` | the program is slow to start (first `npx` download) or never speaks MCP on stdout: raise the connect timeout, run the command by hand |
| `Error: … 401` / `403` | the token or headers; with `{{settings.*}}`, check the Configuration tab. v1.9: a 401 shows **Sign in required** instead and is not retried; with a token header, fix the token; to sign in instead, remove the header ([MCP sign-in](mcp-oauth.md#6-troubleshooting)) |
| **Sign in required** after working for a while | the sign-in expired or was revoked: press **Sign in** again |
| A prompt is missing from the slash menu | the server is not connected, needs sign-in or approval, or the prompt's name is not what you typed (`/mcp__<serverId>__<prompt>`; look under **MCP**) |
| No "MCP resources" in the `@` menu | the chat's permission mode is **Off**, or no connected server offers resources (templates are not listed) |
| The plugin is `untrusted` | its `plugin.json` changed; review it and press **Trust** |
| Connected, but the model never calls the tools | the chat's permission mode is **Off**, the model lacks tool support, or the tools are switched off |
| Tool names look cut | names longer than 64 characters are shortened, with a hash suffix to keep them unique |

Every connection attempt, error and stderr line is written to the owning plugin's **Logs** tab.
