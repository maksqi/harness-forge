import { describe, expect, it } from 'vitest'
import {
  projectMcpStateSchema,
  projectMcpTransportSchema,
  trustItemKindSchema,
  trustStateSchema,
  trustWarningSchema,
} from '../enums.ts'
import { createServerEvent, SERVER_EVENT_TYPES, serverEventSchema } from '../events.ts'
import { LIMITS } from '../limits.ts'
import { MCP_JSON_TRANSPORTS } from '../util/mcp-config.ts'
import { TRUST_ITEM_KINDS } from '../util/trust.ts'
import {
  mcpVariableNameSchema,
  projectMcpListSchema,
  projectMcpServerParamsSchema,
  projectMcpServerSchema,
  projectMcpVariablesBodySchema,
  projectTrustApproveBodySchema,
  projectTrustItemParamsSchema,
  projectTrustListSchema,
  trustItemSchema,
} from './project-trust.ts'

const PROJECT_ID = 'prj_ABCdef0123456789'
const SHA = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

const hookItem = {
  kind: 'hook',
  sha256: SHA,
  state: 'pending',
  label: 'sh .claude/hooks/check.sh',
  path: '.claude/settings.json',
  refs: [{ path: '.claude/hooks/check.sh', sha256: SHA_B }],
  warnings: [],
  detail: { event: 'PreToolUse', matcher: 'Write|Edit', command: 'sh .claude/hooks/check.sh', timeout: null },
} as const

const mcpItem = {
  kind: 'mcp',
  sha256: SHA_B,
  state: 'approved',
  label: 'My_Server.v2',
  path: '.mcp.json',
  refs: [],
  warnings: ['private-network'],
  detail: { name: 'My_Server.v2', id: 'my-server-v2', transport: 'http', url: 'http://127.0.0.1:9/mcp', envNames: [], headerNames: ['Authorization'], variables: ['MCP_TOKEN'] },
} as const

const commandItem = {
  kind: 'command',
  sha256: 'c'.repeat(64),
  state: 'pending',
  label: '/status',
  path: '.claude/commands/status.md',
  refs: [],
  warnings: ['runs-repository-code'],
  detail: { name: 'status', spans: ['git status --short'] },
} as const

const server = {
  id: 'my-server-v2',
  name: 'My_Server.v2',
  transport: 'stdio' as const,
  state: 'needs-variables' as const,
  sha256: SHA_B,
  tools: [] as string[],
  shadows: 'memory',
  missingVariables: ['MCP_TOKEN'],
}

describe('enums (Phase 11)', () => {
  it('declares the trust and project MCP enums from the helper constants', () => {
    expect(trustItemKindSchema.options).toEqual([...TRUST_ITEM_KINDS])
    expect(trustItemKindSchema.options).toEqual(['hook', 'mcp', 'command'])
    expect(trustStateSchema.options).toEqual(['approved', 'pending'])
    expect(trustWarningSchema.options).toEqual(['private-network', 'referenced-file-missing', 'runs-repository-code'])
    expect(projectMcpTransportSchema.options).toEqual([...MCP_JSON_TRANSPORTS])
    expect(projectMcpStateSchema.options).toEqual(['pending', 'needs-variables', 'idle', 'connecting', 'connected', 'error', 'disabled'])
  })
})

describe('project trust (ADR-049)', () => {
  it('parses items discriminated on kind (the detail fits the kind)', () => {
    for (const item of [hookItem, mcpItem, commandItem])
      expect(trustItemSchema.parse(item)).toEqual(item)
    // A pending item that changed since it was approved.
    expect(trustItemSchema.parse({ ...hookItem, changed: true }).changed).toBe(true)
    expect(trustItemSchema.safeParse({ ...hookItem, changed: 'yes' }).success).toBe(false)
    expect(trustItemSchema.safeParse({ ...hookItem, detail: commandItem.detail }).success).toBe(false)
    expect(trustItemSchema.safeParse({ ...hookItem, kind: 'plugin' }).success).toBe(false)
    expect(trustItemSchema.safeParse({ ...hookItem, state: 'changed' }).success).toBe(false)
    expect(trustItemSchema.safeParse({ ...hookItem, sha256: 'A'.repeat(64) }).success).toBe(false)
    expect(trustItemSchema.safeParse({ ...hookItem, refs: Array.from({ length: LIMITS.trustRefFilesMax + 1 }, (_, index) => ({ path: `s${index}.sh`, sha256: null })) }).success).toBe(false)
    expect(trustItemSchema.safeParse({ ...commandItem, detail: { name: 'status', spans: Array.from({ length: 11 }).fill('ls') } }).success).toBe(false)
    expect(trustItemSchema.safeParse({ ...mcpItem, detail: { ...mcpItem.detail, variables: ['1BAD'] } }).success).toBe(false)
  })

  it('parses the list', () => {
    const list = { items: [hookItem, mcpItem, commandItem], orphaned: 1, scannedAt: 5, available: true }
    expect(projectTrustListSchema.parse(list)).toEqual(list)
    expect(projectTrustListSchema.parse({ items: [], orphaned: 0, scannedAt: 5, available: false, issue: 'The folder is missing.' }).available).toBe(false)
  })

  it('validates the approve body: 1..50 reviewed hashes, strict, unique', () => {
    const body = { items: [{ kind: 'hook', sha256: SHA }, { kind: 'mcp', sha256: SHA_B }] }
    expect(projectTrustApproveBodySchema.parse(body)).toEqual(body)
    for (const bad of [
      { items: [] },
      { items: [{ kind: 'hook', sha256: SHA }, { kind: 'mcp', sha256: SHA }] },
      { items: [{ kind: 'hook', sha256: SHA, label: 'x' }] },
      { items: [{ kind: 'hook', sha256: 'short' }] },
      { items: [{ kind: 'plugin', sha256: SHA }] },
      { items: Array.from({ length: LIMITS.trustApproveItemsMax + 1 }, (_, index) => ({ kind: 'hook', sha256: index.toString(16).padStart(64, '0') })) },
      { items: [{ kind: 'hook', sha256: SHA }], all: true },
    ])
      expect(projectTrustApproveBodySchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false)
  })

  it('validates the revoke params', () => {
    expect(projectTrustItemParamsSchema.parse({ id: PROJECT_ID, sha256: SHA })).toEqual({ id: PROJECT_ID, sha256: SHA })
    expect(projectTrustItemParamsSchema.safeParse({ id: PROJECT_ID, sha256: 'x' }).success).toBe(false)
  })
})

