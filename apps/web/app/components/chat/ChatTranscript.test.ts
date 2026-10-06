import type { HarnessUIMessage, MessageBranch } from '@harness-forge/shared'
import type { ChatStatus } from 'ai'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import {
  assistantMessage,
  backgroundLaunchOutput,
  backgroundTaskId,
  compactionPart,
  hookCarrier,
  messageBranch,
  taskInput,
  taskOutput,
  taskPart,
  taskResultCarrier,
  taskResultData,
  taskResultPart,
  taskStep,
  userMessage,
} from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { HOOK_ACTIVITY } from './chat-context'
import ChatMessage from './ChatMessage.vue'
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
// Focused buttons open their tooltips (portaled into the body); a tooltip left open by one test would close when the next
// one opens a tooltip, patching nodes the cleared body no longer holds.
enableAutoUnmount(afterEach)

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

describe('chatTranscript: versions', () => {
  const U1 = 'msg_user000000000001'
  const A1 = 'msg_asst000000000001'
  const A1B = 'msg_asst00000000001b'
  const U2 = 'msg_user000000000002'
  const A2 = 'msg_asst000000000002'
  const U2B = 'msg_user00000000002b'
  const A2B = 'msg_asst00000000002b'

  interface State {
    messages: HarnessUIMessage[]
    branches: Record<string, MessageBranch>
    status: ChatStatus
    switching: boolean
  }

  function mountWithVersions(initial: Pick<State, 'messages' | 'branches'>) {
    const state = ref<State>({ status: 'ready', switching: false, ...initial })
    const events: Record<string, unknown[][]> = {}
    const record = (name: string) => (...args: unknown[]) => {
      (events[name] ??= []).push(args)
    }
    const transcript = ref<InstanceType<typeof ChatTranscript> | null>(null)
    const wrapper = mount({
      render: () => h(TooltipProvider, null, {
        default: () => h(ChatTranscript, {
          ref: transcript,
          messages: state.value.messages,
          status: state.value.status,
          showThinking: false,
          branches: state.value.branches,
          switching: state.value.switching,
          onSelectVersion: record('select-version'),
          onRegenerate: record('regenerate'),
          onRetry: record('retry'),
          onEdit: record('edit'),
          onDeleteVersion: record('delete-version'),
          onRewind: record('rewind'),
        }),
      }),
    }, { attachTo: document.body })
    return { wrapper, state, events, transcript }
  }

  function control(wrapper: ReturnType<typeof mountWithVersions>['wrapper'], messageId: string, testId: string) {
    return wrapper.get(`[data-testid="${testIds.messageBranch}"][data-message-id="${messageId}"] [data-testid="${testId}"]`)
  }

  it('moves focus to the same control of the new version after a switch', async () => {
    const { wrapper, state, events } = mountWithVersions({
      messages: [userMessage(U1, 'q1'), assistantMessage(A1, 'a1'), userMessage(U2, 'q2'), assistantMessage(A2, 'a2')],
      branches: { [U2]: messageBranch([U2B, U2], 1) },
    })
    await nextTick()
    const previous = control(wrapper, U2, testIds.messageBranchPrevious)
    ;(previous.element as HTMLElement).focus()
    await previous.trigger('click')
    expect(events['select-version']).toEqual([[U2B]])

    state.value = { ...state.value, switching: true }
    await nextTick()
    expect(previous.attributes('aria-disabled')).toBe('true')
    state.value = {
      ...state.value,
      switching: false,
      messages: [userMessage(U1, 'q1'), assistantMessage(A1, 'a1'), userMessage(U2B, 'q2, first version'), assistantMessage(A2B, 'a2b')],
      branches: { [U2B]: messageBranch([U2B, U2], 0) },
    }
    await flushPromises()
    const moved = control(wrapper, U2B, testIds.messageBranchPrevious)
    expect(document.activeElement).toBe(moved.element)
    // The first version: the focused button is aria-disabled, but keeps the focus.
    expect(moved.attributes('aria-disabled')).toBe('true')
  })

  it('leaves focus alone when the version was not chosen from a focused control, or the switch was refused', async () => {
    const { wrapper, state } = mountWithVersions({
      messages: [userMessage(U1, 'q1'), assistantMessage(A1, 'a1'), userMessage(U2, 'q2'), assistantMessage(A2, 'a2')],
      branches: { [U2]: messageBranch([U2B, U2], 1) },
    })
    await nextTick()
    const previous = control(wrapper, U2, testIds.messageBranchPrevious)
    ;(previous.element as HTMLElement).focus()
    await previous.trigger('click')
    state.value = { ...state.value, switching: true }
    await nextTick()
    // Refused (409): the path did not change, the button keeps its focus.
    state.value = { ...state.value, switching: false }
    await flushPromises()
    expect(document.activeElement).toBe(previous.element)

    ;(document.activeElement as HTMLElement).blur()
    await previous.trigger('click')
    state.value = {
      ...state.value,
      messages: [userMessage(U1, 'q1'), assistantMessage(A1, 'a1'), userMessage(U2B, 'q2b'), assistantMessage(A2B, 'a2b')],
      branches: { [U2B]: messageBranch([U2B, U2], 0) },
    }
    await flushPromises()
    expect(document.activeElement).toBe(document.body)
  })

  it('disables the switchers of older messages while a request or a switch is in flight', async () => {
    const { wrapper, state } = mountWithVersions({
      messages: [userMessage(U1, 'q1'), assistantMessage(A1, 'a1'), userMessage(U2, 'q2'), assistantMessage(A2, 'a2')],
      branches: { [A1]: messageBranch([A1, A1B], 0) },
    })
    await nextTick()
    const next = () => control(wrapper, A1, testIds.messageBranchNext)
    expect(next().attributes('aria-disabled')).toBeUndefined()
    state.value = { ...state.value, status: 'streaming' }
    await nextTick()
    expect(next().attributes('aria-disabled')).toBe('true')
    state.value = { ...state.value, status: 'ready', switching: true }
    await nextTick()
    expect(next().attributes('aria-disabled')).toBe('true')
    state.value = { ...state.value, switching: false }
    await nextTick()
    expect(next().attributes('aria-disabled')).toBeUndefined()
  })

  it('retries the last request from the last reply, and regenerates an older failed reply', async () => {
    const failed = { modelRef: 'mock:echo', startedAt: 1, error: { code: 'provider_error' as const, message: 'Upstream failed', providerId: 'mock' } }
    const { wrapper, events } = mountWithVersions({
      messages: [userMessage(U1, 'q1'), assistantMessage(A1, 'a1', { metadata: failed }), userMessage(U2, 'q2'), assistantMessage(A2, 'a2', { metadata: failed })],
      branches: {},
    })
    await nextTick()
    const retry = (messageId: string) => wrapper.get(`[data-message-id="${messageId}"] [data-testid="${testIds.chatError}"] [data-action="retry"]`)
    await retry(A1).trigger('click')
    await retry(A2).trigger('click')
    expect(events.regenerate).toEqual([[A1]])
    expect(events.retry).toEqual([[]])
  })

  it('re-emits "Delete this version" and edits (with their files) with the message id', async () => {
    const photo = { type: 'file' as const, mediaType: 'image/png', filename: 'photo.png', url: '/api/files/file_photo000000000001' }
    const { wrapper, events } = mountWithVersions({
      messages: [userMessage(U1, 'q1', { parts: [photo, { type: 'text', text: 'q1' }] }), assistantMessage(A1, 'a1')],
      branches: { [A1]: messageBranch([A1, A1B], 0) },
    })
    await nextTick()
    await wrapper.get(`[data-message-id="${A1}"] [data-testid="${testIds.messageDeleteVersion}"]`).trigger('click')
    expect(events['delete-version']).toEqual([[A1]])

    await wrapper.get(`[data-message-id="${U1}"] [data-testid="${testIds.messageEdit}"]`).trigger('click')
    await wrapper.get(`[data-testid="${testIds.messageEditSave}"]`).trigger('click')
    await flushPromises()
    expect(events.edit).toEqual([[U1, 'q1', [photo]]])
  })

  it('focuses the version shown after a deletion: its switcher, else its Copy button; or back on the delete button', async () => {
    const { wrapper, transcript } = mountWithVersions({
      messages: [userMessage(U1, 'q1'), assistantMessage(A1, 'a1'), userMessage(U2, 'q2'), assistantMessage(A2, 'a2')],
      branches: { [U2]: messageBranch([U2B, U2, 'msg_user00000000002c'], 1), [A1]: messageBranch([A1, A1B], 0) },
    })
    await nextTick()
    // The first enabled control of the switcher.
    expect(transcript.value!.focusShownVersion(U2)).toBe(true)
    expect(document.activeElement).toBe(control(wrapper, U2, testIds.messageBranchPrevious).element)
    expect(transcript.value!.focusShownVersion(A1)).toBe(true)
    expect(document.activeElement).toBe(control(wrapper, A1, testIds.messageBranchNext).element)
    // Only one version left: its Copy button.
    expect(transcript.value!.focusShownVersion(A2)).toBe(true)
    expect(document.activeElement).toBe(wrapper.get(`[data-message-id="${A2}"] [data-testid="${testIds.messageCopy}"]`).element)
    expect(transcript.value!.focusShownVersion('msg_gone000000000001')).toBe(false)

    expect(transcript.value!.focusDeleteVersion(U2)).toBe(true)
    expect(document.activeElement).toBe(wrapper.get(`[data-message-id="${U2}"] [data-testid="${testIds.messageDeleteVersion}"]`).element)
    expect(transcript.value!.focusDeleteVersion(A2)).toBe(false)
  })

  it('re-emits "Rewind files to here" with the message id and opens the editor through startEdit (Phase 8)', async () => {
    const { wrapper, state, events, transcript } = mountWithVersions({
      messages: [userMessage(U1, 'q1'), assistantMessage(A1, 'a1')],
      branches: {},
    })
    await nextTick()
    wrapper.findAllComponents(ChatMessage)[0]!.vm.$emit('rewind')
    expect(events.rewind).toEqual([[U1]])

    // Not a project chat: no rewind button, so focusRewind leaves focus alone.
    transcript.value!.focusRewind(U1)
    expect(document.activeElement).toBe(document.body)

    state.value = { ...state.value, status: 'streaming' }
    await nextTick()
    transcript.value!.startEdit(U1)
    await nextTick()
    expect(wrapper.find(`[data-testid="${testIds.messageEditSave}"]`).exists()).toBe(false)

    state.value = { ...state.value, status: 'ready' }
    await nextTick()
    transcript.value!.startEdit(U1)
    await nextTick()
    expect(wrapper.find(`[data-testid="${testIds.messageEditSave}"]`).exists()).toBe(true)
  })
})

