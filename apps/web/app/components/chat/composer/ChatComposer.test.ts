import type { AudioTranscription, FileRef, MessageUsage, ProjectFileEntry, ProjectFileSearch, ReasoningEffort, ToolMode } from '@harness-forge/shared'
import type { ChatStatus } from 'ai'
import type { Mock } from 'vitest'
import type { ChatComposerExposed } from './types'
import type { FakeMedia } from '~/utils/testing/fake-media'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick, reactive } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MENTION_SEARCH_DEBOUNCE_MS } from '~/composables/useFileMentions'
import { IMAGE_OPTIONS_KEY, useImageOptions } from '~/composables/useImageOptions'
import { useShortcuts } from '~/composables/useShortcuts'
import { useBackgroundTasksStore } from '~/stores/background-tasks'
import { useChatsStore } from '~/stores/chats'
import { useCustomizationsStore } from '~/stores/customizations'
import { usePluginsStore } from '~/stores/plugins'
import { useProjectTrustStore } from '~/stores/project-trust'
import { useProjectsStore } from '~/stores/projects'
import { useProvidersStore } from '~/stores/providers'
import { useSettingsStore } from '~/stores/settings'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'
import { installFakeMedia } from '~/utils/testing/fake-media'
import { catalogModel, chatId, chatSummary, customizationList, messageId, pluginSummary, projectFileEntry, projectId, projectSummary, projectTrustList, queueItem, rememberResult, styleEntry, trustCommandItem } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { CHAT_VIEW_ACTIONS } from '../chat-context'
import ChatComposer from './ChatComposer.vue'
import { anthropic, bodyAll, byTestId, haiku, llama, NuxtLinkStub, ollama, openai, seedStores, sonnet } from './composer-test-utils'
import ComposerAddMenu from './ComposerAddMenu.vue'
import SendStopButton from './SendStopButton.vue'

const mock = vi.hoisted(() => ({
  api: null as unknown,
  navigateTo: null as unknown as Mock<(...args: unknown[]) => unknown>,
  toast: null as unknown as Mock<(...args: unknown[]) => unknown>,
  toastError: null as unknown as Mock<(...args: unknown[]) => unknown>,
  toastSuccess: null as unknown as Mock<(...args: unknown[]) => unknown>,
  player: { stop: null as unknown as Mock<() => void> },
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))
vi.mock('./nuxt-imports', () => ({ navigateTo: (...args: unknown[]) => mock.navigateTo(...args) }))
vi.mock('vue-sonner', () => ({
  toast: Object.assign((...args: unknown[]) => mock.toast(...args), {
    error: (...args: unknown[]) => mock.toastError(...args),
    success: (...args: unknown[]) => mock.toastSuccess(...args),
  }),
}))
vi.mock('~/composables/useSpeechPlayer', () => ({ useSpeechPlayer: () => mock.player }))

interface HarnessState {
  chatId: string
  status: ChatStatus
  modelRef: string | null
  reasoningEffort: ReasoningEffort
  toolMode: ToolMode
  usage: MessageUsage | null
  chatCostUsd: number | null
  disabled: boolean
  previousImages: number
  projectId: string | null
  outputStyle: string | null
}

let pinia: ReturnType<typeof createPinia>
let api: MockApi
/** CHAT_VIEW_ACTIONS as ChatView provides them (reset before each test). */
let chatViewActions = { openModelPicker: vi.fn(), openProjectTrust: vi.fn(), openProjectMcp: vi.fn() }

function mountComposer(overrides: Partial<HarnessState> = {}) {
  const state = reactive<HarnessState>({
    chatId: chatId(1),
    status: 'ready',
    modelRef: sonnet.ref,
    reasoningEffort: 'auto',
    toolMode: 'ask',
    usage: null,
    chatCostUsd: null,
    disabled: false,
    previousImages: 0,
    projectId: null,
    outputStyle: null,
    ...overrides,
  })
  const wrapper = mount({
    render: () => h(TooltipProvider, null, {
      default: () => h(ChatComposer, {
        ...state,
        'onUpdate:modelRef': (value: string) => {
          state.modelRef = value
        },
        'onUpdate:reasoningEffort': (value: ReasoningEffort) => {
          state.reasoningEffort = value
        },
        'onUpdate:toolMode': (value: ToolMode) => {
          state.toolMode = value
        },
        'onUpdate:outputStyle': (value: string | null) => {
          state.outputStyle = value
        },
      }),
    }),
  }, { attachTo: document.body, global: { plugins: [pinia], stubs: { NuxtLink: NuxtLinkStub }, provide: { [CHAT_VIEW_ACTIONS as symbol]: chatViewActions } } })
  const composer = () => wrapper.findComponent(ChatComposer)
  const textarea = () => wrapper.get<HTMLTextAreaElement>(byTestId(testIds.composerInput))
  const send = () => wrapper.find(byTestId(testIds.composerSend))
  const mic = () => wrapper.get(byTestId(testIds.composerMic))
  const announcer = () => wrapper.get('[data-slot="composer-announcer"]')
  return { wrapper, state, composer, textarea, send, mic, announcer }
}

async function type(textarea: ReturnType<ReturnType<typeof mountComposer>['textarea']>, value: string) {
  await textarea.setValue(value)
  textarea.element.setSelectionRange(value.length, value.length)
  await textarea.trigger('keyup', { key: 'End' })
}

function press(element: Element, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  element.dispatchEvent(event)
  return event
}

function fileRef(name: string, mime: string): FileRef {
  const id = `file_${name.replace(/\W/g, '').padEnd(16, '0').slice(0, 16)}`
  return { id, name, mime, size: 4, url: `/api/files/${id}` }
}

function dragEvent(type: string, files: File[]) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files, dropEffect: 'none' } })
  return event
}

const shortcuts = useShortcuts()
let media: FakeMedia | null = null

const TRANSCRIPT = 'This is a mock transcription.'

function transcription(text = TRANSCRIPT): AudioTranscription {
  return { text, language: 'en', durationSec: 1.4, modelRef: 'mock:transcribe' }
}

/** Settings -> Media: a speech-to-text model is chosen. */
function configureDictation() {
  const settings = useSettingsStore()
  settings.settings = { ...settings.settings!, transcriptionModelRef: 'mock:transcribe' }
}

