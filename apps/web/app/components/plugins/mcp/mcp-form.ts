// Pure rules of the MCP servers panel and its add / edit dialog (docs/UI.md 8.12, docs/API.md 4.9 and 5.13): status
// text and dots, the form state of McpServerDialog, validation, request bodies and the mapping of server errors to
// fields. Header and environment VALUES are write-only secrets: the form never holds a stored value, an existing row
// with an empty input keeps its stored secret (`null` in `McpServerUpdate`), and a removed row is deleted.
// Phase 14 (ADR-059; C54 declares the signatures, W14.7 owns the module in P14-A; signatures frozen from Gate P14-0b): the
// OAuth settings of an http / sse server (`McpOAuthDraft`: client id, scopes, a write-only client secret), the redirect
// URI shown with Copy (`redirectUriFor`: built in script, never a `//` in a template prop value, vue-tsc #6240), when a
// row offers Sign in (`canSignIn`), when saving drops the tokens (`signsOut`), and " · Signed in" in the status line.
import type {
  HarnessError,
  McpOAuthInput,
  McpOAuthUpdate,
  McpServer,
  McpServerInput,
  McpServerUpdate,
  McpStatus,
  McpTransportInput,
  McpTransportUpdate,
  SecretState,
  ToolPolicy,
} from '@harness-forge/shared'
import type { HarnessErrorView } from '~/components/common/harness-error'
import type { StatusDotStatus } from '~/components/common/status'
import {
  ENV_VAR_NAME_PATTERN,
  HTTP_HEADER_NAME_PATTERN,
  httpHeaderValueSchema,
  httpUrlSchema,
  MCP_SERVER_ID_PATTERN,
  mcpServerInputSchema,
  mcpServerUpdateSchema,
} from '@harness-forge/shared'
import { toHarnessErrorView } from '~/components/common/harness-error'
import { formatRelativeTime } from '~/components/common/relative-time'
import { toHarnessError } from '~/utils/errors'

export type McpTransportType = McpServer['transport']['type']

/** The plugin that owns user-configured MCP servers (the only one whose servers are editable). */
export const CORE_MCP_PLUGIN_ID = 'core-mcp'

export const NAME_MAX = 100
export const ARGS_MAX = 256
export const ARG_MAX_CHARS = 4096
export const COMMAND_MAX_CHARS = 4096
export const ENV_VALUE_MAX_CHARS = 32_768
export const HEADER_VALUE_MAX_CHARS = 8192
/** Longest id: `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`. */
export const ID_MAX = 32

// ---------- display ----------

/** Transport tabs and badges, in tab order. */
export const TRANSPORT_OPTIONS: readonly { value: McpTransportType, label: string }[] = [
  { value: 'stdio', label: 'stdio' },
  { value: 'http', label: 'HTTP' },
  { value: 'sse', label: 'SSE' },
]

export function transportLabel(type: McpTransportType): string {
  return TRANSPORT_OPTIONS.find(option => option.value === type)?.label ?? type
}

/** Policy choices of the dialog (the policy of tools without read-only / destructive hints). */
export const POLICY_OPTIONS: readonly { value: ToolPolicy, label: string, description: string }[] = [
  { value: 'safe', label: 'Safe', description: 'Runs without asking in Ask mode' },
  { value: 'ask', label: 'Ask', description: 'Asks before running in Ask mode' },
  { value: 'always', label: 'Always ask', description: 'Asks even in Auto mode' },
]

export function policyLabel(policy: ToolPolicy): string {
  return POLICY_OPTIONS.find(option => option.value === policy)?.label ?? policy
}

/** Status dot per connection status (docs/UI.md 5.10). */
export const MCP_STATUS_DOTS: Readonly<Record<McpStatus, StatusDotStatus>> = {
  'connected': 'ok',
  'connecting': 'running',
  'error': 'error',
  'disabled': 'off',
  // Phase 14 (ADR-059): the server asks for a sign-in (W14.7 adds the Sign in action).
  'needs-auth': 'warning',
}