describe('chatTranscript: rewind files (Phase 8)', () => {
  const U1 = 'msg_user0000000000w1'
  const A1 = 'msg_asst0000000000w1'
  const U2 = 'msg_user0000000000w2'
  const A2 = 'msg_asst0000000000w2'
  const U3 = 'msg_user0000000000w3'
  const A3 = 'msg_asst0000000000w3'

  type ToolState = 'input-available' | 'output-available' | 'output-error'

  function toolCall(tool: string, state: ToolState, dynamic = false): HarnessUIMessage['parts'][number] {
    const base = { toolCallId: `call_${tool}_${state}`, input: { path: 'src/a.ts' } }
    const settled = state === 'output-available'
      ? { state, output: { path: 'src/a.ts' } }
      : state === 'output-error' ? { state, errorText: 'Failed.' } : { state }
    const part = dynamic ? { type: 'dynamic-tool', toolName: tool, ...base, ...settled } : { type: `tool-${tool}`, ...base, ...settled }
    return part as HarnessUIMessage['parts'][number]
  }

  function reply(id: string, ...parts: HarnessUIMessage['parts']): HarnessUIMessage {
    return assistantMessage(id, 'Done', { parts: [...parts, { type: 'text', text: 'Done', state: 'done' }] })
  }

  interface State { messages: HarnessUIMessage[], status: ChatStatus, projectId: string | null }

  function mountRewind(initial: Pick<State, 'messages'> & Partial<State>) {
    const state = ref<State>({ status: 'ready', projectId: 'prj_sample0000000001', ...initial })
    const events: unknown[][] = []
    const transcript = ref<InstanceType<typeof ChatTranscript> | null>(null)
    const wrapper = mount({
      render: () => h(TooltipProvider, null, {
        default: () => h(ChatTranscript, {
          ref: transcript,
          messages: state.value.messages,
          status: state.value.status,
          showThinking: false,
          projectId: state.value.projectId,
          onRewind: (...args: unknown[]) => events.push(args),
        }),
      }),
    }, { attachTo: document.body })
    return { wrapper, state, events, transcript }
  }

  function rewindable(wrapper: ReturnType<typeof mountRewind>['wrapper']): string[] {
    return wrapper.findAll(`[data-testid="${testIds.messageUser}"]`)
      .filter(row => row.find(`[data-testid="${testIds.messageRewind}"]`).exists())
      .map(row => row.attributes('data-message-id')!)
  }

  it('offers it on the user messages that a finished write_file / edit_file call follows', async () => {
    const { wrapper, state } = mountRewind({
      messages: [
        userMessage(U1, 'q1'),
        reply(A1, toolCall('write_file', 'output-available')),
        userMessage(U2, 'q2'),
        reply(A2, toolCall('shell', 'output-available'), toolCall('read_file', 'output-available')),
        userMessage(U3, 'q3'),
        reply(A3, toolCall('edit_file', 'output-error'), toolCall('write_file', 'input-available')),
      ],
    })
    await nextTick()
    expect(rewindable(wrapper)).toEqual([U1])

    // The last reply finishes an edit (a new message object): every user message before it qualifies.
    state.value = { ...state.value, messages: [...state.value.messages.slice(0, 5), reply(A3, toolCall('edit_file', 'output-available', true))] }
    await nextTick()
    expect(rewindable(wrapper)).toEqual([U1, U2, U3])

    // A chat without a project never offers it.
    state.value = { ...state.value, projectId: null }
    await nextTick()
    expect(rewindable(wrapper)).toEqual([])
  })

  it('hides it like Edit while a reply runs, re-emits it with the message id and takes focus back', async () => {
    const { wrapper, state, events, transcript } = mountRewind({
      messages: [userMessage(U1, 'q1'), reply(A1, toolCall('write_file', 'output-available')), userMessage(U2, 'q2')],
    })
    await nextTick()
    const button = wrapper.get(`[data-message-id="${U1}"] [data-testid="${testIds.messageRewind}"]`)
    expect(button.attributes('aria-label')).toBe('Rewind files to here')
    expect(button.classes()).toContain('group-data-[busy=true]/transcript:hidden')
    await button.trigger('click')
    expect(events).toEqual([[U1]])

    transcript.value!.focusRewind(U1)
    expect(document.activeElement).toBe(button.element)

    state.value = { ...state.value, status: 'submitted' }
    await nextTick()
    expect(wrapper.get('.hf-transcript').attributes('data-busy')).toBe('true')
    // The older row keeps its button (hidden by CSS, no re-render); the last user message is not rewindable.
    expect(rewindable(wrapper)).toEqual([U1])
  })
})

