// The OAuth MCP fixture of Phase 14 (ADR-059 … ADR-061; C53-T3, FROZEN after Gate P14-0b; phase doc "Mock and fixture
// contract"; this header is the reference): an MCP server behind its own OAuth 2.1 authorization server, with tools that
// ask for input (elicitation), prompts and resources, so the tests, the gate probes and the e2e specs drive MCP sign-in,
// elicitation, prompts and resources without any real MCP or OAuth host. Built only on `@modelcontextprotocol/sdk`
// (root dev dependency) and Node built-ins; loopback only; no file writes; every state lives in memory.
//
// Run as a script:
//   node apps/server/src/mcp/__fixtures__/oauth-mcp-server.mjs --port <n> [--host 127.0.0.1] [--name <name>]
//     [--clients <id>,<id>,…] [toggles]
// prints `{"url":"<origin>/mcp","origin":"<origin>"}` as its first stdout line and serves until SIGTERM / SIGINT. Port 0
// (the default) picks a free port; the host must be a loopback address (`127.0.0.1` default, `::1`, `localhost`).
// `--clients` replaces the list of pre-registered client ids (below). Toggle flags carry the toggle names:
// `--preRegistered`, `--noMetadata`, `--approvePage`, `--noAuth`, `--protocol2026` (booleans), `--foreignAs <url>`,
// `--tokenLifeSec <n>`. `--stdio` serves the stdio variant instead (below).
// Imported: `startOAuthMcpServer(options)` (`{ port?, host?, name?, clients?, toggles? }`) → `{ url, origin, port,
// counters(), resetCounters(), toggles(), setToggle(name, value), issueToken(options?), revokeAll(), stop() }` (types in
// `oauth-mcp-server.d.mts`); `createFixtureMcpServer(options)` builds the SDK server of the stdio variant (or of one HTTP
// session).
//
// Pre-registered clients (option `clients`, flag `--clients`; default `DEFAULT_PRE_REGISTERED_CLIENTS` =
// `fixture-client`, `seed-client`, `seed-plugin-client`, the client ids the v1.8.1 upgrade seed configures): they exist
// whatever the toggles say (a server configured with one of these client ids signs in without registration), accept any
// http(s) redirect URI and are public clients (no client secret; PKCE is required for every client). The one exception
// is `fixture-client`, which also knows the secret `fixture-secret`: a request that presents a secret for it must
// present exactly that one (`client_secret_basic` or `client_secret_post`). A secret presented for another public
// client is refused (`invalid_client`).
//
// MCP endpoint `<origin>/mcp`: stateful Streamable HTTP with SSE responses (a server-to-client request such as
// `elicitation/create` needs a session and travels on the open response stream of its `tools/call`). Every request
// (POST, GET, DELETE) without a valid `Authorization: Bearer <access token>` answers 401 with `WWW-Authenticate: Bearer
// resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="mcp:read mcp:write"` (plus
// `error="invalid_token"` when a token was sent but is unknown, expired or revoked). A `server/discover` request (the
// first request of `@ai-sdk/mcp` 2.0.81, which probes protocol `2026-07-28`) answers a JSON-RPC "method not found", so
// the client falls back to `initialize` (protocol `2025-11-25`); with `protocol2026` it is answered (below). A GET or
// DELETE without a session answers 405 (the client opens its GET stream once before `initialize`), a POST without a
// session that is not an `initialize` 400, an unknown session 404.
//
// OAuth endpoints (same origin; the issuer is `<origin>`):
// - `GET /.well-known/oauth-protected-resource/mcp` (and `/.well-known/oauth-protected-resource`): `{ resource:
//   "<origin>/mcp", authorization_servers: ["<origin>"], scopes_supported, bearer_methods_supported: ["header"] }`;
// - `GET /.well-known/oauth-authorization-server`: issuer, `authorization_endpoint`, `token_endpoint`,
//   `registration_endpoint` (absent with `preRegistered`), `revocation_endpoint`, `response_types_supported: ["code"]`,
//   `grant_types_supported`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported:
//   ["none", "client_secret_post", "client_secret_basic"]`, `authorization_response_iss_parameter_supported: true`;
//   `/.well-known/openid-configuration` always 404;
// - `POST /register` (RFC 7591, JSON): a client with the given `redirect_uris` (required, http(s)); a `client_secret`
//   (then required at the token endpoint) unless `token_endpoint_auth_method` is `none`; 201 with the client
//   information; refused (400 `access_denied`) with `preRegistered`;
// - `GET /authorize`: an unknown `client_id` or a `redirect_uri` that is not http(s) or not registered for a dynamic
//   client answers a 400 page (no redirect); then `response_type=code`, `code_challenge` with
//   `code_challenge_method=S256`, a `state` and (when sent) `resource` = `<origin>/mcp` are required, else a redirect
//   with `error` (`invalid_request`, `unsupported_response_type`, `invalid_target`); valid requests auto-approve with a
//   302 to `redirect_uri?code=…&state=…&iss=<origin>`, or with `approvePage` serve a small HTML page with an **Approve**
//   and a **Deny** button (`POST /authorize/decision`; Deny redirects with `error=access_denied`). Codes live 60 s and
//   are single use; a pre-registered client accepts any http(s) redirect URI;
// - `POST /token` (form body; client authentication `client_secret_basic`, `client_secret_post` or `none` for a public
//   client, see "Pre-registered clients"): `authorization_code` (code, `redirect_uri` and the PKCE `code_verifier`
//   checked; `resource` must match when sent) and `refresh_token` (rotated: the old refresh token is revoked); access tokens expire after `tokenLifeSec`
//   (3600 by default); a used, unknown, expired or revoked code or refresh token answers 400 `invalid_grant`, a bad
//   client 401 `invalid_client`;
// - `POST /revoke` (RFC 7009, form body, client authentication): revokes an access token, or a refresh token and every
//   access token issued with it; always 200 for a known client.
// Tokens carry the subject `fixture-user`, the client id and the scope (`mcp:read mcp:write` unless another scope was
// asked for).
//
// Tools (`ask`, `ask_echo`, `slow_ask`, `whoami`; `__touch` in the stdio variant only):
// - `ask` `{ form?: 'basic' | 'all-types' | 'sensitive' | 'multi' | 'unsupported' | 'url' }` (default `basic`): sends
//   `elicitation/create` with the form of `ELICITATION_FORMS` (`url` = a URL-mode request `{ mode: 'url', message, url,
//   elicitationId }`, sent even when the client did not declare URL support, so the harness's `unsupported` decline can
//   be tested; it also carries an empty `requestedSchema`, because `@ai-sdk/mcp` 2.0.81 answers a request without one
//   with a `-32602` error before any handler runs) and answers the JSON text
//   `{"action":…,"fields":[<the names of the accepted content, in order>]}`, never the values;
// - `ask_echo` (form `basic`): answers `{"action":…,"content":<the accepted content or null>}` (to prove the answer
//   arrives);
// - `slow_ask`: waits 2 s (abortable), then asks like `ask` with form `basic`;
// - `whoami` (no elicitation): `{"subject":"fixture-user","clientId":…,"scope":…}` from the request's token (all null
//   without one: `noAuth` or stdio);
// - a client without the elicitation capability gets the error result `The client does not support elicitation.`; a
//   failed or cancelled request the error result `Elicitation failed: <message>`. Server-side elicitation requests time
//   out after 10 minutes (longer than every harness wait).
// Prompts: `greet` (`name` required, `greeting` optional: one user text message `<greeting|Hello>, <name>!`), `review`
// (`topic` optional: an assistant message, then a user message), `with_resource` (a user text, then the embedded text
// resource `fixture://notes/readme.md`), `with_image` (a user text, then a PNG image content); a missing required
// argument or an unknown prompt is a JSON-RPC `-32602` error.
// Resources: `fixture://notes/readme.md` (`text/markdown`, small), `fixture://notes/large.txt` (`text/plain`, exactly 6
// MiB, the 413 path), `fixture://images/pixel.png` (`image/png`, a base64 blob); the template `fixture://notes/{name}`
// (listed by `resources/templates/list` only); an unknown URI is a JSON-RPC `-32002` error. Capabilities: `tools`,
// `prompts` and `resources` (both `listChanged: true`).
//
// Counters (`GET /__counters`, `counters()`; `POST /__reset` or `resetCounters()` zeroes them): `connects` (`initialize`
// requests, counted before the auth check, so a 401'd attempt counts; with `protocol2026` also `server/discover`
// requests), `discovers` (`server/discover` requests), `unauthorized` (401 answers of `/mcp`), `registrations` (`POST
// /register`), `authorizations` (`GET /authorize`), `tokens` (`authorization_code` requests), `refreshes`
// (`refresh_token` requests), `revocations` (`POST /revoke`), `promptsGet`, `resourcesRead`, `elicitations` (requests
// sent, or `input_required` answers with `protocol2026`), `toolCalls`. `POST /__revoke-all` / `revokeAll()` revokes every
// access and refresh token (the `invalid_grant` path of a refresh).
//
// Toggles (flags, `setToggle(name, value)` or `POST /__toggle` with `{ "name": …, "value": … }`):
// - `preRegistered`: no dynamic registration: the metadata has no `registration_endpoint` and `POST /register` is
//   refused, so only the pre-registered clients (above) can sign in;
// - `foreignAs <url | null>`: the protected-resource metadata names that authorization server (e.g.
//   `http://169.254.169.254/` or `http://10.0.0.1/`; never served here, for the URL guard);
// - `noMetadata`: the 401 has no `resource_metadata` (`WWW-Authenticate: Bearer realm="mcp"`) and both well-known
//   documents answer 404 (the endpoints stay);
// - `tokenLifeSec <n>`: the life of new access tokens (short-lived tokens for the refresh path);
// - `approvePage`: the HTML approve page instead of the auto-approval;
// - `noAuth`: `/mcp` answers without a token (no 401 at all);
// - `protocol2026`: `server/discover` answers `{ resultType: "complete", supportedVersions: ["2026-07-28", …],
//   capabilities, _meta: { "io.modelcontextprotocol/serverInfo": … } }`, so `@ai-sdk/mcp` negotiates `2026-07-28`; the
//   requests of that protocol (header `mcp-protocol-version: 2026-07-28`, no session) are answered statelessly as JSON
//   with `resultType: "complete"`; an eliciting tool answers `resultType: "input_required"` when the request's
//   `_meta["io.modelcontextprotocol/clientCapabilities"]` declares elicitation (the multi round-trip the AI SDK does not
//   support yet), else the error result above. Requests of the older protocols keep the stateful path.
//
// stdio variant (`--stdio`): the same tools, prompts and resources over stdio, without OAuth, plus the tool `__touch`,
// which sends `notifications/prompts/list_changed` and `notifications/resources/list_changed` and, from the first touch
// on, lists one more prompt (`touched`, no arguments) and one more resource (`fixture://notes/touched.md`).
import { Buffer } from 'node:buffer'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ElicitResultSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

