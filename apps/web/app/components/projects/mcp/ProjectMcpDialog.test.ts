// The MCP servers of a project (docs/UI.md 7.33, 8.4, 14; W11.9-T4): the fetch on open, the rows with the commands of
// their trust items, Reconnect, Review… (the trust dialog on the server's item), the write-only variables (placeholders,
// Clear, Save variables with fresh auth, values never kept), the empty state, the errors and the event updates.
import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAuthStore } from '~/stores/auth'
import { useProjectMcpStore } from '~/stores/project-mcp'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import { authStatus, projectDefinitionFile, projectId, projectMcpList, projectMcpServer, projectSummary, projectTrustList, trustMcpItem, trustSha } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import ProjectFileEditor from '../../settings/customize/ProjectFileEditor.vue'
import ProjectMcpDialog from './ProjectMcpDialog.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

const P1 = projectId(1)

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let wrapper: VueWrapper | null = null

function twoServers() {
  return projectMcpList({
    items: [
      projectMcpServer({ state: 'connected', tools: ['mcp__memory__get'], missingVariables: [], shadows: 'memory' }),
      projectMcpServer({ id: 'docs', name: 'docs', transport: 'http', state: 'pending', sha256: trustSha(5), missingVariables: [] }),
    ],
    variables: [
      { name: 'MCP_TOKEN', set: true, hint: null, usedBy: ['memory'] },
      { name: 'DOCS_HOST', set: false, hint: 'docs.example.com', usedBy: ['docs'] },
      { name: 'DOCS_TOKEN', set: false, hint: null, usedBy: ['docs'] },
    ],
  })
}

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.toast.success.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
  useProjectsStore().items = [projectSummary()]
  api.projectTrust.list.mockResolvedValue(projectTrustList())
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  disposePinia(pinia)
})

async function mountDialog(list: ReturnType<typeof projectMcpList> | Error = twoServers(), focusServerId: string | null = null) {
  if (list instanceof Error)
    api.projectMcp.list.mockRejectedValueOnce(list)
  else
    api.projectMcp.list.mockResolvedValueOnce(list)
  const state = reactive({ open: true, projectId: P1 as string | null, focusServerId })
  const Host = defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(ProjectMcpDialog, { ...state, 'onUpdate:open': (value: boolean) => (state.open = value) }),
    }),
  })
  wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  await flushPromises()
  await nextTick()
  return state
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string, root: ParentNode = document.body): T | null {
  return root.querySelector<T>(`[data-testid="${id}"]`)
}

function row(serverId: string): HTMLElement {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.projectMcpServer}"]`)].find(element => element.dataset.serverId === serverId)!
}

function variable(name: string): HTMLElement {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.projectMcpVariable}"]`)].find(element => element.dataset.name === name)!
}

function input(name: string): HTMLInputElement {
  return variable(name).querySelector<HTMLInputElement>('input')!
}

async function type(element: HTMLInputElement, value: string) {
  element.value = value
  element.dispatchEvent(new Event('input'))
  await nextTick()
}

async function click(element: HTMLElement | null) {
  element!.click()
  await flushPromises()
  await nextTick()
}

function saveButton(): HTMLButtonElement {
  return byTestId<HTMLButtonElement>(testIds.projectMcpVariablesSave)!
}