describe('chatTranscript: rewind files after sub-agent edits (Phase 9)', () => {
  const U1 = 'msg_user0000000000t1'
  const A1 = 'msg_asst0000000000t1'
  const U2 = 'msg_user0000000000t2'
  const A2 = 'msg_asst0000000000t2'

  function mountTasks(messages: HarnessUIMessage[], status: ChatStatus = 'ready') {
    return mount({
      render: () => h(TooltipProvider, null, {
        default: () => h(ChatTranscript, { messages, status, showThinking: false, projectId: 'prj_sample0000000001' }),
      }),
    }, { attachTo: document.body })
  }

  function rewindable(wrapper: ReturnType<typeof mountTasks>): string[] {
    return wrapper.findAll(`[data-testid="${testIds.messageUser}"]`)
      .filter(row => row.find(`[data-testid="${testIds.messageRewind}"]`).exists())
      .map(row => row.attributes('data-message-id')!)
  }

  it('counts a task call whose sub-agent wrote or edited a file', async () => {
    const wrote = taskPart({ output: taskOutput({ type: 'general', steps: [taskStep(), taskStep({ toolCallId: 'child_2', toolName: 'edit_file', state: 'done' })] }) })
    const wrapper = mountTasks([
      userMessage(U1, 'q1'),
      assistantMessage(A1, '', { parts: [wrote, { type: 'text', text: 'Done', state: 'done' }] }),
      userMessage(U2, 'q2'),
      assistantMessage(A2, 'Plain'),
    ])
    await nextTick()
    expect(rewindable(wrapper)).toEqual([U1])
  })

  it('also counts a stopped sub-agent (a preliminary output) as the last reply', async () => {
    const running = taskPart({ preliminary: true, output: taskOutput({ status: 'running', steps: [taskStep({ toolName: 'write_file', state: 'done' })], report: '' }) })
    const wrapper = mountTasks([userMessage(U1, 'q1'), assistantMessage(A1, '', { parts: [running] })])
    await nextTick()
    expect(rewindable(wrapper)).toEqual([U1])
  })

  it('ignores sub-agents that only read, or whose edits failed, were denied or still run', async () => {
    const steps = [
      taskStep(),
      taskStep({ toolCallId: 'child_2', toolName: 'write_file', state: 'error' }),
      taskStep({ toolCallId: 'child_3', toolName: 'edit_file', state: 'denied' }),
      taskStep({ toolCallId: 'child_4', toolName: 'write_file', state: 'running' }),
    ]
    const unparsable = { ...taskPart(), output: 'Sub-agent finished.' } as HarnessUIMessage['parts'][number]
    const pending = { type: 'tool-task', toolCallId: 'call_task_2', state: 'input-available', input: {} } as HarnessUIMessage['parts'][number]
    const wrapper = mountTasks([
      userMessage(U1, 'q1'),
      assistantMessage(A1, '', { parts: [taskPart({ output: taskOutput({ steps }) }), unparsable, pending] }),
    ])
    await nextTick()
    expect(rewindable(wrapper)).toEqual([])
  })
})