// ---------- constants ----------

export const FIXTURE_SERVER_NAME = 'oauth-fixture'
export const FIXTURE_CLIENT_ID = 'fixture-client'
export const FIXTURE_CLIENT_SECRET = 'fixture-secret'
/** The pre-registered (public) client ids of a fixture started without `clients`. */
export const DEFAULT_PRE_REGISTERED_CLIENTS = Object.freeze([FIXTURE_CLIENT_ID, 'seed-client', 'seed-plugin-client'])
export const FIXTURE_SCOPE = 'mcp:read mcp:write'
export const FIXTURE_SUBJECT = 'fixture-user'
export const FIXTURE_MCP_PATH = '/mcp'
export const FIXTURE_PROTOCOL_2026 = '2026-07-28'
export const DEFAULT_TOKEN_LIFE_SEC = 3600
export const CODE_LIFE_MS = 60_000
export const SLOW_ASK_DELAY_MS = 2000
export const ELICITATION_TIMEOUT_MS = 600_000
export const LARGE_RESOURCE_BYTES = 6 * 1024 * 1024

export const README_URI = 'fixture://notes/readme.md'
export const LARGE_URI = 'fixture://notes/large.txt'
export const PIXEL_URI = 'fixture://images/pixel.png'
export const TOUCHED_URI = 'fixture://notes/touched.md'
export const README_TEXT = '# Fixture notes\n\nThis is the readme of the OAuth MCP fixture.\n'
/** A 1x1 PNG. */
export const PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
export const URL_ELICITATION_URL = 'https://example.invalid/fixture-elicit'

export const COUNTER_NAMES = Object.freeze([
  'connects',
  'discovers',
  'unauthorized',
  'registrations',
  'authorizations',
  'tokens',
  'refreshes',
  'revocations',
  'promptsGet',
  'resourcesRead',
  'elicitations',
  'toolCalls',
])

export const TOGGLE_NAMES = Object.freeze(['preRegistered', 'foreignAs', 'noMetadata', 'tokenLifeSec', 'approvePage', 'noAuth', 'protocol2026'])

