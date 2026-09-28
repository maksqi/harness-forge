// ShareDialog (docs/UI.md 7.14, 8.4, 14.1): opening and closing through the ui store, the link cards (copy, options,
// expiry, update snapshot, revoke), the new-link form, the passwordless warning, fresh auth and errors.
import type { AuthStatus, ShareSummary } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError, LIMITS } from '@harness-forge/shared'
import { mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAuthStore } from '~/stores/auth'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'
import { authStatus } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { SNAPSHOT_TOO_LARGE_MESSAGE } from './share-links'
import ShareDialog from './ShareDialog.vue'
import { allByTestId, byTestId, CHAT_ID, OTHER_CHAT_ID, settle, shareId, shareSummary } from './testing'

const mocks = vi.hoisted(() => ({ api: null as unknown, writeText: null as unknown as ReturnType<typeof vi.fn> }))
// The stores reach the typed client through useApi ('#imports' does not resolve in Vitest).
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api, useApiFetch: () => vi.fn() }))

const DAY = 86_400_000

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | null = null

/** The dialog content renders in a portal under <body>. */
function dialog() {
  return byTestId(testIds.shareDialog)
}

function card(id: string): HTMLElement {
  const element = dialog()?.querySelector<HTMLElement>(`[data-testid="${testIds.shareLink}"][data-share-id="${id}"]`)
  expect(element, `card ${id}`).toBeTruthy()
  return element!
}

function cardIds(): string[] {
  return allByTestId(testIds.shareLink, dialog()!).map(element => element.dataset.shareId!)
}

function option(scope: ParentNode, value: string): HTMLButtonElement {
  return scope.querySelector<HTMLButtonElement>(`[data-testid="${testIds.shareOption}"][data-value="${value}"]`)!
}

function form(): HTMLElement {
  return byTestId(testIds.shareCreateForm, dialog()!)!
}

function press(target: Element, key: string) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

/** Opens an expiry select with the keyboard and picks `value`. */
async function chooseExpiry(scope: ParentNode, value: string) {
  press(byTestId(testIds.shareExpiry, scope)!, 'Enter')
  await settle()
  const item = document.body.querySelector(`[data-testid="${testIds.shareExpiryOption}"][data-value="${value}"]`)
  expect(item, `expiry option ${value}`).not.toBeNull()
  press(item!, 'Enter')
  await settle(5)
}

async function openFor(chatId: string, items: ShareSummary[] = []) {
  api.shares.list.mockResolvedValueOnce({ items, nextCursor: null })
  useUiStore().openShare(chatId)
  await settle()
}

function setAuth(status: AuthStatus) {
  useAuthStore().status = status
}

/** Types into the fresh-auth prompt and confirms. */
async function confirmPassword(password: string) {
  const input = byTestId<HTMLInputElement>(testIds.confirmPasswordInput)!
  input.value = password
  input.dispatchEvent(new Event('input'))
  await settle()
  byTestId<HTMLButtonElement>(testIds.confirmPasswordSubmit)!.click()
  await settle(5)
}

beforeEach(async () => {
  api = createMockApi()
  mocks.api = api
  mocks.writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: mocks.writeText }, configurable: true })
  pinia = createPinia()
  setActivePinia(pinia)
  setAuth(authStatus({ enabled: true, source: 'env', freshUntil: Date.now() + 5 * 60_000 }))
  wrapper = mount({ render: () => h(TooltipProvider, null, { default: () => h(ShareDialog) }) }, {
    attachTo: document.body,
    global: { plugins: [pinia] },
  })
  await settle()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  disposePinia(pinia)
  vi.useRealTimers()
})

