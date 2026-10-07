// MarketplaceAddDialog (Phase 12, ADR-054; docs/UI.md 8.13, 10.9, 14.1; W12.8-T4): the source toggle that follows the
// input, the input check, the add with its toast and events, the server errors by code / reason, Mod+Enter.
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { toast } from 'vue-sonner'
import { testIds } from '~/utils/testids'
import { marketplaceDetail, marketplaceList } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { byTestId, mountInShell, settle } from '../list/testing'
import MarketplaceAddDialog from './MarketplaceAddDialog.vue'
import { MARKETPLACE_INPUT_ERROR } from './marketplaces'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let unmount: (() => void) | null = null

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  vi.mocked(toast.success).mockClear()
})

afterEach(() => {
  unmount?.()
  unmount = null
  document.body.replaceChildren()
  disposePinia(pinia)
})

async function render(props: Record<string, unknown> = {}) {
  const wrapper = mountInShell(MarketplaceAddDialog, { open: true, ...props })
  unmount = () => wrapper.unmount()
  await settle()
  return wrapper
}

function input(): HTMLInputElement {
  return byTestId<HTMLInputElement>(testIds.marketplaceAddInput)!
}

async function type(text: string): Promise<void> {
  input().value = text
  input().dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}

function sourceKind(): string | undefined {
  return byTestId(testIds.marketplaceAddSource)?.dataset.value
}

function submit(): HTMLButtonElement {
  return byTestId<HTMLButtonElement>(testIds.marketplaceAddSubmit)!
}