/** Moves the clock past the 0.5 s minimum clip (only Date is faked, timers stay real). */
function recordFor(ms: number) {
  vi.setSystemTime(Date.now() + ms)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const NO_CAPS = { tools: false, vision: false, pdf: false, reasoning: false, structuredOutput: false, imageOutput: false }
const gptImage = catalogModel({ providerId: 'openai', id: 'gpt-image-1', name: 'GPT Image 1', kind: 'image', contextWindow: null, capabilities: { ...NO_CAPS, vision: true } })

describe('chatComposer', () => {
  beforeAll(() => {
    window.addEventListener('keydown', shortcuts.handleKeydown)
  })

  beforeEach(() => {
    api = createMockApi()
    mock.api = api
    mock.navigateTo = vi.fn()
    mock.toast = vi.fn()
    mock.toastError = vi.fn()
    mock.toastSuccess = vi.fn()
    mock.player.stop = vi.fn()
    stubLocalStorage()
    useImageOptions().set({ n: undefined, aspectRatio: undefined, editPrevious: undefined })
    sessionStorage.clear()
    pinia = createPinia()
    setActivePinia(pinia)
    seedStores()
    chatViewActions = { openModelPicker: vi.fn(), openProjectTrust: vi.fn(), openProjectMcp: vi.fn() }
  })

  afterEach(() => {
    media?.()
    media = null
    shortcuts.setAltEnabled(() => true)
    vi.useRealTimers()
    disposePinia(pinia)
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  })

  afterAll(() => {
    window.removeEventListener('keydown', shortcuts.handleKeydown)
  })

  it('renders the Claude-style card: textarea, toolbar and a disabled Send while empty', () => {
    const { wrapper, textarea, send } = mountComposer()
    const root = wrapper.get(byTestId(testIds.composer))
    expect(root.attributes('data-status')).toBe('ready')
    expect(root.find('[role="form"][aria-label="Message composer"]').exists()).toBe(true)
    expect(textarea().attributes('placeholder')).toBe('Reply…')
    expect(textarea().attributes('enterkeyhint')).toBe('send')
    expect(wrapper.get(byTestId(testIds.composerAdd)).attributes('aria-label')).toBe('Add')
    expect(wrapper.get(byTestId(testIds.modelPickerTrigger)).attributes('data-model-ref')).toBe(sonnet.ref)
    expect(wrapper.find(byTestId(testIds.effortMenuTrigger)).exists()).toBe(true)
    expect(wrapper.find(byTestId(testIds.permissionMenuTrigger)).exists()).toBe(true)
    expect(wrapper.find(byTestId(testIds.contextRing)).exists()).toBe(false)
    expect(send().attributes('aria-disabled')).toBe('true')
    expect(wrapper.find(byTestId(testIds.composerStop)).exists()).toBe(false)
    expect(wrapper.get(byTestId(testIds.composerFileInput)).attributes('accept')).toContain('image/*')
    expect(document.activeElement).toBe(textarea().element)
    wrapper.unmount()
  })

  describe('send key', () => {
    it('sendKey=enter: Enter sends the trimmed text, Shift+Enter does not', async () => {
      const { wrapper, composer, textarea } = mountComposer()
      await type(textarea(), '  hello world \n')
      const shift = press(textarea().element, { key: 'Enter', shiftKey: true })
      expect(shift.defaultPrevented).toBe(false)
      expect(composer().emitted('submit')).toBeUndefined()

      const enter = press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(enter.defaultPrevented).toBe(true)
      expect(composer().emitted('submit')).toEqual([[{ text: 'hello world', files: [] }]])
      expect(textarea().element.value).toBe('')
      wrapper.unmount()
    })

    it('sendKey=mod-enter: Enter inserts a newline, Mod+Enter sends', async () => {
      seedStores({ sendKey: 'mod-enter' })
      const { wrapper, composer, textarea } = mountComposer()
      expect(textarea().attributes('enterkeyhint')).toBe('enter')
      await type(textarea(), 'line one')
      const enter = press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(enter.defaultPrevented).toBe(false)
      expect(composer().emitted('submit')).toBeUndefined()

      press(textarea().element, { key: 'Enter', ctrlKey: true })
      await flushPromises()
      expect(composer().emitted('submit')).toEqual([[{ text: 'line one', files: [] }]])

      await type(textarea(), 'again')
      press(textarea().element, { key: 'Enter', metaKey: true })
      await flushPromises()
      expect(composer().emitted('submit')).toHaveLength(2)
      wrapper.unmount()
    })

    it('ignores Enter during an IME composition', async () => {
      const { wrapper, composer, textarea } = mountComposer()
      await type(textarea(), 'nihon')
      press(textarea().element, { key: 'Enter', isComposing: true } as KeyboardEventInit)
      await flushPromises()
      expect(composer().emitted('submit')).toBeUndefined()
      wrapper.unmount()
    })
  })

  it('send submits, records the model as recent, clears the text and the draft', async () => {
    const { wrapper, composer, textarea, send } = mountComposer({ modelRef: llama.ref })
    await type(textarea(), 'hi there')
    expect(send().attributes('aria-disabled')).toBeUndefined()
    await send().trigger('click')
    await flushPromises()
    expect(composer().emitted('submit')).toEqual([[{ text: 'hi there', files: [] }]])
    expect(textarea().element.value).toBe('')
    expect(sessionStorage.length).toBe(0)
    expect(JSON.parse(localStorage.getItem('hf-recent-models') ?? '[]')).toEqual([llama.ref])
    wrapper.unmount()
  })

  it('shows Stop while a response runs: click or Esc stops, Enter queues the message (Phase 9)', async () => {
    const { wrapper, state, composer, textarea } = mountComposer({ status: 'streaming' })
    expect(wrapper.get(byTestId(testIds.composer)).attributes('data-status')).toBe('streaming')
    expect(wrapper.find(byTestId(testIds.composerSend)).exists()).toBe(false)
    expect(textarea().attributes('placeholder')).toBe('Queue a message…')
    await wrapper.get(byTestId(testIds.composerStop)).trigger('click')
    expect(composer().emitted('stop')).toHaveLength(1)

    press(textarea().element, { key: 'Escape' })
    expect(composer().emitted('stop')).toHaveLength(2)

    await type(textarea(), 'queued?')
    const enter = press(textarea().element, { key: 'Enter' })
    await flushPromises()
    expect(enter.defaultPrevented).toBe(true)
    expect(composer().emitted('submit')).toEqual([[{ text: 'queued?', files: [] }]])
    expect(textarea().element.value).toBe('')
    expect(document.activeElement).toBe(textarea().element)

    // Esc outside inputs stops too (global shortcut).
    textarea().element.blur()
    press(document.body, { key: 'Escape' })
    expect(composer().emitted('stop')).toHaveLength(3)

    state.status = 'ready'
    await nextTick()
    press(document.body, { key: 'Escape' })
    expect(composer().emitted('stop')).toHaveLength(3)
    wrapper.unmount()
  })

  it('↑ in an empty composer asks to edit the last message', async () => {
    const { wrapper, composer, textarea } = mountComposer()
    const up = press(textarea().element, { key: 'ArrowUp' })
    expect(up.defaultPrevented).toBe(true)
    expect(composer().emitted('edit-last')).toHaveLength(1)

    await type(textarea(), 'not empty')
    press(textarea().element, { key: 'ArrowUp' })
    expect(composer().emitted('edit-last')).toHaveLength(1)
    wrapper.unmount()
  })

  describe('slash commands', () => {
    it('opens the slash menu on / with client and server commands', async () => {
      const { wrapper, textarea } = mountComposer()
      await type(textarea(), '/')
      const menu = wrapper.get(byTestId(testIds.slashMenu))
      expect(menu.findAll(byTestId(testIds.slashMenuItem)).map(item => item.attributes('data-value')))
        .toEqual(['new', 'model', 'effort', 'mode', 'help', 'remember', 'output-style', 'summarize'])
      expect(textarea().attributes('aria-controls')).toBe(menu.attributes('id'))

      await type(textarea(), '/mo')
      expect(wrapper.findAll(byTestId(testIds.slashMenuItem)).map(item => item.attributes('data-value'))).toEqual(['model', 'mode'])
      expect(textarea().attributes('aria-activedescendant')).toBe(wrapper.findAll(byTestId(testIds.slashMenuItem))[0]!.attributes('id'))

      await type(textarea(), '/model ')
      expect(wrapper.find(byTestId(testIds.slashMenu)).exists()).toBe(false)
      wrapper.unmount()
    })

    it('enter on /model opens the model picker without submitting', async () => {
      const { wrapper, composer, textarea } = mountComposer()
      await type(textarea(), '/mod')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(composer().emitted('submit')).toBeUndefined()
      expect(textarea().element.value).toBe('')
      expect(bodyAll(byTestId(testIds.modelPicker))).toHaveLength(1)
      wrapper.unmount()
    })

    it('enter on a fully typed /mode opens the permission menu, not /model', async () => {
      const { wrapper, textarea } = mountComposer()
      await type(textarea(), '/mode')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(bodyAll(byTestId(testIds.modelPicker))).toHaveLength(0)
      expect(bodyAll(byTestId(testIds.permissionOption)).map(option => option.dataset.value)).toEqual(['ask', 'auto', 'off'])
      wrapper.unmount()
    })

    it('applies client commands with arguments and never submits them', async () => {
      const { wrapper, state, composer, textarea } = mountComposer()
      await type(textarea(), '/effort high')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(state.reasoningEffort).toBe('high')
      expect(textarea().element.value).toBe('')

      await type(textarea(), '/mode auto')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(state.toolMode).toBe('auto')
      await nextTick()
      expect(wrapper.get(byTestId(testIds.permissionMenuTrigger)).classes()).toContain('text-primary')

      await type(textarea(), '/model llama3:8b')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(state.modelRef).toBe(llama.ref)

      await type(textarea(), '/help')
      await textarea().trigger('keyup', { key: ' ' })
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(useUiStore().shortcutsOpen).toBe(true)

      await type(textarea(), '/new ')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(mock.navigateTo).toHaveBeenCalledWith('/')

      expect(composer().emitted('submit')).toBeUndefined()
      wrapper.unmount()
    })

    it('explains an invalid argument and keeps the text', async () => {
      const { wrapper, composer, textarea } = mountComposer()
      await type(textarea(), '/effort extreme')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(mock.toastError).toHaveBeenCalledWith('Unknown effort "extreme". Use auto, low, medium or high.')
      expect(textarea().element.value).toBe('/effort extreme')
      expect(composer().emitted('submit')).toBeUndefined()
      wrapper.unmount()
    })

    it('completes a server command and sends it as typed', async () => {
      const { wrapper, composer, textarea } = mountComposer()
      await type(textarea(), '/sum')
      press(textarea().element, { key: 'Tab' })
      await flushPromises()
      expect(textarea().element.value).toBe('/summarize ')
      expect(wrapper.find(byTestId(testIds.slashMenu)).exists()).toBe(false)

      await type(textarea(), '/summarize the last hour')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(composer().emitted('submit')).toEqual([[{ text: '/summarize the last hour', files: [] }]])
      wrapper.unmount()
    })

    it('esc closes the slash menu until the command changes', async () => {
      const { wrapper, textarea } = mountComposer()
      await type(textarea(), '/mo')
      press(textarea().element, { key: 'Escape' })
      await nextTick()
      expect(wrapper.find(byTestId(testIds.slashMenu)).exists()).toBe(false)
      await type(textarea(), '/mod')
      expect(wrapper.find(byTestId(testIds.slashMenu)).exists()).toBe(true)
      wrapper.unmount()
    })

    it('the + menu inserts / to open the menu', async () => {
      const { wrapper, textarea } = mountComposer()
      await wrapper.get(byTestId(testIds.composerAdd)).trigger('keydown', { key: 'Enter' })
      await flushPromises()
      const commands = bodyAll('[role="menuitem"]').find(item => item.textContent?.includes('Commands'))!
      commands.click()
      await flushPromises()
      expect(textarea().element.value).toBe('/')
      expect(wrapper.find(byTestId(testIds.slashMenu)).exists()).toBe(true)
      wrapper.unmount()
    })
  })

  describe('customized commands and Remember (Phase 10)', () => {
    const projectCommands = [
      { name: 'compact', description: 'Summarize the conversation', source: 'harness' as const, pluginId: 'core-agent', argumentHint: '[focus]' },
      { name: 'review', description: 'Review a file for bugs', source: 'project' as const, namespace: 'frontend', argumentHint: '<file> [focus]' },
      { name: 'standup', description: 'Draft my standup notes', source: 'user' as const },
      { name: 'summarize', description: 'Summarize the chat', source: 'plugin' as const, pluginId: 'core-commands' },
    ]

    function rows(wrapper: ReturnType<typeof mountComposer>['wrapper']) {
      return wrapper.findAll(byTestId(testIds.slashMenuItem)).map(item => `${item.attributes('data-group')}:${item.attributes('data-value')}`)
    }

    /** A saved chat (the chats store knows it) of project 1. */
    function seedProjectChat() {
      useProjectsStore().items = [projectSummary({ id: projectId(1), name: 'website', instructionsFile: 'AGENTS.md' })]
      useChatsStore().items = [chatSummary({ id: chatId(1), projectId: projectId(1) })]
    }

    function rememberNote(): HTMLTextAreaElement {
      return bodyAll(byTestId(testIds.rememberText))[0] as HTMLTextAreaElement
    }

    function rememberTarget(value: string): HTMLButtonElement {
      return bodyAll(byTestId(testIds.rememberTarget, `[data-value="${value}"]`))[0] as HTMLButtonElement
    }

    it('lists the project\'s commands in the groups App, Project, Personal and Plugins', async () => {
      api.commands.list.mockResolvedValue({ items: projectCommands })
      const { wrapper, textarea } = mountComposer({ projectId: projectId(1) })
      await flushPromises()
      expect(api.commands.list).toHaveBeenCalledWith({ query: { projectId: projectId(1) } })
      await type(textarea(), '/')
      expect(rows(wrapper)).toEqual([
        'app:new',
        'app:model',
        'app:effort',
        'app:mode',
        'app:help',
        'app:remember',
        'app:output-style',
        'app:compact',
        'project:review',
        'personal:standup',
        'plugin:summarize',
      ])
      const menu = wrapper.get(byTestId(testIds.slashMenu))
      expect(menu.findAll('[role="group"]').map(group => wrapper.get(`#${group.attributes('aria-labelledby')}`).text()))
        .toEqual(['App', 'Project', 'Personal', 'Plugins'])
      await type(textarea(), '/re')
      expect(rows(wrapper)).toEqual(['app:remember', 'project:review'])
      wrapper.unmount()
    })

    it('shows the App group alone while the first list loads', async () => {
      api.commands.list.mockReturnValue(new Promise(() => {}))
      const { wrapper, textarea } = mountComposer({ projectId: projectId(1) })
      await type(textarea(), '/')
      expect(new Set(rows(wrapper).map(row => row.split(':')[0]))).toEqual(new Set(['app']))
      wrapper.unmount()
    })

    it('refetches the commands on a project change and when the menu opens, at most every 15 s', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      api.commands.list.mockResolvedValue({ items: projectCommands })
      const { wrapper, state, textarea } = mountComposer({ projectId: projectId(1) })
      await flushPromises()
      expect(api.commands.list).toHaveBeenCalledTimes(1)

      // A list younger than 15 s is used as it is.
      await type(textarea(), '/')
      await flushPromises()
      expect(api.commands.list).toHaveBeenCalledTimes(1)
      await type(textarea(), '')

      // Older: opening the menu fetches it again (a command file saved on disk shows up).
      vi.setSystemTime(Date.now() + 16_000)
      await type(textarea(), '/')
      await flushPromises()
      expect(api.commands.list).toHaveBeenCalledTimes(2)
      // Typing more of the name does not refetch.
      await type(textarea(), '/re')
      await flushPromises()
      expect(api.commands.list).toHaveBeenCalledTimes(2)

      state.projectId = projectId(2)
      await flushPromises()
      expect(api.commands.list).toHaveBeenCalledTimes(3)
      expect(api.commands.list).toHaveBeenLastCalledWith({ query: { projectId: projectId(2) } })
      wrapper.unmount()
    })

    it('shows the argument hint of a typed command over the textarea, linked from it', async () => {
      useCustomizationsStore().commands = { '': [{ name: 'review', description: 'Review a file', source: 'user', argumentHint: '<file> [focus]' }] }
      const { wrapper, textarea } = mountComposer()
      await type(textarea(), '/review ')
      const hint = wrapper.get(byTestId(testIds.slashArgumentHint))
      expect(hint.attributes('aria-hidden')).toBe('true')
      expect(hint.text()).toContain('<file> [focus]')
      // The mirror lies over the textarea's own box.
      expect(hint.element.parentElement).toBe(textarea().element.parentElement)
      expect(hint.element.parentElement?.classList.contains('relative')).toBe(true)
      const describedBy = textarea().attributes('aria-describedby')!
      expect(wrapper.get(`#${describedBy}`).text()).toBe('Arguments: <file> [focus]')
      await type(textarea(), '/review src/a.ts')
      expect(wrapper.find(byTestId(testIds.slashArgumentHint)).exists()).toBe(false)
      expect(textarea().attributes('aria-describedby')).toBeUndefined()
      wrapper.unmount()
    })

    it('shows the hint after Tab completes a command, and hides it when the caret leaves the end or the text scrolls', async () => {
      useCustomizationsStore().commands = { '': [{ name: 'review', description: 'Review a file', source: 'user', argumentHint: '<file> [focus]' }] }
      const { wrapper, textarea } = mountComposer()
      const hint = () => wrapper.find(byTestId(testIds.slashArgumentHint))
      await type(textarea(), '/rev')
      press(textarea().element, { key: 'Tab' })
      await flushPromises()
      expect(textarea().element.value).toBe('/review ')
      expect(hint().exists()).toBe(true)

      // The hint never takes keys: with the menu closed Tab is left to the browser.
      const tab = press(textarea().element, { key: 'Tab' })
      expect(tab.defaultPrevented).toBe(false)

      textarea().element.setSelectionRange(3, 3)
      await textarea().trigger('keyup', { key: 'ArrowLeft' })
      expect(hint().exists()).toBe(false)
      textarea().element.setSelectionRange(8, 8)
      await textarea().trigger('keyup', { key: 'End' })
      expect(hint().exists()).toBe(true)

      textarea().element.scrollTop = 12
      await textarea().trigger('scroll')
      expect(hint().exists()).toBe(false)
      textarea().element.scrollTop = 0
      await textarea().trigger('scroll')
      expect(hint().exists()).toBe(true)

      await type(textarea(), '/standup ')
      expect(hint().exists()).toBe(false)
      wrapper.unmount()
    })

    it('/remember <text> clears the input and opens the Remember dialog with the text', async () => {
      const { wrapper, composer, textarea } = mountComposer()
      await type(textarea(), '/remember Run pnpm check first')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(textarea().element.value).toBe('')
      expect(composer().emitted('submit')).toBeUndefined()
      expect(bodyAll(byTestId(testIds.rememberDialog))).toHaveLength(1)
      expect(rememberNote().value).toBe('Run pnpm check first')
      // Not a saved project chat: the project targets are disabled, the custom instructions selected.
      expect(rememberTarget('project-file').disabled).toBe(true)
      expect(rememberTarget('global').getAttribute('aria-checked')).toBe('true')
      expect(api.memory.remember).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('picking /remember in the menu opens an empty dialog; closing it gives the focus back to the textarea', async () => {
      const { wrapper, textarea } = mountComposer()
      await type(textarea(), '/rem')
      expect(rows(wrapper)).toEqual(['app:remember'])
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(textarea().element.value).toBe('')
      expect(bodyAll(byTestId(testIds.rememberDialog))).toHaveLength(1)
      expect(rememberNote().value).toBe('')
      expect(document.activeElement).toBe(rememberNote())

      press(rememberNote(), { key: 'Escape' })
      await flushPromises()
      expect(bodyAll(byTestId(testIds.rememberDialog))).toHaveLength(0)
      expect(document.activeElement).toBe(textarea().element)
      wrapper.unmount()
    })

    it('in a saved project chat saves to the project file with the chat id', async () => {
      seedProjectChat()
      api.commands.list.mockResolvedValue({ items: [] })
      api.memory.remember.mockResolvedValue(rememberResult({ project: projectSummary({ id: projectId(1), name: 'website', instructionsFile: 'AGENTS.md' }) }))
      const { wrapper, textarea } = mountComposer({ projectId: projectId(1) })
      await type(textarea(), '/remember Use pnpm')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(rememberTarget('project-file').disabled).toBe(false)
      expect(rememberTarget('project-file').getAttribute('aria-checked')).toBe('true')
      expect(document.activeElement).toBe(rememberTarget('project-file'))
      press(rememberNote(), { key: 'Enter', ctrlKey: true })
      await flushPromises()
      expect(api.memory.remember).toHaveBeenCalledWith({ body: { target: 'project-file', text: 'Use pnpm', chatId: chatId(1) } })
      expect(mock.toastSuccess).toHaveBeenCalledWith('Saved to AGENTS.md')
      expect(bodyAll(byTestId(testIds.rememberDialog))).toHaveLength(0)
      expect(document.activeElement).toBe(textarea().element)
      wrapper.unmount()
    })

    it('in the draft chat of a project (not saved yet) the project targets wait for the first message', async () => {
      useProjectsStore().items = [projectSummary({ id: projectId(1), name: 'website' })]
      api.commands.list.mockResolvedValue({ items: [] })
      api.memory.remember.mockResolvedValue({ target: 'global', settings: useSettingsStore().resolved })
      const { wrapper, textarea } = mountComposer({ projectId: projectId(1) })
      await type(textarea(), '/remember Use pnpm')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(rememberTarget('project-file').disabled).toBe(true)
      expect(rememberTarget('project-instructions').disabled).toBe(true)
      bodyAll(byTestId(testIds.rememberSave))[0]!.click()
      await flushPromises()
      expect(api.memory.remember).toHaveBeenCalledWith({ body: { target: 'global', text: 'Use pnpm' } })
      wrapper.unmount()
    })
  })

  describe('keyboard chain (Phase 10)', () => {
    it('esc closes the slash menu first, then stops the response; it never stops background agents', async () => {
      const tasks = useBackgroundTasksStore()
      const stopTask = vi.spyOn(tasks, 'stop')
      const stopAll = vi.spyOn(tasks, 'stopAll')
      const { wrapper, composer, textarea } = mountComposer({ status: 'streaming' })
      await type(textarea(), '/mo')
      const close = press(textarea().element, { key: 'Escape' })
      await nextTick()
      expect(close.defaultPrevented).toBe(true)
      expect(wrapper.find(byTestId(testIds.slashMenu)).exists()).toBe(false)
      expect(composer().emitted('stop')).toBeUndefined()

      press(textarea().element, { key: 'Escape' })
      expect(composer().emitted('stop')).toHaveLength(1)
      // Outside inputs too (the registry's composer-stop).
      textarea().element.blur()
      press(document.body, { key: 'Escape' })
      expect(composer().emitted('stop')).toHaveLength(2)
      await flushPromises()
      expect(stopTask).not.toHaveBeenCalled()
      expect(stopAll).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('shift+Tab cycles the mode only while the slash menu is closed', async () => {
      useProjectsStore().items = [projectSummary({ id: projectId(1), name: 'website' })]
      const { wrapper, state, textarea } = mountComposer({ projectId: projectId(1) })
      await type(textarea(), '/re')
      const inMenu = press(textarea().element, { key: 'Tab', shiftKey: true })
      expect(inMenu.defaultPrevented).toBe(false)
      expect(state.toolMode).toBe('ask')
      await type(textarea(), 'plain text')
      const cycle = press(textarea().element, { key: 'Tab', shiftKey: true })
      await flushPromises()
      expect(cycle.defaultPrevented).toBe(true)
      expect(state.toolMode).toBe('edits')
      wrapper.unmount()
    })
  })

  describe('permission mode: Accept edits (Phase 7)', () => {
    async function permissionOptions(wrapper: ReturnType<typeof mountComposer>['wrapper']) {
      await wrapper.get(byTestId(testIds.permissionMenuTrigger)).trigger('keydown', { key: 'Enter' })
      await flushPromises()
      return bodyAll(byTestId(testIds.permissionOption))
    }

    it('offers Accept edits in a project chat and applies the pick', async () => {
      const { wrapper, state } = mountComposer({ projectId: projectId(1) })
      const options = await permissionOptions(wrapper)
      // Plan (Phase 9) is offered like Accept edits.
      expect(options.map(option => option.dataset.value)).toEqual(['ask', 'edits', 'plan', 'auto', 'off'])
      options[1]!.click()
      await flushPromises()
      expect(state.toolMode).toBe('edits')
      expect(wrapper.get(byTestId(testIds.permissionMenuTrigger)).attributes('aria-label')).toBe('Permission mode: Accept edits')
      wrapper.unmount()
    })

    it('outside a project offers it only while it is the current mode', async () => {
      const { wrapper, state } = mountComposer({ toolMode: 'edits' })
      expect(wrapper.get(byTestId(testIds.permissionMenuTrigger)).attributes('data-value')).toBe('edits')
      const options = await permissionOptions(wrapper)
      expect(options.map(option => option.dataset.value)).toEqual(['ask', 'edits', 'auto', 'off'])
      options[0]!.click()
      await flushPromises()
      expect(state.toolMode).toBe('ask')
      press(document.activeElement ?? document.body, { key: 'Escape' })
      await flushPromises()

      const again = await permissionOptions(wrapper)
      expect(again.map(option => option.dataset.value)).toEqual(['ask', 'auto', 'off'])
      wrapper.unmount()
    })

    it('/mode edits and its aliases select Accept edits in a project chat', async () => {
      const { wrapper, state, composer, textarea } = mountComposer({ projectId: projectId(1) })
      for (const command of ['/mode edits', '/mode accept-edits', '/mode accept edits']) {
        state.toolMode = 'ask'
        await type(textarea(), command)
        press(textarea().element, { key: 'Enter' })
        await flushPromises()
        expect(state.toolMode).toBe('edits')
        expect(textarea().element.value).toBe('')
      }
      expect(mock.toastError).not.toHaveBeenCalled()
      expect(composer().emitted('submit')).toBeUndefined()
      wrapper.unmount()
    })

    it('/mode edits outside a project explains why and changes nothing', async () => {
      const { wrapper, state, composer, textarea } = mountComposer()
      await type(textarea(), '/mode accept edits')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(mock.toastError).toHaveBeenCalledWith('Accept edits works in project chats.')
      expect(state.toolMode).toBe('ask')
      expect(textarea().element.value).toBe('/mode accept edits')
      expect(composer().emitted('submit')).toBeUndefined()
      wrapper.unmount()
    })
  })

  describe('menus', () => {
    it('hides the effort menu without effort control and the permission menu without tools', async () => {
      const haikuComposer = mountComposer({ modelRef: haiku.ref })
      expect(haikuComposer.wrapper.find(byTestId(testIds.effortMenuTrigger)).exists()).toBe(false)
      expect(haikuComposer.wrapper.find(byTestId(testIds.permissionMenuTrigger)).exists()).toBe(true)
      haikuComposer.wrapper.unmount()

      const llamaComposer = mountComposer({ modelRef: llama.ref })
      expect(llamaComposer.wrapper.find(byTestId(testIds.permissionMenuTrigger)).exists()).toBe(false)
      llamaComposer.wrapper.unmount()

      seedStores({ tools: [] })
      const noTools = mountComposer({ modelRef: sonnet.ref })
      expect(noTools.wrapper.find(byTestId(testIds.permissionMenuTrigger)).exists()).toBe(false)
      noTools.wrapper.unmount()
    })

    it('alt+M / Alt+R / Alt+P open the menus by event.code, never with Ctrl', async () => {
      const { wrapper, textarea } = mountComposer()
      press(textarea().element, { key: 'µ', code: 'KeyM', altKey: true, ctrlKey: true })
      await flushPromises()
      expect(bodyAll(byTestId(testIds.modelPicker))).toHaveLength(0)

      const altM = press(textarea().element, { key: 'µ', code: 'KeyM', altKey: true })
      await flushPromises()
      expect(altM.defaultPrevented).toBe(true)
      expect(bodyAll(byTestId(testIds.modelPicker))).toHaveLength(1)
      press(document.activeElement ?? document.body, { key: 'Escape' })
      await flushPromises()

      textarea().element.focus()
      press(textarea().element, { key: '®', code: 'KeyR', altKey: true })
      await flushPromises()
      expect(bodyAll(byTestId(testIds.effortOption)).map(option => option.dataset.value)).toEqual(['auto', 'low', 'medium', 'high'])
      press(document.activeElement ?? document.body, { key: 'Escape' })
      await flushPromises()

      textarea().element.focus()
      press(textarea().element, { key: 'π', code: 'KeyP', altKey: true })
      await flushPromises()
      expect(bodyAll(byTestId(testIds.permissionOption)).map(option => option.dataset.value)).toEqual(['ask', 'auto', 'off'])
      wrapper.unmount()
    })

    it('alt+R does nothing for a model without effort control', async () => {
      const { wrapper, textarea } = mountComposer({ modelRef: haiku.ref })
      const altR = press(textarea().element, { key: '®', code: 'KeyR', altKey: true })
      await flushPromises()
      expect(altR.defaultPrevented).toBe(false)
      expect(bodyAll(byTestId(testIds.effortOption))).toHaveLength(0)
      wrapper.unmount()
    })

    it('lists the composer keys in the shortcuts registry while mounted', () => {
      const { wrapper } = mountComposer()
      const ids = shortcuts.list().map(def => def.id)
      expect(ids).toEqual(expect.arrayContaining(['composer-model-picker', 'composer-effort', 'composer-permission', 'composer-stop', 'composer-send']))
      expect(shortcuts.list().find(def => def.id === 'composer-model-picker')?.keys).toBe('alt+code:KeyM')
      wrapper.unmount()
      expect(shortcuts.list().some(def => def.id.startsWith('composer-'))).toBe(false)
    })
  })

  describe('attachments', () => {
    it('uploads pasted files and sends their refs; Send waits for uploads', async () => {
      let finish!: (ref: FileRef) => void
      api.files.upload.mockReturnValueOnce(new Promise<FileRef>((resolve) => {
        finish = resolve
      }))
      const { wrapper, composer, textarea, send } = mountComposer()
      const file = new File(['# notes'], 'notes.md', { type: 'text/markdown' })
      const paste = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(paste, 'clipboardData', { value: { items: [{ kind: 'file', getAsFile: () => file }] } })
      textarea().element.dispatchEvent(paste)
      await flushPromises()
      expect(paste.defaultPrevented).toBe(true)
      const chip = wrapper.get(byTestId(testIds.composerAttachment))
      expect(chip.attributes('data-state')).toBe('uploading')
      expect(chip.attributes('data-kind')).toBe('upload')

      await type(textarea(), 'see attached')
      await send().trigger('click')
      await flushPromises()
      expect(send().attributes('data-state')).toBe('pending')
      expect(composer().emitted('submit')).toBeUndefined()

      finish(fileRef('notes.md', 'text/markdown'))
      await flushPromises()
      expect(composer().emitted('submit')).toEqual([[{ text: 'see attached', files: [fileRef('notes.md', 'text/markdown')] }]])
      expect(wrapper.find(byTestId(testIds.composerAttachment)).exists()).toBe(false)
      wrapper.unmount()
    })

    it('pastes rich text from office apps as text, not as the rendered image', async () => {
      const { wrapper, textarea } = mountComposer()
      const paste = new Event('paste', { bubbles: true, cancelable: true })
      const rendered = new File(['png'], 'image.png', { type: 'image/png' })
      Object.defineProperty(paste, 'clipboardData', {
        value: { types: ['text/plain', 'text/html', 'Files'], items: [{ kind: 'file', getAsFile: () => rendered }] },
      })
      textarea().element.dispatchEvent(paste)
      await flushPromises()
      expect(paste.defaultPrevented).toBe(false)
      expect(api.files.upload).not.toHaveBeenCalled()
      expect(wrapper.find(byTestId(testIds.composerAttachment)).exists()).toBe(false)
      wrapper.unmount()
    })

    it('rejects files the server cannot take with a toast', async () => {
      const { wrapper, textarea } = mountComposer()
      const paste = new Event('paste', { bubbles: true, cancelable: true })
      const movie = new File(['x'], 'movie.mp4', { type: 'video/mp4' })
      Object.defineProperty(paste, 'clipboardData', { value: { items: [{ kind: 'file', getAsFile: () => movie }] } })
      textarea().element.dispatchEvent(paste)
      await flushPromises()
      expect(mock.toastError).toHaveBeenCalledWith('movie.mp4 can\'t be attached', { description: 'Attach images, PDFs or text files.' })
      expect(api.files.upload).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('warns about images for a model without vision and disables Send', async () => {
      api.files.upload.mockResolvedValue(fileRef('shot.png', 'image/png'))
      const { wrapper, state, textarea, send } = mountComposer({ modelRef: haiku.ref })
      const input = wrapper.get<HTMLInputElement>(byTestId(testIds.composerFileInput))
      Object.defineProperty(input.element, 'files', { value: [new File(['png'], 'shot.png', { type: 'image/png' })], configurable: true })
      await input.trigger('change')
      await flushPromises()
      await type(textarea(), 'what is this?')
      expect(wrapper.text()).toContain('Claude Haiku 5 can\'t see images. Remove them or choose another model.')
      expect(send().attributes('aria-disabled')).toBe('true')

      state.modelRef = sonnet.ref
      await nextTick()
      expect(wrapper.text()).not.toContain('can\'t see images')
      expect(send().attributes('aria-disabled')).toBeUndefined()
      wrapper.unmount()
    })

    it('shows the drop overlay while files are dragged and attaches dropped files', async () => {
      api.files.upload.mockResolvedValue(fileRef('drop.txt', 'text/plain'))
      const { wrapper } = mountComposer()
      const file = new File(['dropped'], 'drop.txt', { type: 'text/plain' })
      document.body.dispatchEvent(dragEvent('dragenter', [file]))
      await nextTick()
      expect(bodyAll(byTestId(testIds.composerDropOverlay))).toHaveLength(1)
      expect(document.body.textContent).toContain('Drop files to attach')

      const drop = dragEvent('drop', [file])
      wrapper.get('form').element.dispatchEvent(drop)
      await flushPromises()
      expect(drop.defaultPrevented).toBe(true)
      expect(bodyAll(byTestId(testIds.composerDropOverlay))).toHaveLength(0)
      expect(wrapper.findAll(byTestId(testIds.composerAttachment))).toHaveLength(1)
      expect(api.files.upload).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    })
  })

  describe('send state', () => {
    it('disables Send for an unavailable model', async () => {
      useProvidersStore().items = [{ ...anthropic, enabled: false }, ollama]
      const { wrapper, textarea, send } = mountComposer()
      await type(textarea(), 'hello')
      expect(send().attributes('aria-disabled')).toBe('true')
      expect(wrapper.get(byTestId(testIds.modelPickerTrigger)).attributes('data-available')).toBe('false')
      wrapper.unmount()
    })

    it('keeps Send enabled for a provider without a key (the server explains)', async () => {
      useProvidersStore().items = [{ ...anthropic, status: 'not_configured' }, ollama]
      const { wrapper, textarea, send } = mountComposer()
      await type(textarea(), 'hello')
      expect(send().attributes('aria-disabled')).toBeUndefined()
      wrapper.unmount()
    })

    it('disables Send when the parent says so, and without a model', async () => {
      const disabled = mountComposer({ disabled: true })
      await type(disabled.textarea(), 'hello')
      expect(disabled.send().attributes('aria-disabled')).toBe('true')
      press(disabled.textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(disabled.composer().emitted('submit')).toBeUndefined()
      disabled.wrapper.unmount()

      const noModel = mountComposer({ modelRef: null })
      await type(noModel.textarea(), 'hello')
      expect(noModel.send().attributes('aria-disabled')).toBe('true')
      expect(noModel.wrapper.get(byTestId(testIds.modelPickerTrigger)).text()).toContain('Choose a model')
      noModel.wrapper.unmount()
    })
  })

  it('keeps the unsent text per chat and restores it', async () => {
    const first = mountComposer()
    await type(first.textarea(), 'draft for chat one')
    first.wrapper.unmount()
    expect(sessionStorage.getItem(`hf-composer-draft:${chatId(1)}`)).toBe('draft for chat one')

    const again = mountComposer()
    expect(again.textarea().element.value).toBe('draft for chat one')
    again.state.chatId = chatId(2)
    await nextTick()
    expect(again.textarea().element.value).toBe('')
    again.wrapper.unmount()
  })

  it('shows the context ring once usage is known', async () => {
    const { wrapper, state } = mountComposer({ usage: { inputTokens: 80_000, outputTokens: 4_000, contextTokens: 84_000 }, chatCostUsd: 0.12 })
    const ring = wrapper.get(byTestId(testIds.contextRing))
    expect(ring.attributes('data-value')).toBe('42')
    expect(ring.attributes('aria-label')).toBe('42% of context used')
    state.usage = { contextTokens: 190_000 }
    await nextTick()
    expect(wrapper.get(byTestId(testIds.contextRing)).attributes('data-level')).toBe('danger')
    state.modelRef = 'ollama:unknown-model'
    await nextTick()
    expect(wrapper.find(byTestId(testIds.contextRing)).exists()).toBe(false)
    wrapper.unmount()
  })

  it('exposes focus, setText and openModelPicker', async () => {
    const { wrapper, composer, textarea } = mountComposer()
    const exposed = composer().vm as unknown as ChatComposerExposed
    textarea().element.blur()
    exposed.setText('prefilled')
    await flushPromises()
    expect(textarea().element.value).toBe('prefilled')
    expect(document.activeElement).toBe(textarea().element)
    exposed.openModelPicker()
    await flushPromises()
    expect(bodyAll(byTestId(testIds.modelPicker))).toHaveLength(1)
    wrapper.unmount()
  })

  describe('dictation', () => {
    beforeEach(() => {
      api.audio.transcribe.mockResolvedValue(transcription())
    })

    it('has no mic without MediaRecorder; with one the mic sits right before Send', async () => {
      const bare = mountComposer()
      expect(bare.wrapper.find(byTestId(testIds.composerMic)).exists()).toBe(false)
      bare.wrapper.unmount()

      media = installFakeMedia()
      const { wrapper, mic, send } = mountComposer()
      expect(mic().attributes()).toMatchObject({ 'data-state': 'setup', 'aria-keyshortcuts': 'Alt+V' })
      expect(mic().element.compareDocumentPosition(send().element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      configureDictation()
      await nextTick()
      expect(mic().attributes('data-state')).toBe('idle')
      wrapper.unmount()
    })

    it('records, replaces the left tools, holds Send, then inserts the transcript at the saved caret', async () => {
      media = installFakeMedia()
      configureDictation()
      vi.useFakeTimers({ toFake: ['Date'] })
      const { wrapper, composer, textarea, send, mic, announcer } = mountComposer()
      await type(textarea(), 'Hello ')
      await mic().trigger('click')
      await flushPromises()

      expect(mic().attributes()).toMatchObject({ 'data-state': 'recording', 'aria-pressed': 'true', 'aria-label': 'Stop and transcribe' })
      expect(mock.player.stop).toHaveBeenCalledTimes(1)
      expect(media.getUserMedia).toHaveBeenCalledTimes(1)
      expect(wrapper.get(byTestId(testIds.composerRecordingTime)).text()).toBe('0:00')
      for (const hidden of [testIds.composerAdd, testIds.modelPickerTrigger, testIds.effortMenuTrigger, testIds.permissionMenuTrigger])
        expect(wrapper.find(byTestId(hidden)).exists()).toBe(false)
      expect(send().attributes('aria-disabled')).toBe('true')
      expect(announcer().text()).toBe('Recording started')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(composer().emitted('submit')).toBeUndefined()

      recordFor(1_500)
      await mic().trigger('click')
      await flushPromises()
      expect(api.audio.transcribe).toHaveBeenCalledTimes(1)
      const { form } = api.audio.transcribe.mock.calls[0]![0] as { form: FormData }
      expect((form.get('file') as File).type).toBe('audio/webm;codecs=opus')
      expect(textarea().element.value).toBe(`Hello ${TRANSCRIPT}`)
      expect(textarea().element.selectionStart).toBe(`Hello ${TRANSCRIPT}`.length)
      expect(document.activeElement).toBe(textarea().element)
      expect(mic().attributes('data-state')).toBe('idle')
      expect(wrapper.find(byTestId(testIds.composerRecording)).exists()).toBe(false)
      expect(wrapper.find(byTestId(testIds.composerAdd)).exists()).toBe(true)
      expect(send().attributes('aria-disabled')).toBeUndefined()
      expect(announcer().text()).toBe('Transcript added')
      expect(media.streams[0]!.stopped).toBe(true)
      wrapper.unmount()
    })

    it('inserts into the middle of the text where the caret was when the recording started', async () => {
      media = installFakeMedia()
      configureDictation()
      vi.useFakeTimers({ toFake: ['Date'] })
      const { wrapper, textarea, mic } = mountComposer()
      await type(textarea(), 'Hello world')
      textarea().element.setSelectionRange(5, 5)
      await mic().trigger('click')
      await flushPromises()
      recordFor(900)
      await mic().trigger('click')
      await flushPromises()
      expect(textarea().element.value).toBe(`Hello ${TRANSCRIPT} world`)
      wrapper.unmount()
    })

    it('shows "Transcribing…" with the stopped timer; a click on the mic then cancels the request', async () => {
      media = installFakeMedia()
      configureDictation()
      vi.useFakeTimers({ toFake: ['Date'] })
      const pending = deferred<AudioTranscription>()
      api.audio.transcribe.mockReturnValue(pending.promise)
      const { wrapper, textarea, mic, announcer } = mountComposer()
      await mic().trigger('click')
      await flushPromises()
      recordFor(12_000)
      await mic().trigger('click')
      await flushPromises()
      expect(mic().attributes()).toMatchObject({ 'data-state': 'transcribing', 'aria-label': 'Cancel transcription' })
      expect(mic().text()).toContain('Transcribing…')
      expect(wrapper.get(byTestId(testIds.composerRecording)).attributes('data-state')).toBe('transcribing')
      expect(wrapper.get(byTestId(testIds.composerRecordingTime)).text()).toBe('0:12')
      expect(announcer().text()).toBe('Transcribing…')

      await mic().trigger('click')
      await flushPromises()
      const { signal } = api.audio.transcribe.mock.calls[0]![0] as { signal: AbortSignal }
      expect(signal.aborted).toBe(true)
      expect(mic().attributes('data-state')).toBe('idle')
      expect(announcer().text()).toBe('Recording canceled')
      pending.resolve(transcription())
      await flushPromises()
      expect(textarea().element.value).toBe('')
      wrapper.unmount()
    })

    it('esc cancels a recording before it stops a running response, in the textarea and outside inputs', async () => {
      media = installFakeMedia()
      configureDictation()
      const { wrapper, composer, textarea, mic, announcer } = mountComposer({ status: 'streaming' })
      await mic().trigger('click')
      await flushPromises()
      const escape = press(textarea().element, { key: 'Escape' })
      await flushPromises()
      expect(escape.defaultPrevented).toBe(true)
      expect(mic().attributes('data-state')).toBe('idle')
      expect(composer().emitted('stop')).toBeUndefined()
      expect(announcer().text()).toBe('Recording canceled')
      expect(api.audio.transcribe).not.toHaveBeenCalled()
      expect(media.streams[0]!.stopped).toBe(true)
      press(textarea().element, { key: 'Escape' })
      expect(composer().emitted('stop')).toHaveLength(1)

      await mic().trigger('click')
      await flushPromises()
      textarea().element.blur()
      press(document.body, { key: 'Escape' })
      await flushPromises()
      expect(mic().attributes('data-state')).toBe('idle')
      expect(composer().emitted('stop')).toHaveLength(1)
      press(document.body, { key: 'Escape' })
      expect(composer().emitted('stop')).toHaveLength(2)
      wrapper.unmount()
    })

    it('cancel of the recording indicator drops the clip and gives the textarea the focus', async () => {
      media = installFakeMedia()
      configureDictation()
      const { wrapper, textarea, mic, announcer } = mountComposer()
      await mic().trigger('click')
      await flushPromises()
      textarea().element.blur()
      await wrapper.get(byTestId(testIds.composerMicCancel)).trigger('click')
      await flushPromises()
      expect(mic().attributes('data-state')).toBe('idle')
      expect(api.audio.transcribe).not.toHaveBeenCalled()
      expect(announcer().text()).toBe('Recording canceled')
      expect(document.activeElement).toBe(textarea().element)
      wrapper.unmount()
    })

    it('alt+V starts and stops dictation, and is off with altShortcuts', async () => {
      media = installFakeMedia()
      configureDictation()
      vi.useFakeTimers({ toFake: ['Date'] })
      const { wrapper, textarea, mic } = mountComposer()
      expect(shortcuts.list().find(def => def.id === 'composer-dictate')).toMatchObject({ keys: 'alt+code:KeyV', group: 'Composer' })
      const start = press(textarea().element, { key: '√', code: 'KeyV', altKey: true })
      await flushPromises()
      expect(start.defaultPrevented).toBe(true)
      expect(mic().attributes('data-state')).toBe('recording')
      recordFor(2_000)
      press(textarea().element, { key: '√', code: 'KeyV', altKey: true })
      await flushPromises()
      expect(textarea().element.value).toBe(TRANSCRIPT)

      const settings = useSettingsStore()
      shortcuts.setAltEnabled(() => settings.resolved.altShortcuts)
      settings.settings = { ...settings.settings!, altShortcuts: false }
      const off = press(textarea().element, { key: '√', code: 'KeyV', altKey: true })
      await flushPromises()
      expect(off.defaultPrevented).toBe(false)
      expect(mic().attributes('data-state')).toBe('idle')
      wrapper.unmount()
      expect(shortcuts.list().some(def => def.id === 'composer-dictate' || def.id === 'composer-dictation-cancel')).toBe(false)
    })

    it('without a speech-to-text model the mic (or Alt+V) opens the setup popover to Settings -> Media', async () => {
      media = installFakeMedia()
      const { wrapper, textarea, mic } = mountComposer()
      await mic().trigger('click')
      await flushPromises()
      expect(bodyAll(byTestId(testIds.composerMicSetup))).toHaveLength(1)
      expect(bodyAll(byTestId(testIds.composerMicSetupLink))[0]!.getAttribute('href')).toBe('/settings/media')
      expect(media.getUserMedia).not.toHaveBeenCalled()
      await mic().trigger('click')
      await flushPromises()
      expect(bodyAll(byTestId(testIds.composerMicSetup))).toHaveLength(0)

      textarea().element.focus()
      press(textarea().element, { key: '√', code: 'KeyV', altKey: true })
      await flushPromises()
      expect(bodyAll(byTestId(testIds.composerMicSetup))).toHaveLength(1)
      wrapper.unmount()
    })

    it('on an insecure origin the mic is disabled and Alt+V is left to the browser', async () => {
      media = installFakeMedia({ secure: false })
      configureDictation()
      const { wrapper, textarea, mic } = mountComposer()
      expect(mic().attributes()).toMatchObject({ 'data-state': 'insecure', 'aria-disabled': 'true' })
      await mic().trigger('click')
      const altV = press(textarea().element, { key: '√', code: 'KeyV', altKey: true })
      await flushPromises()
      expect(altV.defaultPrevented).toBe(false)
      expect(mic().attributes('data-state')).toBe('insecure')
      wrapper.unmount()
    })

    it('says "No speech detected" for an empty transcript and keeps the text', async () => {
      media = installFakeMedia()
      configureDictation()
      vi.useFakeTimers({ toFake: ['Date'] })
      api.audio.transcribe.mockResolvedValue(transcription(''))
      const { wrapper, textarea, mic } = mountComposer()
      await type(textarea(), 'Keep me')
      await mic().trigger('click')
      await flushPromises()
      recordFor(1_000)
      await mic().trigger('click')
      await flushPromises()
      expect(mock.toast).toHaveBeenCalledWith('No speech detected')
      expect(textarea().element.value).toBe('Keep me')
      wrapper.unmount()
    })

    it('shows microphone and provider errors as toasts', async () => {
      media = installFakeMedia({ deny: true })
      configureDictation()
      const denied = mountComposer()
      await denied.mic().trigger('click')
      await flushPromises()
      expect(mock.toastError).toHaveBeenCalledWith('Microphone access is blocked. Allow it in the browser\'s site settings.')
      expect(denied.mic().attributes('data-state')).toBe('idle')
      denied.wrapper.unmount()
      media()

      media = installFakeMedia()
      vi.useFakeTimers({ toFake: ['Date'] })
      api.audio.transcribe.mockRejectedValue(new HarnessError({ code: 'provider_not_configured', message: 'Add an API key in Settings.', providerId: 'anthropic' }))
      const failing = mountComposer()
      await failing.mic().trigger('click')
      await flushPromises()
      recordFor(1_000)
      await failing.mic().trigger('click')
      await flushPromises()
      expect(mock.toastError).toHaveBeenLastCalledWith('No API key for Anthropic (Claude)', { description: 'Add an API key in Settings.' })
      expect(failing.announcer().text()).not.toBe('Recording canceled')
      failing.wrapper.unmount()
    })

    it('a chat switch cancels a running dictation', async () => {
      media = installFakeMedia()
      configureDictation()
      const { wrapper, state, mic } = mountComposer()
      await mic().trigger('click')
      await flushPromises()
      state.chatId = chatId(2)
      await flushPromises()
      expect(mic().attributes('data-state')).toBe('idle')
      expect(media.streams[0]!.stopped).toBe(true)
      wrapper.unmount()
    })
  })

  describe('image models', () => {
    beforeEach(() => {
      seedStores({ providers: [anthropic, ollama, { ...openai, status: 'connected', modelCount: 2 }], models: [sonnet, haiku, llama, gptImage] })
    })

    it('shows "Describe an image…", the image options and no context ring; the prompt is required', async () => {
      const usage = { inputTokens: 80_000, outputTokens: 4_000, contextTokens: 84_000 }
      const { wrapper, state, textarea, send } = mountComposer({ modelRef: gptImage.ref, usage })
      expect(textarea().attributes('placeholder')).toBe('Describe an image…')
      expect(wrapper.find(byTestId(testIds.imageOptionsTrigger)).exists()).toBe(true)
      expect(wrapper.find(byTestId(testIds.effortMenuTrigger)).exists()).toBe(false)
      expect(wrapper.find(byTestId(testIds.permissionMenuTrigger)).exists()).toBe(false)
      expect(wrapper.find(byTestId(testIds.contextRing)).exists()).toBe(false)
      expect(send().attributes('aria-disabled')).toBe('true')
      await type(textarea(), '   ')
      expect(send().attributes('aria-disabled')).toBe('true')
      await type(textarea(), 'a red fox')
      expect(send().attributes('aria-disabled')).toBeUndefined()
      await type(textarea(), 'x'.repeat(32_001))
      expect(send().attributes('aria-disabled')).toBe('true')

      state.modelRef = sonnet.ref
      await nextTick()
      expect(textarea().attributes('placeholder')).toBe('Reply…')
      expect(wrapper.find(byTestId(testIds.imageOptionsTrigger)).exists()).toBe(false)
      expect(wrapper.find(byTestId(testIds.contextRing)).exists()).toBe(true)
      wrapper.unmount()
    })

    it('stores the picked options for the next request and offers "Edit the previous image" after images', async () => {
      const { wrapper, state } = mountComposer({ modelRef: gptImage.ref })
      await wrapper.get(byTestId(testIds.imageOptionsTrigger)).trigger('keydown', { key: 'Enter' })
      await flushPromises()
      expect(bodyAll(byTestId(testIds.imageEditPrevious))).toHaveLength(0)
      bodyAll(byTestId(testIds.imageAspectOption, '[data-value="16:9"]'))[0]!.click()
      await flushPromises()
      expect(useImageOptions().options.value).toEqual({ aspectRatio: '16:9' })
      expect(useImageOptions().forModel(gptImage)).toEqual({ aspectRatio: '16:9' })
      expect(JSON.parse(localStorage.getItem(IMAGE_OPTIONS_KEY) ?? 'null')).toEqual({ aspectRatio: '16:9' })
      expect(wrapper.get(byTestId(testIds.imageOptionsTrigger)).text()).toContain('16:9')

      state.previousImages = 2
      await nextTick()
      await wrapper.get(byTestId(testIds.imageOptionsTrigger)).trigger('keydown', { key: 'Enter' })
      await flushPromises()
      bodyAll(byTestId(testIds.imageEditPrevious))[0]!.click()
      await flushPromises()
      expect(useImageOptions().options.value).toEqual({ aspectRatio: '16:9', editPrevious: false })
      wrapper.unmount()
    })
  })

  it('focuses itself on ui.requestComposerFocus()', async () => {
    const { wrapper, textarea } = mountComposer()
    textarea().element.blur()
    useUiStore().requestComposerFocus()
    await nextTick()
    expect(document.activeElement).toBe(textarea().element)
    wrapper.unmount()
  })

  describe('file mentions (Phase 9)', () => {
    const dir = (path: string) => projectFileEntry(path, 'dir')
    const file = (path: string) => projectFileEntry(path)

    function answer(items: ProjectFileEntry[], truncated = false): ProjectFileSearch {
      return { items, truncated, indexedAt: 1_759_000_000_000 }
    }

    function mountProjectChat(overrides: Partial<HarnessState> = {}) {
      useProjectsStore().items = [projectSummary({ id: projectId(1), name: 'harness-forge' })]
      return mountComposer({ projectId: projectId(1), ...overrides })
    }

    /** The 80 ms debounce runs out and the (mocked) search answers. */
    async function searchSettles() {
      vi.advanceTimersByTime(MENTION_SEARCH_DEBOUNCE_MS)
      await flushPromises()
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    })

    it('@pars + Enter inserts the best match and attaches it as a project chip; Send waits for it', async () => {
      api.projectFiles.search.mockResolvedValue(answer([file('src/parser.ts'), file('src/parser.test.ts')]))
      let finish!: (ref: FileRef) => void
      api.projectFiles.attach.mockReturnValueOnce(new Promise<FileRef>((resolve) => {
        finish = resolve
      }))
      const { wrapper, composer, textarea } = mountProjectChat()
      const menu = () => wrapper.find(byTestId(testIds.mentionMenu))

      await type(textarea(), 'Fix @pars')
      expect(menu().attributes('data-state')).toBe('loading')
      expect(textarea().attributes('aria-controls')).toBe(menu().attributes('id'))
      await searchSettles()
      expect(api.projectFiles.search).toHaveBeenCalledTimes(1)
      expect(api.projectFiles.search.mock.calls[0]![0]).toMatchObject({ params: { id: projectId(1) }, query: { q: 'pars', limit: 50 } })
      expect(menu().attributes()).toMatchObject({ 'data-state': 'ready', 'data-count': '2', 'aria-label': 'Files in harness-forge' })
      const rows = wrapper.findAll(byTestId(testIds.mentionMenuItem))
      expect(textarea().attributes('aria-activedescendant')).toBe(rows[0]!.attributes('id'))

      const enter = press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(enter.defaultPrevented).toBe(true)
      expect(composer().emitted('submit')).toBeUndefined()
      expect(textarea().element.value).toBe('Fix @src/parser.ts ')
      expect(textarea().element.selectionStart).toBe(19)
      expect(menu().exists()).toBe(false)
      expect(textarea().attributes('aria-controls')).toBeUndefined()
      const chip = wrapper.get(byTestId(testIds.composerAttachment))
      expect(chip.attributes()).toMatchObject({ 'data-kind': 'project', 'data-path': 'src/parser.ts', 'data-state': 'uploading' })
      expect(chip.text()).toContain('parser.ts')
      expect(api.projectFiles.attach).toHaveBeenCalledWith(expect.objectContaining({ params: { id: projectId(1) }, body: { path: 'src/parser.ts' } }))

      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(composer().emitted('submit')).toBeUndefined()
      finish(fileRef('parser.ts', 'text/plain'))
      await flushPromises()
      expect(composer().emitted('submit')).toEqual([[{ text: 'Fix @src/parser.ts', files: [fileRef('parser.ts', 'text/plain')] }]])
      wrapper.unmount()
    })

    it('a folder inserts @folder/ and keeps the menu open on it', async () => {
      api.projectFiles.search.mockImplementation(async (input: { query: { q: string } }) => (input.query.q === 'pars'
        ? answer([dir('src/parsers'), file('src/parser.ts')])
        : answer([file('src/parsers/json.ts'), file('src/parsers/yaml.ts')])))
      api.projectFiles.attach.mockResolvedValue(fileRef('yaml.ts', 'text/plain'))
      const { wrapper, textarea } = mountProjectChat()
      await type(textarea(), '@pars')
      await searchSettles()
      expect(wrapper.findAll(byTestId(testIds.mentionMenuItem)).map(row => row.attributes('data-kind'))).toEqual(['dir', 'file'])

      press(textarea().element, { key: 'Tab' })
      await flushPromises()
      expect(textarea().element.value).toBe('@src/parsers/')
      expect(api.projectFiles.attach).not.toHaveBeenCalled()
      expect(wrapper.find(byTestId(testIds.mentionMenu)).exists()).toBe(true)
      await searchSettles()
      expect(api.projectFiles.search).toHaveBeenLastCalledWith(expect.objectContaining({ query: { q: 'src/parsers/', limit: 50 } }))
      expect(wrapper.findAll(byTestId(testIds.mentionMenuItem)).map(row => row.attributes('data-path'))).toEqual(['src/parsers/json.ts', 'src/parsers/yaml.ts'])

      press(textarea().element, { key: 'ArrowDown' })
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(textarea().element.value).toBe('@src/parsers/yaml.ts ')
      expect(wrapper.get(byTestId(testIds.composerAttachment)).attributes('data-path')).toBe('src/parsers/yaml.ts')
      wrapper.unmount()
    })

    it('never opens for a@b or in a chat without a project', async () => {
      const project = mountProjectChat()
      await type(project.textarea(), 'mail a@b')
      await searchSettles()
      expect(project.wrapper.find(byTestId(testIds.mentionMenu)).exists()).toBe(false)
      expect(api.projectFiles.search).not.toHaveBeenCalled()
      project.wrapper.unmount()

      const plain = mountComposer()
      await type(plain.textarea(), 'Fix @pars')
      await searchSettles()
      expect(plain.wrapper.find(byTestId(testIds.mentionMenu)).exists()).toBe(false)
      expect(api.projectFiles.search).not.toHaveBeenCalled()
      press(plain.textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(plain.composer().emitted('submit')).toEqual([[{ text: 'Fix @pars', files: [] }]])
      plain.wrapper.unmount()
    })

    it('esc closes the mention menu before it stops a response; the menu returns when the token changes', async () => {
      api.projectFiles.search.mockResolvedValue(answer([file('src/parser.ts')]))
      const { wrapper, composer, textarea } = mountProjectChat({ status: 'streaming' })
      await type(textarea(), '@pa')
      await searchSettles()
      const escape = press(textarea().element, { key: 'Escape' })
      await flushPromises()
      expect(escape.defaultPrevented).toBe(true)
      expect(wrapper.find(byTestId(testIds.mentionMenu)).exists()).toBe(false)
      expect(composer().emitted('stop')).toBeUndefined()

      await type(textarea(), '@par')
      expect(wrapper.find(byTestId(testIds.mentionMenu)).exists()).toBe(true)
      press(textarea().element, { key: 'Escape' })
      await flushPromises()
      press(textarea().element, { key: 'Escape' })
      expect(composer().emitted('stop')).toHaveLength(1)
      wrapper.unmount()
    })

    it('shows search errors in the menu', async () => {
      api.projectFiles.search.mockRejectedValueOnce(new HarnessError({ code: 'validation_error', message: 'The folder /srv/x is missing.' }))
        .mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Could not reach the server.' }))
      const { wrapper, textarea } = mountProjectChat()
      await type(textarea(), '@pa')
      await searchSettles()
      const menu = wrapper.get(byTestId(testIds.mentionMenu))
      expect(menu.attributes('data-state')).toBe('error')
      expect(menu.text()).toContain('The project folder is unavailable.')
      await type(textarea(), '@par')
      await searchSettles()
      expect(wrapper.get(byTestId(testIds.mentionMenu)).text()).toContain('Couldn\'t search files.')
      wrapper.unmount()
    })

    it('reports a file that cannot be attached with a toast and keeps the text', async () => {
      api.projectFiles.search.mockImplementation(async (input: { query: { q: string } }) => answer([file(`${input.query.q}.log`)]))
      api.projectFiles.attach
        .mockRejectedValueOnce(new HarnessError({ code: 'payload_too_large', message: 'Files are limited to 5 MB.', details: { limitBytes: 5_242_880 } }))
        .mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'File gone.log not found.' }))
        .mockRejectedValueOnce(new HarnessError({ code: 'validation_error', message: 'The file type is not supported.', details: { issues: [{ path: ['file'], message: 'The file type is not supported.', code: 'custom' }] } }))
        .mockRejectedValueOnce(new HarnessError({ code: 'validation_error', message: 'path: Secret-looking paths cannot be attached.', details: { issues: [{ path: ['path'], message: 'Secret-looking paths cannot be attached.', code: 'custom' }] } }))
      const { wrapper, textarea } = mountProjectChat()
      for (const name of ['big', 'gone', 'blob', 'secret']) {
        await type(textarea(), `@${name}`)
        await searchSettles()
        press(textarea().element, { key: 'Enter' })
        await flushPromises()
        expect(textarea().element.value).toBe(`@${name}.log `)
      }
      expect(mock.toastError.mock.calls).toEqual([
        ['big.log can\'t be attached', { description: 'Files can be up to 5 MB.' }],
        ['gone.log can\'t be attached', { description: 'The file no longer exists.' }],
        ['blob.log can\'t be attached', { description: 'Attach images, PDFs or text files.' }],
        ['secret.log can\'t be attached', { description: 'path: Secret-looking paths cannot be attached.' }],
      ])
      expect(wrapper.find(byTestId(testIds.composerAttachment)).exists()).toBe(false)
      wrapper.unmount()
    })

    it('the chip and the text are independent', async () => {
      api.projectFiles.search.mockResolvedValue(answer([file('src/parser.ts')]))
      api.projectFiles.attach.mockResolvedValue(fileRef('parser.ts', 'text/plain'))
      const { wrapper, textarea } = mountProjectChat()
      await type(textarea(), '@pars')
      await searchSettles()
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      const chip = wrapper.get(byTestId(testIds.composerAttachment))
      expect(chip.attributes('data-state')).toBe('done')
      await chip.get('button[aria-label="Remove parser.ts"]').trigger('click')
      expect(wrapper.find(byTestId(testIds.composerAttachment)).exists()).toBe(false)
      expect(textarea().element.value).toBe('@src/parser.ts ')

      // Picking the same file again attaches it again; clearing the text keeps the chip.
      await type(textarea(), '@src/parser.ts @pars')
      await searchSettles()
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(wrapper.findAll(byTestId(testIds.composerAttachment))).toHaveLength(1)
      await type(textarea(), '')
      expect(wrapper.findAll(byTestId(testIds.composerAttachment))).toHaveLength(1)
      wrapper.unmount()
    })
  })

  describe('agent 2.0: queue, + menu and Shift+Tab (Phase 9)', () => {
    async function openAddMenu(wrapper: ReturnType<typeof mountComposer>['wrapper']) {
      await wrapper.get(byTestId(testIds.composerAdd)).trigger('keydown', { key: 'Enter' })
      await flushPromises()
    }

    it('"Mention a file" in the + menu inserts @ at the caret and opens the menu (project chats only)', async () => {
      useProjectsStore().items = [projectSummary({ id: projectId(1), name: 'harness-forge' })]
      const { wrapper, textarea } = mountComposer({ projectId: projectId(1) })
      expect(wrapper.getComponent(ComposerAddMenu).props('projectChat')).toBe(true)
      await type(textarea(), 'Look at')
      await openAddMenu(wrapper)
      const item = bodyAll(byTestId(testIds.composerMention))
      expect(item).toHaveLength(1)
      expect(item[0]!.textContent).toContain('Mention a file')
      item[0]!.click()
      await flushPromises()
      expect(textarea().element.value).toBe('Look at @')
      expect(textarea().element.selectionStart).toBe(9)
      expect(wrapper.find(byTestId(testIds.mentionMenu)).exists()).toBe(true)
      wrapper.unmount()

      const other = mountComposer()
      expect(other.wrapper.getComponent(ComposerAddMenu).props('projectChat')).toBe(false)
      await openAddMenu(other.wrapper)
      expect(bodyAll(byTestId(testIds.composerMention))).toHaveLength(0)
      expect(bodyAll('[role="menuitem"]').map(entry => entry.textContent?.trim())).toEqual(['Attach files', 'Commands'])
      other.wrapper.unmount()
    })

    it('shows "Queue message" left of Stop while a run is active and the composer has content', async () => {
      const { wrapper, state, composer, textarea } = mountComposer({ status: 'streaming' })
      const button = () => wrapper.getComponent(SendStopButton)
      const queue = () => wrapper.find(byTestId(testIds.composerQueue))
      expect(button().props('canQueue')).toBe(false)
      expect(queue().exists()).toBe(false)
      await type(textarea(), 'Also update the README')
      expect(button().props('canQueue')).toBe(true)
      expect(queue().text()).toBe('Queue message')
      const stop = wrapper.get(byTestId(testIds.composerStop))
      expect(queue().element.compareDocumentPosition(stop.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

      await queue().trigger('click')
      await flushPromises()
      expect(composer().emitted('submit')).toEqual([[{ text: 'Also update the README', files: [] }]])
      expect(textarea().element.value).toBe('')
      expect(queue().exists()).toBe(false)
      expect(wrapper.find(byTestId(testIds.composerStop)).exists()).toBe(true)

      await type(textarea(), 'More')
      state.status = 'ready'
      await nextTick()
      expect(button().props('canQueue')).toBe(false)
      expect(queue().exists()).toBe(false)
      expect(textarea().attributes('placeholder')).toBe('Reply…')
      wrapper.unmount()
    })

    it('queueing still waits for uploads in flight', async () => {
      let finish!: (ref: FileRef) => void
      api.files.upload.mockReturnValueOnce(new Promise<FileRef>((resolve) => {
        finish = resolve
      }))
      const { wrapper, composer, textarea } = mountComposer({ status: 'streaming' })
      const paste = new Event('paste', { bubbles: true, cancelable: true })
      const notes = new File(['# notes'], 'notes.md', { type: 'text/markdown' })
      Object.defineProperty(paste, 'clipboardData', { value: { items: [{ kind: 'file', getAsFile: () => notes }] } })
      textarea().element.dispatchEvent(paste)
      await type(textarea(), 'with notes')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(composer().emitted('submit')).toBeUndefined()
      expect(wrapper.get(byTestId(testIds.composerQueue)).attributes('aria-busy')).toBe('true')
      finish(fileRef('notes.md', 'text/markdown'))
      await flushPromises()
      expect(composer().emitted('submit')).toEqual([[{ text: 'with notes', files: [fileRef('notes.md', 'text/markdown')] }]])
      wrapper.unmount()
    })

    it('restoreQueued appends the texts with blank lines and restores the files as chips', async () => {
      const shot = fileRef('shot.png', 'image/png')
      const withFile = queueItem({
        id: messageId('queued2'),
        message: {
          id: messageId('queued2'),
          role: 'user',
          parts: [{ type: 'text', text: 'See the screenshot' }, { type: 'file', mediaType: 'image/png', filename: 'shot.png', url: shot.url }],
        },
      })
      const { wrapper, state, composer, textarea } = mountComposer({ status: 'streaming' })
      await type(textarea(), 'My draft')
      textarea().element.blur()
      const exposed = composer().vm as unknown as ChatComposerExposed
      exposed.restoreQueued([queueItem(), withFile])
      await flushPromises()
      const value = 'My draft\n\nAlso update the README\n\nSee the screenshot'
      expect(textarea().element.value).toBe(value)
      expect(textarea().element.selectionStart).toBe(value.length)
      expect(document.activeElement).toBe(textarea().element)
      const chip = wrapper.get(byTestId(testIds.composerAttachment))
      expect(chip.attributes()).toMatchObject({ 'data-kind': 'upload', 'data-state': 'done', 'data-mime': 'image/png' })
      expect(mock.toast).toHaveBeenCalledWith('Queued messages moved back to the composer.')

      exposed.restoreQueued([])
      await flushPromises()
      expect(mock.toast).toHaveBeenCalledTimes(1)
      expect(textarea().element.value).toBe(value)

      state.status = 'ready'
      await nextTick()
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(composer().emitted('submit')).toEqual([[{ text: value, files: [{ ...shot, size: 0 }] }]])
      wrapper.unmount()
    })

    it('leaves Shift+Tab to the browser while a menu is open or the setting is off', async () => {
      useProjectsStore().items = [projectSummary({ id: projectId(1), name: 'harness-forge' })]
      const { wrapper, state, textarea } = mountComposer({ projectId: projectId(1) })
      await type(textarea(), '@pa')
      expect(wrapper.find(byTestId(testIds.mentionMenu)).exists()).toBe(true)
      const inMention = press(textarea().element, { key: 'Tab', shiftKey: true })
      expect(inMention.defaultPrevented).toBe(false)
      await type(textarea(), '/mo')
      const inSlash = press(textarea().element, { key: 'Tab', shiftKey: true })
      expect(inSlash.defaultPrevented).toBe(false)

      await type(textarea(), '')
      const settings = useSettingsStore()
      settings.settings = { ...settings.settings!, shiftTabModes: false }
      const off = press(textarea().element, { key: 'Tab', shiftKey: true })
      expect(off.defaultPrevented).toBe(false)
      await flushPromises()
      expect(state.toolMode).toBe('ask')
      wrapper.unmount()
    })
  })

  describe('output style and refusal (Phase 11)', () => {
    it('mounts OutputStyleMenu right after EffortMenu with the chat\'s style; hidden for image models', async () => {
      seedStores()
      const { wrapper } = mountComposer()
      const trigger = wrapper.get(byTestId(testIds.outputStyleTrigger))
      expect(trigger.attributes()).toMatchObject({ 'data-value': 'default', 'data-source': 'automatic' })
      const order = [...wrapper.element.querySelectorAll('[data-testid]')].map(node => node.getAttribute('data-testid'))
      expect(order.indexOf(testIds.effortMenuTrigger)).toBeLessThan(order.indexOf(testIds.outputStyleTrigger))
      wrapper.unmount()

      seedStores({ models: [sonnet, gptImage] })
      const image = mountComposer({ modelRef: gptImage.ref })
      expect(image.wrapper.find(byTestId(testIds.outputStyleTrigger)).exists()).toBe(false)
      image.wrapper.unmount()
    })

    it('passes the outputStyle prop to the menu and re-emits its choice as update:outputStyle', async () => {
      seedStores()
      const wrapper = mount({
        render: () => h(TooltipProvider, null, {
          default: () => h(ChatComposer, { chatId: chatId(1), status: 'ready', modelRef: sonnet.ref, reasoningEffort: 'auto', toolMode: 'ask', outputStyle: 'learning' }),
        }),
      }, { attachTo: document.body, global: { plugins: [pinia], stubs: { NuxtLink: NuxtLinkStub } } })
      expect(wrapper.get(byTestId(testIds.outputStyleTrigger)).attributes()).toMatchObject({ 'data-value': 'learning', 'data-source': 'chat' })
      wrapper.findComponent({ name: 'OutputStyleMenu' }).vm.$emit('update:modelValue', null)
      expect(wrapper.findComponent(ChatComposer).emitted('update:outputStyle')).toEqual([[null]])
      wrapper.unmount()
    })

    it('exposes showRefusal and restoreInput: the refusal shows above the text until the next send or its ×', async () => {
      seedStores()
      const actions = { openModelPicker: vi.fn(), openProjectTrust: vi.fn(), openProjectMcp: vi.fn() }
      const wrapper = mount({
        render: () => h(TooltipProvider, null, {
          default: () => h(ChatComposer, { chatId: chatId(1), status: 'ready', modelRef: sonnet.ref, reasoningEffort: 'auto', toolMode: 'ask' }),
        }),
      }, { attachTo: document.body, global: { plugins: [pinia], stubs: { NuxtLink: NuxtLinkStub }, provide: { [CHAT_VIEW_ACTIONS as symbol]: actions } } })
      const composer = wrapper.findComponent(ChatComposer)
      const exposed = composer.vm as unknown as ChatComposerExposed
      const shot = fileRef('shot.png', 'image/png')
      exposed.restoreInput({ text: 'Here is my key', files: [shot] })
      exposed.showRefusal({ code: 'untrusted', reason: 'Approve it first.', event: null, source: null, command: 'deploy' })
      await flushPromises()
      expect(wrapper.get<HTMLTextAreaElement>(byTestId(testIds.composerInput)).element.value).toBe('Here is my key')
      expect(wrapper.get(byTestId(testIds.composerAttachment)).attributes('data-state')).toBe('done')
      const refusal = wrapper.get(byTestId(testIds.composerRefusal))
      expect(refusal.attributes('data-code')).toBe('untrusted')
      await wrapper.get(byTestId(testIds.composerRefusalReview)).trigger('click')
      expect(actions.openProjectTrust).toHaveBeenCalledTimes(1)
      await wrapper.get(byTestId(testIds.composerRefusalDismiss)).trigger('click')
      expect(wrapper.find(byTestId(testIds.composerRefusal)).exists()).toBe(false)

      exposed.showRefusal({ code: 'hook-blocked', reason: 'No keys.', event: 'UserPromptSubmit', source: 'personal', command: null })
      await flushPromises()
      expect(wrapper.find(byTestId(testIds.composerRefusal)).exists()).toBe(true)
      press(wrapper.get(byTestId(testIds.composerInput)).element, { key: 'Enter' })
      await flushPromises()
      expect(composer.emitted('submit')).toHaveLength(1)
      expect(wrapper.find(byTestId(testIds.composerRefusal)).exists()).toBe(false)
      wrapper.unmount()
    })

    /** Project 1 ("website") with the style terse in its catalog; `outputStyle` = the project's own style. */
    function seedStyles(outputStyle: string | null = null) {
      useProjectsStore().items = [projectSummary({ id: projectId(1), name: 'website', outputStyle })]
      api.customizations.list.mockResolvedValue(customizationList({ items: [styleEntry(), styleEntry({ name: 'pirate', label: 'Pirate', source: 'plugin', pluginId: 'fun-pack', path: undefined })] }))
      usePluginsStore().items = [pluginSummary({ id: 'fun-pack', name: 'Fun pack' })]
    }

    function styleRow(value: string): HTMLElement {
      return bodyAll(byTestId(testIds.outputStyleOption, `[data-value="${value}"]`))[0]!
    }

    it('fetches the catalog of the chat\'s scope and resolves Automatic to the project\'s style', async () => {
      seedStyles('terse')
      const { wrapper } = mountComposer({ projectId: projectId(1) })
      await flushPromises()
      expect(api.customizations.list).toHaveBeenCalledWith({ query: { projectId: projectId(1) } })
      const trigger = wrapper.get(byTestId(testIds.outputStyleTrigger))
      expect(trigger.attributes()).toMatchObject({ 'data-value': 'terse', 'data-source': 'automatic', 'aria-label': 'Output style: Terse (automatic)' })

      await trigger.trigger('keydown', { key: 'Enter' })
      await flushPromises()
      expect(bodyAll(byTestId(testIds.outputStyleOption)).map(option => option.dataset.value)).toEqual(['', 'default', 'explanatory', 'learning', 'terse', 'pirate'])
      expect(styleRow('').textContent).toContain('Uses Terse, set for website')
      expect(styleRow('pirate').textContent).toContain('Fun pack')
      wrapper.unmount()
    })

    it('reads the global default without a project style, and refetches the catalog on a project change', async () => {
      seedStyles(null)
      useSettingsStore().settings = { ...useSettingsStore().settings!, outputStyle: 'learning' }
      const { wrapper, state } = mountComposer({ projectId: projectId(1) })
      await flushPromises()
      expect(wrapper.get(byTestId(testIds.outputStyleTrigger)).attributes('data-value')).toBe('learning')
      expect(api.customizations.list).toHaveBeenCalledTimes(1)
      state.projectId = null
      await flushPromises()
      expect(api.customizations.list).toHaveBeenCalledTimes(2)
      expect(api.customizations.list).toHaveBeenLastCalledWith({ query: {} })
      wrapper.unmount()
    })

    it('a pick in the menu sets the chat\'s style, is announced and gives focus back to the textarea', async () => {
      seedStyles()
      const { wrapper, state, textarea, announcer } = mountComposer({ projectId: projectId(1) })
      await flushPromises()
      await wrapper.get(byTestId(testIds.outputStyleTrigger)).trigger('keydown', { key: 'Enter' })
      await flushPromises()
      styleRow('terse').click()
      await flushPromises()
      expect(state.outputStyle).toBe('terse')
      expect(announcer().text()).toBe('Output style: Terse')
      expect(document.activeElement).toBe(textarea().element)
      const trigger = wrapper.get(byTestId(testIds.outputStyleTrigger))
      expect(trigger.attributes()).toMatchObject({ 'data-value': 'terse', 'data-source': 'chat' })
      expect(trigger.get('[data-slot="output-style-label"]').text()).toBe('Terse')
      wrapper.unmount()
    })

    it('/output-style opens the menu; with a name or auto it sets the style and clears the input', async () => {
      seedStyles()
      const { wrapper, state, composer, textarea, announcer } = mountComposer({ projectId: projectId(1) })
      await flushPromises()
      await type(textarea(), '/output-style')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(textarea().element.value).toBe('')
      expect(bodyAll(byTestId(testIds.outputStyleOption)).length).toBeGreaterThan(0)
      press(document.activeElement!, { key: 'Escape' })
      await flushPromises()

      await type(textarea(), '/output-style Terse')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(state.outputStyle).toBe('terse')
      expect(textarea().element.value).toBe('')
      expect(announcer().text()).toBe('Output style: Terse')

      await type(textarea(), '/output-style auto')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(state.outputStyle).toBeNull()
      expect(announcer().text()).toBe('Output style: Default (automatic)')
      expect(composer().emitted('update:outputStyle')).toEqual([['terse'], [null]])
      expect(composer().emitted('submit')).toBeUndefined()
      wrapper.unmount()
    })

    it('/output-style explains an unknown name and keeps the text', async () => {
      const { wrapper, composer, textarea } = mountComposer()
      await type(textarea(), '/output-style pirate')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(mock.toastError).toHaveBeenCalledWith('Unknown output style "pirate". Use auto, default, explanatory, learning or a style from the menu.')
      expect(textarea().element.value).toBe('/output-style pirate')
      expect(composer().emitted('update:outputStyle')).toBeUndefined()
      wrapper.unmount()
    })

    it('/output-style opens no menu for an image model, but a name still sets the style', async () => {
      seedStores({ models: [sonnet, gptImage] })
      const { wrapper, state, textarea } = mountComposer({ modelRef: gptImage.ref })
      await type(textarea(), '/output-style')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(bodyAll(byTestId(testIds.outputStyleOption))).toHaveLength(0)
      // A later text model does not find the menu open.
      state.modelRef = sonnet.ref
      await flushPromises()
      expect(bodyAll(byTestId(testIds.outputStyleOption))).toHaveLength(0)
      await type(textarea(), '/output-style learning')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(state.outputStyle).toBe('learning')
      wrapper.unmount()
    })

    it('lists user-invocable skills in the Skills group, last, and inserts them like commands', async () => {
      api.commands.list.mockResolvedValue({
        items: [
          { name: 'review', description: 'Review a file', source: 'project' },
          { name: 'release-notes', kind: 'skill', description: 'Write release notes', source: 'user', argumentHint: '<version>' },
        ],
      })
      api.projectTrust.list.mockResolvedValue(projectTrustList({ items: [] }))
      const { wrapper, composer, textarea } = mountComposer({ projectId: projectId(1) })
      await flushPromises()
      await type(textarea(), '/re')
      const rows = wrapper.findAll(byTestId(testIds.slashMenuItem)).map(item => `${item.attributes('data-group')}:${item.attributes('data-value')}`)
      expect(rows).toEqual(['app:remember', 'project:review', 'skill:release-notes'])
      await type(textarea(), '/rel')
      press(textarea().element, { key: 'Tab' })
      await flushPromises()
      expect(textarea().element.value).toBe('/release-notes ')
      expect(wrapper.get(byTestId(testIds.slashArgumentHint)).text()).toContain('<version>')
      await type(textarea(), '/release-notes 1.7')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(composer().emitted('submit')).toEqual([[{ text: '/release-notes 1.7', files: [] }]])
      wrapper.unmount()
    })

    it('marks project commands with pending shell lines "Needs approval" once the trust list loaded', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      api.commands.list.mockResolvedValue({ items: [{ name: 'deploy', description: 'Deploy the app', source: 'project' }, { name: 'status', description: 'Git status', source: 'project' }] })
      api.projectTrust.list.mockResolvedValue(projectTrustList({
        items: [trustCommandItem({ state: 'pending', label: '/deploy', detail: { name: 'deploy', spans: ['./deploy.sh'] } }), trustCommandItem()],
      }))
      const { wrapper, composer, textarea } = mountComposer({ projectId: projectId(1) })
      await flushPromises()
      // Lazily: nothing until the slash menu opens.
      expect(api.projectTrust.list).not.toHaveBeenCalled()
      await type(textarea(), '/')
      await flushPromises()
      expect(api.projectTrust.list).toHaveBeenCalledWith({ params: { id: projectId(1) } })
      const deploy = wrapper.get(`${byTestId(testIds.slashMenuItem)}[data-value="deploy"]`)
      expect(deploy.attributes('data-trust')).toBe('pending')
      expect(deploy.text()).toContain('Needs approval')
      expect(wrapper.get(`${byTestId(testIds.slashMenuItem)}[data-value="status"]`).attributes('data-trust')).toBeUndefined()

      // Reopening within 15 s uses the loaded list.
      await type(textarea(), '')
      await type(textarea(), '/')
      await flushPromises()
      expect(api.projectTrust.list).toHaveBeenCalledTimes(1)

      // Selecting it still inserts it, and it is sent as typed.
      await type(textarea(), '/dep')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(textarea().element.value).toBe('/deploy ')
      await type(textarea(), '/deploy prod')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(composer().emitted('submit')).toEqual([[{ text: '/deploy prod', files: [] }]])
      wrapper.unmount()
    })

    it('fetches no trust list without project commands or outside projects', async () => {
      api.commands.list.mockResolvedValue({ items: [{ name: 'standup', description: 'Draft my standup notes', source: 'user' }] })
      const project = mountComposer({ projectId: projectId(1) })
      await flushPromises()
      await type(project.textarea(), '/')
      await flushPromises()
      project.wrapper.unmount()
      const plain = mountComposer()
      await type(plain.textarea(), '/')
      await flushPromises()
      plain.wrapper.unmount()
      expect(api.projectTrust.list).not.toHaveBeenCalled()
    })

    it('a refusal stays while the refused text is back, links the textarea and clears when the text changes', async () => {
      const { wrapper, composer, textarea } = mountComposer()
      const exposed = composer().vm as unknown as ChatComposerExposed
      await type(textarea(), 'Here is my key sk-test')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(textarea().element.value).toBe('')

      // The host may show the refusal before it restores the input.
      exposed.showRefusal({ code: 'hook-blocked', reason: 'Don\'t paste API keys into the chat.', event: 'UserPromptSubmit', source: 'project', command: null })
      exposed.restoreInput({ text: 'Here is my key sk-test', files: [] })
      await flushPromises()
      const refusal = wrapper.get(byTestId(testIds.composerRefusal))
      expect(refusal.attributes()).toMatchObject({ 'data-code': 'hook-blocked', 'data-event': 'UserPromptSubmit', 'role': 'alert' })
      expect(refusal.text()).toContain('UserPromptSubmit · Project hook')
      expect(textarea().element.value).toBe('Here is my key sk-test')
      expect(textarea().attributes('aria-describedby')).toBe(refusal.attributes('id'))
      expect(document.activeElement).toBe(textarea().element)
      // At the top of the card: before the text.
      const card = textarea().element.closest('[data-slot="input-group"]')!
      expect(refusal.element.parentElement).toBe(card)
      expect(refusal.classes()).toContain('order-first')

      // Esc never dismisses it.
      press(textarea().element, { key: 'Escape' })
      await flushPromises()
      expect(wrapper.find(byTestId(testIds.composerRefusal)).exists()).toBe(true)

      // Typing does.
      await type(textarea(), 'Here is my key')
      await flushPromises()
      expect(wrapper.find(byTestId(testIds.composerRefusal)).exists()).toBe(false)
      expect(textarea().attributes('aria-describedby')).toBeUndefined()
      wrapper.unmount()
    })

    it('an untrusted refusal names the command from the refused text and Review… opens its trust item', async () => {
      api.projectTrust.list.mockResolvedValue(projectTrustList({
        items: [trustCommandItem({ state: 'pending', sha256: 'f'.repeat(64), label: '/deploy', detail: { name: 'deploy', spans: ['./deploy.sh'] } })],
      }))
      await useProjectTrustStore().fetch(projectId(1))
      const { wrapper, composer } = mountComposer({ projectId: projectId(1) })
      const exposed = composer().vm as unknown as ChatComposerExposed
      const shot = fileRef('shot.png', 'image/png')
      exposed.restoreInput({ text: '/deploy prod', files: [shot] })
      exposed.showRefusal({ code: 'untrusted', reason: 'Approve the shell lines of /deploy first.', event: null, source: null, command: null })
      await flushPromises()
      const refusal = wrapper.get(byTestId(testIds.composerRefusal))
      expect(refusal.text()).toContain('/deploy runs shell lines you haven\'t approved.')
      expect(wrapper.get(byTestId(testIds.composerAttachment)).attributes('data-state')).toBe('done')
      // The restored command keeps the slash menu closed.
      expect(wrapper.find(byTestId(testIds.slashMenu)).exists()).toBe(false)
      await wrapper.get(byTestId(testIds.composerRefusalReview)).trigger('click')
      expect(chatViewActions.openProjectTrust).toHaveBeenCalledWith('f'.repeat(64))
      expect(wrapper.find(byTestId(testIds.composerRefusal)).exists()).toBe(true)
      wrapper.unmount()
    })

    it('a refusal clears when the chat changes', async () => {
      const { wrapper, state, composer } = mountComposer()
      const exposed = composer().vm as unknown as ChatComposerExposed
      exposed.showRefusal({ code: 'hook-blocked', reason: 'No.', event: null, source: null, command: null })
      await flushPromises()
      expect(wrapper.find(byTestId(testIds.composerRefusal)).exists()).toBe(true)
      state.chatId = chatId(2)
      await flushPromises()
      expect(wrapper.find(byTestId(testIds.composerRefusal)).exists()).toBe(false)
      wrapper.unmount()
    })
  })
})