describe('project MCP servers (ADR-050)', () => {
  it('parses servers and the list with the variables (values are never answered)', () => {
    expect(projectMcpServerSchema.parse(server)).toEqual(server)
    const failed = { ...server, state: 'error', error: { code: 'provider_unreachable', message: 'The MCP server is unreachable.' } }
    expect(projectMcpServerSchema.parse(failed)).toEqual(failed)
    const list = { items: [server], variables: [{ name: 'MCP_TOKEN', set: false, hint: null, usedBy: ['my-server-v2'] }, { name: 'MCP_PORT', set: true, hint: '9', usedBy: ['my-server-v2'] }] }
    expect(projectMcpListSchema.parse(list)).toEqual(list)
    expect(projectMcpServerSchema.safeParse({ ...server, id: 'My_Server' }).success).toBe(false)
    expect(projectMcpServerSchema.safeParse({ ...server, state: 'running' }).success).toBe(false)
  })

  it('validates the variables body: names, 1..4096 characters or null, at most 50 keys, strict', () => {
    const body = { values: { MCP_TOKEN: 'secret-value', MCP_PORT: null, _x1: 'y' } }
    expect(projectMcpVariablesBodySchema.parse(body)).toEqual(body)
    for (const name of ['MCP_TOKEN', 'token', '_x', `A${'b'.repeat(63)}`])
      expect(mcpVariableNameSchema.safeParse(name).success, name).toBe(true)
    for (const name of ['', '1A', 'A-B', 'A B', `A${'b'.repeat(64)}`])
      expect(mcpVariableNameSchema.safeParse(name).success, name).toBe(false)
    for (const bad of [
      { values: { MCP_TOKEN: '' } },
      { values: { MCP_TOKEN: 'x'.repeat(LIMITS.projectMcpVariableValueMaxChars + 1) } },
      { values: { 'MCP-TOKEN': 'x' } },
      { values: Object.fromEntries(Array.from({ length: LIMITS.projectMcpVariablesMax + 1 }, (_, index) => [`V${index}`, 'x'])) },
      { values: {}, serverId: 'x' },
      {},
    ])
      expect(projectMcpVariablesBodySchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false)
    expect(projectMcpServerParamsSchema.safeParse({ id: PROJECT_ID, serverId: 'my-server-v2' }).success).toBe(true)
    expect(projectMcpServerParamsSchema.safeParse({ id: PROJECT_ID, serverId: 'My_Server' }).success).toBe(false)
  })
})

describe('server events (Phase 11)', () => {
  it('adds hooks.changed, project-trust.changed and project-mcp.changed (18 types)', () => {
    // Phase 12 adds `marketplace.changed` (19).
    expect(SERVER_EVENT_TYPES).toHaveLength(19)
    expect(SERVER_EVENT_TYPES.slice(15, 18)).toEqual(['hooks.changed', 'project-trust.changed', 'project-mcp.changed'])
    expect(serverEventSchema.parse(createServerEvent('project-trust.changed', { projectId: PROJECT_ID, pending: 3 }, 1)).data).toEqual({ projectId: PROJECT_ID, pending: 3 })
    expect(serverEventSchema.parse(createServerEvent('project-mcp.changed', { projectId: PROJECT_ID, servers: [server] }, 1)).data).toEqual({ projectId: PROJECT_ID, servers: [server] })
    expect(serverEventSchema.safeParse({ type: 'project-trust.changed', data: { projectId: PROJECT_ID, pending: -1 }, at: 1 }).success).toBe(false)
    expect(serverEventSchema.safeParse({ type: 'trust.changed', data: { projectId: PROJECT_ID, pending: 0 }, at: 1 }).success).toBe(false)
  })
})
