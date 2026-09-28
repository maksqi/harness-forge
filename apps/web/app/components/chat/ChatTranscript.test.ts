import type { HarnessUIMessage, MessageBranch } from '@harness-forge/shared'
import type { ChatStatus } from 'ai'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { assistantMessage, messageBranch, userMessage } from '~/utils/testing/fixtures'
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
})
