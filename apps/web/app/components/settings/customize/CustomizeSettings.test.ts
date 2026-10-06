// Settings -> Customize (docs/UI.md 2.17, 9.12, 10.7, 14; W10.8-T2 … T6): the page frame, the catalog load (refresh)
// with its skeleton and error, the tabs with counts and the project select (both in the query), the source sections
// with the Built-in commands, and the row actions: edit, duplicate, copy to personal, view, export, turn off, delete
// with Undo, plus New and Import…. Phase 11 (W11.8-T2, T6): the five tabs with the hooks count, the header buttons per
// tab, the Output styles tab (scope bar, default badges, Use by default) and the review of a project command.
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
  hookEntry,
  hookList,
  projectDefinitionFile,
  projectDefinitionWriteResult,
  projectId,
  projectSummary,
  projectTrustList,
  settings,
  styleEntry,
  trustCommandItem,
  trustSha,
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
  api.hooks.list.mockResolvedValue(hookList({ items: [hookEntry()], project: undefined }))
  api.settings.get.mockResolvedValue(settings())
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
    expect(byTestId(testIds.pageHeader)?.textContent).toContain('Agents, commands, skills, output styles and hooks: yours, your projects\' and your plugins\'.')
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
    document.body.querySelector<HTMLElement>('[data-slot="sheet-close"]')!.click()
    await settle()

    // Phase 11: the output styles and hooks tabs.
    mocks.route!.query = { tab: 'output-styles' }
    await settle()
    expect(byTestId(testIds.customizeNew)?.textContent?.trim()).toBe('New output style')
    expect(byTestId(testIds.customizeNew)?.dataset.kind).toBe('style')
    byTestId(testIds.customizeNew)!.click()
    await settle()
    expect(byTestId(testIds.customizationEditor)?.dataset).toMatchObject({ kind: 'style', mode: 'new' })
    expect(byTestId(testIds.customizationEditor)?.textContent).toContain('New output style')
    document.body.querySelector<HTMLElement>('[data-slot="sheet-close"]')!.click()
    await settle()

    mocks.route!.query = { tab: 'hooks' }
    await settle()
    expect(byTestId(testIds.customizeNew)?.textContent?.trim()).toBe('New hook')
    expect(byTestId(testIds.customizeNew)?.dataset.kind).toBe('hook')
    byTestId(testIds.customizeNew)!.click()
    await settle()
    expect(byTestId(testIds.hookEditor)?.dataset.mode).toBe('new')
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
      // Phase 11 (ADR-051): the output styles tab; (ADR-048) the hooks tab with the hooks of the scope.
      ['output-styles', '0', 'inactive'],
      ['hooks', '1', 'inactive'],
    ])
    expect(api.hooks.list).toHaveBeenCalledWith({ query: {} })
    expect(tabs[0]!.textContent?.replace(/\s+/g, ' ').trim()).toBe('Agents, 4')
    expect(byTestId(testIds.customizeProjectSelect)?.dataset.value).toBe('')
    expect(byTestId(testIds.customizeProjectSelect)?.textContent).toContain('No project')
  })

  it('renders HooksPanel on ?tab=hooks; New and Import… open the hook editor and the hook import (Phase 11)', async () => {
    mocks.route!.query = { tab: 'hooks' }
    const host = await mountIn(CustomizeSettings)
    expect(byTestId(testIds.customizeTab, document.body)).not.toBeNull()
    expect(allByTestId(testIds.customizeTab).find(tab => tab.dataset.value === 'hooks')?.dataset.state).toBe('active')
    expect(byTestId(testIds.hooksPanel)).not.toBeNull()
    expect(allByTestId(testIds.hooksSection).map(section => section.dataset.source)).toEqual(['personal'])
    const body = host.findComponent(CustomizeSettings).vm as unknown as { create: () => void, import: () => void }
    body.create()
    await settle()
    expect(byTestId(testIds.hookEditor)?.dataset.mode).toBe('new')
    expect(byTestId(testIds.customizationEditor)).toBeNull()
    body.import()
    await settle()
    expect(byTestId(testIds.hookImportDialog)).not.toBeNull()

    allByTestId(testIds.customizeTab)[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    await settle()
    expect(mocks.router.replace).toHaveBeenLastCalledWith({ query: { tab: 'agents' } })
  })

  it('opens the project trust dialog for the review action of a project row (Phase 11)', async () => {
    mocks.route!.query = { project: projectId(1) }
    const host = await mountIn(CustomizeSettings)
    expect(byTestId(testIds.projectTrustDialog)).toBeNull()
    host.findComponent({ name: 'CustomizationSection' }).vm.$emit('action', 'review', customizationEntry())
    await settle()
    expect(byTestId(testIds.projectTrustDialog)?.textContent).toContain('Review website')
  })

  it('marks a project command with pending `!` lines and reviews it focused on its item (Phase 11)', async () => {
    mocks.route!.query = { project: projectId(1), tab: 'commands' }
    const deploy = customizationEntry({ kind: 'command', name: 'deploy', description: 'Deploy', source: 'project', path: '.harness/commands/deploy.md', tools: undefined })
    api.customizations.list.mockResolvedValue({ ...projectList, items: [...projectList.items, deploy] })
    api.projectTrust.list.mockResolvedValue(projectTrustList({ items: [trustCommandItem({ state: 'pending', path: '.harness/commands/deploy.md', sha256: trustSha(4) })] }))
    const host = await mountIn(CustomizeSettings)
    expect(api.projectTrust.list).toHaveBeenCalledWith({ params: { id: projectId(1) } })
    const pending = row('deploy')
    expect(pending.querySelector('[data-slot="customization-needs-approval"]')?.textContent?.trim()).toBe('Needs approval')
    await chooseFromMenu('deploy', testIds.customizationReview)
    expect(byTestId(testIds.projectTrustDialog)).not.toBeNull()
    expect(host.findComponent({ name: 'ProjectTrustDialog' }).props('focusKey')).toBe(trustSha(4))
  })

  it('shows the output styles with the scope bar and the default badges, and uses a style by default (Phase 11)', async () => {
    const builtins = [
      styleEntry({ name: 'default', label: 'Default', description: 'The agent\'s usual replies.', source: 'builtin', path: undefined, keepCodingInstructions: true }),
      styleEntry({ name: 'explanatory', label: 'Explanatory', description: 'Explains its choices.', source: 'builtin', path: undefined, keepCodingInstructions: true }),
    ]
    const terse = styleEntry({ name: 'terse', label: 'Terse', source: 'user', id: customizationId(3), path: undefined, keepCodingInstructions: false })
    api.customizations.list.mockResolvedValue({ ...globalList, items: [...globalList.items, ...builtins, terse] })
    api.settings.update.mockImplementation(async ({ body }: { body: object }) => settings(body))
    mocks.route!.query = { tab: 'output-styles' }
    await mountIn(CustomizeSettings)
    expect(allByTestId(testIds.customizeTab).find(tab => tab.dataset.value === 'output-styles')?.dataset.count).toBe('3')
    const bar = byTestId(testIds.customizeStyleDefault)!
    expect(bar.dataset.value).toBe('default')
    expect(sections().map(section => section.dataset.source)).toEqual(['user', 'builtin'])
    const mine = row('terse')
    expect(mine.dataset.kind).toBe('style')
    expect(mine.textContent).toContain('Terse')
    expect(mine.textContent).toContain('Replaces coding instructions')
    expect(row('default').querySelector('[data-slot="style-default-badge"]')?.textContent?.trim()).toBe('Your default')
    expect(mine.querySelector('[data-slot="style-default-badge"]')).toBeNull()

    await chooseFromMenu('terse', testIds.customizationSetDefault)
    expect(api.settings.update).toHaveBeenCalledWith({ body: { outputStyle: 'terse' } })
    expect(row('terse').querySelector('[data-slot="style-default-badge"]')?.textContent?.trim()).toBe('Your default')
    expect(byTestId(testIds.customizeStyleDefault)?.dataset.value).toBe('terse')
  })

  it('sets a project\'s style from a row and badges it "Default in {project}" (Phase 11)', async () => {
    const terse = styleEntry({ name: 'terse', label: 'Terse' })
    api.customizations.list.mockImplementation(async ({ query }: { query: { projectId?: string } }) => (query.projectId === projectId(1)
      ? { ...projectList, items: [...projectList.items, terse], project: { ...projectList.project!, folders: ['.harness/output-styles'] } }
      : globalList))
    api.projects.update.mockImplementation(async ({ body }: { body: object }) => ({ ...website, ...body }))
    mocks.route!.query = { tab: 'output-styles', project: projectId(1) }
    await mountIn(CustomizeSettings)
    expect(byTestId(testIds.customizeStyleDefault)?.dataset.value).toBe('')
    expect(byTestId(testIds.customizeSettings)?.textContent).toContain('Style in website')
    const project = sections().find(section => section.dataset.source === 'project')!
    expect(project.textContent).toContain('.harness/output-styles')
    await chooseFromMenu('terse', testIds.customizationSetDefault)
    expect(api.projects.update).toHaveBeenCalledWith({ params: { id: projectId(1) }, body: { outputStyle: 'terse' } })
    expect(row('terse').querySelector('[data-slot="style-default-badge"]')?.textContent?.trim()).toBe('Default in website')
  })

  it('scrolls the tab row so the active tab shows whole: on load, on a tab change (W11.19)', async () => {
    // A 390 px screen: the row shows 0 … 358 px of the tabs (472 px wide in all); a tab's box moves with the row's scroll.
    const widths: Record<string, [number, number]> = { 'agents': [0, 84], 'commands': [84, 187], 'skills': [187, 264], 'output-styles': [264, 391], 'hooks': [391, 472] }
    const box = (left: number, right: number) => ({ left, right, x: left, width: right - left, top: 0, bottom: 36, y: 0, height: 36, toJSON: () => ({}) }) as DOMRect
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.querySelector(':scope > [role="tablist"]'))
        return box(0, 358)
      const span = this.getAttribute('role') === 'tab' ? widths[this.dataset.value ?? ''] : undefined
      const scroll = this.closest('[role="tablist"]')?.parentElement?.scrollLeft ?? 0
      return span ? box(span[0] - scroll, span[1] - scroll) : box(0, 0)
    })
    try {
      mocks.route!.query = { tab: 'hooks' }
      await mountIn(CustomizeSettings)
      const row = document.body.querySelector<HTMLElement>('[role="tablist"]')!.parentElement!
      // The end of Hooks (472) plus the inset (16) at the end of the row (358).
      expect(row.scrollLeft).toBe(472 + 16 - 358)

      // Commands is cut off at the start now: the row scrolls back to it.
      mocks.route!.query = { tab: 'commands' }
      await settle()
      expect(row.scrollLeft).toBe(84 - 16)
      // Skills lies inside the visible part: nothing moves.
      mocks.route!.query = { tab: 'skills' }
      await settle()
      expect(row.scrollLeft).toBe(84 - 16)
    }
    finally {
      spy.mockRestore()
    }
  })

  it('lets the Project select wrap below the tabs instead of squeezing the tab row (W11.19)', async () => {
    await mountIn(CustomizeSettings)
    const row = document.body.querySelector<HTMLElement>('[role="tablist"]')!.parentElement!
    expect(row.classList).toContain('overflow-x-auto')
    // One wrapping line: the tabs keep their width and the Project select takes the next line when both do not fit.
    expect(row.parentElement!.classList).toContain('flex-wrap')
    const project = byTestId(testIds.customizeProjectSelect)!.parentElement!
    expect([...row.parentElement!.children]).toEqual([row, project])
    expect(project.classList).toContain('w-full')
    expect(project.classList).toContain('sm:w-auto')
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

    // Phase 12: `color` is read now (ADR-058); `effort` is still ignored.
    const file = new File(['---\nname: reviewer\ndescription: Reviews diffs\neffort: high\n---\nReview.\n'], 'reviewer.md', { type: 'text/markdown' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    input.dispatchEvent(new Event('change'))
    await settle()
    await vi.waitFor(() => expect(byTestId(testIds.customizationEditor)?.dataset.mode).toBe('import'))
    const notes = byTestId(testIds.customizationImportNotes)!
    expect(notes.textContent).toContain('Imported from reviewer.md. Check the fields, then save.')
    expect(notes.textContent).toContain('Ignored: effort')
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

describe('customize: Claude Code import and project files (Phase 12, C46-T7)', () => {
  it('opens the import dialog from the header and from ?import=claude, and drops the query on close', async () => {
    api.claudeImport.home.mockResolvedValue({ available: false, reason: 'disabled', path: null })
    await mountIn(CustomizePage)
    expect(byTestId(testIds.claudeImportDialog)).toBeNull()
    expect(byTestId(testIds.customizeImportClaude)?.textContent?.trim()).toBe('Import from Claude Code…')
    byTestId(testIds.customizeImportClaude)!.click()
    await settle()
    expect(byTestId(testIds.claudeImportDialog)?.dataset.step).toBe('source')
    document.body.querySelector<HTMLElement>('[data-slot="dialog-close"]')!.click()
    await settle()
    expect(byTestId(testIds.claudeImportDialog)).toBeNull()

    mocks.route!.query = { import: 'claude', tab: 'skills' }
    await settle()
    expect(byTestId(testIds.claudeImportDialog)).not.toBeNull()
    document.body.querySelector<HTMLElement>('[data-slot="dialog-close"]')!.click()
    await settle()
    expect(mocks.router.replace).toHaveBeenLastCalledWith({ query: { tab: 'skills' } })

    mocks.route!.query = { import: 'other' }
    await settle()
    expect(byTestId(testIds.claudeImportDialog)).toBeNull()
    expect(mocks.router.replace).toHaveBeenLastCalledWith({ query: {} })
  })

  it('edits a project definition file from its row and from the viewer', async () => {
    mocks.route!.query = { project: projectId(1) }
    api.projectDefinitions.read.mockResolvedValue(projectDefinitionFile({ path: '.harness/agents/reviewer.md' }))
    api.projectDefinitions.write.mockResolvedValue(projectDefinitionWriteResult({ path: '.harness/agents/reviewer.md', trust: { pending: 0 } }))
    await mountIn(CustomizeSettings)
    const reviewer = allByTestId(testIds.customizationRow).find(element => element.dataset.name === 'reviewer' && element.dataset.source === 'project')!
    byTestId(testIds.customizationRowMenu, reviewer)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()
    const edit = byTestId(testIds.customizationEdit)!
    expect(edit.dataset.source).toBe('project')
    edit.click()
    await settle()
    expect(byTestId(testIds.projectFileEditor)?.dataset).toMatchObject({ kind: 'agent', path: '.harness/agents/reviewer.md', mode: 'edit' })
    expect(api.projectDefinitions.read).toHaveBeenCalledWith({ params: { id: projectId(1) }, query: { path: '.harness/agents/reviewer.md' } })
    byTestId(testIds.projectFileSave)!.click()
    await settle()
    expect(api.projectDefinitions.write).toHaveBeenCalledTimes(1)
    expect(byTestId(testIds.projectFileEditor)).toBeNull()

    api.customizations.source.mockResolvedValue({ content: '---\nname: reviewer\ndescription: Reviews a diff\n---\nReview.\n', path: '.harness/agents/reviewer.md' })
    await chooseFromMenu('reviewer', testIds.customizationView)
    const viewerEdit = byTestId(testIds.customizationViewer)!.querySelector<HTMLElement>('[data-action="edit"]')!
    viewerEdit.click()
    await settle()
    expect(byTestId(testIds.customizationViewer)).toBeNull()
    expect(byTestId(testIds.projectFileEditor)?.dataset.path).toBe('.harness/agents/reviewer.md')
  })
})