const BOOLEAN_TOGGLES = new Set(['preRegistered', 'noMetadata', 'approvePage', 'noAuth', 'protocol2026'])
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const BODY_MAX_BYTES = 4 * 1024 * 1024
const PENDING_APPROVAL_MS = 600_000
const BEARER_HEADER = /^bearer\s+(\S+)$/i
const CLIENT_ID_PATTERN = /^[\w.:-]{1,128}$/

function defaultToggles() {
  return { preRegistered: false, foreignAs: null, noMetadata: false, tokenLifeSec: DEFAULT_TOKEN_LIFE_SEC, approvePage: false, noAuth: false, protocol2026: false }
}

function zeroCounters() {
  return Object.fromEntries(COUNTER_NAMES.map(name => [name, 0]))
}

// ---------- elicitation forms ----------

const BASIC_FORM = {
  message: 'The OAuth MCP fixture needs a few details.',
  requestedSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', title: 'Name', description: 'Your name', minLength: 1, maxLength: 50 },
      email: { type: 'string', title: 'Email', format: 'email' },
      count: { type: 'integer', title: 'Count', minimum: 1, maximum: 10 },
      subscribe: { type: 'boolean', title: 'Subscribe', default: false },
      color: { type: 'string', title: 'Color', enum: ['red', 'green', 'blue'] },
    },
    required: ['name'],
  },
}

/** The forms of the `ask` tool (`form` input): `params` of `elicitation/create`. */
export const ELICITATION_FORMS = Object.freeze({
  'basic': BASIC_FORM,
  'all-types': {
    message: 'Every supported field type.',
    requestedSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', title: 'Text', minLength: 2, maxLength: 20 },
        email: { type: 'string', title: 'Email', format: 'email' },
        website: { type: 'string', title: 'Website', format: 'uri' },
        birthday: { type: 'string', title: 'Birthday', format: 'date' },
        meeting: { type: 'string', title: 'Meeting', format: 'date-time' },
        ratio: { type: 'number', title: 'Ratio', minimum: 0, maximum: 1 },
        count: { type: 'integer', title: 'Count', minimum: 1, maximum: 10 },
        agree: { type: 'boolean', title: 'Agree', default: true },
        size: { type: 'string', title: 'Size', enum: ['s', 'm', 'l'], enumNames: ['Small', 'Medium', 'Large'] },
        plan: { type: 'string', title: 'Plan', oneOf: [{ const: 'free', title: 'Free' }, { const: 'pro', title: 'Pro' }] },
        tags: { type: 'array', title: 'Tags', items: { type: 'string', enum: ['a', 'b', 'c'] }, minItems: 1, maxItems: 2 },
        nickname: { title: 'Nickname', anyOf: [{ type: 'string', maxLength: 30 }, { type: 'null' }] },
      },
      required: ['text', 'email'],
    },
  },
  'sensitive': {
    message: 'Sign in to the fixture service.',
    requestedSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', title: 'Username' },
        password: { type: 'string', title: 'Password' },
        api_key: { type: 'string', title: 'API key' },
      },
      required: ['username', 'password'],
    },
  },
  'multi': {
    message: 'Pick your toppings.',
    requestedSchema: {
      type: 'object',
      properties: {
        toppings: { type: 'array', title: 'Toppings', items: { type: 'string', enum: ['cheese', 'ham', 'olives'] }, minItems: 1, maxItems: 2 },
        extras: { type: 'array', title: 'Extras', items: { anyOf: [{ const: 'fries', title: 'Fries' }, { const: 'salad', title: 'Salad' }] } },
      },
      required: ['toppings'],
    },
  },
  'unsupported': {
    message: 'A nested object (outside the supported subset).',
    requestedSchema: {
      type: 'object',
      properties: {
        address: { type: 'object', title: 'Address', properties: { street: { type: 'string' } } },
      },
    },
  },
  'url': {
    mode: 'url',
    message: 'Open the fixture page to continue.',
    url: URL_ELICITATION_URL,
    elicitationId: 'fixture-url-elicitation',
    // `@ai-sdk/mcp` 2.0.81 answers -32602 to a request without `requestedSchema` before any handler runs.
    requestedSchema: { type: 'object', properties: {} },
  },
})

export const ELICITATION_FORM_NAMES = Object.freeze(Object.keys(ELICITATION_FORMS))

// ---------- tools, prompts, resources ----------

const EMPTY_INPUT = { type: 'object', properties: {} }

export const FIXTURE_TOOLS = Object.freeze([
  {
    name: 'ask',
    description: 'Asks the user for input (elicitation) and answers the action and the field names, never the values.',
    inputSchema: { type: 'object', properties: { form: { type: 'string', enum: [...Object.keys(ELICITATION_FORMS)] } } },
  },
  { name: 'ask_echo', description: 'Asks the user for input (the basic form) and answers the action and the content.', inputSchema: EMPTY_INPUT },
  { name: 'slow_ask', description: 'Waits 2 seconds, then asks the user for input (the basic form).', inputSchema: EMPTY_INPUT },
  { name: 'whoami', description: 'Answers the subject, the client id and the scope of the access token.', inputSchema: EMPTY_INPUT, annotations: { readOnlyHint: true } },
])

const TOUCH_TOOL = { name: '__touch', description: 'Sends the prompts and resources list_changed notifications.', inputSchema: EMPTY_INPUT }

export const FIXTURE_PROMPTS = Object.freeze([
  {
    name: 'greet',
    title: 'Greet',
    description: 'Greets someone by name.',
    arguments: [
      { name: 'name', description: 'Who to greet', required: true },
      { name: 'greeting', description: 'The greeting word (default Hello)', required: false },
    ],
  },
  { name: 'review', description: 'An assistant message, then a review request.', arguments: [{ name: 'topic', description: 'What to review', required: false }] },
  { name: 'with_resource', description: 'Embeds the fixture readme as a text resource.' },
  { name: 'with_image', description: 'Embeds a one-pixel PNG image.' },
])

const TOUCHED_PROMPT = { name: 'touched', description: 'Listed after the first __touch.' }

const README_BYTES = Buffer.byteLength(README_TEXT)
const PIXEL_BYTES = Buffer.from(PIXEL_PNG_BASE64, 'base64').length

