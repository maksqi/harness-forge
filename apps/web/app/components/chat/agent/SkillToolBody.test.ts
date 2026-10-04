import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { skillOutput } from '~/utils/testing/fixtures'
import SkillToolBody from './SkillToolBody.vue'

describe('skillToolBody (P10-0b stub)', () => {
  it('renders the skill body for a valid output', () => {
    const wrapper = mount(SkillToolBody, { props: { input: { name: 'release-notes' }, output: skillOutput() } })
    expect(wrapper.get('[data-slot="skill-body"]').text()).toContain('How to write the release notes')
  })

  it('renders nothing for an output that does not parse', () => {
    const wrapper = mount(SkillToolBody, { props: { input: { name: 'x' }, output: { nope: true } } })
    expect(wrapper.find('[data-slot="skill-body"]').exists()).toBe(false)
  })
})
