import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatDetail, chatId, chatSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { UNREAD_CHATS_KEY, useChatsStore } from './chats'
import { useUiStore } from './ui'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let storage: Storage

const NOW = new Date(2026, 8, 28, 15, 0, 0).getTime()
const HOUR = 3_600_000
const DAY = 24 * HOUR

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
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

    chats.applyEvent({ type: 'chat.updated', data: { ...yesterday, title: 'Renamed', updatedAt: NOW + 1 }, at: 2 })
    expect(chats.items.map(chat => chat.title)).toEqual(['Renamed', null, 'Today'])

    chats.applyEvent({ type: 'chat.updated', data: { ...today, archived: true }, at: 3 })
    expect(chats.byId(today.id)).toBeUndefined()

    chats.applyEvent({ type: 'chat.deleted', data: { id: chatId(9) }, at: 4 })
    expect(chats.items.map(chat => chat.id)).toEqual([yesterday.id])
  })

  it('does not insert rows before the list is loaded or outside the loaded window', async () => {
    const chats = useChatsStore()
    chats.applyEvent({ type: 'chat.created', data: today, at: 1 })
    expect(chats.items).toEqual([])

    api.chats.list.mockResolvedValue({ items: [today], nextCursor: 'more' })
    await chats.fetchPage()
    chats.applyEvent({ type: 'chat.updated', data: lastMonth, at: 2 })
    expect(chats.byId(lastMonth.id)).toBeUndefined()
    chats.applyEvent({ type: 'chat.updated', data: { ...lastMonth, running: true }, at: 3 })
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
    chats.applyEvent({ type: 'chat.updated', data: today, at: 1 })
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