export const FIXTURE_RESOURCES = Object.freeze([
  { uri: README_URI, name: 'readme.md', title: 'Fixture notes', description: 'A small markdown note.', mimeType: 'text/markdown', size: README_BYTES },
  { uri: LARGE_URI, name: 'large.txt', title: 'Large text', description: 'A 6 MiB text file (over the attach limit).', mimeType: 'text/plain', size: LARGE_RESOURCE_BYTES },
  { uri: PIXEL_URI, name: 'pixel.png', title: 'Pixel', description: 'A one-pixel PNG image.', mimeType: 'image/png', size: PIXEL_BYTES },
])

export const FIXTURE_RESOURCE_TEMPLATES = Object.freeze([
  { uriTemplate: 'fixture://notes/{name}', name: 'note', title: 'Any note', description: 'A note by name (never listed by the harness).', mimeType: 'text/plain' },
])

const TOUCHED_RESOURCE = { uri: TOUCHED_URI, name: 'touched.md', title: 'Touched', description: 'Listed after the first __touch.', mimeType: 'text/markdown' }

const SERVER_CAPABILITIES = { tools: {}, prompts: { listChanged: true }, resources: { listChanged: true } }

let largeText = null

/** The 6 MiB text of `fixture://notes/large.txt` (built once). */
function largeResourceText() {
  if (largeText === null) {
    const line = 'This line belongs to the large text resource of the OAuth MCP fixture.\n'
    largeText = line.repeat(Math.ceil(LARGE_RESOURCE_BYTES / line.length)).slice(0, LARGE_RESOURCE_BYTES)
  }
  return largeText
}

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

function invalidParams(message) {
  return new McpError(ErrorCode.InvalidParams, message)
}

function abortableWait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('The request was cancelled.'))
      return
    }
    let timer
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('The request was cancelled.'))
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Thrown by `elicit` in the protocol `2026-07-28` path: the answer becomes `resultType: "input_required"`. */
class InputRequired {
  constructor(params) {
    this.params = params
  }
}

function listPrompts(state) {
  return state.touches > 0 ? [...FIXTURE_PROMPTS, TOUCHED_PROMPT] : [...FIXTURE_PROMPTS]
}

function listResources(state) {
  return state.touches > 0 ? [...FIXTURE_RESOURCES, TOUCHED_RESOURCE] : [...FIXTURE_RESOURCES]
}

function getPrompt(state, name, args = {}) {
  state.counters.promptsGet++
  const prompt = listPrompts(state).find(entry => entry.name === name)
  if (prompt === undefined)
    throw invalidParams(`Unknown prompt: ${name}`)
  for (const argument of prompt.arguments ?? []) {
    if (argument.required && (typeof args[argument.name] !== 'string' || args[argument.name] === ''))
      throw invalidParams(`Missing required argument: ${argument.name}`)
  }
  switch (name) {
    case 'greet':
      return { description: 'A greeting.', messages: [{ role: 'user', content: { type: 'text', text: `${args.greeting || 'Hello'}, ${args.name}!` } }] }
    case 'review':
      return {
        description: 'A review request.',
        messages: [
          { role: 'assistant', content: { type: 'text', text: 'I will review it carefully.' } },
          { role: 'user', content: { type: 'text', text: `Please review ${args.topic || 'the latest change'}.` } },
        ],
      }
    case 'with_resource':
      return {
        messages: [
          { role: 'user', content: { type: 'text', text: 'Summarize these notes.' } },
          { role: 'user', content: { type: 'resource', resource: { uri: README_URI, mimeType: 'text/markdown', text: README_TEXT } } },
        ],
      }
    case 'with_image':
      return {
        messages: [
          { role: 'user', content: { type: 'text', text: 'Describe this image.' } },
          { role: 'user', content: { type: 'image', data: PIXEL_PNG_BASE64, mimeType: 'image/png' } },
        ],
      }
    default:
      return { messages: [{ role: 'user', content: { type: 'text', text: `Touched ${state.touches} times.` } }] }
  }
}

function readResource(state, uri) {
  state.counters.resourcesRead++
  switch (uri) {
    case README_URI:
      return { contents: [{ uri, mimeType: 'text/markdown', text: README_TEXT }] }
    case LARGE_URI:
      return { contents: [{ uri, mimeType: 'text/plain', text: largeResourceText() }] }
    case PIXEL_URI:
      return { contents: [{ uri, mimeType: 'image/png', blob: PIXEL_PNG_BASE64 }] }
    case TOUCHED_URI:
      if (state.touches > 0)
        return { contents: [{ uri, mimeType: 'text/markdown', text: `Touched ${state.touches} times.\n` }] }
      break
  }
  throw new McpError(-32002, `Resource not found: ${uri}`)
}

/**
 * One tool call. `ctx`: `{ canElicit(), elicit(params), authInfo, signal, touch() }`; `elicit` sends the request (or
 * throws `InputRequired`).
 */
