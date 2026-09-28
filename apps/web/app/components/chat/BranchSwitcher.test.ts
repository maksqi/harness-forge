import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import BranchSwitcher from './BranchSwitcher.vue'

const SIBLINGS = ['msg_version000000001', 'msg_version000000002', 'msg_version000000003']

function mountSwitcher(props: { siblings?: string[], index: number, disabled?: boolean }) {
  return mount(BranchSwitcher, { props: { siblings: SIBLINGS, ...props }, attachTo: document.body })
}

type Wrapper = ReturnType<typeof mountSwitcher>

function previous(wrapper: Wrapper) {
  return wrapper.get(`[data-testid="${testIds.messageBranchPrevious}"]`)
}

function next(wrapper: Wrapper) {
  return wrapper.get(`[data-testid="${testIds.messageBranchNext}"]`)
}

function selected(wrapper: Wrapper): string[] {
  return (wrapper.emitted('select') ?? []).map(([messageId]) => messageId as string)
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('branchSwitcher', () => {
  it('labels the group, the buttons and the counter', () => {
    const wrapper = mountSwitcher({ index: 1 })
    const root = wrapper.get(`[data-testid="${testIds.messageBranch}"]`)
    expect(root.attributes()).toMatchObject({
      'role': 'group',
      'aria-label': 'Message versions',
      'data-message-id': SIBLINGS[1],
      'data-index': '1',
      'data-count': '3',
    })
    expect(previous(wrapper).attributes('aria-label')).toBe('Previous version')
    expect(next(wrapper).attributes('aria-label')).toBe('Next version')
    const counter = wrapper.get(`[data-testid="${testIds.messageBranchCounter}"]`)
    expect(counter.text()).toBe('2/3')
    expect(counter.attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('.sr-only').text()).toBe('Version 2 of 3')
    // Both buttons are enabled in the middle.
    expect(previous(wrapper).attributes('aria-disabled')).toBeUndefined()
    expect(next(wrapper).attributes('aria-disabled')).toBeUndefined()
  })

  it('selects the neighbor on click', async () => {
    const wrapper = mountSwitcher({ index: 1 })
    await previous(wrapper).trigger('click')
    await next(wrapper).trigger('click')
    expect(selected(wrapper)).toEqual([SIBLINGS[0], SIBLINGS[2]])
  })

  it('marks the ends aria-disabled (never natively disabled) and selects nothing past them', async () => {
    const first = mountSwitcher({ index: 0 })
    expect(previous(first).attributes('aria-disabled')).toBe('true')
    expect(previous(first).attributes('disabled')).toBeUndefined()
    await previous(first).trigger('click')
    expect(selected(first)).toEqual([])
    await next(first).trigger('click')
    expect(selected(first)).toEqual([SIBLINGS[1]])

    const last = mountSwitcher({ index: 2 })
    expect(last.get(`[data-testid="${testIds.messageBranchCounter}"]`).text()).toBe('3/3')
    expect(next(last).attributes('aria-disabled')).toBe('true')
    expect(next(last).attributes('disabled')).toBeUndefined()
    await next(last).trigger('click')
    expect(selected(last)).toEqual([])
  })

  it('keeps focus on a button that becomes aria-disabled', async () => {
    const wrapper = mountSwitcher({ index: 1 })
    const button = previous(wrapper).element as HTMLButtonElement
    button.focus()
    await wrapper.setProps({ index: 0 })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(button)
  })

  it('arrow keys anywhere in the group select the enabled neighbor', async () => {
    const wrapper = mountSwitcher({ index: 1 })
    await next(wrapper).trigger('keydown', { key: 'ArrowLeft' })
    await previous(wrapper).trigger('keydown', { key: 'ArrowRight' })
    await wrapper.get(`[data-testid="${testIds.messageBranch}"]`).trigger('keydown', { key: 'ArrowRight' })
    expect(selected(wrapper)).toEqual([SIBLINGS[0], SIBLINGS[2], SIBLINGS[2]])
    // Modified arrows (browser and OS shortcuts) and other keys are left alone.
    await next(wrapper).trigger('keydown', { key: 'ArrowRight', altKey: true })
    await next(wrapper).trigger('keydown', { key: 'ArrowUp' })
    expect(selected(wrapper)).toHaveLength(3)

    const first = mountSwitcher({ index: 0 })
    await next(first).trigger('keydown', { key: 'ArrowLeft' })
    expect(selected(first)).toEqual([])
  })

  it('selects nothing while disabled (a request or a switch in flight)', async () => {
    const wrapper = mountSwitcher({ index: 1, disabled: true })
    expect(previous(wrapper).attributes('aria-disabled')).toBe('true')
    expect(next(wrapper).attributes('aria-disabled')).toBe('true')
    await previous(wrapper).trigger('click')
    await next(wrapper).trigger('keydown', { key: 'ArrowRight' })
    expect(selected(wrapper)).toEqual([])
  })

  it('keeps an out-of-range index inside the versions', () => {
    const wrapper = mountSwitcher({ siblings: SIBLINGS.slice(0, 2), index: 5 })
    const root = wrapper.get(`[data-testid="${testIds.messageBranch}"]`)
    expect(root.attributes('data-index')).toBe('1')
    expect(root.attributes('data-message-id')).toBe(SIBLINGS[1])
    expect(wrapper.get(`[data-testid="${testIds.messageBranchCounter}"]`).text()).toBe('2/2')
  })
})
