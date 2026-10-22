# Signing in to remote MCP servers (OAuth)

harness-forge v1.9 (ADR-059) signs in to remote MCP servers that use the authorization flow of the
[Model Context Protocol](https://modelcontextprotocol.io), the way Claude Code does: you press **Sign in**, the
server's own sign-in page opens, and you come back to the app with a connected server. It works for remote servers
(Streamable HTTP and SSE) of every origin: your own servers, plugin servers, Claude Code plugin servers and the servers
of a project's `.mcp.json`.

Reference: [ARCHITECTURE.md](../ARCHITECTURE.md) (the MCP sign-in flow and the security section),
[UI.md 2.20, 8.14](../UI.md) (the screens), [API.md](../API.md) (the `mcpAuth` routes),
[PLUGINS.md](../PLUGINS.md) (`transport.oauth` in plugins, plugin API 1.7.0). The basics of adding a server are in
[adding an MCP server](adding-an-mcp-server.md).

## 1. Sign in to one of your servers

1. Open **Plugins** → **MCP servers** → **Add server**, choose the **HTTP** (or **SSE**) tab and enter the server's
   **URL**. Leave the headers empty: a server with an `Authorization` header uses that header and never signs in.
2. Save. A server that needs sign-in answers its first request with "401 Unauthorized", and its row shows the status
   **Sign in required** with a **Sign in** button. Nothing else happens by itself: harness-forge never opens a sign-in
   page in the background and never retries such a server on a timer.
3. Press **Sign in**. The page goes to the server's sign-in page **in the same tab** (not a popup: popups are blocked
   on phones and after a slow request). Sign in there and allow access.
4. The server sends you back to `/oauth/callback` in harness-forge ("Finishing sign-in…"), which finishes the sign-in,
   shows "Signed in to {server}." and returns you to the page you started from.
5. The row now reads "Connected · {n} tools · Signed in", and the server's tools work in every chat.

A reply that was running when you left keeps running on the server; the chat resumes when you are back. When your
session expired while you were away (a password is set), the callback page first asks you to log in, then finishes the
sign-in.

What happens on the way, so you know what the server sees:

- harness-forge sends one request without a token to read the server's `WWW-Authenticate` answer, then reads its
  protected-resource metadata and its authorization server's metadata (discovery).
- It registers itself as a client of that authorization server (dynamic client registration), unless you entered a
  **Client ID** (section 2). It never registers a client in the background: only a click on **Sign in** does.
- It starts the sign-in with PKCE (S256), a one-time `state` value and the server's address as the `resource`. A
  sign-in link is valid for 10 minutes and works once; starting a new sign-in for the same server replaces the old one.
- The callback page removes the code from the address bar at once and sends it to the server together with your
  session. The authorization server's redirect is a cross-site navigation, so the browser does not send harness-forge's
  `SameSite=Strict` session cookie with it; the page's own request does.
- harness-forge exchanges the code for tokens, stores them encrypted and refreshes them by itself when they expire.

## 2. Pre-registered clients and the redirect URI

Some servers do not allow dynamic registration: you register an app (a "client") with the provider yourself and get a
client id (and sometimes a secret). Open the server's **Edit** dialog, HTTP or SSE tab, and expand **Sign-in (OAuth) ·
optional**:

| Field | What to enter |
|---|---|
| **Client ID** | the id of the app you registered with the provider |
| **Client secret** | only when the provider gave you one (write-only: it is never shown again; an empty field keeps the stored one). Your own servers only: plugins and `.mcp.json` cannot carry a secret |
| **Scopes** | the scopes the server documents, separated by spaces; empty = what the server asks for |
| **Redirect URI** | read-only, with **Copy**: register exactly this value with the provider |

The redirect URI is **the address you open harness-forge at** plus `/oauth/callback`, for example
`https://chat.example.com/oauth/callback` or `http://localhost:8787/oauth/callback`. It must match the registered
value exactly:

- `http://localhost:8787` and `http://127.0.0.1:8787` are different addresses; register the one you use (or both).
- Behind a reverse proxy it is the address the **browser** uses (`https://chat.example.com`), not the internal one.
  harness-forge has no "public URL" setting: it reads the address from each request, so the proxy must forward the
  `Host` header and `X-Forwarded-Proto` (README "Behind a reverse proxy").
- In development (`pnpm dev`) the browser is on `http://localhost:3000`, so the redirect URI is
  `http://localhost:3000/oauth/callback`.

Changing the server's URL, its transport type or the client id forgets the stored tokens (they belong to that server
and that client); renaming it or changing its policy keeps them.

## 3. Plugin servers and Claude Code plugin servers

