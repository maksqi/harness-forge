import type { PluginInspection } from '@harness-forge/shared'
import type { InstallTab } from './install'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAuthStore } from '~/stores/auth'
import { testIds } from '~/utils/testids'
import { authStatus, claudePluginInfo, pluginDetail } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import InstallDialog from './InstallDialog.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

const HASH = 'c'.repeat(64)
const SHA256 = `sha256-${'A'.repeat(43)}=`

function inspection(overrides: Partial<PluginInspection> = {}): PluginInspection {
  return {
    manifest: { manifestVersion: 1, id: 'acme', name: 'Acme', version: '1.2.0', description: 'Acme models', engines: { harness: '^1.0.0' } },
    kind: 'declarative',
    format: 'harness',
    source: 'zip',
    sha256: HASH,
    contributions: { providers: ['acme'], models: 2, tools: [], mcpServers: [], commands: [], hooks: [], agents: [], skills: [], commandHooks: 0, outputStyles: [] },
    networkHosts: ['api.acme.test'],
    secretsRequested: ['API key (Acme)'],
    permissions: [],
    requiresTrust: false,
    compatible: true,
    existing: null,
    files: { count: 2, bytes: 1200 },
    warnings: [],
    claude: null,
    ...overrides,
  }
}

function codeInspection(overrides: Partial<PluginInspection> = {}): PluginInspection {
  return inspection({
    manifest: { manifestVersion: 1, id: 'dice', name: 'Dice', version: '1.0.0', engines: { harness: '^1.0.0' }, main: 'index.mjs', permissions: ['storage'] },
    kind: 'code',
    requiresTrust: true,
    permissions: ['storage'],
    networkHosts: [],
    secretsRequested: [],
    warnings: ['Runs code with full server privileges.'],
    ...overrides,
  })
}

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  toasts.success.mockReset()
  toasts.error.mockReset()
  const auth = useAuthStore()
  auth.status = authStatus()
  auth.loaded = true
  api.plugins.get.mockImplementation(async ({ params }: { params: { id: string } }) => pluginDetail({ id: params.id }))
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

async function mountDialog(initialSource: InstallTab = 'zip') {
  const open = ref(true)
  const installed = vi.fn()
  const Host = defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(InstallDialog, {
        'open': open.value,
        'initialSource': initialSource,
        'onUpdate:open': (value: boolean) => {
          open.value = value
        },
        'onInstalled': installed,
      }),
    }),
  })
  const wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  await flushPromises()
  return { wrapper, open, installed }
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)
}

async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull()
  element!.click()
  await flushPromises()
}

