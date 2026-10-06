import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { trustCommandItem, trustHookItem, trustSha } from '~/utils/testing/fixtures'
import ProjectTrustItem from './ProjectTrustItem.vue'

describe('projectTrustItem (P11-0b stub)', () => {
  it('renders its root as a named article with the kind, the state and the key', () => {
    const wrapper = mount(ProjectTrustItem, { props: { item: trustHookItem({ changed: true }), selected: false, busy: false } })
    const root = wrapper.get(`[data-testid="${testIds.projectTrustItem}"]`)
    expect(root.element.tagName).toBe('ARTICLE')
    expect(root.attributes()).toMatchObject({ 'data-kind': 'hook', 'data-state': 'changed', 'data-key': trustSha(1) })
    expect(root.attributes('aria-label')).toBe('hook sh .claude/hooks/guard.sh, Changed')
  })

  it('reads an approved command item and accepts the variables', () => {
    const wrapper = mount(ProjectTrustItem, { props: { item: trustCommandItem(), selected: true, busy: true, variables: [] } })
    const root = wrapper.get(`[data-testid="${testIds.projectTrustItem}"]`)
    expect(root.attributes()).toMatchObject({ 'data-kind': 'command', 'data-state': 'approved', 'aria-busy': 'true' })
    expect(root.text()).toContain('/status')
  })
})
