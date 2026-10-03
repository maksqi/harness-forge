import type { ChatRequestBody } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { UIMessageChunk } from 'ai'
import type { Mock } from 'vitest'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { resetChatSessions } from '~/composables/useChatSession'
import { dispatchServerEvent } from '~/composables/useServerEvents'
import { useChatsStore } from '~/stores/chats'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import { assistantMessage, chatDetail, chatId, messageBranch, projectId, projectSummary, userMessage } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import ChatTranscript from './ChatTranscript.vue'
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
      props: ['chatId', 'status', 'modelRef', 'reasoningEffort', 'toolMode', 'usage', 'chatCostUsd', 'disabled', 'placeholder', 'previousImages', 'projectId'],
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
          'data-previous-images': String(props.previousImages),
          'data-project-id': props.projectId ?? 'none',
          'data-tool-mode': props.toolMode,
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
/** Views mounted by the current test: unmounted before the body is cleared (dialogs render into the body). */
const mounted: VueWrapper[] = []

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
  api.projects.list.mockResolvedValue({ items: [] })
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  for (const wrapper of mounted.splice(0)) {
    if (wrapper.exists())
      wrapper.unmount()
  }
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
        // Like pages/chat/[id].vue: the header gets the chat's project.
        header: ({ projectId: project }: { projectId: string | null }) => h('header', { 'data-testid': 'header', 'data-project-id': project ?? 'none' }),
        // Like pages/index.vue: the greeting and the project picker (v-model on the session's project).
        empty: ({ projectId: project, setProject }: { projectId: string | null, setProject: (id: string | null) => void }) => [
          h('p', { 'data-testid': testIds.emptyGreeting }, 'What\'s next?'),
          h('button', { 'type': 'button', 'data-testid': 'pick-project', 'data-project-id': project ?? 'none', 'onClick': () => setProject(projectId(2)) }),
        ],
      }),
    }),
  }), { attachTo: document.body, global: { stubs: { NuxtLink: { template: '<a><slot /></a>' } } } })
  mounted.push(wrapper)
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

  it('shows a skeleton only for a slow history, and Retry after a failed load', async () => {
    let answer!: (value: unknown) => void
    api.chats.get.mockReset()
    api.chats.get.mockImplementationOnce(() => new Promise((resolve) => {
      answer = resolve
    }))
    const { wrapper } = mountView({ chatId: chatId(2) })
    await flushPromises()
    // Fast loads never flash a skeleton.
    expect(wrapper.find(`[data-testid="${testIds.transcriptSkeleton}"]`).exists()).toBe(false)
    await until(() => wrapper.find(`[data-testid="${testIds.transcriptSkeleton}"]`).exists())
    answer(chatDetail({ id: chatId(2), messages: [{ id: 'msg_user000000000001', role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] }))
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    expect(wrapper.find(`[data-testid="${testIds.transcriptSkeleton}"]`).exists()).toBe(false)
    wrapper.unmount()

    resetChatSessions()
    api.chats.get.mockRejectedValueOnce(new Error('offline'))
    const failed = mountView({ chatId: chatId(3) })
    await until(() => failed.wrapper.text().includes('Could not load this chat'))
    await new Promise(resolve => setTimeout(resolve, 350))
    expect(failed.wrapper.find(`[data-testid="${testIds.transcriptSkeleton}"]`).exists()).toBe(false)
    api.chats.get.mockResolvedValueOnce(chatDetail({ id: chatId(3), messages: [{ id: 'msg_user000000000002', role: 'user', parts: [{ type: 'text', text: 'Back' }] }] }))
    const retry = failed.wrapper.findAll('button').find(button => button.text() === 'Retry')!
    await retry.trigger('click')
    await until(() => failed.wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    expect(failed.wrapper.text()).not.toContain('Could not load this chat')
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

  it('takes a message back while a key rotation holds off new runs (409 busy)', async () => {
    const { wrapper } = mountView({ chatId: chatId(2) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    replies.push(() => new Response(JSON.stringify({ error: { code: 'conflict', message: 'The server is rotating its encryption key. Try again in a moment.', details: { reason: 'busy' } } }), { status: 409 }))
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => mock.toast.mock.calls.length > 0)
    expect(mock.toast.mock.calls).toEqual([['The server is rotating its encryption key. Try again in a moment.']])
    expect(mock.composer.setText).toHaveBeenCalledWith('Hello')
    expect(wrapper.findAll(`[data-testid="${testIds.messageUser}"]`)).toHaveLength(1)
    expect(wrapper.find(`[data-testid="${testIds.chatError}"]`).exists()).toBe(false)
    expect(wrapper.get('[data-testid="composer"]').attributes('data-status')).toBe('ready')
    // Nothing runs: no resume, no running dot.
    await flushPromises()
    expect(calls.filter(call => call.url.endsWith('/stream'))).toHaveLength(0)
    expect(useChatsStore().runState[chatId(2)]).toBeUndefined()
  })
})

describe('chatView: approvals', () => {
  it('"Accept all edits in this chat": the composer shows edits and the continuation runs in edits mode', async () => {
    api.chats.update.mockResolvedValue(chatDetail({ id: chatId(10) }))
    api.chats.get.mockResolvedValue(chatDetail({
      id: chatId(10),
      modelRef: MODEL,
      projectId: projectId(1),
      settings: { toolMode: 'ask' },
      messages: [
        userMessage('msg_user000000000001', 'Fix the parser'),
        {
          id: 'msg_asst000000000009',
          role: 'assistant',
          metadata: { modelRef: MODEL, startedAt: 1 },
          parts: [{ type: 'tool-edit_file', toolCallId: 'call_1', state: 'approval-requested', input: { path: 'a.ts', old_string: 'a', new_string: 'b' }, approval: { id: 'appr_1' } }],
        },
      ],
    }))
    const { wrapper } = mountView({ chatId: chatId(10) })
    await until(() => wrapper.find(`[data-testid="${testIds.toolApproval}"]`).exists())
    expect(wrapper.get('[data-testid="composer"]').attributes('data-tool-mode')).toBe('ask')
    // An edit in a chat that asks: the card offers "Accept all edits in this chat" instead of "Always allow".
    expect(wrapper.find(`[data-testid="${testIds.toolApprovalAcceptEdits}"]`).exists()).toBe(true)
    expect(wrapper.find(`[data-testid="${testIds.toolApprovalAlways}"]`).exists()).toBe(false)

    replies.push(textReply('Edited'))
    wrapper.getComponent(ChatTranscript).vm.$emit('approval', { id: 'appr_1', approved: true, toolName: 'edit_file', alwaysAllow: false, acceptEdits: true })
    await until(() => calls.some(call => call.url === '/api/chat'))
    expect(calls.find(call => call.url === '/api/chat')!.body).toMatchObject({ toolMode: 'edits', message: { role: 'assistant' } })
    expect(api.chats.update).toHaveBeenCalledWith({ params: { id: chatId(10) }, body: { settings: { toolMode: 'edits' } } })
    expect(wrapper.get('[data-testid="composer"]').attributes('data-tool-mode')).toBe('edits')
    await until(() => wrapper.text().includes('Edited'))
  })
})

describe('chatView: approval cards', () => {
  function pendingCall(toolName: string, input: unknown) {
    return {
      id: 'msg_asst000000000009',
      role: 'assistant' as const,
      metadata: { modelRef: MODEL, startedAt: 1 },
      parts: [{ type: `tool-${toolName}` as const, toolCallId: 'call_1', state: 'approval-requested' as const, input, approval: { id: 'appr_1' } }],
    }
  }

  it('a chat that already accepts edits gets no "Accept all edits" checkbox', async () => {
    api.chats.get.mockResolvedValue(chatDetail({
      id: chatId(11),
      modelRef: MODEL,
      projectId: projectId(1),
      settings: { toolMode: 'edits' },
      messages: [userMessage('msg_user000000000001', 'Write it'), pendingCall('write_file', { path: 'a.ts', content: 'x' })],
    }))
    const { wrapper } = mountView({ chatId: chatId(11) })
    await until(() => wrapper.find(`[data-testid="${testIds.toolApproval}"]`).exists())
    expect(wrapper.find(`[data-testid="${testIds.toolApprovalAcceptEdits}"]`).exists()).toBe(false)
    expect(wrapper.find(`[data-testid="${testIds.toolApprovalAlways}"]`).exists()).toBe(false)
    expect(wrapper.find(`[data-testid="${testIds.toolApprovalAllow}"]`).exists()).toBe(true)
  })

  it('a shell approval names the project and announces the command', async () => {
    api.projects.list.mockResolvedValue({ items: [projectSummary({ id: projectId(1), name: 'Website' })] })
    api.chats.get.mockResolvedValue(chatDetail({
      id: chatId(12),
      modelRef: MODEL,
      projectId: projectId(1),
      messages: [userMessage('msg_user000000000001', 'Run the tests'), pendingCall('shell', { command: 'pnpm test\necho done', timeout_ms: 120_000 })],
    }))
    const { wrapper } = mountView({ chatId: chatId(12) })
    await until(() => wrapper.find(`[data-testid="${testIds.toolApprovalPreview}"]`).exists())
    await until(() => wrapper.get(`[data-testid="${testIds.toolApprovalPreview}"]`).text().includes('In Website'))
    expect(wrapper.get(`[data-testid="${testIds.toolApprovalPreview}"]`).attributes('data-kind')).toBe('command')
    // Shell commands are never "always allowed".
    expect(wrapper.find(`[data-testid="${testIds.toolApprovalAlways}"]`).exists()).toBe(false)
    await until(() => wrapper.get('[role="status"]').text() === 'Approval needed: run pnpm test')
  })

  it('announces other tools by name', async () => {
    api.chats.get.mockResolvedValue(chatDetail({
      id: chatId(13),
      modelRef: MODEL,
      messages: [userMessage('msg_user000000000001', 'Use it'), pendingCall('mock_approval_tool', { value: 'x' })],
    }))
    const { wrapper } = mountView({ chatId: chatId(13) })
    await until(() => wrapper.get('[role="status"]').text() === 'Approval needed: mock_approval_tool')
  })
})

describe('chatView: projects', () => {
  const P1 = projectId(1)
  const P2 = projectId(2)

  beforeEach(() => {
    api.projects.list.mockResolvedValue({ items: [projectSummary({ id: P1, name: 'Website' }), projectSummary({ id: P2, name: 'Notes', path: '/srv/workspaces/notes' })] })
  })

  it('loads the projects once (the chip, the picker and the move menu need them)', async () => {
    mountView({ chatId: chatId(1), isNew: true })
    await until(() => useProjectsStore().loaded)
    expect(api.projects.list).toHaveBeenCalledTimes(1)
    mountView({ chatId: chatId(2), isNew: true })
    await flushPromises()
    expect(api.projects.list).toHaveBeenCalledTimes(1)
  })

  it('a new chat: the filter\'s project, then the pick, reach the picker, the composer and the first request', async () => {
    const chats = useChatsStore()
    chats.projectFilter = P1
    const { wrapper } = mountView({ chatId: chatId(1), isNew: true })
    await until(() => wrapper.get('[data-testid="pick-project"]').attributes('data-project-id') === P1)
    expect(wrapper.get('[data-testid="composer"]').attributes('data-project-id')).toBe(P1)

    // The picker's v-model: a local choice until the first send.
    await wrapper.get('[data-testid="pick-project"]').trigger('click')
    expect(wrapper.get('[data-testid="pick-project"]').attributes('data-project-id')).toBe(P2)
    expect(wrapper.get('[data-testid="composer"]').attributes('data-project-id')).toBe(P2)
    expect(api.chats.update).not.toHaveBeenCalled()

    wrapper.getComponent({ name: 'ChatComposer' }).vm.$emit('update:modelRef', MODEL)
    replies.push(textReply('Hi there'))
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => calls.some(call => call.url === '/api/chat'))
    expect(calls.find(call => call.url === '/api/chat')!.body).toMatchObject({ chatId: chatId(1), projectId: P2 })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageAssistant}"]`).length === 1)
    // The chat keeps its project once it exists.
    expect(wrapper.get('[data-testid="composer"]').attributes('data-project-id')).toBe(P2)
    expect(wrapper.get('[data-testid="header"]').attributes('data-project-id')).toBe(P2)
  })

  it('a new chat without a project sends none', async () => {
    const { wrapper } = mountView({ chatId: chatId(1), isNew: true })
    expect(wrapper.get('[data-testid="pick-project"]').attributes('data-project-id')).toBe('none')
    expect(wrapper.get('[data-testid="composer"]').attributes('data-project-id')).toBe('none')
    wrapper.getComponent({ name: 'ChatComposer' }).vm.$emit('update:modelRef', MODEL)
    replies.push(textReply('Hi there'))
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => calls.some(call => call.url === '/api/chat'))
    expect(calls.find(call => call.url === '/api/chat')!.body).not.toHaveProperty('projectId')
  })

  it('a saved chat: the header and the composer get its project', async () => {
    api.chats.get.mockResolvedValue(chatDetail({ id: chatId(5), modelRef: MODEL, projectId: P1, messages: [userMessage('msg_user000000000001', 'Hi')] }))
    const { wrapper } = mountView({ chatId: chatId(5) })
    await until(() => wrapper.get('[data-testid="header"]').attributes('data-project-id') === P1)
    expect(wrapper.get('[data-testid="composer"]').attributes('data-project-id')).toBe(P1)
    // Moved elsewhere (another tab, the sidebar): both follow.
    dispatchServerEvent({ type: 'chat.updated', data: { ...chatDetail({ id: chatId(5), projectId: null }), activeLeafId: 'msg_user000000000001' }, at: 1 })
    await flushPromises()
    expect(wrapper.get('[data-testid="header"]').attributes('data-project-id')).toBe('none')
    expect(wrapper.get('[data-testid="composer"]').attributes('data-project-id')).toBe('none')
  })
})