/** Short tooltip / screen reader label of the status dot (the row shows the full status line next to it). */
export const MCP_STATUS_LABELS: Readonly<Record<McpStatus, string>> = {
  'connected': 'Connected',
  'connecting': 'Connecting',
  'error': 'Error',
  'disabled': 'Disabled',
  'needs-auth': 'Sign in required',
}

/** "1 tool" / "12 tools". */
export function toolCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'tool' : 'tools'}`
}

/** + W14.7: the status line of a `needs-auth` server whose own `Authorization` header was refused (open point 6). */
export const AUTHORIZATION_REJECTED_TEXT = 'The server rejected its Authorization header.'

/** + W14.7: the note of the OAuth section while an `Authorization` header row is set. */
export const AUTHORIZATION_HEADER_NOTE = 'Servers with an Authorization header don\'t sign in.'

/**
 * Status line of a server row: "Connected · 12 tools", "Connecting…", "Error: {message}", "Disabled"; + Phase 14: "Sign
 * in required", and " · Signed in" after a connected server's tools when it holds OAuth tokens. A `needs-auth` server
 * with an `Authorization` header cannot sign in (the server refuses it): its line names the header instead.
 */
export function mcpStatusText(server: Pick<McpServer, 'status' | 'tools' | 'error'> & { auth?: McpServer['auth'], transport?: McpServer['transport'] }): string {
  switch (server.status) {
    case 'connected':
      return `Connected · ${toolCountLabel(server.tools.length)}${server.auth?.signedIn ? ' · Signed in' : ''}`
    case 'connecting':
      return 'Connecting…'
    case 'error':
      return `Error: ${server.error?.message?.trim() || 'The server could not be reached.'}`
    case 'needs-auth':
      return server.transport && hasAuthorizationHeader(server) ? AUTHORIZATION_REJECTED_TEXT : 'Sign in required'
    default:
      return 'Disabled'
  }
}

// ---------- OAuth sign-in (Phase 14, ADR-059) ----------

/** The path of the sign-in callback page (the redirect URI of every MCP sign-in is `<origin>/oauth/callback`). */
export const OAUTH_CALLBACK_PATH = '/oauth/callback'

/** The redirect URI the authorization server sends the browser back to (shown read-only with Copy). */
export function redirectUriFor(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${OAUTH_CALLBACK_PATH}`
}

/** The OAuth fields of the dialog (`McpOAuthFields`): the client secret is write-only (never a stored value). */
export interface McpOAuthDraft {
  clientId: string
  scopes: string
  /** What the user typed; '' keeps a stored secret on an update. */
  clientSecret: string
  /** Remove the stored client secret (its Remove toggle). */
  removeSecret: boolean
}

/** The draft of a server's OAuth settings (empty for a new server, a stdio server or one without OAuth settings). */
export function oauthDraftOf(server: McpServer | null): McpOAuthDraft {
  const oauth = server && server.transport.type !== 'stdio' ? server.transport.oauth : null
  return { clientId: oauth?.clientId ?? '', scopes: oauth?.scopes ?? '', clientSecret: '', removeSecret: false }
}

/** `transport.oauth` of `POST /mcp`; undefined when every field is empty. */
export function oauthInputOf(draft: McpOAuthDraft): Extract<McpServerInput['transport'], { type: 'http' | 'sse' }>['oauth'] | undefined {
  const clientId = draft.clientId.trim()
  const scopes = draft.scopes.trim()
  const clientSecret = draft.clientSecret.trim()
  if (clientId === '' && scopes === '')
    return undefined
  const oauth: McpOAuthInput = {}
  if (clientId !== '')
    oauth.clientId = clientId
  if (scopes !== '')
    oauth.scopes = scopes
  if (clientId !== '' && clientSecret !== '')
    oauth.clientSecret = clientSecret
  return oauth
}

