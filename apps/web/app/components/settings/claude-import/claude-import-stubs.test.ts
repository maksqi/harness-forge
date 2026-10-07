// The components of the Import from Claude Code dialog (Phase 12, ADR-055; docs/UI.md 9.14, 10.9; C46-T3, W12.10): one mount
// per component (root test id, props accepted, emits) and the wizard's happy path. The behavior is covered by
// ClaudeImportDialog.test.ts and ClaudeImportPreview.test.ts.
import type { MockApi } from '~/utils/testing/mock-api'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAuthStore } from '~/stores/auth'
import { testIds } from '~/utils/testids'
import {
  authStatus,
  claudeImportApplyResult,
  claudeImportHome,
  claudeImportItem,
  claudeImportPlan,
  settings,
} from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { defaultSelection, groupsOf } from './claude-import'
import ClaudeImportDialog from './ClaudeImportDialog.vue'
import ClaudeImportGroup from './ClaudeImportGroup.vue'
import ClaudeImportItem from './ClaudeImportItem.vue'
import ClaudeImportPreview from './ClaudeImportPreview.vue'
import ClaudeImportResult from './ClaudeImportResult.vue'
import ClaudeImportSource from './ClaudeImportSource.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))
vi.mock('~/components/settings/nuxt-imports', () => ({ useRoute: () => ({ path: '/settings/customize', query: {} }), useRouter: () => ({ push: async () => {}, replace: async () => {} }) }))

let api: MockApi
let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.status = authStatus()
  auth.loaded = true
})

afterEach(() => {
  document.body.replaceChildren()
  disposePinia(pinia)
})

function render(component: object, props: Record<string, unknown>) {
  return mount(defineComponent({ setup: () => () => h(TooltipProvider, null, { default: () => h(component, props) }) }), { attachTo: document.body, global: { plugins: [pinia] } })
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)
}

function allByTestId(id: string): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)]
}

async function settle() {
  await flushPromises()
  await nextTick()
  await flushPromises()
}

