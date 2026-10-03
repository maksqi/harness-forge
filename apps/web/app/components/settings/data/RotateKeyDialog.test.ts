// RotateKeyDialog skeleton (docs/UI.md 9.8, 10.4; C15, P7-0b): the dialog content carries the root test id and accepts
// the key status. W7.13 adds the effects list, the typed confirmation and the submit.
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { keyStatus } from '~/utils/testing/fixtures'
import RotateKeyDialog from './RotateKeyDialog.vue'

afterEach(() => {
  document.body.replaceChildren()
})

describe('rotateKeyDialog', () => {
  it('renders its content while open and nothing while closed', async () => {
    const status = keyStatus()
    const wrapper = mount(RotateKeyDialog, { props: { open: true, status }, attachTo: document.body })
    await flushPromises()
    const content = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.keyRotateDialog}"]`)
    expect(content?.getAttribute('role')).toBe('dialog')
    expect(content?.textContent).toContain('Rotate the master key?')
    expect(wrapper.props()).toEqual({ open: true, status })

    await wrapper.setProps({ open: false, status: null })
    await flushPromises()
    expect(document.body.querySelector(`[data-testid="${testIds.keyRotateDialog}"]`)).toBeNull()
    wrapper.unmount()
  })
})