async function type(input: HTMLInputElement | null, value: string) {
  expect(input).not.toBeNull()
  input!.value = value
  input!.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

async function chooseZip(name = 'acme.zip') {
  const input = byTestId<HTMLInputElement>(testIds.installZipInput)!
  const file = new File([new Uint8Array([0x50, 0x4B, 3, 4, 1, 2])], name, { type: 'application/zip' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()
  return file
}

function submitDisabled(): boolean {
  return byTestId<HTMLButtonElement>(testIds.installSubmit)!.disabled
}

describe('installDialog', () => {
  it('inspects a zip, shows the preview and installs it', async () => {
    api.pluginInstall.inspect.mockResolvedValue(inspection())
    api.pluginInstall.install.mockResolvedValue(pluginDetail({ id: 'acme', name: 'Acme', kind: 'declarative' }))
    const { installed, open } = await mountDialog()
    await flushPromises()
    expect(byTestId(testIds.installDialog)?.dataset.step).toBe('source')

    await click(byTestId(testIds.installInspect))
    expect(document.body.textContent).toContain('Choose a .zip file.')
    expect(api.pluginInstall.inspect).not.toHaveBeenCalled()

    const file = await chooseZip()
    await click(byTestId(testIds.installInspect))
    const inspectForm = api.pluginInstall.inspect.mock.calls[0]![0].form as FormData
    expect((inspectForm.get('file') as File).name).toBe(file.name)

    const preview = byTestId(testIds.installPreview)!
    expect(preview.dataset.pluginId).toBe('acme')
    expect(preview.textContent).toContain('2 models')
    expect(preview.textContent).toContain('api.acme.test')
    expect(preview.textContent).toContain('API key (Acme)')
    expect(preview.textContent).toContain(HASH)
    expect(byTestId(testIds.trustWarning)).toBeNull()
    expect(submitDisabled()).toBe(false)

    await click(byTestId(testIds.installSubmit))
    const installForm = api.pluginInstall.install.mock.calls[0]![0].form as FormData
    expect((installForm.get('file') as File).name).toBe('acme.zip')
    expect(installForm.get('trust')).toBeNull()
    // The install carries the hash the user reviewed (409 `stale` when the package changed meanwhile).
    expect(installForm.get('sha256')).toBe(HASH)
    expect(toasts.success).toHaveBeenCalledWith('Installed Acme')
    expect(installed).toHaveBeenCalledWith('acme')
    expect(open.value).toBe(false)
  })

  it('requires "I trust" for code plugins and sends trust', async () => {
    api.pluginInstall.inspect.mockResolvedValue(codeInspection())
    api.pluginInstall.install.mockResolvedValue(pluginDetail({ id: 'dice', name: 'Dice' }))
    const { installed } = await mountDialog()
    await chooseZip('dice.zip')
    await click(byTestId(testIds.installInspect))

    const warning = byTestId(testIds.trustWarning)!
    expect(warning.textContent).toContain('Runs code on your server with harness-forge\'s permissions.')
    expect(document.body.textContent).toContain('I trust dice.zip')
    expect(byTestId(testIds.trustPassword)).toBeNull()
    expect(submitDisabled()).toBe(true)

    await click(byTestId(testIds.trustCheckbox))
    expect(submitDisabled()).toBe(false)
    await click(byTestId(testIds.installSubmit))
    expect((api.pluginInstall.install.mock.calls[0]![0].form as FormData).get('trust')).toBe('true')
    expect(installed).toHaveBeenCalledWith('dice')
  })

  it('asks for the password when the session is not fresh and logs in first', async () => {
    const auth = useAuthStore()
    auth.status = authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() - 1000 })
    api.pluginInstall.inspect.mockResolvedValue(codeInspection())
    api.auth.login.mockRejectedValueOnce(new HarnessError({ code: 'unauthorized', message: 'Invalid password' }))
    api.auth.login.mockResolvedValue(authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() + 600_000 }))
    api.pluginInstall.install.mockResolvedValue(pluginDetail({ id: 'dice', name: 'Dice' }))
    const { installed } = await mountDialog()
    await chooseZip('dice.zip')
    await click(byTestId(testIds.installInspect))
    await click(byTestId(testIds.trustCheckbox))
    expect(submitDisabled()).toBe(true)

    await type(byTestId<HTMLInputElement>(testIds.trustPassword), 'wrong')
    await click(byTestId(testIds.installSubmit))
    expect(api.auth.login).toHaveBeenCalledWith({ body: { password: 'wrong' } })
    expect(document.body.textContent).toContain('Wrong password')
    expect(api.pluginInstall.install).not.toHaveBeenCalled()

    await type(byTestId<HTMLInputElement>(testIds.trustPassword), 'right')
    await click(byTestId(testIds.installSubmit))
    expect(api.auth.login).toHaveBeenLastCalledWith({ body: { password: 'right' } })
    expect(api.pluginInstall.install).toHaveBeenCalledTimes(1)
    expect(installed).toHaveBeenCalledWith('dice')
  })

  it('falls back to ConfirmPasswordDialog when the server asks for a fresh login, then retries once', async () => {
    api.pluginInstall.inspect.mockResolvedValue(codeInspection())
    api.pluginInstall.install
      .mockRejectedValueOnce(new HarnessError({ code: 'forbidden', message: 'Confirm your password to continue.', action: 'login' }))
      .mockResolvedValueOnce(pluginDetail({ id: 'dice', name: 'Dice' }))
    api.auth.login.mockResolvedValue(authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() + 600_000 }))
    const { installed } = await mountDialog()
    await chooseZip('dice.zip')
    await click(byTestId(testIds.installInspect))
    await click(byTestId(testIds.trustCheckbox))
    await click(byTestId(testIds.installSubmit))

    expect(byTestId(testIds.confirmPasswordDialog)).not.toBeNull()
    await type(byTestId<HTMLInputElement>(testIds.confirmPasswordInput), 'secret')
    await click(byTestId(testIds.confirmPasswordSubmit))
    expect(api.auth.login).toHaveBeenCalledWith({ body: { password: 'secret' } })
    expect(api.pluginInstall.install).toHaveBeenCalledTimes(2)
    expect(installed).toHaveBeenCalledWith('dice')
  })

  it('shows a refusal after the prompt with Log in, which asks again and installs once more', async () => {
    const refusal = () => new HarnessError({ code: 'forbidden', message: 'Confirm your password to continue.', action: 'login' })
    api.pluginInstall.inspect.mockResolvedValue(codeInspection())
    api.pluginInstall.install
      .mockRejectedValueOnce(refusal())
      .mockRejectedValueOnce(refusal())
      .mockResolvedValueOnce(pluginDetail({ id: 'dice', name: 'Dice' }))
    api.auth.login.mockResolvedValue(authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() + 600_000 }))
    const { installed } = await mountDialog()
    await chooseZip('dice.zip')
    await click(byTestId(testIds.installInspect))
    await click(byTestId(testIds.trustCheckbox))
    await click(byTestId(testIds.installSubmit))
    await type(byTestId<HTMLInputElement>(testIds.confirmPasswordInput), 'secret')
    await click(byTestId(testIds.confirmPasswordSubmit))

    // The install ran once more after the prompt; the second refusal is shown, not asked again.
    expect(api.pluginInstall.install).toHaveBeenCalledTimes(2)
    expect(byTestId(testIds.confirmPasswordDialog)).toBeNull()
    const alert = byTestId(testIds.installError)!
    expect(alert.dataset.code).toBe('forbidden')
    const logIn = [...alert.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Log in')!
    await click(logIn)
    expect(byTestId(testIds.confirmPasswordDialog)).not.toBeNull()
    await type(byTestId<HTMLInputElement>(testIds.confirmPasswordInput), 'secret')
    await click(byTestId(testIds.confirmPasswordSubmit))
    expect(api.auth.login).toHaveBeenCalledTimes(2)
    expect(api.pluginInstall.install).toHaveBeenCalledTimes(3)
    expect(installed).toHaveBeenCalledWith('dice')
  })

  it('installs nothing and shows nothing when the fallback prompt is cancelled', async () => {
    api.pluginInstall.inspect.mockResolvedValue(codeInspection())
    api.pluginInstall.install.mockRejectedValue(new HarnessError({ code: 'forbidden', message: 'Confirm your password to continue.', action: 'login' }))
    const { installed, open } = await mountDialog()
    await chooseZip('dice.zip')
    await click(byTestId(testIds.installInspect))
    await click(byTestId(testIds.trustCheckbox))
    await click(byTestId(testIds.installSubmit))
    const prompt = byTestId(testIds.confirmPasswordDialog)!
    const cancel = [...prompt.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Cancel')!
    await click(cancel)

    expect(byTestId(testIds.confirmPasswordDialog)).toBeNull()
    expect(api.pluginInstall.install).toHaveBeenCalledTimes(1)
    expect(api.auth.login).not.toHaveBeenCalled()
    expect(byTestId(testIds.installError)).toBeNull()
    expect(submitDisabled()).toBe(false)
    expect(installed).not.toHaveBeenCalled()
    expect(open.value).toBe(true)
  })

  it('sends npm specs, keeps inputs on Back and shows field errors from the server', async () => {
    api.pluginInstall.inspect
      .mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'The npm package "missing" was not found.', status: 404 }))
      .mockResolvedValueOnce(inspection({ source: 'npm' }))
      .mockRejectedValueOnce(new HarnessError({ code: 'validation_error', message: 'Bad', details: { issues: [{ path: ['spec'], message: 'No sha512 integrity.', code: 'custom' }] } }))
    await mountDialog('npm')
    await flushPromises()
    await type(byTestId<HTMLInputElement>(testIds.installNpmInput), 'missing')
    await click(byTestId(testIds.installInspect))
    const alert = byTestId(testIds.installError)!
    expect(alert.dataset.code).toBe('not_found')
    expect(alert.textContent).toContain('was not found')

    await type(byTestId<HTMLInputElement>(testIds.installNpmInput), '@scope/harness-plugin')
    const version = document.body.querySelector<HTMLInputElement>('input[placeholder="latest"]')
    await type(version, '^1.0.0')
    await click(byTestId(testIds.installInspect))
    expect(api.pluginInstall.inspect).toHaveBeenLastCalledWith({ body: { source: 'npm', spec: '@scope/harness-plugin@^1.0.0' } })
    expect(byTestId(testIds.installPreview)).not.toBeNull()

    await click(byTestId(testIds.installBack))
    expect(byTestId(testIds.installPreview)).toBeNull()
    expect(byTestId<HTMLInputElement>(testIds.installNpmInput)!.value).toBe('@scope/harness-plugin')
    await click(byTestId(testIds.installInspect))
    expect(document.body.textContent).toContain('No sha512 integrity.')
    expect(byTestId(testIds.installError)).toBeNull()
  })

  it('sends URL and folder sources as JSON', async () => {
    api.pluginInstall.inspect.mockResolvedValue(inspection({ source: 'url' }))
    api.pluginInstall.install.mockResolvedValue(pluginDetail({ id: 'acme', name: 'Acme' }))
    const url = await mountDialog('url')
    await flushPromises()
    await type(byTestId<HTMLInputElement>(testIds.installUrlInput), 'https://cdn.example.com/acme.zip')
    await click(byTestId(testIds.installInspect))
    expect(document.body.textContent).toContain('Expected an SRI hash')
    await type(byTestId<HTMLInputElement>(testIds.installIntegrityInput), SHA256)
    await click(byTestId(testIds.installInspect))
    await click(byTestId(testIds.installSubmit))
    expect(api.pluginInstall.install).toHaveBeenCalledWith({ body: { source: 'url', url: 'https://cdn.example.com/acme.zip', integrity: SHA256, sha256: HASH } })
    url.wrapper.unmount()
    document.body.replaceChildren()

    api.pluginInstall.inspect.mockResolvedValue(inspection({ source: 'copy' }))
    await mountDialog('folder')
    await flushPromises()
    expect(byTestId(testIds.installFolderMode)!.dataset.value).toBe('link')
    await click(document.body.querySelector<HTMLElement>(`[data-testid="${testIds.installFolderMode}"] [data-value="copy"]`))
    expect(byTestId(testIds.installFolderMode)!.dataset.value).toBe('copy')
    await type(byTestId<HTMLInputElement>(testIds.installFolderInput), '/srv/plugins/acme')
    await click(byTestId(testIds.installInspect))
    expect(api.pluginInstall.inspect).toHaveBeenLastCalledWith({ body: { source: 'path', path: '/srv/plugins/acme', mode: 'copy' } })
  })

  it('disables Install for incompatible plugins and source conflicts, and shows install errors', async () => {
    api.pluginInstall.inspect.mockResolvedValueOnce(inspection({ compatible: false, warnings: ['Needs plugin API ^2.0.0; this server provides 1.0.0. It cannot be installed.'] }))
    await mountDialog()
    await chooseZip()
    await click(byTestId(testIds.installInspect))
    expect(submitDisabled()).toBe(true)
    expect(document.body.textContent).toContain('Needs plugin API ^2.0.0')

    await click(byTestId(testIds.installBack))
    api.pluginInstall.inspect.mockResolvedValueOnce(inspection({ existing: { version: '1.0.0', state: 'active', source: 'npm' } }))
    await click(byTestId(testIds.installInspect))
    expect(submitDisabled()).toBe(true)

    await click(byTestId(testIds.installBack))
    api.pluginInstall.inspect.mockResolvedValueOnce(inspection())
    api.pluginInstall.install.mockRejectedValueOnce(new HarnessError({ code: 'plugin_error', message: 'The plugin failed to load, so the installation was rolled back: boom', details: { pluginId: 'acme', phase: 'install' } }))
    await click(byTestId(testIds.installInspect))
    await click(byTestId(testIds.installSubmit))
    const alert = byTestId(testIds.installError)!
    expect(alert.dataset.code).toBe('plugin_error')
    expect(alert.textContent).toContain('rolled back')
    expect(byTestId(testIds.installPreview)).not.toBeNull()
  })

  it('refreshes the preview when the source changed since it was inspected', async () => {
    api.pluginInstall.inspect
      .mockResolvedValueOnce(codeInspection({ source: 'npm' }))
      .mockResolvedValueOnce(codeInspection({ source: 'npm', manifest: { manifestVersion: 1, id: 'dice', name: 'Dice', version: '2.0.0', engines: { harness: '^1.0.0' }, main: 'index.mjs' } }))
    api.pluginInstall.install.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'The plugin changed since you reviewed it (a new version or changed files): inspect it again before installing.', details: { reason: 'stale' } }))
    const { installed } = await mountDialog('npm')
    await type(byTestId<HTMLInputElement>(testIds.installNpmInput), 'dice')
    await click(byTestId(testIds.installInspect))
    await click(byTestId(testIds.trustCheckbox))
    await click(byTestId(testIds.installSubmit))

    expect(api.pluginInstall.install).toHaveBeenLastCalledWith({ body: { source: 'npm', spec: 'dice', sha256: HASH, trust: true } })
    expect(api.pluginInstall.inspect).toHaveBeenCalledTimes(2)
    // The error gives way to a notice about the new preview; the consent starts over.
    expect(byTestId(testIds.installError)).toBeNull()
    expect(byTestId(testIds.installStale)!.textContent).toContain('changed since you reviewed it')
    expect(byTestId(testIds.installPreview)!.textContent).toContain('2.0.0')
    expect(byTestId(testIds.trustCheckbox)!.getAttribute('aria-checked')).toBe('false')
    expect(submitDisabled()).toBe(true)
    expect(installed).not.toHaveBeenCalled()

    // Reviewing again installs the new hash; the notice goes away with the new attempt.
    api.pluginInstall.install.mockResolvedValueOnce(pluginDetail({ id: 'dice', name: 'Dice' }))
    await click(byTestId(testIds.trustCheckbox))
    await click(byTestId(testIds.installSubmit))
    expect(installed).toHaveBeenCalledWith('dice')
  })

  it('keeps the error when the new inspection fails as well', async () => {
    api.pluginInstall.inspect
      .mockResolvedValueOnce(codeInspection({ source: 'npm' }))
      .mockRejectedValueOnce(new HarnessError({ code: 'provider_unreachable', message: 'The npm registry did not answer.' }))
    api.pluginInstall.install.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'The plugin changed since you reviewed it (a new version or changed files): inspect it again before installing.', details: { reason: 'stale' } }))
    await mountDialog('npm')
    await type(byTestId<HTMLInputElement>(testIds.installNpmInput), 'dice')
    await click(byTestId(testIds.installInspect))
    await click(byTestId(testIds.trustCheckbox))
    await click(byTestId(testIds.installSubmit))
    expect(byTestId(testIds.installStale)).toBeNull()
    expect(byTestId(testIds.installError)!.textContent).toContain('inspect it again')
  })

  it('names the resolved source in "I trust" when the server sent one', async () => {
    api.pluginInstall.inspect.mockResolvedValue(codeInspection({ source: 'npm', sourceRef: 'dice@1.4.2' }))
    await mountDialog('npm')
    await type(byTestId<HTMLInputElement>(testIds.installNpmInput), 'dice')
    await click(byTestId(testIds.installInspect))
    expect(document.body.textContent).toContain('I trust dice@1.4.2')
    expect(byTestId(testIds.installPreview)!.textContent).toContain('npm · dice@1.4.2')
  })

  it('starts fresh every time it opens', async () => {
    api.pluginInstall.inspect.mockResolvedValue(inspection())
    const { open } = await mountDialog('npm')
    await flushPromises()
    await type(byTestId<HTMLInputElement>(testIds.installNpmInput), 'harness-plugin')
    await click(byTestId(testIds.installInspect))
    expect(byTestId(testIds.installPreview)).not.toBeNull()
    open.value = false
    await flushPromises()
    open.value = true
    await flushPromises()
    expect(byTestId(testIds.installDialog)?.dataset.step).toBe('source')
    expect(byTestId<HTMLInputElement>(testIds.installNpmInput)!.value).toBe('')
  })

  it('installs a Claude Code plugin from the GitHub tab: the repository spec fills the ref (Phase 12, W12.9)', async () => {
    const claude = claudeInspection()
    api.pluginInstall.inspect.mockResolvedValue(claude)
    api.pluginInstall.install.mockResolvedValue(pluginDetail({ id: 'review-kit', name: 'review-kit', format: 'claude', source: 'github' }))
    const { installed } = await mountDialog('github')
    expect(byTestId(testIds.installTabGithub)?.getAttribute('data-state')).toBe('active')
    expect(document.body.textContent).toContain('Downloads an archive of the exact commit over HTTPS. Nothing runs before you review it.')

    const repo = byTestId<HTMLInputElement>(testIds.installGithubRepo)!
    await type(repo, 'anthropics/review-kit#v1.2.0')
    repo.dispatchEvent(new FocusEvent('blur'))
    await nextTick()
    expect(repo.value).toBe('anthropics/review-kit')
    expect(byTestId<HTMLInputElement>(testIds.installGithubRef)!.value).toBe('v1.2.0')
    await type(byTestId<HTMLInputElement>(testIds.installGithubPath), 'plugins/review-kit/')
    await click(byTestId(testIds.installInspect))
    expect(api.pluginInstall.inspect).toHaveBeenCalledWith({ body: { source: 'github', repo: 'anthropics/review-kit', ref: 'v1.2.0', path: 'plugins/review-kit' } })

    const preview = byTestId(testIds.installPreview)!
    expect(preview.querySelector('[data-slot="install-format"]')?.textContent?.trim()).toBe('Claude Code plugin')
    expect(preview.querySelector('[data-slot="install-commit"]')?.textContent?.trim()).toBe('Resolved commit 3f2a9c1')
    expect(byTestId(testIds.trustWarning)!.querySelector('[data-slot="trust-run-commands"]')?.textContent).toContain('PostToolUse hook')
    expect(document.body.textContent).toContain('I trust anthropics/review-kit@3f2a9c1d0e4b/plugins/review-kit')

    await click(byTestId(testIds.trustCheckbox))
    await click(byTestId(testIds.installSubmit))
    expect(api.pluginInstall.install).toHaveBeenCalledWith({ body: { source: 'github', repo: 'anthropics/review-kit', ref: 'v1.2.0', path: 'plugins/review-kit', sha256: HASH, trust: true } })
    expect(installed).toHaveBeenCalledWith('review-kit')
  })

  it('reports a GitHub repository it cannot read before inspecting (Phase 12, W12.9)', async () => {
    await mountDialog('github')
    await click(byTestId(testIds.installInspect))
    expect(document.body.textContent).toContain('Enter a repository as owner/repo.')
    await type(byTestId<HTMLInputElement>(testIds.installGithubRepo), 'https://gitlab.com/acme/tools')
    await click(byTestId(testIds.installInspect))
    expect(document.body.textContent).toContain('Enter a GitHub repository as owner/repo or a github.com URL.')
    expect(api.pluginInstall.inspect).not.toHaveBeenCalled()
  })
})

/** A Claude Code plugin from a folder of a GitHub repository (Phase 12). */
function claudeInspection(): PluginInspection {
  return inspection({
    manifest: { manifestVersion: 1, id: 'review-kit', name: 'review-kit', version: '1.2.0', engines: { harness: '^1.6.0' } },
    format: 'claude',
    source: 'github',
    sourceRef: 'anthropics/review-kit@3f2a9c1d0e4b/plugins/review-kit',
    contributions: { providers: [], models: 0, tools: [], mcpServers: ['review-kit'], commands: ['review-kit:review'], hooks: [], agents: [], skills: [], commandHooks: 1, outputStyles: [] },
    networkHosts: [],
    secretsRequested: [],
    requiresTrust: true,
    claude: claudePluginInfo(),
  })
}
