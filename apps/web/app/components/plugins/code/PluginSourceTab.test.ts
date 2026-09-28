import type { BuildResult, PluginDetail, PluginFileEntry } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { EditorView } from '@codemirror/view'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { useShortcuts } from '~/composables/useShortcuts'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import { authStatus, logEntry, pluginDetail } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import PluginSourceTab from './PluginSourceTab.vue'
import { sha256Hex } from './source-files'
import { resetSourceWorkspaces } from './source-workspace'
import SourceFileTree from './SourceFileTree.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

type Guard = (...args: any[]) => unknown
const router = vi.hoisted(() => ({ leave: [] as Guard[], update: [] as Guard[], mode: 'dark' }))
vi.mock('./nuxt-imports', () => ({
  onBeforeRouteLeave: (guard: Guard) => router.leave.push(guard),
  onBeforeRouteUpdate: (guard: Guard) => router.update.push(guard),
  useColorMode: () => ({ get value() { return router.mode } }),
}))

const media = vi.hoisted(() => ({ desktop: true }))
vi.mock('@vueuse/core', async importOriginal => ({
  ...await importOriginal<typeof import('@vueuse/core')>(),
  useMediaQuery: () => ref(media.desktop),
}))

const SOURCE = 'export default {\n  setup(ctx) {\n    ctx.logger.info(\'hi\')\n  },\n}\n'
const FILES: Record<string, string> = {
  'index.mjs': SOURCE,
  'plugin.json': '{\n  "id": "my-tool"\n}\n',
  'README.md': '# My tool\n',
}

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let disk: Record<string, string>

function entries(): PluginFileEntry[] {
  return Object.keys(disk).sort().map(path => ({ path, type: 'file', size: disk[path]!.length, mtime: 1, editable: true }))
}

function detail(overrides: Partial<PluginDetail> = {}): PluginDetail {
  return pluginDetail({
    id: 'my-tool',
    name: 'My tool',
    manifest: { manifestVersion: 1, id: 'my-tool', name: 'My tool', version: '0.1.0', engines: { harness: '^1.0.0' }, main: 'index.mjs' },
    ...overrides,
  })
}

function build(overrides: Partial<BuildResult> = {}): BuildResult {
  return { ok: true, durationMs: 42, diagnostics: [], hash: 'b'.repeat(64), state: 'active', ...overrides }
}

beforeEach(() => {
  disk = { ...FILES }
  api = createMockApi()
  mock.api = api
  api.pluginFiles.list.mockImplementation(async () => ({ items: entries() }))
  api.pluginFiles.read.mockImplementation(async ({ params }: { params: { path: string } }) => ({
    path: params.path,
    content: disk[params.path],
    etag: await sha256Hex(disk[params.path]!),
    mtime: 1,
  }))
  api.pluginFiles.write.mockImplementation(async ({ params, body }: { params: { path: string }, body: { content: string } }) => {
    disk[params.path] = body.content
    return { path: params.path, type: 'file', size: body.content.length, mtime: 2, editable: true }
  })
  api.pluginFiles.remove.mockImplementation(async ({ params }: { params: { path: string } }) => {
    delete disk[params.path]
  })
  api.pluginFiles.build.mockResolvedValue(build())
  api.plugins.get.mockResolvedValue(detail())
  api.plugins.logs.mockResolvedValue({ items: [logEntry(1, { message: 'Loaded in 3 ms.' })] })
  pinia = createPinia()
  setActivePinia(pinia)
  usePluginsStore().details = { 'my-tool': detail() }
  router.leave = []
  router.update = []
  router.mode = 'dark'
  media.desktop = true
  toasts.error.mockReset()
})

afterEach(() => {
  resetSourceWorkspaces()
  disposePinia(pinia)
  document.body.replaceChildren()
})

async function settle() {
  for (let round = 0; round < 3; round++) {
    await flushPromises()
    await vi.dynamicImportSettled()
  }
  await flushPromises()
}

