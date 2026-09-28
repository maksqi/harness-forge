import type { ChatRequestBody } from '@harness-forge/shared'
import type { UIMessageChunk } from 'ai'
import type { Mock } from 'vitest'
import type { MockApi } from '~/utils/testing/mock-api'
import { flushPromises, mount } from '@vue/test-utils'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { resetChatSessions } from '~/composables/useChatSession'
import { useChatsStore } from '~/stores/chats'
import { testIds } from '~/utils/testids'
import { chatDetail, chatId } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import ChatView from './ChatView.vue'

const mock = vi.hoisted(() => ({
  api: null as unknown,
  fetch: null as unknown,
  composer: { setText: null as unknown as Mock, openModelPicker: null as unknown as Mock },
  toast: null as unknown as Mock,
}))

vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api, useApiFetch: () => mock.fetch }))
vi.mock('~/components/chat/nuxt-imports', () => ({
  useColorMode: () => ({ value: 'dark' }),
  useRoute: () => ({ path: '/', fullPath: '/', params: {}, query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), currentRoute: { value: { path: '/' } } }),
  navigateTo: vi.fn(),
}))
vi.mock('vue-sonner', () => {
  const toast = Object.assign((...args: unknown[]) => mock.toast(...args), { error: (...args: unknown[]) => mock.toast(...args), success: vi.fn() })
  return { toast }
})
// The real composer belongs to W2.3; this stand-in keeps its contract (docs/UI.md 10.4).
vi.mock('~/components/chat/composer/ChatComposer.vue', async () => {
  const { defineComponent: define, h: render } = await import('vue')
  return {
    default: define({
      name: 'ChatComposer',
      props: ['chatId', 'status', 'modelRef', 'reasoningEffort', 'toolMode', 'usage', 'chatCostUsd', 'disabled', 'placeholder'],
      emits: ['update:modelRef', 'update:reasoningEffort', 'update:toolMode', 'submit', 'stop', 'edit-last'],
      setup(props, { emit, expose }) {
        expose({
          focus: () => {},
          setText: (text: string) => mock.composer.setText(text),
          openModelPicker: () => mock.composer.openModelPicker(),
        })
        return () => render('form', {
          'data-testid': 'composer',
          'data-status': props.status,
          'data-placeholder': props.placeholder,
          'data-model-ref': props.modelRef,
          'data-disabled': String(props.disabled),
          'onSubmit': (event: Event) => {
            event.preventDefault()
            emit('submit', { text: 'Hello', files: [] })
          },
        }, [
          render('button', { 'type': 'button', 'data-action': 'edit-last', 'onClick': () => emit('edit-last') }),
          render('button', { 'type': 'button', 'data-action': 'stop', 'onClick': () => emit('stop') }),
        ])
      },
    }),
  }
})

const MODEL = 'mock:echo'

interface Call { url: string, method: string, body: ChatRequestBody | null }
let calls: Call[] = []
let replies: Array<() => Response> = []

function textReply(text: string): () => Response {
  return () => createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: ({ writer }) => {
        const write = (chunk: UIMessageChunk) => writer.write(chunk as never)
        write({ type: 'start', messageId: 'msg_asst000000000001', messageMetadata: { modelRef: MODEL, startedAt: 1 } })
        write({ type: 'text-start', id: 't' })
        write({ type: 'text-delta', id: 't', delta: text })
        write({ type: 'text-end', id: 't' })
        write({ type: 'finish', messageMetadata: { modelRef: MODEL, startedAt: 1, durationMs: 2000 } })
      },
    }),
  })
}

let api: MockApi
let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  stubLocalStorage()
  calls = []
  replies = []
  mock.toast = vi.fn()
  mock.composer.setText = vi.fn()
  mock.composer.openModelPicker = vi.fn()
  mock.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as ChatRequestBody : null
    calls.push({ url, method: init?.method ?? 'GET', body })
    if (url.endsWith('/stream'))
      return new Response(null, { status: 204 })
    const next = replies.shift()
    if (!next)
      throw new Error(`unexpected ${url}`)
    return next()
  })
  api = createMockApi()
  mock.api = api
  api.settings.get.mockResolvedValue({})
  api.providers.list.mockResolvedValue({ items: [] })
  api.models.list.mockResolvedValue({ items: [] })
  api.tools.list.mockResolvedValue({ items: [] })
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  resetChatSessions()
  disposePinia(pinia)
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

