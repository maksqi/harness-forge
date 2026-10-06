// Settings -> Customize (docs/UI.md 2.17, 9.12, 10.7, 14; W10.8-T2 … T6): the page frame, the catalog load (refresh)
// with its skeleton and error, the tabs with counts and the project select (both in the query), the source sections
// with the Built-in commands, and the row actions: edit, duplicate, copy to personal, view, export, turn off, delete
// with Undo, plus New and Import….
import type { VueWrapper } from '@vue/test-utils'
import type { ComputedRef } from 'vue'
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import CustomizePage from '~/pages/settings/customize.vue'
import { useCustomizationsStore } from '~/stores/customizations'
import { testIds } from '~/utils/testids'
import {
  agentCustomization,
  commandSummary,
  customizationEntry,
  customizationId,
  customizationList,
  projectId,
  projectSummary,
} from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import CustomizeSettings from './CustomizeSettings.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  useHead: vi.fn(),
  route: null as null | { path: string, query: Record<string, string | undefined> },
  router: { replace: vi.fn(), push: vi.fn() },
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), custom: vi.fn(), dismiss: vi.fn() }),
  downloadText: vi.fn(),
}))

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('~/components/settings/nuxt-imports', () => ({
  useHead: mocks.useHead,
  useRoute: () => mocks.route,
  useRouter: () => mocks.router,
}))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))
vi.mock('~/utils/download', () => ({ downloadText: mocks.downloadText }))

/** The body editor as a plain textarea (MarkdownEditor has its own test). */
const MarkdownEditorStub = defineComponent({
  props: { modelValue: { type: String, required: true }, label: { type: String, required: true } },
  emits: ['update:modelValue', 'submit'],
  setup: (props, { attrs }) => () => h('div', { 'data-slot': 'markdown-editor', ...attrs }, [h('textarea', { 'value': props.modelValue, 'aria-label': props.label })]),
})

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | null = null

const website = projectSummary({ id: projectId(1), name: 'website' })
const notes = projectSummary({ id: projectId(2), name: 'Notes', available: false, issue: 'The folder does not exist.' })
const mine = customizationEntry({ name: 'code-reviewer', source: 'user', id: customizationId(1), path: undefined })
const other = customizationEntry({ name: 'test-writer', source: 'user', id: customizationId(2), path: undefined })
const globalList = customizationList({ items: [...customizationList().items.filter(entry => entry.source === 'builtin'), mine, other], project: null })
const projectList = customizationList({
  items: [...globalList.items, customizationEntry()],
  project: { id: projectId(1), available: true, folders: ['.claude/agents', '.harness/agents', '.harness/commands'], scannedAt: 1 },
})

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.useHead.mockReset()
  mocks.route = reactive({ path: '/settings/customize', query: {} })
  mocks.router.push.mockReset()
  mocks.router.push.mockResolvedValue(undefined)
  mocks.router.replace.mockReset()
  mocks.router.replace.mockImplementation(async ({ query }: { query: Record<string, string | undefined> }) => {
    mocks.route!.query = query
  })
  for (const fn of [mocks.toast.success, mocks.toast.error, mocks.toast.custom, mocks.toast.dismiss, mocks.downloadText])
    fn.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
  api.projects.list.mockResolvedValue({ items: [website, notes] })
  api.customizations.list.mockImplementation(async ({ query }: { query: { projectId?: string } }) => (query.projectId === projectId(1) ? projectList : globalList))
  api.commands.list.mockResolvedValue({ items: [commandSummary({ name: 'compact', description: 'Summarize the conversation', source: 'harness', pluginId: 'core-agent' })] })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  disposePinia(pinia)
})

async function mountIn(component: object) {
  const Host = defineComponent({ setup: () => () => h(TooltipProvider, null, { default: () => h(component) }) })
  wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia], stubs: { MarkdownEditor: MarkdownEditorStub, SidebarTrigger: true } } })
  await flushPromises()
  await nextTick()
  return wrapper
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string, root: ParentNode = document.body): T | null {
  return root.querySelector<T>(`[data-testid="${id}"]`)
}

function allByTestId(id: string, root: ParentNode = document.body): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)]
}

function sections(): HTMLElement[] {
  return allByTestId(testIds.customizeSection)
}

function row(name: string): HTMLElement {
  return allByTestId(testIds.customizationRow).find(element => element.dataset.name === name)!
}

async function settle() {
  await flushPromises()
  await nextTick()
  await flushPromises()
}

async function chooseFromMenu(name: string, item: string) {
  byTestId(testIds.customizationRowMenu, row(name))!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await flushPromises()
  byTestId(item)!.click()
  await settle()
}

