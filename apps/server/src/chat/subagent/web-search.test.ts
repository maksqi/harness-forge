// The web search of a sub-agent (Phase 14, C52-T4, ADR-063): a child inherits the parent turn's mode and resolves it for
// its own model over its own tools (`childTools({ webSearch })`); native and builtin never together; a provider-executed
// native call is `not-applicable` in the child's approval function. `providerWebSearch` (W14.4) is replaced by a spy
// that calls the test model's hook.
import type { WebSearchParams, WebSearchRequest } from '@harness-forge/plugin-sdk'
import type { McpServer, Settings, ToolMode, WebSearchMode } from '@harness-forge/shared'
import type { Tool } from 'ai'
import type { ToolPref } from '../../mcp/types.ts'
import type { ResolvedModel } from '../../providers/types.ts'
import type { RegisteredTool } from '../../registry/types.ts'
import type { RunSession } from '../pipeline.ts'
import { SEARCH_WEB_TOOL_NAME } from '@harness-forge/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createSilentLogger } from '../../logger.ts'
import { DENIED_NOT_PROVIDER_EXECUTED } from '../approval.ts'
import { providerWebSearch } from '../search/resolve.ts'
import { SEARCH_TOOL_PLUGIN_ID } from '../search/types.ts'
import { childWebSearchMode } from './host.ts'
import { backgroundLaunchInput } from './index.ts'
import { childTools } from './tools.ts'

vi.mock('../search/resolve.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../search/resolve.ts')>()
  return { ...actual, providerWebSearch: vi.fn(actual.providerWebSearch) }
})

const PROVIDER_TOOL = { type: 'provider', id: 'test.web_search', args: {}, isProviderExecuted: true, inputSchema: z.object({ query: z.string() }) } as unknown as Tool

function registered(pluginId: string, name: string, policy: 'safe' | 'ask'): RegisteredTool {
  return {
    pluginId,
    mcpServerId: null,
    title: null,
    definition: { name, description: name, inputSchema: z.object({ query: z.string().optional() }), policy, execute: async () => 'ok' },
  }
}

const TOOLS: RegisteredTool[] = [
  registered('core-tools', 'current_time', 'safe'),
  registered('core-tools', 'web_fetch', 'ask'),
  registered(SEARCH_TOOL_PLUGIN_ID, SEARCH_WEB_TOOL_NAME, 'safe'),
]

function fakeSession(settings: Partial<Settings> = {}): RunSession {
  const deps = {
    registry: {
      tools: { list: () => TOOLS, get: (name: string) => TOOLS.find(entry => entry.definition.name === name), register: () => ({ dispose() {} }) },
      hooks: { run: async () => {}, on: () => ({ dispose() {} }), list: () => [] },
    },
    plugins: { guard: async <T>(_pluginId: string, fn: (signal: AbortSignal) => T | Promise<T>) => fn(new AbortController().signal), isActive: () => true },
    tools: { prefs: async () => new Map<string, ToolPref>() },
    mcp: { list: async () => [] as McpServer[] },
    env: { workspaceShell: true },
  }
  return { chatId: 'chat', assistantId: 'msg_a000000000000001', ctx: { deps, logger: createSilentLogger(), prepared: { settings } } } as unknown as RunSession
}

function model(webSearch: 'native' | null, tools = true): ResolvedModel {
  return {
    modelRef: 'test:child',
    providerId: 'test',
    modelId: 'child',
    info: { id: 'child' },
    entry: { name: 'Child', webSearch, capabilities: { tools } },
    provider: { definition: { webSearch: (): WebSearchParams => ({ tools: { web_search: PROVIDER_TOOL }, providerOptions: { test: { search: true } } }) } },
  } as unknown as ResolvedModel
}

async function child(options: { webSearch?: WebSearchMode, model?: ResolvedModel, toolMode?: ToolMode, allowlist?: string[], settings?: Partial<Settings>, type?: 'explore' | 'general' }) {
  return childTools({
    session: fakeSession(options.settings),
    type: options.type ?? 'general',
    toolMode: options.toolMode ?? 'ask',
    model: options.model ?? model(null),
    workspace: null,
    scope: null,
    parentCallId: 'call_parent',
    signal: new AbortController().signal,
    ...(options.allowlist === undefined ? {} : { allowlist: options.allowlist }),
    ...(options.webSearch === undefined ? {} : { webSearch: options.webSearch }),
  })
}

beforeEach(() => {
  vi.mocked(providerWebSearch).mockReset().mockImplementation((resolved, request: WebSearchRequest) => {
    const hook = (resolved.provider.definition as { webSearch?: (info: unknown, request: WebSearchRequest) => WebSearchParams | undefined }).webSearch
    return hook?.(resolved.info, request)
  })
})

