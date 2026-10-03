import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatDetail, chatId, chatSummary, projectId, projectSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { PROJECT_DELETED_MESSAGE, PROJECT_FILTER_KEY, UNREAD_CHATS_KEY, useChatsStore } from './chats'
import { useProjectsStore } from './projects'
import { useUiStore } from './ui'

const mock = vi.hoisted(() => ({
  api: null as unknown,
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))
vi.mock('vue-sonner', () => ({ toast: mock.toast }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let storage: Storage

const NOW = new Date(2026, 8, 28, 15, 0, 0).getTime()
const HOUR = 3_600_000
const DAY = 24 * HOUR

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  mock.toast.mockClear()
  api = createMockApi()
  mock.api = api
  storage = stubLocalStorage()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const today = chatSummary({ id: chatId(3), title: 'Today', updatedAt: NOW - HOUR })
const yesterday = chatSummary({ id: chatId(2), title: 'Yesterday', updatedAt: NOW - DAY })
const lastMonth = chatSummary({ id: chatId(1), title: 'August', updatedAt: new Date(2026, 7, 10).getTime() })

describe('chats store: list', () => {
  it('loads cursor pages and groups them by date', async () => {
    api.chats.list.mockResolvedValueOnce({ items: [today, yesterday], nextCursor: 'c1' })
    api.chats.list.mockResolvedValueOnce({ items: [lastMonth], nextCursor: null })
    const chats = useChatsStore()
    await chats.fetchPage()
    expect(api.chats.list).toHaveBeenLastCalledWith({ query: { limit: 50 } })
    expect(chats.hasMore).toBe(true)
    expect(chats.loaded).toBe(true)
    await chats.fetchPage()
    expect(api.chats.list).toHaveBeenLastCalledWith({ query: { limit: 50, cursor: 'c1' } })
    expect(chats.hasMore).toBe(false)
    expect(chats.groups.map(group => [group.label, group.chats.map(chat => chat.title)])).toEqual([
      ['Today', ['Today']],
      ['Yesterday', ['Yesterday']],
      ['August', ['August']],
    ])
    await chats.fetchPage()
    expect(api.chats.list).toHaveBeenCalledTimes(2)
  })

  it('shares a page request in flight and tracks loading', async () => {
    api.chats.list.mockResolvedValue({ items: [today], nextCursor: null })
    const chats = useChatsStore()
    const first = chats.fetchPage()
    const second = chats.fetchPage()
    expect(chats.loading).toBe(true)
    await Promise.all([first, second])
    expect(api.chats.list).toHaveBeenCalledTimes(1)
    expect(chats.loading).toBe(false)
  })

  it('reloads the first page on reset', async () => {
    api.chats.list.mockResolvedValueOnce({ items: [today, yesterday], nextCursor: 'c1' })
    api.chats.list.mockResolvedValueOnce({ items: [yesterday], nextCursor: null })
    const chats = useChatsStore()
    await chats.fetchPage()
    await chats.fetchPage({ reset: true })
    expect(api.chats.list).toHaveBeenLastCalledWith({ query: { limit: 50 } })
    expect(chats.items.map(chat => chat.id)).toEqual([yesterday.id])
  })

  it('surfaces the Phase 0 stub error without marking the list loaded', async () => {
    const chats = useChatsStore()
    await expect(chats.fetchPage()).rejects.toMatchObject({ code: 'not_implemented' })
    expect(chats.loaded).toBe(false)
    expect(chats.loading).toBe(false)
  })

  it('searches without touching the list', async () => {
    api.chats.list.mockResolvedValue({ items: [{ ...today, snippet: 'match' }], nextCursor: null })
    const chats = useChatsStore()
    const results = await chats.search('  auth  ')
    expect(api.chats.list).toHaveBeenCalledWith({ query: { q: 'auth', limit: 20 }, signal: undefined })
    expect(results[0]?.snippet).toBe('match')
    expect(chats.items).toEqual([])
    expect(await chats.search('   ')).toEqual([])
  })

  it('moves the date groups at midnight', async () => {
    api.chats.list.mockResolvedValue({ items: [today], nextCursor: null })
    const chats = useChatsStore()
    await chats.fetchPage()
    expect(chats.groups[0]?.label).toBe('Today')
    await vi.advanceTimersByTimeAsync(10 * HOUR)
    expect(chats.groups[0]?.label).toBe('Yesterday')
  })
})

describe('chats store: status dots', () => {
  it('seeds run state from summaries: approval > running > unread', async () => {
    api.chats.list.mockResolvedValue({
      items: [
        chatSummary({ id: chatId(1), updatedAt: NOW - 1, running: true }),
        chatSummary({ id: chatId(2), updatedAt: NOW - 2, running: true, pendingApproval: true }),
        chatSummary({ id: chatId(3), updatedAt: NOW - 3 }),
      ],
      nextCursor: null,
    })
    const chats = useChatsStore()
    await chats.fetchPage()
    expect(chats.statusOf(chatId(1))).toBe('running')
    expect(chats.statusOf(chatId(2))).toBe('approval')
    expect(chats.statusOf(chatId(3))).toBeNull()
  })

  it('follows run events and marks finished runs of other chats unread', () => {
    const chats = useChatsStore()
    const ui = useUiStore()
    ui.setActiveChat(chatId(1))
    chats.applyEvent({ type: 'run.started', data: { chatId: chatId(1), messageId: 'msg_aaaaaaaaaaaaaaaa', modelRef: 'mock:echo' }, at: 1 })
    chats.applyEvent({ type: 'run.started', data: { chatId: chatId(2), messageId: 'msg_bbbbbbbbbbbbbbbb', modelRef: 'mock:echo' }, at: 2 })
    expect(chats.statusOf(chatId(1))).toBe('running')
    expect(chats.statusOf(chatId(2))).toBe('running')

    chats.applyEvent({ type: 'run.finished', data: { chatId: chatId(1), messageId: 'msg_aaaaaaaaaaaaaaaa', outcome: 'completed', awaitingApproval: false }, at: 3 })
    chats.applyEvent({ type: 'run.finished', data: { chatId: chatId(2), messageId: 'msg_bbbbbbbbbbbbbbbb', outcome: 'completed', awaitingApproval: false }, at: 4 })
    expect(chats.statusOf(chatId(1))).toBeNull()
    expect(chats.statusOf(chatId(2))).toBe('unread')

    chats.applyEvent({ type: 'run.finished', data: { chatId: chatId(3), messageId: 'msg_cccccccccccccccc', outcome: 'completed', awaitingApproval: true }, at: 5 })
    expect(chats.statusOf(chatId(3))).toBe('approval')

    ui.setActiveChat(chatId(2))
    expect(chats.statusOf(chatId(2))).toBeNull()
  })

  it('persists unread marks in localStorage', async () => {
    storage.setItem(UNREAD_CHATS_KEY, JSON.stringify([chatId(7), 42]))
    const chats = useChatsStore()
    expect(chats.statusOf(chatId(7))).toBe('unread')
    chats.applyEvent({ type: 'run.finished', data: { chatId: chatId(8), messageId: 'msg_aaaaaaaaaaaaaaaa', outcome: 'failed', awaitingApproval: false }, at: 1 })
    await Promise.resolve()
    expect(JSON.parse(storage.getItem(UNREAD_CHATS_KEY)!)).toEqual([chatId(7), chatId(8)])
    chats.markRead(chatId(7))
    await Promise.resolve()
    expect(JSON.parse(storage.getItem(UNREAD_CHATS_KEY)!)).toEqual([chatId(8)])
  })

  it('takes run state pushed by the chat session', () => {
    const chats = useChatsStore()
    chats.setRunState(chatId(1), 'running')
    expect(chats.statusOf(chatId(1))).toBe('running')
    chats.setRunState(chatId(1), null)
    expect(chats.statusOf(chatId(1))).toBeNull()
    expect(chats.runState).toEqual({})
  })
})

describe('chats store: events', () => {
  it('inserts, updates, re-sorts and removes rows', async () => {
    api.chats.list.mockResolvedValue({ items: [today, yesterday], nextCursor: null })
    const chats = useChatsStore()
    await chats.fetchPage()
    const created = chatSummary({ id: chatId(9), title: null, updatedAt: NOW })
    chats.applyEvent({ type: 'chat.created', data: created, at: 1 })
    expect(chats.items[0]?.id).toBe(chatId(9))

    chats.applyEvent({ type: 'chat.updated', data: { ...yesterday, title: 'Renamed', updatedAt: NOW + 1, activeLeafId: null }, at: 2 })
    expect(chats.items.map(chat => chat.title)).toEqual(['Renamed', null, 'Today'])

    chats.applyEvent({ type: 'chat.updated', data: { ...today, archived: true, activeLeafId: null }, at: 3 })
    expect(chats.items.some(chat => chat.id === today.id)).toBe(false)
    // Kept aside for byId (an open archived chat still has its summary).
    expect(chats.byId(today.id)?.archived).toBe(true)

    chats.applyEvent({ type: 'chat.deleted', data: { id: chatId(9) }, at: 4 })
    expect(chats.items.map(chat => chat.id)).toEqual([yesterday.id])
  })

  it('keeps summary fields only: the active leaf of chat.updated is not stored in the row', async () => {
    api.chats.list.mockResolvedValue({ items: [today], nextCursor: null })
    const chats = useChatsStore()
    await chats.fetchPage()
    chats.applyEvent({ type: 'chat.updated', data: { ...today, title: 'Switched', activeLeafId: 'msg_asst000000000001' }, at: 1 })
    expect(chats.byId(today.id)).toEqual({ ...today, title: 'Switched' })
    expect(chats.byId(today.id)).not.toHaveProperty('activeLeafId')

    const created = chatSummary({ id: chatId(8), updatedAt: NOW })
    chats.applyEvent({ type: 'chat.updated', data: { ...created, activeLeafId: null }, at: 2 })
    expect(chats.byId(created.id)).toEqual(created)
  })

  it('does not insert rows before the list is loaded or outside the loaded window', async () => {
    const chats = useChatsStore()
    chats.applyEvent({ type: 'chat.created', data: today, at: 1 })
    expect(chats.items).toEqual([])

    api.chats.list.mockResolvedValue({ items: [today], nextCursor: 'more' })
    await chats.fetchPage()
    chats.applyEvent({ type: 'chat.updated', data: { ...lastMonth, activeLeafId: null }, at: 2 })
    expect(chats.items.map(chat => chat.id)).toEqual([today.id])
    // Not listed, but known: byId answers for it (e.g. an old chat opened from search).
    expect(chats.byId(lastMonth.id)).toEqual(lastMonth)
    chats.applyEvent({ type: 'chat.updated', data: { ...lastMonth, running: true, activeLeafId: null }, at: 3 })
    expect(chats.statusOf(lastMonth.id)).toBe('running')
  })
})

describe('chats store: actions', () => {
  it('gets a chat and refreshes its row', async () => {
    api.chats.list.mockResolvedValue({ items: [today], nextCursor: null })
    api.chats.get.mockResolvedValue(chatDetail({ ...today, title: 'Fresh title', pendingApproval: true }))
    const chats = useChatsStore()
    await chats.fetchPage()
    const detail = await chats.get(today.id)
    expect(api.chats.get).toHaveBeenCalledWith({ params: { id: today.id } })
    expect(detail.messages).toEqual([])
    expect(chats.byId(today.id)?.title).toBe('Fresh title')
    expect(chats.byId(today.id)).not.toHaveProperty('messages')
    expect(chats.statusOf(today.id)).toBe('approval')
  })

  it('renames optimistically and rolls back when the request fails', async () => {
    api.chats.list.mockResolvedValue({ items: [today], nextCursor: null })
    api.chats.update.mockRejectedValue(new HarnessError({ code: 'internal_error', message: 'Boom' }))
    const chats = useChatsStore()
    await chats.fetchPage()
    const pending = chats.rename(today.id, '  New name ')
    expect(chats.byId(today.id)?.title).toBe('New name')
    await expect(pending).rejects.toMatchObject({ code: 'internal_error' })
    expect(api.chats.update).toHaveBeenCalledWith({ params: { id: today.id }, body: { title: '  New name ' } })
    expect(chats.byId(today.id)?.title).toBe('Today')
  })

  it('creates a chat at the top of a loaded list', async () => {
    api.chats.list.mockResolvedValue({ items: [yesterday], nextCursor: null })
    api.chats.create.mockResolvedValue(chatDetail({ id: chatId(5), title: 'Imported', updatedAt: NOW }))
    const chats = useChatsStore()
    await chats.fetchPage()
    await chats.create({ title: 'Imported' })
    expect(chats.items.map(chat => chat.id)).toEqual([chatId(5), yesterday.id])
  })

  it('deletes after the undo window, and undo restores the row', async () => {
    api.chats.list.mockResolvedValue({ items: [today, yesterday], nextCursor: null })
    api.chats.remove.mockResolvedValue(undefined)
    const chats = useChatsStore()
    await chats.fetchPage()

    const undone = chats.remove(today.id)
    expect(chats.byId(today.id)).toBeUndefined()
    undone.undo()
    await expect(undone.done).resolves.toEqual({ status: 'undone' })
    expect(chats.items.map(chat => chat.id)).toEqual([today.id, yesterday.id])

    const deleted = chats.remove(today.id)
    chats.applyEvent({ type: 'chat.updated', data: { ...today, activeLeafId: null }, at: 1 })
    expect(chats.byId(today.id)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(4999)
    expect(api.chats.remove).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(deleted.done).resolves.toEqual({ status: 'deleted' })
    expect(api.chats.remove).toHaveBeenCalledWith({ params: { id: today.id } })
    deleted.undo()
    expect(chats.byId(today.id)).toBeUndefined()
  })

  it('restores the row when the delete fails', async () => {
    api.chats.list.mockResolvedValue({ items: [today], nextCursor: null })
    api.chats.remove.mockRejectedValue(new HarnessError({ code: 'internal_error', message: 'Boom' }))
    const chats = useChatsStore()
    await chats.fetchPage()
    const handle = chats.remove(today.id, { undoMs: 10 })
    await vi.advanceTimersByTimeAsync(10)
    await expect(handle.done).resolves.toMatchObject({ status: 'failed', error: { code: 'internal_error' } })
    expect(chats.byId(today.id)?.title).toBe('Today')
  })

  it('sends pending deletes with keepalive when the page goes away', async () => {
    api.chats.list.mockResolvedValue({ items: [today], nextCursor: null })
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchSpy)
    const chats = useChatsStore()
    await chats.fetchPage()
    const handle = chats.remove(today.id)
    window.dispatchEvent(new Event('pagehide'))
    expect(fetchSpy).toHaveBeenCalledWith(`/api/chats/${today.id}`, expect.objectContaining({ method: 'DELETE', keepalive: true }))
    await expect(handle.done).resolves.toEqual({ status: 'deleted' })
    await vi.advanceTimersByTimeAsync(6000)
    expect(api.chats.remove).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('exports a chat as a download named by the server', async () => {
    api.chats.export.mockResolvedValue(new Response('# Chat', {
      headers: { 'content-disposition': 'attachment; filename="today-2026-09-28.md"' },
    }))
    const createObjectURL = vi.fn(() => 'blob:export')
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL: vi.fn() }))
    const clicked: string[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download)
    })
    const chats = useChatsStore()
    await chats.exportChat(today.id, 'md')
    expect(api.chats.export).toHaveBeenCalledWith({ params: { id: today.id }, query: { format: 'md' } })
    expect(clicked).toEqual(['today-2026-09-28.md'])
    click.mockRestore()
  })
})

