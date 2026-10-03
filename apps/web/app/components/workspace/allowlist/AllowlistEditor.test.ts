// AllowlistEditor, AllowlistDialog and GlobalAllowlistSection (docs/UI.md 2.15, 7.23, 9.10, 13.9; W8.11-T2): the
// explanation and risk note, the load (skeleton, failure with Retry), the rules sorted by prefix, Remove with its focus
// moves, the add form (canonical prefix, Enter, clearing and keeping focus), the inline errors (the parser's reasons,
// 409 exists, the server message), the one-word warning, the empty state, and the dialog's focus on open.
import type { ShellRule, ShellRuleList } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useShellRulesStore } from '~/stores/shell-rules'
import { testIds } from '~/utils/testids'
import { projectId, projectSummary, shellRule, shellRuleId } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { allowedCommandsLabel, ALLOWLIST_RISK_NOTE, allowlistDescription, allowlistError } from './allowlist'
import AllowlistDialog from './AllowlistDialog.vue'
import AllowlistEditor from './AllowlistEditor.vue'
import GlobalAllowlistSection from './GlobalAllowlistSection.vue'

const mocks = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let wrappers: VueWrapper[] = []

const test = shellRule({ id: shellRuleId(1), prefix: 'pnpm test' })
const lint = shellRule({ id: shellRuleId(2), prefix: 'pnpm lint' })
const make = shellRule({ id: shellRuleId(3), prefix: 'make' })
const ls = shellRule({ id: shellRuleId(4), projectId: null, prefix: 'ls' })
const other = shellRule({ id: shellRuleId(5), projectId: projectId(2), prefix: 'cargo test' })

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  toasts.success.mockReset()
  toasts.error.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  for (const wrapper of wrappers)
    wrapper.unmount()
  wrappers = []
  disposePinia(pinia)
  document.body.replaceChildren()
})