/**
 * `transport.oauth` of `PATCH /mcp/:id` (the transport is replaced, so the OAuth settings are always sent; undefined
 * removes them): a stored secret that was neither replaced nor removed is kept (`clientSecret: null`).
 */
export function oauthUpdateOf(server: McpServer, draft: McpOAuthDraft): McpOAuthUpdate | undefined {
  const input = oauthInputOf(draft)
  if (!input)
    return undefined
  const stored = server.transport.type !== 'stdio' && server.transport.oauth?.clientSecret.set === true
  const update: McpOAuthUpdate = { ...input }
  if (update.clientSecret === undefined && stored && !draft.removeSecret && update.clientId !== undefined)
    update.clientSecret = null
  return update
}

/** Saving these values drops the server's tokens: it is signed in and its URL, transport type or client id change. */
export function signsOut(server: McpServer, next: { url: string, type: string, clientId: string }): boolean {
  if (!server.auth?.signedIn || server.transport.type === 'stdio')
    return false
  return next.url.trim() !== server.transport.url
    || next.type !== server.transport.type
    || next.clientId.trim() !== (server.transport.oauth?.clientId ?? '')
}

/** A row offers Sign in: the server asks for one, is on, remote and has no `Authorization` header. */
export function canSignIn(server: Pick<McpServer, 'status' | 'enabled' | 'transport'>): boolean {
  if (server.status !== 'needs-auth' || !server.enabled || server.transport.type === 'stdio')
    return false
  return !hasAuthorizationHeader(server)
}

/** + W14.7: an http / sse server whose headers carry `Authorization` (any case): it never signs in (400). */
export function hasAuthorizationHeader(server: { transport?: McpServer['transport'] }): boolean {
  const transport = server.transport
  if (!transport || transport.type === 'stdio')
    return false
  return Object.keys(transport.headers).some(name => name.toLowerCase() === 'authorization')
}

/**
 * + W14.7: a `needs-auth` row whose server refused its own `Authorization` header: it shows the header note and, for a
 * personal server, Edit… instead of Sign in.
 */
export function rejectsAuthorizationHeader(server: Pick<McpServer, 'status' | 'transport'>): boolean {
  return server.status === 'needs-auth' && hasAuthorizationHeader(server)
}

/**
 * + W14.7: the tooltip of a signed-in row: "Signed in · expires {time}" while the access token's expiry is ahead (a
 * refresh renews it), else "Signed in · token renews automatically"; null when not signed in. Never a token or a scope.
 */
export function signedInTooltip(auth: McpServer['auth'] | undefined, now: number = Date.now()): string | null {
  if (!auth?.signedIn)
    return null
  if (auth.expiresAt !== null && auth.expiresAt > now)
    return `Signed in · expires ${formatRelativeTime(new Date(auth.expiresAt), now)}`
  return 'Signed in · token renews automatically'
}

/** + W14.7: the OAuth fields differ from the server's stored settings (a new client id or scopes, a typed or removed secret). */
export function oauthChanged(server: McpServer, draft: McpOAuthDraft): boolean {
  const current = server.transport.type === 'stdio' ? null : server.transport.oauth
  return draft.clientId.trim() !== (current?.clientId ?? '')
    || draft.scopes.trim() !== (current?.scopes ?? '')
    || draft.clientSecret.trim() !== ''
    || (draft.removeSecret && current?.clientSecret.set === true)
}

/** + W14.7: failures a new attempt may fix (the alert offers Retry). */
const SIGN_IN_RETRY_CODES: ReadonlySet<string> = new Set(['provider_error', 'provider_unreachable', 'auth_invalid', 'internal_error', 'rate_limited'])

/** + W14.7: the reason of a 409 answer (`details.reason`), else undefined. */
function conflictReasonOf(view: HarnessErrorView): string | undefined {
  const details = view.details as { reason?: unknown } | undefined
  return view.code === 'conflict' && typeof details?.reason === 'string' ? details.reason : undefined
}