describe('chatTranscript: background agents (Phase 10)', () => {
  const U1 = 'msg_user0000000000b1'
  const A1 = 'msg_asst0000000000b1'
  const U2 = 'msg_user0000000000b2'
  const A2 = 'msg_asst0000000000b2'
  const C1 = 'msg_carr0000000000b1'
  const launch = taskPart({ input: taskInput({ type: 'general', background: true }), output: backgroundLaunchOutput() })
  const wrote = taskOutput({ taskId: backgroundTaskId(1), steps: [taskStep({ toolName: 'write_file', state: 'done' })] })

  function mountChat(messages: HarnessUIMessage[]) {
    const transcript = ref<InstanceType<typeof ChatTranscript> | null>(null)
    const wrapper = mount({
      render: () => h(TooltipProvider, null, {
        default: () => h(ChatTranscript, { ref: transcript, messages, status: 'ready', showThinking: false, projectId: 'prj_sample0000000001' }),
      }),
    }, { attachTo: document.body })
    return { wrapper, transcript }
  }

  function rewindable(wrapper: ReturnType<typeof mountChat>['wrapper']): string[] {
    return wrapper.findAll(`[data-testid="${testIds.messageUser}"]`)
      .filter(row => row.find(`[data-testid="${testIds.messageRewind}"]`).exists())
      .map(row => row.attributes('data-message-id')!)
  }

  it('counts the files a background agent wrote for the reply that launched it, from its delivered result', async () => {
    const { wrapper } = mountChat([
      userMessage(U1, 'q1'),
      assistantMessage(A1, '', { parts: [launch, { type: 'text', text: 'Started it.', state: 'done' }] }),
      taskResultCarrier(C1, [taskResultData({ messageId: A1, output: wrote })]),
      assistantMessage(A2, 'It wrote agent.txt.'),
    ])
    await nextTick()
    // The launching reply counts; the carrier never offers a rewind.
    expect(rewindable(wrapper)).toEqual([U1])
  })

  it('also counts a result delivered inside a later running reply, and ignores results that only read', async () => {
    const delivered = mountChat([
      userMessage(U1, 'q1'),
      assistantMessage(A1, '', { parts: [launch] }),
      userMessage(U2, 'q2'),
      assistantMessage(A2, '', { parts: [taskResultPart({ messageId: A1, output: wrote }), { type: 'text', text: 'Noted.', state: 'done' }] }),
    ])
    await nextTick()
    expect(rewindable(delivered.wrapper)).toEqual([U1])
    delivered.wrapper.unmount()

    const readOnly = mountChat([
      userMessage(U1, 'q1'),
      assistantMessage(A1, '', { parts: [launch] }),
      taskResultCarrier(C1, [taskResultData({ messageId: A1 })]),
      assistantMessage(A2, 'Done.'),
    ])
    await nextTick()
    expect(rewindable(readOnly.wrapper)).toEqual([])
  })

  it('renders a carrier as notes, and ↑ edits the last message the user wrote instead', async () => {
    const { wrapper, transcript } = mountChat([
      userMessage(U1, 'q1'),
      assistantMessage(A1, '', { parts: [launch] }),
      taskResultCarrier(C1),
      assistantMessage(A2, 'Done.'),
    ])
    await nextTick()
    const carrier = wrapper.get(`[data-message-id="${C1}"]`)
    expect(carrier.get(`[data-testid="${testIds.taskResult}"]`).attributes('data-variant')).toBe('turn')
    expect(carrier.find('[data-slot="user-message"]').exists()).toBe(false)
    expect(transcript.value!.editLastUserMessage()).toBe(true)
    await nextTick()
    expect(wrapper.get(`[data-message-id="${U1}"]`).find(`[data-testid="${testIds.messageEditInput}"]`).exists()).toBe(true)
  })
})

