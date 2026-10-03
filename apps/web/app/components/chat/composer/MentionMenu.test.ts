import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { projectFileEntry } from '~/utils/testing/fixtures'
import MentionMenu from './MentionMenu.vue'

const props = {
  open: true,
  query: 'pars',
  items: [projectFileEntry('src/parser.ts'), projectFileEntry('src/parsers', 'dir')],
  state: 'ready' as const,
  truncated: false,
  projectName: 'harness-forge',
}

describe('mentionMenu (P9-0b stub)', () => {
  it('renders a listbox while open, with the state and the count', () => {
    const wrapper = mount(MentionMenu, { props })
    const root = wrapper.get(`[data-testid="${testIds.mentionMenu}"]`)
    expect(root.attributes()).toMatchObject({ 'role': 'listbox', 'aria-label': 'Files in harness-forge', 'data-state': 'ready', 'data-count': '2' })
    expect(root.attributes('id')).toBe(wrapper.vm.listId)
    expect(mount(MentionMenu, { props: { ...props, state: 'loading' } }).get(`[data-testid="${testIds.mentionMenu}"]`).attributes('aria-busy')).toBe('true')
  })

  it('renders nothing while closed and exposes the SlashMenu contract', () => {
    const wrapper = mount(MentionMenu, { props: { ...props, open: false, errorMessage: null } })
    expect(wrapper.find(`[data-testid="${testIds.mentionMenu}"]`).exists()).toBe(false)
    expect(wrapper.vm.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))).toBe(false)
    expect(wrapper.vm.activeId).toBeUndefined()
    expect(wrapper.vm.listId).toMatch(/^mention-menu-/)
  })
})
