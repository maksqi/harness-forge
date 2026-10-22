# Phase 14 — v1.9: MCP 2.0 and web search

Part of the harness-forge build plan. Progress is tracked in `docs/ROADMAP.md` (coordinator only). Shared names come
from `docs/DECISIONS.md` (ADR-059 … ADR-063, the amendment notes on ADR-008, ADR-012, ADR-017, ADR-024, ADR-034,
ADR-042 … ADR-046, ADR-048, ADR-050, ADR-052 and ADR-053, and the Phase 14 contract seed; it wins on conflict);
endpoints and DTOs from `docs/API.md` (the new schema sections for MCP sign-in and the auth info, MCP elicitation, MCP
resources and web search (planned 4.36 – 4.39), the chat setting, request body, summary, settings and catalog model
additions, the route sections for the modules `mcpAuth`, `chatElicitations`, `mcpResources` and `webSearch` (planned
5.37 – 5.40), the chat stream notes on the elicitation preliminary output and provider-executed search parts (planned
6.12), the conflict reason `needs-auth`, the notice `web-search-unavailable`, the two settings and the 141-route key
index; **C47 fixes the final numbers**); components, props, store and module signatures, routes, shortcuts and test ids
from `docs/UI.md` (the 2.20 wireframes, 5.5 the Settings nav "Web search", 6 routes (`/oauth/callback` with the `auth`
layout, `/settings/search`), 7.35 the chat additions (elicitation card, "Needs your input", sources chips, search rows),
8.14 MCP sign-in, 9.15 Web search settings, 10.10 contracts, 11.10 modules, 12 Alt+W, 13.14 the Phase 14 test ids, 14
accessibility, 15 copy); flows, tables and security rules from `docs/ARCHITECTURE.md` (the new flow sections for the MCP
OAuth sign-in, the elicitation live wait, MCP prompts and resources, web search resolution with the provider-executed
approval rule and the history stage, and the `core-search` request path with `safeFetch` POST (planned 6.39 – 6.43),
the stop order, backups and key rotation, the Phase 14 security section (planned 10.14), the log rules); plugin API
1.7.0 (the version rows, `ProviderDefinition.webSearch?`, `McpServerDecl.transport.oauth?`, the `elicitation_dialog`
notification type, the builtin `core-search`) from `docs/PLUGINS.md`; the native search matrix and the mock models
`mock:search` / `mock:search-tool` from `docs/PROVIDERS.md` (section 8, "MCP and search mocks (Phase 14)": the probe
contract); the user guides `docs/guides/mcp-oauth.md` and `docs/guides/web-search.md` (and the updated
`docs/guides/adding-an-mcp-server.md` and `docs/guides/hooks-and-project-mcp.md`). The UI.md, ARCHITECTURE.md,
PLUGINS.md and PROVIDERS.md sections and the guides are written by D19 in P14-0a, API.md by C47; W14.12 reconciles every
doc with the code in P14-B (the facts that change are listed under "Deviations found while building").

**Status (2026-10-22): in progress.** P14-00 is done: the six design reports of the planning session extracted into
`.tmp/p14-designs` (with `plan.md`, `README.md` and `agent-rules.md`), the baseline `pnpm check` on `8108c56` green with
**13815 tests** and `git status --porcelain` unchanged before and after, CI and the scheduled Audit on `8108c56` green,
the two ignored advisories (node-forge GHSA-86w9-cpqp-85rv, braces GHSA-vfj7-8cjw-p6xm) re-checked and unchanged,
`.tmp/v181` (a worktree of the `v1.8.1` tag, `27699db`) installed and built, the old `.tmp` content archived. P14-0a is
running (K1, C47, C48, C49, D18, D19, K3S). "Deviations found while building" and "Outcome" are filled in by the
coordinator at each gate.

Paths: `S` = `apps/server/src`, `W` = `apps/web/app`, `SH` = `packages/shared/src`, `SDK` = `packages/plugin-sdk/src`,
`P` = `node_modules/.pnpm/@ai-sdk+mcp@2.0.81_zod@4.6.7/node_modules/@ai-sdk/mcp/dist` (the server resolves `@ai-sdk/mcp`
**2.0.81**; 2.0.80 is installed too and has the same API). File:line references point at `main` = `8108c56` (checked
with `git show 8108c56:<path>`; they drift as the waves land: search for the named symbol).

## Goal

Ship v1.9: MCP 2.0 (sign-in for remote servers, prompts, resources, elicitation) and web search (the model's own search
tool and a builtin search tool with a BYOK backend), with plugin API 1.7.0, **no new dependency, no database
migration**, and every v1.8.1 data folder and approval intact.

