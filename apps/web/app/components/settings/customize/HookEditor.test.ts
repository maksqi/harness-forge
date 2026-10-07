// HookEditor (docs/UI.md 9.13, 9.14, 8.4, 10.8, 10.9; W11.8-T4, W12.12-T1): the sheet per mode, the fields, the matcher
// preview, the inline rules, create and edit through useFreshAuth (prompt first; an edit that only turns the hook off asks
// nothing), the server's matcher refusal on the field, other errors in `hook-error`, Mod+Enter and the discard
// confirmation; Phase 12: the Prompt type, the 13 events, the handler fields, Where, and the project mode (save through
// saveProjectHook without a password, the pending count with Review, the stale banner with Load from disk / Overwrite).
import type { VueWrapper } from '@vue/test-utils'
import type { HookDraft, ProjectHookTarget } from './hooks'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError, HOOK_EVENTS } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useAuthStore } from '~/stores/auth'
import { useHooksStore } from '~/stores/hooks'
import { useModelsStore } from '~/stores/models'
import { usePluginsStore } from '~/stores/plugins'
import { useProvidersStore } from '~/stores/providers'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import { authStatus, catalogModel, hookEntry, hookId, hookList, personalHook, projectDefinitionFile, projectDefinitionWriteResult, projectId, providerSummary, settings, toolSummary, trustSha } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { SHEET_CLOSE_TOUCH_CLASS } from './customize'
import HookEditor from './HookEditor.vue'

const mocks = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

const passwordSet = authStatus({ enabled: true, authenticated: true, source: 'settings', freshUntil: null })

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let wrappers: VueWrapper[] = []

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  toasts.success.mockReset()
  toasts.error.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
  const plugins = usePluginsStore()
  plugins.tools = ['shell', 'read_file', 'write_file', 'edit_file'].map(name => toolSummary({ name, pluginId: 'core-workspace' }))
  plugins.toolsLoaded = true
  useSettingsStore().settings = settings()
  useSettingsStore().loaded = true
  useProvidersStore().items = [providerSummary()]
  useProvidersStore().loaded = true
  useModelsStore().items = [catalogModel({ id: 'claude-haiku-5', name: 'Claude Haiku 5' })]
  useModelsStore().loaded = true
  api.auth.login.mockImplementation(async ({ body }: { body: { password: string } }) => {
    if (body.password !== 'correct-horse')
      throw new HarnessError({ code: 'unauthorized', message: 'Invalid password' })
    return { ...passwordSet, freshUntil: Date.now() + 600_000 }
  })
})

afterEach(() => {
  for (const wrapper of wrappers)
    wrapper.unmount()
  wrappers = []
  disposePinia(pinia)
  document.body.replaceChildren()
})

async function mountEditor(props: { mode: 'new' | 'edit' | 'copy' | 'project', hook?: ReturnType<typeof personalHook> | null, draft?: HookDraft | null, target?: ProjectHookTarget | null }) {
  const wrapper = mount(HookEditor, {
    props: {
      'open': true,
      'mode': props.mode,
      'hook': props.hook ?? null,
      'draft': props.draft ?? null,
      'target': props.target ?? null,
      'onUpdate:open': (value: boolean) => wrapper.setProps({ open: value }),
    },
    attachTo: document.body,
    global: { plugins: [pinia] },
  })
  wrappers.push(wrapper)
  await flushPromises()
  await nextTick()
  return wrapper
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)
}

