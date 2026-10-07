// CustomizationEditor (docs/UI.md 9.12, 10.7, 12, 14; W10.8-T3): create, edit, the field rules (a reserved name), a
// duplicate name (409 `exists` on the name field), server diagnostics in the form-level alert, the discard
// confirmation, Mod+Enter, the command and skill fields, and the import notes. The body editor is stubbed with a
// textarea (MarkdownEditor has its own test). Phase 11 (W11.8-T6, T7): the output style editor (Keep coding
// instructions, no Tools or Model, the label kept on save) and the skill switches and argument hint. Phase 12
// (W12.11-T3): the agent's Tools not allowed, Max turns, Color and Skills; the skill's Allowed tools, Model, When to use
// and Run in a sub-agent with its Agent; the body help for `$ARGUMENTS[N]`; keys the form does not show are kept.
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
import { agentCustomization, commandCustomization, customizationId, styleCustomization, toolSummary } from '~/utils/testing/fixtures'
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
  kind?: 'agent' | 'command' | 'skill' | 'style'
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

  it('opens an import with its notes and the skill fields (Phase 12: Allowed tools and Model too)', async () => {
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
    // Phase 12 (ADR-058): a skill's Allowed tools and Model work as a command's; no agent fields.
    expect(byTestId(testIds.customizationToolsMode)?.dataset.value).toBe('all')
    expect(editor.textContent).toContain('Allowed tools')
    expect(editor.textContent).toContain('No restriction')
    expect(byTestId(testIds.customizationModel)?.textContent).toContain('The chat\'s model')
    expect(byTestId(testIds.customizationMaxTurns)).toBeNull()
    expect(byTestId(testIds.customizationColor)).toBeNull()
    expect(byTestId(testIds.customizationSkills)).toBeNull()
    expect(byTestId(testIds.customizationWhenToUse)).not.toBeNull()
    expect(byTestId(testIds.customizationFork)?.dataset.state).toBe('unchecked')
    expect(byTestId(testIds.customizationForkAgent)).toBeNull()
    expect(editor.textContent).toContain('$ARGUMENTS[0] or $0 is the first argument')
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

  it('edits an output style: Keep coding instructions, no Tools or Model, the label kept (Phase 11)', async () => {
    const style = styleCustomization()
    api.customizations.update.mockResolvedValue(style)
    const { emitted } = await mountEditor({ kind: 'style', mode: 'edit', customization: style })
    const editor = byTestId(testIds.customizationEditor)!
    expect(editor.dataset.kind).toBe('style')
    expect(editor.textContent).toContain('Edit terse')
    expect(editor.textContent).toContain('Shown in the composer\'s style menu.')
    expect(editor.textContent).toContain('How the agent writes its replies. They go first in the main agent\'s instructions, never in sub-agents\'.')
    expect(byTestId(testIds.customizationToolsMode)).toBeNull()
    expect(byTestId(testIds.customizationModel)).toBeNull()
    const keep = byTestId(testIds.customizationKeepCoding)!
    expect(keep.dataset.state).toBe('checked')
    expect(editor.textContent).toContain('On: the agent keeps its tool rules and task hints. Off: only this style shapes its replies.')
    keep.click()
    await flushPromises()
    expect(keep.dataset.state).toBe('unchecked')
    expect(save().textContent?.trim()).toBe('Save output style')
    save().click()
    await flushPromises()
    // The label as written ("Terse") survives; the flag is left out when off.
    expect(api.customizations.update).toHaveBeenCalledWith({
      params: { id: customizationId(3) },
      body: { content: '---\nname: Terse\ndescription: Short answers without preamble\n---\n\nAnswer in at most three sentences.\n' },
    })
    expect(mocks.toast.success).toHaveBeenCalledWith('Output style saved')
    expect(emitted.saved).toHaveLength(1)
  })

  it('creates a skill with the slash menu switches and an argument hint (Phase 11)', async () => {
    api.customizations.create.mockResolvedValue(commandCustomization())
    await mountEditor({ kind: 'skill' })
    const editor = byTestId(testIds.customizationEditor)!
    const inMenu = byTestId(testIds.customizationUserInvocable)!
    const onlyRun = byTestId(testIds.customizationModelInvocation)!
    expect(inMenu.dataset.state).toBe('checked')
    expect(onlyRun.dataset.state).toBe('unchecked')
    expect(editor.textContent).toContain('Show in the slash menu')
    expect(editor.textContent).toContain('The agent doesn\'t load it by itself; it runs only as /name.')
    expect(byTestId(testIds.customizationKeepCoding)).toBeNull()
    await type(byTestId<HTMLInputElement>(testIds.customizationName), 'deploy')
    await type(byTestId<HTMLTextAreaElement>(testIds.customizationDescription), 'Deploy the app')
    await type(byTestId<HTMLInputElement>(testIds.customizationArgumentHint), '<env>')
    await type(body(), 'Run the deploy for $ARGUMENTS.')
    onlyRun.click()
    await flushPromises()
    save().click()
    await flushPromises()
    const content = (api.customizations.create.mock.calls[0]![0] as { body: { kind: string, content: string } }).body
    expect(content.kind).toBe('skill')
    expect(content.content).toContain('argument-hint: <env>')
    expect(content.content).toContain('disable-model-invocation: true')
    expect(content.content).not.toContain('user-invocable')
  })
})