/**
 * + W14.7: a failed Sign in / Sign out as the view of the row's inline HarnessErrorAlert (`mcp-sign-in-error`): the
 * server's message ("Turn the server on first." for 409 `disabled`); provider failures offer Retry (never "Open
 * settings": there is no API key to fix), other refusals no action. The code stays the server's (`data-code`).
 */
export function signInErrorView(error: unknown): HarnessErrorView {
  const view = toHarnessErrorView(error)
  const shown: HarnessErrorView = { code: view.code, message: view.message }
  if (view.details !== undefined)
    shown.details = view.details
  if (conflictReasonOf(view) === 'disabled')
    shown.message = 'Turn the server on first.'
  if (SIGN_IN_RETRY_CODES.has(view.code))
    shown.action = 'retry'
  return shown
}

/** Only user-configured (`core-mcp`) servers can be edited, switched and deleted; plugin servers only restarted. */
export function isEditable(server: Pick<McpServer, 'editable'>): boolean {
  return server.editable
}

// ---------- form state ----------

/** A header (HTTP / SSE) or environment variable (stdio) row of the dialog. */
export interface SecretRow {
  /** Stable key for `v-for`. */
  uid: number
  name: string
  /** What the user typed; never a stored value. On a stored row, empty keeps the stored secret. */
  value: string
  /** State of the stored secret this row stands for (its name is fixed), or null for a row added in the dialog. */
  stored: SecretState | null
}

export interface McpFormState {
  name: string
  id: string
  /** The id was typed by the user, so it no longer follows the name. */
  idEdited: boolean
  type: McpTransportType
  url: string
  headers: SecretRow[]
  command: string
  /** Arguments, one per line. */
  args: string
  env: SecretRow[]
  policy: ToolPolicy
}

let nextRowUid = 1

/** A new, empty header / env row. */
export function newRow(name = '', value = ''): SecretRow {
  return { uid: nextRowUid++, name, value, stored: null }
}

function storedRows(record: Record<string, SecretState>): SecretRow[] {
  return Object.entries(record).map(([name, state]) => ({ uid: nextRowUid++, name, value: '', stored: state }))
}

/** The dialog state for a new server (stdio first, like the tabs; policy Ask). */
export function emptyForm(): McpFormState {
  return {
    name: '',
    id: '',
    idEdited: false,
    type: 'stdio',
    url: '',
    headers: [],
    command: '',
    args: '',
    env: [],
    policy: 'ask',
  }
}

/** The dialog state of an existing server: stored header / env values stay on the server (rows with empty inputs). */
export function formFromServer(server: McpServer): McpFormState {
  const form = emptyForm()
  form.name = server.name
  form.id = server.id
  form.idEdited = true
  form.policy = server.policy
  form.type = server.transport.type
  if (server.transport.type === 'stdio') {
    form.command = server.transport.command
    form.args = server.transport.args.join('\n')
    form.env = storedRows(server.transport.env)
  }
  else {
    form.url = server.transport.url
    form.headers = storedRows(server.transport.headers)
  }
  return form
}

/**
 * The id derived from a name: lowercase ASCII letters and digits joined by single dashes, at most 32 characters,
 * without a leading or trailing dash ("GitHub MCP" -> "github-mcp").
 */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ID_MAX)
    .replace(/-+$/, '')
}

/** Arguments from the textarea: one per line, trimmed; blank lines are dropped. */
export function parseArgs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
}

/** A row without name, value and stored secret is ignored (e.g. a freshly added row left empty). */
export function isBlankRow(row: SecretRow): boolean {
  return row.stored === null && row.name.trim() === '' && row.value.trim() === ''
}

/** Rows that take part in the request. */
export function activeRows(rows: readonly SecretRow[]): SecretRow[] {
  return rows.filter(row => !isBlankRow(row))
}

/**
 * Header / env record of a request. With `keepStored`, a stored row whose input stayed empty sends `null` (keep the
 * stored secret); values are trimmed.
 */
