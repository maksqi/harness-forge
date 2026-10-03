import type { ProjectFileEntry, ProjectFileSearch } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError, LIMITS } from '@harness-forge/shared'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { projectFileEntry, projectId } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { MENTION_CACHE_SIZE, MENTION_SEARCH_DEBOUNCE_MS, useFileMentions } from './useFileMentions'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let api: MockApi

function answer(items: ProjectFileEntry[], truncated = false): ProjectFileSearch {
  return { items, truncated, indexedAt: 1_759_000_000_000 }
}

function setup(initial = '', project: string | null = projectId(1)) {
  const scope = effectScope()
  const text = ref(initial)
  const caret = ref(initial.length)
  const projectIdRef = ref<string | null>(project)
  const mentions = scope.run(() => useFileMentions({ projectId: projectIdRef, text, caret }))!
  /** Types `value` with the caret at its end. */
  const typeText = async (value: string) => {
    text.value = value
    caret.value = value.length
    await nextTick()
  }
  return { scope, text, caret, projectId: projectIdRef, mentions, typeText }
}

/** The query of the n-th search call. */
function queryOf(call: number): string {
  return (api.projectFiles.search.mock.calls[call]![0] as { query: { q: string } }).query.q
}

describe('useFileMentions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    api = createMockApi()
    mock.api = api
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens on an @ token of a project chat, never for a@b or without a project', async () => {
    const { scope, mentions, typeText, projectId: project } = setup()
    expect(mentions.open.value).toBe(false)
    await typeText('Fix @src/pa')
    expect(mentions.token.value).toEqual({ start: 4, end: 11, query: 'src/pa' })
    expect(mentions.open.value).toBe(true)
    await typeText('mail a@b')
    expect(mentions.token.value).toBeNull()
    expect(mentions.open.value).toBe(false)
    await typeText('@')
    expect(mentions.open.value).toBe(true)
    project.value = null
    await nextTick()
    expect(mentions.open.value).toBe(false)
    vi.runAllTimers()
    await flushPromises()
    // Every token closed before its debounce ran out.
    expect(api.projectFiles.search).not.toHaveBeenCalled()
    scope.stop()
  })

  it('searches 80 ms after the last keystroke with limit 50 and shows the ranked answer', async () => {
    api.projectFiles.search.mockResolvedValue(answer([projectFileEntry('src/parser.ts'), projectFileEntry('src/parsers', 'dir')], true))
    const { scope, mentions, typeText } = setup()
    await typeText('@p')
    await typeText('@pa')
    await typeText('@par')
    expect(mentions.state.value).toBe('loading')
    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS - 1)
    expect(api.projectFiles.search).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(api.projectFiles.search).toHaveBeenCalledTimes(1)
    expect(api.projectFiles.search.mock.calls[0]![0]).toMatchObject({ params: { id: projectId(1) }, query: { q: 'par', limit: LIMITS.mentionResultsMax } })
    await flushPromises()
    expect(mentions.state.value).toBe('ready')
    expect(mentions.items.value.map(item => item.path)).toEqual(['src/parser.ts', 'src/parsers'])
    expect(mentions.truncated.value).toBe(true)
    expect(mentions.error.value).toBeNull()
    scope.stop()
  })

  it('aborts the previous search when the query changes and ignores its answer', async () => {
    let resolveFirst!: (value: ProjectFileSearch) => void
    api.projectFiles.search
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve
      }))
      .mockResolvedValueOnce(answer([projectFileEntry('src/parser.ts')]))
    const { scope, mentions, typeText } = setup()
    await typeText('@pa')
    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS)
    const firstSignal = (api.projectFiles.search.mock.calls[0]![0] as { signal: AbortSignal }).signal
    await typeText('@par')
    expect(firstSignal.aborted).toBe(true)
    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS)
    await flushPromises()
    resolveFirst(answer([projectFileEntry('old.ts')]))
    await flushPromises()
    expect(mentions.items.value.map(item => item.path)).toEqual(['src/parser.ts'])
    expect(queryOf(1)).toBe('par')
    scope.stop()
  })

  it('caches the last 20 queries per project', async () => {
    api.projectFiles.search.mockImplementation(async (input: { query: { q: string } }) => answer([projectFileEntry(`${input.query.q}.ts`)]))
    const { scope, mentions, typeText, projectId: project } = setup()
    await typeText('@a')
    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS)
    await flushPromises()
    await typeText('@ab')
    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS)
    await flushPromises()
    expect(api.projectFiles.search).toHaveBeenCalledTimes(2)

    // Back to a cached query: shown at once, no request.
    await typeText('@a')
    expect(mentions.state.value).toBe('ready')
    expect(mentions.items.value.map(item => item.path)).toEqual(['a.ts'])
    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS)
    expect(api.projectFiles.search).toHaveBeenCalledTimes(2)

    // Another project has its own cache.
    project.value = projectId(2)
    await nextTick()
    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS)
    await flushPromises()
    expect(api.projectFiles.search).toHaveBeenCalledTimes(3)
    project.value = projectId(1)
    await nextTick()

    // 20 more queries push "a" out.
    for (let index = 0; index < MENTION_CACHE_SIZE; index++) {
      await typeText(`@q${index}`)
      vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS)
      await flushPromises()
    }
    const before = api.projectFiles.search.mock.calls.length
    await typeText('@a')
    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS)
    await flushPromises()
    expect(api.projectFiles.search.mock.calls.length).toBe(before + 1)
    expect(queryOf(before)).toBe('a')
    scope.stop()
  })

  it('forgets a cached answer once the server index may have changed', async () => {
    api.projectFiles.search.mockResolvedValue(answer([projectFileEntry('a.ts')]))
    const { scope, typeText } = setup()
    await typeText('@a')
    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS)
    await flushPromises()
    await typeText('Fix it')
    vi.advanceTimersByTime(LIMITS.mentionIndexTtlMs + 1)
    await typeText('@a')
    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS)
    await flushPromises()
    expect(api.projectFiles.search).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it('reports a failed search and clears the rows', async () => {
    const failure = new HarnessError({ code: 'validation_error', message: 'The folder /srv/x is not available.' })
    api.projectFiles.search.mockResolvedValueOnce(answer([projectFileEntry()])).mockRejectedValueOnce(failure)
    const { scope, mentions, typeText } = setup()
    await typeText('@p')
    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS)
    await flushPromises()
    await typeText('@pa')
    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS)
    await flushPromises()
    expect(mentions.state.value).toBe('error')
    expect(mentions.error.value).toBe(failure)
    expect(mentions.items.value).toEqual([])
    scope.stop()
  })

  it('esc dismisses the token until it changes', async () => {
    api.projectFiles.search.mockResolvedValue(answer([]))
    const { scope, mentions, typeText } = setup()
    await typeText('@pa')
    mentions.dismiss()
    await nextTick()
    expect(mentions.open.value).toBe(false)
    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS)
    expect(api.projectFiles.search).not.toHaveBeenCalled()
    await typeText('@pa')
    expect(mentions.open.value).toBe(false)
    await typeText('@par')
    expect(mentions.open.value).toBe(true)
    // Leaving the token and coming back to the same text opens it again.
    mentions.dismiss()
    await typeText('@par ')
    await typeText('@par')
    expect(mentions.open.value).toBe(true)
    scope.stop()
  })

  it('apply inserts the mention and a blank for a file, @dir/ for a folder (menu stays open)', async () => {
    api.projectFiles.search.mockResolvedValue(answer([]))
    const { scope, mentions, text, caret, typeText } = setup()
    await typeText('Fix @pars')
    expect(mentions.apply(projectFileEntry('src/parser.ts'))).toEqual({ text: 'Fix @src/parser.ts ', caret: 19, keepOpen: false })
    expect(mentions.apply(projectFileEntry('src/parsers', 'dir'))).toEqual({ text: 'Fix @src/parsers/', caret: 17, keepOpen: true })
    expect(mentions.apply(projectFileEntry('docs/my notes.md'))).toEqual({ text: 'Fix @"docs/my notes.md" ', caret: 24, keepOpen: false })
    expect(mentions.apply(projectFileEntry('my dir', 'dir'))).toEqual({ text: 'Fix @"my dir/"', caret: 13, keepOpen: true })

    // In the middle of the text: the token is replaced, an existing blank is reused.
    text.value = 'See @pa and more'
    caret.value = 7
    await nextTick()
    expect(mentions.apply(projectFileEntry('src/parser.ts'))).toEqual({ text: 'See @src/parser.ts and more', caret: 19, keepOpen: false })

    // No token: nothing changes.
    await typeText('plain')
    expect(mentions.apply(projectFileEntry())).toEqual({ text: 'plain', caret: 5, keepOpen: false })
    scope.stop()
  })

  it('stops searching when the scope ends', async () => {
    const { scope, typeText } = setup()
    await typeText('@pa')
    scope.stop()
    vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS)
    expect(api.projectFiles.search).not.toHaveBeenCalled()
  })
})
