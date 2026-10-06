import type { HarnessUIMessage } from '@harness-forge/shared'
import type { FileUIPart } from 'ai'
import { DEFAULT_SETTINGS } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import {
  backgroundTaskId,
  compactionPart,
  hookCarrier,
  hookData,
  hookPart,
  hookRecordId,
  planApprovalPart,
  steerPart,
  taskPart,
  taskResultCarrier,
  taskResultData,
  taskResultPart,
} from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import TaskBlock from './agent/TaskBlock.vue'
import ChatMessage from './ChatMessage.vue'
import ToolPart from './parts/ToolPart.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api, useApiFetch: () => vi.fn() }))
// The app-wide read-aloud player (W6.8), with a state the tests can set.
const player = vi.hoisted(() => ({ state: null as unknown as { value: string }, activeId: null as unknown as { value: string | null } }))
vi.mock('~/composables/useSpeechPlayer', async () => {
  const { ref: vueRef } = await import('vue')
  player.state = vueRef('idle')
  player.activeId = vueRef<string | null>(null)
  return {
    useSpeechPlayer: () => ({ state: player.state, activeId: player.activeId, play: vi.fn(), stop: vi.fn(), toggle: vi.fn() }),
  }
})
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
        onSelectVersion: record('select-version'),
        onDeleteVersion: record('delete-version'),
        onRewind: record('rewind'),
      }),
    }),
  }), { attachTo: document.body })
  return { wrapper, events, instance }
}

/** Like mountMessage, with props that change afterwards. */
function mountLive(initial: Props) {
  const state = ref<Props>(initial)
  const wrapper = mount(defineComponent({
    setup: () => () => h(TooltipProvider, null, { default: () => h(ChatMessage, state.value) }),
  }), { attachTo: document.body })
  return { wrapper, state }
}

