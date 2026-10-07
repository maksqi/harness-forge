// ProjectFileEditor (Phase 12, ADR-056; docs/UI.md 2.19, 9.14, 10.9; W12.11-T1): the root test id and attributes, the
// raw file (stubbed MarkdownEditor) with its parsed summary and diagnostics, the save with the loaded sha256, the toast
// with Review when items wait for an approval, the stale conflict (Load from disk, Overwrite), a 400 with diagnostics, a
// file that is gone, the discard confirmation, Mod+Enter, a new definition (Folder, Name, `expectedSha256: null`) and
// `.mcp.json` (the `mcpServers` object as JSON).
import type { ProjectFileTarget } from './customize'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import { projectDefinitionFile, projectDefinitionWriteResult, projectId, projectSummary, trustSha } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import ProjectFileEditor from './ProjectFileEditor.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), custom: vi.fn(), dismiss: vi.fn() }),
}))

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

/** The raw editor as a plain textarea (MarkdownEditor has its own test): same props, emits and `focus`. */
const MarkdownEditorStub = defineComponent({
  props: { modelValue: { type: String, required: true }, label: { type: String, required: true }, readonly: Boolean, diagnostics: { type: Array, default: () => [] }, minHeight: String },
  emits: ['update:modelValue', 'submit'],
  setup(props, { emit, attrs, expose }) {
    expose({ focus: () => document.body.querySelector<HTMLTextAreaElement>('[data-slot="markdown-editor"] textarea')?.focus() })
    return () => h('div', { 'data-slot': 'markdown-editor', 'data-markers': String(props.diagnostics.length), ...attrs }, [h('textarea', {
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

const AGENT = '---\nname: reviewer\ndescription: Reviews a diff and reports bugs\ndisallowedTools: Bash\nmaxTurns: 12\ncolor: purple\nx-team: core\n---\nReview the diff.\n'

let api: MockApi
let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  for (const fn of [mocks.toast.success, mocks.toast.error])
    fn.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
  useProjectsStore().items = [projectSummary({ id: projectId(1), name: 'website' })]
})

afterEach(() => {
  document.body.replaceChildren()
  disposePinia(pinia)
})

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)
}

async function settle() {
  await flushPromises()
  await nextTick()
  await flushPromises()
}

const REVIEWER: ProjectFileTarget = { path: '.claude/agents/reviewer.md', kind: 'agent', name: 'reviewer', create: false }

async function mountEditor(entry: ProjectFileTarget = REVIEWER) {
  const state = reactive({ open: true })
  const events = { saved: vi.fn(), open: vi.fn(), review: vi.fn() }
  const Host = defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(ProjectFileEditor, {
        'open': state.open,
        'projectId': projectId(1),
        entry,
        'onSaved': events.saved,
        'onReview': events.review,
        'onUpdate:open': (value: boolean) => {
          events.open(value)
          state.open = value
        },
      }),
    }),
  })
  mount(Host, { attachTo: document.body, global: { plugins: [pinia], stubs: { MarkdownEditor: MarkdownEditorStub } } })
  await settle()
  return { events, state }
}

function content(): HTMLTextAreaElement {
  const root = byTestId(testIds.projectFileContent)!
  return root.tagName === 'TEXTAREA' ? root as HTMLTextAreaElement : root.querySelector('textarea')!
}

async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}

function save(): HTMLButtonElement {
  return byTestId<HTMLButtonElement>(testIds.projectFileSave)!
}

