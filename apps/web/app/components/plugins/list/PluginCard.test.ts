import type { PluginSummary } from '@harness-forge/shared'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { pluginSummary } from '~/utils/testing/fixtures'
import PluginCard from './PluginCard.vue'
import { NuxtLinkStub, settle } from './testing'

const none = { providers: [], models: 0, tools: [], mcpServers: [], commands: [], hooks: [] }

function mountCard(plugin: PluginSummary) {
  const events: Array<[string, unknown[]]> = []
  const wrapper = mount({
    render: () => h(TooltipProvider, null, {
      default: () => h(PluginCard, {
        plugin,
        'onUpdate:enabled': (...args: unknown[]) => events.push(['update:enabled', args]),
        'onViewLogs': (...args: unknown[]) => events.push(['view-logs', args]),
        'onReview': (...args: unknown[]) => events.push(['review', args]),
      }),
    }),
  }, { attachTo: document.body, global: { stubs: { NuxtLink: NuxtLinkStub } } })
  const card = wrapper.get(`[data-testid="${testIds.pluginCard}"]`)
  return { wrapper, card, events }
}

/** Texts of the badges (Badge renders `data-variant` on a non-button element). */
function badges(card: { findAll: (selector: string) => Array<{ text: () => string }> }) {
  return card.findAll('[data-variant]:not(button)').map(badge => badge.text())
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('pluginCard', () => {
  it('shows icon, name, version, description, source, "Runs code" and the contributions, and links to the detail page', () => {
    const { card } = mountCard(pluginSummary({
      id: 'dice-roller',
      name: 'Dice roller',
      version: '1.2.0',
      description: 'Rolls dice',
      contributions: { ...none, tools: ['roll_dice'], commands: ['roll', 'dice'] },
    }))
    expect(card.attributes('data-plugin-id')).toBe('dice-roller')
    expect(card.attributes('data-state')).toBe('active')
    expect(card.get('h3 a').attributes('href')).toBe('/plugins/dice-roller')
    expect(card.get('h3').text()).toBe('Dice roller')
    expect(card.text()).toContain('v1.2.0')
    expect(card.text()).toContain('Rolls dice')
    expect(card.find('[role="img"][aria-label="Dice roller"]').exists()).toBe(true)
    expect(badges(card)).toEqual(['Code', 'Runs code'])
    expect(card.text()).toContain('1 tool · 2 commands')
    expect(card.classes()).not.toContain('opacity-70')
    expect(card.find(`[data-testid="${testIds.pluginCardLogs}"]`).exists()).toBe(false)
    expect(card.find(`[data-testid="${testIds.pluginCardReview}"]`).exists()).toBe(false)
  })

  it('shows builtins as Core with their glyph', () => {
    const { card } = mountCard(pluginSummary({
      id: 'core-providers',
      name: 'Core providers',
      kind: 'code',
      source: 'builtin',
      builtin: true,
      removable: false,
      runsCode: false,
      contributions: { ...none, providers: Array.from({ length: 13 }, (_, index) => `p${index}`) },
    }))
    expect(badges(card)).toEqual(['Core'])
    expect(card.get('[data-slot="plugin-icon"]').attributes('data-kind')).toBe('builtin')
    expect(card.text()).toContain('13 providers')
  })

  it('labels every source', () => {
    const cases: Array<[Partial<PluginSummary>, string]> = [
      [{ source: 'created', kind: 'declarative' }, 'Declarative'],
      [{ source: 'zip' }, 'zip'],
      [{ source: 'npm' }, 'npm'],
      [{ source: 'url' }, 'URL'],
      [{ source: 'link' }, 'Local'],
      [{ source: 'copy' }, 'Local'],
    ]
    for (const [overrides, label] of cases) {
      const { card, wrapper } = mountCard(pluginSummary({ runsCode: false, ...overrides }))
      expect(badges(card)[0], label).toBe(label)
      wrapper.unmount()
    }
  })

  it('emits the switch value', async () => {
    const { card, events } = mountCard(pluginSummary())
    const toggle = card.get(`[data-testid="${testIds.pluginCardSwitch}"]`)
    expect(toggle.attributes('aria-checked')).toBe('true')
    expect(toggle.attributes('aria-label')).toBe('Enable Dice roller')
    await toggle.trigger('click')
    expect(events).toEqual([['update:enabled', [false]]])
  })

  it('marks errors with a red border, the message and "View logs"', async () => {
    const { card, events } = mountCard(pluginSummary({
      state: 'error',
      lastError: { code: 'plugin_error', message: 'setup() threw: boom' },
    }))
    expect(card.classes()).toContain('border-destructive/60')
    expect(card.text()).toContain('setup() threw: boom')
    await card.get(`[data-testid="${testIds.pluginCardLogs}"]`).trigger('click')
    expect(events).toEqual([['view-logs', []]])
  })

  it('offers Review for untrusted plugins', async () => {
    const { card, events } = mountCard(pluginSummary({ state: 'untrusted' }))
    expect(badges(card)).toContain('Untrusted')
    await card.get(`[data-testid="${testIds.pluginCardReview}"]`).trigger('click')
    expect(events).toEqual([['review', []]])
  })

  it('shows incompatible, loading and disabled states', () => {
    const incompatible = mountCard(pluginSummary({ state: 'incompatible', runsCode: false }))
    expect(badges(incompatible.card)).toContain('Incompatible')
    incompatible.wrapper.unmount()

    const loading = mountCard(pluginSummary({ state: 'loading' }))
    expect(loading.card.find('[role="status"][aria-label="Loading"]').exists()).toBe(true)
    loading.wrapper.unmount()

    const disabled = mountCard(pluginSummary({ enabled: false, state: 'disabled', description: null, contributions: none }))
    expect(disabled.card.classes()).toContain('opacity-70')
    expect(disabled.card.get(`[data-testid="${testIds.pluginCardSwitch}"]`).attributes('aria-checked')).toBe('false')
    expect(disabled.card.text()).toContain('No description')
    expect(disabled.card.text()).toContain('No contributions')
  })

  it('keeps the switch and buttons above the stretched link', async () => {
    const { card } = mountCard(pluginSummary({ state: 'untrusted' }))
    await settle()
    expect(card.get(`[data-testid="${testIds.pluginCardSwitch}"]`).classes()).toContain('z-10')
    expect(card.get(`[data-testid="${testIds.pluginCardReview}"]`).classes()).toContain('z-10')
    expect(card.get('h3 a').classes()).toContain('after:absolute')
  })
})
