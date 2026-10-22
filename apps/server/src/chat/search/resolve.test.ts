// Smoke tests of the P14-0b versions of `resolve.ts` (C52-T7): `providerWebSearch` answers nothing yet (W14.4 calls the
// provider hook), `applyWebSearch` applies a resolution to a turn's tools.
import type { WebSearchParams } from '@harness-forge/plugin-sdk'
import type { Tool, ToolSet } from 'ai'
import type { ResolvedModelBase } from '../../providers/types.ts'
import type { ApprovalTool } from '../approval.ts'
import { SEARCH_WEB_TOOL_NAME } from '@harness-forge/shared'
import { tool } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createSilentLogger } from '../../logger.ts'
import { applyWebSearch, isBuiltinSearchTool, isProviderTool, providerWebSearch } from './resolve.ts'
import { SEARCH_TOOL_PLUGIN_ID } from './types.ts'

function functionTool(): Tool {
  return tool({ description: 'A tool.', inputSchema: z.object({}), execute: async () => ({}) }) as Tool
}

const PROVIDER_TOOL = { type: 'provider', id: 'test.web_search', args: {}, isProviderExecuted: true, inputSchema: z.object({}) } as unknown as Tool

function approvalTool(name: string, pluginId: string): ApprovalTool {
  return { pluginId, definition: { name, description: 'A tool.', inputSchema: z.object({}), execute: async () => ({}) } }
}

function assembled(activeTools?: string[]) {
  const tools: ToolSet = { lookup: functionTool(), [SEARCH_WEB_TOOL_NAME]: functionTool() }
  const byName = new Map([['lookup', approvalTool('lookup', 'demo')], [SEARCH_WEB_TOOL_NAME, approvalTool(SEARCH_WEB_TOOL_NAME, SEARCH_TOOL_PLUGIN_ID)]])
  return { tools, byName, ...(activeTools === undefined ? {} : { activeTools }) }
}

describe('providerWebSearch (P14-0b stub)', () => {
  it('answers undefined', () => {
    expect(providerWebSearch({ provider: { definition: { webSearch: () => ({ tools: { web_search: PROVIDER_TOOL } }) } } } as unknown as ResolvedModelBase, { functionTools: 0, maxUses: 5 }, createSilentLogger())).toBeUndefined()
  })
})

describe('applyWebSearch', () => {
  it('keeps search_web of core-search only for the builtin; never touches the input', () => {
    const input = assembled(['lookup', SEARCH_WEB_TOOL_NAME])
    const builtin = applyWebSearch(input, { kind: 'builtin' }, undefined)
    expect(Object.keys(builtin.tools).sort()).toEqual(['lookup', SEARCH_WEB_TOOL_NAME])
    expect(builtin.activeTools).toEqual(['lookup', SEARCH_WEB_TOOL_NAME])
    for (const resolution of [{ kind: 'off' }, { kind: 'unavailable', reason: 'no-backend' }] as const) {
      const applied = applyWebSearch(input, resolution, undefined)
      expect(Object.keys(applied.tools)).toEqual(['lookup'])
      expect([...applied.byName.keys()]).toEqual(['lookup'])
      expect(applied.activeTools).toEqual(['lookup'])
      expect(applied.nativeTools.size).toBe(0)
    }
    expect(Object.keys(input.tools).sort()).toEqual(['lookup', SEARCH_WEB_TOOL_NAME])
  })

  it('native: provider tools only, no key collision, the options passed on; params are ignored for other kinds', () => {
    const params: WebSearchParams = { tools: { web_search: PROVIDER_TOOL, lookup: PROVIDER_TOOL, other: functionTool() }, providerOptions: { test: { a: 1 } } }
    const native = applyWebSearch(assembled(), { kind: 'native', exclusive: false }, params)
    expect(Object.keys(native.tools).sort()).toEqual(['lookup', 'web_search'])
    expect(native.tools.lookup).not.toBe(PROVIDER_TOOL)
    expect([...native.nativeTools]).toEqual(['web_search'])
    expect(native.providerOptions).toEqual({ test: { a: 1 } })
    expect(native.activeTools).toBeUndefined()
    const off = applyWebSearch(assembled(), { kind: 'off' }, params)
    expect(off.nativeTools.size).toBe(0)
    expect(off.providerOptions).toBeUndefined()
  })

  it('recognizes the builtin by owner and name, provider tools by type', () => {
    expect(isBuiltinSearchTool(SEARCH_WEB_TOOL_NAME, { pluginId: SEARCH_TOOL_PLUGIN_ID })).toBe(true)
    expect(isBuiltinSearchTool(SEARCH_WEB_TOOL_NAME, { pluginId: 'other' })).toBe(false)
    expect(isBuiltinSearchTool('web_search', { pluginId: SEARCH_TOOL_PLUGIN_ID })).toBe(false)
    expect(isBuiltinSearchTool(SEARCH_WEB_TOOL_NAME, undefined)).toBe(false)
    expect(isProviderTool(PROVIDER_TOOL)).toBe(true)
    expect(isProviderTool(functionTool())).toBe(false)
    expect(isProviderTool(null)).toBe(false)
  })
})
