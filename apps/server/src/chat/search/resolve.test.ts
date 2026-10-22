// `resolve.ts` (W14.4-T2): `providerWebSearch` calls the provider's hook guarded (a throw or a bad answer is ignored with
// a warning, the request is sanitized) and `applyWebSearch` applies a resolution to a turn's tools (provider tools only,
// no key collision, provider options copied, `search_web` only for the builtin, `activeTools` gains the native names).
import type { ProviderDefinition, WebSearchParams, WebSearchRequest } from '@harness-forge/plugin-sdk'
import type { Tool, ToolSet } from 'ai'
import type { ResolvedModelBase } from '../../providers/types.ts'
import type { ApprovalTool } from '../approval.ts'
import { SEARCH_WEB_TOOL_NAME, WEB_SEARCH_MAX_USES } from '@harness-forge/shared'
import { tool } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createMemoryLogger, createSilentLogger } from '../../logger.ts'
import { applyWebSearch, isBuiltinSearchTool, isProviderTool, providerWebSearch } from './resolve.ts'
import { SEARCH_TOOL_PLUGIN_ID } from './types.ts'

/** An object whose `tools` getter throws (a hostile hook answer). */
function hostileAnswer(): WebSearchParams {
  return Object.defineProperty({}, 'tools', {
    enumerable: true,
    get: () => {
      throw new Error('getter')
    },
  }) as WebSearchParams
}

function functionTool(): Tool {
  return tool({ description: 'A tool.', inputSchema: z.object({}), execute: async () => ({}) }) as Tool
}

function providerTool(id = 'test.web_search', args: Record<string, unknown> = {}): Tool {
  return { type: 'provider', id, args, isProviderExecuted: true, inputSchema: z.object({ query: z.string() }) } as unknown as Tool
}

const PROVIDER_TOOL = providerTool()

function approvalTool(name: string, pluginId: string): ApprovalTool {
  return { pluginId, definition: { name, description: 'A tool.', inputSchema: z.object({}), execute: async () => ({}) } }
}

function assembled(activeTools?: string[]) {
  const tools: ToolSet = { lookup: functionTool(), [SEARCH_WEB_TOOL_NAME]: functionTool() }
  const byName = new Map([['lookup', approvalTool('lookup', 'demo')], [SEARCH_WEB_TOOL_NAME, approvalTool(SEARCH_WEB_TOOL_NAME, SEARCH_TOOL_PLUGIN_ID)]])
  return { tools, byName, ...(activeTools === undefined ? {} : { activeTools }) }
}

function resolved(webSearch?: ProviderDefinition['webSearch'] | 'not-a-function'): ResolvedModelBase {
  return {
    modelRef: 'test:model',
    providerId: 'test',
    modelId: 'model',
    info: { id: 'model', capabilities: { tools: true } },
    entry: {},
    provider: { pluginId: 'test-plugin', definition: { id: 'test', name: 'Test', credentials: [], createLanguageModel: () => { throw new Error('unused') }, ...(webSearch === undefined ? {} : { webSearch }) } },
  } as unknown as ResolvedModelBase
}

const REQUEST: WebSearchRequest = { functionTools: 2, maxUses: WEB_SEARCH_MAX_USES }