export function secretRecord(rows: readonly SecretRow[], keepStored: true): Record<string, string | null>
export function secretRecord(rows: readonly SecretRow[], keepStored: false): Record<string, string>
export function secretRecord(rows: readonly SecretRow[], keepStored: boolean): Record<string, string | null> {
  const record: Record<string, string | null> = {}
  for (const row of activeRows(rows)) {
    const value = row.value.trim()
    record[row.name.trim()] = keepStored && row.stored !== null && value === '' ? null : value
  }
  return record
}

function nonEmpty<T extends object>(record: T): T | undefined {
  return Object.keys(record).length > 0 ? record : undefined
}

/** The transport of `POST /mcp`. */
export function buildTransportInput(state: McpFormState): McpTransportInput {
  if (state.type === 'stdio') {
    const args = parseArgs(state.args)
    const env = nonEmpty(secretRecord(state.env, false))
    return {
      type: 'stdio',
      command: state.command.trim(),
      ...(args.length > 0 ? { args } : {}),
      ...(env ? { env } : {}),
    }
  }
  const headers = nonEmpty(secretRecord(state.headers, false))
  return { type: state.type, url: state.url.trim(), ...(headers ? { headers } : {}) }
}

/** The replacement transport of `PATCH /mcp/:id` (`null` keeps a stored value, missing keys are removed). */
export function buildTransportUpdate(state: McpFormState): McpTransportUpdate {
  if (state.type === 'stdio') {
    const args = parseArgs(state.args)
    const env = nonEmpty(secretRecord(state.env, true))
    return {
      type: 'stdio',
      command: state.command.trim(),
      ...(args.length > 0 ? { args } : {}),
      ...(env ? { env } : {}),
    }
  }
  const headers = nonEmpty(secretRecord(state.headers, true))
  return { type: state.type, url: state.url.trim(), ...(headers ? { headers } : {}) }
}

/**
 * Body of `POST /mcp` (new servers start enabled). + W14.7: with the dialog's OAuth fields (`oauth`), an http / sse
 * transport carries `oauth` when a client id or scopes are set (`oauthInputOf`).
 */
export function buildCreateInput(state: McpFormState, oauth?: McpOAuthDraft): McpServerInput {
  const transport = buildTransportInput(state)
  if (transport.type !== 'stdio' && oauth) {
    const input = oauthInputOf(oauth)
    if (input)
      transport.oauth = input
  }
  return {
    id: state.id.trim(),
    name: state.name.trim(),
    transport,
    policy: state.policy,
    enabled: true,
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function secretsChanged(stored: Record<string, SecretState>, rows: readonly SecretRow[]): boolean {
  const active = activeRows(rows)
  const names = active.map(row => row.name.trim()).sort()
  if (!sameList(names, Object.keys(stored).sort()))
    return true
  return active.some(row => row.value.trim() !== '')
}

/** The form describes another transport than the server has (a new type, target, argument or secret value). */
export function transportChanged(server: McpServer, state: McpFormState): boolean {
  const current = server.transport
  if (current.type !== state.type)
    return true
  if (current.type === 'stdio') {
    return current.command !== state.command.trim()
      || !sameList(current.args, parseArgs(state.args))
      || secretsChanged(current.env, state.env)
  }
  return current.url !== state.url.trim() || secretsChanged(current.headers, state.headers)
}

/**
 * Body of `PATCH /mcp/:id`: only what changed (empty when nothing did). + W14.7: with the dialog's OAuth fields
 * (`oauth`), a change of them alone also sends the transport, and every http / sse transport sent carries the OAuth
 * settings (`oauthUpdateOf`: the transport is replaced, so an omitted `oauth` would remove them).
 */
export function buildUpdatePatch(server: McpServer, state: McpFormState, oauth?: McpOAuthDraft): McpServerUpdate {
  const patch: McpServerUpdate = {}
  const name = state.name.trim()
  if (name !== server.name)
    patch.name = name
  if (state.policy !== server.policy)
    patch.policy = state.policy
  const remote = state.type !== 'stdio'
  if (transportChanged(server, state) || (remote && oauth !== undefined && oauthChanged(server, oauth))) {
    const transport = buildTransportUpdate(state)
    if (transport.type !== 'stdio' && oauth) {
      const update = oauthUpdateOf(server, oauth)
      if (update)
        transport.oauth = update
    }
    patch.transport = transport
  }
  return patch
}

export type McpSaveRequest
  = | { kind: 'create', input: McpServerInput }
    | { kind: 'update', id: string, patch: McpServerUpdate }

/**
 * Saving a stdio server is a fresh-auth action (ADR-017, API.md 5.13): creating one, or sending a stdio transport in
 * an update (the server checks whether it really changed).
 */
export function requiresFreshAuth(request: McpSaveRequest): boolean {
  if (request.kind === 'create')
    return request.input.transport.type === 'stdio'
  return request.patch.transport?.type === 'stdio'
}

// ---------- validation ----------

/** Field messages: `name`, `id`, `url`, `command`, `args`, `row:<uid>` (a header / env row) and `form`. */
export type McpFormErrors = Record<string, string>

export function rowKey(row: Pick<SecretRow, 'uid'>): string {
  return `row:${row.uid}`
}

function hasControlChars(value: string, allowTab = false): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if ((code < 0x20 && !(allowTab && code === 0x09)) || code === 0x7F)
      return true
  }
  return false
}