async function mountEditor(items: ShellRule[] = [test, lint, ls, other], id: string | null = projectId(1)): Promise<VueWrapper> {
  api.shellRules.list.mockResolvedValue({ items })
  const wrapper = mount(AllowlistEditor, { props: { projectId: id }, attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)
}

function allByTestId<T extends HTMLElement = HTMLElement>(id: string): T[] {
  return [...document.body.querySelectorAll<T>(`[data-testid="${id}"]`)]
}

function prefixes(): string[] {
  return allByTestId(testIds.allowlistRule).map(row => row.dataset.value ?? '')
}

function input(): HTMLInputElement {
  return byTestId<HTMLInputElement>(testIds.allowlistInput)!
}

async function type(value: string): Promise<void> {
  input().value = value
  input().dispatchEvent(new Event('input'))
  await flushPromises()
}

async function submit(): Promise<void> {
  input().closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await flushPromises()
}

function removeButton(prefix: string): HTMLButtonElement {
  return allByTestId(testIds.allowlistRule)
    .find(row => row.dataset.value === prefix)!
    .querySelector<HTMLButtonElement>(`[data-testid="${testIds.allowlistRuleRemove}"]`)!
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('allowlist texts', () => {
  it('words the explanation per scope, the row meta and the add errors', () => {
    expect(allowlistDescription('project')).toBe('Shell commands that start with one of these run without asking in this project. Combined commands run only when every part matches; redirections and substitutions always ask.')
    expect(allowlistDescription('global')).toContain('run without asking in every project. Combined commands')
    expect(allowedCommandsLabel(0)).toBeNull()
    expect(allowedCommandsLabel(1)).toBe('1 allowed command')
    expect(allowedCommandsLabel(3)).toBe('3 allowed commands')
    expect(allowlistError(new HarnessError({ code: 'conflict', message: 'Rule exists.', details: { reason: 'exists' } })))
      .toEqual({ code: 'conflict', message: 'This rule already exists.' })
    expect(allowlistError(new HarnessError({ code: 'validation_error', message: 'A scope can have up to 200 rules.' })))
      .toEqual({ code: 'validation_error', message: 'A scope can have up to 200 rules.' })
    expect(allowlistError(new Error('raw'))).toMatchObject({ code: 'internal_error' })
  })
})

describe('allowlistEditor: list', () => {
  it('shows the risk note and the rules of its project sorted by prefix, in mono, with Remove', async () => {
    const wrapper = await mountEditor()
    expect(wrapper.text()).toContain(ALLOWLIST_RISK_NOTE)
    expect(prefixes()).toEqual(['pnpm lint', 'pnpm test'])
    const row = allByTestId(testIds.allowlistRule)[1]!
    expect(row.dataset.ruleId).toBe(test.id)
    expect(row.querySelector('.font-mono')?.textContent?.trim()).toBe('pnpm test')
    expect(removeButton('pnpm test').getAttribute('aria-label')).toBe('Remove pnpm test')
    expect(byTestId(testIds.allowlistEmpty)).toBeNull()
    // No rule edit (docs/UI.md 7.23).
    expect(wrapper.find('[aria-label^="Edit"]').exists()).toBe(false)
  })

  it('shows the global rules for projectId null', async () => {
    await mountEditor([test, ls, shellRule({ id: shellRuleId(6), projectId: null, prefix: 'git status' })], null)
    expect(prefixes()).toEqual(['git status', 'ls'])
  })

  it('shows a skeleton while the first load runs, then "No allowed commands yet."', async () => {
    const answer = deferred<ShellRuleList>()
    api.shellRules.list.mockReturnValue(answer.promise)
    const wrapper = mount(AllowlistEditor, { props: { projectId: projectId(1) }, attachTo: document.body })
    wrappers.push(wrapper)
    await flushPromises()
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true)
    expect(byTestId(testIds.allowlistEmpty)).toBeNull()
    answer.resolve({ items: [ls] })
    await flushPromises()
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(false)
    expect(byTestId(testIds.allowlistEmpty)?.textContent?.trim()).toBe('No allowed commands yet.')
  })

  it('does not load again when the rules are loaded', async () => {
    const store = useShellRulesStore()
    store.items = [test]
    store.loaded = true
    const wrapper = mount(AllowlistEditor, { props: { projectId: projectId(1) }, attachTo: document.body })
    wrappers.push(wrapper)
    await flushPromises()
    expect(api.shellRules.list).not.toHaveBeenCalled()
    expect(prefixes()).toEqual(['pnpm test'])
  })

  it('says "Couldn\'t load the allowed commands" with Retry when the load fails', async () => {
    api.shellRules.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'The database is locked.' }))
    const wrapper = mount(AllowlistEditor, { props: { projectId: projectId(1) }, attachTo: document.body })
    wrappers.push(wrapper)
    await flushPromises()
    const alert = document.body.querySelector<HTMLElement>('[data-slot="settings-load-error"]')!
    expect(alert.textContent).toContain('Couldn\'t load the allowed commands')
    expect(alert.textContent).toContain('The database is locked.')
    expect(byTestId(testIds.allowlistEmpty)).toBeNull()

    api.shellRules.list.mockResolvedValueOnce({ items: [test] })
    ;[...alert.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Retry')!.click()
    await flushPromises()
    expect(document.body.querySelector('[data-slot="settings-load-error"]')).toBeNull()
    expect(prefixes()).toEqual(['pnpm test'])
  })
})

describe('allowlistEditor: remove', () => {
  it('removes at once, without a confirmation, and moves focus to the next rule\'s Remove', async () => {
    await mountEditor([test, lint, make])
    expect(prefixes()).toEqual(['make', 'pnpm lint', 'pnpm test'])
    api.shellRules.remove.mockResolvedValue(undefined)
    removeButton('pnpm lint').focus()
    removeButton('pnpm lint').click()
    await flushPromises()
    expect(api.shellRules.remove).toHaveBeenCalledWith({ params: { id: lint.id } })
    expect(prefixes()).toEqual(['make', 'pnpm test'])
    expect(document.activeElement).toBe(removeButton('pnpm test'))
  })

  it('moves focus to the previous rule after the last one, then to the input', async () => {
    await mountEditor([test, make])
    api.shellRules.remove.mockResolvedValue(undefined)
    removeButton('pnpm test').focus()
    removeButton('pnpm test').click()
    await flushPromises()
    expect(document.activeElement).toBe(removeButton('make'))
    removeButton('make').click()
    await flushPromises()
    expect(prefixes()).toEqual([])
    expect(byTestId(testIds.allowlistEmpty)).not.toBeNull()
    expect(document.activeElement).toBe(input())
  })

  it('keeps the rule and shows a toast when the removal fails', async () => {
    await mountEditor([test])
    api.shellRules.remove.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'The database is locked.' }))
    removeButton('pnpm test').click()
    await flushPromises()
    expect(prefixes()).toEqual(['pnpm test'])
    expect(toasts.error).toHaveBeenCalledWith('Something went wrong', { description: 'The database is locked.' })
  })
})

