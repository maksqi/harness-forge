// PluginUpdateBanner (Phase 12, ADR-054; docs/UI.md 8.13, 10.9; C46 stub, W12.9); its mount is tested in
// PluginDetailView.test.ts.
import type { PluginUpdate } from '@harness-forge/shared'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { testIds } from '~/utils/testids'
import { pluginUpdate } from '~/utils/testing/fixtures'
import PluginUpdateBanner from './PluginUpdateBanner.vue'

afterEach(() => {
  document.body.replaceChildren()
})

function render(props: { update: PluginUpdate | null, marketplaceName: string | null, onUpdate?: () => void }) {
  return mount({ render: () => h(PluginUpdateBanner, props) }, { attachTo: document.body })
}

describe('pluginUpdateBanner', () => {
  it('renders nothing without an update', () => {
    render({ update: null, marketplaceName: null })
    expect(document.body.querySelector('[data-slot="plugin-update-banner"]')).toBeNull()
  })

  it('names the offered version and its marketplace and emits update', () => {
    const update = vi.fn()
    render({ update: pluginUpdate(), marketplaceName: 'claude-plugins-official', onUpdate: update })
    const banner = document.body.querySelector<HTMLElement>('[data-slot="plugin-update-banner"]')!
    expect(banner.textContent).toContain('Version 1.2.0 is available from claude-plugins-official.')
    expect(banner.getAttribute('role')).toBe('status')
    expect(banner.dataset.version).toBe('1.2.0')
    document.body.querySelector<HTMLElement>(`[data-testid="${testIds.pluginUpdate}"]`)!.click()
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('says a newer commit is available without a version', () => {
    render({ update: pluginUpdate({ availableVersion: null }), marketplaceName: 'acme' })
    expect(document.body.textContent).toContain('A newer commit is available from acme.')
    expect(document.body.querySelector<HTMLElement>('[data-slot="plugin-update-banner"]')?.dataset.version).toBe('')
  })

  it('falls back to "its marketplace" when the marketplace is not loaded', () => {
    render({ update: pluginUpdate(), marketplaceName: null })
    expect(document.body.textContent).toContain('Version 1.2.0 is available from its marketplace.')
  })
})
