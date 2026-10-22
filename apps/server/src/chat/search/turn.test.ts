// `turnWebSearch` (Phase 14, C52): the resolver's inputs from a turn, the second resolution when the provider's answer
// cannot be used, and the applied tools. `providerWebSearch` (W14.4) is replaced by a spy that calls the test model's
// own hook, so these tests keep their meaning once it is implemented.
import type { WebSearchParams, WebSearchRequest } from '@harness-forge/plugin-sdk'
import type { ModelWebSearchKind } from '@harness-forge/shared'
import type { Tool, ToolSet } from 'ai'
import type { ResolvedModelBase } from '../../providers/types.ts'
import type { ApprovalTool } from '../approval.ts'
import type { WebSearchToolSet } from './types.ts'
import { SEARCH_WEB_TOOL_NAME, WEB_SEARCH_MAX_USES } from '@harness-forge/shared'
import { tool } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createSilentLogger } from '../../logger.ts'
import { providerWebSearch } from './resolve.ts'
import { builtinSearchOffered, functionToolCount, turnWebSearch } from './turn.ts'
import { SEARCH_TOOL_PLUGIN_ID } from './types.ts'

vi.mock('./resolve.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./resolve.ts')>()
  return { ...actual, providerWebSearch: vi.fn(actual.providerWebSearch) }
})

const logger = createSilentLogger()

function providerTool(id = 'test.web_search'): Tool {
  return { type: 'provider', id: id as `${string}.${string}`, args: {}, isProviderExecuted: true, inputSchema: z.object({ query: z.string() }) } as Tool
}

function functionTool(): Tool {
  return tool({ description: 'A tool.', inputSchema: z.object({}), execute: async () => ({}) }) as Tool
}

function approvalTool(name: string, pluginId: string): ApprovalTool {
  return { pluginId, definition: { name, description: 'A tool.', inputSchema: z.object({}), execute: async () => ({}) } }
}

/** A tool set: `lookup` (a plain tool) and, unless `search` is false, `core-search`'s `search_web`. */
function toolSet(options: { search?: boolean | string, extra?: number, activeTools?: string[] } = {}): WebSearchToolSet {
  const tools: ToolSet = { lookup: functionTool() }
  const byName = new Map<string, ApprovalTool>([['lookup', approvalTool('lookup', 'demo')]])
  for (let index = 0; index < (options.extra ?? 0); index++) {
    tools[`extra_${index}`] = functionTool()
    byName.set(`extra_${index}`, approvalTool(`extra_${index}`, 'demo'))
  }
  if (options.search !== false) {
    tools[SEARCH_WEB_TOOL_NAME] = functionTool()
    byName.set(SEARCH_WEB_TOOL_NAME, approvalTool(SEARCH_WEB_TOOL_NAME, typeof options.search === 'string' ? options.search : SEARCH_TOOL_PLUGIN_ID))
  }
  return { tools, byName, ...(options.activeTools === undefined ? {} : { activeTools: options.activeTools }) }
}

/** A resolved model with `webSearch` support and a provider hook. */
function model(options: { webSearch?: ModelWebSearchKind | null, tools?: boolean, hook?: (request: WebSearchRequest) => WebSearchParams | undefined } = {}): ResolvedModelBase {
  return {
    modelRef: 'test:model',
    providerId: 'test',
    modelId: 'model',
    info: { id: 'model' },
    entry: { name: 'Test Model', webSearch: options.webSearch ?? null, capabilities: { tools: options.tools ?? true } },
    provider: { definition: { webSearch: (_info: unknown, request: WebSearchRequest) => options.hook?.(request) } },
  } as unknown as ResolvedModelBase
}

const NATIVE: WebSearchParams = { tools: { web_search: providerTool() } }

beforeEach(() => {
  // The spy calls the model's own hook (what W14.4 implements, without its validation).
  vi.mocked(providerWebSearch).mockReset().mockImplementation((resolved, request) => {
    const hook = (resolved.provider.definition as { webSearch?: (info: unknown, request: WebSearchRequest) => WebSearchParams | undefined }).webSearch
    return hook?.(resolved.info, request)
  })
})