describe('providerWebSearch', () => {
  it('calls the hook with the model info and the request; answers a fresh, checked copy', () => {
    const calls: [unknown, WebSearchRequest][] = []
    const answer: WebSearchParams = { tools: { web_search: PROVIDER_TOOL }, providerOptions: { test: { search: { depth: 1 } } } }
    const params = providerWebSearch(resolved((info, request) => {
      calls.push([info, request])
      return answer
    }), REQUEST, createSilentLogger())
    expect(calls).toEqual([[{ id: 'model', capabilities: { tools: true } }, { functionTools: 2, maxUses: 5 }]])
    expect(params).toEqual({ tools: { web_search: PROVIDER_TOOL }, providerOptions: { test: { search: { depth: 1 } } } })
    expect(params).not.toBe(answer)
    expect(params?.tools?.web_search).toBe(PROVIDER_TOOL)
    expect(params?.providerOptions).not.toBe(answer.providerOptions)
    expect(params?.providerOptions?.test).not.toBe(answer.providerOptions?.test)
  })

  it('keeps the hook\'s this (a provider definition with methods)', () => {
    const definition = {
      tool: PROVIDER_TOOL,
      webSearch(this: { tool: Tool }) {
        return { tools: { web_search: this.tool } }
      },
    }
    const model = resolved()
    ;(model.provider as { definition: unknown }).definition = { ...model.provider.definition, ...definition }
    expect(providerWebSearch(model, REQUEST, createSilentLogger())?.tools?.web_search).toBe(PROVIDER_TOOL)
  })

  it('sanitizes the request (whole numbers, maxUses 1 ... 20)', () => {
    const seen: WebSearchRequest[] = []
    const model = resolved((_info, request) => {
      seen.push(request)
      return undefined
    })
    for (const request of [{ functionTools: -1, maxUses: 0 }, { functionTools: 1.5, maxUses: 99 }, { functionTools: Number.NaN, maxUses: Number.NaN }, { functionTools: 3, maxUses: 2 }])
      providerWebSearch(model, request, createSilentLogger())
    expect(seen).toEqual([{ functionTools: 0, maxUses: 5 }, { functionTools: 0, maxUses: 20 }, { functionTools: 0, maxUses: 5 }, { functionTools: 3, maxUses: 2 }])
    expect(Object.isFrozen(seen[0])).toBe(true)
  })

  it('answers undefined without a hook, for a hook answering nothing and for a non-function member', () => {
    const logger = createSilentLogger()
    expect(providerWebSearch(resolved(), REQUEST, logger)).toBeUndefined()
    expect(providerWebSearch(resolved(() => undefined), REQUEST, logger)).toBeUndefined()
    expect(providerWebSearch(resolved(() => ({})), REQUEST, logger)).toBeUndefined()
    expect(providerWebSearch(resolved('not-a-function'), REQUEST, logger)).toBeUndefined()
  })

  it('ignores a throwing hook with a warning that names the provider only', () => {
    const memory = createMemoryLogger()
    const params = providerWebSearch(resolved(() => {
      throw new Error('boom')
    }), REQUEST, memory.logger)
    expect(params).toBeUndefined()
    expect(memory.records).toMatchObject([{ level: 'warn', msg: 'provider webSearch() failed', providerId: 'test' }])
  })

  it('ignores bad parts with a warning (never quoting the answer) and bad answers as a whole', () => {
    const memory = createMemoryLogger()
    const partial = providerWebSearch(resolved(() => ({
      tools: { web_search: PROVIDER_TOOL, plain: functionTool(), [SEARCH_WEB_TOOL_NAME]: providerTool('test.x', { secretArg: 'sk-hidden-value' }) },
    })), REQUEST, memory.logger)
    expect(Object.keys(partial?.tools ?? {})).toEqual(['web_search'])
    expect(memory.records).toHaveLength(1)
    expect(memory.records[0]).toMatchObject({ level: 'warn', msg: 'provider webSearch() answer ignored in part', providerId: 'test', modelRef: 'test:model' })
    expect((memory.records[0]?.problems as string[]).length).toBe(2)
    expect(memory.text()).not.toContain('sk-hidden-value')

    for (const answer of ['native', [PROVIDER_TOOL], { tools: [PROVIDER_TOOL] }, { tools: { web_search: PROVIDER_TOOL }, exclusive: 'yes' }, { tools: { web_search: PROVIDER_TOOL }, providerOptions: { test: 1 } }])
      expect(providerWebSearch(resolved(() => answer as WebSearchParams), REQUEST, createSilentLogger()), JSON.stringify(answer)).toBeUndefined()
  })

  it('a hostile answer (a throwing getter) is ignored', () => {
    const memory = createMemoryLogger()
    expect(providerWebSearch(resolved(() => hostileAnswer()), REQUEST, memory.logger)).toBeUndefined()
    expect(memory.records).toMatchObject([{ level: 'warn', problems: ['the answer cannot be read'] }])
  })
})