function validateHeaderRows(rows: readonly SecretRow[], errors: McpFormErrors): void {
  const seen = new Set<string>()
  for (const row of activeRows(rows)) {
    const key = rowKey(row)
    const name = row.name.trim()
    const value = row.value.trim()
    if (name === '')
      errors[key] = 'Enter the header name.'
    else if (!HTTP_HEADER_NAME_PATTERN.test(name))
      errors[key] = 'Header names use letters, digits and ! # $ % & \' * + - . ^ _ ` | ~ only.'
    else if (seen.has(name.toLowerCase()))
      errors[key] = 'This header is listed twice.'
    else if (row.stored === null && value === '')
      errors[key] = 'Enter a value.'
    else if (value.length > HEADER_VALUE_MAX_CHARS)
      errors[key] = `Header values are limited to ${HEADER_VALUE_MAX_CHARS} characters.`
    else if (!httpHeaderValueSchema.safeParse(value).success)
      errors[key] = 'Header values cannot contain line breaks or control characters.'
    seen.add(name.toLowerCase())
  }
}

function validateEnvRows(rows: readonly SecretRow[], errors: McpFormErrors): void {
  const seen = new Set<string>()
  for (const row of activeRows(rows)) {
    const key = rowKey(row)
    const name = row.name.trim()
    if (name === '')
      errors[key] = 'Enter the variable name.'
    else if (!ENV_VAR_NAME_PATTERN.test(name))
      errors[key] = 'Use letters, digits and "_", not starting with a digit.'
    else if (seen.has(name))
      errors[key] = 'This variable is listed twice.'
    else if (row.value.trim().length > ENV_VALUE_MAX_CHARS)
      errors[key] = `Values are limited to ${ENV_VALUE_MAX_CHARS} characters.`
    seen.add(name)
  }
}