describe('chatView: versions', () => {
  const U1 = 'msg_user00000000000a'
  const A1 = 'msg_asst00000000000a'
  const U1B = 'msg_user00000000000b'
  const A1B = 'msg_asst00000000000b'
  /** The id `textReply()` streams. */
  const REPLY = 'msg_asst000000000001'

  beforeEach(() => {
    api.chats.get.mockResolvedValue(chatDetail({
      id: chatId(4),
      modelRef: MODEL,
      messages: [userMessage(U1, 'First question'), assistantMessage(A1, 'Answer')],
      branches: { [U1]: messageBranch([U1B, U1], 1) },
    }))
  })

  async function mountLoaded() {
    const view = mountView({ chatId: chatId(4) })
    await until(() => view.wrapper.find(`[data-testid="${testIds.messageBranch}"]`).exists())
    return view
  }

  function branchControl(wrapper: ReturnType<typeof mountView>['wrapper'], testId: string) {
    return wrapper.get(`[data-testid="${testIds.messageBranch}"] [data-testid="${testId}"]`)
  }

  it('switches to another version: shows the returned path, announces it and keeps the focus on the control', async () => {
    api.chats.switchBranch.mockResolvedValue(chatDetail({
      id: chatId(4),
      messages: [userMessage(U1B, 'Older question'), assistantMessage(A1B, 'Older answer')],
      branches: { [U1B]: messageBranch([U1B, U1], 0) },
    }))
    const { wrapper } = await mountLoaded()
    expect(wrapper.get(`[data-testid="${testIds.messageBranch}"]`).attributes('data-message-id')).toBe(U1)
    const previous = branchControl(wrapper, testIds.messageBranchPrevious)
    ;(previous.element as HTMLElement).focus()
    await previous.trigger('click')

    expect(api.chats.switchBranch).toHaveBeenCalledWith({ params: { id: chatId(4) }, body: { messageId: U1B } })
    await until(() => wrapper.get(`[data-testid="${testIds.messageUser}"]`).attributes('data-message-id') === U1B)
    expect(wrapper.get(`[data-testid="${testIds.messageAssistant}"]`).text()).toContain('Older answer')
    await until(() => wrapper.get('[role="status"]').text() === 'Version 1 of 2')
    expect(document.activeElement).toBe(branchControl(wrapper, testIds.messageBranchPrevious).element)
  })

  it('a switch refused because a reply is running shows the conflict toast', async () => {
    api.chats.switchBranch.mockRejectedValue(new HarnessError({ code: 'conflict', message: 'A run is active.', details: { reason: 'run-active', chatId: chatId(4) } }))
    const { wrapper } = await mountLoaded()
    await branchControl(wrapper, testIds.messageBranchPrevious).trigger('click')
    await until(() => mock.toast.mock.calls.length > 0)
    expect(mock.toast).toHaveBeenCalledWith('A response is already running in this chat.')
    expect(wrapper.get(`[data-testid="${testIds.messageUser}"]`).attributes('data-message-id')).toBe(U1)
  })

  it('an edit sends a new version: a new message under the edited message\'s parent', async () => {
    const { wrapper } = await mountLoaded()
    replies.push(textReply('Another answer'))
    await wrapper.get(`[data-testid="${testIds.messageEdit}"]`).trigger('click')
    await wrapper.get(`[data-testid="${testIds.messageEditInput}"]`).setValue('First question, edited')
    await wrapper.get(`[data-testid="${testIds.messageEditSave}"]`).trigger('click')
    await until(() => calls.some(call => call.url === '/api/chat'))
    const body = calls.find(call => call.url === '/api/chat')!.body!
    expect(body).toMatchObject({ trigger: 'submit-message', parentId: null })
    expect(body).not.toHaveProperty('messageId')
    expect(body.message.id).not.toBe(U1)
    await until(() => wrapper.text().includes('Another answer'))
    // The new version has no known siblings yet: no switcher until the versions are refetched.
    expect(wrapper.find(`[data-testid="${testIds.messageBranch}"]`).exists()).toBe(false)

    // Its run finished: the versions are refetched and the switcher shows "2/2" on the new message.
    api.chats.get.mockResolvedValueOnce(chatDetail({
      id: chatId(4),
      messages: [userMessage(body.message.id, 'First question, edited'), assistantMessage(REPLY, 'Another answer')],
      branches: { [body.message.id]: messageBranch([U1, body.message.id], 1) },
    }))
    dispatchServerEvent({ type: 'run.finished', data: { chatId: chatId(4), messageId: REPLY, outcome: 'completed', awaitingApproval: false }, at: 1 })
    await until(() => wrapper.find(`[data-testid="${testIds.messageBranch}"]`).exists())
    const switcher = wrapper.get(`[data-testid="${testIds.messageBranch}"]`)
    expect(switcher.attributes('data-message-id')).toBe(body.message.id)
    expect(switcher.get(`[data-testid="${testIds.messageBranchCounter}"]`).text()).toBe('2/2')
  })

  it('a stale path (404): the unsent message goes back into the composer and the chat reloads', async () => {
    const { wrapper } = await mountLoaded()
    api.chats.get.mockResolvedValueOnce(chatDetail({
      id: chatId(4),
      messages: [
        userMessage(U1, 'First question'),
        assistantMessage(A1, 'Answer'),
        userMessage('msg_user000000000009', 'From another tab'),
        assistantMessage('msg_asst000000000009', 'Another answer'),
      ],
    }))
    replies.push(() => new Response(JSON.stringify({ error: { code: 'not_found', message: 'Message not found.' } }), { status: 404 }))
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => mock.toast.mock.calls.length > 0)
    expect(mock.toast).toHaveBeenCalledWith('This chat changed elsewhere and was reloaded.')
    expect(mock.composer.setText).toHaveBeenCalledWith('Hello')
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 2)
    expect(wrapper.text()).toContain('From another tab')
    expect(wrapper.find(`[data-testid="${testIds.chatError}"]`).exists()).toBe(false)
  })
})

