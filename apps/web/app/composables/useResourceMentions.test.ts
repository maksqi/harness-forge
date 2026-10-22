// useResourceMentions (Phase 14, ADR-061; docs/UI.md 7.35, 11.10): the shared mention token, `GET /mcp/resources` 80 ms
// after the last keystroke (the previous request aborted, answers younger than 15 s reused per scope and query),
// `refresh()` when the menu opens, the states, the scope's `available` memory, and `attach` (`POST
// /mcp/resources/attach`, with the chat's `projectId` in a project chat).
import type { McpResourceList } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { mcpResourceEntry, mcpResourceList, projectId } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { RESOURCE_CACHE_MAX_AGE_MS, RESOURCE_LIST_LIMIT, RESOURCE_SEARCH_DEBOUNCE_MS, useResourceMentions } from './useResourceMentions'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let api: MockApi

const EMPTY: McpResourceList = { items: [], truncated: false, unavailable: [] }

function setup(initial = '', options: { project?: string | null, enabled?: boolean } = {}) {
  const scope = effectScope()
  const text = ref(initial)
  const caret = ref(initial.length)
  const project = ref<string | null>(options.project ?? null)
  const enabled = ref(options.enabled ?? true)
  const mentions = scope.run(() => useResourceMentions({ projectId: project, text, caret, enabled }))!
  const typeText = async (value: string) => {
    text.value = value
    caret.value = value.length
    await nextTick()
  }
  return { scope, text, caret, project, enabled, mentions, typeText }
}

/** The 80 ms debounce runs out and the (mocked) listing answers. */
async function settle() {
  vi.advanceTimersByTime(RESOURCE_SEARCH_DEBOUNCE_MS)
  await flushPromises()
}

function queryOf(call: number): Record<string, unknown> {
  return (api.mcpResources.list.mock.calls[call]![0] as { query: Record<string, unknown> }).query
}