async function callFixtureTool(state, name, args, ctx) {
  state.counters.toolCalls++
  const ask = async (formName, echo) => {
    const form = ELICITATION_FORMS[formName]
    if (form === undefined)
      return errorResult(`Unknown form: ${formName}`)
    if (!ctx.canElicit())
      return errorResult('The client does not support elicitation.')
    state.counters.elicitations++
    let result
    try {
      result = await ctx.elicit(form)
    }
    catch (error) {
      if (error instanceof InputRequired)
        throw error
      return errorResult(`Elicitation failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const content = result.content ?? null
    if (echo)
      return textResult({ action: result.action, content })
    return textResult({ action: result.action, fields: Object.keys(content ?? {}) })
  }
  switch (name) {
    case 'ask':
      return ask(typeof args.form === 'string' ? args.form : 'basic', false)
    case 'ask_echo':
      return ask('basic', true)
    case 'slow_ask':
      try {
        await abortableWait(SLOW_ASK_DELAY_MS, ctx.signal)
      }
      catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error))
      }
      return ask('basic', false)
    case 'whoami': {
      const info = ctx.authInfo
      return textResult({ subject: info?.extra?.subject ?? null, clientId: info?.clientId ?? null, scope: info?.scopes?.join(' ') ?? null })
    }
    case '__touch':
      if (ctx.touch !== undefined) {
        state.touches++
        await ctx.touch()
        return textResult({ touches: state.touches })
      }
      break
  }
  return errorResult(`Unknown tool ${name}`)
}

/**
 * The SDK server of one HTTP session or of the stdio variant (not connected). `state` is shared with the HTTP front end
 * (counters, touches); `stdio` adds `__touch`.
 */
export function createFixtureMcpServer(options = {}) {
  const state = options.state ?? { counters: zeroCounters(), touches: 0 }
  const stdio = options.stdio === true
  const server = new Server({ name: options.name ?? FIXTURE_SERVER_NAME, version: '1.0.0' }, { capabilities: SERVER_CAPABILITIES })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: stdio ? [...FIXTURE_TOOLS, TOUCH_TOOL] : [...FIXTURE_TOOLS] }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => callFixtureTool(state, request.params.name, request.params.arguments ?? {}, {
    canElicit: () => server.getClientCapabilities()?.elicitation !== undefined,
    elicit: params => extra.sendRequest({ method: 'elicitation/create', params }, ElicitResultSchema, { timeout: ELICITATION_TIMEOUT_MS, signal: extra.signal }),
    authInfo: extra.authInfo,
    signal: extra.signal,
    touch: stdio
      ? async () => {
        await server.sendPromptListChanged()
        await server.sendResourceListChanged()
      }
      : undefined,
  }))
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: listPrompts(state) }))
  server.setRequestHandler(GetPromptRequestSchema, async request => getPrompt(state, request.params.name, request.params.arguments ?? {}))
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: listResources(state) }))
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [...FIXTURE_RESOURCE_TEMPLATES] }))
  server.setRequestHandler(ReadResourceRequestSchema, async request => readResource(state, request.params.uri))
  return server
}

// ---------- HTTP helpers ----------

function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  res.end(body)
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

function redirect(res, location) {
  res.writeHead(302, { 'location': location, 'cache-control': 'no-store' })
  res.end()
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[char])
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><main>${body}</main></body></html>`
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_MAX_BYTES) {
        reject(Object.assign(new Error('The request body is too large.'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  }
  catch {
    return { ok: false }
  }
}

function randomToken(prefix) {
  return `${prefix}_${randomBytes(24).toString('hex')}`
}

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || !URL.canParse(value))
    return false
  const url = new URL(value)
  return url.protocol === 'http:' || url.protocol === 'https:'
}

function oauthError(res, status, error, description) {
  sendJson(res, status, { error, error_description: description })
}

// ---------- the HTTP server ----------

/**
 * Starts the fixture on a loopback port: see the module comment. `options`: `{ port?: number (0), host?: string
 * ('127.0.0.1'), name?: string, clients?: string[] (DEFAULT_PRE_REGISTERED_CLIENTS), toggles?: Partial<toggles> }`.
 */
export async function startOAuthMcpServer(options = {}) {
  const host = options.host ?? '127.0.0.1'
  if (!LOOPBACK_HOSTS.has(host))
    throw new Error(`The OAuth MCP fixture listens on loopback only (got "${host}").`)
  const name = options.name ?? FIXTURE_SERVER_NAME
  const state = { counters: zeroCounters(), touches: 0 }
  const toggles = defaultToggles()
  const clients = new Map()
  const preRegistered = options.clients ?? DEFAULT_PRE_REGISTERED_CLIENTS
  if (!Array.isArray(preRegistered) || !preRegistered.every(id => typeof id === 'string' && CLIENT_ID_PATTERN.test(id)))
    throw new Error('clients must be a list of client ids ([A-Za-z0-9_.:-], 1 … 128 characters).')
  for (const clientId of preRegistered)
    addPreRegistered(clientId)
  const codes = new Map()
  const pendingApprovals = new Map()
  const accessTokens = new Map()
  const refreshTokens = new Map()
  const sessions = new Map()
  let origin = ''

  const resourceUrl = () => `${origin}${FIXTURE_MCP_PATH}`
  const metadataUrl = () => `${origin}/.well-known/oauth-protected-resource${FIXTURE_MCP_PATH}`

  function setToggle(toggle, value) {
    if (!TOGGLE_NAMES.includes(toggle))
      throw new Error(`Unknown toggle: ${toggle}`)
    if (BOOLEAN_TOGGLES.has(toggle)) {
      toggles[toggle] = value === true || value === 'true'
    }
    else if (toggle === 'foreignAs') {
      if (value !== null && value !== undefined && !isHttpUrl(value))
        throw new Error('foreignAs must be an http(s) URL or null.')
      toggles.foreignAs = value ?? null
    }
    else {
      const seconds = Number(value)
      if (!Number.isSafeInteger(seconds) || seconds < 1)
        throw new Error('tokenLifeSec must be a positive integer.')
      toggles.tokenLifeSec = seconds
    }
  }

  /** A pre-registered public client (`fixture-client` also knows its optional secret). */
  function addPreRegistered(clientId) {
    if (clients.has(clientId))
      return
    const secret = clientId === FIXTURE_CLIENT_ID ? FIXTURE_CLIENT_SECRET : null
    clients.set(clientId, { clientId, secret, secretRequired: false, redirectUris: null, name: clientId, preRegistered: true })
  }

  function issueTokens(clientId, scope) {
    const now = Date.now()
    const refreshToken = randomToken('rt')
    const accessToken = randomToken('at')
    refreshTokens.set(refreshToken, { clientId, scope, revoked: false })
    accessTokens.set(accessToken, { clientId, scope, subject: FIXTURE_SUBJECT, expiresAt: now + toggles.tokenLifeSec * 1000, refreshToken, revoked: false })
    return { access_token: accessToken, token_type: 'Bearer', expires_in: toggles.tokenLifeSec, refresh_token: refreshToken, scope }
  }

  function revokeRefresh(refreshToken) {
    const record = refreshTokens.get(refreshToken)
    if (record !== undefined)
      record.revoked = true
    for (const access of accessTokens.values()) {
      if (access.refreshToken === refreshToken)
        access.revoked = true
    }
  }

  /** The client of a token or revocation request (Basic header, else the form body), or an error. */
  function authenticateClient(req, params) {
    let clientId = params.get('client_id')
    let secret = params.get('client_secret')
    const header = req.headers.authorization
    if (typeof header === 'string' && /^basic /i.test(header)) {
      const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8')
      const colon = decoded.indexOf(':')
      if (colon < 0)
        return { error: 'invalid_client' }
      clientId = decodeURIComponent(decoded.slice(0, colon))
      secret = decodeURIComponent(decoded.slice(colon + 1))
    }
    const client = clientId === null ? undefined : clients.get(clientId)
    if (client === undefined)
      return { error: 'invalid_client' }
    const presented = secret !== null && secret !== undefined && secret !== ''
    if (client.secret === null ? presented : (presented || client.secretRequired) && secret !== client.secret)
      return { error: 'invalid_client' }
    return { client }
  }

  /** The auth info of the request's bearer token, or `{ error }` (null = no token). */
  function bearer(req) {
    const header = req.headers.authorization
    const match = typeof header === 'string' ? header.trim().match(BEARER_HEADER) : null
    if (match === null)
      return { error: null }
    const record = accessTokens.get(match[1])
    if (record === undefined || record.revoked || record.expiresAt <= Date.now())
      return { error: 'invalid_token' }
    return {
      info: {
        token: match[1],
        clientId: record.clientId,
        scopes: record.scope.split(' ').filter(Boolean),
        expiresAt: Math.floor(record.expiresAt / 1000),
        extra: { subject: record.subject },
      },
    }
  }

  function unauthorized(res, error) {
    state.counters.unauthorized++
    const challenge = toggles.noMetadata
      ? 'Bearer realm="mcp"'
      : `Bearer resource_metadata="${metadataUrl()}", scope="${FIXTURE_SCOPE}"${error === null ? '' : `, error="${error}"`}`
    sendJson(res, 401, { error: error ?? 'unauthorized', error_description: 'A valid access token is required.' }, { 'www-authenticate': challenge })
  }

  // ----- OAuth -----

  function protectedResourceMetadata(res) {
    if (toggles.noMetadata)
      return sendJson(res, 404, { error: 'not_found' })
    sendJson(res, 200, {
      resource: resourceUrl(),
      authorization_servers: [toggles.foreignAs ?? origin],
      scopes_supported: FIXTURE_SCOPE.split(' '),
      bearer_methods_supported: ['header'],
      resource_name: 'OAuth MCP fixture',
    })
  }

  function authorizationServerMetadata(res) {
    if (toggles.noMetadata)
      return sendJson(res, 404, { error: 'not_found' })
    sendJson(res, 200, {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      ...(toggles.preRegistered ? {} : { registration_endpoint: `${origin}/register` }),
      revocation_endpoint: `${origin}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: FIXTURE_SCOPE.split(' '),
      authorization_response_iss_parameter_supported: true,
    })
  }

  async function register(req, res) {
    state.counters.registrations++
    if (toggles.preRegistered)
      return oauthError(res, 400, 'access_denied', 'Dynamic client registration is disabled.')
    const parsed = parseJson(await readBody(req))
    const metadata = parsed.ok && typeof parsed.value === 'object' && parsed.value !== null ? parsed.value : null
    const redirectUris = metadata?.redirect_uris
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every(isHttpUrl))
      return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must list http(s) URLs.')
    const method = typeof metadata.token_endpoint_auth_method === 'string' ? metadata.token_endpoint_auth_method : 'client_secret_basic'
    if (!['none', 'client_secret_basic', 'client_secret_post'].includes(method))
      return oauthError(res, 400, 'invalid_client_metadata', `Unsupported token_endpoint_auth_method: ${method}`)
    const clientId = `dyn_${randomBytes(12).toString('hex')}`
    const secret = method === 'none' ? null : randomToken('cs')
    const clientName = typeof metadata.client_name === 'string' ? metadata.client_name.slice(0, 100) : clientId
    clients.set(clientId, { clientId, secret, secretRequired: secret !== null, redirectUris: [...redirectUris], name: clientName, preRegistered: false })
    sendJson(res, 201, {
      ...metadata,
      client_id: clientId,
      ...(secret === null ? {} : { client_secret: secret, client_secret_expires_at: 0 }),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: [...redirectUris],
      token_endpoint_auth_method: method,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    })
  }

  function redirectWith(res, redirectUri, params) {
    const url = new URL(redirectUri)
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null)
        url.searchParams.set(key, value)
    }
    redirect(res, url.href)
  }

  function issueCode(request) {
    const code = randomToken('code')
    codes.set(code, { ...request, expiresAt: Date.now() + CODE_LIFE_MS, used: false })
    return code
  }

  function authorize(url, res) {
    state.counters.authorizations++
    const params = url.searchParams
    const client = clients.get(params.get('client_id') ?? '')
    if (client === undefined)
      return sendHtml(res, 400, page('Authorization error', '<h1>Unknown client</h1><p>The client_id is not registered.</p>'))
    const redirectUri = params.get('redirect_uri')
    if (!isHttpUrl(redirectUri) || (client.redirectUris !== null && !client.redirectUris.includes(redirectUri)))
      return sendHtml(res, 400, page('Authorization error', '<h1>Invalid redirect URI</h1><p>The redirect_uri is not registered for this client.</p>'))
    const flowState = params.get('state')
    const fail = (error, description) => redirectWith(res, redirectUri, { error, error_description: description, state: flowState, iss: origin })
    if (params.get('response_type') !== 'code')
      return fail('unsupported_response_type', 'Only response_type=code is supported.')
    const codeChallenge = params.get('code_challenge')
    if (codeChallenge === null || codeChallenge === '' || params.get('code_challenge_method') !== 'S256')
      return fail('invalid_request', 'A code_challenge with code_challenge_method=S256 is required.')
    if (flowState === null || flowState === '')
      return fail('invalid_request', 'A state is required.')
    const resource = params.get('resource')
    if (resource !== null && resource !== resourceUrl())
      return fail('invalid_target', 'The resource is not this MCP server.')
    const request = { clientId: client.clientId, redirectUri, codeChallenge, state: flowState, resource, scope: params.get('scope') || FIXTURE_SCOPE }
    if (toggles.approvePage) {
      const id = randomUUID()
      pendingApprovals.set(id, { ...request, expiresAt: Date.now() + PENDING_APPROVAL_MS })
      return sendHtml(res, 200, page('Authorize OAuth MCP fixture', [
        '<h1>Authorize access</h1>',
        `<p>The client <strong>${escapeHtml(client.name)}</strong> asks for the scope <code>${escapeHtml(request.scope)}</code> on the OAuth MCP fixture.</p>`,
        '<form method="post" action="/authorize/decision">',
        `<input type="hidden" name="request" value="${escapeHtml(id)}">`,
        '<button type="submit" name="decision" value="approve">Approve</button> ',
        '<button type="submit" name="decision" value="deny">Deny</button>',
        '</form>',
      ].join('')))
    }
    redirectWith(res, redirectUri, { code: issueCode(request), state: flowState, iss: origin })
  }

  async function decision(req, res) {
    const params = new URLSearchParams(await readBody(req))
    const id = params.get('request') ?? ''
    const request = pendingApprovals.get(id)
    pendingApprovals.delete(id)
    if (request === undefined || request.expiresAt <= Date.now())
      return sendHtml(res, 400, page('Authorization error', '<h1>Unknown request</h1><p>This approval was already used or expired.</p>'))
    if (params.get('decision') !== 'approve')
      return redirectWith(res, request.redirectUri, { error: 'access_denied', error_description: 'The user denied the request.', state: request.state, iss: origin })
    const { expiresAt: _expiresAt, ...grant } = request
    redirectWith(res, request.redirectUri, { code: issueCode(grant), state: request.state, iss: origin })
  }

  async function token(req, res) {
    const params = new URLSearchParams(await readBody(req))
    const grantType = params.get('grant_type')
    if (grantType === 'authorization_code')
      state.counters.tokens++
    else if (grantType === 'refresh_token')
      state.counters.refreshes++
    const authenticated = authenticateClient(req, params)
    if (authenticated.error !== undefined)
      return oauthError(res, 401, 'invalid_client', 'Client authentication failed.')
    const client = authenticated.client
    const resource = params.get('resource')
    if (resource !== null && resource !== resourceUrl())
      return oauthError(res, 400, 'invalid_target', 'The resource is not this MCP server.')
    if (grantType === 'authorization_code') {
      const record = codes.get(params.get('code') ?? '')
      if (record === undefined || record.used || record.expiresAt <= Date.now() || record.clientId !== client.clientId)
        return oauthError(res, 400, 'invalid_grant', 'The authorization code is invalid, used or expired.')
      record.used = true
      if (params.get('redirect_uri') !== record.redirectUri)
        return oauthError(res, 400, 'invalid_grant', 'The redirect_uri does not match the authorization request.')
      const verifier = params.get('code_verifier') ?? ''
      if (base64Url(createHash('sha256').update(verifier).digest()) !== record.codeChallenge)
        return oauthError(res, 400, 'invalid_grant', 'The PKCE code_verifier does not match the code_challenge.')
      return sendJson(res, 200, issueTokens(client.clientId, record.scope))
    }
    if (grantType === 'refresh_token') {
      const refreshToken = params.get('refresh_token') ?? ''
      const record = refreshTokens.get(refreshToken)
      if (record === undefined || record.revoked || record.clientId !== client.clientId)
        return oauthError(res, 400, 'invalid_grant', 'The refresh token is invalid or revoked.')
      revokeRefresh(refreshToken)
      return sendJson(res, 200, issueTokens(client.clientId, record.scope))
    }
    oauthError(res, 400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported.')
  }

  async function revoke(req, res) {
    state.counters.revocations++
    const params = new URLSearchParams(await readBody(req))
    const authenticated = authenticateClient(req, params)
    if (authenticated.error !== undefined)
      return oauthError(res, 401, 'invalid_client', 'Client authentication failed.')
    const value = params.get('token') ?? ''
    if (refreshTokens.has(value)) {
      if (refreshTokens.get(value).clientId === authenticated.client.clientId)
        revokeRefresh(value)
    }
    else if (accessTokens.has(value)) {
      const record = accessTokens.get(value)
      if (record.clientId === authenticated.client.clientId)
        record.revoked = true
    }
    res.writeHead(200, { 'cache-control': 'no-store' })
    res.end()
  }

  // ----- MCP -----

  /** The protocol `2026-07-28` answer of one request (stateless). */
  async function modernAnswer(message, authInfo) {
    const { id, method } = message
    const params = message.params ?? {}
    const capabilities = params._meta?.['io.modelcontextprotocol/clientCapabilities'] ?? {}
    const complete = result => ({ jsonrpc: '2.0', id, result: { resultType: 'complete', ...result } })
    try {
      switch (method) {
        case 'server/discover':
          return complete({
            supportedVersions: [FIXTURE_PROTOCOL_2026, '2025-11-25', '2025-06-18', '2025-03-26'],
            capabilities: SERVER_CAPABILITIES,
            _meta: { 'io.modelcontextprotocol/serverInfo': { name, version: '1.0.0' } },
          })
        case 'ping':
          return complete({})
        case 'tools/list':
          return complete({ tools: [...FIXTURE_TOOLS] })
        case 'tools/call':
          return complete(await callFixtureTool(state, params.name, params.arguments ?? {}, {
            canElicit: () => capabilities.elicitation !== undefined,
            elicit: async (form) => {
              throw new InputRequired(form)
            },
            authInfo,
            signal: undefined,
            touch: undefined,
          }))
        case 'prompts/list':
          return complete({ prompts: listPrompts(state) })
        case 'prompts/get':
          return complete(getPrompt(state, params.name, params.arguments ?? {}))
        case 'resources/list':
          return complete({ resources: listResources(state) })
        case 'resources/templates/list':
          return complete({ resourceTemplates: [...FIXTURE_RESOURCE_TEMPLATES] })
        case 'resources/read':
          return complete(readResource(state, params.uri))
        default:
          return { jsonrpc: '2.0', id, error: { code: ErrorCode.MethodNotFound, message: `Method not found: ${method}` } }
      }
    }
    catch (error) {
      if (error instanceof InputRequired)
        return { jsonrpc: '2.0', id, result: { resultType: 'input_required', inputRequests: { elicitation: { method: 'elicitation/create', params: error.params } } } }
      const code = error instanceof McpError ? error.code : ErrorCode.InternalError
      return { jsonrpc: '2.0', id, error: { code, message: error instanceof Error ? error.message : String(error) } }
    }
  }

  async function modern(res, messages, authInfo) {
    const answers = []
    for (const message of messages) {
      if (message !== null && typeof message === 'object' && typeof message.method === 'string' && message.id !== undefined)
        answers.push(await modernAnswer(message, authInfo))
    }
    if (answers.length === 0) {
      res.writeHead(202).end()
      return
    }
    sendJson(res, 200, answers.length === 1 ? answers[0] : answers)
  }

  async function mcp(req, res) {
    let body
    if (req.method === 'POST') {
      const parsed = parseJson(await readBody(req))
      if (!parsed.ok)
        return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: ErrorCode.ParseError, message: 'Parse error' } })
      body = parsed.value
    }
    const messages = Array.isArray(body) ? body : body === undefined ? [] : [body]
    const methods = messages.flatMap(message => (message !== null && typeof message === 'object' && typeof message.method === 'string' ? [message.method] : []))
    const isInitialize = methods.includes('initialize')
    const isDiscover = methods.includes('server/discover')
    if (isInitialize)
      state.counters.connects++
    if (isDiscover) {
      state.counters.discovers++
      if (toggles.protocol2026)
        state.counters.connects++
    }
    let authInfo
    if (!toggles.noAuth) {
      const checked = bearer(req)
      if (checked.info === undefined)
        return unauthorized(res, checked.error)
      authInfo = checked.info
      req.auth = authInfo
    }
    const sessionId = req.headers['mcp-session-id']
    if (toggles.protocol2026 && req.method === 'POST' && sessionId === undefined && (isDiscover || req.headers['mcp-protocol-version'] === FIXTURE_PROTOCOL_2026))
      return modern(res, messages, authInfo)
    if (isDiscover) {
      const id = messages.find(message => message?.method === 'server/discover')?.id ?? null
      return sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: ErrorCode.MethodNotFound, message: 'Method not found: server/discover' } })
    }
    if (typeof sessionId === 'string') {
      const session = sessions.get(sessionId)
      if (session === undefined)
        return sendJson(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } })
      return session.transport.handleRequest(req, res, body)
    }
    // `@ai-sdk/mcp` opens its GET stream once before `initialize`: 405 = no stream without a session (it stays quiet).
    if (req.method !== 'POST')
      return sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed without a session.' } }, { allow: 'POST' })
    if (!isInitialize)
      return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: No valid session ID provided' } })
    const server = createFixtureMcpServer({ name, state })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server })
      },
    })
    transport.onclose = () => {
      if (transport.sessionId !== undefined)
        sessions.delete(transport.sessionId)
    }
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  // ----- routing -----

  async function route(req, res) {
    const url = new URL(req.url ?? '/', origin)
    const path = url.pathname
    if (path === FIXTURE_MCP_PATH)
      return mcp(req, res)
    if (req.method === 'GET' && (path === `/.well-known/oauth-protected-resource${FIXTURE_MCP_PATH}` || path === '/.well-known/oauth-protected-resource'))
      return protectedResourceMetadata(res)
    if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server')
      return authorizationServerMetadata(res)
    if (req.method === 'GET' && path === '/authorize')
      return authorize(url, res)
    if (req.method === 'POST' && path === '/authorize/decision')
      return decision(req, res)
    if (req.method === 'POST' && path === '/register')
      return register(req, res)
    if (req.method === 'POST' && path === '/token')
      return token(req, res)
    if (req.method === 'POST' && path === '/revoke')
      return revoke(req, res)
    if (req.method === 'GET' && path === '/__counters')
      return sendJson(res, 200, { ...state.counters })
    if (req.method === 'POST' && path === '/__reset') {
      resetCounters()
      return sendJson(res, 200, { ...state.counters })
    }
    if (req.method === 'POST' && path === '/__revoke-all') {
      revokeAll()
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && path === '/__toggle') {
      const parsed = parseJson(await readBody(req))
      try {
        if (!parsed.ok || typeof parsed.value?.name !== 'string')
          throw new Error('Expected { "name": …, "value": … }.')
        setToggle(parsed.value.name, parsed.value.value)
      }
      catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return sendJson(res, 200, { ...toggles })
    }
    if (req.method === 'GET' && path === '/')
      return sendJson(res, 200, { name, url: resourceUrl() })
    sendJson(res, 404, { error: 'not_found' })
  }

  function resetCounters() {
    for (const counter of COUNTER_NAMES)
      state.counters[counter] = 0
  }

  function revokeAll() {
    for (const record of accessTokens.values())
      record.revoked = true
    for (const record of refreshTokens.values())
      record.revoked = true
  }

  const httpServer = createServer((req, res) => {
    route(req, res).catch((error) => {
      if (!res.headersSent)
        sendJson(res, error?.status === 413 ? 413 : 500, { error: error instanceof Error ? error.message : String(error) })
      else
        res.end()
    })
  })
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(options.port ?? 0, host, () => {
      httpServer.off('error', reject)
      resolve()
    })
  })
  const port = httpServer.address().port
  origin = `http://${host.includes(':') ? `[${host}]` : host}:${port}`
  for (const [toggle, value] of Object.entries(options.toggles ?? {}))
    setToggle(toggle, value)

  return {
    url: resourceUrl(),
    origin,
    port,
    counters: () => ({ ...state.counters }),
    resetCounters,
    toggles: () => ({ ...toggles }),
    setToggle,
    /** A valid token pair without the browser flow (`clientId` default `fixture-client`; an unknown id is pre-registered). */
    issueToken: (tokenOptions = {}) => {
      const clientId = tokenOptions.clientId ?? FIXTURE_CLIENT_ID
      if (!CLIENT_ID_PATTERN.test(clientId))
        throw new Error('Invalid client id.')
      addPreRegistered(clientId)
      const issued = issueTokens(clientId, tokenOptions.scope ?? FIXTURE_SCOPE)
      return { accessToken: issued.access_token, refreshToken: issued.refresh_token, expiresIn: issued.expires_in }
    },
    revokeAll,
    stop: async () => {
      for (const session of [...sessions.values()]) {
        await session.transport.close().catch(() => {})
        await session.server.close().catch(() => {})
      }
      sessions.clear()
      await new Promise((resolve) => {
        httpServer.closeAllConnections()
        httpServer.close(() => resolve())
      })
    },
  }
}

// ---------- script ----------

function parseArgs(argv) {
  const options = { port: 0, host: '127.0.0.1', name: FIXTURE_SERVER_NAME, stdio: false, toggles: {}, clients: undefined }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const next = () => {
      const value = argv[++index]
      if (value === undefined)
        throw new Error(`${flag} needs a value.`)
      return value
    }
    switch (flag) {
      case '--port':
        options.port = Number(next())
        break
      case '--host':
        options.host = next()
        break
      case '--name':
        options.name = next()
        break
      case '--stdio':
        options.stdio = true
        break
      case '--clients':
        options.clients = next().split(',').map(id => id.trim()).filter(id => id !== '')
        break
      case '--foreignAs':
        options.toggles.foreignAs = next()
        break
      case '--tokenLifeSec':
        options.toggles.tokenLifeSec = next()
        break
      default:
        if (flag.startsWith('--') && BOOLEAN_TOGGLES.has(flag.slice(2))) {
          options.toggles[flag.slice(2)] = true
          break
        }
        throw new Error(`Unknown argument: ${flag}`)
    }
  }
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535)
    throw new Error('--port must be 0 … 65535.')
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.stdio) {
    const server = createFixtureMcpServer({ name: options.name, stdio: true })
    await server.connect(new StdioServerTransport())
    return
  }
  const fixture = await startOAuthMcpServer(options)
  const shutdown = () => {
    fixture.stop().then(() => process.exit(0), () => process.exit(1))
  }
  // The handlers exist before the URL line: a caller may stop the script as soon as it has read it.
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  process.stdout.write(`${JSON.stringify({ url: fixture.url, origin: fixture.origin })}\n`)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error) => {
    process.stderr.write(`oauth-mcp-server: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
