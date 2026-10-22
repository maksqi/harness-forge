import type { McpServer } from '@harness-forge/shared'
import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { mcpServer as mcpServerFixture } from '~/utils/testing/fixtures'
import {
  AUTHORIZATION_REJECTED_TEXT,
  buildCreateInput,
  buildUpdatePatch,
  canSignIn,
  emptyForm,
  formFromServer,
  hasAuthorizationHeader,
  isBlankRow,
  issueField,
  MCP_STATUS_DOTS,
  MCP_STATUS_LABELS,
  mcpStatusText,
  newRow,
  OAUTH_CALLBACK_PATH,
  oauthChanged,
  oauthDraftOf,
  oauthInputOf,
  oauthUpdateOf,
  parseArgs,
  policyLabel,
  redirectUriFor,
  rejectsAuthorizationHeader,
  requiresFreshAuth,
  rowKey,
  saveErrorFields,
  schemaErrors,
  secretRecord,
  signedInTooltip,
  signInErrorView,
  signsOut,
  slugify,
  storedPlaceholder,
  toolCountLabel,
  transportChanged,
  transportLabel,
  validateForm,
} from './mcp-form'

const stored = { set: true, hint: 'ghp_…9fQ2', source: 'stored' as const }

function httpServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 'github',
    name: 'GitHub',
    pluginId: 'core-mcp',
    editable: true,
    transport: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: stored }, oauth: null },
    policy: 'ask',
    enabled: true,
    status: 'connected',
    error: null,
    tools: ['mcp__github__search'],
    connectedAt: 1_759_000_000_000,
    auth: null,
    ...overrides,
  }
}

function stdioServer(overrides: Partial<McpServer> = {}): McpServer {
  return httpServer({
    id: 'everything',
    name: 'Everything',
    transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], env: { API_KEY: stored } },
    ...overrides,
  })
}

describe('display helpers', () => {
  it('writes the status line for every status', () => {
    expect(mcpStatusText({ status: 'connected', tools: ['a', 'b', 'c'], error: null })).toBe('Connected · 3 tools')
    expect(mcpStatusText({ status: 'connected', tools: ['a'], error: null })).toBe('Connected · 1 tool')
    expect(mcpStatusText({ status: 'connected', tools: [], error: null })).toBe('Connected · 0 tools')
    expect(mcpStatusText({ status: 'connecting', tools: [], error: null })).toBe('Connecting…')
    expect(mcpStatusText({ status: 'error', tools: [], error: { code: 'provider_unreachable', message: 'spawn npx ENOENT' } })).toBe('Error: spawn npx ENOENT')
    expect(mcpStatusText({ status: 'error', tools: [], error: null })).toBe('Error: The server could not be reached.')
    expect(mcpStatusText({ status: 'disabled', tools: [], error: null })).toBe('Disabled')
  })

  it('maps statuses to dots and names transports and policies', () => {
    // Phase 14 (ADR-059): `needs-auth` is a warning dot, "Sign in required".
    expect(MCP_STATUS_DOTS).toEqual({ 'connected': 'ok', 'connecting': 'running', 'error': 'error', 'disabled': 'off', 'needs-auth': 'warning' })
    expect(MCP_STATUS_LABELS).toEqual({ 'connected': 'Connected', 'connecting': 'Connecting', 'error': 'Error', 'disabled': 'Disabled', 'needs-auth': 'Sign in required' })
    expect(toolCountLabel(1)).toBe('1 tool')
    expect(toolCountLabel(12)).toBe('12 tools')
    expect([transportLabel('stdio'), transportLabel('http'), transportLabel('sse')]).toEqual(['stdio', 'HTTP', 'SSE'])
    expect([policyLabel('safe'), policyLabel('ask'), policyLabel('always')]).toEqual(['Safe', 'Ask', 'Always ask'])
    expect(storedPlaceholder(stored)).toBe('ghp_…9fQ2 · stored')
    expect(storedPlaceholder({ set: true, hint: null, source: 'stored' })).toBe('Stored')
    expect(storedPlaceholder({ set: false, hint: null, source: null })).toBe('Not set · enter a value')
  })
})