describe('chatView: images', () => {
  it('tells the composer how many images the last reply holds', async () => {
    const image = (n: number) => ({ type: 'file' as const, mediaType: 'image/png', url: `/api/files/file_image00000000000${n}`, filename: `image-${n}.png` })
    api.chats.get.mockResolvedValue(chatDetail({
      id: chatId(6),
      modelRef: MODEL,
      messages: [
        userMessage('msg_user000000000001', 'A red fox'),
        assistantMessage('msg_asst000000000001', '', { parts: [image(1), image(2)] }),
      ],
    }))
    const { wrapper } = mountView({ chatId: chatId(6) })
    await until(() => wrapper.find(`[data-testid="${testIds.imageGallery}"]`).exists())
    expect(wrapper.get('[data-testid="composer"]').attributes('data-previous-images')).toBe('2')

    // A new chat has none.
    const fresh = mountView({ chatId: chatId(7), isNew: true })
    expect(fresh.wrapper.get('[data-testid="composer"]').attributes('data-previous-images')).toBe('0')
  })
})

describe('chatView: edit attachments', () => {
  it('sends the files left in the editor with the new version', async () => {
    const photo = { type: 'file' as const, mediaType: 'image/png', filename: 'photo.png', url: '/api/files/file_photo000000000001' }
    api.chats.get.mockResolvedValue(chatDetail({
      id: chatId(8),
      modelRef: MODEL,
      messages: [userMessage('msg_user000000000001', 'What is this?', { parts: [photo, { type: 'text', text: 'What is this?' }] }), assistantMessage('msg_asst000000000009', 'A photo')],
    }))
    const { wrapper } = mountView({ chatId: chatId(8) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    replies.push(textReply('Without the photo'))
    await wrapper.get(`[data-testid="${testIds.messageEdit}"]`).trigger('click')
    await wrapper.get('[aria-label="Remove photo.png"]').trigger('click')
    await wrapper.get(`[data-testid="${testIds.messageEditSave}"]`).trigger('click')
    await until(() => calls.some(call => call.url === '/api/chat'))
    expect(calls.find(call => call.url === '/api/chat')!.body!.message.parts).toEqual([{ type: 'text', text: 'What is this?' }])
  })
})

describe('chatView: delete a version', () => {
  const U1 = 'msg_user00000000000a'
  const A1 = 'msg_asst00000000000a'
  const U1B = 'msg_user00000000000b'
  const A1B = 'msg_asst00000000000b'
  const U1C = 'msg_user00000000000c'

  function confirmButton(): HTMLButtonElement | null {
    return document.body.querySelector<HTMLButtonElement>(`[data-testid="${testIds.messageDeleteVersionConfirm}"]`)
  }

  async function mountWithVersions(siblings: string[]) {
    api.chats.get.mockResolvedValue(chatDetail({
      id: chatId(9),
      modelRef: MODEL,
      messages: [userMessage(U1B, 'Second question'), assistantMessage(A1B, 'Second answer')],
      branches: { [U1B]: messageBranch(siblings, siblings.indexOf(U1B)) },
    }))
    const view = mountView({ chatId: chatId(9) })
    await until(() => view.wrapper.find(`[data-testid="${testIds.messageDeleteVersion}"]`).exists())
    return view
  }

  async function askToDelete(wrapper: ReturnType<typeof mountView>['wrapper']) {
    await wrapper.get(`[data-message-id="${U1B}"] [data-testid="${testIds.messageDeleteVersion}"]`).trigger('click')
    await until(() => confirmButton() !== null)
  }

  it('asks first, then deletes: the previous version shows, the live region says so, focus lands on it', async () => {
    api.chats.deleteMessage.mockResolvedValue(chatDetail({
      id: chatId(9),
      messages: [userMessage(U1, 'First question'), assistantMessage(A1, 'First answer')],
      branches: {},
    }))
    const { wrapper } = await mountWithVersions([U1, U1B])
    await askToDelete(wrapper)
    expect(document.body.textContent).toContain('Delete this version?')
    expect(document.body.textContent).toContain('This version and every message after it are deleted. Other versions stay.')
    expect(confirmButton()!.textContent?.trim()).toBe('Delete version')
    expect(api.chats.deleteMessage).not.toHaveBeenCalled()

    confirmButton()!.click()
    expect(api.chats.deleteMessage).toHaveBeenCalledWith({ params: { id: chatId(9), messageId: U1B } })
    await until(() => wrapper.get(`[data-testid="${testIds.messageUser}"]`).attributes('data-message-id') === U1)
    await until(() => wrapper.get('[role="status"]').text() === 'Version deleted')
    expect(confirmButton()).toBeNull()
    // One version left: no switcher, focus on its Copy button.
    expect(wrapper.find(`[data-testid="${testIds.messageBranch}"]`).exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get(`[data-message-id="${U1}"] [data-testid="${testIds.messageCopy}"]`).element)
    expect(mock.toast).not.toHaveBeenCalled()
  })

  it('focuses the switcher of the version shown when versions are left', async () => {
    api.chats.deleteMessage.mockResolvedValue(chatDetail({
      id: chatId(9),
      messages: [userMessage(U1, 'First question'), assistantMessage(A1, 'First answer')],
      branches: { [U1]: messageBranch([U1, U1C], 0) },
    }))
    const { wrapper } = await mountWithVersions([U1, U1B, U1C])
    await askToDelete(wrapper)
    confirmButton()!.click()
    await until(() => wrapper.get('[role="status"]').text() === 'Version deleted')
    const switcher = wrapper.get(`[data-testid="${testIds.messageBranch}"]`)
    expect(switcher.attributes('data-message-id')).toBe(U1)
    expect(document.activeElement).toBe(switcher.get(`[data-testid="${testIds.messageBranchNext}"]`).element)
  })

  it('cancel deletes nothing and returns focus to "Delete this version"', async () => {
    const { wrapper } = await mountWithVersions([U1, U1B])
    await askToDelete(wrapper)
    const cancel = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Cancel')!
    cancel.click()
    await until(() => confirmButton() === null)
    await flushPromises()
    expect(api.chats.deleteMessage).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(wrapper.get(`[data-message-id="${U1B}"] [data-testid="${testIds.messageDeleteVersion}"]`).element)
  })

  it('reports failures: the last version, a running reply, a stale path', async () => {
    const { wrapper } = await mountWithVersions([U1, U1B])
    api.chats.deleteMessage.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'The message has no other version.', details: { reason: 'only-version' } }))
    await askToDelete(wrapper)
    confirmButton()!.click()
    await until(() => mock.toast.mock.calls.length === 1)
    expect(mock.toast).toHaveBeenCalledWith('Could not delete the version', { description: 'The message has no other version.' })
    await until(() => confirmButton() === null)
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).not.toBe('Version deleted')
    expect(document.activeElement).toBe(wrapper.get(`[data-message-id="${U1B}"] [data-testid="${testIds.messageDeleteVersion}"]`).element)

    api.chats.deleteMessage.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'A run is active.', details: { reason: 'run-active', chatId: chatId(9) } }))
    await askToDelete(wrapper)
    confirmButton()!.click()
    await until(() => mock.toast.mock.calls.length === 2)
    expect(mock.toast).toHaveBeenLastCalledWith('A response is already running in this chat.')
    await until(() => confirmButton() === null)
    await until(() => calls.some(call => call.url === `/api/chat/${chatId(9)}/stream`))

    await until(() => wrapper.find(`[data-message-id="${U1B}"] [data-testid="${testIds.messageDeleteVersion}"]`).exists())
    api.chats.deleteMessage.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Message not found.' }))
    await askToDelete(wrapper)
    confirmButton()!.click()
    await until(() => mock.toast.mock.calls.length === 3)
    expect(mock.toast).toHaveBeenLastCalledWith('This chat changed elsewhere and was reloaded.')
  })
})