describe('chats store: project filter (Phase 7)', () => {
  const inProject = chatSummary({ id: chatId(11), title: 'In project', updatedAt: NOW - HOUR, projectId: projectId(1) })
  const inOther = chatSummary({ id: chatId(12), title: 'Other project', updatedAt: NOW - 2 * HOUR, projectId: projectId(2) })
  const plain = chatSummary({ id: chatId(13), title: 'Plain', updatedAt: NOW - 3 * HOUR })

  function query() {
    return api.chats.list.mock.lastCall?.[0]?.query as Record<string, unknown> | undefined
  }

  it('starts from the stored filter and ignores a stored value that is not a filter', () => {
    storage.setItem(PROJECT_FILTER_KEY, projectId(1))
    expect(useChatsStore().projectFilter).toBe(projectId(1))
    disposePinia(pinia)

    for (const [stored, expected] of [['none', 'none'], ['all', 'all'], ['prj_bad', 'all'], ['"none"', 'all']] as const) {
      storage.setItem(PROJECT_FILTER_KEY, stored)
      pinia = createPinia()
      setActivePinia(pinia)
      expect(useChatsStore().projectFilter).toBe(expected)
      disposePinia(pinia)
    }
    pinia = createPinia()
    setActivePinia(pinia)
  })

  it('sends projectId with every page of a filtered list (none for chats without a project), nothing for all', async () => {
    api.chats.list.mockResolvedValue({ items: [], nextCursor: null })
    const chats = useChatsStore()
    await chats.fetchPage()
    expect(query()).toEqual({ limit: 50 })

    api.chats.list.mockResolvedValueOnce({ items: [inProject], nextCursor: 'c1' })
    await chats.setProjectFilter(projectId(1))
    expect(query()).toEqual({ limit: 50, projectId: projectId(1) })
    api.chats.list.mockResolvedValueOnce({ items: [], nextCursor: null })
    await chats.fetchPage()
    expect(query()).toEqual({ limit: 50, cursor: 'c1', projectId: projectId(1) })

    api.chats.list.mockResolvedValueOnce({ items: [plain], nextCursor: null })
    await chats.setProjectFilter('none')
    expect(query()).toEqual({ limit: 50, projectId: 'none' })
    expect(chats.items.map(chat => chat.id)).toEqual([plain.id])
  })

  it('stores a new filter, empties the list and loads its first page; the same filter again does nothing', async () => {
    api.chats.list.mockResolvedValueOnce({ items: [inProject, inOther, plain], nextCursor: null })
    const chats = useChatsStore()
    await chats.fetchPage()

    let resolvePage: (value: unknown) => void = () => {}
    api.chats.list.mockReturnValueOnce(new Promise((resolve) => {
      resolvePage = resolve
    }))
    const switching = chats.setProjectFilter(projectId(1))
    expect(storage.getItem(PROJECT_FILTER_KEY)).toBe(projectId(1))
    expect(chats.projectFilter).toBe(projectId(1))
    expect(chats.items).toEqual([])
    expect(chats.loaded).toBe(false)
    expect(chats.loading).toBe(true)
    // The rows of the old list stay known to byId (the open chat keeps its summary).
    expect(chats.byId(inOther.id)).toEqual(inOther)
    resolvePage({ items: [inProject], nextCursor: null })
    await switching
    expect(chats.loaded).toBe(true)
    expect(chats.items.map(chat => chat.id)).toEqual([inProject.id])

    await chats.setProjectFilter(projectId(1))
    expect(api.chats.list).toHaveBeenCalledTimes(2)
  })

  it('rejects when the first page of the new filter fails, leaving the list unloaded', async () => {
    const chats = useChatsStore()
    api.chats.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Boom.' }))
    await expect(chats.setProjectFilter('none')).rejects.toMatchObject({ code: 'internal_error' })
    expect(chats.loaded).toBe(false)
    expect(chats.loading).toBe(false)
    expect(chats.projectFilter).toBe('none')
  })

  it('inserts rows that start matching the filter and removes rows that stop matching', async () => {
    storage.setItem(PROJECT_FILTER_KEY, projectId(1))
    api.chats.list.mockResolvedValueOnce({ items: [inProject], nextCursor: null })
    const chats = useChatsStore()
    await chats.fetchPage()

    // A chat of another project: not listed, but known.
    chats.applyEvent(createServerEvent('chat.created', { ...inOther, updatedAt: NOW }))
    expect(chats.items.map(chat => chat.id)).toEqual([inProject.id])
    expect(chats.byId(inOther.id)?.projectId).toBe(projectId(2))

    // It moves into the filtered project elsewhere: it joins the list.
    chats.applyEvent(createServerEvent('chat.updated', { ...inOther, projectId: projectId(1), updatedAt: NOW, activeLeafId: null }))
    expect(chats.items.map(chat => chat.id)).toEqual([inOther.id, inProject.id])

    // The first one moves out: it leaves the list.
    chats.applyEvent(createServerEvent('chat.updated', { ...inProject, projectId: null, activeLeafId: null }))
    expect(chats.items.map(chat => chat.id)).toEqual([inOther.id])
    expect(chats.byId(inProject.id)?.projectId).toBeNull()
  })

  it('moves a chat optimistically: it leaves the filtered list at once and comes back when the server refuses', async () => {
    storage.setItem(PROJECT_FILTER_KEY, projectId(1))
    api.chats.list.mockResolvedValueOnce({ items: [inProject], nextCursor: null })
    const chats = useChatsStore()
    await chats.fetchPage()

    let reject: (error: unknown) => void = () => {}
    api.chats.update.mockReturnValueOnce(new Promise((_resolve, fail) => {
      reject = fail
    }))
    const moving = chats.update(inProject.id, { projectId: projectId(2) })
    expect(api.chats.update).toHaveBeenCalledWith({ params: { id: inProject.id }, body: { projectId: projectId(2) } })
    expect(chats.items).toEqual([])
    expect(chats.byId(inProject.id)?.projectId).toBe(projectId(2))
    reject(new HarnessError({ code: 'conflict', message: 'A response is running.', details: { reason: 'run-active' } }))
    await expect(moving).rejects.toMatchObject({ code: 'conflict' })
    expect(chats.items).toEqual([inProject])

    // A chat known only aside joins the list when it moves into the filtered project.
    chats.applyEvent(createServerEvent('chat.updated', { ...inOther, activeLeafId: null }))
    api.chats.update.mockResolvedValueOnce({ ...inOther, projectId: projectId(1) })
    const joined = chats.update(inOther.id, { projectId: projectId(1) })
    expect(chats.items.map(chat => chat.id)).toEqual([inProject.id, inOther.id])
    await joined
    expect(chats.byId(inOther.id)?.projectId).toBe(projectId(1))
  })

  it('detaches the chats of a deleted project; a list filtered by it falls back to every chat with a toast', async () => {
    storage.setItem(PROJECT_FILTER_KEY, projectId(1))
    api.chats.list.mockResolvedValueOnce({ items: [inProject], nextCursor: null })
    const chats = useChatsStore()
    await chats.fetchPage()

    api.chats.list.mockResolvedValueOnce({ items: [{ ...inProject, projectId: null }, inOther, plain], nextCursor: null })
    chats.applyEvent(createServerEvent('project.changed', { id: projectId(1), project: null }))
    expect(mock.toast).toHaveBeenCalledWith(PROJECT_DELETED_MESSAGE)
    expect(chats.projectFilter).toBe('all')
    expect(storage.getItem(PROJECT_FILTER_KEY)).toBe('all')
    expect(chats.byId(inProject.id)?.projectId).toBeNull()
    await vi.waitFor(() => expect(chats.loaded).toBe(true))
    expect(query()).toEqual({ limit: 50 })
    expect(chats.items.map(chat => chat.id)).toEqual([inProject.id, inOther.id, plain.id])

    // Another project deleted while every chat shows: its rows lose their project, no toast.
    mock.toast.mockClear()
    chats.applyEvent(createServerEvent('project.changed', { id: projectId(2), project: null }))
    expect(chats.byId(inOther.id)?.projectId).toBeNull()
    expect(chats.projectFilter).toBe('all')
    expect(mock.toast).not.toHaveBeenCalled()
    // A changed (not deleted) project touches nothing.
    chats.applyEvent(createServerEvent('project.changed', { id: projectId(3), project: projectSummary({ id: projectId(3) }) }))
    expect(chats.items).toHaveLength(3)
  })

  it('lists the detached chats in a "No project" list', async () => {
    storage.setItem(PROJECT_FILTER_KEY, 'none')
    api.chats.list.mockResolvedValueOnce({ items: [plain], nextCursor: null })
    const chats = useChatsStore()
    await chats.fetchPage()
    chats.applyEvent(createServerEvent('chat.updated', { ...inProject, activeLeafId: null }))
    expect(chats.items.map(chat => chat.id)).toEqual([plain.id])
    chats.applyEvent(createServerEvent('project.changed', { id: projectId(1), project: null }))
    expect(chats.items.map(chat => chat.id)).toEqual([inProject.id, plain.id])
    expect(mock.toast).not.toHaveBeenCalled()
  })

  it('falls back to every chat when the stored project is unknown once the projects loaded', async () => {
    storage.setItem(PROJECT_FILTER_KEY, projectId(5))
    api.chats.list.mockResolvedValue({ items: [], nextCursor: null })
    const chats = useChatsStore()
    expect(chats.projectFilter).toBe(projectId(5))
    api.projects.list.mockResolvedValueOnce({ items: [projectSummary({ id: projectId(1) })] })
    await useProjectsStore().fetchAll()
    await vi.waitFor(() => expect(chats.projectFilter).toBe('all'))
    expect(storage.getItem(PROJECT_FILTER_KEY)).toBe('all')
    expect(mock.toast).not.toHaveBeenCalled()

    // A known project stays.
    api.projects.list.mockResolvedValueOnce({ items: [projectSummary({ id: projectId(1) })] })
    await chats.setProjectFilter(projectId(1))
    await useProjectsStore().fetchAll()
    await Promise.resolve()
    expect(chats.projectFilter).toBe(projectId(1))
  })

  it('searches every chat, whatever the filter', async () => {
    storage.setItem(PROJECT_FILTER_KEY, projectId(1))
    api.chats.list.mockResolvedValueOnce({ items: [inOther, plain], nextCursor: null })
    const chats = useChatsStore()
    const results = await chats.search('plans')
    expect(api.chats.list).toHaveBeenCalledWith({ query: { q: 'plans', limit: 20 }, signal: undefined })
    expect(results).toEqual([inOther, plain])
  })
})