/** Client-side checks with friendly messages; an empty result means the form can be sent. */
export function validateForm(state: McpFormState, mode: 'create' | 'edit'): McpFormErrors {
  const errors: McpFormErrors = {}
  const name = state.name.trim()
  if (name === '')
    errors.name = 'Enter a name.'
  else if (name.length > NAME_MAX)
    errors.name = `Use at most ${NAME_MAX} characters.`

  if (mode === 'create') {
    const id = state.id.trim()
    if (id === '')
      errors.id = 'Enter an id.'
    else if (!MCP_SERVER_ID_PATTERN.test(id))
      errors.id = 'Use up to 32 lowercase letters, digits and dashes, starting and ending with a letter or digit.'
  }

  if (state.type === 'stdio') {
    const command = state.command.trim()
    if (command === '')
      errors.command = 'Enter the command to run.'
    else if (hasControlChars(command))
      errors.command = 'The command cannot contain control characters.'
    else if (command.length > COMMAND_MAX_CHARS)
      errors.command = `The command is limited to ${COMMAND_MAX_CHARS} characters.`
    const args = parseArgs(state.args)
    if (args.length > ARGS_MAX)
      errors.args = `Use at most ${ARGS_MAX} arguments.`
    else if (args.some(arg => arg.length > ARG_MAX_CHARS))
      errors.args = `Each argument is limited to ${ARG_MAX_CHARS} characters.`
    validateEnvRows(state.env, errors)
  }
  else {
    const url = state.url.trim()
    if (url === '')
      errors.url = 'Enter the server URL.'
    else if (!httpUrlSchema.safeParse(url).success)
      errors.url = 'Enter an absolute http:// or https:// URL without a user name or password.'
    validateHeaderRows(state.headers, errors)
  }
  return errors
}

// ---------- server issues and errors ----------

interface IssueLike {
  path?: unknown
  message?: unknown
}

/** The field of a validation issue path (`['transport', 'headers', 'Authorization']` -> that header row). */
export function issueField(path: readonly unknown[], state: McpFormState): string | null {
  const [first, second, third] = path
  if (first === 'id' || first === 'name')
    return first
  if (first !== 'transport')
    return null
  if (second === 'url' || second === 'command' || second === 'args')
    return second
  if (second === 'headers' || second === 'env') {
    const rows = second === 'headers' ? state.headers : state.env
    const row = typeof third === 'string' ? activeRows(rows).find(item => item.name.trim() === third) : undefined
    return row ? rowKey(row) : null
  }
  return null
}

function addIssues(issues: readonly IssueLike[], state: McpFormState, errors: McpFormErrors): void {
  for (const issue of issues) {
    const message = typeof issue.message === 'string' && issue.message.trim() !== '' ? issue.message : 'This value is not valid.'
    const field = Array.isArray(issue.path) ? issueField(issue.path, state) : null
    const key = field ?? 'form'
    errors[key] ??= message
  }
}

/** Checks the built body against the shared schema (the server's own validation) and maps its issues to fields. */
export function schemaErrors(request: McpSaveRequest, state: McpFormState): McpFormErrors {
  const result = request.kind === 'create'
    ? mcpServerInputSchema.safeParse(request.input)
    : mcpServerUpdateSchema.safeParse(request.patch)
  const errors: McpFormErrors = {}
  if (!result.success)
    addIssues(result.error.issues as readonly IssueLike[], state, errors)
  return errors
}

function detailsReason(error: HarnessError): string | undefined {
  const details = error.details as { reason?: unknown } | undefined
  return typeof details?.reason === 'string' ? details.reason : undefined
}

/** A failed save as field messages (`form` for everything that has no field). */
export function saveErrorFields(error: unknown, state: McpFormState, mode: 'create' | 'edit'): McpFormErrors {
  const failure = toHarnessError(error)
  if (failure.code === 'conflict' && detailsReason(failure) === 'exists' && mode === 'create')
    return { id: 'This id is already used by another MCP server.' }
  if (failure.code === 'validation_error') {
    const issues = (failure.details as { issues?: unknown } | undefined)?.issues
    if (Array.isArray(issues) && issues.length > 0) {
      const errors: McpFormErrors = {}
      addIssues(issues as IssueLike[], state, errors)
      return errors
    }
  }
  return { form: failure.message }
}

/** Placeholder of a stored secret input: its masked hint, else "Stored" (the value itself is never sent back). */
export function storedPlaceholder(state: SecretState | null): string {
  if (!state?.set)
    return 'Not set · enter a value'
  return state.hint ? `${state.hint} · stored` : 'Stored'
}