describe('the resolver inputs of a turn', () => {
  it('counts the offered function tools without core-search\'s search_web (activeTools when set)', () => {
    expect(functionToolCount(toolSet())).toBe(1)
    expect(functionToolCount(toolSet({ extra: 2 }))).toBe(3)
    expect(functionToolCount(toolSet({ search: 'other-plugin' }))).toBe(2)
    expect(functionToolCount(toolSet({ extra: 2, activeTools: ['lookup', SEARCH_WEB_TOOL_NAME] }))).toBe(1)
    expect(functionToolCount({ tools: {}, byName: new Map() })).toBe(0)
  })

  it('the builtin is available only when core-search\'s search_web is offered and callable', () => {
    expect(builtinSearchOffered(toolSet())).toBe(true)
    expect(builtinSearchOffered(toolSet({ search: false }))).toBe(false)
    expect(builtinSearchOffered(toolSet({ search: 'other-plugin' }))).toBe(false)
    expect(builtinSearchOffered(toolSet({ activeTools: ['lookup'] }))).toBe(false)
    expect(builtinSearchOffered(toolSet({ activeTools: ['lookup', SEARCH_WEB_TOOL_NAME] }))).toBe(true)
  })
})

describe('turnWebSearch', () => {
  it('off: nothing native, search_web removed, the provider is never asked', () => {
    const search = turnWebSearch({ mode: 'off', toolMode: 'ask', model: model({ webSearch: 'native', hook: () => NATIVE }), preferNative: true, assembled: toolSet(), logger })
    expect(search.resolution).toEqual({ kind: 'off' })
    expect(Object.keys(search.tools)).toEqual(['lookup'])
    expect([...search.byName.keys()]).toEqual(['lookup'])
    expect(search.nativeTools.size).toBe(0)
    expect(search.providerOptions).toBeUndefined()
    expect(providerWebSearch).not.toHaveBeenCalled()
  })

  it('native: the provider tools join the turn, search_web goes; the hook gets the function tool count and maxUses', () => {
    const search = turnWebSearch({ mode: 'auto', toolMode: 'plan', model: model({ webSearch: 'native', hook: () => NATIVE }), preferNative: true, assembled: toolSet({ extra: 1 }), logger })
    expect(search.resolution).toEqual({ kind: 'native', exclusive: false })
    expect(Object.keys(search.tools).sort()).toEqual(['extra_0', 'lookup', 'web_search'])
    expect([...search.byName.keys()].sort()).toEqual(['extra_0', 'lookup'])
    expect([...search.nativeTools]).toEqual(['web_search'])
    expect(vi.mocked(providerWebSearch).mock.calls[0]?.[1]).toEqual({ functionTools: 2, maxUses: WEB_SEARCH_MAX_USES })
  })

  it('native with activeTools: the native names are appended, search_web removed', () => {
    const search = turnWebSearch({ mode: 'auto', toolMode: 'ask', model: model({ webSearch: 'native', hook: () => NATIVE }), preferNative: true, assembled: toolSet({ activeTools: ['lookup', SEARCH_WEB_TOOL_NAME] }), logger })
    expect(search.activeTools).toEqual(['lookup', 'web_search'])
  })

  it('native options only (a model without tools, OpenRouter\'s web plugin): the options, no tool', () => {
    const options = { test: { plugins: [{ id: 'web', max_results: 5 }] } }
    const search = turnWebSearch({ mode: 'auto', toolMode: 'ask', model: model({ webSearch: 'native', tools: false, hook: () => ({ providerOptions: options }) }), preferNative: true, assembled: { tools: {}, byName: new Map() }, logger })
    expect(search.resolution).toEqual({ kind: 'native', exclusive: false })
    expect(search.providerOptions).toEqual(options)
    expect(search.nativeTools.size).toBe(0)
  })

  it('a hook without a usable answer resolves again without native search (builtin, else unavailable)', () => {
    for (const answer of [undefined, {}, { tools: { lookup: providerTool() } }, { tools: { web_search: functionTool() } }] as (WebSearchParams | undefined)[]) {
      const withBuiltin = turnWebSearch({ mode: 'auto', toolMode: 'ask', model: model({ webSearch: 'native', hook: () => answer }), preferNative: true, assembled: toolSet(), logger })
      expect(withBuiltin.resolution).toEqual({ kind: 'builtin' })
      expect(Object.keys(withBuiltin.tools).sort()).toEqual(['lookup', SEARCH_WEB_TOOL_NAME])
      expect(withBuiltin.nativeTools.size).toBe(0)
      const without = turnWebSearch({ mode: 'auto', toolMode: 'ask', model: model({ webSearch: 'native', hook: () => answer }), preferNative: true, assembled: toolSet({ search: false }), logger })
      expect(without.resolution).toEqual({ kind: 'unavailable', reason: 'no-backend' })
    }
  })

  it('an exclusive answer while function tools are offered never drops them: builtin, else tools-conflict', () => {
    const exclusive = (): WebSearchParams => ({ ...NATIVE, exclusive: true })
    const withBuiltin = turnWebSearch({ mode: 'auto', toolMode: 'ask', model: model({ webSearch: 'native', hook: exclusive }), preferNative: true, assembled: toolSet(), logger })
    expect(withBuiltin.resolution).toEqual({ kind: 'builtin' })
    expect(withBuiltin.nativeTools.size).toBe(0)
    const without = turnWebSearch({ mode: 'auto', toolMode: 'ask', model: model({ webSearch: 'native', hook: exclusive }), preferNative: true, assembled: toolSet({ search: false }), logger })
    expect(without.resolution).toEqual({ kind: 'unavailable', reason: 'tools-conflict' })
    expect(Object.keys(without.tools)).toEqual(['lookup'])
  })

  it('an exclusive model: native only for a turn without function tools; the provider is not asked otherwise', () => {
    const none = turnWebSearch({ mode: 'auto', toolMode: 'ask', model: model({ webSearch: 'exclusive', hook: () => ({ ...NATIVE, exclusive: true }) }), preferNative: true, assembled: { tools: {}, byName: new Map() }, logger })
    expect(none.resolution).toEqual({ kind: 'native', exclusive: true })
    expect(Object.keys(none.tools)).toEqual(['web_search'])
    expect(vi.mocked(providerWebSearch).mock.calls[0]?.[1]).toEqual({ functionTools: 0, maxUses: WEB_SEARCH_MAX_USES })
    vi.mocked(providerWebSearch).mockClear()
    const some = turnWebSearch({ mode: 'auto', toolMode: 'ask', model: model({ webSearch: 'exclusive', hook: () => ({ ...NATIVE, exclusive: true }) }), preferNative: true, assembled: toolSet({ search: false }), logger })
    expect(some.resolution).toEqual({ kind: 'unavailable', reason: 'tools-conflict' })
    expect(providerWebSearch).not.toHaveBeenCalled()
  })

  it('webSearchNative off: always the builtin; unavailable reasons follow the resolver', () => {
    const builtin = turnWebSearch({ mode: 'auto', toolMode: 'auto', model: model({ webSearch: 'native', hook: () => NATIVE }), preferNative: false, assembled: toolSet(), logger })
    expect(builtin.resolution).toEqual({ kind: 'builtin' })
    expect(providerWebSearch).not.toHaveBeenCalled()
    expect(turnWebSearch({ mode: 'auto', toolMode: 'off', model: model(), preferNative: true, assembled: { tools: {}, byName: new Map() }, logger }).resolution)
      .toEqual({ kind: 'unavailable', reason: 'tool-mode-off' })
    expect(turnWebSearch({ mode: 'auto', toolMode: 'ask', model: model({ tools: false }), preferNative: true, assembled: { tools: {}, byName: new Map() }, logger }).resolution)
      .toEqual({ kind: 'unavailable', reason: 'tools-unsupported' })
  })

  it('a search_web of another plugin is a plain tool: kept in every resolution, never the builtin', () => {
    for (const mode of ['off', 'auto'] as const) {
      const search = turnWebSearch({ mode, toolMode: 'ask', model: model(), preferNative: true, assembled: toolSet({ search: 'other-plugin' }), logger })
      expect(Object.keys(search.tools).sort()).toEqual(['lookup', SEARCH_WEB_TOOL_NAME])
      expect(search.byName.get(SEARCH_WEB_TOOL_NAME)?.pluginId).toBe('other-plugin')
    }
  })

  it('never throws on a throwing hook answer', () => {
    const hostile = { get tools(): never {
      throw new Error('boom')
    } } as unknown as WebSearchParams
    const search = turnWebSearch({ mode: 'auto', toolMode: 'ask', model: model({ webSearch: 'native', hook: () => hostile }), preferNative: true, assembled: toolSet(), logger })
    expect(search.resolution).toEqual({ kind: 'builtin' })
  })
})
