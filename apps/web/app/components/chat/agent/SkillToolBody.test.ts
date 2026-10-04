import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { skillOutput } from '~/utils/testing/fixtures'
import SkillToolBody from './SkillToolBody.vue'

// The content renders through Markdown, which reads the color mode.
vi.mock('~/components/chat/nuxt-imports', () => ({ useColorMode: () => ({ value: 'dark' }) }))

describe('skillToolBody', () => {
  it('shows the description, the base folder, the supporting files and the content with its caption', () => {
    const wrapper = mount(SkillToolBody, { props: { input: { name: 'release-notes' }, output: skillOutput() } })
    const body = wrapper.get('[data-slot="skill-body"]')
    expect(body.get('[data-slot="skill-description"]').text()).toBe('How to write the release notes')
    expect(body.get('[data-slot="skill-base-dir"]').text()).toContain('.harness/skills/release-notes')
    const files = body.get('[data-slot="skill-files"]')
    expect(files.attributes('role')).toBe('list')
    expect(files.findAll('li').map(item => item.text())).toEqual(['template.md'])
    const content = body.get('[data-slot="skill-content"]')
    expect(content.classes()).toEqual(expect.arrayContaining(['max-h-[50dvh]', 'overflow-y-auto']))
    expect(content.text()).toContain('List the user-facing changes.')
    expect(body.get('[data-slot="skill-caption"]').text()).toBe('The agent read these instructions.')
  })

  it('leaves out the folder and the files of a personal skill and says when the content was cut', () => {
    const output = skillOutput({ source: 'user', baseDir: undefined, files: undefined, truncated: true })
    const wrapper = mount(SkillToolBody, { props: { input: { name: 'release-notes' }, output } })
    expect(wrapper.find('[data-slot="skill-base-dir"]').exists()).toBe(false)
    expect(wrapper.find('[data-slot="skill-files"]').exists()).toBe(false)
    expect(wrapper.get('[data-slot="skill-caption"]').text().replace(/\s+/g, ' ')).toBe('The agent read these instructions. Cut at 64 KB.')
  })

  it('renders nothing for an output that does not parse', () => {
    const wrapper = mount(SkillToolBody, { props: { input: { name: 'x' }, output: { nope: true } } })
    expect(wrapper.find('[data-slot="skill-body"]').exists()).toBe(false)
    const missing = mount(SkillToolBody, { props: { input: { name: 'x' }, output: undefined } })
    expect(missing.find('[data-slot="skill-body"]').exists()).toBe(false)
  })
})
