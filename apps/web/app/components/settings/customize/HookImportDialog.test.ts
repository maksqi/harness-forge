import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import HookImportDialog from './HookImportDialog.vue'

afterEach(() => {
  document.body.replaceChildren()
})

describe('hookImportDialog (P11-0b stub)', () => {
  it('renders its root while open and closes', async () => {
    const wrapper = mount(HookImportDialog, { props: { open: true }, attachTo: document.body })
    await flushPromises()
    const dialog = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.hookImportDialog}"]`)!
    expect(dialog.textContent).toContain('Import hooks')
    const cancel = [...dialog.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Cancel')!
    cancel.click()
    expect(wrapper.emitted('update:open')).toEqual([[false]])
    wrapper.unmount()
  })
})
