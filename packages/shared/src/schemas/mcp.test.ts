import type { z } from 'zod'
import type { ElicitationField, ElicitationForm, ElicitationOption, ElicitationValue } from '../util/mcp-elicitation.ts'
import type { McpElicitationField, McpElicitationOption, McpElicitationValue } from './mcp.ts'
import { describe, expect, it } from 'vitest'
import { commandInvocationSchema } from '../chat.ts'
import {
  commandSourceSchema,
  elicitationActionSchema,
  elicitationReasonSchema,
  mcpAuthClientKindSchema,
  mcpStatusSchema,
  projectMcpStateSchema,
} from '../enums.ts'
import { conflictReasonSchema } from '../errors.ts'
import { LIMITS } from '../limits.ts'
import { ELICITATION_FIELDS_MAX } from '../util/mcp-elicitation.ts'
import {
  chatElicitationParamsSchema,
  isSafeReturnTo,
  mcpAuthCallbackBodySchema,
  mcpAuthCallbackResultSchema,
  mcpAuthInfoSchema,
  mcpAuthStartBodySchema,
  mcpAuthStartSchema,
  mcpElicitationAnswerBodySchema,
  mcpElicitationAnswerResultSchema,
  mcpElicitationFormSchema,
  mcpElicitationRecordSchema,
  mcpElicitationSchema,
  mcpOAuthConfigSchema,
  mcpOAuthInputSchema,
  mcpOAuthUpdateSchema,
  mcpPromptNameSchema,
  mcpResourceAttachBodySchema,
  mcpResourceEntrySchema,
  mcpResourceListSchema,
  mcpResourceQuerySchema,
  mcpToolProgressSchema,
  slashCommandNameSchema,
} from './mcp.ts'
import { mcpServerDeclSchema, mcpServerDeclSettingsKeys } from './plugin-data.ts'
import { projectMcpServerSchema } from './project-trust.ts'
import { commandSummarySchema, mcpServerInputSchema, mcpServerSchema, mcpServerUpdateSchema } from './tools.ts'

// ---------- type-level sync of the elicitation form mirror ----------

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object ? { -readonly [K in keyof T]: DeepMutable<T[K]> } : T

/** Fails to compile when `mcpElicitationFormSchema` and `ElicitationForm` (`util/mcp-elicitation.ts`) drift apart. */
export const ELICITATION_MIRROR: [
  Equal<McpElicitationOption, DeepMutable<ElicitationOption>>,
  Equal<McpElicitationValue, DeepMutable<ElicitationValue>>,
  Equal<McpElicitationField, DeepMutable<ElicitationField>>,
  Equal<z.infer<typeof mcpElicitationFormSchema>, DeepMutable<ElicitationForm>>,
] = [true, true, true, true]

const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'
const PROJECT_ID = 'prj_ABCdef0123456789'
const ELICITATION_ID = 'eli_ABCdef0123456789'
const STATE = 'aB3_-'.repeat(8)

const form = {
  fields: [
    { name: 'email', type: 'string', title: 'Email', description: null, required: true, format: 'email' },
    { name: 'count', type: 'integer', title: null, description: 'How many', required: false, minimum: 1, maximum: 10, default: 3 },
    { name: 'confirm', type: 'boolean', title: null, description: null, required: false, default: false },
    { name: 'color', type: 'enum', title: 'Color', description: null, required: true, options: [{ value: 'red', label: 'Red' }, { value: 'blue', label: 'blue' }] },
    { name: 'tags', type: 'multi-enum', title: null, description: null, required: false, options: [{ value: 'a', label: 'A' }], minItems: 0, maxItems: 1, default: ['a'] },
  ],
} as const

const elicitation = {
  id: ELICITATION_ID,
  serverId: 'github',
  serverName: 'GitHub',
  message: 'Which repository?',
  form,
  expiresAt: 1_800_000_000_000,
}