describe('slugify and arguments', () => {
  it('derives an id from the name', () => {
    expect(slugify('GitHub MCP')).toBe('github-mcp')
    expect(slugify('  Crème brûlée -- Server!  ')).toBe('creme-brulee-server')
    expect(slugify('---')).toBe('')
    expect(slugify('a'.repeat(40))).toHaveLength(32)
    expect(slugify(`${'a'.repeat(31)} b`)).toBe('a'.repeat(31))
  })

  it('reads one argument per line, trimmed, without blank lines', () => {
    expect(parseArgs('-y\n  @scope/server  \r\n\n--port=3000\n')).toEqual(['-y', '@scope/server', '--port=3000'])
    expect(parseArgs('')).toEqual([])
  })
})

describe('form state', () => {
  it('starts a new server as stdio with policy Ask', () => {
    expect(emptyForm()).toMatchObject({ name: '', id: '', idEdited: false, type: 'stdio', policy: 'ask', headers: [], env: [] })
  })

  it('loads a server without any stored value', () => {
    const form = formFromServer(httpServer())
    expect(form).toMatchObject({ name: 'GitHub', id: 'github', idEdited: true, type: 'http', url: 'https://mcp.example.com/mcp', policy: 'ask' })
    expect(form.headers).toEqual([{ uid: expect.any(Number), name: 'Authorization', value: '', stored }])
    const stdio = formFromServer(stdioServer())
    expect(stdio).toMatchObject({ type: 'stdio', command: 'npx', args: '-y\n@modelcontextprotocol/server-everything' })
    expect(stdio.env.map(row => [row.name, row.value, row.stored?.set])).toEqual([['API_KEY', '', true]])
    expect(JSON.stringify(form)).not.toContain('secret')
  })

  it('ignores blank rows and keeps stored rows with `null`', () => {
    const rows = [
      { ...newRow('Authorization', ''), stored },
      newRow('X-Team', ' blue '),
      newRow(),
    ]
    expect(isBlankRow(rows[2]!)).toBe(true)
    expect(secretRecord(rows, true)).toEqual({ 'Authorization': null, 'X-Team': 'blue' })
    expect(secretRecord(rows, false)).toEqual({ 'Authorization': '', 'X-Team': 'blue' })
  })
})

describe('request bodies', () => {
  it('builds POST /mcp bodies for every transport', () => {
    const http = { ...emptyForm(), name: ' GitHub ', id: 'github', type: 'http' as const, url: ' https://mcp.example.com/mcp ', headers: [newRow('Authorization', 'Bearer ghp_secret')] }
    expect(buildCreateInput(http)).toEqual({
      id: 'github',
      name: 'GitHub',
      transport: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ghp_secret' } },
      policy: 'ask',
      enabled: true,
    })
    const stdio = { ...emptyForm(), name: 'Everything', id: 'everything', command: ' npx ', args: '-y\n@modelcontextprotocol/server-everything', env: [newRow('API_KEY', 'k')], policy: 'safe' as const }
    expect(buildCreateInput(stdio).transport).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], env: { API_KEY: 'k' } })
    expect(buildCreateInput({ ...stdio, args: '', env: [] }).transport).toEqual({ type: 'stdio', command: 'npx' })
    expect(buildCreateInput({ ...http, type: 'sse', headers: [] }).transport).toEqual({ type: 'sse', url: 'https://mcp.example.com/mcp' })
  })

  it('sends only what changed, with `null` for stored values left empty', () => {
    const server = httpServer()
    const form = formFromServer(server)
    expect(buildUpdatePatch(server, form)).toEqual({})
    expect(transportChanged(server, form)).toBe(false)

    form.name = 'GitHub (work)'
    form.policy = 'safe'
    expect(buildUpdatePatch(server, form)).toEqual({ name: 'GitHub (work)', policy: 'safe' })

    form.headers = [...form.headers, newRow('X-Team', 'blue')]
    expect(transportChanged(server, form)).toBe(true)
    expect(buildUpdatePatch(server, form).transport).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { 'Authorization': null, 'X-Team': 'blue' },
    })
  })

  it('detects every kind of transport change', () => {
    const server = stdioServer()
    const base = formFromServer(server)
    expect(transportChanged(server, base)).toBe(false)
    expect(transportChanged(server, { ...base, command: 'uvx' })).toBe(true)
    expect(transportChanged(server, { ...base, args: '-y' })).toBe(true)
    expect(transportChanged(server, { ...base, env: [] })).toBe(true)
    expect(transportChanged(server, { ...base, env: base.env.map(row => ({ ...row, value: 'new' })) })).toBe(true)
    expect(transportChanged(server, { ...base, type: 'http', url: 'https://x.example.com' })).toBe(true)
    // A removed stored row is dropped from the replacement transport (the server deletes it).
    expect(buildUpdatePatch(server, { ...base, env: [] }).transport).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] })
  })

  it('asks for fresh auth only when a stdio transport is sent', () => {
    const create = { kind: 'create' as const, input: buildCreateInput({ ...emptyForm(), name: 'a', id: 'a', command: 'npx' }) }
    expect(requiresFreshAuth(create)).toBe(true)
    expect(requiresFreshAuth({ kind: 'create', input: { ...create.input, transport: { type: 'http', url: 'https://x.example.com' } } })).toBe(false)
    expect(requiresFreshAuth({ kind: 'update', id: 'a', patch: { name: 'b' } })).toBe(false)
    expect(requiresFreshAuth({ kind: 'update', id: 'a', patch: { transport: { type: 'stdio', command: 'uvx' } } })).toBe(true)
    expect(requiresFreshAuth({ kind: 'update', id: 'a', patch: { transport: { type: 'sse', url: 'https://x.example.com' } } })).toBe(false)
  })
})