describe('allowlistEditor: add', () => {
  it('has the input with the placeholder "pnpm test" and Add', async () => {
    await mountEditor([])
    expect(input().placeholder).toBe('pnpm test')
    expect(input().getAttribute('aria-label')).toBe('Start of a command to allow')
    expect(byTestId(testIds.allowlistAdd)?.textContent?.trim()).toBe('Add')
    expect(byTestId<HTMLButtonElement>(testIds.allowlistAdd)?.type).toBe('submit')
  })

  it('adds the canonical prefix to its project; the input clears and keeps focus', async () => {
    await mountEditor([])
    const stored = shellRule({ id: shellRuleId(9), prefix: 'pnpm build' })
    api.shellRules.create.mockResolvedValueOnce(stored)
    input().focus()
    await type('  pnpm   build ')
    byTestId<HTMLButtonElement>(testIds.allowlistAdd)!.click()
    await flushPromises()
    expect(api.shellRules.create).toHaveBeenCalledWith({ body: { projectId: projectId(1), prefix: 'pnpm build' } })
    expect(prefixes()).toEqual(['pnpm build'])
    expect(input().value).toBe('')
    expect(document.activeElement).toBe(input())
    expect(byTestId(testIds.allowlistError)).toBeNull()
  })

  it('submits with Enter and adds a global rule with projectId null', async () => {
    await mountEditor([], null)
    api.shellRules.create.mockResolvedValueOnce(ls)
    await type('ls')
    await submit()
    expect(api.shellRules.create).toHaveBeenCalledWith({ body: { projectId: null, prefix: 'ls' } })
    expect(prefixes()).toEqual(['ls'])
  })

  it('checks the prefix with the parser first and shows its reason inline, cleared by typing', async () => {
    await mountEditor([])
    await submit()
    let error = byTestId(testIds.allowlistError)!
    expect(error.dataset.code).toBe('empty')
    expect(error.textContent?.trim()).toBe('Enter the start of a command.')
    expect(error.getAttribute('role')).toBe('alert')
    expect(input().getAttribute('aria-invalid')).toBe('true')
    expect(input().getAttribute('aria-describedby')).toBe(error.id)

    await type('bash')
    expect(byTestId(testIds.allowlistError)).toBeNull()
    await submit()
    error = byTestId(testIds.allowlistError)!
    expect(error.dataset.code).toBe('command-runner')
    expect(error.textContent?.trim()).toBe('bash runs other commands, so it can\'t be allowed by a rule.')

    await type('ls > out.txt')
    await submit()
    expect(byTestId(testIds.allowlistError)?.dataset.code).toBe('syntax')
    await type('cd src')
    await submit()
    expect(byTestId(testIds.allowlistError)?.dataset.code).toBe('cd')
    await type('node')
    await submit()
    expect(byTestId(testIds.allowlistError)?.dataset.code).toBe('interpreter')
    expect(api.shellRules.create).not.toHaveBeenCalled()
  })

  it('says "This rule already exists." for a 409 and keeps the text', async () => {
    await mountEditor([test])
    api.shellRules.create.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'Shell rule exists.', details: { reason: 'exists' } }))
    await type('pnpm test')
    await submit()
    const error = byTestId(testIds.allowlistError)!
    expect(error.dataset.code).toBe('conflict')
    expect(error.textContent?.trim()).toBe('This rule already exists.')
    expect(input().value).toBe('pnpm test')
    expect(document.activeElement).toBe(input())
    expect(prefixes()).toEqual(['pnpm test'])
  })

  it('shows the server message for a 400 (e.g. the 200-rule cap)', async () => {
    await mountEditor([])
    api.shellRules.create.mockRejectedValueOnce(new HarnessError({ code: 'validation_error', message: 'This project already has 200 rules.' }))
    await type('pnpm test')
    await submit()
    const error = byTestId(testIds.allowlistError)!
    expect(error.dataset.code).toBe('validation_error')
    expect(error.textContent?.trim()).toBe('This project already has 200 rules.')
  })

  it('warns about a one-word prefix without blocking it', async () => {
    await mountEditor([])
    await type('make')
    const warning = document.body.querySelector<HTMLElement>('[data-slot="allowlist-warning"]')!
    expect(warning.textContent?.trim()).toBe('This allows every make command.')
    expect(input().getAttribute('aria-describedby')).toBe(warning.id)
    expect(input().hasAttribute('aria-invalid')).toBe(false)
    await type('make test')
    expect(document.body.querySelector('[data-slot="allowlist-warning"]')).toBeNull()
    await type('make')
    api.shellRules.create.mockResolvedValueOnce(make)
    await submit()
    expect(api.shellRules.create).toHaveBeenCalledWith({ body: { projectId: projectId(1), prefix: 'make' } })
    expect(document.body.querySelector('[data-slot="allowlist-warning"]')).toBeNull()
  })

  it('sends one request at a time', async () => {
    await mountEditor([])
    const answer = deferred<ShellRule>()
    api.shellRules.create.mockReturnValueOnce(answer.promise)
    await type('pnpm test')
    await submit()
    await submit()
    expect(api.shellRules.create).toHaveBeenCalledTimes(1)
    expect(byTestId(testIds.allowlistAdd)?.getAttribute('aria-busy')).toBe('true')
    answer.resolve(test)
    await flushPromises()
    expect(byTestId(testIds.allowlistAdd)?.hasAttribute('aria-busy')).toBe(false)
  })
})