async function mountTab(props: { readonly?: boolean } = {}) {
  const wrapper = mount(PluginSourceTab, { attachTo: document.body, props: { pluginId: 'my-tool', ...props }, global: { plugins: [pinia] } })
  await settle()
  return wrapper
}

function byTestId<T extends Element = HTMLElement>(id: string, extra = ''): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]${extra}`)
}

function all(id: string): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)]
}

function view(): EditorView {
  const editor = document.body.querySelector<HTMLElement>('.cm-editor')
  const found = editor ? EditorView.findFromDOM(editor) : null
  if (!found)
    throw new Error('No editor view')
  return found
}

async function typeInEditor(text: string) {
  view().dispatch({ changes: { from: 0, insert: text } })
  await nextTick()
}

async function pressModS() {
  const mac = useShortcuts().isMac
  const event = new KeyboardEvent('keydown', { key: 's', metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true })
  view().contentDOM.dispatchEvent(event)
  useShortcuts().handleKeydown(event)
  await settle()
}

describe('pluginSourceTab', () => {
  it('lists the files and opens the entry in CodeMirror', async () => {
    const wrapper = await mountTab()
    expect(all(testIds.codeFile).map(item => item.dataset.path)).toEqual(['index.mjs', 'plugin.json', 'README.md'])
    expect(all(testIds.codeEditorTab).map(item => item.dataset.path)).toEqual(['index.mjs'])
    expect(byTestId(testIds.codeEditor)?.dataset.path).toBe('index.mjs')
    expect(view().state.doc.toString()).toBe(SOURCE)
    expect(view().state.facet(EditorView.darkTheme)).toBe(true)
    expect(byTestId(testIds.codeBuildLog)?.textContent).toContain('Loaded in 3 ms.')
    expect(byTestId(testIds.codeReadonlyBanner)).toBeNull()

    byTestId(testIds.codeFile, '[data-path="README.md"]')!.click()
    await settle()
    expect(all(testIds.codeEditorTab).map(item => item.dataset.path)).toEqual(['index.mjs', 'README.md'])
    expect(view().state.doc.toString()).toBe('# My tool\n')
    wrapper.unmount()
  })

  it('marks edits dirty, saves with Mod+S and the etag, and shows the save time', async () => {
    const wrapper = await mountTab()
    await typeInEditor('// edited\n')
    expect(byTestId(testIds.codeEditorTab, '[data-path="index.mjs"]')?.dataset.dirty).toBe('true')
    expect(byTestId<HTMLButtonElement>(testIds.codeEditorSave)?.disabled).toBe(false)
    await pressModS()
    expect(api.pluginFiles.write).toHaveBeenCalledWith({
      params: { id: 'my-tool', path: 'index.mjs' },
      body: { content: `// edited\n${SOURCE}`, baseEtag: await sha256Hex(SOURCE) },
    })
    expect(byTestId(testIds.codeEditorTab, '[data-path="index.mjs"]')?.dataset.dirty).toBe('false')
    expect(document.body.textContent).toMatch(/Saved \d/)
    wrapper.unmount()
  })

  it('does not save with Mod+S while the Source tab is hidden in an inactive tab panel', async () => {
    const panel = document.createElement('div')
    panel.dataset.state = 'inactive'
    document.body.append(panel)
    const wrapper = mount(PluginSourceTab, { attachTo: panel, props: { pluginId: 'my-tool' }, global: { plugins: [pinia] } })
    await settle()
    await typeInEditor('// hidden\n')
    await pressModS()
    expect(api.pluginFiles.write).not.toHaveBeenCalled()
    panel.dataset.state = 'active'
    await pressModS()
    expect(api.pluginFiles.write).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('build & reload saves first, then shows diagnostics as problems and lint markers', async () => {
    const diagnostic = { severity: 'error' as const, file: 'index.mjs', line: 3, column: 5, message: 'Expected ";" but found "ctx"' }
    api.pluginFiles.build.mockResolvedValue(build({ ok: false, diagnostics: [diagnostic], hash: null }))
    const wrapper = await mountTab()
    await typeInEditor('// change\n')
    byTestId<HTMLButtonElement>(testIds.codeBuildReload)!.click()
    await settle()
    expect(api.pluginFiles.write).toHaveBeenCalledTimes(1)
    expect(api.pluginFiles.build).toHaveBeenCalledWith({ params: { id: 'my-tool' }, body: { reload: true } })
    // The build output is fetched too (it also arrives as live plugin.log events).
    expect(api.plugins.logs.mock.calls.length).toBeGreaterThanOrEqual(2)
    const panel = byTestId(testIds.codeBuildLog)!
    expect(panel.textContent).toContain('Build failed')
    expect(panel.textContent).toContain('index.mjs:3:5')
    expect(panel.textContent).toContain('Expected ";" but found "ctx"')
    expect(document.body.querySelector('.cm-hf-lint-marker-error')?.getAttribute('aria-label')).toBe(diagnostic.message)
    expect(document.body.textContent).toContain('1 problem')

    api.pluginFiles.build.mockResolvedValue(build())
    byTestId<HTMLButtonElement>(testIds.codeBuildReload)!.click()
    await settle()
    expect(byTestId(testIds.codeBuildLog)!.textContent).toContain('Build succeeded in 42 ms')
    expect(document.body.querySelector('.cm-hf-lint-marker-error')).toBeNull()
    wrapper.unmount()
  })

  it('asks for the password when a save needs fresh auth, then retries once', async () => {
    api.pluginFiles.write.mockRejectedValueOnce(new HarnessError({ code: 'forbidden', message: 'Confirm your password to continue.', action: 'login' }))
    api.auth.login.mockResolvedValue(authStatus({ enabled: true, freshUntil: Date.now() + 600_000 }))
    const wrapper = await mountTab()
    await typeInEditor('// secure\n')
    byTestId<HTMLButtonElement>(testIds.codeEditorSave)!.click()
    await settle()
    expect(byTestId(testIds.confirmPasswordDialog)).not.toBeNull()
    const input = byTestId<HTMLInputElement>(testIds.confirmPasswordInput)!
    input.value = 'correct horse'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    byTestId<HTMLButtonElement>(testIds.confirmPasswordSubmit)!.click()
    await settle()
    expect(api.auth.login).toHaveBeenCalledWith({ body: { password: 'correct horse' } })
    expect(api.pluginFiles.write).toHaveBeenCalledTimes(2)
    expect(disk['index.mjs']).toBe(`// secure\n${SOURCE}`)
    expect(byTestId(testIds.codeEditorTab, '[data-path="index.mjs"]')?.dataset.dirty).toBe('false')
    expect(toasts.error).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('resolves a stale save by overwriting', async () => {
    const wrapper = await mountTab()
    await typeInEditor('// mine\n')
    api.pluginFiles.write.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'Changed.', details: { reason: 'stale' } }))
    byTestId<HTMLButtonElement>(testIds.codeEditorSave)!.click()
    await settle()
    expect(document.body.textContent).toContain('The file changed on the server')
    const overwrite = [...document.body.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Overwrite')!
    overwrite.click()
    await settle()
    expect(api.pluginFiles.write).toHaveBeenLastCalledWith({ params: { id: 'my-tool', path: 'index.mjs' }, body: { content: `// mine\n${SOURCE}` } })
    expect(document.body.textContent).not.toContain('The file changed on the server')
    wrapper.unmount()
  })

  it('deletes a file after confirmation and protects plugin.json and the entry', async () => {
    const wrapper = await mountTab()
    const tree = wrapper.findComponent(SourceFileTree)
    expect(tree.props('protectedPaths')).toEqual(['plugin.json', 'index.mjs'])
    tree.vm.$emit('delete', 'README.md')
    await settle()
    expect(document.body.textContent).toContain('Delete README.md?')
    const confirm = [...document.body.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Delete')!
    confirm.click()
    await settle()
    expect(api.pluginFiles.remove).toHaveBeenCalledWith({ params: { id: 'my-tool', path: 'README.md' } })
    expect(all(testIds.codeFile).map(item => item.dataset.path)).toEqual(['index.mjs', 'plugin.json'])
    wrapper.unmount()
  })

  it('creates a new file from the tree', async () => {
    const wrapper = await mountTab()
    byTestId<HTMLButtonElement>(testIds.codeNewFile)!.click()
    await settle()
    const input = document.body.querySelector<HTMLInputElement>('input[placeholder="lib/util.mjs"]')!
    input.value = 'lib/helpers.mjs'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    const create = [...document.body.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Create')!
    create.click()
    await settle()
    expect(api.pluginFiles.write).toHaveBeenCalledWith({ params: { id: 'my-tool', path: 'lib/helpers.mjs' }, body: { content: '' } })
    expect(byTestId(testIds.codeEditor)?.dataset.path).toBe('lib/helpers.mjs')
    wrapper.unmount()
  })

  it('asks before closing a dirty tab and before leaving with unsaved changes', async () => {
    const wrapper = await mountTab()
    await typeInEditor('// unsaved\n')
    const close = byTestId(testIds.codeEditorTab, '[data-path="index.mjs"]')!.querySelector<HTMLButtonElement>('button[aria-label="Close index.mjs"]')!
    close.click()
    await settle()
    expect(document.body.textContent).toContain('Discard changes?')
    const keep = [...document.body.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Cancel')!
    keep.click()
    await settle()
    expect(all(testIds.codeEditorTab)).toHaveLength(1)

    expect(router.leave).toHaveLength(1)
    const decision = router.leave[0]!() as Promise<boolean>
    await settle()
    expect(document.body.textContent).toContain('Discard unsaved changes?')
    const discard = [...document.body.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Discard changes')!
    discard.click()
    await settle()
    expect(await decision).toBe(true)
    expect(byTestId(testIds.codeEditorTab, '[data-path="index.mjs"]')?.dataset.dirty).toBe('false')
    // Nothing unsaved: leaving is allowed right away.
    expect(router.leave[0]!()).toBe(true)
    wrapper.unmount()
  })

  it('keeps unsaved edits when the tab unmounts and comes back', async () => {
    const first = await mountTab()
    await typeInEditor('// kept\n')
    first.unmount()
    const second = await mountTab()
    expect(byTestId(testIds.codeEditorTab, '[data-path="index.mjs"]')?.dataset.dirty).toBe('true')
    expect(view().state.doc.toString()).toBe(`// kept\n${SOURCE}`)
    second.unmount()
  })

  it('is read-only for plugins installed from npm', async () => {
    usePluginsStore().details = { 'my-tool': detail({ source: 'npm', editable: false }) }
    const wrapper = await mountTab()
    expect(byTestId(testIds.codeReadonlyBanner)?.textContent).toContain('Installed from npm. Editing is disabled.')
    expect(byTestId<HTMLButtonElement>(testIds.codeBuildReload)?.disabled).toBe(true)
    expect(byTestId<HTMLButtonElement>(testIds.codeEditorSave)?.disabled).toBe(true)
    expect(byTestId(testIds.codeNewFile)).toBeNull()
    expect(view().state.readOnly).toBe(true)
    wrapper.unmount()
  })

  it('uses a file select and a collapsed build panel below lg, and the light theme in light mode', async () => {
    media.desktop = false
    router.mode = 'light'
    const wrapper = await mountTab()
    expect(byTestId(testIds.codeFileTree)).toBeNull()
    const select = document.body.querySelector<HTMLSelectElement>('select[aria-label="File"]')!
    expect([...select.options].map(option => option.value)).toEqual(['index.mjs', 'plugin.json', 'README.md'])
    expect(byTestId(testIds.codeBuildLog)).toBeNull()
    expect(view().state.facet(EditorView.darkTheme)).toBe(false)
    select.value = 'plugin.json'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(byTestId(testIds.codeEditor)?.dataset.path).toBe('plugin.json')
    wrapper.unmount()
  })
})