describe('useResourceMentions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    api = createMockApi()
    mock.api = api
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads the `@` token at the caret while enabled, idle while disabled or without a token', async () => {
    api.mcpResources.list.mockResolvedValue(mcpResourceList())
    const { scope, mentions, enabled, typeText } = setup('see @READ')
    expect(mentions.token.value).toMatchObject({ start: 4, query: 'READ' })
    expect(mentions.state.value).toBe('loading')
    await settle()
    expect(mentions.state.value).toBe('ready')
    enabled.value = false
    await nextTick()
    expect(mentions.token.value).toBeNull()
    expect(mentions.state.value).toBe('idle')
    expect(mentions.items.value).toEqual([])
    expect(mentions.unavailable.value).toEqual([])
    expect(mentions.truncated.value).toBe(false)
    enabled.value = true
    await typeText('mail a@b')
    expect(mentions.token.value).toBeNull()
    expect(mentions.state.value).toBe('idle')
    scope.stop()
  })

  it('lists 80 ms after the last keystroke with limit 50, aborting the request before', async () => {
    const signals: AbortSignal[] = []
    api.mcpResources.list.mockImplementation(async (input: { query: { q: string }, signal: AbortSignal }) => {
      signals.push(input.signal)
      return mcpResourceList({ items: [mcpResourceEntry({ name: `${input.query.q}.md` })] })
    })
    const { scope, mentions, typeText } = setup()
    await typeText('@R')
    await typeText('@RE')
    vi.advanceTimersByTime(RESOURCE_SEARCH_DEBOUNCE_MS - 1)
    expect(api.mcpResources.list).not.toHaveBeenCalled()
    await typeText('@REA')
    await settle()
    expect(api.mcpResources.list).toHaveBeenCalledTimes(1)
    expect(queryOf(0)).toEqual({ q: 'REA', limit: RESOURCE_LIST_LIMIT })
    expect(RESOURCE_LIST_LIMIT).toBe(50)
    expect(mentions.items.value.map(entry => entry.name)).toEqual(['REA.md'])
    expect(mentions.unavailable.value).toEqual([{ serverId: 'linear', status: 'needs-auth' }])

    // A slow answer is aborted by the next query; the previous rows stay while it loads.
    let finish!: (list: McpResourceList) => void
    api.mcpResources.list.mockImplementationOnce(async (input: { signal: AbortSignal }) => {
      signals.push(input.signal)
      return new Promise<McpResourceList>((resolve) => {
        finish = resolve
      })
    })
    await typeText('@READ')
    await settle()
    expect(mentions.state.value).toBe('loading')
    expect(mentions.items.value.map(entry => entry.name)).toEqual(['REA.md'])
    await typeText('@READM')
    await settle()
    expect(signals[1]!.aborted).toBe(true)
    finish(mcpResourceList({ items: [] }))
    await flushPromises()
    expect(mentions.items.value.map(entry => entry.name)).toEqual(['READM.md'])
    expect(mentions.state.value).toBe('ready')
    scope.stop()
  })

  it('sends the project and keeps a separate cache per scope; answers younger than 15 s are reused', async () => {
    api.mcpResources.list.mockResolvedValue(mcpResourceList())
    const { scope, project, typeText, mentions } = setup('', { project: projectId(1) })
    await typeText('@a')
    await settle()
    expect(queryOf(0)).toEqual({ q: 'a', limit: 50, projectId: projectId(1) })
    await typeText('@ab')
    await settle()
    await typeText('@a')
    await nextTick()
    // The cached answer shows at once.
    expect(mentions.state.value).toBe('ready')
    await settle()
    expect(api.mcpResources.list).toHaveBeenCalledTimes(2)

    project.value = null
    await nextTick()
    await settle()
    expect(api.mcpResources.list).toHaveBeenCalledTimes(3)
    expect(queryOf(2)).toEqual({ q: 'a', limit: 50 })

    // Older than 15 s: listed again.
    project.value = projectId(1)
    await nextTick()
    vi.advanceTimersByTime(RESOURCE_CACHE_MAX_AGE_MS)
    await typeText('@ab')
    await settle()
    expect(api.mcpResources.list).toHaveBeenCalledTimes(4)
    scope.stop()
  })

  it('refresh lists at once unless the answer is younger than 15 s', async () => {
    api.mcpResources.list.mockResolvedValue(mcpResourceList())
    const { scope, mentions, typeText } = setup()
    await expect(mentions.refresh()).resolves.toBeUndefined()
    expect(api.mcpResources.list).not.toHaveBeenCalled()
    await typeText('@')
    await mentions.refresh()
    expect(api.mcpResources.list).toHaveBeenCalledTimes(1)
    expect(mentions.state.value).toBe('ready')
    // The debounced listing of the same token was replaced by the refresh.
    await settle()
    expect(api.mcpResources.list).toHaveBeenCalledTimes(1)
    await mentions.refresh()
    expect(api.mcpResources.list).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(RESOURCE_CACHE_MAX_AGE_MS)
    await mentions.refresh()
    expect(api.mcpResources.list).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it('remembers whether the scope has anything to mention', async () => {
    api.mcpResources.list.mockResolvedValueOnce(EMPTY)
      .mockResolvedValueOnce(mcpResourceList({ items: [], unavailable: [{ serverId: 'off', status: 'disabled' }] }))
      .mockResolvedValueOnce(mcpResourceList({ items: [], unavailable: [{ serverId: 'linear', status: 'needs-auth' }] }))
      .mockResolvedValue(EMPTY)
    const { scope, mentions, typeText } = setup()
    expect(mentions.available.value).toBeNull()
    await typeText('@')
    await settle()
    expect(mentions.available.value).toBe(false)
    // A turned-off server is not something to mention.
    await typeText('@a')
    await settle()
    expect(mentions.available.value).toBe(false)
    await typeText('@ab')
    await settle()
    expect(mentions.available.value).toBe(true)
    // Once known, an empty answer is "no match".
    await typeText('@abc')
    await settle()
    expect(mentions.available.value).toBe(true)
    expect(mentions.items.value).toEqual([])
    expect(mentions.state.value).toBe('ready')
    scope.stop()
  })

  it('a failed listing is the error state with no rows', async () => {
    api.mcpResources.list.mockResolvedValueOnce(mcpResourceList()).mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Could not reach the server.' }))
    const { scope, mentions, typeText } = setup()
    await typeText('@r')
    await settle()
    await typeText('@re')
    await settle()
    expect(mentions.state.value).toBe('error')
    expect(mentions.items.value).toEqual([])
    expect(mentions.available.value).toBe(true)
    scope.stop()
  })

  it('attaches through POST /mcp/resources/attach, with the chat\'s project in a project chat', async () => {
    const fileRef = { id: 'file_0000000000000001', name: 'README.md', mime: 'text/markdown', size: 1200, url: '/api/files/file_0000000000000001' }
    api.mcpResources.attach.mockResolvedValue(fileRef)
    const { scope, mentions, project } = setup('', { project: projectId(1) })
    await expect(mentions.attach(mcpResourceEntry())).resolves.toEqual(fileRef)
    // The server reads from the project's approved server of that id, else from the global one.
    expect(api.mcpResources.attach).toHaveBeenLastCalledWith({ body: { serverId: 'github', uri: 'repo://owner/name/README.md', projectId: projectId(1) } })
    await mentions.attach(mcpResourceEntry({ scope: 'project', serverId: 'docs', uri: 'file:///a.md' }))
    expect(api.mcpResources.attach).toHaveBeenLastCalledWith({ body: { serverId: 'docs', uri: 'file:///a.md', projectId: projectId(1) } })
    project.value = null
    await mentions.attach(mcpResourceEntry())
    expect(api.mcpResources.attach).toHaveBeenLastCalledWith({ body: { serverId: 'github', uri: 'repo://owner/name/README.md' } })

    api.mcpResources.attach.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'Sign in first.', details: { reason: 'needs-auth' } }))
    await expect(mentions.attach(mcpResourceEntry())).rejects.toMatchObject({ code: 'conflict', details: { reason: 'needs-auth' } })
    api.mcpResources.attach.mockRejectedValueOnce(new HarnessError({ code: 'payload_too_large', message: 'Too large.' }))
    await expect(mentions.attach(mcpResourceEntry())).rejects.toBeInstanceOf(HarnessError)
    scope.stop()
  })

  it('stops listing when its scope ends', async () => {
    api.mcpResources.list.mockResolvedValue(mcpResourceList())
    const { scope, typeText } = setup()
    await typeText('@x')
    scope.stop()
    await settle()
    expect(api.mcpResources.list).not.toHaveBeenCalled()
  })
})
