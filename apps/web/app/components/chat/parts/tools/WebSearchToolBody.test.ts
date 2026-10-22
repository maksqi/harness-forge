// WebSearchToolBody (Phase 14, ADR-062, ADR-063; docs/UI.md 7.35, 10.10): the C54 stub's contract (props, the root test id
// with `data-mode` and `data-state`); W14.9 implements the body.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { searchWebOutput } from '~/utils/testing/fixtures'
import WebSearchToolBody from './WebSearchToolBody.vue'

describe('webSearchToolBody (stub)', () => {
  it('accepts its props and marks the mode and the state', async () => {
    const wrapper = mount(WebSearchToolBody, { props: { input: { query: 'harness forge' }, output: undefined, native: false, running: true } })
    const root = wrapper.get(`[data-testid="${testIds.webSearchTool}"]`)
    expect(root.attributes('data-mode')).toBe('builtin')
    expect(root.attributes('data-state')).toBe('running')
    await wrapper.setProps({ output: searchWebOutput(), running: false, native: true })
    expect(root.attributes('data-mode')).toBe('native')
    expect(root.attributes('data-state')).toBe('done')
    wrapper.unmount()
  })
})