describe('shareDialog: open and close', () => {
  it('stays closed until ui.openShare(chatId) and then shows that chat', async () => {
    expect(dialog()).toBeNull()
    await openFor(CHAT_ID)
    const content = dialog()!
    expect(content.getAttribute('role')).toBe('dialog')
    expect(content.dataset.chatId).toBe(CHAT_ID)
    expect(content.textContent).toContain('Share chat')
    expect(content.textContent).toContain('Anyone with a link can read a snapshot of this chat.')
    expect(api.shares.list).toHaveBeenCalledWith({ query: { chatId: CHAT_ID } })
  })

  it('closes with ui.closeShare() and clears ui.shareChatId when the user closes it', async () => {
    const ui = useUiStore()
    await openFor(CHAT_ID)
    ui.closeShare()
    await settle()
    expect(dialog()).toBeNull()

    await openFor(OTHER_CHAT_ID)
    expect(dialog()?.dataset.chatId).toBe(OTHER_CHAT_ID)
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    expect(ui.shareChatId).toBeNull()
    expect(dialog()).toBeNull()
  })

  it('returns focus to the control that opened it', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    await openFor(CHAT_ID)
    expect(document.activeElement).not.toBe(opener)
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(document.activeElement).toBe(opener)
  })
})

describe('shareDialog: links', () => {
  it('shows skeleton cards while loading, then one card per link with its URL, meta and badges', async () => {
    let resolve: (value: unknown) => void = () => {}
    api.shares.list.mockImplementationOnce(() => new Promise((done) => {
      resolve = done
    }))
    useUiStore().openShare(CHAT_ID)
    await settle()
    expect(dialog()!.querySelectorAll('[data-slot="skeleton"]').length).toBe(2)
    expect(byTestId(testIds.shareCreateForm, dialog()!)).toBeNull()

    const fresh = shareSummary({ id: shareId(2), messageCount: 1 })
    const stale = shareSummary({ id: shareId(1), outdated: true, expired: true, expiresAt: Date.now() - DAY, createdAt: Date.now() - DAY })
    // Newest first.
    resolve({ items: [stale, fresh], nextCursor: null })
    await settle()
    expect(cardIds()).toEqual([shareId(2), shareId(1)])

    const first = card(shareId(2))
    expect(first.dataset.outdated).toBe('false')
    expect(first.dataset.expired).toBe('false')
    expect(byTestId<HTMLInputElement>(testIds.shareUrl, first)!.value).toBe(`${window.location.origin}${fresh.path}`)
    expect(byTestId<HTMLInputElement>(testIds.shareUrl, first)!.readOnly).toBe(true)
    expect(first.textContent).toContain('1 message · snapshot 3h ago')
    expect(byTestId(testIds.shareExpiry, first)!.textContent).toContain('Never expires')
    expect(byTestId(testIds.shareOutdated, first)).toBeNull()

    const second = card(shareId(1))
    expect(second.dataset.outdated).toBe('true')
    expect(second.dataset.expired).toBe('true')
    expect(byTestId(testIds.shareOutdated, second)?.textContent?.trim()).toBe('Outdated')
    expect(byTestId(testIds.shareExpired, second)?.textContent?.trim()).toBe('Expired')
    expect(byTestId(testIds.shareExpiry, second)!.textContent).toContain('Expired')
    expect(second.textContent).toContain('Changes apply to the link at once.')
    // The switches show the link's options.
    expect(option(second, 'attachments').getAttribute('aria-checked')).toBe('true')
    expect(option(second, 'reasoning').getAttribute('aria-checked')).toBe('false')
    expect(option(second, 'tool-details').getAttribute('aria-checked')).toBe('false')
  })

  it('focuses the first card\'s Copy link, or Create link when the chat has no link', async () => {
    await openFor(CHAT_ID, [shareSummary()])
    expect(document.activeElement).toBe(byTestId(testIds.shareCopy, card(shareId(1))))
    useUiStore().closeShare()
    await settle()

    await openFor(CHAT_ID, [])
    expect(dialog()!.textContent).toContain('This chat has no links yet.')
    expect(document.activeElement).toBe(byTestId(testIds.shareCreate, dialog()!))
  })

  it('copies location.origin + path', async () => {
    const share = shareSummary()
    await openFor(CHAT_ID, [share])
    byTestId<HTMLButtonElement>(testIds.shareCopy, card(share.id))!.click()
    await settle()
    expect(mocks.writeText).toHaveBeenCalledWith(`${window.location.origin}${share.path}`)
    expect(byTestId(testIds.shareCopy, card(share.id))!.textContent).toContain('Copied')
  })

  it('sends only the changed option, disables the card meanwhile and shows the answer', async () => {
    const share = shareSummary()
    await openFor(CHAT_ID, [share])
    let resolve: (value: ShareSummary) => void = () => {}
    api.shares.update.mockImplementationOnce(() => new Promise((done) => {
      resolve = done
    }))

    option(card(share.id), 'tool-details').click()
    await settle()
    expect(api.shares.update).toHaveBeenCalledTimes(1)
    expect(api.shares.update).toHaveBeenCalledWith({ params: { id: share.id }, body: { options: { toolDetails: true } } })
    // Pending: the switch shows the new value and every control of the card is disabled.
    expect(option(card(share.id), 'tool-details').getAttribute('aria-checked')).toBe('true')
    expect(card(share.id).getAttribute('aria-busy')).toBe('true')
    expect(byTestId<HTMLButtonElement>(testIds.shareUpdate, card(share.id))!.disabled).toBe(true)
    expect(byTestId<HTMLButtonElement>(testIds.shareRevoke, card(share.id))!.disabled).toBe(true)
    expect(option(card(share.id), 'reasoning').disabled).toBe(true)

    resolve({ ...share, options: { ...share.options, toolDetails: true } })
    await settle()
    expect(card(share.id).getAttribute('aria-busy')).toBeNull()
    expect(option(card(share.id), 'tool-details').getAttribute('aria-checked')).toBe('true')
    expect(byTestId<HTMLButtonElement>(testIds.shareUpdate, card(share.id))!.disabled).toBe(false)
  })

  it('reverts an option change that failed and shows the error', async () => {
    const share = shareSummary()
    await openFor(CHAT_ID, [share])
    api.shares.update.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    option(card(share.id), 'reasoning').click()
    await settle()
    expect(option(card(share.id), 'reasoning').getAttribute('aria-checked')).toBe('false')
    const alert = byTestId(testIds.shareDialogError, dialog()!)!
    expect(alert.dataset.code).toBe('internal_error')
    expect(alert.textContent).toContain('Something went wrong')
    expect(alert.textContent).toContain('Disk full.')
  })

  it('sets the expiry from now, or removes it with Never', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 28, 12), toFake: ['Date'] })
    const share = shareSummary({ expiresAt: Date.now() + DAY })
    await openFor(CHAT_ID, [share])
    expect(byTestId(testIds.shareExpiry, card(share.id))!.textContent).toContain('Expires in 1 day')

    api.shares.update.mockResolvedValueOnce({ ...share, expiresAt: Date.now() + 30 * DAY })
    await chooseExpiry(card(share.id), '30d')
    expect(api.shares.update).toHaveBeenLastCalledWith({ params: { id: share.id }, body: { expiresAt: Date.now() + 30 * DAY } })
    expect(byTestId(testIds.shareExpiry, card(share.id))!.textContent).toContain('Expires in 30 days')

    api.shares.update.mockResolvedValueOnce({ ...share, expiresAt: null })
    await chooseExpiry(card(share.id), 'never')
    expect(api.shares.update).toHaveBeenLastCalledWith({ params: { id: share.id }, body: { expiresAt: null } })
    expect(byTestId(testIds.shareExpiry, card(share.id))!.textContent).toContain('Never expires')
  })

  it('updates the snapshot with refresh: true and replaces the card', async () => {
    const share = shareSummary({ outdated: true, messageCount: 4 })
    await openFor(CHAT_ID, [share])
    api.shares.update.mockResolvedValueOnce({ ...share, outdated: false, messageCount: 6, snapshotAt: Date.now() })
    byTestId<HTMLButtonElement>(testIds.shareUpdate, card(share.id))!.click()
    await settle()
    expect(api.shares.update).toHaveBeenCalledWith({ params: { id: share.id }, body: { refresh: true } })
    expect(card(share.id).dataset.outdated).toBe('false')
    expect(byTestId(testIds.shareOutdated, card(share.id))).toBeNull()
    expect(card(share.id).textContent).toContain('6 messages · snapshot just now')
    // The link never changes.
    expect(byTestId<HTMLInputElement>(testIds.shareUrl, card(share.id))!.value).toBe(`${window.location.origin}${share.path}`)
  })

  it('revokes a link after the confirmation, and not when cancelled', async () => {
    const first = shareSummary({ id: shareId(2), createdAt: Date.now() })
    const second = shareSummary({ id: shareId(1), createdAt: Date.now() - DAY })
    await openFor(CHAT_ID, [first, second])

    byTestId<HTMLButtonElement>(testIds.shareRevoke, card(first.id))!.click()
    await settle()
    expect(document.body.textContent).toContain('Revoke this link?')
    expect(document.body.textContent).toContain('People with the link can no longer open it. This can\'t be undone.')
    document.body.querySelector('[role="alertdialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    expect(api.shares.remove).not.toHaveBeenCalled()
    expect(cardIds()).toEqual([first.id, second.id])

    api.shares.remove.mockResolvedValueOnce(undefined)
    byTestId<HTMLButtonElement>(testIds.shareRevoke, card(first.id))!.click()
    await settle()
    const confirm = byTestId<HTMLButtonElement>(testIds.shareRevokeConfirm)!
    expect(confirm.textContent).toContain('Revoke')
    confirm.click()
    await settle()
    expect(api.shares.remove).toHaveBeenCalledWith({ params: { id: first.id } })
    expect(cardIds()).toEqual([second.id])
    expect(document.activeElement).toBe(byTestId(testIds.shareCopy, card(second.id)))
  })
})

