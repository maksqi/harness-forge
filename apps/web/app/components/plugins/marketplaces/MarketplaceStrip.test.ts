// MarketplaceStrip (Phase 12, ADR-054; docs/UI.md 8.13, 10.9, 14.1, 14.2; W12.8-T2): the chips with counts, update
// counts, error and busy states and their names, the arrow keys, the row menu, and the Select below `sm`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testIds } from '~/utils/testids'
import { marketplaceId, marketplaceSummary } from '~/utils/testing/fixtures'
import { allByTestId, byTestId, mountInShell, openWithKeyboard, settle } from '../list/testing'
import MarketplaceStrip from './MarketplaceStrip.vue'

let unmount: (() => void) | null = null
let wide = true

/** A matchMedia whose `(min-width: 640px)` answer the test controls. */
function stubViewport(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(min-width: 640px)' ? wide : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}

beforeEach(() => {
  wide = true
  stubViewport()
})

afterEach(() => {
  unmount?.()
  unmount = null
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

const ITEMS = [
  marketplaceSummary({ plugins: 14, updates: 2 }),
  marketplaceSummary({ id: marketplaceId(2), name: 'acme', plugins: 6, lastError: { code: 'provider_unreachable', message: 'Down' } }),
  marketplaceSummary({ id: marketplaceId(3), name: 'team-tools', plugins: 1 }),
]

async function render(props: Record<string, unknown> = {}) {
  const wrapper = mountInShell(MarketplaceStrip, { items: ITEMS, selectedId: null, ...props })
  unmount = () => wrapper.unmount()
  await settle()
  return wrapper
}

describe('marketplaceStrip: chips', () => {
  it('renders All with the total and one chip per marketplace with counts, states and names', async () => {
    await render({ busyIds: [marketplaceId(3)] })
    const group = document.querySelector('[role="group"][aria-label="Marketplace"]')
    expect(group).not.toBeNull()
    const rows = allByTestId(testIds.marketplaceRow)
    expect(rows.map(row => [row.dataset.marketplaceId, row.dataset.state])).toEqual([
      ['', 'ok'],
      [marketplaceId(1), 'ok'],
      [marketplaceId(2), 'error'],
      [marketplaceId(3), 'ok'],
    ])
    expect(rows[0]!.textContent?.replace(/\s+/g, ' ').trim()).toBe('All 21')
    expect(Array.from(rows[1]!.querySelectorAll(':scope > span')).map(span => span.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'claude-plugins-official',
      '14',
      '· 2 updates',
    ])
    expect(rows[2]!.querySelector('.text-warning')).not.toBeNull()
    expect(rows.slice(1).map(row => row.getAttribute('aria-label'))).toEqual([
      'claude-plugins-official, 14 plugins, 2 updates',
      'acme, 6 plugins, last refresh failed',
      'team-tools, 1 plugin',
    ])
    expect(rows[3]!.getAttribute('aria-busy')).toBe('true')
    expect(rows[1]!.getAttribute('aria-busy')).toBeNull()
    // All is selected: pressed and the only tab stop; no row menu without a marketplace.
    expect(rows.map(row => row.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false'])
    expect(rows.map(row => row.tabIndex)).toEqual([0, -1, -1, -1])
    expect(byTestId(testIds.marketplaceRowMenu)).toBeNull()
  })

  it('emits select for another chip only, and keeps the focus on the clicked chip', async () => {
    const select = vi.fn()
    await render({ selectedId: marketplaceId(1), onSelect: select })
    const rows = allByTestId(testIds.marketplaceRow)
    expect(rows.map(row => row.tabIndex)).toEqual([-1, 0, -1, -1])
    rows[1]!.click()
    expect(select).not.toHaveBeenCalled()
    rows[0]!.focus()
    rows[0]!.click()
    expect(select).toHaveBeenCalledWith(null)
    expect(document.activeElement).toBe(rows[0])
    rows[2]!.click()
    expect(select).toHaveBeenLastCalledWith(marketplaceId(2))
  })

  it('moves the focus between the chips with the arrow keys, Home and End (wrapping)', async () => {
    await render()
    const rows = allByTestId(testIds.marketplaceRow)
    const key = (target: HTMLElement, name: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
    rows[0]!.focus()
    key(rows[0]!, 'ArrowRight')
    expect(document.activeElement).toBe(rows[1])
    key(rows[1]!, 'End')
    expect(document.activeElement).toBe(rows[3])
    key(rows[3]!, 'ArrowRight')
    expect(document.activeElement).toBe(rows[0])
    key(rows[0]!, 'ArrowLeft')
    expect(document.activeElement).toBe(rows[3])
    key(rows[3]!, 'Home')
    expect(document.activeElement).toBe(rows[0])
  })

  it('offers Refresh and Remove… for the selected marketplace', async () => {
    const refresh = vi.fn()
    const remove = vi.fn()
    await render({ selectedId: marketplaceId(2), onRefresh: refresh, onRemove: remove })
    const trigger = byTestId(testIds.marketplaceRowMenu)!
    expect(trigger.getAttribute('aria-label')).toBe('Actions for acme')
    await openWithKeyboard(trigger)
    byTestId(testIds.marketplaceRefresh)!.click()
    await settle()
    expect(refresh).toHaveBeenCalledWith(marketplaceId(2))
    await openWithKeyboard(byTestId(testIds.marketplaceRowMenu)!)
    expect(byTestId(testIds.marketplaceRemove)!.textContent).toContain('Remove…')
    byTestId(testIds.marketplaceRemove)!.click()
    await settle()
    expect(remove).toHaveBeenCalledWith(marketplaceId(2))
  })
})

describe('marketplaceStrip: below sm', () => {
  it('replaces the chips with a Select named "Marketplace" and emits the pick', async () => {
    wide = false
    stubViewport()
    const select = vi.fn()
    await render({ selectedId: marketplaceId(1), onSelect: select })
    expect(allByTestId(testIds.marketplaceRow)).toEqual([])
    const trigger = document.querySelector<HTMLElement>('[data-slot="marketplace-select"]')!
    expect(trigger.getAttribute('aria-label')).toBe('Marketplace')
    expect(trigger.textContent).toContain('claude-plugins-official 14 · 2 updates')
    // W12.19: 40 px tall (the SelectTrigger's own `data-[size=default]:h-9` is replaced, a plain `h-10` would lose to it).
    const classes = trigger.className.split(/\s+/)
    expect(classes).toContain('data-[size=default]:h-10')
    expect(classes).not.toContain('data-[size=default]:h-9')
    // The row menu stays next to the Select.
    expect(byTestId(testIds.marketplaceRowMenu)).not.toBeNull()
    await openWithKeyboard(trigger)
    const options = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="select-item"]'))
    expect(options.map(option => option.dataset.marketplaceId)).toEqual(['', marketplaceId(1), marketplaceId(2), marketplaceId(3)])
    options[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()
    expect(select).toHaveBeenCalledWith(null)
  })
})
