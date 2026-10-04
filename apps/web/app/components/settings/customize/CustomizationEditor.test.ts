// CustomizationEditor (docs/UI.md 9.12, 10.7, 12, 14; W10.8-T3): create, edit, the field rules (a reserved name), a
// duplicate name (409 `exists` on the name field), server diagnostics in the form-level alert, the discard
// confirmation, Mod+Enter, the command and skill fields, and the import notes. The body editor is stubbed with a
// textarea (MarkdownEditor has its own test).
import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { formatDefinition, HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import { agentCustomization, commandCustomization, toolSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import CustomizationEditor from './CustomizationEditor.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), custom: vi.fn(), dismiss: vi.fn() }),
}))

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

/** The body editor as a plain textarea (same props and emits). */
const MarkdownEditorStub = defineComponent({
  props: { modelValue: { type: String, required: true }, label: { type: String, required: true }, readonly: Boolean, diagnostics: { type: Array, default: () => [] }, minHeight: String },
  emits: ['update:modelValue', 'submit'],
  setup(props, { emit, attrs }) {
    return () => h('div', { 'data-slot': 'markdown-editor', ...attrs }, [h('textarea', {
      'value': props.modelValue,
      'aria-label': props.label,
      'onInput': (event: Event) => emit('update:modelValue', (event.target as HTMLTextAreaElement).value),
      'onKeydown': (event: KeyboardEvent) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          emit('submit')
        }
      },
    })])
  },
})

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | null = null

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  for (const fn of [mocks.toast.success, mocks.toast.error])
    fn.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
  const plugins = usePluginsStore()
  plugins.tools = [toolSummary({ name: 'read_file', pluginId: 'core-workspace' }), toolSummary({ name: 'task', pluginId: 'core-agent' })]
  plugins.toolsLoaded = true
  plugins.mcpLoaded = true
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  disposePinia(pinia)
})

interface EditorProps {
  open?: boolean
  kind?: 'agent' | 'command' | 'skill'
  mode?: 'new' | 'edit' | 'import'
  customization?: unknown
  draft?: unknown
  notes?: string[]
}

async function mountEditor(initial: EditorProps = {}) {
  const props = reactive({ open: true, kind: 'agent', mode: 'new', customization: null, draft: null, notes: [], ...initial }) as Required<EditorProps>
  const emitted = { open: [] as boolean[], saved: [] as unknown[] }
  const Host = defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(CustomizationEditor, {
        ...props,
        'onUpdate:open': (value: boolean) => {
          emitted.open.push(value)
          props.open = value
        },
        'onSaved': (value: unknown) => emitted.saved.push(value),
      } as never),
    }),
  })
  wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia], stubs: { MarkdownEditor: MarkdownEditorStub } } })
  await flushPromises()
  await nextTick()
  return { props, emitted }
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)
}

async function type(element: HTMLInputElement | HTMLTextAreaElement | null, value: string, blur = true) {
  element!.value = value
  element!.dispatchEvent(new Event('input', { bubbles: true }))
  if (blur)
    element!.dispatchEvent(new FocusEvent('blur'))
  await flushPromises()
}

function body(): HTMLTextAreaElement {
  return byTestId(testIds.customizationBody)!.querySelector('textarea')!
}

function save(): HTMLButtonElement {
  return byTestId<HTMLButtonElement>(testIds.customizationSave)!
}