describe('chatTranscript: compaction (Phase 9)', () => {
  const U1 = 'msg_u000000000000001'
  const A1 = 'msg_a000000000000001'
  const U2 = 'msg_u000000000000002'
  const A2 = 'msg_a000000000000002'
  const U3 = 'msg_u000000000000003'
  const A3 = 'msg_a000000000000003'

  interface State { messages: HarnessUIMessage[], status: ChatStatus, activity: 'compacting' | null }

  function mountCompaction(initial: Pick<State, 'messages'> & Partial<State>) {
    const state = ref<State>({ status: 'ready', activity: null, ...initial })
    const wrapper = mount({
      render: () => h(TooltipProvider, null, {
        default: () => h(ChatTranscript, {
          messages: state.value.messages,
          status: state.value.status,
          showThinking: false,
          activity: state.value.activity,
        }),
      }),
    }, { attachTo: document.body })
    return { wrapper, state }
  }

  function compacted(wrapper: ReturnType<typeof mountCompaction>['wrapper']): string[] {
    return wrapper.findAll('[data-compacted]').map(row => row.attributes('data-message-id')!)
  }

  const history = () => [
    userMessage(U1, 'Old question'),
    assistantMessage(A1, 'Old answer'),
    userMessage(U2, '/compact keep numbers'),
    assistantMessage(A2, '', { parts: [compactionPart({ focus: 'keep numbers' })] }),
    userMessage(U3, 'Next question'),
    assistantMessage(A3, 'Next answer'),
  ]

  it('dims the rows a /compact replaced and renders the divider in its reply', async () => {
    const { wrapper } = mountCompaction({ messages: history() })
    await nextTick()
    expect(compacted(wrapper)).toEqual([U1, A1, U2])
    for (const id of [U1, A1, U2]) {
      const row = wrapper.get(`[data-message-id="${id}"]`)
      expect(row.attributes('data-compacted')).toBe('true')
      expect(row.classes()).toEqual(expect.arrayContaining(['opacity-70', 'hover:opacity-100', 'focus-within:opacity-100']))
    }
    expect(wrapper.get(`[data-message-id="${A3}"]`).classes()).not.toContain('opacity-70')
    const divider = wrapper.get(`[data-message-id="${A2}"] [data-testid="${testIds.compactionDivider}"]`)
    expect(divider.attributes()).toMatchObject({ 'data-kind': 'manual', 'data-variant': 'history', 'aria-label': 'Conversation compacted' })
  })

  it('keeps the user message of an automatic compaction before the reply at full opacity', async () => {
    const { wrapper } = mountCompaction({
      messages: [
        userMessage(U1, 'Old question'),
        assistantMessage(A1, 'Old answer'),
        userMessage(U2, 'New question'),
        assistantMessage(A2, '', { parts: [{ type: 'step-start' }, compactionPart({ trigger: 'auto', keep: 'last-user' }), { type: 'text', text: 'Answer', state: 'done' }] }),
      ],
    })
    await nextTick()
    expect(compacted(wrapper)).toEqual([U1, A1])
    expect(wrapper.get(`[data-testid="${testIds.compactionDivider}"]`).attributes('aria-label')).toBe('Conversation compacted automatically')
  })

  it('dims the earlier rows and the earlier blocks of a reply that compacted during the run, as it streams', async () => {
    const reply = (parts: HarnessUIMessage['parts']) => assistantMessage(A2, '', { parts })
    const before = [userMessage(U1, 'Old question'), assistantMessage(A1, 'Old answer'), userMessage(U2, 'loop 6')]
    const step1: HarnessUIMessage['parts'] = [{ type: 'step-start' }, { type: 'text', text: 'Step 1 done.', state: 'done' }]
    const { wrapper, state } = mountCompaction({ messages: [...before, reply(step1)], status: 'streaming' })
    await nextTick()
    expect(compacted(wrapper)).toEqual([])

    state.value = { ...state.value, activity: 'compacting' }
    await nextTick()
    expect(wrapper.get(`[data-message-id="${A2}"] [data-testid="${testIds.submittedPlaceholder}"]`).text()).toBe('Compacting conversation…')

    const marker = compactionPart({ trigger: 'auto', keep: 'last-user' })
    state.value = { ...state.value, activity: null, messages: [...before, reply([...step1, { type: 'step-start' }, marker])] }
    await nextTick()
    expect(compacted(wrapper)).toEqual([U1, A1])
    const row = wrapper.get(`[data-message-id="${A2}"]`)
    expect(row.attributes('data-compacted')).toBeUndefined()
    expect(row.get('[data-slot="markdown"]').classes()).toContain('opacity-70')
    expect(row.get(`[data-testid="${testIds.compactionDivider}"]`).attributes('data-variant')).toBe('run')
    expect(row.get(`[data-testid="${testIds.submittedPlaceholder}"]`).text()).toBe('Thinking…')
  })

  it('follows the latest of several markers, and a branch without the marker shows no dimming', async () => {
    const messages = history()
    const later = [
      ...messages,
      userMessage('msg_u000000000000004', 'More'),
      assistantMessage('msg_a000000000000004', '', { parts: [compactionPart({ trigger: 'auto', keep: 'last-user' }), { type: 'text', text: 'Four', state: 'done' }] }),
    ]
    const { wrapper, state } = mountCompaction({ messages: later })
    await nextTick()
    expect(compacted(wrapper)).toEqual([U1, A1, U2, A2, U3, A3])
    expect(wrapper.findAll(`[data-testid="${testIds.compactionDivider}"]`)).toHaveLength(2)

    // Another version of the second question: the marker is not on this path.
    state.value = { ...state.value, messages: [userMessage(U1, 'Old question'), assistantMessage(A1, 'Old answer'), userMessage('msg_u00000000000000b', 'Other'), assistantMessage('msg_a00000000000000b', 'Other answer')] }
    await nextTick()
    expect(compacted(wrapper)).toEqual([])
    expect(wrapper.findAll(`[data-testid="${testIds.compactionDivider}"]`)).toHaveLength(0)
  })

  it('says "Compacting conversation…" in the submitted placeholder while the session compacts', async () => {
    const { wrapper, state } = mountCompaction({ messages: [userMessage(U1, 'Question')], status: 'submitted' })
    await nextTick()
    expect(wrapper.get(`[data-testid="${testIds.submittedPlaceholder}"]`).text()).toBe('Thinking…')
    state.value = { ...state.value, activity: 'compacting' }
    await nextTick()
    expect(wrapper.get(`[data-testid="${testIds.submittedPlaceholder}"]`).text()).toBe('Compacting conversation…')
  })
})

