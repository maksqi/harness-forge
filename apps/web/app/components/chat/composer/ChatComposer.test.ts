import type { FileRef, MessageUsage, ReasoningEffort, ToolMode } from '@harness-forge/shared'
import type { ChatStatus } from 'ai'
import type { Mock } from 'vitest'
import type { ChatComposerExposed } from './types'
import type { MockApi } from '~/utils/testing/mock-api'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick, reactive } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useShortcuts } from '~/composables/useShortcuts'
import { useProvidersStore } from '~/stores/providers'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'
import { chatId } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import ChatComposer from './ChatComposer.vue'
import { anthropic, bodyAll, byTestId, haiku, llama, NuxtLinkStub, ollama, seedStores, sonnet } from './composer-test-utils'

const mock = vi.hoisted(() => ({
  api: null as unknown,
  navigateTo: null as unknown as Mock<(...args: unknown[]) => unknown>,
  toastError: null as unknown as Mock<(...args: unknown[]) => unknown>,
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))
vi.mock('./nuxt-imports', () => ({ navigateTo: (...args: unknown[]) => mock.navigateTo(...args) }))
vi.mock('vue-sonner', () => ({
  toast: Object.assign(() => {}, { error: (...args: unknown[]) => mock.toastError(...args) }),
}))

interface HarnessState {
  chatId: string
  status: ChatStatus
  modelRef: string | null
  reasoningEffort: ReasoningEffort
  toolMode: ToolMode
  usage: MessageUsage | null
  chatCostUsd: number | null
  disabled: boolean
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
  return { wrapper, state, composer, textarea, send }
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

describe('chatComposer', () => {
  beforeAll(() => {
    window.addEventListener('keydown', shortcuts.handleKeydown)
  })

  beforeEach(() => {
    api = createMockApi()
    mock.api = api
    mock.navigateTo = vi.fn()
    mock.toastError = vi.fn()
    stubLocalStorage()
    sessionStorage.clear()
    pinia = createPinia()
    setActivePinia(pinia)
    seedStores()
  })

  afterEach(() => {
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

  it('shows Stop while a response runs: click or Esc stops, Enter does not send', async () => {
    const { wrapper, state, composer, textarea } = mountComposer({ status: 'streaming' })
    expect(wrapper.get(byTestId(testIds.composer)).attributes('data-status')).toBe('streaming')
    expect(wrapper.find(byTestId(testIds.composerSend)).exists()).toBe(false)
    await wrapper.get(byTestId(testIds.composerStop)).trigger('click')
    expect(composer().emitted('stop')).toHaveLength(1)

    press(textarea().element, { key: 'Escape' })
    expect(composer().emitted('stop')).toHaveLength(2)

    await type(textarea(), 'queued?')
    press(textarea().element, { key: 'Enter' })
    await flushPromises()
    expect(composer().emitted('submit')).toBeUndefined()

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

  it('focuses itself on ui.requestComposerFocus()', async () => {
    const { wrapper, textarea } = mountComposer()
    textarea().element.blur()
    useUiStore().requestComposerFocus()
    await nextTick()
    expect(document.activeElement).toBe(textarea().element)
    wrapper.unmount()
  })
})