describe('settings customize page', () => {
  it('renders CustomizeSettings in the settings page frame with Import… and New {kind} following ?tab', async () => {
    await mountIn(CustomizePage)
    expect(byTestId(testIds.pageHeader)?.querySelector('h1')?.textContent).toBe('Customize')
    expect(byTestId(testIds.pageHeader)?.textContent).toContain('Sub-agents, slash commands and skills: yours, your projects\' and your plugins\'.')
    expect(byTestId(testIds.customizeSettings)).not.toBeNull()
    expect(byTestId(testIds.customizeImport)?.textContent?.trim()).toBe('Import…')
    const create = byTestId(testIds.customizeNew)!
    expect(create.textContent?.trim()).toBe('New agent')
    expect(create.dataset.kind).toBe('agent')
    const head = mocks.useHead.mock.calls[0]?.[0] as { title: ComputedRef<string> } | undefined
    expect(head?.title.value).toBe('Customize · harness-forge')

    mocks.route!.query = { tab: 'skills' }
    await settle()
    expect(byTestId(testIds.customizeNew)?.textContent?.trim()).toBe('New skill')
    byTestId(testIds.customizeNew)!.click()
    await settle()
    expect(byTestId(testIds.customizationEditor)?.dataset).toMatchObject({ kind: 'skill', mode: 'new' })
  })
})