async function type(id: string, value: string): Promise<void> {
  const input = byTestId<HTMLInputElement>(id)
  expect(input).not.toBeNull()
  input!.value = value
  input!.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

async function chooseEvent(event: string): Promise<void> {
  byTestId(testIds.hookEvent)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await flushPromises()
  const item = [...document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')].find(option => option.dataset.value === event)!
  item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await flushPromises()
}

async function save(): Promise<void> {
  byTestId(testIds.hookSave)!.click()
  await flushPromises()
}

describe('hookEditor', () => {
  it('renders the new sheet with the warning, the fields and the event descriptions', async () => {
    await mountEditor({ mode: 'new' })
    const sheet = byTestId(testIds.hookEditor)!
    expect(sheet.dataset.mode).toBe('new')
    expect(sheet.textContent).toContain('New hook')
    expect(byTestId(testIds.hookWarning)?.textContent).toContain('Hooks run shell commands on your server with harness-forge\'s permissions, without asking, whenever their event happens. Only add commands you understand.')
    expect(byTestId(testIds.hookEvent)?.dataset.value).toBe('PreToolUse')
    expect(sheet.textContent).toContain('Before a tool runs. It can block the call, allow it without asking or change its input.')
    expect(byTestId(testIds.hookMatcher)).not.toBeNull()
    expect(byTestId(testIds.hookCommand)).not.toBeNull()
    expect(byTestId(testIds.hookTimeout)).not.toBeNull()
    expect(byTestId(testIds.hookEditorEnabled)?.dataset.state).toBe('checked')
    expect(document.activeElement).toBe(byTestId(testIds.hookEvent))
  })

  it('hides the tools for events without a tool matcher', async () => {
    await mountEditor({ mode: 'new' })
    await chooseEvent('Stop')
    expect(byTestId(testIds.hookEvent)?.dataset.value).toBe('Stop')
    expect(byTestId(testIds.hookMatcher)).toBeNull()
    expect(byTestId(testIds.hookEditor)?.textContent).toContain('When the agent finishes a reply. It can make it continue.')
  })

  it('previews the matcher after a pause, with the Claude names in brackets', async () => {
    await mountEditor({ mode: 'new' })
    const preview = byTestId(testIds.hookMatcherPreview)!
    expect(preview.getAttribute('aria-live')).toBe('polite')
    await type(testIds.hookMatcher, 'Bash|Edit')
    await vi.waitFor(() => expect(preview.textContent?.trim()).toBe('Matches shell (Bash), edit_file (Edit)'))
    expect(preview.dataset.count).toBe('2')
    await type(testIds.hookMatcher, 'Deploy')
    await vi.waitFor(() => expect(preview.textContent?.trim()).toBe('No tool is named Deploy now.'))
  })

  it('creates a hook after the password prompt, toasts, emits saved and closes', async () => {
    useAuthStore().status = passwordSet
    const created = personalHook({ id: hookId(2), event: 'PreToolUse', matcher: 'Bash', command: './scripts/guard.sh', timeout: 30 })
    api.hooks.create.mockResolvedValue(created)
    const wrapper = await mountEditor({ mode: 'new' })
    await type(testIds.hookMatcher, ' Bash ')
    await type(testIds.hookCommand, './scripts/guard.sh')
    await type(testIds.hookTimeout, '30')
    await save()
    const prompt = byTestId(testIds.confirmPasswordDialog)
    expect(prompt?.textContent).toContain('Saving a hook needs your password.')
    expect(api.hooks.create).not.toHaveBeenCalled()
    await type(testIds.confirmPasswordInput, 'correct-horse')
    byTestId(testIds.confirmPasswordSubmit)!.click()
    await flushPromises()
    expect(api.hooks.create).toHaveBeenCalledWith({ body: { event: 'PreToolUse', matcher: 'Bash', command: './scripts/guard.sh', timeout: 30, enabled: true } })
    expect(toasts.success).toHaveBeenCalledWith('Hook saved')
    expect(wrapper.emitted('saved')?.[0]).toEqual([created])
    expect(byTestId(testIds.hookEditor)).toBeNull()
  })

  it('refuses an invalid matcher, an empty command and a bad timeout inline without a request', async () => {
    await mountEditor({ mode: 'new' })
    await type(testIds.hookMatcher, '^Bash.*$')
    await type(testIds.hookTimeout, '900')
    await save()
    expect(api.hooks.create).not.toHaveBeenCalled()
    const editor = byTestId(testIds.hookEditor)!
    expect(editor.textContent).toContain('Use tool names, | and * only.')
    expect(editor.textContent).toContain('Add the command.')
    expect(editor.textContent).toContain('Enter a whole number from 1 to 600.')
    expect(byTestId(testIds.hookMatcher)?.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(byTestId(testIds.hookMatcher))
  })

  it('shows a matcher the server refused on the field and other errors in the form alert', async () => {
    api.hooks.create.mockRejectedValueOnce(new HarnessError({ code: 'validation_error', message: 'Invalid request.', details: { issues: [{ path: ['matcher'], message: 'Invalid matcher', code: 'custom' }] } }))
    await mountEditor({ mode: 'new' })
    await type(testIds.hookMatcher, 'Bash')
    await type(testIds.hookCommand, 'sh guard.sh')
    await save()
    expect(byTestId(testIds.hookMatcherPreview)?.textContent?.trim()).toBe('Use tool names, | and * only.')
    expect(byTestId(testIds.hookError)).toBeNull()

    api.hooks.create.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'At most 100 personal hooks can be stored; delete one first.', details: { reason: 'exists' } }))
    await type(testIds.hookMatcher, 'Write')
    await save()
    const error = byTestId(testIds.hookError)!
    expect(error.dataset.code).toBe('conflict')
    expect(error.textContent).toContain('At most 100 personal hooks can be stored; delete one first.')
  })

  it('edits only the changed fields and turns a hook off without a password', async () => {
    useAuthStore().status = passwordSet
    const hook = personalHook({ event: 'PreToolUse', matcher: 'Bash', command: 'sh guard.sh', timeout: null, enabled: true })
    api.hooks.update.mockResolvedValue({ ...hook, enabled: false })
    await mountEditor({ mode: 'edit', hook })
    expect(byTestId(testIds.hookEditor)?.textContent).toContain('Edit hook')
    expect(document.activeElement).toBe(byTestId(testIds.hookCommand))
    byTestId(testIds.hookEditorEnabled)!.click()
    await flushPromises()
    await save()
    expect(byTestId(testIds.confirmPasswordDialog)).toBeNull()
    expect(api.hooks.update).toHaveBeenCalledWith({ params: { id: hook.id }, body: { enabled: false } })
    expect(toasts.success).toHaveBeenCalledWith('Hook saved')
  })

  it('asks for the password for any other edit', async () => {
    useAuthStore().status = passwordSet
    const hook = personalHook({ event: 'PreToolUse', matcher: 'Bash', command: 'sh guard.sh', timeout: null })
    api.hooks.update.mockResolvedValue({ ...hook, timeout: 10 })
    await mountEditor({ mode: 'edit', hook })
    await type(testIds.hookTimeout, '10')
    await save()
    expect(byTestId(testIds.confirmPasswordDialog)?.textContent).toContain('Saving a hook needs your password.')
    expect(api.hooks.update).not.toHaveBeenCalled()
  })

  it('saves with Mod+Enter in any field', async () => {
    api.hooks.create.mockResolvedValue(personalHook())
    await mountEditor({ mode: 'copy', draft: { event: 'PostToolUse', matcher: 'Write|Edit', command: 'prettier --write .', timeout: null, enabled: true } })
    expect(byTestId(testIds.hookEditor)?.dataset.mode).toBe('copy')
    expect(byTestId(testIds.hookEditor)?.textContent).toContain('Copy hook')
    byTestId(testIds.hookCommand)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
    await flushPromises()
    expect(api.hooks.create).toHaveBeenCalledWith({ body: { event: 'PostToolUse', matcher: 'Write|Edit', command: 'prettier --write .', timeout: null, enabled: true } })
  })

  it('asks before discarding changes and closes without asking when nothing changed', async () => {
    const wrapper = await mountEditor({ mode: 'new' })
    await type(testIds.hookCommand, 'pnpm lint')
    document.body.querySelector<HTMLElement>('[data-slot="sheet-close"]')!.click()
    await flushPromises()
    expect(byTestId(testIds.hookDiscardConfirm)?.textContent?.trim()).toBe('Discard')
    expect(document.body.textContent).toContain('Discard changes?')
    byTestId(testIds.hookDiscardConfirm)!.click()
    await flushPromises()
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
    expect(byTestId(testIds.hookEditor)).toBeNull()

    const clean = await mountEditor({ mode: 'new' })
    document.body.querySelector<HTMLElement>('[data-slot="sheet-close"]')!.click()
    await flushPromises()
    expect(byTestId(testIds.hookDiscardConfirm)).toBeNull()
    expect(clean.emitted('update:open')?.at(-1)).toEqual([false])
  })

  it('renders nothing while closed', async () => {
    const wrapper = mount(HookEditor, { props: { open: false, mode: 'new', hook: null }, attachTo: document.body, global: { plugins: [pinia] } })
    wrappers.push(wrapper)
    await flushPromises()
    expect(byTestId(testIds.hookEditor)).toBeNull()
  })
})

