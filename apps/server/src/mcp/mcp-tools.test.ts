import type { CallToolResult } from '@ai-sdk/mcp'
import type { McpListedTool } from './mcp-tools.ts'
import { asSchema } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { toolContext } from './__fixtures__/harness.ts'
import { connectionErrorInit, isConnectionFailure, isPermanentMcpError, mcpConfigError } from './errors.ts'
import { mcpErrorText, mcpInputSchema, mcpModelOutput, mcpToolDefinition, mcpToolOutput, offlineToolOf } from './mcp-tools.ts'

function listed(overrides: Partial<McpListedTool> = {}): McpListedTool {
  return { name: 'search', description: 'Search things.', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, ...overrides } as McpListedTool
}

describe('mcpToolDefinition', () => {
  it('maps name, description, schema and policy, and calls the server with the original name', async () => {
    const call = vi.fn(async () => ({ content: [{ type: 'text', text: 'found' }], _meta: { trace: 1 } }) as CallToolResult)
    const definition = mcpToolDefinition(listed({ name: 'search.v2', annotations: { readOnlyHint: true } }), { serverId: 'docs', pluginId: 'core-mcp', serverPolicy: 'always', call })
    expect(definition.name).toBe('mcp__docs__search_v2')
    expect(definition.policy).toBe('safe')
    expect(definition.description).toBe('Search things.')
    expect(await asSchema(definition.inputSchema).jsonSchema).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
      additionalProperties: false,
    })
    const context = toolContext()
    expect(await definition.execute({ q: 'x' }, context)).toEqual({ content: [{ type: 'text', text: 'found' }] })
    expect(call).toHaveBeenCalledWith('search.v2', { q: 'x' }, context)
  })

  it('throws the error text of an isError result', async () => {
    const definition = mcpToolDefinition(listed(), {
      serverId: 'docs',
      pluginId: 'core-mcp',
      serverPolicy: 'ask',
      call: async () => ({ content: [{ type: 'text', text: 'Quota exceeded' }, { type: 'text', text: 'Try later' }], isError: true }) as CallToolResult,
    })
    await expect(definition.execute({ q: 'x' }, toolContext())).rejects.toThrow('Quota exceeded\nTry later')
    expect(definition.policy).toBe('ask')
  })

  it('uses the title as a description fallback and keeps a missing schema an object', () => {
    const tool = listed({ description: undefined, title: 'Find', inputSchema: {} as McpListedTool['inputSchema'] })
    const offline = offlineToolOf(tool, { serverId: 'docs', pluginId: 'acme', serverPolicy: 'always' })
    expect(offline).toEqual({
      name: 'mcp__docs__search',
      title: 'Find',
      description: 'Find',
      pluginId: 'acme',
      mcpServerId: 'docs',
      policy: 'always',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    })
    expect(mcpInputSchema(listed({ inputSchema: { type: 'object', properties: 'bad' } as unknown as McpListedTool['inputSchema'] })).properties).toEqual({})
  })
})

describe('outputs', () => {
  it('drops protocol metadata from stored outputs', () => {
    expect(mcpToolOutput({ content: [], structuredContent: { a: 1 }, _meta: { x: 1 }, isError: false } as unknown as CallToolResult))
      .toEqual({ content: [], structuredContent: { a: 1 } })
  })

  it('converts content parts for the model and falls back to JSON', () => {
    expect(mcpModelOutput({ content: [
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'aGk=', mimeType: 'image/png' },
      { type: 'resource_link', uri: 'file:///a', name: 'a' },
    ] })).toEqual({ type: 'content', value: [
      { type: 'text', text: 'hello' },
      { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'aGk=' } },
      { type: 'text', text: JSON.stringify({ type: 'resource_link', uri: 'file:///a', name: 'a' }) },
    ] })
    expect(mcpModelOutput({ content: [], structuredContent: { total: 3 } })).toEqual({ type: 'json', value: { total: 3 } })
    const truncated = { truncated: true, originalBytes: 70_000, preview: '{"content"' }
    expect(mcpModelOutput(truncated)).toEqual({ type: 'json', value: truncated })
  })

  it('caps the error text and has a fallback', () => {
    expect(mcpErrorText({ content: [], isError: true } as unknown as CallToolResult)).toBe('The MCP tool reported an error.')
    expect(mcpErrorText({ content: [{ type: 'text', text: 'x'.repeat(3000) }], isError: true } as CallToolResult)).toHaveLength(2003)
  })
})

describe('errors', () => {
  it('maps connection failures to provider_unreachable and keeps HarnessErrors', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' })
    expect(isConnectionFailure(refused)).toBe(true)
    expect(connectionErrorInit(refused, text => text)).toMatchObject({ code: 'provider_unreachable', action: 'retry' })
    expect(connectionErrorInit(new Error('MCP client initialization timed out after 20000ms'), text => text).code).toBe('provider_unreachable')
    const unauthorized = Object.assign(new Error('HTTP 401 secret-abc'), { statusCode: 401 })
    expect(connectionErrorInit(unauthorized, text => text.replace('secret-abc', '***'))).toEqual({ code: 'provider_error', message: 'HTTP 401 ***', status: 401 })
    const config = mcpConfigError('Missing setting')
    expect(connectionErrorInit(config, text => text)).toEqual({ code: 'validation_error', message: 'Missing setting' })
    expect(isPermanentMcpError(config)).toBe(true)
    expect(isPermanentMcpError(refused)).toBe(false)
  })
})