describe('validation', () => {
  it('checks the basics of a new server', () => {
    const errors = validateForm({ ...emptyForm(), id: 'Bad_Id' }, 'create')
    expect(errors).toMatchObject({ name: 'Enter a name.', command: 'Enter the command to run.' })
    expect(errors.id).toContain('lowercase')
    expect(validateForm({ ...emptyForm(), name: 'a'.repeat(101), id: 'ok', command: 'npx' }, 'create')).toEqual({ name: 'Use at most 100 characters.' })
    expect(validateForm({ ...emptyForm(), name: 'Ok', id: '', command: 'npx' }, 'create')).toEqual({ id: 'Enter an id.' })
    // The id is fixed when editing.
    expect(validateForm({ ...emptyForm(), name: 'Ok', id: '', command: 'npx' }, 'edit')).toEqual({})
  })

  it('checks URLs, commands and arguments', () => {
    const http = { ...emptyForm(), name: 'a', id: 'a', type: 'http' as const }
    expect(validateForm(http, 'create')).toEqual({ url: 'Enter the server URL.' })
    expect(validateForm({ ...http, url: 'ftp://x.example.com' }, 'create').url).toContain('http://')
    expect(validateForm({ ...http, url: 'https://user:pass@x.example.com' }, 'create').url).toBeDefined()
    expect(validateForm({ ...http, url: 'https://x.example.com/mcp' }, 'create')).toEqual({})
    const stdio = { ...emptyForm(), name: 'a', id: 'a', command: 'npx' }
    expect(validateForm({ ...stdio, command: 'np\u0007x' }, 'create').command).toContain('control characters')
    expect(validateForm({ ...stdio, args: Array.from({ length: 257 }, (_, index) => `a${index}`).join('\n') }, 'create').args).toBe('Use at most 256 arguments.')
    expect(validateForm({ ...stdio, args: 'x'.repeat(4097) }, 'create').args).toContain('4096')
  })

  it('checks header and environment rows', () => {
    const header = (name: string, value: string) => newRow(name, value)
    const http = { ...emptyForm(), name: 'a', id: 'a', type: 'http' as const, url: 'https://x.example.com' }
    const rows = [header('Bad Name', 'x'), header('X-A', 'one'), header('x-a', 'two'), header('X-B', ''), header('X-C', 'a\nb'), header('', 'value')]
    const errors = validateForm({ ...http, headers: rows }, 'create')
    expect(errors[rowKey(rows[0]!)]).toContain('Header names')
    expect(errors[rowKey(rows[1]!)]).toBeUndefined()
    expect(errors[rowKey(rows[2]!)]).toBe('This header is listed twice.')
    expect(errors[rowKey(rows[3]!)]).toBe('Enter a value.')
    expect(errors[rowKey(rows[4]!)]).toContain('control characters')
    expect(errors[rowKey(rows[5]!)]).toBe('Enter the header name.')
    // A stored header left empty is fine: it keeps its value.
    expect(validateForm({ ...http, headers: [{ ...header('Authorization', ''), stored }] }, 'edit')).toEqual({})

    const env = [newRow('1BAD', 'x'), newRow('GOOD', ''), newRow('GOOD', 'again')]
    const envErrors = validateForm({ ...emptyForm(), name: 'a', id: 'a', command: 'npx', env }, 'create')
    expect(envErrors[rowKey(env[0]!)]).toContain('not starting with a digit')
    expect(envErrors[rowKey(env[1]!)]).toBeUndefined()
    expect(envErrors[rowKey(env[2]!)]).toBe('This variable is listed twice.')
  })

  it('maps schema and server issues to fields', () => {
    const form = { ...emptyForm(), type: 'http' as const, headers: [newRow('Authorization', 'x')] }
    const [row] = form.headers
    expect(issueField(['id'], form)).toBe('id')
    expect(issueField(['transport', 'url'], form)).toBe('url')
    expect(issueField(['transport', 'args', 3], form)).toBe('args')
    expect(issueField(['transport', 'headers', 'Authorization'], form)).toBe(rowKey(row!))
    expect(issueField(['transport', 'headers', 'Missing'], form)).toBeNull()
    expect(issueField(['policy'], form)).toBeNull()

    const request = { kind: 'create' as const, input: { ...buildCreateInput(form), id: 'Bad Id' } }
    expect(schemaErrors(request, form).id).toBeDefined()

    const conflict = new HarnessError({ code: 'conflict', message: 'exists', details: { reason: 'exists' } })
    expect(saveErrorFields(conflict, form, 'create')).toEqual({ id: 'This id is already used by another MCP server.' })
    expect(saveErrorFields(conflict, form, 'edit')).toEqual({ form: 'exists' })
    const invalid = new HarnessError({
      code: 'validation_error',
      message: 'Invalid',
      details: { issues: [{ path: ['transport', 'url'], message: 'Bad URL', code: 'custom' }, { path: ['other'], message: 'Something else', code: 'custom' }] },
    })
    expect(saveErrorFields(invalid, form, 'create')).toEqual({ url: 'Bad URL', form: 'Something else' })
    expect(saveErrorFields(new HarnessError({ code: 'provider_error', message: 'Boom' }), form, 'create')).toEqual({ form: 'Boom' })
  })
})

