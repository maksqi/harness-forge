// ToolRuleBadge (docs/UI.md 7.19, 7.23, 10.5; C20): nothing without prefixes; otherwise tool-row-rule with the matched
// prefixes in data-value and the sr-only ", allowed by rule {prefixes}".
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import ToolRuleBadge from './ToolRuleBadge.vue'

function mountBadge(prefixes: readonly string[]) {
  return mount({ render: () => h(TooltipProvider, null, { default: () => h(ToolRuleBadge, { prefixes }) }) }, { attachTo: document.body })
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('toolRuleBadge', () => {
  it('renders nothing without prefixes', () => {
    expect(mountBadge([]).find(`[data-testid="${testIds.toolRowRule}"]`).exists()).toBe(false)
  })

  it('names the matched prefixes for screen readers and in data-value', () => {
    const badge = mountBadge(['pnpm test', 'git status']).get(`[data-testid="${testIds.toolRowRule}"]`)
    expect(badge.attributes('data-value')).toBe('pnpm test, git status')
    expect(badge.get('.sr-only').text()).toBe(', allowed by rule pnpm test, git status')
    expect(badge.get('svg').attributes('aria-hidden')).toBe('true')
  })
})
