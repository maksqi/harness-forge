import type { HookData } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { hookData, hookRecordId } from '~/utils/testing/fixtures'
import ToolHookBadge from './ToolHookBadge.vue'

function badge(hooks: readonly HookData[]) {
  return mount({ render: () => h(TooltipProvider, { delayDuration: 0 }, { default: () => h(ToolHookBadge, { hooks }) }) }, { attachTo: document.body })
}

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

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
