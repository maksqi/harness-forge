// WebSearchToggle (Phase 14, ADR-062, ADR-063; docs/UI.md 7.35, 10.10): the C54 stub's contract (props, emits, the exposed
// activate, the root test id with `data-state` / `data-mode`, `aria-pressed`, `aria-disabled`); W14.8 implements the
// tooltip, the unavailable popover and Alt+W.
import type { WebSearchResolution } from '@harness-forge/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import WebSearchToggle from './WebSearchToggle.vue'

const native: WebSearchResolution = { kind: 'native', exclusive: false }

function toggle(props: { modelValue: boolean, availability: WebSearchResolution, via: string | null, disabled?: boolean }) {
  return mount(WebSearchToggle, { props })
}

describe('webSearchToggle (stub)', () => {
  it('is a pressed toggle named "Web search" that emits the flipped value', async () => {
    const wrapper = toggle({ modelValue: false, availability: native, via: 'Anthropic' })
    const root = wrapper.get(`[data-testid="${testIds.composerWebSearch}"]`)
    expect(root.attributes('aria-label')).toBe('Web search')
    expect(root.attributes('aria-pressed')).toBe('false')
    expect(root.attributes('data-state')).toBe('off')
    expect(root.attributes('data-mode')).toBe('native')
    await root.trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[true]])
    await wrapper.setProps({ modelValue: true, availability: { kind: 'builtin' }, via: 'Brave Search' })
    expect(root.attributes('aria-pressed')).toBe('true')
    expect(root.attributes('data-state')).toBe('on')
    expect(root.attributes('data-mode')).toBe('builtin')
    ;(wrapper.vm as unknown as { activate: () => void }).activate()
    expect(wrapper.emitted('update:modelValue')).toEqual([[true], [false]])
    wrapper.unmount()
  })

  it('stays focusable but does not toggle while unavailable', async () => {
    const wrapper = toggle({ modelValue: true, availability: { kind: 'unavailable', reason: 'no-backend' }, via: null })
    const root = wrapper.get(`[data-testid="${testIds.composerWebSearch}"]`)
    expect(root.attributes('data-state')).toBe('unavailable')
    expect(root.attributes('data-mode')).toBeUndefined()
    expect(root.attributes('aria-disabled')).toBe('true')
    expect(root.attributes('disabled')).toBeUndefined()
    await root.trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    wrapper.unmount()
  })
})