describe('shareDialog: new link', () => {
  it('creates a link with the chosen options and expiry; the new card goes on top with its URL selected', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 28, 12), toFake: ['Date'] })
    const existing = shareSummary({ id: shareId(1) })
    await openFor(CHAT_ID, [existing])
    // Defaults: attachments on, reasoning and tool details off, never expires.
    expect(['attachments', 'reasoning', 'tool-details'].map(value => option(form(), value).getAttribute('aria-checked')))
      .toEqual(['true', 'false', 'false'])
    expect(byTestId(testIds.shareExpiry, form())!.textContent).toContain('Never expires')

    option(form(), 'reasoning').click()
    option(form(), 'attachments').click()
    await chooseExpiry(form(), '7d')
    expect(byTestId(testIds.shareExpiry, form())!.textContent).toContain('Expires in 7 days')
    expect(api.shares.update).not.toHaveBeenCalled()

    const created = shareSummary({ id: shareId(2), options: { attachments: false, reasoning: true, toolDetails: false }, expiresAt: Date.now() + 7 * DAY })
    api.shares.create.mockResolvedValueOnce(created)
    byTestId<HTMLButtonElement>(testIds.shareCreate, form())!.click()
    await settle()
    expect(api.shares.create).toHaveBeenCalledWith({
      body: {
        chatId: CHAT_ID,
        options: { attachments: false, reasoning: true, toolDetails: false },
        expiresAt: Date.now() + 7 * DAY,
      },
    })
    expect(cardIds()).toEqual([created.id, existing.id])
    const url = byTestId<HTMLInputElement>(testIds.shareUrl, card(created.id))!
    expect(document.activeElement).toBe(url)
    expect(url.selectionStart).toBe(0)
    expect(url.selectionEnd).toBe(url.value.length)
  })

  it('sends expiresAt: null for a link that never expires', async () => {
    await openFor(CHAT_ID, [])
    api.shares.create.mockResolvedValueOnce(shareSummary())
    byTestId<HTMLButtonElement>(testIds.shareCreate, form())!.click()
    await settle()
    expect(api.shares.create).toHaveBeenCalledWith({
      body: { chatId: CHAT_ID, options: { attachments: true, reasoning: false, toolDetails: false }, expiresAt: null },
    })
  })

  it('disables Create link at the per-chat limit', async () => {
    const items = Array.from({ length: LIMITS.sharesPerChatMax }, (_, index) => shareSummary({ id: shareId(index + 1) }))
    await openFor(CHAT_ID, items)
    const create = byTestId<HTMLButtonElement>(testIds.shareCreate, form())!
    expect(create.disabled).toBe(true)
    expect(form().textContent).toContain('A chat can have up to 20 links.')
    expect(document.getElementById(create.getAttribute('aria-describedby')!)?.textContent).toContain('up to 20 links')
  })

  it('shows a snapshot over 10 MB with its own message', async () => {
    await openFor(CHAT_ID, [])
    api.shares.create.mockRejectedValueOnce(new HarnessError({ code: 'payload_too_large', message: 'Snapshot too large.', details: { limitBytes: 10_485_760 } }))
    byTestId<HTMLButtonElement>(testIds.shareCreate, form())!.click()
    await settle()
    const alert = byTestId(testIds.shareDialogError, dialog()!)!
    expect(alert.dataset.code).toBe('payload_too_large')
    expect(alert.textContent).toContain(SNAPSHOT_TOO_LARGE_MESSAGE)
    expect(cardIds()).toEqual([])
  })
})

