import type { ChatSummary } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { useChatsStore } from '~/stores/chats'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'
import { chatId, chatSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { CHAT_UNDO_MS } from './chat-nav/chat-actions'
import { allByTestId, byTestId, FakeIntersectionObserver, mountInShell, mountStandalone, settle } from './chat-nav/testing'
import ChatNav from './ChatNav.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  route: null as null | { path: string, fullPath: string, query: Record<string, string> },
  navigateTo: vi.fn(),
  toast: Object.assign(vi.fn(), {
    custom: vi.fn((..._args: unknown[]) => 'toast-1'),
    error: vi.fn(),
    success: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('./nuxt-imports', () => ({
  useRoute: () => mocks.route,
  navigateTo: mocks.navigateTo,
  useColorMode: () => ({ preference: 'dark', value: 'dark' }),
}))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

const MINUTE = 60_000
const NOW = new Date(2026, 8, 28, 15, 0, 0).getTime()
const ORIGINAL_TZ = process.env.TZ

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | null = null

function setup(now = NOW) {
  vi.useFakeTimers({ now, shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  pinia = createPinia()
  setActivePinia(pinia)
}

function go(path: string) {
  mocks.route!.path = path
  mocks.route!.fullPath = path
}

async function mountNav(items: ChatSummary[] = [], nextCursor: string | null = null) {
  api.chats.list.mockResolvedValueOnce({ items, nextCursor })
  wrapper = mountInShell(ChatNav)
  await settle()
  return wrapper
}

function groups() {
  return allByTestId(testIds.chatGroup).map(group => [
    group.dataset.value,
    allByTestId(testIds.chatRow, group).map(row => row.textContent?.trim()),
  ])
}

function row(id: string): HTMLElement {
  const found = allByTestId(testIds.chatRow).find(element => element.dataset.chatId === id)
  if (!found)
    throw new Error(`no row for ${id}`)
  return found
}

function rowItem(id: string): HTMLElement {
  return row(id).closest('li')!
}

/** Pixels of the Tailwind spacing utility `utility-N` among the element's classes (4px per step), else null. */
function spacingPx(element: Element, utility: string): number | null {
  const prefix = `${utility}-`
  const steps = [...element.classList]
    .filter(name => name.startsWith(prefix) && /^\d+(?:\.\d+)?$/.test(name.slice(prefix.length)))
    .map(name => Number(name.slice(prefix.length)))
  return steps.length > 0 ? steps[0]! * 4 : null
}

async function openRowMenu(id: string) {
  const trigger = byTestId(testIds.chatRowMenu, rowItem(id))!
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await settle()
}

async function chooseMenuItem(testId: string) {
  byTestId(testId)!.click()
  await settle(5)
}

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.route = reactive({ path: '/', fullPath: '/', query: {} })
  mocks.navigateTo.mockReset()
  mocks.toast.mockReset()
  mocks.toast.custom.mockClear()
  mocks.toast.error.mockClear()
  mocks.toast.dismiss.mockClear()
  stubLocalStorage()
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  FakeIntersectionObserver.instances = []
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  if (pinia)
    disposePinia(pinia)
  vi.unstubAllGlobals()
  vi.useRealTimers()
  process.env.TZ = ORIGINAL_TZ
})

describe('chatNav: date groups', () => {
  it('groups chats by calendar day with a fixed clock: Today, Yesterday, Previous 7/30 days, then months', async () => {
    setup()
    const startOfToday = new Date(2026, 8, 28).getTime()
    await mountNav([
      chatSummary({ id: chatId(1), title: 'Five minutes ago', updatedAt: NOW - 5 * MINUTE }),
      chatSummary({ id: chatId(2), title: 'At midnight', updatedAt: startOfToday }),
      chatSummary({ id: chatId(3), title: 'Just before midnight', updatedAt: startOfToday - 1 }),
      chatSummary({ id: chatId(4), title: 'Seven days ago', updatedAt: new Date(2026, 8, 21).getTime() }),
      chatSummary({ id: chatId(5), title: 'Eight days ago', updatedAt: new Date(2026, 8, 20, 23, 59).getTime() }),
      chatSummary({ id: chatId(6), title: 'Thirty days ago', updatedAt: new Date(2026, 7, 29).getTime() }),
      chatSummary({ id: chatId(7), title: 'Thirty-one days ago', updatedAt: new Date(2026, 7, 28, 23, 59).getTime() }),
      chatSummary({ id: chatId(8), title: 'Last December', updatedAt: new Date(2025, 11, 31, 12).getTime() }),
    ])
    expect(groups()).toEqual([
      ['Today', ['Five minutes ago', 'At midnight']],
      ['Yesterday', ['Just before midnight']],
      ['Previous 7 days', ['Seven days ago']],
      ['Previous 30 days', ['Eight days ago', 'Thirty days ago']],
      ['August', ['Thirty-one days ago']],
      ['December 2025', ['Last December']],
    ])
    // Group labels stick while the list scrolls; each group is labelled for assistive technology.
    const firstGroup = allByTestId(testIds.chatGroup)[0]!
    const label = document.getElementById(firstGroup.getAttribute('aria-labelledby')!)
    expect(label?.textContent?.trim()).toBe('Today')
    expect(label?.className).toContain('sticky')
  })

  it('splits by local midnight, not UTC midnight (UTC+9)', async () => {
    process.env.TZ = 'Asia/Tokyo'
    expect(new Date(2026, 8, 28).getTimezoneOffset()).toBe(-540)
    setup(new Date(2026, 8, 28, 9, 0).getTime())
    // 00:15 and 23:45 local are 15:15Z and 14:45Z on the same UTC day (Sep 27).
    await mountNav([
      chatSummary({ id: chatId(1), title: 'After local midnight', updatedAt: new Date(2026, 8, 28, 0, 15).getTime() }),
      chatSummary({ id: chatId(2), title: 'Before local midnight', updatedAt: new Date(2026, 8, 27, 23, 45).getTime() }),
    ])
    expect(new Date(2026, 8, 28, 0, 15).getUTCDate()).toBe(new Date(2026, 8, 27, 23, 45).getUTCDate())
    expect(groups()).toEqual([
      ['Today', ['After local midnight']],
      ['Yesterday', ['Before local midnight']],
    ])
  })

  it('counts calendar days across a DST change (UTC-7 to UTC-8, 25-hour day)', async () => {
    process.env.TZ = 'America/Los_Angeles'
    // DST ends on Sunday 2026-11-01 at 02:00 local.
    setup(new Date(2026, 10, 2, 0, 30).getTime())
    await mountNav([
      chatSummary({ id: chatId(1), title: 'Start of the long day', updatedAt: new Date(2026, 10, 1, 0, 0).getTime() }),
      chatSummary({ id: chatId(2), title: 'Just before it', updatedAt: new Date(2026, 9, 31, 23, 59).getTime() }),
      chatSummary({ id: chatId(3), title: 'A week back', updatedAt: new Date(2026, 9, 26, 0, 0).getTime() }),
      chatSummary({ id: chatId(4), title: 'Eight days back', updatedAt: new Date(2026, 9, 25, 23, 0).getTime() }),
    ])
    expect(groups()).toEqual([
      ['Yesterday', ['Start of the long day']],
      ['Previous 7 days', ['Just before it', 'A week back']],
      ['Previous 30 days', ['Eight days back']],
    ])
  })

  it('moves rows to Yesterday when the local day changes', async () => {
    setup(new Date(2026, 8, 28, 23, 59, 30).getTime())
    await mountNav([chatSummary({ id: chatId(1), title: 'Late', updatedAt: new Date(2026, 8, 28, 23, 0).getTime() })])
    expect(groups()).toEqual([['Today', ['Late']]])
    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(groups()).toEqual([['Yesterday', ['Late']]])
  })
})

describe('chatNav: rows', () => {
  it('shows status dots (approval > running > unread), none for idle chats, and follows run events', async () => {
    setup()
    await mountNav([
      chatSummary({ id: chatId(1), title: 'Running', updatedAt: NOW - 1, running: true }),
      chatSummary({ id: chatId(2), title: 'Approval', updatedAt: NOW - 2, running: true, pendingApproval: true }),
      chatSummary({ id: chatId(3), title: 'Idle', updatedAt: NOW - 3 }),
    ])
    const dotOf = (id: string) => byTestId(testIds.chatStatusDot, rowItem(id))?.dataset.status ?? null
    expect(dotOf(chatId(1))).toBe('running')
    expect(dotOf(chatId(2))).toBe('approval')
    expect(dotOf(chatId(3))).toBeNull()
    expect(rowItem(chatId(2)).textContent).toContain('Needs approval')

    const chats = useChatsStore()
    chats.applyEvent(createServerEvent('run.finished', { chatId: chatId(1), messageId: 'msg_0000000000000001', outcome: 'completed', awaitingApproval: false }))
    chats.applyEvent(createServerEvent('run.started', { chatId: chatId(3), messageId: 'msg_0000000000000002', modelRef: 'mock:echo' }))
    await settle()
    expect(dotOf(chatId(1))).toBe('unread')
    expect(dotOf(chatId(3))).toBe('running')
  })

  it('marks the open chat active and shows untitled chats as "New chat" in muted italic', async () => {
    setup()
    mocks.route = reactive({ path: `/chat/${chatId(2)}`, fullPath: `/chat/${chatId(2)}`, query: {} })
    await mountNav([
      chatSummary({ id: chatId(1), title: 'Titled', updatedAt: NOW - 1 }),
      chatSummary({ id: chatId(2), title: null, titleSource: null, updatedAt: NOW - 2 }),
    ])
    expect(row(chatId(2)).dataset.active).toBe('true')
    expect(row(chatId(1)).dataset.active).toBeUndefined()
    expect(row(chatId(1)).getAttribute('href')).toBe(`/chat/${chatId(1)}`)
    const placeholder = row(chatId(2)).querySelector('span')!
    expect(placeholder.textContent?.trim()).toBe('New chat')
    expect(placeholder.className).toContain('italic')

    go(`/chat/${chatId(1)}`)
    await settle()
    expect(row(chatId(1)).dataset.active).toBe('true')
    expect(row(chatId(2)).dataset.active).toBeUndefined()
  })

  it('makes the actions button a 40px touch target and keeps the title clear of it (UI.md 14.5)', async () => {
    setup()
    await mountNav([
      chatSummary({ id: chatId(1), title: 'Busy', updatedAt: NOW - 1, running: true }),
      chatSummary({ id: chatId(2), title: 'Idle', updatedAt: NOW - 2 }),
    ])
    // The trailing slot sits 4px from the row's right edge (right-1); the dot takes 20px plus a 2px gap.
    const inset = 4
    const dot = spacingPx(byTestId(testIds.chatStatusDot, rowItem(chatId(1)))!, 'size')!
    expect(dot).toBe(20)
    for (const id of [chatId(1), chatId(2)]) {
      const trigger = byTestId(testIds.chatRowMenu, rowItem(id))!
      expect(trigger.getAttribute('aria-label')).toBe('Chat actions')
      // Desktop keeps the 20px slot; touch devices get a 40px button.
      expect(spacingPx(trigger, 'size')).toBe(20)
      const touch = spacingPx(trigger, 'pointer-coarse:size')!
      expect(touch).toBeGreaterThanOrEqual(40)
      // Rows are 40px tall on touch devices, so the button fits the row.
      expect(spacingPx(row(id), 'pointer-coarse:h')).toBe(touch)
      const trailing = touch + inset + (id === chatId(1) ? dot + 2 : 0)
      expect(spacingPx(row(id), 'pointer-coarse:pr')).toBeGreaterThanOrEqual(trailing)
      expect(spacingPx(row(id), 'pr')).toBeGreaterThanOrEqual(20 + inset)
    }
  })

  it('updates a row live when the store applies chat.updated (e.g. the generated title)', async () => {
    setup()
    await mountNav([chatSummary({ id: chatId(1), title: null, titleSource: null, updatedAt: NOW - 1 })])
    useChatsStore().applyEvent(createServerEvent('chat.updated', chatSummary({ id: chatId(1), title: 'Generated title', updatedAt: NOW })))
    await settle()
    expect(row(chatId(1)).textContent?.trim()).toBe('Generated title')
  })
})

describe('chatNav: row menu', () => {
  it('renames inline: Enter saves through the store, the row shows the new title', async () => {
    setup()
    const chat = chatSummary({ id: chatId(1), title: 'Old title', updatedAt: NOW - 1 })
    await mountNav([chat])
    api.chats.update.mockImplementation(async ({ body }: { body: { title: string } }) => ({ ...chat, title: body.title, titleSource: 'user' }))

    await openRowMenu(chatId(1))
    await chooseMenuItem(testIds.chatRowRename)
    const input = byTestId<HTMLInputElement>(testIds.chatRowRenameInput)!
    expect(input).not.toBeNull()
    expect(input.value).toBe('Old title')
    expect(document.activeElement).toBe(input)

    input.value = '  New title  '
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()
    expect(api.chats.update).toHaveBeenCalledWith({ params: { id: chatId(1) }, body: { title: 'New title' } })
    expect(byTestId(testIds.chatRowRenameInput)).toBeNull()
    expect(row(chatId(1)).textContent?.trim()).toBe('New title')
    expect(document.activeElement).toBe(row(chatId(1)))
  })

  it('cancels a rename with Escape and never calls the API', async () => {
    setup()
    await mountNav([chatSummary({ id: chatId(1), title: 'Keep me', updatedAt: NOW - 1 })])
    await openRowMenu(chatId(1))
    await chooseMenuItem(testIds.chatRowRename)
    const input = byTestId<HTMLInputElement>(testIds.chatRowRenameInput)!
    input.value = 'Changed'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect(byTestId(testIds.chatRowRenameInput)).toBeNull()
    expect(row(chatId(1)).textContent?.trim()).toBe('Keep me')
    expect(api.chats.update).not.toHaveBeenCalled()
  })

  it('keeps the actions button focusable, so closing the menu with Escape returns focus to it', async () => {
    setup()
    await mountNav([chatSummary({ id: chatId(1), title: 'Keyboard', updatedAt: NOW - 1, running: true })])
    const trigger = byTestId(testIds.chatRowMenu, rowItem(chatId(1)))!
    // Hidden with opacity until hover or focus, never with display: a display:none button cannot take focus back.
    expect(trigger.className).toContain('pointer-fine:opacity-0')
    expect(trigger.className.split(/\s+/).some(token => token === 'hidden' || token.endsWith(':hidden'))).toBe(false)
    await openRowMenu(chatId(1))
    expect(byTestId(testIds.chatRowRename)).not.toBeNull()
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    await vi.advanceTimersByTimeAsync(10)
    expect(byTestId(testIds.chatRowRename)).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('shows a toast and restores the title when the rename fails', async () => {
    setup()
    await mountNav([chatSummary({ id: chatId(1), title: 'Stable', updatedAt: NOW - 1 })])
    api.chats.update.mockRejectedValue(new HarnessError({ code: 'validation_error', message: 'Title too long.' }))
    await openRowMenu(chatId(1))
    await chooseMenuItem(testIds.chatRowRename)
    const input = byTestId<HTMLInputElement>(testIds.chatRowRenameInput)!
    input.value = 'Broken'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()
    expect(mocks.toast.error).toHaveBeenCalledWith('Couldn\'t rename the chat', { description: 'Title too long.' })
    expect(row(chatId(1)).textContent?.trim()).toBe('Stable')
  })

  it('lists Share… after Rename and opens the Share dialog of the row\'s chat', async () => {
    setup()
    await mountNav([
      chatSummary({ id: chatId(1), title: 'Share me', updatedAt: NOW - 1 }),
      chatSummary({ id: chatId(2), title: 'Other', updatedAt: NOW - 2 }),
    ])
    await openRowMenu(chatId(2))
    const items = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    expect(items.map(item => item.textContent?.trim())).toEqual(['Rename', 'Share…', 'Export as Markdown', 'Export as JSON', 'Delete'])

    await chooseMenuItem(testIds.chatRowShare)
    const ui = useUiStore()
    expect(ui.shareChatId).toBe(chatId(2))
    expect(byTestId(testIds.chatRowShare)).toBeNull()
    // The menu trigger has focus again: the Share dialog returns focus there when it closes.
    expect(document.activeElement).toBe(byTestId(testIds.chatRowMenu, rowItem(chatId(2))))
    expect(byTestId(testIds.chatRowRenameInput)).toBeNull()
    expect(allByTestId(testIds.chatRow).map(element => element.dataset.chatId)).toEqual([chatId(1), chatId(2)])
    expect(api.chats.update).not.toHaveBeenCalled()
  })

  it('exports as Markdown and JSON through the store, with a toast on failure', async () => {
    setup()
    await mountNav([chatSummary({ id: chatId(1), title: 'Export me', updatedAt: NOW - 1 })])
    const chats = useChatsStore()
    const exportChat = vi.spyOn(chats, 'exportChat').mockResolvedValue()

    await openRowMenu(chatId(1))
    await chooseMenuItem(testIds.chatRowExportMd)
    expect(exportChat).toHaveBeenLastCalledWith(chatId(1), 'md')

    exportChat.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Chat not found.' }))
    await openRowMenu(chatId(1))
    await chooseMenuItem(testIds.chatRowExportJson)
    expect(exportChat).toHaveBeenLastCalledWith(chatId(1), 'json')
    expect(mocks.toast.error).toHaveBeenCalledWith('Couldn\'t export the chat', { description: 'Chat not found.' })
  })
})

describe('chatNav: delete with undo', () => {
  async function deleteRow(id: string) {
    await openRowMenu(id)
    await chooseMenuItem(testIds.chatRowDelete)
  }

  function toastCall() {
    const [component, options] = mocks.toast.custom.mock.calls.at(-1)! as [object, { duration: number, componentProps: Record<string, unknown> }]
    return { component, options }
  }

  it('hides the row at once, and Undo inside the window restores it without a DELETE', async () => {
    setup()
    await mountNav([
      chatSummary({ id: chatId(1), title: 'First', updatedAt: NOW - 1 }),
      chatSummary({ id: chatId(2), title: 'Second', updatedAt: NOW - 2 }),
    ])
    await deleteRow(chatId(1))
    expect(allByTestId(testIds.chatRow).map(element => element.dataset.chatId)).toEqual([chatId(2)])
    const { component, options } = toastCall()
    expect(options.duration).toBe(Number.POSITIVE_INFINITY)
    expect(options.componentProps.title).toBe('Chat deleted')

    // The toast component, as vue-sonner renders it: its Undo button carries the toast-undo test id.
    const closeToast = vi.fn()
    const toastWrapper = mountStandalone(component, { ...options.componentProps, onCloseToast: closeToast })
    expect(toastWrapper.text()).toContain('Chat deleted')
    await toastWrapper.get(`[data-testid="${testIds.toastUndo}"]`).trigger('click')
    expect(closeToast).toHaveBeenCalledTimes(1)
    await settle()
    expect(allByTestId(testIds.chatRow).map(element => element.dataset.chatId)).toEqual([chatId(1), chatId(2)])

    await vi.advanceTimersByTimeAsync(CHAT_UNDO_MS + 1000)
    expect(api.chats.remove).not.toHaveBeenCalled()
    expect(mocks.toast.dismiss).toHaveBeenCalledWith('toast-1')
    toastWrapper.unmount()
  })

  it('sends the DELETE only when the undo window ends, then closes the toast', async () => {
    setup()
    await mountNav([chatSummary({ id: chatId(1), title: 'Doomed', updatedAt: NOW - 1 })])
    api.chats.remove.mockResolvedValue(undefined)
    await deleteRow(chatId(1))
    expect(allByTestId(testIds.chatRow)).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(CHAT_UNDO_MS - 100)
    expect(api.chats.remove).not.toHaveBeenCalled()
    expect(mocks.toast.dismiss).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(api.chats.remove).toHaveBeenCalledTimes(1)
    expect(api.chats.remove).toHaveBeenCalledWith({ params: { id: chatId(1) } })
    expect(mocks.toast.dismiss).toHaveBeenCalledWith('toast-1')
    expect(mocks.navigateTo).not.toHaveBeenCalled()
  })

  it('navigates to / when the open chat is deleted, and restores the row with a toast when the DELETE fails', async () => {
    setup()
    mocks.route = reactive({ path: `/chat/${chatId(1)}`, fullPath: `/chat/${chatId(1)}`, query: {} })
    await mountNav([chatSummary({ id: chatId(1), title: 'Open one', updatedAt: NOW - 1 })])
    api.chats.remove.mockRejectedValue(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    await deleteRow(chatId(1))
    expect(mocks.navigateTo).toHaveBeenCalledWith('/')

    await vi.advanceTimersByTimeAsync(CHAT_UNDO_MS)
    await settle()
    expect(mocks.toast.error).toHaveBeenCalledWith('Couldn\'t delete the chat', { description: 'Disk full.' })
    expect(allByTestId(testIds.chatRow).map(element => element.dataset.chatId)).toEqual([chatId(1)])
  })

  it('moves focus to the next row, else the previous row, else New chat', async () => {
    setup()
    await mountNav([
      chatSummary({ id: chatId(1), title: 'One', updatedAt: NOW - 1 }),
      chatSummary({ id: chatId(2), title: 'Two', updatedAt: NOW - 2 }),
    ])
    await deleteRow(chatId(1))
    expect(document.activeElement).toBe(row(chatId(2)))
    await deleteRow(chatId(2))
    expect(document.activeElement).toBe(byTestId(testIds.newChat))
  })
})

describe('chatNav: loading', () => {
  it('loads the first page on mount and the next page when the end of the list becomes visible', async () => {
    setup()
    await mountNav([chatSummary({ id: chatId(2), title: 'Newer', updatedAt: NOW - 1 })], 'cursor-1')
    expect(api.chats.list).toHaveBeenCalledTimes(1)
    expect(api.chats.list).toHaveBeenLastCalledWith({ query: { limit: 50 } })

    let resolvePage: (value: unknown) => void = () => {}
    api.chats.list.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePage = resolve
    }))
    FakeIntersectionObserver.report(true)
    await settle()
    expect(api.chats.list).toHaveBeenLastCalledWith({ query: { limit: 50, cursor: 'cursor-1' } })
    // Skeleton rows while the page loads.
    expect(byTestId(testIds.chatList)!.querySelectorAll('[data-sidebar="menu-skeleton"]').length).toBeGreaterThan(0)

    resolvePage({ items: [chatSummary({ id: chatId(1), title: 'Older', updatedAt: NOW - 2 })], nextCursor: null })
    await settle()
    expect(allByTestId(testIds.chatRow).map(element => element.textContent?.trim())).toEqual(['Newer', 'Older'])
    expect(byTestId(testIds.chatList)!.querySelectorAll('[data-sidebar="menu-skeleton"]').length).toBe(0)
    // Last page: the sentinel no longer loads anything.
    FakeIntersectionObserver.report(false)
    FakeIntersectionObserver.report(true)
    await settle()
    expect(api.chats.list).toHaveBeenCalledTimes(2)
  })

  it('shows "No chats yet" for an empty list', async () => {
    setup()
    await mountNav([])
    expect(byTestId(testIds.chatList)!.textContent).toContain('No chats yet')
  })

  it('shows skeleton rows before the first page, and a Retry after a failure', async () => {
    setup()
    api.chats.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Boom.' }))
    wrapper = mountInShell(ChatNav)
    expect(byTestId(testIds.chatList)!.querySelectorAll('[data-sidebar="menu-skeleton"]').length).toBe(8)
    await settle()
    const list = byTestId(testIds.chatList)!
    expect(list.textContent).toContain('Couldn\'t load chats')
    expect(list.textContent).not.toContain('No chats yet')
    // No automatic retry loop from the sentinel after a failure.
    FakeIntersectionObserver.report(true)
    await settle()
    expect(api.chats.list).toHaveBeenCalledTimes(1)

    api.chats.list.mockResolvedValueOnce({ items: [chatSummary({ id: chatId(1), title: 'Back', updatedAt: NOW - 1 })], nextCursor: null })
    const retry = Array.from(list.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Retry')!
    retry.click()
    await settle()
    expect(allByTestId(testIds.chatRow).map(element => element.textContent?.trim())).toEqual(['Back'])
    expect(list.textContent).not.toContain('Couldn\'t load chats')
  })
})

describe('chatNav: top rows', () => {
  it('opens the command palette from Search', async () => {
    setup()
    await mountNav([])
    byTestId(testIds.searchChats)!.click()
    expect(useUiStore().paletteOpen).toBe(true)
  })

  it('new chat goes to / and asks the composer for focus; modified clicks are left to the browser', async () => {
    setup()
    await mountNav([])
    const ui = useUiStore()
    const link = byTestId(testIds.newChat)!
    expect(link.getAttribute('href')).toBe('/')
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    await settle()
    expect(mocks.navigateTo).toHaveBeenCalledWith('/')
    expect(ui.composerFocusRequest).toBe(1)

    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true }))
    await settle()
    expect(mocks.navigateTo).toHaveBeenCalledTimes(1)
    expect(ui.composerFocusRequest).toBe(1)
  })
})
