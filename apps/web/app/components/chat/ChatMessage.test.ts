import type { HarnessUIMessage } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { createMockApi } from '~/utils/testing/mock-api'
import ChatMessage from './ChatMessage.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api, useApiFetch: () => vi.fn() }))
vi.mock('~/components/chat/nuxt-imports', () => ({
  useColorMode: () => ({ value: 'dark' }),
  useRoute: () => ({ path: '/', fullPath: '/', params: {}, query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), currentRoute: { value: { path: '/' } } }),
  navigateTo: vi.fn(),
}))

type Props = InstanceType<typeof ChatMessage>['$props']

function mountMessage(props: Props) {
  const events: Record<string, unknown[][]> = {}
  const record = (name: string) => (...args: unknown[]) => {
    (events[name] ??= []).push(args)
  }
  const instance = ref<InstanceType<typeof ChatMessage> | null>(null)
  const wrapper = mount(defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(ChatMessage, {
        ...props,
        ref: instance,
        onRegenerate: record('regenerate'),
        onEdit: record('edit'),
        onApproval: record('approval'),
        onRetry: record('retry'),
      }),
    }),
  }), { attachTo: document.body })
  return { wrapper, events, instance }
}

const user: HarnessUIMessage = {
  id: 'msg_user000000000001',
  role: 'user',
  parts: [{ type: 'text', text: 'Hello **there**\n  indented' }],
}