describe('customizationEditor', () => {
  it('creates a new agent: focus on Name, the fields serialized with formatDefinition, toast, saved and closed', async () => {
    const { emitted } = await mountEditor()
    const editor = byTestId(testIds.customizationEditor)!
    expect(editor.dataset).toMatchObject({ kind: 'agent', mode: 'new' })
    expect(editor.textContent).toContain('New agent')
    await vi.waitFor(() => expect(document.activeElement).toBe(byTestId(testIds.customizationName)))
    expect(byTestId(testIds.customizationToolsMode)?.dataset.value).toBe('all')
    expect(editor.textContent).toContain('All tools the chat allows')
    expect(byTestId(testIds.customizationModel)?.textContent).toContain('Default sub-agent model')
    expect(byTestId(testIds.customizationArgumentHint)).toBeNull()
    expect(save().disabled).toBe(true)

    await type(byTestId(testIds.customizationName), 'code-reviewer')
    await type(byTestId(testIds.customizationDescription), 'Reviews diffs for bugs.')
    await type(body(), 'You review diffs.')
    expect(editor.textContent).toContain('KB / 64 KB')
    expect(save().disabled).toBe(false)

    const created = agentCustomization({ name: 'code-reviewer' })
    api.customizations.create.mockResolvedValue(created)
    save().click()
    await flushPromises()
    expect(api.customizations.create).toHaveBeenCalledWith({
      body: {
        kind: 'agent',
        content: formatDefinition({ kind: 'agent', fields: { name: 'code-reviewer', description: 'Reviews diffs for bugs.', tools: null, model: null, instructions: 'You review diffs.' } }),
      },
    })
    expect(mocks.toast.success).toHaveBeenCalledWith('Agent saved')
    expect(emitted.saved).toEqual([created])
    expect(emitted.open).toEqual([false])
  })

  it('edits a personal agent: prefilled, focus on Description, Mod+Enter in a field saves through update', async () => {
    const customization = agentCustomization()
    const { emitted } = await mountEditor({ mode: 'edit', customization })
    const editor = byTestId(testIds.customizationEditor)!
    expect(editor.textContent).toContain('Edit reviewer')
    expect(byTestId<HTMLInputElement>(testIds.customizationName)!.value).toBe('reviewer')
    expect(byTestId(testIds.customizationToolsMode)?.dataset.value).toBe('some')
    expect(byTestId(testIds.customizationTools)?.dataset.count).toBe('2')
    expect(body().value).toBe('Review the diff. Report each bug with its file and line.\n')
    await vi.waitFor(() => expect(document.activeElement).toBe(byTestId(testIds.customizationDescription)))

    await type(byTestId(testIds.customizationDescription), 'Reviews a diff carefully', false)
    api.customizations.update.mockResolvedValue({ ...customization, description: 'Reviews a diff carefully' })
    byTestId(testIds.customizationDescription)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
    await flushPromises()
    expect(api.customizations.update).toHaveBeenCalledTimes(1)
    const call = api.customizations.update.mock.calls[0]![0] as { params: { id: string }, body: { content: string } }
    expect(call.params.id).toBe(customization.id)
    expect(call.body.content).toContain('description: Reviews a diff carefully')
    expect(call.body.content).toContain('- read_file')
    expect(emitted.open).toEqual([false])
  })

  it('refuses a built-in name with the editor copy and keeps Save disabled', async () => {
    await mountEditor()
    const name = byTestId<HTMLInputElement>(testIds.customizationName)!
    await type(name, 'explore')
    await type(byTestId(testIds.customizationDescription), 'Explores')
    expect(name.getAttribute('aria-invalid')).toBe('true')
    const error = document.getElementById(name.getAttribute('aria-describedby')!)
    expect(error?.textContent?.trim()).toBe('explore is a built-in name.')
    expect(save().disabled).toBe(true)
    await type(name, 'Bad Name')
    expect(document.getElementById(name.getAttribute('aria-describedby')!)?.textContent?.trim()).toBe('Use lowercase letters, digits and hyphens, starting with a letter.')
  })

  it('shows a 409 exists on the name field and server diagnostics or messages in the form-level alert', async () => {
    await mountEditor({ mode: 'import', draft: { kind: 'agent', name: 'reviewer', description: 'Reviews', tools: null, model: null, argumentHint: null, body: 'Review.' } })
    api.customizations.create.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'A personal agent named "reviewer" already exists.', details: { reason: 'exists' } }))
    save().click()
    await flushPromises()
    const name = byTestId<HTMLInputElement>(testIds.customizationName)!
    expect(document.getElementById(name.getAttribute('aria-describedby')!)?.textContent?.trim()).toBe('You already have an agent named reviewer.')
    await vi.waitFor(() => expect(document.activeElement).toBe(name))
    expect(save().disabled).toBe(true)
    expect(byTestId(testIds.customizationError)).toBeNull()

    await type(name, 'reviewer-2')
    expect(save().disabled).toBe(false)
    api.customizations.create.mockRejectedValueOnce(new HarnessError({
      code: 'validation_error',
      message: 'The definition has errors.',
      details: { issues: [], diagnostics: [{ level: 'error', code: 'reserved-name', message: 'Line 2: reviewer-2 is a built-in name.', line: 2 }] },
    }))
    save().click()
    await flushPromises()
    const alert = byTestId(testIds.customizationError)!
    expect(alert.dataset.code).toBe('validation_error')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toContain('Line 2: reviewer-2 is a built-in name.')

    api.customizations.create.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'You can have up to 200 agents.', details: { reason: 'busy' } }))
    save().click()
    await flushPromises()
    expect(byTestId(testIds.customizationError)?.textContent).toContain('You can have up to 200 agents.')
    expect(byTestId(testIds.customizationError)?.dataset.code).toBe('conflict')
  })

  it('asks "Discard changes?" before closing with changes; Keep editing stays, Discard closes', async () => {
    const { emitted } = await mountEditor()
    document.body.querySelector<HTMLElement>('[data-slot="sheet-close"]')!.click()
    await flushPromises()
    expect(emitted.open).toEqual([false])
    wrapper!.unmount()
    document.body.replaceChildren()

    const second = await mountEditor()
    await type(byTestId(testIds.customizationName), 'draft')
    document.body.querySelector<HTMLElement>('[data-slot="sheet-close"]')!.click()
    await flushPromises()
    expect(second.emitted.open).toEqual([])
    const confirm = document.body.querySelector<HTMLElement>('[data-slot="confirm-dialog"]')!
    expect(confirm.textContent).toContain('Discard changes?')
    expect(confirm.textContent).toContain('Your changes are lost.')
    const keep = [...confirm.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Keep editing')!
    keep.click()
    await flushPromises()
    expect(document.body.querySelector('[data-slot="confirm-dialog"]')).toBeNull()
    expect(byTestId(testIds.customizationEditor)).not.toBeNull()

    byTestId(testIds.customizationEditor)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    byTestId(testIds.customizationDiscardConfirm)!.click()
    await flushPromises()
    expect(second.emitted.open).toEqual([false])
  })

  it('shows the command fields: the / adornment, Allowed tools, the chat\'s model, the argument hint; the body editor submits', async () => {
    await mountEditor({ kind: 'command', mode: 'edit', customization: commandCustomization() })
    const editor = byTestId(testIds.customizationEditor)!
    expect(editor.textContent).toContain('Edit greet')
    expect(byTestId(testIds.customizationName)?.closest('[data-slot="input-group"]')?.textContent).toContain('/')
    expect(editor.textContent).toContain('Allowed tools')
    expect(editor.textContent).toContain('No restriction')
    expect(byTestId(testIds.customizationModel)?.dataset.value).toBe('mock:echo')
    expect(byTestId<HTMLInputElement>(testIds.customizationArgumentHint)!.value).toBe('<name>')
    expect(editor.textContent).toContain('$ARGUMENTS is the text after the command')
    expect(byTestId(testIds.customizationBody)?.querySelector('textarea')?.getAttribute('aria-label')).toBe('Prompt')

    const only = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.customizationToolsMode}"] [role="radio"][value="some"]`)!
    only.click()
    await flushPromises()
    expect(byTestId(testIds.customizationToolsMode)?.dataset.value).toBe('some')
    expect(byTestId(testIds.customizationTools)).not.toBeNull()

    api.customizations.update.mockResolvedValue(commandCustomization())
    body().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
    await flushPromises()
    expect(api.customizations.update).toHaveBeenCalledTimes(1)
    const content = (api.customizations.update.mock.calls[0]![0] as { body: { content: string } }).body.content
    expect(content).toContain('allowed-tools: []')
    expect(content).toContain('argument-hint: <name>')
  })

  it('opens an import with its notes and the skill fields only', async () => {
    await mountEditor({
      kind: 'skill',
      mode: 'import',
      draft: { kind: 'skill', name: '', description: 'Write release notes', tools: null, model: null, argumentHint: null, body: 'Use the changelog.' },
      notes: ['Imported from SKILL.md. Check the fields, then save.', 'Add a name.'],
    })
    const editor = byTestId(testIds.customizationEditor)!
    expect(editor.dataset).toMatchObject({ kind: 'skill', mode: 'import' })
    expect(editor.textContent).toContain('Import skill')
    const notes = byTestId(testIds.customizationImportNotes)!
    expect(notes.dataset.count).toBe('2')
    expect(notes.textContent).toContain('Imported from SKILL.md. Check the fields, then save.')
    expect(byTestId(testIds.customizationToolsMode)).toBeNull()
    expect(byTestId(testIds.customizationModel)).toBeNull()
    // Import mode shows the field problems at once.
    const name = byTestId<HTMLInputElement>(testIds.customizationName)!
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(save().disabled).toBe(true)
    expect(save().textContent?.trim()).toBe('Save skill')
  })

  it('leaves the core-agent tools out of an agent\'s tool list', async () => {
    await mountEditor({ mode: 'edit', customization: agentCustomization() })
    byTestId(testIds.customizationTools)!.click()
    await flushPromises()
    const options = [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.customizationToolOption}"]`)].map(option => option.dataset.toolName)
    expect(options).toEqual(['read_file'])
    // search_files is chosen but not in the tool list: a warning chip.
    const chip = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.customizationToolChip}"][data-tool-name="search_files"]`)
    expect(chip?.dataset.state).toBe('unknown')
  })
})