describe('marketplaceAddDialog', () => {
  it('opens on the input with the GitHub placeholder and Add disabled while empty', async () => {
    await render()
    expect(byTestId(testIds.marketplaceAddDialog)?.textContent).toContain('Add marketplace')
    expect(document.activeElement).toBe(input())
    expect(sourceKind()).toBe('github')
    expect(input().placeholder).toBe('owner/repo#ref')
    expect(document.querySelector(`label[for="${input().id}"]`)?.textContent).toBe('GitHub repository, marketplace.json URL or a folder on this server')
    expect(submit().disabled).toBe(true)
  })

  it('switches the toggle to the kind the text names, and the placeholder to the picked kind', async () => {
    await render()
    const items = Array.from(byTestId(testIds.marketplaceAddSource)!.querySelectorAll<HTMLButtonElement>('[data-slot="toggle-group-item"]'))
    expect(items.map(item => item.textContent?.trim())).toEqual(['GitHub', 'URL', 'Folder on this server'])
    items[2]!.click()
    await settle()
    expect(sourceKind()).toBe('folder')
    expect(input().placeholder).toBe('/srv/marketplaces/acme')
    await type('https://example.com/m/marketplace.json')
    expect(sourceKind()).toBe('url')
    await type('acme/tools#v2')
    expect(sourceKind()).toBe('github')
    await type('/srv/marketplaces/acme')
    expect(sourceKind()).toBe('folder')
  })

  it('refuses an unusable value under the input without a request', async () => {
    await render()
    await type('http://example.com/marketplace.json')
    submit().click()
    await settle()
    const error = byTestId(testIds.marketplaceAddError)!
    expect(error.textContent?.trim()).toBe(MARKETPLACE_INPUT_ERROR)
    expect(error.dataset.code).toBe('validation_error')
    expect(input().getAttribute('aria-invalid')).toBe('true')
    expect(input().getAttribute('aria-describedby')).toBe(error.id)
    expect(api.marketplaces.add).not.toHaveBeenCalled()
    // Typing clears the error.
    await type('acme/tools')
    expect(byTestId(testIds.marketplaceAddError)).toBeNull()
  })

  it('adds what the input names, toasts "Added {name}", emits added and closes', async () => {
    const added = vi.fn()
    const update = vi.fn()
    api.marketplaces.list.mockResolvedValue(marketplaceList({ items: [] }))
    api.marketplaces.add.mockResolvedValue(marketplaceDetail({ name: 'team-tools' }))
    await render({ 'onAdded': added, 'onUpdate:open': update })
    await type('https://github.com/acme/team-tools')
    submit().click()
    await settle()
    expect(api.marketplaces.add).toHaveBeenCalledWith({ body: { source: { type: 'github', repo: 'acme/team-tools' } } })
    expect(toast.success).toHaveBeenCalledWith('Added team-tools')
    expect(added).toHaveBeenCalledWith(expect.objectContaining({ name: 'team-tools' }))
    expect(update).toHaveBeenCalledWith(false)
  })

  it.each([
    [new HarnessError({ code: 'conflict', message: 'A marketplace named acme is already added.', details: { reason: 'exists' } }), 'conflict', 'exists', 'A marketplace named acme is already added.'],
    [new HarnessError({ code: 'conflict', message: 'harness-forge is offline (HF_OFFLINE=1).', details: { reason: 'offline' } }), 'conflict', 'offline', 'harness-forge is offline (HF_OFFLINE=1).'],
    [new HarnessError({ code: 'not_found', message: 'No .claude-plugin/marketplace.json in acme/tools.' }), 'not_found', undefined, 'No .claude-plugin/marketplace.json in acme/tools.'],
    [new HarnessError({ code: 'rate_limited', message: 'GitHub rate limit reached.', retryAfterMs: 600_000 }), 'rate_limited', undefined, 'GitHub rate limit reached. Try again in 10 min'],
    [new HarnessError({ code: 'provider_unreachable', message: 'GitHub could not be reached.' }), 'provider_unreachable', undefined, 'GitHub could not be reached.'],
    [new HarnessError({ code: 'validation_error', message: 'The name claude-plugins-official is reserved for anthropics/* repositories.', details: { issues: [{ path: ['source'], message: 'reserved' }] } }), 'validation_error', undefined, 'The name claude-plugins-official is reserved for anthropics/* repositories.'],
  ])('shows a failed add (%#) with its code and reason and keeps the dialog open', async (failure, code, reason, text) => {
    const update = vi.fn()
    api.marketplaces.add.mockRejectedValue(failure)
    await render({ 'onUpdate:open': update })
    await type('acme/tools')
    submit().click()
    await settle()
    const error = byTestId(testIds.marketplaceAddError)!
    expect(error.dataset.code).toBe(code)
    expect(error.dataset.reason).toBe(reason)
    expect(error.textContent?.trim()).toBe(text)
    expect(error.getAttribute('role')).toBe('alert')
    expect(update).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input())
  })

  it('adds with Mod+Enter from anywhere in the dialog, once while it runs', async () => {
    let release: (value: unknown) => void = () => {}
    api.marketplaces.add.mockReturnValue(new Promise((resolve) => {
      release = resolve
    }))
    await render()
    await type('/srv/marketplaces/acme')
    const toggle = byTestId(testIds.marketplaceAddSource)!
    toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
    toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
    await settle()
    expect(api.marketplaces.add).toHaveBeenCalledTimes(1)
    expect(api.marketplaces.add).toHaveBeenCalledWith({ body: { source: { type: 'path', path: '/srv/marketplaces/acme' } } })
    expect(submit().getAttribute('aria-busy')).toBe('true')
    expect(input().disabled).toBe(true)
    release(marketplaceDetail({ source: { type: 'path', path: '/srv/marketplaces/acme' }, resolvedRef: null }))
    await settle()
    expect(toast.success).toHaveBeenCalledWith('Added claude-plugins-official')
  })

  it('clears the input and the error when it opens again', async () => {
    api.marketplaces.add.mockRejectedValue(new HarnessError({ code: 'not_found', message: 'Nope.' }))
    const open = ref(true)
    const Host = defineComponent({
      setup: () => () => h(MarketplaceAddDialog, { 'open': open.value, 'onUpdate:open': (value: boolean) => (open.value = value) }),
    })
    const wrapper = mountInShell(Host)
    unmount = () => wrapper.unmount()
    await settle()
    await type('acme/tools')
    submit().click()
    await settle()
    expect(byTestId(testIds.marketplaceAddError)).not.toBeNull()
    open.value = false
    await settle()
    open.value = true
    await settle()
    expect(input().value).toBe('')
    expect(byTestId(testIds.marketplaceAddError)).toBeNull()
    expect(sourceKind()).toBe('github')
  })
})