describe('enums (Phase 14)', () => {
  it('appends the sign-in status, the MCP command source and the new conflict reason', () => {
    expect(mcpStatusSchema.options).toEqual(['disabled', 'connecting', 'connected', 'error', 'needs-auth'])
    expect(projectMcpStateSchema.options.at(-1)).toBe('needs-auth')
    expect(commandSourceSchema.options.at(-1)).toBe('mcp')
    expect(conflictReasonSchema.options.at(-1)).toBe('needs-auth')
    // The reasons the Phase 14 routes use exist.
    expect(conflictReasonSchema.options).toEqual(expect.arrayContaining(['stale', 'disabled', 'untrusted', 'needs-auth']))
    expect(elicitationActionSchema.options).toEqual(['accept', 'decline', 'cancel'])
    expect(elicitationReasonSchema.options).toEqual(['user', 'timeout', 'stopped', 'not-interactive', 'ambiguous', 'unsupported'])
    expect(mcpAuthClientKindSchema.options).toEqual(['dynamic', 'configured'])
  })
})

describe('mCP OAuth (ADR-059)', () => {
  it('validates the OAuth settings of a server', () => {
    expect(mcpOAuthConfigSchema.parse({})).toEqual({})
    expect(mcpOAuthConfigSchema.parse({ clientId: ' my-client ', scopes: 'repo read:org' })).toEqual({ clientId: 'my-client', scopes: 'repo read:org' })
    for (const bad of [{ clientId: '' }, { clientId: 'x'.repeat(257) }, { clientId: 'a\nb' }, { clientId: 'clé' }, { scopes: 'x'.repeat(1025) }, { scopes: 'a\u0000' }, { callbackPort: 8080 }, { clientSecret: 's' }])
      expect(mcpOAuthConfigSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    // A client secret (personal servers only) needs a client id; an update keeps the stored one with null.
    expect(mcpOAuthInputSchema.parse({ clientId: 'c', clientSecret: 's3cret' })).toEqual({ clientId: 'c', clientSecret: 's3cret' })
    expect(mcpOAuthInputSchema.safeParse({ clientSecret: 's3cret' }).success).toBe(false)
    expect(mcpOAuthInputSchema.safeParse({ clientId: 'c', clientSecret: null }).success).toBe(false)
    expect(mcpOAuthUpdateSchema.parse({ clientId: 'c', clientSecret: null })).toEqual({ clientId: 'c', clientSecret: null })
    expect(mcpOAuthUpdateSchema.safeParse({ clientSecret: null }).success).toBe(false)
  })

  it('accepts `oauth` on http / sse transports of personal servers only', () => {
    const input = { id: 'linear', name: 'Linear', transport: { type: 'http', url: 'https://mcp.linear.app/mcp', oauth: { clientId: 'c', scopes: 'read' } } }
    expect(mcpServerInputSchema.parse(input).transport).toEqual(input.transport)
    // v1.8.1 bodies (no `oauth`) still parse.
    expect(mcpServerInputSchema.parse({ ...input, transport: { type: 'sse', url: 'https://mcp.example.com/sse' } }).transport).toEqual({ type: 'sse', url: 'https://mcp.example.com/sse' })
    expect(mcpServerInputSchema.safeParse({ ...input, transport: { type: 'stdio', command: 'npx', oauth: {} } }).success).toBe(false)
    expect(mcpServerUpdateSchema.parse({ transport: { type: 'http', url: 'https://mcp.linear.app/mcp', oauth: { clientId: 'c', clientSecret: null } } })).toMatchObject({ transport: { oauth: { clientSecret: null } } })
  })

  it('parses the server DTOs with the OAuth settings and the sign-in state (never a token)', () => {
    const auth = { signedIn: true, expiresAt: 1_800_000_000_000, scope: 'read', client: 'dynamic', issuer: 'https://auth.example.com' }
    expect(mcpAuthInfoSchema.parse(auth)).toEqual(auth)
    expect(mcpAuthInfoSchema.parse({ signedIn: false, expiresAt: null, scope: null, client: null, issuer: null }).signedIn).toBe(false)
    const server = {
      id: 'linear',
      name: 'Linear',
      pluginId: 'core-mcp',
      editable: true,
      transport: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: {}, oauth: { clientId: 'c', clientSecret: { set: true, hint: null, source: 'stored' }, scopes: null } },
      policy: 'ask',
      enabled: true,
      status: 'needs-auth',
      error: null,
      tools: [],
      connectedAt: null,
      auth,
    }
    expect(mcpServerSchema.parse(server)).toEqual(server)
    expect(mcpServerSchema.parse({ ...server, transport: { ...server.transport, oauth: null }, auth: null }).auth).toBeNull()
    expect(mcpServerSchema.safeParse({ ...server, auth: undefined }).success).toBe(false)
    const projectServer = { id: 'linear', name: 'linear', transport: 'http', state: 'needs-auth', sha256: 'a'.repeat(64), tools: [], missingVariables: [], auth: null }
    expect(projectMcpServerSchema.parse(projectServer)).toEqual(projectServer)
  })

  it('validates the sign-in start body and answer', () => {
    expect(mcpAuthStartBodySchema.parse({})).toEqual({})
    expect(mcpAuthStartBodySchema.parse({ returnTo: '/plugins?tab=mcp' })).toEqual({ returnTo: '/plugins?tab=mcp' })
    for (const returnTo of ['//evil.example', 'https://evil.example', 'plugins', '/a\\b', '/\\evil', '/a b', `/${'x'.repeat(512)}`, '', '/a\nb'])
      expect(mcpAuthStartBodySchema.safeParse({ returnTo }).success, returnTo).toBe(false)
    expect(isSafeReturnTo('/')).toBe(true)
    expect(isSafeReturnTo(`/${'x'.repeat(LIMITS.mcpReturnToMaxChars - 1)}`)).toBe(true)
    expect(mcpAuthStartBodySchema.safeParse({ returnTo: '/x', extra: 1 }).success).toBe(false)
    const start = { authorizationUrl: `https://auth.example.com/authorize?state=${STATE}&code_challenge_method=S256`, redirectUri: 'http://127.0.0.1:8787/oauth/callback', expiresAt: 1 }
    expect(mcpAuthStartSchema.parse(start)).toEqual(start)
    expect(mcpAuthStartSchema.parse({ ...start, authorizationUrl: null }).authorizationUrl).toBeNull()
    for (const authorizationUrl of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '/relative'])
      expect(mcpAuthStartSchema.safeParse({ ...start, authorizationUrl }).success, authorizationUrl).toBe(false)
  })

  it('validates the callback body: state and exactly one of code / error', () => {
    expect(mcpAuthCallbackBodySchema.parse({ state: STATE, code: 'abc', iss: 'https://auth.example.com' })).toEqual({ state: STATE, code: 'abc', iss: 'https://auth.example.com' })
    expect(mcpAuthCallbackBodySchema.parse({ state: STATE, error: 'access_denied', errorDescription: 'The user said no.' }).error).toBe('access_denied')
    for (const bad of [
      { state: STATE },
      { state: STATE, code: 'abc', error: 'access_denied' },
      { state: 'short', code: 'abc' },
      { state: 'x'.repeat(257), code: 'abc' },
      { state: `${STATE}\n`, code: 'abc' },
      { state: STATE, code: '' },
      { state: STATE, code: 'x'.repeat(4097) },
      { state: STATE, code: 'abc', extra: true },
      { code: 'abc' },
    ])
      expect(mcpAuthCallbackBodySchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false)
    const global = { target: { kind: 'global', serverId: 'linear' }, status: 'connected', returnTo: null }
    expect(mcpAuthCallbackResultSchema.parse(global)).toEqual(global)
    const project = { target: { kind: 'project', projectId: PROJECT_ID, serverId: 'linear' }, status: 'connected', returnTo: '/projects' }
    expect(mcpAuthCallbackResultSchema.parse(project)).toEqual(project)
    expect(mcpAuthCallbackResultSchema.safeParse({ ...global, returnTo: '//evil' }).success).toBe(false)
    expect(mcpAuthCallbackResultSchema.safeParse({ ...global, target: { kind: 'project', serverId: 'linear' } }).success).toBe(false)
  })

  it('accepts `oauth` in plugin declarations, with a templated client id', () => {
    const decl = { id: 'acme', name: 'Acme', transport: { type: 'http', url: 'https://mcp.acme.dev/mcp', oauth: { clientId: '{{settings.clientId}}', scopes: 'read write' } } } as const
    const parsed = mcpServerDeclSchema.parse(decl)
    expect(parsed).toEqual(decl)
    expect(mcpServerDeclSettingsKeys(parsed)).toEqual(['clientId'])
    for (const oauth of [{ clientId: '{{credentials.x}}' }, { clientId: '' }, { clientSecret: 'x' }, { clientId: 'a\nb' }])
      expect(mcpServerDeclSchema.safeParse({ ...decl, transport: { ...decl.transport, oauth } }).success, JSON.stringify(oauth)).toBe(false)
    expect(mcpServerDeclSchema.safeParse({ id: 'acme', name: 'Acme', transport: { type: 'stdio', command: 'acme', oauth: {} } }).success).toBe(false)
  })
})