describe('oauth sign-in helpers (Phase 14, W14.7)', () => {
  const remote = (overrides: Partial<McpServer> = {}) => mcpServerFixture({ id: 'linear', name: 'Linear', transport: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: {}, oauth: null }, ...overrides })

  it('canSignIn: a needs-auth server that is on, remote and has no Authorization header', () => {
    expect(canSignIn(remote({ status: 'needs-auth' }))).toBe(true)
    expect(canSignIn(remote({ status: 'connected' }))).toBe(false)
    expect(canSignIn(remote({ status: 'needs-auth', enabled: false }))).toBe(false)
    expect(canSignIn(remote({ status: 'needs-auth', transport: { type: 'sse', url: 'https://x.example.com/sse', headers: { authorization: stored }, oauth: null } }))).toBe(false)
    expect(canSignIn(remote({ status: 'needs-auth', transport: { type: 'stdio', command: 'npx', args: [], env: {} } }))).toBe(false)
  })

  it('the redirect URI is the origin plus /oauth/callback', () => {
    expect(OAUTH_CALLBACK_PATH).toBe('/oauth/callback')
    expect(redirectUriFor('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000/oauth/callback')
    expect(redirectUriFor('https://hf.example.com/')).toBe('https://hf.example.com/oauth/callback')
  })

  it('a connected server that holds tokens reads "Signed in"', () => {
    expect(mcpStatusText(remote({ tools: ['mcp__linear__a'], auth: { signedIn: true, expiresAt: null, scope: null, client: 'dynamic', issuer: null } }))).toBe('Connected · 1 tool · Signed in')
    expect(mcpStatusText(remote({ tools: [] }))).toBe('Connected · 0 tools')
    expect(mcpStatusText(remote({ status: 'needs-auth' }))).toBe('Sign in required')
  })

  it('the OAuth draft of a server; its create and update bodies keep a stored secret', () => {
    const configured = remote({ transport: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: {}, oauth: { clientId: 'hf-linear', clientSecret: { set: true, hint: null, source: 'stored' }, scopes: 'read' } } })
    expect(oauthDraftOf(null)).toEqual({ clientId: '', scopes: '', clientSecret: '', removeSecret: false })
    const draft = oauthDraftOf(configured)
    expect(draft).toEqual({ clientId: 'hf-linear', scopes: 'read', clientSecret: '', removeSecret: false })
    expect(oauthInputOf({ clientId: ' ', scopes: '', clientSecret: 'x', removeSecret: false })).toBeUndefined()
    expect(oauthInputOf({ ...draft, clientSecret: 's3cret' })).toEqual({ clientId: 'hf-linear', scopes: 'read', clientSecret: 's3cret' })
    expect(oauthUpdateOf(configured, draft)).toEqual({ clientId: 'hf-linear', scopes: 'read', clientSecret: null })
    expect(oauthUpdateOf(configured, { ...draft, removeSecret: true })).toEqual({ clientId: 'hf-linear', scopes: 'read' })
    expect(signsOut({ ...configured, auth: { signedIn: true, expiresAt: null, scope: null, client: 'configured', issuer: null } }, { url: 'https://mcp.linear.app/mcp', type: 'http', clientId: 'other' })).toBe(true)
    expect(signsOut(configured, { url: 'https://other.example.com/mcp', type: 'http', clientId: 'hf-linear' })).toBe(false)
  })

  it('an Authorization header (any case) blocks the sign-in and names itself in the status line', () => {
    const header = remote({ status: 'needs-auth', transport: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { AUTHORIZATION: stored }, oauth: null } })
    expect(hasAuthorizationHeader(header)).toBe(true)
    expect(hasAuthorizationHeader(remote())).toBe(false)
    expect(hasAuthorizationHeader(stdioServer())).toBe(false)
    expect(rejectsAuthorizationHeader(header)).toBe(true)
    expect(rejectsAuthorizationHeader({ ...header, status: 'connected' })).toBe(false)
    expect(canSignIn(header)).toBe(false)
    expect(mcpStatusText(header)).toBe(AUTHORIZATION_REJECTED_TEXT)
    expect(AUTHORIZATION_REJECTED_TEXT).toBe('The server rejected its Authorization header.')
    // Without the transport (a project server's shape) the line stays "Sign in required".
    expect(mcpStatusText({ status: 'needs-auth', tools: [], error: null })).toBe('Sign in required')
  })

  it('the signed-in tooltip names the expiry while it is ahead, else the automatic renewal', () => {
    const now = 1_759_000_000_000
    expect(signedInTooltip(null, now)).toBeNull()
    expect(signedInTooltip({ signedIn: false, expiresAt: null, scope: null, client: null, issuer: null }, now)).toBeNull()
    expect(signedInTooltip({ signedIn: true, expiresAt: now + 3 * 3_600_000, scope: 'read', client: 'dynamic', issuer: null }, now)).toBe('Signed in · expires in 3h')
    expect(signedInTooltip({ signedIn: true, expiresAt: now - 60_000, scope: null, client: 'dynamic', issuer: null }, now)).toBe('Signed in · token renews automatically')
    expect(signedInTooltip({ signedIn: true, expiresAt: null, scope: null, client: 'configured', issuer: null }, now)).toBe('Signed in · token renews automatically')
  })

  it('oauthChanged: a new client id or scopes, a typed secret or a removed stored one', () => {
    const configured = remote({ transport: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: {}, oauth: { clientId: 'hf-linear', clientSecret: { set: true, hint: null, source: 'stored' }, scopes: 'read' } } })
    const draft = oauthDraftOf(configured)
    expect(oauthChanged(configured, draft)).toBe(false)
    expect(oauthChanged(configured, { ...draft, clientId: ' hf-linear ' })).toBe(false)
    expect(oauthChanged(configured, { ...draft, scopes: 'read write' })).toBe(true)
    expect(oauthChanged(configured, { ...draft, clientId: 'other' })).toBe(true)
    expect(oauthChanged(configured, { ...draft, clientSecret: 'new' })).toBe(true)
    expect(oauthChanged(configured, { ...draft, removeSecret: true })).toBe(true)
    expect(oauthChanged(remote(), { ...oauthDraftOf(null), removeSecret: true })).toBe(false)
  })

  it('the create body carries oauth for http / sse only; the update sends the transport for an OAuth change alone', () => {
    const form = { ...emptyForm(), name: 'Linear', id: 'linear', type: 'http' as const, url: 'https://mcp.linear.app/mcp' }
    const draft = { clientId: 'hf-linear', scopes: '', clientSecret: 's3cret', removeSecret: false }
    expect(buildCreateInput(form, draft).transport).toEqual({ type: 'http', url: 'https://mcp.linear.app/mcp', oauth: { clientId: 'hf-linear', clientSecret: 's3cret' } })
    expect(buildCreateInput(form, oauthDraftOf(null)).transport).toEqual({ type: 'http', url: 'https://mcp.linear.app/mcp' })
    expect(buildCreateInput(form).transport).toEqual({ type: 'http', url: 'https://mcp.linear.app/mcp' })
    expect(buildCreateInput({ ...form, type: 'stdio', command: 'npx' }, draft).transport).toEqual({ type: 'stdio', command: 'npx' })

    const configured = remote({ transport: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: {}, oauth: { clientId: 'hf-linear', clientSecret: { set: true, hint: null, source: 'stored' }, scopes: 'read' } } })
    const state = formFromServer(configured)
    const unchanged = oauthDraftOf(configured)
    expect(buildUpdatePatch(configured, state, unchanged)).toEqual({})
    expect(buildUpdatePatch(configured, state, { ...unchanged, scopes: 'read write' })).toEqual({
      transport: { type: 'http', url: 'https://mcp.linear.app/mcp', oauth: { clientId: 'hf-linear', scopes: 'read write', clientSecret: null } },
    })
    // A transport change keeps the OAuth settings in the replaced transport.
    expect(buildUpdatePatch(configured, { ...state, url: 'https://mcp2.linear.app/mcp' }, unchanged)).toEqual({
      transport: { type: 'http', url: 'https://mcp2.linear.app/mcp', oauth: { clientId: 'hf-linear', scopes: 'read', clientSecret: null } },
    })
    // Clearing every OAuth field removes the settings (an omitted `oauth`).
    expect(buildUpdatePatch(configured, state, oauthDraftOf(null))).toEqual({ transport: { type: 'http', url: 'https://mcp.linear.app/mcp' } })
  })

  it('a sign-in failure as the inline alert: the server message, Retry only for provider failures', () => {
    expect(signInErrorView(new HarnessError({ code: 'provider_unreachable', message: 'Can\'t reach the authorization server.' }))).toEqual({ code: 'provider_unreachable', message: 'Can\'t reach the authorization server.', action: 'retry' })
    expect(signInErrorView(new HarnessError({ code: 'conflict', message: 'The server is disabled.', details: { reason: 'disabled' } }))).toEqual({ code: 'conflict', message: 'Turn the server on first.', details: { reason: 'disabled' } })
    expect(signInErrorView(new HarnessError({ code: 'validation_error', message: 'This server is set up with its own Authorization header, so it does not sign in.' }))).toMatchObject({ code: 'validation_error', message: 'This server is set up with its own Authorization header, so it does not sign in.' })
    expect(signInErrorView(new HarnessError({ code: 'validation_error', message: 'x' })).action).toBeUndefined()
    expect(signInErrorView(new Error('boom'))).toMatchObject({ code: 'internal_error', action: 'retry' })
  })
})