async function chooseIn(id: string, value: string, attribute: 'data-testid' | 'data-field' = 'data-testid'): Promise<void> {
  document.body.querySelector<HTMLElement>(`[${attribute}="${id}"]`)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await flushPromises()
  const item = [...document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')].find(option => option.dataset.value === value)!
  item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await flushPromises()
}

async function chooseType(type: 'command' | 'prompt'): Promise<void> {
  document.body.querySelector<HTMLElement>(`[data-testid="${testIds.hookType}"] [data-value="${type}"]`)!.click()
  await flushPromises()
}

function field<T extends HTMLElement = HTMLElement>(name: string): T | null {
  return document.body.querySelector<T>(`[data-field="${name}"]`)
}

async function typeIn(element: HTMLInputElement | HTMLTextAreaElement | null, value: string): Promise<void> {
  expect(element).not.toBeNull()
  element!.value = value
  element!.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

async function enterPassword(): Promise<void> {
  await type(testIds.confirmPasswordInput, 'correct-horse')
  byTestId(testIds.confirmPasswordSubmit)!.click()
  await flushPromises()
}

describe('hookEditor: the Prompt type and the 13 events (W12.12-T1)', () => {
  it('lists the 13 events in order with their descriptions and the matcher of each', async () => {
    await mountEditor({ mode: 'new' })
    byTestId(testIds.hookEvent)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()
    const options = [...document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')]
    expect(options.map(option => option.dataset.value)).toEqual([...HOOK_EVENTS])
    expect(options.find(option => option.dataset.value === 'PermissionRequest')?.textContent).toContain('When harness-forge is about to ask you to approve a tool call. It can allow or deny the call.')
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()

    await chooseEvent('PostToolUseFailure')
    expect(byTestId(testIds.hookMatcher)).not.toBeNull()
    expect(byTestId(testIds.hookMatcherPreview)).not.toBeNull()
    expect(field('hook-if')).not.toBeNull()
    expect(byTestId(testIds.hookEditor)?.textContent).toContain('After a tool call failed. It can give the agent feedback.')
    await chooseEvent('SubagentStart')
    expect(byTestId(testIds.hookEditor)?.textContent).toContain('Agent types')
    expect(byTestId(testIds.hookEditor)?.textContent).toContain('Agent type names separated by |, like explore|general. Leave it empty for every sub-agent.')
    expect(byTestId(testIds.hookMatcherPreview)).toBeNull()
    expect(field('hook-if')).toBeNull()
    await chooseEvent('SessionEnd')
    expect(byTestId(testIds.hookMatcher)).toBeNull()
    expect(byTestId(testIds.hookEditor)?.textContent).toContain('When you delete a chat.')
  })

  it('creates a prompt hook: the prompt, the model line, and no command', async () => {
    useAuthStore().status = passwordSet
    api.hooks.create.mockResolvedValue(personalHook())
    await mountEditor({ mode: 'new' })
    expect(byTestId(testIds.hookType)?.dataset.value).toBe('command')
    await chooseType('prompt')
    expect(byTestId(testIds.hookType)?.dataset.value).toBe('prompt')
    expect(byTestId(testIds.hookCommand)).toBeNull()
    expect(field('hook-args')).toBeNull()
    expect(byTestId(testIds.hookWarning)?.textContent).toContain('A prompt hook asks a model about every matching event, using tokens each time. Its answer can block a call or make the agent continue, never allow one.')
    expect(field('hook-model-line')?.textContent?.trim()).toBe('Runs with the provider\'s small model (Settings → General → Agent → Hook model). It answers ok, or not ok with a reason.')
    expect(byTestId<HTMLInputElement>(testIds.hookTimeout)?.placeholder).toBe('30')
    // PreToolUse offers Continue on block; Stop does not.
    expect(field('hook-continue-on-block')).not.toBeNull()
    await chooseEvent('Stop')
    expect(field('hook-continue-on-block')).toBeNull()

    // An empty prompt is refused inline.
    await save()
    expect(api.hooks.create).not.toHaveBeenCalled()
    expect(byTestId(testIds.hookEditor)?.textContent).toContain('Add the prompt.')
    expect(document.activeElement).toBe(byTestId(testIds.hookPrompt))

    await type(testIds.hookPrompt, 'Did the tests run and pass? $ARGUMENTS')
    await typeIn(field<HTMLInputElement>('hook-status-message'), 'Checking the tests')
    await save()
    expect(byTestId(testIds.confirmPasswordDialog)?.textContent).toContain('Saving a hook needs your password.')
    await enterPassword()
    expect(api.hooks.create).toHaveBeenCalledWith({ body: { type: 'prompt', event: 'Stop', matcher: null, prompt: 'Did the tests run and pass? $ARGUMENTS', timeout: null, enabled: true, statusMessage: 'Checking the tests' } })
    expect(toasts.success).toHaveBeenCalledWith('Hook saved')
  })

  it('names the hook model of the settings and refuses a prompt hook on an event that takes none', async () => {
    useSettingsStore().settings = settings({ hookModelRef: 'anthropic:claude-haiku-5' })
    await mountEditor({ mode: 'new', draft: { event: 'Notification', matcher: '', command: '', timeout: null, enabled: true, type: 'prompt', prompt: 'Is it urgent?' } })
    expect(field('hook-model-line')?.textContent?.trim()).toBe('Runs with Claude Haiku 5 (Settings → General → Agent → Hook model). It answers ok, or not ok with a reason.')
    expect(field('hook-event-error')?.textContent?.trim()).toBe('Prompt hooks work only for PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, SubagentStop and PermissionRequest.')
    expect(byTestId(testIds.hookEvent)?.getAttribute('aria-invalid')).toBe('true')
    await save()
    expect(api.hooks.create).not.toHaveBeenCalled()
    await chooseEvent('UserPromptSubmit')
    expect(field('hook-event-error')).toBeNull()
  })

  it('sends the command handler fields: arguments, background, only when and the status message', async () => {
    api.hooks.create.mockResolvedValue(personalHook())
    useAuthStore().status = authStatus({ enabled: false, authenticated: true, source: null, freshUntil: null })
    await mountEditor({ mode: 'new' })
    await type(testIds.hookMatcher, 'Bash')
    await type(testIds.hookCommand, 'node')
    await typeIn(field<HTMLTextAreaElement>('hook-args'), 'scripts/guard.js\n\ntwo words')
    field('hook-async')!.click()
    await flushPromises()
    await typeIn(field<HTMLInputElement>('hook-if'), 'Read(./x)')
    await save()
    expect(api.hooks.create).not.toHaveBeenCalled()
    expect(byTestId(testIds.hookEditor)?.textContent).toContain('Only Bash rules may have a pattern in parentheses.')
    await typeIn(field<HTMLInputElement>('hook-if'), 'Bash(git *)')
    await save()
    expect(api.hooks.create).toHaveBeenCalledWith({ body: { event: 'PreToolUse', matcher: 'Bash', command: 'node', timeout: null, enabled: true, args: ['scripts/guard.js', 'two words'], async: true, if: 'Bash(git *)' } })
  })

  it('opens a personal prompt hook on its prompt and patches only what changed', async () => {
    useAuthStore().status = passwordSet
    const hook = { ...personalHook({ event: 'Stop', matcher: null }), type: 'prompt', prompt: 'Done?', model: 'haiku', continueOnBlock: false } as unknown as ReturnType<typeof personalHook>
    api.hooks.update.mockResolvedValue(hook)
    await mountEditor({ mode: 'edit', hook })
    expect(byTestId(testIds.hookType)?.dataset.value).toBe('prompt')
    expect(byTestId<HTMLTextAreaElement>(testIds.hookPrompt)?.value).toBe('Done?')
    expect(document.activeElement).toBe(byTestId(testIds.hookPrompt))
    expect(field('hook-model-line')?.textContent?.trim()).toBe('Runs with haiku. It answers ok, or not ok with a reason.')
    await type(testIds.hookPrompt, 'Is the work done?')
    await save()
    await enterPassword()
    expect(api.hooks.update).toHaveBeenCalledWith({ params: { id: hook.id }, body: { prompt: 'Is the work done?' } })
  })
})

describe('hookEditor: project mode (W12.12-T1)', () => {
  const settingsPath = '.claude/settings.json'
  const fileHooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh guard.sh' }] }] }
  const file = (hooks: unknown = fileHooks, sha = trustSha(4)) => projectDefinitionFile({ path: settingsPath, kind: 'settings', content: JSON.stringify({ permissions: {}, hooks }), sha256: sha })
  const row = (overrides: Parameters<typeof hookEntry>[0] = {}) => hookEntry({ key: `project:${trustSha(1)}`, source: 'project', id: undefined, event: 'PreToolUse', matcher: 'Bash', command: 'sh guard.sh', state: 'pending', path: settingsPath, sha256: trustSha(1), position: [0, 0], ...overrides })
  const target: ProjectHookTarget = { projectId: projectId(1), path: settingsPath, event: 'PreToolUse', groupIndex: 0, handlerIndex: 0 }
  const draft: HookDraft = { event: 'PreToolUse', matcher: 'Bash', command: 'sh guard.sh', timeout: null, enabled: true }

  async function loadListing(items = [row()]) {
    api.hooks.list.mockResolvedValue(hookList({ items }))
    await useHooksStore().fetch(projectId(1))
  }

  it('saves the handler into the settings file without a password and offers Review for the pending items', async () => {
    useAuthStore().status = passwordSet
    await loadListing()
    api.projectDefinitions.read.mockResolvedValue(file())
    api.projectDefinitions.write.mockResolvedValue(projectDefinitionWriteResult({ trust: { pending: 1 } }))
    const wrapper = await mountEditor({ mode: 'project', target, draft })
    const sheet = byTestId(testIds.hookEditor)!
    expect(sheet.dataset.mode).toBe('project')
    expect(sheet.textContent).toContain('Edit project hook')
    expect(field('hook-path')?.textContent?.trim()).toBe(settingsPath)
    expect(byTestId(testIds.hookEditorEnabled)).toBeNull()
    await type(testIds.hookCommand, 'sh guard.sh --strict')
    await save()
    expect(byTestId(testIds.confirmPasswordDialog)).toBeNull()
    expect(api.projectDefinitions.write).toHaveBeenCalledWith({
      params: { id: projectId(1) },
      body: { path: settingsPath, expectedSha256: trustSha(4), hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh guard.sh --strict' }] }] } },
    })
    expect(api.hooks.create).not.toHaveBeenCalled()
    const [message, options] = toasts.success.mock.calls[0]!
    expect(message).toBe('Saved .claude/settings.json. 1 item needs your approval.')
    expect(options.action.label).toBe('Review')
    expect(wrapper.emitted('saved')).toBeUndefined()
    expect(byTestId(testIds.hookEditor)).toBeNull()
    options.action.onClick()
    await flushPromises()
    expect(wrapper.findComponent({ name: 'ProjectTrustDialog' }).props()).toMatchObject({ open: true, projectId: projectId(1) })
  })

  it('shows the stale banner when the file changed and overwrites after refetching the listing', async () => {
    await loadListing()
    api.projectDefinitions.read.mockResolvedValue(file())
    api.projectDefinitions.write
      .mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'The file changed on disk. Load it again or overwrite it.', details: { reason: 'stale' } }))
      .mockResolvedValueOnce(projectDefinitionWriteResult({ trust: { pending: 0 } }))
    await mountEditor({ mode: 'project', target, draft })
    await type(testIds.hookCommand, 'sh guard.sh --strict')
    await save()
    const banner = field('hook-stale')!
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.textContent).toContain('.claude/settings.json changed on disk after you opened it.')
    expect(byTestId(testIds.hookError)).toBeNull()
    api.hooks.list.mockClear()
    banner.querySelector<HTMLElement>('[data-action="overwrite"]')!.click()
    await flushPromises()
    expect(api.hooks.list).toHaveBeenCalledWith({ query: { projectId: projectId(1) } })
    expect(api.projectDefinitions.write).toHaveBeenCalledTimes(2)
    expect(toasts.success).toHaveBeenCalledWith('Saved .claude/settings.json.')
    expect(byTestId(testIds.hookEditor)).toBeNull()
  })

  it('shows the banner without writing when the listing shows another handler, and loads it from disk', async () => {
    await loadListing()
    await mountEditor({ mode: 'project', target, draft })
    await type(testIds.hookCommand, 'sh mine.sh')
    // The agent rewrote the file meanwhile: the refetched listing shows another command at the position.
    await loadListing([row({ command: 'sh theirs.sh' })])
    await save()
    expect(field('hook-stale')).not.toBeNull()
    expect(api.projectDefinitions.read).not.toHaveBeenCalled()
    field('hook-stale')!.querySelector<HTMLElement>('[data-action="reload"]')!.click()
    await flushPromises()
    expect(field('hook-stale')).toBeNull()
    expect(byTestId<HTMLTextAreaElement>(testIds.hookCommand)!.value).toBe('sh theirs.sh')
  })

  it('says a hook that is gone no longer exists and saves the edits as a new handler', async () => {
    await loadListing()
    await mountEditor({ mode: 'project', target, draft })
    await loadListing([])
    await save()
    field('hook-stale')!.querySelector<HTMLElement>('[data-action="reload"]')!.click()
    await flushPromises()
    expect(byTestId(testIds.hookError)?.dataset.code).toBe('not_found')
    expect(byTestId(testIds.hookError)?.textContent).toContain('This hook no longer exists.')
    api.projectDefinitions.read.mockResolvedValue(file({}))
    api.projectDefinitions.write.mockResolvedValue(projectDefinitionWriteResult({ trust: { pending: 1 } }))
    await save()
    expect(api.projectDefinitions.write).toHaveBeenCalledWith({
      params: { id: projectId(1) },
      body: { path: settingsPath, expectedSha256: trustSha(4), hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh guard.sh' }] }] } },
    })
  })

  it('shows a refused settings file in the error alert', async () => {
    api.projectDefinitions.read.mockResolvedValue(file())
    api.projectDefinitions.write.mockRejectedValueOnce(new HarnessError({ code: 'validation_error', message: 'Invalid request.', details: { diagnostics: [{ level: 'error', code: 'invalid-if', message: 'The "if" rule must name one tool. This hook never runs.' }] } }))
    await mountEditor({ mode: 'project', target: { ...target, groupIndex: null, handlerIndex: null }, draft })
    expect(byTestId(testIds.hookEditor)?.textContent).toContain('New project hook')
    await save()
    expect(byTestId(testIds.hookError)?.dataset.code).toBe('validation_error')
    expect(byTestId(testIds.hookError)?.textContent).toContain('The "if" rule must name one tool. This hook never runs.')
  })

  it('offers Where for a new hook while a project is selected and writes the chosen settings file', async () => {
    useAuthStore().status = passwordSet
    api.projectDefinitions.read.mockResolvedValue(projectDefinitionFile({ path: '.harness/settings.json', kind: 'settings', exists: false, content: null, sha256: null }))
    api.projectDefinitions.write.mockResolvedValue(projectDefinitionWriteResult({ path: '.harness/settings.json', created: true, trust: { pending: 1 } }))
    await mountEditor({ mode: 'new', target: { projectId: projectId(1), path: '', event: 'PreToolUse', groupIndex: null, handlerIndex: null } })
    expect(field('hook-where')?.dataset.value).toBe('personal')
    expect(byTestId(testIds.hookEditorEnabled)).not.toBeNull()
    await chooseIn('hook-where', '.harness/settings.json', 'data-field')
    expect(field('hook-where')?.dataset.value).toBe('.harness/settings.json')
    expect(byTestId(testIds.hookEditorEnabled)).toBeNull()
    await type(testIds.hookMatcher, 'Write')
    await type(testIds.hookCommand, 'sh fmt.sh')
    await save()
    expect(byTestId(testIds.confirmPasswordDialog)).toBeNull()
    expect(api.projectDefinitions.write).toHaveBeenCalledWith({
      params: { id: projectId(1) },
      body: { path: '.harness/settings.json', expectedSha256: null, hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'sh fmt.sh' }] }] } },
    })
    expect(toasts.success.mock.calls[0]![0]).toBe('Saved .harness/settings.json. 1 item needs your approval.')
  })

  it('offers no Where without a project', async () => {
    await mountEditor({ mode: 'new' })
    expect(field('hook-where')).toBeNull()
  })
})

describe('hookEditor: touch targets (W12.19, docs/UI.md 14.5)', () => {
  const classesOf = (element: Element | null) => (element?.getAttribute('class') ?? '').split(/\s+/)

  it('gives the switches a 40 px hit area and the Event trigger and the × Close 40 px on a coarse pointer', async () => {
    await mountEditor({ mode: 'new' })
    expect(classesOf(byTestId(testIds.hookEditor))).toEqual(expect.arrayContaining(SHEET_CLOSE_TOUCH_CLASS.split(' ')))
    expect(classesOf(byTestId(testIds.hookEvent))).toContain('pointer-coarse:data-[size=default]:h-10')
    // A Switch's `::after` counts from inside its 1 px border (16.4 px): -12 px each way makes 40.4 px.
    for (const element of [byTestId(testIds.hookEditorEnabled), field('hook-async')])
      expect(classesOf(element)).toContain('pointer-coarse:after:-inset-y-3')
    await chooseType('prompt')
    expect(classesOf(field('hook-continue-on-block'))).toContain('pointer-coarse:after:-inset-y-3')
  })
})