describe('mCP elicitation (ADR-060)', () => {
  it('parses a pending request and the tool progress outputs', () => {
    expect(mcpElicitationSchema.parse(elicitation)).toEqual(elicitation)
    expect(mcpToolProgressSchema.parse({ status: 'input-required', elicitation })).toEqual({ status: 'input-required', elicitation })
    expect(mcpToolProgressSchema.parse({ status: 'running' })).toEqual({ status: 'running' })
    expect(mcpToolProgressSchema.safeParse({ status: 'input-required' }).success).toBe(false)
    expect(mcpElicitationSchema.safeParse({ ...elicitation, message: 'x'.repeat(2001) }).success).toBe(false)
    expect(mcpElicitationSchema.safeParse({ ...elicitation, id: 'eli_short' }).success).toBe(false)
    const tooMany = { fields: Array.from({ length: ELICITATION_FIELDS_MAX + 1 }, (_, index) => ({ name: `f${index}`, type: 'boolean', title: null, description: null, required: false })) }
    expect(mcpElicitationFormSchema.safeParse(tooMany).success).toBe(false)
    expect(mcpElicitationFormSchema.safeParse({ fields: [{ ...form.fields[0], type: 'object' }] }).success).toBe(false)
  })

  it('keeps only names, the action and the reason in the stored record', () => {
    const record = { id: ELICITATION_ID, message: 'Which repository?', fields: ['email', 'count'], action: 'accept', reason: 'user' }
    expect(mcpElicitationRecordSchema.parse(record)).toEqual(record)
    // Zod strips unknown keys of a record: values never survive a parse.
    expect(mcpElicitationRecordSchema.parse({ ...record, content: { email: 'ada@example.com' } })).toEqual(record)
    expect(mcpElicitationRecordSchema.safeParse({ ...record, reason: 'later' }).success).toBe(false)
  })

  it('validates the answer body: content only with accept', () => {
    expect(mcpElicitationAnswerBodySchema.parse({ action: 'accept', content: { email: 'ada@example.com', count: 3, confirm: true, tags: ['a'] } }).action).toBe('accept')
    expect(mcpElicitationAnswerBodySchema.parse({ action: 'accept' })).toEqual({ action: 'accept' })
    expect(mcpElicitationAnswerBodySchema.parse({ action: 'decline' })).toEqual({ action: 'decline' })
    expect(mcpElicitationAnswerBodySchema.parse({ action: 'cancel' })).toEqual({ action: 'cancel' })
    for (const bad of [
      { action: 'decline', content: {} },
      { action: 'cancel', content: { a: 'b' } },
      { action: 'ok' },
      { action: 'accept', content: { email: { nested: true } } },
      { action: 'accept', content: { email: null } },
      { action: 'accept', content: { 'bad name!': 'x' } },
      { action: 'accept', content: { tags: [1, 2] } },
      { action: 'accept', content: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`f${index}`, true])) },
      { action: 'accept', extra: 1 },
    ])
      expect(mcpElicitationAnswerBodySchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false)
    expect(mcpElicitationAnswerResultSchema.parse({ action: 'decline' })).toEqual({ action: 'decline' })
    expect(chatElicitationParamsSchema.safeParse({ id: CHAT_ID, elicitationId: ELICITATION_ID }).success).toBe(true)
    expect(chatElicitationParamsSchema.safeParse({ id: CHAT_ID, elicitationId: 'msg_ABCdef0123456789' }).success).toBe(false)
  })
})