A plugin's remote MCP servers sign in the same way. Their rows sit in the plugin's detail page (Overview → **MCP
servers**) with **Sign in**, and their tokens belong to the plugin (scope `plugin:<pluginId>`, name
`mcp-oauth.<serverId>`; plugin code cannot read them).

- A **harness plugin** (plugin API 1.7.0) declares a pre-registered client in `transport.oauth`; `{{settings.<key>}}`
  works in the client id:

  ```json
  {
    "id": "acme-docs",
    "name": "Acme docs",
    "transport": {
      "type": "http",
      "url": "https://mcp.acme.example/mcp",
      "oauth": { "clientId": "{{settings.clientId}}", "scopes": "docs:read" }
    }
  }
  ```

  Without `oauth` the server still signs in through dynamic registration when it supports it.
- A **Claude Code plugin** keeps the `oauth` object of its MCP servers (v1.8 dropped it with a note): the client id is
  used; `callbackPort` is ignored, because harness-forge signs in through its own callback page.

Uninstalling the plugin deletes its tokens (unless you keep its data).

## 4. Servers of a project's `.mcp.json`

A remote server of a project's `.mcp.json` can sign in too. The `oauth` key is optional; it names a pre-registered
client and scopes:

```json
{
  "mcpServers": {
    "docs": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "oauth": { "clientId": "harness-forge-docs", "scopes": "read" }
    }
  }
}
```

- **Approval first.** The server must be approved in the project's review dialog before it can sign in; a pending row
  shows **Review…**, never **Sign in**. After the approval the row in the project's **MCP servers** dialog (the
  project chip's menu in a chat → **MCP servers…**, or Settings → Projects) shows **Sign in required** and **Sign in**.
- A `clientSecret` is never read from a repository file. `callbackPort` (Claude Code's key) is ignored with the note
  that harness-forge signs in through its own callback page.
- The approval covers the whole server entry, `oauth` included: approvals made in v1.8 stay valid, and changing the
  `oauth` key makes the server pending again.
- The tokens belong to the project (scope `project:<projectId>`, name `mcp-oauth.<serverId>`) and are deleted with the
  project. A project server with the id of one of your global servers replaces it in that project's chats, sign-in
  included.

## 5. Tokens and signing out

- Tokens, the client registration and a client secret are stored **encrypted** in the server's secret store, bound to
  the server's address and client id. They never appear in an API answer, a log line, a chat or a backup zip.
- A master key rotation re-encrypts them; **Delete all data** keeps them (it deletes chats, not servers). Deleting the
  server, the plugin or the project deletes them.
- **Sign out…** (the row's `⋯` menu) asks "harness-forge forgets the tokens; the server stays configured." and then
  deletes the stored tokens and asks the authorization server to revoke them (best effort: a revocation that fails is
  not retried). The row goes back to **Sign in required**.
- `HF_OFFLINE=1` and `HF_SAFE_MODE=1` change nothing here (safe mode still starts the servers of the MCP servers panel,
  and no project server).

## 6. Troubleshooting

| What you see | What to check |
|---|---|
| **Sign in required** on a server that worked with a header | a 401 now means "sign in", not "retry later": the server is never retried with increasing delays. With a token header, check the token; to use sign-in instead, remove the `Authorization` header |
| No **Sign in** button | the server is stdio (only remote servers sign in), has an `Authorization` header, is disabled, or is a project server that still needs approval (**Review…**) |
| An error saying the server does not support sign-in (a 401 without OAuth metadata) | the server publishes no MCP authorization metadata; it expects a token header instead |
| The provider refuses the redirect URI | register the exact **Redirect URI** of the dialog (section 2). Many providers accept `http://` only for `localhost`: open harness-forge over HTTPS (a reverse proxy) or at `localhost` |
| The error card after the provider's page | it shows the provider's own message (for example `access_denied` when you declined); **Try again** starts a new sign-in, **Back to MCP servers** returns to the list |
| "This sign-in link was already used or expired." | a sign-in link works once and for 10 minutes, and a newer sign-in for the same server replaces it: press **Sign in** again |
| The sign-in stops before the provider's page | harness-forge refuses an authorization server on a private or local address (`10.x`, `169.254.169.254`, …) or over plain `http`, unless it is on the MCP server's own address, or both are on loopback (a local test server) |
| Signed in, later **Sign in required** again | the refresh token expired or was revoked (`invalid_grant`); sign in again |
| The server's questions never show up in the chat | servers on MCP protocol `2026-07-28` cannot ask questions through harness-forge yet; harness-forge connects them without that feature ([adding an MCP server](adding-an-mcp-server.md#elicitation-a-server-asks-you-v19)) |

Every sign-in step and failure is written to the owning plugin's **Logs** tab, without tokens, codes or secrets.
