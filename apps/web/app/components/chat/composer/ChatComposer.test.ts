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
import { useCustomizationsStore } from '~/stores/customizations'
import { useProjectsStore } from '~/stores/projects'
import { useProvidersStore } from '~/stores/providers'
import { useSettingsStore } from '~/stores/settings'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'
import { installFakeMedia } from '~/utils/testing/fake-media'
import { catalogModel, chatId, messageId, projectFileEntry, projectId, projectSummary, queueItem } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import ChatComposer from './ChatComposer.vue'
import { anthropic, bodyAll, byTestId, haiku, llama, NuxtLinkStub, ollama, openai, seedStores, sonnet } from './composer-test-utils'
import ComposerAddMenu from './ComposerAddMenu.vue'
import SendStopButton from './SendStopButton.vue'

const mock = vi.hoisted(() => ({
  api: null as unknown,
  navigateTo: null as unknown as Mock<(...args: unknown[]) => unknown>,
  toast: null as unknown as Mock<(...args: unknown[]) => unknown>,
  toastError: null as unknown as Mock<(...args: unknown[]) => unknown>,
  player: { stop: null as unknown as Mock<() => void> },
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))
vi.mock('./nuxt-imports', () => ({ navigateTo: (...args: unknown[]) => mock.navigateTo(...args) }))
vi.mock('vue-sonner', () => ({
  toast: Object.assign((...args: unknown[]) => mock.toast(...args), { error: (...args: unknown[]) => mock.toastError(...args) }),
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
}

let pinia: ReturnType<typeof createPinia>
let api: MockApi

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
      }),
    }),
  }, { attachTo: document.body, global: { plugins: [pinia], stubs: { NuxtLink: NuxtLinkStub } } })
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
    mock.player.stop = vi.fn()
    stubLocalStorage()
    useImageOptions().set({ n: undefined, aspectRatio: undefined, editPrevious: undefined })
    sessionStorage.clear()
    pinia = createPinia()
    setActivePinia(pinia)
    seedStores()
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
        .toEqual(['new', 'model', 'effort', 'mode', 'help', 'summarize'])
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
    it('reads the slash commands of the chat\'s project from the customizations store', async () => {
      api.commands.list.mockResolvedValue({ items: [{ name: 'review', description: 'Review a file', source: 'project', argumentHint: '<file> [focus]' }] })
      const { wrapper, textarea } = mountComposer({ projectId: projectId(1) })
      await flushPromises()
      expect(api.commands.list).toHaveBeenCalledWith({ query: { projectId: projectId(1) } })
      await type(textarea(), '/')
      expect(wrapper.findAll(byTestId(testIds.slashMenuItem)).map(item => item.attributes('data-value')))
        .toEqual(['new', 'model', 'effort', 'mode', 'help', 'review'])
      wrapper.unmount()
    })

    it('shows the argument hint of a typed command over the textarea, linked from it', async () => {
      useCustomizationsStore().commands = { '': [{ name: 'review', description: 'Review a file', source: 'user', argumentHint: '<file> [focus]' }] }
      const { wrapper, textarea } = mountComposer()
      await type(textarea(), '/review ')
      const hint = wrapper.get(byTestId(testIds.slashArgumentHint))
      expect(hint.attributes('aria-hidden')).toBe('true')
      expect(hint.text()).toContain('<file> [focus]')
      const describedBy = textarea().attributes('aria-describedby')!
      expect(wrapper.get(`#${describedBy}`).text()).toBe('Arguments: <file> [focus]')
      await type(textarea(), '/review src/a.ts')
      expect(wrapper.find(byTestId(testIds.slashArgumentHint)).exists()).toBe(false)
      expect(textarea().attributes('aria-describedby')).toBeUndefined()
      wrapper.unmount()
    })

    it('/remember clears the input and opens the Remember dialog with the text', async () => {
      const { wrapper, composer, textarea } = mountComposer()
      await type(textarea(), '/remember Run pnpm check first')
      press(textarea().element, { key: 'Enter' })
      await flushPromises()
      expect(textarea().element.value).toBe('')
      expect(composer().emitted('submit')).toBeUndefined()
      const dialog = bodyAll(byTestId(testIds.rememberDialog))
      expect(dialog).toHaveLength(1)
      expect(dialog[0]!.textContent).toContain('Run pnpm check first')
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
})