function imagePart(n: number, mediaType = 'image/png'): FileUIPart {
  return { type: 'file', mediaType, url: `/api/files/file_image00000000000${n}`, filename: `image-${n}.png` }
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
  player.state.value = 'idle'
  player.activeId.value = null
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
    await flushPromises()
    expect(events.edit).toEqual([['Changed', []]])
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

  it('edits the attachments too: the editor starts with the message\'s files and emits the new set', async () => {
    const photo = imagePart(1)
    const message: HarnessUIMessage = { ...user, parts: [photo, { type: 'text', text: 'What is this?' }] }
    const { wrapper, events } = mountMessage({ message, isLast: false, streaming: false, showThinking: false })
    await wrapper.get(`[data-testid="${testIds.messageEdit}"]`).trigger('click')
    const chips = wrapper.findAll(`[data-testid="${testIds.messageEditAttachment}"]`)
    expect(chips).toHaveLength(1)
    await wrapper.get('[aria-label="Remove image-1.png"]').trigger('click')
    await wrapper.get(`[data-testid="${testIds.messageEditSave}"]`).trigger('click')
    await flushPromises()
    expect(events.edit).toEqual([['What is this?', []]])
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

  it('offers Regenerate on every finished reply (older ones hide it through data-busy), not while busy or streaming', async () => {
    const older = mountMessage({ message: assistant(), isLast: false, streaming: false, showThinking: false })
    const button = older.wrapper.get(`[data-testid="${testIds.messageRegenerate}"]`)
    expect(button.classes()).toContain('group-data-[busy=true]/transcript:hidden')
    await button.trigger('click')
    expect(older.events.regenerate).toHaveLength(1)
    expect(mountMessage({ message: assistant(), isLast: true, streaming: false, showThinking: false, busy: true })
      .wrapper.find(`[data-testid="${testIds.messageRegenerate}"]`).exists()).toBe(false)
    expect(mountMessage({ message: assistant(), isLast: true, streaming: true, showThinking: false })
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

  it('passes "Accept all edits in this chat" up unchanged (the session switches the mode)', () => {
    const message = assistant({
      parts: [{ type: 'tool-edit_file', toolCallId: 'c1', state: 'approval-requested', input: { path: 'a.ts', old_string: 'a', new_string: 'b' }, approval: { id: 'appr_1' } }],
    })
    const { wrapper, events } = mountMessage({ message, isLast: true, streaming: false, showThinking: false })
    const decision = { id: 'appr_1', approved: true, toolName: 'edit_file', alwaysAllow: false, acceptEdits: true }
    wrapper.getComponent(ToolPart).vm.$emit('approval', decision)
    expect(events.approval).toEqual([[decision]])
  })
})

describe('chatMessage: versions', () => {
  const branch = { siblings: ['msg_version000000001', user.id, 'msg_version000000003'], index: 1 }

  /** The action row: the switcher first, then the actions that fade in on hover. */
  function actionRow(wrapper: ReturnType<typeof mountMessage>['wrapper']) {
    const row = wrapper.get('[data-slot="message-action-row"]')
    const switcher = row.get(`[data-testid="${testIds.messageBranch}"]`)
    const actions = row.get('[data-slot="message-actions"]')
    return { row, switcher, actions }
  }

  it('starts the action row of a user message with the switcher, outside the hover fade', async () => {
    const { wrapper, events } = mountMessage({ message: user, isLast: false, streaming: false, showThinking: false, branch })
    const { row, switcher, actions } = actionRow(wrapper)
    expect(row.element.firstElementChild).toBe(switcher.element)
    expect(actions.classes()).toContain('opacity-0')
    expect(switcher.element.closest('[data-slot="message-actions"]')).toBeNull()
    expect(switcher.attributes()).toMatchObject({ 'data-message-id': user.id, 'data-index': '1', 'data-count': '3' })
    expect(actions.find(`[data-testid="${testIds.messageEdit}"]`).exists()).toBe(true)

    await switcher.get(`[data-testid="${testIds.messageBranchNext}"]`).trigger('click')
    expect(events['select-version']).toEqual([['msg_version000000003']])
  })

  it('starts the action row of a reply with the switcher, before Copy, Regenerate and the meta', () => {
    const { wrapper } = mountMessage({
      message: assistant(),
      isLast: false,
      streaming: false,
      showThinking: false,
      branch: { siblings: ['msg_assistant0000001', 'msg_assistant0000002'], index: 0 },
    })
    const { row, switcher, actions } = actionRow(wrapper)
    expect(row.element.firstElementChild).toBe(switcher.element)
    expect(switcher.get(`[data-testid="${testIds.messageBranchCounter}"]`).text()).toBe('1/2')
    expect(actions.find(`[data-testid="${testIds.messageCopy}"]`).exists()).toBe(true)
    expect(actions.find(`[data-testid="${testIds.messageRegenerate}"]`).exists()).toBe(true)
    expect(actions.find(`[data-testid="${testIds.messageMeta}"]`).exists()).toBe(true)
  })

  it('disables the switcher while a request or a switch is in flight', () => {
    for (const state of [{ busy: true }, { switching: true }]) {
      const { wrapper } = mountMessage({ message: user, isLast: false, streaming: false, showThinking: false, branch, ...state })
      const { switcher } = actionRow(wrapper)
      expect(switcher.get(`[data-testid="${testIds.messageBranchPrevious}"]`).attributes('aria-disabled')).toBe('true')
      expect(switcher.get(`[data-testid="${testIds.messageBranchNext}"]`).attributes('aria-disabled')).toBe('true')
    }
  })

  it('shows no switcher for a message with a single version', () => {
    const { wrapper } = mountMessage({ message: user, isLast: false, streaming: false, showThinking: false })
    expect(wrapper.find(`[data-testid="${testIds.messageBranch}"]`).exists()).toBe(false)
  })
})

describe('chatMessage: generated images', () => {
  it('renders consecutive images as one gallery and other files as chips', () => {
    const message = assistant({
      parts: [
        { type: 'step-start' },
        { type: 'text', text: 'Here you go', state: 'done' },
        imagePart(1),
        imagePart(2, 'image/webp'),
        { type: 'file', mediaType: 'application/pdf', url: '/api/files/file_pdf0000000000001', filename: 'a.pdf' },
      ],
    })
    const { wrapper } = mountMessage({ message, isLast: true, streaming: false, showThinking: false })
    const galleries = wrapper.findAll(`[data-testid="${testIds.imageGallery}"]`)
    expect(galleries).toHaveLength(1)
    expect(galleries[0]!.attributes()).toMatchObject({ 'data-message-id': message.id, 'data-count': '2' })
    expect(wrapper.findAll(`[data-testid="${testIds.fileChip}"]`)).toHaveLength(1)
  })

  it('shows placeholder tiles while an image turn has no image yet, then the gallery', async () => {
    const metadata = { modelRef: 'mock:image', startedAt: 1_759_000_000_000, image: { n: 2, aspectRatio: '16:9' as const } }
    const { wrapper, state } = mountLive({
      message: assistant({ metadata, parts: [{ type: 'step-start' }] }),
      isLast: true,
      streaming: true,
      showThinking: false,
      busy: true,
    })
    const generating = wrapper.get(`[data-testid="${testIds.imageGenerating}"]`)
    expect(generating.attributes('data-count')).toBe('2')
    expect(wrapper.findComponent({ name: 'GeneratingImages' }).props()).toEqual({ n: 2, aspectRatio: '16:9', startedAt: 1_759_000_000_000 })
    // No "Thinking…" next to the tiles.
    expect(wrapper.find(`[data-testid="${testIds.submittedPlaceholder}"]`).exists()).toBe(false)

    state.value = { ...state.value, message: assistant({ metadata, parts: [{ type: 'step-start' }, imagePart(1)] }) }
    await nextTick()
    expect(wrapper.find(`[data-testid="${testIds.imageGenerating}"]`).exists()).toBe(false)
    expect(wrapper.get(`[data-testid="${testIds.imageGallery}"]`).attributes('data-count')).toBe('1')
  })

  it('ends the placeholders as soon as the turn finished, failed or stopped, even while the stream closes', () => {
    const base = { modelRef: 'mock:image', startedAt: 1, image: { n: 1 } }
    const ended = [
      { ...base, finishedAt: 2 },
      { ...base, error: { code: 'provider_error' as const, message: 'Upstream failed', providerId: 'mock' } },
      { ...base, aborted: true },
    ]
    for (const metadata of ended) {
      const { wrapper } = mountMessage({ message: assistant({ metadata, parts: [{ type: 'step-start' }] }), isLast: true, streaming: true, showThinking: false, busy: true })
      expect(wrapper.find(`[data-testid="${testIds.imageGenerating}"]`).exists()).toBe(false)
    }
  })

  it('shows no placeholders once an image turn stopped without images', () => {
    const message = assistant({ metadata: { modelRef: 'mock:image', startedAt: 1, aborted: true, image: { n: 1 } }, parts: [{ type: 'step-start' }] })
    const { wrapper } = mountMessage({ message, isLast: true, streaming: false, showThinking: false })
    expect(wrapper.find(`[data-testid="${testIds.imageGenerating}"]`).exists()).toBe(false)
    expect(wrapper.get(`[data-testid="${testIds.messageAssistant}"]`).attributes('data-status')).toBe('aborted')
    expect(wrapper.get(`[data-testid="${testIds.messageMeta}"]`).text()).toContain('Stopped')
  })

  it('adds the image line to the meta hover and labels the cost "Estimated cost"', async () => {
    const message = assistant({
      metadata: { modelRef: 'mock:image', startedAt: 1, durationMs: 3000, costUsd: 0.04, image: { n: 2, aspectRatio: '16:9', inputs: 1 } },
      parts: [imagePart(1), imagePart(2)],
    })
    const { wrapper } = mountMessage({ message, isLast: true, streaming: false, showThinking: false })
    await wrapper.get(`[data-testid="${testIds.messageMeta}"]`).trigger('focus')
    await new Promise(resolve => setTimeout(resolve, 450))
    await flushPromises()
    const card = document.body.querySelector('[data-slot="message-meta-images"]')
    expect(card?.textContent?.trim()).toBe('2 images · 16:9 · edited 1 image')
    expect(document.body.textContent).toContain('Estimated cost')
    expect(document.body.textContent).toContain('$0.04')
  })
})

describe('chatMessage: copy and read aloud', () => {
  function speechModel(modelRef: string | null) {
    useSettingsStore().settings = { ...DEFAULT_SETTINGS, speechModelRef: modelRef }
  }

  function actionIds(wrapper: ReturnType<typeof mountMessage>['wrapper']): Array<string | undefined> {
    const actions = wrapper.get('[data-slot="message-actions"]')
    return [...actions.element.children].map(child => (child as HTMLElement).dataset.testid)
  }

  it('offers Read aloud right after Copy on a finished reply with text, when a speech model is set', () => {
    speechModel('mock:speech')
    const { wrapper } = mountMessage({ message: assistant(), isLast: true, streaming: false, showThinking: false })
    expect(actionIds(wrapper).slice(0, 3)).toEqual([testIds.messageCopy, testIds.messageReadAloud, testIds.messageRegenerate])
    expect(wrapper.findComponent({ name: 'ReadAloudButton' }).props()).toEqual({ messageId: 'msg_assistant0000001', markdown: 'The **answer**' })
  })

  it('hides Copy and Read aloud on a reply of images only, and Read aloud while streaming', () => {
    speechModel('mock:speech')
    const images = mountMessage({ message: assistant({ parts: [imagePart(1)] }), isLast: true, streaming: false, showThinking: false })
    expect(images.wrapper.find(`[data-testid="${testIds.messageCopy}"]`).exists()).toBe(false)
    expect(images.wrapper.find(`[data-testid="${testIds.messageReadAloud}"]`).exists()).toBe(false)
    expect(images.wrapper.find(`[data-testid="${testIds.messageRegenerate}"]`).exists()).toBe(true)

    const streaming = mountMessage({ message: assistant(), isLast: true, streaming: true, showThinking: false, busy: true })
    expect(streaming.wrapper.find(`[data-testid="${testIds.messageReadAloud}"]`).exists()).toBe(false)
  })

  it('shows no Read aloud without a speech model', () => {
    speechModel(null)
    const { wrapper } = mountMessage({ message: assistant(), isLast: true, streaming: false, showThinking: false })
    expect(wrapper.find(`[data-testid="${testIds.messageReadAloud}"]`).exists()).toBe(false)
    expect(wrapper.find(`[data-testid="${testIds.messageCopy}"]`).exists()).toBe(true)
  })

  it('keeps the action row of an older reply visible while it is read aloud', async () => {
    speechModel('mock:speech')
    const { wrapper } = mountMessage({ message: assistant(), isLast: false, streaming: false, showThinking: false })
    const actions = () => wrapper.get('[data-slot="message-actions"]')
    expect(actions().classes()).toContain('opacity-0')
    // The CSS fallback: a pressed Read aloud button keeps the row visible.
    expect(actions().classes()).toContain('has-[[data-testid=message-read-aloud][aria-pressed=true]]:opacity-100')
    player.activeId.value = 'msg_assistant0000001'
    player.state.value = 'playing'
    await nextTick()
    expect(actions().classes()).not.toContain('opacity-0')
    expect(wrapper.get(`[data-testid="${testIds.messageReadAloud}"]`).attributes('data-state')).toBe('playing')
    player.state.value = 'idle'
    await nextTick()
    expect(actions().classes()).toContain('opacity-0')
  })
})

describe('chatMessage: rewind files (Phase 8)', () => {
  it('offers "Rewind files to here" on a user message with canRewind and re-emits it', async () => {
    const { wrapper, events } = mountMessage({ message: user, isLast: false, streaming: false, showThinking: false, canRewind: true })
    await wrapper.get(`[data-testid="${testIds.messageRewind}"]`).trigger('click')
    expect(events.rewind).toEqual([[]])
  })

  it('not by default, not while a request runs and never on a reply', () => {
    const cases: Array<Partial<Props>> = [{}, { canRewind: true, busy: true }]
    for (const extra of cases) {
      const { wrapper } = mountMessage({ message: user, isLast: false, streaming: false, showThinking: false, ...extra })
      expect(wrapper.find(`[data-testid="${testIds.messageRewind}"]`).exists()).toBe(false)
    }
    const reply = mountMessage({ message: assistant(), isLast: true, streaming: false, showThinking: false, canRewind: true })
    expect(reply.wrapper.find(`[data-testid="${testIds.messageRewind}"]`).exists()).toBe(false)
  })

  it('passes the shell rules of an approval up unchanged', () => {
    const message = assistant({
      parts: [{ type: 'tool-shell', toolCallId: 'c1', state: 'approval-requested', input: { command: 'pnpm test' }, approval: { id: 'appr_1' } }],
    })
    const { wrapper, events } = mountMessage({ message, isLast: true, streaming: false, showThinking: false })
    const decision = { id: 'appr_1', approved: true, toolName: 'shell', alwaysAllow: false, allowRules: { prefixes: ['pnpm test'], scope: 'global' as const } }
    wrapper.getComponent(ToolPart).vm.$emit('approval', decision)
    expect(events.approval).toEqual([[decision]])
  })
})

describe('chatMessage: delete a version', () => {
  const branch = { siblings: ['msg_version000000001', user.id], index: 1 }

  it('offers "Delete this version" on user messages and replies with versions', async () => {
    const userRow = mountMessage({ message: user, isLast: false, streaming: false, showThinking: false, branch })
    await userRow.wrapper.get(`[data-testid="${testIds.messageDeleteVersion}"]`).trigger('click')
    expect(userRow.events['delete-version']).toEqual([[]])

    const reply = mountMessage({
      message: assistant(),
      isLast: true,
      streaming: false,
      showThinking: false,
      branch: { siblings: ['msg_assistant0000001', 'msg_assistant0000002'], index: 0 },
    })
    await reply.wrapper.get(`[data-testid="${testIds.messageDeleteVersion}"]`).trigger('click')
    expect(reply.events['delete-version']).toEqual([[]])
  })

  it('not without versions, while a request runs or while a switch is pending', () => {
    const cases: Array<Partial<Props>> = [{ branch: null }, { branch, busy: true }, { branch, switching: true }]
    for (const extra of cases) {
      const { wrapper } = mountMessage({ message: user, isLast: false, streaming: false, showThinking: false, ...extra })
      expect(wrapper.find(`[data-testid="${testIds.messageDeleteVersion}"]`).exists()).toBe(false)
    }
  })
})

describe('chatMessage: agent parts (Phase 9 seams)', () => {
  it('renders compaction markers, steers and task calls as their blocks, in part order', () => {
    const message = assistant({
      parts: [
        { type: 'step-start' },
        compactionPart({ trigger: 'auto' }),
        { type: 'text', text: 'Step 1 done.', state: 'done' },
        steerPart(),
        taskPart(),
        compactionPart({ trigger: 'auto' }, 'compaction_2'),
      ],
    })
    const { wrapper } = mountMessage({ message, isLast: true, streaming: false, showThinking: false })
    const dividers = wrapper.findAll(`[data-testid="${testIds.compactionDivider}"]`)
    expect(dividers.map(divider => divider.attributes('data-variant'))).toEqual(['history', 'run'])
    expect(wrapper.find(`[data-testid="${testIds.steerNote}"]`).exists()).toBe(true)
    expect(wrapper.get(`[data-testid="${testIds.taskBlock}"]`).attributes('data-state')).toBe('completed')
    const order = [...wrapper.element.querySelectorAll('[data-testid]')]
      .map(element => element.getAttribute('data-testid'))
      .filter(id => id === testIds.compactionDivider || id === testIds.steerNote || id === testIds.taskBlock)
    expect(order).toEqual([testIds.compactionDivider, testIds.steerNote, testIds.taskBlock, testIds.compactionDivider])
  })

  it('marks a compacted row and accepts the activity', () => {
    const reply = mountMessage({ message: assistant(), isLast: false, streaming: false, showThinking: false, compacted: true })
    expect(reply.wrapper.get(`[data-testid="${testIds.messageAssistant}"]`).attributes('data-compacted')).toBe('true')
    const question = mountMessage({ message: user, isLast: false, streaming: false, showThinking: false, compacted: true })
    expect(question.wrapper.get(`[data-testid="${testIds.messageUser}"]`).attributes('data-compacted')).toBe('true')
    const streaming = mountMessage({ message: assistant({ parts: [] }), isLast: true, streaming: true, showThinking: false, activity: 'compacting' })
    expect(streaming.wrapper.get(`[data-testid="${testIds.messageAssistant}"]`).attributes('data-compacted')).toBeUndefined()
  })

  it('dims the blocks before the last marker of a reply that compacted during the run', () => {
    const message = assistant({
      parts: [
        { type: 'step-start' },
        { type: 'text', text: 'Step 1 done.', state: 'done' },
        { type: 'tool-web_fetch', toolCallId: 'c1', state: 'output-available', input: { url: 'https://a.example' }, output: 'ok' },
        steerPart(),
        { type: 'step-start' },
        compactionPart({ trigger: 'auto', keep: 'last-user' }),
        { type: 'text', text: 'Step 2 done.', state: 'done' },
      ],
    })
    const { wrapper } = mountMessage({ message, isLast: true, streaming: false, showThinking: false })
    const root = wrapper.get(`[data-testid="${testIds.messageAssistant}"]`)
    expect(root.attributes('data-compacted')).toBeUndefined()
    const dimmed = (element: Element | undefined) => element?.classList.contains('opacity-70') ?? false
    const markdown = root.findAll('[data-slot="markdown"]')
    expect(markdown.map(block => dimmed(block.element))).toEqual([true, false])
    expect(dimmed(root.get('[data-slot="tool-part"]').element)).toBe(true)
    expect(dimmed(root.get(`[data-testid="${testIds.steerNote}"]`).element)).toBe(true)
    const divider = root.get(`[data-testid="${testIds.compactionDivider}"]`)
    expect(divider.attributes('data-variant')).toBe('run')
    expect(divider.attributes('aria-label')).toBe('Context compacted during this response')
    expect(dimmed(divider.element)).toBe(false)
    // Dimmed blocks come back on hover and focus.
    expect(root.get('[data-slot="tool-part"]').classes()).toEqual(expect.arrayContaining(['hover:opacity-100', 'focus-within:opacity-100']))
  })

  it('dims nothing inside a reply that opens with its marker, nor inside a compacted row (the row is dimmed)', () => {
    const opening = assistant({ parts: [{ type: 'step-start' }, compactionPart({ trigger: 'auto' }), { type: 'text', text: 'Answer', state: 'done' }] })
    const first = mountMessage({ message: opening, isLast: true, streaming: false, showThinking: false })
    expect(first.wrapper.findAll('.opacity-70')).toHaveLength(0)
    expect(first.wrapper.get(`[data-testid="${testIds.compactionDivider}"]`).attributes('aria-label')).toBe('Conversation compacted automatically')

    const inRun = assistant({ parts: [{ type: 'text', text: 'Step 1.', state: 'done' }, compactionPart({ trigger: 'auto' })] })
    const compacted = mountMessage({ message: inRun, isLast: false, streaming: false, showThinking: false, compacted: true })
    const root = compacted.wrapper.get(`[data-testid="${testIds.messageAssistant}"]`)
    expect(root.classes()).toContain('opacity-70')
    expect(root.findAll('.opacity-70')).toHaveLength(0)
  })

  it('labels a /compact reply "Conversation compacted"', () => {
    const message = assistant({ parts: [compactionPart({ focus: 'tests' })] })
    const { wrapper } = mountMessage({ message, isLast: true, streaming: false, showThinking: false })
    const divider = wrapper.get(`[data-testid="${testIds.compactionDivider}"]`)
    expect(divider.attributes()).toMatchObject({ 'data-kind': 'manual', 'data-variant': 'history', 'data-count': '12', 'aria-label': 'Conversation compacted' })
    // Nothing to copy or read aloud: the reply has no text.
    expect(wrapper.find(`[data-testid="${testIds.messageCopy}"]`).exists()).toBe(false)
  })

  it('shows "Compacting conversation…" instead of "Thinking…" while the session compacts', async () => {
    const placeholder = (wrapper: ReturnType<typeof mountLive>['wrapper']) => wrapper.find(`[data-testid="${testIds.submittedPlaceholder}"]`)
    const { wrapper, state } = mountLive({ message: assistant({ parts: [] }), isLast: true, streaming: true, showThinking: false, activity: 'compacting' })
    expect(placeholder(wrapper).text()).toBe('Compacting conversation…')

    // Done compacting: "Thinking…" until the next step renders something after the divider.
    state.value = { ...state.value, activity: null, message: assistant({ parts: [compactionPart({ trigger: 'auto' })] }) }
    await nextTick()
    expect(placeholder(wrapper).text()).toBe('Thinking…')
    state.value = { ...state.value, message: assistant({ parts: [compactionPart({ trigger: 'auto' }), { type: 'text', text: 'Hi', state: 'streaming' }] }) }
    await nextTick()
    expect(placeholder(wrapper).exists()).toBe(false)

    // A compaction during the run: the line shows at the end of the reply.
    state.value = { ...state.value, activity: 'compacting' }
    await nextTick()
    expect(placeholder(wrapper).text()).toBe('Compacting conversation…')
    const blocks = [...wrapper.get(`[data-testid="${testIds.messageAssistant}"]`).element.children]
    expect(blocks.indexOf(placeholder(wrapper).element)).toBeGreaterThan(blocks.indexOf(wrapper.get('[data-slot="markdown"]').element))

    // Never once the reply stopped streaming.
    state.value = { ...state.value, streaming: false }
    await nextTick()
    expect(placeholder(wrapper).exists()).toBe(false)
  })

  it('keeps "Thinking…" for a streaming reply without blocks and no activity', () => {
    const { wrapper } = mountMessage({ message: assistant({ parts: [{ type: 'step-start' }] }), isLast: true, streaming: true, showThinking: false })
    expect(wrapper.get(`[data-testid="${testIds.submittedPlaceholder}"]`).text()).toBe('Thinking…')
  })

  it('passes the approvals of task blocks and plan cards up', () => {
    const message = assistant({ parts: [taskPart(), planApprovalPart()] })
    const { wrapper, events } = mountMessage({ message, isLast: true, streaming: false, showThinking: false })
    const task = { id: 'appr_task', approved: true, toolName: 'task', alwaysAllow: false }
    wrapper.getComponent(TaskBlock).vm.$emit('approval', task)
    const plan = { id: 'approval_call_plan_1', approved: true, toolName: 'exit_plan_mode', alwaysAllow: false, planMode: 'edits', reason: 'Go' }
    wrapper.findAllComponents(ToolPart).at(-1)!.vm.$emit('approval', plan)
    expect(events.approval).toEqual([[task], [plan]])
  })
})

describe('chatMessage: background agent results (Phase 10)', () => {
  it('renders a delivered result inside a reply as an inline note at its position', () => {
    const message = assistant({ parts: [{ type: 'text', text: 'Working.', state: 'done' }, taskResultPart(), { type: 'text', text: 'Done.', state: 'done' }] })
    const { wrapper } = mountMessage({ message, isLast: true, streaming: false, showThinking: false })
    const note = wrapper.get(`[data-testid="${testIds.taskResult}"]`)
    expect(note.attributes()).toMatchObject({ 'data-variant': 'inline', 'data-task-id': backgroundTaskId(1) })
  })

  it('renders a carrier as its notes with "Sent to the agent", without bubble, actions or edit', async () => {
    const carrier = taskResultCarrier('msg_carrier000000001', [taskResultData(), taskResultData({ taskId: backgroundTaskId(2) })])
    const { wrapper, instance } = mountMessage({ message: carrier, isLast: false, streaming: false, showThinking: false, canRewind: true, branch: null })
    const row = wrapper.get(`[data-testid="${testIds.messageUser}"]`)
    expect(row.findAll(`[data-testid="${testIds.taskResult}"]`).map(note => [note.attributes('data-task-id'), note.attributes('data-variant')]))
      .toEqual([[backgroundTaskId(1), 'turn'], [backgroundTaskId(2), 'turn']])
    expect(row.text()).toContain('Sent to the agent')
    expect(row.find('[data-slot="user-message"]').exists()).toBe(false)
    expect(row.find('[data-slot="message-action-row"]').exists()).toBe(false)
    expect(wrapper.find(`[data-testid="${testIds.messageRewind}"]`).exists()).toBe(false)
    instance.value?.startEdit()
    await nextTick()
    expect(wrapper.find(`[data-testid="${testIds.messageEditInput}"]`).exists()).toBe(false)
  })

  it('keeps the carrier itself unfocusable, its caption hidden from screen readers and its notes\' toggles working', async () => {
    const { wrapper } = mountMessage({ message: taskResultCarrier('msg_carrier000000002'), isLast: false, streaming: false, showThinking: false })
    const row = wrapper.get(`[data-testid="${testIds.messageUser}"]`)
    expect(row.attributes('tabindex')).toBeUndefined()
    expect(row.classes()).toContain('items-start')
    const caption = row.findAll('p').at(-1)!
    expect(caption.text()).toBe('Sent to the agent')
    expect(caption.attributes('aria-hidden')).toBe('true')
    await row.get(`[data-testid="${testIds.taskResultToggle}"]`).trigger('click')
    expect(row.find(`[data-testid="${testIds.taskResultReport}"]`).exists()).toBe(true)
  })
})

describe('chatMessage: hook records (Phase 11, P11-0b mounts)', () => {
  it('renders an unlinked record as an inline note at its position and gives tool-linked records to their row', () => {
    const tool = { type: 'tool-write_file', toolCallId: 'call_write_1', state: 'output-denied', input: { path: 'dist/a.js' }, approval: { id: 'a1', approved: false } } as unknown as HarnessUIMessage['parts'][number]
    const stop = hookData({ id: hookRecordId(2), event: 'Stop', outcome: 'stopped', toolCallId: undefined, toolName: undefined, reason: 'Build is red.' })
    const message = assistant({ parts: [tool, hookPart(), { type: 'text', text: 'Done.', state: 'done' }, { type: 'data-hook', id: stop.id, data: stop }] })
    const { wrapper } = mountMessage({ message, isLast: true, streaming: false, showThinking: false })
    const reply = wrapper.get(`[data-testid="${testIds.messageAssistant}"]`)
    const notes = reply.findAll(`[data-testid="${testIds.hookNote}"]`)
    // The tool's notes are in its (closed) body; the Stop record is a note of the reply.
    expect(notes.map(note => [note.attributes('data-event'), note.attributes('data-variant')])).toEqual([['Stop', 'inline']])
    expect(wrapper.getComponent(ToolPart).props('hooks')).toEqual([hookData()])
    expect(reply.get(`[data-testid="${testIds.toolRowHook}"]`).attributes('data-value')).toBe('denied')
  })

  it('renders the records of a task call right after its block', () => {
    const record = hookData({ toolCallId: 'call_task_1', toolName: 'task', outcome: 'context', context: 'Use the fixtures.' })
    const message = assistant({ parts: [taskPart(), { type: 'data-hook', id: record.id, data: record }] })
    const { wrapper } = mountMessage({ message, isLast: true, streaming: false, showThinking: false })
    expect(wrapper.findComponent(TaskBlock).exists()).toBe(true)
    expect(wrapper.get(`[data-testid="${testIds.hookNote}"]`).attributes('data-variant')).toBe('inline')
  })

  it('renders the records of a user message under its bubble', () => {
    const context = hookData({ event: 'UserPromptSubmit', outcome: 'context', toolCallId: undefined, toolName: undefined, context: 'Branch: main' })
    const message: HarnessUIMessage = { ...user, parts: [...user.parts, { type: 'data-hook', id: context.id, data: context }] }
    const { wrapper } = mountMessage({ message, isLast: false, streaming: false, showThinking: false })
    const row = wrapper.get(`[data-testid="${testIds.messageUser}"]`)
    expect(row.find('[data-slot="user-message"]').exists()).toBe(true)
    expect(row.get(`[data-testid="${testIds.hookNote}"]`).attributes()).toMatchObject({ 'data-event': 'UserPromptSubmit', 'data-variant': 'inline' })
    expect(row.find('[data-slot="message-action-row"]').exists()).toBe(true)
  })

  it('renders a hook carrier as its notes with "Sent to the agent", without bubble, actions, edit or rewind', async () => {
    const { wrapper, instance } = mountMessage({ message: hookCarrier('msg_carrier000000003'), isLast: false, streaming: false, showThinking: false, canRewind: true })
    const row = wrapper.get(`[data-testid="${testIds.messageUser}"]`)
    expect(row.findAll(`[data-testid="${testIds.hookNote}"]`).map(note => note.attributes('data-variant'))).toEqual(['turn'])
    expect(row.text()).toContain('Run the tests first.')
    expect(row.text()).toContain('Sent to the agent')
    expect(row.find('[data-slot="user-message"]').exists()).toBe(false)
    expect(row.find('[data-slot="message-action-row"]').exists()).toBe(false)
    expect(wrapper.find(`[data-testid="${testIds.messageRewind}"]`).exists()).toBe(false)
    instance.value?.startEdit()
    await nextTick()
    expect(wrapper.find(`[data-testid="${testIds.messageEditInput}"]`).exists()).toBe(false)
  })

  it('shows "Running hooks…" for the hooks activity of a streaming reply without blocks', () => {
    const { wrapper } = mountMessage({ message: assistant({ parts: [] }), isLast: true, streaming: true, showThinking: false, activity: 'hooks' })
    expect(wrapper.get(`[data-testid="${testIds.submittedPlaceholder}"]`).text()).toBe('Running hooks…')
  })
})

describe('chatMessage: command badge (Phase 10)', () => {
  it('passes the message\'s command to the badge: its model and its source', () => {
    const message: HarnessUIMessage = {
      ...user,
      metadata: { modelRef: 'mock:echo', startedAt: 1, command: { name: 'review', input: 'src/a.ts', type: 'prompt', source: 'project', modelRef: 'openai:gpt-6' } },
      parts: [{ type: 'text', text: '/review src/a.ts' }],
    }
    const { wrapper } = mountMessage({ message, isLast: false, streaming: false, showThinking: false })
    const badge = wrapper.get('[data-slot="command-badge"]')
    expect(badge.get('[data-slot="command-badge-model"]').text()).toBe('· gpt-6')
    expect(badge.text()).toContain(', Project command, Runs on gpt-6')
  })
})