describe('customizationEditor: Claude Code fields (Phase 12, W12.11-T3)', () => {
  const AGENT_FILE = '---\nname: reviewer\ndescription: Reviews a diff\ntools:\n  - read_file\ndisallowedTools:\n  - shell\nmodel: sonnet\nmaxTurns: 12\nskills:\n  - pdf\ncolor: purple\n---\n\nReview it.\n'

  function agentWithKeys() {
    return agentCustomization({
      content: AGENT_FILE,
      fields: {
        name: 'reviewer',
        description: 'Reviews a diff',
        tools: ['read_file'],
        model: null,
        instructions: 'Review it.',
        disallowedTools: ['shell'],
        maxTurns: 12,
        color: 'purple',
        skills: ['pdf'],
        modelAlias: 'sonnet',
      },
    })
  }

  it('shows an agent\'s keys and saves them unchanged (the Claude model name kept)', async () => {
    api.customizations.update.mockResolvedValue(agentWithKeys())
    await mountEditor({ mode: 'edit', customization: agentWithKeys() })
    const editor = byTestId(testIds.customizationEditor)!
    expect(byTestId(testIds.customizationDisallowedTools)?.dataset.count).toBe('1')
    expect(editor.textContent).toContain('Tools not allowed')
    expect(editor.textContent).toContain('Removed after the allowed tools. A rule with arguments, like Bash(rm *), removes the whole tool.')
    expect(byTestId<HTMLInputElement>(testIds.customizationMaxTurns)!.value).toBe('12')
    expect(byTestId<HTMLInputElement>(testIds.customizationMaxTurns)!.getAttribute('inputmode')).toBe('numeric')
    expect(editor.textContent).toContain('At most this many steps; the sub-agent step limit still applies.')
    const color = byTestId(testIds.customizationColor)!
    expect(color.dataset.value).toBe('purple')
    expect(color.textContent).toContain('Purple')
    expect(editor.textContent).toContain('Marks this agent\'s runs in the chat.')
    expect(byTestId(testIds.customizationSkills)?.dataset.count).toBe('1')
    expect(editor.textContent).toContain('Loaded into the sub-agent\'s instructions when it starts.')
    expect(byTestId(testIds.customizationModel)?.textContent).toContain('sonnet (Claude model name)')
    expect(byTestId(testIds.customizationWhenToUse)).toBeNull()
    expect(byTestId(testIds.customizationFork)).toBeNull()

    save().click()
    await flushPromises()
    expect(api.customizations.update).toHaveBeenCalledWith({ params: { id: customizationId(1) }, body: { content: AGENT_FILE } })
  })

  it('checks Max turns and writes the new agent keys with formatDefinition', async () => {
    api.customizations.create.mockResolvedValue(agentCustomization())
    await mountEditor()
    await type(byTestId<HTMLInputElement>(testIds.customizationName), 'triager')
    await type(byTestId<HTMLTextAreaElement>(testIds.customizationDescription), 'Triages issues')
    await type(body(), 'Sort the issues.')
    const turns = byTestId<HTMLInputElement>(testIds.customizationMaxTurns)!
    await type(turns, '500')
    expect(turns.getAttribute('aria-invalid')).toBe('true')
    expect(byTestId(testIds.customizationEditor)?.textContent).toContain('Enter a whole number from 1 to 200.')
    expect(save().disabled).toBe(true)
    await type(turns, '8')
    expect(save().disabled).toBe(false)

    byTestId(testIds.customizationColor)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()
    const options = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options.map(option => option.dataset.value)).toEqual(['', 'red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'])
    expect(options[1]!.querySelector('[data-slot="customization-color-dot"]')?.getAttribute('aria-hidden')).toBe('true')
    options.find(option => option.dataset.value === 'cyan')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(byTestId(testIds.customizationColor)?.dataset.value).toBe('cyan')

    save().click()
    await flushPromises()
    const content = (api.customizations.create.mock.calls[0]![0] as { body: { content: string } }).body.content
    expect(content).toBe(formatDefinition({ kind: 'agent', fields: { name: 'triager', description: 'Triages issues', tools: null, model: null, instructions: 'Sort the issues.', maxTurns: 8, color: 'cyan' } }))
  })

  it('creates a skill that runs in a sub-agent with its agent, When to use, allowed tools and a model', async () => {
    api.customizations.create.mockResolvedValue(commandCustomization())
    await mountEditor({ kind: 'skill' })
    await type(byTestId<HTMLInputElement>(testIds.customizationName), 'pdf')
    await type(byTestId<HTMLTextAreaElement>(testIds.customizationDescription), 'Fill PDF forms')
    await type(byTestId<HTMLTextAreaElement>(testIds.customizationWhenToUse), 'When a PDF form must be filled')
    await type(body(), 'Fill $ARGUMENTS[0].')
    expect(byTestId(testIds.customizationEditor)?.textContent).toContain('Added to the description the agent reads.')
    const fork = byTestId(testIds.customizationFork)!
    expect(byTestId(testIds.customizationEditor)?.textContent).toContain('The skill runs as a sub-agent and only its report comes back.')
    fork.click()
    await flushPromises()
    expect(fork.dataset.state).toBe('checked')
    const agent = byTestId(testIds.customizationForkAgent)!
    expect(agent.dataset.value).toBe('general')
    agent.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()
    document.body.querySelector<HTMLElement>('[role="option"][data-value="explore"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(byTestId(testIds.customizationForkAgent)?.dataset.value).toBe('explore')

    document.body.querySelector<HTMLElement>(`[data-testid="${testIds.customizationToolsMode}"] [role="radio"][value="some"]`)!.click()
    await flushPromises()
    save().click()
    await flushPromises()
    const content = (api.customizations.create.mock.calls[0]![0] as { body: { kind: string, content: string } }).body.content
    expect(content).toContain('when_to_use: When a PDF form must be filled')
    expect(content).toContain('allowed-tools: []')
    expect(content).toContain('context: fork')
    expect(content).toContain('agent: explore')
  })

  it('keeps the named arguments of a command it does not show', async () => {
    const file = '---\ndescription: Greet someone\narguments:\n  - who\n---\n\nSay hello to $who.\n'
    const greet = commandCustomization({
      content: file,
      fields: { name: 'greet', description: 'Greet someone', argumentHint: null, model: null, allowedTools: null, body: 'Say hello to $who.', arguments: ['who'] },
    })
    api.customizations.update.mockResolvedValue(greet)
    await mountEditor({ kind: 'command', mode: 'edit', customization: greet })
    await type(byTestId<HTMLTextAreaElement>(testIds.customizationWhenToUse), 'When you meet someone')
    save().click()
    await flushPromises()
    const content = (api.customizations.update.mock.calls[0]![0] as { body: { content: string } }).body.content
    expect(content).toContain('arguments:\n  - who')
    expect(content).toContain('when_to_use: When you meet someone')
  })
})
