import type { ChatRequestBody, FileRef, HarnessUIMessage, QueueAddBody, QueueItem } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { UIMessageChunk } from 'ai'
import type { Mock } from 'vitest'
import type { TodoState } from './agent/todos'
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { defineComponent, effectScope, h, inject } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import ProjectTrustDialog from '~/components/projects/trust/ProjectTrustDialog.vue'
import { resetChatSessions, useChatSession } from '~/composables/useChatSession'
import { dispatchServerEvent } from '~/composables/useServerEvents'
import { useChatsStore } from '~/stores/chats'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import {
  assistantMessage,
  backgroundLaunchOutput,
  backgroundTask,
  backgroundTaskId,
  changeBatchId,
  chatDetail,
  chatId,
  chatSummary,
  hookCarrier,
  hookData,
  hookPart,
  messageBranch,
  projectId,
  projectSummary,
  queueItem,
  restoreResult,
  rewindPreview,
  taskInput,
  taskOutput,
  taskPart,
  taskResultCarrier,
  taskResultData,
  userMessage,
} from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import TodoStrip from './agent/TodoStrip.vue'
import { announcedTasks } from './background/background-agents'
import { AGENT_TASK_CONTEXT, CHAT_VIEW_ACTIONS, HOOK_ACTIVITY } from './chat-context'
import ChatTranscript from './ChatTranscript.vue'
import ChatView from './ChatView.vue'
import { TOOL_APPROVAL_CONTEXT } from './parts/tool-approval-context'
import QueuedMessages from './queue/QueuedMessages.vue'

type TodoStateFn = (messages: readonly HarnessUIMessage[]) => TodoState | null

const mock = vi.hoisted(() => ({
  api: null as unknown,
  fetch: null as unknown,
  composer: {
    setText: null as unknown as Mock,
    openModelPicker: null as unknown as Mock,
    focus: null as unknown as Mock,
    restoreQueued: null as unknown as Mock,
    showRefusal: null as unknown as Mock,
    restoreInput: null as unknown as Mock,
    /** What the composer's next submit sends (default: "Hello", no files). */
    input: null as unknown as { text: string, files: FileRef[] },
    /** The placeholder of the composer each `restoreInput` / `showRefusal` reached (the empty state's or the dock's). */
    reached: [] as string[],
  },
  /** `todoState` of the todo helpers (W9.10's): the real one unless a test replaces it. */
  todoState: null as unknown as Mock<TodoStateFn>,
  realTodoState: null as TodoStateFn | null,
  toast: null as unknown as Mock,
  customToast: null as unknown as Mock,
}))

vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api, useApiFetch: () => mock.fetch }))
vi.mock('~/components/chat/agent/todos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/components/chat/agent/todos')>()
  mock.realTodoState ??= actual.todoState
  mock.todoState ??= vi.fn(actual.todoState)
  return { ...actual, todoState: mock.todoState }
})
vi.mock('~/components/chat/nuxt-imports', () => ({
  useColorMode: () => ({ value: 'dark' }),
  useRoute: () => ({ path: '/', fullPath: '/', params: {}, query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), currentRoute: { value: { path: '/' } } }),
  navigateTo: vi.fn(),
}))
vi.mock('vue-sonner', () => {
  const toast = Object.assign((...args: unknown[]) => mock.toast(...args), {
    error: (...args: unknown[]) => mock.toast(...args),
    success: vi.fn(),
    custom: (...args: unknown[]) => mock.customToast(...args),
    dismiss: vi.fn(),
  })
  return { toast }
})
// The result note belongs to W10.11; this stand-in keeps its contract (docs/UI.md 7.29, 13.11): the root with its task
// id and variant, and the Show report toggle.
vi.mock('~/components/chat/agent/TaskResultNote.vue', async () => {
  const { defineComponent: define, h: render, ref: reference } = await import('vue')
  return {
    default: define({
      name: 'TaskResultNote',
      props: ['result', 'variant'],
      setup(props) {
        const open = reference(false)
        return () => render('div', {
          'data-testid': 'task-result',
          'data-task-id': props.result.taskId,
          'data-status': props.result.output.status,
          'data-variant': props.variant,
          'role': 'note',
        }, [
          render('button', {
            'type': 'button',
            'data-testid': 'task-result-toggle',
            'data-state': open.value ? 'open' : 'closed',
            'aria-expanded': String(open.value),
            'onClick': () => {
              open.value = !open.value
            },
          }, open.value ? 'Hide report' : 'Show report'),
        ])
      },
    }),
  }
})
// The real composer belongs to W2.3; this stand-in keeps its contract (docs/UI.md 10.4).
vi.mock('~/components/chat/composer/ChatComposer.vue', async () => {
  const { defineComponent: define, h: render, inject: injectFrom } = await import('vue')
  const { CHAT_VIEW_ACTIONS: viewActions } = await import('./chat-context')
  return {
    default: define({
      name: 'ChatComposer',
      props: ['chatId', 'status', 'modelRef', 'reasoningEffort', 'toolMode', 'usage', 'chatCostUsd', 'disabled', 'placeholder', 'previousImages', 'projectId', 'outputStyle'],
      emits: ['update:modelRef', 'update:reasoningEffort', 'update:toolMode', 'update:outputStyle', 'submit', 'stop', 'edit-last'],
      setup(props, { emit, expose }) {
        // Like the real composer: the refusal's Review… opens the trust dialog through the view's actions.
        const chatView = injectFrom(viewActions, null)
        expose({
          focus: () => mock.composer.focus(),
          setText: (text: string) => mock.composer.setText(text),
          openModelPicker: () => mock.composer.openModelPicker(),
          restoreQueued: (items: readonly QueueItem[]) => mock.composer.restoreQueued(items),
          showRefusal: (refusal: unknown) => {
            mock.composer.reached.push(`showRefusal:${props.placeholder}`)
            mock.composer.showRefusal(refusal)
          },
          restoreInput: (input: unknown) => {
            mock.composer.reached.push(`restoreInput:${props.placeholder}`)
            mock.composer.restoreInput(input)
          },
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
          'data-output-style': props.outputStyle ?? 'automatic',
          'onSubmit': (event: Event) => {
            event.preventDefault()
            emit('submit', mock.composer.input)
          },
        }, [
          render('button', { 'type': 'button', 'data-action': 'edit-last', 'onClick': () => emit('edit-last') }),
          render('button', { 'type': 'button', 'data-action': 'stop', 'onClick': () => emit('stop') }),
          render('button', { 'type': 'button', 'data-action': 'review', 'onClick': () => chatView?.openProjectTrust() }),
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
  announcedTasks.clear()
  calls = []
  replies = []
  mock.toast = vi.fn()
  mock.customToast = vi.fn()
  mock.composer.setText = vi.fn()
  mock.composer.openModelPicker = vi.fn()
  mock.composer.focus = vi.fn()
  mock.composer.restoreQueued = vi.fn()
  mock.composer.showRefusal = vi.fn()
  mock.composer.restoreInput = vi.fn()
  mock.composer.input = { text: 'Hello', files: [] }
  mock.composer.reached = []
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
    // + Phase 11: once the server took the message (W11.16: it accepted the request), not before.
    await until(() => created.mock.calls.length === 1)
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

describe('chatView: workspace 2.0 wiring (Phase 8)', () => {
  const U1 = 'msg_user0000000000r1'
  const A1 = 'msg_asst0000000000r1'
  const RUN_ACTIVE = 'Wait for the responses in this project to finish before rewinding files.'

  function rewindDialog(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>(`[data-testid="${testIds.rewindDialog}"]`)
  }

  function inDialog(testId: string): HTMLButtonElement | null {
    return document.body.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
  }

  /** The reply wrote a file with `write_file` (finished), so "Rewind files to here" shows on U1. */
  function editingReply() {
    return assistantMessage(A1, 'Done', {
      parts: [
        { type: 'tool-write_file', toolCallId: 'call_w1', state: 'output-available', input: { path: 'checkpoint.txt', content: 'Turn 1' }, output: { path: 'checkpoint.txt' } },
        { type: 'text', text: 'Done', state: 'done' },
      ] as never,
    })
  }

  async function mountProjectChat(options: { project?: string | null } = {}) {
    api.chats.get.mockResolvedValue(chatDetail({
      id: chatId(21),
      modelRef: MODEL,
      projectId: options.project === undefined ? projectId(1) : options.project,
      messages: [userMessage(U1, 'Fix the parser'), editingReply()],
    }))
    const view = mountView({ chatId: chatId(21) })
    await until(() => view.wrapper.find(`[data-testid="${testIds.messageAssistant}"]`).exists())
    return view
  }

  function rewindButton(wrapper: VueWrapper) {
    return wrapper.find(`[data-message-id="${U1}"] [data-testid="${testIds.messageRewind}"]`)
  }

  async function openRewind(wrapper: VueWrapper) {
    await rewindButton(wrapper).trigger('click')
    await until(() => rewindDialog()?.dataset.state !== undefined && rewindDialog()!.dataset.state !== 'loading')
  }

  it('offers "Rewind files to here" after agent edits in a project chat only', async () => {
    const { wrapper } = await mountProjectChat()
    expect(rewindButton(wrapper).exists()).toBe(true)
    expect(rewindDialog()).toBeNull()
    wrapper.unmount()

    resetChatSessions()
    const other = await mountProjectChat({ project: null })
    expect(other.wrapper.find(`[data-testid="${testIds.messageEdit}"]`).exists()).toBe(true)
    expect(rewindButton(other.wrapper).exists()).toBe(false)
  })

  it('restores the files: the result toast with Undo, focus back on the button, no reload', async () => {
    api.changes.rewindPreview.mockResolvedValue(rewindPreview({ messageId: U1 }))
    api.changes.rewind.mockResolvedValue(restoreResult({
      restored: ['checkpoint.txt'],
      deleted: ['new.txt'],
      skipped: [{ path: 'README.md', reason: 'conflict', message: 'Changed outside this chat.' }],
    }))
    const { wrapper } = await mountProjectChat()
    await openRewind(wrapper)
    expect(api.changes.rewindPreview).toHaveBeenCalledWith(expect.objectContaining({ params: { id: chatId(21) }, query: { messageId: U1 } }))
    expect(rewindDialog()!.dataset.state).toBe('ready')

    inDialog(testIds.rewindRestore)!.click()
    await until(() => rewindDialog() === null)
    expect(api.changes.rewind).toHaveBeenCalledWith({ params: { id: chatId(21) }, body: { messageId: U1, conflicts: 'skip' } })
    expect(mock.customToast).toHaveBeenCalledOnce()
    const props = (mock.customToast.mock.lastCall![1] as { componentProps: { title: string, lines: string[], undoable: boolean, onUndo: () => void } }).componentProps
    expect(props).toMatchObject({ title: 'Restored 2 files', lines: ['Skipped 1 file changed outside this chat'], undoable: true })
    await flushPromises()
    expect(document.activeElement).toBe(rewindButton(wrapper).element)
    // The conversation did not change: no reload.
    expect(api.chats.get).toHaveBeenCalledOnce()

    api.changes.undo.mockResolvedValue(restoreResult({ batchId: changeBatchId(2) }))
    props.onUndo()
    await flushPromises()
    expect(api.changes.undo).toHaveBeenCalledWith({ params: { id: chatId(21) }, body: { batchId: changeBatchId(1), conflicts: 'skip' } })
  })

  it('"Restore files and edit" opens the editor on the message', async () => {
    api.changes.rewindPreview.mockResolvedValue(rewindPreview({ messageId: U1 }))
    api.changes.rewind.mockResolvedValue(restoreResult())
    const { wrapper } = await mountProjectChat()
    await openRewind(wrapper)
    inDialog(testIds.rewindRestoreEdit)!.click()
    await until(() => wrapper.find(`[data-testid="${testIds.messageEditSave}"]`).exists())
    expect(rewindDialog()).toBeNull()
    expect(mock.customToast).toHaveBeenCalledOnce()
    const input = wrapper.get<HTMLTextAreaElement>(`[data-testid="${testIds.messageEditInput}"]`)
    expect(input.element.value).toBe('Fix the parser')
  })

  it('cancel restores nothing and returns focus to the button', async () => {
    api.changes.rewindPreview.mockResolvedValue(rewindPreview({ messageId: U1 }))
    const { wrapper } = await mountProjectChat()
    await openRewind(wrapper)
    const cancel = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Cancel')!
    cancel.click()
    await until(() => rewindDialog() === null)
    await flushPromises()
    expect(api.changes.rewind).not.toHaveBeenCalled()
    expect(mock.customToast).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(rewindButton(wrapper).element)
  })

  it('a running chat of the project: the toast, and this chat\'s run is followed', async () => {
    api.changes.rewindPreview.mockResolvedValue(rewindPreview({ messageId: U1 }))
    const { wrapper } = await mountProjectChat()

    api.changes.rewind.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'A chat of this project is running.', details: { reason: 'run-active', chatId: chatId(5) } }))
    await openRewind(wrapper)
    inDialog(testIds.rewindRestore)!.click()
    await until(() => rewindDialog() === null)
    expect(mock.toast).toHaveBeenCalledWith(RUN_ACTIVE)
    // Another chat runs: nothing to follow here.
    await flushPromises()
    expect(calls.filter(call => call.url.endsWith('/stream'))).toHaveLength(0)
    expect(mock.customToast).not.toHaveBeenCalled()

    api.changes.rewind.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'A chat of this project is running.', details: { reason: 'run-active', chatId: chatId(21) } }))
    await openRewind(wrapper)
    inDialog(testIds.rewindRestore)!.click()
    await until(() => rewindDialog() === null)
    expect(mock.toast).toHaveBeenCalledTimes(2)
    expect(mock.toast).toHaveBeenLastCalledWith(RUN_ACTIVE)
    await until(() => calls.some(call => call.url === `/api/chat/${chatId(21)}/stream`))
  })

  it('a stale path (404): the stale-chat toast and a reload', async () => {
    api.changes.rewindPreview.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: `Message ${U1} not found in chat ${chatId(21)}.` }))
    const { wrapper } = await mountProjectChat()
    await rewindButton(wrapper).trigger('click')
    await until(() => mock.toast.mock.calls.length === 1)
    expect(mock.toast).toHaveBeenCalledWith('This chat changed elsewhere and was reloaded.')
    await until(() => rewindDialog() === null)
    await until(() => api.chats.get.mock.calls.length === 2)
  })

  it('gives the approval cards the chat\'s project and its shell folder', async () => {
    api.chats.get.mockResolvedValue(chatDetail({ id: chatId(22), modelRef: MODEL, projectId: projectId(1), messages: [userMessage(U1, 'Hi')] }))
    const Probe = defineComponent({
      setup() {
        const context = inject(TOOL_APPROVAL_CONTEXT, null)
        return () => h('output', { 'data-testid': 'approval-context', 'data-project-id': context?.projectId() ?? 'none', 'data-cwd': context?.shellCwd() ?? 'root' })
      },
    })
    const wrapper = mount(defineComponent({
      setup: () => () => h(TooltipProvider, null, { default: () => h(ChatView, { chatId: chatId(22) }, { header: () => h(Probe) }) }),
    }), { attachTo: document.body, global: { stubs: { NuxtLink: { template: '<a><slot /></a>' } } } })
    mounted.push(wrapper)
    await until(() => wrapper.get('[data-testid="approval-context"]').attributes('data-project-id') === projectId(1))
    expect(wrapper.get('[data-testid="approval-context"]').attributes('data-cwd')).toBe(useChatSession(chatId(22)).cwd.value ?? 'root')
  })

  it('names a failed rule save "Could not save the rule"', async () => {
    const { wrapper } = await mountProjectChat()
    const session = useChatSession(chatId(21))
    vi.spyOn(session, 'approve').mockRejectedValue(new HarnessError({ code: 'validation_error', message: 'The prefix is not allowed.' }))
    wrapper.getComponent(ChatTranscript).vm.$emit('approval', {
      id: 'appr_1',
      approved: true,
      toolName: 'shell',
      alwaysAllow: false,
      allowRules: { prefixes: ['pnpm test'], scope: 'project' },
    })
    await until(() => mock.toast.mock.calls.length === 1)
    expect(mock.toast).toHaveBeenCalledWith('Could not save the rule', { description: 'The prefix is not allowed.' })
  })
})

// ---------- Agent 2.0 (Phase 9, W9.9) ----------

/** A reply stream written by `writer` (chunks typed loosely: data parts included). */
function streamReply(writer: (write: (chunk: UIMessageChunk) => void) => Promise<void> | void): () => Response {
  return () => createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: async ({ writer: out }) => {
        await writer(chunk => out.write(chunk as never))
      },
    }),
  })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** A text reply that waits for `gate` before it finishes. */
function gatedReply(text: string, gate: Promise<void>): () => Response {
  return streamReply(async (write) => {
    write({ type: 'start', messageId: 'msg_asst000000000001', messageMetadata: { modelRef: MODEL, startedAt: 1 } })
    // A new step: an approval continuation is complete once it streams (no second automatic request).
    write({ type: 'start-step' })
    write({ type: 'text-start', id: 't' })
    write({ type: 'text-delta', id: 't', delta: text })
    await gate
    write({ type: 'text-end', id: 't' })
    write({ type: 'finish', messageMetadata: { modelRef: MODEL, startedAt: 1, durationMs: 2000 } })
  })
}

/** The text of ChatView's polite live region (the last `role="status"` element of the view). */
function announced(wrapper: VueWrapper): string {
  return wrapper.findAll('[role="status"]').at(-1)!.text()
}

/** `POST /chat/:id/queue` answers with the stored item, like the server (W9.2). */
function acceptQueue() {
  api.chatQueue.add.mockImplementation(async ({ body }: { body: QueueAddBody }): Promise<QueueItem> => ({
    id: body.message.id,
    message: body.message,
    modelRef: body.modelRef,
    reasoningEffort: body.reasoningEffort,
    toolMode: body.toolMode,
    createdAt: 1,
    turnOnly: false,
  }))
}

const chatPosts = () => calls.filter(call => call.url === '/api/chat')

