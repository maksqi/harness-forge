import type { HookData } from '@harness-forge/shared'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { hookData, hookRecordId } from '~/utils/testing/fixtures'
import ToolHookBadge from './ToolHookBadge.vue'

function badge(hooks: readonly HookData[]) {
  return mount({ render: () => h(TooltipProvider, { delayDuration: 0 }, { default: () => h(ToolHookBadge, { hooks }) }) }, { attachTo: document.body })
}

/** The badge inside a row button, like ToolPart's CollapsibleTrigger. */
async function badgeInRow(hooks: readonly HookData[]) {
  const wrapper = mount({
    render: () => h(TooltipProvider, { delayDuration: 0 }, {
      default: () => h('button', { 'type': 'button', 'data-row': '' }, [h('span', 'write_file'), h(ToolHookBadge, { hooks })]),
    }),
  }, { attachTo: document.body })
  // The badge finds its row once its trigger is mounted (a post-flush watcher adds the focus listeners).
  await flushPromises()
  return { wrapper, row: wrapper.get('[data-row]').element as HTMLButtonElement }
}

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})
// Registered last, so it runs first (after hooks run in reverse order): unmount before the body is cleared.
enableAutoUnmount(afterEach)

describe('toolHookBadge', () => {
  it('reads "Blocked by hook" for a PreToolUse denial, with the screen reader text', () => {
    const root = badge([hookData()]).get(`[data-testid="${testIds.toolRowHook}"]`)
    expect(root.attributes('data-value')).toBe('denied')
    expect(root.classes()).toContain('text-destructive')
    expect(root.find('svg').classes().join(' ')).toMatch(/shield-ban/)
    expect(root.get('[aria-hidden="true"]:not(svg)').text()).toBe('Blocked by hook')
    expect(root.get('.sr-only').text()).toBe(', blocked by hook')
  })

  it('marks an allowed call with an icon and the tooltip "Allowed by hook"', async () => {
    vi.useFakeTimers()
    const wrapper = badge([hookData({ outcome: 'allowed', reason: undefined })])
    const root = wrapper.get(`[data-testid="${testIds.toolRowHook}"]`)
    expect(root.attributes('data-value')).toBe('allowed')
    expect(root.text()).toBe(', allowed by hook')
    expect(root.findAll('svg').map(icon => icon.classes().join(' '))).toEqual([expect.stringMatching(/webhook/), expect.stringMatching(/check/)])
    await root.trigger('pointermove')
    await root.trigger('pointerenter')
    await vi.advanceTimersByTimeAsync(10)
    await flushPromises()
    expect(document.body.textContent).toContain('Allowed by hook')
  })

  it('marks a rewritten call with a pencil and the tooltip "Input changed by hook"', () => {
    const root = badge([hookData({ outcome: 'rewritten', reason: undefined, updatedInput: { path: 'b' } })]).get(`[data-testid="${testIds.toolRowHook}"]`)
    expect(root.attributes('data-value')).toBe('rewritten')
    expect(root.text()).toBe(', input changed by hook')
    expect(root.findAll('svg')[1]!.classes().join(' ')).toMatch(/pencil/)
  })

  it('shows its tooltip while the row has keyboard focus; the badge itself takes no focus', async () => {
    const { row } = await badgeInRow([hookData({ outcome: 'allowed', reason: undefined })])
    const root = document.querySelector(`[data-testid="${testIds.toolRowHook}"]`)!
    expect(root.hasAttribute('tabindex')).toBe(false)
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull()

    row.focus()
    await flushPromises()
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('Allowed by hook')

    row.blur()
    await flushPromises()
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull()

    // Escape closes it while the row keeps its focus.
    row.focus()
    await flushPromises()
    expect(document.body.textContent).toContain('Allowed by hook')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('keeps the tooltip closed when the row got its focus from a click (not :focus-visible)', async () => {
    const { row } = await badgeInRow([hookData({ outcome: 'rewritten', reason: undefined, updatedInput: { path: 'b' } })])
    const original = Element.prototype.matches
    const matches = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      return selector === ':focus-visible' ? false : original.call(this, selector)
    })
    row.focus()
    await flushPromises()
    matches.mockRestore()
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('renders nothing without a PreToolUse record of a badge outcome', () => {
    const post = hookData({ id: hookRecordId(2), event: 'PostToolUse', outcome: 'context', context: 'ok' })
    const asked = hookData({ id: hookRecordId(3), outcome: 'asked' })
    const postDenied = hookData({ id: hookRecordId(4), event: 'PostToolUse', outcome: 'blocked' })
    expect(badge([]).find(`[data-testid="${testIds.toolRowHook}"]`).exists()).toBe(false)
    expect(badge([post, asked, postDenied]).find(`[data-testid="${testIds.toolRowHook}"]`).exists()).toBe(false)
    const rewritten = badge([post, hookData({ outcome: 'rewritten', updatedInput: { path: 'a' } })])
    expect(rewritten.get(`[data-testid="${testIds.toolRowHook}"]`).attributes('data-value')).toBe('rewritten')
  })
})

describe('toolHookBadge: Phase 12 (W12.13-T3)', () => {
  it('reads "Allowed by hook · still asks" for an allow harness-forge did not follow', async () => {
    const { row } = await badgeInRow([hookData({ outcome: 'allowed', reason: undefined, harnessAsked: true })])
    const root = document.querySelector<HTMLElement>(`[data-testid="${testIds.toolRowHook}"]`)!
    expect(root.dataset).toMatchObject({ value: 'allowed', state: 'still-asks' })
    expect(root.querySelector('.sr-only')!.textContent).toBe(', allowed by hook, still asks')
    row.focus()
    await flushPromises()
    const tooltip = document.body.querySelector('[role="tooltip"]')!
    expect(tooltip.textContent).toContain('Allowed by hook · still asks')
    expect(tooltip.textContent).toContain('harness-forge still asks for this call (plan mode, a tool that runs commands, or an Always ask policy).')
  })

  it('has no still-asks state for a plain allow', () => {
    const root = badge([hookData({ outcome: 'allowed', reason: undefined })]).get(`[data-testid="${testIds.toolRowHook}"]`)
    expect(root.attributes('data-state')).toBeUndefined()
  })

  it('shows a PermissionRequest decision like a PreToolUse one, before it', () => {
    const pre = hookData({ id: hookRecordId(1), outcome: 'allowed', harnessAsked: true, reason: undefined })
    const denied = badge([pre, hookData({ id: hookRecordId(2), event: 'PermissionRequest', outcome: 'denied' })]).get(`[data-testid="${testIds.toolRowHook}"]`)
    expect(denied.attributes('data-value')).toBe('denied')
    expect(denied.text()).toContain('Blocked by hook')
    const allowed = badge([pre, hookData({ id: hookRecordId(3), event: 'PermissionRequest', outcome: 'allowed', reason: undefined })]).get(`[data-testid="${testIds.toolRowHook}"]`)
    expect(allowed.attributes('data-value')).toBe('allowed')
    expect(allowed.attributes('data-state')).toBeUndefined()
    // A PostToolUseFailure record alone marks nothing.
    expect(badge([hookData({ event: 'PostToolUseFailure', outcome: 'blocked' })]).find(`[data-testid="${testIds.toolRowHook}"]`).exists()).toBe(false)
  })

  it('marks no decision for a PermissionRequest prompt hook\'s "no" that changed nothing (W12.17-T2)', () => {
    // W12.5 stores it as outcome `context` with the answer in `reason`: the card still asked, so nothing was blocked;
    // the reason shows in the row's HookNote ("A PermissionRequest hook answered: {reason}").
    const answered = hookData({
      id: hookRecordId(5),
      event: 'PermissionRequest',
      outcome: 'context',
      context: undefined,
      reason: 'Deleting files needs a person.',
      hooks: [{ source: 'personal', label: 'Should this run without asking?', exitCode: null, durationMs: 800, kind: 'prompt', model: 'mock:prompt-hook' }],
    })
    expect(badge([answered]).find(`[data-testid="${testIds.toolRowHook}"]`).exists()).toBe(false)
    // The PreToolUse decision still shows.
    const pre = hookData({ id: hookRecordId(1), outcome: 'allowed', harnessAsked: true, reason: undefined })
    const root = badge([pre, answered]).get(`[data-testid="${testIds.toolRowHook}"]`)
    expect(root.attributes()).toMatchObject({ 'data-value': 'allowed', 'data-state': 'still-asks' })
    expect(root.text()).not.toContain('Deleting files')
  })
})
