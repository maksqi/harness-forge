// HookRow (docs/UI.md 9.13, 10.8, 13.12; W11.8-T3): the row's data attributes, event, matcher and command, the state
// badges, the meta line, the problems of an invalid row, and the row menu per source (emitted once the menu has closed).
import type { HookEntry } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, nextTick, provide } from 'vue'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import { codeHookEntry, hookEntry, hookId, pluginSummary, trustSha } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { HOOK_ROW_CONTEXT } from './customize-context'
import HookRow from './HookRow.vue'

vi.mock('~/composables/useApi', () => ({ useApi: () => createMockApi() }))

let wrapper: VueWrapper | null = null

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
})

function mountRow(entry: HookEntry, busy = false) {
  const actions: string[] = []
  const Host = defineComponent({
    setup: () => () => h('ul', null, [h(HookRow, { entry, busy, onAction: (action: string) => actions.push(action) })]),
  })
  wrapper = mount(Host, { attachTo: document.body })
  return { actions, row: () => document.body.querySelector<HTMLElement>(`[data-testid="${testIds.hookRow}"]`)! }
}

function byTestId(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

async function openMenu(row: HTMLElement) {
  row.querySelector<HTMLElement>(`[data-testid="${testIds.hookRowMenu}"]`)!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await flushPromises()
}

async function choose(element: HTMLElement | null) {
  element!.click()
  await flushPromises()
  await nextTick()
  await flushPromises()
}

function menuItems(): string[] {
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(item => item.textContent?.trim() ?? '')
}

describe('hookRow', () => {
  it('renders a personal command hook: attributes, event, matcher, command and meta', () => {
    const { row } = mountRow(hookEntry({ timeout: 30 }), true)
    expect(row().dataset).toMatchObject({ source: 'personal', event: 'PostToolUse', kind: 'command', state: 'active', hookId: hookId(1) })
    expect(row().getAttribute('aria-busy')).toBe('true')
    expect(row().dataset.path).toBeUndefined()
    expect(row().querySelector('[data-slot="hook-row-matcher"]')?.textContent).toBe('Write|Edit')
    const command = row().querySelector<HTMLElement>('[data-slot="hook-row-command"]')!
    expect(command.textContent).toBe('sh .claude/hooks/format.sh')
    expect(command.title).toBe('sh .claude/hooks/format.sh')
    expect(row().textContent).toContain('Personal')
    expect(row().textContent).toContain('timeout 30s')
    expect(row().querySelector('[data-slot="hook-row-state"]')).toBeNull()
    expect(row().querySelector(`[data-testid="${testIds.hookRowMenu}"]`)?.getAttribute('aria-label')).toBe('Actions for PostToolUse hook')
  })

  it('shows "All tools" for an every-tool matcher and truncates a long command in the middle', () => {
    const long = `sh ${'very/long/path/'.repeat(8)}check.sh --strict`
    const { row } = mountRow(hookEntry({ event: 'PreToolUse', matcher: null, command: long }))
    expect(row().querySelector('[data-slot="hook-row-matcher"]')?.textContent).toBe('All tools')
    const command = row().querySelector<HTMLElement>('[data-slot="hook-row-command"]')!
    expect(command.textContent).toContain('…')
    expect(command.textContent?.endsWith('check.sh --strict')).toBe(true)
    expect(command.title).toBe(long)
  })

  it('shows the state badges of project, off, blocked and invalid rows', () => {
    const pending = mountRow(hookEntry({ source: 'project', id: undefined, state: 'pending', path: '.claude/settings.json', sha256: trustSha(1) }))
    expect(pending.row().dataset).toMatchObject({ source: 'project', path: '.claude/settings.json', state: 'pending' })
    expect(pending.row().querySelector('[data-slot="hook-row-state"]')?.textContent?.trim()).toBe('Needs approval')
    expect(pending.row().textContent).toContain('Project')
    wrapper!.unmount()

    const approved = mountRow(hookEntry({ source: 'project', id: undefined, state: 'active', path: '.claude/settings.json', sha256: trustSha(1) }))
    expect(approved.row().querySelector('[data-slot="hook-row-state"]')?.textContent?.trim()).toBe('Approved')
    wrapper!.unmount()

    expect(mountRow(hookEntry({ state: 'off' })).row().querySelector('[data-slot="hook-row-state"]')?.textContent?.trim()).toBe('Off')
    wrapper!.unmount()
    expect(mountRow(hookEntry({ state: 'blocked' })).row().querySelector('[data-slot="hook-row-state"]')?.textContent?.trim()).toBe('Off on this server')
    wrapper!.unmount()

    const invalid = mountRow(hookEntry({ state: 'invalid', matcher: '^Bash', diagnostics: [{ level: 'error', code: 'invalid-matcher', message: 'The matcher uses regular-expression syntax; use tool names, "|" and "*" only. The hooks of this group never run.' }, { level: 'info', code: 'ignored-field', message: 'The field "x" is ignored.' }] }))
    expect(invalid.row().querySelector('[data-slot="hook-row-state"]')?.textContent?.trim()).toBe('Invalid')
    const problems = invalid.row().querySelector('[data-slot="hook-row-diagnostics"]')!
    expect(problems.querySelectorAll('li')).toHaveLength(1)
    expect(problems.textContent).toContain('regular-expression syntax')
  })

  it('names the plugin of a plugin hook and says when the plugin is not trusted', () => {
    usePluginsStore().items = [pluginSummary({ id: 'hook-pack', name: 'Hook pack', state: 'untrusted' })]
    const { row } = mountRow(hookEntry({ key: 'plugin:hook-pack:0', source: 'plugin', id: undefined, pluginId: 'hook-pack' }))
    expect(row().dataset.pluginId).toBe('hook-pack')
    expect(row().textContent).toContain('Hook pack')
    expect(row().querySelector('[data-slot="hook-row-state"]')?.textContent?.trim()).toBe('Plugin not trusted')
  })

  it('offers Edit, Duplicate, Turn off, Copy as JSON and Delete for a personal row', async () => {
    const { row, actions } = mountRow(hookEntry())
    await openMenu(row())
    expect(menuItems()).toEqual(['Edit…', 'Duplicate', 'Turn off', 'Copy as JSON', 'Delete…'])
    expect(byTestId(testIds.hookToggle)?.dataset.state).toBe('on')
    await choose(byTestId(testIds.hookToggle))
    expect(actions).toEqual(['toggle'])
    await openMenu(row())
    await choose(byTestId(testIds.hookCopyJson))
    await openMenu(row())
    await choose(byTestId(testIds.hookDelete))
    expect(actions).toEqual(['toggle', 'copy-json', 'delete'])
  })

  it('offers Turn on for an off row and disables toggle and delete while busy', async () => {
    const { row } = mountRow(hookEntry({ state: 'off' }), true)
    await openMenu(row())
    expect(byTestId(testIds.hookToggle)?.textContent?.trim()).toBe('Turn on')
    expect(byTestId(testIds.hookToggle)?.dataset.state).toBe('off')
    expect(byTestId(testIds.hookToggle)?.hasAttribute('data-disabled')).toBe(true)
    expect(byTestId(testIds.hookDelete)?.hasAttribute('data-disabled')).toBe(true)
  })

  it('offers Review, Copy to personal and Copy as JSON for a project row', async () => {
    const { row, actions } = mountRow(hookEntry({ source: 'project', id: undefined, state: 'pending', path: '.claude/settings.json', sha256: trustSha(1) }))
    await openMenu(row())
    expect(menuItems()).toEqual(['Review…', 'Copy to personal', 'Copy as JSON'])
    await choose(byTestId(testIds.hookReview))
    await openMenu(row())
    await choose(byTestId(testIds.hookDuplicate))
    expect(actions).toEqual(['review', 'duplicate'])
  })

  it('offers Open plugin and Copy as JSON for a plugin command hook, Open plugin for a code hook', async () => {
    const command = mountRow(hookEntry({ key: 'plugin:hook-pack:0', source: 'plugin', id: undefined, pluginId: 'hook-pack' }))
    await openMenu(command.row())
    expect(menuItems()).toEqual(['Open plugin', 'Copy as JSON'])
    await choose(document.body.querySelector<HTMLElement>('[data-action="open-plugin"]'))
    expect(command.actions).toEqual(['open-plugin'])
    wrapper!.unmount()

    const code = mountRow(codeHookEntry())
    expect(code.row().dataset).toMatchObject({ kind: 'code', event: 'prompt.submit', pluginId: 'hook-pack' })
    expect(code.row().textContent).toContain('Code hook')
    expect(code.row().querySelector('[data-slot="hook-row-command"]')).toBeNull()
    await openMenu(code.row())
    expect(menuItems()).toEqual(['Open plugin'])
  })
})

describe('hookRow: Phase 12 (C46-T7)', () => {
  it('offers Review plugin… for the hook of a plugin that is not trusted', async () => {
    const pending = mountRow(hookEntry({ key: 'plugin:hook-pack:0', source: 'plugin', id: undefined, pluginId: 'hook-pack', state: 'pending' }))
    await openMenu(pending.row())
    expect(menuItems()).toEqual(['Review plugin…', 'Open plugin', 'Copy as JSON'])
    await choose(document.body.querySelector<HTMLElement>('[data-action="trust-plugin"]'))
    expect(pending.actions).toEqual(['trust-plugin'])
  })

  it('offers Edit… on a project row when the panel allows it, and marks prompt rows', async () => {
    const actions: string[] = []
    const entry = hookEntry({ source: 'project', id: undefined, state: 'pending', path: '.claude/settings.json', sha256: trustSha(1) })
    const Host = defineComponent({
      setup() {
        provide(HOOK_ROW_CONTEXT, { editProjectHooks: computed(() => true) })
        return () => h('ul', null, [h(HookRow, { entry, onAction: (action: string) => actions.push(action) })])
      },
    })
    wrapper = mount(Host, { attachTo: document.body })
    const row = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.hookRow}"]`)!
    await openMenu(row)
    expect(menuItems()).toEqual(['Edit…', 'Review…', 'Copy to personal', 'Copy as JSON'])
    await choose(byTestId(testIds.hookEdit))
    expect(actions).toEqual(['edit'])
    wrapper.unmount()
    wrapper = null

    const prompt = mountRow(hookEntry({ type: 'prompt', command: '', prompt: 'Did the tests pass?' }))
    expect(prompt.row().dataset.kind).toBe('prompt')
  })
})
