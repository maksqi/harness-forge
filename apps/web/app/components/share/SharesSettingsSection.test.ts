// SharesSettingsSection (docs/UI.md 9.8): every share link in Settings -> Data, with copy, manage and revoke.
import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NuxtLinkStub } from '~/components/app-shell/chat-nav/testing'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'
import { createMockApi } from '~/utils/testing/mock-api'
import SharesSettingsSection from './SharesSettingsSection.vue'
import { allByTestId, byTestId, CHAT_ID, OTHER_CHAT_ID, settle, shareId, shareSummary } from './testing'

const mocks = vi.hoisted(() => ({ api: null as unknown, writeText: null as unknown as ReturnType<typeof vi.fn> }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api, useApiFetch: () => vi.fn() }))

const DAY = 86_400_000

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | null = null

async function mountSection(items = [shareSummary()]) {
  api.shares.list.mockResolvedValueOnce({ items, nextCursor: null })
  wrapper = mount({ render: () => h(TooltipProvider, null, { default: () => h(SharesSettingsSection) }) }, {
    attachTo: document.body,
    global: { plugins: [pinia], stubs: { NuxtLink: NuxtLinkStub } },
  })
  await settle()
}

function section(): HTMLElement {
  return byTestId(testIds.sharesSection)!
}

function row(id: string): HTMLElement {
  const element = section().querySelector<HTMLElement>(`[data-testid="${testIds.sharesRow}"][data-share-id="${id}"]`)
  expect(element, `row ${id}`).toBeTruthy()
  return element!
}

function rowIds(): string[] {
  return allByTestId(testIds.sharesRow, section()).map(element => element.dataset.shareId!)
}

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: mocks.writeText }, configurable: true })
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  disposePinia(pinia)
})