/** Picks files in the folder input as a browser would (`webkitRelativePath` under the picked folder). */
function pickFolder(input: HTMLInputElement, paths: string[]) {
  const files = paths.map((path) => {
    const file = new File(['x'], path.split('/').at(-1)!)
    Object.defineProperty(file, 'webkitRelativePath', { value: `.claude/${path}` })
    return file
  })
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('claude import components (mounts)', () => {
  it('claudeImportSource offers the three sources, filters a picked folder and states the server scan', async () => {
    const folder = vi.fn()
    render(ClaudeImportSource, { busy: false, serverHome: claudeImportHome({ available: false, reason: 'disabled', path: null }), onFolder: folder })
    expect(allByTestId(testIds.claudeImportSource).map(radio => radio.dataset.value)).toEqual(['folder', 'zip', 'server'])
    expect(byTestId(testIds.claudeImportScan)?.dataset.state).toBe('disabled')
    expect(byTestId(testIds.claudeImportZipInput)).not.toBeNull()
    expect(byTestId(testIds.claudeImportConfigInput)).not.toBeNull()
    pickFolder(byTestId<HTMLInputElement>(testIds.claudeImportFolderInput)!, ['agents/reviewer.md', '.credentials.json', 'projects/x/s.jsonl'])
    await settle()
    const [files, claudeJson] = folder.mock.calls[0]!
    expect((files as File[]).map(file => file.name)).toEqual(['agents/reviewer.md'])
    expect(claudeJson).toBeNull()
  })

  it('claudeImportPreview renders the groups and the CLAUDE.md mode', () => {
    const plan = claudeImportPlan({ items: [...claudeImportPlan().items, claudeImportItem({ key: 'instructions:1', kind: 'instructions', name: 'CLAUDE.md', actions: ['append', 'replace', 'skip'], defaultAction: 'append' })] })
    render(ClaudeImportPreview, { plan, selection: defaultSelection(plan) })
    expect(byTestId(testIds.claudeImportPreview)?.dataset.count).toBe('3')
    expect(allByTestId(testIds.claudeImportGroup).map(group => group.dataset.kind)).toEqual(['agent', 'hook', 'instructions'])
    expect(byTestId(testIds.claudeImportInstructionsMode)?.dataset.value).toBe('append')
  })

  it('claudeImportGroup selects all and reports its state', async () => {
    const plan = claudeImportPlan()
    const update = vi.fn()
    render(ClaudeImportGroup, { 'group': groupsOf(plan)[0], 'selection': { items: {}, instructions: 'append' }, 'onUpdate:selection': update })
    const group = byTestId(testIds.claudeImportGroup)!
    expect(group.dataset).toMatchObject({ kind: 'agent', count: '1' })
    const all = byTestId(testIds.claudeImportSelectAll)!
    expect(all.dataset.state).toBe('unchecked')
    all.click()
    await settle()
    expect(update).toHaveBeenCalledWith({ items: { 'agent:reviewer:agents/reviewer.md': { action: 'import' } }, instructions: 'append' })
  })

  it('claudeImportItem renders its attributes and emits its choice', async () => {
    const update = vi.fn()
    render(ClaudeImportItem, { 'item': claudeImportItem({ status: 'conflict', actions: ['skip', 'rename'], defaultAction: 'skip', renameTo: 'reviewer-2' }), 'choice': null, 'onUpdate:choice': update })
    expect(byTestId(testIds.claudeImportItem)?.dataset).toMatchObject({ kind: 'agent', status: 'conflict', name: 'reviewer' })
    expect(byTestId(testIds.claudeImportItem)?.textContent).toContain('Conflict')
    const resolution = byTestId<HTMLSelectElement>(testIds.claudeImportResolution)!
    resolution.value = 'rename'
    resolution.dispatchEvent(new Event('change', { bubbles: true }))
    expect(update).toHaveBeenCalledWith({ action: 'rename', renameTo: 'reviewer-2' })
    byTestId(testIds.claudeImportSelect)!.click()
    await settle()
    expect(update).toHaveBeenLastCalledWith({ action: 'rename', renameTo: 'reviewer-2' })
  })

  it('claudeImportResult lists the result lines', () => {
    render(ClaudeImportResult, { result: claudeImportApplyResult() })
    expect(byTestId(testIds.claudeImportResult)?.dataset.count).toBe('2')
    expect(byTestId(testIds.claudeImportResult)?.textContent).toContain('Imported 2 items')
  })

  it('claudeImportDialog walks source, preview and result', async () => {
    api.claudeImport.home.mockResolvedValue(claudeImportHome())
    api.claudeImport.upload.mockResolvedValue(claudeImportPlan())
    api.claudeImport.apply.mockResolvedValue(claudeImportApplyResult())
    api.settings.get.mockResolvedValue(settings())
    const imported = vi.fn()
    render(ClaudeImportDialog, { open: true, onImported: imported })
    await settle()
    expect(byTestId(testIds.claudeImportDialog)?.dataset.step).toBe('source')
    expect(byTestId(testIds.claudeImportScan)?.dataset.state).toBe('available')
    expect(byTestId<HTMLButtonElement>(testIds.claudeImportContinue)!.disabled).toBe(true)
    pickFolder(byTestId<HTMLInputElement>(testIds.claudeImportFolderInput)!, ['agents/reviewer.md', 'settings.json'])
    await settle()
    byTestId(testIds.claudeImportContinue)!.click()
    await settle()
    expect(api.claudeImport.upload).toHaveBeenCalledTimes(1)
    expect(byTestId(testIds.claudeImportDialog)?.dataset.step).toBe('preview')
    const submit = byTestId(testIds.claudeImportSubmit)!
    expect(submit.dataset.count).toBe('2')
    submit.click()
    await settle()
    expect(api.claudeImport.apply).toHaveBeenCalledTimes(1)
    expect(byTestId(testIds.claudeImportDialog)?.dataset.step).toBe('result')
    expect(imported).toHaveBeenCalledWith(claudeImportApplyResult())
  })
})
