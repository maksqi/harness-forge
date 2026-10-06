import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { personalHook } from '~/utils/testing/fixtures'
import HookEditor from './HookEditor.vue'

afterEach(() => {
  document.body.replaceChildren()
})

describe('hookEditor (P11-0b stub)', () => {
  it('renders its root with the mode and the title while open', async () => {
    const wrapper = mount(HookEditor, { props: { open: true, mode: 'edit', hook: personalHook(), draft: null }, attachTo: document.body })
    await flushPromises()
    const sheet = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.hookEditor}"]`)!
    expect(sheet.dataset.mode).toBe('edit')
    expect(sheet.textContent).toContain('Edit hook')
    wrapper.unmount()
  })

  it('renders nothing while closed', async () => {
    const wrapper = mount(HookEditor, { props: { open: false, mode: 'new', hook: null }, attachTo: document.body })
    await flushPromises()
    expect(document.body.querySelector(`[data-testid="${testIds.hookEditor}"]`)).toBeNull()
    wrapper.unmount()
  })
})
