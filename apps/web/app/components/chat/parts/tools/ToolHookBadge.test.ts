import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { hookData, hookRecordId } from '~/utils/testing/fixtures'
import ToolHookBadge from './ToolHookBadge.vue'

describe('toolHookBadge (P11-0b stub)', () => {
  it('renders the outcome of the PreToolUse record', () => {
    const wrapper = mount(ToolHookBadge, { props: { hooks: [hookData()] } })
    const root = wrapper.get(`[data-testid="${testIds.toolRowHook}"]`)
    expect(root.attributes('data-value')).toBe('denied')
    expect(root.text()).toBe(', blocked by hook')
  })

  it('renders nothing without a PreToolUse record of a badge outcome', () => {
    const post = hookData({ id: hookRecordId(2), event: 'PostToolUse', outcome: 'context', context: 'ok' })
    const asked = hookData({ id: hookRecordId(3), outcome: 'asked' })
    expect(mount(ToolHookBadge, { props: { hooks: [] } }).find(`[data-testid="${testIds.toolRowHook}"]`).exists()).toBe(false)
    expect(mount(ToolHookBadge, { props: { hooks: [post, asked] } }).find(`[data-testid="${testIds.toolRowHook}"]`).exists()).toBe(false)
    const rewritten = mount(ToolHookBadge, { props: { hooks: [post, hookData({ outcome: 'rewritten', updatedInput: { path: 'a' } })] } })
    expect(rewritten.get(`[data-testid="${testIds.toolRowHook}"]`).attributes('data-value')).toBe('rewritten')
  })
})
