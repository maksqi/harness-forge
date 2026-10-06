import type { SlashItem } from './slash-commands'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { testIds } from '~/utils/testids'
import { byTestId } from './composer-test-utils'
import { clientSlashItems } from './slash-commands'
import SlashMenu from './SlashMenu.vue'

// The shared test helpers import the stores, which import useApi ('#imports' does not resolve in Vitest).
vi.mock('~/composables/useApi', () => ({ useApi: () => ({}) }))

const items: SlashItem[] = [
  ...clientSlashItems(),
  { name: 'summarize', description: 'Summarize the chat', kind: 'server', source: 'Core commands', group: 'plugin' },
  { name: 'model-card', description: 'Show a model card', kind: 'server', source: 'model-tools', group: 'plugin' },
]

/** The groups' names, from the headings their `aria-labelledby` points at. */
function groupLabels(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('[role="group"]').map((group) => {
    const heading = wrapper.find(`#${group.attributes('aria-labelledby')}`)
    expect(heading.attributes('aria-hidden')).toBe('true')
    return heading.text()
  })
}

function key(name: string, init: KeyboardEventInit = {}) {
  return new KeyboardEvent('keydown', { key: name, cancelable: true, ...init })
}

describe('slashMenu', () => {
  it('renders the App and Plugins groups with the plugin on the right', () => {
    const wrapper = mount(SlashMenu, { props: { open: true, query: '', items } })
    const rows = wrapper.findAll(byTestId(testIds.slashMenuItem))
    expect(rows.map(row => `${row.attributes('data-kind')}:${row.attributes('data-value')}`)).toEqual([
      'client:new',
      'client:model',
      'client:effort',
      'client:mode',
      'client:help',
      'client:remember',
      'client:output-style',
      'server:summarize',
      'server:model-card',
    ])
    expect(groupLabels(wrapper)).toEqual(['App', 'Plugins'])
    expect(rows[7]!.text()).toContain('/summarize')
    expect(rows[7]!.text()).toContain('Core commands')
    expect(rows[7]!.attributes('data-group')).toBe('plugin')
    expect(rows[5]!.attributes()).toMatchObject({ 'data-group': 'app', 'aria-label': '/remember, Save a note to your instructions' })
    expect(rows[0]!.attributes('aria-selected')).toBe('true')
  })

  it('shows the four groups in order with their headings, hints and namespaces (Phase 10)', () => {
    const grouped: SlashItem[] = [
      ...items,
      { name: 'compact', description: 'Summarize the conversation', kind: 'server', source: 'Agent tools', group: 'app', argumentHint: '[focus]' },
      { name: 'standup', description: 'Draft my standup notes', kind: 'server', group: 'personal' },
      { name: 'review', description: 'Review a file for bugs', kind: 'server', group: 'project', namespace: 'frontend', argumentHint: '<file> [focus]' },
    ]
    const wrapper = mount(SlashMenu, { props: { open: true, query: '', items: grouped } })
    expect(groupLabels(wrapper)).toEqual(['App', 'Project', 'Personal', 'Plugins'])
    expect(wrapper.findAll('[data-group]:not([data-testid])').map(heading => heading.attributes('data-group'))).toEqual(['app', 'project', 'personal', 'plugin'])
    const rows = wrapper.findAll(byTestId(testIds.slashMenuItem))
    expect(rows.map(row => `${row.attributes('data-group')}:${row.attributes('data-value')}`)).toEqual([
      'app:new',
      'app:model',
      'app:effort',
      'app:mode',
      'app:help',
      'app:remember',
      'app:output-style',
      'app:compact',
      'project:review',
      'personal:standup',
      'plugin:summarize',
      'plugin:model-card',
    ])
    // The option ids follow the visual order, so ↓ walks the rows top to bottom.
    expect(rows.map(row => row.attributes('id'))).toEqual(rows.map((_row, index) => expect.stringMatching(new RegExp(`-option-${index}$`))))

    const review = rows[8]!
    expect(review.attributes('aria-label')).toBe('/review, Review a file for bugs, arguments <file> [focus]')
    const hint = review.get('[data-slot="slash-menu-hint"]')
    expect(hint.text()).toBe('<file> [focus]')
    expect(hint.classes()).toEqual(expect.arrayContaining(['hidden', 'sm:inline', 'font-mono']))
    expect(review.get('[data-slot="slash-menu-detail"]').text()).toBe('frontend')
    // /compact (harness) and personal rows have nothing on the right; plugin rows the plugin name.
    expect(rows[7]!.find('[data-slot="slash-menu-detail"]').exists()).toBe(false)
    expect(rows[7]!.get('[data-slot="slash-menu-hint"]').text()).toBe('[focus]')
    expect(rows[9]!.find('[data-slot="slash-menu-detail"]').exists()).toBe(false)
    expect(rows[10]!.get('[data-slot="slash-menu-detail"]').text()).toBe('Core commands')
  })

  it('lists the Skills group last with the source and BookOpen, and badges pending project commands (Phase 11)', async () => {
    const grouped: SlashItem[] = [
      ...items,
      { name: 'release-notes', description: 'Write release notes', kind: 'server', group: 'skill', skill: true, source: 'Project', argumentHint: '<version>' },
      { name: 'deploy', description: 'Deploy the app', kind: 'server', group: 'project', namespace: 'ops', pending: true },
      { name: 'standup', description: 'Draft my standup notes', kind: 'server', group: 'personal' },
    ]
    const wrapper = mount(SlashMenu, { props: { open: true, query: '', items: grouped } })
    expect(groupLabels(wrapper)).toEqual(['App', 'Project', 'Personal', 'Plugins', 'Skills'])
    const rows = wrapper.findAll(byTestId(testIds.slashMenuItem))
    const skill = rows.at(-1)!
    expect(skill.attributes()).toMatchObject({ 'data-group': 'skill', 'data-value': 'release-notes', 'aria-label': '/release-notes, Write release notes, arguments <version>' })
    expect(skill.get('[data-slot="slash-menu-detail"]').text()).toBe('Project')
    expect(skill.get('[data-slot="slash-menu-hint"]').text()).toBe('<version>')
    expect(skill.find('svg[aria-hidden="true"]').exists()).toBe(true)
    expect(skill.attributes('data-trust')).toBeUndefined()

    const deploy = wrapper.get(`${byTestId(testIds.slashMenuItem)}[data-value="deploy"]`)
    expect(deploy.attributes()).toMatchObject({ 'data-group': 'project', 'data-trust': 'pending', 'aria-label': '/deploy, Deploy the app, needs approval' })
    expect(deploy.get('[data-slot="slash-menu-trust"]').text()).toBe('Needs approval')
    expect(deploy.get('[data-slot="slash-menu-detail"]').text()).toBe('ops')
    expect(wrapper.get(`${byTestId(testIds.slashMenuItem)}[data-value="standup"]`).attributes('data-trust')).toBeUndefined()

    // Picking a pending command still inserts it.
    await wrapper.setProps({ query: 'dep' })
    const vm = wrapper.vm as unknown as { handleKeydown: (event: KeyboardEvent) => boolean }
    vm.handleKeydown(key('Enter'))
    expect(wrapper.emitted('select')?.[0]?.[0]).toMatchObject({ name: 'deploy', pending: true })
  })

  it('truncates a long skill name instead of widening the row', () => {
    const long = `a${'b'.repeat(63)}`
    const wrapper = mount(SlashMenu, { props: { open: true, query: 'a', items: [{ name: long, description: 'Long', kind: 'server', group: 'skill', skill: true, source: 'Personal' }] } })
    const name = wrapper.get(byTestId(testIds.slashMenuItem)).get('span')
    expect(name.text()).toBe(`/${long}`)
    expect(name.classes()).toEqual(expect.arrayContaining(['truncate', 'max-w-[60%]']))
  })

  it('shows a heading only for groups with a match', async () => {
    const grouped: SlashItem[] = [
      ...items,
      { name: 'review', description: 'Review a file', kind: 'server', group: 'project' },
    ]
    const wrapper = mount(SlashMenu, { props: { open: true, query: 'rev', items: grouped } })
    expect(groupLabels(wrapper)).toEqual(['Project'])
    await wrapper.setProps({ query: 'rem' })
    expect(groupLabels(wrapper)).toEqual(['App'])
  })

  it('filters by prefix and hides when nothing matches or closed', async () => {
    const wrapper = mount(SlashMenu, { props: { open: true, query: 'mo', items } })
    expect(wrapper.findAll(byTestId(testIds.slashMenuItem)).map(row => row.attributes('data-value'))).toEqual(['model', 'mode', 'model-card'])
    await wrapper.setProps({ query: 'zzz' })
    expect(wrapper.find(byTestId(testIds.slashMenu)).exists()).toBe(false)
    await wrapper.setProps({ query: '', open: false })
    expect(wrapper.find(byTestId(testIds.slashMenu)).exists()).toBe(false)
  })

  it('moves with the arrow keys and picks with Enter or Tab', async () => {
    const wrapper = mount(SlashMenu, { props: { open: true, query: 'mo', items } })
    const vm = wrapper.vm as unknown as { handleKeydown: (event: KeyboardEvent) => boolean, activeId?: string }
    const down = key('ArrowDown')
    expect(vm.handleKeydown(down)).toBe(true)
    expect(down.defaultPrevented).toBe(true)
    await nextTick()
    expect(wrapper.findAll(byTestId(testIds.slashMenuItem))[1]!.attributes('aria-selected')).toBe('true')
    expect(vm.activeId).toBe(wrapper.findAll(byTestId(testIds.slashMenuItem))[1]!.attributes('id'))

    expect(vm.handleKeydown(key('Enter'))).toBe(true)
    expect(wrapper.emitted('select')?.[0]?.[0]).toMatchObject({ name: 'mode', kind: 'client' })

    vm.handleKeydown(key('ArrowUp'))
    vm.handleKeydown(key('ArrowUp'))
    vm.handleKeydown(key('Tab'))
    expect(wrapper.emitted('select')?.[1]?.[0]).toMatchObject({ name: 'model-card', kind: 'server' })
  })

  it('highlights a fully typed name over longer matches', async () => {
    const wrapper = mount(SlashMenu, { props: { open: true, query: 'model', items } })
    expect(wrapper.findAll(byTestId(testIds.slashMenuItem)).map(row => row.attributes('data-value'))).toEqual(['model', 'model-card'])
    await wrapper.setProps({ query: 'mode' })
    const rows = wrapper.findAll(byTestId(testIds.slashMenuItem))
    expect(rows.map(row => row.attributes('data-value'))).toEqual(['model', 'mode', 'model-card'])
    expect(rows[1]!.attributes('aria-selected')).toBe('true')
    const vm = wrapper.vm as unknown as { handleKeydown: (event: KeyboardEvent) => boolean }
    vm.handleKeydown(key('Enter'))
    expect(wrapper.emitted('select')?.[0]?.[0]).toMatchObject({ name: 'mode' })
  })

  it('closes on Escape and ignores keys it does not own', () => {
    const wrapper = mount(SlashMenu, { props: { open: true, query: '', items } })
    const vm = wrapper.vm as unknown as { handleKeydown: (event: KeyboardEvent) => boolean }
    expect(vm.handleKeydown(key('Escape'))).toBe(true)
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(vm.handleKeydown(key('Enter', { shiftKey: true }))).toBe(false)
    expect(vm.handleKeydown(key('a'))).toBe(false)
    expect(vm.handleKeydown(key('Enter', { isComposing: true } as KeyboardEventInit))).toBe(false)
  })

  it('does nothing while closed', () => {
    const wrapper = mount(SlashMenu, { props: { open: false, query: '', items } })
    const vm = wrapper.vm as unknown as { handleKeydown: (event: KeyboardEvent) => boolean }
    expect(vm.handleKeydown(key('Enter'))).toBe(false)
  })

  it('picks a row on click without taking focus from the textarea', async () => {
    const wrapper = mount(SlashMenu, { props: { open: true, query: 'he', items } })
    const row = wrapper.get(byTestId(testIds.slashMenuItem))
    const mousedown = new MouseEvent('mousedown', { cancelable: true, bubbles: true })
    row.element.dispatchEvent(mousedown)
    expect(mousedown.defaultPrevented).toBe(true)
    await row.trigger('click')
    expect(wrapper.emitted('select')?.[0]?.[0]).toMatchObject({ name: 'help' })
  })
})