describe('projectMcpDialog', () => {
  it('lists the servers with their state, command, shadow note and actions, and focuses the first toggle', async () => {
    await mountDialog()
    expect(api.projectMcp.list).toHaveBeenCalledWith({ params: { id: P1 } })
    expect(api.projectTrust.list).toHaveBeenCalledWith({ params: { id: P1 } })
    const dialog = byTestId(testIds.projectMcpDialog)!
    expect(dialog.textContent).toContain('MCP servers in Website')
    expect(dialog.textContent).toContain('From .mcp.json in the project folder. They run only in this project\'s chats, after you approve them.')
    expect(row('memory').dataset.state).toBe('connected')
    expect(row('memory').textContent).toContain('Connected · 1 tool')
    expect(row('memory').querySelector('[data-slot="project-mcp-command"]')!.textContent?.trim()).toBe('node tools/mcp-memory.mjs')
    expect(row('memory').textContent).toContain('Replaces your server memory in this project\'s chats.')
    expect(byTestId(testIds.projectMcpReconnect, row('memory'))).not.toBeNull()
    expect(row('docs').dataset.transport).toBe('http')
    expect(byTestId(testIds.projectMcpReview, row('docs'))).not.toBeNull()
    expect(document.activeElement).toBe(row('memory').querySelector('[data-action="toggle"]'))
  })

  it('opens on the focused server\'s row with its tools shown', async () => {
    await mountDialog(twoServers(), 'docs')
    expect(document.activeElement).toBe(row('docs').querySelector('[data-action="toggle"]'))
    expect(row('docs').querySelector('[data-action="toggle"]')!.getAttribute('aria-expanded')).toBe('true')
    await click(row('memory').querySelector<HTMLElement>('[data-action="toggle"]'))
    expect(row('memory').querySelector('[data-slot="project-mcp-tools"]')!.textContent).toContain('mcp__memory__get')
  })

  it('reconnects a server and shows a refusal', async () => {
    await mountDialog()
    api.projectMcp.reconnect.mockResolvedValueOnce(projectMcpServer({ state: 'connecting', missingVariables: [], shadows: 'memory' }))
    await click(byTestId(testIds.projectMcpReconnect, row('memory')))
    expect(api.projectMcp.reconnect).toHaveBeenCalledWith({ params: { id: P1, serverId: 'memory' } })
    expect(row('memory').dataset.state).toBe('connecting')

    useProjectMcpStore().applyEvent(createServerEvent('project-mcp.changed', { projectId: P1, servers: [projectMcpServer({ state: 'connected', tools: ['mcp__memory__get', 'mcp__memory__set'], missingVariables: [] })] }, 1))
    await nextTick()
    expect(row('memory').textContent).toContain('Connected · 2 tools')
    api.projectMcp.reconnect.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'Project MCP servers are off in safe mode.', details: { reason: 'disabled' } }))
    await click(byTestId(testIds.projectMcpReconnect, row('memory')))
    const alert = byTestId(testIds.projectMcpError)!
    expect(alert.dataset.code).toBe('conflict')
    expect(alert.textContent).toContain('Project MCP servers are off in safe mode.')
    expect(document.activeElement).toBe(alert)
  })

  it('opens the trust review on a pending server\'s item', async () => {
    api.projectTrust.list.mockResolvedValue(projectTrustList({ items: [trustMcpItem({ sha256: trustSha(5), label: 'docs', detail: { name: 'docs', id: 'docs', transport: 'http', url: 'http://127.0.0.1:9000/mcp', envNames: [], headerNames: [], variables: [] } })] }))
    await mountDialog()
    await click(byTestId(testIds.projectMcpReview, row('docs')))
    const trustDialog = byTestId(testIds.projectTrustDialog)!
    expect(trustDialog.textContent).toContain('Review Website')
    const items = [...trustDialog.querySelectorAll<HTMLElement>(`[data-testid="${testIds.projectTrustItem}"]`)]
    expect(items.map(element => element.dataset.key)).toEqual([trustSha(5)])
    expect(document.activeElement).toBe(byTestId(testIds.projectTrustSelect, items[0]))
  })

  it('shows the variables write-only with their placeholders and saves only what changed', async () => {
    await mountDialog()
    const section = byTestId(testIds.projectMcpVariables)!
    expect(section.dataset.count).toBe('3')
    expect(section.textContent).toContain('Variables · 3')
    expect(section.textContent).toContain('Values are encrypted on this server and used only for this project\'s servers. harness-forge never reads them from the server\'s environment.')
    expect(['MCP_TOKEN', 'DOCS_HOST', 'DOCS_TOKEN'].map(name => variable(name).dataset.state)).toEqual(['set', 'default', 'missing'])
    expect(input('MCP_TOKEN').type).toBe('password')
    expect(input('MCP_TOKEN').value).toBe('')
    expect(input('MCP_TOKEN').placeholder).toBe('•••• · stored')
    expect(input('MCP_TOKEN').getAttribute('aria-label')).toBe('MCP_TOKEN value')
    expect(input('DOCS_HOST').placeholder).toBe('Default: docs.example.com')
    expect(input('DOCS_TOKEN').placeholder).toBe('')
    expect(variable('DOCS_HOST').querySelector('[data-action="clear-variable"]')).toBeNull()

    // Nothing changed: Save variables does nothing (and keeps focus: aria-disabled, not disabled).
    expect(saveButton().getAttribute('aria-disabled')).toBe('true')
    expect(saveButton().disabled).toBe(false)
    await click(saveButton())
    expect(api.projectMcp.setVariables).not.toHaveBeenCalled()

    const clear = variable('MCP_TOKEN').querySelector<HTMLButtonElement>('[data-action="clear-variable"]')!
    expect(clear.getAttribute('aria-label')).toBe('Clear MCP_TOKEN')
    await click(clear)
    expect(clear.getAttribute('aria-pressed')).toBe('true')
    expect(input('MCP_TOKEN').placeholder).toBe('')
    await type(input('DOCS_TOKEN'), 's3cret-value')
    expect(saveButton().getAttribute('aria-disabled')).toBeNull()

    api.projectMcp.setVariables.mockResolvedValueOnce(projectMcpList({
      items: twoServers().items,
      variables: [
        { name: 'MCP_TOKEN', set: false, hint: null, usedBy: ['memory'] },
        { name: 'DOCS_HOST', set: false, hint: 'docs.example.com', usedBy: ['docs'] },
        { name: 'DOCS_TOKEN', set: true, hint: null, usedBy: ['docs'] },
      ],
    }))
    saveButton().focus()
    await click(saveButton())
    expect(api.projectMcp.setVariables).toHaveBeenCalledWith({ params: { id: P1 }, body: { values: { MCP_TOKEN: null, DOCS_TOKEN: 's3cret-value' } } })
    expect(mocks.toast.success).toHaveBeenCalledWith('Variables saved')
    expect(input('DOCS_TOKEN').value).toBe('')
    expect(input('DOCS_TOKEN').placeholder).toBe('•••• · stored')
    expect(variable('MCP_TOKEN').dataset.state).toBe('missing')
    expect(document.activeElement).toBe(saveButton())
    expect(document.body.innerHTML).not.toContain('s3cret-value')
  })

  it('asks for the password before saving variables when the session is not fresh', async () => {
    useAuthStore().status = authStatus({ enabled: true, authenticated: true, source: 'settings', freshUntil: null })
    await mountDialog()
    await type(input('DOCS_TOKEN'), 'value')
    await click(saveButton())
    expect(byTestId(testIds.confirmPasswordDialog)!.textContent).toContain('Saving the variables of this project\'s MCP servers needs your password.')
    expect(api.projectMcp.setVariables).not.toHaveBeenCalled()
  })

  it('shows a save failure inline', async () => {
    await mountDialog()
    await type(input('DOCS_TOKEN'), 'value')
    api.projectMcp.setVariables.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'A project can store up to 50 variables.', details: { reason: 'exists' } }))
    await click(saveButton())
    expect(byTestId(testIds.projectMcpError)!.textContent).toContain('A project can store up to 50 variables.')
    expect(input('DOCS_TOKEN').value).toBe('value')
  })

  it('shows the empty state and load errors with Retry, and closes', async () => {
    const state = await mountDialog(projectMcpList({ items: [], variables: [] }))
    expect(byTestId(testIds.projectMcpEmpty)!.textContent?.trim()).toBe('This project has no .mcp.json.')
    expect(byTestId(testIds.projectMcpVariables)).toBeNull()
    await click([...byTestId(testIds.projectMcpDialog)!.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Close')!)
    expect(state.open).toBe(false)
    wrapper!.unmount()
    wrapper = null
    document.body.replaceChildren()

    disposePinia(pinia)
    pinia = createPinia()
    setActivePinia(pinia)
    useProjectsStore().items = [projectSummary()]
    await mountDialog(new HarnessError({ code: 'internal_error', message: 'Could not read .mcp.json.' }))
    const alert = byTestId(testIds.projectMcpError)!
    expect(alert.dataset.code).toBe('internal_error')
    api.projectMcp.list.mockResolvedValueOnce(twoServers())
    await click([...alert.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Retry')!)
    expect(byTestId(testIds.projectMcpError)).toBeNull()
    expect(row('memory')).toBeDefined()
  })
})

describe('projectMcpDialog: Edit .mcp.json… (Phase 12, C46-T7)', () => {
  it('opens the project file editor on .mcp.json from the footer', async () => {
    api.projectDefinitions.read.mockResolvedValue(projectDefinitionFile({ path: '.mcp.json', kind: 'mcp', content: '{ "mcpServers": {} }' }))
    await mountDialog()
    const edit = byTestId(testIds.projectMcpDialog)!.querySelector<HTMLElement>('[data-action="edit-mcp-json"]')!
    expect(edit.textContent?.trim()).toBe('Edit .mcp.json…')
    edit.click()
    await flushPromises()
    await nextTick()
    expect(byTestId(testIds.projectFileEditor)?.dataset).toMatchObject({ kind: 'mcp', path: '.mcp.json', mode: 'edit' })
    expect(api.projectDefinitions.read).toHaveBeenCalledWith({ params: { id: P1 }, query: { path: '.mcp.json' } })
  })

  it('offers it in the empty state, where it creates the file', async () => {
    api.projectDefinitions.read.mockResolvedValue(projectDefinitionFile({ path: '.mcp.json', kind: 'mcp', exists: false, content: null, sha256: null }))
    await mountDialog(projectMcpList({ items: [], variables: [] }))
    expect(byTestId(testIds.projectMcpEmpty)).not.toBeNull()
    const edit = byTestId(testIds.projectMcpDialog)!.querySelectorAll<HTMLElement>('[data-action="edit-mcp-json"]')
    expect(edit).toHaveLength(1)
    edit[0]!.click()
    await flushPromises()
    await nextTick()
    expect(byTestId(testIds.projectFileEditor)?.dataset.mode).toBe('new')
  })
})

describe('projectMcpDialog: a saved .mcp.json (Phase 12, W12.13-T6)', () => {
  it('refetches its rows after a save: the new server stays pending until it is approved here', async () => {
    api.projectDefinitions.read.mockResolvedValue(projectDefinitionFile({ path: '.mcp.json', kind: 'mcp', exists: false, content: null, sha256: null }))
    await mountDialog(projectMcpList({ items: [], variables: [] }))
    await click(byTestId(testIds.projectMcpDialog)!.querySelector<HTMLElement>('[data-action="edit-mcp-json"]'))
    const editor = wrapper!.findComponent(ProjectFileEditor)
    expect(editor.props('entry')).toMatchObject({ path: '.mcp.json', kind: 'mcp', create: true })

    const pending = projectMcpServer({ id: 'docs', name: 'docs', transport: 'http', state: 'pending', sha256: trustSha(5), missingVariables: [], tools: [] })
    api.projectMcp.list.mockResolvedValueOnce(projectMcpList({ items: [pending], variables: [] }))
    api.projectTrust.list.mockResolvedValueOnce(projectTrustList({ items: [trustMcpItem({ sha256: trustSha(5), label: 'docs', detail: { name: 'docs', id: 'docs', transport: 'http', url: 'https://docs.example.com/mcp', envNames: [], headerNames: [], variables: [] } })] }))
    const listCalls = api.projectMcp.list.mock.calls.length
    const trustCalls = api.projectTrust.list.mock.calls.length
    editor.vm.$emit('saved', { path: '.mcp.json', pending: 1 })
    await flushPromises()
    await nextTick()
    expect(api.projectMcp.list.mock.calls.length).toBe(listCalls + 1)
    expect(api.projectTrust.list.mock.calls.length).toBe(trustCalls + 1)
    expect(byTestId(testIds.projectMcpEmpty)).toBeNull()
    expect(row('docs').dataset.state).toBe('pending')
    expect(row('docs').textContent).toContain('Needs approval')
    // No approval happened: the save never approves.
    expect(api.projectTrust.approve).not.toHaveBeenCalled()

    // Its Review… (from the editor) opens the trust dialog on the saved item.
    editor.vm.$emit('review', trustSha(5))
    await flushPromises()
    await nextTick()
    expect(byTestId(testIds.projectTrustDialog)).not.toBeNull()
  })
})
