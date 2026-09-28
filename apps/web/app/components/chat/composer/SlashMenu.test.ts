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
  { name: 'summarize', description: 'Summarize the chat', kind: 'server', source: 'Core commands' },
  { name: 'model-card', description: 'Show a model card', kind: 'server', source: 'model-tools' },
]

function key(name: string, init: KeyboardEventInit = {}) {
  return new KeyboardEvent('keydown', { key: name, cancelable: true, ...init })
}

describe('slashMenu', () => {
  it('renders App and Commands groups with the plugin on the right', () => {
    const wrapper = mount(SlashMenu, { props: { open: true, query: '', items } })
    const rows = wrapper.findAll(byTestId(testIds.slashMenuItem))
    expect(rows.map(row => `${row.attributes('data-kind')}:${row.attributes('data-value')}`)).toEqual([
      'client:new',
      'client:model',
      'client:effort',
      'client:mode',
      'client:help',
      'server:summarize',
      'server:model-card',
    ])
    expect(wrapper.findAll('[role="group"]').map(group => group.attributes('aria-label'))).toEqual(['App', 'Commands'])
    expect(rows[5]!.text()).toContain('/summarize')
    expect(rows[5]!.text()).toContain('Core commands')
    expect(rows[0]!.attributes('aria-selected')).toBe('true')
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