describe('childTools: web search (Phase 14)', () => {
  it('the builtin wins for a model without native search: the child gets core-search\'s search_web (explore too)', async () => {
    for (const type of ['general', 'explore'] as const) {
      const tools = await child({ webSearch: 'auto', type })
      expect(Object.keys(tools.tools).sort()).toEqual(['current_time', SEARCH_WEB_TOOL_NAME])
      expect(tools.byName.has(SEARCH_WEB_TOOL_NAME)).toBe(true)
      expect(tools.webSearch).toEqual({ kind: 'builtin' })
      expect(tools.nativeTools?.size).toBe(0)
      expect(tools.providerOptions).toBeUndefined()
    }
  })

  it('off or absent: no search_web; an allowlist without it leaves no backend', async () => {
    for (const webSearch of [undefined, 'off'] as const) {
      const tools = await child({ ...(webSearch === undefined ? {} : { webSearch }) })
      expect(Object.keys(tools.tools)).toEqual(['current_time'])
      expect(tools.webSearch).toEqual({ kind: 'off' })
    }
    const narrowed = await child({ webSearch: 'auto', allowlist: ['current_time'] })
    expect(Object.keys(narrowed.tools)).toEqual(['current_time'])
    expect(narrowed.webSearch).toEqual({ kind: 'unavailable', reason: 'no-backend' })
  })

  it('native for a native child model: the provider tool and options, never search_web; its calls never ask', async () => {
    const tools = await child({ webSearch: 'auto', model: model('native') })
    expect(Object.keys(tools.tools).sort()).toEqual(['current_time', 'web_search'])
    expect([...tools.byName.keys()]).toEqual(['current_time'])
    expect([...(tools.nativeTools ?? [])]).toEqual(['web_search'])
    expect(tools.webSearch).toEqual({ kind: 'native', exclusive: false })
    expect(tools.providerOptions).toEqual({ test: { search: true } })
    expect(vi.mocked(providerWebSearch).mock.calls[0]?.[1]).toEqual({ functionTools: 1, maxUses: 5 })
    const call = (providerExecuted?: boolean) => ({ toolCall: { toolName: 'web_search', toolCallId: 'srv_1', input: { query: 'x' }, ...(providerExecuted === undefined ? {} : { providerExecuted }) }, messages: [] })
    expect(await tools.toolApproval(call(true))).toBe('not-applicable')
    expect(await tools.toolApproval(call())).toEqual({ type: 'denied', reason: DENIED_NOT_PROVIDER_EXECUTED })
  })

  it('webSearchNative off: the builtin even for a native model; a model without tools gets nothing', async () => {
    const builtin = await child({ webSearch: 'auto', model: model('native'), settings: { webSearchNative: false } })
    expect(builtin.webSearch).toEqual({ kind: 'builtin' })
    expect(Object.keys(builtin.tools).sort()).toEqual(['current_time', SEARCH_WEB_TOOL_NAME])
    const none = await child({ webSearch: 'auto', model: model(null, false) })
    expect(Object.keys(none.tools)).toEqual([])
    expect(none.webSearch).toEqual({ kind: 'unavailable', reason: 'tools-unsupported' })
  })
})

describe('the inherited mode (Phase 14)', () => {
  it('childWebSearchMode: the turn\'s mode, else the settings\' default, else off', () => {
    expect(childWebSearchMode({ webSearch: 'auto', settings: { webSearchDefault: 'off' } })).toBe('auto')
    expect(childWebSearchMode({ settings: { webSearchDefault: 'auto' } })).toBe('auto')
    expect(childWebSearchMode({ settings: {} })).toBe('off')
    expect(childWebSearchMode({ webSearch: 'bogus' as WebSearchMode, settings: { webSearchDefault: 'bogus' as WebSearchMode } })).toBe('off')
  })

  it('a background launch carries the turn\'s mode as settings.webSearchDefault (what its detached host reads)', () => {
    const settings = { webSearchDefault: 'off', subagentMaxSteps: 30 } as unknown as Settings
    const session = { chatId: 'chat', assistantId: 'msg_a000000000000001', ctx: { prepared: { settings, webSearch: 'auto', chat: { settings: {} } }, reasoningEffort: 'auto', logger: createSilentLogger() } } as unknown as RunSession
    const input = backgroundLaunchInput({ session, model: model(null), toolMode: 'ask', workspace: null, scope: null, catalog: {} as never, background: {} as never, origin: 'request' }, { prompt: 'p', description: 'd', type: 'general', background: true } as never, { toolCallId: 'call_1', signal: new AbortController().signal })
    expect(input.settings.webSearchDefault).toBe('auto')
    expect(input.settings.subagentMaxSteps).toBe(30)
    expect(settings.webSearchDefault).toBe('off')
    expect(childWebSearchMode({ settings: input.settings })).toBe('auto')
  })
})
