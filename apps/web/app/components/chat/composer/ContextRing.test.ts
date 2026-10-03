import type { MessageUsage } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import { settings } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import ContextRing from './ContextRing.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api, useApiFetch: () => vi.fn() }))

function mountRing(props: { usage?: MessageUsage | null, contextWindow?: number | null, chatCostUsd?: number | null }) {
  return mount({
    render: () => h(TooltipProvider, null, { default: () => h(ContextRing, props) }),
  }, { attachTo: document.body })
}

/** Opens the hover card (it opens on focus) and returns its text. */
async function openCard(wrapper: ReturnType<typeof mountRing>): Promise<string> {
  await wrapper.get(`[data-testid="${testIds.contextRing}"]`).trigger('focus')
  await new Promise(resolve => setTimeout(resolve, 50))
  await flushPromises()
  return document.body.querySelector('[data-slot="context-compaction-note"]')?.textContent?.trim() ?? ''
}

beforeEach(() => {
  mock.api = createMockApi()
  setActivePinia(createPinia())
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('contextRing', () => {
  it('shows the share of the context used by the last turn', () => {
    const wrapper = mountRing({ usage: { inputTokens: 80_000, outputTokens: 4_000, contextTokens: 84_000 }, contextWindow: 200_000 })
    const ring = wrapper.get(`[data-testid="${testIds.contextRing}"]`)
    expect(ring.attributes()).toMatchObject({ 'data-value': '42', 'data-level': 'normal', 'aria-label': '42% of context used' })
  })

  it('renders nothing without usage or a context window', () => {
    expect(mountRing({ usage: null, contextWindow: 200_000 }).find(`[data-testid="${testIds.contextRing}"]`).exists()).toBe(false)
    expect(mountRing({ usage: { contextTokens: 10 }, contextWindow: null }).find(`[data-testid="${testIds.contextRing}"]`).exists()).toBe(false)
  })

  it('ends the hover card with the automatic compaction note (Phase 9)', async () => {
    const wrapper = mountRing({ usage: { contextTokens: 170_000 }, contextWindow: 200_000, chatCostUsd: 0.12 })
    expect(wrapper.get(`[data-testid="${testIds.contextRing}"]`).attributes('data-level')).toBe('warning')
    expect(await openCard(wrapper)).toBe('Older messages are summarized automatically near the limit. Type /compact to do it now.')
    expect(document.body.textContent).toContain('Chat cost')
  })

  it('says when automatic compaction is off (Phase 9)', async () => {
    const store = useSettingsStore()
    store.settings = settings({ autoCompact: false })
    const wrapper = mountRing({ usage: { contextTokens: 9_000 }, contextWindow: 200_000 })
    expect(await openCard(wrapper)).toBe('Automatic compaction is off. Older messages are left out near the limit.')
  })
})