describe('sharesSettingsSection', () => {
  it('lists every share link, newest first, as a "Shared links" section', async () => {
    const older = shareSummary({ id: shareId(1), chatTitle: 'Old chat', createdAt: Date.now() - 2 * DAY, outdated: true })
    const newer = shareSummary({
      id: shareId(2),
      chatId: OTHER_CHAT_ID,
      chatTitle: null,
      messageCount: 1,
      expiresAt: Date.now() + 5 * DAY + 60_000,
      createdAt: Date.now() - DAY,
    })
    await mountSection([older, newer])
    expect(api.shares.list).toHaveBeenCalledTimes(1)
    expect(api.shares.list).toHaveBeenCalledWith()
    expect(section().tagName).toBe('SECTION')
    expect(section().querySelector('h2')?.textContent?.trim()).toBe('Shared links')
    expect(rowIds()).toEqual([shareId(2), shareId(1)])

    const first = row(shareId(2))
    expect(first.dataset.chatId).toBe(OTHER_CHAT_ID)
    const link = first.querySelector('a')!
    expect(link.getAttribute('href')).toBe(`/chat/${OTHER_CHAT_ID}`)
    expect(link.textContent?.trim()).toBe('Untitled chat')
    expect(first.textContent).toContain('1 message · snapshot 3h ago')
    expect(first.textContent).toContain('Expires in 5 days')
    expect(byTestId(testIds.shareOutdated, first)).toBeNull()

    const second = row(shareId(1))
    expect(second.dataset.chatId).toBe(CHAT_ID)
    expect(second.querySelector('a')?.textContent?.trim()).toBe('Old chat')
    expect(byTestId(testIds.shareOutdated, second)?.textContent?.trim()).toBe('Outdated')
    expect(second.textContent).not.toContain('Expires')
  })

  it('shows the Expired badge instead of the expiry', async () => {
    await mountSection([shareSummary({ expired: true, expiresAt: Date.now() - DAY })])
    const only = row(shareId(1))
    expect(byTestId(testIds.shareExpired, only)?.textContent?.trim()).toBe('Expired')
    expect(only.textContent).not.toContain('Expires in')
  })

  it('says "No shared links." when there are none', async () => {
    await mountSection([])
    expect(byTestId(testIds.sharesEmpty, section())?.textContent?.trim()).toBe('No shared links.')
    expect(rowIds()).toEqual([])
  })

  it('copies the absolute link and opens the Share dialog of the chat with Manage…', async () => {
    const share = shareSummary({ chatId: OTHER_CHAT_ID })
    await mountSection([share])
    byTestId<HTMLButtonElement>(testIds.shareCopy, row(share.id))!.click()
    await settle()
    expect(mocks.writeText).toHaveBeenCalledWith(`${window.location.origin}${share.path}`)

    byTestId<HTMLButtonElement>(testIds.sharesRowManage, row(share.id))!.click()
    expect(useUiStore().shareChatId).toBe(OTHER_CHAT_ID)
  })

  it('reloads when the Share dialog closes', async () => {
    await mountSection([shareSummary()])
    const ui = useUiStore()
    ui.openShare(CHAT_ID)
    await settle()
    expect(api.shares.list).toHaveBeenCalledTimes(1)

    api.shares.list.mockResolvedValueOnce({ items: [shareSummary(), shareSummary({ id: shareId(2), createdAt: Date.now() })], nextCursor: null })
    ui.closeShare()
    await settle()
    expect(api.shares.list).toHaveBeenCalledTimes(2)
    expect(rowIds()).toEqual([shareId(2), shareId(1)])
  })

  it('revokes after the confirmation, then reloads; cancelling does nothing', async () => {
    const first = shareSummary({ id: shareId(2), createdAt: Date.now() })
    const second = shareSummary({ id: shareId(1) })
    await mountSection([first, second])

    byTestId<HTMLButtonElement>(testIds.shareRevoke, row(first.id))!.click()
    await settle()
    expect(document.body.textContent).toContain('Revoke this link?')
    document.body.querySelector('[role="alertdialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    expect(api.shares.remove).not.toHaveBeenCalled()

    api.shares.remove.mockResolvedValueOnce(undefined)
    api.shares.list.mockResolvedValueOnce({ items: [second], nextCursor: null })
    byTestId<HTMLButtonElement>(testIds.shareRevoke, row(first.id))!.click()
    await settle()
    byTestId<HTMLButtonElement>(testIds.shareRevokeConfirm)!.click()
    await settle()
    expect(api.shares.remove).toHaveBeenCalledWith({ params: { id: first.id } })
    expect(api.shares.list).toHaveBeenCalledTimes(2)
    expect(rowIds()).toEqual([second.id])
    expect(document.activeElement).toBe(byTestId(testIds.shareCopy, row(second.id)))
  })

  it('keeps the row and shows the error when a revoke fails', async () => {
    const share = shareSummary()
    await mountSection([share])
    api.shares.remove.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    api.shares.list.mockResolvedValueOnce({ items: [share], nextCursor: null })
    byTestId<HTMLButtonElement>(testIds.shareRevoke, row(share.id))!.click()
    await settle()
    byTestId<HTMLButtonElement>(testIds.shareRevokeConfirm)!.click()
    await settle()
    expect(rowIds()).toEqual([share.id])
    const alert = section().querySelector<HTMLElement>('[role="alert"]')!
    expect(alert.dataset.code).toBe('internal_error')
    expect(alert.textContent).toContain('Disk full.')
  })

  it('shows a failed load with Try again', async () => {
    api.shares.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Database locked.' }))
    wrapper = mount({ render: () => h(TooltipProvider, null, { default: () => h(SharesSettingsSection) }) }, {
      attachTo: document.body,
      global: { plugins: [pinia], stubs: { NuxtLink: NuxtLinkStub } },
    })
    await settle()
    const alert = section().querySelector<HTMLElement>('[role="alert"]')!
    expect(alert.textContent).toContain('Couldn\'t load the shared links')
    expect(alert.textContent).toContain('Database locked.')
    expect(byTestId(testIds.sharesEmpty, section())).toBeNull()

    api.shares.list.mockResolvedValueOnce({ items: [], nextCursor: null })
    Array.from(alert.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Try again')!.click()
    await settle()
    expect(section().querySelector('[role="alert"]')).toBeNull()
    expect(byTestId(testIds.sharesEmpty, section())).not.toBeNull()
  })
})
