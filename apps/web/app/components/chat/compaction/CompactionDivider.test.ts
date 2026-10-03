import type { CompactionData } from '@harness-forge/shared'
import type { CompactionVariant } from './compaction'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { compactionData } from '~/utils/testing/fixtures'
import CompactionDivider from './CompactionDivider.vue'

// Markdown reads the color mode.
vi.mock('~/components/chat/nuxt-imports', () => ({
  useColorMode: () => ({ value: 'dark' }),
  useRoute: vi.fn(),
  useRouter: vi.fn(),
  navigateTo: vi.fn(),
}))

const writeText = vi.fn(async (_text: string) => {})

function mountDivider(data: CompactionData, variant: CompactionVariant = 'history') {
  return mount({
    render: () => h(TooltipProvider, null, { default: () => h(CompactionDivider, { data, variant }) }),
  }, { attachTo: document.body })
}

beforeEach(() => {
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('compactionDivider', () => {
  it('renders the root with the kind, the variant, the count and the label as its group name', () => {
    const wrapper = mountDivider(compactionData({ trigger: 'auto', messagesCompacted: 42 }), 'run')
    const root = wrapper.get(`[data-testid="${testIds.compactionDivider}"]`)
    expect(root.attributes()).toMatchObject({
      'data-kind': 'auto',
      'data-variant': 'run',
      'data-count': '42',
      'role': 'group',
      'aria-label': 'Context compacted during this response',
    })
    expect(root.attributes('data-state')).toBeUndefined()
    expect(root.text()).toContain('Context compacted during this response')
  })

  it('labels a manual marker and an automatic one before the reply', () => {
    expect(mountDivider(compactionData()).get(`[data-testid="${testIds.compactionDivider}"]`).attributes('aria-label')).toBe('Conversation compacted')
    const auto = mountDivider(compactionData({ trigger: 'auto' }), 'history').get(`[data-testid="${testIds.compactionDivider}"]`)
    expect(auto.attributes('aria-label')).toBe('Conversation compacted automatically')
    expect(auto.attributes('data-kind')).toBe('auto')
  })

  it('shows the meta line from sm up and hides the rules and the icon from screen readers', () => {
    const wrapper = mountDivider(compactionData({ messagesCompacted: 42 }))
    const meta = wrapper.get('[data-slot="compaction-meta"]')
    expect(meta.text().replace(/\s+/g, ' ')).toBe('· 42 messages summarized · 182K → 9K tokens')
    expect(meta.classes()).toEqual(expect.arrayContaining(['hidden', 'sm:inline']))
    const root = wrapper.get(`[data-testid="${testIds.compactionDivider}"]`)
    const hidden = root.findAll('[aria-hidden="true"]')
    // Two rules, the icon, the meta separator and the chevron.
    expect(hidden.filter(element => element.classes().includes('bg-border'))).toHaveLength(2)
    expect(root.find('svg:not([aria-hidden="true"])').exists()).toBe(false)
  })

  it('opens and closes the summary from the toggle, keeping focus on it', async () => {
    const wrapper = mountDivider(compactionData({ focus: 'keep numbers', summary: 'The user is moving **auth** to server sessions.' }))
    const toggle = wrapper.get(`[data-testid="${testIds.compactionToggle}"]`)
    expect(toggle.text()).toBe('Show summary')
    expect(toggle.attributes()).toMatchObject({ 'data-state': 'closed', 'aria-expanded': 'false', 'type': 'button' })
    const controls = toggle.attributes('aria-controls')!
    expect(controls).toMatch(/^compaction-summary-/)
    expect(wrapper.find(`[data-testid="${testIds.compactionSummary}"]`).exists()).toBe(false)

    ;(toggle.element as HTMLButtonElement).focus()
    await toggle.trigger('click')
    await flushPromises()
    expect(toggle.text()).toBe('Hide summary')
    expect(toggle.attributes()).toMatchObject({ 'data-state': 'open', 'aria-expanded': 'true' })
    expect(document.activeElement).toBe(toggle.element)
    const summary = wrapper.get(`[data-testid="${testIds.compactionSummary}"]`)
    expect(summary.attributes('id')).toBe(controls)
    expect(summary.classes()).toContain('max-h-[50dvh]')
    expect(summary.get('[data-slot="compaction-focus"]').text()).toBe('Focus: keep numbers')
    expect(summary.find('[data-slot="markdown"] strong').text()).toBe('auth')
    expect(summary.text()).toContain('The model sees this summary instead of the messages above.')
    // The summary scrolls inside a focusable region.
    const region = summary.get('[role="region"]')
    expect(region.attributes()).toMatchObject({ 'aria-label': 'Summary', 'tabindex': '0' })

    await toggle.trigger('click')
    expect(toggle.attributes('data-state')).toBe('closed')
    expect(wrapper.find(`[data-testid="${testIds.compactionSummary}"]`).exists()).toBe(false)
  })

  it('copies the summary and leaves the focus line out without a focus', async () => {
    const wrapper = mountDivider(compactionData({ summary: '## Done\n- auth' }))
    await wrapper.get(`[data-testid="${testIds.compactionToggle}"]`).trigger('click')
    const summary = wrapper.get(`[data-testid="${testIds.compactionSummary}"]`)
    expect(summary.find('[data-slot="compaction-focus"]').exists()).toBe(false)
    const copy = summary.get('button[aria-label="Copy summary"]')
    await copy.trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('## Done\n- auth')
  })

  it('gives every divider its own summary id', () => {
    const wrapper = mount({
      render: () => h(TooltipProvider, null, {
        default: () => [
          h(CompactionDivider, { data: compactionData(), variant: 'history' }),
          h(CompactionDivider, { data: compactionData({ trigger: 'auto' }), variant: 'run' }),
        ],
      }),
    }, { attachTo: document.body })
    const ids = wrapper.findAll(`[data-testid="${testIds.compactionToggle}"]`).map(toggle => toggle.attributes('aria-controls'))
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })
})