describe('customizeSettings', () => {
  it('loads the global catalog with refresh and lists Personal and Built-in with the tab counts', async () => {
    await mountIn(CustomizeSettings)
    expect(api.customizations.list).toHaveBeenCalledWith({ query: { refresh: '1' } })
    expect(sections().map(section => [section.dataset.source, section.dataset.count])).toEqual([['user', '2'], ['builtin', '2']])
    expect(sections()[0]!.querySelector('h2')?.textContent?.trim()).toBe('Personal · 2')
    const tabs = allByTestId(testIds.customizeTab)
    expect(tabs.map(tab => [tab.dataset.value, tab.dataset.count, tab.dataset.state])).toEqual([
      ['agents', '4', 'active'],
      // /compact and the seven client commands (Phase 11 adds /output-style).
      ['commands', '8', 'inactive'],
      ['skills', '0', 'inactive'],
      // Phase 11 (ADR-051): the output styles tab.
      ['output-styles', '0', 'inactive'],
    ])
    expect(tabs[0]!.textContent?.replace(/\s+/g, ' ').trim()).toBe('Agents, 4')
    expect(byTestId(testIds.customizeProjectSelect)?.dataset.value).toBe('')
    expect(byTestId(testIds.customizeProjectSelect)?.textContent).toContain('No project')
  })

  it('switches tabs through ?tab and lists the built-in commands without a menu', async () => {
    await mountIn(CustomizeSettings)
    allByTestId(testIds.customizeTab)[1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    await settle()
    expect(mocks.router.replace).toHaveBeenLastCalledWith({ query: { tab: 'commands' } })
    const builtin = sections().find(section => section.dataset.source === 'builtin')!
    expect(allByTestId(testIds.customizationRow, builtin).map(element => element.dataset.name)).toEqual(['compact', 'effort', 'help', 'mode', 'model', 'new', 'output-style', 'remember'])
    expect(byTestId(testIds.customizationRowMenu, builtin)).toBeNull()
    expect(builtin.textContent).toContain('Summarize the conversation')
    const empty = byTestId(testIds.customizeEmpty)!
    expect(empty.dataset).toMatchObject({ kind: 'command', source: 'user' })
    expect(empty.querySelector('[data-action="new"]')?.textContent?.trim()).toBe('New command')
  })

  it('shows a project\'s definitions with its folders and writes the project to the query', async () => {
    await mountIn(CustomizeSettings)
    mocks.route!.query = { project: projectId(1) }
    await settle()
    expect(api.customizations.list).toHaveBeenLastCalledWith({ query: { projectId: projectId(1), refresh: '1' } })
    expect(api.commands.list).toHaveBeenLastCalledWith({ query: { projectId: projectId(1) } })
    expect(byTestId(testIds.customizeProjectSelect)?.dataset.value).toBe(projectId(1))
    expect(byTestId(testIds.customizeProjectSelect)?.textContent).toContain('website')
    expect(sections().map(section => section.dataset.source)).toEqual(['user', 'project', 'builtin'])
    const project = sections()[1]!
    expect(project.querySelector('h2')?.textContent?.trim()).toBe('In website · 1')
    expect(project.textContent).toContain('.claude/agents · .harness/agents')
    expect(project.textContent).not.toContain('.harness/commands')
  })

  it('shows the load error with Retry, and drops an unknown project from the query', async () => {
    api.customizations.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'The database is locked.' }))
    await mountIn(CustomizeSettings)
    const alert = document.body.querySelector<HTMLElement>('[data-slot="settings-load-error"]')!
    expect(alert.textContent).toContain('Could not load your customizations')
    expect(alert.textContent).toContain('The database is locked.')
    ;[...alert.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Retry')!.click()
    await settle()
    expect(document.body.querySelector('[data-slot="settings-load-error"]')).toBeNull()
    expect(sections()).toHaveLength(2)

    api.customizations.list.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Project not found.' }))
    mocks.route!.query = { project: projectId(9) }
    await settle()
    expect(mocks.router.replace).toHaveBeenLastCalledWith({ query: {} })
  })

  it('refetches the shown scope quietly when a customization changes', async () => {
    await mountIn(CustomizeSettings)
    const calls = api.customizations.list.mock.calls.length
    useCustomizationsStore().applyEvent(createServerEvent('customization.changed', { kind: 'agent', id: customizationId(3) }, 1))
    await settle()
    expect(api.customizations.list.mock.calls.length).toBeGreaterThan(calls)
    expect(api.customizations.list).toHaveBeenLastCalledWith({ query: {} })
  })

  it('edits, duplicates (a free name) and exports a personal definition', async () => {
    api.customizations.get.mockResolvedValue(agentCustomization({ id: customizationId(1), name: 'code-reviewer', content: '---\nname: code-reviewer\ndescription: Reviews\n---\nReview.\n', fields: { name: 'code-reviewer', description: 'Reviews', tools: null, model: null, instructions: 'Review.' } }))
    await mountIn(CustomizeSettings)
    await chooseFromMenu('code-reviewer', testIds.customizationEdit)
    expect(api.customizations.get).toHaveBeenCalledWith({ params: { id: customizationId(1) } })
    expect(byTestId(testIds.customizationEditor)?.dataset.mode).toBe('edit')
    expect(byTestId(testIds.customizationEditor)?.textContent).toContain('Edit code-reviewer')
    document.body.querySelector<HTMLElement>('[data-slot="sheet-close"]')!.click()
    await settle()

    await chooseFromMenu('code-reviewer', testIds.customizationDuplicate)
    expect(byTestId(testIds.customizationEditor)?.dataset.mode).toBe('new')
    expect(byTestId<HTMLInputElement>(testIds.customizationName)?.value).toBe('code-reviewer-copy')
    document.body.querySelector<HTMLElement>('[data-slot="sheet-close"]')!.click()
    await settle()
    // The copy has changes: confirm the discard.
    byTestId(testIds.customizationDiscardConfirm)?.click()
    await settle()

    await chooseFromMenu('code-reviewer', testIds.customizationExport)
    expect(mocks.downloadText).toHaveBeenCalledWith('---\nname: code-reviewer\ndescription: Reviews\n---\nReview.\n', 'code-reviewer.md', 'text/markdown')
  })

  it('views a project definition and copies it to personal in import mode', async () => {
    mocks.route!.query = { project: projectId(1) }
    api.customizations.source.mockResolvedValue({ content: '---\nname: reviewer\ndescription: Reviews a diff\n---\nReview.\n', path: '.harness/agents/reviewer.md' })
    await mountIn(CustomizeSettings)
    await chooseFromMenu('reviewer', testIds.customizationView)
    expect(byTestId(testIds.customizationViewer)?.dataset).toMatchObject({ kind: 'agent', source: 'project' })
    const copy = [...byTestId(testIds.customizationViewer)!.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Copy to personal')!
    copy.click()
    await settle()
    expect(byTestId(testIds.customizationViewer)).toBeNull()
    expect(byTestId(testIds.customizationEditor)?.dataset).toMatchObject({ kind: 'agent', mode: 'import' })
    expect(byTestId<HTMLInputElement>(testIds.customizationName)?.value).toBe('reviewer')

    document.body.querySelector<HTMLElement>('[data-slot="sheet-close"]')!.click()
    await settle()
    await chooseFromMenu('reviewer', testIds.customizationDuplicate)
    expect(api.customizations.source).toHaveBeenLastCalledWith({ query: { projectId: projectId(1), kind: 'agent', name: 'reviewer', source: 'project', path: '.harness/agents/reviewer.md' } })
    expect(byTestId(testIds.customizationEditor)?.dataset.mode).toBe('import')
  })

  it('turns a personal definition off at once', async () => {
    let resolve!: (value: unknown) => void
    api.customizations.update.mockReturnValue(new Promise((done) => {
      resolve = done
    }))
    await mountIn(CustomizeSettings)
    await chooseFromMenu('code-reviewer', testIds.customizationToggle)
    expect(api.customizations.update).toHaveBeenCalledWith({ params: { id: customizationId(1) }, body: { enabled: false } })
    expect(row('code-reviewer').dataset.state).toBe('off')
    expect(row('code-reviewer').getAttribute('aria-busy')).toBe('true')
    resolve(agentCustomization({ enabled: false }))
    await settle()
    expect(row('code-reviewer').getAttribute('aria-busy')).toBeNull()
  })

  it('deletes after the confirmation, moves focus to the next row and offers Undo, which re-creates it', async () => {
    const kept = agentCustomization({ id: customizationId(1), name: 'code-reviewer', content: '---\nname: code-reviewer\ndescription: Reviews\n---\nReview.\n' })
    api.customizations.get.mockResolvedValue(kept)
    api.customizations.remove.mockResolvedValue(undefined)
    await mountIn(CustomizeSettings)
    await chooseFromMenu('code-reviewer', testIds.customizationDelete)
    const dialog = document.body.querySelector<HTMLElement>('[data-slot="confirm-dialog"]')!
    expect(dialog.textContent).toContain('Delete code-reviewer?')
    expect(dialog.textContent).toContain('Chats that used it keep their messages. The agent can\'t start it anymore.')
    const confirm = byTestId(testIds.customizationDeleteConfirm)!
    expect(confirm.textContent?.trim()).toBe('Delete agent')

    api.customizations.list.mockResolvedValue({ ...globalList, items: globalList.items.filter(entry => entry.name !== 'code-reviewer') })
    confirm.click()
    await settle()
    expect(api.customizations.remove).toHaveBeenCalledWith({ params: { id: customizationId(1) } })
    expect(document.body.querySelector('[data-slot="confirm-dialog"]')).toBeNull()
    expect(document.activeElement).toBe(byTestId(testIds.customizationRowMenu, row('test-writer')))
    expect(mocks.toast.custom).toHaveBeenCalledTimes(1)
    const options = mocks.toast.custom.mock.calls[0]![1] as { duration: number, componentProps: { title: string, onUndo: () => void } }
    expect(options.duration).toBe(5000)
    expect(options.componentProps.title).toBe('Deleted code-reviewer')

    api.customizations.create.mockResolvedValue({ ...kept, id: customizationId(5) })
    api.customizations.list.mockResolvedValue(globalList)
    options.componentProps.onUndo()
    await settle()
    expect(api.customizations.create).toHaveBeenCalledWith({ body: { kind: 'agent', content: kept.content, enabled: true } })
  })

  it('imports a .md file into the editor with its notes and refuses files over 256 KB', async () => {
    const body = await mountIn(CustomizeSettings)
    const exposed = body.findComponent(CustomizeSettings).vm as unknown as { import: () => void }
    const input = byTestId<HTMLInputElement>(testIds.customizeImportInput)!
    expect(input.getAttribute('accept')).toBe('.md,text/markdown')
    const click = vi.spyOn(input, 'click').mockImplementation(() => {})
    exposed.import()
    expect(click).toHaveBeenCalledTimes(1)

    const file = new File(['---\nname: reviewer\ndescription: Reviews diffs\ncolor: blue\n---\nReview.\n'], 'reviewer.md', { type: 'text/markdown' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    input.dispatchEvent(new Event('change'))
    await settle()
    await vi.waitFor(() => expect(byTestId(testIds.customizationEditor)?.dataset.mode).toBe('import'))
    const notes = byTestId(testIds.customizationImportNotes)!
    expect(notes.textContent).toContain('Imported from reviewer.md. Check the fields, then save.')
    expect(notes.textContent).toContain('Ignored: color')
    expect(byTestId<HTMLInputElement>(testIds.customizationName)?.value).toBe('reviewer')
    document.body.querySelector<HTMLElement>('[data-slot="sheet-close"]')!.click()
    await settle()

    const huge = new File(['x'.repeat(256 * 1024 + 1)], 'huge.md')
    Object.defineProperty(input, 'files', { value: [huge], configurable: true })
    input.dispatchEvent(new Event('change'))
    await settle()
    expect(mocks.toast.error).toHaveBeenCalledWith('huge.md is too large', { description: 'Definition files can be up to 64 KB.' })
  })

  it('opens a plugin from its row', async () => {
    api.customizations.list.mockResolvedValue({ ...globalList, items: [...globalList.items, customizationEntry({ name: 'sql-expert', source: 'plugin', pluginId: 'db-tools', path: undefined })] })
    await mountIn(CustomizeSettings)
    byTestId(testIds.customizationRowMenu, row('sql-expert'))!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()
    document.body.querySelector<HTMLElement>('[data-action="open-plugin"]')!.click()
    await settle()
    expect(mocks.router.push).toHaveBeenCalledWith('/plugins/db-tools')
  })
})
