import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { skillOutput } from '~/utils/testing/fixtures'
import { SKILL_FORK_CHECK } from './agent-tools'
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

describe('skillToolBody: skill files and fork reports (Phase 12, W12.13-T5)', () => {
  const fileOutput = skillOutput({
    name: 'review-kit:pdf',
    source: 'plugin',
    content: '',
    baseDir: undefined,
    files: ['scripts/fill.sh', 'forms.md'],
    fileAccess: 'skill',
    file: { path: 'scripts/fill.sh', content: '#!/bin/sh\n# <b>not html</b>\necho "$1"', truncated: true },
  })

  it('shows a supporting file the agent read as plain text, with its path and caption', () => {
    const wrapper = mount(SkillToolBody, { props: { input: { name: 'review-kit:pdf', file: 'scripts/fill.sh' }, output: fileOutput } })
    const body = wrapper.get('[data-slot="skill-body"]')
    expect(body.attributes('data-mode')).toBe('file')
    expect(body.get('[data-slot="skill-file-path"]').text()).toBe('scripts/fill.sh')
    const pre = body.get('[data-slot="skill-file-content"]')
    expect(pre.element.tagName).toBe('PRE')
    expect(pre.text()).toBe('#!/bin/sh\n# <b>not html</b>\necho "$1"')
    expect(pre.find('b').exists()).toBe(false)
    expect(pre.classes()).toEqual(expect.arrayContaining(['max-h-[50dvh]', 'overflow-auto']))
    expect(body.get('[data-slot="skill-caption"]').text().replace(/\s+/g, ' ')).toBe('The agent read this file of the skill. Cut at 64 KB.')
    // The file replaces the list of files and the instructions.
    expect(body.find('[data-slot="skill-files"]').exists()).toBe(false)
    expect(body.find('[data-slot="skill-content"]').exists()).toBe(false)
  })

  it('reads a fork skill\'s content as its report when the chat says the skill runs as a sub-agent', () => {
    const output = skillOutput({ name: 'review-kit:audit', source: 'plugin', baseDir: undefined, files: undefined, content: 'Found **2** issues.' })
    const forked = mount(SkillToolBody, {
      props: { input: { name: 'review-kit:audit' }, output },
      global: { provide: { [SKILL_FORK_CHECK as symbol]: (name: string) => name === 'review-kit:audit' } },
    })
    expect(forked.get('[data-slot="skill-body"]').attributes('data-mode')).toBe('report')
    expect(forked.text()).toContain('Report')
    expect(forked.get('[data-slot="skill-content"]').text()).toContain('Found 2 issues.')
    expect(forked.get('[data-slot="skill-caption"]').text()).toBe('The skill ran as a sub-agent. This is its report.')
    // Without the check (a share page) the content reads as instructions.
    const plain = mount(SkillToolBody, { props: { input: { name: 'review-kit:audit' }, output } })
    expect(plain.get('[data-slot="skill-body"]').attributes('data-mode')).toBe('instructions')
    expect(plain.get('[data-slot="skill-caption"]').text()).toBe('The agent read these instructions.')
  })
})