describe('shareDialog: passwordless warning and fresh auth', () => {
  it('warns when no password is set, and not otherwise', async () => {
    setAuth(authStatus({ enabled: false }))
    await openFor(CHAT_ID)
    const warning = byTestId(testIds.sharePasswordlessWarning, dialog()!)!
    expect(warning.textContent).toContain('No password set')
    expect(warning.textContent).toContain('Set HF_PASSWORD before exposing the server.')

    setAuth(authStatus({ enabled: true, source: 'env', freshUntil: null }))
    await settle()
    expect(byTestId(testIds.sharePasswordlessWarning, dialog()!)).toBeNull()
  })

  it('asks for the password first when the session is not fresh, then creates the link', async () => {
    setAuth(authStatus({ enabled: true, source: 'env', freshUntil: null }))
    await openFor(CHAT_ID, [])
    api.auth.login.mockResolvedValueOnce(authStatus({ enabled: true, source: 'env', freshUntil: Date.now() + 10 * 60_000 }))
    api.shares.create.mockResolvedValueOnce(shareSummary())

    byTestId<HTMLButtonElement>(testIds.shareCreate, form())!.click()
    await settle()
    expect(byTestId(testIds.confirmPasswordDialog)).not.toBeNull()
    expect(api.shares.create).not.toHaveBeenCalled()

    await confirmPassword('correct horse')
    expect(api.auth.login).toHaveBeenCalledWith({ body: { password: 'correct horse' } })
    expect(byTestId(testIds.confirmPasswordDialog)).toBeNull()
    expect(api.shares.create).toHaveBeenCalledTimes(1)
    expect(cardIds()).toEqual([shareId(1)])
  })

  it('prompts after a 403 login answer and retries once', async () => {
    const share = shareSummary()
    await openFor(CHAT_ID, [share])
    api.shares.update
      .mockRejectedValueOnce(new HarnessError({ code: 'forbidden', message: 'Confirm your password.', action: 'login' }))
      .mockResolvedValueOnce({ ...share, outdated: false })
    api.auth.login.mockResolvedValueOnce(authStatus({ enabled: true, source: 'env', freshUntil: Date.now() + 10 * 60_000 }))

    byTestId<HTMLButtonElement>(testIds.shareUpdate, card(share.id))!.click()
    await settle()
    expect(byTestId(testIds.confirmPasswordDialog)).not.toBeNull()
    expect(byTestId(testIds.shareDialogError, dialog()!)).toBeNull()

    await confirmPassword('secret')
    expect(api.shares.update).toHaveBeenCalledTimes(2)
    expect(api.shares.update).toHaveBeenLastCalledWith({ params: { id: share.id }, body: { refresh: true } })
    expect(byTestId(testIds.shareDialogError, dialog()!)).toBeNull()
  })

  it('shows "Wrong password" in the prompt and cancels quietly when it is closed', async () => {
    setAuth(authStatus({ enabled: true, source: 'env', freshUntil: null }))
    const share = shareSummary()
    await openFor(CHAT_ID, [share])
    api.auth.login.mockRejectedValueOnce(new HarnessError({ code: 'unauthorized', message: 'Invalid password', action: 'login' }))

    option(card(share.id), 'reasoning').click()
    await settle()
    await confirmPassword('nope')
    const prompt = byTestId(testIds.confirmPasswordDialog)!
    expect(prompt.textContent).toContain('Wrong password')

    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    expect(byTestId(testIds.confirmPasswordDialog)).toBeNull()
    expect(api.shares.update).not.toHaveBeenCalled()
    expect(byTestId(testIds.shareDialogError, dialog()!)).toBeNull()
    // Cancelled: the switch is back and the card usable again.
    expect(option(card(share.id), 'reasoning').getAttribute('aria-checked')).toBe('false')
    expect(option(card(share.id), 'reasoning').disabled).toBe(false)
  })

  it('does not ask for the password to revoke', async () => {
    setAuth(authStatus({ enabled: true, source: 'env', freshUntil: null }))
    const share = shareSummary()
    await openFor(CHAT_ID, [share])
    api.shares.remove.mockResolvedValueOnce(undefined)
    byTestId<HTMLButtonElement>(testIds.shareRevoke, card(share.id))!.click()
    await settle()
    byTestId<HTMLButtonElement>(testIds.shareRevokeConfirm)!.click()
    await settle()
    expect(byTestId(testIds.confirmPasswordDialog)).toBeNull()
    expect(api.shares.remove).toHaveBeenCalledWith({ params: { id: share.id } })
    expect(cardIds()).toEqual([])
    expect(document.activeElement).toBe(byTestId(testIds.shareCreate, dialog()!))
  })
})