- **OAuth for remote MCP servers** (ADR-059, amends ADR-012, ADR-017, ADR-024, ADR-034, ADR-050 and ADR-053): Streamable
  HTTP and SSE servers of every origin — personal servers, plugin servers, Claude Code plugin servers (their `oauth`
  object is kept instead of dropped, `S/plugins/claude/mcp.ts:199-202`) and project `.mcp.json` servers — sign in
  through `@ai-sdk/mcp`'s `auth()` (`P/index.d.ts:934`) with **one `OAuthClientProvider` per server**:
  protected-resource and authorization-server discovery, dynamic client registration or a configured `clientId` (+ a
  `clientSecret` for personal servers only) and `scopes`, PKCE S256, resource indicators, refresh. A 401, an
  `UnauthorizedError` or the connect mode's `McpAuthRequired` makes the server **`needs-auth`** (a new value of
  `mcpStatusSchema` (`SH/enums.ts:102`) and `projectMcpStateSchema` (`:317`); a permanent `auth_invalid { status: 401
  }`, **never retried with backoff**, tools unavailable also to sub-agents and background tasks, nothing prompts).
  Sign-in starts only from a click: **Sign in** → `POST …/oauth` answers `authorizationUrl` (null = already authorized)
  → a same-tab `location.assign` → the authorization server → the SPA page **`/oauth/callback`** (layout `auth`, no
  sidebar, so the `?code=` URL is never remembered) → the page strips the query and posts `POST /mcp/oauth/callback {
  state, code | error, iss? }` with the session cookie (the `SameSite=Strict` cookie,
  `S/http/middleware/session-auth.ts:72`, is not sent on the cross-site redirect but is sent on the page's own
  same-origin fetch) → `navigateTo(returnTo)`. The redirect URI is `<request Origin>/oauth/callback` (the Origin already
  passed `origin-check.ts:34-46`); pending flows live in memory (keyed by `state`, one per server, ≤ 20, 10 minutes,
  single use; a new start replaces the old one). The provider has three modes: **connect** (background connects: stored
  tokens only; `clientInformation()` throws `McpAuthRequired` when nothing is stored, so no registration ever happens in
  the background; `redirectToAuthorization` throws), **start** (a fresh state and code verifier on the flow; no
  `client_secret` on first use) and **callback** (client, secret and the authorization-server pin from the flow). A
  pre-sign-in probe sends one unauthenticated `initialize` POST and reads `WWW-Authenticate` (`resource_metadata`,
  `scope`). **A custom `fetch` is never passed to an MCP transport** (the SDK's own guard refuses private and loopback
  literals and pins DNS for every cross-origin OAuth URL only while it uses its own fetch);
  `validateAuthorizationServerURL` allows https, or the MCP server's own origin, or loopback → loopback; the
  authorization URL handed to the browser must be http(s); `redirect: 'error'` stays. Tokens live only in `SecretStore`:
  a record `{ v: 1, resource, clientId, client?, as?, tokens?: { …, obtainedAt } }` (ignored when `resource` or
  `clientId` no longer match) under `mcp:<id>` `oauth.record` + `oauth.clientSecret` (personal), `plugin:<pluginId>`
  `mcp-oauth.<serverId>` (plugin, incl. Claude Code plugins; plugin code cannot read it, `S/plugins/context.ts:276-285`)
  and `project:<projectId>` `mcp-oauth.<serverId>` (project); registered with the redactor, never in backups,
  re-encrypted by key rotation, kept by delete-all, removed with their server, plugin (unless `keepData`) or project; no
  new secret scope. Configuration: personal http / sse input and update `oauth?: { clientId?, scopes?, clientSecret? }`
  (a null secret keeps the stored one; `PATCH /mcp/:id` keeps the OAuth secrets unless the URL, the type or the client
  id changed, `S/mcp/user-servers.ts:186-195`), the plugin declaration `transport.oauth?` (`{{settings.x}}` allowed in
  `clientId`), `.mcp.json` remote servers `oauth { clientId, scopes }` (`callbackPort` → an info diagnostic "signs in
  through its own callback page"; the trust hash of v1.8 items is unchanged, so every v1.8.1 approval stays valid).
  Sign-in is refused (400) for stdio servers and servers with an `Authorization` header, 409 `disabled` for a disabled
  server and 409 `untrusted` for a pending project server. Sign out = delete the record + a best-effort RFC 7009
  revocation through `safeFetch` POST. `HF_OFFLINE` and `HF_SAFE_MODE` are unchanged. Upgrade note: a server that used
  to answer 401 to a bad header now shows `needs-auth` instead of retrying.
- **MCP elicitation — the first live wait** (ADR-060, amends ADR-043, ADR-046 and ADR-048): the MCP client advertises
  `capabilities: { elicitation: {} }` and hands `onElicitationRequest` (`P/index.d.ts:1236`; the handler gets no request
  id and no tool-call link) to a broker (`deps.elicitations`). **Attribution**: every MCP client keeps a registry of its
  in-flight calls; when all of them belong to one chat and to the main agent, the oldest call gets the card; calls from
  several chats (`ambiguous`), a sub-agent or background call or no call in flight (`not-interactive`) → `decline`.
  Unsupported schemas or URL mode → `decline` (`unsupported`). A server that negotiates protocol `2026-07-28` reconnects
  once without the capability (remembered per server; the SDK cannot elicit there, `P/index.js:2617`). **The card
  travels in the tool part**: the MCP tool's `execute` becomes an async generator whose preliminary output is `{ status:
  'input-required', elicitation }` (re-yielded every 25 s as a keep-alive; a reload replays it through the run's resume
  buffer, `S/chat/runs.ts:123-165`), then `{ status: 'running' }`; no new data part and no new SSE event. The answer is
  `POST /chat/:id/elicitations/:elicitationId`, validated against the restricted schema (≤ 20 fields: string with min /
  max length and format email · uri · date · date-time, number / integer with minimum / maximum, boolean, a single enum
  (`enum` / `enumNames` / `oneOf`), a multi-select array of an enum); a wait ends after 480 s with `cancel` (reason
  `timeout`); Stop, chat delete, key rotation and shutdown → `cancel` (reason `stopped`). MCP tools get a 600 s outer
  timeout and a pausable 60 s active budget (waiting excluded). The stored final output keeps `{ id, message, fields
  (names), action, reason }` — **never the values**. `ChatSummary.awaitingInput?` (live, through `chat.updated`) drives
  the sidebar's "Needs your input"; a `Notification` hook fires with `notification_type: 'elicitation_dialog'`.
  **Approvals still end the run**; sub-agents and background tasks never elicit.
- **MCP prompts as slash commands and MCP resources in `@` mentions** (ADR-061, amends ADR-042, ADR-044, ADR-045 and
  ADR-052): prompts of connected servers are commands **`/mcp__<serverId>__<prompt>`** (sanitized and capped like
  `mcpToolName`, `SH/ids.ts:393`; `MCP_PROMPT_NAME_PATTERN = /^mcp__[\w-]{1,59}$/` is accepted next to
  `catalogNameSchema` by `commandInvocationSchema.name`, `commandSummarySchema.name` and `parseSlashCommand`); `GET
  /commands` lists them with `source: 'mcp'`, `mcpServer { id, name }` and the hint `<required> [optional]`; project
  servers only in that project's chats (a project server shadows a global id); arguments bind positionally in declared
  order or as `name=value` (the last argument takes the rest); `prompts/get` runs **once** and its result is frozen into
  `metadata.command.expansion` (≤ 64 KB; user-only text joined; with assistant messages each wrapped `<prompt-message
  role="…">`; embedded text resources → `<resource uri mimeType>` blocks; images, blobs and links → one-line
  placeholders); a missing required argument or a server that is not connected → a `failed` reply; regenerate never
  calls the server; the cache is filled on connect, on stdio `prompts/list_changed` and on a listing when older than
  60 s; `customization.changed { kind: 'command' }` on a change. **Resources**: `@` in every chat with tools on lists
  the resources of connected global servers (+ the project's servers in project chats; templates are out) through `GET
  /mcp/resources?projectId&q&limit` → `{ items, truncated, unavailable }`; a pick calls `POST /mcp/resources/attach {
  serverId, uri, projectId? }` → a `FileRef` upload (≤ 5 MiB, 413 above; text → `text/plain` or the server's `text/*`;
  binary only images and PDF; several text contents joined); the text shows `@<serverId>:<uri>` (display only;
  `formatResourceMention` / `parseResourceMention` in `SH/util/mentions.ts`; every file-mention golden test unchanged).
  Small extra: `resource` / `resource_link` items in tool results become readable text (`S/mcp/content.ts`).
- **Provider-native web search and plugin API 1.7.0** (ADR-062, amends ADR-008): `ProviderDefinition.webSearch?(model, {
  functionTools, maxUses })` → `{ tools?, providerOptions?, exclusive? } | undefined` (synchronous, no I/O, called
  inside try / catch like `reasoning`, `SDK/types.ts:151`; the host accepts only tools with `type === 'provider'` whose
  key does not collide with a function tool). Builtins: Anthropic `web_search` = `webSearch_20250305({ maxUses: 5 })`
  (the dynamic-filtering versions are backlog), OpenAI `webSearch({})` (a deny-list of old ids), Google `google_search`
  = `googleSearch({})` (Gemini 2.x → `exclusive: true`, Gemini ≥ 3 normal), xAI `webSearch({})` (deny `grok-2*` /
  `grok-3*`), OpenRouter `tools.webSearch({ maxResults: 5 })` (models without tools → `plugins: [{ id: 'web',
  max_results: 5 }]` through `providerOptions.openrouter`), Groq `browser_search` for `GPT_OSS` models only; Mistral,
  DeepSeek, Z.ai, MiniMax, Moonshot, Alibaba and Ollama: none. The catalog model DTO gains `webSearch: 'native' |
  'exclusive' | null` (computed in `S/catalog/merge.ts` by probing the hook with `{ functionTools: 0 }`; not a
  `capabilities` flag). At the very top of `createToolApproval` (`S/chat/approval.ts:372`) a call whose name is in
  `nativeTools` **and** whose `providerExecuted === true` is `not-applicable` (no hooks, no records); a native name
  without `providerExecuted` is denied; unknown names stay denied (`:416-418`). No `PreToolUse`, `PostToolUse` or
  `PermissionRequest` runs for provider-executed calls. History keeps provider-executed parts only when the message's
  provider is the current provider (else they are removed before `toolPartsAsText`). No fee accounting (the UI says
  native search fees are billed by the provider; OpenRouter's reported cost includes them).
- **Per-chat web search mode, one resolver and the builtin `search_web`** (ADR-063): the chat setting `webSearch:
  'off' | 'auto'` (request body `webSearch?`; body > chat > global) and the global settings `webSearchDefault` (`'off'`)
  and `webSearchNative` (`true`); **one pure resolver** `resolveWebSearch` (`SH/util/web-search.ts`) used by the server
  and the composer: off → off; tool mode `off` → unavailable `tool-mode-off`; native and preferred → native; an
  exclusive native model with no other function tool this turn → native; the builtin is available and the model has
  tools → builtin; else unavailable (`tools-conflict` / `tools-unsupported` / `no-backend`). Plan, Accept edits, Ask and
  Auto all allow search (read-only); sub-agents (background included) inherit the mode, resolved for the child's model;
  **native and builtin search are never offered in one request**; the notice `web-search-unavailable` (info, once per
  chat / model / reason). The builtin plugin **`core-search`** (loaded after `core-tools`) registers the tool
  **`search_web`** (never `web_search`: Anthropic's server tool always uses that wire name, so a function tool of that
  name in a history next to a declared server tool is a likely 400) only while the selected backend has a key
  (`ctx.settings.onChange`). Settings `backend: brave | tavily | exa` (default `brave`), `braveApiKey` / `tavilyApiKey`
  / `exaApiKey` (`format: 'secret'`, scope `plugin:core-search`), `maxResults` 1 – 10 (5). Input `{ query 1..400,
  count? 1..10, freshness?: day | week | month | year }`; output `{ query, backend, results: [{ title ≤ 300, url http(s)
  ≤ 2048, snippet ≤ 800, published | null }] }` ≤ 32 KB. Requests go through `createPluginSourceFetch` (https only + the
  `HF_TEST_REMOTE_URL` reroute, `S/security/ssrf.ts:728`): 10 s, 1 MB, no redirect; 401 / 403 → `provider_error` "key
  rejected" (the key is never echoed), 429 → `rate_limited`, network → `provider_unreachable`. Policy `safe` (the toggle
  is the consent; tool preferences can still ask or deny). `HF_OFFLINE` does not block it. A pipeline transform after
  `generatedFiles` turns every final `search_web` output into `source-url` chunks (deduplicated, http(s) only), so
  sources reach the saved message, shares and exports. `POST /web-search/test { backend? }` → `{ ok, backend, results,
  ms }`.
- **`safeFetch` POST** (with ADR-063): `SafeFetchOptions.method` gains `'POST'` and `body?: string | Uint8Array` (POST
  only, ≤ 64 KB, `content-length` set); a POST never follows a redirect (the 3xx is returned); the SSRF guard and DNS
  pinning are unchanged (`S/security/ssrf.ts:579` refuses everything but GET / HEAD today); the fake remote serves POST
  for `serve()` routes and records the bodies. Complete and frozen in P14-0b.
- **Plugin API 1.7.0** (additive): `ProviderDefinition.webSearch?` with `WebSearchRequest { functionTools, maxUses }`
  and `WebSearchParams { tools?, providerOptions?, exclusive? }`, `McpServerDecl.transport.oauth?`, the `notification`
  code hook's `type` gains `'elicitation_dialog'` (`SDK/types.ts:542`); `SDK/version.ts` 1.7.0, the template mirror
  `S/plugins/templates/sdk-types.ts` and the examples' `harness-forge.d.ts` follow; `^1.6.0` plugins keep loading.
- **No migration**: `McpTransportRecord` (`S/db/schema.ts:74`) gains a TypeScript-only `oauth?` (the column is JSON);
  `db:generate` reports no changes; 23 tables; the latest migration stays `0009`.

Out of scope (ROADMAP backlog): MCP Apps (interactive UI from MCP servers), an MCP Registry browser, deferred tool
loading (tool search), MCP resource templates, inline citations, Anthropic's dynamic-filtering web search versions
(`webSearch_20260209` / `20260318`), native search fee accounting, elicitation URL mode, elicitation for servers on
protocol `2026-07-28` (multi round-trip requests), a SearXNG backend, Mistral conversation-API search, and running the
live provider suite for web search and MCP OAuth with real keys (the user's). Kept as documented behavior: the redirect
URI is the request's origin (there is no public-URL setting; a reverse proxy must forward the browser's host and scheme,
ADR-026; an authorization server may refuse an `http` LAN origin or a client pre-registered with another redirect URI —
the dialog shows the redirect URI with Copy); approvals still end the run; a server that answers 401 to its
`Authorization` header is `needs-auth` and cannot sign in (fix the header); stateless JSON-only HTTP servers cannot
elicit (server-to-client requests need a session with SSE responses); requests the server cannot attribute are declined;
MCP tools have a 600 s outer timeout (60 s active); Groq search has no citations; Gemini 2.x native search runs only in
turns without function tools; Anthropic's `pause_turn` is mapped to `stop`; `encryptedContent` of provider-executed
search parts is stored in messages and backups but stripped from shares and exports; native search fees are not counted;
`HF_OFFLINE` blocks neither MCP connections nor `search_web`.

Totals after Phase 14: routes 132 → **141** (`mcpAuth.start` `POST /mcp/:id/oauth`, `mcpAuth.signOut` `DELETE
/mcp/:id/oauth` (→ `McpServer`), `mcpAuth.projectStart` `POST /projects/:id/mcp/:serverId/oauth`,
`mcpAuth.projectSignOut` `DELETE /projects/:id/mcp/:serverId/oauth` (→ `ProjectMcpServer`), `mcpAuth.callback` `POST
/mcp/oauth/callback` (session + Origin check), `chatElicitations.answer` `POST /chat/:id/elicitations/:elicitationId`,
`mcpResources.list` `GET /mcp/resources`, `mcpResources.attach` `POST /mcp/resources/attach` (201, a `FileRef`),
`webSearch.test` `POST /web-search/test`), route modules 36 → **40** (`mcpAuth` 5, `chatElicitations` 1, `mcpResources`
2, `webSearch` 1; files `mcp-auth.ts`, `chat-elicitations.ts`, `mcp-resources.ts`, `web-search.ts`), routes with `fresh:
true` **14** (none new), public routes unchanged; SSE types **19** (unchanged; `chat.updated` carries `awaitingInput`);
settings keys 32 → **34** (`webSearchDefault`, `webSearchNative`); tables **23**, migration **none** (latest `0009`);
conflict reasons 15 → **16** (`needs-auth`); notice codes 11 → **12** (`web-search-unavailable`); error codes **16**, UI
data part types **6** and hook events **13** unchanged (`Notification` gains the type `elicitation_dialog`); mock models
18 → **20** (**`mock:search`**, **`mock:search-tool`**); builtin plugins + **`core-search`** (tool `search_web`); id
prefix **`eli_`** (elicitations, memory only); plugin API **1.7.0** (additive); `LIMITS` (Phase 14 group)
`mcpElicitationWaitMs` 480 000, `mcpToolActiveMs` 60 000, `mcpOAuthFlowMs` 600 000, `mcpOAuthFlowsMax` 20,
`mcpPromptsMax` 200, `mcpPromptArgumentsMax` 20, `mcpResourcesMax` 1000, `mcpResourceReadBytes` = `mentionFileMaxBytes`
(5 MiB), `mcpReturnToMaxChars` 512, `searchWebOutputBytes` 32 768, `searchWebFetchBytes` 1 048 576, `searchWebTimeoutMs`
10 000, and the util constant `WEB_SEARCH_MAX_USES` 5; the test-only environment variable **`E2E_FAKE_REMOTE_PORT`**
(the e2e fake remote for Brave / Tavily / Exa); about **45** new test ids (UI.md 13.14); ADR-059 … ADR-063; **no new
dependency** (`@ai-sdk/mcp` 2.0.81, the installed `@ai-sdk/*` providers, `@modelcontextprotocol/sdk` 1.32.1 as a root
dev dependency for fixtures, and Node built-ins). Agents: 5 (P14-0a: C47, C48, C49, D18, D19; plus the seed agent K3S) +
5 (P14-0b: C50, C51, C52, C53, C54; plus the upgrade-probe agent G14B) + 10 (P14-A: W14.1 – W14.10; plus the gate-probe
agent G14P) + 2 (P14-B: W14.11, W14.12; W14.13 / W14.14 only for red items; plus the Docker probe agent G14D) = 22 (26
with the probe and seed agents, 28 with the fix-ups), in the Phase 5 wave method (ADR-016).

## Entry criteria

- v1.8.1 is on `main` and pushed (`origin/main` = `8108c56` `docs: close the v1.8.1 roadmap and keep the ubuntu-24.04
  runners`; the release tag `v1.8.1` is on `27699db`; CI and the scheduled Audit are green; no open pull request): `pnpm
  check` (13815 tests), `pnpm build` and e2e 215 passed.
- P14-00 is done (see "Wave P14-00"): the baseline recorded (`.tmp/gates/P14-00/{status-before,check,status-after}.*`),
  `.tmp/v181` built, the advisories re-checked, `.tmp` archived.
- The approved plan and the design inputs exist in `.tmp/p14-designs/` (`plan.md`, `README.md`, `agent-rules.md`,
  `server-mcp.md`, `server-search.md`, `web-waves.md`, `explore-{mcp,search,ui}.md`; the "Reconciliation" table and the
  "Totals" of `plan.md` and the deviations listed in `README.md` are binding and win over the reports).
- K1 is done: DECISIONS.md carries ADR-059 … ADR-063, the amendment notes and the Phase 14 contract seed (the id `eli_`;
  the enumerations `mcpStatus` + `needs-auth`, project MCP state + `needs-auth`, command source + `mcp`, web search
  modes `off | auto`, model web search `native | exclusive`, backends `brave | tavily | exa`, the unavailable reasons,
  the elicitation actions `accept | decline | cancel` and reasons `user | timeout | stopped | not-interactive |
  ambiguous | unsupported`; the conflict reason `needs-auth` (16); the notice `web-search-unavailable` (12); the four
  HTTP module rows `mcp-auth.ts`, `chat-elicitations.ts`, `mcp-resources.ts`, `web-search.ts` that `routes.test.ts`
  reads (141 / 40, fresh 14); SSE 19; the chat request `webSearch?`; the 34 settings; 23 tables and no migration
  (`mcp_servers.transport` may carry `oauth`); the OAuth secret names per origin; the builtin `core-search` and the tool
  name `search_web`; the mocks (20); the `LIMITS`; health `pluginApiVersion` 1.7.0; the test-only
  `E2E_FAKE_REMOTE_PORT`); ROADMAP.md has the Phase 14 section and the updated backlog; AGENT.md has the "Plugin API
  1.7.0" and "MCP 2.0 and web search" facts, the environment variable and the Phase 14 freeze line.
- K2 is done: no new dependency; the `start:e2e` change is deferred to K4 (P14-0b).
- The contract skeletons exist: `SH/util/{mcp-elicitation,mcp-prompts,web-search}.ts` (final names and signatures,
  bodies throw until C48 / C49 implement them) and their three export lines in `SH/index.ts`. (`SH/schemas/mcp.ts` is
  not a skeleton: C47 creates it.)

## Exit criteria

- Every Phase 14 item in `docs/ROADMAP.md` is checked; every wave gate is green; the final checkpoint commit `chore:
  final gate for harness-forge v1.9` exists (pushed, and tagged `v1.9.0`, only when the user asks).
- Every `package.json` carries version **1.9.0**; `pnpm check` and `pnpm build` are green; the built-page CSP test
  passes with `HF_TEST_REQUIRE_WEB_BUILD=1`; `pnpm db:generate` reports no changes.
- `pnpm test:e2e` (projects `chromium` + `mobile` + `tablet`, OS color scheme emulated as light) is green 3× in a row,
  including the new specs `core/web-search`, `core/mcp-elicitation`, `core/mcp-prompts`, `core/mcp-resources`,
  `core/settings-search`, `plugins/mcp-oauth` (incl. a run with a password: the callback completes with the session
  cookie), `mobile/web-search`, `mobile/elicitation`, `mobile/mcp-oauth`, the extended `core/project-mcp` and the tablet
  touch-target spec (the 30-minute CI e2e budget holds); the `@screenshots` run (dark + light) was reviewed; the README
  images come from the `@readme` full-frame shots.
- The gate probes (Gate P14-A, repeated at the final gate on a fresh `.tmp/e2e`) and the regressions (the coordinator's
  copy of the P12-A probes with relaxed pins `.tmp/gates/P14-A-p12a-regression/`, the P11-A and P10-A copies
  `.tmp/gates/P12-A-p11a-regression/` and `.tmp/gates/P12-A-p10a-regression/p10a-regression.mjs`, `node
  .tmp/gates/P9-A/probe.mjs`, `node .tmp/gates/P8-A/probe.mjs ws git`) are green.
- CI on `main` is green on `ubuntu-24.04` (`check`, `e2e`, `docker`, `audit`, `actionlint`); `pnpm audit --prod
  --audit-level high` is clean (the two ignored advisories excepted, re-checked).
- **Upgrade**: a v1.8.1 data directory (seeded by the `.tmp/v181` build) boots on v1.9 with every chat, secret, share,
  project, rule, definition, hook, approval, style and background task intact: no migration applied (10 tags),
  `integrity_check` / `foreign_key_check` clean, the stored messages byte-identical; **every v1.8.1 approval still
  matches** (the `.mcp.json` server with `oauth` included) and nothing new runs before approval; the seeded `oauth`
  project server and the Claude plugin OAuth server are `needs-auth` without a retry loop, and signing in to the seeded
  `oauth` server works; chats without `webSearch` search `off`; the v1.8.1 backup restores.
- **Docker** (Node 24 alpine, uid 1000; daemon permitting, else the CI `docker` job): the callback works through the
  container's origin; OAuth tokens and search keys are stored encrypted (no plain value in the data directory); the
  OAuth fixture signs in as uid 1000; `docker stop` leaves no orphan.
- `pnpm test` never calls a paid API or a real MCP, OAuth or search host, never touches the repository's `data/` or a
  folder outside a temp directory, leaves `git status --porcelain` of the repository unchanged, creates no `.claude/`,
  `.harness/`, `.claude-plugin/` or `.mcp.json` anywhere in the repository, uses loopback only and leaves no fixture
  process behind; `pnpm test:live` stays the user's.
- README status reads "v1.9".

Manual acceptance (coordinator, `HF_MOCK_PROVIDER=1 pnpm dev` + the OAuth fixture script on a loopback port):

- Plugins → MCP → add the fixture URL → "Sign in required" → **Sign in** → the fixture's approve page → back in the app
  "Signed in to {server}." → the tools are listed.
- A chat with `mock:hooks` and `call mcp__fixture__ask {}` shows the form card; **Submit** returns the answer to the
  tool (`ask_echo` shows it arrived; the stored message holds no value).
- `/` lists the MCP group; `/mcp__fixture__greet Ada` expands.
- `@` lists the fixture's resources and attaches one.
- The composer **Search** toggle with `mock:search` shows sources.
- Settings → Web search saves a key (write-only) and **Test search** answers against the fake remote.
- 390 px: the elicitation card, the toggle and the callback page fit.
- A v1.8.1 data directory boots on v1.9 intact (no migration, every approval valid, nothing new run before approval).

With real keys and network (the user, optional): sign in to a real OAuth MCP server (a hosted GitHub or Linear MCP
server), native search on Anthropic / OpenAI / Gemini, `search_web` with a Brave / Tavily / Exa key, `pnpm test:live`.

## Steps

| Step | Owner | Output |
|---|---|---|
| P14-00 | coordinator | design reports → `.tmp/p14-designs` (+ `README.md` reconciliation, `agent-rules.md`); baseline `pnpm check` 13815 + `git status --porcelain` before / after; CI on `8108c56` green; advisories re-checked; `.tmp/v181` worktree of `v1.8.1` installed and built; old `.tmp` content archived; memory |
| P14-0a | coordinator (K1, K2, contract skeletons, K3 seed by K3S) + C47, C48, C49, D18, D19 | decisions, ROADMAP, AGENT.md; every shared contract + plugin SDK 1.7.0 + 501 stubs + API.md; the shared helpers (complete); this file; every other doc; the v1.8.1 upgrade seed |
| Gate P14-0a | coordinator | audit, frozen install (`pnpm why typescript`), check, build (web entry size vs `.tmp/v181`), CSP test, `pluginApiVersion` 1.7.0, 9 new routes mounted, e2e 215, `pnpm audit`, examples' `.d.ts`, commit |
| P14-0b | coordinator (K4) + C50, C51, C52, C53, C54, G14B | server skeleton + `safeFetch` POST (complete), MCP seams (complete), chat seams (complete), mocks + fixtures + fakes (complete), web skeleton, upgrade probe, FREEZE |
| Gate P14-0b | coordinator | audit, `db:generate` no changes, `nuxi prepare`, check, build, CSP test, e2e 215 on a fresh `.tmp/e2e` (now with the fake remote), v1.8.1 upgrade probe + seam no-op probe (G14B), FREEZE, commit |
| P14-A | W14.1 – W14.10 + G14P (one launch) | features + gate probes |
| Gate P14-A | coordinator (+ W14.13 / W14.14 for red items) | CCR batch, `nuxi prepare`, check, build, CSP, G14P probes + the P12-A / P11-A / P10-A copies, P9-A, P8-A regressions, e2e 215, screenshots of the new screens, audit, commit |
| P14-B | W14.11, W14.12 (+ W14.13 / W14.14 only if needed), G14D | feature e2e, screenshots, docs reconciliation, Docker probe |
| Final gate | coordinator | e2e ×3, v1.8.1 → v1.9 upgrade, Docker, audit, hermetic `pnpm test`, version 1.9.0, ROADMAP, memory, commit |

## Design inputs and open points

Binding order of the design inputs: `.tmp/p14-designs/plan.md` (its "Reconciliation" table and "Totals") >
`docs/DECISIONS.md` (after K1) > this file (after D18) > the design reports (`server-mcp.md`, `server-search.md`,
`web-waves.md`, `explore-{mcp,search,ui}.md`). The reports are superseded where the plan and
`.tmp/p14-designs/README.md` disagree with them. The replaced report items, for agents who read the reports for depth
(the list of `README.md`, refined):

- **All reports — the counts**: 9 new routes in 4 modules (`mcpAuth` 5: start, signOut, projectStart, projectSignOut,
  callback; `chatElicitations` 1: answer; `mcpResources` 2: list, attach; `webSearch` 1: test) → **141** routes / **40**
  modules / **14** fresh routes, none public (server-mcp.md's 140 / 39 is superseded); **19** SSE types (web-waves.md's
  `elicitation.changed` is superseded); **34** settings (server-mcp.md's "settings: none" is superseded by the search
  workstream); **12** notices; **16** conflict reasons; **20** mocks (server-mcp.md's "mocks stay 18" and web-waves.md's
  `mock:mcp` are superseded: the MCP paths use `mock:hooks` / `mock:echo` and the OAuth fixture); **no migration**
  (web-waves.md's "decide on `0010`" is settled: none; latest `0009`, 23 tables); id `eli_`.
- **All reports — the ADRs**: five ADRs with the plan's amendment lists: ADR-059 MCP OAuth (amends ADR-012, ADR-017,
  ADR-024, ADR-034, ADR-050, ADR-053), ADR-060 MCP elicitation (ADR-043, ADR-046, ADR-048), ADR-061 MCP prompts and
  resources (ADR-042, ADR-044, ADR-045, ADR-052), ADR-062 provider-native web search and plugin API 1.7.0 (ADR-008),
  ADR-063 the per-chat mode, the resolver and `search_web`. server-mcp.md's separate prompts / resources ADRs are merged
  into ADR-061; server-search.md's ADR-S1 / S2 / S3 are ADR-062 / ADR-063 (S3 merged into ADR-063); web-waves.md's
  numbering is superseded.
- **server-mcp.md**:
  - Its first-cut list is merged into the plan's single list (see "Risks").
  - `S/testing/{create-test-app,fake-project-mcp}.ts` in P14-0b are C50's; the `safeFetch` POST type change is C50's
    (complete); `mcp/__fixtures__/harness.ts` (generators drained) is C51's; the OAuth fixture is C53's.
  - "Not touched: `chat/tools.ts`" holds: the streaming path of an async-generator `execute` already exists
    (`S/chat/tools.ts:520-630`); the 600 s outer timeout is the MCP tool definition's `timeoutMs` (`clampToolTimeout`,
    `:136-140`).
- **server-search.md**:
  - No `S/services/search` folder and no `search:` secret scope: the backend keys are `core-search` secret settings
    (`plugin:core-search`, `settings.<key>`); its Brave-only fallback (cut 6) is superseded by the plan's cut list (Exa
    is the last cut).
  - The tool name `search_web` is final ("if the user insists on `web_search`" is moot).
- **web-waves.md**:
  - Status value `needs-auth` (kebab), not `needs_auth` (test-id values and the `MCP_STATUS_*` maps included).
  - **Elicitation transport**: no transient `data-elicitation` chunk, no `elicitation.changed` SSE event, no
    pending-list GET and no end-of-message card for unattributed requests (they are declined on the server); the card
    data is the MCP tool part's preliminary output; `TOOL_ELICITATIONS` has no `unlinked()`; `useChatSession` derives
    pending elicitations from the running tool parts (never a fetched list).
  - Helper names are the skeletons' (final): `parseElicitationForm`, `elicitationMessageText`,
    `validateElicitationAnswer`, `isSensitiveField`, `elicitationInitialValues`, `coerceElicitationValue`
    (`SH/util/mcp-elicitation.ts`); `resolveWebSearch`, `isProviderExecutedPart`, `sourceDomain`,
    `SEARCH_WEB_TOOL_NAME`, `WEB_SEARCH_MAX_USES` (`SH/util/web-search.ts`); `mcpPromptCommandName`,
    `isMcpPromptCommandName`, `mcpPromptArgumentHint`, `bindMcpPromptArguments` (`SH/util/mcp-prompts.ts`).
    web-waves.md's `elicitationFormModel`, `validateElicitationContent`, `webSearchAvailability()` and
    `PendingElicitation` map to these and to the DTO `McpElicitation` (`SH/schemas/mcp.ts`).
  - Agent numbering and globs are the plan's: its W14.8 oauth-callback-web is merged into W14.7 mcp-web; W14.9 → W14.8
    composer-web, W14.10 → W14.9 transcript-web, W14.11 → W14.10 settings-web, W14.12 e2e → W14.11, W14.13 docs →
    W14.12, fix-ups W14.13 (server) / W14.14 (web). W14.1 does **not** own `S/mcp/{index,project,errors}`: they are
    C51's complete seams, frozen in P14-A; W14.2 does not own `S/chat/{prepare,context}`; the search modules are
    `S/chat/search/**` (not `S/chat/web-search/**`, no `S/providers/**`, no `S/services/search/**`); the route file is
    `web-search.ts`.
  - "K2 wires the fake search remote into `start:e2e`" → K4 in P14-0b; C51's "fetch hook in the http / sse transports"
    is rejected (never a custom `fetch`); C52's `data-elicitation` and "`web_search` in `byName`" are superseded.
  - The settings backend select has no "None" (the setting is an enum of three; without a key the builtin is
    unavailable, open point 7).
  - `useMcpSignIn` calls the start route directly (no Phase 14 route is fresh).
- **explore-{mcp,search,ui}.md** are facts at `8108c56` (explore-mcp.md's `P` path names 2.0.80; the server resolves
  2.0.81, the API is identical).

Plan-level decisions (from the reports, kept by the plan):

- **The SDK's OAuth guard is the SSRF guard**: `auth()` validates every cross-origin OAuth URL (private and loopback
  literals refused, DNS pinned) only while no custom `fetch` is passed, so the design never passes one and a test pins
  the transport configuration.
- **The card rides the tool part**: the run resume buffer already replays a whole stream (`S/chat/runs.ts:123-165`), so
  a preliminary output survives a reload without a new part type, event or route.
- **Search is a toggle, never an approval**: provider-executed calls cannot be blocked after the fact, so they are
  `not-applicable` and unobserved; the builtin is `safe` because the toggle is the consent.
- **One resolver** (`resolveWebSearch`) decides the server's behavior and the composer's state.
- **No migration**: OAuth records are secrets, `oauth` config lives in the JSON transport column, the chat mode in the
  JSON settings column.
- **Docs** are written by D19 and C47 (API.md) in P14-0a and reconciled by W14.12 in P14-B; P14-A agents never edit
  docs. **Feature e2e specs** are written in P14-B by W14.11. **Every new web test id** is added by C54 in P14-0b,
  copied verbatim from UI.md 13.14; `W/utils/testids.ts` is frozen during P14-A.

Coordinator decisions (2026-10-22, binding):

- A. `POST /mcp/oauth/callback` with a replayed, expired or unknown `state` answers 409 with the existing conflict
  reason `stale`.
- B. Elicitation waits cancelled by Stop, chat delete, key rotation or shutdown are recorded with action `cancel` and
  reason `stopped`; the 480 s timeout uses reason `timeout`.
- C. `encryptedContent` of provider-executed search parts is stripped from share snapshots and Markdown exports (W14.6);
  backups keep messages as stored.
- D. `SH/schemas/mcp.ts` was not a coordinator skeleton: C47 creates it (and `SH/schemas/web-search.ts`).

Open points decided by D18 while writing this file (confirmed or changed by the coordinator at Gate P14-0a):

1. **The stop order** (C50): `SHUTDOWN_STEPS` (`S/deps.ts:210`) becomes `claudeImport`, **`elicitations`** (every wait
   answers `cancel` / `stopped`, so the runs can finish), `data`, `runs`, `hooks`, `projectMcp`, `customizations`,
   `projectConfig`, `projectFiles`, `checkpoints`, `marketplaces`, `plugins`, `mcp`, **`mcpAuth`** (pending flows
   dropped after the managers closed), `catalog`, `events` — the plan's "elicitations → MCP managers → `mcpAuth`";
   `BOOT_STEPS` (`:175`) unchanged (both services are lazy). `deps.test.ts` pins both orders.
2. **`awaitingInput` on the wire**: the list and detail answers of `S/http/routes/chats*` set `awaitingInput:
   pendingCount(id) > 0` (C52); the broker (W14.3) emits `chat.updated` with the chat's summary (read through the
   existing `ChatService.summary`, `S/services/chats/types.ts:323`, plus `activeLeafId`) and `awaitingInput` on every 0
   ↔ ≥ 1 transition; every other `chat.updated` / `chat.created` omits the key, and the web chats store treats an absent
   key as "unchanged" (it clears the flag on `run.finished` / `run.aborted` of the chat). No new SSE type.
3. **The elicitation timeout in probes**: the plan's probe group 3 says "timeout (shortened via the test-only limit)",
   but its totals name no environment variable besides `E2E_FAKE_REMOTE_PORT`. Resolved within the totals: the
   "test-only limit" is the broker's option `createElicitationBroker(deps, { waitMs })` (C50's signature), so W14.3's
   unit tests prove the 480 s timeout with fake timers and the probe checks `expiresAt` ≈ request time + 480 s and the
   Stop path. A probe-level timeout on the built server would need a test-only `HF_TEST_ELICITATION_WAIT_MS` (honored
   only with `HF_MOCK_PROVIDER=1`, the `HF_TEST_FILE_SWEEP_DELAY_MS` precedent): that is a CCR the coordinator may
   accept at Gate P14-0a (C50 would add it to `S/env.ts`, K1 to the contract seed and AGENT.md).
4. **A new chat keeps its mode**: the request body's `webSearch` is the turn's mode; when the request creates the chat
   the server saves it as `settings.webSearch` (like `toolMode` and `reasoningEffort` at creation, `S/chat/prepare.ts`);
   for an existing chat the web persists a pick with `PATCH /chats/:id` and also sends it in the body (C52 / C54).
5. **The composer's resolver inputs** (C54, W14.8): `native` = the selected model's `catalogModel.webSearch`,
   `modelTools` = `capabilities.tools`, `preferNative` = the setting `webSearchNative`, `builtinAvailable` =
   `useWebSearchStore().builtinAvailable` (`core-search` active and the selected backend's key `set` in `GET
   /plugins/core-search/settings`; refreshed on `plugin.changed` for `core-search`), `functionTools` = 1 when tools are
   on (the skeleton's estimate). The toggle maps on → `auto`, off → `off`; no pick → the chat's setting, then
   `webSearchDefault`.
6. **A `needs-auth` server with an `Authorization` header** cannot sign in (400): its row shows "The server rejected its
   Authorization header." with Edit… instead of **Sign in** (W14.7; UI.md 8.14 / 15 win on the copy).
7. **No "None" backend**: the Settings page's backend select lists Brave Search, Tavily and Exa; each key row shows "Key
   saved · Replace · Remove" or "No key"; the builtin is available only when the selected backend has a key.
8. **The seeded OAuth server's port**: K3S seeds the project `.mcp.json` http server (with `oauth`) and the Claude
   plugin OAuth server at fixed loopback ports recorded in `.tmp/upgrade-v181-ids.json`; G14B, G14P (group 10) and the
   final gate start the OAuth fixture on those ports, so the v1.8.1 approval stays valid (the `.mcp.json` file is never
   edited) and signing in works.
9. **e2e cross-site**: the Playwright `baseURL` is `http://localhost:8899` (`playwright.config.ts:4`), so W14.11 runs
   the fake authorization server on `127.0.0.1` (the plan wrote the reverse; what matters is two different sites).
10. **The MCP DTO decoration** (`McpServer.transport.oauth`, `McpServer.auth`, `ProjectMcpServer.auth`) is built where
    the DTOs are built (`S/mcp/index.ts:760-820`, `S/mcp/project.ts`): C51 in P14-0b, through
    `deps.mcpAuth.info(target)` (C50's stub answers null); W14.1 implements `info`.
11. **The `prompts` / `resources` / `content` stubs** (`S/mcp/{prompts,resources,content}.ts`) are written by C51 in
    P14-0b with their final signatures (its call sites need them); W14.2 implements them in P14-A.
12. **The pre-sign-in probe** (`S/mcp/oauth/probe.ts`) sends its one `initialize` POST with the global `fetch` and
    `redirect: 'error'` to the MCP server URL only (the host the transport already contacts; `safeFetch` would refuse
    the private and loopback hosts personal MCP servers legitimately use); every authorization-server URL goes through
    `auth()` and its guard.
13. **Route globs**: W14.1's route glob is `S/http/routes/{mcp.,mcp-auth,project-mcp}*` (a bare `mcp*` would also match
    W14.2's `mcp-resources.ts`).
14. **`command-badge.ts`** (`W/components/chat/parts/`, the "MCP · {server}" badge of a sent command) belongs to W14.9;
    the slash menu row (server name, hint) to W14.8.
15. **Regression copies**: the coordinator copies `.tmp/gates/P12-A/{probe,lib,s-*}.mjs` to
    `.tmp/gates/P14-A-p12a-regression/` with the pins Phase 14 moves relaxed (`pluginApiVersion` ≥ 1.6.0, mock models ≥
    18, settings keys ≥ 32, routes ≥ 132, notices ≥ 11, conflict reasons ≥ 15) and keeps the P11-A and P10-A copies at
    `.tmp/gates/P12-A-{p11a,p10a}-regression/`; P9-A (with `.tmp/upgrade-v14`) and P8-A run as they are.
16. **Frozen files inside P14-A globs**: `S/mcp/oauth/types.ts` (W14.1's glob), `S/mcp/elicitation/types.ts` (W14.3's),
    `S/chat/search/types.ts` if C52 creates one (W14.4 / W14.5), `S/services/{chats,shares,data}/types.ts` and
    `S/services/data/references*` (W14.6's), the props / emits / root ids of the C54 stubs inside W14.7 – W14.10's globs
    and the store signatures: they stay frozen (prose exceptions, like Phase 12).
17. **Slots**: P14-0a C47 k2, C48 k3, C49 k4, D18 k1, D19 k5 (no server), K3S :8898 (the `.tmp/v181` build); P14-0b C50
    k3, C51 k4, C52 k5, C53 k6, C54 (web, no server), G14B :8898 after the coordinator's build; P14-A W14.1 – W14.6 k1 –
    k6 (web agents run no server), G14P on :8896 – :8898 only after the build signal; W14.11 e2e 8891; G14D a host port
    the coordinator assigns.

## Deviations from the plan (binding)

The binding changes found while building are listed per wave in "Deviations found while building" below. The coordinator
records there every binding change to the plan sections of this file, with the gate that decided it; the agents build
against the plan sections of this file plus that list.

### Deviations found while building (P14-0a – P14-B)

Recorded by the coordinator from the agent reports (`.tmp/waves/P14-*-notes.md`) and the gates; the code and the
reconciled docs (W14.12) follow these, not the task text further down.

- **Gate P14-0a** (coordinator):
  - Open points 1, 2, 4–7 and 9–17 confirmed as written.
  - Open point 3: the CCR is **accepted** — test-only `HF_TEST_ELICITATION_WAIT_MS` (honored only with
    `HF_MOCK_PROVIDER=1`, like `HF_TEST_FILE_SWEEP_DELAY_MS`; C50 adds it to `S/env.ts` and passes it to the broker's
    `waitMs`), so probe group 3 and the e2e spec can see a real timeout.
  - Open point 8 **changed** to what K3S seeded: the seeded OAuth servers (`.mcp.json` `oauth-remote` and the Claude
    plugin `seed-oauth-kit`) point at `127.0.0.1:${OAUTH_MCP_PORT}`, seeded as port 9 (a fetch "bad port": never
    contacted). G14B / G14P / the final gate repoint them to the OAuth fixture through the project variable
    `OAUTH_MCP_PORT` (`PUT /projects/:id/mcp/variables`, fresh auth) and the plugin setting `OAUTH_MCP_PORT`, and the
    two global http servers through `PATCH /mcp/:id`; the `.mcp.json` file is never edited, so every trust hash stays
    valid. Ids, hashes and the backup sha256 are in `.tmp/upgrade-v181-ids.json` (`ids.index`, `ids.phase14`).
  - C48 accepts the Pydantic / FastMCP optional shape (`anyOf` / `oneOf` `[X, {type: 'null'}]`, `type: [T, 'null']`) as
    an optional field; `sourceDomain` returns the punycode host (WHATWG `URL`).
  - C47: `catalogModel.webSearch` is `nullable().optional()` (absent = null); `McpServer.auth`, `ProjectMcpServer.auth`
    and `transport.oauth` are required and nullable (null until W14.1); MCP server ids `oauth` / `resources` stay valid
    (no route shadows them). OAuth callback replay / expiry / unknown state → 409 `stale`; elicitation cancel by Stop /
    chat delete / key rotation / shutdown → `cancel` + reason `stopped`; the 480 s timeout → reason `timeout`.
  - Seeds and probes that save provider credentials must point the provider at a loopback base URL (saving a key runs
    the provider test even with `HF_OFFLINE=1`).

## Rules for every Phase 14 agent

This section is the canonical copy of the agent rules (`.tmp/p14-designs/agent-rules.md` was its draft). The Phase 12
rules apply, renamed (P12-* → P14-*, W12.15 → W14.12; the ports :3000 / :8787 / :8899 / :8896 – :8898 are the
coordinator's; your slot is `879k`, e2e `889k`; the e2e fake remote port `E2E_FAKE_REMOTE_PORT` is reserved); the Phase
14 additions follow them.

- Read `AGENT.md` fully, your section of this file (or your task prompt) and the docs it names. Paths: `S` =
  `apps/server/src`, `W` = `apps/web/app`, `SH` = `packages/shared/src`, `SDK` = `packages/plugin-sdk/src`. Stay inside
  your OWNED globs; the FREEZE list in AGENT.md overrides any owned glob.
- Never run: package installs or CLIs (`pnpm add`, `npx`, `drizzle-kit`, `nuxi`, `shadcn-vue`), git write commands on
  this repository, `nuxt dev` / `nuxt build` / `nuxt prepare`, servers on :3000 / :8787 / :8899 / :8896 – :8898, **never
  `pnpm test:live`** (the repository `.env` may hold real keys and the suite makes paid calls), and never `pnpm
  key:rotate` / `rotate-key` against the repository's `data/` (tests use temp data directories). Existing scripts are
  allowed (`pnpm -F <pkg> test`, `pnpm typecheck`, `pnpm -F @harness-forge/web typecheck:fast`, `pnpm check:english`,
  `pnpm exec eslint --fix <your files>`).
- Shell hygiene in your own commands: never `cd` (use absolute paths, `pnpm -C <abs>` / `pnpm --dir <abs>`, `git -C
  <abs>`); never inline `sh -c` strings (a security hook blocks them: use script files or argument arrays); zsh does not
  word-split `$var` (use `bash -c` when you need it) and treats a bare `===` word specially (quote it); `rm -rf` is
  denied (move things aside with `mv` under `.tmp/`).
- Your own server uses your slot: `HF_PORT=879k HF_DATA_DIR=.tmp/<agent-id>`; e2e agents use `889k` (k ≠ 9) with
  `E2E_BASE_URL`. Stop every process you started (shell children, hook, MCP, OAuth-fixture and fake-remote children and
  background children included; kill by port) before reporting. Prefer `createTestApp()` + `app.request()`.
- **Temp folders**: tests create workspaces, roots, repositories, definition and settings folders, fake home folders,
  plugin and marketplace folders and data directories with `realpath(await mkdtemp(join(tmpdir(), 'hf-')))` (macOS
  `/var` is a link to `/private/var`, so an un-resolved path fails every containment check) and remove them afterwards;
  never the repository's `data/`, `.tmp/e2e`, a seed folder or a real project folder.
- **Shell tests** use POSIX `sh` syntax only (CI runs Linux, where `/bin/sh` may be `dash`; Docker has busybox): no
  bash-only features (`[[ … ]]`, arrays, `$'…'`, `source`), generous time margins, and skipped on Windows
  (`process.platform === 'win32'`).
- **Never spawn a shell string outside `S/workspace/shell.ts`**: no `spawn(…, { shell: true })`, `exec`, `execSync` or
  `child_process` with a command string anywhere else. **git runs only through `S/workspace/git.ts`** (argument arrays,
  `shell: false`, its scrubbed environment and `-c` overrides; paths after `--`, resolved through `resolveWorkspacePath`
  first). The MCP stdio transport keeps its own argument-array spawn. `S/security/process-spawn.test.ts` enforces the
  list (3 modules; Phase 14 adds none — test fixtures are started by tests, never by server code).
- **Git in tests**: never a git write command on the harness-forge repository. Tests run `git init` inside their own
  `realpath(mkdtemp())` folder, set the author with `-c user.name=… -c user.email=…`, point `HOME` / `GIT_CONFIG_GLOBAL`
  at the temp folder and use `describe.skipIf(!hasGit())`.
- **Every path a workspace tool, a mention, a definition read or write, a settings or `.mcp.json` read or write, a
  referenced script, an `@path` reference, a skill file listing or read, a plan file or a Remember append touches**
  resolves through the frozen `resolveWorkspacePath` (`S/workspace/paths.ts`) and the sensitive-path rules
  (`S/workspace/sensitive.ts`); no `fs` call on a model-supplied, user-supplied or file-supplied path without it (a
  plugin skill folder uses the plugin's realpath as the root). MCP resource URIs are never file paths: a resource is
  read only through its server (`readResource`), never from the disk.
- **Checkpoint blobs and journal rows only through the checkpoint store** (`S/services/checkpoints/**`); sub-agent and
  background sub-agent writes go through the same `journaledWrite` under the launching message's run scope; plan files
  through `journaledWrite`, Remember appends through `deps.checkpoints.journal(...)`. Hook processes, `!` spans and
  project definition files saved from the UI (`writeWithoutRecording`) are not journaled (documented).
- Every new text or JSON column goes into `REFERENCE_SOURCES` or `UNSCANNED_COLUMNS` (`S/services/data/references.ts`).
  Phase 14 adds **no column** (no migration): `mcp_servers.transport` keeps its classification although its JSON may now
  hold `oauth { clientId, scopes }`; `chats.settings` may hold `webSearch`.
- The shell command matcher (`SH/util/shell-command.ts`) fails closed: anything it cannot tokenize asks; imported
  `Bash(...)` rules and hook `if` rules go through it too.
- **Logging**: never log key material, secret values, file contents, diffs, tool inputs or outputs, shell commands,
  compaction summaries, steer / todo / plan texts, sub-agent prompts or outputs, mention queries, definition or skill
  bodies, command expansions, background prompts or reports or Remember texts at `info` (`debug` only, redacted;
  diagnostics carry project-relative paths and never file contents); the Phase 11, Phase 12 and Phase 14 additions
  below.
- Timers are `unref()`-ed and cleared in `stop()`; tests use fake timers (no real sleep over 2 s; hook, prompt-hook,
  elicitation and OAuth-flow timeouts in tests are small injected values, never the 60 s / 30 s / 480 s / 600 s
  defaults).
- Contracts: DTOs and route keys only from `@harness-forge/shared`, plugin shapes only from `@harness-forge/plugin-sdk`;
  server services only through the frozen `types.ts` interfaces. A missing member, a contract change, a frozen-file edit
  or a **new test id** is a CCR in your report (file, current shape, proposed shape, reason) plus a local adapter so you
  can keep working.
- New components are imported explicitly by path (`import ElicitationCard from './ElicitationCard.vue'`): the
  coordinator runs `nuxi prepare` only at the gates, so auto-import types do not know files created mid-wave.
- The props, emits and root test ids of the P14-0b stub components and the signatures of the new stores, modules and
  `useChatSession` / `useServerEvents` / `useMcpSignIn` / `useResourceMentions` additions are frozen after P14-0b:
  implement behind them; a change is a CCR.
- No doc edits in P14-A: write "For W14.12" notes (facts, deviations, suspected doc errors) into your report.
- Web unit tests: Nuxt composables come through a local `nuxt-imports.ts` that tests `vi.mock`; every password prompt
  goes through `useFreshAuth()` (UI.md 8.4).
- e2e uses only `.tmp/e2e/workspaces/*` for project folders; fake homes, plugin folders, marketplace folders and fixture
  state of e2e specs live in `realpath(mkdtemp())` folders outside the repository.
- Verify before reporting — server: `pnpm -F @harness-forge/server test` · `pnpm typecheck`; shared: `pnpm -F
  @harness-forge/shared test`; plugin SDK: `pnpm -F @harness-forge/plugin-sdk test`; web: `pnpm -F @harness-forge/web
  test` · `pnpm -F @harness-forge/web typecheck:fast`; all: `pnpm check:english`; lint your files with `pnpm exec eslint
  --fix <your files>`.
- Report ≤ 300 words in the AGENT.md format (tasks, files, commands + results, CCRs, dependency requests, open issues,
  suggested ROADMAP updates, "For W14.12" notes). Commits are made only by the coordinator; never add AI attribution
  anywhere.

Carried over from Phase 9:

- **Only mock models** in tests (`MockLanguageModelV4`, `simulateReadableStream` from `ai/test`, the `mock:*` provider);
  catalog, command, skill, hook, prompt-hook, background and search code never resolves a real provider (or a key from
  the environment) in tests. Never `pnpm test:live`.
- **Verify AI SDK names** in `node_modules/.pnpm/ai@7.0.148_zod@4.6.7/node_modules/ai/dist/index.d.ts` (the server
  resolves `ai` 7.0.148; 7.0.147 is installed too), `@ai-sdk/provider-utils` `dist/index.d.ts` and the provider packages
  before use: `streamText({ instructions, messages, tools, activeTools, prepareStep, toolApproval, stopWhen, abortSignal
  })` (`stopWhen` is `Arrayable<StopCondition>`), the `prepareStep` result fields, async-generator `execute`,
  `convertToModelMessages` options, `UIMessageStreamWriter`, transient data chunks, `generateText` for prompt hooks;
  Phase 14 adds the provider tool shape (`type: 'provider'`, `id: '<provider>.<name>'`, `args`, `isProviderExecuted:
  true`), the approval function's `toolCall` (`TypedToolCall`, with `providerExecuted`), the provider packages' search
  tools (`anthropic.tools.webSearch_20250305`, `openai.tools.webSearch`, `google.tools.googleSearch`,
  `xai.tools.webSearch`, `openrouter.tools.webSearch`, `groq.tools.browserSearch`) and `@ai-sdk/mcp` 2.0.81
  (`P/index.d.ts`: `OAuthClientProvider` :858, `UnauthorizedError` :931, `auth` :934, `ElicitationRequestSchema` :471,
  `MCPClient.onElicitationRequest` :1236, `experimental_getPrompt` :1228, `readResource` :1217).
- **History-derived state** (`findCompaction`, `compactionMarkers`, `splitSteers`, `latestTodos`, `splitTaskResults`,
  `taskResultText`, `splitHooks`, `hookModelText`, `isHookCarrier`, `hookChainLength`, `sessionStartSource`) only from
  `SH/util/agent-state.ts`; mention parsing / ranking only from `SH/util/mentions.ts` (resource mentions included); the
  web search resolution only from `SH/util/web-search.ts`; no local re-implementation on the server or the web.
- **Plan mode is enforced on the server** (tool set + approval), never only in the UI; `allowed-tools` keeps
  `exit_plan_mode` in plan mode; a hook `allow` (PreToolUse or PermissionRequest) never skips the plan-mode rules. Web
  search is allowed in plan mode (read-only).
- **Sub-agents never create approval requests and never elicit** (foreground and background): a tool that would ask is
  not offered or is denied (a hook `ask` in a child is a denial; `PermissionRequest` runs for the main agent only); an
  elicitation request during a child's MCP call is declined (`not-interactive`); depth 1; `task` and `skill` are absent
  from the child tool set.
- **In-memory state** (the queue, the sub-agent semaphores, the file index, the catalog cache, the background inbox and
  snapshots, the hooks and project-config caches, the hook run log, the project MCP runtimes, the prompt-hook call
  limiter, the async hook processes, the import plans, the tree-hash cache, and now the OAuth flows, the elicitation
  waits and in-flight call registries, the MCP prompt and resource caches, the `2026-07-28` capability memory and the
  once-per-chat notice memory) is keyed by chat / project / plugin / server, bounded, cleared on chat / project delete,
  key rotation and shutdown; timers `unref()`.
- **Feature agents implement behind the P14-0b seams** (`S/mcp/{index,project,errors,stdio-transport}.ts`,
  `S/chat/{pipeline,approval,prepare,agent-scope}.ts`, `S/chat/subagent/{host,index,tools}.ts`, the earlier frozen
  `S/chat/{hooks,tools,steps,markers,model-history}.ts`, `S/workspace/shell.ts`, `S/security/{types,ssrf}.ts`, the
  frozen service types and the stub modules).

Carried over from Phase 10:

- **Project definition files are untrusted input** (`.harness/{agents,commands,skills,output-styles}`, `.claude/{…}`):
  their `tools` / `allowed-tools` / `disallowedTools` / `disallowed-tools` only restrict (never add a tool), they never
  change the mode, grant an approval, create a tool override or a shell rule; `model` resolves only to providers the
  user configured (Claude aliases through `modelAliases`). Prompt injection through bodies is accepted like `AGENTS.md`
  today. The only exception is an **approved** executable item (a hook, a `.mcp.json` server, the `!` spans of a command
  file).
- **Reading project definitions**: every read through `resolveWorkspacePath` / `openWorkspaceFile` (no links anywhere on
  the path, regular files only, binary skipped, byte caps before parsing, count / depth caps, sensitive rules).
  User-level definitions and hooks live in the DB only: `~/.harness` is never read, and the **only** reader of
  `~/.claude` is the explicit import scan (an allowlist at `HF_CLAUDE_HOME`).
- **Parsing only with the shared helpers** (`SH/util/{definitions,arguments,tool-names}.ts`,
  `SH/util/{hooks,trust,mcp-config,command-template,output-styles}.ts`,
  `SH/util/{claude-plugins,claude-import,claude-permissions}.ts` and now
  `SH/util/{mcp-elicitation,mcp-prompts,web-search}.ts`); `yaml` is imported only by `SH/util/definitions.ts`; verify
  its API in
  `node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/*.d.ts`.
- **Background tasks** never create approvals and never elicit; are bounded (3 per chat, 10 per server, 30 min,
  `subagentMaxSteps`); are stopped on chat / project delete, delete-all, key rotation and shutdown (a restart leaves
  `aborted`), **never by the chat's Stop**; are delivered exactly once (`delivered_at`); their writes are journaled
  under the launching message; a running task makes its project busy (409 `run-active` for rewind / revert / undo /
  project delete / chat move / version delete; a branch switch stays allowed; project definition edits are not refused).
- **Writes**: plan files and `AGENTS.md` / `CLAUDE.md` appends go only through the journal (`journaledWrite` /
  `checkpoints.journal(...)`) and the file lock; hidden-path write policies (`always`) are never relaxed, so the agent
  can never silently rewrite `.harness/**`, `.claude/**` or `.mcp.json` (a hook `allow` does not skip them either).
- **Parts and their consumers**: `data-task-result`, `tool-skill` and `data-hook` keep their consumers; Phase 14 adds
  **no part type**: the elicitation card is an MCP tool part's preliminary output (`mcpToolProgressSchema`), the sources
  are the existing `source-url` parts, provider-executed search calls are ordinary tool parts with `providerExecuted:
  true`.
- The mock models (`mock:agents`, `mock:background`, `mock:hooks`, `mock:prompt-hook` and now `mock:search`,
  `mock:search-tool`) are frozen after P14-0b; PROVIDERS.md 8 is the probe contract.

Carried over from Phase 11:

- **Repository content is untrusted**: `.claude` / `.harness` `settings.json` and `settings.local.json` (only the
  `hooks` key is read), `.mcp.json` (now with `oauth`), output styles, command and skill files. Read them only through
  `resolveWorkspacePath` / `openWorkspaceFile` (no links anywhere on the path, regular files only, byte caps before
  `JSON.parse` / YAML, count caps, diagnostics instead of errors).
- **Executable items run only after hash approval** (project hooks incl. prompt hooks, `.mcp.json` servers incl. http /
  sse, command files with `` !`cmd` `` spans): the sha256 of `trustHashInput(item)` covers the item **and the script
  files it references** and is re-checked right before every spawn or model call (verify-before-run); a missing approval
  means "pending" (never "ask at run time"); the approve and variables routes are `fresh` and tests prove 403 without a
  fresh login. A pending project server can never sign in (409 `untrusted`).
- **Never read `process.env`** for `.mcp.json`, imported or plugin MCP variables or to build a hook / MCP environment
  beyond `shellEnvironment` / `stdioEnvironment` + `HARNESS_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` (+ `HARNESS_PLUGIN_ROOT`
  / `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and `CLAUDE_PLUGIN_OPTION_<KEY>` for plugin hooks); OAuth client ids and
  search keys never come from the environment either (the live suite's `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`,
  `EXA_API_KEY` are read only by `*.live.test.ts`).
- **Hooks and `!` spans run only through `runShellCommand`** (with `input` / `env`; exec-form handlers through
  `execFormCommand` quoting, still `runShellCommand`); the spawn allowlist (`S/security/process-spawn.test.ts`) stays at
  3 modules; timeouts, Stop and shutdown kill process groups (async hooks included).
- **Kill switches**: the setting `hooksEnabled: false`, `HF_WORKSPACE_SHELL=0` (no shell string at all: no `shell` tool,
  no command hook, no `!` span) and `HF_SAFE_MODE` (no command hooks, no project MCP servers, no user plugins, no prompt
  hooks) block command hooks; `hooksEnabled: false` and `HF_SAFE_MODE` also block prompt hooks (`HF_WORKSPACE_SHELL=0`
  does not); plugin code hooks still run. Phase 14 adds no switch: `HF_SAFE_MODE` and `HF_OFFLINE` change nothing about
  OAuth, elicitation or search beyond what they already block.
- **Hook scripts in tests** are POSIX `sh` files inside `realpath(mkdtemp())` projects or plugin folders, invoked as `sh
  <relative path>` (or exec form with `args`): never inline `sh -c` strings (a security hook blocks them in the
  coordinator's session), no `jq`, busybox-compatible (use `S/testing/hook-scripts.ts`); every spawned pid is dead at
  test end (assert it).
- **MCP tests** use loopback fixtures only (port 0; `example.invalid` for unreachable hosts; the stdio fixtures of
  `S/mcp/__fixtures__` and the OAuth fixture `S/mcp/__fixtures__/oauth-mcp-server.mjs`); never `npx`, never a remote
  URL.
- **Logging**: never log at `info` hook stdin payloads, stdout / stderr, hook command strings, `!` commands or their
  output, `@file` contents, `.mcp.json` variable values or resolved env / args / headers; hook runs log only the event,
  source, label hash prefix, exit code, duration and outcome.
- **Continuation turns** (Stop hooks and prompt Stop hooks, origin `hook`) are capped (5 in a row) and never start while
  an approval is pending; a user Stop ends the chain.
- **Web**: never put `//` inside a component prop value in a template (vue-tsc 3.3.12 regression
  vuejs/language-tools#6240 corrupts the generated code; `W/components/template-literals.test.ts` guards it); URLs go
  into script constants (the redirect URI shown in the OAuth fields and the "Set up web search" link included).

Carried over from Phase 12:

- **Never read the real `~/.claude` or `~/.claude.json`**: tests use a temp `HF_CLAUDE_HOME` built by
  `S/testing/claude-fixtures.ts` in `realpath(mkdtemp())` (probes also set a temp `HOME` with a sentinel); the scan
  reads only the allowlist (`agents/*.md`, `commands/**/*.md` ≤ 3 levels, `skills/<name>/SKILL.md`,
  `output-styles/*.md`, `settings.json`, `CLAUDE.md`, `.claude.json`); never `.credentials.json`, `projects/`,
  `history.jsonl`, `todos/`, `shell-snapshots/`, `statsig/`, `plugins/`, `settings.local.json`; from `.claude.json` only
  `mcpServers` and `projects[*].mcpServers` are kept.
- **Never fetch real GitHub / codeload / raw / npm / archive hosts**: unit tests inject `safeFetch`
  (`createFakeSafeFetch`, the `InstallerOptions` / `MarketplaceServiceOptions` overrides); probes use
  `HF_TEST_REMOTE_URL` (only with `HF_MOCK_PROVIDER=1`, `http://127.0.0.1:<port>`) and the loopback fake in
  `S/testing/fake-remote.ts`.
- **Never commit or create `.claude/`, `.harness/`, `.claude-plugin/` or `.mcp.json` inside the repository** (Claude
  Code discovers nested `.claude/` folders and would configure the coordinator's session): fixtures are built at test
  time in temp folders; seeds live under `.tmp/`; the only committed exception is
  `examples/plugins/claude-review-kit/.claude-plugin/plugin.json` (with inline `mcpServers`, no `.mcp.json`).
- **Archives go only through the installer's guards** (`checkEntryPath`, `EntryCollector`, exclusive writes,
  `verifyTree`); no git, no shell for downloads; marketplace JSON, Claude `plugin.json`, `hooks.json`, `.mcp.json` and
  `.claude.json` are untrusted input (byte caps before `JSON.parse`, diagnostics instead of errors).
- **Claude plugins that run anything** (command hooks, stdio MCP servers, `!` spans) need a whole-tree trust pin
  (`hf-claude-plugin/v1` hash); exec bits are kept only for the claude format; `bin/`, `.lsp.json`, `monitors/`,
  `themes/`, `workflows/` are never executed.
- **Variables**: `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SKILL_DIR}`,
  `${user_config.KEY}` are substituted only where the plan's variable table allows (`substitutePluginVariables`);
  `${user_config.*}` is refused in shell-form hooks; sensitive values never enter markdown bodies; **never
  `process.env`** for any substitution.
- **Saving a project file never approves** anything; every UI write goes through `resolveWorkspacePath` (rel equality,
  no links), the file lock and the `expectedSha256` check inside the lock; writes only under `.claude/`, `.harness/` or
  `.mcp.json`; settings files keep every key other than `hooks`.
- **Imported executables arrive turned off** (command hooks, `!` commands) unless the user enables them in the
  fresh-auth apply; secrets (env / header values) from the home folder stay in the server-side plan and never reach a
  DTO, a log or an error.
- **Prompt hooks**: the model answer is parsed only by `readPromptHookAnswer` and never grants a permission (`ok: true`
  decides nothing); calls are bounded (timeout, 8 server-wide); usage purpose `hook`; tests use `mock:prompt-hook` or
  `MockLanguageModelV4` only.
- **v1 and v2 trust hashes are byte-stable**: `trustHashInput` keeps the v1 layout for items without `extra` and the v2
  layout for items with it (golden tests); every approval of a v1.8.1 data folder must still match after the upgrade.
- **Qualified names** (`<pluginId>:<seg>…:<name>`) only through the shared helpers (`catalogNameSchema`,
  `qualifiedName`, `splitQualifiedName`); harness plugins keep bare names; MCP prompt names (`mcp__<server>__<prompt>`)
  only through `SH/util/mcp-prompts.ts`.
- **Logging**: never log at `info` imported file contents, hook commands, prompts or prompt-hook answers, `userConfig`
  values, tokens, env / header values, marketplace JSON or transcript lines; marketplace logs carry only id, name, repo
  and a 12-char sha; import logs carry the source, counts and duration (the root path at `debug` only).
- `S/chat/{hooks,tools,steps,markers,model-history}.ts` stay complete and frozen (a change is a CCR); P14-0b reopens
  `S/chat/{pipeline,approval,prepare,agent-scope}.ts` and `S/chat/subagent/{host,index,tools}.ts` only for C52, and they
  are frozen again after it.

Phase 14 additions:

- **Never contact real MCP, OAuth or search hosts** (Brave, Tavily, Exa, GitHub, a hosted MCP server, …): tests use the
  OAuth MCP fixture (`S/mcp/__fixtures__/oauth-mcp-server.mjs`) on loopback port 0, `createFakeSearchFetch`
  (`S/testing/fake-search.ts`), or `HF_TEST_REMOTE_URL` (only with `HF_MOCK_PROVIDER=1`) and the loopback fake remote.
  Live checks live only in `*.live.test.ts` and are never run by agents (`pnpm test:live` is forbidden).
- **Never pass a custom `fetch` to an MCP transport** (`createMCPClient` http / sse): the AI SDK guards every
  cross-origin OAuth URL (private / loopback literals refused, DNS pinned) only while it uses its own fetch; a test pins
  the transport configuration (`{ type, url, headers, redirect: 'error', authProvider? }`, no `fetch`).
- **OAuth secrets** (tokens, codes, code verifiers, client secrets, state values) live only in `SecretStore` under the
  plan's names (`mcp:<id>` `oauth.record` / `oauth.clientSecret`; `plugin:<pluginId>` and `project:<projectId>`
  `mcp-oauth.<serverId>`), are registered with the redactor, never appear in a DTO, a log line, an error message, a
  backup or a message part; sign-in never starts in the background (connect mode throws `McpAuthRequired`); a 401 is
  `needs-auth` and never retried with backoff.
- **Elicitation**: values the user enters are **never stored** (the final tool output keeps the request message, field
  names, the action and the reason); sub-agents and background tasks never elicit (auto-decline `not-interactive`);
  ambiguous attribution declines (`ambiguous`); unsupported schemas or URL mode decline (`unsupported`); every wait is
  bounded (480 s, `timeout`) and cancelled by Stop, chat delete, key rotation and shutdown (`stopped`); approvals still
  end the run.
- **Web search**: provider-executed calls are `not-applicable` in `createToolApproval` only when `providerExecuted ===
  true` **and** the name is in `nativeTools` (no hooks, no records for them); native and builtin search are never
  offered in one request; the builtin tool is `search_web` (never a function tool named `web_search`); search keys are
  `format: 'secret'` settings of `core-search`; queries and keys are never logged at `info`; Gemini 2.x native search is
  used only for turns without function tools (`exclusive`).
- **`safeFetch` POST** (complete in P14-0b): bodies ≤ 64 KB, POST never follows redirects; the SSRF guard and DNS
  pinning are unchanged; every outbound request of `core-search` goes through `createPluginSourceFetch` (https only +
  the test reroute); the token revocation goes through `safeFetch` POST.
- **Untrusted MCP content** (prompt results, resource contents, elicitation messages and schemas, tool results, search
  snippets and titles) is capped before use and rendered as plain text (no `v-html`, no Markdown in the elicitation
  card, provider error text ≤ 300 characters on the callback page).
- **No new dependency**: `@ai-sdk/mcp` 2.0.81, the installed `@ai-sdk/*` providers, `@modelcontextprotocol/sdk` 1.32.1
  (root dev, fixtures only) and Node built-ins cover everything.
- **v1.8 trust hashes stay byte-stable**: `.mcp.json` items that gain `oauth` parsing keep the same `trustHashInput`
  (golden test, C49); every approval of a v1.8.1 data folder must still match after the upgrade.
- **Logging (Phase 14)**: never log at `info` OAuth tokens, codes, verifiers, client secrets, `state` values, the
  authorization URL's query, elicitation messages or values, prompt arguments or expansions, resource contents, search
  queries, search keys or result snippets; OAuth logs carry the server id, the origin kind, the step and the outcome;
  search logs carry the backend, the result count, the status and the duration.
- **Hot files have one owner in P14-A**: `S/mcp/oauth/**`, `S/mcp/user-servers.ts`, `S/plugins/claude/mcp.ts` → W14.1;
  `S/chat/commands.ts`, `S/mcp/{prompts,resources,content}.ts` → W14.2; `S/mcp/mcp-tools.ts`, `S/mcp/elicitation/**` →
  W14.3; `S/builtin-plugins/core-providers/**`, `S/catalog/**` → W14.4; `S/builtin-plugins/core-search/**` → W14.5;
  `ChatComposer.vue`, `SlashMenu.vue`, `MentionMenu.vue` → W14.8; `ToolPart.vue`, `SourcesPart.vue` → W14.9.
  `S/mcp/{index,project,errors,stdio-transport}.ts`, `S/chat/{pipeline,approval,prepare,agent-scope}.ts`,
  `S/chat/subagent/{host,index,tools}.ts`, `S/security/{ssrf,types}.ts`, `useChatSession.ts`, `useServerEvents.ts`,
  `testids.ts`, the mocks and fixtures and the SH utils are complete and frozen after P14-0b (a change is a CCR).
- **Web**: Switch hit areas stay ≥ 40 px on coarse pointers (`apps/web/app/components/switch-hit-areas.test.ts`);
  external links (sources, search results, the authorization URL) open only http(s) URLs (`safeExternalUrl`); no
  external favicon (the SPA CSP `img-src 'self' data: blob:` blocks it: letter avatars instead).
- **No doc edits in P14-A**: write "For W14.12" notes into your report.

## FREEZE in Phase 14

In force since earlier phases (AGENT.md): `packages/*/src`, `S/app.ts`, `S/db/schema.ts`, `apps/server/drizzle/**`,
every `*/types.ts` under `S`, `S/builtin-plugins/index.ts`, `W/layouts/**`, store signatures in `W/stores/**`,
`apps/web/nuxt.config.ts`, every `package.json` and config file, `W/components/{ui,ai-elements}/**`, the CSS design
tokens in `W/assets/css/main.css`, `W/utils/testids.ts` (Phase 5), the Phase 5 – 11 additions (see AGENT.md) and the
Phase 12 additions (`S/plugins/marketplaces/types.ts`, `S/services/{claude-import,project-definitions}/types.ts`,
`S/plugins/claude/types.ts`, the P12-0b versions of `S/types.ts`, `S/chat/types.ts`, `S/plugins/types.ts`,
`S/registry/types.ts`, `S/services/{hooks,customizations}/types.ts` and the deps start / stop order,
`S/chat/{hooks,approval,tools,steps,pipeline,model-history,agent-scope}.ts` and `S/chat/subagent/host.ts` with the
P12-0b call sites, the signatures of the P12-0b stubs, the mock models incl. `mock:prompt-hook`,
`S/testing/{fake-remote,claude-fixtures}.ts`,
`SH/util/{claude-plugins,claude-import,claude-permissions,hooks,trust,definitions,arguments}.ts`, plugin SDK 1.6.0 and
its template mirror, the props / emits / root test ids of the P12-0b stub components, the `marketplaces` store,
`useClaudeImport`, the pure-module signatures, the Customize import query and the Phase 12 test ids).

P14-0a and P14-0b open the frozen files **only** for their named owners:

- P14-0a: K1 — `AGENT.md`, `docs/DECISIONS.md`, `docs/ROADMAP.md`; K2 — nothing (no new dependency: the package files
  and the lockfile stay closed); the coordinator — before the launch the contract skeletons
  `SH/util/{mcp-elicitation,mcp-prompts,web-search}.ts` and their three export lines in `SH/index.ts`, at the gate
  `examples/plugins/*/harness-forge.d.ts` (regenerated for 1.7.0) and the open points of this file; C47 — `SH/**` (not
  the C48 / C49 files; `SH/index.ts` included for its new schema exports), `SDK/**`, `S/app.ts`, the template mirror
  `S/plugins/templates/{sdk-types,templates.test}.ts`, the four 501 route stubs and the compile fixes it lists
  (`C47-compile-fixes`: the `Record<McpStatus, …>` maps of `W/components/plugins/mcp/mcp-form.ts:67-80`, the project MCP
  state maps, the `commandSource` maps and switches of the slash menu, the command badge and the server listing, the
  provider-hook whitelist `S/registry/validate.ts:165-175` if the optional `webSearch` member breaks its typing, the
  strict-schema fallout); C48 — `SH/util/{mcp-elicitation,web-search}{,.test}.ts` (complete); C49 —
  `SH/util/{mcp-prompts,mentions,mcp-config,tool-names}{,.test}.ts` (complete); D19 — `e2e/README.md` (documentation
  only).
- P14-0b: K4 — `playwright.config.ts`, the root `package.json` (`start:e2e` gains `HF_TEST_REMOTE_URL`), `e2e/README.md`
  (the fake-remote port); `apps/server/drizzle/**` only as the `db:generate` check (no file changes); C50 — `S/types.ts`
  (`AppServices.{ mcpAuth, elicitations }`), `S/deps*.ts` (factories, the stop order), `S/env*.ts` (only for an accepted
  open point 3 CCR), `S/main.ts`, `S/mcp/types.ts` (the manager members), the new `S/mcp/{oauth,elicitation}/types.ts`
  and their stubs, `S/db/schema.ts` (the TypeScript `oauth?` of `McpTransportRecord` only), `S/security/{types,ssrf}*`
  (POST, complete), `S/testing/**` (not C53's `fake-search*`, not C47's `api-samples.ts`),
  `S/builtin-plugins/{index,index.test}.ts`, `S/builtin-plugins/core-search/**` (manifest, settings schema, stub); C51 —
  `S/mcp/{index,project,errors,mcp-tools,stdio-transport,prompts,resources,content}*`, `S/mcp/__fixtures__/harness.ts`;
  C52 — `S/chat/**` (not `background/types.ts`), `S/http/routes/chats*`; C53 — the mock models
  (`S/builtin-plugins/mock/**`), `S/mcp/__fixtures__/oauth-mcp-server*`, `S/testing/fake-search*`,
  `e2e/fixtures/fake-remote.mjs`; C54 — `W/utils/testids.ts`, `W/utils/testing/**`, the store signatures of
  `W/stores/{plugins,project-mcp,chats,customizations}.ts` and the new `web-search` store, the prop / emit additions of
  the earlier stub and hot components it mounts into (`ChatComposer`, `MentionMenu`, `ComposerAddMenu`, `ToolPart`,
  `SourcesPart`, `McpServersPanel`, `McpServerDialog`, `ProjectMcpDialog`, `ProjectMcpServerRow`, `ChatNavRow`,
  `SettingsNav`), the `useChatSession` / `useServerEvents` additions.

Added to the freeze after Gate P14-0b:

- the new `S/mcp/oauth/types.ts` and `S/mcp/elicitation/types.ts`; the P14-0b versions of `S/types.ts`, `S/mcp/types.ts`
  (the manager members) and the deps start / stop order; `S/db/schema.ts` (the `oauth?` type);
- the seams of `S/mcp/{index,project,errors,stdio-transport}.ts` (complete, C51) and the signatures of the C51 stubs
  (`S/mcp/{prompts,resources,content}.ts`);
- `S/chat/{pipeline,approval,prepare,agent-scope}.ts` and `S/chat/subagent/{host,index,tools}.ts` (complete, C52), the
  signatures of the C52 stubs (`S/chat/search/{resolve,history,sources}.ts`, the MCP branch of `S/chat/commands.ts`:
  `CommandServices.mcp` / `projectMcp`, `CommandContext.projectId`);
- `S/security/{types,ssrf}.ts` (`safeFetch` POST, complete, C50); the signatures of the C50 stubs
  (`createMcpAuthService`, `createElicitationBroker`, the `core-search` manifest and settings) and the `createTestApp`
  options;
- the mock models `mock:search` / `mock:search-tool` and the mock provider's `webSearch` hook (PROVIDERS.md 8), the
  OAuth fixture (`S/mcp/__fixtures__/oauth-mcp-server.mjs`), `S/mcp/__fixtures__/harness.ts`, the fakes
  (`S/testing/fake-search.ts`, the fake remote's POST, `S/testing/fake-{mcp-auth,elicitations,project-mcp}.ts`),
  `e2e/fixtures/fake-remote.mjs`;
- `SH/util/{mcp-elicitation,mcp-prompts,web-search,mentions,mcp-config}.ts` (complete, C48 / C49; a behavior change
  after the gate is a CCR), `SH/schemas/{mcp,web-search}.ts`; the plugin SDK 1.7.0 and its template mirror;
- the props, emits and root test ids of the C54 stub components (`OAuthCallbackView`, `McpOAuthFields`,
  `ElicitationCard`, `WebSearchToggle`, `WebSearchToolBody`, `WebSearchSettings`), the `web-search` store, the sign-in
  actions of the `plugins` / `project-mcp` stores, the chats store's `awaitingInput`, `useMcpSignIn`,
  `useResourceMentions`, `TOOL_ELICITATIONS`, the `useChatSession` / `useServerEvents` additions, `ChatNavRow`, the
  routes `/oauth/callback` and `/settings/search` and the nav entry, the Phase 14 test ids (UI.md 13.14) in
  `W/utils/testids.ts`.

No CCR is pre-approved for P14-A; the coordinator batches CCRs at Gate P14-A.

---

## Wave P14-00 — stabilization start (done)

1. **Design inputs (done)** — the six reports of the planning session extracted with `.tmp/p10-designs/extract.mjs` into
   `.tmp/p14-designs/{explore-mcp,explore-search,explore-ui,server-mcp,server-search,web-waves}.md`, the approved plan
   copied to `plan.md`, the binding order and the known deviations written to `README.md`, the rules draft to
   `agent-rules.md`, the wave preamble and the agent prompts to `p14-0a-preamble.md` / `prompt-<agent>.md`.
2. **Baseline (done)** — `git status --porcelain` → `pnpm check` on `8108c56` green with 13815 tests (668 files) →
   `git status --porcelain` again, identical (`.tmp/gates/P14-00/{status-before,check,status-after}.*`).
3. **Old build for the seed (done)** — `git worktree add .tmp/v181 v1.8.1` (the tag is on `27699db`), then `pnpm --dir
   <abs>/.tmp/v181 install --frozen-lockfile` and `pnpm --dir <abs>/.tmp/v181 build` (absolute paths, never `cd` into
   the worktree; `.tmp/gates/P14-00/v181-{install,build}.log`). The worktree stays at the real v1.8.1 after `main`
   moves.
4. **CI and advisories (done)** — CI and the scheduled Audit on `8108c56` green, no open pull request; the two ignored
   advisories (node-forge GHSA-86w9-cpqp-85rv, braces GHSA-vfj7-8cjw-p6xm; build tooling) re-checked with the P8-00
   decision rule on 2026-10-22: still unpatched, the ignores stay.
5. **Archive (done)** — the old `.tmp` content moved into `.tmp/_archive/` with `mv` (`e2e-old-*`, the Phase 12 agent
   folders, `C42`, `C45`, `v17`, …); kept: `upgrade-v14` … `upgrade-v17` (+ ids, the v1.7 backup), `gates/**`,
   `p*-designs`, `waves`, `release`, `screenshots` (the regression probes read them). The user deletes `.tmp/_archive`
   with one command.
6. **Memory** — the coordinator rewrites `harness-forge-state.md`: Phase 14 = MCP 2.0 and web search; plan in
   `.tmp/p14-designs`; seed `.tmp/upgrade-v181`; gotchas: never a real MCP / OAuth / search host in tests, never a
   custom `fetch` on MCP transports, never `.claude/`, `.harness/`, `.claude-plugin/` or `.mcp.json` in the repository,
   the regression copies of the P12-A probes.

---

## Wave P14-0a — decisions, contracts, docs

Five agents in one launch (C47, C48, C49, D18, D19) after K1, K2 and the contract skeletons; the K3 seed runs alongside
(agent K3S). K1 writes DECISIONS.md, ROADMAP.md and AGENT.md at the same time as the agents; until it lands, `plan.md`
is the source.

### Coordinator actions

- **K1** — `docs/DECISIONS.md`: ADR-059 … ADR-063 (Decision | Why | Consequences; "Why" = the user decision of
  2026-10-22 + Claude Code parity where true); the amendment notes ("Phase 14 (ADR-0xx): …") on ADR-008 (provider-native
  search tools, plugin API 1.7.0), ADR-012 (OAuth tokens are secrets of the single user), ADR-017 (no Phase 14 route
  needs fresh auth: a sign-in only stores a token the user granted at the authorization server; the client secret
  travels through the existing MCP update), ADR-024 (OAuth records and search keys never in a backup; kept by
  delete-all), ADR-034 (key rotation re-encrypts the OAuth records and cancels pending elicitations and OAuth flows),
  ADR-042 (resource mentions next to file mentions), ADR-043 (children never elicit; they inherit the web search mode),
  ADR-044 / ADR-045 (MCP prompts are a fifth command source `mcp`, frozen expansions), ADR-046 (background children
  never elicit), ADR-048 (`Notification` type `elicitation_dialog`), ADR-050 (`.mcp.json` `oauth`; the trust hash is
  unchanged), ADR-052 (plugin API 1.7.0) and ADR-053 (Claude plugin MCP servers keep `oauth`); the contract seed (see
  "Entry criteria"). `docs/ROADMAP.md`: the Phase 14 section (one box per agent) and the backlog (removed: "OAuth-only
  remote MCP servers of Claude Code plugins"; added: the out-of-scope list of "Goal"; heading "(not in v1.9)"); the wave
  log row `P14-00`. `AGENT.md`: the "Plugin API 1.7.0" and "MCP 2.0 and web search" facts, the test-only
  `E2E_FAKE_REMOTE_PORT` and the Phase 14 freeze line ("Added in Phase 14 (after Gate P14-0b): …", the list of "FREEZE
  in Phase 14").
- **K2 (done)** — no new dependency (`@ai-sdk/mcp` 2.0.81, the installed `@ai-sdk/*` providers,
  `@modelcontextprotocol/sdk` 1.32.1 as a root dev dependency, Node built-ins); a DEPENDENCY REQUEST from an agent is
  declined unless a gate proves the need; the `start:e2e` change is K4's (P14-0b).
- **Contract skeletons (done)** — `SH/util/mcp-elicitation.ts` (`ELICITATION_FIELDS_MAX` 20, `ELICITATION_OPTIONS_MAX`
  100, `ELICITATION_MESSAGE_MAX_CHARS` 2000, `ELICITATION_TEXT_MAX_CHARS` 500, `ELICITATION_VALUE_MAX_CHARS` 10 000,
  `ELICITATION_FIELD_NAME_PATTERN`, `ElicitationFieldType`, `ElicitationStringFormat`, `ElicitationOption`,
  `ElicitationValue`, `ElicitationField`, `ElicitationForm`, `ElicitationFormResult`, `ElicitationContent`,
  `ElicitationIssueCode`, `ElicitationFieldIssue`, `ElicitationAnswerResult`, `ElicitationRawValue`,
  `parseElicitationForm`, `elicitationMessageText`, `validateElicitationAnswer`, `isSensitiveField`,
  `elicitationInitialValues`, `coerceElicitationValue`), `SH/util/mcp-prompts.ts` (`MCP_PROMPT_PREFIX`,
  `MCP_PROMPT_NAME_PATTERN`, `MCP_PROMPT_ARGUMENTS_MAX` 20, `McpPromptArgument`, `McpPromptBinding`,
  `mcpPromptCommandName` (implemented: `mcpToolName`), `isMcpPromptCommandName`, `mcpPromptArgumentHint`,
  `bindMcpPromptArguments`), `SH/util/web-search.ts` (`SEARCH_WEB_TOOL_NAME`, `WEB_SEARCH_MAX_USES` 5,
  `WEB_SEARCH_MODES`, `MODEL_WEB_SEARCH_KINDS`, `WEB_SEARCH_UNAVAILABLE_REASONS`, `WEB_SEARCH_BACKENDS`,
  `WebSearchResolveInput`, `WebSearchResolution`, `resolveWebSearch`, `isProviderExecutedPart`, `sourceDomain`) and
  their three exports in `SH/index.ts`: the names and signatures are final (adding members is fine, a rename or a
  removal is a CCR), the bodies throw until C48 / C49 implement them. The util files never import `limits.ts` /
  `enums.ts` values (type-only imports are fine; the Phase 10 import cycle); `LIMITS` and `enums.ts` mirror their
  constants (C47 pins the mirror).
- **K3 seed (background, agent K3S)** — the `.tmp/v181` build (`27699db`) on :8898 with `HF_PASSWORD`,
  `HF_MOCK_PROVIDER=1 HF_OFFLINE=1 HF_CLAUDE_HOME=0`, `HF_DATA_DIR=.tmp/gates/P14-0b/seed-data` and
  `HF_WORKSPACE_ROOTS=<repo>/.tmp/gates/P14-0b/seed-roots` (outside the data dir, so a copy keeps a valid project path),
  driven by `.tmp/gates/P14-0b/seed-v181.mjs` (derived from `.tmp/gates/P12-0b/seed-v17.mjs`) and `run-seed.sh` /
  `check-seed.mjs` (bash script files, never inline `sh -c`):
  - the full v1.7 seed set, adapted to what v1.8.1 changed;
  - the MCP state Phase 14 touches: a global **http** MCP server with an `Authorization` header secret and one with a
    custom `X-Api-Key` header, pointing at loopback URLs nothing listens on during the seed (their statuses recorded); a
    global **stdio** server (the dependency-free `mcp-min.mjs`); a project `.mcp.json` with an **http server that has an
    `oauth` object** (`{ "clientId": "seed-client", "callbackPort": 8765 }`, at a fixed loopback port recorded in the
    ids file, open point 8) approved through the trust dialog (fresh auth; v1.8.1's `ignored-field` diagnostic and the
    approved trust hash recorded); a Claude Code plugin folder (built under `.tmp/gates/P14-0b/fixtures/`) whose
    `.mcp.json` has an http server with `oauth` (a fixed loopback port), installed and trusted (v1.8.1's diagnostic
    "OAuth settings of MCP servers are not supported" recorded);
  - chats with and without projects whose `chats.settings` have no `webSearch`; a chat with a stored `source-url` part
    if a v1.8.1 mock can produce one (else "none" in the ids file); one pending tool approval; the global settings
    untouched (no `webSearch*` keys);
  - a **v1.8.1 backup zip** (the `/api/data` backup) → `.tmp/upgrade-v181-backup.zip` (sha256 recorded);
  - stop the server by port (wait until the port is free) → `check-seed.mjs` (counts, `integrity_check`, the OAuth
    project server approved, no process left) → copy to `.tmp/upgrade-v181/{data,roots}` (`cp -R` keeps links), the ids
    (chats, messages, projects, MCP servers incl. the OAuth ones and their ports, trust hashes, plugin ids, the backup
    sha256, the pending approval, what v1.8.1 reported for the `oauth` keys) to `.tmp/upgrade-v181-ids.json`,
    `seed-summary.json` (never `.tmp/e2e`, which the gates migrate). **Probes never write into `seed-roots`**: a probe
    copies the roots and points `projects.path` at the copy by SQL before boot. Every later upgrade probe runs on a
    fresh copy of `.tmp/upgrade-v181`. `run-seed.sh` runs green twice in a row (the second run moves the first aside).
- Ownership file `.tmp/waves/P14-0a.json` (below).

### C47 contracts (k2)

- **Mission.** Write every shared contract of Phase 14, the plugin SDK 1.7.0, the nine new routes as 501 stubs and
  `docs/API.md`, keeping `pnpm check` green (with the compile fixes `needs-auth`, the `mcp` command source and the
  strict schemas need).
- **Owned.** `SH/**` except the C48 files (`SH/util/{mcp-elicitation,web-search}{,.test}.ts`) and the C49 files
  (`SH/util/{mcp-prompts,mentions,mcp-config,tool-names}{,.test}.ts`), `SH/index.ts` included (its new schema exports);
  `SDK/**`; `S/plugins/templates/{sdk-types,templates.test}.ts`; `docs/API.md`; `S/app.ts`; the new 501 stubs
  `S/http/routes/{mcp-auth,chat-elicitations,mcp-resources,web-search}.ts`; `S/testing/api-samples.ts`; the route-driven
  tests (`S/http/routes-mounted.test.ts`, `S/http/middleware/{session-auth,fresh-auth}.test.ts`,
  `S/security/{fresh-auth-routes,secret-leaks,request-guards}.test.ts`); `W/utils/testing/fixtures.ts`; and every
  fixture, count pin or compile fix the new required fields need (listed in the report; the coordinator accepts them in
  the audit as `C47-compile-fixes`; expected: `MCP_STATUS_DOTS` / `MCP_STATUS_LABELS` of
  `W/components/plugins/mcp/mcp-form.ts:67-80` (`needs-auth` → dot `warning`, label "Sign in required"; nothing more),
  the project MCP state maps of `W/components/projects/mcp/**`, the `commandSource` maps of
  `W/components/chat/composer/slash-commands.ts` and `W/components/chat/parts/command-badge.ts` and of the server
  listing, `S/registry/validate.ts:165-175` if the optional `webSearch` member breaks the
  `OPTIONAL_PROVIDER_FUNCTIONS` typing, the strict-schema fallout). A file that needs edits from both C47 and C48 / C49
  is C47's (C48 / C49 say what they need). No feature behavior in compile fixes.
- **Read-only highlights.** `.tmp/p14-designs/**` (the plan's Reconciliation table, Totals and sections 1 – 7 and
  `README.md` are binding; `server-mcp.md` section 2 and `server-search.md` "Contracts (0a)" are the detailed contract
  diffs); `docs/DECISIONS.md` (the Phase 14 contract seed, K1); the coordinator's skeletons (C48 / C49 implement them);
  `SH/api/routes.test.ts` and `SH/contract.test.ts` (doc-coupled: API.md section 8 and the DECISIONS module table),
  `SH/schemas/dto.test.ts` (settings, events), `SH/isomorphic.test.ts` (exported value names, no Node built-ins, no
  `process.` text), `SDK/exports.test.ts`; `SH/ids.ts:80` (`MCP_SERVER_ID_PATTERN`), `:176` (`catalogNameSchema`),
  `:393` (`mcpToolName`); `SH/enums.ts:102` (`mcpStatusSchema`), `:204` (`commandSourceSchema`), `:317`
  (`projectMcpStateSchema`); `SH/errors.ts:115` (`conflictReasonSchema`); `SH/schemas/tools.ts:74` (transport input),
  `:90` (server input), `:104` (transport update), `:131-159` (the DTO), `:167` (`commandSummarySchema`);
  `SH/schemas/plugin-data.ts:257` (`mcpServerDeclSchema`); `SH/schemas/chats.ts:21-41` (chat settings and their update),
  `:56` (`pendingApproval`); `SH/chat.ts:41-46` (`commandInvocationSchema`), `:123` (`noticeCodeSchema`), `:354`
  (`chatRequestBodySchema`); `SH/schemas/system.ts:177` (`settingsSchema`); `SH/schemas/models.ts:39`
  (`catalogModelSchema`); `SH/api/routes.ts:325-329` (`mcp.*`), `:332` (`commands.list`), `:451-453` (`projectMcp.*`);
  `SDK/types.ts:112` (`ProviderDefinition`), `:151` (`reasoning`), `:542` (the `notification` code hook);
  `SDK/version.ts:5`.
- **Tasks.**
  1. **C47-T1 Ids** — `SH/ids.ts`: `eli_` + 16 characters (`ELICITATION_ID_PATTERN`, `elicitationIdSchema`,
     `newElicitationId()`; memory only). Check that the MCP server ids `oauth` and `resources` cannot shadow the new
     static routes (`POST /mcp/oauth/callback`, `GET /mcp/resources`, `POST /mcp/resources/attach` next to `PATCH |
     DELETE /mcp/:id`, `POST /mcp/:id/{reconnect,oauth}`); reserve them in the MCP id rules if Hono's order needs it and
     say so. *Accept:* `ids.test.ts` (the generator matches its pattern; the reserved ids, if any).
  2. **C47-T2 Enums** — `SH/enums.ts`: `mcpStatusSchema` + `needs-auth`; `projectMcpStateSchema` + `needs-auth`;
     `commandSourceSchema` + `mcp`; `webSearchModeSchema` (= `z.enum(WEB_SEARCH_MODES)`), `modelWebSearchSchema`
     (`MODEL_WEB_SEARCH_KINDS`), `webSearchBackendSchema` (`WEB_SEARCH_BACKENDS`), `webSearchUnavailableReasonSchema`
     (`WEB_SEARCH_UNAVAILABLE_REASONS`) — built on the util constants (the util never imports the enums);
     `elicitationActionSchema` (`accept | decline | cancel`), `elicitationReasonSchema` (`user | timeout | stopped |
     not-interactive | ambiguous | unsupported`), `mcpAuthClientKindSchema` (`dynamic | configured`). *Accept:* enum
     tests; a v1.8.1 `McpServer` and `ProjectMcpServer` parse.
  3. **C47-T3 Errors, notices, limits** — the conflict reason `needs-auth` (16; the `errors.ts` comment explains it;
     `stale`, `disabled`, `untrusted` exist and serve the new routes, coordinator decision A); the notice code
     `web-search-unavailable` (12); the `LIMITS` Phase 14 group (the values of "Totals"; `mcpResourceReadBytes` equal to
     `mentionFileMaxBytes`, `SH/limits.ts:169`). *Accept:* a test pins every `LIMITS` value mirrored by the util
     constants; the count pins.
  4. **C47-T4 MCP schemas (`SH/schemas/mcp.ts`, new)** — `mcpOAuthConfigSchema` (strict `{ clientId?: 1..256, scopes?: ≤
     1024 }`), the OAuth input (+ `clientSecret?`; null in an update keeps the stored value), `mcpAuthInfoSchema {
     signedIn, expiresAt | null, scope | null, client: dynamic | configured | null, issuer | null }`,
     `mcpAuthStartBodySchema { returnTo? }` (`/`-relative, not `//`, ≤ 512), `mcpAuthStartSchema { authorizationUrl |
     null, redirectUri, expiresAt }`, `mcpAuthCallbackBodySchema` (strict `{ state 16..256, code?, iss?, error?,
     errorDescription? }`, exactly one of `code` / `error`), `mcpAuthCallbackResultSchema { target: { kind: 'global',
     serverId } | { kind: 'project', projectId, serverId }, status, returnTo | null }`; elicitation:
     `mcpElicitationFormSchema` (the zod mirror of `ElicitationForm`, kept in sync with a type-level test),
     `mcpElicitationSchema { id, serverId, serverName, message ≤ 2000, form, expiresAt }`, `mcpToolProgressSchema` (`{
     status: 'input-required', elicitation } | { status: 'running' }`), `mcpElicitationRecordSchema { id, message,
     fields: string[], action, reason }`, `mcpElicitationAnswerBodySchema` (`{ action, content? }`, `content` only with
     `accept`, values string | number | boolean | string[]), `mcpElicitationAnswerResultSchema { action }`; resources:
     `mcpResourceQuerySchema { projectId?, q? ≤ 256, limit 1..100 = 50 }`, `mcpResourceEntrySchema { serverId,
     serverName, scope: global | project, uri ≤ 2048, name, title?, description?, mimeType?, size?, mention }`,
     `mcpResourceListSchema { items, truncated, unavailable: [{ serverId, status }] }`, `mcpResourceAttachBodySchema {
     serverId, uri, projectId? }` (→ `FileRef`). *Accept:* samples; a callback body with both `code` and `error`
     refused; `returnTo` `//evil` and `https://…` refused; an answer body with `content` and `decline` refused.
  5. **C47-T5 Web search schemas (`SH/schemas/web-search.ts`, new)** — `searchWebInputSchema { query 1..400, count?
     1..10, freshness?: day | week | month | year }`, `searchWebResultSchema { title ≤ 300, url http(s) ≤ 2048, snippet
     ≤ 800, published: string | null }`, `searchWebOutputSchema { query, backend, results }`, `webSearchTestBodySchema {
     backend? }`, `webSearchTestResultSchema { ok: true, backend, results: int, ms: int }`. *Accept:* samples; a
     `javascript:` URL refused.
  6. **C47-T6 Existing schemas** — `SH/schemas/tools.ts`: http / sse transport input and update `oauth?`; the DTO
     `transport.oauth: { clientId | null, clientSecret: SecretState, scopes | null } | null` and `auth: McpAuthInfo |
     null`; `commandSummarySchema.name` accepts MCP prompt names (`MCP_PROMPT_NAME_PATTERN`) next to
     `catalogNameSchema`, `mcpServer?: { id, name }`. The project MCP server DTO: `auth`. `SH/schemas/plugin-data.ts`:
     `mcpServerDeclSchema` http / sse `oauth?` (`{{settings.x}}` allowed in `clientId`). `SH/schemas/chats.ts`: chat
     settings `webSearch?`, the update `webSearch` nullable (null removes), `chatSummarySchema.awaitingInput?: boolean`.
     `SH/chat.ts`: `chatRequestBodySchema.webSearch?`; `commandInvocationSchema.name` accepts MCP prompt names and
     `.source` follows `commandSourceSchema`; the notice. `SH/schemas/system.ts`: `webSearchDefault` (`'off'`) and
     `webSearchNative` (`true`) → 34 keys, neither needs fresh auth. `SH/schemas/models.ts`:
     `catalogModelSchema.webSearch: modelWebSearchSchema.nullable()`, optional on input so v1.8.1 cached listings and
     catalog rows still parse (the default handling is stated in the report). *Accept:* a v1.8.1 message (every part
     incl. a hook carrier), a v1.8.1 settings document, a v1.8.1 chat detail without `webSearch`, a v1.8.1 cached model
     listing without `webSearch` and `^1.6.0` manifests parse; `dto.test.ts` at 34 settings.
  7. **C47-T7 Plugin SDK 1.7.0 and manifests** — `PLUGIN_API_VERSION` `'1.7.0'`; `ProviderDefinition.webSearch?(model:
     ModelInfo, request: WebSearchRequest): WebSearchParams | undefined` with `WebSearchRequest { readonly
     functionTools: number, readonly maxUses: number }` and `WebSearchParams { tools?: Record<string, Tool>,
     providerOptions?: …, exclusive?: boolean }` (the `Tool` / provider-options types verified in the installed `ai`
     `.d.ts`, in the style of `reasoning`); `McpServerDecl.transport.oauth?`; the `notification` code hook `type:
     'permission_prompt' | 'elicitation_dialog'`; the template mirror `S/plugins/templates/sdk-types.ts` +
     `templates.test.ts`; `exports.test.ts` pins. *Accept:* SDK tests; `^1.6.0` manifests (the examples,
     `claude-review-kit`) still parse and builtin manifests with `engines ^1.6.0` still load; the report names the
     command that regenerates `examples/plugins/*/harness-forge.d.ts` if one exists.
  8. **C47-T8 Route table** — `ApiModule` += `mcpAuth`, `chatElicitations`, `mcpResources`, `webSearch`; the nine keys
     of "Totals" with their paths and bodies; `mcpResources.attach` 201; none fresh, none public → **141** routes, 40
     modules, 14 fresh; Hono's order checked against the existing `/mcp/:id/…` and `/projects/:id/mcp/…` routes.
     *Accept:* `routes.test.ts` (the API.md section 8 index + the DECISIONS module table) and `contract.test.ts` at 141.
  9. **C47-T9 `docs/API.md`** — the `LIMITS` rows; settings (34); conflict reasons (16); notices (12); the new schema
     sections (planned 4.36 – 4.39: MCP OAuth config, auth info, start / callback; elicitation; resources; web search)
     and the additions to the MCP, project MCP, command, chat settings, chat request, chat summary, settings and catalog
     model schemas; the four route sections (planned 5.37 – 5.40) with every answer (`mcpAuth`: 200, 400 (stdio, an
     `Authorization` header, validation), 404, 409 `disabled` / `untrusted` / `stale` (callback), 502 (the authorization
     server failed); `chatElicitations`: 200, 400 with field issues, 404, 409 `stale`; `mcpResources`: 200, 201, 400,
     404, 409 `needs-auth`, 413, 502 `provider_unreachable`; `webSearch`: 200, 400, 409 `disabled` (no key), 429
     `rate_limited`, 502); the chat stream notes (planned 6.12: the elicitation preliminary output, provider-executed
     parts, `source-url` after `search_web`); the 141-route key index in the parsed format; report the final section
     numbers (D18 / D19 cite them; W14.12 aligns this file).
  10. **C47-T10 Stubs, samples, security tests, fixtures and pins** — `S/app.ts` mounts the four modules; the nine
      routes validate first (params, query, body) → 400, then answer `501 not_implemented`; `api-samples.ts`; the
      route-table security tests follow (the guards; the leak canaries: fake OAuth tokens, codes, verifiers, client
      secrets and search keys never in an answer); `W/utils/testing/fixtures.ts` gets the new DTO fixtures and the two
      settings keys; `C47-compile-fixes`; the count pins (141 / 40 + the fresh list in `SH/api/routes.test.ts` and
      `S/http/routes-mounted.test.ts`, SSE 19 and settings 34 in `SH/schemas/dto.test.ts`, conflict reasons 16, notices
      12, `SH/contract.test.ts`). *Accept:* `routes-mounted.test.ts` green (no new route answers 404); `pnpm check`
      green, or the failures caused only by the unfinished C48 / C49 skeleton bodies listed exactly; v1.8.1 data and
      `^1.6.0` manifests still parse.
- **Tests.** Schema tests for every new DTO; route-table tests; the updated route-driven security tests.
- **Verify.** Shared, plugin SDK, server and web commands.

### C48 shared elicitation and web search helpers (k3)

- **Mission.** The shared elicitation form helpers and the web search resolver — complete and tested (frozen after Gate
  P14-0b; used by C51 – C54, W14.3, W14.4, W14.5, W14.8, W14.9).
- **Owned.** `SH/util/{mcp-elicitation,web-search}{,.test}.ts` (implementing the coordinator's skeletons: the exported
  names and signatures stay; an addition is listed in the report).
- **Read-only highlights.** ADR-060, ADR-063; the plan's Reconciliation rows (Elicitation, Search: mode + resolver);
  `server-mcp.md` sections 1 (ADR-060), 2 (the elicitation schemas) and 4 (unit tests); `server-search.md` ADR-S2; the
  module comments of both skeletons (they are the specification).
- **Tasks.**
  1. **C48-T1 `mcp-elicitation.ts`** — `parseElicitationForm` (the restricted MCP subset: string with `minLength` /
     `maxLength` and the formats email / uri / date / date-time, number / integer with `minimum` / `maximum`, boolean,
     single-select enum via `enum` (+ legacy `enumNames` titles) or `oneOf: [{ const, title }]`, multi-select `array` of
     an enum (`items.enum` or `items.anyOf: [{ const, title }]`, `minItems` / `maxItems`); `title` / `description`
     capped and cleaned of control characters; `default` kept only when valid; unknown annotation keys ignored; anything
     else → `{ ok: false, reason }`); `elicitationMessageText`; `validateElicitationAnswer` (required, types, integer,
     bounds, formats — email with a pragmatic pattern, uri as an absolute http(s) / mailto / urn URL, date `YYYY-MM-DD`
     real dates, date-time RFC 3339 —, options, multi-select counts and duplicates, unknown fields,
     `ELICITATION_VALUE_MAX_CHARS`; numeric strings converted; empty optional values dropped); `isSensitiveField`
     (case-insensitive words: password, passcode, passphrase, secret, token, api key / apikey / api_key, private key,
     pin (a whole word), otp, 2fa, cvv, cvc, card number, credit card, ssn, social security, iban; not "spin" or
     "pinned"); `elicitationInitialValues`; `coerceElicitationValue`. *Accept:* `mcp-elicitation.test.ts` (a table per
     rule and field kind with realistic `requestedSchema` examples from the MCP specification marked "spec example";
     round trips `parseElicitationForm` → `elicitationInitialValues` → `coerceElicitationValue` →
     `validateElicitationAnswer`; sensitive positives and negatives).
  2. **C48-T2 `web-search.ts`** — `resolveWebSearch` (the rule order of the module comment; the full truth table over
     mode × tool mode × native kind × `preferNative` × `builtinAvailable` × `modelTools` × `functionTools`);
     `isProviderExecutedPart` (UI tool parts `type: 'tool-*'` / `'dynamic-tool'` and model content parts `tool-call` /
     `tool-result` with `providerExecuted === true`; anything else, non-objects included, false); `sourceDomain`
     (http(s) only, lowercase host, `www.` removed, IDN left as given, null otherwise). *Accept:* `web-search.test.ts`
     (the truth table; every tool mode incl. `plan` and `edits` allows search).
  3. **C48-T3 Fuzz** — seeded random JSON values for every exported function: never throws, results bounded; an explicit
     describe-level `{ timeout: 30_000 }`.
- **Tests.** The tasks above. Pure and isomorphic (no Node built-ins, never the text `process.` in non-test files); no
  value imports from `enums.ts` / `limits.ts`.
- **Verify.** `pnpm -F @harness-forge/shared test`; `pnpm --dir <abs>/packages/shared typecheck`; `isomorphic.test.ts`
  green; `pnpm check:english`; eslint on the four files.

### C49 shared MCP prompt, mention and config helpers (k4)

- **Mission.** The prompt-command helpers, the resource mentions, the `.mcp.json` `oauth` key and the `WebSearch` tool
  alias — complete and tested, every existing mention and `.mcp.json` behavior byte-identical (frozen after Gate
  P14-0b).
- **Owned.** `SH/util/{mcp-prompts,mentions,mcp-config,tool-names}{,.test}.ts` (`mcp-prompts.test.ts` new).
- **Read-only highlights.** ADR-059 (the OAuth config row), ADR-061; the plan's Reconciliation rows (Prompts, Resources,
  OAuth config); `server-mcp.md` ADR-061 / ADR-062 and section 2; `web-waves.md` B, C; `SH/util/mentions.ts:161`
  (`formatMention`), `:171` (`parseMentions`), `:219` (`mentionTokenAt`); `SH/util/mcp-config.ts:335` (`REMOTE_FIELDS`),
  `:383` (`reportIgnored`), `:464`; `SH/util/trust.ts:223` (the `mcp` item: the raw server object, `oauth` included);
  `SH/ids.ts:393` (`mcpToolName`).
- **Tasks.**
  1. **C49-T1 `mcp-prompts.ts`** — `isMcpPromptCommandName`; `mcpPromptArgumentHint` (`<required> [optional]` in
     declared order, names sanitized for display, capped like the other argument hints); `bindMcpPromptArguments` (the
     module comment's rules; `MCP_PROMPT_ARGUMENTS_MAX`; values capped; never throws). *Accept:* `mcp-prompts.test.ts`
     (quoting, `name=value` for declared and undeclared names — an undeclared `x=y` is a positional word —, required /
     optional / last-takes-rest, fuzz with `{ timeout: 30_000 }`).
  2. **C49-T2 Resource mentions (`mentions.ts`)** — `formatResourceMention(serverId, uri): string | null`
     (`@<serverId>:<uri>`; null for a bad id, an empty or too long (> 2048) uri, whitespace or control characters) and
     `parseResourceMention(token): { serverId, uri } | null` (with or without the leading `@`; the uri starts with a
     scheme `^[a-z][a-z0-9+.-]*:`), plus the helper the composer needs to tell a resource token from a path token; a
     resource token such as `@github:repo://owner/name/README.md` is never treated as a project file path (a minimal
     guard in `parseMentions` if needed). *Accept:* every existing file-mention golden test byte-identical; the callers
     of `parseMentions` / `mentionTokenAt` on the server and the web checked and listed in the report.
  3. **C49-T3 `.mcp.json` `oauth` (`mcp-config.ts`)** — remote servers accept `oauth: { clientId?: 1..256, scopes?: ≤
     1024 }` (a scopes array of strings joined with spaces); `oauth.callbackPort` → an `info` diagnostic ("the harness
     signs in through its own callback page"); any other `oauth` key → `ignored-field`; stdio servers with `oauth` →
     `ignored-field`; the parsed server type gains `oauth?`. *Accept:* parser tables; a **golden test** pins
     `trustHashInput` of `.mcp.json` items with and without `oauth` to the v1.8.1 values (computed with the current code
     before the change).
  4. **C49-T4 `tool-names.ts`** — the Claude Code alias `WebSearch` → `search_web` (next to `WebFetch`). *Accept:*
     `tool-names.test.ts`.
- **Tests.** The tasks above. Pure and isomorphic; no value imports from `enums.ts` / `limits.ts`.
- **Verify.** `pnpm -F @harness-forge/shared test`; `pnpm --dir <abs>/packages/shared typecheck`; `pnpm -F
  @harness-forge/server test -- src/mcp src/chat` and `pnpm -F @harness-forge/web test -- composer` as a quick check;
  `pnpm check:english`; eslint on its files.

### D18 phase doc (k1)

- **Mission.** Write this file so P14-0b, P14-A and P14-B agents can build against it.
- **Owned.** `docs/phases/phase-14-v1-9.md` (new).
- **Tasks.**
  1. **D18-T1 Phase doc** — goal, totals, criteria, the design inputs and open points, the rules for every agent, the
     FREEZE list, every wave with owned globs, tasks with acceptance criteria, ownership JSON, cross-agent contracts,
     gates and probes, the mock and fixture contract, risks; contradictions between the plan, DECISIONS.md, the
     skeletons and the reports listed in the report (the plan's version written here).
- **Verify.** `pnpm check:english`.

### D19 docs (k5, no server)

- **Mission.** Update the user-facing and architecture docs for Phase 14 so P14-0b and P14-A agents can build against
  them.
- **Owned.** `docs/UI.md`, `docs/ARCHITECTURE.md`, `docs/PLUGINS.md`, `docs/PROVIDERS.md`, `docs/guides/**`,
  `README.md`, `.env.example`, `e2e/README.md`.
- **Tasks.**
  1. **D19-T1 UI.md** — 2.20 wireframes (an MCP server row in `needs-auth` and signed in, the OAuth fields section, the
     callback page states, the elicitation card on desktop and at 390 px, the composer Search toggle + the unavailable
     popover, the sources chips, Settings → Web search); 5.5 (the Settings nav "Web search" after Media); 6 (the routes
     `/oauth/callback` (layout `auth`) and `/settings/search`); 7.35 (chat: the elicitation card's behavior, countdown,
     focus and live-region rules, "Needs your input", `WebSearchToolBody`, the sources chips and letter avatars,
     provider-executed rows); 8.14 (MCP sign-in on the MCP panel and the project MCP dialog, sign out, open point 6);
     9.15 (Web search settings, open point 7); 10.10 (the props / emits of `OAuthCallbackView`, `McpOAuthFields`,
     `ElicitationCard`, `WebSearchToggle`, `WebSearchToolBody`, `WebSearchSettings`, see "C54 web skeleton"); 11.10 (the
     `web-search` store, the sign-in actions, `useMcpSignIn`, `useResourceMentions`, `TOOL_ELICITATIONS`, the
     `useChatSession` additions `webSearch`, `respondElicitation`, the run state `input`); 12 (Alt+W toggles web search,
     obeys `altShortcuts`); 13.14 (the Phase 14 test ids, from `web-waves.md` with `needs-auth` values and without the
     ids of removed features); 14 (accessibility); 15 (copy).
  2. **D19-T2 ARCHITECTURE.md** — the new flow sections (the OAuth sign-in sequence with the `SameSite=Strict` reasoning
     and the SDK URL guard; the connect-mode provider; the elicitation live wait: attribution, preliminary output,
     keep-alive, timeouts, cancel paths, children decline; MCP prompts → frozen expansions; resources → uploads; web
     search resolution + the provider-executed approval rule + the history stage + the sources transform; the
     `core-search` request path with `safeFetch` POST); the stop order (open point 1); backups and key rotation; the
     security section (token storage, redaction, backups, rotation; the SSRF of OAuth endpoints; untrusted MCP content;
     search queries and keys never logged); the log rules.
  3. **D19-T3 PLUGINS.md** — API 1.7.0 (`ProviderDefinition.webSearch?` with an example for a code provider,
     `McpServerDecl.transport.oauth?` for `contributes.mcpServers` / `ctx.mcp.register`, the `elicitation_dialog`
     notification type; the version table row); Claude Code plugin MCP servers keep their `oauth` object (sign in from
     the MCP panel); the builtin `core-search` (settings, `search_web`). *Accept:* `SH/schemas/manifest.test.ts` and
     `examples.test.ts` still parse PLUGINS.md (1.7.0-only samples marked so the test skips them until C47 lands,
     reported).
  4. **D19-T4 PROVIDERS.md** — a native web search matrix (provider → tool, version, models, citations, caveats: Gemini
     2.x exclusive, Groq `gpt-oss` only and no citations, Mistral / DeepSeek / Z.ai / MiniMax / Moonshot / Alibaba /
     Ollama none) and the builtin backends (Brave, Tavily, Exa: where to get a key, what is sent); section 8 "MCP and
     search mocks (Phase 14)": `mock:search` and `mock:search-tool` exactly as in "Mock and fixture contract" below (it
     is the probe contract); the listing and `modelCount` numbers.
  5. **D19-T5 Guides** — new `docs/guides/mcp-oauth.md` (adding a remote MCP server that needs sign-in, pre-registered
     clients and the redirect URI to register, project `.mcp.json` `oauth`, sign out, troubleshooting: `needs-auth`, a
     rejected `Authorization` header, http LAN origins, reverse proxies) and `docs/guides/web-search.md` (the toggle,
     native vs builtin, keys, costs, privacy); `adding-an-mcp-server.md` (OAuth, prompts as `/mcp__…`, resources via
     `@`, elicitation) and `hooks-and-project-mcp.md` (`.mcp.json` `oauth`, the `elicitation_dialog` notification)
     updated.
  6. **D19-T6 README, `.env.example`, `e2e/README.md`** — the status "v1.9 in progress" + feature bullets and the docs
     list; `.env.example` gains nothing for users (the live-test keys `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`,
     `EXA_API_KEY` only in the live-test comment block if one exists); `e2e/README.md` documents `E2E_FAKE_REMOTE_PORT`
     (the fake remote for Brave / Tavily / Exa started by Playwright; "default set in `playwright.config.ts`", K4 picks
     it).
- **Verify.** `pnpm check:english`; `pnpm -F @harness-forge/shared test` (doc-coupled tests).

### Wave P14-0a ownership

This is `.tmp/waves/P14-0a.json` (the coordinator's file). The audit cannot express "except": the C48 and C49 files and
the coordinator's skeletons match C47's `packages/shared/src/**` glob too (warnings; C48 / C49 own their files, the
skeletons were the coordinator's before the launch, `SH/index.ts` is C47's during the wave after the coordinator's three
export lines). C47 lists the extra fixture and compile-fix files it had to touch in its report; the coordinator adds
them to `C47-compile-fixes`. K2 changes nothing; K3S writes only below `.tmp/` (ignored by git).

```json
{
  "wave": "P14-0a",
  "agents": {
    "K1": ["AGENT.md", "docs/DECISIONS.md", "docs/ROADMAP.md"],
    "coordinator-skeletons": [
      "packages/shared/src/util/mcp-elicitation.ts",
      "packages/shared/src/util/mcp-prompts.ts",
      "packages/shared/src/util/web-search.ts"
    ],
    "C47": [
      "packages/shared/src/**",
      "packages/plugin-sdk/src/**",
      "apps/server/src/plugins/templates/sdk-types.ts",
      "apps/server/src/plugins/templates/templates.test.ts",
      "docs/API.md",
      "apps/server/src/app.ts",
      "apps/server/src/http/routes/mcp-auth.ts",
      "apps/server/src/http/routes/chat-elicitations.ts",
      "apps/server/src/http/routes/mcp-resources.ts",
      "apps/server/src/http/routes/web-search.ts",
      "apps/server/src/testing/api-samples.ts",
      "apps/server/src/http/routes-mounted.test.ts",
      "apps/server/src/http/middleware/session-auth.test.ts",
      "apps/server/src/http/middleware/fresh-auth.test.ts",
      "apps/server/src/security/fresh-auth-routes.test.ts",
      "apps/server/src/security/secret-leaks.test.ts",
      "apps/server/src/security/request-guards.test.ts",
      "apps/web/app/utils/testing/fixtures.ts"
    ],
    "C48": [
      "packages/shared/src/util/mcp-elicitation.ts",
      "packages/shared/src/util/mcp-elicitation.test.ts",
      "packages/shared/src/util/web-search.ts",
      "packages/shared/src/util/web-search.test.ts"
    ],
    "C49": [
      "packages/shared/src/util/mcp-prompts.ts",
      "packages/shared/src/util/mcp-prompts.test.ts",
      "packages/shared/src/util/mentions.ts",
      "packages/shared/src/util/mentions.test.ts",
      "packages/shared/src/util/mcp-config.ts",
      "packages/shared/src/util/mcp-config.test.ts",
      "packages/shared/src/util/tool-names.ts",
      "packages/shared/src/util/tool-names.test.ts"
    ],
    "D18": ["docs/phases/phase-14-v1-9.md"],
    "D19": [
      "docs/UI.md",
      "docs/ARCHITECTURE.md",
      "docs/PLUGINS.md",
      "docs/PROVIDERS.md",
      "docs/guides/**",
      "README.md",
      ".env.example",
      "e2e/README.md"
    ],
    "C47-compile-fixes": [],
    "coordinator-gate": [
      "examples/plugins/*/harness-forge.d.ts"
    ]
  },
  "allow": []
}
```

### Wave P14-0a cross-agent contracts

| Producer → consumer | Contract |
|---|---|
| coordinator (skeletons) → C47, C48, C49 | the exported names and signatures of `SH/util/{mcp-elicitation,mcp-prompts,web-search}.ts` |
| C47 → C48 – C54, every P14-A agent | the DTOs, enums, ids (`eli_`), limits, route keys, settings, the conflict reason `needs-auth`, the notice, `SH/schemas/{mcp,web-search}.ts`, the chat setting / request / summary / catalog additions; the plugin SDK 1.7.0 (`ProviderDefinition.webSearch?`, `WebSearchRequest`, `WebSearchParams`, `McpServerDecl.transport.oauth?`, the `elicitation_dialog` type) |
| C48 → C51 – C54, W14.3 – W14.5, W14.8 – W14.10 | `parseElicitationForm`, `elicitationMessageText`, `validateElicitationAnswer`, `isSensitiveField`, `elicitationInitialValues`, `coerceElicitationValue`, `resolveWebSearch`, `isProviderExecutedPart`, `sourceDomain` (complete) |
| C49 → C51 – C54, W14.1, W14.2, W14.8 | `mcpPromptCommandName`, `isMcpPromptCommandName`, `mcpPromptArgumentHint`, `bindMcpPromptArguments`, `formatResourceMention`, `parseResourceMention`, the `.mcp.json` `oauth` key and its diagnostics, the `WebSearch` alias (complete) |
| D18 → everyone | this file (owned globs, tasks, acceptance, gates) |
| D19 → C50 – C54, every P14-A agent | UI.md 2.20, 5.5, 6, 7.35, 8.14, 9.15, 10.10, 11.10, 12, 13.14, 14, 15; the ARCHITECTURE.md flow and security sections; PLUGINS.md 1.7.0; PROVIDERS.md (the native search matrix and 8 "MCP and search mocks (Phase 14)"); the two new guides and the updated `adding-an-mcp-server.md` / `hooks-and-project-mcp.md` |
| K3S → G14B, G14P (group 10), the final gate | `.tmp/upgrade-v181/{data,roots}` + `.tmp/upgrade-v181-ids.json` + `.tmp/upgrade-v181-backup.zip`, `.tmp/gates/P14-0b/seed-roots` (read-only for probes) |

### Gate P14-0a

1. `node scripts/audit-ownership.mjs .tmp/waves/P14-0a.json`
2. `pnpm install --frozen-lockfile`; `pnpm why typescript` (only 6.0.x).
3. `pnpm check` → `pnpm build`: record the web `_nuxt` entry chunk size (gzip) against the `.tmp/v181` build (more than
   40 KB larger → the owners of the new heavy pieces load them lazily; decided at the gate).
4. `HF_TEST_REQUIRE_WEB_BUILD=1 pnpm -F @harness-forge/server exec vitest run src/http/static.test.ts`.
5. `mv .tmp/e2e .tmp/e2e-old-p14-0a` (when it exists) → `pnpm start:e2e` → `curl -sf
   http://127.0.0.1:8899/api/health` shows `"pluginApiVersion":"1.7.0"`; the nine new routes are mounted (run with `bash
   -c`: zsh does not word-split `$r`):
   ```sh
   b=http://127.0.0.1:8899/api; p=prj_AAAAAAAAAAAAAAAA; c=01890000-0000-7000-8000-000000000000; e=eli_AAAAAAAAAAAAAAAA
   for r in "POST /mcp/x/oauth" "DELETE /mcp/x/oauth" "POST /projects/$p/mcp/x/oauth" \
            "DELETE /projects/$p/mcp/x/oauth" "POST /mcp/oauth/callback" "POST /chat/$c/elicitations/$e" \
            "GET /mcp/resources" "POST /mcp/resources/attach" "POST /web-search/test"; do
     set -- $r; curl -s -o /dev/null -w "%{http_code} $1 $2\n" -X "$1" -H 'content-type: application/json' -d '{}' "$b$2"
   done   # 501, or 400 where validation runs before the stub (routes-mounted.test.ts covers the full matrix)
   ```
6. `pnpm test:e2e` → 215 passed (`chromium` + `mobile` + `tablet`).
7. `pnpm audit --prod --audit-level high` clean (the two ignored advisories excepted).
8. The coordinator fixes (`examples/plugins/*/harness-forge.d.ts` regenerated for 1.7.0); the open points of this file
   decided (confirmed or changed in "Deviations found while building"); ROADMAP + wave log → commit `feat: add phase 14
   contracts and docs`.

---

## Wave P14-0b — skeletons, seams, FREEZE

**Entry:** Gate P14-0a green and the v1.8.1 seed in `.tmp/upgrade-v181`. C50, C51, C52, C53 and C54 start in one launch
(there is no migration to land first); K4 wires the e2e fake remote once C53's `e2e/fixtures/fake-remote.mjs` exists;
G14B writes its probes during the wave and runs them after the coordinator's build.

### Coordinator actions

- **K4 e2e wiring** — `playwright.config.ts`: `webServer` becomes two entries — first the fake remote `node
  e2e/fixtures/fake-remote.mjs` on `E2E_FAKE_REMOTE_PORT` (a default outside the 879k / 889k slots, chosen by K4 and
  documented in `e2e/README.md`), then the app; the root `package.json` `start:e2e` gains
  `HF_TEST_REMOTE_URL=http://127.0.0.1:<that port>` (honored because `start:e2e` sets `HF_MOCK_PROVIDER=1`); when the
  coordinator runs `pnpm start:e2e` by hand at a gate it starts the fake remote first (documented). A missing fake
  remote only breaks the search specs (the plugin-source fetches of the other specs use local folders and
  `HF_OFFLINE=1`).
- **K4 `db:generate`** — after C50's type edit (`McpTransportRecord.oauth?`) `pnpm db:generate` reports **no changes**
  (no migration; `apps/server/drizzle/**` unchanged).
- **After C50 – C54** — `nuxi prepare`; the build signal for G14B; the gate below; the FREEZE additions.
- Ownership file `.tmp/waves/P14-0b.json` (below).

### C50 server skeleton (k3)

- **Mission.** Freeze the server side of Phase 14 outside the MCP and chat seams: the two new services (`deps.mcpAuth`,
  `deps.elicitations`) with types and stubs whose signatures are final, the MCP manager members, the stop order,
  `safeFetch` POST (complete), the fakes and the `createTestApp` options, the `core-search` registration (manifest and
  settings final, the tool a stub) and the type-only `oauth?` of `McpTransportRecord`.
- **Owned.** `S/types.ts`, `S/deps*.ts`, `S/env*.ts` (only if open point 3's CCR is accepted), `S/main.ts`,
  `S/db/schema.ts` (the type only), `S/mcp/types.ts`, `S/mcp/oauth/{types,index}.ts`,
  `S/mcp/elicitation/{types,broker}.ts`, `S/security/{types,ssrf}*`,
  `S/testing/**` (not `fake-search*`, which is C53's, and not `api-samples.ts`, C47's file of P14-0a, untouched here),
  `S/builtin-plugins/{index,index.test}.ts`, `S/builtin-plugins/core-search/**`, and the compile fixes the interface
  changes force (listed as `C50-compile-fixes`).
- **Read-only highlights.** `.tmp/p14-designs/plan.md` 1 – 5, 7 and the Reconciliation rows (OAuth provider, Token
  storage, Elicitation, Search: builtin, `safeFetch`, No migration); `server-mcp.md` sections 2 – 3; `server-search.md`
  "Contracts (0a)" and "Server modules"; API.md (C47's sections); `SH/schemas/{mcp,web-search}.ts`; `S/deps.ts:175`
  (`BOOT_STEPS`), `:210` (`SHUTDOWN_STEPS`); `S/main.ts:220` (`getBuiltinPlugins(env)`);
  `S/builtin-plugins/index.ts:29` (`getBuiltinPlugins(options: { mockProvider })`); `S/db/schema.ts:74`
  (`McpTransportRecord`); `S/security/types.ts:89-101` (`SafeFetchOptions`), `:117` (`SafeFetch`);
  `S/security/ssrf.ts:579` (the GET / HEAD refusal), `:728` (`createPluginSourceFetch`); `S/testing/fake-remote.ts:38`
  (405 for other methods), `:410` (`serve`), `:585` (`startFakeRemote`), `:685` (`createFakeSafeFetch`);
  `S/testing/create-test-app.ts:284`; `S/services/chats/types.ts:323` (`summary`); the env precedent
  `HF_TEST_FILE_SWEEP_DELAY_MS` (test-only, honored only with `HF_MOCK_PROVIDER=1`).
- **Tasks.**
  1. **C50-T1 Types (additive)** — `S/types.ts`: `AppServices.{ mcpAuth: McpAuthService, elicitations: ElicitationBroker
     }`; `S/mcp/types.ts`: `McpManager` and `ProjectMcpManager` gain `prompts()`, `getPrompt(serverId, name, args,
     signal)`, `resources()`, `readResource(serverId, uri, signal)` and `authTarget(id)` (the storage origin of a
     server: `{ kind: 'user' | 'plugin' | 'project', scope, name }`); `S/db/schema.ts`: `McpTransportRecord` http /
     sse + `oauth?: { clientId: string | null, scopes: string | null }` (TypeScript only; the column is JSON). *Accept:*
     `pnpm typecheck` green; K4's `db:generate` reports no changes.
  2. **C50-T2 `S/mcp/oauth/types.ts` + stub** — `McpAuthService { start(target, { origin, returnTo }), complete(body, {
     origin }), signOut(target), provider(target, mode), info(target), stop() }` with `McpAuthTarget` = `{ kind:
     'global', serverId } | { kind: 'project', projectId, serverId }`, `McpAuthProviderMode` = `'connect' | 'start' |
     'callback'` and the error class `McpAuthRequired` (thrown by the connect mode; C51's classifier recognizes it). The
     stub `createMcpAuthService(deps)` (`S/mcp/oauth/index.ts`): `info` → null; `provider(target, 'connect')` → a
     provider whose `tokens()` answers undefined and whose `clientInformation()` throws `McpAuthRequired` (so a server
     that never answers 401 behaves as today); `start` / `complete` / `signOut` throw `not_implemented`; `stop` a no-op.
     *Accept:* a smoke test per member.
  3. **C50-T3 `S/mcp/elicitation/types.ts` + stub** — `ElicitationBroker { begin(call), handler(runtimeKey),
     answer(chatId, elicitationId, body), pendingCount(chatId), cancelChat(chatId), stop() }`: `begin({ runtimeKey,
     chatId, toolCallId, serverId, serverName, interactive, signal })` returns an in-flight handle that lets the MCP
     tool's generator learn about a request for its call and its settlement (a pending `McpElicitation` or null, change
     notifications, whether the call is waiting — the active budget pauses then) and `end()` removes the call;
     `handler(runtimeKey)` is the `onElicitationRequest` handler of one MCP client; `interactive` = the call runs in the
     main agent (`agentScopeOf(c) !== null`). The stub `createElicitationBroker(deps, options?: { waitMs? })`
     (`S/mcp/elicitation/broker.ts`): `begin` returns a handle that never sees a request, `handler` declines every
     request (`not-interactive`), `answer` → 404 `not_found`, `pendingCount` → 0, `cancelChat` / `stop` no-ops.
     *Accept:* a smoke test per member.
  4. **C50-T4 Deps, environment, boot** — the two factories; `SHUTDOWN_STEPS` per open point 1 (`elicitations` before
     `runs`, `mcpAuth` after `mcp`); `BOOT_STEPS` unchanged (both services are lazy; C50 confirms); `S/env.ts` only if
     the coordinator accepted open point 3's CCR (`HF_TEST_ELICITATION_WAIT_MS`, honored only with `HF_MOCK_PROVIDER=1`,
     1000 … 480 000, else ignored with a warning). *Accept:* `deps.test.ts` checks both orders; `env.test.ts` table (if
     the variable is added).
  5. **C50-T5 `safeFetch` POST (complete)** — `SafeFetchOptions.method: 'GET' | 'HEAD' | 'POST'` and `body?: string |
     Uint8Array` (POST only; ≤ 64 KiB, else `validation_error`; `content-length` set); a POST never follows a redirect
     (a 3xx is returned as the result with its status and headers); the SSRF guard, DNS pinning, `protocols`, caps and
     timeouts unchanged; `createPluginSourceFetch` forwards method and body (the `HF_TEST_REMOTE_URL` reroute included).
     *Accept:* `ssrf.test.ts` (a POST to a private address refused; a 302 answer returned, never followed; the body cap;
     `content-length`; GET and HEAD unchanged; the reroute carries the body).
  6. **C50-T6 Fakes and the test app** — `S/testing/fake-mcp-auth.ts` (scripted `info`, recorded starts / completes /
     sign-outs), `S/testing/fake-elicitations.ts` (scripted requests, recorded answers, `pendingCount`),
     `S/testing/fake-project-mcp.ts` + the manager members; `createTestApp({ mcpAuth?, elicitations? })`; the fake
     remote (`S/testing/fake-remote.ts`) answers POST for `serve()` routes and records the bodies (`{ method, host,
     path, status, body? }`; 405 stays for unregistered methods and paths). *Accept:* `fakes.test.ts`,
     `fake-remote.test.ts`.
  7. **C50-T7 Builtins** — `getBuiltinPlugins(options: Pick<Env, 'mockProvider' | 'testRemoteUrl'>)` (call site
     `S/main.ts:220`); `core-search` registered after `core-tools`; `S/builtin-plugins/core-search/index.ts` with the
     final manifest (`permissions: ['network']`; settings `backend` `brave | tavily | exa` default `brave`,
     `braveApiKey` / `tavilyApiKey` / `exaApiKey` `format: 'secret'`, `maxResults` 1 – 10 default 5) and a body that
     registers no tool (W14.5 implements it), built with `createPluginSourceFetch({ testRemoteUrl })`. A mock-count pin
     in `S/builtin-plugins/index.test.ts` is C50's file: C53 sends the new counts through the coordinator and C50
     applies them. *Accept:* `builtin-plugins/index.test.ts` (the load order; `core-search` loads without a key and
     registers no tool; `GET /plugins/core-search/settings` answers the schema).
- **Tests.** The tasks above.
- **Verify.** Server commands.

### C51 MCP seams (k4)

- **Mission.** Land every MCP-side seam the OAuth, elicitation and prompt / resource agents share, so each P14-A agent
  owns its files alone: `S/mcp/{index,project,errors,stdio-transport}.ts` **complete**; `mcp-tools.ts` as an async
  generator with the budget skeleton; `S/mcp/{prompts,resources,content}.ts` as stubs with final signatures, wired at
  their call sites with unchanged behavior.
- **Owned.** `S/mcp/{index,project,errors,mcp-tools,stdio-transport,prompts,resources,content}*` (the glob also covers
  `project-variables*`, untouched), `S/mcp/__fixtures__/harness.ts`.
- **Read-only highlights.** `.tmp/p14-designs/plan.md` 1 – 3 and the Reconciliation rows (Status name, OAuth provider,
  Elicitation, Prompts, Resources); `server-mcp.md` sections 0 and 3; `explore-mcp.md` A, B; `S/mcp/oauth/types.ts`,
  `S/mcp/elicitation/types.ts`, `S/mcp/types.ts` (C50); `S/mcp/index.ts:46` (`DEFAULT_RETRY_DELAYS_MS`), `:152`
  (`createClient`), `:412-430` (`createTransport`), `:450-455` (`callTool`), `:541-592` (`runConnect`), `:760-820` (the
  DTOs); `S/mcp/project.ts:504-506` (`createTransport`), `:627` (`canStart`); `S/mcp/errors.ts:10`
  (`NON_RETRYABLE_CODES`), `:47` (`isPermanentMcpError`), `:103` (`connectionErrorInit`);
  `S/mcp/stdio-transport.ts:276-280` (notifications); `S/mcp/mcp-tools.ts:96` (`mcpToolDefinition`);
  `S/chat/tools.ts:136-140` (`clampToolTimeout`), `:520-630` (`streamToolCall`); `S/chat/agent-scope.ts:52`
  (`AgentRunScope`; `agentScopeOf(c)` is null in children); `P/index.d.ts:471`, `:858`, `:931`, `:934`, `:1039`
  (`MCPTransportConfig`), `:1100` (`MCPClientConfig`), `:1236`; `S/mcp/__fixtures__/harness.ts:103` (`callTool`),
  `:160-170` (the stateless JSON fixture).
- **Tasks.**
  1. **C51-T1 Connect-mode auth provider** — `createTransport` (`index.ts:412-430`, `project.ts:504-506`) adds
     `authProvider: deps.mcpAuth.provider(target, 'connect')` to http / sse transports **without** an `Authorization`
     header (case-insensitive); `redirect: 'error'` stays; **no `fetch` option**. *Accept:* a test pins the transport
     configuration (`{ type, url, headers, redirect: 'error', authProvider? }`, never `fetch`).
  2. **C51-T2 `needs-auth`** — `S/mcp/errors.ts` `isAuthRequired(error)` (`UnauthorizedError`, `McpAuthRequired`, an
     HTTP 401) → `HarnessError auth_invalid { status: 401 }`, permanent (no backoff retry; the retry schedule of
     `index.ts:46` never starts); the runtime status `needs-auth` (DTO `mcpStatusSchema`, project state `needs-auth`); a
     `callTool` (`index.ts:450`) that fails for auth moves the server to `needs-auth` (tools unavailable, also to
     children and background tasks); a 401 from a server with an `Authorization` header is `needs-auth` too (its row
     cannot sign in, open point 6). *Accept:* a loopback `node:http` server answering 401 → `needs-auth` with exactly
     one connect attempt within 3 s (fake timers); an existing 500 / network failure still retries.
  3. **C51-T3 DTO decoration** — `McpServer.transport.oauth` (from the row / declaration) and `McpServer.auth` =
     `deps.mcpAuth.info(target)` where the DTOs are built (`index.ts:760-820`); `ProjectMcpServer.auth` (`project.ts`);
     open point 10. *Accept:* DTO tests; a v1.8.1 row without `oauth` → `oauth: null`, `auth: null`.
  4. **C51-T4 Elicitation capability** — `createClient` passes `capabilities: { elicitation: {} }`; after connect
     `client.onElicitationRequest(ElicitationRequestSchema, deps.elicitations.handler(runtimeKey))`; a server that
     negotiated protocol `2026-07-28` (read from the client's initialize result; verify the field in `P/index.d.ts`)
     reconnects once without the capability, remembered per server in memory (cleared when its configuration changes).
     *Accept:* a test with the SDK's test server: the handler receives a request; the `2026-07-28` path reconnects once.
  5. **C51-T5 `mcp-tools.ts` generator and budget skeleton** — `execute` becomes `async *`: `deps.elicitations.begin({
     runtimeKey, chatId: c.chatId, toolCallId: c.toolCallId, serverId, serverName, interactive: agentScopeOf(c) !==
     null, signal })` around `callTool`, `end()` in `finally`; the definition's `timeoutMs` 600 000 (outer) and an
     active budget of 60 000 ms on `callTool`'s own abort controller (unpaused in P14-0b, so behavior equals today's 60
     s guard); the generator yields `{ status: 'input-required', elicitation }` when its handle reports a pending
     request and `{ status: 'running' }` after it settles (nothing else in P14-0b); the final output = today's
     `mcpToolOutput` + `elicitations?` (records), which `mcpModelOutput` strips. *Accept:* `mcp-tools.test.ts`; every
     existing MCP tool test green through the generator.
  6. **C51-T6 Prompt / resource call sites and stubs** — `S/mcp/prompts.ts` (`createPromptCache` with `refresh(runtime,
     client, signal)`, `list(serverId)`, `get(…)`), `S/mcp/resources.ts` (`createResourceCache`, `refresh`, `list`,
     `read`), `S/mcp/content.ts` (`mcpContentText(content, options)` = today's JSON-text behavior): final signatures,
     stub bodies (empty lists; `get` / `read` throw `not_implemented`); `runConnect` calls `refresh` after the tool
     listing when the server advertises `capabilities.prompts` / `capabilities.resources`; stdio
     `notifications/prompts/list_changed` and `notifications/resources/list_changed` (`stdio-transport.ts:276-280` →
     `onNotification`) refresh; the manager members delegate to them; `authTarget(id)`. *Accept:* typecheck; one smoke
     test per stub.
  7. **C51-T7 Test harness** — `S/mcp/__fixtures__/harness.ts` `callTool` (`:103`) drains async generators (returns the
     final output; exposes the preliminary outputs for tests). *Accept:* every MCP test green.
- **Tests.** The tasks above; every existing MCP and project MCP test stays green.
- **Verify.** Server commands.

### C52 chat seams (k5)

- **Mission.** Land every chat-side seam the search, elicitation and prompt agents share: `approval.ts`, `pipeline.ts`,
  `prepare.ts`, `agent-scope.ts`, `subagent/{host,index,tools}.ts` and the chats routes **complete**; `S/chat/search/**`
  and the MCP branch of `commands.ts` as stubs with final signatures, wired with unchanged behavior.
- **Owned.** `S/chat/**` (not `background/types.ts`), `S/http/routes/chats*`.
- **Read-only highlights.** `.tmp/p14-designs/plan.md` 2 – 4 and the Reconciliation rows (Search: native, approval /
  history, mode + resolver, builtin; Elicitation; Prompts); `server-search.md` (Verified facts, ADR-S1 / S2, "Server
  modules"); `explore-search.md` A, C; `S/chat/approval.ts:372` (`createToolApproval`), `:416-418` (unknown names
  denied); `S/chat/pipeline.ts:892` (project MCP tools), `:1025-1029` (tools / history), `:1047` (`streamText`), `:1093`
  (`sendSources`), `:1097-1123` (the transform chain, `generatedFiles`); `S/chat/generated-files.ts:9-11`, `:207` (the
  precedent of an injecting transform); `S/chat/params.ts:387` (`providerReasoning`); `S/chat/prepare.ts:468`
  (`resolveCommand`); `S/chat/commands.ts:126` (`COMMAND_PREFIX`), `:129` (`parseSlashCommand`);
  `S/chat/subagent/index.ts:858` (the child `streamText`); `S/chat/hooks.ts:954` (`notification`);
  `S/chat/agent-scope.ts:52`; `ai@7.0.148` `dist/index.d.ts` `GenericToolApprovalFunction` (`toolCall: TypedToolCall`)
  and `dist/index.js:7898-7951` (the approval function runs for provider-executed calls too).
- **Tasks.**
  1. **C52-T1 `approval.ts` (complete)** — at the very top of the function returned by `createToolApproval`: a call
     whose `toolCall.providerExecuted === true` and whose name is in `context.nativeTools` → `{ type: 'not-applicable'
     }` (no hooks, no `settle`, no records); a `nativeTools` name without the flag → denied; unknown names stay denied.
     `ToolApprovalContext.nativeTools: ReadonlySet<string>` (empty by default). *Accept:* `approval.test.ts` (pinned: a
     provider-executed native call is `not-applicable` with zero hook calls; the same name without the flag is denied;
     an unknown name is denied).
  2. **C52-T2 `pipeline.ts` (complete)** — the effective mode (`prepare`), then `resolveWebSearch({ mode, toolMode,
     native: catalogModel.webSearch, preferNative: settings.webSearchNative, builtinAvailable: search_web of core-search
     in assembled.byName, modelTools, functionTools: the assembled function tools without search_web })`;
     `providerWebSearch(resolved, request, logger)` and `applyWebSearch(assembled, resolution, params)` (stubs in
     `S/chat/search/resolve.ts`; the stub `providerWebSearch` answers undefined) → the tools passed to `streamText`
     (native provider tools merged; `search_web` removed unless `builtin`), `byName`, `activeTools` (+ the native names
     when set), `nativeTools` (into the approval context), provider options merged; the history stage
     (`S/chat/search/history.ts` stub = identity) before `toolPartsAsText`; the sources transform
     (`S/chat/search/sources.ts` stub = pass-through) after `generatedFiles` in the chain; the notice
     `web-search-unavailable` (info; once per chat / model / reason, an in-memory set per chat); `agentScope.notify`
     bound to the run's `hooks.notification` (`hooks.ts:954`). *Accept:* every existing chat test green; seam tests with
     `MockLanguageModelV4` and a test provider with a `webSearch` hook: native tools reach `streamText` only when the
     resolution is native; `search_web` absent when off or native; the notice once.
  3. **C52-T3 `prepare.ts` and `commands.ts` (complete / stub)** — the effective mode: body `webSearch` > chat
     `settings.webSearch` > `settings.webSearchDefault`; a new chat saves the body's value as `settings.webSearch`
     (open point 4). `resolveCommand` (`prepare.ts:468`) receives `CommandServices.mcp` / `projectMcp` and
     `CommandContext.projectId`; the MCP branch of `S/chat/commands.ts` (`resolveCommand`, `isServerCommandFor`,
     `listServerCommands` with its new parameter) is a stub that answers "not an MCP prompt" (falls through);
     `parseSlashCommand` accepts `mcp__…` names (`COMMAND_PREFIX` `:126` has no `_` today). *Accept:* typecheck; every
     existing command test green; `/mcp__x__y` parses.
  4. **C52-T4 Sub-agents (complete)** — `subagent/{host,index,tools}.ts`: the child's resolution against the child's
     model with the same resolver and apply (around `index.ts:858`); children inherit the chat's mode; native and
     builtin never together; children have no agent scope, so their MCP calls are non-interactive. *Accept:* every
     sub-agent test green; a seam test (a child gets `search_web` when the builtin wins).
  5. **C52-T5 `agent-scope.ts` (complete)** — `AgentRunScope.notify?(input: { message: string, notificationType:
     'elicitation_dialog' })`. *Accept:* typecheck; a seam test (the hook receives the type).
  6. **C52-T6 Chats routes (complete)** — `S/http/routes/chats*`: list and detail summaries carry `awaitingInput:
     deps.elicitations.pendingCount(id) > 0` (open point 2). *Accept:* route tests with the C50 fake.
  7. **C52-T7 Search stubs** — `S/chat/search/{resolve,history,sources}.ts` with final signatures (`providerWebSearch`,
     `applyWebSearch`, `stripForeignProviderParts` (name fixed by C52), `createSourcesTransform`); a shared
     `S/chat/search/types.ts` only if needed (frozen after the gate). *Accept:* typecheck; one smoke test per stub.
- **Tests.** The tasks above; every existing chat test stays green.
- **Verify.** Server commands.

### C53 mocks, fixtures and fakes (k6)

- **Mission.** The mock models `mock:search` and `mock:search-tool`, the mock provider's `webSearch` hook, the OAuth MCP
  fixture, `createFakeSearchFetch` and the e2e fake remote — **complete** (frozen after the gate; they drive every probe
  and e2e spec). The contract is the section "Mock and fixture contract" below.
- **Owned.** `S/builtin-plugins/mock/**`, `S/mcp/__fixtures__/oauth-mcp-server*`, `S/testing/fake-search*`,
  `e2e/fixtures/fake-remote.mjs`.
- **Read-only highlights.** `.tmp/p14-designs/plan.md` 7 and 9; `server-mcp.md` section 4; `server-search.md` (Mocks,
  Backend HTTP shapes); PROVIDERS.md 8 (D19 writes it from this file); `S/builtin-plugins/mock/models.ts:55`
  (`MOCK_MODEL_IDS`), `mock/index.ts:254` (`smallModelId: 'echo'`), `mock/hooks.ts:27-31` (`call <tool> <json>`);
  `S/mcp/__fixtures__/{harness.ts,echo-server.mjs,mcp-min.mjs}`; `S/testing/fake-remote.ts` (the routing and log
  style); `node_modules/@modelcontextprotocol/sdk` 1.32.1 (server, Streamable HTTP transport, `elicitInput`).
- **Tasks.**
  1. **C53-T1 `mock:search`** (`S/builtin-plugins/mock/search.ts`; the 19th mock) and the mock provider's `webSearch`
     hook — exactly as the contract below. *Accept:* `mock/index.test.ts` / `models.test.ts` (offered / not offered; the
     parts; the usage).
  2. **C53-T2 `mock:search-tool`** (the 20th) — exactly as the contract below. *Accept:* the same test files.
  3. **C53-T3 OAuth MCP fixture** (`S/mcp/__fixtures__/oauth-mcp-server.mjs` + a `.d.mts` like `echo-server`) — exactly
     as the contract below; a script (`node oauth-mcp-server.mjs --port 0 …`) and an importable ESM module. *Accept:* a
     smoke test per endpoint, tool, prompt, resource, toggle and counter (with the real SDK client of `@ai-sdk/mcp`).
  4. **C53-T4 `createFakeSearchFetch`** (`S/testing/fake-search.ts`). *Accept:* a smoke test per backend and mode.
  5. **C53-T5 e2e fake remote** (`e2e/fixtures/fake-remote.mjs`). *Accept:* a smoke test in
     `S/testing/fake-search.test.ts` that starts the script on port 0 and queries each route (the script is plain Node,
     no TypeScript).
  6. **C53-T6 Pins** — the mock listing (`MOCK_MODEL_IDS`, the `modelCount` and listing counts; PROVIDERS.md 8 numbers)
     inside `mock/**`; the counts in `S/builtin-plugins/index.test.ts` through C50 (relayed by the coordinator); the
     spawn allowlist unchanged at 3 modules.
- **Tests.** The tasks above.
- **Verify.** Server commands.

### C54 web skeleton

- **Mission.** Freeze the web side of Phase 14: every new test id, the two routes and the nav entry, the stub components
  with their final props, emits and root test ids, the `web-search` store and the store additions (inert), the
  composables `useMcpSignIn` and `useResourceMentions`, the `TOOL_ELICITATIONS` injection, the session and event wiring
  (complete) and the mounts through the hot files.
- **Owned.** `W/utils/testids.ts`, `W/utils/testing/**`, `W/pages/oauth/**`, `W/pages/settings/search.vue`,
  `W/components/app-shell/{SettingsNav*,chat-nav/ChatNavRow*}`, `W/components/oauth/**`, `W/components/plugins/mcp/**`,
  `W/components/projects/mcp/**`, `W/components/chat/{composer,parts}/**`,
  `W/components/chat/{ChatMessage,ChatView,ChatTranscript}*`, `W/components/settings/search/**`,
  `W/stores/{web-search,plugins,project-mcp,chats,customizations}*`,
  `W/composables/{useMcpSignIn,useResourceMentions,useChatSession,useServerEvents,useComposerAttachments}*`.
- **Read-only highlights.** UI.md 2.20, 5.5, 6, 7.35, 8.14, 9.15, 10.10, 11.10, 12, 13.14, 14, 15 (D19);
  `.tmp/p14-designs/web-waves.md` part 1 (with the reconciliation above); `SH/schemas/{mcp,web-search,chats,tools}.ts`,
  `SH/util/{mcp-elicitation,web-search,mentions,mcp-prompts}.ts`; facts: `W/components/plugins/mcp/mcp-form.ts:67-96`
  (status maps, `mcpStatusText`), `W/stores/plugins.ts:366` (`fetchMcp`),
  `W/components/chat/composer/slash-commands.ts:30-39` (`SlashGroup`, `SLASH_GROUPS`),
  `W/components/chat/composer/ChatComposer.vue:1085` (the toolbar), `W/components/chat/parts/ToolPart.vue:564`
  (`ToolApprovalCard`), `W/components/chat/parts/tool-approval-context.ts` (the injection precedent),
  `W/composables/useChatSession.ts:380` (`buildChatRequestBody`), `W/composables/useFileMentions.ts:61`,
  `W/composables/useComposerAttachments.ts:229` (`addProject`), `W/layouts/auth.vue`, `playwright.config.ts:4`.
- **Tasks.**
  1. **C54-T1 Test ids** — the ids of UI.md 13.14 in `utils/testids.ts` (key = the camelCase of the id) under a `// MCP
     2.0 and web search (Phase 14)` comment. The draft list (web-waves.md, reconciled; UI.md 13.14 wins on any
     difference, reported): MCP sign-in `mcp-sign-in`, `mcp-sign-out`, `mcp-sign-in-error`, `mcp-oauth-section`,
     `mcp-oauth-client-id`, `mcp-oauth-client-secret`, `mcp-oauth-scopes`, `mcp-oauth-redirect-uri`,
     `project-mcp-sign-in`, `project-mcp-sign-out`, `oauth-callback` (`data-state` working | success | error),
     `oauth-callback-error` (`data-code`), `oauth-callback-retry`, `oauth-callback-back`; mentions
     `mention-menu-section` (`data-value` files | resources), `mention-menu-resource` (`data-server-id`, `data-uri`);
     elicitation `elicitation-card` (`data-state` pending | submitting | expired, `data-server-id`),
     `elicitation-message`, `elicitation-field` (`data-name`, `data-type`), `elicitation-field-error`,
     `elicitation-submit`, `elicitation-decline`, `elicitation-dismiss`, `elicitation-countdown`, `elicitation-result`
     (`data-action` accept | decline | cancel | timeout), `elicitation-jump`; web search `composer-web-search`
     (`data-state` off | on | unavailable, `data-mode` native | builtin), `web-search-unavailable` (`data-reason`),
     `web-search-setup`, `sources-chip` (`data-domain`), `source-item` (`data-domain`), `web-search-result`
     (`data-domain`), `settings-nav-search`, `settings-search-native`, `settings-search-default`,
     `settings-search-backend` (`data-value`), `settings-search-key` (`data-backend`, `data-state`),
     `settings-search-key-save`, `settings-search-key-remove`, `settings-search-max-results`, `settings-search-test`,
     `settings-search-test-result`; new values on existing ids `mcp-status[data-value=needs-auth]`,
     `chat-status-dot[data-status=input]`, `slash-menu-item[data-group=mcp]` (UI.md 13.14 is the list: about 45 ids).
  2. **C54-T2 Routes and nav** — `W/pages/oauth/callback.vue` (`definePageMeta({ layout: 'auth' })`, a thin page around
     the `OAuthCallbackView` stub; the auth middleware still runs: an expired session goes to `/login?redirect=…` with
     the query kept); `W/pages/settings/search.vue` (around the `WebSearchSettings` stub); `SettingsNav` entry "Web
     search" (`settings-nav-search`, after Media). *Accept:* `SettingsNav.test.ts`, route tests (the callback page has
     no sidebar, so `rememberRoute` never sees it).
  3. **C54-T3 Stub components** — each renders its root test id and declares exactly (UI.md 10.10 wins where it is more
     precise; report the difference):
     ```ts
     OAuthCallbackView   {}                                         // components/oauth/; reads the route query once
     McpOAuthFields      { modelValue: McpOAuthDraft; transport: 'http' | 'sse'; clientSecret: SecretState | null;
                           redirectUri: string; disabled?: boolean }   // components/plugins/mcp/
                         // emits update:modelValue: [McpOAuthDraft]
     ElicitationCard     { elicitation: McpElicitation; busy?: boolean; now?: number }   // components/chat/parts/
                         // emits respond: [McpElicitationAnswerBody]
     WebSearchToggle     { modelValue: boolean; resolution: WebSearchResolution; backendLabel: string | null;
                           returnFocusTo?: HTMLElement | null }    // components/chat/composer/
                         // emits update:modelValue: [boolean], setup: []
     WebSearchToolBody   { part: ToolUIPartView; providerExecuted: boolean }   // components/chat/parts/tools/
     WebSearchSettings   {}                                         // components/settings/search/
     ```
     `McpOAuthDraft` (`{ clientId, scopes, clientSecret: string | null }`) and `ToolUIPartView` (the existing tool part
     view type of `ToolPart`, or C54's alias) are C54's; the DTO types come from `@harness-forge/shared`. *Accept:* one
     stub mount test per component (root test id, props accepted).
  4. **C54-T4 Stores, composables and injections (inert, typed)** — `useWebSearchStore` (`W/stores/web-search.ts`):
     state from `GET /plugins/core-search/settings` (backend, key states, `maxResults`) and the two global settings
     (through the settings store), getters `builtinAvailable` (open point 5), `backendLabel`; actions `fetch({ maxAgeMs?
     })`, `saveBackend`, `saveKey(backend, value | null)`, `saveMaxResults`, `test(backend?)`, `applyEvent(event)`
     (`plugin.changed` for `core-search`). The plugins store `signInMcp(id, returnTo)` / `signOutMcp(id)`; the
     project-mcp store `signIn(projectId, serverId, returnTo)` / `signOut(projectId, serverId)`; the chats store keeps
     `awaitingInput` (absent = unchanged, open point 2). `useMcpSignIn().start({ kind, serverId, projectId?, returnTo
     })` → `'authorized' | 'redirected'` (same-tab `location.assign` through a mockable local module; `returnTo` checked
     with `safeRedirectPath`). `useResourceMentions({ projectId, text, caret, enabled })` (the `mentionTokenAt` token of
     the file mentions; `GET /mcp/resources` with a 15 s max age; enabled when tools are on, also without a project);
     `useComposerAttachments().addResource(fileRef)`. `TOOL_ELICITATIONS`
     (`W/components/chat/parts/tool-elicitation-context.ts`: `forCall(toolCallId) → McpElicitation | null`,
     `busy(elicitationId)`,
     `respond(elicitationId, answer)`; no `unlinked()`). UI.md 11.10 wins on any difference. *Accept:* store shape
     tests; the composables type-check.
  5. **C54-T5 Session, events and sidebar (complete)** — `useChatSession`: `webSearch: WritableComputedRef<boolean>`
     (picked > the chat's `settings.webSearch` > `webSearchDefault`; persisted with `chats.update`; in
     `buildChatRequestBody` as `webSearch: 'auto' | 'off'`), `elicitations` (computed from the running MCP tool parts
     whose latest preliminary output is `input-required`), `respondElicitation(id, answer) → 'answered' | 'gone'` (404 /
     409 → `gone`), `ChatSessionRunState` + `'input'` (`toListRunState('input')` → `'input'`; a session with a pending
     request is never evicted); `useServerEvents`: `chat.updated.awaitingInput` → the chats store, `plugin.changed` →
     the web-search store; `ChatNavRow`: `input` → the `approval` dot labelled "Needs your input". *Accept:*
     `useChatSession.test.ts` (the body; persistence; `respondElicitation` mapping; eviction),
     `useServerEvents.test.ts`, `ChatNavRow.test.ts`.
  6. **C54-T6 Mounts** — `ChatComposer`: the `WebSearchToggle` stub after `OutputStyleMenu` (hidden for image models);
     `MentionMenu`: optional `resources` / `resourcesState` props and the `select-resource` emit; `ComposerAddMenu`:
     optional `mentionResources`; `ToolPart`: the `ElicitationCard` stub under a running MCP row (through
     `TOOL_ELICITATIONS`) and `WebSearchToolBody` for `search_web` and provider-executed rows; `SourcesPart`: the chips
     slot; `ChatView` / `ChatTranscript`: `TOOL_ELICITATIONS` provided from the session; `McpServersPanel` /
     `McpServerDialog` (the `McpOAuthFields` stub in the HTTP and SSE tabs) / `ProjectMcpServerRow` /
     `ProjectMcpDialog`: the Sign in / Sign out slots. *Accept:* the existing `ChatComposer`, `MentionMenu`, `ToolPart`,
     `SourcesPart`, `McpServersPanel`, `McpServerDialog`, `ProjectMcpDialog`, `ProjectMcpServerRow`, `ChatNavRow`,
     `useChatSession` tests stay green; mount tests for the new mounts.
- **Tests.** The tasks above; `W/components/template-literals.test.ts` stays green (no `//` in component prop values:
  the redirect URI is built in script, `window.location.origin + '/oauth/callback'`).
- **Verify.** Web commands (`typecheck:fast` needs the coordinator's `.nuxt`; import new components by path).

### G14B upgrade and seam probes (:8898)

- **Mission.** Write `.tmp/gates/P14-0b/{upgrade-probe-v181,seam-probe-v19}.mjs` during the wave (from the Phase 12
  `.tmp/gates/P12-0b/{upgrade-probe-v17,seam-probe-v18}.mjs` and `probe-lib.mjs`) and run them on :8898 after the
  coordinator's build signal; report every check ("spec differs" with the evidence when the code is right and the spec
  is not).
- **Owned.** `.tmp/gates/P14-0b/**` (not K3S's seed files).
- **Checks.** See Gate P14-0b steps 5 and 6.

### Wave P14-0b ownership

The audit cannot express "except": `S/testing/fake-search*` matches C50's `S/testing/**` but is C53's;
`S/testing/api-samples.ts` stays C47's file from P14-0a (untouched in P14-0b); `S/chat/background/types.ts` stays
frozen; `S/mcp/project*` also matches `project-variables*` (C51's, untouched). C50 – C54 list the count pins and
fixtures outside their globs in their reports (`*-test-fixes`, `C50-compile-fixes`).

```json
{
  "wave": "P14-0b",
  "agents": {
    "K4": [
      "playwright.config.ts",
      "package.json",
      "e2e/README.md"
    ],
    "C50": [
      "apps/server/src/types.ts",
      "apps/server/src/deps*.ts",
      "apps/server/src/env*.ts",
      "apps/server/src/main.ts",
      "apps/server/src/db/schema.ts",
      "apps/server/src/mcp/types.ts",
      "apps/server/src/mcp/oauth/{types,index}.ts",
      "apps/server/src/mcp/elicitation/{types,broker}.ts",
      "apps/server/src/security/{types,ssrf}*",
      "apps/server/src/testing/**",
      "apps/server/src/builtin-plugins/index.ts",
      "apps/server/src/builtin-plugins/index.test.ts",
      "apps/server/src/builtin-plugins/core-search/**"
    ],
    "C51": [
      "apps/server/src/mcp/{index,project,errors,mcp-tools,stdio-transport,prompts,resources,content}*",
      "apps/server/src/mcp/__fixtures__/harness.ts"
    ],
    "C52": [
      "apps/server/src/chat/**",
      "apps/server/src/http/routes/chats*"
    ],
    "C53": [
      "apps/server/src/builtin-plugins/mock/**",
      "apps/server/src/mcp/__fixtures__/oauth-mcp-server*",
      "apps/server/src/testing/fake-search*",
      "e2e/fixtures/fake-remote.mjs"
    ],
    "C54": [
      "apps/web/app/utils/testids.ts",
      "apps/web/app/utils/testing/**",
      "apps/web/app/pages/oauth/**",
      "apps/web/app/pages/settings/search.vue",
      "apps/web/app/components/app-shell/SettingsNav*",
      "apps/web/app/components/app-shell/chat-nav/ChatNavRow*",
      "apps/web/app/components/oauth/**",
      "apps/web/app/components/plugins/mcp/**",
      "apps/web/app/components/projects/mcp/**",
      "apps/web/app/components/chat/{composer,parts}/**",
      "apps/web/app/components/chat/{ChatMessage,ChatView,ChatTranscript}*",
      "apps/web/app/components/settings/search/**",
      "apps/web/app/stores/{web-search,plugins,project-mcp,chats,customizations}*",
      "apps/web/app/composables/{useMcpSignIn,useResourceMentions,useChatSession,useServerEvents,useComposerAttachments}*"
    ],
    "G14B": [
      ".tmp/gates/P14-0b/**"
    ]
  },
  "allow": [
    "docs/ROADMAP.md",
    "docs/DECISIONS.md",
    "AGENT.md",
    "docs/phases/phase-14-v1-9.md",
    ".tmp/**"
  ]
}
```

### Wave P14-0b cross-agent contracts

| Producer → consumer | Contract |
|---|---|
| C50 → C51, C52, W14.1, W14.3, W14.5, W14.6 | `McpAuthService` (+ `McpAuthTarget`, the provider modes, `McpAuthRequired`), `ElicitationBroker` (+ the in-flight handle), the manager members (`prompts`, `getPrompt`, `resources`, `readResource`, `authTarget`), `safeFetch` POST, `createTestApp({ mcpAuth, elicitations })` and the fakes, the `core-search` manifest and settings, `getBuiltinPlugins` options, the start / stop order |
| C51 → W14.1 – W14.3 | the connect-mode `authProvider` call site, the `needs-auth` classification, the DTO decoration through `mcpAuth.info`, the elicitation capability + handler registration, the `2026-07-28` reconnect, the `mcp-tools.ts` generator + budget skeleton + `begin` / `end`, the prompt / resource / content stubs and their call sites, the harness |
| C52 → W14.2 – W14.5 | `nativeTools` in the approval context, the resolution and merge in the pipeline and the sub-agents, the effective mode, `agentScope.notify`, `awaitingInput` in the chats routes, the stubs `S/chat/search/{resolve,history,sources}.ts` and the MCP branch of `commands.ts` |
| C53 → W14.1 – W14.6, G14P, W14.11 | `mock:search`, `mock:search-tool` and the provider hook (PROVIDERS.md 8), the OAuth fixture, `createFakeSearchFetch`, the e2e fake remote |
| C53 → K4 | `e2e/fixtures/fake-remote.mjs` and its port option |
| C54 → W14.7 – W14.10 | the stub components, the `web-search` store and the store additions, `useMcpSignIn`, `useResourceMentions`, `TOOL_ELICITATIONS`, `addResource`, the session and event wiring (frozen) |
| C54 → everyone | `utils/testids.ts` (frozen after the gate) |

### Gate P14-0b

1. `node scripts/audit-ownership.mjs .tmp/waves/P14-0b.json`
2. `pnpm db:generate` → no changes (K4).
3. `nuxi prepare` → `pnpm check` → `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
4. `mv .tmp/e2e .tmp/e2e-old-p14-0b` (a cached mock listing hides the new mocks; `mv`, not `rm -rf`) → the fake remote +
   `pnpm start:e2e` → `pnpm test:e2e` (215 still green, now with the fake remote in `webServer`).
5. **Upgrade probe (G14B)** on a fresh copy of the K3S seed (never on `.tmp/e2e`, never on the seed itself), on :8898,
   with the OAuth fixture started on the seeded ports (open point 8):
   ```sh
   d=.tmp/gates/P14-0b/upgrade-$(date +%s); cp -R .tmp/upgrade-v181 "$d"   # data + roots
   # before boot, by SQL: projects.path → "$PWD/$d/roots/<p>", the global stdio server's path → the copied fixture
   HF_MOCK_PROVIDER=1 HF_OFFLINE=1 HF_PORT=8898 HF_DATA_DIR="$d/data" \
     HF_WORKSPACE_ROOTS="$PWD/$d/roots" HOME="$d/home" node apps/server/dist/main.mjs &
   # through node + @libsql/client, ids from .tmp/upgrade-v181-ids.json:
   #   SELECT count(*) FROM __drizzle_migrations;                          -> 10 (no migration applied)
   #   PRAGMA foreign_key_check; PRAGMA integrity_check;                  -> no rows; ok
   #   counts of chats, messages, mcp_servers, plugins, project_trust, hooks, customizations -> seeded
   ```
   Then, logged in with the seeded password: every seeded chat opens (stored messages byte-identical); `GET
   /projects/<p>/trust` lists every seeded approval as `approved` **with the seeded sha256** (the `.mcp.json` server
   with `oauth` included) and the pending approval is still pending; `GET /projects/<p>/mcp` shows the `oauth` project
   server `needs-auth` and the fixture's counter shows **one** connect attempt and no retry loop over 10 s; the Claude
   plugin's OAuth server `needs-auth` (its `oauth` now kept, no "not supported" diagnostic); the header-secret servers
   keep their secrets (`SecretState.set`) and their previous behavior (down → `error` with retries); `GET /chats/<id>`
   settings have no `webSearch`; a `mock:search` turn in a seeded chat answers "Search off"; `GET /settings` has
   `webSearchDefault: 'off'` and `webSearchNative: true`; the v1.8.1 backup zip restores; nothing new ran (no hook
   sentinel, no stdio process of a pending item). Stop the probe server and the fixture (kill by port).
6. **Seam no-op probe (G14B)** — the Phase 12 seam probe (`.tmp/gates/P12-0b/seam-probe-v18.mjs` checks, on a copy of
   the roots) passes unchanged; `GET /models` lists `mock:search` and `mock:search-tool` (their `webSearch` stays null
   until W14.4 computes it in `S/catalog/merge.ts`, so no turn resolves native yet); an MCP tool of the echo fixture
   still works through the generator; `mock:search` with search `off` (and, in P14-0b, with `auto` too) answers "Search
   off"; `core-search` loads without a key and `GET /tools` has no `search_web`; `POST /web-search/test`
   still answers 501; `safeFetch` POST reaches the fake remote (unit-proven; a probe check through the test route is
   P14-A's); the other eight new routes answer 501 (or their stub behavior).
7. FREEZE additions (see "FREEZE in Phase 14") → ROADMAP + wave log → commit `feat: add phase 14 skeletons and seams`.

---

## Mock and fixture contract (complete and frozen after P14-0b)

C53 builds this; PROVIDERS.md 8 "MCP and search mocks (Phase 14)" (D19) is the probe contract for the two mock models
and wins on any difference (reported); the fixture's header comment is the reference for the OAuth fixture after
P14-0b; this section summarizes both.

### `mock:search` and the mock provider's `webSearch` hook

- The mock provider gains `webSearch(model, request)`: for model id `search` it answers `{ tools: { web_search: { type:
  'provider', id: 'mock.web_search', args: {}, isProviderExecuted: true } } }` (the AI SDK's `ProviderExecutedTool`
  shape, verified in `@ai-sdk/provider-utils` `dist/index.d.ts`); for every other mock model `undefined`. Once W14.4
  probes the hook in `S/catalog/merge.ts`, the catalog lists `mock:search` with `webSearch: 'native'` and every other
  mock with `webSearch: null`.
- `mock:search` (the 19th mock model, `S/builtin-plugins/mock/search.ts`): `kind: 'chat'`, `capabilities.tools: true`;
  it streams at once (no waits) and ignores the reasoning setting and the output-token cap; usage fixed at 10 input / 5
  output tokens.
- **When `web_search` is among the offered tools** (native resolution): one step that streams a `tool-call` named
  `web_search` with `providerExecuted: true` and input `{ "query": <the last user text, trimmed, ≤ 200 code points> }`,
  its `tool-result` (`providerExecuted: true`, a result array of 2 entries `{ type: 'web_search_result', url, title }`),
  then 2 `source` parts (`sourceType: 'url'`, `https://example.com/mock-search-1` "Mock result one" and
  `https://example.org/mock-search-2` "Mock result two"), then the text `Search done: 2 sources`, `finishReason:
  'stop'`. **Otherwise**: the text `Search off`.
- Probe paths: mode `auto` in `ask` and `plan` → a provider-executed `tool-web_search` part, 2 `source-url` parts, no
  `awaitingApproval`, no PreToolUse record; mode `off` or tool mode `off` → "Search off".

### `mock:search-tool`

- The 20th mock model (`S/builtin-plugins/mock/search-tool.ts`): `kind: 'chat'`, `capabilities.tools: true`, no native
  search; the same timing and usage as `mock:search`.
- **When `search_web` is offered and the turn has no `search_web` result yet**: one call `search_web({ "query": <the
  last user text, trimmed, ≤ 400 code points> })`. **After the result**: the text `Results: <title 1> | <title 2> | …`
  (the result titles in order, joined with ` | `; `Results: none` for an empty list); a failed call → `Search failed:
  <error text, ≤ 120 code points>`; a denied call → `The tool call was denied.` (the PROVIDERS.md 8 convention).
  **Without `search_web` offered**: `Tools are disabled.`
- Probe paths: Brave via the fake remote → a `search_web` part followed by `source-url` parts (the transform) in the
  stored message, the share snapshot and the markdown export; no key → "Tools are disabled." and the notice once.

### The OAuth MCP fixture (`S/mcp/__fixtures__/oauth-mcp-server.mjs`)

A script (`node apps/server/src/mcp/__fixtures__/oauth-mcp-server.mjs --port <n> [--host 127.0.0.1] [toggles]`, prints
`{ "url": …, "origin": … }` on its first stdout line) and an importable ESM module (`startOAuthMcpServer(options) → {
url, origin, counters(), setToggle(name, value), stop() }`; C53 fixes the exact names in the `.d.mts`), built only on
`@modelcontextprotocol/sdk` 1.32.1 and `node:http`; loopback only; no file writes.

- **MCP endpoint** `/mcp`: stateful Streamable HTTP with SSE responses (server-to-client requests need a session); every
  request without a valid `Authorization: Bearer <access token>` answers **401** with `WWW-Authenticate: Bearer
  resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="mcp:read mcp:write"`.
- **OAuth endpoints** (same origin): `/.well-known/oauth-protected-resource/mcp` (`resource`, `authorization_servers`),
  `/.well-known/oauth-authorization-server` (issuer, `authorization_endpoint`, `token_endpoint`,
  `registration_endpoint`, `revocation_endpoint`, `code_challenge_methods_supported: ['S256']`), `POST /register`
  (dynamic client registration), `GET /authorize` (validates `client_id`, `redirect_uri`, `code_challenge` S256,
  `state`, `resource`; auto-approves with a 302 to `redirect_uri?code&state&iss`, or with the toggle `approvePage`
  serves a small HTML page with an **Approve** button and a **Deny** button (`error=access_denied`)), `POST /token`
  (`authorization_code` with PKCE verification; `refresh_token`; expiry; a used or unknown code or refresh token →
  `invalid_grant`), `POST /revoke` (RFC 7009; records the call).
- **Tools**: `ask` (input `{ form?: 'basic' | 'all-types' | 'sensitive' | 'multi' | 'unsupported' | 'url' }`, default
  `basic` = `{ name: string (required), email: string format email, count: integer 1..10, subscribe: boolean, color:
  enum red | green | blue }`; elicits that schema and answers `{ action, fields: [<names>] }` — **never the values**);
  `ask_echo` (elicits `basic` and answers `{ action, content }`, to prove the answer arrives); `slow_ask` (waits 2 s,
  then elicits `basic`); `whoami` (no elicitation; answers the token's subject, for "signed in" checks).
- **Prompts**: `greet` (argument `name` required, `greeting` optional; one user text message `"<greeting|Hello>,
  <name>!"`), `review` (an assistant message + a user message), `with_resource` (an embedded text resource
  `fixture://notes/readme.md`), `with_image` (an image content).
- **Resources**: `fixture://notes/readme.md` (`text/markdown`, small), `fixture://notes/large.txt` (`text/plain`, 6 MiB:
  the 413 path), `fixture://images/pixel.png` (`image/png`, base64 blob); a resource template (listed by
  `resources/templates/list`, never by the harness).
- **Counters** (`GET /__counters` or `counters()`): `connects` (initialize requests), `unauthorized` (401 answers),
  `registrations`, `authorizations`, `tokens`, `refreshes`, `revocations`, `promptsGet`, `resourcesRead`,
  `elicitations`, `toolCalls`.
- **Toggles** (flags or `setToggle` / `POST /__toggle`): `preRegistered` (a client `fixture-client` with the secret
  `fixture-secret`; registration refused), `foreignAs <url>` (the protected-resource metadata names another
  authorization server, e.g. `http://169.254.169.254/` or `http://10.0.0.1/`), `noMetadata` (401 without
  `resource_metadata` and no well-known documents), `tokenLifeSec <n>` (short-lived tokens for the refresh path),
  `approvePage` (the HTML approve page instead of auto-approval), `noAuth` (no 401 at all), `protocol2026` (negotiates
  `2026-07-28`).
- **stdio variant** (`--stdio`): the same tools, prompts and resources over stdio without OAuth; a `__touch` tool sends
  `notifications/prompts/list_changed` and `notifications/resources/list_changed`.

### The search fakes

- **`createFakeSearchFetch(options?)`** (`S/testing/fake-search.ts`): a `SafeFetch` for unit tests that maps
  `https://api.search.brave.com/res/v1/web/search` (GET), `https://api.tavily.com/search` (POST) and
  `https://api.exa.ai/search` (POST) to canned results in each vendor's shape (Brave `web.results[].{ title, url,
  description, page_age }`, Tavily `results[].{ title, url, content, published_date }`, Exa `results[].{ title, url,
  highlights | text, publishedDate }` — the shapes W14.5 verifies against the vendor docs and updates here through a CCR
  if they differ); a mode per backend (`ok`, `401`, `403`, `429`, `500`, `timeout`, `oversize`, `bad-json`, `redirect`);
  a request log `{ method, url, headers, body }` (the values of key headers replaced by `<redacted>`); anything unmapped
  is refused.
- **The e2e fake remote** (`e2e/fixtures/fake-remote.mjs`): a standalone Node script (no TypeScript, no repository
  import) on `E2E_FAKE_REMOTE_PORT` (or `--port 0` for probes) serving the `HF_TEST_REMOTE_URL` layout
  `<base>/<host>/<path>` for the three search hosts with deterministic results (`Result one` `https://example.com/a`,
  `Result two` `https://example.org/b`, …; the requested count honored), `401` for the key `invalid-key`, `429` for the
  key `rate-limited`; `GET /__log` (method, host, path, status; never key values) and `POST /__reset`. G14P may start it
  as the search fake of its probes.

---

## Wave P14-A — features

Ten agents and the gate-probe agent G14P in one launch against the P14-0b checkpoint. Only server agents get slots (k1 –
k6); web agents run no server; G14P runs its probes on :8896 – :8898 only after the coordinator's build signal.

### Coordinator actions

- Before the launch: the ownership file `.tmp/waves/P14-A.json` (below), agent prompts with a "what exists now" section,
  their section of this file and "Rules for every Phase 14 agent"; the regression copy of open point 15.
- During the wave: when every server and web agent has reported, the coordinator runs `nuxi prepare` → `pnpm build` and
  sends G14P the build signal (`BUILD_READY`); G14P then runs its probes while the coordinator runs e2e on :8899. Facts
  one agent reports that another needs are relayed with SendMessage.
- **At the gate**: audit; batch the CCRs; `nuxi prepare`; the gate commands and probes below; the screenshot review;
  `pnpm audit`; red items become W14.13 (server) / W14.14 (web) tasks with their globs; the reports are digested into
  `.tmp/waves/P14-A-notes.md` for W14.12. **First cuts if the wave overflows** (in this order): remote token revocation
  → the `Notification` `elicitation_dialog` type → starting project servers only to list resources → resource content in
  tool results → Groq native search → the OpenRouter `plugins` fallback → confidential clients (client secrets) →
  multi-select enum fields (declined instead) → Alt+W → the elicitation jump pill → Exa.

### Wave rules

- Import new components explicitly by path; no `nuxt prepare` mid-wave.
- A new test id, a contract change or a frozen-file edit is a CCR in the report (with a local adapter).
- No doc edits ("For W14.12" notes in the report instead).
- Hot files have exactly one owner (the list in "Rules for every Phase 14 agent");
  `S/mcp/{index,project,errors,stdio-transport}.ts`, `S/chat/{pipeline,approval,prepare,agent-scope}.ts`,
  `S/chat/subagent/{host,index,tools}.ts`, `S/chat/{hooks,tools,steps,markers,model-history}.ts`,
  `S/security/{types,ssrf}.ts`, `S/workspace/shell.ts`, `W/composables/{useChatSession,useServerEvents}*` and
  `W/utils/testids.ts` are frozen.
- Server agents implement behind the C50 – C52 seams and test against them with `MockLanguageModelV4`, the C50 fakes and
  the C53 mocks, OAuth fixture and search fakes; where a feature needs another agent's piece (W14.3 needs W14.2's
  `content.ts` for resource items in tool output, W14.6 needs W14.5's normalized `search_web` output and W14.3's stored
  record shape, the web agents the routes), test against the frozen signature with a fake; the real round trips are
  probed at the gate.
- The mock models and fixtures are frozen: a test that needs another script uses `MockLanguageModelV4` directly or a
  test-local fixture inside the agent's own test file.
- Network in tests: the OAuth fixture on loopback, `createFakeSearchFetch` or the fake remote only; never a real host.
  Fixture processes: started on port 0, stopped in `afterAll`, every pid asserted dead.

### W14.1 mcp-oauth-server (k1)

- **Mission.** MCP sign-in on the server for every origin: the token store, the provider in its three modes, the pending
  flows, the pre-sign-in probe, the URL guard, revocation, the start / callback / sign-out routes, the OAuth config of
  personal, plugin, Claude plugin and project servers.
- **Owned.** `S/mcp/oauth/**` (not `types.ts`), `S/mcp/{user-servers,templating}*`, `S/plugins/claude/mcp*`,
  `S/http/routes/{mcp.,mcp-auth,project-mcp}*`.
- **Read-only highlights.** ADR-059; the plan's Reconciliation rows (Status name, OAuth flow, OAuth provider, Token
  storage, OAuth config) and section 1; `server-mcp.md` sections 0 – 3 (OAuth parts); `explore-mcp.md` B, C; API.md
  (C47's `mcpAuth` section); `SH/schemas/mcp.ts`; `S/mcp/oauth/types.ts`, `S/mcp/types.ts` (`authTarget`) (frozen,
  C50); the C51 call sites (`createTransport`, the classifier, the DTO decoration); `P/index.d.ts:858-930`
  (`OAuthClientProvider`), `:931` (`UnauthorizedError`), `:934` (`auth`); `P/index.js:1281-1476` (`auth` /
  `authInternal`, the state and issuer checks), `:1379` (a confidential client must be tied to its AS), `:780-794` and
  `:1166-1273` (the guard); `S/mcp/user-servers.ts:14-23` (secret names), `:186-195` (the PATCH secret cleanup), `:206`
  (`resolveTransport`); `S/mcp/templating.ts`; `S/plugins/claude/mcp.ts:195-202`; `S/plugins/context.ts:276-285`;
  `S/http/middleware/origin-check.ts:34-46`, `request-info.ts` (`serverOrigin`); `S/security/ssrf.ts` (`safeFetch`
  POST, C50).
- **Tasks.**
  1. **W14.1-T1 Store** (`store.ts`) — the record `{ v: 1, resource, clientId, client?, as?: { issuer,
     authorizationServerUrl, tokenEndpoint }, tokens?: { …, obtainedAt } }` under the plan's names per origin (through
     `authTarget`); every token, code, verifier and secret value registered with `redactor.addSecret`; a record whose
     `resource` or `clientId` no longer matches the server is ignored (and deleted on the next save); removal with the
     server, the plugin (unless `keepData`) and the project. *Accept:* `S/mcp/oauth/store.test.ts` (per origin; the
     mismatch rule; redaction of a logged token).
  2. **W14.1-T2 Provider** (`provider.ts`) — `OAuthClientProvider` per server and mode: **connect** (stored tokens only;
     `clientInformation()` throws `McpAuthRequired` when nothing is stored; `redirectToAuthorization` and `state()`
     throw; `saveTokens` persists refreshes; `invalidateCredentials` deletes accordingly; `invalid_grant` →
     `needs-auth`), **start** (a fresh state and code verifier on the flow; `clientInformation()` omits `client_secret`
     on first use; the redirect URL is captured, never followed by the server), **callback** (client + secret + the AS
     pin from the flow); `clientMetadata` (`client_name: 'harness-forge'`, the redirect URI, `grant_types` code +
     refresh, `token_endpoint_auth_method` per client kind); `validateAuthorizationServerURL` and `validateResourceURL`
     from `guard.ts`. *Accept:* `provider.test.ts` (each mode; no registration in connect mode; a refresh persisted).
  3. **W14.1-T3 Flows** (`flows.ts`) — pending flows in memory keyed by `state` (one per server, ≤ `mcpOAuthFlowsMax`
     20, `mcpOAuthFlowMs` 10 minutes, single use; a new start replaces the old one; dropped on `key.rotated`, server
     delete and `stop()`). *Accept:* `flows.test.ts` (state mismatch, replay, expiry, replacement, the cap) with fake
     timers.
  4. **W14.1-T4 Probe and guard** (`probe.ts`, `guard.ts`) — one unauthenticated `initialize` POST to the MCP URL only
     (open point 12; `redirect: 'error'`, 20 s) reading `WWW-Authenticate` (`resource_metadata`, `scope`), passed to
     `auth()`; `validateAuthorizationServerURL`: https, or the MCP server's own origin, or loopback → loopback; the
     authorization URL handed to the browser must be http(s); a 401 without OAuth metadata → the clearer message ("This
     server asked for sign-in but does not support OAuth."). *Accept:* `probe.test.ts`, `guard.test.ts`
     (`169.254.169.254`, `10.x`, an http AS, same origin, loopback → loopback, a `javascript:` authorization URL).
  5. **W14.1-T5 Start, complete, sign out** (`index.ts`, `revoke.ts`) — `start(target, { origin, returnTo })`: 400 for
     stdio servers and servers with an `Authorization` header, 409 `disabled`, 409 `untrusted` (a pending project
     server), 404 unknown; the probe, then `auth(provider('start'), { serverUrl, scope, resourceMetadataUrl })`;
     `REDIRECT` → `{ authorizationUrl, redirectUri, expiresAt }`, `AUTHORIZED` → `{ authorizationUrl: null, … }` + a
     reconnect. `complete(body, { origin })`: an unknown, used or expired `state` → 409 `stale` (coordinator decision
     A); `error` → a 400 whose message holds the provider's text as plain text (≤ 300); else `auth(provider('callback'),
     { serverUrl, authorizationCode, callbackState, callbackIssuer })` → tokens saved → reconnect → `{ target, status,
     returnTo }`. `signOut(target)`: the record deleted (the configured `oauth.clientSecret` kept) + a best-effort RFC
     7009 revocation through `safeFetch` POST (`revoke.ts`; never blocks, failures at `debug`) → reconnect →
     `needs-auth`. `info(target)` → `{ signedIn, expiresAt, scope, client, issuer }`. *Accept:* `index.test.ts` with the
     C53 OAuth fixture (the start URL carries S256, `state`, `resource` and `redirect_uri = <origin>/oauth/callback`;
     refresh after expiry; `invalid_grant` → `needs-auth`; sign-out hits `/revoke`; `preRegistered` with a configured
     client id + secret; `foreignAs` refused).
  6. **W14.1-T6 Routes** (`mcp-auth.ts`, replacing C47's stub) — every answer of API.md (planned 5.37); the redirect URI
     = `<request Origin>/oauth/callback` (the Origin already passed the origin check; without an Origin header
     `serverOrigin(c)`); `returnTo` validated (`/`-relative, not `//`, ≤ 512); the callback needs the session and the
     Origin check (never public). *Accept:* `S/http/routes/mcp-auth.test.ts`.
  7. **W14.1-T7 Personal servers** (`user-servers.ts`, `routes/mcp.ts`) — input / update `oauth?: { clientId?, scopes?,
     clientSecret? }`; `oauth.clientSecret` stored as the secret `oauth.clientSecret` (null keeps it); `PATCH` keeps
     `oauth.record` and `oauth.clientSecret` unless the URL, the type or the client id changed (`:186-195`); the row's
     `transport.oauth`. *Accept:* `user-servers` / `routes/mcp.test.ts` (PATCH of the name keeps the tokens, PATCH of
     the URL drops them).
  8. **W14.1-T8 Plugin and Claude plugin servers** (`templating.ts`, `S/plugins/claude/mcp.ts`) — the declaration's
     `transport.oauth.clientId` with `{{settings.x}}` resolved; Claude plugin servers keep `oauth` (`clientId`,
     `scopes`; `callbackPort` → the info diagnostic; `headersHelper` still dropped); the record in `plugin:<pluginId>`
     `mcp-oauth.<serverId>`. *Accept:* `templating.test.ts`, `S/plugins/claude/mcp.test.ts`.
  9. **W14.1-T9 Project servers** (`routes/project-mcp.ts`) — `projectStart` / `projectSignOut` through the same
     service; the record in `project:<projectId>` `mcp-oauth.<serverId>`, removed with the project; a v1.8 approval of a
     server with `oauth` stays valid (C49's golden hash). *Accept:* `project-mcp.test.ts` (approve → sign in → project
     delete removes the secret; a pending server → 409 `untrusted`).
  10. **W14.1-T10 Hygiene** — tokens, codes, verifiers, secrets, `state` values and the authorization URL's query never
      in a log line, a DTO, an error message, a backup or a message part; logs carry the server id, the origin kind, the
      step and the outcome. *Accept:* a leak test (canary token values searched in logs, answers and a backup zip).
- **Tests.** The tasks above; the OAuth fixture on loopback only.
- **Verify.** Server commands.

### W14.2 mcp-prompts-resources-server (k2)

- **Mission.** MCP prompts as slash commands and MCP resources as attachable mentions: the caches, the listing with
  shadowing, argument binding, the frozen expansion, `failed` replies, the resource list and attach routes and the
  content mapping.
- **Owned.** `S/mcp/{prompts,resources,content}*`, `S/chat/commands*`, `S/http/routes/{commands,mcp-resources}*`.
- **Read-only highlights.** ADR-061; the plan's Reconciliation rows (Prompts, Resources) and section 3; `server-mcp.md`
  ADR-061 / ADR-062; API.md (C47's `mcpResources` section, `commandSummarySchema`); `SH/util/{mcp-prompts,mentions}.ts`
  (C49); the C51 stubs and call sites; `S/chat/commands.ts:126` (`COMMAND_PREFIX`), `:129` (`parseSlashCommand`), the
  MCP branch signature (C52); `S/chat/prepare.ts:468`; `SH/chat.ts:41` (`commandInvocationSchema`, the 64 KB
  expansion); `S/http/routes/project-files.ts` (the attach precedent: `FileRef`, 413); `P/index.d.ts:1217`
  (`readResource`), `:1228` (`experimental_getPrompt`).
- **Tasks.**
  1. **W14.2-T1 Prompt cache** (`prompts.ts`) — filled on connect (C51's call), on stdio `prompts/list_changed` and on a
     listing when older than 60 s; ≤ `mcpPromptsMax` 200 per server, ≤ 20 arguments each (more → ignored with a
     diagnostic); names through `mcpPromptCommandName`; two prompts mapping to one name → the first wins (logged);
     `customization.changed { kind: 'command' }` on a change. *Accept:* `prompts.test.ts`.
  2. **W14.2-T2 Listing** (`commands.ts` `listServerCommands`, `routes/commands.ts`) — `GET /commands?projectId` adds
     the prompts of **connected** servers (`needs-auth`, pending and failed servers are not listed) with `source:
     'mcp'`, `kind: 'command'`, `mcpServer { id, name }`, `argumentHint` (`mcpPromptArgumentHint`) and the description
     (capped, plain text); project servers only with their `projectId` (a project server shadows a global server of the
     same id). *Accept:* `commands.test.ts`, `routes/commands.test.ts`.
  3. **W14.2-T3 Resolution and expansion** (`resolveCommand`, `isServerCommandFor`) — `/mcp__<server>__<prompt> input`:
     `bindMcpPromptArguments`; a missing required argument → a `failed` reply ("Missing argument: …"); a server that is
     not connected → `failed`; `getPrompt` **once**; the expansion frozen into `metadata.command.expansion` (≤ 64 KB;
     user-only text joined; with assistant messages each wrapped `<prompt-message role="…">`; embedded text resources →
     `<resource uri mimeType>` blocks; images, blobs and links → one-line placeholders); regenerate reuses the stored
     expansion. *Accept:* `commands.test.ts` with the C53 fixture's `greet`, `review`, `with_resource`, `with_image`
     prompts.
  4. **W14.2-T4 Resource cache and list** (`resources.ts`, `routes/mcp-resources.ts`) — filled like the prompt cache; ≤
     `mcpResourcesMax` 1000 per server; templates out; `GET /mcp/resources?projectId&q&limit` → `{ items, truncated,
     unavailable }` (ranked by name / title / uri match; `mention` = `formatResourceMention`); project servers only with
     their `projectId` (started only when the project's chat needs them; first cut). *Accept:* `resources.test.ts`,
     `routes/mcp-resources.test.ts`.
  5. **W14.2-T5 Attach** — `POST /mcp/resources/attach { serverId, uri, projectId? }` → `readResource` → a `FileRef`
     through the files service (≤ `mcpResourceReadBytes` 5 MiB, 413 above; text → `text/plain` or the server's `text/*`;
     binary only image / PDF, else 400; several text contents joined), 201; 409 `needs-auth`; 502
     `provider_unreachable` when not connected; 404 unknown server or resource. *Accept:* the route tests (text, image,
     the 6 MiB resource → 413, a `needs-auth` server → 409).
  6. **W14.2-T6 Content mapping** (`content.ts`) — MCP content → model text for prompt expansions and tool results
     (`resource` / `resource_link` items become readable text; images stay files; caps). *Accept:* `content.test.ts`.
- **Tests.** The tasks above; prompt arguments, expansions and resource contents never at `info`.
- **Verify.** Server commands.

### W14.3 elicitation-server (k3)

- **Mission.** The elicitation broker and the live wait: attribution, form parsing, the card through preliminary
  outputs, the keep-alive, the budgets, the answer route, every cancel path, the stored record, `awaitingInput` events
  and the `Notification` hook.
- **Owned.** `S/mcp/elicitation/**` (not `types.ts`), `S/mcp/mcp-tools*`, `S/http/routes/chat-elicitations*`.
- **Read-only highlights.** ADR-060; the plan's Reconciliation row (Elicitation) and section 2; `server-mcp.md` ADR-060
  and section 4; API.md (C47's `chatElicitations` section, the stream notes); `SH/util/mcp-elicitation.ts` (C48),
  `SH/schemas/mcp.ts`; `S/mcp/elicitation/types.ts` (frozen, C50); the C51 generator skeleton; `S/chat/tools.ts:520-630`
  (the streaming path: the first preliminary output at once, then ≤ 1 per 250 ms); `S/chat/runs.ts:123-165` (the resume
  buffer); `S/chat/agent-scope.ts` (`notify?`, C52); `S/services/chats/types.ts:323` (`summary`); `P/index.js:2924-2995`
  (the handler gets no request id).
- **Tasks.**
  1. **W14.3-T1 Attribution** (`broker.ts`) — a per-client registry of in-flight calls (`begin` / `end`); a request
     goes to the oldest call when every in-flight call of that client belongs to one chat and is interactive; several
     chats → decline `ambiguous`; a non-interactive call (sub-agent, background) or no call in flight → decline
     `not-interactive`. *Accept:* `broker.test.ts` (one chat, two chats, a sub-agent, no call).
  2. **W14.3-T2 Requests** — `parseElicitationForm` (unsupported → decline `unsupported`; URL mode → decline
     `unsupported`), `elicitationMessageText`, an `eli_` id, `expiresAt` = now + 480 s (or the test-only wait of open
     point 3); at most one pending request per call (a second one while the first waits → decline `ambiguous`).
     *Accept:* the broker tests (the MCP spec examples of C48's tests; URL mode).
  3. **W14.3-T3 Card transport and keep-alive** (`mcp-tools.ts`) — the generator yields `{ status: 'input-required',
     elicitation }` when its call gets a request, re-yields it every 25 s while it waits, yields `{ status: 'running' }`
     after the answer; the final output keeps `elicitations: [{ id, message, fields, action, reason }]` (stripped from
     the model output); resource items of the result through W14.2's `content.ts`. *Accept:* `mcp-tools.test.ts` (fake
     timers: the re-yield; the final record has no values).
  4. **W14.3-T4 Budgets** — the outer timeout 600 s (`timeoutMs`), the active budget 60 s paused while waiting (a 70 s
     wait does not time the call out; 61 s of server work does). *Accept:* `mcp-tools.test.ts` (fake timers).
  5. **W14.3-T5 Answer route** (`chat-elicitations.ts`, replacing C47's stub) —
     `POST /chat/:id/elicitations/:elicitationId { action, content? }`: `validateElicitationAnswer` → 400 with field
     issues; 404 unknown; 409 `stale` (answered, expired, the run ended); the MCP request resolves with `{ action,
     content }`. *Accept:* `chat-elicitations.test.ts`.
  6. **W14.3-T6 Cancel paths** — the 480 s wait → `cancel` / `timeout`; Stop (the call's signal), chat delete
     (`chat.deleted` / `cancelChat`), key rotation (`key.rotated`) and shutdown (`stop()`) → `cancel` / `stopped`
     (coordinator decision B). *Accept:* the broker tests per path; no timer left after `stop()`.
  7. **W14.3-T7 Signals** — `pendingCount(chatId)`; `chat.updated` with `awaitingInput` on every 0 ↔ ≥ 1 transition
     (open point 2); the `Notification` hook through `agentScopeOf(c)?.notify?.({ message, notificationType:
     'elicitation_dialog' })` once per request. *Accept:* event and hook tests through `createTestApp()`.
  8. **W14.3-T8 End to end** — `mock:hooks` `call mcp__fake__ask {}` against the C53 fixture through `createTestApp()`:
     accept (the answer reaches the server: `ask_echo`; the stored message has no value), decline, cancel, Stop, a
     reload (the resume replays the card), a second answer 409, an invalid one 400, a sub-agent call declined, two chats
     both declined. *Accept:* `S/mcp/elicitation/e2e.test.ts` (name fixed by W14.3).
- **Tests.** The tasks above; elicitation messages and values never at any log level above `debug` (values never at
  all).
- **Verify.** Server commands.

### W14.4 search-native-server (k4)

- **Mission.** Provider-native web search: the provider hooks, the hook validation, the host's resolution helpers, the
  catalog's `webSearch` and the history stage.
- **Owned.** `S/builtin-plugins/core-providers/**`, `S/chat/search/{resolve,history}*`, `S/catalog/**`,
  `S/registry/validate*`.
- **Read-only highlights.** ADR-062, ADR-063; the plan's Reconciliation rows (Search: native, approval / history, mode +
  resolver) and section 4; `server-search.md` (Verified facts, ADR-S1, the provider table, Risks); `explore-search.md`
  B; `SH/util/web-search.ts` (C48); `SDK/types.ts` (`webSearch?`, C47); the C52 call sites;
  `S/registry/validate.ts:165-175` (`OPTIONAL_PROVIDER_FUNCTIONS`); `S/chat/params.ts:387` (`providerReasoning`, the
  call pattern); `S/catalog/merge.ts` (the model DTO, around `:206`); the provider packages' `.d.ts` (Anthropic
  `webSearch_20250305`, wire name `web_search` `anthropic/index.js:3699-3701`; OpenAI `webSearch`; Google `googleSearch`
  and the pre-Gemini-3 drop `google/index.js:1041-1044`; xAI `webSearch`; OpenRouter `tools.webSearch` and `plugins`;
  Groq `browserSearch`).
- **Tasks.**
  1. **W14.4-T1 Validation** (`validate.ts`) — `webSearch: true` in `OPTIONAL_PROVIDER_FUNCTIONS`; the host accepts only
     answers whose tools have `type === 'provider'` and whose keys do not collide with a function tool (a collision or a
     bad shape → ignored with a warning). *Accept:* `validate.test.ts`.
  2. **W14.4-T2 Resolution helpers** (`resolve.ts`) — `providerWebSearch(resolved, request, logger)` (sync, try / catch,
     like `providerReasoning`) and `applyWebSearch(assembled, resolution, params)` → tools, `byName`, `activeTools`,
     `nativeTools`, provider options (deep-merged). *Accept:* `resolve.test.ts`.
  3. **W14.4-T3 Provider hooks** (`core-providers/providers/*.ts`) — Anthropic `web_search` =
     `webSearch_20250305({ maxUses: WEB_SEARCH_MAX_USES })` for current `claude-*` models (not claude-2 / instant /
     plain claude-3); OpenAI `web_search` = `webSearch({})` with a deny-list (`o1*`, `o3-mini`, `*-nano`, `gpt-3.5*`,
     `gpt-4` without `o` / `.1`; unknown ids count as supported); Google `google_search` = `googleSearch({})` for Gemini
     (2.x → `exclusive: true`, ≥ 3 normal; non-Gemini none); xAI `web_search` = `webSearch({})` (deny `grok-2*`,
     `grok-3*`); OpenRouter `web_search` = `tools.webSearch({ maxResults: 5 })` for models with tools, else
     `providerOptions.openrouter.plugins: [{ id: 'web', max_results: 5 }]`; Groq `browser_search` for `GPT_OSS` models
     only. *Accept:* `core-providers/providers/web-search.test.ts` (the table per provider, version, deny-list,
     `exclusive`, the OpenRouter fallback).
  4. **W14.4-T4 Catalog** (`merge.ts`) — `catalogModel.webSearch` by probing the hook with `{ functionTools: 0, maxUses:
     WEB_SEARCH_MAX_USES }`: `native`, `exclusive` (the answer's `exclusive`) or null; image models null. *Accept:*
     `merge.test.ts`; `mock:search` → `native`.
  5. **W14.4-T5 History stage** (`history.ts`) — provider-executed parts (`isProviderExecutedPart`) kept only when the
     message's `metadata.modelRef` provider equals the current provider, else removed before `toolPartsAsText`.
     *Accept:* `history.test.ts` (same provider kept, another removed, function tool parts untouched).
  6. **W14.4-T6 Live tests** — `*.live.test.ts` (one native search per provider incl. Gemini 3 and Gemini 2.5 with tools
     off; Anthropic / OpenAI two-turn replay; a cross-provider switch); **never run by the agent**.
- **Tests.** The tasks above; only mock models and `MockLanguageModelV4`.
- **Verify.** Server commands.

### W14.5 search-builtin-server (k5)

- **Mission.** The builtin `search_web` of `core-search`: three backends, key-gated registration, error mapping, the
  sources transform and the test route.
- **Owned.** `S/builtin-plugins/core-search/**`, `S/chat/search/sources*`, `S/http/routes/web-search*`.
- **Read-only highlights.** ADR-063; the plan's Reconciliation rows (Search: builtin, `safeFetch`) and section 4;
  `server-search.md` ADR-S3, "Backend HTTP shapes"; `SH/schemas/web-search.ts`, `SH/util/web-search.ts`; the C50
  manifest and settings; `S/security/ssrf.ts` (`safeFetch` POST, `createPluginSourceFetch`); `S/testing/fake-search.ts`
  (C53); `S/chat/generated-files.ts:9-11`, `:207` (the transform precedent); `S/builtin-plugins/core-tools/web-fetch.ts`
  (the tool style); `S/plugins/host.ts` (secret settings `settings.<key>` in `plugin:<id>`).
- **Tasks.**
  1. **W14.5-T1 Backends** (`backends/{brave,tavily,exa}.ts`) — **verify the request and response shapes against the
     vendor docs at implementation time** (Brave `GET https://api.search.brave.com/res/v1/web/search?q&count&freshness`
     with `X-Subscription-Token`; Tavily `POST https://api.tavily.com/search` with `Authorization: Bearer`, body `{
     query, max_results, search_depth: 'basic', time_range? }`; Exa `POST https://api.exa.ai/search` with `x-api-key`,
     body `{ query, numResults, type: 'auto', contents: { highlights: true }, startPublishedDate? }`); a shape that
     differs from `createFakeSearchFetch` is a CCR to C53's file; normalized to `searchWebOutputSchema` (titles ≤ 300,
     http(s) URLs ≤ 2048, snippets ≤ 800, `published` or null; ≤ 32 KB). *Accept:* `backends/*.test.ts` with
     `createFakeSearchFetch` (request shapes, auth headers present, the key never in an error or a log).
  2. **W14.5-T2 Tool** (`search-web.ts`) — input `{ query, count?, freshness? }`; `count` defaults to `maxResults`; 10
     s, 1 MB, no redirect; 401 / 403 → `provider_error` ("The search key was rejected."), 429 → `rate_limited`, network
     → `provider_unreachable`, oversize / bad JSON → `provider_error`; policy `safe`. *Accept:* `search-web.test.ts`
     (every mode of the fake).
  3. **W14.5-T3 Key-gated registration** (`index.ts`) — `search_web` registered only while the selected backend has a
     key (`ctx.settings.onChange` re-evaluates; the `Disposable` of `tools.register` disposed); `HF_OFFLINE` does not
     block it. *Accept:* `index.test.ts` (no key → not registered; a key → registered; a backend switch without a key →
     unregistered).
  4. **W14.5-T4 Sources transform** (`S/chat/search/sources.ts`) — after a final (non-preliminary) `search_web` output
     of owner `core-search` (tool names tracked from `tool-input-available` and the continued message), one `source-url`
     chunk per result (deduplicated by URL, http(s) only, `title` kept). *Accept:* `sources.test.ts` (dedupe; a tool of
     that name from another plugin adds nothing; the saved message holds the parts).
  5. **W14.5-T5 Test route** (`web-search.ts`, replacing C47's stub) — `POST /web-search/test { backend? }` → `{ ok:
     true, backend, results, ms }` with a fixed query; no key → the answer API.md fixes; errors mapped as T2. *Accept:*
     `S/http/routes/web-search.test.ts`.
  6. **W14.5-T6 Hygiene and live tests** — queries, keys and snippets never at `info` (backend, count, status, duration
     only); `*.live.test.ts` per backend (`BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`), **never run by the
     agent**.
- **Tests.** The tasks above; network only through the fakes.
- **Verify.** Server commands.

### W14.6 chat-records-server (k6)

- **Mission.** Shares, exports, backups and imports of the new message content: `search_web` rows, provider-executed
  search parts, sources and elicitation records; OAuth records and search keys never in a backup.
- **Owned.** `S/services/{chats,shares,data}/**` (not `types.ts`, not `references*`).
- **Read-only highlights.** ADR-024, ADR-060, ADR-062, ADR-063; coordinator decision C;
  `SH/schemas/{mcp,web-search}.ts`; `S/services/shares/snapshot.ts:221-226` (`source-url` kept: http(s), ≤ 2048),
  `S/services/chats/export.ts:175-178` ("Source:" lines), `S/services/data/parts.ts` (backups keep source URLs); W14.5's
  normalized output, W14.3's record shape.
- **Tasks.**
  1. **W14.6-T1 Share snapshots** (`S/services/shares/**`) — `search_web` rows keep the query and the results (title,
     http(s) URL, snippet; capped); provider-executed search parts become a "searched the web" row with the query,
     **without `encryptedContent`** or provider metadata; MCP tool rows keep the elicitation records (message, field
     names, action); sources unchanged. *Accept:* `snapshot.test.ts`.
  2. **W14.6-T2 Exports** (`S/services/chats/export*`) — Markdown: a `search_web` call as its query + result lines,
     provider-executed searches as "Searched the web: <query>" (no `encryptedContent`), "Source:" lines unchanged, an
     elicitation record as one line (fields and action, never values); the JSON export keeps messages as stored.
     *Accept:* `export.test.ts`.
  3. **W14.6-T3 Backups and imports** (`S/services/data/**`) — messages as stored (provider-executed parts included);
     the OAuth records (`oauth.record`, `oauth.clientSecret`, `mcp-oauth.*`) and the `core-search` keys are never in a
     backup; delete-all keeps them; an imported chat with provider-executed parts and elicitation records parses.
     *Accept:* `S/services/data/*.test.ts` (a backup zip listing has no OAuth or search secret; a v1.8.1 backup
     restores).
- **Tests.** The tasks above.
- **Verify.** Server commands.

### W14.7 mcp-web

- **Mission.** MCP sign-in in the UI: the `needs-auth` rows, Sign in / Sign out, the OAuth fields of the MCP dialog,
  the project rows, the `plugins` / `project-mcp` store actions, `useMcpSignIn` and the `/oauth/callback` page.
- **Owned.** `W/components/plugins/mcp/**`, `W/components/projects/mcp/**`, `W/stores/{plugins,project-mcp}*`,
  `W/composables/useMcpSignIn*`, `W/pages/oauth/**`, `W/components/oauth/**`.
- **Read-only highlights.** UI.md 2.20, 6, 8.14, 10.10, 11.10, 13.14, 14, 15; `web-waves.md` A (with the
  reconciliation); API.md (`mcpAuth`); `SH/schemas/{mcp,tools}.ts`; the C54 stubs and signatures (frozen);
  `mcp-form.ts:67-96`; `McpServersPanel.vue`, `McpServerDialog.vue`, `McpSecretRows.vue`; `ProjectMcpServerRow.vue`,
  `ProjectMcpDialog.vue`; `W/layouts/auth.vue`; `useFreshAuth()`; `safeRedirectPath` (`W/utils/redirect.ts:31`).
- **Tasks.**
  1. **W14.7-T1 Rows** — `needs-auth`: dot `warning`, "Sign in required" and **Sign in** (LogIn icon,
     `mcp-sign-in`); a server with an `Authorization` header: "The server rejected its Authorization header." + Edit…
     (open point 6); signed-in rows "Connected · {n} tools · Signed in" and `⋯` → **Sign out…** (a ConfirmDialog
     "harness-forge forgets the tokens; the server stays configured.", `mcp-sign-out`); errors inline in a
     `HarnessErrorAlert` (`mcp-sign-in-error`). *Accept:* `McpServersPanel.test.ts`, `mcp-form.test.ts`.
  2. **W14.7-T2 OAuth fields** — `McpOAuthFields` in the HTTP and SSE tabs ("Sign-in (OAuth) · optional": Client ID,
     write-only Client secret like `McpSecretRows`, Scopes, the read-only Redirect URI with Copy built in script);
     saved through `saveMcp`. *Accept:* `McpOAuthFields.test.ts`, `McpServerDialog.test.ts`.
  3. **W14.7-T3 `useMcpSignIn` and stores** — `start(...)`: `authorized` → a toast; else a same-tab
     `location.assign(url)` (http(s) only); `returnTo` = the current route's full path checked with `safeRedirectPath`;
     the stores' sign-in / sign-out actions refetch on `plugin.changed` / `project-mcp.changed`. *Accept:*
     `useMcpSignIn.test.ts`, `plugins.test.ts`, `project-mcp.test.ts`.
  4. **W14.7-T4 Project rows** — `ProjectMcpServerRow`: Sign in / Sign out (`project-mcp-sign-in`,
     `project-mcp-sign-out`) for approved remote servers; pending rows keep **Review…** and never show Sign in.
     *Accept:* `ProjectMcpServerRow.test.ts`, `ProjectMcpDialog.test.ts`.
  5. **W14.7-T5 Callback page** — `OAuthCallbackView`: read `code`, `state`, `error`, `error_description`, `iss` once,
     `router.replace({ query: {} })`, POST the callback, `navigateTo(returnTo ?? '/plugins', { replace: true })` + the
     toast "Signed in to {server}."; a `role="status"` "Finishing sign-in…"; errors as a card (the provider's text as
     plain text ≤ 300, **Try again** (`oauth-callback-retry`, starts again for the target), **Back to MCP servers**
     (`oauth-callback-back`)); a 409 `stale` → "This sign-in link was already used or expired."; works after a login
     redirect. *Accept:* `OAuthCallbackView.test.ts` (each state; the query removed before the POST).
- **Tests.** The tasks above; no `//` inside a component prop value.
- **Verify.** Web commands.

### W14.8 composer-web

- **Mission.** The composer side: the MCP slash group, resource mentions and their attachments, the web search toggle,
  the customizations store additions.
- **Owned.** `W/components/chat/composer/**`,
  `W/composables/{useFileMentions,useResourceMentions,useComposerAttachments}*`, `W/stores/customizations*`.
- **Read-only highlights.** UI.md 2.20, 7.8, 7.35, 10.10, 11.10, 12, 13.14, 14, 15; `web-waves.md` B, C, E (the toggle);
  API.md (`commands.list`, `mcpResources`); `SH/util/{web-search,mentions,mcp-prompts}.ts`; the C54 stubs and
  signatures; `slash-commands.ts:30-39`, `:85` (`slashGroupOf`), `:121` (`serverSlashItems`); `ChatComposer.vue:1085`;
  `MentionMenu.vue`; `useFileMentions.ts:61`; `useComposerAttachments.ts:229`; `W/stores/customizations.ts:140`
  (`slashCommands`).
- **Tasks.**
  1. **W14.8-T1 Slash group MCP** — `SlashGroup` + `'mcp'` (order App · Project · Personal · Plugins · MCP · Skills;
     `slashGroupOf` maps `source: 'mcp'`); the row detail is the server name, the hint the `argumentHint`; the
     customizations store refetches the slash list on `customization.changed { kind: 'command' }`. *Accept:*
     `slash-commands.test.ts`, `SlashMenu.test.ts`, `customizations.test.ts`.
  2. **W14.8-T2 Resource mentions** — `useResourceMentions` behind C54's signature (the shared `mentionTokenAt` token;
     `GET /mcp/resources` with a 15 s max age, refetched when the menu opens); `MentionMenu`: one listbox with two
     `role="group"` sections "Files in {project}" and "MCP resources" (`mention-menu-section`, `mention-menu-resource`;
     `aria-activedescendant` keeps working); a resource row shows an icon, the title, a server badge and the MIME type;
     `ComposerAddMenu` "Mention a file or resource". *Accept:* `useResourceMentions.test.ts`, `MentionMenu.test.ts`.
  3. **W14.8-T3 Attach** — a pick inserts `@<server>:<uri>` (`formatResourceMention`) and attaches through `POST
     /mcp/resources/attach` → `addResource(fileRef)` (a chip); 413 → "This resource is larger than 5 MB."; 409
     `needs-auth` → "Sign in to {server} first." *Accept:* `useComposerAttachments.test.ts`, `ChatComposer.test.ts`.
  4. **W14.8-T4 Web search toggle** — `WebSearchToggle` (a Globe `Toggle`, `aria-pressed`, the label "Search" from `sm`,
     icon-only with a dot below; tooltip "Web search on · {provider | backend}"; unavailable → `aria-disabled` (still
     focusable) and a Popover with the resolver's reason and "Set up web search" (`web-search-setup`); hidden for image
     models; changes announced in the composer's live region); `ChatComposer` feeds the resolver (open point 5) and
     `useChatSession().webSearch`; Alt+W toggles it and obeys `altShortcuts`. *Accept:* `WebSearchToggle.test.ts`,
     `ChatComposer.test.ts` (each reason; Alt+W with and without `altShortcuts`).
- **Tests.** The tasks above; file-mention behavior unchanged (`useFileMentions.test.ts` green).
- **Verify.** Web commands.

### W14.9 transcript-web

- **Mission.** The transcript side: the elicitation card and its jump pill, the tool row states, the sources chips and
  letter avatars, the search rows, the command badge and the share view.
- **Owned.** `W/components/chat/{parts,hooks,agent}/**`, `W/components/chat/{ChatMessage,ChatView,ChatTranscript}*`,
  `W/components/share/**`.
- **Read-only highlights.** UI.md 2.20, 7.35, 10.10, 11.10, 13.14, 14, 15; `web-waves.md` D, E (sources, search rows);
  `SH/util/{mcp-elicitation,web-search}.ts`, `SH/schemas/{mcp,web-search}.ts`; the C54 stubs, `TOOL_ELICITATIONS`
  (frozen); `ToolPart.vue:564` (`ToolApprovalCard`, the mount precedent), `SourcesPart.vue`, `chat-format.ts` (source
  blocks), `command-badge.ts`, `SharedChatView.vue`.
- **Tasks.**
  1. **W14.9-T1 `ElicitationCard`** — fields per type from `parseElicitationForm`'s form (string → Input with `type`
     email / url / date / datetime-local and length limits; number / integer → numeric Input with min / max / step;
     boolean → Checkbox; enum → RadioGroup for ≤ 4 options, else Select; multi-select → checkboxes); initial values and
     coercion through `elicitationInitialValues` / `coerceElicitationValue`, validation through
     `validateElicitationAnswer` (an invalid submit focuses the first invalid field, `aria-invalid` +
     `aria-describedby`); the header "{server} needs more information" + a countdown (`tabular-nums`, one polite
     announcement at 60 s); the message as plain text (`whitespace-pre-wrap`, "Show more"); the caution "Share only what
     you would give {server}. Never enter passwords here." (+ the sensitive-field warning, `isSensitiveField`);
     **Submit** / **Decline** / × "Dismiss request" (cancel); never takes focus on appearing (a polite live region says
     "{server} needs your input"); the one-line result after the answer; at 390 px the buttons stack full width and
     fields are 40 px on coarse pointers. *Accept:* `ElicitationCard.test.ts` (each field kind; submit, decline,
     dismiss; expiry; the 'gone' answer).
  2. **W14.9-T2 Tool row** — `ToolPart` mounts the card under a running MCP row whose latest preliminary output is
     `input-required` (through `TOOL_ELICITATIONS`; rows stay `v-memo`ed); the status cell reads "Waiting for your
     input". *Accept:* `ToolPart.test.ts`.
  3. **W14.9-T3 Jump pill** — `ChatView`: "{server} needs your input · Show" (`elicitation-jump`) when the card is
     off-screen; it scrolls to the card and focuses its first field. *Accept:* `ChatView.test.ts`.
  4. **W14.9-T4 Sources** — `SourcesPart`: up to 3 domain chips + "+N" next to "N sources" (`sourceDomain`), a letter
     avatar per source (`Avatar` / `AvatarFallback`, colors from the `chart-1` … `chart-5` tokens; no favicon); the
     trigger's name "N sources: a.com, b.org and 3 more"; chips `aria-hidden`. *Accept:* `SourcesPart.test.ts`.
  5. **W14.9-T5 Search rows** — `WebSearchToolBody` for `search_web` and provider-executed rows: "Searched the web", the
     query, "{n} results", each result's title link (http(s) only), domain and snippet as plain text; never an approval
     card; never `encryptedContent`. *Accept:* `WebSearchToolBody.test.ts`.
  6. **W14.9-T6 Command badge and share view** — `command-badge.ts`: "MCP · {server}" for `source: 'mcp'` (open point
     14); the share view renders the W14.6 rows (search, provider-executed, elicitation record). *Accept:*
     `command-badge.test.ts`, the share view tests.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### W14.10 settings-web

- **Mission.** Settings → Web search: the page, the `web-search` store, the key rows and **Test search**.
- **Owned.** `W/pages/settings/search*`, `W/components/settings/search/**`, `W/stores/web-search*`.
- **Read-only highlights.** UI.md 2.20, 5.5, 9.15, 10.10, 11.10, 13.14, 14, 15; `web-waves.md` E (settings); API.md
  (`webSearch.test`, the settings, `/plugins/:id/settings`); the C54 stubs and the store signature (frozen);
  `W/components/settings/` (the existing section style), `switch-hit-areas.test.ts`.
- **Tasks.**
  1. **W14.10-T1 Store** — `useWebSearchStore` behind C54's signature: single flight, `maxAgeMs`, an answer older than
     the last event never wins; `builtinAvailable` (open point 5). *Accept:* `web-search.test.ts` (store).
  2. **W14.10-T2 Page** — `WebSearchSettings`: "Use the model's own web search when it has one"
     (`settings-search-native`, `webSearchNative`), "Turn on web search in new chats" (`settings-search-default`,
     `webSearchDefault` `auto` / `off`), the backend select Brave Search · Tavily · Exa (open point 7), max results, the
     note "Native search fees are billed by the provider."; every Switch keeps the 40 px coarse-pointer hit area.
     *Accept:* `WebSearchSettings.test.ts`.
  3. **W14.10-T3 Key rows** — write-only per backend (`settings-search-key[data-backend][data-state]`): "Key saved ·
     Replace · Remove" or an input + Save, through `/plugins/core-search/settings`. *Accept:* the same test file (a
     value never rendered back).
  4. **W14.10-T4 Test search** — **Test search** (`settings-search-test`) → `POST /web-search/test` → "{n} results in
     {ms} ms" or the mapped error (`settings-search-test-result`). *Accept:* the same test file.
- **Tests.** The tasks above.
- **Verify.** Web commands.

### G14P gate probes

- **Mission.** Write `.tmp/gates/P14-A/probe.mjs` (the catalogue in "Gate probes" below) during the wave against the
  contracts of this file, API.md and PROVIDERS.md 8; run it after the coordinator's build signal on :8896 – :8898 while
  the coordinator runs e2e on :8899; report every check with its result ("spec differs" when the code is right and the
  spec is not, with the evidence).
- **Owned.** `.tmp/gates/P14-A/**`.
- **Read-only highlights.** `.tmp/gates/P12-A/{lib,probe,s-*}.mjs` (the harness: `startServer`, `client`, `login`,
  `newProject`, `say`, `settle`, `rows`, `fakeRemote`, `check`, `section`, `guarded`, `stopAll`, …),
  `.tmp/upgrade-v181-ids.json`, PROVIDERS.md 8, `S/mcp/__fixtures__/oauth-mcp-server.mjs` (importable: the probes run
  the built server, the fixture is plain ESM), `e2e/fixtures/fake-remote.mjs`.
- **Rules.** New helpers `oauthFixture(options)` (the C53 fixture on port 0, its counters and toggles),
  `searchRemote()` (the fake remote, its log), `signIn(c, target)` (start → follow the authorization URL with `fetch`
  and `redirect: 'manual'` → the callback POST), `waitCard(c, chatId)` (the preliminary output in the stream), `logGrep`
  (canaries in the log file); every probe server runs with `HF_MOCK_PROVIDER=1 HF_TEST_REMOTE_URL=<fake> HOME=<temp
  folder with a sentinel file>` and its own `HF_DATA_DIR` / `HF_WORKSPACE_ROOTS` under `.tmp/gates/P14-A/run-<ts>/`;
  restarts with `HF_SAFE_MODE=1` or `HF_OFFLINE=1` where a group says so; loops through `bash -c`; every server,
  fixture and fake-remote process stopped at the end (kill by port, pids checked).

### Wave P14-A ownership

These globs are the plan's table, with W14.1's route glob written as `{mcp.,mcp-auth,project-mcp}*` (open point 13), so
no path has two owners. The audit cannot express "except": `S/mcp/oauth/types.ts`, `S/mcp/elicitation/types.ts`,
`S/chat/search/types.ts` (if any), `S/services/{chats,shares,data}/types.ts`, `S/services/data/references*` and the
P14-0b stub props stay frozen despite the globs (open point 16).

```json
{
  "wave": "P14-A",
  "agents": {
    "W14.1": [
      "apps/server/src/mcp/oauth/**",
      "apps/server/src/mcp/{user-servers,templating}*",
      "apps/server/src/plugins/claude/mcp*",
      "apps/server/src/http/routes/{mcp.,mcp-auth,project-mcp}*"
    ],
    "W14.2": [
      "apps/server/src/mcp/{prompts,resources,content}*",
      "apps/server/src/chat/commands*",
      "apps/server/src/http/routes/{commands,mcp-resources}*"
    ],
    "W14.3": [
      "apps/server/src/mcp/elicitation/**",
      "apps/server/src/mcp/mcp-tools*",
      "apps/server/src/http/routes/chat-elicitations*"
    ],
    "W14.4": [
      "apps/server/src/builtin-plugins/core-providers/**",
      "apps/server/src/chat/search/{resolve,history}*",
      "apps/server/src/catalog/**",
      "apps/server/src/registry/validate*"
    ],
    "W14.5": [
      "apps/server/src/builtin-plugins/core-search/**",
      "apps/server/src/chat/search/sources*",
      "apps/server/src/http/routes/web-search*"
    ],
    "W14.6": [
      "apps/server/src/services/{chats,shares,data}/**"
    ],
    "W14.7": [
      "apps/web/app/components/plugins/mcp/**",
      "apps/web/app/components/projects/mcp/**",
      "apps/web/app/stores/{plugins,project-mcp}*",
      "apps/web/app/composables/useMcpSignIn*",
      "apps/web/app/pages/oauth/**",
      "apps/web/app/components/oauth/**"
    ],
    "W14.8": [
      "apps/web/app/components/chat/composer/**",
      "apps/web/app/composables/{useFileMentions,useResourceMentions,useComposerAttachments}*",
      "apps/web/app/stores/customizations*"
    ],
    "W14.9": [
      "apps/web/app/components/chat/{parts,hooks,agent}/**",
      "apps/web/app/components/chat/{ChatMessage,ChatView,ChatTranscript}*",
      "apps/web/app/components/share/**"
    ],
    "W14.10": [
      "apps/web/app/pages/settings/search*",
      "apps/web/app/components/settings/search/**",
      "apps/web/app/stores/web-search*"
    ],
    "G14P": [
      ".tmp/gates/P14-A/**"
    ]
  },
  "allow": [
    "docs/ROADMAP.md",
    "docs/DECISIONS.md",
    "AGENT.md",
    "pnpm-lock.yaml",
    ".tmp/**"
  ]
}
```

A file a P14-A agent creates outside its globs is a CCR: the coordinator adds it to the wave file at the gate. Unowned
in P14-A (a needed change is a CCR; new test helpers go into the agent's own files):
`S/mcp/{index,project,project-view,project-variables,project-testing,errors,stdio-transport,types,policy,tools,internal}*`,
`S/mcp/__fixtures__/**`, `S/chat/` other than `commands*` and `search/{resolve,history,sources}*`, `S/http/routes/`
other than the files above, `S/security/**`, `S/testing/**`, `S/env*`, `S/deps*`, `S/types.ts`, `S/builtin-plugins/`
other than `core-providers/**` and `core-search/**`, `S/registry/` other than `validate*`, `S/plugins/` other than
`claude/mcp*`, `W/utils/testids.ts`, `W/composables/{useChatSession,useServerEvents}*`, `W/components/app-shell/**`,
`W/stores/` other than the files above, `W/components/chat/` outside `{composer,parts,hooks,agent}/` and
`{ChatMessage,ChatView,ChatTranscript}*`, `W/components/settings/` other than `search/**`, `e2e/**`, `docs/**`.

### Wave P14-A cross-agent contracts

The props below are frozen in the P14-0b stubs or documented in UI.md 10.10; the server members in the frozen files.

| Producer → consumer | Contract |
|---|---|
| C50 / C51 / C52 / C53 → every server agent | the service interfaces, the seams, the fakes, the mocks, the OAuth fixture, the search fakes |
| W14.1 → C51's seams (at run time), W14.7 | `McpAuthService` (`provider` modes, `info`, `start` / `complete` / `signOut`); the start answer `{ authorizationUrl, redirectUri, expiresAt }` and the callback answer `{ target, status, returnTo }` |
| W14.2 → W14.3 | `content.ts` (resource items in tool output) |
| W14.2 → W14.8 | the `/commands` `mcp` rows (`mcpServer`, `argumentHint`) and the resource routes (list, attach) |
| W14.3 → W14.9 | `mcpToolProgressSchema` (the preliminary outputs), the stored record, the answer route |
| W14.3 → W14.6 | the stored elicitation record inside MCP tool outputs |
| W14.4 / W14.5 → W14.8 / W14.10 | the resolver inputs: `catalogModel.webSearch`, the `search_web` registration rule (selected backend + key) |
| W14.5 → W14.6 / W14.9 | the normalized `search_web` output and the `source-url` chunks |
| W14.4 → W14.9 | provider-executed parts (names `web_search`, `google_search`, `browser_search`; `providerExecuted: true`) |

### Gate probes (`.tmp/gates/P14-A/probe.mjs`)

Built on the P12-A harness plus `oauthFixture`, `searchRemote`, `signIn`, `waitCard`. Probe servers: **8896** MCP
(groups 1 – 5 and 9), **8897** search (groups 6 – 7), **8898** upgrade (group 10); group 8 runs across all of them.
Every server with `HF_MOCK_PROVIDER=1 HF_TEST_REMOTE_URL=http://127.0.0.1:<fake-remote port>`, `HOME=<temp with a
sentinel>`, its own `HF_DATA_DIR=.tmp/gates/P14-A/run-<ts>/<name>` and `HF_WORKSPACE_ROOTS`; the OAuth fixture on
loopback port 0 (the seeded ports for group 10, open point 8); restarts with `HF_SAFE_MODE=1` or `HF_OFFLINE=1` where a
group says so. MCP calls use `mock:hooks` (`call <tool> <json>`), prompt expansions `mock:echo`, native search
`mock:search`, the builtin `mock:search-tool`.

1. **OAuth** — a fixture server added as a personal http server → `needs-auth` and the fixture counts exactly one
   connect (`connects` 1, no growth over 3 s); `POST /mcp/:id/oauth` answers an authorization URL with
   `code_challenge_method=S256`, `state`, `resource` and `redirect_uri=<Origin>/oauth/callback`; following it
   (auto-approve) and posting the callback → `connected`, `GET /mcp` shows `auth.signedIn: true` and the tools; the
   token, code and verifier strings appear nowhere in the log file, a backup zip, any `GET` answer or `messages`;
   `tokenLifeSec 2` → a tool call after expiry refreshes (`refreshes` 1); an `invalid_grant` on refresh → `needs-auth`;
   sign-out deletes the record (`auth: null`) and the fixture counts `revocations` 1; `noMetadata` → "This server asked
   for sign-in but does not support OAuth."; `foreignAs http://169.254.169.254/` and `http://10.0.0.1/` → refused before
   any request reaches them; a replayed, expired or mismatched `state` → 409 `stale`; a stdio server or one with an
   `Authorization` header → 400; a disabled server → 409 `disabled`; `POST /api/keys/rotate` + a restart keep
   `connected` (the record re-encrypted); `PATCH` of the name keeps the tokens, `PATCH` of the URL drops them.
2. **Origins** — a plugin server whose `transport.oauth.clientId` is `{{settings.clientId}}` signs in with the
   configured client (`preRegistered`); a Claude plugin `.mcp.json` server with `oauth` signs in (no "not supported"
   diagnostic); a project `.mcp.json` server with `oauth.clientId`: pending → 409 `untrusted`; approved → sign in → `GET
   /projects/:id/mcp` shows `auth.signedIn`; deleting the project removes `project:<id>` `mcp-oauth.<serverId>`; a v1.8
   approval of such a server (group 10's seed) stays valid.
3. **Elicitation** (`mock:hooks` `call mcp__fake__ask {}`) — the stream carries a preliminary output `input-required`
   with an `eli_` id and `expiresAt` ≈ now + 480 s; accept → the tool result arrives (`ask_echo` echoes the values to
   the fixture) and the stored message holds no value (searched by a canary); decline and cancel (× Dismiss) → recorded
   actions; the timeout → `expiresAt` checked (a live `cancel` / `timeout` only if open point 3's CCR was accepted);
   Stop → `cancel` / `stopped`; a reload (`GET /chat/:id/stream`) replays the card; a second answer → 409 `stale`; an
   invalid answer → 400 with field issues; `awaitingInput: true` in `GET /chats` and in a `chat.updated` event, false
   after the answer; a sub-agent's call (`mock:hooks agent …`) is declined automatically; two chats calling at once are
   both declined (`ambiguous`); a `Notification` hook with matcher `elicitation_dialog` fires once; a 70 s wait does not
   time the call out (the active budget).
4. **Prompts** — `GET /commands` lists `mcp__fake__greet` with `source: 'mcp'`, `mcpServer`, the hint `<name>
   [greeting]`; `/mcp__fake__greet Ada` on `mock:echo` echoes the expansion "Hello, Ada!"; a missing required argument →
   a `failed` reply; regenerate makes no second `prompts/get` (fixture counter); a project server's prompts only with
   `projectId`; a project server shadows a global one of the same id; a `needs-auth` server's prompts are not listed.
5. **Resources** — `GET /mcp/resources?q=readme` lists and ranks the fixture's resources (`mention` =
   `@fake:fixture://notes/readme.md`); attaching the text and the image resources gives `FileRef`s (201); the 6 MiB
   resource → 413; a `needs-auth` server → 409 `needs-auth`; a chat without a project lists the global servers'
   resources.
6. **Native search** (`mock:search`) — mode `auto` in `ask` and in `plan` → a provider-executed `tool-web_search` part,
   ≥ 2 `source-url` parts, no `awaitingApproval`, no PreToolUse record (a recording hook); mode `off` → "Search off";
   tool mode `off` → "Search off" and the notice `web-search-unavailable` (`tool-mode-off`) once.
7. **Builtin search** (`mock:search-tool`, `core-search`) — with a Brave key: a `search_web` part followed by
   `source-url` parts in the stored message, the share snapshot and the markdown export ("Source:" lines); Tavily and
   Exa → the fake log shows POST with a JSON body (and the key only in the header); without a key: `search_web` absent
   from `GET /tools`, "Tools are disabled." and the notice once; the keys `invalid-key` → `provider_error` and
   `rate-limited` → `rate_limited`; a `mock:subagent` child gets `search_web`; native and builtin never in the same
   request (`mock:search` with a key set still answers natively and `search_web` is not offered); `POST
   /web-search/test` → `{ ok: true, backend, results, ms }`; with `HF_OFFLINE=1` the builtin still works.
8. **Hygiene** — the log files contain no query, key, token, code, verifier, client secret or elicitation value
   (canaries); `git status` identical around `pnpm test`; the fake-remote and fixture logs are the only network (no
   other outbound connection); no `.claude*` / `.harness` / `.mcp.json` in the repository; the `HOME` sentinel
   untouched; no orphan processes; the ports free.
9. **Plugin API 1.7.0** — health `pluginApiVersion` 1.7.0; `^1.6.0` plugins and every example load; a code provider
   with a `webSearch` hook whose tool is not `type: 'provider'` is ignored with a warning; the v1 and v2 trust hashes of
   the golden items unchanged.
10. **Upgrade** (8898, a fresh `.tmp/upgrade-v181` copy with copied roots, the OAuth fixture on the seeded ports) — the
    Gate P14-0b checks (G14B), plus: signing in to the seeded `oauth` project server works (its approval unchanged); the
    Claude plugin OAuth server signs in; a seeded chat turns search on with `PATCH /chats/:id` and `mock:search`
    answers natively.

### Gate P14-A

1. `node scripts/audit-ownership.mjs .tmp/waves/P14-A.json`
2. Batch the CCRs → `nuxi prepare` → `pnpm check` → `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
3. `mv .tmp/e2e .tmp/e2e-old-p14-a` → the G14P probes (the catalogue above).
4. **Regressions** (one after another: shared ports) — the coordinator's copy `.tmp/gates/P14-A-p12a-regression/` (open
   point 15; incl. its v1.7 upgrade on `.tmp/upgrade-v17`), the P11-A copy `.tmp/gates/P12-A-p11a-regression/` (incl.
   its v1.6 upgrade), the P10-A copy `.tmp/gates/P12-A-p10a-regression/p10a-regression.mjs`, `node
   .tmp/gates/P9-A/probe.mjs` (incl. its v1.4 upgrade) and `node .tmp/gates/P8-A/probe.mjs ws git`.
5. `pnpm test:e2e` (`chromium` + `mobile` + `tablet`, with the fake remote; the feature specs come in P14-B) → 215
   green.
6. `E2E_SCREENSHOTS=1 pnpm test:e2e --grep @screenshots` → review `.tmp/screenshots/{dark,light}/`; the new screens on
   desktop and 390 px through a coordinator script or the dev server (the feature screenshot specs come in P14-B).
7. `pnpm audit --prod --audit-level high` clean (the ignored advisories excepted).
8. Digest `.tmp/waves/P14-A-notes.md`; red items → W14.13 / W14.14; ROADMAP + wave log → commit `feat: add mcp oauth,
   prompts, resources, elicitation and web search`.

---

## Wave P14-B — feature e2e, docs, fix-ups

### Coordinator actions

- Before the launch: the P14-A checkpoint build for W14.11; W14.13 / W14.14 globs from the red P14-A gate items added to
  `.tmp/waves/P14-B.json` (launched only when needed); the P14-A reports handed to W14.12 as the digest
  `.tmp/waves/P14-A-notes.md` (contract facts, deviations, items marked "For W14.12").
- The final gate below; ROADMAP (every Phase 14 box, the backlog, the wave log); the memory file; push and tag only when
  the user asks.

### W14.11 e2e-features (e2e 8891)

- **Mission.** End-to-end specs for MCP sign-in, elicitation, prompts, resources, web search and its settings; the
  extensions of existing specs; mobile and tablet checks; screenshots of the new screens and full-frame README shots.
- **Owned.** `e2e/**`.
- **Read-only highlights.** UI.md 2.20, 7.35, 8.14, 9.15, 12, 13.14, 14; PROVIDERS.md 8 (`mock:search`,
  `mock:search-tool`, `mock:hooks`, `mock:echo`); `playwright.config.ts` (K4's two `webServer` entries);
  `e2e/README.md`; `e2e/helpers/**`; `e2e/fixtures/{fake-remote.mjs,mcp-echo-server.mjs}`;
  `S/mcp/__fixtures__/oauth-mcp-server.mjs` (plain ESM: re-export or copy it as `e2e/fixtures/mcp-oauth-server.mjs`; e2e
  never imports server TypeScript; the MCP SDK is a root dev dependency).
- **Rules.** Project folders only under `.tmp/e2e/workspaces/*`; fixture state in `realpath(mkdtemp())` folders outside
  the repository; the OAuth / elicitation fixture is started by the specs on free ports on **`127.0.0.1`** while the app
  runs on `localhost` (open point 9: a genuinely cross-site redirect); the search specs use the fake remote of
  `webServer` (`E2E_FAKE_REMOTE_PORT`); never a real host; never `.claude/`, `.harness/`, `.claude-plugin/` or
  `.mcp.json` in the repository (a project `.mcp.json` lives in `.tmp/e2e/workspaces/<p>/`).
- **Tasks.**
  1. **W14.11-T1 `plugins/mcp-oauth.spec.ts`** — add the fixture URL in Plugins → MCP → "Sign in required" → **Sign in**
     → the fixture's approve page (`approvePage`) → back on `/oauth/callback` → "Signed in to {server}." → the tools are
     listed; sign out (confirm) → `needs-auth`; the OAuth fields (client id, write-only secret, the redirect URI with
     Copy); a used callback link → "This sign-in link was already used or expired."; **a run with a password**
     (`HF_PASSWORD` on a slot server): the callback completes with the session cookie after the cross-site redirect.
  2. **W14.11-T2 `core/mcp-elicitation.spec.ts`** — `mock:hooks` `call mcp__<id>__ask {}` → the card under the running
     row (status "Waiting for your input", the sidebar dot "Needs your input"); Submit with a validation error first
     (focus on the invalid field), then valid → the result line; Decline; × Dismiss; a reload while waiting shows the
     card again; the jump pill when scrolled away.
  3. **W14.11-T3 `core/mcp-prompts.spec.ts`** — `/` shows the MCP group with the server badge and hint;
     `/mcp__<id>__greet Ada` with `mock:echo` shows the expansion; a missing argument shows the failed reply.
  4. **W14.11-T4 `core/mcp-resources.spec.ts`** — `@` in a chat without a project lists "MCP resources"; a pick inserts
     `@<id>:<uri>` and a chip; the large resource → "This resource is larger than 5 MB."; in a project chat both
     sections (files and resources) in one listbox.
  5. **W14.11-T5 `core/web-search.spec.ts`** — the composer Search toggle with `mock:search` → the provider-executed row
     ("Searched the web") and the sources chips; with `mock:search-tool` and a Brave key (through the settings page) →
     the `search_web` row with results and sources; unavailable states (tool mode off, no key: the popover and "Set up
     web search"); Alt+W.
  6. **W14.11-T6 `core/settings-search.spec.ts`** — Settings → Web search: the two switches, the backend select, a key
     saved (write-only, Replace / Remove), **Test search** against the fake remote, the rejected-key error.
  7. **W14.11-T7 Extensions** — `core/project-mcp.spec.ts` (an approved `.mcp.json` server with `oauth` → Sign in from
     the project MCP dialog; a pending one shows Review…, never Sign in).
  8. **W14.11-T8 Mobile and tablet** — `mobile/web-search.spec.ts`, `mobile/elicitation.spec.ts`,
     `mobile/mcp-oauth.spec.ts` (390 px: the card's buttons stacked full width, the toggle icon-only, the callback page
     fits, no horizontal scroll); the tablet touch-target spec covers the toggle, the card buttons, Sign in and the new
     switches (≥ 40 px).
  9. **W14.11-T9 Screenshots** — `mcp-needs-auth`*, `oauth-callback`*, `mcp-dialog-oauth`, `composer-web-search`*,
     `sources-chips`*, `elicitation-card`*, `slash-mcp-group`, `mention-resources`, `settings-web-search`* (dark +
     light;
     * = also mobile) and the `@readme` full-frame shots for every README image.
  10. **W14.11-T10 README** — `e2e/README.md` lists the new specs, the fake remote and the OAuth fixture.
- **Verify.** `pnpm test:e2e --list`; slot runs (`HF_MOCK_PROVIDER=1 HF_OFFLINE=1 HF_PORT=8891
  HF_DATA_DIR=.tmp/W14.11/data HF_TEST_REMOTE_URL=http://127.0.0.1:<fake-remote port> node apps/server/dist/main.mjs`
  with the fake remote started first, `E2E_BASE_URL=http://localhost:8891 pnpm test:e2e`); three green runs of the new
  specs; watch the CI e2e job budget (30 minutes).

### W14.12 docs-final

- **Mission.** Reconcile every doc with the code and the agent reports.
- **Owned.** `README.md`, `.env.example`, `docs/**` except `DECISIONS.md` and `ROADMAP.md`, `docs/assets/**`,
  `examples/plugins/README.md`.
- **Read-only highlights.** `.tmp/waves/P14-A-notes.md`, the code of every Phase 14 area.
- **Tasks.**
  1. **W14.12-T1 Reconcile** — API.md vs the route table and the implemented answers (`mcpAuth`, `chatElicitations`,
     `mcpResources`, `webSearch`, the MCP / project MCP / command / chat / settings / catalog additions, `needs-auth`,
     the notice, the stream notes); UI.md 13.14 vs `utils/testids.ts`, the contracts (10.10), the stores and modules
     (11.10), the copy (15), the shortcuts (12); ARCHITECTURE.md vs the implemented flows (OAuth, the live wait, prompts
     and resources, web search, `core-search`, the stop order, backups, key rotation, the security section, log rules);
     PLUGINS.md (1.7.0, the `webSearch` hook example, `core-search`, Claude plugin `oauth`); PROVIDERS.md (the native
     search matrix as built, 8 "MCP and search mocks (Phase 14)" vs the mocks); the guides `mcp-oauth.md`,
     `web-search.md`, `adding-an-mcp-server.md`, `hooks-and-project-mcp.md`; the section numbers cited in this file.
  2. **W14.12-T2 Status** — README "v1.9" (features: MCP sign-in for remote servers, MCP prompts as slash commands, MCP
     resources in `@` mentions, MCP elicitation forms, web search (the model's own or Brave / Tavily / Exa), plugin API
     1.7.0); `docs/assets/screenshots/` refreshed from the `@readme` shots at the final gate (the coordinator copies
     them).
  3. **W14.12-T3 This file** — what actually happened (status, "Deviations found while building", gate results per
     wave).
- **Verify.** `pnpm check:english`; `pnpm -F @harness-forge/shared test` (doc-coupled tests).

### W14.13 / W14.14 fix-ups

Server (W14.13) and web (W14.14) fix-ups only for red items of Gate P14-A or of W14.11's runs, with the globs of their
items (added to `.tmp/waves/P14-B.json` by the coordinator); a frozen file in such a glob is opened only for that item.

### G14D Docker probe

- **Mission.** `.tmp/gates/P14-B/docker-probe.mjs` against the built image (daemon permitting, else the CI `docker`
  job): the callback works through the container's origin (`-p <host port>:8787`, the fixture on the host reachable from
  the container through a loopback-mapped address or run inside a sidecar on the same network — the probe documents its
  setup); OAuth tokens and search keys are stored encrypted (no plain canary value anywhere under the data volume); the
  OAuth fixture signs in as uid 1000; `docker stop` leaves no orphan.
- **Owned.** `.tmp/gates/P14-B/**`.

### Wave P14-B ownership

```json
{
  "wave": "P14-B",
  "agents": {
    "W14.11": ["e2e/**"],
    "W14.12": [
      "README.md",
      ".env.example",
      "docs/API.md",
      "docs/UI.md",
      "docs/ARCHITECTURE.md",
      "docs/PLUGINS.md",
      "docs/PROVIDERS.md",
      "docs/guides/**",
      "docs/phases/phase-14-v1-9.md",
      "docs/assets/**",
      "examples/plugins/README.md"
    ],
    "W14.13": [],
    "W14.14": [],
    "G14D": [".tmp/gates/P14-B/**"]
  },
  "allow": [
    "docs/ROADMAP.md",
    "docs/DECISIONS.md",
    "AGENT.md",
    "pnpm-lock.yaml",
    ".tmp/**"
  ]
}
```

### Final gate

1. `node scripts/audit-ownership.mjs .tmp/waves/P14-B.json` → `pnpm install --frozen-lockfile` → `pnpm check` → `pnpm
   build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`; `pnpm db:generate` reports no changes.
2. The P14-A probes again (after `mv .tmp/e2e .tmp/e2e-old-final-v19`) plus the regressions (the P12-A, P11-A and P10-A
   copies, P9-A, P8-A `ws git`; one after another: shared ports).
3. `for i in 1 2 3; do pnpm test:e2e || exit 1; done` (`chromium` + `mobile` + `tablet`, with the fake remote), with the
   OS color scheme emulated as light; `E2E_SCREENSHOTS=1 pnpm test:e2e --grep @screenshots` → dark + light reviewed (the
   `needs-auth` row, the OAuth fields, the callback page, the elicitation card, the composer toggle, the sources chips,
   the MCP slash group, the resource mentions, the Web search settings on desktop and mobile); the README images copied
   from the `@readme` shots.
4. `pnpm audit --prod --audit-level high`; the advisories re-checked with the P8-00 rule.
5. **Real v1.8.1 → v1.9 upgrade**: the `.tmp/v181` worktree build (`27699db`) seeds a fresh data directory with the full
   K3S seed set, stop it, start v1.9 on the same data directory → the G14B checks (no migration, every v1.8.1 approval
   still approved, the `oauth` servers `needs-auth` without a retry loop, nothing new run before approval) + signing in
   to the seeded `oauth` server works (the OAuth fixture on the seeded port).
6. **Docker** (G14D's results or the CI `docker` job).
7. `pnpm test` is hermetic: `git status --porcelain` of the repository unchanged, no `.claude/`, `.harness/`,
   `.claude-plugin/` or `.mcp.json` created in the repository, no network beyond loopback, no leftover processes.
8. Every `package.json` → **1.9.0**; ROADMAP (every box, the backlog, the wave log) + memory → commit `chore: final gate
   for harness-forge v1.9`; push and tag `v1.9.0` only when the user asks. The live provider suite stays the user's
   (paid).

---

## Outcome

Completed by the coordinator at each gate ("audit" is the ownership audit of `scripts/audit-ownership.mjs`).

| Wave | Agents | Gate result | Commit |
|---|---|---|---|
| P14-00 | coordinator | baseline `pnpm check` 13815 green on `8108c56`, `git status` unchanged; CI and Audit green; the two ignored advisories unchanged; design reports in `.tmp/p14-designs`; `.tmp/v181` built; `.tmp` archived | — |
| P14-0a | coordinator (K1, K2, contract skeletons, K3 seed by K3S), C47, C48, C49, D18, D19 | _pending_ | _pending_ |
| P14-0b | coordinator (K4), C50, C51, C52, C53, C54, G14B | _pending_ | _pending_ |
| P14-A | W14.1 – W14.10, G14P (+ W14.13 / W14.14 if red) | _pending_ | _pending_ |
| P14-B | W14.11, W14.12 (+ W14.13 / W14.14 if needed), G14D | _pending_ | _pending_ |
| Final gate v1.9 | coordinator | _pending_ | _pending_ |

---

## Risks

State before P14-0a.

| Risk | Mitigation |
|---|---|
| Elicitation attribution is a heuristic (MCP clients are shared across chats) | decline whenever ambiguous or non-interactive; probes for two chats and a sub-agent (group 3) |
| Servers on protocol `2026-07-28` cannot elicit through the AI SDK | reconnect once without the capability; backlog item |
| Reverse-proxy idle timeouts during a wait (nginx defaults to 60 s) | the 25 s re-yield keep-alive |
| The SDK's OAuth URL guard holds only without a custom `fetch` | the rule + a test pinning the transport configuration (C51-T1) |
| Authorization servers refusing the redirect URI (http LAN origins, pre-registered clients) | the redirect URI shown with Copy; the guide `mcp-oauth.md` |
| The `SameSite=Strict` cookie after a cross-site redirect is an assumption | the SPA page posts with a same-origin fetch; e2e with a password and a genuinely cross-site fixture (W14.11-T1) |
| MCP tool timeout 60 s → 600 s outer (60 s active); every MCP call streams | documented; budget tests (W14.3-T4); probe group 3 |
| The 401 reclassification changes how bad header keys show (`needs-auth`, no retry) | the upgrade note; open point 6's copy; G14B |
| Provider-executed calls reach the approval function; SDK drift | the `not-applicable` rule + a pinned test (C52-T1); the provider tool shape verified in the `.d.ts` |
| Gemini 2.x silently drops function tools next to Google Search | `exclusive` only when the turn sends no function tools (the resolver) |
| Unknown model ids misclassified by the deny-lists | deny-lists rather than allow-lists; live tests by the user |
| `encryptedContent` size in messages; Anthropic `pause_turn` → `stop` | `maxUses` 5; shares and exports strip it (coordinator decision C); documented |
| Native history with search off (Anthropic `server_tool_use` without the tool declared) is unverified | the same-provider history rule; a live test by the user |
| Vendor API drift (Tavily auth, Exa contents) | verified against the vendor docs at implementation (W14.5-T1); the fake's shapes updated through a CCR |
| Prompt injection through snippets, MCP prompts, resources or elicitation messages | plain-text rendering, caps; search reaches only the chosen vendor; no Markdown in the card |
| Cost multipliers (children search too; native fees not counted) | the toggle is off by default (`webSearchDefault: 'off'`); the UI note on provider fees |
| Count pins (routes 141 / 40, fresh 14, SSE 19, settings 34, conflict reasons 16, notices 12, mocks 20, tables 23, test ids) | listed by C47 / C50 / C53 / C54; accepted at the audits; the regression probe copies (open point 15) |
| A cached mock listing hides the new mocks | `mv .tmp/e2e` before every gate |
| Wave size (10 + G14P) | the first cuts (below); W14.13 / W14.14 |
| CI e2e budget (~215 tests + the new specs) | watch the 30-minute job |

First cuts if P14-A overflows (the plan's single list, in this order): remote token revocation (delete tokens locally
only) → the `Notification` `elicitation_dialog` type and its plugin-API change → starting project servers only to list
resources (global resources only) → resource content in tool results → Groq native search → the OpenRouter `plugins`
fallback → confidential clients (client secrets) → multi-select enum fields (declined instead) → Alt+W → the elicitation
jump pill → Exa. A cut is recorded in "Deviations found while building" and in the backlog; the contracts frozen in
P14-0b stay (a cut feature answers as unsupported, it never removes a field).