function assistant(overrides: Partial<HarnessUIMessage> = {}): HarnessUIMessage {
  return {
    id: 'msg_assistant0000001',
    role: 'assistant',
    metadata: { modelRef: 'mock:echo', startedAt: 1, durationMs: 14_000 },
    parts: [
      { type: 'step-start' },
      { type: 'reasoning', text: 'thinking', state: 'done' },
      { type: 'tool-web_fetch', toolCallId: 'c1', state: 'output-available', input: { url: 'https://a.example' }, output: 'ok' },
      { type: 'text', text: 'The **answer**', state: 'done' },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  mock.api = createMockApi()
  setActivePinia(createPinia())
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('chatMessage: user', () => {
  it('renders plain text in a bubble (no markdown) with Copy and Edit', () => {
    const { wrapper } = mountMessage({ message: user, isLast: false, streaming: false, showThinking: false })
    const root = wrapper.get(`[data-testid="${testIds.messageUser}"]`)
    expect(root.attributes('data-message-id')).toBe(user.id)
    expect(root.find('strong').exists()).toBe(false)
    expect(root.text()).toContain('Hello **there**')
    expect(root.find(`[data-testid="${testIds.messageCopy}"]`).exists()).toBe(true)
    expect(root.find(`[data-testid="${testIds.messageEdit}"]`).exists()).toBe(true)
    expect(root.find(`[data-testid="${testIds.messageRegenerate}"]`).exists()).toBe(false)
  })

  it('edits inline and emits the new text; Esc cancels', async () => {
    const { wrapper, events } = mountMessage({ message: user, isLast: false, streaming: false, showThinking: false })
    await wrapper.get(`[data-testid="${testIds.messageEdit}"]`).trigger('click')
    const input = wrapper.get<HTMLTextAreaElement>(`[data-testid="${testIds.messageEditInput}"]`)
    expect(input.element.value).toBe('Hello **there**\n  indented')
    await input.setValue('Changed')
    await wrapper.get(`[data-testid="${testIds.messageEditSave}"]`).trigger('click')
    expect(events.edit).toEqual([['Changed']])
    expect(wrapper.find(`[data-testid="${testIds.messageEditInput}"]`).exists()).toBe(false)

    await wrapper.get(`[data-testid="${testIds.messageEdit}"]`).trigger('click')
    await wrapper.get(`[data-testid="${testIds.messageEditInput}"]`).trigger('keydown', { key: 'Escape' })
    expect(wrapper.find(`[data-testid="${testIds.messageEditInput}"]`).exists()).toBe(false)
    expect(events.edit).toHaveLength(1)
  })

  it('cannot be edited while a run is active; startEdit() opens the editor otherwise', async () => {
    const busy = mountMessage({ message: user, isLast: false, streaming: false, showThinking: false, busy: true })
    expect(busy.wrapper.find(`[data-testid="${testIds.messageEdit}"]`).exists()).toBe(false)
    busy.instance.value?.startEdit()
    await nextTick()
    expect(busy.wrapper.find(`[data-testid="${testIds.messageEditInput}"]`).exists()).toBe(false)

    const idle = mountMessage({ message: user, isLast: false, streaming: false, showThinking: false })
    idle.instance.value?.startEdit()
    await nextTick()
    expect(idle.wrapper.find(`[data-testid="${testIds.messageEditInput}"]`).exists()).toBe(true)
  })

  it('shows the command badge and keeps the text as typed', () => {
    const message: HarnessUIMessage = {
      ...user,
      parts: [{ type: 'text', text: '/review src/app.ts' }],
      metadata: { modelRef: 'mock:echo', startedAt: 1, command: { name: 'review', input: 'src/app.ts', type: 'prompt' } },
    }
    const { wrapper } = mountMessage({ message, isLast: false, streaming: false, showThinking: false })
    expect(wrapper.get('[data-slot="command-badge"]').text()).toContain('/review')
    expect(wrapper.text()).toContain('/review src/app.ts')
  })
})

describe('chatMessage: assistant', () => {
  it('renders parts in order with markdown text and the meta row', async () => {
    const { wrapper } = mountMessage({ message: assistant(), isLast: true, streaming: false, showThinking: false })
    await flushPromises()
    const root = wrapper.get(`[data-testid="${testIds.messageAssistant}"]`)
    expect(root.attributes('data-status')).toBe('done')
    const order = root.findAll(`[data-testid="${testIds.reasoningRow}"], [data-testid="${testIds.toolRow}"], [data-slot="markdown"]`)
      .map(element => element.attributes('data-testid') ?? element.attributes('data-slot'))
    expect(order).toEqual([testIds.reasoningRow, testIds.toolRow, 'markdown'])
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(root.find('strong').text()).toBe('answer')
    expect(root.get(`[data-testid="${testIds.messageMeta}"]`).text()).toContain('14s')
    expect(root.find(`[data-testid="${testIds.messageRegenerate}"]`).exists()).toBe(true)
  })

  it('offers Regenerate on the last message only, and not while busy', () => {
    expect(mountMessage({ message: assistant(), isLast: false, streaming: false, showThinking: false })
      .wrapper.find(`[data-testid="${testIds.messageRegenerate}"]`).exists()).toBe(false)
    expect(mountMessage({ message: assistant(), isLast: true, streaming: false, showThinking: false, busy: true })
      .wrapper.find(`[data-testid="${testIds.messageRegenerate}"]`).exists()).toBe(false)
  })

  it('reports streaming, stopped and max-token replies', () => {
    const streaming = mountMessage({ message: assistant({ parts: [] }), isLast: true, streaming: true, showThinking: false, busy: true })
    expect(streaming.wrapper.get(`[data-testid="${testIds.messageAssistant}"]`).attributes('data-status')).toBe('streaming')
    expect(streaming.wrapper.find(`[data-testid="${testIds.submittedPlaceholder}"]`).exists()).toBe(true)

    const stopped = mountMessage({ message: assistant({ metadata: { modelRef: 'mock:echo', startedAt: 1, aborted: true, finishReason: 'length' } }), isLast: true, streaming: false, showThinking: false })
    expect(stopped.wrapper.get(`[data-testid="${testIds.messageAssistant}"]`).attributes('data-status')).toBe('aborted')
    const meta = stopped.wrapper.get(`[data-testid="${testIds.messageMeta}"]`).text()
    expect(meta).toContain('Stopped')
    expect(meta).toContain('Max tokens reached')
  })

  it('shows a stored error with Retry', async () => {
    const message = assistant({ metadata: { modelRef: 'mock:echo', startedAt: 1, error: { code: 'provider_error', message: 'Upstream failed', providerId: 'mock' } } })
    const { wrapper, events } = mountMessage({ message, isLast: true, streaming: false, showThinking: false })
    expect(wrapper.get(`[data-testid="${testIds.messageAssistant}"]`).attributes('data-status')).toBe('error')
    await wrapper.get(`[data-testid="${testIds.chatError}"] [data-action="retry"]`).trigger('click')
    expect(events.retry).toHaveLength(1)
  })

  it('labels a reply command answer', () => {
    const { wrapper } = mountMessage({ message: assistant(), isLast: true, streaming: false, showThinking: false, commandReply: true })
    expect(wrapper.get(`[data-testid="${testIds.messageMeta}"]`).text()).toContain('Command reply')
  })

  it('passes approval decisions up', async () => {
    const message = assistant({
      parts: [{ type: 'tool-mock_approval_tool', toolCallId: 'c1', state: 'approval-requested', input: { value: 'x' }, approval: { id: 'appr_1' } }],
    })
    const { wrapper, events } = mountMessage({ message, isLast: true, streaming: false, showThinking: false })
    await wrapper.get(`[data-testid="${testIds.toolApprovalAllow}"]`).trigger('click')
    expect(events.approval).toEqual([[{ id: 'appr_1', approved: true, toolName: 'mock_approval_tool', alwaysAllow: false }]])
  })
})
