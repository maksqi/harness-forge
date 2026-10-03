// ChangesFileDiff (docs/UI.md 7.21, 10.5): the lazy diff of an open row: a skeleton, then DiffView with the server's
// totals; the binary / too-large / base-missing notes and DiffView's "too large" for a null diff; "Couldn't load the
// diff" with Retry; an abort on unmount; a reload when the view refreshes; each loaded diff reported to the panel.
import type { FileDiff } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import DiffView from '~/components/chat/parts/tools/DiffView.vue'
import { useWorkspaceStore } from '~/stores/workspace'
import { chatChanges, chatId, fileDiff, gitStatus } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { CHANGES_PANEL_CONTEXT } from './changes-context'
import ChangesFileDiff from './ChangesFileDiff.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
})

// Unmount every tree after each test (before the next one changes the shared panel state).
enableAutoUnmount(afterEach)

/** Mounted inside a TooltipProvider (DiffView's Copy path button has a tooltip). */
function mountDiff(view: 'chat' | 'git' = 'chat', context?: { diffLoaded: ReturnType<typeof vi.fn>, revertStale: ReturnType<typeof vi.fn> }) {
  return mount(defineComponent({
    setup: () => () => h(TooltipProvider, null, { default: () => h(ChangesFileDiff, { chatId: chatId(1), view, path: 'src/index.ts' }) }),
  }), { global: context ? { provide: { [CHANGES_PANEL_CONTEXT as symbol]: context } } : {} })
}

function root(wrapper: ReturnType<typeof mountDiff>) {
  return wrapper.get('[data-slot="changes-diff"]')
}

describe('changesFileDiff', () => {
  it('shows a skeleton, then DiffView with the hunks, the server\'s totals and line numbers', async () => {
    const context = { diffLoaded: vi.fn(), revertStale: vi.fn() }
    let resolve: (value: FileDiff) => void = () => {}
    api.changes.diff.mockReturnValueOnce(new Promise((done) => {
      resolve = done
    }))
    const wrapper = mountDiff('chat', context)
    expect(root(wrapper).attributes('data-state')).toBe('loading')
    expect(root(wrapper).attributes('aria-busy')).toBe('true')
    expect(api.changes.diff).toHaveBeenCalledWith({ params: { id: chatId(1) }, query: { source: 'chat', path: 'src/index.ts' }, signal: expect.any(AbortSignal) })

    const diff = fileDiff({ diff: { hunks: fileDiff().diff!.hunks, added: 40, removed: 7, truncated: true } })
    resolve(diff)
    await flushPromises()
    expect(root(wrapper).attributes('data-state')).toBe('ready')
    const view = wrapper.getComponent(DiffView)
    expect(view.props()).toMatchObject({ hunks: diff.diff!.hunks, path: 'src/index.ts', created: false, truncated: true, stats: { additions: 40, deletions: 7 }, lineNumbers: true })
    expect(context.diffLoaded).toHaveBeenCalledWith('chat', 'src/index.ts', diff)
  })

  it.each([
    [{ binary: true, diff: null }, 'Binary file. No preview.'],
    [{ tooLarge: true, diff: null }, 'This file is too large to show a diff.'],
    [{ baseAvailable: false, diff: null }, 'The earlier version of this file is no longer stored, so it can\'t be shown or reverted.'],
  ] as const)('shows the note for %o', async (overrides, text) => {
    api.changes.diff.mockResolvedValueOnce(fileDiff(overrides))
    const wrapper = mountDiff()
    await flushPromises()
    expect(wrapper.get('[data-slot="changes-diff-note"]').text()).toBe(text)
    expect(wrapper.findComponent(DiffView).exists()).toBe(false)
  })

  it('lets DiffView say a null diff is too large, and marks an untracked Git file as new', async () => {
    api.changes.diff.mockResolvedValueOnce(fileDiff({ source: 'git', status: 'untracked', diff: null }))
    const wrapper = mountDiff('git')
    await flushPromises()
    expect(wrapper.getComponent(DiffView).props()).toMatchObject({ hunks: [], truncated: true, created: true, stats: null })
    expect(wrapper.text()).toContain('The diff is too large to show.')
  })

  it('shows "Couldn\'t load the diff" with Retry', async () => {
    api.changes.diff.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Not found.' }))
    const wrapper = mountDiff()
    await flushPromises()
    expect(root(wrapper).attributes('data-state')).toBe('error')
    const error = wrapper.get('[data-slot="changes-diff-error"]')
    expect(error.attributes('data-code')).toBe('not_found')
    expect(error.text()).toContain('Couldn\'t load the diff')
    api.changes.diff.mockResolvedValueOnce(fileDiff())
    await error.get('button').trigger('click')
    await flushPromises()
    expect(root(wrapper).attributes('data-state')).toBe('ready')
  })

  it('aborts the request when the row closes', () => {
    api.changes.diff.mockReturnValueOnce(new Promise(() => {}))
    const wrapper = mountDiff()
    const signal = (api.changes.diff.mock.calls[0]![0] as { signal: AbortSignal }).signal
    wrapper.unmount()
    expect(signal.aborted).toBe(true)
  })

  it('reloads when its view refreshes (the cache was dropped), keeping the shown diff meanwhile', async () => {
    const workspace = useWorkspaceStore()
    api.changes.git.mockResolvedValue(gitStatus())
    api.changes.list.mockResolvedValue(chatChanges())
    await workspace.fetchChatChanges(chatId(1))
    api.changes.diff.mockResolvedValueOnce(fileDiff())
    const wrapper = mountDiff()
    await flushPromises()
    expect(api.changes.diff).toHaveBeenCalledTimes(1)

    // Another view refreshing changes nothing.
    await workspace.fetchGit(chatId(1))
    await flushPromises()
    expect(api.changes.diff).toHaveBeenCalledTimes(1)

    api.changes.diff.mockReturnValueOnce(new Promise(() => {}))
    await workspace.fetchChatChanges(chatId(1), { force: true })
    await flushPromises()
    expect(api.changes.diff).toHaveBeenCalledTimes(2)
    expect(root(wrapper).attributes('data-state')).toBe('ready')
    expect(wrapper.findComponent(DiffView).exists()).toBe(true)
  })
})