describe('mCP prompts and resources (ADR-061)', () => {
  it('accepts MCP prompt command names next to catalog names', () => {
    for (const name of ['mcp__github__create_issue', 'mcp__fixture__greet', `mcp__${'x'.repeat(59)}`])
      expect(slashCommandNameSchema.safeParse(name).success, name).toBe(true)
    for (const name of ['compact', 'review-kit:review', 'review-kit:db:migrate'])
      expect(slashCommandNameSchema.safeParse(name).success, name).toBe(true)
    for (const name of ['mcp__', `mcp__${'x'.repeat(60)}`, 'mcp__a b', 'MCP__x', 'clean_gone', 'mcp_x', ''])
      expect(slashCommandNameSchema.safeParse(name).success, name).toBe(false)
    expect(mcpPromptNameSchema.safeParse('compact').success).toBe(false)
    const invocation = { name: 'mcp__fixture__greet', input: 'Ada', type: 'prompt', expansion: 'Hello Ada', source: 'mcp' }
    expect(commandInvocationSchema.parse(invocation)).toEqual(invocation)
    // v1.8.1 invocations still parse.
    expect(commandInvocationSchema.parse({ name: 'review-kit:review', input: '', type: 'prompt', source: 'plugin' }).source).toBe('plugin')
    const summary = { name: 'mcp__fixture__greet', description: 'Greets someone', source: 'mcp', argumentHint: '<name> [style]', mcpServer: { id: 'fixture', name: 'Fixture' } }
    expect(commandSummarySchema.parse(summary)).toEqual(summary)
    expect(commandSummarySchema.parse({ name: 'compact', description: 'Compact', source: 'harness' }).mcpServer).toBeUndefined()
  })

  it('validates the resource query, list and attach body', () => {
    expect(mcpResourceQuerySchema.parse({})).toEqual({ q: '', limit: 50 })
    expect(mcpResourceQuerySchema.parse({ projectId: PROJECT_ID, q: 'readme', limit: '100' })).toEqual({ projectId: PROJECT_ID, q: 'readme', limit: 100 })
    for (const bad of [{ limit: '0' }, { limit: '101' }, { q: 'x'.repeat(257) }, { projectId: 'prj_short' }])
      expect(mcpResourceQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    const entry = { serverId: 'github', serverName: 'GitHub', scope: 'global', uri: 'repo://owner/name/README.md', name: 'README.md', mimeType: 'text/markdown', size: 120, mention: '@github:repo://owner/name/README.md' }
    expect(mcpResourceEntrySchema.parse(entry)).toEqual(entry)
    const list = { items: [entry], truncated: false, unavailable: [{ serverId: 'linear', status: 'needs-auth' }] }
    expect(mcpResourceListSchema.parse(list)).toEqual(list)
    expect(mcpResourceAttachBodySchema.parse({ serverId: 'github', uri: 'repo://owner/name/README.md' })).toEqual({ serverId: 'github', uri: 'repo://owner/name/README.md' })
    for (const bad of [
      { serverId: 'github', uri: 'no-scheme' },
      { serverId: 'github', uri: 'file:///a b' },
      { serverId: 'github', uri: `file:///${'x'.repeat(2048)}` },
      { serverId: 'GitHub', uri: 'file:///a' },
      { serverId: 'github', uri: 'file:///a', projectId: 'prj_short' },
      { serverId: 'github', uri: 'file:///a', extra: true },
    ])
      expect(mcpResourceAttachBodySchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false)
  })
})