describe('chatTranscript: Phase 9 seams', () => {
  it('passes the activity to the streaming last reply only, and no row is compacted without a marker', async () => {
    const messages = [
      userMessage('msg_u000000000000001', 'Old question'),
      assistantMessage('msg_a000000000000001', 'Old answer'),
      userMessage('msg_u000000000000002', 'New question'),
      assistantMessage('msg_a000000000000002', '', { parts: [] }),
    ]
    const state = ref<{ status: ChatStatus, activity: 'compacting' | null }>({ status: 'streaming', activity: 'compacting' })
    const wrapper = mount({
      render: () => h(TooltipProvider, null, {
        default: () => h(ChatTranscript, { messages, status: state.value.status, showThinking: false, activity: state.value.activity }),
      }),
    }, { attachTo: document.body })
    await nextTick()
    const rows = () => wrapper.findAllComponents(ChatMessage)
    expect(rows().map(row => row.props('activity'))).toEqual([null, null, null, 'compacting'])
    expect(rows().map(row => row.props('compacted'))).toEqual([false, false, false, false])
    state.value = { status: 'ready', activity: 'compacting' }
    await nextTick()
    expect(rows().map(row => row.props('activity'))).toEqual([null, null, null, null])
  })
})

describe('chatTranscript: hooks (Phase 11)', () => {
  it('passes the hooks activity to the streaming last reply and the submitted placeholder', async () => {
    const state = ref<{ status: ChatStatus, messages: HarnessUIMessage[] }>({
      status: 'submitted',
      messages: [userMessage('msg_u000000000000001', 'Question')],
    })
    const wrapper = mount({
      render: () => h(TooltipProvider, null, {
        default: () => h(ChatTranscript, { messages: state.value.messages, status: state.value.status, showThinking: false, activity: 'hooks' }),
      }),
    }, { attachTo: document.body })
    await nextTick()
    expect(wrapper.get(`[data-testid="${testIds.submittedPlaceholder}"]`).text()).toBe('Running hooks…')
    state.value = { status: 'streaming', messages: [...state.value.messages, assistantMessage('msg_a000000000000001', '', { parts: [] })] }
    await nextTick()
    expect(wrapper.findAllComponents(ChatMessage).map(row => row.props('activity'))).toEqual([null, 'hooks'])
  })

  it('moves "Running hook…" between the tool row and the end of the memoized reply through HOOK_ACTIVITY', async () => {
    const tool = { type: 'tool-write_file', toolCallId: 'call_w1', state: 'input-available', input: { path: 'a.txt', content: 'x' } } as unknown as HarnessUIMessage['parts'][number]
    const messages = [userMessage('msg_u000000000000001', 'Question'), assistantMessage('msg_a000000000000001', '', { parts: [{ type: 'text', text: 'Writing.', state: 'done' }, tool] })]
    const hookActivity = ref<{ event: 'PreToolUse' | 'Stop', toolCallId: string | null } | null>({ event: 'PreToolUse', toolCallId: 'call_w1' })
    const wrapper = mount({
      render: () => h(TooltipProvider, null, {
        default: () => h(ChatTranscript, { messages, status: 'streaming', showThinking: false, activity: 'hooks' }),
      }),
    }, { attachTo: document.body, global: { provide: { [HOOK_ACTIVITY as symbol]: hookActivity } } })
    await nextTick()
    const lines = () => wrapper.findAll('[data-slot="running-hook"]').map(line => line.text())
    expect(lines()).toEqual(['Running hook…'])
    expect(wrapper.get(`[data-testid="${testIds.toolRow}"]`).find('[data-slot="running-hook"]').exists()).toBe(true)
    // Only the injected activity changes: the memoized row still follows it.
    hookActivity.value = { event: 'Stop', toolCallId: null }
    await nextTick()
    expect(lines()).toEqual(['Running hooks…'])
    expect(wrapper.get(`[data-testid="${testIds.toolRow}"]`).find('[data-slot="running-hook"]').exists()).toBe(false)
  })

  it('renders a hook carrier as notes: never rewound, and ↑ edits the last message the user wrote', async () => {
    const U1 = 'msg_user0000000000h1'
    const C1 = 'msg_carr0000000000h1'
    const write = { type: 'tool-write_file', toolCallId: 'call_w1', state: 'output-available', input: { path: 'a.txt', content: 'x' }, output: { path: 'a.txt', created: true, bytes: 1, diff: '' } } as unknown as HarnessUIMessage['parts'][number]
    const transcript = ref<InstanceType<typeof ChatTranscript> | null>(null)
    const wrapper = mount({
      render: () => h(TooltipProvider, null, {
        default: () => h(ChatTranscript, {
          ref: transcript,
          messages: [userMessage(U1, 'q1'), assistantMessage('msg_asst0000000000h1', '', { parts: [write] }), hookCarrier(C1), assistantMessage('msg_asst0000000000h2', 'Fixed.', { parts: [write] })],
          status: 'ready',
          showThinking: false,
          projectId: 'prj_sample0000000001',
        }),
      }),
    }, { attachTo: document.body })
    await nextTick()
    const carrier = wrapper.get(`[data-message-id="${C1}"]`)
    expect(carrier.get(`[data-testid="${testIds.hookNote}"]`).attributes('data-variant')).toBe('turn')
    expect(carrier.find(`[data-testid="${testIds.messageRewind}"]`).exists()).toBe(false)
    expect(wrapper.get(`[data-message-id="${U1}"]`).find(`[data-testid="${testIds.messageRewind}"]`).exists()).toBe(true)
    expect(transcript.value!.editLastUserMessage()).toBe(true)
    await nextTick()
    expect(wrapper.get(`[data-message-id="${U1}"]`).find(`[data-testid="${testIds.messageEditInput}"]`).exists()).toBe(true)
  })
})
