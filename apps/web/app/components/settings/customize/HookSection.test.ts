// HookSection (docs/UI.md 9.13, 9.14, 10.8; W11.8-T3, W12.12-T2): the heading and count, the project's files and "Review
// {n}…", the rows in event order with their actions, the empty states, the unavailable folder and the slots; Phase 12:
// prompt rows among command rows (sorted by their prompt) and the pending rows of an untrusted plugin.
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { testIds } from '~/utils/testids'
import { hookEntry, trustSha } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import HookSection from './HookSection.vue'

vi.mock('~/composables/useApi', () => ({ useApi: () => createMockApi() }))

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('hookSection', () => {
  it('renders its rows in event order and re-emits their actions with the entry', () => {
    const stop = hookEntry({ key: 'stop', event: 'Stop', matcher: null })
    const pre = hookEntry({ key: 'pre', event: 'PreToolUse', matcher: 'Bash' })
    const wrapper = mount(HookSection, { props: { source: 'personal', entries: [stop, pre], busyIds: [] } })
    const root = wrapper.get(`[data-testid="${testIds.hooksSection}"]`)
    expect(root.attributes()).toMatchObject({ 'data-source': 'personal', 'data-count': '2' })
    expect(root.get('h2').text()).toBe('Personal · 2')
    expect(wrapper.findAll(`[data-testid="${testIds.hookRow}"]`).map(row => row.attributes('data-event'))).toEqual(['PreToolUse', 'Stop'])
    wrapper.findAllComponents({ name: 'HookRow' })[0]!.vm.$emit('action', 'toggle')
    expect(wrapper.emitted('action')).toEqual([['toggle', pre]])
  })

  it('heads a project section with its files and Review {n}…, which emits review', async () => {
    const entry = hookEntry({ source: 'project', id: undefined, state: 'pending', path: '.claude/settings.json', sha256: trustSha(1) })
    const wrapper = mount(HookSection, { props: { source: 'project', entries: [entry], projectName: 'website', files: ['.harness/settings.json', '.claude/settings.json'], pending: 2 } })
    expect(wrapper.get('h2').text()).toBe('In website · 1')
    expect(wrapper.text()).toContain('.harness/settings.json · .claude/settings.json')
    const review = wrapper.get(`[data-testid="${testIds.customizeTrustReview}"]`)
    expect(review.attributes('data-count')).toBe('2')
    expect(review.text()).toBe('Review 2…')
    await review.trigger('click')
    expect(wrapper.emitted('review')).toHaveLength(1)
  })

  it('hides Review without pending items', () => {
    const wrapper = mount(HookSection, { props: { source: 'project', entries: [], projectName: 'website', files: [], pending: 0 } })
    expect(wrapper.find(`[data-testid="${testIds.customizeTrustReview}"]`).exists()).toBe(false)
  })

  it('shows the empty states of the personal and project sections, with the personal buttons', () => {
    const personal = mount(HookSection, {
      props: { source: 'personal', entries: [] },
      slots: { 'empty-actions': () => h('button', { 'data-action': 'new' }, 'New hook') },
    })
    const empty = personal.get(`[data-testid="${testIds.hooksEmpty}"]`)
    expect(empty.attributes('data-source')).toBe('personal')
    expect(empty.text()).toContain('No personal hooks yet. A hook runs a shell command when something happens, like before a tool call.')
    expect(empty.find('[data-action="new"]').exists()).toBe(true)

    const project = mount(HookSection, { props: { source: 'project', entries: [], projectName: 'website', files: ['.claude/settings.json'], pending: null, issue: null } })
    expect(project.get('h2').text()).toBe('In website · 0')
    expect(project.get(`[data-testid="${testIds.hooksEmpty}"]`).text()).toBe('No hooks in website. Add a "hooks" object to .harness/settings.json (or .claude/settings.json) in the project folder.')
  })

  it('replaces the rows with the issue of an unavailable folder and shows the notices', () => {
    const wrapper = mount(HookSection, {
      props: { source: 'project', entries: [hookEntry({ source: 'project' })], projectName: 'website', issue: 'The project folder is unavailable.', pending: 3 },
      slots: { notices: () => h('p', { 'data-slot': 'notice' }, '.claude/settings.json: The settings file is not valid JSON.') },
    })
    expect(wrapper.get(`[data-testid="${testIds.hooksSection}"]`).attributes('data-count')).toBe('0')
    expect(wrapper.get('[role="alert"]').text()).toBe('The project folder is unavailable.')
    expect(wrapper.find(`[data-testid="${testIds.hookRow}"]`).exists()).toBe(false)
    expect(wrapper.find(`[data-testid="${testIds.customizeTrustReview}"]`).exists()).toBe(false)
    expect(wrapper.get('[data-slot="notice"]').text()).toContain('not valid JSON')
  })

  it('titles the plugin section "From plugins"', () => {
    const wrapper = mount(HookSection, { props: { source: 'plugin', entries: [hookEntry({ source: 'plugin', pluginId: 'hook-pack', id: undefined })] } })
    expect(wrapper.get('h2').text()).toBe('From plugins · 1')
    expect(wrapper.find(`[data-testid="${testIds.hooksEmpty}"]`).exists()).toBe(false)
  })
})

describe('hookSection: Phase 12 (W12.12-T2)', () => {
  it('lists prompt rows in event order among the command rows and re-emits their actions', () => {
    const later = hookEntry({ key: 'p2', source: 'project', id: undefined, event: 'Stop', matcher: null, type: 'prompt', command: '', prompt: 'Zebra: is the work done?', path: '.claude/settings.json', position: [0, 1] })
    const earlier = hookEntry({ key: 'p1', source: 'project', id: undefined, event: 'Stop', matcher: null, type: 'prompt', command: '', prompt: 'Apple: did the tests pass?', path: '.claude/settings.json', position: [0, 0] })
    const guard = hookEntry({ key: 'c1', source: 'project', id: undefined, event: 'PreToolUse', matcher: 'Bash', path: '.harness/settings.json', position: [0, 0] })
    const wrapper = mount(HookSection, { props: { source: 'project', entries: [later, guard, earlier], projectName: 'website', files: ['.claude/settings.json', '.harness/settings.json'], pending: 3 } })
    const rows = wrapper.findAll(`[data-testid="${testIds.hookRow}"]`)
    expect(rows.map(row => [row.attributes('data-event'), row.attributes('data-kind')])).toEqual([['PreToolUse', 'command'], ['Stop', 'prompt'], ['Stop', 'prompt']])
    expect(rows[1]!.get('[data-slot="hook-row-prompt"]').text()).toBe('Apple: did the tests pass?')
    wrapper.findAllComponents({ name: 'HookRow' })[2]!.vm.$emit('action', 'review')
    expect(wrapper.emitted('action')).toEqual([['review', later]])
  })

  it('lists the pending hooks of an untrusted plugin with "Plugin not trusted"', () => {
    const pending = hookEntry({ key: 'plugin:hook-pack:0', source: 'plugin', id: undefined, pluginId: 'hook-pack', state: 'pending' })
    const wrapper = mount(HookSection, { props: { source: 'plugin', entries: [pending] } })
    const row = wrapper.get(`[data-testid="${testIds.hookRow}"]`)
    expect(row.attributes()).toMatchObject({ 'data-source': 'plugin', 'data-state': 'pending' })
    expect(row.get('[data-slot="hook-row-state"]').text()).toBe('Plugin not trusted')
  })
})