describe('projectFileEditor', () => {
  it('opens on the raw file with its kind, path and mode, the parsed summary and the note', async () => {
    api.projectDefinitions.read.mockResolvedValue(projectDefinitionFile({ content: AGENT }))
    await mountEditor()
    const editor = byTestId(testIds.projectFileEditor)!
    expect(editor.dataset).toMatchObject({ kind: 'agent', path: '.claude/agents/reviewer.md', mode: 'edit' })
    expect(editor.textContent).toContain('Edit reviewer.md')
    expect(editor.textContent).toContain('.claude/agents/reviewer.md')
    expect(editor.textContent).toContain('Copy path')
    // The raw text: an unknown key is kept byte for byte.
    expect(content().value).toBe(AGENT)
    expect(content().getAttribute('aria-label')).toBe('File content')
    expect(api.projectDefinitions.read).toHaveBeenCalledWith({ params: { id: projectId(1) }, query: { path: '.claude/agents/reviewer.md' } })
    const summary = editor.querySelector<HTMLElement>('[data-slot="project-file-summary"]')!
    expect(summary.textContent).toContain('Agent reviewer')
    expect(summary.textContent).toContain('Max turns 12')
    expect(summary.textContent).toContain('Not allowed:')
    expect(summary.textContent).toContain('Purple')
    expect(summary.querySelector('[data-slot="customization-color-dot"]')?.getAttribute('aria-hidden')).toBe('true')
    expect(editor.textContent).toContain('Saving never approves hooks or shell lines.')
    expect(save().disabled).toBe(false)
    await vi.waitFor(() => expect(document.activeElement).toBe(content()))
  })

  it('saves with the loaded sha256, toasts the path and closes', async () => {
    api.projectDefinitions.read.mockResolvedValue(projectDefinitionFile())
    api.projectDefinitions.write.mockResolvedValue(projectDefinitionWriteResult({ path: '.claude/agents/reviewer.md', trust: { pending: 0 } }))
    const { events } = await mountEditor()
    save().click()
    await settle()
    expect(api.projectDefinitions.write).toHaveBeenCalledWith({
      params: { id: projectId(1) },
      body: { path: '.claude/agents/reviewer.md', expectedSha256: trustSha(1), content: projectDefinitionFile().content },
    })
    expect(mocks.toast.success).toHaveBeenCalledWith('Saved .claude/agents/reviewer.md.')
    expect(events.saved).toHaveBeenCalledWith({ path: '.claude/agents/reviewer.md', pending: 0 })
    expect(events.open).toHaveBeenCalledWith(false)
  })

  it('offers Review in the toast when items wait for an approval, and saves with Mod+Enter', async () => {
    api.projectDefinitions.read.mockResolvedValue(projectDefinitionFile({ path: '.claude/commands/deploy.md', kind: 'command', content: '---\ndescription: Deploy\n---\nRun !`npm run deploy` now.\n' }))
    api.projectDefinitions.write.mockResolvedValue(projectDefinitionWriteResult({ path: '.claude/commands/deploy.md', trust: { pending: 2 } }))
    const { events } = await mountEditor({ path: '.claude/commands/deploy.md', kind: 'command', name: 'deploy', create: false })
    await type(content(), '---\ndescription: Deploy the app\n---\nRun !`npm run deploy` now.\n')
    content().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
    await settle()
    expect(api.projectDefinitions.write).toHaveBeenCalledTimes(1)
    const [message, options] = mocks.toast.success.mock.calls[0] as [string, { action: { label: string, onClick: () => void } }]
    expect(message).toBe('Saved .claude/commands/deploy.md. 2 items need your approval.')
    expect(options.action.label).toBe('Review')
    options.action.onClick()
    expect(events.review).toHaveBeenCalledTimes(1)
    expect(events.saved).toHaveBeenCalledWith({ path: '.claude/commands/deploy.md', pending: 2 })
  })

  it('shows the conflict of a stale save; Load from disk drops the edits and reloads', async () => {
    api.projectDefinitions.read.mockResolvedValueOnce(projectDefinitionFile())
    api.projectDefinitions.write.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'The file changed on disk.', details: { reason: 'stale' } }))
    await mountEditor()
    await type(content(), `${projectDefinitionFile().content}More.\n`)
    save().click()
    await settle()
    const alert = byTestId(testIds.projectFileConflict)!
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toContain('reviewer.md changed on disk after you opened it.')
    expect(document.activeElement).toBe(alert)

    api.projectDefinitions.read.mockResolvedValueOnce(projectDefinitionFile({ content: '---\nname: reviewer\ndescription: Changed elsewhere\n---\nNew.\n', sha256: trustSha(5) }))
    byTestId(testIds.projectFileReload)!.click()
    await settle()
    expect(byTestId(testIds.projectFileConflict)).toBeNull()
    expect(content().value).toContain('Changed elsewhere')
    api.projectDefinitions.write.mockResolvedValueOnce(projectDefinitionWriteResult({ path: '.claude/agents/reviewer.md', trust: { pending: 0 } }))
    save().click()
    await settle()
    expect((api.projectDefinitions.write.mock.calls[1]![0] as { body: { expectedSha256: string } }).body.expectedSha256).toBe(trustSha(5))
  })

  it('overwrites a changed file with the current sha256 and the edited text', async () => {
    api.projectDefinitions.read.mockResolvedValueOnce(projectDefinitionFile())
    api.projectDefinitions.write.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'The file changed on disk.', details: { reason: 'stale' } }))
    const { events } = await mountEditor()
    const edited = '---\nname: reviewer\ndescription: Mine\n---\nMine.\n'
    await type(content(), edited)
    save().click()
    await settle()
    api.projectDefinitions.read.mockResolvedValueOnce(projectDefinitionFile({ sha256: trustSha(7), content: 'theirs' }))
    api.projectDefinitions.write.mockResolvedValueOnce(projectDefinitionWriteResult({ path: '.claude/agents/reviewer.md', trust: { pending: 0 } }))
    byTestId(testIds.projectFileOverwrite)!.click()
    await settle()
    expect(api.projectDefinitions.write).toHaveBeenLastCalledWith({
      params: { id: projectId(1) },
      body: { path: '.claude/agents/reviewer.md', expectedSha256: trustSha(7), content: edited },
    })
    expect(events.saved).toHaveBeenCalledTimes(1)
  })

  it('blocks saving while the parser reports an error and lists a 400 with its diagnostics', async () => {
    api.projectDefinitions.read.mockResolvedValue(projectDefinitionFile())
    await mountEditor()
    await type(content(), '---\nname: reviewer\n---\nNo description.\n')
    expect(save().disabled).toBe(true)
    const problems = byTestId(testIds.projectFileEditor)!.querySelector<HTMLElement>('[data-slot="project-file-diagnostics"]')!
    expect(problems.querySelector('[data-level="error"]')).not.toBeNull()

    await type(content(), '---\nname: reviewer\ndescription: Fine\n---\nBody.\n')
    expect(save().disabled).toBe(false)
    api.projectDefinitions.write.mockRejectedValueOnce(new HarnessError({ code: 'validation_error', message: 'The definition has errors.', details: { diagnostics: [{ level: 'error', code: 'invalid-name', message: 'Line 2: Use another name.' }] } }))
    save().click()
    await settle()
    const error = byTestId(testIds.projectFileError)!
    expect(error.dataset.code).toBe('validation_error')
    expect(error.textContent).toContain('Line 2: Use another name.')
  })

  it('says when the file no longer exists and closes without asking', async () => {
    api.projectDefinitions.read.mockResolvedValue(projectDefinitionFile({ exists: false, content: null, sha256: null }))
    const { events } = await mountEditor()
    const error = byTestId(testIds.projectFileError)!
    expect(error.dataset.code).toBe('not_found')
    expect(error.textContent).toContain('This file no longer exists.')
    expect(byTestId(testIds.projectFileSave)).toBeNull()
    const close = [...byTestId(testIds.projectFileEditor)!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Close')!
    close.click()
    await settle()
    expect(events.open).toHaveBeenCalledWith(false)
  })

  it('asks "Discard changes?" before closing with edits', async () => {
    api.projectDefinitions.read.mockResolvedValue(projectDefinitionFile())
    const { events } = await mountEditor()
    await type(content(), 'changed')
    const cancel = [...byTestId(testIds.projectFileEditor)!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Cancel')!
    cancel.click()
    await settle()
    expect(events.open).not.toHaveBeenCalled()
    const discard = byTestId(testIds.projectFileDiscardConfirm)!
    expect(document.body.textContent).toContain('Discard changes?')
    discard.click()
    await settle()
    expect(events.open).toHaveBeenCalledWith(false)
    expect(api.projectDefinitions.write).not.toHaveBeenCalled()
  })

  it('creates a new definition from a folder and a name (expectedSha256 null)', async () => {
    api.projectDefinitions.write.mockResolvedValue(projectDefinitionWriteResult({ path: '.claude/skills/pdf/SKILL.md', created: true, trust: { pending: 0 } }))
    const { events } = await mountEditor({ path: '.claude/skills/SKILL.md', kind: 'skill', name: null, create: true })
    const editor = byTestId(testIds.projectFileEditor)!
    expect(editor.dataset.mode).toBe('new')
    expect(editor.textContent).toContain('New skill in website')
    expect(api.projectDefinitions.read).not.toHaveBeenCalled()
    expect(editor.querySelector<HTMLElement>('[data-slot="project-file-folder"]')?.dataset.value).toBe('.claude')
    const name = editor.querySelector<HTMLInputElement>('[data-slot="project-file-name"]')!
    await vi.waitFor(() => expect(document.activeElement).toBe(name))
    expect(save().disabled).toBe(true)
    await type(name, 'pdf')
    expect(editor.dataset.path).toBe('.claude/skills/pdf/SKILL.md')
    // The starting frontmatter follows the name while it is untouched.
    expect(content().value).toBe('---\nname: pdf\ndescription: \n---\n\n')
    await type(content(), '---\nname: pdf\ndescription: Fill PDF forms\n---\nUse the scripts.\n')
    save().click()
    await settle()
    expect(api.projectDefinitions.write).toHaveBeenCalledWith({
      params: { id: projectId(1) },
      body: { path: '.claude/skills/pdf/SKILL.md', expectedSha256: null, content: '---\nname: pdf\ndescription: Fill PDF forms\n---\nUse the scripts.\n' },
    })
    expect(events.saved).toHaveBeenCalledWith({ path: '.claude/skills/pdf/SKILL.md', pending: 0 })
  })

  it('switches a new file to the existing one after a conflict and Load from disk', async () => {
    api.projectDefinitions.write.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'The file changed on disk.', details: { reason: 'stale' } }))
    await mountEditor({ path: '.harness/agents/.md', kind: 'agent', name: null, create: true })
    const editor = byTestId(testIds.projectFileEditor)!
    await type(editor.querySelector<HTMLInputElement>('[data-slot="project-file-name"]')!, 'reviewer')
    await type(content(), '---\nname: reviewer\ndescription: New one\n---\nBody.\n')
    save().click()
    await settle()
    expect(byTestId(testIds.projectFileConflict)).not.toBeNull()
    api.projectDefinitions.read.mockResolvedValueOnce(projectDefinitionFile({ path: '.harness/agents/reviewer.md', sha256: trustSha(4) }))
    byTestId(testIds.projectFileReload)!.click()
    await settle()
    expect(api.projectDefinitions.read).toHaveBeenCalledWith({ params: { id: projectId(1) }, query: { path: '.harness/agents/reviewer.md' } })
    expect(editor.dataset).toMatchObject({ mode: 'edit', path: '.harness/agents/reviewer.md' })
    expect(editor.querySelector('[data-slot="project-file-name"]')).toBeNull()
    expect(content().value).toBe(projectDefinitionFile().content)
  })

  it('edits the mcpServers object of .mcp.json as JSON and refuses invalid JSON', async () => {
    api.projectDefinitions.read.mockResolvedValue(projectDefinitionFile({ path: '.mcp.json', kind: 'mcp', content: '{ "mcpServers": { "memory": { "command": "npx" } }, "other": true }', sha256: trustSha(3) }))
    api.projectDefinitions.write.mockResolvedValue(projectDefinitionWriteResult({ path: '.mcp.json', trust: { pending: 1 } }))
    const { events } = await mountEditor({ path: '.mcp.json', kind: 'mcp', name: null, create: false })
    const editor = byTestId(testIds.projectFileEditor)!
    expect(editor.dataset).toMatchObject({ kind: 'mcp', mode: 'edit' })
    expect(content().tagName).toBe('TEXTAREA')
    expect(JSON.parse(content().value)).toEqual({ memory: { command: 'npx' } })
    expect(editor.querySelector('[data-slot="project-file-summary"]')?.textContent).toContain('1 server')
    await type(content(), '{ "memory": ')
    expect(save().disabled).toBe(true)
    expect(editor.textContent).toContain('This isn\'t valid JSON.')
    await type(content(), '{ "memory": { "command": "npx" }, "docs": { "type": "http", "url": "https://mcp.example.test/mcp" } }')
    expect(editor.querySelector('[data-slot="project-file-summary"]')?.textContent).toContain('2 servers')
    save().click()
    await settle()
    expect(api.projectDefinitions.write).toHaveBeenCalledWith({
      params: { id: projectId(1) },
      body: { path: '.mcp.json', expectedSha256: trustSha(3), mcpServers: { memory: { command: 'npx' }, docs: { type: 'http', url: 'https://mcp.example.test/mcp' } } },
    })
    expect(events.saved).toHaveBeenCalledWith({ path: '.mcp.json', pending: 1 })
  })

  it('creates .mcp.json when it does not exist yet', async () => {
    api.projectDefinitions.read.mockResolvedValue(projectDefinitionFile({ path: '.mcp.json', kind: 'mcp', exists: false, content: null, sha256: null }))
    api.projectDefinitions.write.mockResolvedValue(projectDefinitionWriteResult({ path: '.mcp.json', created: true, trust: { pending: 1 } }))
    await mountEditor({ path: '.mcp.json', kind: 'mcp', name: null, create: true })
    const editor = byTestId(testIds.projectFileEditor)!
    expect(editor.dataset.mode).toBe('new')
    expect(editor.textContent).toContain('New .mcp.json in website')
    await type(content(), '{ "memory": { "command": "npx" } }')
    save().click()
    await settle()
    expect(api.projectDefinitions.write).toHaveBeenCalledWith({
      params: { id: projectId(1) },
      body: { path: '.mcp.json', expectedSha256: null, mcpServers: { memory: { command: 'npx' } } },
    })
  })
})