describe('shareDialog: failures', () => {
  it('shows a failed list with Try again', async () => {
    api.shares.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Database locked.' }))
    useUiStore().openShare(CHAT_ID)
    await settle()
    const alert = byTestId(testIds.shareDialogError, dialog()!)!
    expect(alert.textContent).toContain('Database locked.')
    expect(byTestId(testIds.shareCreateForm, dialog()!)).toBeNull()

    api.shares.list.mockResolvedValueOnce({ items: [shareSummary()], nextCursor: null })
    Array.from(alert.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Try again')!.click()
    await settle()
    expect(byTestId(testIds.shareDialogError, dialog()!)).toBeNull()
    expect(cardIds()).toEqual([shareId(1)])
    expect(api.shares.list).toHaveBeenCalledTimes(2)
  })

  it('drops a card whose link is gone (404) and says why', async () => {
    const share = shareSummary()
    await openFor(CHAT_ID, [share])
    api.shares.update.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Share link not found.' }))
    byTestId<HTMLButtonElement>(testIds.shareUpdate, card(share.id))!.click()
    await settle()
    expect(cardIds()).toEqual([])
    expect(byTestId(testIds.shareDialogError, dialog()!)?.dataset.code).toBe('not_found')
  })

  it('ignores answers that arrive after the dialog switched to another chat', async () => {
    let resolve: (value: unknown) => void = () => {}
    api.shares.list.mockImplementationOnce(() => new Promise((done) => {
      resolve = done
    }))
    useUiStore().openShare(CHAT_ID)
    await settle()
    await openFor(OTHER_CHAT_ID, [shareSummary({ id: shareId(9), chatId: OTHER_CHAT_ID })])
    resolve({ items: [shareSummary({ id: shareId(1) })], nextCursor: null })
    await settle()
    expect(dialog()?.dataset.chatId).toBe(OTHER_CHAT_ID)
    expect(cardIds()).toEqual([shareId(9)])
  })
})