describe('chatView: queue and stop (Phase 9)', () => {
  beforeEach(() => {
    api.chatQueue.list.mockResolvedValue({ items: [] })
    api.chats.get.mockResolvedValue(chatDetail({
      id: chatId(2),
      modelRef: MODEL,
      messages: [
        { id: 'msg_user000000000001', role: 'user', parts: [{ type: 'text', text: 'First question' }] },
        { id: 'msg_asst000000000009', role: 'assistant', metadata: { modelRef: MODEL, startedAt: 1 }, parts: [{ type: 'text', text: 'Answer', state: 'done' }] },
      ],
    }))
  })

  async function streamingView() {
    const view = mountView({ chatId: chatId(2) })
    await until(() => view.wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    const gate = deferred()
    replies.push(gatedReply('Working on it', gate.promise))
    await view.wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => view.wrapper.get('[data-testid="composer"]').attributes('data-status') === 'streaming')
    return { ...view, gate }
  }

  it('stacks the queued messages above the composer and hides the empty dock parts', async () => {
    const { wrapper } = mountView({ chatId: chatId(2) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    expect(api.chatQueue.list).toHaveBeenCalledWith({ params: { id: chatId(2) } })
    expect(wrapper.find(`[data-testid="${testIds.queuedMessages}"]`).exists()).toBe(false)
    expect(wrapper.find(`[data-testid="${testIds.todoStrip}"]`).exists()).toBe(false)
    expect(wrapper.getComponent(ChatTranscript).props('activity')).toBeNull()

    dispatchServerEvent(createServerEvent('queue.changed', { chatId: chatId(2), items: [queueItem()] }))
    await flushPromises()
    const queued = wrapper.get(`[data-testid="${testIds.queuedMessages}"]`)
    expect(queued.attributes('data-count')).toBe('1')
    expect(queued.attributes('data-state')).toBe('queued')
    const composer = wrapper.get('[data-testid="composer"]')
    expect(queued.element.compareDocumentPosition(composer.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    dispatchServerEvent(createServerEvent('queue.changed', { chatId: chatId(1), items: [queueItem()] }))
    dispatchServerEvent(createServerEvent('chat.deleted', { id: chatId(1) }))
    await flushPromises()
    expect(wrapper.get(`[data-testid="${testIds.queuedMessages}"]`).attributes('data-count')).toBe('1')
  })

  it('queues a message sent while the reply streams and announces it', async () => {
    const { wrapper, gate } = await streamingView()
    acceptQueue()
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => announced(wrapper) === 'Message queued')
    expect(api.chatQueue.add).toHaveBeenCalledOnce()
    expect(chatPosts()).toHaveLength(1)
    await until(() => wrapper.find(`[data-testid="${testIds.queuedMessages}"]`).exists())
    expect(wrapper.findAll(`[data-testid="${testIds.messageUser}"]`)).toHaveLength(2)
    expect(mock.toast).not.toHaveBeenCalled()
    gate.resolve()
    await until(() => wrapper.get('[data-testid="composer"]').attributes('data-status') === 'ready')
  })

  it('a full queue puts the text back with its toast; another failure with an error toast', async () => {
    const { wrapper, gate } = await streamingView()
    api.chatQueue.add.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'The queue is full.', details: { reason: 'queue-full' } }))
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => mock.toast.mock.calls.length === 1)
    expect(mock.toast).toHaveBeenCalledWith('The queue is full. Wait for the agent to take a message.')
    expect(mock.composer.setText).toHaveBeenCalledWith('Hello')

    api.chatQueue.add.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Something went wrong.' }))
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => mock.toast.mock.calls.length === 2)
    expect(mock.toast).toHaveBeenLastCalledWith('Could not send the message', { description: 'Something went wrong.' })
    expect(mock.composer.setText).toHaveBeenCalledTimes(2)
    expect(chatPosts()).toHaveLength(1)
    gate.resolve()
    await until(() => wrapper.get('[data-testid="composer"]').attributes('data-status') === 'ready')
  })

  it('stop hands the messages it dropped back to the composer of this tab', async () => {
    const { wrapper, gate } = await streamingView()
    const item = queueItem()
    dispatchServerEvent(createServerEvent('queue.changed', { chatId: chatId(2), items: [item] }))
    api.chat.stop.mockResolvedValue({ stopped: true, dropped: [item] })
    await wrapper.get('[data-action="stop"]').trigger('click')
    await until(() => mock.composer.restoreQueued.mock.calls.length === 1)
    expect(mock.composer.restoreQueued).toHaveBeenCalledWith([item])
    expect(wrapper.find(`[data-testid="${testIds.queuedMessages}"]`).exists()).toBe(false)
    gate.resolve()
    await until(() => announced(wrapper) === 'Response stopped')
  })

  it('stops without restoring anything while nothing was queued', async () => {
    api.chat.stop.mockResolvedValue({ stopped: false })
    const { wrapper } = mountView({ chatId: chatId(2) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    await wrapper.get('[data-action="stop"]').trigger('click')
    await flushPromises()
    expect(api.chat.stop).toHaveBeenCalledWith({ params: { id: chatId(2) } })
    expect(mock.composer.restoreQueued).not.toHaveBeenCalled()
    expect(mock.toast).not.toHaveBeenCalled()
  })

  it('cancel: the row shows cancelling meanwhile; "Already sent to the agent." when it was delivered first', async () => {
    const { wrapper } = mountView({ chatId: chatId(2) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    const first = queueItem()
    const second = queueItem({ id: 'msg_queued2000000000', text: 'Second' })
    dispatchServerEvent(createServerEvent('queue.changed', { chatId: chatId(2), items: [first, second] }))
    await flushPromises()
    const list = () => wrapper.getComponent(QueuedMessages)

    let answer!: () => void
    api.chatQueue.remove.mockImplementationOnce(() => new Promise<void>((resolve) => {
      answer = resolve
    }))
    list().vm.$emit('cancel', first.id)
    await flushPromises()
    expect(list().props('cancelling')).toEqual([first.id])
    answer()
    await until(() => list().props('items').length === 1)
    expect(list().props('cancelling')).toEqual([])
    expect(mock.toast).not.toHaveBeenCalled()

    api.chatQueue.remove.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Not queued.' }))
    list().vm.$emit('cancel', second.id)
    await until(() => mock.toast.mock.calls.length === 1)
    expect(mock.toast).toHaveBeenCalledWith('Already sent to the agent.')
    expect(wrapper.find(`[data-testid="${testIds.queuedMessages}"]`).exists()).toBe(false)
    expect(mock.composer.restoreQueued).not.toHaveBeenCalled()
  })

  it('edit cancels the message, then puts it back into the composer (not when it was already sent)', async () => {
    const { wrapper } = mountView({ chatId: chatId(2) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    const first = queueItem()
    const second = queueItem({ id: 'msg_queued2000000000', text: 'Second' })
    dispatchServerEvent(createServerEvent('queue.changed', { chatId: chatId(2), items: [first, second] }))
    await flushPromises()
    api.chatQueue.remove.mockResolvedValueOnce(undefined)
    wrapper.getComponent(QueuedMessages).vm.$emit('edit', first.id)
    await until(() => mock.composer.restoreQueued.mock.calls.length === 1)
    expect(api.chatQueue.remove).toHaveBeenCalledWith({ params: { id: chatId(2), itemId: first.id } })
    expect(mock.composer.restoreQueued).toHaveBeenCalledWith([first])

    api.chatQueue.remove.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Not queued.' }))
    wrapper.getComponent(QueuedMessages).vm.$emit('edit', second.id)
    await until(() => mock.toast.mock.calls.length === 1)
    expect(mock.toast).toHaveBeenCalledWith('Already sent to the agent.')
    expect(mock.composer.restoreQueued).toHaveBeenCalledOnce()
  })

  it('queued messages wait while the chat awaits an approval', async () => {
    api.chats.get.mockResolvedValue(chatDetail({
      id: chatId(2),
      modelRef: MODEL,
      messages: [
        userMessage('msg_user000000000001', 'Use it'),
        { id: 'msg_asst000000000009', role: 'assistant', metadata: { modelRef: MODEL, startedAt: 1 }, parts: [{ type: 'tool-mock_approval_tool', toolCallId: 'call_1', state: 'approval-requested', input: { value: 'x' }, approval: { id: 'appr_1' } }] },
      ],
    }))
    const { wrapper } = mountView({ chatId: chatId(2) })
    await until(() => wrapper.find(`[data-testid="${testIds.toolApproval}"]`).exists())
    dispatchServerEvent(createServerEvent('queue.changed', { chatId: chatId(2), items: [queueItem()] }))
    await flushPromises()
    expect(wrapper.getComponent(QueuedMessages).props('waitingForApproval')).toBe(true)
    expect(wrapper.get(`[data-testid="${testIds.queuedMessages}"]`).attributes('data-state')).toBe('approval')
  })
})

describe('chatView: plan approval (Phase 9)', () => {
  function planChat(n: number) {
    api.chatQueue.list.mockResolvedValue({ items: [] })
    api.chats.update.mockResolvedValue(chatDetail({ id: chatId(n) }))
    api.chats.get.mockResolvedValue(chatDetail({
      id: chatId(n),
      modelRef: MODEL,
      projectId: projectId(1),
      settings: { toolMode: 'plan' },
      messages: [
        userMessage('msg_user000000000001', 'Plan the notes file'),
        {
          id: 'msg_asst000000000009',
          role: 'assistant',
          metadata: { modelRef: MODEL, startedAt: 1 },
          parts: [{ type: 'tool-exit_plan_mode', toolCallId: 'call_plan', state: 'approval-requested', input: { plan: '# Plan\n1. Write notes.txt' }, approval: { id: 'appr_plan' } }],
        },
      ],
    }))
  }

  it('"Approve, accept edits": the continuation runs in edits, the decision is announced, focus goes back to the composer', async () => {
    planChat(20)
    const { wrapper } = mountView({ chatId: chatId(20) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageAssistant}"]`).length === 1)
    expect(wrapper.get('[data-testid="composer"]').attributes('data-tool-mode')).toBe('plan')
    const gate = deferred()
    replies.push(gatedReply('Writing notes.txt', gate.promise))
    wrapper.getComponent(ChatTranscript).vm.$emit('approval', { id: 'appr_plan', approved: true, toolName: 'exit_plan_mode', alwaysAllow: false, planMode: 'edits' })
    await until(() => announced(wrapper) === 'Plan approved. Permission mode: Accept edits.')
    expect(mock.composer.focus).toHaveBeenCalled()
    await until(() => chatPosts().length === 1)
    expect(chatPosts()[0]!.body).toMatchObject({ toolMode: 'edits', message: { role: 'assistant' } })
    expect(api.chats.update).toHaveBeenCalledWith({ params: { id: chatId(20) }, body: { settings: { toolMode: 'edits' } } })
    expect(wrapper.get('[data-testid="composer"]').attributes('data-tool-mode')).toBe('edits')
    gate.resolve()
    await until(() => wrapper.text().includes('Writing notes.txt'))
  })

  it('"Approve, ask before edits" announces Ask', async () => {
    planChat(21)
    const { wrapper } = mountView({ chatId: chatId(21) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageAssistant}"]`).length === 1)
    const gate = deferred()
    replies.push(gatedReply('Asking first', gate.promise))
    wrapper.getComponent(ChatTranscript).vm.$emit('approval', { id: 'appr_plan', approved: true, toolName: 'exit_plan_mode', alwaysAllow: false, planMode: 'ask' })
    await until(() => announced(wrapper) === 'Plan approved. Permission mode: Ask.')
    await until(() => chatPosts().length === 1)
    expect(chatPosts()[0]!.body!.toolMode).toBe('ask')
    gate.resolve()
    await until(() => wrapper.get('[data-testid="composer"]').attributes('data-status') === 'ready')
  })

  it('"Keep planning" sends the feedback, keeps plan and says so', async () => {
    planChat(22)
    const { wrapper } = mountView({ chatId: chatId(22) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageAssistant}"]`).length === 1)
    const gate = deferred()
    replies.push(gatedReply('Revising: keep the old API', gate.promise))
    wrapper.getComponent(ChatTranscript).vm.$emit('approval', { id: 'appr_plan', approved: false, toolName: 'exit_plan_mode', alwaysAllow: false, reason: 'Keep the old API' })
    await until(() => announced(wrapper) === 'Feedback sent. The agent keeps planning.')
    await until(() => chatPosts().length === 1)
    const body = chatPosts()[0]!.body!
    expect(body.toolMode).toBe('plan')
    expect(body.message.parts.find(part => part.type === 'tool-exit_plan_mode')).toMatchObject({ approval: { approved: false, reason: 'Keep the old API' } })
    expect(api.chats.update).not.toHaveBeenCalled()
    gate.resolve()
    await until(() => wrapper.get('[data-testid="composer"]').attributes('data-status') === 'ready')
  })

  it('other approvals announce nothing extra', async () => {
    api.chatQueue.list.mockResolvedValue({ items: [] })
    api.chats.get.mockResolvedValue(chatDetail({
      id: chatId(23),
      modelRef: MODEL,
      messages: [
        userMessage('msg_user000000000001', 'Use it'),
        { id: 'msg_asst000000000009', role: 'assistant', metadata: { modelRef: MODEL, startedAt: 1 }, parts: [{ type: 'tool-mock_approval_tool', toolCallId: 'call_1', state: 'approval-requested', input: { value: 'x' }, approval: { id: 'appr_1' } }] },
      ],
    }))
    const { wrapper } = mountView({ chatId: chatId(23) })
    await until(() => announced(wrapper) === 'Approval needed: mock_approval_tool')
    const gate = deferred()
    replies.push(gatedReply('Done', gate.promise))
    wrapper.getComponent(ChatTranscript).vm.$emit('approval', { id: 'appr_1', approved: true, toolName: 'mock_approval_tool', alwaysAllow: false })
    await until(() => chatPosts().length === 1)
    await flushPromises()
    expect(announced(wrapper)).toBe('Approval needed: mock_approval_tool')
    expect(mock.composer.focus).not.toHaveBeenCalled()
    gate.resolve()
    await until(() => wrapper.get('[data-testid="composer"]').attributes('data-status') === 'ready')
  })
})

describe('chatView: compaction and todos (Phase 9)', () => {
  const compaction = { trigger: 'manual', keep: 'none', summary: 'The user wants notes.', modelRef: 'mock:compact', messagesCompacted: 2, tokensBefore: 1200, tokensAfter: 90, createdAt: 1_759_000_000_000 }

  beforeEach(() => {
    api.chatQueue.list.mockResolvedValue({ items: [] })
  })

  it('announces "Conversation compacted" for a /compact reply that streams and finishes within one tick', async () => {
    api.chats.get.mockResolvedValue(chatDetail({
      id: chatId(31),
      modelRef: MODEL,
      messages: [userMessage('msg_user000000000001', 'Hi'), assistantMessage('msg_asst000000000009', 'Hello')],
    }))
    const { wrapper } = mountView({ chatId: chatId(31) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    const seen: string[] = []
    const region = wrapper.findAll('[role="status"]').at(-1)!.element
    const observer = new MutationObserver(() => seen.push(region.textContent ?? ''))
    observer.observe(region, { childList: true, characterData: true, subtree: true })
    replies.push(streamReply(async (write) => {
      write({ type: 'start', messageId: 'msg_asst000000000011', messageMetadata: { modelRef: MODEL, startedAt: 1 } })
      write({ type: 'data-compaction', id: 'cmp_2', data: compaction } as UIMessageChunk)
      write({ type: 'finish', messageMetadata: { modelRef: MODEL, startedAt: 1, durationMs: 1 } })
    }))
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => seen.some(text => text.includes('Response finished')))
    observer.disconnect()
    expect(seen.some(text => text.includes('Conversation compacted'))).toBe(true)
  })

  it('announces "Conversation compacted" once, when a marker arrives in this tab\'s stream', async () => {
    api.chats.get.mockResolvedValue(chatDetail({
      id: chatId(30),
      modelRef: MODEL,
      messages: [userMessage('msg_user000000000001', 'Hi'), assistantMessage('msg_asst000000000009', 'Hello')],
    }))
    const { wrapper } = mountView({ chatId: chatId(30) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    const gate = deferred()
    replies.push(streamReply(async (write) => {
      write({ type: 'start', messageId: 'msg_asst000000000010', messageMetadata: { modelRef: MODEL, startedAt: 1 } })
      write({ type: 'data-activity', data: { kind: 'compacting' }, transient: true } as UIMessageChunk)
      write({ type: 'data-compaction', id: 'cmp_1', data: compaction } as UIMessageChunk)
      write({ type: 'data-activity', data: { kind: 'idle' }, transient: true } as UIMessageChunk)
      await gate.promise
      write({ type: 'finish', messageMetadata: { modelRef: MODEL, startedAt: 1, durationMs: 10 } })
    }))
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => announced(wrapper) === 'Conversation compacted')
    gate.resolve()
    await until(() => announced(wrapper) === 'Response finished')
    // The stored path comes back with the marker (another tab's run finished): nothing is announced again.
    api.chats.get.mockResolvedValue(chatDetail({
      id: chatId(30),
      modelRef: MODEL,
      messages: [
        userMessage('msg_user000000000001', 'Hi'),
        assistantMessage('msg_asst000000000009', 'Hello'),
        userMessage('msg_user000000000002', 'Hello'),
        { id: 'msg_asst000000000010', role: 'assistant', metadata: { modelRef: MODEL, startedAt: 1 }, parts: [{ type: 'data-compaction', id: 'cmp_1', data: compaction } as never] },
      ],
    }))
    dispatchServerEvent(createServerEvent('run.finished', { chatId: chatId(30), messageId: 'msg_asst000000000077', outcome: 'completed', awaitingApproval: false }))
    await until(() => api.chats.get.mock.calls.length === 2)
    await flushPromises()
    expect(announced(wrapper)).toBe('Response finished')
  })

  it('a loaded path with a marker announces nothing', async () => {
    api.chats.get.mockResolvedValue(chatDetail({
      id: chatId(31),
      modelRef: MODEL,
      messages: [
        userMessage('msg_user000000000001', '/compact'),
        { id: 'msg_asst000000000010', role: 'assistant', metadata: { modelRef: MODEL, startedAt: 1 }, parts: [{ type: 'data-compaction', id: 'cmp_1', data: compaction } as never] },
      ],
    }))
    const { wrapper } = mountView({ chatId: chatId(31) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    await flushPromises()
    expect(announced(wrapper)).toBe('')
  })

  it('shows the todo strip from the session\'s todos, running while a run is active', async () => {
    const state: TodoState = {
      todos: [
        { id: 't1', content: 'Read the parser', status: 'completed' },
        { id: 't2', content: 'Run the tests', status: 'in_progress', activeForm: 'Running the tests' },
        { id: 't3', content: 'Fix the bug', status: 'pending' },
      ],
      done: 1,
      total: 3,
      current: { id: 't2', content: 'Run the tests', status: 'in_progress', activeForm: 'Running the tests' },
      messageId: 'msg_asst000000000009',
      live: true,
    }
    mock.todoState.mockImplementation(messages => (messages.length > 0 ? state : null))
    try {
      api.chats.get.mockResolvedValue(chatDetail({
        id: chatId(32),
        modelRef: MODEL,
        messages: [userMessage('msg_user000000000001', 'Do it'), assistantMessage('msg_asst000000000009', 'Working')],
      }))
      const { wrapper } = mountView({ chatId: chatId(32) })
      await until(() => wrapper.find(`[data-testid="${testIds.todoStrip}"]`).exists())
      const strip = wrapper.get(`[data-testid="${testIds.todoStrip}"]`)
      expect(strip.attributes('data-count')).toBe('3')
      expect(strip.attributes('data-value')).toBe('1')
      const component = wrapper.getComponent(TodoStrip)
      expect(component.props('state')).toEqual(state)
      expect(component.props('running')).toBe(false)
      // The strip sits above the queue and the composer.
      const composer = wrapper.get('[data-testid="composer"]')
      expect(strip.element.compareDocumentPosition(composer.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      const gate = deferred()
      replies.push(gatedReply('Still working', gate.promise))
      await composer.trigger('submit')
      await until(() => component.props('running') === true)
      gate.resolve()
      await until(() => component.props('running') === false)
    }
    finally {
      mock.todoState.mockImplementation(mock.realTodoState!)
    }
  })
})

describe('chatView: background agents (Phase 10)', () => {
  const U1 = 'msg_user000000000001'
  const running = backgroundTask({ chatId: chatId(30), status: 'running', finishedAt: null, output: taskOutput({ status: 'running', description: 'Find flaky tests', finishedAt: undefined }) })

  it('stacks the background agents between the todo strip and the queue, and stops one through the session', async () => {
    api.chatQueue.list.mockResolvedValue({ items: [] })
    api.chats.get.mockResolvedValue(chatDetail({ id: chatId(30), modelRef: MODEL, messages: [userMessage(U1, 'Hi')] }))
    const { wrapper } = mountView({ chatId: chatId(30) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    expect(wrapper.find(`[data-testid="${testIds.backgroundAgents}"]`).exists()).toBe(false)

    dispatchServerEvent(createServerEvent('task.changed', { chatId: chatId(30), task: running }))
    dispatchServerEvent(createServerEvent('queue.changed', { chatId: chatId(30), items: [queueItem()] }))
    await flushPromises()
    const dock = wrapper.get(`[data-testid="${testIds.backgroundAgents}"]`)
    expect(dock.attributes('data-count')).toBe('1')
    const queued = wrapper.get(`[data-testid="${testIds.queuedMessages}"]`)
    expect(dock.element.compareDocumentPosition(queued.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    api.chatTasks.stop.mockResolvedValueOnce({ ...running, status: 'completed', finishedAt: 1_759_000_050_000 })
    wrapper.getComponent({ name: 'BackgroundAgents' }).vm.$emit('stop', running.id)
    await until(() => mock.toast.mock.calls.some(call => call[0] === 'It already finished.'))
    expect(api.chatTasks.stop).toHaveBeenCalledWith({ params: { id: chatId(30), taskId: running.id } })
  })

  it('gives task blocks the live task, the delivered result of the path and the dock reveal', async () => {
    api.chatQueue.list.mockResolvedValue({ items: [] })
    const carrier = taskResultCarrier('msg_carrier000000001')
    api.chats.get.mockResolvedValue(chatDetail({ id: chatId(31), modelRef: MODEL, messages: [userMessage(U1, 'Hi'), carrier] }))
    const Probe = defineComponent({
      setup() {
        const context = inject(AGENT_TASK_CONTEXT, null)
        return () => h('output', {
          'data-testid': 'agent-task-context',
          'data-live': context?.task(backgroundTaskId(2))?.status ?? 'none',
          'data-result': context?.result(backgroundTaskId(1))?.output.status ?? 'none',
          'data-project-id': context?.projectId() ?? 'none',
          'onClick': () => context?.reveal(backgroundTaskId(2)),
        })
      },
    })
    const wrapper = mount(defineComponent({
      setup: () => () => h(TooltipProvider, null, { default: () => h(ChatView, { chatId: chatId(31) }, { header: () => h(Probe) }) }),
    }), { attachTo: document.body, global: { stubs: { NuxtLink: { template: '<a><slot /></a>' } } } })
    mounted.push(wrapper)
    await until(() => wrapper.get('[data-testid="agent-task-context"]').attributes('data-result') === 'completed')
    // The carrier renders its result notes, not a bubble.
    expect(wrapper.find(`[data-testid="${testIds.taskResult}"][data-variant="turn"]`).exists()).toBe(true)
    dispatchServerEvent(createServerEvent('task.changed', { chatId: chatId(31), task: { ...running, id: backgroundTaskId(2), chatId: chatId(31) } }))
    await flushPromises()
    const probe = wrapper.get('[data-testid="agent-task-context"]')
    expect(probe.attributes('data-live')).toBe('running')
    expect(probe.attributes('data-project-id')).toBe('none')
    await probe.trigger('click')
    expect(wrapper.getComponent({ name: 'BackgroundAgents' }).props('reveal')).toEqual({ taskId: backgroundTaskId(2), n: 1 })
  })

  it('stop all stops each running agent in turn; a failure shows the error toast; the composer\'s Stop never stops them', async () => {
    api.chatQueue.list.mockResolvedValue({ items: [] })
    const other = { ...running, id: backgroundTaskId(3) }
    api.chatTasks.list.mockResolvedValue({ items: [running, other] })
    api.chats.get.mockResolvedValue(chatDetail({ id: chatId(30), modelRef: MODEL, messages: [userMessage(U1, 'Hi')] }))
    api.chat.stop.mockResolvedValue({ stopped: false })
    const { wrapper } = mountView({ chatId: chatId(30) })
    await until(() => wrapper.find(`[data-testid="${testIds.backgroundAgents}"]`).exists())
    expect(api.chatTasks.list).toHaveBeenCalledWith({ params: { id: chatId(30) } })
    expect(wrapper.get(`[data-testid="${testIds.backgroundAgents}"]`).attributes()).toMatchObject({ 'data-count': '2', 'data-total': '2' })

    await wrapper.get('[data-action="stop"]').trigger('click')
    await flushPromises()
    expect(api.chat.stop).toHaveBeenCalledOnce()
    expect(api.chatTasks.stop).not.toHaveBeenCalled()

    api.chatTasks.stop.mockResolvedValueOnce({ ...running, status: 'aborted', finishedAt: 1_759_000_050_000 })
    api.chatTasks.stop.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Boom' }))
    wrapper.getComponent({ name: 'BackgroundAgents' }).vm.$emit('stop-all')
    wrapper.getComponent({ name: 'BackgroundAgents' }).vm.$emit('stop-all')
    await until(() => mock.toast.mock.calls.length === 1)
    expect(mock.toast).toHaveBeenCalledWith('Could not stop the background agent', { description: 'Boom' })
    expect(api.chatTasks.stop.mock.calls.map(call => (call[0] as { params: { taskId: string } }).params.taskId)).toEqual([running.id, other.id])
    await until(() => wrapper.get(`[data-testid="${testIds.backgroundAgents}"]`).attributes('data-count') === '1')
  })

  it('the dock\'s rows open TaskBody with the prompt of the call that launched them', async () => {
    api.chatQueue.list.mockResolvedValue({ items: [] })
    const launch = { id: 'msg_asst000000000007', role: 'assistant' as const, metadata: { modelRef: MODEL, startedAt: 1 }, parts: [taskPart({ toolCallId: running.toolCallId, input: taskInput({ description: 'Find flaky tests', prompt: 'Run the suite ten times.', background: true }), output: backgroundLaunchOutput() })] }
    const task = { ...running, messageId: launch.id }
    api.chatTasks.list.mockResolvedValue({ items: [task, { ...task, id: backgroundTaskId(4), toolCallId: 'call_elsewhere' }] })
    api.chats.get.mockResolvedValue(chatDetail({ id: chatId(30), modelRef: MODEL, messages: [userMessage(U1, 'Hi'), launch] }))
    const { wrapper } = mountView({ chatId: chatId(30) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.backgroundAgent}"]`).length === 2)
    const rows = wrapper.findAll(`[data-testid="${testIds.backgroundAgent}"]`)
    // The call of the second task is not on the path: no details toggle.
    expect(rows[1]!.find(`[data-testid="${testIds.backgroundAgentToggle}"]`).exists()).toBe(false)
    await rows[0]!.get(`[data-testid="${testIds.backgroundAgentToggle}"]`).trigger('click')
    expect(rows[0]!.get('[data-slot="task-body"]').text()).toContain('Run the suite ten times.')
  })

  it('"Go to the result" scrolls to the note, opens its report and focuses its toggle; false without a result', async () => {
    api.chatQueue.list.mockResolvedValue({ items: [] })
    const carrier = taskResultCarrier('msg_carrier000000001')
    api.chats.get.mockResolvedValue(chatDetail({ id: chatId(31), modelRef: MODEL, messages: [userMessage(U1, 'Hi'), carrier] }))
    let showResult: ((taskId: string) => boolean) | undefined
    const Probe = defineComponent({
      setup() {
        showResult = inject(AGENT_TASK_CONTEXT, null)?.showResult
        return () => null
      },
    })
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    onTestFinished(() => scrolled.mockRestore())
    const wrapper = mount(defineComponent({
      setup: () => () => h(TooltipProvider, null, { default: () => h(ChatView, { chatId: chatId(31) }, { header: () => h(Probe) }) }),
    }), { attachTo: document.body, global: { stubs: { NuxtLink: { template: '<a><slot /></a>' } } } })
    mounted.push(wrapper)
    await until(() => wrapper.find(`[data-testid="${testIds.taskResult}"]`).exists())
    expect(showResult!(backgroundTaskId(9))).toBe(false)
    expect(showResult!(backgroundTaskId(1))).toBe(true)
    const toggle = wrapper.get(`[data-testid="${testIds.taskResult}"] [data-testid="${testIds.taskResultToggle}"]`)
    expect(scrolled).toHaveBeenCalledOnce()
    await flushPromises()
    expect(toggle.attributes()).toMatchObject({ 'aria-expanded': 'true', 'data-state': 'open' })
    expect(document.activeElement).toBe(toggle.element)
    // Already open: it stays open.
    expect(showResult!(backgroundTaskId(1))).toBe(true)
    await flushPromises()
    expect(toggle.attributes('data-state')).toBe('open')
  })

  it('a turn the server started for finished agents announces each result once its carrier shows; a loaded carrier says nothing', async () => {
    api.chatQueue.list.mockResolvedValue({ items: [] })
    const loadedCarrier = taskResultCarrier('msg_carrier000000001')
    const base = [userMessage(U1, 'Hi'), loadedCarrier]
    api.chats.get.mockResolvedValueOnce(chatDetail({ id: chatId(32), modelRef: MODEL, messages: base }))
    const { wrapper } = mountView({ chatId: chatId(32) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.taskResult}"]`).length === 1)
    expect(announced(wrapper)).toBe('')

    const results = [
      taskResultData({ taskId: backgroundTaskId(2), output: taskOutput({ description: 'Find flaky tests' }) }),
      taskResultData({ taskId: backgroundTaskId(3), output: taskOutput({ status: 'failed', description: 'Review the diff', error: 'Boom' }) }),
    ]
    const carrier = taskResultCarrier('msg_carrier000000002', results)
    api.chats.get.mockResolvedValue(chatDetail({ id: chatId(32), modelRef: MODEL, running: true, messages: [...base, carrier] }))
    dispatchServerEvent(createServerEvent('run.started', { chatId: chatId(32), messageId: 'msg_asst000000000002', modelRef: MODEL, origin: 'task', userMessageId: carrier.id }))
    await until(() => announced(wrapper) === 'Background agent finished: Find flaky tests. Background agent failed: Review the diff')
    expect(wrapper.findAll(`[data-testid="${testIds.taskResult}"]`)).toHaveLength(3)
    // Once per carrier: a second event for it says nothing new.
    dispatchServerEvent(createServerEvent('run.started', { chatId: chatId(32), messageId: 'msg_asst000000000002', modelRef: MODEL, origin: 'task', userMessageId: carrier.id }))
    await flushPromises()
    expect(announced(wrapper)).toBe('Background agent finished: Find flaky tests. Background agent failed: Review the diff')
  })

  it('announces each finished agent once per tab: the dock saw it end, so its carrier turn says nothing more', async () => {
    api.chatQueue.list.mockResolvedValue({ items: [] })
    api.chatTasks.list.mockResolvedValue({ items: [] })
    const base = [userMessage(U1, 'Hi')]
    api.chats.get.mockResolvedValueOnce(chatDetail({ id: chatId(33), modelRef: MODEL, messages: base }))
    const { wrapper } = mountView({ chatId: chatId(33) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    const live = { ...running, chatId: chatId(33) }
    dispatchServerEvent(createServerEvent('task.changed', { chatId: chatId(33), task: live }))
    await flushPromises()
    const done = { ...live, status: 'completed' as const, finishedAt: 1_759_000_041_000, output: { ...live.output, status: 'completed' as const } }
    dispatchServerEvent(createServerEvent('task.changed', { chatId: chatId(33), task: done }))
    const dockAnnouncer = () => wrapper.get('[data-slot="background-agents-announcer"]').text()
    await until(() => dockAnnouncer() === 'Background agent finished: Find flaky tests')

    const carrier = taskResultCarrier('msg_carrier000000003', [taskResultData({ taskId: live.id, output: done.output })])
    api.chats.get.mockResolvedValue(chatDetail({ id: chatId(33), modelRef: MODEL, running: true, messages: [...base, carrier] }))
    dispatchServerEvent(createServerEvent('task.changed', { chatId: chatId(33), task: { ...done, deliveredAt: 1_759_000_042_000, deliveredMessageId: carrier.id } }))
    dispatchServerEvent(createServerEvent('run.started', { chatId: chatId(33), messageId: 'msg_asst000000000003', modelRef: MODEL, origin: 'task', userMessageId: carrier.id }))
    await until(() => wrapper.findAll(`[data-testid="${testIds.taskResult}"]`).length === 1)
    await flushPromises()
    expect(announced(wrapper)).toBe('')
    expect(dockAnnouncer()).toBe('Background agent finished: Find flaky tests')
  })
})

describe('chatView: hooks, project trust and output styles (Phase 11, P11-0b mounts)', () => {
  const U1 = 'msg_user000000000001'

  beforeEach(() => {
    api.chatQueue.list.mockResolvedValue({ items: [] })
    api.chats.get.mockResolvedValue(chatDetail({ id: chatId(41), modelRef: MODEL, projectId: projectId(1), settings: { outputStyle: 'learning' }, messages: [userMessage(U1, 'Hi')] }))
  })

  it('hosts the trust and MCP dialogs of the chat\'s project (CHAT_VIEW_ACTIONS) and provides the hook activity', async () => {
    useProjectsStore().items = [projectSummary({ id: projectId(1), name: 'website' })]
    api.projects.list.mockResolvedValue({ items: [projectSummary({ id: projectId(1), name: 'website' })] })
    let actions: { openProjectTrust: (focusKey?: string) => void, openProjectMcp: (serverId?: string) => void } | null = null
    let hookActivity: unknown = 'absent'
    const Probe = defineComponent({
      setup() {
        actions = inject(CHAT_VIEW_ACTIONS, null)
        hookActivity = inject(HOOK_ACTIVITY, null)?.value
        return () => null
      },
    })
    const wrapper = mount(defineComponent({
      setup: () => () => h(TooltipProvider, null, { default: () => h(ChatView, { chatId: chatId(41) }, { header: () => h(Probe) }) }),
    }), { attachTo: document.body, global: { stubs: { NuxtLink: { template: '<a><slot /></a>' } } } })
    mounted.push(wrapper)
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    expect(hookActivity).toBeNull()
    expect(document.body.querySelector(`[data-testid="${testIds.projectTrustDialog}"]`)).toBeNull()
    actions!.openProjectTrust()
    await until(() => document.body.querySelector(`[data-testid="${testIds.projectTrustDialog}"]`) !== null)
    expect(document.body.querySelector(`[data-testid="${testIds.projectTrustDialog}"]`)!.textContent).toContain('Review website')
    actions!.openProjectMcp('memory')
    await until(() => document.body.querySelector(`[data-testid="${testIds.projectMcpDialog}"]`) !== null)
  })

  it('passes the chat\'s own output style to the composer and saves its choice', async () => {
    const { wrapper } = mountView({ chatId: chatId(41) })
    await until(() => wrapper.get('[data-testid="composer"]').attributes('data-output-style') === 'learning')
    api.chats.update.mockResolvedValue(chatDetail({ id: chatId(41) }))
    wrapper.getComponent({ name: 'ChatComposer' }).vm.$emit('update:outputStyle', null)
    await flushPromises()
    expect(wrapper.get('[data-testid="composer"]').attributes('data-output-style')).toBe('automatic')
    expect(api.chats.update).toHaveBeenCalledWith({ params: { id: chatId(41) }, body: { settings: { outputStyle: null } } })
  })

  it('a queued message refused by a hook goes back into the composer with the refusal', async () => {
    const { wrapper } = mountView({ chatId: chatId(41) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    const gate = deferred()
    replies.push(gatedReply('Working on it', gate.promise))
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => wrapper.get('[data-testid="composer"]').attributes('data-status') === 'streaming')
    api.chatQueue.add.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'No secrets, please.', details: { reason: 'hook-blocked' } }))
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => mock.composer.showRefusal.mock.calls.length === 1)
    expect(mock.composer.restoreInput).toHaveBeenCalledWith({ text: 'Hello', files: [] })
    expect(mock.composer.showRefusal).toHaveBeenCalledWith({ code: 'hook-blocked', reason: 'No secrets, please.', event: null, source: null, command: null })
    expect(mock.toast).not.toHaveBeenCalled()
    gate.resolve()
    await until(() => wrapper.get('[data-testid="composer"]').attributes('data-status') === 'ready')
  })

  it('a new turn refused by a hook (409 before streaming) goes back into the composer with the refusal', async () => {
    const { wrapper } = mountView({ chatId: chatId(41) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    replies.push(() => new Response(JSON.stringify({ error: { code: 'conflict', message: 'Blocked by policy.', details: { reason: 'hook-blocked' } } }), { status: 409, headers: { 'content-type': 'application/json' } }))
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => mock.composer.showRefusal.mock.calls.length === 1)
    expect(mock.composer.showRefusal.mock.calls[0]![0]).toMatchObject({ code: 'hook-blocked', reason: 'Blocked by policy.' })
    expect(mock.composer.restoreInput).toHaveBeenCalledWith({ text: 'Hello', files: [] })
    // Nothing was stored: the refused message left the transcript.
    expect(wrapper.findAll(`[data-testid="${testIds.messageUser}"]`)).toHaveLength(1)
  })
})

describe('chatView: refused messages, hook turns and announcements (Phase 11, W11.11)', () => {
  const U1 = 'msg_user000000000001'
  const A1 = 'msg_asst000000000009'
  const DOC: FileRef = { id: 'file_notes00000000000', name: 'notes.md', mime: 'text/markdown', size: 42, url: '/api/files/file_notes00000000000' }
  /** The record of the UserPromptSubmit hook that blocked the message (`details.hook`). */
  const blockedRecord = hookData({ event: 'UserPromptSubmit', outcome: 'stopped', toolCallId: undefined, toolName: undefined, reason: 'No secrets, please.' })

  function refusal(reason: 'hook-blocked' | 'untrusted', message: string): () => Response {
    const details = reason === 'hook-blocked' ? { reason, hook: blockedRecord } : { reason }
    return () => new Response(JSON.stringify({ error: { code: 'conflict', message, details } }), { status: 409, headers: { 'content-type': 'application/json' } })
  }

  beforeEach(() => {
    api.chatQueue.list.mockResolvedValue({ items: [] })
    api.projects.list.mockResolvedValue({ items: [projectSummary({ id: projectId(1), name: 'website' })] })
  })

  it('on `/`: a refused first message stays a new chat (no created), its text and files come back with the refusal; the next send creates the chat', async () => {
    const { wrapper, created } = mountView({ chatId: chatId(51), isNew: true })
    wrapper.getComponent({ name: 'ChatComposer' }).vm.$emit('update:modelRef', MODEL)
    mock.composer.input = { text: 'my password is hunter2', files: [DOC] }
    // The server created the row, ran the hook, removed the row and answered 409 (open point 14).
    replies.push(() => {
      dispatchServerEvent(createServerEvent('chat.created', chatSummary({ id: chatId(51) })))
      dispatchServerEvent(createServerEvent('chat.deleted', { id: chatId(51) }))
      return refusal('hook-blocked', 'No secrets, please.')()
    })
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => mock.composer.showRefusal.mock.calls.length === 1)
    expect(mock.composer.restoreInput).toHaveBeenCalledWith({ text: 'my password is hunter2', files: [DOC] })
    expect(mock.composer.showRefusal).toHaveBeenCalledWith({ code: 'hook-blocked', reason: 'No secrets, please.', event: 'UserPromptSubmit', source: 'project', command: null })
    // The empty state is back, and the input reached its composer (not the dock's, which left with the message).
    expect(wrapper.find(`[data-testid="${testIds.emptyGreeting}"]`).exists()).toBe(true)
    expect(mock.composer.reached).toEqual(['restoreInput:Ask anything…', 'showRefusal:Ask anything…'])
    expect(wrapper.find(`[data-testid="${testIds.messageUser}"]`).exists()).toBe(false)
    expect(created).not.toHaveBeenCalled()
    expect(mock.toast).not.toHaveBeenCalled()
    expect(useChatsStore().byId(chatId(51))).toBeUndefined()

    // The next send is a first message again: it creates the chat, then the page moves.
    mock.composer.input = { text: 'Hello', files: [] }
    replies.push(textReply('Hi there'))
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => created.mock.calls.length === 1)
    expect(created).toHaveBeenCalledWith(chatId(51))
    expect(calls.filter(call => call.url === '/api/chat').map(call => call.body!.parentId)).toEqual([null, null])
  })

  it('on `/`: the page moves as soon as the server accepted the first message, before anything streams (an image turn, W11.16)', async () => {
    const { wrapper, created } = mountView({ chatId: chatId(57), isNew: true })
    wrapper.getComponent({ name: 'ChatComposer' }).vm.$emit('update:modelRef', MODEL)
    mock.composer.input = { text: 'a lighthouse at dusk', files: [] }
    // Like an image turn: `start` (the placeholders), then nothing until the image is ready.
    const gate = deferred()
    replies.push(streamReply(async (write) => {
      write({ type: 'start', messageId: 'msg_asst000000000001', messageMetadata: { modelRef: MODEL, startedAt: 1 } })
      write({ type: 'start-step' })
      await gate.promise
      write({ type: 'finish-step' })
      write({ type: 'finish', messageMetadata: { modelRef: MODEL, startedAt: 1, durationMs: 2000 } })
    }))
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => created.mock.calls.length === 1)
    expect(created).toHaveBeenCalledWith(chatId(57))
    expect(wrapper.get('[data-testid="composer"]').attributes('data-status')).toBe('submitted')
    gate.resolve()
    await until(() => wrapper.get('[data-testid="composer"]').attributes('data-status') === 'ready')
    expect(created).toHaveBeenCalledOnce()
  })

  it('on `/`: a first message the transcript keeps (an error with Retry) still moves the page', async () => {
    const { wrapper, created } = mountView({ chatId: chatId(52), isNew: true })
    wrapper.getComponent({ name: 'ChatComposer' }).vm.$emit('update:modelRef', MODEL)
    replies.push(() => new Response(JSON.stringify({ error: { code: 'internal_error', message: 'Boom.' } }), { status: 500, headers: { 'content-type': 'application/json' } }))
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => created.mock.calls.length === 1)
    expect(wrapper.findAll(`[data-testid="${testIds.messageUser}"]`)).toHaveLength(1)
    expect(mock.composer.showRefusal).not.toHaveBeenCalled()
  })

  it('an existing chat: a new turn refused by a hook goes back with its files; nothing stays in the transcript', async () => {
    api.chats.get.mockResolvedValue(chatDetail({ id: chatId(53), modelRef: MODEL, messages: [userMessage(U1, 'Hi'), assistantMessage(A1, 'Hello')] }))
    const { wrapper } = mountView({ chatId: chatId(53) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    mock.composer.input = { text: 'Read my notes', files: [DOC] }
    replies.push(refusal('hook-blocked', 'No secrets, please.'))
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => mock.composer.showRefusal.mock.calls.length === 1)
    expect(mock.composer.restoreInput).toHaveBeenCalledWith({ text: 'Read my notes', files: [DOC] })
    expect(mock.composer.showRefusal.mock.calls[0]![0]).toMatchObject({ code: 'hook-blocked', event: 'UserPromptSubmit', source: 'project' })
    expect(wrapper.findAll(`[data-testid="${testIds.messageUser}"]`)).toHaveLength(1)
    expect(wrapper.find(`[data-testid="${testIds.chatError}"]`).exists()).toBe(false)
    expect(wrapper.get('[data-testid="composer"]').attributes('data-status')).toBe('ready')
    expect(mock.toast).not.toHaveBeenCalled()
  })

  it('an untrusted command names itself; Review… opens the trust dialog of the chat\'s project', async () => {
    api.chats.get.mockResolvedValue(chatDetail({ id: chatId(54), modelRef: MODEL, projectId: projectId(1), messages: [userMessage(U1, 'Hi')] }))
    const { wrapper } = mountView({ chatId: chatId(54) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    mock.composer.input = { text: '/deploy staging', files: [] }
    replies.push(refusal('untrusted', 'The command /deploy runs shell lines that are not approved.'))
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => mock.composer.showRefusal.mock.calls.length === 1)
    expect(mock.composer.showRefusal).toHaveBeenCalledWith({ code: 'untrusted', reason: 'The command /deploy runs shell lines that are not approved.', event: null, source: null, command: 'deploy' })
    expect(mock.composer.restoreInput).toHaveBeenCalledWith({ text: '/deploy staging', files: [] })
    expect(wrapper.getComponent(ProjectTrustDialog).props()).toMatchObject({ open: false, projectId: projectId(1) })
    await wrapper.get('[data-action="review"]').trigger('click')
    expect(wrapper.getComponent(ProjectTrustDialog).props()).toMatchObject({ open: true, projectId: projectId(1), focusKey: null })
  })

  it('a queued message refused at enqueue goes back with its files and the hook\'s line', async () => {
    api.chats.get.mockResolvedValue(chatDetail({ id: chatId(55), modelRef: MODEL, messages: [userMessage(U1, 'Hi')] }))
    const { wrapper } = mountView({ chatId: chatId(55) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    const gate = deferred()
    replies.push(gatedReply('Working on it', gate.promise))
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => wrapper.get('[data-testid="composer"]').attributes('data-status') === 'streaming')
    api.chatQueue.add.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'No secrets, please.', details: { reason: 'hook-blocked', hook: blockedRecord } }))
    mock.composer.input = { text: 'Also read my notes', files: [DOC] }
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => mock.composer.showRefusal.mock.calls.length === 1)
    expect(mock.composer.restoreInput).toHaveBeenCalledWith({ text: 'Also read my notes', files: [DOC] })
    expect(mock.composer.showRefusal).toHaveBeenCalledWith({ code: 'hook-blocked', reason: 'No secrets, please.', event: 'UserPromptSubmit', source: 'project', command: null })
    expect(announced(wrapper)).not.toBe('Message queued')
    expect(mock.toast).not.toHaveBeenCalled()
    gate.resolve()
    await until(() => wrapper.get('[data-testid="composer"]').attributes('data-status') === 'ready')
  })

  it('an edit refused by a hook: its text and files go to the composer and the previous version shows again', async () => {
    const detail = chatDetail({ id: chatId(56), modelRef: MODEL, messages: [userMessage(U1, 'First question'), assistantMessage(A1, 'Answer')] })
    api.chats.get.mockResolvedValue(detail)
    const { wrapper } = mountView({ chatId: chatId(56) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageUser}"]`).length === 1)
    replies.push(refusal('hook-blocked', 'No secrets, please.'))
    const file = { type: 'file' as const, mediaType: DOC.mime, filename: DOC.name, url: DOC.url }
    wrapper.getComponent(ChatTranscript).vm.$emit('edit', U1, 'my password is hunter2', [file])
    await until(() => mock.composer.showRefusal.mock.calls.length === 1)
    expect(mock.composer.restoreInput).toHaveBeenCalledWith({ text: 'my password is hunter2', files: [{ ...DOC, size: 0 }] })
    // The previous version is reloaded from the server.
    await until(() => api.chats.get.mock.calls.length === 2)
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageAssistant}"]`).length === 1)
    expect(wrapper.get(`[data-testid="${testIds.messageUser}"]`).text()).toContain('First question')
    expect(calls.filter(call => call.url === '/api/chat')[0]!.body).toMatchObject({ parentId: null, message: { role: 'user' } })
  })

  it('a regenerate refused because the command\'s shell lines are no longer approved: the path reloads and only the refusal shows', async () => {
    api.chats.get.mockResolvedValue(chatDetail({ id: chatId(60), modelRef: MODEL, projectId: projectId(1), messages: [userMessage(U1, '/deploy staging'), assistantMessage(A1, 'Deployed')] }))
    const { wrapper } = mountView({ chatId: chatId(60) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageAssistant}"]`).length === 1)
    replies.push(refusal('untrusted', 'The command /deploy runs shell lines that are not approved.'))
    wrapper.getComponent(ChatTranscript).vm.$emit('regenerate', A1)
    await until(() => mock.composer.showRefusal.mock.calls.length === 1)
    expect(mock.composer.showRefusal.mock.calls[0]![0]).toMatchObject({ code: 'untrusted', command: 'deploy' })
    expect(mock.composer.restoreInput).not.toHaveBeenCalled()
    await until(() => api.chats.get.mock.calls.length === 2)
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageAssistant}"]`).length === 1)
    expect(wrapper.find(`[data-testid="${testIds.chatError}"]`).exists()).toBe(false)
  })

  it('a refusal that arrived while the chat was not shown is handled when it shows again', async () => {
    const component = effectScope()
    const session = component.run(() => useChatSession(chatId(57), { isNew: true }))!
    session.modelRef.value = MODEL
    replies.push(refusal('hook-blocked', 'No secrets, please.'))
    await session.submit({ text: 'Hello again', files: [] })
    component.stop()
    expect(session.chat.status.value).toBe('error')
    const { wrapper } = mountView({ chatId: chatId(57), isNew: true })
    await until(() => mock.composer.showRefusal.mock.calls.length === 1)
    expect(mock.composer.restoreInput).toHaveBeenCalledWith({ text: 'Hello again', files: [] })
    expect(wrapper.find(`[data-testid="${testIds.emptyGreeting}"]`).exists()).toBe(true)
  })

  it('a hook turn: the carrier shows before its reply and is announced once; a loaded carrier says nothing', async () => {
    const loadedCarrier = hookCarrier('msg_hookcarrier00001')
    const base = [userMessage(U1, 'Fix it'), assistantMessage(A1, 'Done'), loadedCarrier, assistantMessage('msg_asst000000000010', 'Tests pass')]
    api.chats.get.mockResolvedValueOnce(chatDetail({ id: chatId(58), modelRef: MODEL, messages: base }))
    const { wrapper } = mountView({ chatId: chatId(58) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageAssistant}"]`).length === 2)
    await flushPromises()
    expect(announced(wrapper)).toBe('')

    const carrier = hookCarrier('msg_hookcarrier00002')
    api.chats.get.mockResolvedValue(chatDetail({ id: chatId(58), modelRef: MODEL, running: true, messages: [...base, carrier] }))
    dispatchServerEvent(createServerEvent('run.started', { chatId: chatId(58), messageId: 'msg_asst000000000011', modelRef: MODEL, origin: 'hook', userMessageId: carrier.id }))
    await until(() => announced(wrapper) === 'A hook asked the agent to continue')
    expect(api.chats.get).toHaveBeenCalledTimes(2)
    // Once per carrier: a second event for it says nothing new.
    await wrapper.vm.$nextTick()
    const region = wrapper.findAll('[role="status"]').at(-1)!.element
    const seen: string[] = []
    const observer = new MutationObserver(() => seen.push(region.textContent ?? ''))
    observer.observe(region, { childList: true, characterData: true, subtree: true })
    dispatchServerEvent(createServerEvent('run.started', { chatId: chatId(58), messageId: 'msg_asst000000000011', modelRef: MODEL, origin: 'hook', userMessageId: carrier.id }))
    await flushPromises()
    observer.disconnect()
    expect(seen).toEqual([])
  })

  it('announces "A hook blocked {tool}" once for a denial in this tab\'s stream, never for a loaded one', async () => {
    const denied = hookPart({ id: 'hev_sample0000000007', toolCallId: 'call_write_7' })
    const loadedReply: HarnessUIMessage = {
      id: A1,
      role: 'assistant',
      metadata: { modelRef: MODEL, startedAt: 1 },
      parts: [
        { type: 'tool-write_file', toolCallId: 'call_write_7', state: 'output-denied', input: { path: 'dist/a.js', content: 'x' }, approval: { id: 'appr_7', approved: false, reason: 'Blocked by hook: Writes to dist/ are not allowed.' } } as never,
        denied,
      ],
    }
    api.chats.get.mockResolvedValue(chatDetail({ id: chatId(59), modelRef: MODEL, messages: [userMessage(U1, 'Build it'), loadedReply] }))
    const { wrapper } = mountView({ chatId: chatId(59) })
    await until(() => wrapper.findAll(`[data-testid="${testIds.messageAssistant}"]`).length === 1)
    await flushPromises()
    expect(announced(wrapper)).toBe('')

    const gate = deferred()
    const record = hookData({ id: 'hev_sample0000000008', toolCallId: 'call_write_8' })
    replies.push(streamReply(async (write) => {
      write({ type: 'start', messageId: 'msg_asst000000000012', messageMetadata: { modelRef: MODEL, startedAt: 1 } })
      write({ type: 'start-step' })
      write({ type: 'tool-input-available', toolCallId: 'call_write_8', toolName: 'write_file', input: { path: 'dist/b.js', content: 'y' } })
      write({ type: 'data-hook', id: record.id, data: record } as UIMessageChunk)
      write({ type: 'tool-output-denied', toolCallId: 'call_write_8' } as UIMessageChunk)
      write({ type: 'text-start', id: 't' })
      write({ type: 'text-delta', id: 't', delta: 'I cannot write there.' })
      await gate.promise
      write({ type: 'text-end', id: 't' })
      write({ type: 'finish-step' })
      write({ type: 'finish', messageMetadata: { modelRef: MODEL, startedAt: 1, durationMs: 5 } })
    }))
    await wrapper.get('[data-testid="composer"]').trigger('submit')
    await until(() => announced(wrapper) === 'A hook blocked write_file')
    gate.resolve()
    await until(() => announced(wrapper) === 'Response finished')
  })
})
