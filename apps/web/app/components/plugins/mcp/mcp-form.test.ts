import type { McpServer } from '@harness-forge/shared'
import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import {
  buildCreateInput,
  buildUpdatePatch,
  emptyForm,
  formFromServer,
  isBlankRow,
  issueField,
  loginFailureMessage,
  MCP_STATUS_DOTS,
  MCP_STATUS_LABELS,
  mcpStatusText,
  needsLogin,
  newRow,
  parseArgs,
  policyLabel,
  requiresFreshAuth,
  rowKey,
  saveErrorFields,
  schemaErrors,
  secretRecord,
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
    transport: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: stored } },
    policy: 'ask',
    enabled: true,
    status: 'connected',
    error: null,
    tools: ['mcp__github__search'],
    connectedAt: 1_759_000_000_000,
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
    expect(MCP_STATUS_DOTS).toEqual({ connected: 'ok', connecting: 'running', error: 'error', disabled: 'off' })
    expect(MCP_STATUS_LABELS).toEqual({ connected: 'Connected', connecting: 'Connecting', error: 'Error', disabled: 'Disabled' })
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

  it('recognizes fresh-auth failures and explains login failures', () => {
    expect(needsLogin(new HarnessError({ code: 'forbidden', message: 'Confirm', action: 'login' }))).toBe(true)
    expect(needsLogin(new HarnessError({ code: 'forbidden', message: 'No' }))).toBe(false)
    expect(loginFailureMessage(new HarnessError({ code: 'unauthorized', message: 'x' }))).toBe('Wrong password')
    expect(loginFailureMessage(new HarnessError({ code: 'rate_limited', message: 'x', retryAfterMs: 4200 }))).toBe('Too many attempts. Try again in 5s.')
    expect(loginFailureMessage(new HarnessError({ code: 'provider_error', message: 'Other' }))).toBe('Other')
  })
})