describe('allowlistDialog', () => {
  it('shows "Allowed commands in {name}", the explanation and the project\'s rules, with focus on the input', async () => {
    api.shellRules.list.mockResolvedValue({ items: [test, ls] })
    const wrapper = mount(AllowlistDialog, { props: { open: true, project: projectSummary({ id: projectId(1), name: 'website' }) }, attachTo: document.body })
    wrappers.push(wrapper)
    await flushPromises()
    const dialog = byTestId(testIds.allowlistDialog)!
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.querySelector('h2')?.textContent?.trim()).toBe('Allowed commands in website')
    const description = document.getElementById(dialog.getAttribute('aria-describedby')!)
    expect(description?.textContent?.trim()).toBe(allowlistDescription('project'))
    expect(prefixes()).toEqual(['pnpm test'])
    expect(document.activeElement).toBe(input())
  })

  it('emits update:open false when closed with Escape', async () => {
    api.shellRules.list.mockResolvedValue({ items: [] })
    const wrapper = mount(AllowlistDialog, { props: { open: true, project: projectSummary({ id: projectId(1) }) }, attachTo: document.body })
    wrappers.push(wrapper)
    await flushPromises()
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(wrapper.emitted('update:open')).toEqual([[false]])
  })
})

describe('globalAllowlistSection', () => {
  it('renders "Allowed in every project" with the every-project explanation and the global rules', async () => {
    api.shellRules.list.mockResolvedValue({ items: [test, ls] })
    const wrapper = mount(GlobalAllowlistSection, { attachTo: document.body })
    wrappers.push(wrapper)
    await flushPromises()
    const section = byTestId(testIds.allowlistSection)!
    expect(section.querySelector('h2')?.textContent?.trim()).toBe('Allowed in every project')
    expect(section.textContent).toContain(allowlistDescription('global'))
    expect(section.textContent).toContain(ALLOWLIST_RISK_NOTE)
    expect(prefixes()).toEqual(['ls'])
  })
})
