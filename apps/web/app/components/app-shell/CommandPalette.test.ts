import type { ChatSummary } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { DEFAULT_SETTINGS, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { useShortcuts } from '~/composables/useShortcuts'
import { useChatsStore } from '~/stores/chats'
import { useProjectsStore } from '~/stores/projects'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'
import { catalogModel, chatId, chatSummary, projectId, projectSummary, providerSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { GLOBAL_SHORTCUT_IDS } from './chat-nav/global-shortcuts'
import { allByTestId, byTestId, mountInShell, press, settle } from './chat-nav/testing'
import CommandPalette from './CommandPalette.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  route: null as null | { path: string, fullPath: string, query: Record<string, string> },
  colorMode: null as null | { preference: string, value: string },
  navigateTo: vi.fn(),
  toast: Object.assign(vi.fn(), { custom: vi.fn(), error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
}))

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('./nuxt-imports', () => ({
  useRoute: () => mocks.route,
  navigateTo: mocks.navigateTo,
  useColorMode: () => mocks.colorMode,
}))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

const NOW = new Date(2026, 8, 28, 15, 0, 0).getTime()

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | null = null

const recent: ChatSummary[] = [
  chatSummary({ id: chatId(1), title: 'Auth refactor', updatedAt: NOW - 1000 }),
  chatSummary({ id: chatId(2), title: 'Dinner plans', updatedAt: NOW - 2000 }),
  chatSummary({ id: chatId(3), title: 'OAuth tokens', updatedAt: NOW - 3000 }),
]

async function openPalette(items: ChatSummary[] = recent) {
  const chats = useChatsStore()
  api.chats.list.mockResolvedValueOnce({ items, nextCursor: null })
  await chats.fetchPage()
  wrapper = mountInShell(CommandPalette)
  useUiStore().openPalette()
  await settle()
}

function input(): HTMLInputElement {
  return byTestId<HTMLInputElement>(testIds.commandPaletteInput)!
}

async function type(value: string) {
  const field = input()
  field.value = value
  field.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}

function itemValues() {
  return allByTestId(testIds.commandPaletteItem).map(item => item.dataset.value)
}

function headings() {
  return Array.from(document.body.querySelectorAll('[data-slot="command-group-heading"]')).map(heading => heading.textContent?.trim())
}

function item(value: string): HTMLElement {
  const found = allByTestId(testIds.commandPaletteItem).find(element => element.dataset.value === value)
  if (!found)
    throw new Error(`no palette item ${value}`)
  return found
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  api = createMockApi()
  mocks.api = api
  mocks.route = reactive({ path: '/', fullPath: '/', query: {} })
  mocks.colorMode = reactive({ preference: 'dark', value: 'dark' })
  mocks.navigateTo.mockReset()
  mocks.toast.success.mockClear()
  mocks.toast.error.mockClear()
  stubLocalStorage()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  disposePinia(pinia)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('commandPalette', () => {
  it('opens from the ui store with recent chats first, then actions, pages and theme', async () => {
    await openPalette()
    expect(byTestId(testIds.commandPalette)).not.toBeNull()
    expect(headings()).toEqual(['Recent chats', 'Actions', 'Go to', 'Theme'])
    expect(itemValues().slice(0, 5)).toEqual([`chat:${chatId(1)}`, `chat:${chatId(2)}`, `chat:${chatId(3)}`, 'new-chat', 'show-shortcuts'])
    expect(itemValues()).toContain('go-settings-general')
    expect(item('theme-dark').dataset.checked).toBe('true')
    expect(item('theme-light').dataset.checked).toBeUndefined()
    expect(input().placeholder).toBe('Search chats and commands…')
  })

  it('loads the chat list when it opens before the sidebar did', async () => {
    wrapper = mountInShell(CommandPalette)
    api.chats.list.mockResolvedValueOnce({ items: recent, nextCursor: null })
    useUiStore().openPalette()
    await settle()
    expect(api.chats.list).toHaveBeenCalledTimes(1)
    expect(itemValues()[0]).toBe(`chat:${chatId(1)}`)
  })

  it('searches chats after a debounce, showing local title matches meanwhile', async () => {
    await openPalette()
    const server = [chatSummary({ id: chatId(2), title: 'Dinner plans', updatedAt: NOW - 2000, snippet: 'the auth cookie' })]
    api.chats.list.mockResolvedValueOnce({ items: server, nextCursor: null })
    await type('auth')
    expect(headings()[0]).toBe('Chats')
    expect(itemValues().filter(value => value?.startsWith('chat:'))).toEqual([`chat:${chatId(1)}`, `chat:${chatId(3)}`])
    expect(api.chats.list).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(api.chats.list).toHaveBeenCalledTimes(2)
    expect(api.chats.list).toHaveBeenLastCalledWith({ query: { q: 'auth', limit: 8 }, signal: expect.any(AbortSignal) })
    expect(itemValues().filter(value => value?.startsWith('chat:'))).toEqual([`chat:${chatId(2)}`])
    expect(item(`chat:${chatId(2)}`).textContent).toContain('the auth cookie')
    // The first result is highlighted again once the results arrive, so Enter opens it.
    expect(item(`chat:${chatId(2)}`).hasAttribute('data-highlighted')).toBe(true)
  })

  it('ignores a slower answer for an older query', async () => {
    await openPalette()
    let answerOld: (value: unknown) => void = () => {}
    let oldSignal: AbortSignal | undefined
    api.chats.list.mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
      oldSignal = signal
      return new Promise((resolve) => {
        answerOld = resolve
      })
    })
    await type('din')
    await vi.advanceTimersByTimeAsync(200)
    api.chats.list.mockResolvedValueOnce({ items: [recent[0]!], nextCursor: null })
    await type('auth refactor')
    expect(oldSignal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    answerOld({ items: [recent[1]!], nextCursor: null })
    await settle()
    expect(itemValues().filter(value => value?.startsWith('chat:'))).toEqual([`chat:${chatId(1)}`])
  })

  it('keeps local matches when the search fails, and shows "No results" when nothing matches', async () => {
    await openPalette()
    api.chats.list.mockRejectedValueOnce(new HarnessError({ code: 'not_implemented', message: 'Not implemented yet.' }))
    await type('oauth')
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(itemValues()).toEqual([`chat:${chatId(3)}`])

    api.chats.list.mockResolvedValueOnce({ items: [], nextCursor: null })
    await type('qwertyuiop')
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(itemValues()).toEqual([])
    expect(byTestId(testIds.commandPalette)!.textContent).toContain('No results')
  })

  it('runs the chosen command and closes', async () => {
    await openPalette()
    const ui = useUiStore()

    item(`chat:${chatId(2)}`).click()
    await settle()
    expect(ui.paletteOpen).toBe(false)
    expect(mocks.navigateTo).toHaveBeenLastCalledWith(`/chat/${chatId(2)}`)

    ui.openPalette()
    await settle()
    item('theme-light').click()
    await settle()
    expect(mocks.colorMode!.preference).toBe('light')
    expect(ui.paletteOpen).toBe(false)

    ui.openPalette()
    await settle()
    item('go-settings-models').click()
    await settle()
    expect(mocks.navigateTo).toHaveBeenLastCalledWith('/settings/models')

    ui.openPalette()
    await settle()
    item('show-shortcuts').click()
    await settle()
    expect(ui.paletteOpen).toBe(false)
    expect(ui.shortcutsOpen).toBe(true)

    ui.shortcutsOpen = false
    ui.openPalette()
    await settle()
    item('new-chat').click()
    await settle()
    expect(mocks.navigateTo).toHaveBeenLastCalledWith('/')
    expect(ui.composerFocusRequest).toBe(1)
    expect(ui.paletteOpen).toBe(false)
  })

  it('moves through items with the arrow keys and runs the highlighted one with Enter', async () => {
    await openPalette()
    await type('theme')
    press({ key: 'ArrowDown' }, input())
    await settle()
    expect(item('theme-light').hasAttribute('data-highlighted')).toBe(true)
    press({ key: 'Enter' }, input())
    await settle()
    expect(mocks.colorMode!.preference).toBe('light')
  })

  it('sets the default model from a search, with a confirmation toast', async () => {
    api.providers.list.mockResolvedValue({ items: [providerSummary()] })
    api.models.list.mockResolvedValue({ items: [
      catalogModel({ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }),
      catalogModel({ id: 'text-embed', name: 'Claude embeddings', kind: 'embedding' }),
    ] })
    api.settings.update.mockImplementation(async ({ body }: { body: object }) => ({ ...DEFAULT_SETTINGS, ...body }))
    await openPalette()
    expect(headings()).not.toContain('Default model')

    await type('claude')
    await settle()
    expect(headings()).toContain('Default model')
    const values = itemValues()
    expect(values).toContain('model:anthropic:claude-sonnet-5')
    expect(values).not.toContain('model:anthropic:text-embed')

    item('model:anthropic:claude-sonnet-5').click()
    await settle()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { defaultModelRef: 'anthropic:claude-sonnet-5' } })
    expect(mocks.toast.success).toHaveBeenCalledWith('Default model set to Claude Sonnet 5')
  })

  it('filters the chat list from the Projects section and links Add project… to the settings dialog', async () => {
    api.projects.list.mockResolvedValue({ items: [projectSummary({ id: projectId(1), name: 'Website' })] })
    await openPalette()
    expect(api.projects.list).toHaveBeenCalledTimes(1)
    expect(headings()).not.toContain('Projects')
    await type('project')
    expect(headings()).toContain('Projects')
    expect(item('project-filter-all').dataset.checked).toBe('true')

    api.chats.list.mockResolvedValueOnce({ items: [], nextCursor: null })
    item(`project-filter-${projectId(1)}`).click()
    await settle()
    expect(useUiStore().paletteOpen).toBe(false)
    expect(useChatsStore().projectFilter).toBe(projectId(1))
    expect(api.chats.list).toHaveBeenLastCalledWith({ query: { limit: 50, projectId: projectId(1) } })

    useUiStore().openPalette()
    await settle()
    await type('add project')
    item('project-add').click()
    await settle()
    expect(mocks.navigateTo).toHaveBeenLastCalledWith('/settings/projects?add=1')
  })

  it('moves the open chat to a project', async () => {
    api.projects.list.mockResolvedValue({ items: [projectSummary({ id: projectId(1), name: 'Website' })] })
    await openPalette()
    useUiStore().setActiveChat(chatId(2))
    await type('move')
    expect(itemValues()).toEqual([`project-move-${projectId(1)}`])
    api.chats.update.mockResolvedValueOnce({ ...recent[1]!, projectId: projectId(1) })
    item(`project-move-${projectId(1)}`).click()
    await settle()
    expect(api.chats.update).toHaveBeenCalledWith({ params: { id: chatId(2) }, body: { projectId: projectId(1) } })
    expect(useUiStore().paletteOpen).toBe(false)
    expect(useProjectsStore().byId(projectId(1))?.name).toBe('Website')
  })

  it('registers the global shortcuts while mounted', async () => {
    const registry = useShortcuts()
    const ids = () => registry.list().map(def => def.id)
    await openPalette()
    expect(ids()).toEqual(expect.arrayContaining(Object.values(GLOBAL_SHORTCUT_IDS)))
    wrapper!.unmount()
    wrapper = null
    expect(ids()).not.toContain(GLOBAL_SHORTCUT_IDS.commandPalette)
  })
})
