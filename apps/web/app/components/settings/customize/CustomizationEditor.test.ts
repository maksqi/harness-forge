import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { agentCustomization } from '~/utils/testing/fixtures'
import CustomizationEditor from './CustomizationEditor.vue'

afterEach(() => {
  document.body.replaceChildren()
})

function editor(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testIds.customizationEditor}"]`)
}

describe('customizationEditor (P10-0b stub)', () => {
  it('renders its root with the kind and the mode while open', async () => {
    const wrapper = mount(CustomizationEditor, {
      props: { open: true, kind: 'agent', mode: 'edit', customization: agentCustomization(), draft: null, notes: [] },
      attachTo: document.body,
    })
    await flushPromises()
    expect(editor()?.dataset).toMatchObject({ kind: 'agent', mode: 'edit' })
    expect(editor()?.textContent).toContain('Edit reviewer')
    wrapper.unmount()
  })

  it('titles new and imported definitions, renders nothing while closed, and emits update:open', async () => {
    const wrapper = mount(CustomizationEditor, { props: { open: true, kind: 'command', mode: 'import' }, attachTo: document.body })
    await flushPromises()
    expect(editor()?.textContent).toContain('Import command')
    document.body.querySelector<HTMLElement>('[data-slot="sheet-close"]')!.click()
    await flushPromises()
    expect(wrapper.emitted('update:open')).toEqual([[false]])
    await wrapper.setProps({ open: false })
    await flushPromises()
    expect(editor()).toBeNull()
    wrapper.unmount()
  })
})
