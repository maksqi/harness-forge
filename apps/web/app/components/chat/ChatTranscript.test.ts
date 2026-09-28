import type { HarnessUIMessage } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { createMockApi } from '~/utils/testing/mock-api'
import ChatTranscript from './ChatTranscript.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api, useApiFetch: () => vi.fn() }))
vi.mock('~/components/chat/nuxt-imports', () => ({
  useColorMode: () => ({ value: 'dark' }),
  useRoute: () => ({ path: '/', fullPath: '/', params: {}, query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), currentRoute: { value: { path: '/' } } }),
  navigateTo: vi.fn(),
}))

function userMessages(count: number): HarnessUIMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg_user${String(index).padStart(12, '0')}`,
    role: 'user' as const,
    parts: [{ type: 'text' as const, text: `Question ${index}` }],
  }))
}

function mountTranscript(messages: HarnessUIMessage[], status: 'ready' | 'streaming' = 'ready') {
  const state = ref({ messages, status })
  const wrapper = mount({
    render: () => h(TooltipProvider, null, {
      default: () => h(ChatTranscript, { messages: state.value.messages, status: state.value.status, showThinking: false }),
    }),
  }, { attachTo: document.body })
  return { wrapper, state }
}

function rendered(wrapper: ReturnType<typeof mountTranscript>['wrapper']): string[] {
  return wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).map(item => item.attributes('data-message-id')!)
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) {
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(check()).toBe(true)
}

beforeEach(() => {
  mock.api = createMockApi()
  setActivePinia(createPinia())
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('chatTranscript: long histories', () => {
  it('renders the newest messages first and the older ones right after, in order', async () => {
    const messages = userMessages(300)
    const { wrapper } = mountTranscript(messages)
    await nextTick()
    const first = rendered(wrapper)
    expect(first.length).toBeLessThan(300)
    expect(first.at(-1)).toBe(messages.at(-1)!.id)
    await until(() => rendered(wrapper).length === 300)
    expect(rendered(wrapper)).toEqual(messages.map(message => message.id))
  })

  it('renders short histories at once and keeps new messages in place', async () => {
    const messages = userMessages(12)
    const { wrapper, state } = mountTranscript(messages)
    await nextTick()
    expect(rendered(wrapper)).toHaveLength(12)
    state.value = { ...state.value, messages: [...messages, ...userMessages(13).slice(12)] }
    await nextTick()
    expect(rendered(wrapper)).toHaveLength(13)
  })

  it('hides the Edit buttons of older messages through data-busy while a reply runs', async () => {
    const { wrapper, state } = mountTranscript(userMessages(3))
    await nextTick()
    const column = wrapper.get('.hf-transcript')
    expect(column.attributes('data-busy')).toBeUndefined()
    expect(wrapper.findAll(`[data-testid="${testIds.messageEdit}"]`)).toHaveLength(3)
    state.value = { ...state.value, status: 'streaming' }
    await nextTick()
    expect(column.attributes('data-busy')).toBe('true')
    // Older messages keep their button (hidden by CSS); the last one follows the busy prop.
    const edits = wrapper.findAll(`[data-testid="${testIds.messageEdit}"]`)
    expect(edits).toHaveLength(2)
    expect(edits[0]!.classes()).toContain('group-data-[busy=true]/transcript:hidden')
  })
})
