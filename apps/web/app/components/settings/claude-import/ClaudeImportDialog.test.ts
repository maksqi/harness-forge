// The Import from Claude Code dialog (Phase 12, ADR-055; docs/UI.md 2.19, 9.14, 14; W12.10-T2): the three steps with the
// step heading taking focus, the sources (a filtered folder, a zip, the server scan with its reasons), the password
// prompts of the scan and the apply, the footer's executables line, the expired plan, the discard question on step 2,
// the result's turned-off lines and actions, and the stores refetched after an apply.
import type { ClaudeImportApplyResult, ClaudeImportPlan } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAuthStore } from '~/stores/auth'
import { useCustomizationsStore } from '~/stores/customizations'
import { useHooksStore } from '~/stores/hooks'
import { useSettingsStore } from '~/stores/settings'
import { useShellRulesStore } from '~/stores/shell-rules'
import { testIds } from '~/utils/testids'
import { authStatus, claudeImportApplyResult, claudeImportHome, claudeImportItem, claudeImportPlan, importPlanId, settings } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import ClaudeImportDialog from './ClaudeImportDialog.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  route: { path: '/settings/customize', query: { import: 'claude', project: 'prj_1' } as Record<string, string> },
  router: { push: vi.fn(async () => {}), replace: vi.fn(async () => {}) },
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('~/components/settings/nuxt-imports', () => ({ useRoute: () => mocks.route, useRouter: () => mocks.router }))

const AGENT_KEY = 'agent:reviewer:agents/reviewer.md'
const HOOK_KEY = 'hook:PostToolUse:settings.json:0:0'
const SERVER_KEY = 'mcp-server:github:.claude.json'

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let openChanges: boolean[]
let imported: ClaudeImportApplyResult[]

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.router.push.mockClear()
  pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.status = authStatus()
  auth.loaded = true
  api.claudeImport.home.mockResolvedValue(claudeImportHome())
  api.settings.get.mockResolvedValue(settings())
  openChanges = []
  imported = []
})

afterEach(() => {
  document.body.replaceChildren()
  disposePinia(pinia)
})

/** Mounts the dialog open, owned like the page owns it (closing sets `open` false). */
async function render() {
  const open = ref(true)
  const wrapper = mount(defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(ClaudeImportDialog, {
        'open': open.value,
        'onUpdate:open': (value: boolean) => {
          openChanges.push(value)
          open.value = value
        },
        'onImported': (result: ClaudeImportApplyResult) => imported.push(result),
      }),
    }),
  }), { attachTo: document.body, global: { plugins: [pinia] } })
  await settle()
  return { wrapper, open }
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string, root: ParentNode = document.body): T | null {
  return root.querySelector<T>(`[data-testid="${id}"]`)
}

function allByTestId(id: string): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)]
}

function dialog(): HTMLElement | null {
  return byTestId(testIds.claudeImportDialog)
}

function step(): string | undefined {
  return dialog()?.dataset.step
}

function heading(): HTMLElement {
  return dialog()!.querySelector<HTMLElement>('[data-slot="claude-import-step"]')!
}

function source(value: string): HTMLElement {
  return allByTestId(testIds.claudeImportSource).find(element => element.dataset.value === value)!
}

function action(name: string): HTMLButtonElement | null {
  return dialog()!.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)
}

async function settle() {
  await flushPromises()
  await nextTick()
  await flushPromises()
}

/** Picks files in the folder input as a browser would (`webkitRelativePath` under the picked folder). */
async function pickFolder(paths: string[]) {
  const input = byTestId<HTMLInputElement>(testIds.claudeImportFolderInput)!
  const files = paths.map((path) => {
    const file = new File(['x'], path.split('/').at(-1)!)
    Object.defineProperty(file, 'webkitRelativePath', { value: `.claude/${path}` })
    return file
  })
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
}

async function pickFile(id: string, file: File) {
  const input = byTestId<HTMLInputElement>(id)!
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
}

async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull()
  element!.click()
  await settle()
}

async function submitPassword(password = 'correct-horse') {
  const input = byTestId<HTMLInputElement>(testIds.confirmPasswordInput)!
  input.value = password
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  await click(byTestId(testIds.confirmPasswordSubmit))
}

function needsPassword() {
  useAuthStore().status = authStatus({ enabled: true, source: 'settings', freshUntil: null })
  api.auth.login.mockResolvedValue(authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() + 600_000 }))
}

function plan(overrides: Partial<ClaudeImportPlan> = {}): ClaudeImportPlan {
  return claudeImportPlan(overrides)
}