describe('applyWebSearch', () => {
  it('keeps search_web of core-search only for the builtin; never touches the input', () => {
    const input = assembled(['lookup', SEARCH_WEB_TOOL_NAME])
    const builtin = applyWebSearch(input, { kind: 'builtin' }, undefined)
    expect(Object.keys(builtin.tools).sort()).toEqual(['lookup', SEARCH_WEB_TOOL_NAME])
    expect(builtin.activeTools).toEqual(['lookup', SEARCH_WEB_TOOL_NAME])
    expect(builtin.nativeTools.size).toBe(0)
    expect(builtin.providerOptions).toBeUndefined()
    for (const resolution of [{ kind: 'off' }, { kind: 'unavailable', reason: 'no-backend' }] as const) {
      const applied = applyWebSearch(input, resolution, undefined)
      expect(Object.keys(applied.tools)).toEqual(['lookup'])
      expect([...applied.byName.keys()]).toEqual(['lookup'])
      expect(applied.activeTools).toEqual(['lookup'])
      expect(applied.nativeTools.size).toBe(0)
    }
    expect(Object.keys(input.tools).sort()).toEqual(['lookup', SEARCH_WEB_TOOL_NAME])
    expect([...input.byName.keys()]).toEqual(['lookup', SEARCH_WEB_TOOL_NAME])
  })

  it('native: provider tools only, no key collision, the options passed on as a copy; params are ignored for other kinds', () => {
    const params: WebSearchParams = { tools: { web_search: PROVIDER_TOOL, lookup: PROVIDER_TOOL, other: functionTool() }, providerOptions: { test: { a: 1 } } }
    const native = applyWebSearch(assembled(), { kind: 'native', exclusive: false }, params)
    expect(Object.keys(native.tools).sort()).toEqual(['lookup', 'web_search'])
    expect(native.tools.lookup).not.toBe(PROVIDER_TOOL)
    expect(native.tools.web_search).toBe(PROVIDER_TOOL)
    expect([...native.nativeTools]).toEqual(['web_search'])
    expect(native.byName.has('web_search')).toBe(false)
    expect(native.providerOptions).toEqual({ test: { a: 1 } })
    expect(native.providerOptions).not.toBe(params.providerOptions)
    expect(native.activeTools).toBeUndefined()
    for (const resolution of [{ kind: 'off' }, { kind: 'builtin' }, { kind: 'unavailable', reason: 'tools-conflict' }] as const) {
      const other = applyWebSearch(assembled(), resolution, params)
      expect(other.nativeTools.size, resolution.kind).toBe(0)
      expect(other.providerOptions, resolution.kind).toBeUndefined()
      expect(Object.hasOwn(other.tools, 'web_search'), resolution.kind).toBe(false)
    }
  })

  it('native: the names join activeTools when that list is set; search_web leaves it', () => {
    const native = applyWebSearch(assembled(['lookup', SEARCH_WEB_TOOL_NAME]), { kind: 'native', exclusive: false }, { tools: { web_search: PROVIDER_TOOL } })
    expect(native.activeTools).toEqual(['lookup', 'web_search'])
    expect(Object.keys(native.tools).sort()).toEqual(['lookup', 'web_search'])
  })

  it('native with provider options only (a model without tools): no tool added, the options passed on', () => {
    const native = applyWebSearch({ tools: {}, byName: new Map() }, { kind: 'native', exclusive: false }, { providerOptions: { openrouter: { plugins: [{ id: 'web', max_results: 5 }] } } })
    expect(native.tools).toEqual({})
    expect(native.nativeTools.size).toBe(0)
    expect(native.providerOptions).toEqual({ openrouter: { plugins: [{ id: 'web', max_results: 5 }] } })
  })

  it('warns about a colliding key of an answer from providerWebSearch (the function tool keeps its name)', () => {
    const memory = createMemoryLogger()
    const params = providerWebSearch(resolved(() => ({ tools: { lookup: providerTool('test.lookup'), web_search: PROVIDER_TOOL } })), REQUEST, memory.logger)
    expect(memory.records).toEqual([])
    const native = applyWebSearch(assembled(), { kind: 'native', exclusive: false }, params)
    expect([...native.nativeTools]).toEqual(['web_search'])
    expect(native.tools.lookup).not.toBe(params?.tools?.lookup)
    expect(memory.records).toMatchObject([{ level: 'warn', providerId: 'test', tools: ['lookup'] }])
  })

  it('a hostile answer passed directly adds nothing and never throws', () => {
    const native = applyWebSearch(assembled(), { kind: 'native', exclusive: false }, hostileAnswer())
    expect(Object.keys(native.tools)).toEqual(['lookup'])
    expect(native.nativeTools.size).toBe(0)
  })

  it('recognizes the builtin by owner and name, provider tools by shape', () => {
    expect(isBuiltinSearchTool(SEARCH_WEB_TOOL_NAME, { pluginId: SEARCH_TOOL_PLUGIN_ID })).toBe(true)
    expect(isBuiltinSearchTool(SEARCH_WEB_TOOL_NAME, { pluginId: 'other' })).toBe(false)
    expect(isBuiltinSearchTool('web_search', { pluginId: SEARCH_TOOL_PLUGIN_ID })).toBe(false)
    expect(isBuiltinSearchTool(SEARCH_WEB_TOOL_NAME, undefined)).toBe(false)
    expect(isProviderTool(PROVIDER_TOOL)).toBe(true)
    expect(isProviderTool({ type: 'provider', id: 'openrouter.web_search', args: { maxResults: 5 }, isProviderExecuted: false })).toBe(true)
    expect(isProviderTool(functionTool())).toBe(false)
    expect(isProviderTool(null)).toBe(false)
    expect(isProviderTool({ type: 'provider', id: 'no-dot', args: {} })).toBe(false)
    expect(isProviderTool({ type: 'provider', id: 'test.web_search' })).toBe(false)
    expect(isProviderTool({ type: 'provider', id: 'test.web_search', args: [] })).toBe(false)
  })
})
