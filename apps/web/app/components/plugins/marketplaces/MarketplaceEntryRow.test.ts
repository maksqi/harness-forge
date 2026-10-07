// MarketplaceEntryRow (Phase 12, ADR-054; docs/UI.md 8.13, 10.9, 14.2, 14.5; W12.8-T5): the article and its name, the
// four states with their lines and actions, line 2 (marketplace on All, tags, source) and the unsupported reason.
import type { MarketplaceEntryView } from './marketplaces'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, provide } from 'vue'
import { testIds } from '~/utils/testids'
import { marketplaceEntry, marketplaceId, pluginUpdate } from '~/utils/testing/fixtures'
import { byTestId, mountInShell } from '../list/testing'
import { MARKETPLACE_ENTRY_CONTEXT } from './entry-context'
import MarketplaceEntryRow from './MarketplaceEntryRow.vue'

let unmount: (() => void) | null = null

afterEach(() => {
  unmount?.()
  unmount = null
  document.body.replaceChildren()
})

function view(overrides: Partial<MarketplaceEntryView> = {}): MarketplaceEntryView {
  return {
    marketplaceId: marketplaceId(1),
    marketplaceName: 'claude-plugins-official',
    entry: marketplaceEntry(),
    state: 'available',
    pluginId: null,
    installedVersion: null,
    update: null,
    ...overrides,
  }
}

function render(entry: MarketplaceEntryView, props: Record<string, unknown> = {}, showMarketplace = false) {
  const Host = defineComponent({
    setup() {
      provide(MARKETPLACE_ENTRY_CONTEXT, { showMarketplace: computed(() => showMarketplace) })
      return () => h(MarketplaceEntryRow, { entry, ...props })
    },
  })
  const wrapper = mountInShell(Host)
  unmount = () => wrapper.unmount()
  return byTestId(testIds.marketplaceEntry)!
}

describe('marketplaceEntryRow', () => {
  it('is an article named "{name}, Available" with Install {name}', () => {
    const install = vi.fn()
    const row = render(view(), { onInstall: install })
    expect(row.tagName).toBe('ARTICLE')
    expect(row.dataset).toMatchObject({ name: 'review-kit', state: 'available', marketplaceId: marketplaceId(1) })
    expect(row.getAttribute('aria-label')).toBe('review-kit, Available')
    expect(row.textContent).toContain('1.2.0')
    expect(row.textContent).toContain('development')
    expect(row.textContent).toContain('Code review commands and agents')
    expect(row.textContent).toContain('In this marketplace')
    expect(row.textContent).toContain('review')
    expect(row.textContent).not.toContain('claude-plugins-official')
    const button = byTestId<HTMLButtonElement>(testIds.marketplaceEntryInstall)!
    expect(button.getAttribute('aria-label')).toBe('Install review-kit')
    expect(button.textContent).toContain('Install…')
    expect(byTestId(testIds.marketplaceEntryUpdate)).toBeNull()
    button.click()
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('shows Installed and an Open link to the plugin page for an installed entry', () => {
    const row = render(view({ state: 'installed', pluginId: 'review-kit', installedVersion: '1.2.0', entry: marketplaceEntry({ installedPluginId: 'review-kit' }) }))
    expect(row.getAttribute('aria-label')).toBe('review-kit, Installed')
    expect(row.querySelector('[data-slot="marketplace-entry-status"]')?.textContent?.trim()).toBe('Installed')
    const open = row.querySelector<HTMLAnchorElement>('[data-action="open-plugin"]')!
    expect(open.getAttribute('href')).toBe('/plugins/review-kit')
    expect(open.getAttribute('aria-label')).toBe('Open review-kit')
    expect(byTestId(testIds.marketplaceEntryInstall)).toBeNull()
  })

  it('offers Update {name} with "Installed · Update to {version}" and disables it while busy', () => {
    const update = vi.fn()
    const row = render(view({ state: 'update', pluginId: 'review-kit', installedVersion: '1.1.0', update: pluginUpdate({ availableVersion: '1.3.0' }) }), { busy: true, onUpdate: update })
    expect(row.getAttribute('aria-label')).toBe('review-kit, Update available')
    expect(row.getAttribute('aria-busy')).toBe('true')
    expect(row.textContent).toContain('Installed · Update to 1.3.0')
    const button = byTestId<HTMLButtonElement>(testIds.marketplaceEntryUpdate)!
    expect(button.getAttribute('aria-label')).toBe('Update review-kit')
    expect(button.disabled).toBe(true)
    button.click()
    expect(update).not.toHaveBeenCalled()
  })

  it('names an unsupported source with its reason as the description and no button', () => {
    const row = render(view({
      state: 'unsupported',
      entry: marketplaceEntry({ name: 'py-lsp', source: { kind: 'git', text: 'https://gitlab.example/x.git' }, supported: false, unsupportedReason: 'Git sources other than GitHub are not supported.' }),
    }))
    expect(row.getAttribute('aria-label')).toBe('py-lsp, Unsupported')
    expect(row.textContent).toContain('Unsupported source (git)')
    const reason = document.getElementById(row.getAttribute('aria-describedby')!)
    expect(reason?.textContent?.trim()).toBe('Git sources other than GitHub are not supported.')
    expect(row.querySelector('button')).toBeNull()
  })

  it('names the marketplace in line 2 on All', () => {
    const row = render(view({ entry: marketplaceEntry({ source: { kind: 'github', text: 'acme/ct@v1' }, tags: ['git', 'workflow'] }) }), {}, true)
    const line = Array.from(row.querySelectorAll('p')).find(p => p.textContent?.includes('GitHub acme/ct@v1'))!
    expect(line.textContent?.replace(/\s+/g, ' ').trim()).toBe('claude-plugins-official · git · workflow · GitHub acme/ct@v1')
  })
})