async function toPreview(next: ClaudeImportPlan = plan()) {
  api.claudeImport.upload.mockResolvedValue(next)
  await pickFolder(['agents/reviewer.md', 'settings.json'])
  await click(byTestId(testIds.claudeImportContinue))
  expect(step()).toBe('preview')
}

describe('claudeImportDialog', () => {
  it('walks the three steps and moves focus to the step heading each time', async () => {
    await render()
    expect(dialog()?.getAttribute('role')).toBe('dialog')
    expect(step()).toBe('source')
    expect(heading().textContent?.replace(/\s+/g, ' ').trim()).toBe('Step 1 of 3 · Choose what to read')
    expect(document.activeElement).toBe(heading())
    expect(dialog()!.textContent).toContain('Only agents, commands, skills, output styles, settings.json, CLAUDE.md and the mcpServers of .claude.json are read.')
    expect(byTestId<HTMLButtonElement>(testIds.claudeImportContinue)!.disabled).toBe(true)

    await toPreview()
    expect(api.claudeImport.upload).toHaveBeenCalledTimes(1)
    expect(heading().textContent).toContain('Step 2 of 3')
    expect(document.activeElement).toBe(heading())
    const submit = byTestId<HTMLButtonElement>(testIds.claudeImportSubmit)!
    expect(submit.textContent?.trim()).toBe('Import 2 items')
    expect(submit.type).toBe('button')

    api.claudeImport.apply.mockResolvedValue(claudeImportApplyResult())
    await click(submit)
    expect(step()).toBe('result')
    expect(heading().textContent).toContain('Step 3 of 3')
    expect(document.activeElement).toBe(heading())
    expect(imported).toHaveLength(1)
  })

  it('keeps only allowlisted files of a folder and says when nothing matches', async () => {
    await render()
    await pickFolder(['.credentials.json', 'projects/x/session.jsonl', 'history.jsonl'])
    expect(dialog()!.textContent).toContain('Nothing to import in this folder.')
    expect(byTestId<HTMLButtonElement>(testIds.claudeImportContinue)!.disabled).toBe(true)

    await pickFolder(['agents/reviewer.md', '.credentials.json', 'settings.local.json'])
    expect(dialog()!.textContent).toContain('1 file picked')
    await pickFile(testIds.claudeImportConfigInput, new File(['{}'], 'claude.json'))
    expect(dialog()!.textContent).toContain('.claude.json added')
    api.claudeImport.upload.mockResolvedValue(plan())
    await click(byTestId(testIds.claudeImportContinue))
    const form = api.claudeImport.upload.mock.calls[0]![0].form as FormData
    expect((form.getAll('files') as File[]).map(file => file.name)).toEqual(['agents/reviewer.md'])
    expect((form.get('claudeJson') as File).name).toBe('.claude.json')
  })

  it('uploads a zip, and shows a 413 inline', async () => {
    await render()
    await click(source('zip'))
    expect(source('zip').getAttribute('aria-checked')).toBe('true')
    expect(byTestId<HTMLButtonElement>(testIds.claudeImportContinue)!.disabled).toBe(true)
    await pickFile(testIds.claudeImportZipInput, new File(['PK'], 'claude.zip'))
    expect(dialog()!.textContent).toContain('claude.zip')
    api.claudeImport.upload.mockRejectedValue(new HarnessError({ code: 'payload_too_large', message: 'Request body too large.' }))
    await click(byTestId(testIds.claudeImportContinue))
    const error = byTestId(testIds.claudeImportError)!
    expect(error.dataset.code).toBe('payload_too_large')
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent?.trim()).toBe('The upload is larger than 32 MiB.')
    expect((api.claudeImport.upload.mock.calls[0]![0].form as FormData).get('file')).toBeInstanceOf(File)
    expect(step()).toBe('source')
  })

  it.each([
    [{ available: false, reason: 'disabled' as const, path: null }, 'disabled', 'Scanning is turned off on this server (HF_CLAUDE_HOME=0).'],
    [{ available: false, reason: 'missing' as const, path: '/home/ada/.claude' }, 'missing', 'There is no .claude folder at /home/ada/.claude.'],
    [{ available: false, reason: 'unreadable' as const, path: '/home/ada/.claude' }, 'unreadable', 'harness-forge can\'t read /home/ada/.claude.'],
  ])('disables the server scan with its reason (%#)', async (home, state, text) => {
    api.claudeImport.home.mockResolvedValue(home)
    await render()
    const scan = byTestId(testIds.claudeImportScan)!
    expect(scan.dataset.state).toBe(state)
    expect(scan.textContent?.trim()).toBe(text)
    expect(source('server').hasAttribute('disabled') || source('server').dataset.disabled !== undefined).toBe(true)
    expect(source('server').getAttribute('aria-describedby')).toBe(scan.id)
  })

  it('scans the server after the password prompt', async () => {
    needsPassword()
    api.claudeImport.scan.mockResolvedValue(plan({ source: 'scan', root: '/home/ada/.claude' }))
    await render()
    expect(source('server').textContent).toContain('Scan /home/ada/.claude on this server')
    await click(source('server'))
    await click(byTestId(testIds.claudeImportContinue))
    expect(byTestId(testIds.confirmPasswordDialog)?.textContent).toContain('Scanning this server\'s Claude Code folder needs your password.')
    expect(api.claudeImport.scan).not.toHaveBeenCalled()
    await submitPassword()
    expect(api.claudeImport.scan).toHaveBeenCalledTimes(1)
    expect(step()).toBe('preview')
  })

  it('shows a scan that the server turned off', async () => {
    api.claudeImport.scan.mockRejectedValue(new HarnessError({ code: 'conflict', message: 'Disabled.', details: { reason: 'disabled' } }))
    await render()
    await click(source('server'))
    await click(byTestId(testIds.claudeImportContinue))
    expect(byTestId(testIds.claudeImportError)?.textContent?.trim()).toBe('Scanning is turned off on this server (HF_CLAUDE_HOME=0).')
  })

  it('asks for the password with the executables text, imports and reports what stayed off', async () => {
    needsPassword()
    const customizations = vi.spyOn(useCustomizationsStore(), 'refreshLoaded').mockResolvedValue()
    const hooks = vi.spyOn(useHooksStore(), 'refreshLoaded').mockResolvedValue()
    const settingsFetch = vi.spyOn(useSettingsStore(), 'fetch').mockResolvedValue(settings())
    const shellRules = useShellRulesStore()
    shellRules.loaded = true
    const rules = vi.spyOn(shellRules, 'fetchAll').mockResolvedValue()
    await render()
    await toPreview()
    expect(dialog()!.querySelector('[data-slot="claude-import-executables"]')?.textContent?.trim()).toBe('Includes 1 item that runs commands on this server.')
    const result = claudeImportApplyResult({
      results: [{ key: AGENT_KEY, outcome: 'created', id: 'cus_1' }, { key: HOOK_KEY, outcome: 'created', id: 'hok_1' }],
      counts: { created: 2, updated: 0, unchanged: 0, skipped: 0, failed: 0 },
      warnings: ['The style terse is not installed.', '1 command hook was imported turned off.'],
    })
    api.claudeImport.apply.mockResolvedValue(result)
    await click(byTestId(testIds.claudeImportSubmit))
    expect(byTestId(testIds.confirmPasswordDialog)?.textContent).toContain('Importing hooks and commands that run on this server needs your password.')
    await submitPassword()
    expect(api.claudeImport.apply).toHaveBeenCalledWith({ body: { planId: importPlanId(1), items: [{ key: AGENT_KEY, action: 'import' }, { key: HOOK_KEY, action: 'import' }], instructions: 'append' } })
    expect(step()).toBe('result')
    const panel = byTestId(testIds.claudeImportResult)!
    expect(panel.dataset.count).toBe('2')
    expect(panel.querySelector('[role="status"]')?.textContent?.trim()).toBe('Imported 2 items')
    expect([...panel.querySelectorAll('[data-slot="claude-import-turned-off"]')].map(line => line.textContent?.trim())).toEqual(['1 command turned off (it runs shell lines)'])
    // W12.17: every server warning shows as it is (the server sends no per-item turned-off sentence, nothing is
    // filtered), after the dialog's own turned-off line.
    const lines = [...panel.querySelectorAll('p')].map(line => line.textContent?.trim())
    expect(lines).toEqual(['Imported 2 items', '1 command turned off (it runs shell lines)', 'The style terse is not installed.', '1 command hook was imported turned off.'])
    expect(customizations).toHaveBeenCalledTimes(1)
    expect(hooks).toHaveBeenCalledTimes(1)
    expect(settingsFetch).toHaveBeenCalledTimes(1)
    expect(rules).toHaveBeenCalledTimes(1)
    expect(imported).toEqual([result])
    expect(action('open-mcp')).toBeNull()

    await click(action('open-customize'))
    expect(openChanges).toEqual([false])
    expect(mocks.router.push).toHaveBeenCalledWith({ path: '/settings/customize', query: { project: 'prj_1', tab: 'agents' } })
  })

  it('uses the plain prompt without executables, sends the enable flag and links to the MCP servers', async () => {
    needsPassword()
    const next = plan({
      items: [
        claudeImportItem({ key: SERVER_KEY, kind: 'mcp-server', name: 'github', source: { file: '.claude.json' }, summary: 'stdio: npx', warnings: ['runs-commands'], executable: true }),
        claudeImportItem({ key: HOOK_KEY, kind: 'hook', name: 'Stop', source: { file: 'settings.json' }, summary: 'Asks a model on Stop.' }),
      ],
    })
    await render()
    await toPreview(next)
    const github = allByTestId(testIds.claudeImportItem).find(element => element.dataset.name === 'github')!
    await click(github.querySelector<HTMLElement>('[data-action="enable"]'))
    api.claudeImport.apply.mockResolvedValue(claudeImportApplyResult({
      results: [{ key: SERVER_KEY, outcome: 'created', id: 'github' }, { key: HOOK_KEY, outcome: 'created', id: 'hok_1' }],
      counts: { created: 2, updated: 0, unchanged: 0, skipped: 0, failed: 0 },
      warnings: [],
    }))
    await click(byTestId(testIds.claudeImportSubmit))
    await submitPassword()
    expect(api.claudeImport.apply.mock.calls[0]![0].body.items).toEqual([{ key: SERVER_KEY, action: 'import', enable: true }, { key: HOOK_KEY, action: 'import' }])
    expect(dialog()!.querySelector('[data-slot="claude-import-turned-off"]')).toBeNull()
    await click(action('open-mcp'))
    expect(mocks.router.push).toHaveBeenCalledWith('/plugins/core-mcp')
    expect(openChanges).toEqual([false])
  })

  it('asks for the import password when nothing that runs commands is picked', async () => {
    needsPassword()
    await render()
    await toPreview()
    const hook = allByTestId(testIds.claudeImportItem).find(element => element.dataset.kind === 'hook')!
    await click(byTestId(testIds.claudeImportSelect, hook))
    expect(dialog()!.querySelector('[data-slot="claude-import-executables"]')).toBeNull()
    expect(byTestId(testIds.claudeImportSubmit)?.textContent?.trim()).toBe('Import 1 item')
    api.claudeImport.apply.mockResolvedValue(claudeImportApplyResult())
    await click(byTestId(testIds.claudeImportSubmit))
    expect(byTestId(testIds.confirmPasswordDialog)?.textContent).toContain('Importing from Claude Code needs your password.')
  })

  it('starts again when the preview expired', async () => {
    await render()
    await toPreview()
    api.claudeImport.apply.mockRejectedValue(new HarnessError({ code: 'not_found', message: 'The import plan expired. Read the folder again.' }))
    await click(byTestId(testIds.claudeImportSubmit))
    const error = byTestId(testIds.claudeImportError)!
    expect(error.dataset.code).toBe('not_found')
    expect(error.textContent).toContain('This preview expired. Start again.')
    await click(action('start-again'))
    expect(step()).toBe('source')
    expect(byTestId(testIds.claudeImportError)).toBeNull()
    // The picked folder is kept: Continue reads it again.
    expect(dialog()!.textContent).toContain('2 files picked')
    expect(byTestId<HTMLButtonElement>(testIds.claudeImportContinue)!.disabled).toBe(false)
  })

  it('closes at once on step 1 and asks before dropping a preview', async () => {
    const { wrapper } = await render()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    expect(openChanges).toEqual([false])
    wrapper.unmount()
    document.body.replaceChildren()

    openChanges = []
    await render()
    await toPreview()
    document.body.querySelector<HTMLElement>('[data-slot="dialog-close"]')!.click()
    await settle()
    const confirm = document.body.querySelector<HTMLElement>('[data-slot="confirm-dialog"]')!
    expect(confirm.textContent).toContain('Discard this import?')
    const keep = [...confirm.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Keep reviewing')!
    await click(keep)
    expect(openChanges).toEqual([])
    expect(step()).toBe('preview')

    document.body.querySelector<HTMLElement>('[data-slot="dialog-close"]')!.click()
    await settle()
    const discard = [...document.body.querySelector<HTMLElement>('[data-slot="confirm-dialog"]')!.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Discard')!
    await click(discard)
    expect(openChanges).toEqual([false])
  })

  it('goes back to the source with Back and keeps the choice', async () => {
    await render()
    await toPreview()
    await click(byTestId(testIds.claudeImportBack))
    expect(step()).toBe('source')
    expect(source('folder').getAttribute('aria-checked')).toBe('true')
    expect(byTestId<HTMLButtonElement>(testIds.claudeImportContinue)!.disabled).toBe(false)
  })
})