function mountView(props: { chatId: string, isNew?: boolean }) {
  const created = vi.fn()
  const wrapper = mount(defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(ChatView, { ...props, onCreated: created }, {
        empty: () => h('p', { 'data-testid': testIds.emptyGreeting }, 'What\'s next?'),
      }),
    }),
  }), { attachTo: document.body, global: { stubs: { NuxtLink: { template: '<a><slot /></a>' } } } })
  return { wrapper, created }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) {
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  expect(check()).toBe(true)
}

describe('chatView: new chat', () => {
  it('shows the empty slot above the composer and emits created on the first send', async () => {
    const { wrapper, created } = mountView({ chatId: chatId(1), isNew: true })
    const composer = wrapper.get('[data-testid="composer"]')
    expect(wrapper.find(`[data-testid="${testIds.emptyGreeting}"]`).exists()).toBe(true)
    expect(composer.attributes('data-placeholder')).toBe('Ask anything…')

    // No model yet: the send is refused and the picker opens.
    await composer.trigger('submit')
    expect(mock.composer.openModelPicker).toHaveBeenCalledOnce()
    expect(created).not.toHaveBeenCalled()

    wrapper.getComponent({ name: 'ChatComposer' }).vm.$emit('update:modelRef', MODEL)
    replies.push(textReply('Hi there'))
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    expect(created).toHaveBeenCalledWith(chatId(1))
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageAssistant}"]`).length === 1)
    expect(calls[0]!.body).toMatchObject({ chatId: chatId(1), trigger: 'submit-message', modelRef: MODEL })
    expect(wrapper.find(`[data-testid="${testIds.emptyGreeting}"]`).exists()).toBe(false)
    expect(wrapper.get(`[data-testid="${testIds.messageUser}"]`).text()).toContain('Hello')
    expect(wrapper.get('[data-testid="composer"]').attributes('data-placeholder')).toBe('Reply…')
  })
})

describe('chatView: existing chat', () => {
  beforeEach(() => {
    api.chats.get.mockResolvedValue(chatDetail({
      id: chatId(2),
      modelRef: MODEL,
      messages: [
        { id: 'msg_user000000000001', role: 'user', parts: [{ type: 'text', text: 'First question' }] },
        { id: 'msg_asst000000000009', role: 'assistant', metadata: { modelRef: MODEL, startedAt: 1 }, parts: [{ type: 'text', text: 'Answer', state: 'done' }] },
      ],
    }))
  })

  it('loads the history and opens the editor on the last user message (↑)', async () => {
    const { wrapper } = mountView({ chatId: chatId(2) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    expect(wrapper.get('[data-testid="composer"]').attributes('data-model-ref')).toBe(MODEL)
    await wrapper.get('[data-action="edit-last"]').trigger('click')
    await flushPromises()
    const input = wrapper.get<HTMLTextAreaElement>(`[data-testid="${testIds.messageEditInput}"]`)
    expect(input.element.value).toBe('First question')
  })

  it('takes a message back when a reply is already running (409)', async () => {
    const { wrapper } = mountView({ chatId: chatId(2) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    replies.push(() => new Response(JSON.stringify({ error: { code: 'conflict', message: 'A run is active.', details: { reason: 'run-active', chatId: chatId(2) } } }), { status: 409 }))
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => mock.toast.mock.calls.length > 0)
    expect(mock.toast).toHaveBeenCalledWith('A response is already running in this chat.')
    expect(mock.composer.setText).toHaveBeenCalledWith('Hello')
    expect(wrapper.findAll(`[data-testid="${testIds.messageUser}"]`)).toHaveLength(1)
    expect(wrapper.find(`[data-testid="${testIds.chatError}"]`).exists()).toBe(false)
    // The running reply is followed: the store knows it runs, and the view asked to resume it.
    await until(() => calls.some(call => call.url === `/api/chat/${chatId(2)}/stream`))
    expect(useChatsStore().runState[chatId(2)]).toBeUndefined()
  })
})
